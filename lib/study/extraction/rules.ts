/**
 * Rule-based exercise extraction (learning plan B08, strategy `rules-v1`).
 * Pure and deterministic; no model is involved.
 *
 * Input is the parsed text of each page (one text block per page from the
 * B02 artifact; `null` for a page without text, i.e. a scanned page) and the
 * images the parser found per page. The extractor:
 * - drops page numbers and running heads/footers (a first/last line repeated
 *   on most pages);
 * - follows section headings ("习题 1.2", "一、选择题") and numbered questions
 *   ("3．", "第 3 题", "例 2"), with numbering that must move forward, so a
 *   "2." inside a stem does not start a question; text after a page break
 *   continues the open question (cross-page questions keep both pages);
 * - splits choice options ("A．…  B．…" on one line or one per line,
 *   "(A) …"), inline answers ("【答案】B", "答案：AC", "…故选 B") and
 *   explanations ("【解析】", "解：");
 * - reads answer keys ("参考答案" then "1．B  2．AC", "1~5 BCADB" or one
 *   text answer per number) and matches them to questions by section and
 *   number — never by guessing;
 * - gives a page's figures to the questions on it that mention a figure.
 *
 * Questions without options are kept as `open` candidates (calculation,
 * proof, fill-in); they enter the bank once open questions are supported.
 */
import { normalizeText, type QuestionOption } from '@/lib/study/questions/contracts';

import {
  EXTRACTION_LIMITS,
  type AnswerRef,
  type CandidateContent,
  type ExtractionStats,
  type SourceLine,
} from './contracts';

export interface PageText {
  page: number;
  /** null or blank: the page has no text (scanned). */
  text: string | null;
}

export interface PageImage {
  id: string;
  page: number;
}

export interface ExtractedCandidate {
  label: string | null;
  section: string | null;
  lines: SourceLine[];
  pages: number[];
  content: CandidateContent;
  answerBasis: 'missing' | 'source';
  answerRef: AnswerRef | null;
}

export type RuleStats = Omit<ExtractionStats, 'durationMs' | 'extractorId' | 'pageCount'>;

export interface RuleExtraction {
  candidates: ExtractedCandidate[];
  stats: RuleStats;
}

type KindHint = 'choice' | 'multiple' | 'fill' | 'open' | null;

const LETTERS = 'ABCDEFGH';
/** Caps that keep a stored candidate well under its row limits. */
const CAPS = { stem: 3000, option: 500, explanation: 3000, reference: 2000, lineChars: 400 };

const PAGE_NUMBER_LINE =
  /^(?:[-—–·•\s]*\d{1,4}[-—–·•\s]*|第\s*\d{1,4}\s*页(?:\s*[,，/]?\s*共\s*\d{1,4}\s*页)?|\d{1,4}\s*\/\s*\d{1,4}|page\s*\d{1,4}(?:\s*of\s*\d{1,4})?)$/i;
const SECTION_HEADING =
  /^(?:第[一二三四五六七八九十百零\d]+[章节部分篇]|(?:总|复|自测|课后|综合|单元)?习题\s*[\dA-Za-z一二三四五六七八九十.\-—–]*|练习\s*[\d.\-—–]*|复习题|自测题|[一二三四五六七八九十]+\s*[、.．]\s*\S{0,12}题|exercises?\b)/i;
const ANSWER_HEADING =
  /^(?:(?:第[一二三四五六七八九十百零\d]+[章节]|(?:总|复|自测|课后|综合|单元)?习题\s*[\d.\-—–]*|练习\s*[\d.\-—–]*|[一二三四五六七八九十]+\s*[、.．])\s*)?(?:参考答案|习题答案|部分答案|参考解答|答案(?:与|及)(?:提示|解析|解答)|答案|answers?(?:\s+key)?)(?:\s*(?:与|及)\s*(?:提示|解析))?\s*[:：]?$/i;
const QUESTION_START =
  /^(?:第\s*(\d{1,3})\s*题|(\d{1,3})\s*[.．、](?!\d)|例\s*(\d{1,3})(?![\d.．])\s*[.．、:：]?)\s*/;
