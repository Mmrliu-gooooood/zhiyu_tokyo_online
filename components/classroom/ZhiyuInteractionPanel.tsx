'use client';

import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { BookOpen, MessageCircle, PanelRightClose, UsersRound } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import {
  ZHIYU_INTERACTION_PANEL_WIDTH,
  type ZhiyuClassroomLiveStatus,
} from './zhiyu-classroom-layout';

export type ZhiyuInteractionTab = 'lecture' | 'discussion' | 'roles';
export type { ZhiyuClassroomLiveStatus } from './zhiyu-classroom-layout';

export type ZhiyuInteractionPanelProps = {
  readonly collapsed: boolean;
  readonly onCollapsedChange: (collapsed: boolean) => void;
  /** The one persistent ChatArea instance. It must never be duplicated. */
  readonly persistentContent: ReactNode;
  readonly rolesContent: ReactNode;
  readonly liveStatus: ZhiyuClassroomLiveStatus;
  readonly onTabChange?: (tab: ZhiyuInteractionTab) => void;
};

const TAB_ICONS = {
  lecture: BookOpen,
  discussion: MessageCircle,
  roles: UsersRound,
} as const;

export function ZhiyuInteractionPanel({
  collapsed,
  onCollapsedChange,
  persistentContent,
  rolesContent,
  liveStatus,
  onTabChange,
}: ZhiyuInteractionPanelProps) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<ZhiyuInteractionTab>('lecture');

  const selectTab = (tab: ZhiyuInteractionTab) => {
    setActiveTab(tab);
    onTabChange?.(tab);
  };

  const tabs: readonly ZhiyuInteractionTab[] = ['lecture', 'discussion', 'roles'];
  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const currentIndex = tabs.indexOf(activeTab);
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
    if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const tab = tabs[nextIndex];
    selectTab(tab);
    document.getElementById(`zhiyu-interaction-tab-${tab}`)?.focus();
  };

  return (
    <section
      data-testid="zhiyu-interaction-panel"
      data-collapsed={collapsed ? 'true' : 'false'}
      style={{
        width: collapsed
          ? 0
          : `var(--zhiyu-interaction-width, ${ZHIYU_INTERACTION_PANEL_WIDTH}px)`,
      }}
      className={cn(
        'flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-l border-border/70 bg-card/95 transition-[width] duration-300 dark:bg-card/95',
        collapsed && 'pointer-events-none border-l-0',
      )}
      aria-label={t('classroomWorkspace.interactionTitle')}
      aria-hidden={collapsed || undefined}
      inert={collapsed ? true : undefined}
    >
      <div className={cn('flex h-full min-h-0 w-full flex-col', collapsed && 'invisible')}>
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-border/60 px-4">
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold text-foreground">
                {t('classroomWorkspace.interactionTitle')}
              </h2>
              <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span
                  className={cn(
                    'size-1.5 rounded-full',
                    liveStatus === 'teaching' && 'bg-primary',
                    liveStatus === 'thinking' && 'bg-[var(--zhiyu-ai)]',
                    liveStatus === 'discussion' && 'bg-[var(--zhiyu-learning)]',
                    liveStatus === 'idle' && 'bg-muted-foreground/50',
                  )}
                  aria-hidden="true"
                />
                <span aria-live="polite">
                  {t(`classroomWorkspace.status.${liveStatus}`)}
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => onCollapsedChange(true)}
              className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              aria-label={t('classroomWorkspace.collapseInteraction')}
            >
              <PanelRightClose className="size-4" />
            </button>
          </div>

          <div
            role="tablist"
            aria-label={t('classroomWorkspace.interactionTabs')}
            className="grid h-11 shrink-0 grid-cols-3 border-b border-border/60 px-3"
          >
            {tabs.map((tab) => {
              const Icon = TAB_ICONS[tab];
              const selected = activeTab === tab;
              return (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={
                    tab === 'roles' ? 'zhiyu-interaction-roles' : 'zhiyu-interaction-learning'
                  }
                  id={`zhiyu-interaction-tab-${tab}`}
                  onClick={() => selectTab(tab)}
                  onKeyDown={handleTabKeyDown}
                  tabIndex={selected ? 0 : -1}
                  className={cn(
                    'relative inline-flex min-w-0 items-center justify-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary',
                    selected && 'text-primary',
                  )}
                >
                  <Icon className="size-3.5 shrink-0" />
                  <span className="truncate">{t(`classroomWorkspace.tabs.${tab}`)}</span>
                  {selected ? (
                    <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-primary" />
                  ) : null}
                </button>
              );
            })}
          </div>

          <div className="relative min-h-0 flex-1 overflow-hidden">
            <div
              id="zhiyu-interaction-learning"
              role="tabpanel"
              aria-labelledby={`zhiyu-interaction-tab-${activeTab}`}
              className={cn(
                'absolute inset-0 flex min-h-0',
                activeTab === 'roles' && 'invisible pointer-events-none',
              )}
            >
              {persistentContent}
            </div>
            <div
              id="zhiyu-interaction-roles"
              role="tabpanel"
              aria-labelledby="zhiyu-interaction-tab-roles"
              hidden={activeTab !== 'roles'}
              className="h-full overflow-y-auto p-4"
            >
              {rolesContent}
            </div>
          </div>
      </div>
    </section>
  );
}
