/**
 * Tap or Tarp - Game Timer Server
 *
 * Main entry point for the server. Uses modular components from lib/server/.
 */

const WebSocket = require("ws");
const Sentry = require("@sentry/node");

// Import modular server components
const {
  serverState,
  createHttpServer,
  createWebSocketServer,
  safeSend,
  createMessageHandler,
  persistSessions,
  loadSessions,
  cleanupSessions,
  handleClientDisconnect,
} = require("./lib/server");

// Import supporting modules
const { createStorage, isAsyncStorage } = require("./lib/storage");
const { logger } = require("./lib/logger");
const metrics = require("./lib/metrics");
const { CONSTANTS } = require("./lib/shared/constants");
const { RateLimiter, ConnectionRateLimiter, getClientIP } = require("./lib/rate-limiter");

// ============================================================================
// CONFIGURATION
// ============================================================================

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
const STORAGE_TYPE = process.env.STORAGE_TYPE || "sqlite";
const DB_PATH = process.env.DB_PATH || "./data/sessions.db";
const REDIS_URL = process.env.REDIS_URL || null;
const REDIS_PRIMARY = process.env.REDIS_PRIMARY === "true";
const CONNECTION_DRAIN_TIMEOUT = 30000;

// ============================================================================
// SENTRY ERROR TRACKING (Optional)
// ============================================================================

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
    beforeSend(event) {
      if (event.extra && event.extra.isShuttingDown) {
        return null;
      }
      return event;
    },
  });
  logger.info("Sentry error tracking initialized");
}

// ============================================================================
// RATE LIMITERS
// ============================================================================

const rateLimiters = {
  message: new RateLimiter({
    windowMs: 1000,
    maxRequests: 30,
  }),
  connection: new ConnectionRateLimiter({
    windowMs: 60000,
    maxConnections: 20,
  }),
};

// ============================================================================
// SERVER SETUP
// ============================================================================

// Create HTTP server with Express app
const { app, server } = createHttpServer(rateLimiters);

// Create WebSocket server
const wss = createWebSocketServer(server, rateLimiters, getClientIP);

// Create message handler
const handleMessage = createMessageHandler(rateLimiters);

// ============================================================================
// WEBSOCKET CONNECTION HANDLING
// ============================================================================

wss.on("connection", (ws, req) => {
  ws.clientId = serverState.generateClientId();
  ws.clientIP = req.clientIP || getClientIP(req);
  ws.messageTimestamps = [];

  // Record new connection
  metrics.recordNewConnection();
  logger.debug({ clientId: ws.clientId, ip: ws.clientIP }, "New WebSocket connection");

  // Sentry breadcrumb
  if (process.env.SENTRY_DSN) {
    Sentry.addBreadcrumb({
      category: "websocket",
      message: "New WebSocket connection",
      level: "info",
      data: { clientId: ws.clientId, ip: ws.clientIP },
    });
  }

  // Send client their ID
  safeSend(ws, JSON.stringify({ type: "clientId", data: { clientId: ws.clientId } }));
  metrics.recordMessageSent("clientId");

  // Message handler
  ws.on("message", async message => {
    // Sentry context
    if (process.env.SENTRY_DSN) {
      Sentry.setUser({ id: ws.clientId });
      Sentry.setContext("websocket", {
        clientId: ws.clientId,
        gameId: ws.gameId || null,
      });
      Sentry.addBreadcrumb({
        category: "websocket.message",
        message: "Message received",
        level: "info",
        data: { gameId: ws.gameId || null },
      });
    }

    await handleMessage(ws, message);
  });

  // Connection close handler
  ws.on("close", () => {
    handleClientDisconnect(ws);

    if (process.env.SENTRY_DSN) {
      Sentry.addBreadcrumb({
        category: "websocket",
        message: "WebSocket connection closed",
        level: "info",
        data: { clientId: ws.clientId, gameId: ws.gameId },
      });
    }
  });

  // Error handler
  ws.on("error", error => {
    logger.error({ error: error.message, clientId: ws.clientId }, "WebSocket error");
    metrics.recordError("websocket_error");

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
// GRACEFUL SHUTDOWN
// ============================================================================

async function gracefulShutdown(signal, exitCode = 0) {
  if (serverState.isShuttingDown) return;
  serverState.beginShutdown();

  logger.info({ signal, instanceId: serverState.instanceId }, "Starting graceful shutdown");

  // Clear timers
  serverState.clearTimers();

  // Close rate limiters
  rateLimiters.message.close();
  rateLimiters.connection.close();

  // Stop accepting new HTTP connections
  logger.info("Stopping HTTP server from accepting new connections");
  server.close(() => {
    logger.info("HTTP server stopped accepting connections");
  });

  // Notify connected clients
  const initialClientCount = wss.clients.size;
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        safeSend(
          client,
          JSON.stringify({
            type: "shutdown_warning",
            data: {
              message: "Server is shutting down. Please save your game state.",
              timeout: CONNECTION_DRAIN_TIMEOUT,
            },
          })
        );
      } catch (e) {
        // Ignore errors
      }
    }
  });
  logger.info({ clientCount: initialClientCount }, "Notified clients of impending shutdown");

  // Connection draining
  logger.info({ timeout: CONNECTION_DRAIN_TIMEOUT }, "Starting connection drain");
  const drainStart = Date.now();

  while (wss.clients.size > 0 && Date.now() - drainStart < CONNECTION_DRAIN_TIMEOUT) {
    const remaining = wss.clients.size;
    const elapsed = Date.now() - drainStart;
    const timeLeft = Math.ceil((CONNECTION_DRAIN_TIMEOUT - elapsed) / 1000);

    logger.info(
      {
        remaining,
        timeLeft: `${timeLeft}s`,
        elapsed: `${Math.floor(elapsed / 1000)}s`,
      },
      "Draining connections"
    );

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Force close remaining clients
  if (wss.clients.size > 0) {
    logger.warn(
      { remaining: wss.clients.size },
      "Drain timeout reached, forcing client disconnection"
    );
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
  } else {
    logger.info("All clients disconnected gracefully");
  }

  // Persist sessions
  logger.info("Persisting sessions before shutdown");
  try {
    await persistSessions();
  } catch (error) {
    logger.error({ error: error.message }, "Error during final persistence");
  }

  // Close WebSocket server
  logger.info("Closing WebSocket server");
  wss.close(() => {
    logger.info("WebSocket server closed");
  });

  // Cleanup all sessions
  serverState.cleanupAllSessions();

  // Close storage
  if (serverState.storage) {
    logger.info("Closing storage");
    try {
      if (serverState.isAsyncStorageMode) {
        await serverState.storage.close();
      } else {
        serverState.storage.close();
      }
    } catch (error) {
      logger.error({ error: error.message }, "Error closing storage");
    }
  }

  logger.info("Graceful shutdown complete");
  process.exit(exitCode);
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
});

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// ============================================================================
// SERVER STARTUP
// ============================================================================

