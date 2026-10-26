import { NAV_CLEARANCE } from "../config/office-layout";
import { PF_CELL_SIZE, PF_MAX_ITER } from "@/lib/constants";

export interface PathPoint {
  x: number;
  y: number;
}

interface AStarNode {
  r: number;
  c: number;
  g: number;
  h: number;
  parent: AStarNode | null;
}

const CELL_SIZE = PF_CELL_SIZE;

class MinHeap<T> {
  private data: T[] = [];
  constructor(private score: (item: T) => number) {}

  get length() {
    return this.data.length;
  }

  push(item: T) {
    this.data.push(item);
    this.bubbleUp(this.data.length - 1);
  }

  pop(): T | undefined {
    const top = this.data[0];
    const last = this.data.pop();
    if (this.data.length > 0 && last !== undefined) {
      this.data[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  private bubbleUp(i: number) {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.score(this.data[i]) >= this.score(this.data[parent])) break;
      [this.data[i], this.data[parent]] = [this.data[parent], this.data[i]];
      i = parent;
    }
  }

  private sinkDown(i: number) {
    const n = this.data.length;
    while (true) {
      let smallest = i;
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      if (l < n && this.score(this.data[l]) < this.score(this.data[smallest])) smallest = l;
      if (r < n && this.score(this.data[r]) < this.score(this.data[smallest])) smallest = r;
      if (smallest === i) break;
      [this.data[i], this.data[smallest]] = [this.data[smallest], this.data[i]];
      i = smallest;
    }
  }
}

export class Pathfinder {
  private grid: boolean[][];
  private solids: { left: number; top: number; right: number; bottom: number }[] = [];
  private cols: number;
  private rows: number;

  /**
   * @param padding  Extra clearance around collision rects (half of the
   *                 moving body's largest dimension) to prevent clipping.
   */
  constructor(
    mapWidthPx: number,
    mapHeightPx: number,
    collisionRects: { x: number; y: number; width: number; height: number }[],
    padding: number | { x: number; y: number } = 0,
  ) {
    this.cols = Math.ceil(mapWidthPx / CELL_SIZE);
    this.rows = Math.ceil(mapHeightPx / CELL_SIZE);
    this.grid = [];

    // Inflate collision rects by `padding` (half-body-width) so that paths
    // keep the sprite body clear of obstacles.
    const px = typeof padding === "number" ? padding : padding.x;
    const py = typeof padding === "number" ? padding : padding.y;
    const inflated = collisionRects
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => ({
        left: r.x - px,
        top: r.y - py,
        right: r.x + r.width + px,
        bottom: r.y + r.height + py,
      }));

    this.solids = inflated;
    // Nodes represent body centers. Inflate by the actual footprint, then
    // test every route segment against those same bounds. Blocking entire
    // cells as well would double-count clearance and close valid doorways.
    for (let r = 0; r < this.rows; r++) {
      this.grid[r] = [];
      for (let c = 0; c < this.cols; c++) {
        const cellLeft = c * CELL_SIZE;
        const cellTop = r * CELL_SIZE;
        const cellRight = cellLeft + CELL_SIZE;
        const cellBottom = cellTop + CELL_SIZE;

        let walkable = true;
        for (const rect of inflated) {
          if (
            (cellLeft + cellRight) / 2 > rect.left &&
            (cellLeft + cellRight) / 2 < rect.right &&
            (cellTop + cellBottom) / 2 > rect.top &&
            (cellTop + cellBottom) / 2 < rect.bottom
          ) {
            walkable = false;
            break;
          }
        }
        this.grid[r][c] = walkable;
      }
    }
  }

