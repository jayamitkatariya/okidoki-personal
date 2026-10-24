// Billboard label sprites rendered from a 2D canvas, with optional leader lines.
import * as THREE from './three.module.js';

const FONT = '600 13px -apple-system, system-ui, "Helvetica Neue", Helvetica, Arial, sans-serif';
const PAD_X = 10, PAD_Y = 6, DOT = 5, GAP = 7, RADIUS = 9;

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Draws the pill and returns { texture, width, height } in CSS pixels.
function paint(text, accent, scale) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = FONT;
  const tw = Math.ceil(ctx.measureText(text).width);
  const w = PAD_X * 2 + DOT + GAP + tw;
  const h = PAD_Y * 2 + 16;
  canvas.width = Math.ceil(w * scale);
  canvas.height = Math.ceil(h * scale);
  ctx.scale(scale, scale);
  ctx.font = FONT;
  ctx.fillStyle = 'rgba(16, 18, 22, 0.86)';
  roundRect(ctx, 0.5, 0.5, w - 1, h - 1, RADIUS);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(PAD_X + DOT / 2, h / 2, DOT / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, PAD_X + DOT + GAP, h / 2 + 0.5);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return { texture, width: w, height: h };
}

export class Label {
  constructor({ text, size = 1, accent = '#44E45E', dpr = 2 }) {
    this.text = text;
    this.size = size;
    this.accent = accent;
    this.dpr = dpr;
    this.material = new THREE.SpriteMaterial({ transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false });
    this.sprite = new THREE.Sprite(this.material);
    this.sprite.renderOrder = 1000;
    this.sprite.userData.noPick = true;
    this.lineMaterial = new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.55, depthTest: false });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    this.leader = new THREE.Line(geo, this.lineMaterial);
    this.leader.renderOrder = 999;
    this.leader.userData.noPick = true;
    this.leader.frustumCulled = false;
    this.leader.visible = false;
    this.group = new THREE.Group();
    this.group.userData.noPick = true;
    this.group.add(this.sprite, this.leader);
    this.viewportHeight = 600;
    this.repaint();
  }

  setText(text) { this.text = text; this.repaint(); }
  setAccent(accent) {
    this.accent = accent;
    this.lineMaterial.color.set(accent);
    this.repaint();
  }

  repaint() {
    const old = this.material.map;
    const { texture, width, height } = paint(this.text, this.accent, this.dpr);
    this.material.map = texture;
    this.material.needsUpdate = true;
    this.pxWidth = width;
    this.pxHeight = height;
    if (old) old.dispose();
    this.applyScale();
  }

  // sizeAttenuation=false → the sprite shader keeps screen size constant, but the
  // projection matrix still scales it. Undo that so the pill is pxWidth×pxHeight CSS px.
  setViewport(width, height, camera) {
    this.viewportWidth = width;
    this.viewportHeight = height;
    this.camera = camera || this.camera;
    this.applyScale();
  }
  applyScale() {
    const vh = this.viewportHeight || 600, vw = this.viewportWidth || 800;
    let fx = 1, fy = 1;
    const cam = this.camera;
    if (cam && cam.isPerspectiveCamera) {
      fy = Math.tan((cam.fov * Math.PI) / 360);
      fx = fy * cam.aspect;
    } else if (cam && cam.isOrthographicCamera) {
      fy = (cam.top - cam.bottom) / 2 / cam.zoom;
      fx = (cam.right - cam.left) / 2 / cam.zoom;
    }
    this.sprite.scale.set((2 * this.pxWidth * this.size * fx) / vw, (2 * this.pxHeight * this.size * fy) / vh, 1);
  }

  // Position the sprite at `at` and draw a leader from `from` (optional).
  place(at, from) {
    this.sprite.position.copy(at);
    if (from) {
      const a = this.leader.geometry.attributes.position;
      a.setXYZ(0, from.x, from.y, from.z);
      a.setXYZ(1, at.x, at.y, at.z);
      a.needsUpdate = true;
      this.leader.visible = true;
    } else {
      this.leader.visible = false;
    }
  }

  setOpacity(o) {
    this.material.opacity = o;
    this.lineMaterial.opacity = 0.55 * o;
  }

  dispose() {
    if (this.material.map) this.material.map.dispose();
    this.material.dispose();
    this.lineMaterial.dispose();
    this.leader.geometry.dispose();
    this.group.removeFromParent();
  }
}
