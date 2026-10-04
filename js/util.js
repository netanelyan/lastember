'use strict';
// Small math, randomness and storage helpers shared by every other file.

const TAU = Math.PI * 2;
const DIRS8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const invLerp = (a, b, v) => clamp((v - a) / (b - a), 0, 1);
const dist2 = (ax, ay, bx, by) => { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; };
const dist = (ax, ay, bx, by) => Math.sqrt(dist2(ax, ay, bx, by));
const rand = (a, b) => a + Math.random() * (b - a);
const randi = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const chance = p => Math.random() < p;

function angleDiff(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  else if (d < -Math.PI) d += TAU;
  return d;
}
function approachAngle(a, b, maxStep) {
  return a + clamp(angleDiff(a, b), -maxStep, maxStep);
}
// Frame-rate independent exponential smoothing factor.
const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

// mulberry32 seeded generator
function makeRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic 0..1 value for an integer lattice point.
function hash2(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function makeNoise(seed) {
  return function (x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
    const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
    return lerp(lerp(a, b, u), lerp(c, d, u), v);
  };
}
function fbm(noise, x, y, oct = 4) {
  let f = 1, amp = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += noise(x * f, y * f) * amp;
    norm += amp;
    f *= 2; amp *= 0.5;
  }
  return sum / norm;
}

const ease = {
  outCubic: t => 1 - Math.pow(1 - t, 3),
  outBack: t => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
  inOutSine: t => -(Math.cos(Math.PI * t) - 1) / 2,
};

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
// Lighten (amt > 0) or darken (amt < 0) a hex colour.
function shade(hex, amt) {
  const [r, g, b] = hexToRgb(hex);
  const f = amt < 0 ? 0 : 255, t = Math.abs(amt);
  return `rgb(${Math.round(lerp(r, f, t))},${Math.round(lerp(g, f, t))},${Math.round(lerp(b, f, t))})`;
}
function rgba(hex, a) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

// Binary min-heap of integer ids keyed by float priority (used by the predator path field).
class MinHeap {
  constructor() { this.ids = []; this.pri = []; this.lastPri = 0; }
  get size() { return this.ids.length; }
  clear() { this.ids.length = 0; this.pri.length = 0; }
  push(id, p) {
    const a = this.ids, b = this.pri;
    let n = a.length;
    a.push(id); b.push(p);
    while (n > 0) {
      const parent = (n - 1) >> 1;
      if (b[parent] <= p) break;
      a[n] = a[parent]; b[n] = b[parent];
      n = parent;
    }
    a[n] = id; b[n] = p;
  }
  pop() {
    const a = this.ids, b = this.pri;
    const top = a[0];
    this.lastPri = b[0];
    const lastId = a.pop(), lastP = b.pop();
    const len = a.length;
    if (len > 0) {
      let n = 0;
      for (;;) {
        const l = 2 * n + 1;
        if (l >= len) break;
        const r = l + 1;
        const m = r < len && b[r] < b[l] ? r : l;
        if (b[m] >= lastP) break;
        a[n] = a[m]; b[n] = b[m];
        n = m;
      }
      a[n] = lastId; b[n] = lastP;
    }
    return top;
  }
}

function fmtClock(minutes) {
  const m = ((Math.floor(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60), mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
function fmtDuration(sec) {
  sec = Math.max(0, Math.ceil(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

// localStorage can be missing or throw (private windows, sandboxed previews), so every access is guarded.
const Store = {
  prefix: 'lastember.',
  get(key, fallback = null) {
    try {
      const raw = window.localStorage.getItem(this.prefix + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  },
  set(key, value) {
    try { window.localStorage.setItem(this.prefix + key, JSON.stringify(value)); return true; } catch (e) { return false; }
  },
  del(key) {
    try { window.localStorage.removeItem(this.prefix + key); } catch (e) { /* ignore */ }
  },
};
