'use strict';
// Frame rendering: terrain chunks, y-sorted world objects, lighting, in-world UI.

const GROUND = {
  [T_GRASS]:  [[0x68, 0x93, 0x45], [0x86, 0xad, 0x56]],
  [T_FOREST]: [[0x39, 0x5f, 0x35], [0x50, 0x7a, 0x41]],
  [T_ROCKY]:  [[0x84, 0x83, 0x6e], [0xa2, 0x9e, 0x87]],
  [T_SAND]:   [[0xc9, 0xb2, 0x7a], [0xdc, 0xcb, 0x95]],
  [T_WATER]:  [[0xb0, 0x9c, 0x6a], [0xc0, 0xac, 0x78]],
};

const Render = {
  canvas: null, ctx: null, dpr: 1, W: 0, H: 0, scale: 1,
  cam: { x: WORLD_PX / 2, y: WORLD_PX / 2 },
  shakeMag: 0, shakeX: 0, shakeY: 0,
  light: null, lctx: null, LS: 0.5,
  chunks: new Map(), chunkRes: 1, CH: 10, frameNo: 0,
  base: null, wfield: null, wnoise: null, world: null,
  mini: null, miniBase: null, miniT: 0,
  t: 0,
  snow: [],

  init(canvas, mini) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.light = document.createElement('canvas');
    this.lctx = this.light.getContext('2d');
    this.mini = mini;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    for (let i = 0; i < 160; i++) this.snow.push({ x: Math.random(), y: Math.random(), s: rand(1, 3), v: rand(0.6, 1.2), p: Math.random() * TAU });
  },

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.W = window.innerWidth;
    this.H = window.innerHeight;
    this.canvas.width = Math.round(this.W * this.dpr);
    this.canvas.height = Math.round(this.H * this.dpr);
    this.scale = clamp(Math.min(this.W, this.H) / 660, 0.56, 1.22);
    this.light.width = Math.ceil(this.W * this.LS);
    this.light.height = Math.ceil(this.H * this.LS);
    const res = clamp(Math.round(this.dpr * this.scale * 4) / 4, 1, 2);
    if (res !== this.chunkRes) { this.chunkRes = res; this.chunks.clear(); }
  },

  setWorld(world) {
    this.world = world;
    this.chunks.clear();
    const N = world.N;
    // 1px-per-tile ground colours, drawn magnified with smoothing for soft biome blends.
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const g = c.getContext('2d');
    const img = g.createImageData(N, N);
    for (let i = 0; i < N * N; i++) {
      const [a, b] = GROUND[world.tiles[i]];
      const k = clamp((world.tone[i] - 0.28) / 0.44, 0, 1);
      img.data[i * 4] = lerp(a[0], b[0], k);
      img.data[i * 4 + 1] = lerp(a[1], b[1], k);
      img.data[i * 4 + 2] = lerp(a[2], b[2], k);
      img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    this.base = c;
    // Smoothed water field for organic shorelines.
    const raw = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) raw[i] = world.tiles[i] === T_WATER ? 1 : 0;
    const wf = new Float32Array(N * N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        let s = 0, w = 0;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const nx = clamp(x + ox, 0, N - 1), ny = clamp(y + oy, 0, N - 1);
            const k = (ox === 0 ? 2 : 1) * (oy === 0 ? 2 : 1);
            s += raw[ny * N + nx] * k; w += k;
          }
        }
        wf[y * N + x] = s / w;
      }
    }
    this.wfield = wf;
    this.wnoise = makeNoise(world.seed ^ 0x77);
    this.buildMiniBase();
  },

  buildMiniBase() {
    const w = this.world, N = w.N;
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const g = c.getContext('2d');
    const img = g.createImageData(N, N);
    for (let i = 0; i < N * N; i++) {
      let col;
      const t = w.tiles[i];
      if (t === T_WATER) col = [52, 104, 128];
      else {
        const [a, b] = GROUND[t];
        col = [lerp(a[0], b[0], 0.5), lerp(a[1], b[1], 0.5), lerp(a[2], b[2], 0.5)];
        const n = w.nodes[i];
        if (n && n.kind === 'tree') col = col.map(v => v * 0.62);
        else if (n && n.kind === 'rock') col = [150, 150, 145];
      }
      img.data[i * 4] = col[0]; img.data[i * 4 + 1] = col[1]; img.data[i * 4 + 2] = col[2]; img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    this.miniBase = c;
    this.miniVersion = w.version;
  },

  worldToScreen(x, y) {
    return { x: (x - this.cam.x) * this.scale + this.W / 2 + this.shakeX, y: (y - this.cam.y) * this.scale + this.H / 2 + this.shakeY };
  },
  screenToWorld(sx, sy) {
    return { x: (sx - this.W / 2 - this.shakeX) / this.scale + this.cam.x, y: (sy - this.H / 2 - this.shakeY) / this.scale + this.cam.y };
  },
  shake(mag) { this.shakeMag = Math.max(this.shakeMag, mag); },

  // ---------- terrain chunks ----------
  // Returns a cached chunk canvas; builds it only when budget allows (keeps frame times smooth while moving).
  getChunk(cx, cy, budget) {
    const key = cy * 100 + cx;
    let ch = this.chunks.get(key);
    if (ch) { ch.used = this.frameNo; return ch.c; }
    if (budget.n <= 0) return null;
    budget.n--;
    ch = { c: this.buildChunk(cx, cy), used: this.frameNo };
    this.chunks.set(key, ch);
    if (this.chunks.size > 36) {
      let oldK = null, oldU = Infinity;
      for (const [k, v] of this.chunks) if (v.used < oldU) { oldU = v.used; oldK = k; }
      this.chunks.delete(oldK);
    }
    return ch.c;
  },

  buildChunk(cx, cy) {
    const w = this.world, CH = this.CH, size = CH * TILE, res = this.chunkRes;
    const c = document.createElement('canvas');
    c.width = c.height = Math.ceil(size * res);
    const g = c.getContext('2d');
    g.scale(res, res);
    g.translate(-cx * size, -cy * size);
    const tx0 = cx * CH, ty0 = cy * CH;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    const m = 2;
    g.drawImage(this.base, tx0 - m, ty0 - m, CH + m * 2, CH + m * 2,
      (tx0 - m) * TILE + TILE / 2, (ty0 - m) * TILE + TILE / 2, (CH + m * 2) * TILE, (CH + m * 2) * TILE);
    g.lineCap = 'round';
    let hasWater = false;
    for (let ty = ty0 - 1; ty <= ty0 + CH; ty++) {
      for (let tx = tx0 - 1; tx <= tx0 + CH; tx++) {
        if (!w.inBounds(tx, ty)) continue;
        const t = w.tiles[ty * w.N + tx];
        if (t === T_WATER) { hasWater = true; continue; }
        this.tileDetails(g, tx, ty, t);
      }
    }
    if (hasWater || this.chunkNearWater(tx0, ty0)) this.paintWater(g, cx, cy);
    return c;
  },

  chunkNearWater(tx0, ty0) {
    const w = this.world;
    for (let ty = ty0 - 2; ty < ty0 + this.CH + 2; ty++) {
      for (let tx = tx0 - 2; tx < tx0 + this.CH + 2; tx++) if (w.inBounds(tx, ty) && w.tiles[ty * w.N + tx] === T_WATER) return true;
    }
    return false;
  },

  tileDetails(g, tx, ty, t) {
    const seed = this.world.seed;
    const h = k => hash2(tx * 7 + k, ty * 13 - k * 3, seed);
    const x0 = tx * TILE, y0 = ty * TILE;
    if (h(200) < 0.2) {
      const r = 22 + h(204) * 30, cx = x0 + h(202) * TILE, cy = y0 + h(203) * TILE;
      const dark = h(201) < 0.5;
      const gr = g.createRadialGradient(cx, cy, 0, cx, cy, r);
      gr.addColorStop(0, dark ? 'rgba(20,40,10,0.1)' : 'rgba(255,255,220,0.07)');
      gr.addColorStop(1, dark ? 'rgba(20,40,10,0)' : 'rgba(255,255,220,0)');
      g.fillStyle = gr;
      g.fillRect(cx - r, cy - r, r * 2, r * 2);
    }
    if (t === T_GRASS) {
      g.lineWidth = 1.4;
      for (let i = 0; i < 8; i++) {
        const x = x0 + h(i) * TILE, y = y0 + h(i + 20) * TILE;
        g.strokeStyle = h(i + 40) < 0.55 ? 'rgba(160,200,100,0.5)' : 'rgba(60,100,40,0.4)';
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + (h(i + 60) - 0.5) * 5, y - 4 - h(i + 80) * 4); g.stroke();
      }
      if (h(100) < 0.13) {
        const cols = ['#f3ecd6', '#f2c94c', '#c7a2dd', '#ec8f8f', '#9fc5f0'];
        g.fillStyle = cols[Math.floor(h(101) * cols.length)];
        const fx = x0 + 8 + h(102) * 32, fy = y0 + 8 + h(103) * 32;
        for (let i = 0; i < 5; i++) circle(g, fx + (h(110 + i) - 0.5) * 14, fy + (h(120 + i) - 0.5) * 14, 1.7);
      }
    } else if (t === T_FOREST) {
      g.lineWidth = 1.2;
      g.strokeStyle = 'rgba(110,80,40,0.35)';
      for (let i = 0; i < 7; i++) {
        const x = x0 + h(i) * TILE, y = y0 + h(i + 20) * TILE, a = h(i + 40) * TAU;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * 5, y + Math.sin(a) * 5); g.stroke();
      }
      if (h(100) < 0.25) {
        const r = 9 + h(103) * 10, cx = x0 + h(101) * TILE, cy = y0 + h(102) * TILE;
        const gr = g.createRadialGradient(cx, cy, 0, cx, cy, r);
        gr.addColorStop(0, 'rgba(90,130,60,0.3)');
        gr.addColorStop(1, 'rgba(90,130,60,0)');
        g.fillStyle = gr;
        g.fillRect(cx - r, cy - r, r * 2, r * 2);
      }
      if (h(104) < 0.06) {
        const fx = x0 + 12 + h(105) * 24, fy = y0 + 12 + h(106) * 24;
        g.strokeStyle = '#5e9a4a'; g.lineWidth = 2;
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * TAU + h(107);
          g.beginPath(); g.moveTo(fx, fy); g.quadraticCurveTo(fx + Math.cos(a + 0.3) * 6, fy + Math.sin(a + 0.3) * 6, fx + Math.cos(a) * 11, fy + Math.sin(a) * 11); g.stroke();
        }
      }
      if (h(108) < 0.022) {
        const fx = x0 + 10 + h(109) * 28, fy = y0 + 10 + h(110) * 28;
        g.fillStyle = '#efe6d0'; circle(g, fx + 1, fy + 1.5, 2);
        g.fillStyle = '#c7402f'; circle(g, fx, fy, 3.3);
        g.fillStyle = '#fff'; circle(g, fx - 1, fy - 1, 0.7); circle(g, fx + 1.2, fy + 0.4, 0.6);
      }
    } else if (t === T_ROCKY) {
      for (let i = 0; i < 4; i++) {
        g.fillStyle = h(i + 50) < 0.5 ? 'rgba(90,92,88,0.5)' : 'rgba(190,190,180,0.5)';
        ellipse(g, x0 + h(i) * TILE, y0 + h(i + 20) * TILE, 2 + h(i + 30) * 2.5, 1.5 + h(i + 40) * 2);
      }
      if (h(100) < 0.2) {
        g.strokeStyle = 'rgba(70,68,60,0.35)'; g.lineWidth = 1.2;
        const x = x0 + h(101) * TILE, y = y0 + h(102) * TILE;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + 8, y + 4); g.lineTo(x + 14, y + 2); g.stroke();
      }
    } else if (t === T_SAND) {
      for (let i = 0; i < 8; i++) {
        g.fillStyle = h(i + 50) < 0.5 ? 'rgba(140,115,70,0.35)' : 'rgba(255,250,230,0.4)';
        circle(g, x0 + h(i) * TILE, y0 + h(i + 20) * TILE, 0.9 + h(i + 30));
      }
    }
  },

  // Water layer computed per pixel from the smoothed field: deep/shallow colour, foam line, wet sand.
  paintWater(g, cx, cy) {
    const w = this.world, N = w.N, CH = this.CH, size = CH * TILE;
    const R = 2; // world px per water pixel
    const px = size / R;
    const tmp = document.createElement('canvas');
    tmp.width = tmp.height = px;
    const tg = tmp.getContext('2d');
    const img = tg.createImageData(px, px);
    const d = img.data, wf = this.wfield, noise = this.wnoise;
    const ox = cx * size, oy = cy * size;
    const sm = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
    for (let j = 0; j < px; j++) {
      for (let i = 0; i < px; i++) {
        const wx = ox + (i + 0.5) * R, wy = oy + (j + 0.5) * R;
        const fx = wx / TILE - 0.5, fy = wy / TILE - 0.5;
        const ix = Math.floor(fx), iy = Math.floor(fy);
        const ax = fx - ix, ay = fy - iy;
        const x0 = clamp(ix, 0, N - 1), x1 = clamp(ix + 1, 0, N - 1), y0 = clamp(iy, 0, N - 1), y1 = clamp(iy + 1, 0, N - 1);
        let f = lerp(lerp(wf[y0 * N + x0], wf[y0 * N + x1], ax), lerp(wf[y1 * N + x0], wf[y1 * N + x1], ax), ay);
        if (f < 0.2) continue;
        f += (noise(wx * 0.045, wy * 0.045) - 0.5) * 0.12;
        const aWet = 0.3 * sm(0.3, 0.44, f);
        const aFoam = 0.8 * sm(0.44, 0.48, f);
        const aWater = sm(0.48, 0.51, f);
        const depth = sm(0.52, 0.95, f);
        let r = 112, gg = 96, b = 62, a = aWet;
        // foam over wet sand
        let na = aFoam + a * (1 - aFoam);
        if (na > 0) { r = (232 * aFoam + r * a * (1 - aFoam)) / na; gg = (240 * aFoam + gg * a * (1 - aFoam)) / na; b = (234 * aFoam + b * a * (1 - aFoam)) / na; }
        a = na;
        const wr = lerp(92, 34, depth), wg = lerp(166, 96, depth), wb = lerp(176, 126, depth);
        na = aWater + a * (1 - aWater);
        if (na > 0) { r = (wr * aWater + r * a * (1 - aWater)) / na; gg = (wg * aWater + gg * a * (1 - aWater)) / na; b = (wb * aWater + b * a * (1 - aWater)) / na; }
        a = na;
        const k = (j * px + i) * 4;
        d[k] = r; d[k + 1] = gg; d[k + 2] = b; d[k + 3] = a * 255;
      }
    }
    tg.putImageData(img, 0, 0);
    g.drawImage(tmp, ox, oy, size, size);
  },

  // ---------- main frame ----------
  frame(S, dt) {
    const ctx = this.ctx, w = this.world;
    this.t += dt;
    this.frameNo++;
    const t = this.t;
    // camera shake
    if (this.shakeMag > 0.1) {
      this.shakeX = (Math.random() - 0.5) * this.shakeMag * 2;
      this.shakeY = (Math.random() - 0.5) * this.shakeMag * 2;
      this.shakeMag *= Math.exp(-dt * 14);
    } else { this.shakeX = this.shakeY = 0; this.shakeMag = 0; }

    const sc = this.scale, dpr = this.dpr;
    const ox = this.W / 2 - this.cam.x * sc + this.shakeX, oy = this.H / 2 - this.cam.y * sc + this.shakeY;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#1d3326';
    ctx.fillRect(0, 0, this.W, this.H);
    ctx.setTransform(dpr * sc, 0, 0, dpr * sc, dpr * ox, dpr * oy);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const vx0 = this.cam.x - this.W / 2 / sc - 60, vx1 = this.cam.x + this.W / 2 / sc + 60;
    const vy0 = this.cam.y - this.H / 2 / sc - 60, vy1 = this.cam.y + this.H / 2 / sc + 80;
    this.view = { x0: vx0, y0: vy0, x1: vx1, y1: vy1 };

    // ground
    const size = this.CH * TILE;
    const cx0 = Math.max(0, Math.floor(vx0 / size)), cx1 = Math.min(Math.ceil(WORLD_N / this.CH) - 1, Math.floor(vx1 / size));
    const cy0 = Math.max(0, Math.floor(vy0 / size)), cy1 = Math.min(Math.ceil(WORLD_N / this.CH) - 1, Math.floor(vy1 / size));
    const budget = { n: this.frameNo < 3 ? 99 : 2 };
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = this.getChunk(cx, cy, budget);
        if (c) ctx.drawImage(c, cx * size, cy * size, size, size);
        else {
          ctx.imageSmoothingEnabled = true;
          ctx.drawImage(this.base, cx * this.CH, cy * this.CH, this.CH, this.CH, cx * size, cy * size, size, size);
        }
      }
    }
    this.waterShimmer(ctx, t);

    const tx0 = Math.max(0, Math.floor(vx0 / TILE)), tx1 = Math.min(w.N - 1, Math.floor(vx1 / TILE));
    const ty0 = Math.max(0, Math.floor(vy0 / TILE)), ty1 = Math.min(w.N - 1, Math.floor((vy1 + 40) / TILE));
    const night = Game.darkness();
    const shadowA = 0.24 * (1 - night * 0.7);
    const p = S.player;

    // pass 1: flat ground objects; collect everything that stands up
    const sorted = [];
    const canopies = [];
    const standing = [];
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const i = ty * w.N + tx;
        const n = w.nodes[i];
        if (n) {
          if (n.kind === 'grass') this.drawSprite(ctx, (n.amt > 0 ? Sprites.grass : Sprites.grassCut)[n.v], n.x, n.y, n.rot, 1);
          else if (n.kind === 'stump') this.drawSprite(ctx, Sprites.stump, n.x, n.y, n.rot, 1);
          else {
            standing.push(n);
            if (n.kind === 'tree') { sorted.push({ y: n.y, k: 1, o: n }); canopies.push(n); }
            else sorted.push({ y: n.y, k: 2, o: n });
          }
        }
        const s = w.structs[i];
        if (s) {
          if (s.type === 'spikes' || s.type === 'snare') Draw.structure(ctx, s, t, w);
          else { standing.push(s); sorted.push({ y: s.y + (s.type === 'campfire' ? -6 : 0), k: 3, o: s }); }
        }
      }
    }
    // pass 2: shadows
    ctx.fillStyle = `rgba(12,24,14,${shadowA})`;
    for (const o of standing) {
      if (o.kind === 'tree') { const R = this.treeR(o); ellipse(ctx, o.x + R * 0.28, o.y + R * 0.36, R * 0.95, R * 0.8); }
      else if (o.kind === 'rock') ellipse(ctx, o.x + 4, o.y + 6, 19 * o.size, 15 * o.size);
      else if (o.kind === 'bush') ellipse(ctx, o.x + 3, o.y + 5, 15, 12);
      else if (o.type === 'torch') ellipse(ctx, o.x + 3, o.y + 5, 8, 6);
      else if (o.type && o.type !== 'campfire') ctx.fillRect(o.x - TILE / 2 + 6, o.y - TILE / 2 + 8, TILE, TILE - 2);
    }
    // drops
    for (const d of S.drops) if (d.x > vx0 && d.x < vx1 && d.y > vy0 && d.y < vy1) Draw.drop(ctx, d, t, shadowA);
    // creatures & player
    for (const c of S.creatures) {
      if (c.x < vx0 - 40 || c.x > vx1 + 40 || c.y < vy0 - 40 || c.y > vy1 + 40) continue;
      if (c.type === 'fish') { Draw.creature(ctx, c, t); continue; }
      const r = CREATURES[c.type].r;
      ctx.fillStyle = `rgba(12,24,14,${shadowA})`;
      ellipse(ctx, c.x + 3, c.y + 5, r * 1.1, r * 0.8);
      sorted.push({ y: c.y, k: 4, o: c });
    }
    if (p && !p.hidden) {
      ctx.fillStyle = `rgba(12,24,14,${shadowA})`;
      ellipse(ctx, p.x + 3, p.y + 5, 14, 11);
      sorted.push({ y: p.y, k: 5, o: p });
    }
    sorted.sort((a, b) => a.y - b.y);
    for (const e of sorted) {
      const o = e.o;
      if (e.k === 1) {
        ctx.fillStyle = '#5a3b22'; circle(ctx, o.x, o.y, 8); ctx.fillStyle = '#7a5332'; circle(ctx, o.x - 1, o.y - 1, 6);
      } else if (e.k === 2) {
        if (o.kind === 'rock') {
          const sh = o.shake > 0 ? Math.sin(t * 60) * o.shake * 6 : 0;
          const spr = (w.tiles[o.ty * w.N + o.tx] === T_FOREST ? Sprites.mossRocks : Sprites.rocks)[o.v];
          this.drawSprite(ctx, spr, o.x + sh, o.y, o.rot, o.size);
        } else {
          const sh = o.shake > 0 ? Math.sin(t * 50) * o.shake * 5 : 0;
          this.drawSprite(ctx, (o.ripe ? Sprites.bushes : Sprites.bushesBare)[o.v], o.x + sh, o.y, o.rot, 1);
        }
      } else if (e.k === 3) Draw.structure(ctx, o, t, w);
      else if (e.k === 4) Draw.creature(ctx, o, t);
      else if (e.k === 5) Draw.player(ctx, o, t, S);
    }
    // projectiles
    for (const a of S.arrows) Draw.arrow(ctx, a);
    // canopies
    for (const n of canopies) this.drawCanopy(ctx, n, p, t, dt);
    // particles below light
    Draw.particles(ctx, S.particles, false, vx0, vy0, vx1, vy1);

    // ---------- lighting ----------
    if (night > 0.01) this.lighting(S, night, ox, oy);
    else this.dayTint(S);

    ctx.setTransform(dpr * sc, 0, 0, dpr * sc, dpr * ox, dpr * oy);
    // glowing things on top of darkness
    ctx.globalCompositeOperation = 'lighter';
    Draw.particles(ctx, S.particles, true, vx0, vy0, vx1, vy1);
    if (night > 0.25) Draw.eyes(ctx, S.creatures, night, t, vx0, vy0, vx1, vy1);
    ctx.globalCompositeOperation = 'source-over';

    // in-world UI
    Draw.worldUI(ctx, S, t);

    // screen space
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (S.snow > 0.01) this.drawSnow(ctx, S.snow, dt);
    Draw.texts(ctx, S.texts);
  },

  treeR(n) {
    const base = n.species === 'birch' ? [28, 31, 34] : [34, 38, 42];
    return base[n.v];
  },

  drawSprite(ctx, spr, x, y, rot, s) {
    if (!rot && s === 1) { ctx.drawImage(spr.c, x - spr.w / 2, y - spr.h / 2, spr.w, spr.h); return; }
    ctx.save();
    ctx.translate(x, y);
    if (rot) ctx.rotate(rot);
    if (s !== 1) ctx.scale(s, s);
    ctx.drawImage(spr.c, -spr.w / 2, -spr.h / 2, spr.w, spr.h);
    ctx.restore();
  },

  drawCanopy(ctx, n, p, t, dt) {
    const sp = n.species === 'pine' ? 'pine' : n.autumn ? 'autumn' : n.species;
    const spr = Sprites.trees[sp][n.v];
    const R = this.treeR(n);
    let target = 1;
    if (p && !p.hidden && dist2(p.x, p.y, n.x, n.y) < (R + 8) * (R + 8)) target = 0.38;
    n.fade = n.fade == null ? target : lerp(n.fade, target, damp(10, dt));
    if (n.grow > 0) n.grow = Math.max(0, n.grow - dt * 1.4);
    const grow = 1 - (n.grow || 0) * 0.7;
    const sway = Math.sin(t * 1.1 + n.rot * 3) * 0.035;
    let sh = 0;
    if (n.shake > 0) sh = Math.sin(t * 55) * n.shake * 7;
    ctx.save();
    ctx.globalAlpha = n.fade;
    ctx.translate(n.x + sh, n.y - 4);
    ctx.rotate(n.rot + sway);
    const s = grow * (1 + Math.sin(t * 0.9 + n.rot) * 0.012);
    ctx.scale(s, s);
    ctx.drawImage(spr.c, -spr.w / 2, -spr.h / 2, spr.w, spr.h);
    ctx.restore();
  },

  waterShimmer(ctx, t) {
    const w = this.world, v = this.view;
    const tx0 = Math.max(0, Math.floor(v.x0 / TILE)), tx1 = Math.min(w.N - 1, Math.floor(v.x1 / TILE));
    const ty0 = Math.max(0, Math.floor(v.y0 / TILE)), ty1 = Math.min(w.N - 1, Math.floor(v.y1 / TILE));
    ctx.strokeStyle = 'rgba(220,240,245,0.35)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        if (w.tiles[ty * w.N + tx] !== T_WATER || this.wfield[ty * w.N + tx] < 0.75) continue;
        const h = hash2(tx, ty, 99);
        const ph = (t * 0.35 + h) % 1;
        const a = Math.sin(ph * Math.PI);
        if (a < 0.3) continue;
        const x = tx * TILE + 10 + h * 26 + ph * 8, y = ty * TILE + 12 + hash2(ty, tx, 7) * 24;
        ctx.moveTo(x, y);
        ctx.quadraticCurveTo(x + 5, y - 2.5 * a, x + 10, y);
      }
    }
    ctx.stroke();
  },

  lights(S) {
    const out = [];
    const p = S.player;
    for (const s of S.structures) {
      if (s.type === 'campfire' && s.fuel > 0) {
        const r = Game.fireLight(s);
        out.push({ x: s.x, y: s.y, r: r * (1 + Math.sin(this.t * 9 + s.x) * 0.02 + Math.sin(this.t * 23) * 0.015), i: 1, fire: s });
      } else if (s.type === 'torch') {
        out.push({ x: s.x, y: s.y, r: STRUCTS.torch.light * (1 + Math.sin(this.t * 11 + s.y) * 0.03), i: 0.95, torch: true });
      }
    }
    if (p && !p.hidden) out.push({ x: p.x, y: p.y, r: 95 + (S.perks.owl || 0) * 55, i: 0.75 });
    return out;
  },

  lighting(S, night, ox, oy) {
    const lc = this.lctx, LS = this.LS, sc = this.scale;
    const lw = this.light.width, lh = this.light.height;
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.globalCompositeOperation = 'source-over';
    lc.clearRect(0, 0, lw, lh);
    const tint = Game.ambientTint();
    lc.fillStyle = `rgba(${tint[0]},${tint[1]},${tint[2]},${night})`;
    lc.fillRect(0, 0, lw, lh);
    lc.globalCompositeOperation = 'destination-out';
    const lights = this.lights(S);
    for (const L of lights) {
      const x = (L.x * sc + ox) * LS, y = (L.y * sc + oy) * LS, r = L.r * sc * LS;
      if (x < -r || y < -r || x > lw + r || y > lh + r) continue;
      const g = lc.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(0,0,0,${L.i})`);
      g.addColorStop(0.55, `rgba(0,0,0,${L.i * 0.75})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      lc.fillStyle = g;
      lc.fillRect(x - r, y - r, r * 2, r * 2);
    }
    const ctx = this.ctx, dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.drawImage(this.light, 0, 0, this.W, this.H);
    // warm glow from fires
    ctx.globalCompositeOperation = 'lighter';
    for (const L of lights) {
      if (!L.fire && !L.torch) continue;
      const x = L.x * sc + ox, y = L.y * sc + oy, r = L.r * sc * 0.75;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      const a = (L.fire ? 0.22 : 0.14) * night;
      g.addColorStop(0, `rgba(255,150,60,${a})`);
      g.addColorStop(1, 'rgba(255,90,20,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    ctx.globalCompositeOperation = 'source-over';
    // dusk/dawn colour wash
    const wash = Game.skyWash();
    if (wash) { ctx.fillStyle = wash; ctx.fillRect(0, 0, this.W, this.H); }
  },

  dayTint(S) {
    const wash = Game.skyWash();
    if (!wash) return;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, this.W, this.H);
  },

  drawSnow(ctx, k, dt) {
    ctx.fillStyle = 'rgba(245,248,255,0.85)';
    const n = Math.floor(this.snow.length * k);
    for (let i = 0; i < n; i++) {
      const f = this.snow[i];
      f.y += dt * f.v * 0.09 * (1 + f.s * 0.3);
      f.x += dt * (0.02 + Math.sin(this.t * 0.8 + f.p) * 0.02);
      if (f.y > 1.02) { f.y = -0.02; f.x = Math.random(); }
      if (f.x > 1.02) f.x = -0.02;
      circle(ctx, f.x * this.W, f.y * this.H, f.s * 0.8);
    }
  },

  drawMinimap(S, dt) {
    if (!this.mini || this.mini.offsetParent === null) return;
    this.miniT -= dt;
    if (this.miniT > 0) return;
    this.miniT = 0.15;
    const w = this.world;
    if (this.miniVersion !== w.version) this.buildMiniBase();
    const c = this.mini, g = c.getContext('2d');
    const size = c.width;
    const k = size / WORLD_PX;
    g.imageSmoothingEnabled = false;
    g.drawImage(this.miniBase, 0, 0, size, size);
    const night = Game.darkness();
    if (night > 0.05) { g.fillStyle = `rgba(6,12,28,${night * 0.55})`; g.fillRect(0, 0, size, size); }
    for (const s of S.structures) {
      if (s.type === 'campfire') {
        g.fillStyle = s.fuel > 0 ? '#ffb347' : '#7a5a40';
        g.beginPath(); g.arc(s.x * k, s.y * k, 3.2, 0, TAU); g.fill();
      } else if (s.type !== 'snare' && s.type !== 'spikes') {
        g.fillStyle = s.type === 'stonewall' ? '#c9ccd0' : s.type === 'tent' ? '#e9d8a6' : '#c29a6a';
        g.fillRect(s.tx * TILE * k, s.ty * TILE * k, Math.max(2, TILE * k), Math.max(2, TILE * k));
      }
    }
    const p = S.player;
    for (const cr of S.creatures) {
      const def = CREATURES[cr.type];
      if (def.kind !== 'predator') continue;
      if (dist2(cr.x, cr.y, p.x, p.y) > 1100 * 1100) continue;
      g.fillStyle = def.boss ? '#ff4d3d' : '#ff7a6a';
      g.beginPath(); g.arc(cr.x * k, cr.y * k, def.boss ? 3.5 : 2.2, 0, TAU); g.fill();
    }
    // view rectangle
    const vw = this.W / this.scale * k, vh = this.H / this.scale * k;
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.lineWidth = 1;
    g.strokeRect(this.cam.x * k - vw / 2, this.cam.y * k - vh / 2, vw, vh);
    if (p && !p.hidden) {
      g.save();
      g.translate(p.x * k, p.y * k);
      g.rotate(p.aim);
      g.fillStyle = '#ffffff';
      g.strokeStyle = '#10201a';
      g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(6, 0); g.lineTo(-4, -4.5); g.lineTo(-2, 0); g.lineTo(-4, 4.5); g.closePath();
      g.stroke(); g.fill();
      g.restore();
    }
  },
};

