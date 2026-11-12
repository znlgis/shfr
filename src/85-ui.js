/* 85-ui.js — 全屏界面层：启动屏 / 标题卡 / 四选一选角 / 暂停 / 失败结算 / 胜利结算（负责人：ui）
   -----------------------------------------------------------------------------
   · 只负责 DOM 界面态；HUD（血条/弹药/准星/飘字/触屏）由 80-hud.js 挂到同一个
     window.PG.ui 上，本文件绝不整体覆盖 PG.ui，只逐个追加方法。
   · 禁止 import/export（build.mjs 会把它拼进单个 <script>）。
   · 对外 API：mount(rootEl) / screen(name) / setCharacters(list) / on(evt, fn)
              + 可选 setResult(data)（结算统计，Lead 可调，也可不调）。 */
(() => {
  'use strict';
  const PG = (window.PG = window.PG || {});
  const ui = (PG.ui = PG.ui || {});

  /* ================================= 工具 ================================= */
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const num = (v, fb) => (typeof v === 'number' && isFinite(v) ? v : fb);
  const pad2 = (n) => (n < 10 ? '0' + n : '' + n);

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(num(sec, 0)));
    return pad2(Math.floor(sec / 60)) + ':' + pad2(sec % 60);
  }
  function group(n) {
    return String(Math.round(num(n, 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function mk(tag, cls, parent, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    if (parent) parent.appendChild(el);
    return el;
  }
  function fx(name) {
    try {
      if (PG.audio && typeof PG.audio.sfx === 'function') PG.audio.sfx(name);
    } catch (e) {}
  }
  function hexRgba(hex, a) {
    let h = typeof hex === 'string' ? hex.replace('#', '') : '';
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length !== 6) h = 'e8b33a';
    const n = parseInt(h, 16);
    if (!isFinite(n)) return 'rgba(232,179,58,' + a + ')';
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  // 复制一份画布，避免把 PG.models 生成的头像节点搬来搬去影响 HUD
  function copyCanvas(src, size, cls) {
    if (!src || typeof src !== 'object') return null;
    try {
      const c = document.createElement('canvas');
      c.width = size;
      c.height = size;
      c.className = cls || 'cc-canvas';
      const x = c.getContext('2d');
      if (!x) return null;
      x.drawImage(src, 0, 0, size, size);
      return c;
    } catch (e) {
      return null;
    }
  }

  const TYPE_CN = { lei: '雷', mu: '木', huo: '火', shui: '水', feng: '风', du: '毒', yan: '岩', shou: '兽', ling: '灵', gui: '鬼', yao: '妖' };
  const DIFF_META = [
    { id: 'easy', cn: '悠然', en: 'EASY', desc: '妖物更慢更轻 · 灵兽帮忙 · 护主复活一次', color: '#8ed36a' },
    { id: 'normal', cn: '标准', en: 'NORMAL', desc: '节奏舒展 · 有挑战，但不会手忙脚乱', color: '#e8b33a' },
    { id: 'hard', cn: '挑战', en: 'HARD', desc: '原版强度 · 妖物四面来袭，只靠走位与枪法', color: '#d0432e' },
  ];
  const STATS = [['hp', '体力'], ['dmg', '伤害'], ['rate', '射速'], ['spd', '速度']];

  /* ================================= 状态 ================================= */
  const D = {
    mounted: false,
    root: null,
    layer: null,
    grid: null,
    scrs: {},
    screen: 'hidden',
    pending: null,
    chars: [],
    sel: 0,
    selId: null,
    cardEls: [],
    elCount: null,
    elUlt: null,
    btnLaunch: null,
    res: {},
    result: null,
    settings: [],
    volume: 0.7,
    muted: false,
    listeners: {},
    hoverEl: null,
    hoverAt: 0,
    diffId: 'easy',
    diffEls: [],
    pauseDiff: null,
    pauseDiffEls: [],
    sensRange: null,
    sensVal: null,
    sens: 1,
  };

  /* =============================== 事件总线 =============================== */
  function emit(evt, a, b) {
    const arr = D.listeners[evt];
    if (!arr) return;
    for (let i = 0; i < arr.length; i++) {
      try {
        arr[i](a, b);
      } catch (e) {}
    }
  }
  function on(evt, fn) {
    if (typeof evt !== 'string' || typeof fn !== 'function') return;
    (D.listeners[evt] || (D.listeners[evt] = [])).push(fn);
  }

  /* =============================== 设置组件 =============================== */
  function buildSettings(parent) {
    const row = mk('div', 'ui-settings', parent);
    mk('span', 'st-lbl', row, '音量');
    const range = mk('input', 'ui-range', row);
    range.type = 'range';
    range.min = '0';
    range.max = '100';
    range.step = '1';
    range.setAttribute('aria-label', '音量');
    const mute = mk('button', 'ui-chip ui-mute', row);
    mute.type = 'button';

    const sync = () => {
      range.value = String(Math.round(D.volume * 100));
      range.style.setProperty('--vol', D.volume.toFixed(3));
      mute.classList.toggle('off', D.muted);
      mute.textContent = D.muted ? '音效：关' : '音效：开';
    };
    range.addEventListener('input', () => {
      D.volume = clamp(Number(range.value) / 100, 0, 1);
      sync();
      emit('volume', D.volume);
    });
    range.addEventListener('change', () => fx('ui_click'));
    mute.addEventListener('click', () => {
      fx('ui_click');
      D.muted = !D.muted;
      sync();
      emit('mute', D.muted);
    });

    D.settings.push(sync);
    sync();
    return row;
  }
  function syncSettings() {
    for (let i = 0; i < D.settings.length; i++) {
      try {
        D.settings[i]();
      } catch (e) {}
    }
  }

  /* =============================== 标题屏 =============================== */
  // 触屏上写「按 Enter」只会让人困惑；手机竖屏也只有横过来才有完整视野
  function titleHintText() {
    let touch = false;
    try { touch = !!(ui.isTouch && ui.isTouch()); } catch (e) {}
    if (!touch) {
      try {
        touch = (('ontouchstart' in window) || (navigator.maxTouchPoints > 0)) &&
          !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
      } catch (e) {}
    }
    return touch ? '点击按钮开始 · 建议横屏游玩' : '按 Enter 或点击按钮开始 · 建议全屏游玩';
  }
  function buildTitle() {
    const s = mk('section', 'scr scr-title');
    s.setAttribute('data-scr', 'title');

    const deco = mk('div', 'title-deco', s);
    for (let i = 0; i < 6; i++) mk('i', 'deco-orb', deco);

    const hero = mk('header', 'title-hero', s);
    mk('div', 'title-ribbon', hero, '山海秘境 · 混沌来袭');
    const logo = mk('h1', 'title-logo', hero);
    mk('span', 'tl-top', logo, '山海');
    mk('span', 'tl-main', logo, '森之突袭');
    const en = mk('div', 'title-en', hero);
    mk('span', '', en, 'SHAN HAI');
    mk('i', 'en-dot', en);
    mk('span', '', en, 'FOREST RAID');
    mk('p', 'title-tag', hero, '混沌之气侵入山海秘境，上古妖物纷纷苏醒。带上灵兽，从古林一路打到山海之眼。');

    const chips = mk('div', 'title-chips', hero);
    mk('span', 'chip', chips, '8 波关卡');
    mk('span', 'chip', chips, '第 8 波 BOSS · 混沌');
    mk('span', 'chip', chips, '4 位行者可选');

    const foot = mk('footer', 'title-actions', s);
    const start = mk('button', 'ui-btn ui-btn-primary btn-start', foot);
    start.type = 'button';
    mk('i', 'ui-coin', start);
    mk('span', '', start, '开始探险');
    start.addEventListener('click', () => enterSelect());
    mk('div', 'title-hint', foot, titleHintText());
    buildSettings(foot).classList.add('title-settings');
    mk('div', 'title-ver', s, 'v1.0 · 单文件离线版');
    return s;
  }

  /* =============================== 选角屏 =============================== */
  function buildSelect() {
    const s = mk('section', 'scr scr-select');
    s.setAttribute('data-scr', 'select');

    const head = mk('header', 'scr-head sel-head', s);
    const back = mk('button', 'ui-btn ui-btn-ghost btn-back', head);
    back.type = 'button';
    back.textContent = '← 返回标题';
    back.addEventListener('click', () => {
      fx('ui_back');
      screen('title');
    });
    const mid = mk('div', 'head-mid', head);
    mk('div', 'scr-kicker', mid, '行者卷宗 · 四选一');
    mk('h2', 'scr-h', mid, '选择你的行者');
    mk('p', 'scr-sub', mid, '灵兽会随你进入古林，法器与异能各不相同');
    D.elCount = mk('div', 'sel-count', head);

    D.grid = mk('div', 'char-grid', s);

    // 难度三选一（默认悠然；选角页与暂停页都可切换）
    const diffBox = mk('div', 'sel-diffs', s);
    const dHead = mk('div', 'sel-diff-head', diffBox);
    mk('b', 'sel-diff-t', dHead, '难度');
    mk('span', 'sel-diff-s', dHead, '小朋友建议选「悠然」');
    const dGrid = mk('div', 'sel-diff-grid', diffBox);
    D.diffEls = [];
    for (let i = 0; i < DIFF_META.length; i++) {
      const d = DIFF_META[i];
      const b = mk('button', 'diff-card', dGrid);
      b.type = 'button';
      b.style.setProperty('--dc', d.color);
      const nm = mk('div', 'dc-head', b);
      mk('b', 'dc-cn', nm, d.cn);
      mk('span', 'dc-en', nm, d.en);
      mk('p', 'dc-desc', b, d.desc);
      b.addEventListener('click', () => { if (D.diffId !== d.id) { fx('ui_click'); setDifficulty(d.id, true); } });
      D.diffEls.push({ id: d.id, el: b });
    }
    setDifficulty(D.diffId, false);

    const foot = mk('footer', 'sel-foot', s);
    const ult = mk('div', 'sel-ult', foot);
    mk('span', 'ult-tag', ult, '灵兽技');
    D.elUlt = mk('b', 'ult-text', ult, '');
    D.btnLaunch = mk('button', 'ui-btn ui-btn-primary btn-launch', foot, '确认出发');
    D.btnLaunch.type = 'button';
    D.btnLaunch.addEventListener('click', doLaunch);
    mk('div', 'sel-hint', foot, '← → 选择 · Enter 出发 · Esc 返回标题');
    return s;
  }

  function ensureCards(force) {
    if (!D.grid) return;
    const key = D.chars.map((c) => c.id).join('|');
    if (!force && D.grid.childElementCount && D.cardsForKey === key) return;
    D.cardsForKey = key;
    D.grid.innerHTML = '';
    D.cardEls = [];
    for (let i = 0; i < D.chars.length; i++) {
      const c = D.chars[i];
      const card = mk('article', 'char-card', D.grid);
      card.style.setProperty('--i', String(i));
      card.style.setProperty('--type', c.color || '#e8b33a');
      card.style.setProperty('--type-soft', hexRgba(c.color || '#e8b33a', 0.2));

      const por = mk('div', 'cc-portrait', card);
      const cv = copyCanvas(c.portrait, 256, 'cc-canvas');
      if (cv) por.appendChild(cv);
      else mk('span', 'cc-initial', por, (c.cn || '行').slice(0, 1));
      mk('span', 'cc-type', por, TYPE_CN[c.type] || '');

      const nm = mk('div', 'cc-name', card);
      mk('b', '', nm, c.cn || '行者');
      mk('em', '', nm, c.en || '');

      const partner = mk('div', 'cc-partner', card);
      const picon = copyCanvas(c.partnerIcon, 128, 'cc-pic cc-canvas');
      if (picon) partner.appendChild(picon);
      else mk('i', 'cc-pic cc-pic-blank', partner, (c.partnerCn || '兽').slice(0, 1));
      mk('span', 'cc-pname', partner, c.partnerCn || '灵兽');

      const weapon = mk('div', 'cc-weapon', card);
      mk('i', 'cc-wdot', weapon);
      mk('span', '', weapon, c.weapon || '伏魔法器');

      mk('p', 'cc-passive', card, c.passive || '以伏魔法器与灵兽并肩作战');

      const stats = mk('div', 'cc-stats', card);
      for (let j = 0; j < STATS.length; j++) {
        const key2 = STATS[j][0];
        const v = clamp(num(c.stats && c.stats[key2], 0.4), 0.06, 1);
        const row = mk('div', 'cc-stat', stats);
        mk('span', 'cc-slabel', row, STATS[j][1]);
        const track = mk('div', 'cc-strack', row);
        const fill = mk('i', '', track);
        fill.style.width = Math.round(v * 100) + '%';
      }

      mk('i', 'cc-check', card, '✓');
      card.addEventListener('click', () => selectChar(i, true));
      D.cardEls.push(card);
    }
    selectChar(clamp(D.sel, 0, Math.max(0, D.chars.length - 1)), false);
  }

  function renderSelFoot() {
    const c = D.chars[D.sel];
    if (D.elCount) D.elCount.innerHTML = '<b>' + (D.chars.length ? D.sel + 1 : 0) + '</b><span>/ ' + D.chars.length + '</span>';
    if (D.elUlt) D.elUlt.textContent = c ? (c.ult || c.passive || '') : '';
    if (D.btnLaunch) D.btnLaunch.disabled = !c;
  }

  function selectChar(i, user) {
    const n = D.chars.length;
    if (!n) return;
    i = ((i % n) + n) % n;
    const changed = i !== D.sel;
    D.sel = i;
    D.selId = D.chars[i] ? D.chars[i].id : null;
    for (let k = 0; k < D.cardEls.length; k++) {
      D.cardEls[k].classList.toggle('sel', k === i);
    }
    renderSelFoot();
    if (changed) {
      emit('select', D.selId);
      if (user) fx('ui_click');
    }
  }

  /* =============================== 暂停屏 =============================== */
  function buildPause() {
    const s = mk('section', 'scr scr-pause');
    s.setAttribute('data-scr', 'pause');
    mk('div', 'ui-dim', s);

    const card = mk('div', 'ui-card pause-card', s);
    const badge = mk('div', 'pause-badge', card);
    mk('i', '', badge);
    mk('i', '', badge);
    mk('h2', 'pause-title', card, '已暂停');
    mk('p', 'pause-sub', card, '古林的时间也为你停驻');

    const list = mk('div', 'menu-list', card);
    const resume = mk('button', 'ui-btn ui-btn-primary', list, '继续游戏');
    resume.type = 'button';
    resume.addEventListener('click', doResume);
    const again = mk('button', 'ui-btn ui-btn-secondary', list, '重新开始');
    again.type = 'button';
    again.addEventListener('click', doRestart);
    const quit = mk('button', 'ui-btn ui-btn-ghost', list, '返回标题');
    quit.type = 'button';
    quit.addEventListener('click', doQuit);

    const diffRow = mk('div', 'pause-diff', card);
    mk('span', 'pause-diff-l', diffRow, '难度');
    D.pauseDiff = mk('b', 'pause-diff-v', diffRow, '悠然');
    D.pauseDiffEls = [];
    for (let i = 0; i < DIFF_META.length; i++) {
      const d = DIFF_META[i];
      const b = mk('button', 'pause-diff-btn', diffRow);
      b.type = 'button';
      b.textContent = d.cn;
      b.style.setProperty('--dc', d.color);
      b.addEventListener('click', () => { if (D.diffId !== d.id) { fx('ui_click'); setDifficulty(d.id, true); } });
      D.pauseDiffEls.push({ id: d.id, el: b });
    }

    const sensRow = mk('div', 'pause-sens', card);
    mk('span', 'st-lbl', sensRow, '视角灵敏度');
    const sr = mk('input', 'ui-range pause-range', sensRow);
    sr.type = 'range';
    sr.min = '60';
    sr.max = '160';
    sr.step = '5';
    sr.setAttribute('aria-label', '视角灵敏度');
    const sv = mk('b', 'pause-sens-v', sensRow, '100%');
    D.sensRange = sr;
    D.sensVal = sv;
    const syncSens = () => {
      sr.value = String(Math.round(clamp(D.sens, 0.6, 1.6) * 100));
      sv.textContent = sr.value + '%';
      sr.style.setProperty('--vol', ((Number(sr.value) - 60) / 100).toFixed(3));
    };
    sr.addEventListener('input', () => {
      D.sens = clamp(Number(sr.value) / 100, 0.6, 1.6);
      syncSens();
      emit('sens', D.sens);
    });
    sr.addEventListener('change', () => fx('ui_click'));
    syncSens();

    const tips = mk('div', 'pause-tips', card);
    const TIPS = [['WASD', '移动'], ['鼠标', '瞄准'], ['左键', '射击'], ['R', '装填'], ['Shift', '冲刺'], ['Space', '跳跃'], ['Q', '灵兽技'], ['Esc', '暂停']];
    for (let i = 0; i < TIPS.length; i++) {
      const row = mk('div', 'tip', tips);
      mk('kbd', '', row, TIPS[i][0]);
      mk('span', '', row, TIPS[i][1]);
    }
    buildSettings(card).classList.add('pause-settings');

    mk('div', 'pause-hint', s, 'Esc 或 Enter 继续游戏 · R 重新开始');
    return s;
  }

  /* =============================== 结算屏 =============================== */
  function buildResult(kind) {
    const win = kind === 'win';
    const s = mk('section', 'scr scr-' + kind);
    s.setAttribute('data-scr', kind);

    const backdrop = mk('div', 'result-backdrop ' + kind, s);
    if (win) {
      const conf = mk('div', 'confetti', backdrop);
      const colors = ['#e8b33a', '#d0432e', '#2f6fae', '#4e9c3f', '#f09b3c', '#2f9e8f', '#ffffff'];
      for (let i = 0; i < 22; i++) {
        const p = mk('i', '', conf);
        p.style.left = (3 + Math.random() * 94).toFixed(1) + '%';
        p.style.background = colors[i % colors.length];
        p.style.width = (5 + Math.random() * 7).toFixed(0) + 'px';
        p.style.height = (9 + Math.random() * 11).toFixed(0) + 'px';
        p.style.setProperty('--dur', (3.6 + Math.random() * 3.6).toFixed(2) + 's');
        p.style.setProperty('--delay', (Math.random() * 4).toFixed(2) + 's');
        p.style.setProperty('--drift', (Math.random() * 160 - 80).toFixed(0) + 'px');
      }
    }

    const card = mk('div', 'ui-card result-card ' + kind, s);
    const kicker = mk('div', 'result-kicker', card);
    mk('h2', 'result-title', card, win ? '山泽安宁！' : '挑战失败');
    const diffLine = mk('div', 'result-diff', card, '');

    let rank = null;
    if (win) {
      const rw = mk('div', 'rank-wrap', card);
      rank = mk('div', 'rank-stamp', rw, 'S');
      mk('small', 'rank-cap', rw, '本局评价');
    }

    const quote = mk('p', 'result-quote', card);
    const qwho = mk('span', 'quote-who', quote);
    const qtext = mk('span', 'quote-text', quote);

    const tiles = mk('div', 'res-stats', card);
    const refs = {};
    const TILE = [['wave', '抵达波次'], ['score', '总得分'], ['combo', '最高连击'], ['time', '坚持时间']];
    for (let i = 0; i < TILE.length; i++) {
      const t = mk('div', 'res-tile', tiles);
      refs[TILE[i][0]] = mk('b', '', t, '0');
      mk('span', '', t, TILE[i][1]);
    }

    const actions = mk('div', 'result-actions', card);
    const btnAgain = mk('button', 'ui-btn ui-btn-primary', actions, win ? '再来一局' : '再战一局');
    btnAgain.type = 'button';
    btnAgain.addEventListener('click', doRestart);
    const btnTitle = mk('button', 'ui-btn ui-btn-ghost', actions, '返回标题');
    btnTitle.type = 'button';
    btnTitle.addEventListener('click', doQuit);

    mk('div', 'result-note', s, 'Enter 再战一局 · Esc 返回标题');
    D.res[kind] = { kicker: kicker, rank: rank, who: qwho, text: qtext, refs: refs, diff: diffLine };
    return s;
  }

  function setDifficulty(id, user) {
    if (!DIFF_META.some((d) => d.id === id)) id = 'easy';
    const changed = id !== D.diffId;
    D.diffId = id;
    const meta = DIFF_META.find((d) => d.id === id) || DIFF_META[0];
    for (const it of D.diffEls) it.el.classList.toggle('sel', it.id === id);
    for (const it of D.pauseDiffEls) it.el.classList.toggle('sel', it.id === id);
    if (D.pauseDiff) {
      D.pauseDiff.textContent = meta.cn;
      D.pauseDiff.style.setProperty('--dc', meta.color);
    }
    if (changed && user) emit('difficulty', id);
    return id;
  }

  function partnerName() {
    try {
      if (PG.game && PG.game.char && PG.game.char.partnerCn) return PG.game.char.partnerCn;
    } catch (e) {}
    const c = D.chars[D.sel];
    if (c && c.partnerCn) return c.partnerCn;
    return '灵兽';
  }
  function gameState() {
    try {
      return (PG.game && PG.game.state) || {};
    } catch (e) {
      return {};
    }
  }
  function rankOf(score, win) {
    if (!win) return '';
    if (score >= 14000) return 'S';
    if (score >= 9000) return 'A';
    if (score >= 5500) return 'B';
    if (score >= 2500) return 'C';
    return 'D';
  }
  function renderResult(kind) {
    const R = D.res[kind];
    if (!R) return;
    const g = gameState();
    const r = D.result || {};
    const win = kind === 'win';
    const total = Math.max(1, Math.round(num(r.waveTotal, num(g.waveTotal, 8))));
    let wave = Math.round(num(r.wave, num(g.wave, win ? total : 1)));
    wave = clamp(wave, 0, total);
    const score = Math.round(num(r.score, num(g.score, 0)));
    const combo = Math.round(num(r.comboMax, num(g.comboMax, 0)));
    const time = num(r.time, num(g.time, 0));

    R.kicker.textContent = win ? ('第 ' + total + ' 波 · 混沌之核已净化') : ('第 ' + Math.max(1, wave) + ' 波 · 山海古径');
    R.refs.wave.textContent = wave + ' / ' + total;
    R.refs.score.textContent = group(score);
    R.refs.combo.textContent = 'x' + combo;
    R.refs.time.textContent = fmtTime(time);
    const diffId = (typeof r.diff === 'string' && r.diff) || D.diffId;
    const diffMeta = DIFF_META.find((d) => d.id === diffId) || DIFF_META[0];
    if (R.diff) R.diff.textContent = '难度 · ' + diffMeta.cn;
    R.who.textContent = '「' + partnerName() + '」';
    R.text.textContent = win
      ? '成功了！山泽的暗影散了——多谢你，行者！'
      : '别灰心，行者……我们再试一次，山林还等着我们！';
    if (R.rank) {
      const rk = (typeof r.rank === 'string' && r.rank) || rankOf(score, win);
      R.rank.textContent = rk;
      R.rank.className = 'rank-stamp rank-' + String(rk).toLowerCase();
      R.rank.style.animation = 'none';
      void R.rank.offsetWidth;
      R.rank.style.animation = '';
    }
  }

  /* =============================== 流程动作 =============================== */
  function enterSelect() {
    screen('select');
    emit('start');
  }
  function doLaunch() {
    const c = D.chars[D.sel];
    if (!c) return;
    fx('ui_click');
    emit('launch', c.id);
    screen('game');
  }
  function doResume() {
    fx('ui_click');
    emit('resume');
    screen('game');
  }
  function doRestart() {
    fx('ui_click');
    emit('restart');
    screen('game');
  }
  function doQuit() {
    fx('ui_back');
    emit('quit');
    screen('title');
  }

  /* =============================== 启动屏控制 =============================== */
  function bootEl() {
    return document.getElementById('boot');
  }
  function showBoot() {
    const el = bootEl();
    if (!el) return;
    el.style.display = '';
    el.classList.remove('done');
    const fill = document.getElementById('boot-fill');
    if (fill) fill.style.width = '0%';
    const msg = document.getElementById('boot-msg');
    if (msg) msg.textContent = '正在进入山海秘境…';
  }
  function hideBoot() {
    const el = bootEl();
    if (el) el.style.display = 'none';
  }

  /* =============================== 屏幕切换 =============================== */
  function screen(name) {
    name = name == null ? 'hidden' : String(name);
    if (!D.mounted) {
      D.pending = name;
      return;
    }
    if (!D.scrs[name] && name !== 'game' && name !== 'hidden' && name !== 'boot') name = 'hidden';
    D.screen = name;
    document.body.setAttribute('data-screen', name);

    for (const k in D.scrs) {
      const el = D.scrs[k];
      const on2 = k === name;
      el.classList.toggle('on', on2);
      el.classList.remove('anim');
      if (on2) {
        void el.offsetWidth;
        el.classList.add('anim');
      }
    }
    if (name === 'boot') {
      showBoot();
      return;
    }
    hideBoot();
    if (name === 'select') {
      ensureCards(false);
      renderSelFoot();
      setDifficulty(D.diffId, false);
    } else if (name === 'pause') {
      setDifficulty(D.diffId, false);
    } else if (name === 'dead' || name === 'win') {
      renderResult(name);
    }
  }

  /* =============================== 键盘操作 =============================== */
  function onKey(e) {
    if (!D.mounted) return;
    const scr = D.screen;
    if (scr !== 'title' && scr !== 'select' && scr !== 'pause' && scr !== 'dead' && scr !== 'win') return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.key;
    let used = false;

    if (scr === 'title') {
      if (k === 'Enter' || k === ' ' || k === 'Spacebar') {
        enterSelect();
        used = true;
      }
    } else if (scr === 'select') {
      if (k === 'ArrowLeft' || k === 'a' || k === 'A') {
        selectChar(D.sel - 1, true);
        used = true;
      } else if (k === 'ArrowRight' || k === 'd' || k === 'D') {
        selectChar(D.sel + 1, true);
        used = true;
      } else if (k >= '1' && k <= '9') {
        const i = Number(k) - 1;
        if (i >= 0 && i < D.chars.length) {
          selectChar(i, true);
          used = true;
        }
      } else if (k === 'Enter' || k === ' ') {
        doLaunch();
        used = true;
      } else if (k === 'Escape') {
        fx('ui_back');
        screen('title');
        used = true;
      }
    } else if (scr === 'pause') {
      if (k === 'Escape' || k === 'Enter' || k === 'p' || k === 'P') {
        doResume();
        used = true;
      } else if (k === 'r' || k === 'R') {
        doRestart();
        used = true;
      }
    } else if (scr === 'dead' || scr === 'win') {
      if (k === 'Enter' || k === ' ' || k === 'r' || k === 'R') {
        doRestart();
        used = true;
      } else if (k === 'Escape') {
        doQuit();
        used = true;
      }
    }
    if (used) {
      e.preventDefault();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      else e.stopPropagation();
    }
  }

  /* =============================== Hover 音效 =============================== */
  function onHover(e) {
    const t = e.target;
    if (!t || !t.closest) return;
    const hit = t.closest('.ui-btn, .char-card, .ui-chip');
    if (!hit || hit === D.hoverEl) return;
    D.hoverEl = hit;
    const now = Date.now();
    if (now - D.hoverAt < 70) return;
    D.hoverAt = now;
    fx('ui_hover');
  }
  function onOut(e) {
    const rt = e.relatedTarget;
    if (!rt || !rt.closest || !rt.closest('.ui-btn, .char-card, .ui-chip')) D.hoverEl = null;
  }

  /* ================================ 挂载 ================================ */
  function mount(rootEl) {
    if (D.mounted) return;
    const root = rootEl || document.getElementById('ui');
    if (!root) return;
    D.root = root;

    // 音量初值（audio 可能还没 init，拿不到就用默认）
    try {
      if (PG.audio && typeof PG.audio.getVolume === 'function') {
        const v = PG.audio.getVolume();
        if (typeof v === 'number' && isFinite(v) && v >= 0) D.volume = clamp(v, 0, 1);
      }
    } catch (e) {}

    const layer = mk('div', 'ui-screens', root);
    D.layer = layer;
    const builders = { title: buildTitle, select: buildSelect, pause: buildPause, dead: () => buildResult('dead'), win: () => buildResult('win') };
    for (const k in builders) {
      const el = builders[k]();
      layer.appendChild(el);
      D.scrs[k] = el;
    }

    D.mounted = true;
    syncSettings();
    ensureCards(true);
    renderSelFoot();
    for (const k in D.scrs) D.scrs[k].classList.remove('on');
    D.screen = 'hidden';
    document.body.setAttribute('data-screen', 'hidden');

    window.addEventListener('keydown', onKey, true);
    layer.addEventListener('pointerover', onHover);
    layer.addEventListener('pointerout', onOut);

    if (D.pending) {
      const p = D.pending;
      D.pending = null;
      screen(p);
    }
  }

  /* ============================== 对外方法 ============================== */
  function setCharacters(list) {
    if (!Array.isArray(list) || !list.length) return;
    D.chars = list.filter(Boolean);
    if (D.chars.length > 8) D.chars = D.chars.slice(0, 8);
    const idx = D.chars.findIndex((c) => c.id === D.selId);
    D.sel = idx >= 0 ? idx : 0;
    D.selId = D.chars[D.sel] ? D.chars[D.sel].id : null;
    if (D.mounted) {
      ensureCards(true);
      renderSelFoot();
    }
  }
  function setResult(data) {
    if (!data || typeof data !== 'object') return;
    const base = D.result || {};
    for (const k in data) if (data[k] !== undefined) base[k] = data[k];
    D.result = base;
    if (D.screen === 'dead' || D.screen === 'win') renderResult(D.screen);
  }

  /* ============================ HUD 兜底与 toast ============================
     80-hud.js 先于本文件加载；若它缺失/抛错，至少保证 90-main.js 调用的 HUD 方法
     全部存在（空操作或极简 DOM 版本），避免一处出错整屏白掉。 */
  function fallbackToast(text, ms) {
    try {
      let el = document.getElementById('ui-fb-toast');
      if (!el) {
        el = mk('div', '', document.body);
        el.id = 'ui-fb-toast';
        el.style.cssText = 'position:fixed;left:50%;bottom:16%;transform:translateX(-50%);z-index:80;' +
          'padding:9px 20px;border-radius:999px;background:#e8b33a;color:#24313f;' +
          'font:900 13px/1.4 var(--ui-font,sans-serif);letter-spacing:.08em;' +
          'box-shadow:0 6px 18px rgba(36,49,63,.28);pointer-events:none;opacity:0;transition:opacity .2s';
      }
      el.textContent = text || '';
      el.style.opacity = '1';
      clearTimeout(el._t);
      el._t = setTimeout(() => { el.style.opacity = '0'; }, Math.max(600, ms || 1600));
    } catch (e) {}
  }
  function installHudFallbacks() {
    const noop = function () {};
    const fb = {
      hud: noop,
      hudVisible: noop,
      setCrosshair: noop,
      setAmmoWarn: noop,
      hitmarker: noop,
      damageFrom: noop,
      killfeed: noop,
      damageNumber: noop,
      fps: noop,
      hurtFlash: noop,
      setObjectives: noop,
      banner: (title, sub) => fallbackToast([title, sub].filter(Boolean).join(' · '), 2000),
      subtitle: (who, text) => fallbackToast([who, text].filter(Boolean).join('：'), 2600),
      toast: fallbackToast,
      isTouch: () => false,
    };
    for (const k in fb) if (typeof ui[k] !== 'function') ui[k] = fb[k];
  }
  installHudFallbacks();

  ui.mount = mount;
  ui.screen = screen;
  ui.setCharacters = setCharacters;
  ui.on = on;
  ui.setResult = setResult;
  ui.setDifficulty = function (id) { return setDifficulty(id, false); };
  ui.getDifficulty = function () { return D.diffId; };
  ui.setSens = function (v) {
    const n = Number(v);
    D.sens = clamp(isFinite(n) && n > 0 ? n : 1, 0.6, 1.6);
    if (D.sensRange) {
      D.sensRange.value = String(Math.round(D.sens * 100));
      D.sensRange.style.setProperty('--vol', ((Math.round(D.sens * 100) - 60) / 100).toFixed(3));
      if (D.sensVal) D.sensVal.textContent = D.sensRange.value + '%';
    }
    return D.sens;
  };
  if (!ui.getScreen) {
    ui.getScreen = function () {
      return D.screen;
    };
  }
})();
