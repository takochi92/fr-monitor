// PopDEX x Variational FR monitor - headless version (GitHub Actions or PC). No dependencies, Node 18+.
// 全ペアを走査し、平均化したFR差で「最も効率のいい1本」を選んで Telegram に指令を出す。
//
//   node monitor.js            run once (GitHub Actions)
//   node monitor.js --loop     run every 60 s (keep it running on a PC)
//   node monitor.js --chatid   print the chat id of whoever messaged the bot (setup helper)
//
// Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID. Without them, messages are printed instead of sent.
const fs = require('fs');
const path = require('path');

const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'state.json');
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const POPDEX = 'https://api.popdex.xyz/api/v1/public';
const VARIATIONAL = 'https://omni-client-api.prod.ap-northeast-1.variational.io/metadata/stats';
const POP_INTERVAL_H = 1;

const DEFAULT_SETTINGS = {
  balPop: 100, balV: 100, lev: 3, takerBps: 3.2,
  holdMode: 1,        // 1 = 常にポジションを持つ（ポイント重視・長期保有） / 0 = FR差が大きい時だけ入る
  holdDays: 30,       // 常時保有モード: この日数持つ前提でコストを割って順位付け
  holdFloor: -0.005,  // 常時保有モード: 見込み受取差 %/日 がこれ以上なら建ててよい（少しのマイナスは許容）
  exitFloor: -0.01,   // 常時保有モード: 平均の受取差がこれを下回ったら「悪化」とみなす
  minHoldHours: 24,   // 常時保有モード: 建ててからこの時間は乗り換え提案をしない
  switchMinGain: 0.02,// 常時保有モード: 乗り換えは受取差がこれ以上 %/日 良くなる時だけ
  minDiff: 0.02,      // 厳選モード: %/24h（現在値と平均の両方）がこれ以上でエントリー候補
  maxDays: 7,         // 厳選モード: コスト回収日数の上限
  maxGap: 0.1,        // 不利な価格乖離の許容 %
  exitHours: 24,      // 平均の受取差が悪化したままこの時間続いたら撤退（または乗り換え）
  cooldownMin: 60,    // 同じ指令を繰り返さない時間
  emaHours: 6,        // FR差の平均化（指数移動平均）の時間幅
  warmupMin: 60,      // 新しいペアはこの時間観測してから判定に使う
  universe: 'wide',   // 'safe' = 主要5銘柄のみ / 'wide' = 両取引所の共通銘柄すべて（フィルタ付き）
  minVol: 200000,     // wide: 両取引所の24h出来高の下限 $
  maxSpreadBps: 15,   // wide: 片側スプレッドの上限 bps
  maxPositions: 1,    // 同時保有数（証拠金は空き分で割り当て）
  switchDays: 3,      // 乗り換えコストをこの日数以内に回収できるなら乗り換え指令
  reportHour: 21,     // 日報を送る時刻（日本時間）
  altMaxLev: 3,       // 主要5銘柄以外の暗号資産のレバ上限
  rwaMaxLev: 3,       // 主要5銘柄以外の株・商品のレバ上限
};
const SETTINGS_VER = 2; // 既定値を変えた項目を古い state.json から引き継がないための版数
const RESET_ON_UPGRADE = ['exitHours'];
const NUMERIC_KEYS = Object.keys(DEFAULT_SETTINGS).filter(k => typeof DEFAULT_SETTINGS[k] === 'number');

// 主要銘柄（レバ上限は個別）
const CORE = {
  XAUUSDT: { label: 'GOLD', maxLev: 5, market: 'metal',  v: 'XAU' },
  XAGUSDT: { label: '銀',   maxLev: 3, market: 'metal',  v: 'XAG' },
  BTCUSDT: { label: 'BTC',  maxLev: 5, market: 'crypto', v: 'BTC' },
  ETHUSDT: { label: 'ETH',  maxLev: 5, market: 'crypto', v: 'ETH' },
  BNBUSDT: { label: 'BNB',  maxLev: 5, market: 'crypto', v: 'BNB' },
  QQQUSDT: { label: 'QQQ',  maxLev: 5, market: 'us',     v: 'QQQ' },
};
const LABEL_ALIASES = { GOLD: 'XAUUSDT', XAU: 'XAUUSDT', 金: 'XAUUSDT', 銀: 'XAGUSDT', SILVER: 'XAGUSDT' };
// wide: PopDEX名 -> Variational名（違うものだけ）
const V_ALIAS = { kPEPE: '1000PEPE' };
// 取引時間がアジア市場の銘柄は休場判定が合わないので除外
const SKIP = new Set(['SAMSUNG', 'SKHYNIX', 'SKHY', 'KR200', 'JP225', 'SOFTBANK', 'CXMT', 'UNITREE', 'ZHIPU', 'MINIMAX', 'KSTR', 'EWY', 'EWJ']);
const METAL_LIKE = new Set(['XAU', 'XAG', 'XPT', 'CL', 'BZ', 'COPPER', 'NATGAS']);

