/**
 * Shared constants used across server and client.
 * Single source of truth for all game configuration values.
 */

// Game timing constants
const TICK_INTERVAL = 100; // ms between timer ticks
const DEFAULT_INITIAL_TIME = 10 * 60 * 1000; // 10 minutes in ms
const MAX_INITIAL_TIME = 24 * 60 * 60 * 1000; // 24 hours max

// Player limits
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 8;
const MAX_PLAYER_NAME_LENGTH = 50;

// Player value limits
const MIN_LIFE = -999;
const MAX_LIFE = 9999;
const MIN_COUNTER = 0;
const MAX_COUNTER = 999;

// Game settings limits
const MAX_GAME_NAME_LENGTH = 50;

// Session management
const SESSION_CLEANUP_INTERVAL = 5 * 60 * 1000; // Check for cleanup every 5 minutes
const INACTIVE_SESSION_THRESHOLD = 24 * 60 * 60 * 1000; // Remove after 24 hours inactive
const EMPTY_SESSION_THRESHOLD = 5 * 60 * 1000; // Remove empty sessions after 5 minutes

// Rate limiting
const RATE_LIMIT_WINDOW = 1000; // 1 second window
const RATE_LIMIT_MAX_MESSAGES = 20; // messages per window

// Reconnection
const RECONNECT_TOKEN_EXPIRY = 60 * 60 * 1000; // 1 hour
const RECONNECT_INITIAL_DELAY = 1000; // 1 second
const RECONNECT_MAX_DELAY = 30000; // 30 seconds

// Warning thresholds
const WARNING_TICK_DELTA = 100; // Delta for checking warning crossings
const WARNING_THRESHOLD_5MIN = 300000; // 5 minutes
const WARNING_THRESHOLD_1MIN = 60000; // 1 minute
const CRITICAL_THRESHOLD = 60000; // 1 minute (same as 1min warning for now)

// Time utilities
const MINUTE_MS = 60000;
const TIME_ADJUSTMENT_MINUTES = 1;
const TIME_ADJUSTMENT_MS = 60000;

// Token storage (client-side)
const TOKEN_STORAGE_KEY = "tapOrTarpReconnectTokens";
const TOKEN_MAX_AGE = 60 * 60 * 1000; // 1 hour

// Server constants (only used server-side but exported for reference)
const PERSISTENCE_INTERVAL = 5000; // Save active games every 5 seconds
const HEARTBEAT_INTERVAL = 30000; // Instance heartbeat every 30 seconds
const CONNECTION_DRAIN_TIMEOUT = 30000; // 30 seconds to drain on shutdown
const MAX_BUFFER_SIZE = 1024 * 1024; // 1MB max WebSocket buffer
const BUFFER_WARNING_SIZE = 512 * 1024; // 512KB warning threshold

// Aggregate exports for convenience
const CONSTANTS = {
  // Timing
  TICK_INTERVAL,
  DEFAULT_INITIAL_TIME,
  MAX_INITIAL_TIME,

  // Players
  MIN_PLAYERS,
  MAX_PLAYERS,
  MAX_PLAYER_NAME_LENGTH,
  MIN_LIFE,
  MAX_LIFE,
  MIN_COUNTER,
  MAX_COUNTER,
  MAX_GAME_NAME_LENGTH,

  // Sessions
  SESSION_CLEANUP_INTERVAL,
  INACTIVE_SESSION_THRESHOLD,
  EMPTY_SESSION_THRESHOLD,

  // Rate limiting
  RATE_LIMIT_WINDOW,
  RATE_LIMIT_MAX_MESSAGES,

  // Reconnection
  RECONNECT_TOKEN_EXPIRY,
  RECONNECT_INITIAL_DELAY,
  RECONNECT_MAX_DELAY,

  // Warnings
  WARNING_TICK_DELTA,
  WARNING_THRESHOLD_5MIN,
  WARNING_THRESHOLD_1MIN,
  CRITICAL_THRESHOLD,

  // Time utilities
  MINUTE_MS,
  TIME_ADJUSTMENT_MINUTES,
  TIME_ADJUSTMENT_MS,

  // Client storage
  TOKEN_STORAGE_KEY,
  TOKEN_MAX_AGE,

  // Server
  PERSISTENCE_INTERVAL,
  HEARTBEAT_INTERVAL,
  CONNECTION_DRAIN_TIMEOUT,
  MAX_BUFFER_SIZE,
  BUFFER_WARNING_SIZE,
};

module.exports = {
  CONSTANTS,
  // Also export individual constants for selective imports
  TICK_INTERVAL,
  DEFAULT_INITIAL_TIME,
  MAX_INITIAL_TIME,
  MIN_PLAYERS,
  MAX_PLAYERS,
  MAX_PLAYER_NAME_LENGTH,
  MIN_LIFE,
  MAX_LIFE,
  MIN_COUNTER,
  MAX_COUNTER,
  MAX_GAME_NAME_LENGTH,
  SESSION_CLEANUP_INTERVAL,
  INACTIVE_SESSION_THRESHOLD,
  EMPTY_SESSION_THRESHOLD,
  RATE_LIMIT_WINDOW,
  RATE_LIMIT_MAX_MESSAGES,
  RECONNECT_TOKEN_EXPIRY,
  RECONNECT_INITIAL_DELAY,
  RECONNECT_MAX_DELAY,
  WARNING_TICK_DELTA,
  WARNING_THRESHOLD_5MIN,
  WARNING_THRESHOLD_1MIN,
  CRITICAL_THRESHOLD,
  MINUTE_MS,
  TIME_ADJUSTMENT_MINUTES,
  TIME_ADJUSTMENT_MS,
  TOKEN_STORAGE_KEY,
  TOKEN_MAX_AGE,
  PERSISTENCE_INTERVAL,
  HEARTBEAT_INTERVAL,
  CONNECTION_DRAIN_TIMEOUT,
  MAX_BUFFER_SIZE,
  BUFFER_WARNING_SIZE,
};
