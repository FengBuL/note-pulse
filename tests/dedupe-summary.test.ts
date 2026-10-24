import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, FileRecord } from "../src/dedupe/core/group";
import { groupKey, isNearCopy, noteDay, overview, pairReclaimChars, pairWording, readablePreview, significantPairs } from "../src/dedupe/core/summary";
import { pairsToItems } from "../src/dedupe/core/plan";
import { tokenize } from "../src/dedupe/core/tokenize";
import { OPTS } from "./dedupe/fixtures";

const para = (s: string) => `${s} ${"padding words to make the block long enough for the threshold. ".repeat(2)}`;
function rec(path: string, text: string, ctime = 0): FileRecord {
  const t = tokenize(text, OPTS);
  return { path, ctime, mtime: ctime, len: text.length, lines: t.lines, totalW: t.totalW, blocks: t.blocks };
}

const P1 = para("First shared paragraph.");
const P2 = para("Second shared paragraph.");
const files = [rec("a.md", `${P1}\n\n${P2}\n`), rec("b.md", `${P1}\n`), rec("c.md", `${P2}\n`), rec("d.md", "unrelated")];

test("overview counts shown items, the notes they touch and the words saved", () => {
  const a = analyze(files);
  const o = overview(a, new Set());
  assert.equal(o.groups.length, 2);
  assert.equal(o.notes, 3);
  assert.equal(o.ignored, 0);
  assert.equal(o.words, a.groups.reduce((s, g) => s + g.reclaimWords, 0));
});

test("ignored items are left out of the list and the totals, and the key survives a rescan", () => {
  const a = analyze(files);
  const key = groupKey(a.groups.find((g) => g.occs.some((o) => o.path === "b.md"))!);
  const o = overview(a, new Set([key]));
  assert.equal(o.groups.length, 1);
  assert.equal(o.ignored, 1);
  assert.equal(o.notes, 2);
  const again = analyze([...files].reverse());
  assert.ok(again.groups.some((g) => groupKey(g) === key));
});

test("noteDay prefers the date in the file name", () => {
  assert.equal(noteDay({ path: "x/2026-10-05-1423-清单.md", ctime: 0 }), "2026-10-05");
  assert.match(noteDay({ path: "notes/plain.md", ctime: Date.UTC(2026, 0, 2, 12) }), /^2026-01-0[12]$/);
});

test("readablePreview strips Markdown markers and table pipes", () => {
  assert.equal(readablePreview("> quoted line\n> https://x.com/a"), "quoted line\nhttps://x.com/a");
  assert.equal(readablePreview("| 1 | @me | hello |"), "1 · @me · hello");
  assert.equal(readablePreview("- [ ] **task** text ^cd-abc"), "task text");
  assert.equal(readablePreview("x".repeat(20), 10).length, 10);
});

test("看板上的重复内容：只有大面积重复的笔记才算，零散共用的段落不算", () => {
  const para3 = (s: string) => `${s} ${"padding words to make the block long enough for the threshold. ".repeat(4)}`;
  const A = para3("Alpha paragraph."), B = para3("Beta paragraph."), C = para3("Gamma paragraph."), X = para3("Shared once.");
  const own = (n: string) => para3(`Only in ${n}.`);
  const fs = [
    // a 和 b：三段里有三段一样，几乎是同一篇
    rec("a.md", `${A}\n\n${B}\n\n${C}\n`, 1),
    rec("b.md", `${A}\n\n${B}\n\n${C}\n`, 2),
    // c 和 d 只共用一段，各自还有一大堆别的内容
    rec("c.md", `${X}\n\n${own("c1")}\n\n${own("c2")}\n\n${own("c3")}\n\n${own("c4")}\n`, 3),
    rec("d.md", `${X}\n\n${own("d1")}\n\n${own("d2")}\n\n${own("d3")}\n\n${own("d4")}\n`, 4),
  ];
  const a = analyze(fs);
  assert.ok(a.groups.length >= 4, "分段层面一共有好几处重复");
  const pairs = significantPairs(a, new Set());
  assert.equal(pairs.length, 1);
  assert.deepEqual([pairs[0].older, pairs[0].newer], ["a.md", "b.md"]);
  // 这一对的段落全被忽略了，就不再显示
  const ignoredAll = new Set(a.groups.filter((g) => g.occs.some((o) => o.path === "a.md")).map((g) => groupKey(g)));
  assert.equal(significantPairs(a, ignoredAll).length, 0);
});

