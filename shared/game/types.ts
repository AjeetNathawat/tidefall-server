// ===== Core IDs & primitives =====
export type PlayerId = 0 | 1 | 2 | 3;
export type PlayerColor = "red" | "blue" | "orange" | "white";

export type Resource = "brick" | "lumber" | "ore" | "grain" | "wool";
export const RESOURCES: readonly Resource[] = ["brick", "lumber", "ore", "grain", "wool"] as const;

export type Terrain = "hills" | "forest" | "mountains" | "fields" | "pasture" | "desert";

export type DevCardType =
  | "knight"
  | "victory_point"
  | "road_building"
  | "year_of_plenty"
  | "monopoly";

export type ResourceCounts = Record<Resource, number>;
export const ZERO_RESOURCES: ResourceCounts = { brick: 0, lumber: 0, ore: 0, grain: 0, wool: 0 };

export type HexId = number;
export type VertexId = number;
export type EdgeId = number;
export type PortSlotId = number;

// ===== Board (immutable per game) =====
export interface Hex {
  id: HexId;
  row: number;
  col: number;
  cx: number;
  cy: number;
  terrain: Terrain;
  number: number | null; // null only for desert
  vertices: readonly VertexId[]; // 6, clockwise from top
}

export interface Vertex {
  id: VertexId;
  x: number;
  y: number;
  hexes: readonly HexId[]; // 1..3
  adjacentVertices: readonly VertexId[];
  edges: readonly EdgeId[];
  port?: PortSlotId; // set when on a port slot's access list
}

export interface Edge {
  id: EdgeId;
  vertexA: VertexId;
  vertexB: VertexId;
  hexes: readonly HexId[]; // 1..2
  port?: PortSlotId; // set when this is a port slot's edge
}

export type PortType =
  | { kind: "generic"; ratio: 3 }
  | { kind: "specific"; resource: Resource; ratio: 2 };

export interface PortSlot {
  id: PortSlotId;
  edgeId: EdgeId;
  accessVertices: readonly [VertexId, VertexId];
  /** Edge midpoint in board-local coordinates. */
  edgeMidX: number;
  edgeMidY: number;
  /** Outward unit normal pointing away from the adjacent hex. */
  normalX: number;
  normalY: number;
  /** Final dock position (well outside any hex). */
  dockX: number;
  dockY: number;
  type: PortType;
}

export interface BoardState {
  hexes: readonly Hex[];
  vertices: readonly Vertex[];
  edges: readonly Edge[];
  ports: readonly PortSlot[];
  robberHex: HexId;
  /** Pre-computed: number → list of hexes that produce on that roll. */
  rollLookup: Readonly<Record<number, readonly HexId[]>>;
}

// ===== Game state =====
export type Phase =
  | "lobby"
  | "setup_round_1"
  | "setup_round_2"
  | "main_roll"
  | "main_action"
  | "discard"
  | "move_robber"
  | "rob_player"
  | "game_over";

export interface PlayerState {
  id: PlayerId;
  name: string;
  color: PlayerColor;
  hand: ResourceCounts;
  /**
   * - `hand`: playable dev cards (drawn before this turn).
   * - `pending`: drawn this turn, can't be played until next turn.
   * - `played`: face-up, used; counts toward Largest Army when knights.
   */
  devCards: { hand: DevCardType[]; pending: DevCardType[]; played: DevCardType[] };
  pieces: { roads: number; settlements: number; cities: number };
  /** Cached: settlements (1pt) + cities (2pt) on board. Excludes hidden VP cards. */
  publicVP: number;
  /** Hidden VP from victory_point dev cards. */
  hiddenVP: number;
}

export interface PieceState {
  settlements: Record<VertexId, PlayerId>;
  cities: Record<VertexId, PlayerId>;
  roads: Record<EdgeId, PlayerId>;
}

export interface TradeOffer {
  id: string;
  fromPlayerId: PlayerId;
  give: Partial<ResourceCounts>;
  want: Partial<ResourceCounts>;
  acceptedBy: PlayerId[];
  targetPlayerId?: PlayerId;
}

export type GameEvent =
  | { type: "log"; t: number; text: string };

