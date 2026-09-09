/**
 * Runtime configuration parsed from URL parameters.
 *   ?demo=1        build the demo city on start (default 1)
 *   ?seed=1337     deterministic seed for all procedural generation
 *   ?time=14.5     starting hour of day (0-24)
 *   ?cam=city      camera preset (aerial | city | street | skyline | closeup or a demo-defined preset)
 *   ?quality=high  low | medium | high | ultra
 *   ?paused=1      start with simulation paused
 *   ?focus=a,b     only load the listed modules (for isolated development)
 *   ?weather=clear clear | cloudy | rain | fog | snow
 *   ?headless=1    deterministic fixed timestep for screenshots
 *   ?debug=1       verbose logging
 *   ?menu=0        skip the start screen (implied by ?demo=, ?showcase= or ?headless=)
 *   ?showcase=roads  run src/modules/<name>/showcase.js after init (implies demo=0 unless demo=1 given)
 */
export class Config {
  constructor(search = typeof window !== 'undefined' ? window.location.search : '') {
    const p = new URLSearchParams(search);
    this.params = p;
    this.menuParam = p.get('menu');
    this.showcase = p.get('showcase') ? p.get('showcase').split(',').map((s) => s.trim()).filter(Boolean) : null;
    // demo city is on by default, except when a module showcase is requested explicitly
    this.demo = p.has('demo') ? p.get('demo') !== '0' : !this.showcase;
    this.seed = int(p.get('seed'), 1337);
    this.time = float(p.get('time'), 14.0);
    this.cam = p.get('cam') || 'city';
    this.quality = QUALITY[p.get('quality')] ? p.get('quality') : 'high';
    this.paused = p.get('paused') === '1';
    this.focus = p.get('focus') ? p.get('focus').split(',').map((s) => s.trim()).filter(Boolean) : null;
    this.weather = p.get('weather') || 'clear';
    this.mapSize = int(p.get('map'), 2048);
    this.headless = p.get('headless') === '1';
    /**
     * Start screen. Shown only when the caller has NOT pinned the world with an explicit
     * demo/showcase/headless parameter, so every screenshot and showcase URL keeps working unchanged.
     * Force it on with ?menu=1, off with ?menu=0.
     */
    this.menu = this.menuParam != null
      ? this.menuParam !== '0'
      : (!p.has('demo') && !this.showcase && !this.headless);
    this.debug = p.get('debug') === '1';
    this.timeScale = float(p.get('timescale'), 1);
  }
  get(name, fallback = null) {
    return this.params.has(name) ? this.params.get(name) : fallback;
  }
}

function int(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}
function float(v, d) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : d;
}

/**
 * Quality presets. Modules read `engine.quality` and scale their own detail accordingly.
 *   density      vegetation / particle / scatter density
 *   propDensity  street furniture only (so "fewer trees" does not also delete benches and lamps)
 *   lightBudget  soft cap on registered point/spot lights across ALL modules (engine.registerLight)
 */
export const QUALITY = {
  low: {
    name: 'low', pixelRatio: 1, shadowMapSize: 1024, cascades: 2, shadowDistance: 600,
    gtao: false, bloom: true, smaa: true, anisotropy: 4, drawDistance: 2500,
    density: 0.4, reflections: false, particles: 0.3, textureSize: 1024,
    propDensity: 0.4, lightBudget: 8,
  },
  medium: {
    name: 'medium', pixelRatio: 1, shadowMapSize: 2048, cascades: 3, shadowDistance: 900,
    gtao: true, bloom: true, smaa: true, anisotropy: 8, drawDistance: 3500,
    density: 0.7, reflections: false, particles: 0.6, textureSize: 1024,
    propDensity: 0.7, lightBudget: 16,
  },
  /**
   * `high` runs THREE cascades, not four, and the reason is the TRIANGLE budget, not draw calls.
   *
   * (Correcting an earlier version of this comment, which claimed the fourth cascade was needed to
   * get under "the ≤1500 draw-call budget in §9". Both halves were wrong: the budget lives in
   * ARCHITECTURE.md §3 and is ≤2500 draw calls / ≤8 M triangles, and at four cascades draw calls
   * measured 1580 / 1634 — never over. Nothing here was ever a draw-call problem.)
   *
   * What the cascades actually cost is geometry. Every shadow caster is re-submitted once per
   * cascade, and §3's counts are ACCUMULATED over all passes. Measured at 1920x1080, quality=high,
   * seed 1337, mean over 80 frames, by disabling each cascade light in turn at the `civic` preset:
   *
   *     3 shadow passes            4.06 M triangles     722 draw calls
   *     ...of a frame that totals  8.12 M triangles    1548 draw calls
   *
   * So shadows are HALF the triangle budget, and a fourth cascade costs ~1.3 M more — which no
   * other lever measured comes close to refunding. Note §3 describes the frame as "4 shadow
   * cascades + GTAO + water reflection + main"; three is a deliberate deviation from that shape,
   * taken because four cannot fit the 8 M ceiling on this scene.
   *
   * Levers measured and rejected on the way here, so nobody re-runs them:
   *   road station density (the 2 cm chord tolerance in RoadMesher)  0.01 M — curvature and the
   *                                                                 8 m max step set the spacing,
   *                                                                 not terrain; a 7.5x looser
   *                                                                 tolerance changed nothing
   *   shadowDistance 1000, keeping 4 cascades                        drops distant shadows and
   *                                                                 still does not fit
   *   perfect material atlasing across every shader family           ~-65 draw calls, 0 triangles —
   *                                                                 the 51 live building pools span
   *                                                                 21 distinct shader programs, so
   *                                                                 only 12 pools can ever merge
   *
   * The cost is real and near-field: the same 2048² maps now cover 1400 m in three slices, so the
   * near cascade spans 204 m instead of 150 m and its texels are ~26% coarser. Measured against the
   * same frame, that is 1.40/255 mean and 3.0% of pixels beyond a threshold of 8, against a
   * 0.15/0.24% noise floor — visible to a measurement, hard to find by eye, and tree, vehicle and
   * kerb shadows all still read. `medium` has always shipped three cascades.
   *
   * To trade the budget back for shadow resolution, set this to 4. Nothing else depends on it.
   */
  high: {
    name: 'high', pixelRatio: 1.5, shadowMapSize: 2048, cascades: 3, shadowDistance: 1400,
    gtao: true, bloom: true, smaa: true, anisotropy: 16, drawDistance: 5000,
    density: 1.0, reflections: true, particles: 1.0, textureSize: 2048,
    propDensity: 1.0, lightBudget: 32,
  },
  ultra: {
    name: 'ultra', pixelRatio: 2, shadowMapSize: 4096, cascades: 4, shadowDistance: 2000,
    gtao: true, bloom: true, smaa: true, anisotropy: 16, drawDistance: 8000,
    density: 1.3, reflections: true, particles: 1.3, textureSize: 2048,
    propDensity: 1.4, lightBudget: 48,
  },
};
