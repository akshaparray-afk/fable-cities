/**
 * props — deterministic placement.
 *
 * Everything is derived from the public APIs: `roads.api.sampleEdge` for the sidewalk edge and its
 * outward normal, the segment records for length/trim/phase (so props sit clear of junction pads and
 * never collide with the lamps the road asset already carries), `zones.api.lotsFor()` for the lot
 * boundaries that get hedges, fences and driveways, and `terrain` for ground heights off the paved
 * surface.
 *
 * Each (segment, side) keeps a 1-D occupancy list in arc length, so a bus shelter, a tree, a bench
 * and a sign can never end up inside one another — the thing that makes procedural street furniture
 * look procedural. Randomness is seeded per segment/node/lot (`makeRng(hash2(world.seed,
 * hashString(id)))`), so the same seed always produces the same street.
 */
import * as THREE from 'three';
import { makeRng, hash2, hashString } from '../../shared/random.js';
import { clamp } from '../../shared/math.js';
import { GroundCover } from './PropGround.js';

const RANK = { path: 1, local: 2, avenue: 3, highway: 4 };
/** Share of the lot a built mass actually covers, per zone type (see indexBuildings). */
const FOOTPRINT = {
  'res-low': [0.58, 0.52], 'res-high': [0.80, 0.72], 'com-low': [0.86, 0.80],
  'com-high': [0.90, 0.86], office: [0.88, 0.84], ind: [0.90, 0.86], default: [0.82, 0.78],
};
const LAMP_MARGIN = 3.0;            // roads keeps its lamps this far from a trimmed segment end
/** Widens every luminaire's PointLight cutoff — see addSource() for why, and why it is free. */
const LIGHT_RANGE_SCALE = 3;
/**
 * Scales every luminaire's PointLight intensity. The authored values (16 cd for a road lamp,
 * 10 for a classic one) are far below what a luminaire 15 m above the carriageway needs to put
 * light ON that carriageway — a real street lamp is a four-figure candela figure — so with the
 * cutoff widened the lamps still lit almost nothing. Swept at a night street view against the
 * same frame at ×1: ×5 moves 0.6% of pixels, ×10 5.8%, ×20 11.7%, ×40 17.0%. ×20 is the point
 * where the pavement and kerb first read as lit; ×40 is the sodium-lit look, and is what this
 * is set to — the tone mapper still has headroom there (see the clipping check in the commit).
 *
 * This scales ONLY the real light: `luminaire()` draws the lamp's halo from `halo` and its ground
 * pool from `dia`, and neither reads `intensity`, so the faked lighting is untouched and the four
 * pooled lights still blend into the many lamps that never get one.
 */
const LIGHT_INTENSITY_SCALE = 40;
const CAR_COLORS = [
  0xf2f3f4, 0xe8e9ea, 0xd8dade, 0xb9bdc0, 0x9aa0a5, 0x6d7377, 0x2f3438, 0x1b1e21,
  0x2d4a72, 0x38607f, 0x6b2f33, 0x8f3b2c, 0x35513c, 0x7a6a4f, 0xc9a227, 0x1f4a3c,
];

/**
 * Ground contact occlusion per kind: `r` = [half-width, half-depth] in metres of the darkening
 * ellipse, `rot` = turn it with the instance (cars, benches, hedges), `every` = decal only every
 * Nth item where a kind comes in long runs. This is the AO the shadow cascades cannot resolve —
 * without it every prop reads as pasted onto the ground.
 */
const CONTACT = {
  tree_broad: { r: [1.55, 1.55] }, tree_broad_b: { r: [1.55, 1.55] },
  tree_upright: { r: [1.30, 1.30] }, tree_upright_b: { r: [1.30, 1.30] }, tree_small: { r: [1.15, 1.15] },
  tree_conifer: { r: [1.25, 1.25] },
  bush_a: { r: [0.72, 0.72] }, bush_b: { r: [0.82, 0.82] },
  hedge: { r: [0.95, 0.60], rot: true, every: 2 },
  fence_picket: { r: [1.15, 0.26], rot: true, every: 3 },
  fence_chain: { r: [1.15, 0.24], rot: true, every: 3 },
  bench: { r: [1.15, 0.60], rot: true },
  bin: { r: [0.42, 0.42] }, bin_rust: { r: [0.42, 0.42] },
  hydrant: { r: [0.36, 0.36] }, hydrant_aged: { r: [0.36, 0.36] },
  planter: { r: [0.88, 0.60], rot: true },
  news_box: { r: [0.46, 0.40], rot: true },
  cycle_stand: { r: [0.34, 0.28], rot: true },
  bollard: { r: [0.26, 0.26] },
  sign_post: { r: [0.30, 0.30] },
  traffic_light: { r: [0.42, 0.42] }, traffic_light_mast: { r: [0.56, 0.56] },
  lamp_classic: { r: [0.48, 0.48] },
  bus_shelter: { r: [2.35, 1.05], rot: true },
  mailbox: { r: [0.28, 0.28] },
  wheelie_bin: { r: [0.44, 0.40], rot: true },
  utility_box: { r: [0.58, 0.38], rot: true },
  a_board: { r: [0.44, 0.40], rot: true },
  garden_shed: { r: [1.30, 1.05], rot: true },
  rock_small: { r: [0.34, 0.34] },
  car_sedan: { r: [1.05, 2.35], rot: true }, car_hatch: { r: [1.02, 2.10], rot: true },
  car_estate: { r: [1.05, 2.45], rot: true }, car_van: { r: [1.12, 2.60], rot: true },
  car_covered: { r: [1.10, 2.45], rot: true },
};

/** Paved-surface grid (see markPaved): 0.9 m cells, rasterised at 0.6 m so no cell is missed. */
const PAVE_CELL = 0.9;
const PAVE_STEP = 0.6;
const paveKey = (x, z) => ((Math.round(x / PAVE_CELL) + 8192) << 14) | (Math.round(z / PAVE_CELL) + 8192);

const _c = new THREE.Color();
const toLinear = (hex) => _c.setHex(hex).toArray();

export class PropScatter {
  constructor(ctx, assets) {
    this.ctx = ctx;
    this.assets = assets;
    this.world = ctx.world;
    this.density = 1;
    this.sources = [];
    this.counts = {};
    this.carPalette = CAR_COLORS.map(toLinear);
    this.slots = new Map();          // `${segId}:${side}` → [[s0,s1], …]
    this.paved = new Set();          // 0.9 m grid cells covered by a slab / driveway apron
    this.buildings = [];             // { x, z, hw, hd, c, s } footprint rects for collision tests
    this.ground = new GroundCover(this);
  }

