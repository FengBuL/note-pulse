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
  /** 底部的今日新建、今日改动、今天写过 */
  foot: boolean;
  chips: boolean;
  /** 圆环直径 */
  ring: number;
}

const WEEK_H = 150;
const FOOT_H = 84;
const RING_FULL = 132;

export function heroDensity(b: Box): HeroDensity {
  // 窄面板里卡片高度跟内容走：什么都显示，七天放在下面
  if (b.narrow) return { wide: false, week: true, stacked: true, foot: true, chips: true, ring: 112 };
  const w = innerW(b);
  const h = bodyH(b);
  const wide = w >= 560;
  let week = false;
  let stacked = false;
  let used = RING_FULL;
  if (wide) {
    week = h >= WEEK_H;
    used = Math.max(RING_FULL, week ? WEEK_H : 0);
  } else if (h >= RING_FULL + 20 + WEEK_H) {
    week = true;
    stacked = true;
    used = RING_FULL + 20 + WEEK_H;
  }
  const foot = h - used >= FOOT_H;
  const ring = clamp(Math.floor((h - (foot ? FOOT_H : 0) - (stacked ? 20 + WEEK_H : 0)) / 4) * 4, 80, RING_FULL);
  return { wide, week, stacked, foot, chips: foot && w >= 420, ring };
}

export interface KpiDensity {
  /** 迷你走势线 / 进度条 */
  viz: boolean;
  /** 主数字缩小（卡片很窄） */
  small: boolean;
  /** 主数字右边的说明 */
  side: boolean;
}

export function kpiDensity(b: Box): KpiDensity {
  if (b.narrow) return { viz: true, small: innerW(b) < 120, side: innerW(b) >= 130 };
  const w = innerW(b) - (isTight(b.rows) ? -14 : 0);
  return { viz: b.rows >= 3, small: w < 120, side: w >= 150 };
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
    default:
      return isTight(b.rows) ? "tight" : "";
  }
}
