/**
 * Base Game Mode Interface
 *
 * Abstract base class defining the contract for all game modes.
 * Extend this class to implement new game modes (casual, campaign, tournament, etc.)
 */

const crypto = require("crypto");
const { CONSTANTS } = require("../shared/constants");

/**
 * Base class for game sessions across all modes.
 * Contains shared player management, timer logic, and broadcasting.
 */
class BaseGameSession {
  /**
   * @param {string} id - Unique game session ID
   * @param {object} settings - Game settings
   * @param {function} broadcastFn - Function to broadcast messages to clients
   */
  constructor(id, settings = {}, broadcastFn = null) {
    this.id = id;
    this.mode = "base"; // Override in subclasses
    this.name = settings.name || "Game"; // Game lobby name
    this.players = [];
    this.activePlayer = null;
    this.status = "waiting"; // waiting, running, paused, finished
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.lastTick = null;
    this.interval = null;
    this.broadcastFn = broadcastFn;
    this.ownerId = null;
    this.interruptingPlayers = []; // Queue of player IDs currently interrupting

    // Default settings - subclasses can extend
    this.settings = {
      initialTime: settings.initialTime || CONSTANTS.DEFAULT_INITIAL_TIME,
      playerCount: settings.playerCount || CONSTANTS.MIN_PLAYERS,
      warningThresholds: settings.warningThresholds || [300000, 60000, 30000],
      penaltyType: settings.penaltyType || "warning",
      penaltyTimeDeduction: settings.penaltyTimeDeduction || 0,
      audioEnabled: true,
      ...settings,
    };

    this.initPlayers();
  }

  // ============================================================================
  // ABSTRACT METHODS - Must be implemented by subclasses
  // ============================================================================

  /**
   * Get the mode-specific name for display
   * @returns {string}
   */
  getModeName() {
    throw new Error("Subclass must implement getModeName()");
  }

  /**
   * Handle mode-specific game completion logic
   * Called when game ends (time out, all but one eliminated, etc.)
   * @param {object} result - Game result data
   */
  onGameComplete(result) {
    // Override in subclasses for mode-specific completion handling
  }

  /**
   * Get mode-specific state to include in serialization
   * @returns {object}
   */
  getModeState() {
    return {};
  }

  /**
   * Restore mode-specific state from persistence
   * @param {object} state - Persisted state
   */
  restoreModeState(state) {
    // Override in subclasses
  }

  // ============================================================================
  // PLAYER MANAGEMENT
  // ============================================================================

  /**
   * Initialize players based on settings
   */
  initPlayers() {
    this.players = [];
    for (let i = 1; i <= this.settings.playerCount; i++) {
      this.players.push(this.createPlayer(i));
    }
  }

  /**
   * Create a player object - can be overridden for mode-specific player data
   * @param {number} id - Player ID
   * @returns {object} Player object
   */
  createPlayer(id) {
    return {
      id,
      name: `Player ${id}`,
      timeRemaining: this.settings.initialTime,
      penalties: 0,
      isEliminated: false,
      claimedBy: null,
      reconnectToken: null,
      tokenExpiry: null,
      life: 20,
      drunkCounter: 0,
      genericCounter: 0,
      color: null, // Custom color ID, null means use default based on player ID
    };
  }

  /**
   * Set the game owner
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
   * Check if a client owns a specific player
   * @param {number} playerId - Player ID
   * @param {string} clientId - Client ID
   * @returns {boolean}
   */
  isPlayerOwner(playerId, clientId) {
    const player = this.players.find(p => p.id === playerId);
    return player ? player.claimedBy === clientId : false;
  }

  /**
   * Check if a client has any claimed player
   * @param {string} clientId - Client ID
   * @returns {boolean}
   */
  hasClaimedPlayer(clientId) {
    return this.players.some(p => p.claimedBy === clientId);
  }

  /**
   * Check if a client can modify a player
   * @param {number} playerId - Player ID
   * @param {string} clientId - Client ID
   * @returns {boolean}
   */
  canModifyPlayer(playerId, clientId) {
    return this.isOwner(clientId) || this.isPlayerOwner(playerId, clientId);
  }

  /**
   * Check if a client can control the game
   * @param {string} clientId - Client ID
   * @returns {boolean}
   */
  canControlGame(clientId) {
    return this.isOwner(clientId) || this.hasClaimedPlayer(clientId);
  }

  /**
   * Check if a client can switch to a player
   * @param {number} targetPlayerId - Target player ID
   * @param {string} clientId - Client ID
   * @returns {boolean}
   */
  canSwitchPlayer(targetPlayerId, clientId) {
    if (this.status === "waiting") return true;
    if (this.isOwner(clientId)) return true;

    const activePlayer = this.players.find(p => p.id === this.activePlayer);
    return activePlayer && activePlayer.claimedBy === clientId;
  }

