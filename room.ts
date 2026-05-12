import {
  initGame,
  getVariant,
  DEFAULT_VARIANT,
  type GameState,
  type LobbyState,
  type LobbySettings,
  type PlayerColor,
  type PlayerId,
} from "./shared";

const COLORS: PlayerColor[] = ["red", "blue", "orange", "white"];

export class Room {
  lobby: LobbyState;
  game: GameState | null = null;

  constructor(public code: string) {
    const v = getVariant(DEFAULT_VARIANT);
    this.lobby = {
      code,
      players: [],
      settings: {
        playerCount: Math.min(4, v.maxPlayers),
        turnTimer: 0,
        variantId: v.id,
      },
      hostSocketId: null,
      gameStarted: false,
    };
  }

  isFull(): boolean {
    return this.lobby.players.length >= this.lobby.settings.playerCount;
  }

  hasName(name: string): boolean {
    return this.lobby.players.some((p) => p.name.toLowerCase() === name.toLowerCase());
  }

  addPlayer(socketId: string, name: string): { ok: true; playerId: PlayerId } | { ok: false; error: string } {
    if (this.lobby.gameStarted) return { ok: false, error: "game_already_started" };
    if (this.isFull()) return { ok: false, error: "room_full" };
    if (this.hasName(name)) return { ok: false, error: "name_taken" };
    const playerId = this.lobby.players.length as PlayerId;
    const color = COLORS[playerId] ?? "white";
    const isHost = this.lobby.players.length === 0;
    this.lobby.players.push({
      socketId,
      playerId,
      name,
      color,
      ready: isHost, // host is auto-ready
      host: isHost,
      connected: true,
    });
    if (isHost) this.lobby.hostSocketId = socketId;
    return { ok: true, playerId };
  }

  /** Mark a player as disconnected. Don't remove (so they can reconnect with same name). */
  markDisconnected(socketId: string): void {
    const p = this.lobby.players.find((x) => x.socketId === socketId);
    if (p) p.connected = false;
  }

  /** Re-attach an existing player (by name) to a new socket. */
  reattach(socketId: string, name: string): PlayerId | null {
    const p = this.lobby.players.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!p) return null;
    p.socketId = socketId;
    p.connected = true;
    if (p.host) this.lobby.hostSocketId = socketId;
    return p.playerId;
  }

  removePlayer(socketId: string): void {
    if (this.lobby.gameStarted) {
      this.markDisconnected(socketId);
      return;
    }
    const idx = this.lobby.players.findIndex((p) => p.socketId === socketId);
    if (idx < 0) return;
    const wasHost = this.lobby.players[idx]!.host;
    this.lobby.players.splice(idx, 1);
    // Re-index playerIds (in lobby only)
    this.lobby.players.forEach((p, i) => {
      p.playerId = i as PlayerId;
      p.color = COLORS[i] ?? "white";
      p.host = false;
    });
    if (wasHost && this.lobby.players.length > 0) {
      this.lobby.players[0]!.host = true;
      this.lobby.players[0]!.ready = true;
      this.lobby.hostSocketId = this.lobby.players[0]!.socketId;
    } else if (this.lobby.players.length === 0) {
      this.lobby.hostSocketId = null;
    }
  }

  toggleReady(socketId: string): void {
    const p = this.lobby.players.find((x) => x.socketId === socketId);
    if (!p) return;
    if (p.host) return; // host is always ready
    p.ready = !p.ready;
  }

  updateSettings(socketId: string, settings: Partial<LobbySettings>): boolean {
    if (socketId !== this.lobby.hostSocketId) return false;
    const merged: LobbySettings = { ...this.lobby.settings, ...settings };
    // Clamp playerCount against the (possibly new) variant's bounds
    const v = getVariant(merged.variantId);
    const clamped = Math.max(v.minPlayers, Math.min(v.maxPlayers, merged.playerCount));
    merged.playerCount = clamped;
    merged.variantId = v.id;
    this.lobby.settings = merged;
    // Trim players if shrinking player count
    if (this.lobby.players.length > this.lobby.settings.playerCount) {
      this.lobby.players = this.lobby.players.slice(0, this.lobby.settings.playerCount);
    }
    return true;
  }

  startGame(socketId: string): { ok: true } | { ok: false; error: string } {
    if (socketId !== this.lobby.hostSocketId) return { ok: false, error: "not_host" };
    const v = getVariant(this.lobby.settings.variantId);
    if (this.lobby.players.length < v.minPlayers) return { ok: false, error: "not_enough_players" };
    if (this.lobby.players.length > v.maxPlayers) return { ok: false, error: "too_many_players" };
    if (this.lobby.players.length < this.lobby.settings.playerCount) return { ok: false, error: "not_enough_players" };
    if (!this.lobby.players.every((p) => p.ready)) return { ok: false, error: "not_all_ready" };

    const seed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
    this.game = initGame({
      roomCode: this.code,
      seed,
      players: this.lobby.players.map((p) => ({ id: p.playerId, name: p.name })),
      variantId: v.id,
    });
    // Override player colors from lobby
    this.game = {
      ...this.game,
      players: this.game.players.map((p, i) => ({
        ...p,
        color: this.lobby.players[i]?.color ?? p.color,
      })),
    };
    this.lobby.gameStarted = true;
    return { ok: true };
  }

  setGame(state: GameState): void {
    this.game = state;
  }

  socketIdToPlayerId(socketId: string): PlayerId | null {
    return this.lobby.players.find((p) => p.socketId === socketId)?.playerId ?? null;
  }
}
