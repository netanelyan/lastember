'use strict';
// Boot and main loop.

(function () {
  let last = 0;

  function handleKeys() {
    const I = Input, S = Game.S;
    if (I.hit('KeyM')) UI.toggleMute();
    if (!UI.el.help.hidden) {
      if (I.hit('Escape')) UI.showHelp(false);
      else UI.menuKeys();
      return;
    }
    if (Game.mode === 'play') {
      if (I.hit('Escape')) {
        if (UI.craftOpen) UI.toggleCraft(false);
        else if (UI.buildOpen) UI.setBuildBar(false);
        else Game.pause();
      } else if (I.hit('KeyP')) Game.pause();
      if (I.hit('KeyC') || I.hit('Tab')) UI.toggleCraft();
      if (I.hit('KeyB')) UI.toggleBuild();
      if (UI.craftOpen) {
        for (let i = 0; i < 10; i++) if (I.hit('Digit' + ((i + 1) % 10)) && RECIPES[i]) UI.craftKey(RECIPES[i].id);
        if (I.hit('PageDown') || I.hit('PageUp')) UI.el.craftList.scrollBy({ top: I.hit('PageDown') ? 200 : -200, behavior: 'smooth' });
      }
      if (UI.buildOpen) {
        for (let i = 0; i < 10; i++) {
          if (I.hit('Digit' + ((i + 1) % 10)) && BUILD_ORDER[i]) {
            const id = BUILD_ORDER[i];
            Game.setBuild(S.build && S.build.id === id ? null : id);
          }
        }
        if (I.hit('KeyX')) Game.setBuild(S.build && S.build.id === 'demolish' ? null : 'demolish');
        if (!I.touchMode && I.mouse.rightPressed && S.build) Game.setBuild(null);
      }
    } else if (Game.mode === 'paused') {
      if (I.hit('Escape') || I.hit('KeyP')) Game.resume();
      else UI.menuKeys();
    } else UI.menuKeys();
  }

  function loop(now) {
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000)) || 0.016;
    last = now;
    try {
      handleKeys();
      Game.update(dt);
      if (Game.S) {
        Render.frame(Game.S, Game.mode === 'play' || Game.mode === 'title' ? dt : 0);
        Render.drawMinimap(Game.S, dt);
      }
      UI.update(dt);
      Sfx.updateAmbient(dt, Game.ambientInfo());
    } catch (err) {
      console.error(err);
    }
    Input.endFrame();
    requestAnimationFrame(loop);
  }

  function start(data) {
    Sprites.init();
    Render.init(document.getElementById('game'), document.getElementById('minimap'));
    Input.init(document.getElementById('game'));
    UI.init();
    const resumed = data && data.save && Game.load(data.save);
    if (resumed) {
      // The page was updated mid-run: carry on from where the player was.
      UI.el.title.hidden = true;
      Game.mode = 'play';
      Game.updateCamera(0, true);
      UI.onRunStart();
      Game.pause();
    } else {
      Game.newWorld((Math.random() * 1e9) >>> 0);
      Game.mode = 'title';
      UI.showTitle();
    }
    // First interaction unlocks audio.
    const unlock = () => { Sfx.init(); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);

    document.addEventListener('visibilitychange', () => { if (document.hidden && Game.mode === 'play') Game.pause(); });
    window.addEventListener('pagehide', () => Game.save());

    const hot = window.claude && window.claude.hot;
    if (hot && hot.snapshot) {
      hot.snapshot(() => (Game.S && ['play', 'paused', 'perk'].includes(Game.mode) && !Game.S.player.dead ? { save: Game.serialize() } : {}));
    }
    last = performance.now();
    requestAnimationFrame(loop);
  }

  const boot = () => {
    const hot = window.claude && window.claude.hot;
    if (hot && hot.ready) hot.ready(start);
    else start((hot && hot.data) || {});
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
