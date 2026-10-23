'use client';

/**
 * The learner's identity in the app shell: avatar and nickname (from the
 * profile the AI teacher sees) with one menu for everything personal —
 * profile, settings, theme, language and the hosted account.
 */
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Check,
  ChevronsUpDown,
  Languages,
  LogOut,
  Monitor,
  Moon,
  Settings,
  ShieldCheck,
  Sun,
  UserPen,
} from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SettingsDialog } from '@/components/settings';
import { ProfileDialog } from '@/components/user-profile';
import { signOutAndReload } from '@/lib/auth/client-barrier';
import { peekAccountSnapshot, peekAccountUserId } from '@/lib/auth/account-environment';
import { canUseHostedAuthUi } from '@/lib/auth/mode';
import { supportedLocales, type Locale } from '@/lib/i18n';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useTheme } from '@/lib/hooks/use-theme';
import { useUserProfileStore } from '@/lib/store/user-profile';
import { cn } from '@/lib/utils';

/**
 * What the app calls the learner — the profile nickname, else the hosted
 * account's display name, else the default — shared by the account card and
 * Home's greeting so the two never disagree.
 */
export function useLearnerIdentity(): { name: string; email?: string; signedIn: boolean } {
  const { t } = useI18n();
  const nickname = useUserProfileStore((s) => s.nickname);
  const [, setAccountEpoch] = useState(0);
  useEffect(() => {
    const refresh = () => setAccountEpoch((value) => value + 1);
    window.addEventListener('auth-change', refresh);
    return () => window.removeEventListener('auth-change', refresh);
  }, []);
  const signedIn = canUseHostedAuthUi() && Boolean(peekAccountUserId());
  const account = signedIn ? peekAccountSnapshot() : undefined;
  return {
    name: nickname.trim() || account?.displayName?.trim() || t('profile.defaultNickname'),
    email: account?.email,
    signedIn,
  };
}

export function ShellAccount({ variant }: { variant: 'card' | 'avatar' }) {
  const { t, locale, setLocale } = useI18n();
  const { theme, setTheme } = useTheme();
  const router = useRouter();
  const avatar = useUserProfileStore((s) => s.avatar);
  const [profileOpen, setProfileOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsReturnFocusRef = useRef<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { name, email, signedIn } = useLearnerIdentity();
  const secondary = email ?? t('shell.accountHint');

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          {variant === 'card' ? (
            <button
              ref={triggerRef}
              type="button"
              data-testid="shell-account"
              className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left shadow-flat transition-colors hover:bg-muted"
            >
              <img
                src={avatar}
                alt=""
                className="size-8 shrink-0 rounded-full bg-muted object-cover"
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13px] font-semibold text-foreground">{name}</span>
                <span className="truncate text-xs text-muted-foreground">{secondary}</span>
              </span>
              <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            </button>
          ) : (
            <button
              ref={triggerRef}
              type="button"
              data-testid="shell-account"
              aria-label={t('auth.accountMenu')}
              className="rounded-full ring-1 ring-border transition-shadow hover:ring-border-strong"
            >
              <img src={avatar} alt="" className="size-8 rounded-full bg-muted object-cover" />
            </button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side={variant === 'card' ? 'top' : 'bottom'}
          align={variant === 'card' ? 'start' : 'end'}
          sideOffset={8}
          className="w-64"
        >
          <DropdownMenuLabel className="flex items-center gap-2.5 py-2 font-normal">
            <img src={avatar} alt="" className="size-9 rounded-full bg-muted object-cover" />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-semibold text-foreground">{name}</span>
              {email ? (
                <span className="truncate text-xs text-muted-foreground">{email}</span>
              ) : null}
            </span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setProfileOpen(true)}>
            <UserPen className="size-4" />
            {t('shell.editProfile')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              settingsReturnFocusRef.current = triggerRef.current;
              setSettingsOpen(true);
            }}
          >
            <Settings className="size-4" />
            {t('settings.title')}
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              {theme === 'dark' ? (
                <Moon className="size-4" />
              ) : theme === 'light' ? (
                <Sun className="size-4" />
              ) : (
                <Monitor className="size-4" />
              )}
              {t('settings.theme')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup
                value={theme}
                onValueChange={(value) => setTheme(value as typeof theme)}
              >
                <DropdownMenuRadioItem value="light">
                  {t('settings.themeOptions.light')}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="dark">
                  {t('settings.themeOptions.dark')}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="system">
                  {t('settings.themeOptions.system')}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Languages className="size-4" />
              {t('settings.language')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-80 overflow-y-auto">
              {supportedLocales.map((l) => (
                <DropdownMenuItem key={l.code} onSelect={() => setLocale(l.code as Locale)}>
                  <Check
                    className={cn('size-4', l.code === locale ? 'opacity-100' : 'opacity-0')}
                  />
                  {l.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {signedIn ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => router.push('/account')}>
                <ShieldCheck className="size-4" />
                {t('auth.accountTitle')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void signOutAndReload()}>
                <LogOut className="size-4" />
                {t('auth.signOut')}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <ProfileDialog open={profileOpen} onOpenChange={setProfileOpen} />
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        returnFocusTargetRef={settingsReturnFocusRef}
      />
    </>
  );
}
