// PopDEX x Variational FR monitor - headless version (GitHub Actions or PC). No dependencies, Node 18+.
// Checks the "relatively safe" pairs, sends entry/exit instructions to Telegram, and accepts commands from Telegram.
//
//   node monitor.js            run once (GitHub Actions)
//   node monitor.js --loop     run every 60 s (keep it running on a PC)
//   node monitor.js --chatid   print the chat id of whoever messaged the bot (setup helper)
//
// Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID. Without them, messages are printed instead of sent.
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'state.json');
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const POPDEX = 'https://api.popdex.xyz/api/v1/public';
const VARIATIONAL = 'https://omni-client-api.prod.ap-northeast-1.variational.io/metadata/stats';
const POP_INTERVAL_H = 1;

const DEFAULT_SETTINGS = {
  balPop: 100, balV: 100, lev: 3, takerBps: 3.2,
  minDiff: 0.02,   // %/24h needed for an entry instruction
  maxDays: 7,      // break-even days needed for an entry instruction
  maxGap: 0.1,     // tolerated unfavorable price gap, %
  exitHours: 4,    // spread negative this long -> exit instruction
  cooldownMin: 60, // same entry instruction is not repeated within this window
};

// same "relatively safe" set as the dashboard; swaps are skipped (their rates are not in the public API)
const SAFE = {
  XAUUSDT:     { label: 'GOLD',  maxLev: 5, market: 'metal',  v: 'XAU' },
  XAGUSDT:     { label: '銀',    maxLev: 3, market: 'metal',  v: 'XAG' },
  BTCUSDT:     { label: 'BTC',   maxLev: 3, market: 'crypto', v: 'BTC' },
  ETHUSDT:     { label: 'ETH',   maxLev: 3, market: 'crypto', v: 'ETH' },
  QQQUSDT:     { label: 'QQQ',   maxLev: 5, market: 'us',     v: 'QQQ' },
};
const LABEL_ALIASES = { GOLD: 'XAUUSDT', XAU: 'XAUUSDT', 金: 'XAUUSDT', 銀: 'XAGUSDT', XAG: 'XAGUSDT', SILVER: 'XAGUSDT', BTC: 'BTCUSDT', ETH: 'ETHUSDT', QQQ: 'QQQUSDT' };

// ---------- state ----------
function loadState() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8').replace(/^﻿/, '')); } catch {} // tolerate BOM from Windows editors
  return {
    settings: { ...DEFAULT_SETTINGS, ...(s.settings || {}) },
    positions: s.positions || [], history: s.history || [],
    pairState: s.pairState || {}, notifyLast: s.notifyLast || {}, tgOffset: s.tgOffset || 0,
  };
}
const saveState = st => fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2) + '\n');

// ---------- helpers ----------
const num = v => (v === undefined || v === null || v === '' ? NaN : Number(v));
const usd = (v, d = 2) => (v < 0 ? '−' : '') + '$' + Math.abs(v).toFixed(d);
const sgnUsd = v => (v >= 0 ? '+' : '') + usd(v);
const pct = (v, d = 4) => (v >= 0 ? '+' : '') + v.toFixed(d) + '%';
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function getJson(url, opts) {
  const where = url.split('?')[0].replace(/bot[^/]+/, 'bot***'); // never print the bot token
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (fr-monitor)' }, ...opts });
  if (!res.ok) {
    const hint = where.includes('telegram') ? (res.status === 404 || res.status === 401 ? '（トークンが間違っている）' : '')
      : res.status === 403 ? '（このサーバーからのアクセスを拒否された）' : '';
    throw new Error(`HTTP ${res.status} ${where} ${hint}`);
  }
  return res.json();
}

function marketClosed(market) {
  if (market === 'crypto') return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    .formatToParts(new Date()).map(x => [x.type, x.value]));
  const day = p.weekday, mins = Number(p.hour) * 60 + Number(p.minute);
  if (day === 'Sat' || (day === 'Sun' && mins < 18 * 60) || (day === 'Fri' && mins >= 17 * 60)) return '週末で市場休み';
  if (market === 'us' && !(mins >= 9 * 60 + 30 && mins < 16 * 60)) return '米国株 時間外';
  if (market === 'metal' && mins >= 17 * 60 && mins < 18 * 60) return '金属 日次休場';
  return '';
}

