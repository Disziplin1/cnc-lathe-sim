import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Vec } from '../nc/types';
import { SCALE, type Paths } from '../sim/geometry';
import { chuckBox, protrusionOf, type StockConfig } from '../sim/simulator';
import { tapOutline, type ToolDef } from '../machine/tools';
import { coarsePitch } from '../sim/features';

const RADIAL = 72;

/** 단면 다각형을 Z축(three 의 x축) 둘레로 회전시켜 솔리드 메시를 만든다 */
function revolve(paths: Paths): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  const cos: number[] = [];
  const sin: number[] = [];
  for (let j = 0; j <= RADIAL; j++) {
    const th = (j / RADIAL) * Math.PI * 2;
    cos.push(Math.cos(th));
    sin.push(Math.sin(th));
  }
  for (const path of paths) {
    const n = path.length;
    for (let i = 0; i < n; i++) {
      const a = { z: path[i].X / SCALE, r: path[i].Y / SCALE };
      const b = { z: path[(i + 1) % n].X / SCALE, r: path[(i + 1) % n].Y / SCALE };
      if (a.r < 1e-3 && b.r < 1e-3) continue;
      const dz = b.z - a.z;
      const dr = b.r - a.r;
      const len = Math.hypot(dz, dr);
      if (len < 1e-6) continue;
      const nz = dr / len;
      const nr = -dz / len;
      const base = pos.length / 3;
      for (let j = 0; j <= RADIAL; j++) {
        pos.push(a.z, a.r * cos[j], a.r * sin[j], b.z, b.r * cos[j], b.r * sin[j]);
        nor.push(nz, nr * cos[j], nr * sin[j], nz, nr * cos[j], nr * sin[j]);
      }
      for (let j = 0; j < RADIAL; j++) {
        const a0 = base + 2 * j;
        idx.push(a0, a0 + 1, a0 + 2, a0 + 1, a0 + 3, a0 + 2);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

/** 널링 무늬 (마름모) 텍스처: 한 칸 = 마름모 하나 */
let knurlTex: THREE.CanvasTexture | null = null;
function knurlTexture(): THREE.CanvasTexture {
  if (knurlTex) return knurlTex;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 32;
  const c = cv.getContext('2d')!;
  c.fillStyle = '#a7b0bb';
  c.fillRect(0, 0, 32, 32);
  c.strokeStyle = '#4b535e';
  c.lineWidth = 3;
  c.beginPath();
  c.moveTo(0, 0);
  c.lineTo(32, 32);
  c.moveTo(32, 0);
  c.lineTo(0, 32);
  c.stroke();
  knurlTex = new THREE.CanvasTexture(cv);
  knurlTex.wrapS = knurlTex.wrapT = THREE.RepeatWrapping;
  knurlTex.colorSpace = THREE.SRGBColorSpace;
  return knurlTex;
}

/** 널링 구간 [a, b] 가운데에서 소재 바깥 반경 (단면 다각형 변이 그 Z 를 지나는 곳) */
function outerRadius(paths: Paths, a: number, b: number): number {
  const zm = (a + b) / 2;
  let r = 0;
  for (const path of paths)
    for (let i = 0; i < path.length; i++) {
      const p = path[i];
      const q = path[(i + 1) % path.length];
      const [z0, z1] = [p.X / SCALE, q.X / SCALE];
      if ((z0 - zm) * (z1 - zm) > 0 || z0 === z1) continue;
      r = Math.max(r, (p.Y + ((q.Y - p.Y) * (zm - z0)) / (z1 - z0)) / SCALE);
    }
  return r;
}

const holderMat = new THREE.MeshStandardMaterial({ color: '#5b6472', metalness: 0.7, roughness: 0.4 });

/** 공구 좌표(z, r, 접선 방향 깊이)로 상자 만들기 */
function box(z0: number, z1: number, r0: number, r1: number, d0: number, d1: number, mat: THREE.Material) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(z1 - z0, r1 - r0, d1 - d0), mat);
  m.position.set((z0 + z1) / 2, (r0 + r1) / 2, (d0 + d1) / 2);
  return m;
}

/** 2D 윤곽을 접선 방향(d0~d1)으로 두께를 준 판 */
function plate(pts: Vec[], d0: number, d1: number, mat: THREE.Material) {
  const g = new THREE.ExtrudeGeometry(new THREE.Shape(pts.map((p) => new THREE.Vector2(p.z, p.r))), {
    depth: d1 - d0,
    bevelEnabled: false,
  });
  g.translate(0, 0, d0);
  return new THREE.Mesh(g, mat);
}

/**
 * 공구 3D 모델 (원점 = 공구 끝점).
 * 인서트는 2D 절삭 윤곽 그대로, 홀더·생크·보링바·드릴 몸체를 덧붙인다.
 * 접선 방향(three 의 z)은 인서트 윗면(경사면)이 0, 생크는 그 아래(-)에 있다.
 */
function buildTool(def: ToolDef, shape: Vec[], color: string): THREE.Group {
  const g = new THREE.Group();
  const tipMat = new THREE.MeshStandardMaterial({ color, metalness: 0.35, roughness: 0.45 });
  const zs = shape.map((p) => p.z);
  const rs = shape.map((p) => p.r);
  const [zMin, zMax, rMin, rMax] = [Math.min(...zs), Math.max(...zs), Math.min(...rs), Math.max(...rs)];

  switch (def.type) {
    case 'rough':
    case 'finish':
    case 'thread': {
      // 인서트(두께 4.8) + 인서트를 받치는 헤드 + 바깥으로 뻗은 생크(20 x 20)
      g.add(plate(shape, -2.4, 2.4, tipMat));
      g.add(box(zMin + 1, zMax, rMin + 2, rMax, -9, -2.4, holderMat));
      const zc = def.type === 'thread' ? 0 : (zMin + zMax) / 2 + 2;
      g.add(box(zc - 10, zc + 10, rMax - 2, rMax + 80, -22, -2.4, holderMat));
      break;
    }
    case 'groove': {
      // 날 끝(색) + 얇고 높은 블레이드 + 블록
      const w = zMax - zMin;
      g.add(box(zMin, zMax, 0, 4, -3, 3, tipMat));
      g.add(box(zMin + w * 0.08, zMax - w * 0.08, 4, 28, -18, 3, holderMat));
      g.add(box(zMin - 2, zMax + 18, 28, 100, -22, 3, holderMat));
      break;
    }
    case 'igroove':
    case 'ithread': {
      // 날 + 구멍 안으로 들어가는 가는 바 (축 = 날 끝보다 4 아래)
      g.add(plate(shape, -1.5, 1.5, tipMat));
      const len = 160;
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, len, 24), holderMat);
      bar.rotation.z = Math.PI / 2;
      bar.position.set(zMax + len / 2, -4, -1.5);
      g.add(bar);
      break;
    }
    case 'boring': {
      // 인서트 + 구멍 안으로 들어가는 둥근 보링바 (축 = 공구 끝보다 6 아래)
      g.add(plate(shape, -2.4, 2.4, tipMat));
      const len = 160;
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, len, 32), holderMat);
      bar.rotation.z = Math.PI / 2;
      bar.position.set(zMax - 2 + len / 2, -6, -2.4);
      g.add(bar);
      break;
    }
    case 'knurl': {
      // 롤러 (축이 Z 방향) + 롤러를 잡는 홀더
      const w = zMax - zMin;
      const roller = new THREE.Mesh(new THREE.CylinderGeometry(8, 8, w, 32), new THREE.MeshStandardMaterial({ map: knurlTexture(), metalness: 0.6, roughness: 0.4 }));
      roller.rotation.z = Math.PI / 2;
      roller.position.set(0, 8, 0);
      g.add(roller);
      g.add(box(zMin - 3, zMax + 3, 8, 30, -6, 6, holderMat));
      g.add(box(-10, 10, 30, 110, -22, 6, holderMat));
      break;
    }
    case 'tap': {
      // 나사산이 보이는 탭 (끝 물림부 → 나사산 → 가는 생크) + 탭 홀더
      const pitch = coarsePitch(def.width) ?? 1;
      const outline = tapOutline(def.width > 0 ? def.width : 6, pitch);
      const body = new THREE.LatheGeometry([new THREE.Vector2(0, 0), ...outline.map((p) => new THREE.Vector2(p.r, p.z)), new THREE.Vector2(0, 60)], 48);
      body.rotateZ(-Math.PI / 2);
      g.add(new THREE.Mesh(body, new THREE.MeshStandardMaterial({ color: '#c9ced6', metalness: 0.85, roughness: 0.3, flatShading: true })));
      const holder = new THREE.Mesh(new THREE.CylinderGeometry(rMax + 6, rMax + 6, 50, 40), holderMat);
      holder.rotation.z = Math.PI / 2;
      holder.position.x = 60 + 25;
      g.add(holder);
      break;
    }
    case 'drill': {
      // 날끝 원뿔 + 몸통을 축 둘레로 회전시킨 모양
      const rr = rMax;
      // 날끝 원뿔 길이 = 바깥지름에 처음 닿는 Z
      const tipLen = Math.min(...shape.filter((p) => p.r > rr - 1e-6).map((p) => p.z));
      const body = new THREE.LatheGeometry(
        [new THREE.Vector2(0, 0), new THREE.Vector2(rr, tipLen), new THREE.Vector2(rr, 70), new THREE.Vector2(0, 70)],
        40,
      );
      body.rotateZ(-Math.PI / 2);
      g.add(new THREE.Mesh(body, tipMat));
      const shank = new THREE.Mesh(new THREE.CylinderGeometry(rr + 6, rr + 6, 50, 40), holderMat);
      shank.rotation.z = Math.PI / 2;
      shank.position.x = 70 + 25;
      g.add(shank);
      break;
    }
  }
  return g;
}

