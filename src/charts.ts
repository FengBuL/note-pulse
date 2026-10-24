/* 原生 SVG / HTML 图表：无外部依赖，颜色全部来自 CSS 变量 */
import { L, isZh } from "./i18n";

const SVG_NS = "http://www.w3.org/2000/svg";
let uid = 0;

export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
  parent?: Element
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const k of Object.keys(attrs)) el.setAttribute(k, String(attrs[k]));
  if (parent) parent.appendChild(el);
  return el;
}

/* ---------------- 数字格式 ---------------- */

/** 拆分为数字和单位，便于大号数字 + 小号单位的排版 */
export function fmtParts(n: number): { num: string; unit: string } {
  const a = Math.abs(n);
  if (isZh()) {
    if (a >= 1e8) return { num: trimZero((n / 1e8).toFixed(2)), unit: "亿" };
    if (a >= 1e4) return { num: trimZero((n / 1e4).toFixed(a >= 1e6 ? 0 : 1)), unit: "万" };
  } else {
    // 英文：1.2K、34K、1.5M（单位紧贴数字，后面再接 " words" 之类的空格）
    if (a >= 1e6) return { num: trimZero((n / 1e6).toFixed(a >= 1e8 ? 0 : 1)), unit: "M" };
    if (a >= 1e4) return { num: trimZero((n / 1e3).toFixed(a >= 1e5 ? 0 : 1)), unit: "K" };
  }
  return { num: Math.round(n).toLocaleString("en-US"), unit: "" };
}

function trimZero(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/**
 * 大数字排版：中文“200 / 万字”（万和字一起放进单位），英文“200K / words”（K 紧贴数字，单位另起）。
 * bigNumber 和数字滚动都用它，保证两边拆法一致。
 */
export function splitNum(n: number, unit = ""): { value: string; unit: string } {
  const p = fmtParts(n);
  return isZh() ? { value: p.num, unit: p.unit + unit } : { value: p.num + p.unit, unit };
}

export function fmtNum(n: number): string {
  const p = fmtParts(n);
  return p.num + p.unit;
}

export function fmtFull(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** 渲染“大数字 + 小单位” */
export function bigNumber(parent: HTMLElement, n: number | string, unit?: string, cls = "vp-num"): HTMLElement {
  const el = parent.createDiv({ cls });
  if (typeof n === "number") {
    const p = splitNum(n, unit);
    el.createSpan({ cls: "vp-num-value", text: p.value });
    if (p.unit) el.createSpan({ cls: "vp-num-unit", text: p.unit });
  } else {
    el.createSpan({ cls: "vp-num-value", text: n });
    if (unit) el.createSpan({ cls: "vp-num-unit", text: unit });
  }
  return el;
}

/* ---------------- 刻度 ---------------- */

function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const r = raw / p;
  return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10) * p;
}

