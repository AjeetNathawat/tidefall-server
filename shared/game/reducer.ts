import type {
  GameState,
  Action,
  PlayerId,
  Result,
  VertexId,
  EdgeId,
  HexId,
  Resource,
  ResourceCounts,
  PieceState,
  DevCardType,
} from "./types";
import {
  ok,
  err,
  TERRAIN_RESOURCE,
  COST_ROAD,
  COST_SETTLEMENT,
  COST_CITY,
  COST_DEV_CARD,
} from "./types";
import { mulberry32, rollDie } from "../board/rng";

// ============== Helpers ==============
function appendLog(state: GameState, text: string): GameState {
  return {
    ...state,
    log: [...state.log, { type: "log" as const, t: state.meta.sequence, text }],
  };
}

function bump(state: GameState): GameState {
  return { ...state, meta: { ...state.meta, sequence: state.meta.sequence + 1 } };
}

function spend(hand: ResourceCounts, cost: ResourceCounts): ResourceCounts {
  return {
    brick: hand.brick - cost.brick,
    lumber: hand.lumber - cost.lumber,
    ore: hand.ore - cost.ore,
    grain: hand.grain - cost.grain,
    wool: hand.wool - cost.wool,
  };
}

function add(hand: ResourceCounts, gain: ResourceCounts): ResourceCounts {
  return {
    brick: hand.brick + gain.brick,
    lumber: hand.lumber + gain.lumber,
    ore: hand.ore + gain.ore,
    grain: hand.grain + gain.grain,
    wool: hand.wool + gain.wool,
  };
}

function canAfford(hand: ResourceCounts, cost: ResourceCounts): boolean {
  return (
    hand.brick >= cost.brick &&
    hand.lumber >= cost.lumber &&
    hand.ore >= cost.ore &&
    hand.grain >= cost.grain &&
    hand.wool >= cost.wool
  );
}

function settlementsPlacedBy(state: GameState, playerId: PlayerId): VertexId[] {
  return Object.entries(state.pieces.settlements)
    .filter(([, o]) => o === playerId)
    .map(([vid]) => Number(vid));
}

function roadsPlacedBy(state: GameState, playerId: PlayerId): EdgeId[] {
  return Object.entries(state.pieces.roads)
    .filter(([, o]) => o === playerId)
    .map(([eid]) => Number(eid));
}

function isVertexOccupied(pieces: PieceState, vid: VertexId): boolean {
  return pieces.settlements[vid] !== undefined || pieces.cities[vid] !== undefined;
}

// ============== Validity ==============
export function validSettlementVertices(state: GameState, playerId: PlayerId): VertexId[] {
  const { board, pieces } = state;
  const inSetup = state.meta.phase === "setup_round_1" || state.meta.phase === "setup_round_2";
  const out: VertexId[] = [];
  for (const v of board.vertices) {
    if (isVertexOccupied(pieces, v.id)) continue;
    if (v.adjacentVertices.some((nv) => isVertexOccupied(pieces, nv))) continue;
    if (!inSetup) {
      // Must connect to one of player's roads
      const connected = v.edges.some((eid) => pieces.roads[eid] === playerId);
      if (!connected) continue;
    }
    out.push(v.id);
  }
  return out;
}

export function validRoadEdges(state: GameState, playerId: PlayerId, mustConnectTo?: VertexId): EdgeId[] {
  const { board, pieces } = state;
  const out: EdgeId[] = [];
  for (const e of board.edges) {
    if (pieces.roads[e.id] !== undefined) continue;
    if (mustConnectTo !== undefined) {
      if (e.vertexA !== mustConnectTo && e.vertexB !== mustConnectTo) continue;
      out.push(e.id);
      continue;
    }
    const a = board.vertices[e.vertexA]!;
    const b = board.vertices[e.vertexB]!;
    const ownsA = pieces.settlements[e.vertexA] === playerId || pieces.cities[e.vertexA] === playerId;
    const ownsB = pieces.settlements[e.vertexB] === playerId || pieces.cities[e.vertexB] === playerId;
    const connectedRoad = [...a.edges, ...b.edges].some(
      (eid) => eid !== e.id && pieces.roads[eid] === playerId,
    );
    if (ownsA || ownsB || connectedRoad) out.push(e.id);
  }
  return out;
}

// ============== Reducer ==============
/** Inner switch — applies one action; the exported `reduce` wraps this with a victory check. */
function applyAction(state: GameState, action: Action): Result<GameState> {
  switch (action.type) {
    case "PLACE_SETTLEMENT": return applyPlaceSettlement(state, action.playerId, action.vertexId);
    case "PLACE_ROAD":       return applyPlaceRoad(state, action.playerId, action.edgeId);
    case "PLACE_CITY":       return applyPlaceCity(state, action.playerId, action.vertexId);
    case "ROLL_DICE":        return applyRollDice(state, action.playerId);
    case "END_TURN":         return applyEndTurn(state, action.playerId);
    case "DISCARD":          return applyDiscard(state, action.playerId, action.cards);
    case "MOVE_ROBBER":      return applyMoveRobber(state, action.playerId, action.hexId);
    case "STEAL_FROM":       return applyStealFrom(state, action.playerId, action.victimId);
    case "BUY_DEV_CARD":     return applyBuyDevCard(state, action.playerId);
    case "PLAY_KNIGHT":      return applyPlayKnight(state, action.playerId);
    case "PLAY_ROAD_BUILDING": return applyPlayRoadBuilding(state, action.playerId);
    case "PLAY_YEAR_OF_PLENTY": return applyPlayYearOfPlenty(state, action.playerId, action.resources);
    case "PLAY_MONOPOLY":    return applyPlayMonopoly(state, action.playerId, action.resource);
    case "MARITIME_TRADE":   return applyMaritimeTrade(state, action.playerId, action.give, action.giveQty, action.receive);
    case "PROPOSE_TRADE":    return applyProposeTrade(state, action.playerId, action.give, action.want, action.targetPlayerId);
    case "ACCEPT_TRADE":     return applyAcceptTrade(state, action.playerId, action.tradeId);
    case "EXECUTE_TRADE":    return applyExecuteTrade(state, action.playerId, action.tradeId, action.counterpartyId);
    case "CANCEL_TRADE":     return applyCancelTrade(state, action.playerId, action.tradeId);
    default: {
      const _exhaustive: never = action;
      return err(`unsupported_action:${(_exhaustive as { type: string }).type}`);
    }
  }
}

