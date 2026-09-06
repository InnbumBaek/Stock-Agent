'use strict';

// PIXEL TRADING FLOOR — HTTP 서버 (Node 내장 http, 외부 의존성 0)
// 라우트 (v1.2 기존):
//   GET  /                정적 index.html
//   GET  /<static>        public/ 정적 파일 (html/css/js/png)
//   GET  /api/stream      SSE — 접속 시 engine.history replay 후 실시간 구독
//   POST /api/analyze     {symbol, demo} → engine.run 비동기 시작(202) / 진행 중이면 409 / 심볼 없으면 400
//   GET  /api/tape        fetchTape 결과 (서버 60초 캐시)
//   GET  /api/board       거래소 전광판 (심볼별 15초 캐시)
//   GET  /reports · /reports/<파일> · /reports/all.zip · /project.zip
// 라우트 (v2 신규 — docs/v2-contracts.md "서버 라우트"):
//   GET  /api/config           설정 조회 (토큰 마스킹)
//   POST /api/config           설정 저장 (부분 병합)
//   GET  /api/watcher          감시 상태 + 최근 알림
//   POST /api/watcher          {enabled:true|false}
//   GET  /api/stats            성적표 JSON
//   GET  /stats                성적표 HTML 페이지
//   GET  /api/positions        가상 포지션 (open/closed/summary)
//   POST /api/positions/close  {id, price?}
//   POST /api/scan             워치리스트 일괄 스캔 시작
//   GET  /api/replay?file=…    리포트 재생 시작 (SSE로 흘림)
//   POST /api/telegram/test    테스트 메시지 발송
// 라우트 (통합 — docs/integration.md):
//   GET  /api/ki?symbol=…      주가 모니터링 원장의 실측값 (ki.enabled 일 때만)
// 신규 모듈(config/watcher/…)은 병렬로 만들어지는 중이라 require를 전부 감싼다.
// 모듈이 없으면 해당 라우트만 503으로 응답하고 서버 기동은 절대 실패하지 않는다.

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const { Engine } = require('./engine');
const { fetchTape, fetchVenueBoard, resolveSymbol, fetchMarket, KR_STOCKS } = require('./market');
// 주가 모니터링 원장 브리지. 없으면 /api/ki 만 503 이고 서버는 그대로 뜬다.
let kiBridge = null;
try {
  kiBridge = require('./ki-bridge');
} catch (err) {
  console.error('[ki] ki-bridge 모듈 없음 — /api/ki 는 비활성:', err && err.message);
}

// 기본 8000. 이미 8000이 쓰이는 중이면 PORT=8123 처럼 덮어쓸 수 있다.
const PORT = Number(process.env.PORT) || 8000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const TAPE_TTL_MS = 60 * 1000;
const BOARD_TTL_MS = 15 * 1000;
const PING_INTERVAL_MS = 25 * 1000;

const engine = new Engine();

// ---- v2 신규 모듈 안전 로더 ----------------------------------------------
// server/config.js · watcher.js · notify.js … 는 다른 에이전트가 동시에 만드는 중이다.
// 파일이 없거나 로드 중 예외가 나도 서버는 반드시 떠야 하므로 require를 감싸고,
// 성공한 모듈만 캐시한다(실패는 캐시하지 않아 나중에 파일이 생기면 그때 살아난다).
const modCache = new Map(); // 이름 -> 모듈
const modError = new Map(); // 이름 -> 마지막 실패 사유

function loadModule(name) {
  if (modCache.has(name)) return modCache.get(name);
  try {
    const mod = require(path.join(__dirname, `${name}.js`));
    modCache.set(name, mod);
    modError.delete(name);
    return mod;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (modError.get(name) !== msg) {
      // 같은 사유가 반복되면 로그를 도배하지 않는다.
      console.error(`[모듈] server/${name}.js 로드 실패 — 해당 기능은 503:`, msg);
    }
    modError.set(name, msg);
    return null;
  }
}

// 모듈이 아직 없을 때의 표준 응답
function notReady(res, name, extra) {
  const body = {
    error: '아직 준비되지 않은 기능입니다.',
    module: `server/${name}.js`,
    detail: modError.get(name) || '모듈을 찾을 수 없습니다.',
  };
  if (extra && typeof extra === 'object') Object.assign(body, extra);
  return sendJson(res, 503, body);
}

// 모듈 + 필요한 함수까지 갖춰졌는지 확인. 아니면 null.
function needModule(res, name, fns) {
  const mod = loadModule(name);
  if (!mod) {
    notReady(res, name);
    return null;
  }
  for (const fn of fns || []) {
    if (typeof mod[fn] !== 'function') {
      modError.set(name, `${fn}() 가 아직 구현되지 않았습니다.`);
      notReady(res, name);
      return null;
    }
  }
  return mod;
}

// ---- 서버 자체 SSE 방송 경로 ---------------------------------------------
// engine.history 와 분리된 실시간 전용 채널. 감시 알림·스캔 진행·리포트 재생을
// 여기로 흘린다(히스토리에 남기지 않으므로 새 구독자 replay가 오염되지 않는다).
const sseClients = new Set();