  findPath(sx: number, sy: number, ex: number, ey: number): PathPoint[] | null {
    if (!this.segmentClear(sx, sy, sx, sy)) return null;
    let sc = this.toCol(sx);
    let sr = this.toRow(sy);
    let ec = this.toCol(ex);
    let er = this.toRow(ey);
    let endSnapped = false;
    const exactEndSafe = this.segmentClear(ex, ey, ex, ey);

    if (!this.valid(sr, sc)) return null;

    if (!this.grid[sr]?.[sc]) {
      const ns = this.nearestWalkableCell(sr, sc);
      if (!ns) return null;
      if (
        !this.segmentClear(
          sx,
          sy,
          ns.c * CELL_SIZE + CELL_SIZE / 2,
          ns.r * CELL_SIZE + CELL_SIZE / 2,
        )
      )
        return null;
      sr = ns.r;
      sc = ns.c;
    }

    if (!this.valid(er, ec) || !this.grid[er]?.[ec] || !this.segmentClear(ex, ey, ex, ey)) {
      const nearest = this.nearestWalkableCell(er, ec);
      if (!nearest) return null;
      er = nearest.r;
      ec = nearest.c;
      endSnapped = true;
    }

    if (
      exactEndSafe &&
      this.valid(this.toRow(ey), this.toCol(ex)) &&
      this.segmentClear(sx, sy, ex, ey)
    )
      return [
        { x: sx, y: sy },
        { x: ex, y: ey },
      ];

    if (sr === er && sc === ec) {
      const end = endSnapped
        ? { x: ec * CELL_SIZE + CELL_SIZE / 2, y: er * CELL_SIZE + CELL_SIZE / 2 }
        : { x: ex, y: ey };
      if (!this.segmentClear(sx, sy, end.x, end.y)) return null;
      return [
        { x: sx, y: sy },
        endSnapped
          ? { x: ec * CELL_SIZE + CELL_SIZE / 2, y: er * CELL_SIZE + CELL_SIZE / 2 }
          : { x: ex, y: ey },
      ];
    }

    const open = new MinHeap<AStarNode>((n) => n.g + n.h);
    open.push({ r: sr, c: sc, g: 0, h: this.h(sr, sc, er, ec), parent: null });
    const best = new Map<number, number>();
    const DIRS: [number, number][] = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
      [-1, -1],
      [-1, 1],
      [1, -1],
      [1, 1],
    ];

    let iterations = 0;

    while (open.length > 0 && iterations++ < PF_MAX_ITER) {
      const cur = open.pop()!;

      if (cur.r === er && cur.c === ec) {
        const path = this.reconstruct(cur);
        if (path.length > 0) {
          if (endSnapped) {
            path[path.length - 1] = {
              x: ec * CELL_SIZE + CELL_SIZE / 2,
              y: er * CELL_SIZE + CELL_SIZE / 2,
            };
          } else {
            const previous = path[Math.max(0, path.length - 2)];
            if (this.segmentClear(previous.x, previous.y, ex, ey))
              path[path.length - 1] = { x: ex, y: ey };
          }
        }
        if (!this.segmentClear(sx, sy, path[0].x, path[0].y)) return null;
        const last = path[path.length - 1];
        if (endSnapped && exactEndSafe && this.segmentClear(last.x, last.y, ex, ey))
          path.push({ x: ex, y: ey });
        path.unshift({ x: sx, y: sy });
        return path;
      }

      const key = cur.r * this.cols + cur.c;
      const prev = best.get(key);
      if (prev !== undefined && prev <= cur.g) continue;
      best.set(key, cur.g);

      for (const [dr, dc] of DIRS) {
        const nr = cur.r + dr;
        const nc = cur.c + dc;
        if (!this.valid(nr, nc) || !this.grid[nr][nc]) continue;

        if (dr !== 0 && dc !== 0) {
          if (!this.grid[cur.r + dr][cur.c] || !this.grid[cur.r][cur.c + dc]) continue;
        }

        if (
          !this.segmentClear(
            cur.c * CELL_SIZE + CELL_SIZE / 2,
            cur.r * CELL_SIZE + CELL_SIZE / 2,
            nc * CELL_SIZE + CELL_SIZE / 2,
            nr * CELL_SIZE + CELL_SIZE / 2,
          )
        )
          continue;
        const cost = dr !== 0 && dc !== 0 ? 1.414 : 1;
        const g = cur.g + cost;
        const nkey = nr * this.cols + nc;
        const prevBest = best.get(nkey);
        if (prevBest !== undefined && prevBest <= g) continue;
        open.push({ r: nr, c: nc, g, h: this.h(nr, nc, er, ec), parent: cur });
      }
    }

