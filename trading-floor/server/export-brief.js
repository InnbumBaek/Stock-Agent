#!/usr/bin/env node
'use strict';

// PIXEL TRADING FLOOR — 에이전트 브리핑 내보내기 (export-brief)
//
// 에이전트들이 분석·토론해 내린 판정을 한 덩어리로 모아, 주가 모니터링
// 리포트(`../stock-monitor`)가 실을 수 있는 JSON 으로 낸다.
//
//   node server/export-brief.js --run --symbols SKHYNIX,SAMSUNG
//   node server/export-brief.js                      # 기존 리포트만 모은다 (분석 안 함)
//
// 계약(../docs/integration.md): 출력 스키마는 `agent.brief/1`.
//
// 원칙
//   - **stdout 은 사람용 진행 상황**이고, 결과는 파일로 쓴다. 파이썬이 파일을 읽는다.
//     (반대 방향인 ki_monitor.py facts 는 stdout 이 JSON 이다. 방향이 다르므로
//      규칙도 반대다 — 여기서는 몇 분씩 걸리는 진행 상황을 사람이 봐야 한다.)
//   - **없는 것을 지어내지 않는다.** 분석이 없는 종목은 빼거나 errors 에 이유를 남긴다.
//   - **--run 없이는 절대 분석을 돌리지 않는다.** 실전 런은 에이전트 최대 16명 × claude opus 라
//     비용이 크다. 기본 동작은 이미 저장된 리포트를 모으는 것뿐이다.
//   - 한 종목이 실패해도 나머지는 계속한다. 엔진은 동시 1건이라 순차로 돌린다.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const REPORTS_DIR = path.join(__dirname, '..', 'reports');
const DEFAULT_OUT = path.join(REPORTS_DIR, 'agent-brief.json');
const SCHEMA = 'agent.brief/1';
const RUN_SCHEMA = 'floor.run/1';

const DISCLAIMER =
  '본 브리핑은 AI 에이전트의 분석·토론 결과이며 투자 조언이 아닙니다. ' +
  '실제 주문·거래·자금 이동은 발생하지 않았습니다. ' +
  '판단과 책임은 이 문서를 읽는 사람에게 있습니다.';

// --- 인자 파싱 ----------------------------------------------------------

function parseArgs(argv) {
  const out = {
    out: DEFAULT_OUT,
    symbols: null,
    run: false,
    mode: 'algo',
    demo: false,
    maxAgeHours: null,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[(i += 1)];
    if (a === '--out') out.out = next();
    else if (a === '--symbols') out.symbols = splitList(next());
    else if (a === '--run') out.run = true;
    else if (a === '--mode') out.mode = next();
    else if (a === '--demo') out.demo = true;
    else if (a === '--max-age-hours') out.maxAgeHours = Number(next());
    else if (a === '--quiet') out.quiet = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else return { error: `알 수 없는 인자: ${a}` };
  }
  if (!['algo', 'scalp', 'attack'].includes(out.mode)) {
    return { error: `--mode 는 algo·scalp·attack 중 하나여야 합니다 (받은 값: ${out.mode})` };
  }
  if (out.maxAgeHours != null && !Number.isFinite(out.maxAgeHours)) {
    return { error: '--max-age-hours 는 숫자여야 합니다' };
  }
  return out;
}

