# buildout branch → core / integrator

ARCHITECTURE.md §1 reserves `src/main.js` and `src/core/**` for the integrator and asks for a written
request instead of an edit. This branch **does** edit four of those files. This document is the
request that should have come first, written after the fact and offered on that footing: each change
is described with what it does, why it could not live in a module, and what was measured. **Reject
any of them freely** — the four module-local changes (props, roads, terrain, ui) stand on their own
and do not depend on these.

---

## 1. `src/core/Input.js` — pointer tracking for touch

**What.** Track live pointers by `pointerId` in a `Map`, expose `touchCount` and per-frame pinch /
twist / midpoint deltas, and give every drag an owning `pointerId`.

**Why not in a module.** `Input` is the sole owner of pointer events; nothing outside core sees a
`pointerdown`. A module cannot know a second finger exists.

**Why at all.** The camera could not be moved *at all* on a touch device. Panning required a
middle-button or Alt+left drag and the keyboard path needs WASD; a phone has neither. Measured on an
iPhone-class viewport (390×844): a one-finger drag moved the camera **0.00 m**.

**Note on the drag record.** The same change fixes a latent bug it would otherwise have introduced:
a drag now belongs to the pointer that started it. Previously any `pointerdown` overwrote
`this.drag`, and since every touch reports `button 0`, whichever finger lifted first ended it. A
mouse keeps one `pointerId` across its buttons, so mouse behaviour is unchanged by construction.
`pointercancel` also gets the teardown it was missing — it *replaces* `pointerup`, so without it a
cancelled gesture left a live drag accumulating movement for ever.

---

## 2. `src/core/CameraController.js` — touch gestures

**What.** One finger drags the ground (only while no build tool is armed); two fingers pinch to
zoom, twist to rotate and slide to pan.

**Why not in a module.** The camera controller is core, and this is camera behaviour.

**Known wart, flagged rather than hidden.** The one-finger branch reads
`world.tool.active !== 'select' && !== 'info'` — a core→module string coupling, and it has to be kept
in step with the identical list in `src/modules/ui/index.js`. **Request:** have the tools module
publish the fact instead (e.g. `world.tool.consumesDrag`, or a `passive` flag on the tool record) so
both call sites read one value and core stops naming tools.

**Measured after (same viewport and seed):** one-finger pan 0.00 m → 62.7 m; pinch distance
380 → 104.8; twist yaw 0.6 → −0.09; two-finger slide 18.3 m. Desktop unchanged: WASD 136.3 m,
right-drag rotate, wheel zoom and middle-drag pan all still pass, zero console errors.

---

## 3. `src/core/Engine.js` — two changes to the AO path

**(a) GTAO pre-pass culled to the AO fade distance.** The blend fades AO to nothing by `aoFade.y`
(1200 m), but the normal/depth pre-pass — a second full-scene render — submitted geometry to
`camera.far` (15 km, past the horizon ring). The pass now renders with the far plane pulled in to
the fade distance. The restore happens *after* the blend, not before: the blend samples the depth
this pass wrote and reads `camera.far` to linearise it, so the two have to agree.

Measured, sim paused and reflection pinned so the pass is the only variable: **2057 → 2040 draw
calls, 8.81 M → 8.68 M triangles**, mean per-pixel delta 0.29/255 (visually neutral; a 2× crop of the
strongest contact-AO region is indistinguishable).

**(b) An AO floor.** The AO term multiplies the *final* colour, direct sunlight included, so an
occlusion near zero turned lit paving into a hard black slab — the artefact the project's own blind
judges named, and which `Engine.js` comments record two earlier attempts to kill. Isolated by
elimination: with shadows disabled the slab was unchanged; with the AO blend disabled it vanished
(near-black pixels in the region 1.36% → 0.01%). Occlusion physically attenuates ambient, never the
sun, so the term is floored at 0.6.

Chosen by sweep against the same frame with AO off: floor 0.00 → 0.184% of the frame crushed to
near-black keeping 100% of AO darkening; 0.42 → 0.108% / 99.5%; **0.60 → 0.028% / 94.7%**. It removes
85% of the crushed pixels for 5% of the darkening, because it only clamps the pathological tail.
Verified not to wash out where AO earns its keep: at a street-level junction and at night the change
is invisible (mean delta 1.11 and 0.94 of 255).

**Why not in a module.** Nothing outside core can reach `gtaoPass.blendMaterial` or the pre-pass
camera.

**Request:** if this lands, `uAoFloor` deserves to be an engine knob alongside `shadowTuning` rather
than a hardcoded uniform, so perfguard and the critics can sweep it.

---

## 4. `src/main.js` — where a new city opens

**What.** The new-city camera search now scores candidates by whether a **140 m road can actually be
built** through them, using the road tool's own rule, instead of by a dryness/flatness proxy. It also
nudges candidates off the 120 m lattice.

