'use strict';
// Terrain, resource nodes (trees, rocks, bushes, grass) and tile-based collision.

const T_GRASS = 0, T_FOREST = 1, T_ROCKY = 2, T_SAND = 3, T_WATER = 4;
const TREE_R = 12;   // trunk collision; leaves a diagonal gap between neighbouring trees

class World {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.N = WORLD_N;
    const n = this.N * this.N;
    this.tiles = new Uint8Array(n);
    this.tone = new Float32Array(n);       // per-tile colour variation
    this.nodes = new Array(n).fill(null);
    this.structs = new Array(n).fill(null);
    this.nodeList = [];
    this.rockTarget = 0;
    this.regrowT = 0;
    this.version = 0;                      // bumps when blocking layout changes (path field + minimap)
    this.generate();
  }

  idx(tx, ty) { return ty * this.N + tx; }
  inBounds(tx, ty) { return tx >= 0 && ty >= 0 && tx < this.N && ty < this.N; }
  tileAt(tx, ty) { return this.inBounds(tx, ty) ? this.tiles[ty * this.N + tx] : T_WATER; }
  isWater(tx, ty) { return this.tileAt(tx, ty) === T_WATER; }
  nodeAt(tx, ty) { return this.inBounds(tx, ty) ? this.nodes[ty * this.N + tx] : null; }
  structAt(tx, ty) { return this.inBounds(tx, ty) ? this.structs[ty * this.N + tx] : null; }
  isEdge(tx, ty) { return tx < 2 || ty < 2 || tx >= this.N - 2 || ty >= this.N - 2; }

  generate() {
    const N = this.N, seed = this.seed;
    const rng = makeRng(seed);
    const nE = makeNoise(seed ^ 0xA5A5A5), nM = makeNoise(seed ^ 0x5A5A5A), nT = makeNoise(seed ^ 0x123457);
    const c = N / 2;
    for (let ty = 0; ty < N; ty++) {
      for (let tx = 0; tx < N; tx++) {
        const dx = (tx + 0.5 - c) / c, dy = (ty + 0.5 - c) / c;
        const d = Math.sqrt(dx * dx + dy * dy);
        let e = fbm(nE, tx * 0.075, ty * 0.075, 4);
        const m = fbm(nM, tx * 0.055 + 31.7, ty * 0.055 + 17.3, 3);
        if (d < 0.2) e = Math.max(e, lerp(0.52, e, d / 0.2));  // dry ground around camp
        let t;
        if (e < 0.33) t = T_WATER;
        else if (e > 0.665) t = T_ROCKY;
        else if (m > 0.53) t = T_FOREST;
        else t = T_GRASS;
        const i = ty * N + tx;
        this.tiles[i] = t;
        this.tone[i] = fbm(nT, tx * 0.21, ty * 0.21, 2);
      }
    }
    // Beaches around water.
    const sand = [];
    for (let ty = 0; ty < N; ty++) {
      for (let tx = 0; tx < N; tx++) {
        const t = this.tiles[ty * N + tx];
        if (t === T_WATER || t === T_ROCKY) continue;
        let near = false;
        for (let oy = -1; oy <= 1 && !near; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const nx = tx + ox, ny = ty + oy;
            if (this.inBounds(nx, ny) && this.tiles[ny * N + nx] === T_WATER) { near = true; break; }
          }
        }
        if (near) sand.push(ty * N + tx);
      }
    }
    for (const i of sand) this.tiles[i] = T_SAND;

    // Resource nodes.
    for (let ty = 0; ty < N; ty++) {
      for (let tx = 0; tx < N; tx++) {
        const i = ty * N + tx;
        const t = this.tiles[i];
        if (t === T_WATER) continue;
        const cd = Math.hypot(tx + 0.5 - c, ty + 0.5 - c);
        if (cd < 4.6) continue;
        if (this.isEdge(tx, ty)) {
          if (rng() < 0.92) this.addNode('tree', tx, ty, rng, 'pine');
          continue;
        }
        const r = rng();
        if (t === T_FOREST) {
          if (r < 0.36) this.addNode('tree', tx, ty, rng, rng() < 0.75 ? 'pine' : 'oak');
          else if (r < 0.4) this.addNode('bush', tx, ty, rng);
          else if (r < 0.44) this.addNode('grass', tx, ty, rng);
          else if (r < 0.452) this.addNode('rock', tx, ty, rng);
        } else if (t === T_GRASS) {
          if (r < 0.06) this.addNode('tree', tx, ty, rng, rng() < 0.6 ? 'oak' : 'birch');
          else if (r < 0.11) this.addNode('bush', tx, ty, rng);
          else if (r < 0.2) this.addNode('grass', tx, ty, rng);
          else if (r < 0.213) this.addNode('rock', tx, ty, rng);
        } else if (t === T_ROCKY) {
          if (r < 0.19) this.addNode('rock', tx, ty, rng);
          else if (r < 0.23) this.addNode('tree', tx, ty, rng, 'pine');
          else if (r < 0.27) this.addNode('grass', tx, ty, rng);
        } else if (t === T_SAND) {
          if (r < 0.04) this.addNode('grass', tx, ty, rng);
          else if (r < 0.06) this.addNode('rock', tx, ty, rng);
        }
      }
    }
    // Make sure the first minutes always have something to hit nearby.
    const want = { tree: 9, rock: 4, bush: 3, grass: 4 };
    const have = { tree: 0, rock: 0, bush: 0, grass: 0 };
    for (const n of this.nodeList) {
      const cd = Math.hypot(n.tx + 0.5 - c, n.ty + 0.5 - c);
      if (cd < 11 && have[n.kind] != null) have[n.kind]++;
    }
    for (const kind in want) {
      let guard = 0;
      while (have[kind] < want[kind] && guard++ < 400) {
        const a = rng() * TAU, rr = 5.5 + rng() * 5;
        const tx = Math.floor(c + Math.cos(a) * rr), ty = Math.floor(c + Math.sin(a) * rr);
        if (!this.inBounds(tx, ty) || this.isWater(tx, ty) || this.nodeAt(tx, ty)) continue;
        this.addNode(kind, tx, ty, rng, kind === 'tree' ? (rng() < 0.5 ? 'oak' : 'pine') : undefined);
        have[kind]++;
      }
    }
    this.connect();
    this.rockTarget = this.nodeList.filter(n => n.kind === 'rock').length;
  }

  // Tiles that block a diagonal squeeze: water, rocks and blocking structures. Trees leave a gap.
  diagBlocked(tx, ty) {
    if (!this.inBounds(tx, ty)) return true;
    const i = ty * this.N + tx;
    if (this.tiles[i] === T_WATER) return true;
    const n = this.nodes[i];
    if (n && n.kind === 'rock') return true;
    const s = this.structs[i];
    return !!(s && STRUCTS[s.type].block);
  }

  // Flood fill of walkable tiles from (sx, sy) using the same movement rule as predators.
  reachable(sx, sy) {
    const N = this.N, seen = new Uint8Array(N * N), q = [sy * N + sx];
    seen[sy * N + sx] = 1;
    while (q.length) {
      const i = q.pop();
      const x = i % N, y = (i / N) | 0;
      for (let k = 0; k < 8; k++) {
        const dx = DIRS8[k][0], dy = DIRS8[k][1];
        const nx = x + dx, ny = y + dy;
        if (!this.tileOpen(nx, ny) || this.isEdge(nx, ny)) continue;
        const j = ny * N + nx;
        if (seen[j]) continue;
        if (dx && dy && (this.diagBlocked(x + dx, y) || this.diagBlocked(x, y + dy))) continue;
        seen[j] = 1;
        q.push(j);
      }
    }
    return seen;
  }

  // Carve through trees and rocks until every open pocket joins the camp's region.
  connect() {
    const N = this.N, c = Math.floor(N / 2);
    const order = [];
    for (let i = 0; i < N * N; i++) order.push(i);
    const rng = makeRng(this.seed ^ 0xC0FFEE);
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    for (let iter = 0; iter < 200; iter++) {
      const reach = this.reachable(c, c);
      let start = -1;
      for (const i of order) {
        const x = i % N, y = (i / N) | 0;
        if (!reach[i] && this.tileOpen(x, y) && !this.isEdge(x, y)) { start = i; break; }
      }
      if (start < 0) return;
      // 0-1 BFS: open tiles cost 0, trees/rocks cost 1, water is impassable. Stop at the camp region.
      const dist = new Int32Array(N * N).fill(1e9), prev = new Int32Array(N * N).fill(-1);
      const dq = [start];
      let head = 0;
      dist[start] = 0;
      let goal = -1;
      const deque = { front: [], back: dq };
      while (deque.front.length || head < deque.back.length) {
        const i = deque.front.length ? deque.front.pop() : deque.back[head++];
        if (reach[i]) { goal = i; break; }
        const x = i % N, y = (i / N) | 0;
        for (let k = 0; k < 4; k++) {
          const nx = x + DIRS8[k][0], ny = y + DIRS8[k][1];
          if (!this.inBounds(nx, ny) || this.isEdge(nx, ny)) continue;
          const j = ny * N + nx;
          if (this.tiles[j] === T_WATER) continue;
          const w = this.isSolidNode(this.nodes[j]) ? 1 : 0;
          if (dist[i] + w < dist[j]) {
            dist[j] = dist[i] + w;
            prev[j] = i;
            if (w) deque.back.push(j); else deque.front.push(j);
          }
        }
      }
      if (goal < 0) {
        // Pocket sealed by water: fill it with trees so nothing spawns where it cannot leave.
        const pocket = [start];
        const seen = new Set(pocket);
        while (pocket.length) {
          const i = pocket.pop();
          const x = i % N, y = (i / N) | 0;
          if (this.nodes[i] && !this.isSolidNode(this.nodes[i])) this.removeNode(this.nodes[i]);
          if (!this.nodes[i]) this.addNode('tree', x, y, rng, 'pine');
          for (let k = 0; k < 4; k++) {
            const nx = x + DIRS8[k][0], ny = y + DIRS8[k][1];
            const j = ny * N + nx;
            if (!this.tileOpen(nx, ny) || this.isEdge(nx, ny) || seen.has(j)) continue;
            seen.add(j);
            pocket.push(j);
          }
        }
        continue;
      }
      for (let i = goal; i >= 0; i = prev[i]) {
        const n = this.nodes[i];
        if (this.isSolidNode(n)) this.removeNode(n);
      }
    }
  }

  addNode(kind, tx, ty, rng, species) {
    rng = rng || Math.random;
    const n = {
      kind, tx, ty,
      x: tx * TILE + TILE / 2 + (rng() - 0.5) * 8,
      y: ty * TILE + TILE / 2 + (rng() - 0.5) * 8,
      v: Math.floor(rng() * 3),
      rot: rng() * TAU,
      amt: 0, t: 0, shake: 0, shakeDir: 0,
    };
    if (kind === 'tree') {
      n.species = species || 'oak';
      n.amt = n.species === 'pine' ? 8 : 6;
      n.r = TREE_R;
      n.autumn = n.species !== 'pine' && rng() < 0.18;
    } else if (kind === 'rock') {
      n.size = 0.8 + rng() * 0.4;
      n.amt = Math.round(9 * n.size);
      n.r = 19 * n.size;
    } else if (kind === 'bush') {
      n.ripe = rng() < 0.85;
      n.r = 0;
    } else if (kind === 'grass') {
      n.amt = 2;
      n.r = 0;
    }
    this.nodes[ty * this.N + tx] = n;
    this.nodeList.push(n);
    if (kind === 'tree' || kind === 'rock') this.version++;
    return n;
  }

  removeNode(n) {
    const i = n.ty * this.N + n.tx;
    if (this.nodes[i] === n) this.nodes[i] = null;
    const k = this.nodeList.indexOf(n);
    if (k >= 0) this.nodeList.splice(k, 1);
    this.version++;
  }

  isSolidNode(n) { return !!n && (n.kind === 'tree' || n.kind === 'rock'); }

  // Can a predator stand on / see through this tile? (ignores breakable structures)
  tileOpen(tx, ty) {
    if (!this.inBounds(tx, ty)) return false;
    const i = ty * this.N + tx;
    if (this.tiles[i] === T_WATER) return false;
    if (this.isSolidNode(this.nodes[i])) return false;
    return true;
  }

  // Straight-line check for line of sight. Breakable structures count as blockers.
  lineClear(x0, y0, x1, y1) {
    const d = dist(x0, y0, x1, y1);
    const steps = Math.ceil(d / 18);
    let lastI = -1;
    for (let s = 1; s < steps; s++) {
      const k = s / steps;
      const tx = Math.floor(lerp(x0, x1, k) / TILE), ty = Math.floor(lerp(y0, y1, k) / TILE);
      const i = ty * this.N + tx;
      if (i === lastI) continue;
      lastI = i;
      if (!this.tileOpen(tx, ty)) return false;
      const st = this.structs[i];
      if (st && STRUCTS[st.type].block) return false;
    }
    return true;
  }

  // Push a circle out of everything solid. Returns the first structure it bumped into (if any).
  // mode: 'player' | 'creature'
  collide(o, r, mode) {
    let bumped = null;
    const tx0 = Math.floor((o.x - r) / TILE) - 1, tx1 = Math.floor((o.x + r) / TILE) + 1;
    const ty0 = Math.floor((o.y - r) / TILE) - 1, ty1 = Math.floor((o.y + r) / TILE) + 1;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const x0 = tx * TILE, y0 = ty * TILE;
        if (!this.inBounds(tx, ty) || this.tiles[ty * this.N + tx] === T_WATER) {
          pushCircleAABB(o, r, x0, y0, x0 + TILE, y0 + TILE);
          continue;
        }
        const i = ty * this.N + tx;
        const n = this.nodes[i];
        if (n && n.r > 0 && (n.kind === 'tree' || n.kind === 'rock')) pushCircleCircle(o, r, n.x, n.y, n.r);
        const s = this.structs[i];
        if (s) {
          const def = STRUCTS[s.type];
          const blocks = mode === 'player' ? def.solid : (def.block || def.solid);
          if (!blocks) continue;
          let hit;
          if (def.circle) hit = pushCircleCircle(o, r, s.x, s.y, def.circle);
          else hit = pushCircleAABB(o, r, x0 + 1, y0 + 1, x0 + TILE - 1, y0 + TILE - 1);
          if (hit && !bumped) bumped = s;
        }
      }
    }
    return bumped;
  }

  // Slow regrowth so the map never runs dry.
  update(dt, player) {
    this.regrowT -= dt;
    if (this.regrowT > 0) return;
    this.regrowT = 0.5;
    const step = 0.5;
    for (const n of this.nodeList) {
      if (n.kind === 'stump') {
        n.t -= step;
        if (n.t <= 0) {
          const i = n.ty * this.N + n.tx;
          const blocked = this.structs[i] || (player && dist2(player.x, player.y, n.x, n.y) < 40 * 40);
          if (blocked) { n.t = 5; continue; }
          n.kind = 'tree';
          n.amt = n.species === 'pine' ? 8 : 6;
          n.r = TREE_R;
          n.grow = 1;
          this.version++;
        }
      } else if (n.kind === 'bush' && !n.ripe) {
        n.t -= step;
        if (n.t <= 0) n.ripe = true;
      } else if (n.kind === 'grass' && n.amt <= 0) {
        n.t -= step;
        if (n.t <= 0) n.amt = 2;
      }
    }
    // Rocks do not regrow in place; new ones appear somewhere out of sight.
    this.rockT = (this.rockT || 0) - step;
    if (this.rockT <= 0) {
      this.rockT = 14;
      let rocks = 0;
      for (const n of this.nodeList) if (n.kind === 'rock') rocks++;
      if (rocks < this.rockTarget) {
        for (let tries = 0; tries < 40; tries++) {
          const tx = randi(3, this.N - 4), ty = randi(3, this.N - 4);
          const t = this.tileAt(tx, ty);
          if (t === T_WATER || this.nodeAt(tx, ty) || this.structAt(tx, ty)) continue;
          if (t !== T_ROCKY && Math.random() < 0.7) continue;
          if (player && dist2(player.x, player.y, tx * TILE, ty * TILE) < 700 * 700) continue;
          this.addNode('rock', tx, ty);
          break;
        }
      }
    }
  }

  // Random walkable spot on a given set of terrain types, away from a point.
  randomSpot(types, awayX, awayY, minD, maxD) {
    for (let tries = 0; tries < 60; tries++) {
      let tx, ty;
      if (maxD) {
        const a = Math.random() * TAU, d = rand(minD, maxD);
        tx = Math.floor((awayX + Math.cos(a) * d) / TILE);
        ty = Math.floor((awayY + Math.sin(a) * d) / TILE);
      } else {
        tx = randi(3, this.N - 4); ty = randi(3, this.N - 4);
      }
      if (!this.inBounds(tx, ty) || this.isEdge(tx, ty)) continue;
      const t = this.tileAt(tx, ty);
      if (t === T_WATER || (types && !types.includes(t))) continue;
      const n = this.nodeAt(tx, ty);
      if (this.isSolidNode(n) || this.structAt(tx, ty)) continue;
      const x = tx * TILE + TILE / 2, y = ty * TILE + TILE / 2;
      if (minD && dist2(x, y, awayX, awayY) < minD * minD) continue;
      return { x, y, tx, ty };
    }
    return null;
  }

  // Compact form for saving. Terrain is rebuilt from the seed.
  serializeNodes() {
    const KIND = { tree: 0, stump: 1, rock: 2, bush: 3, grass: 4 };
    const SPEC = { pine: 0, oak: 1, birch: 2 };
    return this.nodeList.map(n => [KIND[n.kind], n.tx, n.ty, n.amt | 0, Math.round(n.t * 10) / 10,
      n.species ? SPEC[n.species] : -1, n.ripe ? 1 : 0, n.size ? Math.round(n.size * 100) : 0]);
  }
  loadNodes(list) {
    const KIND = ['tree', 'stump', 'rock', 'bush', 'grass'];
    const SPEC = ['pine', 'oak', 'birch'];
    this.nodes.fill(null);
    this.nodeList = [];
    for (const a of list) {
      const kind = KIND[a[0]];
      const base = kind === 'stump' ? 'tree' : kind;
      const n = this.addNode(base, a[1], a[2], makeRng(a[1] * 977 + a[2] * 131 + this.seed), a[5] >= 0 ? SPEC[a[5]] : undefined);
      n.kind = kind;
      n.amt = a[3];
      n.t = a[4];
      if (kind === 'bush') n.ripe = !!a[6];
      if (kind === 'rock' && a[7]) { n.size = a[7] / 100; n.r = 19 * n.size; }
      if (kind === 'stump') n.r = 0;
    }
    this.version++;
  }
}