function splitList(s) {
  return String(s || '')
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

const USAGE = `
사용법: node server/export-brief.js [옵션]

에이전트 판정을 모아 주가 모니터링 리포트가 읽을 JSON 을 만듭니다.

  --run                  실제로 분석을 실행합니다 (종목별 순차, 실전은 수 분/종목).
                         주지 않으면 이미 저장된 리포트만 모읍니다.
  --symbols A,B          대상 종목. 없으면 config.json 의 watchlist 를 씁니다.
  --mode algo|scalp|attack   --run 일 때의 파이프라인 (기본 algo)
  --demo                 --run 과 함께 — claude 없이 목업으로 돌립니다 (연결 시험용)
  --out <경로>           출력 파일 (기본 reports/agent-brief.json)
  --max-age-hours N      기존 리포트를 모을 때 N시간보다 오래된 건 제외
  --quiet                진행 상황 출력 안 함

예)
  node server/export-brief.js --run --symbols SKHYNIX,SAMSUNG --mode algo
  node server/export-brief.js --out ../stock-monitor/agent-brief.json
`.trim();

// --- 설정 ---------------------------------------------------------------

function loadWatchlist() {
  try {
    // eslint-disable-next-line global-require
    const { loadConfig } = require('./config');
    const cfg = loadConfig();
    if (Array.isArray(cfg.watchlist) && cfg.watchlist.length) return cfg.watchlist.slice();
  } catch (_) {
    /* config.js 가 없거나 깨져도 아래 기본값으로 간다 */
  }
  return ['SKHYNIX', 'SAMSUNG'];
}

// --- 기존 리포트 수집 ---------------------------------------------------

// reports/ 의 사이드카 JSON 을 읽어 종목별 최신 1건만 남긴다.
async function collectRuns({ symbols, maxAgeHours, dir }) {
  const reportsDir = dir || REPORTS_DIR;
  let names;
  try {
    names = await fsp.readdir(reportsDir);
  } catch (_) {
    return { runs: [], note: 'reports/ 디렉터리가 없습니다 — 아직 분석한 적이 없습니다.' };
  }

  const want = symbols ? new Set(symbols.map((s) => String(s).toUpperCase())) : null;
  const cutoff =
    maxAgeHours != null ? Date.now() - maxAgeHours * 3600 * 1000 : null;

  const latest = new Map(); // key -> record
  for (const name of names) {
    if (!name.endsWith('.json') || name === 'decisions.json' || name === 'positions.json') continue;
    if (path.resolve(reportsDir, name) === path.resolve(DEFAULT_OUT)) continue;
    if (name === 'agent-brief.json') continue; // 자기 출력물은 다시 읽지 않는다

    let rec;
    try {
      rec = JSON.parse(await fsp.readFile(path.join(reportsDir, name), 'utf8'));
    } catch (_) {
      continue; // 깨진 파일은 조용히 건너뛴다
    }
    if (!rec || rec.schema !== RUN_SCHEMA || !rec.ts) continue;

    const ts = Date.parse(rec.ts);
    if (!Number.isFinite(ts)) continue;
    if (cutoff != null && ts < cutoff) continue;
    if (want && !want.has(String(rec.display || '').toUpperCase())) continue;

    const key = keyOf(rec);
    const prev = latest.get(key);
    if (!prev || Date.parse(prev.ts) < ts) latest.set(key, rec);
  }

  return { runs: [...latest.values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b))) };
}

// 브리핑에서 이 런을 가리키는 키. 한국 주식은 KRX 코드 —
// 주가 모니터링 워치리스트가 그 코드로 조인한다.
function keyOf(rec) {
  return rec.krCode || String(rec.display || rec.symbol || 'UNKNOWN');
}

// --- 분석 실행 ----------------------------------------------------------

// 종목 하나를 분석하고 방금 저장된 사이드카를 읽어 돌려준다.
// 엔진은 동시 1건이므로 부르는 쪽이 순차로 호출해야 한다.
async function runOne(engine, symbol, { mode, demo, quiet }) {
  let savedPath = null;
  let errMsg = null;

  const onEvent = (evt) => {
    if (!evt) return;
    if (evt.type === 'saved') savedPath = evt.path;
    else if (evt.type === 'run:error') errMsg = evt.message || '알 수 없는 오류';
    else if (!quiet && evt.type === 'log' && evt.kind === 'stage') {
      process.stdout.write(`    ${evt.line}\n`);
    }
  };
  engine.on('event', onEvent);
  try {
    await engine.run(symbol, { mock: demo, mode });
  } catch (err) {
    errMsg = err && err.message ? err.message : String(err);
  } finally {
    engine.off('event', onEvent);
  }

  if (errMsg) return { error: errMsg };
  if (!savedPath) return { error: '리포트가 저장되지 않았습니다' };

  const jsonPath = path.join(__dirname, '..', savedPath.replace(/\.md$/, '.json'));
  try {
    const rec = JSON.parse(await fsp.readFile(jsonPath, 'utf8'));
    if (!rec || rec.schema !== RUN_SCHEMA) return { error: '사이드카 JSON 형식이 올바르지 않습니다' };
    return { record: rec };
  } catch (err) {
    return { error: `사이드카 JSON 을 읽지 못했습니다: ${err && err.message}` };
  }
}

