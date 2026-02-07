/**
 * Campaign Game Mode
 *
 * Multi-game campaign mode with persistent progress tracking.
 * Players progress through a series of games, with cumulative stats
 * and progression mechanics.
 */

const { BaseGameSession } = require("./base");
const { wastelandsPreset } = require("./campaign-presets/wastelands");

/**
 * Campaign configuration presets
 */
const CAMPAIGN_PRESETS = {
  standard: {
    name: "Standard Campaign",
    description: "A balanced campaign with 5 rounds",
    rounds: 5,
    timePerRound: 10 * 60 * 1000, // 10 minutes
    timeDecreasePerRound: 60 * 1000, // 1 minute less each round
    minTime: 5 * 60 * 1000, // Minimum 5 minutes
    winCondition: "best_of", // best_of, first_to, total_time
    winTarget: 3, // Win 3 out of 5
  },
  blitz: {
    name: "Blitz Campaign",
    description: "Fast-paced campaign with short rounds",
    rounds: 7,
    timePerRound: 5 * 60 * 1000, // 5 minutes
    timeDecreasePerRound: 30 * 1000, // 30 seconds less each round
    minTime: 2 * 60 * 1000, // Minimum 2 minutes
    winCondition: "first_to",
    winTarget: 4, // First to 4 wins
  },
  endurance: {
    name: "Endurance Campaign",
    description: "Long campaign testing stamina",
    rounds: 10,
    timePerRound: 15 * 60 * 1000, // 15 minutes
    timeDecreasePerRound: 0, // No decrease
    minTime: 15 * 60 * 1000, // Same throughout
    winCondition: "total_time",
    winTarget: null, // Most time remaining wins
  },
  wastelands: wastelandsPreset,
};

/**
 * Campaign session tracking state across multiple games
 */
class CampaignState {
  constructor(preset = "standard", playerCount = 2) {
    const config = CAMPAIGN_PRESETS[preset] || CAMPAIGN_PRESETS.standard;

    this.preset = preset;
    this.config = { ...config };
    this.currentRound = 1;
    this.maxRounds = config.rounds;
    this.playerStats = {};
    this.roundHistory = [];
    this.campaignStatus = "in_progress"; // in_progress, completed
    this.winner = null;
    this.startedAt = Date.now();

    // Persistent player identity across rounds
    this.playerNames = {};    // { [playerId]: string }
    this.playerClaims = {};   // { [playerId]: clientId }

    // Scoring infrastructure
    this.damageTracker = {};  // { [playerId]: { [targetId]: totalDamage } }
    this.playerPoints = {};   // { [playerId]: number }
    this.playerLevels = {};   // { [playerId]: number }

    // Initialize player stats
    for (let i = 1; i <= playerCount; i++) {
      this.playerStats[i] = {
        wins: 0,
        losses: 0,
        totalTimeUsed: 0,
        penalties: 0,
        eliminations: 0,
        accumulatedPoints: 0,
      };
      this.damageTracker[i] = {};
      this.playerPoints[i] = 0;
      this.playerLevels[i] = 1;
    }
  }

  // ============================================================================
  // DAMAGE & SCORING
  // ============================================================================

  /**
   * Record damage dealt by one player to another
   * @param {number} attackerId - Player dealing damage
   * @param {number} targetId - Player receiving damage
   * @param {number} amount - Damage amount
   */
  recordDamage(attackerId, targetId, amount) {
    if (amount <= 0) return;
    if (!this.damageTracker[attackerId]) {
      this.damageTracker[attackerId] = {};
    }
    this.damageTracker[attackerId][targetId] =
      (this.damageTracker[attackerId][targetId] || 0) + amount;
  }

  /**
   * Get total damage dealt by a player this round
   * @param {number} playerId
   * @returns {number}
   */
  getTotalDamage(playerId) {
    const targets = this.damageTracker[playerId];
    if (!targets) return 0;
    return Object.values(targets).reduce((sum, dmg) => sum + dmg, 0);
  }

  /**
   * Get count of unique players damaged by this player
   * @param {number} playerId
   * @returns {number}
   */
  getUniqueDamagedCount(playerId) {
    const targets = this.damageTracker[playerId];
    if (!targets) return 0;
    return Object.values(targets).filter(dmg => dmg > 0).length;
  }

  /**
   * Calculate points for a player using the preset's scoring formula
   * @param {number} playerId
   * @returns {number}
   */
  calculatePoints(playerId) {
    if (this.config.scoringFormula) {
      return this.config.scoringFormula(this, playerId);
    }
    return 0;
  }

