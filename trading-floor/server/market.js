'use strict';

// Market-data collection for the pixel trading floor.
// All sources are keyless public endpoints. Node built-ins only (global fetch).
//
// Exports:
//   resolveSymbol(input)      -> { kind:'crypto'|'stock'|'krstock', symbol, display,
//                                  [yahoo, nameKo, tapbitPair] (krstock only) }
//   async fetchMarket(resolved) -> { kind, symbol, display, [nameKo, tapbitPair],
//                                    candles, indicators, fundamentals:{lines},
//                                    news:{headlines}, sentiment:{lines}, priceLine,
//                                    intraday:{candles15m, summaryLines} }
//   async fetchTape()         -> [{ sym, price, changePct }]
//
// Failure policy: each source is best-effort. A failed source degrades to
// ["데이터 없음"] (or a fallback) and collection continues. Only a candle
// failure is fatal (throws) — everything downstream needs the price series.

const { computeIndicators } = require('./indicators.js');

const TIMEOUT_MS = 10000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function timeoutSignal() {
  return AbortSignal.timeout(TIMEOUT_MS);
}

// CoinGecko id map — symbol (upper) -> coingecko id. ~36 coins.
const COIN_IDS = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  XRP: 'ripple',
  DOGE: 'dogecoin',
  ADA: 'cardano',
  AVAX: 'avalanche-2',
  LINK: 'chainlink',
  DOT: 'polkadot',
  TRX: 'tron',
  BNB: 'binancecoin',
  SUI: 'sui',
  PEPE: 'pepe',
  MATIC: 'matic-network',
  LTC: 'litecoin',
  BCH: 'bitcoin-cash',
  ATOM: 'cosmos',
  UNI: 'uniswap',
  NEAR: 'near',
  APT: 'aptos',
  ARB: 'arbitrum',
  OP: 'optimism',
  FIL: 'filecoin',
  ICP: 'internet-computer',
  ETC: 'ethereum-classic',
  XLM: 'stellar',
  HBAR: 'hedera-hashgraph',
  VET: 'vechain',
  INJ: 'injective-protocol',
  RNDR: 'render-token',
  SHIB: 'shiba-inu',
  TON: 'the-open-network',
  AAVE: 'aave',
  MKR: 'maker',
  SEI: 'sei-network',
  TIA: 'celestia',
};

// English-ish names for news queries (fallback to the symbol itself).
const COIN_NAMES = {
  BTC: 'Bitcoin',
  ETH: 'Ethereum',
  SOL: 'Solana',
  XRP: 'Ripple XRP',
  DOGE: 'Dogecoin',
  ADA: 'Cardano',
  AVAX: 'Avalanche',
  LINK: 'Chainlink',
  DOT: 'Polkadot',
  TRX: 'Tron',
  BNB: 'BNB',
  SUI: 'Sui',
  PEPE: 'Pepe coin',
  MATIC: 'Polygon',
  LTC: 'Litecoin',
  BCH: 'Bitcoin Cash',
  ATOM: 'Cosmos',
  UNI: 'Uniswap',
  NEAR: 'Near Protocol',
  APT: 'Aptos',
  ARB: 'Arbitrum',
  OP: 'Optimism',
  FIL: 'Filecoin',
  ICP: 'Internet Computer',
  ETC: 'Ethereum Classic',
  XLM: 'Stellar',
  HBAR: 'Hedera',
  VET: 'VeChain',
  INJ: 'Injective',
  RNDR: 'Render',
  SHIB: 'Shiba Inu',
  TON: 'Toncoin',
  AAVE: 'Aave',
  MKR: 'Maker',
  SEI: 'Sei',
  TIA: 'Celestia',
};

// Korean stocks that back tapbit USDT-settled perpetual futures.
// symbol (canonical) -> { yahoo, display, nameKo, tapbitPair, perps, listings }
//
// `perps` — the SAME USDT-settled equity perpetual as the tapbit pair, listed
// across several venues. Tapbit's own endpoints (openapi.tapbit.com,
// www.tapbit.com) answer 403 from a CloudFront/Cloudflare edge with no keyless
// path around it, so these venues stand in: they price the identical
// underlying, so their index/mark prices bracket where tapbit's contract sits.
// Binance additionally serves klines, which is what makes the scalp desk able
// to read the 24/7 perpetual chart instead of the KRX session chart.
//
// `listings` — other places the same company trades, for the venue board.
const KR_STOCKS = {
  SKHYNIX: {
    yahoo: '000660.KS',
    display: 'SKHYNIX',
    nameKo: 'SK하이닉스',
    tapbitPair: 'SKHYNIX-USDT',
    perps: {
      binance: 'SKHYNIXUSDT',
      bybit: 'SKHYNIXUSDT',
      bitget: 'SKHYNIXUSDT',
      gate: 'SKHYNIX_USDT',
    },
    listings: [
      { label: '나스닥 SKHY', yahoo: 'SKHY', cs: '$' },
      { label: '프랑크푸르트 HY9', yahoo: 'HY9.F', cs: '€' },
    ],
  },
  SAMSUNG: {
    yahoo: '005930.KS',
    display: 'SAMSUNG',
    nameKo: '삼성전자',
    tapbitPair: 'SAMSUNG-USDT',
    perps: {
      binance: 'SAMSUNGUSDT',
      bybit: 'SAMSUNGUSDT',
      bitget: 'SAMSUNGUSDT',
      // Gate has no SAMSUNG_USDT contract (404/403 on the tickers endpoint).
      gate: null,
    },
    listings: [
      { label: '런던 GDR SMSN', yahoo: 'SMSN.IL', cs: '$' },
      { label: 'OTC SSNLF', yahoo: 'SSNLF', cs: '$' },
    ],
  },
};

// Alias -> canonical KR symbol. Matched case-insensitively (input is upper-cased;
// Korean text is unaffected by toUpperCase). Includes the KRX 6-digit codes.
const KR_ALIASES = {
  SKHYNIX: 'SKHYNIX',
  HYNIX: 'SKHYNIX',
  하이닉스: 'SKHYNIX',
  SK하이닉스: 'SKHYNIX',
  '000660': 'SKHYNIX',
  SAMSUNG: 'SAMSUNG',
  삼성전자: 'SAMSUNG',
  삼성: 'SAMSUNG',
  '005930': 'SAMSUNG',
};

