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
const { createStorage } = require("./lib/storage");

// ============================================================================
// CONFIGURATION
// ============================================================================

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
const STORAGE_TYPE = process.env.STORAGE_TYPE || "sqlite";
const DB_PATH = process.env.DB_PATH || "./data/sessions.db";
const PERSISTENCE_INTERVAL = 10000; // Save active games every 10 seconds

// ============================================================================
// GLOBAL STATE
// ============================================================================

let isShuttingDown = false;
let storage = null;
let persistenceTimer = null;
let cleanupTimer = null;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, "public")));

// Health check endpoint for Fly.io
app.get("/health", (req, res) => {
  res.status(200).json({
    status: isShuttingDown ? "shutting_down" : "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    activeSessions: gameSessions.size,
    activeConnections: wss.clients.size,
    storageType: STORAGE_TYPE,
    persistedSessions: storage ? storage.count() : 0,
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
          session.setOwner(ws.clientId); // Set creator as owner
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
          // Set owner if not already set (for restored sessions)
          if (!session.ownerId) {
            session.setOwner(ws.clientId);
          }
          ws.send(JSON.stringify({ type: "state", data: session.getState() }));
          break;
        }
        case "start": {
          const session = gameSessions.get(ws.gameId);
          if (session) {
            // Authorization: owner or claimed player can start
            if (!session.canControlGame(ws.clientId)) {
              ws.send(
                JSON.stringify({ type: "error", data: { message: "Not authorized to start game" } })
              );
              break;
            }
            session.lastActivity = Date.now();
            session.start();
          }
          break;
        }
        case "pause": {
          const session = gameSessions.get(ws.gameId);
          if (session) {
            // Authorization: owner or claimed player can pause/resume
            if (!session.canControlGame(ws.clientId)) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  data: { message: "Not authorized to pause/resume" },
                })
              );
              break;
            }
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
            // Authorization: only owner can reset
            if (!session.isOwner(ws.clientId)) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  data: { message: "Only the game owner can reset" },
                })
              );
              break;
            }
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
            // Authorization: check switch permissions
            if (!session.canSwitchPlayer(data.playerId, ws.clientId)) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  data: { message: "Not authorized to switch players" },
                })
              );
              break;
            }
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
            // Authorization: can only modify own player or if owner
            if (!session.canModifyPlayer(data.playerId, ws.clientId)) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  data: { message: "Not authorized to modify this player" },
                })
              );
              break;
            }
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
            // Authorization: only owner can add penalties
            if (!session.isOwner(ws.clientId)) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  data: { message: "Only the game owner can add penalties" },
                })
              );
              break;
            }
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
            // Authorization: only owner can eliminate
            if (!session.isOwner(ws.clientId)) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  data: { message: "Only the game owner can eliminate players" },
                })
              );
              break;
            }
            session.lastActivity = Date.now();
            session.eliminate(data.playerId);
          }
          break;
        }
        case "updateSettings": {
          const session = gameSessions.get(ws.gameId);
          if (session) {
            // Authorization: only owner can update settings
            if (!session.isOwner(ws.clientId)) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  data: { message: "Only the game owner can change settings" },
                })
              );
              break;
            }
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

// ============================================================================
// PERSISTENCE FUNCTIONS
// ============================================================================

/**
 * Save all active sessions to storage
 */
function persistSessions() {
  if (!storage || isShuttingDown) return;

  for (const [gameId, session] of gameSessions.entries()) {
    try {
      storage.save(gameId, session.toJSON());
    } catch (error) {
      console.error(`Failed to persist session ${gameId}:`, error.message);
    }
  }
}

/**
 * Load sessions from storage on startup
 */
function loadSessions() {
  if (!storage) return;

  try {
    const savedSessions = storage.loadAll();
    console.log(`Found ${savedSessions.length} persisted sessions`);

    for (const { id, state } of savedSessions) {
      try {
        const session = BaseGameSession.fromState(state, (type, data) => {
          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.gameId === id) {
              client.send(JSON.stringify({ type, data }));
            }
          });
        });
        gameSessions.set(id, session);
        console.log(`Restored session ${id} (status: ${session.status})`);
      } catch (error) {
        console.error(`Failed to restore session ${id}:`, error.message);
        storage.delete(id);
      }
    }
  } catch (error) {
    console.error("Failed to load sessions:", error.message);
  }
}

/**
 * Session cleanup routine
 */
function cleanupSessions() {
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
      if (storage) {
        storage.delete(gameId);
      }
      console.log(`Cleaned up session ${gameId}`);
    }
  }
}

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

/**
 * Gracefully shutdown the server
 * @param {string} signal - Signal that triggered shutdown
 * @param {number} exitCode - Exit code (default 0)
 */
async function gracefulShutdown(signal, exitCode = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\nReceived ${signal}. Starting graceful shutdown...`);

  // Clear timers
  if (persistenceTimer) clearInterval(persistenceTimer);
  if (cleanupTimer) clearInterval(cleanupTimer);

  // Persist all sessions before shutdown
  console.log("Persisting sessions...");
  persistSessions();

  // Close WebSocket server (stop accepting new connections)
  console.log("Closing WebSocket server...");
  wss.close(() => {
    console.log("WebSocket server closed");
  });

  // Notify connected clients
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(
          JSON.stringify({ type: "error", data: { message: "Server is shutting down" } })
        );
        client.close(1001, "Server shutting down");
      } catch (e) {
        // Ignore errors during shutdown
      }
    }
  });

  // Cleanup all sessions
  for (const [, session] of gameSessions.entries()) {
    session.cleanup();
  }

  // Close storage
  if (storage) {
    console.log("Closing storage...");
    storage.close();
  }

  // Close HTTP server
  console.log("Closing HTTP server...");
  server.close(() => {
    console.log("HTTP server closed");
    console.log("Graceful shutdown complete");
    process.exit(exitCode);
  });

  // Force exit after timeout
  setTimeout(() => {
    console.error("Forced shutdown after timeout");
    process.exit(exitCode);
  }, 10000);
}

// ============================================================================
// ERROR HANDLERS
// ============================================================================

process.on("uncaughtException", error => {
  console.error("Uncaught Exception:", error);
  gracefulShutdown("uncaughtException", 1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  // Don't exit on unhandled rejection, just log it
});

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// ============================================================================
// SERVER STARTUP
// ============================================================================

function startServer() {
  // Initialize storage
  try {
    storage = createStorage(STORAGE_TYPE, DB_PATH);
    console.log(`Storage initialized (type: ${STORAGE_TYPE})`);
  } catch (error) {
    console.error("Failed to initialize storage:", error.message);
    console.log("Continuing with in-memory storage only");
  }

  // Load persisted sessions
  loadSessions();

  // Start persistence timer
  persistenceTimer = setInterval(persistSessions, PERSISTENCE_INTERVAL);

  // Start cleanup timer
  cleanupTimer = setInterval(cleanupSessions, CONSTANTS.SESSION_CLEANUP_INTERVAL);

  // Start HTTP server
  server.listen(PORT, HOST, () => {
    console.log(`Tap or Tarp server running on ${HOST}:${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
    console.log(`Active sessions: ${gameSessions.size}`);
  });
}

// Start the server
startServer();
