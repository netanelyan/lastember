'use strict';
// Everything visual is painted in code. Static sprites are painted once at the art resolution and turned
// into pixel art (pixel.js); animated things (creatures, the player, fire) are drawn every frame by render.js.

const PAL = {
  oak:    ['#2b5226', '#3a6a2f', '#4f893c', '#6ea84f'],
  birch:  ['#56782a', '#6c9334', '#88b049', '#abd06b'],
  autumn: ['#7e3a1a', '#a95522', '#cf812f', '#efb24c'],
  pine:   ['#1c412e', '#235238', '#2d6543', '#3c7b51'],
  skin: '#e2b38a',
  jacket: '#2f6d8a',
  pack: '#6b4f33',
  hat: '#7a5532',
  wood: '#9a6a3c',
  woodDark: '#6e4726',
  woodLight: '#c08a52',
  stone: '#8a8f93',
  stoneLight: '#aeb3b6',
  stoneDark: '#5f6468',
  fiber: '#8fb85a',
  rope: '#d9c08a',
};

function circle(g, x, y, r) { g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill(); }
function ellipse(g, x, y, rx, ry, rot = 0) { g.beginPath(); g.ellipse(x, y, rx, ry, rot, 0, TAU); g.fill(); }
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  if (g.roundRect) g.roundRect(x, y, w, h, r);
  else {
    g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
    g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
    g.closePath();
  }
}
function polyPath(g, pts, sx = 1, ox = 0, oy = 0) {
  g.beginPath();
  pts.forEach((p, i) => { const x = ox + p[0] * sx, y = oy + p[1] * sx; if (i) g.lineTo(x, y); else g.moveTo(x, y); });
  g.closePath();
}

