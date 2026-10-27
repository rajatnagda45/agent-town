// Scene data for the code-rendered Agent Town office (world units; canvas scales them).
export const W = 384;
export const H = 256;
export const GRID = 4;

export type Rect = { x: number; y: number; w: number; h: number };
export type Room = Rect & {
  id: string;
  wall: number;
  floorA: string;
  floorB: string;
  wallA: string;
  wallB: string;
  tile: number;
};

export const rooms: Room[] = [
  {
    id: "work",
    x: 64,
    y: 56,
    w: 146,
    h: 84,
    wall: 14,
    floorA: "#a59c8e",
    floorB: "#988f81",
    wallA: "#efe6d4",
    wallB: "#d8cdb6",
    tile: 8,
  },
  {
    id: "lib",
    x: 214,
    y: 56,
    w: 112,
    h: 84,
    wall: 14,
    floorA: "#8a6846",
    floorB: "#7e5e3f",
    wallA: "#efe6d4",
    wallB: "#d8cdb6",
    tile: 6,
  },
  {
    id: "lounge",
    x: 64,
    y: 152,
    w: 106,
    h: 48,
    wall: 12,
    floorA: "#7d5f4a",
    floorB: "#735644",
    wallA: "#8b6a52",
    wallB: "#6e523f",
    tile: 8,
  },
  {
    id: "hall",
    x: 174,
    y: 152,
    w: 36,
    h: 48,
    wall: 12,
    floorA: "#6f665a",
    floorB: "#655d52",
    wallA: "#8b6a52",
    wallB: "#6e523f",
    tile: 8,
  },
  {
    id: "kitchen",
    x: 214,
    y: 152,
    w: 112,
    h: 48,
    wall: 12,
    floorA: "#cfc6b2",
    floorB: "#bab19c",
    wallA: "#8b6a52",
    wallB: "#6e523f",
    tile: 6,
  },
];

// Openings between rooms — walkable and drawn as floor.
export const doors: Rect[] = [
  { x: 206, y: 104, w: 12, h: 12 },
  { x: 120, y: 136, w: 12, h: 30 },
  { x: 166, y: 176, w: 12, h: 10 },
  { x: 206, y: 176, w: 12, h: 10 },
  { x: 262, y: 136, w: 12, h: 30 },
];

export type Kind =
  | "desk"
  | "plant"
  | "shelf"
  | "tv"
  | "rug"
  | "armchair"
  | "globe"
  | "table"
  | "sofa"
  | "lamp"
  | "counter"
  | "fridge"
  | "stairs"
  | "board"
  | "cooler"
  | "frame"
  | "ac";

export type Item = Rect & {
  kind: Kind;
  solid: boolean;
  id?: string;
  wall?: boolean;
  tint?: string;
  light?: boolean;
};

const desks: Item[] = [];
[78, 114, 150].forEach((x, i) => {
  desks.push({ kind: "desk", id: `desk${i}a`, x, y: 84, w: 26, h: 10, solid: true });
  desks.push({ kind: "desk", id: `desk${i}b`, x, y: 112, w: 26, h: 10, solid: true });
});

