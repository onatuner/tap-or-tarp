/**
 * Cleanup Tests
 *
 * Tests for session cleanup functionality.
 */

const WebSocket = require("ws");
const { CasualGameSession } = require("../lib/game-modes");
const { CONSTANTS } = require("../lib/shared/constants");

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
  recordStorageOperation: jest.fn(),
}));

jest.mock("../lib/lock", () => ({
  withGameLock: jest.fn((gameId, fn) => fn()),
}));

jest.mock("../lib/server/persistence", () => ({
  ensureGameLoaded: jest.fn(),
}));

// Create mock serverState
const mockServerState = {
  gameSessions: new Map(),
  storage: null,
  isAsyncStorageMode: false,
  isRedisPrimaryMode: false,
  wss: null,
  getSession: jest.fn(id => mockServerState.gameSessions.get(id)),
  setSession: jest.fn((id, session) => mockServerState.gameSessions.set(id, session)),
  getSessionCount: jest.fn(() => mockServerState.gameSessions.size),
  getAllSessions: jest.fn(() => mockServerState.gameSessions.entries()),
};

jest.mock("../lib/server/state", () => ({
  serverState: mockServerState,
}));

// Import after mocking
const { cleanupSessions, handleClientDisconnect, shouldCleanupSession } = require("../lib/server/cleanup");
const { ensureGameLoaded } = require("../lib/server/persistence");
const metrics = require("../lib/metrics");

