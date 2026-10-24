/*
 * 合并卡和新卡片用的纯计算：写作趋势的各种指标、笔记长度分布、本月对比上月、目标进度、最近编辑。
 * 只用看板已经统计好的数据，不增加统计成本；不依赖 Obsidian API，便于单元测试。
 */
import { Say } from "./moments";
import { TrendRange, headline, monthWriting, trendModel, weekStart, weeklyCheckins, weeklyNotes, weeklyWords } from "./dashboard-logic";
import { FileStat, VaultStats, addDays, dayKey, isCheckinDay, startOfDay } from "./stats";

/* ---------------- 写作趋势：五种指标 ---------------- */

export type HubMetric = "words" | "notes" | "totalNotes" | "totalWords" | "checkins";
export const HUB_METRICS: HubMetric[] = ["words", "notes", "totalNotes", "totalWords", "checkins"];

export interface HubBucket {
  start: Date;
  end: Date;
  /** 画在图上的值：累计类是这一段结束时的累计数，其余是这一段的数 */
  value: number;
  /** 这一段新增的量（累计类是这一段新增，其余等于 value），合计、平均、最高都按它算 */
  gain: number;
  /** 这一段里打卡的天数 */
  checkins: number;
}

export interface HubSeries {
  gran: "day" | "week";
  buckets: HubBucket[];
  cumulative: boolean;
  /** 合计（累计类是这段时间新增了多少）、每段平均、新增最多的一段 */
  total: number;
  average: number;
  best: HubBucket | null;
}

/** 范围换算成周数（累计类和打卡按周画） */
export const weeksOf = (range: TrendRange): number => (range === 30 ? 5 : range === 182 ? 26 : 52);

export function hubSeries(s: VaultStats, metric: HubMetric, range: TrendRange, goal: number, now: Date): HubSeries {
  if (metric === "words" || metric === "notes") {
    const m = trendModel(s, range, metric, goal, now);
    const buckets = m.buckets.map((b) => ({ start: b.start, end: b.end, value: b.value, gain: b.value, checkins: b.checkins }));
    return { gran: m.gran, buckets, cumulative: false, total: m.total, average: m.average, best: m.best ? { start: m.best.start, end: m.best.end, value: m.best.value, gain: m.best.value, checkins: m.best.checkins } : null };
  }
  const weeks = weeksOf(range);
  const pts = metric === "totalNotes" ? weeklyNotes(s, weeks, now) : metric === "totalWords" ? weeklyWords(s, weeks, now) : weeklyCheckins(s, goal, weeks, now);
  const cumulative = metric === "totalNotes" || metric === "totalWords";
  const buckets: HubBucket[] = pts.map((p) => ({
    start: p.start,
    end: p.end,
    value: p.value,
    gain: cumulative ? p.extra : p.value,
    checkins: metric === "checkins" ? p.value : 0,
  }));
  const total = buckets.reduce((a, b) => a + b.gain, 0);
  const best = buckets.reduce<HubBucket | null>((m, b) => (!m || b.gain > m.gain ? b : m), null);
  return { gran: "week", buckets, cumulative, total, average: buckets.length ? Math.round(total / buckets.length) : 0, best: best && best.gain > 0 ? best : null };
}

/* ---------------- 笔记长度分布 ---------------- */

export type LengthBucketId = "empty" | "tiny" | "short" | "medium" | "long" | "huge";

export interface LengthBucket {
  id: LengthBucketId;
  /** 含下界、不含上界（huge 没有上界） */
  min: number;
  max: number;
  count: number;
}

const LENGTH_EDGES: [LengthBucketId, number, number][] = [
  ["empty", 0, 1],
  ["tiny", 1, 100],
  ["short", 100, 500],
  ["medium", 500, 2000],
  ["long", 2000, 10000],
  ["huge", 10000, Infinity],
];

/** 笔记按字数分几档。采集文件夹里的不算（那不是你写的） */
export function lengthBuckets(s: VaultStats): LengthBucket[] {
  const out: LengthBucket[] = LENGTH_EDGES.map(([id, min, max]) => ({ id, min, max, count: 0 }));
  for (const f of s.files) {
    if (f.collected) continue;
    const b = out.find((x) => f.words >= x.min && f.words < x.max);
    if (b) b.count++;
  }
  return out;
}

/* ---------------- 本月对比上月 ---------------- */

