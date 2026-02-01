/**
 * Game Control Handlers
 *
 * Handles game control actions: start, pause, reset, switch.
 */

const { logger } = require("../../logger");
const metrics = require("../../metrics");
const { withGameLock } = require("../../lock");
const { CONSTANTS } = require("../../shared/constants");
const { sanitizeString } = require("../../shared/validators");
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
      session.lastActivity = Date.now();

      // Mark session as closed (will not be loaded on server restart)
      session.close();

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

      // Persist the closed state immediately
      if (serverState.storage) {
        if (serverState.isAsyncStorageMode) {
          await serverState.storage.save(ws.gameId, session.toJSON());
        } else {
          serverState.storage.save(ws.gameId, session.toJSON());
        }
      }

      // Remove from in-memory sessions (but keep in storage for audit)
      serverState.deleteSession(ws.gameId);

      logger.info({ gameId: ws.gameId, clientId: ws.clientId }, "Game lobby closed");
    });
  } catch (error) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: error.message } }));
    metrics.recordError("endGame_lock_error");
  }
}

async function handleInterrupt(ws, data) {
  const session = serverState.isRedisPrimaryMode
    ? await ensureGameLoaded(ws.gameId)
    : serverState.getSession(ws.gameId);

  if (!session) return;

  try {
    await withGameLock(ws.gameId, async () => {
      const myPlayer = session.players.find(p => p.claimedBy === ws.clientId);
      if (!myPlayer) {
        safeSend(
          ws,
          JSON.stringify({
            type: "error",
            data: { message: "You must claim a player to interrupt" },
          })
        );
        return;
      }

      if (session.status !== "running") {
        safeSend(
          ws,
          JSON.stringify({
            type: "error",
            data: { message: "Game is not running" },
          })
        );
        return;
      }

      session.interrupt(myPlayer.id);

      if (serverState.isRedisPrimaryMode) {
        await syncGameToRedis(ws.gameId);
      }

      logger.info({ gameId: ws.gameId, playerId: myPlayer.id }, "Player interrupted");
    });
  } catch (error) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: error.message } }));
    metrics.recordError("interrupt_lock_error");
  }
}

async function handlePassPriority(ws, data) {
  const session = serverState.isRedisPrimaryMode
    ? await ensureGameLoaded(ws.gameId)
    : serverState.getSession(ws.gameId);

  if (!session) return;

  try {
    await withGameLock(ws.gameId, async () => {
      const myPlayer = session.players.find(p => p.claimedBy === ws.clientId);
      if (!myPlayer) {
        safeSend(
          ws,
          JSON.stringify({
            type: "error",
            data: { message: "You must claim a player to pass priority" },
          })
        );
        return;
      }

      if (!session.interruptingPlayers.includes(myPlayer.id)) {
        safeSend(
          ws,
          JSON.stringify({
            type: "error",
            data: { message: "You are not in the interrupt queue" },
          })
        );
        return;
      }

      session.passPriority(myPlayer.id);

      if (serverState.isRedisPrimaryMode) {
        await syncGameToRedis(ws.gameId);
      }

      logger.info({ gameId: ws.gameId, playerId: myPlayer.id }, "Player passed priority");
    });
  } catch (error) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: error.message } }));
    metrics.recordError("passPriority_lock_error");
  }
}

/**
 * Handle rename game message
 * @param {WebSocket} ws - WebSocket client
 * @param {object} data - Message data
 */
async function handleRenameGame(ws, data) {
  const session = serverState.isRedisPrimaryMode
    ? await ensureGameLoaded(ws.gameId)
    : serverState.getSession(ws.gameId);

  if (!session) return;

  try {
    await withGameLock(ws.gameId, async () => {
      session.lastActivity = Date.now();

      // Validate, sanitize, and truncate game name
      let newName = data.name?.trim() || "Game";
      newName = sanitizeString(newName);
      if (newName.length > CONSTANTS.MAX_GAME_NAME_LENGTH) {
        newName = newName.substring(0, CONSTANTS.MAX_GAME_NAME_LENGTH);
      }
      session.name = newName;

      // Broadcast name change to all clients
      session.broadcastState();

      // Sync to Redis if using Redis
      if (serverState.isRedisPrimaryMode) {
        await syncGameToRedis(ws.gameId);
      }

      // Send confirmation to the requester
      safeSend(
        ws,
        JSON.stringify({
          type: "gameRenamed",
          data: { name: newName },
        })
      );

      logger.info({ gameId: ws.gameId, clientId: ws.clientId, newName }, "Game renamed");
    });
  } catch (error) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: error.message } }));
    metrics.recordError("renameGame_lock_error");
  }
}

module.exports = {
  start: handleStart,
  pause: handlePause,
  reset: handleReset,
  switch: handleSwitch,
  endGame: handleEndGame,
  renameGame: handleRenameGame,
  interrupt: handleInterrupt,
  passPriority: handlePassPriority,
};
