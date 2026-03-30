import { Injectable, NgZone, inject } from '@angular/core';
import '@babylonjs/core/Physics/joinedPhysicsEngineComponent';
import '@babylonjs/core/Culling/ray';
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { Vector3, Matrix, Quaternion } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Plane } from '@babylonjs/core/Maths/math.plane';
import { Viewport } from '@babylonjs/core/Maths/math.viewport';
import { Camera } from '@babylonjs/core/Cameras/camera';
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { CSG } from '@babylonjs/core/Meshes/csg';
import { CreateSegmentedBoxVertexData } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import type { ICanvasRenderingContext } from '@babylonjs/core/Engines/ICanvas';
import { PhysicsImpostor } from '@babylonjs/core/Physics/v1/physicsImpostor';
import { AmmoJSPlugin } from '@babylonjs/core/Physics/v1/Plugins/ammoJSPlugin';
import { CORNHOLE, throwLineY } from './cornhole-constants';
import { GameStateService, ThrowResult } from './game-state.service';

const HOLE_WORLD = {
  x: 0,
  z: CORNHOLE.boardWorld.z + CORNHOLE.board.holeCenterZLocal,
};

const GROUND_PLANE = Plane.FromPositionAndNormal(new Vector3(0, 0, 0), new Vector3(0, 1, 0));

