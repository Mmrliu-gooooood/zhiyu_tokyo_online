'use client';

import { useEffect, useMemo, useState } from 'react';
import { Check, LoaderCircle, Search } from 'lucide-react';

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
import { useI18n } from '@/lib/hooks/use-i18n';
import { studyApi } from '@/lib/study/spaces/client';
import type { LinkableCourse } from '@/lib/study/spaces/contracts';
import { cn } from '@/lib/utils';
import { RelativeTime } from '@/components/study/spaces/study-format';

/** Pick existing courses (owned by the learner) to add to a space. Mount it while open. */
export function AddCoursesDialog({
  open,
  onOpenChange,
  spaceId,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  spaceId: string;
  onAdded: () => void;
}) {
  const { t } = useI18n();
  const [courses, setCourses] = useState<LinkableCourse[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    studyApi
      .listCourses()
      .then((list) => {
        if (!cancelled) setCourses(list);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (courses ?? []).filter(
      (course) => !needle || course.name.toLowerCase().includes(needle),
    );
  }, [courses, query]);

  const toggle = (stageId: string) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(stageId)) next.delete(stageId);
      else next.add(stageId);
      return next;
    });

  async function add() {
    setSaving(true);
    setError('');
    let failed = 0;
    for (const stageId of selected) {
      try {
        await studyApi.linkCourse(spaceId, stageId);
      } catch {
        failed += 1;
      }
    }
    setSaving(false);
    onAdded();
    if (failed) setError(t('study.addCourses.partialFailure', { count: failed }));
    else onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('study.addCourses.title')}</DialogTitle>
          <DialogDescription>{t('study.addCourses.description')}</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('study.addCourses.search')}
            className="pl-8"
          />
        </div>
        <div
          className="-mx-1 min-h-[160px] flex-1 overflow-y-auto px-1"
          data-testid="study-add-courses-list"
        >
          {loadFailed ? (
            <p className="py-10 text-center text-sm text-destructive">{t('study.state.error')}</p>
          ) : courses === null ? (
            <div className="flex justify-center py-10">
              <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : visible.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {courses.length === 0 ? t('study.addCourses.none') : t('study.addCourses.noMatch')}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {visible.map((course) => {
                const already = course.spaceIds.includes(spaceId);
                const checked = already || selected.has(course.stageId);
                return (
                  <li key={course.stageId}>
                    <button
                      type="button"
                      disabled={already}
                      onClick={() => toggle(course.stageId)}
                      aria-pressed={checked}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors',
                        checked
                          ? 'border-primary/50 bg-primary/5'
                          : 'border-border hover:bg-muted/60',
                        already && 'cursor-default opacity-60',
                      )}
                    >
                      <span
                        className={cn(
                          'flex size-4 shrink-0 items-center justify-center rounded border',
                          checked
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-border',
                        )}
                      >
                        {checked ? <Check className="size-3" /> : null}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">
                          {course.name}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {t('study.course.pages', { count: course.sceneCount })}
                          {course.generation === 'incomplete'
                            ? ` · ${t('study.course.generating')}`
                            : ''}
                          {' · '}
                          <RelativeTime iso={course.updatedAt} />
                        </span>
                      </span>
                      {already ? (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {t('study.addCourses.alreadyIn')}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button disabled={saving || selected.size === 0} onClick={() => void add()}>
            {saving ? <LoaderCircle className="mr-1.5 size-4 animate-spin" /> : null}
            {t('study.addCourses.confirm', { count: selected.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
