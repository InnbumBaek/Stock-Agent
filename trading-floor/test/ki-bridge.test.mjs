import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ki = require('../server/ki-bridge.js');
const { DEFAULTS } = require('../server/config.js');

// ---------------------------------------------------------------------------
// 가짜 파이썬 — 실제 원장·파이썬 없이 스폰 동작을 검증한다.
// child_process.spawn 이 돌려주는 것과 같은 모양(EventEmitter + stdout/stderr)을 낸다.
// ---------------------------------------------------------------------------

function fakeChild({ stdout = '', stderr = '', code = 0, delayMs = 0, error = null }) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {
    child.killed = true;
  };
  setTimeout(() => {
    if (error) {
      child.emit('error', error);
      return;
    }
    if (stdout) child.stdout.emit('data', stdout);
    if (stderr) child.stderr.emit('data', stderr);
    child.emit('close', code);
  }, delayMs);
  return child;
}

// 호출을 기록하는 spawn 대역. plan 은 실행 파일 이름별 응답이다.
function spyingSpawn(plan) {
  const calls = [];
  const fn = (bin, args) => {
    calls.push({ bin, args });
    const r = typeof plan === 'function' ? plan(bin, args) : plan;
    if (r instanceof Error) throw r;
    return fakeChild(r);
  };
  fn.calls = calls;
  return fn;
}

const ENOENT = Object.assign(new Error('spawn python3 ENOENT'), { code: 'ENOENT' });

// 최소한의 정상 응답 — ki.facts/1 스키마
function factsJson(code = '000660', extra = {}) {
  return JSON.stringify({
    ok: true,
    schema: 'ki.facts/1',
    assumptions: ['처분 소요일수 — 거래량의 10%만 소화한다고 가정합니다.'],
    units: { days_3pct: '영업일' },
    markets: {
      KOSPI: { as_of: '2026-08-12', n_days: 243, regime: {} },
    },
    stocks: {
      [code]: {
        found: true,
        code,
        name: 'SK하이닉스',
        market: 'KOSPI',
        as_of: '2026-08-12',
        stale_days: 1,
        close: 1504000,
        measures: { days_3pct: 37.3, pbr: 2.1 },
        observations: { liq: ['시가총액 3% 처분 소요 — 37.3영업일'], px: [], cap: [], fin: [], events: [] },
        volume_profile: [],
        ...extra,
      },
    },
    missing: [],
  });
}

// 설정을 인자로 주입한다 — config.json 을 건드리지 않는다.
const ON = { enabled: true, cacheMin: 30, timeoutSec: 5 };

function reset() {
  ki.clearCache();
  ki._setSpawn(null);
}

// ------------------------------------------------------------------ krCodeOf

test('krCodeOf: KRX 6자리 코드와 야후 접미사', () => {
  assert.equal(ki.krCodeOf('000660'), '000660');
  assert.equal(ki.krCodeOf('000660.KS'), '000660');
  assert.equal(ki.krCodeOf('035420.kq'), '035420');
  assert.equal(ki.krCodeOf(' 005930 '), '005930');
});

test('krCodeOf: 코드가 아닌 입력은 null (심볼을 코드로 착각하지 않는다)', () => {
  assert.equal(ki.krCodeOf('SKHYNIX'), null);
  assert.equal(ki.krCodeOf('BTC'), null);
  assert.equal(ki.krCodeOf('12345'), null); // 5자리
  assert.equal(ki.krCodeOf('1234567'), null); // 7자리
  assert.equal(ki.krCodeOf(null), null);
  assert.equal(ki.krCodeOf(undefined), null);
});

// -------------------------------------------------------------- 기본값 · 계약

test('기본값은 꺼짐 — 켜기 전까지 통합 이전과 동작이 같다', () => {
  assert.equal(ki.DEFAULT_KI.enabled, false);
  assert.equal(DEFAULTS.ki.enabled, false);
});

test('config.DEFAULTS.ki 와 ki-bridge.DEFAULT_KI 의 키가 일치한다', () => {
  // 한쪽에만 키가 생기면 설정이 조용히 무시된다 (config.js 는 미지의 키를 병합만 한다).
  assert.deepEqual(Object.keys(DEFAULTS.ki).sort(), Object.keys(ki.DEFAULT_KI).sort());
});

