/**
 * props — instanced renderer.
 *
 * One InstancedMesh per (kind, material part), two LOD levels for trees. A throttled visibility
 * pass (camera moved / every N frames) does per-instance distance + frustum culling, picks the LOD
 * and streams the matrices into the instance buffers, so draw calls stay flat while the city grows.
 * When a kind has more visible instances than its cap, a distance histogram picks a cutoff radius —
 * O(n) and stable, so instances thin out with distance instead of popping at random.
 *
 * It also owns the real light pool: a fixed number of PointLights (allocated up-front so the light
 * count — and therefore every shader program — never changes) parked on the luminaires nearest the
 * camera at night.
 */
import * as THREE from 'three';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _sph = new THREE.Sphere();
const _cam = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _mvp = new THREE.Matrix4();
const _lightFrustum = new THREE.Frustum();
const _lightVP = new THREE.Matrix4();
const _lightSphere = new THREE.Sphere();
const BUCKETS = 48;
/** Transparent-pass draw order inside the props group (see build()). */
const ORDER = { lightpool: 1, contact: 2, halo: 3 };

export class PropRenderer {
  constructor(ctx, assets) {
    this.ctx = ctx;
    this.engine = ctx.engine;
    this.assets = assets;
    this.group = new THREE.Group();
    this.group.name = 'props';
    this.group.matrixAutoUpdate = false;
    ctx.scene.add(this.group);

    this.frustum = new THREE.Frustum();
    this.lastCam = new THREE.Vector3(1e9, 1e9, 1e9);
    this.lastDir = new THREE.Vector3();
    this.frame = 0;
    this.dirty = true;
    this.hist = new Int32Array(BUCKETS);
    this.stats = { kinds: 0, meshes: 0, drawn: 0, placed: 0, visible: 0, lights: 0, passMs: 0 };

    // --- real light pool -------------------------------------------------
    const q = this.engine.quality;
    /**
     * Pool size. Every light in this pool is compiled into the light-count define on every lit
     * material in the scene (NUM_SPOT_LIGHTS, since these are spots — see below) and evaluated per
     * fragment whether or not it is switched on, so the pool is a whole-frame cost, not a
     * night-time one. Measured at 1080p on the demo city, interleaved over three repetitions to
     * survive a contended machine:
     *
     *     12 lights  160.2 ms      4 lights  131.0 ms (-18%)      0 lights  121.9 ms (-24%)
     *
     * What it buys today is nothing. At a night street view where all twelve are lit at full
     * intensity, switching every one of them off changes the frame by a mean of 0.01/255, and the
     * single most-affected 120 px window in the image is indistinguishable. The cause is not
     * intensity — multiplying it by 20 changes nothing measurable — it is RANGE: `distance` is
     * ~22 m on a luminaire mounted ~15 m up, so the sphere barely reaches the pavement and what
     * lands there is swamped by the emissive glow and the MAX-blended ground pool that already
     * draw the light for free. Tripling the range is what makes these lights matter (19% of pixels
     * move), and that is a look decision with the frame budget attached, not a perf fix.
     *
     * So: keep a small pool so the mechanism survives for whoever fixes the range, and stop paying
     * for twelve of them in the meantime.
     */
    const n = q.density >= 1.2 ? 6 : q.density >= 0.9 ? 4 : q.density >= 0.6 ? 3 : 2;
    this.lights = [];
    this.lightGroup = new THREE.Group();
    this.lightGroup.name = 'props/lights';
    for (let i = 0; i < n; i++) {
      /**
       * A SpotLight aimed down, not a PointLight. A luminaire is a shade over a bulb: it throws
       * light at the road, not at the building beside it. As a point light it lit the two equally,
       * and that spill — not clipping — was what put a ceiling on the intensity, because past a
       * point the tower corner reads as deliberately uplit rather than as a lamp catching the
       * lower storeys.
       *
       * ANGLE is the half-angle of the cone. At 1.3 rad (74°) a head 15 m up covers a ~32 m radius
       * of carriageway, comfortably more than the spacing these lamps sit at, and a lower fitting
       * covers proportionally less — the cone widens with distance, so one angle serves both the
       * 15 m road lamps and the 3.2 m warm fittings. PENUMBRA softens the rim so there is no
       * cookie-cutter disc on the asphalt.
       */
      const l = new THREE.SpotLight(0xffb877, 0, 46, 1.3, 0.35, 2);
      l.name = `props/lamp${i}`;
      l.castShadow = false;
      // never toggled: three recompiles every lit material when the visible light count changes,
      // so the pool stays in the scene from the first frame and idles at intensity 0
      l.visible = true;
      l.position.set(0, -1000, 0);
      // three reads the cone direction from target.matrixWorld, so the target has to be in the graph
      l.target.position.set(0, -1010, 0);
      this.lightGroup.add(l.target);
      this.lights.push({ light: l, source: null, want: null, level: 0 });
      this.lightGroup.add(l);
    }
    ctx.scene.add(this.lightGroup);
    this.sources = [];
    this.lightTimer = 0;
  }

