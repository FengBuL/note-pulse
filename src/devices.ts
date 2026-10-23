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
