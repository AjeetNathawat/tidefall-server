import { createServer } from "node:http";
import { Server } from "socket.io";
import {
  reduce,
  redactStateFor,
  type C2SEvent,
  type S2CEvent,
  type Action,
  type LobbySettings,
} from "./shared";
import { Room } from "./room";

const PORT = Number(process.env.PORT || 3030);
const httpServer = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Tidefall server OK");
});

const io = new Server(httpServer, {
  cors: { origin: true, credentials: true },
});

// roomCode → Room
const rooms = new Map<string, Room>();

function broadcastLobby(room: Room) {
  const payload: S2CEvent = { type: "LOBBY_STATE", state: room.lobby };
  io.to(room.code).emit("s2c", payload);
}

function broadcastGame(room: Room) {
  if (!room.game) return;
  // Send a per-player redacted state to each socket
  for (const p of room.lobby.players) {
    if (!p.connected) continue;
    const redacted = redactStateFor(room.game, p.playerId);
    const payload: S2CEvent = { type: "GAME_STATE", state: redacted, you: p.playerId };
    io.to(p.socketId).emit("s2c", payload);
  }
}

function emitError(socketId: string, code: string, message: string) {
  const payload: S2CEvent = { type: "ERROR", code, message };
  io.to(socketId).emit("s2c", payload);
}

io.on("connection", (socket) => {
  let joinedCode: string | null = null;
  let joinedName: string | null = null;

  socket.on("c2s", (event: C2SEvent) => {
    try {
      switch (event.type) {
        case "JOIN_ROOM": {
          const { code, name } = event;
          const cleanName = name.trim().slice(0, 20);
          if (!cleanName) {
            return emitError(socket.id, "invalid_name", "Display name required.");
          }
          let room = rooms.get(code);
          if (!room) {
            room = new Room(code);
            rooms.set(code, room);
          }
          // Try reattach first (rejoin with same name after disconnect)
          let reattachedId = room.reattach(socket.id, cleanName);
          if (reattachedId === null) {
            const result = room.addPlayer(socket.id, cleanName);
            if (!result.ok) {
              return emitError(socket.id, result.error, errorMessage(result.error));
            }
            reattachedId = result.playerId;
          }
          socket.join(code);
          joinedCode = code;
          joinedName = cleanName;
          broadcastLobby(room);
          if (room.lobby.gameStarted && room.game) {
            broadcastGame(room);
          }
          break;
        }
        case "LEAVE_ROOM": {
          if (!joinedCode) return;
          const room = rooms.get(joinedCode);
          if (!room) return;
          room.removePlayer(socket.id);
          socket.leave(joinedCode);
          if (room.lobby.players.length === 0) {
            rooms.delete(joinedCode);
          } else {
            broadcastLobby(room);
          }
          joinedCode = null;
          joinedName = null;
          break;
        }
        case "TOGGLE_READY": {
          if (!joinedCode) return;
          const room = rooms.get(joinedCode);
          if (!room || room.lobby.gameStarted) return;
          room.toggleReady(socket.id);
          broadcastLobby(room);
          break;
        }
        case "UPDATE_SETTINGS": {
          if (!joinedCode) return;
          const room = rooms.get(joinedCode);
          if (!room || room.lobby.gameStarted) return;
          if (!room.updateSettings(socket.id, event.settings as Partial<LobbySettings>)) {
            return emitError(socket.id, "not_host", "Only the host can change settings.");
          }
          broadcastLobby(room);
          break;
        }
        case "START_GAME": {
          if (!joinedCode) return;
          const room = rooms.get(joinedCode);
          if (!room) return;
          const result = room.startGame(socket.id);
          if (!result.ok) {
            return emitError(socket.id, result.error, errorMessage(result.error));
          }
          broadcastLobby(room);
          broadcastGame(room);
          break;
        }
        case "ACTION": {
          if (!joinedCode) return;
          const room = rooms.get(joinedCode);
          if (!room || !room.game) return;
          const pid = room.socketIdToPlayerId(socket.id);
          if (pid === null) return emitError(socket.id, "not_in_room", "You are not in this room.");
          const action: Action = { ...event.action, playerId: pid };
          const result = reduce(room.game, action);
          if (!result.ok) {
            return emitError(socket.id, result.error, errorMessage(result.error));
          }
          room.setGame(result.value);
          broadcastGame(room);
          break;
        }
      }
    } catch (e) {
      console.error("[c2s error]", e);
      emitError(socket.id, "internal_error", String(e));
    }
  });

  socket.on("disconnect", () => {
    if (!joinedCode) return;
    const room = rooms.get(joinedCode);
    if (!room) return;
    if (room.lobby.gameStarted) {
      room.markDisconnected(socket.id);
      broadcastLobby(room);
    } else {
      room.removePlayer(socket.id);
      if (room.lobby.players.length === 0) {
        rooms.delete(joinedCode);
      } else {
        broadcastLobby(room);
      }
    }
  });
});

function errorMessage(code: string): string {
  switch (code) {
    case "room_full": return "This room is full.";
    case "name_taken": return "That name is already taken in this room.";
    case "game_already_started": return "Game already started — can't join in progress.";
    case "not_host": return "Only the host can do that.";
    case "not_enough_players": return "Need more players to start.";
    case "not_all_ready": return "All players must ready up first.";
    case "not_your_turn": return "Not your turn.";
    case "invalid_phase": return "Can't do that right now.";
    case "insufficient_resources": return "Not enough resources.";
    case "distance_rule": return "Settlements must be at least 2 edges apart.";
    case "vertex_occupied": return "Spot is taken.";
    case "edge_occupied": return "Road already there.";
    case "must_connect_to_road": return "Settlement must connect to one of your roads.";
    case "must_connect_to_existing": return "Road must connect to your network.";
    case "road_must_connect_to_settlement": return "Road must connect to the settlement you just placed.";
    default: return code;
  }
}

httpServer.listen(PORT, () => {
  console.log(`▲ Tidefall server listening on :${PORT}`);
});
