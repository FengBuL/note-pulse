/*
 * 编辑看板时卡片的拖动、拖角调大小和键盘操作。用 Pointer 事件自己实现：
 * HTML5 拖放拿不到中途位置，做不了实时让位，拖动的样子也由浏览器决定。
 * 算法（让位、夹范围）在 grid.ts，这里只管 DOM：跟手、占位框、让位动画、自动滚动、Esc 取消。
 * 拖动过程中不保存、不重画卡片内容，只改位置；松手保存一次。
 *
 * 手感上的几个做法：
 * - 被拖的卡（或调大小的卡）每一帧都跟着指针走，像素级，不按格子跳；格子吸附只体现在虚线占位框上。
 * - 指针事件合并到每帧处理一次；被拖的卡提升成独立的合成层，移动只是合成，不重绘。
 * - 落点就是指针所在的格子（虚线占位框立刻跟着走）；占位框压住别的卡时，那些卡要等指针在这一格停一会儿（180ms）才让开，
 *   划过去的途中别的卡一动不动，不会整个版面乱跳；占位框没压住任何卡时，不需要让位，立刻生效。
 * - 调大小时，移动途中只有卡片自己和虚线框在变，别的卡一动不动（它们的重排和动画是最费力的部分），
 *   指针停住 120ms 后才让位；内容每 200ms 重画一次。
 */