function niceTicks(min: number, max: number, count: number, zeroBased: boolean): number[] {
  if (zeroBased || min > max * 0.98) min = zeroBased ? 0 : min;
  if (max <= min) max = min + 1;
  let lo = zeroBased ? 0 : min;
  // 数据变化不大时不从 0 开始，避免曲线贴着顶部变成一条直线
  if (!zeroBased && min < max * 0.35) lo = 0;
  // 数据均为整数，刻度步长至少为 1
  const step = Math.max(1, niceStep((max - lo) / count));
  lo = Math.floor(lo / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(v);
  return ticks;
}

/* ---------------- 平滑曲线（单调三次插值，不会过冲） ---------------- */

/** 折线：相邻两点直接连 */
function polylinePath(xs: number[], ys: number[]): string {
  return xs.map((x, i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(" ");
}

function monotonePath(xs: number[], ys: number[]): string {
  const n = xs.length;
  if (n === 0) return "";
  if (n === 1) return `M${xs[0]},${ys[0]}`;
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) m.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i] || 1));
  const t = new Array<number>(n);
  t[0] = m[0];
  t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i] / m[i],
      b = t[i + 1] / m[i],
      s = a * a + b * b;
    if (s > 9) {
      const k = 3 / Math.sqrt(s);
      t[i] = k * a * m[i];
      t[i + 1] = k * b * m[i];
    }
  }
  let d = `M${xs[0].toFixed(1)},${ys[0].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const dx = (xs[i + 1] - xs[i]) / 3;
    d += ` C${(xs[i] + dx).toFixed(1)},${(ys[i] + t[i] * dx).toFixed(1)} ${(xs[i + 1] - dx).toFixed(1)},${(
      ys[i + 1] -
      t[i + 1] * dx
    ).toFixed(1)} ${xs[i + 1].toFixed(1)},${ys[i + 1].toFixed(1)}`;
  }
  return d;
}

/* ---------------- 悬浮提示 ---------------- */

export type TipRow = { label: string; value: string; dot?: string };

let srSeq = 0;
/**
 * 给元素加一个无障碍名称，但不会触发 Obsidian 自带的悬停提示
 * （Obsidian 会给所有带 aria-label 属性的元素弹提示，会和我们自己的气泡重复）。
 * 做法：在 holder 里放一段视觉隐藏的文字，再用 aria-labelledby 指向它。
 */
export function srLabel(el: Element, text: string, holder?: Element): void {
  const id = `vp-sr-${++srSeq}`;
  const span = createSpan({ cls: "vp-sr-only", attr: { id }, text });
  if (holder) holder.appendChild(span);
  else el.appendChild(span);
  el.setAttribute("aria-labelledby", id);
}

export class Tooltip {
  el: HTMLElement;
  constructor(private host: HTMLElement) {
    this.el = host.createDiv({ cls: "vp-tooltip" });
  }
  /** x / y 为相对 host 的坐标，提示框显示在该点上方 */
  show(x: number, y: number, title: string, rows: TipRow[]) {
    const el = this.el;
    el.empty();
    el.createDiv({ cls: "vp-tooltip-title", text: title });
    for (const r of rows) {
      const row = el.createDiv({ cls: "vp-tooltip-row" });
      if (r.dot) row.createSpan({ cls: `vp-tooltip-dot ${r.dot}` });
      row.createSpan({ cls: "vp-tooltip-label", text: r.label });
      row.createSpan({ cls: "vp-tooltip-value", text: r.value });
    }
    el.addClass("is-visible");
    const w = el.offsetWidth,
      h = el.offsetHeight;
    const maxX = this.host.clientWidth - w - 4;
    const left = Math.max(4, Math.min(maxX, x - w / 2));
    // 上方空间不够（超出所在卡片）时改为显示在下方
    const bound = (this.host.closest(".vp-card") || this.host).getBoundingClientRect();
    const hostTop = this.host.getBoundingClientRect().top;
    let top = y - h - 12;
    if (hostTop + top < bound.top + 4) top = y + 16;
    el.setCssProps({ "--vp-tip-left": `${left}px` });
    el.setCssProps({ "--vp-tip-top": `${top}px` });
  }
  /** 以视口坐标定位 */
  showAtClient(clientX: number, clientY: number, title: string, rows: TipRow[]) {
    const r = this.host.getBoundingClientRect();
    this.show(clientX - r.left, clientY - r.top, title, rows);
  }
  hide() {
    this.el.removeClass("is-visible");
  }
}

/* ---------------- 趋势图 ---------------- */

export interface SeriesPoint {
  label: string;
  value: number;
  tipTitle: string;
  tipRows: TipRow[];
}

export interface ChartOptions {
  width: number;
  height: number;
  /** bar 柱状；line 折线；curve 平滑曲线；area 平滑曲线加下面的面积 */
  kind: "area" | "bar" | "line" | "curve";
  zeroBased?: boolean;
  /** 柱状图：最后一根（本日 / 本周）用实色，其余用浅色 */
  highlightLast?: boolean;
  tooltip: Tooltip;
}

export function drawTrendChart(container: HTMLElement, points: SeriesPoint[], o: ChartOptions) {
  const W = Math.max(240, Math.floor(o.width)),
    H = o.height;
  const padL = 48,
    padR = 12,
    padT = 12,
    padB = 28;
  const cw = W - padL - padR,
    ch = H - padT - padB;
  const svg = svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: "vp-chart" }, container);
  const n = points.length;
  if (n === 0) return;

  const values = points.map((p) => p.value);
  const ticks = niceTicks(Math.min(...values), Math.max(...values, 1), 4, o.kind === "bar" || !!o.zeroBased);
  const lo = ticks[0],
    hi = ticks[ticks.length - 1];
  const yOf = (v: number) => padT + ch - ((v - lo) / (hi - lo || 1)) * ch;

  for (const t of ticks) {
    const y = Math.round(yOf(t)) + 0.5;
    svgEl("line", { x1: padL, x2: W - padR, y1: y, y2: y, class: t === lo ? "vp-axis-base" : "vp-gridline" }, svg);
    const tx = svgEl("text", { x: padL - 10, y: y + 4, "text-anchor": "end", class: "vp-axis-text" }, svg);
    tx.textContent = fmtNum(t);
  }

  const isBar = o.kind === "bar";
  const step = isBar ? cw / n : cw / Math.max(1, n - 1);
  const xOf = (i: number) => (isBar ? padL + i * step + step / 2 : n === 1 ? padL + cw / 2 : padL + i * step);

  // X 轴标签：按可用宽度自动抽稀
  const maxLabels = Math.max(2, Math.floor(cw / 64));
  const every = Math.max(1, Math.ceil(n / maxLabels));
  for (let i = 0; i < n; i++) {
    const isLast = i === n - 1;
    if (i % every !== 0 && !isLast) continue;
    if (isLast && i % every !== 0 && (n - 1) % every < every * 0.6) continue;
    const anchor = isBar ? "middle" : i === 0 ? "start" : isLast ? "end" : "middle";
    const tx = svgEl("text", { x: xOf(i), y: H - 8, "text-anchor": anchor, class: "vp-axis-text" }, svg);
    tx.textContent = points[i].label;
  }

  const gid = `vp-grad-${++uid}`;
  const defs = svgEl("defs", {}, svg);
  const grad = svgEl("linearGradient", { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
  svgEl("stop", { offset: "0%", class: "vp-grad-top" }, grad);
  svgEl("stop", { offset: "100%", class: "vp-grad-bottom" }, grad);

  const bars: SVGRectElement[] = [];
  if (isBar) {
    // 柱子上浓下淡的渐变（颜色取自 CSS 里的 stop-color）
    const bgid = `${gid}-bar`;
    const bgrad = svgEl("linearGradient", { id: bgid, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    svgEl("stop", { offset: "0%", class: "vp-bargrad-top" }, bgrad);
    svgEl("stop", { offset: "100%", class: "vp-bargrad-bottom" }, bgrad);
    const hgrad = svgEl("linearGradient", { id: `${bgid}-hi`, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    svgEl("stop", { offset: "0%", class: "vp-stroke-b" }, hgrad);
    svgEl("stop", { offset: "100%", class: "vp-stroke-a" }, hgrad);
    const bw = Math.max(2, Math.min(28, step * 0.62));
    points.forEach((p, i) => {
      const y = yOf(p.value);
      const h = Math.max(p.value > 0 ? 2 : 0, padT + ch - y);
      bars.push(
        svgEl(
          "rect",
          {
            x: xOf(i) - bw / 2,
            y: padT + ch - h,
            width: bw,
            height: h,
            rx: Math.min(4, bw / 2),
            class: "vp-bar" + (o.highlightLast && i === n - 1 ? " is-current" : ""),
            fill: `url(#${o.highlightLast && i === n - 1 ? `${bgid}-hi` : bgid})`,
          },
          svg
        )
      );
    });
  } else {
    const xs = points.map((_, i) => xOf(i));
    const ys = points.map((p) => yOf(p.value));
    const line = o.kind === "line" ? polylinePath(xs, ys) : monotonePath(xs, ys);
    const base = padT + ch;
    if (o.kind === "area") {
      svgEl(
        "path",
        { d: `${line} L${xs[n - 1].toFixed(1)},${base} L${xs[0].toFixed(1)},${base} Z`, class: "vp-area", fill: `url(#${gid})` },
        svg
      );
    }
    svgEl("path", { d: line, class: "vp-line" }, svg);
    // 折线、曲线：每个数据点画一个小圆点（点太密时只画最后一个）
    if ((o.kind === "line" || o.kind === "curve") && n <= 40) for (let i = 0; i < n - 1; i++) svgEl("circle", { cx: xs[i], cy: ys[i], r: 2.5, class: "vp-line-dot" }, svg);
    svgEl("circle", { cx: xs[n - 1], cy: ys[n - 1], r: 4, class: "vp-line-end" }, svg);
  }

  // 悬停：参考线 + 焦点 + 提示
  const guide = svgEl("line", { x1: 0, x2: 0, y1: padT, y2: padT + ch, class: "vp-guide" }, svg);
  const focus = svgEl("circle", { cx: 0, cy: 0, r: 5, class: "vp-focus" }, svg);
  const hit = svgEl("rect", { x: padL, y: 0, width: cw, height: H, class: "vp-hit" }, svg);
  let lastIdx = -1;
  const onMove = (e: MouseEvent) => {
    const r = svg.getBoundingClientRect();
    const mx = e.clientX - r.left;
    let i = isBar ? Math.floor((mx - padL) / step) : Math.round((mx - padL) / step);
    i = Math.max(0, Math.min(n - 1, i));
    if (i !== lastIdx) {
      lastIdx = i;
      bars.forEach((b, k) => b.toggleClass("is-dim", k !== i));
    }
    const x = xOf(i),
      y = yOf(points[i].value);
    guide.setAttribute("x1", String(x));
    guide.setAttribute("x2", String(x));
    svg.addClass("is-hover");
    if (!isBar) {
      focus.setAttribute("cx", String(x));
      focus.setAttribute("cy", String(y));
    }
    o.tooltip.showAtClient(r.left + x, r.top + Math.min(y, padT + ch - 8), points[i].tipTitle, points[i].tipRows);
  };
  hit.addEventListener("mousemove", onMove);
  hit.addEventListener("mouseleave", () => {
    lastIdx = -1;
    svg.removeClass("is-hover");
    bars.forEach((b) => b.removeClass("is-dim"));
    o.tooltip.hide();
  });
}

