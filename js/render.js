'use strict';
// Frame rendering at the art resolution: pixel terrain chunks, y-sorted world objects, lighting and
// in-world UI, each drawn into the layer that pixel.js composites (ground, objs, fx, light, warm, ui).

const GROUND = {
  [T_GRASS]:  [[0x68, 0x93, 0x45], [0x86, 0xad, 0x56]],
  [T_FOREST]: [[0x39, 0x5f, 0x35], [0x50, 0x7a, 0x41]],
  [T_ROCKY]:  [[0x84, 0x83, 0x6e], [0xa2, 0x9e, 0x87]],
  [T_SAND]:   [[0xc9, 0xb2, 0x7a], [0xdc, 0xcb, 0x95]],
  [T_WATER]:  [[0xb0, 0x9c, 0x6a], [0xc0, 0xac, 0x78]],
};
// Four ground shades per terrain, dark to light.
const GROUND_PAL = {};
for (const t in GROUND) {
  const [a, b] = GROUND[t];
  GROUND_PAL[t] = [a.map(v => v * 0.86), a, a.map((v, i) => (v + b[i]) / 2), b].map(c => c.map(Math.round));
}
const WATER_PAL = [[92, 166, 176], [72, 142, 160], [52, 118, 143], [34, 96, 126]];
const FOAM = [226, 238, 232];

