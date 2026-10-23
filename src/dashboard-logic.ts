/* 看板用到的纯计算：不依赖 Obsidian API，便于单元测试 */
import type { TFile } from "obsidian";
import { addDays, dayKey, isCheckinDay, startOfDay } from "./stats";
import type { FileStat, VaultStats } from "./stats";
import { weekdayLetter, weekdayName } from "./i18n";
import type { LinkSuggestion } from "./checkup-logic";


/** 本地日历周的周一 */
export function weekStart(d: Date): Date {
  const x = startOfDay(d);
  return addDays(x, -((x.getDay() + 6) % 7));
}

function sumWords(s: VaultStats, from: Date, toInclusive: Date): number {
  let n = 0;
  for (let d = new Date(from); d.getTime() <= toInclusive.getTime(); d = addDays(d, 1)) n += s.dayWords[dayKey(d)] || 0;
  return n;
}

/* ---------------- 本周七天 ---------------- */

export interface WeekDay {
  key: string;
  label: string;
  words: number;
  done: boolean;
  future: boolean;
  isToday: boolean;
  /** 写了但没达标时，占每日目标的百分比（0–99）；其余情况为 null */
  pct: number | null;
}

/** 周一到周日；打卡规则与看板、周报一致 */
export function weekDays(s: VaultStats, goal: number, now: Date): WeekDay[] {
  const today = startOfDay(now);
  const start = weekStart(now);
  const out: WeekDay[] = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(start, i);
    const key = dayKey(d);
    const future = d.getTime() > today.getTime();
    const words = future ? 0 : s.dayWords[key] || 0;
    const done = !future && isCheckinDay(s, goal, key);
    const pct = !future && !done && goal > 0 && words > 0 ? Math.min(99, Math.floor((words / goal) * 100)) : null;
    out.push({ key, label: weekdayLetter(d.getDay()), words, done, future, isToday: d.getTime() === today.getTime(), pct });
  }
  return out;
}

/* ---------------- 页首一句话 ---------------- */

export interface Headline {
  weekWords: number;
  /** 上周同一时段（周一到上周的今天）的字数 */
  prevWords: number;
  /** 相对上周同期的变化百分比；上周同期为 0 时为 null */
  changePct: number | null;
  todayWords: number;
  todayDone: boolean;
  dueToday: number;
  overdue: number;
}

export function headline(s: VaultStats, goal: number, now: Date): Headline {
  const today = startOfDay(now);
  const start = weekStart(now);
  const weekWords = sumWords(s, start, today);
  const prevWords = sumWords(s, addDays(start, -7), addDays(today, -7));
  const changePct = prevWords > 0 ? Math.round(((weekWords - prevWords) / prevWords) * 100) : null;
  const todayKey = dayKey(today);
  return {
    weekWords,
    prevWords,
    changePct,
    todayWords: s.dayWords[todayKey] || 0,
    todayDone: isCheckinDay(s, goal, todayKey),
    dueToday: s.tasks.dueSoon.filter((t) => t.due === todayKey).length,
    overdue: s.tasks.overdue.length,
  };
}

/* ---------------- 数据卡小趋势线（按周） ---------------- */

export interface WeekPoint {
  start: Date;
  /** 包含在内的最后一天（本周为今天） */
  end: Date;
  value: number;
  /** 这一周内的增量（累计类指标）或附带数值（打卡类：当周字数） */
  extra: number;
}

/** 近 n 周，每周结束时的累计新建笔记数（不含采集文件夹） */
export function weeklyNotes(s: VaultStats, weeks: number, now: Date): WeekPoint[] {
  return weeklyCumulative(s.files, weeks, now, () => 1);
}

/** 近 n 周，每周结束时累计的写作字数（写作口径，按创建日期计） */
export function weeklyWords(s: VaultStats, weeks: number, now: Date): WeekPoint[] {
  return weeklyCumulative(s.files, weeks, now, (f) => f.writeWords);
}

function weeklyCumulative(files: FileStat[], weeks: number, now: Date, weight: (f: FileStat) => number): WeekPoint[] {
  const today = startOfDay(now);
  const first = addDays(weekStart(now), -(weeks - 1) * 7);
  const sorted = files.filter((f) => !f.collected).sort((a, b) => a.created - b.created);
  let p = 0,
    cum = 0;
  const upTo = (endExclusive: number) => {
    while (p < sorted.length && sorted[p].created < endExclusive) cum += weight(sorted[p++]);
    return cum;
  };
  let prev = upTo(first.getTime());
  const out: WeekPoint[] = [];
  for (let w = 0; w < weeks; w++) {
    const start = addDays(first, w * 7);
    const end = w === weeks - 1 ? today : addDays(start, 6);
    const value = upTo(addDays(end, 1).getTime());
    out.push({ start, end, value, extra: value - prev });
    prev = value;
  }
  return out;
}

/** 近 n 周，每周的打卡天数（extra 为当周写作字数） */
export function weeklyCheckins(s: VaultStats, goal: number, weeks: number, now: Date): WeekPoint[] {
  const today = startOfDay(now);
  const first = addDays(weekStart(now), -(weeks - 1) * 7);
  const out: WeekPoint[] = [];
  for (let w = 0; w < weeks; w++) {
    const start = addDays(first, w * 7);
    const end = w === weeks - 1 ? today : addDays(start, 6);
    let days = 0,
      words = 0;
    for (let d = new Date(start); d.getTime() <= end.getTime(); d = addDays(d, 1)) {
      const k = dayKey(d);
      if (isCheckinDay(s, goal, k)) days++;
      words += s.dayWords[k] || 0;
    }
    out.push({ start, end, value: days, extra: words });
  }
  return out;
}