// ---------- state ----------
function loadState() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8').replace(/^﻿/, '')); } catch {} // tolerate BOM
  const saved = { ...(s.settings || {}) };
  if ((s.settingsVer || 0) < SETTINGS_VER) for (const k of RESET_ON_UPGRADE) delete saved[k];
  return {
    settingsVer: SETTINGS_VER,
    settings: { ...DEFAULT_SETTINGS, ...saved },
    positions: s.positions || [], history: s.history || [],
    pairState: s.pairState || {}, notifyLast: s.notifyLast || {}, tgOffset: s.tgOffset || 0,
    ema: s.ema || {}, lastTopKey: s.lastTopKey || null, lastReportDay: s.lastReportDay || '',
  };
}
const saveState = st => fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2) + '\n');

// ---------- helpers ----------
const num = v => (v === undefined || v === null || v === '' ? NaN : Number(v));
const usd = (v, d = 2) => (v < 0 ? '−' : '') + '$' + Math.abs(v).toFixed(d);
const sgnUsd = v => (v >= 0 ? '+' : '') + usd(v);
const pct = (v, d = 4) => (v >= 0 ? '+' : '') + v.toFixed(d) + '%';
const daysTxt = d => (isFinite(d) ? d.toFixed(1) + '日' : '—');
const jstDay = t => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);
const jstHour = t => new Date(t + 9 * 3600e3).getUTCHours();

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

function marketClosed(market, now = Date.now()) {
  if (market === 'crypto') return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    .formatToParts(new Date(now)).map(x => [x.type, x.value]));
  const day = p.weekday, mins = Number(p.hour) * 60 + Number(p.minute);
  if (day === 'Sat' || (day === 'Sun' && mins < 18 * 60) || (day === 'Fri' && mins >= 17 * 60)) return '週末で市場休み';
  if (market === 'us' && !(mins >= 9 * 60 + 30 && mins < 16 * 60)) return '米国株 時間外';
  if (market === 'metal' && mins >= 17 * 60 && mins < 18 * 60) return '金属 日次休場';
  return '';
}

// ---------- market data ----------
async function fetchMarket() {
  const pop = [];
  let cursor = '';
  for (let page = 0; page < 20; page++) {
    const j = await getJson(`${POPDEX}/market/tickers?category=Futures&limit=100${cursor ? `&cursor=${cursor}` : ''}`);
    if (String(j.code) !== '200') throw new Error('PopDEX: ' + j.msg);
    pop.push(...j.data);
    if (!j.data.length || pop.length >= Number(j.total)) break;
    cursor = j.cursor;
  }
  const vari = await getJson(VARIATIONAL);
  return { pop, vari };
}

function pairInfo(t, S) {
  if (CORE[t.symbol]) return { ...CORE[t.symbol], core: true };
  if (S.universe !== 'wide' || t.status && t.status !== 'Trading') return null;
  const base = t.symbol.replace(/USDT$/, '');
  if (SKIP.has(base)) return null;
  const rwa = String(t.symbolId || '').startsWith('21'); // PopDEXの株・指数・商品は 21xxx
  return { label: base.toUpperCase(), maxLev: rwa ? S.rwaMaxLev : S.altMaxLev, market: rwa ? (METAL_LIKE.has(base) ? 'metal' : 'us') : 'crypto', v: V_ALIAS[base] || base, core: false };
}

