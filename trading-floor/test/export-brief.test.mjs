import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const brief = require('../server/export-brief.js');
const { Engine } = require('../server/engine.js');

// ---------------------------------------------------------------------------
// 사이드카 한 건 만들기 — 엔진의 실제 빌더를 쓴다.
// 손으로 쓴 픽스처는 엔진이 바뀌어도 통과해 버려서 계약을 지켜 주지 못한다.
// ---------------------------------------------------------------------------

const engine = new Engine();

function makeRun({
  symbol = 'SKHYNIX',
  nameKo = 'SK하이닉스',
  krCode = '000660',
  kind = 'krstock',
  ts = '2026-09-04T01:30:00Z',
  action = 'BUY',
  confidence = 64,
  kiAsOf = '2026-08-12',
} = {}) {
  return engine._runRecord(
    { symbol, display: symbol, kind, nameKo },
    {
      krCode,
      priceLine: `${nameKo} 1,504,000원`,
      ki: kiAsOf ? { stocks: { [krCode]: { as_of: kiAsOf } } } : null,
    },
    false,
    'algo',
    `${ts.slice(0, 10)}-${symbol}-1030.md`,
    [{ id: 'diana', name: 'DIANA', bubble: '처분에 시간이 걸린다', report: '37.3영업일.' }],
    [],
    [],
    [],
    null,
    [],
    {
      action,
      confidence,
      entry: '1,480,000원',
      stop: '1,400,000원',
      target: '1,700,000원',
      rationale: '근거',
      risk: { rr: 2.75, ok: true, minRR: 1.5, reasons: [] },
    },
    new Date(ts)
  );
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brief-'));
}

function writeRun(dir, name, rec) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(rec, null, 2), 'utf8');
}

// ------------------------------------------------------------- _runRecord

test('사이드카는 floor.run/1 이고 조인 키(krCode)를 담는다', () => {
  const r = makeRun();
  assert.equal(r.schema, 'floor.run/1');
  assert.equal(r.krCode, '000660');
  assert.equal(r.kiAsOf, '2026-08-12', '어느 시점 원장을 보고 판단했는지 남아야 한다');
  assert.equal(r.decision.action, 'BUY');
  assert.equal(r.decision.confidence, 64);
});

test('사이드카는 없는 값을 0·빈 문자열로 위장하지 않는다', () => {
  const r = engine._runRecord(
    { symbol: 'BTC', display: 'BTC', kind: 'crypto' },
    {},
    true,
    'algo',
    'x.md',
    [],
    [],
    [],
    [],
    null,
    null,
    { action: 'HOLD' },
    new Date('2026-09-04T00:00:00Z')
  );
  assert.equal(r.krCode, null, '한국 주식이 아니면 코드는 null');
  assert.equal(r.kiAsOf, null);
  assert.equal(r.decision.confidence, null, '확신도 없음이 0으로 둔갑하면 안 된다');
  assert.equal(r.decision.entry, null);
  assert.equal(r.pm, null);
  assert.deepEqual(r.memory, []);
});

// ------------------------------------------------------------------ keyOf

test('keyOf: 한국 주식은 KRX 코드, 그 외는 표시명', () => {
  assert.equal(brief.keyOf(makeRun()), '000660');
  assert.equal(brief.keyOf({ display: 'BTC' }), 'BTC');
  assert.equal(brief.keyOf({}), 'UNKNOWN');
});

// -------------------------------------------------------------- buildBrief

test('buildBrief: 코드로 키를 잡고 한국 상장 여부를 가른다', () => {
  const b = brief.buildBrief(
    [makeRun(), makeRun({ symbol: 'BTC', nameKo: null, krCode: null, kind: 'crypto' })],
    { mode: 'algo', ran: true, errors: [] }
  );
  assert.equal(b.schema, 'agent.brief/1');
  assert.equal(b.executed, true, '실제로 돌렸는지가 기록돼야 한다');
  assert.deepEqual(Object.keys(b.runs).sort(), ['000660', 'BTC']);
  assert.deepEqual(b.by_code, ['000660']);
  assert.deepEqual(b.others, ['BTC']);
  assert.ok(b.disclaimer.includes('투자 조언이 아닙니다'));
});

