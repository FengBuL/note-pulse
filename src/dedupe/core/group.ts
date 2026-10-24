import type { Block, BlockKind } from "./tokenize";

export type KeepRule = "auto" | "created" | "modified" | "name";

/** What the scan knows about one note. */
export interface FileRecord {
  path: string;
  ctime: number;
  mtime: number;
  /** Characters in the note. */
  len: number;
  lines: number;
  totalW: number;
  blocks: Block[];
}

export interface Occurrence {
  /** Index into the scan's file list. */
  f: number;
  path: string;
  block: Block;
}

export type GroupKind = "text" | "post";

export interface DupGroup {
  id: string;
  kind: GroupKind;
  /** For "post" groups: true when every occurrence has identical text. */
  exact: boolean;
  /** Occurrences ordered by the keep rule: index 0 is the one kept by default. */
  occs: Occurrence[];
  /** Largest block among the occurrences (for ranking and previews). */
  blockKind: BlockKind;
  /** Reclaimable amount when only the first occurrence is kept. */
  reclaimChars: number;
  reclaimWords: number;
  reclaimW: number;
}

export interface OverlapPair {
  /** Older note (kept) and newer note (cleaned). */
  older: string;
  newer: string;
  sharedBlocks: number;
  sharedW: number;
  sharedChars: number;
  /** Characters the shared blocks occupy in the older note (sharedChars is the newer note's side). */
  olderChars: number;
  /** Share of the older / newer note's counted content that also appears in the other note. */
  olderRatio: number;
  newerRatio: number;
  groupIds: string[];
}

export interface Analysis {
  files: FileRecord[];
  groups: DupGroup[];
  pairs: OverlapPair[];
  totals: {
    notes: number;
    chars: number;
    groups: number;
    blocks: number;
    reclaimChars: number;
    reclaimWords: number;
    ratio: number;
    postGroups: number;
  };
  /** Groups spanning more files than the pair analysis handles (usually boilerplate). */
  skippedBroad: number;
}

export interface GroupOptions {
  keepRule: KeepRule;
  /** Smallest containment ratio for two notes to be listed as overlapping. */
  overlapThreshold: number;
  /** Do not build pairs for groups that appear in more notes than this. */
  pairFileCap: number;
}

export const DEFAULT_GROUP_OPTIONS: GroupOptions = { keepRule: "auto", overlapThreshold: 0.7, pairFileCap: 40 };

const DATE_IN_NAME = /(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})(?:[ T_-]?(\d{2})[:._-]?(\d{2}))?/;

function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return (i >= 0 ? path.slice(i + 1) : path).replace(/\.md$/i, "");
}