const Paint = {
  pine(g, R, seed) {
    const rng = makeRng(seed);
    const cols = PAL.pine;
    for (let L = 0; L < 4; L++) {
      const r = R * (1 - L * 0.21);
      const off = -L * R * 0.045;
      const pts = 11 - L;
      g.beginPath();
      for (let i = 0; i < pts * 2; i++) {
        const a = (i / (pts * 2)) * TAU + L * 0.37;
        const rr = i % 2 === 0 ? r * (0.94 + rng() * 0.08) : r * (0.66 + rng() * 0.08);
        const x = off + Math.cos(a) * rr, y = off + Math.sin(a) * rr;
        if (i) g.lineTo(x, y); else g.moveTo(x, y);
      }
      g.closePath();
      g.fillStyle = cols[L];
      g.fill();
      g.strokeStyle = 'rgba(8,26,16,0.28)';
      g.lineWidth = 1;
      g.stroke();
    }
    g.fillStyle = '#5c9a68';
    circle(g, -R * 0.17, -R * 0.17, R * 0.09);
  },

  broadleaf(g, R, seed, pal) {
    const rng = makeRng(seed);
    const [dark, mid, light, hi] = pal;
    g.fillStyle = dark;
    const n = 7;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + rng() * 0.5;
      circle(g, Math.cos(a) * R * 0.5, Math.sin(a) * R * 0.5, R * (0.47 + rng() * 0.08));
    }
    circle(g, 0, 0, R * 0.62);
    g.fillStyle = mid;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU + rng();
      circle(g, -R * 0.08 + Math.cos(a) * R * 0.36, -R * 0.1 + Math.sin(a) * R * 0.36, R * (0.33 + rng() * 0.08));
    }
    g.fillStyle = light;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + rng();
      circle(g, -R * 0.2 + Math.cos(a) * R * 0.2, -R * 0.24 + Math.sin(a) * R * 0.18, R * (0.2 + rng() * 0.06));
    }
    g.fillStyle = hi;
    for (let i = 0; i < 12; i++) {
      const a = rng() * TAU, d = rng() * R * 0.55;
      circle(g, -R * 0.2 + Math.cos(a) * d, -R * 0.2 + Math.sin(a) * d, 1.4 + rng() * 2);
    }
    g.fillStyle = 'rgba(0,20,0,0.18)';
    for (let i = 0; i < 10; i++) {
      const a = rng() * TAU, d = R * (0.45 + rng() * 0.4);
      circle(g, Math.cos(a) * d * 0.9 + R * 0.12, Math.sin(a) * d * 0.9 + R * 0.12, 2 + rng() * 2.5);
    }
  },

  rock(g, R, seed, mossy) {
    const rng = makeRng(seed);
    const pts = [];
    const n = 9;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + rng() * 0.35;
      const r = R * (0.8 + rng() * 0.22);
      pts.push([Math.cos(a) * r, Math.sin(a) * r * 0.88]);
    }
    polyPath(g, pts);
    g.fillStyle = PAL.stone;
    g.fill();
    g.save();
    polyPath(g, pts);
    g.clip();
    polyPath(g, pts, 0.74, -R * 0.12, -R * 0.15);
    g.fillStyle = '#9da2a5';
    g.fill();
    polyPath(g, pts, 0.42, -R * 0.24, -R * 0.27);
    g.fillStyle = PAL.stoneLight;
    g.fill();
    g.strokeStyle = 'rgba(40,44,50,0.5)';
    g.lineWidth = 1.2;
    for (let i = 0; i < 2; i++) {
      const a = rng() * TAU;
      g.beginPath();
      g.moveTo(Math.cos(a) * R * 0.15, Math.sin(a) * R * 0.15);
      g.lineTo(Math.cos(a + 0.4) * R * 0.5, Math.sin(a + 0.4) * R * 0.45);
      g.lineTo(Math.cos(a + 0.2) * R * 0.75, Math.sin(a + 0.2) * R * 0.7);
      g.stroke();
    }
    if (mossy) {
      g.fillStyle = 'rgba(96,140,64,0.75)';
      for (let i = 0; i < 6; i++) circle(g, -R * 0.3 + rng() * R * 0.5, -R * 0.35 + rng() * R * 0.4, 2 + rng() * 3.5);
    }
    g.restore();
    polyPath(g, pts);
    g.strokeStyle = 'rgba(35,38,44,0.55)';
    g.lineWidth = 1.5;
    g.stroke();
  },

  bush(g, R, seed, ripe) {
    const rng = makeRng(seed);
    g.fillStyle = '#2d5629';
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU + rng() * 0.6;
      circle(g, Math.cos(a) * R * 0.45, Math.sin(a) * R * 0.45, R * (0.48 + rng() * 0.1));
    }
    g.fillStyle = '#3d7135';
    for (let i = 0; i < 5; i++) {
      const a = rng() * TAU;
      circle(g, -R * 0.12 + Math.cos(a) * R * 0.3, -R * 0.12 + Math.sin(a) * R * 0.3, R * (0.3 + rng() * 0.1));
    }
    g.fillStyle = '#5b9446';
    for (let i = 0; i < 8; i++) circle(g, -R * 0.25 + rng() * R * 0.5, -R * 0.3 + rng() * R * 0.45, 1.5 + rng() * 2);
    if (ripe) {
      for (let i = 0; i < 9; i++) {
        const a = rng() * TAU, d = R * (0.2 + rng() * 0.6);
        const x = Math.cos(a) * d, y = Math.sin(a) * d;
        g.fillStyle = '#7d1a2c';
        circle(g, x + 0.6, y + 0.6, 3);
        g.fillStyle = '#d23a52';
        circle(g, x, y, 2.8);
        g.fillStyle = 'rgba(255,190,200,0.9)';
        circle(g, x - 0.9, y - 0.9, 0.9);
      }
    }
  },

  grass(g, R, seed, cut) {
    const rng = makeRng(seed);
    const cols = ['#6f9d45', '#88b552', '#9cc560', '#5f8a3b'];
    const n = cut ? 9 : 13;
    for (let i = 0; i < n; i++) {
      const a = rng() * TAU;
      const bx = Math.cos(a) * R * 0.25 * rng(), by = Math.sin(a) * R * 0.25 * rng();
      const len = cut ? R * (0.15 + rng() * 0.12) : R * (0.55 + rng() * 0.45);
      const ex = bx + Math.cos(a) * len, ey = by + Math.sin(a) * len;
      g.strokeStyle = cut ? '#8a9a52' : cols[Math.floor(rng() * cols.length)];
      g.lineWidth = cut ? 2 : 2.4;
      g.beginPath();
      g.moveTo(bx, by);
      g.quadraticCurveTo(bx + Math.cos(a + 0.6) * len * 0.5, by + Math.sin(a + 0.6) * len * 0.5, ex, ey);
      g.stroke();
      if (!cut && rng() < 0.3) { g.fillStyle = '#e4d98a'; circle(g, ex, ey, 1.6); }
    }
  },

  stump(g) {
    g.fillStyle = '#5a3b22';
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + 0.4;
      ellipse(g, Math.cos(a) * 10, Math.sin(a) * 10, 5, 3, a);
    }
    g.fillStyle = '#7a5332';
    circle(g, 0, 0, 11);
    g.fillStyle = '#b58a5a';
    circle(g, -0.5, -0.5, 8.5);
    g.strokeStyle = 'rgba(110,70,38,0.7)';
    g.lineWidth = 1;
    for (const r of [6, 3.5]) { g.beginPath(); g.arc(-0.5, -0.5, r, 0, TAU); g.stroke(); }
  },
};

