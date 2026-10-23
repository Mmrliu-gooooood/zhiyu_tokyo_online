'use client';

import { useState, useEffect, useEffectEvent, useMemo, useRef, useDeferredValue } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'motion/react';
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Folder,
  FolderPlus,
  Pencil,
  Trash2,
  Search,
  Upload,
  Sparkles,
  Atom,
  X,
  Presentation,
  Loader2,
} from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  StudyGenerationTargetBanner,
  useStudyGenerationTarget,
} from '@/components/study/spaces/home-entry';
import { GenerationMaterialPicker } from '@/components/study/materials/GenerationMaterialPicker';
import {
  studyMaterialsGenerationInput,
  type StudyMaterialSelection,
} from '@/lib/study/materials/generation';
import { createLogger } from '@/lib/logger';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupInput, InputGroupButton } from '@/components/ui/input-group';
import { cn } from '@/lib/utils';
import { SettingsDialog } from '@/components/settings';
import { AppShell } from '@/components/shell/AppShell';
import { HomeGreeting, HomeStudyOverview } from '@/components/home/HomeStudyOverview';
import { GenerationToolbar } from '@/components/generation/generation-toolbar';
import { AgentBar } from '@/components/agent/agent-bar';
import { nanoid } from 'nanoid';
import {
  deleteDocumentBlob,
  deleteStoredImages,
  storeDocumentBlob,
  storeImages,
} from '@/lib/utils/image-storage';
import { normalizeDocumentMimeType } from '@/lib/document/mime';
import {
  courseMaterialFingerprint,
  dedupeCourseMaterialFiles,
} from '@/lib/document/course-materials';
import type {
  PdfImage,
  SelectedCourseMaterial,
  SessionDocumentSource,
  UserRequirements,
} from '@/lib/types/generation';
import { useSettingsStore } from '@/lib/store/settings';
import { hasUsableLLMSelection } from '@/lib/store/settings-validation';
import { useUserProfileStore } from '@/lib/store/user-profile';
import {
  StageListItem,
  listStages,
  deleteStageData,
  renameStage,
  getFirstSlideByStages,
  revokeThumbnailSlideMediaUrls,
  listFolders,
  createFolder,
  renameFolder,
  deleteFolder,
  setStageFolder,
  FolderNameError,
  type DeleteFolderMode,
} from '@/lib/utils/stage-storage';
import type { FolderRecord } from '@/lib/utils/database';
import { displayNameWidth, FOLDER_NAME_MAX_WIDTH } from '@/lib/utils/folder-name-validation';
import { FolderCard } from '@/components/discovery/folder-card';
import { NewFolderDialog } from '@/components/discovery/folder-dialogs';
import { MoveToFolderMenu } from '@/components/discovery/move-to-folder-menu';
import { SlideThumbnail } from '@/components/slide-renderer/SlideThumbnail';
import type { Slide } from '@openmaic/dsl';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { toast } from 'sonner';
import { isOwnerListingAuthFailure } from '@/lib/utils/owner-listing-error';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useDraftCache } from '@/lib/hooks/use-draft-cache';
import { SpeechButton } from '@/components/audio/speech-button';
import { useImportClassroom } from '@/lib/import/use-import-classroom';
import { isPptxImportEnabled, shouldShowVocationalTestUi } from '@/lib/config/feature-flags';
import { useImportPptx } from '@/lib/import/use-import-pptx';
import { InteractiveModeButton } from '@/components/generation/interactive-mode-button';
import { arrivedByProSwap } from '@/lib/workbench/pro-swap';

const log = createLogger('Home');

const WEB_SEARCH_STORAGE_KEY = 'webSearchEnabled';
const RECENT_OPEN_STORAGE_KEY = 'recentClassroomsOpen';
const INTERACTIVE_MODE_STORAGE_KEY = 'interactiveModeEnabled';

// PPTX import is still scaffolding: `useImportPptx` has no `onImported` consumer
// yet, so the flow only logs the parsed slides. Hide the entry point behind a
// flag until it's wired end-to-end, so the UI doesn't expose a no-op button.
const PPTX_IMPORT_ENABLED = isPptxImportEnabled();

interface FormState {
  courseMaterials: SelectedCourseMaterial[];
  requirement: string;
  webSearch: boolean;
  interactiveMode: boolean;
  vocationalTestMode: boolean;
}

const initialFormState: FormState = {
  courseMaterials: [],
  requirement: '',
  webSearch: false,
  interactiveMode: false,
  vocationalTestMode: false,
};

