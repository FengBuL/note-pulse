import { applyEdits, CleanMode, Edit, Plan, PlanFile, PlanSkip, PropEdit, SkipReason } from "./plan";
import { fingerprint } from "./text";

/** Notes touched less than this long ago are left alone (a sync client or the editor may still be writing). */
export const RECENT_MS = 2000;

export interface BackupFile {
  path: string;
  /** Full text before the cleanup. */
  original: string;
  /** Fingerprint of the original text. */
  pre: string;
  /** Fingerprint of the text right after the cleanup; null while the cleanup is still running. */
  post: string | null;
}

export interface BackupRecord {
  v: 1;
  id: string;
  createdAt: number;
  mode: CleanMode;
  blocks: number;
  chars: number;
  files: BackupFile[];
}

/** Everything the engine needs from the outside world, so it can run against a real vault or an in-memory one. */
export interface ApplyIO {
  now(): number;
  mtime(path: string): number | null;
  read(path: string): Promise<string | null>;
  /** Atomic read-modify-write; `fn` receives the content at the time of writing. */
  process(path: string, fn: (data: string) => string): Promise<string>;
  processFrontMatter(path: string, fn: (fm: Record<string, unknown>) => void): Promise<void>;
  saveBackup(rec: BackupRecord): Promise<void>;
  deleteBackup(id: string): Promise<void>;
  yieldToUi(): Promise<void>;
}

export interface Hooks {
  progress?: (done: number, total: number) => void;
  cancelled?: () => boolean;
}

export interface ApplyResult {
  backupId: string | null;
  changed: string[];
  appliedEdits: number;
  skipped: PlanSkip[];
  cancelled: boolean;
}

