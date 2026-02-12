/**
 * Claim Handlers
 *
 * Handles player claiming, reconnection, and unclaiming.
 */

const { logger } = require("../../logger");
const metrics = require("../../metrics");
const { withGameLock } = require("../../lock");
const { CONSTANTS } = require("../../shared/constants");
const { serverState } = require("../state");
const { safeSend } = require("../websocket");
const { ensureGameLoaded, syncGameToRedis, getSessionForHandler } = require("../persistence");

/**
 * Handle claim player message
 * @param {WebSocket} ws - WebSocket client
 * @param {object} data - Message data
 */
async function handleClaim(ws, data) {
  const session = await getSessionForHandler(ws.gameId);

  if (!session) return;

  // Validate player ID
  if (data.playerId === undefined || data.playerId < 1 || data.playerId > CONSTANTS.MAX_PLAYERS) {
    return;
  }

  try {
    await withGameLock(ws.gameId, async () => {
      session.lastActivity = Date.now();
      const result = session.claimPlayer(data.playerId, ws.clientId);

      if (!result.success) {
        safeSend(
          ws,
          JSON.stringify({
            type: "error",
            data: { message: result.reason || "Cannot claim this player" },
          })
        );
        metrics.recordError("claim_failed");
      } else {
        if (serverState.isRedisPrimaryMode) {
          await syncGameToRedis(ws.gameId);
        }

        // Send the reconnection token to the client (private message)
        safeSend(
          ws,
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
    safeSend(ws, JSON.stringify({ type: "error", data: { message: error.message } }));
    metrics.recordError("claim_lock_error");
  }
}

/**
 * Handle reconnect message
 * @param {WebSocket} ws - WebSocket client
 * @param {object} data - Message data
 */
async function handleReconnect(ws, data) {
  // Load from storage if not already in memory (works with all storage backends)
  const session = await ensureGameLoaded(data.gameId);

  if (!session) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: "Game not found" } }));
    metrics.recordError("reconnect_game_not_found");
    return;
  }

  // Validate player ID
  if (data.playerId === undefined || data.playerId < 1 || data.playerId > CONSTANTS.MAX_PLAYERS) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: "Invalid player ID" } }));
    metrics.recordError("reconnect_invalid_player");
    return;
  }

  // Validate token
  if (!data.token || typeof data.token !== "string") {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: "Invalid token" } }));
    metrics.recordError("reconnect_invalid_token");
    return;
  }

  try {
    await withGameLock(data.gameId, async () => {
      const result = session.reconnectPlayer(data.playerId, data.token, ws.clientId);

      if (!result.success) {
        safeSend(
          ws,
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
        if (serverState.isRedisPrimaryMode) {
          await syncGameToRedis(data.gameId);
        }

        ws.gameId = data.gameId;

        // Send new token and current state
        safeSend(
          ws,
          JSON.stringify({
            type: "reconnected",
            data: {
              playerId: data.playerId,
              token: result.token,
              gameId: data.gameId,
            },
          })
        );

        safeSend(ws, JSON.stringify({ type: "state", data: session.getState() }));

        metrics.recordMessageSent("reconnected");
        metrics.recordMessageSent("state");
        logger.info(
          { gameId: data.gameId, playerId: data.playerId, clientId: ws.clientId },
          "Player reconnected successfully"
        );
      }
    });
  } catch (error) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: error.message } }));
    metrics.recordError("reconnect_lock_error");
  }
}

/**
 * Handle unclaim message
 * @param {WebSocket} ws - WebSocket client
 * @param {object} data - Message data
 */
async function handleUnclaim(ws, data) {
  const session = await getSessionForHandler(ws.gameId);

  if (!session) return;

  try {
    await withGameLock(ws.gameId, async () => {
      session.lastActivity = Date.now();
      session.unclaimPlayer(ws.clientId);

      if (serverState.isRedisPrimaryMode) {
        await syncGameToRedis(ws.gameId);
      }
    });
  } catch (error) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: error.message } }));
    metrics.recordError("unclaim_lock_error");
  }
}

module.exports = {
  claim: handleClaim,
  reconnect: handleReconnect,
  unclaim: handleUnclaim,
};
