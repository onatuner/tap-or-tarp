/**
 * Redis-based game state manager for true horizontal scaling
 *
 * Architecture:
 * - Redis is the primary store for game state (source of truth)
 * - Local cache provides fast reads with TTL-based expiration
 * - WATCH/MULTI/EXEC ensures atomic updates with optimistic locking
 * - Pub/sub invalidates local cache across instances
 *
 * Benefits:
 * - No data loss on instance crash (state is in Redis)
 * - True horizontal scaling (any instance can handle any game)
 * - Consistent state across all instances
 */

const { logger } = require("./logger");

// Cache configuration
const CACHE_TTL = 5000; // 5 seconds cache TTL
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY = 50; // ms

// Redis key prefixes
const KEYS = {
  GAME: "game:",
  GAME_LOCK: "game:lock:",
  CACHE_INVALIDATE: "cache:invalidate:",
};

/**
 * Local cache entry
 */
class CacheEntry {
  constructor(data) {
    this.data = data;
    this.timestamp = Date.now();
  }

  isValid(ttl = CACHE_TTL) {
    return Date.now() - this.timestamp < ttl;
  }
}

/**
 * Redis-based game state manager with local caching
 */
class RedisGameStateManager {
  /**
   * Create a new Redis game state manager
   * @param {object} redis - ioredis client instance
   * @param {object} options - Configuration options
   */
  constructor(redis, options = {}) {
    this.redis = redis;
    this.pubClient = options.pubClient || null;
    this.subClient = options.subClient || null;
    this.instanceId = options.instanceId || "unknown";
    this.cacheTTL = options.cacheTTL || CACHE_TTL;

    // Local cache: Map<gameId, CacheEntry>
    this.cache = new Map();

    // Subscribed game channels
    this.subscribedGames = new Set();

    // Cache cleanup interval
    this.cleanupInterval = null;

    // Stats
    this.stats = {
      cacheHits: 0,
      cacheMisses: 0,
      cacheInvalidations: 0,
      optimisticLockRetries: 0,
      optimisticLockFailures: 0,
    };
  }

  /**
   * Initialize the manager
   */
  async initialize() {
    // Start cache cleanup interval
    this.cleanupInterval = setInterval(() => {
      this.cleanupCache();
    }, this.cacheTTL * 2);

    // Subscribe to cache invalidation channel
    if (this.subClient) {
      this.subClient.on("message", (channel, message) => {
        this.handleCacheInvalidation(channel, message);
      });
    }

    logger.info({ instanceId: this.instanceId }, "Redis game state manager initialized");
  }

