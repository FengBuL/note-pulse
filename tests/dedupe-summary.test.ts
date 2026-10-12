import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, FileRecord } from "../src/dedupe/core/group";
import { groupKey, noteDay, overview, readablePreview } from "../src/dedupe/core/summary";
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
