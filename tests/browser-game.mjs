// End-to-end browser test in TEST MODE (synthetic eyes, no camera).
// Exercises the real calibration screens, control check, gaze-only start, collision,
// pausing on face loss / head movement, level transitions and the success screen.
//   CHROME=/path/to/chrome node tests/browser-game.mjs
import puppeteer from 'puppeteer-core';
import { serve } from './serve.mjs';

const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const SHOTS = process.env.SHOTS || null;
const PORT = 8123;

const server = await serve(PORT);
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--window-size=1280,800'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const phase = () => page.evaluate(() => window.eyeMaze.phase);
const waitPhase = async (want, ms = 30000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if ((await phase()) === want) return; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error(`timeout waiting for phase ${want} (now ${await phase()})`);
};
const shot = async (name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };
const ok = (cond, msg) => { if (!cond) throw new Error('FAIL: ' + msg); console.log('  ✓', msg); };

try {
  await page.goto(`http://127.0.0.1:${PORT}/?test`, { waitUntil: 'load' });
  await shot('01-start');
  await page.click('#btn-start');
  await waitPhase('calibrating', 5000);
  await new Promise((r) => setTimeout(r, 2500));
  await shot('02-calibration');
  await waitPhase('checking', 30000);
  const cal = await page.evaluate(() => ({ q: window.eyeMaze.model.quality, head: window.eyeMaze.model.head }));
  ok(cal.q.overall > 0.5, `calibration quality ${cal.q.overall.toFixed(2)} (x ${cal.q.x.toFixed(2)}, y ${cal.q.y.toFixed(2)})`);
  ok(Math.abs(cal.head.kx) > 0.02, `head compensation learned (kx ${cal.head.kx.toFixed(3)})`);
  await new Promise((r) => setTimeout(r, 1200));
  await shot('03-check');
  await waitPhase('ready', 40000);
  ok(true, 'control check passed all 4 directions');
  await shot('04-ready');
  await waitPhase('play', 6000);
  ok(true, 'game started by looking at the centre (no click)');

  const levels = await page.evaluate(() => window.eyeMaze.maze && document.getElementById('hud-level').textContent);
  console.log('  ', levels);

  // ---- pause behaviour
  await page.evaluate(() => window.eyeMaze.setGaze(0, 0));
  await page.evaluate(() => window.eyeMaze.setFace(false));
  await new Promise((r) => setTimeout(r, 1200));
  ok(await page.evaluate(() => !document.getElementById('pause').hidden && window.eyeMaze.est.out.state === 'noface'), 'face lost → paused');
  await page.evaluate(() => window.eyeMaze.setFace(true));
  await new Promise((r) => setTimeout(r, 600));
  ok(await page.evaluate(() => document.getElementById('pause').hidden), 'face back → resumed');
  await page.evaluate(() => window.eyeMaze.setHead(26, 0));
  await new Promise((r) => setTimeout(r, 1300));
  ok(await page.evaluate(() => window.eyeMaze.est.out.state === 'head' && !document.getElementById('pause').hidden), 'large head turn → paused');
  await shot('05-pause-head');
  await page.evaluate(() => window.eyeMaze.setHead(0, 0));
  await new Promise((r) => setTimeout(r, 800));

  // ---- centre gaze keeps the ball still
  const b0 = await page.evaluate(() => ({ ...window.eyeMaze.ball }));
  await new Promise((r) => setTimeout(r, 1500));
  const b1 = await page.evaluate(() => ({ ...window.eyeMaze.ball }));
  ok(Math.hypot(b1.x - b0.x, b1.y - b0.y) < 0.01, 'centre gaze → ball stays still');

  // ---- play every level by "looking" along the solution (driving synthetic gaze, not the ball)
  let levelsDone = 0, playShot = false;
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const st = await page.evaluate(() => {
      const a = window.eyeMaze;
      if (a.phase !== 'play') return { phase: a.phase, idx: a.levelIdx };
      const m = a.maze, b = a.ball;
      const cell = { x: Math.floor(b.x), y: Math.floor(b.y) };
      // BFS with dynamic walls treated as open (the player waits at gates / sustains gaze)
      const key = (c) => c.x + ',' + c.y;
      const prev = new Map([[key(cell), null]]), q = [cell];
      const D = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
      while (q.length) {
        const c = q.shift();
        if (c.x === m.goal.x && c.y === m.goal.y) break;
        for (const d in D) if (m.passable(c.x, c.y, d, 'open')) {
          const n = { x: c.x + D[d][0], y: c.y + D[d][1] };
          if (!prev.has(key(n))) { prev.set(key(n), c); q.push(n); }
        }
      }
      let c = m.goal, next = null;
      while (c && prev.get(key(c)) && key(prev.get(key(c))) !== key(cell)) c = prev.get(key(c));
      next = c;
      let want;
      if (!next || key(next) === key(cell)) want = b.x < m.goal.x + 0.5 ? 'right' : 'left';
      else want = next.x > cell.x ? 'right' : next.x < cell.x ? 'left' : next.y > cell.y ? 'down' : 'up';
      const horiz = want === 'left' || want === 'right';
      const lane = horiz ? b.y - (cell.y + 0.5) : b.x - (cell.x + 0.5);
      let look = want;
      if (Math.abs(lane) > 0.15) look = horiz ? (lane > 0 ? 'up' : 'down') : (lane > 0 ? 'left' : 'right');
      const G = { left: [-0.9, 0], right: [0.9, 0], up: [0, -0.9], down: [0, 0.9] }[look];
      a.setGaze(G[0], G[1]);
      return { phase: a.phase, idx: a.levelIdx, look, dir: a.est.out.dir };
    });
    if (st.phase === 'play' && !playShot) { await new Promise((r) => setTimeout(r, 1500)); await shot(`06-play-L${st.idx + 1}`); playShot = true; }
    if (st.phase === 'transition' && levelsDone === st.idx) {
      levelsDone++;
      console.log(`  ✓ level ${st.idx + 1} completed`);
      await page.evaluate(() => window.eyeMaze.setGaze(0, 0));
      playShot = false;
    }
    if (st.phase === 'ready') { await page.evaluate(() => window.eyeMaze.setGaze(0, 0)); await shot(`07-ready-L${st.idx + 1}`); await waitPhase('play', 6000); }
    if (st.phase === 'success') break;
    await new Promise((r) => setTimeout(r, 60));
  }
  await waitPhase('success', 3000);
  await new Promise((r) => setTimeout(r, 700));
  await shot('08-success');
  const times = await page.evaluate(() => window.eyeMaze.times);
  ok(times.length >= 1 && times.every((t) => t > 0), `success screen reached; level times ${times.map((t) => t.toFixed(1) + 's').join(', ')}`);

  // ---- every frame during play: ball must never be inside a wall (spot-check final state)
  const inside = await page.evaluate(() => {
    const a = window.eyeMaze, b = a.ball;
    return a.maze.staticRects().some((R) => {
      const qx = Math.max(R.x, Math.min(b.x, R.x + R.w)), qy = Math.max(R.y, Math.min(b.y, R.y + R.h));
      return (b.x - qx) ** 2 + (b.y - qy) ** 2 < (b.r - 1e-6) ** 2;
    });
  });
  ok(!inside, 'ball not overlapping any wall');

  // ---- play again by gaze
  await page.evaluate(() => window.eyeMaze.setGaze(0, 0));
  await waitPhase('ready', 5000);
  ok(true, 'success → look at centre 2 s → restarted');

  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  console.log('BROWSER GAME TEST PASSED');
} catch (e) {
  console.error(e.message);
  await shot('zz-failure');
  console.error('errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
