/**
 * Base Game Mode Interface
 *
 * Abstract base class defining the contract for all game modes.
 * Extend this class to implement new game modes (casual, campaign, tournament, etc.)
 */

const crypto = require("crypto");
const { CONSTANTS, TARGETING } = require("../shared/constants");

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
    this.isClosed = false; // Whether lobby has been closed (persists but won't load on restart)
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.lastTick = null;
    this.interval = null;
    this.broadcastFn = broadcastFn;
    this.ownerId = null;
    this.interruptingPlayers = []; // Queue of player IDs currently interrupting

    // Targeting state
    this.targetingState = TARGETING.STATES.NONE;
    this.targetedPlayers = [];
    this.awaitingPriority = [];
    this.originalActivePlayer = null;

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
   * @param {number} playerId - Player ID to modify
   * @param {string} clientId - Client attempting modification
   * @returns {boolean} Whether modification is allowed
   */
  canModifyPlayer(playerId, clientId) {
    // Game owner can always modify any player
    if (this.isOwner(clientId)) {
      return true;
    }

    const player = this.players.find(p => p.id === playerId);
    if (!player) {
      return false;
    }

    // Player can modify their own claimed player
    if (player.claimedBy === clientId) {
      return true;
    }

    // In waiting state, anyone can modify unclaimed players
    // This allows renaming before claiming
    if (this.status === "waiting" && !player.claimedBy) {
      return true;
    }

    return false;
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
   * Close the lobby (marks as closed, won't be restored on server restart)
   */
  close() {
    this.pause();
    this.isClosed = true;
    this.status = "finished";
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
          this.checkWarnings(interruptingPlayer, elapsed);
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
          this.checkWarnings(activePlayer, elapsed);
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
    player.penalties++;
    this.broadcastTimeout(player.id);
    // Eliminate player when time runs out
    player.isEliminated = true;

    // Check if this is a targeted player during targeting resolution
    if (this.targetingState === TARGETING.STATES.RESOLVING) {
      // Handle the eliminated target - auto-pass their priority
      this.handleEliminatedTarget(player.id);
      // Don't pause the game - targeting continues
      this.broadcastState();
      return;
    }

    // Normal timeout handling - pause the game
    this.pause();
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
   * @param {number} elapsed - Time elapsed since last tick (ms)
   */
  checkWarnings(player, elapsed = CONSTANTS.TICK_INTERVAL) {
    this.settings.warningThresholds.forEach(threshold => {
      const previousTime = player.timeRemaining + elapsed;
      const crossedThreshold = previousTime > threshold && player.timeRemaining <= threshold;
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
    // Reset targeting state
    this.targetingState = TARGETING.STATES.NONE;
    this.targetedPlayers = [];
    this.awaitingPriority = [];
    this.originalActivePlayer = null;
    this.initPlayers();
    this.broadcastState();
  }

  interrupt(playerId) {
    const player = this.players.find(p => p.id === playerId);
    if (!player || player.isEliminated) return;

    // Add player to end of queue (allows multiple instances of same player)
    this.interruptingPlayers.push(playerId);
    this.broadcastState();
  }

  passPriority(playerId) {
    // Find last occurrence of player in queue (the one with priority)
    let lastIndex = -1;
    for (let i = this.interruptingPlayers.length - 1; i >= 0; i--) {
      if (this.interruptingPlayers[i] === playerId) {
        lastIndex = i;
        break;
      }
    }

    if (lastIndex !== -1) {
      this.interruptingPlayers.splice(lastIndex, 1);
      this.broadcastState();
    }
  }

  // ============================================================================
  // TARGETING SYSTEM
  // ============================================================================

  /**
   * Start target selection mode
   * @returns {boolean} Success
   */
  startTargetSelection() {
    if (this.status !== 'running') return false;
    if (this.targetingState !== TARGETING.STATES.NONE) return false;

    this.targetingState = TARGETING.STATES.SELECTING;
    this.targetedPlayers = [];
    return true;
  }

  /**
   * Toggle a player as target
   * @param {number} playerId - Player ID to toggle
   * @returns {boolean} Success
   */
  toggleTarget(playerId) {
    if (this.targetingState !== TARGETING.STATES.SELECTING) return false;
    if (playerId === this.activePlayer) return false; // Can't target self

    const player = this.players.find(p => p.id === playerId);
    if (!player || player.isEliminated) return false;

    const idx = this.targetedPlayers.indexOf(playerId);
    if (idx === -1) {
      this.targetedPlayers.push(playerId);
    } else {
      this.targetedPlayers.splice(idx, 1);
    }

    return true;
  }

  /**
   * Confirm targets and begin resolution
   * @returns {boolean} Success
   */
  confirmTargets() {
    if (this.targetingState !== TARGETING.STATES.SELECTING) return false;
    if (this.targetedPlayers.length === 0) return false;

    // Store original player
    this.originalActivePlayer = this.activePlayer;

    // Set up priority queue
    this.awaitingPriority = [...this.targetedPlayers];
    this.targetingState = TARGETING.STATES.RESOLVING;

    // First target becomes active
    this.activePlayer = this.awaitingPriority[0];

    return true;
  }

  /**
   * Targeted player passes priority
   * @param {number} playerId - Player ID passing priority
   * @returns {boolean} Success
   */
  passTargetPriority(playerId) {
    if (this.targetingState !== TARGETING.STATES.RESOLVING) return false;

    const idx = this.awaitingPriority.indexOf(playerId);
    if (idx === -1) return false;

    // Remove from awaiting list
    this.awaitingPriority.splice(idx, 1);

    if (this.awaitingPriority.length === 0) {
      // All targets have passed - return to original player
      return this.completeTargeting();
    } else {
      // Move to next target
      this.activePlayer = this.awaitingPriority[0];
      return true;
    }
  }

  /**
   * Complete targeting and return to normal
   * @returns {boolean} Success
   */
  completeTargeting() {
    this.activePlayer = this.originalActivePlayer;
    this.targetingState = TARGETING.STATES.NONE;
    this.targetedPlayers = [];
    this.awaitingPriority = [];
    this.originalActivePlayer = null;
    return true;
  }

  /**
   * Cancel targeting (return to normal without completing)
   * @returns {boolean} Success
   */
  cancelTargeting() {
    if (this.targetingState === TARGETING.STATES.NONE) return false;

    // If we were resolving, return to original player
    if (this.originalActivePlayer !== null) {
      this.activePlayer = this.originalActivePlayer;
    }

    this.targetingState = TARGETING.STATES.NONE;
    this.targetedPlayers = [];
    this.awaitingPriority = [];
    this.originalActivePlayer = null;
    return true;
  }

  /**
   * Handle eliminated target during targeting resolution
   * @param {number} playerId - Player ID that was eliminated
   */
  handleEliminatedTarget(playerId) {
    if (this.targetingState !== TARGETING.STATES.RESOLVING) return;

    // Remove from targeted players list
    const targetIdx = this.targetedPlayers.indexOf(playerId);
    if (targetIdx !== -1) {
      this.targetedPlayers.splice(targetIdx, 1);
    }

    // Remove from awaiting priority list
    const awaitingIdx = this.awaitingPriority.indexOf(playerId);
    if (awaitingIdx !== -1) {
      this.awaitingPriority.splice(awaitingIdx, 1);
    }

    // Check if targeting is complete (no more targets)
    if (this.awaitingPriority.length === 0) {
      this.completeTargeting();
    } else if (this.activePlayer === playerId) {
      // If the eliminated player was the active target, move to next
      this.activePlayer = this.awaitingPriority[0];
    }
  }

  /**
   * Check if a player is currently a target
   * @param {number} playerId - Player ID
   * @returns {boolean}
   */
  isTargeted(playerId) {
    return this.targetedPlayers.includes(playerId);
  }

  /**
   * Check if a player is awaiting priority
   * @param {number} playerId - Player ID
   * @returns {boolean}
   */
  isAwaitingTargetPriority(playerId) {
    return this.awaitingPriority.includes(playerId);
  }

  updatePlayer(playerId, updates) {
    const player = this.players.find(p => p.id === playerId);
    if (player) {
      if (updates.name !== undefined) player.name = updates.name;
      if (updates.time !== undefined) player.timeRemaining = updates.time;
      if (updates.life !== undefined) {
        player.life = Math.max(
          CONSTANTS.MIN_LIFE,
          Math.min(CONSTANTS.MAX_LIFE, updates.life)
        );
      }
      if (updates.drunkCounter !== undefined) {
        player.drunkCounter = Math.max(
          CONSTANTS.MIN_COUNTER,
          Math.min(CONSTANTS.MAX_COUNTER, updates.drunkCounter)
        );
      }
      if (updates.genericCounter !== undefined) {
        player.genericCounter = Math.max(
          CONSTANTS.MIN_COUNTER,
          Math.min(CONSTANTS.MAX_COUNTER, updates.genericCounter)
        );
      }
      if (updates.color !== undefined) player.color = updates.color;

      // Eliminate player if life reaches 0 or below
      if (player.life <= 0 && !player.isEliminated) {
        player.isEliminated = true;
        // Handle elimination during targeting
        if (this.targetingState === TARGETING.STATES.RESOLVING) {
          this.handleEliminatedTarget(playerId);
        } else {
          this.switchToNextAlivePlayer();
        }
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

      // Handle elimination during targeting
      if (this.targetingState === TARGETING.STATES.RESOLVING) {
        this.handleEliminatedTarget(playerId);
      } else if (this.activePlayer === playerId) {
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
      targetingState: this.targetingState,
      targetedPlayers: this.targetedPlayers,
      awaitingPriority: this.awaitingPriority,
      originalActivePlayer: this.originalActivePlayer,
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
      mode: this.mode || "base",
      name: this.name || "Game",
      // Deep copy players array to avoid reference issues
      players: this.players.map(p => ({
        id: p.id,
        name: p.name,
        timeRemaining: p.timeRemaining,
        life: p.life,
        drunkCounter: p.drunkCounter,
        genericCounter: p.genericCounter,
        isEliminated: p.isEliminated,
        claimedBy: p.claimedBy,
        reconnectToken: p.reconnectToken,
        color: p.color,
      })),
      activePlayer: this.activePlayer,
      status: this.status || "waiting",
      isClosed: this.isClosed || false, // Explicitly default to false
      createdAt: this.createdAt || Date.now(),
      lastActivity: this.lastActivity || Date.now(),
      settings: { ...this.settings }, // Copy settings object
      ownerId: this.ownerId,
      // Copy arrays to avoid reference issues
      interruptingPlayers: [...(this.interruptingPlayers || [])],
      targetingState: this.targetingState || TARGETING.STATES.NONE,
      targetedPlayers: [...(this.targetedPlayers || [])],
      awaitingPriority: [...(this.awaitingPriority || [])],
      originalActivePlayer: this.originalActivePlayer ?? null,
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
    session.name = state.name || "Game";
    // Restore players with proper defaults for each field
    session.players = Array.isArray(state.players)
      ? state.players.map(p => ({
          id: p.id,
          name: p.name || `Player ${p.id}`,
          timeRemaining: p.timeRemaining ?? session.settings.initialTime,
          life: p.life ?? 40,
          drunkCounter: p.drunkCounter ?? 0,
          genericCounter: p.genericCounter ?? 0,
          isEliminated: p.isEliminated || false,
          claimedBy: p.claimedBy || null,
          reconnectToken: p.reconnectToken || null,
          color: p.color || null,
        }))
      : [];
    session.activePlayer = state.activePlayer;
    // Running games should be paused on restore
    session.status = state.status === "running" ? "paused" : state.status || "waiting";
    session.isClosed = state.isClosed || false;
    session.createdAt = state.createdAt || Date.now();
    session.lastActivity = state.lastActivity || Date.now();
    session.ownerId = state.ownerId || null;
    session.interruptingPlayers = Array.isArray(state.interruptingPlayers)
      ? [...state.interruptingPlayers]
      : [];
    // Restore targeting state with proper defaults
    session.targetingState = state.targetingState || TARGETING.STATES.NONE;
    session.targetedPlayers = Array.isArray(state.targetedPlayers)
      ? [...state.targetedPlayers]
      : [];
    session.awaitingPriority = Array.isArray(state.awaitingPriority)
      ? [...state.awaitingPriority]
      : [];
    session.originalActivePlayer = state.originalActivePlayer ?? null;
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
