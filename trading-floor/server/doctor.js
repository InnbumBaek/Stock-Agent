'use strict';

// PIXEL TRADING FLOOR — 진단 도구
// 실전 분석이 "파싱 실패"로 떨어질 때 원인을 한 번에 찾아준다.
// 실행: node server/doctor.js   (또는 doctor.cmd 더블클릭)

const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const HOME = os.homedir();
const line = (s = '') => console.log(s);
const ok = (s) => console.log('  [정상] ' + s);
const bad = (s) => console.log('  [문제] ' + s);
const info = (s) => console.log('         ' + s);

// cmd 한 줄 실행 → {code, stdout, stderr, timedOut}
function run(cmd, { cwd = HOME, input = null, timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, { shell: true, cwd });
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(r);
    };
    const t = setTimeout(() => {
      try { child.kill(); } catch { /* 무시 */ }
      finish({ code: null, stdout, stderr, timedOut: true });
    }, timeout);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => {
      stderr += `[spawn error] ${e.message}`;
      finish({ code: null, stdout, stderr, timedOut: false });
    });
    child.on('close', (code) => finish({ code, stdout, stderr, timedOut: false }));
    if (input != null) {
      try {
        child.stdin.write(input);
        child.stdin.end();
      } catch (e) {
        stderr += `[stdin error] ${e.message}`;
      }
    }
  });
}

