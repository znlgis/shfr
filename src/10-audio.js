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
