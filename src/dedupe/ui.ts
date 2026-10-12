import { setIcon } from "obsidian";
import { isChinese, t } from "./i18n";

let srSeq = 0;

/** Names an element through aria-labelledby (not aria-label, which Obsidian turns into a second tooltip). */
export function srLabel(el: Element, text: string): void {
  const id = `cd-sr-${++srSeq}`;
  el.appendChild(createSpan({ cls: "cd-sr-only", attr: { id }, text }));
  el.setAttribute("aria-labelledby", id);
}

/** Lets a non-button element be used with mouse, Enter and Space. */
export function makeClickable(el: HTMLElement, onActivate: (e: MouseEvent | KeyboardEvent) => void): void {
  el.setAttr("tabindex", "0");
  el.setAttr("role", "button");
  el.addEventListener("click", (e) => onActivate(e));
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onActivate(e);
    }
  });
}

export function fmtFull(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** Compact number: 12.3万 for Chinese, 12.3k for English. */
export function fmtNum(n: number): string {
  const a = Math.abs(n);
  const trim = (s: string) => (s.includes(".") ? s.replace(/\.?0+$/, "") : s);
  if (isChinese()) {
    if (a >= 1e8) return trim((n / 1e8).toFixed(2)) + "亿";
    if (a >= 1e4) return trim((n / 1e4).toFixed(a >= 1e6 ? 0 : 1)) + "万";
  } else {
    if (a >= 1e9) return trim((n / 1e9).toFixed(2)) + "B";
    if (a >= 1e6) return trim((n / 1e6).toFixed(a >= 1e7 ? 0 : 1)) + "M";
    if (a >= 1e4) return trim((n / 1e3).toFixed(a >= 1e5 ? 0 : 1)) + "k";
  }
  return fmtFull(n);
}

export function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return (i >= 0 ? path.slice(i + 1) : path).replace(/\.md$/i, "");
}

export function folderOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(0, i) : "";
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void, cls = ""): HTMLElement {
  const b = parent.createEl("button", { cls: `cd-icon-btn ${cls}`.trim(), attr: { type: "button" } });
  setIcon(b, icon);
  srLabel(b, label);
  b.addEventListener("click", onClick);
  return b;
}

/**
 * Small "?" buttons that explain something in a bubble on hover, focus or tap, so no footnote text takes up room.
 * One bubble is shared and positioned with fixed coordinates, so it is never clipped by a card and never shifts the layout.
 */
export class HelpManager {
  private pop: HTMLElement | null = null;
  private anchor: HTMLElement | null = null;
  private seq = 0;

  attach(parent: HTMLElement, text: string): HTMLElement {
    const b = parent.createEl("button", { cls: "cd-help", attr: { type: "button" } });
    // The accessible name lives in hidden text: an aria-label would make Obsidian pop up its own second tooltip
    srLabel(b, t("help"));
    setIcon(b, "circle-help");
    if (!b.querySelector("svg")) setIcon(b, "help-circle");
    if (!b.querySelector("svg")) b.createSpan({ text: "?", attr: { "aria-hidden": "true" } });
    const show = () => this.show(b, text);
    b.addEventListener("mouseenter", show);
    b.addEventListener("focus", show);
    b.addEventListener("mouseleave", () => this.hide(b));
    b.addEventListener("blur", () => this.hide(b));
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      show();
    });
    b.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.hide(b);
    });
    return b;
  }

  private show(anchor: HTMLElement, text: string) {
    const doc = anchor.ownerDocument;
    if (!this.pop || !this.pop.isConnected) {
      this.pop = doc.body.createDiv({ cls: "cd-help-pop", attr: { role: "tooltip", id: `cd-help-pop-${++this.seq}` } });
    }
    const pop = this.pop;
    pop.setText(text);
    pop.removeClass("is-visible");
    pop.setCssProps({ left: "0px", top: "0px" });
    this.anchor = anchor;
    anchor.setAttr("aria-describedby", pop.id);
    const a = anchor.getBoundingClientRect();
    const vw = doc.documentElement.clientWidth;
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    const left = Math.max(8, Math.min(vw - pw - 8, a.left + a.width / 2 - pw / 2));
    let top = a.top - ph - 8;
    if (top < 8) top = a.bottom + 8;
    pop.setCssProps({ left: `${Math.round(left)}px`, top: `${Math.round(top)}px` });
    pop.addClass("is-visible");
  }

  hide(anchor?: HTMLElement) {
    if (anchor && this.anchor !== anchor) return;
    this.pop?.removeClass("is-visible");
    this.anchor?.removeAttribute("aria-describedby");
    this.anchor = null;
  }

  destroy() {
    this.pop?.remove();
    this.pop = null;
    this.anchor = null;
  }
}
