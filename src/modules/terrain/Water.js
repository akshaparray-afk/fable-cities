/**
 * Water surface: one merged mesh covering every chunk that dips below the water level (plus the
 * horizon ring out to 4×half).
 *
 * It is a real **MeshPhysicalMaterial at roughness 0.04 / ior 1.333 (F0 = 0.020)**, not a hand-rolled
 * ShaderMaterial. That is the whole point: at roughness 0.04 the PMREM sky probe is a *sharp* mirror,
 * so the surface is sky-reflection dominated and the diffuse body (a dark teal → navy absorption
 * ramp) only fills in what the reflection does not. Everything bright on the water is reflected sky.
 *   - depth-based colour & transparency; terrain height comes from three half-float height textures
 *     (2 m in-map, 8 m outer ring, 32 m far ring) so the depth colour is seamless across the map edge
 *   - five ripple-normal octaves (150 m swell → 2.4 m chop); the 23/61 m layers never fade out, so
 *     there is normal detail at every distance instead of a flat wash on the far water
 *   - planar reflection render target (quality.reflections) keyed by RT alpha overrides the sky probe
 *     where it caught something, so dark trees/buildings on the bank really show in the water
 *   - a sharp-normal GGX glitter lobe on top of three's own direct specular (sun + moon paths)
 *   - narrow (<= 1.6 m) noise-broken foam lace and a dithered shoreline dissolve — no hard seam
 */
import * as THREE from 'three';

const _reflectorPlane = new THREE.Plane();
const _reflFrustum = new THREE.Frustum();
const _reflViewProj = new THREE.Matrix4();
const _reflBox = new THREE.Box3();
const _normal = new THREE.Vector3();
const _reflectorWorldPosition = new THREE.Vector3();
const _cameraWorldPosition = new THREE.Vector3();
const _rotationMatrix = new THREE.Matrix4();
const _lookAtPosition = new THREE.Vector3(0, 0, -1);
const _clipPlane = new THREE.Vector4();
const _view = new THREE.Vector3();
const _target = new THREE.Vector3();
const _q = new THREE.Vector4();
const _sizeVec = new THREE.Vector2();
const _poseDir = new THREE.Vector3();
const _posePos = new THREE.Vector3();
const _clearColor = new THREE.Color();

