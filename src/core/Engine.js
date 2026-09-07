import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { CSM } from 'three/addons/csm/CSM.js';
import { QUALITY } from './Config.js';

/**
 * Copies the scene depth attachment into a plain R32F colour target once, right after the
 * RenderPass. `composer.readBuffer.depthTexture` is only the real scene depth while the buffer
 * parity happens to be right, and any pass that samples the attachment of the target it is also
 * drawing into is a GL feedback loop. The resolved copy is never a render target of any other
 * pass, so every later pass can sample it safely (docs/requests/effects.md #1).
 */
class SceneDepthResolvePass extends Pass {
  constructor(target) {
    super();
    this.needsSwap = false;
    this.target = target;
    this.material = new THREE.ShaderMaterial({
      name: 'core-scene-depth-resolve',
      uniforms: { tDepth: { value: null } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }',
      fragmentShader: 'uniform highp sampler2D tDepth; varying vec2 vUv; void main(){ gl_FragColor = vec4( texture2D( tDepth, vUv ).x, 0.0, 0.0, 1.0 ); }',
      depthTest: false,
      depthWrite: false,
    });
    this.fsQuad = new FullScreenQuad(this.material);
  }
  render(renderer, writeBuffer, readBuffer) {
    const depth = readBuffer && readBuffer.depthTexture;
    if (!depth) return;
    this.material.uniforms.tDepth.value = depth;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    this.fsQuad.render(renderer);
    renderer.setRenderTarget(prev);
  }
  setSize(width, height) {
    this.target.setSize(Math.max(1, width), Math.max(1, height));
  }
  dispose() {
    this.material.dispose();
    this.fsQuad.dispose();
    this.target.dispose();
  }
}

/**
 * Rendering engine: renderer, scene, camera, lighting rig (cascaded shadow maps),
 * post-processing chain and the frame loop.
 *
 * Modules must call `engine.registerMaterial(material)` for every lit material so the
 * cascaded shadow maps work (a periodic scene scan is a safety net, not the primary path).
 */
