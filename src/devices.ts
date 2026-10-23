/* 多设备计数：每台设备只写自己的记录文件，看板把所有设备的记录相加（不会互相覆盖，也不会重复计数） */

/** 一台设备的每日新增字数 */
export interface DeviceLog {
  /** 设备名，显示在设置里 */
  name: string;
  /** 日期 -> 当日新增字数（普通笔记） */
  wordLog: Record<string, number>;
  /** 日期 -> 当日新增字数（超大笔记） */
  wordLogBig: Record<string, number>;
  /** 最后一次写入的时间戳 */
  updated: number;
}

export function emptyDeviceLog(name: string): DeviceLog {
  return { name, wordLog: {}, wordLogBig: {}, updated: 0 };
}

/** 读到的记录文件可能来自别的版本或被同步弄坏：只保留合法的数字 */
export function normalizeDeviceLog(raw: unknown, fallbackName: string): DeviceLog | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const days = (v: unknown): Record<string, number> => {
    const out: Record<string, number> = {};
    if (!v || typeof v !== "object") return out;
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(k) && typeof n === "number" && Number.isFinite(n) && n > 0) out[k] = Math.round(n);
    }
    return out;
  };
  return {
    name: typeof r.name === "string" && r.name.trim() ? r.name.trim() : fallbackName,
    wordLog: days(r.wordLog),
    wordLogBig: days(r.wordLogBig),
    updated: typeof r.updated === "number" && Number.isFinite(r.updated) ? r.updated : 0,
  };
}

/** 把几份按日期的记录相加 */
export function sumLogs(logs: Record<string, number>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const log of logs) for (const [k, v] of Object.entries(log)) out[k] = (out[k] || 0) + v;
  return out;
}

/** 设备 ID：只用字母数字，作为文件名 */
export function newDeviceId(random: () => number = Math.random): string {
  let s = "";
  for (let i = 0; i < 12; i++) s += "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(random() * 36)];
  return s;
}

export function isDeviceId(id: unknown): id is string {
  return typeof id === "string" && /^[a-z0-9]{6,32}$/.test(id);
}

/**
 * 同一台设备的两份记录（设备文件和 data.json 里的副本，或者内存和磁盘）合在一起：
 * 每台设备的记录只增不减，所以按天取较大值就是最新的；名字取更新时间较新的那份。
 * 取最大值和次序无关、重复做也不变，哪份先同步到都不会算错。
 */
export function mergeDeviceLog(a: DeviceLog | null | undefined, b: DeviceLog | null | undefined): DeviceLog | null {
  if (!a) return b ?? null;
  if (!b) return a;
  const max = (x: Record<string, number>, y: Record<string, number>) => {
    const out = { ...x };
    for (const [k, v] of Object.entries(y)) out[k] = Math.max(out[k] || 0, v);
    return out;
  };
  const newer = b.updated > a.updated ? b : a;
  return { name: newer.name, wordLog: max(a.wordLog, b.wordLog), wordLogBig: max(a.wordLogBig, b.wordLogBig), updated: Math.max(a.updated, b.updated) };
}
