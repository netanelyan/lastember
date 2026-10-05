'use strict';
// All sound is synthesised with WebAudio, so the game ships with no audio files.

const Sfx = {
  ctx: null,
  bus: null,
  master: null,
  noiseBuf: null,
  muted: false,
  last: {},
  amb: null,

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try { this.ctx = new AC(); } catch (e) { this.ctx = null; return; }
    const c = this.ctx;
    this.master = c.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp);
    comp.connect(c.destination);
    this.bus = c.createGain();
    this.bus.gain.value = 0.9;
    this.bus.connect(this.master);

    const len = c.sampleRate * 2;
    this.noiseBuf = c.createBuffer(1, len, c.sampleRate);
    const data = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    this.startAmbient();
  },

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.05);
  },

  tone(o) {
    const c = this.ctx;
    const t = c.currentTime + (o.delay || 0);
    const osc = c.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f0, t);
    if (o.f1) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t + o.dur);
    const g = c.createGain();
    const vol = o.vol == null ? 0.2 : o.vol;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + (o.attack || 0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    let node = osc;
    if (o.lp) {
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = o.lp;
      osc.connect(f);
      node = f;
    }
    node.connect(g);
    g.connect(this.bus);
    osc.start(t);
    osc.stop(t + o.dur + 0.05);
  },

  noise(o) {
    const c = this.ctx;
    const t = c.currentTime + (o.delay || 0);
    const src = c.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = c.createBiquadFilter();
    f.type = o.ft || 'bandpass';
    f.frequency.setValueAtTime(o.f0, t);
    if (o.f1) f.frequency.exponentialRampToValueAtTime(o.f1, t + o.dur);
    f.Q.value = o.q || 1;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(o.vol || 0.2, t + (o.attack || 0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    src.connect(f);
    f.connect(g);
    g.connect(this.bus);
    src.start(t, Math.random() * 1.5);
    src.stop(t + o.dur + 0.05);
  },

  howl(vol = 0.09, pitch = 1, delay = 0) {
    const c = this.ctx;
    const t = c.currentTime + delay;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.35);
    g.gain.setValueAtTime(vol, t + 1.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.1);
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 1500;
    f.connect(g);
    g.connect(this.bus);
    const lfo = c.createOscillator();
    lfo.frequency.value = 5.5;
    const lfoGain = c.createGain();
    lfoGain.gain.value = 7 * pitch;
    lfo.connect(lfoGain);
    [1, 1.004].forEach(det => {
      const o = c.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(300 * pitch * det, t);
      o.frequency.exponentialRampToValueAtTime(560 * pitch * det, t + 0.5);
      o.frequency.setValueAtTime(560 * pitch * det, t + 1.1);
      o.frequency.exponentialRampToValueAtTime(410 * pitch * det, t + 2.0);
      lfoGain.connect(o.frequency);
      o.connect(f);
      o.start(t);
      o.stop(t + 2.2);
    });
    lfo.start(t);
    lfo.stop(t + 2.2);
  },

  // name -> synth recipe. Throttled per name so swarms do not clip.
  play(name, opt = {}) {
    if (!this.ctx || this.muted) return;
    const now = this.ctx.currentTime;
    const gap = opt.gap == null ? 0.03 : opt.gap;
    if (this.last[name] && now - this.last[name] < gap) return;
    this.last[name] = now;
    const v = opt.vol == null ? 1 : opt.vol;
    const p = opt.pitch || 1;
    switch (name) {
      case 'swing': this.noise({ f0: 1400 * p, f1: 380, dur: 0.13, vol: 0.12 * v, q: 1.2 }); break;
      case 'chop':
        this.tone({ type: 'triangle', f0: 190 * p, f1: 110, dur: 0.09, vol: 0.32 * v });
        this.noise({ f0: 2200, dur: 0.05, vol: 0.18 * v, ft: 'highpass' });
        break;
      case 'stone':
        this.tone({ type: 'square', f0: 1100 * p, f1: 700, dur: 0.05, vol: 0.06 * v });
        this.noise({ f0: 3500, dur: 0.07, vol: 0.2 * v, ft: 'highpass' });
        break;
      case 'rustle': this.noise({ f0: 900 * p, f1: 1800, dur: 0.18, vol: 0.12 * v, q: 0.7 }); break;
      case 'fell':
        this.noise({ f0: 600, f1: 120, dur: 0.6, vol: 0.25 * v, ft: 'lowpass' });
        this.tone({ type: 'sine', f0: 90, f1: 45, dur: 0.4, vol: 0.3 * v, delay: 0.12 });
        break;
      case 'crumble': this.noise({ f0: 1800, f1: 300, dur: 0.35, vol: 0.25 * v, ft: 'lowpass' }); break;
      case 'hit':
        this.tone({ type: 'sine', f0: 160 * p, f1: 60, dur: 0.12, vol: 0.32 * v });
        this.noise({ f0: 900, dur: 0.06, vol: 0.14 * v });
        break;
      case 'kill':
        this.tone({ type: 'triangle', f0: 320 * p, f1: 80, dur: 0.25, vol: 0.2 * v });
        this.noise({ f0: 500, f1: 150, dur: 0.25, vol: 0.15 * v, ft: 'lowpass' });
        break;
      case 'hurt':
        this.tone({ type: 'sawtooth', f0: 230, f1: 90, dur: 0.22, vol: 0.18 * v, lp: 900 });
        this.noise({ f0: 400, dur: 0.12, vol: 0.18 * v, ft: 'lowpass' });
        break;
      case 'pickup': this.tone({ type: 'sine', f0: 620 * p, f1: 980 * p, dur: 0.07, vol: 0.07 * v }); break;
      case 'craft':
        this.tone({ type: 'triangle', f0: 523, dur: 0.12, vol: 0.14 * v });
        this.tone({ type: 'triangle', f0: 784, dur: 0.2, vol: 0.14 * v, delay: 0.08 });
        break;
      case 'build':
        this.tone({ type: 'sine', f0: 110, f1: 70, dur: 0.16, vol: 0.35 * v });
        this.noise({ f0: 1200, dur: 0.07, vol: 0.12 * v });
        break;
      case 'demolish': this.noise({ f0: 1400, f1: 200, dur: 0.3, vol: 0.2 * v, ft: 'lowpass' }); break;
      case 'shoot':
        this.tone({ type: 'triangle', f0: 420, f1: 180, dur: 0.12, vol: 0.16 * v });
        this.noise({ f0: 2500, f1: 900, dur: 0.1, vol: 0.08 * v });
        break;
      case 'thunk': this.tone({ type: 'square', f0: 260, f1: 140, dur: 0.05, vol: 0.06 * v }); break;
      case 'splash': this.noise({ f0: 1200, f1: 400, dur: 0.25, vol: 0.12 * v }); break;
      case 'eat':
        for (let i = 0; i < 3; i++) this.noise({ f0: 1500 + i * 300, dur: 0.05, vol: 0.12 * v, delay: i * 0.08, ft: 'highpass' });
        break;
      case 'heal':
        this.tone({ type: 'sine', f0: 440, f1: 660, dur: 0.25, vol: 0.1 * v });
        this.tone({ type: 'sine', f0: 660, f1: 880, dur: 0.3, vol: 0.08 * v, delay: 0.1 });
        break;
      case 'fuel': this.noise({ f0: 300, f1: 1400, dur: 0.3, vol: 0.14 * v, ft: 'lowpass', attack: 0.05 }); break;
      case 'sizzle': this.noise({ f0: 5000, dur: 0.4, vol: 0.06 * v, ft: 'highpass', attack: 0.05 }); break;
      case 'dodge': this.noise({ f0: 700, f1: 2400, dur: 0.15, vol: 0.09 * v }); break;
      case 'growl': this.tone({ type: 'sawtooth', f0: 75 * p, f1: 55, dur: 0.7, vol: 0.16 * v, lp: 380, attack: 0.08 }); break;
      case 'snarl': this.tone({ type: 'sawtooth', f0: 150 * p, f1: 110, dur: 0.22, vol: 0.08 * v, lp: 700 }); break;
      case 'squeal': this.tone({ type: 'square', f0: 900 * p, f1: 600, dur: 0.15, vol: 0.06 * v, lp: 2000 }); break;
      case 'howl': this.howl(0.07 * v, p, opt.delay || 0); break;
      case 'ui': this.tone({ type: 'sine', f0: 880, dur: 0.04, vol: 0.05 * v }); break;
      case 'deny': this.tone({ type: 'square', f0: 160, f1: 130, dur: 0.1, vol: 0.06 * v, lp: 900 }); break;
      case 'night':
        this.tone({ type: 'sine', f0: 110, dur: 2.4, vol: 0.12 * v, attack: 0.6 });
        this.tone({ type: 'sine', f0: 164.8, dur: 2.4, vol: 0.08 * v, attack: 0.8 });
        this.howl(0.07, 1, 0.9);
        break;
      case 'dawn':
        [392, 494, 587, 784].forEach((f, i) => this.tone({ type: 'triangle', f0: f, dur: 1.4, vol: 0.06 * v, delay: i * 0.12, attack: 0.05 }));
        break;
      case 'perk':
        [523, 659, 784, 1046].forEach((f, i) => this.tone({ type: 'triangle', f0: f, dur: 0.4, vol: 0.08 * v, delay: i * 0.06 }));
        break;
      case 'revive':
        [262, 330, 392].forEach((f, i) => this.tone({ type: 'sine', f0: f, dur: 1.2, vol: 0.1 * v, delay: i * 0.1, attack: 0.1 }));
        break;
      case 'over':
        [392, 330, 262, 196].forEach((f, i) => this.tone({ type: 'triangle', f0: f, dur: 0.6, vol: 0.12 * v, delay: i * 0.22 }));
        break;
      case 'trap': this.tone({ type: 'triangle', f0: 700, f1: 300, dur: 0.12, vol: 0.12 * v }); break;
      case 'cast': this.noise({ f0: 2600, f1: 500, dur: 0.24, vol: 0.08 * v, q: 0.9 }); break;
      case 'plip': this.tone({ type: 'sine', f0: 940 * p, f1: 520, dur: 0.07, vol: 0.07 * v }); break;
      case 'bite':
        this.tone({ type: 'triangle', f0: 560, f1: 170, dur: 0.16, vol: 0.18 * v });
        this.noise({ f0: 1300, f1: 450, dur: 0.18, vol: 0.12 * v, delay: 0.03 });
        break;
      case 'catch':
        [660, 880, 1175].forEach((f, i) => this.tone({ type: 'triangle', f0: f, dur: 0.16, vol: 0.08 * v, delay: i * 0.07 }));
        break;
      default: break;
    }
  },

  startAmbient() {
    const c = this.ctx;
    const mk = (type, freq, q) => {
      const src = c.createBufferSource();
      src.buffer = this.noiseBuf;
      src.loop = true;
      const f = c.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = c.createGain();
      g.gain.value = 0;
      src.connect(f); f.connect(g); g.connect(this.master);
      src.start();
      return { src, f, g };
    };
    this.amb = { wind: mk('lowpass', 420, 0.6), fire: mk('bandpass', 1800, 0.5), t: 0, crickT: 2, birdT: 3 };
  },

  // Called every frame with how dark it is and how close the nearest fire is.
  updateAmbient(dt, info) {
    if (!this.amb || !this.ctx) return;
    const a = this.amb, t = this.ctx.currentTime;
    a.t += dt;
    const windVol = 0.035 + info.night * 0.05 + info.snow * 0.04 + Math.sin(a.t * 0.23) * 0.015;
    a.wind.g.gain.setTargetAtTime(windVol, t, 0.5);
    a.wind.f.frequency.setTargetAtTime(330 + Math.sin(a.t * 0.17) * 120 + info.snow * 200, t, 0.5);
    a.fire.g.gain.setTargetAtTime(info.fire * 0.05, t, 0.2);
    if (this.muted) return;
    if (info.fire > 0.05 && Math.random() < dt * 9 * info.fire) {
      this.noise({ f0: 2500 + Math.random() * 3000, dur: 0.03, vol: 0.05 * info.fire, ft: 'highpass' });
    }
    if (info.night > 0.6 && !info.snow) {
      a.crickT -= dt;
      if (a.crickT <= 0) {
        a.crickT = rand(0.6, 2.4);
        const f = rand(4000, 4600);
        for (let i = 0; i < 3; i++) this.tone({ type: 'sine', f0: f, dur: 0.03, vol: 0.012, delay: i * 0.06 });
      }
    } else if (info.night < 0.2) {
      a.birdT -= dt;
      if (a.birdT <= 0) {
        a.birdT = rand(3, 9);
        const f = rand(1800, 2600);
        const n = randi(2, 4);
        for (let i = 0; i < n; i++) this.tone({ type: 'sine', f0: f, f1: f * 1.4, dur: 0.08, vol: 0.018, delay: i * 0.13 });
      }
    }
  },
};
