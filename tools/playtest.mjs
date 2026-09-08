#!/usr/bin/env node
/**
 * tools/playtest.mjs — first-time-player audit.
 *
 * Drives the REAL game in headless Chrome exactly the way a stranger would: start screen → new city →
 * pick the road tool from the HUD → draw roads with the mouse → zone → run time → place a service →
 * bulldoze → Esc → then the demo-city path. Every step screenshots into shots/playtest/ and records
 * what actually happened, including the in-game notifications and uncaught errors it provoked, so a
 * step that silently does nothing can be attributed to a module.
 *
 *   node tools/playtest.mjs [--url http://127.0.0.1:5180/?menu=1&seed=7] [--out shots/playtest]
 *                           [--grow 300] [--grow2 240] [--default-window 125] [--w 1600] [--h 1000] [--skip-demo]
 *
 * Writes shots/playtest/report.json. Adds no production code — it only clicks.
 */
import puppeteer from 'puppeteer-core';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import fs from 'node:fs';
import path from 'node:path';

/** Resolve a Chrome/Chromium binary across platforms; override with CHROME_PATH. */
function resolveChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const fs = require('node:fs');
  const candidates = process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ] : process.platform === 'win32' ? [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ] : [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch (_) { /* ignore */ } }
  throw new Error('No Chrome/Chromium found. Install Google Chrome or set CHROME_PATH to its executable.');
}


const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);
const CHROME = resolveChrome();
const URL_NEW = flag('url', 'http://127.0.0.1:5180/?menu=1&seed=7');
const OUT = path.resolve(flag('out', 'shots/playtest'));
const GROW = +flag('grow', 300);
const DEFAULT_WINDOW = +flag('default-window', 125); // seconds left running at the DEFAULT speed before ramping up
const W = +flag('w', 1600), H = +flag('h', 1000);

fs.mkdirSync(OUT, { recursive: true });

const steps = [];
const logs = [];
let shotN = 0;
const rel = (p) => path.relative(process.cwd(), p);

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio', '--enable-unsafe-swiftshader', '--hide-scrollbars'],
});
const page = await browser.newPage();
// Six builders edit this repo at once. Vite's HMR client would full-reload the page mid-audit and
// silently reset the city, so serve a no-op stub in its place: the game itself is untouched.
await page.setRequestInterception(true);
page.on('request', (r) => {
  if (r.url().includes('/@vite/client')) {
    return r.respond({ status: 200, contentType: 'text/javascript', body:
      'export const createHotContext=()=>({on(){},off(){},send(){},accept(){},acceptExports(){},dispose(){},prune(){},invalidate(){},decline(){},data:{}});'
      + 'export const updateStyle=(id,c)=>{let e=document.querySelector(`style[data-vite-dev-id="${id}"]`);if(!e){e=document.createElement("style");e.setAttribute("type","text/css");e.setAttribute("data-vite-dev-id",id);document.head.appendChild(e);}e.textContent=c;};'
      + 'export const removeStyle=(id)=>{const e=document.querySelector(`style[data-vite-dev-id="${id}"]`);if(e)e.remove();};'
      + 'export const injectQuery=(u)=>u; export class ErrorOverlay extends HTMLElement{constructor(){super();}}' });
  }
  return r.continue();
});
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push({ type: m.type(), text: m.text().slice(0, 400) }); });
page.on('pageerror', (e) => logs.push({ type: 'pageerror', text: String(e && e.message || e).slice(0, 200), stack: String(e && e.stack || '').slice(0, 700) }));
page.on('requestfailed', (r) => logs.push({ type: 'requestfailed', text: `${r.url()} ${r.failure()?.errorText || ''}`.slice(0, 300) }));

