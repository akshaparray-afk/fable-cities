import * as THREE from 'three';
import { clamp, damp, dampAngle, DEG2RAD } from '../shared/math.js';

/**
 * Cities: Skylines style orbit camera.
 *  - WASD / arrows: pan (speed scales with zoom)   - Q/E: rotate   - R/F: tilt
 *  - Middle drag (or Alt+left drag): grab-the-ground pan    - Right drag: rotate/tilt
 *  - Wheel: zoom towards cursor                              - Home: reset
 *
 * Touch (a phone has neither WASD nor a middle button, so without this the camera cannot move
 * at all — measured: a one-finger drag moved the camera 0.00 m):
 *  - One finger: grab-the-ground pan, but only while no build tool is armed, so it never fights
 *    a tool that reads the same drag ("drag across the ground to lay it").
 *  - Two fingers: pinch to zoom, twist to rotate, slide to pan. Always available, so the camera
 *    is reachable even with a tool armed.
 */
export class CameraController {
  constructor(camera, input, world, canvas) {
    this.camera = camera;
    this.input = input;
    this.world = world;
    this.canvas = canvas;
    this.enabled = true;

    this.target = new THREE.Vector3(0, 0, 0);
    this.distance = 450;
    this.yaw = 30 * DEG2RAD;
    this.pitch = 42 * DEG2RAD;
    this.desired = { target: this.target.clone(), distance: this.distance, yaw: this.yaw, pitch: this.pitch };

    this.minDistance = 4;
    this.maxDistance = 3200;
    this.minPitch = 6 * DEG2RAD;
    this.maxPitch = 88 * DEG2RAD;
    this.smoothing = 12;
    this.panSpeed = 1.1; // fraction of distance per second
    this.rotateSpeed = 0.0045;
    this.zoomSpeed = 0.0011;
    this.pinchZoomSpeed = 0.007; // per px of finger separation
    this.touchRotateSpeed = 1.0; // twist is already radians
    this.minHeightAboveGround = 1.8;

    this._raycaster = new THREE.Raycaster();
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._panStart = new THREE.Vector3();
    this._panning = false;
    this._forward = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this.updateCameraTransform(true);
  }

  /** Immediately or smoothly move to a view: { target:{x,y,z}, distance, yaw (rad), pitch (rad) } */
  setView(view, immediate = false) {
    if (view.target) this.desired.target.set(view.target.x ?? this.desired.target.x, view.target.y ?? 0, view.target.z ?? this.desired.target.z);
    if (view.distance != null) this.desired.distance = clamp(view.distance, this.minDistance, this.maxDistance);
    if (view.yaw != null) this.desired.yaw = view.yaw;
    if (view.pitch != null) this.desired.pitch = clamp(view.pitch, this.minPitch, this.maxPitch);
    if (immediate) {
      this.target.copy(this.desired.target);
      this.distance = this.desired.distance;
      this.yaw = this.desired.yaw;
      this.pitch = this.desired.pitch;
      this.updateCameraTransform(true);
    }
  }

  getView() {
    return { target: this.target.clone(), distance: this.distance, yaw: this.yaw, pitch: this.pitch };
  }

  /** Project the pointer onto the terrain. */
  pointerToGround(ndc, out) {
    this._raycaster.setFromCamera(ndc, this.camera);
    return this.world.terrain.raycast(this._raycaster.ray, out);
  }

  /**
   * Pan by a screen-space delta in pixels. Two-finger drag has no single pointer to ray-cast
   * through, so convert pixels to metres at the target plane instead of grabbing the ground.
   * Vertical pixels cover more ground the flatter the camera sits, hence the sin(pitch) term.
   */
  _panByPixels(dx, dy, d) {
    const h = Math.max(1, this.canvas ? this.canvas.clientHeight : 1000);
    const mpp = (2 * this.distance * Math.tan((this.camera.fov * DEG2RAD) / 2)) / h;
    const yaw = this.yaw;
    this._forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    this._right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    const mx = -dx * mpp;
    const mz = dy * mpp / clamp(Math.sin(this.pitch), 0.35, 1);
    d.target.addScaledVector(this._right, mx);
    d.target.addScaledVector(this._forward, mz);
    this.target.addScaledVector(this._right, mx);   // immediate, for 1:1 feel
    this.target.addScaledVector(this._forward, mz);
  }

