'use strict';

// PIXEL TRADING FLOOR — 저장 리포트 재생
//
// reports/*.md 에 저장된 분석 리포트를 파싱해 **원래 방송됐던 SSE 이벤트 시퀀스**로
// 복원하고, 배속을 걸어 순차 방출한다. 화면은 실제 런과 똑같이 흘러간다.
//
// 파싱 기준은 engine.js 의 _renderMarkdown 출력이다. 섹션 구조:
//   # PIXEL TRADING FLOOR 분석 리포트
//   - 심볼: <display> (<symbol>, <kind>) / - 시각 / - 모드 / - 시세 / - 시세(체결 기준)
//   ## 멀티 거래소 전광판        (선택)
//   ## 애널리스트 리포트          ### TARO (기술적 분석) → "> 말풍선" → 본문
//   ## 리서치 토론 (BULL vs BEAR) ### 턴 1 — BULL (매수 논거)
//   ## 스캘핑 데스크 (20x)        ### BLITZ (스캘퍼)
//   ## 리스크 위원회              ### RISKY (공격적 리스크)
//   ## 포트폴리오 매니저 승인      - 판정/권장 비중/근거 → "> 말풍선" → 본문
//   ## 과거 판정 회고             - 한 줄씩
//   ## 최종 판정 (ACE[ → PM 승인]) - 액션/확신도/진입/손절/목표/근거
//                                 ### 스캘핑 판정 (탭비트 20x) - 편향/…
//                                 <ACE 본문>
//   ---
//
// 원칙: **어떤 입력에도 throw 하지 않는다.** 실패하면 빈 이벤트 배열과 한국어 사유를 돌려준다.
// 리포트에 없는 값(과거 캔들, ACE 말풍선 원문 등)은 지어내지 않는다.
//
// 외부 의존성 0 (Node 내장만).

const fsp = require('fs').promises;

// 이벤트 사이 기본 간격 (speed 1 기준). speed 2면 200ms.
const DEFAULT_DELAY_MS = 400;

// 에이전트 이름은 전부 id의 대문자형이다 (TARO→taro, PM→pm).
// agents.js 를 읽을 수 있으면 거기서 보강하고, 못 읽어도 내장 목록으로 동작한다.
const FALLBACK_AGENT_IDS = [
  'taro', 'diana', 'nova', 'vibe',
  'bull', 'bear',
  'blitz', 'guard',
  'risky', 'safe', 'neutral',
  'ace', 'pm',
];
const KNOWN_AGENT_IDS = (() => {
  const set = new Set(FALLBACK_AGENT_IDS);
  try {
    const mod = require('./agents');
    const raw = mod && mod.AGENTS;
    const list = Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object'
      ? Object.keys(raw).map((k) => raw[k])
      : [];
    for (const a of list) {
      if (a && a.id) set.add(String(a.id).toLowerCase());
    }
  } catch (_) {
    // agents.js 로드 실패는 무시 — 내장 목록으로 충분하다.
  }
  return set;
})();

// 섹션 제목 → 내부 키. 접두사로 판정해 뒤에 붙는 괄호/부제 변화에 견딘다.
const SECTION_KEYS = [
  ['멀티 거래소 전광판', 'board'],
  ['애널리스트 리포트', 'analysts'],
  ['리서치 토론', 'debate'],
  ['스캘핑 데스크', 'scalpdesk'],
  ['리스크 위원회', 'risk'],
  ['리스크 게이트', 'riskgate'],
  ['포트폴리오 매니저 승인', 'pm'],
  ['과거 판정 회고', 'memory'],
  ['최종 판정', 'decision'],
];

// `- 키: 값` 한 줄.
// 키 안에 콜론이 있을 수 있어서(`- 손익비(R:R): 2.10`) **콜론+공백**을 구분자로 삼고
// 키는 최소 매칭한다. 값이 없는 `- 사유:` 형태도 받는다.
const BULLET_RE = /^-\s+(.+?):(?:\s+(.*))?$/;
// 리스크 게이트 사유의 들여쓴 하위 항목 `  - 사유 문장`
const SUB_BULLET_RE = /^\s+-\s+(.*)$/;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sectionKey(title) {
  const t = String(title || '').trim();
  for (const [prefix, key] of SECTION_KEYS) {
    if (t.startsWith(prefix)) return key;
  }
  return null;
}