/* ---------------- 迷你折线 ---------------- */

export interface SparkScrub {
  /** 悬停 / 方向键移到第 i 个点时调用；i 为 null 表示离开，恢复默认 */
  onPoint: (i: number | null) => void;
  /** 读屏文字 */
  label: (i: number) => string;
}

export function drawSparkline(container: HTMLElement, values: number[], scrub?: SparkScrub) {
  const W = 120,
    H = 36;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", class: "vp-spark" }, container);
  if (values.length < 2) return;
  const min = Math.min(...values),
    max = Math.max(...values);
  const span = max - min || 1;
  const xs = values.map((_, i) => (i / (values.length - 1)) * W);
  const ys = values.map((v) => H - 3 - ((v - min) / span) * (H - 6));
  const gid = `vp-spark-${++uid}`;
  const defs = svgEl("defs", {}, svg);
  const grad = svgEl("linearGradient", { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
  svgEl("stop", { offset: "0%", class: "vp-grad-top" }, grad);
  svgEl("stop", { offset: "100%", class: "vp-grad-bottom" }, grad);
  const sgrad = svgEl("linearGradient", { id: `${gid}-s`, x1: 0, y1: 0, x2: 1, y2: 0 }, defs);
  svgEl("stop", { offset: "0%", class: "vp-stroke-a" }, sgrad);
  svgEl("stop", { offset: "100%", class: "vp-stroke-b" }, sgrad);
  const line = monotonePath(xs, ys);
  svgEl("path", { d: `${line} L${W},${H} L0,${H} Z`, fill: `url(#${gid})`, class: "vp-spark-area" }, svg);
  svgEl("path", { d: line, class: "vp-spark-line", stroke: `url(#${gid}-s)` }, svg);
  if (!scrub) return;

  // 参考线和圆点用 HTML 叠在上面：SVG 被横向拉伸（preserveAspectRatio=none），圆点画在里面会变成椭圆
  container.addClass("vp-spark-host");
  const guide = container.createDiv({ cls: "vp-spark-guide" });
  const dot = container.createDiv({ cls: "vp-spark-dot" });
  const live = container.createDiv({ cls: "vp-sr-only", attr: { "aria-live": "polite" } });
  let cur: number | null = null;
  const show = (i: number | null) => {
    if (i === cur) return;
    cur = i;
    container.toggleClass("is-scrubbing", i !== null);
    if (i !== null) {
      const left = `${(xs[i] / W) * 100}%`;
      guide.setCssProps({ "--vp-spark-x": left });
      dot.setCssProps({ "--vp-spark-x": left, "--vp-spark-y": `${(ys[i] / H) * 100}%` });
      live.setText(scrub.label(i));
    }
    scrub.onPoint(i);
  };
  const indexAt = (clientX: number) => {
    const r = container.getBoundingClientRect();
    const ratio = r.width > 0 ? (clientX - r.left) / r.width : 1;
    return Math.max(0, Math.min(values.length - 1, Math.round(ratio * (values.length - 1))));
  };
  container.setAttr("tabindex", "0");
  container.setAttr("role", "slider");
  container.setAttr("aria-valuemin", "1");
  container.setAttr("aria-valuemax", String(values.length));
  srLabel(container, L("近 12 周走势。用左右方向键逐周查看。", "Last 12 weeks. Use the left and right arrow keys to step through weeks."));
  container.addEventListener("pointermove", (e: PointerEvent) => {
    if (e.pointerType === "mouse" || e.buttons > 0) show(indexAt(e.clientX));
  });
  container.addEventListener("pointerdown", (e: PointerEvent) => {
    if (e.pointerType !== "mouse") show(indexAt(e.clientX));
  });
  container.addEventListener("pointerleave", () => show(null));
  container.addEventListener("pointerup", (e: PointerEvent) => {
    if (e.pointerType !== "mouse") show(null);
  });
  container.addEventListener("pointercancel", () => show(null));
  container.addEventListener("focus", () => show(values.length - 1));
  container.addEventListener("blur", () => show(null));
  container.addEventListener("keydown", (e: KeyboardEvent) => {
    const step = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      show(e.key === "Home" ? 0 : values.length - 1);
    } else if (step) {
      e.preventDefault();
      show(Math.max(0, Math.min(values.length - 1, (cur ?? values.length - 1) + step)));
    } else if (e.key === "Escape") show(null);
    if (cur !== null) container.setAttr("aria-valuenow", String(cur + 1));
  });
}

/* ---------------- 圆环 ---------------- */

/** 画一个进度圆环，返回中心的 HTML 容器，用于放置文字 */
export function drawRing(container: HTMLElement, ratio: number, size: number, stroke: number, cls = ""): HTMLElement {
  const wrap = container.createDiv({ cls: `vp-ring ${cls}` });
  // 尺寸通过 CSS 变量传入，样式表里的 .vp-ring 用它设置宽高（窄屏时可以直接覆盖，不必 !important）
  wrap.setCssProps({ "--vp-ring-size": `${size}px` });
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const svg = svgEl("svg", { width: size, height: size, viewBox: `0 0 ${size} ${size}` }, wrap);
  const gid = `vp-ring-${++uid}`;
  const grad = svgEl("linearGradient", { id: gid, x1: 0, y1: 0, x2: 1, y2: 1 }, svgEl("defs", {}, svg));
  svgEl("stop", { offset: "0%", class: "vp-stroke-a" }, grad);
  svgEl("stop", { offset: "100%", class: "vp-stroke-b" }, grad);
  svgEl("circle", { cx: size / 2, cy: size / 2, r, class: "vp-ring-track", "stroke-width": stroke, fill: "none" }, svg);
  const v = Math.max(0, Math.min(1, ratio));
  if (v > 0) {
    svgEl(
      "circle",
      {
        cx: size / 2,
        cy: size / 2,
        r,
        class: "vp-ring-value",
        stroke: `url(#${gid})`,
        "stroke-width": stroke,
        fill: "none",
        "stroke-dasharray": `${c * v} ${c}`,
        "stroke-linecap": "round",
        transform: `rotate(-90 ${size / 2} ${size / 2})`,
      },
      svg
    );
  }
  return wrap.createDiv({ cls: "vp-ring-center" });
}

/* ---------------- 水平条形列表 ---------------- */

export interface BarItem {
  label: string;
  value: number;
  valueText?: string;
  /** 数值左边的小字，比如“本周 +3” */
  note?: string;
  title?: string;
  onClick?: (evt: MouseEvent) => void;
}

export function drawBarList(container: HTMLElement, items: BarItem[], emptyText: string, emptyIcon?: (el: HTMLElement) => void) {
  const list = container.createDiv({ cls: "vp-barlist" });
  if (items.length === 0) {
    const e = list.createDiv({ cls: "vp-empty" });
    if (emptyIcon) emptyIcon(e);
    e.createDiv({ cls: "vp-empty-text", text: emptyText });
    return;
  }
  const max = Math.max(...items.map((i) => i.value), 1);
  items.forEach((it, idx) => {
    const row = list.createDiv({ cls: "vp-barrow" });
    const top = row.createDiv({ cls: "vp-barrow-top" });
    top.createSpan({ cls: "vp-barlabel", text: it.label, attr: { title: it.title ?? it.label } });
    const val = top.createSpan({ cls: "vp-barvalue" });
    if (it.note) val.createSpan({ cls: "vp-barnote", text: it.note });
    val.createSpan({ text: it.valueText ?? fmtNum(it.value) });
    const track = row.createDiv({ cls: "vp-bartrack" });
    const fill = track.createDiv({ cls: "vp-barfill" });
    fill.setCssProps({ "--vp-bar-width": `${Math.max(2, (it.value / max) * 100)}%` });
    // 排名越靠前颜色越饱和
    const strength = Math.round(100 - (idx / Math.max(1, items.length - 1)) * 50);
    fill.setCssProps({ "--vp-bar-strength": `${strength}%` });
    if (it.onClick) {
      const cb = it.onClick;
      row.addClass("is-clickable");
      row.setAttribute("role", "button");
      row.setAttribute("tabindex", "0");
      srLabel(row, `${it.label}${L("，", ", ")}${it.valueText ?? fmtNum(it.value)}`);
      row.addEventListener("click", (e) => cb(e));
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          cb(e as unknown as MouseEvent);
        }
      });
    }
  });
}