  add(kindId, item) {
    const kind = this.assets.kinds.get(kindId);
    if (!kind) return;
    if (item.s === undefined) item.s = 1;
    kind.items.push(item);
    this.counts[kindId] = (this.counts[kindId] || 0) + 1;
  }

  /**
   * A warm luminaire the renderer may put a real PointLight on.
   *
   * `range` becomes the light's `distance`, which in three is not the falloff — the falloff is
   * 1/d² regardless — but a WINDOW that multiplies it by (1 - (d/range)^4)² and forces it to zero
   * at the cutoff. The declared ranges (22 m for a road lamp, 21 m for a classic one) were barely
   * wider than the mounting height of the luminaire they belong to (~15 m), so the window was
   * still closing over the very ground the lamp is meant to light: directly beneath a road lamp it
   * held back a third of the contribution, and by 22 m out it clipped everything to nothing.
   *
   * Widening it costs nothing measurable — the shader evaluates every point light for every
   * fragment whatever its range, so this changes the arithmetic and not the work. Interleaved over
   * three repetitions at a night street view: 74.4 ms at ×1 against 69.4 ms at ×3, i.e. within
   * noise and if anything faster.
   */
  addSource(x, y, z, color, intensity, range) {
    this.sources.push({
      x, y, z, color,
      intensity: intensity * LIGHT_INTENSITY_SCALE,
      range: range * LIGHT_RANGE_SCALE,
    });
  }

  /* ------------------------------------------------------------- helpers */

  groundY(x, z) {
    const t = this.world.terrain;
    return t && t.getHeight ? t.getHeight(x, z) : 0;
  }

  /** Height of the paved surface at (x,z), or `fallback` when the point is off the network. */
  paveY(x, z, fallback) {
    const api = this.world.roads.api;
    const y = api && api.surfaceHeight ? api.surfaceHeight(x, z) : null;
    return y == null ? fallback : y;
  }

  isWater(x, z) {
    const t = this.world.terrain;
    return !!(t && t.isWater && t.isWater(x, z));
  }

  /**
   * Reserve [s−half, s+half] on one kerb; false when something already stands there.
   * `ch` separates independent lateral channels: 'k' = the sidewalk furniture line,
   * 'p' = the kerbside parking lane (a tree and a parked car never fight for the same metre).
   */
  claim(seg, side, s, half, ch = 'k') {
    const key = `${seg.id}:${side}:${ch}`;
    let list = this.slots.get(key);
    if (!list) { list = []; this.slots.set(key, list); }
    const a = s - half, b = s + half;
    for (const [c, d] of list) if (a < d && b > c) return false;
    list.push([a, b]);
    return true;
  }

  /** Sidewalk edge sample with the tangent worked out from the outward normal. */
  edge(seg, s, side) {
    const api = this.world.roads.api;
    const t = clamp(s / Math.max(1e-3, seg.length), 0, 1);
    const e = api.sampleEdge(seg.id, t, side);
    if (!e) return null;
    e.tx = e.nz * side;
    e.tz = -e.nx * side;
    return e;
  }

  /** Point `d` metres inside the road from an edge sample (negative = beyond the edge). */
  inset(e, d) {
    return { x: e.x - e.nx * d, z: e.z - e.nz * d };
  }

  /** Per-instance foliage albedo: no two shrubs or hedges the same green. */
  leafTint(rng) {
    const t = 0.62 + rng() * 0.46;
    return [t * (0.94 + rng() * 0.2), t * (1.0 + rng() * 0.08), t * (0.86 + rng() * 0.2)];
  }

  /**
   * Crown tint for a street tree. cs2_04 shows six distinguishable species on one street; ours
   * varied only in brightness, so every crown read as the same green blob at a different exposure.
   * Picking a hue class per instance — deep green, mid green, olive, gold, blue-green — spreads a
   * planting across the same range without a second set of leaf textures.
   */
  crownTint(rng, species = 'broad') {
    const t = 0.74 + rng() * 0.40;
    const r = rng();
    // the flowering ornamental already carries a pink card, so it never takes the gold class —
    // gold x pink read as magenta, which is the one hue a street planting never contains
    const h = species === 'conifer' ? (r < 0.55 ? [0.70, 0.94, 0.84] : [0.80, 1.00, 0.72])
      : species === 'blossom' ? (r < 0.5 ? [0.96, 0.98, 0.90] : [0.88, 0.96, 0.84])
        : r < 0.38 ? [0.90, 1.02, 0.74]                     // mid green
          : r < 0.62 ? [0.74, 1.02, 0.66]                   // deep green
            : r < 0.84 ? [1.10, 0.98, 0.56]                 // olive
              : r < 0.94 ? [1.20, 1.00, 0.50]               // gold / turning
                : [0.70, 0.96, 0.86];                       // blue-green
    return [t * h[0] * (0.93 + rng() * 0.14), t * h[1] * (0.95 + rng() * 0.10), t * h[2] * (0.93 + rng() * 0.14)];
  }

  /** Which crown palette a kind takes. */
  crownSpecies(id) { return id === 'tree_conifer' ? 'conifer' : id === 'tree_small' ? 'blossom' : 'broad'; }

  /** Yaw whose local +Z points at the carriageway. */
  faceRoad(e) { return Math.atan2(-e.nx, -e.nz); }
  /** Yaw whose local +Z runs along the road (in the direction of travel on this side). */
  alongRoad(e) { return Math.atan2(e.tx, e.tz); }

  /** Lamp head positions the road asset places on this segment (spacing/phase are public data). */
  roadLamps(seg, def) {
    const lm = def && def.lamps;
    const out = [];
    if (!lm) return out;
    const L = seg.length;
    const s0 = Math.min(seg.trimA || 0, L), s1 = Math.max(s0, L - (seg.trimB || 0));
    const iMin = Math.ceil((s0 + LAMP_MARGIN + seg.phase) / lm.spacing - 0.5);
    const iMax = Math.floor((s1 - LAMP_MARGIN + seg.phase) / lm.spacing - 0.5);
    for (let i = iMin; i <= iMax; i++) {
      const s = (i + 0.5) * lm.spacing - seg.phase;
      const side = lm.alternate ? (((i % 2) + 2) % 2 === 0 ? 1 : -1) : 1;
      const e = this.edge(seg, s, side);
      if (!e) continue;
      const half = seg.width * 0.5;
      if (lm.kind === 'mast') {
        // twin heads reaching out from a median mast (roads models the head 14 cm under the arm)
        const y = e.y + lm.height - 0.14;
        for (const sgn of [-1, 1]) {
          const h = this.inset(e, half + sgn * lm.arm);
          out.push({ s, side: sgn, x: h.x, z: h.z, y, gy: e.y, tx: e.tx, tz: e.tz, color: lm.color, radius: lm.radius });
        }
      } else {
        const h = this.inset(e, half - lm.poleLat + lm.arm);
        const b = this.inset(e, half - lm.poleLat);              // pole base, on the sidewalk
        out.push({
          s, side, x: h.x, z: h.z, y: e.y + lm.height, gy: e.y, tx: e.tx, tz: e.tz,
          bx: b.x, bz: b.z, color: lm.color, radius: lm.radius,
        });
      }
    }
    return out;
  }

