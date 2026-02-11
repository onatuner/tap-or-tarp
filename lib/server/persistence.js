/**
 * Session Persistence
 *
 * Handles saving and loading game sessions to/from storage.
 */

const { logger } = require("../logger");
const metrics = require("../metrics");
const { serverState } = require("./state");
const { broadcastToGame, subscribeToGameChannel } = require("./websocket");
const { restoreGameSession } = require("../game-modes");

/**
 * Save all active sessions to storage
 */
async function persistSessions() {
  if (!serverState.storage || serverState.isShuttingDown) return;

  // Convert iterator to array for multiple iterations and counting
  const allSessions = Array.from(serverState.getAllSessions());
  const totalSessions = allSessions.length;

  if (totalSessions === 0) {
    return; // Nothing to persist
  }

  logger.debug({ totalSessions }, "Starting persistence cycle");

  const endTimer = metrics.startStorageSaveTimer();
  let savedCount = 0;
  let errorCount = 0;

  try {
    if (serverState.isAsyncStorageMode) {
      // Redis: save individually
      for (const [gameId, session] of allSessions) {
        try {
          const state = session.toJSON();
          logger.debug({
            gameId,
            status: state.status,
            isClosed: state.isClosed,
            playerCount: state.players?.length,
          }, "Persisting session");
          await serverState.storage.save(gameId, state);
          metrics.recordStorageOperation("save", "success");
          savedCount++;
        } catch (error) {
          logger.error({ gameId, error: error.message }, "Failed to persist session");
          metrics.recordStorageOperation("save", "error");
          errorCount++;
        }
      }
    } else if (serverState.storage.saveBatch) {
      // SQLite/Memory: use batch save
      const sessions = allSessions.map(([id, session]) => {
        const state = session.toJSON();
        logger.debug({
          gameId: id,
          status: state.status,
          isClosed: state.isClosed,
          playerCount: state.players?.length,
        }, "Preparing session for batch save");
        return { id, state };
      });

      if (sessions.length > 0) {
        const count = serverState.storage.saveBatch(sessions);
        if (count === sessions.length) {
          savedCount = count;
          metrics.recordStorageOperation("save_batch", "success");
        } else {
          // Partial save - fall back to individual saves
          logger.warn(
            { expected: sessions.length, actual: count },
            "Batch save incomplete, retrying individually"
          );
          for (const { id, state } of sessions) {
            try {
              serverState.storage.save(id, state);
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
      for (const [gameId, session] of allSessions) {
        try {
          const state = session.toJSON();
          logger.debug({
            gameId,
            status: state.status,
            isClosed: state.isClosed,
            playerCount: state.players?.length,
          }, "Persisting session");
          serverState.storage.save(gameId, state);
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
    errorCount = serverState.getSessionCount();
  }

  endTimer();
  if (savedCount > 0 || errorCount > 0) {
    logger.debug({ savedCount, errorCount }, "Persistence cycle completed");
  }
}

/**
 * Immediately persist a single game session
 * @param {string} gameId - Game ID to persist
 */
async function persistGameImmediately(gameId) {
  if (!serverState.storage || serverState.isShuttingDown) return;

  const session = serverState.getSession(gameId);
  if (!session) return;

  try {
    if (serverState.isAsyncStorageMode) {
      await serverState.storage.save(gameId, session.toJSON());
    } else {
      serverState.storage.save(gameId, session.toJSON());
    }
    metrics.recordStorageOperation("save_immediate", "success");
    logger.debug({ gameId }, "Game persisted immediately");
  } catch (error) {
    logger.error({ gameId, error: error.message }, "Immediate persistence failed");
    metrics.recordStorageOperation("save_immediate", "error");
  }
}

/**
 * Sync game state to Redis (for Redis-primary mode)
 * @param {string} gameId - Game ID
 */
async function syncGameToRedis(gameId) {
  if (!serverState.isRedisPrimaryMode || !serverState.storage || serverState.isShuttingDown) {
    return;
  }

  const session = serverState.getSession(gameId);
  if (!session) return;

  try {
    await serverState.storage.save(gameId, session.toJSON());
    logger.debug({ gameId }, "Game synced to Redis");
  } catch (error) {
    logger.error({ gameId, error: error.message }, "Failed to sync game to Redis");
  }
}

/**
 * Load game from storage if not in local cache
 * Works with all storage backends (Redis, SQLite, memory)
 * @param {string} gameId - Game ID
 * @returns {GameSession|null}
 */
async function ensureGameLoaded(gameId) {
  // Check local cache first
  if (serverState.hasSession(gameId)) {
    logger.debug({ gameId }, "Game found in local cache");
    return serverState.getSession(gameId);
  }

  // No storage configured, can only use in-memory sessions
  if (!serverState.storage) {
    logger.debug({ gameId }, "No storage configured, game not in local cache");
    return null;
  }

  // Try to load from storage
  try {
    let state;
    if (serverState.isAsyncStorageMode) {
      state = await serverState.storage.load(gameId);
    } else {
      state = serverState.storage.load(gameId);
    }

    if (state) {
      const session = restoreGameSession(state, (type, data) => {
        broadcastToGame(gameId, type, data).catch(error => {
          logger.error({ error: error.message, gameId }, "Broadcast failed");
        });
      });
      serverState.setSession(gameId, session);

      // Subscribe to Redis channel if using Redis-primary mode
      if (serverState.isRedisPrimaryMode) {
        subscribeToGameChannel(gameId).catch(error => {
          logger.error({ error: error.message, gameId }, "Failed to subscribe to game channel");
        });
      }

      logger.debug({ gameId }, "Game loaded from storage into cache");
      return session;
    } else {
      logger.debug({ gameId }, "Game not found in storage");
    }
  } catch (error) {
    logger.error({ gameId, error: error.message }, "Failed to load game from storage");
  }

  return null;
}

/**
 * Load all active (non-closed) sessions from storage on startup
 */
async function loadSessions() {
  if (!serverState.storage) {
    logger.warn("No storage configured - cannot load sessions");
    return;
  }

  try {
    let savedSessions;
    let totalInStorage = 0;
    let skippedClosed = 0;

    // Use loadActiveSessions if available, otherwise filter after loading all
    if (serverState.isAsyncStorageMode) {
      if (serverState.storage.loadActiveSessions) {
        savedSessions = await serverState.storage.loadActiveSessions();
        totalInStorage = savedSessions.length; // We don't know total, only active
      } else {
        const allSessions = await serverState.storage.loadAll();
        totalInStorage = allSessions.length;
        savedSessions = allSessions.filter(s => {
          const isActive = s.state && !s.state.isClosed;
          if (!isActive) {
            skippedClosed++;
            logger.debug({
              gameId: s.id,
              isClosed: s.state?.isClosed,
              hasState: !!s.state,
            }, "Skipping closed/invalid session");
          }
          return isActive;
        });
      }
    } else {
      if (serverState.storage.loadActiveSessions) {
        savedSessions = serverState.storage.loadActiveSessions();
        totalInStorage = savedSessions.length;
      } else {
        const allSessions = serverState.storage.loadAll();
        totalInStorage = allSessions.length;
        savedSessions = allSessions.filter(s => {
          const isActive = s.state && !s.state.isClosed;
          if (!isActive) {
            skippedClosed++;
            logger.debug({
              gameId: s.id,
              isClosed: s.state?.isClosed,
              hasState: !!s.state,
            }, "Skipping closed/invalid session");
          }
          return isActive;
        });
      }
    }

    logger.info({
      totalInStorage,
      activeCount: savedSessions.length,
      skippedClosed,
    }, "Found sessions in storage");

    for (const { id, state } of savedSessions) {
      try {
        logger.debug({
          gameId: id,
          status: state.status,
          playerCount: state.players?.length,
          lastActivity: state.lastActivity,
        }, "Restoring session");

        const session = restoreGameSession(state, (type, data) => {
          broadcastToGame(id, type, data).catch(error => {
            logger.error({ error: error.message, gameId: id }, "Broadcast failed");
          });
        });
        serverState.setSession(id, session);

        // Subscribe to Redis channel if using Redis
        if (serverState.isAsyncStorageMode && serverState.storage.subscribeToGame) {
          await subscribeToGameChannel(id);
        }

        metrics.recordRestoredSession();
        metrics.recordStorageOperation("load", "success");
        logger.info({ gameId: id, status: session.status }, "Session restored successfully");
      } catch (error) {
        logger.error(
          { gameId: id, error: error.message, stack: error.stack },
          "Failed to restore session"
        );
        metrics.recordStorageOperation("load", "error");
        // Don't auto-delete sessions on load failure - they might be recoverable
        // This prevents losing active games due to transient errors
        logger.warn({ gameId: id }, "Session kept in storage despite load failure");
      }
    }
  } catch (error) {
    logger.error({ error: error.message, stack: error.stack }, "Failed to load sessions");
    metrics.recordError("session_load_failed");
  }
}

/**
 * Get a session for a message handler, loading from storage if needed.
 * @param {string} gameId - Game ID
 * @returns {Promise<object|null>} The session, or null if not found
 */
async function getSessionForHandler(gameId) {
  return serverState.isRedisPrimaryMode
    ? await ensureGameLoaded(gameId)
    : serverState.getSession(gameId);
}

module.exports = {
  persistSessions,
  persistGameImmediately,
  syncGameToRedis,
  ensureGameLoaded,
  getSessionForHandler,
  loadSessions,
};
