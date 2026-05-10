// Public surface of @catan/shared

// Types
export * from "./game/types";

// Engine
export {
  Engine,
  initGame,
} from "./game/engine";
export type { InitParams } from "./game/engine";

// Reducer (authoritative game logic)
export {
  reduce,
  validSettlementVertices,
  validRoadEdges,
  setupSubstep,
  pendingSettlementVertex,
  bestMaritimeRatios,
} from "./game/reducer";

// Events (client/server messaging)
export type {
  LobbyPlayer,
  LobbySettings,
  LobbyState,
  C2SEvent,
  S2CEvent,
} from "./events";
export { redactStateFor, totalCards } from "./events";

// Board / geometry constants & helpers
export {
  HEX_W,
  HEX_H,
  APOTHEM,
  HEX_RADIUS,
  buildGraph,
  buildPorts,
  buildRollLookup,
  assignTerrainAndNumbers,
  boardBounds,
  distance,
} from "./board/geometry";

export { generateBoard } from "./board/generator";
export { mulberry32, shuffle, rollDie } from "./board/rng";
export type { RNG } from "./board/rng";
