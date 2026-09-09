/**
 * Turns the network into meshes. Geometry is cached per segment / per junction as raw typed arrays
 * and batched per 256 m tile and material, so a change only re-tessellates the touched segments and
 * re-merges the tiles they live in. Median trees, guard-rail posts and street lamps are InstancedMeshes.
 */
import * as THREE from 'three';
import { mergeRaw } from './GeomBuilder.js';
import { buildSegmentPieces, buildJunctionPieces, layoutFor } from './RoadMesher.js';

/**
 * Batching tile, metres. Geometry is grouped per tile AND per material, so the tile size trades two
 * budgeted quantities against each other: bigger tiles mean fewer meshes (fewer DRAW CALLS, since
 * mesh count is tiles x materials) but coarser frustum culling, because a tile that is one-tenth
 * visible still submits all of its geometry (more TRIANGLES).
 *
 * ARCHITECTURE.md §3 budgets both, accumulated over every pass of a frame: <= 2500 draw calls and
 * <= 8 M triangles. Draw calls are the one with room; triangles are the one that binds. Measured on
 * the demo city at 1080p, quality high, mean of 32 frames, at the two densest camera presets:
 *
 *                civic                      junction
 *              calls    triangles         calls    triangles
 *   TILE 128    1703      8.49 M           1845      7.77 M
 *   TILE 256    1537      8.63 M           1545      7.84 M
 *   TILE 512    1465      8.90 M           1433      7.95 M
 *
 * So 256 stays. A previous revision of this file raised it to 512 to buy draw calls, which was the
 * wrong direction: it spent the binding budget to relieve the one with ~1000 calls of headroom.
 * 128 is better still on triangles, but only by 0.14 M, for 166 more draw calls and 580 road meshes
 * against 239 — not worth the mesh count for a change that does not reach the budget either way.
 *
 * Road-build cost does not measurably regress with tile size — medians 597 / 656 / 566 ms at
 * 256 / 512 / 1024, differences inside the run-to-run spread, because an edit is dominated by
 * terrain conforming rather than re-batching.
 */
const TILE = 256;
/**
 * Which road materials are submitted to the shadow cascades. `curb` is deliberately NOT here.
 *
 * A kerb is a ~12 cm upstand, and casting it costs 0.194 M of the accumulated triangle budget at
 * `civic` — every kerb tile is re-submitted once per cascade — for a hairline band that is already
 * drawn twice over by cheaper means: `sweepEdge` bakes the kerb's own contact shadow into the
 * roadside grit (see RoadMesher), and the GTAO pre-pass darkens the kerb/carriageway junction. Cut
 * it and the kerb still reads as a raised edge; keep it and `civic` sits over §3's 8 M ceiling.
 *
 * Measured at 1920x1080, quality=high, seed 1337, mean over 80 frames — the three road casters that
 * actually matter are NOT the kerb, so they stay:
 *     street trees   0.560 M    dappled shade, the most valuable shadow in the scene
 *     street lamps   0.278 M    long, legible mast shadows at low sun
 *     curb           0.194 M    REMOVED — a hairline, already baked
 *     barrier / barrier_base / guardrail / granite   ~0.00 M each
 */
const CAST_SHADOW = new Set(['barrier', 'barrier_base', 'guardrail', 'granite']);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _v = new THREE.Vector3();
const _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

export class RoadRenderer {
  constructor(ctx, network, materials) {
    this.ctx = ctx;
    this.engine = ctx.engine;
    this.world = ctx.world;
    this.network = network;
    this.materials = materials;
    this.quality = ctx.engine.quality.density;
    this.group = new THREE.Group();
    this.group.name = 'roads';
    ctx.scene.add(this.group);
    this.pieces = new Map(); // key → { tile, byMat, trees, posts, lamps }
    this.tiles = new Map(); // tileKey → { members:Set<key>, meshes:Map<mat,Mesh>, group }
    this.trees = null;
    this.posts = null;
    this.lamps = null;
    this.masts = null;
    this.streetLights = true;
    this._instancesDirty = false;
    this.stats = { tiles: 0, meshes: 0, trees: 0, posts: 0, lamps: 0, lastFlushMs: 0 };
  }

  get dirty() {
    const n = this.network;
    return n.dirtySegments.size > 0 || n.dirtyNodes.size > 0 || n.removedSegments.size > 0 || n.removedNodes.size > 0;
  }