/* ---------------- 环形图 ---------------- */

export interface DonutPart {
  /** 占整体的比例（0–1） */
  share: number;
  /** 颜色类，如 is-c1 … is-c4、is-other */
  cls: string;
  title: string;
}

/** 环形图：每一段是一个 circle 的描边，颜色由 CSS 类决定；中间留给调用方放字（返回的容器里有 .vp-donut-center） */
export function drawDonut(container: HTMLElement, parts: DonutPart[], size: number, stroke: number): HTMLElement {
  const wrap = container.createDiv({ cls: "vp-donut" });
  wrap.setCssProps({ "--vp-donut-size": `${size}px` });
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const svg = svgEl("svg", { width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: "img" }, wrap);
  svgEl("circle", { cx: size / 2, cy: size / 2, r, class: "vp-donut-track", "stroke-width": stroke, fill: "none" }, svg);
  const gap = parts.length > 1 ? Math.min(3, c * 0.01) : 0;
  let offset = 0;
  for (const p of parts) {
    const len = Math.max(0, p.share * c - gap);
    if (len <= 0) continue;
    const seg = svgEl(
      "circle",
      {
        cx: size / 2,
        cy: size / 2,
        r,
        class: `vp-donut-seg ${p.cls}`,
        "stroke-width": stroke,
        fill: "none",
        "stroke-dasharray": `${len} ${c - len}`,
        "stroke-dashoffset": -offset,
        transform: `rotate(-90 ${size / 2} ${size / 2})`,
      },
      svg
    );
    svgEl("title", {}, seg).textContent = p.title;
    offset += p.share * c;
  }
  wrap.createDiv({ cls: "vp-donut-center" });
  return wrap;
}

