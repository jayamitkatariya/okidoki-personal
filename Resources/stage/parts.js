// Builders for every Part type in the scene spec. Each returns { obj, materials, label? }.
import * as THREE from './three.module.js';
import { compile } from './expr.js';
import { Label } from './labels.js';

export const DEFAULT_COLOR = '#B8C0CC';
const MAX_COORD = 1000, MAX_RADIUS = 500;

export const num = (v, def, max = MAX_COORD) => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : def;
  return Math.max(-max, Math.min(max, n));
};
export const vec3 = (v, def = [0, 0, 0], max = MAX_COORD) =>
  Array.isArray(v) && v.length >= 3 ? [num(v[0], def[0], max), num(v[1], def[1], max), num(v[2], def[2], max)] : def.slice();
const radius = (v, def) => Math.max(0.001, num(v, def, MAX_RADIUS));
const int = (v, def, max) => Math.max(1, Math.min(max, Math.round(num(v, def, max))));

export function standardMaterial(spec, ctx, extra = {}) {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(spec.color || ctx.defaultColor || DEFAULT_COLOR),
    metalness: num(spec.metal, 0.1, 1),
    roughness: num(spec.rough, 0.55, 1),
    ...extra,
  });
}

function mesh(geometry, material) {
  const m = new THREE.Mesh(geometry, material);
  m.castShadow = false;
  return m;
}

// ---------- curves ----------
class Helix extends THREE.Curve {
  constructor(r, h, coils) { super(); this.r = r; this.h = h; this.coils = coils; }
  getPoint(t, target = new THREE.Vector3()) {
    const a = t * Math.PI * 2 * this.coils;
    return target.set(Math.cos(a) * this.r, (t - 0.5) * this.h, Math.sin(a) * this.r);
  }
}
export function pathCurve(path, closed) {
  const pts = (Array.isArray(path) ? path : []).map((p) => new THREE.Vector3(...vec3(p)));
  if (pts.length < 2) pts.push(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0));
  return new THREE.CatmullRomCurve3(pts, !!closed, 'centripetal');
}

// ---------- gear outline ----------
function gearShape(r, teeth, hole) {
  const m = (2 * r) / teeth;
  const tip = r + m, root = Math.max(r * 0.3, r - 1.25 * m);
  const p = (Math.PI * 2) / teeth;
  const shape = new THREE.Shape();
  const pt = (rad, a) => [Math.cos(a) * rad, Math.sin(a) * rad];
  for (let i = 0; i < teeth; i++) {
    const a = i * p;
    const seq = [[root, a], [tip, a + 0.14 * p], [tip, a + 0.36 * p], [root, a + 0.5 * p], [root, a + 0.75 * p]];
    seq.forEach(([rad, ang], k) => {
      const [x, y] = pt(rad, ang);
      if (i === 0 && k === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
    });
  }
  shape.closePath();
  if (hole > 0) {
    const h = new THREE.Path();
    h.absarc(0, 0, Math.min(hole, root * 0.9), 0, Math.PI * 2, true);
    shape.holes.push(h);
  }
  return shape;
}

// ---------- element data ----------
const CPK = {
  H: '#F4F4F4', C: '#8C8C8C', N: '#3B6BF5', O: '#F0453C', S: '#F5D23B', P: '#F59A2B',
  F: '#5FDB5F', Cl: '#3FD13F', Br: '#A6442A', I: '#8E3BB8', B: '#FFB5B5', Fe: '#E06633',
  Na: '#AB5CF2', K: '#8F40D4', Ca: '#3DFF00', Mg: '#8AFF00', Zn: '#7D80B0', Cu: '#C88033',
};
const COVALENT = { H: 0.31, C: 0.76, N: 0.71, O: 0.66, S: 1.05, P: 1.07, F: 0.57, Cl: 1.02, Br: 1.2, I: 1.39, B: 0.84, Fe: 1.32, Na: 1.66, K: 2.03, Ca: 1.76, Mg: 1.41, Zn: 1.22, Cu: 1.32 };
const VDW = { H: 1.2, C: 1.7, N: 1.55, O: 1.52, S: 1.8, P: 1.8, F: 1.47, Cl: 1.75, Br: 1.85, I: 1.98, B: 1.92, Fe: 2.0, Na: 2.27, K: 2.75, Ca: 2.31, Mg: 1.73, Zn: 1.39, Cu: 1.4 };
const normEl = (el) => (typeof el === 'string' && el.length ? el[0].toUpperCase() + el.slice(1).toLowerCase() : 'C');

// ---------- textures ----------
let dotTexture = null;
function getDotTexture() {
  if (dotTexture) return dotTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.9)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  dotTexture = new THREE.CanvasTexture(c);
  return dotTexture;
}

