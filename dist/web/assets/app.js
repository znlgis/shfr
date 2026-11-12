
/* ==================== 10-audio.js ==================== */
/* 10-audio.js — 程序化音效与音乐（PG.audio）
 * ------------------------------------------------------------------
 * 契约 API（CONTRACT.md 3.2）：
 *   init() / sfx(name, opts) / music(cue) / setMuted(bool) / isMuted()
 *   setVolume(v) / getVolume() / setDuck(v)
 *
 * 设计要点：
 *   - 100% WebAudio 程序化合成，不加载任何外部音频文件，单文件离线可玩。
 *   - 总线：masterGain -> compressor(限幅) -> analyser -> destination
 *           sfxBus -> masterGain
 *           musicBus -> duckGain -> masterGain   （setDuck 只压音乐）
 *   - sfx 额外支持 opts.weapon / opts.type 选择武器音色（thunder/wood/fire/water），
 *     这样同一份 "shot" 音效可以给四位行者不同音色；不传则用清脆雷音。
 *   - 同名音效 30ms 内最多 3 次 + 全局 80ms 内最多 20 次，防止叠爆/破音。
 *   - 音乐使用 25ms 间隔、提前 0.18s 排程的 lookahead scheduler，切歌 0.5s 交叉淡入淡出，
 *     同一 cue 重复调用不会重启。
 *   - win / lose 是 4~8 秒的小曲，播完自动回 title（胜利）或静音（失败），
 *     期间若外部又切了歌，则本次接续作废。
 *   - 额外提供一个仅供自检页使用的 __test.offlineCheck()：
 *     用 OfflineAudioContext 把全部音效/音乐各渲染一遍，返回峰值/RMS/异常，用于验证"真的有声音"。
 *   - 任何公开方法都不会抛错；未初始化、未知音效名、浏览器不支持 WebAudio 时静默降级。
 * ------------------------------------------------------------------ */
(() => {
  'use strict';
  const PG = (window.PG = window.PG || {});

  // 模块载入失败时的兜底 API：保证后续模块不被异常打断（其他模块可能直接调用 PG.audio）。
  function makeFallback() {
    const noop = () => {};
    return {
      init: () => null,
      sfx: noop,
      music: noop,
      setMuted: noop,
      isMuted: () => false,
      setVolume: noop,
      getVolume: () => 0.8,
      setDuck: noop,
    };
  }

  let api = null;
  try {
    api = buildApi();
  } catch (err) {
    // 真到了这里说明模块自身有 bug：静音降级并记录，绝不让整份 <script> 停摆。
    try { console.error('[PG.audio] 初始化失败，已降级为静音:', err); } catch (e) {}
    try { if (PG.errors) PG.errors.push('audio: ' + (err && err.message ? err.message : err)); } catch (e) {}
  }
  PG.audio = api || makeFallback();

  // ==================================================================
  //  实现
  // ==================================================================
  function buildApi() {
    // ----------------------------------------------------------------
    // 一、基础工具与全局状态
    // ----------------------------------------------------------------
    const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
    const nowMs = () => (window.performance && performance.now ? performance.now() : Date.now());
    const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

    let ctx = null;            // 在线 AudioContext
    let engine = null;         // 在线引擎（总线 / 噪声 / 混响）
    let muted = false;
    let volume = 0.8;          // 用户音量 0..1
    let duck = 1;              // 音乐压低系数 0..1
    let currentCue = 'none';   // 正在播放的音乐 cue
    let currentTrack = null;   // 正在播放的 track 对象
    let pendingCue = null;     // init 之前请求的 cue
    let musicEpoch = 0;        // 切歌令牌：让"小曲播完自动接续"不会覆盖后来的切歌
    let lastError = null;
    let unlockBound = false;

    // 限流参数（契约：同名 30ms 内最多 3 次）
    const THROTTLE_WINDOW = 30;
    const THROTTLE_MAX = 3;
    const GLOBAL_WINDOW = 80;
    const GLOBAL_MAX = 20;
    const throttleMap = Object.create(null);
    let globalWindowAt = 0;
    let globalCount = 0;

    // 音乐排程参数
    const LOOKAHEAD = 0.18;    // 提前排程的秒数
    const SCHEDULER_MS = 25;   // 调度器间隔
    const MUSIC_FADE = 0.5;    // 切歌淡入淡出时长

    // ----------------------------------------------------------------
    // 二、缓冲区：噪声 / 混响脉冲（按采样率缓存，离线自检复用）
    // ----------------------------------------------------------------
    const bufferCache = { noise: Object.create(null), impulse: Object.create(null) };

    function buildNoiseBuffer(c, seconds) {
      const n = Math.max(64, Math.floor(c.sampleRate * seconds));
      const buf = c.createBuffer(1, n, c.sampleRate);
      const data = buf.getChannelData(0);
      // 白噪声为主，掺一点布朗噪声让低频更自然（后面再按需滤波）
      let brown = 0;
      for (let i = 0; i < n; i++) {
        const w = Math.random() * 2 - 1;
        brown = (brown + 0.02 * w) / 1.02;
        data[i] = w * 0.85 + brown * 2.0;
      }
      let peak = 0;
      for (let i = 0; i < n; i++) {
        const a = Math.abs(data[i]);
        if (a > peak) peak = a;
      }
      if (peak > 0) {
        const k = 0.9 / peak;
        for (let i = 0; i < n; i++) data[i] *= k;
      }
      return buf;
    }

    function buildImpulse(c, seconds, decay) {
      const n = Math.max(64, Math.floor(c.sampleRate * seconds));
      const buf = c.createBuffer(2, n, c.sampleRate);
      const pre = Math.floor(c.sampleRate * 0.012); // 12ms 预延迟
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        let peak = 0;
        for (let i = 0; i < n; i++) {
          const x = i / n;
          const env = Math.pow(1 - x, decay);
          const v = i < pre ? 0 : (Math.random() * 2 - 1) * env;
          d[i] = v;
          const a = Math.abs(v);
          if (a > peak) peak = a;
        }
        if (peak > 0) {
          const k = 0.6 / peak;
          for (let i = 0; i < n; i++) d[i] *= k;
        }
      }
      return buf;
    }

    function getNoise(c) {
      const key = String(c.sampleRate);
      if (!bufferCache.noise[key]) bufferCache.noise[key] = buildNoiseBuffer(c, 2.0);
      return bufferCache.noise[key];
    }

    function getImpulse(c) {
      const key = String(c.sampleRate);
      if (!bufferCache.impulse[key]) bufferCache.impulse[key] = buildImpulse(c, 1.8, 2.8);
      return bufferCache.impulse[key];
    }

    // ----------------------------------------------------------------
    // 三、引擎：输出链 + 母线 + 混响
    // ----------------------------------------------------------------
    function createEngine(c) {
      const e = { ctx: c };
      e.noise = getNoise(c);

      // 主输出：masterGain -> compressor -> analyser -> destination
      const master = c.createGain();
      master.gain.value = 0.8;
      const comp = c.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 22;
      comp.ratio.value = 8;
      comp.attack.value = 0.004;
      comp.release.value = 0.22;
      const analyser = c.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.72;
      master.connect(comp);
      comp.connect(analyser);
      analyser.connect(c.destination);
      e.master = master;
      e.comp = comp;
      e.analyser = analyser;

      // 程序化混响（音乐厅感，给清脆的电子音一点空间）
      const revIn = c.createGain();
      revIn.gain.value = 1;
      const conv = c.createConvolver();
      try {
        conv.buffer = getImpulse(c);
      } catch (err) {
        conv.buffer = buildImpulse(c, 1.8, 2.8);
      }
      const revTone = c.createBiquadFilter();
      revTone.type = 'lowpass';
      revTone.frequency.value = 4500;
      const revOut = c.createGain();
      revOut.gain.value = 0.5;
      revIn.connect(conv);
      conv.connect(revTone);
      revTone.connect(revOut);
      revOut.connect(master);
      e.revIn = revIn;

      // 两条独立的音效 / 音乐总线
      const sfxBus = c.createGain();
      sfxBus.gain.value = 0.95;
      sfxBus.connect(master);
      const sfxRev = c.createGain();
      sfxRev.gain.value = 0.9;
      sfxRev.connect(revIn);
      const duckGain = c.createGain();
      duckGain.gain.value = 1;
      duckGain.connect(master);
      const musicBus = c.createGain();
      musicBus.gain.value = 0.45; // 音乐垫在音效下面，避免枪声被 BGM 盖住
      musicBus.connect(duckGain);
      e.sfxBus = sfxBus;
      e.sfxRev = sfxRev;
      e.duckGain = duckGain;
      e.musicBus = musicBus;
      return e;
    }

    // ----------------------------------------------------------------
    // 四、合成原语：包络 / 滤波 / 振荡器 / 噪声
    // ----------------------------------------------------------------
    // ADSR 简化版：0 -> peak（a 秒）-> 保持 hold -> 指数衰减到静音（d 秒）
    function envelope(param, t, peak, a, d, hold) {
      const atk = Math.max(0.001, a == null ? 0.005 : a);
      const dec = Math.max(0.006, d == null ? 0.12 : d);
      const hld = Math.max(0, hold == null ? 0 : hold);
      const pk = Math.max(0.0002, peak == null ? 0.2 : peak);
      param.setValueAtTime(0.0002, t);
      param.exponentialRampToValueAtTime(pk, t + atk);
      if (hld > 0) param.setValueAtTime(pk, t + atk + hld);
      param.exponentialRampToValueAtTime(0.0002, t + atk + hld + dec);
      return atk + hld + dec;
    }

    function makeFilter(c, cfg, t) {
      const f = c.createBiquadFilter();
      f.type = cfg.type || 'lowpass';
      const f0 = Math.max(20, cfg.freq == null ? 1200 : cfg.freq);
      f.frequency.setValueAtTime(f0, t);
      if (cfg.to != null) {
        const to = Math.max(20, cfg.to);
        const tt = t + Math.max(0.005, cfg.time == null ? 0.2 : cfg.time);
        if (cfg.sweep === 'linear') f.frequency.linearRampToValueAtTime(to, tt);
        else f.frequency.exponentialRampToValueAtTime(to, tt);
      }
      f.Q.value = cfg.q == null ? 0.7 : cfg.q;
      return f;
    }

    // 共享的"混响发送"小节点：避免每个音符都新建 send gain（节点泄漏/开销）
    function sendNode(V, send) {
      if (!send || send <= 0 || !V.rev) return null;
      const key = Math.round(send * 20) / 20; // 5% 一档，够用且不会建太多节点
      if (!V.sends) V.sends = Object.create(null);
      let node = V.sends[key];
      if (!node) {
        node = V.ctx.createGain();
        node.gain.value = key;
        node.connect(V.rev);
        V.sends[key] = node;
      }
      return node;
    }

    function routeTo(V, node, send) {
      node.connect(V.dest);
      const s = sendNode(V, send);
      if (s) node.connect(s);
    }

    /** 振荡器音：可扫频、可滤波、可选颤音、可送混响。
     *  V: { ctx, noise, dest, rev, rate, sends }
     *  cfg: { type, f, f1, t, a, d, hold, vol, detune, filter, send, sweepTime, sweep, vibrato, vibRate }
     */
    function tone(V, cfg) {
      const c = V.ctx;
      const t = cfg.t == null ? c.currentTime : cfg.t;
      const rate = cfg.rate == null ? (V.rate || 1) : cfg.rate;
      const a = cfg.a == null ? 0.005 : cfg.a;
      const d = cfg.d == null ? 0.12 : cfg.d;
      const hold = cfg.hold == null ? 0 : cfg.hold;
      const vol = cfg.vol == null ? 0.2 : cfg.vol;

      const o = c.createOscillator();
      o.type = cfg.type || 'sine';
      const f0 = Math.max(0.5, (cfg.f || 440) * rate);
      o.frequency.setValueAtTime(f0, t);
      if (cfg.f1 != null) {
        const f1 = Math.max(0.5, cfg.f1 * rate);
        if (Math.abs(f1 - f0) > 0.01) {
          const st = t + Math.max(0.008, cfg.sweepTime == null ? d : cfg.sweepTime);
          if (cfg.sweep === 'linear') o.frequency.linearRampToValueAtTime(f1, st);
          else o.frequency.exponentialRampToValueAtTime(f1, st);
        }
      }
      if (cfg.detune) o.detune.setValueAtTime(cfg.detune, t);

      let tail = o;
      if (cfg.filter) {
        const flt = makeFilter(c, cfg.filter, t);
        tail.connect(flt);
        tail = flt;
      }
      const g = c.createGain();
      const len = envelope(g.gain, t, vol, a, d, hold);
      tail.connect(g);
      routeTo(V, g, cfg.send || 0);

      o.start(t);
      o.stop(t + len + 0.05);

      if (cfg.vibrato) {
        const lfo = c.createOscillator();
        lfo.type = 'sine';
        lfo.frequency.value = cfg.vibRate || 5.2;
        const lg = c.createGain();
        lg.gain.value = cfg.vibrato; // 单位：音分
        lfo.connect(lg);
        lg.connect(o.detune);
        lfo.start(t);
        lfo.stop(t + len + 0.05);
      }
      return o;
    }

    /** 噪声爆音：白噪声 + biquad 塑形，可做"沙沙 / 爆炸 / 风声 / whoosh" */
    function noiseBurst(V, cfg) {
      const c = V.ctx;
      const t = cfg.t == null ? c.currentTime : cfg.t;
      const rate = cfg.rate == null ? (V.rate || 1) : cfg.rate;
      const src = c.createBufferSource();
      src.buffer = V.noise;
      src.loop = true;
      src.playbackRate.value = clamp(rate, 0.25, 4);

      let tail = src;
      if (cfg.filter) {
        const flt = makeFilter(c, cfg.filter, t);
        tail.connect(flt);
        tail = flt;
      }
      const g = c.createGain();
      const len = envelope(
        g.gain, t,
        cfg.vol == null ? 0.15 : cfg.vol,
        cfg.a == null ? 0.002 : cfg.a,
        cfg.d == null ? 0.1 : cfg.d,
        cfg.hold || 0
      );
      tail.connect(g);
      routeTo(V, g, cfg.send || 0);

      const off = cfg.offset == null ? Math.random() * 1.6 : cfg.offset;
      src.start(t, off);
      src.stop(t + len + 0.06);
      return src;
    }

    // 和弦号角（波次提示 / win 小曲共用）
    function hornChord(V, t, freqs, dur, vol) {
      const a = 0.09;
      const d = Math.max(0.15, dur * 0.45);
      const hold = Math.max(0.05, dur - a - d);
      for (let i = 0; i < freqs.length; i++) {
        const f = freqs[i];
        for (let k = 0; k < 2; k++) {
          tone(V, {
            type: 'sawtooth', f, t, a, hold, d, vol,
            detune: k === 0 ? -7 : 7,
            filter: { type: 'lowpass', freq: 1600, to: 900, time: dur, q: 0.8 },
            send: 0.22,
          });
        }
      }
    }

    // ----------------------------------------------------------------
    // 五、音乐乐器（全部程序化；V 由 track 提供，共享混响发送节点）
    // ----------------------------------------------------------------
    // 音乐盒 / 钟琴：基频 + 八度 + 三倍泛音，轻盈的国风清音
    function iBell(V, t, midi, dur, vol) {
      const f = midiHz(midi);
      tone(V, { type: 'sine', f, t, a: 0.004, d: dur, vol, send: 0.55 });
      tone(V, { type: 'sine', f: f * 2.004, t, a: 0.003, d: dur * 0.55, vol: vol * 0.26, send: 0.5 });
      tone(V, { type: 'sine', f: f * 3.01, t, a: 0.002, d: dur * 0.3, vol: vol * 0.07, send: 0.45 });
    }

    // 拨弦 / 短促电子音
    function iPluck(V, t, midi, dur, vol, type) {
      const f = midiHz(midi);
      tone(V, {
        type: type || 'triangle', f, t, a: 0.004, d: dur, vol,
        filter: { type: 'lowpass', freq: 3200, to: 1100, time: Math.max(0.05, dur) },
        send: 0.16,
      });
      tone(V, {
        type: 'sawtooth', f: f * 1.006, t, a: 0.004, d: dur * 0.75, vol: vol * 0.2,
        filter: { type: 'lowpass', freq: 1900, to: 900, time: Math.max(0.05, dur) },
        send: 0.12,
      });
    }

    // 低音：三角波 + 半频正弦，温暖不轰头
    function iBass(V, t, midi, dur, vol, type) {
      const f = midiHz(midi);
      const a = 0.01;
      const d = Math.max(0.08, dur * 0.5);
      const hold = Math.max(0.02, dur - a - d);
      tone(V, {
        type: type || 'triangle', f, t, a, hold, d, vol,
        filter: { type: 'lowpass', freq: 520, q: 0.9 }, send: 0.05,
      });
      tone(V, { type: 'sine', f: f / 2, t, a: a * 2, hold, d, vol: vol * 0.45, filter: { type: 'lowpass', freq: 220 } });
    }

    // 柔和 pad：两路失谐三角波，慢起慢落
    function iPad(V, t, midis, dur, vol) {
      const a = Math.min(0.9, Math.max(0.2, dur * 0.16));
      const d = Math.max(0.6, dur * 0.3);
      const hold = Math.max(0.05, dur - a - d);
      for (let i = 0; i < midis.length; i++) {
        const f = midiHz(midis[i]);
        for (let k = 0; k < 2; k++) {
          tone(V, {
            type: 'triangle', f, t, a, hold, d,
            vol: vol / midis.length,
            detune: k === 0 ? -8 : 8,
            filter: { type: 'lowpass', freq: 1200, q: 0.6, to: 700, time: dur },
            send: 0.6,
          });
        }
      }
    }

    // 长笛：三角波 + 八度正弦 + 气声噪声 + 轻微颤音
    function iFlute(V, t, midi, dur, vol) {
      const f = midiHz(midi);
      const a = 0.07;
      const d = Math.max(0.08, dur * 0.4);
      const hold = Math.max(0.02, dur - a - d);
      tone(V, {
        type: 'triangle', f, t, a, hold, d, vol,
        vibrato: 7, vibRate: 5.1,
        filter: { type: 'lowpass', freq: 2600 }, send: 0.35,
      });
      tone(V, {
        type: 'sine', f: f * 2, t, a: a * 1.2, hold, d,
        vol: vol * 0.2, vibrato: 5, vibRate: 5.1, send: 0.3,
      });
      noiseBurst(V, {
        t, a: 0.03, hold: Math.max(0.01, dur * 0.3), d: Math.max(0.05, dur * 0.35),
        vol: vol * 0.12,
        filter: { type: 'bandpass', freq: f * 4, q: 3 }, send: 0.2,
      });
    }

    // 木质打击（木鱼 / 木琴）
    function iWood(V, t, vol) {
      tone(V, { type: 'sine', f: 560, f1: 380, t, a: 0.002, d: 0.11, vol: vol * 1.2, send: 0.3 });
      tone(V, { type: 'triangle', f: 1120, f1: 760, t, a: 0.002, d: 0.06, vol: vol * 0.4 });
      noiseBurst(V, { t, a: 0.001, d: 0.045, vol: vol * 0.55, filter: { type: 'bandpass', freq: 1800, q: 5 } });
    }

    function iKick(V, t, vol) {
      tone(V, { type: 'sine', f: 150, f1: 44, t, a: 0.004, d: 0.2, vol, send: 0.06 });
      noiseBurst(V, { t, a: 0.001, d: 0.02, vol: vol * 0.25, filter: { type: 'highpass', freq: 1500 } });
    }

    function iSnare(V, t, vol) {
      noiseBurst(V, { t, a: 0.002, d: 0.13, vol: vol * 0.85, filter: { type: 'bandpass', freq: 1900, q: 0.9 }, send: 0.18 });
      tone(V, { type: 'triangle', f: 190, f1: 120, t, a: 0.002, d: 0.09, vol: vol * 0.45 });
      noiseBurst(V, { t, a: 0.001, d: 0.03, vol: vol * 0.3, filter: { type: 'highpass', freq: 4000 } });
    }

    function iHat(V, t, vol) {
      noiseBurst(V, { t, a: 0.001, d: 0.035, vol, filter: { type: 'highpass', freq: 7200 } });
    }

    function iShaker(V, t, vol) {
      noiseBurst(V, { t, a: 0.01, d: 0.08, vol, filter: { type: 'highpass', freq: 5000 }, send: 0.1 });
    }

    function iTom(V, t, vol) {
      tone(V, { type: 'sine', f: 150, f1: 62, t, a: 0.004, d: 0.26, vol, send: 0.15 });
      noiseBurst(V, { t, a: 0.002, d: 0.06, vol: vol * 0.18, filter: { type: 'lowpass', freq: 600 } });
    }

    function iBrass(V, t, midis, dur, vol) {
      const a = 0.05;
      const d = Math.max(0.1, dur * 0.5);
      const hold = Math.max(0.05, dur - a - d);
      for (let i = 0; i < midis.length; i++) {
        const f = midiHz(midis[i]);
        tone(V, {
          type: 'sawtooth', f, t, a, hold, d, vol,
          filter: { type: 'lowpass', freq: 2000, to: 1200, time: dur, q: 0.9 }, send: 0.25,
        });
        tone(V, {
          type: 'sawtooth', f, t, a, hold, d, vol: vol * 0.6, detune: 9,
          filter: { type: 'lowpass', freq: 1600, to: 900, time: dur }, send: 0.25,
        });
      }
    }

    // 噪声渐强（BOSS 压迫感 / 转场）
    function iSwell(V, t, dur, vol) {
      noiseBurst(V, {
        t, a: Math.max(0.1, dur * 0.8), hold: 0.02, d: Math.max(0.15, dur * 0.3), vol,
        filter: { type: 'bandpass', freq: 300, q: 1.8, to: 2600, time: dur }, send: 0.4,
      });
      tone(V, { type: 'sine', f: 55, f1: 110, t, a: Math.max(0.1, dur * 0.75), hold: 0.04, d: Math.max(0.2, dur * 0.4), vol: vol * 0.9, send: 0.2 });
    }

    function iTimpani(V, t, midi, vol) {
      const f = midiHz(midi);
      tone(V, { type: 'sine', f, f1: f * 0.82, t, a: 0.004, d: 0.5, vol, send: 0.35 });
      noiseBurst(V, { t, a: 0.002, d: 0.12, vol: vol * 0.3, filter: { type: 'lowpass', freq: 500 } });
    }

    // ----------------------------------------------------------------
    // 六、音效（契约 3.2 全部 25 个名字 + 武器音色变体）
    // ----------------------------------------------------------------
    // 属性键 / 法器别名 -> 音色族（雷 / 木 / 火 / 水）
    const TIMBRES = {
      lei: 'thunder', bolt: 'thunder', thunder: 'thunder',
      mu: 'wood', seed: 'wood', leaf: 'wood', wood: 'wood',
      huo: 'fire', ember: 'fire', flame: 'fire', fire: 'fire',
      shui: 'water', tide: 'water', water: 'water',
    };
    const TIMBRE_ORDER = ['thunder', 'fire', 'water', 'wood'];

    function normTimbre(w) {
      if (w == null) return null;
      if (typeof w === 'number') return TIMBRE_ORDER[((w % 4) + 4) % 4];
      const key = String(w).toLowerCase().replace(/^t_/, '');
      return TIMBRES[key] || null;
    }

    // 四种法器的射击音色：雷=高频方波+噪声 / 火=低沉噪声爆炸 / 水=气泡+正弦扫频 / 木=木质短促
    function weaponShot(V, heavy) {
      const t = V.t;
      const timbre = V.timbre || 'thunder';
      // 轻微随机音高，避免连发时像复读机
      const jitter = 1 + (Math.random() - 0.5) * 0.04;
      if (timbre === 'fire') {
        const dur = heavy ? 0.42 : 0.26;
        tone(V, { type: 'sine', f: 180 * jitter, f1: 48, t, a: 0.004, d: dur, vol: 0.3, send: 0.12 });
        noiseBurst(V, {
          t, a: 0.006, d: dur * 1.05, vol: heavy ? 0.3 : 0.22,
          filter: { type: 'lowpass', freq: 1600, to: 220, time: dur }, send: 0.1,
        });
        noiseBurst(V, { t: t + 0.01, a: 0.002, d: 0.05, vol: 0.055, filter: { type: 'highpass', freq: 2600 } });
        if (heavy) tone(V, { type: 'triangle', f: 90, f1: 55, t: t + 0.03, a: 0.01, d: 0.3, vol: 0.14 });
        return;
      }
      if (timbre === 'water') {
        tone(V, { type: 'sine', f: 240 * jitter, f1: heavy ? 1200 : 900, t, a: 0.006, d: heavy ? 0.2 : 0.15, vol: 0.2 });
        tone(V, { type: 'sine', f: 760, f1: heavy ? 300 : 380, t: t + 0.02, a: 0.01, d: 0.2, vol: 0.1 });
        noiseBurst(V, {
          t, a: 0.01, d: 0.2, vol: 0.08,
          filter: { type: 'bandpass', freq: 1100, q: 3.5, to: 500, time: 0.2 }, send: 0.12,
        });
        tone(V, { type: 'sine', f: 1500, f1: 600, t: t + 0.01, a: 0.002, d: 0.05, vol: 0.08 });
        if (heavy) tone(V, { type: 'sine', f: 200, f1: 1200, t: t + 0.12, a: 0.01, d: 0.22, vol: 0.16 });
        return;
      }
      if (timbre === 'wood') {
        tone(V, { type: 'triangle', f: 620 * jitter, f1: 280, t, a: 0.003, d: 0.09, vol: 0.17, filter: { type: 'lowpass', freq: 2200 } });
        noiseBurst(V, {
          t, a: 0.002, d: 0.06, vol: 0.09,
          filter: { type: 'bandpass', freq: 1500, q: 6, to: 900, time: 0.06 },
        });
        tone(V, { type: 'sine', f: 190, f1: 130, t, a: 0.004, d: 0.06, vol: 0.08 });
        if (heavy) {
          for (let i = 0; i < 3; i++) {
            tone(V, {
              type: 'triangle', f: (520 + i * 90) * jitter, f1: 240, t: t + i * 0.05,
              a: 0.002, d: 0.07, vol: 0.09, filter: { type: 'lowpass', freq: 2000 },
            });
          }
          noiseBurst(V, { t: t + 0.04, a: 0.01, d: 0.18, vol: 0.05, filter: { type: 'highpass', freq: 3200 } });
        }
        return;
      }
      // thunder（默认）：清脆雷音"啾 / 啪"
      const f = (heavy ? 1300 : 1700) * jitter;
      tone(V, {
        type: 'square', f, f1: heavy ? 380 : 460, t, a: 0.002, d: heavy ? 0.13 : 0.1,
        vol: heavy ? 0.18 : 0.14, filter: { type: 'lowpass', freq: 5200 },
      });
      tone(V, {
        type: 'sawtooth', f: f * 0.76, f1: 300, t: t + 0.006, a: 0.002, d: 0.08, vol: 0.07,
        filter: { type: 'lowpass', freq: 3800 },
      });
      noiseBurst(V, { t, a: 0.001, d: 0.055, vol: heavy ? 0.13 : 0.09, filter: { type: 'highpass', freq: 2200 } });
      tone(V, { type: 'sine', f: 320, f1: 170, t, a: 0.002, d: 0.05, vol: 0.09 });
      if (heavy) {
        tone(V, {
          type: 'square', f: 2200, f1: 900, t: t + 0.03, a: 0.002, d: 0.12, vol: 0.07,
          filter: { type: 'lowpass', freq: 6000 },
        });
      }
    }

    const SFX = {
      // --- UI：极短、柔和，不抢戏 ---
      ui_hover(V) {
        tone(V, { type: 'sine', f: 1320, f1: 1560, t: V.t, a: 0.004, d: 0.05, vol: 0.05 });
        tone(V, { type: 'triangle', f: 2640, t: V.t, a: 0.002, d: 0.025, vol: 0.012 });
      },
      ui_click(V) {
        const t = V.t;
        tone(V, { type: 'square', f: 900, f1: 680, t, a: 0.002, d: 0.055, vol: 0.06, filter: { type: 'lowpass', freq: 3200 } });
        noiseBurst(V, { t, a: 0.001, d: 0.022, vol: 0.03, filter: { type: 'highpass', freq: 4200 } });
      },
      ui_back(V) {
        const t = V.t;
        tone(V, { type: 'square', f: 720, f1: 540, t, a: 0.002, d: 0.07, vol: 0.055, filter: { type: 'lowpass', freq: 2600 } });
        tone(V, { type: 'square', f: 500, f1: 360, t: t + 0.065, a: 0.002, d: 0.09, vol: 0.045, filter: { type: 'lowpass', freq: 2200 } });
      },
      // 选中：两个音的上行（山海菜单确认音）
      select(V) {
        const t = V.t;
        tone(V, { type: 'sine', f: 660, t, a: 0.003, d: 0.09, vol: 0.08, send: 0.2 });
        tone(V, { type: 'sine', f: 990, t: t + 0.07, a: 0.003, d: 0.16, vol: 0.085, send: 0.25 });
        tone(V, { type: 'sine', f: 1980, t: t + 0.07, a: 0.002, d: 0.07, vol: 0.025 });
      },

      // --- 战斗：射击 ---
      shot(V) { weaponShot(V, false); },
      shot_alt(V) { weaponShot(V, true); },

      reload(V) {
        const t = V.t;
        noiseBurst(V, { t, a: 0.001, d: 0.025, vol: 0.08, filter: { type: 'highpass', freq: 3200 } });
        noiseBurst(V, { t: t + 0.11, a: 0.001, d: 0.03, vol: 0.07, filter: { type: 'highpass', freq: 3600 } });
        tone(V, { type: 'sine', f: 190, f1: 90, t: t + 0.17, a: 0.003, d: 0.1, vol: 0.12, filter: { type: 'lowpass', freq: 500 } });
        tone(V, { type: 'triangle', f: 2200, f1: 1400, t: t + 0.12, a: 0.002, d: 0.05, vol: 0.04 });
      },
      empty(V) {
        const t = V.t;
        for (let i = 0; i < 2; i++) {
          const st = t + i * 0.085;
          tone(V, { type: 'square', f: 190, f1: 95, t: st, a: 0.001, d: 0.045, vol: 0.08, filter: { type: 'lowpass', freq: 1400 } });
          noiseBurst(V, { t: st, a: 0.001, d: 0.02, vol: 0.05, filter: { type: 'highpass', freq: 2600 } });
        }
      },

      // --- 命中 / 击杀 / 受伤 ---
      hit(V) {
        const t = V.t;
        noiseBurst(V, { t, a: 0.001, d: 0.05, vol: 0.13, filter: { type: 'bandpass', freq: 1800, q: 1.6, to: 900, time: 0.05 } });
        tone(V, { type: 'square', f: 300, f1: 150, t, a: 0.002, d: 0.05, vol: 0.07, filter: { type: 'lowpass', freq: 1800 } });
        tone(V, { type: 'sine', f: 520, f1: 240, t, a: 0.002, d: 0.04, vol: 0.06 });
      },
      crit(V) {
        const t = V.t;
        tone(V, { type: 'triangle', f: 2400, f1: 1150, t, a: 0.002, d: 0.18, vol: 0.13, send: 0.2 });
        tone(V, { type: 'sine', f: 3300, f1: 1600, t: t + 0.01, a: 0.002, d: 0.12, vol: 0.09 });
        noiseBurst(V, { t, a: 0.001, d: 0.08, vol: 0.14, filter: { type: 'highpass', freq: 3000 } });
        tone(V, { type: 'sine', f: 190, f1: 80, t, a: 0.003, d: 0.14, vol: 0.15 });
        tone(V, { type: 'square', f: 1250, f1: 620, t: t + 0.02, a: 0.002, d: 0.1, vol: 0.05, filter: { type: 'bandpass', freq: 2000, q: 2 } });
      },
      kill(V) {
        const t = V.t;
        tone(V, { type: 'sawtooth', f: 920, f1: 120, t, a: 0.004, d: 0.28, vol: 0.13, filter: { type: 'lowpass', freq: 2400 } });
        noiseBurst(V, { t, a: 0.01, d: 0.32, vol: 0.18, filter: { type: 'lowpass', freq: 2200, to: 200, time: 0.34 }, send: 0.15 });
        tone(V, { type: 'sine', f: 130, f1: 42, t: t + 0.02, a: 0.006, d: 0.34, vol: 0.2, send: 0.2 });
        noiseBurst(V, { t, a: 0.001, d: 0.06, vol: 0.08, filter: { type: 'highpass', freq: 4000 } });
        // 卡通化的"啵"
        tone(V, { type: 'sine', f: 700, f1: 340, t: t + 0.02, a: 0.006, d: 0.12, vol: 0.07 });
      },
      hurt(V) {
        const t = V.t;
        tone(V, { type: 'sine', f: 150, f1: 58, t, a: 0.004, d: 0.2, vol: 0.24, filter: { type: 'lowpass', freq: 420 } });
        noiseBurst(V, { t, a: 0.002, d: 0.12, vol: 0.13, filter: { type: 'lowpass', freq: 600, to: 200, time: 0.12 } });
        tone(V, { type: 'triangle', f: 230, f1: 96, t, a: 0.003, d: 0.1, vol: 0.07 });
      },
      heal(V) {
        const t = V.t;
        const notes = [1046, 1318, 1568];
        for (let i = 0; i < notes.length; i++) {
          const f = notes[i], st = t + i * 0.075;
          tone(V, { type: 'sine', f, t: st, a: 0.004, d: 0.5, vol: 0.07, send: 0.45 });
          tone(V, { type: 'sine', f: f * 2, t: st, a: 0.003, d: 0.28, vol: 0.025 });
        }
        noiseBurst(V, { t: t + 0.05, a: 0.08, d: 0.5, vol: 0.02, filter: { type: 'highpass', freq: 6000 }, send: 0.5 });
      },
      levelup(V) {
        const t = V.t;
        const notes = [523.25, 659.25, 783.99, 1046.5];
        for (let i = 0; i < notes.length; i++) {
          const st = t + i * 0.085;
          tone(V, { type: 'triangle', f: notes[i], t: st, a: 0.004, d: i === 3 ? 0.5 : 0.16, vol: 0.09, send: 0.3 });
          tone(V, { type: 'square', f: notes[i] * 2, t: st, a: 0.002, d: 0.08, vol: 0.03, filter: { type: 'lowpass', freq: 5000 } });
        }
        tone(V, { type: 'sine', f: 300, f1: 900, t, a: 0.02, d: 0.55, vol: 0.04, send: 0.3 });
      },
      wave(V) {
        const t = V.t;
        // 两段号角式和弦 C -> G，营造"下一波来了"的推进感
        hornChord(V, t, [130.81, 196.0, 261.63], 0.55, 0.06);
        hornChord(V, t + 0.62, [196.0, 246.94, 293.66], 1.1, 0.07);
        tone(V, { type: 'sine', f: 65.4, t, a: 0.03, d: 1.6, vol: 0.1, send: 0.25 });
      },
      boss_roar(V) {
        const t = V.t;
        // 双锯齿失谐 + 下滑 = 低沉吼叫
        for (let i = 0; i < 2; i++) {
          tone(V, {
            type: 'sawtooth', f: 92, f1: 48, t, a: 0.06, hold: 0.25, d: 0.85, vol: 0.16,
            detune: i === 0 ? 0 : 13,
            filter: { type: 'lowpass', freq: 620, to: 160, time: 1.0 }, send: 0.25,
          });
        }
        noiseBurst(V, {
          t: t + 0.05, a: 0.18, hold: 0.2, d: 0.9, vol: 0.2,
          filter: { type: 'lowpass', freq: 700, to: 120, time: 1.05 }, send: 0.2,
        });
        tone(V, { type: 'sine', f: 62, f1: 34, t, a: 0.05, d: 1.05, vol: 0.2 });
        // 低频方波 LFO 调制第三层锯齿的 detune，做出"咕噜咕噜"的兽吼质感
        const c = V.ctx;
        const o = c.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(140, t);
        o.frequency.exponentialRampToValueAtTime(70, t + 0.9);
        const lfo = c.createOscillator();
        lfo.type = 'square';
        lfo.frequency.value = 9.5;
        const lg = c.createGain();
        lg.gain.value = 55;
        lfo.connect(lg);
        lg.connect(o.detune);
        const g = c.createGain();
        envelope(g.gain, t, 0.08, 0.08, 0.85);
        const f = c.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 800;
        o.connect(f);
        f.connect(g);
        routeTo(V, g, 0.2);
        o.start(t);
        o.stop(t + 1.0);
        lfo.start(t);
        lfo.stop(t + 1.0);
      },

      // --- 移动 / 拾取 ---
      jump(V) {
        const t = V.t;
        tone(V, { type: 'sine', f: 320, f1: 700, t, a: 0.004, d: 0.12, vol: 0.09 });
        noiseBurst(V, { t, a: 0.004, d: 0.07, vol: 0.035, filter: { type: 'highpass', freq: 2500 } });
      },
      dash(V) {
        const t = V.t;
        noiseBurst(V, { t, a: 0.02, d: 0.18, vol: 0.13, filter: { type: 'bandpass', freq: 500, q: 1.2, to: 3200, time: 0.17 }, send: 0.15 });
        noiseBurst(V, { t: t + 0.02, a: 0.06, d: 0.16, vol: 0.04, filter: { type: 'highpass', freq: 2800 } });
        tone(V, { type: 'sine', f: 180, f1: 420, t, a: 0.01, d: 0.16, vol: 0.04 });
      },
      combo(V) {
        const t = V.t;
        const notes = [880, 1174.7];
        for (let i = 0; i < notes.length; i++) {
          tone(V, { type: 'square', f: notes[i], t: t + i * 0.06, a: 0.002, d: 0.07, vol: 0.07, filter: { type: 'lowpass', freq: 4200 } });
        }
        tone(V, { type: 'sine', f: 1760, t: t + 0.06, a: 0.002, d: 0.09, vol: 0.03 });
      },
      orb(V) {
        const t = V.t;
        tone(V, { type: 'sine', f: 988, t, a: 0.002, d: 0.07, vol: 0.08, send: 0.2 });
        tone(V, { type: 'sine', f: 1318.5, t: t + 0.07, a: 0.002, d: 0.18, vol: 0.085, send: 0.25 });
        tone(V, { type: 'sine', f: 2637, t: t + 0.07, a: 0.002, d: 0.06, vol: 0.02 });
      },
      spawn(V) {
        const t = V.t;
        tone(V, { type: 'sine', f: 100, f1: 46, t, a: 0.01, d: 0.4, vol: 0.16, send: 0.2 });
        noiseBurst(V, {
          t, a: 0.04, d: 0.36, vol: 0.1,
          filter: { type: 'bandpass', freq: 380, q: 1.4, to: 1100, time: 0.32 }, send: 0.2,
        });
        for (let i = 0; i < 2; i++) {
          tone(V, { type: 'triangle', f: 1400 + i * 500, t: t + 0.12 + i * 0.08, a: 0.002, d: 0.07, vol: 0.035 });
        }
      },
      // 森林环境音：微风 + 几声鸟鸣（game 可隔几秒随机播一次）
      amb(V) {
        const t = V.t;
        noiseBurst(V, {
          t, a: 0.35, hold: 0.25, d: 0.85, vol: 0.045,
          filter: { type: 'lowpass', freq: 900, q: 0.5, to: 500, time: 1.2 }, send: 0.4,
        });
        const bird = (st, f0, f1, pan) => {
          const c = V.ctx;
          const o = c.createOscillator();
          o.type = 'sine';
          o.frequency.setValueAtTime(f0, st);
          o.frequency.exponentialRampToValueAtTime(f1, st + 0.05);
          const g = c.createGain();
          envelope(g.gain, st, 0.04, 0.004, 0.06);
          o.connect(g);
          if (c.createStereoPanner) {
            const p = c.createStereoPanner();
            p.pan.value = pan;
            g.connect(p);
            p.connect(V.dest);
          } else {
            g.connect(V.dest);
          }
          o.start(st);
          o.stop(st + 0.12);
        };
        bird(t + 0.16, 2300, 2900, -0.5);
        bird(t + 0.28, 2600, 3200, 0.4);
        bird(t + 0.72, 2100, 2600, -0.2);
      },

      // --- 短小的胜利 / 失败音（音乐层另有更长的 win / lose 小曲） ---
      win(V) {
        const t = V.t;
        const notes = [523.25, 659.25, 783.99, 1046.5];
        for (let i = 0; i < notes.length; i++) {
          tone(V, { type: 'triangle', f: notes[i], t: t + i * 0.1, a: 0.004, d: 0.2, vol: 0.09, send: 0.3 });
        }
        hornChord(V, t + 0.42, [523.25, 659.25, 783.99], 0.9, 0.055);
        tone(V, { type: 'sine', f: 130.81, t: t + 0.42, a: 0.01, d: 0.9, vol: 0.1, send: 0.2 });
      },
      lose(V) {
        const t = V.t;
        const notes = [392, 349.23, 293.66, 261.63];
        for (let i = 0; i < notes.length; i++) {
          const st = t + i * 0.18;
          tone(V, { type: 'triangle', f: notes[i], t: st, a: 0.01, d: 0.35, vol: 0.07, send: 0.35 });
          tone(V, { type: 'sine', f: notes[i] / 2, t: st, a: 0.02, d: 0.4, vol: 0.05 });
        }
        tone(V, { type: 'sine', f: 130.81, t: t + 0.54, a: 0.04, d: 1.1, vol: 0.09, send: 0.3 });
      },
    };

    // ----------------------------------------------------------------
    // 七、曲目数据（纯代码作曲；音高 = MIDI，时长 = 步）
    // ----------------------------------------------------------------
    // ---- title：温暖怀旧的八音盒 + 柔和 pad，C 大调 72BPM，8 小节 26.7s 循环 ----
    const TITLE_CHORDS = [
      { pad: [48, 52, 55, 59], bass: 36 }, // Cmaj7
      { pad: [45, 48, 52, 55], bass: 33 }, // Am7
      { pad: [41, 45, 48, 52], bass: 41 }, // Fmaj7
      { pad: [43, 47, 50, 53], bass: 43 }, // G7
    ];
    for (let i = 0; i < TITLE_CHORDS.length; i++) {
      TITLE_CHORDS[i].arp = TITLE_CHORDS[i].pad.map((n) => n + 24);
    }
    // 16 个八分音符的琶音型（两小节一循环，有呼吸感）
    const TITLE_ARP = [0, 1, 2, 3, 2, 1, 3, 2, 0, 1, 2, 3, 2, 3, 1, 2];
    // 主旋律 [步, MIDI, 时值(步), 力度]
    const TITLE_MELODY = [
      [2, 76, 2, 1], [6, 79, 2, 0.9], [10, 74, 3, 0.85], [14, 71, 2, 0.7],
      [18, 72, 3, 0.9], [22, 76, 2, 0.85], [26, 69, 3, 0.8], [30, 67, 2, 0.7],
      [34, 77, 2, 0.9], [38, 81, 2, 0.95], [42, 79, 3, 0.85], [46, 76, 2, 0.75],
      [50, 74, 2, 0.85], [54, 79, 3, 0.9], [58, 77, 2, 0.8], [62, 74, 2, 0.75],
    ];

    const TITLE = {
      bpm: 72, stepBeats: 0.5, steps: 64, loop: true,
      step(tr, s, t) {
        const V = tr.V, d = tr.stepDur;
        const ci = (s / 16) | 0;
        const ch = TITLE_CHORDS[ci];
        // pad：每两小节换一次和弦，低音在中间补一个五度
        if (s % 16 === 0) {
          iPad(V, t, ch.pad, 16 * d * 0.94, 0.045);
          iBass(V, t, ch.bass, 7 * d, 0.11);
          iBass(V, t + 8 * d, ch.bass + 7, 3.5 * d, 0.055);
        }
        // 八音盒琶音
        const note = ch.arp[TITLE_ARP[s % 16]];
        iBell(V, t, note, 1.6, s % 8 === 0 ? 0.05 : 0.033);
        // 主旋律
        for (let i = 0; i < TITLE_MELODY.length; i++) {
          const m = TITLE_MELODY[i];
          if (m[0] === s) iBell(V, t, m[1], Math.max(0.7, m[2] * d * 1.2), 0.055 * m[3]);
        }
      },
    };

    // ---- forest：明亮轻快，C 大调 105BPM，木质打击 + 长笛 + 低音，8 小节 18.3s 循环 ----
    const FOREST_CHORDS = [
      { pad: [48, 52, 55], root: 36, fifth: 43, arp: [60, 64, 67] }, // C
      { pad: [41, 45, 48], root: 41, fifth: 48, arp: [53, 57, 60] }, // F
      { pad: [43, 47, 50], root: 43, fifth: 50, arp: [55, 59, 62] }, // G
      { pad: [45, 48, 52], root: 33, fifth: 40, arp: [57, 60, 64] }, // Am
    ];
    const FOREST_WOOD = [0, 3, 6, 8, 11, 14];
    const FOREST_SHAKE = [2, 5, 7, 10, 13, 15];
    const FOREST_MELODY = [
      [0, 76, 3, 0.9], [3, 79, 2, 0.8], [6, 81, 3, 0.85], [10, 79, 2, 0.75], [12, 76, 3, 0.8],
      [16, 77, 3, 0.9], [19, 81, 2, 0.8], [22, 84, 3, 0.9], [26, 81, 2, 0.75], [28, 79, 3, 0.8],
      [32, 74, 3, 0.85], [35, 79, 2, 0.8], [38, 83, 3, 0.9], [42, 79, 2, 0.75], [44, 74, 3, 0.8],
      [48, 72, 3, 0.85], [51, 76, 2, 0.8], [54, 79, 3, 0.85], [58, 76, 2, 0.7], [60, 72, 4, 0.8],
    ];

    const FOREST = {
      bpm: 105, stepBeats: 0.5, steps: 64, loop: true,
      step(tr, s, t) {
        const V = tr.V, d = tr.stepDur;
        const ci = (s / 16) | 0;
        const ch = FOREST_CHORDS[ci];
        const b = s % 16;
        // 木质打击：强弱交错
        if (FOREST_WOOD.indexOf(b) >= 0) iWood(V, t, b % 8 === 0 ? 0.1 : 0.065);
        if (FOREST_SHAKE.indexOf(b) >= 0) iShaker(V, t, 0.026);
        // 低音
        if (b === 0) iBass(V, t, ch.root, 6 * d, 0.11);
        if (b === 8) iBass(V, t, ch.fifth, 4 * d, 0.08);
        // 长笛旋律
        for (let i = 0; i < FOREST_MELODY.length; i++) {
          const m = FOREST_MELODY[i];
          if (m[0] === s) iFlute(V, t, m[1], Math.max(0.2, m[2] * d * 1.05), 0.075 * m[3]);
        }
        // 乐句间隙的铃铛点缀
        if (b === 12) iBell(V, t, ch.arp[2] + 12, 0.9, 0.02);
      },
    };

    // ---- battle：紧张快速，E 小调 150BPM，16 分 ostinato + 鼓，8 小节 12.8s 循环 ----
    const BATTLE_CHORDS = [
      { arp: [52, 55, 59, 64], root: 40 }, // Em
      { arp: [48, 52, 55, 60], root: 36 }, // C
      { arp: [50, 55, 59, 62], root: 43 }, // G
      { arp: [50, 54, 57, 62], root: 38 }, // D
    ];
    const BATTLE_ARP = [0, 1, 2, 3, 2, 1, 2, 3, 0, 1, 2, 3, 2, 1, 0, 1];
    const BATTLE_LEAD = [
      [0, 79, 2, 0.05], [4, 76, 2, 0.045], [8, 74, 2, 0.045], [12, 76, 3, 0.05],
      [20, 79, 2, 0.05], [24, 83, 3, 0.055], [30, 81, 2, 0.045],
    ];

    const BATTLE = {
      bpm: 150, stepBeats: 0.25, steps: 128, loop: true,
      step(tr, s, t) {
        const V = tr.V, d = tr.stepDur;
        const ci = (s / 32) | 0;
        const ch = BATTLE_CHORDS[ci];
        const b = s % 16;
        // 16 分琶音 ostinato
        const idx = BATTLE_ARP[b];
        iPluck(V, t, ch.arp[idx] + 12, 0.16, b % 4 === 0 ? 0.05 : 0.034, 'sawtooth');
        // 鼓
        if (b === 0 || b === 8 || b === 14) iKick(V, t, b === 0 ? 0.42 : 0.3);
        if (b === 4 || b === 12) iSnare(V, t, 0.2);
        if (s % 2 === 0) iHat(V, t, b % 4 === 2 ? 0.036 : 0.022);
        // 低音
        if (b === 0 || b === 6 || b === 10) iBass(V, t, ch.root + (b === 10 ? 7 : 0), 3 * d, 0.12);
        // 每两小节一次的强力铜管重音
        if (b === 0 && ci % 2 === 1) iBrass(V, t, [ch.arp[0] - 12, ch.arp[2] - 12, ch.arp[0]], 0.22, 0.045);
        // 副歌式主旋律（第 2 / 4 段）
        if (ci === 1 || ci === 3) {
          for (let i = 0; i < BATTLE_LEAD.length; i++) {
            const m = BATTLE_LEAD[i];
            if (m[0] === s % 32) iPluck(V, t, m[1], Math.max(0.18, m[2] * d * 1.2), m[3], 'triangle');
          }
        }
      },
    };

    // ---- boss：低沉压迫，D 小调 100BPM，低音 ostinato + 不协和音程 + 打击乐 ----
    const BOSS_OST = [38, 38, 45, 38, 41, 38, 44, 38];
    const BOSS = {
      bpm: 100, stepBeats: 0.5, steps: 64, loop: true,
      step(tr, s, t) {
        const V = tr.V, d = tr.stepDur;
        const b = s % 8;
        const ci = (s / 16) | 0;
        // 低音 ostinato：后半段加入半音，制造不安
        const dark = ci >= 2 && (b === 3 || b === 7);
        iBass(V, t, BOSS_OST[b] + (dark ? 1 : 0), 1.6 * d, 0.15, 'sawtooth');
        // 不协和 pad：Dm + 三全音
        if (s % 16 === 0) {
          const pad = ci < 2 ? [50, 53, 56] : [48, 51, 55];
          iPad(V, t, pad, 16 * d * 0.92, 0.04);
        }
        // 打击乐
        if (b === 0) iKick(V, t, 0.45);
        if (b === 3 || b === 6) iTom(V, t, b === 3 ? 0.24 : 0.18);
        if (s % 16 === 12) iSnare(V, t, 0.1);
        if (b === 4) iHat(V, t, 0.018);
        // 每两小节铜管重击
        if (s % 32 === 16) iBrass(V, t, [38, 45, 50], 0.6, 0.06);
        // 每 4 小节一次噪声涌动
        if (s % 32 === 0) iSwell(V, t, 15 * d, 0.05);
        // 尖锐的高音不协和点缀
        if (s % 8 === 2) tone(V, { type: 'sine', f: midiHz(73), t, a: 0.002, d: 0.5, vol: 0.012, send: 0.7 });
      },
    };

    // ---- win：C 大调号角式胜利小曲（约 6s，播完自动回 title） ----
    const WIN_MELODY = {
      0: [72, 2], 2: [76, 2], 4: [79, 2], 6: [84, 4],
      12: [81, 2], 14: [79, 2], 16: [77, 2], 18: [81, 2], 20: [84, 4],
      28: [79, 2], 30: [84, 2], 32: [86, 2], 34: [88, 6],
    };
    const WIN = {
      bpm: 160, stepBeats: 0.25, steps: 48, loop: false, tail: 1.6,
      step(tr, s, t) {
        const V = tr.V, d = tr.stepDur;
        const m = WIN_MELODY[s];
        if (m) {
          iBell(V, t, m[0], Math.max(0.35, m[1] * d * 1.4), 0.095);
          iPluck(V, t, m[0] - 12, 0.2, 0.03);
        }
        // 伴奏：C -> F -> G -> C 的和弦推进
        if (s === 0) { iBrass(V, t, [48, 52, 55], 0.5, 0.05); iBass(V, t, 36, 0.5, 0.13); iKick(V, t, 0.35); }
        if (s === 8) { iBrass(V, t, [53, 57, 60], 0.5, 0.05); iBass(V, t, 41, 0.5, 0.12); }
        if (s === 16) { iBrass(V, t, [55, 59, 62], 0.5, 0.05); iBass(V, t, 43, 0.5, 0.12); }
        if (s === 24) { iBrass(V, t, [48, 52, 55, 60], 0.9, 0.06); iBass(V, t, 36, 0.9, 0.14); iKick(V, t, 0.4); }
        if (s === 32) {
          iBrass(V, t, [48, 52, 55, 60], 1.4, 0.065);
          iBass(V, t, 36, 1.4, 0.15);
          iTimpani(V, t, 36, 0.3);
        }
        if (s === 34 || s === 36 || s === 38) iSnare(V, t, 0.07);
        if (s % 2 === 0 && s < 40) iHat(V, t, 0.02);
      },
    };

    // ---- lose：A 小调下行（约 7.4s，播完自动静音） ----
    const LOSE_MELODY = {
      0: [69, 3, 0.075], 3: [72, 2, 0.07], 6: [76, 3, 0.08],
      10: [74, 2, 0.07], 12: [72, 2, 0.07], 14: [69, 4, 0.08], 16: [64, 2, 0.06],
    };
    const LOSE = {
      bpm: 96, stepBeats: 0.5, steps: 18, loop: false, tail: 1.8,
      step(tr, s, t) {
        const V = tr.V, d = tr.stepDur;
        const m = LOSE_MELODY[s];
        if (m) iBell(V, t, m[0], Math.max(0.6, m[1] * d * 1.2), m[2]);
        // 和声：Am -> F -> Am（低音缓慢下沉）
        if (s === 0) { iPad(V, t, [45, 48, 52], 8 * d, 0.035); iBass(V, t, 33, 8 * d, 0.1); }
        if (s === 8) { iPad(V, t, [41, 45, 48], 8 * d, 0.035); iBass(V, t, 29, 8 * d, 0.09); }
        if (s === 16) { iPad(V, t, [45, 48, 52], 4 * d, 0.035); iBass(V, t, 33, 4 * d, 0.1); }
        if (s === 0) iTimpani(V, t, 33, 0.22);
      },
    };

    const MUSIC_DEFS = { title: TITLE, forest: FOREST, battle: BATTLE, boss: BOSS, win: WIN, lose: LOSE };

    // ----------------------------------------------------------------
    // 八、播放音效
    // ----------------------------------------------------------------
    function normalizeSfxOpts(opts) {
      const o = opts || {};
      const num = (v, dflt) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : dflt;
      };
      const timbreSrc = o.weapon != null ? o.weapon : (o.type != null ? o.type : o.element);
      return {
        vol: clamp(num(o.vol, 1), 0, 2),
        rate: clamp(num(o.rate, 1), 0.25, 4),
        pan: clamp(num(o.pan, 0), -1, 1),
        delay: clamp(num(o.delay, 0), 0, 5),
        timbre: normTimbre(timbreSrc),
      };
    }

    function throttleOk(name) {
      const t = nowMs();
      let arr = throttleMap[name];
      if (!arr) { arr = throttleMap[name] = []; }
      let i = 0;
      while (i < arr.length && t - arr[i] > THROTTLE_WINDOW) i++;
      if (i > 0) arr.splice(0, i);
      if (arr.length >= THROTTLE_MAX) return false;
      arr.push(t);
      return true;
    }

    function globalOk() {
      const t = nowMs();
      if (t - globalWindowAt > GLOBAL_WINDOW) { globalWindowAt = t; globalCount = 0; }
      if (globalCount >= GLOBAL_MAX) return false;
      globalCount++;
      return true;
    }

    /**
     * 把一个音效排进指定引擎（在线/离线共用）。
     * @returns {boolean} 是否成功排程
     */
    function playSfxInto(eng, name, o, t) {
      const fn = SFX[name];
      if (!fn) return false;
      const c = eng.ctx;
      const out = c.createGain();
      out.gain.value = o.vol == null ? 1 : o.vol;
      let dest = out;
      if (c.createStereoPanner) {
        const p = c.createStereoPanner();
        p.pan.value = clamp(o.pan == null ? 0 : o.pan, -1, 1);
        out.connect(p);
        dest = p;
      }
      dest.connect(eng.sfxBus);
      const V = {
        ctx: c,
        noise: eng.noise,
        dest: out,
        rev: eng.sfxRev,
        rate: o.rate || 1,
        timbre: o.timbre || null,
        sends: Object.create(null),
        t,
      };
      fn(V);
      return true;
    }

    function autoInitIfActive() {
      try {
        const act = navigator.userActivation;
        if (act && act.hasBeenActive) { init(); return !!engine; }
      } catch (e) {}
      return false;
    }

    // ----------------------------------------------------------------
    // 九、音乐：lookahead 排程器 + 交叉淡入淡出
    // ----------------------------------------------------------------
    function makeTrack(eng, cue, def, fadeIn) {
      const c = eng.ctx;
      const gain = c.createGain();
      gain.gain.value = 0.0002;
      gain.connect(eng.musicBus);
      const revSend = c.createGain();
      revSend.gain.value = 1;
      revSend.connect(eng.revIn);
      const track = {
        E: eng,
        cue,
        def,
        gain,
        revSend,
        V: { ctx: c, noise: eng.noise, dest: gain, rev: revSend, sends: Object.create(null), rate: 1 },
        stepDur: (60 / def.bpm) * (def.stepBeats || 1),
        nextTime: c.currentTime + 0.12,
        step: 0,
        dead: false,
        finishing: false,
        timer: 0,
        endTimer: 0,
        endCb: null,
      };
      try {
        const g = gain.gain;
        const now = c.currentTime;
        g.cancelScheduledValues(now);
        g.setValueAtTime(0.0002, now);
        g.exponentialRampToValueAtTime(1, now + Math.max(0.05, fadeIn));
      } catch (e) {
        try { gain.gain.value = 1; } catch (e2) {}
      }
      track.timer = setInterval(() => tickTrack(track), SCHEDULER_MS);
      tickTrack(track);
      return track;
    }

    function tickTrack(track) {
      if (track.dead) return;
      const c = track.E.ctx;
      const def = track.def;
      const now = c.currentTime;
      // 标签页被挂起后回来：丢掉积压的步进，避免一次性排爆
      if (track.nextTime < now - 0.35) track.nextTime = now + 0.05;
      const horizon = now + LOOKAHEAD;
      let guard = 0;
      while (track.nextTime < horizon && guard++ < 96) {
        if (!def.loop && track.step >= def.steps) { finishTrack(track); return; }
        const idx = def.loop ? track.step % def.steps : track.step;
        try {
          def.step(track, idx, track.nextTime);
        } catch (err) {
          lastError = err;
          try { console.warn('[PG.audio] 音乐步进失败:', err); } catch (e) {}
        }
        track.step++;
        track.nextTime += track.stepDur;
      }
    }

    function finishTrack(track) {
      if (track.dead || track.finishing) return;
      track.finishing = true;
      if (track.timer) { clearInterval(track.timer); track.timer = 0; }
      const c = track.E.ctx;
      const wait = Math.max(0, (track.nextTime + (track.def.tail || 0.8) - c.currentTime) * 1000);
      track.endTimer = setTimeout(() => {
        if (track.dead) return;
        track.dead = true;
        // 淡出并断开，交给回调决定下一步
        try {
          const g = track.gain.gain;
          const t = c.currentTime;
          g.cancelScheduledValues(t);
          g.setValueAtTime(Math.max(0.0002, g.value), t);
          g.linearRampToValueAtTime(0.0001, t + 0.6);
        } catch (e) {}
        setTimeout(() => {
          try { track.gain.disconnect(); } catch (e) {}
          try { track.revSend.disconnect(); } catch (e) {}
        }, 800);
        if (track.endCb) { try { track.endCb(); } catch (e) { lastError = e; } }
      }, wait);
    }

    function stopTrack(track, fade) {
      if (!track || track.dead) return;
      track.dead = true;
      if (track.timer) { clearInterval(track.timer); track.timer = 0; }
      if (track.endTimer) { clearTimeout(track.endTimer); track.endTimer = 0; }
      const c = track.E.ctx;
      const now = c.currentTime;
      const g = track.gain.gain;
      try {
        g.cancelScheduledValues(now);
        g.setValueAtTime(Math.max(0.0002, g.value), now);
        g.linearRampToValueAtTime(0.0001, now + fade);
      } catch (e) {}
      setTimeout(() => {
        try { track.gain.disconnect(); } catch (e) {}
        try { track.revSend.disconnect(); } catch (e) {}
      }, (fade + 0.2) * 1000);
    }

    function music(cue) {
      try {
        if (typeof cue !== 'string' || (!MUSIC_DEFS[cue] && cue !== 'none')) cue = 'none';
        if (!ctx || !engine || ctx.state === 'closed') { pendingCue = cue; return; }
        // 同一 cue 重复调用不重启
        if (cue === currentCue && (cue === 'none' || (currentTrack && !currentTrack.dead))) return;
        const epoch = ++musicEpoch;
        const old = currentTrack;
        currentTrack = null;
        currentCue = cue;
        if (old) stopTrack(old, MUSIC_FADE);
        if (cue === 'none') return;
        const track = makeTrack(engine, cue, MUSIC_DEFS[cue], MUSIC_FADE);
        currentTrack = track;
        track.endCb = () => {
          if (epoch !== musicEpoch) return;
          currentTrack = null;
          if (cue === 'win') { currentCue = 'none'; music('title'); }
          else if (cue === 'lose') { music('none'); }
          else currentCue = 'none';
        };
      } catch (err) {
        lastError = err;
      }
    }

    // ----------------------------------------------------------------
    // 十、音量 / 静音 / duck
    // ----------------------------------------------------------------
    function applyVolume() {
      if (!engine) return;
      const target = muted ? 0 : Math.pow(clamp(volume, 0, 1), 1.15) * 0.95;
      const g = engine.master.gain;
      const t = engine.ctx.currentTime;
      try {
        g.cancelScheduledValues(t);
        g.setTargetAtTime(target, t, 0.03);
      } catch (e) {
        try { g.value = target; } catch (e2) {}
      }
    }

    function applyDuck() {
      if (!engine) return;
      const g = engine.duckGain.gain;
      const t = engine.ctx.currentTime;
      try {
        g.cancelScheduledValues(t);
        g.setTargetAtTime(clamp(duck, 0, 1), t, 0.05);
      } catch (e) {
        try { g.value = duck; } catch (e2) {}
      }
    }

    function setMuted(v) {
      muted = !!v;
      applyVolume();
    }
    function isMuted() { return muted; }
    function setVolume(v) {
      const n = Number(v);
      volume = clamp(Number.isFinite(n) ? n : 0.8, 0, 1);
      applyVolume();
    }
    function getVolume() { return volume; }
    function setDuck(v) {
      const n = Number(v);
      duck = clamp(Number.isFinite(n) ? n : 1, 0, 1);
      applyDuck();
    }

    // ----------------------------------------------------------------
    // 十一、初始化
    // ----------------------------------------------------------------
    function ensureRunning() {
      if (!ctx) return;
      try {
        if (ctx.state === 'suspended') {
          const p = ctx.resume();
          if (p && p.catch) p.catch(() => {});
        }
      } catch (e) {}
    }

    function init() {
      try {
        // 已初始化：只确保在运行
        if (ctx && ctx.state !== 'closed') {
          ensureRunning();
          return ctx;
        }
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return null;
        let c = null;
        try {
          c = new Ctor({ latencyHint: 'interactive' });
        } catch (e) {
          try { c = new Ctor(); } catch (e2) { c = null; }
        }
        if (!c) return null;
        ctx = c;
        engine = createEngine(c);
        // 把之前存下的设置应用到新引擎
        applyVolume();
        applyDuck();
        const pending = pendingCue;
        pendingCue = null;
        currentCue = 'none';
        if (pending && pending !== 'none') music(pending);
        ensureRunning();
        return ctx;
      } catch (err) {
        lastError = err;
        return ctx;
      }
    }

    // 事件解锁：任何一次用户手势都会尝试 init/resume（幂等，游戏自己调 init 也完全 OK）
    function bindUnlock() {
      if (unlockBound || typeof document === 'undefined' || !document.addEventListener) return;
      unlockBound = true;
      const handler = () => {
        try {
          if (!ctx) init();
          ensureRunning();
        } catch (e) {}
        if (ctx && ctx.state === 'running') {
          try {
            document.removeEventListener('pointerdown', handler, true);
            document.removeEventListener('keydown', handler, true);
            document.removeEventListener('touchend', handler, true);
          } catch (e) {}
        }
      };
      try {
        document.addEventListener('pointerdown', handler, true);
        document.addEventListener('keydown', handler, true);
        document.addEventListener('touchend', handler, true);
      } catch (e) {}
    }

    // ----------------------------------------------------------------
    // 十二、公开 API
    // ----------------------------------------------------------------
    function sfx(name, opts) {
      try {
        if (!name) return;
        if (!ctx || !engine || ctx.state === 'closed') {
          if (!autoInitIfActive()) return;
        }
        if (!engine) return;
        if (!SFX[name]) return; // 未知音效：静默返回，不抛错
        const o = normalizeSfxOpts(opts);
        if (!throttleOk(name)) return;
        if (!globalOk()) return;
        const t = ctx.currentTime + 0.008 + o.delay;
        playSfxInto(engine, name, o, t);
      } catch (err) {
        lastError = err;
      }
    }

    // ----------------------------------------------------------------
    // 十三、离线自检（仅 tests/audio.html 使用；不影响游戏）
    // ----------------------------------------------------------------
    // 逐个创建 OfflineAudioContext 太慢（headless 下离线渲染耗时接近实时），
    // 这里用「多声道并行渲染」：把 24 个音效分别接到同一次渲染的 24 个声道上，
    // 一次 3.2 秒渲染即可拿到每个音效独立的峰值；音乐同理用 6 个声道并行。
    function renderMultiChannel(count, seconds, sampleRate, setup) {
      return new Promise((resolve) => {
        const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        const out = { peaks: [], rms: [], nan: [], error: null, seconds };
        let oc = null;
        try {
          oc = new OAC(count, Math.max(1, Math.ceil(sampleRate * seconds)), sampleRate);
        } catch (e) {
          out.error = 'OfflineAudioContext 创建失败: ' + (e && e.message);
          resolve(out);
          return;
        }
        const merger = oc.createChannelMerger(count);
        merger.connect(oc.destination);
        const chans = [];
        for (let i = 0; i < count; i++) {
          const g = oc.createGain();
          g.gain.value = 1;
          g.connect(merger, 0, i);
          chans.push(g);
        }
        try {
          setup(oc, chans);
        } catch (e) {
          out.error = String((e && e.message) || e);
        }
        oc.startRendering().then((buf) => {
          try {
            for (let ch = 0; ch < buf.numberOfChannels; ch++) {
              const data = buf.getChannelData(ch);
              let peak = 0, sum = 0, n = 0, bad = false;
              for (let i = 0; i < data.length; i += 4) {
                const v = data[i];
                if (v !== v) { bad = true; break; }
                const a = v < 0 ? -v : v;
                if (a > peak) peak = a;
                sum += v * v;
                n++;
              }
              out.peaks.push(peak);
              out.rms.push(n ? Math.sqrt(sum / n) : 0);
              out.nan.push(bad);
            }
          } catch (e) {
            out.error = out.error || String((e && e.message) || e);
          }
          resolve(out);
        }).catch((e) => {
          out.error = String((e && e.message) || e);
          resolve(out);
        });
      });
    }

    // 离线把一段音乐按时间排进去（不依赖 setInterval）
    function scheduleMusicOffline(eng, cue, seconds) {
      const def = MUSIC_DEFS[cue];
      if (!def) throw new Error('未知 cue: ' + cue);
      const c = eng.ctx;
      const gain = c.createGain();
      gain.gain.value = 1;
      gain.connect(eng.musicBus);
      let revSend = null;
      if (eng.revIn) {
        revSend = c.createGain();
        revSend.gain.value = 1;
        revSend.connect(eng.revIn);
      }
      const track = {
        E: eng, cue, def, gain, revSend,
        V: { ctx: c, noise: eng.noise, dest: gain, rev: revSend, sends: Object.create(null), rate: 1 },
        stepDur: (60 / def.bpm) * (def.stepBeats || 1),
        step: 0,
      };
      let t = 0.12;
      const horizon = Math.max(0.3, seconds - 0.1);
      let guard = 0;
      while (t < horizon && guard++ < 4000) {
        const idx = def.loop ? track.step % def.steps : Math.min(track.step, def.steps - 1);
        def.step(track, idx, t);
        track.step++;
        if (!def.loop && track.step >= def.steps) break;
        t += track.stepDur;
      }
    }

    /**
     * 离线自检：不需要用户手势，页面加载时就能跑。
     *  - 用「多声道并行渲染」把全部音效 / 音乐各渲染一遍（2 次渲染，够快）；
     *  - 检查每个声道是否抛异常 / 出现 NaN / 峰值大于静音阈值（证明真的有声）。
     * 返回 { supported, sfx:[{name,peak,rms,ok,error}], music:[...], sfxOk, musicOk, peakSfx, peakMusic, errors }
     * opts: { music=true, onProgress(done,total,label) }
     */
    async function offlineCheck(opts) {
      const o = opts || {};
      const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const res = { supported: !!OAC, sfx: [], music: [], sfxOk: 0, musicOk: 0, peakSfx: 0, peakMusic: 0, errors: [] };
      if (!OAC) { res.errors.push('浏览器不支持 OfflineAudioContext'); return res; }

      const names = Object.keys(SFX);
      const cues = o.music === false ? [] : Object.keys(MUSIC_DEFS);
      const total = names.length + cues.length;
      let done = 0;
      const progress = (label) => {
        done++;
        if (typeof o.onProgress === 'function') {
          try { o.onProgress(done, total, label); } catch (e) {}
        }
      };

      // 1) 音效：24 个声道并行，一次 3.2s 渲染出全部峰值（互不干扰）
      const sfxSeconds = 3.2;
      const sfxErrors = Object.create(null);
      const sfxJob = renderMultiChannel(names.length, sfxSeconds, 44100, (oc, chans) => {
        const noise = getNoise(oc);
        for (let i = 0; i < names.length; i++) {
          try {
            const eng = { ctx: oc, noise, sfxBus: chans[i], sfxRev: null };
            playSfxInto(eng, names[i], { vol: 1, pan: 0, rate: 1 }, 0.06);
          } catch (e) {
            sfxErrors[names[i]] = String((e && e.message) || e);
          }
        }
      }).then((r) => {
        for (let i = 0; i < names.length; i++) progress('sfx:' + names[i]);
        return r;
      });

      // 2) 音乐：6 个声道并行，一次 3s 渲染（采样率减半，验证"有声"已经足够，速度优先）
      const musicSeconds = 3.0;
      const musicSampleRate = 22050;
      const musicErrors = Object.create(null);
      const musicJob = cues.length
        ? renderMultiChannel(cues.length, musicSeconds, musicSampleRate, (oc, chans) => {
            const noise = getNoise(oc);
            for (let i = 0; i < cues.length; i++) {
              try {
                const eng = { ctx: oc, noise, musicBus: chans[i], revIn: null };
                scheduleMusicOffline(eng, cues[i], musicSeconds);
              } catch (e) {
                musicErrors[cues[i]] = String((e && e.message) || e);
              }
            }
          }).then((r) => {
            for (let i = 0; i < cues.length; i++) progress('music:' + cues[i]);
            return r;
          })
        : Promise.resolve({ peaks: [], rms: [], nan: [], error: null, seconds: musicSeconds });

      const results = await Promise.all([sfxJob, musicJob]);
      const sfxRender = results[0];
      const musicRender = results[1];
      if (sfxRender.error) res.errors.push('音效渲染: ' + sfxRender.error);
      if (musicRender.error) res.errors.push('音乐渲染: ' + musicRender.error);

      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        const peak = sfxRender.peaks[i] || 0;
        const rms = sfxRender.rms[i] || 0;
        const nan = !!sfxRender.nan[i];
        const error = sfxErrors[name] || null;
        const ok = !error && !nan && peak > 0.006;
        res.sfx.push({ name, peak, rms, error, ok, seconds: sfxSeconds });
        if (ok) res.sfxOk++;
        if (peak > res.peakSfx) res.peakSfx = peak;
      }
      for (let i = 0; i < cues.length; i++) {
        const cue = cues[i];
        const peak = musicRender.peaks[i] || 0;
        const rms = musicRender.rms[i] || 0;
        const nan = !!musicRender.nan[i];
        const error = musicErrors[cue] || null;
        const ok = !error && !nan && peak > 0.006;
        res.music.push({ cue, peak, rms, error, ok, seconds: musicSeconds });
        if (ok) res.musicOk++;
        if (peak > res.peakMusic) res.peakMusic = peak;
      }
      return res;
    }

    // 页面加载后绑定一次用户手势解锁（不主动创建 AudioContext，不会自动播放）
    bindUnlock();

    return {
      init,
      sfx,
      music,
      setMuted,
      isMuted,
      setVolume,
      getVolume,
      setDuck,
      // --- 以下为调试/自检辅助，不属于契约，可安全忽略 ---
      __state: () => ({
        ready: !!ctx,
        state: ctx ? ctx.state : 'no-context',
        cue: currentCue,
        volume,
        muted,
        duck,
        sampleRate: ctx ? ctx.sampleRate : 0,
        error: lastError ? String(lastError.message || lastError) : null,
      }),
      __analyser: () => (engine ? engine.analyser : null),
      __sfxNames: () => Object.keys(SFX),
      __cues: () => Object.keys(MUSIC_DEFS),
      __test: { offlineCheck },
    };
  }
})();

/* ==================== 20-world.js ==================== */
/* ============================================================
 * 20-world.js — 山海古林场景（PG.world）
 * ------------------------------------------------------------
 * 白天阳光斜射的山海古林空地：
 *   · 起伏草丘地形（正弦叠加，groundY 与网格严格一致）
 *   · 环形卡通古林：多球树冠、深浅两档绿 + 顶部黄绿受光
 *   · 成片白 / 粉小花、红白斑点蘑菇圈、圆润岩石
 *   · 清澈水塘：半透明水面 shader + 波纹 + 睡莲 + 岸石 + 木栈桥
 *   · 中式牌坊（朱漆方柱 + 横梁 + 起翘檐口）、祭坛（石台 / 石碑 / 玉璧）、
 *     石鼎香炉（烟气 / 微光）、石阶
 *   · 丁达尔光柱、萤火虫、蒲公英、薄雾与渐变天空
 * 全部程序化生成（CanvasTexture + 基础几何），不依赖外部资源。
 * 性能：树 / 草 / 花 / 蘑菇 / 石块 / 睡莲全部 InstancedMesh，
 *       风场在顶点着色器里算（GPU 风），update 只更新少量 uniform。
 * ============================================================ */
(() => {
  'use strict';
  const PG = (window.PG = window.PG || {});
  const TAU = Math.PI * 2;

  // THREE 在 build() 时注入，保证本文件不依赖脚本加载顺序
  let T = null;

  // ---------------- 数学小工具（不依赖 PG.util，保证独立可测） ----------------
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0 || 1e-6), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const fract = (v) => v - Math.floor(v);

  /** 确定性伪随机（布局固定，截图与联调可复现） */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 2D 值噪声（地形色斑 / 花丛分布用） */
  function hash2(x, y) {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s - Math.floor(s);
  }
  function valueNoise2(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    return lerp(
      lerp(hash2(xi, yi), hash2(xi + 1, yi), u),
      lerp(hash2(xi, yi + 1), hash2(xi + 1, yi + 1), u),
      v
    );
  }

  // ---------------- 场地布局（全部子模块共享） ----------------
  const LAYOUT = {
    radius: 62, // 玩家活动半径
    pond: { x: -27, z: -19, r: 8.8 }, // 水塘
    altar: { x: 0, z: -36 }, // 祭坛（牌坊 + 石台 + 石碑 + 玉璧）
    ring: { x: 18.5, z: -21 }, // 蘑菇圈
    rocks: { x: 34, z: -31 }, // 岩石群（右）
    rocks2: { x: -40, z: -34 }, // 岩石群（左）
    sunDir: [0.56, 0.6, -0.57], // 阳光方向（指向太阳）
    fogColor: 0xd8eee4,
    skyTop: 0x2f8fe0,
  };

  // ---------------- 全局风场 uniform（树冠 / 草共用） ----------------
  const windUniform = { value: 0 };

  /** 给材质注入顶点风场：按实例世界位置取相位，按顶点高度加权 */
  function withWind(mat, amp, height) {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uWind = windUniform;
      shader.vertexShader =
        'uniform float uWind;\n' +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          [
            '#include <begin_vertex>',
            '#ifdef USE_INSTANCING',
            '  vec3 wInst = instanceMatrix[3].xyz;',
            '#else',
            '  vec3 wInst = vec3(0.0);',
            '#endif',
            '  float wPh = wInst.x * 0.63 + wInst.z * 0.87;',
            '  float wSway = sin(uWind * 1.15 + wPh) * 0.6',
            '              + sin(uWind * 2.35 + wPh * 1.7) * 0.26',
            '              + sin(uWind * 0.47 + wPh * 0.6) * 0.34;',
            '  float wT = clamp(position.y / ' + height.toFixed(3) + ', 0.0, 1.4);',
            '  float wAmt = wSway * wT * wT * ' + amp.toFixed(3) + ';',
            '  transformed.x += wAmt;',
            '  transformed.z += wAmt * 0.55;',
          ].join('\n')
        );
    };
    // 让不同参数的风场材质使用各自的着色器程序
    mat.customProgramCacheKey = () => 'pg-wind-' + amp.toFixed(3) + '-' + height.toFixed(3);
    mat.needsUpdate = true;
    return mat;
  }

  // ============================================================
  // 1. Canvas 程序化贴图
  // ============================================================
  function makeTexture(w, h, draw, opts) {
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const c2 = cv.getContext('2d');
    draw(c2, w, h);
    const tex = new T.CanvasTexture(cv);
    if (T.SRGBColorSpace) tex.colorSpace = T.SRGBColorSpace;
    if (opts && opts.repeat) {
      tex.wrapS = tex.wrapT = T.RepeatWrapping;
      tex.repeat.set(opts.repeat[0], opts.repeat[1]);
    }
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    return tex;
  }

  /** 天空竖直渐变（球体内壁） */
  function makeSkyTexture() {
    return makeTexture(16, 512, (c, w, h) => {
      const g = c.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0.0, '#2f8fe0'); // 天顶深蓝
      g.addColorStop(0.22, '#4fa7ee');
      g.addColorStop(0.4, '#8fd0f6');
      g.addColorStop(0.47, '#cdeeff');
      g.addColorStop(0.5, '#eef9ea'); // 地平线：暖白偏绿
      g.addColorStop(0.56, '#dcefd6');
      g.addColorStop(1.0, '#b9d9b4'); // 下半球（一般被地形遮住）
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
    });
  }

  /** 草地细节贴图（与顶点色相乘，只做细微纹理） */
  function makeGrassTexture() {
    return makeTexture(
      256,
      256,
      (c, w, h) => {
        c.fillStyle = '#ffffff';
        c.fillRect(0, 0, w, h);
        const rnd = mulberry32(20241111);
        // 大块明暗
        for (let i = 0; i < 64; i++) {
          c.globalAlpha = 0.05 + rnd() * 0.06;
          c.fillStyle = rnd() < 0.5 ? '#cfe6b8' : '#f2ffe0';
          const r = 10 + rnd() * 46;
          c.beginPath();
          c.ellipse(rnd() * w, rnd() * h, r, r * (0.45 + rnd() * 0.5), rnd() * 3, 0, TAU);
          c.fill();
        }
        // 细草叶
        for (let i = 0; i < 1000; i++) {
          c.globalAlpha = 0.08 + rnd() * 0.12;
          c.strokeStyle = rnd() < 0.5 ? '#b9d894' : '#eaffd0';
          c.lineWidth = 0.8 + rnd() * 1.3;
          const x = rnd() * w, y = rnd() * h;
          const len = 3 + rnd() * 8;
          const ang = -Math.PI / 2 + (rnd() - 0.5) * 1.0;
          c.beginPath();
          c.moveTo(x, y);
          c.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
          c.stroke();
        }
        c.globalAlpha = 1;
      },
      { repeat: [34, 34] }
    );
  }

  /** 柔和光斑（萤火虫 / 光晕 / 阳光通用） */
  function makeGlowTexture(stops) {
    return makeTexture(64, 64, (c, w, h) => {
      const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      for (const s of stops) g.addColorStop(s[0], s[1]);
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
    });
  }

  /** 蒲公英种子（白色绒球 + 细茎） */
  function makeSeedTexture() {
    return makeTexture(64, 64, (c, w, h) => {
      const cx = w / 2, cy = h * 0.42;
      c.strokeStyle = 'rgba(255,255,255,0.85)';
      c.lineWidth = 1.1;
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * TAU;
        const len = 17 + (i % 3) * 3;
        c.beginPath();
        c.moveTo(cx, cy);
        c.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
        c.stroke();
        // 绒毛小点
        c.fillStyle = 'rgba(255,255,255,0.9)';
        c.beginPath();
        c.arc(cx + Math.cos(a) * len, cy + Math.sin(a) * len, 1.4, 0, TAU);
        c.fill();
      }
      // 中心亮核
      const g = c.createRadialGradient(cx, cy, 0, cx, cy, 12);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.5, 'rgba(255,255,230,0.55)');
      g.addColorStop(1, 'rgba(255,255,230,0)');
      c.fillStyle = g;
      c.beginPath();
      c.arc(cx, cy, 12, 0, TAU);
      c.fill();
      // 细茎
      c.strokeStyle = 'rgba(230,255,220,0.5)';
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(cx, cy + 8);
      c.quadraticCurveTo(cx + 3, cy + 20, cx + 1, h - 6);
      c.stroke();
    });
  }

  /** 阳光圆盘 */
  function makeSunTexture() {
    return makeTexture(128, 128, (c, w, h) => {
      const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      g.addColorStop(0.0, 'rgba(255,255,246,1)');
      g.addColorStop(0.18, 'rgba(255,250,214,1)');
      g.addColorStop(0.4, 'rgba(255,236,168,0.5)');
      g.addColorStop(0.72, 'rgba(255,224,150,0.14)');
      g.addColorStop(1.0, 'rgba(255,220,140,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
    });
  }

  /** 牌坊匾额 / 祭坛石碑的题字（竖排两字，Canvas 绘制） */
  function makeInscriptionTexture(text, opt) {
    const o = opt || {};
    const bg = o.bg || '#f6ecd2';
    const edge = o.edge || '#c8432a';
    const ink = o.ink || '#24313f';
    return makeTexture(128, 160, (c, w, h) => {
      c.fillStyle = bg;
      c.fillRect(0, 0, w, h);
      c.strokeStyle = edge;
      c.lineWidth = 10;
      c.strokeRect(5, 5, w - 10, h - 10);
      c.strokeStyle = o.inner || edge;
      c.lineWidth = 3;
      c.strokeRect(15, 15, w - 30, h - 30);
      c.fillStyle = ink;
      c.font = '900 66px "PingFang SC","Microsoft YaHei","YouYuan",sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      const chars = String(text).slice(0, 2);
      if (chars.length === 2) {
        c.fillText(chars[0], w / 2, h * 0.31 + 4);
        c.fillText(chars[1], w / 2, h * 0.72 + 4);
      } else {
        c.font = '900 92px "PingFang SC","Microsoft YaHei","YouYuan",sans-serif';
        c.fillText(chars || '山', w / 2, h / 2 + 6);
      }
    });
  }

  // ============================================================
  // 2. 几何工具：合并 / 顶点着色 / 基础体
  // ============================================================

  /**
   * 合并 BufferGeometry（position/normal/uv[/color][/extra]），返回单个几何体。
   * three 的 addons 不可用，所以这里自己实现（只处理非交错、带 index 的常规几何）。
   */
  function mergeGeoms(list, extraNames) {
    list = list.filter((g) => g && g.attributes && g.attributes.position);
    if (!list.length) return new T.BufferGeometry();
    const useColor = list.every((g) => g.attributes.color);
    const names = ['position', 'normal', 'uv'].concat(extraNames || [], useColor ? ['color'] : []);
    const itemSizes = {};
    for (const n of names) itemSizes[n] = list[0].attributes[n] ? list[0].attributes[n].itemSize : 3;

    let vCount = 0, iCount = 0;
    for (const g of list) {
      const n = g.attributes.position.count;
      vCount += n;
      iCount += g.index ? g.index.count : n;
    }
    const arrays = {};
    for (const n of names) arrays[n] = new Float32Array(vCount * itemSizes[n]);
    const IdxArr = vCount > 65535 ? Uint32Array : Uint16Array;
    const idx = new IdxArr(iCount);

    let vo = 0, io = 0;
    for (const g of list) {
      const count = g.attributes.position.count;
      for (const n of names) {
        const attr = g.attributes[n];
        if (!attr) continue;
        const is = itemSizes[n];
        const src = attr.array;
        const dst = arrays[n];
        for (let v = 0; v < count; v++) {
          for (let k = 0; k < is; k++) dst[(vo + v) * is + k] = src[v * is + k];
        }
      }
      if (g.index) {
        const gi = g.index;
        for (let i = 0; i < gi.count; i++) idx[io + i] = gi.getX(i) + vo;
        io += gi.count;
      } else {
        for (let i = 0; i < count; i++) idx[io + i] = vo + i;
        io += count;
      }
      vo += count;
    }

    const out = new T.BufferGeometry();
    for (const n of names) {
      if (n === 'color' && !useColor) continue;
      out.setAttribute(n, new T.BufferAttribute(arrays[n], itemSizes[n]));
    }
    out.setIndex(new T.BufferAttribute(idx, 1));
    return out;
  }

  /** 按顶点写入颜色（fn 收到临时 Color 与局部坐标） */
  function paintVerts(geo, fn) {
    const p = geo.attributes.position;
    const arr = new Float32Array(p.count * 3);
    const c = new T.Color();
    for (let i = 0; i < p.count; i++) {
      c.setRGB(1, 1, 1);
      fn(c, p.getX(i), p.getY(i), p.getZ(i), i);
      arr[i * 3] = c.r;
      arr[i * 3 + 1] = c.g;
      arr[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new T.BufferAttribute(arr, 3));
    return geo;
  }

  /** 生成几何并可选地旋转/平移（参数顺序：几何 → 旋转 → 平移） */
  function part(geo, x, y, z, rx, ry, rz) {
    if (rx) geo.rotateX(rx);
    if (ry) geo.rotateY(ry);
    if (rz) geo.rotateZ(rz);
    geo.translate(x || 0, y || 0, z || 0);
    return geo;
  }

  function boxGeo(w, h, d) {
    return new T.BoxGeometry(w, h, d);
  }
  function cylGeo(rt, rb, h, seg, open) {
    return new T.CylinderGeometry(rt, rb, h, seg || 8, 1, !!open);
  }
  function sphereGeo(r, ws, hs) {
    return new T.SphereGeometry(r, ws || 10, hs || 7);
  }

  // ============================================================
  // 3. 地形高度场（groundY 与网格顶点共用同一个函数）
  // ============================================================
  function makeHeightField() {
    const P = LAYOUT.pond;

    function baseHeight(x, z) {
      const d = Math.hypot(x, z);
      let h =
        0.3 * Math.sin(x * 0.083 + 0.6) * Math.cos(z * 0.071 - 0.4) +
        0.17 * Math.sin((x + z) * 0.132 + 1.9) +
        0.09 * Math.cos(x * 0.22 - z * 0.19 + 0.8);
      // 中央战斗空地更平整，外圈渐渐起伏
      h *= 0.42 + 0.58 * smoothstep(14, 38, d);
      // 外圈抬高成盆地边缘，遮住地平线
      h += smoothstep(44, 82, d) * 4.6;
      return h;
    }

    const pondBase = baseHeight(P.x, P.z);
    const pondWaterY = pondBase - 0.24;

    function groundY(x, z) {
      let h = baseHeight(x, z);
      const pd = Math.hypot(x - P.x, z - P.z);
      const flat = smoothstep(P.r * 1.22, P.r * 0.7, pd);
      if (flat > 0.001) {
        const bowl = smoothstep(P.r * 1.02, P.r * 0.72, pd);
        h = lerp(h, pondBase - 0.9 * bowl, flat);
      }
      return h;
    }

    return { groundY, baseHeight, pondBase, pondWaterY };
  }

  // ============================================================
  // 4. 天空 / 云 / 太阳
  // ============================================================
  function buildSky(ctx) {
    const g = ctx.group;
    const skyR = ctx.opts.skyRadius || 260;

    // 渐变天穹（球体内壁）
    const sky = new T.Mesh(
      new T.SphereGeometry(skyR, 32, 20),
      new T.MeshBasicMaterial({
        map: ctx.tex.sky,
        side: T.BackSide,
        fog: false,
        depthWrite: false,
      })
    );
    sky.name = 'skyDome';
    sky.renderOrder = -100;
    sky.frustumCulled = false;
    g.add(sky);

    // 太阳：两层叠加 sprite（亮核 + 大光晕）
    const sunPos = ctx.sunDir.clone().multiplyScalar(skyR * 0.92);
    const mkSprite = (scale, opacity, tex) => {
      const sp = new T.Sprite(
        new T.SpriteMaterial({
          map: tex,
          color: 0xffffff,
          transparent: true,
          opacity,
          blending: T.AdditiveBlending,
          depthWrite: false,
          fog: false,
        })
      );
      sp.position.copy(sunPos);
      sp.scale.set(scale, scale, 1);
      sp.renderOrder = -90;
      return sp;
    };
    const sunHalo = mkSprite(skyR * 0.2, 0.1, ctx.tex.sun);
    sunHalo.material.color.setHex(0xffe9b0);
    const sunCore = mkSprite(skyR * 0.032, 0.42, ctx.tex.sun);
    sunCore.material.color.setHex(0xfff4cc);
    g.add(sunHalo);
    g.add(sunCore);

    // 卡通云：若干压扁球合并成一个几何体（1 个 draw call）
    const cloudParts = [];
    const cloudRnd = mulberry32(777);
    const cloudClusters = 7;
    for (let i = 0; i < cloudClusters; i++) {
      const a = (i / cloudClusters) * TAU + cloudRnd() * 0.7;
      const dist = 120 + cloudRnd() * 70;
      const cx = Math.cos(a) * dist;
      const cz = Math.sin(a) * dist;
      const cy = 52 + cloudRnd() * 46;
      const blobs = 4 + ((cloudRnd() * 3) | 0);
      const baseS = 9 + cloudRnd() * 9;
      for (let b = 0; b < blobs; b++) {
        const r = baseS * (0.55 + cloudRnd() * 0.6);
        const gg = new T.SphereGeometry(r, 10, 7);
        gg.scale(1.25, 0.62, 1);
        gg.translate(
          cx + (cloudRnd() - 0.5) * baseS * 2.6,
          cy + (cloudRnd() - 0.5) * baseS * 0.5,
          cz + (cloudRnd() - 0.5) * baseS * 1.4
        );
        cloudParts.push(gg);
      }
    }
    const cloudGeo = mergeGeoms(cloudParts);
    paintVerts(cloudGeo, (c, x, y) => {
      // 云底偏淡蓝，云顶纯白
      const t = smoothstep(40, 96, y);
      c.setHex(0xffffff).lerp(new T.Color(0xd4e9fb), 1 - t);
    });
    const clouds = new T.Mesh(
      cloudGeo,
      new T.MeshBasicMaterial({ vertexColors: true, fog: false, transparent: true, opacity: 0.94 })
    );
    clouds.name = 'clouds';
    clouds.frustumCulled = false;
    g.add(clouds);
    ctx.dyn.clouds = clouds;

    ctx.dyn.updaters.push((dt) => {
      clouds.rotation.y += dt * 0.0022; // 云朵极缓慢漂移
    });
  }

  // ============================================================
  // 5. 备用光照（Lead 若已布光可传 opts.skipLights 或已有 DirectionalLight）
  // ============================================================
  function buildLights(ctx) {
    const scene = ctx.scene;
    const o = ctx.opts;
    if (o.skipLights) return;

    // 场景里已经有方向光（Lead 布置过）就不重复加
    let hasDir = false;
    scene.traverse((n) => {
      if (n.isDirectionalLight) hasDir = true;
    });
    if (hasDir) return;

    const sun = new T.DirectionalLight(0xfff2cc, 2.35);
    sun.name = 'pgSun';
    sun.position.copy(ctx.sunDir).multiplyScalar(80);
    sun.target.position.set(0, 0, 0);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -74;
    sc.right = 74;
    sc.top = 74;
    sc.bottom = -74;
    sc.near = 1;
    sc.far = 230;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.045;
    sc.updateProjectionMatrix();
    scene.add(sun);
    scene.add(sun.target);
    ctx.sunLight = sun;
  }

  // ============================================================
  // 6. 地形
  // ============================================================
  function buildTerrain(ctx) {
    const SIZE = 240;
    const SEG = 192;
    const geo = new T.PlaneGeometry(SIZE, SIZE, SEG, SEG);
    geo.rotateX(-Math.PI / 2);

    const pa = geo.attributes.position;
    const colors = new Float32Array(pa.count * 3);
    const c = new T.Color();
    const tmp = new T.Color();
    const cDark = new T.Color(0x5aa63f);
    const cMid = new T.Color(0x74c452);
    const cLight = new T.Color(0x9adc63);
    const cSun = new T.Color(0xc8ef8b);
    const cSand = new T.Color(0xe8d9a0);
    const cWet = new T.Color(0xcbd49c);
    const cOuter = new T.Color(0x4f8a3c);
    const P = LAYOUT.pond;
    const waterY = ctx.ground.pondWaterY;

    for (let i = 0; i < pa.count; i++) {
      const x = pa.getX(i);
      const z = pa.getZ(i);
      const y = ctx.ground.groundY(x, z);
      pa.setY(i, y);

      const d = Math.hypot(x, z);
      const n1 = valueNoise2(x * 0.13, z * 0.13);
      const n2 = valueNoise2(x * 0.45 + 7.3, z * 0.45 - 3.1);
      c.copy(cDark).lerp(cMid, smoothstep(0.22, 0.78, n1));
      c.lerp(cLight, smoothstep(0.42, 0.95, n2) * 0.5);
      // 大块阳光斑
      const sunPatch = smoothstep(0.56, 0.96, valueNoise2(x * 0.045 + 11.3, z * 0.045 - 4.7));
      c.lerp(cSun, sunPatch * 0.34);
      // 外圈林地略暗（雾会再压一层）
      c.lerp(cOuter, smoothstep(48, 78, d) * 0.5);
      // 池塘沙岸 + 水下浅沙
      const pd = Math.hypot(x - P.x, z - P.z);
      const bank = smoothstep(P.r * 1.32, P.r * 0.96, pd);
      if (bank > 0.01) {
        c.lerp(cSand, bank * 0.9);
        const under = smoothstep(waterY + 0.12, waterY - 0.1, y);
        c.lerp(cWet, under * 0.7);
      }
      // 细微明暗噪点
      const shade = 0.93 + hash2(x * 3.1, z * 3.7) * 0.13;
      tmp.copy(c).multiplyScalar(shade);
      colors[i * 3] = tmp.r;
      colors[i * 3 + 1] = tmp.g;
      colors[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute('color', new T.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mat = new T.MeshStandardMaterial({
      map: ctx.tex.grass,
      vertexColors: true,
      roughness: 0.97,
      metalness: 0.0,
    });
    const ground = new T.Mesh(geo, mat);
    ground.name = 'terrain';
    ground.receiveShadow = true;
    ctx.group.add(ground);
    ctx.groundMesh = ground;
  }

    // ============================================================
  // 7. 树木：粗壮树干（2 变体）+ 多球树冠（3 变体）· InstancedMesh
  // ============================================================
  function makeTrunkGeo(variant, lod) {
    const short = variant === 1;
    const H = short ? 6.9 : 7.8;
    const profile = [
      [0.02, 0.0],
      [1.02 * (short ? 1.12 : 1.0), 0.0],
      [1.32 * (short ? 1.12 : 1.0), 0.3],
      [1.04, 0.8],
      [0.76, 1.7],
      [0.66, 2.9],
      [0.6, 4.2],
      [0.54, 5.5],
      [0.47, 6.6],
      [0.3, H - 0.4],
      [0.03, H],
    ];
    const parts = [new T.LatheGeometry(profile.map((p) => new T.Vector2(p[0], p[1])), lod ? 7 : 9)];

    // 根部板根（粗壮卡通树的关键剪影）
    const rootCount = 4;
    for (let i = 0; i < rootCount; i++) {
      const a = (i / rootCount) * TAU + (short ? 0.4 : 0.15);
      const g = cylGeo(0.09, 0.52, lod ? 2.1 : 2.5, lod ? 5 : 6, true);
      g.rotateZ(-0.92);
      g.rotateY(-a);
      g.translate(Math.cos(a) * 0.92, 0.5, Math.sin(a) * 0.92);
      parts.push(g);
    }
    // 两根伸进树冠的树枝
    for (let i = 0; i < 2; i++) {
      const a = 0.9 + i * 2.6;
      const g = cylGeo(0.09, 0.23, 2.7, 6, false);
      g.rotateZ(-0.95);
      g.rotateY(-a);
      g.translate(Math.cos(a) * 0.75, 5.5 + i * 0.6, Math.sin(a) * 0.75);
      parts.push(g);
    }

    const geo = mergeGeoms(parts);
    geo.computeVertexNormals();
    const cBase = new T.Color(0x5a3d27);
    const cMid = new T.Color(0x8b5f3c);
    const cTop = new T.Color(0x764f33);
    const cMoss = new T.Color(0x62803c);
    paintVerts(geo, (c, x, y, z) => {
      const t = clamp(y / H, 0, 1);
      c.copy(cBase).lerp(cMid, smoothstep(0.0, 0.3, t));
      c.lerp(cTop, smoothstep(0.4, 1.0, t) * 0.7);
      // 根部长一点青苔
      c.lerp(cMoss, smoothstep(0.9, 0.05, y) * 0.45);
    });
    return geo;
  }

  const CANOPY_VARIANTS = [
    // 0：圆润蓬松
    [
      [0, 7.3, 0, 2.95],
      [-2.45, 6.7, 0.5, 2.25],
      [2.5, 6.85, -0.35, 2.3],
      [0.35, 6.55, 2.4, 2.15],
      [-0.5, 6.9, -2.35, 2.2],
      [1.0, 9.0, 0.25, 2.05],
      [-1.15, 8.4, -0.7, 1.75],
    ],
    // 1：高挑
    [
      [0, 7.6, 0, 2.75],
      [-2.1, 7.0, 0.4, 1.95],
      [2.15, 7.2, -0.3, 2.0],
      [0.2, 6.7, 2.1, 1.85],
      [-0.3, 7.3, -2.05, 1.9],
      [0.5, 9.9, 0.1, 1.9],
      [-0.7, 9.0, -0.5, 1.55],
    ],
    // 2：宽伞状
    [
      [0, 7.0, 0, 2.85],
      [-3.0, 6.5, 0.2, 2.05],
      [3.05, 6.6, -0.2, 2.1],
      [0.3, 6.3, 2.7, 1.9],
      [-0.2, 6.4, -2.65, 1.85],
      [1.6, 8.6, 1.3, 1.7],
      [-1.7, 8.5, -1.1, 1.65],
    ],
  ];

  function makeCanopyGeo(variant, lod) {
    const blobs = CANOPY_VARIANTS[variant] || CANOPY_VARIANTS[0];
    const ws = lod ? 8 : 11, hs = lod ? 6 : 8;
    const parts = blobs.map((b) => {
      const g = new T.SphereGeometry(b[3], ws, hs);
      g.translate(b[0], b[1], b[2]);
      return g;
    });
    const geo = mergeGeoms(parts);
    geo.computeVertexNormals();
    // 深浅两档绿 + 顶部亮黄绿受光（烘焙进顶点色）
    const cDark = new T.Color(0x2e7a33);
    const cMid = new T.Color(0x4e9c3f);
    const cLight = new T.Color(0x8bd154);
    const cTop = new T.Color(0xc9ee7d);
    paintVerts(geo, (c, x, y) => {
      const t = clamp((y - 4.0) / 7.2, 0, 1);
      c.copy(cDark).lerp(cMid, smoothstep(0.0, 0.45, t));
      c.lerp(cLight, smoothstep(0.38, 0.8, t));
      c.lerp(cTop, smoothstep(0.76, 1.0, t));
    });
    return geo;
  }

  function buildTrees(ctx) {
    const rnd = ctx.rnd;
    const P = LAYOUT.pond, S = LAYOUT.altar, R = LAYOUT.ring, RK = LAYOUT.rocks, RK2 = LAYOUT.rocks2;
    const trees = [];

    const altarAng = Math.atan2(S.z, S.x);
    const angGap = (a, b) => {
      let d = a - b;
      while (d > Math.PI) d -= TAU;
      while (d < -Math.PI) d += TAU;
      return Math.abs(d);
    };
    const farFromTrees = (x, z, gap) => {
      for (const t of trees) if (Math.hypot(x - t.x, z - t.z) < gap) return false;
      return true;
    };
    const clearOfSpawns = (x, z, gap) => {
      for (const sp of ctx.spawnPoints) if (Math.hypot(x - sp.x, z - sp.z) < gap) return false;
      return true;
    };
    const clearOfLandmarks = (x, z) => {
      if (Math.hypot(x - P.x, z - P.z) < P.r + 4.6) return false;
      if (Math.hypot(x - S.x, z - S.z) < 10.5) return false;
      if (Math.hypot(x - R.x, z - R.z) < 8.5) return false;
      if (Math.hypot(x - RK.x, z - RK.z) < 9.5) return false;
      if (Math.hypot(x - RK2.x, z - RK2.z) < 9.5) return false;
      return true;
    };

    function addTree(x, z, s, outer, force) {
      if (!force) {
        if (!clearOfSpawns(x, z, 6.4)) return false;
        if (!farFromTrees(x, z, (s + 1) * 3.0)) return false;
        if (!outer && !clearOfLandmarks(x, z)) return false;
      }
      trees.push({
        x,
        z,
        s,
        v: (rnd() * 3) | 0,
        tv: (rnd() * 2) | 0,
        rot: rnd() * TAU,
        outer: !!outer,
        tint: 0.9 + rnd() * 0.18,
        warm: rnd() * 0.1,
      });
      return true;
    }

    // 手工摆位：构图锚点（相机默认 (0,1.7,20) 朝 -Z 时形成天然画框）
    const anchors = [
      [0, -50, 1.8], // 祭坛背后的巨树
      [-24, 11, 1.16],
      [24, 8, 1.12],
      [-33, -9, 1.06],
      [34, -13, 1.04],
      [-20, 30, 1.0],
      [21, 29, 0.96],
      [-20, -31, 1.0],
      [22, -32, 1.02],
      [-44, 26, 1.26],
      [46, 20, 1.22],
      [-15, 43, 1.1],
      [17, 45, 1.06],
    ];
    for (const a of anchors) addTree(a[0], a[1], a[2], a[0] * a[0] + a[1] * a[1] > 62 * 62, true);

    // 中层森林环：30~57 半径随机填充
    for (let i = 0; i < 1200 && trees.length < 78; i++) {
      const a = rnd() * TAU;
      const rr = 29 + rnd() * 27.5;
      const x = Math.cos(a) * rr;
      const z = Math.sin(a) * rr;
      // 祭坛视线走廊留空
      if (rr < 48 && angGap(a, altarAng) < 0.2) continue;
      addTree(x, z, 0.82 + rnd() * 0.44, false, false);
    }

    // 外围森林墙 A（62~74）：把场地围起来
    for (let i = 0; i < 68; i++) {
      const a = (i / 68) * TAU + (rnd() - 0.5) * 0.055;
      const rr = 63 + rnd() * 10;
      addTree(Math.cos(a) * rr, Math.sin(a) * rr, 1.05 + rnd() * 0.5, true, true);
    }
    // 外围森林墙 B（78~96）：远景剪影
    for (let i = 0; i < 46; i++) {
      const a = (i / 46) * TAU + (rnd() - 0.5) * 0.08;
      const rr = 78 + rnd() * 17;
      addTree(Math.cos(a) * rr, Math.sin(a) * rr, 1.45 + rnd() * 0.7, true, true);
    }

    // ---- 生成 InstancedMesh（近景高模 / 远景低模 LOD）----
    const trunkGeos = [makeTrunkGeo(0, false), makeTrunkGeo(1, false)];
    const trunkGeosFar = [makeTrunkGeo(0, true), makeTrunkGeo(1, true)];
    const canopyGeos = [makeCanopyGeo(0, false), makeCanopyGeo(1, false), makeCanopyGeo(2, false)];
    const canopyGeosFar = [makeCanopyGeo(0, true), makeCanopyGeo(1, true), makeCanopyGeo(2, true)];
    const dummy = new T.Object3D();
    const col = new T.Color();

    const groups = []; // { outer, v, list }
    for (const outer of [false, true]) {
      for (let v = 0; v < 3; v++) {
        const list = trees.filter((t) => t.outer === outer && t.v === v);
        if (list.length) groups.push({ outer, v, list });
      }
    }

    // 树干按变体分组合并
    for (const outer of [false, true]) {
      for (let tv = 0; tv < 2; tv++) {
        const list = trees.filter((t) => t.outer === outer && t.tv === tv);
        if (!list.length) continue;
        const mesh = new T.InstancedMesh(outer ? trunkGeosFar[tv] : trunkGeos[tv], ctx.mats.trunk, list.length);
        mesh.name = 'trees-trunk-' + (outer ? 'far' : 'near') + tv;
        for (let i = 0; i < list.length; i++) {
          const t = list[i];
          const gy = ctx.ground.groundY(t.x, t.z);
          dummy.position.set(t.x, gy - 0.28, t.z);
          dummy.rotation.set(0, t.rot, 0);
          dummy.scale.setScalar(t.s);
          dummy.updateMatrix();
          mesh.setMatrixAt(i, dummy.matrix);
          const k = 0.9 + (t.tint - 0.9) * 2;
          col.setRGB(k, k, k * 0.97);
          mesh.setColorAt(i, col);
        }
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.castShadow = !outer;
        mesh.receiveShadow = false;
        mesh.frustumCulled = true;
        ctx.group.add(mesh);
      }
    }

    for (const grp of groups) {
      const mesh = new T.InstancedMesh(grp.outer ? canopyGeosFar[grp.v] : canopyGeos[grp.v], ctx.mats.canopy, grp.list.length);
      mesh.name = 'trees-canopy-' + (grp.outer ? 'far' : 'near') + grp.v;
      for (let i = 0; i < grp.list.length; i++) {
        const t = grp.list[i];
        const gy = ctx.ground.groundY(t.x, t.z);
        dummy.position.set(t.x, gy - 0.28, t.z);
        dummy.rotation.set(0, t.rot, 0);
        dummy.scale.setScalar(t.s);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        // 每棵树轻微色差：偏黄 / 偏青，做出层次
        const k = t.tint;
        col.setRGB(k * (1 + t.warm * 0.35), k, k * (0.95 - t.warm * 0.15));
        mesh.setColorAt(i, col);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = !grp.outer;
      mesh.receiveShadow = false;
      ctx.group.add(mesh);
    }

    // 树干圆柱碰撞体（只统计玩家能到达的范围）
    for (const t of trees) {
      if (t.outer) continue;
      ctx.colliders.push({ x: t.x, z: t.z, r: 1.08 * t.s });
    }
    ctx.trees = trees;
  }

  // ============================================================
  // 8. 草簇（InstancedMesh + GPU 风场）
  //    形态：一小丛向外披散、带弯度的宽叶；顶点色由根深绿→尖亮黄绿，
  //    材质用不透明双面标准材质 + 轻微自发光，避免草叶背面发黑。
  // ============================================================
  function makeGrassGeo() {
    const rnd = mulberry32(9911);
    const pos = [], nor = [], uv = [], col = [], idx = [];
    const cBase = new T.Color(0x3d7a22);
    const cMid = new T.Color(0x5fa232);
    const cTip = new T.Color(0x9ad254);
    const bladeCount = 8;
    let vOff = 0;
    const tmpC = new T.Color();
    for (let b = 0; b < bladeCount; b++) {
      const ang = (b / bladeCount) * TAU + rnd() * 0.9;
      const h = 0.15 + rnd() * 0.17;
      const bend = 0.05 + rnd() * 0.09; // 向外披散
      const w = 0.024 + rnd() * 0.012;
      const dx = Math.cos(ang), dz = Math.sin(ang);
      const ox = dx * 0.035, oz = dz * 0.035; // 从丛心略微偏出
      const rows = [
        [0.0, w, 0.0],
        [h * 0.52, w * 0.82, bend * 0.42],
        [h, w * 0.16, bend],
      ];
      const start = vOff;
      const tx = -dz, tz = dx;
      for (let r = 0; r < rows.length; r++) {
        const y = rows[r][0], half = rows[r][1], off = rows[r][2];
        for (let sgn = -1; sgn <= 1; sgn += 2) {
          pos.push(ox + dx * off + tx * half * sgn, y, oz + dz * off + tz * half * sgn);
          nor.push(0, 1, 0);
          uv.push((sgn + 1) * 0.5, r / 2);
          tmpC.copy(cBase).lerp(cMid, r / 2);
          if (r === 2) tmpC.lerp(cTip, 0.75);
          col.push(tmpC.r, tmpC.g, tmpC.b);
        }
      }
      const rowBase = (r) => start + r * 2;
      idx.push(rowBase(0), rowBase(1), rowBase(3));
      idx.push(rowBase(0), rowBase(3), rowBase(2));
      idx.push(rowBase(2), rowBase(3), rowBase(5));
      idx.push(rowBase(2), rowBase(5), rowBase(4));
      vOff = start + rows.length * 2;
    }
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('normal', new T.BufferAttribute(new Float32Array(nor), 3));
    geo.setAttribute('uv', new T.BufferAttribute(new Float32Array(uv), 2));
    geo.setAttribute('color', new T.BufferAttribute(new Float32Array(col), 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  function buildGrass(ctx) {
    const rnd = ctx.rnd;
    const COUNT = 5200;
    const geo = makeGrassGeo();
    const mesh = new T.InstancedMesh(geo, ctx.mats.grass, COUNT);
    mesh.name = 'grass';
    const dummy = new T.Object3D();
    const col = new T.Color();
    const P = LAYOUT.pond;
    const list = [];
    let guard = 0;
    while (list.length < COUNT && guard++ < COUNT * 10) {
      // 面积均匀 + 近处更密
      const near = rnd() < 0.6;
      const rr = near
        ? Math.sqrt(6 + rnd() * (34 * 34 - 6))
        : Math.sqrt(34 * 34 + rnd() * (61 * 61 - 34 * 34));
      const a = rnd() * TAU;
      const x = Math.cos(a) * rr;
      const z = Math.sin(a) * rr;
      const pd = Math.hypot(x - P.x, z - P.z);
      if (pd < P.r * 1.1) continue; // 水里不长草
      if (rr > 42 && rnd() < 0.45) continue;
      // 用噪声把草聚成一片片，避免均匀铺满
      if (valueNoise2(x * 0.11 + 3.7, z * 0.11 - 1.3) < 0.34) continue;
      list.push({ x, z, s: 0.5 + rnd() * 0.55, rot: rnd() * TAU, tint: rnd() });
    }
    for (let i = 0; i < list.length; i++) {
      const g = list[i];
      dummy.position.set(g.x, ctx.ground.groundY(g.x, g.z) - 0.01, g.z);
      dummy.rotation.set(0, g.rot, 0);
      dummy.scale.set(g.s * (0.95 + g.tint * 0.35), g.s * (0.8 + g.tint * 0.5), g.s * (0.95 + g.tint * 0.35));
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      const k = 0.76 + g.tint * 0.22;
      col.setRGB(k * (0.88 + g.tint * 0.14), k, k * 0.66);
      mesh.setColorAt(i, col);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    ctx.group.add(mesh);
    ctx.stats.grass = list.length;
  }

  // ============================================================
  // 9. 小花（白 / 粉，成片散布）
  //    花冠做成微微上翘的“杯状”立体花瓣，从低机位也能看清；
  //    花瓣 / 花心 / 花茎 = 3 个 InstancedMesh（3 个 draw call）。
  // ============================================================
  function makeFlowerGeos() {
    const petals = [];
    const petalCount = 5;
    const cupTilt = 0.95; // 花瓣向上翘的角度（弧度）
    for (let i = 0; i < petalCount; i++) {
      const phi = (i / petalCount) * TAU;
      const g = new T.CircleGeometry(0.13, 8);
      g.scale(1, 1.55, 1); // 拉长成椭圆花瓣
      g.translate(0, 0.15, 0); // 从花心向外
      g.rotateX(cupTilt); // 翘起
      g.rotateY(phi); // 绕中心散开
      petals.push(g);
    }
    const petalGeo = mergeGeoms(petals);
    petalGeo.computeVertexNormals();
    const centerGeo = new T.SphereGeometry(0.056, 9, 7);
    centerGeo.scale(1, 0.7, 1);
    centerGeo.translate(0, 0.085, 0);
    const stemGeo = new T.CylinderGeometry(0.012, 0.019, 0.2, 5, 1, false);
    stemGeo.translate(0, -0.1, 0);
    return { petalGeo, centerGeo, stemGeo };
  }

  function buildFlowers(ctx) {
    const rnd = ctx.rnd;
    const P = LAYOUT.pond, S = LAYOUT.altar, R = LAYOUT.ring;
    const clusters = [];
    // 先在空地正面放几片花丛（保证默认机位能看到成片小花）
    const featured = [
      { x: -5.5, z: 11.5, r: 2.6 },
      { x: 6.5, z: 10.5, r: 2.4 },
      { x: -12.5, z: 5.5, r: 2.8 },
      { x: 11.5, z: 3.5, r: 2.5 },
      { x: 1.5, z: 4.5, r: 3.0 },
      { x: -3.5, z: -3.5, r: 2.6 },
      { x: 8.5, z: -6.5, r: 2.6 },
      { x: -9.5, z: -11.5, r: 2.8 },
    ];
    for (const f of featured) clusters.push(f);
    let guard = 0;
    while (clusters.length < 44 && guard++ < 900) {
      const rr = 7 + Math.sqrt(rnd()) * 49;
      const a = rnd() * TAU;
      const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
      if (Math.hypot(x - P.x, z - P.z) < P.r * 1.3) continue;
      if (Math.hypot(x - S.x, z - S.z) < 5) continue;
      if (Math.hypot(x - R.x, z - R.z) < 3.5) continue;
      let tooClose = false;
      for (const c of clusters) if (Math.hypot(x - c.x, z - c.z) < 4.5) { tooClose = true; break; }
      if (tooClose) continue;
      clusters.push({ x, z, r: 1.6 + rnd() * 1.6 });
    }
    const flowers = [];
    for (const c of clusters) {
      const rad = c.r || 2.2;
      const n = 9 + ((rnd() * 9) | 0);
      for (let i = 0; i < n; i++) {
        const a = rnd() * TAU;
        const rr = Math.sqrt(rnd()) * rad;
        flowers.push({
          x: c.x + Math.cos(a) * rr,
          z: c.z + Math.sin(a) * rr,
          s: 0.78 + rnd() * 0.5,
          yaw: rnd() * TAU,
          tiltX: (rnd() - 0.5) * 0.24,
          tiltZ: (rnd() - 0.5) * 0.24,
          kind: rnd(),
        });
      }
    }
    const { petalGeo, centerGeo, stemGeo } = makeFlowerGeos();
    const petalMesh = new T.InstancedMesh(petalGeo, ctx.mats.petal, flowers.length);
    const centerMesh = new T.InstancedMesh(centerGeo, ctx.mats.flowerCenter, flowers.length);
    const stemMesh = new T.InstancedMesh(stemGeo, ctx.mats.flowerStem, flowers.length);
    petalMesh.name = 'flowers';
    centerMesh.name = 'flower-centers';
    stemMesh.name = 'flower-stems';
    const dummy = new T.Object3D();
    const col = new T.Color();
    const cWhite = new T.Color(0xffffff);
    const cPink = new T.Color(0xff8fc0);
    const cRose = new T.Color(0xffb8d6);
    const cCream = new T.Color(0xfff0a8);
    const cLilac = new T.Color(0xdcc0ff);
    const euler = new T.Euler();
    for (let i = 0; i < flowers.length; i++) {
      const f = flowers[i];
      dummy.position.set(f.x, ctx.ground.groundY(f.x, f.z) + 0.16 + f.s * 0.02, f.z);
      euler.set(f.tiltX, f.yaw, f.tiltZ, 'YXZ');
      dummy.quaternion.setFromEuler(euler);
      dummy.scale.setScalar(f.s);
      dummy.updateMatrix();
      petalMesh.setMatrixAt(i, dummy.matrix);
      centerMesh.setMatrixAt(i, dummy.matrix);
      stemMesh.setMatrixAt(i, dummy.matrix);
      if (f.kind < 0.38) col.copy(cWhite);
      else if (f.kind < 0.66) col.copy(cPink);
      else if (f.kind < 0.82) col.copy(cRose);
      else if (f.kind < 0.92) col.copy(cCream);
      else col.copy(cLilac);
      petalMesh.setColorAt(i, col);
    }
    petalMesh.instanceMatrix.needsUpdate = true;
    centerMesh.instanceMatrix.needsUpdate = true;
    stemMesh.instanceMatrix.needsUpdate = true;
    if (petalMesh.instanceColor) petalMesh.instanceColor.needsUpdate = true;
    petalMesh.castShadow = false;
    centerMesh.castShadow = false;
    stemMesh.castShadow = false;
    petalMesh.frustumCulled = false;
    centerMesh.frustumCulled = false;
    stemMesh.frustumCulled = false;
    ctx.group.add(stemMesh);
    ctx.group.add(petalMesh);
    ctx.group.add(centerMesh);
    ctx.stats.flowers = flowers.length;
  }

  // ============================================================
  // 10. 红白斑点蘑菇（帽 + 斑点烘焙进同一几何体）+ 蘑菇圈
  // ============================================================
  function makeMushroomGeos() {
    const rnd = mulberry32(4242);
    const capParts = [];
    const cap = new T.SphereGeometry(0.27, 12, 7, 0, TAU, 0, Math.PI * 0.53);
    cap.scale(1, 0.82, 1);
    const cRim = new T.Color(0xc9342c);
    const cTop = new T.Color(0xff7052);
    paintVerts(cap, (c, x, y) => {
      const t = clamp(y / 0.21, 0, 1);
      c.copy(cRim).lerp(cTop, t * 0.75);
    });
    capParts.push(cap);
    // 帽子上的白斑点
    for (let i = 0; i < 5; i++) {
      const theta = 0.28 + rnd() * 0.72;
      const phi = rnd() * TAU;
      const surf = new T.Vector3(
        Math.sin(theta) * Math.cos(phi) * 0.27,
        Math.cos(theta) * 0.82 * 0.27,
        Math.sin(theta) * Math.sin(phi) * 0.27
      );
      const spot = new T.SphereGeometry(0.052, 7, 5);
      spot.scale(1, 0.62, 1);
      spot.translate(surf.x, surf.y + 0.012, surf.z);
      paintVerts(spot, (c) => c.setHex(0xfff4e2));
      capParts.push(spot);
    }
    const capGeo = mergeGeoms(capParts);
    capGeo.computeVertexNormals();
    capGeo.translate(0, 0.3, 0); // 抬到菌柄顶端

    const stemGeo = cylGeo(0.062, 0.098, 0.31, 8, false);
    stemGeo.translate(0, 0.155, 0);
    paintVerts(stemGeo, (c, x, y) => {
      c.setHex(0xe6d2a8).lerp(new T.Color(0xfff6df), clamp(y / 0.3, 0, 1));
    });
    return { capGeo, stemGeo };
  }

  function buildMushrooms(ctx) {
    const rnd = ctx.rnd;
    const { capGeo, stemGeo } = makeMushroomGeos();
    const P = LAYOUT.pond, S = LAYOUT.altar, R = LAYOUT.ring;
    const list = [];
    // 蘑菇圈（妖精环）：15 朵，大一些
    for (let i = 0; i < 15; i++) {
      const a = (i / 15) * TAU + (rnd() - 0.5) * 0.22;
      const rr = 3.5 + rnd() * 2.1;
      list.push({
        x: R.x + Math.cos(a) * rr,
        z: R.z + Math.sin(a) * rr,
        s: 1.15 + rnd() * 0.9,
        rot: rnd() * TAU,
        tilt: (rnd() - 0.5) * 0.18,
      });
    }
    // 零散蘑菇
    let guard = 0;
    while (list.length < 46 && guard++ < 400) {
      const rr = 9 + Math.sqrt(rnd()) * 49;
      const a = rnd() * TAU;
      const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
      if (Math.hypot(x - P.x, z - P.z) < P.r * 1.2) continue;
      if (Math.hypot(x - S.x, z - S.z) < 4) continue;
      if (Math.hypot(x - R.x, z - R.z) < 6) continue;
      list.push({ x, z, s: 0.75 + rnd() * 0.7, rot: rnd() * TAU, tilt: (rnd() - 0.5) * 0.24 });
    }

    const capMesh = new T.InstancedMesh(capGeo, ctx.mats.mushroom, list.length);
    const stemMesh = new T.InstancedMesh(stemGeo, ctx.mats.mushroomStem, list.length);
    capMesh.name = 'mushroom-caps';
    stemMesh.name = 'mushroom-stems';
    const dummy = new T.Object3D();
    const col = new T.Color();
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      dummy.position.set(m.x, ctx.ground.groundY(m.x, m.z) - 0.025, m.z);
      dummy.rotation.set(m.tilt, m.rot, m.tilt * 0.6);
      dummy.scale.setScalar(m.s);
      dummy.updateMatrix();
      capMesh.setMatrixAt(i, dummy.matrix);
      stemMesh.setMatrixAt(i, dummy.matrix);
      const k = 0.92 + rnd() * 0.14;
      col.setRGB(k, k * (0.98 + rnd() * 0.04), k * 0.96);
      capMesh.setColorAt(i, col);
      stemMesh.setColorAt(i, col);
    }
    capMesh.instanceMatrix.needsUpdate = true;
    stemMesh.instanceMatrix.needsUpdate = true;
    if (capMesh.instanceColor) capMesh.instanceColor.needsUpdate = true;
    if (stemMesh.instanceColor) stemMesh.instanceColor.needsUpdate = true;
    capMesh.castShadow = false;
    stemMesh.castShadow = false;
    ctx.group.add(capMesh);
    ctx.group.add(stemMesh);
    ctx.stats.mushrooms = list.length;
  }

  // ============================================================
  // 11. 岩石（低多面体，圆润）+ 池塘岸石
  // ============================================================
  function makeRockGeo(seed, detail, squash) {
    const geo = new T.IcosahedronGeometry(1, detail);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      // 用坐标哈希扰动，保证共享顶点被同样地移动、不裂开
      const f = 0.8 + 0.42 * hash2(x * 5.7 + seed, z * 4.3 + y * 2.9 + seed * 0.7);
      p.setXYZ(i, x * f, y * f, z * f);
    }
    geo.scale(1, squash || 0.7, 1);
    geo.computeVertexNormals();
    const cGray = new T.Color(0x8f9aa0);
    const cLight = new T.Color(0xb9c4b8);
    const cMoss = new T.Color(0x6f9a4e);
    paintVerts(geo, (c, x, y, z) => {
      c.copy(cGray).lerp(cLight, smoothstep(-0.5, 0.7, y) * 0.8);
      c.lerp(cMoss, smoothstep(0.35, 0.95, y) * 0.62);
    });
    geo.translate(0, 0.52, 0);
    return geo;
  }

  function buildRocks(ctx) {
    const rnd = ctx.rnd;
    const P = LAYOUT.pond;
    const bigGeo = makeRockGeo(3.1, 1, 0.72);
    const smallGeo = makeRockGeo(8.4, 0, 0.55);
    const bigs = [];
    const smalls = [];
    // 大石群（两个，形成地标）
    const clusters = [
      { x: LAYOUT.rocks.x, z: LAYOUT.rocks.z, n: 4 },
      { x: LAYOUT.rocks2.x, z: LAYOUT.rocks2.z, n: 3 },
    ];
    for (const c of clusters) {
      for (let i = 0; i < c.n; i++) {
        const a = (i / c.n) * TAU + rnd() * 0.8;
        const rr = i === 0 ? 0 : 1.6 + rnd() * 1.9;
        const s = i === 0 ? 1.9 + rnd() * 0.7 : 1.05 + rnd() * 0.8;
        bigs.push({
          x: c.x + Math.cos(a) * rr,
          z: c.z + Math.sin(a) * rr,
          s,
          rot: rnd() * TAU,
        });
        if (s > 1.15) ctx.colliders.push({ x: c.x + Math.cos(a) * rr, z: c.z + Math.sin(a) * rr, r: 0.92 * s });
      }
    }
    // 零散小石块
    for (let i = 0; i < 30; i++) {
      const rr = 12 + Math.sqrt(rnd()) * 47;
      const a = rnd() * TAU;
      const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
      if (Math.hypot(x - P.x, z - P.z) < P.r * 1.15) continue;
      smalls.push({ x, z, s: 0.3 + rnd() * 0.5, rot: rnd() * TAU });
    }
    // 池塘岸石（围一圈）
    for (let i = 0; i < 22; i++) {
      const a = (i / 22) * TAU + (rnd() - 0.5) * 0.2;
      const rr = P.r + 0.55 + rnd() * 1.5;
      smalls.push({
        x: P.x + Math.cos(a) * rr,
        z: P.z + Math.sin(a) * rr,
        s: 0.42 + rnd() * 0.42,
        rot: rnd() * TAU,
      });
    }

    const dummy = new T.Object3D();
    const col = new T.Color();
    const mk = (geo, mat, list, name, cast) => {
      const mesh = new T.InstancedMesh(geo, mat, list.length);
      mesh.name = name;
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        dummy.position.set(r.x, ctx.ground.groundY(r.x, r.z) - 0.04, r.z);
        dummy.rotation.set(0, r.rot, 0);
        dummy.scale.set(r.s * (0.85 + rnd() * 0.3), r.s, r.s * (0.85 + rnd() * 0.3));
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        const k = 0.9 + rnd() * 0.16;
        col.setRGB(k, k, k);
        mesh.setColorAt(i, col);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
      ctx.group.add(mesh);
      return mesh;
    };
    mk(bigGeo, ctx.mats.rock, bigs, 'rocks-big', true);
    mk(smallGeo, ctx.mats.rock, smalls, 'rocks-small', false);
    ctx.stats.rocks = bigs.length + smalls.length;
  }

    // ============================================================
  // 12. 水塘：半透明水面 shader + 波纹 + 睡莲 + 木栈桥
  // ============================================================
  const WATER_VERT = [
    'varying vec3 vWorld;',
    'void main() {',
    '  vec4 wp = modelMatrix * vec4(position, 1.0);',
    '  vWorld = wp.xyz;',
    '  gl_Position = projectionMatrix * viewMatrix * wp;',
    '}',
  ].join('\n');

  const WATER_FRAG = [
    'uniform float uTime;',
    'uniform vec2 uCenter;',
    'uniform float uRadius;',
    'uniform vec3 uCamPos;',
    'uniform vec3 uDeep;',
    'uniform vec3 uShallow;',
    'uniform vec3 uSky;',
    'uniform vec3 uFoam;',
    'uniform vec3 uSun;',
    'varying vec3 vWorld;',
    'void main() {',
    '  vec2 p = vWorld.xz;',
    '  float d = clamp(length(p - uCenter) / uRadius, 0.0, 1.2);',
    // 三组行波叠加出柔和波纹
    '  float w = sin(p.x * 1.9 + uTime * 1.15) * 0.5',
    '          + sin(p.y * 2.4 - uTime * 0.95) * 0.5',
    '          + sin((p.x + p.y) * 3.6 + uTime * 1.75) * 0.32',
    '          + sin((p.x - p.y) * 5.9 - uTime * 2.1) * 0.16;',
    '  float ripple = w * 0.42 + 0.5;',
    '  vec3 col = mix(uDeep, uShallow, clamp(d * 0.85 + ripple * 0.22, 0.0, 1.0));',
    // 波峰亮边
    '  float crest = smoothstep(0.66, 0.96, ripple);',
    '  col += uSun * crest * 0.3;',
    // 阳光碎金
    '  vec2 gp = p * 1.35;',
    '  float sp = pow(max(0.0, sin(gp.x * 6.3 + uTime * 2.4) * sin(gp.y * 5.7 - uTime * 1.8)), 14.0);',
    '  col += uSun * sp * 1.4;',
    // 视角菲涅尔：平视时映出天空
    '  vec3 viewDir = normalize(uCamPos - vWorld);',
    '  float fres = pow(1.0 - clamp(viewDir.y, 0.0, 1.0), 2.2);',
    '  col = mix(col, uSky, fres * 0.5);',
    // 岸边泡沫
    '  float foam = smoothstep(0.87, 1.0, d);',
    '  col = mix(col, uFoam, foam * 0.55);',
    '  float alpha = 0.82 * (1.0 - smoothstep(0.9, 1.02, d));',
    '  gl_FragColor = vec4(col, alpha);',
    '  #include <tonemapping_fragment>',
    '  #include <colorspace_fragment>',
    '}',
  ].join('\n');

  function buildPond(ctx) {
    const P = LAYOUT.pond;
    const waterY = ctx.ground.pondWaterY;
    const waterR = P.r * 0.96; // 水面略大，边缘埋进岸里，看起来水满到岸边
    const rnd = ctx.rnd;

    // ---- 水面 ----
    const uniforms = {
      uTime: { value: 0 },
      uCenter: { value: new T.Vector2(P.x, P.z) },
      uRadius: { value: waterR },
      uCamPos: { value: new T.Vector3(0, 2, 20) },
      uDeep: { value: new T.Color(0x2f9fc4) },
      uShallow: { value: new T.Color(0x8ae8d2) },
      uSky: { value: new T.Color(0xd8f3ff) },
      uFoam: { value: new T.Color(0xf6fffa) },
      uSun: { value: new T.Color(0xfff6cc) },
    };
    const waterGeo = new T.CircleGeometry(waterR, 64);
    waterGeo.rotateX(-Math.PI / 2);
    const waterMat = new T.ShaderMaterial({
      uniforms,
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
      transparent: true,
      depthWrite: false,
      side: T.DoubleSide,
    });
    const water = new T.Mesh(waterGeo, waterMat);
    water.name = 'pond-water';
    water.position.set(P.x, waterY, P.z);
    water.renderOrder = 2;
    ctx.group.add(water);
    ctx.waterUniform = uniforms;

    // ---- 睡莲 ----
    const padGeo = new T.CircleGeometry(0.55, 13);
    // 切一个缺口更像睡莲叶
    const padPos = padGeo.attributes.position;
    for (let i = 0; i < padPos.count; i++) {
      const x = padPos.getX(i), y = padPos.getY(i);
      const a = Math.atan2(y, x);
      if (a > 0.25 && a < 0.55) padGeo.attributes.position.setXYZ(i, x * 0.55, y * 0.55, 0);
    }
    padGeo.rotateX(-Math.PI / 2);
    const padCount = 10;
    const padMesh = new T.InstancedMesh(padGeo, ctx.mats.lily, padCount);
    padMesh.name = 'lily-pads';
    const dummy = new T.Object3D();
    const col = new T.Color();
    const pads = [];
    for (let i = 0; i < padCount; i++) {
      const a = rnd() * TAU;
      const rr = 1.2 + rnd() * (waterR * 0.72);
      pads.push({
        x: P.x + Math.cos(a) * rr,
        z: P.z + Math.sin(a) * rr,
        phase: rnd() * TAU,
        s: 0.7 + rnd() * 0.85,
        rot: rnd() * TAU,
      });
    }
    for (let i = 0; i < padCount; i++) {
      const p = pads[i];
      dummy.position.set(p.x, waterY + 0.045, p.z);
      dummy.rotation.set(0, p.rot, 0);
      dummy.scale.setScalar(p.s);
      dummy.updateMatrix();
      padMesh.setMatrixAt(i, dummy.matrix);
      const k = 0.85 + rnd() * 0.3;
      col.setRGB(0.32 * k, 0.55 * k, 0.2 * k);
      padMesh.setColorAt(i, col);
    }
    padMesh.instanceMatrix.needsUpdate = true;
    if (padMesh.instanceColor) padMesh.instanceColor.needsUpdate = true;
    padMesh.castShadow = false;
    ctx.group.add(padMesh);

    // ---- 水面涟漪圈 ----
    const ringGeo = new T.RingGeometry(0.86, 1.0, 40);
    ringGeo.rotateX(-Math.PI / 2);
    const ripples = [];
    for (let i = 0; i < 6; i++) {
      const mat = new T.MeshBasicMaterial({
        color: 0xe6fbff,
        transparent: true,
        opacity: 0,
        blending: T.AdditiveBlending,
        depthWrite: false,
        side: T.DoubleSide,
        fog: false,
      });
      const mesh = new T.Mesh(ringGeo, mat);
      const a = rnd() * TAU;
      const rr = 1.0 + rnd() * (waterR * 0.55);
      mesh.position.set(P.x + Math.cos(a) * rr, waterY + 0.035, P.z + Math.sin(a) * rr);
      mesh.renderOrder = 3;
      ctx.group.add(mesh);
      ripples.push({ mesh, mat, phase: i / 6 + rnd() * 0.1 });
    }

    // ---- 木栈桥 ----
    const d = new T.Vector2(0 - P.x, 0 - P.z).normalize(); // 从塘心指向空地中心
    const shore = P.r + 0.4;
    const px = P.x + d.x * (shore - 1.7);
    const pz = P.z + d.y * (shore - 1.7);
    const pierParts = [];
    for (let i = 0; i < 5; i++) {
      const plank = boxGeo(0.56, 0.09, 3.3);
      plank.translate((i - 2) * 0.62, 0, 0);
      pierParts.push(plank);
    }
    for (const sx of [-1.35, 1.35]) {
      for (const sz of [-1.5, 1.5]) {
        const post = cylGeo(0.085, 0.1, 1.5, 7, false);
        post.translate(sx * 1.05, -0.55, sz);
        pierParts.push(post);
      }
    }
    const pier = new T.Mesh(mergeGeoms(pierParts), ctx.mats.woodLight);
    pier.name = 'pier';
    pier.position.set(px, waterY + 0.22, pz);
    pier.rotation.y = Math.atan2(-d.x, -d.y); // 桥头朝塘心
    pier.castShadow = true;
    pier.receiveShadow = true;
    ctx.group.add(pier);

    // ---- 每帧动画 ----
    const padDummy = new T.Object3D();
    ctx.dyn.updaters.push((dt, time) => {
      uniforms.uTime.value = time;
      // 睡莲随波起伏
      for (let i = 0; i < pads.length; i++) {
        const p = pads[i];
        padDummy.position.set(p.x, waterY + 0.045 + Math.sin(time * 0.8 + p.phase) * 0.03, p.z);
        padDummy.rotation.set(0, p.rot + Math.sin(time * 0.25 + p.phase) * 0.18, 0);
        padDummy.scale.setScalar(p.s);
        padDummy.updateMatrix();
        padMesh.setMatrixAt(i, padDummy.matrix);
      }
      padMesh.instanceMatrix.needsUpdate = true;
      // 涟漪扩散
      for (const r of ripples) {
        const t = fract(time * 0.19 + r.phase);
        const s = 0.45 + t * 3.1;
        r.mesh.scale.set(s, 1, s);
        r.mat.opacity = Math.pow(1 - t, 2.2) * 0.5;
      }
    });
  }

  // ============================================================
  // 13. 祭坛：中式牌坊 + 石台 + 石碑 + 玉璧 + 石鼎香炉 + 石阶
  // ============================================================
  function buildAltar(ctx) {
    const S = LAYOUT.altar;
    const gy = ctx.ground.groundY(S.x, S.z);
    const root = new T.Group();
    root.name = 'altar';
    root.position.set(S.x, gy, S.z);
    ctx.group.add(root);

    const lacquer = []; // 朱漆构件（方柱 / 横梁 / 楹联板）
    const timber = []; // 深色木构（斗拱 / 雀替 / 椽头 / 匾框）
    const stone = []; // 青石（柱础 / 台基 / 石碑 / 石鼎 / 香案 / 石阶）
    const gold = []; // 鎏金饰件（柱箍 / 鸱吻 / 鼎耳）
    const roofTiles = []; // 青瓦屋面（两坡 / 瓦垄 / 正脊 / 垂脊 / 翘角）
    const ember = []; // 石鼎内的香火

    // ---- 牌坊：三间四柱三楼（两坡瓦顶 + 正脊 / 垂脊 / 鸱吻 + 飞檐翘角）----
    const colX = 2.5; // 主柱（中开间）
    const colW = 0.62;
    const colBaseH = 0.42;
    const colH = 5.0;
    const colTop = colBaseH + colH;
    const sideX = 4.3; // 侧柱（外移、矮柱）
    const sideW = 0.5;
    const sideBaseH = 0.34;
    const sideH = 3.06;
    const sideTop = sideBaseH + sideH;

    /** 两坡瓦顶：坡面 + 瓦垄 + 正脊 + 垂脊 + 四角飞檐翘起；outerDir 非空时只在该端做鸱吻 */
    const addRoof = (cx, width, eaveY, ridgeY, halfDepth, tileStep, outerDir) => {
      const rise = ridgeY - eaveY;
      const len = Math.sqrt(rise * rise + halfDepth * halfDepth);
      const ang = Math.atan2(rise, halfDepth);
      const midY = (eaveY + ridgeY) / 2;
      const off = 0.1; // 瓦垄抬离坡面
      for (const s of [-1, 1]) {
        // 坡面（前 / 后）
        const slope = boxGeo(width, 0.13, len);
        slope.rotateX(s * ang);
        slope.translate(cx, midY, (s * halfDepth) / 2);
        roofTiles.push(slope);
        // 瓦垄细条
        const n = Math.max(3, Math.round(width / tileStep));
        for (let i = 0; i <= n; i++) {
          const tx = cx - width / 2 + (width * i) / n;
          const tile = boxGeo(0.09, 0.07, len * 1.02);
          tile.rotateX(s * ang);
          tile.translate(tx, midY + (off * halfDepth) / len, s * (halfDepth / 2 + (off * rise) / len));
          roofTiles.push(tile);
        }
        // 两端垂脊 + 飞檐翘角
        for (const e of [-1, 1]) {
          const hip = boxGeo(0.16, 0.11, len * 1.02);
          hip.rotateX(s * ang);
          hip.translate(cx + (e * width) / 2, midY + 0.04, (s * halfDepth) / 2);
          roofTiles.push(hip);
          const tip = boxGeo(0.58, 0.1, 0.52);
          tip.rotateZ(e * 0.42);
          tip.rotateX(s * 0.1);
          tip.translate(cx + e * (width / 2 + 0.1), eaveY + 0.05, s * halfDepth);
          roofTiles.push(tip);
          const horn = new T.ConeGeometry(0.11, 0.26, 4);
          horn.rotateZ(e * 0.85);
          horn.translate(cx + e * (width / 2 + 0.42), eaveY + 0.22, s * halfDepth);
          gold.push(horn);
        }
      }
      // 正脊 + 鸱吻（小 box + 锥体）
      const ridge = boxGeo(width + 0.24, 0.24, 0.34);
      ridge.translate(cx, ridgeY + 0.1, 0);
      roofTiles.push(ridge);
      for (const e of [-1, 1]) {
        if (outerDir != null && e !== outerDir) continue;
        const chiwen = boxGeo(0.3, 0.46, 0.3);
        chiwen.rotateZ(e * 0.18);
        chiwen.translate(cx + e * (width / 2 + 0.12), ridgeY + 0.36, 0);
        timber.push(chiwen);
        const beak = new T.ConeGeometry(0.13, 0.3, 4);
        beak.rotateZ(e * 0.55);
        beak.translate(cx + e * (width / 2 + 0.2), ridgeY + 0.62, 0);
        gold.push(beak);
      }
    };

    for (const side of [-1, 1]) {
      const x = side * colX;
      // 青石柱础
      const footing = boxGeo(colW + 0.5, colBaseH, colW + 0.5);
      footing.translate(x, colBaseH / 2, 0);
      stone.push(footing);
      // 朱漆方柱（上端略向中心收）
      const col = boxGeo(colW, colH, colW);
      col.rotateZ(-side * 0.012);
      col.translate(x, colBaseH + colH / 2, 0);
      lacquer.push(col);
      // 鎏金柱箍（上下两道）
      for (const cy of [colBaseH + 0.36, colTop - 0.48]) {
        const band = boxGeo(colW + 0.1, 0.12, colW + 0.1);
        band.translate(x, cy, 0);
        gold.push(band);
      }
      // 楹联板：鎏金外框 + 朱漆板面
      const coupletFrame = boxGeo(0.5, 1.52, 0.06);
      coupletFrame.translate(x, 2.5, colW / 2 + 0.03);
      gold.push(coupletFrame);
      const coupletFace = boxGeo(0.38, 1.4, 0.05);
      coupletFace.translate(x, 2.5, colW / 2 + 0.09);
      lacquer.push(coupletFace);

      // 侧柱（矮柱，外移）
      const sx = side * sideX;
      const sideFoot = boxGeo(sideW + 0.36, sideBaseH, sideW + 0.36);
      sideFoot.translate(sx, sideBaseH / 2, 0);
      stone.push(sideFoot);
      const sideCol = boxGeo(sideW, sideH, sideW);
      sideCol.translate(sx, sideBaseH + sideH / 2, 0);
      lacquer.push(sideCol);
      const sideBand = boxGeo(sideW + 0.08, 0.1, sideW + 0.08);
      sideBand.translate(sx, sideTop - 0.3, 0);
      gold.push(sideBand);
      // 侧额枋（连接主柱与侧柱）
      const sideBeam = boxGeo(sideX - colX + 0.32, 0.3, 0.5);
      sideBeam.translate(side * ((colX + sideX) / 2), 2.95, 0);
      lacquer.push(sideBeam);
      // 次间花板 + 鎏金镂条
      const panel = boxGeo(1.7, 0.5, 0.12);
      panel.translate(side * 3.4, 3.3, 0);
      timber.push(panel);
      for (const px of [-0.55, 0, 0.55]) {
        const slat = boxGeo(0.06, 0.36, 0.05);
        slat.translate(side * 3.4 + px, 3.3, 0.09);
        gold.push(slat);
      }
      // 侧柱雀替
      const sideBrace = boxGeo(0.42, 0.16, 0.34);
      sideBrace.rotateZ(-side * 0.7);
      sideBrace.translate(side * (sideX - sideW / 2 - 0.18), 2.62, 0);
      timber.push(sideBrace);

      // 次楼两坡瓦顶（楼高低于主楼）
      addRoof(side * 3.9, 2.1, 3.75, 4.72, 0.9, 0.62, side);
    }

    // 小额枋（下横梁，贯通中柱）
    const lowerBeam = boxGeo(colX * 2 + 0.7, 0.28, 0.5);
    lowerBeam.translate(0, 3.28, 0);
    lacquer.push(lowerBeam);
    // 匾上小额枋
    const upperSubBeam = boxGeo(3.5, 0.16, 0.52);
    upperSubBeam.translate(0, 4.74, 0);
    lacquer.push(upperSubBeam);
    // 大额枋（主横梁）
    const beamY = 5.02;
    const beam = boxGeo(6.9, 0.44, 0.64);
    beam.translate(0, beamY, 0);
    lacquer.push(beam);
    const beamTrim = boxGeo(6.4, 0.09, 0.72);
    beamTrim.translate(0, beamY - 0.25, 0);
    gold.push(beamTrim);
    // 斗拱（五攒两层叠斗）
    for (const dx of [-2.4, -1.2, 0, 1.2, 2.4]) {
      const b1 = boxGeo(0.6, 0.2, 0.66);
      b1.translate(dx, 5.3, 0);
      timber.push(b1);
      const b2 = boxGeo(0.42, 0.18, 0.54);
      b2.translate(dx, 5.5, 0);
      timber.push(b2);
      const cap = boxGeo(0.72, 0.08, 0.74);
      cap.translate(dx, 5.62, 0);
      timber.push(cap);
    }
    // 柱头雀替（中柱两侧角撑）
    for (const side of [-1, 1]) {
      for (const e of [-1, 1]) {
        const brace = boxGeo(0.5, 0.16, 0.36);
        brace.rotateZ(e * 0.78);
        brace.translate(side * colX + e * 0.4, 4.78, 0);
        timber.push(brace);
      }
    }
    // 椽头（主楼 / 次楼檐下小方块）
    for (const s of [-1, 1]) {
      for (let i = 0; i <= 8; i++) {
        const rafter = boxGeo(0.12, 0.14, 0.16);
        rafter.translate(-3.9 + i * 0.975, 5.5, s * 1.02);
        timber.push(rafter);
      }
      for (const side of [-1, 1]) {
        for (let i = 0; i < 4; i++) {
          const rafter = boxGeo(0.1, 0.12, 0.14);
          rafter.translate(side * (2.5 + i * 0.6), 3.42, s * 0.86);
          timber.push(rafter);
        }
      }
    }
    // 主楼两坡瓦顶（占满牌坊宽度）
    addRoof(0, 8.8, 5.68, 6.62, 1.15, 0.78, null);
    // 匾额木框（题字贴图另贴在框前）
    const plaqueFrame = boxGeo(1.16, 1.3, 0.16);
    plaqueFrame.translate(0, 4.0, 0.2);
    timber.push(plaqueFrame);

    // ---- 石鼎香炉 ×2（香火微光 + 青烟）----
    const censers = [];
    for (const side of [-1, 1]) {
      const lx = side * 5.7;
      const lz = 1.5;
      // 三足（石鼎）：向外撇开，鼎足立于地面
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * TAU + Math.PI * 0.5;
        const leg = cylGeo(0.085, 0.115, 0.56, 7, false);
        leg.rotateX(Math.cos(a) * 0.3);
        leg.rotateZ(-Math.sin(a) * 0.3);
        leg.translate(lx + Math.cos(a) * 0.34, 0.29, lz + Math.sin(a) * 0.34);
        stone.push(leg);
      }
      // 鼎身（鼓腹）
      const belly = cylGeo(0.44, 0.34, 0.46, 12, false);
      belly.translate(lx, 0.79, lz);
      stone.push(belly);
      // 鼎口沿
      const rim = cylGeo(0.52, 0.46, 0.16, 12, false);
      rim.translate(lx, 1.1, lz);
      stone.push(rim);
      // 双耳（鎏金）
      for (const ex of [-1, 1]) {
        const ear = boxGeo(0.12, 0.3, 0.16);
        ear.rotateZ(ex * 0.12);
        ear.translate(lx + ex * 0.42, 1.28, lz);
        gold.push(ear);
      }
      // 香火（鼎口内的微光）
      const coals = new T.SphereGeometry(0.3, 12, 8);
      coals.scale(1, 0.24, 1);
      coals.translate(lx, 1.12, lz);
      ember.push(coals);
      censers.push({ x: lx, z: lz });
    }

    // ---- 祭坛石台：三层青石台基 ----
    const az = -2.45;
    for (const t of [
      [4.4, 0.24, 2.9, 0.12],
      [3.6, 0.22, 2.3, 0.35],
      [2.8, 0.2, 1.8, 0.56],
    ]) {
      const tier = boxGeo(t[0], t[1], t[2]);
      tier.translate(0, t[3], az);
      stone.push(tier);
    }
    // 台前踏跺（三级）
    for (let i = 0; i < 3; i++) {
      const st = boxGeo(1.9 - i * 0.12, 0.16, 0.34);
      st.translate(0, 0.14 + i * 0.17, az + 2.26 - i * 0.32);
      stone.push(st);
    }
    // ---- 石碑：碑座 + 碑身 + 云头碑首 ----
    const stepTop = 0.66;
    const steleBase = boxGeo(1.5, 0.16, 0.62);
    steleBase.translate(0, stepTop + 0.08, az);
    stone.push(steleBase);
    const stele = boxGeo(1.16, 2.0, 0.3);
    stele.translate(0, stepTop + 1.16, az);
    stone.push(stele);
    for (const side of [-1, 1]) {
      const horn = boxGeo(0.3, 0.52, 0.34);
      horn.rotateZ(side * 0.42);
      horn.translate(side * 0.6, stepTop + 2.32, az);
      stone.push(horn);
    }
    const steleFace = new T.Mesh(
      new T.PlaneGeometry(0.74, 1.3),
      new T.MeshStandardMaterial({ map: ctx.tex.stele, roughness: 0.9, metalness: 0, side: T.DoubleSide })
    );
    steleFace.position.set(0, stepTop + 1.34, az + 0.17);
    root.add(steleFace);

    // ---- 香案（祭坛前的供桌）----
    const tableTop = boxGeo(2.0, 0.2, 0.92);
    tableTop.translate(0, 0.56, 2.6);
    stone.push(tableTop);
    const tableTrim = boxGeo(2.08, 0.06, 1.0);
    tableTrim.translate(0, 0.67, 2.6);
    gold.push(tableTrim);
    for (const side of [-1, 1]) {
      const leg = boxGeo(0.34, 0.52, 0.72);
      leg.translate(side * 0.74, 0.26, 2.6);
      stone.push(leg);
    }
    // ---- 石阶（香案前三级踏跺，通向牌坊）----
    for (let i = 0; i < 3; i++) {
      const st = boxGeo(4.2 - i * 0.45, 0.16, 0.72);
      st.translate(0, 0.08 - i * 0.005, 3.55 + i * 0.82);
      stone.push(st);
    }

    const shadowOn = true;
    const addMerged = (parts, mat, name) => {
      if (!parts.length) return null;
      const mesh = new T.Mesh(mergeGeoms(parts), mat);
      mesh.name = name;
      mesh.castShadow = shadowOn;
      mesh.receiveShadow = true;
      root.add(mesh);
      return mesh;
    };
    addMerged(lacquer, ctx.mats.woodRed, 'altar-lacquer');
    addMerged(timber, ctx.mats.woodDark, 'altar-timber');
    addMerged(stone, ctx.mats.altarStone, 'altar-stone');
    addMerged(gold, ctx.mats.gold, 'altar-gold');
    addMerged(roofTiles, ctx.mats.roofTile, 'altar-roof');
    const emberMesh = addMerged(ember, ctx.mats.censerGlow, 'altar-censer-glow');
    if (emberMesh) emberMesh.castShadow = false;

    // ---- 牌坊匾额（题字「山海」）----
    const plaque = new T.Mesh(
      new T.PlaneGeometry(0.92, 1.06),
      new T.MeshStandardMaterial({ map: ctx.tex.plaque, roughness: 0.85, side: T.DoubleSide })
    );
    plaque.position.set(0, 4.0, 0.29);
    root.add(plaque);

    // ---- 青玉璧：悬在香案上方的发光玉环 + 光晕 ----
    const biGroup = new T.Group();
    biGroup.position.set(0, 2.25, 2.55);
    root.add(biGroup);
    const bi = new T.Mesh(new T.TorusGeometry(0.58, 0.15, 10, 30), ctx.mats.jadeGlow);
    bi.castShadow = false;
    biGroup.add(bi);
    // 璧面三颗鎏金粟纹（转动时可见）
    const studParts = [];
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * TAU;
      const stud = sphereGeo(0.085, 8, 6);
      stud.translate(Math.cos(a) * 0.58, Math.sin(a) * 0.58, 0);
      studParts.push(stud);
    }
    const studs = new T.Mesh(mergeGeoms(studParts), ctx.mats.gold);
    studs.castShadow = false;
    biGroup.add(studs);
    const haloMat = (opacity, tint) =>
      new T.SpriteMaterial({
        map: ctx.tex.glowWhite,
        color: tint,
        transparent: true,
        opacity,
        blending: T.AdditiveBlending,
        depthWrite: false,
        fog: false,
      });
    const haloBig = new T.Sprite(haloMat(0.2, 0x9dffe4));
    haloBig.scale.set(4.2, 4.2, 1);
    biGroup.add(haloBig);
    const haloSmall = new T.Sprite(haloMat(0.55, 0xd8fff2));
    haloSmall.scale.set(1.8, 1.8, 1);
    biGroup.add(haloSmall);

    // ---- 石鼎香炉的微光 ----
    const censerHalos = [];
    for (const c of censers) {
      const sp = new T.Sprite(haloMat(0.46, 0xffc97a));
      sp.scale.set(1.7, 1.7, 1);
      sp.position.set(c.x, 1.5, c.z);
      root.add(sp);
      censerHalos.push(sp);
    }
    // ---- 青烟：石鼎上方缓缓上升、放大、渐隐的柔光 ----
    const smoke = [];
    for (const c of censers) {
      const sway = c.x < 0 ? -0.18 : 0.18;
      for (let k = 0; k < 3; k++) {
        const mat = new T.SpriteMaterial({
          map: ctx.tex.glowWhite,
          color: 0xdfeae2,
          transparent: true,
          opacity: 0.2,
          depthWrite: false,
          fog: true,
        });
        const sp = new T.Sprite(mat);
        sp.scale.set(0.72, 0.72, 1);
        root.add(sp);
        smoke.push({ sprite: sp, x: c.x, z: c.z, phase: k / 3, sway: sway });
      }
    }

    // ---- 石阶石板（从空地方向一路铺到祭坛）----
    const slabGeo = cylGeo(1, 1, 0.16, 9, false);
    slabGeo.translate(0, -0.02, 0);
    paintVerts(slabGeo, (c, x, y) => {
      c.setHex(0x9aa596).lerp(new T.Color(0xc3ccb9), smoothstep(-0.5, 0.5, y));
    });
    const slabCount = 12;
    const slabs = new T.InstancedMesh(slabGeo, ctx.mats.slab, slabCount);
    slabs.name = 'altar-path';
    const dummy = new T.Object3D();
    const slabCol = new T.Color();
    for (let i = 0; i < slabCount; i++) {
      const z = -28.5 + i * 1.85;
      const x = Math.sin(i * 0.9) * 0.55;
      dummy.position.set(S.x + x, ctx.ground.groundY(S.x + x, z) + 0.04, z);
      dummy.rotation.set(0, (i * 1.37) % TAU, 0);
      dummy.scale.set(0.72 + (i % 3) * 0.12, 1, 0.72 + (i % 2) * 0.14);
      dummy.updateMatrix();
      slabs.setMatrixAt(i, dummy.matrix);
      const k = 0.9 + (i % 4) * 0.04;
      slabCol.setRGB(k, k, k * 0.97);
      slabs.setColorAt(i, slabCol);
    }
    slabs.instanceMatrix.needsUpdate = true;
    if (slabs.instanceColor) slabs.instanceColor.needsUpdate = true;
    slabs.receiveShadow = true;
    ctx.group.add(slabs);

    // ---- 祭坛碰撞体（方柱 / 石鼎 / 香案）——位置与旧版一致 ----
    ctx.colliders.push({ x: S.x - 2.5, z: S.z, r: 0.62 });
    ctx.colliders.push({ x: S.x + 2.5, z: S.z, r: 0.62 });
    ctx.colliders.push({ x: S.x - 5.7, z: S.z + 1.5, r: 0.55 });
    ctx.colliders.push({ x: S.x + 5.7, z: S.z + 1.5, r: 0.55 });
    ctx.colliders.push({ x: S.x, z: S.z + 2.6, r: 0.95 });

    ctx.dyn.altar = {
      biGroup,
      bi,
      haloBig,
      haloSmall,
      censerHalos,
      smoke,
      jadeMat: ctx.mats.jadeGlow,
      censerMat: ctx.mats.censerGlow,
    };
    ctx.dyn.updaters.push((dt, time) => {
      // 玉璧悬浮 + 缓转
      biGroup.position.y = 2.25 + Math.sin(time * 1.15) * 0.12;
      biGroup.rotation.z = time * 0.35;
      const pulse = 1 + Math.sin(time * 1.6) * 0.08;
      haloSmall.scale.set(1.8 * pulse, 1.8 * pulse, 1);
      const hb = 4.2 * (1 + Math.sin(time * 0.9 + 1.2) * 0.06);
      haloBig.scale.set(hb, hb, 1);
      // 青玉与香火的呼吸微光
      ctx.mats.jadeGlow.emissiveIntensity = 2.2 + Math.sin(time * 1.5) * 0.25;
      for (const sp of censerHalos) sp.material.opacity = 0.4 + Math.sin(time * 3.1) * 0.1;
      ctx.mats.censerGlow.emissiveIntensity = 1.7 + Math.sin(time * 3.1) * 0.22 + Math.sin(time * 7.7) * 0.1;
      // 青烟：循环上升 + 放大 + 渐隐
      for (const s of smoke) {
        const k = fract(time * 0.16 + s.phase);
        const sway = Math.sin(time * 0.9 + s.phase * 6.0) * 0.16;
        s.sprite.position.set(
          s.x + sway + s.sway * k,
          1.15 + k * 2.2,
          s.z + Math.cos(time * 0.75 + s.phase * 5.0) * 0.14
        );
        const sc = 0.72 + k * 1.15;
        s.sprite.scale.set(sc, sc, 1);
        s.sprite.material.opacity = Math.sin(k * Math.PI) * 0.26;
      }
    });
  }

  // ============================================================
  // 14. 丁达尔光柱（合并几何 + 顶点 alpha 的加法混合）
  // ============================================================
  function buildGodRays(ctx) {
    const rnd = ctx.rnd;
    const spots = [
      [-7, -6], [8, -12], [-14, -16], [13, -19], [-3, -26],
      [18, -9], [-18, -24], [4, -30], [10, -31],
    ];
    const warm = new T.Color(0xffe4a2);
    const up = new T.Vector3(0, 1, 0);
    const parts = [];
    for (const s of spots) {
      const x = s[0] + (rnd() - 0.5) * 2.4;
      const z = s[1] + (rnd() - 0.5) * 2.4;
      const h = 12 + rnd() * 4.5;
      const rb = 0.9 + rnd() * 1.05;
      const rt = 0.24 + rnd() * 0.3;
      const g = new T.CylinderGeometry(rt, rb, h, 10, 5, true);
      const p = g.attributes.position;
      const colArr = new Float32Array(p.count * 4);
      const tint = 0.34 + rnd() * 0.24;
      for (let i = 0; i < p.count; i++) {
        const t = (p.getY(i) + h / 2) / h; // 0 = 地面，1 = 树冠
        let a = smoothstep(0.02, 0.3, t) * (1 - smoothstep(0.8, 1.0, t));
        a *= 0.55 + 0.45 * Math.sin(Math.atan2(p.getX(i), p.getZ(i)) * 3.0 + s[0]);
        a *= tint;
        colArr[i * 4] = warm.r;
        colArr[i * 4 + 1] = warm.g;
        colArr[i * 4 + 2] = warm.b;
        colArr[i * 4 + 3] = clamp(a, 0, 1);
      }
      g.setAttribute('color', new T.BufferAttribute(colArr, 4));
      // 光柱轴向 = 阳光方向
      g.applyQuaternion(new T.Quaternion().setFromUnitVectors(up, ctx.sunDir));
      const by = ctx.ground.groundY(x, z);
      const dir = ctx.sunDir;
      g.translate(x + dir.x * h * 0.5, by + dir.y * h * 0.5, z + dir.z * h * 0.5);
      parts.push(g);
    }
    const geo = mergeGeoms(parts);
    const mat = new T.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.2,
      blending: T.AdditiveBlending,
      depthWrite: false,
      side: T.DoubleSide,
      fog: false,
    });
    const mesh = new T.Mesh(geo, mat);
    mesh.name = 'godrays';
    mesh.renderOrder = 6;
    mesh.frustumCulled = false;
    ctx.group.add(mesh);
    ctx.dyn.updaters.push((dt, time) => {
      mat.opacity = 0.24 + Math.sin(time * 0.9) * 0.04 + Math.sin(time * 2.7 + 1.1) * 0.025;
    });
  }

  // ============================================================
  // 15. 粒子：萤火虫 / 浮尘 / 蒲公英种子（GPU 动画 Points）
  // ============================================================
  const POINT_VERT = [
    'attribute float aSize;',
    'attribute float aPhase;',
    'attribute vec3 aParam;',
    'uniform float uTime;',
    'uniform float uPixelScale;',
    'uniform float uFlicker;',
    'varying float vAlpha;',
    'varying float vDist;',
    'void main() {',
    '  vec3 p = position;',
    '  float ph = aPhase * 6.2831853;',
    '  float sp = aParam.x;',
    '  p.x += sin(uTime * sp + ph) * aParam.y;',
    '  p.z += cos(uTime * sp * 0.83 + ph * 1.7) * aParam.y;',
    '  p.y += sin(uTime * sp * 1.27 + ph * 2.3) * aParam.y * 0.6 + aParam.z * sin(uTime * 0.23 + ph);',
    '  vec4 mv = modelViewMatrix * vec4(p, 1.0);',
    '  gl_Position = projectionMatrix * mv;',
    '  float dist = max(0.2, -mv.z);',
    '  gl_PointSize = aSize * uPixelScale / dist;',
    '  float flick = 0.3 + 0.7 * pow(0.5 + 0.5 * sin(uTime * 2.1 + ph * 4.0), 2.0);',
    '  vAlpha = mix(1.0, flick, uFlicker);',
    '  vDist = dist;',
    '}',
  ].join('\n');

  const POINT_FRAG = [
    'uniform sampler2D uMap;',
    'uniform vec3 uColor;',
    'uniform float uOpacity;',
    'varying float vAlpha;',
    'varying float vDist;',
    'void main() {',
    '  vec4 tex = texture2D(uMap, gl_PointCoord);',
    '  float fade = 1.0 - smoothstep(70.0, 110.0, vDist);',
    '  float a = tex.a * vAlpha * uOpacity * fade;',
    '  if (a < 0.004) discard;',
    '  gl_FragColor = vec4(uColor, a);',
    '  #include <tonemapping_fragment>',
    '  #include <colorspace_fragment>',
    '}',
  ].join('\n');

  function buildParticles(ctx) {
    const rnd = ctx.rnd;
    const P_TIME = { value: 0 };
    const P_PIXEL = { value: 700 };

    function makeSystem(cfg) {
      const n = cfg.count;
      const pos = new Float32Array(n * 3);
      const size = new Float32Array(n);
      const phase = new Float32Array(n);
      const param = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        let x, z, y;
        if (cfg.volume === 'air') {
          const a = rnd() * TAU;
          const rr = Math.sqrt(rnd()) * cfg.radius;
          x = Math.cos(a) * rr;
          z = Math.sin(a) * rr;
          y = ctx.ground.groundY(x, z) + cfg.yMin + rnd() * (cfg.yMax - cfg.yMin);
        } else {
          const a = rnd() * TAU;
          const rr = Math.sqrt(rnd()) * cfg.radius;
          x = Math.cos(a) * rr;
          z = Math.sin(a) * rr;
          y = ctx.ground.groundY(x, z) + cfg.yMin + rnd() * (cfg.yMax - cfg.yMin);
        }
        pos[i * 3] = x;
        pos[i * 3 + 1] = y;
        pos[i * 3 + 2] = z;
        size[i] = cfg.size[0] + rnd() * (cfg.size[1] - cfg.size[0]);
        phase[i] = rnd();
        param[i * 3] = 0.22 + rnd() * cfg.speed;
        param[i * 3 + 1] = cfg.range * (0.35 + rnd() * 0.85);
        param[i * 3 + 2] = cfg.rise * (0.3 + rnd() * 0.8);
      }
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.BufferAttribute(pos, 3));
      geo.setAttribute('aSize', new T.BufferAttribute(size, 1));
      geo.setAttribute('aPhase', new T.BufferAttribute(phase, 1));
      geo.setAttribute('aParam', new T.BufferAttribute(param, 3));
      const mat = new T.ShaderMaterial({
        uniforms: {
          uTime: P_TIME,
          uPixelScale: P_PIXEL,
          uFlicker: { value: cfg.flicker },
          uMap: { value: cfg.tex },
          uColor: { value: new T.Color(cfg.color) },
          uOpacity: { value: cfg.opacity },
        },
        vertexShader: POINT_VERT,
        fragmentShader: POINT_FRAG,
        transparent: true,
        depthWrite: false,
        blending: T.AdditiveBlending,
        depthTest: true,
      });
      const points = new T.Points(geo, mat);
      points.name = cfg.name;
      points.frustumCulled = false;
      points.renderOrder = 7;
      ctx.group.add(points);
      return points;
    }

    // 萤火虫：暖黄色、闪烁、在空地间缓缓漂浮
    makeSystem({
      name: 'fireflies',
      count: 90,
      volume: 'air',
      radius: 46,
      yMin: 0.8,
      yMax: 3.6,
      size: [0.16, 0.34],
      speed: 0.5,
      range: 1.1,
      rise: 0.35,
      flicker: 1.0,
      color: 0xffe07a,
      opacity: 0.95,
      tex: ctx.tex.glowWarm,
    });
    // 浮尘：细小的金色光点，营造丁达尔体积感
    makeSystem({
      name: 'motes',
      count: 150,
      volume: 'air',
      radius: 50,
      yMin: 0.6,
      yMax: 7.5,
      size: [0.05, 0.13],
      speed: 0.35,
      range: 0.8,
      rise: 0.5,
      flicker: 0.35,
      color: 0xfff2cf,
      opacity: 0.6,
      tex: ctx.tex.glowWarm,
    });
    // 蒲公英种子：白色绒球，缓缓上升飘荡
    makeSystem({
      name: 'seeds',
      count: 30,
      volume: 'air',
      radius: 38,
      yMin: 2.0,
      yMax: 9.0,
      size: [0.16, 0.3],
      speed: 0.18,
      range: 1.6,
      rise: 0.9,
      flicker: 0.12,
      color: 0xffffff,
      opacity: 0.8,
      tex: ctx.tex.seed,
    });

    ctx.dyn.particleTime = P_TIME;
    ctx.dyn.particlePixel = P_PIXEL;
  }

  // ============================================================
  // 16. 敌人的刷新点（均匀分布在半径 50~58 的环上，尽量落在空地）
  // ============================================================
  function makeSpawnPoints(ctx) {
    const rnd = ctx.rnd;
    const pts = [];
    const N = 14;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU + 0.31 + (rnd() - 0.5) * 0.07;
      const r = 51.5 + rnd() * 6;
      pts.push({ x: Math.cos(a) * r, z: Math.sin(a) * r });
    }
    return pts;
  }

  // ============================================================
  // 17. 组装世界
  // ============================================================
  let _built = null;
  let elapsed = 0;

  function disposeObject(root) {
    if (!root) return;
    root.traverse((o) => {
      if (o.geometry && o.geometry.dispose) o.geometry.dispose();
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of mats) {
        for (const k in m) {
          const v = m[k];
          if (v && v.isTexture) v.dispose();
        }
        if (m.dispose) m.dispose();
      }
    });
  }

  function buildWorld(scene, THREE, opts) {
    if (!scene) throw new Error('PG.world.build: 缺少 scene');
    T = THREE || window.THREE;
    if (!T) throw new Error('PG.world.build: 缺少 THREE');
    opts = opts || {};

    // 释放上一次构建（重开/热重载时避免泄漏）
    if (_built) {
      if (_built.group && _built.group.parent) _built.group.parent.remove(_built.group);
      disposeObject(_built.group);
      for (const l of _built.lights || []) {
        if (l.parent) l.parent.remove(l);
        if (l.target && l.target.parent) l.target.parent.remove(l.target);
        if (l.dispose) l.dispose();
      }
      _built = null;
    }

    const group = new T.Group();
    group.name = 'world';
    scene.add(group);

    // 场景环境
    if (!opts.skipFog) scene.fog = new T.Fog(LAYOUT.fogColor, 42, 150);
    if (scene.background == null) scene.background = new T.Color(LAYOUT.fogColor);

    const sunDir = new T.Vector3(LAYOUT.sunDir[0], LAYOUT.sunDir[1], LAYOUT.sunDir[2]).normalize();
    const rnd = mulberry32(opts.seed == null ? 20241111 : opts.seed);

    // 贴图（Canvas 程序生成）
    const tex = {
      sky: makeSkyTexture(),
      grass: makeGrassTexture(),
      glowWarm: makeGlowTexture([
        [0, 'rgba(255,255,240,1)'],
        [0.28, 'rgba(255,232,150,0.72)'],
        [0.62, 'rgba(255,214,110,0.22)'],
        [1, 'rgba(255,200,90,0)'],
      ]),
      glowWhite: makeGlowTexture([
        [0, 'rgba(255,255,255,1)'],
        [0.3, 'rgba(230,255,248,0.66)'],
        [0.65, 'rgba(200,255,240,0.2)'],
        [1, 'rgba(200,255,240,0)'],
      ]),
      seed: makeSeedTexture(),
      sun: makeSunTexture(),
      // 牌坊匾额「山海」 / 祭坛石碑「古林」
      plaque: makeInscriptionTexture('山海', { bg: '#f6ecd2', edge: '#c8432a', inner: '#e0b25a', ink: '#24313f' }),
      stele: makeInscriptionTexture('古林', { bg: '#9aa79c', edge: '#e8b33a', inner: '#c3ccb9', ink: '#26302c' }),
    };

    // 材质（标准卡通材质，明亮、无金属感）
    const mats = {
      trunk: new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }),
      canopy: withWind(
        new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 }),
        0.22,
        9.6
      ),
      grass: withWind(
        // 草用不受光的顶点色材质：完全避免草叶背面发黑，明亮卡通
        new T.MeshBasicMaterial({ vertexColors: true, side: T.DoubleSide, fog: true }),
        0.13,
        0.75
      ),
      // 花瓣很小，用不受光材质保证任何角度都明亮可爱
      petal: new T.MeshBasicMaterial({ color: 0xffffff, side: T.DoubleSide, fog: true }),
      flowerStem: new T.MeshBasicMaterial({ color: 0x4f8f35, fog: true }),
      flowerCenter: new T.MeshStandardMaterial({
        color: 0xffd23f,
        roughness: 0.7,
        metalness: 0,
        emissive: 0x4a2f00,
        emissiveIntensity: 0.55,
      }),
      mushroom: new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0 }),
      mushroomStem: new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 }),
      rock: new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, flatShading: true }),
      lily: new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.65, metalness: 0 }),
      // 朱漆 / 深色木构 / 栈桥木
      woodRed: new T.MeshStandardMaterial({ color: 0xd0432e, roughness: 0.7, metalness: 0 }),
      woodDark: new T.MeshStandardMaterial({ color: 0x5f3d2b, roughness: 0.85, metalness: 0 }),
      woodLight: new T.MeshStandardMaterial({ color: 0xb98a55, roughness: 0.85, metalness: 0 }),
      // 青石（柱础 / 台基 / 石碑 / 石鼎 / 香案 / 石阶）
      altarStone: new T.MeshStandardMaterial({ color: 0x93a49b, roughness: 0.95, metalness: 0 }),
      slab: new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }),
      // 鎏金饰件
      gold: new T.MeshStandardMaterial({ color: 0xe8b33a, roughness: 0.42, metalness: 0.3 }),
      // 青瓦屋面（两坡 / 瓦垄 / 正脊 / 垂脊）
      roofTile: new T.MeshStandardMaterial({ color: 0x4f5a56, roughness: 0.86, metalness: 0.06 }),
      // 石鼎内的香火
      censerGlow: new T.MeshStandardMaterial({
        color: 0xffc070,
        emissive: 0xff9a3c,
        emissiveIntensity: 1.8,
        roughness: 0.4,
        metalness: 0,
      }),
      // 青玉璧
      jadeGlow: new T.MeshStandardMaterial({
        color: 0x9dffe4,
        emissive: 0x3fd9b0,
        emissiveIntensity: 2.3,
        roughness: 0.22,
        metalness: 0,
      }),
    };

    const ctx = {
      T,
      scene,
      opts,
      group,
      rnd,
      tex,
      mats,
      sunDir,
      ground: null,
      dyn: { updaters: [] },
      colliders: [],
      landmarks: [],
      spawnPoints: [],
      trees: [],
      sunLight: null,
      stats: { trees: 0, grass: 1500, flowers: 0, mushrooms: 0, rocks: 0 },
    };
    ctx.ground = makeHeightField();

    // ---- 构建顺序：先算刷新点，树木摆放时避开 ----
    ctx.spawnPoints = makeSpawnPoints(ctx);

    buildSky(ctx);
    buildLights(ctx);
    buildTerrain(ctx);
    buildTrees(ctx);
    buildGrass(ctx);
    buildFlowers(ctx);
    buildMushrooms(ctx);
    buildRocks(ctx);
    buildPond(ctx);
    buildAltar(ctx);
    buildGodRays(ctx);
    buildParticles(ctx);

    ctx.landmarks = [
      { x: LAYOUT.altar.x, z: LAYOUT.altar.z, type: 'altar' },
      { x: LAYOUT.pond.x, z: LAYOUT.pond.z, type: 'pond' },
      { x: LAYOUT.ring.x, z: LAYOUT.ring.z, type: 'ring' },
      { x: LAYOUT.rocks.x, z: LAYOUT.rocks.z, type: 'rock' },
      { x: LAYOUT.rocks2.x, z: LAYOUT.rocks2.z, type: 'rock' },
    ];
    ctx.stats.trees = ctx.trees.length;
    ctx.stats.colliders = ctx.colliders.length;
    ctx.stats.trunkColliders = ctx.trees.filter((t) => !t.outer).length;
    ctx.treesInfo = ctx.trees.map((t) => ({ x: t.x, z: t.z, s: t.s, outer: !!t.outer }));
    ctx.stats.spawnPoints = ctx.spawnPoints.length;

    // ---- 每帧更新 ----
    let updaters = ctx.dyn.updaters;
    const pixelScaleTarget = ctx.dyn.particlePixel;

    function update(dt, t, camera) {
      dt = Math.min(dt == null ? 0.016 : dt, 0.1);
      let time;
      if (t == null) {
        elapsed += dt;
        time = elapsed;
      } else {
        time = t;
        elapsed = t;
      }
      // 风（树冠 / 草的顶点着色器共用这个 uniform）
      windUniform.value = time;
      if (ctx.waterUniform) {
        ctx.waterUniform.uTime.value = time;
        if (camera && camera.position) ctx.waterUniform.uCamPos.value.copy(camera.position);
      }
      // 粒子点尺寸随相机 fov 缩放（Points 走世界单位直径）
      if (camera && camera.fov && pixelScaleTarget) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const hPx = (window.innerHeight || 800) * dpr;
        pixelScaleTarget.value = hPx / (2 * Math.tan((camera.fov * Math.PI) / 360));
      }
      if (ctx.dyn.particleTime) ctx.dyn.particleTime.value = time;
      for (let i = 0; i < updaters.length; i++) updaters[i](dt, time, camera);
    }

    function reset() {
      elapsed = 0;
      windUniform.value = 0;
      if (ctx.waterUniform) ctx.waterUniform.uTime.value = 0;
      if (ctx.dyn.particleTime) ctx.dyn.particleTime.value = 0;
      const al = ctx.dyn.altar;
      if (al) {
        al.biGroup.position.y = 2.25;
        al.biGroup.rotation.z = 0;
      }
    }

    const world = {
      group,
      radius: LAYOUT.radius,
      colliders: ctx.colliders,
      spawnPoints: ctx.spawnPoints,
      landmarks: ctx.landmarks,
      sunDir: sunDir.clone(),
      groundY: (x, z) => ctx.ground.groundY(x, z),
      update,
      reset,
      // —— 扩展字段（主循环 / UI 可选用）——
      ambient: {
        sky: new T.Color(0xdaf1ff),
        ground: new T.Color(0x6faa52),
        sun: new T.Color(0xfff2cc),
        sunIntensity: 2.35,
        skyTop: new T.Color(LAYOUT.skyTop),
        fog: new T.Color(LAYOUT.fogColor),
        sunDir: sunDir.clone(),
      },
      fog: scene.fog,
      layout: LAYOUT,
      stats: ctx.stats,
      sunLight: ctx.sunLight,
      lights: ctx.sunLight ? [ctx.sunLight] : [],
      pondWaterY: ctx.ground.pondWaterY,
      waterUniform: ctx.waterUniform,
      // 供 QA / 调试：树木与地标数据
      trees: ctx.treesInfo,
      colliderCount: ctx.colliders.length,
      // 调试用
      _meshes: {},
    };

    _built = { group, lights: ctx.sunLight ? [ctx.sunLight] : [], world };
    PG.world._last = world;
    return world;
  }

  // ============================================================
  // 18. 导出
  // ============================================================
  PG.world = { build: buildWorld };
})();
/* ==================== 30-models.js ==================== */
/* ============================================================================
 * 30-models.js — PG.models
 * 山海 · 森之突袭 — 程序化 3D 模型库（负责：队友 models）
 * ----------------------------------------------------------------------------
 * 设计要点：
 *  1) 全库由 Three.js 基本几何体拼装（球 / 胶囊 / 锥 / 圆柱 / 环 / 挤出），
 *     无任何外部贴图，离线可用；题材为中国神话（山海秘境 · 上古异兽）。
 *  2) 压低 draw call：每个"动画节点"（root / head / tail / wing ...）内部的
 *     同类材质零件，在建完模后合并为一个带顶点色的 BufferGeometry。
 *     单只模型通常 3~6 个 draw call；全库共用材质。
 *  3) 模板只构建一次，make() 通过 group.clone(true) 复制（几何与材质共享 GPU
 *     资源），刷怪不会产生几何垃圾。
 *  4) 美术规范：脚底 y = 0，正面朝 -Z；update(dt, t) 处理呼吸 / 耳朵 / 尾巴 /
 *     翅膀 / 飘浮等细微动画。行者站立，右手前举，暴露 handAnchor 供挂法器。
 *  5) 分工：本文件负责 18 只异兽资料表、4 只灵兽与 4 位行者的模型、拼装 DSL、
 *     注册口与 PG.models API；14 只妖物由 32-beasts.js 通过 PG.models._dsl
 *     构建并 registerBuilders 注入；2D 图标与行者头像由 35-art.js 挂到
 *     PG.models.art，本文件只保留 icon / portrait 薄封装。
 * ==========================================================================*/

(() => {
  "use strict";

// ===========================================================================
// 0. 常量、数据表
// ===========================================================================
const TAU = Math.PI * 2;
const PI = Math.PI;
const PG = (window.PG = window.PG || {});
const T3 = window.THREE || null;   // 构建顺序保证 three.min.js 已先加载

// 异兽顺序（18 只，见 MYTHOLOGY 第 3 节）：4 灵兽在前，其余为妖物
const CREATURE_IDS = [
  'kui', 'qilin', 'bifang', 'xuanwu',
  'lushu', 'wugong', 'zhen', 'mumei',
  'xuanfeng', 'zheng', 'jiuwei', 'jiaoren',
  'chimei', 'wangliang', 'chiru', 'taotie', 'bashe', 'hundun',
];
const TRAINER_IDS = ['t_bolt', 't_leaf', 't_ember', 't_tide'];

// cn 中文名 | en 英文名 | type 属性键（拼音）| kind starter/enemy/elite/boss
// h 目标总高度（米）| r 碰撞半径参考值
const DATA = {
  kui:       { cn: '夔牛',   en: 'KUI',       type: 'lei',  kind: 'starter', h: 0.86, r: 0.30 },
  qilin:     { cn: '麒麟',   en: 'QILIN',     type: 'mu',   kind: 'starter', h: 1.00, r: 0.46 },
  bifang:    { cn: '毕方',   en: 'BIFANG',    type: 'huo',  kind: 'starter', h: 1.05, r: 0.36 },
  xuanwu:    { cn: '玄武',   en: 'XUANWU',    type: 'shui', kind: 'starter', h: 0.95, r: 0.36 },
  lushu:     { cn: '鹿蜀',   en: 'LUSHU',     type: 'shou', kind: 'enemy',   h: 0.66, r: 0.32 },
  wugong:    { cn: '蜈蚣精', en: 'WUGONG',    type: 'du',   kind: 'enemy',   h: 0.66, r: 0.30 },
  zhen:      { cn: '鸩鸟',   en: 'ZHEN',      type: 'du',   kind: 'enemy',   h: 0.62, r: 0.30 },
  mumei:     { cn: '木魅',   en: 'MUMEI',     type: 'mu',   kind: 'enemy',   h: 0.62, r: 0.30 },
  xuanfeng:  { cn: '玄蜂',   en: 'XUANFENG',  type: 'du',   kind: 'enemy',   h: 1.15, r: 0.45 },
  zheng:     { cn: '狰',     en: 'ZHENG',     type: 'shou', kind: 'enemy',   h: 1.35, r: 0.42 },
  jiuwei:    { cn: '九尾狐', en: 'JIUWEI',    type: 'yao',  kind: 'enemy',   h: 0.92, r: 0.34 },
  jiaoren:   { cn: '鲛人',   en: 'JIAOREN',   type: 'shui', kind: 'enemy',   h: 0.60, r: 0.28 },
  chimei:    { cn: '魑魅',   en: 'CHIMEI',    type: 'gui',  kind: 'enemy',   h: 0.85, r: 0.40 },
  wangliang: { cn: '魍魉',   en: 'WANGLIANG', type: 'gui',  kind: 'enemy',   h: 1.45, r: 0.50 },
  chiru:     { cn: '赤鱬',   en: 'CHIRU',     type: 'shui', kind: 'enemy',   h: 0.86, r: 0.34 },
  taotie:    { cn: '饕餮',   en: 'TAOTIE',    type: 'shou', kind: 'elite',   h: 2.20, r: 0.82 },
  bashe:     { cn: '巴蛇',   en: 'BASHE',     type: 'shou', kind: 'elite',   h: 1.75, r: 0.55 },
  hundun:    { cn: '混沌',   en: 'HUNDUN',    type: 'ling', kind: 'boss',    h: 1.90, r: 0.42 },
};

const TRAINER_DATA = {
  t_bolt:  { cn: '雷公', en: 'LEIGONG',  type: 'lei'  },
  t_leaf:  { cn: '句芒', en: 'GOUMANG',  type: 'mu'   },
  t_ember: { cn: '祝融', en: 'ZHURONG',  type: 'huo'  },
  t_tide:  { cn: '玄冥', en: 'XUANMING', type: 'shui' },
};

// 属性主色 / 暗色 / 中文（十一类，与 MYTHOLOGY 第 4 节逐字一致）
const TYPE_COLORS = {
  lei: '#ffd93d', mu: '#7ec850', huo: '#ff8a3d', shui: '#6fc3ff', feng: '#a9c0ea',
  du: '#b57ad8', yan: '#b3a68f', shou: '#d9c9a8', ling: '#7ad0c8', gui: '#8a6ac8', yao: '#f08bb4',
};
const TYPE_DARK = {
  lei: '#b58a00', mu: '#3f7a2c', huo: '#c2451a', shui: '#1f6fb2', feng: '#4a5f96',
  du: '#6a3a8f', yan: '#6b6152', shou: '#8a7650', ling: '#2f7f74', gui: '#4c3580', yao: '#a83f6a',
};
const TYPE_CN = {
  lei: '雷', mu: '木', huo: '火', shui: '水', feng: '风',
  du: '毒', yan: '岩', shou: '兽', ling: '灵', gui: '鬼', yao: '妖',
};

function infoOf(id) {
  const d = DATA[id];
  if (d) return { id: id, cn: d.cn, en: d.en, type: d.type, scale: 1, kind: d.kind, h: d.h, r: d.r };
  const t = TRAINER_DATA[id];
  if (t) return { id: id, cn: t.cn, en: t.en, type: t.type, scale: 1, kind: 'trainer', h: 1.8, r: 0.40 };
  return null;
}

// ===========================================================================
// 1. 材质 / 几何缓存（全库共用，保证同色同材质只创建一次）
// ===========================================================================
const MAT_CACHE = new Map();

// spec: { kind:'body'|'shine'|'rock'|'glass'|'glow', key, opacity?, c?, intensity? }
function matOf(spec) {
  let m = MAT_CACHE.get(spec.key);
  if (m) return m;
  if (!T3) throw new Error('PG.models: THREE 未加载');
  if (spec.kind === 'glow') {
    m = new T3.MeshStandardMaterial({
      color: spec.c, emissive: spec.c, emissiveIntensity: spec.intensity || 1.5,
      roughness: 0.45, metalness: 0.0,
    });
  } else if (spec.kind === 'glass') {
    m = new T3.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, transparent: true, opacity: spec.opacity,
      roughness: 0.22, metalness: 0.06, depthWrite: false,
    });
  } else if (spec.kind === 'shine') {
    m = new T3.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.22, metalness: 0.0,
    });
  } else if (spec.kind === 'rock') {
    m = new T3.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.9, metalness: 0.03, flatShading: true,
    });
  } else {
    m = new T3.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.56, metalness: 0.02,
    });
  }
  m.name = 'pg_' + spec.key;
  MAT_CACHE.set(spec.key, m);
  return m;
}

const GEO_CACHE = new Map();
function cachedGeo(key, factory) {
  let g = GEO_CACHE.get(key);
  if (!g) { g = factory(); GEO_CACHE.set(key, g); }
  return g;
}
const f3 = (n) => Math.round(n * 1000) / 1000;

// 单位球（缩放通过矩阵完成，保证缓存复用）
const SPH = () => cachedGeo('sph', () => new T3.SphereGeometry(1, 14, 10));
const SPH_HI = () => cachedGeo('sphHi', () => new T3.SphereGeometry(1, 18, 12));
const CONE = () => cachedGeo('cone', () => new T3.ConeGeometry(1, 1, 14));
const CYL = () => cachedGeo('cyl', () => new T3.CylinderGeometry(1, 1, 1, 14));
const BOX = () => cachedGeo('box', () => new T3.BoxGeometry(1, 1, 1));
const HEMI = () => cachedGeo('hemi', () => new T3.SphereGeometry(1, 16, 8, 0, TAU, 0, PI / 2));
const TORUS = (R, tube, arc) => cachedGeo('t' + f3(R) + '_' + f3(tube) + '_' + f3(arc),
  () => new T3.TorusGeometry(R, tube, 6, 22, arc));
const CAPSULE = (r, len) => cachedGeo('c' + f3(r) + '_' + f3(len),
  () => new T3.CapsuleGeometry(r, len, 3, 10));
const ICO = (r, detail) => cachedGeo('i' + f3(r) + '_' + detail, () => new T3.IcosahedronGeometry(r, detail));

// 叶子 / 闪电 / 螳螂镰刀：用挤出几何获得漂亮轮廓（低段数，不增加多少面）
function leafGeo(w, h, depth) {
  return cachedGeo('leaf' + f3(w) + '_' + f3(h) + '_' + f3(depth), () => {
    const s = new T3.Shape();
    s.moveTo(0, 0);
    s.bezierCurveTo(w * 0.55, h * 0.22, w * 0.62, h * 0.68, 0, h);
    s.bezierCurveTo(-w * 0.62, h * 0.68, -w * 0.55, h * 0.22, 0, 0);
    return new T3.ExtrudeGeometry(s, {
      depth: depth, bevelEnabled: true, bevelThickness: depth * 0.35,
      bevelSize: depth * 0.35, bevelSegments: 1, steps: 1, curveSegments: 6,
    });
  });
}

// 闪电轮廓（灵兽紫电 / 妖物电弧通用）（XY 平面内，沿 +Y 生长，挤出厚度 depth）
function boltGeo(scale, depth) {
  return cachedGeo('bolt' + f3(scale) + '_' + f3(depth), () => {
    const pts = [
      [0.00, 0.00], [0.36, 0.00], [0.62, 0.34], [0.28, 0.40],
      [0.72, 0.70], [0.36, 0.76], [0.92, 1.10],
      [-0.10, 0.62], [0.18, 0.57], [-0.22, 0.26], [0.02, 0.22], [-0.30, 0.06],
    ];
    const s = new T3.Shape();
    s.moveTo(pts[0][0] * scale, pts[0][1] * scale);
    for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0] * scale, pts[i][1] * scale);
    s.closePath();
    return new T3.ExtrudeGeometry(s, {
      depth: depth, bevelEnabled: true, bevelThickness: depth * 0.4,
      bevelSize: depth * 0.4, bevelSegments: 1, steps: 1, curveSegments: 4,
    });
  });
}

// 弯钩刃（带钩的弯刀，XY 平面，+Y 为刀尖方向）
function scytheGeo(w, h, depth) {
  return cachedGeo('scy' + f3(w) + '_' + f3(h) + '_' + f3(depth), () => {
    const s = new T3.Shape();
    s.moveTo(0, 0);
    s.bezierCurveTo(w * 0.62, h * 0.06, w * 0.95, h * 0.42, w * 0.78, h * 0.80);
    s.bezierCurveTo(w * 0.60, h * 0.56, w * 0.34, h * 0.34, 0, h * 0.20);
    s.lineTo(0, 0);
    return new T3.ExtrudeGeometry(s, {
      depth: depth, bevelEnabled: true, bevelThickness: depth * 0.4,
      bevelSize: depth * 0.4, bevelSegments: 1, steps: 1, curveSegments: 8,
    });
  });
}

// ===========================================================================
// 2. 顶点色合并拼装器（核心：把同节点同材质零件合并成一个 Mesh）
// ===========================================================================
const COLOR_CACHE = new Map();
function colorOf(hex) {
  let c = COLOR_CACHE.get(hex);
  if (!c) { c = new T3.Color(hex); COLOR_CACHE.set(hex, c); }
  return c;
}

let IDENTITY_Q = null;
function matrixOf(o) {
  if (!IDENTITY_Q) IDENTITY_Q = new T3.Quaternion();
  const p = new T3.Vector3(o.x || 0, o.y || 0, o.z || 0);
  let q = IDENTITY_Q;
  if (o.q) q = o.q;
  else if (o.rx || o.ry || o.rz) q = new T3.Quaternion().setFromEuler(new T3.Euler(o.rx || 0, o.ry || 0, o.rz || 0));
  const s = new T3.Vector3(o.sx == null ? 1 : o.sx, o.sy == null ? 1 : o.sy, o.sz == null ? 1 : o.sz);
  const m = new T3.Matrix4();
  m.compose(p, q, s);
  return m;
}

function specOf(o) {
  if (o.glow != null) {
    const inten = o.glowInt == null ? 1.5 : o.glowInt;
    return { kind: 'glow', key: 'g' + (o.glow >>> 0) + '_' + inten, c: o.glow, intensity: inten };
  }
  if (o.glass != null) {
    const op = Math.round((o.glass === true ? 0.5 : o.glass) * 100) / 100;
    return { kind: 'glass', key: 'gl' + op, opacity: op };
  }
  if (o.rock) return { kind: 'rock', key: 'rock' };
  if (o.shine) return { kind: 'shine', key: 'shine' };
  return { kind: 'body', key: 'body' };
}

// 把若干 {geo, color, m} 合并成一个带顶点色的 BufferGeometry
function mergeParts(parts, withColor) {
  const n = parts.length;
  let total = 0;
  const prep = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = parts[i];
    const src = p.geo;
    const g = src.index ? src.toNonIndexed() : src.clone();
    if (p.m) g.applyMatrix4(p.m);
    prep[i] = g;
    total += g.attributes.position.count;
  }
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  const col = withColor ? new Float32Array(total * 3) : null;
  let off = 0;
  for (let i = 0; i < n; i++) {
    const g = prep[i];
    const cnt = g.attributes.position.count;
    pos.set(g.attributes.position.array, off * 3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array, off * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, off * 2);
    if (col) {
      const c = parts[i].color;
      for (let v = 0; v < cnt; v++) {
        const bi = (off + v) * 3;
        col[bi] = c.r; col[bi + 1] = c.g; col[bi + 2] = c.b;
      }
    }
    off += cnt;
  }
  const geo = new T3.BufferGeometry();
  geo.setAttribute('position', new T3.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new T3.BufferAttribute(nor, 3));
  geo.setAttribute('uv', new T3.BufferAttribute(uv, 2));
  if (col) geo.setAttribute('color', new T3.BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

// 网格拼装器：node() 建动画节点，put() 塞零件，bake() 合并成极少 draw call
function Builder() {
  const root = new T3.Group();
  root.name = 'root';
  const nodeMap = { root: root };
  const buckets = { root: new Map() };

  const api = {
    root: root,
    // 新建动画节点（作为 parent 的子级）
    node: function (name, parentName, x, y, z) {
      const g = new T3.Group();
      g.name = name;
      g.position.set(x || 0, y || 0, z || 0);
      (nodeMap[parentName] || root).add(g);
      nodeMap[name] = g;
      buckets[name] = new Map();
      return g;
    },
    // 往节点里加一个零件：geo 几何、color 颜色、o 变换与材质选项
    put: function (nodeName, geo, color, o) {
      const opt = o || {};
      const spec = specOf(opt);
      let map = buckets[nodeName];
      if (!map) { map = new Map(); buckets[nodeName] = map; }
      let b = map.get(spec.key);
      if (!b) { b = { spec: spec, parts: [] }; map.set(spec.key, b); }
      b.parts.push({ geo: geo, color: colorOf(color), m: matrixOf(opt) });
    },
    // 合并每个节点的所有零件，生成最终 Mesh
    bake: function () {
      Object.keys(buckets).forEach(function (name) {
        const g = nodeMap[name];
        const map = buckets[name];
        if (!g || !map) return;
        map.forEach(function (b) {
          const spec = b.spec;
          const mat = matOf(spec);
          const geo = mergeParts(b.parts, spec.kind !== 'glow');
          const mesh = new T3.Mesh(geo, mat);
          mesh.name = 'mesh_' + name + '_' + spec.kind;
          mesh.castShadow = (spec.kind === 'body' || spec.kind === 'rock' || spec.kind === 'shine');
          mesh.receiveShadow = false;
          if (spec.kind === 'glass') mesh.renderOrder = 2;
          mesh.matrixAutoUpdate = false;
          mesh.updateMatrix();
          g.add(mesh);
        });
        buckets[name] = null;
      });
    },
  };
  return api;
}

// 常用朝向工具：把 +Y 单位向量转到 dir
function quatY(dir) {
  return new T3.Quaternion().setFromUnitVectors(new T3.Vector3(0, 1, 0), dir.clone().normalize());
}

// 胶囊链（尾巴 / 长颈 / 行者四肢）：pts = [[x,y,z], ...]
function capChain(B, nodeName, pts, radii, color, o) {
  const opt = o || {};
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) continue;
    const r = radii[i - 1] == null ? radii[radii.length - 1] : radii[i - 1];
    B.put(nodeName, CAPSULE(r, Math.max(0.001, len - r * 0.5)), color, {
      x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, z: (a[2] + b[2]) / 2,
      q: quatY(new T3.Vector3(dx, dy, dz)),
      shine: opt.shine, rock: opt.rock, glass: opt.glass, glow: opt.glow, glowInt: opt.glowInt,
    });
  }
}

// ===========================================================================
// 3. 通用零件（眼睛 / 嘴 / 牙 / 腮红 / 爪子）
// ===========================================================================

// 眼睛：side = -1 左 / +1 右（视觉上的左右）
// style: 'simple' 黑豆眼 | 'oval' 竖椭圆 | 'full' 眼白+虹膜+瞳孔+高光
function addEye(B, node, side, o) {
  const st = o.style || 'simple';
  const r = o.r || 0.045;
  const spread = o.spread == null ? 0.09 : o.spread;
  const x = (o.x || 0) + side * spread;
  const y = o.y || 0;
  const z = o.z == null ? -0.18 : o.z;
  const wz = o.wz == null ? 0.6 : o.wz;
  const sy = o.sy == null ? 1.05 : o.sy;
  const tilt = (o.tilt || 0) * side;
  const look = o.look || 0;
  if (st === 'full') {
    // 眼白
    B.put(node, SPH(), o.white == null ? 0xffffff : o.white,
      { x: x, y: y, z: z, sx: r, sy: r * sy, sz: r * wz, rz: tilt, shine: true });
    // 虹膜
    B.put(node, SPH(), o.iris == null ? 0x2f6fa8 : o.iris,
      { x: x + look * r * 0.12, y: y - r * 0.06, z: z - r * wz * 0.50, sx: r * 0.64, sy: r * 0.64, sz: r * 0.34, shine: true });
    // 瞳孔
    B.put(node, SPH(), o.pupil == null ? 0x1d2430 : o.pupil,
      { x: x + look * r * 0.16, y: y - r * 0.04, z: z - r * wz * 0.70, sx: r * 0.33, sy: r * 0.35, sz: r * 0.20, shine: true });
  } else if (st === 'oval') {
    B.put(node, SPH(), o.pupil == null ? 0x232733 : o.pupil,
      { x: x, y: y, z: z, sx: r * 0.82, sy: r * 1.15, sz: r * wz, rz: tilt, shine: true });
  } else {
    B.put(node, SPH(), o.pupil == null ? 0x232733 : o.pupil,
      { x: x, y: y, z: z, sx: r, sy: r * sy, sz: r * wz, rz: tilt, shine: true });
  }
  // 高光（左上方的小白点，卡通眼必备）
  if (o.hi !== false) {
    const hr = r * (o.hiR || 0.30);
    B.put(node, SPH(), 0xffffff,
      { x: x - r * 0.26, y: y + r * 0.32, z: z - r * wz * 1.02, sx: hr, sy: hr, sz: hr * 0.6, shine: true });
  }
}
function addEyes(B, node, o) {
  addEye(B, node, -1, o);
  addEye(B, node, 1, o);
}

// 微笑弧线（U 形）：由半环旋转而成，贴合脸部
function addSmile(B, node, o) {
  const w = o.w == null ? 0.05 : o.w;
  const tube = o.tube == null ? w * 0.17 : o.tube;
  B.put(node, TORUS(w, tube, PI), o.color == null ? 0x3a2b30 : o.color,
    { x: o.x || 0, y: o.y || 0, z: o.z == null ? -0.2 : o.z, rz: PI, sz: 0.4, shine: !!o.shine });
}

// 张开的嘴（深色椭圆，可选舌头）
function addOpenMouth(B, node, o) {
  const w = o.w == null ? 0.06 : o.w;
  const h = o.h == null ? w * 0.9 : o.h;
  B.put(node, SPH(), o.color == null ? 0x2a1f28 : o.color,
    { x: o.x || 0, y: o.y || 0, z: o.z == null ? -0.2 : o.z, sx: w, sy: h, sz: w * 0.22, shine: !!o.shine });
  if (o.tongue != null) {
    B.put(node, SPH(), o.tongue,
      { x: o.x || 0, y: (o.y || 0) - h * 0.42, z: (o.z == null ? -0.2 : o.z) - w * 0.13, sx: w * 0.5, sy: h * 0.34, sz: w * 0.13, shine: true });
  }
}

// 下獠牙（锥体朝上，白色）
function addFangs(B, node, o) {
  const n = o.n || 2;
  const gap = o.gap || 0.05;
  for (let i = 0; i < n; i++) {
    const x = (o.x || 0) + (i - (n - 1) / 2) * gap;
    B.put(node, CONE(), o.color == null ? 0xfffdf2 : o.color, {
      x: x, y: o.y || 0, z: o.z == null ? -0.21 : o.z,
      sx: o.w || 0.013, sy: o.h || 0.032, sz: (o.w || 0.013) * 0.8, shine: true,
    });
  }
}

// 一排牙齿（方糖状，用于妖物的咧嘴大笑）
function addTeethRow(B, node, o) {
  const n = o.n || 5;
  const w = o.w || 0.02;
  const gap = o.gap || w * 1.12;
  for (let i = 0; i < n; i++) {
    const x = (o.x || 0) + (i - (n - 1) / 2) * gap;
    B.put(node, BOX(), o.color == null ? 0xfffdf2 : o.color, {
      x: x, y: o.y || 0, z: o.z == null ? -0.2 : o.z,
      sx: w, sy: o.h || w * 1.3, sz: w * 0.7, rz: o.rz || 0, shine: true,
    });
  }
}

// 圆腮红（灵兽的腮红）
function addCheeks(B, node, o) {
  const r = o.r || 0.06;
  for (let s = -1; s <= 1; s += 2) {
    B.put(node, SPH(), o.color == null ? 0xe8453c : o.color, {
      x: (o.x || 0) + s * (o.spread || 0.16), y: o.y || 0,
      z: o.z == null ? -0.16 : o.z, sx: r, sy: r * 0.9, sz: r * 0.35,
    });
  }
}

// 朝 -Z 的三根白爪（手 / 脚通用）
function addClaws(B, node, o) {
  const n = o.n || 3;
  const spread = o.spread || 0.018;
  for (let i = 0; i < n; i++) {
    const a = (i - (n - 1) / 2) * spread;
    B.put(node, CONE(), o.color == null ? 0xfff6e0 : o.color, {
      x: (o.x || 0) + a, y: o.y || 0, z: o.z || 0,
      sx: o.r || 0.013, sy: o.len || 0.034, sz: (o.r || 0.013) * 0.8,
      rx: o.rx == null ? -PI / 2 : o.rx, shine: true,
    });
  }
}

// 一只小脚：主脚掌 + 可选脚趾
function addFoot(B, node, x, y, z, sx, sy, sz, color, toeColor) {
  B.put(node, SPH(), color, { x: x, y: y, z: z, sx: sx, sy: sy, sz: sz });
  if (toeColor != null) addClaws(B, node, { x: x, y: y, z: z - sz * 0.75, r: sx * 0.16, len: sz * 0.30, spread: sx * 0.32, color: toeColor });
}

// 模型收尾：合并网格 + 自动测量包围盒（保证 height/radius 与视觉一致）
// opt: { scale: 统一缩放, y: 整体上/下平移, fitH: 自动缩放到达标高度 }
//（fitH 缩放落在根节点上，避免被动画循环里对 inner 的呼吸缩放覆盖）
function finishModel(B, anim, opt) {
  B.bake();
  const o = opt || {};
  // 统一套一层 inner 组，用于整体缩放 / 降地（保证脚底精确落在 y=0）
  const inner = new T3.Group();
  inner.name = 'inner';
  const kids = B.root.children.slice();
  for (let i = 0; i < kids.length; i++) inner.add(kids[i]);
  inner.position.y = o.y || 0;
  if (o.scale) inner.scale.setScalar(o.scale);
  B.root.add(inner);
  if (o.autoGround !== false) {
    const b0 = new T3.Box3().setFromObject(B.root);
    // 整体降地：保证脚底精确落在 y=0（悬空/入地一律修正）
    if (Math.abs(b0.min.y) > 0.0015) inner.position.y -= b0.min.y;
  }
  // fitH：按目标高度自动缩放
  //   fitInner=true 时缩放落在 inner 上，外层 root 保持 1 倍：
  //   - 灵兽会被 50-game 以 model.height 重新设 root.scale，若缩放放在 root 会被覆盖，
  //     放在 inner 才能保证视觉高度始终等于返回值；
  //   - 行者只放展示台，缩放落在 root 上即可。
  if (o.fitH) {
    const b1 = new T3.Box3().setFromObject(B.root);
    const h1 = b1.max.y - Math.min(0, b1.min.y);
    if (h1 > 1e-4) {
      const k = o.fitH / h1;
      if (o.fitInner) inner.scale.setScalar(inner.scale.x * k);
      else B.root.scale.setScalar(k);
      B.root.updateMatrixWorld(true);
      if (o.fitInner) {
        const b2 = new T3.Box3().setFromObject(B.root);
        if (Math.abs(b2.min.y) > 1e-4) inner.position.y -= b2.min.y;
      }
    }
  }
  const box = new T3.Box3().setFromObject(B.root);
  const minY = Math.min(0, box.min.y);
  const height = box.max.y - minY;
  const radius = Math.max(box.max.x, -box.min.x, box.max.z, -box.min.z);
  return { group: B.root, height: height, radius: radius, anim: anim };
}

// ===========================================================================
// 4. 灵兽模型（四只，跟随行者出战）
// ===========================================================================

// —— 夔牛 KUI（lei）：单足雷牛，苍青牛身、紫电缠身、雷纹背 ——
function buildKui() {
  const B = Builder();
  const BODY = 0x6b7fa8, BODY_D = 0x51638c, BELLY = 0x9aaacb, HOOF = 0x39425a;
  const PUR = 0xb06bff, EYE = 0xffd93d, NOSE = 0x2f3a4e;

  // 牛身 + 腹部 + 单足（山海经：状如牛，苍身无角，一足）
  B.put('root', SPH(), BODY, { y: 0.50, sx: 0.215, sy: 0.235, sz: 0.285 });
  B.put('root', SPH(), BELLY, { y: 0.395, z: -0.01, sx: 0.175, sy: 0.155, sz: 0.248 });
  B.put('root', SPH(), BODY_D, { y: 0.665, z: -0.12, sx: 0.14, sy: 0.075, sz: 0.16 });   // 牛肩峰
  B.put('root', SPH(), BODY_D, { y: 0.40, z: 0.0, sx: 0.115, sy: 0.14, sz: 0.135 });
  B.put('root', CAPSULE(0.072, 0.24), BODY_D, { y: 0.25, z: 0.0 });
  B.put('root', CYL(), HOOF, { y: 0.10, z: 0.0, sx: 0.095, sy: 0.16, sz: 0.10 });
  B.put('root', SPH(), HOOF, { y: 0.026, z: -0.02, sx: 0.105, sy: 0.032, sz: 0.125 });

  // 尾巴（动画节点）
  const tail = B.node('tail', 'root', 0, 0.55, 0.22);
  capChain(B, 'tail', [[0, 0, 0], [0.015, 0.02, 0.08], [0.03, -0.03, 0.15], [0.03, 0.05, 0.19]], [0.048, 0.036, 0.026, 0.015], BODY_D);
  B.put('tail', CONE(), PUR, { x: 0.03, y: 0.10, z: 0.185, sx: 0.032, sy: 0.10, sz: 0.032, rx: -0.55, glow: PUR, glowInt: 1.6 });

  // 牛首（无角）
  B.node('head', 'root', 0, 0.615, -0.225);
  B.put('head', SPH_HI(), BODY, { y: 0.02, sx: 0.185, sy: 0.175, sz: 0.185 });
  B.put('head', SPH(), BELLY, { y: -0.045, z: -0.135, sx: 0.125, sy: 0.10, sz: 0.115 });
  B.put('head', SPH(), NOSE, { x: 0.045, y: -0.05, z: -0.238, sx: 0.020, sy: 0.014, sz: 0.010 });
  B.put('head', SPH(), NOSE, { x: -0.045, y: -0.05, z: -0.238, sx: 0.020, sy: 0.014, sz: 0.010 });
  addSmile(B, 'head', { y: -0.075, z: -0.222, w: 0.055, tube: 0.010, color: 0x3d4a66 });
  addEyes(B, 'head', { y: 0.035, z: -0.155, spread: 0.088, r: 0.046, style: 'full', iris: EYE, pupil: 0x2a2f44, wz: 0.55 });
  // 牛耳（无角，改为一对叶耳）
  B.put('head', leafGeo(0.05, 0.11, 0.018), BODY_D, { x: 0.165, y: 0.10, z: 0.01, rz: -1.05, rx: -0.35 });
  B.put('head', leafGeo(0.05, 0.11, 0.018), BODY_D, { x: -0.165, y: 0.10, z: 0.01, rz: 1.05, rx: -0.35 });
  // 额头雷纹
  B.put('head', boltGeo(0.085, 0.012), PUR, { x: -0.02, y: 0.10, z: -0.205, glow: PUR, glowInt: 1.9 });

  // 背脊雷纹 + 缠身紫电（动画节点：呼吸式明灭 / 抖动）
  const spark = B.node('spark', 'root', 0, 0, 0);
  B.put('spark', boltGeo(0.17, 0.018), PUR, { x: -0.13, y: 0.70, z: 0.02, rx: -PI / 2, ry: 0.28, glow: PUR, glowInt: 1.8 });
  B.put('spark', boltGeo(0.17, 0.018), PUR, { x: 0.12, y: 0.71, z: 0.10, rx: -PI / 2, ry: -0.42, glow: PUR, glowInt: 1.8 });
  B.put('spark', TORUS(0.20, 0.016, PI * 1.15), PUR, { y: 0.55, z: 0.02, rx: PI / 2, ry: 0.20, glow: PUR, glowInt: 1.5 });
  B.put('spark', SPH(), PUR, { x: 0.215, y: 0.42, z: 0.10, sx: 0.022, sy: 0.022, sz: 0.022, glow: PUR, glowInt: 2.2 });
  B.put('spark', SPH(), PUR, { x: -0.20, y: 0.60, z: -0.10, sx: 0.017, sy: 0.017, sz: 0.017, glow: PUR, glowInt: 2.2 });

  return finishModel(B, function (nodes, dt, t) {
    nodes.head.rotation.x = Math.sin(t * 1.2) * 0.06;
    nodes.head.rotation.z = Math.sin(t * 0.7) * 0.04;
    nodes.tail.rotation.z = Math.sin(t * 1.8) * 0.14;
    nodes.tail.rotation.x = Math.sin(t * 1.2 + 0.6) * 0.10;
    const sp = 0.94 + Math.sin(t * 6.5) * 0.06;
    nodes.spark.scale.set(sp, sp, sp);
    nodes.spark.rotation.y = Math.sin(t * 0.9) * 0.08;
  }, { fitH: 0.86, fitInner: true });
}

// —— 麒麟 QILIN（mu）：四足瑞兽，鳞身、鹿角、金鬃、灵芝尾 ——
function buildQilin() {
  const B = Builder();
  const JADE = 0x4fb99f, JADE_D = 0x3a8f7c, JADE_L = 0x9fe6cf;
  const GOLD = 0xe8b33a, CREAM = 0xf6f2da, HOOF = 0x2c5a4e, EYE = 0xffd93d;

  // 四足（瑞兽短腿 + 金蹄）
  [[0.155, -0.19], [-0.155, -0.19], [0.155, 0.21], [-0.155, 0.21]].forEach(function (p) {
    B.put('root', SPH(), JADE_D, { x: p[0], y: 0.42, z: p[1], sx: 0.085, sy: 0.12, sz: 0.10 });
    B.put('root', CAPSULE(0.062, 0.24), JADE_D, { x: p[0], y: 0.25, z: p[1] });
    B.put('root', SPH(), JADE, { x: p[0], y: 0.12, z: p[1], sx: 0.072, sy: 0.085, sz: 0.078 });
    B.put('root', CYL(), GOLD, { x: p[0], y: 0.05, z: p[1] - 0.01, sx: 0.066, sy: 0.09, sz: 0.068, shine: true });
    B.put('root', SPH(), HOOF, { x: p[0], y: 0.016, z: p[1] - 0.01, sx: 0.074, sy: 0.024, sz: 0.084 });
  });

  // 躯干 + 腹甲
  B.put('root', SPH(), JADE, { y: 0.62, sx: 0.235, sy: 0.25, sz: 0.35 });
  B.put('root', SPH(), CREAM, { y: 0.52, z: -0.03, sx: 0.185, sy: 0.17, sz: 0.29 });
  // 金鳞（背侧两列半环）
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 2; j++) {
      B.put('root', TORUS(0.048, 0.011, PI), GOLD, {
        x: (j ? 1 : -1) * (0.135 + i * 0.012), y: 0.70 - i * 0.055, z: -0.12 + i * 0.15,
        rx: PI / 2, ry: (j ? -1 : 1) * 0.5, sz: 0.6, shine: true,
      });
    }
  }

  // 颈（前上方）+ 金鬃
  B.put('root', CAPSULE(0.105, 0.20), JADE, { y: 0.80, z: -0.26, rx: -0.62 });
  for (let i = 0; i < 4; i++) {
    B.put('root', CONE(), GOLD, {
      x: (i % 2 ? 0.045 : -0.045), y: 0.90 - i * 0.075, z: -0.13 - i * 0.055,
      sx: 0.055 - i * 0.008, sy: 0.13, sz: 0.045, rx: 0.9 + i * 0.12, rz: (i % 2 ? 1 : -1) * 0.18, shine: true,
    });
  }

  // 头（动画节点）
  const head = B.node('head', 'root', 0, 0.94, -0.40);
  B.put('head', SPH_HI(), JADE, { sx: 0.16, sy: 0.15, sz: 0.185 });
  B.put('head', SPH(), CREAM, { y: -0.055, z: -0.145, sx: 0.095, sy: 0.078, sz: 0.095 });
  B.put('head', SPH(), 0x27463d, { x: 0.035, y: -0.045, z: -0.215, sx: 0.014, sy: 0.010, sz: 0.008 });
  B.put('head', SPH(), 0x27463d, { x: -0.035, y: -0.045, z: -0.215, sx: 0.014, sy: 0.010, sz: 0.008 });
  addSmile(B, 'head', { y: -0.085, z: -0.205, w: 0.042, tube: 0.008, color: 0x2f5a4e });
  addEyes(B, 'head', { y: 0.045, z: -0.145, spread: 0.082, r: 0.043, style: 'full', iris: EYE, pupil: 0x2a3a34, wz: 0.55 });
  // 鹿角（分叉金角）
  [-1, 1].forEach(function (s) {
    const bx = s * 0.075;
    B.put('head', CONE(), GOLD, { x: bx, y: 0.24, z: 0.0, sx: 0.026, sy: 0.17, sz: 0.026, rz: s * 0.30, shine: true });
    B.put('head', CONE(), GOLD, { x: bx + s * 0.055, y: 0.33, z: 0.015, sx: 0.021, sy: 0.12, sz: 0.021, rz: s * 0.85, shine: true });
    B.put('head', CONE(), GOLD, { x: bx + s * 0.012, y: 0.345, z: -0.055, sx: 0.019, sy: 0.11, sz: 0.019, rx: -0.65, shine: true });
  });

  // 灵芝尾（动画节点）
  const tail = B.node('tail', 'root', 0, 0.74, 0.30);
  B.put('tail', CAPSULE(0.05, 0.12), JADE_D, { y: 0.01, z: 0.02, rx: PI / 2 - 0.5 });
  for (let i = -2; i <= 2; i++) {
    B.put('tail', leafGeo(0.055, 0.17, 0.014), (i % 2) ? GOLD : JADE_L, {
      x: i * 0.045, y: 0.10 - Math.abs(i) * 0.012, z: 0.10, rz: i * 0.34, rx: -0.9, shine: (i % 2) === 0,
    });
  }
  B.put('tail', TORUS(0.05, 0.012, TAU), GOLD, { y: 0.02, z: 0.10, rx: PI / 2, shine: true });

  return finishModel(B, function (nodes, dt, t) {
    nodes.head.rotation.x = Math.sin(t * 1.05) * 0.055;
    nodes.head.rotation.z = Math.sin(t * 0.8) * 0.04;
    nodes.tail.rotation.z = Math.sin(t * 1.6) * 0.12;
    nodes.tail.rotation.x = Math.sin(t * 1.15 + 0.4) * 0.08;
  }, { fitH: 1.0, fitInner: true });
}

// —— 毕方 BIFANG（huo）：独足火鸟，鹤形赤羽、金喙、翅尖燃焰 ——
function buildBifang() {
  const B = Builder();
  const RED = 0xe8453c, RED_D = 0xb8302a, GOLD = 0xffd93d, GOLD_D = 0xe8b33a;
  const CREAM = 0xfff2d0, FLAME = 0xff8a2a;

  // 独足（鹤腿：细长金腿 + 三趾 + 后趾）
  B.put('root', CYL(), GOLD_D, { y: 0.26, sx: 0.024, sy: 0.52, sz: 0.024 });
  B.put('root', SPH(), GOLD_D, { y: 0.50, sx: 0.045, sy: 0.05, sz: 0.045 });
  for (let k = 0; k < 3; k++) {
    B.put('root', CONE(), GOLD, { x: (k - 1) * 0.045, y: 0.028, z: -0.055, sx: 0.018, sy: 0.10, sz: 0.016, rx: -1.15, rz: (k - 1) * 0.2 });
  }
  B.put('root', CONE(), GOLD, { y: 0.03, z: 0.07, sx: 0.016, sy: 0.08, sz: 0.014, rx: 1.25 });

  // 身体（鹤形斜置）+ 腹羽
  B.put('root', SPH(), RED, { y: 0.70, z: 0.02, sx: 0.17, sy: 0.19, sz: 0.235, rx: 0.16 });
  B.put('root', SPH(), CREAM, { y: 0.63, z: -0.09, sx: 0.115, sy: 0.125, sz: 0.13 });

  // 尾羽（动画节点，赤金长羽）
  const tail = B.node('tail', 'root', 0, 0.76, 0.20);
  for (let i = -2; i <= 2; i++) {
    B.put('tail', leafGeo(0.05, 0.30, 0.012), (i % 2) ? GOLD : RED_D, {
      x: i * 0.035, y: 0.02, z: 0.03, rz: i * 0.26, rx: 0.75 + Math.abs(i) * 0.08,
    });
  }

  // 长颈（动画节点）
  const neck = B.node('neck', 'root', 0, 0.80, -0.10);
  capChain(B, 'neck', [[0, 0, 0], [0, 0.13, -0.055], [0, 0.24, -0.09], [0, 0.31, -0.105]], [0.068, 0.058, 0.05, 0.045], RED);

  // 头（动画节点）
  const head = B.node('head', 'neck', 0, 0.355, -0.115);
  B.put('head', SPH(), RED, { y: 0.015, sx: 0.10, sy: 0.092, sz: 0.115 });
  B.put('head', SPH(), CREAM, { y: -0.02, z: -0.065, sx: 0.065, sy: 0.052, sz: 0.06 });
  // 金喙
  B.put('head', CONE(), GOLD, { y: -0.005, z: -0.145, sx: 0.042, sy: 0.155, sz: 0.036, rx: -PI / 2 - 0.12, shine: true });
  // 赤冠 + 火冠羽
  B.put('head', leafGeo(0.035, 0.15, 0.012), RED_D, { y: 0.16, z: 0.01, rx: -0.35 });
  B.put('head', leafGeo(0.028, 0.11, 0.010), FLAME, { y: 0.14, z: -0.03, rx: -0.7, glow: FLAME, glowInt: 1.5 });
  addEyes(B, 'head', { y: 0.045, z: -0.075, spread: 0.052, r: 0.028, style: 'full', iris: 0xffe066, pupil: 0x2a1a14, wz: 0.62 });

  // 双翼（动画节点）+ 翅尖燃焰
  [['wingL', -1], ['wingR', 1]].forEach(function (w) {
    const name = w[0], s = w[1];
    B.node(name, 'root', s * 0.13, 0.80, 0.0);
    for (let i = 0; i < 3; i++) {
      B.put(name, leafGeo(0.10 - i * 0.014, 0.30 - i * 0.03, 0.012), i === 1 ? GOLD : RED, {
        x: s * (0.10 + i * 0.075), y: 0.03 - i * 0.02, z: 0.02 + i * 0.05,
        rz: s * (-1.15 - i * 0.18), ry: s * 0.25, rx: -0.15,
      });
    }
    B.put(name, CONE(), FLAME, { x: s * 0.32, y: 0.05, z: 0.10, sx: 0.045, sy: 0.16, sz: 0.045, rz: s * -0.9, glow: FLAME, glowInt: 1.9 });
    B.put(name, CONE(), GOLD, { x: s * 0.36, y: 0.10, z: 0.10, sx: 0.026, sy: 0.10, sz: 0.026, rz: s * -0.9, glow: GOLD, glowInt: 2.2 });
  });

  return finishModel(B, function (nodes, dt, t) {
    const flap = Math.sin(t * 6.2);
    nodes.wingL.rotation.z = 0.18 + flap * 0.22;
    nodes.wingR.rotation.z = -0.18 - flap * 0.22;
    nodes.wingL.rotation.x = Math.sin(t * 4.1) * 0.08;
    nodes.wingR.rotation.x = Math.sin(t * 4.1 + 0.6) * 0.08;
    nodes.neck.rotation.x = Math.sin(t * 1.3) * 0.05;
    nodes.head.rotation.x = Math.sin(t * 1.1 + 0.6) * 0.06;
    nodes.head.rotation.y = Math.sin(t * 0.8) * 0.12;
    nodes.tail.rotation.z = Math.sin(t * 1.5) * 0.08;
    nodes.tail.rotation.x = Math.sin(t * 2.0 + 0.3) * 0.10;
  }, { fitH: 1.05, fitInner: true });
}

// —— 玄武 XUANWU（shui）：龟蛇合体，墨绿龟甲金纹、青色蛇颈缠绕 ——
function buildXuanwu() {
  const B = Builder();
  const SHELL = 0x2f4a3a, SHELL_L = 0x3f6450, SHELL_D = 0x1f3327, GOLD = 0xe8b33a;
  const SNAKE = 0x4fb9a8, SNAKE_D = 0x2f8f80, CREAM = 0xd8e8d4, EYE = 0xffd93d;

  // 四足（龟足）+ 尾
  [[0.215, -0.15], [-0.215, -0.15], [0.215, 0.17], [-0.215, 0.17]].forEach(function (p) {
    B.put('root', SPH(), SHELL_L, { x: p[0], y: 0.20, z: p[1], sx: 0.095, sy: 0.115, sz: 0.10 });
    B.put('root', SPH(), CREAM, { x: p[0], y: 0.045, z: p[1] - 0.02, sx: 0.095, sy: 0.045, sz: 0.10 });
  });
  const tail = B.node('tail', 'root', 0, 0.34, 0.30);
  B.put('tail', CONE(), SHELL_L, { z: 0.08, sx: 0.045, sy: 0.17, sz: 0.038, rx: PI / 2 + 0.45 });

  // 龟身 + 龟甲（半球）+ 金边 + 甲纹
  B.put('root', SPH(), SHELL_D, { y: 0.33, sx: 0.30, sy: 0.22, sz: 0.345 });
  B.put('root', HEMI(), SHELL, { y: 0.37, sx: 0.315, sy: 0.31, sz: 0.36 });
  B.put('root', TORUS(0.30, 0.024, TAU), GOLD, { y: 0.38, rx: PI / 2, sy: 1.14, shine: true });
  for (let i = 0; i < 3; i++) {
    B.put('root', TORUS(0.095 + i * 0.052, 0.011, PI * 0.9), GOLD, {
      x: (i - 1) * 0.07, y: 0.635 - i * 0.015, z: 0.03, rx: -1.15, ry: (i - 1) * 0.28, shine: true,
    });
  }

  // 龟首（动画节点）
  const head = B.node('head', 'root', 0, 0.42, -0.33);
  B.put('head', SPH(), SHELL_L, { y: 0.02, sx: 0.105, sy: 0.10, sz: 0.135 });
  B.put('head', SPH(), CREAM, { y: -0.01, z: -0.10, sx: 0.07, sy: 0.055, sz: 0.07 });
  addEyes(B, 'head', { y: 0.045, z: -0.10, spread: 0.058, r: 0.028, style: 'full', iris: EYE, pupil: 0x203028, wz: 0.6 });

  // 青蛇（动画节点）：从甲后绕到身前，蛇首昂起
  const serpent = B.node('serpent', 'root', 0, 0.42, 0.14);
  capChain(B, 'serpent', [
    [0, 0, 0], [0.20, 0.08, -0.02], [0.28, 0.22, -0.12], [0.20, 0.34, -0.24],
    [0.02, 0.36, -0.30], [-0.16, 0.30, -0.28], [-0.225, 0.20, -0.225],
  ], [0.072, 0.068, 0.06, 0.054, 0.048, 0.042, 0.038], SNAKE);
  [[0.20, 0.08, -0.02], [0.20, 0.34, -0.24], [-0.16, 0.30, -0.28]].forEach(function (p) {
    B.put('serpent', TORUS(0.055, 0.011, TAU), GOLD, { x: p[0], y: p[1], z: p[2], rx: 0.9, shine: true });
  });

  B.node('snakeHead', 'serpent', -0.235, 0.205, -0.225);
  B.put('snakeHead', SPH(), SNAKE, { y: 0.02, sx: 0.08, sy: 0.068, sz: 0.10 });
  B.put('snakeHead', SPH(), SNAKE_D, { y: -0.015, z: -0.09, sx: 0.045, sy: 0.03, sz: 0.045 });
  addEyes(B, 'snakeHead', { y: 0.05, z: -0.05, spread: 0.042, r: 0.024, style: 'full', iris: EYE, pupil: 0x1e2a24, wz: 0.62 });
  B.put('snakeHead', CAPSULE(0.007, 0.06), 0xd0432e, { y: -0.01, z: -0.155, rx: PI / 2 });
  B.put('snakeHead', CAPSULE(0.006, 0.035), 0xd0432e, { x: 0.018, y: -0.01, z: -0.19, rx: PI / 2, ry: 0.4 });
  B.put('snakeHead', CAPSULE(0.006, 0.035), 0xd0432e, { x: -0.018, y: -0.01, z: -0.19, rx: PI / 2, ry: -0.4 });

  return finishModel(B, function (nodes, dt, t) {
    nodes.head.rotation.x = Math.sin(t * 1.0) * 0.06;
    nodes.head.rotation.z = Math.sin(t * 0.7) * 0.045;
    nodes.tail.rotation.z = Math.sin(t * 1.5) * 0.12;
    nodes.serpent.rotation.y = Math.sin(t * 0.85) * 0.12;
    nodes.serpent.rotation.z = Math.sin(t * 1.15 + 0.4) * 0.06;
    nodes.snakeHead.rotation.x = Math.sin(t * 1.6 + 0.3) * 0.10;
    nodes.snakeHead.rotation.y = Math.sin(t * 1.1) * 0.14;
  }, { fitH: 0.95, fitInner: true });
}

// ===========================================================================
// 5. 行者模型（四位，站立 + 右手前举持法器）
// ===========================================================================
// 造型要点见 MYTHOLOGY 第 2 节：配色 / 服饰 / 头饰为中国神话风。
// 骨架与动画节点名与旧版一致：root / torso / head / armL / armR / handAnchor；
// 句芒额外有 hairL / hairR / cape，玄冥额外有 pony，雷公额外有 drum / tassel。
const TRAINER_LOOKS = {
  // 雷公：深蓝短打 + 鎏金云肩 + 雷纹头巾 + 束袖，背后小雷鼓，赤绳结
  t_bolt: {
    skin: 0xf0c8a0, hair: 0x2a2028,
    robe: 0x2f4a7a, robeD: 0x24395e, sleeve: 0x2a3f66,
    trim: 0xe8b33a, trimD: 0xc28e22, accent: 0xffd93d,
    pants: 0x263a5c, boot: 0x22304a, sole: 0x152033, glove: 0x3d2a22,
    sash: 0xd0432e, light: 0x8fa8d8,
  },
  // 句芒：青绿道袍 + 木纹护腕 + 鹿角木冠 + 藤蔓腰带，羽形披肩
  t_leaf: {
    skin: 0xf3cba8, hair: 0x3a2a1e,
    robe: 0x4e9c3f, robeD: 0x3a7a2c, sleeve: 0x6fbb4a,
    trim: 0xd8f0c0, trimD: 0xa8d890, accent: 0x7ec850,
    pants: 0x2f4a2a, boot: 0x6a4a2e, sole: 0x3f2a18, glove: 0x6a4a2e,
    sash: 0x7ac95a, light: 0x9fe08a, wood: 0x8a5a2a,
  },
  // 祝融：赤红甲胄 + 火焰纹披风 + 朱发束冠 + 金环臂钏
  t_ember: {
    skin: 0xe8b088, hair: 0xd0432e,
    robe: 0xd0432e, robeD: 0xa8301f, sleeve: 0xb8302a,
    trim: 0xe8b33a, trimD: 0xc28e22, accent: 0xff8a3d,
    pants: 0x3a2420, boot: 0x2b1a16, sole: 0x1a100d, glove: 0x2b1a16,
    sash: 0xe8b33a, light: 0xffc48a,
  },
  // 玄冥：玄青长袍 + 浪纹 + 龟甲护心 + 玉簪束发，蓝发
  t_tide: {
    skin: 0xefc8a8, hair: 0x3f8fc0,
    robe: 0x24485a, robeD: 0x18323f, sleeve: 0x2c5a70,
    trim: 0x7ad0c8, trimD: 0x4fb0a8, accent: 0x5ab8f0,
    pants: 0x1b2f3a, boot: 0x1b2f3a, sole: 0x101c24, glove: 0x2c5a70,
    sash: 0x7ad0c8, light: 0x9fe8e0,
  },
};

// 通用人形骨架：靴 / 腿 / 袍 / 腰带 + 躯干 + 头 + 双臂（右手前举持法器）
function buildTrainer(id) {
  const L = TRAINER_LOOKS[id] || TRAINER_LOOKS.t_bolt;
  const B = Builder();

  // ---------------- 下半身（不参与动画） ----------------
  [1, -1].forEach(function (s) {
    // 靴：靴筒 + 靴面 + 靴头 + 鞋底 + 靴口金边
    B.put('root', CAPSULE(0.072, 0.18), L.boot, { x: s * 0.105, y: 0.30, z: 0.0 });
    B.put('root', SPH(), L.boot, { x: s * 0.105, y: 0.135, z: -0.02, sx: 0.088, sy: 0.08, sz: 0.12 });
    B.put('root', SPH(), L.boot, { x: s * 0.105, y: 0.075, z: -0.10, sx: 0.072, sy: 0.05, sz: 0.075 });
    B.put('root', SPH(), L.sole, { x: s * 0.105, y: 0.028, z: -0.04, sx: 0.098, sy: 0.026, sz: 0.175 });
    B.put('root', SPH(), L.trim, { x: s * 0.105, y: 0.20, z: -0.01, sx: 0.085, sy: 0.013, sz: 0.11, shine: true });
    // 小腿 / 大腿 / 膝
    B.put('root', CAPSULE(0.058, 0.24), L.pants, { x: s * 0.105, y: 0.44, z: -0.005 });
    B.put('root', CAPSULE(0.079, 0.26), L.pants, { x: s * 0.10, y: 0.72, z: 0.0 });
    B.put('root', SPH(), L.pants, { x: s * 0.105, y: 0.555, z: -0.015, sx: 0.063, sy: 0.062, sz: 0.066 });
  });

  // 袍下摆：道袍 / 长袍为长裙，短打为胯前布片
  if (id === 't_leaf' || id === 't_tide') {
    B.put('root', CONE(), L.robeD, { y: 0.60, z: 0.015, sx: 0.285, sy: 0.68, sz: 0.245 });
    B.put('root', CONE(), L.robe, { y: 0.63, sx: 0.275, sy: 0.70, sz: 0.235 });
    B.put('root', TORUS(0.27, 0.018, TAU), L.trim, { y: 0.285, rx: PI / 2, sy: 1.0, shine: true });
  } else {
    B.put('root', CONE(), L.robe, { y: 0.83, sx: 0.19, sy: 0.30, sz: 0.155 });
    B.put('root', SPH(), L.robeD, { y: 0.80, z: -0.10, sx: 0.145, sy: 0.10, sz: 0.04 });
  }

  // 胯 + 腰带 + 腰扣
  B.put('root', SPH(), L.pants, { y: 0.93, sx: 0.175, sy: 0.115, sz: 0.125 });
  B.put('root', CYL(), L.sash, { y: 1.00, sx: 0.172, sy: 0.055, sz: 0.132 });
  B.put('root', SPH(), L.trim, { y: 1.00, z: -0.128, sx: 0.045, sy: 0.032, sz: 0.014, shine: true });
  // 腰带垂下的绳结
  B.put('root', CAPSULE(0.012, 0.10), L.sash, { x: 0.05, y: 0.93, z: -0.13, rx: 0.1 });
  B.put('root', CAPSULE(0.010, 0.08), L.sash, { x: 0.075, y: 0.92, z: -0.125, rx: 0.15, rz: 0.2 });

  // ---------------- 躯干（动画节点） ----------------
  const torso = B.node('torso', 'root', 0, 0.98, 0);
  B.put('torso', SPH_HI(), L.robe, { y: 0.22, sx: 0.185, sy: 0.245, sz: 0.132 });
  B.put('torso', SPH(), L.robeD, { y: 0.04, sx: 0.165, sy: 0.06, sz: 0.12 });
  // 交领（右衽）：两片斜襟在胸骨处交汇成 V
  B.put('torso', SPH(), L.trim, { x: -0.052, y: 0.285, z: -0.116, sx: 0.019, sy: 0.155, sz: 0.020, rz: 0.58, shine: true });
  B.put('torso', SPH(), L.trim, { x: 0.052, y: 0.285, z: -0.116, sx: 0.019, sy: 0.155, sz: 0.020, rz: -0.58, shine: true });
  B.put('torso', CYL(), L.trim, { y: 0.40, sx: 0.078, sy: 0.036, sz: 0.064, shine: true });
  // 肩 / 袖根
  B.put('torso', SPH(), L.sleeve, { x: 0.185, y: 0.34, z: 0.0, sx: 0.082, sy: 0.078, sz: 0.085 });
  B.put('torso', SPH(), L.sleeve, { x: -0.185, y: 0.34, z: 0.0, sx: 0.082, sy: 0.078, sz: 0.085 });
  // 脖子与头
  B.put('torso', CYL(), L.skin, { y: 0.42, sx: 0.058, sy: 0.07, sz: 0.058 });
  const head = B.node('head', 'torso', 0, 0.50, 0);

  // ---------------- 头部基础 ----------------
  B.put('head', SPH_HI(), L.skin, { y: 0.13, sx: 0.145, sy: 0.155, sz: 0.142 });
  B.put('head', SPH(), L.skin, { x: 0.142, y: 0.12, z: 0.005, sx: 0.032, sy: 0.048, sz: 0.03 });
  B.put('head', SPH(), L.skin, { x: -0.142, y: 0.12, z: 0.005, sx: 0.032, sy: 0.048, sz: 0.03 });
  addEyes(B, 'head', { y: 0.155, z: -0.118, spread: 0.056, r: 0.034, style: 'full', white: 0xfffdf8, iris: 0x3a2a20, pupil: 0x241c14, wz: 0.5, hiR: 0.28 });
  B.put('head', SPH(), L.hair, { x: 0.058, y: 0.215, z: -0.115, sx: 0.038, sy: 0.010, sz: 0.014, rz: id === 't_ember' ? 0.20 : 0.05 });
  B.put('head', SPH(), L.hair, { x: -0.058, y: 0.215, z: -0.115, sx: 0.038, sy: 0.010, sz: 0.014, rz: id === 't_ember' ? -0.20 : -0.05 });
  B.put('head', SPH(), L.skin, { y: 0.115, z: -0.142, sx: 0.018, sy: 0.016, sz: 0.018 });
  addSmile(B, 'head', { y: 0.058, z: -0.132, w: 0.032, tube: 0.008, color: 0x8a4a3a });
  B.put('head', SPH(), 0xff9a9a, { x: 0.10, y: 0.085, z: -0.105, sx: 0.028, sy: 0.016, sz: 0.014 });
  B.put('head', SPH(), 0xff9a9a, { x: -0.10, y: 0.085, z: -0.105, sx: 0.028, sy: 0.016, sz: 0.014 });

  // ---------------- 左臂（自然下垂） ----------------
  const armL = B.node('armL', 'torso', -0.205, 0.36, 0);
  B.put('armL', CAPSULE(0.058, 0.15), L.sleeve, { x: -0.012, y: -0.10, z: 0.0, rz: 0.06 });
  B.put('armL', SPH(), L.skin, { x: -0.02, y: -0.21, z: 0.0, sx: 0.052, sy: 0.052, sz: 0.052 });
  B.put('armL', CAPSULE(0.046, 0.17), L.skin, { x: -0.026, y: -0.32, z: -0.012, rz: 0.03 });
  B.put('armL', SPH(), L.skin, { x: -0.03, y: -0.43, z: -0.022, sx: 0.055, sy: 0.062, sz: 0.05 });
  B.put('armL', CYL(), L.glove, { x: -0.03, y: -0.39, z: -0.02, sx: 0.05, sy: 0.03, sz: 0.046 });
  for (let k = 0; k < 3; k++) {
    B.put('armL', CAPSULE(0.012, 0.045), L.skin, { x: -0.03 + (k - 1) * 0.024, y: -0.485, z: -0.03, rz: (k - 1) * 0.16 });
  }

  // ---------------- 右臂（前举握着法器） ----------------
  const armR = B.node('armR', 'torso', 0.205, 0.36, 0);
  B.put('armR', CAPSULE(0.060, 0.13), L.sleeve, { x: 0.022, y: -0.055, z: -0.085, rx: -0.62 });
  B.put('armR', SPH(), L.sleeve, { x: 0.05, y: -0.105, z: -0.165, sx: 0.055, sy: 0.055, sz: 0.055 });
  B.put('armR', CAPSULE(0.048, 0.15), L.skin, { x: 0.042, y: -0.085, z: -0.29, rx: -1.32 });
  B.put('armR', CYL(), L.glove, { x: 0.038, y: -0.05, z: -0.395, sx: 0.05, sy: 0.026, sz: 0.048, rx: -1.2 });
  B.put('armR', SPH(), L.skin, { x: 0.034, y: -0.025, z: -0.44, sx: 0.058, sy: 0.048, sz: 0.068 });
  for (let k = 0; k < 3; k++) {
    B.put('armR', CAPSULE(0.013, 0.045), L.skin, {
      x: 0.034 + (k - 1) * 0.026, y: -0.005, z: -0.49, rx: -PI / 2 + 0.25, rz: (k - 1) * 0.12,
    });
  }
  // 挂载点：90-main 可把法器挂到这里（跟随右臂动画）
  const anchor = new T3.Object3D();
  anchor.name = 'handAnchor';
  anchor.position.set(0.034, -0.02, -0.50);
  armR.add(anchor);

  // ---------------- 发型与专属配饰 ----------------
  if (id === 't_bolt') {
    // 雷公：雷纹头巾 + 鎏金云肩 + 束袖 + 背后小雷鼓 + 赤绳结
    B.put('head', HEMI(), L.robeD, { y: 0.19, z: 0.01, sx: 0.152, sy: 0.135, sz: 0.152 });
    B.put('head', TORUS(0.148, 0.020, TAU), L.robeD, { y: 0.165, z: 0.01, rx: PI / 2 - 0.10 });
    B.put('head', TORUS(0.150, 0.010, TAU), L.trim, { y: 0.128, z: 0.01, rx: PI / 2 - 0.10, shine: true });
    B.put('head', boltGeo(0.075, 0.012), L.accent, { y: 0.19, z: -0.145, glow: L.accent, glowInt: 1.4 });
    B.put('head', SPH(), L.hair, { x: 0.13, y: 0.08, z: 0.0, sx: 0.035, sy: 0.06, sz: 0.05 });
    B.put('head', SPH(), L.hair, { x: -0.13, y: 0.08, z: 0.0, sx: 0.035, sy: 0.06, sz: 0.05 });
    B.put('head', SPH(), L.hair, { y: 0.17, z: 0.10, sx: 0.10, sy: 0.07, sz: 0.055 });
    // 云肩：三片云头甲叠在双肩
    [-1, 1].forEach(function (s) {
      for (let i = 0; i < 3; i++) {
        B.put('torso', SPH(), L.trim, {
          x: s * (0.14 + i * 0.035), y: 0.35 - i * 0.035, z: -0.02 + i * 0.02,
          sx: 0.075 - i * 0.012, sy: 0.032, sz: 0.075, rz: s * (0.18 + i * 0.22), shine: true,
        });
      }
    });
    // 束袖（金口）
    B.put('armL', CYL(), L.trim, { x: -0.028, y: -0.245, z: -0.006, sx: 0.052, sy: 0.026, sz: 0.05, shine: true });
    B.put('armR', CYL(), L.trim, { x: 0.045, y: -0.10, z: -0.345, sx: 0.052, sy: 0.024, sz: 0.05, rx: -1.2, shine: true });
    // 背后小雷鼓
    const drum = B.node('drum', 'torso', 0, 0.20, 0.175);
    B.put('drum', CYL(), L.robeD, { sx: 0.105, sy: 0.06, sz: 0.105, rx: PI / 2 });
    B.put('drum', TORUS(0.104, 0.013, TAU), L.trim, { z: 0.031, shine: true });
    B.put('drum', TORUS(0.104, 0.013, TAU), L.trim, { z: -0.031, shine: true });
    B.put('drum', SPH(), 0xfff2d0, { z: 0.033, sx: 0.088, sy: 0.088, sz: 0.018 });
    B.put('drum', SPH(), 0xfff2d0, { z: -0.033, sx: 0.088, sy: 0.088, sz: 0.018 });
    B.put('drum', CAPSULE(0.010, 0.13), 0x6a4a2e, { x: 0.07, y: 0.07, z: 0.05, rz: 0.6, ry: 0.3 });
    B.put('drum', CAPSULE(0.010, 0.13), 0x6a4a2e, { x: -0.07, y: 0.07, z: 0.05, rz: -0.6, ry: -0.3 });
    // 赤绳结 + 流苏
    const tassel = B.node('tassel', 'torso', 0, 0.10, 0.16);
    B.put('tassel', SPH(), L.sash, { sx: 0.035, sy: 0.03, sz: 0.03 });
    B.put('tassel', CAPSULE(0.010, 0.10), L.sash, { y: -0.09 });
    B.put('tassel', CAPSULE(0.008, 0.08), L.sash, { x: 0.02, y: -0.09, rz: 0.2 });
    B.put('tassel', SPH(), L.trim, { y: -0.15, sx: 0.014, sy: 0.02, sz: 0.014, shine: true });
  } else if (id === 't_leaf') {
    // 句芒：青绿道袍 + 鹿角木冠 + 藤蔓腰带 + 木纹护腕 + 羽形披肩
    B.put('head', SPH(), L.hair, { y: 0.20, z: 0.02, sx: 0.150, sy: 0.115, sz: 0.150 });
    B.put('head', SPH(), L.hair, { y: 0.155, z: -0.085, sx: 0.135, sy: 0.085, sz: 0.085 });
    B.put('head', SPH(), L.hair, { x: 0.06, y: 0.16, z: -0.115, sx: 0.06, sy: 0.07, sz: 0.045, rz: -0.25 });
    B.put('head', SPH(), L.hair, { x: -0.06, y: 0.16, z: -0.115, sx: 0.06, sy: 0.07, sz: 0.045, rz: 0.25 });
    // 鹿角木冠（木纹分叉 + 横带）
    [-1, 1].forEach(function (s) {
      B.put('head', CONE(), L.wood, { x: s * 0.06, y: 0.27, z: 0.02, sx: 0.022, sy: 0.18, sz: 0.022, rz: s * 0.42 });
      B.put('head', CONE(), L.wood, { x: s * 0.105, y: 0.34, z: 0.03, sx: 0.017, sy: 0.12, sz: 0.017, rz: s * 0.95 });
      B.put('head', CONE(), L.wood, { x: s * 0.045, y: 0.37, z: -0.02, sx: 0.015, sy: 0.10, sz: 0.015, rx: -0.35, rz: s * 0.15 });
    });
    B.put('head', TORUS(0.132, 0.016, TAU), L.wood, { y: 0.205, z: 0.005, rx: PI / 2 - 0.12 });
    // 两侧长发（动画节点）
    B.node('hairL', 'head', -0.148, 0.15, 0.02);
    B.node('hairR', 'head', 0.148, 0.15, 0.02);
    capChain(B, 'hairL', [[-0.005, 0.01, 0.0], [-0.028, -0.10, 0.035], [-0.03, -0.22, 0.065], [-0.018, -0.32, 0.055]], [0.042, 0.036, 0.026, 0.015], L.hair);
    capChain(B, 'hairR', [[0.005, 0.01, 0.0], [0.028, -0.10, 0.035], [0.03, -0.22, 0.065], [0.018, -0.32, 0.055]], [0.042, 0.036, 0.026, 0.015], L.hair);
    B.put('hairL', SPH(), L.trim, { y: 0.04, z: 0.01, sx: 0.03, sy: 0.02, sz: 0.028 });
    B.put('hairR', SPH(), L.trim, { y: 0.04, z: 0.01, sx: 0.03, sy: 0.02, sz: 0.028 });
    // 羽形披肩（动画节点：随呼吸轻摆）
    const cape = B.node('cape', 'torso', 0, 0.34, 0.045);
    for (let i = -2; i <= 2; i++) {
      B.put('cape', leafGeo(0.075, 0.26, 0.014), (i % 2) ? L.trim : L.light, {
        x: i * 0.085, y: -0.02, z: 0.02 + Math.abs(i) * 0.01,
        rz: i * 0.22, rx: 0.30 + Math.abs(i) * 0.05,
      });
    }
    B.put('cape', SPH(), L.robe, { y: 0.02, z: 0.01, sx: 0.17, sy: 0.075, sz: 0.09 });
    // 木纹护腕
    B.put('armL', CYL(), L.wood, { x: -0.028, y: -0.24, z: -0.006, sx: 0.054, sy: 0.045, sz: 0.052 });
    B.put('armR', CYL(), L.wood, { x: 0.045, y: -0.10, z: -0.345, sx: 0.054, sy: 0.04, sz: 0.052, rx: -1.2 });
    // 藤蔓腰带 + 垂藤小叶
    B.put('root', CYL(), L.sash, { y: 1.00, sx: 0.176, sy: 0.04, sz: 0.132 });
    B.put('root', CAPSULE(0.012, 0.16), L.sash, { x: 0.08, y: 0.90, z: -0.12, rx: 0.15 });
    B.put('root', CAPSULE(0.010, 0.12), L.sash, { x: -0.06, y: 0.91, z: -0.125, rx: 0.10, rz: 0.12 });
    B.put('root', leafGeo(0.03, 0.07, 0.008), L.accent, { x: 0.095, y: 0.845, z: -0.125, rz: 0.6 });
    B.put('root', leafGeo(0.026, 0.06, 0.008), L.accent, { x: -0.075, y: 0.86, z: -0.128, rz: -0.5 });
    // 道袍前襟与下摆纹
    B.put('torso', SPH(), L.trim, { y: 0.14, z: -0.124, sx: 0.10, sy: 0.02, sz: 0.018, shine: true });
    B.put('root', TORUS(0.20, 0.012, PI), L.accent, { y: 0.46, z: -0.19, rx: PI / 2, ry: 0.0, sz: 0.8 });
  } else if (id === 't_ember') {
    // 祝融：朱发束冠 + 赤红甲胄 + 火焰纹披风 + 金环臂钏
    B.put('head', SPH(), L.hair, { y: 0.21, z: 0.02, sx: 0.148, sy: 0.115, sz: 0.148 });
    B.put('head', SPH(), L.hair, { y: 0.30, z: 0.05, sx: 0.085, sy: 0.075, sz: 0.085 });
    B.put('head', TORUS(0.075, 0.016, TAU), L.trim, { y: 0.30, z: 0.05, rx: PI / 2, shine: true });
    B.put('head', CONE(), L.trim, { y: 0.385, z: 0.05, sx: 0.026, sy: 0.09, sz: 0.026, shine: true });
    [-1, 1].forEach(function (s) {
      B.put('head', CONE(), L.accent, { x: s * 0.06, y: 0.35, z: 0.03, sx: 0.022, sy: 0.10, sz: 0.018, rz: s * 0.35, glow: L.accent, glowInt: 1.3 });
    });
    B.put('head', SPH(), L.hair, { x: 0.055, y: 0.175, z: -0.115, sx: 0.06, sy: 0.055, sz: 0.045, rz: -0.3 });
    B.put('head', SPH(), L.hair, { x: -0.055, y: 0.175, z: -0.115, sx: 0.06, sy: 0.055, sz: 0.045, rz: 0.3 });
    // 火焰纹披风（动画节点）
    const cape = B.node('cape', 'torso', 0, 0.34, 0.045);
    B.put('cape', CONE(), L.robeD, { y: -0.16, z: 0.03, sx: 0.255, sy: 0.44, sz: 0.225 });
    for (let i = 0; i < 3; i++) {
      B.put('cape', CONE(), L.accent, { x: (i - 1) * 0.09, y: -0.18 - Math.abs(i - 1) * 0.02, z: -0.10, sx: 0.026, sy: 0.12, sz: 0.018, rx: 0.5, glow: L.accent, glowInt: 1.5 });
    }
    B.put('cape', TORUS(0.20, 0.018, TAU), L.trim, { y: -0.36, rx: PI / 2, sz: 0.86, shine: true });
    // 赤红甲胄：胸片 + 肩甲
    B.put('torso', SPH(), L.robeD, { y: 0.25, z: -0.112, sx: 0.14, sy: 0.145, sz: 0.034 });
    B.put('torso', SPH(), L.trim, { y: 0.25, z: -0.118, sx: 0.148, sy: 0.152, sz: 0.028, shine: true });
    B.put('torso', CONE(), L.accent, { y: 0.25, z: -0.142, sx: 0.028, sy: 0.08, sz: 0.014, glow: L.accent, glowInt: 1.2 });
    [-1, 1].forEach(function (s) {
      B.put('torso', SPH(), L.robeD, { x: s * 0.20, y: 0.36, z: 0.0, sx: 0.09, sy: 0.075, sz: 0.095 });
      B.put('torso', TORUS(0.075, 0.012, PI), L.trim, { x: s * 0.205, y: 0.325, z: -0.03, rx: PI / 2, ry: s * 0.3, shine: true });
    });
    // 金环臂钏
    B.put('armL', TORUS(0.058, 0.011, TAU), L.trim, { x: -0.024, y: -0.16, z: -0.005, rx: PI / 2, shine: true });
    B.put('armR', TORUS(0.055, 0.011, TAU), L.trim, { x: 0.043, y: -0.09, z: -0.20, rx: -1.2, shine: true });
  } else {
    // 玄冥：蓝发玉簪 + 玄青长袍浪纹 + 龟甲护心
    B.put('head', SPH(), L.hair, { y: 0.20, z: 0.025, sx: 0.148, sy: 0.115, sz: 0.148 });
    B.put('head', SPH(), L.hair, { y: 0.30, z: 0.06, sx: 0.078, sy: 0.07, sz: 0.078 });
    B.put('head', CYL(), L.trim, { y: 0.315, z: 0.06, sx: 0.012, sy: 0.26, sz: 0.012, rx: PI / 2, shine: true });
    B.put('head', SPH(), L.light, { x: 0.10, y: 0.235, z: -0.06, sx: 0.045, sy: 0.022, sz: 0.06, rz: -0.4 });
    // 后马尾（动画节点）
    B.node('pony', 'head', 0, 0.17, 0.135);
    capChain(B, 'pony', [[0, 0.01, 0], [0.01, 0.08, 0.09], [0.02, 0.02, 0.19], [0.02, -0.10, 0.26], [0.01, -0.20, 0.30]], [0.052, 0.045, 0.035, 0.024, 0.013], L.hair);
    B.put('pony', TORUS(0.040, 0.012, TAU), L.trim, { y: 0.02, z: 0.02, rx: PI / 2 + 0.5, shine: true });
    B.put('pony', CAPSULE(0.016, 0.12), L.light, { x: 0.03, y: -0.02, z: 0.14, rx: 0.9, ry: 0.2 });
    // 龟甲护心（墨绿甲片 + 青玉边）
    B.put('torso', SPH(), 0x3f6450, { y: 0.25, z: -0.112, sx: 0.135, sy: 0.135, sz: 0.035 });
    B.put('torso', TORUS(0.105, 0.014, TAU), L.trim, { y: 0.25, z: -0.118, shine: true });
    B.put('torso', SPH(), 0x2f4a3a, { y: 0.25, z: -0.132, sx: 0.085, sy: 0.085, sz: 0.012 });
    // 浪纹（袍摆上的青玉弧线）
    for (let i = 0; i < 3; i++) {
      B.put('root', TORUS(0.075 + i * 0.02, 0.010, PI), L.trim, { x: (i - 1) * 0.085, y: 0.42 + i * 0.10, z: -0.205, rz: PI, shine: true });
    }
    B.put('root', TORUS(0.24, 0.012, PI), L.accent, { y: 0.34, z: -0.16, rx: PI / 2, sz: 0.85, glow: L.accent, glowInt: 1.1 });
  }

  // ---------------- 待机动画 ----------------
  const anim = function (nodes, dt, t) {
    const br = Math.sin(t * 1.55);
    nodes.torso.scale.y = 1 + br * 0.010;
    nodes.torso.rotation.z = Math.sin(t * 0.62) * 0.012;
    nodes.head.rotation.x = Math.sin(t * 0.95) * 0.028;
    nodes.head.rotation.y = Math.sin(t * 0.48 + 1.2) * 0.07;
    // 持法器手保持稳定，只留一两毫米呼吸位移
    nodes.armR.rotation.x = Math.sin(t * 1.55 + 0.6) * 0.012;
    nodes.armR.rotation.z = Math.sin(t * 0.62) * 0.008;
    nodes.armL.rotation.x = Math.sin(t * 1.3 + 1.7) * 0.035;
    if (nodes.hairL) {
      nodes.hairL.rotation.z = Math.sin(t * 1.8) * 0.10;
      nodes.hairL.rotation.x = Math.sin(t * 1.3 + 0.5) * 0.07;
      nodes.hairR.rotation.z = -Math.sin(t * 1.8 + 0.4) * 0.10;
      nodes.hairR.rotation.x = Math.sin(t * 1.3 + 0.9) * 0.07;
    }
    if (nodes.pony) {
      nodes.pony.rotation.z = Math.sin(t * 1.65) * 0.09;
      nodes.pony.rotation.x = Math.sin(t * 1.2 + 0.8) * 0.07;
    }
    if (nodes.cape) {
      nodes.cape.rotation.x = Math.sin(t * 1.4) * 0.022;
      nodes.cape.rotation.z = Math.sin(t * 0.9 + 0.5) * 0.018;
    }
    if (nodes.drum) {
      nodes.drum.rotation.z = Math.sin(t * 1.1) * 0.05;
    }
    if (nodes.tassel) {
      nodes.tassel.rotation.z = Math.sin(t * 1.4) * 0.14;
      nodes.tassel.rotation.x = Math.sin(t * 1.05) * 0.10;
    }
  };

  return finishModel(B, anim, { fitH: 1.8 });
}

// ===========================================================================
// 6. 模板缓存与注册口
// ===========================================================================
// 4 灵兽在本文件注册；14 只妖物由 32-beasts.js 调用 registerBuilders 注入。
const PARTNER_BUILDERS = {
  kui: buildKui, qilin: buildQilin, bifang: buildBifang, xuanwu: buildXuanwu,
};
const BEAST_BUILDERS = {};
const TEMPLATES = new Map();

function builderFor(id) {
  if (TRAINER_LOOKS[id]) return buildTrainer;
  if (PARTNER_BUILDERS[id]) return PARTNER_BUILDERS[id];
  if (BEAST_BUILDERS[id]) return BEAST_BUILDERS[id];
  return null;
}

// 查找顺序：行者 → 4 灵兽 → 32-beasts 注册的妖物
function getTemplate(id) {
  let tpl = TEMPLATES.get(id);
  if (tpl) return tpl;
  if (!T3) throw new Error('PG.models: THREE 未加载，无法构建 3D 模型');
  const fn = builderFor(id);
  if (!fn) throw new Error('PG.models: 未知模型 id "' + id + '"（妖物需由 32-beasts.js 注册）');
  tpl = fn(id);
  const isTrainer = !!TRAINER_LOOKS[id];
  tpl.group.name = (isTrainer ? 'trainer_' : 'model_') + id;
  tpl.group.userData.modelId = id;
  TEMPLATES.set(id, tpl);
  return tpl;
}

// 32-beasts.js 注入 14 只妖物的 builder（key = 异兽 id）
function registerBuilders(map) {
  if (!map) return BEAST_BUILDERS;
  Object.keys(map).forEach(function (k) {
    if (typeof map[k] !== 'function') return;
    BEAST_BUILDERS[k] = map[k];
    TEMPLATES.delete(k);
  });
  return BEAST_BUILDERS;
}

// 克隆模板并收集命名动画节点（几何与材质共享，克隆开销极小）
function instantiate(id) {
  const tpl = getTemplate(id);
  const group = tpl.group.clone(true);
  const nodes = { root: group };
  group.traverse(function (o) {
    if (o !== group && o.name) nodes[o.name] = o;
  });
  const state = { phase: Math.random() * TAU, seed: Math.random() };
  const refs = {
    group: group,
    height: tpl.height,
    radius: tpl.radius,
    nodes: nodes,
    update: function (dt, t) {
      try {
        tpl.anim(nodes, dt, (t || 0) + state.phase, state);
      } catch (e) {
        if (!refs._animErr) { refs._animErr = true; console.warn('PG.models 动画异常(' + id + ')：', e); }
      }
    },
  };
  return refs;
}

function makeBeast(id) {
  const refs = instantiate(id);
  return {
    group: refs.group,
    height: refs.height,
    radius: refs.radius,
    update: refs.update,
    id: id,
  };
}

function makeTrainerModel(id) {
  const refs = instantiate(id);
  const anchor = refs.nodes.handAnchor || null;
  return {
    group: refs.group,
    height: refs.height,
    update: refs.update,
    handAnchor: anchor,
    id: id,
  };
}

// ===========================================================================
// 7. 对外 API
// ===========================================================================
// 2D 委托：图标 / 头像由 35-art.js 挂在 PG.models.art 上；未加载时返回 null
function icon(id, size) {
  try {
    const A = PG.models && PG.models.art;
    return (A && typeof A.icon === 'function') ? A.icon(id, size) : null;
  } catch (e) { return null; }
}
function portrait(id, size) {
  try {
    const A = PG.models && PG.models.art;
    return (A && typeof A.portrait === 'function') ? A.portrait(id, size) : null;
  } catch (e) { return null; }
}

// 预热模板（可选，游戏启动时调用可避免首刷卡顿）；未注册的妖物直接跳过
function warmup(ids) {
  const list = ids || CREATURE_IDS.concat(TRAINER_IDS);
  for (let i = 0; i < list.length; i++) {
    try { getTemplate(list[i]); } catch (e) { /* 忽略单只失败（如 32-beasts 尚未加载） */ }
  }
  return true;
}

PG.models = {
  CREATURES: CREATURE_IDS.slice(),
  TRAINERS: TRAINER_IDS.slice(),
  TYPES: Object.keys(TYPE_COLORS),
  TYPE_COLORS: TYPE_COLORS,
  TYPE_DARK: TYPE_DARK,
  TYPE_CN: TYPE_CN,
  has: function (id) { return !!DATA[id] || !!TRAINER_DATA[id]; },
  info: infoOf,
  make: function (id) {
    if (!DATA[id]) throw new Error('PG.models.make: 未知异兽 id "' + id + '"');
    return makeBeast(id);
  },
  makeTrainer: function (id) {
    if (!TRAINER_DATA[id]) throw new Error('PG.models.makeTrainer: 未知行者 id "' + id + '"');
    return makeTrainerModel(id);
  },
  portrait: portrait,
  icon: icon,
  warmup: warmup,
  registerBuilders: registerBuilders,
  art: null,
  // 供 32-beasts.js 使用的拼装 DSL（成员清单见 docs/MYTHOLOGY.md 第 8.1 节）
  _dsl: {
    Builder: Builder, SPH: SPH, SPH_HI: SPH_HI, CONE: CONE, CYL: CYL, BOX: BOX,
    HEMI: HEMI, TORUS: TORUS, CAPSULE: CAPSULE, ICO: ICO,
    leafGeo: leafGeo, boltGeo: boltGeo, scytheGeo: scytheGeo, capChain: capChain,
    addEye: addEye, addEyes: addEyes, addSmile: addSmile, addOpenMouth: addOpenMouth,
    addFangs: addFangs, addTeethRow: addTeethRow, addCheeks: addCheeks,
    addClaws: addClaws, addFoot: addFoot, finishModel: finishModel,
    quatY: quatY, TAU: TAU, PI: PI,
  },
  // 调试用：查看模板高度 / draw call 估算
  stats: function (id) {
    const t = getTemplate(id);
    let meshes = 0;
    t.group.traverse(function (o) { if (o.isMesh) meshes++; });
    return { id: id, height: t.height, radius: t.radius, meshes: meshes };
  },
  silhouetteColor: function (id) {
    const d = DATA[id];
    if (d && TYPE_COLORS[d.type]) return TYPE_COLORS[d.type];
    const td = TRAINER_DATA[id];
    return (td && TYPE_COLORS[td.type]) || '#ffffff';
  },
};

})();

/* ==================== 32-beasts.js ==================== */
/* ============================================================================
 * 32-beasts.js — 山海妖物 3D 模型（14 只）
 * ----------------------------------------------------------------------------
 * 造型由 src/30-models.js 暴露的 PG.models._dsl 拼装，末尾 registerBuilders 注入。
 *   1) 全程序化几何（球 / 胶囊 / 环 / 锥 / 柱 / 盒 / 挤出片），无外部贴图；
 *   2) 脚底 y = 0、正面朝 -Z（finishModel 统一降地并量高）；
 *   3) 动画节点名只用 [a-z0-9_]；update 里做呼吸 / 摆尾 / 振翅 / 雾摆 / 鳞光；
 *   4) 高度与半径按 docs/MYTHOLOGY.md 第 3 节，形体尽量贴合。
 * ==========================================================================*/
(() => { const PG = window.PG = window.PG || {}; const M = PG.models; if (!M || !M._dsl) return; const D = M._dsl;
  const {
    Builder, SPH, SPH_HI, CONE, CYL, BOX, HEMI, TORUS, CAPSULE, ICO,
    leafGeo, boltGeo, scytheGeo, capChain, addEye, addEyes, addSmile, addOpenMouth,
    addFangs, addTeethRow, addCheeks, addClaws, addFoot, finishModel, quatY, TAU, PI,
  } = D;

  // =========================================================================
  // 公共小工具
  // =========================================================================

  // 呼吸：整体沿 Y 轻微起伏（优先用 finishModel 包好的 inner 组）
  function breathe(nodes, t, amp) {
    const n = nodes.inner || nodes.root;
    if (n) n.scale.y = 1 + Math.sin(t * 1.9) * (amp == null ? 0.012 : amp);
  }

  // 发光眼（成对）：鬼魅 / 精怪 / 混沌用
  function glowEyes(B, node, o) {
    const r = o.r == null ? 0.03 : o.r;
    const spread = o.spread == null ? 0.055 : o.spread;
    const col = o.color == null ? 0x7af0d0 : o.color;
    for (let s = -1; s <= 1; s += 2) {
      B.put(node, SPH(), col, {
        x: (o.x || 0) + s * spread, y: o.y || 0, z: o.z == null ? -0.09 : o.z,
        sx: r, sy: r * (o.sy == null ? 1.15 : o.sy), sz: r * 0.6,
        glow: col, glowInt: o.glowInt == null ? 1.9 : o.glowInt,
      });
    }
  }

  // 一排尖刺（鬃毛 / 背脊 / 冠羽）：沿 X 排开，可按 tilt 扇形张开
  function spikeFan(B, node, o) {
    const n = o.n == null ? 3 : o.n;
    const gap = o.gap == null ? 0.05 : o.gap;
    for (let i = 0; i < n; i++) {
      const k = i - (n - 1) / 2;
      B.put(node, CONE(), o.color == null ? 0xf0e6d2 : o.color, {
        x: (o.x || 0) + k * gap, y: (o.y || 0) + k * k * (o.arc || 0), z: o.z || 0,
        sx: o.w || 0.02, sy: o.h || 0.09, sz: (o.w || 0.02) * 0.72,
        rx: (o.rx || 0) + k * (o.rxTilt || 0), ry: o.ry || 0,
        rz: (o.rz || 0) + k * (o.tilt || 0),
        shine: true,
      });
    }
  }

  // 绕 Y 轴的环带（金环纹 / 混沌赤光 / 树纹）
  function ringBand(B, node, o) {
    B.put(node, TORUS(o.R == null ? 1 : o.R, o.tube == null ? 0.05 : o.tube, TAU), o.color, {
      x: o.x || 0, y: o.y || 0, z: o.z || 0, rx: PI / 2,
      sx: o.sx == null ? 1 : o.sx, sy: o.sy == null ? 1 : o.sy, sz: o.sz == null ? 1 : o.sz,
      glow: o.glow, glowInt: o.glowInt, glass: o.glass, shine: o.shine,
    });
  }

  // =========================================================================
  // 1) 鹿蜀 — 马形白身、虎纹、赤尾、长耳（h 0.66 / r 0.32）
  // =========================================================================
  function buildLushu() {
    const B = Builder();
    const CREAM = 0xe8e2d2, CREAM_D = 0xd6ccb4, STRIPE = 0x9a6a35;
    const RED = 0xd0432e, HOOF = 0x6a4a32;

    // 四条细腿 + 小蹄
    const LEGS = [[-0.10, -0.12], [0.10, -0.12], [-0.10, 0.13], [0.10, 0.13]];
    for (let i = 0; i < LEGS.length; i++) {
      const lx = LEGS[i][0], lz = LEGS[i][1];
      B.put('root', CAPSULE(0.026, 0.075), CREAM_D, { x: lx, y: 0.105, z: lz });
      B.put('root', CAPSULE(0.031, 0.075), CREAM, { x: lx, y: 0.20, z: lz });
      B.put('root', SPH(), HOOF, { x: lx, y: 0.038, z: lz - 0.006, sx: 0.038, sy: 0.036, sz: 0.046 });
    }

    // 躯干：米白马身 + 深赭虎纹（绕身体一圈的环带）
    B.put('root', SPH_HI(), CREAM, { y: 0.375, sx: 0.152, sy: 0.132, sz: 0.205 });
    B.put('root', SPH(), CREAM_D, { y: 0.316, z: -0.02, sx: 0.115, sy: 0.082, sz: 0.18 });
    for (let i = 0; i < 6; i++) {
      const zc = -0.135 + i * 0.062;
      const k = 1.030 * Math.sqrt(Math.max(0.10, 1 - (zc / 0.205) * (zc / 0.205)));
      B.put('root', TORUS(1, 0.024, TAU), STRIPE, { y: 0.375, z: zc, sx: 0.152 * k, sy: 0.132 * k, sz: 1 });
    }
    // 颈 + 头
    capChain(B, 'root', [[0, 0.44, -0.08], [0, 0.478, -0.14], [0, 0.516, -0.18]], [0.075, 0.062, 0.052], CREAM);
    B.node('head', 'root', 0, 0.525, -0.19);
    B.put('head', SPH_HI(), CREAM, { y: 0.02, sx: 0.078, sy: 0.075, sz: 0.092 });
    B.put('head', SPH(), CREAM_D, { y: -0.028, z: -0.062, sx: 0.052, sy: 0.048, sz: 0.055 });
    B.put('head', SPH(), 0x4a3226, { y: -0.012, z: -0.114, sx: 0.014, sy: 0.012, sz: 0.012 });
    addEyes(B, 'head', { y: 0.035, z: -0.062, spread: 0.05, r: 0.027, style: 'full', white: 0xfffdf4, iris: 0x8a5a32, pupil: 0x241c16, wz: 0.55 });
    B.put('head', SPH(), STRIPE, { y: 0.072, z: -0.052, sx: 0.03, sy: 0.016, sz: 0.02, rx: 0.3 });
    // 长耳（动画节点）
    const earL = B.node('ear_l', 'head', -0.042, 0.058, 0.008);
    const earR = B.node('ear_r', 'head', 0.042, 0.058, 0.008);
    earL.rotation.z = 0.22; earR.rotation.z = -0.22;
    for (let s = -1; s <= 1; s += 2) {
      const nm = s < 0 ? 'ear_l' : 'ear_r';
      B.put(nm, CONE(), CREAM, { y: 0.044, sx: 0.021, sy: 0.088, sz: 0.014, rz: s * 0.10 });
      B.put(nm, CONE(), RED, { y: 0.038, z: -0.009, sx: 0.011, sy: 0.062, sz: 0.008, rz: s * 0.10 });
    }
    // 赤尾（动画节点）：三片红尾羽 + 米白尾根
    B.node('tail', 'root', 0, 0.40, 0.175);
    B.put('tail', SPH(), CREAM, { y: 0.005, sx: 0.045, sy: 0.045, sz: 0.04 });
    B.put('tail', leafGeo(0.055, 0.13, 0.02), RED, { y: 0.01, z: 0.012, rx: 0.85 });
    B.put('tail', leafGeo(0.048, 0.12, 0.018), RED, { x: 0.028, y: 0.005, z: 0.01, rx: 0.9, rz: -0.28 });
    B.put('tail', leafGeo(0.048, 0.12, 0.018), RED, { x: -0.028, y: 0.005, z: 0.01, rx: 0.9, rz: 0.28 });

    return finishModel(B, function (nodes, dt, t) {
      breathe(nodes, t, 0.014);
      nodes.head.rotation.x = Math.sin(t * 1.55) * 0.06;
      nodes.head.rotation.z = Math.sin(t * 0.85) * 0.04;
      nodes.ear_l.rotation.z = 0.22 + Math.sin(t * 2.4) * 0.10;
      nodes.ear_r.rotation.z = -0.22 - Math.sin(t * 2.4 + 0.5) * 0.10;
      nodes.tail.rotation.y = Math.sin(t * 1.35) * 0.16;
      nodes.tail.rotation.z = Math.sin(t * 1.05 + 0.4) * 0.12;
    }, { fitH: 0.66 });
  }

  // =========================================================================
  // 2) 蜈蚣精 — 多节蜈蚣、百足、毒颚、触须（h 0.66 / r 0.30）
  // =========================================================================
  function buildWugong() {
    const B = Builder();
    const BROWN = 0x5a3a2a, OCHRE = 0xb8743a, VENOM = 0x9bd44a, DARK = 0x34231a;

    const SEG = [
      ['seg1', 0.230, -0.140, 0.080],
      ['seg2', 0.212, -0.062, 0.078],
      ['seg3', 0.198, 0.014, 0.075],
      ['seg4', 0.190, 0.090, 0.072],
      ['seg5', 0.186, 0.166, 0.068],
      ['seg6', 0.192, 0.242, 0.062],
    ];
    for (let i = 0; i < SEG.length; i++) {
      const s = SEG[i], nm = s[0], sy0 = s[1], z0 = s[2], rad = s[3];
      B.node(nm, 'root', 0, sy0, z0);
      B.put(nm, SPH(), i % 2 ? OCHRE : BROWN, { sx: 0.078 - i * 0.003, sy: rad, sz: 0.052 });
      // 背甲 + 毒绿脊点（鳞光）
      B.put(nm, SPH(), DARK, { y: rad * 0.52, sx: 0.062 - i * 0.002, sy: 0.016, sz: 0.042 });
      B.put(nm, SPH(), VENOM, { y: rad * 0.9, sx: 0.017, sy: 0.014, sz: 0.017, glow: VENOM, glowInt: 0.7 });
      // 每节三对足（step 2 只做左右各一，共六足感）
      for (let k = -1; k <= 1; k += 2) {
        const legLen = Math.max(0.05, sy0 - 0.04);
        const legCy = 0.008 - sy0 / 2;
        B.put(nm, CAPSULE(0.011, legLen), DARK, { x: k * 0.058, y: legCy, z: 0, rz: k * 0.34 });
        B.put(nm, CONE(), DARK, { x: k * 0.082, y: legCy - legLen / 2 - 0.006, z: 0.012, sx: 0.008, sy: 0.032, sz: 0.008, rx: PI, rz: k * 0.2 });
      }
    }
    // 头（抬起） + 毒颚 + 触须
    B.node('head', 'root', 0, 0.320, -0.205);
    B.put('head', SPH_HI(), OCHRE, { sx: 0.095, sy: 0.085, sz: 0.092 });
    B.put('head', SPH(), BROWN, { y: 0.040, z: 0.008, sx: 0.082, sy: 0.030, sz: 0.078 });
    glowEyes(B, 'head', { y: 0.022, z: -0.070, spread: 0.050, r: 0.020, color: VENOM, glowInt: 1.6 });
    // 毒颚（下颚动画节点，左右开合）
    B.node('jaw', 'head', 0, -0.040, -0.030);
    for (let s = -1; s <= 1; s += 2) {
      B.put('jaw', CONE(), VENOM, { x: s * 0.028, y: -0.018, z: -0.030, sx: 0.014, sy: 0.085, sz: 0.012, rx: -2.15, rz: s * 0.18, shine: true });
    }
    // 两根触须（动画节点）
    const feelL = B.node('feel_l', 'head', -0.048, 0.058, -0.012);
    const feelR = B.node('feel_r', 'head', 0.048, 0.058, -0.012);
    for (let s = -1; s <= 1; s += 2) {
      const nm = s < 0 ? 'feel_l' : 'feel_r';
      capChain(B, nm, [[0, 0, 0], [s * 0.030, 0.130, -0.050], [s * 0.060, 0.270, -0.100]], [0.011, 0.009, 0.006], BROWN);
      B.put(nm, SPH(), VENOM, { x: s * 0.060, y: 0.272, z: -0.100, sx: 0.014, sy: 0.014, sz: 0.014, glow: VENOM, glowInt: 1.0 });
    }
    // 尾节尖刺
    B.put('seg6', CONE(), OCHRE, { y: 0.02, z: 0.040, sx: 0.02, sy: 0.075, sz: 0.02, rx: 1.25, shine: true });

    return finishModel(B, function (nodes, dt, t) {
      for (let i = 0; i < SEG.length; i++) {
        const n = nodes[SEG[i][0]];
        n.position.y = SEG[i][1] + Math.sin(t * 4.8 - i * 0.85) * 0.010;
        n.rotation.y = Math.sin(t * 4.0 - i * 0.7) * 0.05;
      }
      nodes.head.rotation.x = -0.05 + Math.sin(t * 2.2) * 0.06;
      nodes.head.rotation.z = Math.sin(t * 1.4) * 0.05;
      nodes.feel_l.rotation.z = 0.08 + Math.sin(t * 3.1) * 0.15;
      nodes.feel_r.rotation.z = -0.08 - Math.sin(t * 3.1 + 0.6) * 0.15;
      nodes.jaw.rotation.x = -0.05 - Math.sin(t * 3.4) * 0.14;
    }, { fitH: 0.66 });
  }

  // =========================================================================
  // 3) 鸩鸟 — 毒羽鸟、金喙、赤目、长尾羽（h 0.62 / r 0.30）
  // =========================================================================
  function buildZhen() {
    const B = Builder();
    const PURPLE = 0x8a5fbf, DARK = 0x4a2f6a, PLUME = 0x6a4f8a;
    const GOLD = 0xe8b33a, RED = 0xe8453c, LEG = 0x9a7a3a;

    // 细腿 + 趾
    for (let s = -1; s <= 1; s += 2) {
      B.put('root', CAPSULE(0.013, 0.11), LEG, { x: s * 0.06, y: 0.085, z: 0.0 });
      addClaws(B, 'root', { x: s * 0.06, y: 0.020, z: -0.030, r: 0.009, len: 0.030, spread: 0.016, color: LEG });
      addClaws(B, 'root', { x: s * 0.06, y: 0.020, z: 0.028, r: 0.007, len: 0.024, spread: 0.014, color: LEG, rx: PI / 2 });
    }
    // 身体 + 胸羽
    B.put('root', SPH_HI(), PURPLE, { y: 0.275, sx: 0.132, sy: 0.150, sz: 0.140 });
    B.put('root', SPH(), PLUME, { y: 0.300, z: 0.030, sx: 0.155, sy: 0.160, sz: 0.120 });
    B.put('root', SPH(), 0xb39ae0, { y: 0.252, z: -0.092, sx: 0.082, sy: 0.105, sz: 0.055 });
    spikeFan(B, 'root', { x: 0, y: 0.345, z: 0.075, n: 3, gap: 0.055, w: 0.030, h: 0.12, rx: 0.85, tilt: 0.35, color: DARK });

    // 头（动画节点）
    B.node('head', 'root', 0, 0.442, -0.030);
    B.put('head', SPH_HI(), PURPLE, { sx: 0.112, sy: 0.098, sz: 0.104 });
    // 金喙（朝 -Z）
    B.put('head', CONE(), GOLD, { y: -0.018, z: -0.100, sx: 0.040, sy: 0.105, sz: 0.036, rx: -PI / 2, shine: true });
    B.put('head', CONE(), 0xc99a2a, { y: -0.048, z: -0.082, sx: 0.026, sy: 0.062, sz: 0.024, rx: -PI / 2 + 0.30 });
    // 赤目
    addEyes(B, 'head', { y: 0.020, z: -0.072, spread: 0.060, r: 0.026, style: 'full', white: 0xfff2ee, iris: RED, pupil: 0x2a0f14, wz: 0.55 });
    B.put('head', SPH(), DARK, { y: 0.052, z: -0.058, sx: 0.078, sy: 0.012, sz: 0.024, rz: -0.12 });
    // 毒羽冠（三片，向后上方）
    for (let i = 0; i < 3; i++) {
      B.put('head', leafGeo(0.026, 0.105 - i * 0.012, 0.012), i === 1 ? DARK : PLUME, {
        x: (i - 1) * 0.038, y: 0.072, z: 0.010, rx: -0.30 - i * 0.06, rz: (i - 1) * 0.22,
      });
    }
    // 双翼（动画节点）
    const wingL = B.node('wing_l', 'root', -0.125, 0.335, 0.020);
    const wingR = B.node('wing_r', 'root', 0.125, 0.335, 0.020);
    wingL.rotation.z = 0.45; wingR.rotation.z = -0.45;
    for (let s = -1; s <= 1; s += 2) {
      const nm = s < 0 ? 'wing_l' : 'wing_r';
      for (let i = 0; i < 3; i++) {
        B.put(nm, leafGeo(0.058 - i * 0.010, 0.170 - i * 0.026, 0.012), i === 0 ? DARK : PLUME, {
          x: s * (0.010 + i * 0.020), y: 0.015 - i * 0.012, z: 0.010 + i * 0.012,
          rz: -s * (1.12 + i * 0.14), rx: -0.22 - i * 0.10,
        });
      }
    }
    // 长尾羽（动画节点）
    B.node('tail', 'root', 0, 0.235, 0.120);
    for (let i = 0; i < 3; i++) {
      B.put('tail', leafGeo(0.034, 0.150 - i * 0.020, 0.012), i === 0 ? DARK : PLUME, {
        x: (i - 1) * 0.026, y: 0.005, z: 0.010, rx: 1.50 - i * 0.10, rz: (i - 1) * 0.26,
      });
    }
    B.put('tail', SPH(), RED, { y: 0.040, z: 0.145, sx: 0.018, sy: 0.014, sz: 0.020, glow: RED, glowInt: 0.9 });

    return finishModel(B, function (nodes, dt, t) {
      breathe(nodes, t, 0.011);
      nodes.head.rotation.x = Math.sin(t * 1.7) * 0.06;
      nodes.head.rotation.y = Math.sin(t * 0.9 + 0.4) * 0.12;
      const flap = Math.sin(t * 9.0) * 0.20;
      nodes.wing_l.rotation.z = 0.45 + flap;
      nodes.wing_r.rotation.z = -0.45 - flap;
      nodes.wing_l.rotation.x = Math.sin(t * 9.0 + 0.4) * 0.08;
      nodes.wing_r.rotation.x = Math.sin(t * 9.0 + 0.4) * 0.08;
      nodes.tail.rotation.x = Math.sin(t * 1.3) * 0.10;
      nodes.tail.rotation.y = Math.sin(t * 1.05) * 0.14;
    }, { fitH: 0.62 });
  }

  // =========================================================================
  // 4) 木魅 — 树桩妖、苔绿树冠、树皮脸、根须手（h 0.62 / r 0.30）
  // =========================================================================
  function buildMumei() {
    const B = Builder();
    const BARK = 0x6a4a2e, BARKD = 0x4a3220, MOSS = 0x7ec850, MOSSD = 0x4e8a32;
    const EYE = 0xffd66a;

    // 树桩主干 + 顶面
    B.put('root', CYL(), BARK, { y: 0.170, sx: 0.163, sy: 0.340, sz: 0.152 });
    B.put('root', SPH(), BARKD, { y: 0.338, sx: 0.166, sy: 0.045, sz: 0.155 });
    // 树皮纵纹
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * TAU;
      B.put('root', BOX(), BARKD, { x: Math.cos(a) * 0.160, y: 0.165, z: Math.sin(a) * 0.149, sx: 0.014, sy: 0.29, sz: 0.014, ry: -a });
    }
    // 板根（四条）
    for (let i = 0; i < 4; i++) {
      const a = i * PI / 2 + PI / 4;
      B.put('root', CONE(), BARKD, {
        x: Math.cos(a) * 0.135, y: 0.060, z: Math.sin(a) * 0.128,
        sx: 0.045, sy: 0.150, sz: 0.045, rx: -0.45, ry: -a,
      });
    }
    // 树皮脸：眉骨 / 眼窝 / 嘴
    B.put('root', SPH(), BARK, { y: 0.285, z: -0.130, sx: 0.155, sy: 0.115, sz: 0.045 });
    glowEyes(B, 'root', { y: 0.275, z: -0.160, spread: 0.052, r: 0.022, color: EYE, glowInt: 1.5 });
    B.put('root', BOX(), BARKD, { x: 0.052, y: 0.322, z: -0.160, sx: 0.062, sy: 0.018, sz: 0.022, rz: -0.18 });
    B.put('root', BOX(), BARKD, { x: -0.052, y: 0.322, z: -0.160, sx: 0.062, sy: 0.018, sz: 0.022, rz: 0.18 });
    addOpenMouth(B, 'root', { y: 0.205, z: -0.150, w: 0.048, h: 0.032, color: 0x180f08 });
    // 苔绿树冠（动画节点）
    B.node('crown', 'root', 0, 0.345, 0);
    B.put('crown', SPH(), MOSS, { y: 0.085, sx: 0.150, sy: 0.095, sz: 0.140 });
    B.put('crown', SPH(), MOSSD, { x: 0.105, y: 0.050, z: 0.045, sx: 0.075, sy: 0.065, sz: 0.070 });
    B.put('crown', SPH(), MOSSD, { x: -0.100, y: 0.062, z: -0.030, sx: 0.065, sy: 0.058, sz: 0.062 });
    for (let i = 0; i < 5; i++) {
      const a = -0.9 + i * 0.45;
      B.put('crown', leafGeo(0.030, 0.105 + (i % 2) * 0.030, 0.012), i % 2 ? MOSS : MOSSD, {
        x: Math.sin(a) * 0.075, y: 0.135, z: Math.cos(a) * 0.045, rx: -0.35 + i * 0.06, rz: -a * 0.55,
      });
    }
    // 根须手（两条动画节点）
    for (let s = -1; s <= 1; s += 2) {
      const nm = s < 0 ? 'arm_l' : 'arm_r';
      B.node(nm, 'root', s * 0.145, 0.235, -0.030);
      capChain(B, nm, [[0, 0, 0], [s * 0.025, -0.040, -0.095], [s * 0.050, -0.095, -0.205]], [0.038, 0.030, 0.020], BARK);
      B.put(nm, CONE(), BARKD, { x: s * 0.050, y: -0.097, z: -0.258, sx: 0.012, sy: 0.060, sz: 0.012, rx: -PI / 2 + 0.18, rz: s * 0.2 });
      B.put(nm, CONE(), BARKD, { x: s * 0.074, y: -0.095, z: -0.245, sx: 0.010, sy: 0.050, sz: 0.010, rx: -PI / 2 + 0.25, rz: s * 0.5 });
      B.put(nm, CONE(), BARKD, { x: s * 0.028, y: -0.105, z: -0.250, sx: 0.010, sy: 0.050, sz: 0.010, rx: -PI / 2 + 0.10, rz: -s * 0.15 });
    }

    return finishModel(B, function (nodes, dt, t) {
      breathe(nodes, t, 0.009);
      nodes.crown.rotation.z = Math.sin(t * 1.15) * 0.055;
      nodes.crown.rotation.x = Math.sin(t * 0.9 + 0.6) * 0.040;
      nodes.arm_l.rotation.x = Math.sin(t * 1.6) * 0.10;
      nodes.arm_r.rotation.x = Math.sin(t * 1.6 + 0.9) * 0.10;
      nodes.arm_l.rotation.z = Math.sin(t * 1.2 + 0.3) * 0.06;
      nodes.arm_r.rotation.z = -Math.sin(t * 1.2 + 0.3) * 0.06;
    }, { fitH: 0.62 });
  }

  // =========================================================================
  // 5) 玄蜂 — 玄黑巨蜂、金环纹、毒针、灰蓝薄翅（h 1.15 / r 0.45）
  // =========================================================================
  function buildXuanfeng() {
    const B = Builder();
    const BLACK = 0x2b2b36, DARK = 0x1a1a22, GOLD = 0xe8b33a, WING = 0x9fb6e0;

    // 六足（三对，细长下垂点地）
    const LEGS = [[-0.075, -0.10], [0.075, -0.10], [-0.085, 0.02], [0.085, 0.02], [-0.070, 0.14], [0.070, 0.14]];
    for (let i = 0; i < LEGS.length; i++) {
      const lx = LEGS[i][0], lz = LEGS[i][1];
      const s = lx > 0 ? 1 : -1;
      B.put('root', CAPSULE(0.020, 0.16), BLACK, { x: lx * 1.25, y: 0.560, z: lz, rz: s * 0.55 });
      B.put('root', CAPSULE(0.015, 0.40), DARK, { x: lx * 2.05, y: 0.235, z: lz - 0.012, rz: s * 0.10 });
      B.put('root', SPH(), DARK, { x: lx * 2.25, y: 0.020, z: lz - 0.030, sx: 0.026, sy: 0.018, sz: 0.040 });
    }
    // 腹部（动画节点）：玄黑 + 三道金环 + 毒针
    B.node('abdomen', 'root', 0, 0.545, 0.150);
    B.put('abdomen', SPH_HI(), BLACK, { sx: 0.150, sy: 0.168, sz: 0.215 });
    for (let i = 0; i < 3; i++) {
      const zc = -0.075 + i * 0.075;
      const k = Math.sqrt(Math.max(0.10, 1 - (zc / 0.215) * (zc / 0.215)));
      B.put('abdomen', SPH(), GOLD, { z: zc, sx: 0.150 * k + 0.004, sy: 0.168 * k + 0.004, sz: 0.016, shine: true });
    }
    B.put('abdomen', CONE(), GOLD, { y: -0.010, z: 0.235, sx: 0.030, sy: 0.150, sz: 0.030, rx: PI / 2 + 0.10, shine: true });
    // 胸（玄黑 + 金领环）
    B.put('root', SPH_HI(), BLACK, { y: 0.730, sx: 0.180, sy: 0.185, sz: 0.165 });
    ringBand(B, 'root', { y: 0.845, R: 1, tube: 0.055, sx: 0.135, sy: 0.125, color: GOLD, shine: true });
    B.put('root', SPH(), GOLD, { y: 0.700, z: -0.130, sx: 0.075, sy: 0.085, sz: 0.030, shine: true });
    // 头（动画节点）
    B.node('head', 'root', 0, 0.925, -0.055);
    B.put('head', SPH_HI(), BLACK, { sx: 0.135, sy: 0.122, sz: 0.120 });
    for (let s = -1; s <= 1; s += 2) {
      B.put('head', SPH(), GOLD, { x: s * 0.086, y: 0.018, z: -0.052, sx: 0.062, sy: 0.075, sz: 0.048, glow: GOLD, glowInt: 1.2, shine: true });
      B.put('head', CONE(), DARK, { x: s * 0.030, y: -0.075, z: -0.088, sx: 0.016, sy: 0.070, sz: 0.014, rx: -2.30, rz: s * 0.20 });
    }
    // 触角（动画节点）
    for (let s = -1; s <= 1; s += 2) {
      const nm = s < 0 ? 'ant_l' : 'ant_r';
      B.node(nm, 'head', s * 0.045, 0.088, -0.012);
      capChain(B, nm, [[0, 0, 0], [s * 0.020, 0.080, -0.030], [s * 0.035, 0.150, -0.060]], [0.010, 0.008, 0.006], DARK);
      B.put(nm, SPH(), GOLD, { x: s * 0.035, y: 0.152, z: -0.060, sx: 0.010, sy: 0.010, sz: 0.010, shine: true });
    }
    // 四片灰蓝薄翅（两个动画节点，每边两片）
    const wingL = B.node('wing_l', 'root', -0.145, 0.790, 0.030);
    const wingR = B.node('wing_r', 'root', 0.145, 0.790, 0.030);
    wingL.rotation.z = 0.30; wingR.rotation.z = -0.30;
    for (let s = -1; s <= 1; s += 2) {
      const nm = s < 0 ? 'wing_l' : 'wing_r';
      B.put(nm, leafGeo(0.130, 0.300, 0.006), WING, { x: s * 0.010, y: 0.020, z: 0.020, rz: -s * 1.12, rx: -0.30, glass: 0.78 });
      B.put(nm, leafGeo(0.100, 0.215, 0.006), WING, { x: s * 0.010, y: -0.030, z: 0.060, rz: -s * 0.92, rx: -0.22, glass: 0.66 });
      B.put(nm, leafGeo(0.018, 0.300, 0.004), GOLD, { x: s * 0.010, y: 0.020, z: 0.026, rz: -s * 1.12, rx: -0.30, glass: 0.9, shine: true });
    }

    return finishModel(B, function (nodes, dt, t) {
      const n = nodes.inner || nodes.root;
      if (n) n.position.y = (Math.sin(t * 5.0) * 0.5 + 0.5) * 0.030;
      nodes.head.rotation.x = Math.sin(t * 2.2) * 0.05;
      nodes.head.rotation.y = Math.sin(t * 1.1) * 0.10;
      nodes.abdomen.rotation.x = Math.sin(t * 2.6) * 0.07;
      nodes.abdomen.rotation.z = Math.sin(t * 1.9 + 0.4) * 0.05;
      nodes.ant_l.rotation.z = 0.08 + Math.sin(t * 3.4) * 0.12;
      nodes.ant_r.rotation.z = -0.08 - Math.sin(t * 3.4 + 0.7) * 0.12;
      nodes.wing_l.rotation.z = 0.30 + Math.sin(t * 38) * 0.16;
      nodes.wing_r.rotation.z = -0.30 - Math.sin(t * 38) * 0.16;
      nodes.wing_l.rotation.x = Math.sin(t * 33 + 0.5) * 0.07;
      nodes.wing_r.rotation.x = Math.sin(t * 33 + 0.5) * 0.07;
    }, { fitH: 1.15 });
  }

  // =========================================================================
  // 6) 狰 — 赤豹、独角、五尾、獠牙、骨白鬃毛（h 1.35 / r 0.42）
  // =========================================================================
  function buildZheng() {
    const B = Builder();
    const RUST = 0xc2452e, RUST_D = 0x8f2f1e, BONE = 0xf0e6d2, DARK = 0x4a1a12;

    // 四条强壮兽腿 + 骨白利爪
    const LEGS = [[-0.165, -0.175], [0.165, -0.175], [-0.170, 0.190], [0.170, 0.190]];
    for (let i = 0; i < LEGS.length; i++) {
      const lx = LEGS[i][0], lz = LEGS[i][1];
      B.put('root', CAPSULE(0.062, 0.26), RUST, { x: lx, y: 0.500, z: lz, rz: lx > 0 ? -0.06 : 0.06 });
      B.put('root', CAPSULE(0.046, 0.26), RUST_D, { x: lx, y: 0.225, z: lz - 0.014, rz: lx > 0 ? -0.04 : 0.04 });
      B.put('root', SPH(), RUST_D, { x: lx, y: 0.052, z: lz - 0.030, sx: 0.070, sy: 0.052, sz: 0.105 });
      addClaws(B, 'root', { x: lx, y: 0.040, z: lz - 0.125, r: 0.014, len: 0.040, spread: 0.022, color: BONE });
    }
    // 躯干 + 肩臀
    B.put('root', SPH_HI(), RUST, { y: 0.720, sx: 0.235, sy: 0.225, sz: 0.275 });
    B.put('root', SPH(), RUST, { y: 0.760, z: -0.180, sx: 0.190, sy: 0.190, sz: 0.150 });
    B.put('root', SPH(), RUST, { y: 0.745, z: 0.175, sx: 0.195, sy: 0.200, sz: 0.160 });
    B.put('root', SPH(), 0xd9764f, { y: 0.660, z: -0.060, sx: 0.130, sy: 0.100, sz: 0.220 });
    // 背部深色脊纹
    for (let i = 0; i < 4; i++) {
      B.put('root', SPH(), RUST_D, { y: 0.905 - i * 0.010, z: -0.120 + i * 0.075, sx: 0.030, sy: 0.014, sz: 0.032 });
    }
    // 颈
    capChain(B, 'root', [[0, 0.850, -0.170], [0, 0.950, -0.225], [0, 1.020, -0.255]], [0.130, 0.115, 0.100], RUST);
    // 骨白鬃毛（环颈一圈的尖刺）
    for (let i = 0; i < 9; i++) {
      const a = -PI * 0.85 + (i / 8) * PI * 1.7;
      B.put('root', CONE(), BONE, {
        x: Math.sin(a) * 0.150, y: 0.965 + Math.cos(a) * 0.045, z: -0.190 + Math.cos(a) * 0.105,
        sx: 0.030, sy: 0.135, sz: 0.024, rx: Math.cos(a) * 0.9, rz: -Math.sin(a) * 0.9, shine: true,
      });
    }
    // 头（动画节点）
    B.node('head', 'root', 0, 1.080, -0.265);
    B.put('head', SPH_HI(), RUST, { sx: 0.165, sy: 0.145, sz: 0.132 });
    B.put('head', SPH(), RUST_D, { y: -0.045, z: -0.100, sx: 0.105, sy: 0.080, sz: 0.060 });
    // 獠牙 + 张口
    addOpenMouth(B, 'head', { y: -0.062, z: -0.128, w: 0.062, h: 0.045, color: DARK, tongue: 0xd04a5a });
    addFangs(B, 'head', { n: 2, gap: 0.055, y: -0.045, z: -0.140, w: 0.018, h: 0.055, color: BONE });
    addFangs(B, 'head', { n: 2, gap: 0.040, y: -0.098, z: -0.126, w: 0.012, h: 0.030, color: BONE });
    // 金瞳
    addEyes(B, 'head', { y: 0.048, z: -0.100, spread: 0.076, r: 0.040, style: 'full', white: 0xfff6d8, iris: 0xffc933, pupil: 0x2a1408, wz: 0.60 });
    B.put('head', SPH(), RUST_D, { y: 0.088, z: -0.092, sx: 0.092, sy: 0.020, sz: 0.030, rz: -0.10 });
    B.put('head', SPH(), RUST_D, { y: 0.088, z: -0.092, sx: 0.092, sy: 0.020, sz: 0.030, rz: 0.10 });
    // 独角（额前一枝）
    B.put('head', CONE(), BONE, { y: 0.140, z: -0.020, sx: 0.045, sy: 0.260, sz: 0.040, rx: -0.16, shine: true });
    B.put('head', CONE(), BONE, { y: 0.240, z: -0.055, sx: 0.026, sy: 0.130, sz: 0.024, rx: -0.30, shine: true });
    // 耳
    for (let s = -1; s <= 1; s += 2) {
      B.put('head', SPH(), RUST, { x: s * 0.125, y: 0.100, z: 0.020, sx: 0.046, sy: 0.058, sz: 0.032, rz: s * 0.30 });
      B.put('head', SPH(), DARK, { x: s * 0.140, y: 0.105, z: 0.014, sx: 0.022, sy: 0.030, sz: 0.016, rz: s * 0.30 });
    }
    // 五条尾巴（动画节点，扇形）
    for (let i = 0; i < 5; i++) {
      const k = i - 2;
      const nm = 'tail_' + (i + 1);
      const n = B.node(nm, 'root', k * 0.055, 0.820, 0.270);
      n.rotation.y = k * 0.22;
      n.rotation.z = -k * 0.06;
      capChain(B, nm, [[0, 0, 0], [0, 0.090, 0.060], [0, 0.165, 0.095]], [0.040, 0.030, 0.020], RUST);
      B.put(nm, CONE(), BONE, { y: 0.205, z: 0.105, sx: 0.025, sy: 0.075, sz: 0.020, rx: 1.15, shine: true });
    }

    return finishModel(B, function (nodes, dt, t) {
      breathe(nodes, t, 0.011);
      nodes.head.rotation.x = Math.sin(t * 1.4) * 0.05;
      nodes.head.rotation.y = Math.sin(t * 0.8) * 0.10;
      for (let i = 0; i < 5; i++) {
        const n = nodes['tail_' + (i + 1)];
        const k = i - 2;
        n.rotation.y = k * 0.22 + Math.sin(t * 1.6 + i * 0.5) * 0.10;
        n.rotation.x = Math.sin(t * 1.2 + i * 0.7) * 0.09;
        n.rotation.z = -k * 0.06 + Math.sin(t * 1.05 + i * 0.4) * 0.05;
      }
    }, { fitH: 1.35 });
  }

  // =========================================================================
  // 7) 九尾狐 — 白狐、九条飘尾、金瞳、额间朱纹（h 0.92 / r 0.34）
  // =========================================================================
  function buildJiuwei() {
    const B = Builder();
    const WHITE = 0xf4f1e8, WHITE_D = 0xd9d2c0, RED = 0xe8453c, PINK = 0xf08bb4, DARK = 0x33241e;

    // 四条细狐腿 + 爪
    const LEGS = [[-0.085, -0.105], [0.085, -0.105], [-0.090, 0.115], [0.090, 0.115]];
    for (let i = 0; i < LEGS.length; i++) {
      const lx = LEGS[i][0], lz = LEGS[i][1];
      B.put('root', CAPSULE(0.030, 0.150), WHITE, { x: lx, y: 0.155, z: lz });
      B.put('root', CAPSULE(0.024, 0.09), WHITE_D, { x: lx, y: 0.055, z: lz });
      B.put('root', SPH(), WHITE, { x: lx, y: 0.028, z: lz - 0.024, sx: 0.036, sy: 0.026, sz: 0.052 });
      addClaws(B, 'root', { x: lx, y: 0.024, z: lz - 0.070, r: 0.008, len: 0.022, spread: 0.013, color: 0xfff6e0 });
    }
    // 躯干
    B.put('root', SPH_HI(), WHITE, { y: 0.400, sx: 0.150, sy: 0.140, sz: 0.215 });
    B.put('root', SPH(), WHITE_D, { y: 0.350, z: -0.020, sx: 0.115, sy: 0.095, sz: 0.190 });
    B.put('root', SPH(), WHITE, { y: 0.450, z: -0.130, sx: 0.115, sy: 0.120, sz: 0.105 });
    // 颈 + 头
    capChain(B, 'root', [[0, 0.480, -0.130], [0, 0.580, -0.155], [0, 0.660, -0.165]], [0.080, 0.068, 0.058], WHITE);
    B.node('head', 'root', 0, 0.700, -0.175);
    B.put('head', SPH_HI(), WHITE, { sx: 0.110, sy: 0.095, sz: 0.105 });
    B.put('head', SPH(), WHITE, { y: -0.040, z: -0.090, sx: 0.062, sy: 0.048, sz: 0.052 });
    B.put('head', SPH(), DARK, { y: -0.032, z: -0.135, sx: 0.014, sy: 0.010, sz: 0.010 });
    addEyes(B, 'head', { y: 0.028, z: -0.076, spread: 0.055, r: 0.028, style: 'full', white: 0xfffdf6, iris: 0xffc933, pupil: 0x2a1a0a, wz: 0.55 });
    // 额间朱纹（菱花）
    B.put('head', SPH(), RED, { y: 0.078, z: -0.070, sx: 0.020, sy: 0.022, sz: 0.012, rz: 0.79 });
    B.put('head', SPH(), RED, { y: 0.078, z: -0.068, sx: 0.014, sy: 0.016, sz: 0.010, rz: -0.79 });
    // 长耳（动画节点）
    const earL = B.node('ear_l', 'head', -0.055, 0.072, 0.010);
    const earR = B.node('ear_r', 'head', 0.055, 0.072, 0.010);
    earL.rotation.z = 0.26; earR.rotation.z = -0.26;
    for (let s = -1; s <= 1; s += 2) {
      const nm = s < 0 ? 'ear_l' : 'ear_r';
      B.put(nm, CONE(), WHITE, { y: 0.060, sx: 0.032, sy: 0.145, sz: 0.018, rz: s * 0.06 });
      B.put(nm, CONE(), PINK, { y: 0.052, z: -0.010, sx: 0.016, sy: 0.100, sz: 0.008, rz: s * 0.06 });
    }
    // 九条飘尾：三组节点（每组三片），组间左右扇开，白底朱尖
    for (let g = 0; g < 3; g++) {
      const nm = ['tail_a', 'tail_b', 'tail_c'][g];
      const n = B.node(nm, 'root', (g - 1) * 0.075, 0.445, 0.195);
      n.rotation.y = (g - 1) * 0.55;
      n.rotation.z = (g - 1) * -0.10;
      B.put(nm, SPH(), WHITE, { y: 0.014, z: 0.004, sx: 0.078, sy: 0.066, sz: 0.058 });
      for (let i = 0; i < 3; i++) {
        const k = i - 1;
        const len = 0.250 - Math.abs(k) * 0.020;
        const rx = 0.22 + Math.abs(k) * 0.34;
        const rz = k * 0.34 + (g - 1) * 0.16;
        B.put(nm, leafGeo(0.100, len, 0.020), i % 2 ? WHITE : WHITE_D, {
          x: k * 0.034, y: 0.012, z: 0.010, rx: rx, rz: rz,
        });
        const tipY = len * Math.cos(rx);
        const tipZ = len * Math.sin(rx);
        B.put(nm, leafGeo(0.070, len * 0.46, 0.016), RED, {
          x: k * 0.034 + Math.sin(rz) * 0.012, y: 0.012 + tipY * 0.56, z: 0.010 + tipZ * 0.56,
          rx: rx, rz: rz,
        });
        B.put(nm, SPH(), RED, { x: k * 0.034 + Math.sin(rz) * 0.040, y: 0.012 + tipY * 0.94, z: 0.010 + tipZ * 0.94, sx: 0.022, sy: 0.022, sz: 0.018 });
      }
    }

    return finishModel(B, function (nodes, dt, t) {
      breathe(nodes, t, 0.011);
      nodes.head.rotation.x = Math.sin(t * 1.5) * 0.05;
      nodes.head.rotation.z = Math.sin(t * 0.9) * 0.04;
      nodes.ear_l.rotation.z = 0.26 + Math.sin(t * 2.2) * 0.09;
      nodes.ear_r.rotation.z = -0.26 - Math.sin(t * 2.2 + 0.6) * 0.09;
      const tails = ['tail_a', 'tail_b', 'tail_c'];
      for (let g = 0; g < 3; g++) {
        const n = nodes[tails[g]];
        n.rotation.y = (g - 1) * 0.42 + Math.sin(t * 1.25 + g * 0.9) * 0.15;
        n.rotation.z = Math.sin(t * 1.05 + g * 1.3) * 0.10;
      }
    }, { fitH: 0.92 });
  }

  // =========================================================================
  // 8) 鲛人 — 人鱼、长发、鳞尾、珠光、张口吟唱（h 0.60 / r 0.28）
  // =========================================================================
  function buildJiaoren() {
    const B = Builder();
    const PALE = 0xcfe8e2, SCALE = 0x4fb9c9, SCALE_D = 0x2f8a9a, PEARL = 0xfffdf5, HAIR = 0x2f6a7a;

    // 鱼尾（人鱼下摆）：锥形鳞尾 + 尾鳍（动画节点）
    capChain(B, 'root', [[0, 0.330, 0.000], [0, 0.240, 0.020], [0, 0.150, 0.060], [0, 0.085, 0.105]], [0.092, 0.080, 0.062, 0.042], SCALE);
    B.node('tail_fin', 'root', 0, 0.085, 0.100);
    B.put('tail_fin', leafGeo(0.125, 0.160, 0.018), SCALE, { y: 0.005, z: 0.010, rx: 1.72 });
    B.put('tail_fin', leafGeo(0.078, 0.120, 0.014), SCALE_D, { y: 0.000, z: 0.016, rx: 1.86 });
    // 腰际鳞带
    ringBand(B, 'root', { y: 0.315, R: 1, tube: 0.022, sx: 0.096, sy: 0.082, color: SCALE_D });
    // 鳞片点缀（前排 + 侧排）
    const TILES = [
      [0.000, 0.298, -0.086], [0.046, 0.286, -0.078], [-0.046, 0.286, -0.078],
      [0.000, 0.224, -0.062], [0.040, 0.214, -0.054], [-0.040, 0.214, -0.054],
      [0.000, 0.164, -0.022], [0.030, 0.155, -0.016], [-0.030, 0.155, -0.016],
    ];
    for (let i = 0; i < TILES.length; i++) {
      const p = TILES[i];
      B.put('root', SPH(), i % 2 ? SCALE_D : SCALE, { x: p[0], y: p[1], z: p[2], sx: 0.017, sy: 0.013, sz: 0.008, shine: true });
    }
    // 上身 + 腰饰
    B.put('root', SPH(), PALE, { y: 0.360, sx: 0.093, sy: 0.115, sz: 0.078 });
    B.put('root', SPH(), SCALE_D, { y: 0.300, z: -0.005, sx: 0.088, sy: 0.030, sz: 0.076 });
    // 双臂 + 合掌吟唱
    for (let s = -1; s <= 1; s += 2) {
      B.put('root', CAPSULE(0.022, 0.075), PALE, { x: s * 0.090, y: 0.395, z: -0.020, rx: -0.55, rz: s * 0.30 });
      B.put('root', CAPSULE(0.019, 0.070), PALE, { x: s * 0.062, y: 0.345, z: -0.075, rx: -1.15, rz: s * 0.55 });
      B.put('root', SPH(), PALE, { x: s * 0.038, y: 0.320, z: -0.108, sx: 0.026, sy: 0.026, sz: 0.024 });
    }
    // 珍珠项圈
    for (let i = 0; i < 5; i++) {
      const a = -0.9 + i * 0.45;
      B.put('root', SPH(), PEARL, { x: Math.sin(a) * 0.075, y: 0.300 - Math.cos(a) * 0.010, z: -0.045 - Math.cos(a) * 0.030, sx: 0.013, sy: 0.013, sz: 0.011, shine: true });
    }
    // 头（动画节点）
    B.node('head', 'root', 0, 0.495, -0.010);
    B.put('head', SPH_HI(), PALE, { sx: 0.098, sy: 0.100, sz: 0.092 });
    // 长发（动画节点）
    for (let s = -1; s <= 1; s += 2) {
      const nm = s < 0 ? 'hair_l' : 'hair_r';
      B.node(nm, 'head', s * 0.062, 0.020, 0.030);
      capChain(B, nm, [[0, 0, 0], [s * 0.025, -0.085, 0.045], [s * 0.045, -0.180, 0.060]], [0.038, 0.030, 0.020], HAIR);
      B.put(nm, leafGeo(0.020, 0.070, 0.010), HAIR, { x: s * 0.048, y: -0.190, z: 0.062, rx: 0.9, rz: s * 0.2 });
    }
    B.put('head', HEMI(), HAIR, { y: 0.022, z: 0.012, sx: 0.090, sy: 0.070, sz: 0.086 });
    B.put('head', SPH(), HAIR, { y: 0.055, z: 0.055, sx: 0.070, sy: 0.055, sz: 0.050 });
    // 人面：眼睛 / 张口吟唱 / 腮红
    addEyes(B, 'head', { y: 0.012, z: -0.070, spread: 0.048, r: 0.028, style: 'full', white: 0xfffdf8, iris: 0x2f6fae, pupil: 0x1d2430, wz: 0.55 });
    addOpenMouth(B, 'head', { y: -0.046, z: -0.082, w: 0.032, h: 0.030, color: 0x8a3a4a, tongue: 0xe8909a });
    addCheeks(B, 'head', { y: -0.020, z: -0.066, spread: 0.070, r: 0.020, color: 0xf0a0a8 });
    // 额心珠饰
    B.put('head', SPH(), PEARL, { y: 0.062, z: -0.058, sx: 0.014, sy: 0.016, sz: 0.010, shine: true });
    // 颈
    B.put('root', CAPSULE(0.032, 0.055), PALE, { y: 0.455, sx: 1, sy: 1, sz: 1 });

    return finishModel(B, function (nodes, dt, t) {
      breathe(nodes, t, 0.010);
      nodes.head.rotation.x = Math.sin(t * 1.3) * 0.05;
      nodes.head.rotation.y = Math.sin(t * 0.9) * 0.12;
      nodes.hair_l.rotation.z = 0.10 + Math.sin(t * 1.5) * 0.10;
      nodes.hair_r.rotation.z = -0.10 - Math.sin(t * 1.5 + 0.5) * 0.10;
      nodes.hair_l.rotation.x = Math.sin(t * 1.15 + 0.3) * 0.07;
      nodes.hair_r.rotation.x = Math.sin(t * 1.15 + 0.8) * 0.07;
      nodes.tail_fin.rotation.y = Math.sin(t * 1.7) * 0.20;
      nodes.tail_fin.rotation.z = Math.sin(t * 1.1) * 0.10;
    }, { fitH: 0.60 });
  }

  // =========================================================================
  // 9) 魑魅 — 无足飘浮精魅、雾状下摆、青光眼、长耳（h 0.85 / r 0.40）
  // =========================================================================
  function buildChimei() {
    const B = Builder();
    const MIST = 0x8a6ac8, MIST_L = 0xb39ae0, DEEP = 0x4c3580, CYAN = 0x7af0d0, DARK = 0x1e1430;

    // 雾状下摆（动画节点）：无足，数团紫雾层层收拢
    B.node('skirt', 'root', 0, 0.440, 0);
    const PUFFS = [
      [0, 0.030, 0, 0.215, 0.120, 0.180, 0.72],
      [0.165, -0.045, 0.030, 0.165, 0.110, 0.150, 0.68],
      [-0.160, -0.040, -0.030, 0.165, 0.110, 0.150, 0.68],
      [0.205, -0.140, 0.060, 0.140, 0.100, 0.130, 0.62],
      [-0.200, -0.130, -0.060, 0.140, 0.100, 0.130, 0.62],
      [0.075, -0.230, 0.050, 0.130, 0.100, 0.120, 0.58],
      [-0.080, -0.225, -0.050, 0.130, 0.100, 0.120, 0.58],
      [0.015, -0.320, 0.020, 0.115, 0.095, 0.105, 0.54],
      [-0.010, -0.355, 0.045, 0.095, 0.085, 0.090, 0.50],
    ];
    for (let i = 0; i < PUFFS.length; i++) {
      const p = PUFFS[i];
      B.put('skirt', SPH(), i % 2 ? MIST : MIST_L, {
        x: p[0], y: p[1], z: p[2], sx: p[3], sy: p[4], sz: p[5], glass: p[6],
      });
    }
    // 雾丝（下摆拖尾，让"飘浮"更明显）
    for (let i = 0; i < 5; i++) {
      const a = i * TAU / 5 + 0.4;
      B.put('skirt', leafGeo(0.030, 0.120, 0.010), i % 2 ? DEEP : MIST, {
        x: Math.cos(a) * 0.085, y: -0.300, z: Math.sin(a) * 0.080, rx: PI, rz: Math.cos(a) * 0.30, glass: 0.42,
      });
    }
    // 上身 + 头
    B.put('root', SPH_HI(), MIST, { y: 0.545, sx: 0.120, sy: 0.140, sz: 0.105, glass: 0.86 });
    B.put('root', SPH(), MIST_L, { y: 0.575, z: -0.050, sx: 0.080, sy: 0.090, sz: 0.056, glass: 0.84 });
    B.put('root', SPH(), MIST, { y: 0.628, sx: 0.064, sy: 0.052, sz: 0.058, glass: 0.9 });
    B.node('head', 'root', 0, 0.700, -0.010);
    B.put('head', SPH_HI(), MIST_L, { sx: 0.115, sy: 0.108, sz: 0.102, glass: 0.88 });
    // 长耳（动画节点，尖长后掠）
    for (let s = -1; s <= 1; s += 2) {
      const nm = s < 0 ? 'ear_l' : 'ear_r';
      B.node(nm, 'head', s * 0.082, 0.050, 0.010);
      B.put(nm, CONE(), MIST, { y: 0.072, sx: 0.026, sy: 0.170, sz: 0.015, rz: s * -0.62, shine: true });
      B.put(nm, CONE(), CYAN, { y: 0.062, z: -0.008, sx: 0.012, sy: 0.100, sz: 0.008, rz: s * -0.62, glow: CYAN, glowInt: 1.1 });
    }
    // 青光眼 + 怪笑
    glowEyes(B, 'head', { y: 0.020, z: -0.082, spread: 0.050, r: 0.026, color: CYAN, glowInt: 2.1, sy: 1.35 });
    addOpenMouth(B, 'head', { y: -0.045, z: -0.086, w: 0.040, h: 0.035, color: DARK });
    addTeethRow(B, 'head', { n: 4, w: 0.012, gap: 0.016, y: -0.032, z: -0.100, h: 0.016, color: 0xe8f8f4 });
    // 雾状手臂
    for (let s = -1; s <= 1; s += 2) {
      const nm = s < 0 ? 'arm_l' : 'arm_r';
      B.node(nm, 'root', s * 0.155, 0.580, -0.020);
      capChain(B, nm, [[0, 0, 0], [s * 0.130, -0.060, -0.070], [s * 0.245, -0.150, -0.110]], [0.042, 0.034, 0.022], MIST, { glass: 0.7 });
    }

    return finishModel(B, function (nodes, dt, t) {
      const n = nodes.inner || nodes.root;
      if (n) n.position.y = (Math.sin(t * 1.6) * 0.5 + 0.5) * 0.035;
      nodes.head.rotation.x = Math.sin(t * 1.2) * 0.06;
      nodes.head.rotation.y = Math.sin(t * 0.7 + 0.5) * 0.14;
      nodes.ear_l.rotation.z = 0.20 + Math.sin(t * 1.8) * 0.10;
      nodes.ear_r.rotation.z = -0.20 - Math.sin(t * 1.8 + 0.5) * 0.10;
      nodes.skirt.rotation.y = Math.sin(t * 0.8) * 0.14;
      nodes.skirt.rotation.z = Math.sin(t * 1.1 + 0.4) * 0.07;
      nodes.arm_l.rotation.x = Math.sin(t * 1.4) * 0.12;
      nodes.arm_r.rotation.x = Math.sin(t * 1.4 + 1.1) * 0.12;
    }, { fitH: 0.85 });
  }

  // =========================================================================
  // 10) 魍魉 — 墨影魍魉、双角、烟雾下摆、利爪（h 1.45 / r 0.50）
  // =========================================================================
  function buildWangliang() {
    const B = Builder();
    const SHADE = 0x3a2a4a, DEEP = 0x241a33, MIST = 0x5a4470, RED = 0xe8453c, CLAW = 0xe8e0d0, BONE = 0xe8dcc0;

    // 烟雾下摆（动画节点）：无腿，墨紫烟团堆叠
    B.node('skirt', 'root', 0, 0.640, 0);
    const PUFFS = [
      [0, 0.020, 0.020, 0.300, 0.190, 0.300],
      [0.300, -0.100, 0.040, 0.200, 0.160, 0.180],
      [-0.290, -0.090, -0.050, 0.200, 0.160, 0.180],
      [0.160, -0.260, 0.100, 0.170, 0.140, 0.160],
      [-0.170, -0.270, -0.080, 0.170, 0.140, 0.160],
      [0.030, -0.420, 0.040, 0.140, 0.120, 0.130],
      [-0.040, -0.520, 0.050, 0.120, 0.110, 0.110],
    ];
    for (let i = 0; i < PUFFS.length; i++) {
      const p = PUFFS[i];
      B.put('skirt', SPH(), i % 2 ? SHADE : MIST, {
        x: p[0], y: p[1], z: p[2], sx: p[3], sy: p[4], sz: p[5], glass: 0.78,
      });
    }
    for (let i = 0; i < 5; i++) {
      const a = i * TAU / 5 + 0.3;
      B.put('skirt', leafGeo(0.040, 0.120, 0.014), i % 2 ? DEEP : SHADE, {
        x: Math.cos(a) * 0.190, y: -0.520, z: Math.sin(a) * 0.175, rx: PI, rz: Math.cos(a) * 0.30, glass: 0.62,
      });
    }
    // 躯干
    B.put('root', SPH_HI(), SHADE, { y: 0.920, sx: 0.205, sy: 0.235, sz: 0.175 });
    B.put('root', SPH(), DEEP, { y: 0.960, z: -0.100, sx: 0.150, sy: 0.160, sz: 0.100 });
    // 肩甲
    for (let s = -1; s <= 1; s += 2) {
      B.put('root', SPH(), DEEP, { x: s * 0.195, y: 1.060, z: -0.010, sx: 0.095, sy: 0.090, sz: 0.105 });
      B.put('root', CONE(), SHADE, { x: s * 0.245, y: 1.105, z: 0.000, sx: 0.040, sy: 0.120, sz: 0.035, rz: -s * 0.85 });
    }
    // 双臂 + 利爪（动画节点）
    for (let s = -1; s <= 1; s += 2) {
      const nm = s < 0 ? 'arm_l' : 'arm_r';
      B.node(nm, 'root', s * 0.215, 1.030, -0.020);
      capChain(B, nm, [[0, 0, 0], [s * 0.085, -0.150, -0.080], [s * 0.075, -0.320, -0.170]], [0.060, 0.050, 0.038], SHADE);
      B.put(nm, SPH(), DEEP, { x: s * 0.075, y: -0.335, z: -0.185, sx: 0.045, sy: 0.042, sz: 0.040 });
      for (let k = 0; k < 3; k++) {
        B.put(nm, CONE(), CLAW, {
          x: s * 0.075 + (k - 1) * 0.022, y: -0.360, z: -0.225,
          sx: 0.012, sy: 0.075, sz: 0.010, rx: -1.90, rz: (k - 1) * 0.18, shine: true,
        });
      }
    }
    // 头（动画节点）
    B.node('head', 'root', 0, 1.175, -0.020);
    B.put('head', SPH_HI(), SHADE, { sx: 0.135, sy: 0.128, sz: 0.122 });
    B.put('head', SPH(), DEEP, { y: -0.030, z: -0.080, sx: 0.095, sy: 0.080, sz: 0.060 });
    // 赤目 + 咧嘴獠牙
    glowEyes(B, 'head', { y: 0.028, z: -0.098, spread: 0.052, r: 0.030, color: RED, glowInt: 2.2, sy: 1.05 });
    B.put('head', SPH(), 0x140b18, { y: -0.055, z: -0.092, sx: 0.085, sy: 0.042, sz: 0.030 });
    addTeethRow(B, 'head', { n: 5, w: 0.016, gap: 0.022, y: -0.052, z: -0.112, h: 0.022, color: BONE });
    // 双角（动画节点）
    for (let s = -1; s <= 1; s += 2) {
      const nm = s < 0 ? 'horn_l' : 'horn_r';
      B.node(nm, 'head', s * 0.082, 0.080, 0.000);
      capChain(B, nm, [[0, 0, 0], [s * 0.050, 0.095, 0.020], [s * 0.020, 0.190, 0.055]], [0.040, 0.030, 0.018], BONE);
      B.put(nm, SPH(), RED, { x: s * 0.020, y: 0.196, z: 0.058, sx: 0.012, sy: 0.014, sz: 0.012, glow: RED, glowInt: 1.4 });
    }
    // 颈
    B.put('root', CAPSULE(0.070, 0.060), SHADE, { y: 1.090, z: -0.010 });

    return finishModel(B, function (nodes, dt, t) {
      const n = nodes.inner || nodes.root;
      if (n) n.position.y = (Math.sin(t * 1.35) * 0.5 + 0.5) * 0.040;
      nodes.head.rotation.x = Math.sin(t * 1.1) * 0.06;
      nodes.head.rotation.y = Math.sin(t * 0.65 + 0.4) * 0.12;
      nodes.skirt.rotation.y = Math.sin(t * 0.7) * 0.10;
      nodes.arm_l.rotation.z = 0.06 + Math.sin(t * 1.5) * 0.08;
      nodes.arm_r.rotation.z = -0.06 - Math.sin(t * 1.5 + 0.7) * 0.08;
      nodes.arm_l.rotation.x = Math.sin(t * 1.2 + 0.3) * 0.08;
      nodes.arm_r.rotation.x = Math.sin(t * 1.2 + 1.0) * 0.08;
      nodes.horn_l.rotation.z = 0.06 + Math.sin(t * 1.8) * 0.05;
      nodes.horn_r.rotation.z = -0.06 - Math.sin(t * 1.8 + 0.5) * 0.05;
    }, { fitH: 1.45 });
  }

  // =========================================================================
  // 11) 赤鱬 — 鱼身人面、大眼、金鳍、吐水泡（h 0.86 / r 0.34）
  // =========================================================================
  function buildChiru() {
    const B = Builder();
    const RED = 0xe8563c, RED_D = 0xc2452e, GOLD = 0xffd93d, SKIN = 0xf2d2b8, PEARL = 0xd8f4ff;

    // 立姿鱼身
    B.put('root', SPH_HI(), RED, { y: 0.390, sx: 0.170, sy: 0.260, sz: 0.145 });
    B.put('root', SPH(), RED_D, { y: 0.335, z: 0.020, sx: 0.140, sy: 0.210, sz: 0.112 });
    B.put('root', SPH(), 0xf0a080, { y: 0.360, z: -0.115, sx: 0.105, sy: 0.160, sz: 0.045 });
    B.put('root', CAPSULE(0.058, 0.050), SKIN, { y: 0.545, z: -0.010 });
    // 鱼身金鳞点缀
    for (let i = 0; i < 4; i++) {
      B.put('root', SPH(), GOLD, { x: (i % 2 ? 1 : -1) * 0.140, y: 0.300 + i * 0.055, z: -0.020 + i * 0.010, sx: 0.022, sy: 0.016, sz: 0.028, shine: true });
    }
    // 背鳍（金）+ 尾鳍（动画节点）
    B.put('root', leafGeo(0.050, 0.180, 0.012), GOLD, { y: 0.600, z: 0.070, rx: 0.40, shine: true });
    B.node('tail_fin', 'root', 0, 0.155, 0.120);
    B.put('tail_fin', leafGeo(0.095, 0.215, 0.014), GOLD, { y: 0.010, z: 0.005, rx: 1.95, shine: true });
    B.put('tail_fin', leafGeo(0.060, 0.150, 0.012), 0xf0b030, { x: 0.040, y: 0.005, z: 0.005, rx: 2.05, rz: -0.30 });
    B.put('tail_fin', leafGeo(0.060, 0.150, 0.012), 0xf0b030, { x: -0.040, y: 0.005, z: 0.005, rx: 2.05, rz: 0.30 });
    // 侧鳍（动画节点）
    for (let s = -1; s <= 1; s += 2) {
      const nm = s < 0 ? 'fin_l' : 'fin_r';
      B.node(nm, 'root', s * 0.165, 0.420, -0.020);
      B.put(nm, leafGeo(0.070, 0.165, 0.012), GOLD, { x: s * 0.010, y: 0.010, z: 0.010, rz: -s * 2.05, rx: 0.20, shine: true });
    }
    // 人面头（动画节点）
    B.node('head', 'root', 0, 0.655, -0.020);
    B.put('head', SPH_HI(), SKIN, { sx: 0.118, sy: 0.110, sz: 0.104 });
    B.put('head', SPH(), SKIN, { y: -0.034, z: -0.080, sx: 0.082, sy: 0.070, sz: 0.056 });
    // 大眼 + 金瞳
    addEyes(B, 'head', { y: 0.016, z: -0.078, spread: 0.068, r: 0.045, style: 'full', white: 0xfffdf8, iris: 0xffc933, pupil: 0x2a1a0a, wz: 0.60 });
    B.put('head', SPH(), RED_D, { y: 0.080, z: -0.068, sx: 0.088, sy: 0.013, sz: 0.026, rz: -0.06 });
    // 吐水泡的嘴
    addOpenMouth(B, 'head', { y: -0.050, z: -0.088, w: 0.034, h: 0.032, color: 0x8a3a3a, tongue: 0xf09090 });
    addCheeks(B, 'head', { y: -0.022, z: -0.070, spread: 0.070, r: 0.018, color: 0xf5a090 });
    // 头顶金鳍冠（撑起高度）
    B.put('head', leafGeo(0.045, 0.150, 0.012), GOLD, { y: 0.080, z: 0.015, rx: -0.18, shine: true });
    B.put('head', leafGeo(0.030, 0.105, 0.010), 0xf0b030, { x: 0.045, y: 0.075, z: 0.020, rx: -0.25, rz: -0.42 });
    B.put('head', leafGeo(0.030, 0.105, 0.010), 0xf0b030, { x: -0.045, y: 0.075, z: 0.020, rx: -0.25, rz: 0.42 });
    // 水泡（动画节点）
    B.node('bubbles', 'root', 0, 0.600, -0.145);
    const BUB = [[0.000, 0.020, -0.020, 0.026], [0.030, 0.120, -0.045, 0.019], [-0.025, 0.205, -0.060, 0.014], [0.020, 0.280, -0.075, 0.010]];
    for (let i = 0; i < BUB.length; i++) {
      const b = BUB[i];
      B.put('bubbles', SPH(), PEARL, { x: b[0], y: b[1], z: b[2], sx: b[3], sy: b[3], sz: b[3], glow: 0xbfe8ff, glowInt: 0.9, glass: 0.5 });
    }

    return finishModel(B, function (nodes, dt, t) {
      breathe(nodes, t, 0.010);
      nodes.head.rotation.x = Math.sin(t * 1.35) * 0.05;
      nodes.head.rotation.y = Math.sin(t * 0.85 + 0.3) * 0.10;
      nodes.fin_l.rotation.z = 0.10 + Math.sin(t * 2.4) * 0.16;
      nodes.fin_r.rotation.z = -0.10 - Math.sin(t * 2.4 + 0.5) * 0.16;
      nodes.tail_fin.rotation.y = Math.sin(t * 1.9) * 0.22;
      nodes.bubbles.position.y = 0.600 + Math.sin(t * 1.2) * 0.012;
      nodes.bubbles.rotation.y = t * 0.6;
    }, { fitH: 0.86 });
  }

  // =========================================================================
  // 12) 饕餮 — 青铜巨兽、巨口獠牙、羊角、金纹、腹大（h 2.20 / r 0.82）
  // =========================================================================
  function buildTaotie() {
    const B = Builder();
    const BRONZE = 0x6b8a5a, BRONZE_D = 0x4e6a42, GOLD = 0xe8b33a, BONE = 0xfff6e0;
    const DARK = 0x2a3624, MOUTH = 0x3a1212;

    // 四条粗壮兽腿 + 巨爪
    const LEGS = [[-0.360, -0.300], [0.360, -0.300], [-0.370, 0.330], [0.370, 0.330]];
    for (let i = 0; i < LEGS.length; i++) {
      const lx = LEGS[i][0], lz = LEGS[i][1];
      B.put('root', CAPSULE(0.130, 0.300), BRONZE, { x: lx, y: 0.430, z: lz });
      B.put('root', CAPSULE(0.105, 0.180), BRONZE_D, { x: lx, y: 0.170, z: lz - 0.012 });
      B.put('root', SPH(), BRONZE_D, { x: lx, y: 0.070, z: lz - 0.080, sx: 0.170, sy: 0.100, sz: 0.240 });
      addClaws(B, 'root', { x: lx, y: 0.055, z: lz - 0.270, r: 0.022, len: 0.065, spread: 0.036, color: BONE });
    }
    // 巨腹（动画节点，呼吸更明显）
    B.node('belly', 'root', 0, 0.960, 0);
    B.put('belly', SPH_HI(), BRONZE, { sx: 0.575, sy: 0.500, sz: 0.590 });
    B.put('belly', SPH(), 0x9cb884, { y: -0.030, z: -0.420, sx: 0.330, sy: 0.280, sz: 0.190 });
    B.put('belly', SPH(), 0xb9cf9a, { y: 0.075, z: -0.455, sx: 0.220, sy: 0.140, sz: 0.130 });
    // 腹部金纹（贴在腹甲表面的云雷纹：金环弧 + 金点）
    for (let i = 0; i < 2; i++) {
      const sx = i ? -1 : 1;
      B.put('belly', TORUS(0.105, 0.016, PI * 1.40), GOLD, { x: sx * 0.140, y: -0.020, z: -0.632, rz: i ? -0.8 : 0.8, shine: true });
      B.put('belly', TORUS(0.055, 0.013, PI * 1.50), GOLD, { x: sx * 0.225, y: -0.130, z: -0.598, rz: i ? 2.0 : -2.0, shine: true });
    }
    for (let i = 0; i < 5; i++) {
      B.put('belly', SPH(), GOLD, { x: Math.sin(i * 1.5) * 0.150, y: -0.155 + i * 0.030, z: -0.600, sx: 0.020, sy: 0.020, sz: 0.012, shine: true });
    }
    // 胸前金饰（青铜兽面的额饰）
    B.put('root', SPH(), GOLD, { y: 1.345, z: -0.392, sx: 0.072, sy: 0.036, sz: 0.016, rx: 0.24, shine: true });
    B.put('root', TORUS(0.052, 0.012, PI * 1.1), GOLD, { x: 0.155, y: 1.300, z: -0.368, rz: 0.5, shine: true });
    B.put('root', TORUS(0.052, 0.012, PI * 1.1), GOLD, { x: -0.155, y: 1.300, z: -0.368, rz: -0.5, shine: true });
    // 背脊金刺（沿脊梁一排）
    for (let i = 0; i < 6; i++) {
      B.put('root', CONE(), GOLD, { y: 1.390 - i * 0.012, z: -0.230 + i * 0.130, sx: 0.045, sy: 0.150 - i * 0.012, sz: 0.036, rx: 0.30, shine: true });
    }
    // 肩胸
    B.put('root', SPH_HI(), BRONZE, { y: 1.300, z: -0.110, sx: 0.520, sy: 0.380, sz: 0.430 });
    B.put('root', SPH(), BRONZE_D, { y: 1.330, z: -0.250, sx: 0.400, sy: 0.280, sz: 0.240 });
    // 尾（动画节点）：短壮 + 金铃
    B.node('tail', 'root', 0, 1.020, 0.540);
    capChain(B, 'tail', [[0, 0, 0], [0, 0.075, 0.100], [0, 0.160, 0.170]], [0.095, 0.075, 0.050], BRONZE);
    B.put('tail', SPH(), GOLD, { y: 0.205, z: 0.195, sx: 0.070, sy: 0.070, sz: 0.070, shine: true });
    // 头（动画节点）
    B.node('head', 'root', 0, 1.620, -0.300);
    B.put('head', SPH_HI(), BRONZE, { sx: 0.420, sy: 0.340, sz: 0.380 });
    B.put('head', SPH(), BRONZE_D, { y: 0.120, z: -0.150, sx: 0.340, sy: 0.180, sz: 0.260 });
    // 巨口：口腔 + 上齿 + 下颚
    B.put('head', SPH(), MOUTH, { y: -0.095, z: -0.270, sx: 0.260, sy: 0.160, sz: 0.160 });
    B.put('head', SPH(), 0x8a2a2a, { y: -0.150, z: -0.300, sx: 0.170, sy: 0.070, sz: 0.090 });
    B.put('head', SPH(), BRONZE, { y: 0.020, z: -0.300, sx: 0.320, sy: 0.110, sz: 0.150 });
    // 上排獠牙（朝下）
    for (let i = 0; i < 6; i++) {
      const x = (i - 2.5) * 0.078;
      B.put('head', CONE(), BONE, { x: x, y: -0.050, z: -0.352, sx: 0.024, sy: 0.090, sz: 0.020, rx: PI, shine: true });
    }
    B.put('head', CONE(), BONE, { x: 0.245, y: -0.030, z: -0.330, sx: 0.030, sy: 0.130, sz: 0.026, rx: PI, shine: true });
    B.put('head', CONE(), BONE, { x: -0.245, y: -0.030, z: -0.330, sx: 0.030, sy: 0.130, sz: 0.026, rx: PI, shine: true });
    // 下颚（动画节点：开合）
    B.node('jaw', 'head', 0, -0.150, -0.170);
    B.put('jaw', SPH(), BRONZE_D, { y: -0.020, z: -0.040, sx: 0.300, sy: 0.110, sz: 0.250 });
    B.put('jaw', SPH(), 0x9cb884, { y: 0.020, z: -0.190, sx: 0.220, sy: 0.060, sz: 0.130 });
    for (let i = 0; i < 5; i++) {
      const x = (i - 2) * 0.078;
      B.put('jaw', CONE(), BONE, { x: x, y: 0.070, z: -0.230, sx: 0.022, sy: 0.080, sz: 0.018, shine: true });
    }
    // 金瞳 + 眉骨
    B.put('head', SPH(), GOLD, { x: 0.185, y: 0.190, z: -0.300, sx: 0.075, sy: 0.060, sz: 0.050, glow: GOLD, glowInt: 1.7, shine: true });
    B.put('head', SPH(), GOLD, { x: -0.185, y: 0.190, z: -0.300, sx: 0.075, sy: 0.060, sz: 0.050, glow: GOLD, glowInt: 1.7, shine: true });
    B.put('head', SPH(), BRONZE_D, { x: 0.185, y: 0.245, z: -0.290, sx: 0.120, sy: 0.040, sz: 0.090, rz: -0.18 });
    B.put('head', SPH(), BRONZE_D, { x: -0.185, y: 0.245, z: -0.290, sx: 0.120, sy: 0.040, sz: 0.090, rz: 0.18 });
    // 羊角（动画节点，向两侧卷起）
    for (let s = -1; s <= 1; s += 2) {
      const nm = s < 0 ? 'horn_l' : 'horn_r';
      B.node(nm, 'head', s * 0.300, 0.235, 0.010);
      capChain(B, nm, [[0, 0, 0], [s * 0.060, 0.140, -0.020], [s * 0.030, 0.260, 0.040], [-s * 0.050, 0.330, 0.110]], [0.085, 0.075, 0.055, 0.034], 0xd9b86a);
      B.put(nm, TORUS(0.050, 0.016, TAU), GOLD, { x: s * 0.045, y: 0.150, z: -0.012, rz: -s * 1.2, shine: true });
    }
    // 耳 + 颊部金环
    for (let s = -1; s <= 1; s += 2) {
      B.put('head', SPH(), BRONZE_D, { x: s * 0.370, y: 0.060, z: 0.050, sx: 0.070, sy: 0.100, sz: 0.050, rz: s * 0.4 });
    }
    B.put('head', TORUS(0.095, 0.024, PI * 1.30), GOLD, { x: 0.300, y: 0.020, z: -0.270, rz: 0.7, shine: true });
    B.put('head', TORUS(0.095, 0.024, PI * 1.30), GOLD, { x: -0.300, y: 0.020, z: -0.270, rz: -0.7, shine: true });

    return finishModel(B, function (nodes, dt, t) {
      breathe(nodes, t, 0.008);
      nodes.belly.scale.set(1 + Math.sin(t * 1.7 + 0.4) * 0.012, 1 + Math.sin(t * 1.7) * 0.016, 1 + Math.sin(t * 1.7 + 0.2) * 0.010);
      nodes.head.rotation.x = Math.sin(t * 1.2) * 0.035;
      nodes.head.rotation.y = Math.sin(t * 0.75) * 0.06;
      nodes.jaw.rotation.x = -0.12 - Math.max(0, Math.sin(t * 2.1)) * 0.16;
      nodes.tail.rotation.z = Math.sin(t * 1.6) * 0.14;
      nodes.tail.rotation.x = Math.sin(t * 1.2 + 0.5) * 0.08;
      nodes.horn_l.rotation.z = 0.03 + Math.sin(t * 1.4) * 0.015;
      nodes.horn_r.rotation.z = -0.03 - Math.sin(t * 1.4 + 0.4) * 0.015;
    }, { fitH: 2.20 });
  }

  // =========================================================================
  // 13) 巴蛇 — 巨蛇、金瞳、盘绕、鳞纹（h 1.75 / r 0.55）
  // =========================================================================
  function buildBashe() {
    const B = Builder();
    const GREEN = 0x3f6a4a, GREEN_D = 0x2a4a34, BELLY = 0xc9b46a, GOLD = 0xffd93d, RED = 0xd84a5a;

    // 盘绕的蛇身基座：两圈粗蛇体（环弧平滑盘起），上接竖立主躯干
    B.put('root', TORUS(0.285, 0.140, PI * 1.60), GREEN, { y: 0.145, rx: PI / 2 - 0.22, ry: -0.30 });
    B.put('root', TORUS(0.222, 0.118, PI * 1.45), GREEN_D, { y: 0.290, z: 0.030, rx: PI / 2 - 0.08, ry: 1.10 });
    B.put('root', SPH(), GREEN, { x: 0.300, y: 0.165, z: 0.160, sx: 0.118, sy: 0.140, sz: 0.128 });
    // 尾尖从盘绕末端翘出
    B.put('root', CONE(), GREEN_D, { x: 0.320, y: 0.180, z: 0.290, sx: 0.058, sy: 0.230, sz: 0.052, rx: 1.30, ry: -0.55, shine: true });
    // 盘圈外侧腹鳞
    for (let i = 0; i < 10; i++) {
      const a = -0.25 + (i / 9) * PI * 1.20;
      B.put('root', SPH(), BELLY, { x: Math.cos(a) * 0.290, y: 0.068, z: Math.sin(a) * 0.290, sx: 0.050, sy: 0.018, sz: 0.058, ry: -a });
    }
    // 尾尖（动画节点）
    B.node('tail', 'root', 0, 0.150, 0.360);
    capChain(B, 'tail', [[0, 0, 0], [0.060, 0.045, 0.070], [0.110, 0.100, 0.110]], [0.060, 0.040, 0.022], GREEN_D);
    B.put('tail', CONE(), GREEN_D, { x: 0.130, y: 0.115, z: 0.130, sx: 0.030, sy: 0.080, sz: 0.026, rx: 1.0, shine: true });
    // 主躯干（动画节点：S 形起伏）
    B.node('trunk', 'root', 0, 0.300, 0.030);
    const PTS = [
      [0, 0.00, 0], [0.120, 0.200, 0.030], [0.030, 0.420, -0.020],
      [0.100, 0.640, -0.060], [0.000, 0.860, -0.100], [-0.050, 1.060, -0.140], [0.000, 1.180, -0.160],
    ];
    const RADS = [0.200, 0.190, 0.180, 0.170, 0.160, 0.150, 0.140];
    capChain(B, 'trunk', PTS, RADS, GREEN);
    // 腹鳞（正面 + 背脊鳞纹）
    for (let i = 1; i < PTS.length; i++) {
      const p = PTS[i];
      B.put('trunk', SPH(), BELLY, { x: p[0] * 0.92, y: p[1], z: p[2] - RADS[i] * 0.72, sx: RADS[i] * 0.62, sy: 0.045, sz: RADS[i] * 0.42 });
      B.put('trunk', ICO(1, 0), i % 2 ? GREEN_D : 0x5a8a5a, { x: p[0], y: p[1] + RADS[i] * 0.72, z: p[2], sx: 0.055, sy: 0.040, sz: 0.062, ry: PI / 4 });
    }
    // 颈侧金鳍（云纹）
    for (let i = 0; i < 3; i++) {
      B.put('trunk', leafGeo(0.026, 0.080, 0.010), GOLD, { x: 0.030 - i * 0.020, y: 1.000 + i * 0.030, z: -0.150 - i * 0.010, rx: -0.30, rz: -0.65, shine: true });
    }
    // 头（动画节点）
    B.node('head', 'trunk', 0, 1.280, -0.170);
    B.put('head', SPH_HI(), GREEN, { sx: 0.200, sy: 0.160, sz: 0.240 });
    B.put('head', SPH(), GREEN_D, { y: 0.020, z: 0.060, sx: 0.165, sy: 0.130, sz: 0.180 });
    B.put('head', SPH(), GREEN, { y: -0.020, z: -0.200, sx: 0.130, sy: 0.090, sz: 0.100 });
    // 金瞳（竖瞳）
    for (let s = -1; s <= 1; s += 2) {
      B.put('head', SPH(), GOLD, { x: s * 0.105, y: 0.055, z: -0.150, sx: 0.050, sy: 0.055, sz: 0.032, glow: GOLD, glowInt: 1.4, shine: true });
      B.put('head', SPH(), 0x2a2008, { x: s * 0.105, y: 0.055, z: -0.176, sx: 0.013, sy: 0.044, sz: 0.010, shine: true });
      B.put('head', SPH(), GREEN_D, { x: s * 0.105, y: 0.110, z: -0.140, sx: 0.075, sy: 0.026, sz: 0.050 });
    }
    // 张口 + 獠牙 + 分叉舌
    addOpenMouth(B, 'head', { y: -0.070, z: -0.235, w: 0.095, h: 0.045, color: 0x3a1418 });
    addFangs(B, 'head', { n: 2, gap: 0.075, y: -0.055, z: -0.245, w: 0.020, h: 0.060, color: 0xfffdf0 });
    B.put('head', CAPSULE(0.012, 0.100), RED, { y: -0.080, z: -0.285, rx: -PI / 2 });
    B.put('head', CAPSULE(0.009, 0.070), RED, { x: 0.030, y: -0.080, z: -0.345, rx: -PI / 2, rz: -0.35 });
    B.put('head', CAPSULE(0.009, 0.070), RED, { x: -0.030, y: -0.080, z: -0.345, rx: -PI / 2, rz: 0.35 });
    // 头冠红鳞 + 鼻角
    B.put('head', SPH(), RED, { y: 0.140, z: -0.050, sx: 0.075, sy: 0.040, sz: 0.090 });
    B.put('head', CONE(), GOLD, { y: 0.150, z: -0.200, sx: 0.018, sy: 0.085, sz: 0.016, rx: -1.10, shine: true });

    return finishModel(B, function (nodes, dt, t) {
      nodes.trunk.rotation.x = Math.sin(t * 1.15) * 0.045;
      nodes.trunk.rotation.z = Math.sin(t * 0.85) * 0.055;
      nodes.head.rotation.x = Math.sin(t * 1.35 + 0.4) * 0.06;
      nodes.head.rotation.y = Math.sin(t * 0.95) * 0.16;
      nodes.head.rotation.z = Math.sin(t * 1.6) * 0.04;
      nodes.tail.rotation.y = Math.sin(t * 2.1) * 0.22;
      nodes.tail.rotation.x = Math.sin(t * 1.5 + 0.6) * 0.10;
      breathe(nodes, t, 0.006);
    }, { fitH: 1.75 });
  }

  // =========================================================================
  // 14) 混沌 — 无面黄囊、六足四翼、赤光流转、浑敦无目（h 1.90 / r 0.42）
  // =========================================================================
  function buildHundun() {
    const B = Builder();
    const SAC = 0xe8c86a, SAC_D = 0xc9a84a, SAC_L = 0xf4dfa0, RED = 0xe8453c, WING = 0xf0e0b0;

    // 无面黄囊（主体，动画节点做缓慢鼓动）
    B.node('sac', 'root', 0, 0.000, 0);
    B.put('sac', SPH_HI(), SAC, { y: 1.060, sx: 0.420, sy: 0.750, sz: 0.380 });
    B.put('sac', SPH(), SAC_D, { y: 1.020, z: 0.060, sx: 0.390, sy: 0.700, sz: 0.330 });
    B.put('sac', SPH(), SAC_L, { y: 1.180, z: -0.120, sx: 0.290, sy: 0.480, sz: 0.240 });
    // 赤光流转（环带 + 光点）
    ringBand(B, 'sac', { y: 0.730, R: 1, tube: 0.026, sx: 0.378, sy: 0.342, color: RED, glow: RED, glowInt: 1.6 });
    ringBand(B, 'sac', { y: 1.060, R: 1, tube: 0.028, sx: 0.420, sy: 0.380, color: RED, glow: RED, glowInt: 1.9 });
    ringBand(B, 'sac', { y: 1.380, R: 1, tube: 0.026, sx: 0.381, sy: 0.345, color: RED, glow: RED, glowInt: 1.6 });
    const MOTES = [
      [0.300, 0.860, -0.250], [-0.290, 1.000, -0.230], [0.240, 1.240, -0.280],
      [-0.210, 1.330, -0.240], [0.330, 1.120, 0.120], [-0.330, 0.920, 0.140],
    ];
    for (let i = 0; i < MOTES.length; i++) {
      const m = MOTES[i];
      B.put('sac', SPH(), RED, { x: m[0], y: m[1], z: m[2], sx: 0.028, sy: 0.028, sz: 0.028, glow: RED, glowInt: 2.0 });
    }
    // 六足（三对，短壮）
    const LEGS = [[-0.260, -0.190], [0.260, -0.190], [-0.300, 0.030], [0.300, 0.030], [-0.280, 0.240], [0.280, 0.240]];
    for (let i = 0; i < LEGS.length; i++) {
      const lx = LEGS[i][0], lz = LEGS[i][1];
      B.put('root', CAPSULE(0.052, 0.260), SAC_D, { x: lx, y: 0.245, z: lz, rz: lx > 0 ? -0.18 : 0.18 });
      B.put('root', SPH(), SAC_D, { x: lx * 1.30, y: 0.055, z: lz - 0.030, sx: 0.075, sy: 0.055, sz: 0.100 });
      addClaws(B, 'root', { x: lx * 1.30, y: 0.050, z: lz - 0.120, r: 0.012, len: 0.034, spread: 0.020, color: 0xfff2c0 });
    }
    // 四翼（四个动画节点，两对）：叶状宽翼，向后上方展开
    // 四翼：两对宽叶翼从背侧向上、向外张开，叶面朝前（正面清晰可见）
    const WINGS = [
      ['wing_a_l', -1, -0.255, 1.420, 0.100, 0.340, 0.55, 0.55],
      ['wing_a_r', 1, 0.255, 1.420, 0.100, 0.340, 0.55, 0.55],
      ['wing_b_l', -1, -0.220, 1.170, 0.165, 0.300, 0.80, 0.45],
      ['wing_b_r', 1, 0.220, 1.170, 0.165, 0.300, 0.80, 0.45],
    ];
    for (let i = 0; i < WINGS.length; i++) {
      const w = WINGS[i];
      const nm = w[0], s = w[1], len = w[5], rz = w[6], rx = w[7];
      B.node(nm, 'root', w[2], w[3], w[4]);
      // 主翼膜
      B.put(nm, leafGeo(0.150, len, 0.014), WING, { x: s * 0.010, y: 0.000, z: 0.000, rx: rx, rz: -s * rz, glass: 0.82 });
      // 内层淡金翼膜
      B.put(nm, leafGeo(0.085, len * 0.68, 0.010), SAC_L, { x: s * 0.020, y: 0.000, z: 0.010, rx: rx - 0.06, rz: -s * (rz + 0.14), glass: 0.66 });
      // 赤色翼缘 + 翼尖赤光
      B.put(nm, leafGeo(0.026, len * 0.95, 0.006), RED, { x: s * 0.008, y: 0.000, z: 0.014, rx: rx, rz: -s * rz, glow: RED, glowInt: 1.3 });
      const tipY = len * Math.cos(rx) * Math.cos(rz);
      const tipX = len * Math.sin(rz) * Math.cos(rx);
      B.put(nm, SPH(), RED, { x: s * (0.010 + tipX * 0.93), y: tipY * 0.93, z: 0.016 + len * Math.sin(rx) * 0.93, sx: 0.022, sy: 0.020, sz: 0.016, glow: RED, glowInt: 1.6 });
    }
    // 正面赤光漩涡（无面之脸的位置只有流转的红光）
    const SWIRL = [[-0.120, 1.240], [-0.030, 1.285], [0.075, 1.250], [0.135, 1.165], [0.095, 1.080], [0.000, 1.055], [-0.105, 1.090]];
    for (let i = 0; i < SWIRL.length; i++) {
      B.put('sac', SPH(), RED, { x: SWIRL[i][0], y: SWIRL[i][1], z: -0.355, sx: 0.032, sy: 0.026, sz: 0.018, glow: RED, glowInt: 2.1 });
    }
    // 顶部混沌之光（撑起 1.9 的高度）
    B.put('root', SPH(), RED, { y: 1.862, sx: 0.050, sy: 0.046, sz: 0.050, glow: RED, glowInt: 2.4 });
    B.put('root', TORUS(0.080, 0.014, TAU), RED, { y: 1.830, rx: PI / 2, glow: RED, glowInt: 1.7 });

    return finishModel(B, function (nodes, dt, t) {
      nodes.sac.scale.set(1 + Math.sin(t * 1.35) * 0.010, 1 + Math.sin(t * 1.35 + 0.3) * 0.014, 1 + Math.sin(t * 1.35 + 0.6) * 0.010);
      const flap = Math.sin(t * 5.6);
      const flap2 = Math.sin(t * 5.6 + 0.9);
      nodes.wing_a_l.rotation.z = 0.10 + flap * 0.20;
      nodes.wing_a_r.rotation.z = -0.10 - flap * 0.20;
      nodes.wing_b_l.rotation.z = 0.08 + flap2 * 0.16;
      nodes.wing_b_r.rotation.z = -0.08 - flap2 * 0.16;
      nodes.wing_a_l.rotation.x = Math.sin(t * 5.6 + 0.4) * 0.08;
      nodes.wing_a_r.rotation.x = Math.sin(t * 5.6 + 0.4) * 0.08;
      nodes.wing_b_l.rotation.x = Math.sin(t * 5.6 + 1.3) * 0.07;
      nodes.wing_b_r.rotation.x = Math.sin(t * 5.6 + 1.3) * 0.07;
    }, { fitH: 1.90 });
  }

  // =========================================================================
  // 注册 14 只妖物
  // =========================================================================
  const BUILDERS = {
    lushu: buildLushu, wugong: buildWugong, zhen: buildZhen, mumei: buildMumei,
    xuanfeng: buildXuanfeng, zheng: buildZheng, jiuwei: buildJiuwei, jiaoren: buildJiaoren,
    chimei: buildChimei, wangliang: buildWangliang, chiru: buildChiru, taotie: buildTaotie,
    bashe: buildBashe, hundun: buildHundun,
  };
  if (typeof M.registerBuilders === 'function') {
    M.registerBuilders(BUILDERS);
  } else if (window.console && console.warn) {
    console.warn('[PG.models] registerBuilders 缺失：14 只妖物未能注册');
  }
})();

/* ==================== 35-art.js ==================== */
/* ============================================================================
 * 35-art.js — PG.models.art
 * 山海 · 森之突袭 2D 美术：18 只异兽圆形图标 + 4 位行者半身头像
 * ----------------------------------------------------------------------------
 * 1) 全部在 0..1 单位空间用 Canvas2D 手绘，g.scale(size,size) 后天然适配任意像素尺寸。
 * 2) 纯几何拼装：圆 / 椭圆 / 多边形 / 圆角矩形 / 渐变 / 描边；无外部贴图，离线可用。
 * 3) 配色与造型严格按 docs/MYTHOLOGY.md 第 2、3 节（主色 / 特征 / 属性徽章）。
 * 4) 对外只挂 PG.models.art = { icon(id,size), portrait(id,size), has(id) }：
 *    - icon 最小 16px、portrait 最小 32px，尺寸取整；同 id 同尺寸命中缓存。
 *    - 未知 id 返回 null，绝不抛错（PG.models 未加载时也安全）。
 * 5) 不引用 30-models 内部变量；需要资料时走 PG.models.info(id)。
 * ==========================================================================*/
(function () {
  'use strict';

  var TAU = Math.PI * 2;
  var PI = Math.PI;
  var PG = (window.PG = window.PG || {});

  // =========================================================================
  // 1. 画布与手绘工具（0..1 单位空间）
  // =========================================================================
  function mkCanvas(size) {
    var s = Math.max(16, Math.round(size || 128));
    var c = document.createElement('canvas');
    c.width = s;
    c.height = s;
    var g = c.getContext('2d');
    if (g) {
      g.scale(s, s);
      g.lineJoin = 'round';
      g.lineCap = 'round';
    }
    return { canvas: c, g: g, size: s };
  }

  function cCir(g, x, y, r, fill, stroke, lw) {
    g.beginPath();
    g.arc(x, y, Math.abs(r), 0, TAU);
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.lineWidth = lw == null ? 0.02 : lw; g.strokeStyle = stroke; g.stroke(); }
  }

  function cEll(g, x, y, rx, ry, rot, fill, stroke, lw) {
    g.beginPath();
    g.ellipse(x, y, Math.abs(rx), Math.abs(ry), rot || 0, 0, TAU);
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.lineWidth = lw == null ? 0.02 : lw; g.strokeStyle = stroke; g.stroke(); }
  }

  function cShp(g, pts, fill, stroke, lw) {
    if (!pts || !pts.length) return;
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.closePath();
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.lineWidth = lw == null ? 0.02 : lw; g.strokeStyle = stroke; g.stroke(); }
  }

  function cRR(g, x, y, w, h, r, fill, stroke, lw) {
    var rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    g.beginPath();
    g.moveTo(x + rr, y);
    g.lineTo(x + w - rr, y); g.quadraticCurveTo(x + w, y, x + w, y + rr);
    g.lineTo(x + w, y + h - rr); g.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    g.lineTo(x + rr, y + h); g.quadraticCurveTo(x, y + h, x, y + h - rr);
    g.lineTo(x, y + rr); g.quadraticCurveTo(x, y, x + rr, y);
    g.closePath();
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.lineWidth = lw == null ? 0.02 : lw; g.strokeStyle = stroke; g.stroke(); }
  }

  function cLin(g, x0, y0, x1, y1, stops) {
    var gr = g.createLinearGradient(x0, y0, x1, y1);
    for (var i = 0; i < stops.length; i++) gr.addColorStop(stops[i][0], stops[i][1]);
    return gr;
  }

  function cRad(g, x, y, r0, r1, stops) {
    var gr = g.createRadialGradient(x, y, Math.max(0, r0), x, y, Math.max(0.001, r1));
    for (var i = 0; i < stops.length; i++) gr.addColorStop(stops[i][0], stops[i][1]);
    return gr;
  }

  // 四角星闪光
  function cSpark(g, x, y, r, color) {
    g.beginPath();
    g.moveTo(x, y - r);
    g.quadraticCurveTo(x + r * 0.18, y - r * 0.18, x + r, y);
    g.quadraticCurveTo(x + r * 0.18, y + r * 0.18, x, y + r);
    g.quadraticCurveTo(x - r * 0.18, y + r * 0.18, x - r, y);
    g.quadraticCurveTo(x - r * 0.18, y - r * 0.18, x, y - r);
    g.closePath();
    g.fillStyle = color || '#ffffff';
    g.fill();
  }

  // 卡通眼睛：眼白 + 虹膜 + 瞳孔 + 两处高光
  function cEye(g, x, y, r, white, iris, pupil) {
    cEll(g, x, y, r, r * 1.06, 0, white || '#fffdf6');
    if (iris) cEll(g, x, y + r * 0.10, r * 0.70, r * 0.72, 0, iris);
    if (pupil) cEll(g, x, y + r * 0.13, r * 0.36, r * 0.40, 0, pupil);
    cCir(g, x - r * 0.30, y - r * 0.34, r * 0.28, '#ffffff');
    cCir(g, x + r * 0.26, y + r * 0.30, r * 0.12, 'rgba(255,255,255,.85)');
  }

  function cSmile(g, x, y, r, color, lw) {
    g.beginPath();
    g.arc(x, y, r, PI * 0.18, PI * 0.82);
    g.lineWidth = lw || 0.015;
    g.strokeStyle = color || '#5a3a2a';
    g.stroke();
  }

  // 柔和光晕（径向渐变）
  function cGlow(g, x, y, r, color, alpha) {
    g.save();
    g.globalAlpha = alpha == null ? 0.45 : alpha;
    var gr = g.createRadialGradient(x, y, 0, x, y, Math.max(0.001, r));
    gr.addColorStop(0, color);
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fill();
    g.restore();
  }

  // 地面软阴影
  function cShadow(g, y, rx, ry, alpha) {
    cEll(g, 0.5, y, rx, ry, 0, 'rgba(24,18,10,' + (alpha == null ? 0.18 : alpha) + ')');
  }

  // 雷纹闪电（也用于属性徽章的 bolt）
  function cBolt(g, x, y, s, fill, stroke) {
    var pts = [
      [x + s * 0.10, y - s * 0.55], [x - s * 0.44, y + s * 0.06],
      [x - s * 0.02, y + s * 0.06], [x - s * 0.12, y + s * 0.55],
      [x + s * 0.44, y - s * 0.10], [x + s * 0.04, y - s * 0.10]
    ];
    cShp(g, pts, fill || '#ffd93d', stroke, s * 0.18);
  }

  // 火焰：底部中心 (x,y)，h 向上
  function cFlame(g, x, y, w, h, fill, inner) {
    g.beginPath();
    g.moveTo(x, y);
    g.bezierCurveTo(x - w * 0.62, y - h * 0.24, x - w * 0.48, y - h * 0.74, x - w * 0.04, y - h);
    g.bezierCurveTo(x + w * 0.20, y - h * 0.62, x + w * 0.56, y - h * 0.38, x + w * 0.12, y);
    g.closePath();
    g.fillStyle = fill || '#ff8a3d';
    g.fill();
    if (inner) {
      g.beginPath();
      g.moveTo(x, y - h * 0.06);
      g.bezierCurveTo(x - w * 0.26, y - h * 0.26, x - w * 0.20, y - h * 0.52, x - w * 0.01, y - h * 0.68);
      g.bezierCurveTo(x + w * 0.10, y - h * 0.46, x + w * 0.24, y - h * 0.28, x + w * 0.05, y - h * 0.04);
      g.closePath();
      g.fillStyle = inner;
      g.fill();
    }
  }

  // 锥形肢体 / 直尾 / 角（两端圆头）
  function cTaper(g, x0, y0, x1, y1, w0, w1, fill, stroke, lw) {
    cCurveTaper(g, x0, y0, (x0 + x1) / 2, (y0 + y1) / 2, x1, y1, w0, w1, fill, stroke, lw);
  }

  // 带弧度的锥形：起点 (x0,y0) -> 控制点 (cx,cy) -> 终点 (x1,y1)
  function cCurveTaper(g, x0, y0, cx, cy, x1, y1, w0, w1, fill, stroke, lw) {
    var a0 = Math.atan2(cy - y0, cx - x0);
    var a1 = Math.atan2(y1 - cy, x1 - cx);
    var n0x = -Math.sin(a0), n0y = Math.cos(a0);
    var n1x = -Math.sin(a1), n1y = Math.cos(a1);
    var mx = (x0 + cx) / 2, my = (y0 + cy) / 2;
    g.beginPath();
    g.moveTo(x0 + n0x * w0, y0 + n0y * w0);
    g.quadraticCurveTo(mx + n1x * w0, my + n1y * w0, x1 + n1x * w1, y1 + n1y * w1);
    g.arc(x1, y1, Math.abs(w1), a1 + PI / 2, a1 - PI / 2, true);
    g.quadraticCurveTo(mx - n1x * w0 * 0.85, my - n1y * w0 * 0.85, x0 - n0x * w0, y0 - n0y * w0);
    g.arc(x0, y0, Math.abs(w0), a0 - PI / 2, a0 + PI / 2, true);
    g.closePath();
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.lineWidth = lw == null ? 0.014 : lw; g.strokeStyle = stroke; g.stroke(); }
  }

  // 螺旋（云纹 / 灵芝尾 / 赤光流转）
  function cSwirl(g, x, y, r, turns, color, lw, dir) {
    var steps = 42;
    g.beginPath();
    for (var i = 0; i <= steps; i++) {
      var t = i / steps;
      var ang = (dir === -1 ? -1 : 1) * t * turns * TAU;
      var rr = r * (1 - t * 0.88);
      var px = x + Math.cos(ang) * rr;
      var py = y + Math.sin(ang) * rr;
      if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.lineWidth = lw || 0.014;
    g.strokeStyle = color;
    g.stroke();
  }

  // 一排鳞片（U 形弧）
  function cScaleRow(g, cx, cy, n, r, color, lw, rot) {
    var step = r * 1.55;
    g.save();
    if (rot) { g.translate(cx, cy); g.rotate(rot); g.translate(-cx, -cy); }
    g.lineWidth = lw || 0.012;
    g.strokeStyle = color;
    for (var i = 0; i < n; i++) {
      var x = cx + (i - (n - 1) / 2) * step;
      g.beginPath();
      g.arc(x, cy, r, PI * 0.16, PI * 0.84);
      g.stroke();
    }
    g.restore();
  }

  // 六边形（龟甲纹 / 鳞甲）
  function cHex(g, cx, cy, r, rot, fill, stroke, lw) {
    var pts = [];
    for (var i = 0; i < 6; i++) {
      var a = (rot || 0) + i * PI / 3;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
    cShp(g, pts, fill, stroke, lw);
  }

  // 云纹 / 灵芝（三瓣云头 + 卷尾）
  function cCloud(g, x, y, s, fill, stroke, lw) {
    cCir(g, x - s * 0.55, y, s * 0.42, fill);
    cCir(g, x, y - s * 0.20, s * 0.52, fill);
    cCir(g, x + s * 0.55, y, s * 0.40, fill);
    cRR(g, x - s * 0.60, y, s * 1.2, s * 0.45, s * 0.22, fill);
    if (stroke) {
      g.lineWidth = lw || 0.014;
      g.strokeStyle = stroke;
      g.beginPath(); g.arc(x, y - s * 0.20, s * 0.52, PI * 1.05, PI * 1.95); g.stroke();
      g.beginPath(); g.arc(x - s * 0.55, y, s * 0.42, PI * 0.85, PI * 1.6); g.stroke();
      g.beginPath(); g.arc(x + s * 0.55, y, s * 0.40, PI * 1.4, PI * 2.15); g.stroke();
    }
  }

  // 爪：从 (x,y) 朝 angle 方向伸出三趾
  function cClaw(g, x, y, r, angle, color) {
    g.save();
    g.translate(x, y);
    g.rotate(angle);
    g.fillStyle = color;
    for (var i = -1; i <= 1; i++) {
      g.beginPath();
      g.moveTo(i * r * 0.34, r * 0.30);
      g.quadraticCurveTo(i * r * 0.60 + r * 0.12, -r * 0.52, i * r * 0.40 + r * 0.30, -r * 1.05);
      g.quadraticCurveTo(i * r * 0.30 + r * 0.02, -r * 0.45, i * r * 0.18, r * 0.28);
      g.closePath();
      g.fill();
    }
    g.restore();
  }

  // 发光眼（鬼魅 / 妖兽）
  function cSpiritEye(g, x, y, r, color) {
    cGlow(g, x, y, r * 2.8, color, 0.5);
    cEll(g, x, y, r, r * 0.80, 0, color);
    cEll(g, x, y - r * 0.08, r * 0.52, r * 0.42, 0, '#ffffff');
  }

  // 图标底：渐变背景 + 白色圆盘 + 光晕 + 高光弧
  function iconBG(g, base, light) {
    g.fillStyle = cLin(g, 0.15, 0, 0.85, 1, [[0, light], [1, base]]);
    g.fillRect(0, 0, 1, 1);
    g.save();
    g.globalAlpha = 0.16;
    g.fillStyle = '#ffffff';
    g.beginPath(); g.moveTo(0, 0.72); g.lineTo(1, 0.18); g.lineTo(1, 0.42); g.lineTo(0, 0.96); g.closePath(); g.fill();
    g.restore();
    g.save();
    g.shadowColor = 'rgba(50,40,20,.22)'; g.shadowBlur = 0.05; g.shadowOffsetY = 0.018;
    cCir(g, 0.5, 0.545, 0.402, '#ffffff');
    g.restore();
    cCir(g, 0.5, 0.545, 0.378, base);
    g.save();
    g.globalAlpha = 0.55;
    cCir(g, 0.5, 0.49, 0.30, cRad(g, 0.46, 0.40, 0.02, 0.36, [[0, '#ffffff'], [1, 'rgba(255,255,255,0)']]));
    g.restore();
    cCir(g, 0.5, 0.545, 0.394, null, '#ffffff', 0.028);
    g.save();
    g.globalAlpha = 0.5;
    g.strokeStyle = '#ffffff'; g.lineWidth = 0.026;
    g.beginPath(); g.arc(0.5, 0.545, 0.345, PI * 1.08, PI * 1.42); g.stroke();
    g.restore();
  }

  // =========================================================================
  // 2. 十八只异兽圆形图标（id 与顺序见 docs/MYTHOLOGY.md 第 3 节）
  // =========================================================================
  const ICONS = {};

  // 夔牛：苍青单足雷牛，紫电缠身、金色雷纹（无角）
  ICONS.kui = function (g) {
    iconBG(g, '#4a5c80', '#dbe8fb');
    var OL = 'rgba(24,28,50,.62)';
    var BODY = '#6b7fa8', BODYD = '#41527a', LIGHT = '#c3d4ea';
    var PUR = '#b06bff', PURL = '#e0c8ff', GOLD = '#ffd93d';
    // 背后紫电
    g.save();
    g.globalAlpha = 0.95;
    cBolt(g, 0.205, 0.415, 0.185, PUR);
    cBolt(g, 0.83, 0.345, 0.140, PURL);
    g.restore();
    cSpark(g, 0.29, 0.235, 0.030, PURL);
    cSpark(g, 0.76, 0.205, 0.022, PURL);
    cShadow(g, 0.845, 0.195, 0.036, 0.20);
    // 紫电绒尾
    cCurveTaper(g, 0.735, 0.70, 0.855, 0.66, 0.855, 0.545, 0.040, 0.016, BODY, OL, 0.014);
    cCir(g, 0.855, 0.525, 0.045, PUR, '#7a3fbf', 0.012);
    cSpark(g, 0.855, 0.525, 0.055, PURL);
    // 身体（蹲坐）
    cEll(g, 0.5, 0.705, 0.265, 0.16, 0, cRad(g, 0.5, 0.68, 0.02, 0.31, [[0, '#8296bc'], [1, BODYD]]), OL, 0.02);
    cEll(g, 0.5, 0.745, 0.105, 0.075, 0, 'rgba(195,212,234,.55)');
    // 单足 + 金足镯
    cRR(g, 0.438, 0.795, 0.124, 0.085, 0.042, cLin(g, 0.44, 0.79, 0.56, 0.88, [[0, '#7f93b8'], [1, BODYD]]), OL, 0.016);
    g.strokeStyle = '#2f3c5c'; g.lineWidth = 0.012;
    g.beginPath(); g.moveTo(0.5, 0.802); g.lineTo(0.5, 0.872); g.stroke();
    cRR(g, 0.44, 0.792, 0.12, 0.024, 0.012, GOLD, '#b58a00', 0.010);
    // 耳朵
    cEll(g, 0.298, 0.446, 0.082, 0.052, -0.34, BODY, OL, 0.016);
    cEll(g, 0.702, 0.446, 0.082, 0.052, 0.34, BODY, OL, 0.016);
    cEll(g, 0.302, 0.450, 0.044, 0.025, -0.34, '#a07fd0');
    cEll(g, 0.698, 0.450, 0.044, 0.025, 0.34, '#a07fd0');
    // 头顶鬃毛（无角，三簇）
    cShp(g, [[0.435, 0.305], [0.468, 0.245], [0.492, 0.305]], BODYD, OL, 0.012);
    cShp(g, [[0.478, 0.298], [0.512, 0.232], [0.535, 0.300]], PUR, '#7a3fbf', 0.012);
    cShp(g, [[0.520, 0.305], [0.552, 0.252], [0.570, 0.310]], BODYD, OL, 0.012);
    // 头
    cCir(g, 0.5, 0.475, 0.205, cRad(g, 0.43, 0.40, 0.03, 0.30, [[0, '#9cb0d2'], [0.55, BODY], [1, BODYD]]), OL, 0.022);
    // 额头金色雷纹
    g.strokeStyle = GOLD; g.lineWidth = 0.014;
    g.beginPath();
    g.moveTo(0.468, 0.372); g.lineTo(0.532, 0.372); g.lineTo(0.492, 0.402); g.lineTo(0.548, 0.402);
    g.stroke();
    // 口鼻 + 下巴鬃毛
    cEll(g, 0.5, 0.588, 0.152, 0.098, 0, cLin(g, 0.40, 0.53, 0.60, 0.67, [[0, LIGHT], [1, '#a9bcd8']]), OL, 0.016);
    cEll(g, 0.448, 0.575, 0.022, 0.016, 0.22, '#3c4a6a');
    cEll(g, 0.552, 0.575, 0.022, 0.016, -0.22, '#3c4a6a');
    cSmile(g, 0.5, 0.614, 0.048, '#3c4a6a', 0.014);
    cShp(g, [[0.448, 0.672], [0.5, 0.715], [0.552, 0.672]], BODYD, OL, 0.010);
    // 眼睛
    cEye(g, 0.408, 0.462, 0.056, '#fffdf6', PUR, '#2a1838');
    cEye(g, 0.592, 0.462, 0.056, '#fffdf6', PUR, '#2a1838');
    // 怒眉
    g.strokeStyle = '#2a3350'; g.lineWidth = 0.019;
    g.beginPath(); g.moveTo(0.348, 0.398); g.quadraticCurveTo(0.386, 0.382, 0.424, 0.404); g.stroke();
    g.beginPath(); g.moveTo(0.652, 0.398); g.quadraticCurveTo(0.614, 0.382, 0.576, 0.404); g.stroke();
    // 紫电缠绕
    g.save();
    g.strokeStyle = PURL; g.lineWidth = 0.011; g.globalAlpha = 0.9;
    g.beginPath();
    g.moveTo(0.238, 0.645); g.lineTo(0.282, 0.618); g.lineTo(0.252, 0.583); g.lineTo(0.296, 0.556);
    g.stroke();
    g.beginPath();
    g.moveTo(0.762, 0.66); g.lineTo(0.718, 0.632); g.lineTo(0.748, 0.598); g.lineTo(0.704, 0.572);
    g.stroke();
    g.restore();
    // 腮红
    cEll(g, 0.335, 0.545, 0.030, 0.018, 0, 'rgba(240,130,150,.30)');
    cEll(g, 0.665, 0.545, 0.030, 0.018, 0, 'rgba(240,130,150,.30)');
  };

  // 麒麟：青玉鳞身、鹿角金鬃、灵芝尾
  ICONS.qilin = function (g) {
    iconBG(g, '#2f8a74', '#d8fff0');
    var OL = 'rgba(16,58,46,.60)';
    var JADE = '#4fb99f', JADED = '#2f7a66', JADEL = '#b8ecdc', GOLD = '#e8b33a', GOLDD = '#b8841a';
    // 金鬃（头后）
    cCurveTaper(g, 0.47, 0.62, 0.30, 0.56, 0.275, 0.40, 0.045, 0.010, GOLD, GOLDD, 0.010);
    cCurveTaper(g, 0.50, 0.64, 0.32, 0.70, 0.29, 0.78, 0.045, 0.010, GOLD, GOLDD, 0.010);
    cCurveTaper(g, 0.53, 0.62, 0.70, 0.56, 0.725, 0.40, 0.045, 0.010, GOLD, GOLDD, 0.010);
    cCurveTaper(g, 0.52, 0.64, 0.69, 0.70, 0.71, 0.78, 0.042, 0.010, GOLD, GOLDD, 0.010);
    // 鹿角（金色分叉）
    cCurveTaper(g, 0.395, 0.335, 0.335, 0.235, 0.325, 0.145, 0.026, 0.009, GOLD, GOLDD, 0.010);
    cCurveTaper(g, 0.365, 0.255, 0.310, 0.225, 0.285, 0.185, 0.017, 0.006, GOLD, GOLDD, 0.009);
    cCurveTaper(g, 0.345, 0.215, 0.390, 0.180, 0.412, 0.152, 0.014, 0.006, GOLD, GOLDD, 0.009);
    cCurveTaper(g, 0.605, 0.335, 0.665, 0.235, 0.675, 0.145, 0.026, 0.009, GOLD, GOLDD, 0.010);
    cCurveTaper(g, 0.635, 0.255, 0.690, 0.225, 0.715, 0.185, 0.017, 0.006, GOLD, GOLDD, 0.009);
    cCurveTaper(g, 0.655, 0.215, 0.610, 0.180, 0.588, 0.152, 0.014, 0.006, GOLD, GOLDD, 0.009);
    // 耳
    cEll(g, 0.352, 0.402, 0.062, 0.034, -0.50, JADE, OL, 0.012);
    cEll(g, 0.648, 0.402, 0.062, 0.034, 0.50, JADE, OL, 0.012);
    // 四足 + 金蹄
    var legs = [0.335, 0.435, 0.565, 0.665];
    for (var i = 0; i < legs.length; i++) {
      cRR(g, legs[i] - 0.032, 0.79, 0.064, 0.10, 0.028, JADED, OL, 0.012);
      cRR(g, legs[i] - 0.036, 0.862, 0.072, 0.032, 0.014, GOLD, GOLDD, 0.010);
    }
    // 身体 + 鳞纹
    cEll(g, 0.5, 0.705, 0.275, 0.165, 0, cRad(g, 0.47, 0.66, 0.03, 0.32, [[0, '#8fe0c8'], [0.55, JADE], [1, JADED]]), OL, 0.02);
    cScaleRow(g, 0.50, 0.705, 4, 0.030, 'rgba(31,90,74,.55)', 0.010);
    cScaleRow(g, 0.50, 0.755, 3, 0.028, 'rgba(31,90,74,.45)', 0.010);
    cScaleRow(g, 0.43, 0.660, 3, 0.026, 'rgba(184,236,220,.55)', 0.009);
    // 灵芝尾
    g.save();
    g.translate(0.765, 0.705);
    cSwirl(g, 0, 0, 0.045, 1.15, GOLDD, 0.012);
    cCloud(g, 0.012, -0.045, 0.052, GOLD, GOLDD, 0.010);
    g.restore();
    // 头
    cCir(g, 0.5, 0.475, 0.205, cRad(g, 0.43, 0.40, 0.03, 0.30, [[0, JADEL], [0.55, JADE], [1, JADED]]), OL, 0.022);
    // 额前金鬃
    cShp(g, [[0.448, 0.312], [0.478, 0.262], [0.5, 0.318], [0.522, 0.262], [0.552, 0.312]], GOLD, GOLDD, 0.010);
    // 额头玉珠
    cCir(g, 0.5, 0.372, 0.030, GOLD, GOLDD, 0.010);
    cCir(g, 0.5, 0.372, 0.014, '#fff6d8');
    // 颊侧鳞片
    cScaleRow(g, 0.372, 0.512, 2, 0.020, 'rgba(20,70,58,.55)', 0.008);
    cScaleRow(g, 0.628, 0.512, 2, 0.020, 'rgba(20,70,58,.55)', 0.008);
    // 口鼻
    cEll(g, 0.5, 0.582, 0.128, 0.090, 0, '#e8fff6', OL, 0.015);
    cEll(g, 0.458, 0.570, 0.017, 0.012, 0.18, '#2f6a5c');
    cEll(g, 0.542, 0.570, 0.017, 0.012, -0.18, '#2f6a5c');
    cSmile(g, 0.5, 0.604, 0.044, '#2f6a5c', 0.013);
    // 眼（金色虹膜）
    cEye(g, 0.408, 0.462, 0.056, '#fffdf6', GOLD, '#4a3410');
    cEye(g, 0.592, 0.462, 0.056, '#fffdf6', GOLD, '#4a3410');
    // 眉
    g.strokeStyle = '#2f6a5c'; g.lineWidth = 0.015;
    g.beginPath(); g.moveTo(0.352, 0.406); g.quadraticCurveTo(0.386, 0.392, 0.420, 0.408); g.stroke();
    g.beginPath(); g.moveTo(0.648, 0.406); g.quadraticCurveTo(0.614, 0.392, 0.580, 0.408); g.stroke();
    // 金点
    cCir(g, 0.352, 0.552, 0.010, GOLD);
    cCir(g, 0.648, 0.552, 0.010, GOLD);
  };

  // 毕方：独足火鸟，赤羽金喙，翅尖燃焰
  ICONS.bifang = function (g) {
    iconBG(g, '#e8b33a', '#fff6cf');
    var OL = 'rgba(110,40,16,.58)';
    var RED = '#e8453c', REDD = '#b02a20', REDL = '#ff8a6a', GOLD = '#ffd93d', GOLDD = '#c99a10', CREAM = '#ffe6c2';
    cGlow(g, 0.5, 0.60, 0.40, '#ff8a3d', 0.30);
    // 单足 + 爪
    cTaper(g, 0.5, 0.705, 0.5, 0.845, 0.026, 0.015, GOLD, GOLDD, 0.010);
    g.strokeStyle = GOLDD; g.lineWidth = 0.014;
    g.beginPath(); g.moveTo(0.5, 0.845); g.lineTo(0.455, 0.878); g.stroke();
    g.beginPath(); g.moveTo(0.5, 0.845); g.lineTo(0.5, 0.885); g.stroke();
    g.beginPath(); g.moveTo(0.5, 0.845); g.lineTo(0.545, 0.878); g.stroke();
    // 尾羽
    cCurveTaper(g, 0.575, 0.645, 0.78, 0.62, 0.875, 0.435, 0.048, 0.012, RED, REDD, 0.012);
    cCurveTaper(g, 0.575, 0.685, 0.80, 0.735, 0.895, 0.655, 0.042, 0.012, REDD, '#7a1a14', 0.012);
    cCurveTaper(g, 0.60, 0.67, 0.775, 0.70, 0.83, 0.56, 0.030, 0.010, GOLD, GOLDD, 0.010);
    // 双翅（三片羽）+ 翅尖燃焰
    var wings = [
      [[0.44, 0.585], [0.235, 0.525], [0.155, 0.395], [0.30, 0.44], [0.245, 0.305], [0.395, 0.435], [0.44, 0.35], [0.485, 0.525]],
      [[0.56, 0.585], [0.765, 0.525], [0.845, 0.395], [0.70, 0.44], [0.755, 0.305], [0.605, 0.435], [0.56, 0.35], [0.515, 0.525]]
    ];
    for (var w = 0; w < 2; w++) {
      cShp(g, wings[w], cLin(g, 0.5, 0.35, 0.5, 0.60, [[0, REDL], [0.5, RED], [1, REDD]]), OL, 0.014);
      g.save();
      g.globalAlpha = 0.6;
      g.strokeStyle = '#7a1a14'; g.lineWidth = 0.009;
      g.beginPath(); g.moveTo(w === 0 ? 0.42 : 0.58, 0.56); g.lineTo(w === 0 ? 0.23 : 0.77, 0.43); g.stroke();
      g.beginPath(); g.moveTo(w === 0 ? 0.42 : 0.58, 0.55); g.lineTo(w === 0 ? 0.30 : 0.70, 0.32); g.stroke();
      g.restore();
      cFlame(g, w === 0 ? 0.215 : 0.785, 0.395, 0.095, 0.165, GOLD, '#ff8a3d');
      cFlame(g, w === 0 ? 0.17 : 0.83, 0.315, 0.055, 0.105, '#fff0a0', GOLD);
    }
    // 身体 + 奶油胸羽
    cEll(g, 0.5, 0.615, 0.155, 0.185, 0, cRad(g, 0.46, 0.55, 0.02, 0.24, [[0, '#ff9a7a'], [0.55, RED], [1, REDD]]), OL, 0.02);
    cEll(g, 0.5, 0.675, 0.082, 0.115, 0, CREAM);
    cEll(g, 0.5, 0.675, 0.082, 0.115, 0, null, 'rgba(200,120,70,.35)', 0.008);
    // 颈 + 头
    cCurveTaper(g, 0.5, 0.53, 0.48, 0.455, 0.462, 0.405, 0.072, 0.055, RED, REDD, 0.014);
    cCir(g, 0.462, 0.352, 0.108, cRad(g, 0.42, 0.30, 0.02, 0.16, [[0, '#ff9a7a'], [0.6, RED], [1, REDD]]), OL, 0.018);
    // 冠羽（燃焰翎）
    cFlame(g, 0.44, 0.26, 0.075, 0.135, RED, null);
    cFlame(g, 0.49, 0.255, 0.065, 0.15, REDL, null);
    cFlame(g, 0.53, 0.275, 0.055, 0.115, GOLD, null);
    // 金喙
    cShp(g, [[0.375, 0.338], [0.225, 0.362], [0.372, 0.398]], cLin(g, 0.24, 0.33, 0.38, 0.40, [[0, GOLD], [1, GOLDD]]), '#9a7408', 0.012);
    g.strokeStyle = '#9a7408'; g.lineWidth = 0.009;
    g.beginPath(); g.moveTo(0.235, 0.362); g.lineTo(0.372, 0.380); g.stroke();
    // 眼
    cEye(g, 0.437, 0.330, 0.034, '#fffdf6', '#3a2410', '#1c1208');
    cEll(g, 0.525, 0.335, 0.026, 0.016, 0.5, REDL);
    // 火粒
    cSpark(g, 0.30, 0.205, 0.022, GOLD);
    cSpark(g, 0.72, 0.235, 0.018, GOLD);
    cCir(g, 0.26, 0.26, 0.012, '#ff8a3d');
    cCir(g, 0.75, 0.30, 0.010, '#ff8a3d');
  };

  // 玄武：墨绿龟甲金纹，青色蛇颈缠绕
  ICONS.xuanwu = function (g) {
    iconBG(g, '#2f4a3a', '#c8f0dc');
    var OL = 'rgba(8,24,16,.66)';
    var SHELL = '#4f7a5f', SHELLD = '#24402f', SHELLL = '#8fbf9c', GOLD = '#e8b33a', GOLDD = '#a87a1a';
    var SNAKE = '#4fb9c9', SNL = '#a8eef5';
    // 龟足
    cRR(g, 0.245, 0.795, 0.10, 0.075, 0.035, SHELLD, OL, 0.014);
    cRR(g, 0.655, 0.795, 0.10, 0.075, 0.035, SHELLD, OL, 0.014);
    cClaw(g, 0.275, 0.868, 0.022, 0.2, GOLD);
    cClaw(g, 0.725, 0.868, 0.022, -0.2, GOLD);
    // 龟甲
    cEll(g, 0.5, 0.585, 0.255, 0.225, 0, cRad(g, 0.44, 0.49, 0.03, 0.34, [[0, SHELLL], [0.55, SHELL], [1, SHELLD]]), OL, 0.022);
    cEll(g, 0.5, 0.585, 0.255, 0.225, 0, null, GOLD, 0.026);
    cEll(g, 0.5, 0.585, 0.198, 0.172, 0, null, GOLDD, 0.012);
    // 甲纹
    cHex(g, 0.5, 0.585, 0.088, PI / 6, 'rgba(36,64,47,.55)', GOLD, 0.012);
    cHex(g, 0.5, 0.585, 0.040, PI / 6, null, GOLD, 0.010);
    cHex(g, 0.335, 0.505, 0.050, PI / 6, null, GOLD, 0.010);
    cHex(g, 0.665, 0.505, 0.050, PI / 6, null, GOLD, 0.010);
    cHex(g, 0.335, 0.675, 0.050, PI / 6, null, GOLD, 0.010);
    cHex(g, 0.665, 0.675, 0.050, PI / 6, null, GOLD, 0.010);
    cHex(g, 0.5, 0.455, 0.048, PI / 6, null, GOLD, 0.010);
    cHex(g, 0.5, 0.722, 0.048, PI / 6, null, GOLD, 0.010);
    var dots = [[0.27, 0.50], [0.24, 0.585], [0.27, 0.67], [0.73, 0.50], [0.76, 0.585], [0.73, 0.67]];
    for (var i = 0; i < dots.length; i++) cCir(g, dots[i][0], dots[i][1], 0.012, GOLD, GOLDD, 0.006);
    // 龟颈 + 头
    cCurveTaper(g, 0.30, 0.62, 0.245, 0.60, 0.215, 0.575, 0.055, 0.048, SHELL, OL, 0.014);
    cCir(g, 0.215, 0.565, 0.092, cRad(g, 0.19, 0.53, 0.02, 0.14, [[0, SHELLL], [0.6, SHELL], [1, SHELLD]]), OL, 0.018);
    cEye(g, 0.248, 0.548, 0.032, '#fffdf6', GOLD, '#3a2a08');
    cSmile(g, 0.205, 0.598, 0.028, '#1e3828', 0.011);
    cEll(g, 0.185, 0.585, 0.016, 0.010, 0, 'rgba(240,130,150,.28)');
    // 蛇：绕甲
    cCurveTaper(g, 0.79, 0.80, 0.865, 0.62, 0.735, 0.40, 0.042, 0.034, SNAKE, '#1f6a78', 0.012);
    cCurveTaper(g, 0.735, 0.40, 0.70, 0.315, 0.62, 0.285, 0.034, 0.030, SNAKE, '#1f6a78', 0.012);
    cCir(g, 0.80, 0.665, 0.012, GOLD);
    cCir(g, 0.762, 0.50, 0.012, GOLD);
    cCir(g, 0.66, 0.335, 0.011, GOLD);
    // 蛇头
    cEll(g, 0.615, 0.278, 0.075, 0.055, -0.30, cRad(g, 0.60, 0.26, 0.01, 0.10, [[0, SNL], [1, SNAKE]]), '#1f6a78', 0.014);
    cEye(g, 0.588, 0.268, 0.024, '#fffdf6', '#e8453c', '#2a0a0a');
    // 蛇信
    g.strokeStyle = '#e8453c'; g.lineWidth = 0.010;
    g.beginPath(); g.moveTo(0.548, 0.292); g.lineTo(0.50, 0.302); g.stroke();
    g.beginPath(); g.moveTo(0.50, 0.302); g.lineTo(0.478, 0.288); g.stroke();
    g.beginPath(); g.moveTo(0.50, 0.302); g.lineTo(0.482, 0.318); g.stroke();
    // 蛇鳞点
    cCir(g, 0.735, 0.44, 0.008, SNL);
    cCir(g, 0.775, 0.56, 0.008, SNL);
    cCir(g, 0.80, 0.70, 0.008, SNL);
    cSpark(g, 0.84, 0.30, 0.022, SNL);
  };

  // 鹿蜀：白马形、虎纹、赤尾、长耳
  ICONS.lushu = function (g) {
    iconBG(g, '#b8894a', '#f7e6c8');
    var OL = 'rgba(60,42,20,.60)';
    var W = '#f4efe2', WD = '#d9d0bc', TG = '#b8894a', TGD = '#8a6234', RED = '#d0432e', REDD = '#a82a1e', GOLD = '#e8b33a';
    // 赤尾（三缕蓬松尾毛）
    cCurveTaper(g, 0.705, 0.74, 0.845, 0.710, 0.815, 0.385, 0.050, 0.030, cLin(g, 0.71, 0.74, 0.82, 0.38, [[0, RED], [1, REDD]]), '#7a1a14', 0.012);
    cCurveTaper(g, 0.695, 0.755, 0.815, 0.665, 0.865, 0.445, 0.046, 0.020, RED, '#7a1a14', 0.011);
    cCurveTaper(g, 0.690, 0.775, 0.835, 0.775, 0.875, 0.585, 0.042, 0.018, REDD, '#6a140f', 0.011);
    cEll(g, 0.815, 0.395, 0.048, 0.062, -0.25, RED, '#7a1a14', 0.010);
    cEll(g, 0.862, 0.452, 0.040, 0.056, 0.20, REDD, '#6a140f', 0.010);
    cEll(g, 0.868, 0.596, 0.036, 0.050, 0.35, REDD, '#6a140f', 0.010);
    // 身体
    cEll(g, 0.575, 0.735, 0.185, 0.135, 0, cLin(g, 0.5, 0.66, 0.65, 0.84, [[0, W], [1, WD]]), OL, 0.018);
    // 前腿 + 蹄
    cTaper(g, 0.455, 0.795, 0.445, 0.875, 0.030, 0.022, W, OL, 0.012);
    cTaper(g, 0.615, 0.795, 0.625, 0.875, 0.030, 0.022, W, OL, 0.012);
    cRR(g, 0.425, 0.868, 0.040, 0.026, 0.010, TGD, OL, 0.009);
    cRR(g, 0.605, 0.868, 0.040, 0.026, 0.010, TGD, OL, 0.009);
    // 长耳
    cCurveTaper(g, 0.375, 0.345, 0.315, 0.235, 0.305, 0.155, 0.042, 0.014, W, OL, 0.013);
    cCurveTaper(g, 0.535, 0.325, 0.595, 0.215, 0.612, 0.140, 0.042, 0.014, W, OL, 0.013);
    cCurveTaper(g, 0.372, 0.340, 0.325, 0.255, 0.318, 0.195, 0.020, 0.007, TG, null, 0);
    cCurveTaper(g, 0.532, 0.320, 0.585, 0.235, 0.598, 0.180, 0.020, 0.007, TG, null, 0);
    // 颈后鬃毛
    cShp(g, [[0.63, 0.50], [0.70, 0.46], [0.68, 0.545], [0.745, 0.56], [0.665, 0.60], [0.70, 0.655], [0.615, 0.63], [0.625, 0.70], [0.575, 0.64]], TG, TGD, 0.012);
    // 头
    cEll(g, 0.455, 0.475, 0.168, 0.188, -0.10, cRad(g, 0.40, 0.40, 0.03, 0.26, [[0, '#fdfaf1'], [0.6, W], [1, WD]]), OL, 0.022);
    // 虎纹
    g.save();
    g.strokeStyle = TG; g.lineWidth = 0.018; g.lineCap = 'round';
    g.beginPath(); g.moveTo(0.315, 0.512); g.quadraticCurveTo(0.345, 0.505, 0.362, 0.520); g.stroke();
    g.beginPath(); g.moveTo(0.308, 0.552); g.quadraticCurveTo(0.338, 0.548, 0.354, 0.562); g.stroke();
    g.beginPath(); g.moveTo(0.60, 0.475); g.quadraticCurveTo(0.575, 0.49, 0.572, 0.515); g.stroke();
    g.beginPath(); g.moveTo(0.625, 0.51); g.quadraticCurveTo(0.60, 0.525, 0.598, 0.552); g.stroke();
    g.lineWidth = 0.016;
    g.beginPath(); g.moveTo(0.47, 0.755); g.quadraticCurveTo(0.50, 0.74, 0.53, 0.752); g.stroke();
    g.beginPath(); g.moveTo(0.45, 0.795); g.quadraticCurveTo(0.48, 0.782, 0.51, 0.792); g.stroke();
    g.beginPath(); g.moveTo(0.60, 0.78); g.quadraticCurveTo(0.63, 0.768, 0.66, 0.776); g.stroke();
    g.restore();
    // 口鼻
    cEll(g, 0.415, 0.602, 0.118, 0.088, -0.12, '#fbf7ec', OL, 0.015);
    cEll(g, 0.372, 0.582, 0.016, 0.012, 0.18, '#5a3a22');
    cEll(g, 0.452, 0.578, 0.016, 0.012, -0.18, '#5a3a22');
    cSmile(g, 0.405, 0.618, 0.040, '#5a3a22', 0.012);
    // 眼
    cEye(g, 0.392, 0.470, 0.050, '#fffdf6', '#5a3a1a', '#241408');
    cEye(g, 0.532, 0.458, 0.050, '#fffdf6', '#5a3a1a', '#241408');
    // 额间金饰
    cCir(g, 0.455, 0.345, 0.026, GOLD, '#a87a10', 0.008);
    cCir(g, 0.455, 0.345, 0.011, '#fff6d8');
    // 腮红
    cEll(g, 0.345, 0.565, 0.028, 0.016, 0, 'rgba(232,120,110,.28)');
    cEll(g, 0.505, 0.555, 0.024, 0.014, 0, 'rgba(232,120,110,.24)');
  };

  // 蜈蚣精：多节百足、毒颚、触须
  ICONS.wugong = function (g) {
    iconBG(g, '#6b4a34', '#e8c8a0');
    var OL = 'rgba(28,14,6,.66)';
    var B = '#5a3a2a', BL = '#8a5a3a', OCH = '#b8743a', TOX = '#9bd44a', TOXD = '#5f8f22';
    var segs = [
      [0.225, 0.700, 0.052], [0.255, 0.625, 0.062], [0.315, 0.565, 0.072],
      [0.395, 0.525, 0.080], [0.475, 0.515, 0.086], [0.545, 0.535, 0.092]
    ];
    // 百足
    g.strokeStyle = BL; g.lineWidth = 0.014;
    for (var i = 0; i < segs.length; i++) {
      var sx = segs[i][0], sy = segs[i][1], sr = segs[i][2];
      for (var k = 0; k < 2; k++) {
        var side = k === 0 ? -1 : 1;
        g.beginPath();
        g.moveTo(sx + side * sr * 0.5, sy + sr * 0.4);
        g.quadraticCurveTo(sx + side * (sr + 0.055), sy + sr * 0.55 + 0.015, sx + side * (sr + 0.05), sy + sr * 0.55 + 0.075);
        g.stroke();
        cCir(g, sx + side * (sr + 0.05), sy + sr * 0.55 + 0.075, 0.011, TOX);
      }
    }
    // 体节
    for (var j = segs.length - 1; j >= 0; j--) {
      var x = segs[j][0], y = segs[j][1], r = segs[j][2];
      cCir(g, x, y, r, cRad(g, x - r * 0.35, y - r * 0.4, 0.01, r * 1.4, [[0, '#d99a5e'], [0.6, OCH], [1, B]]), OL, 0.014);
      cCir(g, x, y, r * 0.58, null, 'rgba(90,58,42,.65)', 0.010);
      cCir(g, x - r * 0.22, y - r * 0.28, r * 0.22, TOX);
      cCir(g, x - r * 0.22, y - r * 0.28, r * 0.10, TOXD);
    }
    // 尾刺
    cShp(g, [[0.195, 0.705], [0.135, 0.745], [0.20, 0.762]], TOXD, '#3a5a14', 0.010);
    // 头
    cCir(g, 0.615, 0.585, 0.150, cRad(g, 0.57, 0.52, 0.02, 0.20, [[0, '#a8744a'], [0.6, B], [1, '#3a2416']]), OL, 0.02);
    cCir(g, 0.615, 0.585, 0.150, null, 'rgba(155,212,74,.30)', 0.016);
    // 触须
    g.strokeStyle = TOXD; g.lineWidth = 0.012;
    g.beginPath(); g.moveTo(0.575, 0.455); g.quadraticCurveTo(0.535, 0.395, 0.555, 0.335); g.stroke();
    g.beginPath(); g.moveTo(0.655, 0.455); g.quadraticCurveTo(0.705, 0.40, 0.685, 0.335); g.stroke();
    cCir(g, 0.555, 0.328, 0.016, TOX, TOXD, 0.007);
    cCir(g, 0.685, 0.328, 0.016, TOX, TOXD, 0.007);
    // 毒颚
    cCurveTaper(g, 0.555, 0.695, 0.47, 0.745, 0.445, 0.700, 0.020, 0.006, TOXD, '#3a5a14', 0.009);
    cCurveTaper(g, 0.675, 0.695, 0.755, 0.745, 0.775, 0.700, 0.020, 0.006, TOXD, '#3a5a14', 0.009);
    cCir(g, 0.442, 0.708, 0.012, TOX);
    cCir(g, 0.778, 0.708, 0.012, TOX);
    // 复眼
    cEye(g, 0.568, 0.565, 0.046, '#f4ffd8', TOX, '#1f2a0a');
    cEye(g, 0.662, 0.565, 0.046, '#f4ffd8', TOX, '#1f2a0a');
    cCir(g, 0.605, 0.505, 0.014, TOX);
    cCir(g, 0.628, 0.500, 0.010, TOX);
    cCir(g, 0.583, 0.500, 0.010, TOX);
    // 口器
    cEll(g, 0.615, 0.635, 0.045, 0.024, 0, '#2a1a10', 'rgba(155,212,74,.5)', 0.010);
    cCir(g, 0.51, 0.735, 0.014, TOX);
    cCir(g, 0.72, 0.735, 0.012, TOX);
    cEll(g, 0.515, 0.640, 0.020, 0.012, 0, 'rgba(155,212,74,.35)');
    cEll(g, 0.715, 0.640, 0.020, 0.012, 0, 'rgba(155,212,74,.35)');
  };

  // 鸩鸟：毒紫毒羽、金喙、赤目、长尾羽
  ICONS.zhen = function (g) {
    iconBG(g, '#4a2f6a', '#d8c4f2');
    var OL = 'rgba(20,8,36,.66)';
    var PUR = '#8a5fbf', PURL = '#c8a8ee', PURD = '#4a2f6a', GOLD = '#ffd93d', GOLDD = '#c99a10', RED = '#e8453c', TOX = '#9bd44a';
    // 长尾羽
    cCurveTaper(g, 0.575, 0.665, 0.78, 0.70, 0.86, 0.565, 0.048, 0.014, PUR, PURD, 0.012);
    cCurveTaper(g, 0.59, 0.685, 0.81, 0.775, 0.865, 0.73, 0.042, 0.012, PURD, '#2a1640', 0.012);
    cCurveTaper(g, 0.60, 0.655, 0.80, 0.62, 0.86, 0.455, 0.036, 0.012, PURL, PURD, 0.010);
    // 毒雾
    cCir(g, 0.79, 0.34, 0.030, 'rgba(155,212,74,.22)');
    cCir(g, 0.835, 0.39, 0.020, 'rgba(200,168,238,.30)');
    cCir(g, 0.74, 0.28, 0.016, 'rgba(200,168,238,.35)');
    // 薄翅
    g.save();
    g.globalAlpha = 0.55;
    cEll(g, 0.345, 0.545, 0.135, 0.075, -0.55, '#e8dcff', '#b8a0d8', 0.012);
    g.restore();
    // 身体 + 腹羽
    cEll(g, 0.5, 0.62, 0.155, 0.175, 0, cRad(g, 0.46, 0.56, 0.02, 0.23, [[0, '#b48ae0'], [0.55, PUR], [1, PURD]]), OL, 0.02);
    cEll(g, 0.5, 0.68, 0.085, 0.105, 0, PURL);
    // 折叠翅
    cShp(g, [[0.56, 0.60], [0.72, 0.62], [0.76, 0.72], [0.64, 0.70]], PURD, '#2a1640', 0.012);
    g.strokeStyle = 'rgba(200,168,238,.6)'; g.lineWidth = 0.009;
    g.beginPath(); g.moveTo(0.60, 0.615); g.lineTo(0.70, 0.655); g.stroke();
    g.beginPath(); g.moveTo(0.59, 0.635); g.lineTo(0.685, 0.685); g.stroke();
    // 颈 + 头
    cCurveTaper(g, 0.49, 0.50, 0.465, 0.45, 0.455, 0.405, 0.062, 0.052, PUR, PURD, 0.014);
    cCir(g, 0.455, 0.355, 0.115, cRad(g, 0.42, 0.30, 0.02, 0.17, [[0, '#c8a8ee'], [0.55, PUR], [1, PURD]]), OL, 0.018);
    // 冠羽
    cCurveTaper(g, 0.44, 0.27, 0.435, 0.205, 0.47, 0.17, 0.024, 0.007, PURD, '#2a1640', 0.009);
    cCurveTaper(g, 0.475, 0.26, 0.50, 0.195, 0.545, 0.175, 0.022, 0.007, PUR, PURD, 0.009);
    cCurveTaper(g, 0.505, 0.275, 0.555, 0.225, 0.60, 0.215, 0.018, 0.006, PURL, PURD, 0.009);
    // 金喙
    cShp(g, [[0.372, 0.342], [0.235, 0.368], [0.372, 0.402]], cLin(g, 0.25, 0.34, 0.38, 0.40, [[0, GOLD], [1, GOLDD]]), '#9a7408', 0.011);
    g.strokeStyle = '#9a7408'; g.lineWidth = 0.008;
    g.beginPath(); g.moveTo(0.245, 0.368); g.lineTo(0.372, 0.385); g.stroke();
    // 赤目
    cGlow(g, 0.43, 0.335, 0.075, RED, 0.35);
    cEye(g, 0.43, 0.335, 0.034, '#fffdf6', RED, '#3a0a08');
    cCir(g, 0.535, 0.345, 0.013, RED);
    cCir(g, 0.56, 0.315, 0.009, RED);
    // 爪
    cTaper(g, 0.47, 0.785, 0.455, 0.855, 0.018, 0.012, GOLD, GOLDD, 0.008);
    cTaper(g, 0.53, 0.785, 0.545, 0.855, 0.018, 0.012, GOLD, GOLDD, 0.008);
    cClaw(g, 0.455, 0.862, 0.018, 0.2, GOLDD);
    cClaw(g, 0.545, 0.862, 0.018, -0.2, GOLDD);
    // 毒点
    cCir(g, 0.335, 0.29, 0.012, TOX);
    cCir(g, 0.70, 0.245, 0.010, TOX);
  };

  // 木魅：树桩妖，苔绿树冠、树皮脸、根须手
  ICONS.mumei = function (g) {
    iconBG(g, '#c9a86a', '#f7ecd2');
    var OL = 'rgba(40,26,12,.62)';
    var BARK = '#6a4a2e', BARKD = '#4a321e', BARKL = '#9a7048';
    var MOSS = '#7ec850', MOSSD = '#4e9c3f', MOSSY = '#c8f080';
    // 根须手
    cCurveTaper(g, 0.335, 0.74, 0.245, 0.775, 0.195, 0.695, 0.030, 0.016, BARK, BARKD, 0.011);
    cCurveTaper(g, 0.665, 0.74, 0.755, 0.775, 0.805, 0.695, 0.030, 0.016, BARK, BARKD, 0.011);
    cTaper(g, 0.20, 0.70, 0.165, 0.655, 0.011, 0.004, BARK, BARKD, 0.006);
    cTaper(g, 0.195, 0.70, 0.19, 0.64, 0.011, 0.004, BARK, BARKD, 0.006);
    cTaper(g, 0.20, 0.705, 0.235, 0.65, 0.010, 0.004, BARK, BARKD, 0.006);
    cTaper(g, 0.80, 0.70, 0.835, 0.655, 0.011, 0.004, BARK, BARKD, 0.006);
    cTaper(g, 0.805, 0.70, 0.81, 0.64, 0.011, 0.004, BARK, BARKD, 0.006);
    cTaper(g, 0.80, 0.705, 0.765, 0.65, 0.010, 0.004, BARK, BARKD, 0.006);
    // 树桩身体
    cRR(g, 0.335, 0.44, 0.33, 0.40, 0.16, cLin(g, 0.34, 0.44, 0.67, 0.84, [[0, BARKL], [0.5, BARK], [1, BARKD]]), OL, 0.02);
    // 树皮纹理
    g.strokeStyle = BARKD; g.lineWidth = 0.010;
    for (var i = 0; i < 6; i++) {
      var x = 0.375 + i * 0.045;
      g.beginPath();
      g.moveTo(x, 0.48 + (i % 2) * 0.03);
      g.quadraticCurveTo(x + 0.012, 0.62, x - 0.006, 0.80);
      g.stroke();
    }
    g.strokeStyle = 'rgba(154,112,72,.55)'; g.lineWidth = 0.012;
    g.beginPath(); g.arc(0.5, 0.50, 0.13, PI * 1.15, PI * 1.85); g.stroke();
    // 苔绿树冠
    cCir(g, 0.365, 0.415, 0.105, MOSS, MOSSD, 0.014);
    cCir(g, 0.5, 0.375, 0.135, cRad(g, 0.47, 0.33, 0.01, 0.16, [[0, MOSSY], [0.6, MOSS], [1, MOSSD]]), MOSSD, 0.014);
    cCir(g, 0.635, 0.415, 0.105, MOSS, MOSSD, 0.014);
    cCir(g, 0.43, 0.335, 0.070, MOSSY, MOSSD, 0.010);
    cCir(g, 0.575, 0.325, 0.062, MOSSY, MOSSD, 0.010);
    cCir(g, 0.45, 0.315, 0.016, '#eaffc0');
    cCir(g, 0.60, 0.31, 0.012, '#eaffc0');
    cEll(g, 0.72, 0.36, 0.030, 0.016, 0.8, MOSS, MOSSD, 0.009);
    cEll(g, 0.285, 0.345, 0.028, 0.015, -0.7, MOSS, MOSSD, 0.009);
    // 树皮脸：眼窝 + 发光眼
    cEll(g, 0.44, 0.575, 0.062, 0.072, 0, '#2a1a0e', BARKD, 0.012);
    cEll(g, 0.56, 0.575, 0.062, 0.072, 0, '#2a1a0e', BARKD, 0.012);
    cEll(g, 0.44, 0.578, 0.034, 0.040, 0, MOSSY);
    cEll(g, 0.56, 0.578, 0.034, 0.040, 0, MOSSY);
    cCir(g, 0.44, 0.575, 0.014, '#2a4a10');
    cCir(g, 0.56, 0.575, 0.014, '#2a4a10');
    cCir(g, 0.43, 0.565, 0.008, '#ffffff');
    cCir(g, 0.55, 0.565, 0.008, '#ffffff');
    // 苔眉
    cEll(g, 0.44, 0.515, 0.055, 0.018, -0.08, MOSS, MOSSD, 0.008);
    cEll(g, 0.56, 0.515, 0.055, 0.018, 0.08, MOSS, MOSSD, 0.008);
    // 树洞嘴
    cEll(g, 0.5, 0.685, 0.055, 0.035, 0, '#241408', BARKD, 0.010);
    cEll(g, 0.5, 0.692, 0.030, 0.014, 0, MOSSY);
    // 年轮
    cCir(g, 0.5, 0.79, 0.085, null, 'rgba(74,50,30,.55)', 0.012);
    cCir(g, 0.5, 0.79, 0.045, null, 'rgba(74,50,30,.45)', 0.010);
    // 小蘑菇
    cEll(g, 0.72, 0.80, 0.022, 0.016, 0, '#e8d0a8', '#8a6234', 0.007);
    cCir(g, 0.72, 0.782, 0.026, '#d0432e', '#8a2018', 0.008);
    cCir(g, 0.715, 0.776, 0.006, '#ffe0d0');
    // 苔斑
    cCir(g, 0.36, 0.79, 0.012, MOSS);
    cCir(g, 0.64, 0.815, 0.010, MOSS);
  };

  // 玄蜂：玄黑巨蜂、金环纹、毒针、灰蓝薄翅
  ICONS.xuanfeng = function (g) {
    iconBG(g, '#e8b33a', '#fff6cf');
    var OL = 'rgba(30,24,10,.66)';
    var BLK = '#2b2b36', BLKL = '#4a4a5c', GOLD = '#e8b33a', GOLDD = '#a87a1a', WING = '#9fb8d8', TOX = '#b57ad8';
    // 四片薄翅
    g.save();
    g.globalAlpha = 0.58;
    cEll(g, 0.30, 0.40, 0.155, 0.078, -0.55, WING, '#6a86a8', 0.014);
    cEll(g, 0.70, 0.40, 0.155, 0.078, 0.55, WING, '#6a86a8', 0.014);
    cEll(g, 0.33, 0.625, 0.135, 0.066, -0.22, WING, '#6a86a8', 0.012);
    cEll(g, 0.67, 0.625, 0.135, 0.066, 0.22, WING, '#6a86a8', 0.012);
    g.restore();
    g.save();
    g.globalAlpha = 0.38; g.strokeStyle = '#4a6384'; g.lineWidth = 0.008;
    g.beginPath(); g.moveTo(0.37, 0.44); g.lineTo(0.22, 0.335); g.stroke();
    g.beginPath(); g.moveTo(0.63, 0.44); g.lineTo(0.78, 0.335); g.stroke();
    g.beginPath(); g.moveTo(0.37, 0.63); g.lineTo(0.235, 0.60); g.stroke();
    g.beginPath(); g.moveTo(0.63, 0.63); g.lineTo(0.765, 0.60); g.stroke();
    g.restore();
    // 六足（玄黑 + 金节）
    var legs = [[0.43, 0.66, -1], [0.57, 0.66, 1], [0.44, 0.735, -1], [0.56, 0.735, 1], [0.455, 0.80, -1], [0.545, 0.80, 1]];
    for (var li = 0; li < legs.length; li++) {
      var lx = legs[li][0], ly = legs[li][1], sd = legs[li][2];
      g.strokeStyle = BLK; g.lineWidth = 0.016;
      g.beginPath();
      g.moveTo(lx, ly);
      g.lineTo(lx + sd * 0.055, ly + 0.035);
      g.lineTo(lx + sd * 0.075, ly + 0.085);
      g.stroke();
      cCir(g, lx + sd * 0.055, ly + 0.035, 0.012, GOLD, GOLDD, 0.005);
    }
    // 毒针
    cShp(g, [[0.468, 0.855], [0.5, 0.928], [0.532, 0.855]], TOX, '#6a3a8f', 0.010);
    cShp(g, [[0.478, 0.852], [0.5, 0.888], [0.522, 0.852]], '#e0c0f8', null, 0);
    // 腹部 + 金环纹
    cEll(g, 0.5, 0.735, 0.172, 0.135, 0, cRad(g, 0.44, 0.68, 0.02, 0.24, [[0, BLKL], [0.55, BLK], [1, '#17171f']]), OL, 0.018);
    cEll(g, 0.5, 0.700, 0.150, 0.019, 0, GOLD, GOLDD, 0.006);
    cEll(g, 0.5, 0.742, 0.163, 0.019, 0, GOLD, GOLDD, 0.006);
    cEll(g, 0.5, 0.784, 0.142, 0.018, 0, GOLD, GOLDD, 0.006);
    // 胸节 + 金纹
    cEll(g, 0.5, 0.615, 0.132, 0.078, 0, cLin(g, 0.5, 0.55, 0.5, 0.69, [[0, BLKL], [1, BLK]]), OL, 0.014);
    cShp(g, [[0.5, 0.565], [0.552, 0.615], [0.5, 0.668], [0.448, 0.615]], null, GOLD, 0.010);
    cCir(g, 0.5, 0.615, 0.016, GOLD);
    // 触角
    g.strokeStyle = BLK; g.lineWidth = 0.014;
    g.beginPath(); g.moveTo(0.44, 0.305); g.quadraticCurveTo(0.375, 0.235, 0.40, 0.185); g.stroke();
    g.beginPath(); g.moveTo(0.56, 0.305); g.quadraticCurveTo(0.625, 0.235, 0.60, 0.185); g.stroke();
    cCir(g, 0.40, 0.178, 0.018, GOLD, GOLDD, 0.006);
    cCir(g, 0.60, 0.178, 0.018, GOLD, GOLDD, 0.006);
    // 头
    cCir(g, 0.5, 0.415, 0.155, cRad(g, 0.44, 0.35, 0.02, 0.21, [[0, BLKL], [0.6, BLK], [1, '#17171f']]), OL, 0.02);
    // 金环纹（头）
    g.strokeStyle = GOLD; g.lineWidth = 0.012;
    g.beginPath(); g.arc(0.5, 0.415, 0.148, PI * 1.10, PI * 1.90); g.stroke();
    // 复眼（金）
    cEll(g, 0.425, 0.400, 0.058, 0.072, -0.20, cLin(g, 0.39, 0.34, 0.47, 0.47, [[0, '#ffe9a0'], [0.55, GOLD], [1, GOLDD]]), '#7a5a08', 0.012);
    cEll(g, 0.575, 0.400, 0.058, 0.072, 0.20, cLin(g, 0.61, 0.34, 0.53, 0.47, [[0, '#ffe9a0'], [0.55, GOLD], [1, GOLDD]]), '#7a5a08', 0.012);
    cCir(g, 0.415, 0.392, 0.020, '#2a2010');
    cCir(g, 0.585, 0.392, 0.020, '#2a2010');
    cCir(g, 0.408, 0.382, 0.008, '#ffffff');
    cCir(g, 0.578, 0.382, 0.008, '#ffffff');
    // 金颚
    cShp(g, [[0.452, 0.478], [0.5, 0.508], [0.548, 0.478]], GOLD, GOLDD, 0.008);
    cSmile(g, 0.5, 0.495, 0.030, '#1a1a20', 0.010);
    // 毒紫光点
    cCir(g, 0.34, 0.72, 0.011, TOX);
    cCir(g, 0.66, 0.72, 0.010, TOX);
  };

  // 狰：赤豹、独角、五尾、獠牙、骨白鬃毛
  ICONS.zheng = function (g) {
    iconBG(g, '#a8643a', '#f2d8b8');
    var OL = 'rgba(52,18,8,.64)';
    var RUST = '#c2452e', RUSTD = '#8a2c1c', BONE = '#f0e6d2', BONED = '#cbbd9f', GOLD = '#e8b33a', DARK = '#3a140c';
    // 五尾
    var tails = [
      [0.86, 0.73, 0.045], [0.885, 0.60, 0.042], [0.86, 0.465, 0.040], [0.80, 0.365, 0.036], [0.70, 0.315, 0.032]
    ];
    for (var ti = 0; ti < tails.length; ti++) {
      var ex = tails[ti][0], ey = tails[ti][1], ew = tails[ti][2];
      cCurveTaper(g, 0.60, 0.715, 0.76, 0.70, ex, ey, 0.042, ew, cLin(g, 0.60, 0.72, ex, ey, [[0, RUST], [0.7, RUSTD], [1, '#5a1a10']]), '#4a120a', 0.010);
      cCir(g, ex, ey, ew * 0.9, BONE, BONED, 0.006);
    }
    // 身体
    cEll(g, 0.5, 0.715, 0.265, 0.145, 0, cLin(g, 0.5, 0.64, 0.5, 0.86, [[0, RUST], [1, RUSTD]]), OL, 0.018);
    // 鬃毛（骨白尖刺）
    for (var mi = 0; mi < 9; mi++) {
      var ma = PI * 1.12 + mi * (PI * 0.76 / 8);
      var bx = 0.47 + Math.cos(ma) * 0.185;
      var by = 0.50 + Math.sin(ma) * 0.185;
      var tipx = 0.47 + Math.cos(ma) * 0.285;
      var tipy = 0.50 + Math.sin(ma) * 0.285;
      var nx = -Math.sin(ma) * 0.030, ny = Math.cos(ma) * 0.030;
      cShp(g, [[bx + nx, by + ny], [tipx, tipy], [bx - nx, by - ny]], mi % 2 ? BONE : BONED, '#9a8a6a', 0.008);
    }
    // 独脚 + 骨环
    cCurveTaper(g, 0.47, 0.345, 0.40, 0.245, 0.365, 0.155, 0.032, 0.010, BONE, BONED, 0.012);
    g.strokeStyle = 'rgba(160,140,110,.8)'; g.lineWidth = 0.008;
    g.beginPath(); g.moveTo(0.452, 0.302); g.lineTo(0.392, 0.278); g.stroke();
    g.beginPath(); g.moveTo(0.43, 0.262); g.lineTo(0.378, 0.238); g.stroke();
    cCir(g, 0.47, 0.345, 0.035, GOLD, '#a87a10', 0.009);
    // 耳
    cShp(g, [[0.325, 0.42], [0.285, 0.285], [0.395, 0.365]], RUST, OL, 0.012);
    cShp(g, [[0.675, 0.42], [0.715, 0.285], [0.605, 0.365]], RUST, OL, 0.012);
    cShp(g, [[0.335, 0.408], [0.312, 0.325], [0.383, 0.373]], BONED, null, 0);
    cShp(g, [[0.665, 0.408], [0.688, 0.325], [0.617, 0.373]], BONED, null, 0);
    // 头
    cCir(g, 0.47, 0.495, 0.205, cRad(g, 0.40, 0.42, 0.03, 0.30, [[0, '#e0705a'], [0.55, RUST], [1, RUSTD]]), OL, 0.022);
    // 面颊骨白
    cEll(g, 0.415, 0.565, 0.075, 0.060, -0.10, BONE, BONED, 0.012);
    cEll(g, 0.535, 0.565, 0.075, 0.060, 0.10, BONE, BONED, 0.012);
    // 豹斑
    var spots = [[0.33, 0.44, 0.018], [0.60, 0.43, 0.016], [0.325, 0.60, 0.014], [0.61, 0.585, 0.015], [0.42, 0.72, 0.016], [0.56, 0.735, 0.014]];
    for (var si = 0; si < spots.length; si++) {
      cCir(g, spots[si][0], spots[si][1], spots[si][2], null, 'rgba(74,18,10,.7)', 0.008);
      cCir(g, spots[si][0], spots[si][1], spots[si][2] * 0.45, 'rgba(74,18,10,.45)');
    }
    // 鼻 + 大口獠牙
    cShp(g, [[0.47, 0.535], [0.445, 0.578], [0.495, 0.578]], RUSTD, null, 0);
    cShp(g, [[0.375, 0.618], [0.5, 0.672], [0.625, 0.618], [0.6, 0.60], [0.5, 0.632], [0.40, 0.60]], DARK, '#2a0a06', 0.010);
    // 上獠牙
    cShp(g, [[0.398, 0.622], [0.418, 0.672], [0.438, 0.622]], BONE, BONED, 0.008);
    cShp(g, [[0.562, 0.622], [0.582, 0.672], [0.602, 0.622]], BONE, BONED, 0.008);
    // 下獠牙
    cShp(g, [[0.435, 0.655], [0.455, 0.708], [0.475, 0.655]], BONE, BONED, 0.007);
    cShp(g, [[0.525, 0.655], [0.545, 0.708], [0.565, 0.655]], BONE, BONED, 0.007);
    // 眼（金瞳 + 竖瞳）
    cEye(g, 0.398, 0.492, 0.050, '#fffdf6', GOLD, '#2a1a06');
    cEye(g, 0.542, 0.492, 0.050, '#fffdf6', GOLD, '#2a1a06');
    g.fillStyle = '#1a0e04';
    cEll(g, 0.398, 0.498, 0.010, 0.026, 0, '#1a0e04');
    cEll(g, 0.542, 0.498, 0.010, 0.026, 0, '#1a0e04');
    // 怒眉
    g.strokeStyle = '#4a120a'; g.lineWidth = 0.020;
    g.beginPath(); g.moveTo(0.335, 0.435); g.quadraticCurveTo(0.375, 0.418, 0.415, 0.440); g.stroke();
    g.beginPath(); g.moveTo(0.605, 0.435); g.quadraticCurveTo(0.565, 0.418, 0.525, 0.440); g.stroke();
    // 爪
    cClaw(g, 0.285, 0.79, 0.026, 1.9, BONE);
    cClaw(g, 0.715, 0.79, 0.026, -1.9, BONE);
  };

  // 九尾狐：白狐、九条飘尾、金瞳、额间朱纹
  ICONS.jiuwei = function (g) {
    iconBG(g, '#d8a24a', '#fff3cc');
    var OL = 'rgba(120,86,30,.55)';
    var WHITE = '#f4f1e8', WHITED = '#ded6c2', RED = '#e8453c', REDD = '#b32a22', GOLD = '#e8b33a', GOLDD = '#a87a10';
    // 九条尾（自左向右扇形，蓬松白尾 + 赤尾尖）
    for (var i = 0; i < 9; i++) {
      var ang = PI * 0.985 - i * (PI * 0.97 / 8);
      var bx = 0.5, by = 0.695;
      var rad = 0.325 + Math.sin(ang) * 0.062;
      var mx = bx + Math.cos(ang + 0.13) * 0.185;
      var my = by + Math.sin(ang + 0.13) * 0.185;
      var ex = bx + Math.cos(ang) * rad;
      var ey = by + Math.sin(ang) * rad;
      var w0 = 0.058, w1 = 0.034;
      cCurveTaper(g, bx, by, mx, my, ex, ey, w0, w1,
        cLin(g, bx, by, ex, ey, [[0, '#ffffff'], [0.52, WHITE], [0.80, '#ffe2cf'], [1, RED]]),
        'rgba(150,120,70,.45)', 0.007);
      cCir(g, ex, ey, w1 * 0.80, RED, REDD, 0.005);
    }
    // 身体 + 前爪
    cEll(g, 0.5, 0.775, 0.135, 0.095, 0, cLin(g, 0.5, 0.72, 0.5, 0.86, [[0, WHITE], [1, WHITED]]), OL, 0.014);
    cCir(g, 0.415, 0.845, 0.045, WHITE, OL, 0.012);
    cCir(g, 0.585, 0.845, 0.045, WHITE, OL, 0.012);
    // 耳（尖耳 + 赤内耳）
    cShp(g, [[0.345, 0.44], [0.315, 0.285], [0.44, 0.375]], WHITE, OL, 0.014);
    cShp(g, [[0.655, 0.44], [0.685, 0.285], [0.56, 0.375]], WHITE, OL, 0.014);
    cShp(g, [[0.36, 0.428], [0.342, 0.325], [0.42, 0.385]], RED, null, 0);
    cShp(g, [[0.64, 0.428], [0.658, 0.325], [0.58, 0.385]], RED, null, 0);
    // 头
    cCir(g, 0.5, 0.515, 0.168, cRad(g, 0.44, 0.45, 0.02, 0.25, [[0, '#ffffff'], [0.6, WHITE], [1, WHITED]]), OL, 0.02);
    // 额间朱纹（三瓣花钿）
    cCir(g, 0.5, 0.398, 0.022, RED, REDD, 0.006);
    cCir(g, 0.462, 0.418, 0.014, RED, REDD, 0.005);
    cCir(g, 0.538, 0.418, 0.014, RED, REDD, 0.005);
    // 口鼻
    cEll(g, 0.5, 0.60, 0.098, 0.072, 0, '#fffdf6', OL, 0.012);
    cCir(g, 0.5, 0.565, 0.020, '#3a2a1a');
    cCir(g, 0.5, 0.565, 0.008, '#ffffff');
    cSmile(g, 0.5, 0.612, 0.038, '#5a4030', 0.012);
    cShp(g, [[0.478, 0.626], [0.492, 0.652], [0.506, 0.626]], '#ffffff', '#c8b090', 0.005);
    // 金瞳（竖瞳）
    cEye(g, 0.435, 0.512, 0.048, '#fffdf6', GOLD, '#4a3408');
    cEye(g, 0.565, 0.512, 0.048, '#fffdf6', GOLD, '#4a3408');
    cEll(g, 0.435, 0.518, 0.009, 0.024, 0, '#2a1a04');
    cEll(g, 0.565, 0.518, 0.009, 0.024, 0, '#2a1a04');
    // 眼线
    g.strokeStyle = RED; g.lineWidth = 0.010;
    g.beginPath(); g.moveTo(0.388, 0.488); g.quadraticCurveTo(0.42, 0.478, 0.452, 0.492); g.stroke();
    g.beginPath(); g.moveTo(0.612, 0.488); g.quadraticCurveTo(0.58, 0.478, 0.548, 0.492); g.stroke();
    // 胡须
    g.strokeStyle = 'rgba(120,90,60,.55)'; g.lineWidth = 0.008;
    g.beginPath(); g.moveTo(0.40, 0.60); g.lineTo(0.335, 0.592); g.stroke();
    g.beginPath(); g.moveTo(0.40, 0.62); g.lineTo(0.335, 0.628); g.stroke();
    g.beginPath(); g.moveTo(0.60, 0.60); g.lineTo(0.665, 0.592); g.stroke();
    g.beginPath(); g.moveTo(0.60, 0.62); g.lineTo(0.665, 0.628); g.stroke();
    // 赤金点缀
    cSpark(g, 0.80, 0.30, 0.022, '#fff2c0');
    cSpark(g, 0.22, 0.36, 0.018, '#fff2c0');
    cEll(g, 0.365, 0.565, 0.020, 0.012, 0, 'rgba(232,110,100,.30)');
    cEll(g, 0.635, 0.565, 0.020, 0.012, 0, 'rgba(232,110,100,.30)');
  };

  // 鲛人：人鱼、长发、鳞尾、珠光、张口吟唱
  ICONS.jiaoren = function (g) {
    iconBG(g, '#1f6f7f', '#c8fff8');
    var OL = 'rgba(8,40,44,.58)';
    var SKIN = '#e8f4ee', SKIND = '#c4dcd4', SCALE = '#4fb9c9', SCALED = '#2f8a99', PEARL = '#fff6e0', GOLD = '#e8b33a', HAIR = '#2f7a8a';
    // 长发（身后）
    cCurveTaper(g, 0.40, 0.44, 0.27, 0.52, 0.245, 0.70, 0.075, 0.035, HAIR, '#1a525e', 0.012);
    cCurveTaper(g, 0.60, 0.44, 0.73, 0.52, 0.755, 0.70, 0.075, 0.035, HAIR, '#1a525e', 0.012);
    cCurveTaper(g, 0.44, 0.40, 0.35, 0.66, 0.36, 0.80, 0.055, 0.024, '#3f95a6', '#1a525e', 0.010);
    cCurveTaper(g, 0.56, 0.40, 0.65, 0.66, 0.64, 0.80, 0.055, 0.024, '#3f95a6', '#1a525e', 0.010);
    // 鳞尾（右下方缠绕）
    cCurveTaper(g, 0.50, 0.80, 0.72, 0.90, 0.865, 0.76, 0.075, 0.045, cLin(g, 0.5, 0.82, 0.86, 0.76, [[0, SCALE], [1, SCALED]]), '#1f6a78', 0.014);
    // 尾鳍
    cShp(g, [[0.855, 0.735], [0.905, 0.665], [0.875, 0.745], [0.915, 0.795], [0.855, 0.775]], 'rgba(168,238,245,.8)', '#2f8a99', 0.010);
    // 鳞纹
    cScaleRow(g, 0.62, 0.84, 3, 0.018, 'rgba(255,255,255,.55)', 0.008);
    cScaleRow(g, 0.74, 0.81, 2, 0.016, 'rgba(255,255,255,.5)', 0.008);
    // 身体
    cEll(g, 0.5, 0.71, 0.145, 0.125, 0, cLin(g, 0.5, 0.64, 0.5, 0.84, [[0, SKIN], [1, SKIND]]), OL, 0.014);
    // 肩
    cEll(g, 0.365, 0.665, 0.075, 0.055, -0.25, SKIN, OL, 0.012);
    cEll(g, 0.635, 0.665, 0.075, 0.055, 0.25, SKIN, OL, 0.012);
    // 贝壳胸饰
    cShp(g, [[0.44, 0.655], [0.5, 0.70], [0.56, 0.655], [0.53, 0.72], [0.5, 0.735], [0.47, 0.72]], PEARL, GOLD, 0.010);
    g.strokeStyle = 'rgba(200,160,80,.55)'; g.lineWidth = 0.007;
    g.beginPath(); g.moveTo(0.5, 0.70); g.lineTo(0.47, 0.665); g.stroke();
    g.beginPath(); g.moveTo(0.5, 0.70); g.lineTo(0.53, 0.665); g.stroke();
    // 头 + 长发
    cCir(g, 0.5, 0.465, 0.170, cRad(g, 0.44, 0.40, 0.02, 0.25, [[0, '#ffffff'], [0.6, SKIN], [1, SKIND]]), OL, 0.018);
    // 刘海
    cShp(g, [[0.335, 0.47], [0.345, 0.365], [0.40, 0.315], [0.47, 0.298], [0.545, 0.31], [0.62, 0.355], [0.665, 0.47], [0.61, 0.42], [0.55, 0.398], [0.50, 0.43], [0.45, 0.398], [0.39, 0.42]], cLin(g, 0.4, 0.30, 0.6, 0.47, [[0, '#4aa3b4'], [1, HAIR]]), '#1a525e', 0.012);
    // 侧发丝
    cCurveTaper(g, 0.345, 0.44, 0.29, 0.50, 0.275, 0.575, 0.032, 0.014, HAIR, '#1a525e', 0.008);
    cCurveTaper(g, 0.655, 0.44, 0.71, 0.50, 0.725, 0.575, 0.032, 0.014, HAIR, '#1a525e', 0.008);
    // 珍珠额饰
    cCir(g, 0.5, 0.352, 0.028, PEARL, GOLD, 0.008);
    cCir(g, 0.5, 0.352, 0.011, '#ffffff');
    cCir(g, 0.435, 0.375, 0.014, PEARL, GOLD, 0.006);
    cCir(g, 0.565, 0.375, 0.014, PEARL, GOLD, 0.006);
    // 眼
    cEye(g, 0.437, 0.472, 0.044, '#ffffff', SCALED, '#123a40');
    cEye(g, 0.563, 0.472, 0.044, '#ffffff', SCALED, '#123a40');
    // 吟唱的口
    cEll(g, 0.5, 0.585, 0.030, 0.038, 0, '#3a2430', '#7a4a52', 0.008);
    cEll(g, 0.5, 0.60, 0.017, 0.013, 0, '#e8909a');
    // 腮红
    cEll(g, 0.395, 0.545, 0.024, 0.014, 0, 'rgba(240,130,140,.32)');
    cEll(g, 0.605, 0.545, 0.024, 0.014, 0, 'rgba(240,130,140,.32)');
    // 水泡 + 珠光
    cCir(g, 0.245, 0.43, 0.030, null, 'rgba(220,255,250,.85)', 0.010);
    cCir(g, 0.205, 0.36, 0.020, null, 'rgba(220,255,250,.75)', 0.009);
    cCir(g, 0.30, 0.335, 0.014, null, 'rgba(220,255,250,.7)', 0.008);
    cCir(g, 0.245, 0.425, 0.008, 'rgba(255,255,255,.9)');
    cSpark(g, 0.75, 0.30, 0.022, '#e0fffa');
  };

  // 魑魅：无足飘浮精魅，雾状下摆、青光眼、长耳
  ICONS.chimei = function (g) {
    iconBG(g, '#6a4aa8', '#e8d8ff');
    var OL = 'rgba(30,14,56,.55)';
    var MIST = '#8a6ac8', MISTL = '#b8a0e8', MISTD = '#5a3f96', GLOW = '#7af0d0', GOLD = '#e8b33a';
    // 雾状下摆
    g.save();
    g.globalAlpha = 0.85;
    cCurveTaper(g, 0.40, 0.66, 0.30, 0.78, 0.255, 0.86, 0.10, 0.030, cLin(g, 0.4, 0.66, 0.25, 0.87, [[0, MIST], [1, 'rgba(138,106,200,0)']]), null, 0);
    cCurveTaper(g, 0.60, 0.66, 0.70, 0.78, 0.745, 0.86, 0.10, 0.030, cLin(g, 0.6, 0.66, 0.75, 0.87, [[0, MIST], [1, 'rgba(138,106,200,0)']]), null, 0);
    cCurveTaper(g, 0.5, 0.70, 0.56, 0.82, 0.52, 0.885, 0.12, 0.030, cLin(g, 0.5, 0.70, 0.5, 0.89, [[0, MISTL], [1, 'rgba(184,160,232,0)']]), null, 0);
    g.restore();
    // 身体（飘浮，无足）
    cShp(g, [[0.345, 0.46], [0.355, 0.585], [0.44, 0.655], [0.5, 0.675], [0.56, 0.655], [0.645, 0.585], [0.655, 0.46]], cLin(g, 0.5, 0.45, 0.5, 0.68, [[0, MIST], [1, MISTD]]), OL, 0.016);
    // 长耳
    cCurveTaper(g, 0.40, 0.35, 0.33, 0.27, 0.30, 0.175, 0.040, 0.010, MIST, MISTD, 0.011);
    cCurveTaper(g, 0.60, 0.35, 0.67, 0.27, 0.70, 0.175, 0.040, 0.010, MIST, MISTD, 0.011);
    cCir(g, 0.295, 0.168, 0.020, GLOW);
    cCir(g, 0.705, 0.168, 0.020, GLOW);
    // 头
    cCir(g, 0.5, 0.445, 0.175, cRad(g, 0.44, 0.38, 0.02, 0.26, [[0, MISTL], [0.55, MIST], [1, MISTD]]), OL, 0.018);
    // 云纹额饰
    cShp(g, [[0.45, 0.365], [0.47, 0.335], [0.5, 0.352], [0.53, 0.335], [0.55, 0.365]], GOLD, '#a87a10', 0.008);
    // 青光眼
    cSpiritEye(g, 0.428, 0.445, 0.042, GLOW);
    cSpiritEye(g, 0.572, 0.445, 0.042, GLOW);
    // 小嘴
    cEll(g, 0.5, 0.545, 0.026, 0.032, 0, '#2a1a44', 'rgba(122,240,208,.5)', 0.008);
    // 腮红
    cEll(g, 0.375, 0.51, 0.028, 0.016, 0, 'rgba(200,150,255,.35)');
    cEll(g, 0.625, 0.51, 0.028, 0.016, 0, 'rgba(200,150,255,.35)');
    // 飘浮雾旋
    cSwirl(g, 0.235, 0.52, 0.055, 1.2, 'rgba(122,240,208,.55)', 0.012);
    cSwirl(g, 0.775, 0.60, 0.048, 1.2, 'rgba(200,168,238,.65)', 0.012, -1);
    cSpark(g, 0.74, 0.30, 0.018, GLOW);
    cSpark(g, 0.27, 0.31, 0.016, GLOW);
  };

  // 魍魉：墨影魍魉、双角、赤目、烟雾下摆、利爪
  ICONS.wangliang = function (g) {
    iconBG(g, '#5a3f7a', '#c8b0e8');
    var OL = 'rgba(16,6,28,.66)';
    var SHADOW = '#3a2a4a', SHADOWD = '#241a33', SHADOWL = '#6a4a8a', RED = '#e8453c', PUR = '#8a6ac8';
    // 烟雾下摆（身后）
    g.save();
    g.globalAlpha = 0.9;
    cCurveTaper(g, 0.30, 0.70, 0.20, 0.80, 0.16, 0.875, 0.09, 0.025, cLin(g, 0.3, 0.7, 0.16, 0.88, [[0, SHADOW], [1, 'rgba(58,42,74,0)']]), null, 0);
    cCurveTaper(g, 0.70, 0.70, 0.80, 0.80, 0.84, 0.875, 0.09, 0.025, cLin(g, 0.7, 0.7, 0.84, 0.88, [[0, SHADOW], [1, 'rgba(58,42,74,0)']]), null, 0);
    cCurveTaper(g, 0.5, 0.72, 0.52, 0.82, 0.50, 0.905, 0.10, 0.022, cLin(g, 0.5, 0.72, 0.5, 0.90, [[0, SHADOWL], [1, 'rgba(106,74,138,0)']]), null, 0);
    g.restore();
    // 双角
    cCurveTaper(g, 0.405, 0.335, 0.325, 0.245, 0.275, 0.155, 0.036, 0.008, SHADOWD, '#120a1c', 0.010);
    cCurveTaper(g, 0.595, 0.335, 0.675, 0.245, 0.725, 0.155, 0.036, 0.008, SHADOWD, '#120a1c', 0.010);
    cCir(g, 0.272, 0.148, 0.020, PUR, '#4a2f6a', 0.007);
    cCir(g, 0.728, 0.148, 0.020, PUR, '#4a2f6a', 0.007);
    // 影身
    cShp(g, [[0.5, 0.275], [0.62, 0.305], [0.69, 0.42], [0.745, 0.62], [0.71, 0.76], [0.60, 0.80], [0.5, 0.785], [0.40, 0.80], [0.29, 0.76], [0.255, 0.62], [0.31, 0.42], [0.38, 0.305]], cLin(g, 0.5, 0.30, 0.5, 0.78, [[0, SHADOWL], [0.45, SHADOW], [1, SHADOWD]]), OL, 0.018);
    // 肩部高光
    g.strokeStyle = 'rgba(138,106,200,.35)'; g.lineWidth = 0.012;
    g.beginPath(); g.arc(0.5, 0.50, 0.20, PI * 1.08, PI * 1.45); g.stroke();
    // 面孔（红目 + 利齿笑）
    cGlow(g, 0.428, 0.445, 0.09, RED, 0.42);
    cGlow(g, 0.572, 0.445, 0.09, RED, 0.42);
    cEll(g, 0.428, 0.445, 0.052, 0.030, -0.22, RED);
    cEll(g, 0.572, 0.445, 0.052, 0.030, 0.22, RED);
    cEll(g, 0.428, 0.445, 0.024, 0.014, -0.22, '#ffe6c0');
    cEll(g, 0.572, 0.445, 0.024, 0.014, 0.22, '#ffe6c0');
    cCir(g, 0.428, 0.443, 0.009, '#2a0a08');
    cCir(g, 0.572, 0.443, 0.009, '#2a0a08');
    // 咧嘴 + 獠牙
    cShp(g, [[0.385, 0.535], [0.5, 0.60], [0.615, 0.535], [0.575, 0.575], [0.5, 0.615], [0.425, 0.575]], '#241a33', '#120a1c', 0.010);
    var fangs = [0.415, 0.455, 0.5, 0.545, 0.585];
    for (var fi = 0; fi < fangs.length; fi++) {
      cShp(g, [[fangs[fi] - 0.014, 0.552], [fangs[fi], 0.578 + (fi % 2) * 0.008], [fangs[fi] + 0.014, 0.552]], '#e8e0f0', '#8a7aa0', 0.005);
    }
    // 利爪
    cClaw(g, 0.255, 0.66, 0.030, 1.75, RED);
    cClaw(g, 0.745, 0.66, 0.030, -1.75, RED);
    // 影子高光
    cEll(g, 0.5, 0.70, 0.11, 0.05, 0, 'rgba(138,106,200,.20)');
    // 雾旋
    cSwirl(g, 0.235, 0.33, 0.045, 1.1, 'rgba(200,168,238,.45)', 0.010);
    cSwirl(g, 0.775, 0.39, 0.040, 1.1, 'rgba(200,168,238,.40)', 0.010, -1);
  };

  // 赤鱬：鱼身人面、大眼、金鳍、吐水泡
  ICONS.chiru = function (g) {
    iconBG(g, '#e8b33a', '#fff2c8');
    var OL = 'rgba(110,34,12,.60)';
    var RED = '#e8563c', REDL = '#ff8a6a', REDD = '#b02a1a', GOLD = '#ffd93d', GOLDD = '#c99a10', SKIN = '#ffe0c8', SKIND = '#d8a880', HAIR = '#3a5468';
    // 金鳍（尾 + 背）
    cShp(g, [[0.80, 0.62], [0.915, 0.53], [0.885, 0.65], [0.92, 0.76], [0.80, 0.72]], cLin(g, 0.82, 0.55, 0.92, 0.75, [[0, GOLD], [1, GOLDD]]), '#a87a10', 0.012);
    cShp(g, [[0.46, 0.40], [0.52, 0.285], [0.585, 0.395], [0.55, 0.44], [0.50, 0.435]], GOLD, GOLDD, 0.012);
    cShp(g, [[0.34, 0.70], [0.265, 0.795], [0.385, 0.785], [0.425, 0.735]], GOLD, GOLDD, 0.010);
    // 鳍条
    g.strokeStyle = 'rgba(168,122,16,.7)'; g.lineWidth = 0.007;
    g.beginPath(); g.moveTo(0.84, 0.64); g.lineTo(0.90, 0.58); g.stroke();
    g.beginPath(); g.moveTo(0.85, 0.66); g.lineTo(0.895, 0.70); g.stroke();
    g.beginPath(); g.moveTo(0.49, 0.41); g.lineTo(0.52, 0.32); g.stroke();
    g.beginPath(); g.moveTo(0.54, 0.42); g.lineTo(0.56, 0.36); g.stroke();
    // 鱼身
    cEll(g, 0.55, 0.62, 0.245, 0.185, -0.06, cRad(g, 0.45, 0.55, 0.02, 0.30, [[0, REDL], [0.55, RED], [1, REDD]]), OL, 0.020);
    // 鳞纹
    cScaleRow(g, 0.60, 0.62, 4, 0.026, 'rgba(176,42,26,.55)', 0.009);
    cScaleRow(g, 0.66, 0.67, 3, 0.024, 'rgba(176,42,26,.45)', 0.009);
    cScaleRow(g, 0.63, 0.57, 3, 0.022, 'rgba(255,200,170,.55)', 0.008);
    // 人面
    cEll(g, 0.335, 0.565, 0.135, 0.145, -0.06, cRad(g, 0.29, 0.50, 0.02, 0.19, [[0, '#fff2e4'], [0.6, SKIN], [1, SKIND]]), OL, 0.016);
    // 头发（人面头顶）
    cShp(g, [[0.235, 0.50], [0.255, 0.425], [0.315, 0.385], [0.375, 0.40], [0.42, 0.445], [0.44, 0.52], [0.41, 0.475], [0.36, 0.455], [0.31, 0.475], [0.27, 0.455]], cLin(g, 0.28, 0.39, 0.42, 0.52, [[0, '#5a7a90'], [1, HAIR]]), '#22384a', 0.011);
    // 耳
    cEll(g, 0.213, 0.575, 0.026, 0.040, 0, SKIN, OL, 0.010);
    cEll(g, 0.455, 0.575, 0.026, 0.040, 0, SKIN, OL, 0.010);
    // 眼（大眼）
    cEye(g, 0.285, 0.552, 0.048, '#ffffff', '#3a6a8a', '#1a2a38');
    cEye(g, 0.373, 0.548, 0.048, '#ffffff', '#3a6a8a', '#1a2a38');
    // 眉
    g.strokeStyle = HAIR; g.lineWidth = 0.012;
    g.beginPath(); g.moveTo(0.248, 0.502); g.quadraticCurveTo(0.282, 0.488, 0.315, 0.502); g.stroke();
    g.beginPath(); g.moveTo(0.345, 0.498); g.quadraticCurveTo(0.378, 0.486, 0.408, 0.500); g.stroke();
    // 鼻 + 嘴
    g.strokeStyle = SKIND; g.lineWidth = 0.010;
    g.beginPath(); g.moveTo(0.33, 0.578); g.quadraticCurveTo(0.34, 0.595, 0.328, 0.602); g.stroke();
    cShp(g, [[0.298, 0.622], [0.355, 0.622], [0.352, 0.638], [0.328, 0.648], [0.304, 0.638]], '#c25a48', '#8a3222', 0.009);
    // 腮红
    cEll(g, 0.248, 0.602, 0.024, 0.014, 0, 'rgba(232,110,100,.32)');
    cEll(g, 0.415, 0.598, 0.022, 0.012, 0, 'rgba(232,110,100,.30)');
    // 水泡
    cCir(g, 0.185, 0.40, 0.026, null, 'rgba(255,255,255,.9)', 0.010);
    cCir(g, 0.145, 0.335, 0.018, null, 'rgba(255,255,255,.8)', 0.009);
    cCir(g, 0.225, 0.31, 0.013, null, 'rgba(255,255,255,.75)', 0.008);
    cCir(g, 0.185, 0.395, 0.007, 'rgba(255,255,255,.95)');
    // 高光点
    cSpark(g, 0.80, 0.42, 0.020, '#fff6c8');
  };

  // 饕餮：青铜巨兽、巨口獠牙、羊角、金纹、腹大
  ICONS.taotie = function (g) {
    iconBG(g, '#48603c', '#c8d8b0');
    var OL = 'rgba(20,32,16,.66)';
    var BRZ = '#6b8a5a', BRZD = '#3c5434', BRZL = '#9ab884', GOLD = '#e8b33a', GOLDD = '#a87a1a', BONE = '#f0e6d2';
    // 大腹
    cEll(g, 0.5, 0.735, 0.30, 0.175, 0, cRad(g, 0.46, 0.68, 0.02, 0.34, [[0, BRZL], [0.55, BRZ], [1, BRZD]]), OL, 0.020);
    // 腹上金纹
    cEll(g, 0.5, 0.775, 0.245, 0.115, 0, null, GOLDD, 0.010);
    cSwirl(g, 0.36, 0.78, 0.045, 1.2, GOLD, 0.011);
    cSwirl(g, 0.64, 0.78, 0.045, 1.2, GOLD, 0.011, -1);
    cCir(g, 0.5, 0.70, 0.026, GOLD, GOLDD, 0.008);
    // 羊角（金铜粗角 + 内卷纹）
    cCurveTaper(g, 0.345, 0.395, 0.255, 0.335, 0.205, 0.478, 0.052, 0.040, cLin(g, 0.33, 0.36, 0.22, 0.48, [[0, '#e8c878'], [1, '#a8823a']]), '#4a3410', 0.013);
    cCurveTaper(g, 0.655, 0.395, 0.745, 0.335, 0.795, 0.478, 0.052, 0.040, cLin(g, 0.67, 0.36, 0.78, 0.48, [[0, '#e8c878'], [1, '#a8823a']]), '#4a3410', 0.013);
    cCir(g, 0.218, 0.478, 0.034, '#8a6a2a', '#4a3410', 0.010);
    cCir(g, 0.218, 0.478, 0.017, '#e8c878');
    cCir(g, 0.782, 0.478, 0.034, '#8a6a2a', '#4a3410', 0.010);
    cCir(g, 0.782, 0.478, 0.017, '#e8c878');
    // 耳
    cShp(g, [[0.30, 0.42], [0.245, 0.49], [0.335, 0.485]], BRZ, OL, 0.011);
    cShp(g, [[0.70, 0.42], [0.755, 0.49], [0.665, 0.485]], BRZ, OL, 0.011);
    // 头（青铜面）
    cCir(g, 0.5, 0.475, 0.215, cRad(g, 0.44, 0.40, 0.02, 0.31, [[0, BRZL], [0.55, BRZ], [1, BRZD]]), OL, 0.022);
    // 额上金云纹
    cSwirl(g, 0.5, 0.395, 0.052, 1.1, GOLD, 0.012);
    cCir(g, 0.5, 0.352, 0.022, GOLD, GOLDD, 0.007);
    // 金眉
    g.strokeStyle = GOLD; g.lineWidth = 0.020;
    g.beginPath(); g.moveTo(0.325, 0.425); g.quadraticCurveTo(0.375, 0.398, 0.43, 0.425); g.stroke();
    g.beginPath(); g.moveTo(0.675, 0.425); g.quadraticCurveTo(0.625, 0.398, 0.57, 0.425); g.stroke();
    // 眼（金环 + 暗瞳）
    cCir(g, 0.395, 0.465, 0.058, GOLD, GOLDD, 0.010);
    cCir(g, 0.605, 0.465, 0.058, GOLD, GOLDD, 0.010);
    cCir(g, 0.395, 0.465, 0.036, '#2a3a24');
    cCir(g, 0.605, 0.465, 0.036, '#2a3a24');
    cCir(g, 0.395, 0.465, 0.017, BONE);
    cCir(g, 0.605, 0.465, 0.017, BONE);
    cCir(g, 0.386, 0.453, 0.010, '#ffffff');
    cCir(g, 0.596, 0.453, 0.010, '#ffffff');
    // 巨口
    cShp(g, [[0.30, 0.545], [0.5, 0.585], [0.70, 0.545], [0.66, 0.64], [0.5, 0.665], [0.34, 0.64]], '#3a1410', '#1a0a08', 0.012);
    // 上排牙
    var tx = [0.33, 0.375, 0.42, 0.465, 0.51, 0.555, 0.60, 0.645];
    for (var ti2 = 0; ti2 < tx.length; ti2++) {
      cShp(g, [[tx[ti2] - 0.017, 0.558], [tx[ti2], 0.60], [tx[ti2] + 0.017, 0.558]], BONE, '#b8a888', 0.005);
    }
    // 下排獠牙
    var bx = [0.36, 0.44, 0.52, 0.60]; // 下獠牙
    for (var bi = 0; bi < 4; bi++) {
      cShp(g, [[bx[bi] - 0.020, 0.645], [bx[bi], 0.70], [bx[bi] + 0.020, 0.645]], BONE, '#b8a888', 0.006);
    }
    // 舌尖
    cEll(g, 0.5, 0.625, 0.085, 0.026, 0, '#c2452e', '#8a2018', 0.008);
    // 腹下小爪
    cClaw(g, 0.265, 0.865, 0.024, 2.0, GOLD);
    cClaw(g, 0.735, 0.865, 0.024, -2.0, GOLD);
    // 青铜锈斑
    cCir(g, 0.355, 0.33, 0.012, 'rgba(232,179,58,.35)');
    cCir(g, 0.655, 0.72, 0.014, 'rgba(232,179,58,.30)');
  };

  // 巴蛇：巨蛇、金瞳、盘绕、鳞纹、黄腹
  ICONS.bashe = function (g) {
    iconBG(g, '#7a9a4a', '#f0f8d8');
    var OL = 'rgba(16,34,18,.64)';
    var SNAKE = '#3f6a4a', SNAKED = '#2a4a33', SNAKEL = '#6f9a70', BELLY = '#c9b46a', GOLD = '#e8b33a', GOLDD = '#a87a1a';
    // 盘绕的身体（身后）
    cEll(g, 0.5, 0.775, 0.275, 0.115, -0.06, cLin(g, 0.5, 0.68, 0.5, 0.87, [[0, SNAKEL], [0.5, SNAKE], [1, SNAKED]]), OL, 0.016);
    // 盘纹
    cEll(g, 0.5, 0.775, 0.20, 0.075, -0.06, null, 'rgba(111,154,112,.65)', 0.010);
    cEll(g, 0.5, 0.775, 0.115, 0.042, -0.06, null, 'rgba(111,154,112,.55)', 0.009);
    // 腹黄
    cCurveTaper(g, 0.70, 0.80, 0.86, 0.72, 0.88, 0.60, 0.040, 0.022, BELLY, '#9a8540', 0.010);
    // 身体（从头部向右下）
    cCurveTaper(g, 0.55, 0.60, 0.78, 0.70, 0.70, 0.86, 0.085, 0.045, cLin(g, 0.55, 0.60, 0.72, 0.86, [[0, SNAKEL], [0.5, SNAKE], [1, SNAKED]]), OL, 0.014);
    // 身体鳞纹
    cScaleRow(g, 0.665, 0.70, 3, 0.024, 'rgba(201,180,106,.55)', 0.008, 0.5);
    cScaleRow(g, 0.655, 0.76, 3, 0.022, 'rgba(111,154,112,.65)', 0.008, 0.3);
    // 尾尖
    cCurveTaper(g, 0.58, 0.855, 0.45, 0.90, 0.33, 0.865, 0.038, 0.010, SNAKED, '#16281a', 0.010);
    // 蛇头
    cEll(g, 0.395, 0.475, 0.185, 0.145, -0.26, cRad(g, 0.35, 0.42, 0.02, 0.25, [[0, SNAKEL], [0.55, SNAKE], [1, SNAKED]]), OL, 0.020);
    // 头顶鳞纹
    cScaleRow(g, 0.40, 0.43, 3, 0.026, 'rgba(232,179,58,.45)', 0.009, -0.26);
    // 眉骨
    cShp(g, [[0.28, 0.435], [0.375, 0.405], [0.40, 0.44]], SNAKED, '#16281a', 0.010);
    // 眼（金瞳竖瞳）
    cEye(g, 0.35, 0.462, 0.046, '#f4ffe0', GOLD, '#3a2a06');
    cEye(g, 0.468, 0.442, 0.040, '#f4ffe0', GOLD, '#3a2a06');
    cEll(g, 0.35, 0.468, 0.008, 0.022, -0.2, '#1a1404');
    cEll(g, 0.468, 0.448, 0.007, 0.019, -0.2, '#1a1404');
    // 鼻
    cCir(g, 0.305, 0.505, 0.012, SNAKED);
    // 口（张开）+ 獠牙 + 蛇信
    cShp(g, [[0.245, 0.535], [0.36, 0.565], [0.445, 0.545], [0.435, 0.60], [0.345, 0.625], [0.255, 0.585]], '#3a1418', '#1a0a0a', 0.010);
    cShp(g, [[0.31, 0.558], [0.325, 0.60], [0.34, 0.558]], '#f0e6d2', '#b8a888', 0.006);
    cShp(g, [[0.38, 0.55], [0.395, 0.59], [0.41, 0.548]], '#f0e6d2', '#b8a888', 0.005);
    // 蛇信
    g.strokeStyle = '#e8453c'; g.lineWidth = 0.012;
    g.beginPath(); g.moveTo(0.26, 0.585); g.quadraticCurveTo(0.20, 0.60, 0.175, 0.575); g.stroke();
    g.beginPath(); g.moveTo(0.185, 0.588); g.lineTo(0.155, 0.568); g.stroke();
    g.beginPath(); g.moveTo(0.185, 0.588); g.lineTo(0.152, 0.606); g.stroke();
    // 黄腹（颈下）
    cCurveTaper(g, 0.31, 0.60, 0.24, 0.65, 0.20, 0.71, 0.030, 0.014, BELLY, '#9a8540', 0.008);
    // 金点
    cCir(g, 0.60, 0.62, 0.010, GOLD);
    cCir(g, 0.64, 0.68, 0.008, GOLD);
    cSpark(g, 0.80, 0.36, 0.018, '#fff6c8');
  };

  // 混沌：无面黄囊、六足四翼、赤光流转、浑敦无目
  ICONS.hundun = function (g) {
    iconBG(g, '#b8402a', '#ffb080');
    var OL = 'rgba(90,30,10,.62)';
    var SACK = '#e8c86a', SACKL = '#fff0b0', SACKD = '#b89040', RED = '#e8453c', REDD = '#a8201a', FEET = '#8a6a3a';
    // 赤光流转
    cGlow(g, 0.5, 0.60, 0.42, RED, 0.30);
    // 四翼（两对，金羽 + 赤光缘）
    var wings4 = [
      [[0.35, 0.445], [0.19, 0.335], [0.145, 0.395], [0.235, 0.435], [0.155, 0.465], [0.35, 0.505]],
      [[0.65, 0.445], [0.81, 0.335], [0.855, 0.395], [0.765, 0.435], [0.845, 0.465], [0.65, 0.505]],
      [[0.355, 0.60], [0.20, 0.585], [0.15, 0.645], [0.245, 0.655], [0.17, 0.705], [0.35, 0.675]],
      [[0.645, 0.60], [0.80, 0.585], [0.85, 0.645], [0.755, 0.655], [0.83, 0.705], [0.65, 0.675]]
    ];
    for (var w4 = 0; w4 < wings4.length; w4++) {
      cShp(g, wings4[w4], cLin(g, 0.5, 0.40, 0.5, 0.68, [[0, '#ffe9a8'], [0.6, SACK], [1, '#d8a850']]), '#8a5a1a', 0.011);
      g.save();
      g.globalAlpha = 0.7;
      g.strokeStyle = RED; g.lineWidth = 0.008;
      g.beginPath();
      g.moveTo(wings4[w4][1][0], wings4[w4][1][1]);
      g.lineTo(wings4[w4][3][0], wings4[w4][3][1]);
      g.stroke();
      g.restore();
    }
    // 六足
    var feet = [0.335, 0.40, 0.465, 0.535, 0.60, 0.665];
    for (var fi2 = 0; fi2 < feet.length; fi2++) {
      var fx = feet[fi2];
      cRR(g, fx - 0.022, 0.795, 0.044, 0.070, 0.018, FEET, '#5a4420', 0.008);
      cCir(g, fx, 0.862, 0.020, FEET, '#5a4420', 0.007);
      cCir(g, fx - 0.008, 0.866, 0.006, '#c8a860');
    }
    // 黄囊身体（无面）
    cShp(g, [[0.5, 0.295], [0.615, 0.325], [0.705, 0.42], [0.735, 0.56], [0.70, 0.70], [0.62, 0.80], [0.5, 0.835], [0.38, 0.80], [0.30, 0.70], [0.265, 0.56], [0.295, 0.42], [0.385, 0.325]], cRad(g, 0.44, 0.48, 0.02, 0.42, [[0, SACKL], [0.55, SACK], [1, SACKD]]), OL, 0.020);
    // 囊口（束口 + 赤绳）
    cEll(g, 0.5, 0.30, 0.058, 0.032, 0, SACKD, '#8a6a20', 0.010);
    cCurveTaper(g, 0.44, 0.30, 0.40, 0.275, 0.37, 0.30, 0.014, 0.014, RED, REDD, 0.007);
    cCurveTaper(g, 0.56, 0.30, 0.60, 0.275, 0.63, 0.30, 0.014, 0.014, RED, REDD, 0.007);
    // 赤光流转（身体上的旋纹）
    cGlow(g, 0.5, 0.585, 0.17, RED, 0.45);
    cSwirl(g, 0.5, 0.585, 0.125, 1.35, RED, 0.017);
    cSwirl(g, 0.5, 0.585, 0.070, 1.0, '#ff9a6a', 0.013, -1);
    cCir(g, 0.5, 0.585, 0.020, '#ffe6a0');
    // 赤光流点
    cCir(g, 0.385, 0.42, 0.014, RED);
    cCir(g, 0.615, 0.43, 0.012, RED);
    cCir(g, 0.60, 0.735, 0.014, RED);
    cCir(g, 0.395, 0.72, 0.011, RED);
    // 金云纹
    cSwirl(g, 0.36, 0.68, 0.042, 1.0, '#c89a30', 0.010);
    cSwirl(g, 0.64, 0.66, 0.038, 1.0, '#c89a30', 0.010, -1);
    // 光晕点
    cSpark(g, 0.755, 0.325, 0.020, '#ffe6a0');
    cSpark(g, 0.24, 0.335, 0.016, '#ffe6a0');
    cSpark(g, 0.705, 0.72, 0.013, '#ffb080');
  };


  // =========================================================================
  // 3. 行者半身头像（选角界面 / 结算界面用）
  //    服饰按 docs/MYTHOLOGY.md 第 2 节；右下角属性徽章按第 4 节
  // =========================================================================
  const TRAINER_ART = {
    t_bolt: {
      bg1: '#fff6cc', bg2: '#ffd93d', ring: '#e8b33a', symbol: 'bolt', eye: '#4a3a1a',
      skin: '#f2c79f', skinD: '#d8a87e', hair: '#2c2b33', hairD: '#1b1a20',
      top: '#2f4a7a', topD: '#22385c', sleeve: '#3a5a8e', trim: '#e8b33a', inner: '#fff6e0',
    },
    t_leaf: {
      bg1: '#eafbe0', bg2: '#8ed36a', ring: '#4e9c3f', symbol: 'leaf', eye: '#3a5a24',
      skin: '#f3cba8', skinD: '#dbab84', hair: '#6a4a2a', hairD: '#4a3218',
      top: '#3f8a63', topD: '#2c6849', sleeve: '#57a878', trim: '#fff4c8', inner: '#fff4c8',
    },
    t_ember: {
      bg1: '#ffe6cc', bg2: '#ff8a3d', ring: '#d0432e', symbol: 'flame', eye: '#8a3a12',
      skin: '#dfa77d', skinD: '#c48c62', hair: '#c2451a', hairD: '#8a2c10',
      top: '#b8302a', topD: '#8a2018', sleeve: '#b8302a', trim: '#e8b33a', inner: '#ffb43d',
    },
    t_tide: {
      bg1: '#e0f4ff', bg2: '#5ab8f0', ring: '#2f6fae', symbol: 'drop', eye: '#1f5a7a',
      skin: '#f1c4a4', skinD: '#d6a583', hair: '#3f6aae', hairD: '#2a4a80',
      top: '#1f3a5a', topD: '#152a44', sleeve: '#26456a', trim: '#a8e0ff', inner: '#e0f4ff',
    }
  };

  // 属性符号：lei 雷纹 bolt / mu 叶 leaf / huo 火 flame / shui 水 drop（其余属性复用 drop）
  function drawSymbol(g, kind, x, y, r, color) {
    g.save();
    g.translate(x, y);
    g.fillStyle = color || '#ffffff';
    g.strokeStyle = color || '#ffffff';
    if (kind === 'bolt') {
      g.beginPath();
      g.moveTo(r * 0.12, -r); g.lineTo(-r * 0.55, r * 0.10); g.lineTo(-r * 0.05, r * 0.10);
      g.lineTo(-r * 0.18, r); g.lineTo(r * 0.58, -r * 0.14); g.lineTo(r * 0.06, -r * 0.14);
      g.closePath(); g.fill();
    } else if (kind === 'leaf') {
      g.beginPath();
      g.moveTo(-r * 0.62, r * 0.58);
      g.quadraticCurveTo(-r * 0.92, -r * 0.70, r * 0.66, -r * 0.70);
      g.quadraticCurveTo(r * 0.62, r * 0.58, -r * 0.62, r * 0.58);
      g.closePath(); g.fill();
      g.beginPath(); g.moveTo(-r * 0.50, r * 0.52); g.lineTo(r * 0.42, -r * 0.48);
      g.strokeStyle = 'rgba(255,255,255,.62)'; g.lineWidth = r * 0.16; g.stroke();
    } else if (kind === 'flame') {
      g.beginPath();
      g.moveTo(0, -r);
      g.bezierCurveTo(r * 0.78, -r * 0.24, r * 0.56, r * 0.58, 0, r * 0.88);
      g.bezierCurveTo(-r * 0.56, r * 0.58, -r * 0.78, -r * 0.24, 0, -r);
      g.closePath(); g.fill();
      g.fillStyle = 'rgba(255,255,255,.72)';
      g.beginPath();
      g.moveTo(0, -r * 0.12);
      g.bezierCurveTo(r * 0.32, r * 0.16, r * 0.22, r * 0.46, 0, r * 0.62);
      g.bezierCurveTo(-r * 0.26, r * 0.42, -r * 0.32, r * 0.10, 0, -r * 0.12);
      g.closePath(); g.fill();
    } else {
      g.beginPath();
      g.moveTo(0, -r);
      g.bezierCurveTo(r * 0.72, -r * 0.10, r * 0.62, r * 0.56, 0, r * 0.96);
      g.bezierCurveTo(-r * 0.62, r * 0.56, -r * 0.72, -r * 0.10, 0, -r);
      g.closePath(); g.fill();
      g.fillStyle = 'rgba(255,255,255,.68)';
      g.beginPath();
      g.ellipse(0, r * 0.28, r * 0.17, r * 0.25, -0.4, 0, TAU);
      g.fill();
    }
    g.restore();
  }

  // 行者半身像：类型色圆环底 + 半身像 + 右下属性徽章
  function drawTrainerPortrait(g, id) {
    var A = TRAINER_ART[id] || TRAINER_ART.t_bolt;
    var OL = 'rgba(46,30,18,.55)';
    // 背景
    g.fillStyle = cLin(g, 0.1, 0, 0.9, 1, [[0, A.bg1], [1, A.bg2]]);
    g.fillRect(0, 0, 1, 1);
    // 放射光
    g.save();
    g.translate(0.5, 0.48);
    g.globalAlpha = 0.13;
    g.fillStyle = '#ffffff';
    for (var i = 0; i < 12; i++) {
      g.rotate(TAU / 12);
      g.beginPath(); g.moveTo(0, 0); g.lineTo(0.5, -0.05); g.lineTo(0.5, 0.05); g.closePath(); g.fill();
    }
    g.restore();
    // 背景云纹
    g.save(); g.globalAlpha = 0.20;
    cCloud(g, 0.155, 0.635, 0.055, '#ffffff', null, 0);
    cCloud(g, 0.845, 0.315, 0.045, '#ffffff', null, 0);
    g.restore();
    // 大圆环
    g.save();
    g.shadowColor = 'rgba(40,30,10,.22)'; g.shadowBlur = 0.06; g.shadowOffsetY = 0.022;
    cCir(g, 0.5, 0.49, 0.395, '#ffffff');
    g.restore();
    cCir(g, 0.5, 0.49, 0.372, cRad(g, 0.5, 0.34, 0.03, 0.42, [[0, '#ffffff'], [0.42, A.bg1], [1, A.ring]]));
    cCir(g, 0.5, 0.49, 0.388, null, '#ffffff', 0.03);
    // 地面光
    g.save(); g.globalAlpha = 0.5;
    cEll(g, 0.5, 0.78, 0.30, 0.075, 0, '#ffffff');
    g.restore();

    // ---- 身后物件 / 披风 / 鹿角 ----
    if (id === 't_bolt') {
      // 背后小雷鼓
      cCir(g, 0.155, 0.675, 0.088, '#8a5a2a', '#5a3a18', 0.014);
      cCir(g, 0.155, 0.675, 0.088, null, '#e8b33a', 0.012);
      cCir(g, 0.155, 0.675, 0.060, '#c8402e', '#8a2018', 0.010);
      cCir(g, 0.155, 0.675, 0.060, null, '#e8b33a', 0.008);
      g.strokeStyle = '#e8b33a'; g.lineWidth = 0.008;
      g.beginPath(); g.moveTo(0.115, 0.63); g.lineTo(0.195, 0.72); g.stroke();
      g.beginPath(); g.moveTo(0.195, 0.63); g.lineTo(0.115, 0.72); g.stroke();
      cCir(g, 0.155, 0.675, 0.020, '#e8b33a', '#a87a1a', 0.006);
    } else if (id === 't_leaf') {
      // 鹿角木冠（身后分叉）
      cCurveTaper(g, 0.425, 0.32, 0.365, 0.22, 0.335, 0.145, 0.024, 0.008, '#8a6438', '#4a3218', 0.010);
      cCurveTaper(g, 0.395, 0.245, 0.345, 0.215, 0.315, 0.185, 0.015, 0.006, '#8a6438', '#4a3218', 0.008);
      cCurveTaper(g, 0.575, 0.32, 0.635, 0.22, 0.665, 0.145, 0.024, 0.008, '#8a6438', '#4a3218', 0.010);
      cCurveTaper(g, 0.605, 0.245, 0.655, 0.215, 0.685, 0.185, 0.015, 0.006, '#8a6438', '#4a3218', 0.008);
    } else if (id === 't_ember') {
      // 火焰纹披风
      cShp(g, [[0.10, 0.885], [0.13, 0.72], [0.23, 0.65], [0.36, 0.67], [0.30, 0.75], [0.26, 0.885]], cLin(g, 0.2, 0.66, 0.15, 0.885, [[0, '#d0432e'], [1, '#8a2018']]), '#5a120c', 0.014);
      cShp(g, [[0.90, 0.885], [0.87, 0.72], [0.77, 0.65], [0.64, 0.67], [0.70, 0.75], [0.74, 0.885]], cLin(g, 0.8, 0.66, 0.85, 0.885, [[0, '#d0432e'], [1, '#8a2018']]), '#5a120c', 0.014);
      cFlame(g, 0.20, 0.862, 0.075, 0.16, '#ff8a3d', '#ffd93d');
      cFlame(g, 0.80, 0.862, 0.075, 0.16, '#ff8a3d', '#ffd93d');
      cFlame(g, 0.145, 0.80, 0.05, 0.10, '#ffb43d', null);
      cFlame(g, 0.855, 0.80, 0.05, 0.10, '#ffb43d', null);
    }

    // ---- 躯干 ----
    g.beginPath();
    g.moveTo(0.20, 0.885);
    g.bezierCurveTo(0.215, 0.725, 0.32, 0.665, 0.5, 0.655);
    g.bezierCurveTo(0.68, 0.665, 0.785, 0.725, 0.80, 0.885);
    g.closePath();
    g.fillStyle = cLin(g, 0.3, 0.65, 0.7, 0.885, [[0, A.top], [1, A.topD]]);
    g.fill();
    g.lineWidth = 0.018; g.strokeStyle = OL; g.stroke();
    // 袖子
    cEll(g, 0.228, 0.82, 0.088, 0.115, 0.24, A.sleeve, OL, 0.016);
    cEll(g, 0.772, 0.82, 0.088, 0.115, -0.24, A.sleeve, OL, 0.016);
    // 交领内衬
    g.beginPath();
    g.moveTo(0.375, 0.665);
    g.quadraticCurveTo(0.44, 0.745, 0.5, 0.795);
    g.quadraticCurveTo(0.56, 0.745, 0.625, 0.665);
    g.quadraticCurveTo(0.5, 0.705, 0.375, 0.665);
    g.closePath();
    g.fillStyle = A.inner; g.fill();
    g.lineWidth = 0.012; g.strokeStyle = OL; g.stroke();
    // 领缘
    g.strokeStyle = A.trim; g.lineWidth = 0.014;
    g.beginPath(); g.moveTo(0.375, 0.667); g.quadraticCurveTo(0.44, 0.747, 0.5, 0.797); g.stroke();
    g.beginPath(); g.moveTo(0.625, 0.667); g.quadraticCurveTo(0.56, 0.747, 0.5, 0.797); g.stroke();

    // ---- 胸饰 / 护具 ----
    if (id === 't_bolt') {
      // 鎏金云肩
      cCloud(g, 0.245, 0.735, 0.068, '#e8b33a', '#a87a1a', 0.010);
      cCloud(g, 0.755, 0.735, 0.068, '#e8b33a', '#a87a1a', 0.010);
      cCir(g, 0.212, 0.753, 0.011, '#fff0b0');
      cCir(g, 0.278, 0.753, 0.011, '#fff0b0');
      cCir(g, 0.722, 0.753, 0.011, '#fff0b0');
      cCir(g, 0.788, 0.753, 0.011, '#fff0b0');
      // 赤绳结
      cCir(g, 0.5, 0.805, 0.022, '#d0432e', '#8a2018', 0.008);
      cEll(g, 0.468, 0.792, 0.026, 0.016, -0.5, null, '#d0432e', 0.010);
      cEll(g, 0.532, 0.792, 0.026, 0.016, 0.5, null, '#d0432e', 0.010);
      cTaper(g, 0.5, 0.822, 0.492, 0.875, 0.007, 0.004, '#d0432e', null, 0);
      cTaper(g, 0.5, 0.822, 0.512, 0.872, 0.007, 0.004, '#d0432e', null, 0);
      // 束袖金箍
      cRR(g, 0.182, 0.782, 0.088, 0.026, 0.012, '#e8b33a', '#a87a1a', 0.008);
      cRR(g, 0.730, 0.782, 0.088, 0.026, 0.012, '#e8b33a', '#a87a1a', 0.008);
    } else if (id === 't_leaf') {
      // 羽形披肩
      var fe = [[0.225, 0.705, -0.62, 0], [0.265, 0.745, -0.30, 1], [0.20, 0.765, -0.85, 2], [0.775, 0.705, 0.62, 0], [0.735, 0.745, 0.30, 1], [0.80, 0.765, 0.85, 2]];
      for (var fi = 0; fi < fe.length; fi++) {
        g.save();
        g.translate(fe[fi][0], fe[fi][1]);
        g.rotate(fe[fi][2]);
        cShp(g, [[0, -0.055], [0.062, 0.010], [0.026, 0.096], [-0.040, 0.086], [-0.058, 0.026]], fi % 2 ? '#dff6e6' : '#7ec89a', '#2c6849', 0.010);
        g.restore();
      }
      // 木纹护腕
      cRR(g, 0.166, 0.845, 0.10, 0.052, 0.020, '#8a6438', '#4a3218', 0.010);
      cRR(g, 0.734, 0.845, 0.10, 0.052, 0.020, '#8a6438', '#4a3218', 0.010);
      g.strokeStyle = 'rgba(74,50,24,.65)'; g.lineWidth = 0.007;
      g.beginPath(); g.moveTo(0.18, 0.856); g.lineTo(0.25, 0.856); g.stroke();
      g.beginPath(); g.moveTo(0.18, 0.872); g.lineTo(0.25, 0.872); g.stroke();
      g.beginPath(); g.moveTo(0.75, 0.856); g.lineTo(0.82, 0.856); g.stroke();
      g.beginPath(); g.moveTo(0.75, 0.872); g.lineTo(0.82, 0.872); g.stroke();
      // 藤蔓腰带
      g.strokeStyle = '#4e9c3f'; g.lineWidth = 0.016;
      g.beginPath(); g.moveTo(0.36, 0.868); g.quadraticCurveTo(0.5, 0.892, 0.64, 0.868); g.stroke();
      g.strokeStyle = '#2c6849'; g.lineWidth = 0.008;
      g.beginPath(); g.moveTo(0.38, 0.878); g.quadraticCurveTo(0.5, 0.900, 0.62, 0.878); g.stroke();
      cEll(g, 0.44, 0.884, 0.020, 0.011, -0.5, '#8ed36a', '#3f7a2c', 0.006);
      cEll(g, 0.56, 0.884, 0.020, 0.011, 0.5, '#8ed36a', '#3f7a2c', 0.006);
    } else if (id === 't_ember') {
      // 赤红甲胄
      cRR(g, 0.405, 0.695, 0.19, 0.185, 0.036, cLin(g, 0.4, 0.69, 0.6, 0.88, [[0, '#d0432e'], [1, '#8a2018']]), '#5a120c', 0.012);
      cRR(g, 0.405, 0.695, 0.19, 0.185, 0.036, null, '#e8b33a', 0.012);
      // 胸甲火纹
      cFlame(g, 0.5, 0.80, 0.075, 0.095, '#e8b33a', '#ffd93d');
      cCir(g, 0.43, 0.72, 0.010, '#e8b33a');
      cCir(g, 0.57, 0.72, 0.010, '#e8b33a');
      cCir(g, 0.43, 0.862, 0.010, '#e8b33a');
      cCir(g, 0.57, 0.862, 0.010, '#e8b33a');
      // 肩甲
      cEll(g, 0.252, 0.722, 0.098, 0.066, 0.22, cLin(g, 0.2, 0.68, 0.3, 0.78, [[0, '#d0432e'], [1, '#8a2018']]), '#5a120c', 0.014);
      cEll(g, 0.748, 0.722, 0.098, 0.066, -0.22, cLin(g, 0.8, 0.68, 0.7, 0.78, [[0, '#d0432e'], [1, '#8a2018']]), '#5a120c', 0.014);
      g.strokeStyle = '#e8b33a'; g.lineWidth = 0.010;
      g.beginPath(); g.arc(0.252, 0.722, 0.072, PI * 1.1, PI * 1.9); g.stroke();
      g.beginPath(); g.arc(0.748, 0.722, 0.072, PI * 1.1, PI * 1.9); g.stroke();
      // 金环臂钏
      cRR(g, 0.170, 0.800, 0.098, 0.028, 0.013, '#e8b33a', '#a87a1a', 0.008);
      cRR(g, 0.732, 0.800, 0.098, 0.028, 0.013, '#e8b33a', '#a87a1a', 0.008);
    } else {
      // 龟甲护心
      cHex(g, 0.5, 0.775, 0.092, PI / 6, '#2f4a3a', '#e8b33a', 0.014);
      cHex(g, 0.5, 0.775, 0.052, PI / 6, null, '#c9a850', 0.010);
      cCir(g, 0.5, 0.775, 0.016, '#7af0d0', '#2f8a78', 0.008);
      cCir(g, 0.44, 0.735, 0.009, '#e8b33a');
      cCir(g, 0.56, 0.735, 0.009, '#e8b33a');
      cCir(g, 0.44, 0.818, 0.009, '#e8b33a');
      cCir(g, 0.56, 0.818, 0.009, '#e8b33a');
      // 浪纹
      g.strokeStyle = 'rgba(168,224,255,.75)'; g.lineWidth = 0.010;
      for (var wi = 0; wi < 3; wi++) {
        g.beginPath();
        g.arc(0.32 + wi * 0.10, 0.86, 0.030, PI * 1.05, PI * 1.95);
        g.stroke();
        g.beginPath();
        g.arc(0.52 + wi * 0.075, 0.875, 0.026, PI * 1.05, PI * 1.95);
        g.stroke();
      }
      // 玉饰
      cCir(g, 0.5, 0.855, 0.016, '#7af0d0', '#2f8a78', 0.007);
      cTaper(g, 0.5, 0.775, 0.5, 0.84, 0.006, 0.004, '#a8e0ff', null, 0);
    }

    // ---- 头发（后层） ----
    if (id === 't_bolt') {
      cEll(g, 0.5, 0.452, 0.172, 0.178, 0, A.hair);
      cEll(g, 0.5, 0.618, 0.128, 0.058, 0, A.hair);
    } else if (id === 't_leaf') {
      cEll(g, 0.5, 0.452, 0.182, 0.182, 0, A.hair);
      cCurveTaper(g, 0.362, 0.52, 0.295, 0.64, 0.295, 0.82, 0.055, 0.028, A.hair, A.hairD, 0.010);
      cCurveTaper(g, 0.638, 0.52, 0.705, 0.64, 0.705, 0.82, 0.055, 0.028, A.hair, A.hairD, 0.010);
    } else if (id === 't_ember') {
      cShp(g, [[0.33, 0.46], [0.30, 0.30], [0.385, 0.365], [0.365, 0.24], [0.46, 0.335], [0.48, 0.205], [0.545, 0.325], [0.60, 0.225], [0.625, 0.36], [0.71, 0.30], [0.68, 0.46], [0.5, 0.40]], cLin(g, 0.35, 0.24, 0.65, 0.46, [[0, '#e86a3a'], [1, A.hair]]), A.hairD, 0.012);
    } else {
      cEll(g, 0.5, 0.452, 0.175, 0.178, 0, A.hair);
      cCurveTaper(g, 0.372, 0.53, 0.305, 0.66, 0.312, 0.84, 0.052, 0.026, A.hairD, null, 0);
      cCurveTaper(g, 0.628, 0.53, 0.695, 0.66, 0.688, 0.84, 0.052, 0.026, A.hairD, null, 0);
    }

    // ---- 脖子 / 头 ----
    cRR(g, 0.442, 0.60, 0.116, 0.10, 0.03, A.skinD, OL, 0.014);
    cEll(g, 0.5, 0.465, 0.155, 0.175, 0, A.skin, OL, 0.018);
    // 耳
    cEll(g, 0.352, 0.478, 0.026, 0.041, 0, A.skin, OL, 0.012);
    cEll(g, 0.648, 0.478, 0.026, 0.041, 0, A.skin, OL, 0.012);
    // 腮红
    cEll(g, 0.405, 0.535, 0.030, 0.018, 0, 'rgba(232,110,100,.32)');
    cEll(g, 0.595, 0.535, 0.030, 0.018, 0, 'rgba(232,110,100,.32)');
    // 眉
    g.strokeStyle = id === 't_bolt' ? A.hair : A.hairD; g.lineWidth = 0.016;
    if (id === 't_ember') {
      g.beginPath(); g.moveTo(0.402, 0.428); g.quadraticCurveTo(0.428, 0.410, 0.458, 0.422); g.stroke();
      g.beginPath(); g.moveTo(0.598, 0.428); g.quadraticCurveTo(0.572, 0.410, 0.542, 0.422); g.stroke();
    } else {
      g.beginPath(); g.moveTo(0.408, 0.420); g.quadraticCurveTo(0.432, 0.408, 0.456, 0.418); g.stroke();
      g.beginPath(); g.moveTo(0.592, 0.420); g.quadraticCurveTo(0.568, 0.408, 0.544, 0.418); g.stroke();
    }
    // 眼
    cEye(g, 0.437, 0.472, 0.033, '#ffffff', A.eye, '#241c14');
    cEye(g, 0.563, 0.472, 0.033, '#ffffff', A.eye, '#241c14');
    // 鼻
    g.strokeStyle = A.skinD; g.lineWidth = 0.012;
    g.beginPath(); g.moveTo(0.5, 0.49); g.quadraticCurveTo(0.508, 0.51, 0.497, 0.518); g.stroke();
    // 嘴
    g.strokeStyle = 'rgba(120,60,50,.85)'; g.lineWidth = 0.014;
    if (id === 't_ember') {
      g.beginPath(); g.moveTo(0.472, 0.552); g.quadraticCurveTo(0.5, 0.568, 0.528, 0.550); g.stroke();
    } else {
      g.beginPath(); g.moveTo(0.468, 0.552); g.quadraticCurveTo(0.5, 0.575, 0.532, 0.552); g.stroke();
    }

    // ---- 发型 / 头饰（前层） ----
    if (id === 't_bolt') {
      // 短发顶
      cEll(g, 0.5, 0.372, 0.162, 0.072, 0, A.hair);
      // 雷纹头巾
      cRR(g, 0.332, 0.382, 0.336, 0.062, 0.024, A.top, '#1a2c4a', 0.012);
      g.strokeStyle = '#ffd93d'; g.lineWidth = 0.008;
      g.beginPath(); g.moveTo(0.348, 0.394); g.lineTo(0.652, 0.394); g.stroke();
      g.beginPath(); g.moveTo(0.348, 0.432); g.lineTo(0.652, 0.432); g.stroke();
      g.strokeStyle = '#ffd93d'; g.lineWidth = 0.013;
      g.beginPath();
      g.moveTo(0.40, 0.424); g.lineTo(0.445, 0.424); g.lineTo(0.43, 0.404); g.lineTo(0.475, 0.404);
      g.stroke();
      g.beginPath();
      g.moveTo(0.525, 0.424); g.lineTo(0.57, 0.424); g.lineTo(0.555, 0.404); g.lineTo(0.60, 0.404);
      g.stroke();
      // 巾结 + 飘带
      cCir(g, 0.662, 0.412, 0.026, '#ffd93d', '#b58a00', 0.008);
      cShp(g, [[0.672, 0.404], [0.775, 0.372], [0.812, 0.412], [0.70, 0.428]], A.top, '#1a2c4a', 0.010);
      cShp(g, [[0.67, 0.424], [0.762, 0.452], [0.786, 0.50], [0.678, 0.452]], A.topD, '#1a2c4a', 0.009);
      // 鬓发
      cEll(g, 0.345, 0.50, 0.026, 0.048, 0, A.hair);
      cEll(g, 0.655, 0.50, 0.026, 0.048, 0, A.hair);
    } else if (id === 't_leaf') {
      // 刘海
      g.beginPath();
      g.moveTo(0.335, 0.455);
      g.bezierCurveTo(0.33, 0.28, 0.43, 0.245, 0.5, 0.245);
      g.bezierCurveTo(0.57, 0.245, 0.67, 0.28, 0.665, 0.455);
      g.quadraticCurveTo(0.62, 0.395, 0.565, 0.415);
      g.quadraticCurveTo(0.53, 0.36, 0.49, 0.415);
      g.quadraticCurveTo(0.43, 0.36, 0.405, 0.425);
      g.quadraticCurveTo(0.365, 0.40, 0.335, 0.455);
      g.closePath();
      g.fillStyle = cLin(g, 0.35, 0.25, 0.65, 0.46, [[0, '#8a6438'], [1, A.hair]]);
      g.fill(); g.lineWidth = 0.014; g.strokeStyle = OL; g.stroke();
      // 木冠 + 叶饰
      cRR(g, 0.355, 0.368, 0.29, 0.050, 0.020, '#7a5a34', '#4a3218', 0.010);
      cEll(g, 0.40, 0.368, 0.030, 0.018, -0.4, '#7ec850', '#3f7a2c', 0.008);
      cEll(g, 0.5, 0.361, 0.032, 0.020, 0, '#7ec850', '#3f7a2c', 0.008);
      cEll(g, 0.60, 0.368, 0.030, 0.018, 0.4, '#7ec850', '#3f7a2c', 0.008);
      cEll(g, 0.632, 0.332, 0.023, 0.042, 0.7, '#8ed36a', '#3f7a2c', 0.008);
      // 耳侧长发
      cCurveTaper(g, 0.362, 0.46, 0.322, 0.56, 0.338, 0.70, 0.036, 0.018, A.hair, A.hairD, 0.008);
      cCurveTaper(g, 0.638, 0.46, 0.678, 0.56, 0.662, 0.70, 0.036, 0.018, A.hair, A.hairD, 0.008);
    } else if (id === 't_ember') {
      // 头顶刺发 + 束冠
      cShp(g, [[0.40, 0.345], [0.435, 0.255], [0.475, 0.33], [0.52, 0.245], [0.555, 0.335], [0.60, 0.29], [0.585, 0.375], [0.5, 0.395], [0.415, 0.375]], cLin(g, 0.4, 0.26, 0.6, 0.4, [[0, '#e86a3a'], [1, A.hair]]), A.hairD, 0.012);
      // 金色发冠
      cRR(g, 0.432, 0.316, 0.136, 0.036, 0.016, '#e8b33a', '#a87a10', 0.010);
      cCir(g, 0.5, 0.292, 0.032, A.hair, A.hairD, 0.008);
      cCir(g, 0.5, 0.292, 0.012, '#ffd93d');
      // 鬓角
      cEll(g, 0.352, 0.505, 0.026, 0.050, 0, A.hair);
      cEll(g, 0.648, 0.505, 0.026, 0.050, 0, A.hair);
    } else {
      // 发髻 + 玉簪
      cCir(g, 0.5, 0.299, 0.048, A.hair, A.hairD, 0.012);
      cCir(g, 0.5, 0.299, 0.030, A.hairD, null, 0);
      cTaper(g, 0.415, 0.297, 0.585, 0.297, 0.008, 0.008, '#a8e0ff', '#5a8aa8', 0.005);
      cCir(g, 0.585, 0.297, 0.018, '#7af0d0', '#2f8a78', 0.008);
      cCir(g, 0.585, 0.297, 0.007, '#ffffff');
      // 刘海
      cShp(g, [[0.34, 0.47], [0.352, 0.365], [0.41, 0.305], [0.5, 0.288], [0.59, 0.305], [0.648, 0.365], [0.66, 0.47], [0.62, 0.415], [0.565, 0.395], [0.53, 0.43], [0.47, 0.43], [0.435, 0.395], [0.38, 0.415]], cLin(g, 0.4, 0.30, 0.6, 0.47, [[0, '#4f7ac8'], [1, A.hair]]), '#1f3a66', 0.012);
      // 耳侧发
      cCurveTaper(g, 0.36, 0.48, 0.33, 0.60, 0.335, 0.72, 0.030, 0.016, A.hair, A.hairD, 0.008);
      cCurveTaper(g, 0.64, 0.48, 0.67, 0.60, 0.665, 0.72, 0.030, 0.016, A.hair, A.hairD, 0.008);
    }

    // ---- 右下属性徽章 ----
    cCir(g, 0.795, 0.795, 0.115, '#ffffff');
    cCir(g, 0.795, 0.795, 0.115, null, 'rgba(255,255,255,.9)', 0.022);
    cCir(g, 0.795, 0.795, 0.096, A.ring);
    cCir(g, 0.795, 0.795, 0.096, null, '#ffffff', 0.012);
    drawSymbol(g, A.symbol, 0.795, 0.795, 0.052, '#ffffff');
    // 左上柔光
    g.save();
    g.globalAlpha = 0.32;
    cCir(g, 0.20, 0.16, 0.10, cRad(g, 0.2, 0.16, 0.01, 0.10, [[0, '#ffffff'], [1, 'rgba(255,255,255,0)']]));
    g.restore();
  }

  // =========================================================================
  // 4. 对外接口：缓存 canvas + 挂载 PG.models.art
  // =========================================================================
  var CACHE = new Map();

  function cacheGet(key) {
    var c = CACHE.get(key);
    return c || null;
  }

  function icon(id, size) {
    try {
      if (!ICONS[id]) return null;
      var s = Math.max(16, Math.round(size || 96));
      var key = 'i|' + id + '|' + s;
      var c = cacheGet(key);
      if (c) return c;
      var m = mkCanvas(s);
      if (!m.g) return null;
      var g = m.g;
      cRR(g, 0, 0, 1, 1, 0.18, '#ffffff', null, 0);
      g.save();
      g.beginPath();
      cRR(g, 0, 0, 1, 1, 0.18, null, null, 0);
      g.clip();
      ICONS[id](g);
      g.restore();
      g.save();
      g.globalAlpha = 0.10;
      g.beginPath();
      g.moveTo(0, 0.42); g.quadraticCurveTo(0.5, 0.28, 1, 0.42);
      g.lineTo(1, 0); g.lineTo(0, 0); g.closePath();
      g.fillStyle = '#ffffff'; g.fill();
      g.restore();
      CACHE.set(key, m.canvas);
      return m.canvas;
    } catch (e) {
      if (window.console && console.warn) console.warn('PG.models.art.icon 绘制失败(' + id + ')：', e);
      return null;
    }
  }

  function portrait(id, size) {
    try {
      var s = Math.max(32, Math.round(size || 256));
      var isTrainer = !!TRAINER_ART[id];
      if (!isTrainer && !ICONS[id]) return null;
      var key = 'p|' + id + '|' + s;
      var c = cacheGet(key);
      if (c) return c;
      var m = mkCanvas(s);
      if (!m.g) return null;
      var g = m.g;
      cRR(g, 0, 0, 1, 1, 0.16, '#ffffff', null, 0);
      g.save();
      g.beginPath();
      cRR(g, 0, 0, 1, 1, 0.16, null, null, 0);
      g.clip();
      if (isTrainer) {
        drawTrainerPortrait(g, id);
      } else {
        // 异兽也可拿 portrait（UI 兜底）：图标放大 + 白环
        ICONS[id](g);
        cCir(g, 0.5, 0.5, 0.475, null, 'rgba(255,255,255,.92)', 0.02);
      }
      g.restore();
      CACHE.set(key, m.canvas);
      return m.canvas;
    } catch (e) {
      if (window.console && console.warn) console.warn('PG.models.art.portrait 绘制失败(' + id + ')：', e);
      return null;
    }
  }

  function has(id) {
    return !!(ICONS[id] || TRAINER_ART[id]);
  }

  var api = { icon: icon, portrait: portrait, has: has };

  // 构建顺序保证 30-models 先加载；若缺席也不报错，仍可用 PG.art 自测
  try {
    if (PG.models && typeof PG.models === 'object') PG.models.art = api;
  } catch (e) { /* 忽略：models 未就绪时仅提供 PG.art */ }
  try { PG.art = api; } catch (e) { /* 忽略 */ }
})();

/* ==================== 40-util.js ==================== */
/* 40-util.js — 通用工具（Lead） */
(() => {
  const PG = (window.PG = window.PG || {});
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
  const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0 || 1e-6), 0, 1); return t * t * (3 - 2 * t); };
  const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
  const randInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];
  const chance = (p) => Math.random() < p;
  const now = () => (window.performance && performance.now ? performance.now() : Date.now());

  function dirXZ(fromX, fromZ, toX, toZ) {
    const dx = toX - fromX, dz = toZ - fromZ;
    const l = Math.hypot(dx, dz) || 1;
    return { x: dx / l, z: dz / l, len: Math.hypot(dx, dz) };
  }

  function disposeTree(obj) {
    if (!obj) return;
    obj.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          for (const k in m) {
            const v = m[k];
            if (v && v.isTexture) v.dispose();
          }
          m.dispose();
        }
      }
    });
  }

  // 简易对象池
  class Pool {
    constructor(factory, reset, size = 0) {
      this.factory = factory; this.reset = reset; this.free = [];
      for (let i = 0; i < size; i++) this.free.push(factory());
    }
    get() { return this.free.length ? this.free.pop() : this.factory(); }
    put(o) { this.reset && this.reset(o); this.free.push(o); }
  }

  // 屏幕坐标投影：世界点 -> 屏幕像素（返回 null 表示在相机背后）
  function project(v3, camera, w, h) {
    const p = v3.clone().project(camera);
    if (p.z > 1) return null;
    return { x: (p.x * 0.5 + 0.5) * w, y: (-p.y * 0.5 + 0.5) * h, z: p.z };
  }

  function fmtTime(sec) {
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  // 线性同余随机（固定种子，让场景可重复生成）
  function seeded(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  PG.util = { TAU, clamp, lerp, damp, smoothstep, rand, randInt, pick, chance, now, dirXZ, disposeTree, Pool, project, fmtTime, seeded };
  PG.errors = PG.errors || [];
  window.addEventListener('error', (e) => { PG.errors.push(String(e.message)); });
})();

/* ==================== 50-game.js ==================== */
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
      gun: { dmg: 15, rate: 0.115, pellets: 1, spread: 0.005, speed: 108, ammoMax: 36, reload: 0.9, splash: 0, pierce: 0, crit: 2.0, projColor: 0xffe66b },
    },
    {
      id: 't_leaf', cn: '句芒', en: 'GOUMANG', type: 'mu', color: '#8ed36a', colorHex: 0x8ed36a,
      partner: 'qilin', partnerCn: '麒麟',
      weapon: '灵种杖', weaponShort: '灵种杖',
      passive: '春生：脱战 4 秒后缓慢回复体力',
      ult: '万物生：灵雨护体，回血并减速周围妖物',
      hp: 110, speed: 1.0,
      gun: { dmg: 12, rate: 0.62, pellets: 5, spread: 0.05, speed: 62, ammoMax: 12, reload: 1.15, splash: 0, pierce: 1, crit: 1.8, projColor: 0x9ef06b },
    },
    {
      id: 't_ember', cn: '祝融', en: 'ZHURONG', type: 'huo', color: '#ff8a3d', colorHex: 0xff8a3d,
      partner: 'bifang', partnerCn: '毕方',
      weapon: '离火铳', weaponShort: '离火铳',
      passive: '余烬：击杀后 2 秒内伤害 +40%',
      ult: '焚天业火：以自身为中心的爆炎新星，范围灼烧',
      hp: 120, speed: 0.94,
      gun: { dmg: 46, rate: 0.44, pellets: 1, spread: 0.008, speed: 58, ammoMax: 10, reload: 1.3, splash: 2.8, pierce: 0, crit: 1.7, projColor: 0xff9a3c },
    },
    {
      id: 't_tide', cn: '玄冥', en: 'XUANMING', type: 'shui', color: '#5ab8f0', colorHex: 0x5ab8f0,
      partner: 'xuanwu', partnerCn: '玄武',
      weapon: '玄水枪', weaponShort: '玄水枪',
      passive: '潮汐：每第 5 发伤害翻倍并回复 2 点体力',
      ult: '玄冥水盾：3 秒无敌，冲开周围所有敌人',
      hp: 105, speed: 1.03,
      gun: { dmg: 19, rate: 0.155, pellets: 1, spread: 0.004, speed: 96, ammoMax: 42, reload: 1.05, splash: 0, pierce: 2, crit: 1.8, projColor: 0x6fd8ff },
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

  // ============================ 难度 ============================
  // 三档：悠然（默认，小朋友 / 新手）、标准、挑战（原版强度）。
  // 数值全部是「相对原版基准的倍率」，挑战档 = 原版手感，方便随时回退。
  const DIFFS = {
    easy: {
      id: 'easy', cn: '悠然', en: 'EASY', color: '#8ed36a',
      desc: '妖物更慢更轻 · 灵兽自动帮忙 · 护主复活一次',
      enemyHp: 0.6, enemyDmg: 0.45, enemySpd: 0.85, enemyCd: 1.3, eProjSpd: 0.65,
      maxAlive: 6, spawnNear: [12, 20], spawnArc: Math.PI,
      playerHp: 1.35, invuln: 0.55, waveHeal: 0.35,
      revive: true, aimAssist: 3.5, hitScale: 1.5, autoHelp: true,
      bossHp: 0.6, bossFan: 5, scoreMul: 0.8,
    },
    normal: {
      id: 'normal', cn: '标准', en: 'NORMAL', color: '#e8b33a',
      desc: '节奏舒展 · 有挑战，但不会手忙脚乱',
      enemyHp: 0.9, enemyDmg: 0.75, enemySpd: 0.95, enemyCd: 1.1, eProjSpd: 0.85,
      maxAlive: 9, spawnNear: [15, 26], spawnArc: Math.PI * 4 / 3,
      playerHp: 1.15, invuln: 0.4, waveHeal: 0.22,
      revive: false, aimAssist: 1.2, hitScale: 1, autoHelp: false,
      bossHp: 0.9, bossFan: 9, scoreMul: 1,
    },
    hard: {
      id: 'hard', cn: '挑战', en: 'HARD', color: '#d0432e',
      desc: '原版强度 · 妖物四面来袭，只靠走位与枪法',
      enemyHp: 1.15, enemyDmg: 1.1, enemySpd: 1, enemyCd: 1, eProjSpd: 1,
      maxAlive: 12, spawnNear: [18, 32], spawnArc: Math.PI * 2,
      playerHp: 1, invuln: 0.28, waveHeal: 0,
      revive: false, aimAssist: 0, hitScale: 1, autoHelp: false,
      bossHp: 1, bossFan: 14, scoreMul: 1.15,
    },
  };
  const DIFF_ORDER = ['easy', 'normal', 'hard'];
  const DIFF_DEFAULT = 'easy';

  // ============================ 波次 ============================
  const WAVES = [
    { name: '林间异动', tip: '山里的灵气乱了……有东西在盯着我们！先瞄准脚下有光环的妖物！', list: [['lushu', 4], ['wugong', 2]] },
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
    pending: [], focus: null,
    diff: DIFFS[DIFF_DEFAULT], diffId: DIFF_DEFAULT, sens: 1,
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
      hp: Math.round(char.hp * G.diff.playerHp), hpMax: Math.round(char.hp * G.diff.playerHp),
      speed: 5.4 * char.speed,
      eye: 1.62, onGround: true, vy: 0,
      fireCd: 0, ammo: char.gun.ammoMax, reloading: false, reloadT: 0,
      recoil: 0, bloom: 0, camShake: 0,
      dashCd: 0, dashT: 0, dashDir: new THREE.Vector3(), invuln: 0,
      ultCd: 0, ultMax: 13,
      charge: 0, emberT: 0, tideCount: 0, outT: 0,
      bobT: 0, bobAmt: 0, strafeLean: 0, hurtT: 0, dead: false,
      shieldT: 0, slowT: 0,
      kills: 0, shots: 0, hits: 0, reviveUsed: false, helpCd: 3.0,
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
        const c = e.hitCenter, r = e.hitRadius * (G.diff.hitScale || 1);
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
        if (p.pos.distanceTo(pc) < 0.55 + p.radius) {
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

  const AURA_COLOR = { enemy: 0x7fe0a0, elite: 0xffd66b, boss: 0xff6b4a };
  // 脚下光环：让妖物在草丛 / 远处也能一眼看见（纯提示，不参与受击）
  function makeAura(e) {
    const col = AURA_COLOR[e.kind] || AURA_COLOR.enemy;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: ringTexture(hexStr(col)), color: 0xffffff, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }));
    const s = e.kind === 'boss' ? 4.2 : e.kind === 'elite' ? 2.2 : 1.15;
    sp.scale.set(s, s, 1);
    sp.position.set(e.pos.x, 0.06, e.pos.z);
    sp.renderOrder = 1;
    G.scene.add(sp);
    return sp;
  }

  // 受击闪白 / 准星聚焦呼吸光，统一走材质自发光，避免额外的描边 draw call
  function updateEnemyGlow(e, t) {
    const flash = e.flash > 0.02;
    const focus = e.focus;
    const pulse = 0.55 + Math.sin(t * 6 + e.id) * 0.35;
    for (const m of e.mats) {
      if (!m.emissive) continue;
      if (flash) {
        m.emissive.setHex(0xffffff);
        if (m.emissiveIntensity !== undefined) m.emissiveIntensity = 1.6;
      } else if (focus) {
        m.emissive.setHex(0xffc94a);
        if (m.emissiveIntensity !== undefined) m.emissiveIntensity = pulse;
      } else {
        const base = m.userData.baseEmissive;
        if (base != null) m.emissive.setHex(base);
        if (m.emissiveIntensity !== undefined) m.emissiveIntensity = m.userData.baseEmissiveI == null ? 1 : m.userData.baseEmissiveI;
      }
    }
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

    const d = G.diff;
    const boss = def.kind === 'boss';
    const hp = Math.max(1, Math.round(def.hp * (opt.hpMul || 1) * (boss ? d.bossHp : d.enemyHp)));
    // 材质自发光基线：用于「受击闪白 / 准星聚焦呼吸光」
    for (const m of mats) {
      if (!m.emissive) continue;
      m.userData.baseEmissive = m.emissive.getHex();
      m.userData.baseEmissiveI = m.emissiveIntensity == null ? 1 : m.emissiveIntensity;
    }
    const e = {
      id: enemyIdSeq++, type: id, def, group, model, mats,
      pos: new THREE.Vector3(x, def.y || 0, z),
      hp, hpMax: hp, alive: true, radius, height,
      hitRadius: Math.max(0.55, radius * 1.3),
      hitCenter: new THREE.Vector3(x, (def.y || 0) + height * 0.5, z),
      // 难度生效后的实际数值（AI 一律读这些字段，不再直接读 def）
      spd: def.spd * d.enemySpd,
      cdMax: def.cd * d.enemyCd,
      dmg: (def.dmg || 8) * d.enemyDmg,
      range: def.range || 26,
      projSpd: (def.projSpd || 20) * d.eProjSpd,
      dashSpeed: 17 * d.enemySpd,
      cd: rand(0.6, 1.6) * d.enemyCd, state: 'spawn', flash: 0,
      yOff: 0, anim: rand(0, 10), spawnT: 0, dying: 0, slow: 0,
      dashT: 0, dashCd: 0, dashDir: new THREE.Vector3(), teleT: 2.5,
      windT: 0, alert: 0, focus: false, aura: null,
      kind: def.kind || 'enemy',
    };
    if (def.ghost) for (const m of mats) { if (m.transparent !== undefined) { m.transparent = true; m.opacity = 0.72; } }
    e.aura = makeAura(e);
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
    if (G.focus === e) G.focus = null;
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
    if (PG.ui && PG.ui.hitmarker) PG.ui.hitmarker('kill');
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
    hurtPlayer((e.dmg || e.def.dmg || 8) * (mul || 1), e.pos.clone().setY(1.0));
    spawnSpark(new THREE.Vector3(pl.pos.x, 1.1, pl.pos.z), 0xff6b5a, 8, 0.9, 0.35);
  }

  function rangedAttack(e, mul) {
    const pl = G.player;
    if (!pl) return;
    const from = new THREE.Vector3(e.pos.x, e.pos.y + e.height * 0.6 + (e.yOff || 0), e.pos.z);
    const aim = new THREE.Vector3(pl.pos.x, pl.pos.y + 1.0, pl.pos.z);
    const d = from.distanceTo(aim);
    const tt = d / (e.projSpd || 20);
    aim.x += pl.vel.x * tt * 0.6;
    aim.z += pl.vel.z * tt * 0.6;
    const dir = aim.sub(from).normalize();
    fireProjectile(from, dir, { dmg: (e.dmg || 8) * (mul || 1), projSpd: e.projSpd || 20 }, 1, true, 0xff6a5a);
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
    const spd = e.spd * (phase2 ? 1.5 : 1);
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
          fireProjectile(from.clone(), dir, { dmg: e.dmg * 0.6, projSpd: e.projSpd * 1.2 }, 1, true, 0xff9a4a);
        }
        if (PG.audio) PG.audio.sfx('boss_roar', { vol: 0.5, rate: 1.5 });
        e.cd = phase2 ? 1.5 : 2.2;
      } else if (mode === 1) {
        const n = phase2 ? G.diff.bossFan + 5 : G.diff.bossFan;
        const from = new THREE.Vector3(e.pos.x, e.pos.y + e.height * 0.7, e.pos.z);
        for (let i = 0; i < n; i++) {
          const a = (i / n) * TAU + t;
          fireProjectile(from.clone(), new THREE.Vector3(Math.cos(a), rand(-0.05, 0.05), Math.sin(a)), { dmg: e.dmg * 0.45, projSpd: e.projSpd * 0.8 }, 1, true, 0xffb04a);
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
    if (dist < 2.6 && Math.random() < dt * 1.6) hurtPlayer(e.dmg, e.pos.clone());
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
      if (e.aura) e.aura.material.opacity = (1 - k) * 0.45;
      e.group.position.y += dt * 1.5;
      if (e.dying <= 0) {
        G.scene.remove(e.group);
        if (PG.util && PG.util.disposeTree) PG.util.disposeTree(e.group);
        if (e.aura) { if (e.aura.parent) e.aura.parent.remove(e.aura); e.aura.material.dispose(); e.aura = null; }
        const idx = G.enemies.indexOf(e);
        if (idx >= 0) G.enemies.splice(idx, 1);
      }
      return;
    }

    if (e.flash > 0) e.flash -= dt;
    updateEnemyGlow(e, t);

    e.slow = Math.max(0, e.slow - dt);
    const slowMul = e.slow > 0 ? 0.45 : 1;
    const spd = e.spd * slowMul * (1 + (G.state.wave - 1) * 0.045);
    let mvx = 0, mvz = 0;
    const attackRange = 1.8 + e.radius;

    if (e.state === 'active') {
      switch (e.def.ai) {
        case 'melee':
        case 'heavy':
          if (dist > attackRange) { mvx = nx * spd; mvz = nz * spd; }
          else { e.cd -= dt; if (e.cd <= 0) { e.cd = e.cdMax; meleeAttack(e); } }
          break;
        case 'strafe': {
          const side = Math.sin(t * 1.7 + e.id) > 0 ? 1 : -1;
          if (dist > 7) { mvx = nx * spd; mvz = nz * spd; }
          else { mvx = -nz * spd * 0.85 * side + nx * spd * 0.25; mvz = nx * spd * 0.85 * side + nz * spd * 0.25; }
          e.cd -= dt;
          if (e.cd <= 0 && dist < 14) { e.cd = e.cdMax; rangedAttack(e, 1); }
          break;
        }
        case 'ranged':
          if (dist > e.range * 0.75) { mvx = nx * spd; mvz = nz * spd; }
          else if (dist < e.range * 0.4) { mvx = -nx * spd * 0.7; mvz = -nz * spd * 0.7; }
          e.cd -= dt;
          if (e.cd <= 0) { e.cd = e.cdMax; rangedAttack(e, 1); }
          break;
        case 'flyer': {
          e.pos.y = 1.5 + Math.sin(t * 2.2 + e.id) * 0.35;
          if (dist > 2.2) { const dive = dist < 9 ? 1.7 : 1; mvx = nx * spd * dive; mvz = nz * spd * dive; }
          else { e.cd -= dt; if (e.cd <= 0) { e.cd = e.cdMax; meleeAttack(e); } }
          break;
        }
        case 'float':
          e.pos.y = 1.3 + Math.sin(t * 1.8 + e.id) * 0.25;
          if (dist > 3) { mvx = nx * spd; mvz = nz * spd; }
          e.cd -= dt;
          if (e.cd <= 0 && dist < 16) { e.cd = e.cdMax; rangedAttack(e, 1); }
          break;
        case 'sing':
          if (dist > 2.0) { mvx = nx * spd; mvz = nz * spd; }
          else { e.cd -= dt; if (e.cd <= 0) { e.cd = e.cdMax; singAttack(e); } }
          break;
        case 'dash':
          e.dashCd = Math.max(0, e.dashCd - dt);
          if (e.dashT > 0) {
            e.dashT -= dt;
            mvx = e.dashDir.x * e.dashSpeed; mvz = e.dashDir.z * e.dashSpeed;
            if (dist < attackRange) { meleeAttack(e, 1.6); e.dashT = 0; }
          } else if (e.windT > 0) {
            // 冲刺前摇：脚下黄环 + 头顶 "!"，给玩家反应时间
            e.windT -= dt;
            e.alert = 1;
            if (e.windT <= 0) { e.dashT = 0.45; e.dashDir.set(nx, 0, nz); }
          } else {
            if (dist > 9) { mvx = nx * spd; mvz = nz * spd; }
            else { mvx = -nz * spd * 0.5; mvz = nx * spd * 0.5; }
            if (e.dashCd <= 0 && dist < 20) {
              e.dashCd = e.cdMax; e.windT = 0.38;
              spawnRing(e.pos.clone().setY(0.2), 0xffe066, 1.4, 0.38);
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
          if (e.cd <= 0 && dist < 18) { e.cd = e.cdMax; rangedAttack(e, 1.4); }
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

    // 危险预警：即将攻击 / 正在蓄力
    e.alert = Math.max(0, e.alert - dt * 2.5);
    if (e.state === 'active' && (e.windT > 0 || (e.cd <= 0.4 && dist < 16))) e.alert = 1;
    if (e.aura) {
      const base = e.kind === 'boss' ? 4.2 : e.kind === 'elite' ? 2.2 : 1.15;
      const s = base * (0.94 + Math.sin(t * 3 + e.id) * 0.07) * (e.focus ? 1.14 : 1);
      e.aura.scale.set(s, s, 1);
      e.aura.position.set(e.pos.x, 0.06, e.pos.z);
      e.aura.material.opacity = Math.min(1, (e.focus ? 0.95 : 0.5) * (e.state === 'spawn' ? 0.35 : 1));
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
    pl.invuln = G.diff.invuln;
    pl.camShake = Math.min(0.35, 0.10 + dmg * 0.003);
    pl.outT = 0;
    if (PG.audio) PG.audio.sfx('hurt', { vol: 0.8 });
    if (PG.ui && PG.ui.hurtFlash) PG.ui.hurtFlash(Math.min(0.6, dmg / 30));
    if (PG.ui && PG.ui.damageFrom && fromPos) {
      const ang = Math.atan2(fromPos.x - pl.pos.x, fromPos.z - pl.pos.z);
      PG.ui.damageFrom(ang - (pl.yaw + Math.PI));
    }
    if (pl.hp <= 0) {
      // 悠然档：灵兽护主，把玩家拉回来一次
      if (G.diff.revive && !pl.reviveUsed) {
        pl.reviveUsed = true;
        pl.hp = Math.round(pl.hpMax * 0.5);
        pl.invuln = 3.0;
        pl.camShake = 0.5;
        spawnRing(new THREE.Vector3(pl.pos.x, 0.2, pl.pos.z), 0x9ef06b, 6, 1.0);
        spawnSpark(new THREE.Vector3(pl.pos.x, 1.1, pl.pos.z), 0x9ef06b, 40, 1.8, 0.9);
        if (PG.audio) PG.audio.sfx('levelup', { vol: 0.9 });
        if (PG.ui) {
          if (PG.ui.banner) PG.ui.banner('灵兽护主', '你被灵兽拉了回来 · 体力恢复一半', 2200);
          if (PG.ui.toast) PG.ui.toast('灵兽护主！接下来小心一点', 2000);
        }
        return;
      }
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
    pl.recoil = Math.min(1, pl.recoil + 0.30);
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
    // 瞄准辅助：射线往准星附近的目标轻拉一点（难度可调，挑战档为 0 = 关闭）
    if (G.diff.aimAssist > 0) aimAssistDir(origin, dir);

    const count = gun.pellets || 1;
    for (let i = 0; i < count; i++) {
      const d = dir.clone();
      const spread = gun.spread * (1 + pl.bloom * 1.15);
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

  // 准星附近的软吸附（不改命中判定本身，只把射线方向拉向目标）
  function aimAssistDir(origin, dir) {
    const maxAng = G.diff.aimAssist * Math.PI / 180;
    let best = null, bestAng = maxAng;
    for (const e of G.enemies) {
      if (!e.alive || e.state === 'dying') continue;
      const to = e.hitCenter.clone().sub(origin);
      const d = to.length();
      if (d > 60 || d < 0.5) continue;
      to.multiplyScalar(1 / d);
      const ang = dir.angleTo(to);
      if (ang < bestAng) { bestAng = ang; best = to; }
    }
    if (!best) return false;
    const k = 0.55 + 0.35 * (1 - bestAng / maxAng);
    dir.lerp(best, k).normalize();
    return true;
  }

  // 灵兽自动协助：一道绿色灵光 + 低额伤害，给小朋友一个"伙伴在帮忙"的反馈
  function spiritHelp() {
    const pl = G.player;
    if (!pl || pl.dead) return;
    let best = null, bd = 20;
    for (const e of G.enemies) {
      if (!e.alive || e.state === 'spawn' || e.state === 'dying') continue;
      const d = e.pos.distanceTo(pl.pos);
      if (d < bd) { bd = d; best = e; }
    }
    if (!best) { pl.helpCd = 1.0; return; }
    const from = new THREE.Vector3(pl.pos.x - 0.6, pl.pos.y + 1.2, pl.pos.z - 0.6);
    spawnBeamFX(from, best.hitCenter.clone(), 0x8ed36a, 0.22);
    damageEnemy(best, 10, best.hitCenter.clone(), 'hit');
    spawnSpark(best.hitCenter.clone(), 0x8ed36a, 6, 0.9, 0.3);
    pl.helpCd = 4.0;
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

    const look = 0.0030 * (G.sens || 1);
    pl.yaw -= (input.dx || 0) * look;
    pl.pitch -= (input.dy || 0) * look;
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
      pl.dashCd = 1.0;
      pl.dashT = 0.2;
      pl.invuln = Math.max(pl.invuln, 0.32);
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

    // 悠然档：灵兽每 4 秒自动帮你打一下最近的妖物
    if (G.diff.autoHelp) {
      pl.helpCd = Math.max(0, pl.helpCd - dt);
      if (pl.helpCd <= 0 && !pl.reloading) spiritHelp();
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

    pl.recoil = Math.max(0, pl.recoil - dt * 9);
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
    G.focus = null;
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
      const pl = G.player;
      if (pl) {
        pl.hp = pl.hpMax;
        pl.ammo = G.char.gun.ammoMax;
        pl.reloading = false;
        if (PG.ui && PG.ui.toast) PG.ui.toast('山灵馈赠：体力与能量已充满', 2400);
      }
      const bossHp = Math.round(ENEMIES.hundun.hp * G.diff.bossHp);
      spawnEnemyAt('hundun', 0, -24);
      G.state.boss = { name: '混沌', hp: bossHp, hpMax: bossHp };
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

  // 刷怪预警：先出现地面涟漪，0.8 秒后妖物才钻出来，避免"凭空冒出来"
  function queueSpawn(id, x, z) {
    const ring = new THREE.Sprite(new THREE.SpriteMaterial({
      map: ringTexture('#b46bff'), color: 0xffffff, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }));
    ring.position.set(x, 0.12, z);
    ring.scale.setScalar(1.0);
    G.scene.add(ring);
    G.pending.push({ id, x, z, t: 0.8, dur: 0.8, ring });
  }

  function updatePending(dt) {
    for (let i = G.pending.length - 1; i >= 0; i--) {
      const p = G.pending[i];
      p.t -= dt;
      const k = clamp(1 - Math.max(0, p.t) / p.dur, 0, 1);
      p.ring.scale.setScalar(1.0 + k * 1.4);
      p.ring.material.opacity = 0.14 + (1 - k) * 0.5;
      if (p.t <= 0) {
        if (p.ring.parent) p.ring.parent.remove(p.ring);
        p.ring.material.dispose();
        G.pending.splice(i, 1);
        spawnEnemyAt(p.id, p.x, p.z);
      }
    }
  }

  function aliveCount() {
    let n = G.pending.length;
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
      const maxAlive = Math.min(G.diff.maxAlive, 4 + Math.ceil(w.index * 1.1));
      if (w.spawnT <= 0 && alive < maxAlive) {
        const id = w.queue.pop();
        // 从玩家正前方扇区刷怪：悠然 180° / 标准 240° / 挑战 360°
        const fwd = Math.atan2(-Math.cos(G.player.yaw), -Math.sin(G.player.yaw));
        const arc = G.diff.spawnArc;
        const ang = fwd + rand(-arc / 2, arc / 2);
        const near = rand(G.diff.spawnNear[0], G.diff.spawnNear[1]) - Math.min(4, w.index * 0.8);
        const px = G.player.pos.x + Math.cos(ang) * near;
        const pz = G.player.pos.z + Math.sin(ang) * near;
        const R = (G.world ? G.world.radius : 60) - 3;
        const dl = Math.hypot(px, pz) || 1;
        const sx = dl > R ? (px / dl) * R : px;
        const sz = dl > R ? (pz / dl) * R : pz;
        queueSpawn(id, sx, sz);
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
      const heal = G.diff.waveHeal;
      if (heal > 0) pl.hp = Math.min(pl.hpMax, pl.hp + pl.hpMax * heal);
      pl.ammo = G.char.gun.ammoMax;
      pl.reloading = false;
      if (PG.audio) PG.audio.sfx('heal', { vol: 0.7 });
      if (PG.ui) {
        if (PG.ui.banner) PG.ui.banner('第 ' + (w.index + 1) + ' 波 · 清除', heal > 0 ? '体力与能量已补充' : '没有补给，靠你自己了', 2000);
        if (PG.ui.toast && heal > 0) PG.ui.toast('体力已恢复，能量充满！', 1800);
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

  // ============================ 准星聚焦 / 目标提示 ============================
  const _fv = new THREE.Vector3(), _tv = new THREE.Vector3(), _cv = new THREE.Vector3();
  let focusT = 0;
  function updateFocus(dt) {
    focusT += dt;
    if (focusT < 1 / 20) return;
    focusT = 0;
    const cam = G.camera;
    if (!cam) return;
    cam.getWorldPosition(_fv);
    cam.getWorldDirection(_cv);
    let best = null, bestAng = 0.12; // 约 7°：准星附近才算"锁定"
    for (const e of G.enemies) {
      if (!e.alive || e.state === 'dying') continue;
      _tv.copy(e.hitCenter).sub(_fv);
      const d = _tv.length();
      if (d > 55 || d < 0.4) continue;
      _tv.multiplyScalar(1 / d);
      const ang = _cv.angleTo(_tv);
      if (ang < bestAng) { bestAng = ang; best = e; }
    }
    if (G.focus && G.focus !== best) G.focus.focus = false;
    G.focus = best;
    if (best) best.focus = true;
  }

  // 头顶血条数据：受伤 / 被锁定 / 悠然档近距离时显示
  function collectBars() {
    const cam = G.camera, w = window.innerWidth, h = window.innerHeight;
    if (!cam || !G.player) return [];
    const out = [];
    for (const e of G.enemies) {
      if (!e.alive || e.state === 'spawn' || e.state === 'dying') continue;
      const damaged = e.hp < e.hpMax - 0.01;
      const near = G.diff.id === 'easy' && e.pos.distanceTo(G.player.pos) < 26;
      if (!damaged && !e.focus && !near && e.alert <= 0) continue;
      const p = PG.util.project(new THREE.Vector3(e.pos.x, e.pos.y + e.height + 0.35, e.pos.z), cam, w, h);
      if (!p || p.x < -60 || p.x > w + 60 || p.y < -60 || p.y > h + 60) continue;
      out.push({ x: p.x, y: p.y, ratio: clamp(e.hp / e.hpMax, 0, 1), kind: e.kind, focus: !!e.focus, alert: e.alert > 0 });
    }
    out.sort((a, b) => (a.focus ? 0 : 1) - (b.focus ? 0 : 1));
    return out.slice(0, 8);
  }

  // 屏幕外指示：告诉玩家"敌人在哪个方向、多远"
  function collectEdges() {
    const cam = G.camera, w = window.innerWidth, h = window.innerHeight;
    if (!cam || !G.player) return [];
    const out = [];
    const rightX = Math.cos(G.player.yaw), rightZ = -Math.sin(G.player.yaw);
    const fwdX = -Math.sin(G.player.yaw), fwdZ = -Math.cos(G.player.yaw);
    for (const e of G.enemies) {
      if (!e.alive || e.state === 'dying') continue;
      const dx = e.pos.x - G.player.pos.x, dz = e.pos.z - G.player.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 5 || dist > 50) continue;
      const p = PG.util.project(new THREE.Vector3(e.pos.x, e.pos.y + e.height * 0.5, e.pos.z), cam, w, h);
      if (p && p.x > 40 && p.x < w - 40 && p.y > 40 && p.y < h - 40) continue;
      const th = Math.atan2(dx * rightX + dz * rightZ, dx * fwdX + dz * fwdZ);
      out.push({ angle: th, dist, kind: e.kind, alert: e.alert > 0 });
    }
    out.sort((a, b) => a.dist - b.dist);
    return out.slice(0, 6);
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
      dashCd: pl.dashCd, dashMax: 1.0,
      ultCd: pl.ultCd, ultMax: pl.ultMax,
      boss: G.state.boss ? { name: G.state.boss.name, hp: Math.max(0, G.state.boss.hp), hpMax: G.state.boss.hpMax } : null,
      charge: G.char.id === 't_bolt' ? pl.charge / 5 : (G.char.id === 't_tide' ? pl.tideCount / 5 : 0),
      time: G.state.time,
      diff: { id: G.diff.id, cn: G.diff.cn, color: G.diff.color },
    });
    if (PG.ui.enemyBars) PG.ui.enemyBars(collectBars());
    if (PG.ui.edgeMarkers) PG.ui.edgeMarkers(collectEdges());
  }

  // ============================ 生命周期 ============================
  function clearSession() {
    for (let i = G.projectiles.length - 1; i >= 0; i--) killProj(G.projectiles[i], i, G.projectiles);
    for (let i = G.eprojectiles.length - 1; i >= 0; i--) killProj(G.eprojectiles[i], i, G.eprojectiles);
    for (const e of G.enemies) {
      if (e.aura) { if (e.aura.parent) e.aura.parent.remove(e.aura); e.aura.material.dispose(); e.aura = null; }
      if (e.group.parent) e.group.parent.remove(e.group);
      if (PG.util && PG.util.disposeTree) PG.util.disposeTree(e.group);
    }
    for (const p of G.pending) {
      if (p.ring.parent) p.ring.parent.remove(p.ring);
      p.ring.material.dispose();
    }
    G.pending.length = 0;
    G.focus = null;
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
    updatePending(dt);
    updateWaves(dt);
    updateFocus(dt);
    updateFx(dt);
    applyCamera(dt);
    updateViewmodel(dt);
    pushHud(dt);
  }

  function setDifficulty(id) {
    if (!DIFFS[id]) id = DIFF_DEFAULT;
    G.diffId = id;
    G.diff = DIFFS[id];
    const pl = G.player;
    if (pl && G.char) {
      const ratio = pl.hpMax > 0 ? pl.hp / pl.hpMax : 1;
      pl.hpMax = Math.round(G.char.hp * G.diff.playerHp);
      pl.hp = clamp(ratio * pl.hpMax, 1, pl.hpMax);
    }
    return G.diff;
  }
  function setSensitivity(v) {
    const n = Number(v);
    G.sens = clamp(isFinite(n) && n > 0 ? n : 1, 0.4, 2);
    return G.sens;
  }
  function rankFor(score, win) {
    const mul = G.diff.scoreMul;
    if (!win) return score > 8000 * mul ? 'B' : score > 4000 * mul ? 'C' : 'D';
    return score > 16000 * mul ? 'S' : score > 11000 * mul ? 'A' : 'B';
  }

  function winGame() {
    if (G.state.mode === 'win' || G.state.mode === 'dead') return;
    G.state.mode = 'win';
    if (PG.audio) PG.audio.music('win');
    if (G.onEnd) G.onEnd('win');
  }

  PG.game = {
    CHARS, ENEMIES, WAVES, WAVE_TOTAL,
    DIFFS, DIFF_ORDER, DIFF_DEFAULT,
    init, start, pause, resume, stop, update, winGame,
    setDifficulty, setSensitivity, rankFor,
    // 调试/QA 用（仅通过 URL 参数或控制台开启，不影响正常玩法）
    setGod(v) { G.god = !!v; },
    setDmgMul(v) { G.dmgMul = v || 1; },
    getDebug() {
      const pl = G.player;
      return {
        god: !!G.god, dmgMul: G.dmgMul || 1, diff: G.diffId, wave: G.state.wave, enemies: aliveCount(),
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
    get difficulty() { return G.diff; },
    get difficultyId() { return G.diffId; },
    get sensitivity() { return G.sens; },
    get focusEnemy() { return G.focus; },
    set onEnd(fn) { G.onEnd = fn; },
  };
  PG.enemyCN = CN;
})();

/* ==================== 80-hud.js ==================== */
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
    D.el.diff = $('div', 'hud-diff', top);

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

    // ---- 敌人头顶血条 / 屏外方向指示 ----
    D.el.ebars = $('div', 'hud-ebars', hud);
    D.el.edges = $('div', 'hud-edges', hud);

    // ---- 中央：准星 / 锁定角标 / 命中 / 受击弧 ----
    const cross = $('div', 'hud-cross', hud);
    D.el.cross = cross;
    ['t', 'r', 'b', 'l'].forEach((k) => { D.el['cross' + k] = $('i', 'hud-cross-' + k, cross); });
    D.el.crossDot = $('i', 'hud-cross-dot', cross);
    const lockEl = $('div', 'hud-lock', cross);
    D.el.lock = lockEl;
    ['tl', 'tr', 'bl', 'br'].forEach((k) => { $('i', 'hud-lock-' + k, lockEl); });
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
    // 难度徽标
    if (s.diff && L.diffId !== s.diff.id) {
      L.diffId = s.diff.id;
      D.el.diff.textContent = s.diff.cn;
      D.el.diff.style.setProperty('--dc', s.diff.color || '#e8b33a');
      D.el.diff.classList.add('on');
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

  ui.setCrosshair = function (mode, spread, lock) {
    ensureDom();
    if (!D.ready) return;
    const el = D.el.cross;
    el.classList.toggle('off', mode === 0);
    const on = !!(lock && lock.on);
    el.classList.toggle('lock', on);
    el.classList.toggle('alert', !!(on && lock.alert));
    const s = 5 + (spread || 0) * 12;
    D.el.crosst.style.transform = 'translate(-50%,-50%) translateY(' + (-s) + 'px)';
    D.el.crossb.style.transform = 'translate(-50%,-50%) translateY(' + s + 'px)';
    D.el.crossl.style.transform = 'translate(-50%,-50%) translateX(' + (-s) + 'px)';
    D.el.crossr.style.transform = 'translate(-50%,-50%) translateX(' + s + 'px)';
  };

  const barPool = [];
  function ensureBarPool() {
    while (barPool.length < 8) {
      const el = $('div', 'hud-ebar', D.el.ebars);
      const fill = $('i', 'hud-ebar-fill', el);
      barPool.push({ el, fill, on: false });
    }
  }
  ui.enemyBars = function (list) {
    ensureDom();
    if (!D.ready || !D.el.ebars) return;
    ensureBarPool();
    list = list || [];
    for (let i = 0; i < barPool.length; i++) {
      const b = barPool[i];
      const it = list[i];
      if (!it) {
        if (b.on) { b.el.className = 'hud-ebar'; b.on = false; }
        continue;
      }
      if (!b.on) { b.el.className = 'hud-ebar on'; b.on = true; }
      b.el.classList.toggle('focus', !!it.focus);
      b.el.classList.toggle('alert', !!it.alert);
      b.el.classList.toggle('elite', it.kind === 'elite');
      b.el.classList.toggle('boss', it.kind === 'boss');
      b.el.style.transform = 'translate(-50%,-50%) translate(' + Math.round(it.x) + 'px,' + Math.round(it.y) + 'px)';
      b.fill.style.transform = 'scaleX(' + clamp(it.ratio, 0, 1).toFixed(3) + ')';
    }
  };

  const edgePool = [];
  function ensureEdgePool() {
    while (edgePool.length < 6) {
      const el = $('div', 'hud-edge', D.el.edges);
      const arrow = $('i', 'hud-edge-arrow', el);
      const dist = $('span', 'hud-edge-d', el);
      edgePool.push({ el, arrow, dist, on: false });
    }
  }
  ui.edgeMarkers = function (list) {
    ensureDom();
    if (!D.ready || !D.el.edges) return;
    ensureEdgePool();
    list = list || [];
    const w = window.innerWidth, h = window.innerHeight;
    const cx = w / 2, cy = h / 2;
    const rx = Math.min(w * 0.41, 520), ry = Math.min(h * 0.36, 285);
    for (let i = 0; i < edgePool.length; i++) {
      const m = edgePool[i];
      const it = list[i];
      if (!it) {
        if (m.on) { m.el.className = 'hud-edge'; m.on = false; }
        continue;
      }
      if (!m.on) { m.el.className = 'hud-edge on'; m.on = true; }
      const x = cx + Math.sin(it.angle) * rx;
      const y = cy - Math.cos(it.angle) * ry;
      m.el.style.transform = 'translate(-50%,-50%) translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
      m.arrow.style.transform = 'rotate(' + Math.round(it.angle * 180 / Math.PI) + 'deg)';
      m.dist.textContent = Math.max(1, Math.round(it.dist)) + 'm';
      m.el.classList.toggle('alert', !!it.alert);
      m.el.classList.toggle('boss', it.kind === 'boss');
      m.el.classList.toggle('elite', it.kind === 'elite');
    }
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

/* ==================== 85-ui.js ==================== */
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
    mk('div', 'title-hint', foot, '按 Enter 或点击按钮开始 · 建议全屏游玩');
    buildSettings(foot).classList.add('title-settings');
    mk('div', 'title-ver', s, 'v1.0 · 目录版');
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

/* ==================== 90-main.js ==================== */
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
    PG.audio && PG.audio.music('title');
  }

  function toSelect() {
    E.mode = 'select';
    PG.audio && PG.audio.sfx('ui_click');
  }

  function startGame(charId) {
    E.char = charId || E.char;
    E.mode = 'playing';
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

  function reportErr(err) {
    const msg = (err && (err.stack || err.message)) || String(err);
    E.err.push(msg);
    const f = document.getElementById('fatal');
    if (f) { f.textContent = '运行错误：\n' + E.err.slice(-3).join('\n\n'); f.style.display = 'block'; }
    if (window.console) console.error(err);
  }

  // ---------------- 启动 ----------------
  function boot2() {
    window.addEventListener('error', (e) => reportErr(e.error || new Error(e.message)));
    window.addEventListener('unhandledrejection', (e) => reportErr(e.reason));
    try {
      initEngine();
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
