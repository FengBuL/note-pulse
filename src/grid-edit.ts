/*
 * 编辑看板时卡片的拖动、拖角调大小和键盘操作。用 Pointer 事件自己实现：
 * HTML5 拖放拿不到中途位置，做不了实时让位，拖动的样子也由浏览器决定。
 * 算法（让位、上浮、夹范围）在 grid.ts，这里只管 DOM：跟手、占位框、让位动画、自动滚动、Esc 取消。
 * 拖动过程中不保存、不重画卡片内容，只改位置；松手保存一次。
 */
import { COLS, GAP, GridItem, LimitsOf, ROW_H, growItem, moveItem, nudgeItem, resizeItem } from "./grid";
import { MOTION, playLayout, snapshotRects } from "./motion";

export interface GestureHost {
  grid: HTMLElement;
  /** 当前已经保存的布局 */
  items(): GridItem[];
  limitsOf: LimitsOf;
  /** 把这套布局画出来（只改位置和大小，不保存）；skip 是正被拖着的卡，它自己的位置不动 */
  show(items: GridItem[], skip?: string): void;
  /** 手势结束：保存这套布局 */
  commit(items: GridItem[]): void;
  /** 某张卡的大小变了（拖角调大小时每跨过一个格子调用一次）：按新尺寸重画内容 */
  resized(id: string): void;
  /** 键盘操作的读屏播报 */
  announce(id: string, item: GridItem): void;
  /** 键盘按 Delete：移除这张卡 */
  remove(id: string): void;
  /** 手势全部结束（含取消）：该补的重画可以补了 */
  ended(): void;
  scroller(): HTMLElement;
  motion(): boolean;
}

/** 位置和大小写成 CSS 变量，styles.css 据此摆进栅格 */
export function setPlace(el: HTMLElement, it: GridItem) {
  el.setCssProps({ "--vp-x": String(it.x), "--vp-y": String(it.y), "--vp-w": String(it.w), "--vp-h": String(it.h) });
}

const same = (a: GridItem[], b: GridItem[]): boolean =>
  a.length === b.length && a.every((x) => {
    const y = b.find((i) => i.id === x.id);
    return !!y && y.x === x.x && y.y === x.y && y.w === x.w && y.h === x.h;
  });

const DRAG_THRESHOLD = 4;
const EDGE = 48;
const MAX_SCROLL = 18;
const SETTLE_MS = 160;
const SHIFT_MS = 200;

export class GridGesture {
  /** 正在进行的手势（期间不要整页重画） */
  active = false;

  constructor(private host: GestureHost) {}

  attach() {
    const g = this.host.grid;
    g.addEventListener("pointerdown", (e) => this.onDown(e));
    g.addEventListener("keydown", (e) => this.onKey(e));
  }

  /* ---------- 指针：拖动换位置、拖角调大小 ---------- */

  private onDown(e: PointerEvent) {
    const target = e.target as HTMLElement;
    const card = target.closest<HTMLElement>(".vp-grid > .vp-w");
    const id = card?.dataset.widget;
    if (!card || !id || e.button !== 0 || this.active || target.closest(".vp-w-remove")) return;
    const resize = !!target.closest(".vp-w-handle");
    e.preventDefault();
    card.focus({ preventScroll: true });
    this.run(card, id, resize, e);
  }

