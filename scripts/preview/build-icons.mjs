// 从 lucide 包里抽出看板用到的图标，生成预览用的 icons.json（只在本地预览时运行）
// node scripts/preview/build-icons.mjs <lucide 包的 dist/esm/icons 目录>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.argv[2];
const names = ["alarm-clock","calendar-days","calendar-range","check","chevron-down","chevron-right","chevron-up","circle-help","clock","coffee","files","flame","folder","heart-pulse","history","layout-dashboard","line-chart","list-checks","list-todo","notebook-pen","party-popper","pencil","refresh-cw","settings","sparkles","tag","trending-up","type","x","lightbulb","calendar-clock","alert-triangle"];
// Obsidian 认旧名，lucide 新版改了名
const alias = { "line-chart": "chart-line", "alert-triangle": "triangle-alert" };
const out = {};
for (const n of names) {
  let src;
  try { src = readFileSync(join(dir, `${alias[n] ?? n}.js`), "utf8"); } catch { console.warn("missing", n); continue; }
  const body = src.slice(src.indexOf("["), src.lastIndexOf("];") + 1);
  const arr = Function(`"use strict"; const defaultAttributes = {}; return ${body};`)();
  const kids = arr[2].map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(" ")}/>`).join("");
  out[n] = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon lucide-${n}">${kids}</svg>`;
}
writeFileSync(new URL("./icons.json", import.meta.url), JSON.stringify(out));
console.log(Object.keys(out).length, "icons");
