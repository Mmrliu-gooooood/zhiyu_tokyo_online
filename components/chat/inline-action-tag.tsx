'use client';

import { cn } from '@/lib/utils';
import {
  Flashlight,
  MousePointer2,
  Type,
  Shapes,
  Eraser,
  PanelLeftOpen,
  PanelLeftClose,
  MessageSquare,
  Zap,
  Loader2,
  BarChart3,
  Sigma,
  Table2,
  PenLine,
  Trash2,
  Play,
  Minus,
  Code2,
  FileCode,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface InlineActionTagProps {
  actionName: string;
  state: string;
}

// ── Style tokens ──────────────────────────────────────────────

const WB_STYLE = 'bg-ai-soft border-ai/30 text-ai';
const WB_ACCENT = 'bg-ai';

const SPOTLIGHT_STYLE = 'bg-review-soft border-review/30 text-review-ink';
const LASER_STYLE = 'bg-mistake-soft border-mistake/30 text-mistake-ink';
const DISCUSS_STYLE = 'bg-review-soft border-review/30 text-review-ink';
const DEFAULT_STYLE = 'bg-muted border-border-strong/40 text-muted-foreground';

// ── Action config ─────────────────────────────────────────────

interface ActionCfg {
  label: string;
  Icon: LucideIcon;
  style: string;
  /** Whiteboard family — gets the pen-line accent indicator */
  wb?: boolean;
}

const ACTION_CONFIG: Record<string, ActionCfg> = {
  // Slide effects
  spotlight: { label: 'Spotlight', Icon: Flashlight, style: SPOTLIGHT_STYLE },
  laser: { label: 'Laser', Icon: MousePointer2, style: LASER_STYLE },
  play_video: { label: 'Play', Icon: Play, style: SPOTLIGHT_STYLE },

  // Whiteboard lifecycle
  wb_open: { label: 'Open', Icon: PanelLeftOpen, style: WB_STYLE, wb: true },
  wb_close: { label: 'Close', Icon: PanelLeftClose, style: WB_STYLE, wb: true },
  wb_clear: { label: 'Clear', Icon: Eraser, style: WB_STYLE, wb: true },
  wb_delete: { label: 'Delete', Icon: Trash2, style: WB_STYLE, wb: true },

  // Whiteboard drawing
  wb_draw_text: { label: 'Text', Icon: Type, style: WB_STYLE, wb: true },
  wb_draw_shape: { label: 'Shape', Icon: Shapes, style: WB_STYLE, wb: true },
  wb_draw_chart: { label: 'Chart', Icon: BarChart3, style: WB_STYLE, wb: true },
  wb_draw_latex: { label: 'Formula', Icon: Sigma, style: WB_STYLE, wb: true },
  wb_draw_table: { label: 'Table', Icon: Table2, style: WB_STYLE, wb: true },
  wb_draw_line: { label: 'Line', Icon: Minus, style: WB_STYLE, wb: true },
  wb_draw_code: { label: 'Code', Icon: Code2, style: WB_STYLE, wb: true },
  wb_edit_code: { label: 'Edit Code', Icon: FileCode, style: WB_STYLE, wb: true },

  // Social
  discussion: { label: 'Discuss', Icon: MessageSquare, style: DISCUSS_STYLE },
};

// ── Component ─────────────────────────────────────────────────

export function InlineActionTag({ actionName, state }: InlineActionTagProps) {
  const config = ACTION_CONFIG[actionName];
  const Icon = config?.Icon || Zap;
  const label = config?.label || actionName;
  const style = config?.style || DEFAULT_STYLE;
  const isWb = config?.wb ?? false;
  const isRunning = state === 'running' || state === 'input-available';

  return (
    <span
      className={cn(
        'inline-flex items-center mx-1 rounded-full border align-middle leading-none whitespace-nowrap',
        'text-[9px] font-bold tracking-wide',
        // Slightly tighter padding when wb accent is present (accent provides left visual weight)
        isWb ? 'pl-0.5 pr-1.5 py-px' : 'px-1.5 py-px',
        style,
        isRunning && 'animate-pulse',
      )}
    >
      {/* Whiteboard accent: tiny PenLine chip on the left */}
      {isWb && (
        <span
          className={cn(
            'inline-flex items-center justify-center rounded-full mr-0.5 shrink-0',
            'w-3 h-3',
            WB_ACCENT,
          )}
        >
          <PenLine className="h-[7px] w-[7px] text-primary-foreground" strokeWidth={2.5} />
        </span>
      )}

      {/* Action icon */}
      {isRunning ? (
        <Loader2 className="w-2.5 h-2.5 animate-spin shrink-0" />
      ) : (
        <Icon className="w-2.5 h-2.5 shrink-0" />
      )}

      <span className="ml-0.5">{label}</span>
    </span>
  );
}