// ---------------------------------------------------------------- fetchKiFacts

test('꺼져 있으면 파이썬을 스폰하지 않는다', async () => {
  reset();
  const spawn = spyingSpawn({ stdout: factsJson() });
  ki._setSpawn(spawn);
  const r = await ki.fetchKiFacts('000660', { cfg: { enabled: false } });
  assert.equal(r, null);
  assert.equal(spawn.calls.length, 0);
  reset();
});

test('종목코드가 아니면 스폰하지 않는다', async () => {
  reset();
  const spawn = spyingSpawn({ stdout: factsJson() });
  ki._setSpawn(spawn);
  assert.equal(await ki.fetchKiFacts('BTC', { cfg: ON }), null);
  assert.equal(spawn.calls.length, 0);
  reset();
});

test('정상 응답을 파싱하고 facts 를 돌려준다', async () => {
  reset();
  const spawn = spyingSpawn({ stdout: factsJson() });
  ki._setSpawn(spawn);
  const r = await ki.fetchKiFacts('000660', { cfg: ON });
  assert.ok(r);
  assert.equal(r.schema, 'ki.facts/1');
  assert.equal(r.stocks['000660'].name, 'SK하이닉스');
  // 인자가 계약대로인가 — facts --code <6자리>
  const { args } = spawn.calls[0];
  assert.ok(args[0].endsWith('ki_monitor.py'));
  assert.deepEqual(args.slice(1), ['facts', '--code', '000660']);
  reset();
});

test('withDisclosures 를 켰을 때만 --with-disclosures 를 붙인다', async () => {
  reset();
  const spawn = spyingSpawn({ stdout: factsJson() });
  ki._setSpawn(spawn);
  await ki.fetchKiFacts('000660', { cfg: { ...ON, withDisclosures: true } });
  assert.ok(spawn.calls[0].args.includes('--with-disclosures'));
  reset();
});

test('같은 종목을 다시 물으면 캐시로 답한다 (파이썬 재스폰 없음)', async () => {
  reset();
  const spawn = spyingSpawn({ stdout: factsJson() });
  ki._setSpawn(spawn);
  await ki.fetchKiFacts('000660', { cfg: ON });
  await ki.fetchKiFacts('000660', { cfg: ON });
  await ki.fetchKiFacts('000660.KS', { cfg: ON }); // 같은 코드로 정규화된다
  assert.equal(spawn.calls.length, 1);
  reset();
});

test('ok:false 응답은 null 이고 throw 하지 않는다', async () => {
  reset();
  ki._setSpawn(
    spyingSpawn({ stdout: JSON.stringify({ ok: false, reason: '원장이 없습니다' }), code: 1 })
  );
  assert.equal(await ki.fetchKiFacts('000660', { cfg: ON }), null);
  reset();
});

test('JSON 이 아닌 출력은 null 이고 throw 하지 않는다', async () => {
  reset();
  ki._setSpawn(spyingSpawn({ stdout: 'Traceback (most recent call last):', code: 1 }));
  assert.equal(await ki.fetchKiFacts('000660', { cfg: ON }), null);
  reset();
});

test('경고 한 줄이 stdout 에 섞여도 JSON 을 건져낸다', async () => {
  reset();
  ki._setSpawn(spyingSpawn({ stdout: `UserWarning: ...\n${factsJson()}\n` }));
  const r = await ki.fetchKiFacts('000660', { cfg: ON });
  assert.ok(r && r.ok === true);
  reset();
});

test('python3 가 없으면 python 으로 넘어간다', async () => {
  reset();
  const spawn = spyingSpawn((bin) =>
    bin === 'python3' ? { error: ENOENT } : { stdout: factsJson() }
  );
  ki._setSpawn(spawn);
  const r = await ki.fetchKiFacts('000660', { cfg: ON });
  assert.ok(r, '두 번째 후보로 조회에 성공해야 한다');
  assert.deepEqual(spawn.calls.map((c) => c.bin), ['python3', 'python']);
  reset();
});