async function startServer() {
  logger.info({ instanceId: serverState.instanceId }, "Starting server instance");

  // Initialize storage
  try {
    let storage;
    let isAsync = false;
    let isRedisPrimary = false;

    if (STORAGE_TYPE === "redis" && REDIS_URL) {
      storage = createStorage("redis", {
        url: REDIS_URL,
        instanceId: serverState.instanceId,
      });
      isAsync = true;
      isRedisPrimary = REDIS_PRIMARY;
      logger.info(
        {
          storageType: "redis",
          instanceId: serverState.instanceId,
          redisPrimary: isRedisPrimary,
        },
        "Redis storage initialized"
      );

      // Subscribe to global events channel
      if (storage.subscribe) {
        await storage.subscribe("global:events", message => {
          logger.debug({ eventType: message.eventType }, "Received global event");
        });
      }

      // Start heartbeat
      serverState.heartbeatTimer = setInterval(async () => {
        if (storage && storage.heartbeat) {
          await storage.heartbeat();
        }
      }, CONSTANTS.HEARTBEAT_INTERVAL);
    } else {
      storage = createStorage(STORAGE_TYPE, DB_PATH);
      isAsync = isAsyncStorage(STORAGE_TYPE);
      logger.info({ storageType: STORAGE_TYPE, dbPath: DB_PATH }, "Storage initialized");
    }

    serverState.setStorage(storage, isAsync, isRedisPrimary);
  } catch (error) {
    logger.error({ error: error.message, stack: error.stack }, "Failed to initialize storage");
    logger.warn("Continuing with in-memory storage only");
    serverState.setStorage(createStorage("memory"), false, false);
  }

  // Verify storage is working
  if (serverState.storage) {
    try {
      const testId = `_persistence_test_${Date.now()}`;
      const testState = { test: true, timestamp: Date.now() };

      if (serverState.isAsyncStorageMode) {
        await serverState.storage.save(testId, testState);
        const loaded = await serverState.storage.load(testId);
        await serverState.storage.delete(testId);
        if (!loaded) {
          logger.error("Storage verification FAILED - save/load cycle broken");
        } else {
          logger.info("Storage verification passed");
        }
      } else {
        serverState.storage.save(testId, testState);
        const loaded = serverState.storage.load(testId);
        serverState.storage.delete(testId);
        if (!loaded) {
          logger.error("Storage verification FAILED - save/load cycle broken");
        } else {
          logger.info("Storage verification passed");
        }
      }
    } catch (error) {
      logger.error({ error: error.message, stack: error.stack }, "Storage verification threw error");
    }
  }

  // Load persisted sessions
  logger.info("Loading persisted sessions...");
  await loadSessions();
  logger.info(`Loaded ${serverState.getSessionCount()} sessions from storage`);

  // Verify feedback storage
  if (serverState.storage && serverState.storage.loadAllFeedbacks) {
    try {
      const feedbacks = serverState.isAsyncStorageMode
        ? await serverState.storage.loadAllFeedbacks()
        : serverState.storage.loadAllFeedbacks();
      logger.info({ feedbackCount: feedbacks.length }, "Feedback entries in storage");
    } catch (error) {
      logger.error({ error: error.message }, "Failed to verify feedback storage");
    }
  }

  // Start persistence timer
  serverState.persistenceTimer = setInterval(async () => {
    try {
      await persistSessions();
    } catch (error) {
      logger.error({ error: error.message }, "Persistence timer error");
    }
  }, CONSTANTS.PERSISTENCE_INTERVAL);

  // Start cleanup timer
  serverState.cleanupTimer = setInterval(async () => {
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
        instanceId: serverState.instanceId,
        storageType: STORAGE_TYPE,
        activeSessions: serverState.getSessionCount(),
      },
      "Tap or Tarp server started"
    );
    logger.info(`Server listening on ${HOST}:${PORT}`);
  });
}

// Start the server
startServer().catch(error => {
  logger.fatal({ error: error.message }, "Failed to start server");
  process.exit(1);
});
