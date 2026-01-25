/**
 * Game Control Handlers
 *
 * Handles game control actions: start, pause, reset, switch.
 */

const { logger } = require("../../logger");
const metrics = require("../../metrics");
const { withGameLock } = require("../../lock");
const { CONSTANTS } = require("../../shared/constants");
const { serverState } = require("../state");
const { safeSend } = require("../websocket");
const { ensureGameLoaded, syncGameToRedis } = require("../persistence");

/**
 * Handle start game message
 * @param {WebSocket} ws - WebSocket client
 * @param {object} data - Message data
 */
async function handleStart(ws, data) {
  const session = serverState.isRedisPrimaryMode
    ? await ensureGameLoaded(ws.gameId)
    : serverState.getSession(ws.gameId);

  if (!session) return;

  try {
    await withGameLock(ws.gameId, async () => {
      if (!session.canControlGame(ws.clientId)) {
        safeSend(
          ws,
          JSON.stringify({
            type: "error",
            data: { message: "Not authorized to start game" },
          })
        );
        metrics.recordAuthDenied("start");
        logger.warn({ gameId: ws.gameId, clientId: ws.clientId }, "Unauthorized start attempt");
        return;
      }

      session.lastActivity = Date.now();
      session.start();

      if (serverState.isRedisPrimaryMode) {
        await syncGameToRedis(ws.gameId);
      }

      logger.info({ gameId: ws.gameId }, "Game started");
    });
  } catch (error) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: error.message } }));
    metrics.recordError("start_lock_error");
  }
}

/**
 * Handle pause/resume game message
 * @param {WebSocket} ws - WebSocket client
 * @param {object} data - Message data
 */
async function handlePause(ws, data) {
  const session = serverState.isRedisPrimaryMode
    ? await ensureGameLoaded(ws.gameId)
    : serverState.getSession(ws.gameId);

  if (!session) return;

  try {
    await withGameLock(ws.gameId, async () => {
      if (!session.canControlGame(ws.clientId)) {
        safeSend(
          ws,
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
        if (serverState.isRedisPrimaryMode) {
          await syncGameToRedis(ws.gameId);
        }
        logger.debug({ gameId: ws.gameId }, "Game paused");
      } else if (session.status === "paused") {
        session.resume();
        if (serverState.isRedisPrimaryMode) {
          await syncGameToRedis(ws.gameId);
        }
        logger.debug({ gameId: ws.gameId }, "Game resumed");
      }
    });
  } catch (error) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: error.message } }));
    metrics.recordError("pause_lock_error");
  }
}

/**
 * Handle reset game message
 * @param {WebSocket} ws - WebSocket client
 * @param {object} data - Message data
 */
async function handleReset(ws, data) {
  const session = serverState.isRedisPrimaryMode
    ? await ensureGameLoaded(ws.gameId)
    : serverState.getSession(ws.gameId);

  if (!session) return;

  try {
    await withGameLock(ws.gameId, async () => {
      session.lastActivity = Date.now();
      session.reset();

      if (serverState.isRedisPrimaryMode) {
        await syncGameToRedis(ws.gameId);
      }

      logger.info({ gameId: ws.gameId }, "Game reset");
    });
  } catch (error) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: error.message } }));
    metrics.recordError("reset_lock_error");
  }
}

/**
 * Handle switch player message
 * @param {WebSocket} ws - WebSocket client
 * @param {object} data - Message data
 */
async function handleSwitch(ws, data) {
  const session = serverState.isRedisPrimaryMode
    ? await ensureGameLoaded(ws.gameId)
    : serverState.getSession(ws.gameId);

  if (!session) return;

  // Validate player ID
  if (data.playerId === undefined || data.playerId < 1 || data.playerId > CONSTANTS.MAX_PLAYERS) {
    return;
  }

  try {
    await withGameLock(ws.gameId, async () => {
      if (!session.canSwitchPlayer(data.playerId, ws.clientId)) {
        safeSend(
          ws,
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
      // Note: Not syncing switch to Redis immediately for performance
      // Timer ticks are frequent - sync happens via periodic persistence
    });
  } catch (error) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: error.message } }));
    metrics.recordError("switch_lock_error");
  }
}

/**
 * Handle end game message (close lobby)
 * @param {WebSocket} ws - WebSocket client
 * @param {object} data - Message data
 */
async function handleEndGame(ws, data) {
  const session = serverState.isRedisPrimaryMode
    ? await ensureGameLoaded(ws.gameId)
    : serverState.getSession(ws.gameId);

  if (!session) return;

  try {
    await withGameLock(ws.gameId, async () => {
      if (!session.isOwner(ws.clientId)) {
        safeSend(
          ws,
          JSON.stringify({
            type: "error",
            data: { message: "Not authorized to end game" },
          })
        );
        metrics.recordAuthDenied("endGame");
        logger.warn({ gameId: ws.gameId, clientId: ws.clientId }, "Unauthorized end game attempt");
        return;
      }

      session.lastActivity = Date.now();

      // Broadcast to all connected clients in this game
      if (serverState.wss) {
        serverState.wss.clients.forEach(client => {
          if (client.gameId === ws.gameId) {
            safeSend(
              client,
              JSON.stringify({
                type: "gameEnded",
                data: { gameId: ws.gameId },
              })
            );
          }
        });
      }

      // Remove game session
      serverState.deleteSession(ws.gameId);

      // Remove from Redis if using Redis
      if (serverState.isRedisPrimaryMode && serverState.storage) {
        await serverState.storage.delete(ws.gameId);
      }

      logger.info({ gameId: ws.gameId, clientId: ws.clientId }, "Game lobby closed");
    });
  } catch (error) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: error.message } }));
    metrics.recordError("endGame_lock_error");
  }
}

module.exports = {
  start: handleStart,
  pause: handlePause,
  reset: handleReset,
  switch: handleSwitch,
  endGame: handleEndGame,
};
