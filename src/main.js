import { Config } from './core/Config.js';
import { EventBus } from './core/EventBus.js';
import { Engine } from './core/Engine.js';
import { World } from './core/World.js';
import { Input } from './core/Input.js';
import { CameraController } from './core/CameraController.js';
import { AssetLoader } from './core/AssetLoader.js';
import { installDebugAPI } from './core/DebugAPI.js';
import { MODULES } from './modules/registry.js';
import { makeRng } from './shared/random.js';

const loadingBar = document.getElementById('loading-bar');
const loadingStatus = document.getElementById('loading-status');
let menuModule = null;
const setLoading = (fraction, text) => {
  if (loadingBar) loadingBar.style.width = `${Math.round(fraction * 100)}%`;
  if (loadingStatus && text) loadingStatus.textContent = text;
  // §5b: the start screen mirrors core progress inside its own panel while modules initialise.
  try { menuModule?.setProgress?.(fraction, text); } catch (_) { /* the menu must never block boot */ }
};

async function boot() {
  const canvas = document.getElementById('game');
  const config = new Config();
  const events = new EventBus();
  const engine = new Engine({ canvas, config, events });
  const world = new World(config);
  const assets = new AssetLoader(engine.renderer, events);
  const input = new Input(canvas);
  const cameraController = new CameraController(engine.camera, input, world, canvas);

  const ctx = {
    engine,
    renderer: engine.renderer,
    scene: engine.scene,
    camera: engine.camera,
    world,
    events,
    assets,
    input,
    cameraController,
    config,
    modules: {},
    moduleStatus: {},
    uiRoot: document.getElementById('ui-root'),
  };
  const debug = installDebugAPI(ctx);

  engine.onUpdate(function coreInput(dt) {
    input.beginFrame();
    cameraController.update(dt);
  });
  engine.onAfterRender(() => input.endFrame());
  engine.start();

  // --- start screen: runs BEFORE module init so it can choose the seed the world is built from ---
  if (config.menu) {
    try {
      const menu = await import('./modules/menu/index.js');
      ctx.modules.menu = menu;
      menuModule = menu;
      document.getElementById('loading')?.classList.add('hidden');
      const choice = await menu.showStartScreen(ctx);
      if (choice) {
        if (Number.isFinite(choice.seed)) {
          config.seed = choice.seed;
          world.seed = choice.seed;
          world.rng = makeRng(choice.seed);
        }
        if (choice.cityName) world.economy.cityName = choice.cityName;
        config.demo = choice.mode === 'demo';
        ctx.startChoice = choice;
        events.emit('game:start', choice);
      }
      document.getElementById('loading')?.classList.remove('hidden');
    } catch (err) {
      console.error('[main] start screen failed, continuing without it', err);
      ctx.moduleStatus.menu = { ok: false, error: String(err && err.stack || err) };
    }
  }

  // --- load modules in order ---
  const list = [...MODULES].sort((a, b) => a.order - b.order).filter((m) => !config.focus || config.focus.includes(m.name));
  let i = 0;
  for (const entry of list) {
    setLoading((i / (list.length + 1)) * 0.9, `Loading ${entry.name}`);
    const t0 = performance.now();
    try {
      const mod = await entry.load();
      ctx.modules[entry.name] = mod;
      if (typeof mod.init === 'function') await mod.init(ctx);
      if (typeof mod.update === 'function') {
        const fn = (dt, elapsed) => mod.update(dt, elapsed);
        fn.moduleName = entry.name;
        engine.onUpdate(fn);
      }
      ctx.moduleStatus[entry.name] = { ok: true, ms: Math.round(performance.now() - t0) };
      events.emit(`module:ready:${entry.name}`, mod);
    } catch (err) {
      console.error(`[main] module "${entry.name}" failed to initialise`, err);
      ctx.moduleStatus[entry.name] = { ok: false, error: String(err && err.stack || err) };
      debug.errors.push(`module ${entry.name}: ${err && err.message}`);
    }
    i++;
  }
  events.emit('modules:ready');

  // --- module showcases (?showcase=roads,props) ---
  if (config.showcase) {
    const showcases = import.meta.glob('./modules/*/showcase.js');
    for (const name of config.showcase) {
      const key = `./modules/${name}/showcase.js`;
      setLoading(0.91, `Showcase ${name}`);
      try {
        if (!showcases[key]) throw new Error(`no showcase.js for module "${name}"`);
        const mod = await showcases[key]();
        await mod.showcase(ctx);
        ctx.moduleStatus[`showcase:${name}`] = { ok: true };
      } catch (err) {
        console.error(`[main] showcase "${name}" failed`, err);
        ctx.moduleStatus[`showcase:${name}`] = { ok: false, error: String(err && err.stack || err) };
        debug.errors.push(`showcase ${name}: ${err && err.message}`);
      }
    }
  }

  // --- demo city ---
  if (config.demo) {
    setLoading(0.92, 'Building city');
    try {
      const { buildDemoCity } = await import('./demo/DemoCity.js');
      await buildDemoCity(ctx);
      ctx.moduleStatus.demo = { ok: true };
    } catch (err) {
      console.error('[main] demo city failed', err);
      ctx.moduleStatus.demo = { ok: false, error: String(err && err.stack || err) };
      debug.errors.push(`demo: ${err && err.message}`);
    }
  }

  // An empty world has no city to look at. Map origin is wherever the heightmap put it — often a
  // slope or open water — so search for the flattest dry patch and open the camera over that.
  if (!config.demo && !config.showcase) {
    const spot = findBuildableStart(world);
    if (spot) {
      debug.presets.newcity = { target: { x: spot.x, z: spot.z }, distance: 380, yaw: 0.6, pitch: 0.62 };
      config.cam = 'newcity';
      if (config.debug) console.log('[main] new-city start', spot);
    }
  }
  debug.setCamera(config.cam, true) || debug.setCamera('city', true);
  setLoading(1, 'Ready');
  await debug.waitStable(2);
  document.getElementById('loading')?.classList.add('hidden');
  debug.ready = true;
  events.emit('game:ready');
  if (config.debug) console.log('[main] ready', debug.stats());
}

