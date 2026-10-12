/* 用内存里的假仓库跑一遍 WordPropsService：触发、防抖、不循环、不重复写、批量、移除 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { FakeEl, Modal, Notice, Setting, TFile, getFrontMatterInfo, parseYaml, stringifyYaml } from "obsidian";
import { WordPropsService } from "../src/wordprops";
import { DEFAULT_SETTINGS } from "../src/settings";

/* ---- 假时钟：window.setTimeout 和 Date.now 都由测试控制 ---- */
let clock = 1_000_000;
const timers = new Map<number, { at: number; fn: () => void }>();
let tid = 0;
Date.now = () => clock;
const win = {
  setTimeout: (fn: () => void, ms: number) => {
    timers.set(++tid, { at: clock + ms, fn });
    return tid;
  },
  clearTimeout: (id: number) => void timers.delete(id),
};
(globalThis as unknown as { window: unknown }).window = win;
async function advance(ms: number) {
  const end = clock + ms;
  for (let i = 0; i < 50; i++) await Promise.resolve();
  for (;;) {
    const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) break;
    timers.delete(next[0]);
    clock = Math.max(clock, next[1].at);
    next[1].fn();
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }
  clock = end;
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/* ---- 假仓库 ---- */
const files = new Map<string, { f: TFile; text: string }>();
let writes: string[] = [];
let handlers: { modify: ((f: TFile) => void)[]; edit: ((e: unknown, i: { file: TFile }) => void)[] } = { modify: [], edit: [] };
let active: TFile | null = null;

function addFile(path: string, text: string, mtime = clock - 60_000): TFile {
  const f = new TFile();
  f.path = path;
  f.stat.mtime = mtime;
  files.set(path, { f, text });
  return f;
}
function fmOf(path: string): Record<string, unknown> | null {
  const info = getFrontMatterInfo(files.get(path)!.text);
  return info.exists ? (parseYaml(info.frontmatter) as Record<string, unknown>) : null;
}

const app = {
  vault: {
    getMarkdownFiles: () => [...files.values()].map((x) => x.f),
    getAbstractFileByPath: (p: string) => files.get(p)?.f ?? null,
    read: async (f: TFile) => files.get(f.path)!.text,
    cachedRead: async (f: TFile) => files.get(f.path)!.text,
    on: (_n: string, cb: (f: TFile) => void) => handlers.modify.push(cb),
  },
  workspace: {
    getActiveFile: () => active,
    on: (_n: string, cb: (e: unknown, i: { file: TFile }) => void) => handlers.edit.push(cb),
  },
  metadataCache: { getFileCache: (f: TFile) => ({ frontmatter: fmOf(f.path) ?? undefined }) },
  fileManager: {
    processFrontMatter: async (f: TFile, fn: (fm: Record<string, unknown>) => void) => {
      const rec = files.get(f.path)!;
      const info = getFrontMatterInfo(rec.text);
      const fm = info.exists ? (parseYaml(info.frontmatter) as Record<string, unknown>) : {};
      const body = info.exists ? rec.text.slice(info.contentStart) : rec.text;
      fn(fm);
      rec.text = `---\n${stringifyYaml(fm)}\n---\n${body}`;
      clock += 5; // 写入本身会推进 mtime
      f.stat.mtime = clock;
      writes.push(f.path);
      for (const h of handlers.modify) h(f); // 真实 Obsidian 也会触发 modify
      for (const h of handlers.edit) h(null, { file: f });
    },
  },
};

function makeService(over: Partial<typeof DEFAULT_SETTINGS> = {}) {
  const plugin = {
    app,
    settings: { ...DEFAULT_SETTINGS, wordPropEnabled: true, ...over },
    registerEvent: () => {},
    requestRefresh: async () => {},
  };
  const svc = new WordPropsService(plugin as never);
  svc.register();
  return { svc, plugin };
}
/** 模拟用户在当前笔记里打字：改正文、更新 mtime、触发 editor-change（autosave 之后再触发 modify） */
function type(f: TFile, body: string) {
  const rec = files.get(f.path)!;
  const info = getFrontMatterInfo(rec.text);
  rec.text = (info.exists ? rec.text.slice(0, info.contentStart) : "") + body;
  f.stat.mtime = clock;
  for (const h of handlers.edit) h(null, { file: f });
}
function autosave(f: TFile) {
  f.stat.mtime = clock;
  for (const h of handlers.modify) h(f);
}