// --- 브리핑 조립 --------------------------------------------------------

function buildBrief(runs, { mode, ran, errors }) {
  const byKey = {};
  const byCode = [];
  const others = [];

  for (const rec of runs) {
    const key = keyOf(rec);
    byKey[key] = rec;
    if (rec.krCode) byCode.push(rec.krCode);
    else others.push(key);
  }

  return {
    schema: SCHEMA,
    generated_at: new Date().toISOString(),
    source: 'PIXEL TRADING FLOOR',
    mode,
    // 이 브리핑을 만들 때 실제로 분석을 돌렸는가, 저장된 것을 모았을 뿐인가.
    // 리포트에 "언제 분석한 것인가"를 정직하게 적기 위한 구분이다.
    executed: !!ran,
    disclaimer: DISCLAIMER,
    runs: byKey,
    by_code: byCode.sort(),
    others: others.sort(),
    errors: errors.slice(),
  };
}

// --- main ---------------------------------------------------------------

async function main(argv) {
  const args = parseArgs(argv);
  if (args.error) {
    console.error(args.error);
    console.error('');
    console.error(USAGE);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const say = (s) => {
    if (!args.quiet) console.log(s);
  };
  const symbols = args.symbols || loadWatchlist();
  const errors = [];
  let runs = [];

  if (args.run) {
    say(`분석 실행 — ${symbols.length}종목 · 모드 ${args.mode}` + (args.demo ? ' · 데모' : ''));
    say('엔진은 동시 1건만 돌리므로 순차로 진행합니다.');
    // eslint-disable-next-line global-require
    const { Engine } = require('./engine');
    const engine = new Engine();
    for (const sym of symbols) {
      say(`  [${sym}] 분석 중...`);
      // eslint-disable-next-line no-await-in-loop
      const r = await runOne(engine, sym, { mode: args.mode, demo: args.demo, quiet: args.quiet });
      if (r.error) {
        say(`  [${sym}] 실패 — ${r.error}`);
        errors.push({ symbol: sym, message: r.error });
      } else {
        const d = r.record.decision || {};
        say(`  [${sym}] ${d.action || '?'} · 확신도 ${d.confidence != null ? d.confidence : '?'}%`);
        runs.push(r.record);
      }
    }
  } else {
    say('저장된 리포트를 모읍니다 (분석은 실행하지 않습니다 — 돌리려면 --run).');
    const collected = await collectRuns({
      symbols: args.symbols,
      maxAgeHours: args.maxAgeHours,
    });
    if (collected.note) say(`  ${collected.note}`);
    runs = collected.runs;
    for (const rec of runs) {
      const d = rec.decision || {};
      say(`  [${rec.display}] ${d.action || '?'} · ${rec.ts}`);
    }
  }

  const brief = buildBrief(runs, { mode: args.mode, ran: args.run, errors });
  const outPath = path.resolve(args.out);
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.writeFile(outPath, JSON.stringify(brief, null, 2) + '\n', 'utf8');

  say('');
  say(`브리핑 저장: ${outPath}`);
  say(`  판정 ${Object.keys(brief.runs).length}건` +
      (brief.by_code.length ? ` · 한국 상장 ${brief.by_code.length}종목 (${brief.by_code.join(', ')})` : '') +
      (brief.others.length ? ` · 그 외 ${brief.others.join(', ')}` : '') +
      (errors.length ? ` · 실패 ${errors.length}건` : ''));
  if (!Object.keys(brief.runs).length) {
    say('  판정이 하나도 없습니다 — 리포트에는 "분석 없음"으로 표시됩니다.');
  }
  return errors.length && !Object.keys(brief.runs).length ? 1 : 0;
}

module.exports = { buildBrief, collectRuns, keyOf, parseArgs, SCHEMA, RUN_SCHEMA, DISCLAIMER };

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('내보내기 실패:', err && err.message ? err.message : err);
      process.exit(1);
    });
}