// --- formatting helpers -------------------------------------------------

function fmtNum(n) {
  if (n == null || !Number.isFinite(Number(n))) return '-';
  n = Number(n);
  const abs = Math.abs(n);
  if (abs >= 1000) return Math.round(n).toLocaleString('en-US');
  if (abs >= 1) return n.toFixed(2);
  if (abs >= 0.01) return n.toFixed(4);
  if (abs === 0) return '0';
  return n.toPrecision(4);
}

function decodeEntities(s) {
  return String(s)
    .replace(/<!\[CDATA\[/g, '')
    .replace(/\]\]>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&#0*38;/g, '&')
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => {
      try {
        return String.fromCodePoint(Number(d));
      } catch {
        return '';
      }
    })
    .trim();
}

function relAge(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '';
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return '방금 전';
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  return `${day}일 전`;
}

// --- symbol resolution --------------------------------------------------

function resolveSymbol(input) {
  const raw = String(input == null ? '' : input).trim().toUpperCase();

  // Korean stock aliases take precedence over the crypto suffix handling so the
  // tapbit pair form (e.g. SKHYNIX-USDT / SAMSUNG-USDT) resolves to the KRX
  // underlying rather than being treated as a crypto ticker.
  let krProbe = raw;
  if (krProbe.endsWith('-USDT')) krProbe = krProbe.slice(0, -5);
  else if (krProbe.endsWith('USDT') && krProbe.length > 4) {
    krProbe = krProbe.slice(0, -4);
  }
  const krSym = KR_ALIASES[raw] || KR_ALIASES[krProbe];
  if (krSym) {
    const meta = KR_STOCKS[krSym];
    return {
      kind: 'krstock',
      symbol: krSym,
      display: meta.display,
      yahoo: meta.yahoo,
      nameKo: meta.nameKo,
      tapbitPair: meta.tapbitPair,
    };
  }

  let symbol = raw;
  let forcedCrypto = false;

  if (symbol.endsWith('-USDT')) {
    symbol = symbol.slice(0, -5);
    forcedCrypto = true;
  } else if (symbol.endsWith('USDT') && symbol.length > 4) {
    symbol = symbol.slice(0, -4);
    forcedCrypto = true;
  }

  if (COIN_IDS[symbol] || forcedCrypto) {
    return { kind: 'crypto', symbol, display: symbol };
  }
  return { kind: 'stock', symbol: raw, display: raw };
}

// --- crypto sources -----------------------------------------------------

async function fetchBinanceKlines(symbol) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=1d&limit=120`;
  const res = await fetch(url, { signal: timeoutSignal() });
  if (!res.ok) throw new Error(`Binance klines HTTP ${res.status}`);
  const arr = await res.json();
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error('Binance klines empty');
  }
  return arr.map((k) => ({
    t: k[0],
    o: parseFloat(k[1]),
    h: parseFloat(k[2]),
    l: parseFloat(k[3]),
    c: parseFloat(k[4]),
    v: parseFloat(k[5]),
  }));
}

async function fetchBinanceTicker(symbol, display) {
  const url = `https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}USDT`;
  const res = await fetch(url, { signal: timeoutSignal() });
  if (!res.ok) throw new Error(`Binance ticker HTTP ${res.status}`);
  const d = await res.json();
  const price = parseFloat(d.lastPrice);
  const chg = parseFloat(d.priceChangePercent);
  const vol = parseFloat(d.quoteVolume);
  return `${display} $${fmtNum(price)} (${chg >= 0 ? '+' : ''}${chg.toFixed(
    2
  )}% 24h) · 거래대금 $${fmtNum(vol)}`;
}

async function fetchCoinGecko(symbol) {
  const id = COIN_IDS[symbol];
  if (!id) return ['데이터 없음'];
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${id}`;
  const res = await fetch(url, {
    signal: timeoutSignal(),
    headers: { Accept: 'application/json', 'User-Agent': UA },
  });
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  const arr = await res.json();
  if (!Array.isArray(arr) || !arr[0]) throw new Error('CoinGecko empty');
  const d = arr[0];
  const lines = [];
  lines.push(
    `시가총액 $${fmtNum(d.market_cap)} (순위 ${d.market_cap_rank ?? '-'})`
  );
  lines.push(`24h 거래량 $${fmtNum(d.total_volume)}`);
  lines.push(
    `유통량 ${fmtNum(d.circulating_supply)} ${symbol}` +
      (d.max_supply ? ` / 최대 ${fmtNum(d.max_supply)}` : '')
  );
  if (d.ath != null) {
    lines.push(
      `ATH $${fmtNum(d.ath)} (ATH 대비 ${
        d.ath_change_percentage != null
          ? d.ath_change_percentage.toFixed(1) + '%'
          : '-'
      })`
    );
  }
  lines.push(`24h 고가 $${fmtNum(d.high_24h)} / 저가 $${fmtNum(d.low_24h)}`);
  return lines;
}

async function fetchFearGreed() {
  const url = 'https://api.alternative.me/fng/';
  const res = await fetch(url, { signal: timeoutSignal() });
  if (!res.ok) throw new Error(`F&G HTTP ${res.status}`);
  const d = await res.json();
  const item = d && d.data && d.data[0];
  if (!item) throw new Error('F&G empty');
  const clsKo =
    {
      'Extreme Fear': '극단적 공포',
      Fear: '공포',
      Neutral: '중립',
      Greed: '탐욕',
      'Extreme Greed': '극단적 탐욕',
    }[item.value_classification] || item.value_classification;
  return [`공포·탐욕 지수 ${item.value}/100 (${clsKo})`];
}

// --- stock source (Yahoo) ----------------------------------------------

