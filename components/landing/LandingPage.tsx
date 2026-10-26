'use client';

/**
 * The public introduction at `/welcome`: what ZHIYU does, how a lesson
 * starts, what the study tools add, and the way in (sign up / log in).
 * Signed-out visitors to `/` land here; signed-in ones go straight to the app.
 */
import Link from 'next/link';
import {
  ArrowRight,
  Bookmark,
  Check,
  FolderOpen,
  Languages,
  ListChecks,
  NotebookPen,
  Presentation,
  Users,
  Zap,
} from 'lucide-react';

import { ZhiyuLockup } from '@/components/brand/ZhiyuLockup';
import { LandingClassroomPreview } from '@/components/landing/LandingClassroomPreview';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { LANDING_PATH } from '@/lib/auth/public-paths';
import { supportedLocales, type Locale } from '@/lib/i18n';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';

const SIGN_UP_HREF = '/auth/sign-up';
const LOGIN_HREF = '/auth/login';

type Tone = 'primary' | 'ai' | 'peer' | 'review' | 'mistake' | 'correct';

const TONE_ICON: Record<Tone, string> = {
  primary: 'bg-primary-soft text-primary-ink',
  ai: 'bg-ai-soft text-ai-ink',
  peer: 'bg-peer-soft text-peer-ink',
  review: 'bg-review-soft text-review-ink',
  mistake: 'bg-mistake-soft text-mistake-ink',
  correct: 'bg-correct-soft text-correct-ink',
};

/** Feature cards, in reading order; `wide` cards span two columns on desktop. */
const FEATURES: { key: string; icon: typeof Zap; tone: Tone; wide?: boolean }[] = [
  { key: 'classroom', icon: Presentation, tone: 'ai', wide: true },
  { key: 'spaces', icon: FolderOpen, tone: 'primary' },
  { key: 'bank', icon: ListChecks, tone: 'review' },
  { key: 'wrongbook', icon: NotebookPen, tone: 'mistake' },
  { key: 'classmates', icon: Users, tone: 'peer' },
  { key: 'memory', icon: Bookmark, tone: 'correct' },
  { key: 'ultra', icon: Zap, tone: 'primary', wide: true },
];

