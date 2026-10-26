/* The landing page's "chain forge" (plain three.js, lazy-loaded). Scroll progress drives everything:
   blocks drift in as loose, unverified wireframes (coral), then one by one align into an arc, turn
   solid and mint, take their ledger hash, and lock to the previous block with interlocking links.
   When the chain is complete a pulse runs along it. Renders only while on screen and the tab is
   visible; with reduced motion it shows the finished chain and renders only on resize. */
import { useEffect, useRef, type MutableRefObject } from "react";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { BLOCKS, blockFirmness, clamp01, linkLock, seeded, smoothstep } from "../../lib/forge";

export interface ChainForgeProps {
  progress: MutableRefObject<number>;
  /** Labels for the block faces, typically real ledger hashes, oldest first. */
  hashes: string[];
  onError: () => void;
}

const MINT = new THREE.Color("#38D6AC");
const CYAN = new THREE.Color("#7FE7FF");
const CORAL = new THREE.Color("#FA7070");
const DEEP = new THREE.Color("#0B1A1C");
const ARC_R = 8.6;
const ARC = 0.96; // half-angle of the arc in radians (wide enough that the links between blocks show)
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

function faceTexture(label: string, index: number): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 352;
  const g = c.getContext("2d")!;
  g.fillStyle = "rgba(6,20,20,0.92)";
  g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = "rgba(56,214,172,0.18)";
  for (let x = 0; x < c.width; x += 32) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, c.height);
    g.stroke();
  }
  g.fillStyle = "#38D6AC";
  g.font = "600 34px 'JetBrains Mono', monospace";
  g.fillText(`BLOCK #${String(index + 1).padStart(2, "0")}`, 34, 64);
  g.fillStyle = "rgba(220,255,245,0.9)";
  g.font = "400 25px 'JetBrains Mono', monospace";
  const hex = label.replace(/^sha256:/, "");
  [hex.slice(0, 16), hex.slice(16, 32), hex.slice(32, 48), hex.slice(48, 64)].forEach((line, k) => g.fillText(line, 34, 128 + k * 40));
  g.fillStyle = "rgba(56,214,172,0.75)";
  g.font = "500 22px 'JetBrains Mono', monospace";
  g.fillText("sha256 · verified", 34, 316);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function disposeTree(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    const all = Array.isArray(mat) ? mat : mat ? [mat] : [];
    all.forEach((x) => {
      (x as THREE.MeshBasicMaterial).map?.dispose();
      x.dispose();
    });
  });
}

