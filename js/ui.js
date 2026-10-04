'use strict';
// HTML overlay: HUD, panels, menus. The canvas draws the world; everything readable lives here.

const $ = id => document.getElementById(id);

const UI = {
  invDirty: true,
  craftOpen: false,
  craftT: 0,
  dialT: 0,
  toastKeys: {},
  bossC: null,
  hurtV: 0,
  lastTip: null,

  init() {
    // fill every icon placeholder
    document.querySelectorAll('img[data-icon]').forEach(img => { img.src = Sprites.iconURL[img.dataset.icon] || ''; });

    this.el = {
      hud: $('hud'), inv: $('inv'), prompt: $('prompt'), promptKey: $('prompt-key'), promptText: $('prompt-text'),
      toasts: $('toasts'), banner: $('banner'), boss: $('boss'), craft: $('craft'), craftList: $('craft-list'), craftBench: $('craft-bench'),
      buildbar: $('buildbar'), buildList: $('build-list'), buildInfo: $('build-info'), tip: $('tip'), tipText: $('tip-text'), tipKey: $('tip-key'),
      dayLabel: $('day-label'), clockTime: $('clock-time'), phaseLabel: $('phase-label'), dial: $('dial'),
      hurt: $('hurt'), vignette: $('vignette'), touch: $('touch'),
      perks: $('perks'), perkList: $('perk-list'), perkTitle: $('perk-title'),
      title: $('title'), pause: $('pause'), over: $('over'), help: $('help'),
    };
    this.bars = {};
    for (const k of ['hp', 'food', 'warm']) {
      const b = $('bar-' + k);
      this.bars[k] = { root: b, fill: b.querySelector('.fill'), num: b.querySelector('.num'), last: -1 };
    }

    this.buildCraftList();
    this.buildBuildBar();

    // HUD buttons
    $('btn-craft').addEventListener('click', () => { Sfx.play('ui'); this.toggleCraft(); });
    $('btn-build').addEventListener('click', () => { Sfx.play('ui'); this.toggleBuild(); });
    $('btn-pause').addEventListener('click', () => Game.pause());
    $('craft-close').addEventListener('click', () => this.toggleCraft(false));
    $('tip-skip').addEventListener('click', () => Game.skipTips());

    // menus
    $('btn-new').addEventListener('click', () => this.newRun());
    $('btn-continue').addEventListener('click', () => this.continueRun());
    $('btn-help').addEventListener('click', () => this.showHelp(true));
    $('btn-help2').addEventListener('click', () => this.showHelp(true));
    $('help-close').addEventListener('click', () => this.showHelp(false));
    $('btn-resume').addEventListener('click', () => Game.resume());
    $('btn-sound').addEventListener('click', () => this.toggleMute());
    $('btn-quit').addEventListener('click', () => this.quitToTitle());
    $('btn-again').addEventListener('click', () => this.newRun());
    $('btn-title').addEventListener('click', () => this.quitToTitle());

    // touch controls
    Input.bindJoystick($('joy-zone'), $('joy-base'), $('joy-knob'));
    document.querySelectorAll('#actions .tbtn').forEach(b => Input.bindButton(b, b.dataset.act));
    Input.onModeChange = on => this.applyTouchMode(on);
    this.applyTouchMode(Input.touchMode);

    // stop HUD clicks from leaking into the game view
    for (const id of ['hud-top', 'craft', 'buildbar', 'actions']) {
      const e = $(id);
      if (e) e.addEventListener('pointerdown', ev => ev.stopPropagation());
    }

    Sfx.muted = !!Store.get('muted', false);
    this.syncSoundButton();
    this.refreshTitle();
  },

  applyTouchMode(on) {
    document.body.classList.toggle('touch', on);
    this.el.touch.hidden = !on;
    this.refreshBuild();
  },

  // ---------- title / menus ----------
  refreshTitle() {
    const best = Store.get('best', null);
    const line = $('best-line');
    if (best && best.nights > 0) line.textContent = `Longest run: ${best.nights} ${best.nights === 1 ? 'night' : 'nights'} · ${best.kills} predators`;
    else line.textContent = 'No runs yet. The first night is the hardest.';
    const save = Store.get('save', null);
    const c = $('btn-continue');
    if (save && save.v === 1) {
      c.hidden = false;
      c.textContent = `Continue · Day ${save.day}`;
    } else c.hidden = true;
  },

  showTitle() {
    this.el.title.hidden = false;
    this.el.hud.hidden = true;
    this.el.over.hidden = true;
    this.el.pause.hidden = true;
    this.el.perks.hidden = true;
    this.refreshTitle();
  },

  newRun() {
    Sfx.init();
    Sfx.play('ui');
    if (Game.mode !== 'title') Game.newWorld((Math.random() * 1e9) >>> 0);
    Store.del('save');
    this.el.title.hidden = true;
    this.el.over.hidden = true;
    Game.startRun();
  },

  continueRun() {
    Sfx.init();
    Sfx.play('ui');
    const save = Store.get('save', null);
    if (!save || !Game.load(save)) { this.toast('That save could not be loaded', 'bad'); Store.del('save'); this.refreshTitle(); return; }
    this.el.title.hidden = true;
    Game.mode = 'play';
    Game.updateCamera(0, true);
    this.onRunStart();
    this.banner(`Day ${Game.S.day}`, 'Welcome back.');
  },

  quitToTitle() {
    Game.save();
    this.showHelp(false);
    this.toggleCraft(false);
    Game.setBuild(null);
    Game.newWorld((Math.random() * 1e9) >>> 0);
    Game.mode = 'title';
    Game.titleT = 0;
    this.setBoss(null);
    this.showTitle();
  },

  onRunStart() {
    this.el.hud.hidden = false;
    this.el.pause.hidden = true;
    this.el.toasts.innerHTML = '';
    this.toastKeys = {};
    this.invDirty = true;
    this.lastTip = null;
    this.toggleCraft(false);
    this.refreshBuild();
    this.hurtV = 0;
  },

  showPause(on) {
    this.el.pause.hidden = !on;
    if (on) {
      const S = Game.S;
      $('pause-sub').textContent = `Day ${S.day} · ${fmtClock(Game.clockMinutes())} · progress is saved`;
      this.syncSoundButton();
    }
  },

  showHelp(on) {
    this.el.help.hidden = !on;
    document.body.classList.toggle('help-open', on);
  },

  toggleMute() {
    Sfx.setMuted(!Sfx.muted);
    Store.set('muted', Sfx.muted);
    this.syncSoundButton();
    this.toast(Sfx.muted ? 'Sound off' : 'Sound on', 'info', 'mute');
  },
  syncSoundButton() {
    const b = $('btn-sound');
    if (b) b.textContent = Sfx.muted ? 'Sound: off' : 'Sound: on';
  },

  showGameOver(info) {
    const o = this.el.over;
    this.el.hud.hidden = true;
    this.toggleCraft(false);
    $('over-title').textContent = info.nights === 0 ? 'You did not see the dawn' : `You lasted ${info.nights} ${info.nights === 1 ? 'night' : 'nights'}`;
    const bn = info.best.nights;
    $('over-best').textContent = info.isBest && info.nights > 0 ? 'A new personal best.'
      : bn > 0 ? `Your best is ${bn} ${bn === 1 ? 'night' : 'nights'}.` : 'Make it to the first dawn to set a record.';
    const st = info.stats;
    $('st-kills').textContent = st.predators;
    $('st-hunted').textContent = st.hunted;
    $('st-fish').textContent = st.fish;
    $('st-built').textContent = st.built;
    $('st-crafted').textContent = st.crafted;
    $('st-gathered').textContent = st.gathered;
    const perks = $('over-perks');
    perks.innerHTML = '';
    if (info.perks.length) {
      const counts = {};
      for (const id of info.perks) counts[id] = (counts[id] || 0) + 1;
      for (const id in counts) {
        const p = PERKS.find(x => x.id === id);
        const s = document.createElement('span');
        s.className = 'tag';
        s.textContent = counts[id] > 1 ? `${p.name} ×${counts[id]}` : p.name;
        perks.appendChild(s);
      }
    }
    o.hidden = false;
  },

  // ---------- perks ----------
  showPerks(choices, night) {
    this.toggleCraft(false);
    Game.setBuild(null);
    this.el.perkTitle.textContent = `You survived night ${night}`;
    const list = this.el.perkList;
    list.innerHTML = '';
    const roman = ['I', 'II', 'III', 'IV'];
    choices.forEach((pk, i) => {
      const lvl = (Game.S.perks[pk.id] || 0) + 1;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'perk';
      b.innerHTML = `<span class="perk-rank">${roman[lvl - 1]}<small>of ${roman[pk.max - 1]}</small></span>
        <span class="perk-name"></span><span class="perk-desc"></span><kbd>${i + 1}</kbd>`;
      b.querySelector('.perk-name').textContent = pk.name;
      b.querySelector('.perk-desc').textContent = pk.desc;
      b.addEventListener('click', () => Game.pickPerk(pk.id));
      list.appendChild(b);
    });
    this.perkChoices = choices;
    this.el.perks.hidden = false;
  },
  hidePerks() { this.el.perks.hidden = true; this.perkChoices = null; },

  // ---------- craft ----------
  buildCraftList() {
    const list = this.el.craftList;
    list.innerHTML = '';
    this.recipeEls = {};
    for (const r of RECIPES) {
      const row = document.createElement('div');
      row.className = 'recipe';
      const iconId = r.gear || r.item;
      const name = r.gear ? GEAR[r.gear].name : `${ITEMS[r.item].name}${r.n > 1 ? ' ×' + r.n : ''}`;
      row.innerHTML = `<img class="ricon" alt="" src="${Sprites.iconURL[iconId]}">
        <div class="rbody"><div class="rname"><span></span>${r.bench ? '<em class="req">Workbench</em>' : ''}</div>
        <div class="rdesc"></div><div class="rcost"></div></div>
        <button type="button" class="rbtn">Craft</button>`;
      row.querySelector('.rname span').textContent = name;
      row.querySelector('.rdesc').textContent = r.desc;
      const cost = row.querySelector('.rcost');
      const costEls = {};
      for (const k in r.cost) {
        const c = document.createElement('span');
        c.className = 'cost';
        c.innerHTML = `<img alt="" src="${Sprites.iconURL[k]}"><b></b>`;
        c.title = ITEMS[k].name;
        cost.appendChild(c);
        costEls[k] = c;
      }
      const btn = row.querySelector('.rbtn');
      btn.addEventListener('click', () => Game.craft(r.id));
      list.appendChild(row);
      this.recipeEls[r.id] = { row, btn, costEls };
    }
  },

  toggleCraft(force) {
    const open = force === undefined ? !this.craftOpen : force;
    if (open && Game.mode !== 'play') return;
    this.craftOpen = open;
    this.el.craft.hidden = !open;
    $('btn-craft').classList.toggle('on', open);
    if (open) { if (Game.S && Game.S.build) Game.setBuild(null); this.setBuildBar(false); this.refreshCraft(); }
  },

  refreshCraft() {
    if (!this.craftOpen || !Game.S) return;
    const inv = Game.S.player.inv;
    const near = Game.nearBench();
    this.el.craftBench.textContent = near ? 'At workbench' : Game.hasBench() ? 'Workbench out of reach' : '';
    for (const r of RECIPES) {
      const e = this.recipeEls[r.id];
      const why = Game.craftReason(r);
      const owned = why === 'Owned';
      e.row.classList.toggle('owned', owned);
      e.row.classList.toggle('ready', !why);
      e.btn.disabled = !!why;
      e.btn.textContent = owned ? 'Owned' : 'Craft';
      e.btn.title = why || '';
      for (const k in r.cost) {
        const have = inv[k] || 0;
        const el = e.costEls[k];
        el.querySelector('b').textContent = `${Math.min(have, r.cost[k])}/${r.cost[k]}`;
        el.classList.toggle('short', have < r.cost[k] && !owned);
      }
      e.row.classList.toggle('locked', !!r.bench && !near && !owned);
    }
  },

  // ---------- build ----------
  buildBuildBar() {
    const list = this.el.buildList;
    list.innerHTML = '';
    this.buildEls = {};
    BUILD_ORDER.forEach((id, i) => {
      const def = STRUCTS[id];
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'bcard';
      const key = i < 9 ? i + 1 : 0;
      b.innerHTML = `<kbd>${key}</kbd><img alt="" src="${Sprites.iconURL[id]}"><span class="bname"></span><span class="bcost"></span>`;
      b.querySelector('.bname').textContent = def.name;
      const cost = b.querySelector('.bcost');
      for (const k in def.cost) {
        const c = document.createElement('span');
        c.innerHTML = `<img alt="" src="${Sprites.iconURL[k]}">${def.cost[k]}`;
        c.dataset.item = k;
        cost.appendChild(c);
      }
      b.addEventListener('click', () => { Sfx.play('ui'); Game.setBuild(Game.S.build && Game.S.build.id === id ? null : id); });
      b.addEventListener('pointerenter', () => this.showBuildInfo(id));
      b.addEventListener('pointerleave', () => this.showBuildInfo(null));
      list.appendChild(b);
      this.buildEls[id] = b;
    });
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'bcard remove';
    rm.innerHTML = `<kbd>X</kbd><img alt="" src="${Sprites.iconURL.demolish}"><span class="bname">Remove</span><span class="bcost">Refunds half</span>`;
    rm.addEventListener('click', () => { Sfx.play('ui'); Game.setBuild(Game.S.build && Game.S.build.id === 'demolish' ? null : 'demolish'); });
    list.appendChild(rm);
    this.buildEls.demolish = rm;
    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'bdone';
    done.textContent = 'Done';
    done.addEventListener('click', () => { Game.setBuild(null); this.setBuildBar(false); });
    list.appendChild(done);
  },

  showBuildInfo(id) {
    const info = this.el.buildInfo;
    if (!id) { this.buildInfoId = null; return; }
    this.buildInfoId = id;
  },

  setBuildBar(on) {
    this.buildOpen = on;
    this.el.buildbar.hidden = !on;
    $('btn-build').classList.toggle('on', on);
    document.body.classList.toggle('building', on);
    if (Input._joyRest && Input.joy.id === null) requestAnimationFrame(Input._joyRest);
    if (!on && Game.S && Game.S.build) Game.setBuild(null);
    if (on) this.refreshBuild();
  },

  toggleBuild(force) {
    const open = force === undefined ? !this.buildOpen : force;
    if (open && Game.mode !== 'play') return;
    if (open) this.toggleCraft(false);
    this.setBuildBar(open);
  },

  refreshBuild() {
    if (!this.buildEls || !Game.S) return;
    const S = Game.S, inv = S.player.inv;
    const cur = S.build && S.build.id;
    const bench = Game.hasBench();
    for (const id in this.buildEls) {
      const b = this.buildEls[id];
      b.classList.toggle('on', cur === id);
      if (id === 'demolish') continue;
      const def = STRUCTS[id];
      const locked = def.bench && !bench;
      b.classList.toggle('locked', locked);
      b.classList.toggle('short', !!Game.missing(def.cost));
      b.querySelectorAll('.bcost span').forEach(s => s.classList.toggle('short', (inv[s.dataset.item] || 0) < def.cost[s.dataset.item]));
    }
    if (cur && !this.buildOpen) this.setBuildBar(true);
  },

  updateBuildInfo() {
    const S = Game.S;
    const info = this.el.buildInfo;
    const id = this.buildInfoId || (S.build && S.build.id);
    let text = '';
    if (id === 'demolish') text = Input.touchMode ? 'Tap something you built to take it down.' : 'Click something you built to take it down. Right click or Esc to stop.';
    else if (id) {
      const def = STRUCTS[id];
      const gh = Game.ghost;
      const reason = S.build && S.build.id === id && gh && !gh.ok ? gh.reason : (def.bench && !Game.hasBench() ? 'Build a workbench first' : null);
      text = `${def.name}: ${def.desc}${reason ? ' · ' + reason : ''}`;
    } else text = Input.touchMode ? 'Pick something to build, then tap the ground.' : 'Pick something to build (1-0), then click the ground. Hold and drag for walls.';
    if (info.textContent !== text) info.textContent = text;
  },

  // ---------- inventory ----------
  renderInv() {
    const S = Game.S, inv = S.player.inv, gear = S.player.gear;
    const root = this.el.inv;
    const want = [];
    for (const g of GEAR_ORDER) if (gear[g]) want.push({ id: g, gear: true });
    for (const k of INV_ORDER) if (inv[k] > 0 || ALWAYS_SHOWN.includes(k)) want.push({ id: k, n: inv[k] || 0 });
    const sig = want.map(w => w.id + ':' + (w.n == null ? 'g' : w.n)).join(',');
    if (sig === this.invSig) return;
    const prev = this.invCounts || {};
    this.invSig = sig;
    root.innerHTML = '';
    const counts = {};
    let addedDivider = false;
    for (const w of want) {
      if (!w.gear && !addedDivider && want[0].gear) {
        const d = document.createElement('span');
        d.className = 'divider';
        root.appendChild(d);
        addedDivider = true;
      }
      const c = document.createElement('div');
      c.className = w.gear ? 'chip gear' : 'chip';
      c.title = w.gear ? GEAR[w.id].name : ITEMS[w.id].name;
      c.innerHTML = `<img alt="" src="${Sprites.iconURL[w.id]}">${w.gear ? '' : `<span>${w.n}</span>`}`;
      if (!w.gear) {
        counts[w.id] = w.n;
        if (prev[w.id] != null && w.n > prev[w.id]) c.classList.add('bump');
        if (w.n === 0) c.classList.add('empty');
      }
      root.appendChild(c);
    }
    this.invCounts = counts;
  },

  // ---------- per-frame ----------
  update(dt) {
    const S = Game.S;
    // hurt overlay decay
    if (this.hurtV > 0) {
      this.hurtV = Math.max(0, this.hurtV - dt * 1.6);
      this.el.hurt.style.opacity = this.hurtV.toFixed(3);
    }
    if (!S || Game.mode === 'title' || this.el.hud.hidden) return;
    const p = S.player;
    // bars
    this.setBar('hp', p.hp, p.maxHp);
    this.setBar('food', p.hunger, 100);
    this.setBar('warm', p.warmth, 100);
    this.bars.warm.root.classList.toggle('cold', p.warmth < 35);
    this.bars.hp.root.classList.toggle('low', p.hp < p.maxHp * 0.3);
    this.bars.food.root.classList.toggle('low', p.hunger < 20);
    // low health vignette
    const low = clamp(1 - p.hp / (p.maxHp * 0.35), 0, 1);
    this.el.vignette.style.setProperty('--low', low.toFixed(2));
    // clock
    this.dialT -= dt;
    if (this.dialT <= 0) {
      this.dialT = 0.25;
      this.drawDial();
      const left = Game.phaseLen() - S.phaseT;
      let label;
      if (S.phase === 'day') label = `Dusk in ${fmtDuration(left)}`;
      else if (S.phase === 'dusk') label = `Night in ${fmtDuration(left)}`;
      else if (S.phase === 'night') label = `Dawn in ${fmtDuration(left)}`;
      else label = 'Sunrise';
      this.el.dayLabel.textContent = S.phase === 'night' || S.phase === 'dusk' ? `Night ${S.day}` : `Day ${S.day}`;
      this.el.clockTime.textContent = fmtClock(Game.clockMinutes());
      this.el.phaseLabel.textContent = label;
      document.body.classList.toggle('night', S.phase === 'night');
    }
    // inventory
    if (this.invDirty) { this.invDirty = false; this.renderInv(); this.refreshBuild(); }
    // craft panel live state
    if (this.craftOpen) {
      this.craftT -= dt;
      if (this.craftT <= 0) { this.craftT = 0.2; this.refreshCraft(); }
    }
    if (this.buildOpen) this.updateBuildInfo();
    // prompt
    const it = Game.interactTarget;
    const pr = this.el.prompt;
    if (it && !S.build && !p.dead) {
      pr.hidden = false;
      pr.classList.toggle('disabled', !!it.disabled);
      if (this.el.promptText.textContent !== it.label) this.el.promptText.textContent = it.label;
      this.el.promptKey.textContent = Input.touchMode ? 'Use' : 'E';
    } else pr.hidden = true;
    // touch buttons
    if (Input.touchMode) {
      $('t-shoot').hidden = !p.gear.bow;
      if (p.gear.bow) $('t-shoot').querySelector('.cnt').textContent = p.inv.arrow;
      const food = FOOD_ITEMS.reduce((a, k) => a + (p.inv[k] || 0), 0);
      $('t-eat').querySelector('.cnt').textContent = food || '';
      $('t-eat').classList.toggle('dim', !food);
      $('t-heal').hidden = !p.inv.bandage;
      $('t-heal').querySelector('.cnt').textContent = p.inv.bandage || '';
      $('t-use').classList.toggle('ready', !!(it && !it.disabled));
      const swingIcon = Game.weaponId();
      if (this.swingIcon !== swingIcon) { this.swingIcon = swingIcon; $('t-swing').querySelector('img').src = Sprites.iconURL[swingIcon === 'fist' ? 'use' : swingIcon]; }
    }
    // boss
    if (this.bossC) {
      if (this.bossC.dead || !S.creatures.includes(this.bossC)) this.setBoss(null);
      else this.el.boss.querySelector('.boss-fill').style.width = `${clamp(this.bossC.hp / this.bossC.maxHp, 0, 1) * 100}%`;
    }
    // perk hotkeys
    if (Game.mode === 'perk' && this.perkChoices) {
      ['Digit1', 'Digit2', 'Digit3'].forEach((k, i) => { if (Input.hit(k) && this.perkChoices[i]) Game.pickPerk(this.perkChoices[i].id); });
    }
  },

  setBar(k, v, max) {
    const b = this.bars[k];
    const pct = clamp(v / max, 0, 1);
    const r = Math.round(pct * 1000);
    if (r === b.last) return;
    b.last = r;
    b.fill.style.transform = `scaleX(${pct.toFixed(3)})`;
    b.num.textContent = Math.ceil(Math.max(0, v));
  },

  // 24-hour dial: daylight arc, night arc, and a marker for now.
  drawDial() {
    const c = this.el.dial, g = c.getContext('2d');
    const W = c.width, R = W / 2 - 6;
    g.clearRect(0, 0, W, W);
    g.save();
    g.translate(W / 2, W / 2);
    const toA = m => (m / 1440) * TAU + Math.PI / 2;  // midnight at the bottom
    g.lineWidth = 7;
    g.lineCap = 'butt';
    const arc = (m0, m1, col) => { g.strokeStyle = col; g.beginPath(); g.arc(0, 0, R, toA(m0), toA(m1)); g.stroke(); };
    arc(390, 1110, '#e9c46a');
    arc(1110, 1185, '#e07a3f');
    arc(1185, 1440 + 315, '#2c3e66');
    arc(315, 390, '#d98a8a');
    const now = Game.clockMinutes();
    const a = toA(now);
    const night = Game.S.phase === 'night' || Game.S.phase === 'dusk';
    g.fillStyle = night ? '#dfe7ff' : '#ffd25e';
    g.strokeStyle = '#0e1714';
    g.lineWidth = 3;
    g.beginPath(); g.arc(Math.cos(a) * R, Math.sin(a) * R, 8, 0, TAU); g.stroke(); g.fill();
    if (night) { g.fillStyle = '#16231e'; g.beginPath(); g.arc(Math.cos(a) * R + 3.5, Math.sin(a) * R - 2.5, 6, 0, TAU); g.fill(); }
    g.fillStyle = 'rgba(236,228,210,0.85)';
    g.font = '700 15px "Barlow Semi Condensed", "Arial Narrow", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const S = Game.S;
    const wv = S.phase === 'night' ? S.creatures.filter(cr => cr.night && !cr.flee && CREATURES[cr.type].kind === 'predator').length : null;
    if (wv != null) {
      g.fillText(String(wv), 0, -3);
      g.font = '600 9px "Barlow Semi Condensed", "Arial Narrow", sans-serif';
      g.fillStyle = 'rgba(236,228,210,0.6)';
      g.fillText('HUNTING', 0, 10);
    } else {
      g.fillText(String(S.day), 0, -3);
      g.font = '600 9px "Barlow Semi Condensed", "Arial Narrow", sans-serif';
      g.fillStyle = 'rgba(236,228,210,0.6)';
      g.fillText('DAY', 0, 10);
    }
    g.restore();
  },

  // ---------- messages ----------
  toast(text, kind = 'info', key) {
    if (!this.el) return;
    const now = performance.now();
    if (key && this.toastKeys[key] && now - this.toastKeys[key] < 2500) return;
    if (key) this.toastKeys[key] = now;
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.textContent = text;
    this.el.toasts.appendChild(t);
    while (this.el.toasts.children.length > 4) this.el.toasts.firstChild.remove();
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, 2600);
  },

  banner(title, sub) {
    const b = this.el.banner;
    b.querySelector('.banner-title').textContent = title;
    b.querySelector('.banner-sub').textContent = sub || '';
    b.hidden = false;
    b.classList.remove('show');
    void b.offsetWidth;
    b.classList.add('show');
    clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => { b.hidden = true; }, 4200);
  },

  hurt(k) {
    this.hurtV = Math.min(0.85, this.hurtV + 0.35 + k * 0.5);
    this.el.hurt.style.opacity = this.hurtV.toFixed(3);
  },

  setTip(tip) {
    if (tip === this.lastTip) return;
    this.lastTip = tip;
    if (!tip) { this.el.tip.hidden = true; return; }
    this.el.tip.hidden = false;
    this.el.tipText.textContent = tip.text;
    this.el.tipKey.textContent = tip.key[Input.touchMode ? 1 : 0];
    this.el.tip.classList.remove('fresh');
    void this.el.tip.offsetWidth;
    this.el.tip.classList.add('fresh');
  },

  setBoss(c) {
    this.bossC = c;
    this.el.boss.hidden = !c;
    if (c) this.el.boss.querySelector('.boss-name').textContent = CREATURES[c.type].name;
  },
};
