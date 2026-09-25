import {
  getServerProviders,
  getServerTTSProviders,
  getServerASRProviders,
  getServerPDFProviders,
  getServerImageProviders,
  getServerVideoProviders,
  getServerWebSearchProviders,
  getParallelSceneConcurrency,
  getPlatformDefaultCatalog,
  isPlatformDefaultBackingProvider,
} from '@/lib/server/provider-config';
import { hostedAuthGate } from '@/lib/auth/api';
import type { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
import {
  backgroundGenerationEnabled,
  generationRequestReadiness,
} from '@/lib/server/generation-jobs/runtime';

const log = createLogger('ServerProviders');

function userProviderProjection<T extends object>(
  section: 'providers' | 'image' | 'video' | 'tts',
  providers: Record<string, T>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(providers).filter(
      ([providerId, info]) =>
        !isPlatformDefaultBackingProvider(section, providerId) ||
        ('disabled' in info && info.disabled === true),
    ),
  );
}

export async function GET(request: NextRequest) {
  const denied = await hostedAuthGate(request);
  if (denied) return denied;
  try {
    const catalogVersion = request.nextUrl.searchParams.get('catalogVersion');
    const version2 = catalogVersion === '2';
    const providers = getServerProviders();
    const tts = getServerTTSProviders();
    const image = getServerImageProviders();
    const video = getServerVideoProviders();
    return apiSuccess({
      providers: version2 ? userProviderProjection('providers', providers) : providers,
      tts: version2 ? userProviderProjection('tts', tts) : tts,
      asr: getServerASRProviders(),
      pdf: getServerPDFProviders(),
      image: version2 ? userProviderProjection('image', image) : image,
      video: version2 ? userProviderProjection('video', video) : video,
      webSearch: getServerWebSearchProviders(),
      ...(version2 ? { platformDefaults: getPlatformDefaultCatalog() } : {}),
      generation: {
        parallelSceneConcurrency: getParallelSceneConcurrency(),
        background: backgroundGenerationEnabled()
          ? {
              enabled: true,
              available: (await generationRequestReadiness()).accepting,
              pipelineVersion: '1',
            }
          : { enabled: false, available: false, pipelineVersion: '1' },
      },
    });
  } catch (error) {
    log.error('Error fetching server providers:', error);
    return apiError(
      'INTERNAL_ERROR',
      500,
      error instanceof Error ? error.message : 'Unknown error',
    );
  }
}
