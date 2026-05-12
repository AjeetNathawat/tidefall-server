import type {
  GameState,
  Action,
  PlayerId,
  PlayerColor,
  Resource,
} from "../game/types";

// ===== Lobby state (pre-game) =====
export interface LobbyPlayer {
  socketId: string;
  playerId: PlayerId;
  name: string;
  color: PlayerColor;
  ready: boolean;
  host: boolean;
  connected: boolean;
}

export interface LobbySettings {
  /** How many seats are open. Bounds depend on the chosen variant. */
  playerCount: number;
  turnTimer: 0 | 60 | 120 | 180;
  /** Board variant id from `packages/shared/src/board/variants.ts`. */
  variantId: string;
}

export interface LobbyState {
  code: string;
  players: LobbyPlayer[];
  settings: LobbySettings;
  hostSocketId: string | null;
  /** Once started, this is set and game state begins. */
  gameStarted: boolean;
}

// ===== Client → Server events =====
export type C2SEvent =
  | { type: "JOIN_ROOM"; code: string; name: string }
  | { type: "LEAVE_ROOM" }
  | { type: "TOGGLE_READY" }
  | { type: "UPDATE_SETTINGS"; settings: Partial<LobbySettings> }
  | { type: "START_GAME" }
  | { type: "ACTION"; action: Action };

// ===== Server → Client events =====
export type S2CEvent =
  | { type: "LOBBY_STATE"; state: LobbyState }
  | { type: "GAME_STATE"; state: GameState; you: PlayerId }
  | { type: "ERROR"; code: string; message: string }
  | { type: "TOAST"; message: string };

// ===== Helpers =====
/** Filter game state to the view a specific player is allowed to see. */
export function redactStateFor(state: GameState, viewerId: PlayerId): GameState {
  return {
    ...state,
    players: state.players.map((p) => {
      if (p.id === viewerId) return p;
      return {
        ...p,
        // Hide hand cards from other players (only count is visible publicly via cardCount derivation)
        hand: { brick: 0, lumber: 0, ore: 0, grain: 0, wool: 0 },
        devCards: {
          // Hide unplayed dev card types — keep counts via array length only
          hand: p.devCards.hand.map(() => "knight" as const), // dummy type, we only show count
          pending: p.devCards.pending.map(() => "knight" as const),
          played: p.devCards.played,
        },
        hiddenVP: 0,
      };
    }),
  };
}

/** Derived helper: total resources in player's hand. */
export function totalCards(hand: Record<Resource, number>): number {
  return hand.brick + hand.lumber + hand.ore + hand.grain + hand.wool;
}
