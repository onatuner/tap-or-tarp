/**
 * Message Handlers Tests
 *
 * Unit tests for WebSocket message handlers.
 */

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
  recordError: jest.fn(),
  recordAuthDenied: jest.fn(),
  recordMessageSent: jest.fn(),
  recordNewSession: jest.fn(),
}));

jest.mock("../lib/lock", () => ({
  withGameLock: jest.fn((gameId, fn) => fn()),
}));

// Create mock serverState
const mockServerState = {
  gameSessions: new Map(),
  storage: null,
  isAsyncStorageMode: false,
  isRedisPrimaryMode: false,
  wss: null,
  instanceId: "test-instance",
  getSession: jest.fn(),
  setSession: jest.fn(),
  deleteSession: jest.fn(),
  hasSession: jest.fn(),
  getSessionIds: jest.fn(() => new Set()),
  getAllSessions: jest.fn(() => []),
};

jest.mock("../lib/server/state", () => ({
  serverState: mockServerState,
}));

jest.mock("../lib/server/websocket", () => ({
  safeSend: jest.fn(),
  broadcastToGame: jest.fn(() => Promise.resolve()),
  subscribeToGameChannel: jest.fn(() => Promise.resolve()),
}));

jest.mock("../lib/server/persistence", () => ({
  ensureGameLoaded: jest.fn(),
  persistGameImmediately: jest.fn(() => Promise.resolve()),
  syncGameToRedis: jest.fn(() => Promise.resolve()),
}));

// Import handlers after mocking
const handleCreate = require("../lib/server/message-handlers/create");
const handleJoin = require("../lib/server/message-handlers/join");
const {
  claim: handleClaim,
  reconnect: handleReconnect,
  unclaim: handleUnclaim,
} = require("../lib/server/message-handlers/claim");
const {
  start: handleStart,
  pause: handlePause,
  reset: handleReset,
  switch: handleSwitch,
  endGame: handleEndGame,
  interrupt: handleInterrupt,
  passPriority: handlePassPriority,
  renameGame: handleRenameGame,
} = require("../lib/server/message-handlers/game-control");
const {
  updatePlayer: handleUpdatePlayer,
  addPenalty: handleAddPenalty,
  eliminate: handleEliminate,
  updateSettings: handleUpdateSettings,
} = require("../lib/server/message-handlers/player");

const { safeSend } = require("../lib/server/websocket");
const { ensureGameLoaded } = require("../lib/server/persistence");
const metrics = require("../lib/metrics");