// ---------- evaluation ----------
// 価格・コストは建玉1ドルあたりの率で持ち、建玉額は後から掛ける
function evaluateAll(market, st, now = Date.now()) {
  const S = st.settings;
  HORIZON = S.holdMode ? S.holdDays : 7;
  const vMap = new Map(market.vari.listings.map(l => [l.ticker, l]));
  const used = st.positions.reduce((a, p) => a + p.N / p.lev, 0);
  const freeMargin = Math.max(0, Math.min(S.balPop, S.balV) - used);
  const out = [];
  for (const t of market.pop) {
    const info = pairInfo(t, S);
    const l = info && vMap.get(info.v);
    if (!l || !(l.funding_interval_s > 0)) continue; // swap（FRなし）は対象外
    const popBid = num(t.bid1Price), popAsk = num(t.ask1Price);
    const popMid = (popBid + popAsk) / 2 || num(t.markPrice);
    const lev = Math.max(1, Math.min(S.lev, info.maxLev));
    const held = st.positions.find(p => p.sym === t.symbol);
    const N = held ? held.N : freeMargin * lev;
    const q = l.quotes || {};
    const b = N <= 1000 ? (q.size_1k || q.base) : N <= 100000 ? (q.size_100k || q.size_1k) : (q.size_1m || q.size_100k);
    const vMid = b ? (num(b.bid) + num(b.ask)) / 2 : num(l.mark_price);
    if (!(popMid > 0 && vMid > 0) || !(Math.abs(popMid / vMid - 1) < 0.03)) continue; // 別商品・スケール違いは除外

    const popSpread = (popAsk - popBid) / popMid;
    const vSpread = b ? (num(b.ask) - num(b.bid)) / vMid : 0;
    const popVol = num(t.turnover24h), vVol = num(l.volume_24h);
    if (!info.core && !held) {
      if (!(popVol >= S.minVol && vVol >= S.minVol)) continue;
      if (popSpread * 1e4 > S.maxSpreadBps || vSpread * 1e4 > S.maxSpreadBps) continue;
    }

    const popFR24 = num(t.fundingRate) * (24 / POP_INTERVAL_H) * 100;
    const vFR24 = num(l.funding_rate) / 365 * 100;
    const dA = popFR24 - vFR24;  // Pop short / V long の受取差（%/24h）
    const key = `${t.symbol}|${l.ticker}`;
    const e = st.ema[key];
    const warm = !!e && now - e.since >= S.warmupMin * 60e3;
    const avgA = e ? e.v : dA;
    // 方向は平均で決める（一瞬のブレで向きを変えない）
    const popShort = held ? held.popShort : (warm ? avgA >= 0 : dA >= 0);
    const cur = popShort ? dA : -dA;
    const avg = popShort ? avgA : -avgA;
    const cons = warm ? Math.min(cur, avg) : cur; // 控えめな見込み

    const costRate = 2 * S.takerBps / 1e4 + popSpread + vSpread;
    const gap = (popMid / vMid - 1) * 100;
    const favGap = popShort ? gap : -gap;
    const gapRate = favGap >= 0 ? -favGap / 100 * 0.5 : -favGap / 100;
    const effRate = Math.max(costRate + gapRate, 0);
    const days = cons > 0 ? effRate / (cons / 100) : Infinity;
    const closed = marketClosed(info.market, now);
    const gapBad = favGap < -S.maxGap;
    const okBase = warm && !closed && !gapBad;
    const ok = S.holdMode ? okBase && cons >= S.holdFloor : okBase && cur >= S.minDiff && avg >= S.minDiff && days <= S.maxDays;
    const go = !held && ok && N >= 10;
    const weekRate = cons / 100 * 7 - effRate;
    const holdRate = cons / 100 * S.holdDays - effRate; // 長く持つ前提の見込み（建玉比）
    const score = S.holdMode ? holdRate : weekRate;
    out.push({
      key, sym: t.symbol, vTicker: l.ticker, label: info.label, core: info.core, lev, N,
      popShort, dA, cur, avg, cons, warm, costRate, effRate, cost: costRate * N, effCost: effRate * N,
      days, daily: cons / 100 * N, week: weekRate * N, weekRate, holdRate, score, ok,
      gap, favGap, gapBad, closed, go, popMid, vMid, popVol, vVol,
    });
  }
  return { rows: out, freeMargin };
}

