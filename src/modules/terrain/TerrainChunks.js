/**
 * Chunked heightmap mesh with distance LOD, plus a two-ring "horizon" outside the playable map
 * (8 m tiles out to 2×half, 32 m tiles out to 4×half) built from the heightmap's coarse grids.
 * Vertex positions are baked in world space (chunk meshes sit at the origin) so the splat shader
 * can use them directly. Cracks between LOD levels are hidden with skirts. Horizon vertices carry
 * an `aCtrl` attribute (dry, dirt, forest, rockBoost) computed with the same rules as the in-map
 * control texture, so the material is continuous across the map boundary.
 */
import * as THREE from 'three';

const LOD_SEGMENTS = [128, 64, 32, 16];
const _box = new THREE.Box3();

export class TerrainChunks {
  constructor({ heightmap, material, horizonMaterial, controlAt, chunkSize = 256, lodDistances = [100, 320, 800], castShadow = true, horizon = true }) {
    this.hm = heightmap;
    this.material = material;
    this.horizonMaterial = horizonMaterial || material;
    this.controlAt = controlAt;
    this.chunkSize = chunkSize;
    this.lodDistances = lodDistances;
    this.castShadow = castShadow;
    this.group = new THREE.Group();
    this.group.name = 'terrain-chunks';
    this.group.matrixAutoUpdate = false;
    this.chunks = [];
    this.horizonTiles = [];
    this.count = Math.round(heightmap.size / chunkSize);
    this._buildChunks();
    this._buildSuperChunks();
    if (horizon) this._buildHorizon();
  }

  /** 4×4 chunk groups rendered as a single mesh while all their children are at the coarsest LOD. */
  _buildSuperChunks() {
    const per = 4;
    const superSize = this.chunkSize * per;
    const n = this.count / per;
    this.supers = [];
    for (let sz = 0; sz < n; sz++) for (let sx = 0; sx < n; sx++) {
      const x0 = -this.hm.half + sx * superSize, z0 = -this.hm.half + sz * superSize;
      const children = [];
      for (let j = 0; j < per; j++) for (let i = 0; i < per; i++) children.push(this.chunks[(sz * per + j) * this.count + sx * per + i]);
      let mn = Infinity, mx = -Infinity;
      for (const c of children) { mn = Math.min(mn, c.minH); mx = Math.max(mx, c.maxH); }
      const sup = { x0, z0, children, geo: null, mesh: null, minH: mn, maxH: mx };
      sup.geo = buildChunkGeometry(this.hm, x0, z0, superSize, LOD_SEGMENTS[3] * per, 15 + (mx - mn) * 0.12);
      const mesh = new THREE.Mesh(sup.geo, this.material);
      mesh.name = `terrain-super-${sx}-${sz}`;
      mesh.castShadow = this.castShadow && (mx - mn) > 4;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.layers.enable(3);
      mesh.visible = false;
      sup.mesh = mesh;
      for (const c of children) c.superChunk = sup;
      this.group.add(mesh);
      this.supers.push(sup);
    }
  }

  _buildChunks() {
    const { count, chunkSize, hm } = this;
    for (let cz = 0; cz < count; cz++) {
      for (let cx = 0; cx < count; cx++) {
        const x0 = -hm.half + cx * chunkSize, z0 = -hm.half + cz * chunkSize;
        const chunk = { cx, cz, x0, z0, x1: x0 + chunkSize, z1: z0 + chunkSize, geos: [null, null, null, null], lod: -1, minH: 0, maxH: 0, mesh: null };
        this._measure(chunk);
        const mesh = new THREE.Mesh(this._geometry(chunk, 3), this.material);
        mesh.name = `terrain-chunk-${cx}-${cz}`;
        mesh.castShadow = this.castShadow && (chunk.maxH - chunk.minH) > 4; // flat chunks cast nothing visible
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        mesh.layers.enable(3); // reflected in water
        chunk.mesh = mesh;
        chunk.lod = 3;
        this.group.add(mesh);
        this.chunks.push(chunk);
      }
    }
  }

