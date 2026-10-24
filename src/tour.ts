/*
 * 新版本引导的界面：整屏半透明遮罩，挖一个洞高亮当前要讲的界面元素，旁边一张提示卡（第几步、标题、说明、上一步 / 下一步 / 跳过）。
 * 步骤内容和提示卡的定位在 tour-logic.ts。引导期间看板不响应点击（遮罩盖住了），由“下一步”带着走：
 * 需要编辑模式的步骤会自动进入编辑模式，需要“添加卡片”面板的步骤会自动展开面板。
 * 遮罩层放在 document.body 上而不是看板容器里：看板容器是 container-type 元素，里面的 fixed 定位会相对容器而不是窗口。
 */
import { setIcon } from "obsidian";
import { svgEl } from "./charts";
import { L } from "./i18n";
import { Rect, TourState, TourStep, TourTarget, placeCard, visibleRect } from "./tour-logic";

export interface TourHost {
  /** 引导层挂在这个文档的 body 上（弹出窗口里的看板用它自己的 document） */
  doc: Document;
  /** 把看板调到这一步要的状态 */
  apply(state: TourState): void;
  /** 找这一步要高亮的元素 */
  find(target: TourTarget): HTMLElement | null;
  /** 引导结束：completed 为 true 是看完了，false 是中途跳过；看板据此恢复进入引导前的状态、记下已看过 */
  end(completed: boolean): void;
}

const PAD = 6;

export class Tour {
  private layer: HTMLElement | null = null;
  private card: HTMLElement | null = null;
  private cursor: HTMLElement | null = null;
  private index = -1;
  private step: TourStep | null = null;
  private skipped = new Set<string>();
  private demoEl: HTMLElement | null = null;
  private placed = false;
  private timer = 0;
  private raf = 0;
  private dirs: { next: HTMLButtonElement; prev: HTMLButtonElement } | null = null;
  private counter!: HTMLElement;
  private title!: HTMLElement;
  private bodyEl!: HTMLElement;
  private dots!: HTMLElement;

  constructor(private host: TourHost, private steps: TourStep[]) {}

  get active(): boolean {
    return this.layer !== null;
  }

  start() {
    if (this.layer) return;
    const doc = this.host.doc;
    const win = doc.defaultView as Window;
    // 带上 vp-root 是为了拿到设计令牌（颜色、圆角、阴影）
    const layer = doc.body.createDiv({ cls: "vp-tour vp-root", attr: { role: "dialog", "aria-modal": "true", "aria-label": L("新版本引导", "What is new") } });
    this.layer = layer;
    for (const side of ["top", "bottom", "left", "right"]) layer.createDiv({ cls: `vp-tour-dim is-${side}`, attr: { "aria-hidden": "true" } });
    layer.createDiv({ cls: "vp-tour-spot", attr: { "aria-hidden": "true" } });
    this.cursor = layer.createDiv({ cls: "vp-tour-cursor", attr: { "aria-hidden": "true" } });
    const arrow = svgEl("svg", { viewBox: "0 0 24 24", width: 26, height: 26 }, this.cursor);
    svgEl("path", { d: "M5 3l14 8-6 2-3 6z", class: "vp-tour-cursor-shape" }, arrow);

    const card = layer.createDiv({ cls: "vp-tour-card" });
    this.card = card;
    const top = card.createDiv({ cls: "vp-tour-top" });
    this.counter = top.createSpan({ cls: "vp-tour-count" });
    const skip = top.createEl("button", { cls: "vp-tour-skip", attr: { type: "button", "aria-label": L("跳过引导", "Skip the guide") } });
    setIcon(skip.createSpan({ attr: { "aria-hidden": "true" } }), "x");
    skip.createSpan({ text: L("跳过", "Skip") });
    skip.addEventListener("click", () => this.finish(false));
    this.title = card.createDiv({ cls: "vp-tour-title" });
    this.bodyEl = card.createDiv({ cls: "vp-tour-body" });
    const foot = card.createDiv({ cls: "vp-tour-foot" });
    this.dots = foot.createDiv({ cls: "vp-tour-dots", attr: { "aria-hidden": "true" } });
    const btns = foot.createDiv({ cls: "vp-tour-btns" });
    const prev = btns.createEl("button", { cls: "vp-tour-btn", text: L("上一步", "Back"), attr: { type: "button" } });
    const next = btns.createEl("button", { cls: "vp-tour-btn is-primary", attr: { type: "button" } });
    prev.addEventListener("click", () => this.go(-1));
    next.addEventListener("click", () => this.go(1));
    this.dirs = { next, prev };

    doc.addEventListener("keydown", this.onKey, true);
    win.addEventListener("resize", this.schedulePlace);
    win.addEventListener("scroll", this.schedulePlace, true);
    this.timer = win.setInterval(this.place, 250);
    this.show(0, 1);
  }

