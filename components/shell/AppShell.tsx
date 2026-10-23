'use client';

/**
 * The app frame shared by Home and the study pages: a persistent sidebar on
 * desktop (home, new course, Ultra, the learner's subject spaces, the study
 * sections, the account), a top bar plus bottom tabs on phones. Classroom,
 * generation and the Ultra workbench keep their own full-screen chrome.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Bookmark,
  ChevronDown,
  FileText,
  FolderOpen,
  Home,
  Layers,
  Plus,
  Sparkles,
  Users,
} from 'lucide-react';

import { ZhiyuLockup } from '@/components/brand/ZhiyuLockup';
import { ShellAccount } from '@/components/shell/ShellAccount';
import { useStudyNav, useUltraEntry, type StudyNav } from '@/components/shell/use-shell-nav';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';

const ShellNavContext = createContext<StudyNav | null>(null);

/** The shell's study nav (spaces, capabilities) for pages rendered inside it. */
export function useShellStudyNav(): StudyNav {
  const nav = useContext(ShellNavContext);
  if (!nav) throw new Error('useShellStudyNav must be used inside AppShell');
  return nav;
}

/** Spaces listed before the sidebar's "show all" toggle. */
const SPACES_COLLAPSED_COUNT = 5;
const SPACES_EXPANDED_KEY = 'shell.spacesExpanded';

type NavItem = {
  href: string;
  label: string;
  icon: typeof Home;
  current: boolean;
  testId?: string;
};

type Ultra = ReturnType<typeof useUltraEntry>;

function useNavItems(nav: StudyNav) {
  const { t } = useI18n();
  const pathname = usePathname() ?? '';
  const caps = nav.capabilities;
  const under = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const sections: NavItem[] = [];
  if (nav.available && caps?.materials) {
    sections.push({
      href: '/study/materials',
      label: t('study.materials.nav'),
      icon: FileText,
      current: under('/study/materials'),
      testId: 'study-nav-materials',
    });
  }
  if (nav.available && caps?.classmates) {
    sections.push({
      href: '/study/classmates',
      label: t('study.classmates.nav'),
      icon: Users,
      current: under('/study/classmates'),
      testId: 'study-nav-classmates',
    });
  }
  if (nav.available && caps?.memory) {
    sections.push({
      href: '/study/memory',
      label: t('study.memory.nav'),
      icon: Bookmark,
      current: under('/study/memory'),
      testId: 'study-nav-memory',
    });
  }
  return { pathname, sections, under };
}

const itemClass = (current: boolean) =>
  cn(
    'flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors',
    current
      ? 'bg-primary-soft font-semibold text-primary-ink'
      : 'font-medium text-muted-foreground hover:bg-muted hover:text-foreground',
  );

function UltraBadge() {
  return (
    <span
      data-pro-morph="badge"
      className="rounded-full border border-primary/40 bg-primary-soft px-1.5 py-px text-[9.5px] font-bold uppercase tracking-[0.16em] text-primary-ink"
    >
      Ultra
    </span>
  );
}

