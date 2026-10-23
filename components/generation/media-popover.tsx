'use client';

import { useState, useCallback, useMemo, Fragment, useEffect, useRef } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Image as ImageIcon,
  Video,
  Volume2,
  Mic,
  SlidersHorizontal,
  ChevronRight,
} from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { resolveASRProviderName, resolveTTSProviderName } from '@/lib/audio/provider-display';
import { useSettingsStore } from '@/lib/store/settings';
import { IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import { VIDEO_PROVIDERS } from '@/lib/media/video-providers';
import {
  listImageProviders,
  listVideoProviders,
  isImageProviderAvailable,
  isVideoProviderAvailable,
} from '@/lib/media/provider-catalog';
import {
  CUSTOM_ASR_DEFAULT_LANGUAGES,
  TTS_PROVIDERS,
  resolveTTSModelForVoice,
} from '@/lib/audio/constants';
import { ASR_PROVIDERS, getASRSupportedLanguages } from '@/lib/audio/constants';
import type { ImageProviderId, VideoProviderId } from '@/lib/media/types';
import type { ASRProviderId } from '@/lib/audio/types';
import { isCustomASRProvider } from '@/lib/audio/types';
import type { SettingsSection } from '@/lib/types/settings';

interface MediaPopoverProps {
  onSettingsOpen: (section: SettingsSection, returnFocusTarget?: HTMLElement | null) => void;
}

// ─── Provider icon maps ───
const IMAGE_PROVIDER_ICONS: Record<string, string> = {
  seedream: '/logos/doubao.svg',
  'openai-image': '/logos/openai.svg',
  'qwen-image': '/logos/bailian.svg',
  'nano-banana': '/logos/gemini.svg',
  'grok-image': '/logos/grok.svg',
  'comfyui-image': '/logos/comfyui.svg',
};
const VIDEO_PROVIDER_ICONS: Record<string, string> = {
  seedance: '/logos/doubao.svg',
  kling: '/logos/kling.svg',
  veo: '/logos/gemini.svg',
  'grok-video': '/logos/grok.svg',
};

type TabId = 'image' | 'video' | 'tts' | 'asr';
const PLATFORM_IMAGE_GROUP_ID = '__zhiyu-platform-image__';
const PLATFORM_VIDEO_GROUP_ID = '__zhiyu-platform-video__';

const TABS: Array<{ id: TabId; icon: LucideIcon; label: string }> = [
  { id: 'image', icon: ImageIcon, label: 'Image' },
  { id: 'video', icon: Video, label: 'Video' },
  { id: 'tts', icon: Volume2, label: 'TTS' },
  { id: 'asr', icon: Mic, label: 'ASR' },
];

function providerModels<T extends { id: string; name: string }>(
  builtInModels: T[],
  config?: { customModels?: T[]; replaceBuiltInModels?: boolean },
): T[] {
  const customModels = config?.customModels || [];
  if (config?.replaceBuiltInModels && customModels.length > 0) {
    return customModels;
  }
  return [...builtInModels, ...customModels];
}

export function MediaPopover({ onSettingsOpen }: MediaPopoverProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>('image');

  // ─── Store ───
  const imageGenerationEnabled = useSettingsStore((s) => s.imageGenerationEnabled);
  const videoGenerationEnabled = useSettingsStore((s) => s.videoGenerationEnabled);
  const ttsEnabled = useSettingsStore((s) => s.ttsEnabled);
  const asrEnabled = useSettingsStore((s) => s.asrEnabled);
  const setImageGenerationEnabled = useSettingsStore((s) => s.setImageGenerationEnabled);
  const setVideoGenerationEnabled = useSettingsStore((s) => s.setVideoGenerationEnabled);
  const setTTSEnabled = useSettingsStore((s) => s.setTTSEnabled);
  const setASREnabled = useSettingsStore((s) => s.setASREnabled);

  const imageProviderId = useSettingsStore((s) => s.imageProviderId);
  const imageModelId = useSettingsStore((s) => s.imageModelId);
  const imageProvidersConfig = useSettingsStore((s) => s.imageProvidersConfig);
  const setImageProvider = useSettingsStore((s) => s.setImageProvider);
  const setImageModelId = useSettingsStore((s) => s.setImageModelId);
  const imageSelection = useSettingsStore((s) => s.imageSelection);

  const videoProviderId = useSettingsStore((s) => s.videoProviderId);
  const videoModelId = useSettingsStore((s) => s.videoModelId);
  const videoProvidersConfig = useSettingsStore((s) => s.videoProvidersConfig);
  const setVideoProvider = useSettingsStore((s) => s.setVideoProvider);
  const setVideoModelId = useSettingsStore((s) => s.setVideoModelId);
  const videoSelection = useSettingsStore((s) => s.videoSelection);
  const platformDefaults = useSettingsStore((s) => s.platformDefaults);
  const setPlatformDefault = useSettingsStore((s) => s.setPlatformDefault);
  const platformDefaultsStatus = useSettingsStore((s) => s.platformDefaultsStatus);
  const ttsSelection = useSettingsStore((s) => s.ttsSelection);
  const ttsProviderId = useSettingsStore((s) => s.ttsProviderId);
  const ttsVoice = useSettingsStore((s) => s.ttsVoice);
  const ttsProvidersConfig = useSettingsStore((s) => s.ttsProvidersConfig);
  const platformTTS =
    ttsSelection?.source === 'platform'
      ? platformDefaults?.entries.find(
          (entry) => entry.capability === 'tts' && entry.defaultId === ttsSelection.defaultId,
        )
      : undefined;
  const ttsConfig = ttsProvidersConfig[ttsProviderId];
  const ttsProvider = TTS_PROVIDERS[ttsProviderId as keyof typeof TTS_PROVIDERS];
  const ttsModelId = resolveTTSModelForVoice(
    ttsProviderId,
    ttsVoice,
    ttsConfig?.modelId || ttsProvider?.defaultModelId,
  );
  const ttsModelName =
    ttsConfig?.customModels?.find((model) => model.id === ttsModelId)?.name ||
    ttsProvider?.models.find((model) => model.id === ttsModelId)?.name ||
    ttsModelId;

  const asrProviderId = useSettingsStore((s) => s.asrProviderId);
  const asrLanguage = useSettingsStore((s) => s.asrLanguage);
  const asrProvidersConfig = useSettingsStore((s) => s.asrProvidersConfig);
  const setASRProvider = useSettingsStore((s) => s.setASRProvider);
  const setASRLanguage = useSettingsStore((s) => s.setASRLanguage);

  const [comfyWorkflows, setComfyWorkflows] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    fetch('/api/comfyui-workflows')
      .then((r) => r.json())
      .then((d) => setComfyWorkflows(d.workflows || []))
      .catch(() => setComfyWorkflows([]));
  }, []);

  const enabledMap: Record<TabId, boolean> = {
    image: imageGenerationEnabled,
    video: videoGenerationEnabled,
    tts: ttsEnabled,
    asr: asrEnabled,
  };

  const enabledCount = [
    imageGenerationEnabled,
    videoGenerationEnabled,
    ttsEnabled,
    asrEnabled,
  ].filter(Boolean).length;

  const cfgOk = useCallback(
    (
      configs: Record<
        string,
        { apiKey?: string; isServerConfigured?: boolean; serverDisabled?: boolean }
      >,
      id: string,
      needsKey: boolean,
    ) =>
      !configs[id]?.serverDisabled &&
      (!needsKey || !!configs[id]?.apiKey || !!configs[id]?.isServerConfigured),
    [],
  );

  // ─── Grouped select data (only available providers) ───
  const imageGroups = useMemo(() => {
    const userGroups = listImageProviders(IMAGE_PROVIDERS, imageProvidersConfig)
      .filter((p) => isImageProviderAvailable(p.id, IMAGE_PROVIDERS, imageProvidersConfig))
      .map((p) => {
        const items =
          p.id === 'comfyui-image'
            ? comfyWorkflows
            : p.isBuiltIn === false
              ? p.models
              : providerModels(p.models, imageProvidersConfig[p.id]);

        return {
          groupId: p.id,
          groupName: `${t('settings.platformDefault.userProvidedPrefix')} ${p.name}`,
          groupIcon: IMAGE_PROVIDER_ICONS[p.id],
          available: true,
          // Map to a consistent format here
          items: items.map((m) => ({
            id: m.id,
            name: m.name,
          })),
        };
      });
    const platform = platformDefaults?.entries.find((entry) => entry.capability === 'image');
    return platform
      ? [
          {
            groupId: PLATFORM_IMAGE_GROUP_ID,
            groupName: `ZHIYU ${t('settings.defaultModel')}`,
            available: platform.available,
            items: [{ id: platform.defaultId, name: platform.displayName }],
          },
          ...userGroups,
        ]
      : userGroups;
  }, [imageProvidersConfig, comfyWorkflows, platformDefaults, t]);

  const videoGroups = useMemo(() => {
    const userGroups = listVideoProviders(VIDEO_PROVIDERS, videoProvidersConfig)
      .filter((p) => isVideoProviderAvailable(p.id, VIDEO_PROVIDERS, videoProvidersConfig))
      .map((p) => ({
        groupId: p.id,
        groupName: `${t('settings.platformDefault.userProvidedPrefix')} ${p.name}`,
        groupIcon: VIDEO_PROVIDER_ICONS[p.id],
        available: true,
        items: (p.isBuiltIn === false
          ? p.models
          : providerModels(p.models, videoProvidersConfig[p.id])
        ).map((m) => ({
          id: m.id,
          name: m.name,
        })),
      }));
    const platform = platformDefaults?.entries.find((entry) => entry.capability === 'video');
    return platform
      ? [
          {
            groupId: PLATFORM_VIDEO_GROUP_ID,
            groupName: `ZHIYU ${t('settings.defaultModel')}`,
            available: platform.available,
            items: [{ id: platform.defaultId, name: platform.displayName }],
          },
          ...userGroups,
        ]
      : userGroups;
  }, [platformDefaults, t, videoProvidersConfig]);

  // ASR: built-in + custom providers
  const asrGroups = useMemo(() => {
    const groups: SelectGroupData[] = [];

    // Built-in providers
    for (const p of Object.values(ASR_PROVIDERS)) {
      if (!cfgOk(asrProvidersConfig, p.id, p.requiresApiKey)) continue;
      groups.push({
        groupId: p.id,
        // `p.name` is the registry label, which is Chinese for several
        // providers; resolve it the way the settings dialog does.
        groupName: resolveASRProviderName(p.id, t, p.name),
        groupIcon: p.icon,
        available: true,
        items: getASRSupportedLanguages(p.id).map((l) => ({
          id: l,
          name: l,
        })),
      });
    }

    // Custom providers — only show if at least one model is configured
    for (const [id, cfg] of Object.entries(asrProvidersConfig)) {
      if (!isCustomASRProvider(id)) continue;
      const customModels = cfg.customModels || [];
      if (customModels.length === 0) continue;
      const providerName = cfg.customName || id;
      groups.push({
        groupId: id,
        groupName: providerName,
        available: true,
        items: CUSTOM_ASR_DEFAULT_LANGUAGES.map((l) => ({ id: l, name: l })),
      });
    }

    return groups;
  }, [asrProvidersConfig, cfgOk, t]);

  // Auto-select first enabled tab on open
  const handleOpenChange = (isOpen: boolean) => {
    setOpen(isOpen);
    if (isOpen) {
      const first = (['image', 'video', 'tts', 'asr'] as TabId[]).find((id) => enabledMap[id]);
      setActiveTab(first || 'image');
    }
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          className={cn(
            'inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors cursor-pointer select-none whitespace-nowrap border',
            enabledCount > 0
              ? 'bg-primary-soft text-primary-ink border-primary/30'
              : 'bg-card text-foreground hover:bg-muted border-border',
          )}
        >
          <SlidersHorizontal
            className={cn('size-3.5', enabledCount === 0 && 'text-muted-foreground')}
          />
          <span>{t('toolbar.mediaLabel')}</span>
          {imageGenerationEnabled && <ImageIcon className="size-3.5" />}
          {videoGenerationEnabled && <Video className="size-3.5" />}
          {ttsEnabled && <Volume2 className="size-3.5" />}
          {asrEnabled && <Mic className="size-3.5" />}
        </button>
      </PopoverTrigger>

      <PopoverContent align="start" side="bottom" avoidCollisions={false} className="w-80 p-0">
        {/* ── Tab bar (segmented control) ── */}
        <div className="p-2 pb-0">
          <div className="flex gap-0.5 p-0.5 bg-muted/60 rounded-lg">
            {TABS.map((tab) => {
              const isActive = activeTab === tab.id;
              const isEnabled = enabledMap[tab.id];
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-[11px] font-medium transition-all relative',
                    isActive
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground/80',
                  )}
                >
                  <Icon className="size-3.5" />
                  <span className="hidden sm:inline">{tab.label}</span>
                  {isEnabled && !isActive && (
                    <span className="absolute top-1 right-1 size-1.5 rounded-full bg-primary" />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Tab content ── */}
        <div className="p-3 pt-2.5">
          {activeTab === 'image' && (
            <TabPanel
              icon={ImageIcon}
              label={t('media.imageCapability')}
              enabled={imageGenerationEnabled}
              onToggle={setImageGenerationEnabled}
            >
              <GroupedSelect
                groups={imageGroups}
                selectedGroupId={
                  imageSelection?.source === 'platform' ? PLATFORM_IMAGE_GROUP_ID : imageProviderId
                }
                selectedItemId={
                  imageSelection?.source === 'platform' ? imageSelection.defaultId : imageModelId
                }
                onSelect={(gid, iid) => {
                  if (gid === PLATFORM_IMAGE_GROUP_ID) {
                    setPlatformDefault('image', iid as 'zhiyu-default-image');
                    return;
                  }
                  setImageProvider(gid as ImageProviderId);
                  setImageModelId(iid);
                }}
              />
            </TabPanel>
          )}

          {activeTab === 'video' && (
            <TabPanel
              icon={Video}
              label={t('media.videoCapability')}
              enabled={videoGenerationEnabled}
              onToggle={setVideoGenerationEnabled}
            >
              <GroupedSelect
                groups={videoGroups}
                selectedGroupId={
                  videoSelection?.source === 'platform' ? PLATFORM_VIDEO_GROUP_ID : videoProviderId
                }
                selectedItemId={
                  videoSelection?.source === 'platform' ? videoSelection.defaultId : videoModelId
                }
                onSelect={(gid, iid) => {
                  if (gid === PLATFORM_VIDEO_GROUP_ID) {
                    setPlatformDefault('video', iid as 'zhiyu-default-video');
                    return;
                  }
                  setVideoProvider(gid as VideoProviderId);
                  setVideoModelId(iid);
                }}
              />
            </TabPanel>
          )}

          {activeTab === 'tts' && (
            <TabPanel
              icon={Volume2}
              label={t('media.ttsCapability')}
              enabled={ttsEnabled}
              onToggle={setTTSEnabled}
            >
              <div
                className="rounded-lg border border-border/40 bg-background/80 px-2.5 py-2 text-xs"
                data-testid="media-tts-selected-model"
              >
                <div className="font-medium">
                  {ttsSelection?.source === 'platform'
                    ? t('settings.platformDefault.titles.tts')
                    : resolveTTSProviderName(
                        ttsProviderId,
                        t,
                        ttsConfig?.customName || ttsProvider?.name,
                      )}
                </div>
                <div className="mt-1 break-words text-muted-foreground">
                  {ttsSelection?.source === 'platform'
                    ? platformTTS?.displayName ||
                      t(
                        platformDefaultsStatus === 'error'
                          ? 'settings.platformDefault.statuses.loadError'
                          : platformDefaultsStatus === 'ready'
                            ? 'settings.platformDefault.statuses.notConfigured'
                            : 'settings.platformDefault.statuses.loading',
                      )
                    : ttsModelName ||
                      resolveTTSProviderName(
                        ttsProviderId,
                        t,
                        ttsConfig?.customName || ttsProvider?.name,
                      )}
                </div>
                {platformTTS && !platformTTS.available && (
                  <div className="mt-1 text-muted-foreground">
                    {t(
                      platformTTS.status === 'disabled'
                        ? 'settings.platformDefault.statuses.disabled'
                        : 'settings.platformDefault.statuses.notConfigured',
                    )}
                  </div>
                )}
              </div>
            </TabPanel>
          )}

          {activeTab === 'asr' && (
            <TabPanel
              icon={Mic}
              label={t('media.asrCapability')}
              enabled={asrEnabled}
              onToggle={setASREnabled}
            >
              <GroupedSelect
                groups={asrGroups}
                selectedGroupId={asrProviderId}
                selectedItemId={asrLanguage}
                onSelect={(gid, iid) => {
                  setASRProvider(gid as ASRProviderId);
                  setASRLanguage(iid);
                }}
              />
            </TabPanel>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="border-t border-border/40">
          <button
            onClick={() => {
              setOpen(false);
              onSettingsOpen(activeTab, triggerRef.current);
            }}
            className="w-full flex items-center justify-between px-3.5 py-2.5 text-[11px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
          >
            <span>{t('toolbar.advancedSettings')}</span>
            <ChevronRight className="size-3" />
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ─── Tab panel: header (label + switch) + optional body ───
function TabPanel({
  icon: Icon,
  label,
  enabled,
  onToggle,
  children,
}: {
  icon: LucideIcon;
  label: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2.5">
        <Icon
          className={cn(
            'size-4 shrink-0 transition-colors',
            enabled ? 'text-primary-ink' : 'text-muted-foreground/50',
          )}
        />
        <span
          className={cn(
            'flex-1 text-sm font-medium transition-colors',
            !enabled && 'text-muted-foreground',
          )}
        >
          {label}
        </span>
        <Switch
          checked={enabled}
          onCheckedChange={onToggle}
          className="scale-[0.85] origin-right"
        />
      </div>
      {enabled && children}
    </div>
  );
}

// ─── Grouped provider+model select ───
interface SelectGroupData {
  groupId: string;
  groupName: string;
  groupIcon?: string;
  available: boolean;
  items: Array<{ id: string; name: string }>;
}

function GroupedSelect({
  groups,
  selectedGroupId,
  selectedItemId,
  onSelect,
}: {
  groups: SelectGroupData[];
  selectedGroupId: string;
  selectedItemId: string;
  onSelect: (groupId: string, itemId: string) => void;
}) {
  const composite = `${selectedGroupId}::${selectedItemId}`;
  // When multiple groups share the same groupId (e.g. browser-native-tts split by language),
  // find the sub-group that actually contains the selected item.
  const selectedGroup =
    groups.find(
      (g) => g.groupId === selectedGroupId && g.items.some((item) => item.id === selectedItemId),
    ) || groups.find((g) => g.groupId === selectedGroupId);

  return (
    <Select
      value={composite}
      onValueChange={(v) => {
        const sep = v.indexOf('::');
        if (sep === -1) return;
        onSelect(v.slice(0, sep), v.slice(sep + 2));
      }}
    >
      <SelectTrigger className="h-8 w-full rounded-lg border-border/40 bg-background/80 hover:bg-muted/40 shadow-none text-xs focus:ring-1 focus:ring-ring/30 px-2.5">
        <span className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
          {selectedGroup?.groupIcon && (
            <img src={selectedGroup.groupIcon} alt="" className="size-4 rounded-sm shrink-0" />
          )}
          <span className="font-medium truncate">{selectedGroup?.groupName}</span>
          <span className="text-muted-foreground/40">/</span>
          <span className="text-muted-foreground truncate">
            <SelectValue />
          </span>
        </span>
      </SelectTrigger>
      <SelectContent>
        {groups.map((group, i) => (
          <Fragment key={`${group.groupId}-${i}`}>
            {i > 0 && <SelectSeparator />}
            <SelectGroup>
              <SelectLabel className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider">
                {group.groupIcon && (
                  <img
                    src={group.groupIcon}
                    alt=""
                    className={cn('size-3.5 rounded-sm', !group.available && 'opacity-40')}
                  />
                )}
                {group.groupName}
              </SelectLabel>
              {group.items.map((item) => (
                <SelectItem
                  key={`${group.groupId}::${item.id}`}
                  value={`${group.groupId}::${item.id}`}
                  disabled={!group.available}
                  className="text-xs"
                >
                  {item.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </Fragment>
        ))}
      </SelectContent>
    </Select>
  );
}