export const items: Item[] = [
  // workspace
  ...desks,
  { kind: "board", x: 84, y: 58, w: 26, h: 10, solid: false, wall: true },
  { kind: "frame", x: 118, y: 59, w: 8, h: 8, solid: false, wall: true, tint: "#d9ad24" },
  { kind: "ac", x: 140, y: 57, w: 20, h: 5, solid: false, wall: true },
  { kind: "cooler", x: 186, y: 64, w: 8, h: 14, solid: true },
  { kind: "plant", x: 66, y: 70, w: 8, h: 10, solid: true },
  { kind: "plant", x: 198, y: 126, w: 8, h: 10, solid: true },
  { kind: "lamp", x: 168, y: 64, w: 4, h: 12, solid: true, light: true },
  // library
  { kind: "shelf", x: 220, y: 58, w: 20, h: 18, solid: true },
  { kind: "shelf", x: 244, y: 58, w: 20, h: 18, solid: true },
  { kind: "tv", x: 270, y: 59, w: 20, h: 11, solid: false, wall: true },
  { kind: "shelf", x: 296, y: 58, w: 20, h: 18, solid: true },
  { kind: "frame", x: 318, y: 60, w: 6, h: 7, solid: false, wall: true, tint: "#a93640" },
  { kind: "rug", x: 250, y: 98, w: 44, h: 24, solid: false, tint: "#8f2f36" },
  { kind: "globe", x: 220, y: 92, w: 8, h: 10, solid: true },
  { kind: "armchair", x: 304, y: 104, w: 14, h: 12, solid: true, tint: "#5d6aa8" },
  { kind: "table", x: 228, y: 120, w: 18, h: 8, solid: true },
  { kind: "plant", x: 314, y: 126, w: 8, h: 10, solid: true },
  { kind: "lamp", x: 296, y: 92, w: 4, h: 12, solid: true, light: true },
  // lounge
  { kind: "sofa", x: 84, y: 162, w: 36, h: 12, solid: true, tint: "#8f5a3a" },
  { kind: "table", x: 94, y: 182, w: 18, h: 7, solid: true },
  { kind: "armchair", x: 140, y: 170, w: 14, h: 12, solid: true, tint: "#6a62a8" },
  { kind: "lamp", x: 70, y: 160, w: 4, h: 12, solid: true, light: true },
  { kind: "plant", x: 156, y: 188, w: 8, h: 10, solid: true },
  { kind: "frame", x: 136, y: 154, w: 10, h: 7, solid: false, wall: true, tint: "#43e58a" },
  // hall
  { kind: "stairs", x: 176, y: 156, w: 14, h: 42, solid: true },
  // kitchen
  { kind: "counter", x: 218, y: 158, w: 58, h: 10, solid: true },
  { kind: "fridge", x: 292, y: 154, w: 12, h: 18, solid: true },
  { kind: "table", x: 250, y: 182, w: 20, h: 9, solid: true },
  { kind: "plant", x: 314, y: 188, w: 8, h: 10, solid: true },
  { kind: "lamp", x: 284, y: 182, w: 4, h: 12, solid: true, light: true },
];

export type PoiKind =
  "desk" | "shelf" | "coffee" | "sofa" | "board" | "fridge" | "rug" | "cooler" | "table";
export type Poi = {
  id: string;
  kind: PoiKind;
  x: number;
  y: number;
  face: "up" | "down" | "left" | "right";
};

export const pois: Poi[] = [
  ...[91, 127, 163].flatMap((x, i) => [
    { id: `desk${i}a`, kind: "desk" as const, x, y: 98, face: "up" as const },
    { id: `desk${i}b`, kind: "desk" as const, x, y: 126, face: "up" as const },
  ]),
  { id: "board", kind: "board", x: 97, y: 76, face: "up" },
  { id: "cooler", kind: "cooler", x: 190, y: 82, face: "up" },
  { id: "shelf1", kind: "shelf", x: 232, y: 80, face: "up" },
  { id: "shelf2", kind: "shelf", x: 306, y: 80, face: "up" },
  { id: "rug", kind: "rug", x: 272, y: 112, face: "right" },
  { id: "readtable", kind: "table", x: 237, y: 134, face: "up" },
  { id: "board2", kind: "board", x: 106, y: 76, face: "up" },
  { id: "sofa", kind: "sofa", x: 102, y: 178, face: "up" },
  { id: "coffee", kind: "coffee", x: 240, y: 172, face: "up" },
  { id: "fridge", kind: "fridge", x: 298, y: 176, face: "up" },
];

export const bubbles: Record<PoiKind, string[]> = {
  desk: ["Writing code…", "Running tests", "Reviewing PR", "Shipping v2"],
  shelf: ["Good read!", "Researching…"],
  coffee: ["Refilling coffee…"],
  sofa: ["Quick break"],
  board: ["Let's build this!", "Planning sprint"],
  fridge: ["Snack time"],
  rug: ["Thinking…"],
  cooler: ["Hydrating"],
  table: ["Reading docs"],
};

