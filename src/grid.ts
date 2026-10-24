/*
 * 2.0 网格引擎：12 列，每张卡存 x, y, w, h（列、行、占几列、占几行），按格子吸附。
 * 全是纯函数，不依赖 DOM 和 Obsidian：碰撞、上浮（重力）、拖动让位、调大小夹范围、找空位、读坏数据后修复。
 * 做法和 gridstack / react-grid-layout 一致，但“让位”的规则更简单，结果只取决于拖动开始时的布局和当前位置，
 * 和中间走过的路径无关（所以拖动中卡片不会来回抖）。
 */

export const COLS = 12;
/** 一行 40px，行间距 16px：h 行的高度 = 40h + 16(h − 1)。数字卡 3 行正好 152px */
export const ROW_H = 40;
export const GAP = 16;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GridItem extends Rect {
  id: string;
}

export interface Limits {
  minW: number;
  maxW: number;
  minH: number;
  maxH: number;
}

export type LimitsOf = (id: string) => Limits;

export const rowsToPx = (h: number): number => ROW_H * h + GAP * (h - 1);

export function overlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

const byPos = (a: Rect, b: Rect): number => a.y - b.y || a.x - b.x;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** 整数化；不是有限数字时用 fallback */
function int(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;
}

/** 总共占几行 */
export function totalRows(items: Rect[]): number {
  return items.reduce((m, i) => Math.max(m, i.y + i.h), 0);
}

/** 按阅读顺序（从上到下、从左到右）排列，不改动原数组 */
export function inReadingOrder<T extends Rect>(items: T[]): T[] {
  return [...items].sort(byPos);
}

/**
 * 上浮：每张卡往上挪到不能再挪为止，版面不会留洞。
 * 要求输入没有重叠。结果是固定点：再调用一次不会有任何变化。
 */
export function compact<T extends GridItem>(items: T[]): T[] {
  const out = items.map((i) => ({ ...i })).sort(byPos);
  let changed = true;
  while (changed) {
    changed = false;
    out.sort(byPos);
    for (const it of out) {
      let y = it.y;
      while (y > 0 && !out.some((o) => o !== it && overlap(o, { ...it, y: y - 1 }))) y--;
      if (y !== it.y) {
        it.y = y;
        changed = true;
      }
    }
  }
  return out.sort(byPos);
}

/** 不碰 others 里任何一个的最小 y（从 from 往下找） */
function firstFreeY(others: Rect[], r: Rect, from = 0): number {
  const bottom = totalRows(others);
  for (let y = Math.max(0, from); y < bottom; y++) {
    if (!others.some((o) => overlap(o, { ...r, y }))) return y;
  }
  return Math.max(from, bottom);
}

/**
 * 把 pin 钉在它现在的位置，被它挡住的卡片让开，然后整体上浮。
 * - 让位：先看能不能放到 pin 正上方（拖动时），放不下或者是调大小，就放到下面；
 * - 没被挡住的卡片原地不动，只会因为让出来的空位往上补。
 */
function settle<T extends GridItem>(items: T[], pin: T, mode: "move" | "resize"): T[] {
  const rest = items.filter((i) => i.id !== pin.id).sort(byPos);
  const placed: T[] = [pin];
  const moving: T[] = [];
  for (const it of rest) (overlap(it, pin) ? moving : placed).push(it);
  for (const it of moving) {
    let y = -1;
    if (mode === "move") {
      const above = pin.y - it.h;
      if (above >= 0 && !placed.some((o) => overlap(o, { ...it, y: above }))) y = above;
    }
    if (y < 0) y = firstFreeY(placed, it, pin.y);
    placed.push({ ...it, y });
  }
  return compact(placed);
}

/**
 * 拖动：把 id 这张卡的左上角放到格子 (x, y)。
 * 返回整个新布局（已上浮），这张卡自己的最终位置就是占位框该出现的地方。
 */
export function moveItem<T extends GridItem>(items: T[], id: string, x: number, y: number): T[] {
  const cur = items.find((i) => i.id === id);
  if (!cur) return items;
  const pin = { ...cur, x: clamp(int(x, cur.x), 0, COLS - cur.w), y: Math.max(0, int(y, cur.y)) };
  return settle(items, pin, "move");
}

/** 调大小：夹在这张卡的范围里，也不超出右边界（右边放不下时不挪左边，只是不能再变宽） */
export function resizeItem<T extends GridItem>(items: T[], id: string, w: number, h: number, limitsOf: LimitsOf): T[] {
  const cur = items.find((i) => i.id === id);
  if (!cur) return items;
  const lim = limitsOf(id);
  const nw = clamp(int(w, cur.w), lim.minW, Math.min(lim.maxW, COLS));
  const nh = clamp(int(h, cur.h), lim.minH, lim.maxH);
  const pin = { ...cur, w: nw, h: nh, x: clamp(cur.x, 0, COLS - nw) };
  return settle(items, pin, "resize");
}

