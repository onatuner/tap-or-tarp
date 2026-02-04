/**
 * Session Cleanup
 *
 * Handles cleanup of inactive and abandoned game sessions.
 */

const WebSocket = require("ws");
const { logger } = require("../logger");
const metrics = require("../metrics");
const { CONSTANTS } = require("../shared/constants");
const { withGameLock } = require("../lock");
const { serverState } = require("./state");
const { ensureGameLoaded } = require("./persistence");

/**
 * Check if a session should be cleaned up
 * @param {string} gameId - Game ID
 * @param {GameSession} session - Session to check
 * @returns {boolean}
 */
function shouldCleanupSession(gameId, session) {
  const now = Date.now();

  // Count connected clients for this game
  const clientsConnected = serverState.wss
    ? Array.from(serverState.wss.clients).filter(
        client => client.gameId === gameId && client.readyState === WebSocket.OPEN
      ).length
    : 0;

  // Delete if:
  // 1. No clients and inactive for EMPTY_SESSION_THRESHOLD
  // 2. Inactive for INACTIVE_SESSION_THRESHOLD regardless of clients
  return (
    (clientsConnected === 0 && now - session.lastActivity > CONSTANTS.EMPTY_SESSION_THRESHOLD) ||
    now - session.lastActivity > CONSTANTS.INACTIVE_SESSION_THRESHOLD
  );
}

/**
 * Cleanup inactive sessions and old closed sessions
 *
 * Strategy:
 * 1. Mark inactive sessions as closed (isClosed = true)
 * 2. Remove closed sessions from memory to free resources
 * 3. Keep closed sessions in storage for a grace period (they won't load on restart)
 * 4. Delete closed sessions from storage after 24 hours
 */
async function cleanupSessions() {
  let closedCount = 0;
  let removedFromMemoryCount = 0;

  for (const [gameId, session] of serverState.getAllSessions()) {
    if (shouldCleanupSession(gameId, session)) {
      // First, mark the session as closed if not already
      if (!session.isClosed) {
        session.isClosed = true;
        session.lastActivity = Date.now(); // Update timestamp for cleanup threshold

        // Persist the closed state to storage (so it survives restart but won't load)
        if (serverState.storage) {
          try {
            if (serverState.isAsyncStorageMode) {
              await serverState.storage.save(gameId, session.toJSON());
            } else {
              serverState.storage.save(gameId, session.toJSON());
            }
            logger.info({ gameId, status: session.status }, "Session marked as closed");
            closedCount++;
          } catch (error) {
            logger.error({ gameId, error: error.message }, "Failed to save closed session");
          }
        }
      }

      // Cleanup resources and remove from memory
      session.cleanup();
      serverState.gameSessions.delete(gameId);

      // Unsubscribe from Redis channel if applicable
      if (serverState.isAsyncStorageMode && serverState.storage && serverState.storage.unsubscribe) {
        try {
          await serverState.storage.unsubscribe(`broadcast:${gameId}`);
        } catch (error) {
          logger.debug({ gameId, error: error.message }, "Failed to unsubscribe from channel");
        }
      }

      logger.debug({ gameId }, "Session removed from memory");
      removedFromMemoryCount++;
    }
  }

  // Delete old closed sessions from storage (sessions that have been closed for 24+ hours)
  if (serverState.storage && serverState.storage.deleteClosedSessions) {
    try {
      let deletedClosed;
      if (serverState.isAsyncStorageMode) {
        deletedClosed = await serverState.storage.deleteClosedSessions();
      } else {
        deletedClosed = serverState.storage.deleteClosedSessions();
      }
      if (deletedClosed > 0) {
        logger.info({ deletedClosed }, "Deleted old closed sessions from storage");
      }
    } catch (error) {
      logger.error({ error: error.message }, "Failed to cleanup closed sessions from storage");
    }
  }

  if (closedCount > 0 || removedFromMemoryCount > 0) {
    logger.info(
      { closedCount, removedFromMemoryCount, remaining: serverState.getSessionCount() },
      "Cleanup cycle completed"
    );
  }
}

/**
 * Handle client disconnection from a game
 * @param {WebSocket} ws - WebSocket client
 */
async function handleClientDisconnect(ws) {
  logger.debug({ clientId: ws.clientId, gameId: ws.gameId }, "WebSocket connection closed");

  if (!ws.gameId) return;

  // Remove from viewer tracking
  const viewerCount = serverState.removeViewer(ws.gameId, ws.clientId);
  logger.debug({ gameId: ws.gameId, clientId: ws.clientId, viewerCount }, "Viewer left");

  try {
    await withGameLock(ws.gameId, async () => {
      // Try local cache first, then Redis if needed
      let session = serverState.getSession(ws.gameId);
      if (!session && serverState.isRedisPrimaryMode) {
        session = await ensureGameLoaded(ws.gameId);
      }
      if (!session) return;

      // Unclaim any players claimed by this client
      session.handleClientDisconnect(ws.clientId);

      // Check if game should auto-pause
      const clientsConnected = serverState.wss
        ? Array.from(serverState.wss.clients).filter(
            client => client.gameId === ws.gameId && client.readyState === WebSocket.OPEN
          ).length
        : 0;

      if (clientsConnected === 0 && session.status === "running") {
        session.pause();
        logger.info({ gameId: ws.gameId }, "Game auto-paused - no clients connected");
      }
    });
  } catch (error) {
    logger.error({ error: error.message, gameId: ws.gameId }, "Error handling disconnect");
  }
}

module.exports = {
  cleanupSessions,
  handleClientDisconnect,
  shouldCleanupSession,
};
