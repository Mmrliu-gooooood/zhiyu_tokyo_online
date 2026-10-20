/**
 * Whiteboard explanations (learning plan B13): the model describes what to
 * draw in a few simple shapes; the program turns each into an element of the
 * classroom whiteboard — built like the classroom's own drawing tools (text,
 * KaTeX formula, line or arrow, highlight box) — kept inside the board and
 * checked with the whiteboard's element validator. Anything that fails is
 * dropped, never repaired by guessing.
 */
import katex from 'katex';
import type {
  PPTElement,
  PPTLatexElement,
  PPTLineElement,
  PPTShapeElement,
  PPTTextElement,
} from '@openmaic/dsl';

import { normalizeAndValidateWhiteboardElement } from '@/lib/whiteboard/runtime/validate';

import { EXPLANATION_LIMITS } from './contracts';

const BOARD = EXPLANATION_LIMITS.whiteboard;

/** The board as a slide (what the renderer draws). */
export const WHITEBOARD_VIEWPORT = { size: BOARD.width, ratio: BOARD.height / BOARD.width };

const SHAPE_PATHS = {
  rect: 'M 0 0 L 1000 0 L 1000 1000 L 0 1000 Z',
  circle: 'M 500 0 A 500 500 0 1 1 499 0 Z',
} as const;

const HIGHLIGHT = { fill: 'rgba(91,155,213,0.12)', outline: '#5b9bd5' };

export type DrawKind = 'text' | 'latex' | 'line' | 'rect' | 'circle';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Round to one decimal, never -0 (the validator rejects it). */
function tidy(value: number): number {
  const rounded = Math.round(value * 10) / 10;
  return rounded === 0 ? 0 : rounded;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function escapeText(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

function clip(value: string, max: number): string {
  const chars = Array.from(value.trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

/** A box kept on the board: width/height as given (or defaults), moved back inside. */
function box(raw: Record<string, unknown>, defaults: { w: number; h: number }) {
  const w = clamp(num(raw.w) ?? defaults.w, 20, BOARD.width);
  const h = clamp(num(raw.h) ?? defaults.h, 16, BOARD.height);
  const x = clamp(num(raw.x) ?? 0, 0, BOARD.width - w);
  const y = clamp(num(raw.y) ?? 0, 0, BOARD.height - h);
  return { left: tidy(x), top: tidy(y), width: tidy(w), height: tidy(h) };
}

function textElement(id: string, raw: Record<string, unknown>): PPTElement | null {
  if (typeof raw.text !== 'string' || !raw.text.trim()) return null;
  const text = clip(raw.text, BOARD.textChars);
  // A whole formula written as text is drawn as a formula.
  const delimited = /^\$\$?([\s\S]+?)\$?\$$/u.exec(text);
  if (delimited) return latexElement(id, { ...raw, latex: delimited[1] });
  const size = clamp(num(raw.size) ?? 20, 14, 36);
  const lines = text.split(/\r\n|\r|\n/u).length;
  const element: PPTTextElement = {
    id,
    type: 'text',
    ...box(raw, { w: 420, h: Math.ceil(size * 1.6 * lines + 12) }),
    rotate: 0,
    content: `<p style="font-size: ${size}px;">${escapeText(text).replace(/\r\n|\r|\n/gu, '<br>')}</p>`,
    defaultFontName: 'Microsoft YaHei',
    defaultColor: '#333333',
  };
  return element;
}

function latexElement(id: string, raw: Record<string, unknown>): PPTElement | null {
  if (typeof raw.latex !== 'string' || !raw.latex.trim()) return null;
  const latex = raw.latex
    .trim()
    .replace(/^\$\$?|\$?\$$/gu, '')
    .trim();
  if (!latex || Array.from(latex).length > BOARD.latexChars) return null;
  let html: string;
  try {
    html = katex.renderToString(latex, { throwOnError: true, displayMode: true, output: 'html' });
  } catch {
    return null;
  }
  const element: PPTLatexElement = {
    id,
    type: 'latex',
    ...box(raw, { w: 360, h: 70 }),
    rotate: 0,
    latex,
    html,
    color: '#000000',
    fixedRatio: true,
  };
  return element;
}

function lineElement(id: string, raw: Record<string, unknown>): PPTElement | null {
  const x1 = num(raw.x1);
  const y1 = num(raw.y1);
  const x2 = num(raw.x2);
  const y2 = num(raw.y2);
  if (x1 === null || y1 === null || x2 === null || y2 === null) return null;
  const sx = clamp(x1, 0, BOARD.width);
  const sy = clamp(y1, 0, BOARD.height);
  const ex = clamp(x2, 0, BOARD.width);
  const ey = clamp(y2, 0, BOARD.height);
  if (Math.hypot(ex - sx, ey - sy) < 4) return null;
  const left = Math.min(sx, ex);
  const top = Math.min(sy, ey);
  const element: PPTLineElement = {
    id,
    type: 'line',
    left: tidy(left),
    top: tidy(top),
    width: 2,
    start: [tidy(sx - left), tidy(sy - top)],
    end: [tidy(ex - left), tidy(ey - top)],
    style: 'solid',
    color: '#333333',
    points: ['', raw.arrow === true ? 'arrow' : ''],
  };
  return element;
}

function shapeElement(
  id: string,
  kind: 'rect' | 'circle',
  raw: Record<string, unknown>,
): PPTElement | null {
  if (num(raw.w) === null || num(raw.h) === null) return null;
  const element: PPTShapeElement = {
    id,
    type: 'shape',
    ...box(raw, { w: 200, h: 80 }),
    rotate: 0,
    viewBox: [1000, 1000],
    path: SHAPE_PATHS[kind],
    fill: HIGHLIGHT.fill,
    fixedRatio: false,
    outline: { width: 2, style: 'solid', color: HIGHLIGHT.outline },
  };
  return element;
}

/** One drawing instruction as a validated whiteboard element, or null when unusable. */
export function drawToElement(raw: unknown, id: string): PPTElement | null {
  if (!isRecord(raw)) return null;
  let element: PPTElement | null;
  switch (raw.type) {
    case 'text':
      element = textElement(id, raw);
      break;
    case 'latex':
      element = latexElement(id, raw);
      break;
    case 'line':
    case 'arrow':
      element = lineElement(id, raw.type === 'arrow' ? { ...raw, arrow: true } : raw);
      break;
    case 'rect':
    case 'circle':
      element = shapeElement(id, raw.type, raw);
      break;
    default:
      return null;
  }
  if (!element) return null;
  try {
    return normalizeAndValidateWhiteboardElement(element);
  } catch {
    return null;
  }
}
