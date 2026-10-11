/* ============================================================
 * 保证金 / 手续费数据更新脚本
 * 用法：node _src/update-margins.js
 * 数据来源（各交易所官方"结算参数/交易参数"）：
 *   上期所 SHFE  https://www.shfe.com.cn/data/tradedata/future/dailydata/jsYYYYMMDD.dat
 *   能源中心 INE https://www.ine.cn/data/tradedata/future/dailydata/jsYYYYMMDD.dat
 *   郑商所 CZCE  http://www.czce.com.cn/cn/DFSStaticFiles/Future/YYYY/YYYYMMDD/FutureDataClearParams.txt
 *   广期所 GFEX  http://www.gfex.com.cn/u/interfacesWebTtQueryTradPara/loadDayList  (POST trade_type=0)
 *   中金所 CFFEX http://www.cffex.com.cn/sj/jscs/YYYYMM/DD/YYYYMMDD_1.csv （从 /cn/jscs.html 找最新）
 * 大连商品交易所(DCE) 官网对非浏览器客户端返回 412（反爬），暂无法自动抓取。
 * 生成：js/margins-data.js —— 逐合约真实保证金（含部分交易所手续费）
 * ============================================================ */
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function request(url, opt) {
  opt = opt || {};
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const body = opt.body || null;
    const headers = Object.assign({
      "User-Agent": UA,
      "Accept": "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9",
      "Referer": new URL(url).origin + "/"
    }, opt.headers || {});
    if (body) { headers["Content-Type"] = headers["Content-Type"] || "application/json"; headers["Content-Length"] = Buffer.byteLength(body); }
    const req = mod.request(url, { method: opt.method || "GET", headers, timeout: opt.timeout || 20000, rejectUnauthorized: false }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && (opt.redirects || 0) < 5) {
        const next = res.headers.location.startsWith("http") ? res.headers.location : new URL(res.headers.location, url).href;
        res.resume();
        return request(next, Object.assign({}, opt, { redirects: (opt.redirects || 0) + 1 })).then(resolve, reject);
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    if (body) req.write(body);
    req.end();
  });
}
const asText = r => r.buf.toString("utf8");
const asLatin = r => r.buf.toString("latin1");