  /** (Re)build the instanced meshes for every kind that has placements. */
  build() {
    this.clearMeshes();
    let meshes = 0, placed = 0;
    for (const kind of this.assets.kinds.values()) {
      kind.meshes = [];
      kind.lodMeshes = [];
      const n = kind.items.length;
      placed += n;
      if (!n) continue;
      const cap = Math.min(kind.cap, n);
      const makeSet = (parts, lod) => parts.map((part) => {
        const mesh = new THREE.InstancedMesh(part.geometry, part.material, cap);
        mesh.name = `props/${kind.id}${lod ? '_lod' : ''}`;
        mesh.frustumCulled = false;              // culled per instance in pass()
        mesh.castShadow = !!part.cast && !lod;
        mesh.receiveShadow = part.receive !== false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.count = 0;
        if (kind.tint && part.tint) {
          mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
          mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
        }
        if (part.attr) {
          const a = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
          a.setUsage(THREE.DynamicDrawUsage);
          mesh.geometry.setAttribute(part.attr, a);
          mesh.userData.attr = a;
        }
        // billboards, ground decals and alpha-card undergrowth are skipped by the GTAO pre-pass:
        // it renders with scene.overrideMaterial and cannot alpha-test, so they would stamp solid
        // occlusion blocks into the AO buffer
        if (kind.id === 'halo' || kind.noAo) mesh.layers.set(this.engine.LAYER_NO_AO);
        // only the shelters are big enough to be worth a second pass in the water reflection;
        // street trees are not — 800 of them cost ~0.5 M triangles there for a rarely-seen gain
        else if (kind.reflected && !lod) mesh.layers.enable(this.engine.LAYER_REFLECTED);
        // transparent-pass order is contractual: the warm light pools set the lit level of the
        // pavement first, then the contact decals multiply it down, so a car standing inside a pool
        // keeps its grounding instead of having it erased. Halos ride on top of both.
        mesh.renderOrder = ORDER[kind.id] || 0;
        this.group.add(mesh);
        meshes++;
        return mesh;
      });
      kind.meshes = makeSet(kind.parts, 0);
      if (kind.lodParts) kind.lodMeshes = makeSet(kind.lodParts, 1);
    }
    this.stats.kinds = this.assets.kinds.size;
    this.stats.meshes = meshes;
    this.stats.placed = placed;
    this.dirty = true;
  }

  clearMeshes() {
    for (const m of [...this.group.children]) {
      this.group.remove(m);
      m.dispose();   // instance buffers only — geometries/materials are owned by PropAssets
    }
    for (const kind of this.assets.kinds.values()) { kind.meshes = []; kind.lodMeshes = []; }
  }

