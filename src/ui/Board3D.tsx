/**
 * 3D view of the populated board (three.js): orbit around it, watch LEDs light,
 * the servo and motor turn, and press the buttons. Parts are simple procedural
 * bodies, placed from the same board definition as the other views.
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { NetSnapshot } from '../board/board';
import type { DeviceSpec, DeviceState } from '../board/devices';
import { actions, getState, useApp } from './store';
import { LED_COLORS, describeNet } from './BoardPanel';

/** Board coordinates in millimetres: x to the right, z towards the viewer. */
const POSITIONS: Record<string, [number, number]> = {
  console: [-79, -30],
  b1: [-52, -40],
  ld2: [-36, -40],
  led_red: [-10, -40],
  led_yellow: [4, -40],
  led_green: [18, -40],
  led_blue: [32, -40],
  rgb: [50, -40],
  seg: [66, -6],
  servo: [60, 32],
  motor: [26, 34],
  buzzer: [-72, -6],
  sonar: [-40, 10],
  sw1: [-72, 40],
  sw2: [-56, 40],
  pot: [-34, 38],
  temp: [-14, 40],
  ldr: [0, 40],
};

const BOARD_W = 176;
const BOARD_D = 104;
const TOP = 0.8;

interface Part {
  spec: DeviceSpec;
  group: THREE.Group;
  update(state: DeviceState | undefined, dt: number, running: boolean): void;
}

const mat = (color: number, opts: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.1, ...opts });

function box(w: number, h: number, d: number, material: THREE.Material, y = h / 2): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.y = y;
  return m;
}
function cyl(r: number, h: number, material: THREE.Material, y = h / 2, segments = 32): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, segments), material);
  m.position.y = y;
  return m;
}

function silk(text: string, width = 22): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(240, 240, 232, 0.92)';
  g.font = '600 34px ui-monospace, Consolas, monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 128, 34, 250);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(width, width / 4),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = TOP + 0.06;
  return m;
}

function ledPart(spec: DeviceSpec, colorOf: (s: DeviceState | undefined) => { color: THREE.Color; level: number }): Part {
  const group = new THREE.Group();
  const lens = new THREE.MeshStandardMaterial({ color: 0xdddddd, emissive: 0x000000, roughness: 0.25, transparent: true, opacity: 0.92 });
  group.add(box(3.2, 0.6, 1.8, mat(0xe8e4d8)));
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1.7, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2), lens);
  dome.position.y = 0.5;
  group.add(dome);
  const light = new THREE.PointLight(0xffffff, 0, 34, 2);
  light.position.y = 3;
  group.add(light);
  return {
    spec,
    group,
    update(state) {
      const { color, level } = colorOf(state);
      lens.color.copy(color).multiplyScalar(0.35 + 0.25 * level).addScalar(0.12);
      lens.emissive.copy(color).multiplyScalar(level * 1.6);
      light.color.copy(color);
      light.intensity = level * 60;
    },
  };
}

