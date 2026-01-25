/**
 * Feedback Message Handler
 *
 * Handles user feedback submissions and stores them persistently
 */

const { logger } = require("../../logger");
const { serverState } = require("../state");
const { safeSend } = require("../websocket");
const { CONSTANTS } = require("../../shared/constants");

/**
 * Handle feedback submission
 * @param {WebSocket} ws - WebSocket client
 * @param {object} data - Message data
 */
async function handleFeedback(ws, data) {
  const { text } = data;

  if (!text || typeof text !== "string") {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: "Invalid feedback text" } }));
    return;
  }

  if (text.trim().length === 0) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: "Feedback cannot be empty" } }));
    return;
  }

  if (text.length > 255) {
    safeSend(
      ws,
      JSON.stringify({ type: "error", data: { message: "Feedback exceeds maximum length" } })
    );
    return;
  }

  try {
    const feedback = {
      id: generateFeedbackId(),
      text: text.trim(),
      clientId: ws.clientId,
      clientIP: ws.clientIP || "unknown",
      timestamp: Date.now(),
    };

    if (serverState.storage && serverState.storage.saveFeedback) {
      if (serverState.isAsyncStorageMode) {
        await serverState.storage.saveFeedback(feedback);
      } else {
        serverState.storage.saveFeedback(feedback);
      }
      logger.info(
        { feedbackId: feedback.id, clientId: ws.clientId },
        "Feedback saved successfully"
      );
      safeSend(
        ws,
        JSON.stringify({
          type: "feedbackSubmitted",
          data: { message: "Thank you for your feedback!" },
        })
      );
    } else {
      logger.warn("Feedback storage not available, feedback not saved");
      safeSend(
        ws,
        JSON.stringify({
          type: "error",
          data: { message: "Unable to save feedback at this time" },
        })
      );
    }
  } catch (error) {
    logger.error({ error: error.message, clientId: ws.clientId }, "Failed to save feedback");
    safeSend(ws, JSON.stringify({ type: "error", data: { message: "Failed to save feedback" } }));
  }
}

/**
 * Generate a unique feedback ID
 * @returns {string} Feedback ID
 */
function generateFeedbackId() {
  return `fb_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

module.exports = handleFeedback;
