import { Injectable, NgZone, inject } from '@angular/core';
import '@babylonjs/core/Physics/joinedPhysicsEngineComponent';
/** Side-effect: registers Scene.createPickingRay / Ray extensions used by aimPointOnGround */
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
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { PhysicsImpostor } from '@babylonjs/core/Physics/v1/physicsImpostor';
import { CannonJSPlugin } from '@babylonjs/core/Physics/v1/Plugins/cannonJSPlugin';
import * as CANNON from 'cannon-es';
import { CORNHOLE, throwLineY } from './cornhole-constants';
import { GameStateService, ThrowResult } from './game-state.service';

const HOLE_WORLD = {
  x: 0,
  z: CORNHOLE.boardWorld.z + CORNHOLE.board.holeCenterZLocal,
};

/** Ground plane y=0 — mesh picking often hits the bag/board first; aim uses this plane instead. */
const GROUND_PLANE = Plane.FromPositionAndNormal(new Vector3(0, 0, 0), new Vector3(0, 1, 0));

/** Default view — restored when the bag returns to the throw line. */
const DEFAULT_CAM_POS = new Vector3(0, 1.9, -3.2);
const DEFAULT_CAM_TARGET = new Vector3(0, 0.45, 2.5);
/** Slightly wide so the bag at the throw line stays in frame without zooming. */
const DEFAULT_CAM_FOV = 0.9;
/** Wider frustum while tracking the bag so lobs stay in view. */
const FLIGHT_CAM_FOV = 1.05;
/** Slightly wider than default while dragging to keep bag and lawn in view. */
const AIM_CAM_FOV = 0.92;
/**
 * Third-person offset from the bag while in flight: up and toward the player (-Z),
 * so the camera trails the shot from the throwing side toward the board.
 */
const FLIGHT_FOLLOW_OFFSET = new Vector3(0, 1.72, -4.55);

@Injectable({ providedIn: 'root' })
export class CornholeSceneService {
  private engine: Engine | null = null;
  private scene: Scene | null = null;
  private camera: UniversalCamera | null = null;
  private bag: Mesh | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private dragging = false;
  private dragStart = new Vector3();
  private evaluating = false;
  private settledHandled = false;
  private throwStartMs = 0;
  private calmStreak = 0;
  /** Max linear speed seen this throw — avoids instant "settled" before the bag moves. */
  private maxLinSeen = 0;
  /** Delay bag rack + input unlock after the physics result is known. */
  private nextThrowResetTimer: ReturnType<typeof setTimeout> | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private detachCanvasPointers: (() => void) | null = null;

  private readonly scratchFocus = new Vector3();
  private readonly scratchDesiredCam = new Vector3();
  private readonly scratchNextTarget = new Vector3();
  private readonly scratchCamTarget = new Vector3();

  private readonly zone = inject(NgZone);
  private readonly gameState = inject(GameStateService);