test('파이썬이 아예 없으면 null — 앱을 막지 않는다', async () => {
  reset();
  ki._setSpawn(spyingSpawn({ error: ENOENT }));
  assert.equal(await ki.fetchKiFacts('000660', { cfg: ON }), null);
  reset();
});

test('제한 시간을 넘기면 자식을 죽이고 null 을 돌려준다', async () => {
  reset();
  let spawned = null;
  ki._setSpawn((bin, args) => {
    spawned = fakeChild({ stdout: factsJson(), delayMs: 5000 });
    return spawned;
  });
  const r = await ki.fetchKiFacts('000660', { cfg: { ...ON, timeoutSec: 1 } });
  assert.equal(r, null);
  assert.equal(spawned.killed, true, '시간을 넘긴 자식 프로세스는 죽여야 한다');
  reset();
});

// ------------------------------------------------------------ fetchKiCandles

function candlesJson(code = '000660') {
  return JSON.stringify({
    ok: true,
    schema: 'ki.candles/1',
    code,
    name: 'SK하이닉스',
    market: 'KOSPI',
    currency: 'KRW',
    source: '한국거래소 KRX Open API — 일별 시세 (원장)',
    interval: '1d',
    adjusted: true,
    n: 2,
    first: '2026-08-11',
    as_of: '2026-08-12',
    stale_days: 23,
    candles: [
      { t: 1786406400000, o: 1405000, h: 1455000, l: 1373000, c: 1425000, v: 3817655 },
      { t: 1786492800000, o: 1456000, h: 1549000, l: 1440000, c: 1504000, v: 4566672 },
    ],
  });
}

test('fetchKiCandles: candles 서브커맨드를 --days 와 함께 부른다', async () => {
  reset();
  const spawn = spyingSpawn({ stdout: candlesJson() });
  ki._setSpawn(spawn);
  const r = await ki.fetchKiCandles('000660', { cfg: { ...ON, candleDays: 120 } });
  assert.ok(r && r.ok === true);
  assert.equal(r.candles.length, 2);
  const { args } = spawn.calls[0];
  assert.deepEqual(args.slice(1), ['candles', '--code', '000660', '--days', '120']);
  reset();
});

test('fetchKiCandles: 꺼져 있으면 스폰하지 않는다', async () => {
  reset();
  const spawn = spyingSpawn({ stdout: candlesJson() });
  ki._setSpawn(spawn);
  assert.equal(await ki.fetchKiCandles('000660', { cfg: { enabled: false } }), null);
  assert.equal(spawn.calls.length, 0);
  reset();
});

test('facts 와 candles 는 캐시를 공유하지 않는다', async () => {
  reset();
  const spawn = spyingSpawn((bin, args) => ({
    stdout: args.includes('candles') ? candlesJson() : factsJson(),
  }));
  ki._setSpawn(spawn);
  const f = await ki.fetchKiFacts('000660', { cfg: ON });
  const c = await ki.fetchKiCandles('000660', { cfg: ON });
  assert.equal(f.schema, 'ki.facts/1');
  assert.equal(c.schema, 'ki.candles/1', '캔들 요청이 실측 캐시를 받아오면 안 된다');
  assert.equal(spawn.calls.length, 2);
  reset();
});

// ----------------------------------------------------------- formatKiPriceLine

test('원장 시세 줄은 실시간이 아님을 반드시 밝힌다', () => {
  const line = ki.formatKiPriceLine(JSON.parse(candlesJson()), 'SK하이닉스');
  assert.ok(line.includes('SK하이닉스'));
  assert.ok(line.includes('1,504,000'), '마지막 종가');
  assert.ok(line.includes('2026-08-12'), '기준일');
  assert.ok(line.includes('23일 경과'));
  assert.ok(line.includes('실시간 호가가 아니다'), '일별 종가를 현재가로 읽으면 판정이 틀어진다');
});

test('원장 시세 줄은 전일 대비 등락을 실제 값으로 계산한다', () => {
  const line = ki.formatKiPriceLine(JSON.parse(candlesJson()), null);
  // (1504000 - 1425000) / 1425000 = +5.54%
  assert.ok(line.includes('+5.54%'), line);
});

