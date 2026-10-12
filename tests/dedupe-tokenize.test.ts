import { test } from "node:test";
import assert from "node:assert/strict";
import { findTables, tokenize } from "../src/dedupe/core/tokenize";
import { OPTS, POSTS, table } from "./dedupe/fixtures";

const long = (s: string) => `${s} ` + "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor";

test("frontmatter is skipped by default and tokenised when allowed", () => {
  const body = `---\ntitle: ${long("front")}\n---\n\n${long("para")}\n`;
  const a = tokenize(body, OPTS);
  assert.equal(a.blocks.length, 1);
  assert.equal(a.blocks[0].s, 4);
  const b = tokenize(body, { ...OPTS, ignoreFrontmatter: false });
  assert.equal(b.blocks.length, 2);
});

test("code fences are ignored by default, kept as one block otherwise", () => {
  const body = `intro\n\n\`\`\`ts\n${long("const x = 1;")}\n\n${long("const y = 2;")}\n\`\`\`\n\n${long("after")}\n`;
  assert.deepEqual(tokenize(body, OPTS).blocks.map((b) => b.k), ["p"]);
  const withCode = tokenize(body, { ...OPTS, ignoreCode: false, minLength: 20 });
  assert.deepEqual(withCode.blocks.map((b) => b.k), ["code", "p"]);
  assert.equal(withCode.blocks[0].s, 2);
  assert.equal(withCode.blocks[0].e, 6);
});

test("table rows become individual blocks and header/delimiter are skipped", () => {
  const t = table(POSTS.slice(0, 3));
  const r = tokenize(`# T\n\n${t}\n`, OPTS);
  assert.equal(r.blocks.length, 3);
  assert.ok(r.blocks.every((b) => b.k === "tr" && b.s === b.e));
  assert.deepEqual(r.blocks.map((b) => b.s), [4, 5, 6]);
  assert.ok(r.blocks.every((b) => b.sid.length > 0));
  const tables = findTables(`# T\n\n${t}\n`.split("\n"));
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0].rows, [4, 5, 6]);
  assert.equal(tables[0].header, 2);
});

test("nested lists emit the parent with children and each nested item", () => {
  const text = `- ${long("parent item")}\n  - ${long("child one")}\n    - ${long("grandchild")}\n  - ${long("child two")}\n- ${long("sibling")}\n`;
  const r = tokenize(text, OPTS);
  const spans = r.blocks.map((b) => [b.s, b.e, !!b.nested]);
  assert.deepEqual(spans, [
    [0, 3, false],
    [1, 2, true],
    [2, 2, true],
    [3, 3, true],
    [4, 4, false],
  ]);
});

test("list items keep lazy continuation lines and blank-separated children", () => {
  const text = `- first line of item\ncontinuation without indent that is long enough to matter ${"x".repeat(60)}\n\n  - child after blank\n\n- next\n`;
  const r = tokenize(text, { ...OPTS, minLength: 10 });
  const first = r.blocks.find((b) => b.s === 0);
  assert.ok(first);
  assert.equal(first.e, 3);
});

test("blockquote with callout is one block", () => {
  const r = tokenize(`> [!note] Title\n> ${long("line one")}\n> ${long("line two")}\n\nafter\n`, OPTS);
  assert.equal(r.blocks.length, 1);
  assert.equal(r.blocks[0].k, "bq");
  assert.equal(r.blocks[0].e, 2);
});

test("headings, link-only blocks and short blocks are dropped", () => {
  const text = `# ${long("heading")}\n\n- https://example.com/${"a".repeat(120)}\n\nshort line\n\n${long("kept")}\n`;
  const r = tokenize(text, OPTS);
  assert.equal(r.blocks.length, 1);
  assert.equal(r.blocks[0].k, "p");
  assert.equal(tokenize(text, { ...OPTS, ignoreHeadings: false }).blocks.length, 2);
  assert.equal(tokenize(text, { ...OPTS, ignoreLinkOnly: false }).blocks.length, 2);
});

test("min length is CJK-aware: 40 Han characters pass an 80 threshold", () => {
  const han40 = "汉".repeat(40);
  const han39 = "汉".repeat(39);
  assert.equal(tokenize(han40, OPTS).blocks.length, 1);
  assert.equal(tokenize(han39, OPTS).blocks.length, 0);
  assert.equal(tokenize("a".repeat(80), OPTS).blocks.length, 1);
  assert.equal(tokenize("a".repeat(79), OPTS).blocks.length, 0);
});

test("a block with a status id is kept even when short, unless detection is off", () => {
  const text = "- @a: hi https://x.com/a/status/1842110000000000001\n";
  const r = tokenize(text, OPTS);
  assert.equal(r.blocks.length, 1);
  assert.equal(r.blocks[0].sid, "1842110000000000001");
  assert.equal(tokenize(text, { ...OPTS, detectStatusIds: false }).blocks.length, 0);
});

test("CRLF notes produce the same blocks and fingerprints as LF notes", () => {
  const lf = `# T\n\n${long("alpha")}\n\n- ${long("beta")}\n`;
  const crlf = lf.replace(/\n/g, "\r\n");
  const a = tokenize(lf, OPTS).blocks;
  const b = tokenize(crlf, OPTS).blocks;
  assert.deepEqual(a.map((x) => [x.s, x.e, x.h]), b.map((x) => [x.s, x.e, x.h]));
});

test("block ids and markers do not change a block's fingerprint", () => {
  const a = tokenize(`- ${long("same text")}\n`, OPTS).blocks[0];
  const b = tokenize(`* ${long("Same Text")} ^abc123\n`, OPTS).blocks[0];
  assert.equal(a.h, b.h);
});
