// EYE MAZE — app flow: start → camera → position → calibration → check → play → success
import { LEVELS, buildLevel, updatePhaseCharge } from './levels.js';
import { makeBall, stepBall, reachedGoal } from './physics.js';
import { Renderer } from './render.js';
import { CameraTracker, SyntheticTracker } from './tracker.js';
import { CalibrationUI } from './calibrate.js';
import { GazeEstimator, DEFAULT_OPTS } from './gaze.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const TEST = params.has('test');
const PLAYLIST = LEVELS;

const app = {
  phase: 'start',
  tracker: null, est: null, model: null, calUI: null,
  levelIdx: 0, maze: null, ball: null, levelTime: 0, times: [],
  pauseMs: 0, moving: false, charge: { H: 0, V: 0, axis: null },
  settings: { sens: 1, smooth: DEFAULT_OPTS.smoothing, speed: 1 },
  readyHold: 0, debug: params.has('debug'),
};
window.eyeMaze = app; // handy in the console; used by the automated browser test

const renderer = new Renderer($('stage'));
const video = $('cam');

// ---------------------------------------------------------------- screens
const SCREENS = ['screen-start', 'screen-permission', 'screen-position', 'screen-calresult', 'screen-ready', 'screen-success'];
function show(id) {
  for (const s of SCREENS) $(s).hidden = s !== id;
}
function toast(msg, ms = 2600) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}

// ---------------------------------------------------------------- start
if (TEST) {
  $('btn-start').textContent = 'Start test mode';
  $('link-test').textContent = 'Back to camera mode';
  $('link-test').href = location.pathname;
  const w = $('proto-warn');
  w.hidden = false;
  w.textContent = 'TEST MODE — no camera. Synthetic eyes follow the calibration dots automatically; during play use the arrow keys to simulate looking. This checks the game, not real eye tracking.';
}
if (!window.isSecureContext) {
  const w = $('proto-warn'); w.hidden = false;
  w.textContent = 'Camera access needs https:// or http://localhost. Serve this folder with a local server (see README) or use GitHub Pages.';
}
$('btn-start').addEventListener('click', startTracking);
$('btn-retry').addEventListener('click', startTracking);
$('btn-pos-go').addEventListener('click', () => { if (app.phase === 'position') beginCalibration(); });
$('btn-cr-retry').addEventListener('click', beginCalibration);
$('btn-recal').addEventListener('click', () => { if (['play', 'ready'].includes(app.phase)) beginCalibration(); });
$('btn-succ-again').addEventListener('click', () => restart());
$('btn-succ-recal').addEventListener('click', () => { app.levelIdx = 0; app.times = []; beginCalibration(); });
$('btn-debug').addEventListener('click', () => toggleDebug());
addEventListener('keydown', (e) => { if (e.key === 'd' || e.key === 'D') toggleDebug(); });

async function startTracking() {
  if (app.tracker) return;
  show('screen-permission');
  $('perm-actions').hidden = true;
  $('perm-title').textContent = TEST ? 'Test mode' : 'Camera access';
  $('perm-msg').innerHTML = TEST ? 'Starting synthetic eyes…' : 'Your browser will ask to use the camera. Choose <b>Allow</b>.';
  const tracker = TEST ? new SyntheticTracker() : new CameraTracker(video);
  tracker.onFrame(onFrame);
  try {
    await tracker.start((s) => { $('perm-msg').textContent = s; });
    app.tracker = tracker;
    app.calUI = new CalibrationUI($('calib'), tracker);
    $('dbg-src').textContent = TEST ? 'synthetic' : `${tracker.delegate} · model ${tracker.modelSource}`;
    if (TEST) beginCalibration(); else enterPosition();
  } catch (err) {
    console.error(err);
    try { tracker.stop(); } catch (e) { /* ignore */ }
    $('perm-title').textContent = 'Could not start';
    $('perm-msg').innerHTML = explainError(err);
    $('perm-actions').hidden = false;
  }
}

