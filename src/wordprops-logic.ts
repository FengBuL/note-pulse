/* “字数属性”的纯逻辑：该不该跳过、该不该写入、写什么。不依赖 Obsidian API，所以可以直接单元测试。 */
import { countParts } from "./count";

export interface WordPropOptions {
  /** 字数属性名 */
  property: string;
  readingEnabled: boolean;
  /** 阅读时长属性名（单位：分钟） */
  readingProperty: string;
  /** 中日文阅读速度：字 / 分钟 */
  cjkPerMin: number;
  /** 其他文字阅读速度：词 / 分钟 */
  wordsPerMin: number;
  /** 新旧字数相差至少这么多才写入 */
  minChange: number;
  skipOutliers: boolean;
  outlierWords: number;
  /** 只处理这些文件夹；空表示整个仓库 */
  includeFolders: string[];
  /** 这些文件夹（以及看板里设置的“排除的文件夹”）不写入 */
  excludeFolders: string[];
}

export type SkipReason = "not-md" | "excluded" | "not-included" | "outlier" | "recent";

/** 刚被修改的文件（可能正在被别处编辑或同步）不碰 */
export const RECENT_MS = 2000;

export function inFolder(path: string, folder: string): boolean {
  return !!folder && (path === folder || path.startsWith(folder + "/"));
}

/** 只看路径和扩展名就能判断的跳过原因；返回 null 表示可以继续 */
export function pathSkipReason(path: string, extension: string, o: Pick<WordPropOptions, "includeFolders" | "excludeFolders">): SkipReason | null {
  if (extension.toLowerCase() !== "md") return "not-md";
  if (o.excludeFolders.some((f) => inFolder(path, f))) return "excluded";
  if (o.includeFolders.length > 0 && !o.includeFolders.some((f) => inFolder(path, f))) return "not-included";
  return null;
}

export function isRecentlyModified(mtime: number, now: number, windowMs = RECENT_MS): boolean {
  return now - mtime < windowMs;
}

export interface Computed {
  words: number;
  /** 阅读时长（分钟，向上取整；没有内容时为 0） */
  minutes: number;
}

export function readingMinutes(cjk: number, other: number, cjkPerMin: number, wordsPerMin: number): number {
  const c = cjkPerMin > 0 ? cjkPerMin : 400;
  const w = wordsPerMin > 0 ? wordsPerMin : 220;
  const m = cjk / c + other / w;
  if (cjk + other === 0) return 0;
  return Math.max(1, Math.ceil(m));
}

export function compute(text: string, o: Pick<WordPropOptions, "cjkPerMin" | "wordsPerMin">): Computed {
  const p = countParts(text);
  return { words: p.cjk + p.other, minutes: readingMinutes(p.cjk, p.other, o.cjkPerMin, o.wordsPerMin) };
}

export type WriteDecision =
  | { write: false; reason: "outlier" | "unchanged" | "empty" }
  | { write: true; words: number; minutes: number | null };

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * 根据笔记里现有的属性值决定要不要写。
 * - 属性不存在 / 不是数字（比如被写成了文本）：写入
 * - 与新值相差不足 minChange：不写（减少同步抖动）
 * - 完全相同：绝不写
 * - 空笔记且还没有这个属性：不写（不往空笔记里加 words: 0）
 */
export function decideWrite(existing: Record<string, unknown> | null | undefined, c: Computed, o: WordPropOptions): WriteDecision {
  if (o.skipOutliers && c.words > o.outlierWords) return { write: false, reason: "outlier" };
  const cur = existing ? existing[o.property] : undefined;
  const readingCur = existing ? existing[o.readingProperty] : undefined;
  const minChange = Math.max(1, Math.floor(o.minChange) || 1);

  if (!isNum(cur) && c.words === 0 && (!o.readingEnabled || readingCur === undefined)) return { write: false, reason: "empty" };

  let need = !isNum(cur) || Math.abs(cur - c.words) >= minChange;
  // 阅读时长只在它缺失 / 不是数字时单独触发写入；平时跟着字数一起更新，避免多写一次
  if (!need && o.readingEnabled && !isNum(readingCur)) need = true;
  if (!need) return { write: false, reason: "unchanged" };
  return { write: true, words: c.words, minutes: o.readingEnabled ? c.minutes : null };
}

/** 属性名合法性：不能为空、不能含冒号/换行等会破坏 YAML 的字符；不合法就退回默认值 */
export function sanitizeProperty(name: string, fallback: string): string {
  const t = name.trim();
  if (!t || /[:\n\r#"'{}[\],&*!|>%@`]/.test(t)) return fallback;
  return t;
}
