/**
 * Game Logic Module
 *
 * Re-exports game logic components for backward compatibility.
 * New code should import directly from lib/game-modes and lib/shared.
 */

// Re-export from shared constants
const { CONSTANTS } = require("./shared/constants");

// Re-export from shared validators
const {
  validateSettings,
  validatePlayerName,
  validateWarningThresholds,
  validateTimeValue,
  sanitizeString,
  generateGameId,
} = require("./shared/validators");

// Re-export from game modes - use CasualGameSession as default GameSession
const { CasualGameSession, BaseGameSession } = require("./game-modes");

// Alias for backward compatibility
const GameSession = CasualGameSession;

module.exports = {
  CONSTANTS,
  GameSession,
  BaseGameSession,
  CasualGameSession,
  validateSettings,
  validatePlayerName,
  validateWarningThresholds,
  validateTimeValue,
  sanitizeString,
  generateGameId,
};