export default function ChainForge3D({ progress, hashes, onError }: ChainForgeProps) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    } catch {
      onError();
      return;
    }
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.setClearColor(0x000000, 0);
    el.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x05080c, 0.028);
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
    scene.add(new THREE.AmbientLight(0x88ffee, 0.35));
    const key = new THREE.DirectionalLight(0xffffff, 1.3);
    key.position.set(4, 8, 10);
    scene.add(key);
    const rimA = new THREE.PointLight(0x38d6ac, 40, 40);
    rimA.position.set(-7, 3, 4);
    const rimB = new THREE.PointLight(0x7fe7ff, 30, 40);
    rimB.position.set(8, -2, 5);
    scene.add(rimA, rimB);

    // Background: a slow particle field and the ledger floor that firms up under the chain.
    const rnd = seeded(42);
    const starGeo = new THREE.BufferGeometry();
    const stars = new Float32Array(1500 * 3);
    for (let i = 0; i < stars.length; i += 3) {
      stars[i] = (rnd() - 0.5) * 80;
      stars[i + 1] = (rnd() - 0.5) * 40;
      stars[i + 2] = -rnd() * 60 + 8;
    }
    starGeo.setAttribute("position", new THREE.BufferAttribute(stars, 3));
    const starMat = new THREE.PointsMaterial({ color: 0x7fe7ff, size: 0.06, transparent: true, opacity: 0.55, depthWrite: false });
    const field = new THREE.Points(starGeo, starMat);
    scene.add(field);
    const grid = new THREE.GridHelper(80, 80, 0x1b3a3a, 0x1b3a3a); // no bright centre axis
    grid.position.y = -3.4;
    const gridMats = (Array.isArray(grid.material) ? grid.material : [grid.material]) as THREE.LineBasicMaterial[];
    gridMats.forEach((m) => {
      m.transparent = true;
      m.depthWrite = false;
    });
    scene.add(grid);

    // Blocks: glassy body, glowing edges and a hash face.
    const n = BLOCKS;
    const bodyGeo = new THREE.BoxGeometry(1.2, 0.86, 0.86);
    const edgeGeo = new THREE.EdgesGeometry(bodyGeo);
    const faceGeo = new THREE.PlaneGeometry(1.1, 0.77);
    const blocks = Array.from({ length: n }, (_, i) => {
      const group = new THREE.Group();
      const body = new THREE.Mesh(bodyGeo, new THREE.MeshPhysicalMaterial({ color: DEEP, metalness: 0.35, roughness: 0.22, clearcoat: 1, transparent: true, opacity: 0.1, emissive: CORAL.clone(), emissiveIntensity: 0.15 }));
      const edges = new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ color: CORAL.clone(), transparent: true, opacity: 0.8, toneMapped: false }));
      const face = new THREE.Mesh(faceGeo, new THREE.MeshBasicMaterial({ map: faceTexture(hashes[i] ?? "", i), transparent: true, opacity: 0, toneMapped: false }));
      face.position.z = 0.436;
      group.add(body, edges, face);
      const a = -ARC + (2 * ARC * i) / (n - 1);
      const formed = new THREE.Vector3(ARC_R * Math.sin(a), Math.sin(i * 0.9) * 0.22, ARC_R * Math.cos(a) - ARC_R);
      const loose = new THREE.Vector3((rnd() - 0.5) * 26, (rnd() - 0.5) * 12, -rnd() * 18 + 2);
      const spin = new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).multiplyScalar(1.6);
      const turn = new THREE.Euler(rnd() * 6, rnd() * 6, rnd() * 6);
      scene.add(group);
      return { group, body, edges, face, formed, loose, spin, turn, yaw: -a * 0.85 };
    });

    // Links: two interlocking rings between consecutive blocks.
    const ringGeo = new THREE.TorusGeometry(0.22, 0.05, 12, 36);
    const links = Array.from({ length: n - 1 }, (_, i) => {
      const group = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({ color: MINT, emissive: MINT, emissiveIntensity: 0.9, metalness: 0.8, roughness: 0.25, transparent: true, opacity: 0 });
      const r1 = new THREE.Mesh(ringGeo, mat);
      const r2 = new THREE.Mesh(ringGeo, mat);
      r1.position.x = -0.15;
      r2.position.x = 0.15;
      r2.rotation.x = Math.PI / 2;
      group.add(r1, r2);
      const a = blocks[i].formed;
      const b = blocks[i + 1].formed;
      group.position.copy(a).lerp(b, 0.5);
      group.lookAt(b);
      group.rotateY(Math.PI / 2);
      scene.add(group);
      return { group, mat };
    });

    // The integrity pulse that travels along the finished chain.
    const pulse = new THREE.Mesh(new THREE.SphereGeometry(0.16, 20, 20), new THREE.MeshBasicMaterial({ color: CYAN, transparent: true, opacity: 0, toneMapped: false }));
    scene.add(pulse);

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.7, 0.5, 0.2);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());

    const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
    const onMove = (e: PointerEvent) => {
      mouse.tx = (e.clientX / window.innerWidth - 0.5) * 2;
      mouse.ty = (e.clientY / window.innerHeight - 0.5) * 2;
    };
    window.addEventListener("pointermove", onMove, { passive: true });

    let fitDist = 16;
    const resize = () => {
      const w = el.clientWidth || 1;
      const h = el.clientHeight || 1;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      composer.setSize(w, h);
      bloom.setSize(w, h);
      camera.aspect = w / h;
      // Keep the whole arc in frame on any aspect ratio, phones included.
      const halfW = ARC_R * Math.sin(ARC) + 1.2;
      fitDist = Math.min(60, Math.max(13, halfW / (Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect) + 3));
      (scene.fog as THREE.FogExp2).density = 0.028 * Math.min(1, 16 / fitDist); // a farther camera on tall screens must not fog the chain out
      camera.updateProjectionMatrix();
      if (reduce) frame(performance.now());
    };

    const tmp = new THREE.Vector3();
    const frame = (now: number) => {
      const t = now / 1000;
      const p = reduce ? 1 : clamp01(progress.current);
      mouse.x += (mouse.tx - mouse.x) * 0.05;
      mouse.y += (mouse.ty - mouse.y) * 0.05;
      let firmSum = 0;
      blocks.forEach((b, i) => {
        const f = blockFirmness(p, i);
        firmSum += f;
        const e = easeOut(f);
        tmp.copy(b.loose).lerp(b.formed, e);
        if (f < 0.35 && !reduce) tmp.x += Math.sin(t * 23 + i * 7) * 0.04 * (1 - f / 0.35); // unverified blocks jitter
        b.group.position.copy(tmp);
        const loose = 1 - e;
        b.group.rotation.set(
          (b.turn.x + t * b.spin.x) * loose,
          (b.turn.y + t * b.spin.y) * loose + b.yaw * e,
          (b.turn.z + t * b.spin.z) * loose,
        );
        const bodyMat = b.body.material as THREE.MeshPhysicalMaterial;
        bodyMat.opacity = 0.08 + 0.84 * e;
        bodyMat.emissive.copy(CORAL).lerp(MINT, e);
        bodyMat.emissiveIntensity = 0.12 + 0.28 * e;
        const edgeMat = b.edges.material as THREE.LineBasicMaterial;
        edgeMat.color.copy(CORAL).lerp(MINT, e).multiplyScalar(1 + e * 0.8);
        edgeMat.opacity = 0.55 + 0.45 * e;
        (b.face.material as THREE.MeshBasicMaterial).opacity = smoothstep(0.55, 1, f);
      });
      links.forEach((l, i) => {
        const k = linkLock(p, i);
        l.mat.opacity = k;
        l.group.scale.setScalar(0.2 + 0.8 * easeOut(k));
        l.group.rotation.z = (1 - k) * 2.4;
      });
      const integrity = firmSum / blocks.length;
      gridMats.forEach((m) => (m.opacity = 0.08 + 0.5 * integrity));
      rimA.intensity = 22 + 40 * integrity;
      bloom.strength = 0.45 + 0.45 * integrity;
      const done = smoothstep(0.9, 0.97, p);
      (pulse.material as THREE.MeshBasicMaterial).opacity = done;
      if (done > 0) {
        const u = reduce ? 0.5 : (t * 0.35) % 1;
        const x = u * (blocks.length - 1);
        const j = Math.min(blocks.length - 2, Math.floor(x));
        pulse.position.copy(blocks[j].formed).lerp(blocks[j + 1].formed, x - j);
        pulse.position.y += 0.6;
      }
      field.rotation.y = t * 0.012;
      const orbit = reduce ? 0 : Math.sin(t * 0.18) * 1.2;
      camera.position.set(orbit + mouse.x * 0.8, 1.6 - mouse.y * 0.5 + (1 - p) * 1.2, fitDist - p * 2);
      camera.lookAt(0, -0.2, -2.6);
      composer.render();
    };

    let raf = 0;
    let visible = true;
    const loop = (now: number) => {
      frame(now);
      raf = visible && !document.hidden ? requestAnimationFrame(loop) : 0;
    };
    const start = () => {
      if (!reduce && !raf && visible && !document.hidden) raf = requestAnimationFrame(loop);
    };
    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      start();
    });
    io.observe(el);
    const onVis = () => start();
    document.addEventListener("visibilitychange", onVis);
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();
    start();

    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pointermove", onMove);
      disposeTree(scene);
      composer.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
    // hashes only label the faces once; progress is read from the ref every frame
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={host} className="absolute inset-0" aria-hidden />;
}