export function LandingPage() {
  const { t } = useI18n();

  return (
    <div className="min-h-[100dvh] overflow-x-hidden bg-background text-foreground">
      <LandingHeader />

      <main>
        {/* ═══ Hero ═══ */}
        <section className="mx-auto grid w-full max-w-6xl items-center gap-12 px-4 pb-16 pt-10 sm:px-6 md:pt-16 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-12 lg:pb-24 lg:pt-20">
          <div className="animate-in fade-in slide-in-from-bottom-3 duration-500 motion-reduce:animate-none">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-primary-soft px-3 py-1 text-xs font-semibold text-primary-ink">
              <span className="size-1.5 rounded-full bg-primary" />
              {t('landing.eyebrow')}
            </span>
            <h1 className="mt-5 whitespace-pre-line text-balance font-display text-[34px] font-bold leading-[1.2] tracking-tight sm:text-5xl lg:text-[52px]">
              {t('landing.heroTitle')}
            </h1>
            <p className="mt-5 max-w-xl text-pretty text-base leading-7 text-muted-foreground md:text-lg md:leading-8">
              {t('landing.heroSubtitle')}
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button asChild size="lg" className="h-11 px-5 text-[15px]">
                <Link href={SIGN_UP_HREF}>
                  {t('landing.ctaPrimary')}
                  <ArrowRight className="size-4" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="h-11 px-5 text-[15px]">
                <Link href={LOGIN_HREF}>{t('landing.ctaSecondary')}</Link>
              </Button>
            </div>
            <p className="mt-5 text-[13px] text-muted-foreground">{t('landing.heroNote')}</p>
          </div>

          <div className="animate-in fade-in slide-in-from-bottom-4 delay-150 duration-700 fill-mode-backwards motion-reduce:animate-none">
            <LandingClassroomPreview />
          </div>
        </section>

        {/* ═══ How a lesson starts ═══ */}
        <section id="how" className="scroll-mt-20 border-y border-border bg-card/60">
          <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 lg:py-20">
            <SectionHeading eyebrow={t('landing.howEyebrow')} title={t('home.stepsTitle')} />
            <ol className="mt-10 grid gap-4 md:grid-cols-3">
              {[1, 2, 3].map((step) => (
                <li key={step} className="rounded-xl bg-background p-5 shadow-flat">
                  <span className="flex size-8 items-center justify-center rounded-full bg-primary font-display text-sm font-bold text-primary-foreground">
                    {step}
                  </span>
                  <h3 className="mt-4 text-[17px] font-semibold">{t(`home.step${step}Title`)}</h3>
                  <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
                    {t(`landing.step${step}Detail`)}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ═══ What keeps the learning going ═══ */}
        <section
          id="features"
          className="mx-auto w-full max-w-6xl scroll-mt-20 px-4 py-16 sm:px-6 lg:py-24"
        >
          <SectionHeading
            eyebrow={t('landing.featuresEyebrow')}
            title={t('landing.featuresTitle')}
            subtitle={t('landing.featuresSubtitle')}
          />
          <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ key, icon: Icon, tone, wide }) => (
              <li
                key={key}
                className={cn(
                  'flex flex-col rounded-xl bg-card p-5 shadow-flat',
                  wide && 'sm:col-span-2 lg:col-span-2',
                )}
              >
                <span
                  className={cn(
                    'flex size-10 items-center justify-center rounded-lg',
                    TONE_ICON[tone],
                  )}
                >
                  <Icon className="size-5" />
                </span>
                <h3 className="mt-4 text-[17px] font-semibold">
                  {t(`landing.feature.${key}.title`)}
                </h3>
                <p className="mt-1.5 max-w-prose text-sm leading-6 text-muted-foreground">
                  {t(`landing.feature.${key}.desc`)}
                </p>
              </li>
            ))}
          </ul>
        </section>

        {/* ═══ Closing call to action ═══ */}
        <section className="mx-auto w-full max-w-6xl px-4 pb-20 sm:px-6">
          <div className="flex flex-col items-start gap-6 rounded-3xl bg-primary-soft px-6 py-10 sm:px-10 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="font-display text-2xl font-bold text-primary-ink md:text-3xl">
                {t('landing.closingTitle')}
              </h2>
              <ul className="mt-3 flex flex-col gap-1.5 text-sm text-primary-ink/80 sm:flex-row sm:gap-5">
                {[1, 2, 3].map((n) => (
                  <li key={n} className="flex items-center gap-1.5">
                    <Check className="size-4 shrink-0" />
                    {t(`landing.closingPoint${n}`)}
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button asChild size="lg" className="h-11 px-5 text-[15px]">
                <Link href={SIGN_UP_HREF}>
                  {t('landing.ctaPrimary')}
                  <ArrowRight className="size-4" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="ghost" className="h-11 px-4 text-[15px]">
                <Link href={LOGIN_HREF}>{t('landing.signIn')}</Link>
              </Button>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <ZhiyuLockup size="sm" />
          <p>{t('home.footer')}</p>
        </div>
      </footer>
    </div>
  );
}

function LandingHeader() {
  const { t, locale, setLocale } = useI18n();

  return (
    <header className="sticky top-0 z-30 border-b border-border/70 bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-2 px-4 sm:px-6">
        <Link href={LANDING_PATH} aria-label={t('auth.productName')} className="mr-auto">
          <ZhiyuLockup size="sm" />
        </Link>
        <nav className="hidden items-center gap-1 md:flex">
          <a
            href="#how"
            className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            {t('landing.howEyebrow')}
          </a>
          <a
            href="#features"
            className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            {t('landing.featuresEyebrow')}
          </a>
        </nav>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={t('settings.language')}>
              <Languages className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
            {supportedLocales.map((l) => (
              <DropdownMenuItem key={l.code} onSelect={() => setLocale(l.code as Locale)}>
                <Check className={cn('size-4', l.code === locale ? 'opacity-100' : 'opacity-0')} />
                {l.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button asChild variant="ghost" className="hidden sm:inline-flex">
          <Link href={LOGIN_HREF}>{t('landing.signIn')}</Link>
        </Button>
        <Button asChild>
          <Link href={SIGN_UP_HREF}>{t('landing.signUp')}</Link>
        </Button>
      </div>
    </header>
  );
}

function SectionHeading({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="max-w-2xl">
      <p className="text-sm font-semibold text-primary">{eyebrow}</p>
      <h2 className="mt-2 text-balance font-display text-3xl font-bold tracking-tight md:text-4xl">
        {title}
      </h2>
      {subtitle ? (
        <p className="mt-3 text-pretty text-base leading-7 text-muted-foreground">{subtitle}</p>
      ) : null}
    </div>
  );
}