  destroy() {
    const doc = this.host.doc;
    const win = doc.defaultView;
    doc.removeEventListener("keydown", this.onKey, true);
    win?.removeEventListener("resize", this.schedulePlace);
    win?.removeEventListener("scroll", this.schedulePlace, true);
    if (win) {
      win.clearInterval(this.timer);
      win.cancelAnimationFrame(this.raf);
    }
    this.clearDemo();
    this.layer?.remove();
    this.layer = this.card = this.cursor = null;
  }

  private finish(completed: boolean) {
    this.destroy();
    this.host.end(completed);
  }

  private go(dir: 1 | -1) {
    if (!this.layer) return;
    const to = this.index + dir;
    if (to >= this.steps.length) {
      this.finish(true);
      return;
    }
    if (to < 0) return;
    this.show(to, dir);
  }

  /** 显示第 i 步；目标找不到的可选步骤顺着方向跳过 */
  private show(i: number, dir: 1 | -1) {
    while (i >= 0 && i < this.steps.length) {
      const s = this.steps[i];
      this.host.apply(s.state);
      const el = s.target ? this.host.find(s.target) : null;
      if (s.target && !el && s.optional) {
        this.skipped.add(s.id);
        i += dir;
        continue;
      }
      this.index = i;
      this.setStep(s, el);
      return;
    }
    if (i >= this.steps.length) this.finish(true);
    else this.show(0, 1);
  }

  private visibleSteps(): TourStep[] {
    return this.steps.filter((s) => !this.skipped.has(s.id));
  }

  private setStep(s: TourStep, el: HTMLElement | null) {
    this.clearDemo();
    this.step = s;
    const vis = this.visibleSteps();
    const n = vis.indexOf(s) + 1;
    this.counter.setText(L(`第 ${n} 步，共 ${vis.length} 步`, `Step ${n} of ${vis.length}`));
    this.title.setText(s.title);
    this.bodyEl.setText(s.body);
    this.dots.empty();
    vis.forEach((v) => this.dots.createSpan({ cls: "vp-tour-dot" + (v === s ? " is-on" : "") }));
    const first = this.index === 0;
    const last = this.index === this.steps.length - 1;
    if (this.dirs) {
      this.dirs.prev.toggleClass("vp-hide", first);
      this.dirs.next.setText(first ? L("开始看看", "Show me") : last ? L("开始使用", "Get started") : L("下一步", "Next"));
    }
    this.card?.toggleClass("is-centered", !el);
    // 目标不在可见范围里：滚到中间
    if (el) {
      const r = el.getBoundingClientRect();
      const vh = this.host.doc.defaultView?.innerHeight ?? 800;
      if (r.top < 70 || r.bottom > vh - 70) el.scrollIntoView({ block: r.height > vh * 0.7 ? "start" : "center", inline: "nearest" });
    }
    this.startDemo(s, el);
    this.dirs?.next.focus({ preventScroll: true });
    // 状态切换后卡片重画了：等布局稳定再量
    this.schedulePlace();
    this.host.doc.defaultView?.setTimeout(this.place, 120);
  }

