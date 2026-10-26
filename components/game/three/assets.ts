import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

/** Shared GPU resources and deterministic procedural surfaces for the miniature. */
export class OfficeAssets {
  readonly flatCube = new THREE.BoxGeometry(1, 1, 1);
  readonly cube = new RoundedBoxGeometry(1, 1, 1, 1, 0.035);
  readonly cylinder = new THREE.CylinderGeometry(1, 1, 1, 12);
  readonly sphere = new THREE.IcosahedronGeometry(1, 1);
  readonly leaf = new THREE.SphereGeometry(1, 6, 4);
  private materials = new Map<string, THREE.MeshStandardMaterial>();
  private textures: THREE.Texture[] = [];

  material(color: string, roughness = 0.65, metalness = 0) {
    const key = `${color}:${roughness}:${metalness}`;
    let material = this.materials.get(key);
    if (!material) {
      material = new THREE.MeshStandardMaterial({ color, roughness, metalness });
      this.materials.set(key, material);
    }
    return material;
  }
  glow(color: string, intensity = 1) {
    const key = `glow:${color}:${intensity}`;
    let material = this.materials.get(key);
    if (!material) {
      material = new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: intensity,
        roughness: 0.4,
      });
      this.materials.set(key, material);
    }
    return material;
  }
  box(
    parent: THREE.Object3D,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    color: string | THREE.Material,
    roughness = 0.65,
  ) {
    const mesh = new THREE.Mesh(
      Math.min(w, h, d) < 0.08 ? this.flatCube : this.cube,
      typeof color === "string" ? this.material(color, roughness) : color,
    );
    mesh.position.set(x, y, z);
    mesh.scale.set(w, h, d);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }
  round(
    parent: THREE.Object3D,
    x: number,
    y: number,
    z: number,
    radius: number,
    height: number,
    color: string | THREE.Material,
  ) {
    const mesh = new THREE.Mesh(
      this.cylinder,
      typeof color === "string" ? this.material(color) : color,
    );
    mesh.position.set(x, y, z);
    mesh.scale.set(radius, height, radius);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }
  texture(kind: "wood" | "floorwood" | "stone" | "rug" | "screen" | "board") {
    const key = `texture:${kind}`;
    const cached = this.materials.get(key);
    if (cached) return cached;
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const c = canvas.getContext("2d")!;
    let seed = 117;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    if (kind === "wood" || kind === "floorwood") {
      c.fillStyle = kind === "floorwood" ? "#77756b" : "#70553c";
      c.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 400; i++) {
        c.strokeStyle = `rgba(${rand() > 0.5 ? "235,180,105" : "40,20,8"},${rand() * 0.16})`;
        c.lineWidth = rand() * 3;
        c.beginPath();
        const y = rand() * 512;
        c.moveTo(0, y);
        c.bezierCurveTo(150, y + rand() * 8, 380, y - rand() * 9, 512, y);
        c.stroke();
      }
    } else if (kind === "stone") {
      c.fillStyle = "#666b6d";
      c.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 6000; i++) {
        c.fillStyle = `rgba(220,211,192,${rand() * 0.1})`;
        c.fillRect(rand() * 512, rand() * 512, rand() * 15, 2);
      }
      c.strokeStyle = "#92938c";
      c.lineWidth = 3;
      c.strokeRect(1, 1, 510, 510);
    } else if (kind === "rug") {
      c.fillStyle = "#3c5946";
      c.fillRect(0, 0, 512, 512);
      c.strokeStyle = "#b89959";
      c.lineWidth = 12;
      c.strokeRect(22, 22, 468, 468);
      c.lineWidth = 3;
      c.strokeRect(42, 42, 428, 428);
      for (let x = 60; x < 470; x += 35)
        for (let y = 60; y < 470; y += 35) {
          c.fillStyle = "#9d874e";
          c.fillRect(x, y, 4, 4);
        }
      c.save();
      c.translate(256, 256);
      c.rotate(Math.PI / 4);
      c.strokeRect(-70, -70, 140, 140);
      c.restore();
    } else {
      c.fillStyle = kind === "board" ? "#e8e2d5" : "#0c2031";
      c.fillRect(0, 0, 512, 512);
      c.fillStyle = kind === "board" ? "#6b726d" : "#598198";
      c.fillRect(24, 22, 464, 28);
      if (kind === "screen") {
        for (let i = 0; i < 20; i++) {
          c.fillStyle = ["#61bdcb", "#daae66", "#668aaa"][i % 3];
          c.fillRect(28 + (i % 3) * 12, 80 + i * 19, 40 + rand() * 230, 4);
        }
        c.fillStyle = "#172d3d";
        c.fillRect(340, 76, 145, 410);
        for (let i = 0; i < 8; i++) {
          c.fillStyle = "#5487a1";
          c.fillRect(352, 100 + i * 42, 40 + rand() * 70, 5);
        }
      } else {
        c.strokeStyle = "#b1b4ad";
        c.lineWidth = 1;
        for (let y = 110; y < 460; y += 50) {
          c.beginPath();
          c.moveTo(35, y);
          c.lineTo(480, y);
          c.stroke();
        }
        c.strokeStyle = "#ca854c";
        c.lineWidth = 6;
        c.beginPath();
        for (let i = 0; i < 8; i++) {
          const x = 40 + i * 60,
            y = 390 - i * 35 + rand() * 90;
          if (i === 0) c.moveTo(x, y);
          else c.lineTo(x, y);
        }
        c.stroke();
        c.fillStyle = "#708b9c";
        for (let i = 0; i < 8; i++) c.fillRect(45 + i * 55, 450 - i * 22, 25, i * 22 + 8);
      }
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    this.textures.push(texture);
    const mat = new THREE.MeshStandardMaterial({
      map: texture,
      roughness: kind === "stone" ? 0.38 : 0.72,
      metalness: kind === "stone" ? 0.12 : 0,
    });
    if (kind === "screen") {
      mat.emissive = new THREE.Color("#73c4ff");
      mat.emissiveMap = texture;
      mat.emissiveIntensity = 0.6;
    }
    this.materials.set(key, mat);
    return mat;
  }
  dispose() {
    this.cube.dispose();
    this.flatCube.dispose();
    this.cylinder.dispose();
    this.sphere.dispose();
    this.leaf.dispose();
    for (const m of this.materials.values()) m.dispose();
    for (const t of this.textures) t.dispose();
  }
}
