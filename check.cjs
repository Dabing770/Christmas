// No dependencies. Run: node check.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, 'Christmas.html'), 'utf8');
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
new vm.Script(script); // Parse the entire production module, including dynamic imports.
const config = script.slice(script.indexOf('const CONFIG ='), script.indexOf('let scene,'));
const logic = script.slice(script.indexOf('function smoothAlpha('), script.indexOf('function setupEvents()'));
const between = (from, to) => script.slice(script.indexOf(from), script.indexOf(to));
// The effect builders and their per-frame update, pulled out to run against a stubbed THREE.
const effectSource = between('function smoothAlpha(', 'function setStatus(')
  + between('function wrapRange(', 'function updateFocusLayout(')
  + between('function pointsMaterial(', 'class Particle {')
  + between('function updateEffects(', 'function animate(');
const elements = new Map();
function element(id) {
  if (!elements.has(id)) elements.set(id, { textContent: '', hidden: false, disabled: false, setAttribute() {} });
  return elements.get(id);
}
const context = vm.createContext({
  console, setTimeout, clearTimeout, navigator: { mediaDevices: {} },
  performance: { now: () => context.time },
  document: { getElementById: element },
  cancelAnimationFrame() {}, requestAnimationFrame() { return 1; }
});
vm.runInContext(config + `
  let particleSystem = [], defaultPhoto = null, uploading = false;
  let gestureSession = 0, gestureFrame = 0, gestureStream = null, handLandmarker = null;
  let gestureEnabled = false, gestureLoading = false, gesturePending = false;
  let lastVideoTime = -1, lastInferenceTime = 0;
  let burst = null, burstState = null;
  const video = { pause() {}, srcObject: null };
` + logic + `
  updateFocusLayout = () => {};
  globalThis.state = STATE;
`, context);
const run = code => vm.runInContext(code, context);
let disposed = 0;
function photo(id) {
  return { type: 'PHOTO', mesh: {
    id, removeFromParent() {}, traverse(fn) {
      fn({ isMesh: true, geometry: { dispose() { disposed++; } },
        material: { dispose() { disposed++; }, map: { dispose() { disposed++; } } } });
    }
  } };
}
context.photos = [photo(0), photo(1), photo(2)];
run('particleSystem = photos.slice()');
function hand(x, pinch = true, distance = 0.4) {
  const landmarks = Array.from({ length: 21 }, () => ({ x, y: 0.4 }));
  landmarks[0] = { x, y: 0.4 + distance };
  landmarks[4] = { x: x + (pinch ? 0.01 : 0.15), y: 0.4 };
  context.result = { landmarks: [landmarks] };
  run('processGestures(result)');
}

// A stub with just enough of THREE for the effect builders to fill real typed arrays.
function stubThree() {
  return {
    BufferAttribute: class { constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; this.needsUpdate = false; } },
    BufferGeometry: class { constructor() { this.attributes = {}; } setAttribute(name, a) { this.attributes[name] = a; } },
    Points: class { constructor(geometry, material) { this.geometry = geometry; this.material = material; this.userData = {}; this.visible = true; this.frustumCulled = true; } },
    PointsMaterial: function (options) { return Object.assign({ opacity: 1, size: 1 }, options); },
    CanvasTexture: function () { return {}; },
    AdditiveBlending: 2,
    MathUtils: { lerp: (a, b, t) => a + (b - a) * t }
  };
}

const finite = array => Array.prototype.every.call(array, v => Number.isFinite(v));
const within = (array, lo, hi) => Array.prototype.every.call(array, v => v >= lo - 1e-6 && v <= hi + 1e-6);

// Builds every effect, then runs the real per-frame update for `seconds` of simulated time.
function runEffects(seconds, mode, onFrame = () => {}) {
  const fx = vm.createContext({ Math, console, THREE: stubThree() });
  vm.runInContext(config + `
    let sparkTexture = {}, snow, snowMotion, treeLights, lightPhase, starField;
    let meteors, meteorState = [], burst = null, burstState = null;
    const scene = { add() {} }, mainGroup = { add() {} };
  ` + effectSource + `
    createStarfield(); createSnow(); createTreeLights(); createMeteors(); createBurst();
    globalThis.fx = { get snow() { return snow; }, get treeLights() { return treeLights; },
      get starField() { return starField; }, get meteors() { return meteors; },
      get burst() { return burst; }, get burstState() { return burstState; },
      fire: () => fireBurst(), step: (dt, t) => updateEffects(dt, t, '${mode}') };
  `, fx);
  const handle = vm.runInContext('fx', fx);
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) {
    handle.step(dt, t);
    onFrame(handle, t);
  }
  return handle;
}