/** The first road a new player draws. 140 m is what tools/playtest.mjs asks the game for. */
const START_RUN = 140;
const START_DIRS = [0, 45, 90, 135];

/**
 * Can a road actually be built from A to B? This mirrors `evaluate()` in
 * src/modules/tools/roadtool.js — same ~2.2 m sampling, and the same SUSTAINED gradient over a
 * ~10 m window rather than a per-sample slope, because conformPath grades local bumps away.
 * Keep the two in step: if MAX_SLOPE or the sampling there changes, change it here.
 */
function roadCorridorOk(world, ax, az, bx, bz) {
  const t = world.terrain;
  const MAX_SLOPE = 0.25;
  const len = Math.hypot(bx - ax, bz - az);
  if (len < 6) return false;
  const n = Math.max(8, Math.min(220, Math.ceil(len / 2.2)));
  const ys = new Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const s = i / n, x = ax + (bx - ax) * s, z = az + (bz - az) * s;
    if (!world.inBounds(x, z)) return false;
    if (t.isWater && t.isWater(x, z)) return false;
    ys[i] = t.getHeight(x, z);
  }
  const step = len / n;
  const win = Math.max(2, Math.round(10 / step));
  for (let i = 0; i + win < ys.length; i++) {
    if (Math.abs(ys[i + win] - ys[i]) / (step * win) > MAX_SLOPE) return false;
  }
  return true;
}

/** How many of the four cardinal/diagonal first roads through (cx,cz) are buildable. 0-4. */
function startCorridors(world, cx, cz) {
  let n = 0;
  for (const deg of START_DIRS) {
    const r = deg * Math.PI / 180;
    const dx = Math.cos(r) * START_RUN / 2, dz = Math.sin(r) * START_RUN / 2;
    if (roadCorridorOk(world, cx - dx, cz - dz, cx + dx, cz + dz)) n++;
  }
  return n;
}

/**
 * Pick where a brand-new city opens. Deterministic — same seed, same starting view.
 *
 * The old score was a proxy: how much of the surrounding 200 m is dry, plus the height difference
 * from the centre. Neither asks the question that actually matters, so on seed 4242 it opened the
 * camera on a spot where no 140 m road could be drawn in ANY direction — the first thing the game
 * did to a new player was refuse their first action, and the scripted playtest had to hunt 40 m
 * away to lay its first road.
 *
 * So the proxy now only shortlists. The score that decides is the real one: how many first roads
 * are actually buildable through the point, asked with the road tool's own rule.
 */
function findBuildableStart(world) {
  const t = world.terrain;
  if (!t || !t.ready || typeof t.getHeight !== 'function') return null;
  const R = world.half * 0.62;      // stay away from the map edge
  const STEP = 120;                 // candidate spacing
  const PROBE = 40;                 // sample spacing inside a candidate
  const shortlist = [];
  for (let cz = -R; cz <= R; cz += STEP) {
    for (let cx = -R; cx <= R; cx += STEP) {
      let dry = 0, total = 0, maxDrop = 0;
      const h0 = t.getHeight(cx, cz);
      if (t.isWater && t.isWater(cx, cz)) continue;
      for (let dz = -200; dz <= 200; dz += PROBE) {
        for (let dx = -200; dx <= 200; dx += PROBE) {
          const x = cx + dx, z = cz + dz;
          total++;
          if (t.isWater && t.isWater(x, z)) continue;
          dry++;
          maxDrop = Math.max(maxDrop, Math.abs(t.getHeight(x, z) - h0));
        }
      }
      if (!total) continue;
      const dryness = dry / total;
      if (dryness < 0.85) continue;                    // a buildable start is not a lakeside sliver
      const flatness = 1 / (1 + maxDrop / 12);         // 12 m of relief across 400 m is already rolling
      const centreBias = 1 - Math.hypot(cx, cz) / (R * 1.6);
      const score = dryness * 0.45 + flatness * 0.45 + centreBias * 0.10;
      shortlist.push({ x: cx, z: cz, score, dryness, maxDrop: +maxDrop.toFixed(1) });
    }
  }
  if (!shortlist.length) return null;
  shortlist.sort((a, b) => b.score - a.score);

  // Nudge off the 120 m lattice as well: a grid point can sit in a gully while open ground is
  // half a block away, and the camera does not care which of these it looks at.
  const NUDGE = [[0, 0], [60, 0], [-60, 0], [0, 60], [0, -60], [60, 60], [-60, -60], [60, -60], [-60, 60]];
  let best = null;
  for (const c of shortlist.slice(0, 40)) {
    for (const [ox, oz] of NUDGE) {
      const x = c.x + ox, z = c.z + oz;
      if (Math.abs(x) > R || Math.abs(z) > R) continue;
      const corridors = startCorridors(world, x, z);
      if (!best || corridors > best.corridors
        || (corridors === best.corridors && c.score > best.score)) {
        best = { ...c, x, z, corridors };
      }
      if (best.corridors === START_DIRS.length) return best; // every direction works; stop looking
    }
  }
  // Nowhere on the map offers a clean first road (a mountain seed); the proxy's pick still beats
  // the map origin, so open there rather than returning nothing.
  return best || shortlist[0];
}

boot().catch((err) => {
  console.error('[main] fatal', err);
  const el = document.getElementById('loading-status');
  if (el) el.textContent = 'Failed to start: ' + (err && err.message);
});