// 값에서 마크다운 굵게 표시를 걷어낸다. `**HOLD**` → `HOLD`
function cleanValue(v) {
  return String(v == null ? '' : v).replace(/\*\*/g, '').trim();
}

function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const m = v.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    if (m) {
      const n = Number(m[0]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

// 첫 문장만 잘라낸다 (ACE 말풍선 복원용 — 원문 말풍선은 리포트에 저장되지 않는다)
function firstSentence(text, max) {
  const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const idx = t.search(/[.!?](\s|$)/);
  let s = idx >= 0 ? t.slice(0, idx + 1) : t;
  if (s.length > max) s = s.slice(0, Math.max(1, max - 1)).trim() + '…';
  return s;
}

// `### TARO (기술적 분석)` / `### 턴 1 — BULL (매수 논거)` → { id, name, role, turn }
// 에이전트 제목이 아니면(예: `### 스캘핑 판정 (탭비트 20x)`) null
function parseAgentHeading(raw) {
  let text = String(raw || '').trim();
  let turn = null;
  const t = /^턴\s*(\d+)\s*[—–\-]\s*(.+)$/.exec(text);
  if (t) {
    turn = Number(t[1]);
    text = t[2].trim();
  }
  const m = /^([A-Za-z][A-Za-z0-9_]*)\s*(?:\(([^)]*)\))?\s*$/.exec(text);
  if (!m) return null;
  const id = m[1].toLowerCase();
  if (!KNOWN_AGENT_IDS.has(id)) return null;
  return { id, name: text, role: m[2] ? m[2].trim() : '', turn };
}

// `## …` 기준으로 헤더/섹션 분리. `###` 는 섹션 내부에 남는다.
function splitSections(lines) {
  const header = [];
  const sections = [];
  let cur = null;
  for (const line of lines) {
    const m = /^##\s+(.*)$/.exec(line);
    if (m) {
      cur = { title: m[1].trim(), key: sectionKey(m[1]), lines: [] };
      sections.push(cur);
      continue;
    }
    if (cur) cur.lines.push(line);
    else header.push(line);
  }
  return { header, sections };
}

// `### …` 로 나뉜 에이전트 블록들 → [{ id, turn, bubble, report }]
function parseAgentBlocks(lines) {
  const blocks = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    blocks.push({
      id: cur.id,
      name: cur.name,
      role: cur.role,
      turn: cur.turn,
      bubble: cur.bubbleLines.join(' ').trim(),
      report: cur.bodyLines.join('\n').trim(),
    });
    cur = null;
  };
  for (const line of lines) {
    const h = /^###\s+(.*)$/.exec(line);
    if (h) {
      flush();
      const parsed = parseAgentHeading(h[1]);
      if (parsed) cur = Object.assign({}, parsed, { bubbleLines: [], bodyLines: [] });
      continue;
    }
    if (!cur) continue;
    // 제목 직후의 연속된 `>` 줄만 말풍선. 본문이 시작된 뒤의 `>` 는 본문으로 본다.
    if (cur.bodyLines.length === 0 && /^>/.test(line)) {
      cur.bubbleLines.push(line.replace(/^>\s?/, ''));
      continue;
    }
    cur.bodyLines.push(line);
  }
  flush();
  return blocks;
}

function skipBlank(lines, i, end) {
  while (i < end && lines[i].trim() === '') i++;
  return i;
}

