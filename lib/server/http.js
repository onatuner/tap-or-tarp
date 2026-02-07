/**
 * HTTP Server Configuration
 *
 * Express routes, middleware, and HTTP server setup.
 */

const express = require("express");
const http = require("http");
const path = require("path");
const { logger } = require("../logger");
const metrics = require("../metrics");
const { getLockStats } = require("../lock");
const { serverState } = require("./state");

/**
 * Configure security headers middleware
 * @param {express.Application} app - Express app
 */
function configureSecurityHeaders(app) {
  app.use((req, res, next) => {
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self' ws: wss:",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join("; ")
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-XSS-Protection", "1; mode=block");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });
}

/**
 * Configure health check endpoint
 * @param {express.Application} app - Express app
 * @param {object} rateLimiters - Rate limiter instances
 */
function configureHealthEndpoint(app, rateLimiters) {
  app.get("/health", async (req, res) => {
    let persistedSessions = 0;
    let redisHealth = null;

    try {
      if (serverState.storage) {
        if (serverState.isAsyncStorageMode) {
          persistedSessions = await serverState.storage.count();
          if (serverState.storage.health) {
            redisHealth = await serverState.storage.health();
          }
        } else {
          persistedSessions = serverState.storage.count();
        }
      }
    } catch (error) {
      logger.error({ error: error.message }, "Health check storage error");
    }

    const healthData = {
      status: serverState.isShuttingDown ? "shutting_down" : "healthy",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      instanceId: serverState.instanceId,
      activeSessions: serverState.getSessionCount(),
      activeConnections: serverState.wss ? serverState.wss.clients.size : 0,
      storageType: process.env.STORAGE_TYPE || "sqlite",
      redisPrimaryMode: serverState.isRedisPrimaryMode,
      persistedSessions,
    };

    if (redisHealth) {
      healthData.redis = redisHealth;
    }

    healthData.locks = getLockStats();

    if (rateLimiters) {
      healthData.rateLimiter = {
        messages: rateLimiters.message ? rateLimiters.message.getStats() : null,
        connections: rateLimiters.connection ? rateLimiters.connection.getStats() : null,
      };
    }

    res.status(200).json(healthData);
  });
}

/**
 * Configure metrics endpoint
 * @param {express.Application} app - Express app
 */
function configureMetricsEndpoint(app) {
  app.get("/metrics", async (req, res) => {
    try {
      metrics.setActiveSessions(serverState.getSessionCount());
      metrics.setWebsocketConnections(serverState.wss ? serverState.wss.clients.size : 0);

      res.set("Content-Type", metrics.register.contentType);
      res.end(await metrics.register.metrics());
    } catch (error) {
      logger.error({ error: error.message }, "Failed to generate metrics");
      res.status(500).end("Error generating metrics");
    }
  });
}

/**
 * Configure games list endpoint
 * @param {express.Application} app - Express app
 */
function configureGamesEndpoint(app) {
  app.get("/api/games", async (req, res) => {
    // Prevent caching of game list to avoid stale data
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");

    try {
      const gamesMap = new Map();

      // Load from storage if available
      if (serverState.storage && serverState.storage.loadAll) {
        try {
          let storageSessions;
          if (serverState.isAsyncStorageMode) {
            storageSessions = await serverState.storage.loadAll();
          } else {
            storageSessions = serverState.storage.loadAll();
          }

          for (const { id, state } of storageSessions) {
            // Skip closed games
            if (state.isClosed) continue;

            // Use key-derived id to ensure consistency with load()
            const gameId = id;
            const gameInfo = {
              id: gameId,
              name: state.name || "Game",
              mode: state.mode || "casual",
              status: state.status || "waiting",
              createdAt: state.createdAt,
              lastActivity: state.lastActivity,
              playerCount: state.players?.length || 0,
              claimedCount: state.players?.filter(p => p.claimedBy !== null).length || 0,
              settings: {
                playerCount: state.settings?.playerCount || 2,
                initialTime: state.settings?.initialTime || 600000,
              },
            };
            gamesMap.set(gameInfo.id, gameInfo);
          }
        } catch (storageError) {
          logger.error(
            { error: storageError.message },
            "Failed to load games from storage, using cache only"
          );
        }
      }

      // Merge with in-memory cache (overwrites storage data for consistency)
      for (const [gameId, session] of serverState.getAllSessions()) {
        if (session.isClosed) continue;
        const gameInfo = {
          id: session.id,
          name: session.name,
          mode: session.mode,
          status: session.status,
          createdAt: session.createdAt,
          lastActivity: session.lastActivity,
          playerCount: session.players.length,
          claimedCount: session.players.filter(p => p.claimedBy !== null).length,
          settings: {
            playerCount: session.settings.playerCount,
            initialTime: session.settings.initialTime,
          },
        };
        gamesMap.set(gameInfo.id, gameInfo);
      }

      const games = Array.from(gamesMap.values());
      res.status(200).json({
        games,
        instanceId: serverState.instanceId, // For debugging multi-instance issues
      });
    } catch (error) {
      logger.error({ error: error.message }, "Failed to list games");
      res.status(500).json({ error: "Failed to list games" });
    }
  });
}

/**
 * Configure static file serving
 * @param {express.Application} app - Express app
 */
function configureStaticFiles(app) {
  // Set cache control headers that require revalidation
  // This ensures PWAs always check for updates while still allowing caching
  app.use(
    express.static(path.join(__dirname, "../../public"), {
      etag: true,
      lastModified: true,
      setHeaders: (res, filePath) => {
        // For JS and CSS files, require revalidation on each request
        if (filePath.endsWith(".js") || filePath.endsWith(".css")) {
          res.setHeader("Cache-Control", "no-cache, must-revalidate");
        }
        // For HTML, always revalidate
        else if (filePath.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        }
        // For images and other assets, allow short caching
        else {
          res.setHeader("Cache-Control", "public, max-age=3600");
        }
      },
    })
  );
}

/**
 * Create and configure the Express application
 * @param {object} rateLimiters - Rate limiter instances
 * @returns {{ app: express.Application, server: http.Server }}
 */
function createHttpServer(rateLimiters = {}) {
  const app = express();
  const server = http.createServer(app);

  // Configure middleware and routes
  configureSecurityHeaders(app);
  configureHealthEndpoint(app, rateLimiters);
  configureMetricsEndpoint(app);
  configureGamesEndpoint(app);
  configureStaticFiles(app);

  return { app, server };
}

module.exports = {
  createHttpServer,
  configureSecurityHeaders,
  configureHealthEndpoint,
  configureMetricsEndpoint,
  configureGamesEndpoint,
  configureStaticFiles,
};