  /**
   * Rebuild the building footprint index used to keep hedges, shrubs and driveways out of walls.
   * `world.buildings.list` reports the *lot* extent in `w`/`d`, not the built mass, so the mass is
   * approximated per zone type (houses cover about half their plot, towers nearly all of it).
   */
  indexBuildings() {
    this.buildings.length = 0;
    const list = (this.world.buildings && this.world.buildings.list) || [];
    for (const b of list) {
      if (!b || b.w == null) continue;
      const f = FOOTPRINT[b.type] || FOOTPRINT.default;
      const yaw = b.yaw || 0;
      this.buildings.push({
        x: b.x, z: b.z, hw: b.w * 0.5 * f[0], hd: b.d * 0.5 * f[1],
        c: Math.cos(yaw), s: -Math.sin(yaw), lotId: b.lotId,
        lotHw: b.w * 0.5, lotHd: b.d * 0.5, frac: f,
      });
    }
    this.byLot = new Map();
    for (const b of this.buildings) if (b.lotId != null) this.byLot.set(b.lotId, b);
  }

  /** True when (x,z) falls inside any building footprint grown by `pad` metres. */
  inBuilding(x, z, pad = 0.35) {
    for (const b of this.buildings) {
      const dx = x - b.x, dz = z - b.z;
      if (Math.abs(dx) + Math.abs(dz) > b.hw + b.hd + pad + 2) continue;
      const lx = dx * b.c - dz * b.s, lz = dx * b.s + dz * b.c;
      if (Math.abs(lx) <= b.hw + pad && Math.abs(lz) <= b.hd + pad) return true;
    }
    return false;
  }

  /* -------------------------------------------------------------- scatter */

  scatter(density = 1) {
    this.density = density;
    this.sources.length = 0;
    this.counts = {};
    this.slots.clear();
    this.paved.clear();
    for (const kind of this.assets.kinds.values()) kind.items.length = 0;
    this.indexBuildings();

    const world = this.world;
    const roads = world.roads;
    if (!roads || !roads.api || !roads.segments) return this.counts;
    const types = roads.api.types || {};

    // junctions first: signals, stop signs and the name assembly own their corner of the kerb
    for (const node of roads.nodes.values()) this.junction(node, types);
    for (const seg of roads.segments.values()) {
      const def = (types[seg.type] && types[seg.type].definition) || null;
      this.segment(seg, def);
    }
    this.lots();
    this.ground.run(density);
    this.contacts();
    return this.counts;
  }

