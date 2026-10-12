import { test } from "node:test";
import assert from "node:assert/strict";
import { executePlan, undoBackup, RECENT_MS } from "../src/dedupe/core/engine";
import { applyEdits, buildPlan, groupItem, PlanItem, PlanOptions, CleanMode } from "../src/dedupe/core/plan";
import { fingerprint } from "../src/dedupe/core/text";
import { analyze, FileRecord } from "../src/dedupe/core/group";
import { tokenize } from "../src/dedupe/core/tokenize";
import { OPTS, POSTS, buildVault, frontmatter, table } from "./dedupe/fixtures";
import { MemVault, scanVault } from "./dedupe/helpers";

const base = (name: string) => name.replace(/\.md$/, "").split("/").pop() as string;
const popts = (mode: CleanMode, embed = true): PlanOptions => ({ mode, embed, linkText: base, linkLabel: (p) => `see ${base(p)}` });

function texts(v: MemVault): Map<string, string> {
  return new Map(Array.from(v.files.entries()).map(([p, f]) => [p, f.text]));
}
function allItems(v: MemVault): PlanItem[] {
  return scanVault(v).groups.map((g) => groupItem(g));
}
/** Pretend the vault was last touched long ago, so the recent-edit guard does not interfere. */
function aged(): MemVault {
  const v = new MemVault(buildVault());
  v.clock += 60_000;
  return v;
}

test("mark mode only touches properties and leaves every block in place", async () => {
  const v = aged();
  const before = new Map(texts(v));
  const plan = buildPlan(allItems(v), texts(v), popts("mark"));
  assert.ok(plan.files.length >= 1);
  const res = await executePlan(plan, v, "duplicate_of");
  assert.ok(res.changed.length >= 1);
  for (const p of res.changed) {
    const now = v.files.get(p)!.text;
    assert.match(now, /duplicate_of:/);
    // everything below the frontmatter is untouched
    const body = (t: string) => (t.startsWith("---\n") ? t.slice(t.indexOf("\n---\n", 3) + 5) : t);
    assert.equal(body(now), body(before.get(p)!));
  }
  // the oldest note is never marked
  assert.ok(!res.changed.includes("x/2026-10-05-1423-ForYou采样清单.md"));
});

test("remove mode deletes duplicates from the later notes and keeps the first occurrence", async () => {
  const v = aged();
  const first = v.files.get("x/2026-10-05-1423-ForYou采样清单.md")!.text;
  const plan = buildPlan(allItems(v), texts(v), popts("remove"));
  const res = await executePlan(plan, v, "duplicate_of");
  assert.equal(v.files.get("x/2026-10-05-1423-ForYou采样清单.md")!.text, first, "oldest note untouched");
  assert.ok(res.changed.includes("x/2026-10-06-0912-ForYou续查.md"));
  // a rescan finds nothing left to clean across these notes
  const again = scanVault(v);
  assert.equal(again.groups.length, 0, JSON.stringify(again.groups.map((g) => g.occs.map((o) => o.path + ":" + o.block.s))));
  const follow = v.files.get("x/2026-10-06-0912-ForYou续查.md")!.text;
  assert.ok(follow.includes("续查结果"), "unique content of the follow-up stays");
  assert.ok(!/\n\n\n/.test(follow), "no stacked blank lines");
});

test("a table whose rows are all removed disappears with its header", () => {
  const rows = POSTS.slice(0, 3);
  const a = `${frontmatter("2026-10-05")}\n# A\n\n${table(rows)}\n\nafter table text stays here and is long enough to be a block, certainly more than eighty chars.\n`;
  const b = `${frontmatter("2026-10-06")}\n# B\n\n${table(rows)}\n\nB's own paragraph that is unique to the second note, again long enough to count as a block of its own.\n`;
  const v = new MemVault({ "2026-10-05-a.md": { text: a, ctime: 1, mtime: 1 }, "2026-10-06-b.md": { text: b, ctime: 2, mtime: 2 } });
  const plan = buildPlan(allItems(v), texts(v), popts("remove"));
  const edited = applyEdits(b, plan.files[0].edits);
  assert.ok(!edited.text.includes("| 作者 |"), "header removed");
  assert.ok(!edited.text.includes("|------|"), "delimiter removed");
  assert.ok(edited.text.includes("B's own paragraph"));
  assert.ok(edited.text.includes("# B"));
});

