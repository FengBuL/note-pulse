import type { DataAdapter } from "obsidian";
import type { BackupRecord } from "./core/engine";
import type { Block, BlockKind } from "./core/tokenize";

const CACHE_VERSION = 1;

type BlockTuple = [number, number, BlockKind, string, number, number, number, string, number];
/** [mtime, size, chars, lines, totalW, blocks] */
export type CacheEntry = [number, number, number, number, number, BlockTuple[]];

interface CacheFile {
  v: number;
  key: string;
  files: Record<string, CacheEntry>;
}

export function packBlocks(blocks: Block[]): BlockTuple[] {
  return blocks.map((b) => [b.s, b.e, b.k, b.h, b.w, b.r, b.n, b.sid, b.nested ? 1 : 0]);
}

export function unpackBlocks(tuples: BlockTuple[]): Block[] {
  return tuples.map((t) => {
    const b: Block = { s: t[0], e: t[1], k: t[2], h: t[3], w: t[4], r: t[5], n: t[6], sid: t[7] };
    if (t[8]) b.nested = true;
    return b;
  });
}

/** Per-note scan results keyed by modified time, kept in a file of its own so settings stay small. */
export class ScanCache {
  files = new Map<string, CacheEntry>();
  key = "";
  dirty = false;

  constructor(private adapter: DataAdapter, private path: string) {}

  async load(key: string): Promise<void> {
    this.key = key;
    this.files.clear();
    try {
      if (!(await this.adapter.exists(this.path))) return;
      const raw = JSON.parse(await this.adapter.read(this.path)) as CacheFile | null;
      if (!raw || raw.v !== CACHE_VERSION || raw.key !== key || !raw.files) return;
      for (const [p, e] of Object.entries(raw.files)) this.files.set(p, e);
    } catch {
      this.files.clear();
    }
  }

  /** Drops every entry when the settings that shape tokenising have changed. */
  useKey(key: string): void {
    if (key === this.key) return;
    this.key = key;
    this.files.clear();
    this.dirty = true;
  }

  get(path: string, mtime: number, size: number): CacheEntry | null {
    const e = this.files.get(path);
    return e && e[0] === mtime && e[1] === size ? e : null;
  }

  set(path: string, e: CacheEntry): void {
    this.files.set(path, e);
    this.dirty = true;
  }

  prune(valid: Set<string>): void {
    for (const p of Array.from(this.files.keys())) {
      if (!valid.has(p)) {
        this.files.delete(p);
        this.dirty = true;
      }
    }
  }

  async clear(): Promise<void> {
    this.files.clear();
    this.dirty = false;
    try {
      if (await this.adapter.exists(this.path)) await this.adapter.remove(this.path);
    } catch {
      /* nothing to remove */
    }
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    const files: Record<string, CacheEntry> = {};
    for (const [p, e] of this.files) files[p] = e;
    await this.adapter.write(this.path, JSON.stringify({ v: CACHE_VERSION, key: this.key, files } satisfies CacheFile));
    this.dirty = false;
  }
}

/** Cleanup backups: one JSON file per cleanup with the original text of every note it changed. */
export class BackupStore {
  constructor(private adapter: DataAdapter, private dir: string) {}

  private file(id: string): string {
    return `${this.dir}/${id}.json`;
  }

  async save(rec: BackupRecord): Promise<void> {
    if (!(await this.adapter.exists(this.dir))) await this.adapter.mkdir(this.dir);
    await this.adapter.write(this.file(rec.id), JSON.stringify(rec));
  }

  async remove(id: string): Promise<void> {
    const f = this.file(id);
    if (await this.adapter.exists(f)) await this.adapter.remove(f);
  }

  async ids(): Promise<string[]> {
    if (!(await this.adapter.exists(this.dir))) return [];
    const listing = await this.adapter.list(this.dir);
    return listing.files
      .map((p) => p.slice(p.lastIndexOf("/") + 1))
      .filter((n) => /^\d{8}-\d{6}\.json$/.test(n))
      .map((n) => n.replace(/\.json$/, ""))
      .sort();
  }

  async load(id: string): Promise<BackupRecord | null> {
    try {
      const rec = JSON.parse(await this.adapter.read(this.file(id))) as BackupRecord | null;
      return rec && rec.v === 1 && Array.isArray(rec.files) ? rec : null;
    } catch {
      return null;
    }
  }

  async latest(): Promise<BackupRecord | null> {
    const ids = await this.ids();
    for (let i = ids.length - 1; i >= 0; i--) {
      const rec = await this.load(ids[i]);
      if (rec) return rec;
    }
    return null;
  }

  async prune(keep: number): Promise<void> {
    const ids = await this.ids();
    for (const id of ids.slice(0, Math.max(0, ids.length - keep))) await this.remove(id);
  }
}
