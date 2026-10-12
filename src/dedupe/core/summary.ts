import { nameDate } from "./group";
import type { Analysis, DupGroup, FileRecord } from "./group";

/** A key that stays the same across scans for "the same repeated content", used to remember ignored items. */
export function groupKey(g: DupGroup): string {
  const first = g.occs[0]?.block;
  if (!first) return g.id;
  return g.kind === "post" && first.sid ? `s:${first.sid}` : `h:${first.h}`;
}

export interface Overview {
  /** Items still shown (not ignored), in display order. */
  groups: DupGroup[];
  /** Distinct notes that contain at least one shown item. */
  notes: number;
  /** Words (Han characters count one each) that cleaning every shown item would save. */
  words: number;
  chars: number;
  ignored: number;
}

/** What the results page summarises in one sentence: items left after ignoring, and how many notes they touch. */
export function overview(a: Analysis, ignored: ReadonlySet<string>): Overview {
  const groups: DupGroup[] = [];
  const notes = new Set<number>();
  let words = 0;
  let chars = 0;
  let ign = 0;
  for (const g of a.groups) {
    if (ignored.has(groupKey(g))) {
      ign++;
      continue;
    }
    groups.push(g);
    for (const o of g.occs) notes.add(o.f);
    words += g.reclaimWords;
    chars += g.reclaimChars;
  }
  return { groups, notes: notes.size, words, chars, ignored: ign };
}

/** The date a person would call "when this note is from": the date in its file name, otherwise when it was created. */
export function noteDay(file: Pick<FileRecord, "path" | "ctime">): string {
  const nd = nameDate(file.path);
  if (nd) return `${nd.slice(0, 4)}-${nd.slice(4, 6)}-${nd.slice(6, 8)}`;
  const d = new Date(file.ctime);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Block text made readable for a preview: Markdown markers and table pipes removed, whitespace collapsed. */
export function readablePreview(raw: string, max = 600): string {
  const lines = raw
    .replace(/\r/g, "")
    .split("\n")
    .map((l) =>
      l
        .replace(/^\s*>\s?/, "")
        .replace(/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, "")
        .replace(/^\s*#{1,6}\s+/, "")
        .replace(/^\s*\|\s*|\s*\|\s*$/g, "")
        .replace(/\s*\|\s*/g, " · ")
        .replace(/\*\*|__|`/g, "")
        .replace(/\s+\^[\w-]+$/, "")
        .trim()
    )
    .filter((l) => l.length > 0 && !/^[-:· ]+$/.test(l));
  const s = lines.join("\n");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
