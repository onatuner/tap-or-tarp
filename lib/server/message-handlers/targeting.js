/**
 * Targeting System Handlers
 *
 * Handles targeting actions: toggle target, confirm targets, pass priority, cancel.
 */

const { logger } = require("../../logger");
const metrics = require("../../metrics");
const { withGameLock } = require("../../lock");
const { TARGETING } = require("../../shared/constants");
const { serverState } = require("../state");
const { safeSend } = require("../websocket");
const { ensureGameLoaded, syncGameToRedis } = require("../persistence");

/**
 * Broadcast targeting state update to all clients in the game
 * @param {object} session - Game session
 */
function broadcastTargetingState(session) {
  if (serverState.wss) {
    serverState.wss.clients.forEach(client => {
      if (client.gameId === session.id) {
        safeSend(
          client,
          JSON.stringify({
            type: "targetingUpdated",
            data: {
              targetingState: session.targetingState,
              targetedPlayers: session.targetedPlayers,
              awaitingPriority: session.awaitingPriority,
              originalActivePlayer: session.originalActivePlayer,
              activePlayer: session.activePlayer,
            },
          })
        );
      }
    });
  }
}

/**
 * Handle toggle target message
 * @param {WebSocket} ws - WebSocket client
 * @param {object} data - Message data containing playerId
 */
async function handleToggleTarget(ws, data) {
  const session = serverState.isRedisPrimaryMode
    ? await ensureGameLoaded(ws.gameId)
    : serverState.getSession(ws.gameId);

  if (!session) return;

  const { playerId } = data;

  try {
    await withGameLock(ws.gameId, async () => {
      // Find the sender's player
      const senderPlayer = session.players.find(p => p.claimedBy === ws.clientId);
      if (!senderPlayer) {
        safeSend(
          ws,
          JSON.stringify({
            type: "error",
            data: { message: "You must claim a player to select targets" },
          })
        );
        return;
      }

      // Only the active player can select targets
      if (senderPlayer.id !== session.activePlayer) {
        safeSend(
          ws,
          JSON.stringify({
            type: "error",
            data: { message: "Only the active player can select targets" },
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

      // Start target selection if not already in selecting mode
      if (session.targetingState === TARGETING.STATES.NONE) {
        session.startTargetSelection();
      }

      if (session.targetingState !== TARGETING.STATES.SELECTING) {
        safeSend(
          ws,
          JSON.stringify({
            type: "error",
            data: { message: "Cannot change targets now" },
          })
        );
        return;
      }

      if (!session.toggleTarget(playerId)) {
        safeSend(
          ws,
          JSON.stringify({
            type: "error",
            data: { message: "Invalid target" },
          })
        );
        return;
      }

      session.lastActivity = Date.now();
      broadcastTargetingState(session);
      session.broadcastState();

      if (serverState.isRedisPrimaryMode) {
        await syncGameToRedis(ws.gameId);
      }

      logger.debug(
        { gameId: ws.gameId, targetPlayerId: playerId, targets: session.targetedPlayers },
        "Target toggled"
      );
    });
  } catch (error) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: error.message } }));
    metrics.recordError("toggleTarget_lock_error");
  }
}

/**
 * Handle confirm targets message
 * @param {WebSocket} ws - WebSocket client
 * @param {object} data - Message data
 */
async function handleConfirmTargets(ws, data) {
  const session = serverState.isRedisPrimaryMode
    ? await ensureGameLoaded(ws.gameId)
    : serverState.getSession(ws.gameId);

  if (!session) return;

  try {
    await withGameLock(ws.gameId, async () => {
      // Find the sender's player
      const senderPlayer = session.players.find(p => p.claimedBy === ws.clientId);
      if (!senderPlayer || senderPlayer.id !== session.activePlayer) {
        safeSend(
          ws,
          JSON.stringify({
            type: "error",
            data: { message: "Only the active player can confirm targets" },
          })
        );
        return;
      }

      if (session.targetingState !== TARGETING.STATES.SELECTING) {
        safeSend(
          ws,
          JSON.stringify({
            type: "error",
            data: { message: "Not in target selection mode" },
          })
        );
        return;
      }

      if (session.targetedPlayers.length === 0) {
        safeSend(
          ws,
          JSON.stringify({
            type: "error",
            data: { message: "No targets selected" },
          })
        );
        return;
      }

      if (!session.confirmTargets()) {
        safeSend(
          ws,
          JSON.stringify({
            type: "error",
            data: { message: "Failed to confirm targets" },
          })
        );
        return;
      }

      session.lastActivity = Date.now();

      // Broadcast targeting started event
      if (serverState.wss) {
        serverState.wss.clients.forEach(client => {
          if (client.gameId === ws.gameId) {
            safeSend(
              client,
              JSON.stringify({
                type: "targetingStarted",
                data: {
                  originalPlayer: session.originalActivePlayer,
                  targets: session.targetedPlayers,
                  awaitingPriority: session.awaitingPriority,
                  activePlayer: session.activePlayer,
                },
              })
            );
          }
        });
      }

      session.broadcastState();

      if (serverState.isRedisPrimaryMode) {
        await syncGameToRedis(ws.gameId);
      }

      logger.info(
        {
          gameId: ws.gameId,
          originalPlayer: session.originalActivePlayer,
          targets: session.targetedPlayers,
        },
        "Targets confirmed, resolution started"
      );
    });
  } catch (error) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: error.message } }));
    metrics.recordError("confirmTargets_lock_error");
  }
}