/**
 * Total VP for a player including longest-road, largest-army, and hidden VP cards.
 * Used for victory check; not exposed to other players (we keep the hidden portion private).
 */
function totalVPFor(state: GameState, pid: PlayerId): number {
  const p = state.players[pid];
  if (!p) return 0;
  let total = p.publicVP + p.hiddenVP;
  if (state.longestRoad.holderId === pid) total += 2;
  if (state.largestArmy.holderId === pid) total += 2;
  return total;
}

/**
 * Public reducer: apply one action, then run a victory check.
 * Victory triggers when the active player's total VP (public + hidden + Longest Road +
 * Largest Army) reaches 10 on their own turn. Setup phases are exempt.
 */
export function reduce(state: GameState, action: Action): Result<GameState> {
  const result = applyAction(state, action);
  if (!result.ok) return result;
  const next = result.value;
  if (next.meta.phase === "setup_round_1" || next.meta.phase === "setup_round_2") return result;
  if (next.meta.phase === "game_over" || next.winnerId !== null) return result;

  const active = next.meta.activePlayerId;
  const target = next.meta.vpTarget;
  if (totalVPFor(next, active) >= target) {
    const winner = next.players[active]!;
    return ok({
      ...next,
      winnerId: active,
      meta: { ...next.meta, phase: "game_over" },
      log: [
        ...next.log,
        { type: "log", t: next.meta.sequence, text: `🏆 ${winner.name} wins with ${target}+ victory points!` },
      ],
    });
  }
  return result;
}

// --- Setup placement ---
function applyPlaceSettlement(state: GameState, pid: PlayerId, vid: VertexId): Result<GameState> {
  if (state.meta.activePlayerId !== pid) return err("not_your_turn");
  const { board } = state;
  const v = board.vertices[vid];
  if (!v) return err("invalid_vertex");
  if (isVertexOccupied(state.pieces, vid)) return err("vertex_occupied");
  if (v.adjacentVertices.some((nv) => isVertexOccupied(state.pieces, nv))) return err("distance_rule");

  const phase = state.meta.phase;
  const inSetup = phase === "setup_round_1" || phase === "setup_round_2";

  // In main play, must be connected to player's road and afford cost
  if (!inSetup) {
    if (phase !== "main_action") return err("invalid_phase");
    const me = state.players[pid]!;
    if (!canAfford(me.hand, COST_SETTLEMENT)) return err("insufficient_resources");
    const connected = v.edges.some((eid) => state.pieces.roads[eid] === pid);
    if (!connected) return err("must_connect_to_road");
  }

  // In setup, expect this is the player's "settlement step" (no road yet for this round's pair)
  if (inSetup) {
    const myS = settlementsPlacedBy(state, pid).length;
    const myR = roadsPlacedBy(state, pid).length;
    const expected = phase === "setup_round_1" ? 0 : 1;
    if (myS !== expected || myR !== expected) return err("not_settlement_step");
  }

  let nextState: GameState = {
    ...state,
    pieces: { ...state.pieces, settlements: { ...state.pieces.settlements, [vid]: pid } },
    players: state.players.map((p) =>
      p.id === pid
        ? {
            ...p,
            hand: inSetup ? p.hand : spend(p.hand, COST_SETTLEMENT),
            pieces: { ...p.pieces, settlements: p.pieces.settlements - 1 },
            publicVP: p.publicVP + 1,
          }
        : p,
    ),
  };
  if (!inSetup) {
    nextState = {
      ...nextState,
      bank: add(nextState.bank, COST_SETTLEMENT),
    };
  }
  // In round 2, gaining starting resources happens after the SECOND settlement is placed.
  if (phase === "setup_round_2") {
    const gained: ResourceCounts = { brick: 0, lumber: 0, ore: 0, grain: 0, wool: 0 };
    v.hexes.forEach((hid) => {
      const r = TERRAIN_RESOURCE[board.hexes[hid]!.terrain];
      if (r) gained[r]++;
    });
    const totalGained =
      gained.brick + gained.lumber + gained.ore + gained.grain + gained.wool;
    if (totalGained > 0) {
      nextState = {
        ...nextState,
        bank: spend(nextState.bank, gained),
        players: nextState.players.map((p) =>
          p.id === pid ? { ...p, hand: add(p.hand, gained) } : p,
        ),
      };
    }
  }

  nextState = appendLog(nextState, `${state.players[pid]!.name} placed a settlement.`);
  return ok(bump(nextState));
}