/** 这张卡在当前位置最大能调到多大（右边界和别的卡不限制，只看自己的范围） */
export function sizeRange(cur: GridItem, limitsOf: LimitsOf): { maxW: number; maxH: number } {
  const lim = limitsOf(cur.id);
  return { maxW: Math.min(lim.maxW, COLS - cur.x), maxH: lim.maxH };
}

/** 键盘：移动一格（dx 列、dy 行） */
export function nudgeItem<T extends GridItem>(items: T[], id: string, dx: number, dy: number): T[] {
  const cur = items.find((i) => i.id === id);
  return cur ? moveItem(items, id, cur.x + dx, cur.y + dy) : items;
}

/** 键盘：调大小一格 */
export function growItem<T extends GridItem>(items: T[], id: string, dw: number, dh: number, limitsOf: LimitsOf): T[] {
  const cur = items.find((i) => i.id === id);
  return cur ? resizeItem(items, id, cur.w + dw, cur.h + dh, limitsOf) : items;
}

/**
 * 找第一个放得下 w × h 的位置，从最后一行开始往下找：
 * 最后一行右边有空位就放在那里，没有就另起一行。
 */
export function findSpot(items: Rect[], w: number, h: number): { x: number; y: number } {
  const ww = clamp(int(w, 1), 1, COLS);
  const hh = Math.max(1, int(h, 1));
  const start = items.reduce((m, i) => Math.max(m, i.y), 0);
  const end = totalRows(items);
  for (let y = start; y <= end; y++) {
    for (let x = 0; x + ww <= COLS; x++) {
      if (!items.some((o) => overlap(o, { x, y, w: ww, h: hh }))) return { x, y };
    }
  }
  return { x: 0, y: end };
}

/** 加一张卡：放在 findSpot 找到的位置 */
export function addItem<T extends GridItem>(items: T[], item: T): T[] {
  if (items.some((i) => i.id === item.id)) return items;
  const spot = findSpot(items, item.w, item.h);
  return compact([...items, { ...item, ...spot }]);
}

export function removeItem<T extends GridItem>(items: T[], id: string): T[] {
  return compact(items.filter((i) => i.id !== id));
}

/**
 * 读到的位置可能来自别的版本、被同步弄坏或被手改：
 * 去掉重复的卡（保留第一张）；尺寸取整并夹进范围；越界的拉回；重叠的往下推开；最后整体上浮。
 * known(id) 返回 false 的卡（已经不存在的卡）直接丢掉。
 */
export function repairItems(raw: unknown[], limitsOf: LimitsOf, known: (id: string) => boolean): GridItem[] {
  const seen = new Set<string>();
  const cleaned: GridItem[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const { id, x, y, w, h } = r as Record<string, unknown>;
    if (typeof id !== "string" || !known(id) || seen.has(id)) continue;
    const lim = limitsOf(id);
    const nw = clamp(int(w, lim.minW), lim.minW, Math.min(lim.maxW, COLS));
    const nh = clamp(int(h, lim.minH), lim.minH, lim.maxH);
    seen.add(id);
    cleaned.push({ id, w: nw, h: nh, x: clamp(int(x, 0), 0, COLS - nw), y: Math.max(0, int(y, 0)) });
  }
  const placed: GridItem[] = [];
  for (const it of cleaned.sort(byPos)) {
    placed.push(overlap2(placed, it) ? { ...it, y: firstFreeY(placed, it, it.y) } : it);
  }
  return compact(placed);
}

const overlap2 = (others: Rect[], r: Rect): boolean => others.some((o) => overlap(o, r));

/**
 * 旧布局（档位）→ 网格：按原来的顺序从左到右、从上到下摆。
 * 一行放不下就换行，换行的位置在这一行最高那张卡的下面；摆完整体上浮，矮卡下面的卡会补上来。
 */
export function flowItems(entries: { id: string; w: number; h: number }[]): GridItem[] {
  const out: GridItem[] = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const e of entries) {
    const w = clamp(int(e.w, 1), 1, COLS);
    if (x + w > COLS) {
      x = 0;
      y += rowH;
      rowH = 0;
    }
    out.push({ id: e.id, x, y, w, h: Math.max(1, int(e.h, 1)) });
    x += w;
    rowH = Math.max(rowH, e.h);
  }
  return compact(out);
}
