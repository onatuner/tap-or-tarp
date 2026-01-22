/**
 * Redis-based session storage for horizontal scaling
 * Enables shared state across multiple server instances
 * Includes pub/sub for cross-instance communication
 */

const Redis = require("ioredis");
const { logger } = require("./logger");

// Redis key prefixes
const KEYS = {
  SESSION: "session:",
  CHANNEL_BROADCAST: "broadcast:",
  CHANNEL_GLOBAL: "global:events",
  INSTANCE_SET: "instances",
};

// Default TTL for sessions (24 hours)
const DEFAULT_TTL = 24 * 60 * 60;

class RedisStorage {
  /**
   * Create a new Redis storage instance
   * @param {string} url - Redis connection URL
   * @param {object} options - Additional options
   */
  constructor(url, options = {}) {
    this.url = url;
    this.options = {
      ttl: options.ttl || DEFAULT_TTL,
      instanceId: options.instanceId || null,
      ...options,
    };

    // Main Redis client for data operations
    this.redis = null;
    // Publisher client for pub/sub
    this.pubClient = null;
    // Subscriber client for pub/sub
    this.subClient = null;

    // Event handlers for pub/sub messages
    this.messageHandlers = new Map();

    // Connection state
    this.isConnected = false;
    this.isInitialized = false;
  }

  /**
   * Initialize Redis connections
   * @returns {RedisStorage}
   */
  initialize() {
    const redisOptions = {
      retryDelayOnFailover: 100,
      maxRetriesPerRequest: 3,
      lazyConnect: false,
      showFriendlyErrorStack: process.env.NODE_ENV !== "production",
    };

    try {
      // Create main client
      this.redis = new Redis(this.url, redisOptions);
      // Create pub client (separate connection required)
      this.pubClient = new Redis(this.url, redisOptions);
      // Create sub client (separate connection required)
      this.subClient = new Redis(this.url, redisOptions);

      // Set up event handlers
      this.redis.on("connect", () => {
        this.isConnected = true;
        logger.info("Redis main client connected");
      });

      this.redis.on("error", error => {
        logger.error({ error: error.message }, "Redis main client error");
      });

      this.redis.on("close", () => {
        this.isConnected = false;
        logger.warn("Redis main client disconnected");
      });

      // Set up subscriber message handler
      this.subClient.on("message", (channel, message) => {
        this.handleMessage(channel, message);
      });

      this.subClient.on("error", error => {
        logger.error({ error: error.message }, "Redis subscriber error");
      });

      // Register this instance
      if (this.options.instanceId) {
        this.registerInstance();
      }

      this.isInitialized = true;
      logger.info({ url: this.url.replace(/\/\/.*@/, "//***@") }, "Redis storage initialized");

      return this;
    } catch (error) {
      logger.error({ error: error.message }, "Failed to initialize Redis storage");
      throw error;
    }
  }

  /**
   * Register this server instance in Redis
   */
  async registerInstance() {
    if (!this.options.instanceId) return;

    try {
      await this.redis.sadd(KEYS.INSTANCE_SET, this.options.instanceId);
      // Set instance heartbeat with expiry
      await this.redis.setex(
        `instance:${this.options.instanceId}`,
        60, // 60 second TTL
        JSON.stringify({
          id: this.options.instanceId,
          startedAt: Date.now(),
          lastHeartbeat: Date.now(),
        })
      );
    } catch (error) {
      logger.error({ error: error.message }, "Failed to register instance");
    }
  }

  /**
   * Update instance heartbeat
   */
  async heartbeat() {
    if (!this.options.instanceId) return;

    try {
      await this.redis.setex(
        `instance:${this.options.instanceId}`,
        60,
        JSON.stringify({
          id: this.options.instanceId,
          lastHeartbeat: Date.now(),
        })
      );
    } catch (error) {
      logger.error({ error: error.message }, "Failed to update heartbeat");
    }
  }

  /**
   * Save a session to Redis
   * @param {string} id - Game session ID
   * @param {object} sessionState - Session state object
   */
  async save(id, sessionState) {
    if (!this.redis) return;

    try {
      const key = KEYS.SESSION + id;
      const data = JSON.stringify({
        state: sessionState,
        updatedAt: Date.now(),
        instanceId: this.options.instanceId,
      });

      await this.redis.setex(key, this.options.ttl, data);
    } catch (error) {
      logger.error({ error: error.message, gameId: id }, "Failed to save session to Redis");
      throw error;
    }
  }

  /**
   * Load a session from Redis
   * @param {string} id - Game session ID
   * @returns {object|null} Session state or null if not found
   */
  async load(id) {
    if (!this.redis) return null;

    try {
      const key = KEYS.SESSION + id;
      const data = await this.redis.get(key);

      if (!data) return null;

      const parsed = JSON.parse(data);
      return parsed.state;
    } catch (error) {
      logger.error({ error: error.message, gameId: id }, "Failed to load session from Redis");
      return null;
    }
  }

  /**
   * Load all sessions from Redis
   * @returns {Array} Array of {id, state} objects
   */
  async loadAll() {
    if (!this.redis) return [];

    try {
      const keys = await this.redis.keys(KEYS.SESSION + "*");
      if (keys.length === 0) return [];

      const sessions = [];
      for (const key of keys) {
        const id = key.replace(KEYS.SESSION, "");
        const data = await this.redis.get(key);
        if (data) {
          const parsed = JSON.parse(data);
          sessions.push({ id, state: parsed.state });
        }
      }

      return sessions;
    } catch (error) {
      logger.error({ error: error.message }, "Failed to load all sessions from Redis");
      return [];
    }
  }

