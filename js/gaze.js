// EYE MAZE — gaze math (pure, no DOM; runs in browser and in Node tests)
//
// Pipeline:  face landmarks (+ blendshapes, head matrix)
//            -> extractFeatures()     eye-local features, invariant to head translation/scale/roll
//            -> Calibration.compute() per-axis model from the 5 calibration targets + head check
//            -> GazeEstimator.update() head compensation, smoothing, dead zone, hysteresis, debounce

// MediaPipe Face Landmarker indices (478-point mesh with iris refinement)
export const LM = {
  // eye on the IMAGE-LEFT side (subject's right eye): outer corner 33, inner corner 133
  A_C1: 33, A_C2: 133, A_UP: 159, A_LO: 145, A_IRIS: [468, 469, 470, 471, 472],
  // eye on the IMAGE-RIGHT side (subject's left eye): inner corner 362, outer corner 263
  B_C1: 362, B_C2: 263, B_UP: 386, B_LO: 374, B_IRIS: [473, 474, 475, 476, 477],
  NOSE: 1, CHEEK_L: 234, CHEEK_R: 454, FOREHEAD: 10, CHIN: 152,
};

export const DIRS = ['center', 'left', 'right', 'up', 'down'];
const AXES = {
  // positive end = right / down (screen coordinates)
  x: { neg: 'left', pos: 'right', features: ['ih', 'bh'] },
  y: { neg: 'up', pos: 'down', features: ['iv', 'bv', 'open'] },
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mean = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
export function median(arr) {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const mad = (arr, m = median(arr)) => median(arr.map((v) => Math.abs(v - m)));

function eyeFeatures(P, c1, c2, up, lo, irisIdx) {
  const A = P[c1], B = P[c2];
  const ux0 = B.x - A.x, uy0 = B.y - A.y;
  const w = Math.hypot(ux0, uy0) || 1e-6;
  const ux = ux0 / w, uy = uy0 / w; // along the eye (image left -> right)
  const nx = -uy, ny = ux;          // perpendicular (image down)
  let ix = 0, iy = 0;
  for (const i of irisIdx) { ix += P[i].x; iy += P[i].y; }
  ix /= irisIdx.length; iy /= irisIdx.length;
  const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
  const h = ((ix - A.x) * ux + (iy - A.y) * uy) / w;   // 0..1, ~0.5 when centred
  const v = ((ix - mx) * nx + (iy - my) * ny) / w;     // ~0, + = iris lower in the eye
  const open = ((P[lo].x - P[up].x) * nx + (P[lo].y - P[up].y) * ny) / w; // lid aperture
  return { h, v, open, w };
}

function headFromLandmarks(P) {
  // rough fallback head pose (degrees-ish) when no transformation matrix is available
  const n = P[LM.NOSE], l = P[LM.CHEEK_L], r = P[LM.CHEEK_R], f = P[LM.FOREHEAD], c = P[LM.CHIN];
  const fw = Math.hypot(r.x - l.x, r.y - l.y) || 1e-6;
  const fh = Math.hypot(c.x - f.x, c.y - f.y) || 1e-6;
  const yaw = (((n.x - l.x) / (r.x - l.x || 1e-6)) - 0.5) * 90;
  const pitch = (((n.y - f.y) / (c.y - f.y || 1e-6)) - 0.5) * 90;
  const roll = Math.atan2(r.y - l.y, r.x - l.x) * 180 / Math.PI;
  return { yaw, pitch, roll, faceSize: (fw + fh) / 2 };
}

export function headFromMatrix(data) {
  // MediaPipe Matrix.data is column-major 4x4; forward axis = 3rd column of rotation
  if (!data || data.length < 16) return null;
  const fx = data[8], fy = data[9], fz = data[10];
  const yaw = Math.atan2(fx, fz) * 180 / Math.PI;
  const pitch = Math.atan2(-fy, Math.hypot(fx, fz)) * 180 / Math.PI;
  return { yaw, pitch };
}

/**
 * Turn one Face Landmarker result into a feature frame.
 * @param landmarks  array of {x,y,z} in normalised image coords
 * @param aspect     video width / height (landmarks are normalised separately per axis)
 * @param blend      optional blendshape categories [{categoryName, score}]
 * @param matrix     optional facial transformation matrix data (16 numbers)
 */
export function extractFeatures(landmarks, aspect = 4 / 3, blend = null, matrix = null) {
  if (!landmarks || landmarks.length < 478) return null;
  const P = landmarks.map((p) => ({ x: p.x * aspect, y: p.y }));
  const a = eyeFeatures(P, LM.A_C1, LM.A_C2, LM.A_UP, LM.A_LO, LM.A_IRIS);
  const b = eyeFeatures(P, LM.B_C1, LM.B_C2, LM.B_UP, LM.B_LO, LM.B_IRIS);
  const lmHead = headFromLandmarks(P);
  const mHead = headFromMatrix(matrix);
  const f = {
    ih: (a.h + b.h) / 2,
    iv: (a.v + b.v) / 2,
    open: (a.open + b.open) / 2,
    eyeAsym: Math.abs(a.h - b.h),
    yaw: mHead ? mHead.yaw : lmHead.yaw,
    pitch: mHead ? mHead.pitch : lmHead.pitch,
    roll: lmHead.roll,
    faceSize: lmHead.faceSize,
    headSource: mHead ? 'matrix' : 'landmarks',
  };
  if (blend && blend.length) {
    const s = {};
    for (const c of blend) s[c.categoryName] = c.score;
    if (s.eyeLookOutLeft !== undefined) {
      // NOTE: sign does not matter — calibration learns it
      f.bh = ((s.eyeLookOutLeft + s.eyeLookInRight) - (s.eyeLookInLeft + s.eyeLookOutRight)) / 2;
      f.bv = ((s.eyeLookDownLeft + s.eyeLookDownRight) - (s.eyeLookUpLeft + s.eyeLookUpRight)) / 2;
      f.blink = ((s.eyeBlinkLeft || 0) + (s.eyeBlinkRight || 0)) / 2;
    }
  }
  return f;
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------
export class Calibration {
  constructor() {
    this.samples = { center: [], left: [], right: [], up: [], down: [], head: [] };
  }
  add(target, frame) {
    if (frame && this.samples[target]) this.samples[target].push(frame);
  }
  count(target) { return this.samples[target].length; }

  /** Returns { ok, model, quality, issues } */
  compute() {
    const issues = [];
    const S = this.samples;
    for (const t of DIRS) {
      if (S[t].length < 8) issues.push(`Not enough samples for "${t}" (${S[t].length}).`);
    }
    if (issues.length) return { ok: false, model: null, quality: 0, issues };

    const stat = (t, k) => {
      const vals = S[t].map((s) => s[k]).filter((v) => Number.isFinite(v));
      return vals.length >= 5 ? { med: median(vals), mad: mad(vals), n: vals.length } : null;
    };

    const model = { axes: {}, head: {}, blinkOpen: 0, version: 2 };
    for (const [axisName, ax] of Object.entries(AXES)) {
      const feats = [];
      for (const k of ax.features) {
        const c = stat('center', k), n = stat(ax.neg, k), p = stat(ax.pos, k);
        if (!c || !n || !p) continue;
        const noise = Math.max(1.4826 * mean([c.mad, n.mad, p.mad]), 1e-4);
        const dPos = p.med - c.med, dNeg = c.med - n.med;
        const monotonic = Math.sign(dPos) === Math.sign(dNeg) && dPos !== 0;
        const sep = Math.min(Math.abs(dPos), Math.abs(dNeg)) / noise; // signal-to-noise
        const weight = monotonic && sep >= 1.5 ? Math.min(sep, 12) : 0;
        feats.push({ key: k, c: c.med, dPos, dNeg, noise, sep, weight, monotonic });
      }
      const total = feats.reduce((s, f) => s + f.weight, 0);
      model.axes[axisName] = { feats, total };
      if (total < 2) issues.push(`Weak ${axisName === 'x' ? 'left/right' : 'up/down'} signal — try larger eye movements, more light, or move closer.`);
    }

    // neutral head pose from the centre samples
    const yc = stat('center', 'yaw'), pc = stat('center', 'pitch');
    model.head.yaw0 = yc ? yc.med : 0;
    model.head.pitch0 = pc ? pc.med : 0;
    const fs = stat('center', 'faceSize');
    model.head.faceSize0 = fs ? fs.med : 0;

    // head-compensation slopes from the "keep looking at the dot, move your head" step
    model.head.kx = 0; model.head.ky = 0; model.head.range = { yaw: 0, pitch: 0 };
    const H = S.head.filter(Boolean);
    if (H.length >= 15) {
      const proj = (frames, axis) => frames.map((fr) => projectAxis(model.axes[axis], fr));
      const fit = (xs, ys) => {
        const mx = mean(xs), my = mean(ys);
        let sxx = 0, sxy = 0;
        for (let i = 0; i < xs.length; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
        return sxx > 1e-6 ? sxy / sxx : 0;
      };
      const yaws = H.map((f) => f.yaw - model.head.yaw0);
      const pitches = H.map((f) => f.pitch - model.head.pitch0);
      const ry = Math.max(...yaws) - Math.min(...yaws);
      const rp = Math.max(...pitches) - Math.min(...pitches);
      model.head.range = { yaw: ry, pitch: rp };
      // only trust a slope if the user actually moved their head enough
      if (ry >= 6) model.head.kx = clamp(fit(yaws, proj(H, 'x')), -0.15, 0.15);
      if (rp >= 5) model.head.ky = clamp(fit(pitches, proj(H, 'y')), -0.15, 0.15);
    }

    // blink threshold: well below the smallest "open" seen (looking down narrows the eyes)
    const opens = ['center', 'down', 'up', 'left', 'right'].map((t) => stat(t, 'open')).filter(Boolean).map((s) => s.med);
    model.blinkOpen = Math.min(...opens) * 0.55;

    // per-axis quality 0..1
    const q = (tot) => clamp((tot - 1) / 7, 0, 1);
    const quality = Math.min(q(model.axes.x.total), q(model.axes.y.total));
    model.quality = { x: q(model.axes.x.total), y: q(model.axes.y.total), overall: quality };
    const ok = model.axes.x.total >= 2 && model.axes.y.total >= 2;
    return { ok, model, quality, issues };
  }
}

/** Map a feature frame onto one calibrated axis: -1 at the neg target, 0 centre, +1 pos target. */
export function projectAxis(axis, f) {
  if (!axis || !axis.total) return 0;
  let s = 0, w = 0;
  for (const ft of axis.feats) {
    if (!ft.weight) continue;
    const v = f[ft.key];
    if (!Number.isFinite(v)) continue;
    const d = v - ft.c;
    const span = (d >= 0) === (ft.dPos >= 0) ? Math.abs(ft.dPos) : Math.abs(ft.dNeg);
    const val = (d * Math.sign(ft.dPos)) / (span || 1e-6);
    s += clamp(val, -2.5, 2.5) * ft.weight;
    w += ft.weight;
  }
  return w ? s / w : 0;
}

// ---------------------------------------------------------------------------
// One Euro filter (Casiez et al.) — low lag when moving, low jitter when still
// ---------------------------------------------------------------------------
export class OneEuro {
  constructor(minCutoff = 1.2, beta = 0.4, dCutoff = 1.0) {
    Object.assign(this, { minCutoff, beta, dCutoff });
    this.reset();
  }
  reset() { this.x = null; this.dx = 0; this.t = null; }
  static alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  filter(v, tMs) {
    if (this.x === null) { this.x = v; this.t = tMs; return v; }
    const dt = Math.max((tMs - this.t) / 1000, 1e-3);
    this.t = tMs;
    const dv = (v - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dv - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (v - this.x);
    return this.x;
  }
}

export const DEFAULT_OPTS = {
  enter: 0.55,          // |gaze| needed to start moving in a direction (calibrated units: 1 = target)
  exit: 0.36,           // |gaze| below this stops movement (neutral dead zone)
  dominance: 1.2,       // the winning axis must be this much stronger than the other
  dwellMs: 140,         // a new direction must persist this long before it is accepted
  centerDwellMs: 90,    // returning to centre is accepted faster (stopping feels responsive)
  smoothing: 1.2,       // One Euro min cutoff (Hz); lower = smoother but laggier
  headYawLimit: 15,     // degrees from the calibrated head pose before movement pauses
  headPitchLimit: 13,
  headSpeedLimit: 70,   // deg/s — fast head motion is ignored as gaze
  headSpeedHoldMs: 250,
  blinkHoldMs: 350,     // keep the last direction through a short blink, then stop
  lostMs: 400,          // face missing longer than this -> stop
};

export class GazeEstimator {
  constructor(model, opts = {}) {
    this.model = model;
    this.opts = { ...DEFAULT_OPTS, ...opts };
    this.fx = new OneEuro(this.opts.smoothing, 0.4);
    this.fy = new OneEuro(this.opts.smoothing, 0.4);
    this.dir = 'center';
    this.candidate = 'center';
    this.candidateSince = 0;
    this.lastFaceT = -1e9;
    this.blinkSince = null;
    this.headHoldUntil = 0;
    this.prevHead = null;
    this.jitter = 0;
    this.last = { x: 0, y: 0 };
    this.out = this._out('noface', 0, 0, 0, 0, 0);
  }
  setOpts(o) {
    Object.assign(this.opts, o);
    this.fx.minCutoff = this.fy.minCutoff = this.opts.smoothing;
  }
  _out(state, x, y, rawX, rawY, confidence, extra = {}) {
    return { dir: this.dir, state, x, y, rawX, rawY, confidence, candidate: this.candidate, ...extra };
  }
  /** feed one frame (or null when no face); returns the current decision */
  update(f, tMs) {
    const o = this.opts, m = this.model;
    if (!f) {
      if (tMs - this.lastFaceT > o.lostMs) this._commit('center', tMs, true);
      return (this.out = this._out('noface', this.last.x, this.last.y, 0, 0, 0));
    }
    this.lastFaceT = tMs;

    // head pose relative to calibration (lightly smoothed: raw pose is jittery frame to frame)
    if (!this.headF) this.headF = { yaw: f.yaw, pitch: f.pitch };
    this.headF.yaw += 0.4 * (f.yaw - this.headF.yaw);
    this.headF.pitch += 0.4 * (f.pitch - this.headF.pitch);
    const hy = this.headF.yaw, hp = this.headF.pitch;
    const dYaw = hy - m.head.yaw0, dPitch = hp - m.head.pitch0;
    // head speed measured over ~100 ms so single-frame noise does not count as motion
    this.headHist = (this.headHist || []).filter((h) => tMs - h.t <= 160);
    this.headHist.push({ yaw: hy, pitch: hp, t: tMs });
    const old = this.headHist[0];
    if (tMs - old.t >= 80) {
      const speed = Math.hypot(hy - old.yaw, hp - old.pitch) / ((tMs - old.t) / 1000);
      if (speed > o.headSpeedLimit) this.headHoldUntil = tMs + o.headSpeedHoldMs;
    }
    const headDev = Math.max(Math.abs(dYaw) / o.headYawLimit, Math.abs(dPitch) / o.headPitchLimit);
    const headInfo = { dYaw, dPitch, headDev };

    // blink: eyes closed -> features unreliable
    const blinking = f.open < m.blinkOpen;
    if (blinking) {
      if (this.blinkSince === null) this.blinkSince = tMs;
      if (tMs - this.blinkSince > o.blinkHoldMs) this._commit('center', tMs, true);
      return (this.out = this._out('blink', this.last.x, this.last.y, 0, 0, 0.2, headInfo));
    }
    this.blinkSince = null;

    // calibrated gaze, with head-rotation compensation
    let rawX = projectAxis(m.axes.x, f) - m.head.kx * dYaw;
    let rawY = projectAxis(m.axes.y, f) - m.head.ky * dPitch;
    const x = this.fx.filter(rawX, tMs), y = this.fy.filter(rawY, tMs);
    this.jitter = 0.9 * this.jitter + 0.1 * Math.hypot(rawX - x, rawY - y);
    this.last = { x, y };

    // confidence (heuristic, 0..1)
    const stability = clamp(1 - this.jitter / 0.6, 0, 1);
    const headF = clamp(1.25 - headDev, 0, 1);
    const calQ = 0.4 + 0.6 * (m.quality ? m.quality.overall : 0.5);
    const confidence = clamp(stability * headF * calQ, 0, 1);

    if (headDev > 1) {
      this._commit('center', tMs, true);
      return (this.out = this._out('head', x, y, rawX, rawY, confidence, headInfo));
    }
    if (tMs < this.headHoldUntil) {
      this._commit('center', tMs, true);
      return (this.out = this._out('headmove', x, y, rawX, rawY, confidence, headInfo));
    }

    this._commit(this._decide(x, y), tMs, false);
    return (this.out = this._out('ok', x, y, rawX, rawY, confidence, headInfo));
  }
  _decide(x, y) {
    const o = this.opts, ax = Math.abs(x), ay = Math.abs(y);
    const cur = this.dir;
    // keep the current direction while it is still above the exit threshold (hysteresis)
    if (cur !== 'center') {
      const v = cur === 'left' ? -x : cur === 'right' ? x : cur === 'up' ? -y : y;
      const other = cur === 'left' || cur === 'right' ? ay : ax;
      if (v > o.exit && v * o.dominance >= other) return cur;
    }
    if (ax < o.exit && ay < o.exit) return 'center';                  // neutral dead zone
    if (ax >= o.enter && ax >= ay * o.dominance) return x < 0 ? 'left' : 'right';
    if (ay >= o.enter && ay >= ax * o.dominance) return y < 0 ? 'up' : 'down';
    return 'center'; // ambiguous (diagonal) or not far enough: stay still
  }
  _commit(next, tMs, immediate) {
    if (immediate) { this.candidate = next; this.dir = next; this.candidateSince = tMs; return; }
    if (next !== this.candidate) { this.candidate = next; this.candidateSince = tMs; }
    const need = next === 'center' ? this.opts.centerDwellMs : this.opts.dwellMs;
    if (next !== this.dir && tMs - this.candidateSince >= need) this.dir = next;
  }
}
