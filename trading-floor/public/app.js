/* ==========================================================================
   PIXEL TRADING FLOOR — app.js
   SSE 구독 → 픽셀 오피스 UI 실시간 중계. 바닐라 JS, 외부 라이브러리 없음.
   ========================================================================== */
'use strict';

/* --------------------------------------------------------------------------
   1. 캐릭터 스프라이트 데이터 (16×16 매트릭스 → 48×48 fillRect, 픽셀=3)
   문자→색 팔레트 방식. '.' 은 투명.
   -------------------------------------------------------------------------- */
const SPRITE_ROWS = [
  "................", // 0
  ".....HHHHHH.....", // 1  머리 위
  "...HHHHHHHHHH...", // 2
  "..HHHHHHHHHHHH..", // 3
  "..HHssssssssHH..", // 4  이마
  "..HssEEssEEssH..", // 5  눈 2px ×2
  "..HssssssssssH..", // 6
  "...ssssMMssss...", // 7  입 2px
  "....ssssssss....", // 8  턱
  "...BBBBBBBBBB...", // 9  어깨
  "..BBBBBBBBBBBB..", // 10 몸통(블롭)
  "..BBBBDDDDBBBB..", // 11 옷 디테일
  "..BBBBBBBBBBBB..", // 12
  "..BBBBBBBBBBBB..", // 13
  "...BBBBBBBBBB...", // 14
  "....BBBBBBBB...."  // 15 둥근 바닥
];

// 캐릭터별 팔레트 + 액세서리(특정 행 오버라이드)
const CHARACTERS = {
  taro: { // 파란 모자 + 헤드셋
    palette: { H:'#3b6fd4', s:'#f0c8a0', E:'#241a2e', M:'#b85c56', B:'#2b4a8a', D:'#1e3566', X:'#22222e' },
    overrides: {
      5: ".XHssEEssEEssHX.", // 헤드셋 이어컵
      6: ".XHssssssssssHX."
    }
  },
  diana: { // 갈색 단발
    palette: { H:'#8a5a34', s:'#f2cda4', E:'#241a2e', M:'#b85c56', B:'#a94f6b', D:'#7d3a52' },
    overrides: { 7: "..HssssMMssssH.." } // 단발이 볼까지
  },
  nova: { // 노란 머리
    palette: { H:'#e8c84a', s:'#f0c8a0', E:'#241a2e', M:'#b85c56', B:'#3f9d78', D:'#2c7357' },
    overrides: {}
  },
  vibe: { // 보라 후드
    palette: { H:'#7a4bc4', s:'#f0c8a0', E:'#241a2e', M:'#b85c56', B:'#5f3a9e', D:'#452b73' },
    overrides: { 7: "..HssssMMssssH.." } // 후드가 얼굴을 감쌈
  },
  bull: { // 주황 몸 + 뿔 2개
    palette: { H:'#e08a3c', s:'#f6b06a', E:'#241a2e', M:'#7a3b1e', B:'#d97b2e', D:'#b25f1c', X:'#f2e9d0' },
    overrides: {
      0: "...X........X...", // 뿔 끝
      1: "..XXHHHHHHHHXX.."  // 뿔 밑동
    }
  },
  bear: { // 빨간 몸 + 둥근 곰귀
    palette: { H:'#c0392b', s:'#e88a7a', E:'#241a2e', M:'#7a2318', B:'#b03328', D:'#8a2418' },
    overrides: {
      1: "..HH........HH.." // 곰귀 2개
    }
  },
  ace: { // 금발 + 선글라스
    palette: { H:'#e8c86a', s:'#f0c8a0', E:'#241a2e', M:'#b85c56', B:'#2a2a34', D:'#c9a84a', X:'#141018' },
    overrides: {
      5: "..HssXXXXXXssH..", // 선글라스
      12: "..BBBBBDDBBBBB.." // 금색 넥타이
    }
  },
  blitz: { // 시안/일렉트릭 블루 + 노란 바이저·번개
    palette: { H:'#22d3ee', s:'#f0c8a0', E:'#241a2e', M:'#0e4a5a', B:'#1f6feb', D:'#22d3ee', X:'#ffd60a' },
    overrides: {
      5:  "..HssXXXXXXssH..", // 노란 바이저
      10: "..BBBBBXXBBBBB..", // 번개 (지그재그)
      11: "..BBBBXXBBBBBB..",
      12: "..BBBXXXXBBBBB..",
      13: "..BBBBBXXBBBBB.."
    }
  },
  guard: { // 스틸 그레이 + 헬멧·방패
    palette: { H:'#9aa4b2', s:'#e8c4a0', E:'#241a2e', M:'#7a5c4a', B:'#4b5563', D:'#374151', X:'#cbd5e1' },
    overrides: {
      4:  "..HHHHHHHHHHHH..", // 헬멧이 이마까지
      10: "..BBBBXXXXBBBB..", // 방패 엠블럼
      11: "..BBBBXXXXBBBB..",
      12: "..BBBBXXXXBBBB..",
      13: "..BBBBBXXBBBBB.."  // 방패 하단 테이퍼
    }
  },
  risky: { // 주황·공격적 — 뾰족한 스파이크 머리 + 상승 화살표
    palette: { H:'#ff7a3c', s:'#f6b06a', E:'#241a2e', M:'#7a3b1e', B:'#e2582a', D:'#b23c18', X:'#ffd60a' },
    overrides: {
      0: "....X..X..X.....", // 스파이크 끝
      1: "...XHHHHHHHHX...",
      11:"..BBBBBXXBBBBB..", // 위로 향한 화살표
      12:"..BBBBXXXXBBBB..",
      13:"..BBBXXXXXXBBB.."
    }
  },
  neutral: { // 회청 — 평평한 저울 느낌
    palette: { H:'#7f93b0', s:'#eec9a4', E:'#241a2e', M:'#6a5040', B:'#5a6b82', D:'#42505f', X:'#c8d4e2' },
    overrides: {
      11:"..BBXXXXXXXXBB..", // 수평 저울대
      12:"..BBBBBXXBBBBB.."
    }
  },
  safe: { // 짙은 청록 + 방패
    palette: { H:'#2f9e8f', s:'#e8c4a0', E:'#241a2e', M:'#5a4436', B:'#1f6d63', D:'#14504a', X:'#a7e8dd' },
    overrides: {
      4: "..HHHHHHHHHHHH..", // 헬멧
      10:"..BBXXXXXXXXBB..", // 큰 방패
      11:"..BBXXXXXXXXBB..",
      12:"..BBBXXXXXXBBB..",
      13:"..BBBBXXXXBBBB.."
    }
  },
  pm: { // 검정 정장 + 금 넥타이 (ACE보다 격식)
    palette: { H:'#3a3a46', s:'#efc9a2', E:'#241a2e', M:'#8a5148', B:'#15151f', D:'#d4af37', X:'#f2f2f8' },
    overrides: {
      9: "...BBBXXXXBBB...", // 흰 셔츠 카라
      10:"..BBBXDDXBBBBB..", // 금 넥타이 매듭
      11:"..BBBBXDDXBBBB..",
      12:"..BBBBBDDBBBBB..",
      13:"..BBBBBDDBBBBB.."
    }
  }
};

const AGENT_IDS = ['taro','diana','nova','vibe','bull','bear','blitz','guard','risky','neutral','safe','ace','pm'];
const NAMES = { taro:'TARO', diana:'DIANA', nova:'NOVA', vibe:'VIBE', bull:'BULL', bear:'BEAR', blitz:'BLITZ', guard:'GUARD', risky:'RISKY', neutral:'NEUTRAL', safe:'SAFE', ace:'ACE', pm:'PM' };
// 콘솔 로그의 이름 배지 색 + 역할 라벨
const AGENT_TINT = {
  taro:'#3b6fd4', diana:'#a94f6b', nova:'#e8c84a', vibe:'#7a4bc4',
  bull:'#e08a3c', bear:'#c0392b', blitz:'#22d3ee', guard:'#9aa4b2',
  risky:'#ff7a3c', neutral:'#7f93b0', safe:'#2f9e8f', ace:'#e8c86a', pm:'#d4af37',
};
const ROLES = {
  taro:'기술적 분석', diana:'기본적 분석', nova:'뉴스 분석', vibe:'센티먼트',
  bull:'매수 논거', bear:'매도 논거', blitz:'스캘퍼', guard:'리스크 관리',
  risky:'공격적 리스크', neutral:'중립적 리스크', safe:'보수적 리스크',
  ace:'수석 트레이더', pm:'포트폴리오 매니저',
};
const DEBATE_IDS = ['bull','bear','risky','neutral','safe'];
const DECISION_COLORS = { BUY:'#3fb950', SELL:'#f85149', HOLD:'#d29922' };
const DEMO = new URLSearchParams(location.search).get('demo') === '1';
// ?still=1 — 타자기 효과를 끄고 즉시 전체 텍스트를 표시한다(스크린샷·문서 캡처용)
const STILL = new URLSearchParams(location.search).get('still') === '1';

/* --------------------------------------------------------------------------
   2. 유틸
   -------------------------------------------------------------------------- */
const qs = (sel) => document.querySelector(sel);
const deskEl = (id) => document.getElementById('desk-' + id);

function drawSprite(canvas, id) {
  const ch = CHARACTERS[id];
  if (!ch || !canvas) return;
  const ctx = canvas.getContext('2d');
  const px = canvas.width / 16; // 48 / 16 = 3
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let r = 0; r < 16; r++) {
    const row = (ch.overrides && ch.overrides[r]) || SPRITE_ROWS[r];
    for (let c = 0; c < 16; c++) {
      const color = ch.palette[row[c]];
      if (color) {
        ctx.fillStyle = color;
        ctx.fillRect(c * px, r * px, px, px);
      }
    }
  }
}

function fmtNumber(n) {
  const num = typeof n === 'number' ? n : parseFloat(String(n).replace(/,/g, ''));
  if (!isFinite(num)) return String(n);
  const abs = Math.abs(num);
  const maxFrac = abs >= 1 ? 2 : 6;
  return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: maxFrac });
}

// priceLine 문자열 + candles 에서 가격/등락% 추출 (형식 유연 대응)
function parsePriceLine(line, candles) {
  let price = '', change = '', pct = null;
  if (line) {
    const pctM = String(line).match(/([+-]?\d+(?:\.\d+)?)\s*%/);
    if (pctM) { pct = parseFloat(pctM[1]); change = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%'; }
    const priceM = String(line).match(/\$?\s*([\d,]+(?:\.\d+)?)/);
    if (priceM) price = priceM[1];
  }
  if (!price && candles && candles.length) price = fmtNumber(candles[candles.length - 1].c);
  return { price, change, pct };
}

function shortPath(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1];
}

