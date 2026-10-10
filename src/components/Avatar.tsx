"use client";

/**
 * 3D talking-head avatar (Ready Player Me–style GLB) rendered with
 * react-three-fiber. The mouth is driven every frame by `mouthLevel()` from the
 * lip-sync module, so it opens only while Guru is actually making sound. Idle
 * life comes from periodic blinks and a slow head sway.
 *
 * Browser-only: Tutor loads it with `dynamic(..., { ssr: false })`, the same way
 * the Excalidraw board is loaded, because three.js touches browser APIs.
 */

import { Canvas, useFrame, useLoader, useThree } from "@react-three/fiber";
import { Suspense, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mouthLevel } from "@/lib/voice/lipsync";

const MODEL_URL = "/avatar/guru.glb";

// Morph-target names vary between avatars, so we try several and use whatever the
// model actually exposes. "Open mouth" candidates, strongest first. The bare
// numbers are Azure viseme IDs — some rigs (e.g. the wawa-sensei teachers) name
// their morphs "0".."21" after them; "2" is the wide-open "aa", "8" is "ow".
const MOUTH_OPEN = ["AH", "jawOpen", "mouthOpen", "viseme_aa", "viseme_AA", "2"];
const MOUTH_ROUND = ["OH", "viseme_O", "mouthFunnel", "mouthPucker", "8"]; // a touch of rounding
const BLINK_BOTH = ["eye_close", "eyesClosed", "eyeBlink", "blink"];
const BLINK_LEFT = ["eyeBlinkLeft", "eye closed.L", "eyesClosed_L"];
const BLINK_RIGHT = ["eyeBlinkRight", "eye closed.R", "eyesClosed_R"];

type MorphHit = { mesh: THREE.Mesh; idx: number };

/** All (mesh, index) pairs for the first candidate name that any mesh exposes. */
function resolve(meshes: THREE.Mesh[], candidates: string[]): MorphHit[] {
  for (const name of candidates) {
    const hits: MorphHit[] = [];
    for (const mesh of meshes) {
      const dict = mesh.morphTargetDictionary;
      if (dict && name in dict) hits.push({ mesh, idx: dict[name] });
    }
    if (hits.length) return hits;
  }
  return [];
}

function setMorph(hits: MorphHit[], value: number) {
  for (const h of hits) {
    const inf = h.mesh.morphTargetInfluences;
    if (inf) inf[h.idx] = value;
  }
}

function Guru() {
  "use no memo"; // this component mutates three.js objects each frame; don't let the compiler memoize it

  const gltf = useLoader(GLTFLoader, MODEL_URL); // the GLB is uncompressed, so no DRACOLoader is needed
  const root = gltf.scene;
  const { camera } = useThree();

  const rig = useMemo(() => {
    const meshes: THREE.Mesh[] = [];
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.morphTargetDictionary && m.morphTargetInfluences) meshes.push(m);
    });
    const blinkBoth = resolve(meshes, BLINK_BOTH);
    return {
      open: resolve(meshes, MOUTH_OPEN),
      round: resolve(meshes, MOUTH_ROUND),
      blink: blinkBoth.length ? blinkBoth : [...resolve(meshes, BLINK_LEFT), ...resolve(meshes, BLINK_RIGHT)],
      head: root.getObjectByName("mixamorig2:Head") ?? root.getObjectByName("Head") ?? null,
    };
  }, [root]);

  const headBase = useRef<{ x: number; y: number } | null>(null);
  const blink = useRef({ countdown: 1.2, phase: 0 }); // phase>0 means a blink is in progress

  // Frame the camera on the face using the model's bounding box (robust across
  // avatars — bone world positions can't be trusted in bind pose). Capture the
  // head bone's rest rotation for the idle sway.
  useLayoutEffect(() => {
    root.updateMatrixWorld(true);
    if (rig.head) headBase.current = { x: rig.head.rotation.x, y: rig.head.rotation.y };

    const box = new THREE.Box3().setFromObject(root);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    const fov = 26;
    const half = (fov * 0.5) * (Math.PI / 180);
    const faceY = box.max.y - size.y * 0.085; // a touch below the crown ≈ eyes/nose
    const frontZ = box.max.z; // the avatar faces +Z
    const frameHalf = size.y * 0.1; // vertical half-extent to keep in view (head + a little shoulder)
    const dist = frameHalf / Math.tan(half) + 0.12;

    const cam = camera as THREE.PerspectiveCamera;
    cam.position.set(center.x, faceY, frontZ + dist);
    cam.lookAt(center.x, faceY - size.y * 0.015, frontZ);
    cam.fov = fov;
    cam.near = 0.05;
    cam.far = 50;
    cam.updateProjectionMatrix();
  }, [root, rig, camera]);

  // Dev-only probe for smoke tests: reads the live mouth-open influence.
  useLayoutEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    (window as unknown as { __guruMouth?: () => number | null }).__guruMouth = () =>
      rig.open[0]?.mesh.morphTargetInfluences?.[rig.open[0].idx] ?? null;
  }, [rig]);

  useFrame((state, dt) => {
    // ---- mouth: driven by live audio amplitude --------------------------
    const level = mouthLevel();
    setMorph(rig.open, level);
    setMorph(rig.round, level * 0.3);

    // ---- blinking -------------------------------------------------------
    const b = blink.current;
    if (b.phase > 0) {
      b.phase += dt / 0.13; // one blink lasts ~130ms
      if (b.phase >= 1) {
        b.phase = 0;
        b.countdown = 2 + Math.random() * 3.5;
        setMorph(rig.blink, 0);
      } else {
        setMorph(rig.blink, Math.sin(b.phase * Math.PI)); // 0 → 1 → 0
      }
    } else {
      b.countdown -= dt;
      if (b.countdown <= 0) b.phase = 0.0001;
    }

    // ---- idle head sway -------------------------------------------------
    if (rig.head && headBase.current) {
      const t = state.clock.elapsedTime;
      const nod = level * 0.05; // slight lift while speaking
      rig.head.rotation.y = headBase.current.y + Math.sin(t * 0.5) * 0.045;
      rig.head.rotation.x = headBase.current.x + Math.sin(t * 0.37) * 0.02 - nod;
    }
  });

  return <primitive object={root} />;
}

export default function Avatar({ className }: { className?: string }) {
  return (
    <Canvas
      className={className}
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: true, preserveDrawingBuffer: false }}
      camera={{ position: [0, 1.5, 0.7], fov: 26 }}
    >
      {/* The model is mostly unlit (KHR_materials_unlit); a little ambient covers any lit parts. */}
      <ambientLight intensity={1.1} />
      <directionalLight position={[1, 2, 2]} intensity={0.6} />
      <Suspense fallback={null}>
        <Guru />
      </Suspense>
    </Canvas>
  );
}
