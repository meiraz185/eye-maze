import test from 'node:test';
import assert from 'node:assert/strict';
import { Calibration, GazeEstimator, projectAxis, OneEuro } from '../js/gaze.js';
import { syntheticFrame, makeRng } from '../js/synthetic.js';

const TARGETS = { center: [0, 0], left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };

function calibrate({ seed = 1, mirror = false, headStep = true, noise = 1, flat = false } = {}) {
  const rnd = makeRng(seed);
  const cal = new Calibration();
  for (const [t, [gx, gy]] of Object.entries(TARGETS)) {
    for (let i = 0; i < 40; i++) {
      const f = syntheticFrame(flat ? 0 : gx, flat ? 0 : gy, { rnd, mirror, noise });
      cal.add(t, f);
    }
  }
  if (headStep) {
    // eyes fixed on the centre dot while the head turns and nods
    for (let i = 0; i < 90; i++) {
      const yaw = 10 * Math.sin(i / 90 * Math.PI * 4), pitch = 7 * Math.sin(i / 90 * Math.PI * 2 + 1);
      cal.add('head', syntheticFrame(0, 0, { yaw, pitch, rnd, mirror, noise }));
    }
  }
  return cal.compute();
}

/** run the estimator for `ms` at 30 fps with a constant true gaze; returns the direction history */
function run(est, gx, gy, ms, t0, opts = {}) {
  const rnd = opts.rnd || makeRng(7);
  const dirs = [];
  let t = t0;
  for (; t < t0 + ms; t += 33) {
    const f = opts.noFace ? null : syntheticFrame(gx, gy, { rnd, ...opts });
    dirs.push(est.update(f, t).dir);
  }
  return { dirs, t, last: dirs[dirs.length - 1], state: est.out.state };
}

test('calibration succeeds on a clean synthetic signal and learns both axes', () => {
  const r = calibrate();
  assert.ok(r.ok, r.issues.join(' '));
  assert.ok(r.model.quality.x > 0.5 && r.model.quality.y > 0.5, JSON.stringify(r.model.quality));
  // the calibration targets themselves map to about ±1
  const rnd = makeRng(3);
  const x = projectAxis(r.model.axes.x, syntheticFrame(1, 0, { rnd, noise: 0 }));
  const y = projectAxis(r.model.axes.y, syntheticFrame(0, -1, { rnd, noise: 0 }));
  assert.ok(Math.abs(x - 1) < 0.15, `x=${x}`);
  assert.ok(Math.abs(y + 1) < 0.15, `y=${y}`);
});

test('calibration rejects a signal with no eye movement', () => {
  const r = calibrate({ flat: true });
  assert.equal(r.ok, false);
  assert.ok(r.issues.length >= 2);
});

test('calibration rejects too few samples', () => {
  const cal = new Calibration();
  cal.add('center', syntheticFrame(0, 0));
  const r = cal.compute();
  assert.equal(r.ok, false);
});

test('mirrored camera: signs are learned, not assumed', () => {
  const r = calibrate({ mirror: true });
  assert.ok(r.ok);
  const est = new GazeEstimator(r.model);
  const a = run(est, -0.9, 0, 800, 0, { mirror: true });
  assert.equal(a.last, 'left');
});

test('each direction is detected and centre stops', () => {
  const { model } = calibrate();
  const est = new GazeEstimator(model);
  let t = 0;
  for (const [d, [gx, gy]] of Object.entries(TARGETS)) {
    const r = run(est, gx * 0.9, gy * 0.9, 700, t);
    t = r.t;
    assert.equal(r.last, d, `expected ${d}`);
  }
});

test('neutral dead zone: small gaze offsets do not move the ball', () => {
  const { model } = calibrate();
  const est = new GazeEstimator(model);
  for (const [gx, gy] of [[0.25, 0], [-0.25, 0], [0, 0.25], [0, -0.25], [0.2, 0.2]]) {
    const r = run(est, gx, gy, 1500, 0);
    assert.ok(r.dirs.every((d) => d === 'center'), `moved at ${gx},${gy}: ${[...new Set(r.dirs)]}`);
  }
});

test('steady centre gaze with noise never flickers into a direction', () => {
  const { model } = calibrate();
  const est = new GazeEstimator(model);
  const r = run(est, 0, 0, 20000, 0, { noise: 1.5, rnd: makeRng(99) });
  assert.ok(r.dirs.every((d) => d === 'center'), `flicker: ${r.dirs.filter((d) => d !== 'center').length} frames`);
});

test('hysteresis: once moving, a weaker gaze keeps moving; from rest it does not start', () => {
  const { model } = calibrate();
  const est = new GazeEstimator(model);
  let r = run(est, 0.9, 0, 600, 0);
  assert.equal(r.last, 'right');
  r = run(est, 0.47, 0, 1500, r.t);
  assert.ok(r.dirs.slice(5).every((d) => d === 'right'), 'kept moving');
  const est2 = new GazeEstimator(model);
  r = run(est2, 0.47, 0, 1500, 0);
  assert.ok(r.dirs.every((d) => d === 'center'), 'did not start');
});