function broadcast(evt) {
  if (!evt || typeof evt !== 'object') return;
  for (const write of sseClients) {
    try {
      write(evt);
    } catch (_) {
      /* 끊긴 소켓은 cleanup 이 정리한다 */
    }
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
};

// ---- /api/tape 60초 캐시 ----
let tapeCache = null; // { ts, data }
async function getTape() {
  const now = Date.now();
  if (tapeCache && now - tapeCache.ts < TAPE_TTL_MS) return tapeCache.data;
  const data = await fetchTape();
  tapeCache = { ts: now, data };
  return data;
}

// ---- 유틸 ----
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('본문이 너무 큽니다.'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ---- SSE ----
function handleStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  const write = (evt) => {
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  };

  // 1) 현재 히스토리 전부 replay
  for (const evt of engine.history) write(evt);

  // 2) 실시간 구독
  const onEvent = (evt) => write(evt);
  engine.on('event', onEvent);

  // 2-1) 엔진과 무관한 서버 방송(감시 알림·스캔·재생) 구독.
  //      engine.history를 오염시키지 않는 별도 경로다 — 알림이 히스토리에 섞이면
  //      새 구독자가 접속할 때 지난 알림이 분석 결과처럼 다시 흘러나온다.
  sseClients.add(write);

  // 3) keep-alive 핑 (SSE 주석)
  const ping = setInterval(() => {
    res.write(':ping\n\n');
  }, PING_INTERVAL_MS);

  const cleanup = () => {
    clearInterval(ping);
    engine.removeListener('event', onEvent);
    sseClients.delete(write);
  };
  req.on('close', cleanup);
  res.on('error', cleanup);
}

// ---- POST /api/analyze ----
async function handleAnalyze(req, res) {
  let body = {};
  try {
    const raw = await readBody(req);
    body = raw ? JSON.parse(raw) : {};
  } catch (_) {
    return sendJson(res, 400, { error: '잘못된 요청 본문(JSON 파싱 실패).' });
  }

  const symbol = body && typeof body.symbol === 'string' ? body.symbol.trim() : '';
  if (!symbol) {
    return sendJson(res, 400, { error: '심볼(symbol)이 필요합니다.' });
  }
  if (engine.running) {
    return sendJson(res, 409, { error: '이미 분석이 진행 중입니다.' });
  }

  const mock = !!body.demo;
  const mode =
    body.mode === 'scalp' || body.mode === 'attack' ? body.mode : 'algo';
  // 비동기로 실행 시작 후 즉시 202. 내부 오류는 run:error 이벤트로 방송된다.
  engine.run(symbol, { mock, mode }).catch((err) => {
    console.error('[engine] run 오류:', err && err.message ? err.message : err);
  });
  return sendJson(res, 202, { ok: true, symbol, mock, mode });
}

// ---- GET /api/board?symbol=… — 다중 거래소 전광판 (심볼별 15초 캐시) ----
const boardCache = new Map(); // symbolKey -> { ts, data }

async function handleBoard(res, searchParams) {
  const raw = (searchParams && searchParams.get('symbol')) || 'SKHYNIX';
  const key = String(raw).trim().toUpperCase();
  const hit = boardCache.get(key);
  const now = Date.now();
  if (hit && now - hit.ts < BOARD_TTL_MS) return sendJson(res, 200, hit.data);
  try {
    const data = await fetchVenueBoard(raw);
    if (!data) {
      return sendJson(res, 200, {
        rows: [],
        lines: [],
        note: '무기한 선물 페어가 있는 심볼(하이닉스·삼성전자)만 전광판을 제공합니다.',
        supported: Object.keys(KR_STOCKS),
      });
    }
    boardCache.set(key, { ts: now, data });
    return sendJson(res, 200, data);
  } catch (err) {
    // 실패해도 캐시가 있으면 캐시를 준다 (전광판은 끊기지 않는 편이 낫다).
    if (hit) return sendJson(res, 200, hit.data);
    console.error('[board] 조회 실패:', err && err.message ? err.message : err);
    return sendJson(res, 200, { rows: [], lines: [], error: '전광판 조회 실패' });
  }
}

// ---- GET /api/ki?symbol=SKHYNIX ----
//
// 주가 모니터링 원장(KRX·DART 공식 API)의 실측값을 그대로 돌려준다.
// 여기서 가공하지 않는다 — 등급·점수·권고를 만들지 않는 것이 원장 쪽 계약이고,
// 이 라우트는 그 계약을 그대로 통과시키는 창구다.
async function handleKi(res, searchParams) {
  if (!kiBridge) {
    return sendJson(res, 503, { error: 'ki-bridge 모듈을 불러오지 못했습니다.' });
  }
  if (!kiBridge.isEnabled()) {
    return sendJson(res, 200, {
      enabled: false,
      note: '주가 모니터링 원장 연동이 꺼져 있습니다. config.json 의 ki.enabled 를 true 로 두십시오.',
    });
  }

  const raw = (searchParams && searchParams.get('symbol')) || '';
  if (!String(raw).trim()) {
    return sendJson(res, 400, { error: 'symbol 파라미터가 필요합니다.' });
  }

  // 심볼 → KRX 6자리 코드. 코드를 직접 줘도 되고 SKHYNIX 같은 별칭도 된다.
  let code = kiBridge.krCodeOf(raw);
  if (!code) {
    const resolved = resolveSymbol(raw);
    if (resolved && resolved.kind === 'krstock') code = kiBridge.krCodeOf(resolved.yahoo);
  }
  if (!code) {
    return sendJson(res, 200, {
      enabled: true,
      found: false,
      note: '원장은 한국 상장 종목만 다룹니다. KRX 6자리 코드 또는 하이닉스·삼성전자를 지정하십시오.',
      supported: Object.keys(KR_STOCKS),
    });
  }

  const facts = await kiBridge.fetchKiFacts(code);
  if (!facts) {
    return sendJson(res, 200, {
      enabled: true,
      found: false,
      code,
      note: '원장에서 이 종목의 실측값을 얻지 못했습니다. 서버 로그의 [ki] 줄을 보십시오.',
    });
  }
  return sendJson(res, 200, {
    enabled: true,
    found: true,
    code,
    lines: kiBridge.formatKiLines(facts, code),
    facts,
  });
}

// ---- GET /api/tape ----
async function handleTape(res) {
  try {
    const data = await getTape();
    return sendJson(res, 200, data);
  } catch (err) {
    // 실패해도 캐시가 있으면 캐시를, 없으면 빈 배열을 반환한다.
    if (tapeCache) return sendJson(res, 200, tapeCache.data);
    console.error('[tape] 조회 실패:', err && err.message ? err.message : err);
    return sendJson(res, 200, []);
  }
}

// ---- GET /reports (목록) · /reports/<파일> (열람/다운로드) ----
const REPORTS_DIR = path.join(__dirname, '..', 'reports');

// --- 최소 ZIP 생성기 (무압축 store 방식, 외부 의존성 없음) ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const time =
    ((d.getHours() & 0x1f) << 11) |
    ((d.getMinutes() & 0x3f) << 5) |
    ((Math.floor(d.getSeconds() / 2)) & 0x1f);
  const date =
    (((d.getFullYear() - 1980) & 0x7f) << 9) |
    (((d.getMonth() + 1) & 0xf) << 5) |
    (d.getDate() & 0x1f);
  return { time, date };
}

// entries: [{name, data(Buffer), mtime(Date)}] → 단일 ZIP Buffer
function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const { time, date } = dosDateTime(e.mtime || new Date());
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // UTF-8 이름 플래그
    local.writeUInt16LE(0, 8);           // method: store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, e.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);        // made by
    central.writeUInt16LE(20, 6);        // needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    // extra/comment/disk/attrs 전부 0
    central.writeUInt32LE(offset, 42);   // local header offset
    centralParts.push(Buffer.concat([central, nameBuf]));

    offset += local.length + nameBuf.length + e.data.length;
  }
  const centralDir = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDir, end]);
}