function updateEma(st, rows, now) {
  const S = st.settings;
  for (const r of rows) {
    const e = st.ema[r.key];
    if (!e) { st.ema[r.key] = { v: r.dA, t: now, since: now }; continue; }
    const dt = Math.min(now - e.t, 2 * 3600e3);
    const a = 1 - Math.exp(-dt / (S.emaHours * 3600e3));
    e.v += a * (r.dA - e.v);
    e.t = now;
  }
  for (const k of Object.keys(st.ema)) if (now - st.ema[k].t > 2 * 86400e3) delete st.ema[k]; // 2日見ていないものは捨てる
}

const ranked = rows => rows.filter(r => r.go).sort((a, b) => b.score - a.score);
const byScore = (a, b) => b.score - a.score;

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

function resolveRow(word, rows) {
  if (!word) return null;
  const w = word.toUpperCase().replace(/USDT$/, '');
  const sym = LABEL_ALIASES[w] || LABEL_ALIASES[word] || w + 'USDT';
  return rows.find(r => r.sym.toUpperCase() === sym.toUpperCase() || r.label.toUpperCase() === w) || null;
}

const HELP = [
  '<b>コマンド</b>（5分ごとに読み取り・返事は最大5〜15分後）',
  '状況 … 保有と上位候補',
  '候補 … エントリー候補ランキング',
  '持った GOLD … 今の指令どおり建てたとして記録',
  '決済 GOLD … 両方閉じたとして記録',
  '乗り換えた 銀 GOLD … 銀を決済してGOLDを建てたとして記録',
  '反転した 銀 … 同じ銘柄で売り買いを逆に建て直したとして記録',
  '残高 150 120 … PopDEX / Variational 残高',
  'レバ 3 … レバ上限',
  '最大 2 … 同時保有数',
  '範囲 広い / 主要 … 全銘柄 or 主要5銘柄',
  'モード 常時 / 厳選 … 常にポジションを持つ or FR差が大きい時だけ',
  '設定 … 設定一覧 / 設定 minDiff 0.03 … 個別変更',
].join('\n');