function explainError(err) {
  const n = err && err.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'Camera permission was blocked. Click the camera icon in the address bar, allow access for this page, then try again.';
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'No camera was found. Connect a webcam and try again.';
  if (n === 'NotReadableError') return 'The camera is busy — close other apps or tabs using it (video calls, Photo Booth…) and try again.';
  if (err && err.code === 'nocamapi') return err.message;
  return `The face tracking model could not load (${(err && err.message) || err}). The model file is downloaded from Google the first time — check your internet connection, or place <b>face_landmarker.task</b> in the <b>models/</b> folder (see README).`;
}

// ---------------------------------------------------------------- tracking frames
function onFrame(frame, t) {
  if (app.phase === 'calibrating') app.calUI.feed(frame);
  if (app.est) app.est.update(frame, t);
}

// ---------------------------------------------------------------- position screen
function enterPosition() {
  app.phase = 'position';
  app.posStart = performance.now();
  show('screen-position');
  const cv = $('preview'), g = cv.getContext('2d');
  let goodSince = null;
  const loop = () => {
    if (app.phase !== 'position') return;
    drawPreview(g, cv.width, cv.height, true);
    const last = app.tracker.last;
    const st = $('pos-status'), btn = $('btn-pos-go');
    if (!last || !last.frame) {
      st.textContent = 'Looking for your face…'; st.className = 'status bad'; btn.disabled = true; goodSince = null;
    } else {
      const f = last.frame;
      const size = f.faceSize; // ~face width in normalised (aspect-corrected) units
      let msg = 'Face found. Hold still…', ok = true;
      if (size < 0.28) { msg = 'Move a little closer to the camera.'; ok = false; }
      else if (size > 0.75) { msg = 'Move back a little.'; ok = false; }
      else if (Math.abs(f.roll) > 12) { msg = 'Level your head.'; ok = false; }
      btn.disabled = false;
      const slow = app.tracker.fps > 0 && app.tracker.fps < 12 && performance.now() - (app.posStart || 0) > 3000 ? ` (tracking is slow: ${app.tracker.fps.toFixed(0)} fps — close other tabs)` : '';
      if (ok) {
        goodSince = goodSince ?? performance.now();
        const left = 3 - Math.floor((performance.now() - goodSince) / 1000);
        st.textContent = (left > 0 ? `Face found. Calibration starts in ${left}…` : 'Starting…') + slow;
        st.className = 'status ok';
        if (left <= 0) { beginCalibration(); return; }
      } else { st.textContent = msg; st.className = 'status bad'; goodSince = null; }
    }
    requestAnimationFrame(loop);
  };
  loop();
}

const EYE_IDX = [33, 133, 159, 145, 362, 263, 386, 374, 468, 473];
function drawPreview(g, w, h, oval) {
  g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
  if (app.tracker.kind !== 'camera' || !video.videoWidth) {
    g.fillStyle = 'rgba(232,242,255,0.4)'; g.font = '11px monospace'; g.textAlign = 'center';
    g.fillText(app.tracker.kind === 'synthetic' ? 'synthetic eyes' : 'no video', w / 2, h / 2);
    return;
  }
  g.save(); g.translate(w, 0); g.scale(-1, 1); // mirror, like a mirror
  g.drawImage(video, 0, 0, w, h);
  const lm = app.tracker.last && app.tracker.last.landmarks;
  if (lm) {
    for (const i of EYE_IDX) {
      g.fillStyle = i >= 468 ? '#5ff2ff' : 'rgba(255,255,255,0.8)';
      g.beginPath(); g.arc(lm[i].x * w, lm[i].y * h, i >= 468 ? 2.2 : 1.4, 0, Math.PI * 2); g.fill();
    }
  }
  g.restore();
}