    return null;
  }

  avoiding(rects: { x: number; y: number; width: number; height: number }[]) {
    return new Pathfinder(this.cols * CELL_SIZE, this.rows * CELL_SIZE, [
      ...this.solids.map((r) => ({
        x: r.left,
        y: r.top,
        width: r.right - r.left,
        height: r.bottom - r.top,
      })),
      ...rects.map((r) => ({
        x: r.x - NAV_CLEARANCE.x,
        y: r.y - NAV_CLEARANCE.y,
        width: r.width + 2 * NAV_CLEARANCE.x,
        height: r.height + 2 * NAV_CLEARANCE.y,
      })),
    ]);
  }

  segmentClear(sx: number, sy: number, ex: number, ey: number) {
    return !this.solids.some((r) => {
      let lo = 0,
        hi = 1;
      for (const [start, delta, min, max] of [
        [sx, ex - sx, r.left, r.right],
        [sy, ey - sy, r.top, r.bottom],
      ]) {
        if (Math.abs(delta) < 1e-9) {
          if (start <= min || start >= max) return false;
        } else {
          const a = (min - start) / delta,
            b = (max - start) / delta;
          lo = Math.max(lo, Math.min(a, b));
          hi = Math.min(hi, Math.max(a, b));
        }
      }
      return lo <= hi;
    });
  }

  private toCol(x: number) {
    return Math.floor(x / CELL_SIZE);
  }
  private toRow(y: number) {
    return Math.floor(y / CELL_SIZE);
  }
  private valid(r: number, c: number) {
    return r >= 0 && r < this.rows && c >= 0 && c < this.cols;
  }
  private h(r1: number, c1: number, r2: number, c2: number) {
    const dr = Math.abs(r1 - r2);
    const dc = Math.abs(c1 - c2);
    return Math.max(dr, dc) + (Math.SQRT2 - 1) * Math.min(dr, dc);
  }

  private nearestWalkableCell(r: number, c: number): { r: number; c: number } | null {
    for (let d = 1; d <= 12; d++) {
      let bestDist = Infinity;
      let bestCell: { r: number; c: number } | null = null;
      for (let dr = -d; dr <= d; dr++) {
        for (let dc = -d; dc <= d; dc++) {
          if (Math.abs(dr) < d && Math.abs(dc) < d) continue;
          const nr = r + dr;
          const nc = c + dc;
          if (this.valid(nr, nc) && this.grid[nr][nc]) {
            const dist = dr * dr + dc * dc;
            if (dist < bestDist) {
              bestDist = dist;
              bestCell = { r: nr, c: nc };
            }
          }
        }
      }
      if (bestCell) return bestCell;
    }
    return null;
  }

  private reconstruct(node: AStarNode): PathPoint[] {
    const raw: PathPoint[] = [];
    let cur: AStarNode | null = node;
    while (cur) {
      raw.unshift({
        x: cur.c * CELL_SIZE + CELL_SIZE / 2,
        y: cur.r * CELL_SIZE + CELL_SIZE / 2,
      });
      cur = cur.parent;
    }
    return this.simplify(raw);
  }

  private simplify(path: PathPoint[]): PathPoint[] {
    if (path.length <= 2) return path;
    const result: PathPoint[] = [path[0]];
    for (let i = 1; i < path.length - 1; i++) {
      const p = path[i - 1],
        c = path[i],
        n = path[i + 1];
      if (c.x - p.x !== n.x - c.x || c.y - p.y !== n.y - c.y) {
        result.push(c);
      }
    }
    result.push(path[path.length - 1]);
    return result;
  }
}