function buildPart(spec: DeviceSpec): Part {
  const group = new THREE.Group();
  const idle: Part = { spec, group, update() {} };
  switch (spec.kind) {
    case 'led': {
      const base = new THREE.Color(LED_COLORS[String(spec.options?.color ?? 'green')]);
      return ledPart(spec, (s) => ({ color: base, level: Number(s?.brightness ?? 0) }));
    }
    case 'rgb': {
      const col = new THREE.Color();
      return ledPart(spec, (s) => {
        const r = Number(s?.r ?? 0);
        const g = Number(s?.g ?? 0);
        const b = Number(s?.b ?? 0);
        const max = Math.max(r, g, b);
        col.setRGB(max > 0 ? r / max : 1, max > 0 ? g / max : 1, max > 0 ? b / max : 1);
        return { color: col, level: max };
      });
    }
    case 'button': {
      group.add(box(6, 3.4, 6, mat(0x2a2a2a)));
      group.add(box(6.6, 0.4, 6.6, mat(0xb9b9b4, { metalness: 0.7, roughness: 0.3 }), 3.4));
      const cap = cyl(1.9, 1.6, mat(spec.id === 'b1' ? 0x2f6fd0 : 0xd8d4c8), 4.4);
      group.add(cap);
      return {
        spec,
        group,
        update(state) {
          cap.position.y = state?.pressed ? 3.9 : 4.4;
        },
      };
    }
    case 'pot': {
      group.add(box(9.5, 4.5, 9.5, mat(0x2d5fa8)));
      const knob = new THREE.Group();
      knob.add(cyl(3.1, 7, mat(0xe9e6dc), 3.5));
      const mark = box(0.7, 0.3, 2.8, mat(0x222222), 7.1);
      mark.position.z = -1.5;
      knob.add(mark);
      knob.position.y = 4.5;
      group.add(knob);
      return {
        spec,
        group,
        update(state) {
          knob.rotation.y = -(Number(state?.pos ?? 0.5) - 0.5) * ((270 * Math.PI) / 180);
        },
      };
    }
    case 'temp': {
      const body = cyl(2.3, 4.6, mat(0x1c1c1c), 4.3, 24);
      group.add(body);
      for (const dx of [-1.27, 0, 1.27]) {
        const leg = cyl(0.25, 2.2, mat(0xc8c8c8, { metalness: 0.8 }), 1.1, 8);
        leg.position.x = dx;
        group.add(leg);
      }
      return idle;
    }
    case 'ldr': {
      group.add(cyl(2.6, 1.8, mat(0xc9a35a), 2.2));
      const face = cyl(2.2, 0.2, mat(0x8a3b1e), 3.2);
      group.add(face);
      return idle;
    }
    case 'buzzer': {
      const body = cyl(6, 6.5, mat(0x151515));
      group.add(body);
      group.add(cyl(1.1, 0.3, mat(0x000000), 6.6));
      let phase = 0;
      return {
        spec,
        group,
        update(state, dt, running) {
          if (state?.on && running) {
            phase += dt * 60;
            const s = 1 + 0.035 * Math.sin(phase);
            body.scale.set(s, 1, s);
          } else body.scale.set(1, 1, 1);
        },
      };
    }
    case 'servo': {
      group.add(box(22, 14, 12, mat(0x2a66c4)));
      group.add(box(32, 1.6, 12, mat(0x2a66c4), 10));
      const hub = cyl(3, 2.2, mat(0xf0f0ea), 15.1);
      hub.position.x = -5;
      group.add(hub);
      const horn = new THREE.Group();
      const arm = box(2.6, 1, 16, mat(0xf0f0ea), 0.5);
      arm.position.z = -5;
      horn.add(arm);
      horn.position.set(-5, 16.2, 0);
      group.add(horn);
      return {
        spec,
        group,
        update(state) {
          horn.rotation.y = -((Number(state?.angle ?? 90) - 90) * Math.PI) / 180;
        },
      };
    }
    case 'motor': {
      const can = cyl(8, 20, mat(0xb9bcc0, { metalness: 0.85, roughness: 0.3 }));
      group.add(can);
      group.add(cyl(8.2, 2, mat(0x202020), 1));
      const rotor = new THREE.Group();
      rotor.add(cyl(1, 6, mat(0xd8d8d8, { metalness: 0.9, roughness: 0.2 }), 3, 12));
      const blade = box(26, 0.8, 3.2, mat(0xe2572f), 5.6);
      rotor.add(blade);
      const blade2 = box(3.2, 0.8, 26, mat(0xe2572f), 5.6);
      rotor.add(blade2);
      rotor.position.y = 20;
      group.add(rotor);
      return {
        spec,
        group,
        update(state, dt, running) {
          if (running) rotor.rotation.y -= Number(state?.speed ?? 0) * dt * 28;
        },
      };
    }
    case 'hcsr04': {
      const pcb = box(45, 20, 1.6, mat(0x1d4fa3), 10 + 2);
      group.add(pcb);
      for (const dx of [-13, 13]) {
        const eye = new THREE.Mesh(new THREE.CylinderGeometry(8, 8, 12, 32), mat(0xc9ccd0, { metalness: 0.8, roughness: 0.3 }));
        eye.rotation.x = Math.PI / 2;
        eye.position.set(dx, 12, 6.8);
        group.add(eye);
        const mesh = new THREE.Mesh(new THREE.CylinderGeometry(6.6, 6.6, 0.3, 32), mat(0x3a3a3a));
        mesh.rotation.x = Math.PI / 2;
        mesh.position.set(dx, 12, 12.9);
        group.add(mesh);
      }
      group.add(box(11, 2.5, 2.5, mat(0x1a1a1a), 1.25));
      return idle;
    }
    case 'sevenseg': {
      group.add(box(13, 7, 19, mat(0x18181a)));
      const face = 7.05;
      const on = new THREE.Color(0xff3b30);
      const shapes: Array<[number, number, number, number]> = [
        [0, -7, 6, 1.3], // a
        [3.6, -3.5, 1.3, 5.6], // b
        [3.6, 3.5, 1.3, 5.6], // c
        [0, 7, 6, 1.3], // d
        [-3.6, 3.5, 1.3, 5.6], // e
        [-3.6, -3.5, 1.3, 5.6], // f
        [0, 0, 6, 1.3], // g
      ];
      const mats: THREE.MeshStandardMaterial[] = [];
      for (const [x, z, w, d] of shapes) {
        const m = new THREE.MeshStandardMaterial({ color: 0x3a1512, emissive: 0x000000, roughness: 0.4 });
        const seg = box(w, 0.15, d, m, face);
        seg.position.x = x;
        seg.position.z = z;
        group.add(seg);
        mats.push(m);
      }
      const dpm = new THREE.MeshStandardMaterial({ color: 0x3a1512, emissive: 0x000000 });
      const dp = cyl(0.8, 0.15, dpm, face, 16);
      dp.position.set(5.2, face, 8);
      group.add(dp);
      mats.push(dpm);
      return {
        spec,
        group,
        update(state) {
          const segs = (state?.segments as number[] | undefined) ?? [];
          mats.forEach((m, i) => m.emissive.copy(on).multiplyScalar(segs[i] ?? 0));
        },
      };
    }
    case 'console': {
      group.add(box(12, 4.4, 9, mat(0xc4c7cb, { metalness: 0.85, roughness: 0.3 })));
      const slot = box(0.4, 2.6, 6.6, mat(0x111111), 2.2);
      slot.position.x = -6;
      group.add(slot);
      return idle;
    }
  }
}

