import type {
  GameState,
  PlayerId,
  PlayerState,
  PlayerColor,
  PieceState,
  ResourceCounts,
  DevCardType,
  VertexId,
  EdgeId,
  Action,
  Result,
} from "./types";
import {
  PLAYER_COLORS,
  ZERO_RESOURCES,
  BANK_PER_RESOURCE,
  ok,
  err,
} from "./types";
import { generateBoard } from "../board/generator";
import { getVariant } from "../board/variants";
import { mulberry32, shuffle } from "../board/rng";

export interface InitParams {
  roomCode: string;
  seed: number;
  players: { id: PlayerId; name: string }[];
  /** Optional variant id; defaults to "drowning_isles". */
  variantId?: string;
}

/** Build initial GameState. Phase: setup_round_1. */
export function initGame(params: InitParams): GameState {
  const { roomCode, seed, players, variantId } = params;
  const variant = getVariant(variantId);
  const board = generateBoard(seed, variant.id);
  const rng = mulberry32(seed ^ 0xdeadbeef);

  // Build dev deck (25 cards) and shuffle
  const devDeck = shuffle<DevCardType>(
    [
      ...Array<DevCardType>(14).fill("knight"),
      ...Array<DevCardType>(5).fill("victory_point"),
      ...Array<DevCardType>(2).fill("road_building"),
      ...Array<DevCardType>(2).fill("year_of_plenty"),
      ...Array<DevCardType>(2).fill("monopoly"),
    ],
    rng,
  );

  const playerStates: PlayerState[] = players.map((p, i) => ({
    id: p.id,
    name: p.name,
    color: PLAYER_COLORS[i % PLAYER_COLORS.length] as PlayerColor,
    hand: { ...ZERO_RESOURCES },
    devCards: { hand: [], pending: [], played: [] },
    pieces: { roads: 15, settlements: 5, cities: 4 },
    publicVP: 0,
    hiddenVP: 0,
  }));

  const pieces: PieceState = {
    settlements: {},
    cities: {},
    roads: {},
  };

  const bank: ResourceCounts = {
    brick: BANK_PER_RESOURCE,
    lumber: BANK_PER_RESOURCE,
    ore: BANK_PER_RESOURCE,
    grain: BANK_PER_RESOURCE,
    wool: BANK_PER_RESOURCE,
  };

  // Setup queue: forward order for round 1 (round 2 reverse handled by phase logic)
  const setupQueue = playerStates.map((p) => p.id);

  return {
    meta: {
      roomCode,
      seed,
      variantId: variant.id,
      vpTarget: variant.vpTarget,
      phase: "setup_round_1",
      sequence: 0,
      activePlayerId: playerStates[0]!.id,
      setupQueue,
      lastRoll: null,
      rolledThisTurn: false,
      devCardsBoughtThisTurn: 0,
      devCardPlayedThisTurn: false,
      pendingRobberPlayer: null,
      robberMovedTo: null,
      freeRoadsRemaining: 0,
    },
    board,
    players: playerStates,
    pieces,
    bank,
    devDeck,
    trades: [],
    longestRoad: { holderId: null, length: 0 },
    largestArmy: { holderId: null, count: 0 },
    pendingDiscards: [],
    log: [],
    winnerId: null,
  };
}

// ====== Read-only helpers used by UI ======

/** Vertices where `playerId` may legally place a settlement RIGHT NOW. */
export function validSettlementVertices(state: GameState, playerId: PlayerId): VertexId[] {
  const { board, pieces } = state;
  const occupied = new Set<VertexId>([
    ...Object.keys(pieces.settlements).map(Number),
    ...Object.keys(pieces.cities).map(Number),
  ]);
  const inSetup = state.meta.phase === "setup_round_1" || state.meta.phase === "setup_round_2";

  const valid: VertexId[] = [];
  for (const v of board.vertices) {
    if (occupied.has(v.id)) continue;
    // Distance rule: no neighbor vertex occupied
    if (v.adjacentVertices.some((nv) => occupied.has(nv))) continue;
    if (!inSetup) {
      // Must connect to one of player's roads
      const connected = v.edges.some((eid) => pieces.roads[eid] === playerId);
      if (!connected) continue;
    }
    valid.push(v.id);
  }
  return valid;
}

/** Edges where `playerId` may legally place a road RIGHT NOW. */
export function validRoadEdges(state: GameState, playerId: PlayerId): EdgeId[] {
  const { board, pieces } = state;
  const valid: EdgeId[] = [];
  for (const e of board.edges) {
    if (pieces.roads[e.id] !== undefined) continue;
    // Connect to one of player's existing roads or settlements/cities
    const a = board.vertices[e.vertexA]!;
    const b = board.vertices[e.vertexB]!;
    const ownsA =
      pieces.settlements[e.vertexA] === playerId || pieces.cities[e.vertexA] === playerId;
    const ownsB =
      pieces.settlements[e.vertexB] === playerId || pieces.cities[e.vertexB] === playerId;
    const connectedRoad = [...a.edges, ...b.edges].some(
      (eid) => eid !== e.id && pieces.roads[eid] === playerId,
    );
    if (ownsA || ownsB || connectedRoad) {
      valid.push(e.id);
    }
  }
  return valid;
}

/** Stub reducer — Phase 1a focuses on rendering; full reducer comes with multiplayer in 1b. */
export function reduce(state: GameState, action: Action): Result<GameState> {
  // Placeholder: just bump sequence. Actual rule logic lives in `apps/web` for the
  // local prototype until we extract for 1b's authoritative server.
  void action;
  return ok({
    ...state,
    meta: { ...state.meta, sequence: state.meta.sequence + 1 },
  });
}

export const Engine = {
  init: initGame,
  reduce,
  validSettlementVertices,
  validRoadEdges,
};
