'use client';

/**
 * /study/materials/[materialId]/read?version=&page=[&artifact=&block=] — read one version
 * (learning plan B02): the original file (PDF pages rendered with pdf.js from
 * unpdf, images, text) beside the parsed text of the same page. Every
 * location names a version, so it keeps pointing at the same content after
 * the file is replaced. A citation (B03) also names the parse it came from and
 * the block, which is highlighted (with the cited passage, when known).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ChevronLeft, ChevronRight, Download, LoaderCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  StudyShell,
  StudyStatus,
  loadStudyPage,
  studyFailureState,
  type StudyLoadState,
} from '@/components/study/spaces/StudyShell';
import { useI18n } from '@/lib/hooks/use-i18n';
import { materialsApi, readerHref } from '@/lib/study/materials/client';
import { readCitationQuote } from '@/lib/study/knowledge/client';
import {
  readerOriginalKind,
  type ReaderBlock,
  type ReaderPageView,
} from '@/lib/study/materials/contracts';
import { fetchStudyCapabilities } from '@/lib/study/spaces/client';

export function MaterialReaderPage({ materialId }: { materialId: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const search = useSearchParams();
  const versionId = search.get('version') ?? '';
  const requestedPage = Number(search.get('page') ?? '1') || 1;
  const artifactId = search.get('artifact') || undefined;
  const blockId = search.get('block') || null;
  const [quote, setQuote] = useState<string | null>(null);
  useEffect(() => setQuote(blockId ? readCitationQuote(blockId) : null), [blockId]);
  const [state, setState] = useState<StudyLoadState>('loading');
  const [view, setView] = useState<ReaderPageView | null>(null);
  const [currentVersionId, setCurrentVersionId] = useState<string | null>(null);
  const [pageLoading, setPageLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadStudyPage(async () => {
      if (!(await fetchStudyCapabilities()).materials) {
        throw Object.assign(new Error('unavailable'), { status: 404 });
      }
      const detail = await materialsApi.get(materialId);
      const version = versionId || detail.material.current.versionId;
      return { detail, version };
    }).then((result) => {
      if (cancelled) return;
      if (result.state === 'ready') {
        setCurrentVersionId(result.data.detail.material.current.versionId);
        if (!versionId) {
          router.replace(readerHref(materialId, result.data.version, requestedPage));
          return;
        }
      }
      if (result.state !== 'ready') setState(result.state);
    });
    return () => {
      cancelled = true;
    };
    // The page number changes are handled by the reader effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [materialId, versionId]);

  useEffect(() => {
    if (!versionId) return;
    const controller = new AbortController();
    setPageLoading(true);
    materialsApi
      .reader(materialId, versionId, requestedPage, artifactId, controller.signal)
      .then((next) => {
        setView(next);
        setState('ready');
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        if ((error as { code?: string })?.code === 'STUDY_MATERIAL_NOT_PARSED') {
          setView(null);
          setState('ready');
          return;
        }
        setState(studyFailureState(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setPageLoading(false);
      });
    return () => controller.abort();
  }, [materialId, versionId, requestedPage, artifactId]);

  useEffect(() => {
    if (!blockId || !view) return;
    document
      .querySelector(`[data-block-id="${CSS.escape(blockId)}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [blockId, view]);

  const goTo = useCallback(
    (page: number) => {
      // Paging keeps the parse a citation named, but not its block highlight.
      const href = readerHref(materialId, versionId, page);
      router.replace(artifactId ? `${href}&artifact=${encodeURIComponent(artifactId)}` : href, {
        scroll: false,
      });
    },
    [artifactId, materialId, router, versionId],
  );

  if (state !== 'ready') {
    return (
      <StudyShell>
        <StudyStatus state={state} />
      </StudyShell>
    );
  }

  const backLink = (
    <Link
      href={`/study/materials/${encodeURIComponent(materialId)}`}
      className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ChevronLeft className="size-4" />
      {t('study.materials.backToMaterial')}
    </Link>
  );

  if (!view) {
    return (
      <StudyShell>
        {backLink}
        <div
          className="rounded-2xl border border-dashed border-border px-6 py-14 text-center text-sm text-muted-foreground"
          data-testid="study-reader-not-parsed"
        >
          {t('study.materials.reader.notParsed')}
        </div>
      </StudyShell>
    );
  }

  const kind = readerOriginalKind(view.mime);
  const fileUrl = materialsApi.fileUrl(materialId, view.versionId);

  return (
    <StudyShell>
      {backLink}
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1
            className="truncate text-xl font-semibold text-foreground md:text-2xl"
            data-testid="study-reader-title"
          >
            {view.title}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {view.originalName} · {t('study.materials.versionLabel', { n: view.versionNo })}
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <a href={materialsApi.fileUrl(materialId, view.versionId, true)}>
            <Download className="mr-1 size-4" />
            {t('study.materials.download')}
          </a>
        </Button>
      </header>

      {!view.isCurrent && currentVersionId ? (
        <div
          className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-review/30 bg-review-soft/60 px-4 py-2 text-sm"
          data-testid="study-reader-old-version"
        >
          <span>{t('study.materials.reader.oldVersion', { n: view.versionNo })}</span>
          <Link
            className="font-medium text-primary hover:underline"
            href={readerHref(materialId, currentVersionId)}
          >
            {t('study.materials.reader.viewCurrent')}
          </Link>
        </div>
      ) : null}

      {view.paged ? (
        <PageNav
          key={view.page ?? 1}
          page={view.page ?? 1}
          total={view.pageCount}
          loading={pageLoading}
          onGo={goTo}
        />
      ) : (
        <p className="mb-3 text-sm text-muted-foreground">{t('study.materials.reader.noPages')}</p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="min-w-0 rounded-2xl border border-border bg-card p-3">
          <h2 className="mb-2 px-1 text-xs font-medium text-muted-foreground">
            {t('study.materials.reader.original')}
          </h2>
          {kind === 'pdf' ? (
            <PdfPageView url={fileUrl} page={view.page ?? 1} />
          ) : kind === 'image' ? (
            <img
              src={fileUrl}
              alt={view.originalName}
              className="mx-auto max-h-[70vh] max-w-full"
            />
          ) : kind === 'text' ? (
            <TextOriginal url={fileUrl} />
          ) : (
            <p className="px-1 py-8 text-center text-sm text-muted-foreground">
              {t('study.materials.reader.downloadOnly')}
            </p>
          )}
        </section>
        <section
          className="min-w-0 rounded-2xl border border-border bg-card p-4"
          data-testid="study-reader-parsed"
        >
          <h2 className="mb-2 text-xs font-medium text-muted-foreground">
            {t('study.materials.reader.parsed')}
          </h2>
          {view.blocks.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t('study.materials.reader.emptyPage')}
            </p>
          ) : (
            <div className="space-y-3">
              {view.blocks.map((block) => (
                <BlockView
                  key={block.id}
                  block={block}
                  cited={block.id === blockId}
                  quote={block.id === blockId ? quote : null}
                  imageUrl={
                    block.imageId
                      ? materialsApi.imageUrl(
                          materialId,
                          view.versionId,
                          block.imageId,
                          view.artifactId,
                        )
                      : undefined
                  }
                />
              ))}
            </div>
          )}
          {view.truncated ? (
            <p className="mt-3 text-xs text-muted-foreground">
              {t('study.materials.reader.truncated')}
            </p>
          ) : null}
        </section>
      </div>
      {view.paged ? (
        <div className="mt-4">
          <PageNav
            key={view.page ?? 1}
            page={view.page ?? 1}
            total={view.pageCount}
            loading={pageLoading}
            onGo={goTo}
          />
        </div>
      ) : null}
    </StudyShell>
  );
}

function PageNav({
  page,
  total,
  loading,
  onGo,
}: {
  page: number;
  total: number;
  loading: boolean;
  onGo: (page: number) => void;
}) {
  const { t } = useI18n();
  // Remounted per page (keyed by the caller), so the draft starts at the page shown.
  const [draft, setDraft] = useState(String(page));
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="study-reader-nav">
      <Button
        size="sm"
        variant="outline"
        disabled={page <= 1}
        onClick={() => onGo(page - 1)}
        aria-label={t('study.materials.reader.prev')}
      >
        <ChevronLeft className="size-4" />
      </Button>
      <span className="text-sm text-foreground" data-testid="study-reader-page">
        {t('study.materials.reader.page', { page, total })}
      </span>
      <Button
        size="sm"
        variant="outline"
        disabled={page >= total}
        onClick={() => onGo(page + 1)}
        aria-label={t('study.materials.reader.next')}
      >
        <ChevronRight className="size-4" />
      </Button>
      <form
        className="flex items-center gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          const target = Math.trunc(Number(draft));
          if (target >= 1 && target <= total) onGo(target);
        }}
      >
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          inputMode="numeric"
          className="h-8 w-16"
          aria-label={t('study.materials.reader.goTo')}
          data-testid="study-reader-page-input"
        />
        <Button size="sm" variant="ghost" type="submit">
          {t('study.materials.reader.goTo')}
        </Button>
      </form>
      {loading ? <LoaderCircle className="size-4 animate-spin text-muted-foreground" /> : null}
    </div>
  );
}

/** Text with the cited passage marked (its start, matched across whitespace). */
function MarkedText({ text, quote }: { text: string; quote: string | null }) {
  const probe = quote?.replace(/…$/, '').replace(/\s+/g, ' ').trim();
  if (!probe) return <>{text}</>;
  const pattern = probe
    .split(' ')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  const match = new RegExp(pattern).exec(text);
  if (!match) return <>{text}</>;
  return (
    <>
      {text.slice(0, match.index)}
      <mark className="rounded bg-review-soft px-0.5 text-foreground">{match[0]}</mark>
      {text.slice(match.index + match[0].length)}
    </>
  );
}

