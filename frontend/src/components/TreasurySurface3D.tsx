/* WebGL treasury scenario surface (plain three.js, lazy-loaded).
   X = month, Y = projected available balance (mUSDC), Z = cost overrun %. Every vertex is a value
   returned by the treasury model; nothing is interpolated or smoothed. Renders on demand only
   (orbit, zoom, data change, resize), never in a continuous loop. Labels are HTML. */
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { compactUnits, niceTicks } from "../lib/surface";

export interface SurfaceSceneProps {
  months: number[];
  overruns: number[];
  /** token units for geometry, [overrun row][month] */
  after: number[][];
  before: number[];
  selectedRow: number;
  monthIndex: number;
  threshold: number;
  crossingIndex: number | null;
  theme: "light" | "dark";
  resetKey: number;
  onError: (message: string) => void;
}

const W = 12; // plot extents in scene units
const D = 6.5;
const H = 6;
const TARGET = new THREE.Vector3(W / 2, H * 0.38, D / 2);
const START = { radius: 27, polar: 1.1, azimuth: 0.5 };

const PALETTE = {
  light: { low: "#3a62f5", high: "#a9beff", opacity: 0.6, mesh: "#2349e6", selected: "#0b2fe0", selectedDot: "#ffffff", reference: "#0e1c33", amber: "#d48a12", coral: "#e5484d", grid: "#cfd7e2", wall: "#f3f6fb", label: "#17212b", muted: "#5b6b7c", slice: "#2a52ff" },
  dark: { low: "#2b48d8", high: "#8eabff", opacity: 0.55, mesh: "#93acff", selected: "#b9ccff", selectedDot: "#0d1117", reference: "#efe8d6", amber: "#f2b44c", coral: "#ff6b6b", grid: "#2f3a46", wall: "#161d25", label: "#eef2f5", muted: "#a2aebb", slice: "#7f9cff" },
};

