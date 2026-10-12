/* 测试用的极简 obsidian 替身：只实现“字数属性”服务用到的部分 */
export class TFile {
  path = "";
  extension = "md";
  stat = { mtime: 0, ctime: 0, size: 0 };
}
export class TAbstractFile {}
export class Notice {
  static log: string[] = [];
  constructor(public msg: string) {
    Notice.log.push(msg);
  }
  setMessage(m: string) {
    this.msg = m;
  }
  hide() {}
}
export class FakeEl {
  children: FakeEl[] = [];
  text = "";
  classes = new Set<string>();
  createDiv() {
    const c = new FakeEl();
    this.children.push(c);
    return c;
  }
  createEl(_tag: string, o?: { text?: string }) {
    const c = this.createDiv();
    c.text = o?.text ?? "";
    return c;
  }
  empty() {
    this.children = [];
  }
  addClass(c: string) {
    this.classes.add(c);
  }
  allText(): string[] {
    return this.children.map((c) => c.text).filter(Boolean);
  }
}
export class ButtonComponent {
  buttonEl = new FakeEl();
  label = "";
  disabled = false;
  handler: () => void = () => {};
  setCta() {
    return this;
  }
  setButtonText(t: string) {
    this.label = t;
    return this;
  }
  setDisabled(d: boolean) {
    this.disabled = d;
    return this;
  }
  onClick(h: () => void) {
    this.handler = h;
    return this;
  }
}
export class Setting {
  static buttons: ButtonComponent[] = [];
  constructor(_el: unknown) {}
  addButton(cb: (b: ButtonComponent) => void) {
    const b = new ButtonComponent();
    Setting.buttons.push(b);
    cb(b);
    return this;
  }
}
export class Modal {
  static opened: Modal[] = [];
  contentEl = new FakeEl();
  constructor(public app: unknown) {}
  open() {
    Modal.opened.push(this);
    (this as unknown as { onOpen(): void }).onOpen();
  }
  close() {
    (this as unknown as { onClose(): void }).onClose();
  }
  setTitle() {}
}
export class PluginSettingTab {}
export function getFrontMatterInfo(text: string) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  return m ? { exists: true, frontmatter: m[1], contentStart: m[0].length } : { exists: false, frontmatter: "", contentStart: 0 };
}
/** 只支持 `key: value` 的单行 YAML，足够测试用 */
export function parseYaml(s: string): unknown {
  const out: Record<string, unknown> = {};
  for (const line of s.split("\n")) {
    if (!line.trim()) continue;
    const m = /^([^:]+):\s*(.*)$/.exec(line);
    if (!m) throw new Error("bad yaml");
    out[m[1]] = /^-?\d+(\.\d+)?$/.test(m[2]) ? Number(m[2]) : m[2];
  }
  return out;
}
export function stringifyYaml(o: Record<string, unknown>): string {
  return Object.entries(o).map(([k, v]) => `${k}: ${v}`).join("\n");
}
export const moment = { locale: () => "zh-cn" };