function AppSidebar({ nav, ultra }: { nav: StudyNav; ultra: Ultra }) {
  const { t } = useI18n();
  const { pathname, sections, under } = useNavItems(nav);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    try {
      setExpanded(localStorage.getItem(SPACES_EXPANDED_KEY) === '1'); // eslint-disable-line react-hooks/set-state-in-effect -- read a per-viewer preference after mount
    } catch {
      // Storage unavailable: start collapsed.
    }
  }, []);
  const toggleExpanded = () => {
    setExpanded((value) => {
      try {
        localStorage.setItem(SPACES_EXPANDED_KEY, value ? '0' : '1');
      } catch {
        // Not persisted; the toggle still works for this page.
      }
      return !value;
    });
  };
  const spaces = nav.spaces;
  // Keep the current space visible even when it sits below the fold.
  const visibleSpaces = expanded
    ? spaces
    : spaces.filter(
        (space, index) =>
          index < SPACES_COLLAPSED_COUNT || under(`/study/${encodeURIComponent(space.id)}`),
      );
  const hiddenCount = spaces.length - visibleSpaces.length;

  return (
    // The outer column paints the sidebar's surface the full page height; the
    // nav inside it sticks to the viewport.
    <div className="hidden w-[248px] shrink-0 border-r border-border bg-card lg:block">
      <nav
        aria-label={t('shell.navLabel')}
        className="sticky top-0 flex h-[100dvh] flex-col gap-1 overflow-y-auto px-3.5 py-4"
      >
        <Link
          href="/"
          aria-label={t('study.backHome')}
          className="mb-3 flex items-center rounded-md px-1.5 py-1"
          data-pro-morph="lockup"
        >
          <ZhiyuLockup size="sm" />
        </Link>

        <Link
          href="/"
          aria-current={pathname === '/' ? 'page' : undefined}
          className={itemClass(pathname === '/')}
        >
          <Home className="size-[18px]" aria-hidden />
          {t('shell.home')}
        </Link>
        <Link href="/#create" className={itemClass(false)} data-testid="shell-new-course">
          <Plus className="size-[18px]" aria-hidden />
          {t('shell.newCourse')}
        </Link>
        {ultra.enabled ? (
          <button
            type="button"
            onClick={ultra.enter}
            title={t('proMode.badgeEnter')}
            data-testid="pro-mode-enter"
            className={itemClass(false)}
          >
            <Sparkles className="size-[18px]" aria-hidden />
            <span className="flex-1 text-left">{t('shell.ultra')}</span>
            <UltraBadge />
          </button>
        ) : null}

        {nav.available ? (
          <>
            <div className="mx-1.5 my-2.5 h-px bg-border" />
            <div className="flex items-center justify-between px-2.5 pb-1 pt-0.5">
              <Link
                href="/study"
                aria-current={pathname === '/study' ? 'page' : undefined}
                className={cn(
                  'text-xs font-semibold tracking-wide transition-colors hover:text-foreground',
                  pathname === '/study' ? 'text-primary-ink' : 'text-subtle-foreground',
                )}
              >
                {t('shell.mySpaces')}
              </Link>
              <Link
                href="/study?create=1"
                aria-label={t('study.createSpace')}
                title={t('study.createSpace')}
                className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Plus className="size-3.5" aria-hidden />
              </Link>
            </div>
            {spaces.length === 0 ? (
              <Link
                href="/study"
                aria-current={pathname === '/study' ? 'page' : undefined}
                className={itemClass(pathname === '/study')}
              >
                <FolderOpen className="size-[18px]" aria-hidden />
                {t('study.nav')}
              </Link>
            ) : null}
            {visibleSpaces.map((space) => {
              const href = `/study/${encodeURIComponent(space.id)}`;
              const current = under(href);
              return (
                <Link
                  key={space.id}
                  href={href}
                  aria-current={current ? 'page' : undefined}
                  className={itemClass(current)}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'flex size-[22px] shrink-0 items-center justify-center rounded-[6px] font-display text-xs font-bold',
                      current
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-primary-soft text-primary-ink',
                    )}
                  >
                    {Array.from(space.name.trim())[0] ?? '·'}
                  </span>
                  <span className="truncate">{space.name}</span>
                </Link>
              );
            })}
            {spaces.length > SPACES_COLLAPSED_COUNT ? (
              <button
                type="button"
                onClick={toggleExpanded}
                aria-expanded={expanded}
                className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <ChevronDown
                  className={cn('size-3.5 transition-transform', expanded && 'rotate-180')}
                  aria-hidden
                />
                {expanded ? t('shell.showLess') : t('shell.showMore', { count: hiddenCount })}
              </button>
            ) : null}
          </>
        ) : null}

        <div className="mx-1.5 my-2.5 h-px bg-border" />
        {sections.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            data-testid={item.testId}
            aria-current={item.current ? 'page' : undefined}
            className={itemClass(item.current)}
          >
            <item.icon className="size-[18px]" aria-hidden />
            {item.label}
          </Link>
        ))}
        <Link href="/#library" className={itemClass(false)}>
          <Layers className="size-[18px]" aria-hidden />
          {t('shell.library')}
        </Link>

        <div className="flex-1" />
        <div className="pt-3">
          <ShellAccount variant="card" />
        </div>
      </nav>
    </div>
  );
}

function MobileTopBar({ ultra }: { ultra: Ultra }) {
  const { t } = useI18n();
  return (
    <header className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b border-border bg-card/90 px-4 backdrop-blur-md lg:hidden">
      <Link
        href="/"
        aria-label={t('study.backHome')}
        className="mr-auto rounded-md"
        data-pro-morph="lockup"
      >
        <ZhiyuLockup size="sm" />
      </Link>
      {ultra.enabled ? (
        <button
          type="button"
          onClick={ultra.enter}
          aria-label={t('shell.ultra')}
          title={t('proMode.badgeEnter')}
          data-testid="pro-mode-enter"
          className="flex h-8 items-center rounded-md px-1.5 transition-colors hover:bg-muted"
        >
          <UltraBadge />
        </button>
      ) : null}
      <ShellAccount variant="avatar" />
    </header>
  );
}

function MobileTabBar({ nav }: { nav: StudyNav }) {
  const { t } = useI18n();
  const { pathname, sections, under } = useNavItems(nav);
  if (!nav.available) return null;
  const spacesCurrent =
    under('/study') && !sections.some((item) => item.current) && pathname !== '/';
  const tabs: NavItem[] = [
    { href: '/', label: t('shell.tabHome'), icon: Home, current: pathname === '/' },
    { href: '/study', label: t('shell.tabSpaces'), icon: FolderOpen, current: spacesCurrent },
    ...sections.map((item) => ({ ...item, label: t(`shell.tab.${item.href.split('/').pop()}`) })),
  ];
  return (
    <nav
      aria-label={t('shell.navLabel')}
      className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-card/95 px-1 pb-[max(env(safe-area-inset-bottom),6px)] pt-1.5 backdrop-blur-md lg:hidden"
    >
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-current={tab.current ? 'page' : undefined}
          className={cn(
            'flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-md text-[11px]',
            tab.current ? 'font-semibold text-primary-ink' : 'font-medium text-muted-foreground',
          )}
        >
          <tab.icon className="size-5" aria-hidden />
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const nav = useStudyNav();
  const ultra = useUltraEntry();
  return (
    <ShellNavContext.Provider value={nav}>
      <div className="flex min-h-[100dvh] bg-background text-foreground">
        <AppSidebar nav={nav} ultra={ultra} />
        <div className="flex min-w-0 flex-1 flex-col">
          <MobileTopBar ultra={ultra} />
          <div className={cn('flex-1', nav.available && 'pb-20 lg:pb-0')}>{children}</div>
        </div>
        <MobileTabBar nav={nav} />
      </div>
    </ShellNavContext.Provider>
  );
}