export interface MonthRow {
  key: "words" | "notes" | "checkins";
  cur: number;
  prev: number;
  /** 比上月同期多或少多少（整数百分比）；上月是 0 时为 null */
  changePct: number | null;
}

export interface MonthCompare {
  /** 本月到今天一共几天，上月也取同样的天数（上月不够长就取整月） */
  elapsed: number;
  rows: MonthRow[];
}

function sumRange(s: VaultStats, from: Date, to: Date, goal: number): { words: number; notes: number; checkins: number } {
  let words = 0;
  let notes = 0;
  let checkins = 0;
  for (let d = new Date(from); d.getTime() <= to.getTime(); d = addDays(d, 1)) {
    const k = dayKey(d);
    words += s.dayWords[k] || 0;
    notes += s.dayCreated[k] || 0;
    if (isCheckinDay(s, goal, k)) checkins++;
  }
  return { words, notes, checkins };
}

/** 本月到今天，和上个月同样天数的对比：写作字数、新建笔记、打卡天数 */
export function monthCompare(s: VaultStats, goal: number, now: Date): MonthCompare {
  const today = startOfDay(now);
  const start = new Date(today.getFullYear(), today.getMonth(), 1);
  const elapsed = today.getDate();
  const prevStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const prevDays = new Date(today.getFullYear(), today.getMonth(), 0).getDate();
  const prevEnd = addDays(prevStart, Math.min(elapsed, prevDays) - 1);
  const cur = sumRange(s, start, today, goal);
  const prev = sumRange(s, prevStart, prevEnd, goal);
  const row = (key: MonthRow["key"]): MonthRow => ({ key, cur: cur[key], prev: prev[key], changePct: prev[key] > 0 ? Math.round(((cur[key] - prev[key]) / prev[key]) * 100) : null });
  return { elapsed, rows: [row("words"), row("notes"), row("checkins")] };
}

/* ---------------- 目标进度 ---------------- */

export interface GoalRing {
  key: "today" | "week" | "month";
  value: number;
  /** 目标（0 表示没设） */
  goal: number;
  /** 完成比例，最多 1 */
  ratio: number;
  unit: "words" | "days";
}

export function goalRings(s: VaultStats, o: { dailyGoal: number; weeklyGoal: number }, now: Date): GoalRing[] {
  const h = headline(s, o.dailyGoal, now);
  const m = monthWriting(s, o.dailyGoal, now);
  const ratio = (v: number, g: number) => (g > 0 ? Math.min(1, v / g) : v > 0 ? 1 : 0);
  return [
    { key: "today", value: h.todayWords, goal: o.dailyGoal, ratio: ratio(h.todayWords, o.dailyGoal), unit: "words" },
    { key: "week", value: h.weekWords, goal: o.weeklyGoal, ratio: ratio(h.weekWords, o.weeklyGoal), unit: "words" },
    // 本月：打卡的天数占已经过去的天数
    { key: "month", value: m.days, goal: m.elapsed, ratio: ratio(m.days, m.elapsed), unit: "days" },
  ];
}

/* ---------------- 最近编辑 ---------------- */

/** 最近改动过的笔记，最新的在前（含采集文件夹里的：那也是你最近动过的） */
export function recentNotes(s: VaultStats, limit = 50): FileStat[] {
  return [...s.files].sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

/** “刚刚 / 12 分钟前 / 3 小时前 / 昨天 / 5 天前 / 3 周前 / 2 个月前” */
export function relativeTime(then: number, now: number, t: Say): string {
  const min = Math.floor((now - then) / 60000);
  if (min < 1) return t("刚刚", "just now");
  if (min < 60) return t(`${min} 分钟前`, `${min} min ago`);
  const h = Math.floor(min / 60);
  if (h < 24) return t(`${h} 小时前`, `${h} h ago`);
  const todayStart = startOfDay(new Date(now)).getTime();
  const days = Math.max(1, Math.ceil((todayStart - startOfDay(new Date(then)).getTime()) / 86400000));
  if (days === 1) return t("昨天", "yesterday");
  if (days < 7) return t(`${days} 天前`, `${days} days ago`);
  if (days < 30) return t(`${Math.floor(days / 7)} 周前`, `${Math.floor(days / 7)} w ago`);
  if (days < 365) return t(`${Math.floor(days / 30)} 个月前`, `${Math.floor(days / 30)} mo ago`);
  return t(`${Math.floor(days / 365)} 年前`, `${Math.floor(days / 365)} y ago`);
}

export { weekStart };