// ---------- market data / evaluation (mirrors index.html) ----------
async function fetchMarket() {
  const pop = [];
  let cursor = '';
  for (let page = 0; page < 20; page++) {
    const j = await getJson(`${POPDEX}/market/tickers?category=Futures&limit=100${cursor ? `&cursor=${cursor}` : ''}`);
    if (j.code !== '200') throw new Error('PopDEX: ' + j.msg);
    pop.push(...j.data);
    if (!j.data.length || pop.length >= Number(j.total)) break;
    cursor = j.cursor;
  }
  const vari = await getJson(VARIATIONAL);
  return { pop, vari };
}

function evaluateAll(market, S) {
  const vMap = new Map(market.vari.listings.map(l => [l.ticker, l]));
  const out = [];
  for (const t of market.pop) {
    const safe = SAFE[t.symbol];
    const l = safe && vMap.get(safe.v);
    if (!l || !(l.funding_interval_s > 0)) continue;
    const popMid = (num(t.bid1Price) + num(t.ask1Price)) / 2 || num(t.markPrice);
    const q = l.quotes || {};
    const lev = Math.max(1, Math.min(S.lev, safe.maxLev));
    const margin = Math.min(S.balPop, S.balV);
    const N = margin * lev;
    const b = N <= 1000 ? (q.size_1k || q.base) : N <= 100000 ? (q.size_100k || q.size_1k) : (q.size_1m || q.size_100k);
    const vMid = b ? (num(b.bid) + num(b.ask)) / 2 : num(l.mark_price);
    if (!(Math.abs(popMid / vMid - 1) < 0.03)) continue;

    const popFR24 = num(t.fundingRate) * (24 / POP_INTERVAL_H) * 100;
    const vFR24 = num(l.funding_rate) / 365 * 100;
    const dA = popFR24 - vFR24;  // Pop short / V long
    const dB = -popFR24 + vFR24; // Pop long  / V short
    const popShort = dA >= dB;
    const diff = Math.max(dA, dB);
    const popSpread = (num(t.ask1Price) - num(t.bid1Price)) / popMid;
    const vSpread = b ? (num(b.ask) - num(b.bid)) / vMid : 0;
    const cost = N * (2 * S.takerBps / 1e4 + popSpread + vSpread);
    const gap = (popMid / vMid - 1) * 100;
    const favGap = popShort ? gap : -gap;
    const gapCost = favGap >= 0 ? -favGap / 100 * N * 0.5 : -favGap / 100 * N;
    const effCost = Math.max(cost + gapCost, 0);
    const daily = diff / 100 * N;
    const days = daily > 0 ? effCost / daily : Infinity;
    const closed = marketClosed(safe.market);
    const gapBad = favGap < -S.maxGap;
    const go = !closed && !gapBad && diff >= S.minDiff && days <= S.maxDays;
    out.push({
      key: `${t.symbol}|${l.ticker}`, sym: t.symbol, vTicker: l.ticker, label: safe.label, lev, N, margin,
      popShort, dA, dB, diff, cost, effCost, days, week: daily * 7 - effCost, daily, gap, favGap, gapBad, closed, go, popMid, vMid,
    });
  }
  return out;
}

const orderText = (popShort, N, lev, vTicker) =>
  `PopDEXで<b>${popShort ? 'ショート' : 'ロング'}</b> ${usd(N, 0)}（${lev}x）\nVariational(${vTicker})で<b>${popShort ? 'ロング' : 'ショート'}</b> ${usd(N, 0)}（${lev}x）`;

// ---------- telegram ----------
async function send(text) {
  if (!TG_TOKEN || !TG_CHAT) { console.log('--- (dry run) ---\n' + text.replace(/<[^>]+>/g, '')); return; }
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!r.ok) console.error('telegram send failed', r.status, await r.text());
}