  /**
   * Delete a session from Redis
   * @param {string} id - Game session ID
   */
  async delete(id) {
    if (!this.redis) return;

    try {
      await this.redis.del(KEYS.SESSION + id);
    } catch (error) {
      logger.error({ error: error.message, gameId: id }, "Failed to delete session from Redis");
    }
  }

  /**
   * Get the number of stored sessions
   * @returns {number} Session count
   */
  async count() {
    if (!this.redis) return 0;

    try {
      const keys = await this.redis.keys(KEYS.SESSION + "*");
      return keys.length;
    } catch (error) {
      logger.error({ error: error.message }, "Failed to count sessions in Redis");
      return 0;
    }
  }

  /**
   * Check Redis connection health
   * @returns {object} Health status
   */
  async health() {
    if (!this.redis) {
      return { healthy: false, error: "Not initialized" };
    }

    try {
      const start = Date.now();
      await this.redis.ping();
      const latency = Date.now() - start;

      const info = await this.redis.info("server");
      const versionMatch = info.match(/redis_version:(\S+)/);
      const version = versionMatch ? versionMatch[1] : "unknown";

      return {
        healthy: true,
        latency,
        version,
        connected: this.isConnected,
      };
    } catch (error) {
      return {
        healthy: false,
        error: error.message,
        connected: this.isConnected,
      };
    }
  }

  // ============================================================================
  // PUB/SUB METHODS
  // ============================================================================

  /**
   * Subscribe to a channel
   * @param {string} channel - Channel name
   * @param {function} handler - Message handler function
   */
  async subscribe(channel, handler) {
    if (!this.subClient) return;

    try {
      this.messageHandlers.set(channel, handler);
      await this.subClient.subscribe(channel);
      logger.debug({ channel }, "Subscribed to Redis channel");
    } catch (error) {
      logger.error({ error: error.message, channel }, "Failed to subscribe to channel");
    }
  }

  /**
   * Subscribe to a game-specific broadcast channel
   * @param {string} gameId - Game session ID
   * @param {function} handler - Message handler function
   */
  async subscribeToGame(gameId, handler) {
    await this.subscribe(KEYS.CHANNEL_BROADCAST + gameId, handler);
  }

  /**
   * Unsubscribe from a channel
   * @param {string} channel - Channel name
   */
  async unsubscribe(channel) {
    if (!this.subClient) return;

    try {
      this.messageHandlers.delete(channel);
      await this.subClient.unsubscribe(channel);
      logger.debug({ channel }, "Unsubscribed from Redis channel");
    } catch (error) {
      logger.error({ error: error.message, channel }, "Failed to unsubscribe from channel");
    }
  }

  /**
   * Publish a message to a channel
   * @param {string} channel - Channel name
   * @param {object} message - Message to publish
   */
  async publish(channel, message) {
    if (!this.pubClient) return;

    try {
      const data = JSON.stringify({
        ...message,
        instanceId: this.options.instanceId,
        timestamp: Date.now(),
      });
      await this.pubClient.publish(channel, data);
    } catch (error) {
      logger.error({ error: error.message, channel }, "Failed to publish message");
    }
  }

  /**
   * Broadcast a message to all clients in a game (across all instances)
   * @param {string} gameId - Game session ID
   * @param {string} type - Message type
   * @param {object} data - Message data
   */
  async broadcast(gameId, type, data) {
    await this.publish(KEYS.CHANNEL_BROADCAST + gameId, { type, data, gameId });
  }

  /**
   * Publish a global event (e.g., session created, instance status)
   * @param {string} eventType - Event type
   * @param {object} data - Event data
   */
  async publishGlobalEvent(eventType, data) {
    await this.publish(KEYS.CHANNEL_GLOBAL, { eventType, data });
  }

  /**
   * Handle incoming pub/sub message
   * @param {string} channel - Channel name
   * @param {string} message - Raw message string
   */
  handleMessage(channel, message) {
    try {
      const parsed = JSON.parse(message);

      // Skip messages from this instance (already handled locally)
      if (parsed.instanceId === this.options.instanceId) {
        return;
      }

      const handler = this.messageHandlers.get(channel);
      if (handler) {
        handler(parsed);
      }
    } catch (error) {
      logger.error({ error: error.message, channel }, "Failed to handle pub/sub message");
    }
  }

  /**
   * Close all Redis connections
   */
  async close() {
    // Unregister instance
    if (this.options.instanceId && this.redis) {
      try {
        await this.redis.srem(KEYS.INSTANCE_SET, this.options.instanceId);
        await this.redis.del(`instance:${this.options.instanceId}`);
      } catch (error) {
        // Ignore errors during shutdown
      }
    }

    // Close connections
    if (this.subClient) {
      this.subClient.disconnect();
      this.subClient = null;
    }
    if (this.pubClient) {
      this.pubClient.disconnect();
      this.pubClient = null;
    }
    if (this.redis) {
      this.redis.disconnect();
      this.redis = null;
    }

    this.isConnected = false;
    this.isInitialized = false;
    logger.info("Redis storage closed");
  }
}

module.exports = { RedisStorage, KEYS };