const VERT = /* glsl */ `
  varying float vY;
  varying vec3 vN;
  void main() {
    vY = position.y;
    vN = normal;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const FRAG = /* glsl */ `
  uniform vec3 uLow;
  uniform vec3 uHigh;
  uniform vec3 uBelow;
  uniform float uThreshold;
  uniform float uHeight;
  uniform float uOpacity;
  varying float vY;
  varying vec3 vN;
  void main() {
    vec3 c = mix(uLow, uHigh, clamp(vY / uHeight, 0.0, 1.0));
    float shade = 0.74 + 0.26 * abs(dot(normalize(vN), normalize(vec3(0.35, 1.0, 0.55))));
    if (vY < uThreshold) c = mix(uBelow, c, 0.12);
    gl_FragColor = vec4(c * shade, uOpacity);
  }`;

interface Stage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  overlay: HTMLDivElement;
  labels: Array<{ el: HTMLSpanElement; pos: THREE.Vector3; align: "center" | "right" | "left" }>;
  request: () => void;
}

function placeCamera(camera: THREE.PerspectiveCamera, controls: OrbitControls) {
  const { radius, polar, azimuth } = START;
  camera.position.set(
    TARGET.x + radius * Math.sin(polar) * Math.sin(azimuth),
    TARGET.y + radius * Math.cos(polar),
    TARGET.z + radius * Math.sin(polar) * Math.cos(azimuth),
  );
  controls.target.copy(TARGET);
  controls.update();
}

function disposeTree(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  });
}

const lines = (pts: number[], color: string, opacity: number) => {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: false }));
};

function tube(points: THREE.Vector3[], radius: number, color: string) {
  const path = new THREE.CurvePath<THREE.Vector3>();
  for (let i = 0; i < points.length - 1; i++) path.add(new THREE.LineCurve3(points[i], points[i + 1]));
  return new THREE.Mesh(new THREE.TubeGeometry(path, Math.max(8, points.length * 10), radius, 10, false), new THREE.MeshBasicMaterial({ color }));
}

export default function TreasurySurface3D(props: SurfaceSceneProps) {
  const host = useRef<HTMLDivElement>(null);
  const stage = useRef<Stage | null>(null);
  const onError = useRef(props.onError);
  onError.current = props.onError;

  // Renderer, camera and controls: created once.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
      if (!renderer.getContext()) throw new Error("no context");
    } catch {
      onError.current("WebGL is not available in this browser, so the 3D view cannot start.");
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.className = "absolute inset-0 h-full w-full cursor-grab active:cursor-grabbing";
    renderer.domElement.setAttribute("aria-hidden", "true");
    el.appendChild(renderer.domElement);
    const overlay = document.createElement("div");
    overlay.className = "pointer-events-none absolute inset-0 overflow-hidden";
    el.appendChild(overlay);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = false;
    controls.enableDamping = false;
    controls.rotateSpeed = 0.6;
    controls.zoomSpeed = 0.7;
    controls.minDistance = 19;
    controls.maxDistance = 33;
    controls.minPolarAngle = 0.55; // never straight down, where labels would pile up
    controls.maxPolarAngle = 1.42; // never below the floor of the plot
    controls.minAzimuthAngle = -0.5;
    controls.maxAzimuthAngle = 1.35;
    placeCamera(camera, controls);

    const v = new THREE.Vector3();
    let frame = 0;
    const draw = () => {
      frame = 0;
      const w = el.clientWidth;
      const h = el.clientHeight;
      renderer.render(scene, camera);
      for (const l of s.labels) {
        v.copy(l.pos).project(camera);
        const x = (v.x * 0.5 + 0.5) * w;
        const y = (-v.y * 0.5 + 0.5) * h;
        const ax = l.align === "center" ? "-50%" : l.align === "right" ? "-100%" : "0%";
        l.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(${ax}, -50%)`;
        l.el.style.visibility = v.z < 1 ? "visible" : "hidden";
      }
    };
    const request = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    const s: Stage = { renderer, scene, camera, controls, overlay, labels: [], request };
    stage.current = s;

    const resize = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.zoom = Math.min(1, camera.aspect / 1.75); // keep the whole plot in frame on narrow canvases
      camera.updateProjectionMatrix();
      request();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();
    controls.addEventListener("change", request);
    const lost = (e: Event) => {
      e.preventDefault();
      onError.current("The 3D view lost its graphics context.");
    };
    renderer.domElement.addEventListener("webglcontextlost", lost);

    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      controls.removeEventListener("change", request);
      controls.dispose();
      renderer.domElement.removeEventListener("webglcontextlost", lost);
      disposeTree(scene);
      renderer.dispose();
      renderer.domElement.remove();
      overlay.remove();
      stage.current = null;
    };
  }, []);

  useEffect(() => {
    const s = stage.current;
    if (!s) return;
    placeCamera(s.camera, s.controls);
    s.request();
  }, [props.resetKey]);

  // Data objects: rebuilt when the data or a selection changes (a few thousand vertices at most).
  const { months, overruns, after, before, selectedRow, monthIndex, threshold, crossingIndex, theme } = props;
  useEffect(() => {
    const s = stage.current;
    if (!s || months.length < 2 || after.length === 0) return;
    const c = PALETTE[theme];
    const group = new THREE.Group();
    const all = [...after.flat(), ...before, threshold];
    let yMinV = Math.min(...all);
    let yMaxV = Math.max(...all);
    const pad = (yMaxV - yMinV || 1) * 0.06;
    yMinV -= pad;
    yMaxV += pad;
    const m0 = months[0];
    const m1 = months[months.length - 1];
    const z0 = overruns[0];
    const z1 = overruns[overruns.length - 1];
    const xOf = (m: number) => ((m - m0) / (m1 - m0)) * W;
    const zOf = (p: number) => (z1 === z0 ? D / 2 : ((p - z0) / (z1 - z0)) * D);
    const yOf = (val: number) => ((val - yMinV) / (yMaxV - yMinV)) * H;
    const nx = months.length;
    const nz = overruns.length;

    // Walls and grid (floor, back wall, left wall).
    const yTicks = niceTicks(yMinV, yMaxV, 5);
    const mStep = m1 <= 12 ? 2 : 3;
    const mTicks = months.filter((m) => (m - m0) % mStep === 0);
    const zTicks = overruns.filter((p, i) => i === 0 || i === nz - 1 || (p - z0) % 15 === 0);
    const wallMat = new THREE.MeshBasicMaterial({ color: c.wall, transparent: true, opacity: theme === "light" ? 0.7 : 0.55, side: THREE.DoubleSide, depthWrite: false });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), wallMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(W / 2, 0, D / 2);
    const back = new THREE.Mesh(new THREE.PlaneGeometry(W, H), wallMat.clone());
    back.position.set(W / 2, H / 2, 0);
    const left = new THREE.Mesh(new THREE.PlaneGeometry(D, H), wallMat.clone());
    left.rotation.y = Math.PI / 2;
    left.position.set(0, H / 2, D / 2);
    group.add(floor, back, left);
    const grid: number[] = [];
    for (const m of mTicks) grid.push(xOf(m), 0, 0, xOf(m), 0, D, xOf(m), 0, 0, xOf(m), H, 0);
    for (const p of zTicks) grid.push(0, 0, zOf(p), W, 0, zOf(p), 0, 0, zOf(p), 0, H, zOf(p));
    for (const t of yTicks) {
      const y = yOf(t);
      if (y < 0 || y > H) continue;
      grid.push(0, y, 0, W, y, 0, 0, y, 0, 0, y, D);
    }
    group.add(lines(grid, c.grid, 1));
    if (yMinV < 0 && yMaxV > 0) group.add(lines([0, yOf(0), 0, W, yOf(0), 0, 0, yOf(0), 0, 0, yOf(0), D], c.coral, 0.75));

    // Surface: one vertex per (overrun, month) model value.
    if (nz >= 2) {
      const pos = new Float32Array(nz * nx * 3);
      for (let r = 0; r < nz; r++) for (let k = 0; k < nx; k++) pos.set([xOf(months[k]), yOf(after[r][k]), zOf(overruns[r])], (r * nx + k) * 3);
      const idx: number[] = [];
      for (let r = 0; r < nz - 1; r++)
        for (let k = 0; k < nx - 1; k++) {
          const a = r * nx + k;
          idx.push(a, a + nx, a + 1, a + 1, a + nx, a + nx + 1);
        }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      const mat = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        uniforms: {
          uLow: { value: new THREE.Color(c.low) },
          uHigh: { value: new THREE.Color(c.high) },
          uBelow: { value: new THREE.Color(c.coral) },
          uThreshold: { value: yOf(threshold) },
          uHeight: { value: H },
          uOpacity: { value: c.opacity },
        },
      });
      group.add(new THREE.Mesh(g, mat));
      const mesh: number[] = [];
      for (let r = 0; r < nz; r++)
        for (let k = 0; k < nx - 1; k++) mesh.push(xOf(months[k]), yOf(after[r][k]), zOf(overruns[r]), xOf(months[k + 1]), yOf(after[r][k + 1]), zOf(overruns[r]));
      for (let k = 0; k < nx; k++)
        for (let r = 0; r < nz - 1; r++) mesh.push(xOf(months[k]), yOf(after[r][k]), zOf(overruns[r]), xOf(months[k]), yOf(after[r + 1][k]), zOf(overruns[r + 1]));
      group.add(lines(mesh, c.mesh, theme === "light" ? 0.35 : 0.3));
    }

    // Threshold plane.
    const yT = yOf(threshold);
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshBasicMaterial({ color: c.amber, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }));
    plane.rotation.x = -Math.PI / 2;
    plane.position.set(W / 2, yT, D / 2);
    group.add(plane, lines([0, yT, 0, W, yT, 0, W, yT, 0, W, yT, D, W, yT, D, 0, yT, D, 0, yT, D, 0, yT, 0], c.amber, 0.9));

    // Selected scenario (vivid) and the before-proposal reference, both on the selected overrun plane.
    const zs = zOf(overruns[selectedRow]);
    const sel = months.map((m, k) => new THREE.Vector3(xOf(m), yOf(after[selectedRow][k]), zs));
    const ref = months.map((m, k) => new THREE.Vector3(xOf(m), yOf(before[k]), zs));
    group.add(tube(ref, 0.035, c.reference), tube(sel, 0.065, c.selected));
    const dot = new THREE.SphereGeometry(0.085, 14, 10);
    const dotMat = new THREE.MeshBasicMaterial({ color: c.selected });
    const refMat = new THREE.MeshBasicMaterial({ color: c.reference });
    const marker = (p: THREE.Vector3, mat: THREE.Material, scale = 1) => {
      const m = new THREE.Mesh(dot, mat);
      m.position.copy(p);
      m.scale.setScalar(scale);
      group.add(m);
    };
    sel.forEach((p) => marker(p, dotMat));
    ref.forEach((p) => marker(p, refMat, 0.7));

    // Month slice and its intersection with the selected scenario.
    const xm = xOf(months[monthIndex]);
    const slice = new THREE.Mesh(new THREE.PlaneGeometry(D, H), new THREE.MeshBasicMaterial({ color: c.slice, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false }));
    slice.rotation.y = Math.PI / 2;
    slice.position.set(xm, H / 2, D / 2);
    group.add(slice, lines([xm, 0, 0, xm, H, 0, xm, H, 0, xm, H, D, xm, H, D, xm, 0, D, xm, 0, D, xm, 0, 0], c.slice, 0.7));
    const hit = sel[monthIndex];
    const halo = new THREE.Mesh(new THREE.SphereGeometry(0.26, 20, 14), new THREE.MeshBasicMaterial({ color: c.selected, transparent: true, opacity: 0.28, depthWrite: false }));
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.15, 20, 14), new THREE.MeshBasicMaterial({ color: c.selectedDot }));
    halo.position.copy(hit);
    core.position.copy(hit);
    group.add(halo, core, lines([hit.x, 0, hit.z, hit.x, hit.y, hit.z], c.slice, 0.8));
    if (crossingIndex !== null) {
      const cross = new THREE.Mesh(new THREE.SphereGeometry(0.17, 20, 14), new THREE.MeshBasicMaterial({ color: c.coral }));
      cross.position.set(xOf(months[crossingIndex]), yOf(after[selectedRow][crossingIndex]), zs);
      group.add(cross);
    }
    s.scene.add(group);

    // HTML labels.
    const made: Stage["labels"] = [];
    const label = (text: string, pos: THREE.Vector3, opts: { align?: "center" | "right" | "left"; color?: string; weight?: number; size?: number; pill?: boolean } = {}) => {
      const el = document.createElement("span");
      el.textContent = text;
      el.style.cssText = `position:absolute;left:0;top:0;white-space:nowrap;font-size:${opts.size ?? 12}px;font-weight:${opts.weight ?? 500};color:${opts.color ?? c.label};font-variant-numeric:tabular-nums;`
        + (opts.pill ? `background:${theme === "light" ? "rgba(255,255,255,0.88)" : "rgba(20,26,32,0.88)"};padding:1px 6px;border-radius:5px;border:1px solid ${opts.color ?? c.label}55;` : "");
      s.overlay.appendChild(el);
      made.push({ el, pos, align: opts.align ?? "center" });
    };
    for (const m of mTicks) label(`M${m}`, new THREE.Vector3(xOf(m), 0, D + 0.45));
    label("Time (months)", new THREE.Vector3(W / 2, 0, D + 1.25), { color: c.muted, weight: 600 });
    for (const p of zTicks) label(`${p}%`, new THREE.Vector3(W + 0.35, 0, zOf(p)), { align: "left" });
    label("Cost overrun", new THREE.Vector3(W + 0.55, 0, D + 0.9), { align: "left", color: c.muted, weight: 600 });
    for (const t of yTicks) if (yOf(t) >= 0 && yOf(t) <= H) label(compactUnits(t), new THREE.Vector3(-0.3, yOf(t), D), { align: "right", color: t === 0 ? c.coral : c.label });
    label(`Threshold ${compactUnits(threshold)}`, new THREE.Vector3(-0.3, yT, 0), { align: "right", color: c.amber, weight: 600, size: 11, pill: true });
    label(`Month ${months[monthIndex]}`, new THREE.Vector3(xm, H + 0.4, 0), { color: c.slice, weight: 700, pill: true });
    s.labels = made;
    s.request();

    return () => {
      s.scene.remove(group);
      disposeTree(group);
      dot.dispose();
      made.forEach((l) => l.el.remove());
      s.labels = [];
    };
  }, [months, overruns, after, before, selectedRow, monthIndex, threshold, crossingIndex, theme]);

  return <div ref={host} className="relative h-full w-full touch-none select-none" />;
}