test('캔들이 없으면 시세 줄을 만들지 않는다 (지어내지 않는다)', () => {
  assert.equal(ki.formatKiPriceLine(null, 'X'), null);
  assert.equal(ki.formatKiPriceLine({ ok: true, candles: [] }, 'X'), null);
  assert.equal(ki.formatKiPriceLine({ ok: false, candles: [{ c: 1 }] }, 'X'), null);
});

// --------------------------------------------------------------- formatKiLines

test('facts 가 없으면 붙일 줄이 없다 (빈 블록을 만들지 않는다)', () => {
  assert.deepEqual(ki.formatKiLines(null, '000660'), []);
  assert.deepEqual(ki.formatKiLines({ stocks: {} }, '000660'), []);
  assert.deepEqual(
    ki.formatKiLines({ stocks: { '000660': { found: false } } }, '000660'),
    []
  );
});

test('측정값·가정·기준일이 함께 나간다', () => {
  const facts = JSON.parse(factsJson());
  const out = ki.formatKiLines(facts, '000660').join('\n');
  assert.ok(out.includes('2026-08-12'), '원장 기준일이 있어야 한다');
  assert.ok(out.includes('37.3영업일'), '측정값이 있어야 한다');
  assert.ok(out.includes('10%만 소화'), '그 측정값이 선 가정이 함께 있어야 한다');
  assert.ok(out.includes('KRX') || out.includes('한국거래소'), '출처가 있어야 한다');
});

test('원장이 묵으면 "현재가가 아니다" 경고가 붙는다', () => {
  const fresh = JSON.parse(factsJson());
  assert.ok(!ki.formatKiLines(fresh, '000660').join('\n').includes('현재가가 아니다'));

  const stale = JSON.parse(factsJson());
  stale.stocks['000660'].stale_days = 30;
  const out = ki.formatKiLines(stale, '000660').join('\n');
  assert.ok(out.includes('30일'), '며칠 묵었는지 밝혀야 한다');
  assert.ok(out.includes('현재가가 아니다'), '일별 종가를 현재가로 읽으면 판정이 틀어진다');
});

test('판단(등급·점수·권고)을 만들어 내지 않는다', () => {
  const facts = JSON.parse(factsJson());
  const all = ki.formatKiLines(facts, '000660');

  // 마지막 안내문은 "등급·점수·권고가 아니다"라고 말하는 줄이라 금칙어를 품는다.
  // 검사 대상은 실제로 값을 나르는 줄이다.
  const disclaimer = all.filter((l) => l.includes('등급·점수·권고가 아니다'));
  assert.equal(disclaimer.length, 1, '측정값임을 밝히는 안내가 정확히 한 줄 있어야 한다');

  const data = all.filter((l) => !l.includes('등급·점수·권고가 아니다')).join('\n');
  for (const w of ['매수', '매도', '추천', '권고', '등급', '목표주가', '적정주가']) {
    assert.ok(!data.includes(w), `실측 블록에 '${w}' 가 들어가면 안 된다`);
  }
});

test('값이 없는 항목은 줄 자체를 만들지 않는다 (지어내지 않는다)', () => {
  const facts = JSON.parse(factsJson());
  const s = facts.stocks['000660'];
  s.measures = {}; // 측정값 전부 없음
  s.observations = { liq: [], px: [], cap: [], fin: [], events: [] };
  const out = ki.formatKiLines(facts, '000660').join('\n');
  assert.ok(!out.includes('[처분 여건'), '빈 관측은 블록을 만들지 않는다');
  assert.ok(!out.includes('[추가 측정값]'), '빈 측정값은 블록을 만들지 않는다');
  assert.ok(!out.includes('null') && !out.includes('undefined'), '결측이 문자열로 새면 안 된다');
});

test('요청한 코드와 다른 종목의 값을 섞지 않는다', () => {
  const facts = JSON.parse(factsJson('005930'));
  assert.deepEqual(ki.formatKiLines(facts, '000660'), []);
  assert.ok(ki.formatKiLines(facts, '005930').length > 0);
});

// ---------------------------------------------------------------------------
// 실시간 시세 (KIS) — ki.quote/1
//
// 원장은 일별 종가다. 며칠 지난 값을 현재가로 읽으면 목표가·괴리·손익비가
// 통째로 틀어지므로, 그 신선도만 실시간으로 메운다. 대신 **켜야 돈다.**
// ---------------------------------------------------------------------------