const TREE_SIZES = { pine: [34, 38, 42], oak: [34, 38, 42], birch: [28, 31, 34], autumn: [34, 37, 40] };

const Sprites = {
  k: 0.5,             // art pixels per world pixel, set by Render
  cache: new Map(),
  iconURL: {},        // id -> data URL of a 24x24 pixel icon (HUD)
  iconSmallURL: {},   // id -> data URL of a 12x12 pixel icon (cost lists)

  init() { this.makeIcons(); },

  setScale(k) {
    if (k === this.k) return;
    this.k = k;
    this.cache.clear();
  },

  // A static sprite painted in world units at the art resolution, turned into pixel art once and cached.
  get(id, size, paint, opts) {
    let spr = this.cache.get(id);
    if (spr) return spr;
    const n = Math.ceil(size * this.k) + 2;
    const c = document.createElement('canvas');
    c.width = c.height = n;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.translate(n / 2, n / 2);
    g.scale(this.k, this.k);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    paint(g);
    Pixelize.process(c, opts);
    spr = { c, w: n, h: n };
    this.cache.set(id, spr);
    return spr;
  },

  // `s` picks one of a few seeded variants so neighbours don't look alike.
  tree(sp, v, s) {
    const R = TREE_SIZES[sp][v];
    return this.get(`tree ${sp} ${v} ${s}`, (R + 4) * 2, g => {
      if (sp === 'pine') Paint.pine(g, R, 101 + v * 17 + s * 1009);
      else Paint.broadleaf(g, R, 211 + v * 31 + sp.length + s * 1013, PAL[sp]);
    });
  },
  rock(v, mossy, s, size) {
    const q = Math.round(size * 10) / 10;
    return this.get(`rock ${v} ${mossy} ${s} ${q}`, 50 * q, g => Paint.rock(g, 20 * q, 300 + v * 7 + s * 1019, mossy));
  },
  bush(v, ripe, s) { return this.get(`bush ${v} ${ripe} ${s}`, 40, g => Paint.bush(g, 16, 400 + v * 13 + s * 1021, ripe)); },
  grass(v, cut, s) { return this.get(`grass ${v} ${cut} ${s}`, 40, g => Paint.grass(g, 16, 500 + v * 11 + s * 1031, cut), { shade: false, colors: 5 }); },
  stump(s) { return this.get(`stump ${s}`, 34, g => { g.rotate(s * 2.1); Paint.stump(g); }); },
  worldIcon(id) { return this.get(`icon ${id}`, 22, g => { g.scale(22 / 56, 22 / 56); Icon.draw(g, id); }, { colors: 8 }); },

  makeIcons() {
    const ids = [...INV_ORDER, ...GEAR_ORDER, ...BUILD_ORDER, 'heart', 'food', 'warmth', 'stamina', 'swing', 'dodge', 'use', 'craft', 'build', 'demolish', 'pause', 'sound', 'muted', 'crate'];
    for (const id of ids) {
      this.iconURL[id] = this.iconImage(id, 24);
      this.iconSmallURL[id] = this.iconImage(id, 12);
    }
  },

  iconImage(id, n) {
    const c = document.createElement('canvas');
    c.width = c.height = n;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.translate(n / 2, n / 2);
    g.scale((n - 2) / 56, (n - 2) / 56);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    Icon.draw(g, id);
    Pixelize.process(c, { outline: true, colors: n > 16 ? 8 : 6 });
    try { return c.toDataURL('image/png'); } catch (e) { return ''; }
  },
};

