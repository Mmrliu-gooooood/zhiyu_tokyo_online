import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

import type { AssetByteStore } from '@openmaic/storage/asset/pg';

function safeHashPath(root: string, hash: string): string {
  if (!hash.startsWith('sha256-') || hash.length !== 'sha256-'.length + 64) {
    throw new Error('invalid content hash');
  }
  const hex = hash.slice('sha256-'.length).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('invalid content hash');
  const path = resolve(root, hex.slice(0, 2), hex.slice(2, 4), hex);
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new Error('invalid asset path');
  }
  return path;
}

/**
 * Local disk byte store. Bytes are content-addressed; authorization stays
 * in the asset registry. Existence of a file is never an access grant.
 */
export class LocalAssetByteStore implements AssetByteStore {
  readonly writesOutsideRegistryDatabase = true as const;
  private readonly root: string;
  private ready: Promise<void> | undefined;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private async ensureReady(): Promise<void> {
    this.ready ??= (async () => {
      await mkdir(this.root, { recursive: true });
      const info = await stat(this.root);
      if (!info.isDirectory()) {
        throw new Error(`ASSET_LOCAL_ROOT is not a directory: ${this.root}`);
      }
      const probe = resolve(this.root, '.write-check');
      await writeFile(probe, 'ok');
      await rm(probe, { force: true });
    })();
    try {
      await this.ready;
    } catch (error) {
      this.ready = undefined;
      throw error;
    }
  }

  async write(hash: Parameters<AssetByteStore['write']>[0], bytes: Uint8Array): Promise<void> {
    await this.ensureReady();
    const path = safeHashPath(this.root, hash);
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temp, bytes);
      await writeFile(path, bytes);
    } finally {
      await rm(temp, { force: true }).catch(() => undefined);
    }
  }

  async read(hash: Parameters<AssetByteStore['read']>[0]): Promise<Uint8Array | null> {
    await this.ensureReady();
    try {
      return await readFile(safeHashPath(this.root, hash));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async readRange(
    hash: Parameters<AssetByteStore['read']>[0],
    start: number,
    end: number,
  ): Promise<Uint8Array | null> {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
      throw new Error('invalid asset byte range');
    }
    await this.ensureReady();
    let file;
    try {
      file = await open(safeHashPath(this.root, hash), 'r');
      const buffer = Buffer.alloc(end - start + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, start);
      return buffer.subarray(0, bytesRead);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    } finally {
      await file?.close().catch(() => undefined);
    }
  }

  async delete(hash: Parameters<AssetByteStore['delete']>[0]): Promise<void> {
    await this.ensureReady();
    await rm(safeHashPath(this.root, hash), { force: true });
  }
}

export function resolveLocalAssetRoot(): string {
  const root = process.env.ASSET_LOCAL_ROOT?.trim();
  if (!root) {
    throw new Error('ASSET_BYTE_BACKEND=local requires ASSET_LOCAL_ROOT');
  }
  return root;
}