const RT = { enabled: true, realtime: true, cacheMin: 30, timeoutSec: 5, quoteCacheSec: 20 };

function quoteJson(over = {}) {
  return JSON.stringify({
    ok: true,
    schema: 'ki.quote/1',
    code: '000660',
    source: '한국투자증권 KIS Open API — 국내주식 현재가 · 호가',
    realtime: true,
    market_open: true,
    checks: [],
    quote: {
      price: 186200, open: 185000, high: 190000, low: 180000,
      prev_close: 185000, volume: 1234567, value: 2.3e11,
      bid: 186100, ask: 186300, bid_qty: 1200, ask_qty: 800,
      change_pct: 0.6486, spread_bp: 10.74, queue_imbalance: 0.2,
      ts: '2026-09-04T13:20:00',
    },
    ...over,
  });
}

test('실시간이 꺼져 있으면 파이썬을 스폰하지 않는다 (옵트인)', async () => {
  reset();
  const spawn = spyingSpawn({ stdout: quoteJson() });
  ki._setSpawn(spawn);
  // ki.enabled 는 켜져 있어도 realtime 이 꺼져 있으면 돌지 않아야 한다.
  assert.equal(await ki.fetchKiQuote('000660', { cfg: ON }), null);
  assert.equal(spawn.calls.length, 0, '실시간은 명시적으로 켤 때만 돈다');
  reset();
});

test('실시간 기본값은 꺼짐이다', () => {
  assert.equal(ki.DEFAULT_KI.realtime, false);
  assert.equal(DEFAULTS.ki.realtime, false);
});

test('quote 를 부를 때 quote 서브커맨드를 쓴다', async () => {
  reset();
  const spawn = spyingSpawn({ stdout: quoteJson() });
  ki._setSpawn(spawn);
  const r = await ki.fetchKiQuote('000660', { cfg: RT });
  assert.equal(r.schema, 'ki.quote/1');
  const args = spawn.calls[0].args;
  assert.ok(args.includes('quote'), `실제 인자: ${args.join(' ')}`);
  assert.ok(args.includes('000660'));
  assert.ok(!args.includes('--no-orderbook'), '기본은 호가까지 받는다');
  reset();
});

test('호가를 끄면 --no-orderbook 을 넘긴다 (호출 절반)', async () => {
  reset();
  const spawn = spyingSpawn({ stdout: quoteJson() });
  ki._setSpawn(spawn);
  await ki.fetchKiQuote('000660', { cfg: { ...RT, realtimeOrderbook: false } });
  assert.ok(spawn.calls[0].args.includes('--no-orderbook'));
  reset();
});

test('실시간 캐시는 facts 캐시와 섞이지 않는다', async () => {
  reset();
  const spawn = spyingSpawn((bin, args) => ({
    stdout: args.includes('quote') ? quoteJson() : factsJson(),
  }));
  ki._setSpawn(spawn);
  const f = await ki.fetchKiFacts('000660', { cfg: RT });
  const q = await ki.fetchKiQuote('000660', { cfg: RT });
  assert.equal(f.schema, 'ki.facts/1');
  assert.equal(q.schema, 'ki.quote/1');
  reset();
});

test('실패한 조회는 null 이고 원장 경로를 막지 않는다', async () => {
  reset();
  ki._setSpawn(
    spyingSpawn({
      stdout: JSON.stringify({
        ok: false, schema: 'ki.quote/1', code: '000660',
        reason: 'KIS_APP_KEY 가 .env 에 없습니다.',
      }),
    })
  );
  assert.equal(await ki.fetchKiQuote('000660', { cfg: RT }), null);
  reset();
});

// ------------------------------------------------------------------ 시세 줄

test('실시간 시세 줄은 실시간임을 밝힌다', () => {
  const line = ki.formatKiQuoteLine(JSON.parse(quoteJson()), 'SK하이닉스');
  assert.ok(line.includes('SK하이닉스'));
  assert.ok(line.includes('₩186,200'));
  assert.ok(line.includes('+0.65%'));
  assert.ok(line.includes('장중 실시간'));
  assert.ok(line.includes('원장의 일별 종가가 아니라'), '성격을 밝혀야 한다');
});

