/**
 * Tests for Redis Game State Manager
 */

const { RedisGameStateManager } = require("../lib/redis-game-state");

// Mock Redis client
function createMockRedis() {
  const data = new Map();
  const watchedKeys = new Set();
  let transactionAborted = false;

  return {
    data,
    watchedKeys,

    async get(key) {
      return data.get(key) || null;
    },

    async set(key, value, ...args) {
      // Check for NX flag (set if not exists)
      if (args.includes("NX") && data.has(key)) {
        return null;
      }
      data.set(key, value);
      return "OK";
    },

    async setex(key, ttl, value) {
      data.set(key, value);
      return "OK";
    },

    async del(key) {
      return data.delete(key) ? 1 : 0;
    },

    async exists(key) {
      return data.has(key) ? 1 : 0;
    },

    async watch(key) {
      watchedKeys.add(key);
      return "OK";
    },

    async unwatch() {
      watchedKeys.clear();
      return "OK";
    },

    async scan(cursor, ...args) {
      // Simple mock that returns all keys in one go
      const pattern = args[args.indexOf("MATCH") + 1] || "*";
      const prefix = pattern.replace("*", "");
      const matchingKeys = Array.from(data.keys()).filter(k => k.startsWith(prefix));
      return ["0", matchingKeys];
    },

    multi() {
      const commands = [];
      const self = this;
      return {
        set(key, value, ...args) {
          commands.push({ cmd: "set", key, value, args });
          return this;
        },
        async exec() {
          if (transactionAborted) {
            transactionAborted = false;
            return null;
          }
          for (const cmd of commands) {
            if (cmd.cmd === "set") {
              data.set(cmd.key, cmd.value);
            }
          }
          watchedKeys.clear();
          return [["OK"]];
        },
      };
    },

    // Helper to simulate transaction abort (for testing optimistic locking)
    _abortNextTransaction() {
      transactionAborted = true;
    },
  };
}

