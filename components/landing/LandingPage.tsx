'use client';

/**
 * The public introduction at `/welcome`: what ZHIYU does, what it can teach,
 * how a lesson starts, what happens in class, what the study tools add, the
 * common questions, and the way in (sign up / log in). Signed-out visitors to
 * `/` land here; signed-in ones go straight to the app.
 *
 * Motion follows the viewer's reduced-motion setting (MotionConfig "user").
 */
import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { MotionConfig, motion, useMotionValueEvent, useScroll } from 'motion/react';
import {
  ArrowRight,
  Bookmark,
  Check,
  ChevronDown,
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
import { LandingClassroomTour } from '@/components/landing/LandingClassroomTour';
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

const TONE_DOT: Record<Tone, string> = {
  primary: 'bg-primary',
  ai: 'bg-ai',
  peer: 'bg-peer',
  review: 'bg-review',
  mistake: 'bg-mistake',
  correct: 'bg-correct',
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

const TOPIC_TONES: Tone[] = ['primary', 'ai', 'review', 'peer', 'correct', 'mistake'];
const TOPIC_COUNT = 14;
const FAQ_COUNT = 5;

const NAV = [
  { href: '#how', label: 'landing.howEyebrow' },
  { href: '#tour', label: 'landing.tourEyebrow' },
  { href: '#features', label: 'landing.featuresEyebrow' },
  { href: '#faq', label: 'landing.faqEyebrow' },
];

export function LandingPage() {
  const { t } = useI18n();

  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-[100dvh] overflow-x-hidden bg-background text-foreground">
        <LandingHeader />

        <main>
          {/* ═══ Hero ═══ */}
          <section className="mx-auto grid w-full max-w-6xl items-center gap-12 px-4 pb-14 pt-10 sm:px-6 md:pt-16 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-12 lg:pb-20 lg:pt-20">
            <motion.div
              initial="hidden"
              animate="shown"
              variants={{ shown: { transition: { staggerChildren: 0.08 } } }}
            >
              <motion.span
                variants={RISE}
                className="inline-flex items-center gap-1.5 rounded-full bg-primary-soft px-3 py-1 text-xs font-semibold text-primary-ink"
              >
                <span className="relative flex size-1.5">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60 motion-reduce:hidden" />
                  <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
                </span>
                {t('landing.eyebrow')}
              </motion.span>
              <motion.h1
                variants={RISE}
                className="mt-5 whitespace-pre-line text-balance font-display text-[34px] font-bold leading-[1.2] tracking-tight sm:text-5xl lg:text-[52px]"
              >
                {t('landing.heroTitle')}
              </motion.h1>
              <motion.p
                variants={RISE}
                className="mt-5 max-w-xl text-pretty text-base leading-7 text-muted-foreground md:text-lg md:leading-8"
              >
                {t('landing.heroSubtitle')}
              </motion.p>
              <motion.div variants={RISE} className="mt-8 flex flex-wrap items-center gap-3">
                <Button asChild size="lg" className="group h-11 px-5 text-[15px]">
                  <Link href={SIGN_UP_HREF}>
                    {t('landing.ctaPrimary')}
                    <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                  </Link>
                </Button>
                <Button asChild size="lg" variant="outline" className="h-11 px-5 text-[15px]">
                  <Link href={LOGIN_HREF}>{t('landing.ctaSecondary')}</Link>
                </Button>
              </motion.div>
              <motion.p variants={RISE} className="mt-5 text-[13px] text-muted-foreground">
                {t('landing.heroNote')}
              </motion.p>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.2, ease: [0.22, 1, 0.36, 1] }}
              className="relative isolate"
            >
              <div
                aria-hidden
                className="pointer-events-none absolute -inset-x-6 -inset-y-10 -z-10 rounded-[48px] bg-primary-soft/70 blur-3xl"
              />
              <LandingClassroomPreview />
            </motion.div>
          </section>

          {/* ═══ What it can teach ═══ */}
          <section aria-label={t('landing.topicsLabel')} className="pb-16 lg:pb-20">
            <Reveal className="mx-auto mb-5 w-full max-w-6xl px-4 text-center text-sm font-medium text-muted-foreground sm:px-6">
              {t('landing.topicsLabel')}
            </Reveal>
            <div className="space-y-3 [mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)]">
              <TopicRow offset={0} direction="left" />
              <TopicRow offset={7} direction="right" />
            </div>
          </section>

          {/* ═══ How a lesson starts ═══ */}
          <section id="how" className="scroll-mt-20 border-y border-border bg-card/60">
            <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 lg:py-20">
              <Reveal>
                <SectionHeading eyebrow={t('landing.howEyebrow')} title={t('home.stepsTitle')} />
              </Reveal>
              <ol className="relative mt-10 grid gap-4 md:grid-cols-3">
                {/* The path joining the three steps, drawn as the row comes into view */}
                <motion.span
                  aria-hidden
                  initial={{ scaleX: 0 }}
                  whileInView={{ scaleX: 1 }}
                  viewport={{ once: true, amount: 0.6 }}
                  transition={{ duration: 1.1, ease: 'easeInOut', delay: 0.3 }}
                  className="absolute left-[16%] right-[16%] top-9 hidden h-px origin-left border-t border-dashed border-primary/40 md:block"
                />
                {[1, 2, 3].map((step) => (
                  <Reveal
                    key={step}
                    as="li"
                    delay={step * 0.12}
                    className="relative rounded-xl bg-background p-5 shadow-flat"
                  >
                    <span className="flex size-8 items-center justify-center rounded-full bg-primary font-display text-sm font-bold text-primary-foreground ring-4 ring-background">
                      {step}
                    </span>
                    <h3 className="mt-4 text-[17px] font-semibold">{t(`home.step${step}Title`)}</h3>
                    <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
                      {t(`landing.step${step}Detail`)}
                    </p>
                  </Reveal>
                ))}
              </ol>
            </div>
          </section>

          {/* ═══ What happens in class ═══ */}
          <section
            id="tour"
            className="mx-auto w-full max-w-6xl scroll-mt-20 px-4 py-16 sm:px-6 lg:py-24"
          >
            <Reveal>
              <SectionHeading
                eyebrow={t('landing.tourEyebrow')}
                title={t('landing.tourTitle')}
                subtitle={t('landing.tourSubtitle')}
              />
            </Reveal>
            <Reveal delay={0.1} className="mt-10">
              <LandingClassroomTour />
            </Reveal>
          </section>

          {/* ═══ What keeps the learning going ═══ */}
          <section id="features" className="scroll-mt-20 border-y border-border bg-card/60">
            <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 lg:py-24">
              <Reveal>
                <SectionHeading
                  eyebrow={t('landing.featuresEyebrow')}
                  title={t('landing.featuresTitle')}
                  subtitle={t('landing.featuresSubtitle')}
                />
              </Reveal>
              <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {FEATURES.map(({ key, icon: Icon, tone, wide }, index) => (
                  <Reveal
                    key={key}
                    as="li"
                    delay={(index % 3) * 0.08}
                    className={cn(
                      'group flex flex-col rounded-xl bg-background p-5 shadow-flat transition-shadow duration-200 hover:shadow-float',
                      wide && 'sm:col-span-2 lg:col-span-2',
                    )}
                  >
                    <span
                      className={cn(
                        'flex size-10 items-center justify-center rounded-lg transition-transform duration-200 group-hover:-rotate-6 group-hover:scale-110 motion-reduce:transition-none',
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
                  </Reveal>
                ))}
              </ul>
            </div>
          </section>

          {/* ═══ Common questions ═══ */}
          <section
            id="faq"
            className="mx-auto grid w-full max-w-6xl scroll-mt-20 gap-8 px-4 py-16 sm:px-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-14 lg:py-24"
          >
            <Reveal>
              <SectionHeading eyebrow={t('landing.faqEyebrow')} title={t('landing.faqTitle')} />
            </Reveal>
            <div className="divide-y divide-border rounded-xl bg-card shadow-flat">
              {Array.from({ length: FAQ_COUNT }, (_, i) => i + 1).map((n) => (
                <Reveal key={n} delay={n * 0.05}>
                  <details className="group px-5 [&_summary::-webkit-details-marker]:hidden">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 text-[15px] font-semibold">
                      {t(`landing.faq${n}q`)}
                      <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180" />
                    </summary>
                    <p className="pb-4 text-sm leading-6 text-muted-foreground">
                      {t(`landing.faq${n}a`)}
                    </p>
                  </details>
                </Reveal>
              ))}
            </div>
          </section>

          {/* ═══ Closing call to action ═══ */}
          <section className="mx-auto w-full max-w-6xl px-4 pb-20 sm:px-6">
            <Reveal className="flex flex-col items-start gap-6 rounded-3xl bg-primary-soft px-6 py-10 sm:px-10 md:flex-row md:items-center md:justify-between">
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
                <Button asChild size="lg" className="group h-11 px-5 text-[15px]">
                  <Link href={SIGN_UP_HREF}>
                    {t('landing.ctaPrimary')}
                    <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                  </Link>
                </Button>
                <Button asChild size="lg" variant="ghost" className="h-11 px-4 text-[15px]">
                  <Link href={LOGIN_HREF}>{t('landing.signIn')}</Link>
                </Button>
              </div>
            </Reveal>
          </section>
        </main>

        <footer className="border-t border-border">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <ZhiyuLockup size="sm" />
            <p>{t('home.footer')}</p>
          </div>
        </footer>
      </div>
    </MotionConfig>
  );
}

const RISE = {
  hidden: { opacity: 0, y: 16 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] } },
} as const;