**Why it mattered.** On seed 4242 — the seed `tools/playtest.mjs` types — the old proxy opened the
camera where *no* 140 m road was possible in any direction, so the first thing the game did to a new
player was refuse their first action, and the harness had to hunt 40 m away for its first road.

**Measured across 8 seeds**, counting how many of the four first-road directions are buildable at the
exact opening target: seeds with none went **1 of 8 → 0 of 8**; seed 4242 went 0/4 → 4/4 (target moved
60 m). Every other seed is byte-identical, because the search returns as soon as it finds a point
where all four directions work. Still deterministic — same seed, same view, verified over repeat
loads. Cost is bounded by terrain sampling measured at 0.07 µs: **0.02 ms typical, 6.6 ms worst
case** against a ~10 s boot.

**This is the weakest of the four and the one most worth rejecting.** `roadCorridorOk()` duplicates
`MAX_SLOPE` and the sampling rule from `src/modules/tools/roadtool.js`, and takes its 140 m from the
playtest harness. Two copies of a rule will drift.

**Request:** have the tools module export the predicate — something like
`tools.api.canBuildRoad(a, b, typeId)` — and let `main.js` call it. Then core stops owning a copy of
a module's rule, and the spawn search and the road tool can never disagree.

---

## 5. `src/core/Config.js` — three shadow cascades at `high`

**What.** `QUALITY.high.cascades` 4 → 3. One value; nothing else reads it.

**Why not in a module.** The quality presets are core's, and every module scales itself off them.

**Correction first.** An earlier version of this change — and the comment shipped beside it — said
the fourth cascade had to go to get under "the ≤1500 draw-call budget in §9". Both halves were
wrong. The budget is §3's **≤2500 draw calls / ≤8 M triangles**, the 1500 is `PROMPT.md`'s original
brief rather than the shipped contract, and at four cascades draw calls measured 1580 / 1634 —
**never over**. Draw calls were never the problem, and I optimised several commits against a number
I had invented. The comment in `Config.js` now records that.

**Why at all — the real reason is triangles.** §3's counts are ACCUMULATED over every pass, and each
shadow caster is re-submitted once per cascade. Measured at 1920×1080, quality=high, seed 1337, mean
over 80 frames, by disabling each cascade light in turn at the `civic` preset:

| | triangles | draw calls |
|---|---|---|
| the 3 shadow passes | **4.06 M** | 722 |
| whole frame | 8.12 M | 1548 |

Shadows are **half the triangle budget**. A fourth cascade costs ~1.3 M more, and nothing else
measured refunds that. Note §3 describes the frame as "4 shadow cascades + GTAO + water reflection +
main pass" — three is a deliberate deviation from the documented frame shape, taken because four
cannot fit the 8 M ceiling on this scene. **If you would rather keep the documented shape, set it
back to 4 and take the overage**; that is a legitimate call and this is why it is a request.

**Cost.** The same 2048² maps cover 1400 m in three slices, so the near cascade spans 204 m instead
of 150 m and its texels are ~26% coarser: 1.40/255 mean and 3.0% of pixels past a threshold of 8,
against a 0.15/0.24% noise floor. `medium` has always shipped three.

---

## Still open: per-cascade caster culling (core / CSM)

The measurement above says where the remaining triangles are, and the fix is core-owned so it is
left as a request rather than done. Shadow-caster cost at `civic`, by group, measured by clearing
`castShadow` on each group in turn:

| caster | triangles | draw calls |
|---|---|---|
| roads | 1.145 M | 96 |
| terrain-chunks | 0.876 M | 96 |
| service-buildings | 0.491 M | 136 |
| demo | 0.214 M | 88 |
| props / traffic / vegetation | 0.089 / 0.053 / 0.046 M | 25 / 20 / 80 |
| **all casters** | **4.058 M** | **722** |

Every caster is submitted to every cascade it touches, whatever its screen size. The standard fix is
a **per-cascade caster filter** — skip small objects in the distant cascades, where their shadow is
sub-texel anyway. Street furniture, vehicles and vegetation are the obvious candidates; they are
cheap individually but there are thousands of them. That needs a size/importance test inside the CSM
cascade loop in `Engine.js`, which is core, and it is the only lever left that could pay for the
fourth cascade.

Two levers were measured and are **not** worth anyone's time:

* **Road station density.** `RoadMesher.stations()` subdivides on a 2 cm vertical chord tolerance,
  which looks extravagant. Loosening it 7.5× to 15 cm changed the frame by **0.01 M**: curvature and
  the 8 m max step set the spacing, not terrain. Left alone.
* **Material atlasing across shader families.** ≈ −65 draw calls and zero triangles — the 51 live
  building pools span 21 distinct shader programs, so only 12 can ever merge.
