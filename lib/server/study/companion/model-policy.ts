/**
 * Classmate answer-model policy (learning plan B05), shared by the after-class
 * chat runner and the two live classroom chat routes.
 *
 * `inherit` (the default) answers with whatever the caller already uses: the
 * session's model connection in after-class chats, the request's model in the
 * classroom. `custom` names an existing connection — a platform text default,
 * an account the student signed in to, or a provider the server configured —
 * and is checked every time it is used: the account must still be the
 * owner's and active, the platform default or server provider must still be
 * served, and the binding must resolve with a usable credential. When any of
 * that fails the caller reports STUDY_CLASSMATE_MODEL_UNAVAILABLE; it never
 * falls back to another (possibly more expensive) model. Spend limits are the
 * gateway's provider quota plus the chat's own hourly cap.
 */
import {
  GatewayError,
  ModelSelectionError,
  resolveBinding,
  type ModelBinding,
  type ModelSelection,
} from '@/lib/model-gateway';
import { CredentialVault } from '@/lib/model-gateway/credentials/vault';
import {
  defaultCredentialDatabase,
  type CredentialDatabaseFactory,
} from '@/lib/model-gateway/credentials/vault-auth';
import {
  PlatformDefaultModelError,
  getPlatformDefaultCatalog,
  getServerProviders,
  isPlatformDefaultBackingProvider,
  resolvePlatformDefault,
} from '@/lib/server/provider-config';
import type { LlmStage } from '@/lib/server/model-routes';
import { studyEmbeddingSpec } from '@/lib/server/study/knowledge/config';
import { StudyError } from '@/lib/server/study/spaces/repository';
import type { ClassmateModelChoice, ClassmateModelPolicy } from '@/lib/study/classmates/contracts';

export type ClassmateModelUnavailableReason =
  | 'platform_unavailable'
  | 'server_provider_unavailable'
  | 'credential_missing'
  | 'credential_reauth_required'
  | 'credential_provider_mismatch'
  | 'model_unresolvable'
  | 'credential_not_ready'
  | 'tools_unsupported';

export function classmateModelUnavailable(reason: ClassmateModelUnavailableReason): StudyError {
  return new StudyError('STUDY_CLASSMATE_MODEL_UNAVAILABLE', { reason });
}

/** The gateway selection a choice stands for. Carries no secret. */
export function classmateModelSelection(choice: ClassmateModelChoice): ModelSelection {
  switch (choice.kind) {
    case 'platform':
      return { source: 'platform', defaultId: choice.defaultId };
    case 'server':
      return { source: 'legacy-managed', providerId: choice.providerId, modelId: choice.modelId };
    case 'credential':
      return {
        source: 'user',
        providerId: choice.providerId,
        modelId: choice.modelId,
        connection: { auth: 'credential', credentialId: choice.credentialId },
      };
  }
}

/** A short user-facing name, e.g. "平台默认 · DeepSeek Flash" is built by the UI from these parts. */
export function classmateModelLabel(choice: ClassmateModelChoice): string {
  if (choice.kind === 'platform') {
    const entry = getPlatformDefaultCatalog().entries.find(
      (candidate) => candidate.defaultId === choice.defaultId,
    );
    return entry ? entry.displayName : choice.defaultId;
  }
  return `${choice.providerId}:${choice.modelId}`;
}

export interface ClassmateModelDeps {
  credentialDatabase?: CredentialDatabaseFactory;
  resolve?: typeof resolveBinding;
}

/**
 * Check a custom choice for one owner and return the binding it resolves to.
 * Throws STUDY_CLASSMATE_MODEL_UNAVAILABLE with a fixed reason.
 */
