// Okidoki teaching stage runtime. Exposes window.okidokiStage; talks to Swift via
// window.webkit.messageHandlers.stage. Fully offline — all imports are local files.
import * as THREE from './three.module.js';
import { OrbitControls } from './OrbitControls.js';
import { RoomEnvironment } from './RoomEnvironment.js';
import { buildPart, disposeObject, vec3, num } from './parts.js';
import { Label } from './labels.js';

const DEFAULT_ACCENT = '#44E45E';
const DEFAULT_CAMERA = { position: [6, 4, 8], target: [0, 0, 0], fov: 45 };
const DIM_OPACITY = 0.35, XRAY_OPACITY = 0.25, MIN_BEAT = 1.2, HIGHLIGHT_GLOW = 0.22;

// ---------- easing ----------
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutBack = (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
const easeOutBounce = (t) => {
  const n = 7.5625, d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
};
const lerp = (a, b, k) => a + (b - a) * k;
const clampSeconds = (v, def) => Math.min(60, Math.max(0, num(v, def, 60)));

// ---------- messaging ----------
function post(obj) {
  const handler = window.webkit?.messageHandlers?.stage;
  if (handler) { try { handler.postMessage(obj); } catch (e) { console.warn('[stage] postMessage failed', e); } }
  else console.log('[stage]', JSON.stringify(obj));
  try { window.dispatchEvent(new CustomEvent('okidoki-stage', { detail: obj })); } catch (e) { /* ignore */ }
}
let quiet = false; // suppress warn posts while restoreTo replays already-reported beats
const warn = (message) => { if (!quiet) post({ type: 'warn', message }); };

// ---------- stage ----------
class Stage {
  constructor(container) {
    this.container = container;
    this.accent = DEFAULT_ACCENT;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.width = container.clientWidth || 800;
    this.height = container.clientHeight || 600;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(this.dpr);
    renderer.setSize(this.width, this.height, false);
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.localClippingEnabled = false;
    renderer.domElement.style.cssText = 'width:100%;height:100%;display:block;touch-action:none;';
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.setupLights();
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.45;
    pmrem.dispose();

    this.parts = new Map();
    this.spec = null;
    this.beats = [];
    this.tweens = [];
    this.pulses = [];
    this.beatTimers = [];
    this.highlighted = new Set();
    this.explodeFactor = 0;
    this.explodeCenter = new THREE.Vector3();
    this.clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
    this.cutaway = false;
    this.speed = 1;
    this.paused = false;
    this.instant = false;
    this.needsRender = true;
    this.interacting = false;
    this.raf = 0;
    this.last = performance.now();
    this.clock = 0;
    this.raycaster = new THREE.Raycaster();
    this.hoverId = null;
    this.hoverLabel = null;
    this.placeholder = null;
    this.outlineMaterial = new THREE.MeshBasicMaterial({ color: this.accent, side: THREE.BackSide, transparent: true, opacity: 0.6, depthWrite: false });

    this.mode = '3d';
    this.setupCamera('3d', DEFAULT_CAMERA);
    this.setupPointer();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  // ---------- setup ----------
  setupLights() {
    const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x1c1f24, 0.9);
    const key = new THREE.DirectionalLight(0xffffff, 1.7);
    key.position.set(5, 8, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 4;
    const cam = key.shadow.camera;
    cam.near = 0.5; cam.far = 40;
    cam.left = cam.bottom = -9; cam.right = cam.top = 9;
    const rim = new THREE.DirectionalLight(0x9db4ff, 0.6);
    rim.position.set(-6, 3, -7);
    const fill = new THREE.DirectionalLight(0xffffff, 0.35);
    fill.position.set(-4, -2, 5);
    this.scene.add(hemi, key, rim, fill);
    this.keyLight = key;

    // A soft shadow catcher under the model, so parts sit on something instead of floating in a void.
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.ShadowMaterial({ opacity: 0.28, transparent: true, depthWrite: false }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.userData.noPick = true;
    ground.visible = false;
    this.scene.add(ground);
    this.ground = ground;
  }

  // Drop the shadow catcher just under the lowest part. Only in 3d; a flat diagram has no floor.
  placeGround() {
    if (!this.ground) return;
    if (this.mode !== '3d' || this.parts.size === 0) { this.ground.visible = false; return; }
    const box = new THREE.Box3();
    for (const p of this.parts.values()) {
      if (p.type === 'label' || p.type === 'grid' || p.type === 'axes' || p.type === 'particles') continue;
      const b = new THREE.Box3().setFromObject(p.obj, true);
      if (!b.isEmpty()) box.union(b);
    }
    if (box.isEmpty()) { this.ground.visible = false; return; }
    const center = box.getCenter(new THREE.Vector3());
    this.ground.position.set(center.x, box.min.y - 0.02, center.z);
    this.ground.visible = true;
    this.keyLight.target.position.copy(center);
    this.keyLight.target.updateMatrixWorld();
  }

  // ---------- building placeholder ----------
  // While the model is still being written, a slow wireframe keeps the stage alive instead of blank.
  setBuilding(on) {
    if (on && !this.placeholder) {
      const geo = new THREE.IcosahedronGeometry(1.6, 1);
      const mat = new THREE.MeshBasicMaterial({ color: this.accent, wireframe: true, transparent: true, opacity: 0.35 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData.noPick = true;
      const dots = new THREE.Points(geo, new THREE.PointsMaterial({ color: this.accent, size: 0.07, transparent: true, opacity: 0.8 }));
      dots.userData.noPick = true;
      const group = new THREE.Group();
      group.add(mesh, dots);
      this.scene.add(group);
      this.placeholder = { group, geo, mat, dotsMat: dots.material, t: 0 };
      this.schedule();
    } else if (!on && this.placeholder) {
      const ph = this.placeholder;
      this.placeholder = null;
      this.tween(0.5, (k) => { ph.mat.opacity = 0.35 * (1 - k); ph.dotsMat.opacity = 0.8 * (1 - k); ph.group.scale.setScalar(1 + k * 0.6); }, () => {
        ph.group.removeFromParent(); ph.geo.dispose(); ph.mat.dispose(); ph.dotsMat.dispose();
      });
      this.requestRender();
    }
  }

  setupCamera(mode, camSpec) {
    if (this.controls) this.controls.dispose();
    this.mode = mode;
    const spec = this.cameraSpec = {
      position: vec3(camSpec?.position, mode === '2d' ? [0, 0, 10] : DEFAULT_CAMERA.position),
      target: vec3(camSpec?.target, DEFAULT_CAMERA.target),
      fov: Math.min(150, Math.max(5, num(camSpec?.fov, DEFAULT_CAMERA.fov, 150))),
    };
    const aspect = this.width / this.height;
    if (mode === '2d') {
      const dist = Math.max(0.01, new THREE.Vector3(...spec.position).distanceTo(new THREE.Vector3(...spec.target)));
      this.baseDist = dist;
      const h = dist * Math.tan(THREE.MathUtils.degToRad(spec.fov / 2));
      this.camera = new THREE.OrthographicCamera(-h * aspect, h * aspect, h, -h, 0.01, 5000);
      this.camera.position.set(spec.position[0], spec.position[1], Math.max(1, spec.position[2]));
    } else {
      this.camera = new THREE.PerspectiveCamera(spec.fov, aspect, 0.05, 5000);
      this.camera.position.set(...spec.position);
    }
    const controls = new OrbitControls(this.camera, this.renderer.domElement);
    controls.target.set(...spec.target);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.autoRotate = false;
    if (mode === '2d') {
      controls.enableRotate = false;
      controls.screenSpacePanning = true;
      controls.zoomToCursor = true;
      controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
    }
    controls.addEventListener('change', () => this.requestRender());
    controls.addEventListener('start', () => { this.interacting = true; this.requestRender(); });
    controls.addEventListener('end', () => { this.interacting = false; this.requestRender(); });
    controls.update();
    this.controls = controls;
  }

  setupPointer() {
    const el = this.renderer.domElement;
    let lastMove = 0, downPos = null;
    el.addEventListener('pointermove', (e) => {
      const now = performance.now();
      if (now - lastMove < 33) return;
      lastMove = now;
      if (downPos) return;
      this.setHover(this.partAt(e.offsetX, e.offsetY));
    });
    el.addEventListener('pointerleave', () => this.setHover(null));
    el.addEventListener('pointerdown', (e) => { downPos = [e.offsetX, e.offsetY]; });
    el.addEventListener('pointerup', (e) => {
      const d = downPos;
      downPos = null;
      if (!d || Math.hypot(e.offsetX - d[0], e.offsetY - d[1]) > 4) return;
      const id = this.partAt(e.offsetX, e.offsetY);
      if (!id) return;
      const p = this.parts.get(id);
      post({ type: 'partClick', id, name: p.spec.name ?? null, description: p.spec.description ?? null, screen: [e.offsetX, e.offsetY] });
      this.focusPart(id);
    });
  }

  resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.width = w; this.height = h;
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    if (this.camera.isOrthographicCamera) {
      const half = this.camera.top;
      this.camera.left = -half * aspect; this.camera.right = half * aspect;
    } else {
      this.camera.aspect = aspect;
    }
    this.camera.updateProjectionMatrix();
    this.forEachLabel((l) => l.setViewport(w, h, this.camera));
    this.requestRender();
  }

  forEachLabel(fn) {
    for (const p of this.parts.values()) {
      if (p.label) fn(p.label);
      if (p.extraLabels) p.extraLabels.forEach(fn);
    }
    if (this.hoverLabel) fn(this.hoverLabel);
  }

  // ---------- render loop (idles when nothing moves) ----------
  requestRender() {
    this.needsRender = true;
    this.schedule();
  }
  schedule() {
    if (!this.raf) this.raf = requestAnimationFrame((t) => this.tick(t));
  }
  hasAnimations() {
    if (this.tweens.length || this.pulses.length || this.beatTimers.length || this.highlighted.size || this.placeholder) return true;
    for (const p of this.parts.values()) {
      if (p.spin.x || p.spin.y || p.spin.z) return true;
      if (p.osc && p.osc.on) return true;
      if (p.particles && p.particles.on) return true;
    }
    return false;
  }
  tick(now) {
    this.raf = 0;
    const dtRaw = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    const dt = this.paused ? 0 : dtRaw * this.speed;
    this.clock += dt;
    this.needsRender = false;
    const animating = !this.paused && this.hasAnimations();
    if (animating) this.step(dt);
    const controlsMoved = this.controls.update(dtRaw);
    this.render();
    if (animating || controlsMoved || this.interacting || this.controls.autoRotate || this.needsRender) this.schedule();
  }
  step(dt) {
    if (this.placeholder) {
      const ph = this.placeholder;
      ph.t += dt;
      ph.group.rotation.y += dt * 0.35;
      ph.group.rotation.x = Math.sin(ph.t * 0.5) * 0.25;
      ph.mat.opacity = 0.28 + 0.1 * Math.sin(ph.t * 2);
    }
    for (const tw of this.tweens.slice()) {
      tw.t += dt;
      const k = tw.dur > 0 ? Math.min(1, tw.t / tw.dur) : 1;
      tw.fn(k);
      if (k >= 1) { this.tweens.splice(this.tweens.indexOf(tw), 1); tw.onDone?.(); }
    }
    for (const bt of this.beatTimers.slice()) {
      bt.t += dt;
      if (bt.t >= bt.dur) { this.beatTimers.splice(this.beatTimers.indexOf(bt), 1); bt.finish(true); }
    }
    for (const p of this.parts.values()) {
      if (p.spin.x) p.obj.rotation.x += (p.spin.x / 60) * Math.PI * 2 * dt;
      if (p.spin.y) p.obj.rotation.y += (p.spin.y / 60) * Math.PI * 2 * dt;
      if (p.spin.z) p.obj.rotation.z += (p.spin.z / 60) * Math.PI * 2 * dt;
      if (p.osc && p.osc.on) {
        p.osc.t += dt;
        p.off.osc.set(0, 0, 0);
        p.off.osc[p.osc.axis] = p.osc.amplitude * Math.sin((Math.PI * 2 * p.osc.t) / p.osc.period);
        this.syncTransform(p);
      }
      if (p.particles && p.particles.on) {
        p.particles.phase = (p.particles.phase + (p.particles.speed * dt) / p.particles.length) % 1;
        this.updateParticles(p);
      }
    }
    for (const pu of this.pulses.slice()) {
      pu.t += dt;
      const k = Math.min(1, pu.t / 1.5);
      const glow = k >= 1 ? 0 : Math.max(0, Math.sin(k * Math.PI * 3)) * 0.9;
      for (const q of this.subtree(pu.part)) this.setEmissive(q, glow, this.isHighlighted(q) ? HIGHLIGHT_GLOW : 0);
      if (k >= 1) this.pulses.splice(this.pulses.indexOf(pu), 1);
    }
    if (this.highlighted.size) this.outlineMaterial.opacity = 0.45 + 0.3 * Math.sin(this.clock * 4);
  }
  render() {
    this.updateLabels();
    this.forEachLabel((l) => l.setViewport(this.width, this.height, this.camera));
    this.renderer.render(this.scene, this.camera);
  }

  // ---------- scene building ----------
  load(spec) {
    try {
      if (!spec || typeof spec !== 'object') throw new Error('spec must be an object');
      this.spec = { title: spec.title ?? '', mode: spec.mode === '2d' ? '2d' : '3d', camera: spec.camera, parts: Array.isArray(spec.parts) ? spec.parts.slice() : [], beats: Array.isArray(spec.beats) ? spec.beats.slice() : [] };
      const warnings = this.build();
      post({ type: 'loaded', title: this.spec.title, beats: this.beats.length, parts: this.parts.size, warnings });
      return { ok: true, warnings };
    } catch (e) {
      post({ type: 'error', message: `load failed: ${e.message}` });
      return { ok: false, error: e.message };
    }
  }
  build() {
    this.clearScene();
    const warnings = [];
    this.warnings = warnings;
    this.setupCamera(this.spec.mode, this.spec.camera);
    this.beats = this.spec.beats;
    this.addParts(this.spec.parts, warnings);
    this.computeExplodeCenter();
    this.placeGround();
    this.setBuilding(false);
    if (!this.instant) this.reveal();
    this.requestRender();
    return warnings;
  }
  // A fresh scene eases in from a little further out, so it arrives instead of popping.
  reveal() {
    const spec = this.cameraSpec;
    const target = new THREE.Vector3(...spec.target);
    const home = new THREE.Vector3(...spec.position);
    const far = target.clone().addScaledVector(home.clone().sub(target), this.mode === '2d' ? 1.25 : 1.45);
    if (this.mode === '3d') far.applyAxisAngle(new THREE.Vector3(0, 1, 0), -0.35);
    this.camera.position.copy(far);
    if (this.camera.isOrthographicCamera) {
      this.camera.zoom = this.baseDist / Math.max(0.01, far.distanceTo(target));
      this.camera.updateProjectionMatrix();
    }
    this.controls.update();
    this.tweenCamera(spec.position, spec.target, 1.4);
  }
  clearScene() {
    this.cancelBeatTimers();
    this.tweens.length = 0;
    this.pulses.length = 0;
    this.highlighted.clear();
    this.setHover(null);
    for (const p of this.parts.values()) {
      this.removeOutline(p);
      if (p.label) p.label.dispose();
      if (p.extraLabels) p.extraLabels.forEach((l) => l.dispose());
      disposeObject(p.obj);
    }
    this.root.clear();
    this.parts.clear();
    this.explodeFactor = 0;
    this.setCutaway(false);
    this.controls.autoRotate = false;
  }
  partContext() {
    return { accent: this.accent, mode: this.mode, dpr: this.dpr, width: this.width, height: this.height };
  }
  // A part plus every part nested under it (via `parent`).
  subtree(p) {
    const out = [p];
    for (const q of this.parts.values()) {
      let a = q.parent;
      while (a) { if (a === p) { out.push(q); break; } a = a.parent; }
    }
    return out;
  }
  isHighlighted(p) {
    for (let a = p; a; a = a.parent) if (a.highlighted) return true;
    return false;
  }
  addParts(specs, warnings) {
    const w = (m) => { warnings.push(m); warn(m); };
    const ctx = this.partContext();
    const pending = [];
    for (const s of specs) {
      if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !s.id) { w(`part without a valid id skipped`); continue; }
      if (this.parts.has(s.id)) { w(`duplicate part id '${s.id}' skipped`); continue; }
      let built = null;
      try { built = buildPart(s, ctx); } catch (e) { w(`part '${s.id}' (${s.type}) failed: ${e.message}`); continue; }
      if (!built) { w(`unknown part type '${s.type}' for '${s.id}' skipped`); continue; }
      const obj = built.obj;
      obj.userData.partId = s.id;
      obj.name = s.id;
      for (const m of built.materials) {
        m.userData.baseOpacity = m.opacity;
        m.userData.baseTransparent = m.transparent;
        m.userData.baseSide = m.side;
        if (m.emissive) m.userData.baseEmissive = m.emissiveIntensity;
      }
      const scale = typeof s.scale === 'number' ? [s.scale, s.scale, s.scale] : vec3(s.scale, [1, 1, 1], 1000);
      const part = {
        id: s.id, spec: s, type: s.type, obj, materials: built.materials, label: built.label, extraLabels: built.extraLabels, particles: built.particles,
        home: new THREE.Vector3(...vec3(s.position)), baseScale: new THREE.Vector3(...scale),
        off: { explode: new THREE.Vector3(), osc: new THREE.Vector3(), anim: new THREE.Vector3() },
        animScale: 1, op: { base: Math.min(1, Math.max(0, num(s.opacity, 1, 1))), anim: 1, dim: 1 }, xray: false,
        visible: s.visible !== false, spin: { x: 0, y: 0, z: 0 }, osc: null, highlighted: false, outlines: [], parentId: typeof s.parent === 'string' ? s.parent : null,
      };
      obj.rotation.set(...vec3(s.rotation, [0, 0, 0], 1000));
      if (part.particles) { part.particles.on = false; this.updateParticles(part); }
      this.parts.set(s.id, part);
      pending.push(part);
    }
    for (const p of pending) {
      const parent = p.parentId ? this.parts.get(p.parentId) : null;
      if (p.parentId && !parent) w(`part '${p.id}': parent '${p.parentId}' not found`);
      (parent ? parent.obj : this.root).add(p.obj);
      p.parent = parent || null;
      p.topLevel = !parent;
      this.syncTransform(p);
      this.applyOpacity(p);
      p.obj.visible = p.visible;
      if (this.cutaway) this.applyClipping(p, true);
      if (p.label && p.spec.anchor && !this.parts.has(p.spec.anchor)) w(`label '${p.id}': anchor '${p.spec.anchor}' not found`);
    }
  }
  computeExplodeCenter() {
    const box = new THREE.Box3();
    let any = false;
    for (const p of this.parts.values()) {
      if (!this.explodable(p)) continue;
      box.expandByPoint(p.home);
      any = true;
    }
    if (any) box.getCenter(this.explodeCenter); else this.explodeCenter.set(0, 0, 0);
  }
  append(extra) {
    if (!this.spec) { warn('append before load'); return 0; }
    const warnings = [];
    if (Array.isArray(extra?.parts)) {
      this.spec.parts.push(...extra.parts);
      this.addParts(extra.parts, warnings);
      this.computeExplodeCenter();
      this.applyExplode();
      this.placeGround();
    }
    if (Array.isArray(extra?.beats)) this.spec.beats.push(...extra.beats);
    this.beats = this.spec.beats;
    this.requestRender();
    return this.beats.length;
  }

  // ---------- per-part state ----------
  syncTransform(p) {
    p.obj.position.copy(p.home).add(p.off.explode).add(p.off.osc).add(p.off.anim);
    p.obj.scale.copy(p.baseScale).multiplyScalar(Math.max(0.0001, p.animScale));
  }
  applyOpacity(p) {
    const o = p.op.base * p.op.anim * p.op.dim * (p.xray ? XRAY_OPACITY : 1);
    for (const m of p.materials) {
      const target = m.userData.baseOpacity * o;
      m.opacity = target;
      const transparent = m.userData.baseTransparent || target < 0.999 || p.xray;
      if (transparent !== m.transparent) { m.transparent = transparent; m.needsUpdate = true; } // OPAQUE define is baked into the program
      m.depthWrite = !(target < 0.999 && !m.userData.baseTransparent) && !p.xray;
      if ('wireframe' in m && !m.isPointsMaterial) m.wireframe = p.xray;
    }
    if (p.label) p.label.setOpacity(o);
    if (p.extraLabels) p.extraLabels.forEach((l) => l.setOpacity(o));
    for (const s of p.outlines) s.material.visible = o > 0.05;
    // Ghosted or x-rayed parts shouldn't throw a solid (or dotted) shadow.
    const solid = !p.xray && o > 0.5;
    p.obj.traverse((m) => { if (m.isMesh && !m.userData.noPick && m.castShadow !== solid) m.castShadow = solid; });
  }
  setEmissive(p, glow, floor = 0) {
    const v = Math.max(glow, floor);
    for (const m of p.materials) {
      if (!m.emissive) continue;
      if (v > 0) { m.emissive.set(this.accent); m.emissiveIntensity = v; }
      else { m.emissive.set(0x000000); m.emissiveIntensity = m.userData.baseEmissive ?? 1; }
    }
  }
  addOutline(p) {
    if (p.outlines.length) return;
    p.obj.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh || o.userData.noPick || o.isSprite) return;
      const shell = new THREE.Mesh(o.geometry, this.outlineMaterial);
      shell.scale.setScalar(1.045);
      shell.castShadow = false;
      shell.receiveShadow = false;
      shell.userData.noPick = true;
      shell.renderOrder = 5;
      o.add(shell);
      p.outlines.push(shell);
    });
  }
  removeOutline(p) {
    for (const s of p.outlines) s.removeFromParent();
    p.outlines.length = 0;
  }
  setHighlight(ids, on) {
    for (const id of ids) {
      const p = this.parts.get(id);
      if (!p) { warn(`highlight: unknown id '${id}'`); continue; }
      p.highlighted = on;
      if (on) { this.highlighted.add(id); this.addOutline(p); }
      else { this.highlighted.delete(id); this.removeOutline(p); }
      for (const q of this.subtree(p)) this.setEmissive(q, this.isHighlighted(q) ? HIGHLIGHT_GLOW : 0);
    }
    this.updateDim();
  }
  updateDim() {
    const any = this.highlighted.size > 0;
    for (const p of this.parts.values()) {
      const anchor = p.label && p.spec.anchor ? this.parts.get(p.spec.anchor) : null;
      const lit = this.isHighlighted(p) || (anchor && this.isHighlighted(anchor));
      p.op.dim = any && !lit ? DIM_OPACITY : 1;
      this.applyOpacity(p);
    }
    this.requestRender();
  }
  explodable(p) {
    return p.topLevel && p.type !== 'label' && p.type !== 'axes' && p.type !== 'grid';
  }
  applyExplode() {
    for (const p of this.parts.values()) {
      if (!this.explodable(p)) continue;
      p.off.explode.subVectors(p.home, this.explodeCenter).multiplyScalar(this.explodeFactor);
      this.syncTransform(p);
    }
  }
  applyClipping(p, on) {
    for (const m of p.materials) {
      m.clippingPlanes = on ? [this.clipPlane] : null;
      m.side = on ? THREE.DoubleSide : m.userData.baseSide;
      m.needsUpdate = true;
    }
  }
  setCutaway(on, axis = 'x', at = 0) {
    this.cutaway = on;
    this.renderer.localClippingEnabled = on;
    if (on) {
      // Keeps the half-space where coord <= at.
      const n = new THREE.Vector3(axis === 'x' ? -1 : 0, axis === 'y' ? -1 : 0, axis === 'z' ? -1 : 0);
      this.clipPlane.set(n, at);
    }
    for (const p of this.parts.values()) this.applyClipping(p, on);
    this.outlineMaterial.clippingPlanes = on ? [this.clipPlane] : null;
    this.outlineMaterial.needsUpdate = true;
    this.requestRender();
  }
  updateParticles(p) {
    const { curve, count, phase } = p.particles;
    const attr = p.obj.geometry.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      const u = (i / count + phase) % 1;
      curve.getPointAt(u, v);
      attr.setXYZ(i, v.x, v.y, v.z);
    }
    attr.needsUpdate = true;
  }
  boundsOf(p) {
    const box = new THREE.Box3().setFromObject(p.obj, true);
    const sphere = new THREE.Sphere();
    if (box.isEmpty()) { sphere.center.copy(p.obj.getWorldPosition(new THREE.Vector3())); sphere.radius = 0.5; }
    else box.getBoundingSphere(sphere);
    return sphere;
  }
  updateLabels() {
    const world = new THREE.Vector3();
    for (const p of this.parts.values()) {
      if (!p.label || !p.spec.anchor) continue;
      const a = this.parts.get(p.spec.anchor);
      if (!a) continue;
      const anchorVisible = a.visible && a.op.anim > 0.01;
      p.obj.visible = p.visible && anchorVisible;
      if (!p.obj.visible) continue;
      const s = this.boundsOf(a);
      world.copy(s.center);
      const off = Array.isArray(p.spec.offset) ? new THREE.Vector3(...vec3(p.spec.offset)) : new THREE.Vector3(0, s.radius + 0.35, 0);
      p.label.place(world.clone().add(off), world);
    }
    if (this.hoverLabel && this.hoverId) {
      const a = this.parts.get(this.hoverId);
      if (a) { const s = this.boundsOf(a); this.hoverLabel.place(s.center.clone().add(new THREE.Vector3(0, s.radius + 0.3, 0)), s.center); }
    }
  }

  // ---------- tweens ----------
  tween(seconds, fn, onDone) {
    if (this.instant || seconds <= 0) { fn(1); onDone?.(); return 0; }
    this.tweens.push({ t: 0, dur: seconds, fn, onDone });
    this.schedule();
    return seconds;
  }
  tweenCamera(position, target, seconds) {
    const p0 = this.camera.position.clone(), t0 = this.controls.target.clone();
    const p1 = position ? new THREE.Vector3(...position) : p0.clone();
    const t1 = target ? new THREE.Vector3(...target) : t0.clone();
    return this.tween(seconds, (k) => {
      const e = easeInOutCubic(k);
      this.camera.position.lerpVectors(p0, p1, e);
      this.controls.target.lerpVectors(t0, t1, e);
      if (this.camera.isOrthographicCamera) {
        this.camera.zoom = this.baseDist / Math.max(0.01, this.camera.position.distanceTo(this.controls.target));
        this.camera.updateProjectionMatrix();
      }
      this.controls.update();
      this.requestRender();
    });
  }

  // ---------- actions ----------
  idsOf(a, warnMissing = true) {
    const ids = Array.isArray(a.ids) ? a.ids : a.id != null ? [a.id] : [];
    const out = [];
    for (const id of ids) {
      if (this.parts.has(id)) out.push(this.parts.get(id));
      else if (warnMissing) warn(`${a.type}: unknown id '${id}'`);
    }
    return out;
  }
  runAction(a) {
    if (!a || typeof a !== 'object') { warn('invalid action skipped'); return 0; }
    try {
      switch (a.type) {
        case 'show': return this.actShow(a);
        case 'hide': {
          const s = clampSeconds(a.seconds, 0.4);
          let max = 0;
          for (const p of this.idsOf(a)) {
            const from = p.op.anim;
            p.visible = false;
            max = Math.max(max, this.tween(s, (k) => { p.op.anim = lerp(from, 0, easeInOutCubic(k)); this.applyOpacity(p); this.requestRender(); },
              () => { p.obj.visible = false; p.op.anim = 1; this.applyOpacity(p); }));
          }
          return max;
        }
        case 'move': {
          const s = clampSeconds(a.seconds, 0.8);
          let max = 0;
          for (const p of this.idsOf(a)) {
            const from = p.home.clone(), to = new THREE.Vector3(...vec3(a.to, [from.x, from.y, from.z]));
            max = Math.max(max, this.tween(s, (k) => { p.home.lerpVectors(from, to, easeInOutCubic(k)); this.applyExplode(); this.syncTransform(p); this.requestRender(); }));
          }
          return max;
        }
        case 'rotate': {
          const s = clampSeconds(a.seconds, 0.8);
          const by = vec3(a.by, [0, 0, 0], 1000);
          let max = 0;
          for (const p of this.idsOf(a)) {
            let prev = 0;
            max = Math.max(max, this.tween(s, (k) => {
              const e = easeInOutCubic(k), d = e - prev; prev = e;
              p.obj.rotation.x += by[0] * d; p.obj.rotation.y += by[1] * d; p.obj.rotation.z += by[2] * d;
              this.requestRender();
            }));
          }
          return max;
        }
        case 'spin': {
          const axis = ['x', 'y', 'z'].includes(a.axis) ? a.axis : 'y';
          for (const p of this.idsOf(a)) p.spin[axis] = a.on === false ? 0 : num(a.rpm, 10, 10000);
          this.schedule();
          return 0;
        }
        case 'oscillate': {
          const axis = ['x', 'y', 'z'].includes(a.axis) ? a.axis : 'y';
          for (const p of this.idsOf(a)) {
            if (a.on === false) { p.osc = null; p.off.osc.set(0, 0, 0); this.syncTransform(p); }
            else p.osc = { axis, amplitude: num(a.amplitude, 0.5, 1000), period: Math.max(0.05, num(a.period, 1, 600)), on: true, t: p.osc?.t ?? 0 };
          }
          this.schedule();
          return 0;
        }
        case 'pulse': {
          if (this.instant) return 0;
          for (const p of this.idsOf(a)) this.pulses.push({ part: p, t: 0 });
          this.schedule();
          return 1.5;
        }
        case 'highlight': {
          const ids = Array.isArray(a.ids) ? a.ids : a.id != null ? [a.id] : [];
          this.setHighlight(ids, a.on !== false);
          return 0.3;
        }
        case 'camera': return this.tweenCamera(a.position ? vec3(a.position) : null, a.target ? vec3(a.target) : null, clampSeconds(a.seconds, 1.0));
        case 'orbit': {
          this.controls.autoRotate = a.on !== false && this.mode !== '2d';
          this.controls.autoRotateSpeed = num(a.rpm, 1, 100);
          this.schedule();
          return 0;
        }
        case 'explode': {
          const from = this.explodeFactor, to = Math.max(0, num(a.factor, 1, 50));
          return this.tween(clampSeconds(a.seconds, 0.8), (k) => { this.explodeFactor = lerp(from, to, easeInOutCubic(k)); this.applyExplode(); this.requestRender(); });
        }
        case 'cutaway': {
          this.setCutaway(a.on !== false, ['x', 'y', 'z'].includes(a.axis) ? a.axis : 'x', num(a.at, 0, 1000));
          return 0;
        }
        case 'xray': {
          const on = a.on !== false;
          const targets = Array.isArray(a.ids) ? this.idsOf(a).flatMap((p) => this.subtree(p)) : [...this.parts.values()];
          if (Array.isArray(a.ids) && on) for (const p of this.parts.values()) if (p.xray && !targets.includes(p)) { p.xray = false; this.applyOpacity(p); }
          for (const p of targets) { p.xray = on; this.applyOpacity(p); }
          this.requestRender();
          return 0.3;
        }
        case 'flow': {
          for (const p of this.idsOf(a)) {
            if (!p.particles) { warn(`flow: '${p.id}' is not a particles part`); continue; }
            p.particles.on = a.on !== false;
          }
          this.schedule();
          return 0;
        }
        case 'color': {
          for (const p of this.idsOf(a).flatMap((q) => this.subtree(q))) {
            for (const m of p.materials) if (m.color) m.color.set(a.color || this.accent);
            if (p.label) p.label.setAccent(a.color || this.accent);
          }
          this.requestRender();
          return 0;
        }
        case 'label': {
          for (const p of this.idsOf(a)) {
            if (p.label) p.label.setText(String(a.text ?? ''));
            else warn(`label: '${p.id}' is not a label part`);
          }
          this.requestRender();
          return 0;
        }
        case 'point': return 0;
        case 'wait': return this.instant ? 0 : clampSeconds(a.seconds, 1);
        default: warn(`unknown action type '${a.type}' skipped`); return 0;
      }
    } catch (e) {
      warn(`action '${a.type}' failed: ${e.message}`);
      return 0;
    }
  }
  actShow(a) {
    const effect = ['grow', 'fade', 'drop'].includes(a.effect) ? a.effect : 'grow';
    const s = clampSeconds(a.seconds, effect === 'drop' ? 0.9 : 0.6);
    let max = 0;
    for (const p of this.idsOf(a)) {
      p.visible = true;
      p.obj.visible = true;
      const finish = () => { p.animScale = 1; p.op.anim = 1; p.off.anim.set(0, 0, 0); this.syncTransform(p); this.applyOpacity(p); };
      if (effect === 'grow') {
        max = Math.max(max, this.tween(s, (k) => { p.animScale = Math.max(0.0001, easeOutBack(k)); p.op.anim = Math.min(1, k * 4); this.syncTransform(p); this.applyOpacity(p); this.requestRender(); }, finish));
      } else if (effect === 'fade') {
        max = Math.max(max, this.tween(s, (k) => { p.op.anim = easeInOutCubic(k); this.applyOpacity(p); this.requestRender(); }, finish));
      } else {
        max = Math.max(max, this.tween(s, (k) => { p.off.anim.set(0, 1.5 * (1 - easeOutBounce(k)), 0); p.op.anim = Math.min(1, k * 3); this.syncTransform(p); this.applyOpacity(p); this.requestRender(); }, finish));
      }
    }
    return max;
  }

  // ---------- beats ----------
  cancelBeatTimers() {
    for (const bt of this.beatTimers.splice(0)) bt.finish(false);
  }
  play(index) {
    const i = Math.round(num(index, 0, 1e6));
    const beat = this.beats[i];
    if (!beat) { warn(`play: no beat at index ${i}`); return Promise.resolve({ ok: false, index: i }); }
    this.cancelBeatTimers();
    this.paused = false;
    const actions = Array.isArray(beat.actions) ? beat.actions : [];
    let longest = 0;
    for (const a of actions) longest = Math.max(longest, this.runAction(a));
    const dur = Math.max(MIN_BEAT, num(beat.duration, longest, 600) || longest);
    post({ type: 'beatStart', index: i, say: beat.say ?? '', caption: beat.caption ?? null, duration: dur });
    return new Promise((resolve) => {
      this.beatTimers.push({ t: 0, dur, finish: (completed) => { if (completed) post({ type: 'beatDone', index: i }); resolve({ ok: true, index: i, completed }); } });
      this.schedule();
    });
  }
  restoreTo(index) {
    if (!this.spec) return;
    const n = Math.max(0, Math.min(this.beats.length, Math.round(num(index, 0, 1e6))));
    quiet = true;
    this.instant = true;
    try {
      this.build();
      for (let i = 0; i < n; i++) for (const a of (Array.isArray(this.beats[i]?.actions) ? this.beats[i].actions : [])) this.runAction(a);
    } finally { this.instant = false; quiet = false; }
    this.requestRender();
  }
  setSpeed(mult) { this.speed = Math.min(2, Math.max(0.5, num(mult, 1, 2))); }
  pause() { this.paused = true; this.requestRender(); }
  resume() { this.paused = false; this.last = performance.now(); this.schedule(); }

  // ---------- Swift-facing helpers ----------
  highlightPart(id) {
    const current = [...this.highlighted];
    if (current.length) this.setHighlight(current, false);
    if (id != null && this.parts.has(id)) this.setHighlight([id], true);
  }
  focusPart(id) {
    const p = this.parts.get(id);
    if (!p) { warn(`focusPart: unknown id '${id}'`); return; }
    const s = this.boundsOf(p);
    const r = Math.max(0.2, s.radius);
    let position;
    if (this.camera.isOrthographicCamera) {
      const fovRad = THREE.MathUtils.degToRad(this.cameraSpec.fov / 2);
      position = [s.center.x, s.center.y, Math.max(0.5, (r * 1.4) / Math.tan(fovRad))];
    } else {
      const dir = this.camera.position.clone().sub(this.controls.target).normalize();
      const dist = (r / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2))) * 1.25;
      position = s.center.clone().addScaledVector(dir, dist).toArray();
    }
    this.tweenCamera(position, s.center.toArray(), 0.9);
    this.highlightPart(id);
  }
  resetView() {
    this.cancelBeatTimers();
    const spec = this.cameraSpec;
    this.tweenCamera(spec.position, spec.target, 0.9);
    if (this.explodeFactor) this.runAction({ type: 'explode', factor: 0, seconds: 0.6 });
    this.setCutaway(false);
    for (const p of this.parts.values()) if (p.xray) { p.xray = false; this.applyOpacity(p); }
    this.highlightPart(null);
    this.controls.autoRotate = false;
  }
  setAccent(color) {
    try { new THREE.Color(color); } catch (e) { warn(`setAccent: invalid color '${color}'`); return; }
    this.accent = color;
    this.outlineMaterial.color.set(color);
    if (this.placeholder) { this.placeholder.mat.color.set(color); this.placeholder.dotsMat.color.set(color); }
    this.forEachLabel((l) => l.setAccent(color));
    for (const p of this.parts.values()) if (this.isHighlighted(p)) this.setEmissive(p, HIGHLIGHT_GLOW);
    this.requestRender();
  }
  screenshot() {
    this.render();
    return this.renderer.domElement.toDataURL('image/png');
  }
  partAt(x, y) {
    const ndc = new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.root.children, true);
    for (const h of hits) {
      let o = h.object, blocked = false, id = null;
      while (o && o !== this.root) {
        if (o.userData.noPick || !o.visible) { blocked = true; break; }
        if (!id && o.userData.partId) id = o.userData.partId;
        o = o.parent;
      }
      if (blocked || !id) continue;
      const p = this.parts.get(id);
      if (p && p.op.anim > 0.05) return id;
    }
    return null;
  }
  setHover(id) {
    if (id === this.hoverId) return;
    this.hoverId = id;
    if (this.hoverLabel) { this.hoverLabel.dispose(); this.hoverLabel = null; }
    const p = id ? this.parts.get(id) : null;
    this.renderer.domElement.style.cursor = p ? 'pointer' : '';
    if (p && p.spec.name && !(p.type === 'label')) {
      const hasOwnLabel = [...this.parts.values()].some((q) => q.label && q.spec.anchor === id && q.obj.visible);
      if (!hasOwnLabel) {
        this.hoverLabel = new Label({ text: p.spec.name, accent: this.accent, dpr: this.dpr });
        this.hoverLabel.setViewport(this.width, this.height);
        this.hoverLabel.group.renderOrder = 1001;
        this.scene.add(this.hoverLabel.group);
      }
    }
    post(p ? { type: 'partHover', id, name: p.spec.name ?? null } : { type: 'partHover', id: null });
    this.requestRender();
  }
  dispose() {
    this.clearScene();
    if (this.placeholder) { this.placeholder.group.removeFromParent(); this.placeholder = null; }
    this.resizeObserver.disconnect();
    this.controls.dispose();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.scene.environment?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

// ---------- bootstrap ----------
const container = document.getElementById('stage') || document.body;
const stage = new Stage(container);
const api = {
  load: (spec) => stage.load(spec),
  append: (extra) => stage.append(extra),
  play: (i) => stage.play(i),
  restoreTo: (i) => stage.restoreTo(i),
  setSpeed: (m) => stage.setSpeed(m),
  pause: () => stage.pause(),
  resume: () => stage.resume(),
  highlightPart: (id) => stage.highlightPart(id),
  focusPart: (id) => stage.focusPart(id),
  resetView: () => stage.resetView(),
  setAccent: (c) => stage.setAccent(c),
  setBuilding: (on) => stage.setBuilding(!!on),
  screenshot: () => stage.screenshot(),
  partAt: (x, y) => stage.partAt(x, y),
  dispose: () => stage.dispose(),
  get beatCount() { return stage.beats.length; },
  get parts() { return [...stage.parts.keys()]; },
  _stage: stage,
};
window.okidokiStage = api;
window.addEventListener('error', (e) => post({ type: 'error', message: String(e.message || e.error || 'unknown error') }));
window.addEventListener('unhandledrejection', (e) => post({ type: 'error', message: String(e.reason?.message || e.reason || 'unhandled rejection') }));
post({ type: 'ready' });

export default api;
