/*
 * 卡片内容随实际像素大小变化：同样是 4 列，在 2K 屏上更宽就多显示一些，在窄窗口里更窄就少显示一些。
 * 这里只放“这个尺寸该显示什么”的判断，纯函数，输入是卡片的实际像素宽高，便于单元测试；
 * 列表类卡片按高度放几行不在这里（要量真实行高，见 view.ts 的 fitList）。
 */

export interface Box {
  /** 占几列、几行（布局里存的） */
  cols: number;
  rows: number;
  /** 卡片的实际像素大小 */
  w: number;
  h: number;
  /** 窄面板（排成一列）：高度跟内容走，h 只是电脑上存的行数换算成像素，当参考 */
  narrow: boolean;
}

/** 卡片左右内边距 22×2 加描边 */
const PAD_X = 46;
/** 卡片上下内边距 20×2 加描边 */
const PAD_Y = 42;
/** 标题行 26px 加下面 16px 间距 */
const HEAD = 42;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** 卡片内容区的宽度 */
export const innerW = (b: Box): number => Math.max(0, b.w - PAD_X);

/** 卡片内容区的高度（标题行以下，不含上下内边距）；紧凑卡片（2 行）没有标题行间距 */
export const bodyH = (b: Box): number => Math.max(0, b.h - PAD_Y - HEAD);

/** 2 行高的卡片：内边距收小，标题缩成一行小字 */
export const isTight = (rows: number): boolean => rows <= 2;

export interface HeroDensity {
  /** 三栏：圆环 | 连续打卡 | 本周七天；否则两栏，七天放到下面（放得下的话） */
  wide: boolean;
  week: boolean;
  /** 七天放在圆环和连续打卡的下面（卡片窄但够高） */
  stacked: boolean;
  /** 底部那行里“今天写过”的笔记（需要一点宽度）；今日新建、今日改动始终在 */
  chips: boolean;
  /** 圆环直径 */
  ring: number;
  /** 本周七天：圆点直径、柱子的高度和宽度，随卡片大小变；卡片高了再加图例和周目标进度条 */
  dot: number;
  lane: number;
  bar: number;
  weekDetail: boolean;
}

/** 底部一行（今日新建 / 今日改动 / 今天写过）：上边距 16 + 内边距 12 + 内容约 40。卡片再矮它也不消失 */
const FOOT_H = 70;
const RING_MIN = 72;
const RING_MAX = 168;
/**
 * 本周七天的盒子里除了圆点 / 柱子以外占的高度（实测）：内边距 24、顶上一行（标题、问号和切换）36、
 * 星期标签 24；再留 9 的余量。柱状时每根柱子上面的字数在柱子区域自己的 16px 顶部空间里，不另算。
 * 周目标进度条约 20。图例收进了问号，不占地方。
 */
const WEEK_CHROME = 24 + 36 + 24 + 9;
const WEEK_DETAIL = 20;

export function heroDensity(b: Box): HeroDensity {
  // 窄面板里卡片高度跟内容走：什么都显示，七天放在下面
  if (b.narrow) return { wide: false, week: true, stacked: true, chips: true, ring: 112, dot: 30, lane: 44, bar: 16, weekDetail: true };
  const w = innerW(b);
  const main = Math.max(0, bodyH(b) - FOOT_H);
  const wide = w >= 640;
  // 上下叠放时第一行（圆环和连续打卡）约 112 高，两行之间隔 30
  const stacked = !wide && main >= 112 + 30 + 100;
  const week = wide || stacked;
  const weekH = wide ? main : main - 112 - 30;
  const weekDetail = week && weekH >= WEEK_CHROME + WEEK_DETAIL + 80;
  const room = Math.max(0, weekH - WEEK_CHROME - (weekDetail ? WEEK_DETAIL : 0));
  const ring = stacked ? 88 : clamp(Math.floor(main / 4) * 4, RING_MIN, RING_MAX);
  return {
    wide,
    week,
    stacked,
    chips: w >= 420,
    ring,
    dot: clamp(Math.floor(room), 24, 56),
    lane: clamp(Math.floor(room), 36, 220),
    bar: clamp(Math.round(room * 0.4), 16, 30),
    weekDetail,
  };
}

