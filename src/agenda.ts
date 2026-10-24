/* 日历卡片：日程数据和月历计算。纯函数，不依赖 Obsidian API，便于单元测试。 */

export interface AgendaItem {
  id: string;
  text: string;
  done: boolean;
}

/** 日期（YYYY-MM-DD）→ 当天的日程，按添加顺序 */
export type Agenda = Record<string, AgendaItem[]>;

export const MAX_ITEM_CHARS = 200;
const KEY = /^\d{4}-\d{2}-\d{2}$/;

const pad = (n: number) => String(n).padStart(2, "0");

export function keyOf(year: number, month: number, day: number): string {
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}

export function isDateKey(k: string): boolean {
  if (!KEY.test(k)) return false;
  const [y, m, d] = k.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** 读到的日程可能被同步弄坏或被手改：只留日期合法、文字非空的条目；文字截到上限；空的日期去掉 */
export function sanitizeAgenda(raw: unknown): Agenda {
  const out: Agenda = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isDateKey(k) || !Array.isArray(v)) continue;
    const seen = new Set<string>();
    const items: AgendaItem[] = [];
    for (const it of v) {
      if (!it || typeof it !== "object") continue;
      const { id, text, done } = it as { id?: unknown; text?: unknown; done?: unknown };
      if (typeof text !== "string" || !text.trim()) continue;
      let useId = typeof id === "string" && id && !seen.has(id) ? id : `i${++n}${k.replace(/-/g, "")}`;
      while (seen.has(useId)) useId += "x";
      seen.add(useId);
      items.push({ id: useId, text: text.trim().slice(0, MAX_ITEM_CHARS), done: done === true });
    }
    if (items.length) out[k] = items;
  }
  return out;
}

export function itemsOn(a: Agenda, key: string): AgendaItem[] {
  return a[key] ?? [];
}

/** 加一条；空文字不加 */
export function addAgendaItem(a: Agenda, key: string, text: string, id: string): Agenda {
  const t = text.trim().slice(0, MAX_ITEM_CHARS);
  if (!t || !isDateKey(key)) return a;
  return { ...a, [key]: [...itemsOn(a, key), { id, text: t, done: false }] };
}

export function toggleAgendaItem(a: Agenda, key: string, id: string): Agenda {
  const list = itemsOn(a, key);
  if (!list.some((i) => i.id === id)) return a;
  return { ...a, [key]: list.map((i) => (i.id === id ? { ...i, done: !i.done } : i)) };
}

export function removeAgendaItem(a: Agenda, key: string, id: string): Agenda {
  const list = itemsOn(a, key);
  if (!list.some((i) => i.id === id)) return a;
  const rest = list.filter((i) => i.id !== id);
  const out = { ...a };
  if (rest.length) out[key] = rest;
  else delete out[key];
  return out;
}

export interface CalendarCell {
  key: string;
  day: number;
  /** 属于正在看的这个月（否则是前后月补齐的几天） */
  inMonth: boolean;
}

/** 一个月的月历：固定 6 周 × 7 天，周一在前（和热力图一致），前后用相邻月份的日子补齐。month 为 0–11 */
export function monthGrid(year: number, month: number): CalendarCell[] {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7;
  const cells: CalendarCell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(year, month, 1 - lead + i);
    cells.push({ key: keyOf(d.getFullYear(), d.getMonth(), d.getDate()), day: d.getDate(), inMonth: d.getMonth() === month });
  }
  return cells;
}

/** 往前后翻 delta 个月 */
export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const d = new Date(year, month + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() };
}