// opts (all optional, used by the krstock path):
//   displayLabel   — label at the head of priceLine (defaults to `symbol`)
//   currencySymbol — price prefix, e.g. '$' or '₩' (default '$')
//   exchangeLabel  — override for the exchange name (default meta.exchangeName)
//   currencyWord   — trailing currency word in priceLine ('' to omit; default meta.currency)
//   tapbitLine     — extra fundamentals line appended verbatim
async function fetchYahooChart(symbol, opts = {}) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=6mo&interval=1d`;
  const res = await fetch(url, {
    signal: timeoutSignal(),
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Yahoo chart HTTP ${res.status}`);
  const d = await res.json();
  const r = d && d.chart && d.chart.result && d.chart.result[0];
  if (!r) {
    const msg =
      (d && d.chart && d.chart.error && d.chart.error.description) ||
      'Yahoo chart empty';
    throw new Error(msg);
  }
  const ts = r.timestamp || [];
  const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    const c = q.close ? q.close[i] : null;
    if (c == null) continue; // skip gap days Yahoo leaves null
    candles.push({
      t: ts[i] * 1000,
      o: q.open && q.open[i] != null ? q.open[i] : c,
      h: q.high && q.high[i] != null ? q.high[i] : c,
      l: q.low && q.low[i] != null ? q.low[i] : c,
      c,
      v: q.volume && q.volume[i] != null ? q.volume[i] : 0,
    });
  }
  if (candles.length === 0) throw new Error('Yahoo no candles');

  const m = r.meta || {};
  const lastClose = candles[candles.length - 1].c;
  const price = m.regularMarketPrice != null ? m.regularMarketPrice : lastClose;
  // Daily previous close = the prior trading day's close (candle-based), which
  // matches indicators.changePct24h. Deliberately NOT meta.chartPreviousClose,
  // which is the close before the whole 6-month range window (would report a
  // ~6-month move mislabeled as a daily change).
  const prev =
    candles.length >= 2
      ? candles[candles.length - 2].c
      : m.previousClose != null
      ? m.previousClose
      : m.chartPreviousClose != null
      ? m.chartPreviousClose
      : price;
  const chg = prev ? ((price - prev) / prev) * 100 : 0;

  const cs = opts.currencySymbol || '$';
  const label = opts.displayLabel || symbol;
  const exLabel =
    opts.exchangeLabel != null ? opts.exchangeLabel : m.exchangeName || '';
  const curWord =
    opts.currencyWord != null ? opts.currencyWord : m.currency || 'USD';

  const priceLine = `${label} ${cs}${fmtNum(price)} (${
    chg >= 0 ? '+' : ''
  }${chg.toFixed(2)}%) · ${exLabel}${curWord ? ' ' + curWord : ''}`.trim();

  const fundamentals = [];
  fundamentals.push(`현재가 ${cs}${fmtNum(price)} / 전일종가 ${cs}${fmtNum(prev)}`);
  if (m.fiftyTwoWeekHigh != null || m.fiftyTwoWeekLow != null) {
    fundamentals.push(
      `52주 고가 ${cs}${fmtNum(m.fiftyTwoWeekHigh)} / 저가 ${cs}${fmtNum(
        m.fiftyTwoWeekLow
      )}`
    );
  }
  if (m.regularMarketDayHigh != null || m.regularMarketDayLow != null) {
    fundamentals.push(
      `당일 고가 ${cs}${fmtNum(m.regularMarketDayHigh)} / 저가 ${cs}${fmtNum(
        m.regularMarketDayLow
      )}`
    );
  }
  if (m.regularMarketVolume != null) {
    fundamentals.push(`거래량 ${fmtNum(m.regularMarketVolume)}`);
  }
  fundamentals.push(
    `거래소 ${exLabel || '-'} · 통화 ${m.currency || '-'}`
  );
  if (opts.tapbitLine) fundamentals.push(opts.tapbitLine);

  return {
    candles,
    priceLine,
    fundamentals,
    quote: { price, prev, changePct: chg, currency: m.currency || '' },
  };
}

// --- intraday (15-minute) sources & summary ----------------------------