  /**
   * Clean up expired cache entries
   */
  cleanupCache() {
    let cleaned = 0;
    for (const [gameId, entry] of this.cache.entries()) {
      if (!entry.isValid(this.cacheTTL)) {
        this.cache.delete(gameId);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.debug({ cleaned }, "Cleaned expired cache entries");
    }
  }

  /**
   * Handle cache invalidation message from Redis pub/sub
   */
  handleCacheInvalidation(channel, message) {
    try {
      const data = JSON.parse(message);

      // Skip our own invalidation messages
      if (data.instanceId === this.instanceId) {
        return;
      }

      if (data.gameId && this.cache.has(data.gameId)) {
        this.cache.delete(data.gameId);
        this.stats.cacheInvalidations++;
        logger.debug(
          { gameId: data.gameId, fromInstance: data.instanceId },
          "Cache invalidated by remote"
        );
      }
    } catch (error) {
      logger.error({ error: error.message, channel }, "Failed to handle cache invalidation");
    }
  }

  /**
   * Publish cache invalidation to other instances
   * @param {string} gameId - Game ID that was updated
   */
  async publishInvalidation(gameId) {
    if (!this.pubClient) return;

    try {
      await this.pubClient.publish(
        KEYS.CACHE_INVALIDATE + gameId,
        JSON.stringify({
          gameId,
          instanceId: this.instanceId,
          timestamp: Date.now(),
        })
      );
    } catch (error) {
      logger.error({ error: error.message, gameId }, "Failed to publish cache invalidation");
    }
  }

  /**
   * Subscribe to cache invalidation for a game
   * @param {string} gameId - Game ID to subscribe to
   */
  async subscribeToGame(gameId) {
    if (!this.subClient || this.subscribedGames.has(gameId)) return;

    try {
      await this.subClient.subscribe(KEYS.CACHE_INVALIDATE + gameId);
      this.subscribedGames.add(gameId);
      logger.debug({ gameId }, "Subscribed to game cache invalidation");
    } catch (error) {
      logger.error({ error: error.message, gameId }, "Failed to subscribe to game");
    }
  }

  /**
   * Unsubscribe from cache invalidation for a game
   * @param {string} gameId - Game ID to unsubscribe from
   */
  async unsubscribeFromGame(gameId) {
    if (!this.subClient || !this.subscribedGames.has(gameId)) return;

    try {
      await this.subClient.unsubscribe(KEYS.CACHE_INVALIDATE + gameId);
      this.subscribedGames.delete(gameId);
      this.cache.delete(gameId);
      logger.debug({ gameId }, "Unsubscribed from game cache invalidation");
    } catch (error) {
      logger.error({ error: error.message, gameId }, "Failed to unsubscribe from game");
    }
  }

  /**
   * Get game state (with caching)
   * @param {string} gameId - Game ID
   * @returns {object|null} Game state or null if not found
   */
  async get(gameId) {
    // Check local cache first
    const cached = this.cache.get(gameId);
    if (cached && cached.isValid(this.cacheTTL)) {
      this.stats.cacheHits++;
      return cached.data;
    }

    // Cache miss - fetch from Redis
    this.stats.cacheMisses++;

    try {
      const key = KEYS.GAME + gameId;
      const data = await this.redis.get(key);

      if (!data) return null;

      const state = JSON.parse(data);

      // Update cache
      this.cache.set(gameId, new CacheEntry(state));

      return state;
    } catch (error) {
      logger.error({ error: error.message, gameId }, "Failed to get game state from Redis");
      return null;
    }
  }

  /**
   * Check if a game exists
   * @param {string} gameId - Game ID
   * @returns {boolean} True if game exists
   */
  async exists(gameId) {
    // Check cache first
    if (this.cache.has(gameId) && this.cache.get(gameId).isValid(this.cacheTTL)) {
      return true;
    }

    try {
      const key = KEYS.GAME + gameId;
      return (await this.redis.exists(key)) === 1;
    } catch (error) {
      logger.error({ error: error.message, gameId }, "Failed to check game existence");
      return false;
    }
  }

  /**
   * Create a new game (atomic operation)
   * @param {string} gameId - Game ID
   * @param {object} state - Initial game state
   * @param {number} ttl - Time-to-live in seconds (default 24 hours)
   * @returns {boolean} True if created, false if already exists
   */
  async create(gameId, state, ttl = 86400) {
    try {
      const key = KEYS.GAME + gameId;
      const data = JSON.stringify(state);

      // Use SET NX (only set if not exists) for atomic creation
      const result = await this.redis.set(key, data, "EX", ttl, "NX");

      if (result === "OK") {
        // Update local cache
        this.cache.set(gameId, new CacheEntry(state));

        // Subscribe to cache invalidation
        await this.subscribeToGame(gameId);

        logger.debug({ gameId }, "Game created in Redis");
        return true;
      }

      logger.debug({ gameId }, "Game already exists in Redis");
      return false;
    } catch (error) {
      logger.error({ error: error.message, gameId }, "Failed to create game in Redis");
      throw error;
    }
  }

  /**
   * Update game state atomically using optimistic locking
   * @param {string} gameId - Game ID
   * @param {function} updateFn - Function that receives current state and returns new state
   * @param {number} ttl - Time-to-live in seconds (default 24 hours)
   * @returns {object} Updated state
   */
  async update(gameId, updateFn, ttl = 86400) {
    const key = KEYS.GAME + gameId;
    let attempts = 0;

    while (attempts < MAX_RETRY_ATTEMPTS) {
      try {
        // WATCH the key for optimistic locking
        await this.redis.watch(key);

        // Get current state
        const currentData = await this.redis.get(key);
        if (!currentData) {
          await this.redis.unwatch();
          throw new Error("Game not found");
        }

        const currentState = JSON.parse(currentData);

        // Apply the update function
        const newState = await updateFn(currentState);

        // Execute the update in a transaction
        const result = await this.redis
          .multi()
          .set(key, JSON.stringify(newState), "EX", ttl)
          .exec();

        // Check if transaction succeeded (null means WATCH detected a change)
        if (result === null) {
          attempts++;
          this.stats.optimisticLockRetries++;

          if (attempts < MAX_RETRY_ATTEMPTS) {
            // Wait a bit before retrying
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * attempts));
            continue;
          }

          this.stats.optimisticLockFailures++;
          throw new Error("Optimistic lock failed after max retries");
        }

        // Update local cache
        this.cache.set(gameId, new CacheEntry(newState));

        // Publish cache invalidation to other instances
        await this.publishInvalidation(gameId);

        return newState;
      } catch (error) {
        await this.redis.unwatch();

        if (
          error.message === "Game not found" ||
          error.message.includes("Optimistic lock failed")
        ) {
          throw error;
        }

        logger.error({ error: error.message, gameId, attempt: attempts }, "Update failed");
        throw error;
      }
    }
  }

  /**
   * Delete a game
   * @param {string} gameId - Game ID
   */
  async delete(gameId) {
    try {
      const key = KEYS.GAME + gameId;
      await this.redis.del(key);

      // Remove from cache
      this.cache.delete(gameId);

      // Unsubscribe from cache invalidation
      await this.unsubscribeFromGame(gameId);

      // Publish invalidation so other instances remove from their cache
      await this.publishInvalidation(gameId);

      logger.debug({ gameId }, "Game deleted from Redis");
    } catch (error) {
      logger.error({ error: error.message, gameId }, "Failed to delete game from Redis");
    }
  }

  /**
   * Get all game IDs (using SCAN for non-blocking iteration)
   * @returns {Array<string>} Array of game IDs
   */
  async getAllGameIds() {
    const gameIds = [];
    let cursor = "0";

    try {
      do {
        const [newCursor, keys] = await this.redis.scan(
          cursor,
          "MATCH",
          KEYS.GAME + "*",
          "COUNT",
          100
        );
        cursor = newCursor;

        for (const key of keys) {
          // Skip lock keys
          if (!key.includes(":lock:")) {
            const gameId = key.replace(KEYS.GAME, "");
            gameIds.push(gameId);
          }
        }
      } while (cursor !== "0");

      return gameIds;
    } catch (error) {
      logger.error({ error: error.message }, "Failed to get all game IDs");
      return [];
    }
  }

  /**
   * Get the count of games
   * @returns {number} Number of games
   */
  async count() {
    const gameIds = await this.getAllGameIds();
    return gameIds.length;
  }

  /**
   * Get manager statistics
   * @returns {object} Statistics
   */
  getStats() {
    return {
      ...this.stats,
      cacheSize: this.cache.size,
      subscribedGames: this.subscribedGames.size,
      cacheHitRate:
        this.stats.cacheHits + this.stats.cacheMisses > 0
          ? (
              (this.stats.cacheHits / (this.stats.cacheHits + this.stats.cacheMisses)) *
              100
            ).toFixed(2) + "%"
          : "N/A",
    };
  }

  /**
   * Close the manager and clean up resources
   */
  async close() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Unsubscribe from all games
    for (const gameId of this.subscribedGames) {
      try {
        await this.subClient?.unsubscribe(KEYS.CACHE_INVALIDATE + gameId);
      } catch (error) {
        // Ignore errors during shutdown
      }
    }

    this.cache.clear();
    this.subscribedGames.clear();

    logger.info("Redis game state manager closed");
  }
}

module.exports = { RedisGameStateManager, KEYS };