export interface KpiDensity {
  /** 迷你走势线 / 进度条 */
  viz: boolean;
  /** 主数字缩小（卡片很窄） */
  small: boolean;
  /** 主数字右边的说明 */
  side: boolean;
  /** 宽到放得下完整的文字说明（曲线画的是什么、“近 30 天新增 +90 篇”） */
  note: boolean;
}

export function kpiDensity(b: Box): KpiDensity {
  if (b.narrow) return { viz: true, small: innerW(b) < 120, side: innerW(b) >= 130, note: innerW(b) >= 230 };
  const w = innerW(b) - (isTight(b.rows) ? -14 : 0);
  return { viz: b.rows >= 3, small: w < 120, side: w >= 150, note: w >= 230 };
}

export interface RhythmDensity {
  /** 最常写的一天 + 平均字数 */
  top: boolean;
  /** 柱子上方的数值 */
  values: boolean;
}

export function rhythmDensity(b: Box): RhythmDensity {
  if (b.narrow) return { top: true, values: innerW(b) >= 240 };
  return { top: b.rows >= 4, values: b.rows >= 5 && innerW(b) >= 240 };
}

export interface ActivityDensity {
  caption: boolean;
  bar: boolean;
}

export function activityDensity(b: Box): ActivityDensity {
  if (b.narrow) return { bar: true, caption: true };
  return { bar: b.rows >= 3, caption: b.rows >= 4 };
}

export interface DensityDensity {
  caption: boolean;
  share: boolean;
}

export function densityDensity(b: Box): DensityDensity {
  if (b.narrow) return { caption: true, share: true };
  return { caption: b.rows >= 3, share: b.rows >= 4 };
}

export interface FoldersDensity {
  /** 图例竖排成带篇数的列表；否则横排 */
  list: boolean;
}

export function foldersDensity(b: Box): FoldersDensity {
  return { list: b.narrow || b.rows >= 4 };
}

/** 合并卡的标签条占的高度（28 + 6） */
export const HUB_CHROME = 34;

/** 合并卡里面板能用的区域：扣掉标签条，行数按剩下的高度重新算 */
export function hubBox(b: Box): Box {
  const h = Math.max(0, b.h - HUB_CHROME);
  return { ...b, h, rows: Math.max(1, Math.floor((h + 16) / 56)) };
}

export interface OverviewDensity {
  /** 每行几格、一共显示几格（卡片不够大时只显示放得下的） */
  cols: number;
  shown: number;
  /** 每格里的迷你走势线 */
  viz: boolean;
  tileW: number;
  tileH: number;
}

const TILE_MIN_W = 150;
const TILE_MIN_H = 56;
const TILE_VIZ_H = 96;
const TILE_GAP = 12;

/** 数据概览：四格（笔记、总字数、任务完成率、本月写作）按卡片大小排；这张卡没有标题行，格子自己带名字 */
export function overviewDensity(b: Box): OverviewDensity {
  const w = innerW(b);
  const availH = Math.max(0, b.h - PAD_Y);
  const cols = clamp(Math.floor((w + TILE_GAP) / (TILE_MIN_W + TILE_GAP)), 1, 4);
  const rowsNeeded = Math.ceil(4 / cols);
  if (b.narrow) return { cols: Math.min(cols, 2), shown: 4, viz: true, tileW: Math.floor((w - TILE_GAP) / 2), tileH: 110 };
  const rowsFit = Math.max(1, Math.floor((availH + TILE_GAP) / (TILE_MIN_H + TILE_GAP)));
  const rows = Math.min(rowsNeeded, rowsFit);
  const tileH = Math.floor((availH - (rows - 1) * TILE_GAP) / rows);
  return { cols, shown: Math.min(4, cols * rows), viz: tileH >= TILE_VIZ_H, tileW: Math.floor((w - (cols - 1) * TILE_GAP) / cols), tileH };
}

/** 目标进度：三个环的直径（一排三个，下面各一行字） */
export function goalRingSize(b: Box): number {
  if (b.narrow) return 96;
  const byW = clamp(Math.floor(innerW(b) / 3 - 14), 56, 150);
  const byH = clamp(Math.floor(bodyH(b) - 44), 56, 150);
  return Math.min(byW, byH);
}

