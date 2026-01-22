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
const { logger } = require("./lib/logger");
const metrics = require("./lib/metrics");
const Sentry = require("@sentry/node");

// ============================================================================
// SENTRY ERROR TRACKING (Optional)
// ============================================================================

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
    beforeSend(event) {
      // Don't send events during shutdown
      if (event.extra && event.extra.isShuttingDown) {
        return null;
      }
      return event;
    },
  });
  logger.info("Sentry error tracking initialized");
}

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

// ============================================================================
// SECURITY HEADERS
// ============================================================================

// Content Security Policy
app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'", // Allow inline styles for dynamic UI
      "img-src 'self' data:", // Allow data URIs for icons
      "font-src 'self'",
      "connect-src 'self' ws: wss:", // Allow WebSocket connections
      "frame-ancestors 'none'", // Prevent clickjacking
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ")
  );
  // Additional security headers
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

// ============================================================================
// WEBSOCKET ORIGIN VALIDATION
// ============================================================================

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map(o => o.trim())
  : null; // null means allow all origins (for development)

const wss = new WebSocket.Server({
  server,
  maxPayload: 64 * 1024, // 64KB max message size
  verifyClient: ({ origin, req }, callback) => {
    // If no allowed origins configured, allow all (development mode)
    if (!ALLOWED_ORIGINS) {
      callback(true);
      return;
    }

    // Allow requests with no origin (non-browser clients, same-origin)
    if (!origin) {
      callback(true);
      return;
    }

    // Check if origin is in allowed list
    const isAllowed = ALLOWED_ORIGINS.some(allowed => {
      // Exact match
      if (origin === allowed) return true;
      // Subdomain match (e.g., *.fly.dev)
      if (allowed.startsWith("*.")) {
        const domain = allowed.slice(2);
        return origin.endsWith(domain) || origin.endsWith("://" + domain);
      }
      return false;
    });

    if (!isAllowed) {
      logger.warn(
        { origin, allowedOrigins: ALLOWED_ORIGINS },
        "Rejected WebSocket connection from unauthorized origin"
      );
      callback(false, 403, "Forbidden: Origin not allowed");
      return;
    }

    callback(true);
  },
});

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