export interface GameState {
  meta: {
    roomCode: string;
    seed: number;
    phase: Phase;
    sequence: number;
    activePlayerId: PlayerId;
    /** For setup phases: queue of who's next to place. */
    setupQueue: readonly PlayerId[];
    lastRoll: readonly [number, number] | null;
    /** True after the active player rolled this turn. */
    rolledThisTurn: boolean;
    /** Dev cards purchased THIS turn (cannot be played until next turn). */
    devCardsBoughtThisTurn: number;
    /** True if active player has played a dev card this turn. */
    devCardPlayedThisTurn: boolean;
    /** When phase==='move_robber' or 'rob_player', whose action triggered it (knight or 7). */
    pendingRobberPlayer: PlayerId | null;
    /** When phase==='rob_player', which hex the robber moved to. */
    robberMovedTo: HexId | null;
    /** Free roads remaining from a Road Building dev card (0 normally, 2 right after play). */
    freeRoadsRemaining: number;
  };
  board: BoardState;
  players: readonly PlayerState[];
  pieces: PieceState;
  bank: ResourceCounts;
  devDeck: readonly DevCardType[];
  trades: readonly TradeOffer[];
  longestRoad: { holderId: PlayerId | null; length: number };
  largestArmy: { holderId: PlayerId | null; count: number };
  pendingDiscards: readonly PlayerId[];
  log: readonly GameEvent[];
  winnerId: PlayerId | null;
}

// ===== Actions =====
export type Action =
  | { type: "ROLL_DICE"; playerId: PlayerId }
  | { type: "PLACE_SETTLEMENT"; playerId: PlayerId; vertexId: VertexId }
  | { type: "PLACE_CITY"; playerId: PlayerId; vertexId: VertexId }
  | { type: "PLACE_ROAD"; playerId: PlayerId; edgeId: EdgeId }
  | { type: "BUY_DEV_CARD"; playerId: PlayerId }
  | { type: "PLAY_KNIGHT"; playerId: PlayerId }
  | { type: "PLAY_ROAD_BUILDING"; playerId: PlayerId }
  | { type: "PLAY_YEAR_OF_PLENTY"; playerId: PlayerId; resources: [Resource, Resource] }
  | { type: "PLAY_MONOPOLY"; playerId: PlayerId; resource: Resource }
  | {
      type: "PROPOSE_TRADE";
      playerId: PlayerId;
      give: Partial<ResourceCounts>;
      want: Partial<ResourceCounts>;
      targetPlayerId?: PlayerId;
    }
  | { type: "ACCEPT_TRADE"; playerId: PlayerId; tradeId: string }
  | { type: "EXECUTE_TRADE"; playerId: PlayerId; tradeId: string; counterpartyId: PlayerId }
  | { type: "CANCEL_TRADE"; playerId: PlayerId; tradeId: string }
  | { type: "MARITIME_TRADE"; playerId: PlayerId; give: Resource; giveQty: 2 | 3 | 4; receive: Resource }
  | { type: "DISCARD"; playerId: PlayerId; cards: Partial<ResourceCounts> }
  | { type: "MOVE_ROBBER"; playerId: PlayerId; hexId: HexId }
  | { type: "STEAL_FROM"; playerId: PlayerId; victimId: PlayerId | null }
  | { type: "END_TURN"; playerId: PlayerId };

// ===== Result =====
export type Ok<T> = { ok: true; value: T };
export type Err<E> = { ok: false; error: E };
export type Result<T, E = string> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

// ===== Player defs (defaults) =====
export const PLAYER_COLORS: readonly PlayerColor[] = ["red", "blue", "orange", "white"] as const;

// ===== Terrain → resource =====
export const TERRAIN_RESOURCE: Record<Terrain, Resource | null> = {
  hills: "brick",
  forest: "lumber",
  mountains: "ore",
  fields: "grain",
  pasture: "wool",
  desert: null,
};

// ===== Building costs =====
export const COST_ROAD: ResourceCounts = { brick: 1, lumber: 1, ore: 0, grain: 0, wool: 0 };
export const COST_SETTLEMENT: ResourceCounts = { brick: 1, lumber: 1, ore: 0, grain: 1, wool: 1 };
export const COST_CITY: ResourceCounts = { brick: 0, lumber: 0, ore: 3, grain: 2, wool: 0 };
export const COST_DEV_CARD: ResourceCounts = { brick: 0, lumber: 0, ore: 1, grain: 1, wool: 1 };

// ===== Bank starting counts (per resource) =====
export const BANK_PER_RESOURCE = 19;
