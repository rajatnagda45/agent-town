import * as THREE from "three";
import { OfficeAssets } from "./assets";
import { worldPosition } from "./types";
import { WINDOWS } from "../config/office-layout";

/** A small planted urban courtyard and skyline; no claimed real-world landmarks. */
export function addWindowsAndExterior(root: THREE.Group, a: OfficeAssets) {
  const glass = a.material("#8eafb5", 0.15);
  glass.transparent = true;
  glass.opacity = 0.22;
  glass.depthWrite = false;
  for (const window of WINDOWS) {
    const p = worldPosition(window.x + 4, window.y + window.width / 2);
    const length = window.width / 48;
    a.box(root, p.x, 1.35, p.z, 0.055, 2.4, length, glass);
    for (const z of [-length / 2, 0, length / 2])
      a.box(root, p.x, 1.35, p.z + z, 0.16, 2.55, 0.055, "#425451");
    for (const y of [0.1, 2.62]) a.box(root, p.x, y, p.z, 0.19, 0.1, length + 0.12, "#425451");
    a.box(root, p.x, 0.18, p.z, 0.42, 0.12, length + 0.15, "#c6bea5");
  }
  for (const side of [-1, 1]) {
    const x = side === 1 ? 1355 : 35;
    const p = worldPosition(x, 400);
    a.box(root, p.x, -0.29, p.z, 3.1, 0.18, 7.7, "#344d49");
    for (let i = 0; i < 7; i++) {
      const bx = p.x + side * (0.45 + (i % 2) * 0.7),
        z = p.z - 3.4 + i * 1.05,
        h = 1.5 + ((i * 7) % 5) * 0.42;
      a.box(root, bx, h / 2 - 0.3, z, 0.68, h, 0.72, i % 2 ? "#627c7d" : "#7c9290");
      a.box(root, bx, h - 0.25, z, 0.74, 0.1, 0.78, "#abb6a8");
      for (let row = 0; row < 4; row++)
        for (let col = 0; col < 2; col++)
          a.box(
            root,
            bx - side * 0.35,
            0.28 + row * 0.45,
            z - 0.2 + col * 0.35,
            0.012,
            0.21,
            0.16,
            a.glow("#b7d2c6", 0.25),
          );
    }
    // Layered trees soften the architectural view and keep it in the office's visual style.
    for (let i = 0; i < 6; i++) {
      const tx = p.x - side * 0.7,
        tz = p.z - 3 + i * 1.1;
      a.round(root, tx, 0.35, tz, 0.055, 0.8, "#615c43");
      for (let j = 0; j < 3; j++) {
        const crown = new THREE.Mesh(a.sphere, a.material(j % 2 ? "#57745b" : "#3f6154"));
        crown.position.set(tx + (j - 1) * 0.17, 0.9 + j * 0.13, tz);
        crown.scale.set(0.36, 0.5, 0.38);
        root.add(crown);
      }
    }
  }
}

export function makeClouds(a: OfficeAssets) {
  const root = new THREE.Group();
  const material = a.material("#9cafa9");
  for (const side of [-1, 1]) {
    const cloud = new THREE.Group();
    cloud.position.set(side * 13.4, 3.5, -3);
    for (let i = 0; i < 3; i++) {
      const puff = new THREE.Mesh(a.sphere, material);
      puff.position.set((i - 1) * 0.25, i === 1 ? 0.08 : 0, 0);
      puff.scale.set(0.35, 0.15, 0.23);
      cloud.add(puff);
    }
    root.add(cloud);
  }
  return root;
}
