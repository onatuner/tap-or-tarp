/**
 * Campaign Game Mode
 *
 * Multi-game campaign mode with persistent progress tracking.
 * Players progress through a series of games, with cumulative stats
 * and progression mechanics.
 */

const { BaseGameSession } = require("./base");

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

    // Initialize player stats
    for (let i = 1; i <= playerCount; i++) {
      this.playerStats[i] = {
        wins: 0,
        losses: 0,
        totalTimeUsed: 0,
        penalties: 0,
        eliminations: 0,
      };
    }
  }

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
    return {
      preset: this.preset,
      config: this.config,
      currentRound: this.currentRound,
      maxRounds: this.maxRounds,
      playerStats: this.playerStats,
      roundHistory: this.roundHistory,
      campaignStatus: this.campaignStatus,
      winner: this.winner,
      startedAt: this.startedAt,
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
    return {
      ...baseState,
      campaign: {
        currentRound: this.campaign.currentRound,
        maxRounds: this.campaign.maxRounds,
        playerStats: this.campaign.playerStats,
        config: this.campaign.config,
        status: this.campaign.campaignStatus,
      },
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
