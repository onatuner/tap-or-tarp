const crypto = require("crypto");
// Note: 'he' package is available for more complex HTML entity encoding if needed
// Currently using simpler regex-based sanitization that preserves Unicode

const CONSTANTS = {
  TICK_INTERVAL: 100,
  MIN_PLAYERS: 2,
  MAX_PLAYERS: 8,
  MAX_INITIAL_TIME: 24 * 60 * 60 * 1000,
  MAX_PLAYER_NAME_LENGTH: 50,
  SESSION_CLEANUP_INTERVAL: 5 * 60 * 1000,
  INACTIVE_SESSION_THRESHOLD: 24 * 60 * 60 * 1000,
  EMPTY_SESSION_THRESHOLD: 5 * 60 * 1000,
  DEFAULT_INITIAL_TIME: 10 * 60 * 1000,
  WARNING_TICK_DELTA: 100,
  RATE_LIMIT_WINDOW: 1000,
  RATE_LIMIT_MAX_MESSAGES: 20,
  RECONNECT_TOKEN_EXPIRY: 60 * 60 * 1000, // 1 hour
};

class GameSession {
  constructor(id, settings, broadcastFn = null) {
    this.id = id;
    this.players = [];
    this.activePlayer = null;
    this.status = "waiting";
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.lastTick = null;
    this.interval = null;
    this.broadcastFn = broadcastFn;
    this.ownerId = null; // Client ID of the game creator
    this.settings = {
      initialTime: settings.initialTime || CONSTANTS.DEFAULT_INITIAL_TIME,
      playerCount: settings.playerCount || CONSTANTS.MIN_PLAYERS,
      warningThresholds: settings.warningThresholds || [300000, 60000, 30000],
      penaltyType: settings.penaltyType || "warning",
      penaltyTimeDeduction: settings.penaltyTimeDeduction || 0,
      audioEnabled: true,
    };

    this.initPlayers();
  }

  /**
   * Set the game owner (first client to create the game)
   * @param {string} clientId - Client ID to set as owner
   */
  setOwner(clientId) {
    if (!this.ownerId) {
      this.ownerId = clientId;
    }
  }

  /**
   * Check if a client is the game owner
   * @param {string} clientId - Client ID to check
   * @returns {boolean}
   */
  isOwner(clientId) {
    return this.ownerId === clientId;
  }

  /**
   * Check if a client owns (claimed) a specific player
   * @param {number} playerId - Player ID to check
   * @param {string} clientId - Client ID to check
   * @returns {boolean}
   */
  isPlayerOwner(playerId, clientId) {
    const player = this.players.find(p => p.id === playerId);
    if (!player) return false;
    return player.claimedBy === clientId;
  }

  /**
   * Check if a client has any claimed player in the game
   * @param {string} clientId - Client ID to check
   * @returns {boolean}
   */
  hasClaimedPlayer(clientId) {
    return this.players.some(p => p.claimedBy === clientId);
  }

  /**
   * Check if a client can modify a specific player
   * Game owner can modify anyone, player owner can modify their own
   * @param {number} playerId - Player ID to modify
   * @param {string} clientId - Client ID requesting modification
   * @returns {boolean}
   */
  canModifyPlayer(playerId, clientId) {
    return this.isOwner(clientId) || this.isPlayerOwner(playerId, clientId);
  }

  /**
   * Check if a client can perform game control actions (pause, reset, start)
   * Requires being the owner or having a claimed player
   * @param {string} clientId - Client ID to check
   * @returns {boolean}
   */
  canControlGame(clientId) {
    return this.isOwner(clientId) || this.hasClaimedPlayer(clientId);
  }

  /**
   * Check if a client can switch to a specific player (pass turn)
   * During waiting: anyone can switch
   * During game: only the active player's owner or game owner can switch
   * @param {number} targetPlayerId - Target player ID
   * @param {string} clientId - Client ID requesting switch
   * @returns {boolean}
   */
  canSwitchPlayer(targetPlayerId, clientId) {
    // Anyone can switch during waiting phase
    if (this.status === "waiting") return true;

    // Game owner can always switch
    if (this.isOwner(clientId)) return true;

    // Active player's owner can pass their turn
    const activePlayer = this.players.find(p => p.id === this.activePlayer);
    if (activePlayer && activePlayer.claimedBy === clientId) return true;

    return false;
  }