function pushCircleCircle(o, r, cx, cy, cr) {
  const dx = o.x - cx, dy = o.y - cy;
  const min = r + cr;
  const d2 = dx * dx + dy * dy;
  if (d2 >= min * min) return false;
  const d = Math.sqrt(d2) || 0.001;
  const push = min - d;
  o.x += (dx / d) * push;
  o.y += (dy / d) * push;
  return true;
}

function pushCircleAABB(o, r, x0, y0, x1, y1) {
  const cx = clamp(o.x, x0, x1), cy = clamp(o.y, y0, y1);
  const dx = o.x - cx, dy = o.y - cy;
  const d2 = dx * dx + dy * dy;
  if (d2 >= r * r) return false;
  if (d2 > 1e-6) {
    const d = Math.sqrt(d2);
    const push = r - d;
    o.x += (dx / d) * push;
    o.y += (dy / d) * push;
  } else {
    const l = o.x - x0, rr = x1 - o.x, t = o.y - y0, b = y1 - o.y;
    const m = Math.min(l, rr, t, b);
    if (m === l) o.x = x0 - r;
    else if (m === rr) o.x = x1 + r;
    else if (m === t) o.y = y0 - r;
    else o.y = y1 + r;
  }
  return true;
}

function circleOverlapsAABB(x, y, r, x0, y0, x1, y1) {
  const cx = clamp(x, x0, x1), cy = clamp(y, y0, y1);
  return dist2(x, y, cx, cy) < r * r;
}