// ---------- per-object drawing ----------
const Draw = {
  flash: false,
  col(c) { return this.flash ? '#ffffff' : c; },

  legs(ctx, len, side, r, phase, amp, color) {
    ctx.fillStyle = this.col(color);
    const s = Math.sin(phase) * amp;
    ellipse(ctx, len + s, -side, r * 1.35, r);
    ellipse(ctx, len - s, side, r * 1.35, r);
    ellipse(ctx, -len - s, -side, r * 1.35, r);
    ellipse(ctx, -len + s, side, r * 1.35, r);
  },

  creature(ctx, c, t) {
    const def = CREATURES[c.type];
    this.flash = c.flash > 0;
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.angle);
    // poses
    if (c.state === 'windup' || c.state === 'crouch') {
      const k = Math.sin(t * 40) * 0.6;
      ctx.translate(-3 + k, 0);
      ctx.scale(0.9, 1.08);
    } else if (c.state === 'strike' || c.state === 'pounce' || c.state === 'charge') ctx.scale(1.12, 0.92);
    if (c.spawnT > 0) ctx.globalAlpha = clamp(1 - c.spawnT, 0, 1);
    const f = this['c_' + c.type];
    if (f) f.call(this, ctx, c, t);
    ctx.restore();
    this.flash = false;
    if (c.hpShow > 0 && c.hp > 0 && def.kind !== 'fish') {
      const wbar = Math.max(26, def.r * 2), x = c.x - wbar / 2, y = c.y - def.r - 14;
      ctx.fillStyle = 'rgba(10,14,12,0.7)';
      roundRect(ctx, x - 1, y - 1, wbar + 2, 6, 3); ctx.fill();
      ctx.fillStyle = def.kind === 'predator' ? '#e0524a' : '#e8b04a';
      roundRect(ctx, x, y, wbar * clamp(c.hp / c.maxHp, 0, 1), 4, 2); ctx.fill();
    }
    if (c.stun > 0) {
      ctx.fillStyle = '#ffe28a';
      for (let i = 0; i < 3; i++) {
        const a = t * 5 + (i * TAU) / 3;
        circle(ctx, c.x + Math.cos(a) * 12, c.y - def.r - 4 + Math.sin(a) * 4, 2.2);
      }
    }
  },

  c_rabbit(ctx, c, t) {
    const hop = c.moving ? Math.abs(Math.sin(c.walk * 1.3)) : 0;
    ctx.scale(1 + hop * 0.18, 1 - hop * 0.08);
    ctx.fillStyle = this.col('#f4efe6'); circle(ctx, -9, 0, 3.4);
    ctx.fillStyle = this.col('#a88a6a'); ellipse(ctx, 0, 0, 9, 6.5);
    ctx.fillStyle = this.col('#8f735a'); ellipse(ctx, -1.5, 0, 6, 3.4);
    ctx.fillStyle = this.col('#a88a6a'); circle(ctx, 7, 0, 4.8);
    for (const s of [-1, 1]) {
      ctx.fillStyle = this.col('#a08263'); ellipse(ctx, 2, s * 2.8, 6, 1.9, s * 0.25);
      ctx.fillStyle = this.col('#e2b8a8'); ellipse(ctx, 2.4, s * 2.8, 4, 0.8, s * 0.25);
    }
    ctx.fillStyle = this.col('#d88a8a'); circle(ctx, 11.4, 0, 1.1);
  },

  c_deer(ctx, c, t) {
    this.legs(ctx, 11, 7, 3, c.walk, c.moving ? 5 : 0, '#6b4423');
    ctx.fillStyle = this.col('#f2ece0'); ellipse(ctx, -18, 0, 4.2, 3.6);
    ctx.fillStyle = this.col('#93623a'); ellipse(ctx, 0, 0, 18, 9.5);
    ctx.fillStyle = this.col('#ad7a48'); ellipse(ctx, -1, -1, 13, 5.5);
    ctx.fillStyle = this.col('#93623a'); ellipse(ctx, 15, 0, 7, 5.5);
    ctx.fillStyle = this.col('#a8743f'); ellipse(ctx, 22, 0, 7, 4.8);
    for (const s of [-1, 1]) {
      ctx.fillStyle = this.col('#8a5a30'); ellipse(ctx, 18.5, s * 6, 4.4, 2.1, s * 0.6);
      ctx.fillStyle = this.col('#d9b48a'); ellipse(ctx, 18.8, s * 6, 2.8, 1, s * 0.6);
    }
    ctx.fillStyle = this.col('#3a2516'); circle(ctx, 28.4, 0, 1.7);
    if (c.antlers) {
      ctx.strokeStyle = this.col('#e7d9b8'); ctx.lineWidth = 2;
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(20, s * 2.5); ctx.lineTo(12, s * 11); ctx.lineTo(5, s * 13);
        ctx.moveTo(15, s * 8); ctx.lineTo(16, s * 15);
        ctx.moveTo(9, s * 12); ctx.lineTo(8, s * 18);
        ctx.stroke();
      }
    }
  },

  c_boar(ctx, c, t) {
    this.legs(ctx, 9, 8, 3, c.walk, c.moving ? 4 : 0, '#2b201a');
    ctx.strokeStyle = this.col('#2b201a'); ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(-17, 0); ctx.lineTo(-22, Math.sin(t * 8) * 2); ctx.stroke();
    ctx.fillStyle = this.col('#4d3b31'); ellipse(ctx, 0, 0, 17, 11.5);
    ctx.fillStyle = this.col('#5e4a3e'); ellipse(ctx, -1, -2, 12, 6);
    ctx.strokeStyle = this.col('#261c17'); ctx.lineWidth = 1.4;
    for (let i = -12; i <= 10; i += 3) { ctx.beginPath(); ctx.moveTo(i, -2.5); ctx.lineTo(i - 1.5, 2.5); ctx.stroke(); }
    ctx.fillStyle = this.col('#43332a'); ellipse(ctx, 15, 0, 9, 8);
    for (const s of [-1, 1]) { ctx.fillStyle = this.col('#33261f'); ellipse(ctx, 11, s * 7.5, 3.5, 2.2, s * 0.5); }
    ctx.fillStyle = this.col('#c49a8e'); ellipse(ctx, 23, 0, 3.5, 4.6);
    ctx.fillStyle = this.col('#5a3a35'); circle(ctx, 24, -1.5, 0.9); circle(ctx, 24, 1.5, 0.9);
    ctx.strokeStyle = this.col('#f2ead8'); ctx.lineWidth = 2;
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.moveTo(20, s * 4); ctx.quadraticCurveTo(24, s * 8, 22, s * 9.5); ctx.stroke(); }
  },

  c_fish(ctx, c, t) {
    ctx.globalAlpha *= 0.8;
    const wig = Math.sin(t * (c.moving ? 18 : 6) + c.seed) * 0.4;
    ctx.fillStyle = this.col('#25485a');
    ctx.save(); ctx.translate(-7, 0); ctx.rotate(wig);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-8, -5); ctx.lineTo(-8, 5); ctx.closePath(); ctx.fill();
    ctx.restore();
    ellipse(ctx, 0, 0, 9, 4);
    ctx.fillStyle = this.col('#4f7f95'); ellipse(ctx, 1, -0.5, 6, 1.6);
  },

  wolfBody(ctx, c, t, k, body, back, belly) {
    this.legs(ctx, 9 * k, 6.5 * k, 3 * k, c.walk, c.moving ? 4.5 * k : 0, back);
    ctx.save();
    ctx.translate(-15 * k, 0);
    ctx.rotate(Math.sin(t * 7 + c.seed) * (c.moving ? 0.35 : 0.15));
    ctx.fillStyle = this.col(back); ellipse(ctx, -7 * k, 0, 9 * k, 3.6 * k);
    ctx.fillStyle = this.col(belly); ellipse(ctx, -13.5 * k, 0, 3 * k, 2.2 * k);
    ctx.restore();
    ctx.fillStyle = this.col(body); ellipse(ctx, 0, 0, 16 * k, 8.5 * k);
    ctx.fillStyle = this.col(back); ellipse(ctx, -2 * k, 0, 11 * k, 4.5 * k);
    ctx.fillStyle = this.col(body); circle(ctx, 14 * k, 0, 7 * k);
    ctx.fillStyle = this.col(belly); ellipse(ctx, 21 * k, 0, 5.5 * k, 3.4 * k);
    ctx.fillStyle = this.col('#16181b'); circle(ctx, 26 * k, 0, 1.7 * k);
    ctx.fillStyle = this.col(back);
    for (const s of [-1, 1]) {
      ctx.beginPath(); ctx.moveTo(14 * k, s * 2.5 * k); ctx.lineTo(9 * k, s * 8 * k); ctx.lineTo(12.5 * k, s * 7.5 * k); ctx.closePath(); ctx.fill();
    }
  },
  c_wolf(ctx, c, t) { this.wolfBody(ctx, c, t, 1, '#7f8792', '#5b626c', '#a8aeb6'); },
  c_alpha(ctx, c, t) {
    this.wolfBody(ctx, c, t, 1.45, '#4b5058', '#2c3035', '#757b84');
    ctx.strokeStyle = this.col('#c9ccd0'); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(-6, -5); ctx.lineTo(4, 4); ctx.moveTo(-2, -6); ctx.lineTo(8, 2); ctx.stroke();
  },

  c_lynx(ctx, c, t) {
    this.legs(ctx, 8, 6, 3, c.walk, c.moving ? 4 : 0, '#9a7445');
    ctx.fillStyle = this.col('#b08850'); ellipse(ctx, -15, 0, 5, 3);
    ctx.fillStyle = this.col('#1d1712'); circle(ctx, -19, 0, 2.4);
    ctx.fillStyle = this.col('#c49a62'); ellipse(ctx, 0, 0, 14, 7.5);
    ctx.fillStyle = this.col('#8a6538');
    for (let i = 0; i < 7; i++) circle(ctx, -9 + i * 3, ((i * 37) % 7) - 3, 1.2);
    ctx.fillStyle = this.col('#e2c79a'); ellipse(ctx, 12, 0, 5, 8);
    ctx.fillStyle = this.col('#c9a46c'); circle(ctx, 14, 0, 6.5);
    for (const s of [-1, 1]) {
      ctx.fillStyle = this.col('#a8834f');
      ctx.beginPath(); ctx.moveTo(13, s * 2); ctx.lineTo(8, s * 8); ctx.lineTo(12, s * 7); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = this.col('#1d1712'); ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.moveTo(8, s * 8); ctx.lineTo(5, s * 11); ctx.stroke();
    }
    ctx.fillStyle = this.col('#3a2516'); circle(ctx, 20, 0, 1.4);
  },

  c_bear(ctx, c, t) {
    this.legs(ctx, 15, 15, 6, c.walk * 0.8, c.moving ? 4 : 0, '#3b2616');
    ctx.fillStyle = this.col('#57381f'); ellipse(ctx, 0, 0, 28, 21);
    ctx.fillStyle = this.col('#6e4a2a'); ellipse(ctx, -3, -3, 20, 13);
    ctx.fillStyle = this.col('#654326'); ellipse(ctx, 8, 0, 10, 13);
    ctx.fillStyle = this.col('#57381f'); circle(ctx, 25, 0, 12.5);
    for (const s of [-1, 1]) { ctx.fillStyle = this.col('#45291a'); circle(ctx, 20, s * 10, 4.4); }
    ctx.fillStyle = this.col('#9a7454'); ellipse(ctx, 34, 0, 6.5, 5.5);
    ctx.fillStyle = this.col('#1d120b'); circle(ctx, 39.5, 0, 2.6);
  },

  player(ctx, p, t, S) {
    const g = p.gear;
    this.flash = p.hurtT > 0 && Math.floor(t * 30) % 2 === 0;
    ctx.save();
    ctx.translate(p.x, p.y);
    if (p.dead) { ctx.globalAlpha = 0.85; ctx.rotate(p.aim); ctx.scale(1.05, 0.8); }
    else ctx.rotate(p.aim);
    if (p.dodgeT > 0) ctx.scale(1.15, 0.85);
    const walk = p.walk || 0;
    const bob = Math.sin(walk) * 3.2;
    // backpack
    ctx.fillStyle = this.col(PAL.pack);
    roundRect(ctx, -15, -8, 9, 16, 3); ctx.fill();
    ctx.fillStyle = this.col('#8a6a46'); roundRect(ctx, -14, -6.5, 4, 13, 2); ctx.fill();
    if (g.cloak) {
      ctx.fillStyle = this.col('#7d848d'); ellipse(ctx, -2, 0, 11, 15.5);
      ctx.strokeStyle = this.col('#c3c8ce'); ctx.lineWidth = 1.2;
      for (let i = 0; i < 9; i++) {
        const a = Math.PI * 0.55 + (i / 8) * Math.PI * 0.9;
        ctx.beginPath(); ctx.moveTo(-2 + Math.cos(a) * 9, Math.sin(a) * 13.5); ctx.lineTo(-2 + Math.cos(a) * 12, Math.sin(a) * 16.5); ctx.stroke();
      }
    }
    // body
    ctx.fillStyle = this.col(PAL.jacket); ellipse(ctx, 0, 0, 9, 13);
    ctx.fillStyle = this.col('#3c86a6'); ellipse(ctx, 1.5, -1.5, 5, 9.5);
    if (g.armor) {
      ctx.fillStyle = this.col('#b48654');
      for (const s of [-1, 1]) ellipse(ctx, 0, s * 9.5, 6, 4.2);
    }
    // hands & tool
    const swinging = p.swingT > 0;
    const bowing = p.bowT > 0 && g.bow;
    if (bowing) {
      ctx.fillStyle = this.col(PAL.skin);
      circle(ctx, 15, -1, 3.8);
      circle(ctx, 3, 5, 3.8);
      ctx.strokeStyle = this.col('#7a4f2b'); ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(9, -1, 15, -1.1, 1.1); ctx.stroke();
      ctx.strokeStyle = this.col('#e8dfc8'); ctx.lineWidth = 1;
      const pull = p.bowT > 0.18 ? 0 : 5;
      ctx.beginPath(); ctx.moveTo(9 + Math.cos(-1.1) * 15, -1 + Math.sin(-1.1) * 15); ctx.lineTo(9 + Math.cos(-1.1) * 15 - 6 + pull, -1); ctx.lineTo(9 + Math.cos(1.1) * 15, -1 + Math.sin(1.1) * 15); ctx.stroke();
    } else {
      let hx = 7 + bob, hy = 9.5, ang = 0.45;
      if (swinging) {
        const k = ease.outCubic(1 - p.swingT / 0.18);
        const side = p.swingSide;
        ang = lerp(side * 1.5, -side * 1.05, k);
        hx = Math.cos(ang) * 13; hy = Math.sin(ang) * 13;
        const w = MELEE[p.swingWeapon] || MELEE.fist;
        ctx.strokeStyle = this.flash ? '#fff' : 'rgba(255,255,255,0.32)';
        ctx.lineWidth = 5;
        ctx.beginPath();
        const a0 = side * 1.5, a1 = ang;
        ctx.arc(0, 0, w.reach * 0.85, Math.min(a0, a1), Math.max(a0, a1));
        ctx.stroke();
      }
      ctx.fillStyle = this.col(PAL.skin);
      circle(ctx, 7 - bob, -9.5, 3.8);
      ctx.save();
      ctx.translate(hx, hy);
      ctx.rotate(ang);
      this.tool(ctx, swinging ? p.swingTool : p.idleTool);
      ctx.restore();
      ctx.fillStyle = this.col(PAL.skin);
      circle(ctx, hx, hy, 3.8);
    }
    // head + hat
    ctx.fillStyle = this.col(PAL.skin); circle(ctx, 3.5, 0, 6.5);
    ctx.fillStyle = this.col('#5e3f22'); circle(ctx, 1.5, 0, 9);
    ctx.fillStyle = this.col(PAL.hat); circle(ctx, 1, 0, 6.6);
    ctx.fillStyle = this.col('#4a3420'); ctx.beginPath(); ctx.arc(1, 0, 6.6, 0, TAU); ctx.lineWidth = 1.6; ctx.strokeStyle = this.col('#4a3420'); ctx.stroke();
    ctx.fillStyle = this.col('#a0744a'); ellipse(ctx, -0.5, -2, 3, 2);
    ctx.restore();
    this.flash = false;
  },

  // Drawn at the hand, pointing along +x.
  tool(ctx, tool) {
    if (!tool || tool === 'fist') return;
    if (tool === 'axe' || tool === 'pick') {
      ctx.strokeStyle = this.col('#6e4726'); ctx.lineWidth = 3.4;
      ctx.beginPath(); ctx.moveTo(-3, 0); ctx.lineTo(21, 0); ctx.stroke();
      ctx.fillStyle = this.col('#7d8287');
      if (tool === 'axe') { ctx.beginPath(); ctx.moveTo(15, -1); ctx.lineTo(18, -10); ctx.quadraticCurveTo(24, -7, 23, -1); ctx.closePath(); ctx.fill(); }
      else { ctx.beginPath(); ctx.moveTo(18, -11); ctx.quadraticCurveTo(24, 0, 18, 11); ctx.lineTo(21, 0); ctx.closePath(); ctx.fill(); }
      ctx.fillStyle = this.col(PAL.rope); ctx.fillRect(16, -2, 4, 4);
    } else if (tool === 'spear') {
      ctx.strokeStyle = this.col('#7a5230'); ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(-12, 0); ctx.lineTo(34, 0); ctx.stroke();
      ctx.fillStyle = this.col('#8c9196');
      ctx.beginPath(); ctx.moveTo(43, 0); ctx.lineTo(33, -4.5); ctx.lineTo(31, 0); ctx.lineTo(33, 4.5); ctx.closePath(); ctx.fill();
    } else if (tool === 'blade') {
      ctx.fillStyle = this.col('#4a3420'); ctx.fillRect(-3, -2.5, 8, 5);
      ctx.fillStyle = this.col('#e9e1c8');
      ctx.beginPath(); ctx.moveTo(4, -3.5); ctx.quadraticCurveTo(18, -9, 28, -1); ctx.quadraticCurveTo(16, 2, 4, 3.5); ctx.closePath(); ctx.fill();
    }
  },

  structure(ctx, s, t, world, icon) {
    const x = s.x, y = s.y;
    switch (s.type) {
      case 'campfire': {
        ctx.fillStyle = '#2d2520'; circle(ctx, x, y, 13);
        for (let i = 0; i < 10; i++) {
          const a = (i / 10) * TAU;
          ctx.fillStyle = i % 2 ? '#7d8287' : '#9aa0a5';
          circle(ctx, x + Math.cos(a) * 15.5, y + Math.sin(a) * 15.5, 4.6);
          ctx.fillStyle = 'rgba(255,255,255,0.25)';
          circle(ctx, x + Math.cos(a) * 15.5 - 1.2, y + Math.sin(a) * 15.5 - 1.2, 1.6);
        }
        for (let i = 0; i < 3; i++) {
          ctx.save(); ctx.translate(x, y); ctx.rotate(i * 2.1 + 0.3);
          ctx.fillStyle = '#6e4726'; roundRect(ctx, -11, -3, 22, 6, 3); ctx.fill();
          ctx.fillStyle = '#2a1d14'; roundRect(ctx, -4, -3, 8, 6, 2); ctx.fill();
          ctx.restore();
        }
        if (s.fuel > 0) this.flame(ctx, x, y - 1, 0.45 + (s.fuel / FIRE.maxFuel) * 0.75, t, x);
        else {
          for (let i = 0; i < 5; i++) {
            const a = (i / 5) * TAU + 0.5;
            ctx.fillStyle = `rgba(255,${80 + i * 10},40,${0.4 + Math.sin(t * 3 + i) * 0.25})`;
            circle(ctx, x + Math.cos(a) * 5, y + Math.sin(a) * 4, 1.8);
          }
        }
        break;
      }
      case 'torch': {
        ctx.fillStyle = '#5a3b22'; circle(ctx, x, y, 6);
        ctx.fillStyle = '#8a5f36'; circle(ctx, x - 1, y - 1, 4.2);
        ctx.fillStyle = PAL.rope; ctx.fillRect(x - 4, y - 1.5, 8, 3);
        this.flame(ctx, x, y - 3, 0.45, t, y);
        break;
      }
      case 'wall': case 'stonewall': case 'gate':
        this.block(ctx, s, world, t);
        break;
      case 'spikes': {
        ctx.fillStyle = 'rgba(92,70,44,0.55)'; circle(ctx, x, y, 17);
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * TAU + 0.2;
          const c = Math.cos(a), sn = Math.sin(a);
          ctx.fillStyle = '#7a5230';
          ctx.beginPath();
          ctx.moveTo(x + -sn * 3, y + c * 3); ctx.lineTo(x + c * 20, y + sn * 20); ctx.lineTo(x + sn * 3, y - c * 3); ctx.closePath();
          ctx.fill();
          ctx.fillStyle = '#e3cfa6';
          ctx.beginPath();
          ctx.moveTo(x + c * 14 - sn * 1.4, y + sn * 14 + c * 1.4); ctx.lineTo(x + c * 20, y + sn * 20); ctx.lineTo(x + c * 14 + sn * 1.4, y + sn * 14 - c * 1.4); ctx.closePath();
          ctx.fill();
        }
        ctx.fillStyle = '#5a3b22'; circle(ctx, x, y, 5);
        break;
      }
      case 'snare': {
        ctx.strokeStyle = PAL.rope; ctx.lineWidth = 1.8;
        if (s.armed) { ctx.beginPath(); ctx.ellipse(x + 3, y + 2, 10, 7, 0.3, 0, TAU); ctx.stroke(); }
        else { ctx.beginPath(); ctx.moveTo(x - 6, y - 4); ctx.lineTo(x + 8, y + 5); ctx.stroke(); ctx.beginPath(); ctx.arc(x + 9, y + 6, 2.5, 0, TAU); ctx.stroke(); }
        ctx.fillStyle = '#6e4726'; circle(ctx, x - 7, y - 5, 3.5);
        ctx.fillStyle = '#9a6a3c'; circle(ctx, x - 7.5, y - 5.5, 2.2);
        break;
      }
      case 'workbench': {
        ctx.fillStyle = '#5e3c20'; roundRect(ctx, x - 21, y - 14, 42, 30, 3); ctx.fill();
        ctx.fillStyle = '#a7743f'; roundRect(ctx, x - 21, y - 16, 42, 28, 3); ctx.fill();
        ctx.strokeStyle = 'rgba(80,50,25,0.55)'; ctx.lineWidth = 1;
        for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(x - 21, y - 16 + i * 7); ctx.lineTo(x + 21, y - 16 + i * 7); ctx.stroke(); }
        ctx.fillStyle = '#b7bcc0';
        ctx.beginPath(); ctx.moveTo(x - 16, y - 10); ctx.lineTo(x + 2, y - 10); ctx.lineTo(x + 2, y - 4); ctx.lineTo(x - 12, y - 4); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#6e4726'; roundRect(ctx, x + 2, y - 11, 6, 8, 2); ctx.fill();
        ctx.fillStyle = '#6e4726'; ctx.fillRect(x + 6, y + 1, 12, 3);
        ctx.fillStyle = '#7d8287'; roundRect(ctx, x + 14, y - 2, 6, 9, 1.5); ctx.fill();
        break;
      }
      case 'tent': {
        ctx.strokeStyle = 'rgba(217,192,138,0.9)'; ctx.lineWidth = 1;
        const st = [[-24, -20], [24, -20], [-24, 22], [24, 22]];
        for (const [a, b] of st) {
          ctx.beginPath(); ctx.moveTo(x + a * 0.6, y + b * 0.75); ctx.lineTo(x + a, y + b); ctx.stroke();
          ctx.fillStyle = '#6e4726'; circle(ctx, x + a, y + b, 1.8);
        }
        ctx.fillStyle = '#c9ae78';
        ctx.beginPath(); ctx.moveTo(x - 17, y - 16); ctx.lineTo(x, y - 18); ctx.lineTo(x, y + 18); ctx.lineTo(x - 17, y + 16); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#9e8656';
        ctx.beginPath(); ctx.moveTo(x + 17, y - 16); ctx.lineTo(x, y - 18); ctx.lineTo(x, y + 18); ctx.lineTo(x + 17, y + 16); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = '#6e5a38'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x, y - 19); ctx.lineTo(x, y + 19); ctx.stroke();
        ctx.fillStyle = '#3e3020';
        ctx.beginPath(); ctx.moveTo(x - 6, y + 17); ctx.lineTo(x, y + 9); ctx.lineTo(x + 6, y + 17); ctx.closePath(); ctx.fill();
        break;
      }
      case 'springbow': {
        ctx.strokeStyle = '#5e3c20'; ctx.lineWidth = 3.5;
        for (let i = 0; i < 3; i++) { const a = (i / 3) * TAU + 0.5; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * 17, y + Math.sin(a) * 17); ctx.stroke(); }
        ctx.fillStyle = '#8a5f36'; circle(ctx, x, y, 7);
        ctx.save(); ctx.translate(x, y); ctx.rotate(s.aim || 0);
        ctx.strokeStyle = '#7a4f2b'; ctx.lineWidth = 3.4;
        ctx.beginPath(); ctx.arc(-2, 0, 16, -1.15, 1.15); ctx.stroke();
        ctx.strokeStyle = '#e8dfc8'; ctx.lineWidth = 1;
        const pull = s.ammo > 0 && (s.cd || 0) < 0.6 ? 7 : 0;
        ctx.beginPath(); ctx.moveTo(-2 + Math.cos(-1.15) * 16, Math.sin(-1.15) * 16); ctx.lineTo(4 - pull, 0); ctx.lineTo(-2 + Math.cos(1.15) * 16, Math.sin(1.15) * 16); ctx.stroke();
        if (s.ammo > 0) { ctx.strokeStyle = '#a77a45'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(4 - pull, 0); ctx.lineTo(22 - pull, 0); ctx.stroke(); }
        ctx.restore();
        break;
      }
      default: break;
    }
    if (s.flash > 0 && !icon) {
      ctx.fillStyle = `rgba(255,255,255,${s.flash * 2.5})`;
      ctx.fillRect(x - TILE / 2, y - TILE / 2, TILE, TILE);
    }
    if (!icon && s.hp < s.maxHp && s.type !== 'campfire' && s.showHp > 0) {
      const w = 34, bx = x - w / 2, by = y - TILE / 2 - 8;
      ctx.fillStyle = 'rgba(10,14,12,0.7)'; roundRect(ctx, bx - 1, by - 1, w + 2, 6, 3); ctx.fill();
      ctx.fillStyle = s.hp / s.maxHp > 0.35 ? '#e8d27a' : '#e0524a';
      roundRect(ctx, bx, by, w * clamp(s.hp / s.maxHp, 0, 1), 4, 2); ctx.fill();
    }
  },

  // Walls, stone walls and gates join up with their neighbours into one barricade.
  block(ctx, s, world, t) {
    const h = TILE / 2, x0 = s.x - h, y0 = s.y - h;
    const isWall = o => o && (o.type === 'wall' || o.type === 'stonewall' || o.type === 'gate');
    const con = (dx, dy) => (world ? isWall(world.structAt(s.tx + dx, s.ty + dy)) : false);
    const n = con(0, -1), e = con(1, 0), so = con(0, 1), w = con(-1, 0);
    const ins = 5;
    const l = x0 + (w ? 0 : ins), r = x0 + TILE - (e ? 0 : ins), tp = y0 + (n ? 0 : ins), b = y0 + TILE - (so ? 0 : ins);
    const stone = s.type === 'stonewall', gate = s.type === 'gate';
    // south face for a sense of height
    if (!so) {
      ctx.fillStyle = stone ? '#4f5458' : '#4a2f19';
      ctx.fillRect(l, b - 2, r - l, 8);
    }
    ctx.fillStyle = stone ? '#5d6266' : '#4f321b';
    ctx.fillRect(l, tp, r - l, b - tp);
    ctx.save();
    ctx.beginPath(); ctx.rect(l, tp, r - l, b - tp); ctx.clip();
    if (stone) {
      const rows = 4;
      for (let j = 0; j < rows; j++) {
        const yy = y0 + j * 12;
        const off = (j + s.ty * 4) % 2 ? 0 : 8;
        for (let xx = x0 - 16 + off; xx < x0 + TILE + 16; xx += 16) {
          const hv = hash2(Math.floor(xx), Math.floor(yy), 5);
          ctx.fillStyle = hv < 0.33 ? '#8d9397' : hv < 0.66 ? '#9ca2a6' : '#848a8e';
          roundRect(ctx, xx + 1, yy + 1, 14, 10, 3); ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,0.18)';
          ctx.fillRect(xx + 3, yy + 2, 10, 2);
        }
      }
    } else if (gate) {
      const horiz = e || w || !(n || so);
      ctx.fillStyle = '#7a5230';
      if (horiz) for (let j = 0; j < 4; j++) { ctx.fillRect(x0, y0 + 5 + j * 10, TILE, 8); }
      else for (let j = 0; j < 4; j++) { ctx.fillRect(x0 + 5 + j * 10, y0, 8, TILE); }
      ctx.strokeStyle = '#a7743f'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(x0 + 8, y0 + 8); ctx.lineTo(x0 + TILE - 8, y0 + TILE - 8); ctx.stroke();
      ctx.fillStyle = '#c08a52';
      for (const [px, py] of horiz ? [[x0 + 5, s.y], [x0 + TILE - 5, s.y]] : [[s.x, y0 + 5], [s.x, y0 + TILE - 5]]) { circle(ctx, px, py, 5.5); }
    } else {
      // log ends seen from above
      for (let j = 0; j < 5; j++) {
        const yy = y0 + 1 + j * 11;
        const off = (j + s.ty) % 2 ? 0 : 5.5;
        for (let xx = x0 - 6 + off; xx < x0 + TILE + 6; xx += 11) {
          const hv = hash2(Math.floor(xx * 3), Math.floor(yy * 3), 9);
          ctx.fillStyle = hv < 0.5 ? '#9a6a3c' : '#a8774a';
          circle(ctx, xx, yy, 5.6);
          ctx.fillStyle = hv < 0.5 ? '#c99a62' : '#d4a872';
          circle(ctx, xx - 0.6, yy - 0.6, 4);
          ctx.strokeStyle = 'rgba(120,80,40,0.6)'; ctx.lineWidth = 0.8;
          ctx.beginPath(); ctx.arc(xx - 0.6, yy - 0.6, 2.2, 0, TAU); ctx.stroke();
        }
      }
    }
    ctx.restore();
    // edge shading
    ctx.strokeStyle = stone ? 'rgba(30,34,38,0.55)' : 'rgba(40,24,10,0.6)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (!n) { ctx.moveTo(l, tp); ctx.lineTo(r, tp); }
    if (!so) { ctx.moveTo(l, b); ctx.lineTo(r, b); }
    if (!w) { ctx.moveTo(l, tp); ctx.lineTo(l, b); }
    if (!e) { ctx.moveTo(r, tp); ctx.lineTo(r, b); }
    ctx.stroke();
    // damage cracks
    const dmg = 1 - s.hp / s.maxHp;
    if (dmg > 0.3) {
      ctx.strokeStyle = 'rgba(20,12,6,0.7)'; ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(s.x - 10, s.y - 8); ctx.lineTo(s.x - 2, s.y); ctx.lineTo(s.x - 5, s.y + 9);
      if (dmg > 0.6) { ctx.moveTo(s.x + 4, s.y - 12); ctx.lineTo(s.x + 9, s.y - 2); ctx.lineTo(s.x + 3, s.y + 6); }
      ctx.stroke();
    }
  },

  flame(ctx, x, y, size, t, seed) {
    const layers = [['#b8321b', 1], ['#ee6a22', 0.78], ['#ffb43c', 0.54], ['#fff2b8', 0.28]];
    for (let i = 0; i < layers.length; i++) {
      const [col, s] = layers[i];
      const R = 12 * size * s;
      const f = Math.sin(t * 13 + seed + i * 1.7) * 0.14 + Math.sin(t * 29 + i) * 0.06;
      const sway = Math.sin(t * 7 + seed * 0.3 + i) * R * 0.25;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(x + sway, y - R * (1.9 + f));
      ctx.bezierCurveTo(x + R * 0.95, y - R * 0.9, x + R * 1.05, y + R * 0.55, x, y + R * 0.8);
      ctx.bezierCurveTo(x - R * 1.05, y + R * 0.55, x - R * 0.95, y - R * 0.9, x + sway, y - R * (1.9 + f));
      ctx.fill();
    }
  },

  drop(ctx, d, t, shadowA) {
    const icon = Sprites.icons[d.item];
    if (!icon) return;
    const bob = d.z > 0 ? 0 : Math.sin(t * 3 + d.seed) * 1.5;
    ctx.fillStyle = `rgba(12,24,14,${shadowA * 0.9})`;
    ellipse(ctx, d.x, d.y + 6, 8, 3.5);
    const s = 20 * (d.t < 0.15 ? 0.6 + d.t * 2.6 : 1);
    ctx.drawImage(icon, d.x - s / 2, d.y - s / 2 - d.z - 4 + bob, s, s);
  },

  arrow(ctx, a) {
    const ang = Math.atan2(a.vy, a.vx);
    ctx.save();
    ctx.translate(a.x, a.y);
    ctx.rotate(ang);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(-34, 0); ctx.lineTo(-14, 0); ctx.stroke();
    ctx.strokeStyle = '#a77a45'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-14, 0); ctx.lineTo(8, 0); ctx.stroke();
    ctx.fillStyle = '#8c9196';
    ctx.beginPath(); ctx.moveTo(13, 0); ctx.lineTo(6, -3.5); ctx.lineTo(6, 3.5); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#efe9da';
    ctx.beginPath(); ctx.moveTo(-10, 0); ctx.lineTo(-16, -4); ctx.lineTo(-14, 0); ctx.lineTo(-16, 4); ctx.closePath(); ctx.fill();
    ctx.restore();
  },

  particles(ctx, list, glow, x0, y0, x1, y1) {
    for (const q of list) {
      if (!!q.glow !== glow) continue;
      if (q.x < x0 || q.x > x1 || q.y < y0 || q.y > y1) continue;
      const k = q.life / q.max;
      if (q.type === 'smoke') {
        ctx.fillStyle = `rgba(${q.c},${0.22 * k})`;
        circle(ctx, q.x, q.y, q.size * (1.8 - k));
      } else if (q.type === 'ring') {
        ctx.strokeStyle = `rgba(${q.c},${k * 0.8})`;
        ctx.lineWidth = 3 * k;
        ctx.beginPath(); ctx.arc(q.x, q.y, q.size * (1 - k) + 4, 0, TAU); ctx.stroke();
      } else if (q.type === 'chip') {
        ctx.save();
        ctx.translate(q.x, q.y - (q.z || 0));
        ctx.rotate(q.rot);
        ctx.fillStyle = `rgba(${q.c},${Math.min(1, k * 2)})`;
        ctx.fillRect(-q.size, -q.size * 0.5, q.size * 2, q.size);
        ctx.restore();
      } else if (q.type === 'fly') {
        const a = (0.5 + Math.sin(q.life * 6 + q.rot) * 0.5) * Math.min(1, k * 3);
        ctx.fillStyle = `rgba(210,255,120,${a * 0.25})`;
        circle(ctx, q.x, q.y, 6);
        ctx.fillStyle = `rgba(235,255,170,${a})`;
        circle(ctx, q.x, q.y, 1.8);
      } else {
        ctx.fillStyle = `rgba(${q.c},${glow ? k : Math.min(1, k * 1.6)})`;
        circle(ctx, q.x, q.y - (q.z || 0), q.size * (glow ? 0.5 + k * 0.5 : 1));
      }
    }
  },

  eyes(ctx, creatures, night, t, x0, y0, x1, y1) {
    const EYE = { wolf: [21, 2.6], alpha: [30, 3.8], lynx: [17, 2.8], bear: [31, 5] };
    for (const c of creatures) {
      const e = EYE[c.type];
      if (!e || c.x < x0 || c.x > x1 || c.y < y0 || c.y > y1 || c.flee) continue;
      const blink = Math.sin(t * 0.7 + c.seed * 3) > 0.97 ? 0 : 1;
      const a = night * blink * (c.spawnT > 0 ? 1 - c.spawnT : 1);
      const ca = Math.cos(c.angle), sa = Math.sin(c.angle);
      const hot = c.state === 'windup' || c.state === 'crouch';
      for (const s of [-1, 1]) {
        const ex = c.x + ca * e[0] - sa * e[1] * s, ey = c.y + sa * e[0] + ca * e[1] * s;
        ctx.fillStyle = hot ? `rgba(255,80,50,${0.3 * a})` : `rgba(255,190,70,${0.22 * a})`;
        circle(ctx, ex, ey, 5);
        ctx.fillStyle = hot ? `rgba(255,140,110,${a})` : `rgba(255,226,140,${a})`;
        circle(ctx, ex, ey, 1.7);
      }
    }
  },

  worldUI(ctx, S, t) {
    const p = S.player;
    if (!p || p.hidden) return;
    // interact target
    const it = Game.interactTarget;
    if (it && Game.mode === 'play' && !S.build) {
      ctx.strokeStyle = `rgba(255,236,190,${0.5 + Math.sin(t * 6) * 0.25})`;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 5]);
      ctx.beginPath(); ctx.arc(it.x, it.y, 30, 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
    }
    // cooking progress
    if (S.cook && S.cook.fire && S.cook.t > 0) {
      const f = S.cook.fire;
      ctx.strokeStyle = 'rgba(10,10,10,0.5)'; ctx.lineWidth = 5;
      ctx.beginPath(); ctx.arc(f.x, f.y - 38, 9, 0, TAU); ctx.stroke();
      ctx.strokeStyle = '#ffc56a'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(f.x, f.y - 38, 9, -Math.PI / 2, -Math.PI / 2 + TAU * (S.cook.t / FIRE.cookTime)); ctx.stroke();
      const ic = Sprites.icons[S.cook.item];
      if (ic) ctx.drawImage(ic, f.x - 7, f.y - 45, 14, 14);
    }
    // stamina ring
    if (p.stamina < 99.5 && !p.dead) {
      const k = p.stamina / 100;
      ctx.strokeStyle = 'rgba(10,20,10,0.45)'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(p.x, p.y, 24, -Math.PI / 2, -Math.PI / 2 + TAU); ctx.stroke();
      ctx.strokeStyle = p.exhausted ? '#e0524a' : '#a6dc6e'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(p.x, p.y, 24, -Math.PI / 2, -Math.PI / 2 + TAU * k); ctx.stroke();
    }
    // aim hint (mouse)
    if (!Input.touchMode && !S.build && Game.mode === 'play' && !p.dead) {
      const r = 34;
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, p.aim - 0.22, p.aim + 0.22); ctx.stroke();
    }
    // build ghost
    if (S.build && Game.ghost) {
      const gh = Game.ghost;
      ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 6]);
      ctx.beginPath(); ctx.arc(p.x, p.y, PLAYER.buildRange, 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
      const x0 = gh.tx * TILE, y0 = gh.ty * TILE;
      if (S.build.id === 'demolish') {
        const st = Game.world.structAt(gh.tx, gh.ty);
        ctx.strokeStyle = st ? '#ff6b5b' : 'rgba(255,255,255,0.5)';
        ctx.lineWidth = 2.5;
        ctx.strokeRect(x0 + 2, y0 + 2, TILE - 4, TILE - 4);
        if (st) { ctx.fillStyle = 'rgba(255,80,60,0.18)'; ctx.fillRect(x0, y0, TILE, TILE); }
      } else {
        ctx.save();
        ctx.globalAlpha = 0.6;
        const fake = { type: S.build.id, tx: gh.tx, ty: gh.ty, x: x0 + TILE / 2, y: y0 + TILE / 2, hp: 1, maxHp: 1, fuel: 60, ammo: 0, armed: true, aim: 0, flash: 0 };
        this.structure(ctx, fake, t, null, true);
        ctx.restore();
        ctx.fillStyle = gh.ok ? 'rgba(120,230,120,0.18)' : 'rgba(255,80,60,0.22)';
        ctx.fillRect(x0, y0, TILE, TILE);
        ctx.strokeStyle = gh.ok ? '#8be58b' : '#ff6b5b';
        ctx.lineWidth = 2;
        ctx.strokeRect(x0 + 1, y0 + 1, TILE - 2, TILE - 2);
      }
    }
  },

  texts(ctx, texts) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const tx of texts) {
      const sp = Render.worldToScreen(tx.x, tx.y);
      const k = tx.life / tx.max;
      const pop = tx.max - tx.life < 0.12 ? 1 + (0.12 - (tx.max - tx.life)) * 3 : 1;
      ctx.globalAlpha = Math.min(1, k * 2.5);
      ctx.font = `700 ${Math.round(tx.size * pop)}px "Barlow Semi Condensed", "Arial Narrow", sans-serif`;
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = 'rgba(12,18,14,0.85)';
      ctx.strokeText(tx.text, sp.x, sp.y);
      ctx.fillStyle = tx.color;
      ctx.fillText(tx.text, sp.x, sp.y);
    }
    ctx.globalAlpha = 1;
  },
};
