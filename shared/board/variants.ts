import type { Terrain } from "../game/types";

/**
 * Board variant catalog — original Tidefall layouts.
 * Each variant is a parametric description the engine uses to build the board.
 * Same painted illustrations (HillsDecor, ForestDecor, etc.) render across all variants.
 */

export type VariantId = "drowning_isles" | "skerry" | "long_coast";

export interface VariantSpec {
  id: VariantId;
  displayName: string;
  description: string;
  /** Hex layout — one entry per row, value = number of hexes in that row. */
  rows: readonly number[];
  /** Terrain bag (must sum to total hex count). Shuffled into hex positions. */
  terrainBag: readonly Terrain[];
  /** Number-token bag (must equal total non-desert hex count). */
  numberBag: readonly number[];
  /** Number of port slots placed around the coastline. */
  portCount: number;
  /** Minimum and maximum players allowed in the lobby. */
  minPlayers: number;
  maxPlayers: number;
  /** Victory point threshold (10 = standard). */
  vpTarget: number;
}

function repeat<T>(value: T, count: number): T[] {
  return Array(count).fill(value);
}

// ============== Drowning Isles · the original 19-hex board ==============
// 4F / 4G / 4P / 3H / 3M / 1D = 19 hexes
// 3–4 players, 10 VP to win.
const DROWNING_ISLES: VariantSpec = {
  id: "drowning_isles",
  displayName: "Drowning Isles",
  description: "The classic 19-hex chart. Balanced for 3–4 settlers and a one-hour evening.",
  rows: [3, 4, 5, 4, 3],
  terrainBag: [
    ...repeat<Terrain>("forest", 4),
    ...repeat<Terrain>("fields", 4),
    ...repeat<Terrain>("pasture", 4),
    ...repeat<Terrain>("hills", 3),
    ...repeat<Terrain>("mountains", 3),
    "desert",
  ],
  // 18 tokens — one each of 2, 12 and two each of 3, 4, 5, 6, 8, 9, 10, 11.
  numberBag: [5, 2, 6, 3, 8, 10, 9, 12, 11, 4, 8, 10, 9, 4, 5, 6, 3, 11],
  portCount: 9,
  minPlayers: 3,
  maxPlayers: 4,
  vpTarget: 10,
};

// ============== Skerry · compact 10-hex pocket board ==============
// 2F / 2G / 2P / 2H / 1M / 1D = 10 hexes
// 2–3 players, 7 VP to win. Fast 20–30 min game.
const SKERRY: VariantSpec = {
  id: "skerry",
  displayName: "Skerry",
  description: "A tight 10-hex outpost. 2–3 settlers, 7 VP to win. A game in under half an hour.",
  rows: [3, 4, 3],
  terrainBag: [
    ...repeat<Terrain>("forest", 2),
    ...repeat<Terrain>("fields", 2),
    ...repeat<Terrain>("pasture", 2),
    ...repeat<Terrain>("hills", 2),
    "mountains",
    "desert",
  ],
  // 9 tokens (10 hexes − 1 desert) — skips 2 and 12 so the small board has no dead corners.
  numberBag: [3, 4, 5, 6, 8, 9, 10, 11, 5],
  portCount: 5,
  minPlayers: 2,
  maxPlayers: 3,
  vpTarget: 7,
};

// ============== Long Coast · sprawling 30-hex board ==============
// 6F / 6G / 6P / 5H / 5M / 2D = 30 hexes
// 4–6 players, 12 VP to win. Epic ~2-hour games.
const LONG_COAST: VariantSpec = {
  id: "long_coast",
  displayName: "Long Coast",
  description: "A 30-hex sprawl. 4–6 settlers, 12 VP to win. Plan for the long evening.",
  rows: [3, 4, 5, 6, 5, 4, 3],
  terrainBag: [
    ...repeat<Terrain>("forest", 6),
    ...repeat<Terrain>("fields", 6),
    ...repeat<Terrain>("pasture", 6),
    ...repeat<Terrain>("hills", 5),
    ...repeat<Terrain>("mountains", 5),
    ...repeat<Terrain>("desert", 2),
  ],
  // 28 tokens (30 hexes − 2 deserts) — the classic distribution scaled up:
  // 2 (×2), 3 (×3), 4 (×3), 5 (×3), 6 (×3), 8 (×3), 9 (×3), 10 (×3), 11 (×3), 12 (×2) = 28
  numberBag: [
    2, 12, 2, 12,
    3, 3, 3, 11, 11, 11,
    4, 4, 4, 10, 10, 10,
    5, 5, 5, 9, 9, 9,
    6, 6, 6, 8, 8, 8,
  ],
  portCount: 11,
  minPlayers: 4,
  maxPlayers: 6,
  vpTarget: 12,
};

export const VARIANTS: Record<VariantId, VariantSpec> = {
  drowning_isles: DROWNING_ISLES,
  skerry: SKERRY,
  long_coast: LONG_COAST,
};

export const DEFAULT_VARIANT: VariantId = "drowning_isles";

/** Look up by id, falling back to the default. Variant IDs from clients are trust-but-verify. */
export function getVariant(id: string | undefined): VariantSpec {
  if (id && id in VARIANTS) return VARIANTS[id as VariantId];
  return VARIANTS[DEFAULT_VARIANT];
}

/** Sanity: terrain bag length must equal total hexes, number bag must equal non-desert hexes. */
export function validateVariant(v: VariantSpec): void {
  const totalHexes = v.rows.reduce((a, b) => a + b, 0);
  if (v.terrainBag.length !== totalHexes) {
    throw new Error(
      `Variant ${v.id}: terrainBag has ${v.terrainBag.length} entries but rows total ${totalHexes}`,
    );
  }
  const desertCount = v.terrainBag.filter((t) => t === "desert").length;
  const expectedNumbers = totalHexes - desertCount;
  if (v.numberBag.length !== expectedNumbers) {
    throw new Error(
      `Variant ${v.id}: numberBag has ${v.numberBag.length} entries but expected ${expectedNumbers} (hexes − deserts)`,
    );
  }
}

// Self-check at module load so bad variants fail fast in dev.
for (const v of Object.values(VARIANTS)) validateVariant(v);