/* ---------------- 本周七天的折线（无坐标轴，随容器拉伸） ---------------- */

/**
 * 七个点连成折线 / 曲线 / 面积，高度占比 fracs（0–1）。线和面积用 SVG（non-scaling-stroke，随容器宽度拉伸不变形），
 * 圆点和数字用 HTML 按百分比摆，不会被拉扁。返回每个点的 HTML 容器，调用方可以在里面再放东西。
 */
export function drawWeekLine(container: HTMLElement, fracs: number[], opts: { area: boolean; goal?: number; done: boolean[]; future: boolean[] }): void {
  const n = fracs.length;
  const W = 700;
  const H = 100;
  const xs = fracs.map((_, i) => ((i + 0.5) / n) * W);
  const ys = fracs.map((f) => H - Math.max(0, Math.min(1, f)) * H);
  const live = fracs.map((_, i) => !opts.future[i]);
  const idx = live.map((l, i) => (l ? i : -1)).filter((i) => i >= 0);
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", class: "vp-weekline-svg", "aria-hidden": "true" }, container);
  const path = monotonePath(idx.map((i) => xs[i]), idx.map((i) => ys[i]));
  if (idx.length > 1) {
    if (opts.area) {
      const gid = `vp-grad-${++uid}`;
      const grad = svgEl("linearGradient", { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 }, svgEl("defs", {}, svg));
      svgEl("stop", { offset: "0%", class: "vp-grad-top" }, grad);
      svgEl("stop", { offset: "100%", class: "vp-grad-bottom" }, grad);
      svgEl("path", { d: `${path} L${xs[idx[idx.length - 1]].toFixed(1)},${H} L${xs[idx[0]].toFixed(1)},${H} Z`, class: "vp-area", fill: `url(#${gid})` }, svg);
    }
    svgEl("path", { d: path, class: "vp-spark-line" }, svg);
  }
  if (opts.goal !== undefined) {
    const y = H - Math.max(0, Math.min(1, opts.goal)) * H;
    svgEl("line", { x1: 0, x2: W, y1: y, y2: y, class: "vp-weekline-goal" }, svg);
  }
}
