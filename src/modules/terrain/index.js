/**
 * terrain module — heightmap terrain with river, coast and mountains; chunked LOD mesh with a
 * splat-mapped PBR material (continuous across the map edge onto a 6 km horizon ring); lit water
 * with planar reflections; instanced forests and undergrowth.
 * Fills `world.terrain` (see ARCHITECTURE.md §4/§5) and emits `terrain:ready`.
 */
import * as THREE from 'three';
import { Heightmap } from './Heightmap.js';
import { makeGroundControl } from './GroundControl.js';
import { loadLayerArrays, makeNoiseTexture, makeWaterNormalTexture } from './textures.js';
import { createTerrainMaterial } from './TerrainMaterial.js';
import { TerrainChunks } from './TerrainChunks.js';
import { Water } from './Water.js';
import { Vegetation } from './Vegetation.js';
import { clamp, smoothstep, lerp } from '../../shared/math.js';

export const name = 'terrain';

const CONTROL_RES = 512;
let S = null; // module state

export async function init(ctx) {
  const { engine, scene, world, events, assets, camera } = ctx;
  const q = engine.quality;
  const t0 = performance.now();

  // kick off asset loads first (they overlap with the CPU generation below)
  const texSize = q.textureSize >= 2048 ? 1024 : 512;
  const layersPromise = loadLayerArrays(texSize, engine.maxAnisotropy);
  const barkPromise = Promise.all([
    assets.loadPBR({ map: '/assets/shared/Bark012/color.jpg', normalMap: '/assets/shared/Bark012/normal.jpg', roughnessMap: '/assets/shared/Bark012/roughness.jpg' }),
    assets.loadPBR({ map: '/assets/shared/Bark014/color.jpg', normalMap: '/assets/shared/Bark014/normal.jpg', roughnessMap: '/assets/shared/Bark014/roughness.jpg' }),
  ]);

  // --- heightmap & shared ground rules ---
  const hm = new Heightmap({ size: world.size, spacing: 2, seed: world.seed }).generate();
  const half = hm.half;
  const ground = makeGroundControl(hm, world.seed);
  const { controlAt, forestMask } = ground;

  // --- signed shore distance (metres to the waterline, + on land; 128 + 4·sd per heightmap sample) ---
  const shoreData = hm.computeShoreDistance();
  const shoreTex = new THREE.DataTexture(shoreData, hm.N, hm.N, THREE.RedFormat, THREE.UnsignedByteType);
  shoreTex.minFilter = THREE.LinearFilter; shoreTex.magFilter = THREE.LinearFilter;
  shoreTex.wrapS = shoreTex.wrapT = THREE.ClampToEdgeWrapping;
  shoreTex.generateMipmaps = false; shoreTex.colorSpace = THREE.NoColorSpace; shoreTex.unpackAlignment = 1; shoreTex.needsUpdate = true;
  const shoreAt = (x, z) => {
    const i = clamp(Math.round((x + half) / hm.spacing), 0, hm.N - 1), j = clamp(Math.round((z + half) / hm.spacing), 0, hm.N - 1);
    return (shoreData[j * hm.N + i] - 128) * 0.25;
  };
  // curvature (cavity) 0..1: 0.5 flat, < 0.5 hollow, > 0.5 knoll — 8 m Laplacian of the heightmap
  const curvatureAt = (x, z, h) => {
    const e = 8;
    const lap = (hm.getHeight(x + e, z) + hm.getHeight(x - e, z) + hm.getHeight(x, z + e) + hm.getHeight(x, z - e) - 4 * h) / (e * e);
    return clamp(0.5 - lap * 45, 0.05, 0.95);
  };

  // --- control maps (R dry grass, G dirt, B sand, A rock boost | R canopy, G field, B –, A curvature) and world-normal map ---
  const ctrlData = new Uint8Array(CONTROL_RES * CONTROL_RES * 4);
  const ctrl2Data = new Uint8Array(CONTROL_RES * CONTROL_RES * 4);
  const ctrlStep = world.size / CONTROL_RES;
  for (let j = 0; j < CONTROL_RES; j++) {
    const z = -half + (j + 0.5) * ctrlStep;
    for (let i = 0; i < CONTROL_RES; i++) {
      const x = -half + (i + 0.5) * ctrlStep;
      const k = (j * CONTROL_RES + i) * 4;
      const h = hm.getHeight(x, z);
      const slope = hm.getSlope(x, z);
      const c = controlAt(x, z, h, slope, shoreAt(x, z));
      ctrlData[k] = 255 * c.dry; ctrlData[k + 1] = 255 * c.dirt; ctrlData[k + 2] = 255 * c.sand; ctrlData[k + 3] = 255 * c.rock;
      ctrl2Data[k] = 255 * c.forest; ctrl2Data[k + 1] = 255 * clamp(c.field, 0, 1); ctrl2Data[k + 2] = 0; ctrl2Data[k + 3] = 255 * curvatureAt(x, z, h);
    }
  }
  const mkCtrl = (data) => {
    const t = new THREE.DataTexture(data, CONTROL_RES, CONTROL_RES, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = false; t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true;
    return t;
  };
  const controlTex = mkCtrl(ctrlData), control2Tex = mkCtrl(ctrl2Data);

  const NRES = hm.N - 1; // one texel per heightmap cell
  const normalData = new Uint8Array(NRES * NRES * 4);
  const fillNormals = (i0, i1, j0, j1) => {
    const N = hm.N, d = hm.data, sp = hm.spacing;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const ia = Math.max(0, i - 1), ib = Math.min(N - 1, i + 2), ja = Math.max(0, j - 1), jb = Math.min(N - 1, j + 2);
      const hl = (d[j * N + ia] + d[(j + 1) * N + ia]) * 0.5, hr = (d[j * N + ib] + d[(j + 1) * N + ib]) * 0.5;
      const hu = (d[ja * N + i] + d[ja * N + i + 1]) * 0.5, hd = (d[jb * N + i] + d[jb * N + i + 1]) * 0.5;
      const nx = -(hr - hl) / ((ib - ia) * sp), ny = 1, nz = -(hd - hu) / ((jb - ja) * sp);
      const l = Math.hypot(nx, ny, nz);
      const k = (j * NRES + i) * 4;
      normalData[k] = 255 * (0.5 + 0.5 * nx / l); normalData[k + 1] = 255 * (0.5 + 0.5 * ny / l); normalData[k + 2] = 255 * (0.5 + 0.5 * nz / l); normalData[k + 3] = 255;
    }
  };
  fillNormals(0, NRES - 1, 0, NRES - 1);
  const normalTex = new THREE.DataTexture(normalData, NRES, NRES, THREE.RGBAFormat, THREE.UnsignedByteType);
  normalTex.minFilter = THREE.LinearMipmapLinearFilter; normalTex.magFilter = THREE.LinearFilter;
  normalTex.wrapS = normalTex.wrapT = THREE.ClampToEdgeWrapping;
  normalTex.generateMipmaps = true; normalTex.colorSpace = THREE.NoColorSpace; normalTex.anisotropy = Math.min(16, engine.maxAnisotropy); normalTex.needsUpdate = true;

  const tA = performance.now();
  const noiseTex = makeNoiseTexture(256, world.seed);
  const waterNormalTex = makeWaterNormalTexture(256, world.seed);
  waterNormalTex.anisotropy = Math.min(8, engine.maxAnisotropy);
  const cpuMs = performance.now() - t0;
  const timing = { heightmapAndMaps: Math.round(tA - t0), noiseTex: Math.round(performance.now() - tA) };

  // --- materials & meshes ---
  const tB = performance.now();
  const layers = await layersPromise;
  timing.layersAwait = Math.round(performance.now() - tB);
  const matOpts = { albedoArray: layers.albedo, normalArray: layers.normal, controlTex, control2Tex, normalTex, noiseTex, shoreTex, shoreN: hm.N, spacing: hm.spacing, half, size: world.size, waterLevel: hm.waterLevel, globalUniforms: engine.globalUniforms };
  const material = createTerrainMaterial(matOpts);
  const horizonMaterial = createTerrainMaterial({ ...matOpts, horizon: true });
  engine.registerMaterial(material);
  engine.registerMaterial(horizonMaterial);
  const tC = performance.now();
  const chunks = new TerrainChunks({ heightmap: hm, material, horizonMaterial, controlAt, chunkSize: 256, lodDistances: [125, 420, 1000], castShadow: true, horizon: true });
  scene.add(chunks.group);
  timing.chunks = Math.round(performance.now() - tC);

  const water = new Water({ heightmap: hm, noiseTex, normalTex: waterNormalTex, shoreTex, chunkSize: 128, reflections: !!q.reflections, reflectionScale: q.name === 'ultra' ? 0.6 : 0.5, renderer: engine.renderer, engine, noAoLayer: engine.LAYER_NO_AO != null ? engine.LAYER_NO_AO : 1 });
  scene.add(water.mesh);

  // --- vegetation ---
  const [oak, fir] = await barkPromise;
  const groundInfo = (x, z) => {
    const i = clamp(Math.floor((x + half) / ctrlStep), 0, CONTROL_RES - 1), j = clamp(Math.floor((z + half) / ctrlStep), 0, CONTROL_RES - 1);
    const k = (j * CONTROL_RES + i) * 4;
    const h = hm.getHeight(x, z), slope = hm.getSlope(x, z);
    const dry = ctrlData[k] / 255, dirt = ctrlData[k + 1] / 255, sand0 = ctrlData[k + 2] / 255, rockB = ctrlData[k + 3] / 255, forest = ctrl2Data[k] / 255;
    const hA = h - hm.waterLevel;
    const shoreD = shoreAt(x, z);
    const highland = smoothstep(14, 42, hA);
    const cut = smoothstep(0.24, 0.40, slope) * (1 - highland);
    const rockSlope = smoothstep(0.19, 0.40, slope);
    const rock = Math.max(rockSlope * lerp(0.62, 1, highland), rockB * smoothstep(0.06, 0.2, slope + rockB * 0.3), cut * 0.7);
    const dirtW = Math.max(dirt, cut * 0.45 + smoothstep(0.12, 0.24, slope) * (1 - rockSlope) * 0.28);
    const wet = (1 - smoothstep(0.3, 2.0, shoreD)) * smoothstep(-6, -1, shoreD);
    const sandW = Math.max(sand0, smoothstep(0.2, -1.6, shoreD) * 0.6) * (1 - smoothstep(0.10, 0.22, slope));
    const rest = Math.max(0, 1 - wet * 0.55 - sandW * (1 - wet) - rock * (1 - wet - sandW * (1 - wet)));
    return { h, slope, grass: rest * (1 - dirtW) * (1 - dry * 0.4), dry: rest * dry, dirt: rest * dirtW, sand: sandW, rock, wet, forest, shoreD };
  };
  // average ground colour (sRGB 0..1) at a point — undergrowth tints itself towards it so tufts sit IN the meadow
  // must track the per-layer tints in TerrainMaterial.js so undergrowth sits IN the meadow colour
  const LAYER_TINT = [[0.46, 0.55, 0.40], [0.50, 0.51, 0.38], [0.55, 0.49, 0.38], [0.90, 0.88, 0.90], [0.51, 0.47, 0.38], [0.52, 0.48, 0.40], [0.90, 0.88, 0.90], [0.32, 0.30, 0.22]];
  const groundTint = (x, z, out = [0, 0, 0]) => {
    const g = groundInfo(x, z);
    const w = [g.grass, g.dry, g.dirt, g.rock, g.sand, g.wet * 0.35, 0, g.forest * 0.5 * g.grass];
    let sw = 0; out[0] = out[1] = out[2] = 0;
    for (let i = 0; i < 8; i++) {
      const wi = w[i]; if (wi <= 0.001) continue;
      const a = layers.avg[i], t = LAYER_TINT[i];
      out[0] += wi * a[0] * t[0]; out[1] += wi * a[1] * t[1]; out[2] += wi * a[2] * t[2]; sw += wi;
    }
    if (sw > 0) { out[0] /= sw; out[1] /= sw; out[2] /= sw; } else { out[0] = 0.3; out[1] = 0.38; out[2] = 0.18; }
    return out;
  };
  const isBlocked = (x, z) => { const r = world.roads && world.roads.api; return !!(r && r.isOnRoad && r.isOnRoad(x, z)); };
  const tD = performance.now();
  const vegetation = new Vegetation({ renderer: engine.renderer, engine, heightmap: hm, seed: world.seed, quality: q, forestMask, groundInfo, groundTint, isBlocked, bark: { oak, fir }, half }).build();
  scene.add(vegetation.group);
  // forest floor only under actual canopy: bake crown coverage into control2.r
  const canopy = vegetation.canopyCoverage(CONTROL_RES);
  for (let k = 0, n = CONTROL_RES * CONTROL_RES; k < n; k++) ctrl2Data[k * 4] = 255 * canopy[k];
  control2Tex.needsUpdate = true;
  timing.vegetation = Math.round(performance.now() - tD);

  // --- state ---
  S = { ctx, hm, chunks, water, vegetation, material, horizonMaterial, controlTex, normalTex, fillNormals, dirty: [], camera, groundInfo, forestMask, ctrlStep, ctrlData, shoreData, shoreTex, shoreDirty: false };

  // --- world contract ---
  const terrain = world.terrain;
  terrain.ready = true;
  terrain.size = world.size;
  terrain.waterLevel = hm.waterLevel;
  terrain.getHeight = (x, z) => hm.getHeight(x, z);
  terrain.getNormal = (x, z, out = new THREE.Vector3()) => hm.getNormal(x, z, out);
  terrain.isWater = (x, z) => hm.getHeight(x, z) < hm.waterLevel;
  terrain.raycast = (ray, out) => hm.raycast(ray, out);

  const pushDirty = (r, x0, z0, x1, z1) => {
    if (!r) return;
    S.dirty.push({ ...r, x0: Math.min(x0, x1), z0: Math.min(z0, z1), x1: Math.max(x0, x1), z1: Math.max(z0, z1) });
  };

  terrain.api = {
    heightmap: hm,
    /** Slope 0 (flat) … 1 (vertical) */
    slope: (x, z) => hm.getSlope(x, z),
    /** Biome label at a point: water | wetland | beach | rock | forest | meadow | grass */
    biome: (x, z) => {
      const h = hm.getHeight(x, z);
      if (h < hm.waterLevel) return 'water';
      const g = groundInfo(x, z);
      if (g.wet > 0.5) return 'wetland';
      if (g.sand > 0.5) return 'beach';
      if (g.rock > 0.5) return 'rock';
      if (g.forest > 0.45 && h > hm.waterLevel + 1.6) return 'forest';
      if (g.dry > 0.45) return 'meadow';
      return 'grass';
    },
    /** Detailed ground composition at a point (weights 0..1). */
    groundInfo,
    forestMask: (x, z) => forestMask(x, z, hm.getHeight(x, z), hm.getSlope(x, z)),
    /** Distance to the river centreline and the river's half width at that z. */
    river: (x, z) => ({ distance: hm.riverDistance(x, z), halfWidth: hm.riverHalfWidth(z) }),
    coastZ: (x) => hm.coastZ(x),
    /**
     * Flatten a block of zoning cells (cx, cz, w×d cells) to height y (default: average height).
     * Also clears trees on the footprint. Returns the level used.
     */
    flatten: (cx, cz, w = 1, d = 1, y) => {
      const x0 = -world.half + cx * world.cellSize, z0 = -world.half + cz * world.cellSize;
      return terrain.api.flattenRect(x0, z0, x0 + w * world.cellSize, z0 + d * world.cellSize, y);
    },
    /** Flatten a world-space rectangle; `falloff` metres of smooth blend outside. */
    flattenRect: (x0, z0, x1, z1, y, falloff = 6) => {
      if (y == null) y = hm.averageHeight(x0, z0, x1, z1);
      y = Math.max(y, hm.waterLevel + 0.6);
      pushDirty(hm.flattenRect(x0, z0, x1, z1, y, falloff), Math.min(x0, x1) - falloff, Math.min(z0, z1) - falloff, Math.max(x0, x1) + falloff, Math.max(z0, z1) + falloff);
      vegetation.clearRect(Math.min(x0, x1) - 1.5, Math.min(z0, z1) - 1.5, Math.max(x0, x1) + 1.5, Math.max(z0, z1) + 1.5);
      return y;
    },
    /**
     * Conform the terrain to a road corridor: `points` = dense centreline samples {x,y,z} with the
     * final bed height in y, `width` = full corridor width, `falloff` = blend metres outside.
     * Interpolates along the polyline (no terraces) and clears vegetation in the corridor.
     */
    conformPath: (points, width, falloff = 6) => {
      if (!points || points.length < 2) return;
      const reach = width / 2 + falloff;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const p of points) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
      pushDirty(hm.conformPath(points, width, falloff), minX - reach, minZ - reach, maxX + reach, maxZ + reach);
      vegetation.clearPolyline(points, width + 3);
    },
    /** Conform a disc (junction pad) to height y with a smooth falloff. */
    conformDisc: (x, z, r, y, falloff = 6) => {
      if (y == null) y = hm.getHeight(x, z);
      pushDirty(hm.conformDisc(x, z, r, y, falloff), x - r - falloff, z - r - falloff, x + r + falloff, z + r + falloff);
      vegetation.clearCircle(x, z, r + 1.5);
    },
    /** Remove trees/undergrowth inside a rect, circle, oriented rect or along a polyline (corridor width). */
    clearVegetation: (x0, z0, x1, z1) => vegetation.clearRect(x0, z0, x1, z1),
    clearVegetationRect: (x0, z0, x1, z1) => vegetation.clearRect(x0, z0, x1, z1),
    clearVegetationCircle: (x, z, r) => vegetation.clearCircle(x, z, r),
    clearVegetationPath: (points, width) => vegetation.clearPolyline(points, width),
    clearVegetationOriented: (x, z, w, d, yaw = 0, margin = 0) => vegetation.clearOriented(x, z, w, d, yaw, margin),
    /** True where undergrowth is suppressed (roads, lots, pads). */
    isCleared: (x, z) => vegetation.isCleared(x, z),
    treeCount: () => vegetation.aliveCount(),
    trees: vegetation.trees,
    /** Force LOD/instance refresh (e.g. after bulk edits). */
    refresh: () => { vegetation._forceUpdate = true; vegetation._undergrowthDirty = true; },
    /** Tint the ground for info-view overlays (0 off … 1 full). */
    setInfoTint: (v) => { material.userData.uniforms.uInfoTint.value = v; horizonMaterial.userData.uniforms.uInfoTint.value = v; },
    stats: () => ({ cpuMs: Math.round(cpuMs), timing, trees: vegetation.aliveCount(), chunks: chunks.chunks.length, waterQuads: water.waterQuads.length, minH: hm.minH, maxH: hm.maxH }),
    /** internals for tuning/debugging (not part of the contract) */
    vegetation, chunks, water, material, horizonMaterial,
  };

  // --- keep vegetation out of roads, lots, buildings and service pads built by other modules ---
  events.on('roads:changed', () => {
    const segs = world.roads && world.roads.segments;
    if (!segs || !segs.size) return;
    for (const seg of segs.values()) {
      if (seg._terrainCleared === world.roads.version) continue;
      const pts = seg.points && seg.points.length ? seg.points : null;
      if (!pts) continue;
      vegetation.clearPolyline(pts, (seg.width || 12) + 3);
      seg._terrainCleared = world.roads.version;
    }
  });
  events.on('building:added', (b) => {
    if (!b || b.x == null) return;
    vegetation.clearOriented(b.x, b.z, b.w || 8, b.d || 8, b.yaw || 0, 1.5);
  });
  events.on('zones:changed', () => {
    const lots = world.zones && world.zones.lots;
    if (!lots) return;
    for (const lot of lots) {
      // only lots that actually carry a building lose their trees — empty zoned land keeps them
      if (lot._terrainCleared || lot.buildingId == null) continue;
      lot._terrainCleared = true;
      vegetation.clearOriented(lot.x, lot.z, lot.w || 8, lot.d || 8, lot.yaw || 0, 0.5);
    }
  });
  const clearServices = () => {
    const list = world.services && world.services.list;
    if (!list) return;
    for (const s of list) {
      if (s._terrainCleared) continue;
      s._terrainCleared = true;
      vegetation.clearOriented(s.x, s.z, s.w || 16, s.d || 16, s.yaw || 0, 5);
    }
  };
  events.on('service:added', clearServices);
  events.on('services:changed', clearServices);
  events.on('infoview:changed', (p) => {
    const on = p && p.view && p.terrain !== false ? 1 : 0;
    terrain.api.setInfoTint(on);
  });
  /**
   * The water reflection holds its last target while the camera is still (Water.js `maxFreeze`).
   * Anything that changes layer-3 geometry has to cancel that hold, or a road laid — or a zone
   * overlay toggled — while the camera sits still would be missing from the water until the cap
   * expires. Building growth has no event of its own and is covered by the cap instead.
   */
  const dirtyReflection = () => { water._reflectDirty = true; };
  for (const e of ['terrain:changed', 'roads:changed', 'zones:changed', 'services:changed',
    'service:added', 'building:added', 'infoview:changed', 'weather:set']) events.on(e, dirtyReflection);

  // first LOD pass so the very first frame is correct, then pre-compile the programs (avoids a
  // multi-hundred-ms hitch on the first frame that shows terrain, water and the six tree kinds)
  chunks.update(camera);
  vegetation.update(camera, 0, 0, world.env);
  try { engine.renderer.compile(scene, camera); } catch (e) { /* compile is an optimisation only */ }
  events.emit('terrain:ready', terrain);
  timing.total = Math.round(performance.now() - t0);
  if (ctx.config.debug) console.log('[terrain] ready', terrain.api.stats());
}