  initPlayers() {
    this.players = [];
    for (let i = 1; i <= this.settings.playerCount; i++) {
      this.players.push({
        id: i,
        name: `Player ${i}`,
        timeRemaining: this.settings.initialTime,
        penalties: 0,
        isEliminated: false,
        claimedBy: null,
        reconnectToken: null,
        tokenExpiry: null,
        life: 20,
        drunkCounter: 0,
        genericCounter: 0,
      });
    }
  }

  /**
   * Generate a secure reconnection token
   * @returns {string} 32-byte hex token
   */
  generateReconnectToken() {
    return crypto.randomBytes(32).toString("hex");
  }

  /**
   * Claim a player slot and generate a reconnection token
   * @param {number} playerId - Player ID to claim
   * @param {string} clientId - Client ID claiming the player
   * @returns {{ success: boolean, token?: string }} Result with optional token
   */
  claimPlayer(playerId, clientId) {
    if (this.status !== "waiting") {
      return { success: false, reason: "Game already started" };
    }

    const player = this.players.find(p => p.id === playerId);
    if (!player) {
      return { success: false, reason: "Player not found" };
    }

    if (player.claimedBy && player.claimedBy !== clientId) {
      return { success: false, reason: "Player already claimed" };
    }

    // Unclaim any previously claimed player by this client
    this.players.forEach(p => {
      if (p.claimedBy === clientId) {
        p.claimedBy = null;
        p.reconnectToken = null;
        p.tokenExpiry = null;
      }
    });

    // Generate reconnection token
    const token = this.generateReconnectToken();
    player.claimedBy = clientId;
    player.reconnectToken = token;
    player.tokenExpiry = Date.now() + CONSTANTS.RECONNECT_TOKEN_EXPIRY;

    this.broadcastState();
    return { success: true, token };
  }

  /**
   * Attempt to reconnect and reclaim a player slot using a token
   * @param {number} playerId - Player ID to reclaim
   * @param {string} token - Reconnection token
   * @param {string} newClientId - New client ID to assign
   * @returns {{ success: boolean, reason?: string }}
   */
  reconnectPlayer(playerId, token, newClientId) {
    const player = this.players.find(p => p.id === playerId);
    if (!player) {
      return { success: false, reason: "Player not found" };
    }

    if (!player.reconnectToken) {
      return { success: false, reason: "No reconnection token for this player" };
    }

    if (player.reconnectToken !== token) {
      return { success: false, reason: "Invalid token" };
    }

    if (Date.now() > player.tokenExpiry) {
      // Clear expired token
      player.reconnectToken = null;
      player.tokenExpiry = null;
      return { success: false, reason: "Token expired" };
    }

    // Reclaim the player with new client ID
    player.claimedBy = newClientId;
    // Generate new token for the new session
    const newToken = this.generateReconnectToken();
    player.reconnectToken = newToken;
    player.tokenExpiry = Date.now() + CONSTANTS.RECONNECT_TOKEN_EXPIRY;

    this.broadcastState();
    return { success: true, token: newToken };
  }

  unclaimPlayer(clientId) {
    this.players.forEach(p => {
      if (p.claimedBy === clientId) {
        p.claimedBy = null;
        p.reconnectToken = null;
        p.tokenExpiry = null;
      }
    });
    this.broadcastState();
  }

  handleClientDisconnect(clientId) {
    let changed = false;
    this.players.forEach(p => {
      if (p.claimedBy === clientId) {
        p.claimedBy = null;
        changed = true;
      }
    });
    if (changed) {
      this.broadcastState();
    }
  }

  start() {
    if (this.status === "waiting" || this.status === "paused") {
      this.status = "running";
      this.lastTick = Date.now();
      this.activePlayer = this.activePlayer || 1;
      this.interval = setInterval(() => this.tick(), CONSTANTS.TICK_INTERVAL);
      this.broadcastState();
    }
  }