  update(dt) {
    const input = this.input;
    const d = this.desired;

    // Pointer → ground every frame (used by tools as well)
    input.groundValid = this.pointerToGround(input.ndc, input.ground);

    if (this.enabled && !input.pointerOverUI) {
      // --- keyboard pan ---
      const yaw = this.yaw;
      this._forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
      this._right.set(Math.cos(yaw), 0, -Math.sin(yaw));
      const speed = this.panSpeed * this.distance * dt * (input.shift ? 2.2 : 1);
      let mx = 0, mz = 0;
      if (input.isDown('w') || input.isDown('ArrowUp')) mz += 1;
      if (input.isDown('s') || input.isDown('ArrowDown')) mz -= 1;
      if (input.isDown('a') || input.isDown('ArrowLeft')) mx -= 1;
      if (input.isDown('d') || input.isDown('ArrowRight')) mx += 1;
      if (mx || mz) {
        const len = Math.hypot(mx, mz);
        d.target.addScaledVector(this._forward, (mz / len) * speed);
        d.target.addScaledVector(this._right, (mx / len) * speed);
      }
      if (input.isDown('q')) d.yaw += 1.6 * dt;
      if (input.isDown('e')) d.yaw -= 1.6 * dt;
      // Tilt: T/G always, R/F unless a tool claimed them (input.claimKey('r') — CS2 uses R to rotate a ghost).
      if (input.isDown('r') || input.isHeld('t')) d.pitch += 1.0 * dt;
      if (input.isDown('f') || input.isHeld('g')) d.pitch -= 1.0 * dt;
      if (input.justPressed('Home')) this.setView({ target: { x: 0, y: 0, z: 0 }, distance: 450, yaw: 30 * DEG2RAD, pitch: 42 * DEG2RAD });

      // --- mouse / touch ---
      const drag = input.drag;
      // A build tool reads the same one-finger drag it would use to draw, so one-finger pan is
      // only offered when nothing is armed. Two fingers always reach the camera (below).
      const tool = this.world.tool && this.world.tool.active;
      // 'info' paints an overlay and consumes no drag, so it must not cost the player their pan.
      // Kept identical to the list in src/modules/ui/index.js — the two have to agree.
      const toolArmed = !!tool && tool !== 'select' && tool !== 'info';
      const touchPan = !!drag && drag.pointerType === 'touch' && input.touchCount === 1 && !toolArmed;
      const panDrag = drag && (drag.button === 1 || (drag.button === 0 && input.alt) || touchPan);
      const rotDrag = drag && drag.button === 2 && drag.pointerType !== 'touch';
      if (panDrag) {
        if (!this._panning) {
          this._panning = true;
          this._panStart.copy(drag.startGroundValid ? drag.startGround : d.target);
          this._panPlaneY = this._panStart.y;
        }
        // Grab-the-ground: keep the point under the cursor fixed → intersect with horizontal plane at grab height
        this._raycaster.setFromCamera(input.ndc, this.camera);
        const ray = this._raycaster.ray;
        const t = (this._panPlaneY - ray.origin.y) / ray.direction.y;
        if (Number.isFinite(t) && t > 0 && t < 20000) {
          this._tmp.copy(ray.direction).multiplyScalar(t).add(ray.origin);
          this._tmp2.subVectors(this._panStart, this._tmp);
          this._tmp2.y = 0;
          d.target.add(this._tmp2);
          this.target.add(this._tmp2); // immediate for 1:1 feel
        }
      } else {
        this._panning = false;
      }
      if (rotDrag) {
        d.yaw -= drag.dx * this.rotateSpeed;
        d.pitch += drag.dy * this.rotateSpeed;
      }

      // --- two fingers: pinch zooms, twist rotates, a parallel slide pans ---
      if (input.touchCount === 2) {
        const spread = Math.abs(input.pinchDelta);
        const twist = Math.abs(input.twistDelta);
        const slide = Math.hypot(input.twoFingerDx, input.twoFingerDy);
        if (spread > 0.5) {
          d.distance = clamp(d.distance * Math.exp(-input.pinchDelta * this.pinchZoomSpeed), this.minDistance, this.maxDistance);
        }
        if (twist > 0.004) d.yaw -= input.twistDelta * this.touchRotateSpeed;
        // Only treat the midpoint as a pan when the fingers moved together rather than apart,
        // otherwise every pinch would drag the city as well.
        if (slide > spread && slide > 0.5) this._panByPixels(input.twoFingerDx, input.twoFingerDy, d);
      }

      // --- zoom towards cursor ---
      if (input.wheelDelta !== 0) {
        const factor = Math.exp(input.wheelDelta * this.zoomSpeed);
        const newDist = clamp(d.distance * factor, this.minDistance, this.maxDistance);
        const ratio = newDist / d.distance;
        if (input.groundValid && ratio < 1) {
          // move target towards the cursor point proportionally to how much we zoomed in
          this._tmp.subVectors(input.ground, d.target);
          this._tmp.y = 0;
          d.target.addScaledVector(this._tmp, 1 - ratio);
        }
        d.distance = newDist;
      }
    } else {
      this._panning = false;
    }

    // --- clamp & smooth ---
    d.pitch = clamp(d.pitch, this.minPitch, this.maxPitch);
    d.distance = clamp(d.distance, this.minDistance, this.maxDistance);
    this.world.clampToMap(d.target);
    d.target.y = this.world.terrain.getHeight(d.target.x, d.target.z);

    const k = this.smoothing;
    this.target.x = damp(this.target.x, d.target.x, k, dt);
    this.target.y = damp(this.target.y, d.target.y, k, dt);
    this.target.z = damp(this.target.z, d.target.z, k, dt);
    this.distance = damp(this.distance, d.distance, k, dt);
    this.yaw = dampAngle(this.yaw, d.yaw, k, dt);
    this.pitch = damp(this.pitch, d.pitch, k, dt);
    this.updateCameraTransform(false);
  }

  updateCameraTransform() {
    const cam = this.camera;
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const offX = Math.sin(this.yaw) * cp * this.distance;
    const offZ = Math.cos(this.yaw) * cp * this.distance;
    const offY = sp * this.distance;
    cam.position.set(this.target.x + offX, this.target.y + offY, this.target.z + offZ);
    // keep camera above terrain
    const groundY = this.world.terrain.getHeight(cam.position.x, cam.position.z) + this.minHeightAboveGround;
    if (cam.position.y < groundY) cam.position.y = groundY;
    cam.up.set(0, 1, 0);
    cam.lookAt(this.target);
    const near = clamp(this.distance * 0.004, 0.2, 6);
    if (Math.abs(cam.near - near) > 0.01) {
      cam.near = near;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
  }
}
