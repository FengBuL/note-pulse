/* 浏览器里补上 Obsidian 给 DOM 加的那几个方法（createDiv / setText / setCssProps …），只用于本地预览 */
type Opts = { cls?: string | string[]; text?: string; attr?: Record<string, string | number | boolean | null>; title?: string; type?: string; href?: string; value?: string };

function apply(el: HTMLElement, o?: Opts | string) {
  if (!o) return;
  if (typeof o === "string") {
    el.className = o;
    return;
  }
  if (o.cls) el.className = Array.isArray(o.cls) ? o.cls.join(" ") : o.cls;
  if (o.text !== undefined) el.textContent = o.text;
  if (o.title) el.title = o.title;
  if (o.type) el.setAttribute("type", o.type);
  if (o.href) el.setAttribute("href", o.href);
  if (o.value !== undefined) el.setAttribute("value", o.value);
  if (o.attr) for (const [k, v] of Object.entries(o.attr)) if (v !== null && v !== undefined) el.setAttribute(k, String(v));
}

const P = Node.prototype as unknown as Record<string, unknown>;
P.createEl = function (this: HTMLElement, tag: string, o?: Opts, cb?: (el: HTMLElement) => void) {
  const el = document.createElement(tag);
  apply(el, o);
  this.appendChild(el);
  cb?.(el);
  return el;
};
P.createDiv = function (this: HTMLElement, o?: Opts) {
  return (this as unknown as { createEl: (t: string, o?: Opts) => HTMLElement }).createEl("div", o);
};
P.createSpan = function (this: HTMLElement, o?: Opts) {
  return (this as unknown as { createEl: (t: string, o?: Opts) => HTMLElement }).createEl("span", o);
};
P.empty = function (this: HTMLElement) {
  while (this.firstChild) this.removeChild(this.firstChild);
};
P.setText = function (this: HTMLElement, t: string) {
  this.textContent = t;
};
const E = Element.prototype as unknown as Record<string, unknown>;
E.addClass = function (this: Element, ...c: string[]) {
  this.classList.add(...c.flatMap((x) => x.split(" ").filter(Boolean)));
};
E.addClasses = E.addClass;
E.removeClass = function (this: Element, ...c: string[]) {
  this.classList.remove(...c);
};
E.toggleClass = function (this: Element, c: string, on: boolean) {
  this.classList.toggle(c, on);
};
E.hasClass = function (this: Element, c: string) {
  return this.classList.contains(c);
};
E.setAttr = function (this: Element, k: string, v: string) {
  this.setAttribute(k, v);
};
E.isShown = function (this: HTMLElement) {
  return true;
};
const H = HTMLElement.prototype as unknown as Record<string, unknown>;
H.setCssProps = function (this: HTMLElement, props: Record<string, string>) {
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith("--")) this.style.setProperty(k, v);
    else (this.style as unknown as Record<string, string>)[k] = v;
  }
};
H.show = function (this: HTMLElement) {
  this.style.display = "";
};
H.hide = function (this: HTMLElement) {
  this.style.display = "none";
};
const W = window as unknown as Record<string, unknown>;
W.createDiv = (o?: Opts) => {
  const el = document.createElement("div");
  apply(el, o);
  return el;
};
W.createSpan = (o?: Opts) => {
  const el = document.createElement("span");
  apply(el, o);
  return el;
};