test('diagonal gaze is ambiguous and does not start movement', () => {
  const { model } = calibrate();
  const est = new GazeEstimator(model);
  const r = run(est, 0.8, 0.8, 1500, 0, { noise: 0 });
  assert.ok(r.dirs.every((d) => d === 'center'));
});

test('debounce: a single-frame spike is ignored', () => {
  const { model } = calibrate();
  const est = new GazeEstimator(model, { smoothing: 50 }); // ~no smoothing, isolate the debounce
  const rnd = makeRng(4);
  let t = 0, dirs = [];
  for (let i = 0; i < 60; i++, t += 33) {
    const spike = i === 30 || i === 31;
    dirs.push(est.update(syntheticFrame(spike ? 1.2 : 0, 0, { rnd, noise: 0.3 }), t).dir);
  }
  assert.ok(dirs.every((d) => d === 'center'), dirs.join(','));
});

test('head turn while looking at the centre does not steer (compensation)', () => {
  const { model } = calibrate();
  assert.ok(Math.abs(model.head.kx) > 0.02, `kx learned: ${model.head.kx}`);
  const est = new GazeEstimator(model);
  const r = run(est, 0, 0, 2000, 0, { yaw: 13 });
  assert.ok(r.dirs.every((d) => d === 'center'), `steered: ${[...new Set(r.dirs)]}`);
  // without the head step the same head turn WOULD be read as gaze
  const { model: noHead } = calibrate({ headStep: false });
  const est2 = new GazeEstimator(noHead);
  const r2 = run(est2, 0, 0, 2000, 0, { yaw: 13 });
  assert.notEqual(r2.last, 'center', 'control: uncompensated head turn is misread');
});

test('large head rotation pauses movement with a "head" state', () => {
  const { model } = calibrate();
  const est = new GazeEstimator(model);
  let r = run(est, 0.9, 0, 600, 0);
  assert.equal(r.last, 'right');
  r = run(est, 0.9, 0, 600, r.t, { yaw: 24 });
  assert.equal(r.last, 'center');
  assert.equal(r.state, 'head');
});

test('fast head motion is suppressed', () => {
  const { model } = calibrate();
  const est = new GazeEstimator(model);
  const rnd = makeRng(5);
  let t = 0;
  for (; t < 500; t += 33) est.update(syntheticFrame(0, 0, { rnd }), t);
  const states = [];
  for (let i = 0; i < 8; i++, t += 33) { // 6° per frame ≈ 180°/s
    states.push(est.update(syntheticFrame(0, 0, { rnd, yaw: i * 6 > 12 ? 12 : i * 6 }), t));
  }
  assert.ok(states.some((s) => s.state === 'headmove'));
  assert.ok(states.every((s) => s.dir === 'center'));
});

test('short blink keeps direction, long eye closure stops', () => {
  const { model } = calibrate();
  const est = new GazeEstimator(model);
  let r = run(est, 0, -0.9, 700, 0);
  assert.equal(r.last, 'up');
  r = run(est, 0, -0.9, 200, r.t, { blink: true });
  assert.equal(r.last, 'up', 'short blink');
  assert.equal(r.state, 'blink');
  r = run(est, 0, -0.9, 900, r.t, { blink: true });
  assert.equal(r.last, 'center', 'long closure');
});

test('looking down is not mistaken for a blink', () => {
  const { model } = calibrate();
  const est = new GazeEstimator(model);
  const r = run(est, 0, 1.0, 1200, 0);
  assert.equal(r.last, 'down');
  assert.equal(r.state, 'ok');
});

test('lost face stops the ball', () => {
  const { model } = calibrate();
  const est = new GazeEstimator(model);
  let r = run(est, 0.9, 0, 700, 0);
  assert.equal(r.last, 'right');
  r = run(est, 0, 0, 600, r.t, { noFace: true });
  assert.equal(r.last, 'center');
  assert.equal(r.state, 'noface');
});

test('confidence is high when steady, lower under noise and head deviation', () => {
  const { model } = calibrate();
  const conf = (opts) => { const e = new GazeEstimator(model); run(e, 0, 0, 2000, 0, opts); return e.out.confidence; };
  const clean = conf({ noise: 0.5 }), noisy = conf({ noise: 6 }), head = conf({ yaw: 13 });
  assert.ok(clean > 0.6, `clean ${clean}`);
  assert.ok(noisy < clean, `noisy ${noisy}`);
  assert.ok(head < clean, `head ${head}`);
});

test('One Euro filter converges to a step input', () => {
  const f = new OneEuro(1.2, 0.4);
  let v = 0;
  for (let t = 0; t < 1000; t += 33) v = f.filter(t < 100 ? 0 : 1, t);
  assert.ok(Math.abs(v - 1) < 0.02);
});