function recentDates(n) {
  const out = [];
  const now = new Date();
  for (let i = 0; out.length < n && i < 16; i++) {
    const d = new Date(now.getTime() - i * 86400000);
    const w = d.getDay();
    if (w === 0 || w === 6) continue;
    out.push(d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0"));
  }
  return out;
}

/* ---------- 上期所 / 能源中心：结算参数 .dat ---------- */
async function fetchShfe(host) {
  for (const date of recentDates(6)) {
    try {
      const r = await request(host + "/data/tradedata/future/dailydata/js" + date + ".dat");
      if (r.status !== 200) continue;
      const j = JSON.parse(asText(r));
      const rows = j.o_cursor || [];
      if (rows.length) return { date, rows };
    } catch (e) { /* 下一个日期 */ }
  }
  return null;
}
function mapShfe(rows) {
  const out = {};
  rows.forEach(r => {
    const code = String(r.INSTRUMENTID || "").toLowerCase();
    if (!code) return;
    const spec = Number(r.SPECLONGMARGINRATIO);
    const hedge = Number(r.HEDGLONGMARGINRATIO);
    if (!isFinite(spec)) return;
    out[code] = { m: round2(spec * 100), h: isFinite(hedge) ? round2(hedge * 100) : undefined };
  });
  return out;
}

/* ---------- 郑商所：结算参数 txt（| 分隔） ---------- */
async function fetchCzce() {
  for (const date of recentDates(6)) {
    try {
      const url = "http://www.czce.com.cn/cn/DFSStaticFiles/Future/" + date.slice(0, 4) + "/" + date + "/FutureDataClearParams.txt";
      const r = await request(url);
      if (r.status !== 200) continue;
      const txt = asText(r);
      if (txt.indexOf("结算参数") < 0) continue;
      const out = {};
      txt.split(/\r?\n/).forEach(line => {
        const p = line.split("|").map(s => s.trim());
        const code = (p[0] || "").toUpperCase();
        if (!/^[A-Z]{1,3}\d{3,4}$/.test(code)) return;
        const margin = Number(p[4]);
        if (!isFinite(margin) || margin <= 0) return;
        const feeRaw = p[6], feeType = p[7] || "", closeTodayFeeRaw = p[9];
        const fee = Number(String(feeRaw).replace(/,/g, ""));
        const closeTodayFee = Number(String(closeTodayFeeRaw).replace(/,/g, ""));
        out[code.toLowerCase()] = {
          m: round2(margin),
          feeType: /比例/.test(feeType) ? "rate" : "fixed",
          fee: isFinite(fee) ? fee : undefined,
          feeToday: isFinite(closeTodayFee) ? closeTodayFee : undefined
        };
      });
      if (Object.keys(out).length) return { date, map: out };
    } catch (e) { /* 下一个日期 */ }
  }
  return null;
}

/* ---------- 广期所：日结算参数接口 ---------- */
async function fetchGfex() {
  try {
    const r = await request("http://www.gfex.com.cn/u/interfacesWebTtQueryTradPara/loadDayList", {
      method: "POST",
      body: JSON.stringify({ trade_type: "0" })
    });
    if (r.status !== 200) return null;
    const j = JSON.parse(asText(r));
    if (j.code !== "0" || !Array.isArray(j.data)) return null;
    const out = {};
    j.data.forEach(it => {
      const code = String(it.contractId || "").toLowerCase();
      if (!code || code.indexOf("-") >= 0) return;
      const spec = Number(it.specBuyRate);
      if (!isFinite(spec)) return;
      out[code] = { m: round2(spec * 100), h: isFinite(Number(it.hedgeBuyRate)) ? round2(Number(it.hedgeBuyRate) * 100) : undefined };
    });
    return Object.keys(out).length ? { date: "latest", map: out } : null;
  } catch (e) { return null; }
}

/* ---------- 中金所：结算参数 csv（从页面找最新日期） ---------- */
async function fetchCffex() {
  try {
    const page = await request("http://www.cffex.com.cn/cn/jscs.html");
    if (page.status !== 200) return null;
    const html = asText(page);
    const links = [...html.matchAll(/\/sj\/jscs\/(\d{6})\/(\d{2})\/(\d{8})_1\.csv/g)];
    if (!links.length) return null;
    const latest = links[0];
    const date = latest[3];
    const r = await request("http://www.cffex.com.cn/sj/jscs/" + latest[1] + "/" + latest[2] + "/" + date + "_1.csv");
    if (r.status !== 200) return null;
    const txt = asLatin(r);   // 中金所文件为 GBK，但需要解析的字段都是 ASCII
    const out = {};
    txt.split(/\r?\n/).forEach(line => {
      const p = line.split(",");
      const code = (p[0] || "").trim();
      if (!/^[A-Z]{1,3}\d{3,4}$/.test(code)) return;
      const m = parseFloat(String(p[1]).replace("%", ""));
      if (!isFinite(m)) return;
      out[code.toLowerCase()] = { m: round2(m) };
    });
    return Object.keys(out).length ? { date, map: out } : null;
  } catch (e) { return null; }
}

function round2(x) { return Math.round(x * 100) / 100; }

/* ---------- 大商所：官网有 WAF，尝试抓取（失败则跳过，不影响其它交易所） ---------- */
async function tryDce() {
  const urls = [
    { url: "http://www.dce.com.cn/dcereport/publicweb/tradepara/contractInfo", method: "POST", body: JSON.stringify({ lang: "zh", tradeType: "1", varietyId: "all" }) },
    { url: "http://www.dce.com.cn/dcereport/publicweb/tradepara/dayTradePara", method: "POST", body: JSON.stringify({ lang: "zh", tradeType: "1", varietyId: "all" }) }
  ];
  for (const it of urls) {
    try {
      const r = await request(it.url, { method: it.method, body: it.body, timeout: 12000 });
      if (r.status === 200) {
        const txt = asText(r);
        if (txt.trim().startsWith("{")) {
          const j = JSON.parse(txt);
          const list = j.data || j.Data || [];
          const out = {};
          list.forEach(x => {
            const code = String(x.contractId || x.contractID || "").toLowerCase();
            const m = Number(x.specBuyRate || x.specMarginRate || x.marginRate);
            if (code && isFinite(m)) out[code] = { m: round2(m > 1 ? m : m * 100) };
          });
          if (Object.keys(out).length) return { map: out };
        }
      }
    } catch (e) { /* 继续尝试下一个 */ }
  }
  return null;
}

/* ---------- 读取上一次生成的数据（用于抓取失败时沿用） ---------- */
function readExisting(){
  try{
    const txt = fs.readFileSync(path.join(ROOT, "js", "margins-data.js"), "utf8");
    const m = txt.match(/var MARGIN_LIVE\s*=\s*(\{[\s\S]*?\});/);
    return m ? JSON.parse(m[1]) : {};
  }catch(e){ return {}; }
}
function readExistingSources(){
  try{
    const txt = fs.readFileSync(path.join(ROOT, "js", "margins-data.js"), "utf8");
    const m = txt.match(/var MARGIN_LIVE_SOURCES\s*=\s*(\[[^\]]*\]);/);
    return m ? JSON.parse(m[1]) : [];
  }catch(e){ return []; }
}
/* 品种代码前缀 -> 交易所 id（从 js/data.js 读取） */
function readVarietyExchange(){
  const map = {};
  try{
    const txt = fs.readFileSync(path.join(ROOT, "js", "data.js"), "utf8");
    const re = /code:"([A-Za-z]+)\d+"\s*,\s*exch:"([a-z]+)"/g;
    let m;
    while((m = re.exec(txt))) map[m[1].toLowerCase()] = m[2];
  }catch(e){}
  return map;
}

