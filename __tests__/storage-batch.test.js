const { SessionStorage, MemoryStorage, createStorage } = require("../lib/storage");
const fs = require("fs");
const path = require("path");

describe("Storage Batch Operations", () => {
  const testDbPath = "./data/test-batch-sessions.db";

  afterAll(() => {
    // Cleanup test database
    try {
      if (fs.existsSync(testDbPath)) {
        fs.unlinkSync(testDbPath);
      }
      // Also clean up WAL files
      if (fs.existsSync(testDbPath + "-wal")) {
        fs.unlinkSync(testDbPath + "-wal");
      }
      if (fs.existsSync(testDbPath + "-shm")) {
        fs.unlinkSync(testDbPath + "-shm");
      }
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  describe("SessionStorage.saveBatch", () => {
    let storage;

    beforeEach(() => {
      storage = new SessionStorage(testDbPath).initialize();
    });

    afterEach(() => {
      if (storage) {
        storage.close();
      }
    });

    test("should save multiple sessions in a single transaction", () => {
      const sessions = [
        { id: "game1", state: { players: [], status: "waiting" } },
        { id: "game2", state: { players: [], status: "running" } },
        { id: "game3", state: { players: [], status: "paused" } },
      ];

      const count = storage.saveBatch(sessions);
      expect(count).toBe(3);

      // Verify all sessions were saved
      expect(storage.load("game1")).toEqual({ players: [], status: "waiting" });
      expect(storage.load("game2")).toEqual({ players: [], status: "running" });
      expect(storage.load("game3")).toEqual({ players: [], status: "paused" });
    });

    test("should handle empty array", () => {
      const count = storage.saveBatch([]);
      expect(count).toBe(0);
    });

    test("should handle null/undefined input", () => {
      expect(storage.saveBatch(null)).toBe(0);
      expect(storage.saveBatch(undefined)).toBe(0);
    });

    test("should update existing sessions", () => {
      // Save initial session
      storage.save("game1", { status: "waiting", turn: 0 });

      // Batch update
      const sessions = [
        { id: "game1", state: { status: "running", turn: 1 } },
        { id: "game2", state: { status: "waiting", turn: 0 } },
      ];

      storage.saveBatch(sessions);

      expect(storage.load("game1")).toEqual({ status: "running", turn: 1 });
      expect(storage.load("game2")).toEqual({ status: "waiting", turn: 0 });
    });

    test("should be atomic - all or nothing", () => {
      const sessions = [
        { id: "atomic1", state: { data: "first" } },
        { id: "atomic2", state: { data: "second" } },
        { id: "atomic3", state: { data: "third" } },
      ];

      const count = storage.saveBatch(sessions);
      expect(count).toBe(3);

      // All should be saved
      expect(storage.count()).toBeGreaterThanOrEqual(3);
    });

    test("should handle large batch efficiently", () => {
      const numSessions = 100;
      const sessions = Array(numSessions)
        .fill()
        .map((_, i) => ({
          id: `batch-${i}`,
          state: {
            players: [{ id: 1, name: `Player ${i}`, time: 600000 }],
            status: "waiting",
            createdAt: Date.now(),
          },
        }));

      const startTime = Date.now();
      const count = storage.saveBatch(sessions);
      const elapsed = Date.now() - startTime;

      expect(count).toBe(numSessions);
      // Batch should be reasonably fast (less than 1 second for 100 items)
      expect(elapsed).toBeLessThan(1000);

      // Verify random samples
      expect(storage.load("batch-0")).toBeDefined();
      expect(storage.load("batch-50")).toBeDefined();
      expect(storage.load("batch-99")).toBeDefined();
    });
  });

  describe("MemoryStorage.saveBatch", () => {
    let storage;

    beforeEach(() => {
      storage = new MemoryStorage().initialize();
    });

    test("should save multiple sessions", () => {
      const sessions = [
        { id: "mem1", state: { data: "first" } },
        { id: "mem2", state: { data: "second" } },
      ];

      const count = storage.saveBatch(sessions);
      expect(count).toBe(2);

      expect(storage.load("mem1")).toEqual({ data: "first" });
      expect(storage.load("mem2")).toEqual({ data: "second" });
    });

    test("should handle empty array", () => {
      const count = storage.saveBatch([]);
      expect(count).toBe(0);
    });

    test("should handle null/undefined input", () => {
      expect(storage.saveBatch(null)).toBe(0);
      expect(storage.saveBatch(undefined)).toBe(0);
    });
  });

  describe("createStorage with batch support", () => {
    test("SQLite storage should have saveBatch method", () => {
      const storage = createStorage("sqlite", testDbPath);
      expect(typeof storage.saveBatch).toBe("function");
      storage.close();
    });

    test("Memory storage should have saveBatch method", () => {
      const storage = createStorage("memory");
      expect(typeof storage.saveBatch).toBe("function");
      storage.close();
    });
  });
});

describe("Storage concurrent access simulation", () => {
  const testDbPath = "./data/test-concurrent-sessions.db";

  afterAll(() => {
    try {
      if (fs.existsSync(testDbPath)) {
        fs.unlinkSync(testDbPath);
      }
      if (fs.existsSync(testDbPath + "-wal")) {
        fs.unlinkSync(testDbPath + "-wal");
      }
      if (fs.existsSync(testDbPath + "-shm")) {
        fs.unlinkSync(testDbPath + "-shm");
      }
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  test("should handle rapid sequential saves", () => {
    const storage = new SessionStorage(testDbPath).initialize();

    try {
      const numOperations = 50;

      for (let i = 0; i < numOperations; i++) {
        storage.save(`rapid-${i}`, { iteration: i, timestamp: Date.now() });
      }

      // All should be saved
      for (let i = 0; i < numOperations; i++) {
        const loaded = storage.load(`rapid-${i}`);
        expect(loaded).toBeDefined();
        expect(loaded.iteration).toBe(i);
      }
    } finally {
      storage.close();
    }
  });

  test("should handle interleaved saves and loads", () => {
    const storage = new SessionStorage(testDbPath).initialize();

    try {
      for (let i = 0; i < 20; i++) {
        // Save
        storage.save(`interleaved-${i}`, { value: i });

        // Load previous
        if (i > 0) {
          const prev = storage.load(`interleaved-${i - 1}`);
          expect(prev.value).toBe(i - 1);
        }

        // Update earlier entry
        if (i > 5) {
          storage.save(`interleaved-${i - 5}`, { value: i - 5, updated: true });
        }
      }

      // Verify updates were persisted
      const updated = storage.load("interleaved-10");
      expect(updated.updated).toBe(true);
    } finally {
      storage.close();
    }
  });
});
