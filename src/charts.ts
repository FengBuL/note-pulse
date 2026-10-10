/* 原生 SVG / HTML 图表：无外部依赖，颜色全部来自 CSS 变量 */

const SVG_NS = "http://www.w3.org/2000/svg";
let uid = 0;

export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
  parent?: Element
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K];
  for (const k of Object.keys(attrs)) el.setAttribute(k, String(attrs[k]));
  if (parent) parent.appendChild(el);
  return el;
}

/* ---------------- 数字格式 ---------------- */

/** 拆分为数字和单位，便于大号数字 + 小号单位的排版 */
export function fmtParts(n: number): { num: string; unit: string } {
  const a = Math.abs(n);
  if (a >= 1e8) return { num: trimZero((n / 1e8).toFixed(2)), unit: "亿" };
  if (a >= 1e4) return { num: trimZero((n / 1e4).toFixed(a >= 1e6 ? 0 : 1)), unit: "万" };
  return { num: Math.round(n).toLocaleString("en-US"), unit: "" };
}

function trimZero(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
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
    const p = fmtParts(n);
    el.createSpan({ cls: "vp-num-value", text: p.num });
    const u = (p.unit || "") + (unit || "");
    if (u) el.createSpan({ cls: "vp-num-unit", text: u });
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

function monotonePath(xs: number[], ys: number[]): string {
  const n = xs.length;
  if (n === 0) return "";
  if (n === 1) return `M${xs[0]},${ys[0]}`;
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) m.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i] || 1));
  const t: number[] = new Array(n);
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
  const doc = el.ownerDocument;
  const id = `vp-sr-${++srSeq}`;
  const span = doc.createElement("span");
  span.className = "vp-sr-only";
  span.id = id;
  span.textContent = text;
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
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
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
  kind: "area" | "bar";
  zeroBased?: boolean;
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
    const bw = Math.max(2, Math.min(28, step * 0.62));
    points.forEach((p, i) => {
      const y = yOf(p.value);
      const h = Math.max(p.value > 0 ? 2 : 0, padT + ch - y);
      bars.push(
        svgEl(
          "rect",
          { x: xOf(i) - bw / 2, y: padT + ch - h, width: bw, height: h, rx: Math.min(4, bw / 2), class: "vp-bar" },
          svg
        )
      );
    });
  } else {
    const xs = points.map((_, i) => xOf(i));
    const ys = points.map((p) => yOf(p.value));
    const line = monotonePath(xs, ys);
    const base = padT + ch;
    svgEl(
      "path",
      { d: `${line} L${xs[n - 1].toFixed(1)},${base} L${xs[0].toFixed(1)},${base} Z`, class: "vp-area", fill: `url(#${gid})` },
      svg
    );
    svgEl("path", { d: line, class: "vp-line" }, svg);
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

export function drawSparkline(container: HTMLElement, values: number[]) {
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
  const line = monotonePath(xs, ys);
  svgEl("path", { d: `${line} L${W},${H} L0,${H} Z`, fill: `url(#${gid})`, class: "vp-spark-area" }, svg);
  svgEl("path", { d: line, class: "vp-spark-line" }, svg);
}

/* ---------------- 圆环 ---------------- */

/** 画一个进度圆环，返回中心的 HTML 容器，用于放置文字 */
export function drawRing(container: HTMLElement, ratio: number, size: number, stroke: number, cls = ""): HTMLElement {
  const wrap = container.createDiv({ cls: `vp-ring ${cls}` });
  wrap.style.width = `${size}px`;
  wrap.style.height = `${size}px`;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const svg = svgEl("svg", { width: size, height: size, viewBox: `0 0 ${size} ${size}` }, wrap);
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
    top.createSpan({ cls: "vp-barvalue", text: it.valueText ?? fmtNum(it.value) });
    const track = row.createDiv({ cls: "vp-bartrack" });
    const fill = track.createDiv({ cls: "vp-barfill" });
    fill.style.width = `${Math.max(2, (it.value / max) * 100)}%`;
    // 排名越靠前颜色越饱和：同一强调色的不同浓度
    const strength = Math.round(100 - (idx / Math.max(1, items.length - 1)) * 55);
    fill.style.background = `color-mix(in srgb, var(--vp-accent) ${strength}%, transparent)`;
    if (it.onClick) {
      const cb = it.onClick;
      row.addClass("is-clickable");
      row.setAttribute("role", "button");
      row.setAttribute("tabindex", "0");
      srLabel(row, `${it.label}，${it.valueText ?? fmtNum(it.value)}`);
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
