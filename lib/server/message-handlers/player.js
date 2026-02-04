/**
 * Player Action Handlers
 *
 * Handles player-related actions: update, penalty, eliminate, settings.
 */

const { logger } = require("../../logger");
const metrics = require("../../metrics");
const { withGameLock } = require("../../lock");
const { CONSTANTS } = require("../../shared/constants");
const {
  validatePlayerName,
  validateTimeValue,
  validateWarningThresholds,
  sanitizeString,
} = require("../../shared/validators");
const { serverState } = require("../state");
const { safeSend } = require("../websocket");
const { ensureGameLoaded, syncGameToRedis } = require("../persistence");

/**
 * Handle update player message
 * @param {WebSocket} ws - WebSocket client
 * @param {object} data - Message data
 */
async function handleUpdatePlayer(ws, data) {
  const session = serverState.isRedisPrimaryMode
    ? await ensureGameLoaded(ws.gameId)
    : serverState.getSession(ws.gameId);

  if (!session) return;

  // Validate player ID
  if (data.playerId === undefined || data.playerId < 1 || data.playerId > CONSTANTS.MAX_PLAYERS) {
    return;
  }

  // Validate inputs
  if (data.name !== undefined && !validatePlayerName(data.name)) return;
  if (data.time !== undefined && !validateTimeValue(data.time)) return;

  // Sanitize name
  if (data.name !== undefined) {
    data.name = sanitizeString(data.name);
  }

  try {
    await withGameLock(ws.gameId, async () => {
      if (!session.canModifyPlayer(data.playerId, ws.clientId)) {
        logger.debug({
          gameId: ws.gameId,
          playerId: data.playerId,
          clientId: ws.clientId,
          gameStatus: session.status,
          reason: "Not owner, not player owner, not unclaimed in waiting"
        }, "Update player denied");

        safeSend(
          ws,
          JSON.stringify({
            type: "error",
            data: { message: "Not authorized to modify this player" },
          })
        );
        metrics.recordAuthDenied("updatePlayer");
        return;
      }

      logger.debug({
        gameId: ws.gameId,
        playerId: data.playerId,
        updates: Object.keys(data).filter(k => k !== 'playerId')
      }, "Player updated");

      session.lastActivity = Date.now();
      session.updatePlayer(data.playerId, data);

      if (serverState.isRedisPrimaryMode) {
        await syncGameToRedis(ws.gameId);
      }
    });
  } catch (error) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: error.message } }));
    metrics.recordError("updatePlayer_lock_error");
  }
}

/**
 * Handle add penalty message
 * @param {WebSocket} ws - WebSocket client
 * @param {object} data - Message data
 */
async function handleAddPenalty(ws, data) {
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
      session.lastActivity = Date.now();
      session.addPenalty(data.playerId);

      if (serverState.isRedisPrimaryMode) {
        await syncGameToRedis(ws.gameId);
      }

      logger.debug({ gameId: ws.gameId, playerId: data.playerId }, "Penalty added");
    });
  } catch (error) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: error.message } }));
    metrics.recordError("addPenalty_lock_error");
  }
}

/**
 * Handle eliminate player message
 * @param {WebSocket} ws - WebSocket client
 * @param {object} data - Message data
 */
async function handleEliminate(ws, data) {
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
      session.lastActivity = Date.now();
      session.eliminate(data.playerId);

      if (serverState.isRedisPrimaryMode) {
        await syncGameToRedis(ws.gameId);
      }

      logger.info({ gameId: ws.gameId, playerId: data.playerId }, "Player eliminated");
    });
  } catch (error) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: error.message } }));
    metrics.recordError("eliminate_lock_error");
  }
}

/**
 * Handle update settings message
 * @param {WebSocket} ws - WebSocket client
 * @param {object} data - Message data
 */
async function handleUpdateSettings(ws, data) {
  const session = serverState.isRedisPrimaryMode
    ? await ensureGameLoaded(ws.gameId)
    : serverState.getSession(ws.gameId);

  if (!session) return;

  // Validate warning thresholds if provided
  if (data.warningThresholds !== undefined) {
    if (!validateWarningThresholds(data.warningThresholds)) {
      safeSend(
        ws,
        JSON.stringify({
          type: "error",
          data: { message: "Invalid warning thresholds" },
        })
      );
      metrics.recordError("invalid_warning_thresholds");
      return;
    }
  }

  try {
    await withGameLock(ws.gameId, async () => {
      session.lastActivity = Date.now();

      if (data.warningThresholds !== undefined) {
        session.settings.warningThresholds = data.warningThresholds;
        session.broadcastState();

        if (serverState.isRedisPrimaryMode) {
          await syncGameToRedis(ws.gameId);
        }

        logger.debug({ gameId: ws.gameId }, "Settings updated");
      }
    });
  } catch (error) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: error.message } }));
    metrics.recordError("updateSettings_lock_error");
  }
}

module.exports = {
  updatePlayer: handleUpdatePlayer,
  addPenalty: handleAddPenalty,
  eliminate: handleEliminate,
  updateSettings: handleUpdateSettings,
};