/* ---------- 主流程 ---------- */
(async () => {
  const result = {};
  const sources = [];
  const fresh = {};                 // 本次抓取成功的交易所 id -> 数据日期
  const shfe = await fetchShfe("https://www.shfe.com.cn");
  if (shfe) { Object.assign(result, mapShfe(shfe.rows)); fresh.shfe = shfe.date; sources.push("上期所 " + shfe.date); }
  const ine = await fetchShfe("https://www.ine.cn");
  if (ine) { Object.assign(result, mapShfe(ine.rows)); fresh.ine = ine.date; sources.push("能源中心 " + ine.date); }
  const czce = await fetchCzce();
  if (czce) { Object.assign(result, czce.map); fresh.czce = czce.date; sources.push("郑商所 " + czce.date); }
  const gfex = await fetchGfex();
  if (gfex) { Object.assign(result, gfex.map); fresh.gfex = gfex.date; sources.push("广期所 " + gfex.date); }
  const cffex = await fetchCffex();
  if (cffex) { Object.assign(result, cffex.map); fresh.cffex = cffex.date; sources.push("中金所 " + cffex.date); }
  const dce = await tryDce();
  if (dce) { Object.assign(result, dce.map); fresh.dce = "已接入"; sources.push("大商所 已接入"); }
  else { console.log("ℹ️  大商所：官网返回 412（WAF 反爬），本次沿用上次数据；手工填写 js/margin-manual.js 仍然生效。"); }

  /* 抓取失败的交易所：沿用上次生成的数据，避免一次网络波动清空整所 */
  const oldAll = readExisting();
  const oldSources = readExistingSources();
  const varietyExch = readVarietyExchange();
  const carried = {};
  Object.keys(oldAll).forEach(code => {
    const key = String(code).replace(/\d.*$/, "");
    const ex = varietyExch[key];
    if (!ex || fresh[ex]) return;    // 本次成功的交易所，用新数据覆盖
    carried[code] = oldAll[code];    // 本次失败的交易所，保留旧数据
  });
  Object.keys(carried).forEach(code => { if (!(code in result)) result[code] = carried[code]; });
  const labels = { shfe: "上期所", ine: "能源中心", czce: "郑商所", gfex: "广期所", cffex: "中金所", dce: "大商所" };
  Object.keys(labels).forEach(id => {
    if (fresh[id]) return;
    const prev = oldSources.filter(s => String(s).indexOf(labels[id]) === 0)[0];
    if (prev) sources.push(prev + "（沿用）");
  });

  if (!Object.keys(result).length) { console.error("❌ 所有数据源都抓取失败，且没有可沿用的历史数据"); process.exit(1); }

  const lines = [];
  lines.push("/* ============================================================");
  lines.push(" * 逐合约真实保证金（交易所官方结算参数，脚本自动生成，勿手改）");
  lines.push(" * 数据来源：" + sources.join("；"));
  lines.push(" * 由 update-margins.js 自动生成（GitHub Actions 每日定时更新）。");
  lines.push(" * 字段：m=投机保证金%, h=套保保证金%, fee=手续费, feeType=fixed|rate, feeToday=平今手续费");
  lines.push(" * 说明：标注“沿用”的交易所表示本次抓取失败，保留上一次成功数据；大商所由九期网数据补全。");
  lines.push(" * ============================================================ */");
  const today = new Date();
  lines.push("var MARGIN_LIVE_DATE = \"" + today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0") + "\";");
  lines.push("var MARGIN_LIVE_SOURCES = " + JSON.stringify(sources) + ";");
  lines.push("var MARGIN_LIVE = {");
  const codes = Object.keys(result).sort();
  codes.forEach((code, i) => {
    const v = result[code];
    const parts = ["m: " + v.m];
    if (v.h !== undefined) parts.push("h: " + v.h);
    if (v.fee !== undefined) parts.push("fee: " + v.fee);
    if (v.feeType) parts.push("feeType: " + JSON.stringify(v.feeType));
    if (v.feeToday !== undefined) parts.push("feeToday: " + v.feeToday);
    lines.push("  " + JSON.stringify(code) + ": {" + parts.join(", ") + "}" + (i < codes.length - 1 ? "," : ""));
  });
  lines.push("};");
  fs.writeFileSync(path.join(ROOT, "js", "margins-data.js"), lines.join("\n") + "\n", "utf8");

  console.log("✅ 已生成 js/margins-data.js，共 " + codes.length + " 个合约");
  console.log("   数据源：" + sources.join("；"));
  const ex = {};
  Object.keys(result).forEach(c => { const k = c.replace(/\d.*$/, ""); ex[k] = (ex[k] || 0) + 1; });
  console.log("   品种：" + Object.keys(ex).sort().join(" "));
})();