  _measure(chunk) {
    const { hm } = this;
    const i0 = Math.round((chunk.x0 + hm.half) / hm.spacing), i1 = Math.round((chunk.x1 + hm.half) / hm.spacing);
    const j0 = Math.round((chunk.z0 + hm.half) / hm.spacing), j1 = Math.round((chunk.z1 + hm.half) / hm.spacing);
    let mn = Infinity, mx = -Infinity;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const h = hm.data[j * hm.N + i]; if (h < mn) mn = h; if (h > mx) mx = h; }
    chunk.minH = mn; chunk.maxH = mx;
  }

  _geometry(chunk, lod) {
    if (chunk.geos[lod]) return chunk.geos[lod];
    const geo = buildChunkGeometry(this.hm, chunk.x0, chunk.z0, this.chunkSize, LOD_SEGMENTS[lod], 3 + lod * 4 + (chunk.maxH - chunk.minH) * 0.12);
    chunk.geos[lod] = geo;
    return geo;
  }

  /**
   * Pick LOD per chunk from the camera distance to the chunk's bounding box. LOD0 (2 m) is reserved
   * for chunks the camera is close to *and* roughly above/looking at; a chunk seen edge-on from far
   * above gets 4 m, which is indistinguishable and saves ~25 k triangles per chunk.
   */
  update(camera) {
    const cp = camera.position;
    const d = this.lodDistances;
    for (const c of this.chunks) {
      _box.min.set(c.x0, c.minH, c.z0); _box.max.set(c.x1, c.maxH, c.z1);
      const dist = _box.distanceToPoint(cp);
      let lod = dist < d[0] ? 0 : dist < d[1] ? 1 : dist < d[2] ? 2 : 3;
      if (lod === 0 && cp.y - c.maxH > d[0] * 0.9) lod = 1;
      if (lod !== c.lod) {
        c.lod = lod;
        c.mesh.geometry = this._geometry(c, lod);
      }
    }
    for (const s of this.supers) {
      let allFar = true;
      for (const c of s.children) if (c.lod !== 3) { allFar = false; break; }
      s.mesh.visible = allFar;
      for (const c of s.children) c.mesh.visible = !allFar;
    }
  }

  /** Rebuild chunks intersecting a world rect after the heightmap changed. */
  rebuildRegion(x0, z0, x1, z1) {
    const { chunkSize, hm, count } = this;
    const cx0 = Math.max(0, Math.floor((Math.min(x0, x1) + hm.half) / chunkSize)), cx1 = Math.min(count - 1, Math.floor((Math.max(x0, x1) + hm.half) / chunkSize));
    const cz0 = Math.max(0, Math.floor((Math.min(z0, z1) + hm.half) / chunkSize)), cz1 = Math.min(count - 1, Math.floor((Math.max(z0, z1) + hm.half) / chunkSize));
    const dirtySupers = [];
    for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
      const c = this.chunks[cz * count + cx];
      for (const g of c.geos) if (g) g.dispose();
      c.geos = [null, null, null, null];
      this._measure(c);
      c.mesh.castShadow = this.castShadow && (c.maxH - c.minH) > 4;
      c.mesh.geometry = this._geometry(c, c.lod);
      if (c.superChunk && !c.superChunk._dirty) { c.superChunk._dirty = true; dirtySupers.push(c.superChunk); }
    }
    for (const s of dirtySupers) {
      s._dirty = false;
      let mn = Infinity, mx = -Infinity;
      for (const c of s.children) { mn = Math.min(mn, c.minH); mx = Math.max(mx, c.maxH); }
      s.minH = mn; s.maxH = mx;
      s.geo.dispose();
      s.geo = buildChunkGeometry(this.hm, s.x0, s.z0, this.chunkSize * 4, LOD_SEGMENTS[3] * 4, 15 + (mx - mn) * 0.12);
      s.mesh.geometry = s.geo;
    }
  }

  /** Two rings of tiles outside the map, built from the coarse grids; each tile is its own (culled) mesh. */
  _buildHorizon() {
    const { hm } = this;
    const H = hm.half;
    const addRing = (grid, inner, outer, tile, segs, skirt, lodTag) => {
      const n = Math.round(outer * 2 / tile);
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const x0 = -outer + i * tile, z0 = -outer + j * tile;
        if (x0 >= -inner && x0 < inner && z0 >= -inner && z0 < inner) continue; // covered by the inner ring / map
        const geo = buildGridGeometry(grid, x0, z0, tile, segs, skirt, this.controlAt);
        const mesh = new THREE.Mesh(geo, this.horizonMaterial);
        mesh.name = `terrain-horizon-${lodTag}-${i}-${j}`;
        mesh.castShadow = lodTag === 'near' && (geo.boundingBox.max.y - geo.boundingBox.min.y) > 30;
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        mesh.frustumCulled = true;
        // NOT layer 3: the horizon ring starts at the map edge and runs out to 4x half, so its
        // reflection lands on the far water where the environment's haze has already taken it.
        // It is the in-map terrain, trees and buildings on the near bank that read in the water.
        this.group.add(mesh);
        this.horizonTiles.push(mesh);
      }
    };
    addRing(hm.outer, H, H * 2, 512, 64, 40, 'near');
    addRing(hm.far, H * 2, H * 4, 2048, 64, 90, 'far');
  }

  dispose() {
    for (const c of this.chunks) for (const g of c.geos) if (g) g.dispose();
    for (const s of this.supers) s.geo.dispose();
    for (const m of this.horizonTiles) m.geometry.dispose();
  }
}