async function fetchBinanceIntraday(symbol) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=15m&limit=200`;
  const res = await fetch(url, { signal: timeoutSignal() });
  if (!res.ok) throw new Error(`Binance 15m HTTP ${res.status}`);
  const arr = await res.json();
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error('Binance 15m empty');
  }
  return arr.map((k) => ({
    t: k[0],
    o: parseFloat(k[1]),
    h: parseFloat(k[2]),
    l: parseFloat(k[3]),
    c: parseFloat(k[4]),
    v: parseFloat(k[5]),
  }));
}

async function fetchYahooIntraday(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=5d&interval=15m`;
  const res = await fetch(url, {
    signal: timeoutSignal(),
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Yahoo 15m HTTP ${res.status}`);
  const d = await res.json();
  const r = d && d.chart && d.chart.result && d.chart.result[0];
  if (!r) throw new Error('Yahoo 15m empty');
  const ts = r.timestamp || [];
  const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    const c = q.close ? q.close[i] : null;
    if (c == null) continue;
    candles.push({
      t: ts[i] * 1000,
      o: q.open && q.open[i] != null ? q.open[i] : c,
      h: q.high && q.high[i] != null ? q.high[i] : c,
      l: q.low && q.low[i] != null ? q.low[i] : c,
      c,
      v: q.volume && q.volume[i] != null ? q.volume[i] : 0,
    });
  }
  if (candles.length === 0) throw new Error('Yahoo 15m no candles');
  return candles;
}

// Session bucket key: UTC calendar date. A KRX (00–07 UTC) or US (13–21 UTC)
// trading session sits within one UTC date, and crypto's UTC day is the natural
// 24h boundary — so this cleanly separates "today" from "the prior session".
function intradayDayKey(t) {
  const d = new Date(t);
  return (
    d.getUTCFullYear() +
    '-' +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getUTCDate()).padStart(2, '0')
  );
}

// Build ~5 Korean scalping summary lines from 15-minute candles.
function intradaySummaryLines(candles, currencySymbol) {
  const cs = currencySymbol || '$';
  const n = candles.length;
  const price = Number(candles[n - 1].c);
  const sign = (x) => (x >= 0 ? '+' : '');

  // Split into per-session buckets.
  const sessions = [];
  let curKey = null;
  for (const k of candles) {
    const key = intradayDayKey(k.t);
    if (key !== curKey) {
      sessions.push([]);
      curKey = key;
    }
    sessions[sessions.length - 1].push(k);
  }
  const today = sessions[sessions.length - 1] || candles;
  const prevSession = sessions.length >= 2 ? sessions[sessions.length - 2] : null;

  const todayHigh = Math.max(...today.map((c) => Number(c.h)));
  const todayLow = Math.min(...today.map((c) => Number(c.l)));
  const dayRange = todayHigh - todayLow;
  const pos = dayRange > 0 ? ((price - todayLow) / dayRange) * 100 : 50;

  // ATR(14) over 15m bars — simple mean of the last 14 true ranges.
  const trs = [];
  for (let i = 1; i < n; i++) {
    const h = Number(candles[i].h);
    const l = Number(candles[i].l);
    const pc = Number(candles[i - 1].c);
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const atrPeriod = Math.min(14, trs.length);
  let atr = 0;
  for (let i = trs.length - atrPeriod; i < trs.length && atrPeriod > 0; i++) {
    atr += trs[i];
  }
  atr = atrPeriod > 0 ? atr / atrPeriod : 0;
  const atrPct = price ? (atr / price) * 100 : 0;

  // Momentum over the last ~4 hours (16 bars of 15m).
  const back = Math.min(16, n - 1);
  const refC = Number(candles[n - 1 - back].c);
  const mom = refC ? ((price - refC) / refC) * 100 : 0;

  // Volume flow: mean of the last 4 bars (1h) vs the 4 bars before that.
  const avgVol = (from, to) => {
    let s = 0;
    let cnt = 0;
    for (let i = from; i < to; i++) {
      if (i >= 0 && i < n) {
        s += Number(candles[i].v) || 0;
        cnt++;
      }
    }
    return cnt ? s / cnt : 0;
  };
  const recentVol = avgVol(n - 4, n);
  const priorVol = avgVol(n - 8, n - 4);
  const volChg = priorVol > 0 ? ((recentVol - priorVol) / priorVol) * 100 : 0;

  return [
    `당일 고가 ${cs}${fmtNum(todayHigh)} / 저가 ${cs}${fmtNum(
      todayLow
    )} · 현재가 ${cs}${fmtNum(price)} (레인지 ${pos.toFixed(0)}% 지점)`,
    prevSession
      ? `직전 세션 고가 ${cs}${fmtNum(
          Math.max(...prevSession.map((c) => Number(c.h)))
        )} / 저가 ${cs}${fmtNum(Math.min(...prevSession.map((c) => Number(c.l))))}`
      : '직전 세션 데이터 없음',
    `15분봉 ATR(14) ${cs}${fmtNum(atr)} (${atrPct.toFixed(2)}%)`,
    `최근 4시간 모멘텀 ${sign(mom)}${mom.toFixed(2)}%`,
    `거래량 최근 4봉 평균 ${fmtNum(recentVol)} (직전 4봉 대비 ${sign(
      volChg
    )}${volChg.toFixed(1)}%)`,
  ];
}

// Wrap raw 15m candles into the intraday field, never throwing.
function buildIntraday(candles, currencySymbol) {
  try {
    if (!Array.isArray(candles) || candles.length === 0) {
      return { candles15m: [], summaryLines: ['인트라데이 데이터 없음'] };
    }
    return {
      candles15m: candles,
      summaryLines: intradaySummaryLines(candles, currencySymbol),
    };
  } catch {
    return { candles15m: [], summaryLines: ['인트라데이 데이터 없음'] };
  }
}

// Lightweight Yahoo quote for the tape (price + % only).
async function fetchStockQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=5d&interval=1d`;
  const res = await fetch(url, {
    signal: timeoutSignal(),
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Yahoo quote HTTP ${res.status}`);
  const d = await res.json();
  const m =
    d && d.chart && d.chart.result && d.chart.result[0] && d.chart.result[0].meta;
  if (!m || m.regularMarketPrice == null) throw new Error('Yahoo quote no price');
  const price = m.regularMarketPrice;
  // previousClose = prior trading day. chartPreviousClose would be the close
  // before the whole 5d window (a ~week move), so it is last-resort only.
  const closes =
    (d.chart.result[0].indicators &&
      d.chart.result[0].indicators.quote &&
      d.chart.result[0].indicators.quote[0] &&
      d.chart.result[0].indicators.quote[0].close) ||
    [];
  const valid = closes.filter((c) => c != null);
  const prevCandle = valid.length >= 2 ? valid[valid.length - 2] : null;
  const prev =
    m.previousClose != null
      ? m.previousClose
      : prevCandle != null
      ? prevCandle
      : m.chartPreviousClose != null
      ? m.chartPreviousClose
      : price;
  const changePct = prev ? ((price - prev) / prev) * 100 : 0;
  return { price, changePct };
}

// --- FX + equity perpetuals + venue board -------------------------------

// USD/KRW. Yahoo first (intraday), exchangerate-api as the daily fallback.
async function fetchUsdKrw() {
  try {
    const res = await fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/KRW=X?range=1d&interval=1d',
      { signal: timeoutSignal(), headers: { 'User-Agent': UA, Accept: 'application/json' } }
    );
    if (!res.ok) throw new Error(`FX Yahoo HTTP ${res.status}`);
    const d = await res.json();
    const m = d && d.chart && d.chart.result && d.chart.result[0] && d.chart.result[0].meta;
    const rate = m && Number(m.regularMarketPrice);
    if (!rate || !Number.isFinite(rate)) throw new Error('FX Yahoo no rate');
    return { rate, source: 'Yahoo KRW=X' };
  } catch (_) {
    const res = await fetch('https://open.er-api.com/v6/latest/USD', {
      signal: timeoutSignal(),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`FX er-api HTTP ${res.status}`);
    const d = await res.json();
    const rate = d && d.rates && Number(d.rates.KRW);
    if (!rate || !Number.isFinite(rate)) throw new Error('FX er-api no KRW');
    return { rate, source: 'exchangerate-api' };
  }
}

const num = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

// Each venue fetcher returns a normalized quote or throws. Shape:
//   { venue, symbol, last, changePct, high24h, low24h, mark, index,
//     fundingPct, quoteVol, nextFunding }
async function fetchBinancePerp(symbol) {
  const [tickR, premR] = await Promise.allSettled([
    fetch(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${symbol}`, {
      signal: timeoutSignal(),
    }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))),
    fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`, {
      signal: timeoutSignal(),
    }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))),
  ]);
  if (tickR.status !== 'fulfilled') throw new Error('Binance perp ticker 실패');
  const t = tickR.value;
  const p = premR.status === 'fulfilled' ? premR.value : {};
  return {
    venue: '바이낸스',
    symbol,
    last: num(t.lastPrice),
    changePct: num(t.priceChangePercent),
    high24h: num(t.highPrice),
    low24h: num(t.lowPrice),
    quoteVol: num(t.quoteVolume),
    mark: num(p.markPrice),
    index: num(p.indexPrice),
    fundingPct: p.lastFundingRate != null ? num(p.lastFundingRate) * 100 : null,
    nextFunding: num(p.nextFundingTime),
  };
}

async function fetchBybitPerp(symbol) {
  const res = await fetch(
    `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`,
    { signal: timeoutSignal(), headers: { Accept: 'application/json' } }
  );
  if (!res.ok) throw new Error(`Bybit HTTP ${res.status}`);
  const d = await res.json();
  const t = d && d.result && Array.isArray(d.result.list) && d.result.list[0];
  if (!t) throw new Error('Bybit empty');
  return {
    venue: '바이비트',
    symbol,
    last: num(t.lastPrice),
    // price24hPcnt is a fraction (-0.052123), not a percent.
    changePct: t.price24hPcnt != null ? num(t.price24hPcnt) * 100 : null,
    high24h: num(t.highPrice24h),
    low24h: num(t.lowPrice24h),
    quoteVol: num(t.turnover24h),
    mark: num(t.markPrice),
    index: num(t.indexPrice),
    fundingPct: t.fundingRate != null ? num(t.fundingRate) * 100 : null,
    nextFunding: num(t.nextFundingTime),
  };
}

async function fetchBitgetPerp(symbol) {
  const res = await fetch(
    `https://api.bitget.com/api/v2/mix/market/ticker?symbol=${symbol}&productType=usdt-futures`,
    { signal: timeoutSignal(), headers: { Accept: 'application/json' } }
  );
  if (!res.ok) throw new Error(`Bitget HTTP ${res.status}`);
  const d = await res.json();
  const t = d && Array.isArray(d.data) && d.data[0];
  if (!t) throw new Error('Bitget empty');
  return {
    venue: '비트겟',
    symbol,
    last: num(t.lastPr),
    changePct: t.change24h != null ? num(t.change24h) * 100 : null,
    high24h: num(t.high24h),
    low24h: num(t.low24h),
    quoteVol: num(t.usdtVolume),
    mark: null,
    index: num(t.indexPrice),
    fundingPct: t.fundingRate != null ? num(t.fundingRate) * 100 : null,
    nextFunding: null,
  };
}

