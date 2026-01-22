/**
 * Distributed locking utilities for game session operations
 * Prevents race conditions when multiple clients modify the same game
 */

const AsyncLock = require("async-lock");
const { logger } = require("./logger");

// Lock configuration
const LOCK_TIMEOUT = 5000; // 5 seconds max wait for lock
const MAX_PENDING = 100; // Max queued operations per game

// Single AsyncLock instance handles all game locks
const lock = new AsyncLock({
  timeout: LOCK_TIMEOUT,
  maxPending: MAX_PENDING,
});

// Track active locks for monitoring
const lockStats = {
  acquired: 0,
  released: 0,
  timeouts: 0,
  errors: 0,
};

/**
 * Execute an operation with exclusive access to a game session
 * @param {string} gameId - The game session ID to lock
 * @param {Function} operation - Async function to execute while holding the lock
 * @returns {Promise<any>} Result of the operation
 * @throws {Error} If lock acquisition times out or operation fails
 */
async function withGameLock(gameId, operation) {
  const startTime = Date.now();

  try {
    const result = await lock.acquire(gameId, async () => {
      lockStats.acquired++;
      const acquireTime = Date.now() - startTime;

      if (acquireTime > 100) {
        logger.warn({ gameId, acquireTime }, "Slow lock acquisition");
      }

      try {
        return await operation();
      } finally {
        lockStats.released++;
      }
    });

    return result;
  } catch (error) {
    if (error.message === "async-lock timed out") {
      lockStats.timeouts++;
      logger.error({ gameId, timeout: LOCK_TIMEOUT }, "Game lock acquisition timed out");
      throw new Error("Operation timed out - game is busy");
    }

    if (error.message.includes("Too much pending")) {
      lockStats.errors++;
      logger.error({ gameId, maxPending: MAX_PENDING }, "Too many pending operations for game");
      throw new Error("Too many pending operations - try again later");
    }

    lockStats.errors++;
    throw error;
  }
}

/**
 * Check if a game currently has pending operations
 * @param {string} gameId - The game session ID
 * @returns {boolean} True if there are pending operations
 */
function isGameBusy(gameId) {
  return lock.isBusy(gameId);
}

/**
 * Get the number of pending operations for a game
 * @param {string} gameId - The game session ID
 * @returns {number} Number of pending operations
 */
function getPendingCount(gameId) {
  return lock.isBusy(gameId) ? 1 : 0; // AsyncLock doesn't expose queue length directly
}

/**
 * Get lock statistics for monitoring
 * @returns {object} Lock statistics
 */
function getLockStats() {
  return {
    ...lockStats,
    activeKeys: lock.isBusy() ? "busy" : "idle",
  };
}

/**
 * Reset lock statistics (for testing)
 */
function resetLockStats() {
  lockStats.acquired = 0;
  lockStats.released = 0;
  lockStats.timeouts = 0;
  lockStats.errors = 0;
}

module.exports = {
  withGameLock,
  isGameBusy,
  getPendingCount,
  getLockStats,
  resetLockStats,
  LOCK_TIMEOUT,
  MAX_PENDING,
};