  pause() {
    if (this.status === "running") {
      this.status = "paused";
      clearInterval(this.interval);
      this.broadcastState();
    }
  }

  resume() {
    if (this.status === "paused") {
      this.start();
    }
  }

  tick() {
    if (this.status !== "running") return;

    const now = Date.now();
    const elapsed = now - this.lastTick;
    this.lastTick = now;

    const activePlayer = this.players.find(p => p.id === this.activePlayer);
    if (activePlayer && !activePlayer.isEliminated) {
      activePlayer.timeRemaining -= elapsed;

      if (activePlayer.timeRemaining <= 0) {
        activePlayer.timeRemaining = 0;
        this.handleTimeout(activePlayer);
      } else {
        this.checkWarnings(activePlayer);
      }

      this.broadcastTimes();
    }
  }

  handleTimeout(player) {
    this.pause();
    player.penalties++;
    this.broadcastTimeout(player.id);
    this.applyPenalty(player);
    this.broadcastState();
  }

  applyPenalty(player) {
    switch (this.settings.penaltyType) {
      case "time_deduction":
        player.timeRemaining -= this.settings.penaltyTimeDeduction;
        break;
      case "game_loss":
        player.isEliminated = true;
        break;
    }
  }

  checkWarnings(player) {
    this.settings.warningThresholds.forEach(threshold => {
      const nextThreshold =
        player.timeRemaining > threshold &&
        player.timeRemaining - CONSTANTS.WARNING_TICK_DELTA <= threshold;
      if (nextThreshold) {
        this.broadcastWarning(player.id, threshold);
      }
    });
  }

  switchPlayer(playerId) {
    const activePlayers = this.players.filter(p => !p.isEliminated);
    if (activePlayers.length <= 1) return;

    const targetPlayer = this.players.find(p => p.id === playerId);
    if (targetPlayer && !targetPlayer.isEliminated) {
      this.activePlayer = playerId;
      this.lastTick = Date.now();
      this.broadcastState();
    }
  }

  reset() {
    this.pause();
    this.status = "waiting";
    this.activePlayer = null;
    this.initPlayers();
    this.broadcastState();
  }

  updatePlayer(playerId, updates) {
    const player = this.players.find(p => p.id === playerId);
    if (player) {
      if (updates.name !== undefined) player.name = updates.name;
      if (updates.time !== undefined) player.timeRemaining = updates.time;
      if (updates.life !== undefined) player.life = updates.life;
      if (updates.drunkCounter !== undefined) player.drunkCounter = updates.drunkCounter;
      if (updates.genericCounter !== undefined) player.genericCounter = updates.genericCounter;
      this.broadcastState();
    }
  }

  addPenalty(playerId) {
    const player = this.players.find(p => p.id === playerId);
    if (player) {
      player.penalties++;
      this.applyPenalty(player);
      this.broadcastState();
    }
  }

  eliminate(playerId) {
    const player = this.players.find(p => p.id === playerId);
    if (player) {
      player.isEliminated = true;
      if (this.activePlayer === playerId) {
        const nextPlayer = this.players.find(p => !p.isEliminated);
        if (nextPlayer) {
          this.activePlayer = nextPlayer.id;
        } else {
          this.pause();
        }
      }
      this.broadcastState();
    }
  }

  broadcastState() {
    if (this.broadcastFn) {
      this.broadcastFn("state", this.getState());
    }
    this.lastActivity = Date.now();
  }

  broadcastTimes() {
    if (this.broadcastFn) {
      const times = {};
      this.players.forEach(p => {
        times[p.id] = p.timeRemaining;
      });
      this.broadcastFn("tick", { times });
    }
  }

  broadcastTimeout(playerId) {
    if (this.broadcastFn) {
      this.broadcastFn("timeout", { playerId });
    }
  }

  broadcastWarning(playerId, threshold) {
    if (this.broadcastFn) {
      this.broadcastFn("warning", { playerId, threshold });
    }
  }