describe("Cleanup", () => {
  let session;

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset mock state
    mockServerState.gameSessions.clear();
    mockServerState.storage = null;
    mockServerState.isAsyncStorageMode = false;
    mockServerState.isRedisPrimaryMode = false;
    mockServerState.wss = {
      clients: new Set(),
    };

    session = new CasualGameSession("TEST01", { playerCount: 2 });
    session.lastActivity = Date.now();
    mockServerState.gameSessions.set("TEST01", session);
  });

  afterEach(() => {
    session.cleanup();
  });

  describe("shouldCleanupSession", () => {
    test("should return false for active session with connected clients", () => {
      const mockClient = { gameId: "TEST01", readyState: WebSocket.OPEN };
      mockServerState.wss.clients.add(mockClient);
      session.lastActivity = Date.now();

      const result = shouldCleanupSession("TEST01", session);

      expect(result).toBe(false);
    });

    test("should return true for empty session past threshold", () => {
      session.lastActivity = Date.now() - CONSTANTS.EMPTY_SESSION_THRESHOLD - 1000;

      const result = shouldCleanupSession("TEST01", session);

      expect(result).toBe(true);
    });

    test("should return true for inactive session past threshold even with clients", () => {
      const mockClient = { gameId: "TEST01", readyState: WebSocket.OPEN };
      mockServerState.wss.clients.add(mockClient);
      session.lastActivity = Date.now() - CONSTANTS.INACTIVE_SESSION_THRESHOLD - 1000;

      const result = shouldCleanupSession("TEST01", session);

      expect(result).toBe(true);
    });

    test("should not count closed clients", () => {
      const mockClient = { gameId: "TEST01", readyState: WebSocket.CLOSED };
      mockServerState.wss.clients.add(mockClient);
      session.lastActivity = Date.now() - CONSTANTS.EMPTY_SESSION_THRESHOLD - 1000;

      const result = shouldCleanupSession("TEST01", session);

      expect(result).toBe(true);
    });

    test("should not count clients from other games", () => {
      const mockClient = { gameId: "OTHER01", readyState: WebSocket.OPEN };
      mockServerState.wss.clients.add(mockClient);
      session.lastActivity = Date.now() - CONSTANTS.EMPTY_SESSION_THRESHOLD - 1000;

      const result = shouldCleanupSession("TEST01", session);

      expect(result).toBe(true);
    });

    test("should handle null wss gracefully", () => {
      mockServerState.wss = null;
      session.lastActivity = Date.now() - CONSTANTS.EMPTY_SESSION_THRESHOLD - 1000;

      const result = shouldCleanupSession("TEST01", session);

      expect(result).toBe(true);
    });
  });

  describe("cleanupSessions", () => {
    test("should not cleanup active sessions", async () => {
      const mockClient = { gameId: "TEST01", readyState: WebSocket.OPEN };
      mockServerState.wss.clients.add(mockClient);
      session.lastActivity = Date.now();

      await cleanupSessions();

      expect(mockServerState.gameSessions.has("TEST01")).toBe(true);
    });

    test("should cleanup inactive empty sessions", async () => {
      session.lastActivity = Date.now() - CONSTANTS.EMPTY_SESSION_THRESHOLD - 1000;

      await cleanupSessions();

      expect(mockServerState.gameSessions.has("TEST01")).toBe(false);
    });

    test("should mark session as closed and save to sync storage", async () => {
      const mockStorage = {
        save: jest.fn(),
      };
      mockServerState.storage = mockStorage;
      session.lastActivity = Date.now() - CONSTANTS.EMPTY_SESSION_THRESHOLD - 1000;

      await cleanupSessions();

      // Session should be marked as closed and saved
      expect(mockStorage.save).toHaveBeenCalledWith(
        "TEST01",
        expect.objectContaining({ isClosed: true })
      );
    });

    test("should mark session as closed and save to async storage", async () => {
      const mockStorage = {
        save: jest.fn(() => Promise.resolve()),
      };
      mockServerState.storage = mockStorage;
      mockServerState.isAsyncStorageMode = true;
      session.lastActivity = Date.now() - CONSTANTS.EMPTY_SESSION_THRESHOLD - 1000;

      await cleanupSessions();

      // Session should be marked as closed and saved
      expect(mockStorage.save).toHaveBeenCalledWith(
        "TEST01",
        expect.objectContaining({ isClosed: true })
      );
    });

    test("should unsubscribe from channels on async storage", async () => {
      const mockStorage = {
        save: jest.fn(() => Promise.resolve()),
        unsubscribe: jest.fn(() => Promise.resolve()),
      };
      mockServerState.storage = mockStorage;
      mockServerState.isAsyncStorageMode = true;
      session.lastActivity = Date.now() - CONSTANTS.EMPTY_SESSION_THRESHOLD - 1000;

      await cleanupSessions();

      expect(mockStorage.unsubscribe).toHaveBeenCalledWith("broadcast:TEST01");
    });

    test("should handle storage save errors gracefully during cleanup", async () => {
      const mockStorage = {
        save: jest.fn(() => {
          throw new Error("Save failed");
        }),
      };
      mockServerState.storage = mockStorage;
      session.lastActivity = Date.now() - CONSTANTS.EMPTY_SESSION_THRESHOLD - 1000;

      // Should not throw - handles error gracefully
      await cleanupSessions();

      // Session should still be removed from memory
      expect(mockServerState.gameSessions.has("TEST01")).toBe(false);
    });

    test("should cleanup session interval", async () => {
      session.start();
      expect(session.interval).not.toBe(null);
      session.lastActivity = Date.now() - CONSTANTS.EMPTY_SESSION_THRESHOLD - 1000;

      await cleanupSessions();

      expect(session.interval).toBe(null);
    });

    test("should cleanup multiple sessions", async () => {
      const session2 = new CasualGameSession("TEST02", { playerCount: 2 });
      session2.lastActivity = Date.now() - CONSTANTS.EMPTY_SESSION_THRESHOLD - 1000;
      mockServerState.gameSessions.set("TEST02", session2);

      session.lastActivity = Date.now() - CONSTANTS.EMPTY_SESSION_THRESHOLD - 1000;

      await cleanupSessions();

      expect(mockServerState.gameSessions.size).toBe(0);
    });
  });

  describe("handleClientDisconnect", () => {
    let mockWs;

    beforeEach(() => {
      mockWs = {
        clientId: "client-123",
        gameId: "TEST01",
      };
      session.claimPlayer(1, "client-123");
    });

    test("should unclaim players for disconnected client", async () => {
      await handleClientDisconnect(mockWs);

      expect(session.players[0].claimedBy).toBe(null);
    });

    test("should do nothing if no gameId", async () => {
      mockWs.gameId = null;

      await handleClientDisconnect(mockWs);

      expect(session.players[0].claimedBy).toBe("client-123");
    });

    test("should do nothing if session not found", async () => {
      mockWs.gameId = "NOTFOUND";

      await handleClientDisconnect(mockWs);

      // Should not throw
    });

    test("should auto-pause running game when no clients connected", async () => {
      session.start();
      expect(session.status).toBe("running");

      await handleClientDisconnect(mockWs);

      expect(session.status).toBe("paused");
    });

    test("should not auto-pause if clients still connected", async () => {
      const otherClient = { gameId: "TEST01", readyState: WebSocket.OPEN };
      mockServerState.wss.clients.add(otherClient);
      session.start();

      await handleClientDisconnect(mockWs);

      expect(session.status).toBe("running");
    });

    test("should not auto-pause if game not running", async () => {
      expect(session.status).toBe("waiting");

      await handleClientDisconnect(mockWs);

      expect(session.status).toBe("waiting");
    });

    test("should load session from Redis if in Redis primary mode", async () => {
      mockServerState.gameSessions.delete("TEST01");
      mockServerState.isRedisPrimaryMode = true;
      ensureGameLoaded.mockResolvedValueOnce(session);

      await handleClientDisconnect(mockWs);

      expect(ensureGameLoaded).toHaveBeenCalledWith("TEST01");
    });

    test("should handle errors gracefully", async () => {
      const { withGameLock } = require("../lib/lock");
      withGameLock.mockRejectedValueOnce(new Error("Lock failed"));

      await handleClientDisconnect(mockWs);

      // Should not throw
    });
  });
});
