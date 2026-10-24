/*
 * “添加卡片”里每张卡的预览缩略图：用几何图形画出这张卡大致的样子（标题条 + 图表 / 列表 / 数字），
 * 不读数据、不挂事件，只用 CSS 类上色，跟随主题。画在 160 × 90 的画布里。
 */
import { svgEl } from "./charts";
import { cloudLayout } from "./cloud";
import type { WidgetId } from "./widgets";

export const PREVIEW_W = 160;
export const PREVIEW_H = 90;

type Tone = "acc" | "soft" | "dim" | "ok" | "warn" | "dng" | "rose";

interface Pen {
  svg: SVGSVGElement;
  rect(x: number, y: number, w: number, h: number, tone?: Tone, rx?: number, op?: number): void;
  dot(x: number, y: number, r: number, tone?: Tone, op?: number): void;
  path(d: string, tone?: Tone, fill?: boolean): void;
}

function pen(svg: SVGSVGElement): Pen {
  return {
    svg,
    rect(x, y, w, h, tone = "dim", rx = 1.5, op) {
      svgEl("rect", { x, y, width: Math.max(0, w), height: Math.max(0, h), rx, class: `pv-${tone}`, ...(op !== undefined ? { "fill-opacity": op } : {}) }, svg);
    },
    dot(x, y, r, tone = "acc", op) {
      svgEl("circle", { cx: x, cy: y, r, class: `pv-${tone}`, ...(op !== undefined ? { "fill-opacity": op } : {}) }, svg);
    },
    path(d, tone = "acc", fill = false) {
      svgEl("path", { d, class: fill ? `pv-${tone}` : `pv-stroke pv-s-${tone}`, ...(fill ? {} : { fill: "none" }) }, svg);
    },
  };
}

/** 卡片的框和标题条；返回内容区的左上角和宽高 */
function frame(p: Pen, titleW = 34): { x: number; y: number; w: number; h: number } {
  p.rect(1, 1, PREVIEW_W - 2, PREVIEW_H - 2, "soft", 6, 0.35);
  p.dot(12, 12, 3, "acc");
  p.rect(19, 10, titleW, 4, "dim");
  return { x: 10, y: 22, w: PREVIEW_W - 20, h: PREVIEW_H - 32 };
}

type Area = { x: number; y: number; w: number; h: number };

/** 竖条 */
function bars(p: Pen, a: Area, values: number[], tone: Tone = "acc"): void {
  const n = values.length;
  const gap = 3;
  const bw = (a.w - gap * (n - 1)) / n;
  const max = Math.max(...values, 1);
  values.forEach((v, i) => {
    const h = Math.max(1.5, (v / max) * a.h);
    p.rect(a.x + i * (bw + gap), a.y + a.h - h, bw, h, tone, Math.min(2, bw / 2));
  });
}

/** 折线 / 曲线 / 面积的点 */
function points(a: Area, values: number[]): [number, number][] {
  const max = Math.max(...values, 1);
  return values.map((v, i) => [a.x + (i / (values.length - 1)) * a.w, a.y + a.h - (v / max) * a.h]);
}