  /** Street lamps can be switched off (e.g. when a props module supplies its own street furniture). */
  setStreetLights(on) {
    if (this.streetLights === !!on) return;
    this.streetLights = !!on;
    this._instancesDirty = true;
    this._rebuildInstances();
  }

  flush() {
    if (!this.dirty) return;
    const t0 = performance.now();
    const net = this.network;
    const affected = new Set();
    for (const id of net.removedSegments) this._drop('s:' + id, affected);
    for (const id of net.removedNodes) this._drop('n:' + id, affected);
    for (const id of net.dirtySegments) {
      const seg = net.segments.get(id);
      if (!seg) { this._drop('s:' + id, affected); continue; }
      this._set('s:' + id, buildSegmentPieces(seg, net, this.world, this.quality), affected);
    }
    for (const id of net.dirtyNodes) {
      const node = net.nodes.get(id);
      if (!node) { this._drop('n:' + id, affected); continue; }
      this._set('n:' + id, buildJunctionPieces(node, net, this.world), affected);
    }
    net.clearDirty();
    for (const tk of affected) this._rebuildTile(tk);
    if (this._instancesDirty) this._rebuildInstances();
    this.stats.tiles = this.tiles.size;
    let meshes = 0;
    for (const t of this.tiles.values()) meshes += t.meshes.size;
    this.stats.meshes = meshes;
    this.stats.lastFlushMs = +(performance.now() - t0).toFixed(1);
  }

  _tileKey(bbox) {
    const cx = (bbox.minX + bbox.maxX) / 2, cz = (bbox.minZ + bbox.maxZ) / 2;
    return Math.floor(cx / TILE) + ',' + Math.floor(cz / TILE);
  }

  _hasInstances(p) { return p.trees.length > 0 || p.posts.length > 0 || (p.lamps && p.lamps.length > 0); }

  _drop(key, affected) {
    const p = this.pieces.get(key);
    if (!p) return;
    this.pieces.delete(key);
    const tile = this.tiles.get(p.tile);
    if (tile) { tile.members.delete(key); affected.add(p.tile); }
    if (this._hasInstances(p)) this._instancesDirty = true;
  }

  _set(key, piece, affected) {
    this._drop(key, affected);
    if (!piece) return;
    const tk = piece.bbox ? this._tileKey(piece.bbox) : '0,0';
    let tile = this.tiles.get(tk);
    if (!tile) {
      tile = { members: new Set(), meshes: new Map(), group: new THREE.Group() };
      tile.group.name = 'roads-tile-' + tk;
      tile.group.matrixAutoUpdate = false;
      this.group.add(tile.group);
      this.tiles.set(tk, tile);
    }
    tile.members.add(key);
    const rec = { tile: tk, byMat: piece.byMat, trees: piece.trees, posts: piece.posts, lamps: piece.lamps || [] };
    this.pieces.set(key, rec);
    affected.add(tk);
    if (this._hasInstances(rec)) this._instancesDirty = true;
  }

  _rebuildTile(tk) {
    const tile = this.tiles.get(tk);
    if (!tile) return;
    const byMat = new Map();
    for (const key of tile.members) {
      const p = this.pieces.get(key);
      if (!p) continue;
      for (const [mat, raw] of p.byMat) {
        if (!byMat.has(mat)) byMat.set(mat, []);
        byMat.get(mat).push(raw);
      }
    }
    for (const [mat, mesh] of tile.meshes) {
      if (!byMat.has(mat)) { tile.group.remove(mesh); mesh.geometry.dispose(); tile.meshes.delete(mat); }
    }
    for (const [mat, raws] of byMat) {
      const geo = mergeRaw(raws, layoutFor(mat));
      if (!geo) continue;
      let mesh = tile.meshes.get(mat);
      if (!mesh) {
        mesh = new THREE.Mesh(geo, this.materials.get(mat));
        mesh.name = 'roads/' + mat;
        mesh.receiveShadow = true;
        mesh.castShadow = CAST_SHADOW.has(mat);
        mesh.matrixAutoUpdate = false;
        // the fading skirt is kept out of the GTAO pre-pass (it would leave an AO halo along the
        // fade) — the main camera renders that layer too
        if (mat === 'skirt') mesh.layers.set(this.engine.LAYER_NO_AO);
        /**
         * Road SURFACES stay out of the planar water reflection. A carriageway is flat and sits at
         * or just above the waterline, so it presents itself to the mirrored camera almost edge-on
         * and contributes a sliver of dark asphalt to a half-resolution, normal-distorted target.
         * It cost 40 of the frame's draw calls — the single largest contributor to that pass —
         * for something you cannot pick out of the water.
         *
         * The vertical roadside furniture (lamps, posts, masts, street trees) DOES reflect and
         * keeps its layer below: those are the shapes that actually read on the water.
         */
        tile.group.add(mesh);
        tile.meshes.set(mat, mesh);
      } else {
        mesh.geometry.dispose();
        mesh.geometry = geo;
      }
    }
    if (tile.members.size === 0) {
      this.group.remove(tile.group);
      this.tiles.delete(tk);
    }
  }