// ---------------------------------------------------------------- calibration + check
let calibRun = 0;
async function beginCalibration() {
  const run = ++calibRun;
  app.phase = 'calibrating';
  show(null);
  $('hud').hidden = true; $('pause').hidden = true;
  const res = await app.calUI.run();
  if (run !== calibRun) return;
  app.calUI.hide();
  app.model = res.model;
  console.info('[EYE MAZE] calibration', res);
  if (!res.ok) {
    app.phase = 'calresult';
    $('cr-title').textContent = 'Calibration needs another go';
    $('cr-msg').textContent = 'The tracker could not see a clear difference between some of the directions.';
    $('cr-issues').innerHTML = res.issues.map((s) => `<li>${s}</li>`).join('');
    $('btn-cr-go').textContent = 'Continue anyway';
    $('btn-cr-go').onclick = () => res.model ? runCheck() : beginCalibration();
    show('screen-calresult');
    return;
  }
  runCheck();
}

async function runCheck() {
  const run = calibRun;
  app.est = new GazeEstimator(app.model, estOpts());
  app.phase = 'checking';
  show(null);
  app.calUI.reset();
  const r = await app.calUI.check(app.est);
  if (run !== calibRun) return;
  app.calUI.hide();
  if (r.passed < 4) {
    app.phase = 'calresult';
    const missing = Object.entries(r.results).filter(([, v]) => !v).map(([k]) => k);
    $('cr-title').textContent = `${r.passed} of 4 directions recognised`;
    $('cr-msg').textContent = r.passed >= 3
      ? `"${missing.join('", "')}" was hard to detect. You can play anyway — open the debug panel to raise the sensitivity — or recalibrate.`
      : 'Eye control looks unreliable. Recalibrating usually helps: even light on your face, camera at eye level, larger eye movements.';
    $('cr-issues').innerHTML = '';
    $('btn-cr-go').textContent = 'Play anyway';
    $('btn-cr-go').onclick = () => enterReady();
    show('screen-calresult');
    return;
  }
  enterReady();
}

function estOpts() {
  const s = app.settings.sens;
  return { enter: DEFAULT_OPTS.enter / s, exit: DEFAULT_OPTS.exit / s, smoothing: app.settings.smooth };
}

// ---------------------------------------------------------------- levels
function loadLevel(i) {
  app.levelIdx = i;
  const def = PLAYLIST[i];
  app.def = def;
  app.maze = buildLevel(def, { portrait: innerHeight > innerWidth * 1.1 });
  app.ball = makeBall(app.maze.start);
  app.levelTime = 0;
  app.charge = { H: 0, V: 0, axis: null };
  renderer.layout(app.maze);
  $('hud-level').textContent = `LEVEL ${i + 1}/${PLAYLIST.length}`;
  $('hud-name').textContent = def.name;
  $('hud-hint').textContent = def.hint;
  $('hud-hint').style.opacity = 1;
  $('hud-mode').hidden = !app.maze.phases.length;
}

function enterReady() {
  if (!app.maze || app.maze.levelId !== app.levelIdx) { loadLevel(app.levelIdx); app.maze.levelId = app.levelIdx; }
  app.phase = 'ready';
  app.readyHold = 0;
  const def = PLAYLIST[app.levelIdx];
  $('ready-title').textContent = `LEVEL ${app.levelIdx + 1}`;
  $('ready-name').textContent = def.name;
  $('ready-hint').textContent = def.hint;
  $('ready-sub').textContent = 'Look at the centre to begin';
  $('hud').hidden = false;
  show('screen-ready');
  if (app.tracker.kind === 'synthetic') app.tracker.follow = null;
}

function startPlay() {
  app.phase = 'play';
  show(null);
  app.playStart = performance.now();
  setTimeout(() => ($('hud-hint').style.opacity = 0), 7000);
}

function levelComplete() {
  app.phase = 'transition';
  app.times[app.levelIdx] = app.levelTime;
  renderer.emit(app.ball.x, app.ball.y, 90, [61, 255, 138], 1.6, 1.4);
  renderer.ripple(app.ball.x, app.ball.y, [61, 255, 138]);
  toast(`${app.def.name} — ${fmt(app.levelTime)}`, 1800);
  setTimeout(() => {
    if (app.levelIdx + 1 < PLAYLIST.length) {
      app.levelIdx++;
      enterReady();
      $('ready-sub').textContent = 'Look at the centre to begin';
    } else {
      showSuccess();
    }
  }, 1800);
}

