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
