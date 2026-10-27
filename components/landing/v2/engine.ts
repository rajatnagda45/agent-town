import {
  W,
  H,
  GRID,
  rooms,
  doors,
  items,
  pois,
  bubbles,
  agentDefs,
  activityLabel,
  type Item,
  type Poi,
  type AgentDef,
  type Rect,
  type Activity,
  type PoiKind,
} from "./officeData";

import { workerSnapshot, type WorkerSnapshot } from "./status";

type Dir = "up" | "down" | "left" | "right";

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

const COLS = W / GRID;
const ROWS = H / GRID;

function buildGrid(): boolean[] {
  const g = new Array(COLS * ROWS).fill(false);
  const mark = (r: Rect, v: boolean, pad = 0) => {
    for (let cy = Math.floor((r.y - pad) / GRID); cy < Math.ceil((r.y + r.h + pad) / GRID); cy++)
      for (let cx = Math.floor((r.x - pad) / GRID); cx < Math.ceil((r.x + r.w + pad) / GRID); cx++)
        if (cx >= 0 && cy >= 0 && cx < COLS && cy < ROWS) g[cy * COLS + cx] = v;
  };
  rooms.forEach((r) =>
    mark({ x: r.x + 3, y: r.y + r.wall + 2, w: r.w - 6, h: r.h - r.wall - 4 }, true),
  );
  doors.forEach((d) => mark(d, true));
  items
    .filter((i) => i.solid)
    .forEach((i) => mark({ x: i.x, y: i.y + i.h * 0.35, w: i.w, h: i.h * 0.65 }, false, 2));
  return g;
}

function path(grid: boolean[], sx: number, sy: number, tx: number, ty: number) {
  const s = Math.floor(sy / GRID) * COLS + Math.floor(sx / GRID);
  const t = Math.floor(ty / GRID) * COLS + Math.floor(tx / GRID);
  const prev = new Int32Array(COLS * ROWS).fill(-1);
  prev[s] = s;
  const q = [s];
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    if (c === undefined) continue;
    if (c === t) break;
    const cx = c % COLS,
      cy = (c / COLS) | 0;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = cx + dx,
        ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
      const n = ny * COLS + nx;
      if (prev[n] !== -1 || (!grid[n] && n !== t)) continue;
      prev[n] = c;
      q.push(n);
    }
  }
  if (prev[t] === -1) return null;
  const out: { x: number; y: number }[] = [];
  for (let c = t; c !== s;) {
    out.push({ x: (c % COLS) * GRID + GRID / 2, y: ((c / COLS) | 0) * GRID + GRID / 2 });
    const parent = prev[c];
    if (parent === undefined || parent < 0) return null;
    c = parent;
  }
  out.reverse();
  out[out.length - 1] = { x: tx, y: ty };
  // keep only turning points for smoother walking
  return out.filter((p, i) => i === out.length - 1 || i % 2 === 0);
}

type Mode = "desk" | "walk" | "away";

class Agent {
  x: number;
  y: number;
  dir: Dir = "up";
  mode: Mode = "desk";
  activity: Activity;
  timer: number;
  cycles = 0;
  route: { x: number; y: number }[] = [];
  target: Poi;
  home: Poi;
  buddy: Agent | null = null;
  returning = false;
  bubble = "";
  bubbleT = 0;
  wait = 0;
  stuck = 0;
  phase: number;
  frameT = 0;
  frame = 0;
  constructor(
    public def: AgentDef,
    home: Poi,
    public r: () => number,
  ) {
    this.home = home;
    this.target = home;
    this.x = home.x;
    this.y = home.y;
    this.activity = def.deskStates[0] ?? "typing";
    this.timer = 2 + r() * 5;
    this.phase = r() * 10;
    this.cycles = Math.floor(r() * 2);
  }
  get seated() {
    return this.mode === "desk";
  }
  setActivity(a: Activity, show = true) {
    this.activity = a;
    if (show && activityLabel[a]) {
      this.bubble = activityLabel[a];
      this.bubbleT = 2.6;
    }
  }
  say(text: string, t = 2.4) {
    this.bubble = text;
    this.bubbleT = t;
  }
}

type Fx = { x: number; y: number; t: number; c: string; txt: string };

export class OfficeEngine {
  ctx: CanvasRenderingContext2D;
  grid = buildGrid();
  agents: Agent[];
  fx: Fx[] = [];
  stars: { x: number; y: number; p: number }[];
  city: { x: number; w: number; h: number; win: { x: number; y: number; on: number }[] }[];
  t = 0;
  last = 0;
  raf = 0;
  running = false;
  intro = 0;
  mx = 0;
  my = 0;
  scale = 1;
  hover: Agent | null = null;
  reduced: boolean;

  snapshotKey = "";
  pending: { due: number; run: () => void }[] = [];

