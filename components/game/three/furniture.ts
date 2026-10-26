import * as THREE from "three";
import { OfficeAssets } from "./assets";

export class Furniture {
  constructor(private a: OfficeAssets) {}
  plant(parent: THREE.Object3D, x: number, z: number, scale = 1) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.scale.setScalar(scale);
    parent.add(g);
    this.a.round(g, 0, 0.19, 0, 0.21, 0.38, "#55564b");
    this.a.round(g, 0, 0.4, 0, 0.23, 0.06, "#b9a582");
    this.a.round(g, 0, 0.77, 0, 0.025, 0.78, "#5c4930");
    for (let i = 0; i < 14; i++) {
      const angle = i * 2.399;
      const leaf = new THREE.Mesh(
        this.a.leaf,
        this.a.material(["#3d6034", "#617d3c", "#294c31"][i % 3]),
      );
      leaf.position.set(Math.cos(angle) * 0.21, 0.65 + (i % 5) * 0.12, Math.sin(angle) * 0.21);
      leaf.scale.set(0.13, 0.32, 0.08);
      leaf.rotation.set(Math.sin(angle) * 0.8, angle, 0.6);
      leaf.castShadow = true;
      g.add(leaf);
    }
  }
  lamp(parent: THREE.Object3D, x: number, z: number, y = 0.9) {
    this.a.round(parent, x, y + 0.025, z, 0.12, 0.05, "#393b33");
    this.a.round(parent, x, y + 0.24, z, 0.018, 0.43, "#b98d4d");
    this.a.round(parent, x, y + 0.47, z, 0.16, 0.14, this.a.glow("#ffce83", 1.6));
  }
  chair(parent: THREE.Object3D, x: number, z: number, angle = 0, color = "#303940") {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = angle;
    parent.add(g);
    this.a.round(g, 0, 0.23, 0, 0.045, 0.4, "#323737");
    for (let i = 0; i < 5; i++) {
      const leg = this.a.box(g, 0, 0.07, 0, 0.62, 0.035, 0.045, "#2b3030");
      leg.rotation.y = (i * Math.PI) / 5;
    }
    this.a.box(g, 0, 0.48, 0, 0.55, 0.13, 0.52, color);
    this.a.box(g, 0, 0.85, -0.24, 0.56, 0.63, 0.1, color);
    this.a.box(g, 0, 1.18, -0.24, 0.36, 0.14, 0.13, color);
    for (const side of [-1, 1]) {
      this.a.box(g, side * 0.32, 0.65, 0, 0.045, 0.33, 0.045, "#343a3b");
      this.a.box(g, side * 0.32, 0.79, 0, 0.1, 0.06, 0.37, "#242c2e");
    }
    return g;
  }
  desk(parent: THREE.Object3D, x: number, z: number, angle = 0) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = angle;
    parent.add(g);
    this.a.box(g, 0, 0.83, 0, 1.75, 0.12, 0.85, this.a.texture("wood"));
    for (const sx of [-0.72, 0.72])
      for (const sz of [-0.32, 0.32]) this.a.box(g, sx, 0.4, sz, 0.065, 0.8, 0.065, "#303637");
    this.a.box(g, 0.59, 0.4, 0.08, 0.38, 0.68, 0.55, "#414b4a");
    for (let i = 0; i < 3; i++)
      this.a.box(g, 0.59, 0.23 + i * 0.2, 0.365, 0.14, 0.025, 0.025, "#bda56e");
    this.a.round(g, 0, 0.93, -0.14, 0.15, 0.04, "#242a2d");
    this.a.box(g, 0, 1.09, -0.17, 0.055, 0.3, 0.045, "#30393d");
    this.a.box(g, 0, 1.35, -0.18, 0.86, 0.55, 0.055, "#151e24");
    this.a.box(g, 0, 1.35, -0.146, 0.78, 0.46, 0.012, this.a.texture("screen"));
    this.a.box(g, -0.05, 0.91, 0.15, 0.52, 0.035, 0.19, "#252f34");
    for (let row = 0; row < 3; row++)
      for (let col = 0; col < 10; col++)
        this.a.box(
          g,
          -0.27 + col * 0.047,
          0.933,
          0.09 + row * 0.05,
          0.033,
          0.008,
          0.026,
          "#87918d",
        );
    this.a.box(g, 0.36, 0.92, 0.18, 0.07, 0.035, 0.12, "#91968a");
    this.a.round(g, -0.63, 0.98, 0.19, 0.07, 0.18, "#e2d9bf");
    this.a.round(g, -0.63, 1.075, 0.19, 0.052, 0.005, "#342720");
    this.lamp(g, 0.68, -0.22, 0.9);
    this.a.box(g, -0.63, 0.92, -0.17, 0.23, 0.04, 0.27, "#c2b79a");
    g.scale.x = 1.35;
    return g;
  }
  shelf(parent: THREE.Object3D, x: number, z: number, width = 1.7) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    parent.add(g);
    this.a.box(g, 0, 1.1, -0.18, width, 2.2, 0.08, "#57442e");
    for (const sx of [-width / 2, width / 2])
      this.a.box(g, sx, 1.1, 0, 0.075, 2.2, 0.47, "#b18b4e");
    const colors = ["#9f603e", "#3d6279", "#b99b55", "#58705b", "#a39a7c", "#725963"];
    for (let row = 0; row < 4; row++) {
      this.a.box(g, 0, 0.12 + row * 0.53, 0, width, 0.065, 0.48, this.a.texture("wood"));
      for (let i = 0; i < Math.floor(width / 0.115) - 1; i++) {
        const h = 0.26 + ((i * 13 + row * 7) % 11) * 0.017;
        const bx = -width / 2 + 0.13 + i * 0.115;
        this.a.box(
          g,
          bx,
          0.155 + row * 0.53 + h / 2,
          0.03,
          0.085,
          h,
          0.27,
          colors[(i + row * 3) % colors.length],
        );
        this.a.box(g, bx, 0.23 + row * 0.53, 0.171, 0.068, 0.013, 0.008, "#cfbb81");
      }
    }
    this.a.box(g, 0, 2.23, 0, width + 0.1, 0.08, 0.54, this.a.texture("wood"));
    this.plant(g, -width * 0.3, 0, 0.65);
    // Top-shelf pot is placed above the cabinet, not on the floor.
    g.children[g.children.length - 1].position.y = 2.27;
  }
  board(parent: THREE.Object3D, x: number, z: number, width = 2) {
    this.a.box(parent, x, 1.65, z, width, 1.25, 0.12, "#403f38");
    this.a.box(parent, x, 1.65, z + 0.07, width - 0.12, 1.12, 0.02, this.a.texture("board"));
    this.a.box(parent, x, 1.01, z + 0.15, width, 0.05, 0.22, "#898f87");
  }
  water(parent: THREE.Object3D, x: number, z: number) {
    this.a.box(parent, x, 0.59, z, 0.49, 1.15, 0.44, "#5b6566");
    this.a.box(parent, x, 0.87, z + 0.23, 0.35, 0.32, 0.015, "#263237");
    this.a.round(parent, x, 1.45, z, 0.22, 0.48, this.a.material("#8cbcc7", 0.2, 0.3));
    this.a.box(parent, x, 1.07, z + 0.25, 0.09, 0.04, 0.04, "#b9af91");
    this.a.box(parent, x, 0.3, z + 0.23, 0.35, 0.18, 0.015, "#303c41");
  }
  table(parent: THREE.Object3D, x: number, z: number, width = 1.4) {
    this.a.box(parent, x, 0.78, z, width, 0.12, 0.85, this.a.texture("wood"));
    for (const sx of [-1, 1])
      for (const sz of [-1, 1])
        this.a.box(
          parent,
          x + sx * (width / 2 - 0.12),
          0.37,
          z + sz * 0.3,
          0.065,
          0.74,
          0.065,
          "#353d36",
        );
    this.a.box(parent, x, 0.87, z, 0.26, 0.04, 0.34, "#e0d6b8");
    this.lamp(parent, x + 0.4, z - 0.1, 0.85);
  }
  sofa(parent: THREE.Object3D, x: number, z: number) {
    this.a.box(parent, x, 0.29, z, 1.6, 0.42, 0.8, "#3e4341");
    this.a.box(parent, x, 0.75, z - 0.33, 1.6, 0.65, 0.17, "#69685d");
    for (const sx of [-0.73, 0.73])
      this.a.box(parent, x + sx, 0.59, z, 0.18, 0.52, 0.83, "#5e6057");
    for (const sx of [-0.35, 0.35]) {
      this.a.box(parent, x + sx, 0.52, z, 0.62, 0.2, 0.65, "#79786b");
      this.a.box(parent, x + sx, 0.82, z - 0.22, 0.61, 0.4, 0.14, "#757468");
    }
  }
}