async function readCommands(st) {
  if (!TG_TOKEN) return [];
  const j = await getJson(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${st.tgOffset}&timeout=0`);
  const cmds = [];
  for (const u of j.result || []) {
    st.tgOffset = u.update_id + 1;
    const m = u.message;
    if (!m || !m.text || String(m.chat.id) !== String(TG_CHAT)) continue; // only the owner's chat
    cmds.push(m.text.trim());
  }
  return cmds;
}

function resolveSym(word) {
  if (!word) return null;
  const w = word.toUpperCase().replace(/USDT$/, '');
  return LABEL_ALIASES[w] || LABEL_ALIASES[word] || (SAFE[w + 'USDT'] ? w + 'USDT' : null);
}

const HELP = [
  '<b>コマンド</b>（5分ごとに読み取り・返事は最大5〜15分後）',
  '状況 … 今の判定と保有を表示',
  '持った GOLD … 今の指令どおり建てたとして記録',
  '決済 GOLD … 両方閉じたとして記録',
  '残高 150 120 … PopDEX / Variational 残高を更新',
  'レバ 3 … レバ上限を変更',
  '対象: GOLD 銀 BTC ETH QQQ',
].join('\n');

async function handleCommand(text, st, rows) {
  const [cmdRaw, ...args] = text.replace(/^\//, '').split(/\s+/);
  const cmd = cmdRaw.toLowerCase();
  const S = st.settings;
  if (['help', 'start', 'ヘルプ'].includes(cmd)) return send(HELP);
  if (['status', '状況', 'じょうきょう'].includes(cmd)) return send(statusText(st, rows));
  if (['bal', '残高'].includes(cmd)) {
    const a = num(args[0]), b = num(args[1]);
    if (!(a > 0 && b > 0)) return send('使い方: 残高 150 120（PopDEX Variational）');
    S.balPop = a; S.balV = b;
    return send(`✅ 残高更新: PopDEX ${usd(a, 0)} / Variational ${usd(b, 0)}\n→ 証拠金 ${usd(Math.min(a, b), 0)} × レバ${S.lev}x で計算します`);
  }
  if (['lev', 'レバ'].includes(cmd)) {
    const v = num(args[0]);
    if (!(v >= 1 && v <= 10)) return send('使い方: レバ 3（1〜10）');
    S.lev = v;
    return send(`✅ レバ上限 ${v}x（銘柄ごとの上限でさらに抑えます）`);
  }
  if (['hold', '持った', 'もった'].includes(cmd)) {
    const sym = resolveSym(args[0]);
    const r = rows.find(x => x.sym === sym);
    if (!r) return send('銘柄が分からない… 例: 持った GOLD');
    if (st.positions.some(p => p.sym === sym)) return send(`${r.label} はもう保有中として記録済み`);
    const now = Date.now();
    st.positions.push({ key: r.key, sym, label: r.label, vTicker: r.vTicker, popShort: r.popShort, N: r.N, lev: r.lev,
      entryPop: r.popMid, entryV: r.vMid, entryCost: r.cost, openedAt: now, lastAt: now, earned: 0, negSince: null, status: 'hold' });
    return send(`📌 <b>${r.label}</b> を保有として記録\n${orderText(r.popShort, r.N, r.lev, r.vTicker)}\n往復コスト ${usd(r.cost)} · 撤退やヤバい時はここに指令を出します`);
  }
  if (['close', '決済', 'けっさい'].includes(cmd)) {
    const sym = resolveSym(args[0]);
    const i = st.positions.findIndex(p => p.sym === sym);
    if (i < 0) return send('その銘柄は保有記録にないよ。例: 決済 GOLD');
    const p = st.positions[i];
    st.history.unshift({ sym, label: p.label, openedAt: p.openedAt, closedAt: Date.now(), net: p.net || 0 });
    st.positions.splice(i, 1);
    const total = st.history.reduce((s, x) => s + x.net, 0);
    return send(`✅ <b>${p.label}</b> 決済を記録 · 推定損益 ${sgnUsd(p.net || 0)}\n決済済み合計 ${st.history.length}件 ${sgnUsd(total)}`);
  }
  return send('？ 分からないコマンド\n\n' + HELP);
}

function statusText(st, rows) {
  const S = st.settings;
  const lines = [`<b>📊 状況</b>  証拠金 ${usd(Math.min(S.balPop, S.balV), 0)} · レバ上限 ${S.lev}x`];
  for (const r of [...rows].sort((a, b) => b.diff - a.diff)) {
    const mark = r.go ? '🟢' : r.closed ? '💤' : r.gapBad ? '↔️' : '⚪';
    lines.push(`${mark} ${r.label} ${r.popShort ? 'Pop売/V買' : 'Pop買/V売'} ${pct(r.diff)}/日 · 回収${isFinite(r.days) ? r.days.toFixed(1) + '日' : '—'} · 1週${sgnUsd(r.week)}${r.closed ? ' · ' + r.closed : ''}`);
  }
  if (st.positions.length) {
    lines.push('', '<b>📌 保有</b>');
    for (const p of st.positions) lines.push(`${p.label}: 推定 ${sgnUsd(p.net || 0)} · FR累計 ${sgnUsd(p.earned)} · 清算まで ±${Math.min(p.liqPop ?? 99, p.liqV ?? 99).toFixed(1)}%`);
  } else lines.push('', '保有なし');
  return lines.join('\n');
}

// ---------- main cycle ----------
async function cycle() {
  const st = loadState();
  const S = st.settings;
  const market = await fetchMarket();
  let rows = evaluateAll(market, S);

  for (const c of await readCommands(st)) {
    await handleCommand(c, st, rows);
    rows = evaluateAll(market, S); // settings may have changed
  }

  const now = Date.now();
  // held positions: integrate funding, check liquidation distance and exit condition
  for (const p of st.positions) {
    const r = rows.find(x => x.key === p.key);
    if (!r) continue;
    const d = p.popShort ? r.dA : r.dB;
    p.earned += d / 100 * p.N * Math.min(now - p.lastAt, 3600e3) / 86400e3;
    p.lastAt = now;
    p.negSince = d < 0 ? (p.negSince || now) : null;
    const popPnl = (p.popShort ? p.entryPop - r.popMid : r.popMid - p.entryPop) / p.entryPop * p.N;
    const vPnl = (p.popShort ? r.vMid - p.entryV : p.entryV - r.vMid) / p.entryV * p.N;
    p.net = p.earned + popPnl + vPnl - p.entryCost;
    p.liqPop = Math.max(0, (S.balPop + popPnl) / p.N * 100 - 0.5);
    p.liqV = Math.max(0, (S.balV + vPnl) / p.N * 100 - 0.5);
    const negH = p.negSince ? (now - p.negSince) / 3600e3 : 0;
    const prev = p.status;
    p.status = negH >= S.exitHours ? 'exit' : Math.min(p.liqPop, p.liqV) < 15 ? 'move' : d < 0 ? 'watch' : 'hold';
    if (p.status === prev) continue;
    if (p.status === 'exit') {
      await send(`🔴<b>【指令】${p.label} 撤退</b>\n受取差マイナスが${negH.toFixed(1)}時間継続。\nPopDEXとVariationalの<b>両方を決済</b>して「決済 ${p.label}」と送ってね\n推定損益 ${sgnUsd(p.net)}`);
    } else if (p.status === 'move') {
      const weak = p.liqPop < p.liqV ? 'PopDEX' : 'Variational';
      await send(`⚠️<b>【指令】${p.label} 証拠金を移動</b>\n${weak}側が清算まで ±${Math.min(p.liqPop, p.liqV).toFixed(1)}%。\n${weak === 'PopDEX' ? 'Variational→PopDEX' : 'PopDEX→Variational'} へ資金を移すか、両方を少し減らして`);
    }
  }

  // entry instructions on transition into "go", with cooldown
  for (const r of rows) {
    const prev = st.pairState[r.key];
    const state = r.go ? 'go' : 'no';
    st.pairState[r.key] = state;
    if (state !== 'go' || prev === 'go' || st.positions.some(p => p.sym === r.sym)) continue;
    if (now - (st.notifyLast[r.key] || 0) < S.cooldownMin * 60e3) continue;
    st.notifyLast[r.key] = now;
    await send(`🟢<b>【指令】${r.label} エントリー</b>\n${orderText(r.popShort, r.N, r.lev, r.vTicker)}\n受取差 ${pct(r.diff)}/日 · 回収${r.days.toFixed(1)}日 · 1週見込み ${sgnUsd(r.week)}\n価格乖離 ${pct(r.gap, 3)}（${r.favGap >= 0 ? '有利' : '不利'}）\n建てたら「持った ${r.label}」と送ってね`);
  }

  saveState(st);
  return rows;
}

async function main() {
  const arg = process.argv[2];
  if (arg === '--chatid') {
    if (!TG_TOKEN) return console.log('TELEGRAM_BOT_TOKEN を設定してから実行してね');
    const j = await getJson(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates`);
    const ids = [...new Set((j.result || []).map(u => u.message && u.message.chat.id).filter(Boolean))];
    return console.log(ids.length ? 'chat id: ' + ids.join(', ') : 'ボットに何かメッセージを送ってからもう一度実行してね');
  }
  if (arg === '--loop') {
    for (;;) {
      try { await cycle(); console.log(new Date().toLocaleTimeString(), 'ok'); } catch (e) { console.error(new Date().toLocaleTimeString(), e.message); }
      await new Promise(r => setTimeout(r, 60e3));
    }
  }
  const rows = await cycle();
  console.log(rows.map(r => `${r.go ? 'GO ' : '-- '}${r.label} ${r.popShort ? 'PopS/VL' : 'PopL/VS'} ${r.diff.toFixed(4)}%/d days=${r.days.toFixed(1)} week=${r.week.toFixed(2)} ${r.closed}`).join('\n'));
}

main().catch(e => { console.error(e); process.exit(1); });
