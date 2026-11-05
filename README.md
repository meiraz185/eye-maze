# EYE MAZE

A minimalist maze steered only by your eyes. A glowing cyan ball rolls in the direction you look; look at the centre of the screen and it stops. Built for the *Body & Space* interactive design assignment.

- **Input:** webcam eye movements only (no keyboard or mouse during play)
- **Tech:** plain HTML / CSS / JavaScript (ES modules), [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) for face, iris and eye landmarks
- **Privacy:** every camera frame is processed in the browser by an on-device model. Video is never recorded, stored or uploaded. (The only network request is a one-time download of the model file from Google if you don't keep a local copy — see below.)

## Run it locally

Browsers block the camera and JavaScript modules on `file://`, so serve the folder:

```bash
cd eye-maze
python3 -m http.server 8000        # or:  node tests/serve.mjs 8000
```

Open **http://localhost:8000** in Chrome, Edge, Firefox or Safari and click **Start with camera**.

**Test mode without a camera:** http://localhost:8000/?test — synthetic "eyes" follow the calibration dots automatically, and during play the arrow keys simulate looking. This exercises the game, not real eye tracking.

Add `?debug` to the URL (or press **D**) to open the debug panel.

## Deploy to GitHub Pages

1. Push this folder to a GitHub repository (the `.nojekyll` file is included).
2. *Settings → Pages → Deploy from a branch*, pick `main` / root.
3. Open `https://<user>.github.io/<repo>/`. Pages is served over https, so the camera works.

`node_modules/` (test tools only) is not needed on Pages.

### Optional: keep the model file in the repo (offline / no Google request)
Download it once into `models/`:
```bash
curl -L -o models/face_landmarker.task \
  https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
```
If `models/face_landmarker.task` exists the game uses it; otherwise it fetches the same file from Google. The MediaPipe library and its WebAssembly are already vendored in `vendor/mediapipe/` (Apache-2.0).

## How to play

1. **Start screen** → **Start with camera** → allow camera access.
2. **Position:** centre your face in the oval. Calibration starts automatically after 3 s.
3. **Calibration (6 steps):** follow the dot with your eyes — centre, left, right, up, down — keeping your head still. In the last step keep looking at the dot while you *gently* turn and nod your head; this teaches the game to ignore head movement.
4. **Control check:** look at each glowing arrow. A small ring shows where the game thinks you are looking.
5. **Look at the centre** for a moment to start each level. No clicks needed from here on.
6. Reach the green portal. If the camera loses your face or your head turns too far, the game pauses and continues by itself.

**Levels**
1. **FIRST SIGHT** — a small static maze with long corridors to learn eye control.
2. **TIDE GATES** — sliding walls open and close on a cycle; wait for the gap. Gates never close onto the ball.
3. **GAZE FIELD** — dotted walls react to sustained gaze. Hold a sideways gaze ~1.2 s and the maze turns *sideways* (sideways gates open, vertical gates close); hold up/down and it turns *vertical*. Quick glances change nothing. The ring around the ball shows the build-up.

**Tips:** even, frontal light; laptop camera at eye level; about an arm's length away; move your eyes clearly to the edges of the screen. Glasses with strong reflections can reduce accuracy. If control feels jumpy, open the debug panel and lower *sensitivity* or raise *smoothing*.

## How the eye tracking works

`js/gaze.js` (pure functions, unit-tested):

| Step | What it does |
|---|---|
| **Features** | For each eye, the iris centre (landmarks 468–477) is measured relative to that eye's corners (33/133, 362/263): horizontal position along the corner axis, vertical offset perpendicular to it, and lid opening — all divided by eye width. This makes the features independent of head position, distance and roll. MediaPipe's eye-look blendshapes are used as additional features. |
| **Calibration** | Median feature values at the 5 targets give a per-axis mapping (−1 at left/up, 0 centre, +1 right/down). Each feature is weighted by its signal-to-noise ratio, and features that don't change consistently are dropped. Signs are learned, so a mirrored camera doesn't matter. Calibration refuses to continue if a direction can't be distinguished. |
| **Head movement** | (1) Head-turn compensation learned in the 6th calibration step (how much the eye signal shifts per degree of head rotation, from the face transformation matrix). (2) Fast head motion is ignored. (3) If the head rotates beyond ~15° from the calibrated pose, play pauses with a message. |
| **Stability** | One-Euro smoothing → neutral dead zone (stop) → hysteresis (harder to start than to keep moving) → dominant-axis rule (diagonals are ignored) → short dwell time before a direction is accepted. Blinks are bridged; longer eye closure stops the ball. |
| **Confidence** | Debug-panel heuristic = stability × head-pose factor × calibration quality. It is *not* a probability from the model. |

The ball itself uses lane assist (keeps it on the corridor centre line) and corner assist (a slightly early or late turn still enters the side corridor) — this makes eye steering much less fiddly without moving the ball for you.

## Tests

```bash
npm install              # only needed for the browser tests (puppeteer-core)
npm test                 # unit tests: maze, collision, solvability, calibration, gaze logic, level completion
node tests/browser-game.mjs        # full game in headless Chrome, test mode
```
Optional, needs a local copy of the model and face photos/video of your own:
```bash
MODEL=models/face_landmarker.task FACES=/path/to/jpgs node tests/browser-face.mjs
MODEL=models/face_landmarker.task VIDEO=/path/to/face.y4m node tests/browser-camera.mjs
```
Set `CHROME=/path/to/chrome` if Chrome is not at `/usr/bin/google-chrome`.

### What has and has not been verified

**Verified automatically**
- Every level (landscape and portrait) is solvable; level 2 is *not* solvable with gates closed and level 3 is *not* solvable without switching modes (so the mechanics matter).
- Collision: across thousands of random-gaze steps in 25 mazes the ball never overlaps a wall, never crosses a closed edge and never tunnels at large time steps; gates never close onto the ball.
- Gaze logic on a synthetic eye model: calibration, dead zone, no flicker at rest, hysteresis, diagonal rejection, debounce, head-turn compensation, head-motion pause, blink handling, face loss.
- In headless Chrome (test mode): start → calibration → control check → gaze-only start → all three levels → success screen → gaze restart; pause on face loss and head turn.
- With the **real MediaPipe model on still photos of two real faces**: 478 landmarks incl. iris; features stay stable when the face is shifted, scaled or rolled 10°; mirror symmetry holds; the horizontal/vertical features follow a (pixel-warped) iris shift in the right direction.
- The real camera code path with Chrome's fake webcam (a looped still photo): camera + model start, face detected, and calibration correctly *refuses* because the eyes never move.

**Not verified:** live gaze tracking with a real person in front of a real webcam. That requires your own testing — please try it with several people, lighting conditions, with and without glasses, and adjust sensitivity/smoothing in the debug panel if needed.

## Files

```
index.html          screens and HUD
css/style.css       visual design
js/main.js          app flow and game loop
js/gaze.js          features, calibration, estimator (smoothing, dead zone, head handling)
js/calibrate.js     calibration + control-check screens
js/tracker.js       webcam + MediaPipe (and the synthetic test tracker)
js/maze.js          maze model, generation, BFS solver
js/levels.js        the three levels, moving gates, gaze-reactive walls
js/physics.js       ball movement, collision, lane/corner assist
js/render.js        canvas drawing, glow and particles
js/synthetic.js     synthetic eye model (tests / test mode only)
vendor/mediapipe/   MediaPipe Tasks Vision 1.2.2 (Apache-2.0)
models/             optional local face_landmarker.task
tests/              unit and browser tests
```
