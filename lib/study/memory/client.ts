'use client';

/**
 * Browser client for the Memory and preference APIs (learning plan B06).
 * Errors surface as StudyApiError with the server's fixed code.
 */
import { studyRequest } from '@/lib/study/spaces/client';
import type {
  ChoicePreferenceKey,
  FactView,
  MemoryControlView,
  PreferenceEvidence,
  PreferenceKey,
  PreferenceOrigin,
  PreferenceView,
} from '@/lib/study/memory/contracts';
import type { MemoryOverview } from '@/lib/study/memory/overview';

export function fetchMemoryOverview(): Promise<MemoryOverview> {
  return studyRequest<MemoryOverview>('/api/study/memory');
}

export async function setMemorySwitch(
  spaceId: string | null,
  enabled: boolean,
  baseRevision?: number,
): Promise<MemoryControlView> {
  const body = await studyRequest<{ control: MemoryControlView }>('/api/study/memory/controls', {
    method: 'PUT',
    json: { spaceId, enabled, ...(baseRevision === undefined ? {} : { baseRevision }) },
  });
  return body.control;
}

export function fetchPreferences(): Promise<{
  preferences: PreferenceView[];
  suppressedSuggestions: string[];
}> {
  return studyRequest('/api/study/preferences');
}

export async function savePreference(input: {
  key: PreferenceKey;
  value: string;
  spaceId: string | null;
  origin?: PreferenceOrigin;
  evidence?: PreferenceEvidence;
  baseRevision?: number;
}): Promise<PreferenceView> {
  const body = await studyRequest<{ preference: PreferenceView }>('/api/study/preferences', {
    method: 'PUT',
    json: input,
  });
  return body.preference;
}

export async function removePreference(key: PreferenceKey, spaceId: string | null): Promise<void> {
  const params = new URLSearchParams({ key });
  if (spaceId) params.set('spaceId', spaceId);
  await studyRequest(`/api/study/preferences?${params.toString()}`, { method: 'DELETE' });
}

export async function addFact(input: {
  text: string;
  spaceId: string | null;
  correctsKey?: string;
}): Promise<FactView> {
  const body = await studyRequest<{ fact: FactView }>('/api/study/memory/facts', {
    method: 'POST',
    json: input,
  });
  return body.fact;
}

export async function correctFact(
  factId: string,
  input: { text: string; spaceId?: string | null; baseRevision: number },
): Promise<FactView> {
  const body = await studyRequest<{ fact: FactView }>(
    `/api/study/memory/facts/${encodeURIComponent(factId)}`,
    { method: 'PATCH', json: input },
  );
  return body.fact;
}

export async function removeFact(factId: string): Promise<void> {
  await studyRequest(`/api/study/memory/facts/${encodeURIComponent(factId)}`, {
    method: 'DELETE',
  });
}

export async function removeLearningRecord(seq: number): Promise<void> {
  await studyRequest(`/api/study/memory/records/${seq}`, { method: 'DELETE' });
}

export async function declinePreferenceSuggestion(
  key: ChoicePreferenceKey,
  value: string,
): Promise<void> {
  await studyRequest('/api/study/memory/suggestions', { method: 'POST', json: { key, value } });
}

export async function clearMemoryParts(options: {
  preferences: boolean;
  facts: boolean;
  records: boolean;
  rawQuizAttempts: boolean;
}): Promise<Record<string, number>> {
  const body = await studyRequest<{ cleared: Record<string, number> }>('/api/study/memory/clear', {
    method: 'POST',
    json: options,
  });
  return body.cleared;
}
