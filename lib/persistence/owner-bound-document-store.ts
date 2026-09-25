import type { Scene, Stage } from '@openmaic/dsl';
import {
  PgDocumentStore,
  type Queryable,
  type WithTransaction,
} from '@openmaic/storage/document/pg';
import type {
  DocumentFolder,
  DocumentFolderStore,
  DocumentStore,
  DocumentSummary,
  MaicDocument,
  SceneLike,
  SceneValidator,
  StageValidator,
} from '@openmaic/storage';

import { claimStageMeta, StageAccessError, tombstoneStageMeta } from './stage-meta';
import {
  assertGenerationMutationAllowed,
  preserveGenerationProducer,
  readGenerationOwnership,
} from '@/lib/server/generation-jobs/ownership';
import { isHostedAuthEnabled } from '@/lib/auth/mode';
import { shouldIsolateOwner } from '@/lib/auth/principal';

export interface PoolClientLike {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}

export interface TransactionSource {
  connect(): Promise<PoolClientLike>;
}

export interface OwnerBoundDocumentStoreOptions {
  pool: TransactionSource;
  ownerId: string;
  validateScene: SceneValidator;
  validateStage: StageValidator;
  /** Runner-only lease fence, evaluated inside every mutation transaction. */
  mutationFence?: (queryable: Queryable) => Promise<void>;
}

type OwnershipMode = 'create' | 'mutate' | 'read' | 'delete' | 'library';
interface PendingOperation {
  stageId?: string;
  mode: OwnershipMode;
}

interface RawOwnershipRow extends Record<string, unknown> {
  owner_id: string;
  deleted_at: Date | string | null;
}

function queryableFor(connection: Pick<PoolClientLike, 'query'>): Queryable {
  return {
    async query<TRow extends Record<string, unknown>>(text: string, params?: unknown[]) {
      const result = await connection.query(text, params);
      return { rows: result.rows as TRow[] };
    },
  };
}

function isolateOwnerBoundReads(ownerId: string): boolean {
  return isHostedAuthEnabled() || shouldIsolateOwner(ownerId);
}

/** Unsigned dual-mode traffic lists the shared `anon:` library, not a fresh cookie. */
export function usesSharedAnonymousLibrary(ownerId: string): boolean {
  return !isolateOwnerBoundReads(ownerId);
}

interface LibrarySummaryRow extends Record<string, unknown> {
  id: string;
  name: string;
  description: string | null;
  interactive_mode: boolean | null;
  task_engine_mode: boolean | null;
  created_at: number | string;
  updated_at: number | string;
  scene_count: number | string;
  folder_id: string | null;
}

function summariesFromRows(rows: LibrarySummaryRow[]): DocumentSummary[] {
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    ...(row.description === null ? {} : { description: row.description }),
    ...(row.interactive_mode === null ? {} : { interactiveMode: row.interactive_mode }),
    ...(row.task_engine_mode === null ? {} : { taskEngineMode: row.task_engine_mode }),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    sceneCount: Number(row.scene_count),
    ...(row.folder_id === null ? {} : { folderId: row.folder_id }),
  }));
}

async function bindHostedOwner(client: Pick<PoolClientLike, 'query'>, ownerId: string): Promise<void> {
  if (!isolateOwnerBoundReads(ownerId)) return;
  await client.query('SELECT set_config($1, $2, true)', ['app.owner_id', ownerId]);
}

