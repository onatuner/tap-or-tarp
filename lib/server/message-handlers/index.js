/**
 * Message Handlers Registry
 *
 * Central registry for all WebSocket message handlers.
 * Each handler is responsible for processing a specific message type.
 */

const { logger } = require("../../logger");
const metrics = require("../../metrics");
const { CONSTANTS } = require("../../shared/constants");
const { serverState } = require("../state");
const { safeSend } = require("../websocket");

// Import individual handlers
const createHandler = require("./create");
const joinHandler = require("./join");
const gameControlHandlers = require("./game-control");
const playerHandlers = require("./player");
const claimHandlers = require("./claim");
const feedbackHandler = require("./feedback");
const feedbackManagementHandlers = require("./feedback-management");

/**
 * Message handler registry
 * Maps message types to their handler functions
 */
const handlers = {
  // Game creation and joining
  create: createHandler,
  join: joinHandler,

  // Game control
  start: gameControlHandlers.start,
  pause: gameControlHandlers.pause,
  reset: gameControlHandlers.reset,
  switch: gameControlHandlers.switch,
  endGame: gameControlHandlers.endGame,
  renameGame: gameControlHandlers.renameGame,

  // Player actions
  updatePlayer: playerHandlers.updatePlayer,
  addPenalty: playerHandlers.addPenalty,
  eliminate: playerHandlers.eliminate,
  updateSettings: playerHandlers.updateSettings,

  // Claiming
  claim: claimHandlers.claim,
  reconnect: claimHandlers.reconnect,
  unclaim: claimHandlers.unclaim,

  // Feedback
  feedback: feedbackHandler,
  loadFeedbacks: feedbackManagementHandlers.handleLoadFeedbacks,
  updateFeedback: feedbackManagementHandlers.handleUpdateFeedback,
  deleteFeedback: feedbackManagementHandlers.handleDeleteFeedback,
};

/**
 * Process a WebSocket message
 * @param {WebSocket} ws - WebSocket client
 * @param {object} message - Parsed message
 */
async function processMessage(ws, message) {
  const { type, data = {} } = message;

  if (!type || typeof type !== "string") {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: "Invalid message type" } }));
    metrics.recordError("invalid_message_type");
    return;
  }

  const handler = handlers[type];
  if (!handler) {
    safeSend(
      ws,
      JSON.stringify({ type: "error", data: { message: `Unknown message type: ${type}` } })
    );
    metrics.recordError("unknown_message_type");
    return;
  }

  metrics.recordMessageReceived(type);

  try {
    await handler(ws, data);
  } catch (error) {
    logger.error({ type, error: error.message, clientId: ws.clientId }, "Message handler error");
    safeSend(ws, JSON.stringify({ type: "error", data: { message: error.message } }));
    metrics.recordError(`${type}_error`);
  }
}

/**
 * Check per-connection rate limiting
 * @param {WebSocket} ws - WebSocket client
 * @returns {boolean} True if allowed
 */
function checkConnectionRateLimit(ws) {
  const now = Date.now();
  ws.messageTimestamps = ws.messageTimestamps.filter(ts => now - ts < CONSTANTS.RATE_LIMIT_WINDOW);

  if (ws.messageTimestamps.length >= CONSTANTS.RATE_LIMIT_MAX_MESSAGES) {
    return false;
  }

  ws.messageTimestamps.push(now);
  return true;
}

/**
 * Create the message handler function for WebSocket connections
 * @param {object} rateLimiters - Rate limiter instances
 * @returns {function} Message handler
 */
function createMessageHandler(rateLimiters) {
  return async function handleMessage(ws, messageData) {
    // Per-connection rate limiting
    if (!checkConnectionRateLimit(ws)) {
      safeSend(ws, JSON.stringify({ type: "error", data: { message: "Rate limit exceeded" } }));
      metrics.recordRateLimitExceeded("connection");
      logger.warn({ clientId: ws.clientId, ip: ws.clientIP }, "Per-connection rate limit exceeded");
      return;
    }

    // IP-based rate limiting
    if (rateLimiters.message && !rateLimiters.message.isAllowed(ws.clientIP)) {
      safeSend(ws, JSON.stringify({ type: "error", data: { message: "Rate limit exceeded" } }));
      metrics.recordRateLimitExceeded("ip");
      logger.warn({ clientId: ws.clientId, ip: ws.clientIP }, "IP-based rate limit exceeded");
      return;
    }

    try {
      const message = JSON.parse(messageData);
      await processMessage(ws, message);
    } catch (e) {
      logger.error({ error: e.message, clientId: ws.clientId }, "Invalid JSON received");
      metrics.recordError("invalid_json");
    }
  };
}

module.exports = {
  handlers,
  processMessage,
  createMessageHandler,
  checkConnectionRateLimit,
};