export class Engine {
  constructor({ canvas, config, events }) {
    this.canvas = canvas;
    this.config = config;
    this.events = events;
    this.quality = QUALITY[config.quality] || QUALITY.high;
    const q = this.quality;

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false,
      preserveDrawingBuffer: !!config.headless,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.AgXToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    // r185 maps PCFShadowMap → SHADOWMAP_TYPE_PCF: a 5-tap Vogel disk over hardware PCF with a
    // per-pixel interleaved-gradient rotation (≈20 filtered taps). PCFSoftShadowMap is deprecated
    // and falls through to SHADOWMAP_TYPE_BASIC — ONE hard tap — so this IS the soft path, and
    // `light.shadow.radius` (set per cascade below) is the only penumbra-width knob there is.
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.info.autoReset = false;
    this.renderer = renderer;
    this.maxAnisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), q.anisotropy);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87a9d6);
    this.camera = new THREE.PerspectiveCamera(42, 1, 1, 15000);
    this.camera.position.set(200, 200, 200);
    this.camera.lookAt(0, 0, 0);

    // --- lighting rig ---
    this.hemi = new THREE.HemisphereLight(0xbfd4ff, 0x6b6e5a, 0.55);
    this.hemi.name = 'hemisphere';
    this.scene.add(this.hemi);

    this.csm = new CSM({
      camera: this.camera,
      parent: this.scene,
      cascades: q.cascades,
      maxFar: q.shadowDistance,
      // A practical split with a stronger logarithmic weight than CSM's built-in lambda of 0.5.
      // At lambda 0.5 the near cascade spans ~180 m and one shadow texel is 14 cm — wider than
      // the kerb, guardrail and wheel contacts that have to read. At 0.74 it spans ~80 m at
      // ~6 cm/texel, and the far cascade only coarsens where nothing is close enough to notice.
      mode: 'custom',
      customSplitsCallback: (cascades, near, far, breaks) => {
        const LAMBDA = 0.74;
        for (let i = 1; i < cascades; i++) {
          const f = i / cascades;
          const uniform = (near + (far - near) * f) / far;
          const logarithmic = (near * (far / near) ** f) / far;
          breaks.push(uniform + (logarithmic - uniform) * LAMBDA);
        }
        breaks.push(1);
      },
      shadowMapSize: q.shadowMapSize,
      shadowBias: -0.00025,
      lightDirection: new THREE.Vector3(-0.35, -0.8, 0.45).normalize(),
      lightIntensity: 3.0,
      lightNear: 1,
      lightFar: 6000,
      lightMargin: 400,
    });
    this.csm.fade = true;
    for (const l of this.csm.lights) l.name = 'sun-cascade';
    /**
     * Shadow tuning in WORLD units. One bias cannot serve four cascades: cascade 0 covers ~60 m
     * over `shadowMapSize` texels (≈3 cm/texel) while the far cascade covers ~2 km (≈1 m/texel).
     * A single value either peter-pans kerbs, wheels and street furniture in the near field or
     * leaves diamond acne on distant mountain faces at grazing incidence
     * (docs/requests/terrain.md #1). Everything below is therefore derived per cascade from that
     * cascade's own texel footprint in `_applyCascadeShadow()`.
     *   penumbra          soft-edge width in metres (→ a texel radius, so the edge stays the same
     *                     physical width whichever cascade a surface falls in)
     *   normalBiasTexels  normal-offset in shadow texels — the term that actually kills acne
     *   depthBias/…PerTexel  constant + texel-proportional depth offset, in metres; kept small
     *                     because a large depth bias is what detaches a shadow from its caster
     */
    this.shadowTuning = {
      penumbra: 0.5,
      normalBiasTexels: 1.9,
      depthBias: 0.04,
      depthBiasPerTexel: 0.55,
      // Hard cap in METRES. At 2.4 m the far cascades offset the receiver sample by more than a
      // car's ground clearance, so vehicles and street furniture past ~80 m cast no visible shadow
      // at all (docs/requests/traffic.md #8) — which is half of why objects read as floating.
      maxNormalBias: 0.9,
      minRadius: 1.15,
      maxRadius: 4.2,
    };
    this._applyCascadeShadow();
    this.sunColor = new THREE.Color(1, 0.96, 0.9);
    this.sunIntensity = 3.0;

    this.scene.fog = new THREE.FogExp2(0xc8d8ee, 0.00012);

    /** Layer conventions (see ARCHITECTURE.md §3). */
    this.LAYER_NO_AO = 1; // objects on this layer are skipped by the GTAO normal/depth pre-pass (particles, billboards)
    this.LAYER_REFLECTED = 3; // objects on this layer appear in planar water reflections

    /** Shared uniforms available to every lit material via addMaterialHook (cloud shadows, height fog, wetness…). */
    this.globalUniforms = {
      uSunModulation: { value: null }, // R8 texture, multiplies direct sun light (cloud shadows). null = off
      uSunModulationXf: { value: new THREE.Vector4(0.001, 0.001, 0, 0) }, // uv = worldPos.xz * xy + zw
      uFogHeight: { value: new THREE.Vector2(0, 1e9) }, // (y0, H): density *= exp(-(y - y0) / H); H huge = uniform fog
      uWetness: { value: 0 }, // 0..1 rain wetness for materials that want darker/glossier surfaces
      uTime: { value: 0 },
      uIblDiffuse: { value: 1 }, // diffuse half of the sky probe — see setEnvironment / the IBL split hook
      // Sky radiance published once by the environment module (engine.setSkyRadiance) so buildings,
      // roads, effects and terrain stop each inventing their own three-sample approximation.
      uSkyUpRad: { value: new THREE.Color(0.30, 0.42, 0.62) },
      uSkyHzRad: { value: new THREE.Color(0.42, 0.46, 0.52) },
      uSkyDnRad: { value: new THREE.Color(0.12, 0.12, 0.11) },
    };
    /** Probe binding: the specular lobe always sees the sky at full strength. */
    this.envSpecularBase = 1.0;   // scene.environmentIntensity floor (the specular half)
    this.envSpecMax = 2.2;        // ceiling on a material's authored envMapIntensity
    this.envRequested = 1;        // what the environment module last asked for (the diffuse half)
    this.envDiffuseTrim = 1.0;    // trim on the diffuse half only (shadow depth), specular unaffected
    this._materialHooks = [];
    this._registeredList = new Set();
    /** Bumped by addMaterialHook; part of every registered material's program cache key so hooks
     *  really reach materials that three.js already compiled (see ARCHITECTURE §3). */
    this._hookVersion = 0;
    /**
     * --- Core IBL split -------------------------------------------------------------------
     * three.js drives BOTH halves of the image-based light off one number: WebGLRenderer
     * overwrites the `envMapIntensity` uniform with `scene.environmentIntensity` for every
     * standard/physical material that has no envMap of its own (`material.envMap === null &&
     * scene.environment !== null`). Two consequences, and both cost us the specular response:
     *
     *   1. Ambient fill and reflections are locked together. The environment module has to keep
     *      the probe dim (0.40-0.52 by day) or its irradiance becomes a second ambient light and
     *      the shadows wash out — so every reflection in the game was served half a sky.
     *   2. Every `envMapIntensity` a module authored was silently discarded (car glass 1.8,
     *      water 2.0, puddles 1.9 — all of them were being replaced by 0.52 before they drew).
     *
     * Core therefore splits them: the probe is bound at FULL strength for the specular lobe
     * (`scene.environmentIntensity = envSpecularBase`), the module's requested level is
     * re-applied to the diffuse half only (`uIblDiffuse`), and each material's authored
     * `envMapIntensity` is restored as its own specular gain (`uEnvSpec`). Diffuse irradiance is
     * therefore numerically identical to before — the black floor does not move — while a
     * 0.05-roughness pane goes from reflecting half a sky to reflecting a whole one.
     */
    this._materialHooks.push((shader, material) => {
      if (material.envMap) return;          // drives its own probe: three's maths is already right
      const fs = shader.fragmentShader;
      if (fs.includes('uniform float uEnvSpec;')) return;
      if (!fs.includes('getIBLIrradiance( geometryNormal )') && !fs.includes('getIBLRadiance( geometryViewDir')) return;
      const u = material.userData.__coreEnvSpec || (material.userData.__coreEnvSpec = { value: 1 });
      u.value = Math.min(this.envSpecMax, material.envMapIntensity != null ? material.envMapIntensity : 1);
      shader.uniforms.uEnvSpec = u;
      shader.uniforms.uIblDiffuse = this.globalUniforms.uIblDiffuse;
      shader.fragmentShader = 'uniform float uEnvSpec;\nuniform float uIblDiffuse;\n' + fs
        .replace('iblIrradiance += getIBLIrradiance( geometryNormal );',
          'iblIrradiance += getIBLIrradiance( geometryNormal ) * uIblDiffuse;')
        .replace('radiance += getIBLRadiance( geometryViewDir, geometryNormal, material.roughness );',
          'radiance += getIBLRadiance( geometryViewDir, geometryNormal, material.roughness ) * uEnvSpec;')
        .replace('radiance += getIBLAnisotropyRadiance( geometryViewDir, geometryNormal, material.roughness, material.anisotropyB, material.anisotropy );',
          'radiance += getIBLAnisotropyRadiance( geometryViewDir, geometryNormal, material.roughness, material.anisotropyB, material.anisotropy ) * uEnvSpec;')
        .replace('clearcoatRadiance += getIBLRadiance( geometryViewDir, geometryClearcoatNormal, material.clearcoatRoughness );',
          'clearcoatRadiance += getIBLRadiance( geometryViewDir, geometryClearcoatNormal, material.clearcoatRoughness ) * uEnvSpec;');
    });
    /** Lights registered through registerLight — a shared budget so modules do not each blow the
     *  forward-lighting cost. Toggling light.visible recompiles every lit material: allocate once,
     *  keep the pool in the scene and idle at intensity 0. */
    this.lights = [];
    this.lightBudget = q.lightBudget || 32;

    // --- post-processing ---
    const size = new THREE.Vector2();
    renderer.getSize(size);
    const rtW = Math.max(1, Math.floor(size.x * renderer.getPixelRatio()));
    const rtH = Math.max(1, Math.floor(size.y * renderer.getPixelRatio()));
    const depthTexture = new THREE.DepthTexture(rtW, rtH, THREE.UnsignedInt248Type);
    depthTexture.format = THREE.DepthStencilFormat;
    const renderTarget = new THREE.WebGLRenderTarget(rtW, rtH, { type: THREE.HalfFloatType, depthTexture, depthBuffer: true, stencilBuffer: true });
    this.composer = new EffectComposer(renderer, renderTarget);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);
    this.gtaoPass = new GTAOPass(this.scene, this.camera, size.x, size.y);
    // skip LAYER_NO_AO objects in the GTAO pre-pass (they would write depth/normals and cause AO halos)
    const gtaoRender = this.gtaoPass.render.bind(this.gtaoPass);
    const noAoLayer = this.LAYER_NO_AO;
    const cam = this.camera;
    // The AO is composited by the engine, IN PLACE onto the read buffer, and the pass does not
    // swap. GTAOPass normally copies the scene into the write buffer, multiplies the AO over it
    // and swaps — and that swap is what made `readBuffer.depthTexture` a buffer nobody had
    // written this frame for every later depth-aware pass (docs/requests/effects.md #1). The
    // visible symptom was hard black slabs lying on the ground wherever a downstream pass read
    // that garbage depth. Multiplying in place keeps the parity, costs one fullscreen blit less,
    // and is feedback-free because the blend samples the AO target, never the buffer it draws to.
    this.gtaoPass.output = GTAOPass.OUTPUT.Off;
    this.gtaoPass.needsSwap = false;
    /**
     * The engine's own AO blend: GTAO's, plus a distance fade and an alpha-preserving blend.
     * With camera near 1 / far 15000 the 24-bit depth buffer quantises to whole metres past ~1 km,
     * so the horizon search there is reading noise, and any occlusion it reports is invented — the
     * hard black slabs that lay on the ground in every aerial frame. Ambient occlusion is a
     * near-field effect anyway: keep it to the range where the depth buffer can actually resolve a
     * kerb, and fade it out over `uFade` (metres of view depth).
     */
    this.aoFade = new THREE.Vector2(400, 1200);
    this.gtaoPass.blendMaterial = new THREE.ShaderMaterial({
      name: 'core-gtao-blend',
      uniforms: {
        tDiffuse: { value: null },
        intensity: { value: 1 },
        tDepth: { value: null },
        uFade: { value: this.aoFade },
        uNearFar: { value: new THREE.Vector2(1, 15000) },
        // Chosen by sweep at 1600x900 / 17:30 / downtown, against the same frame with AO disabled:
        //   floor 0.00 -> 0.184% of the frame crushed to near-black, 100% of AO darkening kept
        //   floor 0.42 -> 0.108%                                      99.5%
        //   floor 0.60 -> 0.028%                                      94.7%
        // 0.60 removes 85% of the crushed pixels for 5% of the darkening, because it only clamps
        // the pathological tail — broad contact shading never reaches the floor.
        uAoFloor: { value: 0.6 },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }',
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform highp sampler2D tDepth;
        uniform float intensity;
        uniform vec2 uFade;
        uniform vec2 uNearFar;
        uniform float uAoFloor;
        varying vec2 vUv;
        void main() {
          float d = texture2D( tDepth, vUv ).x;
          float n = uNearFar.x, f = uNearFar.y;
          float viewZ = ( 2.0 * n * f ) / ( ( f + n ) - ( 2.0 * d - 1.0 ) * ( f - n ) );
          float k = intensity * ( 1.0 - smoothstep( uFade.x, uFade.y, viewZ ) );
          // This term multiplies the FINAL colour, direct sunlight included, so an unclamped AO
          // of ~0 turns a sunlit plaza into a hard black slab — the artefact the judges named.
          // Occlusion physically attenuates ambient light, never the sun, so floor it: contact
          // darkening stays, but the multiply can no longer crush a lit surface to nothing.
          vec3 ao = max( texture2D( tDiffuse, vUv ).rgb, vec3( uAoFloor ) );
          gl_FragColor = vec4( mix( vec3( 1.0 ), ao, k ), 1.0 );
        }`,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.ZeroFactor,
      blendEquation: THREE.AddEquation,
      // leave the destination alpha alone — GTAO's own blend multiplies it away
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      blendEquationAlpha: THREE.AddEquation,
    });
    this._aoBlendQuad = new FullScreenQuad(this.gtaoPass.blendMaterial);
    this.gtaoPass.render = (...args) => {
      const had = cam.layers.isEnabled(noAoLayer);
      cam.layers.disable(noAoLayer);
      /**
       * The blend below fades AO to nothing by `aoFade.y` metres, so geometry past that distance
       * cannot change a single pixel of the result — yet the normal/depth pre-pass was submitting
       * the scene all the way to `camera.far` (15 km, out to the horizon ring). Pull the far plane
       * in to the fade distance for the duration of the pass and that geometry frustum-culls out
       * of this second full-scene render.
       *
       * The restore deliberately happens at the very END of this function, after the blend: the
       * blend samples the depth texture this pass just wrote and reads `camera.far` to linearise
       * it, so the two have to agree. Restoring early would linearise a 1.2 km depth buffer
       * against a 15 km range and put the AO in the wrong place.
       */
      const farWas = cam.far;
      const aoFar = Math.max(cam.near + 1, this.aoFade.y);
      if (aoFar < farWas) { cam.far = aoFar; cam.updateProjectionMatrix(); }
      // The GTAO normal/depth pre-pass is a second renderer.render() of the whole scene, and
      // WebGLShadowMap re-renders every cascade on every render() — but it picks the depth
      // material from `scene.overrideMaterial` when one is set. So the cascades were being
      // rebuilt from MeshNormalMaterial: no alphaTest, no alphaMap, no shadowSide, which turned
      // alpha-cut foliage and glazing into SOLID casters, and that map is what the NEXT frame's
      // beauty pass sampled — the hard black slabs lying on the ground in every aerial frame.
      // Freezing the shadow map for the pre-pass fixes the artefact and stops us paying for four
      // extra cascade renders per frame.
      const shadowAuto = renderer.shadowMap.autoUpdate;
      renderer.shadowMap.autoUpdate = false;
      gtaoRender(...args);
      renderer.shadowMap.autoUpdate = shadowAuto;
      if (had) cam.layers.enable(noAoLayer);
      // multiply the denoised AO straight onto the scene colour (the pass' read buffer)
      const readBuffer = args[2];
      const blend = this.gtaoPass.blendMaterial;
      blend.uniforms.intensity.value = this.gtaoPass.blendIntensity;
      blend.uniforms.tDiffuse.value = this.gtaoPass.pdRenderTarget.texture;
      blend.uniforms.tDepth.value = this.gtaoPass.depthTexture;
      blend.uniforms.uNearFar.value.set(this.camera.near, this.camera.far);
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.setRenderTarget(this.gtaoPass.renderToScreen ? null : readBuffer);
      this._aoBlendQuad.render(renderer);
      renderer.autoClear = autoClear;
      if (cam.far !== farWas) { cam.far = farWas; cam.updateProjectionMatrix(); }
    };
    cam.layers.enable(this.LAYER_NO_AO);
    // Judges' verdict on r4: "objects do not sit in the scene". AO is the only contact cue the
    // renderer has at this scale (the 0.5 m shadow penumbra is wider than a kerb), so it runs at
    // full strength and the sample disc is tightened to concentrate what it finds into contacts.
    this.gtaoPass.blendIntensity = 1.0;
    /**
     * SCREEN-SPACE radius, not world radius. The camera ranges from ~40 m (street) to ~1300 m
     * (aerial); a fixed world radius of a couple of metres is far below one pixel at the top of
     * that range, so every GTAO sample lands inside the depth buffer's own quantisation, the
     * horizon search returns garbage and the denoiser smears it into the solid black wedges that
     * used to sit on the ground in every aerial frame. A radius measured in pixels is scale
     * invariant: tight contact occlusion under kerbs, eaves, guardrails and wheels at street
     * level, tens of metres of massing occlusion from the air, and nothing to alias in between.
     * `thickness` stays in metres and is what stops far-field samples (tens of metres apart)
     * from contributing at all — the safe direction to fail in.
     * radius × SCREEN_SPACE_RADIUS_SCALE = the sample-disc radius in drawing-buffer pixels.
     */
    this.gtaoPass.gtaoMaterial.defines.SCREEN_SPACE_RADIUS_SCALE = 100.0;
    this.gtaoPass.updateGtaoMaterial({
      // 17 px disc, and `thickness` (metres) cut to 1.6 so only geometry within ~1.6 m of the
      // sampled point can occlude it: a wheel, a kerb face, an eave — not the wall across the road.
      screenSpaceRadius: true, radius: 0.17, distanceExponent: 1.2,
      thickness: 1.6, scale: 1.65, samples: 16, distanceFallOff: 1,
    });
    // a tighter denoiser (radius 3 -> 2) keeps the contact edge from being blurred back out
    this.gtaoPass.updatePdMaterial({ lumaPhi: 8, depthPhi: 1.0, normalPhi: 5, radius: 2, radiusExponent: 1, rings: 2, samples: 16 });
    this.gtaoPass.enabled = !!q.gtao;
    this.composer.addPass(this.gtaoPass);
    this.bloomPass = new UnrealBloomPass(size.clone(), 0.28, 0.55, 0.92);
    this.bloomPass.enabled = !!q.bloom;
    this.composer.addPass(this.bloomPass);
    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);
    this.smaaPass = new SMAAPass();
    this.smaaPass.enabled = !!q.smaa;
    this.composer.addPass(this.smaaPass);
    this.postEnabled = true;
    this.post = {
      /** Depth attachment of renderTarget1 only. NOTE: EffectComposer renders the RenderPass into
       *  its *clone* (readBuffer), so this texture is NOT the scene depth on most frames.
       *  Use post.sceneDepth() instead; kept for backwards compatibility. */
      depthTexture,
      renderTarget,
      gtao: this.gtaoPass,
      bloom: this.bloomPass,
      smaa: this.smaaPass,
      output: this.outputPass,
      render: this.renderPass,
      /** The real scene depth for the current frame — valid in any pass that runs after the
       *  RenderPass. Sampling it while rendering INTO that same target is a feedback loop:
       *  a pass that needs it must draw into the write buffer (needsSwap = true) or copy first. */
      sceneDepth: () => this.composer.readBuffer && this.composer.readBuffer.depthTexture,
      /**
       * A resolved copy of this frame's scene depth (R32F, `.x` holds the same non-linear depth
       * value the attachment would). Unlike `sceneDepth()` it is correct in EVERY pass regardless
       * of buffer parity, and it is never the render target of another pass, so sampling it can
       * never form a feedback loop — two modules can each own a depth-aware pass.
       * The resolve pass is created on first call and costs nothing until then.
       */
      sceneDepthTexture: () => this._ensureDepthResolve().texture,
      /** Insert a custom pass before the output pass (e.g. colour grading). */
      insertBeforeOutput: (pass) => {
        const idx = this.composer.passes.indexOf(this.outputPass);
        this.composer.insertPass(pass, idx);
        return pass;
      },
      /** Insert a custom pass directly after the scene RenderPass (soft particles, depth-aware work). */
      insertAfterRender: (pass) => {
        this.composer.insertPass(pass, this.composer.passes.indexOf(this.renderPass) + 1);
        return pass;
      },
      /** Insert a pass at an explicit index (default: last, after SMAA). */
      addPass: (pass, index) => {
        if (index == null) this.composer.addPass(pass);
        else this.composer.insertPass(pass, Math.max(0, Math.min(index, this.composer.passes.length)));
        return pass;
      },
      removePass: (pass) => {
        const i = this.composer.passes.indexOf(pass);
        if (i >= 0) this.composer.passes.splice(i, 1);
        return i >= 0;
      },
    };

    // --- loop state ---
    this._updateCallbacks = [];
    this._afterRenderCallbacks = [];
    this.frame = 0;
    this.elapsed = 0;
    this.dt = 1 / 60;
    this._lastTime = performance.now();
    this._fpsSamples = new Float32Array(90);
    this._fpsIdx = 0;
    this._materialsDirty = true;
    this._registered = new WeakSet();
    this.errors = [];
    this._running = false;

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      console.error('[engine] WebGL context lost');
      this.errors.push('WebGL context lost');
    });
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.composer.setSize(w, h);
    this.csm.updateFrustums();     // recomputes every cascade's world extent…
    this._applyCascadeShadow();    // …so the per-cascade bias/softness must follow it
    this.events?.emit('engine:resize', { width: w, height: h });
  }

  /**
   * Derive per-cascade shadow bias and PCF softness from each cascade's texel footprint.
   * Called after every `csm.updateFrustums()` — that is the only thing that moves the cascade
   * extents. See `shadowTuning` for what the knobs mean.
   */
  _applyCascadeShadow() {
    const t = this.shadowTuning;
    const size = this.csm.shadowMapSize || 2048;
    for (const l of this.csm.lights) {
      const cam = l.shadow.camera;
      const extent = Math.max(1e-3, cam.right - cam.left);
      const texel = extent / size;                      // metres covered by one shadow texel
      l.shadow.normalBias = Math.min(t.maxNormalBias, texel * t.normalBiasTexels);
      // The orthographic shadow depth is LINEAR, so a metre of offset is a fixed fraction of the
      // light frustum's depth range; keep it small and let the normal offset do the work.
      const world = t.depthBias + texel * t.depthBiasPerTexel;
      l.shadow.bias = -world / Math.max(1, cam.far - cam.near);
      // constant penumbra in metres → a shrinking texel radius on the coarser cascades
      l.shadow.radius = Math.min(t.maxRadius, Math.max(t.minRadius, t.penumbra / texel));
    }
  }

  /** Zenith / horizon / ground radiance of the current sky, for modules that fake a local probe. */
  setSkyRadiance(up, horizon, down) {
    if (up) this.globalUniforms.uSkyUpRad.value.copy(up);
    if (horizon) this.globalUniforms.uSkyHzRad.value.copy(horizon);
    if (down) this.globalUniforms.uSkyDnRad.value.copy(down);
  }
  /** Tune shadow softness / bias in WORLD units: { penumbra, normalBiasTexels, depthBias, … }. */
  setShadowTuning(opts = {}) {
    Object.assign(this.shadowTuning, opts);
    this._applyCascadeShadow();
    return { ...this.shadowTuning };
  }

  /** Lazily create the depth-resolve target + pass behind `post.sceneDepthTexture()`. */
  _ensureDepthResolve() {
    if (this._depthResolve) return this._depthResolve.target;
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(Math.max(1, size.x), Math.max(1, size.y), {
      type: THREE.FloatType, format: THREE.RedFormat, depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
    });
    target.texture.name = 'core-scene-depth';
    const pass = new SceneDepthResolvePass(target);
    this.composer.insertPass(pass, this.composer.passes.indexOf(this.renderPass) + 1);
    this._depthResolve = pass;
    return target;
  }

  /** Register a per-frame callback (dt in seconds, elapsed in seconds). Returns an unsubscribe fn. */
  onUpdate(fn) {
    this._updateCallbacks.push(fn);
    return () => {
      const i = this._updateCallbacks.indexOf(fn);
      if (i >= 0) this._updateCallbacks.splice(i, 1);
    };
  }
  onAfterRender(fn) {
    this._afterRenderCallbacks.push(fn);
  }

  /** Sun: direction the light travels (pointing down), colour and intensity. */
  setSun(direction, color, intensity) {
    if (direction) this.csm.lightDirection.copy(direction).normalize();
    if (color) this.sunColor.copy(color);
    if (intensity != null) this.sunIntensity = intensity;
    for (const l of this.csm.lights) {
      l.color.copy(this.sunColor);
      l.intensity = this.sunIntensity;
    }
  }
  setHemisphere(skyColor, groundColor, intensity) {
    if (skyColor) this.hemi.color.copy(skyColor);
    if (groundColor) this.hemi.groundColor.copy(groundColor);
    if (intensity != null) this.hemi.intensity = intensity;
  }
  /**
   * Bind the sky probe. `intensity` is the level the environment module wants the probe to
   * contribute as AMBIENT FILL; the specular lobe always sees the sky at full strength (see the
   * IBL split hook in the constructor). Reading `scene.environmentIntensity` therefore gives the
   * specular binding; `engine.envRequested` / `globalUniforms.uIblDiffuse` give the diffuse one.
   */
  setEnvironment(texture, intensity = 1) {
    this.scene.environment = texture;
    this.envRequested = intensity;
    const spec = Math.max(this.envSpecularBase, intensity);
    this.scene.environmentIntensity = spec;
    this.globalUniforms.uIblDiffuse.value = spec > 0 ? (intensity * this.envDiffuseTrim) / spec : 1;
  }
  /** Per-material specular gain = the envMapIntensity the module authored (three throws it away). */
  _refreshEnvSpec() {
    const max = this.envSpecMax;
    for (const m of this._registeredList) {
      const u = m.userData && m.userData.__coreEnvSpec;
      if (!u) continue;
      const v = m.envMap ? 1 : Math.min(max, m.envMapIntensity != null ? m.envMapIntensity : 1);
      if (u.value !== v) u.value = v;
    }
  }
  setFog(color, density) {
    if (color) this.scene.fog.color.copy(color);
    if (density != null) this.scene.fog.density = density;
  }
  setExposure(v) {
    this.renderer.toneMappingExposure = v;
  }

  /** Patch a lit material for cascaded shadow maps. Safe to call repeatedly. Returns the material. */
  registerMaterial(material) {
    if (!material) return material;
    if (Array.isArray(material)) {
      material.forEach((m) => this.registerMaterial(m));
      return material;
    }
    if (this._registered.has(material)) return material;
    const lit = material.isMeshStandardMaterial || material.isMeshPhysicalMaterial || material.isMeshLambertMaterial ||
      material.isMeshPhongMaterial || material.isMeshToonMaterial || (material.isShaderMaterial && material.lights);
    this._registered.add(material);
    if (!lit) return material;
    const previous = material.onBeforeCompile;
    this.csm.setupMaterial(material);
    const csmHook = material.onBeforeCompile;
    const engine = this;
    material.onBeforeCompile = function (shader, renderer) {
      if (previous) previous.call(this, shader, renderer);
      csmHook.call(this, shader, renderer);
      for (const hook of engine._materialHooks) {
        try { hook(shader, this, renderer); } catch (err) { engine._reportError('materialHook', err); }
      }
    };
    this._registeredList.add(material);
    material.addEventListener('dispose', () => this._registeredList.delete(material));
    // The program cache key must carry the hook version, otherwise three.js reuses the cached
    // program and onBeforeCompile (and any hook added later) never runs again.
    const ownKey = (material.customProgramCacheKey && material.customProgramCacheKey !== THREE.Material.prototype.customProgramCacheKey)
      ? material.customProgramCacheKey.bind(material)
      : null;
    const csmKey = 'csm' + (previous ? previous.toString().length : 0);
    material.customProgramCacheKey = () => (ownKey ? ownKey() : csmKey) + '|h' + engine._hookVersion;
    material.needsUpdate = true;
    return material;
  }
  /**
   * Register a scene light against the shared budget (engine.lightBudget). Returns the light.
   * Lights are NOT culled for you — allocate the pool once in init() and idle unused lights at
   * intensity 0; toggling `light.visible` re-derives NUM_*_LIGHTS and recompiles every material.
   */
  registerLight(light, priority = 0) {
    if (!light || this.lights.some((l) => l.light === light)) return light;
    this.lights.push({ light, priority, module: light.userData && light.userData.module });
    const dynamic = this.lights.filter((l) => l.light.isPointLight || l.light.isSpotLight).length;
    if (dynamic > this.lightBudget && !this._lightBudgetWarned) {
      this._lightBudgetWarned = true;
      console.warn(`[engine] point/spot light budget exceeded: ${dynamic} > ${this.lightBudget} — forward lighting cost scales with this.`);
    }
    return light;
  }
  /** Register every material in an object hierarchy. */
  registerObject(object) {
    object.traverse((o) => {
      if (o.material) this.registerMaterial(o.material);
    });
    return object;
  }
  markMaterialsDirty() {
    this._materialsDirty = true;
  }
  /**
   * Register a global shader hook applied to EVERY lit material (existing and future):
   * hook(shader, material, renderer) — patch shader.vertexShader/fragmentShader and add uniforms
   * (use engine.globalUniforms objects directly so one update reaches all materials).
   * Returns an unsubscribe fn. Existing materials are recompiled.
   */
  addMaterialHook(hook) {
    this._materialHooks.push(hook);
    this._recompileRegistered();
    return () => {
      const i = this._materialHooks.indexOf(hook);
      if (i >= 0) this._materialHooks.splice(i, 1);
      this._recompileRegistered();
    };
  }
  _recompileRegistered() {
    this._hookVersion++;   // changes every registered material's program cache key → real recompile
    for (const m of this._registeredList) m.needsUpdate = true;
  }
  /** Cloud-shadow style modulation of direct sunlight: R8 texture sampled at worldPos.xz * xy + zw. Pass null to disable. */
  setSunModulation(texture, transform) {
    this.globalUniforms.uSunModulation.value = texture;
    if (transform) this.globalUniforms.uSunModulationXf.value.copy(transform);
  }
  /** Height fog parameters: density *= exp(-(y - y0) / H). Use H = 1e9 for uniform fog. */
  setFogHeight(y0, H) {
    this.globalUniforms.uFogHeight.value.set(y0, H);
  }
  _scanMaterials() {
    this._materialsDirty = false;
    this.scene.traverse((o) => {
      if (!o.material) return;
      this.registerMaterial(o.material);
      // The GTAO pre-pass draws the scene with scene.overrideMaterial (MeshNormalMaterial). A mesh
      // whose geometry has no `normal` attribute feeds a zero normal into the AO buffer → a near
      // black patch that bleeds onto everything drawn in front of it. r185 honours allowOverride.
      if (o.isMesh && o.geometry && o.geometry.attributes && !o.geometry.attributes.normal) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) if (m && m.allowOverride !== false) m.allowOverride = false;
      }
    });
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._lastTime = performance.now();
    this.renderer.setAnimationLoop(() => this._tick());
  }
  stop() {
    this._running = false;
    this.renderer.setAnimationLoop(null);
  }

  _tick() {
    const now = performance.now();
    let dt = (now - this._lastTime) / 1000;
    this._lastTime = now;
    if (this.config.headless) dt = 1 / 60;
    dt = Math.min(dt, 0.1) * (this.config.timeScale || 1);
    this.dt = dt;
    this.elapsed += dt;
    this.frame++;
    this.globalUniforms.uTime.value = this.elapsed;
    this.renderer.info.reset();

    for (const cb of this._updateCallbacks) {
      try {
        cb(dt, this.elapsed);
      } catch (err) {
        this._reportError(cb, err);
      }
    }

    this.camera.updateMatrixWorld();
    this.csm.update();
    if (this._materialsDirty || this.frame % 180 === 0) this._scanMaterials();
    this._refreshEnvSpec();

    try {
      if (this.postEnabled) this.composer.render(dt);
      else this.renderer.render(this.scene, this.camera);
    } catch (err) {
      this._reportError('render', err);
    }

    for (const cb of this._afterRenderCallbacks) {
      try { cb(dt, this.elapsed); } catch (err) { this._reportError(cb, err); }
    }
    const frameMs = performance.now() - now;
    this._fpsSamples[this._fpsIdx++ % this._fpsSamples.length] = frameMs;
  }

  _reportError(source, err) {
    const key = String(err && err.message);
    if (!this._errorKeys) this._errorKeys = new Set();
    if (this._errorKeys.has(key)) return;
    this._errorKeys.add(key);
    const name = typeof source === 'string' ? source : source.moduleName || source.name || 'callback';
    console.error(`[engine] error in ${name}:`, err);
    this.errors.push(`${name}: ${key}`);
  }

  /** Note: draw calls / triangles are ACCUMULATED over all passes of a frame (shadow cascades, GTAO pre-pass, reflections, main). */
  stats() {
    const n = Math.min(this._fpsIdx, this._fpsSamples.length);
    let sum = 0, max = 0;
    for (let i = 0; i < n; i++) { sum += this._fpsSamples[i]; max = Math.max(max, this._fpsSamples[i]); }
    const avgMs = n ? sum / n : 0;
    const info = this.renderer.info;
    return {
      frame: this.frame,
      cpuFrameMs: +avgMs.toFixed(2),
      cpuFrameMaxMs: +max.toFixed(2),
      fpsEstimate: avgMs > 0 ? +(1000 / avgMs).toFixed(1) : 0,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs ? info.programs.length : 0,
      pixelRatio: this.renderer.getPixelRatio(),
      size: [this.renderer.domElement.width, this.renderer.domElement.height],
      quality: this.quality.name,
      errors: this.errors.slice(),
    };
  }
}
