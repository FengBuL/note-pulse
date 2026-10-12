import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, compareFiles, FileRecord, nameDate } from "../src/dedupe/core/group";
import { tokenize } from "../src/dedupe/core/tokenize";
import { OPTS, POSTS, buildVault, postQuote, table, frontmatter } from "./dedupe/fixtures";
import { MemVault, scanVault } from "./dedupe/helpers";

const para = (s: string) => `${s} ${"padding words to make the block long enough for the threshold. ".repeat(2)}`;

function rec(path: string, text: string, ctime = 0, mtime = 0): FileRecord {
  const t = tokenize(text, OPTS);
  return { path, ctime, mtime, len: text.length, lines: t.lines, totalW: t.totalW, blocks: t.blocks };
}

test("same paragraph in three notes forms one group; the oldest by file-name date is kept", () => {
  const p = para("Shared paragraph about dedupe.");
  const a = analyze([
    rec("x/2026-10-06-0912-b.md", `${p}\n`, 5, 5),
    rec("x/2026-10-05-1423-a.md", `intro\n\n${p}\n`, 9, 9),
    rec("x/2026-10-07-0001-c.md", `${p}\n\nmore text here`, 1, 1),
  ]);
  assert.equal(a.groups.length, 1);
  assert.deepEqual(a.groups[0].occs.map((o) => o.path), ["x/2026-10-05-1423-a.md", "x/2026-10-06-0912-b.md", "x/2026-10-07-0001-c.md"]);
  assert.equal(a.groups[0].kind, "text");
});

test("repeats inside a single note are not a cross-note duplicate", () => {
  const p = para("Only repeated inside one note.");
  const a = analyze([rec("a.md", `${p}\n\n${p}\n`), rec("b.md", "unrelated short")]);
  assert.equal(a.groups.length, 0);
});

test("same status id with different text forms a 'post' group that is not exact", () => {
  const p = POSTS[0];
  const a = analyze([
    rec("a.md", `- @${p.user}: first take on it. https://x.com/${p.user}/status/${p.id}?s=20\n`),
    rec("b.md", `- @${p.user} said something a bit different https://twitter.com/${p.user}/status/${p.id}\n`),
  ]);
  assert.equal(a.groups.length, 1);
  assert.equal(a.groups[0].kind, "post");
  assert.equal(a.groups[0].exact, false);
});

test("identical text with the same status id is an exact post group", () => {
  const p = POSTS[1];
  const text = `${postQuote(p)}\n`;
  const a = analyze([rec("a.md", text), rec("b.md", text)]);
  assert.equal(a.groups[0].kind, "post");
  assert.equal(a.groups[0].exact, true);
});

test("different status ids with the same text are not merged into one 'post'", () => {
  const t = (id: string) => `- Same words everywhere in this very long tweet text that repeats ${"again ".repeat(15)} https://x.com/u/status/${id}\n`;
  const a = analyze([rec("a.md", t("1842110000000000001")), rec("b.md", t("1842110000000000002"))]);
  assert.equal(a.groups.length, 0);
});

test("a duplicated parent list item wins over the duplicated children inside it", () => {
  const body = `- ${para("parent")}\n  - ${para("child one")}\n  - ${para("child two")}\n`;
  const a = analyze([rec("a.md", body), rec("b.md", `${body}- ${para("only in b")}\n`)]);
  assert.equal(a.groups.length, 1);
  assert.equal(a.groups[0].blockKind, "li");
  assert.equal(a.groups[0].occs[0].block.e - a.groups[0].occs[0].block.s, 2);
});

test("when only a child is shared, the child forms its own group", () => {
  const child = `  - ${para("shared child")}\n`;
  const a = analyze([rec("a.md", `- ${para("parent A")}\n${child}`), rec("b.md", `- ${para("parent B is different")}\n${child}`)]);
  assert.equal(a.groups.length, 1);
  assert.equal(a.groups[0].occs[0].block.nested, true);
});

test("table rows shared between notes group per row", () => {
  const a = analyze([
    rec("a.md", frontmatter("2026-10-05") + `\n${table(POSTS.slice(0, 4))}\n`),
    rec("b.md", frontmatter("2026-10-06") + `\n${table(POSTS.slice(2, 6), "?s=46&t=zzz")}\n`),
  ]);
  // rows for posts 2 and 3 are shared, URL tracking params differ but must not matter
  assert.equal(a.groups.length, 2);
  assert.ok(a.groups.every((g) => g.kind === "post"));
  // the rank column differs between runs but is ignored, so these are exact repeats of the same post
  assert.ok(a.groups.every((g) => g.exact));
});