/** Grid geometry for one chunk at a given segment count, heights read straight from the heightmap grid. */
export function buildChunkGeometry(hm, x0, z0, size, segs, skirtDepth) {
  const n = segs + 1;
  const step = size / segs;
  const stride = Math.round(step / hm.spacing);
  const i0 = Math.round((x0 + hm.half) / hm.spacing), j0 = Math.round((z0 + hm.half) / hm.spacing);
  const N = hm.N, data = hm.data;
  const vertCount = n * n + 4 * n;
  const pos = new Float32Array(vertCount * 3);
  const nor = new Float32Array(vertCount * 3);
  const idx = new Uint32Array(segs * segs * 6 + 4 * segs * 6);
  const hAt = (i, j) => data[Math.min(N - 1, Math.max(0, j)) * N + Math.min(N - 1, Math.max(0, i))];
  let p = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const gi = i0 + i * stride, gj = j0 + j * stride;
      const x = x0 + i * step, z = z0 + j * step;
      pos[p] = x; pos[p + 1] = data[gj * N + gi]; pos[p + 2] = z;
      // normal from the fine grid (central differences at the heightmap resolution)
      const dx = hAt(gi + 1, gj) - hAt(gi - 1, gj), dz = hAt(gi, gj + 1) - hAt(gi, gj - 1);
      let nx = -dx / (2 * hm.spacing), ny = 1, nz = -dz / (2 * hm.spacing);
      const l = Math.hypot(nx, ny, nz);
      nor[p] = nx / l; nor[p + 1] = ny / l; nor[p + 2] = nz / l;
      p += 3;
    }
  }
  const q = writeIndices(idx, n, segs);
  writeSkirts(pos, nor, idx, n, segs, skirtDepth, q, null);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Geometry for a horizon tile sampled from a coarse grid (bilinear), with an `aCtrl` attribute
 * = (dry, dirt, forest, rockBoost) from the shared ground rules.
 */
