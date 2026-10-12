import { blockFingerprint, countWords, extractStatusIds, isLinkOnly, normalizeText, fingerprint, weightedLength } from "./text";

export type BlockKind = "p" | "li" | "tr" | "bq" | "code" | "h";

export interface TokenizeOptions {
  ignoreFrontmatter: boolean;
  ignoreCode: boolean;
  ignoreHeadings: boolean;
  ignoreLinkOnly: boolean;
  /** Minimum weighted length (CJK counts double) for a block to take part. */
  minLength: number;
  /** Blocks that mention an X/Twitter status are kept even when short, and grouped by status id. */
  detectStatusIds: boolean;
}

export interface Block {
  /** First and last line (0-based, inclusive). */
  s: number;
  e: number;
  k: BlockKind;
  /** Fingerprint of the normalised text. */
  h: string;
  /** Weighted length of the normalised text. */
  w: number;
  /** Raw characters (including line breaks) the block occupies. */
  r: number;
  /** Words in the block. */
  n: number;
  /** Sorted, comma-joined X/Twitter status ids mentioned in the block ("" when none). */
  sid: string;
  /** True for list items nested below another item. */
  nested?: boolean;
}

export interface TokenizeResult {
  blocks: Block[];
  /** Number of lines in the note. */
  lines: number;
  /** Total weighted length of the blocks that were kept (the denominator for overlap ratios). */
  totalW: number;
}

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING_RE = /^\s{0,3}#{1,6}(?:\s|$)/;
const HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE_RE = /^\s{0,3}>/;
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+/;
const TABLE_DELIM_RE = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function indentOf(line: string): number {
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === " ") n++;
    else if (c === "\t") n += 4 - (n % 4);
    else break;
  }
  return n;
}

const isBlank = (l: string) => l.trim() === "";
const isTableRow = (l: string) => l.includes("|") && !isBlank(l);
const isTableDelim = (l: string) => l.includes("-") && l.includes("|") && TABLE_DELIM_RE.test(l);

export interface TableInfo {
  header: number;
  delim: number;
  rows: number[];
}

/** Finds Markdown tables (header, delimiter row, body rows) outside fenced code. */
export function findTables(lines: string[]): TableInfo[] {
  const tables: TableInfo[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const f = FENCE_RE.exec(lines[i]);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    if (i + 1 < lines.length && isTableRow(lines[i]) && isTableDelim(lines[i + 1])) {
      const rows: number[] = [];
      let j = i + 2;
      while (j < lines.length && isTableRow(lines[j])) rows.push(j++);
      tables.push({ header: i, delim: i + 1, rows });
      i = j - 1;
    }
  }
  return tables;
}

function startsOtherBlock(lines: string[], i: number): boolean {
  const l = lines[i];
  return (
    FENCE_RE.test(l) ||
    HEADING_RE.test(l) ||
    HR_RE.test(l) ||
    QUOTE_RE.test(l) ||
    LIST_RE.test(l) ||
    (i + 1 < lines.length && isTableRow(l) && isTableDelim(lines[i + 1]))
  );
}

/** Last line of the list item that starts at `i`: indented children and lazy continuation lines belong to it. */
function listItemEnd(lines: string[], i: number): number {
  const base = indentOf(lines[i]);
  let end = i;
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j];
    if (isBlank(l)) {
      let k = j + 1;
      while (k < lines.length && isBlank(lines[k])) k++;
      if (k < lines.length && indentOf(lines[k]) > base) {
        j = k;
        continue;
      }
      break;
    }
    if (indentOf(l) > base) {
      end = j;
      j++;
      continue;
    }
    // Same or lower indent: only a plain continuation line stays in the item
    if (startsOtherBlock(lines, j)) break;
    end = j;
    j++;
  }
  return end;
}

/**
 * Splits a note into candidate blocks. Blocks may nest (a list item and the items below it are all emitted);
 * the grouping step later keeps the largest duplicated block and discards what it contains.
 */
export function tokenize(text: string, opts: TokenizeOptions): TokenizeResult {
  const lines = text.split("\n");
  const n = lines.length;
  const blocks: Block[] = [];
  let totalW = 0;

  const emit = (s: number, e: number, k: BlockKind, nested?: boolean) => {
    const slice = lines.slice(s, e + 1);
    const raw = slice.join("\n");
    if (k === "h" && opts.ignoreHeadings) return;
    const sids = opts.detectStatusIds ? extractStatusIds(raw) : [];
    const norm = normalizeText(raw);
    if (norm === "") return;
    const w = weightedLength(norm);
    if (sids.length === 0) {
      if (w < opts.minLength) return;
      if (opts.ignoreLinkOnly && isLinkOnly(raw)) return;
    }
    const b: Block = { s, e, k, h: fingerprint(norm), w, r: raw.length + 1, n: countWords(norm), sid: sids.join(",") };
    if (nested) b.nested = true;
    blocks.push(b);
    totalW += w;
  };

  let i = 0;
  if (opts.ignoreFrontmatter && n > 0 && lines[0].trim() === "---") {
    for (let j = 1; j < n; j++) {
      const t = lines[j].trim();
      if (t === "---" || t === "...") {
        i = j + 1;
        break;
      }
    }
  }

  while (i < n) {
    const l = lines[i];
    if (isBlank(l)) {
      i++;
      continue;
    }
    const fence = FENCE_RE.exec(l);
    if (fence) {
      const ch = fence[1][0];
      const len = fence[1].length;
      let j = i + 1;
      while (j < n) {
        const m = FENCE_RE.exec(lines[j]);
        if (m && m[1][0] === ch && m[1].length >= len && lines[j].replace(/[`~\s]/g, "") === "") break;
        j++;
      }
      const end = Math.min(j, n - 1);
      if (!opts.ignoreCode) emit(i, end, "code");
      i = end + 1;
      continue;
    }
    if (HEADING_RE.test(l)) {
      emit(i, i, "h");
      i++;
      continue;
    }
    if (HR_RE.test(l)) {
      i++;
      continue;
    }
    if (i + 1 < n && isTableRow(l) && isTableDelim(lines[i + 1])) {
      let j = i + 2;
      while (j < n && isTableRow(lines[j])) {
        emit(j, j, "tr");
        j++;
      }
      i = j;
      continue;
    }
    if (QUOTE_RE.test(l)) {
      let j = i;
      while (j + 1 < n && QUOTE_RE.test(lines[j + 1])) j++;
      emit(i, j, "bq");
      i = j + 1;
      continue;
    }
    const li = LIST_RE.exec(l);
    if (li) {
      const end = listItemEnd(lines, i);
      emit(i, end, "li", indentOf(l) > 0);
      // Continue on the next line so that nested items are emitted as well
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < n && !isBlank(lines[j + 1]) && !startsOtherBlock(lines, j + 1)) j++;
    emit(i, j, "p");
    i = j + 1;
  }
  return { blocks, lines: n, totalW };
}

/** Re-derives the fingerprint of a line range, used to check that a block has not changed since it was scanned. */
export function rangeFingerprint(lines: string[], s: number, e: number): string | null {
  if (s < 0 || e >= lines.length || s > e) return null;
  return blockFingerprint(lines.slice(s, e + 1));
}
