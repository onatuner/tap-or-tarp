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
 * Cleanup inactive sessions
 */
async function cleanupSessions() {
  let cleanedCount = 0;

  for (const [gameId, session] of serverState.getAllSessions()) {
    if (shouldCleanupSession(gameId, session)) {
      // Cleanup the session
      session.cleanup();
      serverState.gameSessions.delete(gameId);

      // Remove from storage
      if (serverState.storage) {
        try {
          if (serverState.isAsyncStorageMode) {
            await serverState.storage.delete(gameId);
            if (serverState.storage.unsubscribe) {
              await serverState.storage.unsubscribe(`broadcast:${gameId}`);
            }
          } else {
            serverState.storage.delete(gameId);
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
    logger.info(
      { cleanedCount, remaining: serverState.getSessionCount() },
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
