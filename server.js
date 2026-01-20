const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");
const {
  CONSTANTS,
  GameSession: BaseGameSession,
  validateSettings,
  validatePlayerName,
  validateWarningThresholds,
  validateTimeValue,
  sanitizeString,
  generateGameId,
} = require("./lib/game-logic");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, "public")));

// Health check endpoint for Fly.io
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    activeSessions: gameSessions.size,
  });
});

const gameSessions = new Map();

// Server-specific GameSession that uses WebSocket for broadcasting
class GameSession extends BaseGameSession {
  constructor(id, settings) {
    super(id, settings, (type, data) => {
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.gameId === id) {
          client.send(JSON.stringify({ type, data }));
        }
      });
    });
  }
}

let clientIdCounter = 0;

function generateClientId() {
  return `client_${Date.now()}_${++clientIdCounter}`;
}

wss.on("connection", ws => {
  ws.clientId = generateClientId();
  ws.messageTimestamps = [];

  // Send the client their ID
  ws.send(JSON.stringify({ type: "clientId", data: { clientId: ws.clientId } }));

  ws.on("message", message => {
    // Rate limiting
    const now = Date.now();
    ws.messageTimestamps = ws.messageTimestamps.filter(
      ts => now - ts < CONSTANTS.RATE_LIMIT_WINDOW
    );

    if (ws.messageTimestamps.length >= CONSTANTS.RATE_LIMIT_MAX_MESSAGES) {
      ws.send(JSON.stringify({ type: "error", data: { message: "Rate limit exceeded" } }));
      return;
    }
    ws.messageTimestamps.push(now);

    try {
      const parsed = JSON.parse(message);
      const type = parsed.type;
      const data = parsed.data || {};

      if (!type || typeof type !== "string") {
        ws.send(JSON.stringify({ type: "error", data: { message: "Invalid message type" } }));
        return;
      }

      switch (type) {
        case "create": {
          if (!validateSettings(data.settings)) {
            ws.send(JSON.stringify({ type: "error", data: { message: "Invalid settings" } }));
            break;
          }
          const gameId = generateGameId(new Set(gameSessions.keys()));
          const session = new GameSession(gameId, data.settings || {});
          gameSessions.set(gameId, session);
          ws.gameId = gameId;
          ws.send(JSON.stringify({ type: "state", data: session.getState() }));
          break;
        }
        case "join": {
          const session = gameSessions.get(data.gameId);
          if (!session) {
            ws.send(JSON.stringify({ type: "error", data: { message: "Game not found" } }));
            break;
          }
          ws.gameId = data.gameId;
          session.lastActivity = Date.now();
          ws.send(JSON.stringify({ type: "state", data: session.getState() }));
          break;
        }
        case "start": {
          const session = gameSessions.get(ws.gameId);
          if (session) {
            session.lastActivity = Date.now();
            session.start();
          }
          break;
        }
        case "pause": {
          const session = gameSessions.get(ws.gameId);
          if (session) {
            session.lastActivity = Date.now();
            if (session.status === "running") {
              session.pause();
            } else if (session.status === "paused") {
              session.resume();
            }
          }
          break;
        }
        case "reset": {
          const session = gameSessions.get(ws.gameId);
          if (session) {
            session.lastActivity = Date.now();
            session.reset();
          }
          break;
        }
        case "switch": {
          const session = gameSessions.get(ws.gameId);
          if (session) {
            if (
              data.playerId === undefined ||
              data.playerId < 1 ||
              data.playerId > CONSTANTS.MAX_PLAYERS
            )
              break;
            session.lastActivity = Date.now();
            session.switchPlayer(data.playerId);
          }
          break;
        }
        case "updatePlayer": {
          const session = gameSessions.get(ws.gameId);
          if (session) {
            if (
              data.playerId === undefined ||
              data.playerId < 1 ||
              data.playerId > CONSTANTS.MAX_PLAYERS
            )
              break;
            if (data.name !== undefined && !validatePlayerName(data.name)) break;
            if (data.time !== undefined && !validateTimeValue(data.time)) break;
            if (data.name !== undefined) {
              data.name = sanitizeString(data.name);
            }
            session.lastActivity = Date.now();
            session.updatePlayer(data.playerId, data);
          }
          break;
        }
        case "addPenalty": {
          const session = gameSessions.get(ws.gameId);
          if (session) {
            if (
              data.playerId === undefined ||
              data.playerId < 1 ||
              data.playerId > CONSTANTS.MAX_PLAYERS
            )
              break;
            session.lastActivity = Date.now();
            session.addPenalty(data.playerId);
          }
          break;
        }
        case "eliminate": {
          const session = gameSessions.get(ws.gameId);
          if (session) {
            if (
              data.playerId === undefined ||
              data.playerId < 1 ||
              data.playerId > CONSTANTS.MAX_PLAYERS
            )
              break;
            session.lastActivity = Date.now();
            session.eliminate(data.playerId);
          }
          break;
        }
        case "updateSettings": {
          const session = gameSessions.get(ws.gameId);
          if (session) {
            session.lastActivity = Date.now();
            if (data.warningThresholds !== undefined) {
              if (!validateWarningThresholds(data.warningThresholds)) {
                ws.send(
                  JSON.stringify({ type: "error", data: { message: "Invalid warning thresholds" } })
                );
                break;
              }
              session.settings.warningThresholds = data.warningThresholds;
              session.broadcastState();
            }
          }
          break;
        }
        case "claim": {
          const session = gameSessions.get(ws.gameId);
          if (session) {
            if (
              data.playerId === undefined ||
              data.playerId < 1 ||
              data.playerId > CONSTANTS.MAX_PLAYERS
            )
              break;
            session.lastActivity = Date.now();
            const success = session.claimPlayer(data.playerId, ws.clientId);
            if (!success) {
              ws.send(
                JSON.stringify({ type: "error", data: { message: "Cannot claim this player" } })
              );
            }
          }
          break;
        }
        case "unclaim": {
          const session = gameSessions.get(ws.gameId);
          if (session) {
            session.lastActivity = Date.now();
            session.unclaimPlayer(ws.clientId);
          }
          break;
        }
      }
    } catch (e) {
      console.error("Invalid JSON received:", e.message);
      return;
    }
  });

  ws.on("close", () => {
    const session = gameSessions.get(ws.gameId);
    if (session) {
      // Unclaim any players claimed by this client
      session.handleClientDisconnect(ws.clientId);

      const clientsConnected = Array.from(wss.clients).filter(
        client => client.gameId === ws.gameId && client.readyState === WebSocket.OPEN
      ).length;

      if (clientsConnected === 0 && session.status === "running") {
        session.pause();
      }
    }
  });
});

setInterval(() => {
  const now = Date.now();

  for (const [gameId, session] of gameSessions.entries()) {
    const clientsConnected = Array.from(wss.clients).filter(
      client => client.gameId === gameId && client.readyState === WebSocket.OPEN
    ).length;

    const shouldDelete =
      (clientsConnected === 0 && now - session.lastActivity > CONSTANTS.EMPTY_SESSION_THRESHOLD) ||
      now - session.lastActivity > CONSTANTS.INACTIVE_SESSION_THRESHOLD;

    if (shouldDelete) {
      session.cleanup();
      gameSessions.delete(gameId);
    }
  }
}, CONSTANTS.SESSION_CLEANUP_INTERVAL);

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0"; // Bind to all interfaces for Docker/Fly.io

server.listen(PORT, HOST, () => {
  console.log(`Tap or Tarp server running on ${HOST}:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
});
