/* 50-game.js — 核心玩法：玩家、武器、敌人 AI、波次、BOSS、粒子、镜头（Lead）
   依赖：THREE、PG.util、PG.audio、PG.ui、PG.world、PG.models
   对外：PG.game.CHARS / init / start / pause / resume / stop / restart / state */
(() => {
  const PG = (window.PG = window.PG || {});
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (a) => a[(Math.random() * a.length) | 0];
  const nowS = () => performance.now() / 1000;

  // ============================ 角色配置 ============================
  const CHARS = [
    {
      id: 't_bolt', cn: '雷公', en: 'LEIGONG', type: 'lei', color: '#ffd93d', colorHex: 0xffd93d,
      partner: 'kui', partnerCn: '夔牛',
      weapon: '雷光锤', weaponShort: '雷光锤',
      passive: '聚雷：命中累积雷气，满 5 层下一发必定暴击',
      ult: '天雷引：连锁闪电，劈中 8 米内最多 6 只妖物',
      hp: 100, speed: 1.06,
      gun: { dmg: 15, rate: 0.115, pellets: 1, spread: 0.008, speed: 108, ammoMax: 30, reload: 1.05, splash: 0, pierce: 0, crit: 2.0, projColor: 0xffe66b },
    },
    {
      id: 't_leaf', cn: '句芒', en: 'GOUMANG', type: 'mu', color: '#8ed36a', colorHex: 0x8ed36a,
      partner: 'qilin', partnerCn: '麒麟',
      weapon: '灵种杖', weaponShort: '灵种杖',
      passive: '春生：脱战 4 秒后缓慢回复体力',
      ult: '万物生：灵雨护体，回血并减速周围妖物',
      hp: 110, speed: 1.0,
      gun: { dmg: 12, rate: 0.62, pellets: 5, spread: 0.075, speed: 62, ammoMax: 9, reload: 1.45, splash: 0, pierce: 1, crit: 1.8, projColor: 0x9ef06b },
    },
    {
      id: 't_ember', cn: '祝融', en: 'ZHURONG', type: 'huo', color: '#ff8a3d', colorHex: 0xff8a3d,
      partner: 'bifang', partnerCn: '毕方',
      weapon: '离火铳', weaponShort: '离火铳',
      passive: '余烬：击杀后 2 秒内伤害 +40%',
      ult: '焚天业火：以自身为中心的爆炎新星，范围灼烧',
      hp: 120, speed: 0.94,
      gun: { dmg: 46, rate: 0.44, pellets: 1, spread: 0.012, speed: 58, ammoMax: 8, reload: 1.7, splash: 2.8, pierce: 0, crit: 1.7, projColor: 0xff9a3c },
    },
    {
      id: 't_tide', cn: '玄冥', en: 'XUANMING', type: 'shui', color: '#5ab8f0', colorHex: 0x5ab8f0,
      partner: 'xuanwu', partnerCn: '玄武',
      weapon: '玄水枪', weaponShort: '玄水枪',
      passive: '潮汐：每第 5 发伤害翻倍并回复 2 点体力',
      ult: '玄冥水盾：3 秒无敌，冲开周围所有敌人',
      hp: 105, speed: 1.03,
      gun: { dmg: 19, rate: 0.155, pellets: 1, spread: 0.006, speed: 96, ammoMax: 36, reload: 1.25, splash: 0, pierce: 2, crit: 1.8, projColor: 0x6fd8ff },
    },
  ];

  // ============================ 敌人配置 ============================
  const ENEMIES = {
    lushu: { hp: 30, spd: 2.0, dmg: 7, cd: 1.5, ai: 'melee', score: 60, y: 0 },
    wugong: { hp: 28, spd: 2.3, dmg: 6, cd: 2.2, ai: 'ranged', range: 24, projSpd: 17, score: 70 },
    zhen: { hp: 24, spd: 3.0, dmg: 6, cd: 1.9, ai: 'flyer', y: 1.4, score: 70 },
    mumei: { hp: 42, spd: 1.7, dmg: 9, cd: 1.7, ai: 'melee', score: 80 },
    xuanfeng: { hp: 46, spd: 3.1, dmg: 9, cd: 1.5, ai: 'ranged', range: 30, projSpd: 26, score: 110 },
    zheng: { hp: 62, spd: 2.7, dmg: 14, cd: 2.9, ai: 'dash', score: 130 },
    jiuwei: { hp: 44, spd: 2.6, dmg: 9, cd: 1.3, ai: 'strafe', score: 100 },
    jiaoren: { hp: 58, spd: 1.6, dmg: 5, cd: 2.4, ai: 'sing', score: 120 },
    chimei: { hp: 34, spd: 2.2, dmg: 9, cd: 2.0, ai: 'float', y: 1.3, score: 120, ghost: true },
    wangliang: { hp: 78, spd: 2.0, dmg: 13, cd: 2.6, ai: 'teleport', score: 190, ghost: true },
    chiru: { hp: 50, spd: 1.4, dmg: 8, cd: 1.8, ai: 'ranged', range: 22, projSpd: 19, score: 100 },
    taotie: { hp: 300, spd: 1.05, dmg: 22, cd: 2.6, ai: 'heavy', score: 500, kind: 'elite', scale: 1.08 },
    bashe: { hp: 210, spd: 1.3, dmg: 18, cd: 2.2, ai: 'ranged', range: 34, projSpd: 15, score: 450, kind: 'elite', scale: 1.05 },
    hundun: { hp: 1500, spd: 2.1, dmg: 20, cd: 2.0, ai: 'boss', score: 3000, kind: 'boss', scale: 1.15 },
  };
  const CN = {
    lushu: '鹿蜀', wugong: '蜈蚣精', zhen: '鸩鸟', mumei: '木魅', xuanfeng: '玄蜂',
    zheng: '狰', jiuwei: '九尾狐', jiaoren: '鲛人', chimei: '魑魅', wangliang: '魍魉',
    chiru: '赤鱬', taotie: '饕餮', bashe: '巴蛇', hundun: '混沌',
  };

  // ============================ 波次 ============================
  const WAVES = [
    { name: '林间异动', tip: '山里的灵气乱了……有东西在盯着我们！', list: [['lushu', 5], ['wugong', 3]] },
    { name: '妖群来袭', tip: '它们被混沌之气侵蚀了，别心软！', list: [['lushu', 4], ['wugong', 4], ['zhen', 3]] },
    { name: '古木伏击', tip: '左边的古木在动——树魅在聚气！', list: [['mumei', 4], ['zhen', 3], ['xuanfeng', 2]] },
    { name: '玄蜂之刺', tip: '混沌之气越来越浓，别停下！', list: [['xuanfeng', 5], ['jiuwei', 3], ['wugong', 4]] },
    { name: '百鬼夜行', tip: '雾里……有东西在飘。', list: [['chimei', 4], ['jiuwei', 3], ['zheng', 2], ['jiaoren', 2]] },
    { name: '凶兽突袭', tip: '迅捷的凶兽来了，用冲刺闪避！', list: [['zheng', 4], ['xuanfeng', 4], ['chiru', 3]] },
    { name: '凶兽镇守', tip: '两只凶兽守在祭坛前——集中火力！', list: [['taotie', 1], ['bashe', 1], ['wangliang', 2], ['mumei', 4]] },
    { name: '混沌之核', tip: '那……那是混沌？它竟没有面目！', list: [['hundun', 1]], boss: true },
  ];
  const WAVE_TOTAL = WAVES.length;

  // ============================ 运行时状态 ============================
  const G = {
    state: { mode: 'idle', wave: 0, waveTotal: WAVE_TOTAL, score: 0, combo: 0, comboMax: 0, time: 0, boss: null },
    scene: null, camera: null, renderer: null, vmScene: null, vmCamera: null,
    player: null, char: null, view: null, world: null,
    waves: null, enemies: [], projectiles: [], eprojectiles: [], fx: [],
    mats: {}, texes: {},
    onEnd: null,
  };

  // ============================ 纹理工具 ============================
  function glowTexture(inner, outer) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, inner);
    g.addColorStop(0.35, outer);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  function getGlow() {
    if (!G.texes.glow) G.texes.glow = glowTexture('rgba(255,255,255,1)', 'rgba(255,255,255,.55)');
    return G.texes.glow;
  }
  function ringTexture(color) {
    const key = 'ring' + color;
    if (G.texes[key]) return G.texes[key];
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const x = c.getContext('2d');
    x.strokeStyle = color;
    x.lineWidth = 9;
    x.shadowColor = color;
    x.shadowBlur = 16;
    x.beginPath();
    x.arc(64, 64, 48, 0, TAU);
    x.stroke();
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    G.texes[key] = t;
    return t;
  }
  const hexStr = (hex) => '#' + hex.toString(16).padStart(6, '0');

  // ============================ 玩家 ============================
  function makePlayer(char) {
    return {
      pos: new THREE.Vector3(0, 0, 22),
      vel: new THREE.Vector3(),
      yaw: 0, pitch: 0,
      hp: char.hp, hpMax: char.hp,
      speed: 5.4 * char.speed,
      eye: 1.62, onGround: true, vy: 0,
      fireCd: 0, ammo: char.gun.ammoMax, reloading: false, reloadT: 0,
      recoil: 0, bloom: 0, camShake: 0,
      dashCd: 0, dashT: 0, dashDir: new THREE.Vector3(), invuln: 0,
      ultCd: 0, ultMax: 13,
      charge: 0, emberT: 0, tideCount: 0, outT: 0,
      bobT: 0, bobAmt: 0, strafeLean: 0, hurtT: 0, dead: false,
      shieldT: 0, slowT: 0,
      kills: 0, shots: 0, hits: 0,
    };
  }

  // ============================ 第一人称手持法器 ============================
  // 山海国风"伏魔法器"：青铜六棱主体 + 鎏金环节 + 朱砂缠绳 + 玉珠核心 + 铜钱挂饰
  function buildViewmodel(char) {
    const root = new THREE.Group();
    root.name = 'viewmodel';
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x8a7a5a, roughness: 0.42, metalness: 0.35 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x4a4436, roughness: 0.5, metalness: 0.3 });
    const goldMat = new THREE.MeshStandardMaterial({ color: 0xe8b33a, roughness: 0.35, metalness: 0.55 });
    const jadeMat = new THREE.MeshStandardMaterial({ color: 0x8fd8c0, roughness: 0.18, metalness: 0.02 });
    const accentMat = new THREE.MeshStandardMaterial({ color: char.colorHex, roughness: 0.28, metalness: 0.06, emissive: char.colorHex, emissiveIntensity: 0.7 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0xbfead8, roughness: 0.1, metalness: 0, transparent: true, opacity: 0.6, emissive: 0x2f9e8f, emissiveIntensity: 0.4 });

    // 主身：六棱青铜筒（朝 -Z），仿古礼器握柄
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.082, 0.34, 6), bodyMat);
    body.rotation.x = Math.PI / 2;
    body.position.set(0, 0, -0.08);
    root.add(body);
    // 鎏金环节
    for (const z of [-0.2, 0.02, 0.14]) {
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.086, 0.086, 0.028, 12), goldMat);
      band.rotation.x = Math.PI / 2; band.position.set(0, 0, z); root.add(band);
    }
    // 前端吞口
    const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.082, 0.1, 8), darkMat);
    muzzle.rotation.x = Math.PI / 2; muzzle.position.set(0, 0, -0.3); root.add(muzzle);
    // 前端法环（属性色光）
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.062, 0.012, 8, 24), accentMat);
    ring.position.set(0, 0, -0.355); root.add(ring);
    // 法环内三枚玉片（云雷纹意象）
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU;
      const jade = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.006, 0.052), jadeMat);
      jade.position.set(Math.cos(a) * 0.042, Math.sin(a) * 0.042, -0.352);
      jade.rotation.z = a + Math.PI / 2;
      root.add(jade);
    }
    // 玉珠核心（顶部玉匣）
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.056, 16, 12), glassMat);
    core.position.set(0, 0.072, -0.05); root.add(core);
    const coreBall = new THREE.Mesh(new THREE.SphereGeometry(0.038, 16, 12), accentMat);
    coreBall.position.set(0, 0.072, -0.05); root.add(coreBall);
    // 顶部提梁（鎏金）
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.011, 6, 18, Math.PI), goldMat);
    handle.position.set(0, 0.125, 0.02); handle.rotation.y = Math.PI / 2; root.add(handle);
    // 后部玉管
    const tank = new THREE.Mesh(new THREE.CapsuleGeometry(0.052, 0.085, 6, 14), jadeMat);
    tank.rotation.x = Math.PI / 2; tank.position.set(0, 0, 0.17); root.add(tank);
    // 握把 + 朱砂缠绳
    const grip = new THREE.Mesh(new THREE.CapsuleGeometry(0.038, 0.15, 5, 12), darkMat);
    grip.position.set(0, -0.15, 0.1); grip.rotation.x = 0.3; root.add(grip);
    for (let i = 0; i < 4; i++) {
      const wrap = new THREE.Mesh(new THREE.TorusGeometry(0.041, 0.007, 5, 14), new THREE.MeshStandardMaterial({ color: 0xd0432e, roughness: 0.8 }));
      wrap.position.set(0, -0.19 + i * 0.038, 0.09 + i * 0.013);
      wrap.rotation.x = 0.3 + Math.PI / 2; root.add(wrap);
    }
    // 属性法器头（四位行者各不相同）
    if (char.type === 'lei') {
      // 雷公：雷纹方锤
      const ham = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.13, 0.16), bodyMat);
      ham.position.set(0, 0, -0.34); root.add(ham);
      const stud = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 8), goldMat);
      stud.position.set(0.07, 0, -0.34); root.add(stud);
    } else if (char.type === 'mu') {
      // 句芒：灵芝杖头
      const gourdU = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 10), new THREE.MeshStandardMaterial({ color: 0x8ed36a, roughness: 0.5 }));
      gourdU.position.set(0, 0.075, -0.33); root.add(gourdU);
      const gourdD = new THREE.Mesh(new THREE.SphereGeometry(0.037, 12, 10), new THREE.MeshStandardMaterial({ color: 0x6aa83a, roughness: 0.5 }));
      gourdD.position.set(0, 0.02, -0.33); root.add(gourdD);
      const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), new THREE.MeshStandardMaterial({ color: 0x7ec850, roughness: 0.6 }));
      leaf.scale.set(1.5, 0.35, 0.8); leaf.position.set(0.05, 0.09, -0.31); leaf.rotation.z = -0.4; root.add(leaf);
    } else if (char.type === 'huo') {
      // 祝融：离火盆口
      const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.06, 0.09, 12), bodyMat);
      bowl.position.set(0, 0.02, -0.35); root.add(bowl);
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * TAU;
        const flame = new THREE.Mesh(new THREE.ConeGeometry(0.024, 0.07, 8), accentMat);
        flame.position.set(Math.cos(a) * 0.045, 0.085, -0.35 + Math.sin(a) * 0.045); root.add(flame);
      }
    } else {
      // 玄冥：玉璧蛇首
      const bi = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.018, 8, 24), jadeMat);
      bi.position.set(0, 0.02, -0.35); root.add(bi);
      const snake = new THREE.Mesh(new THREE.ConeGeometry(0.026, 0.09, 8), new THREE.MeshStandardMaterial({ color: 0x4fb9c9, roughness: 0.38 }));
      snake.position.set(0, 0.1, -0.35); snake.rotation.x = 0.5; root.add(snake);
    }
    // 侧挂铜钱（外圆内方）+ 朱砂系绳
    const coin = new THREE.Group();
    const coinBody = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.012, 20), goldMat);
    coinBody.rotation.x = Math.PI / 2;
    const hole = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.022, 0.03), darkMat);
    coin.add(coinBody, hole);
    coin.position.set(0.072, -0.055, 0.06);
    root.add(coin);
    const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.075, 5), new THREE.MeshStandardMaterial({ color: 0xd0432e, roughness: 0.75 }));
    cord.position.set(0.072, -0.012, 0.06); root.add(cord);

    root.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.frustumCulled = false; o.renderOrder = 2; } });

    const flash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: getGlow(), color: char.colorHex, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
    }));
    flash.scale.set(0.85, 0.85, 1);
    flash.position.set(0, 0, -0.42);
    flash.renderOrder = 3;
    root.add(flash);

    const ringFx = new THREE.Sprite(new THREE.SpriteMaterial({
      map: ringTexture(hexStr(char.colorHex)), color: 0xffffff, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
    }));
    ringFx.scale.set(0.45, 0.45, 1);
    ringFx.position.set(0, 0, -0.4);
    ringFx.renderOrder = 3;
    root.add(ringFx);

    // 灵兽：左下角小小的一只
    let buddy = null;
    try {
      const m = PG.models && PG.models.make ? PG.models.make(char.partner) : null;
      if (m) {
        buddy = m.group;
        const s = 0.42 / (m.height || 0.8);
        buddy.scale.setScalar(s);
        buddy.position.set(-1.95, -0.86, -1.9);
        buddy.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.frustumCulled = false; o.renderOrder = 2; } });
        root.add(buddy);
      }
    } catch (e) { buddy = null; }

    root.scale.setScalar(0.42);
    return { root, flash, ringFx, buddy, core, barrel: muzzle, accentMat, bodyMat, basePos: new THREE.Vector3(0.4, -0.3, -1.02) };
  }

  // ============================ 粒子 / 特效 ============================
  function spawnSpark(pos, color, count, power, life) {
    for (let i = 0; i < count; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: getGlow(), color, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      sp.position.copy(pos);
      const a = rand(0, TAU), e = rand(-0.3, 1);
      const sp2 = rand(1.5, 6) * (power || 1);
      G.scene.add(sp);
      G.fx.push({ type: 'spark', obj: sp, vx: Math.cos(a) * sp2, vy: e * sp2, vz: Math.sin(a) * sp2, life: (life || 0.5) * rand(0.7, 1.3), t: 0, grav: -6, scale: rand(0.12, 0.3) });
    }
  }
  function spawnRing(pos, color, size, life) {
    const m = new THREE.Sprite(new THREE.SpriteMaterial({
      map: ringTexture(hexStr(color)), color: 0xffffff, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    m.position.copy(pos);
    m.scale.setScalar(size || 0.6);
    G.scene.add(m);
    G.fx.push({ type: 'ring', obj: m, life: life || 0.35, t: 0, size: size || 0.6 });
  }
  function spawnBeamFX(from, to, color, life) {
    const dist = from.distanceTo(to) || 1;
    const geo = new THREE.CylinderGeometry(0.05, 0.02, dist, 5, 1, true);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(from).lerp(to, 0.5);
    m.lookAt(to);
    m.rotateX(Math.PI / 2);
    G.scene.add(m);
    G.fx.push({ type: 'beam', obj: m, life: life || 0.18, t: 0 });
  }
  function updateFx(dt) {
    for (let i = G.fx.length - 1; i >= 0; i--) {
      const f = G.fx[i];
      f.t += dt;
      const k = f.t / f.life;
      if (k >= 1) {
        if (f.obj.parent) f.obj.parent.remove(f.obj);
        if (f.obj.geometry) f.obj.geometry.dispose();
        if (f.obj.material) f.obj.material.dispose();
        G.fx.splice(i, 1);
        continue;
      }
      if (f.type === 'spark') {
        f.vy += f.grav * dt;
        f.obj.position.x += f.vx * dt;
        f.obj.position.y += f.vy * dt;
        f.obj.position.z += f.vz * dt;
        const s = f.scale * (1 - k * 0.6);
        f.obj.scale.set(s, s, 1);
        f.obj.material.opacity = 1 - k;
      } else if (f.type === 'ring') {
        const s = f.size * (0.3 + k * 1.9);
        f.obj.scale.set(s, s, 1);
        f.obj.material.opacity = (1 - k) * 0.9;
      } else if (f.type === 'beam') {
        f.obj.material.opacity = (1 - k) * 0.9;
      }
    }
  }

  // ============================ 弹体 ============================
  function makeProjMesh(color, size) {
    const g = new THREE.Group();
    const core = new THREE.Mesh(new THREE.SphereGeometry(size, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: getGlow(), color, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.scale.setScalar(size * 7);
    g.add(core, glow);
    return g;
  }
  function fireProjectile(from, dir, gun, dmgMul, isEnemy, colorOverride) {
    const color = colorOverride != null ? colorOverride : (isEnemy ? 0xff5a5a : gun.projColor);
    const size = isEnemy ? 0.16 : 0.13;
    const mesh = makeProjMesh(color, size);
    mesh.position.copy(from);
    G.scene.add(mesh);
    const spd = isEnemy ? (gun.projSpd || 20) : gun.speed;
    const p = {
      mesh, pos: from.clone(), prev: from.clone(), dir: dir.clone().normalize(),
      speed: spd, dmg: 0, life: isEnemy ? 3.2 : 2.0, t: 0, isEnemy,
      splash: isEnemy ? 0 : (gun.splash || 0), pierce: isEnemy ? 0 : (gun.pierce || 0),
      hitSet: new Set(), color: color, radius: size,
    };
    p.dmg = isEnemy ? (gun.dmg || 8) * dmgMul : gun.dmg * dmgMul;
    (isEnemy ? G.eprojectiles : G.projectiles).push(p);
    return p;
  }

  function updateProjectiles(dt) {
    for (let i = G.projectiles.length - 1; i >= 0; i--) {
      const p = G.projectiles[i];
      p.prev.copy(p.pos);
      p.pos.addScaledVector(p.dir, p.speed * dt);
      p.t += dt;
      p.mesh.position.copy(p.pos);
      let dead = false;
      for (const e of G.enemies) {
        if (!e.alive || p.hitSet.has(e.id)) continue;
        const c = e.hitCenter, r = e.hitRadius;
        const abx = p.pos.x - p.prev.x, aby = p.pos.y - p.prev.y, abz = p.pos.z - p.prev.z;
        const acx = c.x - p.prev.x, acy = c.y - p.prev.y, acz = c.z - p.prev.z;
        const ab2 = abx * abx + aby * aby + abz * abz || 1e-6;
        let tt = (acx * abx + acy * aby + acz * abz) / ab2;
        tt = clamp(tt, 0, 1);
        const px = p.prev.x + abx * tt - c.x, py = p.prev.y + aby * tt - c.y, pz = p.prev.z + abz * tt - c.z;
        if (px * px + py * py + pz * pz <= r * r) {
          const hitPoint = new THREE.Vector3(p.prev.x + abx * tt, p.prev.y + aby * tt, p.prev.z + abz * tt);
          const head = hitPoint.y > c.y + r * 0.45;
          damageEnemy(e, p.dmg * (head ? 1.55 : 1), hitPoint, head ? 'crit' : 'hit');
          spawnSpark(hitPoint, p.color, 6, 1.0, 0.35);
          spawnRing(hitPoint, p.color, 0.5, 0.25);
          p.hitSet.add(e.id);
          if (p.splash > 0) {
            splashDamage(hitPoint, p.splash, p.dmg * 0.55, e.id);
            spawnRing(hitPoint, p.color, p.splash * 1.2, 0.32);
          }
          if (p.pierce > 0) p.pierce--; else dead = true;
          if (dead) break;
        }
      }
      if (!dead && (p.t > p.life || p.pos.length() > (G.world ? G.world.radius + 8 : 100))) dead = true;
      if (dead) killProj(p, i, G.projectiles);
    }
    const pl = G.player;
    for (let i = G.eprojectiles.length - 1; i >= 0; i--) {
      const p = G.eprojectiles[i];
      p.prev.copy(p.pos);
      p.pos.addScaledVector(p.dir, p.speed * dt);
      p.t += dt;
      p.mesh.position.copy(p.pos);
      let dead = false;
      if (pl && !pl.dead) {
        const pc = new THREE.Vector3(pl.pos.x, pl.pos.y + 1.0, pl.pos.z);
        if (p.pos.distanceTo(pc) < 0.62 + p.radius) {
          if (pl.invuln <= 0) {
            hurtPlayer(p.dmg, p.pos);
            spawnSpark(p.pos, 0xff6b5a, 8, 1.1, 0.4);
          }
          dead = true;
        }
      }
      if (!dead && (p.t > p.life || p.pos.y < -0.5 || p.pos.length() > (G.world ? G.world.radius + 10 : 100))) dead = true;
      if (dead) killProj(p, i, G.eprojectiles);
    }
  }
  function killProj(p, i, arr) {
    if (p.mesh.parent) p.mesh.parent.remove(p.mesh);
    p.mesh.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    arr.splice(i, 1);
  }
  function splashDamage(center, radius, dmg, skipId) {
    for (const e of G.enemies) {
      if (!e.alive || e.id === skipId) continue;
      const d = e.pos.distanceTo(center);
      if (d < radius + e.hitRadius) {
        const f = 1 - clamp(d / (radius + e.hitRadius), 0, 1) * 0.6;
        damageEnemy(e, dmg * f, e.hitCenter.clone(), 'splash');
      }
    }
  }

  // ============================ 敌人 ============================
  let enemyIdSeq = 1;
  let fallbackGeo = null;
  function fallbackModel(color) {
    if (!fallbackGeo) fallbackGeo = new THREE.SphereGeometry(0.5, 14, 12);
    const g = new THREE.Group();
    const m = new THREE.Mesh(fallbackGeo, new THREE.MeshStandardMaterial({ color: color || 0x99cc66, roughness: 0.6 }));
    m.position.y = 0.5;
    m.castShadow = true;
    g.add(m);
    return { group: g, height: 1.0, radius: 0.5, update() {} };
  }

  function makeEnemy(id, x, z, opt) {
    opt = opt || {};
    const def = ENEMIES[id] || ENEMIES.lushu;
    let model = null;
    try { model = (PG.models && PG.models.make) ? PG.models.make(id) : null; } catch (e) { model = null; }
    if (!model || !model.group) model = fallbackModel();
    const group = model.group;
    const scale = (def.scale || 1) * (opt.scale || 1);
    group.scale.multiplyScalar(scale);
    group.rotation.y = 0;
    const height = (model.height || 1) * scale;
    const radius = Math.max(0.35, (model.radius || 0.45) * scale);
    group.position.set(x, def.y || 0, z);
    G.scene.add(group);

    const mats = [];
    group.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      if (Array.isArray(o.material)) o.material = o.material.map((mm) => { const c = mm.clone(); mats.push(c); return c; });
      else if (o.material) { const c = o.material.clone(); o.material = c; mats.push(c); }
    });

    const hp = def.hp * (opt.hpMul || 1);
    const e = {
      id: enemyIdSeq++, type: id, def, group, model, mats,
      pos: new THREE.Vector3(x, def.y || 0, z),
      hp, hpMax: hp, alive: true, radius, height,
      hitRadius: Math.max(0.55, radius * 1.3),
      hitCenter: new THREE.Vector3(x, (def.y || 0) + height * 0.5, z),
      cd: rand(0.6, 1.6), state: 'spawn', flash: 0,
      yOff: 0, anim: rand(0, 10), spawnT: 0, dying: 0, slow: 0,
      dashT: 0, dashCd: 0, dashDir: new THREE.Vector3(), teleT: 2.5,
      kind: def.kind || 'enemy',
    };
    if (def.ghost) for (const m of mats) { if (m.transparent !== undefined) { m.transparent = true; m.opacity = 0.72; } }
    spawnRing(new THREE.Vector3(x, 0.1, z), 0x8a6ac8, 1.4, 0.5);
    G.enemies.push(e);
    return e;
  }

  function damageEnemy(e, dmg, hitPoint, kind) {
    if (!e.alive) return;
    if (e.state === 'spawn' && e.spawnT < 0.2) return;
    const pl = G.player;
    let mult = 1;
    if (pl && pl.emberT > 0) mult *= 1.4;
    dmg = Math.max(1, Math.round(dmg * mult * (G.dmgMul || 1)));
    e.hp -= dmg;
    e.flash = 0.09;
    if (hitPoint && pl) {
      const kx = e.pos.x - pl.pos.x, kz = e.pos.z - pl.pos.z;
      const kl = Math.hypot(kx, kz) || 1;
      const push = e.kind === 'boss' ? 0.04 : e.kind === 'elite' ? 0.12 : 0.3;
      e.pos.x += (kx / kl) * push;
      e.pos.z += (kz / kl) * push;
    }
    if (pl) {
      pl.hits++;
      addCombo(kind === 'crit' ? 2 : 1);
      if (PG.audio) PG.audio.sfx(kind === 'crit' ? 'crit' : 'hit', { vol: 0.5 });
      showDamageText(hitPoint, dmg, kind);
      if (G.char && G.char.id === 't_bolt') pl.charge = Math.min(5, pl.charge + 1);
      if (G.char && G.char.id === 't_tide') pl.tideCount = (pl.tideCount + 1) % 5;
    }
    if (PG.ui && PG.ui.hitmarker) PG.ui.hitmarker(kind === 'crit' || kind === 'splash' ? 'crit' : 'hit');
    if (e.hp <= 0) killEnemy(e);
  }

  function showDamageText(pos, dmg, kind) {
    if (!pos || !PG.ui || !PG.ui.damageNumber || !G.camera) return;
    const v = pos.clone();
    v.y += 0.35;
    const p = PG.util.project(v, G.camera, window.innerWidth, window.innerHeight);
    if (!p) return;
    PG.ui.damageNumber(p.x + rand(-8, 8), p.y, String(dmg), kind === 'crit' ? 'crit' : kind === 'splash' ? 'splash' : 'dmg');
  }

  function killEnemy(e) {
    if (!e.alive) return;
    e.alive = false;
    e.dying = 0.5;
    e.state = 'dying';
    const pl = G.player;
    const gain = e.def.score || 60;
    const comboMul = 1 + Math.min(2.5, G.state.combo * 0.05);
    G.state.score += Math.round(gain * comboMul);
    if (pl) {
      pl.kills++;
      if (G.char && G.char.id === 't_ember') pl.emberT = 2.0;
      pl.ammo = Math.min(G.char.gun.ammoMax, pl.ammo + 1);
    }
    addCombo(3);
    const col = e.kind === 'boss' ? 0xffb04a : e.kind === 'elite' ? 0xe8b33a : 0x9ef06b;
    spawnSpark(e.hitCenter.clone(), col, e.kind === 'boss' ? 60 : e.kind === 'elite' ? 26 : 12, e.kind === 'boss' ? 2.4 : 1.2, 0.9);
    spawnRing(e.pos.clone().setY(0.15), col, e.kind === 'boss' ? 4 : 1.6, 0.55);
    if (PG.audio) PG.audio.sfx('kill', { vol: e.kind === 'enemy' ? 0.5 : 0.85 });
    if (PG.ui && PG.ui.killfeed) PG.ui.killfeed('击败 ' + (CN[e.type] || e.type) + '  +' + gain, e.kind === 'boss' ? 'boss' : e.kind === 'elite' ? 'elite' : 'kill');
    if (e.kind === 'boss') {
      G.state.boss = null;
      setTimeout(() => winGame(), 900);
    }
  }

  function meleeAttack(e, mul) {
    const pl = G.player;
    if (!pl) return;
    const d = Math.hypot(pl.pos.x - e.pos.x, pl.pos.z - e.pos.z);
    if (d > 2.6 + e.radius) return;
    if (pl.invuln > 0 || pl.dashT > 0) return;
    hurtPlayer((e.def.dmg || 8) * (mul || 1), e.pos.clone().setY(1.0));
    spawnSpark(new THREE.Vector3(pl.pos.x, 1.1, pl.pos.z), 0xff6b5a, 8, 0.9, 0.35);
  }

  function rangedAttack(e, mul) {
    const pl = G.player;
    if (!pl) return;
    const from = new THREE.Vector3(e.pos.x, e.pos.y + e.height * 0.6 + (e.yOff || 0), e.pos.z);
    const aim = new THREE.Vector3(pl.pos.x, pl.pos.y + 1.0, pl.pos.z);
    const d = from.distanceTo(aim);
    const tt = d / (e.def.projSpd || 20);
    aim.x += pl.vel.x * tt * 0.6;
    aim.z += pl.vel.z * tt * 0.6;
    const dir = aim.sub(from).normalize();
    fireProjectile(from, dir, { dmg: (e.def.dmg || 8) * (mul || 1), projSpd: e.def.projSpd || 20 }, 1, true, 0xff6a5a);
    if (PG.audio) PG.audio.sfx('shot_alt', { vol: 0.2, rate: 0.7 });
  }

  function singAttack(e) {
    const pl = G.player;
    if (!pl) return;
    spawnRing(e.pos.clone().setY(0.4), 0xff9fd0, 2.4, 0.6);
    if (PG.audio) PG.audio.sfx('heal', { vol: 0.3, rate: 0.6 });
    if (pl.pos.distanceTo(e.pos) < 7) {
      pl.slowT = 2.5;
      if (PG.ui && PG.ui.toast) PG.ui.toast('鲛人的歌声让你脚步沉滞…', 1600);
    }
  }

  function updateBoss(e, dt, t, dist, nx, nz) {
    const pl = G.player;
    if (!pl) return;
    const phase2 = e.hp < e.hpMax * 0.5;
    e.cd -= dt;
    const spd = e.def.spd * (phase2 ? 1.5 : 1);
    e.pos.y = 0.55 + Math.sin(t * 1.4) * 0.25;
    if (dist > 7) { e.pos.x += nx * spd * dt; e.pos.z += nz * spd * dt; }
    else if (dist < 4) { e.pos.x -= nx * spd * dt; e.pos.z -= nz * spd * dt; }
    if (e.cd <= 0) {
      const mode = Math.floor(rand(0, phase2 ? 4 : 3));
      if (mode === 0) {
        const from = new THREE.Vector3(e.pos.x, e.pos.y + e.height * 0.6, e.pos.z);
        const aim = new THREE.Vector3(pl.pos.x, pl.pos.y + 1.0, pl.pos.z);
        const base = aim.clone().sub(from).normalize();
        for (let i = -1; i <= 1; i++) {
          const dir = base.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), i * 0.13);
          fireProjectile(from.clone(), dir, { dmg: 12, projSpd: 24 }, 1, true, 0xff9a4a);
        }
        if (PG.audio) PG.audio.sfx('boss_roar', { vol: 0.5, rate: 1.5 });
        e.cd = phase2 ? 1.5 : 2.2;
      } else if (mode === 1) {
        const n = phase2 ? 14 : 9;
        const from = new THREE.Vector3(e.pos.x, e.pos.y + e.height * 0.7, e.pos.z);
        for (let i = 0; i < n; i++) {
          const a = (i / n) * TAU + t;
          fireProjectile(from.clone(), new THREE.Vector3(Math.cos(a), rand(-0.05, 0.05), Math.sin(a)), { dmg: 9, projSpd: 16 }, 1, true, 0xffb04a);
        }
        spawnRing(e.pos.clone().setY(e.pos.y + 0.5), 0xffb04a, 3.2, 0.6);
        e.cd = phase2 ? 2.0 : 3.0;
      } else if (mode === 2) {
        spawnSpark(e.pos.clone().setY(e.hitCenter.y), 0xffb04a, 24, 1.6, 0.6);
        const a = rand(0, TAU), r = rand(6, 10);
        e.pos.x = pl.pos.x + Math.cos(a) * r;
        e.pos.z = pl.pos.z + Math.sin(a) * r;
        spawnRing(e.pos.clone().setY(0.2), 0xffb04a, 2.4, 0.5);
        e.cd = phase2 ? 1.8 : 2.6;
      } else {
        for (let i = 0; i < 2; i++) {
          const a = rand(0, TAU), r = rand(4, 8);
          spawnEnemyAt(pick(['chimei', 'wangliang']), e.pos.x + Math.cos(a) * r, e.pos.z + Math.sin(a) * r);
        }
        if (PG.ui && PG.ui.subtitle) PG.ui.subtitle('混沌', '更多混沌……从山泽深处涌出来了！', 2600);
        e.cd = 4.0;
      }
    }
    if (dist < 2.6 && Math.random() < dt * 1.6) hurtPlayer(e.def.dmg, e.pos.clone());
  }

  function updateEnemy(e, dt, t) {
    const pl = G.player;
    if (!pl) return;
    const dx = pl.pos.x - e.pos.x, dz = pl.pos.z - e.pos.z;
    const dist = Math.hypot(dx, dz) || 1;
    const nx = dx / dist, nz = dz / dist;
    e.anim += dt;

    if (e.state === 'spawn') {
      e.spawnT += dt;
      const k = clamp(e.spawnT / 0.55, 0, 1);
      e.yOff = lerp(-1.6, 0, k * k * (3 - 2 * k));
      if (k >= 1) { e.state = 'active'; e.yOff = 0; }
    }
    if (e.state === 'dying') {
      e.dying -= dt;
      const k = clamp(1 - e.dying / 0.5, 0, 1);
      e.group.scale.multiplyScalar(1 + dt * 1.8);
      for (const m of e.mats) { m.transparent = true; m.opacity = (1 - k) * 0.9; }
      e.group.position.y += dt * 1.5;
      if (e.dying <= 0) {
        G.scene.remove(e.group);
        if (PG.util && PG.util.disposeTree) PG.util.disposeTree(e.group);
        const idx = G.enemies.indexOf(e);
        if (idx >= 0) G.enemies.splice(idx, 1);
      }
      return;
    }

    if (e.flash > 0) {
      e.flash -= dt;
      const on = e.flash > 0.02;
      for (const m of e.mats) { if (m.emissive) { m.emissive.setHex(on ? 0xffffff : 0x000000); } }
    }

    e.slow = Math.max(0, e.slow - dt);
    const slowMul = e.slow > 0 ? 0.45 : 1;
    const spd = e.def.spd * slowMul * (1 + (G.state.wave - 1) * 0.045);
    let mvx = 0, mvz = 0;
    const attackRange = 1.8 + e.radius;

    if (e.state === 'active') {
      switch (e.def.ai) {
        case 'melee':
        case 'heavy':
          if (dist > attackRange) { mvx = nx * spd; mvz = nz * spd; }
          else { e.cd -= dt; if (e.cd <= 0) { e.cd = e.def.cd; meleeAttack(e); } }
          break;
        case 'strafe': {
          const side = Math.sin(t * 1.7 + e.id) > 0 ? 1 : -1;
          if (dist > 7) { mvx = nx * spd; mvz = nz * spd; }
          else { mvx = -nz * spd * 0.85 * side + nx * spd * 0.25; mvz = nx * spd * 0.85 * side + nz * spd * 0.25; }
          e.cd -= dt;
          if (e.cd <= 0 && dist < 14) { e.cd = e.def.cd; rangedAttack(e, 1); }
          break;
        }
        case 'ranged':
          if (dist > (e.def.range || 26) * 0.75) { mvx = nx * spd; mvz = nz * spd; }
          else if (dist < (e.def.range || 26) * 0.4) { mvx = -nx * spd * 0.7; mvz = -nz * spd * 0.7; }
          e.cd -= dt;
          if (e.cd <= 0) { e.cd = e.def.cd; rangedAttack(e, 1); }
          break;
        case 'flyer': {
          e.pos.y = 1.5 + Math.sin(t * 2.2 + e.id) * 0.35;
          if (dist > 2.2) { const dive = dist < 9 ? 1.7 : 1; mvx = nx * spd * dive; mvz = nz * spd * dive; }
          else { e.cd -= dt; if (e.cd <= 0) { e.cd = e.def.cd; meleeAttack(e); } }
          break;
        }
        case 'float':
          e.pos.y = 1.3 + Math.sin(t * 1.8 + e.id) * 0.25;
          if (dist > 3) { mvx = nx * spd; mvz = nz * spd; }
          e.cd -= dt;
          if (e.cd <= 0 && dist < 16) { e.cd = e.def.cd; rangedAttack(e, 1); }
          break;
        case 'sing':
          if (dist > 2.0) { mvx = nx * spd; mvz = nz * spd; }
          else { e.cd -= dt; if (e.cd <= 0) { e.cd = e.def.cd; singAttack(e); } }
          break;
        case 'dash':
          e.dashCd = Math.max(0, e.dashCd - dt);
          if (e.dashT > 0) {
            e.dashT -= dt;
            mvx = e.dashDir.x * 17; mvz = e.dashDir.z * 17;
            if (dist < attackRange) { meleeAttack(e, 1.6); e.dashT = 0; }
          } else {
            if (dist > 9) { mvx = nx * spd; mvz = nz * spd; }
            else { mvx = -nz * spd * 0.5; mvz = nx * spd * 0.5; }
            if (e.dashCd <= 0 && dist < 20) {
              e.dashCd = e.def.cd; e.dashT = 0.45;
              e.dashDir.set(nx, 0, nz);
              spawnRing(e.pos.clone().setY(0.2), 0xffe066, 1.2, 0.3);
            }
          }
          break;
        case 'teleport':
          e.teleT -= dt;
          if (e.teleT <= 0 && dist > 6) {
            e.teleT = 3.2;
            spawnSpark(e.pos.clone().setY(e.hitCenter.y), 0xb46bff, 14, 1.2, 0.5);
            const a = rand(0, TAU), r = rand(8, 13);
            e.pos.x = pl.pos.x + Math.cos(a) * r;
            e.pos.z = pl.pos.z + Math.sin(a) * r;
            spawnSpark(e.pos.clone().setY(0.6), 0xb46bff, 14, 1.2, 0.5);
          }
          if (dist > 3) { mvx = nx * spd; mvz = nz * spd; }
          e.cd -= dt;
          if (e.cd <= 0 && dist < 18) { e.cd = e.def.cd; rangedAttack(e, 1.4); }
          break;
        case 'boss':
          updateBoss(e, dt, t, dist, nx, nz);
          break;
      }
    }

    e.pos.x += mvx * dt;
    e.pos.z += mvz * dt;

    if (dist < 1.0 + e.radius && e.def.ai !== 'boss') {
      e.pos.x -= nx * (1.0 + e.radius - dist) * 0.5;
      e.pos.z -= nz * (1.0 + e.radius - dist) * 0.5;
    }
    if (G.world) {
      const R = (G.world.radius || 60) - 1.2;
      const dl = Math.hypot(e.pos.x, e.pos.z);
      if (dl > R) { e.pos.x = (e.pos.x / dl) * R; e.pos.z = (e.pos.z / dl) * R; }
      const cols = G.world.colliders || [];
      for (let i = 0; i < cols.length; i++) {
        const c = cols[i];
        const sx = e.pos.x - c.x, sz = e.pos.z - c.z;
        const d2 = Math.hypot(sx, sz) || 1;
        const minD = c.r + e.radius * 0.8;
        if (d2 < minD) { e.pos.x = c.x + (sx / d2) * minD; e.pos.z = c.z + (sz / d2) * minD; }
      }
      for (const o of G.enemies) {
        if (o === e || !o.alive || o.state === 'spawn') continue;
        const ox = e.pos.x - o.pos.x, oz = e.pos.z - o.pos.z;
        const od = Math.hypot(ox, oz);
        const minD = (e.radius + o.radius) * 0.85;
        if (od > 0.001 && od < minD) {
          const push = (minD - od) * 0.5;
          e.pos.x += (ox / od) * push;
          e.pos.z += (oz / od) * push;
        }
      }
    }

    e.group.position.set(e.pos.x, e.pos.y + (e.yOff || 0), e.pos.z);
    const targetFace = Math.atan2(dx, dz);
    const cur = e.group.rotation.y;
    const diff = ((targetFace - cur + Math.PI * 3) % TAU) - Math.PI;
    e.group.rotation.y = cur + diff * Math.min(1, dt * 8);
    e.hitCenter.set(e.pos.x, e.pos.y + e.height * 0.5 + (e.yOff || 0), e.pos.z);
    if (e.model && e.model.update) { try { e.model.update(dt, t + e.anim); } catch (err) {} }
  }

  function hurtPlayer(dmg, fromPos) {
    const pl = G.player;
    if (G.god) return;
    if (!pl || pl.dead || pl.invuln > 0) return;
    if (pl.shieldT > 0) { spawnSpark(fromPos || pl.pos.clone().setY(1), 0x6fd8ff, 8, 1, 0.3); return; }
    pl.hp -= dmg;
    pl.hurtT = 0.35;
    pl.invuln = 0.28;
    pl.camShake = Math.min(0.5, 0.16 + dmg * 0.006);
    pl.outT = 0;
    if (PG.audio) PG.audio.sfx('hurt', { vol: 0.8 });
    if (PG.ui && PG.ui.hurtFlash) PG.ui.hurtFlash(Math.min(0.6, dmg / 30));
    if (PG.ui && PG.ui.damageFrom && fromPos) {
      const ang = Math.atan2(fromPos.x - pl.pos.x, fromPos.z - pl.pos.z);
      PG.ui.damageFrom(ang - (pl.yaw + Math.PI));
    }
    if (pl.hp <= 0) {
      pl.hp = 0;
      pl.dead = true;
      G.state.mode = 'dead';
      if (PG.audio) { PG.audio.music('lose'); PG.audio.sfx('lose', { vol: 1 }); }
      if (G.onEnd) G.onEnd('dead');
    }
  }

  // ============================ 玩家更新 ============================
  function startReload() {
    const pl = G.player;
    if (pl.reloading || pl.ammo >= G.char.gun.ammoMax) return;
    pl.reloading = true;
    pl.reloadT = G.char.gun.reload;
    if (PG.audio) PG.audio.sfx('reload', { vol: 0.5 });
  }

  function fireWeapon() {
    const pl = G.player;
    const gun = G.char.gun;
    pl.fireCd = gun.rate;
    pl.bloom = Math.min(1, pl.bloom + (gun.pellets > 1 ? 0.3 : 0.12));
    pl.recoil = Math.min(1, pl.recoil + 0.55);
    pl.camShake = Math.min(0.35, pl.camShake + 0.045);
    pl.shots++;
    if (PG.audio) PG.audio.sfx(pl.bloom > 0.5 ? 'shot_alt' : 'shot', { vol: 0.55, rate: rand(0.94, 1.06), weapon: G.char.type });

    let dmgMul = 1;
    let forcedCrit = false;
    if (G.char.id === 't_tide') {
      pl.tideCount = (pl.tideCount + 1) % 5;
      if (pl.tideCount === 0) { dmgMul = 2; pl.hp = Math.min(pl.hpMax, pl.hp + 2); }
    }
    if (G.char.id === 't_bolt' && pl.charge >= 5) { forcedCrit = true; dmgMul = gun.crit; pl.charge = 0; }
    if (Math.random() < 0.06) dmgMul += 0.6;

    const origin = new THREE.Vector3();
    G.camera.getWorldPosition(origin);
    const dir = new THREE.Vector3();
    G.camera.getWorldDirection(dir);

    const count = gun.pellets || 1;
    for (let i = 0; i < count; i++) {
      const d = dir.clone();
      const spread = gun.spread * (1 + pl.bloom * 1.8);
      const a = rand(0, TAU), r = Math.sqrt(Math.random()) * spread;
      const right = new THREE.Vector3().crossVectors(d, new THREE.Vector3(0, 1, 0)).normalize();
      const up = new THREE.Vector3().crossVectors(right, d).normalize();
      d.addScaledVector(right, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).normalize();
      const start = origin.clone().addScaledVector(d, 0.55);
      start.y -= 0.06;
      fireProjectile(start, d, gun, dmgMul, false);
    }
    if (G.view) {
      G.view.flash.material.opacity = 1;
      G.view.flash.scale.setScalar(rand(0.55, 0.8));
      G.view.ringFx.material.opacity = 0.9;
      if (G.view.buddy) G.view.buddy.userData.kick = 1;
    }
    if (pl.ammo > 0) pl.ammo--;
    if (pl.ammo <= 0 && !pl.reloading) startReload();
    if (PG.ui && PG.ui.setAmmoWarn) PG.ui.setAmmoWarn(pl.ammo <= Math.ceil(gun.ammoMax * 0.25));
  }

  function doUlt() {
    const pl = G.player;
    pl.ultCd = pl.ultMax;
    const id = G.char.id;
    if (PG.audio) PG.audio.sfx('levelup', { vol: 0.8 });
    if (PG.ui && PG.ui.subtitle) PG.ui.subtitle(G.char.partnerCn, { t_bolt: '天雷引！', t_leaf: '万物生！', t_ember: '焚天业火！', t_tide: '玄冥水盾！' }[id], 1800);
    if (id === 't_bolt') {
      const targets = G.enemies.filter((e) => e.alive).sort((a, b) => a.pos.distanceTo(pl.pos) - b.pos.distanceTo(pl.pos)).slice(0, 6);
      const from = new THREE.Vector3(pl.pos.x, 1.2, pl.pos.z);
      for (const e of targets) {
        const to = e.hitCenter.clone();
        spawnBeamFX(from, to, 0xffe66b, 0.2);
        damageEnemy(e, 55, to, 'crit');
        spawnSpark(to, 0xffe66b, 12, 1.4, 0.45);
        from.set(to.x, to.y, to.z);
      }
      pl.charge = 5;
    } else if (id === 't_leaf') {
      pl.hp = Math.min(pl.hpMax, pl.hp + 35);
      for (const e of G.enemies) if (e.alive && e.pos.distanceTo(pl.pos) < 9) { e.slow = 1.6; damageEnemy(e, 30, e.hitCenter.clone(), 'hit'); }
      spawnRing(new THREE.Vector3(pl.pos.x, 0.2, pl.pos.z), 0x9ef06b, 5, 0.8);
      spawnSpark(new THREE.Vector3(pl.pos.x, 1, pl.pos.z), 0x9ef06b, 30, 1.6, 0.7);
    } else if (id === 't_ember') {
      for (const e of G.enemies) if (e.alive && e.pos.distanceTo(pl.pos) < 8) damageEnemy(e, 70, e.hitCenter.clone(), 'crit');
      spawnRing(new THREE.Vector3(pl.pos.x, 0.2, pl.pos.z), 0xff7a3c, 7, 0.9);
      spawnSpark(new THREE.Vector3(pl.pos.x, 0.8, pl.pos.z), 0xff7a3c, 40, 2.0, 0.8);
      pl.emberT = 3.0;
      pl.camShake = 0.6;
    } else {
      pl.shieldT = 3.0;
      for (const e of G.enemies) {
        if (e.alive && e.pos.distanceTo(pl.pos) < 7) {
          const a = Math.atan2(e.pos.z - pl.pos.z, e.pos.x - pl.pos.x);
          e.pos.x += Math.cos(a) * 3; e.pos.z += Math.sin(a) * 3;
          damageEnemy(e, 25, e.hitCenter.clone(), 'hit');
        }
      }
      spawnRing(new THREE.Vector3(pl.pos.x, 0.3, pl.pos.z), 0x6fd8ff, 6, 0.8);
    }
  }

  function addCombo(n) {
    G.state.combo += n;
    G.state.comboMax = Math.max(G.state.comboMax, G.state.combo);
    G.state.comboT = 3.0;
    if (G.state.combo > 0 && G.state.combo % 10 === 0 && PG.audio) PG.audio.sfx('combo', { vol: 0.5 });
  }

  function updatePlayer(dt, input) {
    const pl = G.player;
    if (!pl || pl.dead) return;
    pl.invuln = Math.max(0, pl.invuln - dt);
    pl.dashCd = Math.max(0, pl.dashCd - dt);
    pl.ultCd = Math.max(0, pl.ultCd - dt);
    pl.emberT = Math.max(0, pl.emberT - dt);
    pl.shieldT = Math.max(0, pl.shieldT - dt);
    pl.slowT = Math.max(0, pl.slowT - dt);
    pl.hurtT = Math.max(0, pl.hurtT - dt);
    pl.fireCd = Math.max(0, pl.fireCd - dt);
    pl.outT += dt;

    if (G.char.id === 't_leaf' && pl.outT > 4 && pl.hp < pl.hpMax) pl.hp = Math.min(pl.hpMax, pl.hp + 4 * dt);

    pl.yaw -= (input.dx || 0) * 0.0023;
    pl.pitch -= (input.dy || 0) * 0.0023;
    pl.pitch = clamp(pl.pitch, -1.35, 1.35);

    let mx = input.mx || 0, mz = input.mz || 0;
    const ml = Math.hypot(mx, mz);
    if (ml > 1) { mx /= ml; mz /= ml; }
    const sin = Math.sin(pl.yaw), cos = Math.cos(pl.yaw);
    const wx = -sin * mz + cos * mx;
    const wz = -cos * mz - sin * mx;
    const slowMul = pl.slowT > 0 ? 0.55 : 1;
    const spd = pl.speed * slowMul;
    const accel = pl.onGround ? 14 : 6;
    pl.vel.x = lerp(pl.vel.x, wx * spd, clamp(accel * dt, 0, 1));
    pl.vel.z = lerp(pl.vel.z, wz * spd, clamp(accel * dt, 0, 1));

    if (input.dash && pl.dashCd <= 0) {
      pl.dashCd = 1.15;
      pl.dashT = 0.2;
      pl.invuln = Math.max(pl.invuln, 0.26);
      const dl = Math.hypot(wx, wz);
      pl.dashDir.set(dl > 0.01 ? wx / dl : -sin, 0, dl > 0.01 ? wz / dl : -cos);
      if (PG.audio) PG.audio.sfx('dash', { vol: 0.6 });
      spawnRing(new THREE.Vector3(pl.pos.x, 0.2, pl.pos.z), G.char.gun.projColor, 1.3, 0.3);
    }
    if (pl.dashT > 0) {
      pl.dashT -= dt;
      pl.vel.x = pl.dashDir.x * 17;
      pl.vel.z = pl.dashDir.z * 17;
    }

    if (input.jump && pl.onGround) {
      pl.vy = 6.4;
      pl.onGround = false;
      if (PG.audio) PG.audio.sfx('jump', { vol: 0.4 });
    }
    pl.vy -= 19 * dt;
    pl.pos.x += pl.vel.x * dt;
    pl.pos.z += pl.vel.z * dt;
    pl.pos.y += pl.vy * dt;
    if (pl.pos.y <= 0) { pl.pos.y = 0; pl.vy = 0; pl.onGround = true; }

    if (G.world) {
      const R = (G.world.radius || 60) - 1.0;
      const dl = Math.hypot(pl.pos.x, pl.pos.z);
      if (dl > R) { pl.pos.x = (pl.pos.x / dl) * R; pl.pos.z = (pl.pos.z / dl) * R; pl.vel.x *= 0.3; pl.vel.z *= 0.3; }
      const cols = G.world.colliders || [];
      for (const c of cols) {
        const sx = pl.pos.x - c.x, sz = pl.pos.z - c.z;
        const d = Math.hypot(sx, sz) || 1;
        const minD = c.r + 0.42;
        if (d < minD) { pl.pos.x = c.x + (sx / d) * minD; pl.pos.z = c.z + (sz / d) * minD; }
      }
    }

    if (pl.reloading) {
      pl.reloadT -= dt;
      if (pl.reloadT <= 0) {
        pl.reloading = false;
        pl.ammo = G.char.gun.ammoMax;
        if (PG.audio) PG.audio.sfx('reload', { vol: 0.5, rate: 1.3 });
      }
    } else if (input.reload) {
      startReload();
    }
    if (input.fire && !pl.reloading && pl.fireCd <= 0) fireWeapon();
    if (input.ult && pl.ultCd <= 0) doUlt();

    pl.recoil = Math.max(0, pl.recoil - dt * 6);
    pl.bloom = Math.max(0, pl.bloom - dt * 1.6);
    pl.camShake = Math.max(0, pl.camShake - dt * 1.8);
    pl.strafeLean = lerp(pl.strafeLean, mx * 0.045, clamp(dt * 7, 0, 1));
    const moving = Math.hypot(pl.vel.x, pl.vel.z) > 0.5 && pl.onGround;
    pl.bobT += dt * (moving ? 9.5 : 3.2);
    pl.bobAmt = lerp(pl.bobAmt, moving ? 0.032 : 0, clamp(dt * 6, 0, 1));
  }

  // ============================ 镜头 ============================
  function applyCamera(dt) {
    const pl = G.player;
    const cam = G.camera;
    if (!pl) return;
    const bob = Math.sin(pl.bobT) * (pl.bobAmt || 0);
    const bobX = Math.cos(pl.bobT * 0.5) * (pl.bobAmt || 0) * 0.6;
    let shakeX = 0, shakeY = 0;
    if (pl.camShake > 0.001) { shakeX = rand(-1, 1) * pl.camShake * 0.12; shakeY = rand(-1, 1) * pl.camShake * 0.12; }
    cam.position.set(pl.pos.x + bobX + shakeX, pl.pos.y + pl.eye + bob + shakeY, pl.pos.z);
    cam.position.y += Math.sin(nowS() * 1.6) * 0.006;
    const recoilPitch = pl.recoil * 0.055 + (pl.reloading ? -0.06 : 0);
    const hurtRoll = pl.hurtT > 0 ? Math.sin(pl.hurtT * 40) * pl.hurtT * 0.35 : 0;
    cam.rotation.set(pl.pitch + recoilPitch, pl.yaw, pl.strafeLean + hurtRoll);
    const targetFov = 78 + pl.bloom * 2 + pl.recoil * 3 + (pl.dashT > 0 ? 6 : 0);
    cam.fov = lerp(cam.fov, targetFov, clamp(dt * 8, 0, 1));
    cam.updateProjectionMatrix();
  }

  // ============================ 波次 ============================
  function startWaves() {
    G.waves = { index: -1, queue: [], spawnT: 0, drip: 0.6, between: 2.0, cleared: false, totalSpawned: 0 };
  }

  function beginWave(idx) {
    // 防御：索引越界时直接进入胜利结算（正常流程由 BOSS 死亡触发）
    if (!WAVES[idx]) {
      winGame();
      return;
    }
    G.waves.index = idx;
    G.state.wave = Math.min(idx + 1, WAVE_TOTAL);
    const w = WAVES[idx];
    G.waves.queue = [];
    for (const pair of w.list) for (let i = 0; i < pair[1]; i++) G.waves.queue.push(pair[0]);
    G.waves.drip = w.boss ? 0.5 : 0.55;
    G.waves.spawnT = 1.1;
    G.waves.cleared = false;
    G.waves.totalSpawned = 0;
    G.state.boss = null;
    if (PG.audio) PG.audio.music(w.boss ? 'boss' : 'battle');
    if (PG.ui) {
      if (PG.ui.banner) PG.ui.banner(w.boss ? '最终波 · ' + w.name : '第 ' + (idx + 1) + ' 波 · ' + w.name, w.boss ? '直面混沌' : '剩余妖物 ' + G.waves.queue.length, 2600);
      if (PG.ui.subtitle) PG.ui.subtitle(w.boss ? '混沌' : G.char.partnerCn, w.tip, 4200);
      if (PG.ui.setObjectives) PG.ui.setObjectives([
        { text: '清剿第 ' + (idx + 1) + ' 波妖物', done: false },
        { text: w.boss ? '击败混沌' : '守住山海祭坛', done: false },
        { text: '击退全部 ' + WAVE_TOTAL + ' 波', done: false },
      ]);
    }
    if (PG.audio) PG.audio.sfx('wave', { vol: 0.8 });
    if (w.boss) {
      spawnEnemyAt('hundun', 0, -24);
      G.state.boss = { name: '混沌', hp: 1500, hpMax: 1500 };
    }
  }

  function spawnEnemyAt(id, x, z, opt) {
    const e = makeEnemy(id, x, z, opt);
    if (e.kind === 'boss') {
      G.state.boss = { name: '混沌', hp: e.hp, hpMax: e.hpMax };
      e.bossRef = true;
    }
    return e;
  }

  function aliveCount() {
    let n = 0;
    for (const e of G.enemies) if (e.alive && e.state !== 'dying') n++;
    return n;
  }

  function updateWaves(dt) {
    const w = G.waves;
    if (!w) return;
    const alive = aliveCount();

    // 开场倒计时：进入第 1 波
    if (w.index < 0) {
      if (w.between > 0) {
        w.between -= dt;
        if (w.between <= 0) beginWave(0);
      }
      return;
    }

    // 滴灌式刷怪
    if (w.queue.length > 0) {
      w.spawnT -= dt;
      const maxAlive = Math.min(12, 6 + Math.floor(w.index * 1.2));
      if (w.spawnT <= 0 && alive < maxAlive) {
        const id = w.queue.pop();
        const ang = rand(0, TAU);
        const near = rand(18, 32) - Math.min(6, w.index * 1.2);
        const px = G.player.pos.x + Math.cos(ang) * near;
        const pz = G.player.pos.z + Math.sin(ang) * near;
        const R = (G.world ? G.world.radius : 60) - 3;
        const dl = Math.hypot(px, pz) || 1;
        const sx = dl > R ? (px / dl) * R : px;
        const sz = dl > R ? (pz / dl) * R : pz;
        spawnEnemyAt(id, sx, sz);
        w.spawnT = w.drip * (id === 'hundun' ? 1 : rand(0.75, 1.25));
        w.totalSpawned++;
      }
      return;
    }

    // 本波清空
    if (!w.cleared && alive === 0) {
      w.cleared = true;
      if (w.index >= WAVES.length - 1) return; // BOSS 波由 winGame 接管
      if (G.state.boss) return;
      const pl = G.player;
      pl.hp = Math.min(pl.hpMax, pl.hp + pl.hpMax * 0.22);
      pl.ammo = G.char.gun.ammoMax;
      pl.reloading = false;
      if (PG.audio) PG.audio.sfx('heal', { vol: 0.7 });
      if (PG.ui) {
        if (PG.ui.banner) PG.ui.banner('第 ' + (w.index + 1) + ' 波 · 清除', '体力与能量已补充', 2000);
        if (PG.ui.toast) PG.ui.toast('体力已恢复，能量充满！', 1800);
      }
      w.between = 4.0;
      return;
    }

    // 波间休整 → 下一波
    if (w.cleared) {
      w.between -= dt;
      if (w.between <= 0) beginWave(w.index + 1);
    }
  }

  // ============================ HUD ============================
  let hudT = 0;
  function pushHud(dt) {
    hudT += dt;
    if (hudT < 1 / 30) return;
    hudT = 0;
    const pl = G.player;
    if (!pl || !PG.ui || !PG.ui.hud) return;
    if (G.state.boss) {
      const bossE = G.enemies.find((e) => e.kind === 'boss' && e.alive);
      if (bossE) { G.state.boss.hp = bossE.hp; G.state.boss.hpMax = bossE.hpMax; }
    }
    PG.ui.hud({
      hp: Math.ceil(pl.hp), hpMax: pl.hpMax,
      wave: Math.max(1, Math.min(WAVE_TOTAL, G.state.wave)), waveTotal: WAVE_TOTAL,
      enemiesLeft: aliveCount() + (G.waves ? G.waves.queue.length : 0),
      score: G.state.score, combo: G.state.combo, comboMax: G.state.comboMax,
      ammo: pl.ammo, ammoMax: G.char.gun.ammoMax, reserve: 0,
      weaponName: G.char.weaponShort, weaponColor: G.char.color,
      reloading: pl.reloading, reloadT: pl.reloading ? 1 - pl.reloadT / G.char.gun.reload : 1,
      dashCd: pl.dashCd, dashMax: 1.15,
      ultCd: pl.ultCd, ultMax: pl.ultMax,
      boss: G.state.boss ? { name: G.state.boss.name, hp: Math.max(0, G.state.boss.hp), hpMax: G.state.boss.hpMax } : null,
      charge: G.char.id === 't_bolt' ? pl.charge / 5 : (G.char.id === 't_tide' ? pl.tideCount / 5 : 0),
      time: G.state.time,
    });
  }

  // ============================ 生命周期 ============================
  function clearSession() {
    for (let i = G.projectiles.length - 1; i >= 0; i--) killProj(G.projectiles[i], i, G.projectiles);
    for (let i = G.eprojectiles.length - 1; i >= 0; i--) killProj(G.eprojectiles[i], i, G.eprojectiles);
    for (const e of G.enemies) { if (e.group.parent) e.group.parent.remove(e.group); if (PG.util && PG.util.disposeTree) PG.util.disposeTree(e.group); }
    for (const f of G.fx) {
      if (f.obj.parent) f.obj.parent.remove(f.obj);
      if (f.obj.geometry) f.obj.geometry.dispose();
      if (f.obj.material) f.obj.material.dispose();
    }
    G.projectiles.length = 0;
    G.eprojectiles.length = 0;
    G.enemies.length = 0;
    G.fx.length = 0;
    if (G.view && G.view.root.parent) G.view.root.parent.remove(G.view.root);
    if (G.view && PG.util && PG.util.disposeTree) PG.util.disposeTree(G.view.root);
    G.view = null;
    G.waves = null;
    G.state.boss = null;
  }

  function init(engine) {
    G.scene = engine.scene;
    G.camera = engine.camera;
    G.renderer = engine.renderer;
    G.world = engine.world;
    G.vmScene = engine.vmScene || null;
    G.vmCamera = engine.vmCamera || null;
    G.state.mode = 'idle';
    return G;
  }

  function start(charId) {
    const char = CHARS.find((c) => c.id === charId) || CHARS[0];
    clearSession();
    G.char = char;
    G.state.mode = 'playing';
    G.state.wave = 0;
    G.state.score = 0;
    G.state.combo = 0;
    G.state.comboMax = 0;
    G.state.comboT = 0;
    G.state.time = 0;
    G.state.boss = null;
    enemyIdSeq = 1;
    G.player = makePlayer(char);
    G.player.yaw = 0;
    G.player.pitch = 0;

    try {
      G.view = buildViewmodel(char);
      if (G.vmScene) G.vmScene.add(G.view.root);
      G.view.root.position.copy(G.view.basePos);
    } catch (e) { G.view = null; }

    startWaves();
    if (G.world && G.world.reset) { try { G.world.reset(); } catch (err) {} }
    if (PG.ui) {
      if (PG.ui.setCrosshair) PG.ui.setCrosshair(1, 0);
      if (PG.ui.setObjectives) PG.ui.setObjectives([
        { text: '清剿第 1 波妖物', done: false },
        { text: '守住山海祭坛', done: false },
        { text: '击退全部 ' + WAVE_TOTAL + ' 波', done: false },
      ]);
    }
    if (PG.audio) PG.audio.music('battle');
    applyCamera(1);
    return G.state;
  }

  function pause() { if (G.state.mode === 'playing') G.state.mode = 'paused'; }
  function resume() { if (G.state.mode === 'paused') G.state.mode = 'playing'; }
  function stop() {
    clearSession();
    G.state.mode = 'idle';
    G.player = null;
    G.waves = null;
    G.char = null;
    if (PG.ui && PG.ui.setCrosshair) PG.ui.setCrosshair(0, 0);
  }

  function updateViewmodel(dt) {
    const v = G.view;
    if (!v || !G.player) return;
    const pl = G.player;
    const t = G.state.time;
    const swayX = Math.sin(pl.bobT * 0.5) * (pl.bobAmt || 0) * 1.2;
    const swayY = Math.sin(pl.bobT) * (pl.bobAmt || 0) * 0.8;
    const base = v.basePos;
    v.root.position.x = lerp(v.root.position.x, base.x + swayX, clamp(dt * 12, 0, 1));
    v.root.position.y = lerp(v.root.position.y, base.y + swayY - pl.recoil * 0.02, clamp(dt * 12, 0, 1));
    v.root.position.z = lerp(v.root.position.z, base.z + pl.recoil * 0.06, clamp(dt * 14, 0, 1));
    v.root.rotation.x = lerp(v.root.rotation.x, 0.02 + pl.recoil * 0.16 + (pl.reloading ? Math.sin((1 - pl.reloadT / G.char.gun.reload) * Math.PI) * 0.5 : 0), clamp(dt * 10, 0, 1));
    v.root.rotation.z = lerp(v.root.rotation.z, -swayX * 0.6, clamp(dt * 8, 0, 1));
    v.root.rotation.y = lerp(v.root.rotation.y, 0.34 + swayX * 0.5, clamp(dt * 8, 0, 1));
    v.flash.material.opacity = Math.max(0, v.flash.material.opacity - dt * 9);
    v.ringFx.material.opacity = Math.max(0, v.ringFx.material.opacity - dt * 6);
    v.ringFx.scale.setScalar(0.5 + (1 - v.ringFx.material.opacity) * 0.9);
    if (v.buddy) {
      const kick = v.buddy.userData.kick || 0;
      v.buddy.userData.kick = Math.max(0, kick - dt * 4);
      v.buddy.position.y = -0.28 + Math.sin(t * 2.4) * 0.015 + kick * 0.03;
      v.buddy.rotation.z = Math.sin(t * 1.7) * 0.09;
      v.buddy.rotation.y = Math.PI + Math.sin(t * 0.9) * 0.12;
    }
    const k = pl.ammo / G.char.gun.ammoMax;
    v.core.material.emissiveIntensity = 0.2 + k * 0.8;
  }

  function update(dt, input) {
    if (G.state.mode !== 'playing') { updateFx(dt * 0.25); return; }
    G.state.time += dt;
    if (G.state.comboT > 0) {
      G.state.comboT -= dt;
      if (G.state.comboT <= 0) G.state.combo = 0;
    }
    updatePlayer(dt, input || {});
    updateProjectiles(dt);
    for (const e of G.enemies.slice()) updateEnemy(e, dt, G.state.time);
    updateWaves(dt);
    updateFx(dt);
    applyCamera(dt);
    updateViewmodel(dt);
    pushHud(dt);
  }

  function winGame() {
    if (G.state.mode === 'win' || G.state.mode === 'dead') return;
    G.state.mode = 'win';
    if (PG.audio) PG.audio.music('win');
    if (G.onEnd) G.onEnd('win');
  }

  PG.game = {
    CHARS, ENEMIES, WAVES, WAVE_TOTAL,
    init, start, pause, resume, stop, update, winGame,
    // 调试/QA 用（仅通过 URL 参数或控制台开启，不影响正常玩法）
    setGod(v) { G.god = !!v; },
    setDmgMul(v) { G.dmgMul = v || 1; },
    getDebug() {
      const pl = G.player;
      return {
        god: !!G.god, dmgMul: G.dmgMul || 1, wave: G.state.wave, enemies: aliveCount(),
        queue: G.waves ? G.waves.queue.length : -1,
        shots: pl ? pl.shots : -1, kills: pl ? pl.kills : -1, hits: pl ? pl.hits : -1,
        ammo: pl ? pl.ammo : -1, reloading: pl ? pl.reloading : null,
        fireCd: pl ? +pl.fireCd.toFixed(3) : -1, projectiles: G.projectiles.length,
        eprojectiles: G.eprojectiles.length, fx: G.fx.length,
        enemyStates: G.enemies.slice(0, 3).map((e) => [e.type, +e.pos.x.toFixed(1), +e.pos.z.toFixed(1), e.state, Math.round(e.hp)]),
        mode: G.state.mode,
      };
    },
    get state() { return G.state; },
    get player() { return G.player; },
    get char() { return G.char; },
    get world() { return G.world; },
    get enemies() { return G.enemies; },
    set onEnd(fn) { G.onEnd = fn; },
  };
  PG.enemyCN = CN;
})();