export interface CalendarDensity {
  /** none：只有月历；below：月历下面是选中那天的日程；side：月历左边、日程右边 */
  mode: "none" | "below" | "side";
  /** 月历每一格的高度 */
  cell: number;
}

/** 星期标题行 20，月历和日程之间 8，日程区最少 104（标题一行、两条日程、输入框） */
const CAL_WEEKDAYS = 20;
const CAL_AGENDA = 104;

export function calendarDensity(b: Box): CalendarDensity {
  if (b.narrow) return { mode: "below", cell: 34 };
  const w = innerW(b);
  const h = bodyH(b);
  if (w >= 560 && h >= 150) return { mode: "side", cell: clamp(Math.floor((h - CAL_WEEKDAYS) / 6), 20, 44) };
  if (h - CAL_WEEKDAYS - 8 - 6 * 22 >= CAL_AGENDA) return { mode: "below", cell: clamp(Math.floor((h - CAL_WEEKDAYS - 8 - CAL_AGENDA) / 6), 22, 32) };
  return { mode: "none", cell: clamp(Math.floor((h - CAL_WEEKDAYS) / 6), 14, 36) };
}

export interface HeatDensity {
  /** 格子大小（高度方向）和宽度方向每周占的宽度 */
  cell: number;
  stepX: number;
  weeks: number;
}

const HEAT_LEFT = 22;
const HEAT_TOP = 20;
const HEAT_GAP = 4;

/**
 * 热力图：格子大小由高度决定（7 行要放进内容区），周数由宽度决定（最多 53 周）。
 * 宽屏上周数已经到顶时，格子横向拉宽一点（最多比高度宽一倍）填满，不留一大块空白。
 * avail 是热力图自己能用的像素宽高。
 */
export function heatDensity(avail: { w: number; h: number }): HeatDensity {
  const cell = clamp(Math.floor((avail.h - HEAT_TOP + HEAT_GAP) / 7) - HEAT_GAP, 8, 22);
  const weeks = clamp(Math.floor((avail.w - HEAT_LEFT + HEAT_GAP) / (cell + HEAT_GAP)), 4, 53);
  const fit = (avail.w - HEAT_LEFT + HEAT_GAP) / weeks - HEAT_GAP;
  const stepX = Math.floor(clamp(fit, cell, cell * 2)) + HEAT_GAP;
  return { cell, stepX, weeks };
}

export interface TrendDensity {
  /** 合计、平均、最高那一行 */
  summary: boolean;
  /** 底下“排除超大笔记”的开关 */
  annot: boolean;
}

export function trendDensity(b: Box): TrendDensity {
  const h = bodyH(b);
  return { summary: b.narrow || h >= 190, annot: b.narrow || h >= 250 };
}

/** 这张卡当前尺寸下的“显示什么”，序列化成字符串；变了就要重画这张卡 */
export function densityKey(id: string, b: Box): string {
  switch (id) {
    case "hero":
      return JSON.stringify(heroDensity(b));
    case "notes":
    case "words":
    case "taskRate":
    case "month":
      return JSON.stringify([kpiDensity(b), isTight(b.rows)]);
    case "rhythm":
      return JSON.stringify(rhythmDensity(b));
    case "activity":
      return JSON.stringify([activityDensity(b), isTight(b.rows)]);
    case "density":
      return JSON.stringify([densityDensity(b), isTight(b.rows)]);
    case "folders":
      return JSON.stringify([foldersDensity(b), isTight(b.rows)]);
    case "trend":
      return JSON.stringify(trendDensity(b));
    case "calendar":
      return JSON.stringify(calendarDensity(b));
    case "trendHub":
      return JSON.stringify(trendDensity(b));
    case "overview":
      return JSON.stringify(overviewDensity(b));
    case "goals":
      return String(goalRingSize(b));
    case "structure":
    case "habits": {
      const h = hubBox(b);
      return JSON.stringify([foldersDensity(h), rhythmDensity(h), activityDensity(h), densityDensity(h)]);
    }
    default:
      return isTight(b.rows) ? "tight" : "";
  }
}
