/* 90-main.js — 启动、渲染器、光照、输入、标题展示、主循环与模块接线（Lead） */
(() => {
  const PG = (window.PG = window.PG || {});
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const TAU = Math.PI * 2;

  const E = {
    renderer: null, scene: null, camera: null, world: null, clock: 0, last: 0,
    mode: 'boot', titleT: 0, showcase: null, fpsAcc: 0, fpsFrames: 0, fps: 60,
    locked: false, started: false, bootT: 0, char: 't_bolt', canvas: null,
    sens: 1, diff: 'easy', lockTries: 0,
    err: [],
  };
  const Q = new URLSearchParams(location.search);

  function storeGet(k, fb) {
    try { const v = localStorage.getItem(k); return v == null ? fb : v; } catch (e) { return fb; }
  }
  function storeSet(k, v) {
    try { localStorage.setItem(k, String(v)); } catch (e) {}
  }
  // 难度：URL ?diff= 优先，其次本地记忆，默认悠然
  function applyDiff(id) {
    E.diff = (PG.game && PG.game.DIFFS && PG.game.DIFFS[id]) ? id : 'easy';
    try { PG.game && PG.game.setDifficulty && PG.game.setDifficulty(E.diff); } catch (e) {}
    try { PG.ui && PG.ui.setDifficulty && PG.ui.setDifficulty(E.diff); } catch (e) {}
    return E.diff;
  }
  function applySens(v) {
    const n = Number(v);
    E.sens = clamp(isFinite(n) && n > 0 ? n : 1, 0.6, 1.6);
    try { PG.game && PG.game.setSensitivity && PG.game.setSensitivity(E.sens); } catch (e) {}
    try { PG.ui && PG.ui.setSens && PG.ui.setSens(E.sens); } catch (e) {}
    return E.sens;
  }

  // ---------------- 输入 ----------------
  const keys = Object.create(null);
  const input = { mx: 0, mz: 0, dx: 0, dy: 0, fire: false, reload: false, jump: false, dash: false, ult: false };
  const edge = { reload: false, jump: false, dash: false, ult: false };

  function bindInput() {
    const canvas = E.canvas;
    window.addEventListener('keydown', (e) => {
      const k = e.code;
      keys[k] = true;
      if (k === 'KeyW' || k === 'KeyA' || k === 'KeyS' || k === 'KeyD' || k === 'Space') e.preventDefault();
      if (k === 'KeyR') edge.reload = true;
      if (k === 'Space') edge.jump = true;
      if (k === 'ShiftLeft' || k === 'ShiftRight') edge.dash = true;
      if (k === 'KeyQ') edge.ult = true;
      if (k === 'Escape') {
        if (E.mode === 'playing') doPause();
        else if (E.mode === 'paused') doResume();
      }
      if (k === 'Enter' && E.mode === 'title') {
        if (PG.ui && PG.ui.screen) PG.ui.screen('select');
        E.mode = 'select';
      }
    });
    window.addEventListener('keyup', (e) => { keys[e.code] = false; });
    window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; input.fire = false; });

    let dragLook = false;
    canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (E.mode === 'playing' && !E.locked && !isTouch()) {
        // 第一次点击只用来锁定指针，避免"还没瞄准就先打空一发"
        dragLook = true;
        if (E.lockTries < 1) { E.lockTries++; requestLock(); return; }
      }
      input.fire = true;
    });
    window.addEventListener('mouseup', () => { dragLook = false; });
    // 指针锁定不可用时的兜底：按住左键拖动也能转视角
    canvas.addEventListener('mousemove', (e) => {
      if (!E.locked && dragLook && E.mode === 'playing') {
        input.dx += e.movementX || 0;
        input.dy += e.movementY || 0;
      }
    });
    window.addEventListener('mouseup', (e) => { if (e.button === 0) input.fire = false; });
    window.addEventListener('mousemove', (e) => {
      if (E.locked && E.mode === 'playing') {
        input.dx += e.movementX || 0;
        input.dy += e.movementY || 0;
      }
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener('pointerlockchange', () => {
      E.locked = document.pointerLockElement === E.canvas;
      if (E.locked) E.lockTries = 0;
      if (!E.locked && E.mode === 'playing' && !isTouch()) doPause();
    });
    canvas.addEventListener('click', () => {
      if (E.mode === 'playing' && !E.locked && !isTouch()) requestLock();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && E.mode === 'playing') doPause();
    });
  }
  function requestLock() {
    try { const p = E.canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
  }
  function isTouch() {
    try { return !!(PG.ui && PG.ui.isTouch && PG.ui.isTouch()); } catch (e) { return false; }
  }

  // ---------------- 渲染器 / 场景 ----------------
  function initEngine() {
    const canvas = (E.canvas = document.getElementById('view'));
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    E.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xbde6ff);
    scene.fog = new THREE.Fog(0xcfeaff, 44, 140);
    E.scene = scene;
    const sky = skyGradient();
    scene.add(sky);
    E.sky = sky;

    const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.05, 400);
    camera.rotation.order = 'YXZ';
    camera.position.set(0, 2.3, 8.5);
    scene.add(camera);
    E.camera = camera;

    // 第一人称武器独立场景（永远盖在世界之上，不会被墙裁切）
    const vmScene = new THREE.Scene();
    const vmCamera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 12);
    vmScene.add(new THREE.HemisphereLight(0xffffff, 0x88aa99, 2.0));
    const vmKey = new THREE.DirectionalLight(0xfff2d8, 2.2);
    vmKey.position.set(0.8, 1.2, 0.9);
    vmScene.add(vmKey);
    const vmRim = new THREE.DirectionalLight(0x9fd8ff, 1.1);
    vmRim.position.set(-1.0, 0.4, -0.8);
    vmScene.add(vmRim);
    E.vmScene = vmScene;
    E.vmCamera = vmCamera;

    // ---- 光照：明亮阳光 ----
    const hemi = new THREE.HemisphereLight(0xdff3ff, 0x6f9a3e, 1.35);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff3d6, 2.35);
    sun.position.set(26, 34, 16);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 140;
    sun.shadow.camera.left = -55;
    sun.shadow.camera.right = 55;
    sun.shadow.camera.top = 55;
    sun.shadow.camera.bottom = -55;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.03;
    scene.add(sun);
    scene.add(sun.target);
    E.sun = sun;
    // 冷色补光，让轮廓更卡通
    const rim = new THREE.DirectionalLight(0x9fd8ff, 0.55);
    rim.position.set(-22, 14, -26);
    scene.add(rim);
  }

  function skyGradient() {
    // 竖直渐变天空（用大球内壁 + 顶点色）
    const geo = new THREE.SphereGeometry(190, 24, 16);
    const colors = [];
    const pos = geo.attributes.position;
    const top = new THREE.Color(0x4aa8e8), mid = new THREE.Color(0xbde6ff), bot = new THREE.Color(0xe8f7d8);
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / 190;
      let c;
      if (y > 0.15) c = mid.clone().lerp(top, clamp((y - 0.15) / 0.85, 0, 1));
      else c = bot.clone().lerp(mid, clamp((y + 0.1) / 0.25, 0, 1));
      colors.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false });
    const sky = new THREE.Mesh(geo, mat);
    sky.renderOrder = -10;
    return sky;
  }

  // ---------------- 标题展示 ----------------
  function buildShowcase() {
    if (E.showcase) return E.showcase;
    const g = new THREE.Group();
    g.name = 'showcase';
    const chars = PG.game.CHARS;
    const xs = [-3.9, -1.35, 1.35, 3.9];
    const list = [];
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      try {
        const tr = PG.models.makeTrainer(c.id);
        if (tr && tr.group) {
          tr.group.position.set(xs[i], 0, -0.4);
          tr.group.rotation.y = Math.PI + (i < 2 ? 0.18 : -0.18);
          g.add(tr.group);
          list.push({ model: tr, phase: i * 1.1, base: tr.group.position.clone(), kind: 'trainer' });
        }
      } catch (e) {}
      try {
        const pk = PG.models.make(c.partner);
        if (pk && pk.group) {
          const s = 0.85 / (pk.height || 0.8);
          pk.group.scale.setScalar(s);
          pk.group.position.set(xs[i] + (i % 2 === 0 ? 0.75 : -0.75), 0, 1.5);
          pk.group.rotation.y = Math.PI * 0.86;
          g.add(pk.group);
          list.push({ model: pk, phase: i * 0.7 + 0.4, base: pk.group.position.clone(), kind: 'beast' });
        }
      } catch (e) {}
    }
    E.scene.add(g);
    E.showcase = { group: g, list };
    return E.showcase;
  }
  function removeShowcase() {
    if (!E.showcase) return;
    E.scene.remove(E.showcase.group);
    try { PG.util.disposeTree(E.showcase.group); } catch (e) {}
    E.showcase = null;
  }
  function updateShowcase(dt, t) {
    if (!E.showcase) return;
    for (const it of E.showcase.list) {
      const m = it.model;
      if (!m || !m.group) continue;
      // 呼吸 + 轻微摇摆
      m.group.position.y = it.base.y + Math.sin(t * 1.6 + it.phase) * (it.kind === 'beast' ? 0.04 : 0.02);
      m.group.rotation.z = Math.sin(t * 0.9 + it.phase) * 0.02;
      if (m.update) { try { m.update(dt, t + it.phase); } catch (e) {} }
    }
  }

  // ---------------- 标题镜头 ----------------
  function titleCamera(dt) {
    E.titleT += dt;
    const cam = E.camera;
    const t = E.titleT;
    cam.position.set(Math.sin(t * 0.13) * 1.6, 2.45 + Math.sin(t * 0.21) * 0.12, 8.4 + Math.sin(t * 0.09) * 0.5);
    cam.lookAt(Math.sin(t * 0.16) * 0.3, 1.15 + Math.sin(t * 0.4) * 0.04, 0);
    cam.fov = lerp(cam.fov, 56, clamp(dt * 3, 0, 1));
    cam.updateProjectionMatrix();
  }

  // ---------------- 流程 ----------------
  function boot() {
    const fill = document.getElementById('boot-fill');
    const msg = document.getElementById('boot-msg');
    const bootEl = document.getElementById('boot');
    const steps = [
      [0.12, '正在唤醒山海秘境…'],
      [0.38, '召唤上古灵兽…'],
      [0.64, '编织森林光影…'],
      [0.86, '校准伏魔法器…'],
      [1.0, '准备就绪'],
    ];
    let i = 0;
    const tick = () => {
      if (i < steps.length) {
        if (fill) fill.style.width = Math.round(steps[i][0] * 100) + '%';
        if (msg) msg.textContent = steps[i][1];
        i++;
        setTimeout(tick, 190 + Math.random() * 120);
      } else {
        if (bootEl) { bootEl.classList.add('done'); setTimeout(() => { bootEl.style.display = 'none'; }, 800); }
        toTitle();
      }
    };
    tick();
  }

  function toTitle() {
    E.mode = 'title';
    E.titleT = 0;
    removeShowcase();
    buildShowcase();
    PG.ui && PG.ui.screen && PG.ui.screen('title');
    PG.ui && PG.ui.hudVisible && PG.ui.hudVisible(false);
    hideRotateTip();
    maybeShowRotateTip();
    PG.audio && PG.audio.music('title');
  }

  function toSelect() {
    E.mode = 'select';
    PG.audio && PG.audio.sfx('ui_click');
  }

  function startGame(charId) {
    E.char = charId || E.char;
    E.mode = 'playing';
    hideRotateTip();
    removeShowcase();
    PG.audio && PG.audio.init && PG.audio.init();
    PG.ui && PG.ui.screen && PG.ui.screen('game');
    PG.ui && PG.ui.hudVisible && PG.ui.hudVisible(true);
    // HUD 头像与名字
    try {
      const cd = (E.charData || []).find((c) => c.id === E.char);
      if (cd && PG.ui.setPlayerCard) PG.ui.setPlayerCard(cd);
      const av = document.querySelector('.hud-avatar');
      if (av && cd && cd.portrait) {
        av.style.backgroundImage = 'url(' + cd.portrait.toDataURL() + ')';
        const pn = document.querySelector('.hud-pname');
        if (pn) pn.textContent = cd.cn;
        const pt = document.querySelector('.hud-partner');
        if (pt) pt.textContent = '灵兽 ' + cd.partnerCn;
      }
    } catch (e) {}
    try { PG.game.init({ scene: E.scene, camera: E.camera, renderer: E.renderer, world: E.world, vmScene: E.vmScene, vmCamera: E.vmCamera }); } catch (e) {}
    PG.game.onEnd = (mode) => {
      E.mode = mode === 'win' ? 'win' : 'dead';
      if (document.pointerLockElement) document.exitPointerLock();
      try {
        const st = PG.game.state, pl = PG.game.player;
        const score = st.score || 0;
        const diff = PG.game.difficulty || { id: 'normal', cn: '标准' };
        const rank = PG.game.rankFor ? PG.game.rankFor(score, mode === 'win')
          : (mode === 'win' ? (score > 16000 ? 'S' : score > 11000 ? 'A' : 'B') : (score > 8000 ? 'B' : score > 4000 ? 'C' : 'D'));
        if (PG.ui && PG.ui.setResult) PG.ui.setResult({
          wave: st.wave, waveTotal: PG.game.WAVE_TOTAL, score: score,
          comboMax: st.comboMax, time: Math.round(st.time), kills: pl ? pl.kills : 0,
          hits: pl ? pl.hits : 0, shots: pl ? pl.shots : 0,
          rank: rank, win: mode === 'win',
          diff: diff.id, diffCn: diff.cn,
        });
      } catch (e) {}
      PG.ui && PG.ui.hudVisible && PG.ui.hudVisible(false);
      PG.ui && PG.ui.screen && PG.ui.screen(E.mode);
    };
    PG.game.start(E.char);
    if (!isTouch()) requestLock();
    PG.audio && PG.audio.music('battle');
  }

  function doPause() {
    if (E.mode !== 'playing') return;
    E.mode = 'paused';
    PG.game.pause();
    PG.ui && PG.ui.hudVisible && PG.ui.hudVisible(false);
    PG.ui && PG.ui.screen && PG.ui.screen('pause');
    PG.audio && PG.audio.setDuck && PG.audio.setDuck(0.35);
    input.fire = false;
    if (document.pointerLockElement) document.exitPointerLock();
  }
  function doResume() {
    if (E.mode !== 'paused') return;
    E.mode = 'playing';
    PG.game.resume();
    PG.ui && PG.ui.hudVisible && PG.ui.hudVisible(true);
    PG.ui && PG.ui.screen && PG.ui.screen('game');
    PG.audio && PG.audio.setDuck && PG.audio.setDuck(1);
    if (!isTouch()) requestLock();
  }
  function restartGame() {
    PG.ui && PG.ui.hudVisible && PG.ui.hudVisible(true);
    PG.ui && PG.ui.screen && PG.ui.screen('game');
    try { PG.game.init({ scene: E.scene, camera: E.camera, renderer: E.renderer, world: E.world, vmScene: E.vmScene, vmCamera: E.vmCamera }); } catch (e) {}
    PG.game.start(E.char);
    E.mode = 'playing';
    PG.audio && PG.audio.music('battle');
    if (!isTouch()) requestLock();
  }
  function quitToTitle() {
    PG.game.stop();
    PG.audio && PG.audio.setDuck && PG.audio.setDuck(1);
    toTitle();
  }

  function wireUI() {
    if (!PG.ui) return;
    PG.ui.mount && PG.ui.mount(document.getElementById('ui'));
    // 角色卡片数据
    try {
      const chars = PG.game.CHARS.map((c) => ({
        id: c.id, cn: c.cn, en: c.en, type: c.type, color: c.color,
        partner: c.partner, partnerCn: c.partnerCn,
        weapon: c.weapon, passive: c.passive, ult: c.ult,
        stats: { hp: c.hp / 120, dmg: clamp(c.gun.dmg * (c.gun.pellets || 1) / 50, 0.1, 1), rate: clamp(0.32 / c.gun.rate, 0.1, 1), spd: clamp((c.speed - 0.9) / 0.18, 0.15, 1) },
        portrait: (() => { try { return PG.models.portrait(c.id, 256); } catch (e) { return null; } })(),
        partnerIcon: (() => { try { return PG.models.icon(c.partner, 128); } catch (e) { return null; } })(),
      }));
      PG.ui.setCharacters && PG.ui.setCharacters(chars);
      E.charData = chars;
    } catch (e) {}

    PG.ui.on && PG.ui.on('start', () => { PG.audio && PG.audio.init && PG.audio.init(); toSelect(); });
    PG.ui.on && PG.ui.on('select', (id) => { E.char = id || E.char; });
    PG.ui.on && PG.ui.on('launch', (id) => startGame(id));
    PG.ui.on && PG.ui.on('difficulty', (id) => {
      applyDiff(id);
      storeSet('shfr.diff', E.diff);
      try { if (PG.ui.toast && PG.game.difficulty) PG.ui.toast('难度 · ' + PG.game.difficulty.cn, 1400); } catch (e) {}
    });
    PG.ui.on && PG.ui.on('sens', (v) => {
      applySens(v);
      storeSet('shfr.sens', E.sens);
    });
    PG.ui.on && PG.ui.on('resume', () => doResume());
    PG.ui.on && PG.ui.on('restart', () => restartGame());
    PG.ui.on && PG.ui.on('quit', () => quitToTitle());
    PG.ui.on && PG.ui.on('mute', (m) => { PG.audio && PG.audio.setMuted && PG.audio.setMuted(!!m); });
    PG.ui.on && PG.ui.on('volume', (v) => { PG.audio && PG.audio.setVolume && PG.audio.setVolume(v); });
  }

  // ---------------- 主循环 ----------------
  function loop(now) {
    requestAnimationFrame(loop);
    if (!E.last) E.last = now;
    let dt = (now - E.last) / 1000;
    E.last = now;
    dt = clamp(dt, 0, 0.05);
    E.clock += dt;
    const t = E.clock;

    // FPS
    E.fpsAcc += dt; E.fpsFrames++;
    if (E.fpsAcc >= 0.5) {
      E.fps = E.fpsFrames / E.fpsAcc;
      E.fpsAcc = 0; E.fpsFrames = 0;
      PG.ui && PG.ui.fps && PG.ui.fps(E.fps);
    }

    // 输入合成
    const touch = (PG.ui && PG.ui.touchState) || null;
    let mx = 0, mz = 0;
    if (keys.KeyW) mz += 1;
    if (keys.KeyS) mz -= 1;
    if (keys.KeyA) mx -= 1;
    if (keys.KeyD) mx += 1;
    if (touch) {
      if (typeof touch.mx === 'number') mx += touch.mx;
      if (typeof touch.mz === 'number') mz += touch.mz;
      if (touch.fire) input.fire = input.fire || touch.fire;
      if (touch.lookDx) { input.dx += touch.lookDx; touch.lookDx = 0; }
      if (touch.lookDy) { input.dy += touch.lookDy; touch.lookDy = 0; }
      if (touch.dash) { edge.dash = true; touch.dash = false; }
      if (touch.jump) { edge.jump = true; touch.jump = false; }
      if (touch.reload) { edge.reload = true; touch.reload = false; }
      if (touch.ult) { edge.ult = true; touch.ult = false; }
    }
    input.mx = mx; input.mz = mz;
    input.reload = edge.reload; edge.reload = false;
    input.dash = edge.dash; edge.dash = false;
    input.jump = edge.jump; edge.jump = false;
    input.ult = edge.ult; edge.ult = false;

    // 世界动画
    if (E.world && E.world.update) { try { E.world.update(dt, t, E.camera); } catch (e) {} }

    // HUD 只在游玩中显示（暂停/结算由各流程点显式隐藏）
    if (E.mode === 'playing' || E.mode === 'dead' || E.mode === 'win') {
      try { PG.game.update(dt, input); } catch (err) { reportErr(err); }
      input.dx = 0; input.dy = 0;
    } else if (E.mode === 'title' || E.mode === 'select') {
      titleCamera(dt);
      updateShowcase(dt, t);
    } else if (E.mode === 'paused') {
      try { PG.game.update(dt, {}); } catch (err) {}
    }

    // 玩家受击/准星松弛
    try {
      const st = PG.game.state;
      if (E.mode === 'playing' && PG.ui && PG.ui.setCrosshair) {
        const pl = PG.game.player;
        if (pl) {
          const f = PG.game.focusEnemy || null;
          PG.ui.setCrosshair(1, clamp(pl.bloom * 0.8 + (Math.hypot(pl.vel.x, pl.vel.z) / 40), 0, 1),
            f ? { on: true, kind: f.kind, alert: f.alert > 0 } : null);
        }
      }
    } catch (e) {}

    if (E.sky) { E.sky.position.copy(E.camera.position); }
    const R = E.renderer;
    R.autoClear = true;
    R.render(E.scene, E.camera);
    if (E.vmScene && E.vmScene.children.length > 3) {
      R.autoClear = false;
      R.clearDepth();
      R.render(E.vmScene, E.vmCamera);
      R.autoClear = true;
    }
  }

  // WebGL 不可用（老设备 / 关了硬件加速 / WebView 禁用 WebGL）时，直接 new WebGLRenderer
  // 会抛异常，屏幕上只剩一屏红色堆栈。先探测一次，给一张能看懂、能操作的说明卡。
  function webglAvailable() {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) return false;
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      return true;
    } catch (e) {
      return false;
    }
  }
  function showUnsupported() {
    try {
      const bootEl = document.getElementById('boot');
      if (bootEl) bootEl.style.display = 'none';
      const u = document.getElementById('unsupported');
      if (u) { u.classList.add('on'); return; }
    } catch (e) {}
    // 模板里没有兜底节点时，至少给一行可读文字，别留白屏
    const f = document.getElementById('fatal');
    if (f) { f.textContent = '当前环境不支持 WebGL，无法运行本作。请更换浏览器后重试。'; f.style.display = 'block'; }
  }

  // 竖屏手机提示一次「横过来」。只在标题/选角这类没有 HUD 的界面出现，
  // 战斗中不弹，避免挡住波次条与弹药；每次会话只提示一次，7 秒后自动消失。
  let rotateTipShown = false;
  function maybeShowRotateTip() {
    if (rotateTipShown) return;
    const tip = document.getElementById('rotate-tip');
    if (!tip) return;
    let touch = false;
    try { touch = !!(PG.ui && PG.ui.isTouch && PG.ui.isTouch()); } catch (e) {}
    if (!touch) {
      try {
        touch = (('ontouchstart' in window) || (navigator.maxTouchPoints > 0)) &&
          !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
      } catch (e) {}
    }
    if (!touch || window.innerHeight <= window.innerWidth) return;
    rotateTipShown = true;
    tip.classList.add('on');
    setTimeout(() => tip.classList.remove('on'), 7000);
  }
  function hideRotateTip() {
    const tip = document.getElementById('rotate-tip');
    if (tip) tip.classList.remove('on');
  }

  function reportErr(err) {
    const msg = (err && (err.stack || err.message)) || String(err);
    E.err.push(msg);
    if (window.console) console.error(err);
    // 面向玩家只给一句可读提示：真机上弹一屏红色堆栈，审核侧会直接按「页面报错、打不开」处理。
    // 完整堆栈仍保留在 console 与 E.err 中，?debug=1 时照常显示（playtest 读的就是 E.err）。
    const f = document.getElementById('fatal');
    if (!f) return;
    f.textContent = Q.get('debug') === '1'
      ? '运行错误：\n' + E.err.slice(-3).join('\n\n')
      : '运行出现了一点问题，请刷新页面重试。';
    f.style.display = 'block';
  }

  // ---------------- 启动 ----------------
  function boot2() {
    window.addEventListener('error', (e) => reportErr(e.error || new Error(e.message)));
    window.addEventListener('unhandledrejection', (e) => reportErr(e.reason));
    try {
      const unsupReload = document.getElementById('unsup-reload');
      if (unsupReload) unsupReload.addEventListener('click', () => { try { location.reload(); } catch (e) {} });
      // 没有 WebGL 直接给兜底页，别让它掉进 reportErr 变成一屏报错
      if (!webglAvailable()) {
        E.mode = 'unsupported';
        showUnsupported();
        return;
      }
      try {
        initEngine();
      } catch (e) {
        // 探测通过但上下文创建失败（驱动 / 显存 / WebView 限制），同样按「不支持」处理
        E.mode = 'unsupported';
        showUnsupported();
        if (window.console) console.warn('[main] WebGL 初始化失败', e);
        return;
      }
      // 世界
      try {
        E.world = PG.world.build(E.scene, THREE, { radius: 62, skipLights: true });
      } catch (e) {
        reportErr(e);
        E.world = { group: null, radius: 60, colliders: [], spawnPoints: [], groundY: () => 0, update() {}, reset() {} };
      }
      bindInput();
      wireUI();
      applyDiff(Q.get('diff') || storeGet('shfr.diff', 'easy'));
      applySens(storeGet('shfr.sens', '1'));
      // 尺寸
      const applyLayout = () => {
        E.camera.aspect = window.innerWidth / window.innerHeight;
        E.camera.updateProjectionMatrix();
        if (E.vmCamera) { E.vmCamera.aspect = E.camera.aspect; E.vmCamera.updateProjectionMatrix(); }
        E.renderer.setSize(window.innerWidth, window.innerHeight, false);
        E.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
        // 小屏整体缩放 HUD，避免遮挡视野
        const ui = document.getElementById('ui');
        if (ui) {
          const w = window.innerWidth, h = window.innerHeight;
          const s = Math.max(0.72, Math.min(1, Math.min(w / 1180, h / 760) * 1.02));
          ui.style.setProperty('--ui-scale', s.toFixed(3));
          document.body.classList.toggle('is-small', w < 900);
        }
        // 只在校外界面提示横屏；游戏内 HUD 占着顶部，不适合再叠一条提示
        if (document.body.getAttribute('data-screen') === 'title') maybeShowRotateTip();
      };
      const onResize = () => applyLayout();
      window.addEventListener('resize', onResize);
      applyLayout();

      if (Q.get('debug') === '1') {
        setTimeout(() => {
          try {
            const info = { mode: E.mode, enemies: (PG.game ? (PG.game.enemies || []) : []) };
            const f = document.getElementById('fatal');
            if (f) {
              f.style.display = 'block';
              f.textContent = 'DEBUG ' + JSON.stringify({
                mode: E.mode,
                game: PG.game && PG.game.getDebug ? PG.game.getDebug() : null,
                simSteps: E.simSteps, simSec: E.simSec,
                errs: E.err.slice(-3).map((x) => String(x).slice(0, 400)),
                player: PG.game && PG.game.player ? { hp: Math.round(PG.game.player.hp), kills: PG.game.player.kills, ammo: PG.game.player.ammo, score: PG.game.state.score } : null,
                state: PG.game && PG.game.state ? PG.game.state.mode : null,
                playerPos: PG.game && PG.game.player ? [PG.game.player.pos.x.toFixed(1), PG.game.player.pos.z.toFixed(1)] : null,
                worldRadius: E.world && E.world.radius,
                spawnPoints: E.world && E.world.spawnPoints ? E.world.spawnPoints.length : 0,
                children: E.scene.children.length,
                audio: PG.audio && PG.audio.isMuted ? PG.audio.isMuted() : null,
              }, null, 1);
            }
          } catch (e) { console.log(e); }
        }, 2500);
      }
      window.__PG_DEBUG = {
        E, PG, input,
        startGame,
        toTitle,
        select(id) {
          // 模拟完整 UI 流程：标题 → 选角 → 出发（QA 用）
          try {
            const chars = E.charData || [];
            const c = chars.find((x) => x.id === id) || chars[0];
            if (c) PG.ui.setCharacters && null;
            E.char = c ? c.id : id || E.char;
            startGame(E.char);
          } catch (e) { reportErr(e); }
        },
        key(code, type) {
          const ev = new KeyboardEvent(type || 'keydown', { code, key: code, bubbles: true, cancelable: true });
          window.dispatchEvent(ev);
        },
        sim(sec, opts) {
          opts = opts || {};
          const step = 1 / 60;
          const inp = { mx: 0, mz: opts.slow ? 0 : 0.15, dx: 0, dy: 0, fire: !!opts.fire, reload: false, jump: false, dash: false, ult: false };
          for (let i = 0; i < sec / step; i++) {
            try { PG.game.update(step, inp); } catch (err) { reportErr(err); break; }
          }
        },
        enemiesOnScreen() {
          const out = [];
          for (const e of PG.game.state ? [] : []) {}
          return out;
        },
      };

      // 自动进入（截图/QA 用）
      const auto = Q.get('auto');
      const autoChar = Q.get('char') || 't_bolt';
      E.char = autoChar;
      // 先同步建好展示物，避免首帧空
      buildShowcase();
      requestAnimationFrame((n) => { E.last = n; loop(n); });

      // ---- 直接打开某个界面（截图 / 调试用）----
      const scr = Q.get('screen');
      if (scr && !auto) {
        setTimeout(() => {
          try {
            if (scr === 'select') {
              E.mode = 'select';
              PG.ui && PG.ui.screen && PG.ui.screen('select');
            } else if (scr === 'pause') {
              startGame(autoChar);
              setTimeout(() => doPause(), 260);
            } else if (scr === 'dead' || scr === 'win') {
              startGame(autoChar);
              setTimeout(() => {
                E.mode = scr;
                PG.game.state.mode = scr;
                if (PG.ui && PG.ui.hudVisible) PG.ui.hudVisible(false);
                if (PG.ui && PG.ui.screen) PG.ui.screen(scr);
                if (PG.ui && PG.ui.setResult) PG.ui.setResult({ wave: 6, score: 12840, comboMax: 37, time: 512, kills: 96, rank: scr === 'win' ? 'S' : 'C' });
                if (document.pointerLockElement) document.exitPointerLock();
              }, 400);
            } else if (scr === 'title' || scr === 'boot') {
              if (scr === 'boot') {
                const b = document.getElementById('boot');
                if (b) { b.classList.remove('done'); b.style.display = 'flex'; }
                if (PG.ui && PG.ui.screen) PG.ui.screen('boot');
              } else {
                const b = document.getElementById('boot');
                if (b) { b.classList.add('done'); b.style.display = 'none'; }
                E.mode = 'title';
                E.titleT = 0;
                buildShowcase();
                if (PG.ui && PG.ui.screen) PG.ui.screen('title');
              }
            }
          } catch (e) { reportErr(e); }
        }, 500);
      }
      if (auto === '1' || auto === 'game') {
        setTimeout(() => {
          startGame(autoChar);
          if (Q.get('god') === '1' && PG.game.setGod) PG.game.setGod(true);
          if (Q.get('dmg')) PG.game.setDmgMul && PG.game.setDmgMul(parseFloat(Q.get('dmg')) || 1);
          const simSec = parseFloat(Q.get('sim') || '0');
          if (simSec > 0) {
            const step = 1 / 60;
            const fir = Q.get('fire') === '1';
            const mv = parseFloat(Q.get('mv') || '0.0');
            const inp = { mx: 0, mz: mv, dx: 0, dy: 0, fire: fir, reload: false, jump: false, dash: false, ult: false };
            let stepsRun = 0;
            const aim = Q.get('aim') === '1';
            for (let i = 0; i < simSec / step; i++) {
              if (aim) {
                try {
                  const pl = PG.game.player;
                  const ens = PG.game.enemies.filter((e) => e.alive);
                  if (pl && ens.length) {
                    let best = null, bd = 1e9;
                    for (const e of ens) {
                      const d = Math.hypot(e.pos.x - pl.pos.x, e.pos.z - pl.pos.z);
                      if (d < bd) { bd = d; best = e; }
                    }
                    if (best) {
                      const want = Math.atan2(-(best.pos.x - pl.pos.x), -(best.pos.z - pl.pos.z));
                      let diff = ((want - pl.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
                      pl.yaw += Math.max(-0.09, Math.min(0.09, diff));
                      const ty = best.hitCenter ? best.hitCenter.y : 1;
                      const wantPitch = Math.atan2(ty - (pl.pos.y + pl.eye), bd);
                      pl.pitch += Math.max(-0.06, Math.min(0.06, wantPitch - pl.pitch));
                    }
                  }
                } catch (e) {}
              }
              try { PG.game.update(step, inp); stepsRun++; } catch (err) { reportErr(err); break; }
            }
            E.simSteps = stepsRun;
            E.simSec = simSec;
            try { PG.ui && PG.ui.hud && PG.game.state && PG.game.player && PG.ui.hud({
              hp: Math.ceil(PG.game.player.hp), hpMax: PG.game.player.hpMax,
              wave: PG.game.state.wave, waveTotal: PG.game.WAVE_TOTAL,
              enemiesLeft: 8, score: PG.game.state.score, combo: PG.game.state.combo, comboMax: PG.game.state.comboMax,
              ammo: PG.game.player.ammo, ammoMax: PG.game.char.gun.ammoMax, reserve: 0,
              weaponName: PG.game.char.weaponShort, weaponColor: PG.game.char.color,
              reloading: false, reloadT: 1, dashCd: 0, dashMax: 1.0, ultCd: 0, ultMax: 13,
              boss: null, charge: 0.6, time: PG.game.state.time,
            }); } catch (e) {}
          }
        }, 120);
      } else if (!scr) {
        boot();
      } else {
        // 直接开屏模式：跳过 boot 流程，避免 1.5s 后被 toTitle 覆盖
        const b = document.getElementById('boot');
        if (b) { b.classList.add('done'); setTimeout(() => { b.style.display = 'none'; }, 300); }
        const bf = document.getElementById('boot-fill');
        if (bf) bf.style.width = '100%';
        buildShowcase();
        E.mode = 'title';
        E.titleT = 0;
      }
    } catch (err) {
      reportErr(err);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot2);
  else boot2();

  // 对外：便于 QA 直接调用
  PG.main = { E, startGame, toTitle, doPause, doResume, restartGame, quitToTitle, applyDiff, applySens };
})();