  /**
   * Generate a secure reconnection token
   * @returns {string}
   */
  generateReconnectToken() {
    return crypto.randomBytes(32).toString("hex");
  }

  /**
   * Claim a player slot
   * @param {number} playerId - Player ID
   * @param {string} clientId - Client ID
   * @returns {{ success: boolean, token?: string, reason?: string }}
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

    // Unclaim previous player
    this.players.forEach(p => {
      if (p.claimedBy === clientId) {
        p.claimedBy = null;
        p.reconnectToken = null;
        p.tokenExpiry = null;
      }
    });

    const token = this.generateReconnectToken();
    player.claimedBy = clientId;
    player.reconnectToken = token;
    player.tokenExpiry = Date.now() + CONSTANTS.RECONNECT_TOKEN_EXPIRY;

    this.broadcastState();
    return { success: true, token };
  }

  /**
   * Reconnect a player using a token
   * @param {number} playerId - Player ID
   * @param {string} token - Reconnection token
   * @param {string} newClientId - New client ID
   * @returns {{ success: boolean, token?: string, reason?: string }}
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
      player.reconnectToken = null;
      player.tokenExpiry = null;
      return { success: false, reason: "Token expired" };
    }

    player.claimedBy = newClientId;
    const newToken = this.generateReconnectToken();
    player.reconnectToken = newToken;
    player.tokenExpiry = Date.now() + CONSTANTS.RECONNECT_TOKEN_EXPIRY;

    this.broadcastState();
    return { success: true, token: newToken };
  }

  /**
   * Unclaim all players for a client
   * @param {string} clientId - Client ID
   */
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

  /**
   * Handle client disconnect
   * @param {string} clientId - Client ID
   */
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

  // ============================================================================
  // GAME CONTROL
  // ============================================================================

  /**
   * Start the game
   */
  start() {
    if (this.status === "waiting" || this.status === "paused") {
      this.status = "running";
      this.lastTick = Date.now();
      this.activePlayer = this.activePlayer || 1;
      this.interval = setInterval(() => this.tick(), CONSTANTS.TICK_INTERVAL);
      this.broadcastState();
    }
  }

  /**
   * Pause the game
   */
  pause() {
    if (this.status === "running") {
      this.status = "paused";
      clearInterval(this.interval);
      this.broadcastState();
    }
  }

  /**
   * Resume the game
   */
  resume() {
    if (this.status === "paused") {
      this.start();
    }
  }

