#!/usr/bin/env node
'use strict';
/**
 * 논문 문헌 심사 — 연도별로 훑어 온 후보를 퀀트 데스크가 읽고 채택을 제안한다.
 *
 *   node server/paper-scan.js --years 2013-2026            무엇을 할지만 보여준다
 *   node server/paper-scan.js --years 2024-2026 --run      실제로 심사한다
 *   node server/paper-scan.js --years 2025-2025 --run --demo   목업 (무료·배선 확인)
 *
 * 후보는 `stock-monitor/.papers_candidates.json` 에 있고, 그것을 채우는 것은
 * `python docs/fetch_papers.py --harvest 2013-2026` 이다. 이 명령은 그 다음
 * 단계다 — 훑어 온 것을 읽고 **이 데스크에 쓸모가 있는지** 가린다.
 *
 * 지키는 것 세 가지.
 *
 *  1. **--run 없이는 claude 를 부르지 않는다.** 연도 하나가 곧 호출 하나다.
 *  2. **결과가 저장소를 고치지 않는다.** 제안서를 docs/proposals/ 에 쓸 뿐,
 *     .papers.json 이나 팩터 코드는 건드리지 않는다. 검산되지 않은 계산이
 *     회의 자료에 조용히 실리는 것이 이 프로젝트가 막으려는 실패다.
 *  3. **stdout 은 사람용이고 결과는 파일이다.** (facts 와 방향이 반대다)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CANDIDATES = path.join(ROOT, '..', 'stock-monitor', '.papers_candidates.json');
const ADOPTED = path.join(ROOT, '..', 'stock-monitor', '.papers.json');
const OUT_DIR = path.join(ROOT, '..', 'docs', 'proposals');
const PLUGIN_DIR = path.join(ROOT, '..', 'stock-monitor', 'factors_proposed');

/**
 * 리포트에서 ```factor:<키> … ``` 블록을 꺼낸다.
 *
 * 키는 파일 이름이 되므로 좁게 받는다 — 경로 탈출(../)이나 이상한 문자가
 * 파일 이름에 들어가면 그 자체가 구멍이다.
 */