  /** Distance/frustum/LOD pass. Cheap enough to run a few times a second. */
  pass(camera) {
    const t0 = performance.now();
    camera.updateMatrixWorld();
    _mvp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(_mvp);
    for (const p of this.frustum.planes) p.constant += 8; // margin: the pass is throttled
    camera.getWorldPosition(_cam);

    let visible = 0;
    this.drawn = 0;
    const night = this.assets.shared.uNight.value;
    for (const kind of this.assets.kinds.values()) {
      const items = kind.items;
      if (!items.length || !kind.meshes.length) continue;
      if (kind.nightOnly && night < 0.02) { for (const m of kind.meshes) this._finish(m, 0); continue; }
      const cap = kind.meshes[0].instanceMatrix.count;
      const max = kind.maxDist, max2 = max * max;
      const lod2 = kind.lodDist * kind.lodDist;
      const hasLod = kind.lodMeshes.length > 0;

      // pass 1 — count what is visible, bucketed by distance (only needed when over cap)
      let n = 0;
      this.hist.fill(0);
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const dx = it.x - _cam.x, dy = it.y - _cam.y, dz = it.z - _cam.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > max2) { it._v = 0; continue; }
        const r = kind.radius * it.s;
        _sph.center.set(it.x, it.y + r * 0.45, it.z);
        _sph.radius = r;
        if (!this.frustum.intersectsSphere(_sph)) { it._v = 0; continue; }
        it._v = 1;
        it._d2 = d2;
        n++;
        const b = Math.min(BUCKETS - 1, (Math.sqrt(d2) / max * BUCKETS) | 0);
        this.hist[b]++;
      }
      // distance cutoff when the kind overflows its instance budget
      let cut2 = max2;
      if (n > cap) {
        let acc = 0, b = 0;
        for (; b < BUCKETS; b++) { if (acc + this.hist[b] > cap) break; acc += this.hist[b]; }
        const cut = (b / BUCKETS) * max;
        cut2 = cut * cut;
      }