import { COLS, GAP, GridItem, LimitsOf, ROW_H, displacedCount, growItem, moveItemSnap, nudgeItem, placeItemSnap, resizeItem } from "./grid";
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
  /** 某张卡的大小变了：按新尺寸重画内容、重新截列表（拖角调大小时按固定间隔调用） */
  resized(id: string): void;
  /** 拖角调大小期间，这张卡的图表不要跟着每一帧重画 */
  freeze(id: string | null): void;
  /** 键盘操作的读屏播报 */
  announce(id: string, item: GridItem): void;
  /** 从“添加卡片”面板拖进来的新卡落下：items 是加入后的整套布局，id 是新卡 */
  add(items: GridItem[], id: string): void;
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

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const DRAG_THRESHOLD = 4;
const EDGE = 48;
const MAX_SCROLL = 18;
const SETTLE_MS = 160;
const SHIFT_MS = 200;
/** 占位框压住别的卡时，指针要停这么久，那些卡才让开 */
const DWELL_MS = 180;
/** 调大小时，内容（列表、图表）按这个间隔重画 */
const REDRAW_MS = 200;
/** 调大小时，指针停住这么久，别的卡才跟着让位（移动途中只有虚线框在变，别的卡一动不动） */
const REST_MS = 120;

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
    if (!card || !id || e.button !== 0 || this.active || target.closest(".vp-w-remove") || target.closest(".vp-ctl")) return;
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
    const lim = h.limitsOf(id);
    const gridRect = grid.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const unitX = (grid.clientWidth + GAP) / COLS;
    const unitY = ROW_H + GAP;
    const origin = { x: cardRect.left - gridRect.left, y: cardRect.top - gridRect.top };
    // 调大小：卡片自己的像素范围（最小、最大，右边不能超出栅格）
    const minW = lim.minW * unitX - GAP;
    const maxW = Math.min(lim.maxW, COLS - cur0.x) * unitX - GAP;
    const minH = lim.minH * unitY - GAP;
    const maxH = lim.maxH * unitY - GAP;
    const startScroll = scroller.scrollTop;
    const pointerId = down.pointerId;
    this.active = true;

    let last = { x: down.clientX, y: down.clientY };
    let dirty = false;
    let dragging = false;
    let shown = base; // 页面上现在画着的
    let want = base; // 指针此刻指的
    let placeholder: HTMLElement | null = null;
    let badge: HTMLElement | null = null;
    let raf = 0;
    let dwell = 0;
    let redraw = 0;
    let lastRedraw = 0;

    try {
      card.setPointerCapture(pointerId);
    } catch {
      /* 合成事件没有真正的指针，忽略 */
    }

    const showNow = (next: GridItem[]) => {
      shown = next;
      const before = h.motion() ? snapshotRects(grid) : null;
      h.show(next, resize ? undefined : id);
      const me = next.find((i) => i.id === id);
      if (placeholder && me) setPlace(placeholder, me);
      if (before) playLayout(grid, before, { ms: SHIFT_MS, skip: id });
    };

    const cancelDwell = () => {
      if (dwell) win.clearTimeout(dwell);
      dwell = 0;
    };

    /** 别的卡让位：干扰小的立刻让，会大面积推开别的卡的要等指针停一会儿；调大小则一律等指针停住 */
    const follow = (next: GridItem[]) => {
      want = next;
      if (same(next, shown)) {
        cancelDwell();
        return;
      }
      if (resize) {
        cancelDwell();
        dwell = win.setTimeout(() => {
          dwell = 0;
          if (dragging && !same(want, shown)) showNow(want);
        }, REST_MS);
        return;
      }
      // 没压住任何卡：别的卡不用动（或者要回到原位），立刻生效；压住了就等指针停一下
      if (displacedCount(base, next, id) === 0) {
        cancelDwell();
        showNow(next);
        return;
      }
      cancelDwell();
      dwell = win.setTimeout(() => {
        dwell = 0;
        if (dragging && !same(want, shown)) showNow(want);
      }, DWELL_MS);
    };

    const redrawContent = () => {
      redraw = 0;
      lastRedraw = win.performance.now();
      h.resized(id);
    };

    const update = () => {
      const dx = last.x - down.clientX;
      const dy = last.y - down.clientY + (scroller.scrollTop - startScroll);
      if (!dragging) {
        if (Math.hypot(dx, last.y - down.clientY) < DRAG_THRESHOLD) return;
        dragging = true;
        grid.addClass("is-gesture");
        card.addClass(resize ? "is-resizing-card" : "is-dragging");
        placeholder = grid.createDiv({ cls: "vp-ph", attr: { "data-widget": "__ph", "aria-hidden": "true" } });
        setPlace(placeholder, cur0);
        if (resize) {
          badge = card.createDiv({ cls: "vp-w-badge", attr: { "aria-hidden": "true" } });
          h.freeze(id);
        }
      }
      if (resize) {
        // 卡片自己按像素跟着指针长大变小；虚线框显示吸附后的大小
        const wpx = clamp(cardRect.width + dx, minW, maxW);
        const hpx = clamp(cardRect.height + dy, minH, maxH);
        card.setCssProps({ width: `${wpx}px`, height: `${hpx}px` });
        const w = Math.round((cardRect.width + dx + GAP) / unitX);
        const hh = Math.round((cardRect.height + dy + GAP) / unitY);
        const next = resizeItem(base, id, w, hh, h.limitsOf);
        const me = next.find((i) => i.id === id);
        if (badge && me) badge.setText(`${me.w} × ${me.h}`);
        if (placeholder && me) setPlace(placeholder, me);
        follow(next);
        // 内容按固定间隔重画，不是每一帧
        const now = win.performance.now();
        if (!redraw) redraw = win.setTimeout(redrawContent, Math.max(0, REDRAW_MS - (now - lastRedraw)));
      } else {
        card.setCssProps({ transform: `translate3d(${dx}px, ${dy}px, 0) scale(1.02)` });
        const next = moveItemSnap(base, id, Math.round((origin.x + dx) / unitX), Math.round((origin.y + dy) / unitY));
        const me = next.find((i) => i.id === id);
        // 虚线占位框立刻跟着指针走；被压住的卡什么时候让开由 follow 决定
        if (placeholder && me) setPlace(placeholder, me);
        follow(next);
      }
    };

    /** 每帧一次：指针靠近滚动区上下边缘 48px 时自动滚动，然后处理这一帧里攒下的指针移动 */
    const frame = () => {
      if (dragging) {
        // 文档本身在滚动时，可见范围是窗口而不是整个文档
        const r = scroller === doc.scrollingElement ? { top: 0, bottom: win.innerHeight } : scroller.getBoundingClientRect();
        let v = 0;
        if (last.y < r.top + EDGE) v = -((r.top + EDGE - last.y) / EDGE) * MAX_SCROLL;
        else if (last.y > r.bottom - EDGE) v = ((last.y - (r.bottom - EDGE)) / EDGE) * MAX_SCROLL;
        if (v) {
          scroller.scrollTop += v;
          dirty = true;
        }
      }
      if (dirty) {
        dirty = false;
        update();
      }
      raf = win.requestAnimationFrame(frame);
    };
    raf = win.requestAnimationFrame(frame);

    const finish = (commit: boolean) => {
      win.cancelAnimationFrame(raf);
      cancelDwell();
      if (redraw) win.clearTimeout(redraw);
      redraw = 0;
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
      // 松手时指针指在哪就落在哪（取消则回到原位）；被拖的卡从松手的地方滑进去
      const final = commit ? want : base;
      const from = card.getBoundingClientRect();
      card.removeClass("is-dragging");
      card.removeClass("is-resizing-card");
      card.setCssProps({ transform: "", width: "", height: "" });
      grid.removeClass("is-gesture");
      placeholder?.remove();
      badge?.remove();
      const before = h.motion() ? snapshotRects(grid) : null;
      if (before) before.set(id, from);
      h.show(final);
      if (before) playLayout(grid, before, { ms: commit ? SETTLE_MS : SHIFT_MS });
      this.active = false;
      if (resize) h.freeze(null);
      if (commit && !same(final, base)) h.commit(final);
      if (resize) h.resized(id);
      h.ended();
    };

    const onMove = (e: PointerEvent) => {
      last = { x: e.clientX, y: e.clientY };
      dirty = true;
    };
    const onUp = (e: PointerEvent) => {
      last = { x: e.clientX, y: e.clientY };
      if (dirty || !dragging) update();
      dirty = false;
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

  /* ---------- 从“添加卡片”面板把一张卡拖到看板上 ---------- */

  /**
   * 在 src（面板里的卡片项）上按下指针之后调用：移动不到几像素当作点击，什么也不做（点击由调用方处理）；
   * 拖动起来之后，一个缩略图跟着指针走，指针进了看板就出现虚线占位框，别的卡实时让位（规则和看板里拖动一样），
   * 松手在看板里就把这张卡放在虚线框的位置，松手在别处或按 Esc 就取消。
   * item 是这张卡添加时的默认大小（id、w、h）。
   */
  dragIn(src: HTMLElement, item: GridItem, down: PointerEvent, makeGhost: () => HTMLElement) {
    if (this.active || down.button !== 0) return;
    // 和看板里拖卡片一样：不让浏览器开始选中文字、拖图片
    down.preventDefault();
    const h = this.host;
    const grid = h.grid;
    const doc = grid.ownerDocument;
    const win = doc.defaultView as Window;
    const scroller = h.scroller();
    const base = h.items().map((i) => ({ ...i }));
    const unitX = () => (grid.clientWidth + GAP) / COLS;
    const unitY = ROW_H + GAP;
    this.active = true;

    let last = { x: down.clientX, y: down.clientY };
    let dirty = false;
    let dragging = false;
    let ghost: HTMLElement | null = null;
    let placeholder: HTMLElement | null = null;
    let shown = base;
    let want = base;
    let raf = 0;
    let dwell = 0;

    try {
      src.setPointerCapture(down.pointerId);
    } catch {
      /* 合成事件没有真正的指针，忽略 */
    }

    const cancelDwell = () => {
      if (dwell) win.clearTimeout(dwell);
      dwell = 0;
    };
    const showNow = (next: GridItem[]) => {
      shown = next;
      const before = h.motion() ? snapshotRects(grid) : null;
      h.show(next);
      const me = next.find((i) => i.id === item.id);
      if (me) {
        if (!placeholder) placeholder = grid.createDiv({ cls: "vp-ph", attr: { "data-widget": "__ph", "aria-hidden": "true" } });
        setPlace(placeholder, me);
      } else {
        placeholder?.remove();
        placeholder = null;
      }
      if (before) playLayout(grid, before, { ms: SHIFT_MS, skip: item.id });
    };
    const follow = (next: GridItem[]) => {
      want = next;
      if (same(next, shown)) {
        cancelDwell();
        return;
      }
      cancelDwell();
      if (displacedCount(base, next, item.id) === 0) {
        showNow(next);
        return;
      }
      dwell = win.setTimeout(() => {
        dwell = 0;
        if (dragging && !same(want, shown)) showNow(want);
      }, DWELL_MS);
    };

    const update = () => {
      if (!dragging) {
        if (Math.hypot(last.x - down.clientX, last.y - down.clientY) < DRAG_THRESHOLD) return;
        dragging = true;
        grid.addClass("is-gesture");
        ghost = makeGhost();
        doc.body.appendChild(ghost);
      }
      if (ghost) ghost.setCssProps({ "--vp-gx": `${last.x}px`, "--vp-gy": `${last.y}px` });
      const r = grid.getBoundingClientRect();
      // 指针在看板左右范围里、上下离看板不远：落在看板里；否则回到没有这张卡的样子
      const over = last.x >= r.left - 8 && last.x <= r.right + 8 && last.y >= r.top - 24 && last.y <= r.bottom + 120;
      if (!over) {
        placeholder?.remove();
        placeholder = null;
        follow(base);
        return;
      }
      const gx = Math.round((last.x - r.left) / unitX() - item.w / 2);
      const gy = Math.round((last.y - r.top) / unitY - item.h / 2);
      const next = placeItemSnap(base, item, gx, gy);
      const me = next.find((i) => i.id === item.id);
      if (me) {
        if (!placeholder) placeholder = grid.createDiv({ cls: "vp-ph", attr: { "data-widget": "__ph", "aria-hidden": "true" } });
        setPlace(placeholder, me);
      }
      follow(next);
    };

    const frame = () => {
      if (dragging) {
        const r = scroller === doc.scrollingElement ? { top: 0, bottom: win.innerHeight } : scroller.getBoundingClientRect();
        let v = 0;
        if (last.y < r.top + EDGE) v = -((r.top + EDGE - last.y) / EDGE) * MAX_SCROLL;
        else if (last.y > r.bottom - EDGE) v = ((last.y - (r.bottom - EDGE)) / EDGE) * MAX_SCROLL;
        if (v) {
          scroller.scrollTop += v;
          dirty = true;
        }
      }
      if (dirty) {
        dirty = false;
        update();
      }
      raf = win.requestAnimationFrame(frame);
    };
    raf = win.requestAnimationFrame(frame);

    const finish = (commit: boolean) => {
      win.cancelAnimationFrame(raf);
      cancelDwell();
      src.removeEventListener("pointermove", onMove);
      src.removeEventListener("pointerup", onUp);
      src.removeEventListener("pointercancel", onCancel);
      src.removeEventListener("lostpointercapture", onCancel);
      doc.removeEventListener("keydown", onEsc, true);
      doc.removeEventListener("selectstart", noSelect, true);
      try {
        src.releasePointerCapture(down.pointerId);
      } catch {
        /* 已经释放 */
      }
      if (!dragging) {
        this.active = false;
        h.ended();
        return;
      }
      // 拖过之后松手会再触发一次 click，不能让它把卡片又加一遍
      const swallow = (e: Event) => {
        e.stopImmediatePropagation();
        e.preventDefault();
      };
      src.addEventListener("click", swallow, { capture: true, once: true });
      win.setTimeout(() => src.removeEventListener("click", swallow, true), 0);
      ghost?.remove();
      placeholder?.remove();
      grid.removeClass("is-gesture");
      this.active = false;
      const landed = commit && want.some((i) => i.id === item.id);
      if (landed) h.add(want, item.id);
      else h.show(base);
      h.ended();
    };

    const onMove = (e: PointerEvent) => {
      last = { x: e.clientX, y: e.clientY };
      dirty = true;
    };
    const onUp = (e: PointerEvent) => {
      last = { x: e.clientX, y: e.clientY };
      if (dirty || !dragging) update();
      dirty = false;
      // 松手时指针不在看板上：取消
      finish(dragging);
    };
    const onCancel = () => finish(false);
    const noSelect = (e: Event) => e.preventDefault();
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    };
    src.addEventListener("pointermove", onMove);
    src.addEventListener("pointerup", onUp);
    src.addEventListener("pointercancel", onCancel);
    src.addEventListener("lostpointercapture", onCancel);
    doc.addEventListener("keydown", onEsc, true);
    doc.addEventListener("selectstart", noSelect, true);
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
