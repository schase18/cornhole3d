import { Injectable, NgZone, inject } from '@angular/core';
import '@babylonjs/core/Physics/joinedPhysicsEngineComponent';
import '@babylonjs/core/Culling/ray';
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { Vector3, Matrix, Quaternion } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Plane } from '@babylonjs/core/Maths/math.plane';
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { PhysicsImpostor } from '@babylonjs/core/Physics/v1/physicsImpostor';
import { AmmoJSPlugin } from '@babylonjs/core/Physics/v1/Plugins/ammoJSPlugin';
import { CORNHOLE, throwLineY } from './cornhole-constants';
import { GameStateService, ThrowResult } from './game-state.service';

const HOLE_WORLD = {
  x: 0,
  z: CORNHOLE.boardWorld.z + CORNHOLE.board.holeCenterZLocal,
};

const GROUND_PLANE = Plane.FromPositionAndNormal(new Vector3(0, 0, 0), new Vector3(0, 1, 0));

const DEFAULT_CAM_POS = new Vector3(0, 0.95, -0.1);
const DEFAULT_CAM_TARGET = new Vector3(0, 0.3, 3.0);
const DEFAULT_CAM_FOV = 1.0;
const FLIGHT_CAM_FOV = 1.1;
const AIM_CAM_FOV = 0.95;
const FLIGHT_FOLLOW_OFFSET = new Vector3(0, 0.7, -1.0);

/* ── Ammo soft-body node accessors ────────────────────────────────── */

interface AmmoBtVec3 {
  x(): number; y(): number; z(): number;
  setX(v: number): void; setY(v: number): void; setZ(v: number): void;
}
interface AmmoSoftNode {
  get_m_x(): AmmoBtVec3;
  get_m_v(): AmmoBtVec3;
  set_m_v(v: unknown): void;
}
interface AmmoNodeArray { size(): number; at(i: number): AmmoSoftNode }

/* eslint-disable @typescript-eslint/no-explicit-any */

@Injectable({ providedIn: 'root' })
export class CornholeSceneService {
  private engine: Engine | null = null;
  private scene: Scene | null = null;
  private camera: UniversalCamera | null = null;
  private bag: Mesh | null = null;
  private settledBags: Mesh[] = [];
  private resizeObserver: ResizeObserver | null = null;
  private dragging = false;
  private dragStart = new Vector3();
  private evaluating = false;
  private settledHandled = false;
  private throwStartMs = 0;
  private firstContactMs = 0;
  private calmStreak = 0;
  private maxLinSeen = 0;
  private nextThrowResetTimer: ReturnType<typeof setTimeout> | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private detachCanvasPointers: (() => void) | null = null;
  /** Resolved Ammo WASM module — needed for btVector3 construction and destroy(). */
  private ammo: any = null;

  private readonly scratchFocus = new Vector3();
  private readonly scratchDesiredCam = new Vector3();
  private readonly scratchNextTarget = new Vector3();
  private readonly scratchCamTarget = new Vector3();
  private readonly scratchBagCenter = new Vector3();

  private readonly zone = inject(NgZone);
  private readonly gameState = inject(GameStateService);

  /* ================================================================
   *  Lifecycle
   * ================================================================ */