/** 本月打卡天数和日均字数（日均按本月已过天数算） */
export function monthWriting(s: VaultStats, goal: number, now: Date): { days: number; words: number; elapsed: number; average: number } {
  const today = startOfDay(now);
  const start = new Date(today.getFullYear(), today.getMonth(), 1);
  let days = 0,
    words = 0,
    elapsed = 0;
  for (let d = new Date(start); d.getTime() <= today.getTime(); d = addDays(d, 1)) {
    const k = dayKey(d);
    elapsed++;
    words += s.dayWords[k] || 0;
    if (isCheckinDay(s, goal, k)) days++;
  }
  return { days, words, elapsed, average: elapsed ? Math.round(words / elapsed) : 0 };
}

/* ---------------- 每周写作（趋势卡） ---------------- */

export type TrendRange = 30 | 182 | 365;
export type TrendMetric = "words" | "notes";

export interface TrendBucket {
  start: Date;
  end: Date;
  value: number;
  checkins: number;
}

export interface TrendModel {
  gran: "day" | "week";
  buckets: TrendBucket[];
  total: number;
  average: number;
  best: TrendBucket | null;
}

/** 30 天按天；半年和一年按自然周汇总。字数来自每日写作记录（与热力图同一来源），笔记数来自每日新建 */
export function trendModel(s: VaultStats, range: TrendRange, metric: TrendMetric, goal: number, now: Date): TrendModel {
  const today = startOfDay(now);
  const gran = range === 30 ? "day" : "week";
  const first = gran === "day" ? addDays(today, -(range - 1)) : addDays(weekStart(now), -(Math.round(range / 7) - 1) * 7);
  const buckets: TrendBucket[] = [];
  for (let start = new Date(first); start.getTime() <= today.getTime(); start = addDays(start, gran === "day" ? 1 : 7)) {
    const last = gran === "day" ? start : addDays(start, 6);
    const end = last.getTime() > today.getTime() ? today : last;
    let value = 0,
      checkins = 0;
    for (let d = new Date(start); d.getTime() <= end.getTime(); d = addDays(d, 1)) {
      const k = dayKey(d);
      value += metric === "words" ? s.dayWords[k] || 0 : s.dayCreated[k] || 0;
      if (isCheckinDay(s, goal, k)) checkins++;
    }
    buckets.push({ start, end, value, checkins });
  }
  const total = buckets.reduce((a, b) => a + b.value, 0);
  let best: TrendBucket | null = null;
  for (const b of buckets) if (b.value > 0 && (!best || b.value > best.value)) best = b;
  return { gran, buckets, total, average: buckets.length ? Math.round(total / buckets.length) : 0, best };
}

/** 一段时间里写得最多的星期几（按字数合计）；没有写作时为 null */
export function busiestWeekday(s: VaultStats, from: Date, to: Date): string | null {
  const sums = [0, 0, 0, 0, 0, 0, 0];
  for (let d = startOfDay(from); d.getTime() <= to.getTime(); d = addDays(d, 1)) sums[d.getDay()] += s.dayWords[dayKey(d)] || 0;
  let best = -1;
  for (let i = 0; i < 7; i++) if (sums[i] > 0 && (best < 0 || sums[i] > sums[best])) best = i;
  return best < 0 ? null : weekdayName(best);
}

/* ---------------- 库体检 ---------------- */

export interface CheckupModel {
  /** 能修的（有唯一建议）排在前面，其余按出现次数 */
  unresolved: { name: string; count: number; source: string | null; fix: LinkSuggestion | null; from: string[] }[];
  unresolvedCount: number;
  orphans: TFile[];
  empty: FileStat[];
  big: FileStat[];
  sameName: string[][];
  unusedAttachments: TFile[];
}

/**
 * 空笔记：没有正文字数、没有链接、没有嵌入。只有模板属性或只有一张图片的笔记不算空。
 * 超大笔记：超过阈值、不在采集文件夹里的笔记。
 */
export function checkupModel(s: VaultStats): CheckupModel {
  const source = s.links.unresolvedSource || {};
  const sug = s.links.suggestions || {};
  const from = s.links.unresolvedFrom || {};
  const unresolved = s.links.topUnresolved.map(([name, count]) => ({ name, count, source: source[name] ?? null, fix: sug[name] ?? null, from: from[name] ?? [] }));
  unresolved.sort((a, b) => Number(!!b.fix) - Number(!!a.fix) || b.count - a.count);
  return {
    unresolved,
    sameName: s.links.sameName || [],
    unusedAttachments: [...(s.links.unusedAttachments || [])].sort((a, b) => b.stat.size - a.stat.size),
    unresolvedCount: s.links.unresolvedCount,
    orphans: [...s.links.orphans].sort((a, b) => b.stat.mtime - a.stat.mtime),
    empty: s.files.filter((f) => f.words === 0 && f.links === 0 && (f.embeds ?? 0) === 0).sort((a, b) => b.mtime - a.mtime),
    big: s.files.filter((f) => f.big && !f.collected).sort((a, b) => b.words - a.words),
  };
}
