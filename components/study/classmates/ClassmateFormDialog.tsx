'use client';

/**
 * Create / edit a classmate template (learning plan B04): name, role,
 * persona, companion style, speaking rule, avatar (bundled or a small
 * upload), voice from the voices this student can already use, and the
 * library materials it may draw on.
 */
import { useMemo, useRef, useState } from 'react';
import { ImageUp, LoaderCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { BROWSER_NATIVE_TTS_PROVIDER_ID } from '@/lib/audio/provider-enablement';
import {
  scopeProvidersToPlatformTTS,
  withPlatformTTSAvailability,
} from '@/lib/audio/platform-tts-selection';
import { getSelectableProvidersWithVoices } from '@/lib/audio/voice-resolver';
import { useAllVoiceProfiles } from '@/lib/audio/voxcpm-voices';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { classmateApi } from '@/lib/study/classmates/client';
import {
  CLASSMATE_COLORS,
  CLASSMATE_LEARNING_STYLES,
  CLASSMATE_LIMITS,
  CLASSMATE_PRESET_AVATARS,
  CLASSMATE_ROLES,
  CLASSMATE_SPEECH_POLICIES,
  classmateVoiceBinding,
  parseClassmateInput,
  type ClassmateInput,
  type ClassmateView,
  type ClassmateVoice,
} from '@/lib/study/classmates/contracts';
import type { StudyMaterialSummary } from '@/lib/study/materials/contracts';
import { cn } from '@/lib/utils';

import { ClassmateModelPolicyField } from './ClassmateModelPolicyField';

const NO_VOICE = 'none';

interface VoiceOption {
  key: string;
  label: string;
  voice: ClassmateVoice;
}

function voiceKey(voice: Pick<ClassmateVoice, 'providerId' | 'modelId' | 'voiceId'>): string {
  return `${voice.providerId}::${voice.modelId ?? ''}::${voice.voiceId}`;
}

/** Voices this student can already use; browser voices differ per device, so they are left out. */
function useVoiceOptions(current: ClassmateVoice | null): VoiceOption[] {
  const ttsProvidersConfig = useSettingsStore((s) => s.ttsProvidersConfig);
  const ttsSelection = useSettingsStore((s) => s.ttsSelection);
  const platformDefaults = useSettingsStore((s) => s.platformDefaults);
  const { profiles } = useAllVoiceProfiles();
  return useMemo(() => {
    const providers = scopeProvidersToPlatformTTS(
      getSelectableProvidersWithVoices(
        withPlatformTTSAvailability(ttsProvidersConfig, ttsSelection, platformDefaults),
        profiles,
      ),
      ttsSelection,
      platformDefaults,
      ttsProvidersConfig,
    ).filter((provider) => provider.providerId !== BROWSER_NATIVE_TTS_PROVIDER_ID);
    const options: VoiceOption[] = providers.flatMap((provider) =>
      provider.modelGroups.flatMap((group) =>
        group.voices.map((entry) => {
          const voice = classmateVoiceBinding(
            {
              providerId: provider.providerId,
              ...(group.modelId ? { modelId: group.modelId } : {}),
              voiceId: entry.id,
            },
            { ttsSelection, platformDefaults, ttsProvidersConfig },
          );
          return {
            key: voiceKey(voice),
            label: `${entry.name} · ${group.modelId ? `${provider.providerName} ${group.modelName}` : provider.providerName}`,
            voice,
          };
        }),
      ),
    );
    if (current && !options.some((option) => option.key === voiceKey(current))) {
      options.unshift({ key: voiceKey(current), label: current.voiceId, voice: current });
    }
    return options;
  }, [ttsProvidersConfig, ttsSelection, platformDefaults, profiles, current]);
}

/** Downscale a picked image to a 128px square WebP (PNG where WebP encoding is missing). */
async function resizeAvatar(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas');
  const side = Math.min(bitmap.width, bitmap.height);
  context.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    size,
    size,
  );
  bitmap.close();
  const encode = (type: string) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.86));
  const webp = await encode('image/webp');
  const blob = webp?.type === 'image/webp' ? webp : await encode('image/png');
  if (!blob) throw new Error('encode');
  return blob;
}

