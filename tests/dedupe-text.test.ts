import { test } from "node:test";
import assert from "node:assert/strict";
import { countWords, extractStatusIds, fingerprint, isLinkOnly, normalizeText, normalizeUrl, trailingBlockId, weightedLength } from "../src/dedupe/core/text";

test("normalizeText strips markup, case and whitespace", () => {
  assert.equal(normalizeText("- **Hello**   _World_  "), "hello world");
  assert.equal(normalizeText("> [!note] Same   Thing"), "[!note] same thing");
  assert.equal(normalizeText("- [x] done task ^abc123"), "done task");
  assert.equal(normalizeText("## Heading Text"), "heading text");
  assert.equal(normalizeText("[[Some Note|alias]] and [[Other#Head]]"), "alias and other");
  assert.equal(normalizeText("[label](https://Example.com/a/?utm_source=x&b=2)"), "label example.com/a?b=2");
  assert.equal(normalizeText("<b>bold</b> text"), "bold text");
});

test("normalizeText ignores wrapped lines in CJK text but keeps word spaces in Latin text", () => {
  const a = normalizeText("这是一段很长的文字，\n在编辑器里被手动换行了。");
  const b = normalizeText("这是一段很长的文字， 在编辑器里被手动换行了。");
  assert.equal(a, b);
  assert.equal(normalizeText("hello\nworld"), "hello world");
  assert.equal(normalizeText("ＡＢＣ　ｄｅｆ"), "abc def");
});

test("normalizeText turns table rows into text and drops delimiter rows", () => {
  assert.equal(normalizeText("| 1 | @a | hello **there** |"), "@a hello there");
  assert.equal(normalizeText("| 12 | @a | hello **there** |"), normalizeText("| 3 | @a | hello there |"));
  assert.equal(normalizeText("| name | @a | hello there |"), "name @a hello there");
  assert.equal(normalizeText("|---|:--:|---|"), "");
});

test("normalizeUrl removes tracking and unifies X hosts", () => {
  assert.equal(normalizeUrl("https://twitter.com/foo/status/123?s=20&t=abc"), "x.com/status/123");
  assert.equal(normalizeUrl("https://mobile.twitter.com/foo/status/123"), "x.com/status/123");
  assert.equal(normalizeUrl("https://x.com/i/web/status/123"), "x.com/status/123");
  assert.equal(normalizeUrl("https://www.example.com/p/?utm_medium=a&id=7&fbclid=zz#frag"), "example.com/p?id=7");
  assert.equal(normalizeUrl("https://example.com/page/."), "example.com/page");
});

test("extractStatusIds finds distinct ids on all X hosts", () => {
  const raw = "see https://x.com/a/status/1842110000000000001?s=20 and https://twitter.com/b/status/1842110000000000002 and again https://x.com/a/status/1842110000000000001";
  assert.deepEqual(extractStatusIds(raw), ["1842110000000000001", "1842110000000000002"]);
  assert.deepEqual(extractStatusIds("https://x.com/i/web/status/99999999"), ["99999999"]);
  assert.deepEqual(extractStatusIds("https://example.com/status/12345678"), []);
  assert.deepEqual(extractStatusIds("no ids here"), []);
});

test("weightedLength counts CJK characters double; countWords is CJK aware", () => {
  assert.equal(weightedLength("abc"), 3);
  assert.equal(weightedLength("中文"), 4);
  assert.equal(weightedLength("a中"), 3);
  assert.equal(countWords("hello world 你好吗"), 5);
});

test("isLinkOnly", () => {
  assert.equal(isLinkOnly("- https://example.com/a"), true);
  assert.equal(isLinkOnly("[[Note]] [[Other]]"), true);
  assert.equal(isLinkOnly("![[image.png]]"), true);
  assert.equal(isLinkOnly("- see https://example.com/a"), false);
  assert.equal(isLinkOnly("> [label](https://x.y/z)"), true);
});

test("fingerprint and trailingBlockId", () => {
  assert.equal(fingerprint("abc"), fingerprint("abc"));
  assert.notEqual(fingerprint("abc"), fingerprint("abd"));
  assert.equal(trailingBlockId("some text ^abc-12"), "abc-12");
  assert.equal(trailingBlockId("some text"), null);
  assert.equal(trailingBlockId("2^8"), null);
});