function applyPlaceRoad(state: GameState, pid: PlayerId, eid: EdgeId): Result<GameState> {
  if (state.meta.activePlayerId !== pid) return err("not_your_turn");
  const { board } = state;
  const e = board.edges[eid];
  if (!e) return err("invalid_edge");
  if (state.pieces.roads[eid] !== undefined) return err("edge_occupied");

  const phase = state.meta.phase;
  const inSetup = phase === "setup_round_1" || phase === "setup_round_2";

  if (!inSetup) {
    if (phase !== "main_action") return err("invalid_phase");
    const me = state.players[pid]!;
    const isFree = state.meta.freeRoadsRemaining > 0;
    if (!isFree && !canAfford(me.hand, COST_ROAD)) return err("insufficient_resources");
    const a = board.vertices[e.vertexA]!;
    const b = board.vertices[e.vertexB]!;
    const ownsA =
      state.pieces.settlements[e.vertexA] === pid || state.pieces.cities[e.vertexA] === pid;
    const ownsB =
      state.pieces.settlements[e.vertexB] === pid || state.pieces.cities[e.vertexB] === pid;
    const connectedRoad = [...a.edges, ...b.edges].some(
      (otherEid) => otherEid !== eid && state.pieces.roads[otherEid] === pid,
    );
    if (!ownsA && !ownsB && !connectedRoad) return err("must_connect_to_existing");
  }

  if (inSetup) {
    // Must connect to the latest unbuilt-pair settlement (the one without a road yet).
    const myS = settlementsPlacedBy(state, pid);
    const myR = roadsPlacedBy(state, pid);
    const expected = phase === "setup_round_1" ? 1 : 2;
    if (myS.length !== expected || myR.length !== expected - 1) return err("not_road_step");
    // The one without an adjacent road is the latest settlement
    const latestSett = myS.find((vid) => {
      const v = board.vertices[vid]!;
      return !v.edges.some((otherEid) => state.pieces.roads[otherEid] === pid);
    });
    if (latestSett === undefined) return err("no_pending_settlement");
    if (e.vertexA !== latestSett && e.vertexB !== latestSett) return err("road_must_connect_to_settlement");
  }

  const isFreeRoad = !inSetup && state.meta.freeRoadsRemaining > 0;
  let nextState: GameState = {
    ...state,
    pieces: { ...state.pieces, roads: { ...state.pieces.roads, [eid]: pid } },
    players: state.players.map((p) =>
      p.id === pid
        ? {
            ...p,
            hand: inSetup || isFreeRoad ? p.hand : spend(p.hand, COST_ROAD),
            pieces: { ...p.pieces, roads: p.pieces.roads - 1 },
          }
        : p,
    ),
  };
  if (!inSetup && !isFreeRoad) {
    nextState = { ...nextState, bank: add(nextState.bank, COST_ROAD) };
  }
  if (isFreeRoad) {
    nextState = {
      ...nextState,
      meta: { ...nextState.meta, freeRoadsRemaining: state.meta.freeRoadsRemaining - 1 },
    };
  }
  nextState = appendLog(nextState, `${state.players[pid]!.name} placed a road${isFreeRoad ? " (free)" : ""}.`);

  // Advance setup turn: after road placement, advance through setup queue
  if (inSetup) {
    nextState = advanceSetupTurn(nextState);
  }
  return ok(bump(nextState));
}

function advanceSetupTurn(state: GameState): GameState {
  const queue = state.meta.setupQueue;
  if (queue.length === 0) return state;

  const remaining = queue.slice(1);
  if (remaining.length > 0) {
    return {
      ...state,
      meta: {
        ...state.meta,
        setupQueue: remaining,
        activePlayerId: remaining[0]!,
      },
    };
  }
  // Finished current setup round
  if (state.meta.phase === "setup_round_1") {
    // Round 2 = reverse order
    const reverseQueue = state.players.map((p) => p.id).reverse();
    return appendLog(
      {
        ...state,
        meta: {
          ...state.meta,
          phase: "setup_round_2",
          setupQueue: reverseQueue,
          activePlayerId: reverseQueue[0]!,
        },
      },
      "Setup round 2 begins (reverse order).",
    );
  }
  // After round 2 → main play
  return appendLog(
    {
      ...state,
      meta: {
        ...state.meta,
        phase: "main_roll",
        setupQueue: [],
        activePlayerId: state.players[0]!.id,
        rolledThisTurn: false,
      },
    },
    `Setup complete. ${state.players[0]!.name}'s turn — roll the dice.`,
  );
}

// --- Main play: city ---
function applyPlaceCity(state: GameState, pid: PlayerId, vid: VertexId): Result<GameState> {
  if (state.meta.activePlayerId !== pid) return err("not_your_turn");
  if (state.meta.phase !== "main_action") return err("invalid_phase");
  if (state.pieces.settlements[vid] !== pid) return err("must_upgrade_own_settlement");
  const me = state.players[pid]!;
  if (!canAfford(me.hand, COST_CITY)) return err("insufficient_resources");
  if (me.pieces.cities <= 0) return err("no_cities_left");

  const settlements = { ...state.pieces.settlements };
  delete settlements[vid];
  const cities = { ...state.pieces.cities, [vid]: pid };

  const nextState: GameState = {
    ...state,
    pieces: { ...state.pieces, settlements, cities },
    bank: add(state.bank, COST_CITY),
    players: state.players.map((p) =>
      p.id === pid
        ? {
            ...p,
            hand: spend(p.hand, COST_CITY),
            pieces: { ...p.pieces, cities: p.pieces.cities - 1, settlements: p.pieces.settlements + 1 },
            publicVP: p.publicVP + 1,
          }
        : p,
    ),
  };
  return ok(bump(appendLog(nextState, `${me.name} raised a city.`)));
}

