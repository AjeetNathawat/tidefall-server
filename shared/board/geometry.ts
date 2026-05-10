import type {
  Hex,
  Vertex,
  Edge,
  PortSlot,
  PortSlotId,
  PortType,
  HexId,
  VertexId,
  EdgeId,
  Terrain,
} from "../game/types";
import { type RNG, shuffle } from "./rng";

// ====== Hex grid constants ======
// HEX_W is point-to-point width along the side (flat-to-flat for pointy-top: also HEX_W).
// For pointy-top hexes, vertical height = HEX_W * 2 / sqrt(3).
// Adjacent hexes MUST share corners exactly — no gap in the math.
// Visual gaps are achieved via CSS (clip-path inset) without disturbing geometry.
export const HEX_W = 120; // flat-to-flat width
export const HEX_H = (HEX_W * 2) / Math.sqrt(3); // ≈ 138.564 — point-to-point height
export const APOTHEM = HEX_W / 2; // center → flat edge midpoint (60)
export const HEX_RADIUS = HEX_H / 2; // center → corner (≈ 69.28)
const COL_STEP = HEX_W; // adjacent column hexes share an edge — no gap
const ROW_STEP = (HEX_H * 3) / 4; // ≈ 103.92 — proper pointy-top row spacing

const ROWS: readonly number[] = [3, 4, 5, 4, 3];

/** Pixel center of hex at (rowIdx, colIdx). */
function hexCenter(rowIdx: number, colIdx: number): { cx: number; cy: number } {
  const rowLen = ROWS[rowIdx]!;
  const xOffset = ((5 - rowLen) * COL_STEP) / 2;
  return {
    cx: xOffset + colIdx * COL_STEP + HEX_W / 2,
    cy: rowIdx * ROW_STEP + HEX_H / 2,
  };
}

/** Pointy-top corner offsets, clockwise from top. */
function cornerOffsets(): readonly (readonly [number, number])[] {
  const out: [number, number][] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 90);
    out.push([Math.cos(angle) * HEX_RADIUS, Math.sin(angle) * HEX_RADIUS]);
  }
  return out;
}

const CORNERS = cornerOffsets();

/** Build hex/vertex/edge graph from row layout. Pure & deterministic. */
export function buildGraph(): {
  hexes: Hex[];
  vertices: Vertex[];
  edges: Edge[];
} {
  const hexes: Hex[] = [];
  const vertMap = new Map<string, Vertex>();
  const verts: Vertex[] = [];
  const edgeMap = new Map<string, Edge>();
  const edges: Edge[] = [];

  // 1) Place hexes
  let id = 0;
  ROWS.forEach((len, rowIdx) => {
    for (let col = 0; col < len; col++) {
      const { cx, cy } = hexCenter(rowIdx, col);
      hexes.push({
        id: id++,
        row: rowIdx,
        col,
        cx,
        cy,
        terrain: "desert", // assigned later
        number: null,
        vertices: [],
      });
    }
  });

  // 2) Compute vertices (dedup by rounded coords) and edges
  for (const h of hexes) {
    const cornerIds: VertexId[] = [];
    for (let i = 0; i < 6; i++) {
      const [dx, dy] = CORNERS[i]!;
      const px = Math.round((h.cx + dx) * 100) / 100;
      const py = Math.round((h.cy + dy) * 100) / 100;
      const key = `${px}|${py}`;
      let v = vertMap.get(key);
      if (!v) {
        v = {
          id: verts.length,
          x: px,
          y: py,
          hexes: [],
          adjacentVertices: [],
          edges: [],
        };
        vertMap.set(key, v);
        verts.push(v);
      }
      (v.hexes as HexId[]).push(h.id);
      cornerIds.push(v.id);
    }
    (h.vertices as VertexId[]) = cornerIds;

    for (let i = 0; i < 6; i++) {
      const a = cornerIds[i]!;
      const b = cornerIds[(i + 1) % 6]!;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const k = `${lo}-${hi}`;
      let e = edgeMap.get(k);
      if (!e) {
        e = {
          id: edges.length,
          vertexA: lo,
          vertexB: hi,
          hexes: [],
        };
        edgeMap.set(k, e);
        edges.push(e);
      }
      (e.hexes as HexId[]).push(h.id);
    }
  }

  // 3) Vertex adjacency from edges
  for (const e of edges) {
    const a = verts[e.vertexA]!;
    const b = verts[e.vertexB]!;
    (a.adjacentVertices as VertexId[]).push(e.vertexB);
    (b.adjacentVertices as VertexId[]).push(e.vertexA);
    (a.edges as EdgeId[]).push(e.id);
    (b.edges as EdgeId[]).push(e.id);
  }

  return { hexes, vertices: verts, edges };
}

