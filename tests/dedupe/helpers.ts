import { ApplyIO, BackupRecord } from "../../src/dedupe/core/engine";
import { FileRecord, analyze, Analysis, GroupOptions } from "../../src/dedupe/core/group";
import { tokenize, TokenizeOptions } from "../../src/dedupe/core/tokenize";
import { OPTS } from "./fixtures";

export interface MemFile {
  text: string;
  ctime: number;
  mtime: number;
}

/** In-memory stand-in for the Obsidian vault. */
export class MemVault implements ApplyIO {
  files = new Map<string, MemFile>();
  backups = new Map<string, BackupRecord>();
  clock = Date.UTC(2026, 9, 12, 12, 0, 0);
  log: string[] = [];
  constructor(init: Record<string, MemFile>) {
    for (const [p, f] of Object.entries(init)) this.files.set(p, { ...f });
  }
  now() {
    return this.clock;
  }
  mtime(path: string) {
    return this.files.get(path)?.mtime ?? null;
  }
  async read(path: string) {
    return this.files.get(path)?.text ?? null;
  }
  async process(path: string, fn: (d: string) => string) {
    const f = this.files.get(path);
    if (!f) throw new Error("missing " + path);
    const out = fn(f.text);
    if (out !== f.text) {
      this.log.push("write:" + path);
      f.text = out;
      f.mtime = this.clock;
    }
    return out;
  }
  async processFrontMatter(path: string, fn: (fm: Record<string, unknown>) => void) {
    const f = this.files.get(path);
    if (!f) throw new Error("missing " + path);
    const m = /^---\n([\s\S]*?)\n---\n?/.exec(f.text);
    const fm: Record<string, unknown> = {};
    let body = f.text;
    let keep: string[] = [];
    if (m) {
      body = f.text.slice(m[0].length);
      const lines = m[1].split("\n");
      let curKey = "";
      for (const l of lines) {
        const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(l);
        const li = /^\s+-\s+"?(.*?)"?$/.exec(l);
        if (kv) {
          curKey = kv[1];
          if (kv[2] === "") fm[curKey] = [];
          else fm[curKey] = kv[2];
        } else if (li && Array.isArray(fm[curKey])) (fm[curKey] as string[]).push(li[1]);
      }
      keep = lines;
    }
    const before = JSON.stringify(fm);
    fn(fm);
    if (JSON.stringify(fm) === before) return;
    // naive writer: keep original lines for untouched keys, rewrite the changed ones
    const out: string[] = [];
    const written = new Set<string>();
    let skipKey = false;
    for (const l of keep) {
      const kv = /^([A-Za-z_]+):/.exec(l);
      if (kv) {
        skipKey = false;
        if (Array.isArray(fm[kv[1]]) && before.includes(`"${kv[1]}"`) && JSON.stringify((JSON.parse(before) as Record<string, unknown>)[kv[1]]) !== JSON.stringify(fm[kv[1]])) {
          skipKey = true;
          out.push(`${kv[1]}:`, ...(fm[kv[1]] as string[]).map((v) => `  - "${v}"`));
          written.add(kv[1]);
          continue;
        }
        written.add(kv[1]);
        out.push(l);
      } else if (!skipKey) out.push(l);
    }
    for (const k of Object.keys(fm)) {
      if (written.has(k)) continue;
      const v = fm[k];
      out.push(Array.isArray(v) ? `${k}:\n${v.map((x) => `  - "${x}"`).join("\n")}` : `${k}: ${String(v)}`);
    }
    f.text = `---\n${out.join("\n")}\n---\n` + body;
    f.mtime = this.clock;
    this.log.push("fm:" + path);
  }
  async saveBackup(rec: BackupRecord) {
    this.log.push("backup:" + rec.id + ":" + rec.files.map((x) => x.post === null ? "pending" : "post").join(","));
    this.backups.set(rec.id, JSON.parse(JSON.stringify(rec)) as BackupRecord);
  }
  async deleteBackup(id: string) {
    this.log.push("rmbackup:" + id);
    this.backups.delete(id);
  }
  async yieldToUi() {}
}

export function scanVault(v: MemVault, opts: TokenizeOptions = OPTS, group: Partial<GroupOptions> = {}): Analysis {
  const recs: FileRecord[] = [];
  for (const [path, f] of v.files) {
    const t = tokenize(f.text, opts);
    recs.push({ path, ctime: f.ctime, mtime: f.mtime, len: f.text.length, lines: t.lines, totalW: t.totalW, blocks: t.blocks });
  }
  return analyze(recs, group);
}
