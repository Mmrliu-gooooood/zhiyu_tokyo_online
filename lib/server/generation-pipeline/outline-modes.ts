import type { SceneOutline } from '@/lib/types/generation';

function normalizeTaskEngineProceduralOutline(
  outline: SceneOutline,
  requirement: string,
): SceneOutline {
  const widgetOutline = outline.widgetOutline ?? {};

  return {
    ...outline,
    type: 'interactive',
    widgetType: 'procedural-skill',
    widgetOutline: {
      ...widgetOutline,
      procedureType: widgetOutline.procedureType ?? 'inspection',
      task: widgetOutline.task || requirement,
      tools:
        widgetOutline.tools && widgetOutline.tools.length > 0
          ? widgetOutline.tools
          : ['required PPE', 'task checklist'],
      steps:
        widgetOutline.steps && widgetOutline.steps.length > 0
          ? widgetOutline.steps
          : ['Confirm task conditions', 'Select required tools', 'Complete safety check'],
      successCriteria:
        widgetOutline.successCriteria && widgetOutline.successCriteria.length > 0
          ? widgetOutline.successCriteria
          : ['Required checks completed', 'Unsafe conditions are not ignored'],
      errorConsequences:
        widgetOutline.errorConsequences && widgetOutline.errorConsequences.length > 0
          ? widgetOutline.errorConsequences
          : ['Unsafe or incorrect actions require stopping and rechecking'],
    },
  };
}

function normalizeTaskEngineSlideOutline(outline: SceneOutline): SceneOutline {
  const normalized: SceneOutline = {
    ...outline,
    type: 'slide',
  };
  delete normalized.widgetType;
  delete normalized.widgetOutline;
  delete normalized.interactiveConfig;
  return normalized;
}

const ORDINARY_WIDGET_TYPES = new Set(['simulation', 'diagram', 'code', 'game', 'visualization3d']);

export function normalizeTaskEngineOutline(
  outline: SceneOutline,
  requirement: string,
): SceneOutline {
  if (outline.type === 'slide') {
    return normalizeTaskEngineSlideOutline(outline);
  }

  if (outline.type === 'interactive' && outline.widgetType === 'procedural-skill') {
    return normalizeTaskEngineProceduralOutline(outline, requirement);
  }

  if (
    outline.type === 'interactive' &&
    outline.widgetType &&
    ORDINARY_WIDGET_TYPES.has(outline.widgetType)
  ) {
    return outline;
  }

  return normalizeTaskEngineSlideOutline(outline);
}

export function sanitizeNonTaskEngineOutline(outline: SceneOutline): SceneOutline {
  if (outline.widgetType !== 'procedural-skill') {
    return outline;
  }

  const widgetOutline = { ...(outline.widgetOutline ?? {}) };
  delete widgetOutline.procedureType;
  delete widgetOutline.task;
  delete widgetOutline.tools;
  delete widgetOutline.steps;
  delete widgetOutline.successCriteria;
  delete widgetOutline.errorConsequences;

  // procedural-skill is gated behind taskEngineMode to protect ordinary MAIC generation.
  return {
    ...outline,
    type: 'interactive',
    widgetType: 'diagram',
    description: outline.description
      ? `${outline.description} Present this as a process or structure diagram.`
      : 'Present this topic as a process or structure diagram.',
    widgetOutline,
  };
}