test('장 마감 후에는 마감했다고 적는다', () => {
  const line = ki.formatKiQuoteLine(JSON.parse(quoteJson({ market_open: false })), 'X');
  assert.ok(line.includes('장 마감 후'));
  assert.ok(!line.includes('장중 실시간'));
});

test('실시간이 없으면 시세 줄을 만들지 않는다 (원장으로 폴백)', () => {
  assert.equal(ki.formatKiQuoteLine(null, 'X'), null);
  assert.equal(ki.formatKiQuoteLine({ ok: false }, 'X'), null);
  assert.equal(ki.formatKiQuoteLine(JSON.parse(quoteJson({ quote: null })), 'X'), null);
});

// -------------------------------------------------------------- 미시구조 블록

test('호가 블록은 잔량·스프레드·불균형을 함께 낸다', () => {
  const out = ki.formatKiMicroLines(JSON.parse(quoteJson())).join('\n');
  assert.ok(out.startsWith('[실시간 호가'));
  assert.ok(out.includes('매수 186,100원 / 매도 186,300원'));
  assert.ok(out.includes('1,200주'));
  assert.ok(out.includes('10.7bp'));
  assert.ok(out.includes('+20.0%'));
  assert.ok(out.includes('1호가만 본 값'), '한계를 밝혀야 한다');
});

test('호가가 없으면 블록 자체를 만들지 않는다', () => {
  const p = JSON.parse(quoteJson());
  p.quote.bid = null;
  p.quote.ask = null;
  assert.deepEqual(ki.formatKiMicroLines(p), []);
  assert.deepEqual(ki.formatKiMicroLines(null), []);
});

test('장이 닫혀 있으면 마지막 호가라고 적는다', () => {
  const out = ki.formatKiMicroLines(JSON.parse(quoteJson({ market_open: false }))).join('\n');
  assert.ok(out.includes('마지막 호가'));
  assert.ok(out.includes('체결된다는 뜻이 아니다'));
});

// ---------------------------------------------------------------------------
// 거시 재료 (ki.macro/1) — 종목 코드가 없는 유일한 조회
// ---------------------------------------------------------------------------

function macroJson(over = {}) {
  return JSON.stringify({
    ok: true,
    schema: 'ki.macro/1',
    source: '한국은행 경제통계시스템(ECOS) — 100대 통계지표',
    n: 2,
    stats: [
      { group: '통화/금리', name: '한국은행 기준금리', value: 2.5, unit: '연%', as_of: '202608' },
      { group: '국제수지/환율', name: '원/달러 환율', value: 1382.5, unit: '원', as_of: '20260904' },
    ],
    ...over,
  });
}

test('거시는 꺼져 있으면 파이썬을 스폰하지 않는다 (옵트인)', async () => {
  reset();
  const spawn = spyingSpawn({ stdout: macroJson() });
  ki._setSpawn(spawn);
  assert.equal(await ki.fetchKiMacro({ cfg: ON }), null, 'ki.macro 없이 돌면 안 된다');
  assert.equal(spawn.calls.length, 0);
  reset();
});

test('거시 기본값은 꺼짐이다', () => {
  assert.equal(ki.DEFAULT_KI.macro, false);
  assert.equal(DEFAULTS.ki.macro, false);
});

test('거시는 종목 코드 없이 macro 서브커맨드를 쓴다', async () => {
  reset();
  const spawn = spyingSpawn({ stdout: macroJson() });
  ki._setSpawn(spawn);
  const r = await ki.fetchKiMacro({ cfg: { ...ON, macro: true, macroCount: 60 } });
  assert.equal(r.schema, 'ki.macro/1');
  const args = spawn.calls[0].args;
  assert.ok(args.includes('macro'));
  assert.ok(args.includes('--limit') && args.includes('60'));
  assert.ok(!args.includes('--code'), '매크로는 종목에 딸린 값이 아니다');
  reset();
});