/**
 * Handle pass target priority message
 * @param {WebSocket} ws - WebSocket client
 * @param {object} data - Message data
 */
async function handlePassTargetPriority(ws, data) {
  const session = serverState.isRedisPrimaryMode
    ? await ensureGameLoaded(ws.gameId)
    : serverState.getSession(ws.gameId);

  if (!session) return;

  try {
    await withGameLock(ws.gameId, async () => {
      if (session.targetingState !== TARGETING.STATES.RESOLVING) {
        safeSend(
          ws,
          JSON.stringify({
            type: "error",
            data: { message: "Not in targeting resolution" },
          })
        );
        return;
      }

      // Find the sender's player
      const senderPlayer = session.players.find(p => p.claimedBy === ws.clientId);
      if (!senderPlayer) {
        safeSend(
          ws,
          JSON.stringify({
            type: "error",
            data: { message: "You must claim a player to pass priority" },
          })
        );
        return;
      }

      if (!session.awaitingPriority.includes(senderPlayer.id)) {
        safeSend(
          ws,
          JSON.stringify({
            type: "error",
            data: { message: "You are not currently awaiting priority" },
          })
        );
        return;
      }

      if (senderPlayer.id !== session.activePlayer) {
        safeSend(
          ws,
          JSON.stringify({
            type: "error",
            data: { message: "Wait for your turn to pass priority" },
          })
        );
        return;
      }

      const passedBy = senderPlayer.id;
      session.passTargetPriority(senderPlayer.id);
      session.lastActivity = Date.now();

      // Broadcast appropriate event based on whether targeting completed
      if (session.targetingState === TARGETING.STATES.NONE) {
        // Targeting complete
        if (serverState.wss) {
          serverState.wss.clients.forEach(client => {
            if (client.gameId === ws.gameId) {
              safeSend(
                client,
                JSON.stringify({
                  type: "targetingComplete",
                  data: {
                    activePlayer: session.activePlayer,
                  },
                })
              );
            }
          });
        }
        logger.info({ gameId: ws.gameId, activePlayer: session.activePlayer }, "Targeting complete");
      } else {
        // Priority passed, moving to next target
        if (serverState.wss) {
          serverState.wss.clients.forEach(client => {
            if (client.gameId === ws.gameId) {
              safeSend(
                client,
                JSON.stringify({
                  type: "priorityPassed",
                  data: {
                    passedBy,
                    awaitingPriority: session.awaitingPriority,
                    activePlayer: session.activePlayer,
                  },
                })
              );
            }
          });
        }
        logger.debug(
          { gameId: ws.gameId, passedBy, nextActive: session.activePlayer },
          "Target priority passed"
        );
      }

      session.broadcastState();

      if (serverState.isRedisPrimaryMode) {
        await syncGameToRedis(ws.gameId);
      }
    });
  } catch (error) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: error.message } }));
    metrics.recordError("passTargetPriority_lock_error");
  }
}

/**
 * Handle cancel targeting message
 * @param {WebSocket} ws - WebSocket client
 * @param {object} data - Message data
 */
async function handleCancelTargeting(ws, data) {
  const session = serverState.isRedisPrimaryMode
    ? await ensureGameLoaded(ws.gameId)
    : serverState.getSession(ws.gameId);

  if (!session) return;

  try {
    await withGameLock(ws.gameId, async () => {
      if (session.targetingState === TARGETING.STATES.NONE) {
        return; // Nothing to cancel
      }

      // Find the sender's player
      const senderPlayer = session.players.find(p => p.claimedBy === ws.clientId);
      if (!senderPlayer) {
        safeSend(
          ws,
          JSON.stringify({
            type: "error",
            data: { message: "You must claim a player to cancel targeting" },
          })
        );
        return;
      }

      // Determine if this player can cancel
      const canCancel =
        (session.targetingState === TARGETING.STATES.SELECTING &&
          senderPlayer.id === session.activePlayer) ||
        (session.targetingState === TARGETING.STATES.RESOLVING &&
          senderPlayer.id === session.originalActivePlayer);

      if (!canCancel) {
        safeSend(
          ws,
          JSON.stringify({
            type: "error",
            data: { message: "You cannot cancel targeting" },
          })
        );
        return;
      }

      session.cancelTargeting();
      session.lastActivity = Date.now();

      // Broadcast targeting canceled event
      if (serverState.wss) {
        serverState.wss.clients.forEach(client => {
          if (client.gameId === ws.gameId) {
            safeSend(
              client,
              JSON.stringify({
                type: "targetingCanceled",
                data: {
                  activePlayer: session.activePlayer,
                },
              })
            );
          }
        });
      }

      session.broadcastState();

      if (serverState.isRedisPrimaryMode) {
        await syncGameToRedis(ws.gameId);
      }

      logger.info({ gameId: ws.gameId, canceledBy: senderPlayer.id }, "Targeting canceled");
    });
  } catch (error) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: error.message } }));
    metrics.recordError("cancelTargeting_lock_error");
  }
}

module.exports = {
  toggleTarget: handleToggleTarget,
  confirmTargets: handleConfirmTargets,
  passTargetPriority: handlePassTargetPriority,
  cancelTargeting: handleCancelTargeting,
  broadcastTargetingState,
};
