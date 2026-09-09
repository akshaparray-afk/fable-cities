import * as THREE from 'three';

/** Pointer / keyboard state, polled once per frame. */
export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.justPressedKeys = new Set();
    this.justReleasedKeys = new Set();
    this.pointer = new THREE.Vector2(0, 0); // pixels
    this.ndc = new THREE.Vector2(0, 0);
    this.buttons = 0;
    this.justPressedButtons = new Set();
    this.justReleasedButtons = new Set();
    this._wheelAccum = 0;
    this.wheelDelta = 0;
    this.pointerOverUI = false;
    this.pointerInside = true;
    this.drag = null; // { button, startX, startY, x, y, dx, dy, totalDx, totalDy, overUIAtDown, target }
    /** Live pointers by pointerId — the only way to see a second finger, since `drag` is single. */
    this.pointers = new Map(); // id -> { x, y, type }
    /** Touch contacts down this frame. 1 = drag-to-pan, 2 = pinch/twist. */
    this.touchCount = 0;
    /** Two-finger gesture deltas, accumulated per frame and cleared in endFrame(). */
    this.pinchDelta = 0;  // px change in the distance between the two fingers
    this.twistDelta = 0;  // radians change in the angle between them
    this.twoFingerDx = 0; // px the midpoint moved horizontally (two-finger pan)
    this.twoFingerDy = 0; // px the midpoint moved vertically
    this._gesture = null; // { dist, angle, midX, midY } from the previous move
    /** Keys claimed by a module — CameraController and other consumers skip them.
     *  Call input.claimKey('r') every frame while your tool wants the key; a claim stays live
     *  until the frame after the last call, so it survives the camera update at the top of the
     *  next frame (modules update after the camera). */
    this._claimed = new Map();
    this._frame = 0;
    this.dragThreshold = 4;
    this.enabled = true;
    /** World position under the pointer (set each frame by CameraController via terrain raycast). */
    this.ground = new THREE.Vector3();
    this.groundValid = false;
    this.shift = false;
    this.ctrl = false;
    this.alt = false;
    this._bind();
  }

  _bind() {
    const c = this.canvas;
    window.addEventListener('keydown', (e) => {
      if (isTypingTarget(e.target)) return;
      const k = normKey(e);
      if (!this.keys.has(k)) this.justPressedKeys.add(k);
      this.keys.add(k);
      this.shift = e.shiftKey; this.ctrl = e.ctrlKey || e.metaKey; this.alt = e.altKey;
      if (['Space'].includes(e.code) && e.target === document.body) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      const k = normKey(e);
      this.keys.delete(k);
      this.justReleasedKeys.add(k);
      this.shift = e.shiftKey; this.ctrl = e.ctrlKey || e.metaKey; this.alt = e.altKey;
    });
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('pointermove', (e) => {
      this.pointerOverUI = e.target !== c;
      if (this.pointers.has(e.pointerId)) {
        const p = this.pointers.get(e.pointerId);
        p.x = e.clientX; p.y = e.clientY;
        this._updateGesture();
      }
      // With two fingers down the "pointer" would jitter between them; keep the ray on the first.
      if (this.touchCount < 2) this._setPointer(e.clientX, e.clientY);
      // only the pointer that owns the drag may move it — otherwise a second finger drives it
      if (this.drag && e.pointerId === this.drag.pointerId) {
        this.drag.dx += e.clientX - this.drag.x;
        this.drag.dy += e.clientY - this.drag.y;
        this.drag.x = e.clientX; this.drag.y = e.clientY;
        this.drag.totalDx = e.clientX - this.drag.startX;
        this.drag.totalDy = e.clientY - this.drag.startY;
        if (!this.drag.active && Math.hypot(this.drag.totalDx, this.drag.totalDy) > this.dragThreshold) this.drag.active = true;
      }
    });
    c.addEventListener('pointerdown', (e) => {
      c.focus();
      this.pointerOverUI = false;
      this._setPointer(e.clientX, e.clientY);
      this.buttons = e.buttons;
      this.justPressedButtons.add(e.button);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
      this._refreshTouchCount();
      /**
       * A drag belongs to the pointer that started it. Without this a second finger overwrote the
       * first finger's drag, and since every touch reports button 0, whichever finger lifted first
       * then ended it — so a pinch left the survivor dragging nothing and tools saw a drag end they
       * never earned. A mouse keeps ONE pointerId across its buttons, so pressing a second mouse
       * button still replaces the drag exactly as it did before.
       */
      const live = this.drag;
      const ownerGone = live && !this.pointers.has(live.pointerId);
      if (!live || live.pointerId === e.pointerId || ownerGone) {
        this.drag = { pointerId: e.pointerId, button: e.button, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, dx: 0, dy: 0, totalDx: 0, totalDy: 0, active: false, startGround: this.ground.clone(), startGroundValid: this.groundValid, target: e.target, overUIAtDown: false, synthetic: !!e.__synthetic, pointerType: e.pointerType || 'mouse' };
      }
      try { c.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    });
    window.addEventListener('pointercancel', (e) => {
      this.buttons = e.buttons;
      this.pointers.delete(e.pointerId);
      this._refreshTouchCount();
      // pointercancel REPLACES pointerup — no up follows — so the drag has to be torn down here
      // too, or it stays live for ever and keeps accumulating movement. It is dropped WITHOUT
      // publishing an endedDrag: a cancelled gesture must not commit whatever a tool was staging.
      if (this.drag && e.pointerId === this.drag.pointerId) this.drag = null;
    });
    window.addEventListener('pointerup', (e) => {
      this.buttons = e.buttons;
      this.justReleasedButtons.add(e.button);
      this.pointers.delete(e.pointerId);
      this._refreshTouchCount();
      if (this.drag && e.pointerId === this.drag.pointerId && this.drag.button === e.button) {
        this.drag.ended = true;
        this._endedDrag = this.drag;
        this.drag = null;
      }
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const scale = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
      this._wheelAccum += e.deltaY * scale;
    }, { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerenter', () => (this.pointerInside = true));
    c.addEventListener('pointerleave', () => (this.pointerInside = false));
  }

  _setPointer(x, y) {
    this.pointer.set(x, y);
    const r = this.canvas.getBoundingClientRect();
    this.ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
  }

  /** Touch contacts currently down. Mouse and pen never count towards a pinch. */
  _refreshTouchCount() {
    let n = 0;
    for (const p of this.pointers.values()) if (p.type === 'touch') n++;
    this.touchCount = n;
    if (n !== 2) this._gesture = null;
  }

  /**
   * Accumulate this frame's two-finger pinch (spread), twist (rotation) and vertical drag.
   * Deltas are relative to the previous move event, so they stay correct however fast the
   * fingers travel, and are consumed and cleared once per frame by the camera.
   */
  _updateGesture() {
    if (this.touchCount !== 2) return;
    const t = [];
    for (const p of this.pointers.values()) if (p.type === 'touch') t.push(p);
    if (t.length !== 2) return;
    const dx = t[1].x - t[0].x, dy = t[1].y - t[0].y;
    const dist = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);
    const midX = (t[0].x + t[1].x) / 2;
    const midY = (t[0].y + t[1].y) / 2;
    if (this._gesture) {
      this.pinchDelta += dist - this._gesture.dist;
      // shortest signed angular difference, so the ±π wrap never spins the camera
      let da = angle - this._gesture.angle;
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      this.twistDelta += da;
      this.twoFingerDx += midX - this._gesture.midX;
      this.twoFingerDy += midY - this._gesture.midY;
    }
    this._gesture = { dist, angle, midX, midY };
  }

  /** Call at the start of every frame. */
  beginFrame() {
    this._frame++;
    for (const [k, f] of this._claimed) if (this._frame - f > 1) this._claimed.delete(k);
    this.wheelDelta = this._wheelAccum;
    this._wheelAccum = 0;
    this.endedDrag = this._endedDrag || null;
    this._endedDrag = null;
  }
  /** Call at the end of every frame. */
  endFrame() {
    this.justPressedKeys.clear();
    this.justReleasedKeys.clear();
    this.justPressedButtons.clear();
    this.justReleasedButtons.clear();
    this.pinchDelta = 0;
    this.twistDelta = 0;
    this.twoFingerDx = 0;
    this.twoFingerDy = 0;
    if (this.drag) { this.drag.dx = 0; this.drag.dy = 0; }
  }

  /**
   * Claim a key so lower-priority consumers (the camera) ignore it. Call once per frame while
   * the claim should hold (e.g. a placement tool taking `R` to rotate its ghost). Returns true.
   */
  claimKey(key) {
    this._claimed.set(key, this._frame);
    return true;
  }
  releaseKey(key) { this._claimed.delete(key); }
  /** True while `key` is claimed by a module (this frame or the previous one). */
  isClaimed(key) {
    const f = this._claimed.get(key);
    return f !== undefined && this._frame - f <= 1;
  }

  /**
   * Synthesise a pointer click at NDC coordinates (x, y ∈ [-1, 1]) — used by tools and the
   * screenshot harness to drive the game headlessly. Dispatches real pointer/mouse events on
   * the canvas so every module sees them through its normal path.
   */
  injectClick(ndc, button = 0) {
    const r = this.canvas.getBoundingClientRect();
    const clientX = r.left + ((ndc.x + 1) / 2) * r.width;
    const clientY = r.top + ((1 - ndc.y) / 2) * r.height;
    const opts = { clientX, clientY, button, buttons: 1 << (button === 1 ? 2 : button === 2 ? 1 : 0), bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse' };
    const mk = (type, o) => { const ev = new PointerEvent(type, o); ev.__synthetic = true; return ev; };
    this.canvas.dispatchEvent(mk('pointermove', { ...opts, buttons: 0 }));
    this.canvas.dispatchEvent(mk('pointerdown', opts));
    window.dispatchEvent(mk('pointerup', { ...opts, buttons: 0 }));
    return { clientX, clientY };
  }

  isDown(key) { return !this.isClaimed(key) && this.keys.has(key); }
  /** Raw key state, ignoring claims — use this in the module that made the claim. */
  isHeld(key) { return this.keys.has(key); }
  justPressedRaw(key) { return this.justPressedKeys.has(key); }
  justPressed(key) { return !this.isClaimed(key) && this.justPressedKeys.has(key); }
  justReleased(key) { return this.justReleasedKeys.has(key); }
  buttonDown(b) { return (this.buttons & (1 << (b === 1 ? 2 : b === 2 ? 1 : 0))) !== 0; }
  buttonJustPressed(b) { return this.justPressedButtons.has(b); }
  buttonJustReleased(b) { return this.justReleasedButtons.has(b); }
}

function normKey(e) {
  if (e.code && e.code.startsWith('Key')) return e.code.slice(3).toLowerCase();
  if (e.code && e.code.startsWith('Digit')) return e.code.slice(5);
  return e.code || e.key;
}
function isTypingTarget(t) {
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}