test("a partially removed table keeps its header and the remaining rows", () => {
  const a = `${table(POSTS.slice(0, 2))}\n`;
  const b = `${table(POSTS.slice(0, 3))}\n`;
  const v = new MemVault({ "2026-10-05-a.md": { text: a, ctime: 1, mtime: 1 }, "2026-10-06-b.md": { text: b, ctime: 2, mtime: 2 } });
  const plan = buildPlan(allItems(v), texts(v), popts("remove"));
  const edited = applyEdits(b, plan.files[0].edits).text;
  assert.ok(edited.includes("| 作者 |"));
  assert.ok(edited.includes(POSTS[2].id));
  assert.ok(!edited.includes(POSTS[0].id));
});

test("link mode adds a block id to the kept block and replaces later copies with embeds", async () => {
  const v = aged();
  const plan = buildPlan(allItems(v), texts(v), popts("link"));
  assert.ok(plan.skipped.some((s) => s.reason === "unsupported"), "table rows are not linked");
  const res = await executePlan(plan, v, "duplicate_of");
  const first = v.files.get("x/2026-10-05-1423-ForYou采样清单.md")!.text;
  const ids = first.match(/ \^cd-[a-z0-9]+/g) ?? [];
  assert.ok(ids.length >= 1, "kept blocks got ids");
  const evening = v.files.get("x/2026-10-05-2025-ForYou采样清单.md")!.text;
  assert.match(evening, /!\[\[2026-10-05-1423-ForYou采样清单#\^cd-[a-z0-9]+\]\]/);
  assert.ok(res.changed.length >= 2);
  // every embed points at an id that exists
  for (const [, f] of v.files) {
    for (const m of f.text.matchAll(/!\[\[([^#\]]+)#\^(cd-[a-z0-9]+)\]\]/g)) {
      const target = Array.from(v.files.entries()).find(([p]) => base(p) === m[1]);
      assert.ok(target && target[1].text.includes(` ^${m[2]}`), `dangling embed ${m[0]}`);
    }
  }
});

test("link mode keeps list markers and supports link style", () => {
  const item = `- ${"shared list item with plenty of words to pass the minimum length for blocks ".repeat(2)}\n`;
  const v = new MemVault({ "2026-10-05-a.md": { text: `intro\n\n${item}`, ctime: 1, mtime: 1 }, "2026-10-06-b.md": { text: `other\n\n${item}\n- tail item\n`, ctime: 2, mtime: 2 } });
  const plan = buildPlan(allItems(v), texts(v), popts("link", false));
  const b = plan.files.find((f) => f.path === "2026-10-06-b.md")!;
  const out = applyEdits(v.files.get("2026-10-06-b.md")!.text, b.edits, new Set(plan.files.flatMap((f) => f.edits.filter((e) => e.type === "blockid").map((e) => (e as { key: string }).key))));
  assert.match(out.text, /\n- \[\[2026-10-05-a#\^cd-[a-z0-9]+\|see 2026-10-05-a\]\]\n/);
  assert.ok(out.text.includes("- tail item"));
});

test("an existing block id on the kept block is reused", () => {
  const p = "paragraph with an existing id and enough words to be considered a block by the scanner here";
  const v = new MemVault({ "2026-10-05-a.md": { text: `${p} ^keepme\n`, ctime: 1, mtime: 1 }, "2026-10-06-b.md": { text: `${p}\n`, ctime: 2, mtime: 2 } });
  const plan = buildPlan(allItems(v), texts(v), popts("link"));
  assert.ok(!plan.files.some((f) => f.edits.some((e) => e.type === "blockid")));
  const out = applyEdits(v.files.get("2026-10-06-b.md")!.text, plan.files[0].edits, new Set(["2026-10-05-a.md#keepme"]));
  assert.match(out.text, /!\[\[2026-10-05-a#\^keepme\]\]/);
});

test("the backup is written before the first change and undo restores every note", async () => {
  const v = aged();
  const originals = new Map(texts(v));
  const plan = buildPlan(allItems(v), texts(v), popts("remove"));
  const res = await executePlan(plan, v, "duplicate_of");
  const firstWrite = v.log.findIndex((l) => l.startsWith("write:") || l.startsWith("fm:"));
  const firstBackup = v.log.findIndex((l) => l.startsWith("backup:"));
  assert.ok(firstBackup >= 0 && firstBackup < firstWrite, v.log.join(" > "));
  assert.ok(v.log.find((l) => l.startsWith("backup:"))!.includes("pending"));
  assert.ok(res.backupId);
  const rec = v.backups.get(res.backupId!)!;
  assert.equal(rec.files.length, res.changed.length);
  assert.ok(rec.files.every((f) => f.post !== null));
  const undo = await undoBackup(rec, v);
  assert.equal(undo.skipped.length, 0);
  for (const [p, t] of originals) assert.equal(v.files.get(p)!.text, t, p);
  assert.equal(v.backups.size, 0, "backup removed after a full undo");
});

test("undo skips notes the user edited after the cleanup and keeps their backup", async () => {
  const v = aged();
  const plan = buildPlan(allItems(v), texts(v), popts("remove"));
  const res = await executePlan(plan, v, "duplicate_of");
  const rec = v.backups.get(res.backupId!)!;
  const edited = res.changed[0];
  v.files.get(edited)!.text += "\nMy own note added afterwards.\n";
  const undo = await undoBackup(rec, v);
  assert.deepEqual(undo.skipped.map((s) => s.path), [edited]);
  assert.equal(undo.skipped[0].reason, "edited");
  assert.ok(v.files.get(edited)!.text.endsWith("My own note added afterwards.\n"), "edited note untouched");
  assert.equal(undo.restored.length, res.changed.length - 1);
  assert.equal(v.backups.get(rec.id)!.files.length, 1, "the unrestored note stays in the backup");
});

test("undo skips deleted notes and treats already-restored notes as done", async () => {
  const v = aged();
  const plan = buildPlan(allItems(v), texts(v), popts("remove"));
  const res = await executePlan(plan, v, "duplicate_of");
  const rec = v.backups.get(res.backupId!)!;
  v.files.delete(res.changed[0]);
  v.files.get(res.changed[1])!.text = rec.files[1].original;
  const undo = await undoBackup(rec, v);
  assert.equal(undo.skipped[0].reason, "missing");
  assert.ok(undo.restored.includes(res.changed[1]));
});

test("a note edited between scan and apply is skipped, not overwritten", async () => {
  const v = aged();
  const plan = buildPlan(allItems(v), texts(v), popts("remove"));
  const target = "x/2026-10-06-0912-ForYou续查.md";
  v.files.get(target)!.text = v.files.get(target)!.text.replace("ForYou 采样清单", "ForYou 采样清单 (edited)");
  // also change one duplicated row in place
  v.files.get(target)!.text = v.files.get(target)!.text.replace(POSTS[2].user, "someoneelse");
  const res = await executePlan(plan, v, "duplicate_of");
  assert.ok(res.skipped.some((s) => s.path === target && s.reason === "stale"));
  assert.ok(v.files.get(target)!.text.includes("someoneelse"), "user's edit survives");
});

test("notes modified within the last two seconds are not touched", async () => {
  const v = new MemVault(buildVault());
  v.clock = v.files.get("x/2026-10-06-0912-ForYou续查.md")!.mtime + RECENT_MS - 1;
  for (const f of v.files.values()) f.mtime = v.clock - 100;
  const before = new Map(texts(v));
  const plan = buildPlan(allItems(v), texts(v), popts("remove"));
  const res = await executePlan(plan, v, "duplicate_of");
  assert.equal(res.changed.length, 0);
  assert.equal(res.backupId, null);
  assert.ok(res.skipped.some((s) => s.reason === "recent"));
  for (const [p, t] of before) assert.equal(v.files.get(p)!.text, t);
  assert.equal(v.backups.size, 0);
});

test("cancelling stops after the current note and leaves the rest untouched", async () => {
  const v = aged();
  const plan = buildPlan(allItems(v), texts(v), popts("remove"));
  assert.ok(plan.files.length >= 2);
  let n = 0;
  const res = await executePlan(plan, v, "duplicate_of", { cancelled: () => n++ >= 1 });
  assert.equal(res.cancelled, true);
  assert.ok(res.skipped.some((s) => s.reason === "cancelled"));
  assert.ok(res.changed.length < plan.files.length);
  const undo = await undoBackup(v.backups.get(res.backupId!)!, v);
  assert.equal(undo.skipped.length, 0);
});

test("mark mode merges with an existing duplicate_of property", async () => {
  const p = "paragraph shared between three notes with enough words to be a block for sure okay";
  const v = new MemVault({
    "2026-10-01-a.md": { text: `---\ndate: 1\n---\n${p}\n`, ctime: 1, mtime: 1 },
    "2026-10-02-b.md": { text: `---\nduplicate_of:\n  - "old"\n---\n${p}\n`, ctime: 2, mtime: 2 },
    "2026-10-03-c.md": { text: `${p}\n`, ctime: 3, mtime: 3 },
  });
  v.clock += 60_000;
  const plan = buildPlan(allItems(v), texts(v), popts("mark"));
  await executePlan(plan, v, "duplicate_of");
  const b = v.files.get("2026-10-02-b.md")!.text;
  assert.match(b, /- "old"/);
  assert.match(b, /- "\[\[2026-10-01-a\]\]"/);
  assert.match(v.files.get("2026-10-03-c.md")!.text, /^---\nduplicate_of:\n {2}- "\[\[2026-10-01-a\]\]"\n---\n/);
  assert.equal(v.files.get("2026-10-01-a.md")!.text, `---\ndate: 1\n---\n${p}\n`);
});

test("choosing a different kept occurrence changes what is removed", () => {
  const v = aged();
  const a = scanVault(v);
  const g = a.groups.find((x) => x.occs.length === 3)!;
  const item = groupItem(g, 2);
  assert.equal(item.keep.path, g.occs[2].path);
  assert.equal(item.remove.length, 2);
  const plan = buildPlan([item], texts(v), popts("remove"));
  assert.ok(!plan.files.some((f) => f.path === item.keep.path));
});

test("CRLF notes are cleaned without mixing line endings", () => {
  const p = "carriage return paragraph with sufficient length so that it is certainly treated as a block ok";
  const a = `intro line\r\n\r\n${p}\r\n`;
  const b = `other\r\n\r\n${p}\r\n\r\nunique tail text that should stay in the second note after the cleanup finishes ok\r\n`;
  const v = new MemVault({ "2026-10-01-a.md": { text: a, ctime: 1, mtime: 1 }, "2026-10-02-b.md": { text: b, ctime: 2, mtime: 2 } });
  const plan = buildPlan(allItems(v), texts(v), popts("link"));
  const dep = new Set(plan.files.flatMap((f) => f.edits.filter((e) => e.type === "blockid").map((e) => (e as { key: string }).key)));
  const keptOut = applyEdits(a, plan.files.find((f) => f.path === "2026-10-01-a.md")!.edits);
  assert.match(keptOut.text, / \^cd-[a-z0-9]+\r\n$/);
  const out = applyEdits(b, plan.files.find((f) => f.path === "2026-10-02-b.md")!.edits, dep);
  assert.ok(!/[^\r]\n/.test(out.text.replace(/\n$/, "")) || out.text.split("\n").every((l, i, arr) => i === arr.length - 1 || l.endsWith("\r")));
  assert.match(out.text, /!\[\[2026-10-01-a#\^cd-[a-z0-9]+\]\]\r\n/);
});

test("scale: 3000 notes scan and group quickly", () => {
  const files: FileRecord[] = [];
  const t0 = Date.now();
  for (let i = 0; i < 3000; i++) {
    const shared = i % 10 === 0 ? `\n\n${POSTS[i % 12].text} ${POSTS[(i + 1) % 12].text}\n` : "";
    const text = `${frontmatter("2026-01-01")}\n# Note ${i}\n\nUnique paragraph number ${i} ${"with filler words to be long enough ".repeat(4)}${i}\n${shared}\n${table(POSTS.slice(i % 4, (i % 4) + 3))}\n`;
    const t = tokenize(text, OPTS);
    files.push({ path: `n/${i}.md`, ctime: i, mtime: i, len: text.length, lines: t.lines, totalW: t.totalW, blocks: t.blocks });
  }
  const a = analyze(files);
  const ms = Date.now() - t0;
  assert.ok(a.groups.length > 0);
  assert.ok(ms < 5000, `took ${ms} ms`);
  assert.equal(fingerprint("x"), fingerprint("x"));
});