  /**
   * Calculate level from points using the preset's level thresholds
   * @param {number} points
   * @returns {number}
   */
  calculateLevel(points) {
    if (!this.config.levelThresholds) return 1;
    let level = 1;
    for (const threshold of this.config.levelThresholds) {
      if (points >= threshold) {
        level++;
      } else {
        break;
      }
    }
    return level;
  }

  /**
   * Recalculate points and levels for all players
   */
  recalculateAllScores() {
    for (const playerId of Object.keys(this.playerStats)) {
      const id = parseInt(playerId);
      this.playerPoints[id] = this.calculatePoints(id);
      this.playerLevels[id] = this.calculateLevel(this.playerPoints[id]);
    }
  }

  /**
   * Finalize scoring for the current round.
   * Saves accumulated points and resets damage tracker for next round.
   */
  finalizeRoundScoring() {
    this.recalculateAllScores();
    for (const playerId of Object.keys(this.playerStats)) {
      const id = parseInt(playerId);
      this.playerStats[id].accumulatedPoints = this.playerPoints[id];
    }
    // Reset damage tracker for next round
    for (const playerId of Object.keys(this.damageTracker)) {
      this.damageTracker[playerId] = {};
    }
  }

  // ============================================================================
  // ROUND MANAGEMENT
  // ============================================================================

  /**
   * Record a round result
   * @param {number} winnerId - Winning player ID
   * @param {object} roundData - Data from the completed round
   */
  recordRound(winnerId, roundData) {
    this.roundHistory.push({
      round: this.currentRound,
      winner: winnerId,
      data: roundData,
      timestamp: Date.now(),
    });

    // Update player stats
    for (const [playerId, stats] of Object.entries(roundData.players)) {
      const playerStats = this.playerStats[playerId];
      if (playerStats) {
        if (parseInt(playerId) === winnerId) {
          playerStats.wins++;
        } else {
          playerStats.losses++;
        }
        playerStats.totalTimeUsed += stats.timeUsed || 0;
        playerStats.penalties += stats.penalties || 0;
      }
    }
  }

  /**
   * Advance to the next round
   * @returns {boolean} True if campaign should continue
   */
  advanceRound() {
    this.currentRound++;
    return this.currentRound <= this.maxRounds && !this.checkCampaignComplete();
  }

  /**
   * Get time for current round
   * @returns {number} Time in milliseconds
   */
  getCurrentRoundTime() {
    const decrease = this.config.timeDecreasePerRound * (this.currentRound - 1);
    const time = this.config.timePerRound - decrease;
    return Math.max(time, this.config.minTime);
  }

  /**
   * Check if campaign is complete based on win condition
   * @returns {boolean}
   */
  checkCampaignComplete() {
    const config = this.config;
    const stats = Object.entries(this.playerStats);

    switch (config.winCondition) {
      case "best_of":
        // Check if anyone has enough wins to clinch
        for (const [playerId, stat] of stats) {
          if (stat.wins >= config.winTarget) {
            this.winner = parseInt(playerId);
            this.campaignStatus = "completed";
            return true;
          }
        }
        break;

      case "first_to":
        // Check if anyone reached the target
        for (const [playerId, stat] of stats) {
          if (stat.wins >= config.winTarget) {
            this.winner = parseInt(playerId);
            this.campaignStatus = "completed";
            return true;
          }
        }
        break;

      case "total_time":
        // Only complete after all rounds
        if (this.currentRound > this.maxRounds) {
          // Winner is player with least time used (most remaining)
          let minTime = Infinity;
          for (const [playerId, stat] of stats) {
            if (stat.totalTimeUsed < minTime) {
              minTime = stat.totalTimeUsed;
              this.winner = parseInt(playerId);
            }
          }
          this.campaignStatus = "completed";
          return true;
        }
        break;

      case "total_points":
        // Only complete after all rounds; winner has most accumulated points
        if (this.currentRound > this.maxRounds) {
          let maxPoints = -1;
          for (const [playerId, points] of Object.entries(this.playerPoints)) {
            if (points > maxPoints) {
              maxPoints = points;
              this.winner = parseInt(playerId);
            }
          }
          this.campaignStatus = "completed";
          return true;
        }
        break;
    }

    // Check if all rounds complete
    if (this.currentRound > this.maxRounds) {
      // Determine winner by most wins
      let maxWins = 0;
      for (const [playerId, stat] of stats) {
        if (stat.wins > maxWins) {
          maxWins = stat.wins;
          this.winner = parseInt(playerId);
        }
      }
      this.campaignStatus = "completed";
      return true;
    }

    return false;
  }