async function handleReportsZip(res) {
  let names = [];
  try {
    names = (await fsp.readdir(REPORTS_DIR)).filter(
      (n) => n.endsWith('.md') || n === 'decisions.json'
    );
  } catch (_) {}
  const entries = [];
  for (const n of names) {
    try {
      const full = path.join(REPORTS_DIR, n);
      const [data, stat] = await Promise.all([fsp.readFile(full), fsp.stat(full)]);
      entries.push({ name: n, data, mtime: stat.mtime });
    } catch (_) {}
  }
  const zip = buildZip(entries);
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad2z(d.getMonth() + 1)}${pad2z(d.getDate())}`;
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': zip.length,
    'Content-Disposition': `attachment; filename=trading-floor-reports-${stamp}.zip`,
  });
  res.end(zip);
}

function pad2z(n) {
  return String(n).padStart(2, '0');
}

// ---- GET /project.zip — 새 PC 이식용 / 공유용 소스 번들 ----
// 포함: 소스·커맨드·문서. 제외: vendor 대용량(venv·클론), .git, node_modules,
//       그리고 남에게 넘어가면 안 되는 개인 데이터 — 분석 리포트(매매 판정 이력)와
//       .claude/settings.local.json(로컬 절대경로·권한 허용 목록).
const PROJECT_ROOT = path.join(__dirname, '..');
const BUNDLE_EXCLUDE_DIRS = new Set([
  '.git',
  'node_modules',
  path.join('vendor', 'ta-venv'),
  path.join('vendor', 'TradingAgents'),
]);

// 개인 데이터 — 번들에서 뺀다.
// 이 번들은 남에게 그대로 전달되므로(텔레그램 배포 등) 판단이 애매하면 빼는 쪽이 옳다.
function isPrivateBundleFile(rel) {
  if (rel === '.claude/settings.local.json') return true;
  if (rel === '.env') return true;
  // config.json 에는 텔레그램 봇 토큰·chatId 가 평문으로 들어간다. 절대 포함 금지.
  if (rel === 'config.json') return true;
  // reports/ 는 개인 매매 기록(리포트·판정 이력·가상 포지션) 전체가 개인 데이터다.
  // README 같은 안내 파일만 남기고 나머지는 전부 뺀다.
  if (rel.startsWith('reports/') && rel !== 'reports/README.md') return true;
  return false;
}

async function collectBundleFiles(dir, relBase, out) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const rel = relBase ? `${relBase}/${e.name}` : e.name;
    const relNorm = rel.split('/').join(path.sep);
    if (e.isDirectory()) {
      if (BUNDLE_EXCLUDE_DIRS.has(relNorm) || BUNDLE_EXCLUDE_DIRS.has(e.name)) continue;
      await collectBundleFiles(path.join(dir, e.name), rel, out);
    } else if (e.isFile()) {
      if (isPrivateBundleFile(rel)) continue;
      out.push(rel);
    }
  }
}

async function handleProjectZip(res) {
  const rels = [];
  await collectBundleFiles(PROJECT_ROOT, '', rels);
  const entries = [];
  for (const rel of rels) {
    try {
      const full = path.join(PROJECT_ROOT, rel);
      const [data, stat] = await Promise.all([fsp.readFile(full), fsp.stat(full)]);
      entries.push({ name: `trading-floor/${rel}`, data, mtime: stat.mtime });
    } catch (_) {}
  }
  const zip = buildZip(entries);
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': zip.length,
    'Content-Disposition': 'attachment; filename=trading-floor-portable.zip',
  });
  res.end(zip);
}

async function handleReports(req, res, pathname, searchParams) {
  const rel = decodeURIComponent(pathname.replace(/^\/reports\/?/, ''));

  // 목록 페이지
  if (!rel) {
    let names = [];
    try {
      names = (await fsp.readdir(REPORTS_DIR))
        .filter((n) => n.endsWith('.md') || n === 'decisions.json')
        .sort()
        .reverse();
    } catch (_) {}
    const rows = names
      .map(
        (n) =>
          `<li><a href="/reports/${encodeURIComponent(n)}">${n}</a>` +
          ` <a class="dl" href="/reports/${encodeURIComponent(n)}?dl=1">[다운로드]</a></li>`
      )
      .join('\n');
    const html =
      '<!doctype html><html lang="ko"><head><meta charset="utf-8">' +
      '<title>리포트 — PIXEL TRADING FLOOR</title>' +
      '<style>body{background:#1a1a24;color:#eee;font-family:monospace;padding:24px}' +
      'a{color:#e8c84a}a.dl{color:#3fb950;text-decoration:none;margin-left:8px}' +
      'li{margin:6px 0}h1{font-size:18px;color:#e8c84a}' +
      '.zip{display:inline-block;background:#3fb950;color:#08160b;font-weight:bold;' +
      'padding:8px 14px;margin:8px 0 16px;text-decoration:none;border:2px solid #000;' +
      'box-shadow:3px 3px 0 #000}</style></head><body>' +
      `<h1>◆ 분석 리포트 (${names.length}건) ◆</h1>` +
      '<a class="zip" href="/reports/all.zip">⬇ 전체 다운로드 (.zip)</a>' +
      `<ul>${rows}</ul>` +
      '<p><a href="/">← 플로어로 돌아가기</a></p></body></html>';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  // 전체 ZIP
  if (rel === 'all.zip') {
    return handleReportsZip(res);
  }

  // 개별 파일 — 경로 탈출 방지 + 확장자 화이트리스트
  const target = path.normalize(path.join(REPORTS_DIR, rel));
  if (
    !target.startsWith(REPORTS_DIR) ||
    !(target.endsWith('.md') || target.endsWith('decisions.json'))
  ) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const data = await fsp.readFile(target);
    const isMd = target.endsWith('.md');
    const headers = {
      'Content-Type': isMd
        ? 'text/plain; charset=utf-8'
        : 'application/json; charset=utf-8',
      'Content-Length': data.length,
    };
    // ?dl=1 이면 저장 대화상자를 띄운다
    if (searchParams && searchParams.get('dl') === '1') {
      headers['Content-Disposition'] =
        `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(target))}`;
    }
    res.writeHead(200, headers);
    return res.end(data);
  } catch (_) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 Not Found');
  }
}

// ---- 정적 파일 ----
async function handleStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  // 경로 탈출 방지
  const target = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const data = await fsp.readFile(target);
    const ext = path.extname(target).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': data.length,
    });
    res.end(data);
  } catch (_) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

// ==========================================================================
//  v2 신규 라우트 — 설정 · 감시 · 성적표 · 포지션 · 스캔 · 재생 · 텔레그램
// ==========================================================================

const MAX_ALERTS = 50;          // 최근 알림 보관 개수
const recentAlerts = [];        // GET /api/watcher 응답용 링버퍼
const TOKEN_MASK = '...';       // 토큰 마스킹 접미사
let watcher = null;             // Watcher 인스턴스 (없으면 null)
let scheduler = null;           // Scheduler 인스턴스 (없으면 null)
let scanning = false;           // 스캔 진행 중 플래그
let replaying = false;          // 리포트 재생 진행 중 플래그
let lastScan = null;            // 마지막 스캔 결과 (참고용)

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// 중첩 객체까지 병합. 배열은 통째로 교체(워치리스트·잡 목록은 덮어쓰기가 자연스럽다).
// 중첩 객체는 항상 새로 만든다 — 원본(요청 본문·현재 설정)을 건드리지 않기 위해서다.
function deepMerge(base, patch) {
  const out = isPlainObject(base) ? Object.assign({}, base) : {};
  if (!isPlainObject(patch)) return out;
  for (const key of Object.keys(patch)) {
    const v = patch[key];
    out[key] = isPlainObject(v)
      ? deepMerge(isPlainObject(out[key]) ? out[key] : {}, v)
      : v;
  }
  return out;
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  return isPlainObject(parsed) ? parsed : {};
}

// ---- 설정 --------------------------------------------------------------
function readConfigSafe() {
  const mod = loadModule('config');
  if (!mod || typeof mod.loadConfig !== 'function') return null;
  try {
    const cfg = mod.loadConfig();
    return isPlainObject(cfg) ? cfg : null;
  } catch (err) {
    console.error('[설정] 로드 실패:', err && err.message ? err.message : err);
    return null;
  }
}

function maskToken(token) {
  const s = String(token == null ? '' : token);
  if (!s) return '';
  return s.slice(0, 6) + TOKEN_MASK;
}

// 응답용 사본. botToken 같은 민감값은 앞 6자만 남긴다.
function maskConfig(cfg) {
  const out = deepMerge({}, cfg);
  if (isPlainObject(out.telegram)) {
    const tok = out.telegram.botToken;
    out.telegram = Object.assign({}, out.telegram, {
      botToken: maskToken(tok),
      tokenSet: !!(tok && String(tok).length),
    });
  }
  return out;
}

// 마스킹된 토큰이 그대로 되돌아오면 기존 값을 유지한다(화면에서 그대로 저장 눌렀을 때).
function unmaskPatch(patch, current) {
  if (!isPlainObject(patch) || !isPlainObject(patch.telegram)) return patch;
  const next = deepMerge({}, patch);
  delete next.telegram.tokenSet;
  const incoming = next.telegram.botToken;
  const kept = isPlainObject(current) && isPlainObject(current.telegram)
    ? current.telegram.botToken
    : '';
  if (
    typeof incoming === 'string' &&
    incoming.endsWith(TOKEN_MASK) &&
    kept &&
    maskToken(kept) === incoming
  ) {
    next.telegram.botToken = kept;
  }
  return next;
}

// 응답에 토큰 원문이 새어나가지 않도록 훑어 지운다.
function scrubToken(value, token) {
  if (!token) return value;
  try {
    const s = JSON.stringify(value);
    if (s == null) return null;
    return JSON.parse(s.split(String(token)).join(maskToken(token)));
  } catch (_) {
    return null;
  }
}

async function handleConfigGet(res) {
  const mod = needModule(res, 'config', ['loadConfig']);
  if (!mod) return;
  const cfg = readConfigSafe();
  if (!cfg) return sendJson(res, 500, { error: '설정을 읽지 못했습니다.' });
  const masked = maskConfig(cfg);
  // 프런트가 data.config / data.watcher 둘 중 무엇을 보든 동작하도록 둘 다 담는다.
  return sendJson(res, 200, Object.assign({ ok: true, config: masked }, masked));
}

async function handleConfigPost(req, res) {
  const mod = needModule(res, 'config', ['loadConfig', 'saveConfig']);
  if (!mod) return;
  let body;
  try {
    body = await readJsonBody(req);
  } catch (_) {
    return sendJson(res, 400, { error: '잘못된 요청 본문(JSON 파싱 실패).' });
  }
  const raw = isPlainObject(body.config) ? body.config : body;
  const current = readConfigSafe() || {};
  const patch = unmaskPatch(raw, current);
  let saved;
  try {
    // saveConfig 의 병합 깊이에 의존하지 않도록 서버에서 먼저 깊게 병합해 넘긴다.
    saved = await mod.saveConfig(deepMerge(current, patch));
  } catch (err) {
    console.error('[설정] 저장 실패:', err && err.message ? err.message : err);
    return sendJson(res, 500, { error: '설정 저장에 실패했습니다.' });
  }
  const next = isPlainObject(saved) ? saved : readConfigSafe() || deepMerge(current, patch);
  applyRuntime(next);
  const masked = maskConfig(next);
  return sendJson(res, 200, Object.assign({ ok: true, config: masked }, masked));
}

// ---- 감시(watcher) · 예약(scheduler) 수명주기 ---------------------------
function pushAlert(evt) {
  recentAlerts.push(evt);
  while (recentAlerts.length > MAX_ALERTS) recentAlerts.shift();
}

// 텔레그램 알림은 부가 기능 — 실패해도 절대 흐름을 막지 않는다.
async function relayAlertToTelegram(alert) {
  const mod = loadModule('notify');
  if (!mod || typeof mod.sendAlert !== 'function') return;
  const cfg = readConfigSafe();
  if (!cfg || !isPlainObject(cfg.telegram) || !cfg.telegram.enabled) return;
  try {
    await mod.sendAlert(alert, cfg);
  } catch (err) {
    console.error('[알림] 텔레그램 중계 실패:', err && err.message ? err.message : err);
  }
}

function onWatcherAlert(alert) {
  try {
    const evt = Object.assign({ type: 'alert' }, isPlainObject(alert) ? alert : {});
    evt.type = 'alert';
    pushAlert(evt);
    broadcast(evt); // engine.history 에는 넣지 않는다
    relayAlertToTelegram(evt);
  } catch (err) {
    console.error('[감시] 알림 처리 실패:', err && err.message ? err.message : err);
  }
}

function stopWatcher() {
  if (!watcher) return;
  try {
    if (typeof watcher.removeListener === 'function') {
      watcher.removeListener('alert', onWatcherAlert);
    }
  } catch (_) {}
  try {
    if (typeof watcher.stop === 'function') watcher.stop();
  } catch (err) {
    console.error('[감시] 중지 실패:', err && err.message ? err.message : err);
  }
  watcher = null;
}

function startWatcher(cfg) {
  const mod = loadModule('watcher');
  if (!mod) return { ok: false, error: modError.get('watcher') || '감시 모듈 없음' };
  const Watcher = mod.Watcher || (typeof mod === 'function' ? mod : null);
  if (typeof Watcher !== 'function') {
    return { ok: false, error: 'Watcher 클래스를 찾지 못했습니다.' };
  }
  stopWatcher();
  try {
    const w = new Watcher({ engine, config: cfg });
    if (typeof w.on === 'function') w.on('alert', onWatcherAlert);
    if (typeof w.start === 'function') w.start();
    watcher = w;
    return { ok: true };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error('[감시] 시작 실패:', msg);
    watcher = null;
    return { ok: false, error: msg };
  }
}

function stopScheduler() {
  if (!scheduler) return;
  try {
    if (typeof scheduler.stop === 'function') scheduler.stop();
  } catch (err) {
    console.error('[예약] 중지 실패:', err && err.message ? err.message : err);
  }
  scheduler = null;
}

function startScheduler(cfg) {
  const mod = loadModule('scheduler');
  if (!mod) return { ok: false, error: modError.get('scheduler') || '예약 모듈 없음' };
  const Scheduler = mod.Scheduler || (typeof mod === 'function' ? mod : null);
  if (typeof Scheduler !== 'function') {
    return { ok: false, error: 'Scheduler 클래스를 찾지 못했습니다.' };
  }
  stopScheduler();
  try {
    const s = new Scheduler({ engine, config: cfg, notify: loadModule('notify') });
    if (typeof s.start === 'function') s.start();
    scheduler = s;
    return { ok: true };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error('[예약] 시작 실패:', msg);
    scheduler = null;
    return { ok: false, error: msg };
  }
}

// 설정 상태에 맞춰 감시·예약을 켜고 끈다. 어떤 실패도 서버를 죽이지 않는다.
function applyRuntime(cfg) {
  const out = { watcher: null, scheduler: null };
  try {
    if (cfg && isPlainObject(cfg.watcher) && cfg.watcher.enabled) {
      out.watcher = startWatcher(cfg);
    } else {
      stopWatcher();
      out.watcher = { ok: true, running: false };
    }
  } catch (err) {
    console.error('[감시] 적용 실패:', err && err.message ? err.message : err);
  }
  try {
    if (cfg && isPlainObject(cfg.schedule) && cfg.schedule.enabled) {
      out.scheduler = startScheduler(cfg);
    } else {
      stopScheduler();
      out.scheduler = { ok: true, running: false };
    }
  } catch (err) {
    console.error('[예약] 적용 실패:', err && err.message ? err.message : err);
  }
  return out;
}

function watcherStatus() {
  if (!watcher) return null;
  try {
    return typeof watcher.status === 'function' ? watcher.status() : { running: true };
  } catch (err) {
    return { error: err && err.message ? err.message : String(err) };
  }
}

async function handleWatcherGet(res) {
  const mod = needModule(res, 'watcher', []);
  if (!mod) return;
  const cfg = readConfigSafe();
  return sendJson(res, 200, {
    ok: true,
    enabled: !!watcher,
    configEnabled: !!(cfg && isPlainObject(cfg.watcher) && cfg.watcher.enabled),
    status: watcherStatus(),
    alerts: recentAlerts.slice(),
  });
}

async function handleWatcherPost(req, res) {
  const mod = needModule(res, 'watcher', []);
  if (!mod) return;
  let body;
  try {
    body = await readJsonBody(req);
  } catch (_) {
    return sendJson(res, 400, { error: '잘못된 요청 본문(JSON 파싱 실패).' });
  }
  if (typeof body.enabled !== 'boolean') {
    return sendJson(res, 400, { error: 'enabled(true|false)가 필요합니다.' });
  }
  const enabled = body.enabled;

  // 설정에도 반영한다(모듈이 없으면 런타임 토글만 한다).
  let cfg = readConfigSafe();
  const cfgMod = loadModule('config');
  if (cfg && cfgMod && typeof cfgMod.saveConfig === 'function') {
    try {
      const merged = deepMerge(cfg, { watcher: { enabled } });
      const saved = await cfgMod.saveConfig(merged);
      cfg = isPlainObject(saved) ? saved : merged;
    } catch (err) {
      console.error('[감시] 설정 저장 실패:', err && err.message ? err.message : err);
      cfg = deepMerge(cfg, { watcher: { enabled } });
    }
  } else {
    cfg = deepMerge(cfg || {}, { watcher: { enabled } });
  }

  const result = enabled ? startWatcher(cfg) : (stopWatcher(), { ok: true, running: false });
  if (enabled && !result.ok) {
    return sendJson(res, 500, { error: '감시를 시작하지 못했습니다.', detail: result.error });
  }
  return sendJson(res, 200, {
    ok: true,
    enabled: !!watcher,
    status: watcherStatus(),
    alerts: recentAlerts.slice(),
  });
}

// ---- 가격 조회기 (성적표·포지션 평가용) ---------------------------------
// 티커 시세는 이미 60초 캐시가 있다. 여기서 한 번 데워두고,
// **동기 함수**를 넘긴다 — stats.js 가 await 없이 호출해도 안전하도록.
async function buildPriceMap() {
  const map = new Map();
  try {
    const tape = await getTape();
    for (const row of Array.isArray(tape) ? tape : []) {
      if (row && row.sym && Number.isFinite(row.price)) {
        map.set(String(row.sym).toUpperCase(), row.price);
      }
    }
  } catch (err) {
    console.error('[시세] 가격표 준비 실패:', err && err.message ? err.message : err);
  }
  return map;
}

// 성적표용 캔들 캐시 — 요청 간에도 유지한다(성적표는 자주 새로고침되는데
// 심볼마다 fetchMarket을 다시 돌리면 페이지가 수십 초씩 걸린다).
const statsCandleCache = new Map(); // SYMBOL -> { ts, data }
const STATS_CANDLE_TTL_MS = 10 * 60 * 1000;

function priceLookupFrom(map) {
  // 성적표(stats.js)는 판정의 성패를 보려면 "판정 시점 이후의 가격 흐름"이 필요하다.
  // 현재가 하나만 주면 기준가가 없어 전부 pending 으로 떨어지므로, 계약대로
  // { candles: [{t,c}] } 를 돌려주는 캔들 공급자를 만든다.
  const candleCache = statsCandleCache;

  return async function priceLookup(symbol) {
    if (symbol == null) return null;
    const key = String(symbol).trim().toUpperCase();
    const hit = candleCache.get(key);
    if (hit && Date.now() - hit.ts < STATS_CANDLE_TTL_MS) return hit.data;

    let out = null;
    try {
      const resolved = resolveSymbol(key);
      const m = await fetchMarket(resolved);
      const candles = Array.isArray(m && m.candles)
        ? m.candles.map((c) => ({ t: c.t, c: c.c })).filter((c) => Number.isFinite(c.c))
        : [];
      if (candles.length) out = { candles };
    } catch (err) {
      console.error(
        `[성적표] ${key} 캔들 조회 실패 — 이 심볼의 판정은 평가 불가로 남습니다:`,
        err && err.message ? err.message : err
      );
    }

    // 캔들을 못 구했으면 최소한 현재가라도 알려준다(평가 불가 표기는 stats.js가 한다).
    if (!out) {
      const px = map.get(key);
      if (Number.isFinite(px)) out = { candles: [], price: px };
    }
    candleCache.set(key, { ts: Date.now(), data: out });
    return out;
  };
}

function mapToObject(map) {
  const obj = {};
  for (const [k, v] of map) obj[k] = v;
  return obj;
}

// ---- 성적표 ------------------------------------------------------------
async function handleStatsApi(res) {
  const mod = needModule(res, 'stats', ['buildStats']);
  if (!mod) return;
  const priceLookup = priceLookupFrom(await buildPriceMap());
  try {
    const data = await mod.buildStats({ priceLookup });
    return sendJson(res, 200, data);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error('[성적표] 집계 실패:', msg);
    return sendJson(res, 500, { error: '성적표 집계에 실패했습니다.', detail: msg });
  }
}

// GET /stats — public/stats.html 서빙. 아직 없으면 안내 문구를 200으로 준다.
async function handleStatsPage(res) {
  const target = path.join(PUBLIC_DIR, 'stats.html');
  try {
    const data = await fsp.readFile(target);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': data.length,
    });
    return res.end(data);
  } catch (_) {
    const html =
      '<!doctype html><html lang="ko"><head><meta charset="utf-8">' +
      '<title>성적표 — PIXEL TRADING FLOOR</title>' +
      '<style>body{background:#1a1a24;color:#eee;font-family:monospace;padding:24px;line-height:1.7}' +
      'a{color:#e8c84a}h1{font-size:18px;color:#e8c84a}</style></head><body>' +
      '<h1>◆ 성적표 준비 중 ◆</h1>' +
      '<p>성적표 화면(<code>public/stats.html</code>)이 아직 준비되지 않았습니다.</p>' +
      '<p>집계 데이터는 <a href="/api/stats">/api/stats</a> 에서 먼저 확인할 수 있습니다.</p>' +
      '<p><a href="/">← 플로어로 돌아가기</a></p></body></html>';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }
}

// ---- 가상 포지션 -------------------------------------------------------
// listPositions() 가 배열을 주든 {open, closed} 를 주든 같은 모양으로 정규화한다.
function normalizePositions(list) {
  if (Array.isArray(list)) return { open: list, closed: [] };
  if (isPlainObject(list)) {
    return {
      open: Array.isArray(list.open) ? list.open : [],
      closed: Array.isArray(list.closed) ? list.closed : [],
    };
  }
  return { open: [], closed: [] };
}

async function readPositions(mod, prices) {
  if (prices && typeof mod.markToMarket === 'function') {
    try {
      await mod.markToMarket(prices);
    } catch (err) {
      console.error('[포지션] 평가 실패:', err && err.message ? err.message : err);
    }
  }
  let list = null;
  try {
    list = typeof mod.listPositions === 'function' ? await mod.listPositions() : null;
  } catch (err) {
    console.error('[포지션] 조회 실패:', err && err.message ? err.message : err);
  }
  // listPositions()가 summary를 함께 주면 그걸 쓰고, 아니면 따로 계산한다.
  let summary = isPlainObject(list) && isPlainObject(list.summary) ? list.summary : null;
  if (!summary) {
    try {
      summary = typeof mod.summary === 'function' ? await mod.summary() : null;
    } catch (err) {
      console.error('[포지션] 요약 실패:', err && err.message ? err.message : err);
    }
  }
  return Object.assign({ ok: true, summary }, normalizePositions(list));
}

async function handlePositionsGet(res) {
  const mod = needModule(res, 'positions', ['listPositions']);
  if (!mod) return;
  const prices = mapToObject(await buildPriceMap());
  return sendJson(res, 200, await readPositions(mod, prices));
}

async function handlePositionsClose(req, res) {
  const mod = needModule(res, 'positions', ['closePosition']);
  if (!mod) return;
  let body;
  try {
    body = await readJsonBody(req);
  } catch (_) {
    return sendJson(res, 400, { error: '잘못된 요청 본문(JSON 파싱 실패).' });
  }
  const id = body.id != null ? String(body.id) : '';
  if (!id) return sendJson(res, 400, { error: '포지션 id가 필요합니다.' });

  let price = Number(body.price);
  const reason = typeof body.reason === 'string' && body.reason ? body.reason : '수동 청산';

  // 가격을 안 주면 현재 시세로 채운다. 그래도 없으면 null 로 넘긴다(지어내지 않는다).
  if (!Number.isFinite(price)) {
    price = null;
    try {
      const map = await buildPriceMap();
      const lookup = priceLookupFrom(map);
      const { open } = normalizePositions(
        typeof mod.listPositions === 'function' ? await mod.listPositions() : null
      );
      const found = open.find((p) => p && String(p.id) === id);
      if (found) {
        const p = lookup(found.symbol || found.display);
        if (Number.isFinite(p)) price = p;
      }
    } catch (_) {}
  }

  let closed;
  try {
    closed = await mod.closePosition(id, { price, reason });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error('[포지션] 청산 실패:', msg);
    return sendJson(res, 500, { error: '포지션 청산에 실패했습니다.', detail: msg });
  }
  if (!closed) return sendJson(res, 404, { error: '해당 포지션을 찾지 못했습니다.', id });

  broadcast({ type: 'position', action: 'close', position: closed });
  const snapshot = await readPositions(mod, null);
  return sendJson(res, 200, Object.assign({ ok: true, position: closed }, snapshot));
}

// ---- 워치리스트 일괄 스캔 ----------------------------------------------
async function handleScan(req, res) {
  const mod = needModule(res, 'scanner', ['scanWatchlist']);
  if (!mod) return;
  let body;
  try {
    body = await readJsonBody(req);
  } catch (_) {
    return sendJson(res, 400, { error: '잘못된 요청 본문(JSON 파싱 실패).' });
  }
  if (engine.running) return sendJson(res, 409, { error: '이미 분석이 진행 중입니다.' });
  const busy = scanning || (typeof mod.isScanning === 'function' && mod.isScanning());
  if (busy) return sendJson(res, 409, { error: '이미 스캔이 진행 중입니다.' });
  if (replaying) return sendJson(res, 409, { error: '리포트 재생이 진행 중입니다.' });

  const cfg = readConfigSafe();
  const symbols = (Array.isArray(body.symbols) && body.symbols.length
    ? body.symbols
    : (cfg && Array.isArray(cfg.watchlist) ? cfg.watchlist : [])
  )
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  if (!symbols.length) {
    return sendJson(res, 400, { error: '스캔할 심볼이 없습니다(워치리스트가 비어 있습니다).' });
  }
  const mode =
    body.mode === 'algo' || body.mode === 'attack' || body.mode === 'scalp'
      ? body.mode
      : 'scalp';
  const mock = !!body.demo;

  scanning = true;
  // start·item·done 이벤트는 scanner 가 onProgress 로 직접 준다.
  // 서버가 또 만들면 중복이 되므로 그대로 중계만 한다(실패 시에만 done을 대신 낸다).
  mod
    .scanWatchlist({
      engine,
      symbols,
      mode,
      mock,
      onProgress: (p) => {
        if (!isPlainObject(p)) return;
        broadcast(Object.assign({ type: 'scan', phase: 'item' }, p));
      },
    })
    .then((ranking) => {
      lastScan = { ts: new Date().toISOString(), mode, symbols, ranking: ranking || [] };
    })
    .catch((err) => {
      const msg = err && err.message ? err.message : String(err);
      console.error('[스캔] 실패:', msg);
      broadcast({ type: 'scan', phase: 'done', mode, ranking: [], error: msg });
    })
    .finally(() => {
      scanning = false;
    });

  return sendJson(res, 202, { ok: true, symbols, mode, mock });
}

// ---- 리포트 재생 -------------------------------------------------------
function normalizeReplayEvents(parsed) {
  if (Array.isArray(parsed)) return parsed.filter((e) => isPlainObject(e));
  if (isPlainObject(parsed) && Array.isArray(parsed.events)) {
    return parsed.events.filter((e) => isPlainObject(e));
  }
  return null;
}

// parseReport 의 인자 형태를 알 수 없으므로(본문/경로/객체) 순서대로 시도한다.
async function parseReportSafe(mod, text, fullPath) {
  const attempts = [() => mod.parseReport(text), () => mod.parseReport(fullPath), () => mod.parseReport({ text, path: fullPath })];
  for (const attempt of attempts) {
    try {
      const evts = normalizeReplayEvents(await attempt());
      if (evts && evts.length) return evts;
    } catch (_) {
      /* 다음 형태로 재시도 */
    }
  }
  return null;
}

// replayEvents 가 없거나 호출에 실패했을 때 쓰는 서버 내장 재생기
async function fallbackReplay(events, speed, emit) {
  const base = 400;
  for (const evt of events) {
    emit(evt);
    const d = Number(evt && (evt.delayMs != null ? evt.delayMs : evt.delay));
    await sleep((Number.isFinite(d) ? d : base) / (speed > 0 ? speed : 1));
  }
}

async function runReplay(mod, events, speed) {
  const emit = (evt) => broadcast(evt);
  if (typeof mod.replayEvents === 'function') {
    let ret;
    try {
      ret = mod.replayEvents(events, { speed, onEvent: emit, emit });
    } catch (err) {
      console.error(
        '[재생] replayEvents 호출 실패 — 서버 내장 재생으로 대체:',
        err && err.message ? err.message : err
      );
      return fallbackReplay(events, speed, emit);
    }
    // 이벤트 배열만 돌려주는 구현이면 서버가 직접 흘린다.
    if (Array.isArray(ret)) return fallbackReplay(ret, speed, emit);
    try {
      await ret;
    } catch (err) {
      console.error('[재생] 실패:', err && err.message ? err.message : err);
    }
    return;
  }
  return fallbackReplay(events, speed, emit);
}

async function handleReplay(res, searchParams) {
  const mod = needModule(res, 'replay', ['parseReport']);
  if (!mod) return;
  if (engine.running) return sendJson(res, 409, { error: '이미 분석이 진행 중입니다.' });
  if (replaying) return sendJson(res, 409, { error: '이미 재생이 진행 중입니다.' });

  let file = (searchParams && searchParams.get('file')) || '';

  // file=latest — 가장 최근 리포트를 재생한다.
  //
  // 자동 실행(금요일 16:10)은 화면 없이 돌아 리포트만 남긴다. 그래서 "에이전트가
  // 실행만 되고 대화를 안 한다"고 보인다. 대화는 리포트 안에 그대로 있고,
  // 이 경로가 그것을 화면으로 되돌린다 — 파일 이름을 몰라도 되게 한다.
  if (file === 'latest') {
    let newest = null;
    try {
      const names = (await fsp.readdir(REPORTS_DIR)).filter((n) => n.endsWith('.md'));
      for (const n of names) {
        const st = await fsp.stat(path.join(REPORTS_DIR, n)).catch(() => null);
        if (st && (!newest || st.mtimeMs > newest.t)) newest = { name: n, t: st.mtimeMs };
      }
    } catch (_) {}
    if (!newest) {
      return sendJson(res, 404, {
        error: '재생할 리포트가 없습니다. 분석을 한 번 돌린 뒤에 다시 시도하십시오.',
      });
    }
    file = newest.name;
  }
  if (!file) return sendJson(res, 400, { error: 'file 파라미터가 필요합니다.' });

  // 경로 탈출 방지 + .md 만 허용 (기존 /reports 라우트와 동일한 규칙)
  const rel = String(file).replace(/^\/?reports\/?/, '');
  const target = path.normalize(path.join(REPORTS_DIR, rel));
  if (!target.startsWith(REPORTS_DIR) || !target.endsWith('.md')) {
    return sendJson(res, 403, { error: '허용되지 않은 파일 경로입니다.' });
  }
  let text;
  try {
    text = await fsp.readFile(target, 'utf8');
  } catch (_) {
    return sendJson(res, 404, { error: '리포트를 찾지 못했습니다.', file });
  }

  const events = await parseReportSafe(mod, text, target);
  if (!events || !events.length) {
    return sendJson(res, 422, { error: '리포트에서 재생할 이벤트를 복원하지 못했습니다.', file });
  }

  const rawSpeed = Number(searchParams && searchParams.get('speed'));
  const speed = Number.isFinite(rawSpeed) && rawSpeed > 0 ? Math.min(rawSpeed, 50) : 1;
  const name = path.basename(target);

  replaying = true;
  broadcast({ type: 'log', kind: 'stage', line: `── 리포트 재생: ${name} (x${speed}) ──` });
  runReplay(mod, events, speed)
    .catch((err) => {
      console.error('[재생] 처리 오류:', err && err.message ? err.message : err);
    })
    .finally(() => {
      replaying = false;
      broadcast({ type: 'log', kind: 'stage', line: `── 재생 종료: ${name} ──` });
    });

  return sendJson(res, 202, { ok: true, file: name, events: events.length, speed });
}

// ---- 텔레그램 테스트 발송 ----------------------------------------------
async function handleTelegramTest(req, res) {
  const mod = needModule(res, 'notify', ['sendMessage']);
  if (!mod) return;
  let body;
  try {
    body = await readJsonBody(req);
  } catch (_) {
    return sendJson(res, 400, { error: '잘못된 요청 본문(JSON 파싱 실패).' });
  }
  const cfg = readConfigSafe();
  const tele = cfg && isPlainObject(cfg.telegram) ? cfg.telegram : null;
  if (!tele || !tele.botToken || !tele.chatId) {
    return sendJson(res, 400, {
      error: '텔레그램 봇 토큰과 chatId를 먼저 설정하세요.',
      tokenSet: !!(tele && tele.botToken),
      chatIdSet: !!(tele && tele.chatId),
    });
  }
  const text =
    typeof body.text === 'string' && body.text.trim()
      ? body.text.trim()
      : '◆ PIXEL TRADING FLOOR 연결 테스트입니다. 이 메시지가 보이면 알림 설정이 정상입니다.';

  // 사용자가 명시적으로 "테스트 발송"을 누른 상황이므로, 아직 enabled=false 여도
  // 이 한 건은 보낸다(토큰이 맞는지 켜기 전에 확인하는 게 이 버튼의 용도다).
  const forced = !cfg.telegram.enabled;
  const sendCfg = forced ? deepMerge(cfg, { telegram: { enabled: true } }) : cfg;

  let result;
  try {
    result = await mod.sendMessage(text, sendCfg);
  } catch (err) {
    // notify 는 throw 하지 않기로 돼 있지만, 계약이 깨져도 서버는 버틴다.
    const msg = err && err.message ? err.message : String(err);
    console.error('[텔레그램] 테스트 발송 실패:', msg);
    return sendJson(res, 200, { ok: false, error: '발송에 실패했습니다.', detail: msg });
  }
  const ok = !(result === false || (isPlainObject(result) && result.ok === false));
  return sendJson(res, 200, {
    ok,
    sent: ok,
    forced, // 설정이 꺼져 있는데도 테스트로 한 건 보냈다는 표시
    error: ok ? undefined : (isPlainObject(result) && result.error) || '발송에 실패했습니다.',
    result: scrubToken(result, tele.botToken),
  });
}

// ---- 라우터 ----
const server = http.createServer(async (req, res) => {
  let pathname = '/';
  let searchParams = null;
  try {
    const u = new URL(req.url, 'http://localhost');
    pathname = u.pathname;
    searchParams = u.searchParams;
  } catch (_) {
    pathname = req.url || '/';
  }

  try {
    if (req.method === 'GET' && pathname === '/api/stream') {
      return handleStream(req, res);
    }
    if (req.method === 'GET' && (pathname === '/reports' || pathname.startsWith('/reports/'))) {
      return await handleReports(req, res, pathname, searchParams);
    }
    if (req.method === 'GET' && pathname === '/project.zip') {
      return await handleProjectZip(res);
    }
    if (req.method === 'POST' && pathname === '/api/analyze') {
      return await handleAnalyze(req, res);
    }
    if (req.method === 'GET' && pathname === '/api/tape') {
      return await handleTape(res);
    }
    if (req.method === 'GET' && pathname === '/api/board') {
      return await handleBoard(res, searchParams);
    }

    // --- v2 신규 라우트 ---
    if (pathname === '/api/config') {
      if (req.method === 'GET') return await handleConfigGet(res);
      if (req.method === 'POST') return await handleConfigPost(req, res);
    }
    if (pathname === '/api/watcher') {
      if (req.method === 'GET') return await handleWatcherGet(res);
      if (req.method === 'POST') return await handleWatcherPost(req, res);
    }
    if (req.method === 'GET' && pathname === '/api/stats') {
      return await handleStatsApi(res);
    }
    if (req.method === 'GET' && (pathname === '/stats' || pathname === '/stats/')) {
      return await handleStatsPage(res);
    }
    if (req.method === 'GET' && pathname === '/api/positions') {
      return await handlePositionsGet(res);
    }
    if (req.method === 'POST' && pathname === '/api/positions/close') {
      return await handlePositionsClose(req, res);
    }
    if (req.method === 'POST' && pathname === '/api/scan') {
      return await handleScan(req, res);
    }
    if (req.method === 'GET' && pathname === '/api/replay') {
      return await handleReplay(res, searchParams);
    }
    if (req.method === 'POST' && pathname === '/api/telegram/test') {
      return await handleTelegramTest(req, res);
    }

    // --- 통합 라우트 (docs/integration.md) ---
    if (req.method === 'GET' && pathname === '/api/ki') {
      return await handleKi(res, searchParams);
    }

    if (req.method === 'GET') {
      return await handleStatic(req, res, pathname);
    }
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('405 Method Not Allowed');
  } catch (err) {
    console.error('[server] 처리 오류:', err && err.message ? err.message : err);
    if (!res.headersSent) sendJson(res, 500, { error: '서버 내부 오류.' });
    else res.end();
  }
});

// 기동 시 설정을 읽어 감시·예약을 자동 시작한다(enabled 가 true 일 때만).
// 여기서 무슨 일이 나도 서버 기동은 계속된다.
function bootRuntime() {
  const cfg = readConfigSafe();
  if (!cfg) {
    console.log('  설정 모듈 없음 — 감시·예약 비활성 (server/config.js 준비 전)');
    return;
  }
  const r = applyRuntime(cfg);
  const wOn = !!(isPlainObject(cfg.watcher) && cfg.watcher.enabled);
  const sOn = !!(isPlainObject(cfg.schedule) && cfg.schedule.enabled);
  console.log(
    `  감시: ${wOn ? (watcher ? '가동' : '시작 실패 — ' + ((r.watcher && r.watcher.error) || '원인 미상')) : '꺼짐'}` +
      ` · 예약: ${sOn ? (scheduler ? '가동' : '시작 실패 — ' + ((r.scheduler && r.scheduler.error) || '원인 미상')) : '꺼짐'}`
  );
}

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log('====================================');
  console.log('  ◆ PIXEL TRADING FLOOR ◆');
  console.log(`  서버 실행 중: ${url}`);
  console.log(`  데모 모드: ${url}/?demo=1`);
  console.log('  종료: Ctrl+C');
  try {
    bootRuntime();
  } catch (err) {
    console.error('  런타임 초기화 실패(서버는 계속 동작):', err && err.message ? err.message : err);
  }
  console.log('====================================');
});

// 종료 시 타이머를 정리한다(감시·예약이 프로세스를 붙잡지 않도록).
function shutdown() {
  try {
    stopWatcher();
  } catch (_) {}
  try {
    stopScheduler();
  } catch (_) {}
}
process.on('SIGINT', () => {
  shutdown();
  process.exit(0);
});
process.on('SIGTERM', () => {
  shutdown();
  process.exit(0);
});

module.exports = { server, engine, broadcast };