function HomePage() {
  const { t } = useI18n();
  const router = useRouter();
  // Do not replay the classic hero's entrance after the route handoff already
  // carried the lockup and composer into place.
  const [swapped] = useState(arrivedByProSwap);
  const heroEnter = (from: Record<string, number>) => (swapped ? false : from);
  const showVocationalTestUi = shouldShowVocationalTestUi();
  const [form, setForm] = useState<FormState>(initialFormState);
  const studyTarget = useStudyGenerationTarget();
  // Parsed study-library materials chosen as course material (learning plan B02).
  const [studyMaterials, setStudyMaterials] = useState<StudyMaterialSelection[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<
    import('@/lib/types/settings').SettingsSection | undefined
  >(undefined);
  const settingsReturnFocusTargetRef = useRef<HTMLElement | null>(null);

  // Draft cache for requirement text
  const { cachedValue: cachedRequirement, updateCache: updateRequirementCache } =
    useDraftCache<string>({ key: 'requirementDraft' });

  // A usable LLM provider exists ⇒ a concrete model is always selected (#580
  // invariant). Gate generation on this single condition (state A vs B)
  // instead of inspecting modelId directly.
  const providersConfig = useSettingsStore((s) => s.providersConfig);
  const platformDefaults = useSettingsStore((s) => s.platformDefaults);
  const llmSelection = useSettingsStore((s) => s.llmSelection);
  const hasUsableProvider = hasUsableLLMSelection(providersConfig, platformDefaults, llmSelection);
  const [recentOpen, setRecentOpen] = useState(true);
  const persistRecentOpen = (next: boolean) => {
    setRecentOpen(next);
    try {
      localStorage.setItem(RECENT_OPEN_STORAGE_KEY, String(next));
    } catch {
      /* ignore */
    }
  };

  // Hydrate client-only state after mount (avoids SSR mismatch)
  useEffect(() => {
    try {
      const saved = localStorage.getItem(RECENT_OPEN_STORAGE_KEY);
      if (saved !== null) setRecentOpen(saved !== 'false');
    } catch {
      /* localStorage unavailable */
    }
    try {
      const savedWebSearch = localStorage.getItem(WEB_SEARCH_STORAGE_KEY);
      const savedInteractiveMode = localStorage.getItem(INTERACTIVE_MODE_STORAGE_KEY);
      const updates: Partial<FormState> = {};
      if (savedWebSearch === 'true') updates.webSearch = true;
      if (savedInteractiveMode === 'true') updates.interactiveMode = true;
      if (Object.keys(updates).length > 0) {
        setForm((prev) => ({ ...prev, ...updates }));
      }
    } catch {
      /* localStorage unavailable */
    }
  }, []);

  // Restore requirement draft from localStorage on mount. The previous derived-state
  // pattern initialised `prev` from the cached value itself, so on the first client
  // render the comparison was always equal and the restore never fired. Use an effect
  // so the cache is hydrated into the form once we know the live requirement is empty.
  const draftRestoredRef = useRef(false);
  useEffect(() => {
    if (draftRestoredRef.current) return;
    if (!cachedRequirement) return;
    draftRestoredRef.current = true;
    setForm((prev) => (prev.requirement ? prev : { ...prev, requirement: cachedRequirement }));
  }, [cachedRequirement]);

  // A course explanation of a wrong question (B13) brings its requirement (editable).
  const explanationRequirement = studyTarget.target?.explanation?.requirement ?? '';
  useEffect(() => {
    if (!explanationRequirement) return;
    draftRestoredRef.current = true;
    setForm((prev) => ({ ...prev, requirement: explanationRequirement }));
  }, [explanationRequirement]);

  const [error, setError] = useState<string | null>(null);
  // True while the Generate click drains upload-time ingests and builds the
  // generation session. Doubles as the guard flag that freezes the course
  // material set for the duration of prep and as the switch that disables the
  // toolbar's add/remove affordances, so the session is always built from a
  // set that cannot change under it.
  const [preparingGenerate, setPreparingGenerate] = useState(false);
  const [classrooms, setClassrooms] = useState<StageListItem[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, Slide>>({});
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Course folders — device-local grouping. `currentFolderId === undefined`
  // is the root view (folders + unfiled courses); a folder id navigates into
  // that folder's course list. Searching flattens every course regardless of
  // folder and annotates each with its folder name.
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  // True once the initial classroom + folder loads resolve. Guards layout
  // selection so the hero does not flip between full-screen and compact as the
  // two async reads land (avoids a visible layout shift on first paint).
  const [hydrated, setHydrated] = useState(false);
  const [currentFolderId, setCurrentFolderId] = useState<string | undefined>(undefined);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  // When set, the new-folder dialog is creating a folder AND moving this course
  // into it (entered via the move-menu's "new folder" entry).
  const [createAndMoveTarget, setCreateAndMoveTarget] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // The shell's "new course" entry links to /#create: bring the composer into
  // view and put the cursor in it, also when Home is already open.
  useEffect(() => {
    const focusComposer = () => {
      if (window.location.hash !== '#create') return;
      textareaRef.current?.focus({ preventScroll: true });
      document.getElementById('create')?.scrollIntoView({ block: 'start' });
    };
    focusComposer();
    window.addEventListener('hashchange', focusComposer);
    return () => window.removeEventListener('hashchange', focusComposer);
  }, []);
  const thumbnailsRef = useRef<Record<string, Slide>>({});
  const classroomLoadEpochRef = useRef(0);

  const replaceThumbnails = (slides: Record<string, Slide>) => {
    const previous = thumbnailsRef.current;
    thumbnailsRef.current = slides;
    setThumbnails(slides);
    window.setTimeout(() => revokeThumbnailSlideMediaUrls(previous), 0);
  };

  const loadClassrooms = async () => {
    const epoch = ++classroomLoadEpochRef.current;
    const isCurrent = () => classroomLoadEpochRef.current === epoch;
    try {
      const list = await listStages();
      if (!isCurrent()) return;
      setClassrooms(list);
      // Covers are optional background work. Do not hold library hydration or
      // keep starting network requests after navigation/account replacement.
      if (list.length > 0) {
        void getFirstSlideByStages(
          list.map((c) => c.id),
          { shouldContinue: isCurrent },
        ).then((slides) => {
          if (isCurrent()) replaceThumbnails(slides);
          else revokeThumbnailSlideMediaUrls(slides);
        });
      } else {
        replaceThumbnails({});
      }
    } catch (err) {
      if (!isCurrent()) return;
      log.error('Failed to load classrooms:', err);
      if (!isOwnerListingAuthFailure(err)) {
        toast.error('Persistence is unavailable. Saved classrooms could not be loaded.');
      }
    }
  };

  const loadFolders = async () => {
    try {
      setFolders(await listFolders());
    } catch (err) {
      log.error('Failed to load folders:', err);
    }
  };

  // Capture the active folder when an import starts so the imported course
  // lands in that folder, not whichever folder is active when the async import
  // resolves (the user may have navigated away in the meantime).
  const importFolderRef = useRef<string | undefined>(undefined);
  const handleImportSuccess = async (importedStageId: string) => {
    const folderId = importFolderRef.current;
    importFolderRef.current = undefined;
    // File the imported course into the folder that was active when the
    // import began, before refreshing the list so the card appears in place.
    if (folderId) {
      try {
        await setStageFolder(importedStageId, folderId);
      } catch (err) {
        log.error('Failed to assign imported course to folder:', err);
        toast.error(t('classroom.moveFailed'));
      }
    }
    await loadClassrooms();
  };
  const { importing, fileInputRef, triggerFileSelect, handleFileChange } =
    useImportClassroom(handleImportSuccess);
  const triggerImport = () => {
    importFolderRef.current = currentFolderId;
    triggerFileSelect();
  };

  const {
    importing: pptxImporting,
    fileInputRef: pptxFileInputRef,
    triggerFileSelect: triggerPptxFileSelect,
    handleFileChange: handlePptxFileChange,
  } = useImportPptx();

  // Mount and account changes reload the library with the latest loaders.
  const refreshLibrary = useEffectEvent(() => Promise.all([loadClassrooms(), loadFolders()]));

  useEffect(() => {
    // Clear stale media store to prevent cross-course thumbnail contamination.
    // The store may hold tasks from a previously visited classroom whose elementIds
    // (gen_img_1, etc.) collide with other courses' placeholders.
    useMediaGenerationStore.getState().revokeObjectUrls();
    useMediaGenerationStore.setState({ tasks: {} });

    // Read sessionStorage on the client only (avoids SSR hydration mismatch).
    // Both reads resolve before flipping `hydrated`, so the hero layout does
    // not thrash as each lands independently.
    void refreshLibrary().finally(() => setHydrated(true));
    const onAuthChange = () => {
      void refreshLibrary();
    };
    window.addEventListener('auth-change', onAuthChange);

    return () => {
      classroomLoadEpochRef.current += 1;
      window.removeEventListener('auth-change', onAuthChange);
      revokeThumbnailSlideMediaUrls(thumbnailsRef.current);
      thumbnailsRef.current = {};
    };
  }, []);

  const handleDelete = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setPendingDeleteId(id);
  };

  const confirmDelete = async (id: string) => {
    setPendingDeleteId(null);
    try {
      await deleteStageData(id);
      await loadClassrooms();
    } catch (err) {
      log.error('Failed to delete classroom:', err);
      toast.error('Failed to delete classroom');
    }
  };

  const handleRename = async (id: string, newName: string) => {
    try {
      await renameStage(id, newName);
      setClassrooms((prev) => prev.map((c) => (c.id === id ? { ...c, name: newName } : c)));
    } catch (err) {
      log.error('Failed to rename classroom:', err);
      toast.error(t('classroom.renameFailed'));
    }
  };

  // ─── Folder handlers ────────────────────────────────────────────────
  const handleCreateFolder = async (name: string) => {
    const folder = await createFolder(name);
    setFolders((prev) => [...prev, folder]);
    // If this create came from the move-menu's "new folder" entry, move the
    // requesting course into the freshly created folder.
    if (createAndMoveTarget) {
      await handleMoveCourse(createAndMoveTarget, folder.id);
      setCreateAndMoveTarget(null);
    }
  };

  const handleRenameFolder =
    (folder: FolderRecord) =>
    async (newName: string): Promise<string | null> => {
      // Empty or unchanged input just exits editing without an error.
      const trimmed = newName.trim();
      if (!trimmed || trimmed === folder.name) return null;
      try {
        await renameFolder(folder.id, newName);
        setFolders((prev) => prev.map((f) => (f.id === folder.id ? { ...f, name: trimmed } : f)));
        return null;
      } catch (err) {
        if (err instanceof FolderNameError) {
          if (err.kind === 'duplicate') return t('classroom.folderNameExists');
          if (err.kind === 'tooLong')
            return t('classroom.folderWidth', {
              width: displayNameWidth(trimmed),
              max: FOLDER_NAME_MAX_WIDTH,
            });
          return t('classroom.folderNameHint');
        }
        log.error('Failed to rename folder:', err);
        return t('classroom.folderRenameFailed');
      }
    };

  const confirmDeleteFolder = async (folder: FolderRecord, mode: DeleteFolderMode) => {
    try {
      await deleteFolder(folder.id, mode);
      if (currentFolderId === folder.id) setCurrentFolderId(undefined);
    } catch (err) {
      log.error('Failed to delete folder:', err);
      toast.error(t('classroom.folderDeleteFailed'));
    } finally {
      // Always refresh authoritative state: in 'remove' mode a partial failure
      // may have durably deleted some courses before throwing, and the UI must
      // reflect that rather than leaving stale cards/counts behind.
      await Promise.all([loadFolders(), loadClassrooms()]);
    }
  };

  const handleMoveCourse = async (stageId: string, folderId: string | undefined) => {
    // Optimistic update for snappy UI; the persistence call follows.
    setClassrooms((prev) => prev.map((c) => (c.id === stageId ? { ...c, folderId } : c)));
    try {
      await setStageFolder(stageId, folderId);
    } catch (err) {
      log.error('Failed to move course:', err);
      toast.error(t('classroom.moveFailed'));
      // Revert on failure.
      await loadClassrooms();
    }
  };

  // From the move-menu's "new folder" entry: remember the course, then open the
  // folder dialog. The actual create+move happens in handleCreateFolder once the
  // name is confirmed. (A Radix DropdownMenu is modal, so the name input cannot
  // live inside it; the dialog is the focus surface.)
  const handleCreateAndMove = (stageId: string) => () => {
    setCreateAndMoveTarget(stageId);
    setNewFolderOpen(true);
  };

  const deferredSearchQuery = useDeferredValue(searchQuery);
  const filteredClassrooms = useMemo(() => {
    const q = deferredSearchQuery.trim().toLowerCase();
    if (!q) return classrooms;
    return classrooms.filter((c) => {
      const name = c.name?.toLowerCase() ?? '';
      const desc = c.description?.toLowerCase() ?? '';
      return name.includes(q) || desc.includes(q);
    });
  }, [classrooms, deferredSearchQuery]);

  // Folder-aware view model. Searching collapses the hierarchy: every matching
  // course is shown flat, annotated with its folder name. Otherwise the root
  // view shows folder tiles + unfiled courses, and a folder view shows only
  // that folder's members.
  const folderNameById = useMemo(() => new Map(folders.map((f) => [f.id, f.name])), [folders]);
  const isSearching = deferredSearchQuery.trim().length > 0;
  // The course tiles rendered in the active view: search flattens everything;
  // a folder shows only its members; the root shows unfiled courses (folder
  // tiles are rendered separately above them).
  const visibleClassrooms = useMemo(() => {
    if (isSearching) return filteredClassrooms;
    if (currentFolderId) return filteredClassrooms.filter((c) => c.folderId === currentFolderId);
    return filteredClassrooms.filter(
      (c) => c.folderId === undefined || !folderNameById.has(c.folderId),
    );
  }, [filteredClassrooms, isSearching, currentFolderId, folderNameById]);
  const currentFolderClassrooms = useMemo(
    () => (currentFolderId ? classrooms.filter((c) => c.folderId === currentFolderId) : []),
    [classrooms, currentFolderId],
  );
  const courseCountByFolder = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of classrooms) {
      if (c.folderId) counts.set(c.folderId, (counts.get(c.folderId) ?? 0) + 1);
    }
    return counts;
  }, [classrooms]);
  // Up to 3 member course covers (first-slide thumbnails) per folder, for the
  // folder tile's cover stack. Members are ordered by updatedAt desc so the
  // frontmost cover is the most recently touched course.
  const coverSlidesByFolder = useMemo(() => {
    const byFolder = new Map<string, Slide[]>();
    for (const c of [...classrooms].sort((a, b) => b.updatedAt - a.updatedAt)) {
      if (!c.folderId) continue;
      const slide = thumbnails[c.id];
      if (!slide) continue;
      const list = byFolder.get(c.folderId) ?? [];
      if (list.length < 3) list.push(slide);
      byFolder.set(c.folderId, list);
    }
    return byFolder;
  }, [classrooms, thumbnails]);
  const currentFolder = folders.find((f) => f.id === currentFolderId);

  const updateForm = <K extends keyof FormState>(field: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    try {
      if (field === 'webSearch') localStorage.setItem(WEB_SEARCH_STORAGE_KEY, String(value));
      if (field === 'interactiveMode')
        localStorage.setItem(INTERACTIVE_MODE_STORAGE_KEY, String(value));
      if (field === 'requirement') updateRequirementCache(value as string);
    } catch {
      /* ignore */
    }
  };

  const addCourseMaterials = (files: File[]) => {
    // The set is frozen for the duration of generate-prep: adding is inert
    // while `preparingGenerate` is set (the toolbar affordance is disabled
    // via the same state), so nothing can slip into the set mid-prep.
    if (preparingGenerate) return;
    const dedupedFiles = dedupeCourseMaterialFiles(form.courseMaterials, files);
    const startOrder = form.courseMaterials.length + 1;
    const additions = dedupedFiles.map((file, index) => ({
      id: nanoid(8),
      file,
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
      type: file.type,
      order: startOrder + index,
    }));

    if (additions.length === 0) return;
    setForm((prev) => {
      // Pure updater: drop any addition the latest state already carries — by
      // id (a replayed or superseded update) or by content fingerprint (two
      // addCourseMaterials calls in one render batch both dedupe against the
      // same stale closure list, so the same file could otherwise enter twice
      // under two ids and ingest/extract twice) — then append the rest.
      const missing = additions.filter((addition) => {
        if (prev.courseMaterials.some((item) => item.id === addition.id)) return false;
        return !prev.courseMaterials.some(
          (item) => courseMaterialFingerprint(item) === courseMaterialFingerprint(addition),
        );
      });
      if (missing.length === 0) return prev;
      return { ...prev, courseMaterials: [...prev.courseMaterials, ...missing] };
    });
  };

  const removeCourseMaterial = (id: string) => {
    // The set is frozen for the duration of generate-prep: removing is inert
    // while `preparingGenerate` is set (the toolbar affordance is disabled
    // via the same state), so nothing can slip out of the set mid-prep.
    if (preparingGenerate) return;
    setForm((prev) => ({
      ...prev,
      courseMaterials: prev.courseMaterials
        .filter((item) => item.id !== id)
        .map((item, index) => ({ ...item, order: index + 1 })),
    }));
  };

  const handleGenerate = async () => {
    // No model/provider guard here: generation is gated by `canGenerate`
    // (requires a usable provider), and under the #580 invariant a usable
    // provider always has a concrete model. State A (no usable provider)
    // surfaces through the toolbar's single Configure-Provider affordance.
    if (preparingGenerate) return;
    if (!form.requirement.trim()) {
      setError(t('upload.requirementRequired'));
      return;
    }

    setError(null);

    // The material list and the extractor provider config are frozen for the
    // duration of prep: `preparingGenerate` makes add/remove inert and
    // disables the toolbar affordances (including the extractor Select and the
    // web-search toggle), so neither can change under the session build below.
    // Capture both at click time and build the session from this snapshot,
    // never from live form state or live store state.
    const frozenMaterials = [...form.courseMaterials].sort((a, b) => a.order - b.order);
    const settingsSnapshot = useSettingsStore.getState();
    const frozenPdfProviderId = settingsSnapshot.pdfProviderId;
    const frozenPdfProviderConfig = settingsSnapshot.pdfProvidersConfig?.[
      settingsSnapshot.pdfProviderId
    ]
      ? {
          apiKey: settingsSnapshot.pdfProvidersConfig[settingsSnapshot.pdfProviderId].apiKey,
          baseUrl: settingsSnapshot.pdfProvidersConfig[settingsSnapshot.pdfProviderId].baseUrl,
          accessKeyId:
            settingsSnapshot.pdfProvidersConfig[settingsSnapshot.pdfProviderId].accessKeyId,
          accessKeySecret:
            settingsSnapshot.pdfProvidersConfig[settingsSnapshot.pdfProviderId].accessKeySecret,
        }
      : undefined;

    // Flip the generating UI state before material bytes are copied locally.
    setPreparingGenerate(true);
    // Library images copied into the browser image store; released on failure.
    let studyImageIds: string[] = [];
    try {
      const userProfile = useUserProfileStore.getState();
      const requirements: UserRequirements = {
        requirement: form.requirement,
        userNickname: userProfile.nickname || undefined,
        userBio: userProfile.bio || undefined,
        webSearch: form.webSearch || undefined,
        interactiveMode: form.vocationalTestMode ? true : form.interactiveMode,
        ...(form.vocationalTestMode ? { taskEngineMode: true } : {}),
      };

      let documentSources: SessionDocumentSource[] | undefined;
      let pdfProviderId: string | undefined;
      let pdfProviderConfig:
        | { apiKey?: string; baseUrl?: string; accessKeyId?: string; accessKeySecret?: string }
        | undefined;

      if (frozenMaterials.length > 0) {
        // The session is built from the click-time snapshot (frozen above),
        // never from live store state.
        pdfProviderId = frozenPdfProviderId;
        pdfProviderConfig = frozenPdfProviderConfig;

        const storedDocumentKeys: string[] = [];
        try {
          documentSources = [];
          for (const [index, item] of frozenMaterials.entries()) {
            const storageKey = await storeDocumentBlob(item.file);
            storedDocumentKeys.push(storageKey);
            documentSources.push({
              id: item.id,
              name: item.name,
              size: item.size,
              lastModified: item.lastModified,
              mimeType: normalizeDocumentMimeType({
                mimeType: item.file.type,
                fileName: item.file.name,
              }),
              order: index + 1,
              storageKey,
              providerId: pdfProviderId,
            });
          }
        } catch (error) {
          await Promise.allSettled(storedDocumentKeys.map((key) => deleteDocumentBlob(key)));
          throw error;
        }
      }

      // Library materials reuse their stored parse: the text goes straight
      // into the session and the extracted images into the same browser image
      // store a direct upload uses, so neither generation path extracts anything.
      let studyText = '';
      let studyImages: PdfImage[] = [];
      if (!documentSources?.length && studyTarget.target && studyMaterials.length > 0) {
        let input: Awaited<ReturnType<typeof studyMaterialsGenerationInput>>;
        try {
          input = await studyMaterialsGenerationInput(studyMaterials);
        } catch {
          throw new Error(t('study.materials.generation.loadFailed'));
        }
        studyText = input.text;
        if (input.images.length > 0) {
          try {
            studyImageIds = await storeImages(input.images);
            studyImages = input.images.map((image, index) => ({
              id: image.id,
              src: '',
              pageNumber: image.pageNumber,
              description: image.description,
              width: image.width,
              height: image.height,
              originalId: image.originalId,
              sourceDocumentId: image.sourceDocumentId,
              sourceDocumentName: image.sourceDocumentName,
              sourceDocumentOrder: image.sourceDocumentOrder,
              visionPriority: image.visionPriority,
              storageId: studyImageIds[index],
            }));
          } catch (error) {
            // Images enrich the course; without browser storage it is text-only.
            log.warn('Library images unavailable for generation:', error);
            studyImageIds = [];
          }
        }
      }

      const sessionState = {
        sessionId: nanoid(),
        requirements,
        pdfText: studyText,
        pdfImages: studyImages,
        imageStorageIds: studyImageIds,
        documentSources,
        // Backward-compatible single-document fields for previously saved sessions.
        pdfStorageKey: documentSources?.[0]?.storageKey,
        pdfFileName: documentSources?.[0]?.name,
        documentMimeType: documentSources?.[0]?.mimeType,
        pdfProviderId,
        pdfProviderConfig,
        sceneOutlines: null,
        currentStep: 'generating' as const,
        ...(studyTarget.target ? { studySpaceId: studyTarget.target.id } : {}),
        // B13: the course of a wrong-question explanation, with only the media ticked there.
        ...(studyTarget.target?.explanation
          ? {
              studyExplanationId: studyTarget.target.explanation.id,
              mediaChoice: studyTarget.target.explanation.media,
            }
          : {}),
        ...(studyText
          ? {
              studyMaterialVersions: studyMaterials.map(({ materialId, versionId }) => ({
                materialId,
                versionId,
              })),
            }
          : {}),
      };
      sessionStorage.setItem('generationSession', JSON.stringify(sessionState));

      router.push('/generation-preview');
    } catch (err) {
      if (studyImageIds.length > 0) void deleteStoredImages(studyImageIds).catch(() => undefined);
      log.error('Error preparing generation:', err);
      setError(err instanceof Error ? err.message : t('upload.generateFailed'));
    } finally {
      // Unfreeze the set once prep settles (navigation unmounts this page, so
      // this is normally a no-op on the way out).
      setPreparingGenerate(false);
    }
  };

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffTime = Math.abs(now.getTime() - date.getTime());
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return t('classroom.today');
    if (diffDays === 1) return t('classroom.yesterday');
    if (diffDays < 7) return `${diffDays} ${t('classroom.daysAgo')}`;
    return date.toLocaleDateString();
  };

  const canGenerate = !!form.requirement.trim() && hasUsableProvider;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (canGenerate && !preparingGenerate) handleGenerate();
    }
  };

  return (
    <AppShell>
      <div className="relative w-full overflow-x-hidden px-4 pb-12 pt-6 text-foreground md:px-8 md:pt-10">
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip"
          onChange={handleFileChange}
          className="hidden"
        />
        {PPTX_IMPORT_ENABLED && (
          <input
            ref={pptxFileInputRef}
            type="file"
            accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
            onChange={handlePptxFileChange}
            className="hidden"
          />
        )}
        <SettingsDialog
          open={settingsOpen}
          onOpenChange={(open) => {
            setSettingsOpen(open);
            if (!open) setSettingsSection(undefined);
          }}
          initialSection={settingsSection}
          returnFocusTargetRef={settingsReturnFocusTargetRef}
        />

        {/* ═══ Learning home: product promise + creation card ═══ */}
        <motion.main
          initial={heroEnter({ opacity: 0, y: 20 })}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: 'easeOut' }}
          className="relative z-20 mx-auto w-full max-w-6xl"
        >
          <HomeGreeting />

          <section id="create" aria-label={t('shell.newCourse')} className="scroll-mt-20">
            <div
              data-testid="zhiyu-home-create-card"
              data-pro-morph="composer"
              className="w-full rounded-3xl bg-card shadow-feature transition-shadow focus-within:shadow-[0_0_0_1.5px_var(--primary),0_5px_0_var(--primary)]"
            >
              {/* ── What to learn + who joins the class ── */}
              <div className="relative z-20 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-5 pt-4">
                <label
                  htmlFor="home-requirement"
                  className="text-sm font-semibold text-muted-foreground"
                >
                  {t('home.composerLabel')}
                </label>
                <div className="min-w-0 max-w-full shrink">
                  <AgentBar />
                </div>
              </div>

              {studyTarget.target ? (
                <>
                  <StudyGenerationTargetBanner
                    target={studyTarget.target}
                    onClear={() => {
                      setStudyMaterials([]);
                      studyTarget.clear();
                    }}
                  />
                  <GenerationMaterialPicker
                    spaceId={studyTarget.target.id}
                    selected={studyMaterials}
                    onChange={setStudyMaterials}
                    disabled={form.courseMaterials.length > 0}
                  />
                </>
              ) : null}

              {/* Textarea */}
              <textarea
                id="home-requirement"
                ref={textareaRef}
                placeholder={t('upload.requirementPlaceholder')}
                className="min-h-[180px] max-h-[420px] w-full resize-none border-0 bg-transparent px-5 pb-4 pt-3 text-base leading-relaxed placeholder:text-subtle-foreground focus:outline-none md:min-h-[240px] md:text-[17px]"
                value={form.requirement}
                onChange={(e) => updateForm('requirement', e.target.value)}
                onKeyDown={handleKeyDown}
                rows={4}
              />

              {/* Toolbar row */}
              <div className="flex flex-wrap items-center gap-2 border-t border-border/70 px-4 py-3">
                <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
                  <GenerationToolbar
                    webSearch={form.webSearch}
                    onWebSearchChange={(v) => updateForm('webSearch', v)}
                    onSettingsOpen={(section, returnFocusTarget) => {
                      settingsReturnFocusTargetRef.current = returnFocusTarget ?? null;
                      setSettingsSection(section);
                      setSettingsOpen(true);
                    }}
                    courseMaterials={form.courseMaterials}
                    onCourseMaterialsAdd={addCourseMaterials}
                    onCourseMaterialRemove={removeCourseMaterial}
                    onPdfError={setError}
                    materialsLocked={preparingGenerate || studyMaterials.length > 0}
                  />
                </div>

                <div className="ml-auto flex shrink-0 items-center gap-2">
                  {/* Interactive mode toggle */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <InteractiveModeButton
                        pressed={form.interactiveMode}
                        label={t('toolbar.interactiveModeLabel')}
                        onPressedChange={(pressed) => updateForm('interactiveMode', pressed)}
                      />
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-xs">
                      {t('toolbar.interactiveModeHint')}
                    </TooltipContent>
                  </Tooltip>

                  {/* Voice input */}
                  <SpeechButton
                    size="md"
                    onTranscription={(text) => {
                      setForm((prev) => {
                        const next = prev.requirement + (prev.requirement ? ' ' : '') + text;
                        updateRequirementCache(next);
                        return { ...prev, requirement: next };
                      });
                    }}
                  />

                  {/* Send button */}
                  <button
                    onClick={handleGenerate}
                    disabled={!canGenerate || preparingGenerate}
                    className={cn(
                      'flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-md px-4 transition-[background-color,translate,box-shadow]',
                      canGenerate && !preparingGenerate
                        ? 'cursor-pointer bg-primary text-primary-foreground shadow-edge-primary hover:bg-primary-hover active:translate-y-0.5 active:shadow-none'
                        : 'cursor-not-allowed bg-muted text-subtle-foreground',
                    )}
                  >
                    <span className="text-[13px] font-semibold">
                      {preparingGenerate ? t('stage.generating') : t('toolbar.enterClassroom')}
                    </span>
                    {preparingGenerate ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <ArrowUp className="size-3.5" />
                    )}
                  </button>
                </div>
              </div>
            </div>
          </section>

          <HomeStudyOverview />

          {hydrated && classrooms.length === 0 && folders.length === 0 && (
            <ol aria-label={t('home.stepsTitle')} className="mt-5 grid gap-2.5 sm:grid-cols-3">
              {([1, 2, 3] as const).map((n) => (
                <li
                  key={n}
                  className="flex items-start gap-3 rounded-xl bg-card px-4 py-3 shadow-flat"
                >
                  <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
                    {n}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm font-semibold text-foreground">
                      {t(`home.step${n}Title`)}
                    </span>
                    <span className="text-[13px] leading-5 text-muted-foreground">
                      {t(`home.step${n}Desc`)}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          )}

          <section aria-labelledby="home-try-title" className="mt-8">
            <h2 id="home-try-title" className="mb-3 text-[17px] font-semibold text-foreground">
              {t('home.tryTitle')}
            </h2>
            <div className="grid gap-3 sm:grid-cols-3">
              {([1, 2, 3] as const).map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => {
                    updateForm('requirement', t(`home.example${n}Prompt`));
                    textareaRef.current?.focus();
                  }}
                  className="flex flex-col gap-1 rounded-xl bg-card px-4 py-3.5 text-left sticker"
                >
                  <span className="text-[15px] font-semibold text-foreground">
                    {t(`home.example${n}Title`)}
                  </span>
                  <span className="text-[13px] text-muted-foreground">
                    {t(`home.example${n}Meta`)}
                  </span>
                </button>
              ))}
            </div>
          </section>

          {showVocationalTestUi && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.4 }}
              className="mt-2 flex w-full justify-start px-1"
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={form.vocationalTestMode}
                    onClick={() => updateForm('vocationalTestMode', !form.vocationalTestMode)}
                    className={cn(
                      'inline-flex h-7 items-center gap-2 rounded-full border px-2.5 text-[11px] font-medium transition-colors',
                      form.vocationalTestMode
                        ? 'border-primary/50 bg-primary/10 text-primary shadow-sm'
                        : 'border-border/70 bg-background/70 text-muted-foreground hover:border-primary/40 hover:text-primary',
                    )}
                  >
                    <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-normal text-primary">
                      测试功能
                    </span>
                    <Sparkles className="size-3.5" />
                    <span>职教任务</span>
                    <span
                      className={cn(
                        'relative h-3.5 w-6 rounded-full transition-colors',
                        form.vocationalTestMode ? 'bg-primary' : 'bg-muted-foreground/25',
                      )}
                    >
                      <span
                        className={cn(
                          'absolute left-0.5 top-0.5 size-2.5 rounded-full bg-white transition-transform',
                          form.vocationalTestMode ? 'translate-x-2.5' : 'translate-x-0',
                        )}
                      />
                    </span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  从当前输入框提交职教实操训练测试
                </TooltipContent>
              </Tooltip>
            </motion.div>
          )}

          {/* ── Error ── */}
          <AnimatePresence>
            {error && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="mt-3 w-full p-3 bg-destructive/10 border border-destructive/20 rounded-lg"
              >
                <p className="text-sm text-destructive">{error}</p>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.main>

        {/* ═══ Recent classrooms — collapsible ═══ */}
        {/* The library action bar is always present after hydration: it carries
          the New-folder / import / search actions, so a brand-new user with
          zero courses and zero folders can still create the first folder or
          import. One stable action surface across root, folder, and empty. */}
        {hydrated && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.5 }}
            id="library"
            className="relative z-10 mx-auto mt-10 flex w-full max-w-6xl scroll-mt-20 flex-col items-start"
          >
            {/* Trigger — divider-line with centered text. Fixed height keeps the
              bar geometrically stable when the New-folder action or the folder
              path appears/disappears (entering vs leaving a folder). */}
            <div className="w-full flex items-center gap-4 h-9">
              <div className="flex min-w-0 flex-1 items-center gap-3 text-[13px] text-muted-foreground select-none">
                <button
                  onClick={() => {
                    if (currentFolderId) setCurrentFolderId(undefined);
                    else persistRecentOpen(!recentOpen);
                  }}
                  className="mr-auto flex min-w-0 items-center gap-2 text-[17px] font-semibold text-foreground transition-colors hover:text-primary cursor-pointer"
                >
                  <Clock className="size-4 text-muted-foreground" />
                  {t('classroom.recentClassrooms')}
                  {currentFolder && (
                    <>
                      <ChevronRight className="size-3 opacity-40" />
                      <span className="text-foreground truncate max-w-[160px]">
                        {currentFolder.name}
                      </span>
                    </>
                  )}
                  <span className="text-[12px] font-normal tabular-nums text-muted-foreground">
                    {currentFolder ? currentFolderClassrooms.length : classrooms.length}
                  </span>
                  <motion.div
                    animate={{ rotate: recentOpen ? 180 : 0 }}
                    transition={{ duration: 0.3, ease: 'easeInOut' }}
                  >
                    <ChevronDown className="size-3.5" />
                  </motion.div>
                </button>

                {/* Search toggle — icon that expands into an input in place */}
                <AnimatePresence initial={false}>
                  {!searchOpen ? (
                    <motion.button
                      key="search-icon"
                      ref={searchButtonRef}
                      type="button"
                      aria-label={t('classroom.searchAriaLabel')}
                      onClick={() => {
                        setSearchOpen(true);
                        if (!recentOpen) persistRecentOpen(true);
                        requestAnimationFrame(() => searchInputRef.current?.focus());
                      }}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.12, ease: 'easeOut' }}
                      className="flex items-center justify-center size-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
                    >
                      <Search className="size-3.5" />
                    </motion.button>
                  ) : (
                    <motion.div
                      key="search-input"
                      initial={{ opacity: 0, width: 0 }}
                      animate={{ opacity: 1, width: 200 }}
                      exit={{ opacity: 0, width: 0 }}
                      transition={{ duration: 0.18, ease: [0.25, 0.1, 0.25, 1] }}
                      className="overflow-hidden"
                    >
                      <InputGroup
                        className={cn(
                          'h-7 text-[12px] rounded-full bg-muted/40 border-transparent shadow-none',
                          'transition-colors',
                          'hover:bg-muted/60',
                          'has-[[data-slot=input-group-control]:focus-visible]:bg-muted/60',
                          'has-[[data-slot=input-group-control]:focus-visible]:border-transparent',
                          'has-[[data-slot=input-group-control]:focus-visible]:ring-0',
                        )}
                      >
                        <InputGroupInput
                          ref={searchInputRef}
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') {
                              e.preventDefault();
                              if (searchQuery) {
                                setSearchQuery('');
                              } else {
                                setSearchOpen(false);
                                requestAnimationFrame(() => searchButtonRef.current?.focus());
                              }
                            }
                          }}
                          onBlur={() => {
                            if (!searchQuery) {
                              setSearchOpen(false);
                            }
                          }}
                          placeholder={t('classroom.searchPlaceholder')}
                          aria-label={t('classroom.searchAriaLabel')}
                          className="h-7 pl-3 placeholder:text-muted-foreground/50"
                        />
                        {searchQuery && (
                          <InputGroupButton
                            size="icon-xs"
                            aria-label={t('classroom.clearSearch')}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => {
                              setSearchQuery('');
                              searchInputRef.current?.focus();
                            }}
                          >
                            <X />
                          </InputGroupButton>
                        )}
                      </InputGroup>
                    </motion.div>
                  )}
                </AnimatePresence>

                <button
                  onClick={triggerImport}
                  disabled={importing}
                  className="group/import grid grid-cols-[auto_0fr] hover:grid-cols-[auto_1fr] items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-muted-foreground hover:text-foreground hover:bg-muted transition-all duration-200 cursor-pointer"
                >
                  <Upload className="size-3" />
                  <span className="overflow-hidden opacity-0 group-hover/import:opacity-100 transition-opacity duration-200 whitespace-nowrap">
                    {t('import.classroom')}
                  </span>
                </button>
                {PPTX_IMPORT_ENABLED && (
                  <button
                    onClick={triggerPptxFileSelect}
                    disabled={pptxImporting}
                    className="group/import-pptx grid grid-cols-[auto_0fr] hover:grid-cols-[auto_1fr] items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-muted-foreground hover:text-foreground hover:bg-muted transition-all duration-200 cursor-pointer"
                  >
                    <Presentation className="size-3" />
                    <span className="overflow-hidden opacity-0 group-hover/import-pptx:opacity-100 transition-opacity duration-200 whitespace-nowrap">
                      {t('import.pptx')}
                    </span>
                  </button>
                )}
                {/* New folder — round icon button, matches the import/upload affordances. */}
                {!currentFolderId && !isSearching && (
                  <button
                    type="button"
                    onClick={() => {
                      if (!recentOpen) persistRecentOpen(true);
                      setNewFolderOpen(true);
                    }}
                    aria-label={t('classroom.newFolderTitle')}
                    title={t('classroom.newFolderTitle')}
                    className="inline-flex items-center justify-center size-7 rounded-md bg-card text-muted-foreground shadow-edge-outline hover:bg-muted hover:text-foreground transition-[background-color,color,box-shadow] cursor-pointer"
                  >
                    <FolderPlus className="size-3.5" />
                  </button>
                )}
              </div>
            </div>

            {/* Expandable content */}
            <AnimatePresence>
              {recentOpen && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                  className="w-full overflow-hidden"
                >
                  {folders.length === 0 && classrooms.length === 0 ? (
                    <div className="mt-4 rounded-xl px-4 py-8 text-center text-[13px] text-muted-foreground shadow-flat">
                      {t('classroom.emptyLibraryHint')}
                    </div>
                  ) : !isSearching && currentFolderId && currentFolderClassrooms.length === 0 ? (
                    // Empty folder: hint directly below the centered path bar.
                    <div className="pt-8 text-center">
                      <p className="text-[14px] text-muted-foreground">
                        {t('classroom.emptyFolderHint')}
                      </p>
                    </div>
                  ) : isSearching && filteredClassrooms.length === 0 ? (
                    <div className="pt-8 pb-2 text-center text-[13px] text-muted-foreground">
                      {t('classroom.searchEmpty')}
                    </div>
                  ) : (
                    <div className="pt-5">
                      {/* Breadcrumb — shown only while searching (the folder path
                        already lives in the centered header above). */}
                      {isSearching && (
                        <div className="mb-4 flex items-center gap-1.5 text-[13px] text-muted-foreground">
                          <button
                            type="button"
                            onClick={() => {
                              setCurrentFolderId(undefined);
                              setSearchQuery('');
                              setSearchOpen(false);
                            }}
                            className="hover:text-foreground transition-colors"
                          >
                            {t('classroom.recentClassrooms')}
                          </button>
                          <ChevronRight className="size-3.5" />
                          <span className="text-foreground font-medium">
                            {t('classroom.searchResults')}
                          </span>
                          <span className="ml-1.5 text-[12px] text-muted-foreground tabular-nums">
                            ({filteredClassrooms.length})
                          </span>
                        </div>
                      )}

                      <AnimatePresence mode="wait">
                        <motion.div
                          key={
                            isSearching
                              ? 'search'
                              : currentFolderId
                                ? `folder-${currentFolderId}`
                                : 'root'
                          }
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -8 }}
                          transition={{ duration: 0.2 }}
                          className="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4 lg:grid-cols-4"
                        >
                          {/* Root + non-search: render folder tiles first. */}
                          {!isSearching &&
                            currentFolderId === undefined &&
                            folders.map((folder, i) => (
                              <motion.div
                                key={folder.id}
                                initial={{ opacity: 0, y: 16 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ delay: i * 0.04, duration: 0.35, ease: 'easeOut' }}
                              >
                                <FolderCard
                                  folder={folder}
                                  courseCount={courseCountByFolder.get(folder.id) ?? 0}
                                  coverSlides={coverSlidesByFolder.get(folder.id) ?? []}
                                  onOpen={() => setCurrentFolderId(folder.id)}
                                  onRename={handleRenameFolder(folder)}
                                  onDelete={(mode) => confirmDeleteFolder(folder, mode)}
                                  onDropCourse={(stageId) => handleMoveCourse(stageId, folder.id)}
                                />
                              </motion.div>
                            ))}

                          {/* Course tiles for the active view. */}
                          {visibleClassrooms.map((classroom, i) => (
                            <motion.div
                              key={classroom.id}
                              initial={{ opacity: 0, y: 16 }}
                              animate={{ opacity: 1, y: 0 }}
                              transition={{ delay: i * 0.04, duration: 0.35, ease: 'easeOut' }}
                            >
                              <ClassroomCard
                                classroom={classroom}
                                slide={thumbnails[classroom.id]}
                                formatDate={formatDate}
                                onDelete={handleDelete}
                                onRename={handleRename}
                                confirmingDelete={pendingDeleteId === classroom.id}
                                onConfirmDelete={() => confirmDelete(classroom.id)}
                                onCancelDelete={() => setPendingDeleteId(null)}
                                onClick={() => router.push(`/classroom/${classroom.id}`)}
                                overlay={
                                  <>
                                    <MoveToFolderMenu
                                      folders={folders}
                                      currentFolderId={classroom.folderId}
                                      onMove={(folderId) =>
                                        handleMoveCourse(classroom.id, folderId)
                                      }
                                      onCreateAndMove={handleCreateAndMove(classroom.id)}
                                    />
                                    {/* Search view: show the owning folder as a badge. */}
                                    {isSearching && classroom.folderId && (
                                      <span className="absolute bottom-2 left-2 z-10 inline-flex items-center gap-1 rounded-md bg-primary/80 px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground backdrop-blur-sm pointer-events-none">
                                        <Folder className="size-2.5" />
                                        {folderNameById.get(classroom.folderId) ?? ''}
                                      </span>
                                    )}
                                  </>
                                }
                              />
                            </motion.div>
                          ))}
                        </motion.div>
                      </AnimatePresence>
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}

        {/* Folder dialogs — mounted at the top level so they are reachable even
          while the Recent section is collapsed or the course list is empty. */}
        <NewFolderDialog
          open={newFolderOpen}
          onOpenChange={(open) => {
            setNewFolderOpen(open);
            if (!open) setCreateAndMoveTarget(null);
          }}
          folders={folders}
          onCreate={handleCreateFolder}
        />
      </div>
    </AppShell>
  );
}