test("realistic vault: follow-up note overlaps its source almost completely", () => {
  const v = new MemVault(buildVault());
  const a = scanVault(v);
  assert.ok(a.groups.length >= 10, `groups: ${a.groups.length}`);
  const pair = a.pairs.find((p) => p.older.includes("2025") && p.newer.includes("续查"));
  assert.ok(pair, "pair found");
  assert.ok(pair.olderRatio > 0.85, `older ratio ${pair.olderRatio}`);
  assert.ok(pair.newerRatio > 0.7, `newer ratio ${pair.newerRatio}`);
  assert.ok(a.totals.reclaimChars > 0 && a.totals.ratio > 0 && a.totals.ratio < 1);
  // weekly reports share exactly one paragraph, listed as a group but not as an overlapping pair
  const weekly = a.groups.find((g) => g.occs.every((o) => o.path.startsWith("notes/")));
  assert.ok(weekly);
  assert.ok(!a.pairs.some((p) => p.older.startsWith("notes/")));
});

test("groups never overlap each other inside a note", () => {
  const v = new MemVault(buildVault());
  const a = scanVault(v);
  const seen = new Map<string, [number, number][]>();
  for (const g of a.groups) {
    for (const o of g.occs) {
      const list = seen.get(o.path) ?? [];
      for (const [s, e] of list) assert.ok(o.block.e < s || o.block.s > e, `overlap in ${o.path}`);
      list.push([o.block.s, o.block.e]);
      seen.set(o.path, list);
    }
  }
});

test("keep rules: auto prefers file-name dates, created/modified/name behave as named", () => {
  const f = (path: string, c: number, m: number) => rec(path, "x", c, m);
  const a = f("x/2026-10-05-1423-a.md", 100, 100);
  const b = f("x/2026-10-05-2025-b.md", 50, 200);
  assert.ok(compareFiles(a, b, "auto") < 0);
  assert.ok(compareFiles(a, b, "created") > 0);
  assert.ok(compareFiles(a, b, "modified") < 0);
  assert.ok(compareFiles(a, b, "name") < 0);
  const c = f("plain-note.md", 10, 10);
  assert.ok(compareFiles(c, a, "auto") < 0, "falls back to ctime when a name has no date");
  assert.equal(nameDate("x/2026-10-05-1423-ForYou采样清单.md"), "202610051423");
  assert.equal(nameDate("note 2026-13-45.md"), null);
  assert.equal(nameDate("hello.md"), null);
});

test("overlap threshold and CJK paragraphs reflowed differently still match", () => {
  const cjk = "做知识库最容易犯的错误是只收集不整理，收藏夹里躺着上千条链接，真正需要的时候一条也找不到，所以每周固定留半小时做清理。";
  const wrapped = cjk.replace("，收藏夹", "，\n收藏夹");
  const a = analyze([rec("a.md", `${cjk}\n`), rec("b.md", `${wrapped}\n`)]);
  assert.equal(a.groups.length, 1);
  const none = analyze([rec("a.md", `${cjk}\n\n${para("unique a content")}\n\n${para("another unique a block")}\n\n${para("more of a")}\n`), rec("b.md", `${cjk}\n\n${para("b unique things")}\n`)], { overlapThreshold: 0.7 });
  assert.equal(none.pairs.length, 0);
});

test("broad groups (boilerplate in many notes) are skipped for pair analysis", () => {
  const files: FileRecord[] = [];
  for (let i = 0; i < 50; i++) files.push(rec(`n${i}.md`, `${para("boilerplate footer")}\n\n${para("unique " + i)}\n`));
  const a = analyze(files, { pairFileCap: 40 });
  assert.equal(a.groups.length, 1);
  assert.equal(a.groups[0].occs.length, 50);
  assert.equal(a.pairs.length, 0);
  assert.equal(a.skippedBroad, 1);
});

test("the same post is only grouped within the same kind of block", () => {
  const p = POSTS[3];
  const a = analyze([
    rec("a.md", `| 1 | @${p.user} | ${p.text} | https://x.com/${p.user}/status/${p.id} |\n`.replace("| 1 |", "| 1 |") + "\n"),
    rec("b.md", `${postQuote(p)}\n`),
  ]);
  assert.equal(a.groups.length, 0);
});