  private run(card: HTMLElement, id: string, resize: boolean, down: PointerEvent) {
    const h = this.host;
    const grid = h.grid;
    const doc = grid.ownerDocument;
    const win = doc.defaultView as Window;
    const scroller = h.scroller();
    const base = h.items().map((i) => ({ ...i }));
    const cur0 = base.find((i) => i.id === id);
    if (!cur0) return;
    const gridRect = grid.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const unitX = (grid.clientWidth + GAP) / COLS;
    const unitY = ROW_H + GAP;
    const origin = { x: cardRect.left - gridRect.left, y: cardRect.top - gridRect.top };
    const startScroll = scroller.scrollTop;
    const pointerId = down.pointerId;
    this.active = true;
    let last = { x: down.clientX, y: down.clientY };
    let dragging = false;
    let shown = base;
    let placeholder: HTMLElement | null = null;
    let badge: HTMLElement | null = null;
    let raf = 0;
    let frame = 0;
    try {
      card.setPointerCapture(pointerId);
    } catch {
      /* 合成事件没有真正的指针，忽略 */
    }

    const flipTo = (next: GridItem[], opts: { ms: number; skip?: string }) => {
      const before = h.motion() ? snapshotRects(grid) : null;
      h.show(next, resize ? undefined : id);
      const me = next.find((i) => i.id === id);
      if (placeholder && me) setPlace(placeholder, me);
      if (before) playLayout(grid, before, opts);
    };

    const update = () => {
      const dx = last.x - down.clientX;
      const dy = last.y - down.clientY + (scroller.scrollTop - startScroll);
      if (!dragging) {
        if (Math.hypot(dx, last.y - down.clientY) < DRAG_THRESHOLD) return;
        dragging = true;
        grid.addClass("is-gesture");
        card.addClass(resize ? "is-resizing-card" : "is-dragging");
        if (resize) {
          badge = card.createDiv({ cls: "vp-w-badge", attr: { "aria-hidden": "true" } });
        } else {
          placeholder = grid.createDiv({ cls: "vp-ph", attr: { "data-widget": "__ph", "aria-hidden": "true" } });
          setPlace(placeholder, cur0);
        }
        raf = win.requestAnimationFrame(tick);
      }
      let next: GridItem[];
      if (resize) {
        const w = Math.round((cardRect.width + dx + GAP) / unitX);
        const hh = Math.round((cardRect.height + dy + GAP) / unitY);
        next = resizeItem(base, id, w, hh, h.limitsOf);
        const me = next.find((i) => i.id === id);
        if (badge && me) badge.setText(`${me.w} × ${me.h}`);
      } else {
        card.setCssProps({ "--vp-drag-x": `${dx}px`, "--vp-drag-y": `${dy}px` });
        next = moveItem(base, id, Math.round((origin.x + dx) / unitX), Math.round((origin.y + dy) / unitY));
      }
      if (same(next, shown)) return;
      const prev = shown.find((i) => i.id === id);
      shown = next;
      flipTo(next, { ms: SHIFT_MS, skip: id });
      const me = next.find((i) => i.id === id);
      if (resize && prev && me && (prev.w !== me.w || prev.h !== me.h) && !frame) {
        // 每跨过一个格子重画这张卡的内容，每帧最多一次
        frame = win.requestAnimationFrame(() => {
          frame = 0;
          h.resized(id);
        });
      }
    };

    /** 指针靠近滚动区上下边缘 48px 时自动滚动 */
    const tick = () => {
      // 文档本身在滚动时，可见范围是窗口而不是整个文档
      const r = scroller === doc.scrollingElement ? { top: 0, bottom: win.innerHeight } : scroller.getBoundingClientRect();
      let v = 0;
      if (last.y < r.top + EDGE) v = -((r.top + EDGE - last.y) / EDGE) * MAX_SCROLL;
      else if (last.y > r.bottom - EDGE) v = ((last.y - (r.bottom - EDGE)) / EDGE) * MAX_SCROLL;
      if (v) {
        scroller.scrollTop += v;
        update();
      }
      raf = win.requestAnimationFrame(tick);
    };

    const finish = (commit: boolean) => {
      win.cancelAnimationFrame(raf);
      win.cancelAnimationFrame(frame);
      card.removeEventListener("pointermove", onMove);
      card.removeEventListener("pointerup", onUp);
      card.removeEventListener("pointercancel", onCancel);
      card.removeEventListener("lostpointercapture", onCancel);
      doc.removeEventListener("keydown", onEsc, true);
      try {
        card.releasePointerCapture(pointerId);
      } catch {
        /* 已经释放 */
      }
      if (!dragging) {
        this.active = false;
        h.ended();
        return;
      }
      const final = commit ? shown : base;
      // 落位：从手指松开的地方滑进占位框（取消时滑回原位）；拖角调大小的那张直接到位
      const from = card.getBoundingClientRect();
      card.removeClass("is-dragging");
      card.removeClass("is-resizing-card");
      card.setCssProps({ "--vp-drag-x": "", "--vp-drag-y": "" });
      grid.removeClass("is-gesture");
      placeholder?.remove();
      badge?.remove();
      const before = h.motion() ? snapshotRects(grid) : null;
      if (before && !resize) before.set(id, from);
      h.show(final);
      if (before) playLayout(grid, before, { ms: commit && !resize ? SETTLE_MS : SHIFT_MS, skip: resize ? id : undefined });
      this.active = false;
      if (commit && !same(final, base)) h.commit(final);
      if (resize) h.resized(id);
      h.ended();
    };

    const onMove = (e: PointerEvent) => {
      last = { x: e.clientX, y: e.clientY };
      update();
    };
    const onUp = (e: PointerEvent) => {
      last = { x: e.clientX, y: e.clientY };
      update();
      finish(true);
    };
    const onCancel = () => finish(false);
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    };
    card.addEventListener("pointermove", onMove);
    card.addEventListener("pointerup", onUp);
    card.addEventListener("pointercancel", onCancel);
    card.addEventListener("lostpointercapture", onCancel);
    doc.addEventListener("keydown", onEsc, true);
  }

  /* ---------- 键盘：方向键移动一格，Shift + 方向键调大小，Delete 移除 ---------- */

  private onKey(e: KeyboardEvent) {
    const card = e.target as HTMLElement;
    const id = card.dataset?.widget;
    if (!id || !card.classList.contains("vp-w") || this.active) return;
    const base = this.host.items();
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      this.host.remove(id);
      return;
    }
    const d = arrows[e.key];
    if (!d || e.altKey || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    const next = e.shiftKey ? growItem(base, id, d[0], d[1], this.host.limitsOf) : nudgeItem(base, id, d[0], d[1]);
    const me = next.find((i) => i.id === id);
    if (!me || same(next, base)) {
      if (me) this.host.announce(id, me);
      return;
    }
    const before = this.host.motion() ? snapshotRects(this.host.grid) : null;
    this.host.show(next);
    if (before) playLayout(this.host.grid, before, { ms: MOTION.base });
    this.host.commit(next);
    if (e.shiftKey) this.host.resized(id);
    this.host.announce(id, me);
  }
}
