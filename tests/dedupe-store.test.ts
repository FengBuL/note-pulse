import { test } from "node:test";
import assert from "node:assert/strict";
import type { DataAdapter } from "obsidian";
import { BackupStore, ScanCache, packBlocks, unpackBlocks } from "../src/dedupe/store";
import { tokenize } from "../src/dedupe/core/tokenize";
import { OPTS, buildVault } from "./dedupe/fixtures";

class FakeAdapter {
  files = new Map<string, string>();
  dirs = new Set<string>();
  async exists(p: string) { return this.files.has(p) || this.dirs.has(p); }
  async read(p: string) { const v = this.files.get(p); if (v === undefined) throw new Error("ENOENT"); return v; }
  async write(p: string, d: string) { this.files.set(p, d); }
  async remove(p: string) { this.files.delete(p); }
  async mkdir(p: string) { this.dirs.add(p); }
  async list(dir: string) { return { files: Array.from(this.files.keys()).filter((k) => k.startsWith(dir + "/")), folders: [] as string[] }; }
}
const asAdapter = (a: FakeAdapter) => a as unknown as DataAdapter;

test("blocks survive the compact cache format", () => {
  const files = buildVault();
  const t = tokenize(files["x/2026-10-05-2025-ForYou采样清单.md"].text, OPTS);
  assert.ok(t.blocks.length > 5);
  assert.deepEqual(unpackBlocks(packBlocks(t.blocks)), t.blocks);
});

test("scan cache keys entries by mtime and size, and drops them when the settings key changes", async () => {
  const ad = new FakeAdapter();
  const c = new ScanCache(asAdapter(ad), "cache.json");
  await c.load("k1");
  c.set("a.md", [10, 100, 90, 5, 40, []]);
  c.set("b.md", [11, 100, 90, 5, 40, []]);
  await c.save();
  const c2 = new ScanCache(asAdapter(ad), "cache.json");
  await c2.load("k1");
  assert.ok(c2.get("a.md", 10, 100));
  assert.equal(c2.get("a.md", 11, 100), null, "changed mtime misses");
  assert.equal(c2.get("a.md", 10, 101), null, "changed size misses");
  c2.prune(new Set(["a.md"]));
  assert.equal(c2.files.has("b.md"), false);
  const c3 = new ScanCache(asAdapter(ad), "cache.json");
  await c3.load("other-settings");
  assert.equal(c3.files.size, 0);
  ad.files.set("cache.json", "{ not json");
  const c4 = new ScanCache(asAdapter(ad), "cache.json");
  await c4.load("k1");
  assert.equal(c4.files.size, 0, "a corrupt cache is ignored");
});

test("backup store lists, loads, prunes and returns the newest backup", async () => {
  const ad = new FakeAdapter();
  const s = new BackupStore(asAdapter(ad), "plug/backups");
  const mk = (id: string) => ({ v: 1 as const, id, createdAt: 1, mode: "remove" as const, blocks: 1, chars: 1, files: [{ path: "a.md", original: "x", pre: "p", post: "q" }] });
  for (const id of ["20261010-101010", "20261011-101010", "20261012-101010"]) await s.save(mk(id));
  assert.equal((await s.latest())?.id, "20261012-101010");
  await s.prune(2);
  assert.deepEqual(await s.ids(), ["20261011-101010", "20261012-101010"]);
  ad.files.set("plug/backups/20261013-000000.json", "garbage");
  assert.equal((await s.latest())?.id, "20261012-101010", "a damaged newest file is skipped");
});