// Prometheus metrics endpoint
app.get("/metrics", async (req, res) => {
  try {
    // Update gauges before serving metrics
    metrics.setActiveSessions(gameSessions.size);
    metrics.setWebsocketConnections(wss.clients.size);

    res.set("Content-Type", metrics.register.contentType);
    res.end(await metrics.register.metrics());
  } catch (error) {
    logger.error({ error: error.message }, "Failed to generate metrics");
    res.status(500).end("Error generating metrics");
  }
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

  // Record new connection
  metrics.recordNewConnection();
  logger.debug({ clientId: ws.clientId }, "New WebSocket connection");

  // Sentry: Add breadcrumb for new connection
  if (process.env.SENTRY_DSN) {
    Sentry.addBreadcrumb({
      category: "websocket",
      message: "New WebSocket connection",
      level: "info",
      data: { clientId: ws.clientId },
    });
  }

  // Send the client their ID
  ws.send(JSON.stringify({ type: "clientId", data: { clientId: ws.clientId } }));
  metrics.recordMessageSent("clientId");

  ws.on("message", message => {
    // Rate limiting
    const now = Date.now();
    ws.messageTimestamps = ws.messageTimestamps.filter(
      ts => now - ts < CONSTANTS.RATE_LIMIT_WINDOW
    );

    if (ws.messageTimestamps.length >= CONSTANTS.RATE_LIMIT_MAX_MESSAGES) {
      ws.send(JSON.stringify({ type: "error", data: { message: "Rate limit exceeded" } }));
      metrics.recordRateLimitExceeded();
      logger.warn({ clientId: ws.clientId }, "Rate limit exceeded");
      return;
    }
    ws.messageTimestamps.push(now);

    try {
      const parsed = JSON.parse(message);
      const type = parsed.type;
      const data = parsed.data || {};

      if (!type || typeof type !== "string") {
        ws.send(JSON.stringify({ type: "error", data: { message: "Invalid message type" } }));
        metrics.recordError("invalid_message_type");
        return;
      }

      // Sentry: Set user context and add breadcrumb for message
      if (process.env.SENTRY_DSN) {
        Sentry.setUser({ id: ws.clientId });
        Sentry.setContext("websocket", {
          clientId: ws.clientId,
          gameId: ws.gameId || null,
        });
        Sentry.addBreadcrumb({
          category: "websocket.message",
          message: `Received ${type} message`,
          level: "info",
          data: { type, gameId: ws.gameId || null },
        });
      }

      // Record message received
      metrics.recordMessageReceived(type);

      switch (type) {
        case "create": {
          if (!validateSettings(data.settings)) {
            ws.send(JSON.stringify({ type: "error", data: { message: "Invalid settings" } }));
            metrics.recordError("invalid_settings");
            break;
          }
          const gameId = generateGameId(new Set(gameSessions.keys()));
          const session = new GameSession(gameId, data.settings || {});
          session.setOwner(ws.clientId); // Set creator as owner
          gameSessions.set(gameId, session);
          ws.gameId = gameId;
          ws.send(JSON.stringify({ type: "state", data: session.getState() }));
          metrics.recordNewSession();
          metrics.recordMessageSent("state");
          logger.info(
            { gameId, clientId: ws.clientId, playerCount: session.settings.playerCount },
            "Game created"
          );
          break;
        }
        case "join": {
          const session = gameSessions.get(data.gameId);
          if (!session) {
            ws.send(JSON.stringify({ type: "error", data: { message: "Game not found" } }));
            metrics.recordError("game_not_found");
            logger.debug(
              { gameId: data.gameId, clientId: ws.clientId },
              "Join attempt for non-existent game"
            );
            break;
          }
          ws.gameId = data.gameId;
          session.lastActivity = Date.now();
          // Set owner if not already set (for restored sessions)
          if (!session.ownerId) {
            session.setOwner(ws.clientId);
          }
          ws.send(JSON.stringify({ type: "state", data: session.getState() }));
          metrics.recordMessageSent("state");
          logger.info({ gameId: data.gameId, clientId: ws.clientId }, "Client joined game");
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
              metrics.recordAuthDenied("start");
              logger.warn(
                { gameId: ws.gameId, clientId: ws.clientId },
                "Unauthorized start attempt"
              );
              break;
            }
            session.lastActivity = Date.now();
            session.start();
            logger.info({ gameId: ws.gameId }, "Game started");
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
              metrics.recordAuthDenied("pause");
              break;
            }
            session.lastActivity = Date.now();
            if (session.status === "running") {
              session.pause();
              logger.debug({ gameId: ws.gameId }, "Game paused");
            } else if (session.status === "paused") {
              session.resume();
              logger.debug({ gameId: ws.gameId }, "Game resumed");
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
              metrics.recordAuthDenied("reset");
              break;
            }
            session.lastActivity = Date.now();
            session.reset();
            logger.info({ gameId: ws.gameId }, "Game reset");
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
              metrics.recordAuthDenied("switch");
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
              metrics.recordAuthDenied("updatePlayer");
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
              metrics.recordAuthDenied("addPenalty");
              break;
            }
            session.lastActivity = Date.now();
            session.addPenalty(data.playerId);
            logger.debug({ gameId: ws.gameId, playerId: data.playerId }, "Penalty added");
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
              metrics.recordAuthDenied("eliminate");
              break;
            }
            session.lastActivity = Date.now();
            session.eliminate(data.playerId);
            logger.info({ gameId: ws.gameId, playerId: data.playerId }, "Player eliminated");
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
              metrics.recordAuthDenied("updateSettings");
              break;
            }
            session.lastActivity = Date.now();
            if (data.warningThresholds !== undefined) {
              if (!validateWarningThresholds(data.warningThresholds)) {
                ws.send(
                  JSON.stringify({ type: "error", data: { message: "Invalid warning thresholds" } })
                );
                metrics.recordError("invalid_warning_thresholds");
                break;
              }
              session.settings.warningThresholds = data.warningThresholds;
              session.broadcastState();
              logger.debug({ gameId: ws.gameId }, "Settings updated");
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
            const result = session.claimPlayer(data.playerId, ws.clientId);
            if (!result.success) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  data: { message: result.reason || "Cannot claim this player" },
                })
              );
              metrics.recordError("claim_failed");
            } else {
              // Send the reconnection token to the client (private message)
              ws.send(
                JSON.stringify({
                  type: "claimed",
                  data: {
                    playerId: data.playerId,
                    token: result.token,
                    gameId: ws.gameId,
                  },
                })
              );
              metrics.recordMessageSent("claimed");
              logger.debug(
                { gameId: ws.gameId, playerId: data.playerId, clientId: ws.clientId },
                "Player claimed with reconnection token"
              );
            }
          }
          break;
        }
        case "reconnect": {
          // Attempt to reclaim a player slot using a reconnection token
          const session = gameSessions.get(data.gameId);
          if (!session) {
            ws.send(JSON.stringify({ type: "error", data: { message: "Game not found" } }));
            metrics.recordError("reconnect_game_not_found");
            break;
          }
          if (
            data.playerId === undefined ||
            data.playerId < 1 ||
            data.playerId > CONSTANTS.MAX_PLAYERS
          ) {
            ws.send(JSON.stringify({ type: "error", data: { message: "Invalid player ID" } }));
            metrics.recordError("reconnect_invalid_player");
            break;
          }
          if (!data.token || typeof data.token !== "string") {
            ws.send(JSON.stringify({ type: "error", data: { message: "Invalid token" } }));
            metrics.recordError("reconnect_invalid_token");
            break;
          }

          const result = session.reconnectPlayer(data.playerId, data.token, ws.clientId);
          if (!result.success) {
            ws.send(
              JSON.stringify({
                type: "error",
                data: { message: result.reason || "Reconnection failed" },
              })
            );
            metrics.recordError("reconnect_failed");
            logger.debug(
              { gameId: data.gameId, playerId: data.playerId, reason: result.reason },
              "Reconnection failed"
            );
          } else {
            ws.gameId = data.gameId;
            // Send new token and current state
            ws.send(
              JSON.stringify({
                type: "reconnected",
                data: {
                  playerId: data.playerId,
                  token: result.token,
                  gameId: data.gameId,
                },
              })
            );
            ws.send(JSON.stringify({ type: "state", data: session.getState() }));
            metrics.recordMessageSent("reconnected");
            metrics.recordMessageSent("state");
            logger.info(
              { gameId: data.gameId, playerId: data.playerId, clientId: ws.clientId },
              "Player reconnected successfully"
            );
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
      logger.error({ error: e.message, clientId: ws.clientId }, "Invalid JSON received");
      metrics.recordError("invalid_json");
      return;
    }
  });

  ws.on("close", () => {
    logger.debug({ clientId: ws.clientId, gameId: ws.gameId }, "WebSocket connection closed");

    // Sentry: Add breadcrumb for connection close
    if (process.env.SENTRY_DSN) {
      Sentry.addBreadcrumb({
        category: "websocket",
        message: "WebSocket connection closed",
        level: "info",
        data: { clientId: ws.clientId, gameId: ws.gameId },
      });
    }

    const session = gameSessions.get(ws.gameId);
    if (session) {
      // Unclaim any players claimed by this client
      session.handleClientDisconnect(ws.clientId);

      const clientsConnected = Array.from(wss.clients).filter(
        client => client.gameId === ws.gameId && client.readyState === WebSocket.OPEN
      ).length;

      if (clientsConnected === 0 && session.status === "running") {
        session.pause();
        logger.info({ gameId: ws.gameId }, "Game auto-paused - no clients connected");
      }
    }
  });

  ws.on("error", error => {
    logger.error({ error: error.message, clientId: ws.clientId }, "WebSocket error");
    metrics.recordError("websocket_error");

    // Sentry: Capture WebSocket error
    if (process.env.SENTRY_DSN) {
      Sentry.captureException(error, {
        extra: {
          clientId: ws.clientId,
          gameId: ws.gameId,
        },
      });
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

  const endTimer = metrics.startStorageSaveTimer();
  let savedCount = 0;
  let errorCount = 0;

  for (const [gameId, session] of gameSessions.entries()) {
    try {
      storage.save(gameId, session.toJSON());
      metrics.recordStorageOperation("save", "success");
      savedCount++;
    } catch (error) {
      logger.error({ gameId, error: error.message }, "Failed to persist session");
      metrics.recordStorageOperation("save", "error");
      errorCount++;
    }
  }

  endTimer();
  if (savedCount > 0 || errorCount > 0) {
    logger.debug({ savedCount, errorCount }, "Persistence cycle completed");
  }
}

/**
 * Load sessions from storage on startup
 */
function loadSessions() {
  if (!storage) return;

  try {
    const savedSessions = storage.loadAll();
    logger.info({ count: savedSessions.length }, "Found persisted sessions");

    for (const { id, state } of savedSessions) {
      try {
        const session = BaseGameSession.fromState(state, (type, data) => {
          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.gameId === id) {
              client.send(JSON.stringify({ type, data }));
              metrics.recordMessageSent(type);
            }
          });
        });
        gameSessions.set(id, session);
        metrics.recordRestoredSession();
        metrics.recordStorageOperation("load", "success");
        logger.info({ gameId: id, status: session.status }, "Restored session");
      } catch (error) {
        logger.error({ gameId: id, error: error.message }, "Failed to restore session");
        metrics.recordStorageOperation("load", "error");
        storage.delete(id);
      }
    }
  } catch (error) {
    logger.error({ error: error.message }, "Failed to load sessions");
    metrics.recordError("session_load_failed");
  }
}