// --- Roll dice ---
function applyRollDice(state: GameState, pid: PlayerId): Result<GameState> {
  if (state.meta.activePlayerId !== pid) return err("not_your_turn");
  if (state.meta.phase !== "main_roll") return err("invalid_phase");

  const rng = mulberry32((state.meta.seed ^ state.meta.sequence ^ 0x12345) >>> 0);
  const d1 = rollDie(rng);
  const d2 = rollDie(rng);
  const sum = d1 + d2;

  let nextState: GameState = {
    ...state,
    meta: {
      ...state.meta,
      lastRoll: [d1, d2],
      rolledThisTurn: true,
    },
  };
  nextState = appendLog(nextState, `${state.players[pid]!.name} rolled ${sum}.`);

  if (sum === 7) {
    // Discard phase if any player has > 7 cards, then robber
    const pendingDiscards: PlayerId[] = [];
    state.players.forEach((p) => {
      const total = p.hand.brick + p.hand.lumber + p.hand.ore + p.hand.grain + p.hand.wool;
      if (total > 7) pendingDiscards.push(p.id);
    });
    if (pendingDiscards.length > 0) {
      return ok(bump({ ...nextState, meta: { ...nextState.meta, phase: "discard" }, pendingDiscards }));
    }
    return ok(bump({ ...nextState, meta: { ...nextState.meta, phase: "move_robber", pendingRobberPlayer: pid } }));
  }

  // Distribute resources
  const hits = state.board.rollLookup[sum] || [];
  const gainsByPlayer: Record<number, ResourceCounts> = {};
  state.players.forEach((p) => {
    gainsByPlayer[p.id] = { brick: 0, lumber: 0, ore: 0, grain: 0, wool: 0 };
  });

  for (const hid of hits) {
    if (hid === state.board.robberHex) continue;
    const hex = state.board.hexes[hid]!;
    const r = TERRAIN_RESOURCE[hex.terrain];
    if (!r) continue;
    for (const vid of hex.vertices) {
      const sOwner = state.pieces.settlements[vid];
      const cOwner = state.pieces.cities[vid];
      if (sOwner !== undefined) gainsByPlayer[sOwner]![r] += 1;
      if (cOwner !== undefined) gainsByPlayer[cOwner]![r] += 2;
    }
  }

  // Apply (subject to bank)
  let bank = { ...state.bank };
  const playerGain: Record<number, ResourceCounts> = {};
  for (const r of ["brick", "lumber", "ore", "grain", "wool"] as Resource[]) {
    let totalDemand = 0;
    state.players.forEach((p) => { totalDemand += gainsByPlayer[p.id]![r]; });
    const eligibleCount = state.players.filter((p) => gainsByPlayer[p.id]![r] > 0).length;
    if (totalDemand > bank[r]) {
      // Single eligible: receive remaining; multiple eligible: nobody gets any
      if (eligibleCount === 1) {
        const ePid = state.players.find((p) => gainsByPlayer[p.id]![r] > 0)!.id;
        playerGain[ePid] = playerGain[ePid] || { brick: 0, lumber: 0, ore: 0, grain: 0, wool: 0 };
        playerGain[ePid]![r] = bank[r];
        bank[r] = 0;
      }
      // else: skip, nobody gets any
    } else {
      state.players.forEach((p) => {
        const want = gainsByPlayer[p.id]![r];
        if (want > 0) {
          playerGain[p.id] = playerGain[p.id] || { brick: 0, lumber: 0, ore: 0, grain: 0, wool: 0 };
          playerGain[p.id]![r] = want;
        }
      });
      bank[r] -= totalDemand;
    }
  }

  nextState = {
    ...nextState,
    bank,
    players: nextState.players.map((p) => {
      const gain = playerGain[p.id];
      if (!gain) return p;
      return { ...p, hand: add(p.hand, gain) };
    }),
    meta: { ...nextState.meta, phase: "main_action" },
  };
  // Log resource distributions per player
  for (const p of state.players) {
    const gain = playerGain[p.id];
    if (!gain) continue;
    const total = gain.brick + gain.lumber + gain.ore + gain.grain + gain.wool;
    if (total === 0) continue;
    const parts: string[] = [];
    if (gain.brick) parts.push(`${gain.brick} brick`);
    if (gain.lumber) parts.push(`${gain.lumber} lumber`);
    if (gain.ore) parts.push(`${gain.ore} ore`);
    if (gain.grain) parts.push(`${gain.grain} grain`);
    if (gain.wool) parts.push(`${gain.wool} wool`);
    nextState = appendLog(nextState, `${p.name} received ${parts.join(", ")}.`);
  }
  return ok(bump(nextState));
}

function applyEndTurn(state: GameState, pid: PlayerId): Result<GameState> {
  if (state.meta.activePlayerId !== pid) return err("not_your_turn");
  if (state.meta.phase !== "main_action") return err("invalid_phase");
  const next = (pid + 1) % state.players.length;
  // Merge the active player's pending dev cards into their hand so they can play them next turn.
  const nextState: GameState = {
    ...state,
    players: state.players.map((p) =>
      p.id === pid
        ? {
            ...p,
            devCards: {
              ...p.devCards,
              hand: [...p.devCards.hand, ...p.devCards.pending],
              pending: [],
            },
          }
        : p,
    ),
    meta: {
      ...state.meta,
      activePlayerId: next as PlayerId,
      phase: "main_roll",
      lastRoll: null,
      rolledThisTurn: false,
      devCardsBoughtThisTurn: 0,
      devCardPlayedThisTurn: false,
      freeRoadsRemaining: 0,
    },
  };
  return ok(bump(appendLog(nextState, `${state.players[next]?.name ?? "?"}'s turn.`)));
}

