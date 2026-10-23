'use client';

/**
 * Subscription sign-in for one provider (plan 3.10, P6-5): connection state,
 * the sign-in flow (auth link, device code with countdown, pasted redirect or
 * code), cancel, and disconnect. Only a credential id ever reaches settings.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Copy, ExternalLink, Loader2, LogIn, Unplug, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { peekAccountUserId } from '@/lib/auth/account-environment';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import type { ProviderCredentialStatus } from '@/lib/types/settings';
import {
  ModelAuthClientError,
  OPEN_SIGN_IN_STATUSES,
  modelAuthClient,
  type SignInSession,
  type SignedInAccount,
} from '@/lib/utils/model-auth-client';

export interface CredentialUpdate {
  authMode?: 'oauth' | 'api-key';
  credentialId?: string;
  credentialStatus?: ProviderCredentialStatus;
}

interface SubscriptionSignInProps {
  providerId: string;
  credentialId?: string;
  credentialStatus?: ProviderCredentialStatus;
  onCredentialChange: (update: CredentialUpdate) => void;
}

const POLL_MS = 1500;

/**
 * Sign-ins that mint a key on the provider's side. Disconnecting deletes only
 * our copy, so the user is pointed at the provider's page to delete theirs.
 */
const UPSTREAM_KEY_PAGES: Readonly<Record<string, { name: string; url: string }>> = {
  openrouter: { name: 'OpenRouter', url: 'https://openrouter.ai/settings/keys' },
};

function errorKey(code: string | null | undefined): string {
  switch (code) {
    case 'MODEL_AUTH_ACCOUNT_INACTIVE':
      return 'settings.oauthAccountInactive';
    case 'MODEL_AUTH_BUSY':
      return 'settings.oauthBusy';
    case 'MODEL_AUTH_PROVIDER_UNAVAILABLE':
    case 'MODEL_AUTH_UNAVAILABLE':
      return 'settings.oauthSignInPending';
    default:
      return 'settings.oauthRequestFailed';
  }
}

