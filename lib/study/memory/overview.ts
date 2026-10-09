/**
 * The Memory page's data contract (learning plan B06). Pure types shared by
 * the server service and the page.
 */
import type {
  FactView,
  LearningRecordView,
  MemoryControlView,
  MemorySpaceControlView,
  PreferenceView,
} from '@/lib/study/memory/contracts';
import type { RecentState } from '@/lib/study/memory/recent-state';

export interface MemorySpaceInfo {
  spaceId: string;
  name: string;
  status: 'active' | 'archived';
  goal: string | null;
  examDate: string | null;
}

export interface MemoryOverview {
  controls: { global: MemoryControlView; spaces: MemorySpaceControlView[] };
  spaces: MemorySpaceInfo[];
  preferences: PreferenceView[];
  facts: FactView[];
  records: LearningRecordView[];
  recentState: { all: RecentState; spaces: RecentState[] };
  /** Names for the ids the recent state reports. */
  names: { courses: Record<string, string>; classmates: Record<string, string> };
  /** Preference values the student deleted or declined: never suggested again. */
  suppressedSuggestions: string[];
  sync: { ran: boolean; recorded: number; failed: string[] };
}