function applyDiscard(state: GameState, pid: PlayerId, cards: Partial<ResourceCounts>): Result<GameState> {
  if (state.meta.phase !== "discard") return err("invalid_phase");
  if (!state.pendingDiscards.includes(pid)) return err("not_your_discard");
  const me = state.players[pid]!;
  const total = me.hand.brick + me.hand.lumber + me.hand.ore + me.hand.grain + me.hand.wool;
  const target = Math.floor(total / 2);
  const submitted =
    (cards.brick || 0) + (cards.lumber || 0) + (cards.ore || 0) + (cards.grain || 0) + (cards.wool || 0);
  if (submitted !== target) return err(`must_discard_${target}`);
  const drop: ResourceCounts = {
    brick: cards.brick || 0,
    lumber: cards.lumber || 0,
    ore: cards.ore || 0,
    grain: cards.grain || 0,
    wool: cards.wool || 0,
  };
  // Validate sufficient
  if (
    drop.brick > me.hand.brick ||
    drop.lumber > me.hand.lumber ||
    drop.ore > me.hand.ore ||
    drop.grain > me.hand.grain ||
    drop.wool > me.hand.wool
  ) {
    return err("insufficient_for_discard");
  }
  let nextState: GameState = {
    ...state,
    bank: add(state.bank, drop),
    players: state.players.map((p) =>
      p.id === pid ? { ...p, hand: spend(p.hand, drop) } : p,
    ),
    pendingDiscards: state.pendingDiscards.filter((x) => x !== pid),
  };
  if (nextState.pendingDiscards.length === 0) {
    nextState = {
      ...nextState,
      meta: {
        ...nextState.meta,
        phase: "move_robber",
        pendingRobberPlayer: nextState.meta.activePlayerId,
      },
    };
  }
  return ok(bump(appendLog(nextState, `${me.name} discarded ${target} cards.`)));
}

function applyMoveRobber(state: GameState, pid: PlayerId, hid: HexId): Result<GameState> {
  if (state.meta.phase !== "move_robber") return err("invalid_phase");
  if (state.meta.pendingRobberPlayer !== pid) return err("not_your_robber");
  if (hid === state.board.robberHex) return err("must_move_to_different_hex");
  if (hid < 0 || hid >= state.board.hexes.length) return err("invalid_hex");

  // Adjacent victims (other than self) with settlement/city on hex
  const hex = state.board.hexes[hid]!;
  const victims = new Set<PlayerId>();
  hex.vertices.forEach((vid) => {
    const so = state.pieces.settlements[vid];
    const co = state.pieces.cities[vid];
    if (so !== undefined && so !== pid) victims.add(so);
    if (co !== undefined && co !== pid) victims.add(co);
  });

  let nextState: GameState = {
    ...state,
    board: { ...state.board, robberHex: hid },
    meta: { ...state.meta, robberMovedTo: hid },
  };

  if (victims.size === 0) {
    nextState = {
      ...nextState,
      meta: { ...nextState.meta, phase: "main_action", pendingRobberPlayer: null, robberMovedTo: null },
    };
    return ok(bump(appendLog(nextState, `${state.players[pid]!.name} moved the Robber. No one to steal from.`)));
  }
  if (victims.size === 1) {
    // Auto-steal
    const victim = [...victims][0]!;
    return applyStealFrom(
      { ...nextState, meta: { ...nextState.meta, phase: "rob_player" } },
      pid,
      victim,
    );
  }
  // Multiple victims — wait for STEAL_FROM
  return ok(
    bump(
      appendLog(
        { ...nextState, meta: { ...nextState.meta, phase: "rob_player" } },
        `${state.players[pid]!.name} moved the Robber. Pick a victim.`,
      ),
    ),
  );
}

function applyStealFrom(state: GameState, pid: PlayerId, victimId: PlayerId | null): Result<GameState> {
  if (state.meta.phase !== "rob_player") return err("invalid_phase");
  if (state.meta.pendingRobberPlayer !== pid) return err("not_your_steal");
  let nextState: GameState = state;
  if (victimId !== null && victimId !== pid) {
    const victim = state.players[victimId];
    if (!victim) return err("invalid_victim");
    const pool: Resource[] = [];
    (Object.entries(victim.hand) as [Resource, number][]).forEach(([r, n]) => {
      for (let i = 0; i < n; i++) pool.push(r);
    });
    if (pool.length > 0) {
      const rng = mulberry32((state.meta.seed ^ state.meta.sequence ^ 0xabc) >>> 0);
      const r = pool[Math.floor(rng() * pool.length)]!;
      nextState = {
        ...nextState,
        players: nextState.players.map((p) => {
          if (p.id === pid) return { ...p, hand: { ...p.hand, [r]: p.hand[r] + 1 } };
          if (p.id === victimId) return { ...p, hand: { ...p.hand, [r]: p.hand[r] - 1 } };
          return p;
        }),
      };
      nextState = appendLog(nextState, `${state.players[pid]!.name} stole 1 card from ${victim.name}.`);
    } else {
      nextState = appendLog(nextState, `${victim.name} had no cards to steal.`);
    }
  }
  nextState = {
    ...nextState,
    meta: { ...nextState.meta, phase: "main_action", pendingRobberPlayer: null, robberMovedTo: null },
  };
  return ok(bump(nextState));
}

function applyBuyDevCard(state: GameState, pid: PlayerId): Result<GameState> {
  if (state.meta.activePlayerId !== pid) return err("not_your_turn");
  if (state.meta.phase !== "main_action") return err("invalid_phase");
  const me = state.players[pid]!;
  if (!canAfford(me.hand, COST_DEV_CARD)) return err("insufficient_resources");
  if (state.devDeck.length === 0) return err("dev_deck_empty");
  const card = state.devDeck[state.devDeck.length - 1]!;
  // VP cards bypass pending — they're "played" implicitly at win time.
  // Other cards go to `pending` so they can't be played until next turn.
  const nextState: GameState = {
    ...state,
    devDeck: state.devDeck.slice(0, -1),
    bank: add(state.bank, COST_DEV_CARD),
    players: state.players.map((p) =>
      p.id === pid
        ? {
            ...p,
            hand: spend(p.hand, COST_DEV_CARD),
            devCards: {
              ...p.devCards,
              pending: card === "victory_point" ? p.devCards.pending : [...p.devCards.pending, card],
            },
            hiddenVP: p.hiddenVP + (card === "victory_point" ? 1 : 0),
          }
        : p,
    ),
    meta: { ...state.meta, devCardsBoughtThisTurn: state.meta.devCardsBoughtThisTurn + 1 },
  };
  return ok(bump(appendLog(nextState, `${me.name} drew a development card.`)));
}