export function makeBackupId(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Merges new `duplicate_of`-style values into whatever the property already holds. */
export function mergePropValues(existing: unknown, values: string[]): string[] {
  const list: string[] = [];
  if (Array.isArray(existing)) for (const v of existing) list.push(String(v));
  else if (typeof existing === "string" && existing.trim() !== "") list.push(existing);
  for (const v of values) if (!list.includes(v)) list.push(v);
  return list;
}

/**
 * Runs a plan: backs up every note that will change, adds block ids to kept blocks, then edits the other notes.
 * Every step re-checks the note's current content, so a note edited in the meantime is skipped rather than overwritten.
 */
export async function executePlan(plan: Plan, io: ApplyIO, propName: string, hooks: Hooks = {}): Promise<ApplyResult> {
  const skipped: PlanSkip[] = [...plan.skipped];
  const now = io.now();
  const targets: PlanFile[] = [];
  for (const f of plan.files) {
    if (f.edits.length === 0) continue;
    const mt = io.mtime(f.path);
    if (mt === null) skipped.push({ path: f.path, reason: "missing" });
    else if (now - mt < RECENT_MS) skipped.push({ path: f.path, reason: "recent" });
    else targets.push(f);
  }

  // Back up first: nothing is written until the originals are safe on disk
  const files: BackupFile[] = [];
  const live: PlanFile[] = [];
  for (const f of targets) {
    const original = await io.read(f.path);
    if (original === null) {
      skipped.push({ path: f.path, reason: "missing" });
      continue;
    }
    files.push({ path: f.path, original, pre: fingerprint(original), post: null });
    live.push(f);
  }
  if (live.length === 0) return { backupId: null, changed: [], appliedEdits: 0, skipped, cancelled: false };

  const record: BackupRecord = { v: 1, id: makeBackupId(now), createdAt: now, mode: plan.mode, blocks: plan.blocks, chars: plan.chars, files };
  await io.saveBackup(record);

  const expected = new Map<string, string>(files.map((f) => [f.path, f.pre]));
  const okDeps = new Set<string>();
  let appliedEdits = 0;
  let cancelled = false;
  const total = live.length * 2;
  let done = 0;
  const tick = async () => {
    done++;
    hooks.progress?.(done, total);
    if (done % 4 === 0) await io.yieldToUi();
  };

  const run = async (path: string, edits: Edit[], deps: Set<string> | undefined): Promise<void> => {
    const box: { result: ReturnType<typeof applyEdits> | null } = { result: null };
    await io.process(path, (data) => {
      box.result = null;
      if (fingerprint(data) !== expected.get(path)) return data;
      box.result = applyEdits(data, edits, deps);
      return box.result.text;
    });
    const r = box.result;
    if (!r) {
      for (const e of edits) if (e.type !== "prop") skipped.push({ path, reason: "stale", groupId: e.groupId });
      return;
    }
    for (const s of r.skipped) skipped.push({ path, reason: s.reason, groupId: s.edit.type === "prop" ? undefined : s.edit.groupId });
    for (const e of r.applied) {
      appliedEdits++;
      if (e.type === "blockid") okDeps.add(e.key);
    }
    expected.set(path, fingerprint(r.text));
  };

  // Stage A: block ids on kept blocks
  for (const f of live) {
    const ids = f.edits.filter((e) => e.type === "blockid");
    if (ids.length) await run(f.path, ids, undefined);
    await tick();
  }
  // Stage B: removals, replacements and properties
  for (const f of live) {
    if (hooks.cancelled?.()) {
      cancelled = true;
      for (const rest of live.slice(live.indexOf(f))) skipped.push({ path: rest.path, reason: "cancelled" });
      break;
    }
    const lineEdits = f.edits.filter((e) => e.type === "replace");
    if (lineEdits.length) await run(f.path, lineEdits, okDeps);
    const props = f.edits.filter((e): e is PropEdit => e.type === "prop");
    if (props.length) {
      const cur = await io.read(f.path);
      if (cur === null || fingerprint(cur) !== expected.get(f.path)) {
        skipped.push({ path: f.path, reason: "stale" });
      } else {
        const values = props[0].values;
        await io.processFrontMatter(f.path, (fm) => {
          fm[propName] = mergePropValues(fm[propName], values);
        });
        appliedEdits += values.length;
      }
    }
    await tick();
  }

  // Record what each note looks like now, so an undo can tell whether it was edited afterwards
  const changed: string[] = [];
  const kept: BackupFile[] = [];
  for (const bf of files) {
    const cur = await io.read(bf.path);
    if (cur === null) continue;
    const post = fingerprint(cur);
    if (post === bf.pre) continue;
    bf.post = post;
    kept.push(bf);
    changed.push(bf.path);
  }
  record.files = kept;
  if (kept.length === 0) await io.deleteBackup(record.id);
  else await io.saveBackup(record);
  return { backupId: kept.length ? record.id : null, changed, appliedEdits, skipped, cancelled };
}

export interface UndoResult {
  restored: string[];
  skipped: { path: string; reason: SkipReason }[];
  /** Files that could not be restored (edited since); the record keeps them. */
  remaining: BackupFile[];
}

/** Restores the notes of a backup, but only those that still look exactly like they did right after the cleanup. */
export async function undoBackup(rec: BackupRecord, io: ApplyIO): Promise<UndoResult> {
  const restored: string[] = [];
  const skipped: { path: string; reason: SkipReason }[] = [];
  const remaining: BackupFile[] = [];
  for (const f of rec.files) {
    const cur = await io.read(f.path);
    if (cur === null) {
      skipped.push({ path: f.path, reason: "missing" });
      continue;
    }
    const fp = fingerprint(cur);
    if (fp === f.pre) {
      restored.push(f.path); // already back to the original
      continue;
    }
    if (f.post === null || fp !== f.post) {
      skipped.push({ path: f.path, reason: "edited" });
      remaining.push(f);
      continue;
    }
    let ok = false;
    await io.process(f.path, (data) => {
      ok = fingerprint(data) === f.post;
      return ok ? f.original : data;
    });
    if (ok) restored.push(f.path);
    else {
      skipped.push({ path: f.path, reason: "edited" });
      remaining.push(f);
    }
    await io.yieldToUi();
  }
  if (remaining.length === 0) await io.deleteBackup(rec.id);
  else await io.saveBackup({ ...rec, files: remaining });
  return { restored, skipped, remaining };
}