  _rebuildInstances() {
    this._instancesDirty = false;
    const trees = [], posts = [], lamps = [], masts = [];
    for (const p of this.pieces.values()) {
      trees.push(...p.trees); posts.push(...p.posts);
      if (this.streetLights) for (const l of p.lamps) (l.kind === 'mast' ? masts : lamps).push(l);
    }
    const M = this.materials;
    this.trees = this._syncInstanced(this.trees, M.treeGeometry, [M.bark, M.leaves], trees, 'roads/trees', (t, i, mesh) => {
      _q.setFromAxisAngle(UP, t.yaw);
      _s.set(t.scale, t.scale * (0.92 + ((i * 7) % 5) * 0.03), t.scale);
      _m.compose(_v.set(t.x, t.y, t.z), _q, _s);
      mesh.setMatrixAt(i, _m);
      mesh.setColorAt(i, _c.setRGB(t.tint * 0.96, t.tint, t.tint * 0.86));
    });
    this.posts = this._syncInstanced(this.posts, M.postGeometry, M.get('post'), posts, 'roads/posts', (p, i, mesh) => {
      _q.setFromAxisAngle(UP, p.yaw);
      // `h` shrinks the post through a guard-rail end terminal so it follows the beam into the verge
      _m.compose(_v.set(p.x, p.y, p.z), _q, _s.set(1, p.h == null ? 1 : p.h, 1));
      mesh.setMatrixAt(i, _m);
    });
    // per-luminaire output / colour-temperature jitter (deterministic from the pole position) so a night
    // street is not a perfect grid of identical bloom dots; the glow material multiplies emissive by this
    const placeLamp = (l, i, mesh) => {
      _q.setFromAxisAngle(UP, l.yaw);
      _m.compose(_v.set(l.x, l.y, l.z), _q, _s.set(1, 1, 1));
      mesh.setMatrixAt(i, _m);
      const h = Math.abs(Math.sin(l.x * 12.9898 + l.z * 78.233) * 43758.5453) % 1;
      const h2 = Math.abs(Math.sin(l.x * 39.3468 + l.z * 11.135) * 24634.6345) % 1;
      const g = 0.80 + 0.40 * h;
      mesh.setColorAt(i, _c.setRGB(g * (1 + 0.05 * h2), g, g * (1 - 0.10 * h2)));
    };
    this.lamps = this._syncInstanced(this.lamps, M.lampGeometry.street, [M.lampMetal, M.lampGlow], lamps, 'roads/lamps', placeLamp);
    this.masts = this._syncInstanced(this.masts, M.lampGeometry.mast, [M.lampMetal, M.mastGlow], masts, 'roads/masts', placeLamp);
    this.stats.trees = trees.length;
    this.stats.posts = posts.length;
    this.stats.lamps = lamps.length + masts.length;
  }

  _syncInstanced(mesh, geometry, material, items, name, fill) {
    if (!items.length) {
      if (mesh) { this.group.remove(mesh); mesh.dispose(); }
      return null;
    }
    if (!mesh || mesh.instanceMatrix.count < items.length) {
      if (mesh) { this.group.remove(mesh); mesh.dispose(); }
      const cap = Math.ceil(items.length * 1.25) + 16;
      mesh = new THREE.InstancedMesh(geometry, material, cap);
      mesh.name = name;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.layers.enable(this.engine.LAYER_REFLECTED);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(mesh);
    }
    mesh.count = items.length;
    for (let i = 0; i < items.length; i++) fill(items[i], i, mesh);
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    return mesh;
  }

  dispose() {
    for (const tile of this.tiles.values()) for (const mesh of tile.meshes.values()) mesh.geometry.dispose();
    for (const m of [this.trees, this.posts, this.lamps, this.masts]) if (m) m.dispose();
    this.ctx.scene.remove(this.group);
    this.tiles.clear();
    this.pieces.clear();
  }
}