function BlockView(props: {
  block: ReaderBlock;
  imageUrl?: string;
  cited?: boolean;
  quote?: string | null;
}) {
  const { cited = false } = props;
  return (
    <div
      data-block-id={props.block.id}
      data-cited={cited ? 'true' : undefined}
      className={cited ? 'rounded-lg ring-2 ring-review/70 ring-offset-2 ring-offset-card' : ''}
    >
      <BlockContent {...props} />
    </div>
  );
}

function BlockContent({
  block,
  imageUrl,
  quote = null,
}: {
  block: ReaderBlock;
  imageUrl?: string;
  quote?: string | null;
}) {
  const { t } = useI18n();
  if (block.type === 'image' && imageUrl) {
    return (
      <figure>
        <img
          src={imageUrl}
          alt={block.text ?? t('study.materials.reader.image')}
          className="max-w-full rounded-lg"
        />
        {block.text ? (
          <figcaption className="mt-1 text-xs text-muted-foreground">{block.text}</figcaption>
        ) : null}
      </figure>
    );
  }
  if (block.type === 'formula') {
    return (
      <pre className="overflow-x-auto rounded-lg bg-muted px-3 py-2 text-xs">{block.text}</pre>
    );
  }
  if (block.type === 'table') {
    return (
      <pre className="overflow-x-auto whitespace-pre rounded-lg bg-muted px-3 py-2 text-xs">
        {block.text}
      </pre>
    );
  }
  return (
    <p
      className="whitespace-pre-wrap break-words text-sm leading-7 text-foreground"
      data-testid="study-reader-block"
    >
      <MarkedText text={block.text ?? ''} quote={quote} />
    </p>
  );
}