const Render = {
  canvas: null, overlay: null, octx: null, odpr: 1,
  W: 0, H: 0, dpr: 1, scale: 1,
  pix: 2,         // device pixels per art pixel
  T: 24,          // art pixels per tile
  k: 0.5,         // art pixels per world pixel
  LW: 0, LH: 0,   // layer size in art pixels
  ox: 0, oy: 0,   // world -> art pixel offset, whole pixels
  L: null, g: null,
  cam: { x: WORLD_PX / 2, y: WORLD_PX / 2 },
  shakeMag: 0, shakeX: 0, shakeY: 0,
  chunks: new Map(), chunkT: 0, CH: 10, frameNo: 0,
  base: null, wfield: null, world: null,
  mini: null, miniBase: null, miniT: 0,
  t: 0,
  snow: [],
  overlayUsed: false,
  spriteQueue: [],
  fresh: true,

  init(canvas, mini) {
    this.canvas = canvas;
    Pixel.init(canvas);
    this.overlay = document.getElementById('overlay');
    this.octx = this.overlay.getContext('2d');
    this.L = {};
    this.g = {};
    for (const name of PIXEL_LAYERS) {
      const c = document.createElement('canvas');
      this.L[name] = c;
      this.g[name] = c.getContext('2d');
    }
    this.mini = mini;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    for (let i = 0; i < 160; i++) this.snow.push({ x: Math.random(), y: Math.random(), s: rand(1, 3), v: rand(0.6, 1.2), p: Math.random() * TAU });
  },

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.W = window.innerWidth;
    this.H = window.innerHeight;
    const cw = Math.round(this.W * this.dpr), ch = Math.round(this.H * this.dpr);
    this.canvas.width = cw;
    this.canvas.height = ch;
    this.odpr = Math.min(this.dpr, 2);
    this.overlay.width = Math.round(this.W * this.odpr);
    this.overlay.height = Math.round(this.H * this.odpr);
    this.overlayUsed = true;
    // Art pixels are whole device pixels about 2 CSS px across, and a tile is a whole number of them.
    const want = clamp(Math.min(this.W, this.H) / 660, 0.56, 1.22);
    this.pix = Math.max(2, Math.round(this.dpr * 1.5), Math.round(this.dpr * want / 0.5));
    this.T = Math.max(12, Math.round(TILE * want * this.dpr / this.pix));
    this.k = this.T / TILE;
    this.scale = this.k * this.pix / this.dpr;
    this.LW = Math.ceil(cw / this.pix / 2) * 2;
    this.LH = Math.ceil(ch / this.pix / 2) * 2;
    for (const name of PIXEL_LAYERS) {
      const half = name === 'light' || name === 'warm';
      this.L[name].width = half ? this.LW / 2 : this.LW;
      this.L[name].height = half ? this.LH / 2 : this.LH;
    }
    if (this.T !== this.chunkT) { this.chunkT = this.T; this.chunks.clear(); this.fresh = true; }
    if (Sprites.k !== this.k) { Sprites.setScale(this.k); this.queueSprites(); }
  },

  // Every static sprite variant the world uses, to be made in spare frame time rather than on first sight.
  queueSprites() {
    const w = this.world;
    this.spriteQueue = [];
    if (!w) return;
    const seen = new Set();
    for (const n of w.nodeList) {
      const s = this.variant(n);
      let key = null, make = null;
      if (n.kind === 'tree') {
        const sp = n.species === 'pine' ? 'pine' : n.autumn ? 'autumn' : n.species;
        key = `t ${sp} ${n.v} ${s}`; make = () => Sprites.tree(sp, n.v, s);
      } else if (n.kind === 'rock') {
        const mossy = w.tiles[n.ty * w.N + n.tx] === T_FOREST;
        key = `r ${n.v} ${mossy} ${s} ${Math.round(n.size * 10)}`; make = () => Sprites.rock(n.v, mossy, s, n.size);
      } else if (n.kind === 'bush') {
        key = `b ${n.v} ${s}`; make = () => { Sprites.bush(n.v, true, s); Sprites.bush(n.v, false, s); };
      } else if (n.kind === 'grass') {
        key = `g ${n.v} ${s}`; make = () => { Sprites.grass(n.v, false, s); Sprites.grass(n.v, true, s); };
      }
      if (key && !seen.has(key)) { seen.add(key); this.spriteQueue.push(make); }
    }
  },

  setWorld(world) {
    this.world = world;
    this.chunks.clear();
    this.fresh = true;
    const N = world.N;
    // 1px-per-tile ground colours: the minimap, and a stand-in while a chunk is being painted.
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
    // Noise sampled on fixed grids (per tile: 2 for border warping, 6 for ground texture) so painting a chunk stays cheap.
    const grid = (res, seed, freq) => {
      const n = makeNoise(seed), M = N * res + 1, a = new Float32Array(M * M);
      for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) a[y * M + x] = n(x / res * freq, y / res * freq);
      return { a, M, res };
    };
    this.jx = grid(2, world.seed ^ 0x51, 0.9);
    this.jy = grid(2, world.seed ^ 0x93, 0.9);
    this.tex = grid(6, world.seed ^ 0x2f, 1.6);
    this.queueSprites();
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

  // CSS pixels <-> world pixels (uses the camera offset of the last frame drawn)
  worldToScreen(x, y) {
    const f = this.pix / this.dpr;
    return { x: (x * this.k + this.ox) * f, y: (y * this.k + this.oy) * f };
  },
  screenToWorld(sx, sy) {
    const f = this.pix / this.dpr;
    return { x: (sx / f - this.ox) / this.k, y: (sy / f - this.oy) / this.k };
  },
  shake(mag) { this.shakeMag = Math.max(this.shakeMag, mag); },

  // ---------- terrain chunks ----------
  // Returns a painted chunk canvas, or null while it is still being painted. Painting is spread over
  // frames a few rows at a time (runChunkJobs) so walking into new ground never stalls a frame.
  getChunk(cx, cy) {
    const key = cy * 100 + cx;
    const ch = this.chunks.get(key);
    if (ch) { ch.used = this.frameNo; return ch.c; }
    this.chunks.set(key, { c: null, job: this.chunkJob(cx, cy), used: this.frameNo });
    return null;
  },

  runChunkJobs(ms) {
    const end = performance.now() + ms;
    for (const ch of this.chunks.values()) {
      if (ch.c) continue;
      while (!ch.c && performance.now() < end) {
        const r = ch.job.next();
        if (r.done) { ch.c = r.value; ch.job = null; }
      }
      if (performance.now() >= end) break;
    }
    // spare time (a few ms at most) goes to making the sprites this world uses before they come into view
    const spriteEnd = Math.min(end, performance.now() + 4);
    while (this.spriteQueue.length && performance.now() < spriteEnd) this.spriteQueue.pop()();
    // forget the least recently seen chunks
    while (this.chunks.size > 48) {
      let oldK = null, oldU = Infinity;
      for (const [k, v] of this.chunks) if (v.used < oldU) { oldU = v.used; oldK = k; }
      if (oldU >= this.frameNo) break;
      this.chunks.delete(oldK);
    }
  },

  // Bilinear lookup in one of the noise grids, at a position in tile units.
  field(f, x, y) {
    const M = f.M, gx = clamp(x * f.res, 0, M - 1.001), gy = clamp(y * f.res, 0, M - 1.001);
    const ix = gx | 0, iy = gy | 0, ax = gx - ix, ay = gy - iy, i = iy * M + ix, a = f.a;
    return (a[i] * (1 - ax) + a[i + 1] * ax) * (1 - ay) + (a[i + M] * (1 - ax) + a[i + M + 1] * ax) * ay;
  },

  // Every pixel of the ground is worked out here: terrain shade with dithered biome borders, then water
  // in stepped depths with a foam line, then little pixel details (blades, flowers, pebbles, twigs).
  // A generator: it pauses every few rows, and returns the finished canvas.
  *chunkJob(cx, cy) {
    const w = this.world, N = w.N, CH = this.CH, T = this.T, size = CH * T;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const img = g.createImageData(size, size), d = img.data;
    const wet = new Uint8Array(size * size);
    const tx0 = cx * CH, ty0 = cy * CH, inv = 1 / T;
    const tiles = w.tiles, tone = w.tone, wf = this.wfield;
    const nearWater = this.chunkNearWater(tx0, ty0);
    const sm = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
    const bil = (arr, x, y) => {
      const ix = clamp(Math.floor(x), 0, N - 2), iy = clamp(Math.floor(y), 0, N - 2);
      const ax = clamp(x - ix, 0, 1), ay = clamp(y - iy, 0, 1), i = iy * N + ix;
      return (arr[i] * (1 - ax) + arr[i + 1] * ax) * (1 - ay) + (arr[i + N] * (1 - ax) + arr[i + N + 1] * ax) * ay;
    };
    for (let j = 0; j < size; j++) {
      const fy = ty0 + (j + 0.5) * inv, gy = ty0 * T + j;
      for (let i = 0; i < size; i++) {
        const fx = tx0 + (i + 0.5) * inv, gx = tx0 * T + i;
        const bay = BAYER4[(gy & 3) * 4 + (gx & 3)];
        // terrain under a gently warped point, so biome borders wander and break into dither
        const bx = clamp(Math.floor(fx + (this.field(this.jx, fx, fy) - 0.5) * 0.9 + (bay - 0.5) * 0.16), 0, N - 1);
        const by = clamp(Math.floor(fy + (this.field(this.jy, fx, fy) - 0.5) * 0.9 + (BAYER4[((gy + 2) & 3) * 4 + ((gx + 1) & 3)] - 0.5) * 0.16), 0, N - 1);
        let t = tiles[by * N + bx];
        if (t === T_WATER) t = T_SAND;
        const tv = (bil(tone, fx - 0.5, fy - 0.5) - 0.28) / 0.44;
        const tx = this.field(this.tex, fx, fy);
        const v = tv * 0.45 + tx * 0.95 - 0.2 + (bay - 0.5) * 0.14;
        let col = GROUND_PAL[t][v < 0.3 ? 0 : v < 0.55 ? 1 : v < 0.8 ? 2 : 3];
        if (nearWater) {
          const f = bil(wf, fx - 0.5, fy - 0.5) + (tx - 0.5) * 0.12 + (bay - 0.5) * 0.03;
          if (f >= 0.49) {
            const depth = sm(0.52, 0.95, f);
            col = WATER_PAL[clamp(Math.floor(depth * 3.6 + (bay - 0.5) * 0.7), 0, 3)];
            wet[j * size + i] = 2;
          } else if (f >= 0.445) { col = FOAM; wet[j * size + i] = 2; }
          else if (f >= 0.3) {
            col = [col[0] * 0.7 + 30, col[1] * 0.68 + 26, col[2] * 0.62 + 18];
            wet[j * size + i] = 1;
          }
        }
        const k = (j * size + i) * 4;
        d[k] = col[0]; d[k + 1] = col[1]; d[k + 2] = col[2]; d[k + 3] = 255;
      }
      if ((j & 3) === 3) yield;
    }
    // details, a few per tile, stamped as tiny pixel clusters
    const put = (x, y, col) => {
      if (x < 0 || y < 0 || x >= size || y >= size || wet[y * size + x]) return;
      const k = (y * size + x) * 4;
      d[k] = col[0]; d[k + 1] = col[1]; d[k + 2] = col[2];
    };
    const seed = w.seed;
    const FLOWERS = [[243, 236, 214], [242, 201, 76], [199, 162, 221], [236, 143, 143], [159, 197, 240]];
    for (let ty = ty0; ty < ty0 + CH; ty++) {
      for (let tx = tx0; tx < tx0 + CH; tx++) {
        const t = tiles[ty * N + tx];
        if (t === T_WATER) continue;
        const h = q => hash2(tx * 7 + q, ty * 13 - q * 3, seed);
        const X = (tx - tx0) * T, Y = (ty - ty0) * T;
        const at = q => [X + Math.floor(h(q) * T), Y + Math.floor(h(q + 20) * T)];
        const P = GROUND_PAL[t];
        if (t === T_GRASS) {
          for (let q = 0; q < 7; q++) {
            const [x, y] = at(q);
            const light = h(q + 40) < 0.55;
            const c1 = light ? [P[3][0] + 22, P[3][1] + 22, P[3][2] + 12] : P[0].map(v => v * 0.85);
            put(x, y, c1); put(x, y - 1, c1);
            if (h(q + 60) < 0.5) put(x + (h(q + 80) < 0.5 ? -1 : 1), y - 2, c1);
          }
          if (h(100) < 0.13) {
            const fc = FLOWERS[Math.floor(h(101) * FLOWERS.length)];
            const fx = X + 3 + Math.floor(h(102) * (T - 6)), fy = Y + 3 + Math.floor(h(103) * (T - 6));
            for (let q = 0; q < 3; q++) {
              const x = fx + Math.floor((h(110 + q) - 0.5) * 7), y = fy + Math.floor((h(120 + q) - 0.5) * 7);
              put(x - 1, y, fc); put(x + 1, y, fc); put(x, y - 1, fc); put(x, y + 1, fc); put(x, y, [250, 220, 90]);
            }
          }
        } else if (t === T_FOREST) {
          for (let q = 0; q < 5; q++) {
            const [x, y] = at(q);
            const c1 = h(q + 40) < 0.6 ? [104, 78, 44] : [70, 110, 52];
            put(x, y, c1); put(x + 1, y + (h(q + 50) < 0.5 ? 0 : 1), c1);
          }
          if (h(104) < 0.07) {
            const [x, y] = at(105);
            const fern = [94, 154, 74];
            for (let q = -2; q <= 2; q++) { put(x + q, y, fern); put(x, y + q, fern); }
            put(x - 2, y - 2, fern); put(x + 2, y + 2, fern); put(x + 2, y - 2, fern); put(x - 2, y + 2, fern);
          }
          if (h(108) < 0.03) {
            const [x, y] = at(109);
            const cap = [199, 64, 47];
            put(x, y + 1, [239, 230, 208]);
            for (const [a, b] of [[-1, 0], [0, 0], [1, 0], [0, -1], [-1, -1], [1, -1]]) put(x + a, y + b, cap);
            put(x, y - 1, [255, 255, 255]);
          }
        } else if (t === T_ROCKY) {
          for (let q = 0; q < 4; q++) {
            const [x, y] = at(q);
            put(x + 1, y, [104, 104, 98]); put(x, y + 1, [96, 96, 90]); put(x + 1, y + 1, [86, 86, 80]);
            put(x, y, [176, 176, 166]);
          }
          if (h(100) < 0.2) {
            const [x, y] = at(101);
            for (let q = 0; q < 4; q++) put(x + q, y + (q >> 1), [92, 90, 78]);
          }
        } else if (t === T_SAND) {
          for (let q = 0; q < 7; q++) {
            const [x, y] = at(q);
            put(x, y, h(q + 50) < 0.5 ? [168, 144, 98] : [240, 228, 186]);
          }
        }
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  },

  chunkNearWater(tx0, ty0) {
    const w = this.world;
    for (let ty = ty0 - 2; ty < ty0 + this.CH + 2; ty++) {
      for (let tx = tx0 - 2; tx < tx0 + this.CH + 2; tx++) if (w.inBounds(tx, ty) && w.tiles[ty * w.N + tx] === T_WATER) return true;
    }
    return false;
  },

  // ---------- pixel helpers ----------
  // Blit a pixel sprite centred on a world point, snapped to whole art pixels. ctx keeps its world transform.
  blit(ctx, spr, x, y, s = 1) {
    const w = Math.round(spr.w * s), h = Math.round(spr.h * s);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(spr.c, Math.round(x * this.k + this.ox - w / 2), Math.round(y * this.k + this.oy - h / 2), w, h);
    ctx.setTransform(this.k, 0, 0, this.k, this.ox, this.oy);
  },

  // A filled ellipse made of whole-pixel rows (crisp shadows on the ground layer, which is not post-processed).
  pxEllipse(g, x, y, rx, ry) {
    const k = this.k, cx = x * k + this.ox, cy = y * k + this.oy, a = rx * k, b = ry * k;
    for (let py = Math.ceil(cy - b - 0.5); py <= Math.floor(cy + b - 0.5); py++) {
      const dy = (py + 0.5 - cy) / b, s = 1 - dy * dy;
      if (s <= 0) continue;
      const half = a * Math.sqrt(s), x0 = Math.round(cx - half), x1 = Math.round(cx + half);
      if (x1 > x0) g.fillRect(x0, py, x1 - x0, 1);
    }
  },

  variant(n) { return Math.floor((((n.rot || 0) % TAU + TAU) % TAU) / TAU * 3) % 3; },

  // ---------- main frame ----------
  frame(S, dt) {
    const w = this.world, G = this.g, k = this.k;
    this.t += dt;
    this.frameNo++;
    const t = this.t;
    // camera shake
    if (this.shakeMag > 0.1) {
      this.shakeX = (Math.random() - 0.5) * this.shakeMag * 2;
      this.shakeY = (Math.random() - 0.5) * this.shakeMag * 2;
      this.shakeMag *= Math.exp(-dt * 14);
    } else { this.shakeX = this.shakeY = 0; this.shakeMag = 0; }
    const f = this.pix / this.dpr;
    const ox = this.ox = Math.round(this.LW / 2 - this.cam.x * k + this.shakeX / f);
    const oy = this.oy = Math.round(this.LH / 2 - this.cam.y * k + this.shakeY / f);
    const LW = this.LW, LH = this.LH;

    const vx0 = -ox / k - 60, vx1 = (LW - ox) / k + 60;
    const vy0 = -oy / k - 60, vy1 = (LH - oy) / k + 80;
    this.view = { x0: vx0, y0: vy0, x1: vx1, y1: vy1 };

    // ground layer: terrain chunks at whole-pixel offsets
    const g0 = G.ground;
    g0.setTransform(1, 0, 0, 1, 0, 0);
    g0.imageSmoothingEnabled = false;
    g0.fillStyle = '#1d3326';
    g0.fillRect(0, 0, LW, LH);
    const csz = this.CH * this.T, cwor = this.CH * TILE, last = Math.ceil(WORLD_N / this.CH) - 1;
    const cx0 = Math.max(0, Math.floor(vx0 / cwor)), cx1 = Math.min(last, Math.floor(vx1 / cwor));
    const cy0 = Math.max(0, Math.floor(vy0 / cwor)), cy1 = Math.min(last, Math.floor(vy1 / cwor));
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) this.getChunk(cx, cy);
    // start on the ring just outside the view too, so it is ready before you get there
    for (let cy = Math.max(0, cy0 - 1); cy <= Math.min(last, cy1 + 1); cy++) {
      for (let cx = Math.max(0, cx0 - 1); cx <= Math.min(last, cx1 + 1); cx++) this.getChunk(cx, cy);
    }
    // a fresh view (new world, resized window) paints in one go; after that a few ms a frame
    this.runChunkJobs(this.fresh ? 2000 : 4);
    this.fresh = false;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = this.chunks.get(cy * 100 + cx).c;
        if (c) g0.drawImage(c, cx * csz + ox, cy * csz + oy);
        else g0.drawImage(this.base, cx * this.CH, cy * this.CH, this.CH, this.CH, cx * csz + ox, cy * csz + oy, csz, csz);
      }
    }
    this.waterShimmer(g0, t);

    // the other layers start clear, in world coordinates
    for (const name of ['objs', 'fx', 'ui']) {
      const c = G[name];
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, LW, LH);
      c.setTransform(k, 0, 0, k, ox, oy);
      c.imageSmoothingEnabled = false;
      c.lineCap = 'round';
      c.lineJoin = 'round';
      c.globalAlpha = 1;
    }
    const ctx = G.objs;
    Draw.fxc = G.fx;
    Draw.uic = G.ui;

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
          if (n.kind === 'grass') this.blit(g0, Sprites.grass(n.v, n.amt <= 0, this.variant(n)), n.x, n.y);
          else if (n.kind === 'stump') this.blit(ctx, Sprites.stump(this.variant(n)), n.x, n.y);
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
    // pass 2: shadows, in whole pixels on the ground layer
    g0.setTransform(1, 0, 0, 1, 0, 0);
    g0.fillStyle = `rgba(12,24,14,${shadowA})`;
    for (const o of standing) {
      if (o.kind === 'tree') { const R = this.treeR(o); this.pxEllipse(g0, o.x + R * 0.28, o.y + R * 0.36, R * 0.95, R * 0.8); }
      else if (o.kind === 'rock') this.pxEllipse(g0, o.x + 4, o.y + 6, 19 * o.size, 15 * o.size);
      else if (o.kind === 'bush') this.pxEllipse(g0, o.x + 3, o.y + 5, 15, 12);
      else if (o.type === 'torch') this.pxEllipse(g0, o.x + 3, o.y + 5, 8, 6);
      else if (o.type && o.type !== 'campfire') g0.fillRect(Math.round((o.x - TILE / 2 + 6) * k + ox), Math.round((o.y - TILE / 2 + 8) * k + oy), this.T, this.T - 1);
    }
    // drops
    for (const d of S.drops) {
      if (d.x < vx0 || d.x > vx1 || d.y < vy0 || d.y > vy1) continue;
      g0.fillStyle = `rgba(12,24,14,${shadowA * 0.9})`;
      this.pxEllipse(g0, d.x, d.y + 6, 8, 3.5);
      Draw.drop(ctx, d, t);
    }
    // creatures & player
    for (const c of S.creatures) {
      if (c.x < vx0 - 40 || c.x > vx1 + 40 || c.y < vy0 - 40 || c.y > vy1 + 40) continue;
      if (c.type === 'fish') { Draw.creature(G.fx, c, t); continue; }
      const r = CREATURES[c.type].r;
      g0.fillStyle = `rgba(12,24,14,${shadowA})`;
      this.pxEllipse(g0, c.x + 3, c.y + 5, r * 1.1, r * 0.8);
      sorted.push({ y: c.y, k: 4, o: c });
    }
    if (p && !p.hidden) {
      g0.fillStyle = `rgba(12,24,14,${shadowA})`;
      this.pxEllipse(g0, p.x + 3, p.y + 5, 14, 11);
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
          this.blit(ctx, Sprites.rock(o.v, w.tiles[o.ty * w.N + o.tx] === T_FOREST, this.variant(o), o.size), o.x + sh, o.y);
        } else {
          const sh = o.shake > 0 ? Math.sin(t * 50) * o.shake * 5 : 0;
          this.blit(ctx, Sprites.bush(o.v, !!o.ripe, this.variant(o)), o.x + sh, o.y);
        }
      } else if (e.k === 3) Draw.structure(ctx, o, t, w);
      else if (e.k === 4) Draw.creature(o.spawnT > 0 ? G.fx : ctx, o, t);
      else if (e.k === 5) Draw.player(ctx, o, t, S);
    }
    // projectiles, fishing line
    for (const a of S.arrows) Draw.arrow(ctx, a);
    if (S.fishing) Draw.fishing(ctx, S.fishing, p, t);
    // canopies
    for (const n of canopies) this.drawCanopy(ctx, n, p, t, dt);
    // particles below light
    Draw.particles(ctx, S.particles, false, vx0, vy0, vx1, vy1);

    // ---------- lighting ----------
    const lit = night > 0.01;
    if (lit) this.lighting(S, night);

    // above the darkness: glowing things and in-world UI
    Draw.particles(G.ui, S.particles, true, vx0, vy0, vx1, vy1);
    if (night > 0.25) Draw.eyes(G.ui, S.creatures, night, t, vx0, vy0, vx1, vy1);
    Draw.worldUI(G.ui, S, t);
    if (S.snow > 0.01) this.drawSnow(G.ui, S.snow, dt);

    Pixel.present(this.L, this.pix, lit, this.washColor());
    this.drawOverlay(S);
  },

  washColor() {
    const s = Game.skyWash();
    if (!s) return [0, 0, 0, 0];
    const m = s.match(/[\d.]+/g);
    return m ? m.slice(0, 4).map(Number) : [0, 0, 0, 0];
  },

  // Floating text sits on a full-resolution canvas above the pixel view, in a pixel font.
  drawOverlay(S) {
    const o = this.octx;
    if (!S.texts.length && !this.overlayUsed) return;
    o.setTransform(1, 0, 0, 1, 0, 0);
    o.clearRect(0, 0, this.overlay.width, this.overlay.height);
    this.overlayUsed = S.texts.length > 0;
    if (!this.overlayUsed) return;
    o.setTransform(this.odpr, 0, 0, this.odpr, 0, 0);
    Draw.texts(o, S.texts);
  },

  treeR(n) {
    const base = n.species === 'birch' ? [28, 31, 34] : [34, 38, 42];
    return base[n.v];
  },

  drawCanopy(ctx, n, p, t, dt) {
    const sp = n.species === 'pine' ? 'pine' : n.autumn ? 'autumn' : n.species;
    const spr = Sprites.tree(sp, n.v, this.variant(n));
    const R = this.treeR(n);
    let target = 1;
    if (p && !p.hidden && dist2(p.x, p.y, n.x, n.y) < (R + 8) * (R + 8)) target = 0.38;
    n.fade = n.fade == null ? target : lerp(n.fade, target, damp(10, dt));
    if (n.grow > 0) n.grow = Math.max(0, n.grow - dt * 1.4);
    const grow = 1 - (n.grow || 0) * 0.7;
    // wind nudges the crown a pixel now and then; a hit shakes it
    const sway = Math.round(Math.sin(t * 1.1 + n.rot * 3) * 0.7) / this.k;
    const sh = n.shake > 0 ? Math.sin(t * 55) * n.shake * 7 : 0;
    const g = n.fade < 0.97 ? Draw.fxc : ctx;
    g.globalAlpha = n.fade;
    this.blit(g, spr, n.x + sh + sway, n.y - 4, grow);
    g.globalAlpha = 1;
  },

  // Little light dashes drifting over open water.
  waterShimmer(g, t) {
    const w = this.world, v = this.view, k = this.k;
    const tx0 = Math.max(0, Math.floor(v.x0 / TILE)), tx1 = Math.min(w.N - 1, Math.floor(v.x1 / TILE));
    const ty0 = Math.max(0, Math.floor(v.y0 / TILE)), ty1 = Math.min(w.N - 1, Math.floor(v.y1 / TILE));
    g.fillStyle = '#cfe9ec';
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        if (w.tiles[ty * w.N + tx] !== T_WATER || this.wfield[ty * w.N + tx] < 0.75) continue;
        const h = hash2(tx, ty, 99);
        const ph = (t * 0.35 + h) % 1;
        const a = Math.sin(ph * Math.PI);
        if (a < 0.3) continue;
        const x = Math.round((tx * TILE + 10 + h * 26 + ph * 8) * k + this.ox), y = Math.round((ty * TILE + 12 + hash2(ty, tx, 7) * 24) * k + this.oy);
        const len = a > 0.75 ? 4 : 2;
        g.fillRect(x, y, len, 1);
        if (a > 0.85) g.fillRect(x + 1, y - 1, len - 2, 1);
      }
    }
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

  // Darkness (rgb: night tint, a: how dark) and warm firelight, both at half the art resolution.
  // The compositor steps and dithers them.
  lighting(S, night) {
    const lc = this.g.light, wc = this.g.warm;
    const lw = this.L.light.width, lh = this.L.light.height;
    const k = this.k / 2, ox = this.ox / 2, oy = this.oy / 2;
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.globalCompositeOperation = 'source-over';
    lc.clearRect(0, 0, lw, lh);
    const tint = Game.ambientTint();
    lc.fillStyle = `rgba(${tint[0]},${tint[1]},${tint[2]},${night})`;
    lc.fillRect(0, 0, lw, lh);
    lc.globalCompositeOperation = 'destination-out';
    const lights = this.lights(S);
    for (const L of lights) {
      const x = L.x * k + ox, y = L.y * k + oy, r = L.r * k;
      if (x < -r || y < -r || x > lw + r || y > lh + r) continue;
      const g = lc.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(0,0,0,${L.i})`);
      g.addColorStop(0.55, `rgba(0,0,0,${L.i * 0.75})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      lc.fillStyle = g;
      lc.fillRect(x - r, y - r, r * 2, r * 2);
    }
    lc.globalCompositeOperation = 'source-over';
    wc.setTransform(1, 0, 0, 1, 0, 0);
    wc.globalCompositeOperation = 'source-over';
    wc.clearRect(0, 0, lw, lh);
    wc.globalCompositeOperation = 'lighter';
    for (const L of lights) {
      if (!L.fire && !L.torch) continue;
      const x = L.x * k + ox, y = L.y * k + oy, r = L.r * k * 0.75;
      const g = wc.createRadialGradient(x, y, 0, x, y, r);
      const a = (L.fire ? 0.24 : 0.16) * night;
      g.addColorStop(0, `rgba(255,150,60,${a})`);
      g.addColorStop(1, 'rgba(255,90,20,0)');
      wc.fillStyle = g;
      wc.fillRect(x - r, y - r, r * 2, r * 2);
    }
    wc.globalCompositeOperation = 'source-over';
  },

  drawSnow(g, amount, dt) {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#f5f8ff';
    const n = Math.floor(this.snow.length * amount);
    for (let i = 0; i < n; i++) {
      const f = this.snow[i];
      f.y += dt * f.v * 0.09 * (1 + f.s * 0.3);
      f.x += dt * (0.02 + Math.sin(this.t * 0.8 + f.p) * 0.02);
      if (f.y > 1.02) { f.y = -0.02; f.x = Math.random(); }
      if (f.x > 1.02) f.x = -0.02;
      const s = f.s > 2.2 ? 2 : 1;
      g.fillRect(Math.floor(f.x * this.LW), Math.floor(f.y * this.LH), s, s);
    }
    g.setTransform(this.k, 0, 0, this.k, this.ox, this.oy);
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
  fxc: null,      // dithered see-through layer (set each frame by Render)
  uic: null,      // in-world UI layer above the darkness
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
      if (S.fishing && !swinging) ({ hx, hy, ang } = this.rodPose(S.fishing, t));
      if (swinging) {
        const k = ease.outCubic(1 - p.swingT / 0.18);
        const side = p.swingSide;
        ang = lerp(side * 1.5, -side * 1.05, k);
        hx = Math.cos(ang) * 13; hy = Math.sin(ang) * 13;
        const w = MELEE[p.swingWeapon] || MELEE.fist;
        const fx = this.fxc || ctx;
        fx.save();
        fx.setTransform(ctx.getTransform());
        fx.strokeStyle = this.flash ? '#fff' : 'rgba(255,255,255,0.45)';
        fx.lineWidth = 5;
        fx.beginPath();
        const a0 = side * 1.5, a1 = ang;
        fx.arc(0, 0, w.reach * 0.85, Math.min(a0, a1), Math.max(a0, a1));
        fx.stroke();
        fx.restore();
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

  // Where the hand holds the rod while fishing (player space, +x is forward). The rod jerks on a bite
  // and swings up as the catch comes out.
  rodPose(f, t) {
    let ang = -0.12;
    if (f.phase === 'bite') ang += Math.sin(t * 45) * 0.12;
    if (f.phase === 'catch') ang -= 0.6 * Math.sin(Math.min(1, f.t / 0.45) * Math.PI);
    return { hx: 10, hy: 7, ang };
  },
  rodTip(p, f, t) {
    const { hx, hy, ang } = this.rodPose(f, t);
    const lx = hx + Math.cos(ang) * 34, ly = hy + Math.sin(ang) * 34;
    const c = Math.cos(p.aim), s = Math.sin(p.aim);
    return { x: p.x + c * lx - s * ly, y: p.y + s * lx + c * ly };
  },

  // Line, float and the catch on its way out of the water.
  fishing(ctx, f, p, t) {
    const tip = this.rodTip(p, f, t);
    let bx = f.x, by = f.y;
    if (f.phase === 'catch') {
      const k = Math.min(1, f.t / 0.45);
      bx = lerp(f.cx, p.x, k);
      by = lerp(f.cy, p.y, k) - Math.sin(k * Math.PI) * 40;
    }
    const taut = f.phase !== 'wait' && f.phase !== 'nibble';
    const fx = this.fxc || ctx;
    fx.strokeStyle = '#ece8dc';
    fx.lineWidth = 1 / Render.k;
    fx.beginPath();
    fx.moveTo(tip.x, tip.y);
    fx.quadraticCurveTo((tip.x + bx) / 2, (tip.y + by) / 2 + (taut ? 0 : 10), bx, by);
    fx.stroke();
    if (f.phase === 'catch') {
      Render.blit(ctx, Sprites.worldIcon(f.catch === 'crate' ? 'crate' : 'fish'), bx, by, f.catch === 'big' ? 1.4 : 1);
      return;
    }
    if (f.phase === 'bite') {
      ctx.fillStyle = '#1d4f66';
      ellipse(ctx, f.x, f.y + 1, 5, 3);
      return;
    }
    const dip = f.phase === 'nibble' ? 2.5 : Math.sin(t * 3.2) * 0.8;
    ctx.fillStyle = '#f1ece0';
    circle(ctx, f.x, f.y + dip, 4);
    ctx.fillStyle = '#d8402f';
    ctx.beginPath(); ctx.arc(f.x, f.y + dip, 4, Math.PI, TAU); ctx.fill();
  },

  // Drawn at the hand, pointing along +x.
  tool(ctx, tool) {
    if (!tool || tool === 'fist') return;
    if (tool === 'rod') {
      ctx.strokeStyle = this.col('#6e4726'); ctx.lineWidth = 2.6;
      ctx.beginPath(); ctx.moveTo(-4, 0); ctx.lineTo(34, 0); ctx.stroke();
      ctx.strokeStyle = this.col('#c9a66a'); ctx.lineWidth = 3.6;
      ctx.beginPath(); ctx.moveTo(-4, 0); ctx.lineTo(6, 0); ctx.stroke();
      ctx.fillStyle = this.col('#8c9196'); circle(ctx, 3, 4, 2.8);
      return;
    }
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
    if (s.flash > 0 && !icon && this.fxc) {
      this.fxc.fillStyle = `rgba(255,255,255,${s.flash * 2.5})`;
      this.fxc.fillRect(x - TILE / 2, y - TILE / 2, TILE, TILE);
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

  drop(ctx, d, t) {
    const bob = d.z > 0 ? 0 : Math.sin(t * 3 + d.seed) * 1.5;
    const s = d.t < 0.15 ? 0.6 + d.t * 2.6 : 1;
    Render.blit(ctx, Sprites.worldIcon(d.item), d.x, d.y - d.z - 4 + bob, s);
  },

  arrow(ctx, a) {
    const ang = Math.atan2(a.vy, a.vx);
    ctx.save();
    ctx.translate(a.x, a.y);
    ctx.rotate(ang);
    if (this.fxc) {
      const fx = this.fxc;
      fx.save();
      fx.setTransform(ctx.getTransform());
      fx.strokeStyle = 'rgba(255,255,255,0.3)'; fx.lineWidth = 3;
      fx.beginPath(); fx.moveTo(-34, 0); fx.lineTo(-14, 0); fx.stroke();
      fx.restore();
    }
    ctx.strokeStyle = '#a77a45'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-14, 0); ctx.lineTo(8, 0); ctx.stroke();
    ctx.fillStyle = '#8c9196';
    ctx.beginPath(); ctx.moveTo(13, 0); ctx.lineTo(6, -3.5); ctx.lineTo(6, 3.5); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#efe9da';
    ctx.beginPath(); ctx.moveTo(-10, 0); ctx.lineTo(-16, -4); ctx.lineTo(-14, 0); ctx.lineTo(-16, 4); ctx.closePath(); ctx.fill();
    ctx.restore();
  },

  particles(ctx, list, glow, x0, y0, x1, y1) {
    const fx = glow ? ctx : (this.fxc || ctx);
    for (const q of list) {
      if (!!q.glow !== glow) continue;
      if (q.x < x0 || q.x > x1 || q.y < y0 || q.y > y1) continue;
      const k = q.life / q.max;
      if (q.type === 'smoke') {
        fx.fillStyle = `rgba(${q.c},${0.32 * k})`;
        circle(fx, q.x, q.y, q.size * (1.8 - k));
      } else if (q.type === 'ring') {
        fx.strokeStyle = `rgba(${q.c},${k * 0.9})`;
        fx.lineWidth = Math.max(2, 4 * k);
        fx.beginPath(); fx.arc(q.x, q.y, q.size * (1 - k) + 4, 0, TAU); fx.stroke();
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
    if (it && Game.mode === 'play' && !S.build && it.kind !== 'reel') {
      ctx.strokeStyle = `rgba(255,236,190,${0.5 + Math.sin(t * 6) * 0.25})`;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 5]);
      ctx.beginPath(); ctx.arc(it.x, it.y, 30, 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
    }
    // a bite: "!" over the float
    const f = S.fishing;
    if (f && f.phase === 'bite') {
      const x = Math.round(f.x * Render.k + Render.ox);
      const y = Math.round((f.y - 16) * Render.k + Render.oy) - Math.round(Math.abs(Math.sin(t * 14)) * 2);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#1a120a'; ctx.fillRect(x - 2, y - 9, 4, 11);
      ctx.fillStyle = '#ffd34a'; ctx.fillRect(x - 1, y - 8, 2, 6); ctx.fillRect(x - 1, y - 1, 2, 2);
      ctx.setTransform(Render.k, 0, 0, Render.k, Render.ox, Render.oy);
    }
    // cooking progress
    if (S.cook && S.cook.fire && S.cook.t > 0) {
      const f = S.cook.fire;
      ctx.strokeStyle = 'rgba(10,10,10,0.5)'; ctx.lineWidth = 5;
      ctx.beginPath(); ctx.arc(f.x, f.y - 38, 9, 0, TAU); ctx.stroke();
      ctx.strokeStyle = '#ffc56a'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(f.x, f.y - 38, 9, -Math.PI / 2, -Math.PI / 2 + TAU * (S.cook.t / FIRE.cookTime)); ctx.stroke();
      Render.blit(ctx, Sprites.worldIcon(S.cook.item), f.x, f.y - 38);
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
      ctx.font = `${Math.round(tx.size * 1.3 * pop)}px "Tiny5", "Courier New", monospace`;
      ctx.lineWidth = 4;
      ctx.lineJoin = 'miter';
      ctx.strokeStyle = '#0c120e';
      ctx.strokeText(tx.text, sp.x, sp.y);
      ctx.fillStyle = tx.color;
      ctx.fillText(tx.text, sp.x, sp.y);
    }
    ctx.globalAlpha = 1;
  },
};
