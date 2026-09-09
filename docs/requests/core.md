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
