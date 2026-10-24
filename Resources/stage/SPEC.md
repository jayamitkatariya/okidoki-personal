# Okidoki Stage — scene spec & runtime API

A self-contained, offline 2D/3D "teaching stage" that runs inside a `WKWebView` with all
networking blocked. Everything it needs is in this folder.

## Files

| File | Purpose |
| --- | --- |
| `stage.html` | Page loaded by the WKWebView. Transparent background, strict CSP, loads `stage.js`. |
| `stage.js` | Runtime (ES module). Creates `window.okidokiStage`, posts messages to Swift. |
| `parts.js` | Builders for every part type. |
| `labels.js` | Billboard label sprites (canvas-rendered pills) with leader lines. |
| `expr.js` | Safe math expression compiler (recursive descent, no `eval`). |
| `samples.js` | Eight sample scenes used by `test.html`. |
| `test.html` | Dev page with a sidebar to load samples and step through beats. |
| `three.module.js`, `three.core.js`, `OrbitControls.js`, `RoomEnvironment.js`, `THREE_LICENSE` | Vendored three.js r186 (MIT). Imports rewritten to relative paths. |

No fonts, images or scripts are fetched. The only font used is the system font via canvas
(`-apple-system, system-ui`).

### Running `test.html`

ES modules are blocked from `file://` in Chrome. Either open `test.html` in **Safari**, or serve
the folder: `python3 -m http.server 8000` then open `http://localhost:8000/test.html`.
Use `←`/`→` keys or the Back/Next buttons to step beats. Messages that would go to Swift are
logged in the panel below the stage (and to the console).

## Swift bridge

Messages are sent with `window.webkit.messageHandlers.stage.postMessage(obj)`. When that
handler is absent (plain browser) they are `console.log`ged as `[stage] {...}` and also
dispatched as a `CustomEvent('okidoki-stage', { detail })` on `window`.

| Message | When |
| --- | --- |
| `{type:"ready"}` | Once, after the module initialised. |
| `{type:"loaded", title, beats, parts, warnings}` | After a successful `load`. |
| `{type:"warn", message}` | Unknown part/action type, missing id, invalid expression, etc. Never throws. |
| `{type:"error", message}` | Uncaught error / unhandled rejection / failed `load`. |
| `{type:"beatStart", index, say, caption, duration}` | `play(index)` began. |
| `{type:"beatDone", index}` | The beat's duration elapsed (respects speed/pause). Not sent when a beat is cut short by another `play`/`restoreTo`. |
| `{type:"partHover", id, name}` / `{type:"partHover", id:null}` | Pointer enters/leaves a part (throttled ~30 Hz). |
| `{type:"partClick", id, name, description, screen:[x,y]}` | Click without drag (> 4 px). The stage also runs `focusPart(id)`. |

## `window.okidokiStage` API

| Method | Behaviour |
| --- | --- |
| `load(spec)` | Disposes the previous scene, builds `spec`, applies its camera. Parts start visible unless `visible:false`. Returns `{ok:true, warnings:[...]}` or `{ok:false, error}`. |
| `append({parts?, beats?})` | Adds parts/beats to the current spec (they survive `restoreTo`). Returns the new total beat count. |
| `play(index)` | Runs all actions of beat `index` concurrently. Returns a Promise resolving `{ok, index, completed}` after the beat duration; posts `beatDone`. Calling `play` while a beat is running cancels the earlier timer (its promise resolves with `completed:false`). |
| `restoreTo(index)` | Rebuilds from the stored spec and re-applies beats `0..index-1` instantly (no animation, no warnings). Use `restoreTo(i-1); play(i-1)` for "Back". Resets the camera to the spec camera first, then applies any camera actions in those beats. |
| `setSpeed(mult)` | 0.5–2. Scales every animation, continuous motion and beat duration. |
| `pause()` / `resume()` | Freezes/resumes animation time (the user can still orbit while paused). |
| `highlightPart(id \| null)` | Exclusive highlight from Swift (hover over a part name). `null` clears. |
| `focusPart(id)` | Tweens the camera to frame the part's bounding sphere and highlights it. |
| `resetView()` | Camera back to the spec camera; clears explode, cutaway, x-ray, highlight and auto-orbit. |
| `setAccent(cssColor)` | Changes the accent used by highlights, outlines, labels. Default `#44E45E`. |
| `setBuilding(on)` | Shows (or fades out) a slow wireframe placeholder while a lesson is still being written. `load` clears it. |
| `screenshot()` | Renders synchronously and returns a PNG data URL (transparent background). |
| `partAt(x, y)` | Raycast at CSS-pixel coordinates; returns the nearest part id (innermost nested part) or `null`. |
| `dispose()` | Tears down the renderer and observers. |
| `beatCount`, `parts` | Read-only getters: number of beats, array of part ids. |