export class View3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private stockMesh: THREE.Mesh;
  private toolMesh: THREE.Group | null = null;
  private toolKey = '';
  /** 절단된 완성품 (떨어지는 높이 partDrop 까지 내려온다) */
  private partMesh: THREE.Mesh;
  private partDrop = 0;
  private stockR = 25;
  private chuck = new THREE.Group();
  private spin = 0;
  visible = false;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    host.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color('#0f141b');
    this.camera = new THREE.PerspectiveCamera(35, 1, 1, 5000);
    this.camera.position.set(40, 110, 200);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(-30, 0, 0);
    this.controls.update();

    this.scene.add(new THREE.HemisphereLight('#dfe9f5', '#2a2f38', 1.2));
    const key = new THREE.DirectionalLight('#ffffff', 1.6);
    key.position.set(80, 150, 120);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight('#9fc3ff', 0.6);
    rim.position.set(-150, -40, -100);
    this.scene.add(rim);

    this.stockMesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshStandardMaterial({ color: '#b9c3cf', metalness: 0.75, roughness: 0.32 }),
    );
    this.partMesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshStandardMaterial({ color: '#b9d9c8', metalness: 0.7, roughness: 0.32 }),
    );
    this.partMesh.visible = false;
    this.scene.add(this.stockMesh, this.partMesh, this.chuck);
    new ResizeObserver(() => this.resize()).observe(host);
  }

  private resize() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setStockConfig(cfg: StockConfig) {
    this.chuck.clear();
    const cb = chuckBox(cfg);
    const len = cb.maxZ - cb.minZ;
    const R = cfg.diameter / 2;
    this.stockR = R;
    const metal = new THREE.MeshStandardMaterial({ color: '#4a5363', metalness: 0.6, roughness: 0.45 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(R + 45, R + 45, 40, 64), metal);
    body.rotation.z = Math.PI / 2;
    body.position.x = cb.minZ - 20;
    this.chuck.add(body);
    for (let k = 0; k < 3; k++) {
      const jaw = new THREE.Mesh(new THREE.BoxGeometry(len, cb.maxR - R, 18), metal);
      const a = (k / 3) * Math.PI * 2;
      const rr = (R + cb.maxR) / 2;
      jaw.position.set(cb.minZ + len / 2, rr * Math.cos(a), rr * Math.sin(a));
      jaw.rotation.x = a;
      this.chuck.add(jaw);
    }
    const p = protrusionOf(cfg);
    this.controls.target.set(-p / 2, 0, 0);
    this.camera.position.set(-p / 2 + 50, R * 2.5 + 40, R * 5 + 110);
    this.controls.update();
  }

  /**
   * 척에 물린 소재와 절단된 완성품. 완성품은 돌지 않고 척 아래로 떨어진다
   */
  setStock(paths: Paths, knurled: [number, number][] = [], parted: Paths | null = null) {
    this.fill(this.stockMesh, paths, knurled);
    if (parted) {
      this.fill(this.partMesh, parted, knurled);
      if (!this.partMesh.visible) {
        this.partMesh.visible = true;
        this.partMesh.position.y = 0;
        this.partMesh.rotation.x = this.spin;
      }
      const top = Math.max(...parted.flat().map((q) => q.Y / SCALE));
      this.partDrop = -(this.stockR + top + 12);
    } else {
      this.partMesh.visible = false;
      this.partMesh.position.y = 0;
    }
  }

  /** 단면을 돌려 메시를 만들고, 널링 구간은 무늬를 입힌 원통을 표면에 살짝 덮는다 (메시와 같이 움직인다) */
  private fill(mesh: THREE.Mesh, paths: Paths, knurled: [number, number][]) {
    mesh.geometry.dispose();
    mesh.geometry = revolve(paths);
    for (const m of [...mesh.children] as THREE.Mesh[]) {
      mesh.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    for (const [a, b] of knurled) {
      const r = outerRadius(paths, a, b);
      if (r <= 0 || b - a < 1e-3) continue;
      const tex = knurlTexture().clone();
      tex.needsUpdate = true;
      // 마름모 한 칸 약 1.2mm
      tex.repeat.set(Math.max(1, Math.round((2 * Math.PI * r) / 1.2)), Math.max(1, Math.round((b - a) / 1.2)));
      const k = new THREE.Mesh(
        new THREE.CylinderGeometry(r + 0.03, r + 0.03, b - a, RADIAL, 1, true),
        new THREE.MeshStandardMaterial({ map: tex, metalness: 0.7, roughness: 0.35 }),
      );
      k.rotation.z = Math.PI / 2;
      k.position.x = (a + b) / 2;
      mesh.add(k);
    }
  }

  setTool(def: ToolDef | null, shape: Vec[] | null, pos: Vec | null, color: string) {
    const key = def && shape ? JSON.stringify(def) + color : '';
    if (key !== this.toolKey) {
      this.toolKey = key;
      if (this.toolMesh) {
        this.scene.remove(this.toolMesh);
        this.toolMesh.traverse((o) => {
          if (o instanceof THREE.Mesh) o.geometry.dispose();
        });
        this.toolMesh = null;
      }
      if (def && shape) {
        this.toolMesh = buildTool(def, shape, color);
        this.scene.add(this.toolMesh);
      }
    }
    if (this.toolMesh) {
      this.toolMesh.visible = !!pos;
      if (pos) this.toolMesh.position.set(pos.z, pos.r, 0);
    }
  }

  render(spindleRpm: number, dt: number) {
    if (!this.visible) return;
    // 회전하는 느낌만 주기 위해 실제 rpm 보다 느리게 돌린다
    this.spin += Math.min(spindleRpm, 3000) * 0.0006 * dt * 60;
    this.stockMesh.rotation.x = this.spin;
    // 떨어지는 완성품: 0.3초쯤에 바닥까지
    if (this.partMesh.visible && this.partMesh.position.y > this.partDrop)
      this.partMesh.position.y = Math.max(this.partDrop, this.partMesh.position.y - Math.max(0.5, -this.partDrop) * 0.06 * dt * 60);
    this.renderer.render(this.scene, this.camera);
  }
}
