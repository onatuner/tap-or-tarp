/**
 * Persistence Tests
 *
 * Tests for session persistence functionality.
 */

const { CasualGameSession } = require("../lib/game-modes");

// Mock dependencies
jest.mock("../lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../lib/metrics", () => ({
  startStorageSaveTimer: jest.fn(() => jest.fn()),
  recordStorageOperation: jest.fn(),
  recordRestoredSession: jest.fn(),
  recordError: jest.fn(),
}));

jest.mock("../lib/server/websocket", () => ({
  broadcastToGame: jest.fn(() => Promise.resolve()),
  subscribeToGameChannel: jest.fn(() => Promise.resolve()),
}));

// Create mock serverState
const mockServerState = {
  gameSessions: new Map(),
  storage: null,
  isAsyncStorageMode: false,
  isRedisPrimaryMode: false,
  isShuttingDown: false,
  getSession: jest.fn(id => mockServerState.gameSessions.get(id)),
  setSession: jest.fn((id, session) => mockServerState.gameSessions.set(id, session)),
  hasSession: jest.fn(id => mockServerState.gameSessions.has(id)),
  getAllSessions: jest.fn(() => mockServerState.gameSessions.entries()),
  getSessionCount: jest.fn(() => mockServerState.gameSessions.size),
};

jest.mock("../lib/server/state", () => ({
  serverState: mockServerState,
}));

// Import after mocking
const {
  persistSessions,
  persistGameImmediately,
  syncGameToRedis,
  ensureGameLoaded,
  loadSessions,
} = require("../lib/server/persistence");
const metrics = require("../lib/metrics");