export type Activity =
  | "coding"
  | "typing"
  | "reviewing"
  | "debugging"
  | "researching"
  | "reading"
  | "thinking"
  | "collaborating"
  | "taking_break"
  | "walking"
  | "returning_to_work"
  | "planning";

export const activityLabel: Record<Activity, string> = {
  coding: "Coding",
  typing: "Typing…",
  reviewing: "Reviewing PR",
  debugging: "Debugging",
  researching: "Researching…",
  reading: "Reading docs",
  thinking: "Thinking…",
  collaborating: "Syncing",
  taking_break: "Coffee break",
  walking: "",
  returning_to_work: "Back to work",
  planning: "Planning sprint",
};

export type AgentDef = {
  name: string;
  role: string;
  hair: string;
  skin: string;
  shirt: string;
  pants: string;
  cap?: string;
  home: string;
  speed: number;
  label: boolean;
  deskStates: Activity[]; // what they do while seated
  trips: { kind: PoiKind | "colleague"; w: number }[]; // where short trips go
  tripChance: number; // chance to leave after a desk cycle
};

export const agentDefs: AgentDef[] = [
  {
    name: "Alice",
    role: "Researcher",
    hair: "#6b3f22",
    skin: "#f1c7a0",
    shirt: "#3b4a7a",
    pants: "#2a2a3a",
    home: "desk0b",
    speed: 20,
    label: true,
    deskStates: ["researching", "reading", "typing", "thinking"],
    trips: [
      { kind: "shelf", w: 3 },
      { kind: "table", w: 2 },
      { kind: "colleague", w: 1 },
    ],
    tripChance: 0.3,
  },
  {
    name: "Bob",
    role: "Frontend Engineer",
    hair: "#8a5a32",
    skin: "#f1c7a0",
    shirt: "#3f8a5a",
    pants: "#4a4a58",
    home: "desk0a",
    speed: 18,
    label: true,
    deskStates: ["coding", "typing", "reviewing", "coding"],
    trips: [
      { kind: "colleague", w: 3 },
      { kind: "cooler", w: 1 },
    ],
    tripChance: 0.18,
  },
  {
    name: "Carol",
    role: "Product Manager",
    hair: "#a3462c",
    skin: "#e9b88f",
    shirt: "#2f8a8a",
    pants: "#c46a2a",
    cap: "#a93640",
    home: "desk1b",
    speed: 22,
    label: true,
    deskStates: ["planning", "reviewing", "typing"],
    trips: [
      { kind: "board", w: 3 },
      { kind: "colleague", w: 3 },
      { kind: "coffee", w: 1 },
    ],
    tripChance: 0.4,
  },
  {
    name: "Dave",
    role: "Backend Engineer",
    hair: "#4a5a7a",
    skin: "#f3d0b0",
    shirt: "#6a4a8a",
    pants: "#3a4a3a",
    home: "desk1a",
    speed: 17,
    label: true,
    deskStates: ["coding", "debugging", "typing", "coding"],
    trips: [
      { kind: "coffee", w: 2 },
      { kind: "colleague", w: 1 },
      { kind: "fridge", w: 1 },
    ],
    tripChance: 0.18,
  },
  {
    name: "Eve",
    role: "Designer",
    hair: "#2a1e1a",
    skin: "#a8724e",
    shirt: "#d9ad24",
    pants: "#2a2a3a",
    home: "desk2a",
    speed: 19,
    label: false,
    deskStates: ["typing", "reviewing", "thinking"],
    trips: [
      { kind: "shelf", w: 1 },
      { kind: "sofa", w: 1 },
      { kind: "colleague", w: 2 },
    ],
    tripChance: 0.22,
  },
  {
    name: "Finn",
    role: "QA",
    hair: "#e0b54a",
    skin: "#f1c7a0",
    shirt: "#c4553a",
    pants: "#3a3a4a",
    home: "desk2b",
    speed: 21,
    label: false,
    deskStates: ["debugging", "reviewing", "typing"],
    trips: [
      { kind: "colleague", w: 2 },
      { kind: "coffee", w: 1 },
      { kind: "sofa", w: 1 },
    ],
    tripChance: 0.2,
  },
];