function heightTexture(grid) {
  const N = grid.N;
  const data = new Uint16Array(N * N);
  const tex = new THREE.DataTexture(data, N, N, THREE.RedFormat, THREE.HalfFloatType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.internalFormat = 'R16F';
  const update = () => {
    const src = grid.data;
    for (let i = 0; i < src.length; i++) data[i] = THREE.DataUtils.toHalfFloat(src[i]);
    tex.needsUpdate = true;
  };
  update();
  return { tex, update, N };
}

export class Water {
  constructor({ heightmap, noiseTex, normalTex, shoreTex = null, chunkSize = 128, reflections = true, reflectionScale = 0.5, renderer, engine = null, noAoLayer = null }) {
    this.hm = heightmap;
    this.waterLevel = heightmap.waterLevel;
    this.reflectionsEnabled = reflections;
    this.renderer = renderer;
    this.engine = engine;

    // --- heightmaps as half-float textures (per-pixel depth, seamless across the map edge) ---
    this.heightFine = heightTexture(heightmap);
    this.heightOuter = heightmap.outer ? heightTexture(heightmap.outer) : this.heightFine;
    this.heightFar = heightmap.far ? heightTexture(heightmap.far) : this.heightOuter;

    // --- reflection target ---
    const size = new THREE.Vector2();
    renderer.getDrawingBufferSize(size);
    this.reflectionScale = reflectionScale;
    /**
     * The reflection is a second full submission of everything on layer 3 — measured at ~404 of
     * the frame's ~2100 draw calls and 1.43 M triangles, about a fifth of the frame, and it ran
     * unconditionally. Two gates cut that without touching another module:
     *   reflectionInterval — re-render the target every Nth frame and reuse it in between. The
     *     whole function is skipped on a reuse frame so the target and its textureMatrix stay
     *     consistent; the reflection is then one frame stale, which is invisible on a half-res,
     *     normal-distorted surface but would swim if the matrix advanced without the content.
     *   visibility — if no water quad is inside the main camera frustum, nothing samples the
     *     target at all, so the pass is pure waste. This one is exact, not an approximation.
     */
    this.reflectionInterval = 2;
    this._reflectionFrame = 0;
    /**
     * A third gate: hold the last target while the camera is still.
     *
     * Everything on layer 3 is static architecture — terrain, roads, buildings, zone ground,
     * trees. Traffic is not on it. So when the main camera has not moved, the pass re-renders a
     * picture of the same geometry from the same place and produces an almost identical target.
     * The exception is tree wind sway, which is why the hold is capped rather than indefinite:
     * at the cap the reflected canopy still updates several times a second, seen at half
     * resolution through the surface's own animated ripple normals.
     *
     * The cap is also what bounds the one staleness case there is no event for — a building
     * finishing while the camera sits still. There is no `buildings:changed` on the bus (only
     * roads/zones/terrain/services), so growth is covered by the cap alone: at the frame rates
     * this runs at, 8 frames is well under half a second.
     */
    this.maxFreeze = 8;
    this._freezeFrames = 0;
    this._reflectDirty = true;
    this._lastPosePos = new THREE.Vector3(Infinity, Infinity, Infinity);
    this._lastPoseDir = new THREE.Vector3();
    this.reflectionRT = new THREE.WebGLRenderTarget(Math.max(256, Math.floor(size.x * reflectionScale)), Math.max(256, Math.floor(size.y * reflectionScale)), {
      type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false, samples: 0,
    });
    this.reflectionRT.texture.minFilter = THREE.LinearFilter;
    this.reflectionRT.texture.magFilter = THREE.LinearFilter;
    this.reflectionRT.texture.generateMipmaps = false;
    this.virtualCamera = new THREE.PerspectiveCamera();
    this.virtualCamera.layers.set(3); // only objects flagged as reflectable
    this.textureMatrix = new THREE.Matrix4();
    this.hasReflection = false;

    // --- material ---
    // NOTE: a plain object, never UniformsUtils.merge — these are Object.assign'd into the standard
    // material's uniform set, and merging three's own fog/light uniforms in would replace the live
    // ones the renderer updates with dead clones.
    const uniforms = {
      uTime: { value: 0 },
      uHeightTex: { value: null }, uHeightN: { value: this.heightFine.N },
      uHeightOuter: { value: null }, uOuterN: { value: this.heightOuter.N }, uOuterHalf: { value: heightmap.outer ? heightmap.outer.half : heightmap.half }, uOuterSpacing: { value: heightmap.outer ? heightmap.outer.spacing : heightmap.spacing },
      uHeightFar: { value: null }, uFarN: { value: this.heightFar.N }, uFarHalf: { value: heightmap.far ? heightmap.far.half : heightmap.half }, uFarSpacing: { value: heightmap.far ? heightmap.far.spacing : heightmap.spacing },
      uHalf: { value: heightmap.half },
      uSpacing: { value: heightmap.spacing },
      uWaterLevel: { value: this.waterLevel },
      uNormalTex: { value: null },
      uNoise: { value: null },
      uShore: { value: null }, uShoreN: { value: heightmap.N },
      uSunDir: { value: new THREE.Vector3(0.35, 0.8, -0.45) },
      uSunColor: { value: new THREE.Color(1, 0.96, 0.9) },
      uSunIntensity: { value: 3 },
      uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
      uMoonColor: { value: new THREE.Color(0.6, 0.7, 0.9) },
      uMoonIntensity: { value: 0 },
      uSkyColor: { value: new THREE.Color(0.55, 0.7, 1.0) },
      uHorizonColor: { value: new THREE.Color(0.75, 0.82, 0.92) },
      uAmbient: { value: 0.6 },
      // multipliers on material.color (0x13282f): shallow = dark teal, deep = navy
      uShallowColor: { value: new THREE.Color(1.90, 1.45, 1.05) },
      uDeepColor: { value: new THREE.Color(0.42, 0.62, 0.98) },
      uReflection: { value: null },
      uReflectionMatrix: { value: this.textureMatrix },
      uReflectionStrength: { value: 0 },
      uNightFactor: { value: 0 },
      uWind: { value: new THREE.Vector2(0.7, 0.3) },
      // absolute sky-bounce floor so open water is never a literal black hole after dark
      uSkyFloor: { value: new THREE.Color(0.030, 0.040, 0.062) },
      uRain: { value: 0 },
      // after dark the PMREM sky probe collapses to almost nothing; CS2's night waterfront has the
      // water as the BRIGHTEST large feature in the frame, so put the sky sheen back explicitly
      uNightSheen: { value: new THREE.Color(0, 0, 0) },
    };
    uniforms.uHeightTex.value = this.heightFine.tex;
    uniforms.uHeightOuter.value = this.heightOuter.tex;
    uniforms.uHeightFar.value = this.heightFar.tex;
    uniforms.uNormalTex.value = normalTex;
    uniforms.uNoise.value = noiseTex;
    uniforms.uShore.value = shoreTex;
    uniforms.uReflection.value = this.reflectionRT.texture;
    uniforms.uReflectionMatrix.value = this.textureMatrix;
    this.uniforms = uniforms;

    // --- the surface is a real PBR dielectric ------------------------------------------------------
    // Water is the one surface in the frame that is almost a mirror: roughness 0.04 and an IOR of
    // 1.333 (F0 = 0.020). Running it through MeshPhysicalMaterial rather than a hand-rolled
    // ShaderMaterial is what finally lets the PMREM sky probe reach it — the body colour is a dark
    // teal→navy diffuse term and everything bright on the surface is *reflected sky*, not paint.
    const mat = new THREE.MeshPhysicalMaterial({
      name: 'water',
      color: new THREE.Color(0x13282f),   // dark teal-navy body
      roughness: 0.04,
      metalness: 0.0,
      ior: 1.333,
      envMapIntensity: 2.0,               // re-normalised against scene.environmentIntensity in update()
      transparent: true,
      depthWrite: false,
      fog: true,
      side: THREE.FrontSide,
    });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
uniform mat4 uReflectionMatrix;
varying vec3 vWorld;
varying vec4 vReflUv;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  vec4 wp = modelMatrix * vec4(transformed, 1.0);
  vWorld = wp.xyz;
  vReflUv = uReflectionMatrix * wp;
}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + WATER_PARS)
        .replace('#include <map_fragment>', WATER_BODY)
        .replace('#include <roughnessmap_fragment>',
          'float roughnessFactor = roughness + 0.085 * smoothstep(160.0, 1700.0, gWDist) + gWFoam * 0.62 + uRain * 0.24;')
        .replace('#include <normal_fragment_begin>', `float faceDirection = 1.0;
vec3 normal = normalize((viewMatrix * vec4(gWN, 0.0)).xyz);
vec3 nonPerturbedNormal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);`)
        // the planar RT replaces the sky probe wherever it actually caught something (the far bank,
        // its trees, buildings); elsewhere the PMREM sky stands in. No brightness clamp: a dark bank
        // must reflect dark.
        .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
#ifdef USE_ENVMAP
if (uReflectionStrength > 0.0) {
  vec4 ruv = vReflUv;
  ruv.xy += vec2(gWN.x, gWN.z) * (0.030 + 0.070 * gWDetail) * ruv.w;
  vec2 pv = ruv.xy / max(ruv.w, 1e-4);
  // the distorted lookup can walk off the reflection target; fade back to the sky probe at its
  // border instead of smearing a clamped column of pixels down the edge of the frame
  vec2 fade = smoothstep(vec2(0.0), vec2(0.035), pv) * smoothstep(vec2(0.0), vec2(0.035), 1.0 - pv);
  float inside = fade.x * fade.y;
  vec4 planar = texture2DProj(uReflection, ruv);
  // a reflected black tree must still sit on a faintly lit surface, never on a hole
  radiance = mix(radiance, max(planar.rgb, radiance * 0.14), clamp(planar.a, 0.0, 1.0) * uReflectionStrength * inside);
}
#endif
// CS2's water measures OKLab chroma 0.028 — a desaturated slate, never a blue field. The reflected
// sky is pulled towards its own luminance; the sun glitter is added later so it stays white.
radiance = mix(radiance, vec3(dot(radiance, vec3(0.2126, 0.7152, 0.0722))), 0.46);`)
        .replace('#include <aomap_fragment>', `#include <aomap_fragment>
reflectedLight.directSpecular += gWGlitter;
reflectedLight.indirectDiffuse += diffuseColor.rgb * uSkyFloor;
// absolute floor: deep water at low fresnel has an almost black diffuse body, and a reflected dark
// bank is near zero too, so without this the near river measures as a hole in the frame
reflectedLight.indirectDiffuse = max(reflectedLight.indirectDiffuse, uSkyFloor * 1.35);
reflectedLight.indirectSpecular += uNightSheen * (0.16 + 0.84 * pow(1.0 - gWNdotV, 3.0));`);
    };
    mat.customProgramCacheKey = () => 'fable-water-pbr-v9';
    this.material = mat;
    if (engine && engine.registerMaterial) engine.registerMaterial(mat);

    this.horizonExtent = heightmap.far ? heightmap.far.half : heightmap.half * 3;
    this.mesh = new THREE.Mesh(this._buildGeometry(chunkSize, this.horizonExtent), this.material);
    this.mesh.name = 'water';
    this.mesh.renderOrder = 10;
    this.mesh.frustumCulled = true;
    this.mesh.receiveShadow = false;
    this.mesh.castShadow = false;
    this.mesh.matrixAutoUpdate = false;
    // The GTAO pre-pass renders every mesh with an override normal material; the water plane has no
    // normal attribute and would feed garbage normals into the AO (dark speckle over the whole river,
    // black trees in front of water). Keeping it on LAYER_NO_AO lets the AO come from the river bed.
    if (noAoLayer != null) this.mesh.layers.set(noAoLayer); else this.mesh.layers.set(0);
    this.chunkSize = chunkSize;
  }

  /** Re-upload the in-map height texture after terrain edits. */
  updateHeightTexture() { this.heightFine.update(); }

  /** Rebuild the water geometry (after terrain edits that might have exposed/covered water). */
  rebuildGeometry() {
    this.mesh.geometry.dispose();
    this.mesh.geometry = this._buildGeometry(this.chunkSize, this.horizonExtent);
  }

  _buildGeometry(chunkSize, extent) {
    const hm = this.hm;
    const count = Math.round(hm.size / chunkSize);
    const quads = [];
    const wl = this.waterLevel;
    for (let cz = 0; cz < count; cz++) for (let cx = 0; cx < count; cx++) {
      const x0 = -hm.half + cx * chunkSize, z0 = -hm.half + cz * chunkSize;
      const i0 = Math.round((x0 + hm.half) / hm.spacing), j0 = Math.round((z0 + hm.half) / hm.spacing);
      const n = Math.round(chunkSize / hm.spacing);
      let mn = Infinity;
      for (let j = j0; j <= j0 + n; j++) for (let i = i0; i <= i0 + n; i++) { const h = hm.data[j * hm.N + i]; if (h < mn) mn = h; }
      if (mn < wl + 0.8) quads.push([x0, z0, x0 + chunkSize, z0 + chunkSize]);
    }
    // horizon ring: 4 big quads around the map
    const H = hm.half, E = extent;
    quads.push([-E, -E, E, -H], [-E, H, E, E], [-E, -H, -H, H], [H, -H, E, H]);
    this.waterQuads = quads;
    const pos = new Float32Array(quads.length * 4 * 3);
    const idx = new Uint32Array(quads.length * 6);
    quads.forEach(([x0, z0, x1, z1], k) => {
      const b = k * 12;
      pos.set([x0, wl, z0, x1, wl, z0, x1, wl, z1, x0, wl, z1], b);
      const v = k * 4;
      idx.set([v, v + 2, v + 1, v, v + 3, v + 2], k * 6);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    // MeshPhysicalMaterial needs a real normal attribute (the shading normal is replaced per-pixel,
    // but `nonPerturbedNormal` / geometryRoughness are derived from this one and NaNs would spread)
    const nrm = new Float32Array(pos.length);
    for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return geo;
  }

  /** Per-frame uniform update. `env` = world.env; `engine` for the live light rig fallback. */
  update(dt, elapsed, engine, env) {
    const u = this.uniforms;
    u.uTime.value = elapsed;
    if (env && env.sunDirection) u.uSunDir.value.copy(env.sunDirection).negate().normalize();
    else { const ld = engine.csm.lightDirection; u.uSunDir.value.set(-ld.x, -ld.y, -ld.z).normalize(); }
    if (env && env.sunColor) u.uSunColor.value.copy(env.sunColor); else u.uSunColor.value.copy(engine.sunColor);
    u.uSunIntensity.value = env && env.sunIntensity != null ? env.sunIntensity : engine.sunIntensity;
    if (env && env.moonDirection) u.uMoonDir.value.copy(env.moonDirection).normalize();
    if (env && env.moonColor) u.uMoonColor.value.copy(env.moonColor);
    u.uMoonIntensity.value = env && env.moonIntensity != null ? env.moonIntensity : 0;
    if (env && env.skyColor) u.uSkyColor.value.copy(env.skyColor); else u.uSkyColor.value.copy(engine.hemi.color);
    u.uAmbient.value = env && env.ambientIntensity != null ? env.ambientIntensity : engine.hemi.intensity;
    if (env && env.horizonColor) u.uHorizonColor.value.copy(env.horizonColor);
    else u.uHorizonColor.value.copy(engine.scene.fog ? engine.scene.fog.color : engine.hemi.color);
    const night = env ? env.nightFactor : 0;
    u.uNightFactor.value = night;
    if (env && env.wind && env.wind.lengthSq() > 1e-6) u.uWind.value.copy(env.wind).normalize();
    // The sky probe is the water's main light source, so it must not be halved by whatever the
    // environment module currently sets scene.environmentIntensity to. Re-normalise every frame:
    // whatever that value is, the water sees an effective intensity of ~1.05.
    const scene = engine && engine.scene;
    const sceneEnv = scene && scene.environmentIntensity != null ? scene.environmentIntensity : 1;
    this.material.envMapIntensity = Math.min(2.6, Math.max(0.6, 1.05 / Math.max(sceneEnv, 0.18)));
    // sky-bounce floor: open water is never a black hole, but it must not glow after dark either
    const sky = u.uSkyColor.value, amb = u.uAmbient.value;
    u.uSkyFloor.value.setRGB(
      sky.r * amb * 0.055 + 0.0055 * night,
      sky.g * amb * 0.055 + 0.0068 * night,
      sky.b * amb * 0.055 + 0.0105 * night,
    );
    // pull it half-way to its own luminance: CS2's water is a desaturated slate (OKLab C 0.028), and
    // a fully sky-tinted floor is what turns the shadowed near water into a blue field
    {
      const f = u.uSkyFloor.value;
      const y = 0.2126 * f.r + 0.7152 * f.g + 0.0722 * f.b;
      f.setRGB(f.r * 0.45 + y * 0.55, f.g * 0.45 + y * 0.55, f.b * 0.45 + y * 0.55);
    }
    // night sky sheen, normalised to a fixed luminance so it does not depend on how the environment
    // module happens to scale its sky colour
    const gw = engine && engine.globalUniforms;
    u.uRain.value = gw && gw.uWetness ? Math.min(1, gw.uWetness.value) : 0;
    const lum = Math.max(1e-4, 0.2126 * sky.r + 0.7152 * sky.g + 0.0722 * sky.b);
    u.uNightSheen.value.copy(sky).multiplyScalar(night * night * 0.024 / lum);
  }

  /** Render the planar reflection into the render target. Call before the main render. */
  /**
   * True when any water quad intersects the main camera frustum. The quads are the same flat
   * [x0,z0,x1,z1] list the surface mesh is built from, so this is exact rather than an estimate;
   * the box gets a little vertical slack for waves and the shoreline band.
   * Returns true when the quad list is missing, so an unknown never culls a visible reflection.
   */
  _waterInView(camera) {
    const quads = this.waterQuads;
    if (!quads || !quads.length) return true;
    _reflViewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _reflFrustum.setFromProjectionMatrix(_reflViewProj);
    const y0 = this.waterLevel - 2, y1 = this.waterLevel + 6;
    for (let i = 0; i < quads.length; i++) {
      const q = quads[i];
      _reflBox.min.set(Math.min(q[0], q[2]), y0, Math.min(q[1], q[3]));
      _reflBox.max.set(Math.max(q[0], q[2]), y1, Math.max(q[1], q[3]));
      if (_reflFrustum.intersectsBox(_reflBox)) return true;
    }
    return false;
  }

  renderReflection(renderer, scene, camera) {
    if (!this.reflectionsEnabled) { this.uniforms.uReflectionStrength.value = 0; return; }

    // Nothing samples the target when no water is on screen, so the whole pass is waste.
    if (!this._waterInView(camera)) {
      this.uniforms.uReflectionStrength.value = 0;
      this._reflectionFrame = 0; // render on the first frame water comes back into view
      return;
    }
    // The resize is tested BEFORE either reuse gate: a canvas resize leaves the old target at the
    // wrong aspect, and a gate that skipped past this would keep showing it for as long as it held.
    const size = renderer.getDrawingBufferSize(_sizeVec);
    const w = Math.max(256, Math.floor(size.x * this.reflectionScale)), h = Math.max(256, Math.floor(size.y * this.reflectionScale));
    if (this.reflectionRT.width !== w || this.reflectionRT.height !== h) {
      this.reflectionRT.setSize(w, h);
      this._reflectDirty = true;
    }

    // Hold the last target while the camera is still (see `maxFreeze`). Deliberately does NOT
    // touch `_reflectionFrame`: the two gates counting the same frames would beat against each
    // other and could starve the pass entirely.
    if (this.uniforms.uReflectionStrength.value > 0 && !this._reflectDirty && this._freezeFrames < this.maxFreeze) {
      _posePos.setFromMatrixPosition(camera.matrixWorld);
      camera.getWorldDirection(_poseDir);
      // ~1 reflection texel of movement at this target size; below it nothing in the mirror moves
      if (_posePos.distanceToSquared(this._lastPosePos) < 0.02 && _poseDir.dot(this._lastPoseDir) > 1 - 1e-6) {
        this._freezeFrames++;
        return;
      }
    }
    this._freezeFrames = 0;
    this._reflectDirty = false;

    // Reuse the last target in between. Never reuse one that was never rendered (strength is only
    // raised at the end of a successful pass), or water would appear with no reflection for a frame.
    if (this.reflectionInterval > 1
      && this.uniforms.uReflectionStrength.value > 0
      && (this._reflectionFrame++ % this.reflectionInterval) !== 0) return;

    // mirror camera across the water plane (based on three's Reflector)
    _reflectorWorldPosition.set(0, this.waterLevel, 0);
    _cameraWorldPosition.setFromMatrixPosition(camera.matrixWorld);
    if (_cameraWorldPosition.y < this.waterLevel) { this.uniforms.uReflectionStrength.value = 0; return; }
    _rotationMatrix.identity();
    _normal.set(0, 1, 0);
    _view.subVectors(_reflectorWorldPosition, _cameraWorldPosition);
    _view.reflect(_normal).negate();
    _view.add(_reflectorWorldPosition);
    _rotationMatrix.extractRotation(camera.matrixWorld);
    _lookAtPosition.set(0, 0, -1);
    _lookAtPosition.applyMatrix4(_rotationMatrix);
    _lookAtPosition.add(_cameraWorldPosition);
    _target.subVectors(_reflectorWorldPosition, _lookAtPosition);
    _target.reflect(_normal).negate();
    _target.add(_reflectorWorldPosition);
    const vc = this.virtualCamera;
    vc.position.copy(_view);
    vc.up.set(0, 1, 0);
    vc.up.applyMatrix4(_rotationMatrix);
    vc.up.reflect(_normal);
    vc.lookAt(_target);
    vc.far = camera.far;
    vc.near = camera.near;
    vc.fov = camera.fov;
    vc.aspect = camera.aspect;
    vc.updateMatrixWorld();
    vc.projectionMatrix.copy(camera.projectionMatrix);
    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.textureMatrix.multiply(vc.projectionMatrix);
    this.textureMatrix.multiply(vc.matrixWorldInverse);
    // oblique near plane so nothing below the water is reflected
    _reflectorPlane.setFromNormalAndCoplanarPoint(_normal, _reflectorWorldPosition);
    _reflectorPlane.applyMatrix4(vc.matrixWorldInverse);
    _clipPlane.set(_reflectorPlane.normal.x, _reflectorPlane.normal.y, _reflectorPlane.normal.z, _reflectorPlane.constant);
    const pm = vc.projectionMatrix;
    _q.x = (Math.sign(_clipPlane.x) + pm.elements[8]) / pm.elements[0];
    _q.y = (Math.sign(_clipPlane.y) + pm.elements[9]) / pm.elements[5];
    _q.z = -1.0;
    _q.w = (1.0 + pm.elements[10]) / pm.elements[14];
    _clipPlane.multiplyScalar(2.0 / _clipPlane.dot(_q));
    pm.elements[2] = _clipPlane.x;
    pm.elements[6] = _clipPlane.y;
    pm.elements[10] = _clipPlane.z + 1.0 - 0.0005;
    pm.elements[14] = _clipPlane.w;

    // render (alpha 0 where nothing is reflected → shader falls back to the analytic sky there)
    const prevTarget = renderer.getRenderTarget();
    const prevXr = renderer.xr.enabled;
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    const prevAutoClear = renderer.autoClear;
    renderer.getClearColor(_clearColor);
    const prevAlpha = renderer.getClearAlpha();
    renderer.xr.enabled = false;
    renderer.shadowMap.autoUpdate = false; // reuse this frame's shadow maps
    this.mesh.visible = false;
    const prevBackground = scene.background;
    scene.background = null;               // a colour/sky background would fill the RT with alpha 1
    renderer.setRenderTarget(this.reflectionRT);
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = false;
    renderer.state.buffers.depth.setMask(true);
    renderer.clear(true, true, false);
    renderer.render(scene, vc);
    scene.background = prevBackground;
    this.mesh.visible = true;
    renderer.autoClear = prevAutoClear;
    renderer.setClearColor(_clearColor, prevAlpha);
    renderer.xr.enabled = prevXr;
    renderer.shadowMap.autoUpdate = prevShadowAuto;
    renderer.setRenderTarget(prevTarget);
    this.uniforms.uReflectionStrength.value = 1;
    // the pose this target was rendered from — the freeze gate above compares against it
    this._lastPosePos.setFromMatrixPosition(camera.matrixWorld);
    camera.getWorldDirection(this._lastPoseDir);
    this.hasReflection = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.heightFine.tex.dispose();
    if (this.heightOuter !== this.heightFine) this.heightOuter.tex.dispose();
    if (this.heightFar !== this.heightOuter) this.heightFar.tex.dispose();
    this.reflectionRT.dispose();
  }
}


// ------------------------------------------------------------------------------------------------
// Fragment injections for MeshPhysicalMaterial. The body colour, the animated ripple normal, the
// foam and the alpha are computed here; the *entire* specular response (sky probe, planar mirror,
// sun lobe) is then produced by three's own physical BRDF at roughness 0.04 / ior 1.333.
// ------------------------------------------------------------------------------------------------
const WATER_PARS = /* glsl */`
uniform float uTime;
uniform sampler2D uHeightTex; uniform float uHeightN;
uniform sampler2D uHeightOuter; uniform float uOuterN; uniform float uOuterHalf; uniform float uOuterSpacing;
uniform sampler2D uHeightFar; uniform float uFarN; uniform float uFarHalf; uniform float uFarSpacing;
uniform float uHalf;
uniform float uSpacing;
uniform float uWaterLevel;
uniform sampler2D uNormalTex;
uniform sampler2D uNoise;
uniform sampler2D uShore; uniform float uShoreN;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uMoonDir;
uniform vec3 uMoonColor;
uniform float uMoonIntensity;
uniform vec3 uSkyColor;
uniform vec3 uHorizonColor;
uniform float uAmbient;
uniform vec3 uShallowColor;
uniform vec3 uDeepColor;
uniform sampler2D uReflection;
uniform mat4 uReflectionMatrix;
uniform float uReflectionStrength;
uniform float uNightFactor;
uniform vec2 uWind;
uniform vec3 uSkyFloor;
uniform vec3 uNightSheen;
uniform float uRain;
varying vec3 vWorld;
varying vec4 vReflUv;

// globals filled by WATER_BODY and consumed by the roughness / normal / lighting injections
vec3  gWN      = vec3(0.0, 1.0, 0.0);
vec3  gWGlitter = vec3(0.0);
float gWDist   = 0.0;
float gWDetail = 0.0;
float gWFoam   = 0.0;
float gWNdotV  = 1.0;

float waterTerrainHeight(vec2 xz) {
  float r = max(abs(xz.x), abs(xz.y));
  if (r <= uHalf) {
    vec2 uv = ((xz + uHalf) / uSpacing + 0.5) / uHeightN;
    return texture2D(uHeightTex, uv).r;
  }
  if (r <= uOuterHalf) {
    vec2 uv = ((xz + uOuterHalf) / uOuterSpacing + 0.5) / uOuterN;
    return texture2D(uHeightOuter, uv).r;
  }
  vec2 uv = ((xz + uFarHalf) / uFarSpacing + 0.5) / uFarN;
  return texture2D(uHeightFar, uv).r;
}

vec3 waterNrm(vec2 uv, float bias) { return texture2D(uNormalTex, uv, bias).xyz * 2.0 - 1.0; }
`;

const WATER_BODY = /* glsl */`
// ---- water body, ripples, foam and alpha --------------------------------------------------------
{
  vec3 Vw = normalize(cameraPosition - vWorld);
  float dist = length(cameraPosition - vWorld);
  gWDist = dist;
  float h = waterTerrainHeight(vWorld.xz);
  float depth = max(uWaterLevel - h, 0.0);
  // metres from the waterline into the water: in-map from the signed shore-distance texture (smooth
  // across triangle facets), outside from the depth
  float toShore;
  if (max(abs(vWorld.x), abs(vWorld.z)) <= uHalf) {
    vec2 uvS = ((vWorld.xz + uHalf) / uSpacing + 0.5) / uShoreN;
    toShore = max(-(texture2D(uShore, uvS).r * 255.0 - 128.0) * 0.25, 0.0);
  } else toShore = depth * 6.0;

  // --- animated ripple normals: five octaves from a 150 m swell down to a 2.4 m chop. The two
  //     smallest fade with distance so the far water calms instead of shimmering into pixel noise,
  //     but the 23 m and 61 m layers stay on out to the horizon, so there is ALWAYS ripple detail.
  vec2 wdir = normalize(uWind + vec2(0.0001));
  vec2 perp = vec2(-wdir.y, wdir.x);
  float t = uTime;
  float bias = 1.35 * smoothstep(150.0, 1100.0, dist);
  const mat2 R37 = mat2(0.7986, -0.6018, 0.6018, 0.7986);
  vec3 nS = waterNrm((R37 * vWorld.xz) / 150.0 + wdir * t * 0.005, bias);
  vec3 n0 = waterNrm((R37 * vWorld.xz) / 61.0 + wdir * t * 0.010, bias);
  vec3 n1 = waterNrm(vWorld.xz / 23.0 + wdir * t * 0.020 + perp * t * 0.004, bias);
  vec3 n2 = waterNrm((R37 * vWorld.xz) / 7.5 - wdir * t * 0.035 + perp * t * 0.011 + 0.37, bias);
  vec3 n3 = waterNrm(vWorld.xz / 2.4 + wdir * t * 0.055 + 0.71, bias);
  float detailFade = 1.0 - smoothstep(50.0, 520.0, dist);
  float midFade = 1.0 - smoothstep(180.0, 1800.0, dist);
  float farFade = 1.0 - smoothstep(400.0, 3000.0, dist);
  float calm = 0.45 + 0.55 * smoothstep(0.0, 2.5, toShore);      // the shallows near the bank are calmer
  gWDetail = detailFade;
  vec2 nxy = (nS.xy * 0.15
            + n0.xy * (0.10 + 0.13 * farFade)
            + n1.xy * (0.07 + 0.16 * midFade)
            + n2.xy * (0.03 + 0.13 * detailFade)
            + n3.xy * 0.09 * detailFade) * (0.60 + 0.40 * calm) * (0.20 + 0.26 * uRain);
  // At roughness 0.04 the sky probe is a sharp mirror, so the ripple slope has to be REAL: a few
  // degrees, not a crumpled foil. 0.20 keeps every octave visible without the reflection swinging
  // between sky and ground per pixel.
  gWN = normalize(vec3(nxy.x, 1.0, nxy.y));
  // a second, sharper normal used only for the sun glitter: this is what makes the sun path read as
  // thousands of individual sparks instead of one soft sheen
  // rain dimples: a fast counter-scrolling pair of the finest octave, near-field only
  if (uRain > 0.01) {
    vec3 r0 = waterNrm(vWorld.xz / 1.1 + vec2(t * 0.31, -t * 0.27), 0.0);
    vec3 r1 = waterNrm(vWorld.xz / 0.7 - vec2(t * 0.24, t * 0.33) + 0.29, 0.0);
    gWN = normalize(gWN + vec3(r0.x + r1.x, 0.0, r0.y + r1.y) * 0.22 * uRain * detailFade);
    nxy += (r0.xy + r1.xy) * 0.10 * uRain * detailFade;
  }
  vec2 gxy = nxy + (n3.xy * 0.30 + n2.xy * 0.22) * detailFade + n1.xy * 0.09 * midFade;
  vec3 Ng = normalize(vec3(gxy.x, 1.0, gxy.y));

  // --- body: absorption. Shallow water is a dark teal, deep water a navy; both are DIFFUSE only —
  //     everything bright on this surface is reflected sky, which is what makes it read as water.
  float absorb = 1.0 - exp(-depth * 0.62);
  diffuseColor.rgb *= mix(uShallowColor, uDeepColor, absorb);
  // river bed shows through the first metre (sand / mud)
  float bedShow = exp(-depth * 2.4);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.058, 0.052, 0.040), bedShow * 0.45);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722))), 0.30);

  // --- sun & moon glitter: a tight GGX lobe on the SHARP normal, added on top of three's own
  //     direct specular so the sun path breaks into sparks instead of one smooth smear.
  float cosT = max(dot(gWN, Vw), 0.0);
  gWNdotV = cosT;
  float ndv = max(cosT, 1e-3);
  float a = 0.040 + 0.055 * (1.0 - detailFade) + 0.05 * smoothstep(500.0, 2600.0, dist);
  float a2 = a * a;
  float moonUp = smoothstep(0.0, 0.15, uMoonDir.y);
  {
    vec3 Hs = normalize(uSunDir + Vw);
    float ndh = max(dot(Ng, Hs), 0.0), ndlS = max(dot(Ng, uSunDir), 0.0);
    float dd = ndh * ndh * (a2 - 1.0) + 1.0;
    float D = a2 / (PI * dd * dd);
    float Fh = 0.02 + 0.98 * pow(1.0 - max(dot(Hs, Vw), 0.0), 5.0);
    float Vis = 0.5 / max(ndlS * sqrt(ndv * ndv * (1.0 - a2) + a2) + ndv * sqrt(ndlS * ndlS * (1.0 - a2) + a2), 1e-3);
    float sunUp = smoothstep(-0.05, 0.12, uSunDir.y);
    gWGlitter += uSunColor * uSunIntensity * sunUp * min(D * Fh * Vis * ndlS, 0.9 + 1.7 * detailFade);
  }
  {
    vec3 Hm = normalize(uMoonDir + Vw);
    float ndh = max(dot(Ng, Hm), 0.0), ndlM = max(dot(Ng, uMoonDir), 0.0);
    float dd = ndh * ndh * (a2 - 1.0) + 1.0;
    float D = a2 / (PI * dd * dd);
    float Fh = 0.02 + 0.98 * pow(1.0 - max(dot(Hm, Vw), 0.0), 5.0);
    float Vis = 0.5 / max(ndlM * sqrt(ndv * ndv * (1.0 - a2) + a2) + ndv * sqrt(ndlM * ndlM * (1.0 - a2) + a2), 1e-3);
    gWGlitter += uMoonColor * uMoonIntensity * moonUp * min(D * Fh * Vis * ndlM, 5.0) * 1.4;
  }

  // --- shoreline: a narrow (<= 1.6 m) noise-broken foam lace, plus rare whitecaps on open water.
  //     Foam is a rough diffuse surface, so it goes into the albedo and lifts roughnessFactor.
  vec2 fuv = vWorld.xz / 9.0;
  float fN = texture2D(uNoise, fuv + wdir * t * 0.04).a * 0.55 + texture2D(uNoise, fuv * 2.7 - wdir * t * 0.07 + 0.3).b * 0.45;
  float band = 1.0 - smoothstep(0.12, 1.30, toShore);
  float swell = 0.5 + 0.5 * sin(t * 1.1 - toShore * 1.6 + fN * 4.0 + vWorld.x * 0.05);
  float foam = band * smoothstep(0.66, 0.88, fN * 0.78 + 0.26 * swell * band) * 0.34;
  foam = max(foam, (1.0 - smoothstep(0.0, 0.42, toShore)) * smoothstep(0.44, 0.70, fN + 0.16 * sin(t * 1.6 + vWorld.x * 0.3 + vWorld.z * 0.23)) * 0.36);
  foam *= 1.0 - smoothstep(260.0, 1000.0, dist);
  foam *= 1.0 - 0.92 * uNightFactor;
  float caps = smoothstep(0.955, 0.995, texture2D(uNoise, vWorld.xz / 11.0 + wdir * t * 0.06 + 0.5).b)
    * smoothstep(0.80, 0.97, texture2D(uNoise, vWorld.xz / 70.0 - wdir * t * 0.02 + 0.2).r)
    * midFade * calm * smoothstep(1.2, 4.0, depth) * 0.10;
  foam = max(foam, caps * (1.0 - 0.92 * uNightFactor));
  gWFoam = foam;
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.34, 0.36, 0.375), foam);

  // --- transparency. The waterline dissolves through a dithered ramp instead of ending on a line:
  //     an interleaved-gradient pattern breaks the last 1.4 m into wet grains, which is what a real
  //     shore looks like and what kills the hard tan seam.
  float fres = 0.020 + 0.55 * pow(1.0 - cosT, 5.0);
  float alpha = 1.0 - exp(-depth * 2.2);
  alpha = max(alpha, fres * 0.8 * smoothstep(0.0, 0.4, depth));
  alpha = max(alpha, foam * 0.85);
  float edge = smoothstep(0.0, 1.40, toShore) * smoothstep(0.0, 0.05, depth);
  float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float grain = texture2D(uNoise, vWorld.xz * 0.9).g;
  edge = clamp(edge * 1.22 - 0.11 + (ign * 0.6 + grain * 0.4 - 0.5) * 0.30 * edge * (1.0 - edge) * 4.0, 0.0, 1.0);
  diffuseColor.a *= clamp(alpha, 0.0, 1.0) * edge;
}
`;