// ====== Port placement (THE FIX) ======
//
// Algorithm:
// 1. Find coastal edges = edges where exactly 1 hex borders them
// 2. Walk the coastal-edge ring in order (each coastal vertex has exactly 2
//    coastal edges incident to it, forming a closed cycle)
// 3. Pick 9 evenly-spaced indices around the ring
// 4. For each, compute outward normal from adjacent hex center → edge midpoint
// 5. Place dock at midpoint + normal * DOCK_OFFSET (well outside the hex)
// 6. Shuffle 9 port types into the 9 slots
//
// This guarantees: every port sits in the ocean, never overlaps any hex.

const DOCK_OFFSET = APOTHEM * 1.25; // ≈ 75px from edge midpoint — outside hex but close enough to read as a coast dock

/** Return coastal edges in order around the perimeter (closed ring). */
function orderPerimeter(coastal: readonly Edge[], _vertices: readonly Vertex[]): Edge[] {
  if (coastal.length === 0) return [];
  // Index coastal edges by vertex
  const byVertex = new Map<VertexId, EdgeId[]>();
  for (const e of coastal) {
    const arrA = byVertex.get(e.vertexA) ?? [];
    arrA.push(e.id);
    byVertex.set(e.vertexA, arrA);
    const arrB = byVertex.get(e.vertexB) ?? [];
    arrB.push(e.id);
    byVertex.set(e.vertexB, arrB);
  }
  const byId = new Map(coastal.map((e) => [e.id, e] as const));

  const ring: Edge[] = [];
  const used = new Set<EdgeId>();
  let current = coastal[0]!;
  let prevVertex: VertexId | null = null;

  while (ring.length < coastal.length) {
    ring.push(current);
    used.add(current.id);
    const nextVertex: VertexId =
      current.vertexA === prevVertex ? current.vertexB : current.vertexA;
    const candidates = byVertex.get(nextVertex) ?? [];
    const nextId = candidates.find((id) => id !== current.id && !used.has(id));
    if (nextId === undefined) break;
    current = byId.get(nextId)!;
    prevVertex = nextVertex;
  }
  return ring;
}

/** Build port slots with corrected placement. */
export function buildPorts(
  hexes: readonly Hex[],
  vertices: readonly Vertex[],
  edges: readonly Edge[],
  rng: RNG,
): { ports: PortSlot[]; vertexPort: Map<VertexId, PortSlotId>; edgePort: Map<EdgeId, PortSlotId> } {
  // 1. Coastal edges: edge.hexes.length === 1 AND both endpoints are coastal vertices
  const coastal = edges.filter(
    (e) =>
      e.hexes.length === 1 &&
      vertices[e.vertexA]!.hexes.length < 3 &&
      vertices[e.vertexB]!.hexes.length < 3,
  );

  // 2. Order them around the perimeter
  const ring = orderPerimeter(coastal, vertices);

  // 3. Pick 9 evenly-spaced indices (no two adjacent in ring order)
  const N = ring.length; // 30 for standard Catan
  const slotCount = 9;
  const stride = N / slotCount; // 3.33...
  const slotEdges = Array.from({ length: slotCount }, (_, i) => ring[Math.floor(i * stride)]!);

  // 4. Shuffle port types into slots
  const types: PortType[] = [
    { kind: "generic", ratio: 3 },
    { kind: "generic", ratio: 3 },
    { kind: "generic", ratio: 3 },
    { kind: "generic", ratio: 3 },
    { kind: "specific", resource: "brick", ratio: 2 },
    { kind: "specific", resource: "lumber", ratio: 2 },
    { kind: "specific", resource: "ore", ratio: 2 },
    { kind: "specific", resource: "grain", ratio: 2 },
    { kind: "specific", resource: "wool", ratio: 2 },
  ];
  const shuffledTypes = shuffle(types, rng);

  const ports: PortSlot[] = [];
  const vertexPort = new Map<VertexId, PortSlotId>();
  const edgePort = new Map<EdgeId, PortSlotId>();

  for (let i = 0; i < slotEdges.length; i++) {
    const e = slotEdges[i]!;
    const a = vertices[e.vertexA]!;
    const b = vertices[e.vertexB]!;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;

    // Outward normal: from adjacent hex's center to edge midpoint
    const h = hexes[e.hexes[0]!]!;
    let nx = mx - h.cx;
    let ny = my - h.cy;
    const nlen = Math.hypot(nx, ny) || 1;
    nx /= nlen;
    ny /= nlen;

    const dockX = mx + nx * DOCK_OFFSET;
    const dockY = my + ny * DOCK_OFFSET;

    const slot: PortSlot = {
      id: i,
      edgeId: e.id,
      accessVertices: [e.vertexA, e.vertexB],
      edgeMidX: mx,
      edgeMidY: my,
      normalX: nx,
      normalY: ny,
      dockX,
      dockY,
      type: shuffledTypes[i]!,
    };
    ports.push(slot);
    vertexPort.set(e.vertexA, i);
    vertexPort.set(e.vertexB, i);
    edgePort.set(e.id, i);
  }

  return { ports, vertexPort, edgePort };
}