beforeEach(() => {
  files.clear();
  writes = [];
  handlers = { modify: [], edit: [] };
  timers.clear();
  active = null;
  Notice.log = [];
});

test("auto: writes once after idle, only for the active file, and does not loop", async () => {
  const { svc } = makeService();
  const a = addFile("a.md", "");
  const other = addFile("other.md", "旧内容");
  active = a;
  type(a, "一二三四五六七八九十");
  autosave(a);
  await advance(4_000);
  assert.equal(writes.length, 0, "还没停手够久，不能写");
  type(a, "一二三四五六七八九十甲乙"); // 继续打字，重新计时
  await advance(4_000);
  assert.equal(writes.length, 0, "打字会重置空闲计时");
  await advance(2_000);
  assert.deepEqual(writes, ["a.md"]);
  assert.equal(fmOf("a.md")?.words, 12);
  assert.equal(typeof fmOf("a.md")?.words, "number");
  await advance(60_000);
  assert.equal(writes.length, 1, "自己的写入触发的事件不会引起再次写入");
  assert.equal(fmOf("other.md"), null, "其他笔记不会被碰");
  svc.dispose();
});

test("auto: unchanged value is never rewritten; equal count after edit stays untouched", async () => {
  makeService();
  const a = addFile("a.md", "---\nwords: 3\n---\n一二三");
  active = a;
  type(a, "三二一"); // 字数没变
  autosave(a);
  await advance(10_000);
  assert.equal(writes.length, 0);
});

test("auto: disabled means nothing is written", async () => {
  makeService({ wordPropEnabled: false });
  const a = addFile("a.md", "");
  active = a;
  type(a, "一二三");
  await advance(30_000);
  assert.equal(writes.length, 0);
});

test("auto: modify of a non-active file (e.g. sync) is ignored", async () => {
  makeService();
  const a = addFile("a.md", "一二三");
  const b = addFile("b.md", "四五六");
  active = a;
  b.stat.mtime = clock;
  for (const h of handlers.modify) h(b);
  await advance(30_000);
  assert.equal(writes.length, 0);
});

test("auto: a file modified within 2s is retried later instead of written", async () => {
  makeService();
  const a = addFile("a.md", "");
  active = a;
  type(a, "一二三");
  await advance(5_000);
  // 在写入前一瞬间，别处（如 iCloud）又改了这个文件：mtime 很新
  assert.equal(writes.length, 1);
  const b = addFile("b.md", "");
  active = b;
  type(b, "四五六");
  clock += 4_900;
  b.stat.mtime = clock - 500; // 0.5 秒前刚被改过
  await advance(100); // 触发写入（5 秒到点）
  assert.equal(writes.length, 1, "刚被修改，这一轮不写");
  await advance(10_000);
  assert.equal(writes.length, 2, "稳定之后补写");
});

test("excluded and outlier files are skipped; folders respected", async () => {
  makeService({ wordPropExcludeFolders: "x", excludedFolders: "Templates", outlierWords: 1000 });
  const ex = addFile("x/a.md", "");
  active = ex;
  type(ex, "一二三");
  await advance(10_000);
  const t = addFile("Templates/t.md", "");
  active = t;
  type(t, "一二三");
  await advance(10_000);
  const big = addFile("big.md", "");
  active = big;
  type(big, "字".repeat(1001));
  await advance(10_000);
  assert.equal(writes.length, 0);
});

test("manual update command writes numeric words and reading time", async () => {
  const { svc } = makeService({ wordPropReading: true });
  const a = addFile("a.md", "字".repeat(401));
  active = a;
  await svc.updateCurrent();
  assert.deepEqual(fmOf("a.md"), { words: 401, reading_time: 2 });
  await advance(10_000);
  await svc.updateCurrent();
  assert.equal(writes.length, 1, "第二次值没变，不写");
  assert.ok(Notice.log.some((m) => m.includes("没有改动文件")));
});

