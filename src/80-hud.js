/* 80-hud.js — 战斗 HUD、准星、飘字、击杀信息、触屏控制（Lead） */
(() => {
  const PG = (window.PG = window.PG || {});
  const ui = (PG.ui = PG.ui || {});
  const $ = (tag, cls, parent) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (parent) parent.appendChild(el);
    return el;
  };
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  const D = { ready: false, root: null, el: {}, last: {}, touch: null, isTouch: false, dmgPool: [], dmgIdx: 0, arcs: [] };

  function isTouchDevice() {
    return (('ontouchstart' in window) || (navigator.maxTouchPoints > 0)) && window.matchMedia('(pointer: coarse)').matches;
  }

  function ensureDom() {
    if (D.ready) return;
    const root = document.getElementById('ui');
    if (!root) return;
    D.root = root;
    const hud = $('div', 'hud', root);
    D.el.hud = hud;

    // ---- 顶部：波次 ----
    const top = $('div', 'hud-top', hud);
    const waveBox = $('div', 'hud-wave', top);
    D.el.waveNum = $('div', 'hud-wave-n', waveBox);
    const waveMeta = $('div', 'hud-wave-meta', waveBox);
    D.el.waveName = $('span', 'hud-wave-label', waveMeta);
    D.el.waveLeft = $('span', 'hud-wave-left', waveMeta);

    // BOSS 血条
    const boss = $('div', 'hud-boss', hud);
    D.el.boss = boss;
    D.el.bossName = $('div', 'hud-boss-name', boss);
    const bossTrack = $('div', 'hud-boss-track', boss);
    D.el.bossFill = $('i', '', bossTrack);
    D.el.bossGhost = $('i', 'ghost', bossTrack);

    // ---- 左上：目标 ----
    const obj = $('div', 'hud-obj', hud);
    D.el.obj = obj;
    D.el.objList = $('ul', 'hud-obj-list', obj);

    // ---- 右上：分数 / 连击 / 击杀信息 ----
    const right = $('div', 'hud-right', hud);
    const scoreBox = $('div', 'hud-score', right);
    D.el.scoreV = $('div', 'hud-score-v', scoreBox);
    D.el.scoreL = $('div', 'hud-score-l', scoreBox);
    D.el.combo = $('div', 'hud-combo', hud);
    D.el.comboN = $('span', 'hud-combo-n', D.el.combo);
    D.el.comboL = $('span', 'hud-combo-l', D.el.combo);
    D.el.feed = $('div', 'hud-feed', right);

    // ---- 左下：行者 ----
    const player = $('div', 'hud-player', hud);
    const pcard = $('div', 'hud-pcard', player);
    D.el.avatar = $('div', 'hud-avatar', pcard);
    const pmid = $('div', 'hud-pmid', pcard);
    const prow = $('div', 'hud-prow', pmid);
    D.el.pname = $('div', 'hud-pname', prow);
    D.el.phpNum = $('div', 'hud-php-num', prow);
    const ptrack = $('div', 'hud-ptrack', pmid);
    D.el.phpBar = $('i', '', ptrack);
    const psub = $('div', 'hud-psub', pmid);
    D.el.partner = $('span', 'hud-partner', psub);
    D.el.dash = $('span', 'hud-dash', psub);

    // ---- 右下：弹药 ----
    const ammo = $('div', 'hud-ammo', hud);
    D.el.ammoBox = ammo;
    D.el.weapon = $('div', 'hud-weapon', ammo);
    const arow = $('div', 'hud-arow', ammo);
    D.el.ammoN = $('div', 'hud-ammo-n', arow);
    D.el.ammoMax = $('div', 'hud-ammo-max', arow);
    const pips = $('div', 'hud-pips', ammo);
    D.el.pips = pips;
    D.el.reload = $('div', 'hud-reload', ammo);
    D.el.reloadBar = $('i', '', D.el.reload);
    D.el.ammoWarn = $('div', 'hud-ammowarn', ammo);

    // ---- 中央：准星 / 命中 / 受击弧 ----
    const cross = $('div', 'hud-cross', hud);
    D.el.cross = cross;
    ['t', 'r', 'b', 'l'].forEach((k) => { D.el['cross' + k] = $('i', 'hud-cross-' + k, cross); });
    D.el.crossDot = $('i', 'hud-cross-dot', cross);
    D.el.hit = $('div', 'hud-hit', hud);
    ['a', 'b', 'c', 'd'].forEach((k) => $('i', k, D.el.hit));
    D.el.arcs = $('div', 'hud-arcs', hud);

    // ---- 底部：字幕 / 提示 / 横幅 ----
    D.el.sub = $('div', 'hud-sub', hud);
    D.el.subWho = $('div', 'hud-sub-who', D.el.sub);
    D.el.subText = $('div', 'hud-sub-text', D.el.sub);
    D.el.banner = $('div', 'hud-banner', hud);
    D.el.bannerT = $('div', 'hud-banner-t', D.el.banner);
    D.el.bannerS = $('div', 'hud-banner-s', D.el.banner);
    D.el.toast = $('div', 'hud-toast', hud);
    D.el.fps = $('div', 'hud-fps', hud);
    D.el.dmg = $('div', 'hud-dmgnums', hud);

    // ---- 全屏受伤/低血量暗角 ----
    D.el.vig = $('div', 'hud-vignette', hud);
    D.el.hurtFx = $('div', 'hud-hurtfx', hud);

    // ---- 全屏受伤 / 低血量暗角 ----
    D.el.vig = $('div', 'hud-vignette', hud);
    D.el.hurtFx = $('div', 'hud-hurtfx', hud);

    // ---- 触屏 ----
    D.isTouch = isTouchDevice();
    if (D.isTouch) {
      hud.classList.add('hud-touch');
      buildTouch(hud);
    }

    // 初始隐藏
    D.el.boss.classList.remove('on');
    D.ready = true;
  }

  // ---------------- 触屏 ----------------
  function buildTouch(hud) {
    const wrap = $('div', 'hud-touchpad', hud);
    // 摇杆
    const stick = $('div', 'hud-stick', wrap);
    const base = $('div', 'hud-stick-base', stick);
    const nub = $('div', 'hud-stick-nub', stick);
    D.el.stick = stick; D.el.nub = nub;
    // 按钮
    const btns = $('div', 'hud-tbtns', wrap);
    const mk = (cls, label, sub) => {
      const b = $('button', 'hud-tbtn ' + cls, btns);
      b.type = 'button';
      b.textContent = label;
      if (sub) { const s = $('span', 'hud-tbtn-sub', b); s.textContent = sub; }
      return b;
    };
    D.el.tFire = mk('t-fire', '开火');
    D.el.tReload = mk('t-reload', '装填');
    D.el.tDash = mk('t-dash', '冲刺');
    D.el.tJump = mk('t-jump', '跳跃');
    D.el.tUlt = mk('t-ult', '灵兽技');

    const st = (ui.touchState = { mx: 0, mz: 0, fire: false, lookDx: 0, lookDy: 0, dash: false, jump: false, reload: false, ult: false });
    let stickId = null, stickCx = 0, stickCy = 0;
    const R = 54;

    const onDown = (e) => {
      const t = e.changedTouches ? e.changedTouches[0] : e;
      if (e.target.closest && e.target.closest('.hud-tbtn')) return;
      if (t.clientX > window.innerWidth * 0.45) return;
      stickId = t.identifier != null ? t.identifier : 'mouse';
      stickCx = t.clientX; stickCy = t.clientY;
      stick.classList.add('on');
      stick.style.left = stickCx + 'px';
      stick.style.top = stickCy + 'px';
      e.preventDefault();
    };
    const onMove = (e) => {
      const list = e.changedTouches ? Array.from(e.changedTouches) : [e];
      for (const t of list) {
        const id = t.identifier != null ? t.identifier : 'mouse';
        if (id !== stickId) continue;
        let dx = t.clientX - stickCx, dy = t.clientY - stickCy;
        const l = Math.hypot(dx, dy);
        if (l > R) { dx = (dx / l) * R; dy = (dy / l) * R; }
        nub.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
        st.mx = dx / R;
        st.mz = -dy / R;
        e.preventDefault();
      }
    };
    const onUp = (e) => {
      const list = e.changedTouches ? Array.from(e.changedTouches) : [e];
      for (const t of list) {
        const id = t.identifier != null ? t.identifier : 'mouse';
        if (id !== stickId) continue;
        stickId = null;
        stick.classList.remove('on');
        nub.style.transform = 'translate(0,0)';
        st.mx = 0; st.mz = 0;
      }
    };
    wrap.addEventListener('touchstart', onDown, { passive: false });
    wrap.addEventListener('touchmove', onMove, { passive: false });
    wrap.addEventListener('touchend', onUp);
    wrap.addEventListener('touchcancel', onUp);

    // 右侧滑动视角
    let lookId = null, lookX = 0, lookY = 0;
    const lookStart = (e) => {
      const t = e.changedTouches ? e.changedTouches[0] : e;
      if (e.target.closest && e.target.closest('.hud-tbtn')) return;
      if (t.clientX <= window.innerWidth * 0.45) return;
      lookId = t.identifier != null ? t.identifier : 'mouse';
      lookX = t.clientX; lookY = t.clientY;
    };
    const lookMove = (e) => {
      const list = e.changedTouches ? Array.from(e.changedTouches) : [e];
      for (const t of list) {
        const id = t.identifier != null ? t.identifier : 'mouse';
        if (id !== lookId) continue;
        st.lookDx += (t.clientX - lookX) * 1.6;
        st.lookDy += (t.clientY - lookY) * 1.6;
        lookX = t.clientX; lookY = t.clientY;
        e.preventDefault();
      }
    };
    const lookEnd = (e) => {
      const list = e.changedTouches ? Array.from(e.changedTouches) : [e];
      for (const t of list) { const id = t.identifier != null ? t.identifier : 'mouse'; if (id === lookId) lookId = null; }
    };
    wrap.addEventListener('touchstart', lookStart, { passive: false });
    wrap.addEventListener('touchmove', lookMove, { passive: false });
    wrap.addEventListener('touchend', lookEnd);

    const bindHold = (el, key) => {
      el.addEventListener('touchstart', (e) => { st[key] = true; el.classList.add('on'); e.preventDefault(); e.stopPropagation(); }, { passive: false });
      el.addEventListener('touchend', (e) => { st[key] = false; el.classList.remove('on'); e.preventDefault(); e.stopPropagation(); });
      el.addEventListener('touchcancel', () => { st[key] = false; el.classList.remove('on'); });
    };
    bindHold(D.el.tFire, 'fire');
    const tap = (el, key) => {
      el.addEventListener('touchstart', (e) => { st[key] = true; el.classList.add('on'); e.preventDefault(); e.stopPropagation(); }, { passive: false });
      el.addEventListener('touchend', (e) => { el.classList.remove('on'); e.preventDefault(); e.stopPropagation(); });
    };
    tap(D.el.tReload, 'reload'); tap(D.el.tDash, 'dash'); tap(D.el.tJump, 'jump'); tap(D.el.tUlt, 'ult');
  }

  // ---------------- HUD 更新 ----------------
  function segBar(fillEl, ratio, cls) {
    // 用 CSS 变量做宽度，避免重排长列表
    fillEl.style.transform = 'scaleX(' + clamp(ratio, 0, 1).toFixed(3) + ')';
    if (cls) fillEl.parentNode.className = cls;
  }

  ui.hurtFlash = function (power) {
    ensureDom();
    if (!D.ready) return;
    const el = D.el.hurtFx;
    el.style.transition = 'none';
    el.style.opacity = String(Math.min(1, 0.35 + (power || 0.3)));
    void el.offsetWidth;
    el.style.transition = 'opacity .5s ease';
    el.style.opacity = '0';
  };

  ui.hurtFlash = function (power) {
    ensureDom();
    if (!D.ready || !D.el.hurtFx) return;
    const el = D.el.hurtFx;
    el.style.transition = 'none';
    el.style.opacity = String(Math.min(1, 0.35 + (power || 0.3)));
    void el.offsetWidth;
    el.style.transition = 'opacity .5s ease';
    el.style.opacity = '0';
  };

  ui.hud = function (s) {
    ensureDom();
    if (!D.ready || !s) return;
    const L = D.last;
    // 血条
    const hpRatio = clamp(s.hp / (s.hpMax || 100), 0, 1);
    if (L.hp !== s.hp || L.hpMax !== s.hpMax) {
      L.hp = s.hp; L.hpMax = s.hpMax;
      D.el.phpBar.style.transform = 'scaleX(' + hpRatio.toFixed(3) + ')';
      D.el.phpNum.textContent = Math.max(0, Math.ceil(s.hp));
      const crit = hpRatio < 0.3;
      D.el.phpBar.parentNode.parentNode.classList.toggle('crit', crit);
      D.el.avatar.classList.toggle('hurt', crit);
      if (D.el.vig) D.el.vig.classList.toggle('on', crit);
      D.el.vig.classList.toggle('on', crit);
    }
    if (L.wave !== s.wave) {
      L.wave = s.wave;
      D.el.waveNum.textContent = '第 ' + s.wave + ' 波';
      D.el.waveName.textContent = '共 ' + s.waveTotal + ' 波';
    }
    if (L.left !== s.enemiesLeft) {
      L.left = s.enemiesLeft;
      D.el.waveLeft.textContent = s.enemiesLeft > 0 ? '剩余 ' + s.enemiesLeft : '已清空';
    }
    if (L.score !== s.score) {
      L.score = s.score;
      D.el.scoreV.textContent = String(s.score).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }
    // 连击
    const combo = s.combo || 0;
    if (L.combo !== combo) {
      L.combo = combo;
      D.el.combo.classList.toggle('on', combo >= 3);
      D.el.comboN.textContent = 'x' + Math.max(1, combo);
      D.el.combo.classList.toggle('hot', combo >= 15);
    }
    // 弹药
    if (L.ammo !== s.ammo || L.ammoMax !== s.ammoMax) {
      L.ammo = s.ammo; L.ammoMax = s.ammoMax;
      D.el.ammoN.textContent = s.ammo;
      D.el.ammoMax.textContent = '/ ' + s.ammoMax;
      const low = s.ammo <= Math.ceil(s.ammoMax * 0.25);
      D.el.ammoBox.classList.toggle('low', low);
      renderPips(s.ammo, s.ammoMax);
    }
    if (L.weapon !== s.weaponName) {
      L.weapon = s.weaponName;
      D.el.weapon.textContent = s.weaponName || '';
    }
    if (s.weaponColor && L.color !== s.weaponColor) {
      L.color = s.weaponColor;
      D.el.ammoBox.style.setProperty('--acc', s.weaponColor);
    }
    // 装填
    if (L.reloading !== s.reloading || (s.reloading && Math.abs((L.reloadT || 0) - s.reloadT) > 0.05)) {
      L.reloading = s.reloading; L.reloadT = s.reloadT;
      D.el.reload.classList.toggle('on', !!s.reloading);
      if (s.reloading) D.el.reloadBar.style.transform = 'scaleX(' + clamp(s.reloadT, 0, 1).toFixed(3) + ')';
    }
    // 冲刺 CD
    if (!L.dashInit || Math.abs(L.dashCd - s.dashCd) > 0.02) {
      L.dashCd = s.dashCd; L.dashInit = true;
      const ready = s.dashCd <= 0.001;
      D.el.dash.textContent = ready ? '冲刺就绪' : '冲刺 ' + s.dashCd.toFixed(1) + 's';
      D.el.dash.classList.toggle('ready', ready);
    }
    // BOSS
    if (s.boss) {
      if (!L.bossOn) { L.bossOn = true; D.el.boss.classList.add('on'); D.el.bossName.textContent = s.boss.name; }
      const r = clamp(s.boss.hp / (s.boss.hpMax || 1), 0, 1);
      D.el.bossFill.style.transform = 'scaleX(' + r.toFixed(3) + ')';
      if (L.bossGhost === undefined || r < L.bossGhost - 0.002) { L.bossGhost = L.bossGhost === undefined ? r : Math.max(r, L.bossGhost - 0.004); }
      D.el.bossGhost.style.transform = 'scaleX(' + clamp(L.bossGhost, 0, 1).toFixed(3) + ')';
      D.el.boss.classList.toggle('phase2', r < 0.5);
    } else if (L.bossOn) {
      L.bossOn = false;
      D.el.boss.classList.remove('on');
    }
    // 时间 / FPS
    if (s.time !== undefined) {
      const t = Math.floor(s.time);
      if (L.time !== t) { L.time = t; D.el.fps.textContent = '时间 ' + String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); }
    }
  };

  let pipsKey = '';
  function renderPips(ammo, max) {
    const key = ammo + '/' + max;
    if (key === pipsKey) return;
    pipsKey = key;
    const n = Math.min(24, max);
    let html = '';
    for (let i = 0; i < n; i++) {
      const on = i < Math.round((ammo / max) * n);
      html += '<i class="' + (on ? 'on' : '') + '"></i>';
    }
    D.el.pips.innerHTML = html;
  }

  ui.setCrosshair = function (mode, spread) {
    ensureDom();
    if (!D.ready) return;
    const el = D.el.cross;
    el.classList.toggle('off', mode === 0);
    const s = 5 + (spread || 0) * 12;
    D.el.crosst.style.transform = 'translate(-50%,-50%) translateY(' + (-s) + 'px)';
    D.el.crossb.style.transform = 'translate(-50%,-50%) translateY(' + s + 'px)';
    D.el.crossl.style.transform = 'translate(-50%,-50%) translateX(' + (-s) + 'px)';
    D.el.crossr.style.transform = 'translate(-50%,-50%) translateX(' + s + 'px)';
  };

  ui.setAmmoWarn = function (on) {
    ensureDom();
    if (!D.ready) return;
    D.el.ammoWarn.classList.toggle('on', !!on);
  };

  let hitT = 0;
  ui.hitmarker = function (kind) {
    ensureDom();
    if (!D.ready) return;
    const el = D.el.hit;
    el.className = 'hud-hit on ' + (kind === 'crit' ? 'crit' : kind === 'kill' ? 'kill' : '');
    clearTimeout(hitT);
    hitT = setTimeout(() => { el.className = 'hud-hit'; }, 130);
  };

  ui.damageFrom = function (angle) {
    ensureDom();
    if (!D.ready) return;
    const arc = $('div', 'hud-arc', D.el.arcs);
    arc.style.transform = 'translate(-50%,-50%) rotate(' + (angle * 180 / Math.PI) + 'deg)';
    arc.innerHTML = '<svg viewBox="0 0 200 200"><path d="M100 8 A92 92 0 0 1 168 40" /></svg>';
    setTimeout(() => { arc.classList.add('out'); setTimeout(() => arc.remove(), 500); }, 40);
  };

  ui.killfeed = function (text, kind) {
    ensureDom();
    if (!D.ready) return;
    const li = $('div', 'hud-fl ' + (kind || ''), D.el.feed);
    li.textContent = text;
    D.el.feed.appendChild(li);
    setTimeout(() => li.classList.add('out'), 2200);
    setTimeout(() => li.remove(), 2900);
    while (D.el.feed.children.length > 5) D.el.feed.firstChild.remove();
  };

  ui.damageNumber = function (sx, sy, text, kind) {
    ensureDom();
    if (!D.ready) return;
    let el = D.dmgPool[D.dmgIdx];
    if (!el) {
      el = $('div', 'hud-dnum', D.el.dmg);
      D.dmgPool[D.dmgIdx] = el;
    }
    D.dmgIdx = (D.dmgIdx + 1) % 28;
    el.className = 'hud-dnum ' + (kind || 'dmg');
    el.textContent = text;
    el.style.left = sx + 'px';
    el.style.top = sy + 'px';
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
    el.classList.add('go');
    el.style.setProperty('--dx', (Math.random() * 40 - 20).toFixed(0) + 'px');
  };

  ui.setObjectives = function (list) {
    ensureDom();
    if (!D.ready) return;
    D.el.objList.innerHTML = '';
    (list || []).forEach((o) => {
      const li = $('li', 'hud-obj-item' + (o.done ? ' done' : ''), D.el.objList);
      const dot = $('i', 'hud-obj-dot', li);
      const tx = $('span', '', li);
      tx.textContent = o.text;
    });
    D.el.obj.classList.toggle('on', !!(list && list.length));
  };

  let bannerT = null;
  ui.banner = function (title, sub, ms) {
    ensureDom();
    if (!D.ready) return;
    D.el.bannerT.textContent = title || '';
    D.el.bannerS.textContent = sub || '';
    D.el.banner.className = 'hud-banner on';
    clearTimeout(bannerT);
    bannerT = setTimeout(() => { D.el.banner.className = 'hud-banner'; }, ms || 2200);
  };

  let toastT = null;
  ui.toast = function (text, ms) {
    ensureDom();
    if (!D.ready) return;
    D.el.toast.textContent = text;
    D.el.toast.className = 'hud-toast on';
    clearTimeout(toastT);
    toastT = setTimeout(() => { D.el.toast.className = 'hud-toast'; }, ms || 1600);
  };

  let subT = null;
  ui.subtitle = function (who, text, ms) {
    ensureDom();
    if (!D.ready) return;
    D.el.subWho.textContent = who || '';
    D.el.subText.textContent = text || '';
    D.el.sub.className = 'hud-sub on';
    clearTimeout(subT);
    subT = setTimeout(() => { D.el.sub.className = 'hud-sub'; }, ms || 3000);
  };

  ui.fps = function (v) {
    ensureDom();
    if (!D.ready) return;
    D.el.fps.textContent = (D.el.fps.textContent === '' ? '' : '');
    // 只在有调试参数时显示
    if (!D.showFps) return;
    D.el.fps.textContent = v.toFixed(0) + ' FPS';
  };
  if (new URLSearchParams(location.search).get('fps') === '1') {
    D.showFps = true;
    setTimeout(() => { ensureDom(); if (D.ready) D.el.fps.classList.add('on'); }, 300);
  }

  ui.isTouch = function () { return D.isTouch || isTouchDevice(); };

  ui.setAmmoWarnVisible = function (v) { ensureDom(); if (D.ready) D.el.ammoWarn.classList.toggle('on', !!v); };

  // 玩家卡：行者名 / 头像 / 灵兽标签（90-main.js 在开局时调用）
  ui.setPlayerCard = function (card) {
    ensureDom();
    if (!D.ready || !card || typeof card !== 'object') return;
    try {
      if (D.el.pname && card.cn) D.el.pname.textContent = card.cn;
      if (D.el.partner) D.el.partner.textContent = card.partnerCn ? '灵兽 ' + card.partnerCn : '';
      if (D.el.avatar && card.portrait && typeof card.portrait.toDataURL === 'function') {
        D.el.avatar.style.backgroundImage = 'url(' + card.portrait.toDataURL() + ')';
      }
      if (D.el.weapon && card.weapon) D.el.weapon.textContent = card.weapon;
    } catch (e) {}
  };

  // 隐藏 HUD（标题/选角时）
  ui.hudVisible = function (v) {
    ensureDom();
    if (!D.ready) return;
    D.el.hud.classList.toggle('on', !!v);
    D.el.hud.classList.toggle('is-on', !!v);
    D.el.hud.style.opacity = v ? '1' : '0';
    D.el.hud.style.visibility = v ? 'visible' : 'hidden';
  };
  // 初始隐藏：由 main 在进入战斗时通过 hudVisible(true) 打开，避免标题/选角屏出现 HUD 残影
  setTimeout(() => {
    ensureDom();
    if (D.ready) { D.el.hud.classList.remove('on'); D.el.hud.classList.remove('is-on'); D.el.hud.style.opacity = '0'; D.el.hud.style.visibility = 'hidden'; }
  }, 30);
})();
