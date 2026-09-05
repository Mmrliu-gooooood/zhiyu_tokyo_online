import { createHash } from 'node:crypto';
import { getDocumentExtractorProviders } from '@/lib/document/extractors/registry';
import {
  getMediaExtractorProviders,
  selectMediaExtractorProvider,
} from '@/lib/document/extractors/media-registry';
import {
  getServerPDFProviders,
  resolvePDFApiKey,
  resolvePDFBaseUrl,
  resolveServerMediaExtractorConfig,
} from '@/lib/server/provider-config';
import type { GenerationInput } from '@/lib/server/generation-jobs/contracts';
import type { DocumentArtifact, MediaArtifact } from '@/lib/document/types';
import type { PipelineAssets } from './services';
import { PipelineExecution } from './execution';

/** Uses the same extractor registry as session materials, with job-owned assets. */
export async function prepareMaterials(
  input: GenerationInput,
  execution: PipelineExecution,
  assets: PipelineAssets,
): Promise<GenerationInput['materials']> {
  if (input.materials?.text || !input.materials?.sources?.length) return input.materials ?? {};
  const texts: string[] = [];
  const images = [...(input.materials.images ?? [])];
  for (const [sourceIndex, source] of input.materials.sources.entries()) {
    const extracted = await execution.checkpoint(`material:${source.assetId}`, source, async () => {
      const raw = await assets.read(source.assetId);
      if (createHash('sha256').update(raw.bytes).digest('hex') !== source.digest)
        throw new Error('MATERIAL_DIGEST_MISMATCH');
      const sourceInput = {
        buffer: Buffer.from(raw.bytes),
        fileName: source.name,
        fileSize: raw.bytes.byteLength,
        mimeType: raw.mimeType,
      };
      let artifact: DocumentArtifact | MediaArtifact;
      const mediaProviders = getMediaExtractorProviders();
      if (mediaProviders.some((provider) => provider.supportedMimeTypes.includes(raw.mimeType))) {
        const config = {
          ...resolveServerMediaExtractorConfig(),
          ...(source.providerId ? { providerId: source.providerId } : {}),
        };
        const provider = await selectMediaExtractorProvider({
          mimeType: raw.mimeType,
          input: { ...sourceInput, config },
          providers: mediaProviders,
        });
        if (source.providerId && provider.id !== source.providerId)
          throw new Error('MATERIAL_PROVIDER_UNAVAILABLE');
        artifact = await execution.external(
          `material:${source.assetId}:extract`,
          { source, provider: provider.id, version: provider.version },
          'media',
          provider.id,
          (signal) => {
            signal.throwIfAborted();
            // Extractor contracts currently have no cancellation input. The
            // execution boundary races the deadline and rejects late artifacts.
            return provider.extract({
              ...sourceInput,
              config: { ...config, providerId: provider.id },
            });
          },
        );
      } else {
        const configured = getServerPDFProviders();
        const candidates = getDocumentExtractorProviders().filter((provider) =>
          provider.supportedMimeTypes.includes(raw.mimeType),
        );
        const provider = source.providerId
          ? candidates.find((candidate) => candidate.id === source.providerId)
          : (candidates.find((candidate) => candidate.id in configured) ?? candidates[0]);
        if (!provider) throw new Error('MATERIAL_TYPE_UNSUPPORTED');
        artifact = await execution.external(
          `material:${source.assetId}:extract`,
          { source, provider: provider.id, version: provider.version },
          'media',
          provider.id,
          (signal) => {
            signal.throwIfAborted();
            return provider.extract({
              ...sourceInput,
              config: {
                providerId: provider.id,
                apiKey: resolvePDFApiKey(provider.id) || undefined,
                baseUrl: resolvePDFBaseUrl(provider.id),
                allowEnvFallback: true,
              },
            });
          },
        );
      }
      const text =
        'blocks' in artifact
          ? artifact.blocks
              .filter((block) => block.type === 'text' || block.type === 'markdown')
              .map((block) => block.text ?? '')
              .join('\n\n')
          : (artifact.transcript ?? [])
              .map((segment) => `[${segment.startMs}-${segment.endMs}ms] ${segment.text}`)
              .join('\n');
      const extractedImages: NonNullable<NonNullable<GenerationInput['materials']>['images']> = [];
      for (const [index, asset] of (artifact.assets ?? []).entries()) {
        if (asset.type !== 'image' || !asset.data) continue;
        const assetId = await assets.write(
          `material:${source.assetId}:image:${index}`,
          Buffer.from(asset.data, 'base64'),
          asset.mimeType ?? 'image/png',
        );
        extractedImages.push({
          id: `src_${sourceIndex}_img_${index}`,
          assetId,
          pageNumber: 'pageNumber' in asset ? (asset.pageNumber ?? 0) : 0,
          description: asset.description,
          sourceDocumentId: source.assetId,
          sourceDocumentName: source.name,
          sourceDocumentOrder: sourceIndex,
        });
      }
      if (!text.trim() && !extractedImages.length) throw new Error('EMPTY_MATERIAL_EXTRACTION');
      return { text, images: extractedImages };
    });
    texts.push(`## ${source.name ?? `Source ${sourceIndex + 1}`}\n${extracted.text}`);
    images.push(...extracted.images);
  }
  return { ...input.materials, text: texts.join('\n\n'), images };
}