/* --------------------------------------------------------------------------
   3. 말풍선 (타이핑/타자기)
   -------------------------------------------------------------------------- */
const typers = {}; // id -> interval id

function resetBubble(id) {
  const desk = deskEl(id);
  if (!desk) return;
  desk.classList.remove('bounce');
  desk.classList.remove('spotlight');
  const b = desk.querySelector('.bubble');
  clearInterval(typers[id]);
  b.classList.remove('show');
  b.textContent = '';
  delete b.dataset.report;
}

function showThinking(id) {
  const desk = deskEl(id);
  if (!desk) return;
  desk.classList.add('bounce');
  const b = desk.querySelector('.bubble');
  clearInterval(typers[id]);
  b.classList.add('show');
  b.innerHTML = '<span class="dots"><i>.</i><i>.</i><i>.</i></span>';
}

function typeBubble(id, text, report) {
  const desk = deskEl(id);
  if (!desk) return;
  const b = desk.querySelector('.bubble');
  clearInterval(typers[id]);
  b.classList.add('show');
  b.dataset.name = NAMES[id] || id.toUpperCase();
  if (report != null && report !== '') b.dataset.report = report;
  const full = String(text || '');
  if (STILL) { desk.classList.remove('bounce'); b.textContent = full; return; }
  b.textContent = '';
  // 말하는 동안에도 상하로 흔들린다 (기존 bounce 재사용) — 다 말하면 멈춘다
  desk.classList.add('bounce');
  let i = 0;
  typers[id] = setInterval(() => {
    i += 1;
    b.textContent = full.slice(0, i);
    if (i % 3 === 0) sfxTick();               // 8비트 타이핑 틱
    if (i >= full.length) {
      clearInterval(typers[id]);
      desk.classList.remove('bounce');
    }
  }, 20);
}

/* --------------------------------------------------------------------------
   4. 전광판 + 차트
   -------------------------------------------------------------------------- */
let lastCandles = null; // 리사이즈 재렌더용

function updateBoard(ev) {
  qs('#board-symbol').textContent = ev.display || ev.symbol || '—';
  const p = parsePriceLine(ev.priceLine, ev.candles);
  // 통화 기호는 priceLine을 따른다 (한국주식 ₩, 그 외 $)
  const cur = ev.priceLine && ev.priceLine.includes('₩') ? '₩' : '$';
  qs('#board-price').textContent = p.price ? cur + p.price : (ev.priceLine || '—');
  const chEl = qs('#board-change');
  chEl.textContent = p.change || '';
  chEl.className = (p.pct == null) ? '' : (p.pct >= 0 ? 'up' : 'down');
  lastCandles = ev.candles || null;
  drawChart(ev.candles);
  updateMarketBadge(ev);
  // 콘솔 상단에 수집 완료를 알리는 합성 로그 (서버가 log 이벤트를 안 보내는 구버전 대비)
  if (!serverLogs) {
    pushLog('sys', `> ${ev.display || ev.symbol} 시세 수신 완료`);
    if (ev.priceLine) pushLog('sys', `> ${ev.priceLine}`);
  }

  // 분석 대상이 무기한 선물 페어가 있는 KR 주식이면 전광판도 그 심볼로 맞춘다.
  const sym = String(ev.symbol || '').toUpperCase();
  if ((sym === 'SKHYNIX' || sym === 'SAMSUNG') && sym !== boardSymbol) {
    boardSymbol = sym;
    loadVenueBoard();
  }
}

// 단순이동평균 — 서버를 건드리지 않고 프론트에서 계산한다(구간 부족 구간은 null)
function sma(arr, n) {
  const out = new Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= n) sum -= arr[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

function drawChart(candles) {
  const cv = qs('#chart');
  const rect = cv.getBoundingClientRect();
  cv.width = Math.max(1, Math.round(rect.width));
  cv.height = Math.max(1, Math.round(rect.height));
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, cv.width, cv.height);
  if (!candles || candles.length < 2) return;

  const closes = candles.map((c) => c.c);
  const ma20 = sma(closes, 20);
  const ma50 = sma(closes, 50);
  // 최근 20봉 고·저 — 점선 수평 레벨로 그린다
  const recent = closes.slice(-20);
  const hi20 = Math.max(...recent);
  const lo20 = Math.min(...recent);

  const pool = closes.concat(
    ma20.filter((v) => v != null),
    ma50.filter((v) => v != null),
    [hi20, lo20]
  );
  const min = Math.min(...pool);
  const max = Math.max(...pool);
  const pad = 6;
  const w = cv.width - pad * 2;
  const h = cv.height - pad * 2;
  const up = closes[closes.length - 1] >= closes[0];
  const color = up ? '#3fb950' : '#f85149';
  const X = (i) => pad + (i / (closes.length - 1)) * w;
  const Y = (v) => pad + (1 - (v - min) / ((max - min) || 1)) * h;

  // 배경 픽셀 그리드 점
  ctx.fillStyle = '#161622';
  for (let gx = pad; gx < cv.width - pad; gx += 16) {
    for (let gy = pad; gy < cv.height - pad; gy += 12) ctx.fillRect(gx, gy, 1, 1);
  }

  // 20봉 고·저 점선 레벨
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 1;
  [[hi20, '#4d4d5e'], [lo20, '#4d4d5e']].forEach(([v, c]) => {
    ctx.strokeStyle = c;
    ctx.beginPath();
    ctx.moveTo(pad, Y(v));
    ctx.lineTo(cv.width - pad, Y(v));
    ctx.stroke();
  });
  ctx.setLineDash([]);

  // 이동평균선 (MA20 금색 / MA50 파랑)
  const line = (series, c, lw) => {
    ctx.strokeStyle = c;
    ctx.lineWidth = lw;
    ctx.beginPath();
    let started = false;
    series.forEach((v, i) => {
      if (v == null) return;
      const px = X(i), py = Y(v);
      started ? ctx.lineTo(px, py) : (ctx.moveTo(px, py), (started = true));
    });
    ctx.stroke();
  };
  line(ma50, '#4a9de8', 1);
  line(ma20, '#e8c84a', 1);

  // 종가 라인
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  closes.forEach((v, i) => { const px = X(i), py = Y(v); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
  ctx.stroke();

  // 마지막 값 점
  const lx = X(closes.length - 1), ly = Y(closes[closes.length - 1]);
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(lx) - 3, Math.round(ly) - 3, 6, 6);

  // 하단 날짜 라벨 (처음·중간·끝)
  ctx.fillStyle = '#5a5a72';
  ctx.font = '9px monospace';
  const label = (i, align) => {
    const t = candles[i] && candles[i].t;
    if (!t) return;
    const d = new Date(t);
    if (Number.isNaN(d.getTime())) return;
    const s = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
    ctx.textAlign = align;
    ctx.fillText(s, X(i), cv.height - 2);
  };
  label(0, 'left');
  label(Math.floor((closes.length - 1) / 2), 'center');
  label(closes.length - 1, 'right');
  ctx.textAlign = 'left';
}

// MARKET OPEN/CLOSED 배지 — 통화 기호와 종목 종류로 장 시간을 근사한다(공휴일 무시).
function updateMarketBadge(ev) {
  const badge = qs('#market-badge');
  const text = qs('#market-badge-text');
  if (!badge || !text) return;
  const isKR = !!(ev.priceLine && ev.priceLine.includes('₩'));
  const kind = ev.kind || '';
  let open = false;
  let label = '';
  const inWindow = (tz, fromMin, toMin) => {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
    }).formatToParts(new Date());
    const get = (t) => (p.find((x) => x.type === t) || {}).value;
    const wd = get('weekday');
    if (wd === 'Sat' || wd === 'Sun') return false;
    const mins = Number(get('hour')) * 60 + Number(get('minute'));
    return mins >= fromMin && mins <= toMin;
  };
  if (kind === 'crypto') {
    open = true;
    label = 'MARKET OPEN · 24H';
  } else if (isKR || kind === 'krstock') {
    open = inWindow('Asia/Seoul', 9 * 60, 15 * 60 + 30);
    label = open ? 'KRX OPEN' : 'KRX CLOSED · 무기한은 24H';
  } else {
    open = inWindow('America/New_York', 9 * 60 + 30, 16 * 60);
    label = open ? 'MARKET OPEN' : 'MARKET CLOSED';
  }
  badge.className = open ? 'open' : 'closed';
  text.textContent = label;
}

/* --------------------------------------------------------------------------
   4.5 에이전트 콘솔 (터미널 로그 — 레퍼런스 릴스의 우측 패널)
   -------------------------------------------------------------------------- */
let serverLogs = false;      // 서버가 log 이벤트를 보내면 true (합성 로그를 끈다)
let consoleFilter = 'all';
let agentLogCount = 0;
let autoScroll = true;
const ctypers = {};          // 콘솔 타이핑 타이머 (key → interval)

function consoleBody() { return qs('#console-body'); }

function nearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}

function applyFilter(el) {
  const cat = el.dataset.cat || 'sys';
  let show = true;
  if (consoleFilter === 'agent') show = cat === 'agent' || cat === 'verdict';
  else if (consoleFilter === 'debate') show = cat === 'debate';
  el.style.display = show ? '' : 'none';
}

function appendLog(el, cat) {
  const body = consoleBody();
  if (!body) return null;
  el.dataset.cat = cat;
  applyFilter(el);
  body.appendChild(el);
  if (autoScroll) body.scrollTop = body.scrollHeight;
  else qs('#console-jump').classList.remove('hidden');
  return el;
}

// sys / news / stage / verdict 한 줄
function pushLog(kind, line) {
  const div = document.createElement('div');
  div.className = 'clog ' + kind;
  div.textContent = kind === 'news' ? '▪ ' + line : line;
  appendLog(div, kind === 'stage' ? 'sys' : kind === 'verdict' ? 'verdict' : kind);
  if (kind === 'stage') {
    const st = qs('#cs-stage');
    if (st) st.textContent = line.replace(/─/g, '').trim() || '진행 중';
  }
}

