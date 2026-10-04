'use strict';
// Game balance and content tables. Tweak numbers here; logic lives in game.js.

const TILE = 48;
const WORLD_N = 80;                 // tiles per side
const WORLD_PX = TILE * WORLD_N;

const CYCLE = {
  dayLen: d => (d === 1 ? 140 : 105),
  duskLen: 12,
  nightLen: n => Math.min(100, 64 + n * 4),
  dawnLen: 7,
};

const PLAYER = {
  r: 13,
  speed: 170,
  sprint: 1.55,
  dodgeSpeed: 450,
  dodgeTime: 0.2,
  dodgeCost: 26,
  hungerRate: 0.45,
  magnet: 110,
  reachInteract: 78,
  buildRange: 260,
};

const FIRE = {
  maxFuel: 100,
  woodFuel: 11,
  burnNight: 0.55,
  burnDay: 0.32,
  startFuel: 70,
  lightBase: 90,
  lightPerFuel: 2.3,
  heatBase: 62,
  heatPerFuel: 1.0,
  cookRadius: 96,
  cookTime: 1.1,
};

const ITEMS = {
  wood:    { name: 'Wood',         tint: '#b07a45' },
  stone:   { name: 'Stone',        tint: '#a9adb0' },
  fiber:   { name: 'Fiber',        tint: '#9bc46a' },
  hide:    { name: 'Hide',         tint: '#c69a6a' },
  pelt:    { name: 'Pelt',         tint: '#8c939c' },
  fang:    { name: 'Fang',         tint: '#efe7d2' },
  arrow:   { name: 'Arrows',       tint: '#d8c49a' },
  berries: { name: 'Berries',      tint: '#d8435a', food: { hunger: 9, heal: 0 } },
  meat:    { name: 'Raw Meat',     tint: '#e0727a', food: { hunger: 12, heal: 0, raw: true }, cooksTo: 'steak' },
  fish:    { name: 'Raw Fish',     tint: '#8fb8c9', food: { hunger: 10, heal: 0, raw: true }, cooksTo: 'grilled' },
  steak:   { name: 'Cooked Meat',  tint: '#a8623a', food: { hunger: 34, heal: 14 } },
  grilled: { name: 'Grilled Fish', tint: '#d39a5a', food: { hunger: 28, heal: 18 } },
  bandage: { name: 'Bandage',      tint: '#efe9dc', heal: 35 },
};
const INV_ORDER = ['wood', 'stone', 'fiber', 'hide', 'pelt', 'fang', 'arrow', 'berries', 'meat', 'fish', 'steak', 'grilled', 'bandage'];
const ALWAYS_SHOWN = ['wood', 'stone', 'fiber'];
const FOOD_ITEMS = ['steak', 'grilled', 'berries', 'fish', 'meat'];

const GEAR = {
  axe:   { name: 'Stone Axe' },
  pick:  { name: 'Stone Pickaxe' },
  spear: { name: 'Spear' },
  bow:   { name: 'Hunting Bow' },
  blade: { name: 'Fang Blade' },
  armor: { name: 'Hide Armor' },
  cloak: { name: 'Fur Cloak' },
};
const GEAR_ORDER = ['axe', 'pick', 'spear', 'blade', 'bow', 'armor', 'cloak'];

// Melee profiles. The best weapon you own is used automatically.
const MELEE = {
  fist:  { dmg: 6,  reach: 44, arc: 1.8, cd: 0.30, kb: 120 },
  axe:   { dmg: 10, reach: 56, arc: 1.9, cd: 0.34, kb: 170 },
  spear: { dmg: 16, reach: 80, arc: 1.15, cd: 0.40, kb: 210 },
  blade: { dmg: 26, reach: 66, arc: 2.2, cd: 0.33, kb: 240 },
};