async function fetchGatePerp(contract) {
  const res = await fetch(
    `https://api.gateio.ws/api/v4/futures/usdt/tickers?contract=${contract}`,
    { signal: timeoutSignal(), headers: { Accept: 'application/json' } }
  );
  if (!res.ok) throw new Error(`Gate HTTP ${res.status}`);
  const arr = await res.json();
  const t = Array.isArray(arr) && arr[0];
  if (!t) throw new Error('Gate empty');
  return {
    venue: '게이트',
    symbol: contract,
    last: num(t.last),
    // change_percentage is already a percent string ("-4.96").
    changePct: num(t.change_percentage),
    high24h: num(t.high_24h),
    low24h: num(t.low_24h),
    quoteVol: num(t.volume_24h_quote),
    mark: num(t.mark_price),
    index: num(t.index_price),
    fundingPct: t.funding_rate != null ? num(t.funding_rate) * 100 : null,
    nextFunding: null,
  };
}

// Binance USDⓈ-M klines for the equity perpetual — 24/7, unlike the KRX session.
async function fetchPerpKlines(symbol, interval, limit) {
  const url =
    `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}` +
    `&interval=${interval}&limit=${limit}`;
  const res = await fetch(url, { signal: timeoutSignal() });
  if (!res.ok) throw new Error(`Perp klines HTTP ${res.status}`);
  const arr = await res.json();
  if (!Array.isArray(arr) || arr.length === 0) throw new Error('Perp klines empty');
  return arr.map((k) => ({
    t: k[0],
    o: parseFloat(k[1]),
    h: parseFloat(k[2]),
    l: parseFloat(k[3]),
    c: parseFloat(k[4]),
    v: parseFloat(k[5]),
  }));
}

// Yahoo quote + currency for a secondary listing row.
async function fetchListingQuote(yahooSym) {
  const res = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      yahooSym
    )}?range=5d&interval=1d`,
    { signal: timeoutSignal(), headers: { 'User-Agent': UA, Accept: 'application/json' } }
  );
  if (!res.ok) throw new Error(`Listing HTTP ${res.status}`);
  const d = await res.json();
  const r = d && d.chart && d.chart.result && d.chart.result[0];
  const m = r && r.meta;
  if (!m || m.regularMarketPrice == null) throw new Error('Listing no price');
  const closes =
    (r.indicators && r.indicators.quote && r.indicators.quote[0] &&
      r.indicators.quote[0].close) || [];
  const valid = closes.filter((c) => c != null);
  const prev =
    m.previousClose != null
      ? m.previousClose
      : valid.length >= 2
      ? valid[valid.length - 2]
      : null;
  const price = Number(m.regularMarketPrice);
  return {
    price,
    changePct: prev ? ((price - prev) / prev) * 100 : null,
    currency: m.currency || '',
    exchange: m.fullExchangeName || '',
  };
}

function pctStr(n, dp = 2) {
  if (n == null || !Number.isFinite(n)) return '-';
  return `${n >= 0 ? '+' : ''}${n.toFixed(dp)}%`;
}

// fmtNum rounds anything >= 1000 to whole units, which would hide the cents on
// an FX rate (1,450.38 -> 1,450). Rates keep two decimals.
function fmtRate(n) {
  if (n == null || !Number.isFinite(Number(n))) return '-';
  return Number(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function hhmmUtcKst(ms) {
  if (!ms) return null;
  const d = new Date(ms + 9 * 3600 * 1000); // KST
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(
    d.getUTCMinutes()
  ).padStart(2, '0')}`;
}