// 에이전트 브리핑 — 이름 배지 + 역할 + 전문(타이핑)
function pushAgentLog(id, report) {
  const tint = AGENT_TINT[id] || '#666';
  const div = document.createElement('div');
  div.className = 'clog agent';
  div.style.setProperty('--tint', tint);
  const head = document.createElement('span');
  head.className = 'who';
  head.textContent = NAMES[id] || id.toUpperCase();
  const role = document.createElement('span');
  role.className = 'role';
  role.textContent = ROLES[id] || '';
  const body = document.createElement('span');
  body.className = 'body';
  div.appendChild(head);
  div.appendChild(role);
  div.appendChild(body);
  appendLog(div, DEBATE_IDS.includes(id) ? 'debate' : 'agent');

  agentLogCount += 1;
  const cnt = qs('#cs-count');
  if (cnt) cnt.textContent = `브리핑 ${agentLogCount}건`;

  // 타이핑 — 길어도 4초 안에 끝나도록 스텝을 키운다
  const text = String(report || '');
  if (STILL) {
    body.textContent = text;
    const bd0 = consoleBody();
    if (bd0) bd0.scrollTop = bd0.scrollHeight;
    return;
  }
  const budget = 4000;
  const step = Math.max(1, Math.ceil(text.length / (budget / 14)));
  let i = 0;
  const key = 'c-' + id + '-' + agentLogCount;
  clearInterval(ctypers[key]);
  ctypers[key] = setInterval(() => {
    i = Math.min(text.length, i + step);
    body.textContent = text.slice(0, i);
    if (i < text.length) {
      const cur = document.createElement('span');
      cur.className = 'cur';
      cur.textContent = '█';
      body.appendChild(cur);
    } else {
      clearInterval(ctypers[key]);
      delete ctypers[key];
    }
    const bd = consoleBody();
    if (autoScroll && bd) bd.scrollTop = bd.scrollHeight;
  }, 14);
}

function resetConsole() {
  const body = consoleBody();
  if (body) body.innerHTML = '';
  Object.keys(ctypers).forEach((k) => { clearInterval(ctypers[k]); delete ctypers[k]; });
  agentLogCount = 0;
  autoScroll = true;
  const jump = qs('#console-jump');
  if (jump) jump.classList.add('hidden');
  const cnt = qs('#cs-count');
  if (cnt) cnt.textContent = '';
}

function initConsole() {
  const body = consoleBody();
  if (body) {
    body.addEventListener('scroll', () => {
      autoScroll = nearBottom(body);
      const jump = qs('#console-jump');
      if (jump) jump.classList.toggle('hidden', autoScroll);
    });
  }
  const jump = qs('#console-jump');
  if (jump) {
    jump.addEventListener('click', () => {
      const b = consoleBody();
      if (b) b.scrollTop = b.scrollHeight;
      autoScroll = true;
      jump.classList.add('hidden');
    });
  }
  document.querySelectorAll('.ctab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.ctab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      consoleFilter = tab.dataset.filter || 'all';
      document.querySelectorAll('#console-body .clog').forEach(applyFilter);
    });
  });
}

// 벽면 이퀄라이저 바 생성 (방마다 14개, 서로 다른 주기·색)
function initEqualizers() {
  document.querySelectorAll('.eq').forEach((eq, ri) => {
    eq.innerHTML = '';
    for (let i = 0; i < 14; i++) {
      const bar = document.createElement('i');
      if ((i + ri) % 3 === 0) bar.className = 'r';
      bar.style.height = 20 + ((i * 37 + ri * 11) % 70) + '%';
      bar.style.animationDelay = (((i * 7 + ri * 3) % 10) / 10).toFixed(1) + 's';
      bar.style.animationDuration = (0.8 + ((i + ri) % 4) * 0.25).toFixed(2) + 's';
      eq.appendChild(bar);
    }
  });
}

/* --------------------------------------------------------------------------
   5. 판정 패널
   -------------------------------------------------------------------------- */
function resetDecision() {
  const panel = qs('#decision-panel');
  panel.classList.remove('active');
  const a = qs('#dp-action');
  a.textContent = '판정 대기 중';
  a.style.color = '';
  qs('#dp-gauge-fill').style.width = '0';
  qs('#dp-conf').textContent = '';
  qs('#dp-entry').textContent = '—';
  qs('#dp-stop').textContent = '—';
  qs('#dp-target').textContent = '—';
  qs('#dp-rationale').textContent = '';
  const vb = qs('#dp-verdict');
  if (vb) vb.classList.add('hidden');
  const rb = qs('#dp-risk');
  if (rb) rb.className = 'hidden';
  resetScalp();
}

function resetScalp() {
  const box = qs('#dp-scalp');
  if (box) box.classList.add('hidden');
  const badge = qs('#dp-scalp-bias');
  if (badge) { badge.textContent = '—'; badge.className = 'scalp-badge'; }
  qs('#dp-scalp-entry').textContent = '—';
  qs('#dp-scalp-stop').textContent = '—';
  qs('#dp-scalp-target').textContent = '—';
  qs('#dp-scalp-note').textContent = '';
}

// decision 이벤트의 선택 필드 scalp:{bias,entry,stop,target,note}
function applyScalp(scalp) {
  const box = qs('#dp-scalp');
  if (!box) return;
  if (!scalp || typeof scalp !== 'object') { resetScalp(); return; }
  const bias = String(scalp.bias || 'PASS').toUpperCase();
  const badge = qs('#dp-scalp-bias');
  badge.textContent = bias;
  const cls = bias === 'LONG' ? 'long' : bias === 'SHORT' ? 'short' : 'pass';
  badge.className = 'scalp-badge ' + cls;
  qs('#dp-scalp-entry').textContent = scalp.entry || '—';
  qs('#dp-scalp-stop').textContent = scalp.stop || '—';
  qs('#dp-scalp-target').textContent = scalp.target || '—';
  qs('#dp-scalp-note').textContent = scalp.note || '';
  box.classList.remove('hidden');
}

function onDecision(ev) {
  const act = String(ev.action || 'HOLD').toUpperCase();
  const col = DECISION_COLORS[act] || DECISION_COLORS.HOLD;
  const panel = qs('#decision-panel');
  panel.classList.add('active');

  const a = qs('#dp-action');
  a.textContent = act;
  a.style.color = col;

  const conf = Math.max(0, Math.min(100, Number(ev.confidence) || 0));
  const fill = qs('#dp-gauge-fill');
  fill.style.width = conf + '%';
  fill.style.background = col;
  qs('#dp-conf').textContent = conf + '%';

  qs('#dp-entry').textContent = ev.entry || '—';
  qs('#dp-stop').textContent = ev.stop || '—';
  qs('#dp-target').textContent = ev.target || '—';
  qs('#dp-rationale').textContent = ev.rationale || '';

  // PM 승인 판정 (algo 모드에서만 옴)
  applyVerdict(ev);

  // 최종 판정 줄은 서버 log 이벤트가 보내준다(구버전 서버일 때만 여기서 보완)
  if (!serverLogs) {
    pushLog('verdict', `>>> 최종 판정 ${act} ${conf}%` + (ev.verdict ? ` · PM ${ev.verdict}` : ''));
  }

  // 스캘핑 플랜 (있을 때만 표시)
  applyScalp(ev.scalp);

  // v2 — 카드 저장용 보관 + 리스크 게이트 보완 + 연출
  lastDecision = ev;
  // risk 이벤트가 따로 안 왔는데 decision에 rr/riskReasons가 실려 있으면 그걸로 표시한다
  if (!lastRisk && (ev.rr != null || (ev.riskReasons && ev.riskReasons.length))) {
    onRisk({
      type: 'risk',
      rr: ev.rr,
      ok: !(ev.riskReasons && ev.riskReasons.length),
      reasons: ev.riskReasons || [],
      sizing: ev.sizing,
    });
  }
  spotlightAce();
  sfxDecision(act === 'HOLD' && ev.scalp ? ev.scalp.bias : act);

  // ACE 말풍선
  typeBubble('ace', '최종 판정: ' + act, ev.report || ev.rationale || '');
}

/* --------------------------------------------------------------------------
   6. 모달 / 토스트
   -------------------------------------------------------------------------- */
function openModal(title, body) {
  qs('#modal-title').textContent = title;
  const box = qs('#modal-body');
  box.classList.remove('rich');
  box.textContent = body;
  qs('#modal').classList.remove('hidden');
}
function closeModal() { qs('#modal').classList.add('hidden'); }

function toast(msg, kind, href) {
  const t = document.createElement('div');
  t.className = 'toast ' + (kind || '');
  t.textContent = msg;
  if (href) {
    t.style.cursor = 'pointer';
    t.title = '클릭하면 리포트가 열립니다';
    t.addEventListener('click', () => window.open(href, '_blank'));
  }
  qs('#toasts').appendChild(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => {
    t.classList.remove('in');
    setTimeout(() => t.remove(), 300);
  }, href ? 8000 : 3200); // 링크 토스트는 누를 시간을 넉넉히
}

/* --------------------------------------------------------------------------
   7. 실행 상태
   -------------------------------------------------------------------------- */
function setBusy(busy) {
  qs('#analyze-btn').disabled = busy;
}

// 현재 선택된 모드 ('algo' | 'scalp' | 'attack') — 토글 버튼과 동기화
let currentMode = 'algo';

function setMode(mode) {
  currentMode = mode === 'scalp' || mode === 'attack' ? mode : 'algo';
  [['#mode-algo', 'algo'], ['#mode-scalp', 'scalp'], ['#mode-attack', 'attack']].forEach(
    ([sel, m]) => {
      const el = qs(sel);
      if (el) el.classList.toggle('active', currentMode === m);
    }
  );
  // 공격 모드는 화면 전체에 표식을 남긴다 — 판정이 강제된 런임을 영상에서 구분하려고.
  document.body.classList.toggle('attack-mode', currentMode === 'attack');
}

// 모드에 따라 이번 런에서 쉬는 방/자리를 흐리게 표시
function applyModeDim(mode) {
  const dim = (sel, on) => {
    const el = qs(sel);
    if (el) el.classList.toggle('idle', !!on);
  };
  // 공격 모드는 스캘핑과 같은 파이프라인(토론 없음 + 스캘핑 데스크)을 쓴다.
  const scalp = mode === 'scalp' || mode === 'attack';
  dim('#room-research', scalp);          // scalp 모드: 토론 없음
  dim('#desk-diana', scalp);
  dim('#desk-nova', scalp);

  // algo 모드에서는 같은 방이 '리스크 위원회'로 바뀐다(논문의 Risk Management team).
  // 좌석 표시는 CSS의 body.mode-algo 규칙이 담당한다.
  document.body.classList.toggle('mode-algo', !scalp);
  const label = qs('#scalp-room-label');
  if (label) {
    label.textContent = scalp ? '◆ 스캘핑 데스크 ◆ 20x' : '◆ 리스크 위원회 ◆';
  }
  dim('#room-scalp', false);
}

