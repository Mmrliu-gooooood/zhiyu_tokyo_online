/**
 * Sealed pi AuthContext (plan D6): by default pi can read no environment
 * variable and no file, so a user request can never pick up a platform or
 * operator key from `process.env`. Only operator-managed ambient providers
 * (Bedrock, Vertex) get a context that exposes their own prefixes.
 */
import type { AuthContext } from '@earendil-works/pi-ai';

const SEALED: AuthContext = Object.freeze({
  env: async () => undefined,
  fileExists: async () => false,
});

export function sealedAuthContext(): AuthContext {
  return SEALED;
}

export const AMBIENT_ENV_PREFIXES = ['AWS_', 'BEDROCK_', 'GOOGLE_', 'GCLOUD_'] as const;

/** Read-through context limited to the given prefixes, for ambient operator auth. */
export function ambientAuthContext(
  prefixes: readonly string[] = AMBIENT_ENV_PREFIXES,
  env: Readonly<Record<string, string | undefined>> = process.env,
): AuthContext {
  return {
    env: async (name) => {
      if (!prefixes.some((prefix) => name.startsWith(prefix))) return undefined;
      const value = env[name];
      return typeof value === 'string' && value.trim() ? value : undefined;
    },
    fileExists: async (path) => {
      const { access } = await import('node:fs/promises');
      try {
        await access(path.startsWith('~') ? `${process.env.HOME ?? ''}${path.slice(1)}` : path);
        return true;
      } catch {
        return false;
      }
    },
  };
}