function extractFactors(report) {
  const out = [];
  const re = /```factor:([a-z][a-z0-9_]{1,40})\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(String(report || '')))) {
    const key = m[1];
    const src = m[2];
    // META 한 줄이 없으면 관문에서 어차피 막힌다. 여기서 먼저 거른다.
    if (!/^#\s*META:\s*\{/m.test(src)) continue;
    if (!/^def compute\(df, mkt, list_date, win\):/m.test(src)) continue;
    out.push({ key, src });
  }
  return out;
}

function say(s) {
  process.stdout.write(String(s) + '\n');
}

function parseArgs(argv) {
  const out = { years: null, run: false, demo: false, out: OUT_DIR, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--years') out.years = argv[++i];
    else if (a === '--run') out.run = true;
    else if (a === '--demo') out.demo = true;
    else if (a === '--out') out.out = argv[++i];
    else if (a === '-h' || a === '--help') out.help = true;
  }
  return out;
}

const HELP = `
논문 문헌 심사 — 연도별 후보를 퀀트 데스크가 읽고 채택을 제안합니다.

  --years 2013-2026   심사할 연도 구간 (필수)
  --run               실제로 심사합니다 (연도당 claude 호출 1회)
  --demo              --run 과 함께 — claude 없이 목업으로 (배선 확인용)
  --out <경로>        제안서를 쓸 폴더 (기본 docs/proposals)

먼저 후보를 채워야 합니다:
  python docs/fetch_papers.py --harvest 2013-2026

제안서는 사람이 읽고 채택합니다. 이 명령은 .papers.json 을 고치지 않습니다.
`.trim();

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function yearRange(spec) {
  const m = /^(\d{4})-(\d{4})$/.exec(String(spec || '').trim());
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a > b) return null;
  const out = [];
  for (let y = a; y <= b; y += 1) out.push(y);
  return out;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help || !args.years) {
    say(HELP);
    return args.help ? 0 : 2;
  }
  const years = yearRange(args.years);
  if (!years) {
    say('--years 는 2013-2026 처럼 씁니다.');
    return 2;
  }

  const cand = readJson(CANDIDATES, null);
  if (!cand || !cand.by_year) {
    say('후보 파일이 없습니다: stock-monitor/.papers_candidates.json');
    say('먼저 훑어 오십시오:  python docs/fetch_papers.py --harvest ' + args.years);
    return 1;
  }
  const adoptedDoc = readJson(ADOPTED, { papers: {} });
  const adopted = Object.values(adoptedDoc.papers || {});

  const plan = years
    .map((y) => ({ year: y, papers: cand.by_year[String(y)] || [] }))
    .filter((x) => x.papers.length);

  if (!plan.length) {
    say(`${args.years} 구간에 후보가 없습니다. --harvest 를 먼저 돌리십시오.`);
    return 1;
  }

  say('');
  say('  논문 문헌 심사');
  say('  ' + '='.repeat(46));
  for (const p of plan) say(`   ${p.year}   후보 ${p.papers.length}편`);
  say(`   채택본 ${adopted.length}편 (중복 제안 방지용으로 함께 넘깁니다)`);
  say('');

  if (!args.run) {
    say('  --run 이 없어 심사를 실행하지 않았습니다.');
    say(`  실제로 돌리려면:  node server/paper-scan.js --years ${args.years} --run`);
    say('  (연도당 claude 호출 1회입니다. --demo 를 붙이면 무료로 배선만 봅니다.)');
    return 0;
  }

  const { runAgent } = require('./agents');
  fs.mkdirSync(args.out, { recursive: true });
  const results = [];
  for (const p of plan) {
    say(`  ${p.year} 심사 중… (후보 ${p.papers.length}편)`);
    let report;
    try {
      const res = await runAgent(
        'quant',
        { paperScan: { year: p.year, papers: p.papers, adopted } },
        { mock: args.demo }
      );
      report = res.report;
    } catch (e) {
      // 한 해가 실패해도 나머지는 계속 간다. 부분 결과가 없는 것보다 낫다.
      say(`     [알림] ${p.year} 실패: ${e && e.message ? e.message : e}`);
      continue;
    }
    // 에이전트가 쓴 구현을 꺼내 관문 앞에 놓는다. 통과 여부는 파이썬이 정한다 —
    // 여기서 통과시키면 관문을 우회하는 셈이 된다.
    const impls = extractFactors(report);
    const wrote = [];
    for (const f of impls) {
      fs.mkdirSync(PLUGIN_DIR, { recursive: true });
      const dst = path.join(PLUGIN_DIR, `${f.key}.py`);
      fs.writeFileSync(dst, f.src, 'utf8');
      wrote.push(f.key);
      say(`     구현 ${f.key} → stock-monitor/factors_proposed/${f.key}.py`);
    }
    if (wrote.length) {
      say('     (관문 통과 여부는 python ki_monitor.py factors <코드> 가 정합니다)');
    }
    results.push({ year: p.year, n: p.papers.length, implemented: wrote, report });
    const md = [
      `# ${p.year}년 논문 심사`,
      '',
      '> 퀀트 데스크(QUANT)가 연도별 후보를 읽고 낸 **제안**입니다.',
      '> 채택은 사람이 합니다 — 이 문서는 `.papers.json` 을 고치지 않습니다.',
      '',
      `후보 ${p.papers.length}편 · 심사 시각 ${new Date().toISOString().slice(0, 19)}`,
      '',
      '---',
      '',
      report,
      '',
      '---',
      '',
      '## 채택하려면',
      '',
      '1. 원문을 확인하십시오. 위 판정은 제목·게재지만 보고 낸 것입니다.',
      '2. `stock-monitor/.papers.json` 에 옮기고 `question`(q1~q4)·`claim`·`limits` 를 적으십시오.',
      '3. 팩터를 구현했다면 `ki_monitor.py` 의 `FACTOR_DEFS` 에 논문 키를 달고,',
      '   손으로 낼 수 있는 값으로 `selftest` 검산을 추가하십시오.',
      '',
      wrote.length
        ? `\n**구현 초안 ${wrote.length}건**: ${wrote.map((k) => '`' + k + '.py`').join(', ')}`
          + ' — `stock-monitor/factors_proposed/` 에 놓였습니다. 정적·연기·검산·인용'
          + ' 네 관문을 통과해야만 팩터 출력에 실리고, 실려도 "채택하기 전" 딱지가'
          + ' 붙어 채택본과 섞이지 않습니다.'
        : '\n구현 초안은 없습니다 (채택제안이 없었거나 형식이 맞지 않았습니다).',
      '',
      `_후보 원본: stock-monitor/.papers_candidates.json (by_year.${p.year})_`,
    ].join('\n');
    const f = path.join(args.out, `${p.year}-논문심사.md`);
    fs.writeFileSync(f, md, 'utf8');
    say(`     → ${path.relative(process.cwd(), f)}`);
  }

  const jf = path.join(args.out, 'paper-scan.json');
  fs.writeFileSync(jf, JSON.stringify({
    schema: 'quant.paperscan/1',
    scanned_at: new Date().toISOString(),
    years: args.years,
    demo: !!args.demo,
    note: '제안입니다. 채택은 사람이 하며 이 파일은 인용되지 않습니다.',
    results,
  }, null, 2), 'utf8');
  say('');
  say(`  끝났습니다. 제안서 ${results.length}건 · 요약 ${path.relative(process.cwd(), jf)}`);
  say('  채택은 사람이 합니다. .papers.json 은 그대로입니다.');
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => {
    process.stderr.write(String((e && e.stack) || e) + '\n');
    process.exit(1);
  });
}

module.exports = { parseArgs, yearRange, extractFactors, main };