test('buildBrief: 수집만 했으면 executed 가 false 다', () => {
  const b = brief.buildBrief([makeRun()], { mode: 'algo', ran: false, errors: [] });
  assert.equal(b.executed, false);
});

test('buildBrief: 실패한 종목은 errors 로 남기고 판정을 지어내지 않는다', () => {
  const b = brief.buildBrief([], {
    mode: 'algo',
    ran: true,
    errors: [{ symbol: 'SAMSUNG', message: 'Yahoo chart HTTP 403' }],
  });
  assert.deepEqual(Object.keys(b.runs), []);
  assert.equal(b.errors.length, 1);
  assert.equal(b.errors[0].symbol, 'SAMSUNG');
});

// ------------------------------------------------------------- collectRuns

test('collectRuns: 종목별 최신 1건만 남긴다', async () => {
  const dir = tmpdir();
  writeRun(dir, 'old.json', makeRun({ ts: '2026-09-01T01:00:00Z', action: 'SELL' }));
  writeRun(dir, 'new.json', makeRun({ ts: '2026-09-04T01:00:00Z', action: 'BUY' }));
  const { runs } = await brief.collectRuns({ dir });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].decision.action, 'BUY', '최신 판정이 남아야 한다');
});

test('collectRuns: 장부·성적표·자기 출력물은 런으로 오해하지 않는다', async () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'decisions.json'), '[{"symbol":"X"}]');
  fs.writeFileSync(path.join(dir, 'positions.json'), '{"open":[]}');
  fs.writeFileSync(path.join(dir, 'agent-brief.json'), '{"schema":"agent.brief/1"}');
  writeRun(dir, 'run.json', makeRun());
  const { runs } = await brief.collectRuns({ dir });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].krCode, '000660');
});

test('collectRuns: 스키마가 다르거나 깨진 파일은 건너뛴다', async () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'a.json'), '{ 깨짐');
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ schema: 'other/1', ts: '2026-09-04T00:00:00Z' }));
  const { runs } = await brief.collectRuns({ dir });
  assert.deepEqual(runs, []);
});

test('collectRuns: --symbols 로 대상을 좁힌다', async () => {
  const dir = tmpdir();
  writeRun(dir, 'a.json', makeRun());
  writeRun(dir, 'b.json', makeRun({ symbol: 'SAMSUNG', nameKo: '삼성전자', krCode: '005930' }));
  const { runs } = await brief.collectRuns({ dir, symbols: ['SAMSUNG'] });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].krCode, '005930');
});

test('collectRuns: 오래된 분석은 --max-age-hours 로 제외한다', async () => {
  const dir = tmpdir();
  const old = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const fresh = new Date(Date.now() - 1 * 3600 * 1000).toISOString();
  writeRun(dir, 'old.json', makeRun({ symbol: 'SAMSUNG', krCode: '005930', ts: old }));
  writeRun(dir, 'fresh.json', makeRun({ ts: fresh }));
  const { runs } = await brief.collectRuns({ dir, maxAgeHours: 24 });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].krCode, '000660');
});

test('collectRuns: reports 디렉터리가 없어도 죽지 않는다', async () => {
  const { runs, note } = await brief.collectRuns({ dir: '/존재하지/않는/디렉터리' });
  assert.deepEqual(runs, []);
  assert.ok(note, '왜 비었는지 알려야 한다');
});

// --------------------------------------------------------------- parseArgs

test('parseArgs: 기본은 분석을 실행하지 않는다 (비용이 큰 동작은 명시적으로만)', () => {
  const a = brief.parseArgs([]);
  assert.equal(a.run, false);
  assert.equal(a.mode, 'algo');
  assert.equal(a.demo, false);
});

test('parseArgs: --run --symbols --mode 를 읽는다', () => {
  const a = brief.parseArgs(['--run', '--symbols', 'SKHYNIX,SAMSUNG', '--mode', 'scalp']);
  assert.equal(a.run, true);
  assert.deepEqual(a.symbols, ['SKHYNIX', 'SAMSUNG']);
  assert.equal(a.mode, 'scalp');
});

test('parseArgs: 모르는 인자와 잘못된 모드를 거부한다', () => {
  assert.ok(brief.parseArgs(['--nope']).error);
  assert.ok(brief.parseArgs(['--mode', 'yolo']).error);
  assert.ok(brief.parseArgs(['--max-age-hours', 'abc']).error);
});