  init(canvas: HTMLCanvasElement): void {
    this.dispose();

    const engine = new Engine(canvas, true, {
      preserveDrawingBuffer: true,
      stencil: true,
    });
    this.engine = engine;

    const scene = new Scene(engine);
    this.scene = scene;

    const cannonPlugin = new CannonJSPlugin(true, 16, CANNON);
    scene.enablePhysics(new Vector3(0, -9.81, 0), cannonPlugin);

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
    this.createBag(scene);

    scene.onAfterPhysicsObservable.add(() => this.checkBagSettled());

    this.canvas = canvas;
    canvas.tabIndex = 1;
    canvas.style.cursor = 'crosshair';

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) {
        return;
      }
      e.preventDefault();
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* already captured or unsupported */
      }
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      this.onPointerDown(scene, x, y);
    };
    const onUp = (e: PointerEvent) => {
      if (e.button !== 0) {
        return;
      }
      e.preventDefault();
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* no capture */
      }
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      this.onPointerUp(scene, x, y);
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
          if (this.evaluating) {
            this.updateFlightCamera();
          } else if (this.dragging) {
            this.updateAimCamera();
          } else {
            this.updateIdleCamera();
          }
        }
        scene.render();
      });
    });

    this.resizeObserver = new ResizeObserver(() => {
      engine.resize();
    });
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
    if (this.scene) {
      this.scene.dispose();
      this.scene = null;
    }
    if (this.engine) {
      this.engine.dispose();
      this.engine = null;
    }
    this.bag = null;
    this.camera = null;
    this.dragging = false;
    this.evaluating = false;
    this.settledHandled = false;
    this.calmStreak = 0;
    this.maxLinSeen = 0;
  }

  private createGround(scene: Scene): void {
    const g = MeshBuilder.CreateGround(
      'ground',
      { width: CORNHOLE.ground.sizeM, height: CORNHOLE.ground.sizeM },
      scene,
    );
    g.position.y = 0;
    const mat = new StandardMaterial('groundMat', scene);
    mat.diffuseColor = new Color3(0.22, 0.45, 0.22);
    mat.specularColor = Color3.Black();
    g.material = mat;
    g.physicsImpostor = new PhysicsImpostor(
      g,
      PhysicsImpostor.BoxImpostor,
      { mass: 0, friction: 0.9, restitution: 0.05 },
      scene,
    );
  }

  private createBoard(scene: Scene): void {
    const { widthM, lengthM, thicknessM, holeCenterZLocal } = CORNHOLE.board;
    const { x: bx, y: by, z: bz } = CORNHOLE.boardWorld;

    const deck = MeshBuilder.CreateBox(
      'deckVis',
      { width: widthM, height: thicknessM, depth: lengthM },
      scene,
    );
    deck.position.set(bx, by, bz);
    const wood = new StandardMaterial('wood', scene);
    wood.diffuseColor = new Color3(0.55, 0.35, 0.2);
    wood.specularColor = new Color3(0.15, 0.1, 0.05);
    deck.material = wood;

    const halfL = lengthM / 2;
    const halfW = widthM / 2;
    const zh = holeCenterZLocal;
    const R = CORNHOLE.board.holeRadiusM;
    const zTop0 = zh + R;
    const zTop1 = halfL;
    const zBot0 = -halfL;
    const zBot1 = zh - R;

    const frameMat = wood.clone('frameMatClone');
    const frameY = by + thicknessM / 2 + 0.012;
    const fh = 0.024;

    const addFrame = (cx: number, cz: number, w: number, d: number) => {
      const m = MeshBuilder.CreateBox(
        `frame_${cx}_${cz}`,
        { width: w, height: fh, depth: d },
        scene,
      );
      m.position.set(bx + cx, frameY, bz + cz);
      m.material = frameMat;
      m.physicsImpostor = new PhysicsImpostor(
        m,
        PhysicsImpostor.BoxImpostor,
        { mass: 0, friction: 0.65, restitution: 0.02 },
        scene,
      );
    };

    addFrame(0, (zTop0 + zTop1) / 2, widthM, zTop1 - zTop0);
    addFrame(0, (zBot0 + zBot1) / 2, widthM, zBot1 - zBot0);
    addFrame((-halfW - R) / 2, zh, halfW - R, 2 * R);
    addFrame((halfW + R) / 2, zh, halfW - R, 2 * R);

    this.addDeckSurfaceColliders(scene, bx, by, bz, halfW, halfL, zh, R);
  }

  /**
   * Four thin static boxes tiling the deck top around the circular hole (no concave mesh).
   */
  private addDeckSurfaceColliders(
    scene: Scene,
    bx: number,
    by: number,
    bz: number,
    halfW: number,
    halfL: number,
    zh: number,
    R: number,
  ): void {
    const h = CORNHOLE.deckColliderThicknessM;
    const topY = by + CORNHOLE.board.thicknessM / 2;
    const cy = topY - h / 2;

    const addDeck = (name: string, cx: number, cz: number, w: number, d: number) => {
      const m = MeshBuilder.CreateBox(name, { width: w, height: h, depth: d }, scene);
      m.position.set(bx + cx, cy, bz + cz);
      m.isVisible = false;
      m.isPickable = false;
      m.physicsImpostor = new PhysicsImpostor(
        m,
        PhysicsImpostor.BoxImpostor,
        { mass: 0, friction: 0.65, restitution: 0.02 },
        scene,
      );
    };

    const boardW = CORNHOLE.board.widthM;
    const zBelowMax = zh - R;
    const zAboveMin = zh + R;
    const depthBelow = zBelowMax - -halfL;
    if (depthBelow > 0.02) {
      addDeck('deckSurf_below', 0, (-halfL + zBelowMax) / 2, boardW, depthBelow);
    }
    const depthAbove = halfL - zAboveMin;
    if (depthAbove > 0.02) {
      addDeck('deckSurf_above', 0, (zAboveMin + halfL) / 2, boardW, depthAbove);
    }
    const xBandW = halfW - R;
    if (xBandW > 0.02) {
      addDeck('deckSurf_left', (-halfW - R) / 2, zh, xBandW, 2 * R);
      addDeck('deckSurf_right', (halfW + R) / 2, zh, xBandW, 2 * R);
    }
  }

  private createBag(scene: Scene): void {
    const { widthM, depthM, thicknessM, massKg } = CORNHOLE.bag;
    const bag = MeshBuilder.CreateBox(
      'bag',
      { width: widthM, height: thicknessM, depth: depthM },
      scene,
    );
    this.bag = bag;
    const mat = new StandardMaterial('bagMat', scene);
    mat.diffuseColor = new Color3(0.85, 0.12, 0.12);
    mat.specularColor = Color3.Black();
    bag.material = mat;
    this.resetBagPosition();
    bag.physicsImpostor = new PhysicsImpostor(
      bag,
      PhysicsImpostor.BoxImpostor,
      {
        mass: massKg,
        friction: 0.75,
        restitution: 0.08,
        nativeOptions: {
          linearDamping: 0.22,
          angularDamping: 0.55,
        },
      },
      scene,
    );
  }

  private resetBagPosition(): void {
    if (!this.bag) {
      return;
    }
    const { x, z } = CORNHOLE.throwLine;
    this.bag.position.set(x, throwLineY(), z);
    /**
     * Must keep `rotationQuaternion` set: PhysicsImpostor.beforeStep only pushes the mesh pose
     * into Cannon when quaternion exists; if it is null, the body stays at the old pose and
     * afterStep snaps the mesh back — bag vanishes from the throw line after reset.
     */
    this.bag.rotationQuaternion = Quaternion.Identity();
    const imp = this.bag.physicsImpostor;
    if (imp) {
      imp.setMass(CORNHOLE.bag.massKg);
      imp.setLinearVelocity(Vector3.Zero());
      imp.setAngularVelocity(Vector3.Zero());
      const p = this.bag.getAbsolutePosition();
      imp.executeNativeFunction((_world, body: CANNON.Body) => {
        body.position.set(p.x, p.y, p.z);
        body.velocity.set(0, 0, 0);
        body.angularVelocity.set(0, 0, 0);
        body.quaternion.set(0, 0, 0, 1);
      });
      imp.sleep();
    }
    this.settledHandled = false;
    this.evaluating = false;
    this.calmStreak = 0;
    this.maxLinSeen = 0;
    this.resetCameraToDefault();
  }

  private resetCameraToDefault(): void {
    if (!this.camera) {
      return;
    }
    this.camera.position.copyFrom(DEFAULT_CAM_POS);
    this.camera.fov = DEFAULT_CAM_FOV;
    this.camera.setTarget(DEFAULT_CAM_TARGET.clone());
  }

  /**
   * Follow the bag from release until it settles: camera stays behind/near the throwing side
   * and tracks the bag center (with a small arc-height boost so lobs stay in frame).
   * @param smooth 1 = snap to follow (used on release); lower values smooth over frames.
   */
  private applyBagFollowCamera(smooth: number): void {
    if (!this.camera || !this.bag) {
      return;
    }
    const bagPos = this.bag.absolutePosition;
    const arcBoost = Math.min(1.15, Math.max(0, bagPos.y - 0.42) * 0.58);
    this.scratchDesiredCam.set(
      bagPos.x + FLIGHT_FOLLOW_OFFSET.x,
      bagPos.y + FLIGHT_FOLLOW_OFFSET.y + arcBoost,
      bagPos.z + FLIGHT_FOLLOW_OFFSET.z,
    );
    this.scratchFocus.set(bagPos.x, bagPos.y + 0.04, bagPos.z);
    const alpha = smooth;
    Vector3.LerpToRef(this.camera.position, this.scratchDesiredCam, alpha, this.camera.position);
    this.scratchCamTarget.copyFrom(this.camera.getTarget());
    Vector3.LerpToRef(this.scratchCamTarget, this.scratchFocus, alpha, this.scratchNextTarget);
    this.camera.setTarget(this.scratchNextTarget);
    if (smooth >= 0.99) {
      this.camera.fov = FLIGHT_CAM_FOV;
    } else {
      this.camera.fov += (FLIGHT_CAM_FOV - this.camera.fov) * 0.14;
    }
  }

  private updateFlightCamera(): void {
    this.applyBagFollowCamera(0.42);
  }

  /** Keep default framing between throws; gently nudges toward the bag so it never clips out. */
  private updateIdleCamera(): void {
    if (!this.camera || !this.bag) {
      return;
    }
    const bagPos = this.bag.absolutePosition;
    const idleFocus = this.scratchFocus;
    idleFocus.set(
      bagPos.x * 0.22 + DEFAULT_CAM_TARGET.x * 0.78,
      Math.min(0.52, bagPos.y * 0.35 + DEFAULT_CAM_TARGET.y * 0.65),
      bagPos.z * 0.18 + DEFAULT_CAM_TARGET.z * 0.82,
    );
    const beta = 0.1;
    Vector3.LerpToRef(this.camera.position, DEFAULT_CAM_POS, beta, this.camera.position);
    this.scratchCamTarget.copyFrom(this.camera.getTarget());
    Vector3.LerpToRef(this.scratchCamTarget, idleFocus, beta, this.scratchNextTarget);
    this.camera.setTarget(this.scratchNextTarget);
    this.camera.fov += (DEFAULT_CAM_FOV - this.camera.fov) * 0.14;
  }

  private updateAimCamera(): void {
    if (!this.camera) {
      return;
    }
    this.camera.fov += (AIM_CAM_FOV - this.camera.fov) * 0.2;
  }

  /**
   * Aim point on the lawn (y=0) from canvas coordinates.
   * Uses a ray vs plane so the bag/board in front of the ground do not block aiming.
   */
  private aimPointOnGround(scene: Scene, canvasX: number, canvasY: number): Vector3 | null {
    const camera = scene.activeCamera;
    if (!camera) {
      return null;
    }
    const ray = scene.createPickingRay(canvasX, canvasY, Matrix.Identity(), camera);
    const t = ray.intersectsPlane(GROUND_PLANE);
    if (t === null || t < 0) {
      return null;
    }
    return ray.origin.add(ray.direction.scale(t));
  }

  private onPointerDown(scene: Scene, canvasX: number, canvasY: number): void {
    const gs = this.gameState.snapshot;
    if (!gs.canThrow || gs.throwsRemaining <= 0) {
      return;
    }
    const hit = this.aimPointOnGround(scene, canvasX, canvasY);
    if (!hit) {
      return;
    }
    this.dragStart = hit.clone();
    let started = false;
    this.zone.run(() => {
      started = this.gameState.beginThrow();
    });
    if (!started) {
      return;
    }
    this.dragging = true;
  }

  private onPointerUp(scene: Scene, canvasX: number, canvasY: number): void {
    if (!this.dragging || !this.bag?.physicsImpostor) {
      this.dragging = false;
      return;
    }
    this.dragging = false;

    const target = this.aimPointOnGround(scene, canvasX, canvasY);

    if (!target) {
      this.zone.run(() => this.gameState.cancelThrow());
      this.resetCameraToDefault();
      return;
    }
    const bagPos = this.bag.absolutePosition.clone();
    /**
     * Horizontal aim = toward the release point on the lawn (from the bag).
     * Drag length still sets power; swipe-only direction often projects to ~0 in XZ and looked “vertical only”.
     */
    const dir = target.subtract(bagPos);
    dir.y = 0;
    if (dir.lengthSquared() < 1e-4) {
      dir.set(
        CORNHOLE.boardWorld.x - bagPos.x,
        0,
        CORNHOLE.boardWorld.z - bagPos.z,
      );
    }
    if (dir.lengthSquared() < 1e-8) {
      dir.set(0, 0, 1);
    }
    dir.normalize();

    /** Cannon `applyImpulse` uses N·s; use I = m * Δv for realistic toss speeds (m/s). */
    const mass = CORNHOLE.bag.massKg;
    const pull = Vector3.Distance(this.dragStart, target);
    const pullT = Math.min(1, pull / 4.2);
    /** Underhand lob: stronger vertical component vs flat laser throw. */
    const horizSpeed = 1.5 + pullT * 4.2;
    const upSpeed = 2.2 + pullT * 4.5;
    const deltaV = dir.scale(horizSpeed).add(new Vector3(0, upSpeed, 0));
    const impulse = deltaV.scale(mass);

    this.bag.physicsImpostor.wakeUp();
    this.bag.physicsImpostor.applyImpulse(impulse, this.bag.getAbsolutePosition());

    this.evaluating = true;
    this.settledHandled = false;
    this.calmStreak = 0;
    this.maxLinSeen = 0;
    this.throwStartMs = performance.now();
    this.applyBagFollowCamera(1);
    this.zone.run(() => {
      /* throw started */
    });
  }

  private checkBagSettled(): void {
    if (!this.evaluating || this.settledHandled || !this.bag?.physicsImpostor) {
      return;
    }
    const imp = this.bag.physicsImpostor;
    const v = imp.getLinearVelocity();
    const av = imp.getAngularVelocity();
    if (!v) {
      return;
    }
    const lin = v.length();
    const ang = av?.length() ?? 0;
    this.maxLinSeen = Math.max(this.maxLinSeen, lin);
    /** Do not fold angular speed into one threshold — a spinning bag stays "fast" forever. */
    const calm = lin < 0.24 && ang < 2.4;
    const elapsed = performance.now() - this.throwStartMs;
    /** Ignore "calm" until the throw has had time to integrate (avoids instant reset / flash). */
    const minFlightMs = 500;
    if (calm && elapsed >= minFlightMs) {
      this.calmStreak++;
    } else {
      this.calmStreak = 0;
    }
    /** Require evidence the bag actually left the hand, or resting low (ground); board rests rely on prior peak speed. */
    const p = this.bag.absolutePosition;
    const likelyResting =
      this.maxLinSeen > 0.18 ||
      p.y < CORNHOLE.bag.thicknessM * 3.5 ||
      elapsed > 12000;
    const stuckNoMotion = elapsed > 2500 && this.maxLinSeen < 0.2 && calm;
    const settledEnough = this.calmStreak >= 12 && likelyResting;
    const outOfWorld = p.y < -0.8 || p.y > 30 || Math.abs(p.x) > 80 || Math.abs(p.z) > 80;
    if (!settledEnough && !outOfWorld && !stuckNoMotion && elapsed < 45000) {
      return;
    }

    let result = this.classifyThrow(p);
    if (outOfWorld || elapsed >= 45000) {
      result = 'miss';
    }
    this.settledHandled = true;
    this.evaluating = false;

    this.zone.run(() => {
      this.gameState.recordSettledResult(result);
    });

    if (this.nextThrowResetTimer !== null) {
      clearTimeout(this.nextThrowResetTimer);
    }
    this.nextThrowResetTimer = setTimeout(() => {
      this.nextThrowResetTimer = null;
      this.zone.run(() => {
        this.resetBagPosition();
        this.gameState.prepareNextThrow();
      });
    }, 2000);
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

    if (nearGround && inHoleRadius) {
      return 'in_hole';
    }
    if (p.y > 0.42 && p.y < 0.75 && onBoardXZ && holeDist > CORNHOLE.board.holeRadiusM * 0.85) {
      return 'on_board';
    }
    if (p.y > 0.42 && p.y < 0.75 && onBoardXZ && inHoleRadius) {
      return 'on_board';
    }
    if (nearGround && !inHoleRadius) {
      return 'miss';
    }
    if (p.y > 0.42 && p.y < 0.75 && onBoardXZ) {
      return 'on_board';
    }
    return 'miss';
  }
}