class OwnerBoundDocumentStore<TScene extends SceneLike, TStage extends Stage>
  implements DocumentStore<TScene, TStage>, DocumentFolderStore
{
  constructor(
    private readonly inner: PgDocumentStore<TScene, TStage>,
    private readonly pending: { operation?: PendingOperation },
    private readonly runTransaction: WithTransaction,
    private readonly queryable: Queryable,
    private readonly ownerId: string,
  ) {}

  private async tagged<T>(operation: PendingOperation, body: () => Promise<T>): Promise<T> {
    this.pending.operation = operation;
    try {
      return await body();
    } finally {
      this.pending.operation = undefined;
    }
  }

  saveDocument(doc: MaicDocument<TScene, TStage>): Promise<void> {
    return this.tagged({ stageId: doc.stage.id, mode: 'create' }, () =>
      this.inner.saveDocument(doc),
    );
  }

  putStage(stageId: string, stage: TStage): Promise<void> {
    return this.tagged({ stageId, mode: 'mutate' }, () => this.inner.putStage(stageId, stage));
  }

  putScene(stageId: string, scene: TScene): Promise<void> {
    return this.tagged({ stageId, mode: 'mutate' }, () => this.inner.putScene(stageId, scene));
  }

  deleteScene(stageId: string, sceneId: string): Promise<void> {
    return this.tagged({ stageId, mode: 'mutate' }, () => this.inner.deleteScene(stageId, sceneId));
  }

  async deleteDocument(stageId: string): Promise<void> {
    await this.tagged({ stageId, mode: 'delete' }, () =>
      this.runTransaction(async (queryable) => {
        // Course deletion is also a generation fence. Do this in the same
        // transaction as the tombstone so a worker cannot commit between the
        // user's delete and the epoch bump, nor can a stale lease republish a
        // deleted course after the transaction commits.
        await queryable.query(
          `UPDATE generation_jobs
              SET status='cancelled', worker_id=NULL,
                  lease_epoch=lease_epoch+1, lease_expires_at=NULL,
                  heartbeat_at=NULL,
                  cancel_requested_at=COALESCE(cancel_requested_at,clock_timestamp()),
                  finished_at=COALESCE(finished_at,clock_timestamp()),
                  updated_at=clock_timestamp(), state_version=state_version+1
            WHERE stage_id=$1
              AND status NOT IN ('succeeded','failed','cancelled')`,
          [stageId],
        );
        await queryable.query(
          `UPDATE generation_ownership
              SET ownership_epoch=ownership_epoch+1,
                  write_mode='editable', updated_at=clock_timestamp()
            WHERE stage_id=$1`,
          [stageId],
        );
        await tombstoneStageMeta(queryable, stageId);
        await queryable.query('UPDATE document_stages SET folder_id = NULL WHERE id = $1', [
          stageId,
        ]);
      }),
    );
  }

  async loadDocument(stageId: string): Promise<MaicDocument<TScene, TStage> | null> {
    return this.readGated(stageId, () => this.inner.loadDocument(stageId));
  }

  async getScene(stageId: string, sceneId: string): Promise<TScene | null> {
    return this.readGated(stageId, () => this.inner.getScene(stageId, sceneId));
  }

  /** The trigger-maintained freshness manifest is a read: capability-by-id. */
  async readFreshnessManifest(stageId: string) {
    return this.readGated(stageId, () => this.inner.readFreshnessManifest(stageId));
  }

  private async readGated<T>(stageId: string, body: () => Promise<T>): Promise<T | null> {
    try {
      return await this.tagged({ stageId, mode: 'read' }, body);
    } catch (error) {
      if (error instanceof StageAccessError) return null;
      throw error;
    }
  }

  async listDocuments(folderId?: string): Promise<DocumentSummary[]> {
    const [documents, live] = await Promise.all([
      this.inner.listDocuments(folderId),
      this.queryable.query<{ stage_id: string } & Record<string, unknown>>(
        'SELECT stage_id FROM stage_meta WHERE owner_id = $1 AND deleted_at IS NULL',
        [this.ownerId],
      ),
    ]);
    const liveIds = new Set(live.rows.map((row) => row.stage_id));
    return documents.filter((document) => liveIds.has(document.id));
  }

  /**
   * Home / workbench library. Signed `user:{uuid}` sessions stay owner-scoped.
   * Unsigned dual-mode traffic lists every live `anon:` course so a freshly
   * minted `generation_owner` cookie does not hide the shared classroom pile.
   */
  async listLibraryDocuments(folderId?: string): Promise<DocumentSummary[]> {
    if (!usesSharedAnonymousLibrary(this.ownerId)) {
      return this.listDocuments(folderId);
    }
    const folderFilter = folderId === undefined ? '' : ' AND stages.folder_id = $1';
    const result = await this.queryable.query<LibrarySummaryRow>(
      `SELECT stages.id,
              stages.name,
              stages.description,
              stages.interactive_mode,
              stages.task_engine_mode,
              stages.created_at,
              stages.updated_at,
              stages.folder_id,
              COUNT(scenes.id)::text AS scene_count
         FROM document_stages AS stages
         LEFT JOIN document_scenes AS scenes ON scenes.stage_id = stages.id
         INNER JOIN stage_meta AS meta ON meta.stage_id = stages.id
        WHERE meta.deleted_at IS NULL
          AND meta.owner_id LIKE 'anon:%'
          AND (stages.owner_id LIKE 'anon:%' OR stages.owner_id IS NULL)
          ${folderFilter}
        GROUP BY stages.id
        ORDER BY stages.id ASC`,
      folderId === undefined ? [] : [folderId],
    );
    return summariesFromRows(result.rows);
  }

  createFolder(folderId: string, name: string, limit?: number) {
    return this.tagged({ mode: 'library' }, () => this.inner.createFolder(folderId, name, limit));
  }

  listFolders(): Promise<DocumentFolder[]> {
    return this.inner.listFolders();
  }

  moveDocumentToFolder(stageId: string, folderId: string): Promise<boolean> {
    return this.tagged({ stageId, mode: 'mutate' }, () =>
      this.inner.moveDocumentToFolder(stageId, folderId),
    );
  }

  renameFolder(id: string, name: string): Promise<DocumentFolder | null> {
    return this.tagged({ mode: 'library' }, () => this.inner.renameFolder(id, name));
  }

  deleteFolder(
    id: string,
    mode: 'ungroup' | 'remove',
  ): Promise<{ removedStageIds: string[] } | null> {
    return this.tagged({ mode: 'library' }, () => this.inner.deleteFolder(id, mode));
  }

  setStageFolder(stageId: string, folderId: string | null): Promise<boolean> {
    return this.tagged({ stageId, mode: 'mutate' }, () =>
      this.inner.setStageFolder(stageId, folderId),
    );
  }
}