/**
 * Session cleanup routine
 */
function cleanupSessions() {
  const now = Date.now();
  let cleanedCount = 0;

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
        metrics.recordStorageOperation("delete", "success");
      }
      logger.info({ gameId }, "Session cleaned up");
      cleanedCount++;
    }
  }

  if (cleanedCount > 0) {
    logger.info({ cleanedCount, remaining: gameSessions.size }, "Cleanup cycle completed");
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

  logger.info({ signal }, "Starting graceful shutdown");

  // Clear timers
  if (persistenceTimer) clearInterval(persistenceTimer);
  if (cleanupTimer) clearInterval(cleanupTimer);

  // Persist all sessions before shutdown
  logger.info("Persisting sessions before shutdown");
  persistSessions();

  // Close WebSocket server (stop accepting new connections)
  logger.info("Closing WebSocket server");
  wss.close(() => {
    logger.info("WebSocket server closed");
  });

  // Notify connected clients
  const clientCount = wss.clients.size;
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
  logger.info({ clientCount }, "Notified clients of shutdown");

  // Cleanup all sessions
  for (const [, session] of gameSessions.entries()) {
    session.cleanup();
  }

  // Close storage
  if (storage) {
    logger.info("Closing storage");
    storage.close();
  }

  // Close HTTP server
  logger.info("Closing HTTP server");
  server.close(() => {
    logger.info("HTTP server closed");
    logger.info("Graceful shutdown complete");
    process.exit(exitCode);
  });

  // Force exit after timeout
  setTimeout(() => {
    logger.error("Forced shutdown after timeout");
    process.exit(exitCode);
  }, 10000);
}