function netColor(n: NetSnapshot | undefined): number {
  if (!n) return 0x2f6b55;
  if (n.contention) return 0xff4d3d;
  if (n.floating) return 0x2a6650;
  if (n.v > 0.25 && n.v < 3.05) return 0xf0b03a;
  if (n.freq > 0.5 && n.duty > 0.001 && n.duty < 0.999) return 0x8dfad0;
  return n.level ? 0x43e8a8 : 0x2f6b55;
}

interface Tip {
  x: number;
  y: number;
  title: string;
  text: string;
}

export default function Board3D({ specs }: { specs: DeviceSpec[] }) {
  const host = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const [failed, setFailed] = useState(false);
  const details = useApp((s) => s.details);
  const key = specs.map((s) => s.id).join(',');

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setFailed(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 1, 2000);
    camera.position.set(0, 190, 170);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0, 4);
    controls.enableDamping = true;
    controls.minDistance = 60;
    controls.maxPolarAngle = Math.PI * 0.49;
    let userMoved = false;
    controls.addEventListener('start', () => {
      userMoved = true;
    });

    scene.add(new THREE.HemisphereLight(0xffffff, 0x445046, 1.5));
    const sun = new THREE.DirectionalLight(0xffffff, 2.0);
    sun.position.set(-80, 220, 120);
    scene.add(sun);

    // PCB
    const pcb = new THREE.Mesh(new THREE.BoxGeometry(BOARD_W, 1.6, BOARD_D), mat(0x0f5c44, { roughness: 0.45 }));
    scene.add(pcb);
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const hole = cyl(1.8, 1.7, mat(0xd9c27a, { metalness: 0.9, roughness: 0.3 }), 0, 24);
      hole.position.set((x * (BOARD_W - 10)) / 2, 0, (z * (BOARD_D - 10)) / 2);
      scene.add(hole);
    }
    // MCU (LQFP-64) with pins
    const mcu = new THREE.Group();
    mcu.add(box(12, 1.5, 12, mat(0x1b1b1d, { roughness: 0.35 }), 0.95));
    const pinMat = mat(0xd0d0cc, { metalness: 0.9, roughness: 0.25 });
    for (let i = 0; i < 16; i++) {
      const o = -5.6 + i * 0.75;
      for (const [px, pz, w, d] of [[o, -6.6, 0.32, 1.2], [o, 6.6, 0.32, 1.2], [-6.6, o, 1.2, 0.32], [6.6, o, 1.2, 0.32]] as const) {
        const p = box(w, 0.3, d, pinMat, 0.2);
        p.position.x = px;
        p.position.z = pz;
        mcu.add(p);
      }
    }
    const dot = cyl(0.6, 0.05, mat(0x555555), 1.73, 16);
    dot.position.set(-4.4, 1.73, 4.4);
    mcu.add(dot);
    mcu.position.y = TOP;
    scene.add(mcu);
    const mcuLabel = silk(details ? 'U1 STM32F072' : 'STM32', 26);
    mcuLabel.position.z = 12;
    scene.add(mcuLabel);
    // header rows for a familiar dev-board look
    const headerMat = mat(0x151515);
    const goldMat = mat(0xd9b84a, { metalness: 0.9, roughness: 0.3 });
    for (const z of [-BOARD_D / 2 + 5, BOARD_D / 2 - 5]) {
      const strip = box(BOARD_W - 30, 2.5, 2.5, headerMat, TOP + 1.25);
      strip.position.z = z;
      scene.add(strip);
      for (let i = 0; i < 28; i++) {
        const pin = box(0.6, 6, 0.6, goldMat, TOP + 3.5);
        pin.position.set(-(BOARD_W - 34) / 2 + i * ((BOARD_W - 34) / 27), TOP + 3.5, z);
        scene.add(pin);
      }
    }

    // devices and ratsnest lines
    const parts: Part[] = [];
    const lines: Array<{ pin: string; material: THREE.LineBasicMaterial }> = [];
    for (const spec of specs) {
      const pos = POSITIONS[spec.id];
      if (!pos) continue;
      const part = buildPart(spec);
      part.group.position.set(pos[0], TOP, pos[1]);
      part.group.traverse((o) => (o.userData.deviceId = spec.id));
      scene.add(part.group);
      parts.push(part);
      const label = silk(details ? spec.ref : spec.label.replace('On-board ', '').replace(' sensor', ''), details ? 12 : 20);
      const tall = spec.kind === 'hcsr04' || spec.kind === 'servo' || spec.kind === 'motor' || spec.kind === 'sevenseg';
      label.position.set(pos[0], TOP + 0.06, pos[1] + (tall ? 14 : 8));
      scene.add(label);
      Object.values(spec.pins).forEach((pin, i, all) => {
        const angle = Math.atan2(pos[1], pos[0]);
        const spread = (i - (all.length - 1) / 2) * 0.9;
        const from = new THREE.Vector3(Math.cos(angle) * 7 - Math.sin(angle) * spread, TOP + 0.08, Math.sin(angle) * 7 + Math.cos(angle) * spread);
        const to = new THREE.Vector3(pos[0] - Math.sin(angle) * spread * 1.6, TOP + 0.08, pos[1] + Math.cos(angle) * spread * 1.6);
        const material = new THREE.LineBasicMaterial({ color: 0x2f6b55 });
        scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([from, to]), material));
        lines.push({ pin, material });
      });
    }

    const resize = () => {
      const w = el.clientWidth || 300;
      const h = el.clientHeight || 300;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = `${w}px`;
      renderer.domElement.style.height = `${h}px`;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      if (!userMoved) {
        // Frame the whole board: far enough that its width and depth both fit.
        const vHalf = (camera.fov * Math.PI) / 360;
        const hHalf = Math.atan(Math.tan(vHalf) * camera.aspect);
        const dist = Math.max((BOARD_W * 0.56) / Math.tan(hHalf), (BOARD_D * 0.62) / Math.tan(vHalf));
        camera.position.set(0, dist * 0.8, dist * 0.6);
        controls.maxDistance = dist * 2.2;
        controls.update();
      }
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    // picking
    const ray = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const pick = (e: PointerEvent): DeviceSpec | null => {
      const r = renderer.domElement.getBoundingClientRect();
      pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(pointer, camera);
      const hit = ray.intersectObjects(parts.map((p) => p.group), true)[0];
      const id = hit?.object.userData.deviceId as string | undefined;
      return id ? (specs.find((s) => s.id === id) ?? null) : null;
    };
    let held: string | null = null;
    const onDown = (e: PointerEvent) => {
      const spec = pick(e);
      if (spec?.kind === 'button') {
        held = spec.id;
        controls.enabled = false;
        actions.input(spec.id, 'pressed', 1);
      }
    };
    const onUp = () => {
      if (held) actions.input(held, 'pressed', 0);
      held = null;
      controls.enabled = true;
    };
    const onMove = (e: PointerEvent) => {
      const spec = pick(e);
      const r = el.getBoundingClientRect();
      renderer.domElement.style.cursor = spec?.kind === 'button' ? 'pointer' : 'grab';
      if (!spec) return setTip(null);
      const board = getState().frame?.board;
      const text = Object.entries(spec.pins)
        .map(([role, pin]) => `${pin}${Object.keys(spec.pins).length > 1 ? ` ${role}` : ''}: ${describeNet(board?.nets[pin])}`)
        .join('\n');
      setTip({ x: e.clientX - r.left, y: e.clientY - r.top, title: `${spec.ref} · ${spec.label}`, text });
    };
    const onLeave = () => setTip(null);
    renderer.domElement.addEventListener('pointerdown', onDown);
    window.addEventListener('pointerup', onUp);
    renderer.domElement.addEventListener('pointermove', onMove);
    renderer.domElement.addEventListener('pointerleave', onLeave);

    let raf = 0;
    let last = performance.now();
    const loop = () => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const frame = getState().frame;
      const running = frame?.state === 'running';
      for (const p of parts) p.update(frame?.board.devices[p.spec.id], dt, running);
      for (const l of lines) l.material.color.setHex(netColor(frame?.board.nets[l.pin]));
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('pointerup', onUp);
      controls.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const material = m.material as THREE.Material | THREE.Material[] | undefined;
        for (const mm of Array.isArray(material) ? material : material ? [material] : []) {
          (mm as THREE.MeshBasicMaterial).map?.dispose();
          mm.dispose();
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, details]);

  if (failed) return <div className="board-empty">The 3D view needs WebGL, which is not available in this browser.</div>;
  if (specs.length === 0) return <div className="board-empty">This exercise uses no board devices.</div>;

  return (
    <div className="board3d" ref={host}>
      <div className="board3d-hint">Drag to orbit · scroll to zoom · click the buttons</div>
      {tip && (
        <div className="tip" style={{ left: Math.min(tip.x + 12, (host.current?.clientWidth ?? 400) - 230), top: tip.y + 14 }}>
          <strong>{tip.title}</strong>
          <span className="tip-pre">{tip.text}</span>
        </div>
      )}
    </div>
  );
}
