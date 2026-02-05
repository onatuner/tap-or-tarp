/**
 * Join Game Handler
 *
 * Handles game joining requests.
 */

const { logger } = require("../../logger");
const metrics = require("../../metrics");
const { withGameLock } = require("../../lock");
const { serverState } = require("../state");
const { safeSend, subscribeToGameChannel } = require("../websocket");
const { ensureGameLoaded } = require("../persistence");

/**
 * Handle join game message
 * @param {WebSocket} ws - WebSocket client
 * @param {object} data - Message data
 */
async function handleJoin(ws, data) {
  if (!data.gameId) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: "Game ID is required" } }));
    return;
  }

  // Load from storage if not already in memory (works with all storage backends)
  const session = await ensureGameLoaded(data.gameId);

  if (!session) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: "Game not found" } }));
    metrics.recordError("game_not_found");
    logger.warn(
      {
        gameId: data.gameId,
        clientId: ws.clientId,
        instanceId: serverState.instanceId,
        hasStorage: !!serverState.storage,
        isAsyncMode: serverState.isAsyncStorageMode,
        isRedisPrimary: serverState.isRedisPrimaryMode,
        cachedGameIds: Array.from(serverState.getSessionIds()),
        cacheSize: serverState.getSessionCount(),
      },
      "Join attempt for non-existent game"
    );
    return;
  }

  try {
    await withGameLock(data.gameId, async () => {
      ws.gameId = data.gameId;
      session.lastActivity = Date.now();

      // Set owner if not already set (for restored sessions)
      if (!session.ownerId) {
        session.setOwner(ws.clientId);
      }

      // Subscribe to game channel for cross-instance messaging
      if (serverState.isRedisPrimaryMode) {
        subscribeToGameChannel(data.gameId).catch(error => {
          logger.error(
            { error: error.message, gameId: data.gameId },
            "Failed to subscribe to game channel"
          );
        });
      }
    });

    // Track viewer for this game
    const viewerCount = serverState.addViewer(data.gameId, ws.clientId);

    safeSend(ws, JSON.stringify({ type: "state", data: session.getState() }));
    metrics.recordMessageSent("state");

    // Broadcast to ALL clients so they know about the new viewer
    // This ensures state consistency across all connected clients
    session.broadcastState();

    logger.info({ gameId: data.gameId, clientId: ws.clientId, viewerCount }, "Client joined game");
  } catch (error) {
    logger.error({ error: error.message, gameId: data.gameId }, "Join error");
    safeSend(ws, JSON.stringify({ type: "error", data: { message: error.message } }));
    metrics.recordError("join_lock_error");
  }
}

module.exports = handleJoin;