(async () => {
  line('====================================');
  line('  PIXEL TRADING FLOOR — 진단');
  line('====================================');
  line(`OS: ${os.platform()} ${os.release()} · Node ${process.version}`);
  line(`홈 디렉터리: ${HOME}`);
  line(`프로젝트: ${path.join(__dirname, '..')}`);
  line();

  let problems = 0;

  // 1) API 키 환경변수 (구독 대신 과금되는 함정)
  line('[1] 환경변수 점검');
  if (process.env.ANTHROPIC_API_KEY) {
    bad('ANTHROPIC_API_KEY 가 설정돼 있습니다.');
    info('비대화형(-p) 호출은 이 키로 과금됩니다. 구독을 쓰려면 해제하세요:');
    info('  PowerShell: [Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", $null, "User")');
    problems += 1;
  } else {
    ok('ANTHROPIC_API_KEY 없음 (구독으로 동작)');
  }
  line();

  // 2) claude 실행 파일 — PATH 우선, 없으면 표준 설치 경로 (앱과 동일한 방식)
  line('[2] claude 설치 확인');
  const { resolveClaudeBin } = require('./agents');
  const bare = await run('claude --version', { timeout: 20000 });
  let claudeCmd = 'claude';
  if (bare.code === 0 && /\d+\.\d+/.test(bare.stdout)) {
    ok(`PATH에서 실행 가능: claude ${bare.stdout.trim()}`);
  } else {
    const resolved = resolveClaudeBin();
    if (resolved && resolved !== 'claude') {
      const viaPath = await run(`${resolved} --version`, { timeout: 20000 });
      if (viaPath.code === 0 && /\d+\.\d+/.test(viaPath.stdout)) {
        claudeCmd = resolved;
        ok(`claude ${viaPath.stdout.trim()} — 설치 경로로 실행됨`);
        info(`경로: ${resolved}`);
        info('PATH에는 없지만 앱은 이 경로를 직접 찾아 쓰므로 정상 동작합니다.');
        info('터미널에서 `claude`를 바로 쓰려면 PC를 재부팅하면 PATH가 갱신됩니다.');
      } else {
        bad('설치 파일은 있으나 실행에 실패했습니다.');
        info(`경로: ${resolved}`);
        info(`종료코드: ${viaPath.code}${viaPath.timedOut ? ' (타임아웃)' : ''}`);
        if (viaPath.stderr.trim()) info(`stderr: ${viaPath.stderr.trim().slice(0, 300)}`);
        problems += 1;
        line();
        line('claude 실행에 실패해 이후 검사를 건너뜁니다.');
        process.exit(1);
      }
    } else {
      bad('claude 를 찾을 수 없습니다.');
      info(`종료코드: ${bare.code}${bare.timedOut ? ' (타임아웃)' : ''}`);
      if (bare.stderr.trim()) info(`stderr: ${bare.stderr.trim().slice(0, 300)}`);
      info('→ Claude Code 를 설치한 뒤 이 창을 닫고 새로 여세요.');
      problems += 1;
      line();
      line('claude 자체를 못 찾아 이후 검사를 건너뜁니다.');
      process.exit(1);
    }
  }
  line();

  // 3) 홈 디렉터리에서 비대화형 호출 (앱이 실제로 쓰는 방식)
  line('[3] 비대화형 호출 (앱과 동일한 방식, 홈 디렉터리)');
  const t0 = Date.now();
  const r1 = await run(`${claudeCmd} -p --model opus`, {
    cwd: HOME,
    input: '아래 JSON 하나만 출력하라. 다른 문장 금지: {"ok":true}',
    timeout: 180000,
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (r1.stdout.includes('"ok"')) {
    ok(`정상 응답 (${secs}초)`);
  } else {
    bad(`JSON 응답을 받지 못했습니다 (${secs}초)`);
    info(`종료코드: ${r1.code}${r1.timedOut ? ' (180초 타임아웃)' : ''}`);
    info(`stdout(${r1.stdout.length}자): ${r1.stdout.trim().slice(0, 400) || '(비어 있음)'}`);
    info(`stderr(${r1.stderr.length}자): ${r1.stderr.trim().slice(0, 400) || '(비어 있음)'}`);
    if (!r1.stdout.trim() && !r1.stderr.trim()) {
      info('→ 출력이 완전히 비었습니다. 로그인 또는 폴더 신뢰 대기 상태일 가능성이 큽니다.');
      info('→ 터미널에서 `claude` 를 직접 실행해 로그인·신뢰 프롬프트를 처리한 뒤 다시 시도하세요.');
    }
    problems += 1;
  }
  line();

  // 4) 프로젝트 폴더에서 호출 (신뢰 게이트 비교용)
  line('[4] 프로젝트 폴더에서 호출 (신뢰 게이트 비교)');
  const proj = path.join(__dirname, '..');
  const r2 = await run(`${claudeCmd} -p --model opus`, {
    cwd: proj,
    input: '아래 JSON 하나만 출력하라. 다른 문장 금지: {"ok":true}',
    timeout: 120000,
  });
  if (r2.stdout.includes('"ok"')) {
    ok('프로젝트 폴더에서도 정상 (신뢰 문제 없음)');
  } else {
    bad('프로젝트 폴더에서는 실패합니다 → 폴더 신뢰 게이트에 걸린 것으로 보입니다.');
    info('앱은 홈 디렉터리에서 실행하도록 고쳐졌으니, [3]이 정상이면 앱은 동작합니다.');
    info(`stdout: ${r2.stdout.trim().slice(0, 200) || '(비어 있음)'}`);
  }
  line();

  // 5) 앱 코드 경로 그대로 (실제 에이전트 1명)
  line('[5] 앱 코드로 에이전트 1명 실행 (TARO)');
  try {
    const { resolveSymbol, fetchMarket } = require('./market');
    const { runAgent } = require('./agents');
    const resolved = resolveSymbol('BTC');
    const market = await fetchMarket(resolved);
    ok(`시장 데이터 수집 성공: ${market.priceLine || 'BTC'}`);
    const t1 = Date.now();
    const res = await runAgent('taro', { market, mode: 'scalp' }, { mock: false });
    const s2 = ((Date.now() - t1) / 1000).toFixed(1);
    if (String(res.bubble).includes('분석 실패')) {
      bad(`에이전트 실패 (${s2}초)`);
      info(String(res.report).split('\n').slice(0, 8).join('\n         '));
      problems += 1;
    } else {
      ok(`에이전트 정상 (${s2}초, 브리핑 ${String(res.report).length}자)`);
      info(String(res.bubble).slice(0, 80));
    }
  } catch (e) {
    bad('앱 코드 실행 중 오류: ' + (e && e.message ? e.message : String(e)));
    problems += 1;
  }
  line();

  line('====================================');
  if (problems === 0) {
    line('  결과: 문제 없음 — 실전 분석이 동작해야 합니다.');
    line('  그래도 실패한다면 서버를 껐다 켜고 다시 시도하세요.');
  } else {
    line(`  결과: 문제 ${problems}건 발견 — 위 [문제] 항목을 확인하세요.`);
  }
  line('====================================');
})();
