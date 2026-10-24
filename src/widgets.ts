/* 2.0 小组件：卡片目录和网格布局。纯数据与纯函数，不依赖 Obsidian API，便于单元测试。 */
import { COLS, GridItem, Limits, addItem, compact, flowItems, repairItems } from "./grid";

export type WidgetId =
  | "hero"
  | "tasks"
  | "notes"
  | "words"
  | "taskRate"
  | "month"
  | "heat"
  | "trend"
  | "tags"
  | "reports"
  | "topLinked"
  | "rhythm"
  | "activity"
  | "taskNotes"
  | "density"
  | "folders"
  | "calendar"
  | "trendHub"
  | "overview"
  | "checkupHub"
  | "structure"
  | "habits"
  | "tasksHub"
  | "recent"
  | "goals"
  | "monthCompare"
  | "lengths"
  | "brokenLinks"
  | "orphans"
  | "sameName"
  | "emptyBig"
  | "unusedFiles"
  | "dupes";

export interface WidgetInfo extends Limits {
  id: WidgetId;
  /** 添加时的默认宽（列）和高（行） */
  w: number;
  h: number;
  /** 2.0 新加的卡片 */
  isNew?: boolean;
}

const spec = (id: WidgetId, minW: number, maxW: number, minH: number, maxH: number, w: number, h: number, isNew = false): WidgetInfo => ({
  id,
  minW,
  maxW,
  minH,
  maxH,
  w,
  h,
  ...(isNew ? { isNew } : {}),
});

/**
 * 卡片目录：顺序就是“添加卡片”里的顺序。
 * 宽高范围的依据是：在这个范围里内容能跟着有意义地变化，超出范围只会多出空白或被截断。
 */
export const WIDGETS: WidgetInfo[] = [
  spec("hero", 5, 12, 6, 8, 8, 6),
  spec("tasks", 3, 12, 3, 12, 4, 6),
  spec("notes", 2, 6, 2, 4, 3, 3),
  spec("words", 2, 6, 2, 4, 3, 3),
  spec("taskRate", 2, 6, 2, 4, 3, 3),
  spec("month", 2, 6, 2, 4, 3, 3),
  spec("heat", 6, 12, 4, 6, 12, 5),
  spec("trend", 5, 12, 4, 10, 8, 7),
  spec("tags", 3, 12, 3, 12, 4, 7),
  spec("brokenLinks", 3, 12, 3, 12, 4, 5, true),
  spec("orphans", 3, 12, 3, 12, 4, 5, true),
  spec("sameName", 3, 12, 3, 12, 4, 5, true),
  spec("emptyBig", 3, 12, 3, 12, 4, 4, true),
  spec("unusedFiles", 3, 12, 3, 12, 4, 4, true),
  spec("dupes", 3, 12, 3, 8, 4, 4, true),
  spec("reports", 8, 12, 4, 6, 12, 4),
  spec("topLinked", 3, 12, 3, 12, 4, 4, true),
  spec("rhythm", 3, 8, 3, 6, 4, 4, true),
  spec("activity", 3, 8, 2, 4, 4, 4, true),
  spec("taskNotes", 3, 12, 3, 12, 4, 3, true),
  spec("density", 2, 6, 2, 4, 4, 3, true),
  spec("folders", 3, 12, 2, 5, 4, 3, true),
  spec("calendar", 3, 12, 4, 10, 4, 7, true),
  // 合并卡：同一类的数据放进一张带标签页的卡里（新建的默认布局不放它们，在“添加卡片”里加）
  spec("trendHub", 5, 12, 5, 10, 8, 7, true),
  spec("overview", 4, 12, 3, 6, 12, 3, true),
  spec("checkupHub", 4, 12, 4, 12, 6, 7, true),
  spec("structure", 4, 12, 4, 10, 4, 7, true),
  spec("habits", 3, 8, 4, 8, 4, 5, true),
  spec("tasksHub", 4, 12, 4, 12, 6, 7, true),
  // 新卡片
  spec("recent", 3, 12, 3, 12, 4, 6, true),
  spec("goals", 3, 12, 4, 6, 6, 4, true),
  spec("monthCompare", 3, 8, 5, 6, 4, 5, true),
  spec("lengths", 4, 12, 4, 8, 6, 5, true),
];

const INFO = new Map(WIDGETS.map((w) => [w.id, w]));

export function widgetInfo(id: string): WidgetInfo | undefined {
  return INFO.get(id as WidgetId);
}

const isKnown = (id: string): boolean => INFO.has(id as WidgetId);