async function main() {
  // A failed module import must reach the visible startup-error path.
  let bootError = '';
  const boot = vm.createContext({
    clearTimeout, window: { bootTimer: 0 }, console: { error() {} },
    showBootError(message) { bootError = message; }
  });
  new vm.Script(script).runInContext(boot); // No import resolver: simulates unavailable dependencies.
  await new Promise(resolve => setImmediate(resolve));
  assert.match(bootError, /启动失败/);

  // Original FOCUS behavior: left/right screen zones switch with a 450 ms cooldown.
  context.time = 1000;
  hand(0.5);
  assert.equal(context.state.mode, 'FOCUS');
  assert.equal(context.state.focusIndex, 0);
  hand(0.1);
  assert.equal(context.state.focusIndex, 1);
  context.time = 1200;
  hand(0.1);
  assert.equal(context.state.focusIndex, 1);
  context.time = 1501;
  hand(0.1);
  assert.equal(context.state.focusIndex, 2);
  context.time = 2000;
  hand(0.9);
  assert.equal(context.state.focusIndex, 1);
  run('processGestures({ landmarks: [] })');
  assert.equal(context.state.pinchActive, false);
  assert.equal(context.state.mode, 'FOCUS');
  hand(0.5, false, 0.5);
  assert.equal(context.state.mode, 'SCATTER');
  hand(0.5, false, 0.1);
  assert.equal(context.state.mode, 'TREE');

  // Circular navigation, deletion before the selected item, selected/last-item deletion.
  run('focusPhotoByIndex(-1)');
  assert.equal(context.state.focusIndex, 2);
  run('removePhoto(particleSystem[0])');
  assert.equal(context.state.focusIndex, 1);
  assert.equal(context.state.focusTarget.id, 2);
  run('deleteCurrentPhoto()');
  assert.equal(context.state.focusIndex, 0);
  assert.equal(context.state.focusTarget.id, 1);
  run('deleteCurrentPhoto(); nextPhoto(); prevPhoto()');
  assert.equal(context.state.focusIndex, -1);
  assert.equal(context.state.focusTarget, null);
  assert.equal(context.state.mode, 'TREE');
  assert.equal(disposed, 9);
  assert.equal(element('focus-button').disabled, true);

  // Framing for wide and tall images in portrait and landscape available viewports.
  for (const [w, h, vw, vh] of [[8, 1.44, 6.4, 5], [1.44, 8, 20, 5], [1.44, 1.44, 6.4, 3]]) {
    context.dimensions = [w, h, vw, vh];
    const scale = run('fitPhotoScale(...dimensions)');
    assert.ok(w * scale <= vw * 0.9 + 1e-9);
    assert.ok(h * scale <= vh * 0.9 + 1e-9);
  }
  for (const dt of [0, 1 / 60, 2, 300]) {
    context.dt = dt;
    const alpha = run('smoothAlpha(5, dt)');
    assert.ok(alpha >= 0 && alpha <= 1);
  }
  assert.equal(run('photoFileError({size: 1, type: "image/png"}, 29)'), '');
  assert.notEqual(run('photoFileError({size: 1, type: "image/png"}, 30)'), '');
  assert.notEqual(run('photoFileError({size: 21 * 1024 * 1024, type: "image/png"}, 0)'), '');
  assert.notEqual(run('photoFileError({size: 1, type: "text/plain"}, 0)'), '');

  // Desktop pointer maths: zoom stays inside the range that keeps the focused photo in front.
  assert.equal(run('clampZoom(50, 0)'), 50);
  assert.equal(run('clampZoom(50, -10000)'), run('CONFIG.camera.min'));
  assert.equal(run('clampZoom(50, 10000)'), run('CONFIG.camera.max'));
  assert.ok(run('clampZoom(50, -100)') < 50 && run('clampZoom(50, -100)') >= run('CONFIG.camera.min'));
  assert.ok(run('clampZoom(50, 100)') > 50 && run('clampZoom(50, 100)') <= run('CONFIG.camera.max'));
  context.drag = run('dragDelta(100, 50, 1000, 500)');
  assert.ok(Math.abs(context.drag.y - Math.PI * 0.2) < 1e-9); // A full width drag is one turn.
  assert.ok(Math.abs(context.drag.x - Math.PI * 0.1) < 1e-9);
  assert.equal(run('dragDelta(10, 10, 0, 0).y'), 10 * Math.PI * 2); // No division by zero.
  assert.equal(run('clampPitch(5)'), 1.2);
  assert.equal(run('clampPitch(-5)'), -1.2);
  assert.equal(run('clampPitch(0.3)'), 0.3);

  // Effect maths: snow wrapping, light twinkle bounds, meteor/burst fade.
  assert.equal(run('wrapRange(5, 0, 10)'), 5);
  assert.equal(run('wrapRange(-1, 0, 10)'), 9);    // Falls past the floor, reappears at the ceiling.
  assert.equal(run('wrapRange(-36, -35, 70)'), 34);
  assert.equal(run('wrapRange(115, 0, 10)'), 5);   // Several spans at once still lands in range.
  for (const t of [0, 0.3, 1.7, 40]) {
    context.t = t;
    const k = run('twinkle(t, 1.2, 2.5)');
    assert.ok(k >= 0.35 - 1e-9 && k <= 1 + 1e-9);
  }
  assert.equal(run('fadeLife(0.45, 0.9)'), 0.5);
  assert.equal(run('fadeLife(-1, 0.9)'), 0);
  assert.equal(run('fadeLife(5, 0.9)'), 1);
  assert.equal(run('fadeLife(1, 0)'), 1);          // No division by zero.

  // Every mode change fires the burst, which must be inert before createBurst() has run.
  assert.doesNotThrow(() => run('setMode("SCATTER"); setMode("TREE")'));
  assert.equal(context.state.mode, 'TREE');

  // The builders and the per-frame update run for real against a stubbed THREE, which is
  // where an off-by-one in the position/colour strides would surface as NaN or a black frame.
  const fxCfg = vm.runInContext('CONFIG.effects', context);
  let sawMeteor = false;
  const handle = runEffects(24, 'TREE', h => {
    assert.ok(finite(h.snow.geometry.attributes.position.array), 'snow positions finite');
    assert.ok(finite(h.meteors.geometry.attributes.position.array), 'meteor positions finite');
    if (Array.prototype.some.call(h.meteors.geometry.attributes.color.array, v => v > 0.05)) sawMeteor = true;
  });

  assert.equal(handle.snow.geometry.attributes.position.array.length, fxCfg.snow * 3);
  assert.equal(handle.starField.geometry.attributes.position.array.length, fxCfg.stars * 3);
  assert.equal(handle.treeLights.geometry.attributes.color.array.length, fxCfg.lights * 3);
  assert.equal(handle.meteors.geometry.attributes.position.array.length, fxCfg.meteors * fxCfg.meteorTrail * 3);
  assert.equal(handle.burst.geometry.attributes.position.array.length, fxCfg.burst * 3);

  // Snow must stay inside its column instead of drifting off the bottom for good.
  const snowY = [];
  const snowPos = handle.snow.geometry.attributes.position.array;
  for (let i = 1; i < snowPos.length; i += 3) snowY.push(snowPos[i]);
  assert.ok(within(snowY, -fxCfg.snowHeight / 2, fxCfg.snowHeight / 2), 'snow stays in range');

  // Twinkling scales the stored base colour; it must never blow past full brightness.
  assert.ok(within(handle.treeLights.geometry.attributes.color.array, 0, 1), 'light colours in gamut');
  assert.ok(handle.treeLights.material.opacity > 0.9, 'lights lit in TREE mode');
  assert.ok(sawMeteor, 'at least one meteor launched');

  // Lights belong to the tree shape, so they must fade away once it breaks apart.
  const scattered = runEffects(4, 'SCATTER');
  assert.ok(scattered.treeLights.material.opacity < 0.01, 'lights fade outside TREE mode');
  assert.equal(scattered.treeLights.visible, false);

  // A burst expands, then fully retires itself rather than lingering at zero opacity.
  const bursting = runEffects(0.1, 'TREE');
  assert.equal(bursting.burst.visible, false);
  bursting.fire();
  assert.equal(bursting.burst.visible, true);
  bursting.step(0.2, 1);
  const spread = bursting.burst.geometry.attributes.position.array;
  assert.ok(Array.prototype.some.call(spread, v => Math.abs(v) > 0.5), 'burst actually expands');
  assert.ok(finite(spread), 'burst positions finite');
  for (let i = 0; i < 120; i++) bursting.step(1 / 60, 1 + i / 60);
  assert.equal(bursting.burstState.life, 0);
  assert.equal(bursting.burst.visible, false);

  // The sign stays photo 1 in the switching order no matter where it sits in the array.
  context.sign = photo('sign');
  context.extras = [photo(20), photo(21)];
  run('particleSystem = [extras[0], sign, extras[1]]; defaultPhoto = sign');
  assert.equal(run('getPhotoParticles().length'), 3);
  assert.equal(run('getPhotoParticles()[0].mesh.id'), 'sign');
  assert.equal(run('getPhotoParticles()[2].mesh.id'), 21);
  run('focusPhotoByIndex(0)');
  assert.equal(run('STATE.focusTarget.id'), 'sign');
  run('nextPhoto(); nextPhoto(); nextPhoto()'); // Wraps back around to the sign.
  assert.equal(run('STATE.focusTarget.id'), 'sign');
  run('defaultPhoto = null');
  assert.equal(run('getPhotoParticles()[0].mesh.id'), 20);

  // An out-of-range focus index must be pulled back in range by any removal.
  context.photos = [photo(10), photo(11), photo(12)];
  run('particleSystem = photos.slice(); STATE.mode = "TREE"; STATE.focusIndex = 9; STATE.focusTarget = null');
  run('removePhoto(particleSystem[0])');
  assert.equal(context.state.focusIndex, 1);
  run('removePhoto(particleSystem[0]); removePhoto(particleSystem[0])');
  assert.equal(context.state.focusIndex, -1);
  assert.equal(context.state.focusTarget, null);

  // Permission rejection must leave the camera off and ordinary controls usable.
  context.navigator.mediaDevices.getUserMedia = async () => {
    throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
  };
  await run('toggleGestures()');
  assert.match(element('gesture-status').textContent, /权限未获允许/);
  assert.equal(element('gesture-button').disabled, false);
  assert.equal(run('gestureEnabled || gestureLoading || gesturePending'), false);

  // Cancellation while the permission request is pending must stop a late camera stream.
  let resolveCamera, stops = 0;
  context.navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { resolveCamera = resolve; });
  const enabling = run('toggleGestures()');
  run('stopGestures()');
  resolveCamera({ getTracks: () => [{ stop() { stops++; } }] });
  await enabling;
  assert.equal(stops, 1);
  assert.equal(run('gestureStream'), null);
  assert.equal(run('gestureEnabled'), false);

  // Explicit stop must release both active camera tracks and the model.
  let closes = 0;
  context.mockStream = { getTracks: () => [{ stop() { stops++; } }] };
  context.mockModel = { close() { closes++; } };
  run('gestureEnabled = true; gestureStream = mockStream; handLandmarker = mockModel; stopGestures()');
  assert.equal(stops, 2);
  assert.equal(closes, 1);

  // Timed-out asynchronous resources are disposed if they arrive later.
  let resolveLate, lateDisposed = 0;
  context.pending = new Promise(resolve => { resolveLate = resolve; });
  context.disposeLate = () => lateDisposed++;
  await assert.rejects(run('withTimeout(pending, 5, "timeout", disposeLate)'), /timeout/);
  resolveLate({});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lateDisposed, 1);
  console.log('PASS: full syntax, failed startup, gestures, photo navigation/deletion/disposal, framing, smoothing, file limits, pointer zoom/drag/pitch, snow wrap/twinkle/fade, effect builders and per-frame update against a stubbed THREE, pinned default sign, focus-index guard, denied permission, cancellation, shutdown and late-resource cleanup.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
