/**
 * ui module — Cities: Skylines II class HUD rendered into ctx.uiRoot.
 *
 * Emits:   tool:select (tool, options), time:speed, time:set, weather:set, city:renamed, ui:hud, infoview:changed
 * Listens: sim:tick, economy:changed, time:tick, time:set, time:speed, tool:changed, entity:selected,
 *          notification, weather:set, building:levelup, milestone, engine:resize
 * Reads:   world.economy, world.time, world.env, world.tool, world.selection, world.buildings/roads/zones/services
 *
 * The simulation module owns the clock (world.time) — the HUD only reads it.
 */
import './ui.css';
import { h } from './dom.js';
import { createTooltip } from './tooltip.js';
import { createToasts } from './toasts.js';
import { createTopBar } from './topbar.js';
import { createToolbar } from './toolbar.js';
import { createInfoPanel } from './infopanel.js';
import { createInfoView } from './infoview.js';
import { createSettings } from './settings.js';
import { createShortcuts } from './shortcuts.js';
import { createOnboarding } from './onboarding.js';
import { CATEGORIES } from './catalog.js';
import { ensureThumbDefs } from './thumbs.js';

export const name = 'ui';
/** Public API (filled in init): notify, selectTool, openCategory, select, deselect, setHudVisible, setTime, setSpeed, setWeather, hud */
export const api = {};

let hud = null;
let statTimer = 0;
/** Last COMPLETED frame's renderer.info — see the fps meter in init() for why it is sampled there. */
const lastFrameInfo = { calls: 0, triangles: 0 };