describe("Persistence", () => {
  let session;

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset mock state
    mockServerState.gameSessions.clear();
    mockServerState.storage = null;
    mockServerState.isAsyncStorageMode = false;
    mockServerState.isRedisPrimaryMode = false;
    mockServerState.isShuttingDown = false;

    session = new CasualGameSession("TEST01", { playerCount: 2 });
    mockServerState.gameSessions.set("TEST01", session);
  });

  afterEach(() => {
    session.cleanup();
  });

  describe("persistSessions", () => {
    test("should do nothing if storage not configured", async () => {
      mockServerState.storage = null;

      await persistSessions();

      expect(metrics.startStorageSaveTimer).not.toHaveBeenCalled();
    });

    test("should do nothing if shutting down", async () => {
      mockServerState.storage = { save: jest.fn() };
      mockServerState.isShuttingDown = true;

      await persistSessions();

      expect(mockServerState.storage.save).not.toHaveBeenCalled();
    });

    test("should save sessions with sync storage", async () => {
      const mockStorage = {
        save: jest.fn(),
      };
      mockServerState.storage = mockStorage;

      await persistSessions();

      expect(mockStorage.save).toHaveBeenCalledWith("TEST01", expect.any(Object));
      expect(metrics.recordStorageOperation).toHaveBeenCalledWith("save", "success");
    });

    test("should use batch save when available", async () => {
      const mockStorage = {
        saveBatch: jest.fn(() => 1),
      };
      mockServerState.storage = mockStorage;

      await persistSessions();

      expect(mockStorage.saveBatch).toHaveBeenCalledWith([
        { id: "TEST01", state: expect.any(Object) },
      ]);
    });

    test("should fallback to individual saves on partial batch", async () => {
      const mockStorage = {
        saveBatch: jest.fn(() => 0), // Returns 0, indicating partial save
        save: jest.fn(),
      };
      mockServerState.storage = mockStorage;

      await persistSessions();

      expect(mockStorage.save).toHaveBeenCalled();
    });

    test("should save individually for async storage", async () => {
      const mockStorage = {
        save: jest.fn(() => Promise.resolve()),
      };
      mockServerState.storage = mockStorage;
      mockServerState.isAsyncStorageMode = true;

      await persistSessions();

      expect(mockStorage.save).toHaveBeenCalledWith("TEST01", expect.any(Object));
    });

    test("should handle save errors gracefully", async () => {
      const mockStorage = {
        save: jest.fn(() => {
          throw new Error("Save failed");
        }),
      };
      mockServerState.storage = mockStorage;

      await persistSessions();

      expect(metrics.recordStorageOperation).toHaveBeenCalledWith("save", "error");
    });
  });

  describe("persistGameImmediately", () => {
    test("should do nothing if storage not configured", async () => {
      mockServerState.storage = null;

      await persistGameImmediately("TEST01");

      // Should not throw
    });

    test("should do nothing if shutting down", async () => {
      mockServerState.storage = { save: jest.fn() };
      mockServerState.isShuttingDown = true;

      await persistGameImmediately("TEST01");

      expect(mockServerState.storage.save).not.toHaveBeenCalled();
    });

    test("should do nothing if session not found", async () => {
      mockServerState.storage = { save: jest.fn() };

      await persistGameImmediately("NOTFOUND");

      expect(mockServerState.storage.save).not.toHaveBeenCalled();
    });

    test("should save session synchronously for sync storage", async () => {
      const mockStorage = { save: jest.fn() };
      mockServerState.storage = mockStorage;

      await persistGameImmediately("TEST01");

      expect(mockStorage.save).toHaveBeenCalledWith("TEST01", expect.any(Object));
      expect(metrics.recordStorageOperation).toHaveBeenCalledWith("save_immediate", "success");
    });

    test("should save session asynchronously for async storage", async () => {
      const mockStorage = { save: jest.fn(() => Promise.resolve()) };
      mockServerState.storage = mockStorage;
      mockServerState.isAsyncStorageMode = true;

      await persistGameImmediately("TEST01");

      expect(mockStorage.save).toHaveBeenCalledWith("TEST01", expect.any(Object));
    });

    test("should handle save errors", async () => {
      const mockStorage = {
        save: jest.fn(() => {
          throw new Error("Save failed");
        }),
      };
      mockServerState.storage = mockStorage;

      await persistGameImmediately("TEST01");

      expect(metrics.recordStorageOperation).toHaveBeenCalledWith("save_immediate", "error");
    });
  });

  describe("syncGameToRedis", () => {
    test("should do nothing if not Redis primary mode", async () => {
      mockServerState.storage = { save: jest.fn() };
      mockServerState.isRedisPrimaryMode = false;

      await syncGameToRedis("TEST01");

      expect(mockServerState.storage.save).not.toHaveBeenCalled();
    });

    test("should do nothing if storage not configured", async () => {
      mockServerState.isRedisPrimaryMode = true;
      mockServerState.storage = null;

      await syncGameToRedis("TEST01");

      // Should not throw
    });

    test("should do nothing if shutting down", async () => {
      mockServerState.storage = { save: jest.fn() };
      mockServerState.isRedisPrimaryMode = true;
      mockServerState.isShuttingDown = true;

      await syncGameToRedis("TEST01");

      expect(mockServerState.storage.save).not.toHaveBeenCalled();
    });

    test("should do nothing if session not found", async () => {
      mockServerState.storage = { save: jest.fn() };
      mockServerState.isRedisPrimaryMode = true;

      await syncGameToRedis("NOTFOUND");

      expect(mockServerState.storage.save).not.toHaveBeenCalled();
    });

    test("should save to Redis when configured", async () => {
      const mockStorage = { save: jest.fn(() => Promise.resolve()) };
      mockServerState.storage = mockStorage;
      mockServerState.isRedisPrimaryMode = true;

      await syncGameToRedis("TEST01");

      expect(mockStorage.save).toHaveBeenCalledWith("TEST01", expect.any(Object));
    });

    test("should handle save errors gracefully", async () => {
      const mockStorage = {
        save: jest.fn(() => Promise.reject(new Error("Redis error"))),
      };
      mockServerState.storage = mockStorage;
      mockServerState.isRedisPrimaryMode = true;

      await syncGameToRedis("TEST01");

      // Should not throw, just log error
    });
  });

  describe("ensureGameLoaded", () => {
    test("should return session from local cache if available", async () => {
      const result = await ensureGameLoaded("TEST01");

      expect(result).toBe(session);
    });

    test("should return null if no storage and not in cache", async () => {
      mockServerState.storage = null;

      const result = await ensureGameLoaded("NOTFOUND");

      expect(result).toBe(null);
    });

    test("should load from sync storage if not in cache", async () => {
      const savedState = {
        id: "LOADED01",
        mode: "casual",
        players: [],
        settings: { playerCount: 2 },
      };
      const mockStorage = {
        load: jest.fn(() => savedState),
      };
      mockServerState.storage = mockStorage;

      const result = await ensureGameLoaded("LOADED01");

      expect(result).toBeDefined();
      expect(result.id).toBe("LOADED01");
      expect(mockStorage.load).toHaveBeenCalledWith("LOADED01");
    });

    test("should load from async storage if not in cache", async () => {
      const savedState = {
        id: "LOADED02",
        mode: "casual",
        players: [],
        settings: { playerCount: 2 },
      };
      const mockStorage = {
        load: jest.fn(() => Promise.resolve(savedState)),
      };
      mockServerState.storage = mockStorage;
      mockServerState.isAsyncStorageMode = true;

      const result = await ensureGameLoaded("LOADED02");

      expect(result).toBeDefined();
      expect(result.id).toBe("LOADED02");
    });

    test("should return null if not found in storage", async () => {
      const mockStorage = {
        load: jest.fn(() => null),
      };
      mockServerState.storage = mockStorage;

      const result = await ensureGameLoaded("NOTFOUND");

      expect(result).toBe(null);
    });

    test("should handle load errors gracefully", async () => {
      const mockStorage = {
        load: jest.fn(() => {
          throw new Error("Load failed");
        }),
      };
      mockServerState.storage = mockStorage;

      const result = await ensureGameLoaded("ERROR01");

      expect(result).toBe(null);
    });
  });

  describe("loadSessions", () => {
    test("should do nothing if no storage", async () => {
      mockServerState.storage = null;

      await loadSessions();

      // Should not throw
    });

    test("should load all sessions from sync storage", async () => {
      const savedSessions = [
        {
          id: "LOAD01",
          state: { id: "LOAD01", mode: "casual", players: [], settings: { playerCount: 2 } },
        },
        {
          id: "LOAD02",
          state: { id: "LOAD02", mode: "casual", players: [], settings: { playerCount: 3 } },
        },
      ];
      const mockStorage = {
        loadAll: jest.fn(() => savedSessions),
      };
      mockServerState.storage = mockStorage;
      mockServerState.gameSessions.clear();

      await loadSessions();

      expect(mockStorage.loadAll).toHaveBeenCalled();
      expect(mockServerState.setSession).toHaveBeenCalledTimes(2);
      expect(metrics.recordRestoredSession).toHaveBeenCalledTimes(2);
    });

    test("should load all sessions from async storage", async () => {
      const savedSessions = [
        {
          id: "ASYNC01",
          state: { id: "ASYNC01", mode: "casual", players: [], settings: { playerCount: 2 } },
        },
      ];
      const mockStorage = {
        loadAll: jest.fn(() => Promise.resolve(savedSessions)),
      };
      mockServerState.storage = mockStorage;
      mockServerState.isAsyncStorageMode = true;
      mockServerState.gameSessions.clear();

      await loadSessions();

      expect(mockStorage.loadAll).toHaveBeenCalled();
    });

    test("should handle restore errors for individual sessions", async () => {
      const savedSessions = [
        {
          id: "GOOD01",
          state: { id: "GOOD01", mode: "casual", players: [], settings: { playerCount: 2 } },
        },
        {
          id: "BAD01",
          state: {}, // Missing required id field will cause fromState to throw
        },
      ];
      const mockStorage = {
        loadAll: jest.fn(() => savedSessions),
      };
      mockServerState.storage = mockStorage;
      mockServerState.gameSessions.clear();

      await loadSessions();

      // Should continue loading despite errors - the missing id will cause restoration to fail
      expect(metrics.recordStorageOperation).toHaveBeenCalledWith("load", "error");
    });

    test("should filter out sessions with null state", async () => {
      const savedSessions = [
        {
          id: "GOOD01",
          state: { id: "GOOD01", mode: "casual", players: [], settings: { playerCount: 2 } },
        },
        {
          id: "BAD01",
          state: null, // Null state should be filtered out
        },
      ];
      const mockStorage = {
        loadAll: jest.fn(() => savedSessions),
      };
      mockServerState.storage = mockStorage;
      mockServerState.gameSessions.clear();

      await loadSessions();

      // Only the good session should be loaded, null state is filtered out
      expect(mockServerState.gameSessions.size).toBe(1);
      expect(mockServerState.gameSessions.has("GOOD01")).toBe(true);
      expect(mockServerState.gameSessions.has("BAD01")).toBe(false);
    });

    test("should handle loadAll errors gracefully", async () => {
      const mockStorage = {
        loadAll: jest.fn(() => {
          throw new Error("LoadAll failed");
        }),
      };
      mockServerState.storage = mockStorage;

      await loadSessions();

      expect(metrics.recordError).toHaveBeenCalledWith("session_load_failed");
    });
  });
});