test('거시는 런당 한 번만 조회한다', async () => {
  reset();
  const spawn = spyingSpawn({ stdout: macroJson() });
  ki._setSpawn(spawn);
  const cfg = { ...ON, macro: true };
  await ki.fetchKiMacro({ cfg });
  await ki.fetchKiMacro({ cfg });
  await ki.fetchKiMacro({ cfg });
  assert.equal(spawn.calls.length, 1, '캐시가 안 먹었다');
  reset();
});

test('거시 조회가 실패하면 null — 분석을 막지 않는다', async () => {
  reset();
  ki._setSpawn(
    spyingSpawn({
      stdout: JSON.stringify({ ok: false, schema: 'ki.macro/1', reason: 'ECOS_API_KEY 없음' }),
    })
  );
  assert.equal(await ki.fetchKiMacro({ cfg: { ...ON, macro: true } }), null);
  reset();
});

test('거시 블록은 한국은행 표기를 그대로 보존한다', () => {
  const out = ki.formatKiMacroLines(JSON.parse(macroJson())).join('\n');
  assert.ok(out.startsWith('[거시 지표 — 한국은행'));
  assert.ok(out.includes('한국은행 기준금리 2.5 연% (기준 202608)'));
  assert.ok(out.includes('1,382.5 원'), '천 단위 구분이 있어야 읽힌다');
  assert.ok(out.includes('1차 출처'));
});

test('거시 블록은 통계표가 되지 않게 잘라 낸다', () => {
  const many = { ok: true, schema: 'ki.macro/1', stats: [] };
  for (let i = 0; i < 40; i += 1) {
    many.stats.push({ group: '기타', name: `통계${i}`, value: i, unit: '', as_of: '202608' });
  }
  const out = ki.formatKiMacroLines(many, { limit: 12 });
  // 헤더 1 + 12줄 + "그 밖에 N개" + 마지막 안내 = 15
  assert.equal(out.length, 15, out.join('\n'));
  assert.ok(out.join('\n').includes('그 밖에 28개'));
});

test('거시가 없으면 블록을 만들지 않는다', () => {
  assert.deepEqual(ki.formatKiMacroLines(null), []);
  assert.deepEqual(ki.formatKiMacroLines({ ok: false }), []);
  assert.deepEqual(ki.formatKiMacroLines({ ok: true, stats: [] }), []);
});

// ---------------------------------------------------------------------------
// 토론 턴 수 — 속도와 깊이 사이의 유일한 손잡이
//
// 이 4턴이 한 종목 대기 시간의 절반 이상이다. 순차일 수밖에 없기 때문이다.
// 열어 두되 기본은 바꾸지 않는다 — 속도를 위해 판정 깊이를 말없이 깎지 않는다.
// ---------------------------------------------------------------------------

const engine = require('../server/engine.js');

test('설정이 없으면 논문 구조 그대로 4턴이다', () => {
  assert.deepEqual(engine.debatePlan(undefined), engine.DEBATE_ORDER);
  assert.deepEqual(engine.debatePlan(null), engine.DEBATE_ORDER);
  assert.deepEqual(engine.debatePlan(4), ['bull', 'bear', 'bull', 'bear']);
  assert.equal(DEFAULTS.debateTurns, 4, '기본값이 바뀌면 판정도 바뀐다');
});

test('턴 수는 짝수로 맞춘다 — 홀수면 반박 없이 끝난다', () => {
  assert.deepEqual(engine.debatePlan(3), ['bull', 'bear']);
  assert.deepEqual(engine.debatePlan(5), ['bull', 'bear', 'bull', 'bear']);
});

test('BULL 이 먼저, BEAR 가 받는다', () => {
  for (const n of [2, 4, 6, 8]) {
    const p = engine.debatePlan(n);
    assert.equal(p.length, n);
    assert.equal(p[0], 'bull');
    assert.equal(p[p.length - 1], 'bear', '마지막은 반박이어야 한다');
  }
});

test('말이 안 되는 값은 기본으로 돌린다', () => {
  for (const bad of ['x', -1, 0, 1, NaN, {}, []]) {
    assert.deepEqual(engine.debatePlan(bad), engine.DEBATE_ORDER, `${JSON.stringify(bad)}`);
  }
});

test('너무 큰 값은 8턴에서 자른다', () => {
  assert.equal(engine.debatePlan(99).length, 8);
});
