import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CHART_STYLES, sanitizeChartStyles } from "../src/chart-styles";

test("图表样式：缺失、不认识、类型不对的换成默认；认识的保留", () => {
  assert.deepEqual(sanitizeChartStyles(undefined), DEFAULT_CHART_STYLES);
  assert.deepEqual(sanitizeChartStyles("x"), DEFAULT_CHART_STYLES);
  const s = sanitizeChartStyles({ trend: "area", rhythm: "pie", mix: "donut", tags: 7, lengths: "area", extra: 1 });
  assert.deepEqual(s, { trend: "area", rhythm: "bar", mix: "donut", tags: "bars", lengths: "area" });
  assert.deepEqual(sanitizeChartStyles({ trend: "curve", rhythm: "line", mix: "list", tags: "cloud", lengths: "bar" }), { trend: "curve", rhythm: "line", mix: "list", tags: "cloud", lengths: "bar" });
});