export function update(dt, elapsed) {
  if (!S) return;
  const { ctx, chunks, water, vegetation, hm } = S;
  const { camera, engine, world, scene } = ctx;

  // apply pending heightmap edits (batched; a few regions per frame keeps the frame smooth)
  if (S.dirty.length) {
    let budget = 8;
    let minI = Infinity, maxI = -Infinity, minJ = Infinity, maxJ = -Infinity;
    while (S.dirty.length && budget-- > 0) {
      const r = S.dirty.shift();
      chunks.rebuildRegion(r.x0, r.z0, r.x1, r.z1);
      vegetation.resnap(r.x0, r.z0, r.x1, r.z1);
      minI = Math.min(minI, r.i0); maxI = Math.max(maxI, r.i1); minJ = Math.min(minJ, r.j0); maxJ = Math.max(maxJ, r.j1);
    }
    const NRES = hm.N - 1;
    S.fillNormals(Math.max(0, minI - 1), Math.min(NRES - 1, maxI + 1), Math.max(0, minJ - 1), Math.min(NRES - 1, maxJ + 1));
    S.normalTex.needsUpdate = true;
    water.updateHeightTexture();
    // edits near the waterline change the shore distance field (recomputed once the queue drains)
    const N = hm.N, d = hm.data, wl = hm.waterLevel;
    for (let j = Math.max(0, minJ); j <= Math.min(N - 1, maxJ) && !S.shoreDirty; j += 2) for (let i = Math.max(0, minI); i <= Math.min(N - 1, maxI); i += 2) {
      if (d[j * N + i] < wl + 3) { S.shoreDirty = true; break; }
    }
    if (S.shoreDirty && !S.dirty.length) { hm.computeShoreDistance(S.shoreData); S.shoreTex.needsUpdate = true; S.shoreDirty = false; }
    ctx.events.emit('terrain:changed');
  }

  // night factor drives the terrain's matte/cool night response (kills grazing specular smears)
  const nf = (world.env && world.env.nightFactor) || 0;
  S.material.userData.uniforms.uNight.value = nf;
  S.horizonMaterial.userData.uniforms.uNight.value = nf;
  // moon direction drives the night modelling term (flat dark grey-green land otherwise)
  const md = S.material.userData.uniforms.uMoonDir.value;
  const em = world.env && world.env.moonDirection;
  if (em && em.y > 0.08) md.copy(em);
  else if (world.env && world.env.sunDirection) {
    // moon down: model the land with the brightest part of the twilight sky instead (opposite the sun,
    // lifted to 35 deg) so the relief still reads rather than going flat black
    md.set(-world.env.sunDirection.x, 0, -world.env.sunDirection.z);
    if (md.lengthSq() < 1e-6) md.set(0, 1, 0); else md.normalize().multiplyScalar(0.82).setY(0.57);
  }
  S.horizonMaterial.userData.uniforms.uMoonDir.value.copy(md);

  chunks.update(camera);
  vegetation.update(camera, dt, elapsed, world.env);
  water.update(dt, elapsed, engine, world.env);
  if (water.reflectionsEnabled) water.renderReflection(engine.renderer, scene, camera);
}

export function dispose() {
  if (!S) return;
  const { ctx, chunks, water, vegetation } = S;
  ctx.scene.remove(chunks.group, water.mesh, vegetation.group);
  chunks.dispose(); water.dispose(); vegetation.dispose();
  S = null;
}
