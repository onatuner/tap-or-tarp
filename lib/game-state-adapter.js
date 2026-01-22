/**
 * Unified Game State Adapter
 *
 * Provides a consistent interface for game state management regardless of
 * the underlying storage strategy:
 *
 * 1. Memory-primary mode (default):
 *    - Games stored in memory Map
 *    - Periodically backed up to storage (Redis/SQLite)
 *    - Fast but data loss possible on crash
 *
 * 2. Redis-primary mode (REDIS_PRIMARY=true):
 *    - Games stored in Redis as source of truth
 *    - Local cache for read performance
 *    - True horizontal scaling, no data loss on crash
 */

const { RedisGameStateManager } = require("./redis-game-state");
const { logger } = require("./logger");

/**
 * Memory-based game state adapter (existing behavior)
 */
class MemoryGameStateAdapter {
  constructor() {
    this.games = new Map();
  }

  async get(gameId) {
    return this.games.get(gameId) || null;
  }

  async exists(gameId) {
    return this.games.has(gameId);
  }

  async create(gameId, session) {
    if (this.games.has(gameId)) {
      return false;
    }
    this.games.set(gameId, session);
    return true;
  }

  async set(gameId, session) {
    this.games.set(gameId, session);
  }

  async delete(gameId) {
    return this.games.delete(gameId);
  }

  async getAllIds() {
    return Array.from(this.games.keys());
  }

  async getAll() {
    return this.games;
  }

  async count() {
    return this.games.size;
  }

  getStats() {
    return { mode: "memory", gameCount: this.games.size };
  }

  async close() {
    this.games.clear();
  }
}

/**
 * Redis-primary game state adapter
 * Wraps RedisGameStateManager to store full GameSession objects
 */
class RedisGameStateAdapter {
  constructor(redis, options = {}) {
    this.manager = new RedisGameStateManager(redis, options);
    this.sessionFactory = options.sessionFactory;
    this.instanceId = options.instanceId;

    // Local session cache (holds hydrated GameSession instances)
    this.sessionCache = new Map();
  }

  async initialize() {
    await this.manager.initialize();
  }

  /**
   * Get a game session by ID
   * @param {string} gameId - Game ID
   * @returns {GameSession|null} Game session or null
   */
  async get(gameId) {
    // Check local session cache first
    const cached = this.sessionCache.get(gameId);
    if (cached) {
      return cached;
    }

    // Get state from Redis
    const state = await this.manager.get(gameId);
    if (!state) return null;

    // Hydrate into a GameSession object
    const session = this.sessionFactory(gameId, state);
    this.sessionCache.set(gameId, session);

    return session;
  }

  async exists(gameId) {
    return this.sessionCache.has(gameId) || (await this.manager.exists(gameId));
  }

  /**
   * Create a new game
   * @param {string} gameId - Game ID
   * @param {GameSession} session - Game session instance
   * @returns {boolean} True if created
   */
  async create(gameId, session) {
    const state = session.toJSON();
    const created = await this.manager.create(gameId, state);

    if (created) {
      this.sessionCache.set(gameId, session);
    }

    return created;
  }

  /**
   * Update a game session in Redis
   * @param {string} gameId - Game ID
   * @param {GameSession} session - Updated session
   */
  async set(gameId, session) {
    const state = session.toJSON();

    try {
      // Use update with optimistic locking
      await this.manager.update(gameId, () => state);
      this.sessionCache.set(gameId, session);
    } catch (error) {
      if (error.message === "Game not found") {
        // Game doesn't exist yet, create it
        await this.manager.create(gameId, state);
        this.sessionCache.set(gameId, session);
      } else {
        throw error;
      }
    }
  }

  /**
   * Perform an atomic update on a game session
   * @param {string} gameId - Game ID
   * @param {function} updateFn - Function that modifies the session
   * @returns {GameSession} Updated session
   */
  async atomicUpdate(gameId, updateFn) {
    const newState = await this.manager.update(gameId, async currentState => {
      // Hydrate current state into session
      const session = this.sessionFactory(gameId, currentState);

      // Apply the update
      await updateFn(session);

      // Return the new state
      return session.toJSON();
    });

    // Update local cache with new session
    const session = this.sessionFactory(gameId, newState);
    this.sessionCache.set(gameId, session);

    return session;
  }

  async delete(gameId) {
    this.sessionCache.delete(gameId);
    await this.manager.delete(gameId);
    return true;
  }

  async getAllIds() {
    return this.manager.getAllGameIds();
  }

  /**
   * Get all games as a Map (for compatibility)
   * Note: This loads all games from Redis, use sparingly
   */
  async getAll() {
    const map = new Map();
    const ids = await this.manager.getAllGameIds();

    for (const id of ids) {
      const session = await this.get(id);
      if (session) {
        map.set(id, session);
      }
    }

    return map;
  }

  async count() {
    return this.manager.count();
  }

  getStats() {
    return {
      mode: "redis-primary",
      ...this.manager.getStats(),
      sessionCacheSize: this.sessionCache.size,
    };
  }

  /**
   * Invalidate local cache for a game (called when receiving cross-instance updates)
   */
  invalidateCache(gameId) {
    this.sessionCache.delete(gameId);
  }

  async close() {
    this.sessionCache.clear();
    await this.manager.close();
  }
}

/**
 * Create the appropriate game state adapter based on configuration
 * @param {object} options - Configuration options
 * @returns {MemoryGameStateAdapter|RedisGameStateAdapter}
 */
function createGameStateAdapter(options = {}) {
  const {
    redisPrimary = false,
    redis = null,
    pubClient = null,
    subClient = null,
    sessionFactory = null,
    instanceId = null,
  } = options;

  if (redisPrimary && redis) {
    if (!sessionFactory) {
      throw new Error("sessionFactory is required for Redis-primary mode");
    }

    logger.info("Creating Redis-primary game state adapter");
    return new RedisGameStateAdapter(redis, {
      pubClient,
      subClient,
      sessionFactory,
      instanceId,
    });
  }

  logger.info("Creating memory-primary game state adapter");
  return new MemoryGameStateAdapter();
}

module.exports = {
  MemoryGameStateAdapter,
  RedisGameStateAdapter,
  createGameStateAdapter,
};
