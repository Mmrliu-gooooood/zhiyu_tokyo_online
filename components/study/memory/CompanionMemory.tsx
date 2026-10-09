'use client';

/**
 * Memory in an after-class chat (learning plan B06):
 * - a confirm prompt when the student explicitly states a standing wish
 *   ("以后先举例子") — nothing is stored unless they confirm;
 * - a header note saying what the latest turn took from Memory.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Brain, X } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  declinePreferenceSuggestion,
  fetchPreferences,
  savePreference,
} from '@/lib/study/memory/client';
import {
  preferenceSuppressionKey,
  suggestionsToOffer,
  type MemoryTurnInfo,
  type PreferenceSuggestion,
  type PreferenceView,
} from '@/lib/study/memory/contracts';

export function useMemorySuggestions(enabled: boolean) {
  const [preferences, setPreferences] = useState<PreferenceView[]>([]);
  const [suppressed, setSuppressed] = useState<Set<string>>(new Set());
  const [offer, setOffer] = useState<{
    suggestion: PreferenceSuggestion;
    excerpt: string;
    sessionId: string | null;
    spaceId: string | null;
  } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetchPreferences()
      .then((value) => {
        if (cancelled) return;
        setPreferences(value.preferences);
        setSuppressed(new Set(value.suppressedSuggestions));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  /** Call after a message was sent. Offers at most one preference at a time. */
  const consider = useCallback(
    (text: string, sessionId: string | null, spaceId: string | null) => {
      if (!enabled) return;
      const [first] = suggestionsToOffer(text, preferences, suppressed, spaceId);
      if (first) {
        setOffer({
          suggestion: first,
          excerpt: Array.from(text).slice(0, 120).join(''),
          sessionId,
          spaceId,
        });
      }
    },
    [enabled, preferences, suppressed],
  );

  const accept = useCallback(
    async (scope: 'global' | 'space') => {
      if (!offer) return;
      const preference = await savePreference({
        key: offer.suggestion.key,
        value: offer.suggestion.value,
        spaceId: scope === 'space' ? offer.spaceId : null,
        origin: 'confirmed_prompt',
        evidence: {
          ...(offer.sessionId ? { sessionId: offer.sessionId } : {}),
          excerpt: offer.excerpt,
        },
      });
      setPreferences((list) => [
        ...list.filter(
          (item) => !(item.key === preference.key && item.spaceId === preference.spaceId),
        ),
        preference,
      ]);
      setOffer(null);
    },
    [offer],
  );

  const decline = useCallback(async () => {
    if (!offer) return;
    const { key, value } = offer.suggestion;
    setOffer(null);
    setSuppressed((set) => new Set([...set, preferenceSuppressionKey(key, value)]));
    await declinePreferenceSuggestion(key, value).catch(() => undefined);
  }, [offer]);

  return { offer, consider, accept, decline };
}

export function MemorySuggestionBar({
  offer,
  spaceName,
  onAccept,
  onDecline,
}: {
  offer: { suggestion: PreferenceSuggestion; spaceId: string | null };
  spaceName: string;
  onAccept: (scope: 'global' | 'space') => Promise<void>;
  onDecline: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const choice = t(`study.memory.choice.${offer.suggestion.key}.${offer.suggestion.value}`);
  const accept = async (scope: 'global' | 'space') => {
    setBusy(true);
    try {
      await onAccept(scope);
      toast.success(t('study.memory.suggest.saved', { choice }));
    } catch {
      toast.error(t('study.errors.generic'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs"
      data-testid="memory-suggestion"
    >
      <Brain className="size-3.5 text-primary" />
      <span className="min-w-0 flex-1">{t('study.memory.suggest.ask', { choice })}</span>
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => void accept('global')}>
        {t('study.memory.suggest.allSubjects')}
      </Button>
      {offer.spaceId && spaceName ? (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void accept('space')}>
          {t('study.memory.suggest.onlySpace', { space: spaceName })}
        </Button>
      ) : null}
      <Button
        size="icon"
        variant="ghost"
        className="size-7"
        aria-label={t('study.memory.suggest.decline')}
        title={t('study.memory.suggest.decline')}
        disabled={busy}
        onClick={onDecline}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}

/** What the latest turn took from Memory (from its server-side turn record). */
export function MemoryTurnNote({ info }: { info: MemoryTurnInfo | undefined }) {
  const { t } = useI18n();
  if (!info || info.state === 'unavailable') return null;
  const count = (kind: string) => info.refs.filter((ref) => ref.startsWith(`${kind}:`)).length;
  const text =
    info.state === 'off'
      ? t('study.memory.turn.off')
      : info.state === 'space_off'
        ? t('study.memory.turn.spaceOff')
        : info.refs.length
          ? t('study.memory.turn.used', {
              preferences: count('pref'),
              facts: count('fact') + count('goal'),
            })
          : t('study.memory.turn.none');
  return (
    <p className="mt-1 text-xs text-muted-foreground" data-testid="companion-memory">
      {text}{' '}
      <Link href="/study/memory" className="underline underline-offset-2 hover:text-foreground">
        {t('study.memory.turn.manage')}
      </Link>
    </p>
  );
}
