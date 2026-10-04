'use strict';
// Keyboard, mouse and touch input. Game code reads this state once per frame.

const Input = {
  keys: new Set(),
  pressed: new Set(),
  mouse: { x: 0, y: 0, has: false, left: false, right: false, leftPressed: false, rightPressed: false },
  touchMode: false,
  joy: { id: null, bx: 0, by: 0, dx: 0, dy: 0, mag: 0 },
  held: {},              // touch buttons currently held
  tapped: new Set(),     // touch buttons pressed this frame
  worldTouch: null,      // { id, x, y, pressed } finger on the game view (used to place buildings)
  onModeChange: null,
  JOY_R: 56,

  init(canvas) {
    const block = new Set(['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyF', 'KeyQ', 'KeyE']);
    window.addEventListener('keydown', e => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (block.has(e.code)) e.preventDefault();
      if (!e.repeat) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (this.touchMode) this.setTouchMode(false);
    });
    window.addEventListener('keyup', e => { this.keys.delete(e.code); });
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.releaseAll(); });

    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('pointerdown', e => {
      if (e.pointerType === 'touch') {
        this.setTouchMode(true);
        if (!this.worldTouch) {
          this.worldTouch = { id: e.pointerId, x: e.clientX, y: e.clientY, pressed: true };
          try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        }
        e.preventDefault();
        return;
      }
      if (this.touchMode && e.pointerType === 'mouse') this.setTouchMode(false);
      this.mouse.x = e.clientX; this.mouse.y = e.clientY; this.mouse.has = true;
      if (e.button === 0) { this.mouse.left = true; this.mouse.leftPressed = true; }
      if (e.button === 2) { this.mouse.right = true; this.mouse.rightPressed = true; }
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    canvas.addEventListener('pointermove', e => {
      if (e.pointerType === 'touch') {
        if (this.worldTouch && this.worldTouch.id === e.pointerId) { this.worldTouch.x = e.clientX; this.worldTouch.y = e.clientY; }
        return;
      }
      this.mouse.x = e.clientX; this.mouse.y = e.clientY; this.mouse.has = true;
    });
    const up = e => {
      if (e.pointerType === 'touch') {
        if (this.worldTouch && this.worldTouch.id === e.pointerId) this.worldTouch = null;
        return;
      }
      if (e.button === 0 || e.type === 'pointercancel') this.mouse.left = false;
      if (e.button === 2 || e.type === 'pointercancel') this.mouse.right = false;
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    // Mouse position also updates when hovering over HUD, so aiming stays smooth.
    window.addEventListener('pointermove', e => {
      if (e.pointerType === 'mouse') { this.mouse.x = e.clientX; this.mouse.y = e.clientY; this.mouse.has = true; }
    });
    window.addEventListener('pointerup', e => {
      if (e.pointerType === 'mouse') { if (e.button === 0) this.mouse.left = false; if (e.button === 2) this.mouse.right = false; }
    });

    this.setTouchMode(window.matchMedia && window.matchMedia('(pointer: coarse)').matches && !window.matchMedia('(pointer: fine)').matches);
  },

  bindJoystick(zone, base, knob) {
    const R = this.JOY_R;
    const place = (x, y) => {
      base.style.transform = `translate(${x - 70}px, ${y - 70}px)`;
    };
    const rest = () => {
      const r = zone.getBoundingClientRect();
      place(100, r.height - 100);
      knob.style.transform = 'translate(0px, 0px)';
      base.classList.remove('active');
    };
    this._joyRest = rest;
    zone.addEventListener('pointerdown', e => {
      e.preventDefault();
      this.setTouchMode(true);
      if (this.joy.id !== null) return;
      const r = zone.getBoundingClientRect();
      this.joy.id = e.pointerId;
      this.joy.bx = e.clientX; this.joy.by = e.clientY;
      place(e.clientX - r.left, e.clientY - r.top);
      base.classList.add('active');
      try { zone.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    zone.addEventListener('pointermove', e => {
      if (e.pointerId !== this.joy.id) return;
      let dx = e.clientX - this.joy.bx, dy = e.clientY - this.joy.by;
      const d = Math.hypot(dx, dy);
      if (d > R) { dx = dx / d * R; dy = dy / d * R; }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      const mag = Math.min(1, d / R);
      this.joy.mag = mag < 0.15 ? 0 : mag;
      this.joy.dx = d > 0 ? (dx / R) : 0;
      this.joy.dy = d > 0 ? (dy / R) : 0;
      if (this.joy.mag === 0) { this.joy.dx = 0; this.joy.dy = 0; }
    });
    const end = e => {
      if (e.pointerId !== this.joy.id) return;
      this.joy.id = null; this.joy.dx = 0; this.joy.dy = 0; this.joy.mag = 0;
      rest();
    };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);
    requestAnimationFrame(rest);
    window.addEventListener('resize', () => { if (this.joy.id === null) rest(); });
  },

  bindButton(el, act) {
    el.addEventListener('pointerdown', e => {
      e.preventDefault();
      e.stopPropagation();
      this.held[act] = true;
      this.tapped.add(act);
      el.classList.add('down');
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    const end = () => { this.held[act] = false; el.classList.remove('down'); };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
    el.addEventListener('contextmenu', e => e.preventDefault());
  },

  setTouchMode(on) {
    if (this.touchMode === on) return;
    this.touchMode = on;
    if (on) { this.mouse.left = false; this.mouse.right = false; }
    if (this.onModeChange) this.onModeChange(on);
  },

  releaseAll() {
    this.keys.clear();
    this.mouse.left = false; this.mouse.right = false;
    for (const k in this.held) this.held[k] = false;
  },

  down(code) { return this.keys.has(code); },
  hit(code) { return this.pressed.has(code); },

  endFrame() {
    this.pressed.clear();
    this.tapped.clear();
    this.mouse.leftPressed = false;
    this.mouse.rightPressed = false;
    if (this.worldTouch) this.worldTouch.pressed = false;
  },
};
