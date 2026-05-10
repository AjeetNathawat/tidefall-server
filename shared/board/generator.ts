import type { BoardState, HexId } from "../game/types";
import { mulberry32 } from "./rng";
import {
  buildGraph,
  buildPorts,
  assignTerrainAndNumbers,
  buildRollLookup,
} from "./geometry";

/** Produce a complete, deterministic BoardState from a seed. */
export function generateBoard(seed: number): BoardState {
  const rng = mulberry32(seed);

  // 1) Topology
  const { hexes, vertices, edges } = buildGraph();

  // 2) Terrain + numbers (with red-adjacency avoidance)
  assignTerrainAndNumbers(hexes, rng, { avoidRedAdjacency: true });

  // 3) Ports — corrected placement
  const { ports, vertexPort, edgePort } = buildPorts(hexes, vertices, edges, rng);

  // Apply port refs back to vertices/edges
  for (const v of vertices) {
    const p = vertexPort.get(v.id);
    if (p !== undefined) (v as { port?: number }).port = p;
  }
  for (const e of edges) {
    const p = edgePort.get(e.id);
    if (p !== undefined) (e as { port?: number }).port = p;
  }

  // 4) Robber starts on the desert
  const desertHex = hexes.find((h) => h.terrain === "desert");
  const robberHex: HexId = desertHex ? desertHex.id : 0;

  // 5) Roll lookup
  const rollLookup = buildRollLookup(hexes);

  return {
    hexes,
    vertices,
    edges,
    ports,
    robberHex,
    rollLookup,
  };
}