test("看板上的重复内容：共同部分太短的整篇相同也不算（比如两条一句话笔记）", () => {
  const short = "x".repeat(81);
  const a = analyze([rec("s1.md", `${short}\n`, 1), rec("s2.md", `${short}\n`, 2)]);
  assert.equal(significantPairs(a, new Set()).length, 0);
});

test("一键处理大面积重复：只清理这些笔记对里的笔记，同一段落出现在几对里也只清理一次", () => {
  const p3 = (s: string) => `${s} ${"padding words to make the block long enough for the threshold. ".repeat(4)}`;
  const A = p3("Alpha paragraph."), B = p3("Beta paragraph."), C = p3("Gamma paragraph."), Z = p3("Passage that also sits in an unrelated note.");
  const fs = [
    rec("a.md", `${A}\n\n${B}\n\n${C}\n`, 1),
    rec("b.md", `${A}\n\n${B}\n\n${C}\n`, 2),
    rec("c.md", `${A}\n\n${B}\n\n${C}\n`, 3),
    rec("x.md", `${A}\n\n${Z}\n\n${p3("Other one.")}\n\n${p3("Other two.")}\n\n${p3("Other three.")}\n`, 4),
  ];
  const a = analyze(fs);
  const pairs = significantPairs(a, new Set());
  assert.equal(pairs.length, 3, "a–b、a–c、b–c 三对");
  const items = pairsToItems(a, pairs);
  assert.equal(items.length, 3, "三个共同段落，各一项");
  for (const it of items) {
    assert.equal(it.keep.path, "a.md", "每段只保留最早的 a");
    assert.deepEqual(it.remove.map((o) => o.path).sort(), ["b.md", "c.md"], "x.md 虽然也有 Alpha 段，但不在任何一对里，不动");
  }
  assert.ok(pairReclaimChars(pairs) > 0);
  assert.equal(pairReclaimChars([]), 0);
});

test("看板上的重复内容：比例按整篇全文量，两个长段落一样、其余都不一样的笔记不算；长度几乎一样且参与比对的部分几乎全一样的复制品算", () => {
  const long = (s: string) => `${s} ${"padding words to make the block long enough for the threshold. ".repeat(4)}`;
  const A = long("Alpha."), B = long("Beta.");
  // 很多短句（不够长，不参与比对），两篇各写各的
  const shorts = (tag: string) => Array.from({ length: 80 }, (_, i) => `- ${tag} note line number ${i}`).join("\n");
  const x = rec("x.md", `${A}\n\n${B}\n\n${shorts("x")}\n`, 1);
  const y = rec("y.md", `${A}\n\n${B}\n\n${shorts("y").split("\n").slice(0, 60).join("\n")}\n`, 2);
  const ax = analyze([x, y]);
  assert.equal(ax.pairs.length, 1, "按参与比对的段落算，这一对是 100%");
  assert.equal(significantPairs(ax, new Set()).length, 0, "但共同部分只占全文一小部分，不算大面积重复");
  // 同样的短句，两篇都一样：整篇几乎一模一样（复制品）
  const same = shorts("same");
  const c = rec("c.md", `${A}\n\n${B}\n\n${same}\n`, 3);
  const d = rec("d.md", `${A}\n\n${B}\n\n${same}\n`, 4);
  const ad = analyze([c, d]);
  assert.equal(significantPairs(ad, new Set()).length, 1, "长度一样、比对部分全一样，是复制品");
  assert.ok(ad.pairs[0].olderChars > 0, "老的一边的共同字数也记下了");
  assert.ok(isNearCopy(ad, ad.pairs[0]), "复制品");
  assert.ok(!isNearCopy(ax, ax.pairs[0]), "长度差很多的不算复制品");
});

test("pairWording：哪一篇的重复比例更高就说哪一篇", () => {
  const p = { older: "a.md", newer: "b.md", olderRatio: 0.76, newerRatio: 0.45 } as never;
  assert.deepEqual(pairWording(p), { name: "a.md", other: "b.md", pct: 76 });
  const q = { older: "a.md", newer: "b.md", olderRatio: 0.5, newerRatio: 0.9 } as never;
  assert.deepEqual(pairWording(q), { name: "b.md", other: "a.md", pct: 90 });
});
