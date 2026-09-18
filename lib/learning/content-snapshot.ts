import type { Scene, SlideContent } from '@/lib/types/stage';
import { resolvePBLContent } from '@/lib/pbl/legacy/read';
import { stripToDesignTemplate } from '@/lib/pbl/v2/runtime/learner-state';
import {
  LEARNING_CHECK_LIMITS,
  LEARNING_SNAPSHOT_ALGORITHM_VERSION,
  type LearningContentSnapshot,
  type LearningSourceRef,
} from './contracts';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, member]) => `${JSON.stringify(key)}:${stable(member)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function plainText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function slideContent(content: SlideContent): unknown[] {
  return content.canvas.elements.flatMap((element): unknown[] => {
    switch (element.type) {
      case 'text':
        return [{ type: 'text', text: plainText(element.content) }];
      case 'shape':
        return element.text ? [{ type: 'shape-text', text: plainText(element.text.content) }] : [];
      case 'table':
        return [{ type: 'table', rows: element.data.map((row) => row.map((cell) => cell.text)) }];
      case 'code':
        return [
          {
            type: 'code',
            language: element.language,
            fileName: element.fileName,
            code: element.lines.map((line) => line.content).join('\n'),
          },
        ];
      case 'latex':
        return [{ type: 'latex', latex: element.latex }];
      case 'chart':
        return [{ type: 'chart', chartType: element.chartType, data: element.data }];
      default:
        return [];
    }
  });
}

function narration(scene: Scene): unknown[] {
  return (scene.actions ?? []).flatMap((action): unknown[] => {
    if (action.type === 'speech') return [{ type: 'speech', text: action.text }];
    if (action.type === 'discussion') {
      return [{ type: 'discussion', topic: action.topic, prompt: action.prompt }];
    }
    if (action.type === 'wb_draw_text')
      return [{ type: action.type, text: plainText(action.content) }];
    if (action.type === 'wb_draw_code') return [{ type: action.type, code: action.code }];
    if (action.type === 'wb_draw_latex') return [{ type: action.type, latex: action.latex }];
    if (action.type === 'wb_draw_table') return [{ type: action.type, data: action.data }];
    return [];
  });
}

function omitRuntimeFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitRuntimeFields);
  if (!value || typeof value !== 'object') return value;
  const omitted = new Set([
    'createdAt',
    'updatedAt',
    'uiPhase',
    'status',
    'submissions',
    'evaluations',
    'threads',
    'engagementEvents',
    'runtimeEvents',
    'runtimeResetEpoch',
    'pendingHandover',
    'pendingTaskCompletion',
    'pendingOpenTaskPriorQuizResults',
    'internalAssessment',
    'completionReason',
    'engagement',
  ]);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !omitted.has(key))
      .map(([key, member]) => [key, omitRuntimeFields(member)]),
  );
}

async function sceneEvidence(
  scene: Scene,
): Promise<{ canonical: unknown; text: string; limited: boolean }> {
  const common = { id: scene.id, type: scene.type, title: scene.title };
  const teaching = narration(scene);
  if (scene.content.type === 'slide') {
    const semantic = slideContent(scene.content);
    return {
      canonical: { ...common, semantic, teaching },
      text: plainText(stable([...semantic, ...teaching])),
      limited: semantic.length === 0,
    };
  }
  if (scene.content.type === 'quiz') {
    const questions = scene.content.questions.map((question) => ({
      id: question.id,
      type: question.type,
      question: question.question,
      options: question.options,
      answer: question.answer,
      analysis: question.analysis,
      commentPrompt: question.commentPrompt,
      hasAnswer: question.hasAnswer,
      points: question.points,
    }));
    return {
      canonical: { ...common, questions, teaching },
      text: plainText(stable([...questions, ...teaching])),
      limited: false,
    };
  }
  if (scene.content.type === 'interactive') {
    const rawSource = stable({
      html: scene.content.html,
      url: scene.content.url,
      widgetType: scene.content.widgetType,
      widgetConfig: scene.content.widgetConfig,
    });
    const sourceDigest = await sha256(rawSource);
    const visible = [
      scene.content.html ? plainText(scene.content.html) : '',
      scene.content.widgetConfig ? plainText(stable(scene.content.widgetConfig)) : '',
      ...teaching.map((part) => plainText(stable(part))),
    ]
      .filter(Boolean)
      .join('\n');
    return {
      canonical: { ...common, sourceDigest, teaching },
      text: visible,
      limited: true,
    };
  }
  const resolved = resolvePBLContent(scene.content);
  if (resolved.kind === 'v2') {
    const design = omitRuntimeFields(stripToDesignTemplate(resolved.projectV2));
    return {
      canonical: { ...common, design, teaching },
      text: plainText(stable([design, ...teaching])),
      limited: false,
    };
  }
  if (resolved.kind === 'legacy') {
    const legacy = omitRuntimeFields({
      projectInfo: resolved.projectConfig.projectInfo,
      agents: resolved.projectConfig.agents.map((agent) => ({
        name: agent.name,
        actor_role: agent.actor_role,
        system_prompt: agent.system_prompt,
      })),
      issues: resolved.projectConfig.issueboard.issues.map((issue) => ({
        id: issue.id,
        title: issue.title,
        description: issue.description,
        notes: issue.notes,
        generated_questions: issue.generated_questions,
      })),
    });
    return {
      canonical: { ...common, legacy, teaching },
      text: plainText(stable([legacy, ...teaching])),
      limited: false,
    };
  }
  return {
    canonical: { ...common, empty: true, teaching },
    text: plainText(stable(teaching)),
    limited: true,
  };
}

export async function createLearningContentSnapshot(input: {
  courseTitle: string;
  scenes: readonly Scene[];
}): Promise<LearningContentSnapshot> {
  const ordered = [...input.scenes].sort(
    (left, right) => left.order - right.order || left.id.localeCompare(right.id),
  );
  const evidence = await Promise.all(ordered.map(sceneEvidence));
  const canonical = {
    algorithm: LEARNING_SNAPSHOT_ALGORITHM_VERSION,
    courseTitle: input.courseTitle,
    scenes: evidence.map((item) => item.canonical),
  };
  const fragments = await Promise.all(
    evidence.map(async (item, index) => {
      const scene = ordered[index]!;
      const sourceRef: LearningSourceRef = {
        sceneId: scene.id,
        sceneType: scene.type,
        sceneTitle: scene.title,
      };
      const text = item.text.slice(0, LEARNING_CHECK_LIMITS.fragmentCharacters);
      return { id: `scene:${scene.id}`, sourceRef, text, digest: await sha256(text) };
    }),
  );
  const selected = fragments.slice(0, LEARNING_CHECK_LIMITS.evidenceFragments);
  let used = 0;
  const limitedByTotal = (
    await Promise.all(
      selected.map(async (fragment) => {
        const remaining = Math.max(0, LEARNING_CHECK_LIMITS.evidenceCharacters - used);
        const text = fragment.text.slice(0, remaining);
        used += text.length;
        return { ...fragment, text, digest: await sha256(text) };
      }),
    )
  ).filter((fragment) => fragment.text.length > 0);
  const limitedSceneIds = ordered
    .filter(
      (scene, index) =>
        evidence[index]!.limited ||
        !limitedByTotal.some((fragment) => fragment.sourceRef.sceneId === scene.id),
    )
    .map((scene) => scene.id);
  return {
    snapshotAlgorithmVersion: LEARNING_SNAPSHOT_ALGORITHM_VERSION,
    contentRevision: await sha256(stable(canonical)),
    courseTitle: input.courseTitle,
    fragments: limitedByTotal,
    coverage: {
      includedSceneIds: limitedByTotal.map((fragment) => fragment.sourceRef.sceneId),
      limitedSceneIds,
      notes:
        limitedSceneIds.length > 0
          ? ['Some interactive or oversized content could only be partially inspected.']
          : [],
    },
  };
}
