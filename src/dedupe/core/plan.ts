import type { DupGroup, Occurrence } from "./group";
import { hash53, trailingBlockId } from "./text";
import { BlockKind, findTables, rangeFingerprint } from "./tokenize";

export type CleanMode = "mark" | "remove" | "link";
export type SkipReason = "recent" | "stale" | "missing" | "unsupported" | "dependency" | "edited" | "cancelled" | "header";

/** One duplicate group together with the occurrence to keep and the ones to clean. */
export interface PlanItem {
  group: DupGroup;
  keep: Occurrence;
  remove: Occurrence[];
}

export interface ReplaceEdit {
  type: "replace";
  s: number;
  e: number;
  /** Fingerprint the lines must still have when the edit is applied. */
  expect: string;
  /** Replacement lines; empty to delete the range. */
  lines: string[];
  kind: BlockKind;
  /** Original lines, for the preview. */
  before: string[];
  /** Block-id edit (`path#id`) that must have been applied first. */
  dep?: string;
  /** Row edits that must all be applied for this edit (table header) to be applied. */
  needs?: number[];
  groupId: string;
  keepPath: string;
}

export interface BlockIdEdit {
  type: "blockid";
  s: number;
  e: number;
  line: number;
  expect: string;
  id: string;
  key: string;
  groupId: string;
}

export interface PropEdit {
  type: "prop";
  /** Wikilinks (`[[note]]`) to the notes that were kept. */
  values: string[];
}

export type Edit = ReplaceEdit | BlockIdEdit | PropEdit;

export interface PlanFile {
  path: string;
  edits: Edit[];
}

export interface PlanSkip {
  path: string;
  reason: SkipReason;
  groupId?: string;
  detail?: string;
}

export interface Plan {
  mode: CleanMode;
  files: PlanFile[];
  skipped: PlanSkip[];
  /** Blocks that will be removed, replaced or marked. */
  blocks: number;
  chars: number;
  words: number;
  /** Number of notes that are only modified because they are kept (block id added). */
  keptNotes: number;
}

export interface PlanOptions {
  mode: CleanMode;
  /** Link text for `[[...]]` pointing at a note. */
  linkText: (path: string) => string;
  /** Visible label for link-style replacements. */
  linkLabel: (path: string) => string;
  /** true: `![[note#^id]]`, false: `[[note#^id|label]]`. */
  embed: boolean;
}

export function groupItem(group: DupGroup, keepIndex = 0): PlanItem {
  const keep = group.occs[Math.min(Math.max(0, keepIndex), group.occs.length - 1)];
  return { group, keep, remove: group.occs.filter((o) => o !== keep && o.f !== keep.f) };
}

export function newBlockId(key: string): string {
  return "cd-" + hash53(key).toString(36).slice(0, 6);
}

const LIST_PREFIX = /^(\s*)([-*+]|\d+[.)])\s+/;

function mkSkip(path: string, reason: SkipReason, groupId?: string, detail?: string): PlanSkip {
  return { path, reason, groupId, detail };
}

/**
 * Turns chosen duplicate groups into concrete per-note edits. `texts` holds the current content of every note involved;
 * a block whose lines no longer match what the scan saw is left out (reason "stale").
 */
