// EYE MAZE — synthetic eye model, used ONLY by the automated tests and the keyboard test mode.
// It produces feature frames shaped like real Face Landmarker output so the whole
// calibration -> estimator -> game pipeline can be exercised without a camera.
// It is NOT a model of any real person's eyes and proves nothing about real-camera accuracy.

export function makeRng(seed = 1) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function gauss(rnd) {
  let u = 0, v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * gx, gy: true gaze in screen terms (-1 = left/up calibration target, +1 = right/down)
 * yaw, pitch: head rotation in degrees (eyes counter-rotate to keep looking at the same spot)
 */
export function syntheticFrame(gx, gy, { yaw = 0, pitch = 0, noise = 1, rnd = Math.random, mirror = false, blink = false } = {}) {
  const n = (s) => gauss(rnd) * s * noise;
  const sx = mirror ? -1 : 1;
  // eye-in-head rotation = screen gaze minus head rotation (approx. 20° per calibrated unit)
  const ex = gx - yaw / 20, ey = gy - pitch / 20;
  return {
    ih: 0.5 + sx * 0.055 * ex + n(0.006),
    iv: 0.01 + 0.018 * ey + n(0.004),
    open: blink ? 0.04 : 0.29 - 0.05 * ey + n(0.006),
    bh: sx * 0.35 * ex + n(0.04),
    bv: 0.4 * ey + n(0.05),
    yaw: yaw + n(0.6),
    pitch: pitch + n(0.6),
    roll: n(0.5),
    faceSize: 0.5,
    headSource: 'synthetic',
  };
}