describe("Message Handlers", () => {
  let mockWs;
  let session;

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset mock serverState
    mockServerState.gameSessions.clear();
    mockServerState.storage = null;
    mockServerState.isAsyncStorageMode = false;
    mockServerState.isRedisPrimaryMode = false;
    mockServerState.wss = { clients: new Set() };

    // Create mock WebSocket
    mockWs = {
      clientId: "client-123",
      gameId: null,
    };

    // Create a test session
    session = new CasualGameSession("TEST01", { playerCount: 4 });
    session.setOwner("client-123");

    // Setup mock implementations
    mockServerState.getSession.mockImplementation(id => {
      if (id === "TEST01") return session;
      return undefined;
    });
    mockServerState.hasSession.mockImplementation(id => id === "TEST01");
    ensureGameLoaded.mockImplementation(async id => {
      if (id === "TEST01") return session;
      return null;
    });
  });

  afterEach(() => {
    session.cleanup();
  });

  describe("handleCreate", () => {
    test("should create a new game session", async () => {
      const data = {
        settings: {
          playerCount: 2,
          initialTime: 600000,
        },
      };

      await handleCreate(mockWs, data);

      expect(mockServerState.setSession).toHaveBeenCalled();
      expect(safeSend).toHaveBeenCalled();
      expect(metrics.recordNewSession).toHaveBeenCalled();
    });

    test("should reject invalid settings", async () => {
      const data = {
        settings: null,
      };

      await handleCreate(mockWs, data);

      expect(safeSend).toHaveBeenCalledWith(
        mockWs,
        expect.stringContaining("Invalid settings")
      );
      expect(metrics.recordError).toHaveBeenCalledWith("invalid_settings");
    });

    test("should reject player count out of range", async () => {
      const data = {
        settings: {
          playerCount: 99,
        },
      };

      await handleCreate(mockWs, data);

      expect(safeSend).toHaveBeenCalledWith(
        mockWs,
        expect.stringContaining("Invalid settings")
      );
    });
  });

  describe("handleJoin", () => {
    test("should allow joining existing game", async () => {
      const data = { gameId: "TEST01" };

      await handleJoin(mockWs, data);

      expect(mockWs.gameId).toBe("TEST01");
      expect(safeSend).toHaveBeenCalledWith(
        mockWs,
        expect.stringContaining('"type":"state"')
      );
    });

    test("should return error for missing gameId", async () => {
      const data = {};

      await handleJoin(mockWs, data);

      expect(safeSend).toHaveBeenCalledWith(
        mockWs,
        expect.stringContaining("Game ID is required")
      );
    });

    test("should return error for non-existent game", async () => {
      const data = { gameId: "NOTFOUND" };
      ensureGameLoaded.mockResolvedValueOnce(null);

      await handleJoin(mockWs, data);

      expect(safeSend).toHaveBeenCalledWith(
        mockWs,
        expect.stringContaining("Game not found")
      );
      expect(metrics.recordError).toHaveBeenCalledWith("game_not_found");
    });

    test("should set owner if not already set", async () => {
      session.ownerId = null;
      const data = { gameId: "TEST01" };

      await handleJoin(mockWs, data);

      expect(session.ownerId).toBe("client-123");
    });
  });

  describe("handleClaim", () => {
    beforeEach(() => {
      mockWs.gameId = "TEST01";
    });

    test("should claim an unclaimed player", async () => {
      const data = { playerId: 1 };

      await handleClaim(mockWs, data);

      expect(session.players[0].claimedBy).toBe("client-123");
      expect(safeSend).toHaveBeenCalledWith(
        mockWs,
        expect.stringContaining('"type":"claimed"')
      );
    });

    test("should return error when claiming already claimed player", async () => {
      session.claimPlayer(1, "other-client");
      const data = { playerId: 1 };

      await handleClaim(mockWs, data);

      expect(safeSend).toHaveBeenCalledWith(
        mockWs,
        expect.stringContaining("error")
      );
      expect(metrics.recordError).toHaveBeenCalledWith("claim_failed");
    });

    test("should do nothing for invalid player ID", async () => {
      const data = { playerId: 0 };

      await handleClaim(mockWs, data);

      expect(safeSend).not.toHaveBeenCalled();
    });

    test("should do nothing for player ID out of range", async () => {
      const data = { playerId: CONSTANTS.MAX_PLAYERS + 1 };

      await handleClaim(mockWs, data);

      expect(safeSend).not.toHaveBeenCalled();
    });

    test("should do nothing if session not found", async () => {
      mockServerState.getSession.mockReturnValueOnce(undefined);
      const data = { playerId: 1 };

      await handleClaim(mockWs, data);

      expect(safeSend).not.toHaveBeenCalled();
    });
  });

  describe("handleReconnect", () => {
    test("should reconnect with valid token", async () => {
      const claimResult = session.claimPlayer(1, "old-client");
      const data = {
        gameId: "TEST01",
        playerId: 1,
        token: claimResult.token,
      };

      await handleReconnect(mockWs, data);

      expect(session.players[0].claimedBy).toBe("client-123");
      expect(safeSend).toHaveBeenCalledWith(
        mockWs,
        expect.stringContaining('"type":"reconnected"')
      );
    });

    test("should return error for game not found", async () => {
      ensureGameLoaded.mockResolvedValueOnce(null);
      const data = {
        gameId: "NOTFOUND",
        playerId: 1,
        token: "some-token",
      };

      await handleReconnect(mockWs, data);

      expect(safeSend).toHaveBeenCalledWith(
        mockWs,
        expect.stringContaining("Game not found")
      );
    });

    test("should return error for invalid player ID", async () => {
      const data = {
        gameId: "TEST01",
        playerId: 0,
        token: "some-token",
      };

      await handleReconnect(mockWs, data);

      expect(safeSend).toHaveBeenCalledWith(
        mockWs,
        expect.stringContaining("Invalid player ID")
      );
    });

    test("should return error for invalid token format", async () => {
      const data = {
        gameId: "TEST01",
        playerId: 1,
        token: null,
      };

      await handleReconnect(mockWs, data);

      expect(safeSend).toHaveBeenCalledWith(
        mockWs,
        expect.stringContaining("Invalid token")
      );
    });

    test("should return error for wrong token", async () => {
      session.claimPlayer(1, "old-client");
      const data = {
        gameId: "TEST01",
        playerId: 1,
        token: "wrong-token",
      };

      await handleReconnect(mockWs, data);

      expect(safeSend).toHaveBeenCalledWith(
        mockWs,
        expect.stringContaining("error")
      );
      expect(metrics.recordError).toHaveBeenCalledWith("reconnect_failed");
    });
  });

  describe("handleUnclaim", () => {
    beforeEach(() => {
      mockWs.gameId = "TEST01";
    });

    test("should unclaim player", async () => {
      session.claimPlayer(1, "client-123");

      await handleUnclaim(mockWs, {});

      expect(session.players[0].claimedBy).toBe(null);
    });

    test("should do nothing if session not found", async () => {
      mockServerState.getSession.mockReturnValueOnce(undefined);

      await handleUnclaim(mockWs, {});

      // Should not throw
    });
  });

  describe("handleStart", () => {
    beforeEach(() => {
      mockWs.gameId = "TEST01";
    });

    test("should start game when authorized", async () => {
      await handleStart(mockWs, {});

      expect(session.status).toBe("running");
    });

    test("should reject unauthorized start", async () => {
      mockWs.clientId = "unauthorized-client";

      await handleStart(mockWs, {});

      expect(session.status).toBe("waiting");
      expect(safeSend).toHaveBeenCalledWith(
        mockWs,
        expect.stringContaining("Not authorized")
      );
      expect(metrics.recordAuthDenied).toHaveBeenCalledWith("start");
    });

    test("should do nothing if session not found", async () => {
      mockServerState.getSession.mockReturnValueOnce(undefined);

      await handleStart(mockWs, {});

      // Should not throw
    });
  });

  describe("handlePause", () => {
    beforeEach(() => {
      mockWs.gameId = "TEST01";
      session.start();
    });

    test("should pause running game", async () => {
      await handlePause(mockWs, {});

      expect(session.status).toBe("paused");
    });

    test("should resume paused game", async () => {
      session.pause();

      await handlePause(mockWs, {});

      expect(session.status).toBe("running");
    });

    test("should reject unauthorized pause", async () => {
      mockWs.clientId = "unauthorized-client";

      await handlePause(mockWs, {});

      expect(session.status).toBe("running");
      expect(safeSend).toHaveBeenCalledWith(
        mockWs,
        expect.stringContaining("Not authorized")
      );
    });
  });

  describe("handleReset", () => {
    beforeEach(() => {
      mockWs.gameId = "TEST01";
      session.start();
      session.players[0].timeRemaining = 100;
    });

    test("should reset game", async () => {
      await handleReset(mockWs, {});

      expect(session.status).toBe("waiting");
      expect(session.activePlayer).toBe(null);
      expect(session.players[0].timeRemaining).toBe(session.settings.initialTime);
    });
  });

  describe("handleSwitch", () => {
    beforeEach(() => {
      mockWs.gameId = "TEST01";
      session.start();
    });

    test("should switch to valid player", async () => {
      await handleSwitch(mockWs, { playerId: 2 });

      expect(session.activePlayer).toBe(2);
    });

    test("should do nothing for invalid player ID", async () => {
      const original = session.activePlayer;

      await handleSwitch(mockWs, { playerId: 0 });

      expect(session.activePlayer).toBe(original);
    });

    test("should reject unauthorized switch", async () => {
      mockWs.clientId = "unauthorized-client";

      await handleSwitch(mockWs, { playerId: 2 });

      expect(safeSend).toHaveBeenCalledWith(
        mockWs,
        expect.stringContaining("Not authorized")
      );
    });
  });

  describe("handleEndGame", () => {
    beforeEach(() => {
      mockWs.gameId = "TEST01";
      mockServerState.wss.clients = new Set([mockWs]);
    });

    test("should broadcast gameEnded and delete session", async () => {
      await handleEndGame(mockWs, {});

      expect(safeSend).toHaveBeenCalledWith(
        mockWs,
        expect.stringContaining('"type":"gameEnded"')
      );
      expect(mockServerState.deleteSession).toHaveBeenCalledWith("TEST01");
    });
  });

  describe("handleInterrupt", () => {
    beforeEach(() => {
      mockWs.gameId = "TEST01";
      session.claimPlayer(1, "client-123");
      session.start();
    });

    test("should add player to interrupt queue", async () => {
      await handleInterrupt(mockWs, {});

      expect(session.interruptingPlayers).toContain(1);
    });

    test("should return error if player not claimed", async () => {
      session.unclaimPlayer("client-123");

      await handleInterrupt(mockWs, {});

      expect(safeSend).toHaveBeenCalledWith(
        mockWs,
        expect.stringContaining("must claim a player")
      );
    });

    test("should return error if game not running", async () => {
      session.pause();

      await handleInterrupt(mockWs, {});

      expect(safeSend).toHaveBeenCalledWith(
        mockWs,
        expect.stringContaining("Game is not running")
      );
    });
  });

  describe("handlePassPriority", () => {
    beforeEach(() => {
      mockWs.gameId = "TEST01";
      session.claimPlayer(1, "client-123");
      session.start();
      session.interrupt(1);
    });

    test("should remove player from interrupt queue", async () => {
      await handlePassPriority(mockWs, {});

      expect(session.interruptingPlayers).not.toContain(1);
    });

    test("should return error if player not claimed", async () => {
      session.unclaimPlayer("client-123");

      await handlePassPriority(mockWs, {});

      expect(safeSend).toHaveBeenCalledWith(
        mockWs,
        expect.stringContaining("must claim a player")
      );
    });

    test("should return error if not in interrupt queue", async () => {
      session.passPriority(1);

      await handlePassPriority(mockWs, {});

      expect(safeSend).toHaveBeenCalledWith(
        mockWs,
        expect.stringContaining("not in the interrupt queue")
      );
    });
  });

  describe("handleRenameGame", () => {
    beforeEach(() => {
      mockWs.gameId = "TEST01";
    });

    test("should rename the game", async () => {
      await handleRenameGame(mockWs, { name: "My Cool Game" });

      expect(session.name).toBe("My Cool Game");
      expect(safeSend).toHaveBeenCalledWith(
        mockWs,
        expect.stringContaining('"type":"gameRenamed"')
      );
    });

    test("should truncate long names", async () => {
      const longName = "A".repeat(100);

      await handleRenameGame(mockWs, { name: longName });

      expect(session.name.length).toBeLessThanOrEqual(CONSTANTS.MAX_GAME_NAME_LENGTH);
    });

    test("should default to 'Game' for empty name", async () => {
      await handleRenameGame(mockWs, { name: "   " });

      expect(session.name).toBe("Game");
    });

    test("should sanitize XSS in name", async () => {
      await handleRenameGame(mockWs, { name: '<script>alert("xss")</script>' });

      expect(session.name).not.toContain("<script>");
    });
  });

  describe("handleUpdatePlayer", () => {
    beforeEach(() => {
      mockWs.gameId = "TEST01";
      session.claimPlayer(1, "client-123");
    });

    test("should update player name", async () => {
      await handleUpdatePlayer(mockWs, { playerId: 1, name: "Alice" });

      expect(session.players[0].name).toBe("Alice");
    });

    test("should update player time", async () => {
      await handleUpdatePlayer(mockWs, { playerId: 1, time: 300000 });

      expect(session.players[0].timeRemaining).toBe(300000);
    });

    test("should update player life", async () => {
      await handleUpdatePlayer(mockWs, { playerId: 1, life: 15 });

      expect(session.players[0].life).toBe(15);
    });

    test("should reject invalid player ID", async () => {
      await handleUpdatePlayer(mockWs, { playerId: 0, name: "Alice" });

      // Should not update any player
      expect(session.players.every(p => p.name.startsWith("Player"))).toBe(true);
    });

    test("should reject unauthorized update", async () => {
      mockWs.clientId = "other-client";

      await handleUpdatePlayer(mockWs, { playerId: 1, name: "Hacker" });

      expect(session.players[0].name).not.toBe("Hacker");
      expect(safeSend).toHaveBeenCalledWith(
        mockWs,
        expect.stringContaining("Not authorized")
      );
    });

    test("should sanitize player name", async () => {
      await handleUpdatePlayer(mockWs, { playerId: 1, name: "<script>xss</script>" });

      expect(session.players[0].name).not.toContain("<script>");
    });

    test("should reject invalid name length", async () => {
      const originalName = session.players[0].name;
      await handleUpdatePlayer(mockWs, { playerId: 1, name: "A".repeat(100) });

      expect(session.players[0].name).toBe(originalName);
    });

    test("should reject negative time", async () => {
      const originalTime = session.players[0].timeRemaining;
      await handleUpdatePlayer(mockWs, { playerId: 1, time: -1000 });

      expect(session.players[0].timeRemaining).toBe(originalTime);
    });
  });

  describe("handleAddPenalty", () => {
    beforeEach(() => {
      mockWs.gameId = "TEST01";
    });

    test("should add penalty to player", async () => {
      await handleAddPenalty(mockWs, { playerId: 1 });

      expect(session.players[0].penalties).toBe(1);
    });

    test("should reject invalid player ID", async () => {
      await handleAddPenalty(mockWs, { playerId: 0 });

      expect(session.players.every(p => p.penalties === 0)).toBe(true);
    });
  });

  describe("handleEliminate", () => {
    beforeEach(() => {
      mockWs.gameId = "TEST01";
    });

    test("should eliminate player", async () => {
      await handleEliminate(mockWs, { playerId: 1 });

      expect(session.players[0].isEliminated).toBe(true);
    });

    test("should reject invalid player ID", async () => {
      await handleEliminate(mockWs, { playerId: 0 });

      expect(session.players.every(p => !p.isEliminated)).toBe(true);
    });
  });

  describe("handleUpdateSettings", () => {
    beforeEach(() => {
      mockWs.gameId = "TEST01";
    });

    test("should update warning thresholds", async () => {
      const newThresholds = [120000, 60000];
      await handleUpdateSettings(mockWs, { warningThresholds: newThresholds });

      expect(session.settings.warningThresholds).toEqual(newThresholds);
    });

    test("should reject invalid warning thresholds", async () => {
      const originalThresholds = [...session.settings.warningThresholds];

      await handleUpdateSettings(mockWs, { warningThresholds: [] });

      expect(session.settings.warningThresholds).toEqual(originalThresholds);
      expect(safeSend).toHaveBeenCalledWith(
        mockWs,
        expect.stringContaining("Invalid warning thresholds")
      );
    });

    test("should reject non-array warning thresholds", async () => {
      const originalThresholds = [...session.settings.warningThresholds];

      await handleUpdateSettings(mockWs, { warningThresholds: "not-an-array" });

      expect(session.settings.warningThresholds).toEqual(originalThresholds);
    });
  });
});

describe("Message Handler Error Handling", () => {
  let mockWs;

  beforeEach(() => {
    jest.clearAllMocks();
    mockWs = {
      clientId: "client-123",
      gameId: "TEST01",
    };
  });

  test("handlers should handle lock errors gracefully", async () => {
    const { withGameLock } = require("../lib/lock");
    withGameLock.mockRejectedValueOnce(new Error("Lock timeout"));

    await handleStart(mockWs, {});

    expect(safeSend).toHaveBeenCalledWith(
      mockWs,
      expect.stringContaining("Lock timeout")
    );
    expect(metrics.recordError).toHaveBeenCalledWith("start_lock_error");
  });
});
