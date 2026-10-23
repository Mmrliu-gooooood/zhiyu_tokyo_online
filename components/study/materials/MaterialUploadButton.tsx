'use client';

/**
 * Upload one or more files into the material library (optionally into a
 * space, or as a new version of one material), with progress and the
 * duplicate / parse-not-started notices the server returns.
 */
import { useRef, useState } from 'react';
import { LoaderCircle, Upload } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import { uploadStudyMaterial } from '@/lib/study/materials/client';
import {
  STUDY_MATERIAL_ACCEPT,
  type StudyMaterialUploadResult,
} from '@/lib/study/materials/contracts';
import { StudyApiError } from '@/lib/study/spaces/client';

import { useMaterialErrorText } from './material-format';

export function MaterialUploadButton({
  spaceId,
  materialId,
  label,
  variant = 'default',
  size = 'sm',
  onUploaded,
  testId = 'study-material-upload',
}: {
  spaceId?: string;
  materialId?: string;
  label?: string;
  variant?: 'default' | 'secondary' | 'outline';
  size?: 'sm' | 'default';
  onUploaded: (result: StudyMaterialUploadResult) => void;
  testId?: string;
}) {
  const { t } = useI18n();
  const errorText = useMaterialErrorText();
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<{ name: string; percent: number } | null>(null);

  async function uploadAll(files: File[]) {
    for (const file of files) {
      setProgress({ name: file.name, percent: 0 });
      try {
        const result = await uploadStudyMaterial(file, {
          ...(spaceId ? { spaceId } : {}),
          ...(materialId ? { materialId } : {}),
          onProgress: (fraction) =>
            setProgress({ name: file.name, percent: Math.round(fraction * 100) }),
        });
        onUploaded(result);
        if (result.duplicateOf) {
          toast.info(
            t('study.materials.duplicateHint', {
              title: result.duplicateOf.title,
              version: result.duplicateOf.versionNo,
            }),
          );
        }
        if (result.parseNotStarted) {
          toast.warning(
            t('study.materials.parseNotStarted', {
              reason: errorText(new StudyApiError(503, result.parseNotStarted, null)),
            }),
          );
        }
      } catch (error) {
        toast.error(`${file.name}: ${errorText(error)}`);
      }
    }
    setProgress(null);
  }

  return (
    <>
      <input
        ref={input}
        type="file"
        multiple={!materialId}
        accept={STUDY_MATERIAL_ACCEPT}
        className="hidden"
        data-testid={`${testId}-input`}
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = '';
          if (files.length) void uploadAll(files);
        }}
      />
      <Button
        size={size}
        variant={variant}
        disabled={progress !== null}
        onClick={() => input.current?.click()}
        data-testid={testId}
      >
        {progress ? (
          <LoaderCircle className="mr-1 size-4 animate-spin" />
        ) : (
          <Upload className="mr-1 size-4" />
        )}
        {progress
          ? t('study.materials.uploading', { name: progress.name, percent: progress.percent })
          : (label ?? t('study.materials.upload'))}
      </Button>
    </>
  );
}
