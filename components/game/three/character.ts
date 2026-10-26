import * as THREE from "three";
import { OfficeAssets } from "./assets";
import { facingAngle, shortestAngle, worldPosition, type OfficeActor } from "./types";

const palettes: Record<string, { hair: string; shirt: string; skin: string }> = {
  character_02: { hair: "#744b35", shirt: "#48566b", skin: "#d3a182" },
  character_03: { hair: "#593b2c", shirt: "#3d705c", skin: "#d7a784" },
  character_04: { hair: "#a64e42", shirt: "#3e6571", skin: "#bc896e" },
  character_05: { hair: "#314c64", shirt: "#7c6782", skin: "#e6b89b" },
  character_09: { hair: "#4d4439", shirt: "#aa7041", skin: "#cba280" },
};

/** Articulated voxel coworker: limbs have local pivots, all motion derives from the live actor. */
export class OfficeCharacter {
  readonly root = new THREE.Group();
  readonly body = new THREE.Group();
  private head = new THREE.Group();
  private arms = [new THREE.Group(), new THREE.Group()];
  private legs = [new THREE.Group(), new THREE.Group()];
  private phase = 0;
  private seated = 0;
  private angle = 0;
  private initialized = false;
  private ring: THREE.Mesh;
  private ringMaterial: THREE.MeshStandardMaterial;
  private shirt: THREE.Mesh[] = [];
  private hair: THREE.Mesh[] = [];
  private skin: THREE.Mesh[] = [];
  private appearance = "";