function initialValues(classmate: ClassmateView | null | undefined, index: number): ClassmateInput {
  return classmate
    ? {
        name: classmate.name,
        role: classmate.role,
        persona: classmate.persona,
        learningStyle: classmate.learningStyle,
        speechPolicy: classmate.speechPolicy,
        avatar: classmate.avatar,
        color: classmate.color,
        voice: classmate.voice,
        materialIds: classmate.materialIds,
        modelPolicy: classmate.modelPolicy,
      }
    : {
        name: '',
        role: 'student',
        persona: '',
        learningStyle: 'peer',
        speechPolicy: 'active',
        avatar: CLASSMATE_PRESET_AVATARS[index % CLASSMATE_PRESET_AVATARS.length]!,
        color: CLASSMATE_COLORS[index % CLASSMATE_COLORS.length]!,
        voice: null,
        materialIds: [],
        modelPolicy: { mode: 'inherit' },
      };
}

export function ClassmateFormDialog({
  open,
  onOpenChange,
  classmate,
  defaultIndex,
  materials,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present when editing. */
  classmate?: ClassmateView | null;
  /** Spreads default avatars/colours over new classmates. */
  defaultIndex: number;
  /** The library, when this deployment has one; null hides the material field. */
  materials: StudyMaterialSummary[] | null;
  /** Resolves when saved; a rejection keeps the dialog open with its message. */
  onSubmit: (input: ClassmateInput) => Promise<void>;
}) {
  const { t } = useI18n();
  const [values, setValues] = useState<ClassmateInput>(() =>
    initialValues(classmate, defaultIndex),
  );
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const voiceOptions = useVoiceOptions(values.voice);

  const set = <K extends keyof ClassmateInput>(key: K, value: ClassmateInput[K]) =>
    setValues((previous) => ({ ...previous, [key]: value }));

  async function pickAvatar(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      const { avatar } = await classmateApi.uploadAvatar(await resizeAvatar(file));
      set('avatar', avatar);
    } catch {
      setError(t('study.classmates.form.avatarFailed'));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = parseClassmateInput(values);
    if (!parsed.ok) {
      setError(t(`study.classmates.form.invalid.${parsed.field === 'name' ? 'name' : 'other'}`));
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSubmit(parsed.value);
      onOpenChange(false);
    } catch (failure) {
      setError(
        failure instanceof Error && failure.message ? failure.message : t('study.errors.generic'),
      );
    } finally {
      setSaving(false);
    }
  }

  const presetAvatars = CLASSMATE_PRESET_AVATARS as readonly string[];
  const avatars = presetAvatars.includes(values.avatar)
    ? presetAvatars
    : [values.avatar, ...presetAvatars];

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <form onSubmit={submit} className="space-y-4" data-testid="classmate-form">
          <DialogHeader>
            <DialogTitle>
              {classmate
                ? t('study.classmates.form.editTitle')
                : t('study.classmates.form.createTitle')}
            </DialogTitle>
            <DialogDescription>{t('study.classmates.form.description')}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
            <div className="space-y-1.5">
              <Label htmlFor="classmate-name">{t('study.classmates.form.name')}</Label>
              <Input
                id="classmate-name"
                value={values.name}
                maxLength={CLASSMATE_LIMITS.name}
                placeholder={t('study.classmates.form.namePlaceholder')}
                onChange={(event) => set('name', event.target.value)}
                autoFocus
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="classmate-role">{t('study.classmates.form.role')}</Label>
              <Select
                value={values.role}
                onValueChange={(value) => set('role', value as ClassmateInput['role'])}
              >
                <SelectTrigger id="classmate-role" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CLASSMATE_ROLES.map((role) => (
                    <SelectItem key={role} value={role}>
                      {t(`study.classmates.role.${role}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>{t('study.classmates.form.avatar')}</Label>
            <div className="flex flex-wrap items-center gap-2" role="radiogroup">
              {avatars.map((avatar) => (
                <button
                  key={avatar}
                  type="button"
                  role="radio"
                  aria-checked={values.avatar === avatar}
                  aria-label={t('study.classmates.form.avatar')}
                  onClick={() => set('avatar', avatar)}
                  className={cn(
                    'size-10 overflow-hidden rounded-full ring-offset-2 ring-offset-background transition',
                    values.avatar === avatar ? 'ring-2 ring-primary' : 'ring-1 ring-border',
                  )}
                >
                  <img src={avatar} alt="" className="size-full object-cover" />
                </button>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={uploading}
                onClick={() => fileRef.current?.click()}
              >
                {uploading ? (
                  <LoaderCircle className="mr-1.5 size-4 animate-spin" />
                ) : (
                  <ImageUp className="mr-1.5 size-4" />
                )}
                {t('study.classmates.form.upload')}
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                data-testid="classmate-avatar-input"
                onChange={(event) => void pickAvatar(event.target.files?.[0])}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>{t('study.classmates.form.color')}</Label>
            <div className="flex flex-wrap gap-2" role="radiogroup">
              {CLASSMATE_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  role="radio"
                  aria-checked={values.color === color}
                  aria-label={color}
                  onClick={() => set('color', color)}
                  className={cn(
                    'size-6 rounded-full ring-offset-2 ring-offset-background',
                    values.color === color && 'ring-2 ring-primary',
                  )}
                  style={{ backgroundColor: color }}
                />
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="classmate-persona">{t('study.classmates.form.persona')}</Label>
            <Textarea
              id="classmate-persona"
              value={values.persona}
              maxLength={CLASSMATE_LIMITS.persona}
              placeholder={t('study.classmates.form.personaPlaceholder')}
              onChange={(event) => set('persona', event.target.value)}
              rows={4}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="classmate-style">{t('study.classmates.form.learningStyle')}</Label>
              <Select
                value={values.learningStyle}
                onValueChange={(value) =>
                  set('learningStyle', value as ClassmateInput['learningStyle'])
                }
              >
                <SelectTrigger id="classmate-style" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CLASSMATE_LEARNING_STYLES.map((style) => (
                    <SelectItem key={style} value={style}>
                      {t(`study.classmates.style.${style}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="classmate-speech">{t('study.classmates.form.speechPolicy')}</Label>
              <Select
                value={values.speechPolicy}
                onValueChange={(value) =>
                  set('speechPolicy', value as ClassmateInput['speechPolicy'])
                }
              >
                <SelectTrigger id="classmate-speech" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CLASSMATE_SPEECH_POLICIES.map((policy) => (
                    <SelectItem key={policy} value={policy}>
                      {t(`study.classmates.speech.${policy}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="-mt-2 text-xs leading-5 text-muted-foreground">
            {t(`study.classmates.speechHint.${values.speechPolicy}`)}
          </p>

          <div className="space-y-1.5">
            <Label htmlFor="classmate-voice">{t('study.classmates.form.voice')}</Label>
            <Select
              value={values.voice ? voiceKey(values.voice) : NO_VOICE}
              onValueChange={(value) =>
                set(
                  'voice',
                  value === NO_VOICE
                    ? null
                    : (voiceOptions.find((option) => option.key === value)?.voice ?? null),
                )
              }
            >
              <SelectTrigger id="classmate-voice" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_VOICE}>{t('study.classmates.form.voiceAuto')}</SelectItem>
                {voiceOptions.map((option) => (
                  <SelectItem key={option.key} value={option.key}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {materials ? (
            <div className="space-y-1.5">
              <Label>{t('study.classmates.form.materials')}</Label>
              <p className="text-xs leading-5 text-muted-foreground">
                {t('study.classmates.form.materialsHint')}
              </p>
              {materials.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t('study.classmates.form.noMaterials')}
                </p>
              ) : (
                <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border p-2">
                  {materials.map((material) => {
                    const checked = values.materialIds.includes(material.materialId);
                    return (
                      <label
                        key={material.materialId}
                        className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-muted"
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(next) =>
                            set(
                              'materialIds',
                              next
                                ? [...values.materialIds, material.materialId].slice(
                                    0,
                                    CLASSMATE_LIMITS.materialsPerClassmate,
                                  )
                                : values.materialIds.filter((id) => id !== material.materialId),
                            )
                          }
                        />
                        <span className="truncate">{material.title}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}

          <ClassmateModelPolicyField
            value={values.modelPolicy ?? { mode: 'inherit' }}
            onChange={(policy) => set('modelPolicy', policy)}
          />

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={saving || uploading}>
              {saving ? <LoaderCircle className="mr-1.5 size-4 animate-spin" /> : null}
              {classmate ? t('study.classmates.form.save') : t('study.classmates.form.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