function showSuccess() {
  app.phase = 'success';
  $('hud').hidden = true;
  const total = app.times.reduce((s, t) => s + (t || 0), 0);
  $('succ-title').textContent = PLAYLIST.length > 1 ? 'You found the way out.' : 'Maze complete.';
  $('succ-times').innerHTML = PLAYLIST.map((d, i) => `<li>${d.name} <b>${fmt(app.times[i] || 0)}</b></li>`).join('') +
    (PLAYLIST.length > 1 ? `<li>TOTAL <b>${fmt(total)}</b></li>` : '');
  app.succHold = 0;
  show('screen-success');
}

function restart() {
  app.levelIdx = 0; app.times = []; app.maze = null;
  enterReady();
}

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}.${Math.floor((s % 1) * 10)}`;

// ---------------------------------------------------------------- main loop
let lastT = performance.now(), dbgT = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  const o = app.est ? app.est.out : null;
  const tracking = o && (o.state === 'ok' || o.state === 'blink');
  let dir = 'center';

  if (app.phase === 'ready' && o) {
    const centred = o.state === 'ok' && o.dir === 'center';
    app.readyHold = centred ? app.readyHold + dt : Math.max(0, app.readyHold - dt * 2);
    ring($('ready-fg'), app.readyHold / 1.2);
    $('ready-sub').textContent = o.state === 'noface' ? 'Face not found' : o.state === 'head' ? 'Return your head to the calibrated position' : centred ? 'Hold…' : 'Look at the centre to begin';
    if (app.readyHold >= 1.2) startPlay();
  }

  if (app.phase === 'play') {
    const problem = o && (o.state === 'noface' || o.state === 'head');
    app.pauseMs = problem ? app.pauseMs + dt * 1000 : 0;
    const paused = app.pauseMs > 600;
    $('pause').hidden = !paused;
    if (paused) {
      $('pause-title').textContent = o.state === 'noface' ? 'Face lost' : 'Head moved';
      $('pause-msg').textContent = o.state === 'noface'
        ? 'Come back into view of the camera. The game continues automatically.'
        : `Turn your head back toward the screen (${describeHead(o)}). Only your eyes should steer.`;
    }
    if (tracking && !paused) dir = o.dir;
    if (!paused) {
      app.levelTime += dt;
      app.maze.update(app.levelTime, dt, app.ball);
      if (app.maze.phases.length) {
        const flipped = updatePhaseCharge(app.maze, app.charge, dir, dt);
        if (flipped) { renderer.ripple(app.ball.x, app.ball.y, [220, 235, 255]); toast(flipped === 'H' ? 'the maze turns sideways' : 'the maze turns vertical', 1400); }
      }
      const speed = PLAYLIST[app.levelIdx].speed * app.settings.speed;
      const r = stepBall(app.ball, dir, dt, app.maze, { speed });
      app.moving = r.moved > 0.002;
      if (reachedGoal(app.ball, app.maze.goal)) levelComplete();
    }
    $('hud-time').textContent = fmt(app.levelTime);
    if (app.maze.phases.length) $('hud-mode').textContent = app.maze.mode === 'H' ? '↔ sideways' : '↕ vertical';
  } else {
    $('pause').hidden = true;
  }

  if (app.phase === 'success' && o) {
    const centred = o.state === 'ok' && o.dir === 'center';
    app.succHold = centred ? app.succHold + dt : Math.max(0, app.succHold - dt * 2);
    ring($('succ-fg'), app.succHold / 2);
    if (app.succHold >= 2) restart();
  }

  // tracking dot
  const td = $('track-dot');
  td.className = 'track-dot' + (!o || !tracking ? '' : o.confidence > 0.55 ? ' ok' : ' mid');

  const showMaze = ['ready', 'play', 'transition', 'success'].includes(app.phase);
  renderer.draw({
    maze: showMaze ? app.maze : null, ball: showMaze ? app.ball : null,
    dir: app.phase === 'play' ? dir : 'center', time: now / 1000, dt, moving: app.phase === 'play' && app.moving,
    charge: app.charge.axis ? { amount: app.charge[app.charge.axis] / 1.2 } : null,
    dim: app.phase === 'ready' ? 0.62 : app.phase === 'success' ? 0.5 : 0,
  });
  if (app.debug && now - dbgT > 66) { dbgT = now; updateDebug(); }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function ring(el, p) {
  const C = 138.2;
  el.style.strokeDashoffset = `${C * (1 - Math.max(0, Math.min(1, p)))}`;
}
function describeHead(o) {
  const parts = [];
  if (Math.abs(o.dYaw) > 6) parts.push(`turned ${Math.abs(o.dYaw).toFixed(0)}°`);
  if (Math.abs(o.dPitch) > 6) parts.push(`tilted ${Math.abs(o.dPitch).toFixed(0)}°`);
  return parts.join(', ') || 'off-centre';
}

// ---------------------------------------------------------------- debug panel
function toggleDebug(force) {
  app.debug = force ?? !app.debug;
  $('debug').hidden = !app.debug;
}
toggleDebug(app.debug);
const dbgG = $('dbg-preview').getContext('2d');
function updateDebug() {
  const o = app.est && app.est.out;
  if (app.tracker) drawPreview(dbgG, 200, 150, false);
  if (!o) { $('dbg-state').textContent = app.phase; return; }
  $('dbg-dir').textContent = o.dir;
  $('dbg-state').textContent = `${o.state} · ${app.phase}`;
  $('dbg-conf').style.width = `${(o.confidence * 100).toFixed(0)}%`;
  $('dbg-confv').textContent = o.confidence.toFixed(2);
  const bar = (el, v) => { const c = Math.max(-1.5, Math.min(1.5, v)) / 1.5 * 50; el.style.left = c >= 0 ? '50%' : `${50 + c}%`; el.style.width = `${Math.abs(c)}%`; };
  bar($('dbg-x'), o.x); bar($('dbg-y'), o.y);
  $('dbg-xv').textContent = o.x.toFixed(2); $('dbg-yv').textContent = o.y.toFixed(2);
  const th = app.est.opts.enter / 1.5 * 50;
  for (const id of ['dbg-thx', 'dbg-thy']) { $(id).style.left = `${50 - th}%`; $(id).style.width = `${th * 2}%`; }
  $('dbg-head').textContent = o.dYaw !== undefined ? `yaw ${o.dYaw.toFixed(1)}° pitch ${o.dPitch.toFixed(1)}°` : '—';
  const q = app.model && app.model.quality;
  $('dbg-q').textContent = q ? `x ${q.x.toFixed(2)} y ${q.y.toFixed(2)} · head k ${app.model.head.kx.toFixed(3)}/${app.model.head.ky.toFixed(3)}` : '—';
  $('dbg-fps').textContent = app.tracker ? app.tracker.fps.toFixed(0) : '—';
}
const slider = (id, key, apply) => {
  const el = $(id);
  el.addEventListener('input', () => {
    app.settings[key] = +el.value;
    $(id + '-v').textContent = (+el.value).toFixed(2);
    apply();
  });
};
slider('sl-sens', 'sens', () => app.est && app.est.setOpts(estOpts()));
slider('sl-smooth', 'smooth', () => app.est && app.est.setOpts(estOpts()));
slider('sl-speed', 'speed', () => {});

// test hooks (test mode only drives synthetic eyes)
app.setGaze = (x, y) => { if (app.tracker && app.tracker.kind === 'synthetic') { app.tracker.follow = null; app.tracker.gaze = { x, y }; } };
app.setFace = (v) => { if (app.tracker && app.tracker.kind === 'synthetic') app.tracker.face = v; };
app.setHead = (yaw, pitch) => { if (app.tracker && app.tracker.kind === 'synthetic') app.tracker.head = { yaw, pitch }; };
app.jumpToLevel = (i) => { if (!TEST) return; app.levelIdx = i; app.maze = null; enterReady(); };
