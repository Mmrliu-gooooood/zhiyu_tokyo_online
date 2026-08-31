'use client';

import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { ArrowRight, ShieldCheck, LoaderCircle } from 'lucide-react';
import { ZhiyuLockup } from '@/components/brand/ZhiyuLockup';
import { projectAccessCodeVisualState } from '@/lib/access-code/presentation';

interface AccessCodeModalProps {
  open: boolean;
  onSuccess: () => void;
}

export function AccessCodeModal({ open, onSuccess }: AccessCodeModalProps) {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reduceMotion = useReducedMotion();
  const visualState = projectAccessCodeVisualState({ error, loading, success });

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();

    return () => {
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
      previouslyFocused?.focus();
    };
  }, [open]);

  function keepFocusInDialog(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      inputRef.current?.focus();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'input:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!code || loading) return;
    setError('');
    setLoading(true);
    // Keep a stable focus target while the submit control becomes disabled.
    // The secure gate must never hand focus back to the inert application.
    inputRef.current?.focus();

    try {
      const res = await fetch('/api/access-code/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });

      if (res.ok) {
        setSuccess(true);
        successTimerRef.current = setTimeout(onSuccess, reduceMotion ? 0 : 600);
      } else {
        setError(t('accessCode.error'));
        setCode('');
        inputRef.current?.focus();
      }
    } catch {
      setError(t('accessCode.error'));
      setCode('');
      inputRef.current?.focus();
    } finally {
      setLoading(false);
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          data-testid="access-code-overlay"
          className="fixed inset-0 z-[200] flex items-center justify-center overflow-hidden bg-background/96 px-4 backdrop-blur-md"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: reduceMotion ? 0 : 0.2 } }}
          transition={{ duration: reduceMotion ? 0 : 0.2 }}
        >
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="access-code-title"
            aria-describedby="access-code-description"
            data-testid="access-code-dialog"
            data-state={visualState}
            tabIndex={-1}
            onKeyDown={keepFocusInDialog}
            className="relative z-10 w-full max-w-sm"
            initial={{ opacity: 0, y: reduceMotion ? 0 : 12, scale: reduceMotion ? 1 : 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: reduceMotion ? 0 : -8, scale: reduceMotion ? 1 : 0.98 }}
            transition={{ duration: reduceMotion ? 0 : 0.24, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="rounded-[22px] border border-border bg-card p-7 shadow-[0_18px_54px_rgba(20,32,25,0.10)] dark:shadow-black/30 sm:p-8">
              <ZhiyuLockup size="sm" className="mb-8 justify-center" />

              <div className="mx-auto mb-5 flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <ShieldCheck className="size-6" strokeWidth={1.7} aria-hidden="true" />
              </div>

              {/* Title */}
              <motion.h1
                id="access-code-title"
                className="mb-1 text-center text-lg font-semibold tracking-tight text-foreground"
                initial={{ opacity: 0, y: reduceMotion ? 0 : 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: reduceMotion ? 0 : 0.12, duration: reduceMotion ? 0 : 0.2 }}
              >
                {t('accessCode.title')}
              </motion.h1>

              <motion.p
                id="access-code-description"
                className="mb-6 text-center text-sm text-muted-foreground"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: reduceMotion ? 0 : 0.14, duration: reduceMotion ? 0 : 0.2 }}
              >
                {t('home.footer')}
              </motion.p>

              {/* Form */}
              <motion.form
                onSubmit={handleSubmit}
                className="space-y-4"
                initial={{ opacity: 0, y: reduceMotion ? 0 : 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: reduceMotion ? 0 : 0.16, duration: reduceMotion ? 0 : 0.2 }}
              >
                <div className="relative">
                  <input
                    ref={inputRef}
                    data-testid="access-code-input"
                    type="password"
                    placeholder={t('accessCode.placeholder')}
                    aria-label={t('accessCode.placeholder')}
                    value={code}
                    onChange={(e) => {
                      setCode(e.target.value);
                      if (error) setError('');
                    }}
                    className={`
                      w-full rounded-xl border bg-background px-4 py-3 pr-12 text-sm
                      outline-none transition-all duration-200
                      placeholder:text-muted-foreground/50
                      focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/20
                      ${error ? 'border-destructive/50 focus:border-destructive/50 focus:ring-destructive/10' : 'border-border/60'}
                    `}
                    readOnly={loading || success}
                    autoComplete="off"
                  />
                  <button
                    type="submit"
                    data-testid="access-code-submit"
                    aria-label={loading ? t('accessCode.validating') : t('common.confirm')}
                    disabled={!code || loading || success}
                    className={`
                      absolute right-2 top-1/2 -translate-y-1/2 flex h-8 w-8 items-center
                      justify-center rounded-lg transition-all duration-200
                      focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary
                      ${code && !loading && !success ? 'cursor-pointer bg-primary text-primary-foreground hover:bg-primary/90' : 'cursor-default text-muted-foreground/40'}
                    `}
                  >
                    {loading ? (
                      <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                    ) : success ? (
                      <motion.div
                        initial={{ scale: reduceMotion ? 1 : 0 }}
                        animate={{ scale: 1 }}
                        transition={
                          reduceMotion
                            ? { duration: 0 }
                            : { type: 'spring', stiffness: 300, damping: 20 }
                        }
                      >
                        <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
                      </motion.div>
                    ) : (
                      <ArrowRight className="size-4" aria-hidden="true" />
                    )}
                  </button>
                </div>

                {/* Error message */}
                <AnimatePresence mode="wait">
                  {error && (
                    <motion.p
                      id="access-code-error"
                      role="alert"
                      data-testid="access-code-error"
                      className="text-center text-sm text-destructive"
                      initial={{ opacity: 0, y: -4, height: 0 }}
                      animate={{ opacity: 1, y: 0, height: 'auto' }}
                      exit={{ opacity: 0, y: -4, height: 0 }}
                      transition={{ duration: reduceMotion ? 0 : 0.2 }}
                    >
                      {error}
                    </motion.p>
                  )}
                </AnimatePresence>
                <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
                  {loading ? t('accessCode.validating') : success ? t('accessCode.success') : ''}
                </p>
              </motion.form>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
