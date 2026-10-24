import { nameDate } from "./group";
import type { Analysis, DupGroup, FileRecord, OverlapPair } from "./group";

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

/** 共同部分至少这么长（加权长度，一个汉字算 2）才算“大面积重复”：大约 120 个汉字，或 240 个英文字符 */
export const MIN_SHARED_W = 240;

/** 共同部分至少占整篇笔记全文（含标题、短句、表格行这些没参与比对的部分）的这么多，才算大面积重复 */
export const MIN_NOTE_SHARE = 0.4;

/**
 * 看板上“重复内容”算的是笔记和笔记之间大面积重复的组合：一篇笔记至少 70% 的内容在另一篇里也有，
 * 而且共同部分不太少。零散的一两个句子、一两段话在别处出现过，不算。
 *
 * 比例原来只按“够长、参与比对的段落”算，一篇笔记里大部分是短句和表格时，两个长段落一样就显示成 100%。
 * 所以再按整篇全文量一遍：共同部分占其中一篇全文的 40% 以上才算；
 * 例外是两篇长度几乎一样（差不到 2%）而且参与比对的部分 90% 以上一样，那是一份复制品，剩下的短句也多半一样。
 * 用户在“重复内容清理”里已经忽略的段落不计入：这一对的共同段落全被忽略了，就不再显示。
 */
export function significantPairs(a: Analysis, ignored: ReadonlySet<string>): OverlapPair[] {
  const byId = new Map(a.groups.map((g) => [g.id, g]));
  const files = new Map(a.files.map((f) => [f.path, f]));
  return a.pairs.filter((p) => {
    if (p.sharedW < MIN_SHARED_W) return false;
    if (!p.groupIds.some((id) => {
      const g = byId.get(id);
      return !!g && !ignored.has(groupKey(g));
    })) return false;
    const fo = files.get(p.older);
    const fn = files.get(p.newer);
    if (!fo || !fn) return false;
    const share = Math.max(fn.len > 0 ? p.sharedChars / fn.len : 0, fo.len > 0 ? p.olderChars / fo.len : 0);
    return nearCopyOf(fo, fn, p) || share >= MIN_NOTE_SHARE;
  });
}

function nearCopyOf(fo: Pick<FileRecord, "len">, fn: Pick<FileRecord, "len">, p: OverlapPair): boolean {
  const longer = Math.max(fo.len, fn.len, 1);
  return Math.abs(fo.len - fn.len) <= longer * 0.02 && Math.min(p.olderRatio, p.newerRatio) >= 0.9;
}

/** 两篇几乎是同一份（长度差不到 2%，参与比对的部分 90% 以上一样）：清理时更合适的做法是留一篇、另一篇进回收站，而不是把几百个段落逐段标记 */
export function isNearCopy(a: Analysis, p: OverlapPair): boolean {
  const fo = a.files.find((f) => f.path === p.older);
  const fn = a.files.find((f) => f.path === p.newer);
  return !!fo && !!fn && nearCopyOf(fo, fn, p);
}

/** 这一对怎么说：哪一篇的重复比例更高（“A 有 85% 和 B 重复”），以及是多少 */
export function pairWording(p: OverlapPair): { name: string; other: string; pct: number } {
  return p.newerRatio >= p.olderRatio
    ? { name: p.newer, other: p.older, pct: Math.round(p.newerRatio * 100) }
    : { name: p.older, other: p.newer, pct: Math.round(p.olderRatio * 100) };
}

/** 清理这些笔记对能减少多少字符：每篇较新的笔记按它和别的笔记共同部分里最多的那个算，免得重复计数 */
export function pairReclaimChars(pairs: OverlapPair[]): number {
  const byNewer = new Map<string, number>();
  for (const p of pairs) byNewer.set(p.newer, Math.max(byNewer.get(p.newer) ?? 0, p.sharedChars));
  let sum = 0;
  for (const v of byNewer.values()) sum += v;
  return sum;
}