export function buildPlan(items: PlanItem[], texts: Map<string, string>, opts: PlanOptions): Plan {
  const lineCache = new Map<string, string[]>();
  const linesOf = (path: string): string[] | null => {
    let l = lineCache.get(path);
    if (!l) {
      const t = texts.get(path);
      if (t === undefined) return null;
      l = t.split("\n");
      lineCache.set(path, l);
    }
    return l;
  };
  const verify = (o: Occurrence): boolean => {
    const l = linesOf(o.path);
    return !!l && rangeFingerprint(l, o.block.s, o.block.e) === o.block.h;
  };

  const files = new Map<string, Edit[]>();
  const skipped: PlanSkip[] = [];
  const add = (path: string, e: Edit) => {
    let l = files.get(path);
    if (!l) files.set(path, (l = []));
    l.push(e);
  };
  const keptOnly = new Set<string>();
  const blockIds = new Set<string>();
  let blocks = 0;
  let chars = 0;
  let words = 0;
  const propValues = new Map<string, Set<string>>();

  for (const item of items) {
    const keep = item.keep;
    if (!verify(keep)) {
      skipped.push(mkSkip(keep.path, "stale", item.group.id, "keep"));
      continue;
    }
    if (opts.mode === "link" && (keep.block.k === "tr" || keep.block.k === "code")) {
      skipped.push(mkSkip(keep.path, "unsupported", item.group.id, keep.block.k));
      continue;
    }
    const keepLines = linesOf(keep.path) as string[];
    let id = "";
    let dep: string | undefined;
    if (opts.mode === "link") {
      const idLine = keep.block.k === "li" ? keep.block.s : keep.block.e;
      const existing = trailingBlockId(keepLines[idLine]);
      id = existing ?? newBlockId(`${keep.path}|${keep.block.h}|${keep.block.s}`);
      dep = `${keep.path}#${id}`;
      if (!existing && !blockIds.has(dep)) {
        blockIds.add(dep);
        add(keep.path, { type: "blockid", s: keep.block.s, e: keep.block.e, line: idLine, expect: keep.block.h, id, key: dep, groupId: item.group.id });
        keptOnly.add(keep.path);
      }
    }
    for (const o of item.remove) {
      if (!verify(o)) {
        skipped.push(mkSkip(o.path, "stale", item.group.id));
        continue;
      }
      const lines = linesOf(o.path) as string[];
      const before = lines.slice(o.block.s, o.block.e + 1);
      if (opts.mode === "mark") {
        let set = propValues.get(o.path);
        if (!set) propValues.set(o.path, (set = new Set()));
        set.add(`[[${opts.linkText(keep.path)}]]`);
      } else if (opts.mode === "remove") {
        add(o.path, { type: "replace", s: o.block.s, e: o.block.e, expect: o.block.h, lines: [], kind: o.block.k, before, groupId: item.group.id, keepPath: keep.path });
      } else {
        if (o.block.k === "tr" || o.block.k === "code") {
          skipped.push(mkSkip(o.path, "unsupported", item.group.id, o.block.k));
          continue;
        }
        const target = `${opts.linkText(keep.path)}#^${id}`;
        const ref = opts.embed ? `![[${target}]]` : `[[${target}|${opts.linkLabel(keep.path)}]]`;
        const prefix = o.block.k === "li" ? (LIST_PREFIX.exec(before[0]) ?? [""])[0] : "";
        const eol = before[before.length - 1].endsWith("\r") ? "\r" : "";
        add(o.path, { type: "replace", s: o.block.s, e: o.block.e, expect: o.block.h, lines: [prefix + ref + eol], kind: o.block.k, before, dep, groupId: item.group.id, keepPath: keep.path });
      }
      blocks++;
      chars += o.block.r;
      words += o.block.n;
    }
  }

  for (const [path, set] of propValues) add(path, { type: "prop", values: Array.from(set).sort() });

  // A table whose body rows are all removed goes away completely, header and delimiter included
  if (opts.mode === "remove") {
    for (const [path, edits] of files) {
      const rowEdits = edits.filter((e): e is ReplaceEdit => e.type === "replace" && e.kind === "tr");
      if (rowEdits.length === 0) continue;
      const removed = new Set(rowEdits.map((e) => e.s));
      const lines = linesOf(path) as string[];
      for (const t of findTables(lines)) {
        if (t.rows.length === 0 || !t.rows.every((r) => removed.has(r))) continue;
        const fp = rangeFingerprint(lines, t.header, t.delim);
        if (fp === null) continue;
        edits.push({
          type: "replace",
          s: t.header,
          e: t.delim,
          expect: fp,
          lines: [],
          kind: "tr",
          before: lines.slice(t.header, t.delim + 1),
          needs: t.rows.slice(),
          groupId: rowEdits[0].groupId,
          keepPath: rowEdits[0].keepPath,
        });
      }
    }
  }

  const out: PlanFile[] = [];
  for (const [path, edits] of files) {
    edits.sort((a, b) => editStart(a) - editStart(b));
    out.push({ path, edits });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { mode: opts.mode, files: out, skipped, blocks, chars, words, keptNotes: keptOnly.size };
}

function editStart(e: Edit): number {
  return e.type === "prop" ? -1 : e.s;
}

export interface ApplyEditsResult {
  text: string;
  applied: Edit[];
  skipped: { edit: Edit; reason: SkipReason }[];
}

/**
 * Applies line edits to a note's text. Each edit is checked against the block's fingerprint first, so anything edited since
 * the scan is skipped. `okDeps` lists block ids that exist; replacements that point to a missing one are skipped.
 */
export function applyEdits(text: string, edits: Edit[], okDeps?: Set<string>): ApplyEditsResult {
  const lines = text.split("\n");
  const applied: Edit[] = [];
  const skipped: { edit: Edit; reason: SkipReason }[] = [];
  const good: (ReplaceEdit | BlockIdEdit)[] = [];
  const lineEdits = edits.filter((e): e is ReplaceEdit | BlockIdEdit => e.type !== "prop");

  const stage = (list: (ReplaceEdit | BlockIdEdit)[]) => {
    for (const e of list) {
      if (e.type === "replace" && e.dep && okDeps && !okDeps.has(e.dep)) {
        skipped.push({ edit: e, reason: "dependency" });
      } else if (rangeFingerprint(lines, e.s, e.e) !== e.expect) {
        skipped.push({ edit: e, reason: "stale" });
      } else good.push(e);
    }
  };
  stage(lineEdits.filter((e) => !(e.type === "replace" && e.needs)));
  const goodStarts = new Set(good.filter((e) => e.type === "replace").map((e) => e.s));
  stage(
    lineEdits.filter((e) => {
      if (e.type === "replace" && e.needs) {
        if (!e.needs.every((n) => goodStarts.has(n))) {
          skipped.push({ edit: e, reason: "header" });
          return false;
        }
        return true;
      }
      return false;
    })
  );

  for (const e of good) {
    if (e.type !== "blockid") continue;
    const cr = lines[e.line].endsWith("\r");
    const base = lines[e.line].replace(/\r$/, "").replace(/\s+$/, "");
    lines[e.line] = `${base} ^${e.id}${cr ? "\r" : ""}`;
    applied.push(e);
  }
  const repl = good.filter((e): e is ReplaceEdit => e.type === "replace").sort((a, b) => b.s - a.s);
  for (const e of repl) {
    let count = e.e - e.s + 1;
    if (e.lines.length === 0) {
      // Do not leave two blank lines in a row where a block used to be
      const prevBlank = e.s === 0 || lines[e.s - 1].trim() === "";
      if (prevBlank && e.e + 1 < lines.length && lines[e.e + 1].trim() === "") count++;
    }
    lines.splice(e.s, count, ...e.lines);
    applied.push(e);
  }
  return { text: lines.join("\n"), applied, skipped };
}
