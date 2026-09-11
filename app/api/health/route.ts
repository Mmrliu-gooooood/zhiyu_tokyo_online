import { apiSuccess } from '@/lib/server/api-response';
import {
  getServerWebSearchProviders,
  getServerImageProviders,
  getServerVideoProviders,
  getServerTTSProviders,
  getPlatformDefaultCatalog,
  isPlatformDefaultBackingProvider,
} from '@/lib/server/provider-config';
import type { PlatformDefaultCapability } from '@/lib/types/platform-default-models';

const version = process.env.npm_package_version || '0.1.0';

function hasAvailableCapability(
  capability: Exclude<PlatformDefaultCapability, 'text'>,
  providers: Record<string, { disabled?: boolean }>,
  platformDefaults: ReturnType<typeof getPlatformDefaultCatalog>,
) {
  if (
    platformDefaults.entries.some((entry) => entry.capability === capability && entry.available)
  ) {
    return true;
  }
  return Object.entries(providers).some(
    ([providerId, info]) =>
      !info.disabled && !isPlatformDefaultBackingProvider(capability, providerId),
  );
}

export async function GET() {
  const platformDefaults = getPlatformDefaultCatalog();
  return apiSuccess({
    status: 'ok',
    version,
    capabilities: {
      // A capability is available only when at least one provider is enabled —
      // force-disabled providers (disabled: true) do not count (#665).
      webSearch: Object.values(getServerWebSearchProviders()).some((info) => !info.disabled),
      imageGeneration: hasAvailableCapability('image', getServerImageProviders(), platformDefaults),
      videoGeneration: hasAvailableCapability('video', getServerVideoProviders(), platformDefaults),
      tts: hasAvailableCapability('tts', getServerTTSProviders(), platformDefaults),
    },
  });
}