/** 布局里没有的卡片也要能查到范围（读到坏数据时不会走到这里，只是给类型兜底） */
export function limitsOf(id: string): Limits {
  const w = INFO.get(id as WidgetId);
  return w ? { minW: w.minW, maxW: w.maxW, minH: w.minH, maxH: w.maxH } : { minW: 1, maxW: COLS, minH: 1, maxH: 12 };
}

export interface WidgetLayoutItem extends GridItem {
  id: WidgetId;
}

export interface WidgetLayout {
  version: 2;
  items: WidgetLayoutItem[];
}

/**
 * 默认布局（12 列，单位是格子）：前面和 1.8 一样，其后日历和 6 张新卡片、库体检拆出的 6 张卡，最后写作回顾。
 * 每一行的卡片等高，右边不留洞。
 *
 *   y0   今日写作 8×6                     | 接下来 4×6
 *   y6   笔记 3×3 | 总字数 3×3 | 任务完成率 3×3 | 本月写作 3×3
 *   y9   写作热力图 12×5
 *   y14  每周写作 8×7                     | 常用标签 4×7
 *   y21  日历 4×7 | 写作节奏 4×4 + 链接密度 4×3 | 笔记活跃度 4×4 + 文件夹构成 4×3
 *   y28  最常被链接 4×5 | 任务最多的笔记 4×5 | 断链 4×5
 *   y33  孤立笔记 4×5 | 同名笔记 4×5 | 空笔记与超大笔记 4×5
 *   y38  未引用的附件 6×4 | 重复内容 6×4
 *   y42  写作回顾 12×4
 */
const DEFAULT_ITEMS: [WidgetId, number, number, number, number][] = [
  ["hero", 0, 0, 8, 6],
  ["tasks", 8, 0, 4, 6],
  ["notes", 0, 6, 3, 3],
  ["words", 3, 6, 3, 3],
  ["taskRate", 6, 6, 3, 3],
  ["month", 9, 6, 3, 3],
  ["heat", 0, 9, 12, 5],
  ["trend", 0, 14, 8, 7],
  ["tags", 8, 14, 4, 7],
  ["calendar", 0, 21, 4, 7],
  ["rhythm", 4, 21, 4, 4],
  ["density", 4, 25, 4, 3],
  ["activity", 8, 21, 4, 4],
  ["folders", 8, 25, 4, 3],
  ["topLinked", 0, 28, 4, 5],
  ["taskNotes", 4, 28, 4, 5],
  ["brokenLinks", 8, 28, 4, 5],
  ["orphans", 0, 33, 4, 5],
  ["sameName", 4, 33, 4, 5],
  ["emptyBig", 8, 33, 4, 5],
  ["unusedFiles", 0, 38, 6, 4],
  ["dupes", 6, 38, 6, 4],
  ["reports", 0, 42, 12, 4],
];

export function defaultLayout(): WidgetLayout {
  return { version: 2, items: compact(DEFAULT_ITEMS.map(([id, x, y, w, h]): WidgetLayoutItem => ({ id, x, y, w, h }))) };
}

/** 2.0 开发中的档位布局（只在开发者本机存在过）：档位 → 占几列 */
const V1_SPAN: Record<string, number> = { s: 3, m: 4, l: 8, xl: 12 };
/** 档位布局里的“库体检”换成拆分后的 6 张卡，放在它原来的位置 */
const CHECKUP_SPLIT: WidgetId[] = ["brokenLinks", "orphans", "sameName", "emptyBig", "unusedFiles", "dupes"];

function migrateV1(raw: { items: unknown[] }): WidgetLayout {
  const seen = new Set<string>();
  const entries: { id: WidgetId; w: number; h: number }[] = [];
  const push = (id: WidgetId, cols: number) => {
    const info = INFO.get(id);
    if (!info || seen.has(id)) return;
    seen.add(id);
    entries.push({ id, w: Math.min(info.maxW, Math.max(info.minW, cols)), h: info.h });
  };
  for (const it of raw.items) {
    if (!it || typeof it !== "object") continue;
    const { id, size } = it as { id?: unknown; size?: unknown };
    if (typeof id !== "string") continue;
    const cols = V1_SPAN[String(size)] ?? INFO.get(id as WidgetId)?.w ?? 4;
    if (id === "checkup") for (const c of CHECKUP_SPLIT) push(c, INFO.get(c)?.w ?? 4);
    else push(id as WidgetId, cols);
  }
  return { version: 2, items: flowItems(entries) as WidgetLayoutItem[] };
}

/**
 * 读到的布局可能来自别的版本、被同步弄坏或被手改：
 * - 没有或读不懂：默认布局；
 * - v1（档位）：迁移到网格；
 * - v2：去掉未知卡和重复卡，尺寸夹进范围，重叠的推开（不上浮，用户留的空位保留）。
 */