  /**
   * Serialize for persistence
   * @returns {object}
   */
  toJSON() {
    // Exclude non-serializable function references from config
    const serializableConfig = {};
    for (const [key, value] of Object.entries(this.config)) {
      if (typeof value !== "function") {
        serializableConfig[key] = value;
      }
    }
    return {
      preset: this.preset,
      config: serializableConfig,
      currentRound: this.currentRound,
      maxRounds: this.maxRounds,
      playerStats: this.playerStats,
      roundHistory: this.roundHistory,
      campaignStatus: this.campaignStatus,
      winner: this.winner,
      startedAt: this.startedAt,
      damageTracker: this.damageTracker,
      playerPoints: this.playerPoints,
      playerLevels: this.playerLevels,
      playerNames: this.playerNames,
      playerClaims: this.playerClaims,
    };
  }

  /**
   * Restore from persisted state
   * @param {object} state - Persisted state
   * @returns {CampaignState}
   */
  static fromState(state) {
    const campaign = new CampaignState(state.preset, Object.keys(state.playerStats).length);
    campaign.config = state.config;
    campaign.currentRound = state.currentRound;
    campaign.maxRounds = state.maxRounds;
    campaign.playerStats = state.playerStats;
    campaign.roundHistory = state.roundHistory;
    campaign.campaignStatus = state.campaignStatus;
    campaign.winner = state.winner;
    campaign.startedAt = state.startedAt;
    campaign.damageTracker = state.damageTracker || {};
    campaign.playerPoints = state.playerPoints || {};
    campaign.playerLevels = state.playerLevels || {};
    campaign.playerNames = state.playerNames || {};
    campaign.playerClaims = state.playerClaims || {};

    // Re-attach non-serializable functions from preset registry
    const presetConfig = CAMPAIGN_PRESETS[state.preset];
    if (presetConfig?.scoringFormula) {
      campaign.config.scoringFormula = presetConfig.scoringFormula;
    }
    if (presetConfig?.levelThresholds) {
      campaign.config.levelThresholds = presetConfig.levelThresholds;
    }

    return campaign;
  }
}

/**
 * Campaign game session - extends base with campaign tracking
 */
class CampaignGameSession extends BaseGameSession {
  constructor(id, settings = {}, broadcastFn = null) {
    // Set initial time based on campaign round
    const campaignSettings = {
      ...settings,
      initialTime: settings.initialTime || 10 * 60 * 1000,
    };

    super(id, campaignSettings, broadcastFn);
    this.mode = "campaign";

    // Initialize campaign state
    this.campaign = new CampaignState(
      settings.campaignPreset || "standard",
      settings.playerCount || 2
    );

    // Apply preset overrides
    if (this.campaign.config.bonusTime !== undefined) {
      this.settings.bonusTime = this.campaign.config.bonusTime;
    }

    // Adjust time for current round
    this.settings.initialTime = this.campaign.getCurrentRoundTime();
    this.initPlayers(); // Reinitialize with correct time
  }

  /**
   * Get display name for this mode
   * @returns {string}
   */
  getModeName() {
    return `Campaign - ${this.campaign.config.name}`;
  }

  /**
   * Override createPlayer to apply campaign-specific starting life
   */
  createPlayer(id) {
    const player = super.createPlayer(id);
    if (this.campaign?.config?.startingLife !== undefined) {
      player.life = this.campaign.config.startingLife;
    }
    return player;
  }

  /**
   * Override revivePlayer to restore campaign-specific starting life
   */
  revivePlayer(playerId) {
    super.revivePlayer(playerId);
    if (this.campaign.config.startingLife !== undefined) {
      const player = this.players.find(p => p.id === playerId);
      if (player && !player.isEliminated) {
        player.life = this.campaign.config.startingLife;
      }
    }
  }

  /**
   * Override claimPlayer to persist claims across rounds
   */
  claimPlayer(playerId, clientId) {
    const result = super.claimPlayer(playerId, clientId);
    if (result.success) {
      this.campaign.playerClaims[playerId] = clientId;
    }
    return result;
  }

  /**
   * Override updatePlayer to persist names across rounds
   */
  updatePlayer(playerId, updates) {
    super.updatePlayer(playerId, updates);
    if (updates.name !== undefined) {
      this.campaign.playerNames[playerId] = updates.name;
    }
  }