export async function resolveClassmateModelChoice(
  ownerId: string,
  choice: ClassmateModelChoice,
  stage: LlmStage,
  options: { requireTools?: boolean } = {},
  deps: ClassmateModelDeps = {},
): Promise<ModelBinding> {
  if (choice.kind === 'platform') {
    try {
      const platform = resolvePlatformDefault(choice.defaultId, 'text');
      if (!platform) throw classmateModelUnavailable('platform_unavailable');
    } catch (error) {
      if (error instanceof PlatformDefaultModelError) {
        throw classmateModelUnavailable('platform_unavailable');
      }
      throw error;
    }
  } else if (choice.kind === 'server') {
    const models = serverAnswerModels()[choice.providerId];
    if (!models) throw classmateModelUnavailable('server_provider_unavailable');
    if (models.length > 0 && !models.includes(choice.modelId)) {
      throw classmateModelUnavailable('model_unresolvable');
    }
  } else {
    const database = deps.credentialDatabase ?? defaultCredentialDatabase;
    const vault = new CredentialVault(await database(ownerId), ownerId);
    const summary = await vault.get(choice.credentialId);
    if (!summary || summary.status === 'revoked') {
      throw classmateModelUnavailable('credential_missing');
    }
    if (summary.status === 'reauth_required') {
      throw classmateModelUnavailable('credential_reauth_required');
    }
    if (summary.providerId !== choice.providerId) {
      throw classmateModelUnavailable('credential_provider_mismatch');
    }
  }
  let binding: ModelBinding;
  try {
    binding = await (deps.resolve ?? resolveBinding)({
      selection: classmateModelSelection(choice),
      stage,
      ownerId,
    });
  } catch (error) {
    if (
      error instanceof ModelSelectionError ||
      error instanceof GatewayError ||
      error instanceof PlatformDefaultModelError
    ) {
      throw classmateModelUnavailable('model_unresolvable');
    }
    throw error;
  }
  if (!binding.credentialReady) throw classmateModelUnavailable('credential_not_ready');
  if (options.requireTools && binding.capabilities.tools === false) {
    throw classmateModelUnavailable('tools_unsupported');
  }
  return binding;
}

/** Inherit → undefined (the caller keeps its own model); custom → the checked binding. */
export async function resolveClassmateModelPolicy(
  ownerId: string,
  policy: ClassmateModelPolicy,
  stage: LlmStage,
  options: { requireTools?: boolean } = {},
  deps: ClassmateModelDeps = {},
): Promise<ModelBinding | undefined> {
  if (policy.mode === 'inherit') return undefined;
  return resolveClassmateModelChoice(ownerId, policy.model, stage, options, deps);
}

export interface ClassmateModelOptions {
  platform: Array<{ defaultId: string; label: string; available: boolean }>;
  credentials: Array<{ credentialId: string; providerId: string; label: string; status: string }>;
  server: Array<{ providerId: string; models: string[] }>;
}

/** What the classmate form may offer this owner. Metadata only. */
export async function listClassmateModelOptions(
  ownerId: string,
  deps: Pick<ClassmateModelDeps, 'credentialDatabase'> = {},
): Promise<ClassmateModelOptions> {
  const platform = getPlatformDefaultCatalog()
    .entries.filter((entry) => entry.capability === 'text')
    .map((entry) => ({
      defaultId: entry.defaultId,
      label: entry.displayName,
      available: entry.available,
    }));
  let credentials: ClassmateModelOptions['credentials'] = [];
  try {
    const database = deps.credentialDatabase ?? defaultCredentialDatabase;
    const vault = new CredentialVault(await database(ownerId), ownerId);
    credentials = (await vault.list()).map((summary) => ({
      credentialId: summary.id,
      providerId: summary.providerId,
      label: summary.accountLabel ?? summary.providerId,
      status: summary.status,
    }));
  } catch {
    // Deployments without the credential vault (no v21 / no encryption key)
    // simply offer no signed-in accounts.
    credentials = [];
  }
  const server = Object.entries(serverAnswerModels()).map(([providerId, models]) => ({
    providerId,
    models,
  }));
  return { platform, credentials, server };
}

/**
 * Server-configured providers a classmate may answer with, and their models
 * (empty = the provider's whole catalog). Platform-default backing providers
 * are not offered, and the study embedding model is not a chat model: a
 * provider configured only for embeddings is left out.
 */
function serverAnswerModels(): Record<string, string[]> {
  const embedding = studyEmbeddingSpec();
  const result: Record<string, string[]> = {};
  for (const [providerId, info] of Object.entries(getServerProviders())) {
    if (isPlatformDefaultBackingProvider('providers', providerId)) continue;
    const configured = info.models ?? [];
    const models = configured.filter(
      (modelId) => !(embedding?.providerId === providerId && embedding.modelId === modelId),
    );
    if (configured.length > 0 && models.length === 0) continue;
    result[providerId] = models;
  }
  return result;
}

/** Save-time check for the classmate form: a custom choice must resolve for this owner now. */
export async function assertClassmateModelPolicy(
  ownerId: string,
  policy: ClassmateModelPolicy,
  deps: ClassmateModelDeps = {},
): Promise<void> {
  await resolveClassmateModelPolicy(ownerId, policy, 'chat-adapter', {}, deps);
}
