/* ============================================================
 * 抓取东方财富全部期货合约列表（代码/名称/最新价/成交量），
 * 生成 js/contracts-snapshot.js，供网页在直连行情接口
 * 失败或被限流时同源兜底，确保合约月份仍然能展开。
 * 由 GitHub Actions 每日定时运行；也可本地：
 *   node _tools/fetch-contracts.js
 * ============================================================ */
const https = require("https");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const HOSTS = ["push2delay.eastmoney.com", "push2.eastmoney.com", "82.push2delay.eastmoney.com"];
const MARKETS = [
  { id: "shfe",  market: "113" },
  { id: "czce",  market: "115" },
  { id: "dce",   market: "114" },
  { id: "gfex",  market: "225" },
  { id: "ine",   market: "142" },
  { id: "cffex", market: "220" }
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { headers: { "User-Agent": UA, "Accept": "*/*" }, timeout: 20000 }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}
async function page(market, pn) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const host = HOSTS[(pn + attempt) % HOSTS.length];
    try {
      const r = await get("https://" + host + "/api/qt/clist/get?pn=" + pn + "&pz=100&po=1&np=1&fltt=2&invt=2&fid=f5&fs=m:" + market + "&fields=f12,f14,f2,f5");
      if (r.status !== 200) throw new Error("status " + r.status);
      const j = JSON.parse(r.text);
      if (!j || !j.data || !j.data.diff || !j.data.diff.length) throw new Error("empty");
      return { total: j.data.total || j.data.diff.length, list: j.data.diff };
    } catch (e) {
      await sleep(800 * (attempt + 1));
    }
  }
  return { total: 0, list: [], failed: true };
}
async function fetchMarket(mk) {
  const first = await page(mk.market, 1);
  if (!first.list.length) return null;
  const out = [];
  const seen = {};
  const push = d => { const c = String(d.f12 || ""); if (c && !seen[c]) { seen[c] = 1; out.push(d); } };
  first.list.forEach(push);
  const pages = Math.min(Math.ceil((first.total || first.list.length) / 100), 8);
  for (let p = 2; p <= pages; p++) {
    const r = await page(mk.market, p);
    r.list.forEach(push);
    await sleep(300);
  }
  return out;
}
function readOld() {
  try {
    const txt = fs.readFileSync(path.join(ROOT, "js", "contracts-snapshot.js"), "utf8");
    const m = txt.match(/var CONTRACTS_SNAPSHOT\s*=\s*(\{[\s\S]*\});\s*$/);
    return m ? JSON.parse(m[1]) : null;
  } catch (e) { return null; }
}
(async () => {
  const old = readOld();
  const list = Object.assign({}, (old && old.list) || {});
  const doneMarkets = {};
  for (const mk of MARKETS) {
    const rows = await fetchMarket(mk);
    if (!rows) { console.log("ℹ️  " + mk.id + " 抓取失败，保留旧数据"); continue; }
    doneMarkets[mk.id] = rows.length;
    Object.keys(list).forEach(code => { if (list[code] && list[code].e === mk.id) delete list[code]; });
    rows.forEach(d => {
      const code = String(d.f12 || "").toLowerCase();
      if (!code || !/\d/.test(code)) return;                 // 跳过主连/指数
      const name = String(d.f14 || "");
      if (/主连|次主连|连续|指数/.test(name)) return;
      list[code] = { n: name, p: Number(d.f2) || 0, v: Number(d.f5) || 0, e: mk.id };
    });
    console.log("✅ " + mk.id + "：" + rows.length + " 条");
    await sleep(400);
  }
  if (!Object.keys(doneMarkets).length) {
    console.error("❌ 全部市场抓取失败，保留原文件不覆盖");
    process.exit(1);
  }
  const now = new Date();
  const stamp = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0") + " " +
    String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
  const lines = [];
  lines.push("/* 东方财富全部期货合约快照（自动生成，勿手改） */");
  lines.push("/* 生成时间：" + stamp + "；用途：行情接口被限流时同源兜底 */");
  lines.push("var CONTRACTS_SNAPSHOT = " + JSON.stringify({ time: stamp, list: list }) + ";");
  fs.writeFileSync(path.join(ROOT, "js", "contracts-snapshot.js"), lines.join("\n") + "\n", "utf8");
  console.log("✅ 已生成 js/contracts-snapshot.js，共 " + Object.keys(list).length + " 个合约");
})();
