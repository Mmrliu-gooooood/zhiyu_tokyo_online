'use client';

import { useEffect, useState } from 'react';
import { CircleUserRound } from 'lucide-react';
import { useRouter } from 'next/navigation';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { signOutAndReload } from '@/lib/auth/client-barrier';
import { peekAccountSnapshot, peekAccountUserId } from '@/lib/auth/account-environment';
import { canUseHostedAuthUi } from '@/lib/auth/mode';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';

export function AccountMenu({ triggerClassName }: { triggerClassName?: string } = {}) {
  const { t } = useI18n();
  const router = useRouter();
  const [, setAccountEpoch] = useState(0);
  useEffect(() => {
    const refresh = () => setAccountEpoch((value) => value + 1);
    window.addEventListener('auth-change', refresh);
    return () => window.removeEventListener('auth-change', refresh);
  }, []);
  if (!canUseHostedAuthUi() || !peekAccountUserId()) return null;
  const account = peekAccountSnapshot();
  const identity = account?.displayName?.trim() || account?.email;

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            'p-2 rounded-full text-gray-400 dark:text-gray-500 hover:bg-white dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200 hover:shadow-sm transition-all',
            triggerClassName,
          )}
          aria-label={t('auth.accountMenu')}
        >
          <CircleUserRound className="w-4 h-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="min-w-[160px]">
        {identity ? (
          <DropdownMenuLabel className="font-normal text-muted-foreground">{identity}</DropdownMenuLabel>
        ) : null}
        <DropdownMenuItem className="cursor-pointer" onSelect={() => router.push('/account')}>
          {t('auth.accountTitle')}
        </DropdownMenuItem>
        <DropdownMenuItem className="cursor-pointer" onSelect={() => void signOutAndReload()}>
          {t('auth.signOut')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
