import { configuredAssetS3Client, configuredS3Bucket } from '@/lib/persistence/s3-client-config';
import { createHash } from 'node:crypto';

export interface ClassroomSnapshotStore {
  put(input: {
    ownerId: string;
    classroomId: string;
    version: number;
    bytes: Uint8Array;
  }): Promise<string>;
  get(storageRef: string): Promise<Uint8Array>;
}

interface ClassroomSnapshotS3StoreOptions {
  bucket: string;
  client: { send(command: unknown): Promise<unknown> };
  putCommand(input: {
    Bucket: string;
    Key: string;
    Body: Uint8Array;
    ContentType: string;
  }): unknown;
  getCommand(input: { Bucket: string; Key: string }): unknown;
}

function snapshotKey(
  ownerId: string,
  classroomId: string,
  version: number,
  bytes: Uint8Array,
): string {
  const digest = createHash('sha256').update(bytes).digest('hex');
  return [
    'snapshots',
    encodeURIComponent(ownerId),
    encodeURIComponent(classroomId),
    `${version}-${digest}.json`,
  ].join('/');
}

function parseStorageRef(storageRef: string): { bucket: string; key: string } {
  if (!storageRef.startsWith('s3://')) throw new Error('INVALID_CLASSROOM_STORAGE_REF');
  const separator = storageRef.indexOf('/', 5);
  if (separator < 0) throw new Error('INVALID_CLASSROOM_STORAGE_REF');
  const bucket = storageRef.slice(5, separator);
  const key = storageRef.slice(separator + 1);
  if (!bucket || !key) throw new Error('INVALID_CLASSROOM_STORAGE_REF');
  return { bucket, key };
}

export class ClassroomSnapshotS3Store implements ClassroomSnapshotStore {
  constructor(private readonly options: ClassroomSnapshotS3StoreOptions) {}

  async put(input: {
    ownerId: string;
    classroomId: string;
    version: number;
    bytes: Uint8Array;
  }): Promise<string> {
    const key = snapshotKey(input.ownerId, input.classroomId, input.version, input.bytes);
    await this.options.client.send(
      this.options.putCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: input.bytes,
        ContentType: 'application/json',
      }),
    );
    return `s3://${this.options.bucket}/${key}`;
  }

  async get(storageRef: string): Promise<Uint8Array> {
    const { bucket, key } = parseStorageRef(storageRef);
    if (bucket !== this.options.bucket) throw new Error('INVALID_CLASSROOM_STORAGE_BUCKET');
    const output = (await this.options.client.send(
      this.options.getCommand({ Bucket: bucket, Key: key }),
    )) as { Body?: { transformToByteArray(): Promise<Uint8Array> } };
    if (!output.Body) throw new Error('CLASSROOM_SNAPSHOT_BODY_MISSING');
    return output.Body.transformToByteArray();
  }
}

async function loadClassroomSnapshotStore(): Promise<ClassroomSnapshotStore> {
  const bucket = configuredS3Bucket(process.env.CLASSROOM_S3_BUCKET, 'CLASSROOM_S3_BUCKET');
  if (!bucket) {
    throw new Error('CLASSROOM_S3_BUCKET is required in hosted auth mode');
  }
  const sdk = await import('@aws-sdk/client-s3');
  return new ClassroomSnapshotS3Store({
    bucket,
    client: new sdk.S3Client(configuredAssetS3Client()),
    putCommand: (input) => new sdk.PutObjectCommand(input),
    getCommand: (input) => new sdk.GetObjectCommand(input),
  });
}

let configuredStore: ClassroomSnapshotStore | null = null;
let pendingStore: Promise<ClassroomSnapshotStore> | null = null;

export async function getClassroomSnapshotStore(): Promise<ClassroomSnapshotStore> {
  if (configuredStore) return configuredStore;
  pendingStore ??= loadClassroomSnapshotStore().catch((error: unknown) => {
    pendingStore = null;
    throw error;
  });
  return pendingStore;
}

export function setClassroomSnapshotStoreForTests(store: ClassroomSnapshotStore | null): void {
  configuredStore = store;
  pendingStore = null;
}
