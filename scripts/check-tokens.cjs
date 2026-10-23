// 看板样式令牌检查：npm run check:tokens
// 规则：在 /* tokens:end */ 与 /* dashboard:end */ 之间，字号、圆角、阴影、时长只能引用令牌（var(--vp-…)），不能直接写数值。
const fs = require("fs");
const css = fs.readFileSync(process.argv[2] || "styles.css", "utf8");
const start = css.indexOf("/* tokens:end */");
const end = css.indexOf("/* dashboard:end */");
if (start < 0 || end < 0) {
  console.log("缺少 tokens:end 或 dashboard:end 标记");
  process.exit(1);
}
const body = css.slice(start, end);
const lineOf = (i) => css.slice(0, start + i).split("\n").length;
const ok = {
  "font-size": (v) => /^var\(--vp-fs-\d+\)$/.test(v),
  "border-radius": (v) => v.split(/\s+/).every((x) => /^var\(--vp-r-[a-z]+\)$/.test(x) || x === "50%" || x === "inherit" || x === "0"),
  // 阴影：令牌，或者只用 1px 线和令牌颜色组成的描边
  "box-shadow": (v) => v === "none" || v.split(/,\s*(?![^(]*\))/).every((x) => /^var\(--vp-[a-z-]+\)$/.test(x) || /^0 -?[01]px 0( 1px)? var\(--vp-[a-z-]+\)$/.test(x) || /^0 0 0 1px var\(--vp-[a-z-]+\)$/.test(x)),
};
const bad = [];
for (const m of body.matchAll(/([a-z-]+):\s*([^;{}]+)(?=[;}])/g)) {
  const [, prop, raw] = m;
  const v = raw.trim();
  if (ok[prop] && !ok[prop](v)) bad.push(`${lineOf(m.index)}: ${prop} 没有使用令牌 → ${v}`);
  if ((prop === "transition" || prop === "animation") && /\b\d+(?:\.\d+)?m?s\b/.test(v)) bad.push(`${lineOf(m.index)}: ${prop} 时长没有使用令牌 → ${v}`);
}
const sizes = new Set([...body.matchAll(/var\((--vp-fs-\d+)\)/g)].map((m) => m[1]));
console.log(`token check: ${bad.length} problems, ${sizes.size} font sizes in use`);
bad.forEach((b) => console.log(b));
process.exit(bad.length ? 1 : 0);
