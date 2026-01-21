const { MemoryStorage, createStorage } = require("../lib/storage");

describe("MemoryStorage", () => {
  let storage;

  beforeEach(() => {
    storage = new MemoryStorage().initialize();
  });

  afterEach(() => {
    storage.close();
  });

  describe("initialize", () => {
    test("should return self for chaining", () => {
      const newStorage = new MemoryStorage();
      expect(newStorage.initialize()).toBe(newStorage);
    });
  });

  describe("save and load", () => {
    test("should save and load a session", () => {
      const sessionState = {
        id: "TEST01",
        players: [{ id: 1, name: "Player 1" }],
        status: "waiting",
      };

      storage.save("TEST01", sessionState);
      const loaded = storage.load("TEST01");

      expect(loaded).toEqual(sessionState);
    });

    test("should return null for non-existent session", () => {
      expect(storage.load("NONEXISTENT")).toBeNull();
    });

    test("should overwrite existing session", () => {
      storage.save("TEST01", { id: "TEST01", status: "waiting" });
      storage.save("TEST01", { id: "TEST01", status: "running" });

      const loaded = storage.load("TEST01");
      expect(loaded.status).toBe("running");
    });

    test("should deep clone saved state", () => {
      const sessionState = {
        id: "TEST01",
        players: [{ id: 1, name: "Player 1" }],
      };

      storage.save("TEST01", sessionState);
      sessionState.players[0].name = "Modified";

      const loaded = storage.load("TEST01");
      expect(loaded.players[0].name).toBe("Player 1");
    });
  });

  describe("loadAll", () => {
    test("should return empty array when no sessions", () => {
      expect(storage.loadAll()).toEqual([]);
    });

    test("should return all sessions", () => {
      storage.save("TEST01", { id: "TEST01" });
      storage.save("TEST02", { id: "TEST02" });
      storage.save("TEST03", { id: "TEST03" });

      const all = storage.loadAll();
      expect(all).toHaveLength(3);
      expect(all.map(s => s.id).sort()).toEqual(["TEST01", "TEST02", "TEST03"]);
    });
  });

  describe("delete", () => {
    test("should delete existing session", () => {
      storage.save("TEST01", { id: "TEST01" });
      storage.delete("TEST01");

      expect(storage.load("TEST01")).toBeNull();
    });

    test("should not throw when deleting non-existent session", () => {
      expect(() => storage.delete("NONEXISTENT")).not.toThrow();
    });
  });

  describe("cleanup", () => {
    test("should delete sessions older than maxAge", () => {
      // Save a session
      storage.save("OLD", { id: "OLD" });

      // Manually set updatedAt to be old
      storage.sessions.get("OLD").updatedAt = Date.now() - 10000;

      // Save a recent session
      storage.save("NEW", { id: "NEW" });

      // Cleanup sessions older than 5 seconds
      const deleted = storage.cleanup(5000);

      expect(deleted).toBe(1);
      expect(storage.load("OLD")).toBeNull();
      expect(storage.load("NEW")).not.toBeNull();
    });

    test("should return count of deleted sessions", () => {
      storage.save("S1", { id: "S1" });
      storage.save("S2", { id: "S2" });
      storage.save("S3", { id: "S3" });

      // Make all sessions old
      for (const data of storage.sessions.values()) {
        data.updatedAt = Date.now() - 10000;
      }

      const deleted = storage.cleanup(5000);
      expect(deleted).toBe(3);
    });
  });

  describe("count", () => {
    test("should return 0 for empty storage", () => {
      expect(storage.count()).toBe(0);
    });

    test("should return correct count", () => {
      storage.save("TEST01", { id: "TEST01" });
      storage.save("TEST02", { id: "TEST02" });

      expect(storage.count()).toBe(2);
    });

    test("should update after delete", () => {
      storage.save("TEST01", { id: "TEST01" });
      storage.save("TEST02", { id: "TEST02" });
      storage.delete("TEST01");

      expect(storage.count()).toBe(1);
    });
  });

  describe("close", () => {
    test("should clear all sessions", () => {
      storage.save("TEST01", { id: "TEST01" });
      storage.close();

      expect(storage.count()).toBe(0);
    });
  });
});

describe("createStorage", () => {
  test("should create MemoryStorage when type is memory", () => {
    const storage = createStorage("memory");
    expect(storage).toBeInstanceOf(MemoryStorage);
    storage.close();
  });

  test("should create storage with valid SQLite path", () => {
    // Use a temp path that should work
    const storage = createStorage("sqlite", "./data/test-sessions.db");
    // Should create either SQLite or fall back to Memory
    expect(storage).toBeDefined();
    expect(typeof storage.save).toBe("function");
    expect(typeof storage.load).toBe("function");
    expect(typeof storage.close).toBe("function");
    storage.close();
  });
});
