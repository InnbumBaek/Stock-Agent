/* ==========================================================================
   PIXEL TRADING FLOOR — stage.js
   살아있는 오피스 연출. 레퍼런스 릴스의 "진짜 일하는 회사" 느낌:
   · 인트로(소등 → 방마다 점등 → 타이틀 카드 → 오프닝 벨)
   · 열일 이펙트(타이핑 파티클 · 모니터 글로우)
   · 서류 전달(분석 완료 시 다음 방으로 종이가 날아감)
   · 판정 스탬프(스포트라이트 + 쾅) · 색종이
   · 오피스 라이프(대기 중 커피 타임 · 잡담 · 기지개)
   app.js 뒤에 로드된다(전역 qs/deskEl/AGENT_IDS/tone/STILL/drawSprite 사용).
   연출은 전부 부가 기능 — 어떤 실패도 분석 흐름을 막지 않는다.
   ========================================================================== */
'use strict';

const Stage = (() => {
  let mode = 'algo';
  let running = false;
  // 페이지 접속 직후에는 SSE가 지난 이벤트를 한꺼번에 재생(replay)한다.
  // 그때 인트로·스탬프·서류가 동시에 터지면 난장판이 되므로 접속 후 2초간은
  // 상태(모드·working 클래스)만 반영하고 화면 연출은 건너뛴다.
  const bootTs = (typeof performance !== 'undefined' ? performance.now() : 0);
  function inReplayBurst() {
    return (typeof performance !== 'undefined' ? performance.now() : 0) - bootTs < 2000;
  }
  let fxLayer = null;
  let coffeeBusy = false;

  // 서류가 날아갈 다음 단계의 방
  function destRoom(id) {
    if (['taro', 'diana', 'nova', 'vibe'].includes(id)) {
      return mode === 'algo' ? 'room-research' : 'room-scalp';
    }
    return 'room-trading';
  }

  function floorEl() { return qs('#floor'); }

  function centerOf(el) {
    const f = floorEl();
    if (!el || !f) return null;
    const a = el.getBoundingClientRect();
    const b = f.getBoundingClientRect();
    return { x: a.left - b.left + a.width / 2, y: a.top - b.top + a.height / 2 };
  }

  function ensureFx() {
    if (fxLayer && fxLayer.isConnected) return fxLayer;
    const f = floorEl();
    if (!f) return null;
    fxLayer = document.createElement('div');
    fxLayer.id = 'fx-layer';
    f.appendChild(fxLayer);
    return fxLayer;
  }

  /* ---- 모임 동선(스쿠트): 책상째 이동해 말풍선·명패가 함께 따라간다 ---- */
  function scoot(id, x, y, cls) {
    const d = deskEl(id);
    if (!d) return;
    d.style.transform = 'translate(' + x + 'px, ' + y + 'px)';
    if (cls) d.classList.add(cls);
  }

  function scootBack(ids) {
    ids.forEach((id) => {
      const d = deskEl(id);
      if (!d) return;
      d.style.transform = '';
      d.classList.remove('arguing');
    });
  }

  // 토론: 서로에게 다가서며 언쟁 / 심사: 본부 쪽으로 모임 / PM: 월스크린 앞으로
  const DEBATE_IDS_ST = ['bull', 'bear'];
  const RISK_IDS_ST = ['risky', 'neutral', 'safe'];

  function choreograph(ev) {
    if (STILL || inReplayBurst()) return;
    const id = ev.id;
    if (ev.type === 'agent:start') {
      if (id === 'bull') { scoot('bull', 26, 8, 'arguing'); scoot('bear', -8, 2); }
      else if (id === 'bear') { scoot('bear', -26, 8, 'arguing'); scoot('bull', -8, 2); }
      else if (RISK_IDS_ST.includes(id)) {
        // 심사자들이 차례로 본부 방향(오른쪽)으로 다가선다
        const off = { risky: [30, -4], neutral: [22, 6], safe: [30, 12] };
        scoot(id, off[id][0], off[id][1], 'arguing');
      } else if (id === 'pm') {
        scoot('pm', 0, -14, 'arguing'); // 월스크린 앞으로 한 걸음
      } else if (['blitz', 'guard', 'ace'].includes(id)) {
        scootBack(DEBATE_IDS_ST); // 토론 끝 — 제자리로
      }
    } else if (ev.type === 'agent:done') {
      const d = deskEl(id);
      if (d) d.classList.remove('arguing');
      if (id === 'pm' || id === 'ace') scootBack(RISK_IDS_ST.concat(['pm']));
    } else if (ev.type === 'run:end') {
      scootBack(DEBATE_IDS_ST.concat(RISK_IDS_ST, ['pm']));
    }
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (ch) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
  }

  /* ---- 인트로: 소등 → 방마다 점등 → 타이틀 카드 → 오프닝 벨 ---- */
  function intro(ev) {
    if (STILL) return;
    const rooms = ['room-analyst', 'room-research', 'room-scalp', 'room-trading']
      .map((id) => document.getElementById(id))
      .filter(Boolean);
    rooms.forEach((r) => r.classList.add('lights-off'));

    const card = document.createElement('div');
    card.id = 'intro-card';
    const modeName =
      ev.mode === 'scalp' ? '⚡ 스캘핑 20x' : ev.mode === 'attack' ? '⚔ 공격 모드' : '알고리즘';
    card.innerHTML =
      '<div class="ic-sym">' + esc(ev.display || ev.symbol || '') + '</div>' +
      '<div class="ic-mode">' + modeName + ' · 분석 개시</div>' +
      '<div class="ic-sub">에이전트 출근 중…</div>';
    document.body.appendChild(card);
    requestAnimationFrame(() => card.classList.add('in'));

    rooms.forEach((r, i) => {
      setTimeout(() => {
        r.classList.remove('lights-off');
        r.classList.add('lights-flick');
        setTimeout(() => r.classList.remove('lights-flick'), 500);
        tone({ freq: 520 + i * 90, dur: 0.05, vol: 0.025 });
        // 그 방 캐릭터들 출근 러시(짧은 점프)
        r.querySelectorAll('.desk:not(.idle) .sprite').forEach((s, j) => {
          setTimeout(() => {
            s.classList.add('rush');
            setTimeout(() => s.classList.remove('rush'), 620);
          }, j * 90);
        });
      }, 350 + i * 320);
    });

    // 오프닝 벨(장 개시 종) 2타 + 카드 퇴장
    setTimeout(() => {
      tone({ freq: 1560, dur: 0.28, vol: 0.05, type: 'triangle' });
      setTimeout(() => tone({ freq: 1560, dur: 0.34, vol: 0.04, type: 'triangle' }), 340);
    }, 350 + rooms.length * 320);
    setTimeout(() => {
      card.classList.remove('in');
      setTimeout(() => card.remove(), 450);
    }, 2450);
  }

  /* ---- 열일: 타이핑 파티클 + 모니터 글로우 ---- */
  function workOn(id) {
    const d = deskEl(id);
    if (!d) return;
    d.classList.add('working');
    d._workFx = setInterval(() => {
      if (document.hidden || STILL) return;
      typingBurst(d, 1 + ((Math.random() * 2) | 0));
    }, 460);
  }

  function workOff(id) {
    const d = deskEl(id);
    if (!d) return;
    d.classList.remove('working');
    if (d._workFx) { clearInterval(d._workFx); d._workFx = null; }
  }

  function typingBurst(desk, n) {
    const fx = ensureFx();
    const c = centerOf(desk);
    if (!fx || !c) return;
    for (let i = 0; i < n; i++) {
      const p = document.createElement('i');
      p.className = 'key-spark';
      p.style.left = (c.x - 6 + Math.random() * 24 - 12) + 'px';
      p.style.top = (c.y + 6) + 'px';
      fx.appendChild(p);
      setTimeout(() => p.remove(), 700);
    }
  }

  /* ---- 서류 전달 ---- */
  function flyPaper(id) {
    if (STILL) return;
    const fx = ensureFx();
    const from = centerOf(deskEl(id));
    const to = centerOf(document.getElementById(destRoom(id)));
    if (!fx || !from || !to) return;
    const paper = document.createElement('div');
    paper.className = 'fly-paper';
    paper.style.left = from.x + 'px';
    paper.style.top = (from.y - 26) + 'px';
    fx.appendChild(paper);
    requestAnimationFrame(() => {
      paper.style.transform =
        'translate(' + (to.x - from.x) + 'px, ' + (to.y - from.y - 20) + 'px) rotate(540deg)';
      paper.style.opacity = '0';
    });
    tone({ freq: 880, dur: 0.04, vol: 0.02 });
    setTimeout(() => paper.remove(), 950);
  }

  /* ---- 판정: 스포트라이트 + 스탬프 + 색종이 ---- */
  function stamp(ev) {
    if (STILL) return;
    const act = String(ev.action || 'HOLD').toUpperCase();
    const col = DECISION_COLORS[act] || DECISION_COLORS.HOLD;

    ['room-analyst', 'room-research', 'room-scalp'].forEach((id) => {
      const r = document.getElementById(id);
      if (r) { r.classList.add('dimmed'); setTimeout(() => r.classList.remove('dimmed'), 2600); }
    });
    const hq = document.getElementById('room-trading');
    if (hq) { hq.classList.add('spotlit'); setTimeout(() => hq.classList.remove('spotlit'), 2600); }

    const st = document.createElement('div');
    st.id = 'decision-stamp';
    st.textContent = act;
    st.style.color = col;
    st.style.borderColor = col;
    document.body.appendChild(st);
    requestAnimationFrame(() => st.classList.add('slam'));
    setTimeout(() => { st.classList.add('out'); setTimeout(() => st.remove(), 500); }, 1900);

    if (act === 'BUY' || act === 'SELL') {
      confetti(col, act === 'BUY' ? '#a7f3c0' : '#ffd0cc');
    }
  }

  function confetti(c1, c2) {
    const fx = ensureFx();
    const f = floorEl();
    if (!fx || !f) return;
    const w = f.clientWidth;
    for (let i = 0; i < 26; i++) {
      const p = document.createElement('i');
      p.className = 'confetti';
      p.style.left = (Math.random() * w) + 'px';
      p.style.background = Math.random() > 0.5 ? c1 : c2;
      p.style.animationDelay = (Math.random() * 0.5).toFixed(2) + 's';
      p.style.animationDuration = (1.1 + Math.random() * 0.9).toFixed(2) + 's';
      fx.appendChild(p);
      setTimeout(() => p.remove(), 2400);
    }
  }

  /* ---- 오피스 라이프 ---- */
  const CHAT_LINES = [
    ['커피 한 잔 어때요?', '이것만 보고요…'],
    ['펀딩비 확인했어요?', '방금 봤어요, 아직 중립.'],
    ['어제 리포트 봤어요?', '손익비가 아쉽던데요.'],
    ['괴리 벌어지는데?', '지켜보죠. 트리거 전까진 관망.'],
    ['오늘 변동성 크네요', '이럴 때일수록 원칙대로.'],
  ];

  function visibleDesks() {
    return AGENT_IDS.map(deskEl).filter((d) => {
      if (!d || d.classList.contains('idle') || d.classList.contains('working')) return false;
      return getComputedStyle(d).display !== 'none';
    });
  }

  function chatMoment() {
    const desks = visibleDesks();
    if (desks.length < 2) return;
    const i = (Math.random() * desks.length) | 0;
    let j = (Math.random() * desks.length) | 0;
    if (j === i) j = (j + 1) % desks.length;
    const pair = CHAT_LINES[(Math.random() * CHAT_LINES.length) | 0];
    smallTalk(desks[i], pair[0]);
    setTimeout(() => smallTalk(desks[j], pair[1]), 1400);
  }

  function smallTalk(desk, text) {
    const fx = ensureFx();
    const c = centerOf(desk);
    if (!fx || !c) return;
    const t = document.createElement('div');
    t.className = 'small-talk';
    t.textContent = text;
    t.style.left = c.x + 'px';
    t.style.top = (c.y - 56) + 'px';
    fx.appendChild(t);
    requestAnimationFrame(() => t.classList.add('in'));
    setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 300); }, 2300);
  }

  // 커피 타임 — 자리를 비우고 커피머신까지 걸어갔다 온다
  function coffeeTrip() {
    if (coffeeBusy) return;
    const desks = visibleDesks();
    if (!desks.length) return;
    const desk = desks[(Math.random() * desks.length) | 0];
    const sprite = desk.querySelector('.sprite');
    const fx = ensureFx();
    const from = centerOf(desk);
    const anl = document.getElementById('room-analyst');
    if (!sprite || !fx || !from || !anl) return;
    const base = centerOf(anl);
    if (!base) return;
    // 커피머신: 애널리스트 방 좌상단 구석
    const machine = {
      x: base.x - anl.clientWidth / 2 + 46,
      y: base.y - anl.clientHeight / 2 + 58,
    };

    const id = AGENT_IDS.find((k) => deskEl(k) === desk);
    if (!id) return;
    coffeeBusy = true;

    const walker = document.createElement('canvas');
    walker.width = 48;
    walker.height = 48;
    walker.className = 'walker';
    drawSprite(walker, id);
    walker.style.left = (from.x - 24) + 'px';
    walker.style.top = (from.y - 30) + 'px';
    fx.appendChild(walker);
    sprite.classList.add('away');

    requestAnimationFrame(() => {
      walker.classList.add('walking');
      walker.style.transform =
        'translate(' + (machine.x - from.x) + 'px, ' + (machine.y - from.y) + 'px)';
    });

    // 도착 → 김 모락모락 → 복귀
    setTimeout(() => {
      walker.classList.remove('walking');
      for (let s = 0; s < 3; s++) {
        setTimeout(() => {
          const st = document.createElement('i');
          st.className = 'steam';
          st.style.left = (machine.x + 4) + 'px';
          st.style.top = (machine.y - 26) + 'px';
          fx.appendChild(st);
          setTimeout(() => st.remove(), 900);
        }, s * 300);
      }
    }, 1650);
    setTimeout(() => {
      walker.classList.add('walking');
      walker.style.transform = 'translate(0px, 0px)';
    }, 3100);
    setTimeout(() => {
      walker.remove();
      sprite.classList.remove('away');
      coffeeBusy = false;
    }, 4900);
  }

  function stretchMoment() {
    const desks = visibleDesks();
    if (!desks.length) return;
    const s = desks[(Math.random() * desks.length) | 0].querySelector('.sprite');
    if (!s) return;
    s.classList.add('stretch');
    setTimeout(() => s.classList.remove('stretch'), 1200);
  }

  function idleTick() {
    if (running || document.hidden || STILL) return;
    const r = Math.random();
    if (r < 0.45) chatMoment();
    else if (r < 0.75) coffeeTrip();
    else stretchMoment();
  }

  /* ---- 이벤트 배선 ---- */
  function on(ev) {
    choreograph(ev);
    switch (ev.type) {
      case 'run:start':
        running = true;
        mode = ev.mode || 'algo';
        if (!inReplayBurst()) intro(ev);
        break;
      case 'agent:start':
        workOn(ev.id);
        break;
      case 'agent:done':
        workOff(ev.id);
        if (!inReplayBurst()) flyPaper(ev.id);
        break;
      case 'decision':
        if (!inReplayBurst()) stamp(ev);
        break;
      case 'run:end':
        running = false;
        AGENT_IDS.forEach(workOff);
        break;
      default:
        break;
    }
  }

  function init() {
    ensureFx();
    if (!STILL) {
      setInterval(idleTick, 8500);
      // 첫 로드 3초 뒤 가벼운 오피스 라이프 한 번 (정지 화면 방지)
      setTimeout(idleTick, 3000);
    }
  }

  return { on, init };
})();