const DEFAULT_CAM_POS = new Vector3(0, 1.2, -0.6);
const DEFAULT_CAM_TARGET = new Vector3(0, 0.3, 8.23);
const DEFAULT_CAM_FOV = 1.0;
const FLIGHT_CAM_FOV = 1.1;
const AIM_CAM_FOV = 0.95;
const FLIGHT_FOLLOW_OFFSET = new Vector3(0, 1.5, -3.0);

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
  private miniMapCamera: UniversalCamera | null = null;
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

  private flipFrom = Quaternion.Identity();
  private flipTo = Quaternion.Identity();
  private flipStartMs = 0;
  private readonly FLIP_DURATION_MS = 350;

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
    camera.viewport = new Viewport(0, 0, 1, 1);
    this.camera = camera;

    const miniMap = new UniversalCamera('miniMapCam',
      new Vector3(CORNHOLE.boardWorld.x, 4, CORNHOLE.boardWorld.z), scene);
    miniMap.setTarget(new Vector3(CORNHOLE.boardWorld.x, 0, CORNHOLE.boardWorld.z));
    miniMap.upVector = new Vector3(0, 0, 1);
    miniMap.mode = Camera.ORTHOGRAPHIC_CAMERA;
    miniMap.minZ = 0.1;
    miniMap.viewport = new Viewport(0.79, 0.31, 0.195, 0.675);
    this.miniMapCamera = miniMap;
    this.updateMiniMapOrthoBounds();

    scene.activeCameras = [camera, miniMap];

    scene.clearColor = new Color4(0.53, 0.77, 0.97, 1.0);

    const light = new HemisphericLight('hemi', new Vector3(0.2, 1, 0.3), scene);
    light.intensity = 0.95;
    light.groundColor = new Color3(0.35, 0.35, 0.4);

    this.createSky(scene);
    this.createGround(scene);
    this.createTreeline(scene);
    this.createBoard(scene);
    this.buildBagMesh(scene);

    scene.onAfterPhysicsObservable.add(() => {
      this.enforceCollisions();
      this.preserveFlightSpin();
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
        this.tickFlipAnimation();
        scene.render();
      });
    });

    this.resizeObserver = new ResizeObserver(() => {
      engine.resize();
      this.updateMiniMapOrthoBounds();
    });
    this.resizeObserver.observe(canvas);
    engine.resize();
    requestAnimationFrame(() => { engine.resize(); this.updateMiniMapOrthoBounds(); });
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
    this.miniMapCamera = null;
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

  private createSky(scene: Scene): void {
    const dome = MeshBuilder.CreateSphere('skyDome', { diameter: 120, segments: 16 }, scene);
    dome.isPickable = false;

    const skyMat = new StandardMaterial('skyMat', scene);
    const skyTex = new DynamicTexture('skyTex', { width: 512, height: 512 }, scene, true);
    const ctx = skyTex.getContext();
    const grad = ctx.createLinearGradient(0, 0, 0, 512);
    grad.addColorStop(0, '#3a8ad8');
    grad.addColorStop(0.45, '#7ec8f0');
    grad.addColorStop(0.7, '#a8dcf5');
    grad.addColorStop(1.0, '#d4ecfa');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 512, 512);
    skyTex.update();

    skyMat.diffuseTexture = skyTex;
    skyMat.emissiveTexture = skyTex;
    skyMat.disableLighting = true;
    skyMat.backFaceCulling = false;
    skyMat.specularColor = Color3.Black();
    dome.material = skyMat;

    this.createClouds(scene);
  }

  private createClouds(scene: Scene): void {
    const cloudTex = this.createCloudTexture(scene);

    const placements: { x: number; y: number; z: number; w: number; h: number }[] = [
      { x: -6,  y: 5.5, z: 25, w: 12, h: 3.5 },
      { x:  8,  y: 7.0, z: 35, w: 16, h: 4.5 },
      { x: -14, y: 8.0, z: 40, w: 18, h: 5.0 },
      { x:  3,  y: 4.5, z: 18, w:  9, h: 3.0 },
      { x: -2,  y: 6.5, z: 45, w: 14, h: 4.0 },
      { x: 16,  y: 6.0, z: 30, w: 11, h: 3.5 },
      { x: -10, y: 7.5, z: 32, w: 10, h: 3.0 },
    ];

    for (let i = 0; i < placements.length; i++) {
      const p = placements[i];
      const cloud = MeshBuilder.CreatePlane(`cloud${i}`, { width: p.w, height: p.h }, scene);
      cloud.position.set(p.x, p.y, p.z);
      cloud.billboardMode = Mesh.BILLBOARDMODE_ALL;
      cloud.isPickable = false;

      const mat = new StandardMaterial(`cloudMat${i}`, scene);
      mat.diffuseTexture = cloudTex;
      mat.opacityTexture = cloudTex;
      mat.emissiveColor = new Color3(0.97, 0.97, 1.0);
      mat.diffuseColor = new Color3(1, 1, 1);
      mat.disableLighting = true;
      mat.backFaceCulling = false;
      mat.specularColor = Color3.Black();
      cloud.material = mat;
    }
  }

  private createCloudTexture(scene: Scene): DynamicTexture {
    const size = 1024;
    const tex = new DynamicTexture('cloudTex', { width: size, height: size }, scene, false);
    const ctx = tex.getContext();

    ctx.clearRect(0, 0, size, size);

    const puffs: { cx: number; cy: number; r: number }[] = [
      { cx: 512, cy: 540, r: 180 },
      { cx: 340, cy: 520, r: 150 },
      { cx: 680, cy: 520, r: 155 },
      { cx: 230, cy: 545, r: 120 },
      { cx: 790, cy: 540, r: 125 },
      { cx: 420, cy: 470, r: 140 },
      { cx: 620, cy: 465, r: 145 },
      { cx: 512, cy: 480, r: 170 },
      { cx: 300, cy: 490, r: 110 },
      { cx: 720, cy: 490, r: 115 },
      { cx: 512, cy: 510, r: 160 },
    ];

    for (const puff of puffs) {
      const g = ctx.createRadialGradient(puff.cx, puff.cy, 0, puff.cx, puff.cy, puff.r);
      g.addColorStop(0, 'rgba(255,255,255,1.0)');
      g.addColorStop(0.55, 'rgba(255,255,255,0.95)');
      g.addColorStop(0.75, 'rgba(252,252,255,0.7)');
      g.addColorStop(0.88, 'rgba(248,248,252,0.25)');
      g.addColorStop(1, 'rgba(245,245,250,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(puff.cx, puff.cy, puff.r, 0, Math.PI * 2);
      ctx.fill();
    }

    tex.update();
    tex.hasAlpha = true;
    return tex;
  }

  /* ── Treeline ─────────────────────────────────────────────────── */

  private createTreeline(scene: Scene): void {
    const treeTex = this.createTreeTexture(scene);

    const backdrop = MeshBuilder.CreatePlane('treeline', { width: 50, height: 6 }, scene);
    backdrop.position.set(0, 3, 19);
    backdrop.isPickable = false;
    const bdMat = new StandardMaterial('treelineMat', scene);
    bdMat.diffuseTexture = treeTex;
    bdMat.opacityTexture = treeTex;
    bdMat.emissiveColor = new Color3(0.35, 0.55, 0.25);
    bdMat.diffuseColor = new Color3(0.4, 0.6, 0.3);
    bdMat.specularColor = Color3.Black();
    bdMat.backFaceCulling = false;
    backdrop.material = bdMat;
  }

  private createTreeTexture(scene: Scene): DynamicTexture {
    const w = 2048, h = 512;
    const tex = new DynamicTexture('treelineTex', { width: w, height: h }, scene, true);
    const ctx = tex.getContext();
    ctx.clearRect(0, 0, w, h);

    const treeCount = 55;
    for (let i = 0; i < treeCount; i++) {
      const cx = (i / treeCount) * w + (Math.random() - 0.5) * (w / treeCount) * 0.8;
      const treeH = 220 + Math.random() * 220;
      const treeW = 70 + Math.random() * 90;
      const baseY = h;
      const shade = 0.7 + Math.random() * 0.3;

      const trunkW = 6 + Math.random() * 5;
      const trunkH = treeH * 0.4;
      ctx.fillStyle = `rgb(${Math.floor(65 * shade)},${Math.floor(45 * shade)},${Math.floor(20 * shade)})`;
      ctx.fillRect(cx - trunkW / 2, baseY - trunkH, trunkW, trunkH);

      this.drawCanopyCluster(ctx, cx, baseY - treeH * 0.4, treeW, treeH * 0.7, shade);
    }

    tex.update();
    tex.hasAlpha = true;
    return tex;
  }

  private drawCanopyCluster(
    ctx: CanvasRenderingContext2D | ICanvasRenderingContext,
    cx: number, cy: number, width: number, height: number, shade: number,
  ): void {
    const baseR = Math.floor(30 * shade);
    const baseG = Math.floor(75 * shade);
    const baseB = Math.floor(22 * shade);

    const bulges: { ox: number; oy: number; rx: number; ry: number }[] = [];
    for (let i = 0; i < 8; i++) {
      bulges.push({
        ox: (Math.random() - 0.5) * width * 0.6,
        oy: (Math.random() - 0.5) * height * 0.5,
        rx: width * (0.2 + Math.random() * 0.15),
        ry: height * (0.18 + Math.random() * 0.12),
      });
    }

    ctx.fillStyle = `rgb(${baseR},${baseG},${baseB})`;
    for (const bl of bulges) {
      ctx.beginPath();
      ctx.arc(cx + bl.ox, cy + bl.oy, Math.min(bl.rx, bl.ry), 0, Math.PI * 2);
      ctx.fill();
    }

    const leafCount = Math.floor(width * height * 0.012);
    for (let i = 0; i < leafCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.random();
      const lx = cx + Math.cos(angle) * dist * width * 0.42;
      const ly = cy + Math.sin(angle) * dist * height * 0.42;

      let inside = false;
      for (const bl of bulges) {
        const dx = (lx - (cx + bl.ox)) / bl.rx;
        const dy = (ly - (cy + bl.oy)) / bl.ry;
        if (dx * dx + dy * dy < 1.1) { inside = true; break; }
      }
      if (!inside) continue;

      const ls = 0.6 + Math.random() * 0.7;
      const isLight = ly < cy;
      const lr = Math.floor((isLight ? 45 : 25) * ls);
      const lg = Math.floor((isLight ? 105 : 65) * ls);
      const lb = Math.floor((isLight ? 28 : 15) * ls);
      const lr2 = 2 + Math.random() * 4;

      ctx.fillStyle = `rgb(${lr},${lg},${lb})`;
      ctx.fillRect(lx - lr2, ly - lr2, lr2 * 2, lr2 * 2);
    }

    ctx.fillStyle = `rgba(${baseR + 30},${baseG + 40},${baseB + 15},0.6)`;
    for (const bl of bulges) {
      const hlx = cx + bl.ox - bl.rx * 0.2;
      const hly = cy + bl.oy - bl.ry * 0.3;
      const hlr = Math.min(bl.rx, bl.ry) * 0.4;
      ctx.beginPath();
      ctx.arc(hlx, hly, hlr, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private createGround(scene: Scene): void {
    const tileCount = 8;
    const g = MeshBuilder.CreateGround('ground',
      { width: CORNHOLE.ground.sizeM, height: CORNHOLE.ground.sizeM }, scene);
    g.position.y = 0;

    const uvs = g.getVerticesData(VertexBuffer.UVKind);
    if (uvs) {
      for (let i = 0; i < uvs.length; i++) uvs[i] *= tileCount;
      g.updateVerticesData(VertexBuffer.UVKind, uvs);
    }

    const mat = new StandardMaterial('groundMat', scene);
    const grassTex = this.createGrassTexture(scene);
    grassTex.wrapU = Texture.WRAP_ADDRESSMODE;
    grassTex.wrapV = Texture.WRAP_ADDRESSMODE;
    mat.diffuseTexture = grassTex;
    mat.specularColor = new Color3(0.05, 0.05, 0.02);
    g.material = mat;
    g.physicsImpostor = new PhysicsImpostor(g, PhysicsImpostor.BoxImpostor,
      { mass: 0, friction: 0.9, restitution: 0.05 }, scene);
  }

  private createGrassTexture(scene: Scene): DynamicTexture {
    const size = 512;
    const tex = new DynamicTexture('grassTex', { width: size, height: size }, scene, true);
    const ctx = tex.getContext();

    ctx.fillStyle = '#4a9935';
    ctx.fillRect(0, 0, size, size);

    for (let y = 0; y < size; y += 2) {
      const shade = 0.85 + Math.random() * 0.3;
      const r = Math.floor(65 * shade);
      const gv = Math.floor(140 * shade);
      const b = Math.floor(45 * shade);
      ctx.fillStyle = `rgb(${r},${gv},${b})`;
      ctx.fillRect(0, y, size, 2);
    }

    for (let i = 0; i < 12000; i++) {
      const bx = Math.random() * size;
      const by = Math.random() * size;
      const bladeH = 6 + Math.random() * 14;
      const lean = (Math.random() - 0.5) * 4;
      const shade = 0.6 + Math.random() * 0.6;
      const r = Math.floor(40 * shade);
      const gv = Math.floor(155 * shade);
      const b = Math.floor(30 * shade);
      ctx.strokeStyle = `rgba(${r},${gv},${b},${0.6 + Math.random() * 0.4})`;
      ctx.lineWidth = 1.0 + Math.random() * 1.2;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx + lean, by - bladeH);
      ctx.stroke();
    }

    for (let i = 0; i < 50; i++) {
      const px = Math.random() * size;
      const py = Math.random() * size;
      const patchR = 20 + Math.random() * 40;
      const dark = Math.random() > 0.5;
      ctx.fillStyle = dark
        ? `rgba(25,75,15,${0.15 + Math.random() * 0.15})`
        : `rgba(90,175,55,${0.12 + Math.random() * 0.12})`;
      ctx.beginPath();
      ctx.arc(px, py, patchR, 0, Math.PI * 2);
      ctx.fill();
    }

    tex.update();
    return tex;
  }

  private createBoard(scene: Scene): void {
    const { widthM, lengthM, thicknessM, holeCenterZLocal, holeRadiusM } = CORNHOLE.board;
    const { x: bx, y: by, z: bz } = CORNHOLE.boardWorld;
    const tilt = CORNHOLE.boardTiltRad;
    const halfL = lengthM / 2;
    const halfW = widthM / 2;

    const boardNode = new TransformNode('boardNode', scene);
    boardNode.position.set(bx, by, bz);
    boardNode.rotation.x = -tilt;

    const deckBox = MeshBuilder.CreateBox('deckBox',
      { width: widthM, height: thicknessM, depth: lengthM }, scene);

    const holeCyl = MeshBuilder.CreateCylinder('holeCyl', {
      diameter: holeRadiusM * 2,
      height: thicknessM + 0.02,
      tessellation: 32,
    }, scene);
    holeCyl.position.set(0, 0, holeCenterZLocal);

    const deckCSG = CSG.FromMesh(deckBox);
    const holeCSG = CSG.FromMesh(holeCyl);
    const resultCSG = deckCSG.subtract(holeCSG);
    deckBox.dispose();
    holeCyl.dispose();

    const deck = resultCSG.toMesh('deck', null, scene, false);
    const wood = new StandardMaterial('wood', scene);
    wood.diffuseTexture = this.createWoodGrainTexture(scene);
    wood.specularColor = new Color3(0.12, 0.10, 0.06);
    deck.material = wood;
    deck.parent = boardNode;

    const rim = MeshBuilder.CreateTorus('holeRim', {
      diameter: holeRadiusM * 2,
      thickness: 0.006,
      tessellation: 32,
    }, scene);
    rim.position.set(0, thicknessM / 2, holeCenterZLocal);
    const rimMat = new StandardMaterial('rimMat', scene);
    rimMat.diffuseColor = new Color3(0.6, 0.45, 0.3);
    rimMat.specularColor = Color3.Black();
    rim.material = rimMat;
    rim.parent = boardNode;

    const R = holeRadiusM;
    const logoLocalZ = (-halfL + holeCenterZLocal) / 2;
    const logoSize = 0.45;
    const logo = MeshBuilder.CreatePlane('logo', { width: logoSize, height: logoSize }, scene);
    logo.position.set(0, thicknessM / 2 + 0.001, logoLocalZ);
    logo.rotation.x = Math.PI / 2;
    const logoMat = new StandardMaterial('logoMat', scene);
    logoMat.diffuseTexture = new Texture('irish-rose-logo.png', scene);
    logoMat.diffuseTexture.hasAlpha = true;
    logoMat.useAlphaFromDiffuseTexture = true;
    logoMat.specularColor = Color3.Black();
    logoMat.backFaceCulling = false;
    logo.material = logoMat;
    logo.parent = boardNode;

    this.addDeckSurfaceColliders(scene, bx, by, bz, halfW, halfL, holeCenterZLocal, R);

    const sinT = Math.sin(tilt);
    const cosT = Math.cos(tilt);
    const backBottomY = by + halfL * sinT - (thicknessM / 2) * cosT;
    const backZ = bz + halfL * cosT + (thicknessM / 2) * sinT;
    const legW = 0.04;
    const legInset = 0.05;
    const legMat = new StandardMaterial('legMat', scene);
    legMat.diffuseColor = new Color3(0.55, 0.38, 0.2);
    legMat.specularColor = Color3.Black();

    const legXs = [
      bx - halfW + legInset + legW / 2,
      bx + halfW - legInset - legW / 2,
    ];
    for (let i = 0; i < legXs.length; i++) {
      const leg = MeshBuilder.CreateBox(`leg${i}`, { width: legW, height: backBottomY, depth: legW }, scene);
      leg.position.set(legXs[i], backBottomY / 2, backZ - legInset);
      leg.material = legMat;
      leg.isPickable = false;
    }
  }

  private createWoodGrainTexture(scene: Scene): DynamicTexture {
    const size = 512;
    const tex = new DynamicTexture('woodGrain', { width: size, height: size }, scene, true);
    const ctx = tex.getContext();

    ctx.fillStyle = '#d2b48c';
    ctx.fillRect(0, 0, size, size);

    for (let y = 0; y < size; y++) {
      const wave = Math.sin(y * 0.04) * 8 + Math.sin(y * 0.11) * 4;
      const base = 190 + wave;
      const r = Math.min(255, base + (Math.random() * 14 - 7));
      const g = Math.min(255, base - 20 + (Math.random() * 10 - 5));
      const b = Math.min(255, base - 55 + (Math.random() * 8 - 4));
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(0, y, size, 1);
    }

    for (let i = 0; i < 40; i++) {
      const y = Math.random() * size;
      const h = 1 + Math.random() * 4;
      ctx.fillStyle = `rgba(140,105,65,${0.12 + Math.random() * 0.18})`;
      ctx.fillRect(0, y, size, h);
    }

    for (let i = 0; i < 8; i++) {
      const y = Math.random() * size;
      ctx.strokeStyle = `rgba(120,90,50,${0.08 + Math.random() * 0.1})`;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      for (let x = 0; x < size; x += 4) {
        ctx.lineTo(x, y + Math.sin(x * 0.02 + i) * 3);
      }
      ctx.stroke();
    }

    tex.update();
    return tex;
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
    const bag = new Mesh('bag', scene);
    CreateSegmentedBoxVertexData({
      width: widthM,
      height: thicknessM,
      depth: depthM,
      segments: 10,
    }).applyToMesh(bag, true);

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

    const uvs = bag.getVerticesData(VertexBuffer.UVKind);
    const pos = bag.getVerticesData(VertexBuffer.PositionKind);
    if (uvs && pos) {
      const halfW = widthM / 2;
      const halfD = depthM / 2;
      const vertCount = uvs.length / 2;
      for (let vi = 0; vi < vertCount; vi++) {
        const u = Math.max(0, Math.min(1, (pos[vi * 3] + halfW) / widthM));
        const vLocal = Math.max(0, Math.min(1, (pos[vi * 3 + 2] + halfD) / depthM));
        uvs[vi * 2] = u;
        uvs[vi * 2 + 1] = pos[vi * 3 + 1] >= 0 ? 0.5 + vLocal * 0.5 : vLocal * 0.5;
      }
      bag.updateVerticesData(VertexBuffer.UVKind, uvs);
    }

    const mat = new StandardMaterial('bagMat', scene);
    mat.diffuseTexture = this.createBagTexture(scene);
    mat.specularColor = Color3.Black();
    bag.material = mat;

    const { x, z } = CORNHOLE.throwLine;
    bag.position.set(x, throwLineY(), z);
    bag.rotationQuaternion = this.gameState.bagSide === 'fast'
      ? Quaternion.FromEulerAngles(0, 0, Math.PI)
      : Quaternion.Identity();
    this.bag = bag;
  }

  flipBagToSide(): void {
    if (!this.bag || this.bag.physicsImpostor || this.evaluating || this.dragging) return;
    const target = this.gameState.bagSide === 'fast'
      ? Quaternion.FromEulerAngles(0, 0, Math.PI)
      : Quaternion.Identity();
    this.flipFrom = (this.bag.rotationQuaternion ?? Quaternion.Identity()).clone();
    this.flipTo = target;
    this.flipStartMs = performance.now();
  }

  private tickFlipAnimation(): void {
    if (!this.flipStartMs || !this.bag || this.bag.physicsImpostor) return;
    const t = Math.min(1, (performance.now() - this.flipStartMs) / this.FLIP_DURATION_MS);
    const eased = t * t * (3 - 2 * t);
    Quaternion.SlerpToRef(this.flipFrom, this.flipTo, eased, this.bag.rotationQuaternion!);
    if (t >= 1) this.flipStartMs = 0;
  }

  private createBagTexture(scene: Scene): DynamicTexture {
    const face = 512;
    const texH = face * 2;
    const tex = new DynamicTexture('bagTex', { width: face, height: texH }, scene, true);
    const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;

    // ── Logo face (top face of bag → canvas y: 0 → face) ──
    ctx.fillStyle = '#0f1b3d';
    ctx.fillRect(0, 0, face, face);

    const splashes: { cx: number; cy: number; r: number; rgb: number[] }[] = [
      { cx: face * 0.72, cy: face * 0.22, r: face * 0.42, rgb: [0, 200, 185] },
      { cx: face * 0.55, cy: face * 0.12, r: face * 0.28, rgb: [20, 225, 205] },
      { cx: face * 0.85, cy: face * 0.45, r: face * 0.20, rgb: [0, 175, 160] },
      { cx: face * 0.25, cy: face * 0.78, r: face * 0.42, rgb: [220, 45, 120] },
      { cx: face * 0.42, cy: face * 0.88, r: face * 0.30, rgb: [235, 60, 140] },
      { cx: face * 0.12, cy: face * 0.58, r: face * 0.22, rgb: [200, 35, 100] },
      { cx: face * 0.50, cy: face * 0.50, r: face * 0.15, rgb: [255, 220, 50] },
    ];
    for (const s of splashes) {
      const grad = ctx.createRadialGradient(s.cx, s.cy, 0, s.cx, s.cy, s.r);
      const [r, g, b] = s.rgb;
      grad.addColorStop(0, `rgba(${r},${g},${b},0.85)`);
      grad.addColorStop(0.35, `rgba(${r},${g},${b},0.6)`);
      grad.addColorStop(0.65, `rgba(${r},${g},${b},0.25)`);
      grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, face, face);
    }

    for (let i = 0; i < 25; i++) {
      const sx = Math.random() * face;
      const sy = Math.random() * face;
      const sr = 4 + Math.random() * 18;
      const colors = [[0, 200, 185], [220, 45, 120], [255, 220, 50]];
      const c = colors[Math.floor(Math.random() * colors.length)];
      ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${0.12 + Math.random() * 0.25})`;
      ctx.beginPath();
      ctx.arc(sx, sy, sr, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    this.drawStar(ctx, face * 0.22, face * 0.25, 28, 12, 5);
    ctx.fill();

    const mainFont = Math.floor(face * 0.52);
    ctx.font = `bold ${mainFont}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillText('3D', face / 2 + 4, face / 2 + 4);
    ctx.fillStyle = '#ffffff';
    ctx.fillText('3D', face / 2, face / 2);

    const subFont = Math.floor(face * 0.08);
    ctx.font = `bold ${subFont}px sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText('CORNHOLE', face / 2, face * 0.82);

    for (let i = 0; i < 4000; i++) {
      const fx = Math.random() * face;
      const fy = Math.random() * face;
      const a = 0.02 + Math.random() * 0.04;
      ctx.fillStyle = Math.random() > 0.5
        ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`;
      ctx.fillRect(fx, fy, 1, 1);
    }

    const inset = 14;
    ctx.fillStyle = 'rgba(200,200,200,0.3)';
    this.drawStitchRect(ctx, inset, inset, face - inset * 2, face - inset * 2, 8, 5);

    // ── White / cream face (bottom face of bag → canvas y: face → texH) ──
    ctx.fillStyle = '#f0ebe3';
    ctx.fillRect(0, face, face, face);

    for (let i = 0; i < 8000; i++) {
      const fx = Math.random() * face;
      const fy = face + Math.random() * face;
      const n = Math.random() * 14 - 7;
      ctx.fillStyle = `rgba(${Math.floor(240 + n)},${Math.floor(235 + n)},${Math.floor(227 + n)},0.35)`;
      ctx.fillRect(fx, fy, 2, 2);
    }

    ctx.strokeStyle = 'rgba(200,195,185,0.12)';
    ctx.lineWidth = 0.5;
    for (let gx = 0; gx < face; gx += 8) {
      ctx.beginPath(); ctx.moveTo(gx, face); ctx.lineTo(gx, texH); ctx.stroke();
    }
    for (let gy = face; gy < texH; gy += 8) {
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(face, gy); ctx.stroke();
    }

    ctx.fillStyle = 'rgba(180,170,155,0.4)';
    this.drawStitchRect(ctx, inset, face + inset, face - inset * 2, face - inset * 2, 8, 5);

    tex.update();
    return tex;
  }

  private drawStar(
    ctx: CanvasRenderingContext2D | ICanvasRenderingContext,
    cx: number, cy: number, outerR: number, innerR: number, points: number,
  ): void {
    ctx.beginPath();
    for (let i = 0; i < points * 2; i++) {
      const angle = (i * Math.PI) / points - Math.PI / 2;
      const r = i % 2 === 0 ? outerR : innerR;
      const px = cx + r * Math.cos(angle);
      const py = cy + r * Math.sin(angle);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  private drawStitchRect(
    ctx: CanvasRenderingContext2D | ICanvasRenderingContext,
    x: number, y: number, w: number, h: number,
    dashLen: number, gapLen: number,
  ): void {
    const step = dashLen + gapLen;
    for (let dx = 0; dx < w; dx += step) {
      ctx.fillRect(x + dx, y, Math.min(dashLen, w - dx), 2);
      ctx.fillRect(x + dx, y + h - 2, Math.min(dashLen, w - dx), 2);
    }
    for (let dy = 0; dy < h; dy += step) {
      ctx.fillRect(x, y + dy, 2, Math.min(dashLen, h - dy));
      ctx.fillRect(x + w - 2, y + dy, 2, Math.min(dashLen, h - dy));
    }
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
        pressure: 6,
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
      cfg.set_kKHR(1.0);
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
      const lz = p.z - CORNHOLE.boardWorld.z;
      const surfY = CORNHOLE.boardWorld.y + lz * Math.sin(CORNHOLE.boardTiltRad)
        + (CORNHOLE.board.thicknessM / 2) * Math.cos(CORNHOLE.boardTiltRad);
      const onBoard = p.y > surfY - 0.06 && p.y < surfY + 0.2;
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

  /**
   * Undo the effect of kDP damping on the rotational (spin) component of
   * node velocities while the bag is in free flight.  Linear (COM) velocity
   * stays damped so the trajectory is unchanged from the original tuning.
   */
  private preserveFlightSpin(): void {
    if (!this.evaluating || this.firstContactMs !== 0) return;
    const nodes = this.softNodes();
    if (!nodes) return;
    const count = nodes.size();
    if (count === 0) return;

    let svx = 0, svy = 0, svz = 0;
    for (let i = 0; i < count; i++) {
      const vel = nodes.at(i).get_m_v();
      svx += vel.x(); svy += vel.y(); svz += vel.z();
    }
    const inv = 1 / count;
    const comVx = svx * inv, comVy = svy * inv, comVz = svz * inv;

    const undamp = 1 / (1 - 0.05);
    for (let i = 0; i < count; i++) {
      const vel = nodes.at(i).get_m_v();
      vel.setX(comVx + (vel.x() - comVx) * undamp);
      vel.setY(comVy + (vel.y() - comVy) * undamp);
      vel.setZ(comVz + (vel.z() - comVz) * undamp);
    }
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
    const clampedX = bagPos.x * 0.15;
    this.scratchDesiredCam.set(
      clampedX + FLIGHT_FOLLOW_OFFSET.x,
      bagPos.y + FLIGHT_FOLLOW_OFFSET.y + arcBoost,
      bagPos.z + FLIGHT_FOLLOW_OFFSET.z,
    );
    this.scratchFocus.set(clampedX, bagPos.y + 0.04, bagPos.z);
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

  private updateMiniMapOrthoBounds(): void {
    if (!this.miniMapCamera || !this.engine) return;
    const vp = this.miniMapCamera.viewport;
    const canvasW = this.engine.getRenderWidth();
    const canvasH = this.engine.getRenderHeight();
    const vpPixelW = vp.width * canvasW;
    const vpPixelH = vp.height * canvasH;
    const vpAspect = vpPixelW / vpPixelH;

    const boardHalfW = CORNHOLE.board.widthM / 2 + 0.10;
    const boardHalfL = CORNHOLE.board.lengthM / 2 + 0.10;

    if (vpAspect > boardHalfW / boardHalfL) {
      this.miniMapCamera.orthoTop = boardHalfL;
      this.miniMapCamera.orthoBottom = -boardHalfL;
      this.miniMapCamera.orthoLeft = -boardHalfL * vpAspect;
      this.miniMapCamera.orthoRight = boardHalfL * vpAspect;
    } else {
      this.miniMapCamera.orthoLeft = -boardHalfW;
      this.miniMapCamera.orthoRight = boardHalfW;
      this.miniMapCamera.orthoTop = boardHalfW / vpAspect;
      this.miniMapCamera.orthoBottom = -boardHalfW / vpAspect;
    }
  }

  /* ================================================================
   *  Input
   * ================================================================ */

  private aimPointOnGround(scene: Scene, canvasX: number, canvasY: number): Vector3 | null {
    if (!this.camera) return null;
    const ray = scene.createPickingRay(canvasX, canvasY, Matrix.Identity(), this.camera);
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
    const horizSpeed = 16.0 + pullT * 9.0;
    const upSpeed = 5.5 + pullT * 3.0;
    const deltaV = dir.scale(horizSpeed).add(new Vector3(0, upSpeed, 0));

    const RPM = 600;
    const spinY = -(RPM * (2 * Math.PI) / 60);
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

    const by = CORNHOLE.boardWorld.y;
    const bx = CORNHOLE.boardWorld.x;
    const bzAmmo = -CORNHOLE.boardWorld.z;
    const halfW = CORNHOLE.board.widthM / 2;
    const halfL = CORNHOLE.board.lengthM / 2;
    const halfT = CORNHOLE.board.thicknessM / 2;
    const sinT = Math.sin(CORNHOLE.boardTiltRad);
    const cosT = Math.cos(CORNHOLE.boardTiltRad);
    const holeZAmmo = -(CORNHOLE.boardWorld.z + CORNHOLE.board.holeCenterZLocal);
    const holeR2 = CORNHOLE.board.holeRadiusM * CORNHOLE.board.holeRadiusM;
    const SLIDE_DAMP = 0.55;
    const STATIC_FRICTION_SPEED = 0.5;
    const POST_CONTACT_MAX_UP_VEL = 0.4;
    const BAG_BOUNCE_MAX_VEL = 1.73;
    let touched = false;

    for (let i = 0; i < count; i++) {
      const node = nodes.at(i);
      const pos = node.get_m_x();
      const vel = node.get_m_v();
      const px = pos.x(), py = pos.y(), pz = pos.z();

      if (py < 0) {
        pos.setY(0);
        vel.setY(0);
        this.applyFriction(vel, SLIDE_DAMP, STATIC_FRICTION_SPEED);
        touched = true;
      }

      const dx = px - bx;
      const dz = pz - bzAmmo;
      const localZ = -dz;
      const surfY = by + localZ * sinT + halfT * cosT;
      if (Math.abs(dx) <= halfW && Math.abs(dz) <= halfL && py < surfY && py > surfY - 0.35) {
        const hx = px - bx;
        const hz = pz - holeZAmmo;
        if (hx * hx + hz * hz > holeR2) {
          pos.setY(surfY);
          vel.setY(0);
          this.applyFriction(vel, SLIDE_DAMP, STATIC_FRICTION_SPEED);
          touched = true;
        }
      }
    }

    /* ── Settled-bag collision ──────────────────────────────────────── */
    for (const settled of this.settledBags) {
      settled.refreshBoundingInfo();
      const bb = settled.getBoundingInfo().boundingBox;
      const sMinX = bb.minimumWorld.x;
      const sMaxX = bb.maximumWorld.x;
      const sMinZ = -bb.maximumWorld.z;
      const sMaxZ = -bb.minimumWorld.z;
      const sTopY = bb.maximumWorld.y;

      for (let i = 0; i < count; i++) {
        const node = nodes.at(i);
        const pos = node.get_m_x();
        const vel = node.get_m_v();
        const px = pos.x(), py = pos.y(), pz = pos.z();

        if (px >= sMinX && px <= sMaxX && pz >= sMinZ && pz <= sMaxZ
            && py < sTopY && py > sTopY - 0.12) {
          pos.setY(sTopY);
          if (vel.y() < 0) vel.setY(0);
          if (vel.y() > BAG_BOUNCE_MAX_VEL) vel.setY(BAG_BOUNCE_MAX_VEL);
          this.applyFriction(vel, SLIDE_DAMP, STATIC_FRICTION_SPEED);
          touched = true;
        }
      }
    }

    /* ── Post-contact upward-velocity clamp ────────────────────────── */
    if (touched) {
      for (let i = 0; i < count; i++) {
        const vel = nodes.at(i).get_m_v();
        if (vel.y() > POST_CONTACT_MAX_UP_VEL) {
          vel.setY(POST_CONTACT_MAX_UP_VEL);
        }
      }
    }

    if (touched && this.firstContactMs === 0 && this.evaluating) {
      this.firstContactMs = performance.now();
      this.killBagSpin(nodes, count);
    }
  }

  /**
   * Remove the rotational velocity component from all soft-body nodes,
   * keeping only the post-friction COM velocity.  Called once on first
   * contact so preserved flight spin doesn't cause lateral drift.
   */
  private killBagSpin(nodes: AmmoNodeArray, count: number): void {
    let svx = 0, svy = 0, svz = 0;
    for (let i = 0; i < count; i++) {
      const vel = nodes.at(i).get_m_v();
      svx += vel.x(); svy += vel.y(); svz += vel.z();
    }
    const inv = 1 / count;
    const cvx = svx * inv, cvy = svy * inv, cvz = svz * inv;
    for (let i = 0; i < count; i++) {
      const vel = nodes.at(i).get_m_v();
      vel.setX(cvx);
      vel.setY(cvy);
      vel.setZ(cvz);
    }
  }

  /** Dynamic + static friction for a contacting soft-body node (XZ only). */
  private applyFriction(vel: AmmoBtVec3, slideDamp: number, staticSpeed: number): void {
    const vx = vel.x(), vz = vel.z();
    if (vx * vx + vz * vz < staticSpeed * staticSpeed) {
      vel.setX(0);
      vel.setZ(0);
    } else {
      vel.setX(vx * slideDamp);
      vel.setZ(vz * slideDamp);
    }
  }

  private classifyThrow(p: Vector3): ThrowResult {
    const { widthM, lengthM, thicknessM } = CORNHOLE.board;
    const { x: bx, y: by, z: bz } = CORNHOLE.boardWorld;
    const tilt = CORNHOLE.boardTiltRad;
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

    const surfY = by + lz * Math.sin(tilt) + (thicknessM / 2) * Math.cos(tilt);
    const onBoardY = p.y > surfY - 0.06 && p.y < surfY + 0.2;

    if (nearGround && inHoleRadius) return 'in_hole';
    if (onBoardY && onBoardXZ) return 'on_board';
    return 'miss';
  }
}
