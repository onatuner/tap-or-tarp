/**
 * Server State Tests
 *
 * Tests for the ServerState singleton and session management.
 */

const { ServerState } = require("../lib/server/state");
const { CasualGameSession } = require("../lib/game-modes");

describe("ServerState", () => {
  let serverState;

  beforeEach(() => {
    serverState = new ServerState();
  });

  afterEach(() => {
    // Cleanup any sessions
    serverState.cleanupAllSessions();
    serverState.clearTimers();
  });

  describe("constructor", () => {
    test("should initialize with empty sessions map", () => {
      expect(serverState.gameSessions.size).toBe(0);
    });

    test("should initialize with null storage", () => {
      expect(serverState.storage).toBe(null);
    });

    test("should initialize flags to false", () => {
      expect(serverState.isAsyncStorageMode).toBe(false);
      expect(serverState.isRedisPrimaryMode).toBe(false);
      expect(serverState.isShuttingDown).toBe(false);
    });

    test("should initialize timers to null", () => {
      expect(serverState.persistenceTimer).toBe(null);
      expect(serverState.cleanupTimer).toBe(null);
      expect(serverState.heartbeatTimer).toBe(null);
    });

    test("should generate unique instance ID", () => {
      expect(serverState.instanceId).toBeDefined();
      expect(typeof serverState.instanceId).toBe("string");
    });

    test("should use environment variables for instance ID if available", () => {
      const originalEnv = process.env.FLY_ALLOC_ID;
      process.env.FLY_ALLOC_ID = "fly-123";

      const state = new ServerState();
      expect(state.instanceId).toBe("fly-123");

      process.env.FLY_ALLOC_ID = originalEnv;
    });
  });

  describe("setStorage", () => {
    test("should set storage and flags", () => {
      const mockStorage = { save: jest.fn() };
      serverState.setStorage(mockStorage, true, true);

      expect(serverState.storage).toBe(mockStorage);
      expect(serverState.isAsyncStorageMode).toBe(true);
      expect(serverState.isRedisPrimaryMode).toBe(true);
    });

    test("should default flags to false", () => {
      const mockStorage = { save: jest.fn() };
      serverState.setStorage(mockStorage);

      expect(serverState.isAsyncStorageMode).toBe(false);
      expect(serverState.isRedisPrimaryMode).toBe(false);
    });
  });

  describe("setWebSocketServer", () => {
    test("should store WebSocket server reference", () => {
      const mockWss = { clients: new Set() };
      serverState.setWebSocketServer(mockWss);

      expect(serverState.wss).toBe(mockWss);
    });
  });

  describe("generateClientId", () => {
    test("should generate unique client IDs", () => {
      const id1 = serverState.generateClientId();
      const id2 = serverState.generateClientId();

      expect(id1).not.toBe(id2);
    });

    test("should start with 'client_' prefix", () => {
      const id = serverState.generateClientId();
      expect(id.startsWith("client_")).toBe(true);
    });

    test("should include timestamp", () => {
      const id = serverState.generateClientId();
      const parts = id.split("_");
      expect(parts.length).toBe(3);
      expect(Number(parts[1])).toBeGreaterThan(0);
    });
  });

  describe("session management", () => {
    let session;

    beforeEach(() => {
      session = new CasualGameSession("TEST01", { playerCount: 2 });
    });

    afterEach(() => {
      session.cleanup();
    });

    describe("setSession", () => {
      test("should add session to map", () => {
        serverState.setSession("TEST01", session);
        expect(serverState.gameSessions.has("TEST01")).toBe(true);
      });
    });

    describe("getSession", () => {
      test("should return session by ID", () => {
        serverState.setSession("TEST01", session);
        expect(serverState.getSession("TEST01")).toBe(session);
      });

      test("should return undefined for non-existent session", () => {
        expect(serverState.getSession("NOTFOUND")).toBeUndefined();
      });
    });

    describe("hasSession", () => {
      test("should return true for existing session", () => {
        serverState.setSession("TEST01", session);
        expect(serverState.hasSession("TEST01")).toBe(true);
      });

      test("should return false for non-existent session", () => {
        expect(serverState.hasSession("NOTFOUND")).toBe(false);
      });
    });

    describe("deleteSession", () => {
      test("should remove session from map", () => {
        serverState.setSession("TEST01", session);
        const result = serverState.deleteSession("TEST01");

        expect(result).toBe(true);
        expect(serverState.hasSession("TEST01")).toBe(false);
      });

      test("should cleanup session before deleting", () => {
        serverState.setSession("TEST01", session);
        session.start(); // Creates interval

        serverState.deleteSession("TEST01");

        expect(session.interval).toBe(null);
      });

      test("should return false for non-existent session", () => {
        const result = serverState.deleteSession("NOTFOUND");
        expect(result).toBe(false);
      });
    });

    describe("getSessionIds", () => {
      test("should return Set of session IDs", () => {
        serverState.setSession("TEST01", session);
        const session2 = new CasualGameSession("TEST02", { playerCount: 2 });
        serverState.setSession("TEST02", session2);

        const ids = serverState.getSessionIds();

        expect(ids).toBeInstanceOf(Set);
        expect(ids.has("TEST01")).toBe(true);
        expect(ids.has("TEST02")).toBe(true);

        session2.cleanup();
      });
    });

    describe("getSessionCount", () => {
      test("should return number of sessions", () => {
        expect(serverState.getSessionCount()).toBe(0);

        serverState.setSession("TEST01", session);
        expect(serverState.getSessionCount()).toBe(1);
      });
    });

    describe("getAllSessions", () => {
      test("should return iterator of session entries", () => {
        serverState.setSession("TEST01", session);
        const session2 = new CasualGameSession("TEST02", { playerCount: 2 });
        serverState.setSession("TEST02", session2);

        const entries = Array.from(serverState.getAllSessions());

        expect(entries.length).toBe(2);
        expect(entries[0][0]).toBe("TEST01");
        expect(entries[1][0]).toBe("TEST02");

        session2.cleanup();
      });
    });
  });

  describe("shutdown management", () => {
    describe("beginShutdown", () => {
      test("should set isShuttingDown to true", () => {
        expect(serverState.isShuttingDown).toBe(false);

        serverState.beginShutdown();

        expect(serverState.isShuttingDown).toBe(true);
      });
    });

    describe("clearTimers", () => {
      test("should clear all timers", () => {
        serverState.persistenceTimer = setInterval(() => {}, 1000);
        serverState.cleanupTimer = setInterval(() => {}, 1000);
        serverState.heartbeatTimer = setInterval(() => {}, 1000);

        serverState.clearTimers();

        expect(serverState.persistenceTimer).toBe(null);
        expect(serverState.cleanupTimer).toBe(null);
        expect(serverState.heartbeatTimer).toBe(null);
      });

      test("should handle null timers gracefully", () => {
        expect(() => serverState.clearTimers()).not.toThrow();
      });
    });

    describe("cleanupAllSessions", () => {
      test("should cleanup all sessions", () => {
        const session1 = new CasualGameSession("TEST01", { playerCount: 2 });
        const session2 = new CasualGameSession("TEST02", { playerCount: 2 });
        session1.start();
        session2.start();

        serverState.setSession("TEST01", session1);
        serverState.setSession("TEST02", session2);

        serverState.cleanupAllSessions();

        expect(session1.interval).toBe(null);
        expect(session2.interval).toBe(null);
      });
    });
  });
});

describe("ServerState singleton behavior", () => {
  test("exported serverState should be a singleton instance", () => {
    const { serverState: state1 } = require("../lib/server/state");
    const { serverState: state2 } = require("../lib/server/state");

    expect(state1).toBe(state2);
  });
});