/** 取最近打开的对话框：它的文字、确认按钮 */
function lastModal() {
  const m = Modal.opened[Modal.opened.length - 1] as unknown as { contentEl: FakeEl };
  const btns = Setting.buttons.slice(-2);
  return { text: m.contentEl.children[0].allText().join("\n"), ok: btns[0] };
}

test("batch: dry-run counts first, then writes only files that change", async () => {
  const { svc } = makeService({ wordPropExcludeFolders: "x" });
  addFile("n1.md", "一二三");
  addFile("n2.md", "---\nwords: 3\n---\n一二三"); // 已是最新
  addFile("n3.md", "---\nwords: 1\n---\n一二三四五"); // 要改
  addFile("n4.md", ""); // 空笔记，不加属性
  addFile("x/c.md", "一二三"); // 不在范围
  addFile("fresh.md", "一二三", clock - 500); // 刚被改过
  await svc.batchUpdate();
  assert.equal(writes.length, 0, "统计阶段不写任何文件");
  const { text, ok } = lastModal();
  assert.match(text, /共检查 6 篇笔记，将更新 2 篇/);
  assert.match(text, /已经是最新、不会被改动：1 篇/);
  assert.match(text, /不在写入范围内 1 篇/);
  assert.match(text, /刚被修改过 1 篇/);
  assert.match(text, /空笔记 1 篇/);
  assert.equal(ok.disabled, false);
  ok.handler();
  await advance(5_000);
  assert.deepEqual(writes.sort(), ["n1.md", "n3.md"]);
  assert.equal(fmOf("n1.md")?.words, 3);
  assert.equal(fmOf("n3.md")?.words, 5);
  assert.equal(fmOf("n4.md"), null);
  assert.equal(fmOf("x/c.md"), null);
  assert.equal(fmOf("fresh.md"), null);
  // 再跑一遍：刚才“刚被改过”的 fresh.md 现在可以更新了，其余已是最新
  writes = [];
  clock += 10_000;
  await svc.batchUpdate();
  const again = lastModal();
  assert.match(again.text, /将更新 1 篇/);
  assert.match(again.text, /已经是最新、不会被改动：3 篇/);
  assert.equal(writes.length, 0);
  again.ok.handler();
  await advance(5_000);
  assert.deepEqual(writes, ["fresh.md"]);
  // 第三遍：什么都不用做，按钮不可点
  writes = [];
  clock += 10_000;
  await svc.batchUpdate();
  const third = lastModal();
  assert.match(third.text, /没有需要更新的/);
  assert.equal(third.ok.disabled, true);
  assert.equal(writes.length, 0);
});

test("batch: a file edited between the dry-run and the confirm is re-checked, not overwritten with a stale value", async () => {
  const { svc } = makeService();
  const f = addFile("n1.md", "一二三");
  await svc.batchUpdate();
  const { ok } = lastModal();
  // 确认前文件又被改了
  files.get("n1.md")!.text = "一二三四五六";
  f.stat.mtime = clock - 30_000 + 1;
  ok.handler();
  await advance(5_000);
  assert.equal(fmOf("n1.md")?.words, 6);
});

test("batch: broken YAML is skipped and reported", async () => {
  const { svc } = makeService();
  addFile("bad.md", "---\nnot yaml line\n---\n一二三");
  await svc.batchUpdate();
  assert.match(lastModal().text, /属性区无法解析 1 篇/);
});

test("remove: asks first, deletes only the configured properties", async () => {
  const { svc } = makeService({ wordPropReading: true });
  addFile("a.md", "---\nwords: 3\nreading_time: 1\ntitle: A\n---\n一二三");
  addFile("b.md", "---\ntitle: B\n---\n一二三");
  addFile("c.md", "---\nwords: 9\n---\n一二三");
  await svc.removeAll();
  assert.equal(writes.length, 0);
  const { text, ok } = lastModal();
  assert.match(text, /将从 2 篇笔记中删除属性 「words」和「reading_time」/);
  ok.handler();
  await advance(5_000);
  assert.deepEqual(fmOf("a.md"), { title: "A" });
  assert.deepEqual(fmOf("c.md"), {});
  assert.deepEqual(fmOf("b.md"), { title: "B" });
});