function textPlane(text, size, color) {
  const font = `600 64px -apple-system, system-ui, "Helvetica Neue", Helvetica, Arial, sans-serif`;
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  g.font = font;
  const w = Math.ceil(g.measureText(text).width) + 16, h = 80;
  c.width = w; c.height = h;
  g.font = font;
  g.fillStyle = color;
  g.textBaseline = 'middle';
  g.fillText(text, 8, h / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const m = mesh(new THREE.PlaneGeometry((w / h) * size, size), mat);
  return { obj: m, materials: [mat] };
}

// Orient a Y-axis geometry from a to b. Returns the mesh positioned at midpoint.
function alignY(obj, a, b) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length() || 1e-6;
  obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  obj.position.copy(a).addScaledVector(dir, len / 2);
  return len;
}

// ---------- builders ----------
const builders = {
  group: () => ({ obj: new THREE.Group(), materials: [] }),

  box(s, ctx) {
    const [w, h, d] = vec3(s.size, [1, 1, 1], MAX_RADIUS);
    const mat = standardMaterial(s, ctx);
    return { obj: mesh(new THREE.BoxGeometry(w, h, d), mat), materials: [mat] };
  },
  sphere(s, ctx) {
    const mat = standardMaterial(s, ctx);
    return { obj: mesh(new THREE.SphereGeometry(radius(s.radius, 0.5), 40, 28), mat), materials: [mat] };
  },
  cylinder(s, ctx) {
    const r = radius(s.radius, 0.5);
    const geo = new THREE.CylinderGeometry(radius(s.radiusTop, r), radius(s.radiusBottom, r), radius(s.height, 1), 40, 1, !!s.open);
    const mat = standardMaterial(s, ctx, s.open ? { side: THREE.DoubleSide } : {});
    return { obj: mesh(geo, mat), materials: [mat] };
  },
  cone(s, ctx) {
    const mat = standardMaterial(s, ctx);
    return { obj: mesh(new THREE.ConeGeometry(radius(s.radius, 0.5), radius(s.height, 1), 40), mat), materials: [mat] };
  },
  torus(s, ctx) {
    const mat = standardMaterial(s, ctx);
    return { obj: mesh(new THREE.TorusGeometry(radius(s.radius, 1), radius(s.tube, 0.2), 20, 80), mat), materials: [mat] };
  },
  tube(s, ctx) {
    const curve = pathCurve(s.path, s.closed);
    const geo = new THREE.TubeGeometry(curve, Math.min(400, Math.max(8, curve.points.length * 12)), radius(s.radius, 0.1), 14, !!s.closed);
    const mat = standardMaterial(s, ctx);
    return { obj: mesh(geo, mat), materials: [mat] };
  },
  gear(s, ctx) {
    const r = radius(s.radius, 1), t = radius(s.thickness, 0.3);
    const shape = gearShape(r, int(s.teeth, 12, 200), num(s.hole, 0, MAX_RADIUS));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: true, bevelSize: t * 0.08, bevelThickness: t * 0.08, bevelSegments: 2, curveSegments: 8 });
    geo.translate(0, 0, -t / 2);
    const mat = standardMaterial({ metal: 0.6, rough: 0.4, ...s }, ctx);
    return { obj: mesh(geo, mat), materials: [mat] };
  },
  spring(s, ctx) {
    const coils = Math.max(1, num(s.coils, 6, 200));
    const curve = new Helix(radius(s.radius, 0.5), radius(s.height, 2), coils);
    const geo = new THREE.TubeGeometry(curve, Math.min(2000, Math.round(coils * 24)), radius(s.tube, 0.05), 10, false);
    const mat = standardMaterial({ metal: 0.7, rough: 0.35, ...s }, ctx);
    return { obj: mesh(geo, mat), materials: [mat] };
  },
  arrow(s, ctx) {
    const a = new THREE.Vector3(...vec3(s.from)), b = new THREE.Vector3(...vec3(s.to, [0, 1, 0]));
    const len = Math.max(1e-3, a.distanceTo(b));
    const w = radius(s.width, Math.max(0.03, len * 0.05));
    const headLen = Math.min(len * 0.4, w * 4), headR = w * 2;
    const mat = standardMaterial({ color: ctx.accent, metal: 0.2, rough: 0.5, ...s }, ctx);
    const group = new THREE.Group();
    const dir = new THREE.Vector3().subVectors(b, a).normalize();
    const shaftEnd = b.clone().addScaledVector(dir, -headLen);
    const shaft = mesh(new THREE.CylinderGeometry(w / 2, w / 2, 1, 16), mat);
    const sl = alignY(shaft, a, shaftEnd);
    shaft.scale.set(1, sl, 1);
    const head = mesh(new THREE.ConeGeometry(headR, headLen, 24), mat);
    alignY(head, shaftEnd, b);
    group.add(shaft, head);
    return { obj: group, materials: [mat] };
  },
  label(s, ctx) {
    const label = new Label({ text: String(s.text ?? s.name ?? ''), size: num(s.size, 1, 10), accent: ctx.accent, dpr: ctx.dpr });
    label.setViewport(ctx.width, ctx.height);
    return { obj: label.group, materials: [], label };
  },
  plane(s, ctx) {
    const [w, h] = Array.isArray(s.size) ? [radius(s.size[0], 1), radius(s.size[1], 1)] : [1, 1];
    const mat = standardMaterial(s, ctx, { side: s.doubleSide ? THREE.DoubleSide : THREE.FrontSide });
    return { obj: mesh(new THREE.PlaneGeometry(w, h), mat), materials: [mat] };
  },
  surface(s, ctx) {
    const f = compile(String(s.expr ?? '0'));
    const [x0, x1] = Array.isArray(s.xRange) ? [num(s.xRange[0], -3), num(s.xRange[1], 3)] : [-3, 3];
    const [y0, y1] = Array.isArray(s.yRange) ? [num(s.yRange[0], -3), num(s.yRange[1], 3)] : [-3, 3];
    const n = int(s.segments, 80, 400);
    const pos = new Float32Array((n + 1) * (n + 1) * 3);
    const idx = [];
    let zmin = Infinity, zmax = -Infinity;
    const scope = { x: 0, y: 0, t: 0 };
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const x = x0 + ((x1 - x0) * i) / n, y = y0 + ((y1 - y0) * j) / n;
        scope.x = x; scope.y = y;
        let z = f(scope);
        if (!Number.isFinite(z)) z = 0;
        z = Math.max(-MAX_COORD, Math.min(MAX_COORD, z));
        zmin = Math.min(zmin, z); zmax = Math.max(zmax, z);
        const k = (j * (n + 1) + i) * 3;
        pos[k] = x; pos[k + 1] = z; pos[k + 2] = -y; // math (x,y,z=f) → world (X, Y=up, -Z)
      }
    }
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const colorBy = s.colorBy === 'height';
    if (colorBy) {
      const cold = new THREE.Color('#3B82F6'), mid = new THREE.Color(ctx.accent), warm = new THREE.Color('#F59E0B');
      const col = new Float32Array(pos.length);
      const span = zmax - zmin || 1;
      const c = new THREE.Color();
      for (let k = 0; k < pos.length; k += 3) {
        const u = (pos[k + 1] - zmin) / span;
        if (u < 0.5) c.lerpColors(cold, mid, u * 2); else c.lerpColors(mid, warm, (u - 0.5) * 2);
        col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
    const mat = standardMaterial({ color: colorBy ? '#ffffff' : s.color || ctx.accent, metal: 0.05, rough: 0.6, ...s, ...(colorBy ? { color: '#ffffff' } : {}) }, ctx, { side: THREE.DoubleSide, vertexColors: colorBy });
    return { obj: mesh(geo, mat), materials: [mat] };
  },
  plot(s, ctx) {
    const f = compile(String(s.expr ?? '0'));
    const [x0, x1] = Array.isArray(s.xRange) ? [num(s.xRange[0], -5), num(s.xRange[1], 5)] : [-5, 5];
    const n = int(s.samples, 200, 4000);
    const pts = [];
    const scope = { x: 0, t: 0 };
    for (let i = 0; i <= n; i++) {
      scope.x = x0 + ((x1 - x0) * i) / n;
      let y = f(scope);
      if (!Number.isFinite(y)) y = 0;
      pts.push(new THREE.Vector3(scope.x, Math.max(-MAX_COORD, Math.min(MAX_COORD, y)), 0));
    }
    const w = radius(s.width, 0.05);
    const color = s.color || ctx.accent;
    if (ctx.mode === '2d') {
      // Ribbon strip of constant width in the XY plane.
      const pos = new Float32Array(pts.length * 6);
      const idx = [];
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i], q = pts[Math.min(i + 1, pts.length - 1)], o = pts[Math.max(i - 1, 0)];
        const tx = q.x - o.x, ty = q.y - o.y, l = Math.hypot(tx, ty) || 1;
        const nx = (-ty / l) * (w / 2), ny = (tx / l) * (w / 2);
        pos.set([p.x + nx, p.y + ny, 0, p.x - nx, p.y - ny, 0], i * 6);
        if (i < pts.length - 1) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setIndex(idx);
      const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color), side: THREE.DoubleSide });
      return { obj: mesh(geo, mat), materials: [mat] };
    }
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const geo = new THREE.TubeGeometry(curve, n, w / 2, 8, false);
    const mat = standardMaterial({ metal: 0.2, rough: 0.4, ...s, color }, ctx);
    return { obj: mesh(geo, mat), materials: [mat] };
  },
  axes(s, ctx) {
    const size = radius(s.size, 5);
    const labels = Array.isArray(s.labels) ? s.labels : ['x', 'y', 'z'];
    const group = new THREE.Group();
    const lineMat = new THREE.LineBasicMaterial({ color: '#C9CED6', transparent: true, opacity: 0.7 });
    const headMat = new THREE.MeshBasicMaterial({ color: '#C9CED6', transparent: true, opacity: 0.9 });
    const dirs = ctx.mode === '2d' ? [[1, 0, 0], [0, 1, 0]] : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const segs = [];
    const labelObjs = [];
    dirs.forEach((d, i) => {
      const dir = new THREE.Vector3(...d);
      segs.push(dir.clone().multiplyScalar(-size), dir.clone().multiplyScalar(size));
      const head = mesh(new THREE.ConeGeometry(size * 0.02, size * 0.08, 16), headMat);
      alignY(head, dir.clone().multiplyScalar(size - size * 0.08), dir.clone().multiplyScalar(size));
      group.add(head);
      if (s.ticks !== false) {
        const step = size > 20 ? 5 : size > 8 ? 2 : 1;
        const tdir = i === 0 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
        for (let v = -Math.floor(size); v <= Math.floor(size); v += step) {
          if (v === 0) continue;
          const p = dir.clone().multiplyScalar(v);
          segs.push(p.clone().addScaledVector(tdir, -size * 0.015), p.clone().addScaledVector(tdir, size * 0.015));
        }
      }
      const label = new Label({ text: String(labels[i] ?? 'xyz'[i]), size: 0.9, accent: ctx.accent, dpr: ctx.dpr });
      label.setViewport(ctx.width, ctx.height);
      label.place(dir.clone().multiplyScalar(size * 1.08));
      group.add(label.group);
      labelObjs.push(label);
    });
    const geo = new THREE.BufferGeometry().setFromPoints(segs);
    group.add(new THREE.LineSegments(geo, lineMat));
    group.userData.noPick = true;
    group.traverse((o) => { o.userData.noPick = true; });
    return { obj: group, materials: [lineMat, headMat], extraLabels: labelObjs };
  },
  grid(s, ctx) {
    const g = new THREE.GridHelper(radius(s.size, 10), int(s.divisions, 10, 500), new THREE.Color('#6B7280'), new THREE.Color('#3A3F47'));
    g.material.transparent = true;
    g.material.opacity = 0.5;
    if (ctx.mode === '2d') g.rotation.x = Math.PI / 2;
    g.userData.noPick = true;
    return { obj: g, materials: [g.material] };
  },
  molecule(s, ctx) {
    const atoms = Array.isArray(s.atoms) ? s.atoms : [];
    const spaceFill = s.style === 'space-fill';
    const group = new THREE.Group();
    const mats = {};
    const matFor = (el) => mats[el] || (mats[el] = new THREE.MeshStandardMaterial({ color: new THREE.Color(CPK[el] || '#F078C8'), metalness: 0.05, roughness: 0.45 }));
    const sphereGeo = new THREE.SphereGeometry(1, 32, 22);
    const positions = atoms.map((a) => new THREE.Vector3(...vec3(a.pos)));
    atoms.forEach((a, i) => {
      const el = normEl(a.el);
      const r = spaceFill ? VDW[el] || 1.6 : (COVALENT[el] || 0.75) * 0.3;
      const m = mesh(sphereGeo, matFor(el));
      m.scale.setScalar(r);
      m.position.copy(positions[i]);
      group.add(m);
    });
    if (!spaceFill) {
      const bondMat = new THREE.MeshStandardMaterial({ color: '#D5D9E0', metalness: 0.1, roughness: 0.5 });
      mats.__bond = bondMat;
      const bondGeo = new THREE.CylinderGeometry(1, 1, 1, 12);
      const up = new THREE.Vector3(0, 1, 0), arb = new THREE.Vector3(0, 0, 1);
      (Array.isArray(s.bonds) ? s.bonds : []).forEach((b) => {
        if (!Array.isArray(b) || !positions[b[0]] || !positions[b[1]]) return;
        const order = Math.max(1, Math.min(3, Math.round(num(b[2], 1, 3))));
        const a = positions[b[0]], c = positions[b[1]];
        const dir = new THREE.Vector3().subVectors(c, a);
        const perp = new THREE.Vector3().crossVectors(dir, Math.abs(dir.clone().normalize().dot(arb)) > 0.9 ? up : arb).normalize();
        const br = order === 1 ? 0.07 : 0.045, spread = order === 1 ? 0 : 0.11;
        for (let k = 0; k < order; k++) {
          const off = perp.clone().multiplyScalar(spread * (k - (order - 1) / 2));
          const m = mesh(bondGeo, bondMat);
          const len = alignY(m, a.clone().add(off), c.clone().add(off));
          m.scale.set(br, len, br);
          group.add(m);
        }
      });
    }
    return { obj: group, materials: Object.values(mats) };
  },
  particles(s, ctx) {
    const curve = pathCurve(s.path, s.closed);
    const count = int(s.count, 30, 5000);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    const mat = new THREE.PointsMaterial({
      color: new THREE.Color(s.color || ctx.accent), size: radius(s.size, 0.12), map: getDotTexture(),
      transparent: true, depthWrite: false, sizeAttenuation: true, blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.userData.noPick = true;
    const particles = { curve, count, speed: Math.max(0, num(s.speed, 1, 100)), closed: !!s.closed, phase: 0, length: curve.getLength() || 1 };
    return { obj: points, materials: [mat], particles };
  },
  text(s, ctx) {
    return textPlane(String(s.text ?? ''), radius(s.size, 0.5), s.color || '#FFFFFF');
  },
  ring(s, ctx) {
    const r = radius(s.radius, 1);
    const geo = new THREE.TorusGeometry(r, radius(s.tube, Math.max(0.004, r * 0.006)), 6, int(s.segments, 160, 720));
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(s.color || '#9AA3B2'), transparent: true, opacity: 0.6 });
    const m = mesh(geo, mat);
    if (ctx.mode !== '2d') m.rotation.x = Math.PI / 2;
    m.userData.noPick = true;
    return { obj: m, materials: [mat] };
  },
  lattice(s, ctx) {
    const nx = int(s.nx, 3, 40), ny = int(s.ny, 3, 40), nz = int(s.nz, 3, 40);
    const sp = radius(s.spacing, 1);
    const mat = standardMaterial({ metal: 0.3, rough: 0.4, ...s }, ctx);
    const inst = new THREE.InstancedMesh(new THREE.SphereGeometry(radius(s.radius, sp * 0.2), 24, 16), mat, nx * ny * nz);
    const m4 = new THREE.Matrix4();
    let k = 0;
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let l = 0; l < nz; l++) {
      m4.makeTranslation((i - (nx - 1) / 2) * sp, (j - (ny - 1) / 2) * sp, (l - (nz - 1) / 2) * sp);
      inst.setMatrixAt(k++, m4);
    }
    inst.instanceMatrix.needsUpdate = true;
    return { obj: inst, materials: [mat] };
  },
};

export const PART_TYPES = Object.keys(builders);

// Returns { obj, materials, label?, particles?, extraLabels? } or null for unknown types.
export function buildPart(spec, ctx) {
  const b = builders[spec.type];
  if (!b) return null;
  return b(spec, ctx);
}

export function disposeObject(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) { if (m.map) m.map.dispose(); m.dispose(); }
  });
}
