/**
 * Server State Management
 *
 * Centralized management of server-wide state including game sessions,
 * storage, and configuration. Provides a single source of truth for
 * all server components.
 */

const crypto = require("crypto");
const { logger } = require("../logger");

/**
 * Server state singleton
 */
class ServerState {
  constructor() {
    // Game sessions map
    this.gameSessions = new Map();

    // Viewer tracking per game
    this.gameViewers = new Map(); // gameId -> Set of clientIds

    // Storage backend
    this.storage = null;
    this.isAsyncStorageMode = false;
    this.isRedisPrimaryMode = false;

    // Server state
    this.isShuttingDown = false;

    // Timers
    this.persistenceTimer = null;
    this.cleanupTimer = null;
    this.heartbeatTimer = null;

    // WebSocket server reference
    this.wss = null;

    // Instance identification
    this.instanceId =
      process.env.FLY_ALLOC_ID ||
      process.env.INSTANCE_ID ||
      `instance_${crypto.randomBytes(8).toString("hex")}`;

    // Client ID counter
    this.clientIdCounter = 0;
  }

  /**
   * Set storage backend
   * @param {object} storage - Storage instance
   * @param {boolean} isAsync - Whether storage uses async operations
   * @param {boolean} isRedisPrimary - Whether Redis is the primary store
   */
  setStorage(storage, isAsync = false, isRedisPrimary = false) {
    this.storage = storage;
    this.isAsyncStorageMode = isAsync;
    this.isRedisPrimaryMode = isRedisPrimary;
  }

  /**
   * Set WebSocket server reference
   * @param {WebSocket.Server} wss - WebSocket server
   */
  setWebSocketServer(wss) {
    this.wss = wss;
  }

  /**
   * Generate a unique client ID
   * @returns {string}
   */
  generateClientId() {
    return `client_${Date.now()}_${++this.clientIdCounter}`;
  }

  /**
   * Get a game session
   * @param {string} gameId - Game ID
   * @returns {GameSession|undefined}
   */
  getSession(gameId) {
    return this.gameSessions.get(gameId);
  }

  /**
   * Set a game session
   * @param {string} gameId - Game ID
   * @param {GameSession} session - Session instance
   */
  setSession(gameId, session) {
    this.gameSessions.set(gameId, session);
  }

  /**
   * Delete a game session
   * @param {string} gameId - Game ID
   * @returns {boolean}
   */
  deleteSession(gameId) {
    const session = this.gameSessions.get(gameId);
    if (session) {
      session.cleanup();
    }
    return this.gameSessions.delete(gameId);
  }

  /**
   * Check if a session exists
   * @param {string} gameId - Game ID
   * @returns {boolean}
   */
  hasSession(gameId) {
    return this.gameSessions.has(gameId);
  }

  /**
   * Get all session IDs
   * @returns {Set<string>}
   */
  getSessionIds() {
    return new Set(this.gameSessions.keys());
  }

  /**
   * Get session count
   * @returns {number}
   */
  getSessionCount() {
    return this.gameSessions.size;
  }

  /**
   * Iterate over all sessions
   * @returns {IterableIterator<[string, GameSession]>}
   */
  getAllSessions() {
    return this.gameSessions.entries();
  }

  /**
   * Add a viewer to a game
   * @param {string} gameId - Game ID
   * @param {string} clientId - Client ID
   * @returns {number} Current viewer count
   */
  addViewer(gameId, clientId) {
    if (!this.gameViewers.has(gameId)) {
      this.gameViewers.set(gameId, new Set());
    }
    this.gameViewers.get(gameId).add(clientId);
    return this.gameViewers.get(gameId).size;
  }

  /**
   * Remove a viewer from a game
   * @param {string} gameId - Game ID
   * @param {string} clientId - Client ID
   * @returns {number} Current viewer count
   */
  removeViewer(gameId, clientId) {
    if (this.gameViewers.has(gameId)) {
      this.gameViewers.get(gameId).delete(clientId);
      if (this.gameViewers.get(gameId).size === 0) {
        this.gameViewers.delete(gameId);
      }
      return this.gameViewers.get(gameId)?.size || 0;
    }
    return 0;
  }

  /**
   * Get viewer count for a game
   * @param {string} gameId - Game ID
   * @returns {number} Viewer count
   */
  getViewerCount(gameId) {
    return this.gameViewers.get(gameId)?.size || 0;
  }

  /**
   * Begin shutdown process
   */
  beginShutdown() {
    this.isShuttingDown = true;
  }

  /**
   * Clear all timers
   */
  clearTimers() {
    if (this.persistenceTimer) {
      clearInterval(this.persistenceTimer);
      this.persistenceTimer = null;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Cleanup all sessions
   */
  cleanupAllSessions() {
    for (const [, session] of this.gameSessions.entries()) {
      session.cleanup();
    }
  }
}

// Singleton instance
const serverState = new ServerState();

module.exports = { serverState, ServerState };
