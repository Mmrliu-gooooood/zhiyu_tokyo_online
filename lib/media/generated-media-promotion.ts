import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';
import { slideMediaReferenceSlots } from './slide-media-slots';

/** Replace a generated placeholder only in the slide locations that reference it. */
export function promoteSceneMediaRef(scene: Scene, placeholder: string, assetId: string): Scene {
  if (scene.content?.type !== 'slide') return scene;
  const content = structuredClone(scene.content);
  let changed = false;
  for (const slot of slideMediaReferenceSlots(content.canvas)) {
    if (slot.read() !== placeholder) continue;
    slot.write(assetId);
    changed = true;
  }
  return changed ? ({ ...scene, content } as Scene) : scene;
}

/** A promoted request no longer needs to call its generation provider on reload. */
export function promoteOutlineMediaRef(
  outline: SceneOutline,
  placeholder: string,
  assetId: string,
): SceneOutline {
  if (!outline.mediaGenerations?.some((request) => request.elementId === placeholder)) {
    return outline;
  }
  return {
    ...outline,
    mediaGenerations: outline.mediaGenerations.map((request) =>
      request.elementId === placeholder ? { ...request, elementId: assetId } : request,
    ),
  };
}