// --- Dev card play handlers ---

function removeFromHand(arr: readonly DevCardType[], type: DevCardType): DevCardType[] {
  const idx = arr.indexOf(type);
  if (idx < 0) return [...arr];
  return [...arr.slice(0, idx), ...arr.slice(idx + 1)];
}

function checkPlayCommon(state: GameState, pid: PlayerId, type: DevCardType): string | null {
  if (state.meta.activePlayerId !== pid) return "not_your_turn";
  if (state.meta.devCardPlayedThisTurn) return "card_already_played";
  const me = state.players[pid];
  if (!me) return "invalid_player";
  if (!me.devCards.hand.includes(type)) {
    if (me.devCards.pending.includes(type)) return "card_just_bought";
    return "card_not_in_hand";
  }
  return null;
}

function applyPlayKnight(state: GameState, pid: PlayerId): Result<GameState> {
  const phase = state.meta.phase;
  if (phase !== "main_roll" && phase !== "main_action") return err("invalid_phase");
  const guard = checkPlayCommon(state, pid, "knight");
  if (guard) return err(guard);
  const me = state.players[pid]!;
  // Recalculate Largest Army
  const myKnights = me.devCards.played.filter((c) => c === "knight").length + 1;
  let largestArmy = state.largestArmy;
  if (myKnights >= 3) {
    const currentHolder =
      largestArmy.holderId !== null ? state.players[largestArmy.holderId] : null;
    const currentCount = currentHolder
      ? currentHolder.devCards.played.filter((c) => c === "knight").length
      : 0;
    if (myKnights > currentCount) {
      largestArmy = { holderId: pid, count: myKnights };
    }
  }
  // Adjust public VP for largest army change
  const players = state.players.map((p) => {
    if (p.id === pid) {
      return {
        ...p,
        devCards: {
          ...p.devCards,
          hand: removeFromHand(p.devCards.hand, "knight"),
          played: [...p.devCards.played, "knight" as DevCardType],
        },
        publicVP:
          p.publicVP +
          // gained largest army (was not me, now is me)
          (largestArmy.holderId === pid && state.largestArmy.holderId !== pid ? 2 : 0),
      };
    }
    if (state.largestArmy.holderId === p.id && largestArmy.holderId !== p.id) {
      return { ...p, publicVP: Math.max(0, p.publicVP - 2) };
    }
    return p;
  });

  let nextState: GameState = {
    ...state,
    players,
    largestArmy,
    meta: {
      ...state.meta,
      devCardPlayedThisTurn: true,
      phase: "move_robber",
      pendingRobberPlayer: pid,
    },
  };
  nextState = appendLog(nextState, `${me.name} played a Knight.`);
  if (largestArmy.holderId === pid && state.largestArmy.holderId !== pid) {
    nextState = appendLog(
      nextState,
      `${me.name} now holds Largest Army (${myKnights} knights, +2 VP).`,
    );
  }
  return ok(bump(nextState));
}

function applyPlayRoadBuilding(state: GameState, pid: PlayerId): Result<GameState> {
  if (state.meta.phase !== "main_action") return err("invalid_phase");
  const guard = checkPlayCommon(state, pid, "road_building");
  if (guard) return err(guard);
  const me = state.players[pid]!;
  const remainingPieceRoads = me.pieces.roads;
  const freeRoads = Math.min(2, remainingPieceRoads);
  const nextState: GameState = {
    ...state,
    players: state.players.map((p) =>
      p.id === pid
        ? {
            ...p,
            devCards: {
              ...p.devCards,
              hand: removeFromHand(p.devCards.hand, "road_building"),
              played: [...p.devCards.played, "road_building"],
            },
          }
        : p,
    ),
    meta: { ...state.meta, devCardPlayedThisTurn: true, freeRoadsRemaining: freeRoads },
  };
  return ok(
    bump(
      appendLog(
        nextState,
        `${me.name} played Road Building. Place ${freeRoads} free road${freeRoads === 1 ? "" : "s"}.`,
      ),
    ),
  );
}

function applyPlayYearOfPlenty(
  state: GameState,
  pid: PlayerId,
  resources: readonly [Resource, Resource],
): Result<GameState> {
  if (state.meta.phase !== "main_action") return err("invalid_phase");
  const guard = checkPlayCommon(state, pid, "year_of_plenty");
  if (guard) return err(guard);
  const me = state.players[pid]!;
  const gain: ResourceCounts = { brick: 0, lumber: 0, ore: 0, grain: 0, wool: 0 };
  for (const r of resources) gain[r]++;
  // Bank check
  if (
    state.bank.brick < gain.brick ||
    state.bank.lumber < gain.lumber ||
    state.bank.ore < gain.ore ||
    state.bank.grain < gain.grain ||
    state.bank.wool < gain.wool
  ) {
    return err("bank_insufficient");
  }
  const nextState: GameState = {
    ...state,
    bank: spend(state.bank, gain),
    players: state.players.map((p) =>
      p.id === pid
        ? {
            ...p,
            hand: add(p.hand, gain),
            devCards: {
              ...p.devCards,
              hand: removeFromHand(p.devCards.hand, "year_of_plenty"),
              played: [...p.devCards.played, "year_of_plenty"],
            },
          }
        : p,
    ),
    meta: { ...state.meta, devCardPlayedThisTurn: true },
  };
  return ok(
    bump(
      appendLog(
        nextState,
        `${me.name} played Year of Plenty: took 1 ${resources[0]} + 1 ${resources[1]}.`,
      ),
    ),
  );
}

