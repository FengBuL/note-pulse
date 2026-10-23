import { test } from "node:test";
import assert from "node:assert/strict";
import { App, TFile } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/settings";
import { ContentInfo, PersistentData, dayKey, mergedWordLog, syncContent } from "../src/stats";
import { isDeviceId, mergeDeviceLog, newDeviceId, normalizeDeviceLog, sumLogs } from "../src/devices";

(globalThis as unknown as { window: unknown }).window = { setTimeout };

/** 一个只有内存文件的库：texts 改了之后 mtime 跟着变 */
function vault(texts: Record<string, string>) {
  const files = new Map<string, TFile>();
  let clock = Date.now() - 1000;
  const file = (path: string) => {
    let f = files.get(path);
    if (!f) {
      f = new TFile();
      f.path = path;
      files.set(path, f);
    }
    f.stat = { mtime: ++clock, ctime: clock, size: texts[path].length };
    return f;
  };
  for (const p of Object.keys(texts)) file(p);
  const app = { vault: { cachedRead: async (f: TFile) => texts[f.path] } } as unknown as App;
  return {
    app,
    files: () => [...files.values()],
    write(path: string, text: string) {
      texts[path] = text;
      file(path);
    },
  };
}

function fresh(): PersistentData {
  return { wordLog: {}, wordLogBig: {}, logInitialized: false, logStartDay: "", localEdits: new Map() };
}

const settings = { ...DEFAULT_SETTINGS };
const today = dayKey(Date.now());

test("只有本机编辑器里改动的笔记才计入本机；同步进来的、外部写的只更新基线", async () => {
  const v = vault({ "a.md": "one two", "b.md": "one" });
  const cache = new Map<string, ContentInfo>();
  const pd = fresh();
  await syncContent(v.app, v.files(), settings, cache, pd); // 第一次：只建立基线
  assert.deepEqual(pd.wordLog, {});

  v.write("a.md", "one two three four"); // 本机键入 +2
  pd.localEdits?.set("a.md", Date.now() - 1);
  v.write("b.md", "one two three four five six"); // 另一台设备写的、同步过来 +5
  await syncContent(v.app, v.files(), settings, cache, pd);
  assert.equal(pd.wordLog[today], 2, "只记本机打的 2 个字");
  assert.equal(cache.get("b.md")?.logged, 6, "同步进来的变化只更新基线");
  assert.equal(pd.localEdits?.has("a.md"), false, "记过之后清掉标记");

  // 再次同步同一个文件（比如另一台设备的基线覆盖了缓存）：没有本机键入就不会再记
  cache.get("a.md")!.logged = 2;
  v.write("a.md", "one two three four");
  await syncContent(v.app, v.files(), settings, cache, pd);
  assert.equal(pd.wordLog[today], 2, "基线被别的设备覆盖也不会重复计数");
});

test("外部程序新建的笔记不计入；本机新建并输入的计入", async () => {
  const v = vault({ "a.md": "x" });
  const cache = new Map<string, ContentInfo>();
  const pd = fresh();
  await syncContent(v.app, v.files(), settings, cache, pd);
  v.write("agent.md", "AI 写的 对话 记录 很多 很多 字");
  v.write("mine.md", "my new note");
  pd.localEdits?.set("mine.md", Date.now() - 1);
  await syncContent(v.app, v.files(), settings, cache, pd);
  assert.equal(pd.wordLog[today], 3);
});

test("读取期间又打了字：标记保留到下一轮", async () => {
  const v = vault({ "a.md": "one" });
  const cache = new Map<string, ContentInfo>();
  const pd = fresh();
  await syncContent(v.app, v.files(), settings, cache, pd);
  v.write("a.md", "one two");
  pd.localEdits?.set("a.md", Date.now() + 60_000); // 读取开始之后的按键
  await syncContent(v.app, v.files(), settings, cache, pd);
  assert.equal(pd.wordLog[today], 1);
  assert.equal(pd.localEdits?.has("a.md"), true);
});

test("没开多设备记录（localEdits 为空）时沿用旧办法：所有变化都算", async () => {
  const v = vault({ "a.md": "one" });
  const cache = new Map<string, ContentInfo>();
  const pd: PersistentData = { wordLog: {}, wordLogBig: {}, logInitialized: false, logStartDay: "" };
  await syncContent(v.app, v.files(), settings, cache, pd);
  v.write("a.md", "one two three");
  await syncContent(v.app, v.files(), settings, cache, pd);
  assert.equal(pd.wordLog[today], 2);
});

test("看板把旧记录、本机、其它设备相加；超大笔记按设置", () => {
  const pd: PersistentData = {
    wordLog: { "2026-10-23": 100 },
    wordLogBig: { "2026-10-23": 5000 },
    legacyLog: { "2026-10-20": 300, "2026-10-23": 1 },
    legacyLogBig: {},
    otherLogs: [{ wordLog: { "2026-10-23": 50, "2026-10-24": 7 }, wordLogBig: { "2026-10-24": 9000 } }],
    logInitialized: true,
    logStartDay: "2026-10-10",
  };
  assert.deepEqual(mergedWordLog(pd, false), { "2026-10-20": 300, "2026-10-23": 151, "2026-10-24": 7 });
  assert.deepEqual(mergedWordLog(pd, true), { "2026-10-20": 300, "2026-10-23": 5151, "2026-10-24": 9007 });
  assert.deepEqual(sumLogs([{ a: 1 }, { a: 2, b: 3 }]), { a: 3, b: 3 });
});

test("设备记录文件：坏数据被过滤，名字缺省用 ID；设备 ID 只含字母数字", () => {
  assert.equal(normalizeDeviceLog(null, "x"), null);
  assert.equal(normalizeDeviceLog("oops", "x"), null);
  const log = normalizeDeviceLog({ wordLog: { "2026-10-23": 12, bad: 3, "2026-10-24": -1, "2026-10-25": "7" }, updated: 5 }, "abc123");
  assert.deepEqual(log, { name: "abc123", wordLog: { "2026-10-23": 12 }, wordLogBig: {}, updated: 5 });
  const id = newDeviceId();
  assert.ok(isDeviceId(id));
  assert.ok(!isDeviceId("../x"));
  assert.ok(!isDeviceId(""));
});

test("同一台设备的两份记录（设备文件 / data.json 副本）按天取较大值，名字取较新的；次序无关、重复合并不变", () => {
  const file = { name: "iPhone", wordLog: { "2026-10-23": 120, "2026-10-24": 30 }, wordLogBig: {}, updated: 200 };
  const copy = { name: "旧名字", wordLog: { "2026-10-22": 50, "2026-10-23": 80 }, wordLogBig: { "2026-10-22": 9000 }, updated: 100 };
  const m = mergeDeviceLog(file, copy);
  assert.deepEqual(m, { name: "iPhone", wordLog: { "2026-10-22": 50, "2026-10-23": 120, "2026-10-24": 30 }, wordLogBig: { "2026-10-22": 9000 }, updated: 200 });
  assert.deepEqual(mergeDeviceLog(copy, file), m, "次序无关");
  assert.deepEqual(mergeDeviceLog(m, m), m, "重复合并不变");
  assert.deepEqual(mergeDeviceLog(null, file), file);
  assert.equal(mergeDeviceLog(null, null), null);
});
