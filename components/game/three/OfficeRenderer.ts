import { makeClouds } from "./exterior";
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { OfficeAssets } from "./assets";
import { buildEnvironment } from "./environment";
import { OfficeCharacter } from "./character";
import { worldPosition, type OfficeSource, type OfficeActor } from "./types";

/** Pure presentation adapter. The existing Phaser scene remains the only simulation clock. */
export class OfficeRenderer {
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private ao: GTAOPass;
  private output: OutputPass;
  private environmentMap: THREE.WebGLRenderTarget;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-15, 15, 11, -11, 0.1, 120);
  private controls: OrbitControls;
  private assets = new OfficeAssets();
  private environment: THREE.Group | null = null;
  private clouds: THREE.Group | null = null;
  private seatsKey = "";
  private doors = new Map<string, THREE.Group>();
  private actors = new Map<
    string,
    { model: OfficeCharacter; label: HTMLButtonElement; activity: HTMLSpanElement }
  >();
  private labels = document.createElement("div");
  private prompt = document.createElement("div");
  private menu = document.createElement("div");
  private menuSignature = "";
  private observer: ResizeObserver;
  private motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  private sun: THREE.DirectionalLight;
  private ambientLights: THREE.PointLight[] = [];
  private visible = true;
  private disposed = false;
  private width = 1;
  private height = 1;
  private frameSamples: number[] = [];
  private lastFrame = 0;
  private qualityTimer = 0;
  private qualityReduced = false;
  private pointerStart = { x: 0, y: 0 };
  private raycaster = new THREE.Raycaster();
  private point = new THREE.Vector3();
  private target: THREE.Vector3 | null = null;

  constructor(
    private host: HTMLElement,
    private source: OfficeSource,
    private onFailure: (message: string) => void,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    const studio = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.environmentMap = pmrem.fromScene(studio, 0.04);
    this.scene.environment = this.environmentMap.texture;
    this.scene.environmentIntensity = 0.32;
    studio.dispose();
    pmrem.dispose();
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.ao = new GTAOPass(this.scene, this.camera, 800, 600);
    this.ao.updateGtaoMaterial({ radius: 0.55, thickness: 1, samples: 8 });
    this.ao.blendIntensity = 0.75;
    this.composer.addPass(this.ao);
    this.output = new OutputPass();
    this.composer.addPass(this.output);
    this.renderer.setClearColor("#101719", 1);
    this.renderer.domElement.className = "office-three-canvas";
    this.renderer.domElement.setAttribute(
      "aria-label",
      "Interactive 3D office. Drag to orbit, scroll to zoom. Use WASD to move and E to interact.",
    );
    this.renderer.domElement.setAttribute("role", "img");
    this.renderer.domElement.tabIndex = 0;
    host.append(this.renderer.domElement);
    this.camera.position.set(1, 22, 25);
    this.camera.lookAt(0, 0, 0);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minZoom = 0.65;
    this.controls.maxZoom = 2.6;
    this.controls.minPolarAngle = 0.2;
    this.controls.maxPolarAngle = Math.PI * 0.43;
    this.controls.maxAzimuthAngle = 0.65;
    this.controls.minAzimuthAngle = -0.65;
    this.controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
    this.controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
    this.controls.addEventListener("start", this.cancelFocus);
    this.scene.add(new THREE.HemisphereLight("#d6e3ea", "#393b37", 0.8));
    this.sun = new THREE.DirectionalLight("#ffdfb1", 2.3);
    this.sun.position.set(-7, 14, 5);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.left = -17;
    this.sun.shadow.camera.right = 17;
    this.sun.shadow.camera.top = 14;
    this.sun.shadow.camera.bottom = -14;
    this.sun.shadow.normalBias = 0.08;
    this.sun.shadow.bias = -0.0002;
    this.scene.add(this.sun);
    const fill = new THREE.DirectionalLight("#b1d0d9", 0.65);
    fill.position.set(9, 10, -5);
    this.scene.add(fill);
    for (const [x, z] of [
      [-6, -5],
      [7, -6],
      [-3, 4],
      [7, 5],
    ]) {
      const light = new THREE.PointLight("#ffc17b", 45, 13, 2);
      light.position.set(x, 2.9, z);
      this.scene.add(light);
      this.ambientLights.push(light);
    }
    for (const [x, z] of [
      [-9, -6.8],
      [-4, -6.8],
      [0, -6.8],
      [4, -7.8],
      [10, -7.8],
      [-7, 2],
      [6, 2],
    ]) {
      const lamp = new THREE.SpotLight("#ffbe70", 65, 8, 0.8, 0.8, 2);
      lamp.position.set(x, 2.6, z);
      lamp.target.position.set(x, 0, z + 1.2);
      this.scene.add(lamp, lamp.target);
    }
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshBasicMaterial({ color: "#101719" }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.47;
    ground.receiveShadow = true;
    this.scene.add(ground);
    this.labels.className = "office-labels";
    this.prompt.className = "office-world-prompt";
    this.menu.className = "office-world-menu";
    this.menu.setAttribute("role", "menu");
    host.append(this.labels, this.prompt, this.menu);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(host);
    this.resize();
    this.renderer.domElement.addEventListener("pointerdown", this.pointerDown);
    this.renderer.domElement.addEventListener("pointerup", this.pointerUp);
    this.renderer.domElement.addEventListener("webglcontextlost", this.contextLost);
    document.addEventListener("visibilitychange", this.visibility);
  }
  private cancelFocus = () => {
    this.target = null;
  };
  private visibility = () => {
    this.lastFrame = 0;
  };
  private contextLost = (event: Event) => {
    event.preventDefault();
    this.onFailure("3D graphics context lost. The original office is still available.");
  };
  private pointerDown = (e: PointerEvent) => {
    this.pointerStart = { x: e.clientX, y: e.clientY };
  };
  private pointerUp = (e: PointerEvent) => {
    if (
      e.button !== 0 ||
      Math.hypot(e.clientX - this.pointerStart.x, e.clientY - this.pointerStart.y) > 5
    )
      return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.raycaster.setFromCamera(
      new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        (-(e.clientY - rect.top) / rect.height) * 2 + 1,
      ),
      this.camera,
    );
    const hit = this.raycaster.intersectObjects(
      [...this.actors.values()].map((a) => a.model.root),
      true,
    )[0];
    const id = hit?.object.userData.actorId;
    if (typeof id === "string") this.source.inspect(id);
  };
  private resize() {
    if (!this.host.clientWidth || !this.host.clientHeight) return;
    const ratio = this.qualityReduced ? 1 : Math.min(window.devicePixelRatio || 1, 1.5);
    this.renderer.setPixelRatio(ratio);
    this.composer.setPixelRatio(ratio);
    this.width = Math.max(1, this.host.clientWidth);
    this.height = Math.max(1, this.host.clientHeight);
    const aspect = this.width / this.height;
    const halfHeight = Math.max(8.0, 12.6 / aspect);
    this.camera.left = -halfHeight * aspect;
    this.camera.right = halfHeight * aspect;
    this.camera.top = halfHeight;
    this.camera.bottom = -halfHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.width, this.height);
    this.composer.setSize(this.width, this.height);
    this.ao.setSize(Math.ceil(this.width * 0.65), Math.ceil(this.height * 0.65));
  }
  setVisible(visible: boolean) {
    this.visible = visible;
    this.host.hidden = !visible;
    if (visible) this.resize();
    this.lastFrame = 0;
  }
  resetCamera() {
    this.target = null;
    this.camera.position.set(1, 22, 25);
    this.controls.target.set(0, 0, 0);
    this.camera.zoom = 1;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }
  focus(id: string) {
    const actor = this.actors.get(id);
    if (actor) this.target = actor.model.root.position.clone().multiplyScalar(0.04);
  }
  setDaylight(day: boolean) {
    this.sun.intensity = day ? 3.2 : 1.2;
    this.sun.color.set(day ? "#fff0d5" : "#d8ad99");
    this.renderer.toneMappingExposure = day ? 1 : 0.78;
  }
  render(time: number, delta: number) {
    if (this.disposed || !this.visible || document.hidden) return;
    const frame = this.source.read();
    if (!frame) return;
    const dt = Math.min(delta / 1000, 0.05);
    const key = frame.seats.map((s) => `${s.seatId}:${s.x}:${s.y}:${s.facing}`).join("|");
    if (key !== this.seatsKey || !this.environment) {
      this.environment?.traverse((o) => {
        if (o instanceof THREE.InstancedMesh) o.dispose();
      });
      this.environment?.removeFromParent();
      this.environment = buildEnvironment(this.assets, frame.seats);
      this.scene.add(this.environment);
      if (!this.clouds) {
        this.clouds = makeClouds(this.assets);
        this.scene.add(this.clouds);
      }
      this.seatsKey = key;
    }
    for (const door of frame.doors) {
      const id = `${door.x}:${door.y}`;
      let pivot = this.doors.get(id);
      if (!pivot) {
        pivot = new THREE.Group();
        const p = worldPosition(door.x - 21, door.y + 17);
        pivot.position.set(p.x, 0, p.z);
        this.assets.box(pivot, 0.42, 0.99, 0, 0.84, 1.98, 0.14, "#9a6937");
        this.assets.box(
          pivot,
          0.42,
          1.49,
          0.08,
          0.56,
          0.58,
          0.025,
          this.assets.glow("#d4e3d9", 0.25),
        );
        this.assets.round(pivot, 0.7, 0.95, 0.1, 0.035, 0.04, "#e0b96d");
        this.scene.add(pivot);
        this.doors.set(id, pivot);
      }
      const target = door.open ? -Math.PI * 0.48 : 0;
      pivot.rotation.y +=
        (target - pivot.rotation.y) * (this.motion.matches ? 1 : 1 - Math.exp(-dt * 10));
    }
    const boss: OfficeActor = {
      id: "boss",
      label: "You",
      spriteKey: "character_09",
      x: frame.player.x,
      y: frame.player.y,
      facing: frame.player.facing,
      moving: frame.player.moving,
      atDesk: false,
      status: "idle",
      voice: "idle",
      connection: "connected",
      activity: "",
      bubble: "",
    };
    const all = [...frame.actors, boss];
    const ids = new Set(all.map((a) => a.id));
    for (const [id, actor] of this.actors)
      if (!ids.has(id)) {
        actor.model.dispose();
        actor.label.remove();
        this.actors.delete(id);
      }
    for (const actor of all) {
      let entry = this.actors.get(actor.id);
      if (!entry) {
        const model = new OfficeCharacter(this.assets, actor.id);
        this.scene.add(model.root);
        const label = document.createElement("button");
        label.className = "office-actor-label";
        label.type = "button";
        const name = document.createElement("strong");
        const activity = document.createElement("span");
        label.append(name, activity);
        label.addEventListener("click", () => this.source.inspect(actor.id));
        this.labels.append(label);
        entry = { model, label, activity };
        this.actors.set(actor.id, entry);
      }
      entry.model.update(actor, dt, this.motion.matches);
      const name = entry.label.firstElementChild!;
      if (name.textContent !== actor.label) name.textContent = actor.label;
      const activity = actor.bubble || actor.activity;
      if (entry.activity.textContent !== activity) entry.activity.textContent = activity;
      entry.activity.hidden = !actor.bubble && actor.voice === "idle" && actor.status === "idle";
      entry.label.dataset.status = actor.status;
      entry.label.dataset.activity = actor.ambient ?? "idle";
      if (process.env.NODE_ENV === "development") {
        entry.label.dataset.x = actor.x.toFixed(1);
        entry.label.dataset.y = actor.y.toFixed(1);
      }
      entry.label.setAttribute(
        "aria-label",
        `${actor.label}${activity ? `: ${activity}` : ""}. Inspect worker`,
      );
    }
    if (this.target) {
      const shift = this.target
        .clone()
        .sub(this.controls.target)
        .multiplyScalar(this.motion.matches ? 1 : 1 - Math.exp(-dt * 5));
      this.controls.target.add(shift);
      this.camera.position.add(shift);
      if (shift.length() < 0.001) this.target = null;
    }
    this.controls.target.x = THREE.MathUtils.clamp(this.controls.target.x, -9, 9);
    this.controls.target.z = THREE.MathUtils.clamp(this.controls.target.z, -6, 6);
    this.controls.target.y = 0;
    this.controls.update();
    this.ambientLights.forEach((light, index) => {
      light.intensity =
        45 * (1 + (this.motion.matches ? 0 : Math.sin(time / 7000 + index) * 0.015));
    });
    this.clouds?.children.forEach((cloud, index) => {
      cloud.position.z = -3 + (this.motion.matches ? 0 : Math.sin(time / 45000 + index) * 0.7);
    });
    this.camera.updateMatrixWorld();
    const used: Array<{ x: number; y: number }> = [];
    for (const actor of all) {
      const entry = this.actors.get(actor.id)!;
      const pos = entry.model.root.position;
      this.point.set(pos.x, 1.8, pos.z).project(this.camera);
      let x = (this.point.x * 0.5 + 0.5) * this.width,
        y = (-this.point.y * 0.5 + 0.5) * this.height;
      for (
        let attempt = 0;
        attempt < 5 &&
        used.some(
          (p) =>
            Math.abs(x - p.x) < (this.width < 600 ? 55 : 110) &&
            Math.abs(y - p.y) < (this.width < 600 ? 23 : 44),
        );
        attempt++
      )
        y -= this.width < 600 ? 25 : 46;
      used.push({ x, y });
      x = THREE.MathUtils.clamp(
        x,
        this.width < 600 ? 28 : 60,
        this.width - (this.width < 600 ? 28 : 60),
      );
      entry.label.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px) translate(-50%,-100%)`;
      entry.label.hidden = this.point.z > 1 || this.point.z < -1 || y < 0 || y > this.height;
    }
    this.prompt.textContent = frame.prompt;
    this.prompt.hidden = !frame.prompt;
    const menuKey = JSON.stringify(frame.menu);
    if (menuKey !== this.menuSignature) {
      this.menuSignature = menuKey;
      this.menu.replaceChildren();
      this.menu.hidden = !frame.menu.visible;
      if (frame.menu.visible)
        frame.menu.options.forEach((option, index) => {
          const button = document.createElement("button");
          button.textContent = option.label;
          button.disabled = !option.enabled;
          button.setAttribute("role", "menuitem");
          button.className = index === frame.menu.selected ? "selected" : "";
          button.onclick = () => this.source.chooseMenu(index);
          this.menu.append(button);
        });
    }
    this.renderer.info.autoReset = false;
    this.renderer.info.reset();
    this.composer.render(dt);
    if (this.lastFrame) {
      this.frameSamples.push(time - this.lastFrame);
      if (this.frameSamples.length > 120) this.frameSamples.shift();
    }
    this.lastFrame = time;
    this.qualityTimer += dt;
    if (this.qualityTimer > 8 && this.frameSamples.length === 120 && !this.qualityReduced) {
      const average = this.frameSamples.reduce((a, b) => a + b, 0) / 120;
      if (average > 28) {
        this.renderer.setPixelRatio(1);
        this.composer.setPixelRatio(1);
        this.ao.enabled = false;
        this.sun.shadow.mapSize.set(1024, 1024);
        this.sun.shadow.map?.dispose();
        this.sun.shadow.map = null;
        this.resize();
        this.qualityReduced = true;
      }
    }
    // Read-only diagnostics for browser regression measurements; never used as business state.
    if (this.qualityTimer > 1) {
      this.host.dataset.drawCalls = String(this.renderer.info.render.calls);
      this.host.dataset.triangles = String(this.renderer.info.render.triangles);
      this.host.dataset.frameMs = (
        this.frameSamples.reduce((a, b) => a + b, 0) / Math.max(1, this.frameSamples.length)
      ).toFixed(1);
    }
  }
  dispose() {
    this.disposed = true;
    this.observer.disconnect();
    this.controls.removeEventListener("start", this.cancelFocus);
    this.controls.dispose();
    document.removeEventListener("visibilitychange", this.visibility);
    this.renderer.domElement.removeEventListener("pointerdown", this.pointerDown);
    this.renderer.domElement.removeEventListener("pointerup", this.pointerUp);
    this.renderer.domElement.removeEventListener("webglcontextlost", this.contextLost);
    for (const entry of this.actors.values()) {
      entry.model.dispose();
      entry.label.remove();
    }
    this.actors.clear();
    this.scene.traverse((object) => {
      if (object instanceof THREE.InstancedMesh) object.dispose();
    });
    // The ground owns its geometry/material; all other meshes share the asset pool.
    for (const object of this.scene.children)
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        if (!Array.isArray(object.material)) object.material.dispose();
      }
    this.sun.shadow.map?.dispose();
    this.ao.dispose();
    this.output.dispose();
    this.composer.dispose();
    this.environmentMap.dispose();
    this.assets.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labels.remove();
    this.prompt.remove();
    this.menu.remove();
  }
}