export function createOwnerBoundDocumentStore<
  TScene extends SceneLike = Scene,
  TStage extends Stage = Stage,
>(
  options: OwnerBoundDocumentStoreOptions,
): DocumentStore<TScene, TStage> &
  DocumentFolderStore & { listLibraryDocuments(folderId?: string): Promise<DocumentSummary[]> } {
  const pending: { operation?: PendingOperation } = {};

  const withTransaction: WithTransaction = async (body) => {
    const client = await options.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      try {
        await bindHostedOwner(client, options.ownerId);
        const queryable = queryableFor(client);
        const operation = pending.operation;
        if (operation?.stageId && operation.mode === 'read') {
          const ownership = await readGenerationOwnership(queryable, operation.stageId);
          if (
            ownership?.producer_kind === 'course-worker' &&
            ownership.owner_id !== options.ownerId
          ) {
            throw new StageAccessError(operation.stageId, options.ownerId, 'foreign');
          }
        }
        if (operation && operation.mode !== 'read') await options.mutationFence?.(queryable);
        if (operation?.stageId && operation.mode !== 'read') {
          await assertGenerationMutationAllowed(queryable, operation.stageId, options.ownerId, {
            internalProducer: !!options.mutationFence,
            delete: operation.mode === 'delete',
          });
        }
        if (operation?.stageId) {
          const lock = operation.mode === 'read' ? 'FOR SHARE' : 'FOR UPDATE';
          const result = await queryable.query<RawOwnershipRow>(
            `SELECT owner_id, deleted_at FROM stage_meta WHERE stage_id = $1 ${lock}`,
            [operation.stageId],
          );
          const row = result.rows[0];
          if (row) {
            const requireOwner =
              operation.mode !== 'read' || isolateOwnerBoundReads(options.ownerId);
            if (requireOwner && row.owner_id !== options.ownerId) {
              throw new StageAccessError(operation.stageId, options.ownerId, 'foreign');
            }
            if (row.deleted_at !== null && operation.mode !== 'delete') {
              throw new StageAccessError(operation.stageId, options.ownerId, 'tombstoned');
            }
          } else if (operation.mode === 'create') {
            const occupied = await queryable.query<{ exists: boolean } & Record<string, unknown>>(
              'SELECT EXISTS(SELECT 1 FROM document_stages WHERE id = $1) AS exists',
              [operation.stageId],
            );
            if (occupied.rows[0]?.exists) {
              throw new StageAccessError(operation.stageId, options.ownerId, 'reserved-document');
            }
          } else {
            throw new StageAccessError(operation.stageId, options.ownerId, 'unclaimed');
          }
        }

        const result = await body(queryable);
        if (operation?.stageId && operation.mode !== 'read' && operation.mode !== 'delete') {
          await preserveGenerationProducer(queryable, operation.stageId, !!options.mutationFence);
        }
        if (operation?.mode === 'create') {
          await claimStageMeta(queryable, operation.stageId!, options.ownerId);
        }
        if (operation && operation.mode !== 'read') await options.mutationFence?.(queryable);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    } finally {
      client.release();
    }
  };

  const queryable: Queryable = {
    async query<TRow extends Record<string, unknown>>(text: string, params?: unknown[]) {
      const client = await options.pool.connect();
      try {
        if (isolateOwnerBoundReads(options.ownerId)) {
          await client.query('BEGIN');
          try {
            await bindHostedOwner(client, options.ownerId);
            const result = await queryableFor(client).query<TRow>(text, params);
            await client.query('COMMIT');
            return result;
          } catch (error) {
            try {
              await client.query('ROLLBACK');
            } catch {
              // Prefer the original query error.
            }
            throw error;
          }
        }
        return await queryableFor(client).query<TRow>(text, params);
      } finally {
        client.release();
      }
    },
  };
  const inner = new PgDocumentStore<TScene, TStage>(queryable, {
    withTransaction,
    ownerId: options.ownerId,
    validateScene: options.validateScene,
    validateStage: options.validateStage,
  });
  return new OwnerBoundDocumentStore(inner, pending, withTransaction, queryable, options.ownerId);
}
