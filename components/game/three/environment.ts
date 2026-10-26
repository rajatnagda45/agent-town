import { addWindowsAndExterior } from "./exterior";
import { DESK, WINDOWS, PLANTS, SOFA } from "../config/office-layout";
import * as THREE from "three";
import { OfficeAssets } from "./assets";
import { Furniture } from "./furniture";
import { worldPosition, facingAngle } from "./types";
import type { SeatDef } from "../utils/MapHelpers";

// Original Tiled room footprint in pixels. Furniture uses the same coordinate system as A*.
const rooms = [
  { x: 122, y: 145, w: 646, d: 448, wood: false },
  { x: 768, y: 95, w: 500, d: 498, wood: false },
  { x: 220, y: 593, w: 548, d: 289, wood: true },
  { x: 816, y: 593, w: 356, d: 319, wood: true },
];

export function buildEnvironment(a: OfficeAssets, seats: SeatDef[]) {
  const root = new THREE.Group();
  const f = new Furniture(a);
  const at = (x: number, y: number) => worldPosition(x, y);
  const put = (x: number, y: number, fn: (x: number, z: number) => void) => {
    const p = at(x, y);
    fn(p.x, p.z);
  };
  for (const room of rooms) {
    const p = at(room.x + room.w / 2, room.y + room.d / 2);
    a.box(root, p.x, -0.23, p.z, room.w / 48, 0.42, room.d / 48, "#252e30");
    const tile = room.wood ? 24 : 48;
    for (let x = room.x; x < room.x + room.w; x += tile)
      for (let y = room.y; y < room.y + room.d; y += 48) {
        const w = Math.min(tile, room.x + room.w - x),
          d = Math.min(48, room.y + room.d - y);
        const t = at(x + w / 2, y + d / 2);
        a.box(
          root,
          t.x,
          0.003,
          t.z,
          (w - 0.15) / 48,
          0.045,
          (d - 0.15) / 48,
          a.texture(room.wood ? "floorwood" : "stone"),
        );
      }
  }
  const wall = (x: number, y: number, w: number, d: number, h = 1.9) => {
    const p = at(x + w / 2, y + d / 2);
    a.box(root, p.x, h / 2, p.z, w / 48, h, d / 48, "#b6ad96");
    a.box(root, p.x, h + 0.04, p.z, w / 48 + 0.035, 0.08, d / 48 + 0.035, "#363b37");
    a.box(root, p.x, 0.12, p.z, w / 48 + 0.03, 0.15, d / 48 + 0.03, "#625c49");
    if (w > d) {
      a.box(
        root,
        p.x,
        h - 0.13,
        p.z + d / 96 + 0.015,
        w / 48 - 0.12,
        0.035,
        0.035,
        a.glow("#ffc87b", 2),
      );
    }
  };
  wall(122, 145, 646, 9);
  wall(768, 95, 500, 9);
  wall(768, 95, 9, 195);
  wall(122, 145, 9, WINDOWS[0].y - 145, 0.75);
  wall(122, WINDOWS[0].y + WINDOWS[0].width, 9, 593 - WINDOWS[0].y - WINDOWS[0].width, 0.75);
  wall(1259, 95, 9, WINDOWS[1].y - 95, 1.7);
  wall(1259, WINDOWS[1].y + WINDOWS[1].width, 9, 593 - WINDOWS[1].y - WINDOWS[1].width, 1.7);
  wall(122, 584, 405, 9, 0.36);
  wall(577, 584, 191, 9, 0.36);
  wall(768, 287, 240, 9, 0.85);
  wall(768, 481, 9, 401, 1.2);
  wall(220, 593, 307, 9, 1.55);
  wall(577, 593, 191, 9, 1.55);
  wall(220, 593, 9, 289, 0.48);
  wall(220, 873, 548, 9, 0.32);
  wall(816, 593, 144, 9, 1.55);
  wall(1008, 593, 164, 9, 1.55);
  wall(816, 593, 9, 319, 0.6);
  wall(1163, 593, 9, 319, 0.7);
  wall(816, 903, 356, 9, 0.32);
  // Fixtures along the reference's back walls.
  for (const [x, y, w] of [
    [338, 170, 2],
    [580, 170, 1.8],
    [1065, 125, 1.8],
  ])
    put(x, y, (px, pz) => f.board(root, px, pz, w));
  for (const [x, y, w] of [
    [480, 190, 1.5],
    [940, 150, 2.7],
    [1152, 150, 1.45],
    [958, 341, 1.3],
  ])
    put(x, y, (px, pz) => f.shelf(root, px, pz, w));
  for (const [x, y] of [
    [744, 205],
    [505, 633],
  ])
    put(x, y, (px, pz) => f.water(root, px, pz));
  for (const [x, y] of [
    [180, 157],
    [1065, 106],
    [280, 605],
  ])
    put(x, y, (px, pz) => {
      a.box(root, px, 2.1, pz, 1.65, 0.42, 0.38, "#d0d0bd");
      for (let i = 0; i < 5; i++)
        a.box(root, px, 1.98 + i * 0.035, pz + 0.2, 1.4, 0.012, 0.012, "#565e5b");
    });
  // Desk instances derive from the actual discovered seats, including vacant ones.
  for (const seat of seats) {
    const p = at(seat.x, seat.y + DESK.feetOffset);
    const angle = facingAngle[seat.facing];
    f.chair(root, p.x, p.z, angle + Math.PI);
    f.desk(
      root,
      p.x + (Math.sin(angle) * DESK.offset) / 48,
      p.z + (Math.cos(angle) * DESK.offset) / 48,
      angle + Math.PI,
    );
  }
  // Shared low workstation dividers occupy the original desk collision footprint.
  put(405, 420, (x, z) => {
    a.box(root, x, 0.65, z, 9.05, 1.25, 0.07, "#586060");
    a.box(root, x, 1.3, z, 9.1, 0.06, 0.09, "#303b3e");
  });
  for (const x of [190, 336, 480, 623])
    put(x, 420, (px, pz) => {
      a.box(root, px, 0.63, pz, 0.065, 1.25, 2.25, "#596263");
      a.box(root, px, 1.28, pz, 0.09, 0.055, 2.25, "#303b3e");
    });
  // Boss workstation and lounge remain in their original rooms.
  put(682, 785, (x, z) => {
    f.desk(root, x - 0.52, z, Math.PI / 2);
    f.chair(root, x + 0.26, z, -Math.PI / 2);
  });
  put(SOFA.x, SOFA.y, (x, z) => f.sofa(root, x, z));
  put(301, 754, (x, z) => {
    f.table(root, x, z, 1.15);
    a.box(root, x - 0.24, 1.03, z - 0.1, 0.3, 0.44, 0.3, "#344140");
    a.box(root, x - 0.24, 1.08, z + 0.06, 0.18, 0.14, 0.02, "#b4b6a2");
    a.round(root, x - 0.24, 0.89, z + 0.15, 0.07, 0.12, "#ddd1ad");
  });
  put(435, 790, (x, z) => f.table(root, x, z, 1.55));
  put(1062, 391, (x, z) => a.box(root, x, 0.035, z, 1.8, 0.035, 2.7, a.texture("rug")));
  put(352, 786, (x, z) => a.box(root, x, 0.035, z, 2.6, 0.035, 2.25, a.texture("rug")));
  for (const [x, y] of [
    [892, 535],
    [1130, 535],
    [1220, 375],
  ])
    put(x, y, (px, pz) => {
      f.table(root, px, pz, 1.25);
      f.chair(root, px - 0.85, pz, Math.PI / 2, "#41564a");
      f.chair(root, px + 0.85, pz, -Math.PI / 2, "#41564a");
    });
  put(843, 205, (x, z) => {
    a.round(root, x, 0.63, z, 0.13, 1.15, "#77603b");
    a.round(root, x, 0.08, z, 0.35, 0.12, "#725633");
    const globe = new THREE.Mesh(a.sphere, a.material("#487e8d", 0.35));
    globe.scale.setScalar(0.4);
    globe.position.set(x, 1.37, z);
    root.add(globe);
    for (let i = 0; i < 9; i++) {
      const leaf = new THREE.Mesh(a.sphere, a.material("#9aaf58"));
      leaf.scale.set(0.16, 0.1, 0.05);
      leaf.position.set(x + Math.sin(i * 2.4) * 0.32, 1.37 + Math.cos(i * 2.4) * 0.29, z + 0.24);
      root.add(leaf);
    }
  });
  put(721, 325, (x, z) => {
    f.table(root, x, z, 0.95);
    a.box(root, x, 1.04, z, 0.64, 0.38, 0.48, "#b8b9a6");
    a.box(root, x, 1.26, z - 0.12, 0.48, 0.08, 0.28, "#d1d0be");
    a.box(root, x, 1.02, z + 0.25, 0.46, 0.12, 0.01, "#353e40");
  });
  for (const [x, y] of [
    [898, 630],
    [1080, 630],
  ])
    put(x, y, (px, pz) => {
      f.shelf(root, px, pz, 1.65);
    });
  put(1050, 690, (x, z) => {
    f.table(root, x, z, 1.7);
    a.box(root, x, 1.29, z - 0.2, 1.2, 0.7, 0.08, "#29373f");
    a.box(root, x, 1.29, z - 0.151, 1.05, 0.56, 0.02, a.texture("screen"));
  });
  put(861, 826, (x, z) => {
    f.table(root, x, z, 1.2);
    a.box(root, x, 0.97, z, 0.65, 0.23, 0.4, "#7baca8");
  });
  put(1103, 845, (x, z) => {
    a.round(root, x, 0.4, z, 0.48, 0.7, "#343f39");
    a.round(root, x, 0.77, z, 0.42, 0.035, a.glow("#a8c34d", 0.7));
    for (const s of [-1, 1]) a.box(root, x + s * 0.4, 0.14, z, 0.12, 0.25, 0.12, "#2d3430");
  });
  for (const [x, y, s] of PLANTS) put(x, y, (px, pz) => f.plant(root, px, pz, s));
  // Warm wall sconces, with a small fixed light budget (no shadow map per bulb).
  for (const [x, y] of [
    [151, 160],
    [360, 160],
    [620, 160],
    [830, 110],
    [1040, 110],
    [1220, 110],
    [270, 610],
    [650, 610],
    [850, 610],
    [1120, 610],
  ])
    put(x, y, (px, pz) => {
      a.box(root, px, 1.8, pz, 0.18, 0.28, 0.15, "#625840");
      a.round(root, px, 1.85, pz + 0.12, 0.09, 0.13, a.glow("#ffe0a2", 2));
    });
  addWindowsAndExterior(root, a);
  bakeInstances(root);
  return root;
}

/** Collapse repeated static parts into GPU instances while keeping real geometry and shadows. */
function bakeInstances(root: THREE.Group) {
  root.updateMatrixWorld(true);
  const batches = new Map<
    string,
    { geometry: THREE.BufferGeometry; material: THREE.Material; matrices: THREE.Matrix4[] }
  >();
  root.traverse((object) => {
    if (object instanceof THREE.Mesh && !Array.isArray(object.material)) {
      const key = object.geometry.uuid + object.material.uuid;
      let batch = batches.get(key);
      if (!batch) {
        batch = { geometry: object.geometry, material: object.material, matrices: [] };
        batches.set(key, batch);
      }
      batch.matrices.push(object.matrixWorld.clone());
    }
  });
  root.clear();
  for (const batch of batches.values()) {
    const mesh = new THREE.InstancedMesh(batch.geometry, batch.material, batch.matrices.length);
    batch.matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.castShadow = !batch.material.transparent;
    mesh.receiveShadow = true;
    root.add(mesh);
  }
}
