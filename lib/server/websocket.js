/**
 * WebSocket Server Configuration
 *
 * WebSocket server setup, connection handling, and broadcasting.
 */

const WebSocket = require("ws");
const { logger } = require("../logger");
const metrics = require("../metrics");
const { CONSTANTS } = require("../shared/constants");
const { serverState } = require("./state");

// Buffer configuration
const MAX_BUFFER_SIZE = CONSTANTS.MAX_BUFFER_SIZE;
const BUFFER_WARNING_SIZE = CONSTANTS.BUFFER_WARNING_SIZE;

/**
 * Parse allowed origins from environment
 * @returns {string[]|null}
 */
function getAllowedOrigins() {
  return process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",").map(o => o.trim())
    : null;
}

/**
 * Check if an origin is allowed
 * @param {string} origin - Origin to check
 * @param {string[]} allowedOrigins - List of allowed origins
 * @returns {boolean}
 */
function isOriginAllowed(origin, allowedOrigins) {
  if (!allowedOrigins) return true;
  if (!origin) return true;

  return allowedOrigins.some(allowed => {
    if (origin === allowed) return true;
    if (allowed.startsWith("*.")) {
      const domain = allowed.slice(2);
      return origin.endsWith(domain) || origin.endsWith("://" + domain);
    }
    return false;
  });
}

/**
 * Create WebSocket server
 * @param {http.Server} server - HTTP server
 * @param {object} rateLimiters - Rate limiter instances
 * @param {function} getClientIP - Function to get client IP
 * @returns {WebSocket.Server}
 */
function createWebSocketServer(server, rateLimiters, getClientIP) {
  const allowedOrigins = getAllowedOrigins();

  const wss = new WebSocket.Server({
    server,
    maxPayload: 64 * 1024, // 64KB max message size
    verifyClient: ({ origin, req }, callback) => {
      const clientIP = getClientIP(req);

      // Connection rate limiting
      if (rateLimiters.connection && !rateLimiters.connection.isConnectionAllowed(clientIP)) {
        logger.warn({ ip: clientIP }, "Connection rate limit exceeded");
        metrics.recordRateLimitExceeded("connection");
        callback(false, 429, "Too Many Requests: Connection rate limit exceeded");
        return;
      }

      req.clientIP = clientIP;

      // Origin validation
      if (!isOriginAllowed(origin, allowedOrigins)) {
        logger.warn(
          { origin, allowedOrigins },
          "Rejected WebSocket connection from unauthorized origin"
        );
        callback(false, 403, "Forbidden: Origin not allowed");
        return;
      }

      callback(true);
    },
  });

  serverState.setWebSocketServer(wss);
  return wss;
}

/**
 * Safely send a message to a client with backpressure handling
 * @param {WebSocket} client - WebSocket client
 * @param {string} message - JSON string to send
 * @returns {boolean} True if sent successfully
 */
function safeSend(client, message) {
  if (client.readyState !== WebSocket.OPEN) {
    return false;
  }

  if (client.bufferedAmount > MAX_BUFFER_SIZE) {
    logger.warn(
      {
        clientId: client.clientId,
        gameId: client.gameId,
        bufferedAmount: client.bufferedAmount,
      },
      "Client buffer overflow, closing connection"
    );
    metrics.recordBufferOverflow();
    client.close(1008, "Buffer overflow");
    return false;
  }

  if (client.bufferedAmount > BUFFER_WARNING_SIZE && !client._bufferWarned) {
    logger.debug(
      {
        clientId: client.clientId,
        bufferedAmount: client.bufferedAmount,
      },
      "Client buffer high"
    );
    client._bufferWarned = true;
  } else if (client.bufferedAmount < BUFFER_WARNING_SIZE / 2) {
    client._bufferWarned = false;
  }

  try {
    client.send(message);
    return true;
  } catch (error) {
    logger.error({ clientId: client.clientId, error: error.message }, "Failed to send message");
    metrics.recordMessageDropped();
    return false;
  }
}

/**
 * Broadcast to all local clients in a game
 * @param {string} gameId - Game ID
 * @param {string} type - Message type
 * @param {object} data - Message data
 * @returns {number} Number of clients sent to
 */
function broadcastToLocalClients(gameId, type, data) {
  const message = JSON.stringify({ type, data });
  let sentCount = 0;

  if (serverState.wss) {
    serverState.wss.clients.forEach(client => {
      if (client.gameId === gameId) {
        if (safeSend(client, message)) {
          sentCount++;
        }
      }
    });
  }

  return sentCount;
}

/**
 * Broadcast to all clients in a game (including cross-instance via Redis)
 * @param {string} gameId - Game ID
 * @param {string} type - Message type
 * @param {object} data - Message data
 */
async function broadcastToGame(gameId, type, data) {
  // Always broadcast to local clients first
  broadcastToLocalClients(gameId, type, data);

  // If using Redis, also publish to cross-instance channel
  if (serverState.isAsyncStorageMode && serverState.storage && serverState.storage.broadcast) {
    try {
      await serverState.storage.broadcast(gameId, type, data);
    } catch (error) {
      logger.error({ error: error.message, gameId }, "Failed to broadcast via Redis");
    }
  }
}

/**
 * Handle a message received from another instance via Redis
 * @param {string} gameId - Game ID
 * @param {object} message - Message from Redis
 */
function handleCrossInstanceMessage(gameId, message) {
  if (message.instanceId === serverState.instanceId) return;

  if (message.type && message.data) {
    broadcastToLocalClients(gameId, message.type, message.data);
    logger.debug({ gameId, type: message.type }, "Relayed cross-instance message");
  }
}

/**
 * Subscribe to a game's Redis channel
 * @param {string} gameId - Game ID
 */
async function subscribeToGameChannel(gameId) {
  if (
    !serverState.isAsyncStorageMode ||
    !serverState.storage ||
    !serverState.storage.subscribeToGame
  ) {
    return;
  }

  try {
    await serverState.storage.subscribeToGame(gameId, message => {
      handleCrossInstanceMessage(gameId, message);
    });
    logger.debug({ gameId }, "Subscribed to game channel");
  } catch (error) {
    logger.error({ error: error.message, gameId }, "Failed to subscribe to game channel");
  }
}

module.exports = {
  createWebSocketServer,
  safeSend,
  broadcastToLocalClients,
  broadcastToGame,
  handleCrossInstanceMessage,
  subscribeToGameChannel,
  getAllowedOrigins,
  isOriginAllowed,
};