  async init(canvas: HTMLCanvasElement): Promise<void> {
    this.dispose();

    const engine = new Engine(canvas, true, {
      preserveDrawingBuffer: true,
      stencil: true,
    });
    this.engine = engine;

    const scene = new Scene(engine);
    this.scene = scene;

    const ammo = await Ammo();
    this.ammo = ammo;
    const ammoPlugin = new AmmoJSPlugin(true, ammo);
    scene.enablePhysics(new Vector3(0, -9.81, 0), ammoPlugin);

    const camera = new UniversalCamera('cam', DEFAULT_CAM_POS.clone(), scene);
    camera.setTarget(DEFAULT_CAM_TARGET.clone());
    camera.fov = DEFAULT_CAM_FOV;
    camera.minZ = 0.1;
    scene.activeCamera = camera;
    this.camera = camera;

    const light = new HemisphericLight('hemi', new Vector3(0.2, 1, 0.3), scene);
    light.intensity = 0.95;
    light.groundColor = new Color3(0.35, 0.35, 0.4);

    this.createGround(scene);
    this.createBoard(scene);
    this.buildBagMesh(scene);

    scene.onAfterPhysicsObservable.add(() => {
      this.enforceCollisions();
      this.checkBagSettled();
    });

    this.canvas = canvas;
    canvas.tabIndex = 1;
    canvas.style.cursor = 'crosshair';

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      try { canvas.setPointerCapture(e.pointerId); } catch { /* */ }
      const rect = canvas.getBoundingClientRect();
      this.onPointerDown(scene, e.clientX - rect.left, e.clientY - rect.top);
    };
    const onUp = (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* */ }
      const rect = canvas.getBoundingClientRect();
      this.onPointerUp(scene, e.clientX - rect.left, e.clientY - rect.top);
    };
    canvas.addEventListener('pointerdown', onDown, { passive: false });
    canvas.addEventListener('pointerup', onUp, { passive: false });
    canvas.addEventListener('pointercancel', onUp, { passive: false });
    this.detachCanvasPointers = () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
    };

    this.zone.runOutsideAngular(() => {
      engine.runRenderLoop(() => {
        if (this.camera && this.bag) {
          if (this.evaluating) this.updateFlightCamera();
          else if (this.dragging) this.updateAimCamera();
          else this.updateIdleCamera();
        }
        scene.render();
      });
    });

    this.resizeObserver = new ResizeObserver(() => engine.resize());
    this.resizeObserver.observe(canvas);
    engine.resize();
    requestAnimationFrame(() => engine.resize());
  }

  dispose(): void {
    if (this.nextThrowResetTimer !== null) {
      clearTimeout(this.nextThrowResetTimer);
      this.nextThrowResetTimer = null;
    }
    this.detachCanvasPointers?.();
    this.detachCanvasPointers = null;
    this.canvas = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.settledBags.forEach(b => b.dispose());
    this.settledBags = [];
    if (this.scene) { this.scene.dispose(); this.scene = null; }
    if (this.engine) { this.engine.dispose(); this.engine = null; }
    this.bag = null;
    this.camera = null;
    this.ammo = null;
    this.dragging = false;
    this.evaluating = false;
    this.settledHandled = false;
    this.calmStreak = 0;
    this.maxLinSeen = 0;
  }

  /* ================================================================
   *  Static geometry
   * ================================================================ */

  private createGround(scene: Scene): void {
    const g = MeshBuilder.CreateGround('ground',
      { width: CORNHOLE.ground.sizeM, height: CORNHOLE.ground.sizeM }, scene);
    g.position.y = 0;
    const mat = new StandardMaterial('groundMat', scene);
    mat.diffuseColor = new Color3(0.22, 0.45, 0.22);
    mat.specularColor = Color3.Black();
    g.material = mat;
    g.physicsImpostor = new PhysicsImpostor(g, PhysicsImpostor.BoxImpostor,
      { mass: 0, friction: 0.9, restitution: 0.05 }, scene);
  }

  private createBoard(scene: Scene): void {
    const { widthM, lengthM, thicknessM, holeCenterZLocal } = CORNHOLE.board;
    const { x: bx, y: by, z: bz } = CORNHOLE.boardWorld;

    const deck = MeshBuilder.CreateBox('deckVis',
      { width: widthM, height: thicknessM, depth: lengthM }, scene);
    deck.position.set(bx, by, bz);
    const wood = new StandardMaterial('wood', scene);
    wood.diffuseColor = new Color3(0.55, 0.35, 0.2);
    wood.specularColor = new Color3(0.15, 0.1, 0.05);
    deck.material = wood;

    const halfL = lengthM / 2;
    const halfW = widthM / 2;
    const zh = holeCenterZLocal;
    const R = CORNHOLE.board.holeRadiusM;

    const frameMat = wood.clone('frameMatClone');
    const fh = 0.024;
    const frameY = by + thicknessM / 2 + fh / 2;

    const addFrame = (cx: number, cz: number, w: number, d: number) => {
      const m = MeshBuilder.CreateBox(`frame_${cx}_${cz}`,
        { width: w, height: fh, depth: d }, scene);
      m.position.set(bx + cx, frameY, bz + cz);
      m.material = frameMat;
      m.physicsImpostor = new PhysicsImpostor(m, PhysicsImpostor.BoxImpostor,
        { mass: 0, friction: 0.65, restitution: 0.02 }, scene);
    };

    addFrame(0, (zh + R + halfL) / 2, widthM, halfL - (zh + R));
    addFrame(0, (-halfL + zh - R) / 2, widthM, (zh - R) - -halfL);
    addFrame((-halfW - R) / 2, zh, halfW - R, 2 * R);
    addFrame((halfW + R) / 2, zh, halfW - R, 2 * R);

    this.addDeckSurfaceColliders(scene, bx, by, bz, halfW, halfL, zh, R);
  }

  private addDeckSurfaceColliders(
    scene: Scene, bx: number, by: number, bz: number,
    halfW: number, halfL: number, zh: number, R: number,
  ): void {
    const h = CORNHOLE.deckColliderThicknessM;
    const cy = by + CORNHOLE.board.thicknessM / 2 - h / 2;

    const addDeck = (name: string, cx: number, cz: number, w: number, d: number) => {
      const m = MeshBuilder.CreateBox(name, { width: w, height: h, depth: d }, scene);
      m.position.set(bx + cx, cy, bz + cz);
      m.isVisible = false;
      m.isPickable = false;
      m.physicsImpostor = new PhysicsImpostor(m, PhysicsImpostor.BoxImpostor,
        { mass: 0, friction: 0.65, restitution: 0.02 }, scene);
    };

    const boardW = CORNHOLE.board.widthM;
    const zBelowMax = zh - R;
    const zAboveMin = zh + R;
    const depthBelow = zBelowMax - -halfL;
    if (depthBelow > 0.02) addDeck('deckSurf_below', 0, (-halfL + zBelowMax) / 2, boardW, depthBelow);
    const depthAbove = halfL - zAboveMin;
    if (depthAbove > 0.02) addDeck('deckSurf_above', 0, (zAboveMin + halfL) / 2, boardW, depthAbove);
    const xBandW = halfW - R;
    if (xBandW > 0.02) {
      addDeck('deckSurf_left', (-halfW - R) / 2, zh, xBandW, 2 * R);
      addDeck('deckSurf_right', (halfW + R) / 2, zh, xBandW, 2 * R);
    }
  }

  /* ================================================================
   *  Soft-body bag
   * ================================================================ */

  /**
   * Rounded-square bag mesh.  Start from a UV sphere, project each vertex
   * onto an anisotropic rounded box: 0.5 " radius on XZ corners, small
   * 4 mm bevel on the top/bottom edges so the bag looks flat, not puffy.
   */
  private buildBagMesh(scene: Scene): void {
    const { widthM, depthM, thicknessM } = CORNHOLE.bag;
    const bag = MeshBuilder.CreateSphere('bag', {
      segments: 14,
      diameterX: widthM,
      diameterY: thicknessM,
      diameterZ: depthM,
      updatable: true,
    }, scene);

    const rXZ = 0.5 * 0.0254;
    const rY = 0.004;
    const hx = widthM / 2 - rXZ;
    const hy = Math.max(0, thicknessM / 2 - rY);
    const hz = depthM / 2 - rXZ;
    const positions = bag.getVerticesData(VertexBuffer.PositionKind);
    if (positions) {
      for (let i = 0; i < positions.length; i += 3) {
        const cx = Math.max(-hx, Math.min(hx, positions[i]));
        const cy = Math.max(-hy, Math.min(hy, positions[i + 1]));
        const cz = Math.max(-hz, Math.min(hz, positions[i + 2]));
        const dx = positions[i] - cx;
        const dy = positions[i + 1] - cy;
        const dz = positions[i + 2] - cz;
        const sdx = dx / rXZ;
        const sdy = dy / rY;
        const sdz = dz / rXZ;
        const slen = Math.sqrt(sdx * sdx + sdy * sdy + sdz * sdz);
        if (slen > 1e-6) {
          positions[i] = cx + rXZ * sdx / slen;
          positions[i + 1] = cy + rY * sdy / slen;
          positions[i + 2] = cz + rXZ * sdz / slen;
        } else {
          positions[i] = cx;
          positions[i + 1] = cy;
          positions[i + 2] = cz;
        }
      }
      bag.updateVerticesData(VertexBuffer.PositionKind, positions);
    }
    bag.createNormals(true);
    bag.forceSharedVertices();

    const mat = new StandardMaterial('bagMat', scene);
    mat.diffuseColor = new Color3(0.85, 0.12, 0.12);
    mat.specularColor = Color3.Black();
    bag.material = mat;

    const { x, z } = CORNHOLE.throwLine;
    bag.position.set(x, throwLineY(), z);
    bag.rotationQuaternion = Quaternion.Identity();
    this.bag = bag;
  }

  /**
   * Attach the SoftbodyImpostor right before the throw so gravity doesn't
   * pull the bag down while it sits on the throw line.
   */
  private activateBagPhysics(): void {
    if (!this.bag || !this.scene || this.bag.physicsImpostor) return;
    this.bag.physicsImpostor = new PhysicsImpostor(
      this.bag, PhysicsImpostor.SoftbodyImpostor, {
        mass: CORNHOLE.bag.massKg,
        friction: 0.9,
        restitution: 0.01,
        pressure: 8,
        stiffness: 0.85,
        damping: 0.05,
        velocityIterations: 8,
        positionIterations: 8,
        margin: 0.03,
      }, this.scene,
    );

    const body = this.bag.physicsImpostor.physicsBody as any;
    if (body?.get_m_cfg) {
      const cfg = body.get_m_cfg();
      cfg.set_kCHR(1.0);
      cfg.set_kKHR(0.8);
      cfg.set_kSHR(1.0);
    }
  }

  /**
   * Freeze the settled bag as static scenery and spawn a new throwable bag.
   * Missed bags (on the ground, fell through hole, out of world) are removed.
   */
  private resetBagPosition(): void {
    if (!this.scene) return;
    if (this.bag) {
      const p = this.bagWorldCenter();
      const onBoard = p.y > 0.42 && p.y < 0.75;
      if (this.bag.physicsImpostor) {
        this.bag.physicsImpostor.dispose();
        this.bag.physicsImpostor = null;
      }
      if (onBoard) {
        this.settledBags.push(this.bag);
      } else {
        this.bag.dispose();
      }
      this.bag = null;
    }
    this.buildBagMesh(this.scene);
    this.settledHandled = false;
    this.evaluating = false;
    this.firstContactMs = 0;
    this.calmStreak = 0;
    this.maxLinSeen = 0;
    this.resetCameraToDefault();
  }

  /* ── Soft-body helpers ──────────────────────────────────────────── */

  /** World-space center computed from Ammo soft-body nodes (Ammo Z → Babylon -Z). */
  private bagWorldCenter(): Vector3 {
    if (!this.bag) return this.scratchBagCenter.set(0, 0, 0);
    const nodes = this.softNodes();
    if (!nodes || nodes.size() === 0) {
      return this.scratchBagCenter.copyFrom(this.bag.position);
    }
    const count = nodes.size();
    let sx = 0, sy = 0, sz = 0;
    for (let i = 0; i < count; i++) {
      const p = nodes.at(i).get_m_x();
      sx += p.x(); sy += p.y(); sz += p.z();
    }
    const inv = 1 / count;
    this.scratchBagCenter.set(sx * inv, sy * inv, -sz * inv);
    return this.scratchBagCenter;
  }

  private softNodes(): AmmoNodeArray | null {
    return (this.bag?.physicsImpostor?.physicsBody as any)?.get_m_nodes?.() ?? null;
  }

  /**
   * Apply throw velocity to every soft-body node.
   * `get_m_v()` returns a reference into the WASM heap (not a copy), so
   * setX/Y/Z writes hit the node data directly.
   *
   * Babylon uses a left-handed coordinate system; Ammo (Bullet) uses
   * right-handed.  The AmmoJSPlugin negates Z when converting between
   * them, so we must negate deltaV.z when writing directly to nodes.
   */
  private applySoftBodyVelocity(deltaV: Vector3, spinY: number): void {
    const imp = this.bag?.physicsImpostor;
    if (!imp) return;
    const body = imp.physicsBody as any;
    if (!body?.get_m_nodes) return;
    const nodes: AmmoNodeArray = body.get_m_nodes();
    const count = nodes.size();
    if (count === 0) return;

    let cx = 0, cz = 0;
    for (let i = 0; i < count; i++) {
      const p = nodes.at(i).get_m_x();
      cx += p.x(); cz += p.z();
    }
    const inv = 1 / count;
    cx *= inv; cz *= inv;

    const ammoVz = -deltaV.z;

    for (let i = 0; i < count; i++) {
      const node = nodes.at(i);
      const p = node.get_m_x();
      const rx = p.x() - cx;
      const rz = p.z() - cz;

      const vel = node.get_m_v();
      vel.setX(deltaV.x + spinY * rz);
      vel.setY(deltaV.y);
      vel.setZ(ammoVz - spinY * rx);
    }

    body.activate(true);
  }

  /** Motion metrics from soft-body node velocities (no getLinearVelocity on btSoftBody). */
  private getSoftMotion(): { lin: number; ang: number } {
    const nodes = this.softNodes();
    if (!nodes) return { lin: 0, ang: 0 };
    const count = nodes.size();
    if (count === 0) return { lin: 0, ang: 0 };

    let maxSp = 0, sx = 0, sy = 0, sz = 0;
    for (let i = 0; i < count; i++) {
      const vel = nodes.at(i).get_m_v();
      const vx = vel.x(), vy = vel.y(), vz = vel.z();
      const sp = Math.hypot(vx, vy, vz);
      if (sp > maxSp) maxSp = sp;
      sx += vx; sy += vy; sz += vz;
    }
    const inv = 1 / count;
    const ax = sx * inv, ay = sy * inv, az = sz * inv;
    let varSum = 0;
    for (let i = 0; i < count; i++) {
      const vel = nodes.at(i).get_m_v();
      const dx = vel.x() - ax, dy = vel.y() - ay, dz = vel.z() - az;
      varSum += dx * dx + dy * dy + dz * dz;
    }
    return { lin: maxSp, ang: Math.sqrt(varSum * inv) };
  }

  /* ================================================================
   *  Camera
   * ================================================================ */

  private resetCameraToDefault(): void {
    if (!this.camera) return;
    this.camera.position.copyFrom(DEFAULT_CAM_POS);
    this.camera.fov = DEFAULT_CAM_FOV;
    this.camera.setTarget(DEFAULT_CAM_TARGET.clone());
  }

  private applyBagFollowCamera(smooth: number): void {
    if (!this.camera || !this.bag) return;
    const bagPos = this.bagWorldCenter();
    const arcBoost = Math.min(1.15, Math.max(0, bagPos.y - 0.42) * 0.58);
    this.scratchDesiredCam.set(
      bagPos.x + FLIGHT_FOLLOW_OFFSET.x,
      bagPos.y + FLIGHT_FOLLOW_OFFSET.y + arcBoost,
      bagPos.z + FLIGHT_FOLLOW_OFFSET.z,
    );
    this.scratchFocus.set(bagPos.x, bagPos.y + 0.04, bagPos.z);
    Vector3.LerpToRef(this.camera.position, this.scratchDesiredCam, smooth, this.camera.position);
    this.scratchCamTarget.copyFrom(this.camera.getTarget());
    Vector3.LerpToRef(this.scratchCamTarget, this.scratchFocus, smooth, this.scratchNextTarget);
    this.camera.setTarget(this.scratchNextTarget);
    if (smooth >= 0.99) this.camera.fov = FLIGHT_CAM_FOV;
    else this.camera.fov += (FLIGHT_CAM_FOV - this.camera.fov) * 0.14;
  }

  private updateFlightCamera(): void { this.applyBagFollowCamera(0.42); }

  private updateIdleCamera(): void {
    if (!this.camera || !this.bag) return;
    const bagPos = this.bagWorldCenter();
    this.scratchFocus.set(
      bagPos.x * 0.22 + DEFAULT_CAM_TARGET.x * 0.78,
      Math.min(0.52, bagPos.y * 0.35 + DEFAULT_CAM_TARGET.y * 0.65),
      bagPos.z * 0.18 + DEFAULT_CAM_TARGET.z * 0.82,
    );
    const beta = 0.1;
    Vector3.LerpToRef(this.camera.position, DEFAULT_CAM_POS, beta, this.camera.position);
    this.scratchCamTarget.copyFrom(this.camera.getTarget());
    Vector3.LerpToRef(this.scratchCamTarget, this.scratchFocus, beta, this.scratchNextTarget);
    this.camera.setTarget(this.scratchNextTarget);
    this.camera.fov += (DEFAULT_CAM_FOV - this.camera.fov) * 0.14;
  }

  private updateAimCamera(): void {
    if (!this.camera) return;
    this.camera.fov += (AIM_CAM_FOV - this.camera.fov) * 0.2;
  }

  /* ================================================================
   *  Input
   * ================================================================ */

  private aimPointOnGround(scene: Scene, canvasX: number, canvasY: number): Vector3 | null {
    const camera = scene.activeCamera;
    if (!camera) return null;
    const ray = scene.createPickingRay(canvasX, canvasY, Matrix.Identity(), camera);
    const t = ray.intersectsPlane(GROUND_PLANE);
    if (t === null || t < 0) return null;
    return ray.origin.add(ray.direction.scale(t));
  }

  private onPointerDown(scene: Scene, canvasX: number, canvasY: number): void {
    const gs = this.gameState.snapshot;
    if (!gs.canThrow || gs.throwsRemaining <= 0) return;
    const hit = this.aimPointOnGround(scene, canvasX, canvasY);
    if (!hit) return;
    this.dragStart = hit.clone();
    let started = false;
    this.zone.run(() => { started = this.gameState.beginThrow(); });
    if (!started) return;
    this.dragging = true;
  }

  private onPointerUp(scene: Scene, canvasX: number, canvasY: number): void {
    if (!this.dragging || !this.bag) { this.dragging = false; return; }
    this.dragging = false;

    const target = this.aimPointOnGround(scene, canvasX, canvasY);
    if (!target) {
      this.zone.run(() => this.gameState.cancelThrow());
      this.resetCameraToDefault();
      return;
    }

    const bagPos = this.bag.position.clone();
    this.activateBagPhysics();
    if (!this.bag.physicsImpostor) return;

    /**
     * Aim: always toward the board, with lateral user aim blended in.
     * Throw power (pullT from drag length) controls whether the bag
     * lands short, on, or past the board.
     *
     * Projectile math (g = 9.81):
     *   pullT=0.0 → lands ~0.3 m short of board front edge (weak toss)
     *   pullT=0.5 → lands on board center
     *   pullT=1.0 → lands ~1 m past board back edge (hard throw)
     */
    const toBoardX = CORNHOLE.boardWorld.x - bagPos.x;
    const toBoardZ = CORNHOLE.boardWorld.z - bagPos.z;
    const lateralAimX = target.x - bagPos.x;
    const dir = new Vector3(
      toBoardX * 0.7 + lateralAimX * 0.3,
      0,
      toBoardZ,
    );
    if (dir.lengthSquared() < 1e-8) dir.set(0, 0, 1);
    dir.normalize();

    const pull = Vector3.Distance(this.dragStart, target);
    const pullT = Math.min(1, pull / 4.2);
    const horizSpeed = 2.1 + pullT * 1.0;
    const upSpeed = 5.5 + pullT * 1.5;
    const deltaV = dir.scale(horizSpeed).add(new Vector3(0, upSpeed, 0));

    const spinY = 0.8 + pullT * 1.5;
    this.applySoftBodyVelocity(deltaV, spinY);

    this.evaluating = true;
    this.settledHandled = false;
    this.firstContactMs = 0;
    this.calmStreak = 0;
    this.maxLinSeen = 0;
    this.throwStartMs = performance.now();
    this.applyBagFollowCamera(1);
    this.zone.run(() => { /* throw started */ });
  }

  /* ================================================================
   *  Settle detection
   * ================================================================ */

  private checkBagSettled(): void {
    if (!this.evaluating || this.settledHandled || !this.bag?.physicsImpostor) return;

    const elapsed = performance.now() - this.throwStartMs;
    const p = this.bagWorldCenter();
    const outOfWorld = p.y < -0.8 || p.y > 30 || Math.abs(p.x) > 80 || Math.abs(p.z) > 80;
    const sinceContact = this.firstContactMs > 0
      ? performance.now() - this.firstContactMs : 0;
    const ready = sinceContact >= 1200 || outOfWorld || elapsed > 10000;
    if (!ready) return;

    let result = this.classifyThrow(p);
    if (outOfWorld || elapsed >= 10000) result = 'miss';
    this.settledHandled = true;
    this.evaluating = false;

    this.zone.run(() => this.gameState.recordSettledResult(result));

    if (this.nextThrowResetTimer !== null) clearTimeout(this.nextThrowResetTimer);
    this.nextThrowResetTimer = setTimeout(() => {
      this.nextThrowResetTimer = null;
      this.zone.run(() => {
        this.resetBagPosition();
        this.gameState.prepareNextThrow();
      });
    }, 800);
  }

  /**
   * Manual collision enforcement — runs every physics step.
   * The Babylon CDN Ammo.js build doesn't reliably resolve soft-body vs
   * rigid-body contacts, so we project penetrating nodes back onto
   * the ground plane and the board deck surface ourselves.
   *
   * All node positions from get_m_x() are in Ammo's right-handed frame
   * where Z is negated relative to Babylon.
   */
  private enforceCollisions(): void {
    const nodes = this.softNodes();
    if (!nodes) return;
    const count = nodes.size();
    if (count === 0) return;

    const boardSurfY = CORNHOLE.boardWorld.y + CORNHOLE.board.thicknessM / 2;
    const bx = CORNHOLE.boardWorld.x;
    const bzAmmo = -CORNHOLE.boardWorld.z;
    const halfW = CORNHOLE.board.widthM / 2;
    const halfL = CORNHOLE.board.lengthM / 2;
    const holeZAmmo = -(CORNHOLE.boardWorld.z + CORNHOLE.board.holeCenterZLocal);
    const holeR2 = CORNHOLE.board.holeRadiusM * CORNHOLE.board.holeRadiusM;
    let touched = false;

    for (let i = 0; i < count; i++) {
      const node = nodes.at(i);
      const pos = node.get_m_x();
      const vel = node.get_m_v();
      const px = pos.x(), py = pos.y(), pz = pos.z();

      if (py < 0) {
        pos.setY(0);
        vel.setY(0);
        vel.setX(vel.x() * 0.4);
        vel.setZ(vel.z() * 0.4);
        touched = true;
      }

      const dx = px - bx;
      const dz = pz - bzAmmo;
      if (Math.abs(dx) <= halfW && Math.abs(dz) <= halfL && py < boardSurfY && py > boardSurfY - 0.35) {
        const hx = px - bx;
        const hz = pz - holeZAmmo;
        if (hx * hx + hz * hz > holeR2) {
          pos.setY(boardSurfY);
          vel.setY(0);
          vel.setX(vel.x() * 0.4);
          vel.setZ(vel.z() * 0.4);
          touched = true;
        }
      }
    }

    if (touched && this.firstContactMs === 0 && this.evaluating) {
      this.firstContactMs = performance.now();
    }
  }

  private classifyThrow(p: Vector3): ThrowResult {
    const { widthM, lengthM } = CORNHOLE.board;
    const { x: bx, z: bz } = CORNHOLE.boardWorld;
    const halfW = widthM / 2;
    const halfL = lengthM / 2;

    const lx = p.x - bx;
    const lz = p.z - bz;
    const dxHole = p.x - HOLE_WORLD.x;
    const dzHole = p.z - HOLE_WORLD.z;
    const holeDist = Math.hypot(dxHole, dzHole);

    const onBoardXZ =
      Math.abs(lx) <= halfW + 0.04 && lz >= -halfL - 0.04 && lz <= halfL + 0.04;
    const nearGround = p.y < CORNHOLE.bag.thicknessM * 2.5;
    const inHoleRadius = holeDist < CORNHOLE.board.holeRadiusM + 0.02;

    if (nearGround && inHoleRadius) return 'in_hole';
    if (p.y > 0.42 && p.y < 0.75 && onBoardXZ && holeDist > CORNHOLE.board.holeRadiusM * 0.85) return 'on_board';
    if (p.y > 0.42 && p.y < 0.75 && onBoardXZ && inHoleRadius) return 'on_board';
    if (nearGround && !inHoleRadius) return 'miss';
    if (p.y > 0.42 && p.y < 0.75 && onBoardXZ) return 'on_board';
    return 'miss';
  }
}