  /**
   * Timer tick - decrement active player's time
   */
  tick() {
    if (this.status !== "running") return;

    const now = Date.now();
    const elapsed = now - this.lastTick;
    this.lastTick = now;

    if (this.interruptingPlayers.length > 0) {
      const currentInterruptingPlayerId =
        this.interruptingPlayers[this.interruptingPlayers.length - 1];
      const interruptingPlayer = this.players.find(p => p.id === currentInterruptingPlayerId);
      if (interruptingPlayer && !interruptingPlayer.isEliminated) {
        interruptingPlayer.timeRemaining -= elapsed;

        if (interruptingPlayer.timeRemaining <= 0) {
          interruptingPlayer.timeRemaining = 0;
          this.handleTimeout(interruptingPlayer);
        } else {
          this.checkWarnings(interruptingPlayer);
        }

        this.broadcastTimes();
      }
    } else {
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
  }

  /**
   * Handle player timeout
   * @param {object} player - Player who timed out
   */
  handleTimeout(player) {
    this.pause();
    player.penalties++;
    this.broadcastTimeout(player.id);
    // Eliminate player when time runs out
    player.isEliminated = true;
    this.switchToNextAlivePlayer();
    this.broadcastState();
  }

  /**
   * Switch to next non-eliminated player if current active player is eliminated
   */
  switchToNextAlivePlayer() {
    const currentPlayer = this.players.find(p => p.id === this.activePlayer);
    if (currentPlayer && currentPlayer.isEliminated) {
      const nextPlayer = this.players.find(p => !p.isEliminated);
      if (nextPlayer) {
        this.activePlayer = nextPlayer.id;
      }
    }
  }

  /**
   * Apply penalty to player
   * @param {object} player - Player to penalize
   */
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

  /**
   * Check and trigger time warnings
   * @param {object} player - Player to check
   */
  checkWarnings(player) {
    this.settings.warningThresholds.forEach(threshold => {
      const crossedThreshold =
        player.timeRemaining > threshold &&
        player.timeRemaining - CONSTANTS.WARNING_TICK_DELTA <= threshold;
      if (crossedThreshold) {
        this.broadcastWarning(player.id, threshold);
      }
    });
  }

  /**
   * Switch active player
   * @param {number} playerId - Player ID to switch to
   */
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

  /**
   * Reset the game
   */
  reset() {
    this.pause();
    this.status = "waiting";
    this.activePlayer = null;
    this.interruptingPlayers = [];
    this.initPlayers();
    this.broadcastState();
  }

  interrupt(playerId) {
    const player = this.players.find(p => p.id === playerId);
    if (!player || player.isEliminated) return;

    if (!this.interruptingPlayers.includes(playerId)) {
      this.interruptingPlayers.push(playerId);
      this.broadcastState();
    }
  }

  passPriority(playerId) {
    const index = this.interruptingPlayers.indexOf(playerId);
    if (index !== -1) {
      this.interruptingPlayers.splice(index, 1);
      this.broadcastState();
    }
  }

  updatePlayer(playerId, updates) {
    const player = this.players.find(p => p.id === playerId);
    if (player) {
      if (updates.name !== undefined) player.name = updates.name;
      if (updates.time !== undefined) player.timeRemaining = updates.time;
      if (updates.life !== undefined) player.life = updates.life;
      if (updates.drunkCounter !== undefined) player.drunkCounter = updates.drunkCounter;
      if (updates.genericCounter !== undefined) player.genericCounter = updates.genericCounter;
      if (updates.color !== undefined) player.color = updates.color;

      // Eliminate player if life reaches 0 or below
      if (player.life <= 0 && !player.isEliminated) {
        player.isEliminated = true;
        this.switchToNextAlivePlayer();
      }

      this.broadcastState();
    }
  }

  /**
   * Add penalty to player
   * @param {number} playerId - Player ID
   */
  addPenalty(playerId) {
    const player = this.players.find(p => p.id === playerId);
    if (player) {
      player.penalties++;
      this.applyPenalty(player);
      this.broadcastState();
    }
  }

  /**
   * Eliminate a player
   * @param {number} playerId - Player ID
   */
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

  // ============================================================================
  // BROADCASTING
  // ============================================================================

  /**
   * Broadcast full state to clients
   */
  broadcastState() {
    if (this.broadcastFn) {
      this.broadcastFn("state", this.getState());
    }
    this.lastActivity = Date.now();
  }

  /**
   * Broadcast time updates
   */
  broadcastTimes() {
    if (this.broadcastFn) {
      const times = {};
      this.players.forEach(p => {
        times[p.id] = p.timeRemaining;
      });
      this.broadcastFn("tick", { times });
    }
  }

  /**
   * Broadcast timeout event
   * @param {number} playerId - Player ID
   */
  broadcastTimeout(playerId) {
    if (this.broadcastFn) {
      this.broadcastFn("timeout", { playerId });
    }
  }

  /**
   * Broadcast warning event
   * @param {number} playerId - Player ID
   * @param {number} threshold - Threshold crossed
   */
  broadcastWarning(playerId, threshold) {
    if (this.broadcastFn) {
      this.broadcastFn("warning", { playerId, threshold });
    }
  }

  // ============================================================================
  // SERIALIZATION
  // ============================================================================

  /**
   * Get public state for broadcasting (excludes sensitive data)
   * @returns {object}
   */
  getState() {
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
      color: p.color,
    }));

    return {
      id: this.id,
      name: this.name,
      mode: this.mode,
      players: publicPlayers,
      activePlayer: this.activePlayer,
      status: this.status,
      createdAt: this.createdAt,
      settings: this.settings,
      ownerId: this.ownerId,
      interruptingPlayers: this.interruptingPlayers,
      ...this.getModeState(),
    };
  }

  /**
   * Serialize for persistence (includes all data)
   * @returns {object}
   */
  toJSON() {
    return {
      id: this.id,
      mode: this.mode,
      players: this.players,
      activePlayer: this.activePlayer,
      status: this.status,
      createdAt: this.createdAt,
      lastActivity: this.lastActivity,
      settings: this.settings,
      ownerId: this.ownerId,
      interruptingPlayers: this.interruptingPlayers,
      ...this.getModeState(),
    };
  }

  /**
   * Restore from persisted state
   * @param {object} state - Persisted state
   * @param {function} broadcastFn - Broadcast function
   * @returns {BaseGameSession}
   */
  static fromState(state, broadcastFn = null) {
    // Validate required fields
    if (!state || !state.id) {
      throw new Error("Invalid state: missing required fields");
    }

    const session = new this(state.id, state.settings, broadcastFn);
    session.mode = state.mode || "base";
    session.players = Array.isArray(state.players) ? state.players : [];
    session.activePlayer = state.activePlayer;
    session.status = state.status === "running" ? "paused" : state.status || "waiting";
    session.createdAt = state.createdAt || Date.now();
    session.lastActivity = state.lastActivity || Date.now();
    session.ownerId = state.ownerId || null;
    session.interruptingPlayers = Array.isArray(state.interruptingPlayers)
      ? state.interruptingPlayers
      : [];
    session.restoreModeState(state);
    return session;
  }

  /**
   * Cleanup resources
   */
  cleanup() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}

module.exports = { BaseGameSession };
