// Camera code path with Chrome's FAKE webcam fed from a video file (a still face photo, looped).
//   MODEL=... VIDEO=face.y4m node tests/browser-camera.mjs
// Expected: camera starts, model loads, face is found, calibration runs — and, because the
// "eyes" never move, calibration must REFUSE (weak signal) instead of producing a bogus model.
import puppeteer from 'puppeteer-core';
import { serve } from './serve.mjs';

const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const PORT = 8125;
const server = await serve(PORT, { overrides: process.env.MODEL ? { '/models/face_landmarker.task': process.env.MODEL } : {} });
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${process.env.VIDEO}`, '--window-size=1280,800'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
let failed = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗', m); if (!c) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  await page.goto(`http://localhost:${PORT}/?debug`);
  await page.click('#btn-start');
  const t0 = Date.now();
  while (Date.now() - t0 < 60000 && (await page.evaluate(() => window.eyeMaze.phase)) === 'start') await wait(200);
  for (let i = 0; i < 150 && (await page.evaluate(() => window.eyeMaze.phase)) !== 'position'; i++) await wait(200);
  ok((await page.evaluate(() => window.eyeMaze.phase)) === 'position', 'camera + model started → position screen');
  const info = await page.evaluate(() => ({ d: window.eyeMaze.tracker.delegate, src: window.eyeMaze.tracker.modelSource }));
  console.log(`    delegate ${info.d}, model ${info.src}`);
  await wait(1500);
  const pos = await page.evaluate(() => ({ text: document.getElementById('pos-status').textContent, frame: window.eyeMaze.tracker.last && window.eyeMaze.tracker.last.frame, fps: window.eyeMaze.tracker.fps }));
  ok(!!pos.frame, `face detected in live video (${pos.text}); ~${pos.fps.toFixed(0)} fps in headless CPU`);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/cam-position.png` });
  // wait through calibration (auto-starts after 3 s of a well-placed face, or press the button)
  await page.evaluate(() => { const b = document.getElementById('btn-pos-go'); if (!b.disabled && window.eyeMaze.phase === 'position') b.click(); });
  for (let i = 0; i < 300 && (await page.evaluate(() => window.eyeMaze.phase)) !== 'calresult'; i++) await wait(200);
  const res = await page.evaluate(() => ({ phase: window.eyeMaze.phase, title: document.getElementById('cr-title').textContent, issues: document.getElementById('cr-issues').textContent }));
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/cam-calresult.png` });
  ok(res.phase === 'calresult' && /another go/i.test(res.title), `static face → calibration refused: "${res.title}" — ${res.issues}`);
  ok(errors.length === 0, 'no page errors ' + errors.join(' | '));
} finally {
  await browser.close();
  server.close();
}
process.exitCode = failed ? 1 : 0;
console.log(failed ? `${failed} failed` : 'CAMERA PATH CHECKS PASSED');
