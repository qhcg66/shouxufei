/* ============================================================
 * 抓取九期网“商品期货手续费一览表”（交易所标准保证金/手续费），
 * 生成 js/margins-9qihuo.js。
 * 作用：补全大商所等官网反爬、自动抓取不到的逐合约保证金，
 *       并作为全部合约月份的兜底列表。
 * 用法：node _tools/fetch-9qihuo.js
 * ============================================================ */
const https = require("https");
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const EXCH_MAP = {
  "上海期货交易所": "shfe",
  "大连商品交易所": "dce",
  "郑州商品交易所": "czce",
  "广州期货交易所": "gfex",
  "上海国际能源交易中心": "ine",
  "中国金融期货交易所": "cffex"
};
function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { headers: { "User-Agent": UA, "Referer": "https://www.9qihuo.com/", "Accept-Encoding": "gzip" }, timeout: 40000 }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        let buf = Buffer.concat(chunks);
        if ((res.headers["content-encoding"] || "").includes("gzip")) { try { buf = zlib.gunzipSync(buf); } catch (e) {} }
        resolve(buf.toString("utf8"));
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}
function text(html) { return String(html).replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim(); }
function pct(html) { const m = text(html).match(/([\d.]+)\s*%/); return m ? Number(m[1]) : null; }
function parseFee(html) {
  const t = text(html);
  if (/万分之/.test(t)) {
    const m = t.match(/([\d.]+)\s*\/\s*万分之/);
    return { type: "rate", value: m ? Number(m[1]) : null };
  }
  if (/免/.test(t)) return { type: "fixed", value: 0 };
  const m = t.match(/([\d.]+)\s*元/);
  return { type: "fixed", value: m ? Number(m[1]) : null };
}
(async () => {
  const html = await get("https://www.9qihuo.com/qihuoshouxufei");
  const tm = html.match(/<table[^>]*id="heyuetbl"[\s\S]*?<\/table>/i);
  if (!tm) { console.error("❌ 未找到行情表格"); process.exit(1); }
  const table = tm[0];
  const rows = table.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const out = {};
  const exchCount = {};
  let exch = "";
  let stamp = "";
  rows.forEach(row => {
    const nameLink = row.match(/class="jysname[^"]*"[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/i);
    if (nameLink) { exch = EXCH_MAP[nameLink[1].trim()] || ""; return; }
    if (/fee-thead/.test(row)) return;
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);
    if (cells.length < 10) return;
    const cm = cells[0].match(/<b>\s*([A-Za-z]+\d+)\s*<\/b>/);
    if (!cm) return;
    const code = cm[1].toLowerCase();
    const margin = pct(cells[3]);
    if (margin === null) return;
    const feeOpen = parseFee(cells[6]);
    const feePrev = parseFee(cells[7]);
    const feeToday = parseFee(cells[8]);
    if (!stamp) {
      const tm2 = row.match(/手续费更新时间：(\d{4}-\d{2}-\d{2})/);
      if (tm2) stamp = tm2[1];
    }
    const remark = text(cells[12] || "");
    const item = { m: margin, e: exch || undefined };
    if (/主力/.test(remark)) item.main = 1;
    if (feeOpen.value !== null) {
      item.fee = feeOpen.value; item.feeType = feeOpen.type;
      if (feePrev.value !== null && (feePrev.value !== feeOpen.value || feePrev.type !== feeOpen.type)) item.feePrev = feePrev.value;
      if (feeToday.value !== null) item.feeToday = feeToday.value;
    }
    if (item.e === undefined) delete item.e;
    out[code] = item;
    exchCount[exch] = (exchCount[exch] || 0) + 1;
  });
  const codes = Object.keys(out);
  if (!codes.length) { console.error("❌ 解析结果为空"); process.exit(1); }
  const lines = [];
  lines.push("/* 九期网：交易所标准保证金/手续费（逐合约，脚本自动生成，勿手改） */");
  lines.push("/* 数据日期：" + (stamp || "未知") + "；来源：https://www.9qihuo.com/qihuoshouxufei */");
  lines.push("var MARGIN_9QIHUO_DATE = " + JSON.stringify(stamp || "") + ";");
  lines.push("var MARGIN_9QIHUO = {");
  codes.sort().forEach((code, i) => {
    const v = out[code];
    const parts = ["m: " + v.m];
    if (v.e) parts.push("e: " + JSON.stringify(v.e));
    if (v.main) parts.push("main: 1");
    if (v.fee !== undefined) parts.push("fee: " + v.fee);
    if (v.feeType) parts.push("feeType: " + JSON.stringify(v.feeType));
    if (v.feePrev !== undefined) parts.push("feePrev: " + v.feePrev);
    if (v.feeToday !== undefined) parts.push("feeToday: " + v.feeToday);
    lines.push("  " + JSON.stringify(code) + ": {" + parts.join(", ") + "}" + (i < codes.length - 1 ? "," : ""));
  });
  lines.push("};");
  fs.writeFileSync(path.join(ROOT, "js", "margins-9qihuo.js"), lines.join("\n") + "\n", "utf8");
  console.log("✅ 已生成 js/margins-9qihuo.js，共 " + codes.length + " 个合约，数据日期 " + (stamp || "未知"));
  console.log("   各交易所：" + Object.keys(exchCount).map(k => (k || "未知") + " " + exchCount[k]).join("；"));
})();