const RECIPES = [
  { id: 'axe',     gear: 'axe',   cost: { wood: 4, stone: 2 },          desc: 'Chop twice the wood per hit. Hits for 10.' },
  { id: 'pick',    gear: 'pick',  cost: { wood: 4, stone: 3 },          desc: 'Break twice the stone per hit.' },
  { id: 'spear',   gear: 'spear', cost: { wood: 6, stone: 3, fiber: 3 }, desc: 'Long reach, hits for 16. Good for spearing fish.' },
  { id: 'bandage', item: 'bandage', n: 1, cost: { fiber: 4 },           desc: 'Heals 35 health instantly.' },
  { id: 'arrows',  item: 'arrow', n: 6, cost: { wood: 2, stone: 1 },     desc: 'Ammo for your bow and for spring bows.' },
  { id: 'bow',     gear: 'bow',   cost: { wood: 6, fiber: 6 }, bench: true,          desc: 'Shoot arrows at range.' },
  { id: 'armor',   gear: 'armor', cost: { hide: 5, fiber: 4 }, bench: true,          desc: 'Take 35% less damage.' },
  { id: 'cloak',   gear: 'cloak', cost: { pelt: 3, fiber: 3 }, bench: true,          desc: 'Lose warmth half as fast at night.' },
  { id: 'blade',   gear: 'blade', cost: { fang: 4, stone: 4, wood: 2 }, bench: true, desc: 'Wide, vicious swings. Hits for 26.' },
];

// solid: blocks the player. block: blocks predators (they must break it).
const STRUCTS = {
  campfire:  { name: 'Campfire',   cost: { wood: 6, stone: 3 }, hp: 999, solid: true, block: true, circle: 19, indestructible: true,
               desc: 'Warmth, light and cooking. Feed it wood.' },
  wall:      { name: 'Wood Wall',  cost: { wood: 4 }, hp: 160, solid: true, block: true,
               desc: 'Predators have to break through it.' },
  gate:      { name: 'Gate',       cost: { wood: 6, fiber: 2 }, hp: 200, solid: false, block: true,
               desc: 'A wall you can walk through. Predators cannot.' },
  torch:     { name: 'Torch',      cost: { wood: 2, fiber: 1 }, hp: 40, solid: true, block: false, circle: 7, light: 175,
               desc: 'Lights the dark. Wolves hang back from bright light.' },
  spikes:    { name: 'Spikes',     cost: { wood: 3, stone: 2 }, hp: 120, solid: false, block: false,
               desc: 'Hurts anything that walks over it, except you.' },
  snare:     { name: 'Snare',      cost: { fiber: 3, wood: 1 }, hp: 30, solid: false, block: false,
               desc: 'Catches rabbits while you are busy elsewhere.' },
  workbench: { name: 'Workbench',  cost: { wood: 10, stone: 5 }, hp: 150, solid: true, block: true,
               desc: 'Craft bows, armor and cloaks next to it. Unlocks stone walls.' },
  tent:      { name: 'Tent',       cost: { wood: 5, fiber: 6, hide: 3 }, hp: 150, solid: true, block: true,
               desc: 'If you fall, you wake up here once. The tent is used up.' },
  stonewall: { name: 'Stone Wall', cost: { stone: 5, wood: 1 }, hp: 450, solid: true, block: true, bench: true,
               desc: 'Nearly three times as tough as wood.' },
  springbow: { name: 'Spring Bow', cost: { wood: 8, fiber: 6, stone: 2 }, hp: 120, solid: true, block: true, bench: true, ammoMax: 30,
               desc: 'Shoots predators in range. Load it with arrows.' },
};
const BUILD_ORDER = ['campfire', 'wall', 'gate', 'torch', 'spikes', 'snare', 'workbench', 'tent', 'stonewall', 'springbow'];

