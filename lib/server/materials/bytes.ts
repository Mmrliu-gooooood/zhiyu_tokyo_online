import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  configuredAssetS3Client,
  configuredS3Bucket,
  type S3ClientConfigValues,
} from '@/lib/persistence/s3-client-config';

export type MaterialByteInput = Buffer | Uint8Array | Readable | ReadableStream<Uint8Array>;

export interface MaterialByteStore {
  put(key: string, body: MaterialByteInput, mime?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

interface S3MaterialObjectInput {
  Bucket: string;
  Key: string;
}

interface S3MaterialPutInput extends S3MaterialObjectInput {
  Body: Buffer | Uint8Array | Readable;
  ContentType?: string;
}

interface S3MaterialGetOutput {
  Body?: { transformToByteArray(): Promise<Uint8Array> };
}

export interface S3MaterialByteStoreClient {
  send(command: unknown): Promise<unknown>;
}

export interface S3MaterialByteStoreCommands {
  put(input: S3MaterialPutInput): unknown;
  get(input: S3MaterialObjectInput): unknown;
  delete(input: S3MaterialObjectInput): unknown;
}

export interface S3MaterialByteStoreOptions {
  bucket: string;
  client: S3MaterialByteStoreClient;
  commands: S3MaterialByteStoreCommands;
}

function nodeReadable(body: MaterialByteInput): Readable {
  if (body instanceof Readable) return body;
  if (body instanceof ReadableStream) return Readable.fromWeb(body as never);
  return Readable.from(body);
}

function safeLocalPath(root: string, key: string): string {
  const path = resolve(root, key);
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new Error(`invalid material object key: ${key}`);
  }
  return path;
}

function safeS3Key(key: string): string {
  const segments = key.split('/');
  if (
    !key ||
    key.startsWith('/') ||
    key.includes('\\') ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('invalid material object key');
  }
  return key;
}

function s3Body(body: MaterialByteInput): Buffer | Uint8Array | Readable {
  return body instanceof ReadableStream ? Readable.fromWeb(body as never) : body;
}

function isNoSuchKey(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; Code?: unknown; code?: unknown };
  return (
    candidate.name === 'NoSuchKey' ||
    candidate.Code === 'NoSuchKey' ||
    candidate.code === 'NoSuchKey'
  );
}

function missingMaterialObject(): NodeJS.ErrnoException {
  return Object.assign(new Error('material object not found'), { code: 'ENOENT' });
}

function materialS3Failure(operation: string): Error {
  return new Error(`material S3 ${operation} failed`);
}

/** Private S3 storage for original material uploads and session materials. */
export class S3MaterialByteStore implements MaterialByteStore {
  private readonly bucket: string;
  private readonly client: S3MaterialByteStoreClient;
  private readonly commands: S3MaterialByteStoreCommands;

  constructor(options: S3MaterialByteStoreOptions) {
    this.bucket = options.bucket;
    this.client = options.client;
    this.commands = options.commands;
  }

  async put(key: string, body: MaterialByteInput, mime?: string): Promise<void> {
    const objectKey = safeS3Key(key);
    try {
      await this.client.send(
        this.commands.put({
          Bucket: this.bucket,
          Key: objectKey,
          Body: s3Body(body),
          ...(mime ? { ContentType: mime } : {}),
        }),
      );
    } catch {
      throw materialS3Failure('put');
    }
  }

  async get(key: string): Promise<Buffer> {
    const objectKey = safeS3Key(key);
    try {
      const output = (await this.client.send(
        this.commands.get({ Bucket: this.bucket, Key: objectKey }),
      )) as S3MaterialGetOutput;
      if (!output.Body) throw materialS3Failure('get');
      return Buffer.from(await output.Body.transformToByteArray());
    } catch (error) {
      if (isNoSuchKey(error)) throw missingMaterialObject();
      throw materialS3Failure('get');
    }
  }

  async delete(key: string): Promise<void> {
    const objectKey = safeS3Key(key);
    try {
      await this.client.send(this.commands.delete({ Bucket: this.bucket, Key: objectKey }));
    } catch (error) {
      if (isNoSuchKey(error)) return;
      throw materialS3Failure('delete');
    }
  }
}

/** Local/self-hosted material byte storage, rooted under the runtime data directory. */
export class LocalMaterialByteStore implements MaterialByteStore {
  private readonly root: string;

  constructor(root: string = resolve(process.cwd(), 'data')) {
    this.root = resolve(root);
  }

  async put(key: string, body: MaterialByteInput, _mime?: string): Promise<void> {
    const path = safeLocalPath(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    try {
      await pipeline(nodeReadable(body), createWriteStream(path));
    } catch (error) {
      await rm(path, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async get(key: string): Promise<Buffer> {
    return readFile(safeLocalPath(this.root, key));
  }

  async delete(key: string): Promise<void> {
    await rm(safeLocalPath(this.root, key), { force: true });
  }
}

type MaterialS3Loader = (
  bucket: string,
  clientConfig: S3ClientConfigValues,
) => Promise<MaterialByteStore>;

async function loadS3MaterialByteStore(
  bucket: string,
  clientConfig: S3ClientConfigValues,
): Promise<MaterialByteStore> {
  const sdk = await import('@aws-sdk/client-s3');
  const client = new sdk.S3Client(clientConfig);
  return new S3MaterialByteStore({
    bucket,
    client,
    commands: {
      put: (input) => new sdk.PutObjectCommand(input),
      get: (input) => new sdk.GetObjectCommand(input),
      delete: (input) => new sdk.DeleteObjectCommand(input),
    },
  });
}

export async function createMaterialByteStore(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  loadS3: MaterialS3Loader = loadS3MaterialByteStore,
): Promise<MaterialByteStore> {
  const backend = environment.MATERIAL_BYTE_BACKEND?.trim().toLowerCase();
  if (backend && backend !== 'local' && backend !== 's3') {
    throw new Error('Invalid MATERIAL_BYTE_BACKEND: expected local or s3');
  }
  const bucket = configuredS3Bucket(environment.MATERIAL_S3_BUCKET, 'MATERIAL_S3_BUCKET');
  if (backend === 'local' || (!bucket && backend !== 's3')) return new LocalMaterialByteStore();
  if (!bucket) {
    throw new Error('MATERIAL_S3_BUCKET is required when MATERIAL_BYTE_BACKEND=s3');
  }
  return loadS3(bucket, configuredAssetS3Client(environment));
}

class LazyMaterialByteStore implements MaterialByteStore {
  private pending: Promise<MaterialByteStore> | undefined;

  private resolve(): Promise<MaterialByteStore> {
    if (this.pending) return this.pending;
    const pending = createMaterialByteStore().catch((error: unknown) => {
      if (this.pending === pending) this.pending = undefined;
      throw error;
    });
    this.pending = pending;
    return pending;
  }

  async put(key: string, body: MaterialByteInput, mime?: string): Promise<void> {
    return (await this.resolve()).put(key, body, mime);
  }

  async get(key: string): Promise<Buffer> {
    return (await this.resolve()).get(key);
  }

  async delete(key: string): Promise<void> {
    return (await this.resolve()).delete(key);
  }
}

let sharedStore: MaterialByteStore | null = null;

export function getMaterialByteStore(): MaterialByteStore {
  sharedStore ??= new LazyMaterialByteStore();
  return sharedStore;
}

export function setMaterialByteStoreForTests(store: MaterialByteStore | null): void {
  sharedStore = store;
}
