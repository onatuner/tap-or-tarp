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

  const endTimer = metrics.startStorageSaveTimer();
  let savedCount = 0;
  let errorCount = 0;

  try {
    if (serverState.isAsyncStorageMode) {
      // Redis: save individually
      for (const [gameId, session] of serverState.getAllSessions()) {
        try {
          await serverState.storage.save(gameId, session.toJSON());
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
      const sessions = Array.from(serverState.getAllSessions()).map(([id, session]) => ({
        id,
        state: session.toJSON(),
      }));

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
      for (const [gameId, session] of serverState.getAllSessions()) {
        try {
          serverState.storage.save(gameId, session.toJSON());
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
 * Load game from Redis if not in local cache
 * @param {string} gameId - Game ID
 * @returns {GameSession|null}
 */
async function ensureGameLoaded(gameId) {
  if (!serverState.isRedisPrimaryMode || !serverState.storage) {
    return serverState.getSession(gameId);
  }

  // Check local cache first
  if (serverState.hasSession(gameId)) {
    return serverState.getSession(gameId);
  }

  // Try to load from Redis
  try {
    const state = await serverState.storage.load(gameId);
    if (state) {
      const session = restoreGameSession(state, (type, data) => {
        broadcastToGame(gameId, type, data).catch(error => {
          logger.error({ error: error.message, gameId }, "Broadcast failed");
        });
      });
      serverState.setSession(gameId, session);
      logger.debug({ gameId }, "Game loaded from Redis into cache");
      return session;
    }
  } catch (error) {
    logger.error({ gameId, error: error.message }, "Failed to load game from Redis");
  }

  return null;
}

/**
 * Load all sessions from storage on startup
 */
async function loadSessions() {
  if (!serverState.storage) return;

  try {
    let savedSessions;
    if (serverState.isAsyncStorageMode) {
      savedSessions = await serverState.storage.loadAll();
    } else {
      savedSessions = serverState.storage.loadAll();
    }
    logger.info({ count: savedSessions.length }, "Found persisted sessions");

    for (const { id, state } of savedSessions) {
      try {
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
        logger.info({ gameId: id, status: session.status }, "Restored session");
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
    logger.error({ error: error.message }, "Failed to load sessions");
    metrics.recordError("session_load_failed");
  }
}

module.exports = {
  persistSessions,
  persistGameImmediately,
  syncGameToRedis,
  ensureGameLoaded,
  loadSessions,
};
