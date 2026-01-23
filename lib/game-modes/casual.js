/**
 * Casual Game Mode
 *
 * Standard single-game mode with timer and turn tracking.
 * This is the original game mode - a single match with no persistence between games.
 */

const { BaseGameSession } = require("./base");

class CasualGameSession extends BaseGameSession {
  constructor(id, settings = {}, broadcastFn = null) {
    super(id, settings, broadcastFn);
    this.mode = "casual";
  }

  /**
   * Get display name for this mode
   * @returns {string}
   */
  getModeName() {
    return "Casual";
  }

  /**
   * Handle game completion
   * For casual mode, we just record the winner if any
   * @param {object} result - Game result data
   */
  onGameComplete(result) {
    // Casual games don't persist results beyond the session
    // Could emit an event or log for analytics
  }

  /**
   * Get mode-specific state (none for casual)
   * @returns {object}
   */
  getModeState() {
    return {
      // Casual mode has no additional state
    };
  }

  /**
   * Restore mode-specific state (none for casual)
   * @param {object} state - Persisted state
   */
  restoreModeState(state) {
    // Nothing to restore for casual mode
  }

  /**
   * Create session from persisted state
   * @param {object} state - Persisted state
   * @param {function} broadcastFn - Broadcast function
   * @returns {CasualGameSession}
   */
  static fromState(state, broadcastFn = null) {
    const session = new CasualGameSession(state.id, state.settings, broadcastFn);
    session.players = state.players;
    session.activePlayer = state.activePlayer;
    session.status = state.status === "running" ? "paused" : state.status;
    session.createdAt = state.createdAt;
    session.lastActivity = state.lastActivity || Date.now();
    session.ownerId = state.ownerId || null;
    return session;
  }
}

module.exports = { CasualGameSession };