// Item / gear / UI icons. Drawn into a 56x56 box centred on the origin.
const Icon = {
  draw(g, id) {
    if (STRUCTS[id]) { this.structure(g, id); return; }
    const f = this[id];
    if (f) f.call(this, g);
  },

  log(g, x, y, len, r, rot) {
    g.save();
    g.translate(x, y);
    g.rotate(rot);
    g.fillStyle = '#7a4f2b';
    roundRect(g, -len / 2, -r, len, r * 2, r);
    g.fill();
    g.fillStyle = '#9a6a3c';
    roundRect(g, -len / 2, -r, len, r * 1.1, r * 0.8);
    g.fill();
    g.strokeStyle = 'rgba(60,35,15,0.5)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(-len / 2 + 6, -r * 0.2); g.lineTo(len / 2 - 8, -r * 0.3); g.stroke();
    g.fillStyle = '#d7a86e';
    ellipse(g, -len / 2 + 1, 0, r * 0.55, r);
    g.strokeStyle = '#a5743f';
    g.beginPath(); g.ellipse(-len / 2 + 1, 0, r * 0.3, r * 0.55, 0, 0, TAU); g.stroke();
    g.restore();
  },
  wood(g) { this.log(g, 2, 7, 38, 7, -0.15); this.log(g, -1, -7, 36, 7, 0.1); },
  stone(g) { Paint.rock(g, 18, 77, false); },
  fiber(g) {
    const cols = ['#7fae4f', '#98c25e', '#6a9a42'];
    for (let i = 0; i < 9; i++) {
      g.strokeStyle = cols[i % 3];
      g.lineWidth = 2.6;
      g.beginPath();
      const s = (i - 4) * 2.2;
      g.moveTo(s * 0.4, 20);
      g.quadraticCurveTo(s * 0.5, 0, s * 1.6, -20);
      g.stroke();
    }
    g.fillStyle = '#c9a66a';
    roundRect(g, -8, 2, 16, 6, 2);
    g.fill();
  },
  hide(g) {
    g.fillStyle = '#8e6a44';
    g.beginPath();
    g.moveTo(-20, -14); g.quadraticCurveTo(-8, -10, 0, -18); g.quadraticCurveTo(8, -10, 20, -14);
    g.quadraticCurveTo(14, 0, 20, 14); g.quadraticCurveTo(8, 10, 0, 18); g.quadraticCurveTo(-8, 10, -20, 14);
    g.quadraticCurveTo(-14, 0, -20, -14);
    g.fill();
    g.fillStyle = '#c69a6a';
    g.save(); g.scale(0.8, 0.8); g.fill(); g.restore();
    g.strokeStyle = 'rgba(90,60,30,0.6)'; g.setLineDash([2, 3]); g.lineWidth = 1;
    g.beginPath(); g.ellipse(0, 0, 11, 9, 0, 0, TAU); g.stroke(); g.setLineDash([]);
  },
  pelt(g) {
    g.fillStyle = '#5f666f';
    ellipse(g, 0, 0, 21, 15);
    g.fillStyle = '#8c939c';
    ellipse(g, -1, -1, 17, 12);
    g.strokeStyle = '#b8bec5';
    g.lineWidth = 1.4;
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * TAU;
      g.beginPath();
      g.moveTo(Math.cos(a) * 9, Math.sin(a) * 6);
      g.lineTo(Math.cos(a) * 15, Math.sin(a) * 10.5);
      g.stroke();
    }
    g.fillStyle = '#3e434a';
    ellipse(g, 17, 0, 7, 3.5, 0.3);
  },
  fang(g) {
    g.fillStyle = '#c8bfa6';
    g.beginPath();
    g.moveTo(-10, -16); g.quadraticCurveTo(14, -12, 8, 20); g.quadraticCurveTo(2, -2, -14, -8); g.closePath();
    g.fill();
    g.fillStyle = '#f2ead6';
    g.beginPath();
    g.moveTo(-9, -15); g.quadraticCurveTo(10, -10, 7, 16); g.quadraticCurveTo(0, -3, -12, -9); g.closePath();
    g.fill();
  },
  arrow(g) {
    g.save();
    g.rotate(-0.75);
    g.strokeStyle = '#a77a45'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(-22, 0); g.lineTo(16, 0); g.stroke();
    g.fillStyle = '#7c8186';
    g.beginPath(); g.moveTo(24, 0); g.lineTo(14, -6); g.lineTo(16, 0); g.lineTo(14, 6); g.closePath(); g.fill();
    g.fillStyle = '#e8e2d2';
    g.beginPath(); g.moveTo(-14, 0); g.lineTo(-22, -7); g.lineTo(-25, -7); g.lineTo(-19, 0); g.closePath(); g.fill();
    g.beginPath(); g.moveTo(-14, 0); g.lineTo(-22, 7); g.lineTo(-25, 7); g.lineTo(-19, 0); g.closePath(); g.fill();
    g.restore();
  },
  berries(g) {
    g.fillStyle = '#3f7a35';
    ellipse(g, 6, -14, 9, 4.5, -0.5);
    const pts = [[-6, 2], [5, 4], [-1, -6], [-2, 13], [9, -5]];
    for (const [x, y] of pts) {
      g.fillStyle = '#7d1a2c'; circle(g, x + 1, y + 1, 7);
      g.fillStyle = '#d23a52'; circle(g, x, y, 6.5);
      g.fillStyle = 'rgba(255,200,210,0.9)'; circle(g, x - 2.2, y - 2.2, 1.8);
    }
  },
  drumstick(g, meat, edge) {
    g.save();
    g.rotate(-0.6);
    g.fillStyle = '#efe6d2';
    roundRect(g, 6, -3.5, 18, 7, 3.5); g.fill();
    circle(g, 24, -4, 4.2); circle(g, 24, 4, 4.2);
    g.fillStyle = edge;
    ellipse(g, -6, 0, 17, 13);
    g.fillStyle = meat;
    ellipse(g, -7, -1, 14.5, 10.5);
    g.restore();
  },
  meat(g) { this.drumstick(g, '#e0727a', '#b04450'); g.fillStyle = 'rgba(255,240,240,0.7)'; ellipse(g, -6, 0, 5, 2, -0.6); },
  steak(g) {
    this.drumstick(g, '#a8623a', '#6e3a1e');
    g.strokeStyle = 'rgba(50,25,10,0.7)'; g.lineWidth = 2.2;
    for (let i = -1; i <= 1; i++) { g.beginPath(); g.moveTo(-14 + i * 6, -8); g.lineTo(-4 + i * 6, 8); g.stroke(); }
  },
  fishShape(g, body, belly, fin) {
    g.fillStyle = fin;
    g.beginPath(); g.moveTo(-14, 0); g.lineTo(-25, -10); g.lineTo(-22, 0); g.lineTo(-25, 10); g.closePath(); g.fill();
    g.fillStyle = body;
    ellipse(g, 2, 0, 19, 10);
    g.fillStyle = belly;
    ellipse(g, 3, 3, 14, 5);
    g.fillStyle = '#1d2a33'; circle(g, 13, -2, 2);
  },
  fish(g) { this.fishShape(g, '#6f9fb5', '#c9dde6', '#4f7f95'); },
  grilled(g) {
    this.fishShape(g, '#b9763d', '#e3b47a', '#8a5226');
    g.strokeStyle = 'rgba(50,25,10,0.75)'; g.lineWidth = 2;
    for (let i = -1; i <= 1; i++) { g.beginPath(); g.moveTo(-6 + i * 7, -8); g.lineTo(-1 + i * 7, 8); g.stroke(); }
  },
  rod(g) {
    g.save(); g.rotate(-0.8);
    g.strokeStyle = '#6e4726'; g.lineWidth = 3.4;
    g.beginPath(); g.moveTo(-24, 0); g.lineTo(24, 0); g.stroke();
    g.strokeStyle = '#c9a66a'; g.lineWidth = 5.5;
    g.beginPath(); g.moveTo(-24, 0); g.lineTo(-11, 0); g.stroke();
    g.fillStyle = '#8c9196'; circle(g, -9, 6, 4.5);
    g.restore();
    g.strokeStyle = '#e8e2d2'; g.lineWidth = 1.6;
    g.beginPath(); g.moveTo(16.7, -17.2); g.quadraticCurveTo(23, 0, 16, 12); g.stroke();
    g.fillStyle = '#f1ece0'; circle(g, 16, 15, 5.5);
    g.fillStyle = '#d8402f'; g.beginPath(); g.arc(16, 15, 5.5, Math.PI, TAU); g.fill();
  },
  crate(g) {
    g.fillStyle = '#6e4726'; roundRect(g, -21, -17, 42, 36, 3); g.fill();
    g.fillStyle = '#a7743f';
    for (let i = 0; i < 3; i++) { roundRect(g, -18, -14 + i * 11, 36, 8.5, 1.5); g.fill(); }
    g.fillStyle = '#4f321b'; g.fillRect(-21, -4, 42, 3);
    g.fillStyle = '#b7bcc0';
    for (const [x, y] of [[-21, -17], [14, -17], [-21, 12], [14, 12]]) g.fillRect(x, y, 7, 7);
  },
  bandage(g) {
    g.fillStyle = '#d8d0bd';
    roundRect(g, 2, 4, 22, 9, 2); g.fill();
    g.fillStyle = '#f3eee2';
    circle(g, -4, 0, 15);
    g.strokeStyle = '#cfc6b1'; g.lineWidth = 1.5;
    g.beginPath(); g.arc(-4, 0, 10, 0, TAU); g.stroke();
    g.beginPath(); g.arc(-4, 0, 5, 0, TAU); g.stroke();
    g.fillStyle = '#c8473d';
    roundRect(g, -6, -9, 4, 18, 1); g.fill();
    roundRect(g, -13, -2, 18, 4, 1); g.fill();
  },
  handle(g, len) {
    g.strokeStyle = '#6e4726'; g.lineWidth = 5;
    g.beginPath(); g.moveTo(-len / 2, 0); g.lineTo(len / 2, 0); g.stroke();
    g.strokeStyle = '#a0703f'; g.lineWidth = 2.5;
    g.beginPath(); g.moveTo(-len / 2, -0.8); g.lineTo(len / 2, -0.8); g.stroke();
  },
  axe(g) {
    g.save(); g.rotate(-0.8);
    this.handle(g, 44);
    g.translate(15, 0);
    g.fillStyle = '#6f7479';
    g.beginPath(); g.moveTo(-5, -4); g.lineTo(4, -15); g.quadraticCurveTo(12, -10, 10, -2); g.lineTo(-5, 4); g.closePath(); g.fill();
    g.fillStyle = '#a7acb0';
    g.beginPath(); g.moveTo(4, -15); g.quadraticCurveTo(12, -10, 10, -2); g.lineTo(6, -4); g.quadraticCurveTo(8, -9, 3, -12); g.closePath(); g.fill();
    g.fillStyle = PAL.rope; roundRect(g, -6, -4, 6, 8, 1); g.fill();
    g.restore();
  },
  pick(g) {
    g.save(); g.rotate(-0.8);
    this.handle(g, 44);
    g.translate(16, 0);
    g.fillStyle = '#7d8287';
    g.beginPath(); g.moveTo(-2, -18); g.quadraticCurveTo(6, 0, -2, 18); g.lineTo(3, 0); g.closePath(); g.fill();
    g.fillStyle = '#b0b5b9';
    g.beginPath(); g.moveTo(-2, -18); g.quadraticCurveTo(4, -6, 1, 0); g.lineTo(3, 0); g.quadraticCurveTo(5, -8, -2, -18); g.fill();
    g.fillStyle = PAL.rope; roundRect(g, -4, -4, 6, 8, 1); g.fill();
    g.restore();
  },
  spear(g) {
    g.save(); g.rotate(-0.8);
    this.handle(g, 50);
    g.fillStyle = '#7d8287';
    g.beginPath(); g.moveTo(34, 0); g.lineTo(22, -6); g.lineTo(18, 0); g.lineTo(22, 6); g.closePath(); g.fill();
    g.fillStyle = '#b0b5b9';
    g.beginPath(); g.moveTo(34, 0); g.lineTo(22, -6); g.lineTo(21, -1); g.closePath(); g.fill();
    g.fillStyle = PAL.rope; roundRect(g, 16, -3.5, 6, 7, 1); g.fill();
    g.restore();
  },
  bow(g) {
    g.save(); g.rotate(-0.8);
    g.strokeStyle = '#e8dfc8'; g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(-4, -22); g.lineTo(-4, 22); g.stroke();
    g.strokeStyle = '#7a4f2b'; g.lineWidth = 4.5;
    g.beginPath(); g.moveTo(-4, -22); g.quadraticCurveTo(18, 0, -4, 22); g.stroke();
    g.strokeStyle = '#b07a45'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(-3, -20); g.quadraticCurveTo(16, 0, -3, 20); g.stroke();
    g.fillStyle = PAL.rope; roundRect(g, 4, -4, 5, 8, 1); g.fill();
    g.restore();
  },
  blade(g) {
    g.save(); g.rotate(-0.8);
    g.fillStyle = '#4a3420'; roundRect(g, -24, -3.5, 16, 7, 2); g.fill();
    g.strokeStyle = PAL.rope; g.lineWidth = 1.5;
    for (let i = 0; i < 4; i++) { g.beginPath(); g.moveTo(-22 + i * 4, -3.5); g.lineTo(-20 + i * 4, 3.5); g.stroke(); }
    g.fillStyle = '#d9cfb4';
    g.beginPath(); g.moveTo(-8, -5); g.quadraticCurveTo(12, -12, 26, -2); g.quadraticCurveTo(12, 2, -8, 5); g.closePath(); g.fill();
    g.fillStyle = '#f5eedc';
    g.beginPath(); g.moveTo(-8, -5); g.quadraticCurveTo(12, -12, 26, -2); g.quadraticCurveTo(12, -5, -8, -1); g.closePath(); g.fill();
    g.restore();
  },
  armor(g) {
    g.fillStyle = '#7a5532';
    g.beginPath();
    g.moveTo(-18, -16); g.lineTo(-8, -20); g.quadraticCurveTo(0, -12, 8, -20); g.lineTo(18, -16);
    g.lineTo(16, 18); g.quadraticCurveTo(0, 22, -16, 18); g.closePath(); g.fill();
    g.fillStyle = '#b48654';
    g.beginPath();
    g.moveTo(-15, -13); g.lineTo(-8, -16); g.quadraticCurveTo(0, -8, 8, -16); g.lineTo(15, -13);
    g.lineTo(13, 15); g.quadraticCurveTo(0, 18, -13, 15); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(70,45,20,0.8)'; g.setLineDash([2.5, 2.5]); g.lineWidth = 1.3;
    g.beginPath(); g.moveTo(0, -8); g.lineTo(0, 16); g.stroke();
    g.beginPath(); g.moveTo(-11, 2); g.lineTo(11, 2); g.stroke();
    g.setLineDash([]);
  },
  cloak(g) {
    g.fillStyle = '#5f666f';
    g.beginPath();
    g.moveTo(-10, -18); g.quadraticCurveTo(0, -14, 10, -18); g.quadraticCurveTo(24, 8, 18, 20);
    g.quadraticCurveTo(0, 14, -18, 20); g.quadraticCurveTo(-24, 8, -10, -18); g.fill();
    g.fillStyle = '#8c939c';
    g.beginPath();
    g.moveTo(-8, -14); g.quadraticCurveTo(0, -10, 8, -14); g.quadraticCurveTo(19, 6, 14, 16);
    g.quadraticCurveTo(0, 11, -14, 16); g.quadraticCurveTo(-19, 6, -8, -14); g.fill();
    g.fillStyle = '#d0d4d8';
    ellipse(g, 0, -15, 12, 4.5);
  },
  heart(g) {
    g.fillStyle = '#e0524a';
    g.beginPath();
    g.moveTo(0, 18); g.bezierCurveTo(-26, 2, -16, -22, 0, -9); g.bezierCurveTo(16, -22, 26, 2, 0, 18); g.fill();
    g.fillStyle = 'rgba(255,220,210,0.55)'; ellipse(g, -8, -6, 4, 2.6, -0.6);
  },
  food(g) { this.drumstick(g, '#e8a548', '#b5762a'); },
  warmth(g) {
    g.fillStyle = '#e8532a';
    g.beginPath(); g.moveTo(0, -22); g.quadraticCurveTo(18, -2, 12, 12); g.quadraticCurveTo(6, 22, 0, 22);
    g.quadraticCurveTo(-6, 22, -12, 12); g.quadraticCurveTo(-18, -2, 0, -22); g.fill();
    g.fillStyle = '#ffb23e';
    g.beginPath(); g.moveTo(0, -8); g.quadraticCurveTo(10, 4, 6, 13); g.quadraticCurveTo(3, 19, 0, 19);
    g.quadraticCurveTo(-3, 19, -6, 13); g.quadraticCurveTo(-10, 4, 0, -8); g.fill();
    g.fillStyle = '#fff1b8'; ellipse(g, 0, 13, 3.2, 5);
  },
  stamina(g) {
    g.fillStyle = '#9fd36a';
    g.beginPath(); g.moveTo(4, -22); g.lineTo(-12, 4); g.lineTo(-1, 4); g.lineTo(-5, 22); g.lineTo(12, -4); g.lineTo(1, -4); g.closePath(); g.fill();
  },
  swing(g) { this.axe(g); },
  dodge(g) {
    g.strokeStyle = '#e9e4d6'; g.lineWidth = 4;
    for (let i = 0; i < 3; i++) { g.beginPath(); g.moveTo(-20 + i * 3, -10 + i * 10); g.lineTo(4 + i * 3, -10 + i * 10); g.stroke(); }
    g.fillStyle = '#e9e4d6'; g.beginPath(); g.moveTo(22, 0); g.lineTo(8, -12); g.lineTo(8, 12); g.closePath(); g.fill();
  },
  use(g) {
    g.fillStyle = '#e2b38a';
    roundRect(g, -12, -4, 24, 22, 7); g.fill();
    for (let i = 0; i < 4; i++) { roundRect(g, -12 + i * 6.2, -20 + (i === 0 || i === 3 ? 5 : 0), 5.4, 20, 2.7); g.fill(); }
    roundRect(g, 9, 0, 13, 6, 3); g.fill();
  },
  craft(g) {
    g.save(); g.rotate(0.7);
    g.fillStyle = '#7a4f2b'; roundRect(g, -3, -6, 6, 30, 2); g.fill();
    g.fillStyle = '#9aa0a5'; roundRect(g, -14, -18, 28, 12, 2); g.fill();
    g.fillStyle = '#c9ced2'; roundRect(g, -14, -18, 28, 4, 2); g.fill();
    g.restore();
  },
  build(g) {
    g.fillStyle = '#8a5a33'; roundRect(g, -20, -16, 40, 32, 3); g.fill();
    g.strokeStyle = '#5e3a1c'; g.lineWidth = 2;
    for (let i = 0; i < 3; i++) { g.beginPath(); g.moveTo(-20, -6 + i * 10); g.lineTo(20, -6 + i * 10); g.stroke(); }
    g.fillStyle = '#c08a52'; roundRect(g, -20, -16, 40, 5, 2); g.fill();
  },
  demolish(g) {
    g.strokeStyle = '#e0524a'; g.lineWidth = 6;
    g.beginPath(); g.moveTo(-15, -15); g.lineTo(15, 15); g.moveTo(15, -15); g.lineTo(-15, 15); g.stroke();
  },
  pause(g) { g.fillStyle = '#e9e4d6'; roundRect(g, -13, -16, 9, 32, 2); g.fill(); roundRect(g, 4, -16, 9, 32, 2); g.fill(); },
  sound(g) {
    g.fillStyle = '#e9e4d6';
    g.beginPath(); g.moveTo(-18, -7); g.lineTo(-9, -7); g.lineTo(2, -17); g.lineTo(2, 17); g.lineTo(-9, 7); g.lineTo(-18, 7); g.closePath(); g.fill();
    g.strokeStyle = '#e9e4d6'; g.lineWidth = 3;
    g.beginPath(); g.arc(4, 0, 9, -0.8, 0.8); g.stroke();
    g.beginPath(); g.arc(4, 0, 16, -0.8, 0.8); g.stroke();
  },
  muted(g) {
    g.fillStyle = '#e9e4d6';
    g.beginPath(); g.moveTo(-18, -7); g.lineTo(-9, -7); g.lineTo(2, -17); g.lineTo(2, 17); g.lineTo(-9, 7); g.lineTo(-18, 7); g.closePath(); g.fill();
    g.strokeStyle = '#e0524a'; g.lineWidth = 3.5;
    g.beginPath(); g.moveTo(8, -8); g.lineTo(22, 8); g.moveTo(22, -8); g.lineTo(8, 8); g.stroke();
  },

  structure(g, id) {
    const fake = { type: id, tx: 0, ty: 0, x: 0, y: 0, hp: 1, maxHp: 1, fuel: 70, ammo: 10, aim: -0.6, armed: true, flash: 0, t: 0 };
    g.save();
    const big = id === 'tent' || id === 'workbench';
    const s = big ? 0.95 : 1;
    g.scale(s, s);
    Draw.structure(g, fake, 1.3, null, true);
    g.restore();
  },
};
