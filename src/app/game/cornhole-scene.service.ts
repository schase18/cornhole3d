import { Injectable, NgZone, inject } from '@angular/core';
import '@babylonjs/core/Physics/joinedPhysicsEngineComponent';
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { PhysicsImpostor } from '@babylonjs/core/Physics/v1/physicsImpostor';
import { CannonJSPlugin } from '@babylonjs/core/Physics/v1/Plugins/cannonJSPlugin';
import { PointerEventTypes } from '@babylonjs/core/Events/pointerEvents';
import * as CANNON from 'cannon-es';
import { CORNHOLE } from './cornhole-constants';
import { GameStateService, ThrowResult } from './game-state.service';

const HOLE_WORLD = {
  x: 0,
  z: CORNHOLE.boardWorld.z + CORNHOLE.board.holeCenterZLocal,
};

@Injectable({ providedIn: 'root' })
export class CornholeSceneService {
  private engine: Engine | null = null;
  private scene: Scene | null = null;
  private bag: Mesh | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private dragging = false;
  private dragStart = new Vector3();
  private evaluating = false;
  private settledHandled = false;

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

    const cannonPlugin = new CannonJSPlugin(true, 10, CANNON);
    scene.enablePhysics(new Vector3(0, -9.81, 0), cannonPlugin);

    const camera = new UniversalCamera('cam', new Vector3(0, 1.9, -3.2), scene);
    camera.setTarget(new Vector3(0, 0.45, 2.5));
    camera.minZ = 0.1;
    scene.activeCamera = camera;

    const light = new HemisphericLight('hemi', new Vector3(0.2, 1, 0.3), scene);
    light.intensity = 0.95;
    light.groundColor = new Color3(0.35, 0.35, 0.4);

    this.createGround(scene);
    this.createBoard(scene);
    this.createBag(scene);

    scene.onAfterPhysicsObservable.add(() => this.checkBagSettled());

    scene.onPointerObservable.add((evt) => {
      if (evt.type === PointerEventTypes.POINTERDOWN) {
        this.onPointerDown(scene);
      } else if (evt.type === PointerEventTypes.POINTERUP) {
        this.onPointerUp(scene);
      }
    });

    this.zone.runOutsideAngular(() => {
      engine.runRenderLoop(() => {
        scene.render();
      });
    });

    this.resizeObserver = new ResizeObserver(() => {
      engine.resize();
    });
    this.resizeObserver.observe(canvas);
  }

  dispose(): void {
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
    this.dragging = false;
    this.evaluating = false;
    this.settledHandled = false;
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
  }

  private createBag(scene: Scene): void {
    const s = CORNHOLE.bag.sizeM;
    const bag = MeshBuilder.CreateBox('bag', { width: s * 0.85, height: s * 0.35, depth: s }, scene);
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
        mass: CORNHOLE.bag.mass,
        friction: 0.85,
        restitution: 0.05,
      },
      scene,
    );
  }

  private resetBagPosition(): void {
    if (!this.bag) {
      return;
    }
    const { x, y, z } = CORNHOLE.throwLine;
    this.bag.position.set(x, y, z);
    this.bag.rotationQuaternion = null;
    this.bag.rotation.set(0, 0, 0);
    const imp = this.bag.physicsImpostor;
    if (imp) {
      imp.setMass(CORNHOLE.bag.mass);
      imp.setLinearVelocity(Vector3.Zero());
      imp.setAngularVelocity(Vector3.Zero());
      imp.sleep();
    }
    this.settledHandled = false;
    this.evaluating = false;
  }

  private onPointerDown(scene: Scene): void {
    const gs = this.gameState.snapshot;
    if (!gs.canThrow || gs.throwsRemaining <= 0) {
      return;
    }
    const pick = scene.pick(scene.pointerX, scene.pointerY, (m) => m.name === 'ground');
    if (!pick?.hit || !pick.pickedPoint) {
      return;
    }
    this.dragStart = pick.pickedPoint.clone();
    this.dragging = true;
    this.zone.run(() => this.gameState.beginThrow());
  }

  private onPointerUp(scene: Scene): void {
    if (!this.dragging || !this.bag?.physicsImpostor) {
      this.dragging = false;
      return;
    }
    this.dragging = false;

    const pick = scene.pick(
      scene.pointerX,
      scene.pointerY,
      (m) => m.name === 'ground',
    );

    if (!pick?.hit || !pick.pickedPoint) {
      this.zone.run(() => this.gameState.cancelThrow());
      return;
    }

    const target = pick.pickedPoint;
    const bagPos = this.bag.absolutePosition.clone();
    const dir = target.subtract(bagPos);
    dir.y = 0;
    if (dir.lengthSquared() < 1e-6) {
      this.zone.run(() => this.gameState.cancelThrow());
      return;
    }
    dir.normalize();

    const pull = Vector3.Distance(this.dragStart, target);
    const power = Math.min(18, 6 + pull * 0.08);

    const impulse = dir.scale(power).add(new Vector3(0, power * 0.35, 0));
    this.bag.physicsImpostor.wakeUp();
    this.bag.physicsImpostor.applyImpulse(impulse, this.bag.getAbsolutePosition());

    this.evaluating = true;
    this.settledHandled = false;
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
    const speed = v.length() + (av?.length() ?? 0) * 0.15;
    if (speed > 0.12) {
      return;
    }

    const p = this.bag.absolutePosition;
    const result = this.classifyThrow(p);
    this.settledHandled = true;
    this.evaluating = false;

    this.zone.run(() => {
      this.gameState.recordSettledResult(result);
      this.resetBagPosition();
    });
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

    const nearGround = p.y < CORNHOLE.bag.sizeM * 0.4;
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