const CREATURES = {
  rabbit: { name: 'Rabbit', kind: 'prey', hp: 10, r: 9, speed: 55, run: 225, flee: 140, drops: { meat: 1 } },
  deer:   { name: 'Deer', kind: 'prey', hp: 42, r: 17, speed: 50, run: 245, flee: 195, drops: { meat: 3, hide: 2 } },
  boar:   { name: 'Boar', kind: 'boar', hp: 70, r: 17, speed: 48, charge: 340, dmg: 14, drops: { meat: 3, hide: 1 } },
  fish:   { name: 'Fish', kind: 'fish', hp: 1, r: 8, speed: 38, run: 150, drops: { fish: 1 } },
  wolf:   { name: 'Wolf', kind: 'predator', hp: 45, r: 15, speed: 200, dmg: 10, range: 30, windup: 0.32, cd: 1.0,
            structDmg: 14, drops: { meat: 1, pelt: 1 }, fang: 0.5 },
  lynx:   { name: 'Lynx', kind: 'predator', hp: 36, r: 14, speed: 165, dmg: 15, range: 26, windup: 0.3, cd: 1.2,
            structDmg: 10, drops: { meat: 1, pelt: 1 }, fang: 0.6, pounce: true, brave: true },
  bear:   { name: 'Bear', kind: 'predator', hp: 240, r: 27, speed: 98, dmg: 24, range: 46, windup: 0.55, cd: 1.6,
            structDmg: 55, drops: { meat: 5, pelt: 2, fang: 2 }, brave: true },
  alpha:  { name: 'Alpha Wolf', kind: 'predator', hp: 420, r: 22, speed: 190, dmg: 17, range: 36, windup: 0.3, cd: 0.85,
            structDmg: 30, drops: { meat: 4, pelt: 3, fang: 5 }, brave: true, boss: true },
};

const PERKS = [
  { id: 'swift',     name: 'Light Feet',     max: 3, desc: 'Move 8% faster.' },
  { id: 'vigor',     name: 'Thick Blood',    max: 3, desc: '+20 max health and a full heal right now.' },
  { id: 'woods',     name: 'Woodsman',       max: 2, desc: '+1 wood from every chop.' },
  { id: 'mason',     name: 'Stonecutter',    max: 2, desc: '+1 stone from every strike.' },
  { id: 'hearth',    name: 'Hearth Keeper',  max: 2, desc: 'Fires burn 30% longer and warm a wider ring.' },
  { id: 'stomach',   name: 'Iron Stomach',   max: 2, desc: 'Hunger drains 20% slower. Raw food stops hurting.' },
  { id: 'aim',       name: 'Steady Aim',     max: 3, desc: 'Arrows hit 30% harder and fly faster.', needs: 'bow' },
  { id: 'brute',     name: 'Brute Strength', max: 3, desc: 'Melee hits 20% harder.' },
  { id: 'coat',      name: 'Thick Coat',     max: 2, desc: 'Lose warmth 25% slower.' },
  { id: 'wind',      name: 'Second Wind',    max: 2, desc: 'Stamina refills 40% faster. Dodging costs less.' },
  { id: 'forager',   name: 'Forager',        max: 2, desc: '+1 berries and fiber from every harvest.' },
  { id: 'carpenter', name: 'Carpenter',      max: 2, desc: 'New structures get 40% more health. Repairs are free.' },
  { id: 'fletcher',  name: 'Fletcher',       max: 2, desc: '+3 arrows every time you craft them.', needs: 'bow' },
  { id: 'blood',     name: 'Bloodthirst',    max: 3, desc: 'Heal 4 health for every predator you kill.' },
  { id: 'owl',       name: 'Night Eyes',     max: 2, desc: 'See farther in the dark.' },
];

// Predators that come for you on night n.
function waveFor(n) {
  const wolves = Math.min(14, 2 + n);
  const lynx = n >= 3 ? Math.min(6, Math.floor((n - 1) / 2)) : 0;
  const bears = n >= 4 ? Math.min(4, 1 + Math.floor((n - 4) / 3)) : 0;
  const alpha = n % 5 === 0 ? 1 : 0;
  return { wolves, lynx, bears, alpha };
}
// Predators get tougher every night.
const nightHpScale = n => 1 + 0.08 * (n - 1);