// ============================================================================
// ERROR HANDLERS
// ============================================================================

process.on("uncaughtException", error => {
  logger.fatal({ error: error.message, stack: error.stack }, "Uncaught Exception");
  metrics.recordError("uncaught_exception");
  if (process.env.SENTRY_DSN) {
    Sentry.captureException(error);
  }
  gracefulShutdown("uncaughtException", 1);
});

process.on("unhandledRejection", reason => {
  logger.error({ reason: String(reason) }, "Unhandled Rejection");
  metrics.recordError("unhandled_rejection");
  if (process.env.SENTRY_DSN) {
    Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
  }
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
    logger.info({ storageType: STORAGE_TYPE, dbPath: DB_PATH }, "Storage initialized");
  } catch (error) {
    logger.error({ error: error.message }, "Failed to initialize storage");
    logger.warn("Continuing with in-memory storage only");
  }

  // Load persisted sessions
  loadSessions();

  // Start persistence timer
  persistenceTimer = setInterval(persistSessions, PERSISTENCE_INTERVAL);

  // Start cleanup timer
  cleanupTimer = setInterval(cleanupSessions, CONSTANTS.SESSION_CLEANUP_INTERVAL);

  // Start HTTP server
  server.listen(PORT, HOST, () => {
    logger.info(
      {
        host: HOST,
        port: PORT,
        env: process.env.NODE_ENV || "development",
        activeSessions: gameSessions.size,
      },
      "Tap or Tarp server started"
    );
  });
}

// Start the server
startServer();
