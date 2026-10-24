// Browser-compatibility check for styles.css (the same idea as the directory's CSS review). Usage: node scripts/check-css.cjs styles.css
const fs = require("fs");
const postcss = require("postcss");
const doiuse = require("doiuse");
const file = process.argv[2] || "styles.css";
const css = fs.readFileSync(file, "utf8");
if (/!important/.test(css)) {
  console.log("!important found");
  process.exit(1);
}
// 目录的 CSS 审查还会报：同一条规则里重复写同一个属性（比如 max-height 先写 vh 再写 dvh）、使用 :has（选择器失效范围大，影响性能）
const bad = [];
postcss.parse(css, { from: file }).walkRules((rule) => {
  if (/:has\(/.test(rule.selector)) bad.push(`${rule.source.start.line}: 不要用 :has — ${rule.selector}`);
  const seen = new Map();
  rule.each((d) => {
    if (d.type !== "decl" || d.prop.startsWith("--")) return;
    if (seen.has(d.prop)) bad.push(`${d.source.start.line}: 重复的属性 ${d.prop}（第 ${seen.get(d.prop)} 行也写了）`);
    else seen.set(d.prop, d.source.start.line);
  });
});
if (bad.length) {
  bad.forEach((b) => console.log(b));
  console.log(`css lint problems: ${bad.length}`);
  process.exit(1);
}
postcss(doiuse({ browsers: ["chrome >= 128", "ios_saf >= 16.4", "android >= 128"] }))
  .process(css, { from: file })
  .then((r) => {
    const w = r.warnings();
    console.log(`css compatibility warnings: ${w.length}`);
    w.forEach((x) => console.log(`${x.line}: ${x.text}`));
    process.exit(w.length ? 1 : 0);
  });