function applyPlayMonopoly(state: GameState, pid: PlayerId, resource: Resource): Result<GameState> {
  if (state.meta.phase !== "main_action") return err("invalid_phase");
  const guard = checkPlayCommon(state, pid, "monopoly");
  if (guard) return err(guard);
  const me = state.players[pid]!;
  let claimed = 0;
  const players = state.players.map((p) => {
    if (p.id === pid) return p;
    claimed += p.hand[resource];
    return { ...p, hand: { ...p.hand, [resource]: 0 } };
  });
  const finalPlayers = players.map((p) =>
    p.id === pid
      ? {
          ...p,
          hand: { ...p.hand, [resource]: p.hand[resource] + claimed },
          devCards: {
            ...p.devCards,
            hand: removeFromHand(p.devCards.hand, "monopoly"),
            played: [...p.devCards.played, "monopoly" as DevCardType],
          },
        }
      : p,
  );
  return ok(
    bump(
      appendLog(
        { ...state, players: finalPlayers, meta: { ...state.meta, devCardPlayedThisTurn: true } },
        `${me.name} played Monopoly: claimed ${claimed} ${resource} from opponents.`,
      ),
    ),
  );
}

/**
 * Compute the best maritime trade ratio a player has for each resource.
 * - 2 if they have a settlement/city on a 2:1 port for that specific resource
 * - 3 if they have a settlement/city on a 3:1 generic port
 * - 4 default
 */
export function bestMaritimeRatios(
  state: GameState,
  pid: PlayerId,
): Record<Resource, 2 | 3 | 4> {
  const result: Record<Resource, 2 | 3 | 4> = {
    brick: 4,
    lumber: 4,
    ore: 4,
    grain: 4,
    wool: 4,
  };
  // Collect port slot IDs reached by this player's settlements/cities
  const myPortSlots = new Set<number>();
  for (const [vidStr, owner] of Object.entries(state.pieces.settlements)) {
    if (owner !== pid) continue;
    const v = state.board.vertices[Number(vidStr)];
    if (v?.port !== undefined) myPortSlots.add(v.port);
  }
  for (const [vidStr, owner] of Object.entries(state.pieces.cities)) {
    if (owner !== pid) continue;
    const v = state.board.vertices[Number(vidStr)];
    if (v?.port !== undefined) myPortSlots.add(v.port);
  }
  for (const slotId of myPortSlots) {
    const port = state.board.ports[slotId];
    if (!port) continue;
    if (port.type.kind === "generic") {
      // 3:1 — improves only if currently 4
      const RES: Resource[] = ["brick", "lumber", "ore", "grain", "wool"];
      for (const r of RES) {
        if (result[r] === 4) result[r] = 3;
      }
    } else {
      // 2:1 specific
      result[port.type.resource] = 2;
    }
  }
  return result;
}

function applyMaritimeTrade(
  state: GameState,
  pid: PlayerId,
  give: Resource,
  giveQty: 2 | 3 | 4,
  receive: Resource,
): Result<GameState> {
  if (state.meta.activePlayerId !== pid) return err("not_your_turn");
  if (state.meta.phase !== "main_action") return err("invalid_phase");
  const me = state.players[pid]!;
  if (give === receive) return err("same_resource");
  // Validate the requested ratio matches the player's actual port access.
  const ratios = bestMaritimeRatios(state, pid);
  const requiredQty = ratios[give];
  if (giveQty !== requiredQty) return err(`bad_ratio_for_${give}_have_${requiredQty}_to_1`);
  if (me.hand[give] < giveQty) return err("insufficient_resources");
  if (state.bank[receive] < 1) return err("bank_empty");
  const nextState: GameState = {
    ...state,
    bank: { ...state.bank, [give]: state.bank[give] + giveQty, [receive]: state.bank[receive] - 1 },
    players: state.players.map((p) =>
      p.id === pid
        ? { ...p, hand: { ...p.hand, [give]: p.hand[give] - giveQty, [receive]: p.hand[receive] + 1 } }
        : p,
    ),
  };
  return ok(bump(appendLog(nextState, `${me.name} traded ${giveQty} ${give} → 1 ${receive} (${giveQty}:1).`)));
}

// ============== Player-to-player trading ==============

function partialTotal(p: Partial<ResourceCounts>): number {
  return (p.brick || 0) + (p.lumber || 0) + (p.ore || 0) + (p.grain || 0) + (p.wool || 0);
}

function hasPartial(hand: ResourceCounts, p: Partial<ResourceCounts>): boolean {
  return (
    hand.brick >= (p.brick || 0) &&
    hand.lumber >= (p.lumber || 0) &&
    hand.ore >= (p.ore || 0) &&
    hand.grain >= (p.grain || 0) &&
    hand.wool >= (p.wool || 0)
  );
}

function partialToFull(p: Partial<ResourceCounts>): ResourceCounts {
  return {
    brick: p.brick || 0,
    lumber: p.lumber || 0,
    ore: p.ore || 0,
    grain: p.grain || 0,
    wool: p.wool || 0,
  };
}

function nextTradeId(state: GameState): string {
  return `t-${state.meta.sequence}-${state.trades.length}`;
}

