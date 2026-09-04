// Network smoke test for server/market.js.
// Run directly:  node test/market.smoke.mjs
// (This is NOT a node:test file — it hits live public APIs and prints results.)

import { createRequire } from 'module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const { resolveSymbol, fetchMarket, fetchTape } = require('../server/market.js');

const __dirname = dirname(fileURLToPath(import.meta.url));

let failed = 0;
function check(label, cond) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'} — ${label}`);
  if (!cond) failed++;
}

async function smoke(input) {
  console.log(`\n=== ${input} ===`);
  const resolved = resolveSymbol(input);
  console.log('resolveSymbol:', JSON.stringify(resolved));
  const m = await fetchMarket(resolved);
  console.log('priceLine     :', m.priceLine);
  console.log('candles.length:', m.candles.length);
  console.log('first candle  :', JSON.stringify(m.candles[0]));
  console.log('last candle   :', JSON.stringify(m.candles[m.candles.length - 1]));
  console.log('indicators.price:', m.indicators.price);
  console.log('indicators.summaryLines:');
  for (const l of m.indicators.summaryLines) console.log('   -', l);
  console.log('fundamentals.lines:');
  for (const l of m.fundamentals.lines) console.log('   -', l);
  console.log('sentiment.lines:');
  for (const l of m.sentiment.lines) console.log('   -', l);
  console.log('intraday.summaryLines:');
  for (const l of (m.intraday && m.intraday.summaryLines) || []) {
    console.log('   -', l);
  }
  console.log(
    'intraday.candles15m.length:',
    (m.intraday && m.intraday.candles15m ? m.intraday.candles15m.length : 0)
  );
  console.log('news.headlines (top 3):');
  for (const h of m.news.headlines.slice(0, 3)) {
    console.log(`   - [${h.age}] ${h.title}`);
  }

  check(`${input}: candles.length > 50`, m.candles.length > 50);
  check(`${input}: indicators.price > 0`, m.indicators.price > 0);
  check(
    `${input}: priceLine is a non-empty string`,
    typeof m.priceLine === 'string' && m.priceLine.length > 0
  );
  return m;
}

(async () => {
  await smoke('BTC');
  await smoke('AAPL');

  const kr = await smoke('SKHYNIX');
  check(
    'SKHYNIX: priceLine contains ₩ (KRW)',
    typeof kr.priceLine === 'string' && kr.priceLine.includes('₩')
  );
  check('SKHYNIX: kind is krstock', kr.kind === 'krstock');
  check(
    'SKHYNIX: intraday.summaryLines present',
    !!kr.intraday &&
      Array.isArray(kr.intraday.summaryLines) &&
      kr.intraday.summaryLines.length > 0
  );

  console.log('\n=== SESSION-PREP (SAMSUNG) ===');
  const prepPath = join(__dirname, '..', 'server', 'session-prep.js');
  let stdout = '';
  let prep = null;
  let parsed = false;
  try {
    stdout = execFileSync(process.execPath, [prepPath, 'SAMSUNG'], {
      encoding: 'utf8',
      timeout: 60000,
    });
    prep = JSON.parse(stdout);
    parsed = true;
  } catch (e) {
    console.error('session-prep error:', e && e.message ? e.message : e);
  }
  check('session-prep SAMSUNG: stdout is valid JSON', parsed);
  check(
    'session-prep SAMSUNG: dailyCloses.length === 30',
    parsed && Array.isArray(prep.dailyCloses) && prep.dailyCloses.length === 30
  );
  if (parsed) {
    console.log('session-prep keys :', Object.keys(prep).join(', '));
    console.log('session-prep bytes:', Buffer.byteLength(stdout, 'utf8'));
    console.log('session-prep priceLine:', prep.priceLine);
  }

  console.log('\n=== TAPE ===');
  const tape = await fetchTape();
  for (const t of tape) {
    console.log(
      `  ${t.sym.padEnd(5)} $${t.price}  ${t.changePct >= 0 ? '+' : ''}${t.changePct.toFixed(2)}%`
    );
  }
  check('tape returned at least one row', tape.length > 0);

  console.log(`\n${failed === 0 ? 'SMOKE OK — all checks passed' : `SMOKE FAILED — ${failed} check(s) failed`}`);
  process.exitCode = failed === 0 ? 0 : 1;
})().catch((e) => {
  console.error('\nSMOKE ERROR:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