// PM 승인 판정 표시 (algo 모드에서만 온다)
function applyVerdict(ev) {
  const box = qs('#dp-verdict');
  if (!box) return;
  if (!ev || !ev.verdict) { box.classList.add('hidden'); return; }
  const v = String(ev.verdict).toUpperCase();
  const badge = qs('#dp-verdict-badge');
  const LABEL = { APPROVE: 'PM 승인', AMEND: 'PM 수정승인', REJECT: 'PM 기각', PM_FAILED: 'PM 절차 실패' };
  if (badge) {
    badge.textContent = LABEL[v] || ('PM ' + v);
    badge.className = v === 'APPROVE' ? 'approve' : v === 'AMEND' ? 'amend' : v === 'REJECT' ? 'reject' : '';
  }
  // sizing은 v1.2에선 문자열, v2에선 riskmath의 객체로 올 수 있다 — 둘 다 받는다
  const sz = qs('#dp-sizing');
  if (sz) sz.textContent = fmtSizing(ev.sizing);
  box.classList.remove('hidden');
}

function onRunStart(ev) {
  setBusy(true);
  AGENT_IDS.forEach(resetBubble);
  resetDecision();
  resetConsole();
  resetV2Run();
  if (ev && ev.mode) {
    setMode(ev.mode);
    applyModeDim(ev.mode);
  }
}

function onRunEnd() {
  setBusy(false);
  AGENT_IDS.forEach((id) => { const d = deskEl(id); if (d) d.classList.remove('bounce'); });
}

/* --------------------------------------------------------------------------
   8. SSE 이벤트 라우팅
   -------------------------------------------------------------------------- */
function handleEvent(ev) {
  // 무대 연출(인트로·열일 이펙트·서류 전달·판정 스탬프)은 Stage가 별도로 받는다.
  try { Stage.on(ev); } catch (_) { /* 연출 실패가 기능을 막으면 안 된다 */ }
  switch (ev.type) {
    case 'run:start':  onRunStart(ev); break;
    case 'market':     updateBoard(ev); break;
    case 'agent:start': showThinking(ev.id); break;
    case 'agent:done':
      typeBubble(ev.id, ev.bubble || '', ev.report || '');
      pushAgentLog(ev.id, ev.report || ev.bubble || '');
      break;
    case 'log': {
      serverLogs = true;
      const line = ev.line || '';
      // 서버의 최종 판정 줄은 강조 박스로 렌더한다
      const kind = line.startsWith('>>>')
        ? 'verdict'
        : ev.kind === 'news' ? 'news' : ev.kind === 'stage' ? 'stage' : 'sys';
      pushLog(kind, line);
      if (ev.kind === 'news') pushNews(line);   // 리서치룸 벽면 마퀴
      break;
    }
    case 'alert':      onAlert(ev); break;
    case 'risk':       onRisk(ev); break;
    case 'position':   onPosition(ev); break;
    case 'scan':       onScan(ev); break;
    case 'decision':   onDecision(ev); break;
    case 'saved':      toast('리포트 저장됨(클릭해서 열기): ' + shortPath(ev.path), 'ok', '/reports/' + encodeURIComponent(shortPath(ev.path))); break;
    case 'run:error':  toast(ev.message || '오류가 발생했습니다', 'err'); break;
    case 'run:end':    onRunEnd(); break;
    default: break;
  }
}

function connectStream() {
  const es = new EventSource('/api/stream');
  es.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch (_) { return; }
    handleEvent(ev);
  };
  es.onerror = () => { /* 브라우저가 자동 재연결 */ };
}

/* --------------------------------------------------------------------------
   9. 분석 요청
   -------------------------------------------------------------------------- */
async function analyze() {
  const sym = qs('#symbol-input').value.trim();
  if (!sym) { toast('심볼을 입력하세요', 'err'); return; }
  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: sym, demo: DEMO, mode: currentMode })
    });
    if (res.status === 409) { toast('이미 분석 중입니다', 'err'); return; }
    if (!res.ok) { toast('요청 실패 (' + res.status + ')', 'err'); return; }
    // 202 성공 — 이후 UI 는 SSE 가 구동
  } catch (_) {
    toast('서버에 연결할 수 없습니다', 'err');
  }
}

/* --------------------------------------------------------------------------
   10. 시계
   -------------------------------------------------------------------------- */
function fmtClock(tz) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(new Date());
}
function tickClocks() {
  qs('#clock-nyc').textContent = fmtClock('America/New_York');
  qs('#clock-ldn').textContent = fmtClock('Europe/London');
  qs('#clock-sel').textContent = fmtClock('Asia/Seoul');
}

/* --------------------------------------------------------------------------
   11. 티커 테이프
   -------------------------------------------------------------------------- */
function renderTape(items) {
  if (!Array.isArray(items) || !items.length) return;
  const make = () => items.map((it) => {
    const pct = Number(it.changePct);
    const sign = pct >= 0 ? '+' : '';
    const cls = pct >= 0 ? 'up' : 'down';
    const pctTxt = isFinite(pct) ? sign + pct.toFixed(2) + '%' : '';
    return '<span class="tape-item"><b>' + it.sym + '</b> $' + fmtNumber(it.price) +
           ' <span class="' + cls + '">' + pctTxt + '</span></span>';
  }).join('');
  // 콘텐츠 2벌 이어붙여 seamless 스크롤 (-50% 애니메이션과 정합)
  qs('#tape-track').innerHTML = make() + make();
}
/* --------------------------------------------------------------------------
   11-b. 멀티 거래소 전광판
   -------------------------------------------------------------------------- */
let boardSymbol = 'SKHYNIX'; // 전광판 대상 (분석 심볼이 KR 주식이면 따라간다)

function vbPrice(row) {
  if (row.price == null || !isFinite(row.price)) return '—';
  const cs = row.cs || '';
  if (row.decimals != null) {
    return cs + Number(row.price).toLocaleString('en-US', {
      minimumFractionDigits: row.decimals,
      maximumFractionDigits: row.decimals,
    });
  }
  return cs + fmtNumber(row.price);
}

