/**
 * Game Modes Registry
 *
 * Central registry for all game modes. Add new modes here to make them
 * available throughout the application.
 */

const { BaseGameSession } = require("./base");
const { CasualGameSession } = require("./casual");
const { CampaignGameSession, CampaignState, CAMPAIGN_PRESETS } = require("./campaign");

/**
 * Registry of available game modes
 */
const GAME_MODES = {
  casual: {
    id: "casual",
    name: "Casual",
    description: "Single game with no persistence",
    SessionClass: CasualGameSession,
  },
  campaign: {
    id: "campaign",
    name: "Campaign",
    description: "Multi-game campaign with progress tracking",
    SessionClass: CampaignGameSession,
  },
};

/**
 * Create a game session of the specified mode
 * @param {string} mode - Game mode ID ('casual', 'campaign', etc.)
 * @param {string} id - Session ID
 * @param {object} settings - Game settings
 * @param {function} broadcastFn - Broadcast function
 * @returns {BaseGameSession}
 */
function createGameSession(mode, id, settings, broadcastFn) {
  const modeConfig = GAME_MODES[mode];
  if (!modeConfig) {
    throw new Error(`Unknown game mode: ${mode}`);
  }
  return new modeConfig.SessionClass(id, settings, broadcastFn);
}

/**
 * Restore a game session from persisted state
 * @param {object} state - Persisted state
 * @param {function} broadcastFn - Broadcast function
 * @returns {BaseGameSession}
 */
function restoreGameSession(state, broadcastFn) {
  const mode = state.mode || "casual"; // Default to casual for legacy sessions
  const modeConfig = GAME_MODES[mode];

  if (!modeConfig) {
    // Fallback to casual for unknown modes
    console.warn(`Unknown mode '${mode}' in persisted state, using casual`);
    return CasualGameSession.fromState(state, broadcastFn);
  }

  return modeConfig.SessionClass.fromState(state, broadcastFn);
}

/**
 * Get list of available game modes for UI
 * @returns {Array<{ id: string, name: string, description: string }>}
 */
function getAvailableModes() {
  return Object.values(GAME_MODES).map(mode => ({
    id: mode.id,
    name: mode.name,
    description: mode.description,
  }));
}

/**
 * Check if a mode exists
 * @param {string} mode - Mode ID
 * @returns {boolean}
 */
function isValidMode(mode) {
  return mode in GAME_MODES;
}

module.exports = {
  // Classes
  BaseGameSession,
  CasualGameSession,
  CampaignGameSession,
  CampaignState,

  // Constants
  GAME_MODES,
  CAMPAIGN_PRESETS,

  // Factory functions
  createGameSession,
  restoreGameSession,
  getAvailableModes,
  isValidMode,
};
