/**
 * Client-side utility functions for the game timer.
 * These are extracted for testability and can be used in both browser and Node.js.
 */

const CONSTANTS = {
  RECONNECT_INITIAL_DELAY: 1000,
  RECONNECT_MAX_DELAY: 30000,
  TIME_ADJUSTMENT_MINUTES: 1,
  TIME_ADJUSTMENT_MS: 60000,
  WARNING_THRESHOLD_5MIN: 300000,
  WARNING_THRESHOLD_1MIN: 60000,
  CRITICAL_THRESHOLD: 60000,
  MINUTE_MS: 60000,
};

/**
 * Format milliseconds to MM:SS format
 * @param {number} milliseconds - Time in milliseconds
 * @returns {string} Formatted time string
 */
function formatTime(milliseconds) {
  if (milliseconds <= 0) return "0:00";

  const totalSeconds = Math.ceil(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * Format milliseconds to MM:SS.D format (with deciseconds)
 * @param {number} milliseconds - Time in milliseconds
 * @returns {string} Formatted time string with deciseconds
 */
function formatTimeWithDeciseconds(milliseconds) {
  if (milliseconds <= 0) return "0:00.0";

  const totalSeconds = milliseconds / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const deciseconds = Math.floor((milliseconds % 1000) / 100);

  return `${minutes}:${seconds.toString().padStart(2, "0")}.${deciseconds}`;
}

/**
 * Calculate reconnect delay with exponential backoff
 * @param {number} attempts - Number of reconnection attempts
 * @returns {number} Delay in milliseconds
 */
function calculateReconnectDelay(attempts) {
  return Math.min(
    CONSTANTS.RECONNECT_INITIAL_DELAY * Math.pow(2, attempts),
    CONSTANTS.RECONNECT_MAX_DELAY
  );
}

/**
 * Find the next active (non-eliminated) player
 * @param {Array} players - Array of player objects
 * @param {number} currentActiveId - Current active player ID
 * @returns {Object|null} Next player object or null if none found
 */
function findNextActivePlayer(players, currentActiveId) {
  if (!players || players.length <= 1) return null;

  const activeIndex = players.findIndex(p => p.id === currentActiveId);
  if (activeIndex === -1) return null;

  let offset = 1;
  while (offset < players.length) {
    const nextIndex = (activeIndex + offset) % players.length;
    const nextPlayer = players[nextIndex];
    if (!nextPlayer.isEliminated) {
      return nextPlayer;
    }
    offset++;
  }

  return null;
}

/**
 * Determine if a player's time is in warning state
 * @param {number} timeRemaining - Time remaining in milliseconds
 * @returns {string|null} Warning level: 'critical', 'warning', or null
 */
function getTimeWarningLevel(timeRemaining) {
  if (timeRemaining < CONSTANTS.CRITICAL_THRESHOLD) {
    return "critical";
  } else if (timeRemaining < CONSTANTS.WARNING_THRESHOLD_5MIN) {
    return "warning";
  }
  return null;
}

/**
 * Parse warning thresholds from comma-separated string
 * @param {string} input - Comma-separated threshold values in minutes
 * @returns {number[]} Array of threshold values in milliseconds
 */
function parseWarningThresholds(input) {
  if (typeof input !== "string") return [];

  return input
    .split(",")
    .map(t => {
      const minutes = parseFloat(t.trim());
      return Math.round(minutes * 60 * 1000);
    })
    .filter(t => t > 0 && Number.isFinite(t));
}

// Export for Node.js (CommonJS)
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    CONSTANTS,
    formatTime,
    formatTimeWithDeciseconds,
    calculateReconnectDelay,
    findNextActivePlayer,
    getTimeWarningLevel,
    parseWarningThresholds,
  };
}