/** Text originals (txt/md/csv) shown as-is, capped for very large files. */
function TextOriginal({ url }: { url: string }) {
  const { t } = useI18n();
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch(url, { credentials: 'include', cache: 'no-store' })
      .then((response) => (response.ok ? response.text() : Promise.reject(response.status)))
      .then((body) => !cancelled && setText(body.slice(0, 200_000)))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [url]);
  if (failed)
    return <p className="py-8 text-center text-sm text-destructive">{t('study.state.error')}</p>;
  if (text === null)
    return <LoaderCircle className="mx-auto my-8 size-4 animate-spin text-muted-foreground" />;
  return (
    <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words px-1 text-sm leading-7">
      {text}
    </pre>
  );
}

type PdfDocument = Awaited<ReturnType<(typeof import('unpdf'))['getDocumentProxy']>>;

/**
 * One PDF page drawn on a canvas by pdf.js (the serverless build unpdf already
 * ships). The document is fetched once per version and kept while the page
 * changes; rendering follows the container width and device pixel ratio.
 */
export function PdfPageView({ url, page }: { url: string; page: number }) {
  const { t } = useI18n();
  const container = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [pdf, setPdf] = useState<PdfDocument | null>(null);
  const [failed, setFailed] = useState(false);
  const [rendering, setRendering] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let loaded: PdfDocument | null = null;
    setPdf(null);
    setFailed(false);
    (async () => {
      const response = await fetch(url, { credentials: 'include', cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const { getDocumentProxy } = await import('unpdf');
      loaded = await getDocumentProxy(bytes);
      if (cancelled) {
        void loaded.destroy();
        return;
      }
      setPdf(loaded);
    })().catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (loaded) void loaded.destroy();
    };
  }, [url]);

  useEffect(() => {
    if (!pdf || !canvas.current || !container.current) return;
    let cancelled = false;
    let task: { cancel(): void; promise: Promise<unknown> } | null = null;
    setRendering(true);
    (async () => {
      const pdfPage = await pdf.getPage(Math.min(Math.max(1, page), pdf.numPages));
      if (cancelled || !canvas.current || !container.current) return;
      const base = pdfPage.getViewport({ scale: 1 });
      const width = Math.max(200, container.current.clientWidth);
      const ratio = window.devicePixelRatio || 1;
      const viewport = pdfPage.getViewport({ scale: (width / base.width) * ratio });
      const target = canvas.current;
      target.width = Math.floor(viewport.width);
      target.height = Math.floor(viewport.height);
      target.style.width = `${Math.floor(viewport.width / ratio)}px`;
      target.style.height = `${Math.floor(viewport.height / ratio)}px`;
      const context = target.getContext('2d');
      if (!context) throw new Error('no canvas context');
      task = pdfPage.render({ canvasContext: context, viewport, canvas: target } as never);
      await task.promise;
      if (!cancelled) setRendering(false);
    })().catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, page]);

  if (failed) {
    return (
      <p
        className="py-8 text-center text-sm text-muted-foreground"
        data-testid="study-reader-pdf-failed"
      >
        {t('study.materials.reader.pdfFailed')}
      </p>
    );
  }
  return (
    <div ref={container} className="relative w-full" data-testid="study-reader-pdf">
      {!pdf || rendering ? (
        <div className="absolute inset-x-0 top-6 flex justify-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          {t('study.materials.reader.pdfLoading')}
        </div>
      ) : null}
      <canvas ref={canvas} className="mx-auto block max-w-full rounded-md border border-border" />
    </div>
  );
}
