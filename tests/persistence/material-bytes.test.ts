import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createMaterialByteStore,
  LocalMaterialByteStore,
  S3MaterialByteStore,
  type S3MaterialByteStoreCommands,
} from '@/lib/server/materials/bytes';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function storeFixture(): Promise<{ root: string; store: LocalMaterialByteStore }> {
  const root = await mkdtemp(join(tmpdir(), 'openmaic-material-bytes-'));
  roots.push(root);
  return { root, store: new LocalMaterialByteStore(root) };
}

describe('LocalMaterialByteStore', () => {
  it('round-trips and deletes an object key under its root', async () => {
    const { root, store } = await storeFixture();
    const key = 'materials/owner-1/mat-1';

    await store.put(key, Buffer.from('material bytes'), 'application/pdf');

    await expect(store.get(key)).resolves.toEqual(Buffer.from('material bytes'));
    await expect(readFile(join(root, key))).resolves.toEqual(Buffer.from('material bytes'));
    await store.delete(key);
    await expect(store.get(key)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects path traversal for every operation', async () => {
    const { store } = await storeFixture();

    await expect(store.put('../outside', Buffer.from('x'))).rejects.toThrow(
      'invalid material object key',
    );
    await expect(store.get('../outside')).rejects.toThrow('invalid material object key');
    await expect(store.delete('../outside')).rejects.toThrow('invalid material object key');
  });
});

type MemoryCommand = {
  operation: 'put' | 'get' | 'delete';
  input: { Bucket: string; Key: string; Body?: Buffer | Uint8Array; ContentType?: string };
};

const memoryCommands: S3MaterialByteStoreCommands = {
  put: (input) => ({ operation: 'put', input }) as MemoryCommand,
  get: (input) => ({ operation: 'get', input }) as MemoryCommand,
  delete: (input) => ({ operation: 'delete', input }) as MemoryCommand,
};

class MemoryMaterialS3Client {
  readonly objects = new Map<string, Uint8Array>();
  readonly puts: MemoryCommand[] = [];

  async send(rawCommand: unknown): Promise<unknown> {
    const command = rawCommand as MemoryCommand;
    if (command.operation === 'put') {
      if (!(command.input.Body instanceof Uint8Array)) throw new Error('expected byte body');
      this.puts.push(command);
      this.objects.set(command.input.Key, Uint8Array.from(command.input.Body));
      return {};
    }
    if (command.operation === 'get') {
      const bytes = this.objects.get(command.input.Key);
      if (!bytes) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
      return { Body: { transformToByteArray: async () => Uint8Array.from(bytes) } };
    }
    if (command.operation === 'delete') {
      this.objects.delete(command.input.Key);
      return {};
    }
    throw new Error('unsupported command');
  }
}

describe('S3MaterialByteStore', () => {
  it('round-trips the existing object key and preserves content type', async () => {
    const client = new MemoryMaterialS3Client();
    const store = new S3MaterialByteStore({
      bucket: 'private-materials',
      client,
      commands: memoryCommands,
    });
    const key = 'materials/owner-1/material-1';

    await store.put(key, Buffer.from('material bytes'), 'application/pdf');

    await expect(store.get(key)).resolves.toEqual(Buffer.from('material bytes'));
    expect(client.puts[0]?.input).toMatchObject({
      Bucket: 'private-materials',
      Key: key,
      ContentType: 'application/pdf',
    });
    await store.delete(key);
    await expect(store.get(key)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects namespace escapes and sanitizes provider failures', async () => {
    const store = new S3MaterialByteStore({
      bucket: 'private-materials',
      client: { send: async () => Promise.reject(new Error('materials/owner-secret/file')) },
      commands: memoryCommands,
    });

    await expect(store.put('../outside', Buffer.from('x'))).rejects.toThrow(
      'invalid material object key',
    );
    await expect(store.get('materials/owner-secret/file')).rejects.toThrow(
      'material S3 get failed',
    );
    await expect(store.get('materials/owner-secret/file')).rejects.not.toThrow('owner-secret');
  });
});

describe('createMaterialByteStore', () => {
  it('keeps local storage as the default for the legacy stack', async () => {
    const loader = vi.fn();

    await expect(createMaterialByteStore({}, loader)).resolves.toBeInstanceOf(
      LocalMaterialByteStore,
    );
    expect(loader).not.toHaveBeenCalled();
  });

  it('lets the legacy local backend override a leftover material bucket', async () => {
    const loader = vi.fn();

    await expect(
      createMaterialByteStore(
        { MATERIAL_BYTE_BACKEND: 'local', MATERIAL_S3_BUCKET: 'private-materials' },
        loader,
      ),
    ).resolves.toBeInstanceOf(LocalMaterialByteStore);
    expect(loader).not.toHaveBeenCalled();
  });

  it('uses the private material bucket with the shared explicit S3 client settings', async () => {
    const expectedStore = new LocalMaterialByteStore();
    const loader = vi.fn().mockResolvedValue(expectedStore);

    await expect(
      createMaterialByteStore(
        {
          MATERIAL_BYTE_BACKEND: 's3',
          MATERIAL_S3_BUCKET: 'private-materials',
          ASSET_S3_ENDPOINT: 'https://project-ref.storage.supabase.co/storage/v1/s3',
          ASSET_S3_REGION: 'ap-southeast-1',
          ASSET_S3_ACCESS_KEY_ID: 'test-access',
          ASSET_S3_SECRET_ACCESS_KEY: 'test-secret',
        },
        loader,
      ),
    ).resolves.toBe(expectedStore);
    expect(loader).toHaveBeenCalledExactlyOnceWith('private-materials', {
      endpoint: 'https://project-ref.storage.supabase.co/storage/v1/s3',
      region: 'ap-southeast-1',
      forcePathStyle: true,
      credentials: { accessKeyId: 'test-access', secretAccessKey: 'test-secret' },
    });
  });

  it('requires a bucket for an explicit S3 backend', async () => {
    await expect(createMaterialByteStore({ MATERIAL_BYTE_BACKEND: 's3' })).rejects.toThrow(
      'MATERIAL_S3_BUCKET is required',
    );
  });
});
