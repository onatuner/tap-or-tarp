/**
 * Server Module Index
 *
 * Main entry point for the modular server components.
 * Re-exports all server utilities for convenient importing.
 */

const { serverState } = require("./state");
const { createHttpServer } = require("./http");
const {
  createWebSocketServer,
  safeSend,
  broadcastToLocalClients,
  broadcastToGame,
  subscribeToGameChannel,
} = require("./websocket");
const { createMessageHandler } = require("./message-handlers");
const {
  persistSessions,
  persistGameImmediately,
  syncGameToRedis,
  ensureGameLoaded,
  loadSessions,
} = require("./persistence");
const { cleanupSessions, handleClientDisconnect } = require("./cleanup");

module.exports = {
  // State
  serverState,

  // HTTP
  createHttpServer,

  // WebSocket
  createWebSocketServer,
  safeSend,
  broadcastToLocalClients,
  broadcastToGame,
  subscribeToGameChannel,

  // Message handling
  createMessageHandler,

  // Persistence
  persistSessions,
  persistGameImmediately,
  syncGameToRedis,
  ensureGameLoaded,
  loadSessions,

  // Cleanup
  cleanupSessions,
  handleClientDisconnect,
};
