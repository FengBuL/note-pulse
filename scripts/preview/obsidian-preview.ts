/* 本地预览用的 obsidian 替身：只实现看板渲染用到的部分 */
import icons from "./icons.json";

export const Platform = { isMobile: false };
export class TFile {
  path = "";
  extension = "md";
  stat = { mtime: 0, ctime: 0, size: 0 };
  parent: { path: string } | null = null;
  get basename() {
    return this.path.split("/").pop()?.replace(/\.md$/, "") ?? "";
  }
}
export class TFolder {}
export class TAbstractFile {}
export class Component {}
export class Notice {
  constructor(msg: string) {
    console.log("[Notice]", msg);
  }
}
export class Modal {
  constructor(public app: unknown) {}
  open() {}
  close() {}
}
export class Setting {}
export class PluginSettingTab {}
export class ButtonComponent {}
export const MarkdownRenderer = {};
export function setIcon(el: HTMLElement, name: string) {
  el.innerHTML = (icons as Record<string, string>)[name] ?? "";
}
export function normalizePath(p: string) {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}
export function getFrontMatterInfo() {
  return { exists: false, frontmatter: "", contentStart: 0 };
}
export function debounce<T extends unknown[]>(fn: (...a: T) => void) {
  return (...a: T) => fn(...a);
}
export const moment = { locale: () => "zh-cn" };

export class ItemView {
  contentEl: HTMLElement;
  containerEl: HTMLElement;
  app: unknown;
  constructor(leaf: { app: unknown; host: HTMLElement }) {
    this.app = leaf.app;
    this.containerEl = leaf.host;
    this.contentEl = leaf.host.createDiv({ cls: "view-content" });
  }
  registerInterval() {}
  register() {}
  registerDomEvent(el: EventTarget, type: string, fn: EventListener, o?: AddEventListenerOptions) {
    el.addEventListener(type, fn, o);
  }
  registerEvent() {}
}
export function getAllTags() {
  return [];
}
export function parseYaml() {
  return {};
}
export function stringifyYaml() {
  return "";
}
export class WorkspaceLeaf {}
export class App {}