// Multi-venue price board ("전광판") for a KR stock that has a USDT perpetual.
// Every source is best-effort; a dead source becomes a row with note only.
// Returns { rows, lines, fx, krw, perpAvg, premiumPct }.
async function fetchPriceBoard(resolved, krQuote) {
  const meta = KR_STOCKS[resolved.symbol] || {};
  const perps = meta.perps || {};
  const listings = meta.listings || [];

  const jobs = [
    fetchUsdKrw(),
    perps.binance ? fetchBinancePerp(perps.binance) : Promise.reject(new Error('미상장')),
    perps.bybit ? fetchBybitPerp(perps.bybit) : Promise.reject(new Error('미상장')),
    perps.bitget ? fetchBitgetPerp(perps.bitget) : Promise.reject(new Error('미상장')),
    perps.gate ? fetchGatePerp(perps.gate) : Promise.reject(new Error('미상장')),
    ...listings.map((l) => fetchListingQuote(l.yahoo)),
  ];
  const settled = await Promise.allSettled(jobs);
  const [fxR, binR, bybR, bitR, gatR, ...listRs] = settled;

  const fx = fxR.status === 'fulfilled' ? fxR.value : null;
  const perpQuotes = [binR, bybR, bitR, gatR]
    .filter((r) => r.status === 'fulfilled')
    .map((r) => r.value);

  const rows = [];
  const lines = [];

  // 1) FX
  if (fx) {
    rows.push({
      key: 'fx',
      label: '환율 USD/KRW',
      price: fx.rate,
      cs: '₩',
      decimals: 2,
      note: fx.source,
    });
    lines.push(`환율 USD/KRW ${fmtRate(fx.rate)} (${fx.source})`);
  } else {
    rows.push({ key: 'fx', label: '환율 USD/KRW', price: null, note: '데이터 없음' });
    lines.push('환율 USD/KRW 데이터 없음 — 원화 환산 불가');
  }

  // 2) KRX spot (+ USD equivalent)
  const krPrice = krQuote && Number.isFinite(krQuote.price) ? krQuote.price : null;
  const krUsd = krPrice != null && fx ? krPrice / fx.rate : null;
  const krCode = String(resolved.yahoo || '').replace(/\.KS$/i, '');
  rows.push({
    key: 'krx',
    label: `KRX ${krCode} 현물`,
    price: krPrice,
    cs: '₩',
    changePct: krQuote ? krQuote.changePct : null,
    usd: krUsd,
    note: 'KRX 09:00-15:30 KST',
  });
  lines.push(
    `KRX ${krCode} 현물 ₩${fmtNum(krPrice)} (${pctStr(
      krQuote ? krQuote.changePct : null
    )})` + (krUsd != null ? ` → USD 환산 $${fmtNum(krUsd)}` : '')
  );

  // 3) Tapbit — the venue the user actually trades on. Not directly quotable.
  const perpAvg = perpQuotes.length
    ? perpQuotes.reduce((s, q) => s + (q.last || 0), 0) / perpQuotes.length
    : null;
  rows.push({
    key: 'tapbit',
    label: `탭비트 ${resolved.tapbitPair} 20x`,
    price: perpAvg,
    cs: '$',
    estimated: true,
    note: perpQuotes.length
      ? `직접 조회 불가(API 차단) — 동일 기초자산 ${perpQuotes.length}개 거래소 평균`
      : '직접 조회 불가(API 차단)',
  });
  lines.push(
    `탭비트 ${resolved.tapbitPair} 20x: 공식 API 차단(403)으로 직접 조회 불가 — ` +
      (perpAvg != null
        ? `동일 기초자산 무기한 선물 ${perpQuotes.length}곳 평균 $${fmtNum(
            perpAvg
          )}로 대체(추정)`
        : '대체 시세도 없음')
  );

  // 4) Each perpetual venue
  for (const q of perpQuotes) {
    rows.push({
      key: 'perp:' + q.venue,
      label: `${q.venue} ${q.symbol}`,
      price: q.last,
      cs: '$',
      changePct: q.changePct,
      mark: q.mark,
      index: q.index,
      fundingPct: q.fundingPct,
      quoteVol: q.quoteVol,
      krw: fx && q.last != null ? q.last * fx.rate : null,
      note: '무기한 선물 · 24시간',
    });
    const bits = [`${q.venue} ${q.symbol} $${fmtNum(q.last)} (${pctStr(q.changePct)})`];
    if (q.mark != null) bits.push(`마크 ${fmtNum(q.mark)}`);
    if (q.index != null) bits.push(`지수 ${fmtNum(q.index)}`);
    if (q.fundingPct != null) bits.push(`펀딩 ${pctStr(q.fundingPct, 4)}`);
    if (q.high24h != null) bits.push(`24h 고 ${fmtNum(q.high24h)}/저 ${fmtNum(q.low24h)}`);
    if (q.quoteVol != null) bits.push(`거래대금 $${fmtNum(q.quoteVol)}`);
    const nf = hhmmUtcKst(q.nextFunding);
    if (nf) bits.push(`다음 펀딩 ${nf} KST`);
    lines.push(bits.join(' · '));
  }

  // 5) The number that matters: perp vs KRX close, in won.
  let premiumPct = null;
  if (perpAvg != null && fx && krPrice) {
    const perpKrw = perpAvg * fx.rate;
    premiumPct = ((perpKrw - krPrice) / krPrice) * 100;
    rows.push({
      key: 'premium',
      label: '선물↔KRX 괴리',
      price: perpKrw,
      cs: '₩',
      changePct: premiumPct,
      note: '선물 평균 원화 환산 vs KRX 종가',
    });
    lines.push(
      `선물 평균 $${fmtNum(perpAvg)} → 원화 환산 ₩${fmtNum(perpKrw)} · ` +
        `KRX 대비 ${pctStr(premiumPct)} (KRX 마감 후 24시간 시장이 매긴 값)`
    );
  }

  // 6) Other listings of the same company
  listings.forEach((l, i) => {
    const r = listRs[i];
    if (!r || r.status !== 'fulfilled') {
      rows.push({ key: 'listing:' + l.yahoo, label: l.label, price: null, note: '데이터 없음' });
      lines.push(`${l.label}: 데이터 없음`);
      return;
    }
    const q = r.value;
    const cs = q.currency === 'EUR' ? '€' : q.currency === 'USD' ? '$' : '';
    // The ADR/GDR share ratio is not published in this feed, so derive it and
    // label it as derived rather than asserting a 1:1 relationship.
    const ratio = krUsd != null && q.price && q.currency === 'USD' ? krUsd / q.price : null;
    rows.push({
      key: 'listing:' + l.yahoo,
      label: l.label,
      price: q.price,
      cs,
      changePct: q.changePct,
      note: q.exchange + (ratio ? ` · 환산배율 ${ratio.toFixed(2)}(추정)` : ''),
    });
    lines.push(
      `${l.label} ${cs}${fmtNum(q.price)} (${pctStr(q.changePct)}) · ${q.exchange}` +
        (ratio ? ` · 1주 대비 환산배율 ${ratio.toFixed(2)}배(추정)` : '')
    );
  });

  // 7) CME — asked for explicitly, so answer it explicitly instead of omitting.
  rows.push({
    key: 'cme',
    label: 'CME',
    price: null,
    note: '한국 개별주식 선물 미상장 — 해당 상품 없음',
  });
  lines.push('CME: 한국 개별주식(SK하이닉스·삼성전자) 선물 미상장 — 비교 대상 없음');

  return { rows, lines, fx, perpAvg, premiumPct, generatedAt: Date.now() };
}

