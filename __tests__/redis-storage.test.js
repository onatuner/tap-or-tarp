/**
 * Tests for Redis storage module
 * Note: These tests mock Redis to avoid requiring a real Redis instance
 */

// Mock ioredis before requiring the module
jest.mock("ioredis", () => {
  const mockRedis = {
    on: jest.fn(),
    setex: jest.fn().mockResolvedValue("OK"),
    get: jest.fn().mockResolvedValue(null),
    del: jest.fn().mockResolvedValue(1),
    keys: jest.fn().mockResolvedValue([]),
    ping: jest.fn().mockResolvedValue("PONG"),
    info: jest.fn().mockResolvedValue("redis_version:7.0.0"),
    sadd: jest.fn().mockResolvedValue(1),
    srem: jest.fn().mockResolvedValue(1),
    subscribe: jest.fn().mockResolvedValue(1),
    unsubscribe: jest.fn().mockResolvedValue(1),
    publish: jest.fn().mockResolvedValue(1),
    disconnect: jest.fn(),
  };

  return jest.fn(() => mockRedis);
});

// Mock logger
jest.mock("../lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { RedisStorage, KEYS } = require("../lib/redis-storage");

describe("RedisStorage", () => {
  let storage;

  beforeEach(() => {
    jest.clearAllMocks();
    storage = new RedisStorage("redis://localhost:6379", {
      instanceId: "test-instance",
    });
  });

  afterEach(async () => {
    if (storage && storage.isInitialized) {
      await storage.close();
    }
  });

  describe("constructor", () => {
    test("should create instance with default options", () => {
      const s = new RedisStorage("redis://localhost:6379");
      expect(s.url).toBe("redis://localhost:6379");
      expect(s.options.ttl).toBe(24 * 60 * 60);
      expect(s.isConnected).toBe(false);
      expect(s.isInitialized).toBe(false);
    });

    test("should accept custom options", () => {
      const s = new RedisStorage("redis://localhost:6379", {
        ttl: 3600,
        instanceId: "custom-instance",
      });
      expect(s.options.ttl).toBe(3600);
      expect(s.options.instanceId).toBe("custom-instance");
    });
  });

  describe("initialize", () => {
    test("should initialize Redis connections", () => {
      storage.initialize();

      expect(storage.redis).toBeDefined();
      expect(storage.pubClient).toBeDefined();
      expect(storage.subClient).toBeDefined();
      expect(storage.isInitialized).toBe(true);
    });

    test("should set up event handlers", () => {
      storage.initialize();

      expect(storage.redis.on).toHaveBeenCalledWith("connect", expect.any(Function));
      expect(storage.redis.on).toHaveBeenCalledWith("error", expect.any(Function));
      expect(storage.redis.on).toHaveBeenCalledWith("close", expect.any(Function));
    });
  });

  describe("save", () => {
    beforeEach(() => {
      storage.initialize();
    });

    test("should save session with TTL", async () => {
      const sessionState = { id: "TEST01", status: "waiting" };
      await storage.save("TEST01", sessionState);

      expect(storage.redis.setex).toHaveBeenCalledWith(
        "session:TEST01",
        storage.options.ttl,
        expect.any(String)
      );
    });

    test("should include metadata in saved data", async () => {
      const sessionState = { id: "TEST01", status: "waiting" };
      await storage.save("TEST01", sessionState);

      // Get the most recent call to setex
      const calls = storage.redis.setex.mock.calls;
      const lastCall = calls[calls.length - 1];
      const savedData = JSON.parse(lastCall[2]);

      expect(savedData.state).toEqual(sessionState);
      expect(savedData.updatedAt).toBeDefined();
      expect(savedData.instanceId).toBe("test-instance");
    });
  });

  describe("load", () => {
    beforeEach(() => {
      storage.initialize();
    });

    test("should return null for non-existent session", async () => {
      storage.redis.get.mockResolvedValueOnce(null);

      const result = await storage.load("NONEXISTENT");
      expect(result).toBeNull();
    });

    test("should return session state for existing session", async () => {
      const sessionState = { id: "TEST01", status: "waiting" };
      storage.redis.get.mockResolvedValueOnce(
        JSON.stringify({ state: sessionState, updatedAt: Date.now() })
      );

      const result = await storage.load("TEST01");
      expect(result).toEqual(sessionState);
    });
  });

  describe("loadAll", () => {
    beforeEach(() => {
      storage.initialize();
    });

    test("should return empty array when no sessions exist", async () => {
      storage.redis.keys.mockResolvedValueOnce([]);

      const result = await storage.loadAll();
      expect(result).toEqual([]);
    });

    test("should return all sessions", async () => {
      const session1 = { id: "TEST01", status: "waiting" };
      const session2 = { id: "TEST02", status: "running" };

      storage.redis.keys.mockResolvedValueOnce(["session:TEST01", "session:TEST02"]);
      storage.redis.get
        .mockResolvedValueOnce(JSON.stringify({ state: session1 }))
        .mockResolvedValueOnce(JSON.stringify({ state: session2 }));

      const result = await storage.loadAll();
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ id: "TEST01", state: session1 });
      expect(result[1]).toEqual({ id: "TEST02", state: session2 });
    });
  });

  describe("delete", () => {
    beforeEach(() => {
      storage.initialize();
    });

    test("should delete session from Redis", async () => {
      await storage.delete("TEST01");
      expect(storage.redis.del).toHaveBeenCalledWith("session:TEST01");
    });
  });

  describe("count", () => {
    beforeEach(() => {
      storage.initialize();
    });

    test("should return session count", async () => {
      storage.redis.keys.mockResolvedValueOnce(["session:A", "session:B", "session:C"]);

      const count = await storage.count();
      expect(count).toBe(3);
    });
  });

  describe("health", () => {
    beforeEach(() => {
      storage.initialize();
    });

    test("should return healthy status", async () => {
      const health = await storage.health();

      expect(health.healthy).toBe(true);
      expect(health.latency).toBeDefined();
      expect(health.version).toBe("7.0.0");
    });

    test("should return unhealthy status on error", async () => {
      storage.redis.ping.mockRejectedValueOnce(new Error("Connection refused"));

      const health = await storage.health();

      expect(health.healthy).toBe(false);
      expect(health.error).toBe("Connection refused");
    });
  });

  describe("pub/sub", () => {
    beforeEach(() => {
      storage.initialize();
    });

    test("should subscribe to channel", async () => {
      const handler = jest.fn();
      await storage.subscribe("test-channel", handler);

      expect(storage.subClient.subscribe).toHaveBeenCalledWith("test-channel");
      expect(storage.messageHandlers.has("test-channel")).toBe(true);
    });

    test("should unsubscribe from channel", async () => {
      const handler = jest.fn();
      await storage.subscribe("test-channel", handler);
      await storage.unsubscribe("test-channel");

      expect(storage.subClient.unsubscribe).toHaveBeenCalledWith("test-channel");
      expect(storage.messageHandlers.has("test-channel")).toBe(false);
    });

    test("should publish message to channel", async () => {
      await storage.publish("test-channel", { type: "test", data: {} });

      expect(storage.pubClient.publish).toHaveBeenCalledWith("test-channel", expect.any(String));

      const publishedData = JSON.parse(storage.pubClient.publish.mock.calls[0][1]);
      expect(publishedData.type).toBe("test");
      expect(publishedData.instanceId).toBe("test-instance");
      expect(publishedData.timestamp).toBeDefined();
    });

    test("should broadcast to game channel", async () => {
      await storage.broadcast("GAME01", "state", { players: [] });

      expect(storage.pubClient.publish).toHaveBeenCalledWith(
        "broadcast:GAME01",
        expect.any(String)
      );
    });

    test("should handle incoming messages", () => {
      const handler = jest.fn();
      storage.messageHandlers.set("test-channel", handler);

      // Simulate message from another instance
      storage.handleMessage(
        "test-channel",
        JSON.stringify({
          type: "test",
          data: { foo: "bar" },
          instanceId: "other-instance",
        })
      );

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "test",
          data: { foo: "bar" },
          instanceId: "other-instance",
        })
      );
    });

    test("should ignore messages from same instance", () => {
      const handler = jest.fn();
      storage.messageHandlers.set("test-channel", handler);

      // Simulate message from same instance
      storage.handleMessage(
        "test-channel",
        JSON.stringify({
          type: "test",
          instanceId: "test-instance",
        })
      );

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("close", () => {
    beforeEach(() => {
      storage.initialize();
    });

    test("should close all connections", async () => {
      await storage.close();

      expect(storage.redis).toBeNull();
      expect(storage.pubClient).toBeNull();
      expect(storage.subClient).toBeNull();
      expect(storage.isInitialized).toBe(false);
    });
  });
});

describe("KEYS", () => {
  test("should have correct key prefixes", () => {
    expect(KEYS.SESSION).toBe("session:");
    expect(KEYS.CHANNEL_BROADCAST).toBe("broadcast:");
    expect(KEYS.CHANNEL_GLOBAL).toBe("global:events");
    expect(KEYS.INSTANCE_SET).toBe("instances");
  });
});
