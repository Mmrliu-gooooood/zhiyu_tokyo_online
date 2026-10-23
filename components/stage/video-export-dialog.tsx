'use client';

/**
 * Video-export dialog — a centered modal for configuring and running a
 * classroom → video export.
 *
 * Replaces the cramped dropdown section (`video-export-menu.tsx`): parameters
 * (resolution / fps / quality / subtitles) get room to group, and the modal has
 * a stable lifecycle so a multi-minute render's progress, ETA, and result stay
 * visible instead of vanishing when a dropdown loses focus.
 *
 * Two render paths share one project ZIP:
 * - **Render MP4** (when the render service is configured) — uploads the ZIP,
 *   polls the async job, downloads the MP4. Exposes fps / quality + live progress.
 * - **Download ZIP** — the always-available degrade path (local CLI rendering).
 *
 * Subtitles are burned in only when toggled on (default off, #867 item 2); the
 * "Download subtitles" button always yields an SRT the user can add in an editor.
 */
import { useEffect, useState } from 'react';
import { Film, Loader2, Download } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import { useExportVideo } from '@/lib/video-export-app/use-export-video';
import { useRenderVideo } from '@/lib/video-export-app/use-render-video';
import { useDownloadSubtitles } from '@/lib/video-export-app/use-download-subtitles';
import {
  VIDEO_FPS,
  VIDEO_QUALITIES,
  VIDEO_RESOLUTIONS,
  type VideoResolution,
} from '@/lib/video-export-app/export-options';

const RESOLUTIONS = Object.keys(VIDEO_RESOLUTIONS) as VideoResolution[];

/** Format an ETA (ms) as a short localized "about X min Y sec" / "about Y sec". */
function formatRemaining(
  ms: number,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const totalSec = Math.max(1, Math.ceil(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? t('export.videoEtaMinSec', { min, sec }) : t('export.videoEtaSec', { sec });
}

/** A row of mutually-exclusive small pill buttons. */
function OptionRow<T extends string | number>({
  label,
  options,
  value,
  onChange,
  format,
  disabled,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  format?: (v: T) => string;
  disabled?: boolean;
}) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-[11px] font-medium text-muted-foreground">{label}</legend>
      <div className="grid grid-flow-col auto-cols-fr gap-1.5 rounded-xl bg-muted/55 p-1">
        {options.map((opt) => (
          <button
            type="button"
            key={String(opt)}
            onClick={() => onChange(opt)}
            disabled={disabled}
            aria-pressed={opt === value}
            className={cn(
              'min-h-8 rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors disabled:opacity-50',
              opt === value
                ? 'border-primary/30 bg-secondary text-primary shadow-sm'
                : 'border-transparent text-muted-foreground hover:bg-background hover:text-foreground',
            )}
          >
            {format ? format(opt) : String(opt)}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export function VideoExportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const { exporting: isExportingVideo, exportVideo } = useExportVideo();
  const { rendering, percent, etaMs, options, setOptions, renderVideo } = useRenderVideo();
  const { downloading, downloadSubtitles } = useDownloadSubtitles();
  const { resolution, fps, quality, burnInSubtitles } = options;
  // undefined = unknown (still probing); true/false = capability answer.
  const [serviceEnabled, setServiceEnabled] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    let active = true;
    fetch('/api/export-video/capability')
      .then((r) => r.json())
      .then((d: { enabled?: boolean }) => {
        if (active) setServiceEnabled(Boolean(d.enabled));
      })
      .catch(() => {
        if (active) setServiceEnabled(false);
      });
    return () => {
      active = false;
    };
  }, [open]);

  // Any in-flight export operation (ZIP build, in-app render, or subtitle
  // download) blocks the others — they share one compile/store critical section.
  const busy = isExportingVideo || rendering || downloading;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-5 rounded-2xl border-border/80 bg-background p-6 shadow-[0_24px_70px_rgba(20,26,46,0.16)]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-ai-soft text-ai">
              <Film className="size-4" />
            </span>
            {t('export.video')}
          </DialogTitle>
          <DialogDescription>{t('export.videoDesc')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* Output settings */}
          <OptionRow
            label={t('export.videoResolution')}
            options={RESOLUTIONS}
            value={resolution}
            onChange={(resolution) => setOptions({ resolution })}
            format={(r) => (r === '4k' ? '4K' : r)}
            disabled={busy}
          />
          {serviceEnabled && (
            <>
              <OptionRow
                label={t('export.videoFps')}
                options={VIDEO_FPS}
                value={fps}
                onChange={(fps) => setOptions({ fps })}
                disabled={busy}
              />
              <OptionRow
                label={t('export.videoQuality')}
                options={VIDEO_QUALITIES}
                value={quality}
                onChange={(quality) => setOptions({ quality })}
                format={(q) => t(`export.videoQuality_${q}`)}
                disabled={busy}
              />
            </>
          )}

          {/* Subtitles */}
          <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-muted/25 p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm">{t('export.videoBurnSubtitles')}</div>
                <div className="text-[11px] text-muted-foreground">
                  {t('export.videoBurnSubtitlesDesc')}
                </div>
              </div>
              <Switch
                checked={burnInSubtitles}
                onCheckedChange={(burnInSubtitles) => setOptions({ burnInSubtitles })}
                disabled={busy}
              />
            </div>
            <button
              type="button"
              onClick={() => downloadSubtitles('srt')}
              disabled={busy || downloading}
              className="flex min-h-9 w-full items-center justify-center gap-1.5 rounded-[10px] border border-border bg-background px-2 py-1.5 text-xs font-medium transition-colors hover:bg-secondary hover:text-primary disabled:opacity-50"
            >
              {downloading ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Download className="w-3 h-3" />
              )}
              {t('export.videoDownloadSubtitles')}
            </button>
          </div>

          {/* Progress */}
          {rendering && (
            <div>
              <Progress value={percent} />
              <div className="mt-1.5 text-[11px] text-muted-foreground">
                {etaMs != null
                  ? t('export.videoProgressWithEta', {
                      percent,
                      remaining: formatRemaining(etaMs, t),
                    })
                  : t('export.videoProgress', { percent })}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-col gap-2 border-t border-border/70 pt-4">
            {serviceEnabled && (
              <button
                type="button"
                onClick={() => renderVideo()}
                disabled={busy}
                className="flex min-h-10 w-full items-center justify-center gap-1.5 rounded-[10px] bg-primary px-2 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {rendering && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {t('export.videoRenderMp4')}
              </button>
            )}
            <button
              type="button"
              onClick={() => exportVideo(resolution, burnInSubtitles)}
              disabled={busy}
              className="flex min-h-10 w-full items-center justify-center gap-1.5 rounded-[10px] border border-border bg-background px-2 py-2 text-sm font-medium transition-colors hover:bg-secondary hover:text-primary disabled:opacity-50"
            >
              {isExportingVideo && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {t('export.videoDownloadZip')}
            </button>
            {serviceEnabled === false && (
              <div className="text-[11px] leading-relaxed text-muted-foreground">
                {t('export.videoServiceHint')}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
