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
  // Load from Redis if using Redis-primary mode
  const session = serverState.isRedisPrimaryMode
    ? await ensureGameLoaded(data.gameId)
    : serverState.getSession(data.gameId);

  if (!session) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: "Game not found" } }));
    metrics.recordError("game_not_found");
    logger.debug(
      { gameId: data.gameId, clientId: ws.clientId },
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

    safeSend(ws, JSON.stringify({ type: "state", data: session.getState() }));
    metrics.recordMessageSent("state");
    logger.info({ gameId: data.gameId, clientId: ws.clientId }, "Client joined game");
  } catch (error) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: error.message } }));
    metrics.recordError("join_lock_error");
  }
}

module.exports = handleJoin;
