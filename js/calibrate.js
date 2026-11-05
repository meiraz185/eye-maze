// EYE MAZE — calibration + control check screens
import { Calibration, GazeEstimator, median } from './gaze.js';

// target positions (fractions of the screen) and their meaning in calibrated gaze units
export const TARGETS = [
  { id: 'center', fx: 0.5, fy: 0.5, gx: 0, gy: 0, text: 'Look at the dot.' },
  { id: 'left', fx: 0.06, fy: 0.5, gx: -1, gy: 0, text: 'Follow the dot with your eyes only.' },
  { id: 'right', fx: 0.94, fy: 0.5, gx: 1, gy: 0, text: 'Keep your head still.' },
  { id: 'up', fx: 0.5, fy: 0.08, gx: 0, gy: -1, text: 'Eyes up — head still.' },
  { id: 'down', fx: 0.5, fy: 0.92, gx: 0, gy: 1, text: 'Eyes down — head still.' },
];
const MOVE_MS = 550, SETTLE_MS = 650, COLLECT_MS = 1500, EXTEND_MS = 2500, HEAD_MS = 4500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class CalibrationUI {
  constructor(root, tracker) {
    this.root = root; this.tracker = tracker;
    this.dot = root.querySelector('.cal-dot');
    this.ring = root.querySelector('.cal-ring circle.fg');
    this.text = root.querySelector('.cal-text');
    this.sub = root.querySelector('.cal-sub');
    this.step = root.querySelector('.cal-step');
    this.arrows = root.querySelectorAll('.cal-arrow');
    this.cursor = root.querySelector('.cal-cursor');
    this.headMeter = root.querySelector('.cal-headmeter');
    this.cal = null;
    this.collecting = null;
    this.target = TARGETS[0];
    this.lastFrame = null;
  }

  /** frames from the tracker arrive here while calibrating */
  feed(frame) {
    this.lastFrame = frame;
    if (!this.collecting || !frame) return;
    const bucket = this.collecting;
    // reject blinks: eyelids much more closed than the frames already kept for this target
    const kept = this.cal.samples[bucket];
    if (kept.length >= 6) {
      const medOpen = median(kept.slice(-30).map((f) => f.open));
      if (frame.open < medOpen * 0.6) return;
    }
    if (frame.blink !== undefined && frame.blink > 0.6 && bucket !== 'down') return;
    this.cal.add(bucket, frame);
    if (bucket === 'head') this._headProgress();
  }

  _place(fx, fy) {
    this.dot.style.left = `${fx * 100}%`;
    this.dot.style.top = `${fy * 100}%`;
  }
  _progress(p) {
    const C = 2 * Math.PI * 22;
    this.ring.style.strokeDasharray = `${C}`;
    this.ring.style.strokeDashoffset = `${C * (1 - Math.max(0, Math.min(1, p)))}`;
  }
  _headProgress() {
    const H = this.cal.samples.head, c = this.cal.samples.center;
    if (!H.length || !c.length) return;
    const y0 = median(c.map((f) => f.yaw)), p0 = median(c.map((f) => f.pitch));
    const ry = Math.max(...H.map((f) => Math.abs(f.yaw - y0)));
    const rp = Math.max(...H.map((f) => Math.abs(f.pitch - p0)));
    this.headMeter.textContent = `head turn ${ry.toFixed(0)}°  ·  nod ${rp.toFixed(0)}°`;
  }

  /** run the full calibration. resolves {ok, model, quality, issues} */
  async run() {
    this.cal = new Calibration();
    this.root.hidden = false;
    this.root.classList.remove('checking');
    this.cursor.hidden = true;
    this.headMeter.hidden = true;
    this.dot.classList.remove('head');
    let i = 0;
    for (const t of TARGETS) {
      i++;
      this.target = t;
      this.step.textContent = `CALIBRATION  ${i} / ${TARGETS.length + 1}`;
      this.text.textContent = t.text;
      this.sub.textContent = '';
      this._place(t.fx, t.fy);
      this._progress(0);
      this.dot.classList.add('moving');
      if (this.tracker.kind === 'synthetic') this.tracker.follow = () => ({ x: t.gx, y: t.gy });
      await sleep(MOVE_MS);
      this.dot.classList.remove('moving');
      await sleep(SETTLE_MS);
      this.collecting = t.id;
      const t0 = performance.now();
      while (true) {
        const el = performance.now() - t0;
        const n = this.cal.count(t.id);
        this._progress(Math.min(el / COLLECT_MS, n / 30));
        if (el >= COLLECT_MS && n >= 20) break;
        if (el >= COLLECT_MS + EXTEND_MS) break;
        if (el > COLLECT_MS && n < 20) this.sub.textContent = this.lastFrame ? 'Hold still…' : 'Face not found — stay in view of the camera.';
        await sleep(40);
      }
      this.collecting = null;
      this.dot.classList.add('done');
      await sleep(150);
      this.dot.classList.remove('done');
    }

    // head-movement step: eyes stay on the dot, head moves -> learn how much head motion leaks into the eye signal
    this.step.textContent = `CALIBRATION  ${TARGETS.length + 1} / ${TARGETS.length + 1}`;
    this.text.textContent = 'Keep your eyes on the dot. Slowly turn your head a little left and right, then nod gently.';
    this.sub.textContent = 'This teaches the game to ignore head movement.';
    this._place(0.5, 0.5);
    this.dot.classList.add('head');
    this.headMeter.hidden = false;
    this.headMeter.textContent = '';
    this._progress(0);
    if (this.tracker.kind === 'synthetic') {
      const s0 = performance.now();
      this.tracker.follow = () => { const k = (performance.now() - s0) / HEAD_MS; return { x: 0, y: 0, yaw: 10 * Math.sin(k * Math.PI * 4), pitch: 7 * Math.sin(k * Math.PI * 2 + 1) }; };
    }
    await sleep(700);
    this.collecting = 'head';
    const h0 = performance.now();
    while (performance.now() - h0 < HEAD_MS) { this._progress((performance.now() - h0) / HEAD_MS); await sleep(40); }
    this.collecting = null;
    this.dot.classList.remove('head');
    this.headMeter.hidden = true;
    if (this.tracker.kind === 'synthetic') this.tracker.follow = () => ({ x: 0, y: 0 });

    const res = this.cal.compute();
    res.counts = Object.fromEntries(Object.entries(this.cal.samples).map(([k, v]) => [k, v.length]));
    return res;
  }

  /**
   * Control check: four arrows light up one at a time; the player looks at each one.
   * Shows a live gaze cursor so the player can see what the tracker thinks.
   * resolves { passed, results }
   */
  async check(est) {
    this.root.hidden = false;
    this.root.classList.add('checking');
    this.step.textContent = 'CONTROL CHECK';
    this.text.textContent = 'Look at the glowing arrow.';
    this.sub.textContent = 'The small ring shows where the game thinks you are looking.';
    this.cursor.hidden = false;
    this.dot.style.opacity = '0';
    const results = {};
    const order = ['left', 'right', 'up', 'down'];
    let raf;
    const moveCursor = () => {
      const o = est.out;
      this.cursor.style.left = `${50 + Math.max(-1.1, Math.min(1.1, o.x)) * 44}%`;
      this.cursor.style.top = `${50 + Math.max(-1.1, Math.min(1.1, o.y)) * 42}%`;
      this.cursor.dataset.dir = o.dir;
      raf = requestAnimationFrame(moveCursor);
    };
    moveCursor();
    for (const d of order) {
      const t = TARGETS.find((x) => x.id === d);
      const arrow = [...this.arrows].find((a) => a.dataset.dir === d);
      arrow.classList.add('active');
      if (this.tracker.kind === 'synthetic') this.tracker.follow = () => ({ x: t.gx * 0.85, y: t.gy * 0.85 });
      let held = 0, last = performance.now();
      const t0 = last;
      let ok = false;
      while (performance.now() - t0 < 7000) {
        await sleep(30);
        const now = performance.now();
        if (est.out.dir === d) held += now - last; else held = Math.max(0, held - (now - last) * 0.5);
        last = now;
        arrow.style.setProperty('--fill', `${Math.min(1, held / 500)}`);
        if (held >= 500) { ok = true; break; }
      }
      results[d] = ok;
      arrow.classList.remove('active');
      arrow.classList.add(ok ? 'pass' : 'fail');
      if (this.tracker.kind === 'synthetic') this.tracker.follow = () => ({ x: 0, y: 0 });
      // return to centre between arrows
      this.text.textContent = 'Back to the centre…';
      const c0 = performance.now();
      while (performance.now() - c0 < 2500 && est.out.dir !== 'center') await sleep(30);
      await sleep(250);
      this.text.textContent = 'Look at the glowing arrow.';
    }
    cancelAnimationFrame(raf);
    const passed = Object.values(results).filter(Boolean).length;
    return { passed, results };
  }

  reset() {
    this.arrows.forEach((a) => { a.classList.remove('active', 'pass', 'fail'); a.style.removeProperty('--fill'); });
    this.dot.style.opacity = '';
  }
  hide() { this.root.hidden = true; this.reset(); }
}

export function makeEstimator(model, opts) { return new GazeEstimator(model, opts); }