  constructor(
    public canvas: HTMLCanvasElement,
    reduced: boolean,
    private onStatus?: (workers: WorkerSnapshot[]) => void,
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D is unavailable");
    this.ctx = ctx;
    this.reduced = reduced;
    const r = rng(7);
    this.stars = Array.from({ length: 70 }, () => ({ x: r() * W, y: r() * 120, p: r() * 6 }));
    this.city = [];
    for (let x = -10; x < W + 20;) {
      const w = 10 + Math.floor(r() * 18),
        h = 40 + Math.floor(r() * 90);
      const win: { x: number; y: number; on: number }[] = [];
      for (let wy = 6; wy < h - 4; wy += 6)
        for (let wx = 2; wx < w - 3; wx += 4) if (r() > 0.6) win.push({ x: wx, y: wy, on: r() });
      this.city.push({ x, w, h, win });
      x += w + 1;
    }
    this.agents = agentDefs.map((d, i) => {
      const home = pois.find((q) => q.id === d.home);
      if (!home) throw new Error(`Missing desk for ${d.name}`);
      return new Agent(d, home, rng(100 + i * 31));
    });
    this.publishStatus();
    this.intro = reduced ? 1 : 0;
  }

  resize(cssW: number) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(((cssW * H) / W) * dpr);
    this.scale = this.canvas.width / W;
    if (!this.running) this.draw();
  }

  publishStatus() {
    const workers = this.agents.map((a) =>
      workerSnapshot(a.def.name, a.def.role, a.activity, a.seated, a.returning),
    );
    const key = JSON.stringify(workers);
    if (key !== this.snapshotKey) {
      this.snapshotKey = key;
      this.onStatus?.(workers);
    }
  }

  start() {
    if (this.reduced) {
      this.draw();
      return;
    }
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      if (!this.reduced) this.update(dt);
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  pointer(nx: number, ny: number) {
    if (this.reduced) return;
    this.mx = nx;
    this.my = ny;
    const wx = (nx + 0.5) * W,
      wy = (ny + 0.5) * H;
    this.hover =
      this.agents.find((a) => Math.abs(a.x - wx) < 6 && wy > a.y - 16 && wy < a.y + 2) ?? null;
  }

  occupantOf(deskId: string) {
    return this.agents.find((a) => a.seated && a.home.id === deskId) ?? null;
  }

  // ---------- behaviour scheduler ----------
  update(dt: number) {
    this.t += dt;
    const due = this.pending.filter((job) => job.due <= this.t);
    this.pending = this.pending.filter((job) => job.due > this.t);
    due.forEach((job) => job.run());
    this.intro = Math.min(1, this.intro + dt / 1.6);
    this.fx = this.fx.filter((f) => (f.t += dt) < 1.6);
    for (const a of this.agents) {
      a.bubbleT -= dt;
      a.frameT += dt;
      if (a.frameT > 0.16) {
        a.frameT = 0;
        a.frame++;
      }
      if (a.mode === "walk") {
        this.step(a, dt);
        continue;
      }
      a.timer -= dt;
      if (a.timer > 0) continue;
      if (a.mode === "desk") this.deskCycle(a);
      else this.leaveSpot(a);
    }
    this.publishStatus();
  }

  deskCycle(a: Agent) {
    a.cycles++;
    const busyNeighbours = this.agents.filter((o) => o.mode !== "desk").length;
    if (a.cycles >= 2 && a.r() < a.def.tripChance && busyNeighbours < 2) {
      if (a.activity === "coding" || a.activity === "debugging" || a.activity === "reviewing")
        this.fx.push({ x: a.x, y: a.y - 22, t: 0, c: "#43e58a", txt: "✓" });
      a.cycles = 0;
      if (this.startTrip(a)) return;
    }
    // pause/resume rhythm: alternate between a work state and a short think
    const states = a.def.deskStates;
    const next =
      a.activity === "thinking" || a.r() > 0.25
        ? (states[Math.floor(a.r() * states.length)] ?? "typing")
        : "thinking";
    a.setActivity(next, a.r() < 0.55);
    a.timer = (next === "thinking" ? 1.8 : 4) + a.r() * 4;
  }

  pick<T extends { w: number }>(a: Agent, list: T[]) {
    let n = a.r() * list.reduce((s, x) => s + x.w, 0);
    for (const x of list) if ((n -= x.w) <= 0) return x;
    return list[0];
  }

  startTrip(a: Agent) {
    const trip = this.pick(a, a.def.trips);
    if (!trip) return false;
    if (trip.kind === "colleague") {
      const mates = this.agents.filter((o) => o !== a && o.seated && !o.buddy);
      const mate = mates[Math.floor(a.r() * mates.length)];
      if (!mate) return false;
      const spot: Poi = {
        id: `visit-${mate.def.name}`,
        kind: "desk",
        x: mate.home.x + 9,
        y: mate.home.y + 1,
        face: "left",
      };
      if (!this.walkTo(a, spot)) return false;
      a.buddy = mate;
      mate.buddy = a;
      a.say(`→ ${mate.def.name}`, 1.6);
      return true;
    }
    const taken = new Set(this.agents.map((o) => o.target.id));
    const opts = pois.filter((p) => p.kind === (trip.kind as PoiKind) && !taken.has(p.id));
    const p = opts[Math.floor(a.r() * opts.length)];
    return p ? this.walkTo(a, p) : false;
  }

  walkTo(a: Agent, p: Poi) {
    const route = path(this.grid, a.x, a.y, p.x, p.y);
    if (!route) return false;
    a.route = route;
    a.target = p;
    a.mode = "walk";
    a.activity = "walking";
    a.stuck = 0;
    return true;
  }

  step(a: Agent, dt: number) {
    const next = a.route[0];
    if (!next) {
      this.arrive(a);
      return;
    }
    const dx = next.x - a.x,
      dy = next.y - a.y,
      d = Math.hypot(dx, dy);
    const blocked = this.agents.some(
      (o) =>
        o !== a && Math.hypot(o.x - a.x, o.y - a.y) < 6 && (o.x - a.x) * dx + (o.y - a.y) * dy > 0,
    );
    if (blocked && a.wait < 0.7) {
      a.wait += dt;
      return;
    }
    a.wait = 0;
    const s = a.def.speed * dt;
    if (d <= s) {
      a.x = next.x;
      a.y = next.y;
      a.route.shift();
    } else {
      a.x += (dx / d) * s;
      a.y += (dy / d) * s;
    }
    a.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
  }

  arrive(a: Agent) {
    a.dir = a.target.face;
    if (a.target === a.home) {
      a.mode = "desk";
      a.returning = false;
      a.setActivity(a.def.deskStates[0] ?? "typing");
      a.timer = 4 + a.r() * 4;
      return;
    }
    a.mode = "away";
    if (a.buddy) {
      const mate = a.buddy;
      a.setActivity("collaborating", false);
      a.say(
        ["Quick sync?", "Got a sec?", "Check this PR", "API ready?"][Math.floor(a.r() * 4)] ??
          "Quick sync?",
      );
      mate.dir = "right";
      this.pending.push({
        due: this.t + 1.4,
        run: () =>
          mate.say(
            ["Sure!", "Looks good", "On it", "Shipping!"][Math.floor(mate.r() * 4)] ?? "Sure!",
          ),
      });
      a.timer = 4 + a.r() * 2;
      return;
    }
    const map: Partial<Record<PoiKind, Activity>> = {
      shelf: "researching",
      table: "reading",
      board: "planning",
      coffee: "taking_break",
      sofa: "taking_break",
      fridge: "taking_break",
      cooler: "taking_break",
      rug: "thinking",
    };
    a.setActivity(map[a.target.kind] ?? "thinking", false);
    const list = bubbles[a.target.kind];
    a.say(list[Math.floor(a.r() * list.length)] ?? "…");
    a.timer = 3.5 + a.r() * 3;
  }

  leaveSpot(a: Agent) {
    if (a.buddy) {
      a.buddy.buddy = null;
      a.buddy.dir = "up";
      a.buddy = null;
    }
    a.returning = true;
    if (!this.walkTo(a, a.home)) {
      a.timer = 1;
      return;
    }
    a.say(activityLabel.returning_to_work, 1.4);
  }

  // ---------- rendering ----------
  r(x: number, y: number, w: number, h: number, c: string) {
    this.ctx.fillStyle = c;
    this.ctx.fillRect(x, y, w, h);
  }

  draw() {
    const c = this.ctx,
      s = this.scale;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.imageSmoothingEnabled = false;
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const e = 1 - Math.pow(1 - this.intro, 3);
    const z = 1.08 - 0.08 * e;
    c.setTransform(s * z, 0, 0, s * z, (W * s * (1 - z)) / 2, (H * s * (1 - z)) / 2);
    c.globalAlpha = Math.min(1, e * 1.5);

    this.drawSky();
    c.save();
    c.translate(-this.mx * 2, -this.my * 1.5);
    this.drawBuilding();
    this.drawRooms();
    this.drawSorted();
    this.drawLights();
    this.drawFacade();
    c.restore();
    this.drawSign();
    this.drawForeground();
    this.drawBubbles();
    c.globalAlpha = 1;
  }

  drawSky() {
    const c = this.ctx,
      t = this.t;
    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#14111c");
    g.addColorStop(0.55, "#251d2e");
    g.addColorStop(1, "#1a1612");
    c.fillStyle = g;
    c.fillRect(-20, -20, W + 40, H + 40);
    for (const st of this.stars) {
      const a = 0.35 + 0.65 * Math.abs(Math.sin(t * 0.8 + st.p));
      c.globalAlpha = a;
      this.r(st.x - this.mx * 4, st.y, 1, 1, "#f0e7d5");
    }
    c.globalAlpha = 1;
    // moon
    const mx = 150 - this.mx * 5,
      my = 26;
    const mg = c.createRadialGradient(mx, my, 2, mx, my, 26);
    mg.addColorStop(0, "rgba(240,215,140,.35)");
    mg.addColorStop(1, "rgba(240,215,140,0)");
    c.fillStyle = mg;
    c.fillRect(mx - 30, my - 30, 60, 60);
    c.fillStyle = "#f2e2a6";
    c.beginPath();
    c.arc(mx, my, 9, 0, Math.PI * 2);
    c.fill();
    this.r(mx - 3, my - 2, 2, 2, "#d8c784");
    this.r(mx + 2, my + 3, 3, 2, "#d8c784");
    // clouds
    for (let i = 0; i < 4; i++) {
      const cx = ((i * 110 + t * (3 + i)) % (W + 80)) - 60,
        cy = 14 + i * 13;
      c.fillStyle = "rgba(70,55,85,.55)";
      c.fillRect(cx, cy, 44, 5);
      c.fillRect(cx + 8, cy - 4, 24, 5);
      c.fillRect(cx + 30, cy + 3, 22, 4);
    }
    // city skyline (two depths)
    for (const [k, depth] of [
      [0, 0.55],
      [1, 1],
    ] as const) {
      const off = -this.mx * (k ? 3 : 1.5);
      for (const b of this.city) {
        const h = b.h * depth,
          x = (b.x * (k ? 1 : 1.3) + off + (k ? 0 : 7)) % (W + 30),
          y = H - 30 - h;
        this.r(x, y, b.w, h + 30, k ? "#1d1820" : "#2a2232");
        if (k)
          for (const w of b.win) {
            if (w.y > h - 2) continue;
            const on = Math.sin(this.t * 0.3 + w.on * 50) > -0.85;
            this.r(x + w.x, y + w.y, 2, 2, on ? (w.on > 0.5 ? "#f0c13a" : "#d98a3a") : "#2c2530");
          }
      }
    }
  }

  drawBuilding() {
    // slab under the floor plan + roof terrace edges
    this.r(54, 46, 280, 160, "#3a3229");
    this.r(56, 48, 276, 156, "#29251d");
    this.r(58, 50, 272, 2, "#5a4e3e");
  }

  drawRooms() {
    const c = this.ctx;
    for (const rm of rooms) {
      // floor tiles
      for (let y = rm.y + rm.wall; y < rm.y + rm.h; y += rm.tile)
        for (let x = rm.x; x < rm.x + rm.w; x += rm.tile)
          this.r(
            x,
            y,
            Math.min(rm.tile, rm.x + rm.w - x),
            Math.min(rm.tile, rm.y + rm.h - y),
            ((x - rm.x) / rm.tile + (y - rm.y) / rm.tile) % 2 < 1 ? rm.floorA : rm.floorB,
          );
      // back wall
      this.r(rm.x, rm.y, rm.w, rm.wall, rm.wallA);
      this.r(rm.x, rm.y + rm.wall - 2, rm.w, 2, rm.wallB);
      if (rm.wallA === "#8b6a52")
        for (let by = rm.y + 2; by < rm.y + rm.wall - 2; by += 3)
          for (let bx = rm.x + ((by / 3) % 2 ? 0 : 3); bx < rm.x + rm.w; bx += 6)
            this.r(bx, by, 1, 1, rm.wallB);
    }
    // partition walls
    const wall = "#f4ecdc",
      edge = "#bfb39b";
    for (const [x, y, w, h] of [
      [210, 56, 4, 84],
      [64, 140, 262, 12],
      [170, 152, 4, 48],
      [210, 152, 4, 48],
    ] as const) {
      this.r(x, y, w, h, wall);
      this.r(x, y + h - 1, w, 1, edge);
    }
    for (const rm of rooms) {
      this.r(rm.x - 2, rm.y - 2, rm.w + 4, 2, wall);
    }
    this.r(62, 54, 2, 148, wall);
    this.r(326, 54, 2, 148, wall);
    this.r(62, 200, 266, 3, wall);
    // door openings
    for (const d of doors) {
      const vertical = d.h > d.w;
      this.r(d.x, d.y, d.w, d.h, "#8f877b");
      if (vertical) {
        this.r(d.x - 1, d.y + 4, 1, d.h - 8, "#b5752e");
        this.r(d.x + d.w, d.y + 4, 1, d.h - 8, "#b5752e");
      }
    }
    c.globalAlpha = 1;
    // wall mounted decor
    items.filter((i) => i.wall).forEach((i) => this.drawItem(i));
  }

  drawSorted() {
    type D = { y: number; f: () => void };
    const list: D[] = [];
    items
      .filter((i) => !i.wall && i.kind !== "rug")
      .forEach((i) => list.push({ y: i.y + i.h, f: () => this.drawItem(i) }));
    items.filter((i) => i.kind === "rug").forEach((i) => this.drawItem(i));
    // chairs sit just behind the seat so a seated agent overlaps them
    pois
      .filter((p) => p.kind === "desk")
      .forEach((p) => list.push({ y: p.y - 0.5, f: () => this.drawChair(p.x, p.y) }));
    this.agents.forEach((a) => list.push({ y: a.y, f: () => this.drawAgent(a) }));
    list.sort((p, q) => p.y - q.y).forEach((d) => d.f());
  }

  drawItem(i: Item) {
    const { x, y, w, h } = i,
      t = this.t;
    switch (i.kind) {
      case "desk": {
        this.r(x, y + 3, w, h - 3, "#c9a46a");
        this.r(x, y + h - 2, w, 2, "#8a6a3e");
        this.r(x + 1, y + h, 2, 2, "#5a4630");
        this.r(x + w - 3, y + h, 2, 2, "#5a4630");
        const occ = i.id ? this.occupantOf(i.id) : null;
        this.drawScreen(x + 1, y - 5, occ?.activity ?? null, x);
        this.drawScreen(
          x + 15,
          y - 5,
          occ ? (occ.activity === "thinking" ? "thinking" : occ.activity) : null,
          x + 7,
        );
        this.r(x + 9, y + 5, 8, 2, "#d8d0c0"); // keyboard
        if (occ && (occ.activity === "typing" || occ.activity === "coding") && occ.frame % 2)
          this.r(x + 10 + (occ.frame % 3) * 2, y + 5, 1, 1, "#f0c13a");
        this.r(x + 2, y + 5, 3, 3, "#f0e7d5");
        this.r(x + w - 4, y + 4, 2, 4, "#a93640");
        if (!occ) this.r(x + 3, y + 6, 1, 1, "#43e58a");
        break;
      }
      case "plant":
        this.r(x + 2, y + h - 4, w - 4, 4, "#8a4a2e");
        this.r(x, y + 1, w, h - 5, "#3d7a48");
        this.r(x + 2, y - 1, w - 4, 3, "#4f9a5a");
        this.r(x + 1, y + 3, 2, 2, "#6ab872");
        break;
      case "shelf": {
        this.r(x, y, w, h, "#6a4a2e");
        this.r(x + 1, y + 1, w - 2, h - 2, "#4a3220");
        const cols = ["#a93640", "#d9ad24", "#3f6aa8", "#3f8a5a", "#e07a4a", "#f0e7d5"];
        for (let row = 0; row < 3; row++)
          for (let b = 0; b < 6; b++)
            this.r(
              x + 2 + b * 3,
              y + 2 + row * 5,
              2,
              4,
              cols[(b * 7 + row * 3 + x) % cols.length] ?? "#a93640",
            );
        break;
      }
      case "tv":
        this.r(x, y, w, h, "#1a1a1e");
        this.r(x + 1, y + 1, w - 2, h - 3, Math.sin(t * 1.5) > 0 ? "#a93640" : "#c04a4a");
        this.r(x + 3, y + 3, 6, 2, "#f0c13a");
        break;
      case "board":
        this.r(x, y, w, h, "#d8d8d8");
        this.r(x + 1, y + 1, w - 2, h - 2, "#fafafa");
        this.r(x + 3, y + 6, 4, 2, "#a93640");
        this.r(x + 8, y + 4, 4, 4, "#3f8a5a");
        this.r(x + 14, y + 2, 4, 6, "#3f6aa8");
        this.r(x + 20, y + 5, 3, 3, "#d9ad24");
        break;
      case "frame":
        this.r(x, y, w, h, "#6a4a2e");
        this.r(x + 1, y + 1, w - 2, h - 2, i.tint ?? "#d9ad24");
        this.r(x + 2, y + h - 3, w - 4, 1, "#f0e7d5");
        break;
      case "ac":
        this.r(x, y, w, h, "#f8f6f0");
        this.r(x + 1, y + h - 2, w - 2, 1, "#a99d89");
        break;
      case "cooler":
        this.r(x + 1, y, w - 2, 5, "#8ec8f0");
        this.r(x, y + 5, w, h - 5, "#d8d8d8");
        this.r(x + 2, y + 8, 2, 2, "#3f6aa8");
        break;
      case "lamp": {
        this.r(x + 1, y + 3, 2, h - 3, "#4a3a2a");
        this.r(x - 1, y + h - 1, 6, 1, "#4a3a2a");
        this.r(x - 2, y, 8, 4, Math.sin(t * 9 + x) > -0.95 ? "#f0c13a" : "#c49a2a");
        break;
      }
      case "rug":
        this.r(x, y, w, h, i.tint ?? "#8f5a3a");
        this.r(x + 2, y + 2, w - 4, h - 4, "#a8453c");
        this.r(x + 4, y + 4, w - 8, h - 8, i.tint ?? "#8f5a3a");
        break;
      case "armchair":
        this.r(x, y, w, h, i.tint ?? "#8f5a3a");
        this.r(x + 2, y + 3, w - 4, h - 5, "#f0e7d533");
        this.r(x, y + h - 2, w, 2, "#2a2440");
        break;
      case "globe":
        this.r(x + 3, y + h - 3, 2, 3, "#6a4a2e");
        this.r(x, y, w, w, "#3f6aa8");
        this.r(x + 2, y + 2, 3, 2, "#3f8a5a");
        this.r(x + 4, y + 5, 3, 2, "#3f8a5a");
        break;
      case "table":
        this.r(x, y, w, h - 2, "#8a5a32");
        this.r(x, y + h - 2, w, 2, "#5a3a20");
        this.r(x + 3, y + 1, 3, 2, "#f0e7d5");
        break;
      case "sofa":
        this.r(x, y, w, 5, "#6a3e28");
        this.r(x, y + 4, w, h - 4, i.tint ?? "#8f5a3a");
        this.r(x - 2, y + 2, 3, h - 2, "#6a3e28");
        this.r(x + w - 1, y + 2, 3, h - 2, "#6a3e28");
        this.r(x + 6, y + 5, 6, 3, "#d9ad24");
        this.r(x + w - 12, y + 5, 6, 3, "#a93640");
        break;
      case "counter": {
        this.r(x, y, w, h, "#e8e2d4");
        this.r(x, y + h - 3, w, 3, "#a99d89");
        this.r(x + 18, y - 4, 8, 7, "#2a2a32");
        this.r(x + 20, y - 2, 4, 2, Math.sin(t * 4) > 0 ? "#a93640" : "#5a2a2a");
        this.r(x + 34, y + 1, 10, 4, "#9ab4c8");
        this.r(x + 4, y + 1, 6, 4, "#c04a3a");
        // steam
        for (let k = 0; k < 3; k++) {
          const sy = (t * 6 + k * 3) % 8;
          this.ctx.globalAlpha = 0.5 * (1 - sy / 8);
          this.r(x + 21 + (k % 2), y - 6 - sy, 1, 1, "#f0e7d5");
        }
        this.ctx.globalAlpha = 1;
        break;
      }
      case "fridge":
        this.r(x, y, w, h, "#d8dde4");
        this.r(x, y + 7, w, 1, "#9aa4b0");
        this.r(x + w - 3, y + 2, 1, 3, "#6a7480");
        this.r(x + w - 3, y + 9, 1, 4, "#6a7480");
        break;
      case "stairs":
        for (let k = 0; k < 7; k++) {
          this.r(x, y + k * 6, w, 6, k % 2 ? "#8a6a48" : "#a07c56");
          this.r(x, y + k * 6 + 5, w, 1, "#5a4630");
        }
        this.r(x + w, y, 1, h, "#f4ecdc");
        break;
    }
  }

  drawScreen(x: number, y: number, act: Activity | null, seed: number) {
    const t = this.t;
    this.r(x, y, 10, 8, "#2a2a32");
    this.r(x + 4, y + 8, 2, 2, "#2a2a32");
    const sx = x + 1,
      sy = y + 1,
      sw = 8,
      sh = 6;
    if (!act) {
      this.r(sx, sy, sw, sh, "#1e2a3a");
      this.r(sx + (((t * 2 + seed) % sw) | 0), sy + 3, 1, 1, "#3f6aa8");
      return;
    }
    this.r(sx, sy, sw, sh, "#14202c");
    const scroll = Math.floor(t * 3 + seed);
    if (act === "coding" || act === "typing" || act === "returning_to_work") {
      const cols = ["#d9ad24", "#6fb3e8", "#43e58a", "#e07a4a", "#c8c0f0"];
      for (let l = 0; l < 3; l++) {
        const k = scroll + l;
        this.r(
          sx + 1 + (k % 2),
          sy + 1 + l * 2,
          2 + ((k * 7) % 5),
          1,
          cols[k % cols.length] ?? "#d9ad24",
        );
      }
      if (Math.floor(t * 2) % 2) this.r(sx + 6, sy + 5, 1, 1, "#f0e7d5");
    } else if (act === "debugging") {
      for (let l = 0; l < 3; l++)
        this.r(sx + 1, sy + 1 + l * 2, 3 + ((scroll + l) % 4), 1, "#6fb3e8");
      if (Math.floor(t * 3) % 2) this.r(sx, sy + 3, sw, 1, "#e34b52");
    } else if (act === "reviewing") {
      for (let l = 0; l < 3; l++)
        this.r(sx + 1, sy + 1 + l * 2, 6, 1, (scroll + l) % 2 ? "#43e58a" : "#e34b52");
    } else if (act === "researching" || act === "reading" || act === "planning") {
      for (let b = 0; b < 4; b++) {
        const h = 1 + Math.floor((Math.sin(t * 1.3 + b + seed) + 1) * 2);
        this.r(sx + 1 + b * 2, sy + sh - h, 1, h, act === "planning" ? "#d9ad24" : "#43e58a");
      }
    } else {
      this.r(sx + 2, sy + 2, 4, 2, "#3f6aa8"); // thinking / idle: dim window
    }
  }

  drawChair(x: number, y: number) {
    this.r(x - 4, y - 4, 8, 3, "#3a3640");
    this.r(x - 3, y - 1, 6, 2, "#2a2630");
    this.r(x - 1, y + 1, 2, 1, "#1a1820");
  }

  drawAgent(a: Agent) {
    const d = a.def,
      x = Math.round(a.x) - 4,
      moving = a.mode === "walk" && a.wait === 0;
    const seated = a.mode === "desk";
    const bobY = moving
      ? Math.floor(this.t * 8 + a.phase) % 2
      : Math.sin(this.t * 2 + a.phase) > 0.6
        ? 1
        : 0;
    const y = Math.round(a.y) - 14 + (seated ? 2 : 0) - (moving ? bobY : 0);
    const c = this.ctx;
    // shadow
    c.fillStyle = "rgba(0,0,0,.3)";
    c.fillRect(x + 1, Math.round(a.y) - 1, 7, 2);
    if (a === this.hover) {
      this.r(x - 1, y - 2, 11, 1, "#f0c13a");
    }
    // legs
    const step = moving ? Math.floor(this.t * 8 + a.phase) % 2 : 0;
    if (!seated) {
      this.r(x + 2, y + 11, 2, 3 - (step ? 1 : 0), d.pants);
      this.r(x + 5, y + 11, 2, 3 - (step ? 0 : 1), d.pants);
    }
    // body
    this.r(x + 1, y + 7, 7, 5, d.shirt);
    const busyHands =
      seated && (a.activity === "typing" || a.activity === "coding" || a.activity === "debugging");
    const typing = busyHands && a.frame % 2;
    this.r(x, y + 8 - (typing ? 1 : 0), 1, 3, d.skin);
    this.r(x + 8, y + 8 - (typing ? 0 : 1), 1, 3, d.skin);
    // head
    this.r(x + 1, y + 1, 7, 6, d.skin);
    if (a.dir === "up") this.r(x + 1, y, 7, 6, d.hair);
    else {
      this.r(x + 1, y, 7, 2, d.hair);
      if (a.dir === "left") {
        this.r(x + 6, y + 1, 2, 4, d.hair);
        this.r(x + 2, y + 3, 1, 1, "#1a1410");
      } else if (a.dir === "right") {
        this.r(x + 1, y + 1, 2, 4, d.hair);
        this.r(x + 6, y + 3, 1, 1, "#1a1410");
      } else {
        this.r(x + 1, y + 1, 1, 3, d.hair);
        this.r(x + 7, y + 1, 1, 3, d.hair);
        this.r(x + 3, y + 3, 1, 1, "#1a1410");
        this.r(x + 5, y + 3, 1, 1, "#1a1410");
      }
    }
    if (d.cap) {
      this.r(x, y - 1, 9, 2, d.cap);
    }
    if (d.label || a === this.hover) {
      c.font = "bold 4px 'Space Mono', monospace";
      const tw = c.measureText(d.name).width + 3;
      const lx = Math.round(a.x - tw / 2),
        ly = Math.round(a.y) + 2;
      this.r(lx, ly, tw, 5, "rgba(18,17,15,.85)");
      c.fillStyle = a === this.hover ? "#f0c13a" : "#f0e7d5";
      c.fillText(d.name, lx + 1.5, ly + 4);
      if (a === this.hover) {
        c.font = "3.4px 'Space Mono', monospace";
        const info = `${d.role} · ${activityLabel[a.activity] || "Walking"}`;
        const iw = c.measureText(info).width + 3;
        this.r(Math.round(a.x - iw / 2), ly + 6, iw, 5, "rgba(73,35,38,.92)");
        c.fillStyle = "#f0e7d5";
        c.fillText(info, Math.round(a.x - iw / 2) + 1.5, ly + 9.8);
      }
    }
    // typing dots above the head while busy at the desk
    if (busyHands && a.bubbleT <= 0)
      for (let k = 0; k < 3; k++)
        this.r(x + 1 + k * 3, y - 4 - ((a.frame + k) % 3 === 0 ? 1 : 0), 1, 1, "#f0c13a");
  }

  drawBubbles() {
    const c = this.ctx;
    c.save();
    c.translate(-this.mx * 2, -this.my * 1.5);
    c.font = "4.2px 'Space Mono', monospace";
    for (const a of this.agents) {
      if (a.bubbleT <= 0 || !a.bubble) continue;
      const tw = c.measureText(a.bubble).width + 5;
      const bx = Math.round(Math.min(W - tw - 2, Math.max(2, a.x - tw / 2))),
        by = Math.round(a.y) - 26;
      c.globalAlpha = Math.min(1, a.bubbleT * 2);
      this.r(bx, by, tw, 8, "#f0e7d5");
      this.r(bx, by + 8, tw, 1, "#a99d89");
      this.r(Math.round(a.x) - 1, by + 8, 3, 2, "#f0e7d5");
      c.fillStyle = "#191713";
      c.fillText(a.bubble, bx + 2.5, by + 5.7);
    }
    c.font = "bold 6px 'Space Mono', monospace";
    for (const f of this.fx) {
      c.globalAlpha = 1 - f.t / 1.6;
      c.fillStyle = f.c;
      c.fillText(f.txt, f.x - 2, f.y - f.t * 8);
    }
    c.globalAlpha = 1;
    c.restore();
  }

  drawLights() {
    const c = this.ctx;
    c.globalCompositeOperation = "lighter";
    for (const i of items.filter((q) => q.light)) {
      const fl = 0.16 + 0.03 * Math.sin(this.t * 7 + i.x);
      const g = c.createRadialGradient(i.x + 2, i.y + 2, 1, i.x + 2, i.y + 2, 26);
      g.addColorStop(0, `rgba(240,180,70,${fl})`);
      g.addColorStop(1, "rgba(240,180,70,0)");
      c.fillStyle = g;
      c.fillRect(i.x - 26, i.y - 26, 56, 56);
    }
    // monitor glow
    for (const i of items.filter((q) => q.kind === "desk")) {
      const g = c.createRadialGradient(i.x + 13, i.y, 1, i.x + 13, i.y, 14);
      g.addColorStop(0, "rgba(90,160,220,.12)");
      g.addColorStop(1, "rgba(90,160,220,0)");
      c.fillStyle = g;
      c.fillRect(i.x - 2, i.y - 14, 30, 28);
    }
    c.globalCompositeOperation = "source-over";
  }

  drawFacade() {
    this.r(54, 204, 280, 30, "#2e2620");
    for (let x = 58; x < 330; x += 6) this.r(x, 206 + ((x / 6) % 2) * 3, 4, 1, "#3a3028");
    for (let i = 0; i < 9; i++) {
      const x = 66 + i * 30,
        on = Math.sin(this.t * 0.4 + i * 1.7) > -0.7;
      this.r(x, 212, 14, 12, "#1a1410");
      this.r(x + 1, 213, 12, 10, on ? "#f0b43a" : "#6a4a20");
      this.r(x + 6, 213, 1, 10, "#1a1410");
      this.r(x + 1, 217, 12, 1, "#1a1410");
    }
    this.r(54, 234, 280, 3, "#1a1410");
  }

  drawSign() {
    const c = this.ctx,
      x = 332,
      y = 118;
    const ox = -this.mx * 2,
      oy = -this.my * 1.5;
    this.r(x + ox + 8, y + oy + 20, 2, 26, "#3a3028");
    this.r(x + ox + 36, y + oy + 20, 2, 26, "#3a3028");
    this.r(x + ox, y + oy, 48, 20, "#2a1416");
    this.r(x + ox + 1, y + oy + 1, 46, 18, "#492326");
    const on = Math.sin(this.t * 13) > -0.92;
    c.font = "5px 'Press Start 2P', monospace";
    c.fillStyle = on ? "#f0c13a" : "#8a6a20";
    c.fillText("AGENT", x + ox + 11, y + oy + 9);
    c.fillText("TOWN", x + ox + 14, y + oy + 16);
    for (let k = 0; k < 6; k++)
      this.r(
        x + ox + 3 + k * 8,
        y + oy + 18,
        2,
        1,
        (Math.floor(this.t * 4) + k) % 2 ? "#f0c13a" : "#a93640",
      );
    // blimp
    const bx = 316 + Math.sin(this.t * 0.4) * 6 - this.mx * 6,
      by = 20 + Math.sin(this.t * 0.9) * 2;
    c.fillStyle = "#5a2228";
    c.beginPath();
    c.ellipse(bx + 28, by + 12, 30, 11, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "#492326";
    c.beginPath();
    c.ellipse(bx + 28, by + 14, 28, 8, 0, 0, Math.PI * 2);
    c.fill();
    this.r(bx + 56, by + 6, 6, 3, "#e07a4a");
    this.r(bx + 56, by + 15, 6, 3, "#e07a4a");
    this.r(bx + 16, by + 23, 18, 4, "#3a2a20");
    c.font = "3.4px 'Press Start 2P', monospace";
    c.fillStyle = "#f0c13a";
    c.fillText("BUILD", bx + 19, by + 11);
    c.fillText("TOGETHER", bx + 14, by + 16);
  }

  drawForeground() {
    // trees framing the building
    const tree = (x: number, y: number, s: number) => {
      this.r(x + s * 0.45, y + s * 0.8, s * 0.12, s * 0.5, "#3a2a1a");
      this.r(x, y + s * 0.2, s, s * 0.7, "#24432c");
      this.r(x + s * 0.15, y, s * 0.7, s * 0.4, "#2f5a38");
      this.r(x + s * 0.2, y + s * 0.15, s * 0.2, s * 0.15, "#4a7a4a");
    };
    const o = -this.mx * 5;
    tree(30 + o, 196, 28);
    tree(10 + o, 214, 34);
    tree(330 + o, 208, 30);
    tree(352 + o, 190, 26);
    // street lamp
    this.r(42 + o, 168, 2, 40, "#2a2420");
    this.r(39 + o, 165, 8, 4, "#f0c13a");
  }
}
