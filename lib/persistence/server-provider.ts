import { PgAssetStore, ensureAssetSchema } from '@openmaic/storage/asset/pg';
import { PgDocumentStore, ensureDocumentSchema } from '@openmaic/storage/document/pg';
import { PgRuntimeStore, ensureSchema } from '@openmaic/storage/runtime/pg';
import {
  nodePostgresTransaction,
  type ConnectableQueryable,
} from '@openmaic/storage/server/reference';
import type { Pool } from 'pg';

import { isHostedAuthEnabled } from '@/lib/auth/mode';
import { getRegisteredPool } from '@/lib/db/pool-registry';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { lazyAssetByteStore } from '@/lib/persistence/asset-byte-store';
import { withLegacySharedAssetReads } from '@/lib/persistence/legacy-readable-assets';
import { hostedAssetBlobMutations } from '@/lib/persistence/hosted-asset-blob-mutations';
import { ensureOwnerMaterialSchema } from '@/lib/persistence/owner-materials';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { ensureStudySchema } from '@/lib/server/study/schema';
import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';

export { createHostedOwnerBoundStores } from './hosted-owner-store-adapter';

export type PersistencePoolFactory = (connectionString: string) => Pool;
const registeredPoolFactory: PersistencePoolFactory = (connectionString) =>
  getRegisteredPool(connectionString);

export interface ServerPersistenceProvider {
  pool: Pool;
  runtimeStore: PgRuntimeStore;
  documentStore: PgDocumentStore;
  assetStore: PgAssetStore;
}

interface ProviderState {
  connectionString?: string;
  providerPromise?: Promise<ServerPersistenceProvider>;
}

const PROVIDER_STATE_KEY = Symbol.for('openmaic.persistence.provider');
const globalState = globalThis as typeof globalThis & {
  [key: symbol]: ProviderState | undefined;
};
const providerState = (globalState[PROVIDER_STATE_KEY] ??= {});

async function createServerPersistenceProvider(
  connectionString: string,
  poolFactory: PersistencePoolFactory,
): Promise<ServerPersistenceProvider> {
  const pool = poolFactory(connectionString);
  const queryable = pool as unknown as ConnectableQueryable;
  try {
    // LOGIN app_web cannot run DDL. Hosted tables are migrated separately.
    if (process.env.GENERATION_BACKGROUND_ENABLED !== '1' && !isHostedAuthEnabled()) {
      await ensureSchema(queryable);
      await ensureDocumentSchema(queryable);
      await ensureStageMetaSchema(queryable);
      await ensureOwnerMaterialSchema(queryable);
      await ensureAssetSchema(queryable);
      await ensureStudySchema(queryable);
    }
    const withTransaction = nodePostgresTransaction(queryable);
    const byteStore = lazyAssetByteStore(process.env.ASSET_S3_BUCKET, queryable);
    return {
      pool,
      runtimeStore: new PgRuntimeStore(queryable, {
        withTransaction,
        payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
      }),
      documentStore: new PgDocumentStore(queryable, {
        withTransaction,
        validateScene: validateAppScene,
        validateStage: validateAppStage,
      }),
      assetStore: withLegacySharedAssetReads(
        new PgAssetStore(queryable, {
          withTransaction,
          byteStore,
          blobMutations: isHostedAuthEnabled() ? hostedAssetBlobMutations : undefined,
        }),
      ),
    };
  } catch (error) {
    if (poolFactory !== registeredPoolFactory) await pool.end().catch(() => {});
    throw error;
  }
}

/** Shared server bootstrap used by both HTTP persistence and Pi composition. */
export function getServerPersistenceProvider(
  connectionString: string,
  poolFactory: PersistencePoolFactory = registeredPoolFactory,
): Promise<ServerPersistenceProvider> {
  if (providerState.providerPromise && providerState.connectionString === connectionString) {
    return providerState.providerPromise;
  }

  providerState.connectionString = connectionString;
  const initialization = createServerPersistenceProvider(connectionString, poolFactory).catch(
    (error) => {
      if (providerState.providerPromise === initialization) {
        providerState.providerPromise = undefined;
        providerState.connectionString = undefined;
      }
      throw error;
    },
  );
  providerState.providerPromise = initialization;
  return initialization;
}