export function buildGridGeometry(grid, x0, z0, size, segs, skirtDepth, controlAt) {
  const n = segs + 1, step = size / segs;
  const vertCount = n * n + 4 * n;
  const pos = new Float32Array(vertCount * 3), nor = new Float32Array(vertCount * 3), ctrl = new Float32Array(vertCount * 4);
  const idx = new Uint32Array(segs * segs * 6 + 4 * segs * 6);
  const heights = new Float32Array((n + 2) * (n + 2));
  for (let j = -1; j <= n; j++) for (let i = -1; i <= n; i++) heights[(j + 1) * (n + 2) + i + 1] = grid.getHeight(x0 + i * step, z0 + j * step);
  const hAt = (i, j) => heights[(j + 1) * (n + 2) + i + 1];
  let p = 0;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = x0 + i * step, z = z0 + j * step, h = hAt(i, j);
    pos[p] = x; pos[p + 1] = h; pos[p + 2] = z;
    const dhx = (hAt(i + 1, j) - hAt(i - 1, j)) / (2 * step), dhz = (hAt(i, j + 1) - hAt(i, j - 1)) / (2 * step);
    let nx = -dhx, ny = 1, nz = -dhz;
    const l = Math.hypot(nx, ny, nz);
    nor[p] = nx / l; nor[p + 1] = ny / l; nor[p + 2] = nz / l;
    if (controlAt) {
      const slope = 1 - 1 / Math.sqrt(1 + dhx * dhx + dhz * dhz);
      const c = controlAt(x, z, h, slope);
      const v = p / 3 * 4;
      ctrl[v] = c.dry; ctrl[v + 1] = c.dirt; ctrl[v + 2] = c.forest; ctrl[v + 3] = c.rock;
    }
    p += 3;
  }
  const q = writeIndices(idx, n, segs);
  writeSkirts(pos, nor, idx, n, segs, skirtDepth, q, ctrl);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('aCtrl', new THREE.BufferAttribute(ctrl, 4));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

function writeIndices(idx, n, segs) {
  let q = 0;
  for (let j = 0; j < segs; j++) for (let i = 0; i < segs; i++) {
    const a = j * n + i, b = (j + 1) * n + i, c = (j + 1) * n + i + 1, d = j * n + i + 1;
    idx[q++] = a; idx[q++] = b; idx[q++] = d; idx[q++] = b; idx[q++] = c; idx[q++] = d;
  }
  return q;
}

/** Skirts: 4 borders, each n vertices dropped by skirtDepth (copies normal + control of the rim vertex). */
function writeSkirts(pos, nor, idx, n, segs, skirtDepth, q, ctrl) {
  let sv = n * n;
  const border = (side, k) => side === 0 ? k : side === 1 ? (n - 1) * n + k : side === 2 ? k * n : k * n + (n - 1);
  for (let side = 0; side < 4; side++) {
    for (let k = 0; k < n; k++) {
      const src = border(side, k), dst = sv + k;
      pos[dst * 3] = pos[src * 3]; pos[dst * 3 + 1] = pos[src * 3 + 1] - skirtDepth; pos[dst * 3 + 2] = pos[src * 3 + 2];
      nor[dst * 3] = nor[src * 3]; nor[dst * 3 + 1] = nor[src * 3 + 1]; nor[dst * 3 + 2] = nor[src * 3 + 2];
      if (ctrl) { ctrl[dst * 4] = ctrl[src * 4]; ctrl[dst * 4 + 1] = ctrl[src * 4 + 1]; ctrl[dst * 4 + 2] = ctrl[src * 4 + 2]; ctrl[dst * 4 + 3] = ctrl[src * 4 + 3]; }
    }
    for (let k = 0; k < segs; k++) {
      const a = border(side, k), b = border(side, k + 1), a2 = sv + k, b2 = sv + k + 1;
      const flip = side === 1 || side === 2;
      if (flip) { idx[q++] = a; idx[q++] = a2; idx[q++] = b; idx[q++] = a2; idx[q++] = b2; idx[q++] = b; }
      else { idx[q++] = a; idx[q++] = b; idx[q++] = a2; idx[q++] = b; idx[q++] = b2; idx[q++] = a2; }
    }
    sv += n;
  }
}
