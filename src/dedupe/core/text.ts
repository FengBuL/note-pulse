/* Pure text utilities: normalisation, hashing, URL handling. No Obsidian imports, so everything here runs in plain Node for tests. */

/** Han, kana and Hangul: scripts written without spaces between words. */
const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const CJK_RANGE = "\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af";
const CJK_SPACE_AFTER = new RegExp(`([${CJK_RANGE}]) +`, "g");
const CJK_SPACE_BEFORE = new RegExp(` +(?=[${CJK_RANGE}])`, "g");

/** cyrb53: fast, well-distributed 53-bit string hash. */
export function hash53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Fingerprint of a string: length plus hash, so accidental collisions need both to match. */
export function fingerprint(s: string): string {
  return `${s.length.toString(36)}.${hash53(s).toString(36)}`;
}

/** Query parameters that only track where a link was clicked, never what it points to. */
const TRACKING_PARAMS = new Set([
  "fbclid", "gclid", "dclid", "msclkid", "yclid", "igshid", "igsh", "mc_cid", "mc_eid", "ref", "ref_src", "ref_url",
  "si", "spm", "share_source", "share_medium", "share_id", "s", "t", "feature", "cmpid", "_hsenc", "_hsmi", "mkt_tok",
  "xhsshare", "app_platform", "vd_source",
]);
const TWITTER_HOST = /(?:^|\.)(?:twitter|x|fxtwitter|vxtwitter|fixupx)\.com$/;

/** Trailing characters that belong to the sentence around a URL, not to the URL. */
const URL_TAIL = /[.,;:!?)\]}>*_~'"，。；：！？）】》”’]+$/;

export function normalizeUrl(raw: string): string {
  const cleaned = raw.replace(URL_TAIL, "");
  try {
    const u = new URL(cleaned);
    let host = u.hostname.toLowerCase().replace(/^www\./, "");
    const isTwitter = TWITTER_HOST.test(host);
    if (isTwitter) host = "x.com";
    const params: [string, string][] = [];
    if (!isTwitter) {
      u.searchParams.forEach((v, k) => {
        const key = k.toLowerCase();
        if (key.startsWith("utm_") || TRACKING_PARAMS.has(key)) return;
        params.push([k, v]);
      });
      params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    }
    let path = u.pathname.replace(/\/+$/, "");
    if (isTwitter) path = path.replace(/^\/[\w.-]+\/status(?:es)?\//, "/status/").replace(/^\/i\/web\//, "/");
    const q = params.length ? "?" + params.map(([k, v]) => `${k}=${v}`).join("&") : "";
    return `${host}${path}${q}`.toLowerCase();
  } catch {
    return cleaned.toLowerCase();
  }
}

const STATUS_RE = /(?:x|twitter|fxtwitter|vxtwitter|fixupx)\.com\/(?:[\w.-]+\/)+?status(?:es)?\/(\d{5,25})/gi;

/** All distinct X/Twitter status IDs referenced in a piece of text, sorted. */
export function extractStatusIds(raw: string): string[] {
  const ids = new Set<string>();
  STATUS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STATUS_RE.exec(raw)) !== null) ids.add(m[1]);
  return Array.from(ids).sort();
}

const URL_RE = /https?:\/\/[^\s<>"'`\u3000]+/gi;
const MD_LINK_RE = /!?\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const WIKI_RE = /!?\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g;
const BLOCK_ID_RE = /\s*\^[A-Za-z0-9-]+\s*$/;

/** Trailing Obsidian block id (`^abc`) of a line, if any. */
export function trailingBlockId(line: string): string | null {
  const m = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/.exec(line);
  return m ? m[1] : null;
}

/**
 * Turns the Markdown of one block into a canonical string: markup stripped, links reduced to their text and cleaned URLs,
 * case folded, whitespace collapsed (including line wraps inside CJK text). Two blocks that read the same normalise the same.
 */
export function normalizeText(raw: string): string {
  const s = raw.normalize("NFKC").replace(/[\u200b-\u200d\u2060\ufeff\u00ad]/g, "");
  const out: string[] = [];
  for (const rawLine of s.split("\n")) {
    let line = rawLine.replace(/\r$/, "");
    line = line.replace(BLOCK_ID_RE, "");
    line = line.replace(/^\s*(?:>\s?)+/, "");
    line = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX\-/>!?]\]\s+)?/, "");
    line = line.replace(/^\s*#{1,6}\s+/, "");
    // Rank columns ("| 3 | ...") change from run to run while the row itself is the same
    line = line.replace(/^\s*\|\s*#?\d{1,4}\s*\|/, "|");
    // Table delimiter rows and horizontal rules carry no content
    if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-")) continue;
    out.push(line);
  }
  let t = out.join("\n");
  t = t.replace(MD_LINK_RE, (_m, text: string, url: string) => `${text} ${/^https?:/i.test(url) ? normalizeUrl(url) : url}`);
  t = t.replace(WIKI_RE, (_m, target: string, alias: string | undefined) => (alias ? alias : target.replace(/#\^?.*$/, "") || target));
  t = t.replace(URL_RE, (u) => {
    const tail = URL_TAIL.exec(u);
    return normalizeUrl(u) + (tail ? tail[0] : "");
  });
  t = t.replace(/<\/?[a-zA-Z][^>]*>/g, " ");
  t = t.replace(/\\([\\`*_{}[\]()#+\-.!|~=>])/g, "$1");
  t = t.replace(/\*+|~~|==|`+/g, "");
  t = t.replace(/(^|[\s(])_+|_+(?=[\s).,;:!?]|$)/g, "$1");
  t = t.replace(/\|/g, " ");
  t = t.replace(/\s+/g, " ").trim().toLowerCase();
  // A soft line wrap next to CJK text leaves a space that the unwrapped version does not have
  t = t.replace(CJK_SPACE_AFTER, "$1").replace(CJK_SPACE_BEFORE, "");
  return t;
}

/** Length with CJK characters counted double: one Han character carries roughly two Latin characters of information. */
export function weightedLength(norm: string): number {
  let n = 0;
  for (let i = 0; i < norm.length; i++) n += CJK_CHAR.test(norm[i]) ? 2 : 1;
  return n;
}

/** Word count in the style of Obsidian: each CJK character is a word, other text is split on whitespace. */
export function countWords(norm: string): number {
  let cjk = 0;
  let rest = "";
  for (let i = 0; i < norm.length; i++) {
    if (CJK_CHAR.test(norm[i])) {
      cjk++;
      rest += " ";
    } else rest += norm[i];
  }
  const latin = rest.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return cjk + latin;
}

/** True when a block has no readable text once every link, embed and URL is removed. */
export function isLinkOnly(raw: string): boolean {
  let t = raw.replace(MD_LINK_RE, " ").replace(WIKI_RE, " ").replace(URL_RE, " ");
  t = t.replace(/^\s*(?:>\s?)*(?:[-*+]|\d+[.)])?\s*(?:\[[ xX]\]\s*)?/gm, "");
  return !/[\p{L}\p{N}]/u.test(t);
}

/** Strips the trailing block id from raw text, used when re-hashing a block. */
export function stripBlockId(line: string): string {
  return line.replace(BLOCK_ID_RE, "");
}

/** Fingerprint of a block's normalised text, computed from its raw lines. */
export function blockFingerprint(lines: string[]): string {
  return fingerprint(normalizeText(lines.join("\n")));
}