  /**
   * Mark an oriented rectangle of hard paving so ground cover never sprouts through it. The p4
   * critic found shrub clumps standing mid-apron on grey paving with no bed and no soil; the yard
   * scatter only tested `roads.api.isOnRoad`, which knows nothing about the slabs and driveway
   * aprons this file lays itself. Rasterised into a 0.9 m grid so the lookup is O(1) per clump.
   * `hw` is the half-width across the frontage, `hd` the half-depth into the lot.
   */
  markPaved(x, z, hw, hd, yaw, pad = 0.35) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const HW = hw + pad, HD = hd + pad;
    for (let u = -HW; u <= HW + 1e-6; u += PAVE_STEP) {
      for (let v = -HD; v <= HD + 1e-6; v += PAVE_STEP) {
        this.paved.add(paveKey(x + c * u + s * v, z - s * u + c * v));
      }
    }
  }

  /** Is (x,z) on a slab, front path or driveway apron this module laid? */
  isPaved(x, z) { return this.paved.has(paveKey(x, z)); }

  /**
   * One ground-occlusion decal under every prop that stands on the ground. Runs last so it sees the
   * final placement list — a prop added anywhere in this file is grounded automatically.
   */
  contacts() {
    for (const id in CONTACT) {
      const kind = this.assets.kinds.get(id);
      if (!kind || !kind.items.length) continue;
      const spec = CONTACT[id];
      const every = spec.every || 1;
      for (let i = 0; i < kind.items.length; i += every) {
        const it = kind.items[i];
        const sc = it.s || 1;
        const stretch = spec.rot ? (it.sx || 1) : 1;      // a stretched hedge piece gets a stretched shadow
        this.add('contact', {
          x: it.x, y: it.y + 0.03, z: it.z, yaw: spec.rot ? it.yaw : 0, s: 1,
          sx: spec.r[0] * 2 * sc * stretch, sy: 1, sz: spec.r[1] * 2 * sc,
        });
      }
    }
  }

  /** Warm pool a luminaire lays on the pavement, and the halo around the head itself. */
  luminaire(x, y, z, gy, color, intensity, range, dia, halo = 1.8, dir = null, base = null) {
    this.addSource(x, y, z, color, intensity, range);
    this.add('halo', { x, y, z, yaw: 0, s: halo });
    // The pool is laid as three overlapping discs strung along the road rather than one big quad:
    // a single 24 m quad is flat, so on any crest or dip it sinks under the carriageway and the
    // depth test slices it off in a hard straight line across the street.
    const n = dir ? 3 : 1;
    const d = dia * (dir ? 0.66 : 1);
    const step = dia * 0.30;
    for (let i = 0; i < n; i++) {
      const k = n === 1 ? 0 : i - 1;
      const px = x + (dir ? dir.x * k * step : 0);
      const pz = z + (dir ? dir.z * k * step : 0);
      this.add('lightpool', {
        x: px, y: this.paveY(px, pz, gy) + 0.09, z: pz, yaw: 0, s: 1, sx: d, sy: 1, sz: d,
      });
    }
    // and one on the footway at the pole base: the sidewalk stands ~20 cm proud of the carriageway,
    // so a pool laid at road height is depth-clipped exactly where pedestrians walk
    if (base) {
      const d2 = dia * 0.62;
      this.add('lightpool', {
        x: base.x, y: this.paveY(base.x, base.z, gy + 0.2) + 0.07, z: base.z,
        yaw: 0, s: 1, sx: d2, sy: 1, sz: d2,
      });
    }
  }

  /** Street furniture along one segment. */
  segment(seg, def) {
    if (!def) return;
    const rng = makeRng(hash2(this.world.seed, hashString('props:' + seg.id)));
    const L = seg.length;
    const s0 = Math.min(seg.trimA || 0, L), s1 = Math.max(s0, L - (seg.trimB || 0));
    const usable = s1 - s0;
    if (usable < 6) return;
    const half = seg.width * 0.5;
    const D = this.density;
    const lamps = this.roadLamps(seg, def);
    for (const l of lamps) {
      this.luminaire(
        l.x, l.y, l.z, l.gy,
        _c.setRGB(l.color[0], l.color[1], l.color[2], THREE.SRGBColorSpace).clone(),
        16, Math.max(22, l.radius * 1.8), clamp(l.radius * 1.95, 17, 36), 1.8,
        { x: l.tx, z: l.tz }, l.bx == null ? null : { x: l.bx, z: l.bz },
      );
      this.claim(seg, l.side, l.s, 1.1);
    }

    if (seg.type === 'highway') return;                     // roads owns the motorway furniture
    if (seg.type === 'path') { this.pathSegment(seg, def, rng); return; }

    const sidewalk = def.sidewalk || 0;
    const isAvenue = seg.type === 'avenue';
    const treeStep = isAvenue ? 11.5 : 14.0;
    const treeIn = clamp(sidewalk * 0.32, 0.55, 1.0);
    const endClear = 8;
    const hydrantSide = rng() < 0.5 ? 1 : -1;
    const parkSide = rng() < 0.5 ? 1 : -1;

    for (const side of [-1, 1]) {
      // --- bus stop first: it is the biggest thing on the kerb
      if (usable > 90 && rng() < (isAvenue ? 0.7 : 0.34) * D) {
        const s = s0 + 26 + rng() * (usable - 56);
        if (this.claim(seg, side, s, isAvenue ? 2.4 : 0.9) && this.claim(seg, side, s, 7.5, 'p')) {
          const e = this.edge(seg, s, side);
          if (e) {
            if (isAvenue) {
              const p = this.inset(e, 1.6);
              this.add('bus_shelter', { x: p.x, y: e.y, z: p.z, yaw: this.faceRoad(e), s: 1 });
              this.luminaire(p.x, e.y + 2.3, p.z, e.y, _c.setHex(0xfff0d8).clone(), 4.5, 12, 8.5, 1.1);
            }
            const f = isAvenue ? this.edge(seg, s + 3.2, side) : e;
            if (f) {
              const q = this.inset(f, Math.max(0.4, half - (def.cwHalf + 0.85)));
              this.add('sign_post', { x: q.x, y: f.y, z: q.z, yaw: this.faceRoad(f), s: 1 });
              this.add('sign_busstop', { x: q.x, y: f.y, z: q.z, yaw: this.faceRoad(f), s: 1 });
            }
          }
        }
      }

      // --- street trees in a regular rhythm, skipping the slots the lamps already hold.
      // A downtown block has a narrower walk than a suburb; at the old 1.6 m gate it got no trees
      // at all, which is what the p4 critic saw. A narrow walk now gets the small ornamental in a
      // pit instead of nothing.
      if (sidewalk >= 1.15) {
        const narrow = sidewalk < 1.6;
        const phase = rng() * treeStep;
        for (let s = s0 + endClear + phase; s < s1 - endClear; s += treeStep) {
          if (rng() > 0.94 * D) continue;
          const js = s + (rng() - 0.5) * 1.2;
          if (!this.claim(seg, side, js, 1.25)) continue;
          const e = this.edge(seg, js, side);
          if (!e) continue;
          const p = this.inset(e, treeIn);
          if (this.isWater(p.x, p.z)) continue;
          if (this.inBuilding(p.x, p.z, 0.6)) continue;
          const r = rng();
          const kindId = narrow ? (r < 0.5 ? 'tree_upright' : r < 0.82 ? 'tree_upright_b' : 'tree_small')
            : r < 0.26 ? 'tree_broad' : r < 0.48 ? 'tree_broad_b'
              : r < 0.64 ? 'tree_upright' : r < 0.78 ? 'tree_upright_b'
                : r < 0.90 ? 'tree_small' : 'tree_conifer';
          const sc = (narrow ? 0.74 : 0.84) + rng() * 0.36;
          this.add(kindId, {
            x: p.x, y: e.y - 0.02, z: p.z, yaw: rng() * Math.PI * 2, s: sc,
            tint: this.crownTint(rng, this.crownSpecies(kindId)),
          });
          this.add('tree_pit', { x: p.x, y: e.y - 0.035, z: p.z, yaw: rng() * 3, s: clamp(sc * 0.9, 0.8, 1.05) });
        }
      }

      // --- benches facing the carriageway, usually with a bin beside them
      const benchStep = isAvenue ? 21 : 30;
      for (let s = s0 + 14 + rng() * benchStep; s < s1 - 10; s += benchStep) {
        if (sidewalk < 1.9 || rng() > 0.86 * D) continue;
        if (!this.claim(seg, side, s, 1.1)) continue;
        const e = this.edge(seg, s, side);
        if (!e) continue;
        const p = this.inset(e, clamp(sidewalk * 0.46, 0.7, 1.2));
        this.add('bench', { x: p.x, y: e.y, z: p.z, yaw: this.faceRoad(e), s: 1 });
        if (rng() < 0.78 && this.claim(seg, side, s + 2.3, 0.5)) {
          const b = this.edge(seg, s + 2.3, side);
          if (b) {
            const q = this.inset(b, clamp(sidewalk * 0.34, 0.5, 0.95));
            this.add(rng() < 0.75 ? 'bin' : 'bin_rust', { x: q.x, y: b.y, z: q.z, yaw: rng() * 6.28, s: 1 });
          }
        }
      }

      // --- litter bins mid-block
      const binStep = 19;
      for (let s = s0 + 20 + rng() * binStep; s < s1 - 8; s += binStep) {
        if (sidewalk < 1.4 || rng() > 0.78 * D) continue;
        if (!this.claim(seg, side, s, 0.5)) continue;
        const e = this.edge(seg, s, side);
        if (!e) continue;
        const p = this.inset(e, clamp(sidewalk * 0.33, 0.45, 0.9));
        this.add(rng() < 0.7 ? 'bin' : 'bin_rust', { x: p.x, y: e.y, z: p.z, yaw: rng() * 6.28, s: 1 });
      }

      // --- hydrants (one side only, deterministic per segment)
      if (side === hydrantSide && sidewalk >= 1.4) {
        for (let s = s0 + 16 + rng() * 40; s < s1 - 12; s += 42 + rng() * 18) {
          if (!this.claim(seg, side, s, 0.45)) continue;
          const e = this.edge(seg, s, side);
          if (!e) continue;
          const p = this.inset(e, Math.max(0.35, half - (def.cwHalf + 0.7)));
          this.add(rng() < 0.65 ? 'hydrant' : 'hydrant_aged', { x: p.x, y: e.y, z: p.z, yaw: rng() * 6.28, s: 1 });
        }
      }

      // --- kerbside clutter: planters and cycle stands on the avenue, news boxes downtown
      if (isAvenue) {
        for (let s = s0 + 18 + rng() * 20; s < s1 - 14; s += 17) {
          if (rng() > 0.82 * D) continue;
          if (!this.claim(seg, side, s, 1.0)) continue;
          const e = this.edge(seg, s, side);
          if (!e) continue;
          const r = rng();
          if (r < 0.45) {
            const p = this.inset(e, 1.05);
            this.add('planter', { x: p.x, y: e.y, z: p.z, yaw: this.alongRoad(e), s: 1 });
          } else if (r < 0.78) {
            for (let k = -1; k <= 1; k++) {
              const b = this.edge(seg, s + k * 0.95, side);
              if (!b) continue;
              const q = this.inset(b, 1.0);
              this.add('cycle_stand', { x: q.x, y: b.y, z: q.z, yaw: this.alongRoad(b), s: 1 });
            }
          } else {
            const p = this.inset(e, 0.95);
            this.add('news_box', { x: p.x, y: e.y, z: p.z, yaw: this.faceRoad(e) + (rng() - 0.5) * 0.3, s: 1 });
          }
        }
      }

      // --- mid-block regulatory signs
      const signStep = isAvenue ? 58 : 46;
      for (let s = s0 + 30 + rng() * signStep; s < s1 - 16; s += signStep) {
        if (rng() > 0.75 * D) continue;
        if (!this.claim(seg, side, s, 0.5)) continue;
        const e = this.edge(seg, s, side);
        if (!e) continue;
        const p = this.inset(e, Math.max(0.35, half - (def.cwHalf + 0.75)));
        const r = rng();
        const id = isAvenue
          ? (r < 0.45 ? 'sign_speed50' : r < 0.75 ? 'sign_priority' : 'sign_noparking')
          : (r < 0.35 ? 'sign_speed30' : r < 0.62 ? 'sign_noparking' : r < 0.85 ? 'sign_parking' : 'sign_crossing');
        const yaw = this.faceRoad(e) + (rng() - 0.5) * 0.1;
        this.add('sign_post', { x: p.x, y: e.y, z: p.z, yaw, s: 1 });
        this.add(id, { x: p.x, y: e.y, z: p.z, yaw, s: 1 });
      }

      // --- utility cabinets against the building line (the clutter CS2 kerbs are full of)
      if (sidewalk >= 2.0) {
        for (let s = s0 + 34 + rng() * 60; s < s1 - 20; s += 78 + rng() * 46) {
          if (rng() > 0.72 * D) continue;
          if (!this.claim(seg, side, s, 0.85)) continue;
          const e = this.edge(seg, s, side);
          if (!e) continue;
          const p = this.inset(e, 0.6);
          this.add('utility_box', { x: p.x, y: e.y, z: p.z, yaw: this.faceRoad(e), s: 1 });
        }
      }
    }

    // --- kerbside parked cars: one side of a local street, tight against the kerb
    if (seg.type === 'local' && usable > 42) {
      const api = this.world.roads.api;
      const slot = 6.4;
      const side = parkSide;
      let gap = 0;
      for (let s = s0 + 13 + rng() * 5; s < s1 - 13; s += slot) {
        if (gap > 0) { gap--; continue; }               // driveways and crossings break the row up
        if (rng() > 0.72 * D) { gap = 1 + ((rng() * 3) | 0); continue; }
        if (!this.claim(seg, side, s, 2.55, 'p')) continue;
        const e = this.edge(seg, s, side);
        if (!e) continue;
        // outer flank 0.15 m off the kerb face → the car never overhangs the sidewalk
        const p = this.inset(e, half - def.cwHalf + 1.12 + (rng() - 0.5) * 0.1);
        const y = api.surfaceHeight ? api.surfaceHeight(p.x, p.z) : null;
        const r = rng();
        const id = r < 0.34 ? 'car_sedan' : r < 0.62 ? 'car_hatch' : r < 0.85 ? 'car_estate' : 'car_van';
        const flip = rng() < 0.5 ? 0 : Math.PI;
        const item = {
          x: p.x, y: y == null ? e.y - 0.21 : y, z: p.z,
          yaw: this.alongRoad(e) + flip + (rng() - 0.5) * 0.04, s: 1,
        };
        item.tint = this.carPalette[(rng() * this.carPalette.length) | 0];
        this.add(id, item);
      }
    }
  }

  /** Park paths: classic lamps, benches, bins and shrubs along the verge. */
  pathSegment(seg, def, rng) {
    const L = seg.length;
    const s0 = Math.min(seg.trimA || 0, L), s1 = Math.max(s0, L - (seg.trimB || 0));
    if (s1 - s0 < 10) return;
    const lampH = (this.assets.modelSizes.lamp_classic && this.assets.modelSizes.lamp_classic[1]) || 4.2;
    let i = 0;
    for (let s = s0 + 6 + rng() * 6; s < s1 - 5; s += 21, i++) {
      const side = i % 2 === 0 ? 1 : -1;
      const e = this.edge(seg, s, side);
      if (!e) continue;
      const p = this.inset(e, -0.6);
      if (this.isWater(p.x, p.z)) continue;
      const y = Math.min(e.y + 0.25, Math.max(e.y - 0.5, this.groundY(p.x, p.z)));
      this.add('lamp_classic', { x: p.x, y, z: p.z, yaw: rng() * 6.28, s: 1 });
      this.luminaire(p.x, y + lampH * 0.93, p.z, y, _c.setHex(0xffc98a).clone(), 10, 21, 13, 1.3);
      if (rng() < 0.55) {
        const b = this.edge(seg, s + 4, -side);
        if (b) {
          const q = this.inset(b, -0.85);
          this.add('bench', { x: q.x, y: this.groundY(q.x, q.z), z: q.z, yaw: this.faceRoad(b), s: 1 });
          if (rng() < 0.5) {
            const r2 = this.edge(seg, s + 6.2, -side);
            if (r2) {
              const q2 = this.inset(r2, -0.8);
              this.add(rng() < 0.7 ? 'bin' : 'bin_rust', { x: q2.x, y: this.groundY(q2.x, q2.z), z: q2.z, yaw: rng() * 6.28, s: 1 });
            }
          }
        }
      }
      // shade trees set back from the path, then shrubs filling the verge
      if (rng() < 0.62) {
        const b = this.edge(seg, s + (rng() - 0.5) * 12, rng() < 0.5 ? 1 : -1);
        if (b) {
          const q = this.inset(b, -2.4 - rng() * 3.4);
          if (!this.isWater(q.x, q.z) && !this.inBuilding(q.x, q.z, 2)) {
            const r = rng();
            const id = r < 0.30 ? 'tree_broad' : r < 0.52 ? 'tree_broad_b' : r < 0.66 ? 'tree_upright'
              : r < 0.78 ? 'tree_small' : 'tree_conifer';
            this.add(id, {
              x: q.x, y: this.groundY(q.x, q.z) - 0.05, z: q.z, yaw: rng() * 6.28, s: 0.9 + rng() * 0.45,
              tint: this.crownTint(rng, this.crownSpecies(id)),
            });
          }
        }
      }
      for (let k = 0; k < 4; k++) {
        if (rng() > 0.62) continue;
        const b = this.edge(seg, s + (rng() - 0.5) * 16, rng() < 0.5 ? 1 : -1);
        if (!b) continue;
        const q = this.inset(b, -1.3 - rng() * 2.6);
        if (this.isWater(q.x, q.z) || this.inBuilding(q.x, q.z, 1)) continue;
        this.add(rng() < 0.5 ? 'bush_a' : 'bush_b', { x: q.x, y: this.groundY(q.x, q.z) - 0.05, z: q.z, yaw: rng() * 6.28, s: 0.85 + rng() * 0.55, tint: this.leafTint(rng) });
      }
    }
  }

  /** Signals, stop signs, corner bins/bollards and the street-name assembly at one junction. */
  junction(node, types) {
    const roads = this.world.roads;
    const arms = [];
    for (const sid of node.segments) {
      const seg = roads.segments.get(sid);
      if (!seg) continue;
      const def = (types[seg.type] && types[seg.type].definition) || null;
      // motorways carry their own furniture; footpaths never get road signs
      if (!def || seg.type === 'highway' || seg.type === 'path') continue;
      const atA = seg.a === node.id;
      const L = seg.length;
      const back = 3.6;
      const s = atA ? Math.min(seg.trimA + back, L * 0.5) : Math.max(L - seg.trimB - back, L * 0.5);
      const side = atA ? -1 : 1;                    // the approaching driver's right-hand kerb
      const e = this.edge(seg, s, side);
      if (!e) continue;
      // travel direction toward the node
      const tx = atA ? -e.tx : e.tx, tz = atA ? -e.tz : e.tz;
      arms.push({ seg, def, e, s, side, tx, tz, rank: RANK[seg.type] || 2, heading: Math.atan2(tx, tz) });
    }
    if (arms.length < 3) return;
    const rng = makeRng(hash2(this.world.seed, hashString('propsj:' + node.id)));
    const maxRank = Math.max(...arms.map((a) => a.rank));
    const signalized = maxRank >= 3;
    const half = (a) => a.seg.width * 0.5;

    for (const a of arms) {
      const inset = Math.max(0.45, half(a) - (a.def.cwHalf + 0.9));
      const p = this.inset(a.e, inset);
      const yaw = Math.atan2(-a.tx, -a.tz);          // face the oncoming driver
      this.claim(a.seg, a.side, a.s, 2.2);
      if (signalized) {
        const phase = Math.abs(Math.cos(a.heading - arms[0].heading)) > 0.5 ? 0 : 1;
        // a mast arm hangs the heads over the carriageway on the big approaches (the CS2 look)
        const mast = a.rank >= 3;
        this.add(mast ? 'traffic_light_mast' : 'traffic_light', { x: p.x, y: a.e.y, z: p.z, yaw, s: 1, phase });
        this.addSource(p.x, a.e.y + 3.2, p.z, _c.setHex(0xff9a5a).clone(), 1.6, 8);
      } else if (a.rank < maxRank || arms.length >= 4) {
        this.add('sign_post', { x: p.x, y: a.e.y, z: p.z, yaw, s: 1 });
        this.add('sign_stop', { x: p.x, y: a.e.y, z: p.z, yaw, s: 1 });
      } else if (arms.length === 3) {
        // the stem of a T gives way
        let aligned = 0;
        for (const b of arms) if (b !== a) aligned = Math.max(aligned, Math.abs(Math.cos(a.heading - b.heading)));
        if (aligned < 0.72) {
          this.add('sign_post', { x: p.x, y: a.e.y, z: p.z, yaw, s: 1 });
          this.add('sign_yield', { x: p.x, y: a.e.y, z: p.z, yaw, s: 1 });
        }
      }
      // corner bin / bollards
      if (rng() < 0.35) {
        const s2 = this.armS(a, 6.6);
        if (this.claim(a.seg, a.side, s2, 0.5)) {
          const b = this.edge(a.seg, s2, a.side);
          if (b) {
            const q = this.inset(b, inset + 1.2);
            this.add(rng() < 0.7 ? 'bin' : 'bin_rust', { x: q.x, y: b.y, z: q.z, yaw: rng() * 6.28, s: 1 });
          }
        }
      }
      if (a.rank >= 3 && rng() < 0.75) {
        for (let i = 0; i < 3; i++) {
          const b = this.edge(a.seg, this.armS(a, 5.5 + i * 1.6), a.side);
          if (!b) continue;
          const q = this.inset(b, Math.max(0.4, half(a) - (a.def.cwHalf + 0.5)));
          this.add('bollard', { x: q.x, y: b.y, z: q.z, yaw: 0, s: 1 });
        }
      }
    }

    // street-name assembly on the first arm's corner
    const a0 = arms[0];
    const inset0 = Math.max(0.5, half(a0) - (a0.def.cwHalf + 1.35));
    const p0 = this.inset(a0.e, inset0);
    this.add('sign_post', { x: p0.x, y: a0.e.y, z: p0.z, yaw: 0, s: 1.26 });
    const rowFor = (id) => Math.abs(hashString(id)) % 4;
    const seen = new Set();
    let placed = 0;
    for (const a of arms) {
      const row = rowFor(a.seg.id);
      if (seen.has(row) || placed >= 2) continue;
      seen.add(row);
      this.add(`name_blade_${row}`, { x: p0.x, y: a0.e.y, z: p0.z, yaw: a.heading + Math.PI / 2, s: 1 });
      placed++;
    }
  }

  /** Arc-length `d` metres back from a junction along one arm. */
  armS(a, d) {
    const seg = a.seg, L = seg.length;
    const atA = a.side === -1;
    return atA ? Math.min(seg.trimA + d, L * 0.5) : Math.max(L - seg.trimB - d, L * 0.5);
  }

  /* ----------------------------------------------------------------- lots */

  /** Hedges, fences, garden shrubs and off-street parking on the lots that carry a building. */
  lots() {
    const zones = this.world.zones;
    const lots = zones && zones.api && typeof zones.api.lotsFor === 'function' ? zones.api.lotsFor() : (zones && zones.lots) || [];
    if (!lots || !lots.length) return;
    const seen = new Set();
    const STEP = 2.6;      // hedge/fence piece length (the geometry is 2 m and is stretched to fit)
    for (const lot of lots) {
      if (!lot.corners || !lot.buildingId) continue;
      const rng = makeRng(hash2(this.world.seed, hashString('propsl:' + lot.id)));
      const style = lot.type === 'ind' ? 'fence_chain'
        : lot.type === 'res-low' ? (Math.abs(hashString(lot.id)) % 3 === 0 ? 'fence_picket' : 'hedge')
          : lot.type === 'res-high' ? 'hedge' : null;
      if (style && (style === 'fence_chain' || rng() < 0.66)) {
        const c = lot.corners;                       // [f0 f1 b1 b0] going around the lot
        const edges = [[2, 3], [3, 0], [1, 2]];      // rear + the two sides (never the frontage)
        for (const [i, j] of edges) {
          const x0 = c[i * 2], z0 = c[i * 2 + 1], x1 = c[j * 2], z1 = c[j * 2 + 1];
          const len = Math.hypot(x1 - x0, z1 - z0);
          if (len < 1.2) continue;
          const n = Math.max(1, Math.round(len / STEP));
          const yaw = Math.atan2(x1 - x0, z1 - z0) - Math.PI / 2;  // local +X runs along the edge
          for (let k = 0; k < n; k++) {
            const t = (k + 0.5) / n;
            const x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
            const key = `${Math.round(x * 0.7)}:${Math.round(z * 0.7)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            if (this.isWater(x, z) || this.inBuilding(x, z, 0.55)) continue;
            const y = this.groundY(x, z);
            const sx = (len / n) / 2.0;
            this.add(style, {
              x, y: y - 0.05, z, yaw, s: 1, sx, sz: 1,
              sy: style === 'hedge' ? 0.92 + rng() * 0.26 : 1,
              tint: style === 'hedge' ? this.leafTint(rng) : undefined,
            });
            // weeds bank up along a boundary — the detail that stops a fence line reading as a decal
            if (k % 2 === 0 && rng() < 0.55) {
              const ox = Math.cos(yaw) * 0.55, oz = -Math.sin(yaw) * 0.55;
              this.ground.clump(x + ox, z + oz, 1 + ((rng() * 2.2) | 0), 0.4, rng, {});
            }
          }
        }
      }
      this.lotParking(lot, rng);
      this.lotDressing(lot, rng, style);
      // a couple of shrubs in the front garden
      if ((lot.type === 'res-low' || lot.type === 'res-high') && lot.frontage && rng() < 0.8) {
        const f = lot.frontage;
        for (let k = 0; k < 3; k++) {
          const along = (rng() - 0.5) * (lot.w - 2.4);
          const depth = 2.0 + rng() * 2.6;
          const x = f.x + (-f.nz) * along + f.nx * depth;
          const z = f.z + f.nx * along + f.nz * depth;
          if (this.isWater(x, z) || this.inBuilding(x, z, 0.6)) continue;
          this.add(rng() < 0.5 ? 'bush_a' : 'bush_b', { x, y: this.groundY(x, z) - 0.04, z, yaw: rng() * 6.28, s: 0.8 + rng() * 0.45, tint: this.leafTint(rng) });
        }
      }
    }
  }

  /**
   * Lot dressing — the difference between a house on a lawn and a house someone lives in:
   * a paved front path to the door, a planting bed against the facade, a mailbox at the boundary,
   * wheelie bins down the side, a shed in the back garden, and a clipped front hedge with a gap
   * where the path crosses it. Commercial frontages get an A-board and planters instead.
   */
  lotDressing(lot, rng, style) {
    const f = lot.frontage;
    if (!f) return;
    const b = this.byLot && this.byLot.get(lot.id);
    const res = lot.type === 'res-low' || lot.type === 'res-high';
    const com = lot.type === 'com-low' || lot.type === 'com-high' || lot.type === 'office';
    const yawIn = Math.atan2(f.nx, f.nz);
    // lot-local frame: `along` runs across the frontage, `depth` runs into the plot
    const at = (along, depth) => ({
      x: f.x + (-f.nz) * along + f.nx * depth,
      z: f.z + (f.nx) * along + f.nz * depth,
    });
    const free = (p, pad = 0.4) => !this.isWater(p.x, p.z) && !this.inBuilding(p.x, p.z, pad);

    if (com) {
      // shopfront clutter, right where a pedestrian would meet it
      if (rng() < 0.55) {
        const p = at((rng() - 0.5) * Math.max(1.5, lot.w - 3.0), 0.45);
        if (free(p, 0.2)) this.add('a_board', { x: p.x, y: this.groundY(p.x, p.z), z: p.z, yaw: yawIn + (rng() - 0.5) * 0.6, s: 1 });
      }
      for (let k = 0; k < 2; k++) {
        if (rng() > 0.5) continue;
        const p = at((k ? 1 : -1) * (lot.w * 0.5 - 1.1), 0.7 + rng() * 0.5);
        if (!free(p, 0.2)) continue;
        const y = this.groundY(p.x, p.z);
        this.add('planter', { x: p.x, y, z: p.z, yaw: yawIn, s: 1 });
      }
      return;
    }
    if (!res || !b) return;

    // where the house sits in the plot, measured from the frontage
    const dc = (b.x - f.x) * f.nx + (b.z - f.z) * f.nz;
    const ac = (b.x - f.x) * (-f.nz) + (b.z - f.z) * (f.nx);
    const stop = dc - b.hd - 0.15;
    let lat = ac + (rng() - 0.5) * Math.min(2.0, b.hw * 1.2);

    // --- front path: slabs from the boundary to the front door
    if (stop > 1.4) {
      const n = Math.max(2, Math.round(stop / 1.15));
      for (let i = 0; i < n; i++) {
        const depth = 0.3 + (stop - 0.3) * ((i + 0.5) / n);
        const p = at(lat, depth);
        if (this.isWater(p.x, p.z)) continue;
        const sz = (stop - 0.3) / n + 0.06;
        this.add('slab', {
          x: p.x, y: this.groundY(p.x, p.z) + 0.035, z: p.z, yaw: yawIn, s: 1,
          sx: 1.18, sy: 1, sz,
        });
        this.markPaved(p.x, p.z, 0.59, sz * 0.5, yawIn);
      }
      // mailbox at the boundary, beside the path
      if (rng() < 0.72) {
        const p = at(lat + (rng() < 0.5 ? -1 : 1) * (0.85 + rng() * 0.4), 0.45);
        if (free(p, 0.3)) this.add('mailbox', { x: p.x, y: this.groundY(p.x, p.z), z: p.z, yaw: yawIn + (rng() - 0.5) * 0.3, s: 0.9 + rng() * 0.2 });
      }
    } else lat = ac;

    // --- planting bed against the facade, on the wider side of the path
    if (stop > 0.9 && rng() < 0.8) {
      const sgn = lat > ac ? -1 : 1;
      const along = ac + sgn * (b.hw * 0.55 + 0.3);
      const depth = Math.max(0.7, stop - 0.55);
      const p = at(along, depth);
      if (free(p, 0.05)) {
        const w = clamp(b.hw * 1.1, 1.2, 3.2);
        this.add('bed', { x: p.x, y: this.groundY(p.x, p.z) + 0.035, z: p.z, yaw: yawIn, s: 1, sx: w * 2, sy: 1, sz: 1.25 });
        for (let k = 0; k < 5; k++) {
          const q = at(along + (rng() - 0.5) * w * 1.7, depth + (rng() - 0.5) * 0.85);
          if (!free(q, 0.05)) continue;
          const t = 0.66 + rng() * 0.4;
          this.add(rng() < 0.62 ? 'tuft_flower' : 'tuft_a', {
            x: q.x, y: this.groundY(q.x, q.z) - 0.02, z: q.z, yaw: rng() * 6.28,
            s: 0.8 + rng() * 0.5, tint: [t * 1.04, t, t * 0.94],
          });
        }
        if (rng() < 0.5) {
          const q = at(along + (rng() - 0.5) * w, depth - 0.1);
          if (free(q, 0.05)) this.add(rng() < 0.5 ? 'bush_a' : 'bush_b', { x: q.x, y: this.groundY(q.x, q.z) - 0.04, z: q.z, yaw: rng() * 6.28, s: 0.7 + rng() * 0.4, tint: this.leafTint(rng) });
        }
      }
    }

    // --- wheelie bins down the side of the house
    const binSide = rng() < 0.5 ? -1 : 1;
    if (rng() < 0.68 && lot.w * 0.5 - b.hw > 1.1) {
      const nb = 1 + (rng() < 0.45 ? 1 : 0);
      for (let k = 0; k < nb; k++) {
        const p = at(ac + binSide * (b.hw + 0.55 + k * 0.7), Math.max(0.9, dc - b.hd * 0.4));
        if (!free(p, 0.25)) continue;
        this.add('wheelie_bin', { x: p.x, y: this.groundY(p.x, p.z), z: p.z, yaw: yawIn + (rng() - 0.5) * 0.5, s: 1 });
      }
    }

    // --- garden shed at the back
    if (lot.type === 'res-low' && lot.d > 19 && lot.w > 12 && rng() < 0.3) {
      const p = at(ac - binSide * (lot.w * 0.5 - 1.5), lot.d - 2.4);
      if (free(p, 0.6)) this.add('garden_shed', { x: p.x, y: this.groundY(p.x, p.z), z: p.z, yaw: yawIn + (rng() - 0.5) * 0.4, s: 0.9 + rng() * 0.2 });
    }

    // --- clipped front hedge with a gap for the path
    if (style === 'hedge' && lot.corners && rng() < 0.62) {
      const c = lot.corners;
      const x0 = c[0], z0 = c[1], x1 = c[2], z1 = c[3];
      const len = Math.hypot(x1 - x0, z1 - z0);
      if (len > 3.0) {
        const n = Math.max(2, Math.round(len / 2.6));
        const yaw = Math.atan2(x1 - x0, z1 - z0) - Math.PI / 2;
        const gap = at(lat, 0);
        for (let k = 0; k < n; k++) {
          const t = (k + 0.5) / n;
          const x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
          if (Math.hypot(x - gap.x, z - gap.z) < 1.35) continue;
          if (this.isWater(x, z) || this.inBuilding(x, z, 0.55)) continue;
          this.add('hedge', {
            x, y: this.groundY(x, z) - 0.05, z, yaw, s: 1,
            sx: (len / n) / 2.0, sy: 0.74 + rng() * 0.2, sz: 0.9, tint: this.leafTint(rng),
          });
        }
      }
    }
  }

  /**
   * Off-street parking: a gravel drive down the side of a house with a car on it. Placed only where
   * the plot is genuinely wider than the built mass, so a drive never runs through a wall.
   */
  lotParking(lot, rng) {
    const f = lot.frontage;
    if (!f) return;
    const b = this.byLot && this.byLot.get(lot.id);
    if (!b) return;
    const res = lot.type === 'res-low' || lot.type === 'res-high';
    if (!res) return;
    // the drive runs down the side of the house: laterally clear of the mass, 3.4 m off the kerb
    const clear = lot.w * 0.5 - b.hw;
    if (clear < 3.0 || lot.d < 12) return;
    if (rng() > 0.72) return;
    const along = (rng() < 0.5 ? -1 : 1) * (lot.w * 0.5 - 1.55);
    const depth = 3.4 + rng() * 0.6;
    const x = f.x + (-f.nz) * along + f.nx * depth;
    const z = f.z + f.nx * along + f.nz * depth;
    if (this.isWater(x, z) || this.inBuilding(x, z, 0.5)) return;
    const y = this.groundY(x, z);
    const yawIn = Math.atan2(f.nx, f.nz);                       // +Z points into the lot
    this.add('driveway', { x, y: y + 0.02, z, yaw: yawIn, s: 1 });
    this.markPaved(x, z, 1.35, 2.7, yawIn);        // makeApron() is 2.7 x 5.4 m
    if (rng() > 0.78) return;                                   // a few drives stay empty
    const r = rng();
    const id = r < 0.3 ? 'car_sedan' : r < 0.56 ? 'car_hatch' : r < 0.8 ? 'car_estate' : r < 0.92 ? 'car_van' : 'car_covered';
    const item = { x, y, z, yaw: yawIn + (rng() < 0.5 ? 0 : Math.PI) + (rng() - 0.5) * 0.05, s: 1 };
    if (id !== 'car_covered') item.tint = this.carPalette[(rng() * this.carPalette.length) | 0];
    this.add(id, item);
  }
}