  /** 当前步骤的演示动画：光标在目标上做一遍操作，拖动卡片、拖角调大小的步骤里真实的卡片也跟着动 */
  private startDemo(s: TourStep, el: HTMLElement | null) {
    if (!s.demo || !el || !this.cursor) {
      this.cursor?.removeClass("is-on");
      return;
    }
    const r = el.getBoundingClientRect();
    let sx = r.left + r.width / 2;
    let sy = r.top + r.height / 2;
    let dx = 0;
    let dy = 0;
    if (s.demo === "drag") {
      sx = r.left + Math.min(60, r.width / 3);
      sy = r.top + 22;
      dx = Math.min(110, (this.host.doc.defaultView?.innerWidth ?? 1200) - sx - 40);
      dy = 18;
      el.setCssProps({ "--vp-tour-dx": `${dx}px`, "--vp-tour-dy": `${dy}px` });
      el.addClass("vp-tour-drag");
      this.demoEl = el;
    } else if (s.demo === "resize") {
      dx = 34;
      dy = 26;
      const card = el.closest<HTMLElement>(".vp-w");
      card?.addClass("vp-tour-grow");
      this.demoEl = card;
    } else {
      sx -= 46;
      sy += 30;
      dx = 46;
      dy = -30;
    }
    this.cursor.setCssProps({ "--vp-tour-x": `${sx}px`, "--vp-tour-y": `${sy}px`, "--vp-tour-dx": `${dx}px`, "--vp-tour-dy": `${dy}px` });
    this.cursor.addClass("is-on");
  }

  private clearDemo() {
    this.demoEl?.removeClass("vp-tour-drag");
    this.demoEl?.removeClass("vp-tour-grow");
    this.demoEl = null;
    this.cursor?.removeClass("is-on");
  }

  private schedulePlace = () => {
    const win = this.host.doc.defaultView;
    if (!win || this.raf) return;
    this.raf = win.requestAnimationFrame(() => {
      this.raf = 0;
      this.place();
    });
  };

  /** 高亮框和提示卡跟着目标走（页面滚动、窗口缩放、卡片重画之后目标的位置都会变） */
  private place = () => {
    const layer = this.layer;
    const card = this.card;
    const s = this.step;
    const win = this.host.doc.defaultView;
    if (!layer || !card || !s || !win) return;
    const vp = { w: win.innerWidth, h: win.innerHeight };
    const el = s.target ? this.host.find(s.target) : null;
    const b = el?.getBoundingClientRect();
    let spot: Rect | null = null;
    if (b && b.width > 0 && b.height > 0) {
      const v = visibleRect({ x: b.left - PAD, y: b.top - PAD, w: b.width + PAD * 2, h: b.height + PAD * 2 }, vp);
      if (v.w > 0 && v.h > 0) spot = v;
    }
    const hole = spot ?? { x: vp.w / 2, y: vp.h / 2, w: 0, h: 0 };
    layer.setCssProps({ "--vp-sx": `${hole.x}px`, "--vp-sy": `${hole.y}px`, "--vp-sw": `${hole.w}px`, "--vp-sh": `${hole.h}px` });
    layer.toggleClass("has-spot", !!spot);
    const pos = placeCard(spot, { w: card.offsetWidth || 340, h: card.offsetHeight || 200 }, vp);
    card.setCssProps({ "--vp-cx": `${pos.x}px`, "--vp-cy": `${pos.y}px` });
    // 第一次摆好之前不要过渡动画，不然提示卡会从角落飞进来
    if (!this.placed) {
      this.placed = true;
      win.requestAnimationFrame(() => layer.addClass("is-ready"));
    }
  };

  private onKey = (e: KeyboardEvent) => {
    if (!this.layer) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.finish(false);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      this.go(1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      e.stopPropagation();
      this.go(-1);
    }
  };
}
