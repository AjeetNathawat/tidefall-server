import type { BoardState, HexId } from "../game/types";
import { mulberry32 } from "./rng";
import {
  buildGraph,
  buildPorts,
  assignTerrainAndNumbers,
  buildRollLookup,
} from "./geometry";
import { getVariant, type VariantId } from "./variants";

/**
 * Produce a complete, deterministic BoardState from a seed + variant id.
 * The variant supplies hex layout, terrain bag, number bag, and port count;
 * the same painted Decor SVGs render across every variant.
 */
export function generateBoard(seed: number, variantId?: VariantId): BoardState {
  const variant = getVariant(variantId);
  const rng = mulberry32(seed);

  // 1) Topology — variant-defined rows
  const { hexes, vertices, edges } = buildGraph(variant.rows);

  // 2) Terrain + numbers from the variant bag (with red-6/8 adjacency avoidance)
  assignTerrainAndNumbers(hexes, rng, {
    terrainBag: variant.terrainBag,
    numberBag: variant.numberBag,
    avoidRedAdjacency: true,
  });

  // 3) Ports — variant-defined count
  const { ports, vertexPort, edgePort } = buildPorts(
    hexes,
    vertices,
    edges,
    rng,
    variant.portCount,
  );

  // Apply port refs back to vertices/edges
  for (const v of vertices) {
    const p = vertexPort.get(v.id);
    if (p !== undefined) (v as { port?: number }).port = p;
  }
  for (const e of edges) {
    const p = edgePort.get(e.id);
    if (p !== undefined) (e as { port?: number }).port = p;
  }

  // 4) Robber starts on the first desert (variants may have 0, 1, or 2 deserts)
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
