/**
 * Shared validation functions used across server and client.
 * Provides consistent validation logic for game inputs.
 */

const { CONSTANTS } = require("./constants");

/**
 * Validate game settings object
 * @param {object} settings - Settings object to validate
 * @returns {boolean} True if valid
 */
function validateSettings(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return false;
  }

  if (settings.playerCount !== undefined) {
    const count = Number(settings.playerCount);
    if (
      !Number.isInteger(count) ||
      count < CONSTANTS.MIN_PLAYERS ||
      count > CONSTANTS.MAX_PLAYERS
    ) {
      return false;
    }
  }

  if (settings.initialTime !== undefined) {
    const time = Number(settings.initialTime);
    if (!Number.isInteger(time) || time <= 0 || time > CONSTANTS.MAX_INITIAL_TIME) {
      return false;
    }
  }

  return true;
}

/**
 * Validate player name
 * @param {string} name - Player name to validate
 * @returns {boolean} True if valid
 */
function validatePlayerName(name) {
  if (typeof name !== "string") return false;
  if (name.length > CONSTANTS.MAX_PLAYER_NAME_LENGTH) return false;
  return true;
}

/**
 * Validate warning thresholds array
 * @param {number[]} thresholds - Array of threshold values in milliseconds
 * @returns {boolean} True if valid
 */
function validateWarningThresholds(thresholds) {
  if (!Array.isArray(thresholds)) return false;
  if (thresholds.length === 0 || thresholds.length > 10) return false;
  return thresholds.every(
    t => typeof t === "number" && Number.isFinite(t) && t > 0 && t <= CONSTANTS.MAX_INITIAL_TIME
  );
}

/**
 * Validate a time value in milliseconds
 * @param {number} time - Time value to validate
 * @returns {boolean} True if valid
 */
function validateTimeValue(time) {
  if (typeof time !== "number") return false;
  if (!Number.isFinite(time)) return false;
  if (time < 0 || time > CONSTANTS.MAX_INITIAL_TIME) return false;
  return true;
}

/**
 * Validate player ID
 * @param {number} playerId - Player ID to validate
 * @returns {boolean} True if valid
 */
function validatePlayerId(playerId) {
  if (playerId === undefined || playerId === null) return false;
  const id = Number(playerId);
  return Number.isInteger(id) && id >= 1 && id <= CONSTANTS.MAX_PLAYERS;
}

/**
 * Validate game ID format (6 alphanumeric characters)
 * @param {string} gameId - Game ID to validate
 * @returns {boolean} True if valid
 */
function validateGameId(gameId) {
  if (typeof gameId !== "string") return false;
  return /^[A-Z0-9]{6}$/.test(gameId);
}

/**
 * Sanitize a string to prevent XSS attacks
 * Uses HTML entity encoding for dangerous characters only
 * Preserves Unicode characters (emojis, international text)
 * @param {string} str - String to sanitize
 * @returns {string} Sanitized string with dangerous characters encoded
 */
function sanitizeString(str) {
  if (typeof str !== "string") return str;
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Generate a unique game ID
 * @param {Set<string>} existingIds - Set of existing IDs to avoid collisions
 * @returns {string} 6-character game ID
 */
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

  // Fallback: use timestamp-based ID
  return Date.now().toString(36).toUpperCase().slice(-6);
}

module.exports = {
  validateSettings,
  validatePlayerName,
  validateWarningThresholds,
  validateTimeValue,
  validatePlayerId,
  validateGameId,
  sanitizeString,
  generateGameId,
};