      // pass 2 — write matrices
      let n0 = 0, n1 = 0;
      const m0 = kind.meshes, m1 = kind.lodMeshes;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (!it._v || it._d2 > cut2) continue;
        const useLod = hasLod && it._d2 > lod2;
        const slot = useLod ? n1 : n0;
        if (slot >= cap) continue;
        _pos.set(it.x, it.y, it.z);
        _q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, it.yaw);
        _scl.set(it.s * (it.sx || 1), it.s * (it.sy || 1), it.s * (it.sz || 1));
        _m.compose(_pos, _q, _scl);
        const target = useLod ? m1 : m0;
        for (const mesh of target) {
          _m.toArray(mesh.instanceMatrix.array, slot * 16);
          if (mesh.instanceColor && it.tint) mesh.instanceColor.array.set(it.tint, slot * 3);
          else if (mesh.instanceColor) { mesh.instanceColor.array[slot * 3] = 1; mesh.instanceColor.array[slot * 3 + 1] = 1; mesh.instanceColor.array[slot * 3 + 2] = 1; }
          if (mesh.userData.attr) mesh.userData.attr.array[slot] = it.phase || 0;
        }
        if (useLod) n1++; else n0++;
      }
      for (const mesh of m0) this._finish(mesh, n0);
      for (const mesh of m1) this._finish(mesh, n1);
      visible += n0 + n1;
    }
    this.stats.visible = visible;
    this.stats.drawn = this.drawn;
    this.stats.passMs = +(performance.now() - t0).toFixed(2);
  }

  _finish(mesh, n) {
    mesh.count = n;
    mesh.visible = n > 0;
    if (!n) return;
    this.drawn++;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    if (mesh.userData.attr) mesh.userData.attr.needsUpdate = true;
  }

  /**
   * Re-aim the real lights at the luminaires worth lighting. A light only moves to a new luminaire
   * once it has faded out, so lamps cross-fade instead of teleporting.
   *
   * "Worth lighting" has to mean ON SCREEN now that these are spots, and that coupling is the whole
   * trap. Nearest-to-camera was fine for a point light — a 66 m sphere spills into frame from a
   * lamp behind you — but a cone lights only a small disc under its own pole, so a lamp out of
   * frame contributes literally nothing. Measured before this changed: all four pooled lamps sat
   * below the bottom of the frame (NDC y −2.9 to −12.6) at 37-42 m, because under a pure distance
   * metric a lamp 37 m behind outscores one 60 m ahead. Every one of the four was dark on screen,
   * and the conversion to spots read as "the lamps stopped working".
   *
   * So the ground pool each luminaire would cast is frustum-tested, and lamps whose pool is in
   * frame are preferred by a wide margin. Off-screen lamps are still ranked rather than dropped,
   * so a slot always has somewhere to go and the cross-fade never snaps.
   */
  updateLights(camera, nightFactor, dt) {
    if (!this.lights.length) return;
    const on = nightFactor > 0.015 && this.sources.length > 0;
    this.lightTimer -= dt;
    if (on && this.lightTimer <= 0) {
      this.lightTimer = 0.25;
      camera.getWorldPosition(_cam);
      camera.getWorldDirection(_dir);
      _lightFrustum.setFromProjectionMatrix(
        _lightVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
      );
      // horizontal view direction, normalised — the raw one collapses as the camera tilts down,
      // which is exactly when the ahead bias mattered most
      const fl = Math.hypot(_dir.x, _dir.z) || 1;
      const fx = _dir.x / fl, fz = _dir.z / fl;
      const N = this.lights.length;
      const best = [];
      const worst = () => best[best.length - 1];
      for (const s of this.sources) {
        const dx = s.x - _cam.x, dy = s.y - _cam.y, dz = s.z - _cam.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > 32000) continue;                       // ~180 m
        const dl = Math.sqrt(dx * dx + dz * dz) || 1;
        const ahead = (dx * fx + dz * fz) / dl;         // −1 behind … +1 in front
        // is the pool this luminaire would cast actually in frame?
        _lightSphere.center.set(s.x, s.groundY ?? (s.y - 6), s.z);
        _lightSphere.radius = 16;
        const inFrame = _lightFrustum.intersectsSphere(_lightSphere);
        const score = d2 * (1.0 - 0.42 * ahead) * (inFrame ? 1 : 40);
        if (best.length < N) {
          best.push({ s, score });
          best.sort((p, q2) => p.score - q2.score);
        } else if (score < worst().score) {
          best[N - 1] = { s, score };
          best.sort((p, q2) => p.score - q2.score);
        }
      }
      for (let i = 0; i < N; i++) this.lights[i].want = best[i] ? best[i].s : null;
    } else if (!on) {
      for (const slot of this.lights) slot.want = null;
    }

    let live = 0;
    const k = Math.min(1, dt * 5.0);
    for (const slot of this.lights) {
      const want = slot.want || null;
      if (slot.source !== want && slot.level < 0.06) {
        slot.source = want;
        if (want) {
          slot.light.position.set(want.x, want.y, want.z);
          // straight down at the ground this luminaire stands over
          slot.light.target.position.set(want.x, want.groundY ?? (want.y - 6), want.z);
          slot.light.target.updateMatrixWorld();
          slot.light.color.copy(want.color);
          slot.light.distance = want.range;
        }
      }
      const target = slot.source && slot.source === want ? 1 : 0;
      slot.level += (target - slot.level) * k;
      const s = slot.source;
      slot.light.intensity = s ? s.intensity * nightFactor * slot.level : 0;
      if (slot.light.intensity > 0.02) live++;
    }
    this.stats.lights = live;
  }

  /** Run the visibility pass when it is worth it (camera moved, or every few frames). */
  update(dt, camera) {
    this.frame++;
    camera.getWorldPosition(_pos);
    camera.getWorldDirection(_dir);
    const moved = _pos.distanceToSquared(this.lastCam) > 9;
    const turned = _dir.dot(this.lastDir) < 0.9993;
    if (this.dirty || moved || turned || this.frame % 15 === 0) {
      this.lastCam.copy(_pos);
      this.lastDir.copy(_dir);
      this.dirty = false;
      this.pass(camera);
    }
  }

  dispose() {
    this.clearMeshes();
    this.ctx.scene.remove(this.group);
    this.ctx.scene.remove(this.lightGroup);
    for (const s of this.lights) s.light.dispose();
    this.lights.length = 0;
  }
}