// ====== Terrain & number assignment ======
const TERRAIN_BAG: readonly Terrain[] = [
  "forest",
  "forest",
  "forest",
  "forest",
  "fields",
  "fields",
  "fields",
  "fields",
  "pasture",
  "pasture",
  "pasture",
  "pasture",
  "hills",
  "hills",
  "hills",
  "mountains",
  "mountains",
  "mountains",
  "desert",
];

// Standard Catan token order (letter-based placement). 18 tokens (skip desert).
const NUMBER_BAG: readonly number[] = [5, 2, 6, 3, 8, 10, 9, 12, 11, 4, 8, 10, 9, 4, 5, 6, 3, 11];

/** Returns true if any 6/8 token is adjacent to another 6/8 token. */
function hasRedAdjacency(hexes: readonly Hex[]): boolean {
  for (let i = 0; i < hexes.length; i++) {
    const a = hexes[i]!;
    if (a.number !== 6 && a.number !== 8) continue;
    for (let j = i + 1; j < hexes.length; j++) {
      const b = hexes[j]!;
      if (b.number !== 6 && b.number !== 8) continue;
      if (areAdjacentHexes(a, b)) return true;
    }
  }
  return false;
}

function areAdjacentHexes(a: Hex, b: Hex): boolean {
  const dx = Math.abs(a.cx - b.cx);
  const dy = Math.abs(a.cy - b.cy);
  // Adjacent hexes are within ~1 hex spacing
  return Math.hypot(dx, dy) < HEX_W * 1.2 && (dx > 1 || dy > 1);
}

/** Assign terrain (shuffled) and numbers (in fixed order to non-desert hexes). */
export function assignTerrainAndNumbers(
  hexes: Hex[],
  rng: RNG,
  options: { avoidRedAdjacency?: boolean } = {},
): void {
  const avoidRed = options.avoidRedAdjacency ?? true;
  const MAX_ATTEMPTS = 200;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const terrains = shuffle(TERRAIN_BAG, rng);
    let numIdx = 0;
    for (let i = 0; i < hexes.length; i++) {
      const h = hexes[i]!;
      h.terrain = terrains[i]!;
      h.number = h.terrain === "desert" ? null : NUMBER_BAG[numIdx++]!;
    }
    if (!avoidRed || !hasRedAdjacency(hexes)) return;
  }
  // Fall through: keep last attempt even if not perfectly balanced
}

// ====== Roll lookup ======
export function buildRollLookup(
  hexes: readonly Hex[],
): Readonly<Record<number, readonly HexId[]>> {
  const lookup: Record<number, HexId[]> = {};
  for (const h of hexes) {
    if (h.number == null) continue;
    if (!lookup[h.number]) lookup[h.number] = [];
    lookup[h.number]!.push(h.id);
  }
  return lookup;
}

// ====== Helpers ======
export function hexCenterPx(h: Hex): { x: number; y: number } {
  return { x: h.cx, y: h.cy };
}

export function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

/** Bounding box of all hexes — useful for sizing the board container. */
export function boardBounds(hexes: readonly Hex[]): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
} {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const h of hexes) {
    if (h.cx - HEX_W / 2 < minX) minX = h.cx - HEX_W / 2;
    if (h.cx + HEX_W / 2 > maxX) maxX = h.cx + HEX_W / 2;
    if (h.cy - HEX_H / 2 < minY) minY = h.cy - HEX_H / 2;
    if (h.cy + HEX_H / 2 > maxY) maxY = h.cy + HEX_H / 2;
  }
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}