export async function init(ctx) {
  const { world, events } = ctx;
  const root = h('div.fc-hud', { role: 'application', 'aria-label': 'Fable Cities HUD' });
  ctx.uiRoot.appendChild(root);
  ensureThumbDefs(root); // shared gradients for the catalogue thumbnails

  hud = { ctx, world, events, root, visible: true };
  /** Left column: selected-entity panel and info-view legend stack here. */
  hud.leftStack = h('div.fc-left');
  root.appendChild(hud.leftStack);

  /**
   * Frame-rate meter. Off unless asked for with `?fps=1` (or `?debug=1`), so the default HUD is
   * unchanged and every screenshot in ARCHITECTURE §7 still renders exactly what it asked for.
   *
   * It reads `stats().fpsEstimate`, which is a median WALL-CLOCK interval — the rate a player
   * actually sees. It is deliberately not `cpuFrameMs`: that only times command submission and
   * over-reported this scene by 3.5x (11.5 ms / "87 fps" against a real 40.6 ms / 24.7 fps).
   * Both are shown side by side precisely so the gap is visible rather than hidden.
   */
  hud.fpsMeter = null;
  if (ctx.config && (ctx.config.get('fps') === '1' || ctx.config.debug)) {
    hud.fpsMeter = h('div.fc-fps', { 'aria-hidden': 'true' });
    root.appendChild(hud.fpsMeter);
    /**
     * Draw calls and triangles have to be sampled AFTER the render, not in `update()`.
     * `Engine._tick` calls `renderer.info.reset()` before the update callbacks run, so a module
     * reading `stats()` from `update()` sees a counter that was cleared microseconds earlier — it
     * reported "1 draws / 0.00 M tris" until this hook existed. The frame rate fields are fine
     * either way; only the renderer.info counters are affected.
     */
    // NB `onAfterRender` has no unsubscribe, so this callback outlives dispose() — it must never
    // touch `hud`, which dispose() nulls. It writes into an object captured directly instead.
    const info = lastFrameInfo;
    ctx.engine.onAfterRender(() => {
      const r = ctx.engine.renderer.info.render;
      info.calls = r.calls;
      info.triangles = r.triangles;
    });
  }

  // ---------- controller helpers used by components ----------
  hud.selectTool = (tool, options = {}) => {
    events.emit('tool:select', tool, options);
    // The bus is synchronous: if the tools module handled it, world.tool already reflects the request.
    // Otherwise (tools module missing) fulfil the contract ourselves so the HUD stays consistent.
    if (world.tool.active !== tool || !sameOptions(world.tool.options, options)) {
      world.tool.active = tool;
      world.tool.options = options;
      events.emit('tool:changed', tool, options);
    }
  };
  hud.deselect = () => {
    world.selection = null;
    hud.info.hide();
    events.emit('entity:selected', null);
  };
  hud.setSpeed = (s) => {
    s = Math.max(0, Math.min(3, Math.round(s)));
    const simApi = world.simulation && world.simulation.api;
    if (simApi && typeof simApi.setSpeed === 'function') simApi.setSpeed(s);
    else { world.time.speed = s; world.time.paused = s === 0; events.emit('time:speed', s); }
    hud.top.refreshTime();
  };
  hud.setTime = (hour) => {
    world.time.hour = ((hour % 24) + 24) % 24;
    events.emit('time:set', world.time.hour);
    hud.top.refreshTime();
    hud.settings.refresh();
  };
  hud.setWeather = (w) => {
    world.env.weather = w;
    events.emit('weather:set', w);
    hud.settings.refresh();
  };
  hud.setHudVisible = (v) => {
    hud.visible = !!v;
    root.classList.toggle('is-hidden', !hud.visible);
    events.emit('ui:hud', hud.visible);
  };
  hud.focusOn = ({ x, z, size = 40 }) => {
    ctx.cameraController.setView({ target: { x, z }, distance: Math.max(45, size * 2.6), pitch: 0.42 }, false);
  };
  hud.escape = () => {
    hud.tooltip.pin(null);
    if (hud.shortcuts.isOpen) return hud.shortcuts.close();
    if (hud.settings.isOpen) return hud.settings.close();
    if (hud.toasts.centre.isOpen) return hud.toasts.centre.close();
    if (world.tool.active !== 'select') { hud.toolbar.closeTray(); return hud.selectTool('select', {}); }
    if (hud.toolbar.openId) return hud.toolbar.closeTray();
    if (hud.info.isOpen) return hud.deselect();
  };

  // ---------- components ----------
  hud.tooltip = createTooltip(hud);
  hud.toasts = createToasts(hud);
  hud.top = createTopBar(hud);
  hud.toolbar = createToolbar(hud);
  hud.info = createInfoPanel(hud);
  hud.infoview = createInfoView(hud);
  hud.settings = createSettings(hud);
  hud.shortcuts = createShortcuts(hud);
  hud.onboarding = createOnboarding(hud); // after top + toolbar: it rings their buttons

  // Input class on the root so touch-only devices lose keyboard-only affordances instead of showing
  // them broken, and so the phone layout can key off one flag rather than a width guess everywhere.
  applyInputMode(root);

  // ---------- events ----------
  const refreshStats = () => { hud.top.refreshStats(); hud.toolbar.refreshDemand(); if (hud.info.isOpen) hud.info.refresh(); if (hud.infoview.isOpen) hud.infoview.refresh(); };
  events.on('sim:tick', refreshStats);
  events.on('economy:changed', refreshStats);
  events.on('milestone', refreshStats);
  events.on('time:tick', () => hud.top.refreshTime());
  events.on('time:set', () => { hud.top.refreshTime(); hud.settings.refresh(); });
  events.on('time:speed', () => hud.top.refreshTime());
  events.on('tool:changed', (tool, options) => {
    hud.toolbar.onToolChanged(tool, options);
    if (tool === 'info' && options && options.view) hud.infoview.show(options.view);
    else hud.infoview.hide();
  });
  events.on('entity:selected', (sel) => {
    if (sel == null) { hud.info.hide(); return; }
    hud.info.show(sel);
  });
  events.on('notification', (a, b, c) => {
    const n = typeof a === 'string' ? { kind: a, title: b, text: c } : a;
    hud.toasts.push(n);
  });
  events.on('building:levelup', (b) => {
    if (b && hud.info.isOpen && hud.info.current && hud.info.current.entity === b) hud.info.refresh();
  });
  events.on('engine:resize', () => { hud.tooltip.reposition(); applyInputMode(root); });

  window.addEventListener('resize', () => applyInputMode(root));
  window.addEventListener('orientationchange', () => setTimeout(() => applyInputMode(root), 60));

  // ---------- keyboard shortcuts (keydown so modifiers are exact; camera keys stay in core Input) ----------
  window.addEventListener('keydown', (e) => {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
    const code = e.code || e.key;
    let handled = true;
    switch (code) {
      case 'Escape': hud.escape(); break;
      case 'Space': hud.setSpeed(world.time.speed === 0 || world.time.paused ? 1 : 0); break;
      case 'Equal': case 'NumpadAdd': hud.setSpeed(Math.min(3, (world.time.speed || 0) + 1)); break;
      case 'Minus': case 'NumpadSubtract': hud.setSpeed(Math.max(0, (world.time.speed || 0) - 1)); break;
      case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4': case 'Digit5': {
        const i = +code.slice(5);
        if (e.shiftKey) { if (i <= 3) hud.setSpeed(i); else handled = false; }
        else hud.toolbar.toggleCategory(CATEGORIES[i - 1].id);
        break;
      }
      case 'Tab': if (hud.toolbar.openId || hud.toolbar.reopen()) hud.toolbar.cycleItem(e.shiftKey ? -1 : 1); else handled = false; break;
      case 'KeyH': hud.setHudVisible(!hud.visible); break;
      case 'KeyO': hud.settings.toggle(); break;
      case 'KeyN': hud.toasts.centre.toggle(); break;
      case 'F1': hud.shortcuts.toggle(); break;
      case 'Slash': if (e.shiftKey) hud.shortcuts.toggle(); else handled = false; break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  });

  /**
   * Build tools read their clicks from the canvas, and the HUD sits on top of it, so a click that
   * lands on a panel while a tool is armed does nothing at all — no ghost, no refusal, no sound.
   * The player reads that silence as a broken tool, and so does a machine: two scripted playtests
   * filed it as a blocker ("a second road is never built", "bulldoze removes nothing") when in
   * both cases the click had simply hit the interface. Roughly an eighth of the viewport behaves
   * this way, and a sixth with a tray open.
   *
   * Say so. Real controls are left alone — this only fires on the inert parts of a panel, and at
   * most once every few seconds so it can never become a stream.
   */
  let lastBlockedHint = 0;
  root.addEventListener('pointerdown', (e) => {
    const tool = world.tool && world.tool.active;
    if (!tool || tool === 'select' || tool === 'info') return;
    if (e.button !== 0) return;
    /**
     * Anything a click already means something on is not a swallowed click. A tag whitelist is not
     * enough: `.fc-toast` is a div you click to dismiss, so dismissing this very hint used to spawn
     * another one. Anything carrying an ARIA role is interactive by definition, and the panels the
     * player can act on are listed by class.
     */
    if (e.target.closest && e.target.closest(
      'button, a, input, select, textarea, [contenteditable="true"], [role], '
      + '.fc-toast, .fc-item, .fc-cat, .fc-onb, .fc-notif, .fc-settings, .fc-shortcuts',
    )) return;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (now - lastBlockedHint < 4000) return;
    lastBlockedHint = now;
    if (hud.toasts) hud.toasts.push({ kind: 'info', title: 'Nothing was built there', text: 'That click landed on the interface, not the map. Aim at the ground to build.', life: 3400 });
  });

  // ---------- initial state ----------
  if (world.tool && world.tool.active && world.tool.active !== 'select') {
    hud.toolbar.onToolChanged(world.tool.active, world.tool.options);
    if (world.tool.active === 'info' && world.tool.options && world.tool.options.view) hud.infoview.show(world.tool.options.view);
  }
  if (world.selection) hud.info.show(world.selection);

  Object.assign(api, {
    hud,
    notify: (n) => hud.toasts.push(typeof n === 'string' ? { kind: 'info', title: n } : n),
    selectTool: hud.selectTool,
    openCategory: (id) => hud.toolbar.openCategory(id),
    closeTray: () => hud.toolbar.closeTray(),
    select: (sel) => hud.info.show(sel),
    deselect: hud.deselect,
    setHudVisible: hud.setHudVisible,
    setTime: hud.setTime,
    setSpeed: hud.setSpeed,
    setWeather: hud.setWeather,
    openSettings: () => hud.settings.open(),
    openNotifications: () => hud.toasts.centre.open(),
    openShortcuts: () => hud.shortcuts.open(),
    onboarding: hud.onboarding,
    pinTooltip: (el, content) => hud.tooltip.pin(el, content),
    refresh: () => { refreshStats(); hud.top.refreshTime(); },
    categories: CATEGORIES,
  });
}