// ---------------------------------------------------------------- helpers
const shot = async (name) => {
  const file = path.join(OUT, `${String(++shotN).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file });
  return rel(file);
};
const record = (step, action, observed, shotFile = null, verdict = 'ok') => {
  steps.push({ step, action, observed, shot: shotFile, verdict });
  const mark = verdict === 'blocker' ? 'BLOCK' : verdict === 'friction' ? 'FRICT' : ' ok  ';
  console.log(`[${mark}] ${step}: ${action}\n         → ${typeof observed === 'string' ? observed : JSON.stringify(observed)}${shotFile ? `\n         → ${shotFile}` : ''}`);
};
const frames = (n = 6) => page.evaluate((f) => window.__game.waitStable(f), n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Hook the event bus so a "silent" step can be attributed: notifications + uncaught errors. */
const installProbe = () => page.evaluate(() => {
  if (window.__pt) return;
  window.__pt = { notes: [], errs: [] };
  window.__game.events.on('notification', (a, b, c) => window.__pt.notes.push(typeof a === 'string' ? { kind: a, title: b, text: c } : a));
  window.addEventListener('error', (e) => window.__pt.errs.push({ msg: String(e.message), stack: String((e.error && e.error.stack) || '').slice(0, 500) }));
  window.addEventListener('unhandledrejection', (e) => window.__pt.errs.push({ msg: 'unhandled: ' + String((e.reason && e.reason.message) || e.reason), stack: String((e.reason && e.reason.stack) || '').slice(0, 500) }));
});
const drain = () => page.evaluate(() => { const p = window.__pt || { notes: [], errs: [] }; const out = { notes: p.notes.slice(), errs: p.errs.slice() }; p.notes.length = 0; p.errs.length = 0; return out; });

/** The start screen was rewritten mid-audit; support both markups. */
const SEL = {
  root: '.fm-root, .menu-root', panel: '.fm-root .fm-panel, .menu-root .menu-panel',
  seed: '#fm-seed, #menu-seed', name: '#fm-name, #menu-name',
  newBtn: '#fm-new, #menu-new', demoBtn: '#fm-demo, #menu-demo',
  title: '#fm-title, #menu-title', choice: '.fm-choice, .menu-choice', reroll: '#fm-reroll, #menu-reroll',
};
/** Six builders share this dev server: a Vite reload mid-run would silently reset the city. */
const RUN_ID = 'pt' + Date.now();
const markRun = () => page.evaluate((id) => { window.__ptRun = id; }, RUN_ID);
const reloaded = async () => (await page.evaluate(() => window.__ptRun || null)) !== RUN_ID;
const assertLive = async (where) => {
  if (await reloaded()) throw new Error(`PAGE RELOADED during "${where}" — another builder's edit triggered a Vite reload and reset the world. Re-run the audit.`);
};

const state = () => page.evaluate(() => {
  const g = window.__game, w = g.world, e = w.economy, s = g.stats();
  let junctions = 0, maxDeg = 0;
  for (const n of w.roads.nodes.values()) { const d = (n.segments || []).length; maxDeg = Math.max(maxDeg, d); if (d >= 3) junctions++; }
  return {
    ready: g.ready, seed: w.seed, cityName: e.cityName,
    money: Math.round(e.money), population: e.population, households: e.households, jobs: e.jobs,
    happiness: +(e.happiness || 0).toFixed(2),
    tool: w.tool.active, toolType: (w.tool.options || {}).type || null,
    roadSegments: w.roads.segments.size, roadNodes: w.roads.nodes.size, junctions, maxNodeDegree: maxDeg,
    zoneLots: w.zones.lots.length, buildings: w.buildings.list.length,
    built: w.buildings.list.filter((b) => b.state === 'built').length,
    maxProgress: +Math.max(0, ...w.buildings.list.map((b) => b.progress || 0)).toFixed(2),
    services: w.services.list.length,
    paused: w.time.paused, speed: w.time.speed, hour: +w.time.hour.toFixed(2), totalDays: +(w.time.totalDays || 0).toFixed(2),
    drawCalls: s.drawCalls, triangles: s.triangles,
    overlay: (w.tools && w.tools.api) ? w.tools.api.stats() : null,
  };
});

const toScreen = (x, z) => page.evaluate(([wx, wz]) => {
  const g = window.__game, T = g.THREE;
  const y = g.world.terrain.getHeight(wx, wz);
  const v = new T.Vector3(wx, y, wz).project(g.camera);
  const el = g.engine.renderer.domElement, r = el.getBoundingClientRect();
  const sx = r.left + (v.x + 1) / 2 * r.width, sy = r.top + (1 - v.y) / 2 * r.height;
  const top = document.elementFromPoint(sx, sy);
  const tag = top ? top.tagName + (top.id ? '#' + top.id : '') + (typeof top.className === 'string' && top.className ? '.' + top.className.split(' ')[0] : '') : null;
  return { x: Math.round(sx), y: Math.round(sy), inView: v.z < 1 && sx > 4 && sy > 4 && sx < r.width - 4 && sy < r.height - 4, topEl: tag, onCanvas: !!(top && top.tagName === 'CANVAS') };
}, [x, z]);

async function hover(x, z, f = 5) {
  const p = await toScreen(x, z);
  if (!p.inView) return { ...p, ok: false, why: 'off-screen' };
  await page.mouse.move(p.x, p.y, { steps: 3 });
  await frames(f);
  const p2 = await toScreen(x, z);
  return { ...p2, ok: p2.onCanvas, why: p2.onCanvas ? null : 'covered by ' + p2.topEl };
}
async function clickWorld(x, z, f = 10) {
  const p = await hover(x, z, 3);
  if (!p.ok) return p;
  await page.mouse.click(p.x, p.y);
  await frames(f);
  return p;
}
const clickSel = async (sel, f = 6) => {
  const el = await page.$(sel);
  if (!el) return false;
  await el.click();
  await frames(f);
  return true;
};
const key = async (k, f = 6) => { await page.keyboard.press(k); await frames(f); };

/** Same validity rules the road tool applies, evaluated in-page: land, in-bounds, gentle. */
const findRun = (fromX, fromZ, length = 140, maxR = 500) => page.evaluate(([fx, fz, L, R]) => {
  const w = window.__game.world, t = w.terrain;
  const ok = (ax, az, bx, bz) => {
    const n = 28, seg = Math.hypot(bx - ax, bz - az) / n;
    let prev = null, slope = 0;
    for (let i = 0; i <= n; i++) {
      const x = ax + (bx - ax) * i / n, z = az + (bz - az) * i / n;
      if (!w.inBounds(x, z) || t.isWater(x, z)) return false;
      const y = t.getHeight(x, z);
      if (prev != null) slope = Math.max(slope, Math.abs(y - prev) / seg);
      prev = y;
    }
    return slope < 0.18;
  };
  for (let r = 0; r <= R; r += 40) for (let a = 0; a < 360; a += 30) {
    const cx = fx + Math.cos(a * Math.PI / 180) * r, cz = fz + Math.sin(a * Math.PI / 180) * r;
    for (const dir of [0, 90, 45, 135]) {
      const rad = dir * Math.PI / 180;
      const A = { x: cx - Math.cos(rad) * L / 2, z: cz - Math.sin(rad) * L / 2 };
      const B = { x: cx + Math.cos(rad) * L / 2, z: cz + Math.sin(rad) * L / 2 };
      if (ok(A.x, A.z, B.x, B.z)) return { a: A, b: B, c: { x: cx, z: cz }, searchRadius: r, dir };
    }
  }
  return null;
}, [fromX, fromZ, length, maxR]);

/** A perpendicular spur that ends ON the given point, validated the same way. */
const findSpur = (cx, cz, dir, len = 100) => page.evaluate(([x0, z0, d, L]) => {
  const w = window.__game.world, t = w.terrain;
  const ok = (ax, az, bx, bz) => {
    const n = 24, seg = Math.hypot(bx - ax, bz - az) / n;
    let prev = null, slope = 0;
    for (let i = 0; i <= n; i++) {
      const x = ax + (bx - ax) * i / n, z = az + (bz - az) * i / n;
      if (!w.inBounds(x, z) || t.isWater(x, z)) return false;
      const y = t.getHeight(x, z);
      if (prev != null) slope = Math.max(slope, Math.abs(y - prev) / seg);
      prev = y;
    }
    return slope < 0.18;
  };
  for (const sign of [1, -1]) for (const l of [L, L * 0.75, L * 0.5]) {
    const rad = (d + 90 * sign) * Math.PI / 180;
    const A = { x: x0 + Math.cos(rad) * l, z: z0 + Math.sin(rad) * l };
    if (ok(A.x, A.z, x0, z0)) return { a: A, b: { x: x0, z: z0 }, length: l, sign };
  }
  return null;
}, [cx, cz, dir, len]);

// ---------------------------------------------------------------- run
const blockers = [], frictions = [];
const addBlocker = (module, description, evidence, suggestion) => blockers.push({ module, description, evidence, suggestion });
const addFriction = (module, description, suggestion) => frictions.push({ module, description, suggestion });

try {
  // ---------- 1. start screen ----------
  const t0 = Date.now();
  await page.goto(URL_NEW, { waitUntil: 'domcontentloaded', timeout: 120000 });
  let menuSeen = true;
  try { await page.waitForSelector(SEL.panel, { visible: true, timeout: 45000 }); } catch (_) { menuSeen = false; }
  const menuInfo = menuSeen ? await page.evaluate((S) => {
    const r = document.querySelector(S.root);
    return {
      title: r.querySelector(S.title)?.innerText.replace(/\n/g, ' '),
      choices: [...r.querySelectorAll(S.choice)].map((b) => b.innerText.replace(/\n/g, ' · ').slice(0, 150)),
      seedValue: r.querySelector(S.seed)?.value,
      suggestedName: r.querySelector(S.name)?.placeholder,
      hasRerollButton: !!r.querySelector(S.reroll),
      qualityPicker: !!r.querySelector('input[name="fm-quality"]'),
      explainsHowToBuild: /click a start and an end|lay the first road|road tool/i.test(r.innerText),
      controlsShown: /WASD|Right-drag|Wheel/i.test(r.innerText),
    };
  }, SEL) : null;
  record('1. start screen', `GET ${URL_NEW}, waited for .menu-root`, menuSeen ? menuInfo : 'START SCREEN NEVER APPEARED', await shot('start-screen'), menuSeen ? 'ok' : 'blocker');
  if (!menuSeen) addBlocker('menu', 'Start screen never rendered at ?menu=1', 'waitForSelector(.menu-root .menu-panel) timed out', 'Check showStartScreen() and Config.menu.');

  if (menuSeen) {
    await page.click(SEL.seed);
    await page.evaluate((S) => { document.querySelector(S.seed).value = ''; }, SEL);
    await page.keyboard.type('4242');
    await page.click(SEL.name);
    await page.keyboard.type('Auditville');
    await frames(4);
    record('1b. seed + name', 'cleared the seed box, typed 4242, typed the city name "Auditville"',
      await page.evaluate((S) => ({ seed: document.querySelector(S.seed).value, name: document.querySelector(S.name).value }), SEL), await shot('start-screen-filled'));
    await page.click(SEL.newBtn);
  }

  // ---------- 2. world loads ----------
  let loaded = true;
  try { await page.waitForFunction('window.__game && window.__game.ready === true', { timeout: 180000, polling: 250 }); } catch (_) { loaded = false; }
  await frames(30);
  await installProbe();
  await markRun();
  // the start overlay now stays up as a loading card and fades on game:ready — wait until it is gone
  try { await page.waitForFunction(`!document.querySelector('${SEL.root}')`, { timeout: 30000, polling: 200 }); } catch (_) { /* reported below */ }
  await frames(10);
  const loadMs = Date.now() - t0;
  if (!loaded) { record('2. world loads', 'clicked "New city"', 'GAME NEVER BECAME READY', await shot('new-city-failed'), 'blocker'); throw new Error('never ready'); }
  const st2 = await state();
  const world2 = await page.evaluate(() => {
    const g = window.__game, w = g.world, v = g.getCamera(), t = w.terrain;
    const tx = v.target.x, tz = v.target.z;
    let land = 0, flat = 0, n = 0;
    for (let dx = -200; dx <= 200; dx += 20) for (let dz = -200; dz <= 200; dz += 20) {
      const x = tx + dx, z = tz + dz; n++;
      if (t.isWater(x, z)) continue;
      land++;
      const h = t.getHeight(x, z);
      if (Math.max(Math.abs(t.getHeight(x + 10, z) - h), Math.abs(t.getHeight(x, z + 10) - h)) / 10 < 0.25) flat++;
    }
    const hud = document.querySelector('.fc-hud');
    return {
      camera: { target: { x: Math.round(tx), z: Math.round(tz) }, distance: Math.round(v.distance), pitchDeg: Math.round(v.pitch * 57.3) },
      targetHeight: +t.getHeight(tx, tz).toFixed(1), targetIsWater: t.isWater(tx, tz),
      landPct: Math.round(land / n * 100), buildablePct: Math.round(flat / n * 100),
      startOverlayStillCoveringTheCanvas: !!document.querySelector('.fm-root, .menu-root'),
      hudVisible: !!hud, hudTopBar: hud ? hud.innerText.split('\n').filter(Boolean).slice(0, 12).join(' | ') : null,
      onboardingToasts: [...document.querySelectorAll('.fc-toast')].map((e) => e.innerText.replace(/\n/g, ' · ')),
      modulesFailed: Object.entries(g.moduleStatus).filter(([, s]) => !s.ok).map(([k, s]) => k + ': ' + String(s.error).slice(0, 120)),
    };
  });
  record('2. world loads', `clicked "New city", waited for __game.ready (${(loadMs / 1000).toFixed(1)} s)`, { ...st2, ...world2 }, await shot('new-city-loaded'),
    world2.modulesFailed.length ? 'blocker' : 'ok');
  if (world2.modulesFailed.length) addBlocker('main', 'A module failed to initialise in a new (empty) city', world2.modulesFailed.join(' / '), 'Modules must not assume a demo city exists (ARCHITECTURE §5b).');
  if (world2.targetIsWater) addBlocker('main.js / terrain', 'A new city opens looking at open water', `camera target (${world2.camera.target.x},${world2.camera.target.z}) isWater=true`, 'Frame the opening camera on buildable land.');
  if (st2.money <= 0) addBlocker('simulation/economy', 'A new city starts with no money', `economy.money=${st2.money}`, 'Seed world.economy.money.');
  if (!world2.onboardingToasts.length && !(menuInfo && menuInfo.explainsHowToBuild)) addFriction('ui', 'Nothing in the running game tells a first-time player what to do first — no tutorial toast, no "lay your first road" prompt', 'Push one notification on game:start in an empty world.');
  if (world2.startOverlayStillCoveringTheCanvas) addBlocker('menu', 'The start overlay is still in the DOM after the world is ready and swallows clicks on the world', 'document.querySelector(".fm-root") != null after __game.ready', 'Remove the overlay (or set pointer-events:none) once game:ready fires.');

  // ---------- 3. select the road tool ----------
  await key('Digit1');
  const kb = await state();
  const trayOpen = await page.evaluate(() => !!document.querySelector('.fc-tray.is-open'));
  record('3a. road tool (keyboard)', 'pressed "1"', { tool: kb.tool, type: kb.toolType, subMenuOpened: trayOpen }, await shot('road-tool-keyboard'), kb.tool === 'road' ? 'ok' : 'blocker');
  if (kb.tool !== 'road') addBlocker('ui', 'Keyboard 1 does not select the road tool', `world.tool.active="${kb.tool}"`, 'Check ui keydown → toolbar.toggleCategory.');

  await key('Escape');
  const catOk = await clickSel('.fc-cat[aria-label="Roads"]');
  const itemOk = await clickSel('.fc-item[aria-label="Two-Lane Road"]');
  const st3 = await state();
  record('3b. road tool (HUD button)', 'clicked the Roads category, then the "Two-Lane Road" card', { categoryButton: catOk, itemCard: itemOk, tool: st3.tool, type: st3.toolType }, await shot('road-tool-hud'), st3.tool === 'road' ? 'ok' : 'blocker');
  if (!catOk || st3.tool !== 'road') addBlocker('ui/toolbar', 'The Roads HUD button does not arm the road tool', `found=${catOk} tool=${st3.tool}`, 'Check toolbar.pickItem → hud.selectTool.');

  const cam = await page.evaluate(() => window.__game.getCamera());
  const run = await findRun(cam.target.x, cam.target.z, 140, 500);
  if (!run) throw new Error('no buildable 140 m corridor within 500 m of the opening camera');
  if (run.searchRadius > 0) addFriction('terrain / main.js', `No buildable 140 m corridor at the opening camera target — the driver had to search ${run.searchRadius} m away`, 'Frame the new-city camera on flat land.');

  // ---------- 4a. ghost under the cursor ----------
  const hA = await hover(run.a.x, run.a.z, 8);
  const g0 = await state();
  record('4a. ghost under the cursor (no clicks yet)', `moved the mouse to ground (${run.a.x.toFixed(0)},${run.a.z.toFixed(0)}) → pixel ${hA.x},${hA.y}; top element ${hA.topEl}`,
    { overlayDrawCalls: g0.overlay?.draws, roadOverlay: g0.overlay?.perTool.road || null, labelChips: (g0.overlay?.draws || 0) - 2 }, await shot('road-ghost-hover'),
    (g0.overlay && g0.overlay.draws > 0) ? 'ok' : 'blocker');

  await page.mouse.click(hA.x, hA.y); await frames(6);
  const hB = await hover(run.b.x, run.b.z, 8);
  const g1 = await state();
  const ghost = g1.overlay && g1.overlay.perTool.road;
  record('4b. ghost with length + cost', 'clicked the start node, moved to the end point',
    { roadGhost_vectorVerts_fillVerts: ghost, labelChipsDrawn: (g1.overlay?.draws || 0) - 2, moneyUnchangedUntilCommit: g1.money }, await shot('road-ghost-length-cost'),
    ghost && ghost[1] > 0 ? 'ok' : 'blocker');
  if (!(ghost && ghost[1] > 0)) addBlocker('tools/roadtool', 'No road ghost is drawn between the anchor and the cursor', `perTool.road=${JSON.stringify(ghost)}`, 'Check roadtool.drawGhost / env.ground().');

  // ---------- 4c. commit ----------
  const b4 = await state();
  await page.mouse.click(hB.x, hB.y); await frames(30);
  const a4 = await state();
  const n4 = await drain();
  const conform = await page.evaluate(() => {
    const w = window.__game.world, seg = [...w.roads.segments.values()][0];
    if (!seg) return null;
    let dev = 0;
    for (const p of seg.points) dev = Math.max(dev, Math.abs(p.y - w.terrain.getHeight(p.x, p.z)));
    return { id: seg.id, type: seg.type, length: +seg.length.toFixed(1), maxTerrainDeviation_m: +dev.toFixed(2) };
  });
  record('4c. draw a road', 'clicked the end point',
    { roadSegments: `${b4.roadSegments} → ${a4.roadSegments}`, money: `${b4.money} → ${a4.money} (Δ ${a4.money - b4.money})`, segment: conform, notifications: n4.notes }, await shot('road-1-built'),
    a4.roadSegments > b4.roadSegments ? 'ok' : 'blocker');
  if (a4.roadSegments <= b4.roadSegments) addBlocker('tools/roadtool + roads', 'Click-start / click-end builds no road', `segments stayed at ${b4.roadSegments}; notifications: ${JSON.stringify(n4.notes)}`, 'Check roadtool.click() → roads.api.build().');
  if (a4.money >= b4.money) addFriction('tools/roadtool', 'Building a road costs nothing', 'Deduct the previewed cost.');

  await assertLive('after the first road');
  // ---------- 5. second road meeting the first ----------
  await key('Escape'); await key('Escape');
  await clickSel('.fc-cat[aria-label="Roads"]');
  const spur = await findSpur(run.c.x, run.c.z, run.dir, 110);
  const b5 = await state();
  let spurLog = { found: !!spur };
  if (spur) {
    const cA = await clickWorld(spur.a.x, spur.a.z, 6);
    const hEnd = await hover(spur.b.x, spur.b.z, 8);
    const mid = await state();
    const shotGhost = await shot('road-2-ghost-snap-to-road');
    const cB = await clickWorld(spur.b.x, spur.b.z, 30);
    spurLog = { found: true, startClick: { ok: cA.ok, why: cA.why, px: `${cA.x},${cA.y}` }, endClick: { ok: cB.ok, why: cB.why, px: `${cB.x},${cB.y}` }, ghostAtRoad: mid.overlay?.perTool.road, ghostShot: shotGhost };
  }
  const a5 = await state();
  const n5 = await drain();
  record('5. junction', spur ? `drew a ${spur.length.toFixed(0)} m spur ending on the middle of road 1` : 'no valid perpendicular spur corridor exists here',
    { ...spurLog, roadSegments: `${b5.roadSegments} → ${a5.roadSegments}`, roadNodes: `${b5.roadNodes} → ${a5.roadNodes}`, junctionNodes: `${b5.junctions} → ${a5.junctions}`, maxNodeDegree: a5.maxNodeDegree, notifications: n5.notes },
    await shot('road-2-junction'), a5.junctions > b5.junctions ? 'ok' : (a5.roadSegments > b5.roadSegments ? 'friction' : 'blocker'));
  if (a5.roadSegments <= b5.roadSegments) addBlocker('tools/roadtool + roads', 'A second road drawn onto the first one is never built — the click does nothing and nothing is said',
    `segments ${b5.roadSegments} → ${a5.roadSegments}; notifications: ${JSON.stringify(n5.notes)}; clicks: ${JSON.stringify(spurLog)}`, 'Check roadtool.click() when the cursor snaps to an existing segment, and roads.api.build() splitting it.');
  else if (a5.junctions <= b5.junctions) addFriction('roads', 'Two roads that meet do not form a ≥3-way junction node', 'Split the existing segment at the snap point in roads.api.build().');

  // ---------- 6. zoning ----------
  await key('Escape'); await key('Escape');
  const zCat = await clickSel('.fc-cat[aria-label="Zoning"]');
  const zItem = await clickSel('.fc-item[aria-label="Low Density Residential"]');
  const stz = await state();
  record('6a. zoning tool', 'clicked Zoning → Low Density Residential', { categoryButton: zCat, itemCard: zItem, tool: stz.tool, type: stz.toolType }, await shot('zone-tool-armed'), stz.tool === 'zone' ? 'ok' : 'blocker');
  if (stz.tool !== 'zone') addBlocker('ui/toolbar', 'The Zoning HUD button does not arm the zone tool', `world.tool.active="${stz.tool}"`, 'Check catalog zoning items → hud.selectTool.');

  const zr = await page.evaluate(([a, b, dir]) => {
    const rad = dir * Math.PI / 180, nx = -Math.sin(rad), nz = Math.cos(rad);
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    return { from: { x: mx - Math.cos(rad) * 60 + nx * 80, z: mz - Math.sin(rad) * 60 + nz * 80 },
      to: { x: mx + Math.cos(rad) * 60 - nx * 80, z: mz + Math.sin(rad) * 60 - nz * 80 } };
  }, [run.a, run.b, run.dir]);
  const p0 = await toScreen(zr.from.x, zr.from.z), p1 = await toScreen(zr.to.x, zr.to.z);
  const zb = await state();
  await page.mouse.move(p0.x, p0.y, { steps: 3 }); await frames(4);
  await page.mouse.down(); await frames(4);
  await page.mouse.move((p0.x + p1.x) / 2, (p0.y + p1.y) / 2, { steps: 6 }); await frames(4);
  await page.mouse.move(p1.x, p1.y, { steps: 6 }); await frames(6);
  const zPreview = await shot('zone-marquee-preview');
  await page.mouse.up(); await frames(25);
  const za = await state();
  const zc = await page.evaluate(() => {
    const w = window.__game.world, api = w.roads.api;
    let far = 0, maxD = 0;
    for (const lot of w.zones.lots) {
      const h = api.nearest(lot.x, lot.z, 400);
      const d = h ? h.distance : 999;
      maxD = Math.max(maxD, d);
      if (d > 40) far++;
    }
    return { lots: w.zones.lots.length, lotsFurtherThan40mFromRoad: far, maxLotDistanceToRoad_m: +maxD.toFixed(1), types: [...new Set(w.zones.lots.map((l) => l.type))] };
  });
  record('6b. paint zones along the road', 'dragged a ~230 m marquee that deliberately overshoots the road by 80 m on both sides',
    { lots: `${zb.zoneLots} → ${za.zoneLots}`, ...zc, previewShot: zPreview }, await shot('zone-painted'), za.zoneLots > zb.zoneLots ? 'ok' : 'blocker');
  if (za.zoneLots <= zb.zoneLots) addBlocker('tools/zonetool + zoning', 'Painting zones next to a road creates no lots', `zones.lots stayed at ${zb.zoneLots}`, 'Check zones.api.cellAt()/paint() in an empty world.');
  if (zc.lotsFurtherThan40mFromRoad > 0) addFriction('zoning', `${zc.lotsFurtherThan40mFromRoad} lots landed further than 40 m from any road`, 'Clamp zoning to the 4-cell road corridor.');

  await assertLive('after zoning');
  // ---------- 7. run time ----------
  await key('Escape'); await key('Escape');
  const t7a = await state();
  await key('Space');
  let t7 = await state();
  if (t7.paused || t7.speed === 0) { await key('Space'); t7 = await state(); }
  // 7a. DEFAULT speed first. A visitor who follows a link never touches the speed control, so the
  // honest question is what the city does at 1x. Only then ramp to 3x for the endurance window.
  const d0t = Date.now();
  const dtrack = [];
  let dFirstSpawn = null, dFirstBuilt = null;
  while ((Date.now() - d0t) / 1000 < DEFAULT_WINDOW) {
    await sleep(2500);
    if (await reloaded()) break;
    const s = await state();
    const sec = +((Date.now() - d0t) / 1000).toFixed(0);
    dtrack.push({ s: sec, b: s.buildings, built: s.built, pop: s.population });
    if (dFirstSpawn == null && s.buildings > 0) dFirstSpawn = sec;
    if (dFirstBuilt == null && s.built > 0) dFirstBuilt = sec;
  }
  const t7d = await state();
  record('7a. the first two minutes at DEFAULT speed', `left the game alone at ${t7d.speed}x for ${DEFAULT_WINDOW} s \u2014 no speed control touched`,
    { speed: t7d.speed, secondsToFirstConstructionSite: dFirstSpawn, secondsToFirstFinishedBuilding: dFirstBuilt,
      buildings: t7d.buildings, finished: t7d.built, timeline: dtrack },
    await shot('growth-default-speed'),
    dFirstBuilt != null && dFirstBuilt <= 60 ? 'ok' : (t7d.buildings > 0 ? 'friction' : 'blocker'));
  if (t7d.buildings === 0) addBlocker('buildings', `Nothing at all is built in ${DEFAULT_WINDOW} s at the default speed`, 'buildings.list stayed empty', 'Check growthStep() fill probability against world.economy.demand.');
  else if (dFirstBuilt == null) addFriction('buildings', `No building finishes inside ${DEFAULT_WINDOW} s at the default speed \u2014 a visitor from a link sees only scaffolding`, 'Shorten BUILD_HOURS / MEAN_FILL_HOURS in src/modules/buildings/index.js.');

  await key('Equal'); await key('Equal'); await key('Equal');
  const t7b = await state();
  const g0t = Date.now();
  let firstSpawn = null, firstBuilt = null, firstPop = null;
  const track = [];
  while ((Date.now() - g0t) / 1000 < GROW) {
    await sleep(5000);
    if (await reloaded()) { track.push({ RELOADED_BY_ANOTHER_BUILDER: true, s: +((Date.now() - g0t) / 1000).toFixed(0) }); break; }
    const s = await state();
    const sec = +((Date.now() - g0t) / 1000).toFixed(0);
    track.push({ s: sec, days: s.totalDays, b: s.buildings, built: s.built, pop: s.population, hh: s.households, jobs: s.jobs });
    if (!firstSpawn && s.buildings > 0) firstSpawn = sec;
    if (!firstBuilt && s.built > 0) firstBuilt = sec;
    if (!firstPop && s.population > 0) firstPop = sec;
    if (s.built >= 3 && s.population > 0) break;
  }
  const t7c = await state();
  const n7 = await drain();
  record('7. run time forward', `Space to run, "+" ×3 → speed 3, waited ${((Date.now() - g0t) / 1000).toFixed(0)} s of real time`,
    { pausedWhenTheWorldOpened: t7a.paused, speed: `${t7a.speed} → ${t7b.speed}`, gameDaysElapsed: t7c.totalDays,
      buildings: `${t7b.buildings} → ${t7c.buildings}`, completed: `${t7b.built} → ${t7c.built}`, maxConstructionProgress: t7c.maxProgress,
      population: `${t7b.population} → ${t7c.population}`, jobs: `${t7b.jobs} → ${t7c.jobs}`,
      secondsToFirstConstructionSite: firstSpawn, secondsToFirstCompletedBuilding: firstBuilt, secondsToFirstResident: firstPop,
      timeline: track, drawCalls: t7c.drawCalls, triangles: t7c.triangles, notifications: n7.notes.slice(0, 6) },
    await shot('growth'), t7c.built > 0 && t7c.population > 0 ? 'ok' : (t7c.buildings > 0 ? 'friction' : 'blocker'));
  if (t7c.buildings === 0) addBlocker('buildings + simulation', 'Zoned lots never grow anything', `after ${GROW}s at speed 3 (${t7c.totalDays} game days) buildings.list.length = 0`, 'Check growthStep() is driven in an empty world.');
  else if (t7c.built === 0) addFriction('buildings', `Buildings appear as construction sites but none finished in ${GROW}s at max speed`, 'Shorten BUILD_HOURS / MEAN_FILL_HOURS in src/modules/buildings/index.js so a new player sees a finished house within a minute.');
  else if (t7c.population === 0) addFriction('simulation/economy', 'Buildings complete but population stays 0', 'Check economy occupancy for freshly completed buildings.');

  await assertLive('after running time');
  // ---------- 8a. service buildings (a city needs power + water before anyone moves in) ----------
  const placeService = async (label, type) => {
    await key('Escape'); await key('Escape');
    await clickSel('.fc-cat[aria-label="Services"]');
    const card = await clickSel(`.fc-item[aria-label="${label}"]`);
    // a first-time player hunts for a clear patch; ask the game where it would actually accept one
    const spot = await page.evaluate(([t]) => {
      const w = window.__game.world, api = w.services && w.services.api, r = w.roads.api;
      if (!api || !api.canPlace) return null;
      const seg = [...w.roads.segments.values()][0];
      const c = seg ? seg.points[Math.floor(seg.points.length / 2)] : { x: 0, z: 0 };
      const tried = [];
      for (let rad = 40; rad <= 320; rad += 20) for (let a = 0; a < 360; a += 20) {
        const x = c.x + Math.cos(a * Math.PI / 180) * rad, z = c.z + Math.sin(a * Math.PI / 180) * rad;
        let yaw = 0;
        const hit = r.nearest(x, z, 90);
        if (hit && hit.tangent) yaw = Math.atan2(hit.tangent.x, hit.tangent.z) + Math.PI / 2;
        const res = api.canPlace(t, x, z, { yaw });
        if (res && res.ok) return { x, z, distanceFromRoadCentre: rad, rejectedSpotsTried: tried.length, lastReason: tried[tried.length - 1] || null };
        if (res && res.reason && tried[tried.length - 1] !== res.reason) tried.push(res.reason);
      }
      return { none: true, reasons: tried };
    }, [type]);
    if (!spot || spot.none) return { label, card, placed: false, spot };
    const before = await state();
    await hover(spot.x, spot.z, 8);
    const ghostShot = await shot(`service-ghost-${type}`);
    const c = await clickWorld(spot.x, spot.z, 25);
    const after = await state();
    const notes = await drain();
    return { label, card, click: { ok: c.ok, why: c.why }, spot, ghostShot,
      services: `${before.services} → ${after.services}`, money: `${before.money} → ${after.money}`,
      placed: after.services > before.services, notifications: notes.notes };
  };
  const water = await placeService('Water Tower', 'water');
  const power = await placeService('Coal Power Plant', 'power');
  const a8 = await state();
  record('8a. place service buildings', 'Services → Water Tower, then Coal Power Plant; each placed on the first spot the game says it accepts',
    { water, power, servicesNow: a8.services, money: a8.money }, await shot('services-placed'),
    (water.placed && power.placed) ? 'ok' : 'blocker');
  if (!water.placed || !power.placed) addBlocker('tools/servicetool + simulation/services', 'A service building cannot be placed',
    `water=${JSON.stringify(water).slice(0, 400)} power=${JSON.stringify(power).slice(0, 400)}`, 'Check services.api.canPlace()/place() and the footprint clearance rules.');

  // ---------- 8a2. with utilities connected, do people finally move in? ----------
  const GROW2 = +flag('grow2', 240);
  const p0t = Date.now();
  let firstResident = null; const track2 = [];
  while ((Date.now() - p0t) / 1000 < GROW2) {
    await sleep(10000);
    if (await reloaded()) { track2.push({ RELOADED_BY_ANOTHER_BUILDER: true }); break; }
    const s2 = await state();
    const sec = +((Date.now() - p0t) / 1000).toFixed(0);
    track2.push({ s: sec, days: s2.totalDays, built: s2.built, pop: s2.population, hh: s2.households, jobs: s2.jobs, coverage: s2.coverage });
    if (!firstResident && s2.population > 0) { firstResident = sec; break; }
  }
  const a82 = await state();
  const cov = await page.evaluate(() => { const c = window.__game.world.economy.coverage || {}; return { power: +(c.power || 0).toFixed(2), water: +(c.water || 0).toFixed(2) }; });
  record('8a2. do citizens appear?', `power + water placed, ran another ${((Date.now() - p0t) / 1000).toFixed(0)} s at speed 3`,
    { coverage: cov, completedBuildings: a82.built, population: a82.population, households: a82.households, jobs: a82.jobs,
      secondsFromFirstCompletedHouseToFirstResident: firstResident, timeline: track2,
      totalRealSecondsPlayed: +((Date.now() - g0t) / 1000).toFixed(0), gameDays: a82.totalDays },
    await shot('population'), a82.population > 0 ? 'ok' : 'blocker');
  if (a82.population === 0) addBlocker('simulation/economy', 'Finished houses never gain a single resident — the HUD still reads 0 population after the whole session',
    `${a82.built} completed residential buildings, coverage power=${cov.power} water=${cov.water}, ${a82.totalDays} game days, population=0, jobs=${a82.jobs}`,
    'economy.js move-in rate (dailyIn ≈ 0.014-0.04 people/building/day) is far too slow for a new city; a first-time player never sees the counter leave 0.');

  // ---------- 8b. bulldoze (prefer a building, so the city survives) ----------
  await key('Escape'); await key('Escape');
  const bzCat = await clickSel('.fc-cat[aria-label="Bulldoze"]');
  const stb = await state();
  /**
   * Several candidates, not one. `clickWorld` refuses to click a point the HUD is covering and
   * returns without dispatching anything, so a single target that happens to sit under a panel
   * produced "bulldoze removes nothing" — a blocker against a module that was working fine. Walk
   * the list until a click actually lands, and only then judge the tool.
   */
  const targets = await page.evaluate(() => {
    const w = window.__game.world;
    const out = w.buildings.list.slice(0, 8).map((b) => ({ x: b.x, z: b.z, kind: 'building', id: b.id }));
    for (const s of [...w.roads.segments.values()].slice(-3)) {
      const p = s.points[Math.floor(s.points.length / 2)];
      out.push({ x: p.x, z: p.z, kind: 'road', id: s.id });
    }
    return out;
  });
  const tgt = targets[0] || null;
  let bzLog = { target: tgt };
  let bzHover = null, bzClick = null, used = null, skipped = 0;
  if (targets.length) {
    const before0 = await state();
    for (const cand of targets) {
      const hv0 = await hover(cand.x, cand.z, 10);
      if (!hv0.ok) { skipped++; continue; }               // covered by the HUD — not this tool's fault
      used = cand;
      const hv = await state();
      bzHover = await shot('bulldoze-hover');
      const before = await state();
      bzClick = await clickWorld(cand.x, cand.z, 25);
      const after = await state();
      bzLog = { target: cand, candidatesSkippedAsCovered: skipped,
        click: { landed: !!bzClick.ok, why: bzClick.why || null, px: `${bzClick.x},${bzClick.y}` },
        hoverHighlighted: hv.overlay && hv.overlay.hover, hoverShot: bzHover,
        buildings: `${before.buildings} → ${after.buildings}`, roadSegments: `${before.roadSegments} → ${after.roadSegments}`, money: `${before.money} → ${after.money}`,
        removed: after.buildings < before.buildings || after.roadSegments < before.roadSegments };
      if (bzLog.removed) break;
    }
    if (!used) bzLog = { target: targets[0], candidatesSkippedAsCovered: skipped, click: { landed: false, why: 'every candidate was under the HUD' }, removed: false, allCovered: true };
    else bzLog.startedFrom = { buildings: before0.buildings };
  }
  const n8b = await drain();
  const bzVerdict = bzLog.removed ? 'ok' : (bzLog.allCovered ? 'friction' : 'blocker');
  record('8b. bulldoze', `Bulldoze category, hovered the ${used ? used.kind : 'nothing'}, clicked`, { categoryButton: bzCat, tool: stb.tool, ...bzLog, notifications: n8b.notes },
    await shot('bulldoze-done'), bzVerdict);
  if (bzLog.allCovered) addFriction('ui / playtest driver', `Every bulldoze candidate (${skipped}) was under the HUD, so the tool was never exercised`, 'Pan the camera, or pick targets away from the panels, before judging the tool.');
  else if (!bzLog.removed) addBlocker('tools/entitytool', 'Bulldoze removes nothing under the cursor', JSON.stringify(bzLog), 'Check picker.pick() + the relevant api.remove().');

  // ---------- 8c. Esc ----------
  await key('Escape'); await key('Escape');
  await clickSel('.fc-cat[aria-label="Roads"]');
  await clickWorld(run.a.x, run.a.z, 6);
  await hover(run.b.x, run.b.z, 8);
  const pend = await state();
  await key('Escape', 12);
  const e1 = await state();
  await key('Escape', 12);
  const e2 = await state();
  record('8c. Esc cancels', 'armed the road tool, placed one node, then pressed Esc twice',
    { ghostFillVerts_before: pend.overlay?.perTool.road, ghostFillVerts_afterFirstEsc: e1.overlay?.perTool.road, toolAfterFirstEsc: e1.tool, toolAfterSecondEsc: e2.tool, nothingWasBuilt: e2.roadSegments === pend.roadSegments },
    await shot('esc-cancelled'), (e1.overlay?.perTool.road && e1.overlay.perTool.road[1] === 0 && e2.tool === 'select') ? 'ok' : 'friction');
  if (e2.tool !== 'select') addFriction('ui/tools', `Esc does not return to the select tool (still "${e2.tool}")`, 'Check hud.escape() vs the capture-phase Esc handler in tools.');

  const fin = await state();
  const finErrs = await drain();
  record('8d. the city a stranger just built', 'final state', { ...fin, uncaughtErrorsDuringPlay: finErrs.errs }, await shot('city-final'));

  await assertLive('before the demo-city path');
  // ---------- 9. demo city ----------
  if (!has('skip-demo')) {
    const t9 = Date.now();
    await page.goto(URL_NEW, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForSelector(SEL.panel, { visible: true, timeout: 45000 });
    await page.click(SEL.demoBtn);
    let demoOk = true;
    try { await page.waitForFunction('window.__game && window.__game.ready === true', { timeout: 300000, polling: 250 }); } catch (_) { demoOk = false; }
    try { await page.waitForFunction(`!document.querySelector('${SEL.root}')`, { timeout: 30000, polling: 200 }); } catch (_) { /* noted */ }
    await frames(30);
    const st9 = demoOk ? await state() : null;
    record('9. Load demo city', `reloaded, clicked "Load demo city" (${((Date.now() - t9) / 1000).toFixed(1)} s)`, demoOk ? st9 : 'never became ready', await shot('demo-city'),
      demoOk && st9.buildings > 50 ? 'ok' : 'blocker');
    if (!demoOk || st9.buildings < 50) addBlocker('demo/DemoCity.js', 'The "Load demo city" path does not produce a city', `ready=${demoOk} buildings=${st9 ? st9.buildings : 'n/a'}`, 'Check buildDemoCity() after the start screen.');
  }
} catch (err) {
  record('FATAL', 'driver aborted', String(err && err.stack || err), await shot('fatal').catch(() => null), 'blocker');
  addBlocker('playtest', 'The audit could not complete', String(err && err.message || err), 'See the fatal step.');
} finally {
  const errors = logs.filter((l) => l.type === 'pageerror' || l.type === 'error');
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ url: URL_NEW, viewport: `${W}x${H}`, when: new Date().toISOString(), steps, consoleErrors: errors.slice(0, 40), warnings: logs.filter((l) => l.type === 'warning').length, blockers, frictions }, null, 2));
  console.log('\n---- page/console errors: ' + errors.length + ' ----');
  for (const e of errors.slice(0, 12)) console.log('  - ' + e.type + ': ' + e.text + (e.stack ? '\n      ' + e.stack.split('\n').slice(0, 4).join('\n      ') : ''));
  console.log('\nblockers: ' + blockers.length + '   frictions: ' + frictions.length);
  for (const b of blockers) console.log('  BLOCKER [' + b.module + '] ' + b.description);
  for (const f of frictions) console.log('  friction [' + f.module + '] ' + f.description);
  console.log('report: ' + rel(path.join(OUT, 'report.json')));
  await browser.close();
}