/** A sortable date taken from the file name (YYYY-MM-DD, optionally followed by HHMM), or null. */
export function nameDate(path: string): string | null {
  const m = DATE_IN_NAME.exec(baseName(path));
  if (!m) return null;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  if (y < 1970 || y > 2200 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${m[1]}${m[2]}${m[3]}${m[4] ?? "00"}${m[5] ?? "00"}`;
}

/** Orders two notes oldest first according to the keep rule. */
export function compareFiles(a: FileRecord, b: FileRecord, rule: KeepRule): number {
  const byPath = a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  switch (rule) {
    case "name":
      return byPath;
    case "modified":
      return a.mtime - b.mtime || byPath;
    case "created":
      return a.ctime - b.ctime || byPath;
    default: {
      const da = nameDate(a.path);
      const db = nameDate(b.path);
      if (da && db && da !== db) return da < db ? -1 : 1;
      return a.ctime - b.ctime || a.mtime - b.mtime || byPath;
    }
  }
}

interface Candidate {
  key: string;
  isPost: boolean;
  occs: Occurrence[];
  span: number;
  w: number;
}

/** Finds duplicate groups and overlapping note pairs among already tokenised notes. */
export function analyze(files: FileRecord[], options: Partial<GroupOptions> = {}): Analysis {
  const opts = { ...DEFAULT_GROUP_OPTIONS, ...options };
  // Rank notes once; occurrence order inside a group follows this rank
  const order = files.map((_, i) => i).sort((x, y) => compareFiles(files[x], files[y], opts.keepRule));
  const rank = new Array<number>(files.length);
  order.forEach((fi, r) => (rank[fi] = r));

  // 1. Bucket blocks by key; only the first block per note takes part (repeats inside one note are out of scope)
  const buckets = new Map<string, Occurrence[]>();
  for (const fi of order) {
    const rec = files[fi];
    const seen = new Set<string>();
    for (const block of rec.blocks) {
      // Same post only counts within the same kind of block (a table row against table rows, a quote against quotes)
      const key = block.sid ? `s:${block.k}:${block.sid}` : `h:${block.h}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let list = buckets.get(key);
      if (!list) buckets.set(key, (list = []));
      list.push({ f: fi, path: rec.path, block });
    }
  }

  // 2. Largest candidates first, so that a duplicated list item wins over the duplicated lines it contains
  const candidates: Candidate[] = [];
  for (const [key, occs] of buckets) {
    if (occs.length < 2) continue;
    let span = 0;
    let w = 0;
    for (const o of occs) {
      span = Math.max(span, o.block.e - o.block.s + 1);
      w = Math.max(w, o.block.w);
    }
    candidates.push({ key, isPost: key.startsWith("s:"), occs, span, w });
  }
  candidates.sort((a, b) => b.span - a.span || b.w - a.w || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  // 3. Claim lines greedily so accepted groups never overlap each other
  const claimed = new Map<number, Uint8Array>();
  const overlaps = (o: Occurrence) => {
    const mask = claimed.get(o.f);
    if (!mask) return false;
    for (let l = o.block.s; l <= o.block.e; l++) if (mask[l]) return true;
    return false;
  };
  const claim = (o: Occurrence) => {
    let mask = claimed.get(o.f);
    if (!mask) claimed.set(o.f, (mask = new Uint8Array(files[o.f].lines + 1)));
    for (let l = o.block.s; l <= o.block.e; l++) mask[l] = 1;
  };

  const groups: DupGroup[] = [];
  let gi = 0;
  for (const c of candidates) {
    const remaining = c.occs.filter((o) => !overlaps(o));
    if (remaining.length < 2) continue;
    remaining.forEach(claim);
    remaining.sort((a, b) => rank[a.f] - rank[b.f]);
    const first = remaining[0].block;
    const exact = remaining.every((o) => o.block.h === first.h);
    let reclaimChars = 0;
    let reclaimWords = 0;
    let reclaimW = 0;
    for (let i = 1; i < remaining.length; i++) {
      reclaimChars += remaining[i].block.r;
      reclaimWords += remaining[i].block.n;
      reclaimW += remaining[i].block.w;
    }
    groups.push({
      id: `g${++gi}`,
      kind: c.isPost ? "post" : "text",
      exact,
      occs: remaining,
      blockKind: first.k,
      reclaimChars,
      reclaimWords,
      reclaimW,
    });
  }
  groups.sort((a, b) => b.reclaimChars - a.reclaimChars || b.occs.length - a.occs.length || (a.id < b.id ? -1 : 1));

  // 4. Overlapping note pairs
  const pairMap = new Map<string, { a: number; b: number; blocks: number; w: number; chars: number; olderChars: number; ids: string[] }>();
  let skippedBroad = 0;
  for (const g of groups) {
    if (g.occs.length > opts.pairFileCap) {
      skippedBroad++;
      continue;
    }
    for (let i = 0; i < g.occs.length; i++) {
      for (let j = i + 1; j < g.occs.length; j++) {
        const A = g.occs[i];
        const B = g.occs[j];
        const key = `${A.f}|${B.f}`;
        let p = pairMap.get(key);
        if (!p) pairMap.set(key, (p = { a: A.f, b: B.f, blocks: 0, w: 0, chars: 0, olderChars: 0, ids: [] }));
        p.blocks++;
        p.w += Math.min(A.block.w, B.block.w);
        p.chars += B.block.r;
        p.olderChars += A.block.r;
        p.ids.push(g.id);
      }
    }
  }
  const pairs: OverlapPair[] = [];
  for (const p of pairMap.values()) {
    const fa = files[p.a];
    const fb = files[p.b];
    const olderRatio = fa.totalW > 0 ? Math.min(1, p.w / fa.totalW) : 0;
    const newerRatio = fb.totalW > 0 ? Math.min(1, p.w / fb.totalW) : 0;
    if (p.blocks < 2 && Math.max(olderRatio, newerRatio) < 0.999) continue;
    if (Math.max(olderRatio, newerRatio) < opts.overlapThreshold) continue;
    pairs.push({
      older: fa.path,
      newer: fb.path,
      sharedBlocks: p.blocks,
      sharedW: p.w,
      sharedChars: p.chars,
      olderChars: p.olderChars,
      olderRatio,
      newerRatio,
      groupIds: p.ids,
    });
  }
  pairs.sort((x, y) => Math.max(y.olderRatio, y.newerRatio) * y.sharedW - Math.max(x.olderRatio, x.newerRatio) * x.sharedW);

  let chars = 0;
  let blocks = 0;
  let reclaimChars = 0;
  let reclaimWords = 0;
  let postGroups = 0;
  for (const f of files) chars += f.len;
  for (const g of groups) {
    blocks += g.occs.length;
    reclaimChars += g.reclaimChars;
    reclaimWords += g.reclaimWords;
    if (g.kind === "post") postGroups++;
  }
  return {
    files,
    groups,
    pairs,
    totals: {
      notes: files.length,
      chars,
      groups: groups.length,
      blocks,
      reclaimChars,
      reclaimWords,
      ratio: chars > 0 ? reclaimChars / chars : 0,
      postGroups,
    },
    skippedBroad,
  };
}