function outcomeKey(session: SignInSession): string | undefined {
  switch (session.status) {
    case 'failed':
      return session.errorCode === 'MODEL_AUTH_ACCOUNT_INACTIVE'
        ? 'settings.oauthAccountInactive'
        : 'settings.oauthFailed';
    case 'expired':
      return 'settings.oauthExpired';
    case 'interrupted':
      return 'settings.oauthInterrupted';
    case 'cancelled':
      return 'settings.oauthCancelled';
    default:
      return undefined;
  }
}

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function SubscriptionSignIn({
  providerId,
  credentialId,
  credentialStatus,
  onCredentialChange,
}: SubscriptionSignInProps) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<'loading' | 'unavailable' | 'ready'>('loading');
  const [account, setAccount] = useState<SignedInAccount | undefined>();
  const [session, setSession] = useState<SignInSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Every provider change, account switch or unmount starts a new generation;
  // late responses from an older one are dropped.
  const generation = useRef(0);
  const props = useRef({ credentialId, credentialStatus, onCredentialChange });
  useEffect(() => {
    props.current = { credentialId, credentialStatus, onCredentialChange };
  });

  const open = session !== null && OPEN_SIGN_IN_STATUSES.includes(session.status);

  const loadAccount = useCallback(
    async (current: number) => {
      try {
        const [accounts, pending] = await Promise.all([
          modelAuthClient.listAccounts(),
          // A sign-in still running (the page was reloaded mid-way) is resumed.
          modelAuthClient.current(providerId).catch(() => null),
        ]);
        if (current !== generation.current) return;
        const found = accounts.find((item) => item.providerId === providerId);
        setAccount(found);
        if (pending) setSession(pending);
        setPhase('ready');
        const known = props.current;
        // Keep the saved reference in step with the server's view.
        if (found && (found.id !== known.credentialId || found.status !== known.credentialStatus)) {
          known.onCredentialChange({
            authMode: 'oauth',
            credentialId: found.id,
            credentialStatus: found.status,
          });
        } else if (!found && known.credentialId) {
          known.onCredentialChange({ credentialStatus: 'revoked' });
        }
      } catch (caught) {
        if (current !== generation.current) return;
        if (caught instanceof ModelAuthClientError && caught.status === 404) {
          setPhase('unavailable');
          return;
        }
        setPhase('ready');
        setError(errorKey(caught instanceof ModelAuthClientError ? caught.code : undefined));
      }
    },
    [providerId],
  );

  const reset = useCallback(() => {
    generation.current += 1;
    setSession(null);
    setAccount(undefined);
    setError(null);
    setInput('');
    setDisconnected(false);
    setPhase('loading');
    return generation.current;
  }, []);

  // Provider change: start over.
  useEffect(() => {
    const current = reset();
    void loadAccount(current);
    return () => {
      generation.current += 1;
    };
  }, [loadAccount, reset]);

  // Account switch: settings rehydrate for the new account; stop polling at once.
  // Settings also rehydrate for the same account (storage recovery after an
  // early write); that is no switch, so the panel keeps what it shows.
  useEffect(() => {
    const persist = useSettingsStore.persist;
    if (!persist) return;
    let accountUserId = peekAccountUserId();
    let switched = false;
    const stopHydrate = persist.onHydrate(() => {
      const next = peekAccountUserId();
      if (next === accountUserId) return;
      accountUserId = next;
      switched = true;
      reset();
    });
    const stopFinish = persist.onFinishHydration(() => {
      if (!switched) return;
      switched = false;
      void loadAccount(generation.current);
    });
    return () => {
      stopHydrate();
      stopFinish();
    };
  }, [loadAccount, reset]);

  // Poll an open sign-in until it ends.
  useEffect(() => {
    if (!open || !session) return;
    const current = generation.current;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const next = await modelAuthClient.get(session.id, controller.signal);
        if (current !== generation.current) return;
        setSession(next);
        if (next.status === 'complete' && next.credentialId) {
          props.current.onCredentialChange({
            authMode: 'oauth',
            credentialId: next.credentialId,
            credentialStatus: 'active',
          });
          void loadAccount(current);
        }
      } catch (caught) {
        if (controller.signal.aborted || current !== generation.current) return;
        setError(errorKey(caught instanceof ModelAuthClientError ? caught.code : undefined));
        setSession(null);
      }
    }, POLL_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, session, loadAccount]);

  // Countdown while a sign-in is open.
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open]);

  const start = async () => {
    const current = generation.current;
    setBusy(true);
    setError(null);
    setInput('');
    setDisconnected(false);
    try {
      const started = await modelAuthClient.start(providerId);
      if (current === generation.current) setSession(started);
    } catch (caught) {
      if (current === generation.current) {
        setError(errorKey(caught instanceof ModelAuthClientError ? caught.code : undefined));
      }
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!session) return;
    const current = generation.current;
    try {
      const ended = await modelAuthClient.cancel(session.id);
      if (current === generation.current) setSession(ended);
    } catch {
      if (current === generation.current) setSession(null);
    }
  };

  const submit = async (value: string) => {
    if (!session || !value.trim()) return;
    const current = generation.current;
    setBusy(true);
    try {
      const next = await modelAuthClient.submit(session.id, value);
      if (current === generation.current) {
        setSession(next);
        setInput('');
      }
    } catch (caught) {
      if (current === generation.current) {
        setError(errorKey(caught instanceof ModelAuthClientError ? caught.code : undefined));
      }
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!account) return;
    const current = generation.current;
    setBusy(true);
    setError(null);
    try {
      await modelAuthClient.disconnect(account.id);
      if (current !== generation.current) return;
      setAccount(undefined);
      setSession(null);
      setDisconnected(true);
      props.current.onCredentialChange({
        authMode: 'api-key',
        credentialId: undefined,
        credentialStatus: 'revoked',
      });
    } catch (caught) {
      if (current === generation.current) {
        setError(errorKey(caught instanceof ModelAuthClientError ? caught.code : undefined));
      }
    } finally {
      setBusy(false);
    }
  };

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable: the code stays visible for manual copy.
    }
  };

  if (phase === 'loading') {
    return (
      <div className="flex items-center gap-2 rounded-lg border p-3 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('settings.oauthLoading')}
      </div>
    );
  }
  if (phase === 'unavailable') {
    return (
      <div className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
        {t('settings.oauthSignInPending')}
      </div>
    );
  }

  const challenge = session?.challenge;
  const prompt = open ? challenge?.prompt : undefined;
  const remaining = session ? new Date(session.expiresAt).getTime() - now : 0;
  const outcome = session && !open ? outcomeKey(session) : undefined;
  const upstreamKeyPage = disconnected && !open ? UPSTREAM_KEY_PAGES[providerId] : undefined;

  return (
    <div className="space-y-3 rounded-lg border p-3 text-sm" data-testid="subscription-sign-in">
      {/* Connection state */}
      {!open && account?.status === 'active' && (
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-correct-ink" />
            <span>{t('settings.oauthStatusConnected')}</span>
            {account.accountLabel && (
              <span className="text-muted-foreground">
                {t('settings.oauthAccount', { label: account.accountLabel })}
              </span>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={disconnect} disabled={busy}>
            <Unplug className="mr-1 h-4 w-4" />
            {t('settings.oauthDisconnect')}
          </Button>
        </div>
      )}
      {!open && account?.status === 'reauth_required' && (
        <div className="flex items-center gap-2 text-review-ink">
          <XCircle className="h-4 w-4" />
          {t('settings.oauthStatusReauth')}
        </div>
      )}
      {!open && !account && (
        <p className="text-muted-foreground">{t('settings.oauthStatusNotConnected')}</p>
      )}

      {/* Sign-in in progress */}
      {open && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2 text-muted-foreground">
            <span className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              {session?.status === 'pending' &&
              challenge?.prompt === undefined &&
              !challenge?.authUrl &&
              !challenge?.deviceCode
                ? t('settings.oauthStarting')
                : session?.status === 'pending'
                  ? t('settings.oauthSubmitted')
                  : t('settings.oauthWaiting')}
            </span>
            <span className="tabular-nums">
              {t('settings.oauthExpiresIn', { time: formatRemaining(remaining) })}
            </span>
          </div>
          {challenge?.info && <p>{challenge.info.message}</p>}
          {challenge?.info?.links?.map((link) => (
            <a
              key={link.url}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block text-primary underline"
            >
              {link.label || link.url}
            </a>
          ))}
          {challenge?.authUrl && (
            <div className="space-y-1">
              <Button asChild size="sm">
                <a href={challenge.authUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="mr-1 h-4 w-4" />
                  {t('settings.oauthOpenAuthPage')}
                </a>
              </Button>
              {challenge.instructions && (
                <p className="text-muted-foreground">{challenge.instructions}</p>
              )}
            </div>
          )}
          {challenge?.deviceCode && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <code
                  className="rounded-md bg-muted px-3 py-1.5 font-mono text-lg tracking-widest"
                  data-testid="device-code"
                >
                  {challenge.deviceCode.userCode}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => copyCode(challenge.deviceCode!.userCode)}
                >
                  <Copy className="mr-1 h-4 w-4" />
                  {copied ? t('settings.oauthCopied') : t('settings.oauthCopyCode')}
                </Button>
              </div>
              <a
                href={challenge.deviceCode.verificationUri}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline"
              >
                {t('settings.oauthDeviceCodeHint', { uri: challenge.deviceCode.verificationUri })}
              </a>
            </div>
          )}
          {challenge?.progress && <p className="text-muted-foreground">{challenge.progress}</p>}
          {prompt && (
            <div className="space-y-2">
              <p>{prompt.message}</p>
              {prompt.kind === 'select' ? (
                <div className="flex flex-wrap gap-2">
                  {prompt.options?.map((option) => (
                    <Button
                      key={option.id}
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      title={option.description}
                      onClick={() => submit(option.id)}
                    >
                      {option.label}
                    </Button>
                  ))}
                </div>
              ) : (
                <form
                  className="flex gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submit(input);
                  }}
                >
                  <Input
                    type={prompt.kind === 'secret' ? 'password' : 'text'}
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder={prompt.placeholder}
                    value={input}
                    maxLength={4096}
                    onChange={(event) => setInput(event.target.value)}
                  />
                  <Button type="submit" size="sm" disabled={busy || !input.trim()}>
                    {t('settings.oauthSubmit')}
                  </Button>
                </form>
              )}
            </div>
          )}
          <Button variant="ghost" size="sm" onClick={cancel}>
            {t('settings.oauthCancel')}
          </Button>
        </div>
      )}

      {outcome && <p className="text-muted-foreground">{t(outcome)}</p>}
      {upstreamKeyPage && (
        <p className="text-muted-foreground" data-testid="upstream-key-notice">
          {t('settings.oauthUpstreamKeyNotice', { provider: upstreamKeyPage.name })}{' '}
          <a
            href={upstreamKeyPage.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline"
          >
            {t('settings.oauthUpstreamKeyLink', { provider: upstreamKeyPage.name })}
          </a>
        </p>
      )}
      {error && <p className="text-destructive">{t(error)}</p>}

      {!open && account?.status !== 'active' && (
        <Button size="sm" onClick={start} disabled={busy}>
          {busy ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <LogIn className="mr-1 h-4 w-4" />
          )}
          {account?.status === 'reauth_required'
            ? t('settings.oauthSignInAgain')
            : t('settings.oauthSignIn')}
        </Button>
      )}
    </div>
  );
}