function linePath(pts: [number, number][], smooth: boolean): string {
  if (!smooth) return pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const mx = (x0 + x1) / 2;
    d += ` C${mx.toFixed(1)} ${y0.toFixed(1)} ${mx.toFixed(1)} ${y1.toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  }
  return d;
}

function lineChart(p: Pen, a: Area, values: number[], opts: { smooth?: boolean; area?: boolean; tone?: Tone } = {}): void {
  const tone = opts.tone ?? "acc";
  const pts = points(a, values);
  p.rect(a.x, a.y + a.h, a.w, 0.8, "dim", 0);
  const d = linePath(pts, !!opts.smooth);
  if (opts.area) p.path(`${d} L${a.x + a.w} ${a.y + a.h} L${a.x} ${a.y + a.h} Z`, "soft", true);
  p.path(d, tone);
}

/** 列表行：圆点 + 名字 + 右侧数值 */
function rows(p: Pen, a: Area, n: number, tone: Tone = "acc", widths: number[] = [0.62, 0.5, 0.7, 0.4, 0.55, 0.45]): void {
  const step = Math.min(13, a.h / n);
  for (let i = 0; i < n; i++) {
    const y = a.y + i * step + 3;
    p.dot(a.x + 3, y + 2, 2.2, tone, 0.85);
    p.rect(a.x + 10, y, (a.w - 40) * widths[i % widths.length], 4, "dim");
    p.rect(a.x + a.w - 18, y, 18, 4, tone, 1.5, 0.5);
  }
}

/** 一格大数字 */
function big(p: Pen, a: Area, tone: Tone = "acc"): void {
  p.rect(a.x, a.y + 4, a.w * 0.5, 14, tone, 3);
  p.rect(a.x, a.y + 24, a.w * 0.34, 4, "dim");
}

function donut(p: Pen, cx: number, cy: number, r: number, parts: [number, Tone][]): void {
  const total = parts.reduce((s, [v]) => s + v, 0);
  const circ = 2 * Math.PI * r;
  let off = 0;
  for (const [v, tone] of parts) {
    const len = (v / total) * circ;
    svgEl("circle", { cx, cy, r, fill: "none", "stroke-width": 7, "stroke-dasharray": `${Math.max(0, len - 1.5).toFixed(1)} ${circ.toFixed(1)}`, "stroke-dashoffset": (-off).toFixed(1), transform: `rotate(-90 ${cx} ${cy})`, class: `pv-ring pv-r-${tone}` }, p.svg);
    off += len;
  }
}

function ring(p: Pen, cx: number, cy: number, r: number, frac: number, tone: Tone = "acc"): void {
  const circ = 2 * Math.PI * r;
  svgEl("circle", { cx, cy, r, fill: "none", "stroke-width": 6, class: "pv-ring pv-r-dim" }, p.svg);
  svgEl("circle", { cx, cy, r, fill: "none", "stroke-width": 6, "stroke-linecap": "round", "stroke-dasharray": `${(circ * frac).toFixed(1)} ${circ.toFixed(1)}`, transform: `rotate(-90 ${cx} ${cy})`, class: `pv-ring pv-r-${tone}` }, p.svg);
}

/** 热力格子 */
function heat(p: Pen, a: Area, cols: number, rowsN: number): void {
  const gap = 2;
  const cw = (a.w - gap * (cols - 1)) / cols;
  const ch = (a.h - gap * (rowsN - 1)) / rowsN;
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rowsN; r++) {
      const v = (Math.sin(c * 1.7 + r * 2.3) + Math.cos(c * 0.9 - r)) / 2 + 0.5;
      const lv = v > 0.8 ? 1 : v > 0.55 ? 0.6 : v > 0.35 ? 0.3 : 0;
      if (lv === 0) p.rect(a.x + c * (cw + gap), a.y + r * (ch + gap), cw, ch, "dim", 1.2);
      else p.rect(a.x + c * (cw + gap), a.y + r * (ch + gap), cw, ch, "acc", 1.2, lv);
    }
  }
}

/** 标签条（一排小胶囊） */
function tabs(p: Pen, x: number, y: number, n: number, active = 0): void {
  const w = Math.min(23, (PREVIEW_W - 20 - 3 * (n - 1)) / n);
  for (let i = 0; i < n; i++) {
    p.rect(x + i * (w + 3), y, w, 7, i === active ? "acc" : "dim", 3.5, i === active ? 0.85 : 1);
  }
}

/** 预览按这些选择来画：style（图的样式）、tab（标签页）、metric（指标）、range（时间范围，天数） */
export type PreviewVariant = Record<string, string | undefined>;

/** 趋势图的数据：指标和时间范围决定点数和走势（累计类一路往上，打卡天数是 0–7 的小数） */
function trendValues(metric?: string, range?: string): number[] {
  const n = range === "30" ? 14 : range === "365" ? 7 : 9;
  if (metric === "totalNotes" || metric === "totalWords") return Array.from({ length: n }, (_, i) => 3 + i * 1.6 + (i % 3) * 0.4);
  if (metric === "checkins") return Array.from({ length: n }, (_, i) => 2 + ((i * 5) % 6));
  if (metric === "notes") return Array.from({ length: n }, (_, i) => 2 + ((i * 7) % 6) + (i % 2));
  return Array.from({ length: n }, (_, i) => 4 + ((i * 37) % 9) + i * 0.4);
}


const RHYTHM = [2, 3, 5, 9, 12, 8, 5, 3, 2, 1, 4, 6];

/** 趋势图：柱状 / 折线 / 曲线 / 面积 */
function trendBody(p: Pen, a: Area, style: string | undefined, values: number[] = trendValues()): void {
  if (style === "line" || style === "curve" || style === "area") {
    lineChart(p, a, values, { smooth: style !== "line", area: style === "area" });
    if (style === "line") for (const [x, y] of points(a, values)) p.dot(x, y, 1.8, "acc");
  } else bars(p, a, values);
}

/** 节奏图：柱状 / 折线 / 面积 */
function rhythmBody(p: Pen, a: Area, style: string | undefined): void {
  if (style === "line" || style === "area") lineChart(p, a, RHYTHM, { smooth: true, area: style === "area" });
  else bars(p, a, RHYTHM);
}

/** 本周七天：圆点 / 柱状 / 折线 */
function weekBody(p: Pen, a: Area, style: string | undefined): void {
  const v = [3, 5, 4, 9, 6, 11, 8];
  if (style === "bars") bars(p, a, v);
  else if (style === "line") {
    lineChart(p, a, v, { smooth: false });
    for (const [x, y] of points(a, v)) p.dot(x, y, 2, "acc");
  } else {
    v.forEach((n, i) => p.dot(a.x + 6 + i * ((a.w - 12) / 6), a.y + a.h / 2, 5, n > 6 ? "acc" : "dim", n > 6 ? 0.9 : 1));
  }
}

/** 标签云：最大的在正中间，往外越来越小（和看板上的标签云同一个排布算法） */
function cloud(p: Pen, a: Area): void {
  const sizes = [[40, 11], [28, 8], [26, 8], [22, 7], [20, 7], [18, 6], [16, 6], [16, 5], [14, 5], [14, 5], [12, 5], [12, 4], [10, 4], [10, 4]].map(([w, h]) => ({ w, h }));
  const spots = cloudLayout(sizes, { width: a.w, height: a.h, bounded: true, gap: 3 });
  sizes.forEach((sz, i) => {
    const sp = spots[i];
    if (!sp) return;
    const tone: Tone = i === 0 ? "acc" : i < 4 ? "rose" : "dim";
    p.rect(a.x + a.w / 2 + sp.x - sz.w / 2, a.y + a.h / 2 + sp.y - sz.h / 2, sz.w, sz.h, tone, sz.h / 2, i === 0 ? 0.9 : i < 4 ? 0.7 : 1);
  });
}

/** 文件夹构成：堆叠条 / 环形图 / 列表 */
function mixBody(p: Pen, a: Area, style: string | undefined): void {
  const parts: [number, Tone][] = [[0.4, "acc"], [0.25, "rose"], [0.2, "warn"], [0.15, "ok"]];
  if (style === "donut") {
    donut(p, a.x + 34, a.y + 28, 17, parts);
    rows(p, { x: a.x + 72, y: a.y + 8, w: 68, h: 44 }, 4, "acc");
  } else if (style === "list") {
    parts.forEach(([f, tone], i) => {
      const y = a.y + 2 + i * 13;
      p.dot(a.x + 3, y + 2, 2.2, tone);
      p.rect(a.x + 10, y, 40, 4, "dim");
      p.rect(a.x + 60, y + 0.5, (a.w - 90) * f * 2, 3, tone, 1.5, 0.7);
      p.rect(a.x + a.w - 18, y, 18, 4, "dim");
    });
  } else {
    let x = a.x;
    parts.forEach(([f, tone]) => {
      p.rect(x, a.y + 4, a.w * f - 1.5, 14, tone, 2, 0.85);
      x += a.w * f;
    });
    p.rect(a.x, a.y + 26, a.w * 0.5, 3, "dim");
  }
}

/** 任务：按到期（勾选框列表）/ 按文件夹（带进度条的分组） */
function tasksBody(p: Pen, a: Area, tab: string | undefined): void {
  for (let i = 0; i < 4; i++) {
    const y = a.y + i * 13;
    if (tab === "folder" || tab === "notes") {
      p.rect(a.x, y, 38 - i * 4, 4, "dim");
      p.rect(a.x + 52, y + 0.5, a.w - 52, 3.5, "dim", 2, 0.6);
      p.rect(a.x + 52, y + 0.5, (a.w - 52) * (0.8 - i * 0.18), 3.5, "acc", 2, 0.8);
    } else {
      p.rect(a.x, y, 7, 7, i < 2 ? "acc" : "dim", 2, i < 2 ? 0.8 : 1);
      p.rect(a.x + 13, y + 1.5, a.w * (0.7 - i * 0.1), 4, "dim");
    }
  }
}

/** 链接密度小图 */
function densityBody(p: Pen, a: Area): void {
  big(p, a, "acc");
  p.dot(a.x + 100, a.y + 14, 4, "acc");
  p.dot(a.x + 124, a.y + 6, 3, "rose");
  p.dot(a.x + 116, a.y + 26, 3, "rose");
  p.path(`M${a.x + 100} ${a.y + 14} L${a.x + 124} ${a.y + 6} M${a.x + 100} ${a.y + 14} L${a.x + 116} ${a.y + 26}`, "dim");
}

/** 笔记活跃度：一排颜色深浅不一的小块 */
function activityBody(p: Pen, a: Area): void {
  for (let i = 0; i < 12; i++) p.rect(a.x + i * 11.2, a.y + 6, 9, 22, "acc", 2, 0.15 + ((i * 37) % 10) / 12);
}

const CHECKUP_TABS = ["brokenLinks", "orphans", "sameName", "emptyBig", "unusedFiles", "dupes"];
const STRUCT_TABS = ["tags", "folders", "mix", "linked", "density"];

const DRAW: Record<WidgetId, (p: Pen, v: PreviewVariant) => void> = {
  hero: (p, v) => {
    const a = frame(p, 40);
    p.rect(a.x, a.y, 44, 16, "acc", 3);
    p.rect(a.x, a.y + 21, 30, 4, "dim");
    weekBody(p, { x: a.x + 62, y: a.y, w: 78, h: 38 }, v.style);
  },
  tasks: (p, v) => tasksBody(p, frame(p), v.tab),
  notes: (p) => big(p, frame(p)),
  words: (p) => big(p, frame(p), "rose"),
  taskRate: (p) => {
    const a = frame(p);
    ring(p, a.x + 28, a.y + 24, 14, 0.7, "ok");
    p.rect(a.x + 58, a.y + 14, 40, 5, "dim");
  },
  month: (p) => {
    const a = frame(p);
    big(p, a);
    lineChart(p, { x: a.x + 76, y: a.y + 4, w: 64, h: 24 }, [3, 5, 4, 7, 6, 9], { smooth: true });
  },
  heat: (p) => heat(p, frame(p), 26, 7),
  trend: (p, v) => trendBody(p, frame(p), v.style, trendValues(v.metric, v.range)),
  trendHub: (p, v) => {
    const a = frame(p);
    tabs(p, a.x, a.y - 2, 4);
    trendBody(p, { x: a.x, y: a.y + 12, w: a.w, h: a.h - 14 }, v.style, trendValues(v.metric, v.range));
  },
  tags: (p, v) => {
    const a = frame(p);
    if (v.tab !== "folders" && v.style === "cloud") cloud(p, a);
    else rows(p, a, 5, v.tab === "folders" ? "acc" : "rose");
  },
  reports: (p) => {
    const a = frame(p);
    for (let i = 0; i < 3; i++) {
      p.rect(a.x + i * 46, a.y, 42, a.h, "soft", 4, 0.8);
      p.rect(a.x + i * 46 + 5, a.y + 6, 22, 4, "acc", 1.5, 0.7);
      p.rect(a.x + i * 46 + 5, a.y + 16, 30, 3, "dim");
      p.rect(a.x + i * 46 + 5, a.y + 23, 24, 3, "dim");
    }
  },
  topLinked: (p) => rows(p, frame(p), 5, "acc"),
  rhythm: (p, v) => rhythmBody(p, frame(p), v.style),
  activity: (p) => activityBody(p, frame(p)),
  taskNotes: (p) => rows(p, frame(p), 4, "warn"),
  density: (p) => densityBody(p, frame(p)),
  folders: (p, v) => mixBody(p, frame(p), v.style),
  calendar: (p) => {
    const a = frame(p);
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 7; c++) {
        const today = r === 1 && c === 3;
        p.rect(a.x + c * 20, a.y + r * 11.5, 16, 8, today ? "acc" : "dim", 2, today ? 0.9 : 0.8);
      }
    }
  },
  overview: (p) => {
    const a = frame(p);
    tabs(p, a.x, a.y - 2, 4);
    for (let i = 0; i < 4; i++) {
      p.rect(a.x + i * 36, a.y + 14, 32, 22, "soft", 4, 0.9);
      p.rect(a.x + i * 36 + 5, a.y + 20, 16, 7, i % 2 ? "rose" : "acc", 2, 0.85);
    }
  },
  checkupHub: (p, v) => {
    const i = Math.max(0, CHECKUP_TABS.indexOf(v.tab ?? ""));
    const a = frame(p);
    tabs(p, a.x, a.y - 2, 6, i);
    const body = { x: a.x, y: a.y + 12, w: a.w, h: a.h - 12 };
    if (v.tab === "unusedFiles") for (let k = 0; k < 4; k++) p.rect(body.x + k * 34, body.y + 2, 28, 20, "soft", 3, 0.9);
    else if (v.tab === "emptyBig") {
      p.rect(body.x, body.y + 2, 40, 22, "dim", 3, 0.6);
      p.rect(body.x + 54, body.y + 2, 40, 22, "warn", 3, 0.5);
      p.rect(body.x + 108, body.y + 2, 30, 22, "dng", 3, 0.5);
    } else rows(p, body, 4, (["dng", "rose", "warn", "warn", "acc", "warn"] as Tone[])[i]);
  },
  structure: (p, v) => {
    const a = frame(p);
    const i = Math.max(0, STRUCT_TABS.indexOf(v.tab ?? ""));
    tabs(p, a.x, a.y - 2, 5, i);
    const body = { x: a.x, y: a.y + 12, w: a.w, h: a.h - 12 };
    if (v.tab === "mix") mixBody(p, body, v.style);
    else if (v.tab === "density") densityBody(p, body);
    else if (v.tab === "folders") rows(p, body, 4, "acc");
    else if (v.tab === "linked") rows(p, body, 4, "warn");
    else if (v.style === "cloud") cloud(p, body);
    else rows(p, body, 4, "rose");
  },
  habits: (p, v) => {
    const a = frame(p);
    tabs(p, a.x, a.y - 2, 2, v.tab === "activity" ? 1 : 0);
    const body = { x: a.x, y: a.y + 14, w: a.w, h: a.h - 16 };
    if (v.tab === "activity") activityBody(p, body);
    else rhythmBody(p, body, v.style);
  },
  tasksHub: (p, v) => {
    const a = frame(p);
    tabs(p, a.x, a.y - 2, 3, Math.max(0, ["due", "folder", "notes"].indexOf(v.tab ?? "")));
    tasksBody(p, { x: a.x, y: a.y + 14, w: a.w, h: a.h - 14 }, v.tab);
  },
  recent: (p) => {
    const a = frame(p);
    for (let i = 0; i < 4; i++) {
      const y = a.y + i * 13;
      p.rect(a.x, y, 4, 8, "acc", 1.5, 1 - i * 0.2);
      p.rect(a.x + 9, y, (a.w - 50) * (0.8 - i * 0.12), 4, "dim");
      p.rect(a.x + 9, y + 6, (a.w - 70) * 0.5, 2.5, "dim", 1, 0.6);
      p.rect(a.x + a.w - 22, y + 1, 22, 3, "dim", 1, 0.8);
    }
  },
  goals: (p) => {
    const a = frame(p);
    ([[0.82, "acc"], [0.55, "rose"], [0.3, "warn"]] as [number, Tone][]).forEach(([f, tone], i) => {
      ring(p, a.x + 20 + i * 48, a.y + 24, 15, f, tone);
      p.rect(a.x + 8 + i * 48, a.y + 46, 24, 3.5, "dim");
    });
  },
  monthCompare: (p) => {
    const a = frame(p);
    ([[0.5, 0.7], [0.65, 0.5], [0.4, 0.62]] as [number, number][]).forEach(([prev, cur], i) => {
      const y = a.y + i * 17;
      p.rect(a.x, y, a.w * prev, 5, "dim", 2);
      p.rect(a.x, y + 6.5, a.w * cur, 5, "acc", 2, 0.85);
    });
  },
  lengths: (p, v) => {
    const a = frame(p);
    const vals = [3, 8, 14, 11, 6, 3, 1];
    if (v.style === "area") lineChart(p, a, vals, { smooth: true, area: true, tone: "rose" });
    else bars(p, a, vals, "rose");
  },
  brokenLinks: (p) => {
    const a = frame(p);
    rows(p, a, 4, "dng");
  },
  orphans: (p) => {
    const a = frame(p);
    for (let i = 0; i < 6; i++) p.dot(a.x + 14 + ((i * 53) % 120), a.y + 8 + ((i * 29) % 36), 4 + (i % 3), i % 2 ? "rose" : "acc", 0.75);
  },
  sameName: (p) => {
    const a = frame(p);
    for (let i = 0; i < 3; i++) {
      const y = a.y + i * 17;
      p.rect(a.x, y, 52, 10, "dim", 3);
      p.rect(a.x + 8, y + 3, 36, 4, "acc", 1.5, 0.6);
      p.rect(a.x + 62, y, 52, 10, "dim", 3);
      p.rect(a.x + 70, y + 3, 36, 4, "acc", 1.5, 0.6);
      p.path(`M${a.x + 54} ${y + 5} L${a.x + 60} ${y + 5}`, "warn");
    }
  },
  emptyBig: (p) => {
    const a = frame(p);
    p.rect(a.x, a.y, 40, 28, "dim", 3, 0.6);
    p.rect(a.x + 54, a.y, 40, 28, "soft", 3, 0.9);
    p.rect(a.x + 54, a.y, 40, 6, "warn", 3, 0.7);
    p.rect(a.x + 108, a.y, 30, 28, "dng", 3, 0.5);
  },
  unusedFiles: (p) => {
    const a = frame(p);
    for (let i = 0; i < 4; i++) {
      p.rect(a.x + i * 34, a.y, 28, 22, "soft", 3, 0.9);
      p.path(`M${a.x + i * 34 + 4} ${a.y + 18} L${a.x + i * 34 + 11} ${a.y + 9} L${a.x + i * 34 + 16} ${a.y + 14} L${a.x + i * 34 + 20} ${a.y + 10} L${a.x + i * 34 + 24} ${a.y + 18}`, "acc");
      p.rect(a.x + i * 34, a.y + 26, 24, 3, "dim");
    }
  },
  dupes: (p) => {
    const a = frame(p);
    for (let i = 0; i < 2; i++) {
      const y = a.y + i * 20;
      p.rect(a.x, y, 56, 14, "dim", 3);
      p.rect(a.x + 4, y + 4, 40, 3, "acc", 1, 0.6);
      p.rect(a.x + 4, y + 9, 28, 3, "acc", 1, 0.4);
      p.rect(a.x + 84, y, 56, 14, "dim", 3);
      p.rect(a.x + 88, y + 4, 40, 3, "acc", 1, 0.6);
      p.rect(a.x + 88, y + 9, 36, 3, "acc", 1, 0.4);
      p.rect(a.x + 61, y + 5, 18, 4, "warn", 2, 0.7);
    }
  },
};

/** 往 host 里画 id 对应卡片的预览缩略图；variant 是在“添加卡片”里选的样式、标签页、指标、范围（和这张卡无关的项忽略） */
export function drawAddPreview(host: HTMLElement, id: WidgetId, variant: PreviewVariant = {}): void {
  const svg = svgEl("svg", { viewBox: `0 0 ${PREVIEW_W} ${PREVIEW_H}`, class: "vp-add-svg", "aria-hidden": "true", focusable: "false", preserveAspectRatio: "xMidYMid meet" }, host);
  DRAW[id](pen(svg), variant);
}