function ClassroomCard({
  classroom,
  slide,
  formatDate,
  overlay,
  onDelete,
  onRename,
  confirmingDelete,
  onConfirmDelete,
  onCancelDelete,
  onClick,
}: {
  classroom: StageListItem;
  slide?: Slide;
  formatDate: (ts: number) => string;
  /** Extra absolutely-positioned layers over the thumbnail (move menu, badges). */
  overlay?: React.ReactNode;
  onDelete: (id: string, e: React.MouseEvent) => void;
  onRename: (id: string, newName: string) => void;
  confirmingDelete: boolean;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  onClick: () => void;
}) {
  const { t } = useI18n();
  const thumbRef = useRef<HTMLDivElement>(null);
  const [thumbWidth, setThumbWidth] = useState(0);
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = thumbRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setThumbWidth(Math.round(entry.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (editing) nameInputRef.current?.focus();
  }, [editing]);

  const isTaskEngineMode = classroom.taskEngineMode === true;
  const showModeBadge = classroom.interactiveMode || isTaskEngineMode;
  const ModeBadgeIcon = isTaskEngineMode ? Sparkles : Atom;
  const modeBadgeLabel = isTaskEngineMode ? 'Vocational Mode' : t('toolbar.interactiveModeLabel');

  const startRename = (e: React.MouseEvent) => {
    e.stopPropagation();
    setNameDraft(classroom.name);
    setEditing(true);
  };

  const commitRename = () => {
    if (!editing) return;
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== classroom.name) {
      onRename(classroom.id, trimmed);
    }
    setEditing(false);
  };

  return (
    <div
      className="group cursor-pointer overflow-hidden rounded-xl bg-card sticker"
      onClick={confirmingDelete ? undefined : onClick}
      draggable={!confirmingDelete && !editing}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/stage-id', classroom.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragEnd={() => {
        // Notify folder cards to clear any lingering drop highlight (Escape-
        // cancelled drags may not fire dragleave on every target).
        window.dispatchEvent(new CustomEvent('course-drag-end'));
      }}
    >
      {/* Thumbnail — the card's top, divided from the info by a hairline */}
      <div
        ref={thumbRef}
        className="relative w-full aspect-[16/9] overflow-hidden border-b border-border bg-muted"
      >
        {slide && thumbWidth > 0 ? (
          <SlideThumbnail
            slide={slide}
            size={thumbWidth}
            viewportSize={slide.viewportSize ?? 1000}
            viewportRatio={slide.viewportRatio ?? 0.5625}
          />
        ) : !slide ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="flex size-12 items-center justify-center rounded-xl bg-primary-soft text-primary-ink">
              <Presentation className="size-5" />
            </div>
          </div>
        ) : null}

        {showModeBadge && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                aria-label={modeBadgeLabel}
                onClick={(e) => e.stopPropagation()}
                className={cn(
                  'absolute bottom-2 left-2 inline-flex items-center justify-center size-5 rounded-full bg-card/70 backdrop-blur-sm shadow-sm z-10',
                  isTaskEngineMode
                    ? 'text-review-ink ring-1 ring-review/35'
                    : 'text-primary ring-1 ring-primary/30',
                )}
              >
                <ModeBadgeIcon className="size-3" />
              </span>
            </TooltipTrigger>
            {/* Negative sideOffset compensates for the global Tooltip Arrow's
                rotate-45 bounding box, which Radix reserves as spacing. */}
            <TooltipContent
              side="top"
              align="start"
              sideOffset={-4}
              collisionPadding={0}
              className="text-xs"
            >
              {modeBadgeLabel}
            </TooltipContent>
          </Tooltip>
        )}

        {/* Delete — top-right, only on hover */}
        <AnimatePresence>
          {!confirmingDelete && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              <Button
                size="icon"
                variant="ghost"
                className="absolute top-2 right-2 size-7 opacity-0 group-hover:opacity-100 transition-opacity bg-black/30 hover:bg-destructive/80 text-white hover:text-white backdrop-blur-sm rounded-full"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(classroom.id, e);
                }}
              >
                <Trash2 className="size-3.5" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="absolute top-2 right-11 size-7 opacity-0 group-hover:opacity-100 transition-opacity bg-black/30 hover:bg-black/50 text-white hover:text-white backdrop-blur-sm rounded-full"
                onClick={startRename}
              >
                <Pencil className="size-3.5" />
              </Button>
              {overlay}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Inline delete confirmation overlay */}
        <AnimatePresence>
          {confirmingDelete && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/50 backdrop-blur-[6px]"
              onClick={(e) => e.stopPropagation()}
            >
              <span className="text-[13px] font-medium text-white/90">
                {t('classroom.deleteConfirmTitle')}?
              </span>
              <div className="flex gap-2">
                <button
                  className="px-3.5 py-1 rounded-lg text-[12px] font-medium bg-white/15 text-white/80 hover:bg-white/25 backdrop-blur-sm transition-colors"
                  onClick={onCancelDelete}
                >
                  {t('common.cancel')}
                </button>
                <button
                  className="px-3.5 py-1 rounded-lg text-[12px] font-medium bg-mistake/90 text-white hover:bg-mistake transition-colors"
                  onClick={onConfirmDelete}
                >
                  {t('classroom.delete')}
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Info — title first, then pages and date */}
      <div className="flex flex-col gap-1 px-3.5 pb-3 pt-2.5">
        {editing ? (
          <div className="flex-1 min-w-0" onClick={(e) => e.stopPropagation()}>
            <input
              ref={nameInputRef}
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') setEditing(false);
              }}
              onBlur={commitRename}
              maxLength={100}
              placeholder={t('classroom.renamePlaceholder')}
              className="w-full bg-transparent border-b border-primary/60 text-[14px] font-semibold text-foreground outline-none placeholder:text-subtle-foreground"
            />
          </div>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <p
                className="min-w-0 cursor-text truncate text-[14px] font-semibold text-foreground"
                onDoubleClick={startRename}
              >
                {classroom.name}
              </p>
            </TooltipTrigger>
            <TooltipContent
              side="bottom"
              sideOffset={4}
              className="!max-w-[min(90vw,32rem)] break-words whitespace-normal"
            >
              <div className="flex items-center gap-1.5">
                <span className="break-all">{classroom.name}</span>
                <button
                  className="shrink-0 p-0.5 rounded hover:bg-foreground/10 transition-colors"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigator.clipboard.writeText(classroom.name);
                    toast.success(t('classroom.nameCopied'));
                  }}
                >
                  <Copy className="size-3 opacity-60" />
                </button>
              </div>
            </TooltipContent>
          </Tooltip>
        )}
        <span className="text-[12px] tabular-nums text-muted-foreground">
          {classroom.sceneCount} {t('classroom.slides')} · {formatDate(classroom.updatedAt)}
        </span>
      </div>
    </div>
  );
}

export default function Page() {
  return <HomePage />;
}
