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
const { createStorage, isAsyncStorage } = require("./lib/storage");
const { logger } = require("./lib/logger");
const metrics = require("./lib/metrics");
const { withGameLock, getLockStats } = require("./lib/lock");
const AsyncLock = require("async-lock");

// Separate lock for game creation to prevent ID collisions
const createGameLock = new AsyncLock({ timeout: 5000 });
const Sentry = require("@sentry/node");
const crypto = require("crypto");

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
const REDIS_URL = process.env.REDIS_URL || null;
const PERSISTENCE_INTERVAL = 10000; // Save active games every 10 seconds
const HEARTBEAT_INTERVAL = 30000; // Instance heartbeat every 30 seconds

// Generate unique instance ID for horizontal scaling
const INSTANCE_ID =
  process.env.FLY_ALLOC_ID ||
  process.env.INSTANCE_ID ||
  `instance_${crypto.randomBytes(8).toString("hex")}`;

// ============================================================================
// GLOBAL STATE
// ============================================================================

let isShuttingDown = false;
let storage = null;
let persistenceTimer = null;
let cleanupTimer = null;
let heartbeatTimer = null;
let isAsyncStorageMode = false;

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
app.get("/health", async (req, res) => {
  let persistedSessions = 0;
  let redisHealth = null;

  try {
    if (storage) {
      if (isAsyncStorageMode) {
        persistedSessions = await storage.count();
        if (storage.health) {
          redisHealth = await storage.health();
        }
      } else {
        persistedSessions = storage.count();
      }
    }
  } catch (error) {
    logger.error({ error: error.message }, "Health check storage error");
  }

  const healthData = {
    status: isShuttingDown ? "shutting_down" : "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    instanceId: INSTANCE_ID,
    activeSessions: gameSessions.size,
    activeConnections: wss.clients.size,
    storageType: STORAGE_TYPE,
    persistedSessions,
  };

  if (redisHealth) {
    healthData.redis = redisHealth;
  }

  // Add lock stats for monitoring
  healthData.locks = getLockStats();

  res.status(200).json(healthData);
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

/**
 * Broadcast a message to all local clients in a game
 * @param {string} gameId - Game session ID
 * @param {string} type - Message type
 * @param {object} data - Message data
 */
function broadcastToLocalClients(gameId, type, data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.gameId === gameId) {
      client.send(JSON.stringify({ type, data }));
    }
  });
}

/**
 * Broadcast a message to all clients in a game (including cross-instance via Redis)
 * @param {string} gameId - Game session ID
 * @param {string} type - Message type
 * @param {object} data - Message data
 */
async function broadcastToGame(gameId, type, data) {
  // Always broadcast to local clients first
  broadcastToLocalClients(gameId, type, data);

  // If using Redis, also publish to cross-instance channel
  if (isAsyncStorageMode && storage && storage.broadcast) {
    try {
      await storage.broadcast(gameId, type, data);
    } catch (error) {
      logger.error({ error: error.message, gameId }, "Failed to broadcast via Redis");
    }
  }
}