describe("RedisGameStateManager", () => {
  let manager;
  let mockRedis;

  beforeEach(() => {
    mockRedis = createMockRedis();
    manager = new RedisGameStateManager(mockRedis, {
      instanceId: "test-instance",
      cacheTTL: 100, // Short TTL for testing
    });
  });

  afterEach(async () => {
    await manager.close();
  });

  describe("create", () => {
    test("should create a new game", async () => {
      const state = { id: "game1", players: [] };
      const created = await manager.create("game1", state);

      expect(created).toBe(true);
      expect(mockRedis.data.has("game:game1")).toBe(true);
    });

    test("should not create duplicate games", async () => {
      const state = { id: "game1" };

      await manager.create("game1", state);
      const created = await manager.create("game1", { id: "game1", different: true });

      expect(created).toBe(false);
    });

    test("should cache created game locally", async () => {
      const state = { id: "game1" };
      await manager.create("game1", state);

      // Get should hit cache
      const result = await manager.get("game1");
      expect(result).toEqual(state);
      expect(manager.stats.cacheHits).toBe(1);
    });
  });

  describe("get", () => {
    test("should return null for non-existent game", async () => {
      const result = await manager.get("non-existent");
      expect(result).toBeNull();
    });

    test("should return game from Redis", async () => {
      const state = { id: "game1", data: "test" };
      mockRedis.data.set("game:game1", JSON.stringify(state));

      const result = await manager.get("game1");
      expect(result).toEqual(state);
    });

    test("should cache result after fetch", async () => {
      const state = { id: "game1" };
      mockRedis.data.set("game:game1", JSON.stringify(state));

      // First call - cache miss
      await manager.get("game1");
      expect(manager.stats.cacheMisses).toBe(1);

      // Second call - cache hit
      await manager.get("game1");
      expect(manager.stats.cacheHits).toBe(1);
    });

    test("should refetch after cache expires", async () => {
      const state = { id: "game1" };
      mockRedis.data.set("game:game1", JSON.stringify(state));

      await manager.get("game1");
      expect(manager.stats.cacheMisses).toBe(1);

      // Wait for cache to expire
      await new Promise(resolve => setTimeout(resolve, 150));

      await manager.get("game1");
      expect(manager.stats.cacheMisses).toBe(2);
    });
  });

  describe("exists", () => {
    test("should return false for non-existent game", async () => {
      const exists = await manager.exists("non-existent");
      expect(exists).toBe(false);
    });

    test("should return true for existing game", async () => {
      mockRedis.data.set("game:game1", JSON.stringify({ id: "game1" }));
      const exists = await manager.exists("game1");
      expect(exists).toBe(true);
    });

    test("should return true if game is in cache", async () => {
      await manager.create("game1", { id: "game1" });
      const exists = await manager.exists("game1");
      expect(exists).toBe(true);
    });
  });

  describe("update", () => {
    test("should update game state atomically", async () => {
      const initialState = { id: "game1", counter: 0 };
      await manager.create("game1", initialState);

      const newState = await manager.update("game1", state => {
        return { ...state, counter: state.counter + 1 };
      });

      expect(newState.counter).toBe(1);

      // Verify it's stored in Redis
      const stored = JSON.parse(mockRedis.data.get("game:game1"));
      expect(stored.counter).toBe(1);
    });

    test("should throw if game does not exist", async () => {
      await expect(manager.update("non-existent", state => state)).rejects.toThrow(
        "Game not found"
      );
    });

    test("should update local cache after update", async () => {
      await manager.create("game1", { id: "game1", value: 1 });

      await manager.update("game1", state => ({ ...state, value: 2 }));

      // Cache should have new value
      const cached = await manager.get("game1");
      expect(cached.value).toBe(2);
      expect(manager.stats.cacheHits).toBe(1); // Should be cache hit
    });
  });

  describe("delete", () => {
    test("should delete game from Redis", async () => {
      await manager.create("game1", { id: "game1" });

      await manager.delete("game1");

      expect(mockRedis.data.has("game:game1")).toBe(false);
    });

    test("should remove from local cache", async () => {
      await manager.create("game1", { id: "game1" });

      await manager.delete("game1");

      expect(manager.cache.has("game1")).toBe(false);
    });
  });

  describe("getAllGameIds", () => {
    test("should return empty array when no games", async () => {
      const ids = await manager.getAllGameIds();
      expect(ids).toEqual([]);
    });

    test("should return all game IDs", async () => {
      await manager.create("game1", { id: "game1" });
      await manager.create("game2", { id: "game2" });
      await manager.create("game3", { id: "game3" });

      const ids = await manager.getAllGameIds();
      expect(ids).toHaveLength(3);
      expect(ids).toContain("game1");
      expect(ids).toContain("game2");
      expect(ids).toContain("game3");
    });
  });

  describe("count", () => {
    test("should return 0 when no games", async () => {
      const count = await manager.count();
      expect(count).toBe(0);
    });

    test("should return correct count", async () => {
      await manager.create("game1", { id: "game1" });
      await manager.create("game2", { id: "game2" });

      const count = await manager.count();
      expect(count).toBe(2);
    });
  });

  describe("stats", () => {
    test("should track cache hits and misses", async () => {
      const state = { id: "game1" };
      mockRedis.data.set("game:game1", JSON.stringify(state));

      // Miss
      await manager.get("game1");
      // Hit
      await manager.get("game1");
      // Hit
      await manager.get("game1");

      const stats = manager.getStats();
      expect(stats.cacheMisses).toBe(1);
      expect(stats.cacheHits).toBe(2);
      expect(stats.cacheHitRate).toBe("66.67%");
    });

    test("should track cache size", async () => {
      await manager.create("game1", { id: "game1" });
      await manager.create("game2", { id: "game2" });

      const stats = manager.getStats();
      expect(stats.cacheSize).toBe(2);
    });
  });

  describe("cache cleanup", () => {
    test("should clean up expired entries", async () => {
      await manager.create("game1", { id: "game1" });

      expect(manager.cache.size).toBe(1);

      // Wait for cache to expire
      await new Promise(resolve => setTimeout(resolve, 150));

      // Manually trigger cleanup
      manager.cleanupCache();

      expect(manager.cache.size).toBe(0);
    });
  });
});
