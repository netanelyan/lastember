'use strict';
// Game state and simulation: player, creatures, structures, day/night cycle, waves, saving.

const TIPS = [
  { text: 'Hit trees to gather wood', key: ['Left click', 'Swing'], done: S => S.player.inv.wood >= 6 || S.player.gear.axe },
  { text: 'Break rocks for stone', key: ['Left click', 'Swing'], done: S => S.player.inv.stone >= 3 || S.player.gear.axe },
  { text: 'Craft a Stone Axe', key: ['C', 'Craft'], done: S => !!S.player.gear.axe },
  { text: 'Feed the campfire some wood', key: ['E near the fire', 'Use'], done: S => !!S.flags.fed },
  { text: 'Hunt an animal or spear a fish', key: ['Left click', 'Swing'], done: S => S.stats.hunted + S.stats.fish + S.stats.predators >= 1 },
  { text: 'Stand by the fire to cook, then eat', key: ['F', 'Eat'], done: S => !!S.flags.ateCooked },
  { text: 'Build walls around your camp', key: ['B', 'Build'], done: S => S.stats.built >= 3 },
];

const Game = {
  mode: 'title',          // title | play | paused | perk | over
  world: null,
  S: null,
  hitstop: 0,
  interactTarget: null,
  ghost: null,
  flow: null, flowCost: null, heap: null, flowT: 0, flowKey: '',
  uid: 1,
  titleT: 0,
  lastPlaced: null,

  // ================= setup =================
  newWorld(seed) {
    this.world = new World(seed);
    Render.setWorld(this.world);
    this.S = this.freshState(seed);
    this.flow = null;
    this.flowKey = '';
    const c = Math.floor(WORLD_N / 2);
    const fire = this.addStruct('campfire', c, c);
    fire.fuel = FIRE.startFuel;
    this.populate(true);
    this.S.player.hidden = true;
  },

  freshState(seed) {
    const c = WORLD_PX / 2;
    const inv = {};
    for (const k of INV_ORDER) inv[k] = 0;
    return {
      seed, day: 1, phase: 'day', phaseT: 0, time: 0, nights: 0,
      player: {
        x: c + 4, y: c + 58, vx: 0, vy: 0, kx: 0, ky: 0, r: PLAYER.r, aim: -Math.PI / 2,
        hp: 100, maxHp: 100, hunger: 100, warmth: 100, stamina: 100,
        inv, gear: {},
        swingCd: 0, swingT: 0, swingSide: 1, swingTool: 'fist', idleTool: 'fist', swingWeapon: 'fist',
        shootCd: 0, bowT: 0, iframes: 0, hurtT: 0, dodgeT: 0, dodgeCd: 0, dodgeDir: 0,
        staminaDelay: 0, exhausted: false, walk: 0, dead: false, hidden: false, interactCd: 0, eatCd: 0, warnT: 0,
      },
      creatures: [], arrows: [], drops: [], particles: [], texts: [], structures: [],
      perks: {}, perkLog: [],
      stats: { kills: 0, hunted: 0, built: 0, crafted: 0, gathered: 0, predators: 0, fish: 0 },
      flags: {}, tipIdx: 0, wave: null, build: null,
      cook: { t: 0, fire: null, item: null },
      snow: 0, popT: 0, dayPredT: 45, deathT: 0, fxT: 0,
    };
  },

  startRun() {
    const S = this.S;
    S.player.hidden = false;
    if (Store.get('tutorialDone', false)) S.tipIdx = TIPS.length;
    this.mode = 'play';
    this.updateCamera(0, true);
    UI.onRunStart();
    UI.banner('Day 1', 'Gather wood and stone. Night comes in a little over two minutes.');
  },

  // ================= structures =================
  addStruct(type, tx, ty, opts = {}) {
    const def = STRUCTS[type];
    const hpMul = 1 + 0.4 * ((this.S && this.S.perks.carpenter) || 0);
    const s = {
      id: this.uid++, type, tx, ty, x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2,
      hp: def.hp * hpMul, maxHp: def.hp * hpMul, flash: 0, showHp: 0, t: 0, cd: 0,
    };
    if (type === 'campfire') s.fuel = 40;
    if (type === 'springbow') { s.ammo = 0; s.aim = -Math.PI / 2; }
    if (type === 'snare') s.armed = true;
    Object.assign(s, opts);
    const n = this.world.nodeAt(tx, ty);
    if (n && (n.kind === 'grass' || n.kind === 'bush' || n.kind === 'stump')) this.world.removeNode(n);
    this.world.structs[this.world.idx(tx, ty)] = s;
    this.S.structures.push(s);
    this.world.version++;
    return s;
  },

  removeStruct(s) {
    const i = this.world.idx(s.tx, s.ty);
    if (this.world.structs[i] === s) this.world.structs[i] = null;
    const k = this.S.structures.indexOf(s);
    if (k >= 0) this.S.structures.splice(k, 1);
    this.world.version++;
  },

  damageStruct(s, dmg) {
    const def = STRUCTS[s.type];
    if (def.indestructible) return;
    s.hp -= dmg;
    s.flash = 0.12;
    s.showHp = 4;
    this.fx(s.x, s.y, 6, { type: 'chip', c: s.type === 'stonewall' ? '160,164,168' : '150,100,55', s0: 60, s1: 160, vz: 160, life: 0.6, size: 2.5 });
    Sfx.play(s.type === 'stonewall' ? 'stone' : 'chop', { vol: 0.6, pitch: 0.8 });
    if (s.hp <= 0) {
      this.removeStruct(s);
      this.fx(s.x, s.y, 16, { type: 'chip', c: s.type === 'stonewall' ? '160,164,168' : '150,100,55', s0: 80, s1: 220, vz: 220, life: 0.9, size: 3 });
      this.fx(s.x, s.y, 6, { type: 'smoke', c: '120,110,100', s0: 10, s1: 40, life: 1, size: 12 });
      Sfx.play('crumble');
      if (dist2(s.x, s.y, this.S.player.x, this.S.player.y) < 900 * 900) UI.toast(`Your ${STRUCTS[s.type].name.toLowerCase()} was destroyed`, 'bad');
    }
  },

  fireLight(s) { return (FIRE.lightBase + s.fuel * FIRE.lightPerFuel) * (1 + 0.15 * (this.S.perks.hearth || 0)); },
  fireHeat(s) { return (FIRE.heatBase + s.fuel * FIRE.heatPerFuel) * (1 + 0.25 * (this.S.perks.hearth || 0)); },

  heatAt(x, y) {
    let best = 0;
    for (const s of this.S.structures) {
      if (s.type !== 'campfire' || s.fuel <= 0) continue;
      const r = this.fireHeat(s);
      const d = dist(x, y, s.x, s.y);
      if (d < r) best = Math.max(best, 1 - d / r * 0.6);
    }
    return best;
  },

  lightLevel(x, y) {
    let best = 0, src = null;
    for (const s of this.S.structures) {
      let r = 0;
      if (s.type === 'campfire' && s.fuel > 0) r = this.fireLight(s);
      else if (s.type === 'torch') r = STRUCTS.torch.light;
      if (!r) continue;
      const d = dist(x, y, s.x, s.y);
      const l = 1 - d / r;
      if (l > best) { best = l; src = { x: s.x, y: s.y, r }; }
    }
    this._lightSrc = src;
    return best;
  },

  // ================= creatures =================
  makeCreature(type, x, y, extra) {
    const def = CREATURES[type];
    const c = {
      id: this.uid++, type, x, y, vx: 0, vy: 0, kx: 0, ky: 0,
      angle: Math.random() * TAU, hp: def.hp, maxHp: def.hp,
      state: 'idle', st: 0, wt: 0, wdir: Math.random() * TAU, walk: 0, moving: false,
      flash: 0, hpShow: 0, atkCd: rand(0.4, 1.2), seed: Math.random() * 100, fear: 0, stun: 0,
      spawnT: 0, spikeCd: 0, losT: 0, los: false, stalkT: 0, orbit: chance(0.5) ? 1 : -1,
      aggro: 0, annoy: 0, pounceCd: 0, buffT: 0, howlT: 6, fleeT: 0, flee: false, night: false, brave: false,
    };
    if (type === 'deer') c.antlers = chance(0.45);
    Object.assign(c, extra || {});
    this.S.creatures.push(c);
    return c;
  },

  populate(initial) {
    const S = this.S, w = this.world;
    const counts = {};
    for (const c of S.creatures) counts[c.type] = (counts[c.type] || 0) + 1;
    const want = { rabbit: 16, deer: 8, boar: 5, fish: 18 };
    const p = S.player;
    const near = initial ? [WORLD_PX / 2, WORLD_PX / 2, 320, 2400] : [p.x, p.y, 700, 1500];
    let spawned = 0;
    for (const type of ['rabbit', 'deer', 'boar', 'fish']) {
      let have = counts[type] || 0;
      let guard = 0;
      while (have < want[type] && guard++ < 40 && (initial || spawned < 2)) {
        if (type === 'fish') {
          const tx = randi(2, w.N - 3), ty = randi(2, w.N - 3);
          if (!w.isWater(tx, ty) || !w.isWater(tx + 1, ty) || !w.isWater(tx - 1, ty) || !w.isWater(tx, ty + 1) || !w.isWater(tx, ty - 1)) continue;
          if (!initial && dist2(tx * TILE, ty * TILE, p.x, p.y) < 500 * 500) continue;
          this.makeCreature('fish', tx * TILE + TILE / 2, ty * TILE + TILE / 2);
          have++; spawned++;
          continue;
        }
        const types = type === 'boar' ? [T_FOREST, T_GRASS] : type === 'deer' ? [T_GRASS, T_FOREST] : [T_GRASS, T_SAND];
        const spot = w.randomSpot(types, near[0], near[1], near[2], near[3]);
        if (!spot) continue;
        const herd = type === 'deer' ? randi(2, 3) : type === 'rabbit' ? randi(1, 2) : 1;
        for (let i = 0; i < herd && have < want[type]; i++) {
          this.makeCreature(type, spot.x + rand(-20, 20), spot.y + rand(-20, 20));
          have++; spawned++;
        }
      }
    }
  },

  spawnPredator(type, x, y, night) {
    const def = CREATURES[type];
    const hp = Math.round(def.hp * nightHpScale(this.S.day));
    const c = this.makeCreature(type, x, y, {
      hp, maxHp: hp, state: 'hunt', night, spawnT: 1,
      stalkT: def.brave ? 0 : rand(2.5, 6) * (this.S.day >= 6 ? 0.5 : 1),
    });
    if (type === 'bear') Sfx.play('growl', { vol: 0.9 });
    if (type === 'alpha') { UI.setBoss(c); Sfx.play('howl', { vol: 1.3, pitch: 0.8 }); }
    return c;
  },

  hurtCreature(c, dmg, ang, kb, byPlayer) {
    if (c.dead) return;
    const def = CREATURES[c.type];
    dmg = Math.max(1, Math.round(dmg));
    c.hp -= dmg;
    c.flash = 0.1;
    c.hpShow = 3;
    const kbm = c.type === 'bear' ? 0.25 : c.type === 'alpha' ? 0.45 : 1;
    c.kx += Math.cos(ang) * kb * kbm;
    c.ky += Math.sin(ang) * kb * kbm;
    this.text(c.x + rand(-6, 6), c.y - def.r - 6, String(dmg), byPlayer ? '#fff4d6' : '#ffd38a', 15);
    const furC = { rabbit: '168,138,106', deer: '160,110,60', boar: '77,59,49', wolf: '127,135,146', alpha: '75,80,88', lynx: '196,154,98', bear: '91,59,38', fish: '120,170,190' }[c.type];
    this.fx(c.x, c.y, 5, { type: 'dot', c: furC, s0: 40, s1: 140, vz: 120, life: 0.5, size: 2.2, ang, spread: 0.9 });
    this.fx(c.x, c.y, 3, { type: 'dot', c: '150,32,36', s0: 30, s1: 90, vz: 90, life: 0.5, size: 1.8, ang, spread: 0.8 });
    Sfx.play('hit', { pitch: def.r > 20 ? 0.7 : 1 });
    if (def.kind === 'prey') {
      c.fear = 5;
      if (c.type === 'rabbit') Sfx.play('squeal', { pitch: 1.2 });
      for (const o of this.S.creatures) if (o.type === c.type && o !== c && dist2(o.x, o.y, c.x, c.y) < 260 * 260) o.fear = 4;
    } else if (def.kind === 'boar') {
      c.aggro = 9;
      Sfx.play('squeal', { pitch: 0.6 });
    } else if (def.kind === 'predator') {
      if (c.state === 'stalk' || c.stalkT > 0) { c.stalkT = 0; c.brave = true; }
      if (c.type === 'bear' && chance(0.3)) Sfx.play('growl', { vol: 0.6 });
    }
    if (byPlayer) { this.hitstop = Math.max(this.hitstop, 0.035); Render.shake(2.5); }
    if (c.hp <= 0) this.killCreature(c, ang);
  },

  killCreature(c, ang) {
    const S = this.S, def = CREATURES[c.type];
    c.dead = true;
    for (const item in def.drops) this.spawnDrops(item, def.drops[item], c.x, c.y);
    if (def.fang && chance(def.fang)) this.spawnDrops('fang', 1, c.x, c.y);
    if (def.kind === 'predator') {
      S.stats.kills++;
      S.stats.predators++;
      const heal = 4 * (S.perks.blood || 0);
      if (heal) { S.player.hp = Math.min(S.player.maxHp, S.player.hp + heal); this.text(S.player.x, S.player.y - 26, `+${heal}`, '#9fe08a', 14); }
      if (S.wave) S.wave.killed++;
    } else if (def.kind === 'fish') S.stats.fish++;
    else S.stats.hunted++;
    this.fx(c.x, c.y, 12, { type: 'dot', c: '200,190,170', s0: 60, s1: 200, vz: 160, life: 0.7, size: 2.4 });
    this.fx(c.x, c.y, 4, { type: 'smoke', c: '200,200,190', s0: 10, s1: 40, life: 0.8, size: def.r * 0.8 });
    Sfx.play('kill', { pitch: def.r > 20 ? 0.6 : def.r < 10 ? 1.5 : 1 });
    if (def.boss) {
      UI.setBoss(null);
      UI.banner('Alpha down', 'The pack scatters for now.');
      Render.shake(10);
    }
  },

  // ================= drops / fx / text =================
  spawnDrops(item, n, x, y) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, sp = rand(30, 110);
      this.S.drops.push({ item, x: x + rand(-5, 5), y: y + rand(-5, 5), vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, z: 4, vz: rand(150, 230), t: 0, seed: Math.random() * 10 });
    }
  },

  fx(x, y, n, o) {
    const P = this.S.particles;
    for (let i = 0; i < n; i++) {
      if (P.length > 700) P.shift();
      const a = o.ang != null ? o.ang + rand(-(o.spread || 0.5), o.spread || 0.5) : Math.random() * TAU;
      const sp = rand(o.s0 || 20, o.s1 || 80);
      const life = (o.life || 0.6) * rand(0.7, 1.2);
      P.push({
        type: o.type || 'dot', x: x + rand(-(o.jit || 3), o.jit || 3), y: y + rand(-(o.jit || 3), o.jit || 3),
        vx: Math.cos(a) * sp + (o.vx || 0), vy: Math.sin(a) * sp + (o.vy || 0),
        z: o.z || 0, vz: o.vz ? rand(o.vz * 0.5, o.vz) : 0, grav: !!o.vz,
        life, max: life, size: (o.size || 2) * rand(0.7, 1.3), c: o.c || '255,255,255', glow: !!o.glow,
        drag: o.drag || 0.9, rot: Math.random() * TAU, vr: rand(-12, 12),
      });
    }
  },

  text(x, y, text, color, size = 14, key) {
    const T = this.S.texts;
    if (key) {
      const old = T.find(t => t.key === key);
      if (old) { old.life = old.max; old.x = x; old.y = y; return; }
    }
    if (T.length > 60) T.shift();
    T.push({ x, y, text, color, size, life: 1.1, max: 1.1, key });
  },

  pickupText(item, n) {
    const p = this.S.player;
    const key = 'pick_' + item;
    const T = this.S.texts;
    const old = T.find(t => t.key === key && t.max - t.life < 0.8);
    const name = ITEMS[item].name;
    if (old) { old.n += n; old.text = `+${old.n} ${name}`; old.life = old.max; old.x = p.x; old.y = p.y - 30; return; }
    T.push({ x: p.x, y: p.y - 30, text: `+${n} ${name}`, color: '#f6e7c1', size: 14, life: 1.1, max: 1.1, key, n });
  },

  // ================= player =================
  weaponId() {
    const g = this.S.player.gear;
    return g.blade ? 'blade' : g.spear ? 'spear' : g.axe ? 'axe' : 'fist';
  },

  updatePlayer(dt) {
    const S = this.S, p = S.player, I = Input, perks = S.perks;
    p.swingCd -= dt; p.swingT -= dt; p.shootCd -= dt; p.bowT -= dt; p.iframes -= dt; p.hurtT -= dt;
    p.dodgeCd -= dt; p.staminaDelay -= dt; p.interactCd -= dt; p.eatCd -= dt;
    if (p.dead) { p.vx *= 0.9; p.vy *= 0.9; return; }

    // movement intent
    let mx = 0, my = 0;
    if (I.down('KeyW') || I.down('ArrowUp')) my -= 1;
    if (I.down('KeyS') || I.down('ArrowDown')) my += 1;
    if (I.down('KeyA') || I.down('ArrowLeft')) mx -= 1;
    if (I.down('KeyD') || I.down('ArrowRight')) mx += 1;
    if (I.joy.mag > 0) { mx = I.joy.dx; my = I.joy.dy; }
    let ml = Math.hypot(mx, my);
    if (ml > 1) { mx /= ml; my /= ml; ml = 1; }

    // aim
    if (!I.touchMode && I.mouse.has) {
      const m = Render.screenToWorld(I.mouse.x, I.mouse.y);
      p.aim = Math.atan2(m.y - p.y, m.x - p.x);
    } else if (ml > 0.2 && p.swingT <= 0 && p.bowT <= 0) {
      p.aim = approachAngle(p.aim, Math.atan2(my, mx), 12 * dt);
    }

    // sprint & stamina
    const sprintKey = I.down('ShiftLeft') || I.down('ShiftRight') || (I.touchMode && I.joy.mag > 0.97);
    let speed = PLAYER.speed * (1 + 0.08 * (perks.swift || 0));
    if (p.stamina <= 0.5) p.exhausted = true;
    if (p.exhausted && p.stamina > 30) p.exhausted = false;
    const sprinting = sprintKey && ml > 0.1 && !p.exhausted;
    if (sprinting) {
      speed *= PLAYER.sprint;
      p.stamina = Math.max(0, p.stamina - 21 * dt);
      p.staminaDelay = 0.6;
      S.fxT -= dt;
      if (S.fxT <= 0) { S.fxT = 0.09; this.fx(p.x, p.y + 6, 1, { type: 'smoke', c: '170,150,120', s0: 5, s1: 20, life: 0.5, size: 5 }); }
    }
    if (p.staminaDelay <= 0) p.stamina = Math.min(100, p.stamina + 26 * (1 + 0.4 * (perks.wind || 0)) * dt);

    // dodge roll
    const dodgeCost = PLAYER.dodgeCost * (1 - 0.2 * (perks.wind || 0));
    if ((I.hit('Space') || I.tapped.has('dodge')) && p.dodgeCd <= 0 && !p.dodgeT) {
      if (p.stamina >= dodgeCost) {
        p.dodgeDir = ml > 0.1 ? Math.atan2(my, mx) : p.aim;
        p.dodgeT = PLAYER.dodgeTime;
        p.iframes = Math.max(p.iframes, 0.3);
        p.stamina -= dodgeCost;
        p.staminaDelay = 0.7;
        p.dodgeCd = 0.42;
        Sfx.play('dodge');
        this.fx(p.x, p.y, 6, { type: 'smoke', c: '190,175,150', s0: 20, s1: 60, life: 0.5, size: 6 });
      } else {
        this.text(p.x, p.y - 30, 'Too tired', '#ffb0a0', 13, 'tired');
      }
    }
    if (p.dodgeT > 0) {
      p.dodgeT -= dt;
      if (p.dodgeT <= 0) p.dodgeT = 0;
      p.vx = Math.cos(p.dodgeDir) * PLAYER.dodgeSpeed;
      p.vy = Math.sin(p.dodgeDir) * PLAYER.dodgeSpeed;
    } else {
      const k = damp(ml > 0.05 ? 14 : 18, dt);
      p.vx = lerp(p.vx, mx * speed, k);
      p.vy = lerp(p.vy, my * speed, k);
    }
    p.x += (p.vx + p.kx) * dt;
    p.y += (p.vy + p.ky) * dt;
    p.kx *= Math.exp(-dt * 10);
    p.ky *= Math.exp(-dt * 10);
    this.world.collide(p, p.r, 'player');
    p.x = clamp(p.x, TILE * 1.5, WORLD_PX - TILE * 1.5);
    p.y = clamp(p.y, TILE * 1.5, WORLD_PX - TILE * 1.5);
    const sp = Math.hypot(p.vx, p.vy);
    if (sp > 20) p.walk += sp * dt * 0.075;

    // idle tool
    p.idleTool = this.weaponId();

    // actions
    if (!S.build) {
      const swingHeld = I.touchMode ? I.held.swing : I.mouse.left;
      const shootHeld = I.touchMode ? I.held.shoot : I.mouse.right;
      if (swingHeld && p.swingCd <= 0 && p.dodgeT <= 0) this.playerSwing();
      if (shootHeld && p.shootCd <= 0 && p.dodgeT <= 0) this.playerShoot();
    }
    // interact
    this.interactTarget = this.findInteract();
    const useHeld = I.down('KeyE') || I.held.use;
    if (useHeld && p.interactCd <= 0 && this.interactTarget && !this.interactTarget.disabled) {
      this.doInteract(this.interactTarget);
      p.interactCd = 0.17;
    } else if ((I.hit('KeyE') || I.tapped.has('use')) && this.interactTarget && this.interactTarget.disabled) {
      UI.toast(this.interactTarget.label, 'info');
      Sfx.play('deny');
    }
    if (I.hit('KeyF') || I.tapped.has('eat')) this.eat();
    if (I.hit('KeyQ') || I.tapped.has('heal')) this.useBandage();
  },

  playerSwing() {
    const S = this.S, p = S.player, w = this.world;
    const wid = this.weaponId();
    const W = MELEE[wid];
    const assist = Input.touchMode ? 1.3 : 0.3;
    let aim = p.aim;
    // aim assist toward the most likely target
    let bestC = null, bestCScore = Infinity;
    for (const c of S.creatures) {
      if (c.dead) continue;
      const r = CREATURES[c.type].r;
      const d = dist(p.x, p.y, c.x, c.y);
      if (d > W.reach + r + 10) continue;
      const ad = Math.abs(angleDiff(aim, Math.atan2(c.y - p.y, c.x - p.x)));
      if (ad > W.arc / 2 + assist) continue;
      const score = ad * 40 + d * 0.4 - (CREATURES[c.type].kind === 'predator' ? 30 : 0);
      if (score < bestCScore) { bestCScore = score; bestC = c; }
    }
    let node = null;
    if (bestC) {
      const a = Math.atan2(bestC.y - p.y, bestC.x - p.x);
      if (Math.abs(angleDiff(aim, a)) > W.arc / 2 * 0.6) aim = a;
    } else {
      node = this.findNode(aim, W.reach, W.arc / 2 + assist);
      if (node) {
        const a = Math.atan2(node.y - p.y, node.x - p.x);
        if (Math.abs(angleDiff(aim, a)) > W.arc / 2 * 0.6) aim = a;
      }
    }
    if (Input.touchMode || bestC || node) p.aim = aim;
    p.swingSide = -p.swingSide;
    p.swingT = 0.18;
    p.swingCd = W.cd;
    p.swingWeapon = wid;
    p.swingTool = wid;
    Sfx.play('swing', { pitch: wid === 'fist' ? 1.3 : 1 });

    const dmgMul = (1 + 0.2 * (S.perks.brute || 0)) * rand(0.9, 1.1);
    let hitCreature = false;
    for (const c of S.creatures) {
      if (c.dead) continue;
      const r = CREATURES[c.type].r;
      const d = dist(p.x, p.y, c.x, c.y);
      if (d > W.reach + r) continue;
      const a = Math.atan2(c.y - p.y, c.x - p.x);
      if (Math.abs(angleDiff(aim, a)) > W.arc / 2 && d > r + p.r + 6) continue;
      if (c.type === 'fish' && d > W.reach + r - 4) continue;
      this.hurtCreature(c, W.dmg * dmgMul, a, W.kb, true);
      hitCreature = true;
    }
    if (!hitCreature) {
      if (!node) node = this.findNode(aim, W.reach, W.arc / 2 + 0.15);
      if (node) {
        if (node.kind === 'tree' && p.gear.axe) p.swingTool = 'axe';
        else if (node.kind === 'rock' && p.gear.pick) p.swingTool = 'pick';
        this.harvest(node, aim);
      }
    }
  },

  findNode(aim, reach, halfArc) {
    const p = this.S.player, w = this.world;
    const ptx = Math.floor(p.x / TILE), pty = Math.floor(p.y / TILE);
    let best = null, bestD = Infinity;
    for (let ty = pty - 2; ty <= pty + 2; ty++) {
      for (let tx = ptx - 2; tx <= ptx + 2; tx++) {
        const n = w.nodeAt(tx, ty);
        if (!n || n.kind === 'stump') continue;
        if (n.kind === 'grass' && n.amt <= 0) continue;
        const nr = n.kind === 'tree' ? 15 : n.kind === 'rock' ? 19 * n.size : 13;
        const d = dist(p.x, p.y, n.x, n.y) - nr;
        if (d > reach) continue;
        const ad = Math.abs(angleDiff(aim, Math.atan2(n.y - p.y, n.x - p.x)));
        if (ad > halfArc && d > 8) continue;
        const score = d + ad * 20;
        if (score < bestD) { bestD = score; best = n; }
      }
    }
    return best;
  },

  harvest(n, aim) {
    const S = this.S, p = S.player, w = this.world, perks = S.perks;
    n.shake = 0.22;
    const back = aim + Math.PI;
    if (n.kind === 'tree') {
      let got = (p.gear.axe ? 2 : 1) + (perks.woods || 0);
      got = Math.min(got, n.amt);
      n.amt -= got;
      this.spawnDrops('wood', got, n.x + Math.cos(back) * 10, n.y + Math.sin(back) * 10);
      S.stats.gathered += got;
      this.fx(n.x + Math.cos(back) * 14, n.y + Math.sin(back) * 14, 6, { type: 'chip', c: '196,140,80', s0: 60, s1: 160, vz: 180, life: 0.6, size: 2.6, ang: back, spread: 1 });
      this.fx(n.x, n.y, 3, { type: 'chip', c: n.species === 'pine' ? '50,100,70' : n.autumn ? '210,130,50' : '90,150,60', s0: 20, s1: 70, vz: 60, life: 1.2, size: 2.4, jit: 22 });
      Sfx.play('chop', { pitch: rand(0.9, 1.1) });
      if (n.amt <= 0) {
        n.kind = 'stump';
        n.r = 0;
        n.t = rand(80, 130);
        w.version++;
        this.fx(n.x, n.y, 18, { type: 'chip', c: n.species === 'pine' ? '45,95,65' : n.autumn ? '210,130,50' : '85,145,58', s0: 40, s1: 160, vz: 120, life: 1.4, size: 3, jit: 26 });
        this.spawnDrops('wood', 1, n.x, n.y);
        Sfx.play('fell');
        Render.shake(3);
      }
    } else if (n.kind === 'rock') {
      let got = (p.gear.pick ? 2 : 1) + (perks.mason || 0);
      got = Math.min(got, n.amt);
      n.amt -= got;
      this.spawnDrops('stone', got, n.x + Math.cos(back) * 12, n.y + Math.sin(back) * 12);
      S.stats.gathered += got;
      this.fx(n.x + Math.cos(back) * 16, n.y + Math.sin(back) * 16, 7, { type: 'chip', c: '175,180,184', s0: 60, s1: 180, vz: 160, life: 0.55, size: 2.2, ang: back, spread: 1 });
      this.fx(n.x + Math.cos(back) * 16, n.y + Math.sin(back) * 16, 3, { type: 'dot', c: '255,230,160', s0: 80, s1: 200, life: 0.25, size: 1.6, glow: true, ang: back, spread: 0.8 });
      Sfx.play('stone', { pitch: rand(0.9, 1.15) });
      if (n.amt <= 0) {
        w.removeNode(n);
        this.fx(n.x, n.y, 14, { type: 'chip', c: '150,154,158', s0: 60, s1: 200, vz: 200, life: 0.9, size: 3.2 });
        this.fx(n.x, n.y, 4, { type: 'smoke', c: '170,170,165', s0: 10, s1: 40, life: 0.9, size: 12 });
        Sfx.play('crumble');
      }
    } else if (n.kind === 'bush') {
      Sfx.play('rustle');
      this.fx(n.x, n.y, 5, { type: 'chip', c: '80,140,60', s0: 30, s1: 90, vz: 80, life: 0.8, size: 2.3, jit: 10 });
      if (n.ripe) {
        n.ripe = false;
        n.t = rand(40, 55);
        const b = randi(2, 3) + (perks.forager || 0);
        this.spawnDrops('berries', b, n.x, n.y);
        this.spawnDrops('fiber', 1 + (perks.forager || 0), n.x, n.y);
        S.stats.gathered += b;
      } else if (chance(0.5)) {
        this.spawnDrops('fiber', 1, n.x, n.y);
      }
    } else if (n.kind === 'grass') {
      const got = 2 + (perks.forager || 0);
      n.amt = 0;
      n.t = rand(45, 60);
      this.spawnDrops('fiber', got, n.x, n.y);
      S.stats.gathered += got;
      Sfx.play('rustle', { pitch: 1.3 });
      this.fx(n.x, n.y, 6, { type: 'chip', c: '150,190,90', s0: 30, s1: 100, vz: 90, life: 0.8, size: 2, jit: 8 });
    }
  },

  playerShoot() {
    const S = this.S, p = S.player;
    if (!p.gear.bow) return;
    if (p.inv.arrow <= 0) {
      p.shootCd = 0.6;
      UI.toast('Out of arrows. Craft more with wood and stone.', 'info', 'arrows');
      Sfx.play('deny');
      return;
    }
    let aim = p.aim;
    // touch: auto-target; mouse: tiny assist
    const range = 460;
    const window = Input.touchMode ? 1.2 : 0.12;
    let best = null, bestS = Infinity;
    for (const c of S.creatures) {
      if (c.dead || c.type === 'fish') continue;
      const d = dist(p.x, p.y, c.x, c.y);
      if (d > range) continue;
      const a = Math.atan2(c.y - p.y, c.x - p.x);
      const ad = Math.abs(angleDiff(aim, a));
      if (ad > window) continue;
      const pred = CREATURES[c.type].kind === 'predator';
      const s = ad * 300 + d - (pred ? 200 : 0);
      if (s < bestS) { bestS = s; best = c; }
    }
    if (best) {
      const lead = dist(p.x, p.y, best.x, best.y) / 800;
      aim = Math.atan2(best.y + best.vy * lead - p.y, best.x + best.vx * lead - p.x);
      if (Input.touchMode) p.aim = aim;
    }
    p.inv.arrow--;
    const lvl = S.perks.aim || 0;
    const spd = 780 * (1 + 0.12 * lvl);
    this.spawnArrow(p.x + Math.cos(aim) * 16, p.y + Math.sin(aim) * 16, aim, spd, 20 * (1 + 0.3 * lvl), 'player');
    p.shootCd = 0.42;
    p.bowT = 0.28;
    Sfx.play('shoot');
    UI.invDirty = true;
  },

  spawnArrow(x, y, ang, speed, dmg, from) {
    this.S.arrows.push({ x, y, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed, life: 0.62, dmg, from });
  },

  findInteract() {
    const S = this.S, p = S.player;
    let best = null, bestD = PLAYER.reachInteract;
    for (const s of S.structures) {
      const d = dist(p.x, p.y, s.x, s.y) - (STRUCTS[s.type].circle ? STRUCTS[s.type].circle : 18);
      if (d > bestD) continue;
      let act = null;
      if (s.type === 'campfire') {
        if (s.fuel < FIRE.maxFuel - 3) {
          act = p.inv.wood > 0 ? { label: s.fuel > 0 ? `Add wood · fire ${Math.round(s.fuel)}%` : 'Relight the fire', kind: 'fuel' }
            : { label: 'You need wood for the fire', disabled: true };
        }
      } else if (s.type === 'springbow') {
        const max = STRUCTS.springbow.ammoMax;
        if (s.ammo < max) act = p.inv.arrow > 0 ? { label: `Load arrows · ${s.ammo}/${max}`, kind: 'load' } : { label: 'You need arrows to load it', disabled: true };
      }
      if (!act && s.hp < s.maxHp * 0.98 && !STRUCTS[s.type].indestructible) {
        const cost = this.repairCost(s);
        act = this.affordable(cost) ? { label: `Repair ${STRUCTS[s.type].name}${this.costText(cost)}`, kind: 'repair' }
          : { label: `Repairing needs${this.costText(cost)}`, disabled: true };
      }
      if (act) { best = Object.assign({ s, x: s.x, y: s.y }, act); bestD = d; }
    }
    return best;
  },

  repairCost(s) {
    if (this.S.perks.carpenter) return {};
    const c = STRUCTS[s.type].cost;
    const main = c.stone && s.type !== 'spikes' ? 'stone' : c.wood ? 'wood' : 'fiber';
    return { [main]: 1 };
  },
  costText(cost) {
    const parts = Object.keys(cost).map(k => `${cost[k]} ${ITEMS[k].name.toLowerCase()}`);
    return parts.length ? ` · ${parts.join(', ')}` : '';
  },
  affordable(cost) {
    const inv = this.S.player.inv;
    for (const k in cost) if ((inv[k] || 0) < cost[k]) return false;
    return true;
  },
  pay(cost) {
    const inv = this.S.player.inv;
    for (const k in cost) inv[k] -= cost[k];
    UI.invDirty = true;
  },

  doInteract(it) {
    const S = this.S, p = S.player, s = it.s;
    if (it.kind === 'fuel') {
      p.inv.wood--;
      const was = s.fuel;
      s.fuel = Math.min(FIRE.maxFuel, s.fuel + FIRE.woodFuel);
      S.flags.fed = true;
      Sfx.play('fuel');
      this.fx(s.x, s.y - 4, 8, { type: 'dot', c: '255,190,90', s0: 40, s1: 140, vy: -40, life: 0.7, size: 2, glow: true });
      if (was <= 0) { this.fx(s.x, s.y, 1, { type: 'ring', c: '255,190,90', life: 0.5, size: 50 }); UI.toast('The fire is burning again', 'good'); }
    } else if (it.kind === 'load') {
      const max = STRUCTS.springbow.ammoMax;
      const n = Math.min(p.inv.arrow, max - s.ammo, 5);
      p.inv.arrow -= n;
      s.ammo += n;
      Sfx.play('thunk');
    } else if (it.kind === 'repair') {
      this.pay(this.repairCost(s));
      s.hp = Math.min(s.maxHp, s.hp + s.maxHp * 0.3);
      s.showHp = 2;
      Sfx.play('build', { vol: 0.6 });
      this.fx(s.x, s.y, 5, { type: 'chip', c: '200,160,100', s0: 30, s1: 80, vz: 100, life: 0.5, size: 2 });
    }
    UI.invDirty = true;
  },

  eat() {
    const S = this.S, p = S.player;
    if (p.eatCd > 0 || p.dead) return;
    if (p.hunger >= 97 && p.hp >= p.maxHp - 0.5) { UI.toast('You are full', 'info', 'full'); return; }
    const order = (p.hp < p.maxHp * 0.6 || p.hunger < 65) ? ['steak', 'grilled', 'berries', 'fish', 'meat'] : ['berries', 'grilled', 'steak', 'fish', 'meat'];
    const choice = order.find(id => p.inv[id] > 0);
    if (!choice) { UI.toast('No food. Pick berries or hunt something.', 'info', 'nofood'); Sfx.play('deny'); return; }
    const f = ITEMS[choice].food;
    p.inv[choice]--;
    p.hunger = Math.min(100, p.hunger + f.hunger);
    if (f.heal) p.hp = Math.min(p.maxHp, p.hp + f.heal);
    let msg = `+${f.hunger} food`;
    if (f.raw && !S.perks.stomach) { p.hp -= 4; msg += ' · raw!'; }
    if (!f.raw && choice !== 'berries') S.flags.ateCooked = true;
    this.text(p.x, p.y - 30, msg, f.raw && !S.perks.stomach ? '#ffb0a0' : '#ffd98a', 14);
    Sfx.play('eat');
    p.eatCd = 0.35;
    UI.invDirty = true;
    if (p.hp <= 0) this.playerDown();
  },

  useBandage() {
    const p = this.S.player;
    if (p.dead || p.eatCd > 0) return;
    if (p.inv.bandage <= 0) { UI.toast('No bandages. Craft them from fiber.', 'info', 'noband'); Sfx.play('deny'); return; }
    if (p.hp >= p.maxHp) { UI.toast('You are not hurt', 'info', 'nothurt'); return; }
    p.inv.bandage--;
    p.hp = Math.min(p.maxHp, p.hp + ITEMS.bandage.heal);
    p.eatCd = 0.35;
    this.text(p.x, p.y - 30, `+${ITEMS.bandage.heal} health`, '#9fe08a', 14);
    this.fx(p.x, p.y, 10, { type: 'dot', c: '160,240,140', s0: 10, s1: 40, vy: -50, life: 0.9, size: 2, glow: true, jit: 14 });
    Sfx.play('heal');
    UI.invDirty = true;
  },

  hurtPlayer(dmg, src) {
    const S = this.S, p = S.player;
    if (p.iframes > 0 || p.dead || this.mode !== 'play') return false;
    if (p.gear.armor) dmg *= 0.65;
    dmg = Math.max(1, Math.round(dmg));
    p.hp -= dmg;
    p.iframes = 0.6;
    p.hurtT = 0.35;
    const a = Math.atan2(p.y - src.y, p.x - src.x);
    p.kx += Math.cos(a) * 280;
    p.ky += Math.sin(a) * 280;
    Render.shake(7);
    this.hitstop = Math.max(this.hitstop, 0.06);
    UI.hurt(dmg / 30);
    Sfx.play('hurt');
    this.text(p.x, p.y - 28, `-${dmg}`, '#ff7a6a', 17);
    this.fx(p.x, p.y, 6, { type: 'dot', c: '170,40,40', s0: 40, s1: 140, vz: 100, life: 0.5, size: 2.2, ang: a, spread: 0.8 });
    if (p.hp <= 0) this.playerDown();
    return true;
  },

  playerDown() {
    const S = this.S, p = S.player;
    if (p.dead) return;
    const tent = S.structures.find(s => s.type === 'tent');
    if (tent) {
      this.removeStruct(tent);
      p.x = tent.x; p.y = tent.y; p.vx = p.vy = p.kx = p.ky = 0;
      p.hp = Math.round(p.maxHp * 0.6);
      p.hunger = Math.max(p.hunger, 45);
      p.warmth = Math.max(p.warmth, 65);
      p.iframes = 3;
      for (const c of S.creatures) {
        if (CREATURES[c.type].kind !== 'predator') continue;
        const d = dist(c.x, c.y, p.x, p.y);
        if (d < 320) {
          const a = Math.atan2(c.y - p.y, c.x - p.x);
          c.kx += Math.cos(a) * 500; c.ky += Math.sin(a) * 500;
          c.state = 'recover'; c.st = 2.2;
        }
      }
      this.fx(p.x, p.y, 1, { type: 'ring', c: '255,236,190', life: 0.8, size: 160 });
      Sfx.play('revive');
      UI.banner('Back on your feet', 'Your tent is gone. Build another for a second chance.');
      UI.hurt(0);
      return;
    }
    p.dead = true;
    p.hp = 0;
    S.deathT = 1.8;
    Render.shake(12);
    Sfx.play('over');
  },

  // ================= build & craft =================
  setBuild(id) {
    const S = this.S;
    if (!id) { S.build = null; this.ghost = null; this.ghostLock = null; UI.refreshBuild(); return; }
    S.build = { id };
    this.lastPlaced = null;
    this.ghostLock = null;
    UI.refreshBuild();
  },

  hasBench() { return this.S.structures.some(s => s.type === 'workbench'); },
  nearBench() {
    const p = this.S.player;
    return this.S.structures.some(s => s.type === 'workbench' && dist2(s.x, s.y, p.x, p.y) < 175 * 175);
  },

  placeReason(id, tx, ty) {
    const w = this.world, p = this.S.player, def = STRUCTS[id];
    if (!w.inBounds(tx, ty) || w.isEdge(tx, ty)) return 'Too close to the edge of the world';
    if (w.isWater(tx, ty)) return 'You cannot build on water';
    const n = w.nodeAt(tx, ty);
    if (n && (n.kind === 'tree' || n.kind === 'rock')) return 'Something is in the way';
    if (w.structAt(tx, ty)) return 'Something is already built here';
    const cx = tx * TILE + TILE / 2, cy = ty * TILE + TILE / 2;
    if (dist(cx, cy, p.x, p.y) > PLAYER.buildRange) return 'Too far away';
    if (def.solid || def.block) {
      const x0 = tx * TILE, y0 = ty * TILE;
      if (circleOverlapsAABB(p.x, p.y, p.r - 2, x0, y0, x0 + TILE, y0 + TILE)) return 'You are standing there';
      for (const c of this.S.creatures) {
        if (c.type === 'fish') continue;
        if (circleOverlapsAABB(c.x, c.y, CREATURES[c.type].r - 2, x0, y0, x0 + TILE, y0 + TILE)) return 'Something is standing there';
      }
    }
    if (def.bench && !this.hasBench()) return 'Build a workbench first';
    const need = this.missing(def.cost);
    if (need) return need;
    return null;
  },

  missing(cost) {
    const inv = this.S.player.inv;
    for (const k in cost) {
      const lack = cost[k] - (inv[k] || 0);
      if (lack > 0) return `Need ${lack} more ${ITEMS[k].name.toLowerCase()}`;
    }
    return null;
  },

  updateBuild(dt) {
    const S = this.S, p = S.player, I = Input;
    if (!S.build || p.dead) { this.ghost = null; return; }
    let tx, ty, pressed = false, held = false;
    if (I.touchMode) {
      if (I.worldTouch) {
        const m = Render.screenToWorld(I.worldTouch.x, I.worldTouch.y);
        this.ghostLock = { tx: Math.floor(m.x / TILE), ty: Math.floor(m.y / TILE) };
        pressed = I.worldTouch.pressed;
        held = true;
      } else if (this.ghostLock && S.build.id !== 'demolish' && this.world.structAt(this.ghostLock.tx, this.ghostLock.ty)) {
        this.ghostLock = null;   // just built there: let the ghost follow the player again
      }
      if (this.ghostLock) { tx = this.ghostLock.tx; ty = this.ghostLock.ty; }
      else { tx = Math.floor((p.x + Math.cos(p.aim) * TILE * 1.3) / TILE); ty = Math.floor((p.y + Math.sin(p.aim) * TILE * 1.3) / TILE); }
      if (I.tapped.has('place') && this.ghost) { pressed = true; held = true; }
    } else {
      const m = Render.screenToWorld(I.mouse.x, I.mouse.y);
      tx = Math.floor(m.x / TILE); ty = Math.floor(m.y / TILE);
      pressed = I.mouse.leftPressed;
      held = I.mouse.left;
    }
    const id = S.build.id;
    if (id === 'demolish') {
      const st = this.world.structAt(tx, ty);
      const far = dist(tx * TILE + TILE / 2, ty * TILE + TILE / 2, p.x, p.y) > PLAYER.buildRange;
      this.ghost = { tx, ty, ok: !!st && !far, reason: !st ? 'Nothing to remove here' : far ? 'Too far away' : null };
      if (pressed) {
        if (this.ghost.ok) this.demolish(st);
        else UI.toast(this.ghost.reason, 'info', 'place');
      }
      return;
    }
    const reason = this.placeReason(id, tx, ty);
    this.ghost = { tx, ty, ok: !reason, reason };
    const drag = ['wall', 'stonewall', 'spikes', 'gate'].includes(id);
    const newTile = !this.lastPlaced || this.lastPlaced.tx !== tx || this.lastPlaced.ty !== ty;
    if (pressed || (held && drag && newTile && this.lastPlaced)) {
      if (!reason) {
        this.place(id, tx, ty);
        this.lastPlaced = { tx, ty };
      } else if (pressed) {
        UI.toast(reason, 'info', 'place');
        Sfx.play('deny');
      }
    }
    if (!held) this.lastPlaced = null;
  },

  place(id, tx, ty) {
    const S = this.S, def = STRUCTS[id];
    this.pay(def.cost);
    const s = this.addStruct(id, tx, ty);
    S.stats.built++;
    s.flash = 0.15;
    Sfx.play('build');
    this.fx(s.x, s.y, 8, { type: 'smoke', c: '190,170,140', s0: 20, s1: 60, life: 0.6, size: 8, jit: 16 });
    if (id === 'workbench') UI.toast('Workbench ready. New recipes unlocked nearby.', 'good');
    if (id === 'tent') UI.toast('Tent pitched. If you fall, you wake up here.', 'good');
    if (id === 'springbow') UI.toast('Load the spring bow with arrows (E)', 'info');
    if (id === 'campfire') s.fuel = 50;
    if (this.missing(def.cost) || (id !== 'wall' && id !== 'stonewall' && id !== 'spikes' && id !== 'torch' && id !== 'gate' && id !== 'snare')) {
      this.setBuild(null);
    }
    UI.refreshBuild();
  },

  demolish(s) {
    const cost = STRUCTS[s.type].cost;
    const back = {};
    for (const k in cost) back[k] = Math.floor(cost[k] * 0.5 * clamp(s.hp / s.maxHp, 0, 1) + 0.0001);
    for (const k in back) if (back[k] > 0) this.spawnDrops(k, back[k], s.x, s.y);
    this.removeStruct(s);
    this.fx(s.x, s.y, 12, { type: 'chip', c: '160,120,80', s0: 60, s1: 180, vz: 160, life: 0.7, size: 2.6 });
    Sfx.play('demolish');
  },

  craftReason(r) {
    const p = this.S.player;
    if (r.gear && p.gear[r.gear]) return 'Owned';
    if (r.bench && !this.nearBench()) return 'Stand next to a workbench';
    return this.missing(r.cost);
  },

  craft(id) {
    const S = this.S, p = S.player;
    const r = RECIPES.find(x => x.id === id);
    if (!r) return;
    const why = this.craftReason(r);
    if (why) { UI.toast(why, 'info', 'craft'); Sfx.play('deny'); return; }
    this.pay(r.cost);
    if (r.gear) {
      p.gear[r.gear] = true;
      UI.toast(`Crafted ${GEAR[r.gear].name}`, 'good');
    } else {
      let n = r.n;
      if (r.item === 'arrow') n += 3 * (S.perks.fletcher || 0);
      p.inv[r.item] += n;
      this.text(p.x, p.y - 30, `+${n} ${ITEMS[r.item].name}`, '#f6e7c1', 14);
    }
    S.stats.crafted++;
    Sfx.play('craft');
    this.fx(p.x, p.y, 10, { type: 'dot', c: '255,230,170', s0: 30, s1: 90, vy: -30, life: 0.6, size: 2, glow: true, jit: 10 });
    UI.invDirty = true;
    UI.refreshCraft();
  },

  // ================= structures update =================
  updateStructures(dt) {
    const S = this.S, p = S.player;
    const night = S.phase === 'night' || S.phase === 'dusk';
    const burn = (night ? FIRE.burnNight : FIRE.burnDay) * Math.pow(0.7, S.perks.hearth || 0);
    let cookFire = null, cookD = FIRE.cookRadius;
    const raw = p.inv.meat > 0 ? 'meat' : p.inv.fish > 0 ? 'fish' : null;
    for (let i = S.structures.length - 1; i >= 0; i--) {
      const s = S.structures[i];
      s.flash -= dt;
      s.showHp -= dt;
      if (s.type === 'campfire') {
        if (s.fuel > 0) {
          s.fuel = Math.max(0, s.fuel - burn * dt);
          if (s.fuel === 0) {
            this.fx(s.x, s.y, 8, { type: 'smoke', c: '90,90,90', s0: 10, s1: 30, vy: -20, life: 1.5, size: 10 });
            if (dist2(s.x, s.y, p.x, p.y) < 700 * 700) UI.toast('A fire went out', 'bad');
          }
          if (raw && !p.dead) {
            const d = dist(s.x, s.y, p.x, p.y);
            if (d < cookD) { cookD = d; cookFire = s; }
          }
          this.fireFx(s, dt);
        }
      } else if (s.type === 'torch') {
        if (this.onScreen(s.x, s.y) && chance(dt * 3)) this.fx(s.x, s.y - 6, 1, { type: 'dot', c: '255,170,70', s0: 5, s1: 20, vy: -35, life: 0.8, size: 1.6, glow: true });
      } else if (s.type === 'spikes') {
        for (const c of S.creatures) {
          if (c.dead || c.type === 'fish' || c.spikeCd > 0) continue;
          const r = CREATURES[c.type].r;
          if (!circleOverlapsAABB(c.x, c.y, r * 0.8, s.x - TILE / 2, s.y - TILE / 2, s.x + TILE / 2, s.y + TILE / 2)) continue;
          c.spikeCd = 0.6;
          this.hurtCreature(c, 22, Math.atan2(c.y - s.y, c.x - s.x), 80, false);
          s.hp -= 6;
          s.showHp = 3;
          if (s.hp <= 0) { this.damageStruct(s, 1); break; }
        }
      } else if (s.type === 'snare') {
        if (!s.armed) { s.t -= dt; if (s.t <= 0) s.armed = true; continue; }
        for (const c of S.creatures) {
          if (c.dead || c.type !== 'rabbit') continue;
          if (dist2(c.x, c.y, s.x, s.y) > 24 * 24) continue;
          s.armed = false;
          s.t = 9;
          this.killCreature(c, 0);
          Sfx.play('trap');
          if (dist2(s.x, s.y, p.x, p.y) > 500 * 500) UI.toast('A snare caught a rabbit', 'good');
          break;
        }
      } else if (s.type === 'springbow') {
        s.cd -= dt;
        let target = null, td = 340 * 340;
        for (const c of S.creatures) {
          if (c.dead || CREATURES[c.type].kind !== 'predator' || c.flee) continue;
          const d = dist2(c.x, c.y, s.x, s.y);
          if (d < td) { td = d; target = c; }
        }
        if (target) {
          const lead = Math.sqrt(td) / 700;
          const a = Math.atan2(target.y + target.vy * lead - s.y, target.x + target.vx * lead - s.x);
          s.aim = approachAngle(s.aim, a, 8 * dt);
          if (s.ammo > 0 && s.cd <= 0 && Math.abs(angleDiff(s.aim, a)) < 0.2) {
            s.ammo--;
            s.cd = 0.95;
            this.spawnArrow(s.x + Math.cos(s.aim) * 18, s.y + Math.sin(s.aim) * 18, s.aim, 700, 18, 'trap');
            if (this.onScreen(s.x, s.y)) Sfx.play('shoot', { vol: 0.6 });
          }
        }
      }
    }
    // cooking
    const ck = S.cook;
    if (cookFire && raw) {
      if (ck.fire !== cookFire || ck.item !== raw) { ck.fire = cookFire; ck.item = raw; ck.t = 0; }
      ck.t += dt;
      if (ck.t >= FIRE.cookTime) {
        ck.t = 0;
        p.inv[raw]--;
        const out = ITEMS[raw].cooksTo;
        p.inv[out]++;
        this.text(cookFire.x, cookFire.y - 50, `+1 ${ITEMS[out].name}`, '#ffd98a', 14);
        Sfx.play('sizzle');
        this.fx(cookFire.x, cookFire.y - 20, 4, { type: 'smoke', c: '220,220,220', s0: 5, s1: 20, vy: -30, life: 1, size: 7 });
        UI.invDirty = true;
      }
    } else { ck.t = 0; ck.fire = null; ck.item = null; }
  },

  fireFx(s, dt) {
    if (!this.onScreen(s.x, s.y)) return;
    const k = s.fuel / FIRE.maxFuel;
    if (chance(dt * (2 + k * 5))) this.fx(s.x + rand(-6, 6), s.y - 8, 1, { type: 'smoke', c: '70,66,62', s0: 3, s1: 12, vy: -28, vx: 6, life: 2.2, size: 6 + k * 6, drag: 0.98 });
    if (chance(dt * (3 + k * 9))) this.fx(s.x + rand(-5, 5), s.y - 6, 1, { type: 'dot', c: '255,180,80', s0: 10, s1: 40, vy: -60, life: 1.1, size: 1.8, glow: true, drag: 0.97 });
  },

  onScreen(x, y) {
    const v = Render.view;
    return v && x > v.x0 && x < v.x1 && y > v.y0 && y < v.y1;
  },

  // ================= predator path field =================
  updateFlow(dt) {
    const S = this.S;
    let need = false;
    for (const c of S.creatures) if (!c.flee && CREATURES[c.type].kind === 'predator') { need = true; break; }
    if (!need) return;
    this.flowT -= dt;
    const p = S.player;
    const key = Math.floor(p.x / TILE) + ',' + Math.floor(p.y / TILE) + ',' + this.world.version;
    if ((key !== this.flowKey && this.flowT <= 0) || this.flowT < -1.2) {
      this.computeFlow(Math.floor(p.x / TILE), Math.floor(p.y / TILE));
      this.flowKey = key;
      this.flowT = 0.25;
    }
  },

  computeFlow(gx, gy) {
    const w = this.world, N = w.N, NN = N * N;
    if (!this.flow) { this.flow = new Float64Array(NN); this.flowCost = new Float64Array(NN); this.flowDiag = new Uint8Array(NN); this.heap = new MinHeap(); }
    const cost = this.flowCost, D = this.flow, diag = this.flowDiag;
    for (let i = 0; i < NN; i++) {
      D[i] = Infinity;
      diag[i] = 0;
      if (w.tiles[i] === T_WATER) { cost[i] = Infinity; diag[i] = 1; continue; }
      const n = w.nodes[i];
      if (n && (n.kind === 'tree' || n.kind === 'rock')) { cost[i] = Infinity; diag[i] = n.kind === 'rock' ? 1 : 0; continue; }
      const s = w.structs[i];
      if (s) {
        const def = STRUCTS[s.type];
        if (def.block) { cost[i] = def.indestructible ? Infinity : 1 + s.hp / 28; diag[i] = 1; continue; }
      }
      cost[i] = 1;
    }
    if (!w.inBounds(gx, gy)) return;
    const heap = this.heap;
    heap.clear();
    const g = gy * N + gx;
    D[g] = 0;
    heap.push(g, 0);
    while (heap.size) {
      const i = heap.pop();
      const d = heap.lastPri;
      if (d > D[i]) continue;
      const x = i % N, y = (i / N) | 0;
      const ci = i === g ? 1 : cost[i];
      for (let k = 0; k < 8; k++) {
        const dx = DIRS8[k][0], dy = DIRS8[k][1];
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
        const j = ny * N + nx;
        if (cost[j] === Infinity) continue;
        let step = 1;
        if (dx && dy) {
          if (diag[y * N + nx] || diag[ny * N + x] || ci !== 1 || cost[j] !== 1) continue;
          step = 1.414;
        }
        const nd = d + step * ci;
        if (nd < D[j]) { D[j] = nd; heap.push(j, nd); }
      }
    }
  },

  // Next waypoint for a predator following the field. Returns {x,y} or {struct}.
  flowStep(c) {
    const w = this.world, N = w.N, D = this.flow, cost = this.flowCost, diag = this.flowDiag;
    if (!D) return null;
    const tx = Math.floor(c.x / TILE), ty = Math.floor(c.y / TILE);
    if (!w.inBounds(tx, ty)) return null;
    const i = ty * N + tx;
    if (!(D[i] < Infinity)) return null;
    let best = -1, bestV = D[i] + 0.0001;
    for (let k = 0; k < 8; k++) {
      const dx = DIRS8[k][0], dy = DIRS8[k][1];
      const nx = tx + dx, ny = ty + dy;
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
      const j = ny * N + nx;
      if (cost[j] === Infinity) continue;
      let step = 1;
      if (dx && dy) {
        if (diag[ty * N + nx] || diag[ny * N + tx] || cost[j] !== 1) continue;
        step = 1.414;
      }
      const v = D[j] + step * cost[j];
      if (v < bestV) { bestV = v; best = j; }
    }
    if (best < 0) return null;
    const st = w.structs[best];
    if (st && STRUCTS[st.type].block) return { struct: st };
    return { x: (best % N) * TILE + TILE / 2, y: ((best / N) | 0) * TILE + TILE / 2 };
  },

  // ================= creature AI =================
  updateCreatures(dt) {
    const S = this.S, w = this.world, p = S.player;
    const list = S.creatures;
    for (const c of list) {
      if (c.dead) continue;
      const def = CREATURES[c.type];
      c.flash -= dt; c.hpShow -= dt; c.spikeCd -= dt; c.stun -= dt; c.buffT -= dt;
      if (c.spawnT > 0) c.spawnT -= dt * 1.5;
      let dvx = 0, dvy = 0;
      if (c.stun > 0) { c.state = 'stunned'; }
      else if (def.kind === 'prey') [dvx, dvy] = this.aiPrey(c, def, dt);
      else if (def.kind === 'boar') [dvx, dvy] = this.aiBoar(c, def, dt);
      else if (def.kind === 'fish') [dvx, dvy] = this.aiFish(c, def, dt);
      else [dvx, dvy] = this.aiPredator(c, def, dt);
      if (c.stun > 0) { dvx = 0; dvy = 0; }

      const rigid = c.state === 'strike' || c.state === 'pounce' || c.state === 'charge';
      if (rigid) { c.vx = dvx; c.vy = dvy; }
      else {
        const k = damp(def.kind === 'predator' ? 9 : 6, dt);
        c.vx = lerp(c.vx, dvx, k);
        c.vy = lerp(c.vy, dvy, k);
      }
      const ox = c.x, oy = c.y;
      c.x += (c.vx + c.kx) * dt;
      c.y += (c.vy + c.ky) * dt;
      c.kx *= Math.exp(-dt * 9);
      c.ky *= Math.exp(-dt * 9);
      if (c.type === 'fish') {
        if (!w.isWater(Math.floor(c.x / TILE), Math.floor(c.y / TILE))) { c.x = ox; c.y = oy; c.wdir += Math.PI * rand(0.6, 1.4); c.vx *= -0.5; c.vy *= -0.5; }
      } else {
        c.bump = w.collide(c, Math.min(def.r, 14), 'creature');
        c.x = clamp(c.x, TILE, WORLD_PX - TILE);
        c.y = clamp(c.y, TILE, WORLD_PX - TILE);
      }
      const moved = Math.hypot(c.x - ox, c.y - oy);
      c.moving = moved > 0.5;
      c.walk += moved * 0.16;
      c.progress = lerp(c.progress == null ? 1 : c.progress, moved / Math.max(0.001, Math.hypot(dvx, dvy) * dt), damp(4, dt));
      if (c.state !== 'windup' && c.state !== 'crouch' && c.state !== 'stunned') {
        const sp = Math.hypot(c.vx, c.vy);
        if (sp > 12) c.angle = approachAngle(c.angle, Math.atan2(c.vy, c.vx), (def.kind === 'predator' ? 12 : 8) * dt);
      }
    }
    // separation + player pushback
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a.dead || a.type === 'fish') continue;
      const ra = CREATURES[a.type].r;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (b.dead || b.type === 'fish') continue;
        const rb = CREATURES[b.type].r;
        const dx = b.x - a.x, dy = b.y - a.y;
        const min = (ra + rb) * 0.85;
        const d2 = dx * dx + dy * dy;
        if (d2 >= min * min || d2 < 0.0001) continue;
        const d = Math.sqrt(d2), push = (min - d) * 0.5;
        a.x -= (dx / d) * push; a.y -= (dy / d) * push;
        b.x += (dx / d) * push; b.y += (dy / d) * push;
      }
      if (!p.dead && !p.hidden) {
        const dx = a.x - p.x, dy = a.y - p.y;
        const min = ra + p.r - 2;
        const d2 = dx * dx + dy * dy;
        if (d2 < min * min && d2 > 0.0001) {
          const d = Math.sqrt(d2), push = min - d;
          a.x += (dx / d) * push * 0.7; a.y += (dy / d) * push * 0.7;
          p.x -= (dx / d) * push * 0.3; p.y -= (dy / d) * push * 0.3;
        }
      }
    }
    // remove dead / despawned
    for (let i = list.length - 1; i >= 0; i--) if (list[i].dead || list[i].remove) list.splice(i, 1);
  },

  wander(c, def, dt, speedMul = 1) {
    c.wt -= dt;
    if (c.wt <= 0) {
      c.wt = rand(1.5, 4.5);
      c.idle = chance(0.4);
      c.wdir += rand(-1.6, 1.6);
    }
    if (c.idle) return [0, 0];
    if (c.progress != null && c.progress < 0.25 && c.moving === false) c.wdir += Math.PI * 0.5;
    const sp = def.speed * speedMul;
    return [Math.cos(c.wdir) * sp, Math.sin(c.wdir) * sp];
  },

  aiPrey(c, def, dt) {
    const p = this.S.player;
    c.state = 'idle';
    const d = p.hidden || p.dead ? 9999 : dist(c.x, c.y, p.x, p.y);
    const sneaking = Math.hypot(p.vx, p.vy) < 60;
    const flee = def.flee * (sneaking ? 0.6 : 1);
    if (d < flee) c.fear = Math.max(c.fear, 1.4);
    // predators scare prey too
    if (this.S.phase === 'night' && chance(dt * 2)) {
      for (const o of this.S.creatures) if (CREATURES[o.type].kind === 'predator' && dist2(o.x, o.y, c.x, c.y) < 200 * 200) { c.fear = 3; c.fearFrom = o; break; }
    }
    if (c.fear > 0) {
      c.fear -= dt;
      c.state = 'flee';
      c.runT = (c.runT || 0) + dt;
      const src = c.fearFrom && !c.fearFrom.dead && c.fearFrom.type !== 'rabbit' ? c.fearFrom : p;
      let a = Math.atan2(c.y - src.y, c.x - src.x);
      if (c.type === 'rabbit') a += Math.sin(this.S.time * 7 + c.seed) * 0.7;
      if (c.progress != null && c.progress < 0.35) c.dodge = (c.dodge || 0) + dt;
      if (c.dodge > 0) { a += c.orbit * 1.4; c.dodge -= dt * 0.5; }
      if (c.fear <= 0) c.fearFrom = null;
      // prey tires after a few seconds of running, so a sprinting hunter can close in
      const tired = c.runT > 3 ? 0.62 : 1;
      if (tired < 1 && chance(dt * 2)) this.fx(c.x, c.y + 4, 1, { type: 'smoke', c: '170,150,120', s0: 5, s1: 15, life: 0.4, size: 4 });
      return [Math.cos(a) * def.run * tired, Math.sin(a) * def.run * tired];
    }
    c.runT = Math.max(0, (c.runT || 0) - dt * 0.5);
    // rabbits drift toward armed snares
    if (c.type === 'rabbit' && c.wt <= dt) {
      for (const s of this.S.structures) {
        if (s.type === 'snare' && s.armed && dist2(s.x, s.y, c.x, c.y) < 280 * 280) { c.wdir = Math.atan2(s.y - c.y, s.x - c.x); c.wt = rand(2, 4); c.idle = false; return [Math.cos(c.wdir) * def.speed, Math.sin(c.wdir) * def.speed]; }
      }
    }
    return this.wander(c, def, dt);
  },

  aiBoar(c, def, dt) {
    const p = this.S.player;
    const d = p.dead || p.hidden ? 9999 : dist(c.x, c.y, p.x, p.y);
    c.aggro -= dt;
    if (d < 70 && c.aggro <= 0) { c.annoy += dt; if (c.annoy > 1.8) { c.aggro = 6; c.annoy = 0; Sfx.play('snarl', { pitch: 0.7 }); } }
    else c.annoy = Math.max(0, c.annoy - dt);
    switch (c.state) {
      case 'windup': {
        c.st -= dt;
        c.angle = approachAngle(c.angle, Math.atan2(p.y - c.y, p.x - c.x), 10 * dt);
        if (chance(dt * 12)) this.fx(c.x - Math.cos(c.angle) * 14, c.y - Math.sin(c.angle) * 14, 1, { type: 'smoke', c: '150,130,100', s0: 10, s1: 30, life: 0.5, size: 5 });
        if (c.st <= 0) { c.state = 'charge'; c.st = 0.75; c.chargeAng = c.angle; c.hitDone = false; }
        return [0, 0];
      }
      case 'charge': {
        c.st -= dt;
        if (!c.hitDone && d < def.r + PLAYER.r + 6) {
          c.hitDone = this.hurtPlayer(def.dmg, c) || true;
        }
        if (c.progress != null && c.progress < 0.3 && c.st < 0.6) { c.stun = 1.4; c.state = 'recover'; c.st = 0; Render.shake(2); Sfx.play('thunk'); return [0, 0]; }
        if (c.st <= 0) { c.state = 'recover'; c.st = 0.9; }
        return [Math.cos(c.chargeAng) * def.charge, Math.sin(c.chargeAng) * def.charge];
      }
      case 'recover':
        c.st -= dt;
        if (c.st <= 0) c.state = 'idle';
        return [0, 0];
      default:
        if (c.aggro > 0 && d < 320) { c.state = 'windup'; c.st = 0.6; return [0, 0]; }
        c.state = 'idle';
        return this.wander(c, def, dt);
    }
  },

  aiFish(c, def, dt) {
    const p = this.S.player;
    const d = dist(c.x, c.y, p.x, p.y);
    if (d < 70 && !p.hidden) {
      c.fear = 1;
    }
    if (c.fear > 0) {
      c.fear -= dt;
      const a = Math.atan2(c.y - p.y, c.x - p.x);
      c.wdir = a;
      return [Math.cos(a) * def.run, Math.sin(a) * def.run];
    }
    c.wt -= dt;
    if (c.wt <= 0) { c.wt = rand(1, 3); c.wdir += rand(-1.2, 1.2); }
    return [Math.cos(c.wdir) * def.speed, Math.sin(c.wdir) * def.speed];
  },

  aiPredator(c, def, dt) {
    const S = this.S, p = S.player, w = this.world;
    const d = dist(c.x, c.y, p.x, p.y);
    c.atkCd -= dt;
    c.pounceCd -= dt;
    const speed = def.speed * (c.buffT > 0 ? 1.2 : 1) * (c.spawnT > 0 ? 0.6 : 1);

    if (c.flee) {
      c.state = 'flee';
      c.fleeT += dt;
      if ((d > 1000 && !this.onScreen(c.x, c.y)) || c.fleeT > 14) c.remove = true;
      const a = Math.atan2(c.y - p.y, c.x - p.x);
      return [Math.cos(a) * speed, Math.sin(a) * speed];
    }
    if (p.dead || p.hidden) { c.state = 'idle'; return this.wander(c, { speed: def.speed * 0.4 }, dt); }

    // alpha howls and calls the pack
    if (c.type === 'alpha') {
      c.howlT -= dt;
      if (c.howlT <= 0) {
        c.howlT = 10;
        Sfx.play('howl', { vol: 1.1, pitch: 0.75 });
        const preds = S.creatures.filter(o => CREATURES[o.type].kind === 'predator').length;
        if (preds < 16) {
          for (let i = 0; i < 2; i++) {
            const a = Math.random() * TAU;
            const sx = c.x + Math.cos(a) * 60, sy = c.y + Math.sin(a) * 60;
            if (w.tileOpen(Math.floor(sx / TILE), Math.floor(sy / TILE))) this.spawnPredator('wolf', sx, sy, c.night);
          }
        }
        for (const o of S.creatures) if (o.type === 'wolf' && dist2(o.x, o.y, c.x, c.y) < 320 * 320) { o.buffT = 5; o.brave = true; }
        this.fx(c.x, c.y, 1, { type: 'ring', c: '255,120,90', life: 0.7, size: 120 });
      }
    }

    c.losT -= dt;
    if (c.losT <= 0) {
      c.losT = rand(0.2, 0.32);
      c.los = d < 560 && w.lineClear(c.x, c.y, p.x, p.y);
    }
    const toP = Math.atan2(p.y - c.y, p.x - c.x);

    switch (c.state) {
      case 'windup': {
        c.st -= dt;
        if (!c.atkStruct) c.angle = approachAngle(c.angle, toP, 8 * dt);
        if (c.st <= 0) {
          if (c.atkStruct) {
            if (this.S.structures.includes(c.atkStruct)) this.damageStruct(c.atkStruct, def.structDmg);
            c.atkStruct = null;
            c.atkCd = def.cd * 0.8;
            c.state = 'hunt';
          } else {
            c.state = 'strike';
            c.st = 0.13;
            c.strikeAng = c.angle;
            c.hitDone = false;
            if (c.type === 'bear') Sfx.play('growl', { vol: 0.5, pitch: 1.3 });
            else Sfx.play('snarl', { pitch: c.type === 'alpha' ? 0.7 : 1 });
          }
        }
        return [0, 0];
      }
      case 'strike': {
        c.st -= dt;
        const reach = def.range + PLAYER.r + def.r * 0.5 + 8;
        if (!c.hitDone && d < reach && Math.abs(angleDiff(c.strikeAng, toP)) < 1.2) {
          c.hitDone = true;
          this.hurtPlayer(def.dmg, c);
        }
        if (c.st <= 0) {
          c.atkCd = def.cd;
          c.state = 'recover';
          c.st = c.type === 'wolf' || c.type === 'alpha' ? 0.4 : 0.25;
        }
        const ls = c.type === 'bear' ? 120 : 330;
        return [Math.cos(c.strikeAng) * ls, Math.sin(c.strikeAng) * ls];
      }
      case 'recover': {
        c.st -= dt;
        if (c.st <= 0) c.state = 'hunt';
        const back = c.type === 'bear' ? 0 : -speed * 0.7;
        return [Math.cos(toP) * back, Math.sin(toP) * back];
      }
      case 'crouch': {
        c.st -= dt;
        c.angle = approachAngle(c.angle, toP, 10 * dt);
        if (c.st <= 0) { c.state = 'pounce'; c.st = 0.32; c.strikeAng = c.angle; c.hitDone = false; Sfx.play('snarl', { pitch: 1.4 }); }
        return [0, 0];
      }
      case 'pounce': {
        c.st -= dt;
        if (!c.hitDone && d < def.r + PLAYER.r + 6) { c.hitDone = true; this.hurtPlayer(def.dmg, c); }
        if (c.st <= 0) { c.state = 'recover'; c.st = 0.6; c.pounceCd = 2.4; c.atkCd = 0.5; }
        return [Math.cos(c.strikeAng) * 560, Math.sin(c.strikeAng) * 560];
      }
      default: break;
    }

    // --- hunting ---
    let tx = p.x, ty = p.y, struct = null;
    const lit = this.lightLevel(p.x, p.y);
    const src = this._lightSrc;
    if (!def.brave && !c.brave && c.stalkT > 0 && lit > 0.42 && src && d < 520) {
      c.state = 'stalk';
      c.stalkT -= dt;
      if (c.stalkT <= 0) { c.brave = true; Sfx.play('snarl'); }
      const R = src.r * 0.78 + 20;
      const a = Math.atan2(c.y - src.y, c.x - src.x) + c.orbit * 0.5;
      tx = src.x + Math.cos(a) * R;
      ty = src.y + Math.sin(a) * R;
      if (chance(dt * 0.3)) Sfx.play('snarl', { vol: 0.4, pitch: 0.9 });
      const a2 = Math.atan2(ty - c.y, tx - c.x);
      return [Math.cos(a2) * speed * 0.6, Math.sin(a2) * speed * 0.6];
    }
    c.state = 'hunt';
    if (!(c.los && d < 420)) {
      const step = this.flowStep(c);
      if (step) {
        if (step.struct) struct = step.struct;
        else { tx = step.x; ty = step.y; }
      }
    }
    // stuck against a structure while chasing: attack it
    if (!struct && c.bump && STRUCTS[c.bump.type].block && !STRUCTS[c.bump.type].indestructible && c.progress < 0.4) struct = c.bump;

    if (def.pounce && c.los && d < 210 && d > 55 && c.pounceCd <= 0) {
      c.state = 'crouch';
      c.st = 0.45;
      return [0, 0];
    }
    if (d < def.range + PLAYER.r + def.r * 0.6 && c.atkCd <= 0) {
      c.state = 'windup';
      c.st = def.windup;
      c.atkStruct = null;
      return [0, 0];
    }
    if (struct) {
      const sd = dist(c.x, c.y, struct.x, struct.y);
      if (sd < def.r + TILE * 0.5 + 12 && c.atkCd <= 0) {
        c.state = 'windup';
        c.st = def.windup * 1.2;
        c.atkStruct = struct;
        c.angle = Math.atan2(struct.y - c.y, struct.x - c.x);
        return [0, 0];
      }
      tx = struct.x; ty = struct.y;
    }
    const a = Math.atan2(ty - c.y, tx - c.x);
    const slow = d < def.range + PLAYER.r + def.r ? 0.4 : 1;
    return [Math.cos(a) * speed * slow, Math.sin(a) * speed * slow];
  },

  // ================= arrows & drops =================
  updateArrows(dt) {
    const S = this.S, w = this.world;
    for (let i = S.arrows.length - 1; i >= 0; i--) {
      const a = S.arrows[i];
      let done = false;
      for (let sub = 0; sub < 2 && !done; sub++) {
        a.x += a.vx * dt * 0.5;
        a.y += a.vy * dt * 0.5;
        for (const c of S.creatures) {
          if (c.dead) continue;
          if (a.from === 'trap' && CREATURES[c.type].kind !== 'predator') continue;
          const r = CREATURES[c.type].r + 3;
          if (dist2(a.x, a.y, c.x, c.y) < r * r) {
            this.hurtCreature(c, a.dmg, Math.atan2(a.vy, a.vx), 150, a.from === 'player');
            Sfx.play('thunk');
            done = true;
            break;
          }
        }
        if (done) break;
        const tx = Math.floor(a.x / TILE), ty = Math.floor(a.y / TILE);
        const n = w.nodeAt(tx, ty);
        if (n && (n.kind === 'tree' || n.kind === 'rock') && dist2(a.x, a.y, n.x, n.y) < n.r * n.r) {
          done = true;
          Sfx.play('thunk', { vol: 0.5 });
          n.shake = 0.12;
          if (chance(0.5)) this.spawnDrops('arrow', 1, a.x - a.vx * 0.02, a.y - a.vy * 0.02);
        }
      }
      a.life -= dt;
      if (!done && a.life <= 0) {
        done = true;
        const tx = Math.floor(a.x / TILE), ty = Math.floor(a.y / TILE);
        if (w.isWater(tx, ty)) { this.fx(a.x, a.y, 5, { type: 'dot', c: '200,230,240', s0: 20, s1: 60, life: 0.4, size: 1.8 }); }
        else if (chance(0.6)) this.spawnDrops('arrow', 1, a.x, a.y);
      }
      if (done) S.arrows.splice(i, 1);
    }
  },

  updateDrops(dt) {
    const S = this.S, p = S.player;
    for (let i = S.drops.length - 1; i >= 0; i--) {
      const d = S.drops[i];
      d.t += dt;
      if (d.z > 0 || d.vz !== 0) {
        d.vz -= 700 * dt;
        d.z += d.vz * dt;
        if (d.z <= 0) { d.z = 0; d.vz = Math.abs(d.vz) > 60 ? -d.vz * 0.35 : 0; d.vx *= 0.6; d.vy *= 0.6; }
      }
      d.vx *= Math.exp(-dt * 3);
      d.vy *= Math.exp(-dt * 3);
      if (d.t > 0.35 && !p.dead && !p.hidden) {
        const dd = dist(d.x, d.y, p.x, p.y);
        if (dd < PLAYER.magnet) {
          const a = Math.atan2(p.y - d.y, p.x - d.x);
          const sp = 240 + (PLAYER.magnet - dd) * 9;
          d.vx = Math.cos(a) * sp; d.vy = Math.sin(a) * sp;
          if (dd < 16) {
            p.inv[d.item] = (p.inv[d.item] || 0) + 1;
            this.pickupText(d.item, 1);
            S.combo = (S.comboT > 0 ? (S.combo || 0) + 1 : 0);
            S.comboT = 0.4;
            Sfx.play('pickup', { pitch: 1 + Math.min(10, S.combo) * 0.05, gap: 0.02 });
            S.drops.splice(i, 1);
            UI.invDirty = true;
            continue;
          }
        }
      }
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      if (d.t > 150) S.drops.splice(i, 1);
    }
    S.comboT = (S.comboT || 0) - dt;
  },

  // ================= survival =================
  updateSurvival(dt) {
    const S = this.S, p = S.player, perks = S.perks;
    if (p.dead) return;
    p.hunger = Math.max(0, p.hunger - PLAYER.hungerRate * Math.pow(0.8, perks.stomach || 0) * dt);
    const heat = this.heatAt(p.x, p.y);
    const coldNight = S.phase === 'night' ? 1 : S.phase === 'dusk' ? S.phaseT / CYCLE.duskLen : S.phase === 'dawn' ? 1 - S.phaseT / CYCLE.dawnLen : 0;
    const winter = S.day >= 7 ? 0.35 : 0;
    const cold = Math.max(coldNight, winter);
    const coldRate = 1.4 * (1 + 0.06 * (S.day - 1)) * (p.gear.cloak ? 0.5 : 1) * Math.pow(0.75, perks.coat || 0);
    if (heat > 0) p.warmth = Math.min(100, p.warmth + 14 * heat * dt);
    else if (cold > 0.05) p.warmth = Math.max(0, p.warmth - coldRate * cold * dt);
    else p.warmth = Math.min(100, p.warmth + 2.5 * dt);
    if (p.hunger <= 0) p.hp -= 1.5 * dt;
    if (p.warmth <= 0) p.hp -= 2.2 * dt;
    if (p.hunger > 50 && p.warmth > 30 && p.hp < p.maxHp) p.hp = Math.min(p.maxHp, p.hp + 0.8 * dt);
    p.warnT -= dt;
    if (p.warnT <= 0) {
      if (p.hunger <= 0) { UI.toast('You are starving. Eat something (F).', 'bad', 'starve'); p.warnT = 8; }
      else if (p.warmth <= 0) { UI.toast('You are freezing. Get to a fire.', 'bad', 'freeze'); p.warnT = 8; }
      else if (p.hunger < 20) { UI.toast('You are getting hungry', 'info', 'hungry'); p.warnT = 20; }
      else if (p.warmth < 25) { UI.toast('You are getting cold', 'info', 'cold'); p.warnT = 20; }
    }
    if (p.hp <= 0) this.playerDown();
  },

  // ================= day / night =================
  phaseLen(phase) {
    const S = this.S;
    switch (phase || S.phase) {
      case 'day': return CYCLE.dayLen(S.day);
      case 'dusk': return CYCLE.duskLen;
      case 'night': return CYCLE.nightLen(S.day);
      default: return CYCLE.dawnLen;
    }
  },

  updateCycle(dt) {
    const S = this.S;
    S.phaseT += dt;
    if (S.phaseT >= this.phaseLen()) { S.phaseT = 0; this.nextPhase(); }
    if (S.phase === 'night' && S.wave) {
      const q = S.wave.queue;
      while (q.length && S.phaseT >= q[0].t) this.spawnGroup(q.shift().g);
    }
    const snowTarget = S.day >= 7 ? 0.75 : (S.day >= 4 && (S.phase === 'night' || S.phase === 'dusk')) ? 0.4 : 0;
    S.snow = lerp(S.snow, snowTarget, damp(0.3, dt));
  },

  nextPhase() {
    const S = this.S;
    if (S.phase === 'day') {
      S.phase = 'dusk';
      UI.banner('Dusk', 'Predators wake at nightfall. Feed your fire.');
      Sfx.play('howl', { vol: 0.5, pitch: 0.95 });
    } else if (S.phase === 'dusk') {
      S.phase = 'night';
      const desc = this.startWave();
      UI.banner(`Night ${S.day}`, desc);
      Sfx.play('night');
    } else if (S.phase === 'night') {
      S.phase = 'dawn';
      S.nights = S.day;
      this.endWave();
      UI.banner('Dawn', `You survived night ${S.day}.`);
      Sfx.play('dawn');
    } else {
      S.phase = 'day';
      S.day++;
      this.offerPerks();
    }
  },

  startWave() {
    const S = this.S, n = S.day, w = waveFor(n);
    const groups = [];
    let wolves = w.wolves;
    if (w.alpha) wolves = Math.max(0, wolves - 2);
    while (wolves > 0) {
      const k = Math.min(wolves, randi(2, 3));
      groups.push(Array(k).fill('wolf'));
      wolves -= k;
    }
    for (let i = 0; i < w.lynx; i++) groups.push(['lynx']);
    for (let i = 0; i < w.bears; i++) groups.push(['bear']);
    for (let i = groups.length - 1; i > 0; i--) { const j = randi(0, i); [groups[i], groups[j]] = [groups[j], groups[i]]; }
    const len = this.phaseLen('night');
    const queue = groups.map((g, i) => ({ t: 3 + (i / Math.max(1, groups.length)) * len * 0.55 + rand(0, 4), g }));
    if (w.alpha) queue.push({ t: len * 0.35, g: ['alpha', 'wolf', 'wolf'] });
    queue.sort((a, b) => a.t - b.t);
    S.wave = { queue };
    const parts = [];
    const nw = w.wolves;
    parts.push(`${nw} wolves`);
    if (w.lynx) parts.push(w.lynx === 1 ? 'a lynx' : `${w.lynx} lynx`);
    if (w.bears) parts.push(w.bears === 1 ? 'a bear' : `${w.bears} bears`);
    let txt = parts.length > 1 ? parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1] : parts[0];
    if (w.alpha) txt += ', led by an alpha';
    return `${txt[0].toUpperCase()}${txt.slice(1)} are coming. Survive until dawn.`;
  },

  spawnGroup(types) {
    const S = this.S, p = S.player, w = this.world;
    let spot = null;
    for (let tries = 0; tries < 30 && !spot; tries++) {
      const a = Math.random() * TAU, d = rand(760, 980);
      const x = p.x + Math.cos(a) * d, y = p.y + Math.sin(a) * d;
      const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
      if (!w.inBounds(tx, ty) || w.isEdge(tx, ty) || !w.tileOpen(tx, ty) || w.structAt(tx, ty)) continue;
      if (this.flow && !(this.flow[ty * w.N + tx] < Infinity)) continue;
      spot = { x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 };
    }
    if (!spot) spot = w.randomSpot(null, p.x, p.y, 600, 1100);
    if (!spot) return;
    for (const type of types) this.spawnPredator(type, spot.x + rand(-18, 18), spot.y + rand(-18, 18), true);
    if (types[0] === 'wolf' && chance(0.6)) Sfx.play('howl', { vol: 0.5, pitch: rand(0.9, 1.1) });
  },

  endWave() {
    const S = this.S;
    S.wave = null;
    for (const c of S.creatures) if (c.night && CREATURES[c.type].kind === 'predator') { c.flee = true; c.state = 'flee'; }
    UI.setBoss(null);
  },

  offerPerks() {
    const S = this.S, p = S.player;
    const avail = PERKS.filter(k => (S.perks[k.id] || 0) < k.max && (!k.needs || p.gear[k.needs]));
    for (let i = avail.length - 1; i > 0; i--) { const j = randi(0, i); [avail[i], avail[j]] = [avail[j], avail[i]]; }
    const choices = avail.slice(0, 3);
    if (!choices.length) { this.afterPerk(); return; }
    this.mode = 'perk';
    Input.releaseAll();
    UI.showPerks(choices, S.day - 1);
  },

  pickPerk(id) {
    const S = this.S, p = S.player;
    S.perks[id] = (S.perks[id] || 0) + 1;
    S.perkLog.push(id);
    if (id === 'vigor') { p.maxHp += 20; p.hp = p.maxHp; }
    Sfx.play('perk');
    UI.hidePerks();
    this.afterPerk();
  },

  afterPerk() {
    const S = this.S;
    this.mode = 'play';
    const tip = S.day === 4 ? 'Snow is coming. Nights will be colder.' : S.day === 7 ? 'Winter is here. Even days are cold now.' : 'Gather, hunt and build before dark.';
    UI.banner(`Day ${S.day}`, tip);
    this.save();
  },

  darkness() {
    const S = this.S;
    if (!S) return 0;
    if (this.mode === 'title') return 0.42;
    const k = clamp(S.phaseT / this.phaseLen(), 0, 1);
    switch (S.phase) {
      case 'dusk': return lerp(0, 0.86, ease.inOutSine(k));
      case 'night': return 0.86;
      case 'dawn': return lerp(0.86, 0, ease.inOutSine(k));
      default: return 0;
    }
  },

  ambientTint() {
    const S = this.S;
    if (this.mode === 'title') return [44, 24, 44];
    const k = clamp(S.phaseT / this.phaseLen(), 0, 1);
    const night = [6, 12, 32];
    if (S.phase === 'dusk') return [lerp(70, night[0], k), lerp(34, night[1], k), lerp(50, night[2], k)].map(Math.round);
    if (S.phase === 'dawn') return [lerp(night[0], 80, k), lerp(night[1], 46, k), lerp(night[2], 64, k)].map(Math.round);
    return night;
  },

  skyWash() {
    const S = this.S;
    if (!S) return null;
    if (this.mode === 'title') return 'rgba(255,128,60,0.10)';
    const k = clamp(S.phaseT / this.phaseLen(), 0, 1);
    if (S.phase === 'dusk') return `rgba(255,120,50,${(0.16 * Math.sin(k * Math.PI)).toFixed(3)})`;
    if (S.phase === 'dawn') return `rgba(255,170,140,${(0.14 * Math.sin(k * Math.PI)).toFixed(3)})`;
    if (S.phase === 'day') {
      const late = invLerp(0.8, 1, k) * 0.08;
      if (S.day >= 7) return `rgba(205,225,255,${0.09 + late})`;
      if (late > 0) return `rgba(255,170,90,${late})`;
    }
    return null;
  },

  // Clock shown in the HUD: day 06:30-18:30, dusk to 19:45, night to 05:15, dawn to 06:30.
  clockMinutes() {
    const S = this.S;
    const k = clamp(S.phaseT / this.phaseLen(), 0, 1);
    switch (S.phase) {
      case 'day': return 390 + k * 720;
      case 'dusk': return 1110 + k * 75;
      case 'night': return 1185 + k * 570;
      default: return 315 + k * 75;
    }
  },

  // ================= misc per-frame =================
  updateSpawns(dt) {
    const S = this.S, p = S.player;
    S.popT -= dt;
    if (S.popT <= 0) {
      S.popT = 3;
      this.populate(false);
      // daytime predators from day 3
      if (S.day >= 3 && S.phase === 'day') {
        S.dayPredT -= 3;
        if (S.dayPredT <= 0) {
          S.dayPredT = rand(45, 75);
          const dayPreds = S.creatures.filter(c => CREATURES[c.type].kind === 'predator' && !c.night).length;
          if (dayPreds < 2) {
            const spot = this.world.randomSpot([T_FOREST, T_GRASS], p.x, p.y, 750, 950);
            if (spot) {
              const type = S.day >= 5 && chance(0.3) ? 'lynx' : 'wolf';
              this.spawnPredator(type, spot.x, spot.y, false).brave = true;
              Sfx.play('howl', { vol: 0.35, pitch: 1.1 });
            }
          }
        }
      }
    }
  },

  updateFX(dt) {
    const S = this.S;
    const P = S.particles;
    for (let i = P.length - 1; i >= 0; i--) {
      const q = P[i];
      q.life -= dt;
      if (q.life <= 0) { P[i] = P[P.length - 1]; P.pop(); continue; }
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      const dr = Math.pow(q.drag, dt * 60);
      q.vx *= dr; q.vy *= dr;
      if (q.grav) {
        q.vz -= 520 * dt;
        q.z += q.vz * dt;
        if (q.z < 0) { q.z = 0; q.vz *= -0.3; q.vx *= 0.5; q.vy *= 0.5; if (Math.abs(q.vz) < 20) q.grav = false; }
      }
      q.rot += q.vr * dt;
    }
    const T = S.texts;
    for (let i = T.length - 1; i >= 0; i--) {
      const t = T[i];
      t.life -= dt;
      t.y -= 24 * dt;
      if (t.life <= 0) T.splice(i, 1);
    }
    // fireflies on warm nights
    const night = this.darkness();
    if (night > 0.5 && S.snow < 0.2 && chance(dt * 3)) {
      const p = S.player;
      const fly = P.filter(q => q.type === 'fly').length;
      if (fly < 22) {
        const a = Math.random() * TAU, d = rand(80, 420);
        const x = p.x + Math.cos(a) * d, y = p.y + Math.sin(a) * d;
        const t = this.world.tileAt(Math.floor(x / TILE), Math.floor(y / TILE));
        if (t === T_GRASS || t === T_FOREST) this.fx(x, y, 1, { type: 'fly', c: '220,255,140', s0: 5, s1: 18, life: 6, size: 2, glow: true, drag: 0.995 });
      }
    }
    for (const s of S.structures) if (s.t !== undefined) s.t += dt;
    for (const n of this.world.nodeList) if (n.shake > 0) n.shake -= dt;
  },

  updateCamera(dt, instant) {
    const p = this.S.player, cam = Render.cam;
    let tx = p.x, ty = p.y;
    if (!Input.touchMode && Input.mouse.has && this.mode === 'play') {
      tx += clamp((Input.mouse.x - Render.W / 2) / Render.scale * 0.16, -80, 80);
      ty += clamp((Input.mouse.y - Render.H / 2) / Render.scale * 0.16, -60, 60);
    } else {
      tx += p.vx * 0.22;
      ty += p.vy * 0.22;
    }
    const k = instant ? 1 : damp(6, dt);
    cam.x = lerp(cam.x, tx, k);
    cam.y = lerp(cam.y, ty, k);
    this.clampCamera();
  },

  clampCamera() {
    const cam = Render.cam;
    const hw = Render.W / 2 / Render.scale, hh = Render.H / 2 / Render.scale;
    cam.x = hw * 2 >= WORLD_PX ? WORLD_PX / 2 : clamp(cam.x, hw, WORLD_PX - hw);
    cam.y = hh * 2 >= WORLD_PX ? WORLD_PX / 2 : clamp(cam.y, hh, WORLD_PX - hh);
  },

  updateTips() {
    const S = this.S;
    if (S.tipIdx >= TIPS.length) { UI.setTip(null); return; }
    while (S.tipIdx < TIPS.length && TIPS[S.tipIdx].done(S)) {
      S.tipIdx++;
      if (S.tipIdx >= TIPS.length) { Store.set('tutorialDone', true); UI.toast('You know the basics. Good luck out there.', 'good'); }
      else Sfx.play('ui');
    }
    UI.setTip(S.tipIdx < TIPS.length ? TIPS[S.tipIdx] : null);
  },

  skipTips() {
    this.S.tipIdx = TIPS.length;
    Store.set('tutorialDone', true);
    UI.setTip(null);
  },

  ambientInfo() {
    const S = this.S;
    if (!S) return { night: 0, fire: 0, snow: 0 };
    const ref = this.mode === 'title' ? Render.cam : S.player;
    let fire = 0;
    for (const s of S.structures) {
      if (s.type !== 'campfire' || s.fuel <= 0) continue;
      fire = Math.max(fire, clamp(1 - dist(ref.x, ref.y, s.x, s.y) / 420, 0, 1) * (0.4 + s.fuel / 160));
    }
    return { night: this.darkness(), fire, snow: S.snow };
  },

  // ================= main update =================
  update(dt) {
    const S = this.S;
    if (!S) return;
    if (this.mode === 'title') { this.updateTitle(dt); return; }
    if (this.mode !== 'play') return;
    const raw = dt;
    if (this.hitstop > 0) { this.hitstop -= raw; dt *= 0.1; }
    S.time += dt;
    this.updateCycle(dt);
    this.updatePlayer(dt);
    this.updateBuild(dt);
    this.updateStructures(dt);
    this.updateFlow(dt);
    this.updateCreatures(dt);
    this.updateArrows(dt);
    this.updateDrops(dt);
    this.world.update(dt, S.player);
    this.updateSurvival(dt);
    this.updateSpawns(dt);
    this.updateFX(dt);
    this.updateCamera(raw);
    this.updateTips();
    if (S.player.dead) {
      S.deathT -= raw;
      if (S.deathT <= 0) this.gameOver();
    }
  },

  updateTitle(dt) {
    const S = this.S;
    this.titleT += dt;
    const c = WORLD_PX / 2;
    const a = this.titleT * 0.05;
    Render.cam.x = c + Math.cos(a) * 140;
    Render.cam.y = c + Math.sin(a) * 90 + 20;
    this.clampCamera();
    for (const s of S.structures) if (s.type === 'campfire') this.fireFx(s, dt);
    this.updateCreatures(dt);
    this.updateFX(dt);
  },

  // ================= flow control =================
  pause() {
    if (this.mode !== 'play') return;
    this.mode = 'paused';
    Input.releaseAll();
    this.save();
    UI.showPause(true);
  },
  resume() {
    if (this.mode !== 'paused') return;
    this.mode = 'play';
    UI.showPause(false);
  },

  gameOver() {
    const S = this.S;
    this.mode = 'over';
    Store.del('save');
    const best = Store.get('best', { nights: 0, kills: 0 });
    const isBest = S.nights > best.nights || (S.nights === best.nights && S.stats.kills > best.kills);
    if (isBest) Store.set('best', { nights: S.nights, kills: S.stats.kills, day: S.day });
    UI.showGameOver({ nights: S.nights, day: S.day, stats: S.stats, perks: S.perkLog, isBest, best: isBest ? { nights: S.nights } : best });
  },

  // ================= save / load =================
  serialize() {
    const S = this.S, p = S.player;
    return {
      v: 1, seed: S.seed, day: S.day, phase: S.phase, phaseT: S.phaseT, time: S.time, nights: S.nights,
      player: { x: p.x, y: p.y, hp: p.hp, maxHp: p.maxHp, hunger: p.hunger, warmth: p.warmth, stamina: p.stamina, inv: p.inv, gear: p.gear, aim: p.aim },
      perks: S.perks, perkLog: S.perkLog, stats: S.stats, flags: S.flags, tipIdx: S.tipIdx,
      structures: S.structures.map(s => ({ type: s.type, tx: s.tx, ty: s.ty, hp: s.hp, maxHp: s.maxHp, fuel: s.fuel, ammo: s.ammo, armed: s.armed })),
      nodes: this.world.serializeNodes(),
      creatures: S.creatures.filter(c => !c.dead).map(c => ({ type: c.type, x: c.x, y: c.y, hp: c.hp, maxHp: c.maxHp, night: c.night, flee: c.flee, antlers: c.antlers, brave: c.brave })),
      wave: S.wave ? { queue: S.wave.queue } : null,
      drops: S.drops.map(d => ({ item: d.item, x: Math.round(d.x), y: Math.round(d.y) })),
      snow: S.snow,
    };
  },

  save() {
    if (!this.S || this.mode === 'over' || this.mode === 'title' || this.S.player.dead) return;
    Store.set('save', this.serialize());
  },

  hasSave() {
    const s = Store.get('save', null);
    return !!(s && s.v === 1 && s.seed != null);
  },

  load(data) {
    try {
      this.world = new World(data.seed);
      Render.setWorld(this.world);
      this.S = this.freshState(data.seed);
      const S = this.S;
      Object.assign(S, { day: data.day, phase: data.phase, phaseT: data.phaseT, time: data.time, nights: data.nights || 0,
        perks: data.perks || {}, perkLog: data.perkLog || [], stats: Object.assign(S.stats, data.stats), flags: data.flags || {}, tipIdx: data.tipIdx || 0, snow: data.snow || 0 });
      Object.assign(S.player, data.player);
      S.player.inv = Object.assign({}, S.player.inv, data.player.inv);
      S.player.gear = Object.assign({}, data.player.gear);
      this.world.loadNodes(data.nodes);
      const perksSaved = S.perks;
      for (const s of data.structures) {
        S.perks = {};
        this.addStruct(s.type, s.tx, s.ty, { hp: s.hp, maxHp: s.maxHp, fuel: s.fuel, ammo: s.ammo, armed: s.armed });
      }
      S.perks = perksSaved;
      for (const c of data.creatures) this.makeCreature(c.type, c.x, c.y, { hp: c.hp, maxHp: c.maxHp, night: c.night, flee: c.flee, antlers: c.antlers, brave: c.brave, state: c.flee ? 'flee' : CREATURES[c.type].kind === 'predator' ? 'hunt' : 'idle' });
      if (data.wave) S.wave = { queue: data.wave.queue };
      for (const d of data.drops || []) S.drops.push({ item: d.item, x: d.x, y: d.y, vx: 0, vy: 0, z: 0, vz: 0, t: 1, seed: Math.random() * 10 });
      for (const c of S.creatures) if (c.type === 'alpha' && !c.flee) UI.setBoss(c);
      this.flow = null;
      this.flowKey = '';
      return true;
    } catch (e) {
      console.warn('Could not load save', e);
      return false;
    }
  },
};