// Server-specific GameSession that uses WebSocket for broadcasting
class GameSession extends BaseGameSession {
  constructor(id, settings) {
    super(id, settings, (type, data) => {
      // Use async broadcast for cross-instance support
      broadcastToGame(id, type, data).catch(error => {
        logger.error({ error: error.message, gameId: id }, "Broadcast failed");
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

  ws.on("message", async message => {
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

          // Use lock to prevent race condition in ID generation
          try {
            const gameId = await createGameLock.acquire("create", async () => {
              // Generate unique ID while holding lock
              let id;
              let attempts = 0;
              const maxAttempts = 10;

              while (attempts < maxAttempts) {
                id = generateGameId(new Set(gameSessions.keys()));

                // For Redis mode, also check/reserve in Redis
                if (isAsyncStorageMode && storage && storage.reserveGameId) {
                  const reserved = await storage.reserveGameId(id);
                  if (reserved) break;
                } else {
                  // For SQLite/memory mode, just check local map
                  if (!gameSessions.has(id)) break;
                }
                attempts++;
              }

              if (attempts >= maxAttempts) {
                throw new Error("Failed to generate unique game ID");
              }

              // Create and register session while still holding lock
              const session = new GameSession(id, data.settings || {});
              session.setOwner(ws.clientId);
              gameSessions.set(id, session);

              return { id, session };
            });

            ws.gameId = gameId.id;

            // Subscribe to Redis channel for cross-instance messaging
            subscribeToGameChannel(gameId.id).catch(error => {
              logger.error(
                { error: error.message, gameId: gameId.id },
                "Failed to subscribe to game channel"
              );
            });

            ws.send(JSON.stringify({ type: "state", data: gameId.session.getState() }));
            metrics.recordNewSession();
            metrics.recordMessageSent("state");
            logger.info(
              {
                gameId: gameId.id,
                clientId: ws.clientId,
                playerCount: gameId.session.settings.playerCount,
                instanceId: INSTANCE_ID,
              },
              "Game created"
            );
          } catch (error) {
            ws.send(JSON.stringify({ type: "error", data: { message: error.message } }));
            metrics.recordError("create_failed");
            logger.error({ error: error.message, clientId: ws.clientId }, "Failed to create game");
          }
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

          try {
            await withGameLock(data.gameId, async () => {
              ws.gameId = data.gameId;
              session.lastActivity = Date.now();
              // Set owner if not already set (for restored sessions)
              if (!session.ownerId) {
                session.setOwner(ws.clientId);
              }
            });
            ws.send(JSON.stringify({ type: "state", data: session.getState() }));
            metrics.recordMessageSent("state");
            logger.info({ gameId: data.gameId, clientId: ws.clientId }, "Client joined game");
          } catch (error) {
            ws.send(JSON.stringify({ type: "error", data: { message: error.message } }));
            metrics.recordError("join_lock_error");
          }
          break;
        }
        case "start": {
          const session = gameSessions.get(ws.gameId);
          if (session) {
            try {
              await withGameLock(ws.gameId, async () => {
                // Authorization: owner or claimed player can start
                if (!session.canControlGame(ws.clientId)) {
                  ws.send(
                    JSON.stringify({
                      type: "error",
                      data: { message: "Not authorized to start game" },
                    })
                  );
                  metrics.recordAuthDenied("start");
                  logger.warn(
                    { gameId: ws.gameId, clientId: ws.clientId },
                    "Unauthorized start attempt"
                  );
                  return;
                }
                session.lastActivity = Date.now();
                session.start();
                logger.info({ gameId: ws.gameId }, "Game started");
              });
            } catch (error) {
              ws.send(JSON.stringify({ type: "error", data: { message: error.message } }));
              metrics.recordError("start_lock_error");
            }
          }
          break;
        }
        case "pause": {
          const session = gameSessions.get(ws.gameId);
          if (session) {
            try {
              await withGameLock(ws.gameId, async () => {
                // Authorization: owner or claimed player can pause/resume
                if (!session.canControlGame(ws.clientId)) {
                  ws.send(
                    JSON.stringify({
                      type: "error",
                      data: { message: "Not authorized to pause/resume" },
                    })
                  );
                  metrics.recordAuthDenied("pause");
                  return;
                }
                session.lastActivity = Date.now();
                if (session.status === "running") {
                  session.pause();
                  logger.debug({ gameId: ws.gameId }, "Game paused");
                } else if (session.status === "paused") {
                  session.resume();
                  logger.debug({ gameId: ws.gameId }, "Game resumed");
                }
              });
            } catch (error) {
              ws.send(JSON.stringify({ type: "error", data: { message: error.message } }));
              metrics.recordError("pause_lock_error");
            }
          }
          break;
        }
        case "reset": {
          const session = gameSessions.get(ws.gameId);
          if (session) {
            try {
              await withGameLock(ws.gameId, async () => {
                // Authorization: only owner can reset
                if (!session.isOwner(ws.clientId)) {
                  ws.send(
                    JSON.stringify({
                      type: "error",
                      data: { message: "Only the game owner can reset" },
                    })
                  );
                  metrics.recordAuthDenied("reset");
                  return;
                }
                session.lastActivity = Date.now();
                session.reset();
                logger.info({ gameId: ws.gameId }, "Game reset");
              });
            } catch (error) {
              ws.send(JSON.stringify({ type: "error", data: { message: error.message } }));
              metrics.recordError("reset_lock_error");
            }
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

            try {
              await withGameLock(ws.gameId, async () => {
                // Authorization: check switch permissions
                if (!session.canSwitchPlayer(data.playerId, ws.clientId)) {
                  ws.send(
                    JSON.stringify({
                      type: "error",
                      data: { message: "Not authorized to switch players" },
                    })
                  );
                  metrics.recordAuthDenied("switch");
                  return;
                }
                session.lastActivity = Date.now();
                session.switchPlayer(data.playerId);
              });
            } catch (error) {
              ws.send(JSON.stringify({ type: "error", data: { message: error.message } }));
              metrics.recordError("switch_lock_error");
            }
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

            try {
              await withGameLock(ws.gameId, async () => {
                // Authorization: can only modify own player or if owner
                if (!session.canModifyPlayer(data.playerId, ws.clientId)) {
                  ws.send(
                    JSON.stringify({
                      type: "error",
                      data: { message: "Not authorized to modify this player" },
                    })
                  );
                  metrics.recordAuthDenied("updatePlayer");
                  return;
                }
                session.lastActivity = Date.now();
                session.updatePlayer(data.playerId, data);
              });
            } catch (error) {
              ws.send(JSON.stringify({ type: "error", data: { message: error.message } }));
              metrics.recordError("updatePlayer_lock_error");
            }
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

            try {
              await withGameLock(ws.gameId, async () => {
                // Authorization: only owner can add penalties
                if (!session.isOwner(ws.clientId)) {
                  ws.send(
                    JSON.stringify({
                      type: "error",
                      data: { message: "Only the game owner can add penalties" },
                    })
                  );
                  metrics.recordAuthDenied("addPenalty");
                  return;
                }
                session.lastActivity = Date.now();
                session.addPenalty(data.playerId);
                logger.debug({ gameId: ws.gameId, playerId: data.playerId }, "Penalty added");
              });
            } catch (error) {
              ws.send(JSON.stringify({ type: "error", data: { message: error.message } }));
              metrics.recordError("addPenalty_lock_error");
            }
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

            try {
              await withGameLock(ws.gameId, async () => {
                // Authorization: only owner can eliminate
                if (!session.isOwner(ws.clientId)) {
                  ws.send(
                    JSON.stringify({
                      type: "error",
                      data: { message: "Only the game owner can eliminate players" },
                    })
                  );
                  metrics.recordAuthDenied("eliminate");
                  return;
                }
                session.lastActivity = Date.now();
                session.eliminate(data.playerId);
                logger.info({ gameId: ws.gameId, playerId: data.playerId }, "Player eliminated");
              });
            } catch (error) {
              ws.send(JSON.stringify({ type: "error", data: { message: error.message } }));
              metrics.recordError("eliminate_lock_error");
            }
          }
          break;
        }
        case "updateSettings": {
          const session = gameSessions.get(ws.gameId);
          if (session) {
            if (data.warningThresholds !== undefined) {
              if (!validateWarningThresholds(data.warningThresholds)) {
                ws.send(
                  JSON.stringify({ type: "error", data: { message: "Invalid warning thresholds" } })
                );
                metrics.recordError("invalid_warning_thresholds");
                break;
              }
            }

            try {
              await withGameLock(ws.gameId, async () => {
                // Authorization: only owner can update settings
                if (!session.isOwner(ws.clientId)) {
                  ws.send(
                    JSON.stringify({
                      type: "error",
                      data: { message: "Only the game owner can change settings" },
                    })
                  );
                  metrics.recordAuthDenied("updateSettings");
                  return;
                }
                session.lastActivity = Date.now();
                if (data.warningThresholds !== undefined) {
                  session.settings.warningThresholds = data.warningThresholds;
                  session.broadcastState();
                  logger.debug({ gameId: ws.gameId }, "Settings updated");
                }
              });
            } catch (error) {
              ws.send(JSON.stringify({ type: "error", data: { message: error.message } }));
              metrics.recordError("updateSettings_lock_error");
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

            try {
              await withGameLock(ws.gameId, async () => {
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
              });
            } catch (error) {
              ws.send(JSON.stringify({ type: "error", data: { message: error.message } }));
              metrics.recordError("claim_lock_error");
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

          try {
            await withGameLock(data.gameId, async () => {
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
            });
          } catch (error) {
            ws.send(JSON.stringify({ type: "error", data: { message: error.message } }));
            metrics.recordError("reconnect_lock_error");
          }
          break;
        }
        case "unclaim": {
          const session = gameSessions.get(ws.gameId);
          if (session) {
            try {
              await withGameLock(ws.gameId, async () => {
                session.lastActivity = Date.now();
                session.unclaimPlayer(ws.clientId);
              });
            } catch (error) {
              ws.send(JSON.stringify({ type: "error", data: { message: error.message } }));
              metrics.recordError("unclaim_lock_error");
            }
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
 * Save all active sessions to storage (supports both sync and async storage)
 * Uses batch transactions for SQLite to ensure atomicity and performance
 */
async function persistSessions() {
  if (!storage || isShuttingDown) return;

  const endTimer = metrics.startStorageSaveTimer();
  let savedCount = 0;
  let errorCount = 0;

  try {
    if (isAsyncStorageMode) {
      // Redis: save individually (each operation is already atomic)
      for (const [gameId, session] of gameSessions.entries()) {
        try {
          await storage.save(gameId, session.toJSON());
          metrics.recordStorageOperation("save", "success");
          savedCount++;
        } catch (error) {
          logger.error({ gameId, error: error.message }, "Failed to persist session");
          metrics.recordStorageOperation("save", "error");
          errorCount++;
        }
      }
    } else if (storage.saveBatch) {
      // SQLite/Memory: use batch save for atomic transaction
      const sessions = Array.from(gameSessions.entries()).map(([id, session]) => ({
        id,
        state: session.toJSON(),
      }));

      if (sessions.length > 0) {
        const count = storage.saveBatch(sessions);
        if (count === sessions.length) {
          savedCount = count;
          metrics.recordStorageOperation("save_batch", "success");
        } else {
          // Partial save or failure - fall back to individual saves
          logger.warn(
            { expected: sessions.length, actual: count },
            "Batch save incomplete, retrying individually"
          );
          for (const { id, state } of sessions) {
            try {
              storage.save(id, state);
              metrics.recordStorageOperation("save", "success");
              savedCount++;
            } catch (error) {
              logger.error({ gameId: id, error: error.message }, "Failed to persist session");
              metrics.recordStorageOperation("save", "error");
              errorCount++;
            }
          }
        }
      }
    } else {
      // Fallback: save individually
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
    }
  } catch (error) {
    logger.error({ error: error.message }, "Persistence cycle failed");
    metrics.recordStorageOperation("save_batch", "error");
    errorCount = gameSessions.size;
  }

  endTimer();
  if (savedCount > 0 || errorCount > 0) {
    logger.debug({ savedCount, errorCount }, "Persistence cycle completed");
  }
}

/**
 * Load sessions from storage on startup (supports both sync and async storage)
 */
async function loadSessions() {
  if (!storage) return;

  try {
    let savedSessions;
    if (isAsyncStorageMode) {
      savedSessions = await storage.loadAll();
    } else {
      savedSessions = storage.loadAll();
    }
    logger.info({ count: savedSessions.length }, "Found persisted sessions");

    for (const { id, state } of savedSessions) {
      try {
        const session = BaseGameSession.fromState(state, (type, data) => {
          // Use async broadcast for cross-instance support
          broadcastToGame(id, type, data).catch(error => {
            logger.error({ error: error.message, gameId: id }, "Broadcast failed");
          });
        });
        gameSessions.set(id, session);

        // Subscribe to Redis channel for this game if using Redis
        if (isAsyncStorageMode && storage.subscribeToGame) {
          await subscribeToGameChannel(id);
        }

        metrics.recordRestoredSession();
        metrics.recordStorageOperation("load", "success");
        logger.info({ gameId: id, status: session.status }, "Restored session");
      } catch (error) {
        logger.error({ gameId: id, error: error.message }, "Failed to restore session");
        metrics.recordStorageOperation("load", "error");
        if (isAsyncStorageMode) {
          await storage.delete(id);
        } else {
          storage.delete(id);
        }
      }
    }
  } catch (error) {
    logger.error({ error: error.message }, "Failed to load sessions");
    metrics.recordError("session_load_failed");
  }
}

/**
 * Subscribe to a game's Redis channel for cross-instance messaging
 * @param {string} gameId - Game session ID
 */
async function subscribeToGameChannel(gameId) {
  if (!isAsyncStorageMode || !storage || !storage.subscribeToGame) return;

  try {
    await storage.subscribeToGame(gameId, message => {
      // Handle messages from other instances
      handleCrossInstanceMessage(gameId, message);
    });
    logger.debug({ gameId }, "Subscribed to game channel");
  } catch (error) {
    logger.error({ error: error.message, gameId }, "Failed to subscribe to game channel");
  }
}

/**
 * Handle a message received from another instance via Redis
 * @param {string} gameId - Game session ID
 * @param {object} message - Message from Redis
 */
function handleCrossInstanceMessage(gameId, message) {
  // Skip if this message originated from this instance
  if (message.instanceId === INSTANCE_ID) return;

  // Broadcast to local clients only (already handled by other instance locally)
  if (message.type && message.data) {
    broadcastToLocalClients(gameId, message.type, message.data);
    logger.debug({ gameId, type: message.type }, "Relayed cross-instance message");
  }
}

/**
 * Session cleanup routine (supports both sync and async storage)
 */
async function cleanupSessions() {
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
        try {
          if (isAsyncStorageMode) {
            await storage.delete(gameId);
            if (storage.unsubscribe) {
              await storage.unsubscribe(`broadcast:${gameId}`);
            }
          } else {
            storage.delete(gameId);
          }
          metrics.recordStorageOperation("delete", "success");
        } catch (error) {
          logger.error({ gameId, error: error.message }, "Failed to delete session from storage");
          metrics.recordStorageOperation("delete", "error");
        }
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

  logger.info({ signal, instanceId: INSTANCE_ID }, "Starting graceful shutdown");

  // Clear timers
  if (persistenceTimer) clearInterval(persistenceTimer);
  if (cleanupTimer) clearInterval(cleanupTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);

  // Persist all sessions before shutdown
  logger.info("Persisting sessions before shutdown");
  try {
    await persistSessions();
  } catch (error) {
    logger.error({ error: error.message }, "Error during final persistence");
  }

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
    try {
      if (isAsyncStorageMode) {
        await storage.close();
      } else {
        storage.close();
      }
    } catch (error) {
      logger.error({ error: error.message }, "Error closing storage");
    }
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

async function startServer() {
  logger.info({ instanceId: INSTANCE_ID }, "Starting server instance");

  // Initialize storage
  try {
    // Determine storage configuration
    if (STORAGE_TYPE === "redis" && REDIS_URL) {
      storage = createStorage("redis", {
        url: REDIS_URL,
        instanceId: INSTANCE_ID,
      });
      isAsyncStorageMode = true;
      logger.info({ storageType: "redis", instanceId: INSTANCE_ID }, "Redis storage initialized");

      // Subscribe to global events channel
      if (storage.subscribe) {
        await storage.subscribe("global:events", message => {
          logger.debug({ eventType: message.eventType }, "Received global event");
        });
      }

      // Start heartbeat for instance registration
      heartbeatTimer = setInterval(async () => {
        if (storage && storage.heartbeat) {
          await storage.heartbeat();
        }
      }, HEARTBEAT_INTERVAL);
    } else {
      storage = createStorage(STORAGE_TYPE, DB_PATH);
      isAsyncStorageMode = isAsyncStorage(STORAGE_TYPE);
      logger.info({ storageType: STORAGE_TYPE, dbPath: DB_PATH }, "Storage initialized");
    }
  } catch (error) {
    logger.error({ error: error.message }, "Failed to initialize storage");
    logger.warn("Continuing with in-memory storage only");
    storage = createStorage("memory");
    isAsyncStorageMode = false;
  }

  // Load persisted sessions
  await loadSessions();

  // Start persistence timer (async-aware)
  persistenceTimer = setInterval(async () => {
    try {
      await persistSessions();
    } catch (error) {
      logger.error({ error: error.message }, "Persistence timer error");
    }
  }, PERSISTENCE_INTERVAL);

  // Start cleanup timer (async-aware)
  cleanupTimer = setInterval(async () => {
    try {
      await cleanupSessions();
    } catch (error) {
      logger.error({ error: error.message }, "Cleanup timer error");
    }
  }, CONSTANTS.SESSION_CLEANUP_INTERVAL);

  // Start HTTP server
  server.listen(PORT, HOST, () => {
    logger.info(
      {
        host: HOST,
        port: PORT,
        env: process.env.NODE_ENV || "development",
        instanceId: INSTANCE_ID,
        storageType: STORAGE_TYPE,
        activeSessions: gameSessions.size,
      },
      "Tap or Tarp server started"
    );
  });
}

// Start the server
startServer().catch(error => {
  logger.fatal({ error: error.message }, "Failed to start server");
  process.exit(1);
});
