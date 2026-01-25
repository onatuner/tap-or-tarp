/**
 * Create Game Handler
 *
 * Handles game creation requests.
 */

const AsyncLock = require("async-lock");
const { logger } = require("../../logger");
const metrics = require("../../metrics");
const { validateSettings, generateGameId } = require("../../shared/validators");
const { createGameSession } = require("../../game-modes");
const { serverState } = require("../state");
const { safeSend, broadcastToGame, subscribeToGameChannel } = require("../websocket");
const { persistGameImmediately, syncGameToRedis } = require("../persistence");

// Lock for game creation to prevent ID collisions
const createGameLock = new AsyncLock({ timeout: 5000 });

/**
 * Handle create game message
 * @param {WebSocket} ws - WebSocket client
 * @param {object} data - Message data
 */
async function handleCreate(ws, data) {
  if (!validateSettings(data.settings)) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: "Invalid settings" } }));
    metrics.recordError("invalid_settings");
    return;
  }

  try {
    const result = await createGameLock.acquire("create", async () => {
      // Generate unique ID
      let id;
      let attempts = 0;
      const maxAttempts = 10;

      while (attempts < maxAttempts) {
        id = generateGameId(serverState.getSessionIds());

        // For Redis mode, check/reserve in Redis
        if (
          serverState.isAsyncStorageMode &&
          serverState.storage &&
          serverState.storage.reserveGameId
        ) {
          const reserved = await serverState.storage.reserveGameId(id);
          if (reserved) break;
        } else {
          // For SQLite/memory mode, just check local map
          if (!serverState.hasSession(id)) break;
        }
        attempts++;
      }

      if (attempts >= maxAttempts) {
        throw new Error("Failed to generate unique game ID");
      }

      // Determine game mode
      const mode = data.settings?.mode || "casual";

      // Create session using the game modes factory
      const session = createGameSession(mode, id, data.settings || {}, (type, msgData) => {
        broadcastToGame(id, type, msgData).catch(error => {
          logger.error({ error: error.message, gameId: id }, "Broadcast failed");
        });
      });

      session.setOwner(ws.clientId);
      serverState.setSession(id, session);

      return { id, session };
    });

    ws.gameId = result.id;

    // Subscribe to Redis channel for cross-instance messaging
    subscribeToGameChannel(result.id).catch(error => {
      logger.error(
        { error: error.message, gameId: result.id },
        "Failed to subscribe to game channel"
      );
    });

    // Persist the new game
    if (serverState.isRedisPrimaryMode) {
      await syncGameToRedis(result.id);
    } else {
      await persistGameImmediately(result.id);
    }

    safeSend(ws, JSON.stringify({ type: "state", data: result.session.getState() }));
    metrics.recordNewSession();
    metrics.recordMessageSent("state");

    logger.info(
      {
        gameId: result.id,
        clientId: ws.clientId,
        playerCount: result.session.settings.playerCount,
        mode: result.session.mode,
        instanceId: serverState.instanceId,
      },
      "Game created"
    );
  } catch (error) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: error.message } }));
    metrics.recordError("create_failed");
    logger.error({ error: error.message, clientId: ws.clientId }, "Failed to create game");
  }
}

module.exports = handleCreate;
