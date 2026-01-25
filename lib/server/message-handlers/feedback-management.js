/**
 * Feedback Management Handlers
 *
 * Handles loading, updating, and deleting user feedback
 */

const { logger } = require("../../logger");
const { serverState } = require("../state");
const { safeSend } = require("../websocket");

/**
 * Handle loading all feedback
 * @param {WebSocket} ws - WebSocket client
 */
async function handleLoadFeedbacks(ws) {
  try {
    let feedbacks = [];

    if (serverState.storage && serverState.storage.loadAllFeedbacks) {
      if (serverState.isAsyncStorageMode) {
        feedbacks = await serverState.storage.loadAllFeedbacks();
      } else {
        feedbacks = serverState.storage.loadAllFeedbacks();
      }

      logger.info({ clientId: ws.clientId }, "Feedback list loaded");
      safeSend(ws, JSON.stringify({ type: "feedbackList", data: { feedbacks } }));
    } else {
      logger.warn("Feedback storage not available, cannot load feedbacks");
      safeSend(
        ws,
        JSON.stringify({
          type: "error",
          data: { message: "Unable to load feedbacks at this time" },
        })
      );
    }
  } catch (error) {
    logger.error({ error: error.message, clientId: ws.clientId }, "Failed to load feedbacks");
    safeSend(ws, JSON.stringify({ type: "error", data: { message: "Failed to load feedbacks" } }));
  }
}

/**
 * Handle updating feedback
 * @param {WebSocket} ws - WebSocket client
 * @param {object} data - Message data
 */
async function handleUpdateFeedback(ws, data) {
  const { id, text } = data;

  if (!id || !text) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: "Invalid update request" } }));
    return;
  }

  if (typeof text !== "string" || text.trim().length === 0) {
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
    const existingFeedback = await loadFeedbackById(id);
    if (!existingFeedback) {
      safeSend(ws, JSON.stringify({ type: "error", data: { message: "Feedback not found" } }));
      return;
    }

    const updatedFeedback = {
      ...existingFeedback,
      text: text.trim(),
      timestamp: Date.now(),
    };

    if (serverState.storage && serverState.storage.updateFeedback) {
      if (serverState.isAsyncStorageMode) {
        await serverState.storage.updateFeedback(id, updatedFeedback);
      } else {
        serverState.storage.updateFeedback(id, updatedFeedback);
      }

      logger.info({ feedbackId: id, clientId: ws.clientId }, "Feedback updated successfully");
      safeSend(
        ws,
        JSON.stringify({ type: "feedbackUpdated", data: { message: "Feedback updated!" } })
      );
    } else {
      logger.warn("Feedback storage not available, cannot update feedback");
      safeSend(
        ws,
        JSON.stringify({
          type: "error",
          data: { message: "Unable to update feedback at this time" },
        })
      );
    }
  } catch (error) {
    logger.error({ error: error.message, feedbackId: id }, "Failed to update feedback");
    safeSend(ws, JSON.stringify({ type: "error", data: { message: "Failed to update feedback" } }));
  }
}

/**
 * Handle deleting feedback
 * @param {WebSocket} ws - WebSocket client
 * @param {object} data - Message data
 */
async function handleDeleteFeedback(ws, data) {
  const { id } = data;

  if (!id) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: "Invalid delete request" } }));
    return;
  }

  try {
    if (serverState.storage && serverState.storage.deleteFeedback) {
      if (serverState.isAsyncStorageMode) {
        await serverState.storage.deleteFeedback(id);
      } else {
        serverState.storage.deleteFeedback(id);
      }

      logger.info({ feedbackId: id, clientId: ws.clientId }, "Feedback deleted successfully");
      safeSend(
        ws,
        JSON.stringify({ type: "feedbackDeleted", data: { message: "Feedback deleted!" } })
      );
    } else {
      logger.warn("Feedback storage not available, cannot delete feedback");
      safeSend(
        ws,
        JSON.stringify({
          type: "error",
          data: { message: "Unable to delete feedback at this time" },
        })
      );
    }
  } catch (error) {
    logger.error({ error: error.message, feedbackId: id }, "Failed to delete feedback");
    safeSend(ws, JSON.stringify({ type: "error", data: { message: "Failed to delete feedback" } }));
  }
}

/**
 * Helper function to load feedback by ID
 * @param {string} id - Feedback ID
 * @returns {object|null} Feedback object or null
 */
async function loadFeedbackById(id) {
  if (!serverState.storage || !serverState.storage.loadFeedback) {
    return null;
  }

  if (serverState.isAsyncStorageMode) {
    return await serverState.storage.loadFeedback(id);
  } else {
    return serverState.storage.loadFeedback(id);
  }
}

module.exports = {
  handleLoadFeedbacks,
  handleUpdateFeedback,
  handleDeleteFeedback,
};