function renderVenueBoard(data) {
  const wrap = qs('#vb-rows');
  if (!wrap) return;
  const rows = (data && data.rows) || [];
  if (!rows.length) {
    wrap.innerHTML =
      '<div class="vb-row vb-dead"><span class="vb-label">전광판</span>' +
      '<span class="vb-price">—</span><span class="vb-pct"></span>' +
      '<span class="vb-note">' +
      ((data && (data.note || data.error)) || '데이터 없음') +
      '</span></div>';
    return;
  }
  wrap.innerHTML = rows.map((r) => {
    const pct = Number(r.changePct);
    const hasPct = isFinite(pct) && r.changePct != null;
    const cls = hasPct ? (pct >= 0 ? 'up' : 'down') : '';
    const pctTxt = hasPct ? (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%' : '';
    const extra = [];
    if (r.krw != null) extra.push('₩' + fmtNumber(r.krw));
    if (r.usd != null) extra.push('$' + fmtNumber(r.usd));
    if (r.fundingPct != null) extra.push('펀딩 ' + (r.fundingPct >= 0 ? '+' : '') + r.fundingPct.toFixed(4) + '%');
    if (r.index != null) extra.push('지수 ' + fmtNumber(r.index));
    const note = extra.length ? extra.join(' · ') : (r.note || '');
    const kind =
      r.key === 'premium' ? ' vb-premium'
      : r.estimated ? ' vb-est'
      : r.price == null ? ' vb-dead' : '';
    return (
      '<div class="vb-row' + kind + '">' +
      '<span class="vb-label">' + esc(r.label) + '</span>' +
      '<span class="vb-price">' + vbPrice(r) + '</span>' +
      '<span class="vb-pct ' + cls + '">' + pctTxt + '</span>' +
      '<span class="vb-note" title="' + esc(r.note || '') + '">' + esc(note) + '</span>' +
      '</div>'
    );
  }).join('');
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function loadVenueBoard() {
  try {
    const res = await fetch('/api/board?symbol=' + encodeURIComponent(boardSymbol));
    if (!res.ok) return;
    const data = await res.json();
    renderVenueBoard(data);
    const sub = qs('#vb-sub');
    if (sub) {
      sub.textContent = data.nameKo
        ? `${data.nameKo} · 탭비트 ${data.tapbitPair} 기준`
        : (data.note || '');
    }
    const stamp = qs('#vb-stamp');
    if (stamp) {
      const d = new Date();
      stamp.textContent = `갱신 ${String(d.getHours()).padStart(2, '0')}:` +
        `${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    }
  } catch (_) { /* 무시 — 다음 폴링에서 재시도 */ }
}

async function loadTape() {
  try {
    const res = await fetch('/api/tape');
    if (!res.ok) return;
    renderTape(await res.json());
  } catch (_) { /* 무시 — 다음 폴링에서 재시도 */ }
}

/* ==========================================================================
   12. v2 — 급변동 알림 · 워치리스트 · 리스크 게이트 · 가상 포지션 ·
        세로 릴스 모드 · 판정 카드 PNG · 리플레이 · 8비트 사운드 · 뉴스 마퀴
   기존 v1.2 동작(모드 3종·기존 SSE 이벤트·리포트 저장)은 건드리지 않는다.
   ========================================================================== */

// ?vertical=1 — 9:16 촬영용 세로 레이아웃
const VERTICAL = new URLSearchParams(location.search).get('vertical') === '1';

let lastDecision = null;                 // 판정 카드용 마지막 판정 이벤트
let lastRisk = null;                     // 마지막 리스크 게이트 결과
let alertsState = [];                    // 최근 급변동 알림 (최신 우선)
let alertsSeeded = false;                // 서버 최근 알림을 한 번만 시드한다
let positionsState = { open: [], closed: [], summary: null };
let watcherOn = false;
let cfgCache = null;
let replaySpeed = 1;
let alertTimer = null;
const newsItems = [];                    // 벽면 마퀴에 흐를 뉴스 헤드라인
const deadApi = {};                      // 404 난 엔드포인트는 더 부르지 않는다

/* ---- 12-a. 숫자·문자 유틸 ---- */
function toNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const m = String(v).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

function pickNum(obj, keys) {
  if (!obj) return null;
  for (let i = 0; i < keys.length; i++) {
    const n = toNum(obj[keys[i]]);
    if (n != null) return n;
  }
  return null;
}

function signPct(n, digits) {
  if (n == null) return '—';
  const d = digits == null ? 2 : digits;
  return (n > 0 ? '+' : '') + n.toFixed(d) + '%';
}

// 승률·적중률이 비율(0~1)로 올 수도, 퍼센트(0~100)로 올 수도 있어 둘 다 받는다
function ratioToPct(v) {
  const n = toNum(v);
  if (n == null) return null;
  return n <= 1 && n >= -1 ? n * 100 : n;
}

// sizing — v1.2는 문자열(PM 비중), v2는 riskmath.positionSize 객체
function fmtSizing(s) {
  if (s == null) return '';
  if (typeof s === 'string') return s;
  if (typeof s !== 'object') return String(s);
  const parts = [];
  const qty = toNum(s.qty);
  const notional = toNum(s.notional);
  const margin = toNum(s.marginRequired);
  const risk = toNum(s.riskAmount);
  const pctOf = toNum(s.notionalPctOfAccount);
  if (qty != null) parts.push('수량 ' + fmtNumber(qty));
  if (notional != null) parts.push('명목 ' + fmtNumber(notional));
  if (margin != null) parts.push('증거금 ' + fmtNumber(margin));
  if (risk != null) parts.push('허용손실 ' + fmtNumber(risk));
  if (pctOf != null) parts.push('계좌대비 ' + pctOf.toFixed(1) + '%');
  return parts.length ? parts.join(' · ') : '데이터 없음';
}

function hhmm(ts) {
  const d = ts == null ? new Date() : new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--';
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function tsOf(a) {
  const t = a && a.ts != null ? new Date(a.ts).getTime() : 0;
  return isFinite(t) ? t : 0;
}

/* ---- 12-b. fetch 헬퍼 (없는 엔드포인트는 조용히 포기) ---- */
async function getJson(url) {
  const base = String(url).split('?')[0];
  if (deadApi[base]) return null;
  try {
    const res = await fetch(url);
    if (res.status === 404 || res.status === 405) { deadApi[base] = true; return null; }
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (ct.indexOf('json') === -1) return null;
    return await res.json();
  } catch (_) { return null; }
}

async function postJson(url, body) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.indexOf('json') !== -1) { try { data = await res.json(); } catch (_) {} }
    return { ok: res.ok, status: res.status, data };
  } catch (_) { return { ok: false, status: 0, data: null }; }
}

/* ---- 12-c. 8비트 사운드 (WebAudio 즉석 생성, 음원 파일 없음) ---- */
const SOUND_KEY = 'ptf-sound';
let soundOn = true;
let audioReady = false;   // 사용자 제스처 전에는 절대 소리를 내지 않는다(브라우저 정책)
let actx = null;

function ensureAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!actx) actx = new AC();
    if (actx.state === 'suspended') actx.resume();
    return actx;
  } catch (_) { return null; }
}

// 사각파 한 음 — 8비트 특유의 딱딱한 음색
function tone(opt) {
  if (!soundOn || !audioReady) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  try {
    const t0 = ctx.currentTime + (opt.delay || 0);
    const dur = opt.dur || 0.08;
    const vol = opt.vol == null ? 0.05 : opt.vol;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = opt.type || 'square';
    osc.frequency.setValueAtTime(opt.freq, t0);
    if (opt.to) osc.frequency.linearRampToValueAtTime(opt.to, t0 + dur);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  } catch (_) { /* 소리는 실패해도 화면을 막지 않는다 */ }
}

function sfxTick() { tone({ freq: 1180, dur: 0.013, vol: 0.016 }); }

// 액션별 음정 — 매수는 올라가고, 매도는 내려가고, 관망은 제자리
function sfxDecision(action) {
  const a = String(action || '').toUpperCase();
  const seq = (a === 'BUY' || a === 'LONG') ? [523, 659, 784, 1047]
    : (a === 'SELL' || a === 'SHORT') ? [784, 622, 523, 392]
    : [440, 440, 587];
  seq.forEach((f, i) => tone({ freq: f, dur: 0.11, vol: 0.06, delay: i * 0.1 }));
}

function sfxAlert(sev) {
  if (sev === 'critical') {
    [988, 740, 988, 740].forEach((f, i) => tone({ freq: f, dur: 0.1, vol: 0.09, delay: i * 0.11, type: 'sawtooth' }));
  } else if (sev === 'warn') {
    [880, 660].forEach((f, i) => tone({ freq: f, dur: 0.1, vol: 0.07, delay: i * 0.12 }));
  } else {
    tone({ freq: 880, to: 1180, dur: 0.09, vol: 0.05 });
  }
}

function sfxPosition(open) {
  if (open) [659, 988].forEach((f, i) => tone({ freq: f, dur: 0.09, vol: 0.05, delay: i * 0.09 }));
  else [988, 659].forEach((f, i) => tone({ freq: f, dur: 0.09, vol: 0.05, delay: i * 0.09 }));
}

function renderSoundBtn() {
  const b = qs('#sound-toggle');
  if (!b) return;
  b.textContent = soundOn ? '♪ 사운드 ON' : '♪ 사운드 OFF';
  b.classList.toggle('on', soundOn);
  b.setAttribute('aria-pressed', soundOn ? 'true' : 'false');
}

function toggleSound() {
  soundOn = !soundOn;
  try { localStorage.setItem(SOUND_KEY, soundOn ? '1' : '0'); } catch (_) {}
  renderSoundBtn();
  if (soundOn) { audioReady = true; sfxAlert('info'); }
}

function initSound() {
  let saved = null;
  try { saved = localStorage.getItem(SOUND_KEY); } catch (_) {}
  soundOn = saved == null ? true : saved === '1';   // 기본 on
  renderSoundBtn();
  const unlock = () => {
    audioReady = true;
    ensureAudio();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
}

/* ---- 12-d. 급변동 알림 ---- */
const SEV_LABEL = { info: '정보', warn: '주의', critical: '위험' };

function sevOf(a) {
  const s = String((a && a.severity) || 'info').toLowerCase();
  return (s === 'critical' || s === 'warn') ? s : 'info';
}

function onAlert(a) {
  if (!a) return;
  alertsState.unshift(a);
  if (alertsState.length > 40) alertsState.length = 40;
  renderAlerts();
  showAlertBanner(a);
  const sev = sevOf(a);
  const who = a.display || a.symbol || '';
  pushLog('alert', ('[급변동 ' + SEV_LABEL[sev] + '] ' + who + ' ' + (a.message || '')).trim());
  sfxAlert(sev);
  markWatchlistHot(a.symbol);
}

function showAlertBanner(a) {
  const box = qs('#alert-banner');
  if (!box) return;
  const sev = sevOf(a);
  const who = a.display || a.symbol || '';
  box.className = sev;
  const sv = qs('#ab-sev');
  const ms = qs('#ab-msg');
  if (sv) sv.textContent = SEV_LABEL[sev] + ' 급변동';
  if (ms) ms.textContent = (who ? who + ' — ' : '') + (a.message || '급변동 감지');
  clearTimeout(alertTimer);
  const hold = sev === 'critical' ? 14000 : sev === 'warn' ? 9000 : 6000;
  alertTimer = setTimeout(hideAlertBanner, hold);
}

function hideAlertBanner() {
  clearTimeout(alertTimer);
  const box = qs('#alert-banner');
  if (box) box.className = 'hidden';
}

function renderAlerts() {
  const cnt = qs('#ap-count');
  if (cnt) cnt.textContent = alertsState.length ? alertsState.length + '건' : '0';
  const list = qs('#ap-list');
  if (!list) return;
  if (!alertsState.length) {
    list.innerHTML = '<div class="ap-empty">알림 없음</div>';
    return;
  }
  list.innerHTML = alertsState.slice(0, 20).map((a) => {
    const sev = sevOf(a);
    const who = a.display || a.symbol || '';
    const msg = (who ? who + ' ' : '') + (a.message || '');
    return '<div class="ap-row ' + sev + '" data-sym="' + esc(a.symbol || '') + '" title="' + esc(msg) + '">' +
      '<i class="ap-dot"></i>' +
      '<span class="ap-time">' + esc(hhmm(a.ts)) + '</span>' +
      '<span class="ap-msg">' + esc(msg) + '</span>' +
      '</div>';
  }).join('');
}

/* ---- 12-e. 워치리스트 · 감시 토글 ---- */
async function loadConfig() {
  const cfg = await getJson('/api/config');
  if (!cfg) { renderWatchlist(null); return; }
  cfgCache = cfg;
  // 로컬 저장값이 없을 때만 서버 설정(ui.sound)을 따른다
  let saved = null;
  try { saved = localStorage.getItem(SOUND_KEY); } catch (_) {}
  if (saved == null && cfg.ui && cfg.ui.sound === false) {
    soundOn = false;
    renderSoundBtn();
  }
  renderWatchlist(cfg.watchlist);
  renderWatcherBtn();
}

function renderWatchlist(list) {
  const box = qs('#watchlist-chips');
  if (!box) return;
  if (!Array.isArray(list) || !list.length) {
    box.innerHTML = '<span class="wl-dim">' + (cfgCache ? '비어 있음' : '설정 없음') + '</span>';
    return;
  }
  box.innerHTML = list.map((s) =>
    '<button class="wl-chip" type="button" data-sym="' + esc(s) + '" title="클릭하면 이 심볼로 분석을 시작합니다">' +
    esc(s) + '</button>'
  ).join('');
}

// 알림이 뜬 심볼 칩을 잠시 붉게 표시
function markWatchlistHot(sym) {
  if (!sym) return;
  document.querySelectorAll('.wl-chip').forEach((c) => {
    if (c.dataset.sym === sym) {
      c.classList.add('hot');
      setTimeout(() => c.classList.remove('hot'), 60000);
    }
  });
}

async function loadWatcher() {
  const d = await getJson('/api/watcher');
  if (!d) {
    const b = qs('#watcher-toggle');
    if (b) b.style.display = 'none';
    return;
  }
  applyWatcherState(d);
}

function applyWatcherState(d) {
  if (!d) return;
  const st = (d.status && typeof d.status === 'object') ? d.status : d;
  const en = st.enabled != null ? st.enabled : (st.running != null ? st.running : d.enabled);
  watcherOn = !!en;
  if (!alertsSeeded) {
    const arr = d.alerts || d.recent || d.recentAlerts || st.alerts;
    if (Array.isArray(arr) && arr.length) {
      alertsSeeded = true;
      alertsState = arr.slice().sort((a, b) => tsOf(b) - tsOf(a)).slice(0, 40);
      renderAlerts();
    }
  }
  renderWatcherBtn();
}

function renderWatcherBtn() {
  const b = qs('#watcher-toggle');
  if (b) {
    b.textContent = watcherOn ? '감시 ON' : '감시 OFF';
    b.classList.toggle('on', watcherOn);
    b.setAttribute('aria-pressed', watcherOn ? 'true' : 'false');
  }
  const stat = qs('#watcher-stat');
  if (stat) {
    const w = cfgCache && cfgCache.watcher;
    if (watcherOn && w) {
      const mv = w.triggers && w.triggers.movePct;
      stat.textContent = (w.intervalSec || 60) + '초 주기' + (mv != null ? ' · 이동 ' + mv + '%' : '');
    } else {
      stat.textContent = '';
    }
  }
}

async function toggleWatcher() {
  const next = !watcherOn;
  const r = await postJson('/api/watcher', { enabled: next });
  if (!r.ok) {
    toast(r.status === 404 ? '감시 기능이 아직 서버에 없습니다' : '감시 설정 실패 (' + r.status + ')', 'err');
    return;
  }
  if (r.data) applyWatcherState(r.data);
  else { watcherOn = next; renderWatcherBtn(); }
  toast(watcherOn ? '급변동 감시를 켰습니다' : '급변동 감시를 껐습니다', 'ok');
}

/* ---- 12-f. 리스크 게이트 ---- */
function onRisk(ev) {
  lastRisk = ev || null;
  renderRisk(ev);
  if (!ev) return;
  const rr = toNum(ev.rr);
  const bad = ev.ok === false || ev.downgrade === true;
  const reasons = Array.isArray(ev.reasons) ? ev.reasons : [];
  // 공격 모드는 계약상 강등하지 않는다 — 같은 게이트 실패라도 '경고'로만 표기한다
  const attack = currentMode === 'attack';
  pushLog('risk',
    '[리스크 게이트] R:R ' + (rr != null ? rr.toFixed(2) : '데이터 없음') +
    ' · ' + (bad ? (attack ? '경고' : '강등') : '통과') +
    (reasons.length ? ' — ' + reasons.join(' / ') : '')
  );
  // 강등이면 플로어를 어둡게 (다음 런 시작 때 풀린다)
  document.body.classList.toggle('risk-downgrade', !!bad && !attack);
}

function renderRisk(ev) {
  const box = qs('#dp-risk');
  if (!box) return;
  if (!ev) { box.className = 'hidden'; return; }
  const rr = toNum(ev.rr);
  const bad = ev.ok === false || ev.downgrade === true;
  const unknown = rr == null;
  box.className = (bad ? 'bad' : '') + (unknown ? (bad ? ' unknown' : 'unknown') : '');

  const badge = qs('#dp-rr-badge');
  if (badge) badge.textContent = unknown ? 'R:R 데이터 없음' : 'R:R ' + rr.toFixed(2);

  const state = qs('#dp-risk-state');
  if (state) {
    state.textContent = bad
      ? (currentMode === 'attack' ? '게이트 경고 (공격 모드는 강등 없음)' : '게이트 강등')
      : (unknown ? '계산 불가' : '게이트 통과');
  }

  const bits = [];
  const sz = fmtSizing(ev.sizing);
  if (sz) bits.push('권장 비중 ' + sz);
  const liq = toNum(ev.liq);
  if (liq != null) bits.push('청산가 ' + fmtNumber(liq));
  if (ev.stopBeyondLiq) bits.push('손절이 청산가 밖 — 청산이 먼저 온다');
  const szEl = qs('#dp-risk-sizing');
  if (szEl) szEl.textContent = bits.join(' · ');

  const rbox = qs('#dp-risk-reasons');
  if (rbox) {
    rbox.innerHTML = '';
    (Array.isArray(ev.reasons) ? ev.reasons : []).slice(0, 3).forEach((r) => {
      const d = document.createElement('div');
      d.className = 'dp-reason';
      d.textContent = String(r);
      rbox.appendChild(d);
    });
  }
}

/* ---- 12-g. 가상 포지션 ---- */
let positionsSeen = false;   // 한 번이라도 데이터를 받았으면 폴링 실패로 패널을 숨기지 않는다

async function loadPositions() {
  const d = await getJson('/api/positions');
  if (!d) {
    if (!positionsSeen) {
      const p = qs('#positions-panel');
      if (p) p.classList.add('hidden');
    }
    return;
  }
  positionsSeen = true;
  positionsState = {
    open: Array.isArray(d.open) ? d.open : [],
    closed: Array.isArray(d.closed) ? d.closed : [],
    summary: d.summary || null,
  };
  renderPositions();
}

function onPosition(ev) {
  const p = ev && ev.position;
  if (!p) return;
  positionsSeen = true;
  const idx = positionsState.open.findIndex((x) => x && x.id === p.id);
  if (ev.action === 'close') {
    if (idx >= 0) positionsState.open.splice(idx, 1);
    positionsState.closed.unshift(p);
    toast('가상 포지션 청산: ' + (p.display || p.symbol || ''), 'ok');
    sfxPosition(false);
  } else {
    if (idx >= 0) positionsState.open[idx] = p;
    else positionsState.open.unshift(p);
    if (ev.action === 'open') {
      toast('가상 포지션 오픈: ' + (p.display || p.symbol || '') + ' ' + (p.side || ''), 'ok');
      sfxPosition(true);
    }
  }
  renderPositions();
}

// markToMarket이 넣어주는 현재가 필드명이 확정 전이라 후보를 순서대로 본다
function posMark(p) {
  return pickNum(p, ['mark', 'price', 'markPrice', 'last', 'lastPrice', 'current', 'currentPrice']);
}

function renderPositions() {
  const panel = qs('#positions-panel');
  const rows = qs('#pp-rows');
  if (!panel || !rows) return;
  panel.classList.remove('hidden');
  const stage = qs('#stage');
  if (stage) stage.classList.add('has-positions');

  const s = positionsState.summary;
  const sum = ['오픈 ' + positionsState.open.length];
  if (s) {
    if (s.closedCount != null) sum.push('청산 ' + s.closedCount);
    const wr = ratioToPct(s.winRate);
    if (wr != null) sum.push('승률 ' + wr.toFixed(0) + '%');
    const pf = toNum(s.profitFactor);
    if (pf != null) sum.push('PF ' + pf.toFixed(2));
    const ex = toNum(s.expectancyPct);
    if (ex != null) sum.push('기대값 ' + ex.toFixed(2) + '%');
    const arr = toNum(s.avgRR);
    if (arr != null) sum.push('평균 R:R ' + arr.toFixed(2));
  }
  const sumEl = qs('#pp-summary');
  if (sumEl) sumEl.textContent = sum.join(' · ');

  if (!positionsState.open.length) {
    rows.innerHTML = '<div class="pp-empty">오픈 포지션 없음</div>';
    return;
  }
  rows.innerHTML = positionsState.open.map(posRowHtml).join('');
}

function posRowHtml(p) {
  const side = String(p.side || '').toUpperCase();
  const sideCls = side === 'SHORT' ? 'short' : 'long';
  const sym = p.display || p.symbol || '—';
  const lev = toNum(p.leverage);
  const pnl = pickNum(p, ['unrealizedPct']);
  const pnlCls = pnl == null ? 'flat' : pnl > 0 ? 'up' : pnl < 0 ? 'down' : 'flat';
  const pnlTxt = pnl == null ? '—' : signPct(pnl);
  const amt = pickNum(p, ['unrealizedAmt']);

  const entry = toNum(p.entry);
  const stop = toNum(p.stop);
  const target = toNum(p.target);
  const liq = toNum(p.liq);
  const rr = toNum(p.rr);
  const qty = toNum(p.qty);
  const mark = posMark(p);

  // 청산까지 남은 여력 게이지 — (현재가↔청산가) / (진입가↔청산가)
  // 20배면 진입가와 청산가 사이가 5% 남짓이라 이 막대가 순식간에 줄어드는 게 보인다.
  let fill = 100;
  let gcls = 'dead';
  let gtxt = '청산 거리 데이터 없음';
  if (liq != null && entry != null && Math.abs(entry - liq) > 0 && mark != null) {
    const span = Math.abs(entry - liq);
    const dist = Math.abs(mark - liq);
    const ratio = Math.max(0, Math.min(1, dist / span));
    fill = ratio * 100;
    gcls = ratio > 0.55 ? '' : ratio > 0.3 ? 'warn' : 'danger';
    const gapPct = mark ? (dist / mark) * 100 : null;
    gtxt = '청산까지 ' + (gapPct != null ? gapPct.toFixed(2) + '%' : '—') + ' · 여력 ' + Math.round(fill) + '%';
  } else if (liq != null) {
    gtxt = '청산가 ' + fmtNumber(liq) + ' · 현재가 데이터 없음';
  }

  const meta = [];
  if (entry != null) meta.push('<b>진입</b> ' + fmtNumber(entry));
  if (mark != null) meta.push('<b>현재</b> ' + fmtNumber(mark));
  if (stop != null) meta.push('<b>손절</b> ' + fmtNumber(stop));
  if (target != null) meta.push('<b>목표</b> ' + fmtNumber(target));
  if (liq != null) meta.push('<b>청산</b> ' + fmtNumber(liq));
  if (rr != null) meta.push('<b>R:R</b> ' + rr.toFixed(2));
  if (qty != null) meta.push('<b>수량</b> ' + fmtNumber(qty));
  if (amt != null) meta.push('<b>평가손익</b> ' + fmtNumber(amt));
  if (p.hitStop) meta.push('<b style="color:#f85149">손절 터치</b>');
  if (p.hitTarget) meta.push('<b style="color:#3fb950">목표 터치</b>');

  return '<div class="pos-row">' +
    '<div class="pos-top">' +
      '<span class="pos-sym">' + esc(sym) + '</span>' +
      '<span class="pos-side ' + sideCls + '">' + esc(side || '—') + '</span>' +
      (lev != null ? '<span class="pos-lev">' + lev + 'x</span>' : '') +
      '<span class="pos-pnl ' + pnlCls + '">' + pnlTxt + '</span>' +
      '<button class="pos-close" type="button" data-id="' + esc(p.id || '') + '">청산</button>' +
    '</div>' +
    '<div class="pos-gauge ' + gcls + '">' +
      '<div class="pos-gauge-liq"></div>' +
      '<div class="pos-gauge-fill" style="width:' + fill.toFixed(1) + '%"></div>' +
      '<span class="pos-gauge-txt">' + esc(gtxt) + '</span>' +
    '</div>' +
    '<div class="pos-meta">' + meta.join('<span></span>') + '</div>' +
  '</div>';
}

async function closePositionById(id) {
  if (!id) return;
  const r = await postJson('/api/positions/close', { id });
  if (!r.ok) {
    toast(r.status === 404 ? '청산 기능이 아직 서버에 없습니다' : '청산 실패 (' + r.status + ')', 'err');
    return;
  }
  await loadPositions();
}

/* ---- 12-h. 벽면 뉴스 마퀴 (리서치룸) ---- */
function pushNews(line) {
  const t = String(line || '').replace(/^[▪\s>]+/, '').trim();
  if (!t) return;
  if (newsItems.indexOf(t) !== -1) return;
  newsItems.push(t);
  if (newsItems.length > 12) newsItems.shift();
  renderNewsMarquee();
}

function renderNewsMarquee() {
  const wrap = qs('#news-marquee');
  const track = qs('#nm-track');
  if (!wrap || !track) return;
  if (!newsItems.length) {
    wrap.classList.add('empty');
    track.innerHTML = '';
    return;
  }
  wrap.classList.remove('empty');
  const html = newsItems.map((t) => '<span class="nm-item">▪ ' + esc(t) + '</span>').join('');
  track.innerHTML = html + html;   // 2벌 이어붙여 seamless (-50% 애니메이션과 정합)
  const chars = newsItems.join('').length + newsItems.length * 4;
  track.style.animationDuration = Math.max(20, Math.min(140, chars * 0.4)).toFixed(0) + 's';
}

/* ---- 12-i. 캐릭터 연출 ---- */
function spotlightAce() {
  ['ace', 'pm'].forEach((id) => {
    const d = deskEl(id);
    if (d && d.offsetParent !== null) d.classList.add('spotlight');
  });
}

function resetV2Run() {
  lastRisk = null;
  document.body.classList.remove('risk-downgrade');
  newsItems.length = 0;
  renderNewsMarquee();
  const rb = qs('#dp-risk');
  if (rb) rb.className = 'hidden';
}

/* ---- 12-j. 스캔 진행(선택) — 콘솔에만 남긴다 ---- */
function onScan(ev) {
  if (!ev) return;
  if (ev.phase === 'start') pushLog('stage', '─ 워치리스트 스캔 시작 ─');
  else if (ev.phase === 'item') {
    const sym = ev.display || ev.symbol || '';
    const bits = [sym];
    if (ev.action) bits.push(String(ev.action).toUpperCase());
    if (ev.confidence != null) bits.push(ev.confidence + '%');
    const rr = toNum(ev.rr);
    if (rr != null) bits.push('R:R ' + rr.toFixed(2));
    pushLog('sys', '> 스캔 ' + bits.join(' · '));
  } else if (ev.phase === 'done') {
    pushLog('stage', '─ 스캔 완료' + (ev.count != null ? ' (' + ev.count + '종목)' : '') + ' ─');
  }
}

/* ---- 12-k. 판정 카드 PNG (canvas만 사용, 외부 라이브러리 없음) ---- */
// 카드에 쓸 종목명 — decision 이벤트엔 심볼이 없을 수 있어 전광판 값을 보조로 쓴다
function cardSymbol(dec) {
  const s = (dec && (dec.display || dec.symbol)) || '';
  if (s) return String(s);
  const el = qs('#board-symbol');
  const t = el ? el.textContent.trim() : '';
  return t && t !== '—' ? t : '—';
}

// '—' 같은 빈 자리표시자를 건너뛰고 첫 실제 값을 고른다
function pickLevel() {
  for (let i = 0; i < arguments.length; i++) {
    const v = arguments[i];
    if (v == null) continue;
    const s = String(v).trim();
    if (s && s !== '—' && s !== '-' && s !== '–') return s;
  }
  return '—';
}

// ' · ' 로 끊긴 조각을 줄에 채워 넣는다 (숫자가 중간에서 잘리지 않게)
function cardPack(g, segs, maxW) {
  const lines = [];
  let cur = '';
  segs.forEach((seg) => {
    const test = cur ? cur + ' · ' + seg : seg;
    if (cur && g.measureText(test).width > maxW) { lines.push(cur); cur = seg; }
    else cur = test;
  });
  if (cur) lines.push(cur);
  return lines;
}

function cardWrap(g, text, maxW) {
  const out = [];
  let cur = '';
  const src = String(text || '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\n') { out.push(cur); cur = ''; continue; }
    const test = cur + ch;
    if (g.measureText(test).width > maxW && cur) { out.push(cur); cur = ch; }
    else cur = test;
  }
  if (cur) out.push(cur);
  return out;
}

function drawDecisionCard(dec, risk) {
  const W = 360, H = 540, SCALE = 2;
  const off = document.createElement('canvas');
  off.width = W;
  off.height = H;
  const g = off.getContext('2d');
  const F = (px) => px + 'px "Galmuri11", monospace';

  const act = String(dec.action || 'HOLD').toUpperCase();
  const col = DECISION_COLORS[act] || DECISION_COLORS.HOLD;

  // 배경 + 픽셀 격자 + 금색 프레임
  g.fillStyle = '#0d0d16';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#15151f';
  for (let x = 0; x < W; x += 8) for (let y = 0; y < H; y += 8) g.fillRect(x, y, 1, 1);
  g.fillStyle = '#000';
  g.fillRect(6, 6, W - 12, H - 12);
  g.fillStyle = '#12121c';
  g.fillRect(9, 9, W - 18, H - 18);
  g.strokeStyle = '#e8c84a';
  g.lineWidth = 2;
  g.strokeRect(13, 13, W - 26, H - 26);

  let y = 34;
  g.textAlign = 'center';
  g.fillStyle = '#e8c84a';
  g.font = F(11);
  g.fillText('◆ PIXEL TRADING FLOOR ◆', W / 2, y);

  // 종목 · 모드
  y += 30;
  g.font = F(17);
  g.fillStyle = '#fff8e0';
  g.fillText(cardSymbol(dec), W / 2, y);
  y += 16;
  g.font = F(10);
  g.fillStyle = '#7a7a90';
  const MODE_KO = { algo: '알고리즘', scalp: '스캘핑 20x', attack: '공격 모드' };
  g.fillText(MODE_KO[currentMode] || currentMode, W / 2, y);

  // 액션
  y += 42;
  g.font = F(38);
  g.fillStyle = '#000';
  g.fillText(act, W / 2 + 2, y + 2);
  g.fillStyle = col;
  g.fillText(act, W / 2, y);

  // 확신도 게이지
  y += 22;
  const conf = Math.max(0, Math.min(100, Number(dec.confidence) || 0));
  const gx = 34, gw = W - 68;
  g.fillStyle = '#000';
  g.fillRect(gx, y, gw, 14);
  g.fillStyle = col;
  g.fillRect(gx + 2, y + 2, Math.round((gw - 4) * conf / 100), 10);
  g.textAlign = 'left';
  g.font = F(10);
  g.fillStyle = '#7a7a90';
  g.fillText('확신도', gx, y - 4);
  g.textAlign = 'right';
  g.fillStyle = '#fff';
  g.fillText(conf + '%', gx + gw, y - 4);

  // R:R 배지
  y += 34;
  const rrNum = toNum(risk && risk.rr) != null ? toNum(risk.rr) : toNum(dec.rr);
  const bad = !!(risk && (risk.ok === false || risk.downgrade === true));
  const rrTxt = rrNum != null ? 'R:R ' + rrNum.toFixed(2) : 'R:R 데이터 없음';
  g.textAlign = 'left';
  g.font = F(15);
  const rrW = g.measureText(rrTxt).width + 18;
  g.fillStyle = '#000';
  g.fillRect(gx, y - 14, rrW, 22);
  g.fillStyle = rrNum == null ? '#4a4a5a' : bad ? '#f85149' : '#3fb950';
  g.fillRect(gx + 2, y - 12, rrW - 4, 18);
  g.fillStyle = rrNum == null ? '#cfcfe0' : bad ? '#fff' : '#08160b';
  g.fillText(rrTxt, gx + 10, y + 2);
  g.font = F(10);
  g.fillStyle = bad ? '#f85149' : '#7a7a90';
  g.fillText(bad ? '리스크 게이트 강등' : (rrNum == null ? '계산 불가' : '게이트 통과'), gx + rrW + 8, y + 1);

  // 레벨 (스캘핑 플랜이 있으면 그쪽 숫자를 우선한다 — 무기한 기준)
  const sc = dec.scalp && typeof dec.scalp === 'object' ? dec.scalp : null;
  const lv = [
    ['진입', pickLevel(sc && sc.entry, dec.entry)],
    ['손절', pickLevel(sc && sc.stop, dec.stop)],
    ['목표', pickLevel(sc && sc.target, dec.target)],
  ];
  y += 26;
  g.font = F(11);
  lv.forEach(([k, v]) => {
    g.fillStyle = '#7a7a90';
    g.fillText(k, gx, y);
    g.fillStyle = '#e6e6f0';
    const lines = cardWrap(g, v || '—', gw - 44);
    lines.slice(0, 2).forEach((ln, i) => g.fillText(ln, gx + 40, y + i * 14));
    y += 14 * Math.min(2, lines.length) + 4;
  });

  // 권장 비중 · 강등 사유
  const szTxt = fmtSizing(risk ? risk.sizing : dec.sizing);
  if (szTxt) {
    y += 6;
    g.font = F(9.5);
    g.fillStyle = '#9a9ab4';
    const segs = szTxt.split(' · ');
    segs[0] = '권장 비중 ' + segs[0];
    cardPack(g, segs, gw).slice(0, 3).forEach((ln) => { g.fillText(ln, gx, y); y += 13; });
  }
  const reasons = (risk && Array.isArray(risk.reasons) ? risk.reasons : dec.riskReasons) || [];
  if (reasons.length) {
    y += 6;
    g.font = F(9.5);
    g.fillStyle = '#ffb4ae';
    reasons.slice(0, 3).forEach((r) => {
      cardWrap(g, '▪ ' + r, gw).slice(0, 2).forEach((ln) => { g.fillText(ln, gx, y); y += 13; });
    });
  }

  // 근거 요약
  const rat = String(dec.rationale || '').trim();
  if (rat && y < H - 96) {
    y += 8;
    g.font = F(10);
    g.fillStyle = '#c8c8dc';
    const room = Math.max(0, Math.floor((H - 84 - y) / 14));
    cardWrap(g, rat, gw).slice(0, room).forEach((ln) => { g.fillText(ln, gx, y); y += 14; });
  }

  // 푸터 — 면책 + 시각
  g.fillStyle = '#2a2a3a';
  g.fillRect(gx, H - 74, gw, 2);
  g.fillStyle = '#000';
  g.fillRect(13, H - 62, W - 26, 49);
  g.textAlign = 'center';
  g.font = F(10);
  g.fillStyle = '#f85149';
  g.fillText('AI 시뮬레이션 — 투자 조언이 아님', W / 2, H - 42);
  g.fillStyle = '#6a6a82';
  g.font = F(9);
  g.fillText('레버리지 거래는 청산 위험이 있습니다', W / 2, H - 29);
  const d = new Date();
  g.fillStyle = '#4a4a5e';
  g.fillText(
    d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0') + ' ' + hhmm(d),
    W / 2, H - 18
  );
  g.textAlign = 'left';

  // 2배 확대 — 보간을 끄면 픽셀이 그대로 커진다
  const out = document.createElement('canvas');
  out.width = W * SCALE;
  out.height = H * SCALE;
  const o = out.getContext('2d');
  o.imageSmoothingEnabled = false;
  o.drawImage(off, 0, 0, out.width, out.height);
  return out;
}

function downloadCanvas(cv, name) {
  const trigger = (url, revoke) => {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (revoke) setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
  if (cv.toBlob) {
    cv.toBlob((blob) => {
      if (!blob) { trigger(cv.toDataURL('image/png'), false); return; }
      trigger(URL.createObjectURL(blob), true);
    }, 'image/png');
  } else {
    trigger(cv.toDataURL('image/png'), false);
  }
}

async function saveDecisionCard() {
  if (!lastDecision) { toast('저장할 판정이 아직 없습니다', 'err'); return; }
  try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (_) {}
  let cv;
  try {
    cv = drawDecisionCard(lastDecision, lastRisk);
  } catch (err) {
    toast('카드 생성 실패', 'err');
    return;
  }
  const d = new Date();
  const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') +
    '-' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
  const sym = String(lastDecision.symbol || cardSymbol(lastDecision) || 'FLOOR').replace(/[\\/:*?"<>|—\s]/g, '');
  downloadCanvas(cv, '판정카드_' + sym + '_' + stamp + '.png');
  toast('판정 카드를 저장했습니다', 'ok');
}

/* ---- 12-l. 리플레이 ---- */
async function fetchReportFiles() {
  // 1) JSON 목록이 있으면 그걸 쓴다
  const j = await getJson('/api/reports');
  if (j) {
    const arr = Array.isArray(j) ? j : (j.files || j.reports || []);
    const names = arr
      .map((x) => (typeof x === 'string' ? x : (x && (x.file || x.name || x.path))))
      .filter(Boolean)
      .map(shortPath)
      .filter((n) => n.endsWith('.md'));
    if (names.length) return names;
  }
  // 2) 없으면 기존 /reports 목록 페이지의 링크를 긁는다
  try {
    const res = await fetch('/reports');
    if (res.ok) {
      const html = await res.text();
      const re = /href="\/reports\/([^"?#]+?\.md)"/g;
      const out = [];
      let m;
      while ((m = re.exec(html))) {
        const n = decodeURIComponent(m[1]);
        if (out.indexOf(n) === -1) out.push(n);
      }
      return out;
    }
  } catch (_) {}
  return [];
}

function openModalNode(title, node) {
  qs('#modal-title').textContent = title;
  const body = qs('#modal-body');
  body.classList.add('rich');
  body.innerHTML = '';
  body.appendChild(node);
  qs('#modal').classList.remove('hidden');
}

async function openReplayModal() {
  const wrap = document.createElement('div');
  const speedSec = document.createElement('div');
  speedSec.className = 'modal-sec';
  speedSec.innerHTML = '<div class="modal-sec-head">재생 배속</div>';
  const speedBox = document.createElement('div');
  speedBox.className = 'modal-speed';
  [1, 2, 4].forEach((sp) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'modal-btn' + (sp === replaySpeed ? ' on' : '');
    b.textContent = sp + 'x';
    b.addEventListener('click', () => {
      replaySpeed = sp;
      speedBox.querySelectorAll('.modal-btn').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
    });
    speedBox.appendChild(b);
  });
  speedSec.appendChild(speedBox);
  wrap.appendChild(speedSec);

  const listSec = document.createElement('div');
  listSec.className = 'modal-sec';
  listSec.innerHTML = '<div class="modal-sec-head">저장된 리포트</div>';
  const list = document.createElement('div');
  list.className = 'modal-list';
  list.innerHTML = '<div class="modal-note">불러오는 중…</div>';
  listSec.appendChild(list);
  wrap.appendChild(listSec);

  const note = document.createElement('div');
  note.className = 'modal-note';
  note.textContent = '리포트를 고르면 그때의 이벤트 순서대로 화면이 다시 재생됩니다. (실제 분석은 돌지 않습니다)';
  wrap.appendChild(note);

  openModalNode('리플레이', wrap);

  const files = await fetchReportFiles();
  if (!files.length) {
    list.innerHTML = '<div class="modal-note">재생할 리포트가 없습니다.</div>';
    return;
  }
  list.innerHTML = '';
  files.slice(0, 60).forEach((f) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'modal-file';
    b.textContent = f;
    b.addEventListener('click', () => startReplay(f));
    list.appendChild(b);
  });
}

async function startReplay(file) {
  closeModal();
  try {
    const res = await fetch('/api/replay?file=' + encodeURIComponent(file) + '&speed=' + replaySpeed);
    if (res.status === 404) { toast('리플레이 기능이 아직 서버에 없습니다', 'err'); return; }
    if (res.status === 409) { toast('이미 실행 중입니다', 'err'); return; }
    if (!res.ok) { toast('리플레이 실패 (' + res.status + ')', 'err'); return; }
    toast('리플레이 시작: ' + file + ' (' + replaySpeed + 'x)', 'ok');
  } catch (_) {
    toast('서버에 연결할 수 없습니다', 'err');
  }
}

/* ---- 12-m. v2 초기화 ---- */
function initV2() {
  // 세로(9:16) 릴스 모드
  if (VERTICAL) {
    document.body.classList.add('vertical');
    const mv = document.querySelector('meta[name="viewport"]');
    if (mv) mv.setAttribute('content', 'width=device-width, initial-scale=1');
  }

  initSound();

  const abClose = qs('#ab-close');
  if (abClose) abClose.addEventListener('click', hideAlertBanner);

  // 워치리스트 칩 클릭 → 그 심볼로 분석 시작
  const chips = qs('#watchlist-chips');
  if (chips) {
    chips.addEventListener('click', (e) => {
      const b = e.target.closest('.wl-chip');
      if (!b || !b.dataset.sym) return;
      const input = qs('#symbol-input');
      if (input) input.value = b.dataset.sym;
      analyze();
    });
  }

  // 알림 행 클릭 → 심볼만 채운다 (분석은 사용자가 직접 누르게)
  const apList = qs('#ap-list');
  if (apList) {
    apList.addEventListener('click', (e) => {
      const row = e.target.closest('.ap-row');
      if (!row || !row.dataset.sym) return;
      const input = qs('#symbol-input');
      if (input) { input.value = row.dataset.sym; input.focus(); }
    });
  }

  const wt = qs('#watcher-toggle');
  if (wt) wt.addEventListener('click', toggleWatcher);

  const st = qs('#sound-toggle');
  if (st) st.addEventListener('click', toggleSound);

  // 성적표 — 승률·손익비·캘리브레이션 차트. 분석 화면을 유지해야 하므로 새 탭으로 연다.
  const sb = qs('#stats-btn');
  if (sb) sb.addEventListener('click', () => window.open('/stats', '_blank'));

  const rb = qs('#replay-btn');
  if (rb) rb.addEventListener('click', openReplayModal);

  const cb = qs('#dp-card-btn');
  if (cb) cb.addEventListener('click', saveDecisionCard);

  const pt = qs('#pp-toggle');
  if (pt) {
    pt.addEventListener('click', () => {
      const box = qs('#positions-panel');
      const collapsed = box.classList.toggle('collapsed');
      pt.textContent = collapsed ? '펼치기' : '접기';
    });
  }

  const pr = qs('#pp-rows');
  if (pr) {
    pr.addEventListener('click', (e) => {
      const b = e.target.closest('.pos-close');
      if (!b) return;
      closePositionById(b.dataset.id);
    });
  }

  // 초기 로드 + 폴링 (엔드포인트가 없으면 getJson이 한 번만 시도하고 끝낸다)
  loadConfig();
  loadWatcher();
  loadPositions();
  setInterval(loadPositions, 15000);
  setInterval(loadWatcher, 30000);
}

/* --------------------------------------------------------------------------
   13. 초기화
   -------------------------------------------------------------------------- */
function init() {
  // 스프라이트 렌더
  AGENT_IDS.forEach((id) => {
    const desk = deskEl(id);
    if (desk) drawSprite(desk.querySelector('.sprite'), id);
  });

  // 시계
  tickClocks();
  setInterval(tickClocks, 1000);

  // 티커
  loadTape();
  setInterval(loadTape, 60000);

  // 전광판 (서버 캐시 15초에 맞춰 폴링)
  loadVenueBoard();
  setInterval(loadVenueBoard, 15000);
  const vbToggle = qs('#vb-toggle');
  if (vbToggle) {
    vbToggle.addEventListener('click', () => {
      const box = qs('#venue-board');
      const hidden = box.classList.toggle('collapsed');
      vbToggle.textContent = hidden ? '펼치기' : '접기';
    });
  }

  // 컨트롤
  qs('#analyze-btn').addEventListener('click', analyze);
  qs('#symbol-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') analyze(); });

  // 모드 토글
  const algoBtn = qs('#mode-algo');
  const scalpBtn = qs('#mode-scalp');
  const attackBtn = qs('#mode-attack');
  if (algoBtn) algoBtn.addEventListener('click', () => { setMode('algo'); applyModeDim('algo'); });
  if (scalpBtn) scalpBtn.addEventListener('click', () => { setMode('scalp'); applyModeDim('scalp'); });
  if (attackBtn) attackBtn.addEventListener('click', () => { setMode('attack'); applyModeDim('attack'); });
  applyModeDim(currentMode);

  // 말풍선 클릭 → 모달
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.bubble');
    if (b && b.dataset.report) openModal(b.dataset.name || '리포트', b.dataset.report);
  });
  qs('#modal-close').addEventListener('click', closeModal);
  qs('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  // 차트 리사이즈 대응 (마지막 candles 재렌더)
  window.addEventListener('resize', () => { if (lastCandles) drawChart(lastCandles); });

  // 에이전트 콘솔 + 벽면 이퀄라이저
  initConsole();
  initEqualizers();
  Stage.init();

  // v2 — 알림·워치리스트·포지션·사운드·리플레이·세로 모드
  initV2();

  // SSE 연결 (현재 상태 replay 후 구독)
  connectStream();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