export function update(dt) {
  if (!hud) return;
  // per-frame HUD updates (cheap: only touches DOM when text changes)
  hud.top.refreshTime();
  hud.tooltip.tick();
  hud.onboarding.tick(dt);
  statTimer += dt;
  if (statTimer > 0.5) {
    statTimer = 0;
    hud.top.refreshStats(); hud.toolbar.refreshDemand();
    if (hud.fpsMeter) {
      const st = hud.ctx.engine.stats();
      const cls = st.fpsEstimate >= 50 ? ' is-good' : st.fpsEstimate >= 30 ? ' is-ok' : ' is-low';
      hud.fpsMeter.className = 'fc-fps' + cls;
      hud.fpsMeter.textContent =
        `${st.fpsEstimate.toFixed(1)} fps   ${st.wallFrameMs.toFixed(1)} ms/frame`
        + `\ncpu ${st.cpuFrameMs.toFixed(1)} ms (submit only)`
        + `\n${lastFrameInfo.calls} draws   ${(lastFrameInfo.triangles / 1e6).toFixed(2)} M tris`
        + `\n${st.quality} @ ${st.size[0]}x${st.size[1]}`;
    }
    if (hud.settings.isOpen) hud.settings.refresh();
    if (hud.infoview.isOpen) hud.infoview.refresh();
    // left column: fade the bottom edge only while it actually scrolls (legend + selection taller than the space above the tray)
    const ls = hud.leftStack;
    ls.classList.toggle('is-overflow', ls.scrollHeight > ls.clientHeight + 1);
  }
}

export function dispose() {
  if (hud) hud.root.remove();
  hud = null;
}

// ---------- helpers ----------
function sameOptions(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.type === b.type && a.view === b.view;
}
function isTyping(t) {
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}
/**
 * `is-touch` when the primary pointer cannot hover (phones, tablets) — hover tooltips and the keyboard
 * strip are dead weight there and are hidden by CSS. `is-phone` is the narrow-portrait layout switch;
 * it is a viewport question, so it is recomputed on resize/rotate.
 */
function applyInputMode(root) {
  const mq = (q) => (typeof matchMedia === 'function' ? matchMedia(q).matches : false);
  // "(hover: none) and (pointer: coarse)" is the PRIMARY pointer, so a Windows laptop with a touchscreen
  // and a mouse stays on the desktop HUD and keeps its hover tooltips. maxTouchPoints alone would not.
  const touch = mq('(hover: none) and (pointer: coarse)') || (mq('(pointer: coarse)') && !mq('(hover: hover)'));
  root.classList.toggle('is-touch', !!touch);
  root.classList.toggle('is-phone', window.innerWidth <= 760 || (touch && window.innerHeight <= 560));
}
