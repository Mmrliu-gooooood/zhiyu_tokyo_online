'use client';

import { useState } from 'react';
import { ImagePlus } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
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
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useUserProfileStore, AVATAR_OPTIONS } from '@/lib/store/user-profile';

/** Check whether avatar is a custom upload (data-URL) */
function isCustomAvatar(avatar: string) {
  return avatar.startsWith('data:');
}

/** Max uploaded image size before we reject */
const MAX_AVATAR_SIZE = 5 * 1024 * 1024; // 5 MB

const FILE_INPUT_ID = 'user-avatar-upload';

/** Read an uploaded image and crop it to a 128px square JPEG data URL. */
function readAvatarFile(file: File, onDone: (dataUrl: string) => void) {
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 128;
      const ctx = canvas.getContext('2d')!;
      const scale = Math.max(128 / img.width, 128 / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.drawImage(img, (128 - w) / 2, (128 - h) / 2, w, h);
      onDone(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.src = reader.result as string;
  };
  reader.readAsDataURL(file);
}

/**
 * Edit the learner profile the AI teacher sees: avatar, nickname and a short
 * bio. Changes are drafted locally and written to the profile store on save.
 */
export function ProfileDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {/* Mounted only while open, so every opening starts from the stored profile. */}
        {open ? <ProfileForm onDone={() => onOpenChange(false)} /> : null}
        <DialogDescription className="sr-only">{t('profile.avatarHint')}</DialogDescription>
      </DialogContent>
    </Dialog>
  );
}

function ProfileForm({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const store = useUserProfileStore();
  const [avatar, setAvatar] = useState(store.avatar);
  const [nickname, setNickname] = useState(store.nickname);
  const [bio, setBio] = useState(store.bio);

  const handleAvatarUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > MAX_AVATAR_SIZE) {
      toast.error(t('profile.fileTooLarge'));
      return;
    }
    if (!file.type.startsWith('image/')) {
      toast.error(t('profile.invalidFileType'));
      return;
    }
    readAvatarFile(file, setAvatar);
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        store.setAvatar(avatar);
        store.setNickname(nickname.trim());
        store.setBio(bio);
        onDone();
      }}
      className="flex flex-col gap-5"
    >
      <DialogHeader>
        <DialogTitle className="font-display text-xl font-bold">
          {t('shell.profileTitle')}
        </DialogTitle>
      </DialogHeader>

      <div className="flex flex-col gap-2.5">
        <span className="text-sm font-medium text-foreground">{t('profile.chooseAvatar')}</span>
        <div className="flex items-center gap-3">
          <img
            src={avatar}
            alt=""
            className="size-14 shrink-0 rounded-full bg-muted object-cover ring-2 ring-primary/30"
          />
          <div className="flex flex-wrap items-center gap-1.5">
            {AVATAR_OPTIONS.map((url, index) => (
              <button
                key={url}
                type="button"
                onClick={() => setAvatar(url)}
                aria-label={`${t('profile.chooseAvatar')} ${index + 1}`}
                aria-pressed={avatar === url}
                className={cn(
                  'size-9 overflow-hidden rounded-full bg-muted transition-shadow',
                  avatar === url
                    ? 'ring-2 ring-primary ring-offset-2 ring-offset-card'
                    : 'hover:ring-1 hover:ring-border-strong',
                )}
              >
                <img src={url} alt="" className="size-full" />
              </button>
            ))}
            <input
              id={FILE_INPUT_ID}
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={handleAvatarUpload}
            />
            <label
              htmlFor={FILE_INPUT_ID}
              title={t('profile.uploadAvatar')}
              className={cn(
                'flex size-9 cursor-pointer items-center justify-center rounded-full border border-dashed transition-colors',
                isCustomAvatar(avatar)
                  ? 'border-primary/40 bg-primary-soft text-primary-ink ring-2 ring-primary ring-offset-2 ring-offset-card'
                  : 'border-border-strong text-muted-foreground hover:text-foreground',
              )}
            >
              <ImagePlus className="size-4" />
              <span className="sr-only">{t('profile.uploadAvatar')}</span>
            </label>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t('profile.avatarHint')}</p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="profile-nickname">{t('shell.nickname')}</Label>
        <Input
          id="profile-nickname"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          maxLength={20}
          placeholder={t('profile.defaultNickname')}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="profile-bio">{t('shell.bio')}</Label>
        <Textarea
          id="profile-bio"
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          placeholder={t('profile.bioPlaceholder')}
          maxLength={200}
          rows={3}
          className="min-h-[88px] resize-none"
        />
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button type="submit">{t('shell.save')}</Button>
      </DialogFooter>
    </form>
  );
}