const INLINE_ANSWER = /^(?:【\s*(?:参考)?答案\s*】|(?:参考)?答案\s*[:：])\s*/;
const INLINE_EXPLANATION =
  /^(?:【\s*(?:解析|详解|分析|解答|点评|提示|解|证明)\s*】|(?:解析|详解|分析|解答|提示|解|证明|证)\s*[:：])\s*/;
const CHOSEN =
  /(?:故选|应选|答案为|答案是)\s*[:：]?\s*([A-HＡ-Ｈ](?:\s*[,，、]?\s*[A-HＡ-Ｈ]){0,7})(?![A-Za-z])/;
const OPTION_MARK = /(^|[\s　;；])[（(]?([A-HＡ-Ｈ])\s*[)）.．、:：]\s*/g;
const ANSWER_RANGE =
  /(\d{1,3})\s*[~～\-—–至]\s*(\d{1,3})\s*[.．、:：]?\s*([A-HＡ-Ｈ]{2,40})(?![A-Za-z])/g;
const ANSWER_PAIR =
  /(?:^|[\s　;；,，。])(\d{1,3})\s*[.．、:：)）]\s*([A-HＡ-Ｈ](?:\s*[,，、]?\s*[A-HＡ-Ｈ]){0,7})(?=$|[\s　;；,，。])/g;
const FIGURE_MENTION = /如图|图\s*[\d一二三四五六七八九十]|下图|上图|右图|左图|图中|所示的图/;
const MULTIPLE_HINT = /多选|多项选择|不定项|哪些|正确的有/;
const CJK = /[⺀-鿿＀-￯　-〿]/;

function foldLetter(value: string): string {
  return value.normalize('NFKC').toUpperCase();
}

/** Join wrapped lines: no space between CJK text, one space otherwise. */
export function joinLines(texts: readonly string[]): string {
  let out = '';
  for (const raw of texts) {
    const text = raw.trim();
    if (!text) continue;
    if (!out) out = text;
    else if (CJK.test(out.at(-1)!) || CJK.test(text[0]!)) out += text;
    else out += ` ${text}`;
  }
  return out;
}