// 연속된 `- 키: 값` 블록을 읽는다. 빈 줄/제목을 만나면 끝.
// 불릿이 아닌 줄은 직전 값의 줄바꿈 연장으로 붙인다(근거가 여러 줄일 때 대비).
function readBullets(lines, i, end, out) {
  let lastKey = null;
  while (i < end) {
    const line = lines[i];
    if (line.trim() === '') break;
    if (/^#/.test(line)) break;
    const m = BULLET_RE.exec(line);
    if (m) {
      lastKey = m[1].trim();
      out[lastKey] = cleanValue(m[2]);
    } else if (lastKey) {
      out[lastKey] = (out[lastKey] + ' ' + cleanValue(line)).trim();
    } else {
      break;
    }
    i++;
  }
  return i;
}

// `## 최종 판정 …` 섹션 → { main, scalp, report }
function parseDecisionSection(lines) {
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  const main = {};
  let scalp = null;

  let i = skipBlank(lines, 0, end);
  i = readBullets(lines, i, end, main);

  let j = skipBlank(lines, i, end);
  if (j < end && /^###\s+.*스캘핑 판정/.test(lines[j])) {
    scalp = {};
    j = readBullets(lines, j + 1, end, scalp);
    i = j;
  }

  const start = skipBlank(lines, i, end);
  const report = lines.slice(start, end).join('\n').trim();
  return { main, scalp, report };
}

// `## 리스크 게이트` 섹션 → risk 이벤트 복원에 필요한 값들.
// engine.js 의 _runRiskGate 결과를 렌더한 것이라, 여기서 읽은 값 외에는 만들지 않는다.
// (sizing 은 리포트에 문자열로만 남으므로 객체가 아니라 원문 문자열로 돌려준다)
function parseRiskGateSection(lines) {
  const f = {};
  const reasons = [];
  let inReasons = false;
  for (const line of lines) {
    if (inReasons) {
      const sub = SUB_BULLET_RE.exec(line);
      if (sub) {
        reasons.push(cleanValue(sub[1]));
        continue;
      }
      if (line.trim() === '') continue;
      inReasons = false;
    }
    const m = BULLET_RE.exec(line);
    if (!m) continue;
    const key = m[1].trim();
    const val = cleanValue(m[2]);
    if (key === '사유') {
      inReasons = true;
      if (val) reasons.push(val);
      continue;
    }
    f[key] = val;
  }

  const scopeText = f['평가 대상'] || '';
  const rrText = f['손익비(R:R)'] || f['손익비'] || '';
  const liqText = f['청산가'] || '';
  const passText = f['통과 여부'] || '';
  const minRRMatch = /최소\s*기준\s*([\d.]+)/.exec(rrText);
  const sideMatch = /방향\s+(\S+)/.exec(scopeText);
  // '1,058.4 — ⚠ 손절이 …' 처럼 경고가 붙어 있으면 가격 부분만 떼어낸다
  const liqPrice = liqText.split(/\s+—\s+/)[0].trim();

  return {
    scope: scopeText.includes('스캘핑') ? 'scalp' : 'swing',
    side: sideMatch ? sideMatch[1] : '',
    rr: toNumber(rrText),
    minRR: minRRMatch ? Number(minRRMatch[1]) : null,
    liq: toNumber(liqPrice),
    liqText: liqPrice && liqPrice !== '데이터 없음' ? liqPrice : '',
    stopBeyondLiq: liqText.includes('청산이 먼저'),
    sizingText: f['권장 비중'] || '',
    ok: passText.startsWith('통과'),
    downgraded: passText.includes('판정 강등'),
    reasons,
  };
}

// `## 포트폴리오 매니저 승인` 섹션 → { fields, bubble, report, failed }
function parsePmSection(lines) {
  const fields = {};
  let i = skipBlank(lines, 0, lines.length);
  i = readBullets(lines, i, lines.length, fields);
  i = skipBlank(lines, i, lines.length);

  const bubbleLines = [];
  while (i < lines.length && /^>/.test(lines[i])) {
    bubbleLines.push(lines[i].replace(/^>\s?/, ''));
    i++;
  }
  i = skipBlank(lines, i, lines.length);
  const report = lines.slice(i).join('\n').trim();
  const verdictRaw = fields['판정'] || '';
  const failed = verdictRaw.includes('승인 절차 실패');
  return {
    fields,
    verdict: failed ? 'PM_FAILED' : verdictRaw.trim().toUpperCase(),
    sizing: fields['권장 비중'] || '',
    rationale: fields['근거'] || '',
    bubble: bubbleLines.join(' ').trim(),
    report,
    failed,
  };
}

function parseHeader(lines) {
  const meta = {
    display: null,
    symbol: null,
    kind: null,
    ts: null,
    mode: 'algo',
    mock: false,
    modeLabel: '',
    priceLine: null,
    perpPriceLine: null,
  };
  for (const line of lines) {
    const m = BULLET_RE.exec(line);
    if (!m) continue;
    const key = m[1].trim();
    const val = String(m[2] == null ? '' : m[2]).trim();
    if (key === '심볼') {
      const s = /^(.*)\s+\(([^()]*)\)\s*$/.exec(val);
      if (s) {
        meta.display = s[1].trim();
        const parts = s[2].split(',').map((x) => x.trim());
        meta.symbol = parts[0] || meta.display;
        meta.kind = parts[1] || null;
      } else {
        meta.display = val;
        meta.symbol = val;
      }
    } else if (key === '시각') {
      meta.ts = val;
    } else if (key === '모드') {
      meta.modeLabel = val;
      meta.mock = val.includes('데모');
      if (val.includes('공격')) meta.mode = 'attack';
      else if (val.includes('스캘핑')) meta.mode = 'scalp';
      else meta.mode = 'algo';
    } else if (key === '시세') {
      meta.priceLine = val;
    } else if (key === '시세(체결 기준)') {
      meta.perpPriceLine = val;
    }
  }
  return meta;
}

/**
 * 저장된 리포트 마크다운 → 원래 SSE 이벤트 시퀀스.
 *
 * 절대 throw 하지 않는다. 파싱에 실패하면 events: [] 와 한국어 reason 을 돌려준다.
 *
 * @param {string} md  리포트 .md 전체 텍스트
 * @returns {{ok:boolean, events:Array, meta:object, reason:(string|null)}}
 */
function parseReport(md) {
  const fail = (reason) => ({ ok: false, events: [], meta: {}, reason });

  try {
    if (typeof md !== 'string' || !md.trim()) {
      return fail('리포트 내용이 비어 있습니다.');
    }
    const lines = md.split(/\r?\n/);
    const looksLikeReport =
      lines.some((l) => l.startsWith('# PIXEL TRADING FLOOR')) ||
      lines.some((l) => /^##\s+최종 판정/.test(l));
    if (!looksLikeReport) {
      return fail('PIXEL TRADING FLOOR 리포트 형식이 아닙니다(제목·최종 판정 섹션 없음).');
    }

    const { header, sections } = splitSections(lines);
    const meta = parseHeader(header);
    if (!meta.display) {
      return fail('심볼 정보를 찾지 못했습니다(- 심볼: 줄 없음).');
    }

    const byKey = {};
    for (const s of sections) {
      if (!s.key) continue;
      if (!byKey[s.key]) byKey[s.key] = s;
    }
    const decSection = byKey.decision;
    if (!decSection) {
      return fail('최종 판정 섹션을 찾지 못했습니다.');
    }

    const dec = parseDecisionSection(decSection.lines);
    const action = (dec.main['액션'] || '').toUpperCase() || 'HOLD';
    const confidence = toNumber(dec.main['확신도']);

    const analysts = byKey.analysts ? parseAgentBlocks(byKey.analysts.lines) : [];
    const debate = byKey.debate ? parseAgentBlocks(byKey.debate.lines) : [];
    const scalpDesk = byKey.scalpdesk ? parseAgentBlocks(byKey.scalpdesk.lines) : [];
    const riskDesk = byKey.risk ? parseAgentBlocks(byKey.risk.lines) : [];
    const pm = byKey.pm ? parsePmSection(byKey.pm.lines) : null;
    const gate = byKey.riskgate ? parseRiskGateSection(byKey.riskgate.lines) : null;
    const memoryLines = byKey.memory
      ? byKey.memory.lines
          .map((l) => l.trim())
          .filter((l) => l.startsWith('- '))
          .map((l) => l.slice(2).trim())
      : [];
    const boardLines = byKey.board
      ? byKey.board.lines
          .map((l) => l.trim())
          .filter((l) => l.startsWith('- '))
          .map((l) => l.slice(2).trim())
      : [];

    // ---- 이벤트 시퀀스 조립 (engine.run 의 방송 순서 그대로) ----
    const events = [];
    const log = (line, kind) => {
      if (!line) return;
      events.push({ type: 'log', kind: kind || 'sys', line: String(line) });
    };

    events.push({
      type: 'run:start',
      symbol: meta.symbol || meta.display,
      display: meta.display,
      mock: meta.mock,
      mode: meta.mode,
      replay: true,
    });

    // 캔들은 리포트에 저장되지 않는다 — 빈 배열로 둔다(없는 값을 지어내지 않는다).
    events.push({
      type: 'market',
      priceLine: meta.priceLine || '',
      candles: [],
      display: meta.display,
      kind: meta.kind || '',
      replay: true,
    });

    log(`> Fetching ${meta.display} data...`);
    log('> 실시간 시세 수신 완료');
    if (meta.priceLine) log(`> ${meta.priceLine}`);
    if (meta.perpPriceLine) log(`> [무기한] ${meta.perpPriceLine}`);

    if (memoryLines.length) {
      log('── 과거 판정 회고 ──', 'stage');
      for (const l of memoryLines) log(`> ${l}`);
    }

    const startEvt = (b) => {
      const e = { type: 'agent:start', id: b.id };
      if (b.turn != null) e.turn = b.turn;
      return e;
    };
    const doneEvt = (b) => {
      const e = { type: 'agent:done', id: b.id, bubble: b.bubble, report: b.report };
      if (b.turn != null) e.turn = b.turn;
      return e;
    };
    // 순차 스테이지(토론·스캘핑 데스크·리스크 위원회): start → done 을 짝지어 낸다
    const pushAgent = (b) => {
      events.push(startEvt(b), doneEvt(b));
    };

    // 애널리스트 팀만 엔진에서 Promise.allSettled 로 **병렬** 실행된다.
    // 그래서 원본은 start 4개가 먼저 몰려 나오고(책상 4개가 동시에 생각한다) 그 뒤에
    // done 이 따라온다. 완료 순서는 기록되지 않으므로 리포트에 적힌 순서를 쓴다.
    if (analysts.length) {
      log('── 애널리스트 팀 분석 ──', 'stage');
      for (const b of analysts) events.push(startEvt(b));
      for (const b of analysts) events.push(doneEvt(b));
    }

    if (debate.length) log('── 리서치 토론 (BULL vs BEAR) ──', 'stage');
    for (const b of debate) pushAgent(b);

    if (scalpDesk.length) log('── 스캘핑 데스크 (20x) ──', 'stage');
    for (const b of scalpDesk) pushAgent(b);

    // ACE — 리포트에는 말풍선이 따로 저장되지 않으므로 근거의 첫 문장으로 복원한다.
    log(pm ? '── 수석 트레이더 1차 판정 ──' : '── 최종 판정 ──', 'stage');
    const rationale = dec.main['근거'] || '';
    const aceBubble =
      firstSentence(rationale, 140) ||
      `${action}${confidence != null ? ` · 확신도 ${confidence}%` : ''}`;
    events.push({ type: 'agent:start', id: 'ace' });
    events.push({
      type: 'agent:done',
      id: 'ace',
      bubble: aceBubble,
      report: dec.report,
      reconstructed: true,
    });

    if (riskDesk.length) log('── 리스크 위원회 심사 ──', 'stage');
    for (const b of riskDesk) pushAgent(b);

    if (pm) {
      log('── 포트폴리오 매니저 최종 승인 ──', 'stage');
      events.push({ type: 'agent:start', id: 'pm' });
      events.push({
        type: 'agent:done',
        id: 'pm',
        bubble: pm.failed ? '승인 절차 실패' : pm.bubble,
        report: pm.report,
      });
    }

    // 리스크 게이트 — 원본에서는 PM 승인 뒤, decision 직전에 방송된다.
    if (gate) {
      events.push({
        type: 'risk',
        rr: gate.rr,
        ok: gate.ok,
        reasons: gate.reasons.slice(),
        // 리포트에는 사이징이 문장으로만 남는다. 객체를 지어내지 않고 원문을 그대로 싣는다.
        sizing: gate.sizingText || null,
        scope: gate.scope,
        side: gate.side,
        // 청산가는 리포트에 이미 반올림돼 저장된다(fmtPrice). 원본의 소수점 이하는 복원 불가라
        // 표기된 값 그대로 쓰고, 원문 문자열도 liqText 로 함께 싣는다.
        liq: gate.liq,
        liqText: gate.liqText || null,
        stopBeyondLiq: gate.stopBeyondLiq,
        minRR: gate.minRR,
        mode: meta.mode,
        replay: true,
      });
      log('── 리스크 게이트 ──', 'stage');
      log(
        `> 평가 대상: ${gate.scope === 'scalp' ? '스캘핑 레벨(레버리지 계약)' : '스윙 레벨'}` +
          ` · 방향 ${gate.side || '없음'}`
      );
      log(
        `> 손익비 ${gate.rr != null ? gate.rr.toFixed(2) : '데이터 없음'}` +
          ` (최소 ${gate.minRR != null ? gate.minRR : '데이터 없음'})` +
          ` · 청산가 ${gate.liqText || '데이터 없음'}` +
          (gate.stopBeyondLiq ? ' · ⚠ 손절보다 청산이 먼저 온다' : '')
      );
      for (const r of gate.reasons) log(`> ${r}`);
    }

    const decisionEvt = {
      type: 'decision',
      action,
      confidence: confidence == null ? 0 : confidence,
      entry: dec.main['진입'] || '-',
      stop: dec.main['손절'] || '-',
      target: dec.main['목표'] || '-',
      rationale,
      report: dec.report,
      replay: true,
    };
    if (dec.scalp) {
      decisionEvt.scalp = {
        bias: (dec.scalp['편향'] || '-').toUpperCase(),
        entry: dec.scalp['진입 트리거'] || '-',
        stop: dec.scalp['무효화(손절)'] || '-',
        target: dec.scalp['1차 목표'] || '-',
        note: dec.scalp['리스크'] || '',
      };
    }
    // PM 판정 / 권장 비중 — 최종 판정 섹션에 있으면 그걸, 없으면 PM 섹션에서 가져온다.
    const verdict = dec.main['PM 판정'] || (pm ? pm.verdict : '');
    if (verdict) decisionEvt.verdict = String(verdict).toUpperCase();
    const sizing = dec.main['권장 비중'] || (pm ? pm.sizing : '');
    if (sizing) decisionEvt.sizing = sizing;
    // 리스크 게이트 결과 — engine.js 가 decision 이벤트에 싣는 필드를 그대로 복원한다.
    if (gate) {
      decisionEvt.rr = gate.rr;
      decisionEvt.riskOk = gate.ok;
      decisionEvt.riskReasons = gate.reasons.slice();
      decisionEvt.liq = gate.liq;
      if (gate.sizingText) decisionEvt.riskSizing = gate.sizingText;
    }
    events.push(decisionEvt);

    log(
      `>>> 최종 판정: ${action}${confidence != null ? ` (${confidence}%)` : ''}` +
        (decisionEvt.verdict ? ` · PM ${decisionEvt.verdict}` : ''),
      'stage'
    );

    events.push({ type: 'run:end', replay: true });

    return {
      ok: true,
      events,
      reason: null,
      meta: {
        display: meta.display,
        symbol: meta.symbol,
        kind: meta.kind,
        ts: meta.ts,
        mode: meta.mode,
        mock: meta.mock,
        priceLine: meta.priceLine,
        perpPriceLine: meta.perpPriceLine,
        boardLines,
        memoryLines,
        riskGate: gate,
        counts: {
          analysts: analysts.length,
          debate: debate.length,
          scalpDesk: scalpDesk.length,
          risk: riskDesk.length,
          pm: pm ? 1 : 0,
          riskGate: gate ? 1 : 0,
          events: events.length,
        },
        // ACE 말풍선은 리포트에 저장되지 않아 근거 첫 문장으로 재구성한 값이다.
        aceBubbleReconstructed: true,
      },
    };
  } catch (e) {
    return fail('리포트 파싱 중 오류: ' + (e && e.message ? e.message : String(e)));
  }
}

/**
 * 리포트 파일을 읽어 파싱한다. parseReport 의 비동기 편의 래퍼(계약 외 확장).
 * 읽기에 실패해도 throw 하지 않는다.
 */
async function parseReportFile(filePath) {
  let raw = '';
  try {
    raw = await fsp.readFile(filePath, 'utf8');
  } catch (e) {
    return {
      ok: false,
      events: [],
      meta: {},
      reason: '리포트 파일을 읽지 못했습니다: ' + (e && e.message ? e.message : String(e)),
    };
  }
  return parseReport(raw);
}

/**
 * 이벤트 배열을 배속으로 순차 방출한다.
 *
 * 첫 이벤트는 즉시, 이후 이벤트는 (400 / speed)ms 간격으로 내보낸다.
 *
 * @param {Array|object} events        이벤트 배열 (parseReport 결과 객체를 그대로 넘겨도 된다)
 * @param {object}  [opts]
 * @param {number}  [opts.speed=1]     배속. 2면 200ms 간격
 * @param {Function}[opts.onEvent]     이벤트마다 호출. Promise 를 돌려주면 await 한다
 * @param {number}  [opts.delayMs=400] 기본 간격 재정의 (계약 외 확장)
 * @param {AbortSignal} [opts.signal]  중단 신호 (계약 외 확장 — SSE 연결이 끊길 때 사용)
 * @param {Function}[opts.shouldStop]  true 를 돌려주면 중단 (계약 외 확장)
 * @returns {Promise<{emitted:number,total:number,stopped:boolean,speed:number,delayMs:number}>}
 */
async function replayEvents(events, opts) {
  const o = opts || {};
  const raw = events && !Array.isArray(events) && Array.isArray(events.events)
    ? events.events
    : events;
  const list = Array.isArray(raw) ? raw.filter((e) => e && typeof e === 'object') : [];

  const speedRaw = Number(o.speed);
  const speed = Number.isFinite(speedRaw) && speedRaw > 0 ? Math.min(speedRaw, 100) : 1;
  const baseRaw = Number(o.delayMs);
  const base = Number.isFinite(baseRaw) && baseRaw >= 0 ? baseRaw : DEFAULT_DELAY_MS;
  const gap = Math.max(0, Math.round(base / speed));

  const onEvent = typeof o.onEvent === 'function' ? o.onEvent : null;
  const aborted = () => {
    if (o.signal && o.signal.aborted) return true;
    if (typeof o.shouldStop === 'function') {
      try {
        return !!o.shouldStop();
      } catch (_) {
        return false;
      }
    }
    return false;
  };

  let emitted = 0;
  let stopped = false;

  for (let i = 0; i < list.length; i++) {
    if (aborted()) {
      stopped = true;
      break;
    }
    if (i > 0 && gap > 0) {
      await sleep(gap);
      if (aborted()) {
        stopped = true;
        break;
      }
    }
    if (onEvent) {
      try {
        // 구독자가 터져도 재생은 계속한다 (SSE 한 명이 끊겨도 나머지는 흘러야 한다).
        await onEvent(list[i], i, list.length);
      } catch (e) {
        console.error('[replay] onEvent 콜백 오류:', e && e.message ? e.message : e);
      }
    }
    emitted++;
  }

  return { emitted, total: list.length, stopped, speed, delayMs: gap };
}

module.exports = { parseReport, parseReportFile, replayEvents, DEFAULT_DELAY_MS };