## Scene spec

```
Scene {
  title: string
  mode: "3d" | "2d"           // 2d = orthographic camera looking down -Z; pan/zoom only (no orbit)
  camera?: { position: [x,y,z], target: [x,y,z], fov?: number }
                               // defaults: 3d position [6,4,8]; 2d position [0,0,10]; target [0,0,0]; fov 45
                               // in 2d mode the visible half-height = |position-target| * tan(fov/2),
                               // so moving the camera closer on Z zooms in.
  parts: Part[]
  beats: Beat[]
}
```

### Part (common fields)

```
{ id: string (required, unique), type: string, name?: string, description?: string,
  color?: css color, position?: [x,y,z], rotation?: [rx,ry,rz] radians, scale?: number | [x,y,z],
  opacity?: 0..1, visible?: boolean (default true), parent?: partId, metal?: 0..1, rough?: 0..1 }
```

* Coordinates are clamped to |v| ≤ 1000, radii/sizes to ≤ 500; non-finite numbers fall back to defaults.
* `parent` nests the object under another part (transforms are relative to the parent).
  Highlight / x-ray / color / show / hide on a parent apply to its nested parts.
* `name` makes the part hoverable with a temporary label; `name`/`description` are sent with `partClick`.
* Materials are `MeshPhysicalMaterial` with a light clearcoat (default color `#B8C0CC`, metal 0.1, rough 0.5) lit by hemisphere + key + rim + fill lights and a subtle room environment map. The key light casts soft shadows onto the parts and onto an invisible shadow catcher just under the model (3d only). A loaded scene eases in from slightly further out.

### Part types

| type | extra fields | notes |
| --- | --- | --- |
| `group` | — | empty container; use with `parent`. |
| `box` | `size:[w,h,d]` | |
| `sphere` | `radius` | |
| `cylinder` | `radius, height, radiusTop?, radiusBottom?, open?` | axis = local Y. |
| `cone` | `radius, height` | apex +Y. |
| `torus` | `radius, tube` | lies in local XY plane. |
| `tube` | `path:[[x,y,z],…], radius, closed?` | CatmullRom through the points (2 points = straight segment). |
| `gear` | `radius, teeth, thickness, hole?` | extruded gear outline, pitch radius `radius`, **axis = local Z** (spin with `axis:"z"`). Meshing gears need equal `radius/teeth`. Defaults metal 0.6 rough 0.4. |
| `spring` | `radius, height, coils, tube` | helix along local Y, centred. |
| `arrow` | `from, to, width?` | shaft + cone head; default color = accent. |
| `label` | `text, size?, anchor?, offset?` | billboard pill (13 px semibold, constant screen size, `size` multiplies). With `anchor` it follows the part's world bounds (offset default = above the bounding sphere) with a leader line and hides when the anchor is hidden; otherwise placed at `position`. |
| `plane` | `size:[w,h], doubleSide?` | in local XY. |
| `surface` | `expr, xRange, yRange, segments?, colorBy?:"height"` | z = f(x,y) via `expr.js` (variables `x`,`y`). **Mapped to world X = x, Y = f (up), Z = −y.** `colorBy:"height"` gives blue → accent → warm vertex colors. Pair with `axes` labels `["x","z","y"]` for math-correct labelling. |
| `plot` | `expr, xRange, samples?, width?` | y = f(x) in the XY plane (variable `x`). Thick ribbon in 2d mode, tube in 3d mode. Default color = accent. |
| `axes` | `size, labels?, ticks?` | X/Y/Z lines from −size to +size with arrowheads, label pills, unit ticks (every 1/2/5 units). Only X/Y in 2d mode. |
| `grid` | `size, divisions` | XZ plane in 3d, XY in 2d. Not pickable. |
| `molecule` | `atoms:[{el,pos}], bonds:[[i,j,order?]], style?:"ball-stick"\|"space-fill"` | CPK colours (C gray, H white, O red, N blue, S yellow, P orange, F/Cl green, Br brown, I purple, unknown pink). Ball-stick radius = covalent×0.3, bonds are cylinders (order 2/3 = parallel thin cylinders). Space-fill uses vdW radii, no bonds. |
| `particles` | `path, count, speed, size?, closed?` | additive glowing dots along a CatmullRom path. Static until a `flow` action turns it on; `speed` is world units / s. |
| `text` | `text, size?` | flat canvas text plane (height = `size`), works in both modes. |
| `ring` | `radius, tube?, segments?` | thin unlit ring; lies flat in XZ in 3d (orbit path), XY in 2d. Not pickable. |
| `lattice` | `nx, ny, nz, spacing, radius` | instanced sphere grid, centred. |