function cap(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

/** "AC", "A, C", "Ａ" → ["A","C"]; null when the text is not just option letters. */
export function answerLetters(text: string): string[] | null {
  const compact = foldLetter(text).replace(/[\s,，、;；.。]/g, '');
  if (!/^[A-H]{1,8}$/.test(compact)) return null;
  return [...new Set(compact)].sort();
}

/** Split "stem A．x B．y" into stem and options (letters must run A, B, C, …). */
export function splitOptions(text: string): { stem: string; options: QuestionOption[] } | null {
  const marks = [...text.matchAll(OPTION_MARK)].map((match) => ({
    letter: foldLetter(match[2]!),
    start: match.index! + match[1]!.length,
    end: match.index! + match[0].length,
  }));
  for (let i = 0; i < marks.length; i += 1) {
    if (marks[i]!.letter !== 'A') continue;
    let sequence = [marks[i]!];
    for (let j = i + 1; j < marks.length && sequence.length < LETTERS.length; j += 1) {
      // A later "A" before any "B" starts the options instead ("设 A、B 两点 … A．…").
      if (marks[j]!.letter === 'A' && sequence.length === 1) sequence = [marks[j]!];
      else if (marks[j]!.letter === LETTERS[sequence.length]) sequence.push(marks[j]!);
    }
    if (sequence.length < 2) continue;
    const labels = sequence.map((mark, k) =>
      joinLines(text.slice(mark.end, sequence[k + 1]?.start ?? text.length).split('\n')),
    );
    if (labels.some((label) => !label)) continue;
    return {
      stem: joinLines(text.slice(0, sequence[0]!.start).split('\n')),
      options: labels.map((label, k) => ({ value: LETTERS[k]!, label: cap(label, CAPS.option) })),
    };
  }
  return null;
}

interface StartMatch {
  label: string;
  number: number | null;
  rest: string;
}

function questionStart(text: string): StartMatch | null {
  const match = QUESTION_START.exec(text);
  if (!match) return null;
  const rest = text.slice(match[0].length);
  if (match[3]) return { label: `例${Number(match[3])}`, number: null, rest };
  const number = Number(match[1] ?? match[2]);
  return { label: String(number), number, rest };
}

function hintOf(heading: string): KindHint {
  if (/多选|多项选择|不定项/.test(heading)) return 'multiple';
  if (/选择/.test(heading)) return 'choice';
  if (/填空/.test(heading)) return 'fill';
  if (/判断|解答|计算|证明|应用|简答|综合|论述/.test(heading)) return 'open';
  return null;
}

/** A section's own number ("习题 1.2" → "1.2", "第三章" → "三"), used to pair answer keys. */
function sectionKeyOf(heading: string): string | null {
  const digits = /(\d+(?:\s*[.．\-—–]\s*\d+)*)/.exec(heading);
  if (digits) return digits[1]!.replace(/\s+/g, '').replace(/[．\-—–]/g, '.');
  const chinese = /第([一二三四五六七八九十百零]+)[章节]/.exec(heading);
  return chinese ? chinese[1]! : null;
}

function isAnswerHeading(text: string): boolean {
  return text.length <= 40 && !text.startsWith('【') && ANSWER_HEADING.test(text);
}

function isSectionHeading(text: string): boolean {
  return text.length <= 60 && SECTION_HEADING.test(text) && !questionStart(text);
}

// ── block parsing (also used for split/merge on the server) ────────────────

export interface ParsedBlock {
  label: string | null;
  content: CandidateContent;
  answerRef: AnswerRef | null;
}

/**
 * The content of one question from its source lines. The first line may
 * still carry its number ("3．…"), which becomes the label.
 */
export function parseBlock(lines: readonly SourceLine[], hint: KindHint = null): ParsedBlock {
  const start = lines[0] ? questionStart(lines[0].text) : null;
  const texts = lines.map((line, index) => ({
    page: line.page,
    text: index === 0 && start ? start.rest : line.text,
  }));
  const body: string[] = [];
  const answerLines: Array<{ page: number; text: string }> = [];
  const explanation: string[] = [];
  let mode: 'body' | 'answer' | 'explanation' = 'body';
  for (const line of texts) {
    const answer = INLINE_ANSWER.exec(line.text);
    const explain = answer ? null : INLINE_EXPLANATION.exec(line.text);
    if (answer) {
      mode = 'answer';
      const rest = line.text.slice(answer[0].length);
      if (rest) answerLines.push({ page: line.page, text: rest });
    } else if (explain) {
      mode = 'explanation';
      const rest = line.text.slice(explain[0].length);
      if (rest) explanation.push(rest);
    } else if (mode === 'answer') {
      if (answerLines.length === 0) answerLines.push({ page: line.page, text: line.text });
      else answerLines[answerLines.length - 1]!.text += `\n${line.text}`;
    } else if (mode === 'explanation') {
      explanation.push(line.text);
    } else {
      body.push(line.text);
    }
  }
  const bodyText = body.join('\n');
  const split = hint === 'fill' || hint === 'open' ? null : splitOptions(bodyText);
  const explanationText = explanation.length ? cap(joinLines(explanation), CAPS.explanation) : null;
  const answerText = answerLines.length ? answerLines.map((line) => line.text).join('\n') : '';
  let answer: string[] = [];
  let answerRef: AnswerRef | null = null;
  let referenceAnswer: string | null = null;
  if (split) {
    const letters = answerText ? answerLetters(answerText.split('\n')[0]!) : null;
    const chosen = !letters && explanationText ? CHOSEN.exec(explanationText) : null;
    const found = letters ?? (chosen ? answerLetters(chosen[1]!) : null);
    if (found && found.every((value) => split.options.some((option) => option.value === value))) {
      answer = found;
      const page = answerLines[0]?.page ?? texts.at(-1)!.page;
      answerRef = { kind: 'inline', page, text: cap((answerText || chosen![0]).trim(), 200) };
    }
  } else if (answerText) {
    referenceAnswer = cap(joinLines(answerText.split('\n')), CAPS.reference);
    answerRef = { kind: 'inline', page: answerLines[0]!.page, text: cap(referenceAnswer, 200) };
  }
  const stem = cap(split ? split.stem : joinLines(body), CAPS.stem);
  const multiple =
    answer.length > 1 || hint === 'multiple' || (answer.length === 0 && MULTIPLE_HINT.test(stem));
  return {
    label: start?.label ?? null,
    answerRef,
    content: {
      type: split ? (multiple ? 'multiple' : 'single') : 'open',
      stem: normalizeText(stem),
      options: split?.options ?? [],
      answer,
      explanation: explanationText,
      concepts: [],
      difficulty: null,
      points: 1,
      figures: [],
      referenceAnswer,
    },
  };
}

export function mentionsFigure(text: string): boolean {
  return FIGURE_MENTION.test(text);
}

// ── whole extraction ────────────────────────────────────────────────────────

interface Block {
  label: string;
  number: number | null;
  section: string | null;
  sectionKey: string | null;
  group: number;
  hint: KindHint;
  lines: SourceLine[];
}

interface AnswerEntry {
  number: number;
  sectionKey: string | null;
  group: number;
  page: number;
  letters: string[] | null;
  text: string;
}

function runningLineKey(text: string): string {
  return text.replace(/\d+/g, '#').replace(/\s+/g, '');
}

/** Lines per page without page numbers and repeated running heads/footers. */
function cleanPages(pages: ReadonlyArray<{ page: number; lines: string[] }>) {
  const counts = new Map<string, number>();
  const edges = (lines: string[]) =>
    lines.length >= 2
      ? [`f:${runningLineKey(lines[0]!)}`, `l:${runningLineKey(lines.at(-1)!)}`]
      : [];
  for (const page of pages)
    for (const key of edges(page.lines)) counts.set(key, (counts.get(key) ?? 0) + 1);
  const threshold = Math.max(3, Math.ceil(pages.length / 2));
  return pages.map((page) => {
    let lines = page.lines.filter((line) => !PAGE_NUMBER_LINE.test(line));
    if (pages.length >= 3 && lines.length >= 2) {
      if ((counts.get(`f:${runningLineKey(lines[0]!)}`) ?? 0) >= threshold) lines = lines.slice(1);
      if (lines.length && (counts.get(`l:${runningLineKey(lines.at(-1)!)}`) ?? 0) >= threshold) {
        lines = lines.slice(0, -1);
      }
    }
    return { page: page.page, lines };
  });
}

function answerEntriesOf(text: string): Array<{ number: number; letters: string[] }> {
  const entries: Array<{ number: number; letters: string[] }> = [];
  const taken: Array<[number, number]> = [];
  for (const match of text.matchAll(ANSWER_RANGE)) {
    const from = Number(match[1]);
    const to = Number(match[2]);
    const letters = foldLetter(match[3]!);
    if (to < from || letters.length !== to - from + 1) continue;
    for (let n = from; n <= to; n += 1) entries.push({ number: n, letters: [letters[n - from]!] });
    taken.push([match.index!, match.index! + match[0].length]);
  }
  for (const match of text.matchAll(ANSWER_PAIR)) {
    const at = match.index!;
    if (taken.some(([from, to]) => at >= from && at < to)) continue;
    const letters = answerLetters(match[2]!);
    if (letters) entries.push({ number: Number(match[1]), letters });
  }
  return entries;
}

function pairGroups(
  blocks: readonly Block[],
  entries: readonly AnswerEntry[],
): Map<number, number> {
  // answer group → question group
  const pairs = new Map<number, number>();
  const qGroups = [
    ...new Map(blocks.filter((b) => b.number !== null).map((b) => [b.group, b])).values(),
  ];
  const aGroups = [...new Map(entries.map((e) => [e.group, e])).values()];
  const usedQ = new Set<number>();
  for (const a of aGroups) {
    if (!a.sectionKey) continue;
    const q = qGroups.find((block) => block.sectionKey === a.sectionKey && !usedQ.has(block.group));
    if (q) {
      pairs.set(a.group, q.group);
      usedQ.add(q.group);
    }
  }
  const restA = aGroups.filter((a) => !pairs.has(a.group));
  const restQ = qGroups.filter((q) => !usedQ.has(q.group));
  if (restA.length && restA.length === restQ.length) {
    restA.forEach((a, index) => pairs.set(a.group, restQ[index]!.group));
  }
  return pairs;
}

export function extractQuestions(
  pages: readonly PageText[],
  images: readonly PageImage[] = [],
): RuleExtraction {
  const skippedPages: number[] = [];
  const textPages: Array<{ page: number; lines: string[] }> = [];
  let textChars = 0;
  for (const page of pages) {
    const text = page.text?.trim();
    if (!text) {
      skippedPages.push(page.page);
      continue;
    }
    textChars += text.length;
    textPages.push({
      page: page.page,
      lines: text
        .split(/\r?\n/)
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean),
    });
  }
  const lines: SourceLine[] = cleanPages(textPages).flatMap((page) =>
    page.lines.map((text) => ({ page: page.page, text: cap(text, CAPS.lineChars) })),
  );

  const blocks: Block[] = [];
  const entries: AnswerEntry[] = [];
  let mode: 'body' | 'answers' = 'body';
  let section: string | null = null;
  let sectionKey: string | null = null;
  let hint: KindHint = null;
  let group = 0;
  let lastNumber = 0;
  let current: Block | null = null;
  let answerGroup = 0;
  let answerKey: string | null = null;
  let answerLast = 0;
  let textEntry: AnswerEntry | null = null;

  const startAnswerGroup = (key: string | null) => {
    answerGroup += 1;
    answerKey = key;
    answerLast = 0;
    textEntry = null;
  };
  const pushEntry = (entry: Omit<AnswerEntry, 'group' | 'sectionKey'>) => {
    if (entry.number <= answerLast) startAnswerGroup(answerKey);
    answerLast = entry.number;
    const full = { ...entry, group: answerGroup, sectionKey: answerKey };
    entries.push(full);
    return full;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (mode === 'answers') {
      if (isAnswerHeading(line.text)) {
        startAnswerGroup(sectionKeyOf(line.text) ?? answerKey);
        continue;
      }
      if (isSectionHeading(line.text)) {
        // The key ends where a new exercise set starts: a heading followed by a real question.
        const next = lines[index + 1] ? questionStart(lines[index + 1]!.text) : null;
        const looksLikeQuestion =
          next !== null &&
          next.rest.length >= 12 &&
          answerEntriesOf(lines[index + 1]!.text).length === 0;
        if (!looksLikeQuestion) {
          startAnswerGroup(sectionKeyOf(line.text));
          continue;
        }
        mode = 'body';
      } else {
        const found = answerEntriesOf(line.text);
        if (found.length) {
          textEntry = null;
          for (const entry of found) {
            pushEntry({ number: entry.number, page: line.page, letters: entry.letters, text: '' });
          }
          continue;
        }
        const start = questionStart(line.text);
        if (start?.number) {
          textEntry = pushEntry({
            number: start.number,
            page: line.page,
            letters: null,
            text: start.rest,
          });
        } else if (textEntry) {
          textEntry.text = joinLines([textEntry.text, line.text]);
        }
        continue;
      }
    }

    if (isAnswerHeading(line.text)) {
      current = null;
      mode = 'answers';
      startAnswerGroup(sectionKeyOf(line.text) ?? sectionKey);
      continue;
    }
    if (isSectionHeading(line.text)) {
      current = null;
      section = cap(line.text, 120);
      const ownKey = sectionKeyOf(line.text);
      const ownHint = hintOf(line.text);
      // "一、选择题" under "习题 1.2" keeps the exercise set's number.
      if (ownKey || !ownHint) sectionKey = ownKey;
      hint = ownHint;
      group += 1;
      lastNumber = 0;
      continue;
    }
    const start = questionStart(line.text);
    const accepted =
      start !== null &&
      (start.number === null ||
        start.number === 1 ||
        (start.number > lastNumber && start.number <= lastNumber + 3));
    if (start && accepted) {
      if (start.number !== null) {
        if (start.number === 1 && lastNumber > 0) group += 1;
        if (group === 0) group = 1;
        lastNumber = start.number;
      }
      current = {
        label: start.label,
        number: start.number,
        section,
        sectionKey,
        group: Math.max(group, 1),
        hint,
        lines: [line],
      };
      blocks.push(current);
      continue;
    }
    if (current && current.lines.length < EXTRACTION_LIMITS.linesPerCandidate)
      current.lines.push(line);
  }

  // Answer keys → questions, by section then number.
  const pairs = pairGroups(blocks, entries);
  const byGroupNumber = new Map<string, AnswerEntry>();
  const unpaired: AnswerEntry[] = [];
  for (const entry of entries) {
    const target = pairs.get(entry.group);
    if (target === undefined) unpaired.push(entry);
    else byGroupNumber.set(`${target}:${entry.number}`, entry);
  }
  // Without a pairing, a number that occurs once on both sides still matches.
  const numbered = blocks.filter((block) => block.number !== null);
  const uniqueQuestion = (number: number) =>
    numbered.filter((block) => block.number === number).length === 1;
  for (const entry of unpaired) {
    const sameNumber = unpaired.filter((other) => other.number === entry.number).length === 1;
    const block = numbered.find((candidate) => candidate.number === entry.number);
    if (block && sameNumber && uniqueQuestion(entry.number)) {
      byGroupNumber.set(`${block.group}:${entry.number}`, entry);
    }
  }

  const used = new Set<AnswerEntry>();
  const truncated = blocks.length > EXTRACTION_LIMITS.candidatesPerExtraction;
  const candidates: ExtractedCandidate[] = blocks
    .slice(0, EXTRACTION_LIMITS.candidatesPerExtraction)
    .map((block) => {
      const parsed = parseBlock(block.lines, block.hint);
      let answerBasis: ExtractedCandidate['answerBasis'] = parsed.answerRef ? 'source' : 'missing';
      let answerRef = parsed.answerRef;
      const entry =
        block.number !== null ? byGroupNumber.get(`${block.group}:${block.number}`) : undefined;
      if (entry && !answerRef) {
        const content = parsed.content;
        if (content.type !== 'open' && entry.letters) {
          const valid = entry.letters.every((value) =>
            content.options.some((option) => option.value === value),
          );
          if (valid) {
            content.answer = entry.letters;
            if (entry.letters.length > 1) content.type = 'multiple';
            answerBasis = 'source';
            answerRef = {
              kind: 'answer_key',
              page: entry.page,
              text: `${entry.number}. ${entry.letters.join('')}`,
            };
            used.add(entry);
          }
        } else if (content.type === 'open' && entry.text) {
          content.referenceAnswer = cap(entry.text, CAPS.reference);
          answerBasis = 'source';
          answerRef = {
            kind: 'answer_key',
            page: entry.page,
            text: cap(`${entry.number}. ${entry.text}`, 200),
          };
          used.add(entry);
        }
      }
      return {
        label: parsed.label ?? block.label,
        section: block.section,
        lines: block.lines,
        pages: [...new Set(block.lines.map((line) => line.page))],
        content: parsed.content,
        answerBasis,
        answerRef,
      };
    });

  // Figures: a page's images go to the questions on it that mention a figure.
  const unassignedFigures: ExtractionStats['unassignedFigures'] = [];
  const questionPages = new Set(candidates.flatMap((candidate) => candidate.pages));
  const imagesByPage = new Map<number, PageImage[]>();
  for (const image of images) {
    if (!questionPages.has(image.page)) continue;
    imagesByPage.set(image.page, [...(imagesByPage.get(image.page) ?? []), image]);
  }
  for (const [page, pageImages] of imagesByPage) {
    const claimants = candidates.filter(
      (candidate) =>
        candidate.pages.includes(page) &&
        mentionsFigure(candidate.lines.map((line) => line.text).join('')),
    );
    if (claimants.length === 0) {
      unassignedFigures.push(...pageImages.map((image) => ({ imageId: image.id, page })));
      continue;
    }
    pageImages.forEach((image, index) => {
      const owner = claimants[Math.min(index, claimants.length - 1)]!;
      if (owner.content.figures.length < EXTRACTION_LIMITS.figuresPerQuestion) {
        owner.content.figures.push(image.id);
      } else {
        unassignedFigures.push({ imageId: image.id, page });
      }
    });
  }

  return {
    candidates,
    stats: {
      pagesRead: pages.length,
      skippedPages,
      textChars,
      candidates: candidates.length,
      choice: candidates.filter((candidate) => candidate.content.type !== 'open').length,
      open: candidates.filter((candidate) => candidate.content.type === 'open').length,
      answersFromSource: candidates.filter((candidate) => candidate.answerBasis === 'source')
        .length,
      unmatchedAnswers: entries
        .filter((entry) => !used.has(entry))
        .slice(0, EXTRACTION_LIMITS.unmatchedReported)
        .map((entry) => ({
          label: String(entry.number),
          page: entry.page,
          text: cap(entry.letters ? entry.letters.join('') : entry.text, 120),
        })),
      unassignedFigures: unassignedFigures.slice(0, 100),
      truncated,
    },
  };
}
