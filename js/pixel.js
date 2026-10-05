'use strict';
// Pixel-art presentation. The world is drawn at a low "art" resolution into a few layers, then one small
// WebGL pass scales it up with hard square pixels: solid objects get crisp edges and a dark outline,
// see-through things and the night light fall off in ordered dither. Without WebGL the layers are simply
// stacked and scaled up.

// 4x4 ordered-dither thresholds in 0..1, row-major.
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + 0.5) / 16);
const bayerAt = (x, y) => BAYER4[(y & 3) * 4 + (x & 3)];

const PIXEL_VS = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const PIXEL_FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uGround, uObjs, uFx, uUi, uLight, uWarm;
uniform vec2 uLow;     // layer size in art pixels
uniform float uPix;    // device pixels per art pixel
uniform float uH;      // canvas height in device pixels
uniform float uNight;  // 1 while the light layers are in use
uniform vec4 uWash;    // colour wash over the whole scene

float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer4(vec2 a) { a = mod(a, 4.0); return bayer2(0.5 * a) * 0.25 + bayer2(a); }

void main() {
  vec2 lp = floor(vec2(gl_FragCoord.x, uH - gl_FragCoord.y) / uPix);
  vec2 px = 1.0 / uLow;
  vec2 uv = (lp + 0.5) * px;
  float th = bayer4(lp) + 0.03125;
  vec3 col = texture2D(uGround, uv).rgb;
  // solid objects: hard edge, and a dark outline one pixel outside
  vec4 o = texture2D(uObjs, uv);
  if (o.a >= 0.5) col = o.rgb;
  else {
    vec4 n = texture2D(uObjs, uv + vec2(px.x, 0.0));
    vec4 m = texture2D(uObjs, uv - vec2(px.x, 0.0)); if (m.a > n.a) n = m;
    m = texture2D(uObjs, uv + vec2(0.0, px.y)); if (m.a > n.a) n = m;
    m = texture2D(uObjs, uv - vec2(0.0, px.y)); if (m.a > n.a) n = m;
    if (n.a >= 0.5) col = n.rgb * 0.28 + vec3(0.03, 0.035, 0.05);
  }
  // see-through things: dithered
  vec4 f = texture2D(uFx, uv);
  if (f.a > th) col = f.rgb;
  // night: stepped, dithered darkness and warm firelight
  if (uNight > 0.5) {
    vec4 L = texture2D(uLight, uv);
    col = mix(col, L.rgb, floor(L.a * 8.0 + th) / 8.0);
    vec4 W = texture2D(uWarm, uv);
    col += W.rgb * (floor(W.a * 5.0 + th) / 5.0);
  }
  col = mix(col, uWash.rgb, uWash.a);
  vec4 u = texture2D(uUi, uv);
  if (u.a > th) col = u.rgb;
  gl_FragColor = vec4(col, 1.0);
}`;

const PIXEL_LAYERS = ['ground', 'objs', 'fx', 'ui', 'light', 'warm'];

const Pixel = {
  canvas: null, gl: null, ctx2d: null, comp: null, prog: null, tex: {}, loc: {},

  init(canvas) {
    this.canvas = canvas;
    let gl = null;
    try {
      gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
    } catch (e) { gl = null; }
    if (gl && this.setupGL(gl)) {
      this.gl = gl;
      canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); this.lost = true; });
      canvas.addEventListener('webglcontextrestored', () => { this.lost = !this.setupGL(gl); });
    } else {
      this.ctx2d = canvas.getContext('2d');
      this.comp = document.createElement('canvas');
    }
  },

  setupGL(gl) {
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.error(gl.getShaderInfoLog(s)); return null; }
      return s;
    };
    const vs = sh(gl.VERTEX_SHADER, PIXEL_VS), fs = sh(gl.FRAGMENT_SHADER, PIXEL_FS);
    if (!vs || !fs) return false;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.error(gl.getProgramInfoLog(prog)); return false; }
    gl.useProgram(prog);
    this.prog = prog;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    for (const k of ['uLow', 'uPix', 'uH', 'uNight', 'uWash']) this.loc[k] = gl.getUniformLocation(prog, k);
    this.tex = {};
    PIXEL_LAYERS.forEach((name, i) => {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, t);
      const filter = name === 'light' || name === 'warm' ? gl.LINEAR : gl.NEAREST;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(gl.getUniformLocation(prog, 'u' + name[0].toUpperCase() + name.slice(1)), i);
      this.tex[name] = { t, unit: i, w: 0, h: 0 };
    });
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    return true;
  },

  upload(name, src) {
    const gl = this.gl, T = this.tex[name];
    gl.activeTexture(gl.TEXTURE0 + T.unit);
    gl.bindTexture(gl.TEXTURE_2D, T.t);
    if (T.w !== src.width || T.h !== src.height) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      T.w = src.width; T.h = src.height;
    } else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, src);
  },

  // L: { ground, objs, fx, ui, light, warm } canvases; night: whether light/warm hold anything; wash: [r,g,b,a] 0..255/0..1
  present(L, pix, night, wash) {
    const c = this.canvas;
    if (this.gl) {
      if (this.lost) return;
      const gl = this.gl;
      this.upload('ground', L.ground);
      this.upload('objs', L.objs);
      this.upload('fx', L.fx);
      this.upload('ui', L.ui);
      if (night) { this.upload('light', L.light); this.upload('warm', L.warm); }
      gl.viewport(0, 0, c.width, c.height);
      gl.uniform2f(this.loc.uLow, L.ground.width, L.ground.height);
      gl.uniform1f(this.loc.uPix, pix);
      gl.uniform1f(this.loc.uH, c.height);
      gl.uniform1f(this.loc.uNight, night ? 1 : 0);
      gl.uniform4f(this.loc.uWash, wash[0] / 255, wash[1] / 255, wash[2] / 255, wash[3]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return;
    }
    // plain canvas fallback: stack the layers, then scale up without smoothing
    const comp = this.comp, w = L.ground.width, h = L.ground.height;
    if (comp.width !== w || comp.height !== h) { comp.width = w; comp.height = h; }
    const g = comp.getContext('2d');
    g.globalCompositeOperation = 'source-over';
    g.drawImage(L.ground, 0, 0);
    g.drawImage(L.objs, 0, 0);
    g.drawImage(L.fx, 0, 0);
    if (night) {
      g.imageSmoothingEnabled = true;
      g.drawImage(L.light, 0, 0, w, h);
      g.globalCompositeOperation = 'lighter';
      g.drawImage(L.warm, 0, 0, w, h);
      g.globalCompositeOperation = 'source-over';
    }
    if (wash[3] > 0) { g.fillStyle = `rgba(${wash[0]},${wash[1]},${wash[2]},${wash[3]})`; g.fillRect(0, 0, w, h); }
    g.drawImage(L.ui, 0, 0);
    const ctx = this.ctx2d;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(comp, 0, 0, w * pix, h * pix);
  },
};

// Turns a sprite painted with smooth shapes into pixel art, in place: hard alpha, a small palette,
// light from the top left (bright rim, dithered shade toward the bottom right) and an optional outline.
const Pixelize = {
  process(c, opts = {}) {
    const w = c.width, h = c.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    const img = g.getImageData(0, 0, w, h), d = img.data, n = w * h;
    const A = new Uint8Array(n);
    for (let i = 0; i < n; i++) A[i] = d[i * 4 + 3] >= 110 ? 1 : 0;
    if (opts.colors !== 0) this.quantize(d, A, opts.colors || 7);
    const on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && A[y * w + x] === 1;
    if (opts.shade !== false) {
      // bounding box centre for the broad shading
      let x0 = w, y0 = h, x1 = 0, y1 = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (A[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, span = Math.max(4, (x1 - x0) + (y1 - y0));
      const out = new Uint8ClampedArray(d);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (!A[i]) continue;
          const lit = !on(x - 1, y) || !on(x, y - 1);
          const dark = !on(x + 1, y) || !on(x, y + 1) || !on(x + 1, y + 1);
          const t = ((x - cx) + (y - cy)) / span + (bayerAt(x, y) - 0.5) * 0.18;
          let k = 0;
          if (lit && !dark) k = 1;
          else if (dark && !lit) k = -1;
          else if (t > 0.2) k = -1;
          else if (t < -0.28) k = 0.5;
          if (!k) continue;
          const j = i * 4;
          if (k > 0) {
            out[j] = d[j] * (1 + 0.16 * k) + 14 * k; out[j + 1] = d[j + 1] * (1 + 0.16 * k) + 12 * k; out[j + 2] = d[j + 2] * (1 + 0.08 * k) + 4 * k;
          } else {
            out[j] = d[j] * 0.7; out[j + 1] = d[j + 1] * 0.74; out[j + 2] = d[j + 2] * 0.82 + 8;
          }
        }
      }
      d.set(out);
    }
    if (opts.outline) {
      const src = new Uint8ClampedArray(d);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (A[i]) continue;
          let nb = -1;
          if (on(x - 1, y)) nb = i - 1; else if (on(x + 1, y)) nb = i + 1; else if (on(x, y - 1)) nb = i - w; else if (on(x, y + 1)) nb = i + w;
          if (nb < 0) continue;
          const j = i * 4, s = nb * 4;
          d[j] = src[s] * 0.28 + 8; d[j + 1] = src[s + 1] * 0.28 + 9; d[j + 2] = src[s + 2] * 0.28 + 13; d[j + 3] = 255;
          A[i] = 2;
        }
      }
    }
    for (let i = 0; i < n; i++) if (A[i] !== 2) d[i * 4 + 3] = A[i] ? 255 : 0;
    g.putImageData(img, 0, 0);
    return c;
  },

  // Snap every opaque pixel to the sprite's own most common colours (drops the in-between edge colours).
  quantize(d, A, max) {
    const buckets = new Map();
    for (let i = 0; i < A.length; i++) {
      if (!A[i]) continue;
      const j = i * 4;
      const key = (d[j] >> 3) << 10 | (d[j + 1] >> 3) << 5 | (d[j + 2] >> 3);
      let b = buckets.get(key);
      if (!b) { b = [0, 0, 0, 0]; buckets.set(key, b); }
      b[0]++; b[1] += d[j]; b[2] += d[j + 1]; b[3] += d[j + 2];
    }
    const sorted = [...buckets.values()].sort((a, b) => b[0] - a[0]);
    const pal = [];
    for (const b of sorted) {
      const c = [b[1] / b[0], b[2] / b[0], b[3] / b[0]];
      if (pal.every(p => (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2 > 22 * 22)) pal.push(c);
      if (pal.length >= max) break;
    }
    if (!pal.length) return;
    for (let i = 0; i < A.length; i++) {
      if (!A[i]) continue;
      const j = i * 4;
      let best = pal[0], bd = Infinity;
      for (const p of pal) {
        const e = (p[0] - d[j]) ** 2 + (p[1] - d[j + 1]) ** 2 + (p[2] - d[j + 2]) ** 2;
        if (e < bd) { bd = e; best = p; }
      }
      d[j] = best[0]; d[j + 1] = best[1]; d[j + 2] = best[2];
    }
  },
};