Unknown types are skipped with a `warn`.

### Beat

```
Beat { say: string, caption?: string, actions: Action[], duration?: seconds }
```
`duration` defaults to the longest action (minimum 1.2 s). Captions are **not** drawn by the
stage — Swift draws them.

### Actions

| action | fields | behaviour |
| --- | --- | --- |
| `show` | `ids, effect?: "grow"\|"fade"\|"drop", seconds?` | make visible with entrance animation. grow: scale 0→1 with overshoot (0.6 s); fade: opacity (0.6 s); drop: from +1.5 Y with bounce (0.9 s). |
| `hide` | `ids, seconds?` | fade out (0.4 s) then `visible=false`. |
| `move` | `id, to, seconds?` | tween the part's home position (0.8 s, easeInOutCubic). Composes with explode/oscillate. |
| `rotate` | `id, by:[rx,ry,rz], seconds?` | one-shot relative rotation (0.8 s). Composes with `spin`. |
| `spin` | `id, axis, rpm, on` | continuous rotation about local axis. |
| `oscillate` | `id, axis, amplitude, period, on` | sinusoidal offset along axis (negative amplitude = opposite phase). |
| `pulse` | `ids` | three emissive pulses over 1.5 s. |
| `highlight` | `ids, on` | accent emissive glow + pulsing outline shell; every non-highlighted part dims to 35 % (labels anchored to a highlighted part stay bright). |
| `camera` | `position?, target?, seconds?` | smooth tween (1 s); also moves the OrbitControls target. In 2d mode distance on Z controls zoom. |
| `orbit` | `on, rpm?` | OrbitControls autoRotate (ignored in 2d). |
| `explode` | `factor, seconds?` | every top-level part (except labels/axes/grid) moves by `factor × (home − centre)`; centre = bounding-box centre of top-level part positions. `factor:0` restores. |
| `cutaway` | `axis, at, on` | renderer clipping plane keeping `coord ≤ at`; materials become double-sided while on. |
| `xray` | `ids?, on` | listed parts (or all) become 25 % transparent wireframe. Turning on a list also clears x-ray on other parts. |
| `flow` | `id, on` | start/stop a `particles` part. |
| `color` | `id, color` | recolour the part's materials (and nested parts). |
| `label` | `id, text` | replace a label's text. |
| `point` | `screen:[fx,fy]` | ignored (Swift draws it). |
| `wait` | `seconds` | contributes to beat duration only. |

Unknown actions and missing ids are reported with `warn` and skipped. Seconds are clamped to
0–60. In `restoreTo` every action is applied instantly (`pulse` and `wait` become no-ops).

## Interaction

* 3d: left-drag orbit, wheel zoom, right-drag pan, damping on. 2d: left/right-drag pan, wheel zoom to cursor, no rotation.
* Hover (throttled ~30 Hz): `partHover` message, pointer cursor, temporary name label (unless the part already has a visible anchored label).
* Click without drag: `partClick` message + `focusPart`.
* The render loop idles at 0 % CPU when nothing animates: it only runs during tweens, continuous
  actions (spin/oscillate/flow/orbit), active highlight (outline pulse), beat timers, control
  damping or user interaction.
* `devicePixelRatio` is honoured up to 2; the canvas follows its container via `ResizeObserver`.

## `expr.js`

`compile(expr) → (scope) => number`. Grammar: numbers (`1`, `.5`, `2e3`), identifiers resolved
from `scope` (throws `Unknown identifier` if missing), `+ - * /`, `^` (right-assoc, binds tighter
than unary minus so `-2^2 = -4`), parentheses, functions `sin cos tan asin acos atan atan2 sinh
cosh tanh exp log log10 sqrt abs floor ceil round min max pow sign clamp`, constants `pi`, `e`.
Syntax errors and unknown functions throw at compile time.

## Known limitations

* Labels use `sizeAttenuation:false` sprites; they always render on top (no depth test).
* `explode` acts on top-level parts only (nested parts move with their parent).
* `cutaway` clips the outline shells too; labels are not clipped.
* Transparent dimmed parts can show normal transparency sorting artefacts where many overlap.
