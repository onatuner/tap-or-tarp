/**
 * Tests for Game State Adapter
 */

const { MemoryGameStateAdapter, createGameStateAdapter } = require("../lib/game-state-adapter");

describe("MemoryGameStateAdapter", () => {
  let adapter;

  beforeEach(() => {
    adapter = new MemoryGameStateAdapter();
  });

  afterEach(async () => {
    await adapter.close();
  });

  describe("basic operations", () => {
    test("should create and retrieve a game", async () => {
      const mockSession = { id: "test-game", toJSON: () => ({ id: "test-game" }) };

      const created = await adapter.create("test-game", mockSession);
      expect(created).toBe(true);

      const retrieved = await adapter.get("test-game");
      expect(retrieved).toBe(mockSession);
    });

    test("should not create duplicate games", async () => {
      const mockSession = { id: "test-game" };

      await adapter.create("test-game", mockSession);
      const created = await adapter.create("test-game", { id: "another" });

      expect(created).toBe(false);
    });

    test("should check if game exists", async () => {
      const mockSession = { id: "test-game" };

      expect(await adapter.exists("test-game")).toBe(false);

      await adapter.create("test-game", mockSession);

      expect(await adapter.exists("test-game")).toBe(true);
    });

    test("should delete a game", async () => {
      const mockSession = { id: "test-game" };

      await adapter.create("test-game", mockSession);
      expect(await adapter.exists("test-game")).toBe(true);

      await adapter.delete("test-game");
      expect(await adapter.exists("test-game")).toBe(false);
    });

    test("should return null for non-existent game", async () => {
      const result = await adapter.get("non-existent");
      expect(result).toBeNull();
    });

    test("should set/update a game", async () => {
      const mockSession1 = { id: "test-game", value: 1 };
      const mockSession2 = { id: "test-game", value: 2 };

      await adapter.set("test-game", mockSession1);
      expect(await adapter.get("test-game")).toBe(mockSession1);

      await adapter.set("test-game", mockSession2);
      expect(await adapter.get("test-game")).toBe(mockSession2);
    });
  });

  describe("collection operations", () => {
    test("should get all game IDs", async () => {
      await adapter.create("game1", { id: "game1" });
      await adapter.create("game2", { id: "game2" });
      await adapter.create("game3", { id: "game3" });

      const ids = await adapter.getAllIds();
      expect(ids).toHaveLength(3);
      expect(ids).toContain("game1");
      expect(ids).toContain("game2");
      expect(ids).toContain("game3");
    });

    test("should count games", async () => {
      expect(await adapter.count()).toBe(0);

      await adapter.create("game1", { id: "game1" });
      expect(await adapter.count()).toBe(1);

      await adapter.create("game2", { id: "game2" });
      expect(await adapter.count()).toBe(2);

      await adapter.delete("game1");
      expect(await adapter.count()).toBe(1);
    });

    test("should get all games as Map", async () => {
      await adapter.create("game1", { id: "game1" });
      await adapter.create("game2", { id: "game2" });

      const allGames = await adapter.getAll();
      expect(allGames instanceof Map).toBe(true);
      expect(allGames.size).toBe(2);
    });
  });

  describe("stats", () => {
    test("should return stats", async () => {
      await adapter.create("game1", { id: "game1" });

      const stats = adapter.getStats();
      expect(stats.mode).toBe("memory");
      expect(stats.gameCount).toBe(1);
    });
  });

  describe("cleanup", () => {
    test("should clear all games on close", async () => {
      await adapter.create("game1", { id: "game1" });
      await adapter.create("game2", { id: "game2" });

      await adapter.close();

      expect(await adapter.count()).toBe(0);
    });
  });
});

describe("createGameStateAdapter", () => {
  test("should create memory adapter by default", () => {
    const adapter = createGameStateAdapter({});
    expect(adapter).toBeInstanceOf(MemoryGameStateAdapter);
  });

  test("should create memory adapter when redis is not provided", () => {
    const adapter = createGameStateAdapter({ redisPrimary: true });
    expect(adapter).toBeInstanceOf(MemoryGameStateAdapter);
  });

  test("should throw if redis primary without session factory", () => {
    const mockRedis = {};
    expect(() => {
      createGameStateAdapter({
        redisPrimary: true,
        redis: mockRedis,
      });
    }).toThrow("sessionFactory is required");
  });
});