function applyProposeTrade(
  state: GameState,
  pid: PlayerId,
  give: Partial<ResourceCounts>,
  want: Partial<ResourceCounts>,
  targetPlayerId?: PlayerId,
): Result<GameState> {
  if (state.meta.activePlayerId !== pid) return err("not_your_turn");
  if (state.meta.phase !== "main_action") return err("invalid_phase");
  const giveTotal = partialTotal(give);
  const wantTotal = partialTotal(want);
  if (giveTotal === 0 || wantTotal === 0) return err("empty_offer");
  const me = state.players[pid]!;
  if (!hasPartial(me.hand, give)) return err("insufficient_resources");

  const trade = {
    id: nextTradeId(state),
    fromPlayerId: pid,
    give,
    want,
    acceptedBy: [] as PlayerId[],
    ...(targetPlayerId !== undefined ? { targetPlayerId } : {}),
  };
  const desc = describeTrade(give, want);
  return ok(
    bump(
      appendLog(
        { ...state, trades: [...state.trades, trade] },
        `${me.name} proposed a trade: ${desc}.`,
      ),
    ),
  );
}

function describeTrade(give: Partial<ResourceCounts>, want: Partial<ResourceCounts>): string {
  const giveStr = (Object.entries(give) as [Resource, number][])
    .filter(([, n]) => n > 0)
    .map(([r, n]) => `${n} ${r}`)
    .join(" + ");
  const wantStr = (Object.entries(want) as [Resource, number][])
    .filter(([, n]) => n > 0)
    .map(([r, n]) => `${n} ${r}`)
    .join(" + ");
  return `give ${giveStr} → want ${wantStr}`;
}

function applyAcceptTrade(state: GameState, pid: PlayerId, tradeId: string): Result<GameState> {
  if (pid === state.meta.activePlayerId) return err("cannot_accept_own_trade");
  const trade = state.trades.find((t) => t.id === tradeId);
  if (!trade) return err("trade_not_found");
  if (trade.targetPlayerId !== undefined && trade.targetPlayerId !== pid) {
    return err("not_targeted_at_you");
  }
  const me = state.players[pid]!;
  // Acceptor must have what the initiator wants (since acceptor will give it)
  if (!hasPartial(me.hand, trade.want)) return err("insufficient_resources");
  if (trade.acceptedBy.includes(pid)) return ok(state); // idempotent

  const updatedTrades = state.trades.map((t) =>
    t.id === tradeId ? { ...t, acceptedBy: [...t.acceptedBy, pid] } : t,
  );
  return ok(
    bump(appendLog({ ...state, trades: updatedTrades }, `${me.name} accepted the trade.`)),
  );
}

function applyExecuteTrade(
  state: GameState,
  pid: PlayerId,
  tradeId: string,
  counterpartyId: PlayerId,
): Result<GameState> {
  if (pid !== state.meta.activePlayerId) return err("not_your_turn");
  const trade = state.trades.find((t) => t.id === tradeId);
  if (!trade) return err("trade_not_found");
  if (trade.fromPlayerId !== pid) return err("not_your_trade");
  if (!trade.acceptedBy.includes(counterpartyId)) return err("counterparty_did_not_accept");
  const me = state.players[pid]!;
  const cp = state.players[counterpartyId];
  if (!cp) return err("invalid_counterparty");
  // Both still have what they need
  if (!hasPartial(me.hand, trade.give)) return err("initiator_lacks_resources");
  if (!hasPartial(cp.hand, trade.want)) return err("counterparty_lacks_resources");

  const giveFull = partialToFull(trade.give);
  const wantFull = partialToFull(trade.want);
  const nextState: GameState = {
    ...state,
    trades: state.trades.filter((t) => t.id !== tradeId),
    players: state.players.map((p) => {
      if (p.id === pid) return { ...p, hand: add(spend(p.hand, giveFull), wantFull) };
      if (p.id === counterpartyId) return { ...p, hand: add(spend(p.hand, wantFull), giveFull) };
      return p;
    }),
  };
  return ok(
    bump(
      appendLog(
        nextState,
        `${me.name} traded with ${cp.name}: ${describeTrade(trade.give, trade.want)}.`,
      ),
    ),
  );
}

function applyCancelTrade(state: GameState, pid: PlayerId, tradeId: string): Result<GameState> {
  const trade = state.trades.find((t) => t.id === tradeId);
  if (!trade) return err("trade_not_found");
  if (trade.fromPlayerId !== pid) return err("not_your_trade");
  return ok(
    bump(
      appendLog(
        { ...state, trades: state.trades.filter((t) => t.id !== tradeId) },
        `${state.players[pid]!.name} withdrew their trade.`,
      ),
    ),
  );
}

// ============== Setup-aware "what should I place next?" ==============
export function setupSubstep(state: GameState, pid: PlayerId): "settlement" | "road" | null {
  const phase = state.meta.phase;
  if (phase !== "setup_round_1" && phase !== "setup_round_2") return null;
  if (state.meta.activePlayerId !== pid) return null;
  const myS = settlementsPlacedBy(state, pid).length;
  const myR = roadsPlacedBy(state, pid).length;
  const expectedS = phase === "setup_round_1" ? 0 : 1;
  if (myS === expectedS && myR === expectedS) return "settlement";
  if (myS === expectedS + 1 && myR === expectedS) return "road";
  return null;
}

/** Last settlement placed by player that doesn't yet have an adjacent road. */
export function pendingSettlementVertex(state: GameState, pid: PlayerId): VertexId | null {
  const myS = settlementsPlacedBy(state, pid);
  for (const vid of myS) {
    const v = state.board.vertices[vid]!;
    const hasRoad = v.edges.some((eid) => state.pieces.roads[eid] === pid);
    if (!hasRoad) return vid;
  }
  return null;
}
