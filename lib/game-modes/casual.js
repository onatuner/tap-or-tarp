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

}

module.exports = { CasualGameSession };