  /**
   * Track damage when a player's life decreases during gameplay.
   * Only records damage dealt by another player (not self-damage).
   */
  onPlayerLifeChanged(playerId, oldLife, newLife) {
    if (newLife >= oldLife) return; // Healing, not damage
    if (this.status !== "running") return;

    const damage = oldLife - newLife;
    const actingPlayerId = this.getActingPlayerId();

    // Skip self-damage or if no acting player
    if (!actingPlayerId || actingPlayerId === playerId) return;

    this.campaign.recordDamage(actingPlayerId, playerId, damage);
    this.campaign.recalculateAllScores();
  }

  /**
   * Handle game completion - record round and possibly advance
   * @param {object} result - Game result data
   */
  onGameComplete(result) {
    const roundData = {
      players: {},
    };

    // Collect round data
    this.players.forEach(p => {
      roundData.players[p.id] = {
        timeUsed: this.settings.initialTime - p.timeRemaining,
        penalties: p.penalties,
        isEliminated: p.isEliminated,
      };
    });

    // Finalize scoring before recording the round
    this.campaign.finalizeRoundScoring();

    // Record the round
    this.campaign.recordRound(result.winnerId, roundData);

    // Check if campaign continues
    if (this.campaign.advanceRound()) {
      // Prepare for next round
      this.prepareNextRound();
    } else {
      // Campaign complete
      this.status = "finished";
      this.broadcastCampaignComplete();
    }
  }

  /**
   * Prepare for the next round
   */
  prepareNextRound() {
    this.status = "waiting";
    this.activePlayer = null;
    this.settings.initialTime = this.campaign.getCurrentRoundTime();
    this.initPlayers();

    // Restore persistent names and claims from campaign state
    for (const player of this.players) {
      if (this.campaign.playerNames[player.id]) {
        player.name = this.campaign.playerNames[player.id];
      }
      if (this.campaign.playerClaims[player.id]) {
        player.claimedBy = this.campaign.playerClaims[player.id];
      }
    }

    this.broadcastState();
  }

  /**
   * Broadcast campaign completion
   */
  broadcastCampaignComplete() {
    if (this.broadcastFn) {
      this.broadcastFn("campaignComplete", {
        winner: this.campaign.winner,
        stats: this.campaign.playerStats,
        history: this.campaign.roundHistory,
      });
    }
  }

  /**
   * Get mode-specific state
   * @returns {object}
   */
  getModeState() {
    return {
      campaign: this.campaign.toJSON(),
    };
  }

  /**
   * Restore mode-specific state
   * @param {object} state - Persisted state
   */
  restoreModeState(state) {
    if (state.campaign) {
      this.campaign = CampaignState.fromState(state.campaign);
    }
  }

  /**
   * Override getState to include campaign info
   * @returns {object}
   */
  getState() {
    const baseState = super.getState();
    // Build displayable config (exclude function references)
    const displayConfig = {};
    for (const [key, value] of Object.entries(this.campaign.config)) {
      if (typeof value !== "function") {
        displayConfig[key] = value;
      }
    }
    const campaignObj = {
      preset: this.campaign.preset,
      currentRound: this.campaign.currentRound,
      maxRounds: this.campaign.maxRounds,
      playerStats: this.campaign.playerStats,
      config: displayConfig,
      status: this.campaign.campaignStatus,
      damageTracker: this.campaign.damageTracker,
      playerPoints: this.campaign.playerPoints,
      playerLevels: this.campaign.playerLevels,
      playerNames: this.campaign.playerNames,
    };

    if (this.campaign.config.startingHandSize !== undefined) {
      campaignObj.handSize = this.campaign.config.startingHandSize +
        (this.campaign.currentRound - 1) * (this.campaign.config.handSizeIncrement || 0);
    }

    return {
      ...baseState,
      campaign: campaignObj,
    };
  }

  /**
   * Create session from persisted state
   * @param {object} state - Persisted state
   * @param {function} broadcastFn - Broadcast function
   * @returns {CampaignGameSession}
   */
  static fromState(state, broadcastFn = null) {
    const session = new CampaignGameSession(state.id, state.settings, broadcastFn);
    session.players = state.players;
    session.activePlayer = state.activePlayer;
    session.status = state.status === "running" ? "paused" : state.status;
    session.createdAt = state.createdAt;
    session.lastActivity = state.lastActivity || Date.now();
    session.ownerId = state.ownerId || null;
    session.restoreModeState(state);
    return session;
  }
}

module.exports = {
  CampaignGameSession,
  CampaignState,
  CAMPAIGN_PRESETS,
};