/** Fades and lifts its content in the first time it scrolls into view. */
function Reveal({
  children,
  className,
  delay = 0,
  as = 'div',
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  as?: 'div' | 'li';
}) {
  const Tag = as === 'li' ? motion.li : motion.div;
  return (
    <Tag
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.25 }}
      transition={{ duration: 0.5, delay, ease: [0.22, 1, 0.36, 1] }}
      className={className}
    >
      {children}
    </Tag>
  );
}

/**
 * One endlessly scrolling row of every example topic, starting at `offset`
 * so the two rows never line up (doubled for a seamless loop).
 */
function TopicRow({ offset, direction }: { offset: number; direction: 'left' | 'right' }) {
  const { t } = useI18n();
  const topics = Array.from({ length: TOPIC_COUNT }, (_, i) => ((i + offset) % TOPIC_COUNT) + 1);
  return (
    <div className="flex overflow-hidden">
      <motion.ul
        animate={{ x: direction === 'left' ? ['0%', '-50%'] : ['-50%', '0%'] }}
        transition={{ duration: 70, ease: 'linear', repeat: Infinity }}
        className="flex shrink-0 gap-3 pr-3"
      >
        {[...topics, ...topics].map((n, i) => (
          <li
            key={i}
            aria-hidden={i >= topics.length}
            className="flex shrink-0 items-center gap-2 rounded-full bg-card px-4 py-2 text-sm text-foreground shadow-flat"
          >
            <span
              className={cn('size-1.5 rounded-full', TONE_DOT[TOPIC_TONES[n % TOPIC_TONES.length]])}
            />
            {t(`landing.topic${n}`)}
          </li>
        ))}
      </motion.ul>
    </div>
  );
}

function LandingHeader() {
  const { t, locale, setLocale } = useI18n();
  const { scrollY } = useScroll();
  const [scrolled, setScrolled] = useState(false);
  useMotionValueEvent(scrollY, 'change', (y) => setScrolled(y > 8));

  return (
    <header
      className={cn(
        'sticky top-0 z-30 border-b bg-background/85 backdrop-blur-md transition-[border-color,box-shadow] duration-200',
        scrolled
          ? 'border-border/70 shadow-[0_6px_20px_-14px_var(--float-shadow)]'
          : 'border-transparent',
      )}
    >
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-2 px-4 sm:px-6">
        <Link href={LANDING_PATH} aria-label={t('auth.productName')} className="mr-auto">
          <ZhiyuLockup size="sm" />
        </Link>
        <nav className="hidden items-center gap-1 lg:flex">
          {NAV.map(({ href, label }) => (
            <a
              key={href}
              href={href}
              className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              {t(label)}
            </a>
          ))}
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