async function handleCommand(text, ctx) {
  const { st } = ctx;
  const S = st.settings;
  const rows = () => ctx.rows;
  const norm = text.replace(/^\//, '').replace(/^(持った|もった|決済|けっさい|残高|レバ|最大|範囲|乗り換えた|反転した|モード)(?=\S)/, '$1 ');
  const [cmdRaw, ...args] = norm.split(/\s+/);
  const cmd = cmdRaw.toLowerCase();
  if (['help', 'start', 'ヘルプ'].includes(cmd)) return send(HELP);
  if (['status', '状況', 'じょうきょう'].includes(cmd)) return send(statusText(st, rows(), ctx.freeMargin));
  if (['top', '候補', 'こうほ'].includes(cmd)) return send(candidatesText(rows(), 8, st));
  if (['bal', '残高'].includes(cmd)) {
    const a = num(args[0]), b = num(args[1]);
    if (!(a > 0 && b > 0)) return send('使い方: 残高 150 120（PopDEX Variational）');
    S.balPop = a; S.balV = b;
    return send(`✅ 残高更新: PopDEX ${usd(a, 0)} / Variational ${usd(b, 0)}`);
  }
  if (['lev', 'レバ'].includes(cmd)) {
    const v = num(args[0]);
    if (!(v >= 1 && v <= 10)) return send('使い方: レバ 3（1〜10）');
    S.lev = v;
    return send(`✅ レバ上限 ${v}x（銘柄ごとの上限でさらに抑えます）`);
  }
  if (['max', '最大'].includes(cmd)) {
    const v = num(args[0]);
    if (!(v >= 1 && v <= 5)) return send('使い方: 最大 2（1〜5）');
    S.maxPositions = v;
    return send(`✅ 同時保有 最大${v}本（証拠金は空き分で割り当て）`);
  }
  if (['universe', '範囲'].includes(cmd)) {
    const w = (args[0] || '').toLowerCase();
    S.universe = ['wide', '広い', 'ひろい', '全部'].includes(w) ? 'wide' : ['safe', '主要', '安全'].includes(w) ? 'safe' : S.universe;
    return send(`✅ 対象: ${S.universe === 'wide' ? '共通銘柄すべて（出来高・スプレッドで絞り込み）' : '主要6銘柄のみ'}`);
  }
  if (['mode', 'モード'].includes(cmd)) {
    const w = (args[0] || '').toLowerCase();
    if (['常時', 'hold', 'じょうじ', '長期'].includes(w)) S.holdMode = 1;
    else if (['厳選', 'pick', 'げんせん'].includes(w)) S.holdMode = 0;
    return send(`✅ モード: ${S.holdMode ? '常時保有（ポイント重視・長く持つ）' : '厳選（FR差が大きい時だけ）'}`);
  }
  if (['settings', '設定'].includes(cmd)) {
    if (args.length >= 2) {
      const k = NUMERIC_KEYS.find(x => x.toLowerCase() === args[0].toLowerCase());
      const v = num(args[1]);
      if (!k || !isFinite(v) || (v < 0 && !['holdFloor', 'exitFloor'].includes(k))) return send('使い方: 設定 minDiff 0.03\n変更できる項目: ' + NUMERIC_KEYS.join(', '));
      S[k] = v;
      return send(`✅ ${k} = ${v}`);
    }
    return send('<b>設定</b>\n' + Object.entries(S).map(([k, v]) => `${k}: ${v}`).join('\n'));
  }
  if (['hold', '持った', 'もった'].includes(cmd)) {
    const r = resolveRow(args[0], rows());
    if (!r) return send('銘柄が分からない… 例: 持った GOLD');
    if (st.positions.some(p => p.sym === r.sym)) return send(`${r.label} はもう保有中として記録済み`);
    if (!(r.N >= 10)) return send('空き証拠金がないよ。「残高」を更新するか、先に決済を記録してね');
    openPosition(st, r, ctx.now);
    return send(`📌 <b>${r.label}</b> を保有として記録\n${orderText(r.popShort, r.N, r.lev, r.vTicker)}\n往復コスト ${usd(r.cost)}`);
  }
  if (['close', '決済', 'けっさい'].includes(cmd)) {
    const p = closePosition(st, args[0], ctx.now);
    if (!p) return send('その銘柄は保有記録にないよ。例: 決済 GOLD');
    const total = st.history.reduce((s, x) => s + x.net, 0);
    return send(`✅ <b>${p.label}</b> 決済を記録 · 推定損益 ${sgnUsd(p.net || 0)}\n決済済み合計 ${st.history.length}件 ${sgnUsd(total)}`);
  }
  if (['flip', '反転した', 'はんてんした'].includes(cmd)) {
    const p = closePosition(st, args[0], ctx.now);
    if (!p) return send('使い方: 反転した 銀');
    ctx.recompute();
    const r = resolveRow(args[0], ctx.rows);
    if (!r) return send(`${p.label} の決済は記録した。「持った ${p.label}」で記録し直してね`);
    openPosition(st, { ...r, popShort: !p.popShort }, ctx.now);
    return send(`🔁 ${p.label} の向きを反転して記録（${sgnUsd(p.net || 0)}）\n${orderText(!p.popShort, r.N, r.lev, r.vTicker)}`);
  }
  if (['switch', '乗り換えた', 'のりかえた'].includes(cmd)) {
    const p = closePosition(st, args[0], ctx.now);
    if (!p) return send('使い方: 乗り換えた 銀 GOLD（決済した銘柄 → 新しく建てた銘柄）');
    ctx.recompute();
    const r = resolveRow(args[1], ctx.rows);
    if (!r) return send(`${p.label} の決済は記録した。新しい銘柄が分からないので「持った ○○」で記録してね`);
    openPosition(st, r, ctx.now);
    return send(`🔁 ${p.label}（${sgnUsd(p.net || 0)}）→ <b>${r.label}</b> に乗り換えを記録\n${orderText(r.popShort, r.N, r.lev, r.vTicker)}`);
  }
  return send('？ 分からないコマンド\n\n' + HELP);
}

function openPosition(st, r, now = Date.now()) {
  st.positions.push({ key: r.key, sym: r.sym, label: r.label, vTicker: r.vTicker, popShort: r.popShort, N: r.N, lev: r.lev,
    entryPop: r.popMid, entryV: r.vMid, entryCost: r.cost, openedAt: now, lastAt: now, earned: 0, earnedAtReport: 0,
    negSince: null, status: 'hold' });
}

function closePosition(st, word, now = Date.now()) {
  if (!word) return null;
  const w = word.toUpperCase().replace(/USDT$/, '');
  const sym = (LABEL_ALIASES[w] || LABEL_ALIASES[word] || w + 'USDT').toUpperCase();
  const i = st.positions.findIndex(p => p.sym.toUpperCase() === sym || p.label.toUpperCase() === w);
  if (i < 0) return null;
  const p = st.positions[i];
  st.history.unshift({ sym: p.sym, label: p.label, openedAt: p.openedAt, closedAt: now, net: p.net || 0, earned: p.earned || 0 });
  st.history = st.history.slice(0, 200);
  st.positions.splice(i, 1);
  return p;
}

let HORIZON = 7;
const horizonTxt = r => `${HORIZON}日${r.N >= 10 ? sgnUsd(r.score * r.N) : pct(r.score * 100, 2) + '（建玉比）'}`;
function rowLine(r) {
  const mark = r.ok ? '🟢' : r.closed ? '💤' : r.gapBad ? '↔️' : !r.warm ? '⏳' : '⚪';
  return `${mark} ${r.label} ${r.popShort ? 'Pop売/V買' : 'Pop買/V売'} 今${pct(r.cur, 3)} 平均${pct(r.avg, 3)}/日 · 回収${daysTxt(r.days)} · ${horizonTxt(r)}${r.closed ? ' · ' + r.closed : ''}`;
}

function candidatesText(rows, n, st) {
  const list = [...rows].filter(r => !st.positions.some(p => p.sym === r.sym)).sort(byScore).slice(0, n);
  if (!list.length) return '候補なし';
  return [`<b>🏁 候補ランキング</b>（${HORIZON}日見込み順・空き証拠金ベース）`, ...list.map(rowLine)].join('\n');
}

function statusText(st, rows, freeMargin) {
  const S = st.settings;
  const lines = [`<b>📊 状況</b>  空き証拠金 ${usd(freeMargin, 0)} · レバ上限 ${S.lev}x · 最大${S.maxPositions}本 · ${S.universe === 'wide' ? '全銘柄' : '主要5'}`];
  if (st.positions.length) {
    lines.push('<b>📌 保有</b>');
    for (const p of st.positions) {
      const liq = p.liqPop === undefined ? '計算中' : `±${Math.min(p.liqPop, p.liqV).toFixed(1)}%`;
      lines.push(`${p.label}: 推定 ${sgnUsd(p.net || 0)} · FR累計 ${sgnUsd(p.earned)} · 清算まで ${liq} · ${p.status}`);
    }
  } else lines.push('保有なし');
  lines.push('', candidatesText(rows, 5, st));
  return lines.join('\n');
}

function reportText(st, rows) {
  const lines = ['<b>🗒 日報</b>'];
  let todayFr = 0;
  for (const p of st.positions) {
    const d = p.earned - (p.earnedAtReport || 0);
    todayFr += d;
    p.earnedAtReport = p.earned;
    lines.push(`${p.label}: 今日のFR ${sgnUsd(d)} · 累計 ${sgnUsd(p.earned)} · 推定損益 ${sgnUsd(p.net || 0)}`);
  }
  if (!st.positions.length) lines.push('保有なし');
  const closed = st.history.reduce((s, x) => s + x.net, 0);
  const open = st.positions.reduce((s, p) => s + (p.net || 0), 0);
  lines.push(`今日のFR合計 ${sgnUsd(todayFr)} · 通算（決済済み${sgnUsd(closed)} + 保有中${sgnUsd(open)}）${sgnUsd(closed + open)}`);
  const best = [...rows].sort(byScore).slice(0, 3);
  if (best.length) lines.push('', '<b>上位候補</b>', ...best.map(rowLine));
  return lines.join('\n');
}

// ---------- main cycle ----------
async function cycle(now = Date.now()) {
  const st = loadState();
  const S = st.settings;
  const market = await fetchMarket();
  const ctx = { st, now, rows: [], freeMargin: 0, recompute() { const e = evaluateAll(market, st, now); ctx.rows = e.rows; ctx.freeMargin = e.freeMargin; } };

  ctx.recompute();
  updateEma(st, ctx.rows, now);
  ctx.recompute();

  for (const c of await readCommands(st)) {
    await handleCommand(c, ctx);
    ctx.recompute(); // settings / positions may have changed
  }
  const rows = ctx.rows;

  // ---- 保有中: FR積算・清算距離・撤退/乗り換え判定
  const usedBy = sym => st.positions.filter(p => p.sym !== sym).reduce((a, p) => a + p.N / p.lev, 0);
  for (const p of st.positions) {
    const r = rows.find(x => x.key === p.key);
    if (!r) continue;
    const d = p.popShort ? r.dA : -r.dA;
    p.earned += d / 100 * p.N * Math.min(Math.max(now - p.lastAt, 0), 3600e3) / 86400e3;
    p.lastAt = now;
    const avgDir = r.warm ? r.avg : d;
    const badLine = S.holdMode ? S.exitFloor : 0;
    p.negSince = avgDir < badLine ? (p.negSince || now) : null;
    const popPnl = (p.popShort ? p.entryPop - r.popMid : r.popMid - p.entryPop) / p.entryPop * p.N;
    const vPnl = (p.popShort ? r.vMid - p.entryV : p.entryV - r.vMid) / p.entryV * p.N;
    p.net = p.earned + popPnl + vPnl - p.entryCost;
    p.liqPop = Math.max(0, (S.balPop - usedBy(p.sym) + popPnl) / p.N * 100 - 0.5);
    p.liqV = Math.max(0, (S.balV - usedBy(p.sym) + vPnl) / p.N * 100 - 0.5);
    const negH = p.negSince ? (now - p.negSince) / 3600e3 : 0;
    const prev = p.status;
    p.status = negH >= S.exitHours ? 'exit' : Math.min(p.liqPop, p.liqV) < 15 ? 'move' : avgDir < badLine ? 'watch' : 'hold';

    // 乗り換え先の候補（同じ証拠金で建て直したとき）
    const mine = p.status === 'exit' ? Math.min(avgDir, 0) : avgDir;
    const alts = rows.filter(x => x.ok && !st.positions.some(q => q.sym === x.sym))
      .map(x => {
        const Nx = p.N / p.lev * x.lev;
        const gain = x.cons / 100 * Nx - mine / 100 * p.N;
        const cost = p.entryCost / 2 + x.effRate * Nx;
        return { x, Nx, gain, cost, days: gain > 0 ? cost / gain : Infinity };
      });
    // 同じ銘柄で向きを逆にする（FRの向きが入れ替わった時）
    if (!r.closed && -r.favGap >= -S.maxGap) {
      const fCons = r.warm ? Math.min(-r.cur, -r.avg) : -r.cur;
      const ok = S.holdMode ? r.warm && fCons >= S.holdFloor : r.warm && -r.cur >= S.minDiff && -r.avg >= S.minDiff;
      if (ok) {
        const gain = (fCons - mine) / 100 * p.N;
        const cost = p.entryCost / 2 + r.effRate * p.N;
        alts.push({ flip: true, x: { ...r, popShort: !p.popShort, cons: fCons, score: fCons / 100 * S.holdDays - r.effRate },
          Nx: p.N, gain, cost, days: gain > 0 ? cost / gain : Infinity });
      }
    }
    const switchMsg = a => `${orderText(a.x.popShort, a.Nx, a.x.lev, a.x.vTicker)}\n受取差 ${pct(mine, 3)} → ${pct(a.x.cons, 3)}/日 · コスト ${usd(a.cost)}${isFinite(a.days) ? ' を ' + daysTxt(a.days) + 'で回収' : ''}\n終わったら「${a.flip ? `反転した ${p.label}` : `乗り換えた ${p.label} ${a.x.label}`}」と送ってね`;
    const switchTitle = a => a.flip ? `${p.label} 向きを反転` : `${p.label} → ${a.x.label} 乗り換え`;

    if (p.status !== prev && p.status === 'exit') {
      // 常時保有モードでは「降りる」より「次に乗る」を優先
      const next = S.holdMode ? [...alts].sort((a, b) => b.x.score - a.x.score)[0] : null;
      if (next) await send(`🔁<b>【指令】${switchTitle(next)}</b>\n${p.label}の受取差が${negH.toFixed(1)}時間悪化したまま（平均${pct(avgDir, 3)}/日）。\n1) ${p.label} を両方決済\n2) ${switchMsg(next)}`);
      else await send(`🔴<b>【指令】${p.label} 撤退</b>\n平均の受取差の悪化が${negH.toFixed(1)}時間継続${S.holdMode ? '。今は乗り換え先もない' : ''}。\nPopDEXとVariationalの<b>両方を決済</b>して「決済 ${p.label}」と送ってね\n推定損益 ${sgnUsd(p.net)}`);
      continue;
    } else if (p.status !== prev && p.status === 'move') {
      const weak = p.liqPop < p.liqV ? 'PopDEX' : 'Variational';
      await send(`⚠️<b>【指令】${p.label} 証拠金を移動</b>\n${weak}側が清算まで ±${Math.min(p.liqPop, p.liqV).toFixed(1)}%。\n${weak === 'PopDEX' ? 'Variational→PopDEX' : 'PopDEX→Variational'} へ資金を移すか、両方を少し減らして`);
    }

    // 乗り換え: 長く持つのが基本。建ててから minHoldHours 経ち、受取差が十分良くなり、コストを switchDays 以内に回収できる時だけ
    if (p.status === 'move' || p.status === 'exit') continue;
    if (S.holdMode && now - p.openedAt < S.minHoldHours * 3600e3 && avgDir >= S.exitFloor) continue; // 悪化中なら待たない
    const alt = alts
      .filter(o => o.days <= S.switchDays && (!S.holdMode || o.x.cons - mine >= S.switchMinGain))
      .sort((a, b) => S.holdMode ? b.x.score - a.x.score : a.days - b.days)[0];
    if (alt) {
      const k = `sw|${p.sym}`; // 1ポジションにつき3時間に1回まで
      if (now - (st.notifyLast[k] || 0) >= S.cooldownMin * 60e3 * 3) {
        st.notifyLast[k] = now;
        await send(`🔁<b>【指令】${switchTitle(alt)}</b>\n1) ${p.label} を両方決済\n2) ${switchMsg(alt)}`);
      }
    }
  }

  // ---- 新規エントリー: 空き枠があれば一番効率のいい1本だけ指令
  // 常時保有モードでは空き枠がある限り、3時間ごとに催促する
  const top = st.positions.length < S.maxPositions ? ranked(rows)[0] : null;
  const sinceEntry = now - (st.notifyLast.entry || 0);
  const changed = top && top.key !== st.lastTopKey;
  if (top && sinceEntry >= S.cooldownMin * 60e3 && (changed || (S.holdMode && sinceEntry >= 180 * 60e3))) {
    st.notifyLast.entry = now;
    st.notifyLast[top.key] = now;
    const runners = ranked(rows).slice(1, 3).map(r => `${r.label} ${horizonTxt(r)}`).join(' / ');
    await send(`🟢<b>【指令】${top.label} エントリー</b>\n${orderText(top.popShort, top.N, top.lev, top.vTicker)}\n受取差 今${pct(top.cur, 3)} · 平均${pct(top.avg, 3)}/日 · 回収${daysTxt(top.days)} · ${S.holdMode ? S.holdDays + '日見込み ' + sgnUsd(top.holdRate * top.N) : '1週見込み ' + sgnUsd(top.week)}\n価格乖離 ${pct(top.gap, 3)}（${top.favGap >= 0 ? '有利' : '不利'}）${runners ? '\n次点: ' + runners : ''}\n建てたら「持った ${top.label}」と送ってね`);
  }
  if (top && st.notifyLast.entry === now) st.lastTopKey = top.key;
  if (!top) st.lastTopKey = null;
  for (const r of rows) st.pairState[r.key] = r.go ? 'go' : 'no';

  // ---- 日報
  const today = jstDay(now);
  if (jstHour(now) >= S.reportHour && st.lastReportDay !== today) {
    st.lastReportDay = today;
    await send(reportText(st, rows));
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
  console.log([...rows].sort(byScore).slice(0, 15)
    .map(r => `${r.go ? 'GO ' : '-- '}${r.label} ${r.popShort ? 'PopS/VL' : 'PopL/VS'} cur=${r.cur.toFixed(4)} avg=${r.avg.toFixed(4)}%/d days=${r.days.toFixed(1)} week=${r.week.toFixed(2)} ${r.warm ? '' : 'warmup'} ${r.closed}`).join('\n'));
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { cycle, evaluateAll, updateEma, loadState };
