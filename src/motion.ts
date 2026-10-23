/* 看板动效：只在首次打开、用户操作和数值真的变化时播放；系统“减弱动态效果”或设置里关掉时全部跳过 */
import { splitNum } from "./charts";

/** 与 styles.css 里的 --vp-t-* 令牌保持一致（JS 动画读不到 CSS 变量的毫秒值） */
export const MOTION = {
  base: 240,
  resize: 320,
  count: 700,
  /** 首次打开：最后一张卡开始入场的延迟（--vp-t-stagger） */
  stagger: 600,
  /** is-intro / is-swap 类保留多久：要覆盖最慢的那段入场动画 */
  introTotal: 1800,
  swapTotal: 1200,
  ease: "cubic-bezier(0.2, 0, 0, 1)",
};
const EASE = MOTION.ease;

export function reducedMotion(win: Window | null | undefined): boolean {
  return !!win?.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** 缓出：开头快、结尾慢，数字滚动用 */
export function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/** 从 from 到 to 的第 t（0–1）帧数值；整数目标逐帧取整，避免出现小数 */
export function tweenValue(from: number, to: number, t: number): number {
  const v = from + (to - from) * easeOut(Math.max(0, Math.min(1, t)));
  return Number.isInteger(to) && Number.isInteger(from) ? Math.round(v) : v;
}

/** 把 bigNumber 生成的“数字 + 单位”从 from 滚到 to；元素被移除后自动停止 */
export function countUp(el: HTMLElement, from: number, to: number, unit = "", duration = MOTION.count, delay = 0) {
  const win = el.ownerDocument.defaultView;
  if (!win) return;
  const paint = (v: number) => {
    const p = splitNum(v, unit);
    const valueEl = el.querySelector(".vp-num-value");
    if (valueEl) valueEl.textContent = p.value;
    let unitEl = el.querySelector(".vp-num-unit");
    if (p.unit && !unitEl) unitEl = el.createSpan({ cls: "vp-num-unit" });
    if (unitEl) unitEl.textContent = p.unit;
  };
  const start = win.performance.now() + delay;
  const frame = (now: number) => {
    if (!el.isConnected && now - start > 50) return;
    const t = Math.max(0, now - start) / duration;
    paint(tweenValue(from, to, t));
    if (t < 1) win.requestAnimationFrame(frame);
  };
  paint(from);
  win.requestAnimationFrame(frame);
}

/** 高度从 from 过渡到元素现在的高度（重绘、展开、收起之后调用） */
export function animateHeight(el: HTMLElement, from: number) {
  const to = el.getBoundingClientRect().height;
  if (!el.animate || Math.abs(to - from) < 2) return;
  el.addClass("is-resizing");
  const a = el.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: MOTION.resize, easing: EASE });
  const done = () => el.removeClass("is-resizing");
  a.onfinish = done;
  a.oncancel = done;
}

export interface SegRect {
  x: number;
  w: number;
}

/** 分段控件里选中项的位置（相对控件本身） */
export function segRect(seg: HTMLElement): SegRect | null {
  const a = seg.querySelector<HTMLElement>(".is-active");
  if (!a) return null;
  const s = seg.getBoundingClientRect();
  const r = a.getBoundingClientRect();
  return { x: r.left - s.left, w: r.width };
}

/** 分段控件：选中底色从旧位置滑到新位置 */
export function slideSeg(seg: HTMLElement, from: SegRect) {
  const to = segRect(seg);
  if (!to || !seg.animate || (Math.abs(to.x - from.x) < 1 && Math.abs(to.w - from.w) < 1)) return;
  const ind = seg.createDiv({ cls: "vp-seg-ind", attr: { "aria-hidden": "true" } });
  seg.addClass("is-sliding");
  const a = ind.animate(
    [
      { transform: `translateX(${from.x}px)`, width: `${from.w}px` },
      { transform: `translateX(${to.x}px)`, width: `${to.w}px` },
    ],
    { duration: MOTION.base, easing: EASE }
  );
  const done = () => {
    ind.remove();
    seg.removeClass("is-sliding");
  };
  a.onfinish = done;
  a.oncancel = done;
}

/**
 * 给列表行、柱子、热力图格子写上先后次序（--vp-i），CSS 按它错开入场动画的开始时间。
 * 热力图按列（从左到右扫过去），其余按同类兄弟元素里的位置，最多错开 12 步。
 */
export function markStagger(root: HTMLElement) {
  const lists = [".vp-rows > .vp-row", ".vp-barlist > .vp-barrow", ".vp-week > .vp-week-day", ".vp-checkup > .vp-checkup-col", ".vp-chart .vp-bar"];
  for (const sel of lists) {
    const seen = new Map<Element | null, number>();
    root.querySelectorAll<HTMLElement | SVGElement>(sel).forEach((el) => {
      const n = seen.get(el.parentElement) ?? 0;
      seen.set(el.parentElement, n + 1);
      el.style.setProperty("--vp-i", String(Math.min(12, n)));
    });
  }
  root.querySelectorAll<SVGSVGElement>("svg.vp-heatmap").forEach((svg) => {
    const w = Number(svg.getAttribute("width")) || 1;
    svg.querySelectorAll<SVGRectElement>(".vp-heat-cell").forEach((c) => {
      c.style.setProperty("--vp-i", String(Math.round((Number(c.getAttribute("x")) / w) * 20)));
    });
  });
}

/** 走势线：按路径长度从左往右描出来（不依赖 clip-path，iOS 16 也能用） */
export function drawLines(root: HTMLElement, delay: number) {
  root.querySelectorAll<SVGPathElement>(".vp-spark-line").forEach((path) => {
    if (!path.animate || !path.getTotalLength) return;
    // 线条用了 non-scaling-stroke，虚线长度按屏幕像素算；SVG 又被横向拉伸，所以把路径长度换算到屏幕上（取较大的缩放比，宁长勿短）
    const svg = path.ownerSVGElement;
    const vb = svg?.viewBox.baseVal;
    const box = svg?.getBoundingClientRect();
    const scale = vb && box && vb.width && vb.height ? Math.max(box.width / vb.width, box.height / vb.height) : 1;
    const len = path.getTotalLength() * scale;
    if (!len) return;
    path.animate([{ strokeDasharray: `${len} ${len}`, strokeDashoffset: len }, { strokeDasharray: `${len} ${len}`, strokeDashoffset: 0 }], {
      duration: MOTION.count + 200,
      delay: delay + MOTION.base,
      easing: EASE,
      fill: "backwards",
    });
  });
}