export function normalizeLayout(raw: unknown): WidgetLayout {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { items?: unknown }).items)) return defaultLayout();
  const r = raw as { version?: unknown; items: unknown[] };
  if (r.version === 1 || (r.version === undefined && r.items.some((i) => i && typeof i === "object" && "size" in i))) return migrateV1(r);
  return { version: 2, items: repairItems(r.items, limitsOf, isKnown) as WidgetLayoutItem[] };
}

/** 隐藏着、可以添加的卡片 */
export function hiddenWidgets(layout: WidgetLayout): WidgetInfo[] {
  const on = new Set(layout.items.map((i) => i.id));
  return WIDGETS.filter((w) => !on.has(w.id));
}

/**
 * “添加卡片”里不再单独列出的卡片：功能已经被另一张卡完整包含。
 * 每周写作是写作趋势的子集（写作趋势多了笔记总数、总字数、打卡天数三个指标），列两张只会让人分不清。
 * 看板上已有的每周写作照常显示，移除后想加回来，加写作趋势就行（默认指标和范围和它一样）。
 */
export const SUPERSEDED: WidgetId[] = ["trend"];

/** “添加卡片”里列出的卡片：隐藏着的，去掉被别的卡完整包含的 */
export function addableWidgets(layout: WidgetLayout): WidgetInfo[] {
  return hiddenWidgets(layout).filter((w) => !SUPERSEDED.includes(w.id));
}

export type WidgetCategory = "writing" | "tasks" | "structure" | "checkup";

/** “添加卡片”里的分类，每类里合并卡排在最前面 */
export const WIDGET_CATEGORIES: { id: WidgetCategory; ids: WidgetId[] }[] = [
  { id: "writing", ids: ["trendHub", "overview", "habits", "hero", "notes", "words", "month", "heat", "trend", "rhythm", "activity", "lengths", "monthCompare", "goals", "reports"] },
  { id: "tasks", ids: ["tasksHub", "tasks", "taskRate", "taskNotes", "calendar"] },
  { id: "structure", ids: ["structure", "tags", "folders", "topLinked", "density", "recent"] },
  { id: "checkup", ids: ["checkupHub", "brokenLinks", "orphans", "sameName", "emptyBig", "unusedFiles", "dupes"] },
];

/** 合并卡：把哪几张单独的卡片放进了一张带标签页的卡里 */
export const MERGED_FROM: Partial<Record<WidgetId, WidgetId[]>> = {
  trendHub: ["trend"],
  overview: ["notes", "words", "taskRate", "month"],
  habits: ["rhythm", "activity"],
  tasksHub: ["tasks", "taskNotes"],
  structure: ["tags", "folders", "topLinked", "density"],
  checkupHub: ["brokenLinks", "orphans", "sameName", "emptyBig", "unusedFiles", "dupes"],
};

/** 这张单独的卡片也包含在哪几张合并卡里 */
export function coveredBy(id: WidgetId): WidgetId[] {
  return (Object.keys(MERGED_FROM) as WidgetId[]).filter((m) => MERGED_FROM[m]?.includes(id));
}

export function withItems(items: GridItem[]): WidgetLayout {
  return { version: 2, items: items as WidgetLayoutItem[] };
}

/** 加一张卡：用这张卡的默认大小，放在最上面第一个放得下的位置（先填空位，没有空位就排在最后） */
export function addWidget(layout: WidgetLayout, id: WidgetId): WidgetLayout {
  const info = INFO.get(id);
  if (!info || layout.items.some((i) => i.id === id)) return layout;
  return withItems(addItem(layout.items, { id, x: 0, y: 0, w: info.w, h: info.h }));
}

/** 移除一张卡：空出来的位置保持空着，别的卡不动 */
export function removeWidget(layout: WidgetLayout, id: WidgetId): WidgetLayout {
  return withItems(layout.items.filter((i) => i.id !== id));
}

/** 整理：每张卡往上补，不留空位（编辑栏的“整理”按钮） */
export function tidyLayout(layout: WidgetLayout): WidgetLayout {
  return withItems(compact(layout.items));
}

export function sameLayout(a: WidgetLayout, b: WidgetLayout): boolean {
  return a.items.length === b.items.length && a.items.every((x, i) => {
    const y = b.items[i];
    return x.id === y.id && x.x === y.x && x.y === y.y && x.w === y.w && x.h === y.h;
  });
}

/** 把卡片按阅读顺序（先上后下、先左后右）排好，窄屏排成一列时用这个顺序 */
export function readingOrder(layout: WidgetLayout): WidgetLayoutItem[] {
  return [...layout.items].sort((a, b) => a.y - b.y || a.x - b.x);
}