  /**
   * Get public state for broadcasting to clients
   * Excludes sensitive data like reconnection tokens
   * @returns {object} Public state object
   */
  getState() {
    // Strip sensitive token data from players
    const publicPlayers = this.players.map(p => ({
      id: p.id,
      name: p.name,
      timeRemaining: p.timeRemaining,
      penalties: p.penalties,
      isEliminated: p.isEliminated,
      claimedBy: p.claimedBy,
      life: p.life,
      drunkCounter: p.drunkCounter,
      genericCounter: p.genericCounter,
    }));

    return {
      id: this.id,
      players: publicPlayers,
      activePlayer: this.activePlayer,
      status: this.status,
      createdAt: this.createdAt,
      settings: this.settings,
      ownerId: this.ownerId,
    };
  }

  /**
   * Serialize session state for persistence
   * Includes all data including reconnection tokens
   * @returns {object} Serializable state object
   */
  toJSON() {
    return {
      id: this.id,
      players: this.players, // Includes reconnectToken and tokenExpiry
      activePlayer: this.activePlayer,
      status: this.status,
      createdAt: this.createdAt,
      lastActivity: this.lastActivity,
      settings: this.settings,
      ownerId: this.ownerId,
    };
  }

  /**
   * Restore session state from persistence
   * @param {object} state - Persisted state object
   * @param {function} broadcastFn - Broadcast function
   * @returns {GameSession}
   */
  static fromState(state, broadcastFn = null) {
    const session = new GameSession(state.id, state.settings, broadcastFn);
    session.players = state.players;
    session.activePlayer = state.activePlayer;
    session.status = state.status === "running" ? "paused" : state.status; // Pause running games on restore
    session.createdAt = state.createdAt;
    session.lastActivity = state.lastActivity || Date.now();
    session.ownerId = state.ownerId || null;
    return session;
  }

  cleanup() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}

function validateSettings(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return false;

  if (settings.playerCount !== undefined) {
    const count = Number(settings.playerCount);
    if (!Number.isInteger(count) || count < CONSTANTS.MIN_PLAYERS || count > CONSTANTS.MAX_PLAYERS)
      return false;
  }

  if (settings.initialTime !== undefined) {
    const time = Number(settings.initialTime);
    if (!Number.isInteger(time) || time <= 0 || time > CONSTANTS.MAX_INITIAL_TIME) return false;
  }

  return true;
}

function validatePlayerName(name) {
  if (typeof name !== "string") return false;
  if (name.length > CONSTANTS.MAX_PLAYER_NAME_LENGTH) return false;
  return true;
}

function validateWarningThresholds(thresholds) {
  if (!Array.isArray(thresholds)) return false;
  if (thresholds.length === 0 || thresholds.length > 10) return false;
  return thresholds.every(
    t => typeof t === "number" && Number.isFinite(t) && t > 0 && t <= CONSTANTS.MAX_INITIAL_TIME
  );
}

function validateTimeValue(time) {
  if (typeof time !== "number") return false;
  if (!Number.isFinite(time)) return false;
  if (time < 0 || time > CONSTANTS.MAX_INITIAL_TIME) return false;
  return true;
}

const he = require("he");

/**
 * Sanitize a string to prevent XSS attacks
 * Uses HTML entity encoding for dangerous characters only
 * Preserves Unicode characters (emojis, international text)
 * @param {string} str - String to sanitize
 * @returns {string} Sanitized string with dangerous characters encoded
 */
function sanitizeString(str) {
  if (typeof str !== "string") return str;
  // Only encode characters that could be used for XSS attacks
  // Preserve Unicode (emojis, international characters)
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function generateGameId(existingIds = new Set()) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const maxAttempts = 100;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let id = "";
    for (let i = 0; i < 6; i++) {
      id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    if (!existingIds.has(id)) {
      return id;
    }
  }

  return Date.now().toString(36).toUpperCase().slice(-6);
}

module.exports = {
  CONSTANTS,
  GameSession,
  validateSettings,
  validatePlayerName,
  validateWarningThresholds,
  validateTimeValue,
  sanitizeString,
  generateGameId,
};
