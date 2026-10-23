/* 2.0 小组件：卡片目录和布局。纯数据与纯函数，不依赖 Obsidian API，便于单元测试。 */

/** 档位：在 12 列栅格里占几列。S 3 · M 4 · L 8 · XL 12（M/L 和 1.8 的 4/8 分栏一致，默认布局看起来不变） */
export type WidgetSize = "s" | "m" | "l" | "xl";

export const SIZE_SPAN: Record<WidgetSize, number> = { s: 3, m: 4, l: 8, xl: 12 };

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
  | "checkup"
  | "reports"
  | "topLinked"
  | "rhythm"
  | "activity"
  | "taskNotes"
  | "density"
  | "folders";

export interface WidgetInfo {
  id: WidgetId;
  /** 支持的档位，第一个是添加时的默认档位 */
  sizes: WidgetSize[];
  /** 2.0 新加的卡片 */
  isNew?: boolean;
}

/** 卡片目录：顺序就是“添加卡片”里的顺序 */
export const WIDGETS: WidgetInfo[] = [
  { id: "hero", sizes: ["l", "m", "xl"] },
  { id: "tasks", sizes: ["m", "l"] },
  { id: "notes", sizes: ["s", "m"] },
  { id: "words", sizes: ["s", "m"] },
  { id: "taskRate", sizes: ["s", "m"] },
  { id: "month", sizes: ["s", "m"] },
  { id: "heat", sizes: ["xl", "l"] },
  { id: "trend", sizes: ["l", "xl"] },
  { id: "tags", sizes: ["m", "l"] },
  { id: "checkup", sizes: ["xl", "l"] },
  { id: "reports", sizes: ["xl", "l"] },
  { id: "topLinked", sizes: ["m", "l"], isNew: true },
  { id: "rhythm", sizes: ["m", "s"], isNew: true },
  { id: "activity", sizes: ["m", "s"], isNew: true },
  { id: "taskNotes", sizes: ["m", "l"], isNew: true },
  { id: "density", sizes: ["s"], isNew: true },
  { id: "folders", sizes: ["m", "l"], isNew: true },
];

export interface LayoutItem {
  id: WidgetId;
  size: WidgetSize;
}

export interface WidgetLayout {
  version: 1;
  items: LayoutItem[];
}

/**
 * 默认布局：前面和 1.8 一样（今日写作 + 接下来、四张数据卡、热力图、每周写作 + 标签），
 * 然后 6 张新卡片排两行（4+4+4、4+4+3，第二行末尾空一列），最后库体检和写作回顾。
 */
export function defaultLayout(): WidgetLayout {
  return {
    version: 1,
    items: [
      { id: "hero", size: "l" },
      { id: "tasks", size: "m" },
      { id: "notes", size: "s" },
      { id: "words", size: "s" },
      { id: "taskRate", size: "s" },
      { id: "month", size: "s" },
      { id: "heat", size: "xl" },
      { id: "trend", size: "l" },
      { id: "tags", size: "m" },
      // 2.0 新卡片
      { id: "rhythm", size: "m" },
      { id: "activity", size: "m" },
      { id: "topLinked", size: "m" },
      { id: "folders", size: "m" },
      { id: "taskNotes", size: "m" },
      { id: "density", size: "s" },
      { id: "checkup", size: "xl" },
      { id: "reports", size: "xl" },
    ],
  };
}

const INFO = new Map(WIDGETS.map((w) => [w.id, w]));

export function widgetInfo(id: WidgetId): WidgetInfo | undefined {
  return INFO.get(id);
}

/**
 * 读到的布局可能来自别的版本、被同步弄坏或被手改：去掉未知的卡片和重复项，
 * 不支持的档位换成这张卡的默认档位；没有或读不懂时用默认布局。
 */
export function normalizeLayout(raw: unknown): WidgetLayout {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { items?: unknown }).items)) return defaultLayout();
  const seen = new Set<string>();
  const items: LayoutItem[] = [];
  for (const it of (raw as { items: unknown[] }).items) {
    if (!it || typeof it !== "object") continue;
    const { id, size } = it as { id?: unknown; size?: unknown };
    const info = typeof id === "string" ? INFO.get(id as WidgetId) : undefined;
    if (!info || seen.has(info.id)) continue;
    seen.add(info.id);
    items.push({ id: info.id, size: info.sizes.includes(size as WidgetSize) ? (size as WidgetSize) : info.sizes[0] });
  }
  return { version: 1, items };
}

/** 隐藏着、可以添加的卡片 */
export function hiddenWidgets(layout: WidgetLayout): WidgetInfo[] {
  const on = new Set(layout.items.map((i) => i.id));
  return WIDGETS.filter((w) => !on.has(w.id));
}

export function setSize(layout: WidgetLayout, id: WidgetId, size: WidgetSize): WidgetLayout {
  const info = INFO.get(id);
  if (!info || !info.sizes.includes(size)) return layout;
  return { version: 1, items: layout.items.map((i) => (i.id === id ? { id, size } : i)) };
}

export function removeWidget(layout: WidgetLayout, id: WidgetId): WidgetLayout {
  return { version: 1, items: layout.items.filter((i) => i.id !== id) };
}

/** 加到最后，用这张卡的默认档位 */
export function addWidget(layout: WidgetLayout, id: WidgetId): WidgetLayout {
  const info = INFO.get(id);
  if (!info || layout.items.some((i) => i.id === id)) return layout;
  return { version: 1, items: [...layout.items, { id, size: info.sizes[0] }] };
}

/** 往前（-1）或往后（+1）挪一格 */
export function moveWidget(layout: WidgetLayout, id: WidgetId, delta: -1 | 1): WidgetLayout {
  const i = layout.items.findIndex((x) => x.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= layout.items.length) return layout;
  const items = [...layout.items];
  [items[i], items[j]] = [items[j], items[i]];
  return { version: 1, items };
}

/** 拖动：把 id 放到 before 前面（before 为 null 时放到最后） */
export function placeWidget(layout: WidgetLayout, id: WidgetId, before: WidgetId | null): WidgetLayout {
  const item = layout.items.find((x) => x.id === id);
  if (!item || id === before) return layout;
  const rest = layout.items.filter((x) => x.id !== id);
  const at = before ? rest.findIndex((x) => x.id === before) : -1;
  if (at < 0) rest.push(item);
  else rest.splice(at, 0, item);
  return { version: 1, items: rest };
}

export function sameLayout(a: WidgetLayout, b: WidgetLayout): boolean {
  return a.items.length === b.items.length && a.items.every((x, i) => x.id === b.items[i].id && x.size === b.items[i].size);
}