// Standalone board fetch for the UI: resolve the input, grab the KRX quote,
// then build the board. Returns null for symbols with no perpetual pair.
async function fetchVenueBoard(input) {
  const resolved = resolveSymbol(input);
  if (resolved.kind !== 'krstock') return null;
  let krQuote = null;
  try {
    krQuote = await fetchListingQuote(resolved.yahoo);
  } catch (_) {}
  const board = await fetchPriceBoard(resolved, krQuote);
  return {
    symbol: resolved.symbol,
    display: resolved.display,
    nameKo: resolved.nameKo,
    tapbitPair: resolved.tapbitPair,
    ...board,
  };
}

// --- news (Google News RSS) --------------------------------------------

function newsQuery(resolved) {
  if (resolved.kind === 'crypto') {
    const name = COIN_NAMES[resolved.symbol] || resolved.symbol;
    return `${name} ${resolved.symbol} 코인`;
  }
  if (resolved.kind === 'krstock') {
    return `${resolved.nameKo || resolved.symbol} 주가`;
  }
  return `${resolved.symbol} 주가`;
}

async function fetchNews(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(
    query
  )}&hl=ko&gl=KR&ceid=KR:ko`;
  const res = await fetch(url, {
    signal: timeoutSignal(),
    headers: { 'User-Agent': UA },
  });
  if (!res.ok) throw new Error(`News HTTP ${res.status}`);
  const xml = await res.text();
  const items = xml.split('<item>').slice(1);
  const headlines = [];
  for (const it of items) {
    const tm = it.match(/<title>([\s\S]*?)<\/title>/);
    if (!tm) continue;
    const title = decodeEntities(tm[1]);
    if (!title) continue;
    const pm = it.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    headlines.push({ title, age: pm ? relAge(pm[1]) : '' });
    if (headlines.length >= 8) break;
  }
  if (headlines.length === 0) throw new Error('News empty');
  return headlines;
}

// --- main aggregation ---------------------------------------------------

async function fetchMarket(resolved) {
  const { kind, symbol, display } = resolved;

  let candles;
  let priceLine = '데이터 없음';
  const fundamentals = { lines: ['데이터 없음'] };
  const sentiment = { lines: ['데이터 없음'] };
  const news = { headlines: [] };
  let intraday = { candles15m: [], summaryLines: ['인트라데이 데이터 없음'] };
  let board = null; // multi-venue price board (KR stocks only)
  let perp = null; // USDT perpetual view used by the scalp desk

  if (kind === 'crypto') {
    // Candles are fatal.
    candles = await fetchBinanceKlines(symbol);

    const [tickerR, cgR, fngR, newsR, intraR] = await Promise.allSettled([
      fetchBinanceTicker(symbol, display),
      fetchCoinGecko(symbol),
      fetchFearGreed(),
      fetchNews(newsQuery(resolved)),
      fetchBinanceIntraday(symbol),
    ]);
    if (tickerR.status === 'fulfilled') priceLine = tickerR.value;
    if (cgR.status === 'fulfilled') fundamentals.lines = cgR.value;
    if (fngR.status === 'fulfilled') sentiment.lines = fngR.value;
    if (newsR.status === 'fulfilled') news.headlines = newsR.value;
    if (intraR.status === 'fulfilled') intraday = buildIntraday(intraR.value, '$');
  } else if (kind === 'krstock') {
    // Korean stock: reuse the Yahoo chart path with the KRX yahoo symbol and
    // KRW-flavoured labels; add the tapbit perpetual-futures fundamentals line.
    const krCode = String(resolved.yahoo || '').replace(/\.KS$/i, '');
    const yq = await fetchYahooChart(resolved.yahoo, {
      displayLabel: resolved.nameKo,
      currencySymbol: '₩',
      exchangeLabel: 'KRX',
      currencyWord: '',
      tapbitLine: `탭비트 무기한 선물: ${resolved.tapbitPair} (USDT 결제, 기초자산 KRX ${krCode})`,
    });
    candles = yq.candles;
    priceLine = yq.priceLine;
    fundamentals.lines = yq.fundamentals.length ? yq.fundamentals : ['데이터 없음'];
    sentiment.lines = ['주식은 공포·탐욕 지수 미적용 — 뉴스 헤드라인으로 심리 판단'];

    const perpSym = ((KR_STOCKS[symbol] || {}).perps || {}).binance || null;
    const [newsR, intraR, boardR, k15R, k1dR] = await Promise.allSettled([
      fetchNews(newsQuery(resolved)),
      fetchYahooIntraday(resolved.yahoo),
      fetchPriceBoard(resolved, yq.quote),
      perpSym ? fetchPerpKlines(perpSym, '15m', 200) : Promise.reject(new Error('미상장')),
      perpSym ? fetchPerpKlines(perpSym, '1d', 120) : Promise.reject(new Error('미상장')),
    ]);
    if (newsR.status === 'fulfilled') news.headlines = newsR.value;
    if (intraR.status === 'fulfilled') intraday = buildIntraday(intraR.value, '₩');
    if (boardR.status === 'fulfilled') board = boardR.value;

    // The tapbit contract is a 24/7 USDT perpetual, so the scalp desk reads
    // this chart — not the KRX session chart, which is stale outside 09:00–15:30
    // KST and denominated in a currency the position is not settled in.
    if (k15R.status === 'fulfilled' || k1dR.status === 'fulfilled') {
      const c15 = k15R.status === 'fulfilled' ? k15R.value : [];
      const c1d = k1dR.status === 'fulfilled' ? k1dR.value : [];
      let perpIndicators = null;
      try {
        if (c1d.length) perpIndicators = computeIndicators(c1d);
      } catch (_) {}
      const boardPerp =
        board && Array.isArray(board.rows)
          ? board.rows.find((r) => r.key === 'perp:바이낸스')
          : null;
      const perpPrice = c15.length ? Number(c15[c15.length - 1].c) : null;
      perp = {
        pair: resolved.tapbitPair,
        venueSymbol: perpSym,
        source: `바이낸스 ${perpSym} 무기한 (탭비트 ${resolved.tapbitPair}와 동일 기초자산)`,
        candles15m: c15,
        candles1d: c1d,
        indicators: perpIndicators,
        intraday: buildIntraday(c15, '$'),
        priceLine:
          perpPrice != null
            ? `${resolved.tapbitPair} $${fmtNum(perpPrice)} (${pctStr(
                boardPerp ? boardPerp.changePct : null
              )} 24h) · USDT 무기한`
            : '데이터 없음',
        krwPerUsd: board && board.fx ? board.fx.rate : null,
      };
    }
  } else {
    // Stock: Yahoo chart supplies candles (fatal), priceLine and fundamentals.
    const yq = await fetchYahooChart(symbol);
    candles = yq.candles;
    priceLine = yq.priceLine;
    fundamentals.lines = yq.fundamentals.length ? yq.fundamentals : ['데이터 없음'];
    sentiment.lines = ['주식은 공포·탐욕 지수 미적용 — 뉴스 헤드라인으로 심리 판단'];

    const [newsR, intraR] = await Promise.allSettled([
      fetchNews(newsQuery(resolved)),
      fetchYahooIntraday(symbol),
    ]);
    if (newsR.status === 'fulfilled') news.headlines = newsR.value;
    if (intraR.status === 'fulfilled') intraday = buildIntraday(intraR.value, '$');
  }

  const indicators = computeIndicators(candles);

  // If the dedicated ticker/price line failed, synthesize one from indicators.
  if (priceLine === '데이터 없음' && indicators && indicators.price) {
    const chg = indicators.changePct24h;
    priceLine = `${display} $${fmtNum(indicators.price)} (${
      chg >= 0 ? '+' : ''
    }${chg.toFixed(2)}%)`;
  }
  if (news.headlines.length === 0) {
    news.headlines = [{ title: '데이터 없음', age: '' }];
  }

  return {
    kind,
    symbol,
    display,
    // Surface the KR-stock metadata on the market object itself so downstream
    // prompt builders (agents.js) can read market.nameKo / market.tapbitPair.
    ...(resolved.nameKo ? { nameKo: resolved.nameKo } : {}),
    ...(resolved.tapbitPair ? { tapbitPair: resolved.tapbitPair } : {}),
    candles,
    indicators,
    fundamentals,
    news,
    sentiment,
    priceLine,
    intraday,
    ...(board ? { board } : {}),
    ...(perp ? { perp } : {}),
  };
}

// --- tape (bottom ticker) ----------------------------------------------

async function fetchTape() {
  const order = [
    'BTC',
    'ETH',
    'SOL',
    'XRP',
    'TSLA',
    'NVDA',
    'AAPL',
    'MSFT',
    'SKHYNIX',
    'SAMSUNG',
  ];
  const cryptoSet = new Set(['BTC', 'ETH', 'SOL', 'XRP']);
  // Tape label -> Yahoo symbol for KR stocks (label stays SKHYNIX/SAMSUNG).
  const yahooOverride = { SKHYNIX: '000660.KS', SAMSUNG: '005930.KS' };
  const results = {};

  await Promise.allSettled(
    order.map(async (sym) => {
      if (cryptoSet.has(sym)) {
        const res = await fetch(
          `https://api.binance.com/api/v3/ticker/24hr?symbol=${sym}USDT`,
          { signal: timeoutSignal() }
        );
        if (!res.ok) throw new Error(`tape ${sym} HTTP ${res.status}`);
        const d = await res.json();
        results[sym] = {
          sym,
          price: parseFloat(d.lastPrice),
          changePct: parseFloat(d.priceChangePercent),
        };
      } else {
        const q = await fetchStockQuote(yahooOverride[sym] || sym);
        results[sym] = { sym, price: q.price, changePct: q.changePct };
      }
    })
  );

  // Preserve declared order; drop failed items.
  return order.filter((s) => results[s]).map((s) => results[s]);
}

module.exports = {
  resolveSymbol,
  fetchMarket,
  fetchTape,
  fetchPriceBoard,
  fetchVenueBoard,
  fetchUsdKrw,
  fetchPerpKlines,
  COIN_IDS,
  KR_STOCKS,
};