  constructor(
    private a: OfficeAssets,
    readonly id: string,
  ) {
    this.root.scale.setScalar(1.15);
    this.body.name = "body";
    this.root.add(this.body);
    const b = (
      parent: THREE.Object3D,
      x: number,
      y: number,
      z: number,
      w: number,
      h: number,
      d: number,
      c: string,
    ) => a.box(parent, x, y, z, w, h, d, c);
    this.shirt.push(b(this.body, 0, 0.78, 0, 0.43, 0.49, 0.29, "#48566b"));
    b(this.body, 0, 0.54, 0, 0.45, 0.07, 0.3, "#292f36");
    b(this.body, 0, 0.56, 0.16, 0.07, 0.04, 0.02, "#c1ad70");
    this.head.position.y = 1.23;
    this.body.add(this.head);
    this.skin.push(b(this.head, 0, 0, 0, 0.49, 0.46, 0.43, "#d3a182"));
    this.hair.push(b(this.head, 0, 0.24, -0.015, 0.54, 0.17, 0.49, "#744b35"));
    this.hair.push(b(this.head, 0, 0.02, -0.22, 0.54, 0.39, 0.11, "#744b35"));
    for (let i = 0; i < 5; i++)
      this.hair.push(
        b(this.head, -0.21 + i * 0.105, 0.15 - (i % 3) * 0.045, 0.21, 0.11, 0.16, 0.1, "#744b35"),
      );
    for (const side of [-1, 1]) {
      this.skin.push(b(this.head, side * 0.26, -0.025, 0, 0.07, 0.12, 0.13, "#d3a182"));
      b(this.head, side * 0.12, 0.005, 0.223, 0.052, 0.066, 0.025, "#25343b");
      b(this.head, side * 0.1, 0.02, 0.239, 0.014, 0.018, 0.008, "#f6e5c9");
    }
    this.skin.push(b(this.head, 0, -0.08, 0.245, 0.08, 0.075, 0.07, "#d3a182"));
    b(this.head, 0, -0.15, 0.222, 0.09, 0.018, 0.018, "#8c5b4a");
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const arm = this.arms[i];
      arm.name = `arm-${i}`;
      arm.position.set(side * 0.29, 0.95, 0);
      this.body.add(arm);
      this.shirt.push(b(arm, 0, -0.14, 0, 0.16, 0.31, 0.22, "#48566b"));
      this.skin.push(b(arm, 0, -0.34, 0, 0.14, 0.14, 0.16, "#d3a182"));
      const leg = this.legs[i];
      leg.name = `leg-${i}`;
      leg.position.set(side * 0.12, 0.52, 0);
      this.body.add(leg);
      b(leg, 0, -0.19, 0, 0.19, 0.38, 0.24, "#38414c");
      b(leg, 0, -0.43, 0.05, 0.21, 0.13, 0.35, "#242b30");
    }
    const geometry = new THREE.RingGeometry(0.34, 0.38, 32);
    geometry.rotateX(-Math.PI / 2);
    this.ringMaterial = new THREE.MeshStandardMaterial({
      color: "#d4ab62",
      emissive: "#d4ab62",
      emissiveIntensity: 0.45,
      transparent: true,
      opacity: 0.65,
      side: THREE.DoubleSide,
    });
    this.ring = new THREE.Mesh(geometry, this.ringMaterial);
    this.ring.position.y = 0.04;
    this.root.add(this.ring);
    this.root.traverse((o) => {
      o.userData.actorId = id;
    });
    this.phase = [...id].reduce((n, c) => n + c.charCodeAt(0), 0) % 37;
  }
  update(actor: OfficeActor, dt: number, reduced: boolean) {
    if (this.appearance !== actor.spriteKey) {
      const palette = palettes[actor.spriteKey] ?? palettes.character_02;
      for (const m of this.shirt) m.material = this.a.material(palette.shirt);
      for (const m of this.hair) m.material = this.a.material(palette.hair);
      for (const m of this.skin) m.material = this.a.material(palette.skin);
      this.appearance = actor.spriteKey;
    }
    const p = worldPosition(actor.x, actor.y);
    this.root.position.set(p.x, 0, p.z);
    const target = facingAngle[actor.facing];
    if (!this.initialized) {
      this.angle = target;
      this.initialized = true;
    }
    this.angle += shortestAngle(this.angle, target) * (1 - Math.exp(-dt * 12));
    this.body.rotation.y = this.angle;
    this.phase += dt * (actor.moving ? 9 : 2);
    const wantSeated = actor.atDesk && !actor.moving ? 1 : 0;
    this.seated += (wantSeated - this.seated) * (1 - Math.exp(-dt * 7));
    this.body.position.y = 0.04 * this.seated + (reduced ? 0 : Math.sin(this.phase) * 0.012);
    const walking = actor.moving && !reduced;
    const working =
      (actor.status === "working" || actor.ambient === "coding") &&
      actor.connection === "connected" &&
      !actor.moving &&
      actor.atDesk;
    const reading = actor.ambient === "reading" || actor.ambient === "researching";
    const stretching = actor.ambient === "stretching";
    const speaking = actor.voice === "speaking";
    const meeting = actor.ambient === "collaborating";
    for (let i = 0; i < 2; i++) {
      const sign = i === 0 ? 1 : -1;
      const stride = walking ? Math.sin(this.phase) * 0.52 * sign : 0;
      this.legs[i].rotation.x = stride - this.seated * 1.25;
      this.arms[i].rotation.x = walking
        ? -stride * 0.65
        : working
          ? -0.85 + (reduced ? 0 : Math.sin(this.phase * 3 + sign) * 0.07)
          : speaking
            ? -0.4 + (reduced ? 0 : Math.sin(this.phase + sign) * 0.22)
            : meeting
              ? -0.2 + (reduced ? 0 : Math.sin(this.phase * 0.6 + sign) * 0.08)
              : reading
                ? -0.65
                : stretching
                  ? -2.3
                  : 0;
      this.arms[i].rotation.z = speaking ? sign * 0.15 : 0;
    }
    this.head.rotation.x = working || reading ? 0.12 : actor.ambient === "thinking" ? -0.08 : 0;
    this.head.rotation.y = !reduced && !walking ? Math.sin(this.phase * 0.35) * 0.045 : 0;
    const color =
      actor.status === "failed"
        ? "#e47667"
        : actor.status === "done"
          ? "#74c392"
          : actor.voice !== "idle"
            ? "#86bdcf"
            : actor.status === "working"
              ? "#e8b765"
              : "#827b67";
    this.ringMaterial.color.set(color);
    this.ringMaterial.emissive.set(color);
    this.ring.visible = actor.status !== "idle" || actor.voice !== "idle";
  }
  dispose() {
    this.ring.geometry.dispose();
    this.ringMaterial.dispose();
    this.root.removeFromParent();
  }
}
