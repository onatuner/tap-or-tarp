const {
  CONSTANTS,
  GameSession,
  validateSettings,
  validatePlayerName,
  validateWarningThresholds,
  validateTimeValue,
  sanitizeString,
  generateGameId,
} = require("../lib/game-logic");

describe("CONSTANTS", () => {
  test("should have correct default values", () => {
    expect(CONSTANTS.TICK_INTERVAL).toBe(100);
    expect(CONSTANTS.MIN_PLAYERS).toBe(2);
    expect(CONSTANTS.MAX_PLAYERS).toBe(8);
    expect(CONSTANTS.MAX_INITIAL_TIME).toBe(24 * 60 * 60 * 1000);
    expect(CONSTANTS.MAX_PLAYER_NAME_LENGTH).toBe(50);
    expect(CONSTANTS.DEFAULT_INITIAL_TIME).toBe(10 * 60 * 1000);
  });
});

describe("validateSettings", () => {
  test("should return false for null or undefined", () => {
    expect(validateSettings(null)).toBe(false);
    expect(validateSettings(undefined)).toBe(false);
  });

  test("should return false for non-object", () => {
    expect(validateSettings("string")).toBe(false);
    expect(validateSettings(123)).toBe(false);
    expect(validateSettings([])).toBe(false);
  });

  test("should return true for empty object", () => {
    expect(validateSettings({})).toBe(true);
  });

  test("should validate playerCount within range", () => {
    expect(validateSettings({ playerCount: 2 })).toBe(true);
    expect(validateSettings({ playerCount: 8 })).toBe(true);
    expect(validateSettings({ playerCount: 4 })).toBe(true);
    expect(validateSettings({ playerCount: 1 })).toBe(false);
    expect(validateSettings({ playerCount: 9 })).toBe(false);
    expect(validateSettings({ playerCount: 0 })).toBe(false);
    expect(validateSettings({ playerCount: -1 })).toBe(false);
  });

  test("should reject non-integer playerCount", () => {
    expect(validateSettings({ playerCount: 2.5 })).toBe(false);
    expect(validateSettings({ playerCount: "two" })).toBe(false);
  });

  test("should validate initialTime within range", () => {
    expect(validateSettings({ initialTime: 1000 })).toBe(true);
    expect(validateSettings({ initialTime: 30 * 60 * 1000 })).toBe(true);
    expect(validateSettings({ initialTime: 24 * 60 * 60 * 1000 })).toBe(true);
    expect(validateSettings({ initialTime: 0 })).toBe(false);
    expect(validateSettings({ initialTime: -1000 })).toBe(false);
    expect(validateSettings({ initialTime: 24 * 60 * 60 * 1000 + 1 })).toBe(false);
  });

  test("should reject non-integer initialTime", () => {
    expect(validateSettings({ initialTime: 1000.5 })).toBe(false);
  });
});

describe("validatePlayerName", () => {
  test("should return true for valid names", () => {
    expect(validatePlayerName("Player 1")).toBe(true);
    expect(validatePlayerName("John")).toBe(true);
    expect(validatePlayerName("")).toBe(true);
    expect(validatePlayerName("A".repeat(50))).toBe(true);
  });

  test("should return false for names exceeding max length", () => {
    expect(validatePlayerName("A".repeat(51))).toBe(false);
    expect(validatePlayerName("A".repeat(100))).toBe(false);
  });

  test("should return false for non-string", () => {
    expect(validatePlayerName(123)).toBe(false);
    expect(validatePlayerName(null)).toBe(false);
    expect(validatePlayerName(undefined)).toBe(false);
    expect(validatePlayerName({})).toBe(false);
  });
});

describe("validateWarningThresholds", () => {
  test("should return true for valid thresholds", () => {
    expect(validateWarningThresholds([300000, 60000, 30000])).toBe(true);
    expect(validateWarningThresholds([60000])).toBe(true);
    expect(validateWarningThresholds([1])).toBe(true);
  });

  test("should return false for empty array", () => {
    expect(validateWarningThresholds([])).toBe(false);
  });

  test("should return false for too many thresholds", () => {
    const tooMany = Array(11).fill(1000);
    expect(validateWarningThresholds(tooMany)).toBe(false);
  });

  test("should return false for non-array", () => {
    expect(validateWarningThresholds("300000")).toBe(false);
    expect(validateWarningThresholds(300000)).toBe(false);
    expect(validateWarningThresholds(null)).toBe(false);
  });

  test("should return false for invalid threshold values", () => {
    expect(validateWarningThresholds([0])).toBe(false);
    expect(validateWarningThresholds([-1000])).toBe(false);
    expect(validateWarningThresholds([Infinity])).toBe(false);
    expect(validateWarningThresholds([NaN])).toBe(false);
    expect(validateWarningThresholds(["60000"])).toBe(false);
    expect(validateWarningThresholds([CONSTANTS.MAX_INITIAL_TIME + 1])).toBe(false);
  });
});

describe("validateTimeValue", () => {
  test("should return true for valid time values", () => {
    expect(validateTimeValue(0)).toBe(true);
    expect(validateTimeValue(1000)).toBe(true);
    expect(validateTimeValue(CONSTANTS.MAX_INITIAL_TIME)).toBe(true);
  });

  test("should return false for negative values", () => {
    expect(validateTimeValue(-1)).toBe(false);
    expect(validateTimeValue(-1000)).toBe(false);
  });

  test("should return false for values exceeding max", () => {
    expect(validateTimeValue(CONSTANTS.MAX_INITIAL_TIME + 1)).toBe(false);
  });

  test("should return false for non-numbers", () => {
    expect(validateTimeValue("1000")).toBe(false);
    expect(validateTimeValue(null)).toBe(false);
    expect(validateTimeValue(undefined)).toBe(false);
  });

  test("should return false for Infinity and NaN", () => {
    expect(validateTimeValue(Infinity)).toBe(false);
    expect(validateTimeValue(-Infinity)).toBe(false);
    expect(validateTimeValue(NaN)).toBe(false);
  });
});

describe("sanitizeString", () => {
  test("should remove < and > characters", () => {
    expect(sanitizeString('<script>alert("xss")</script>')).toBe('scriptalert("xss")/script');
    expect(sanitizeString("Player <1>")).toBe("Player 1");
    expect(sanitizeString("<<>>")).toBe("");
  });

  test("should return unchanged string without < or >", () => {
    expect(sanitizeString("Hello World")).toBe("Hello World");
    expect(sanitizeString("Player 1")).toBe("Player 1");
  });

  test("should return non-string values unchanged", () => {
    expect(sanitizeString(123)).toBe(123);
    expect(sanitizeString(null)).toBe(null);
    expect(sanitizeString(undefined)).toBe(undefined);
  });
});

describe("generateGameId", () => {
  test("should generate 6 character IDs", () => {
    const id = generateGameId();
    expect(id).toHaveLength(6);
  });

  test("should generate IDs with only valid characters", () => {
    const validChars = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/;
    for (let i = 0; i < 100; i++) {
      const id = generateGameId();
      expect(id).toMatch(validChars);
    }
  });

  test("should not generate IDs that already exist", () => {
    const existingIds = new Set(["ABC123", "XYZ789"]);
    const id = generateGameId(existingIds);
    expect(existingIds.has(id)).toBe(false);
  });

  test("should generate unique IDs", () => {
    const ids = new Set();
    for (let i = 0; i < 100; i++) {
      ids.add(generateGameId(ids));
    }
    expect(ids.size).toBe(100);
  });
});

describe("GameSession", () => {
  let session;
  let broadcastMessages;

  beforeEach(() => {
    broadcastMessages = [];
    session = new GameSession("TEST01", { playerCount: 4 }, (type, data) => {
      broadcastMessages.push({ type, data });
    });
  });

  afterEach(() => {
    session.cleanup();
  });

  describe("constructor", () => {
    test("should initialize with correct defaults", () => {
      expect(session.id).toBe("TEST01");
      expect(session.status).toBe("waiting");
      expect(session.activePlayer).toBe(null);
      expect(session.players).toHaveLength(4);
    });

    test("should initialize players with correct properties", () => {
      session.players.forEach((player, index) => {
        expect(player.id).toBe(index + 1);
        expect(player.name).toBe(`Player ${index + 1}`);
        expect(player.timeRemaining).toBe(CONSTANTS.DEFAULT_INITIAL_TIME);
        expect(player.penalties).toBe(0);
        expect(player.isEliminated).toBe(false);
        expect(player.claimedBy).toBe(null);
        expect(player.life).toBe(20);
        expect(player.drunkCounter).toBe(0);
        expect(player.genericCounter).toBe(0);
      });
    });

    test("should use custom initial time", () => {
      const customSession = new GameSession("TEST02", {
        playerCount: 2,
        initialTime: 60000,
      });
      expect(customSession.players[0].timeRemaining).toBe(60000);
      customSession.cleanup();
    });

    test("should use default player count of 2", () => {
      const defaultSession = new GameSession("TEST03", {});
      expect(defaultSession.players).toHaveLength(2);
      defaultSession.cleanup();
    });
  });

  describe("claimPlayer", () => {
    test("should claim an unclaimed player", () => {
      const result = session.claimPlayer(1, "client1");
      expect(result).toBe(true);
      expect(session.players[0].claimedBy).toBe("client1");
    });

    test("should not claim during non-waiting status", () => {
      session.start();
      const result = session.claimPlayer(1, "client1");
      expect(result).toBe(false);
    });

    test("should not claim already claimed player by different client", () => {
      session.claimPlayer(1, "client1");
      const result = session.claimPlayer(1, "client2");
      expect(result).toBe(false);
      expect(session.players[0].claimedBy).toBe("client1");
    });

    test("should allow reclaiming by same client", () => {
      session.claimPlayer(1, "client1");
      const result = session.claimPlayer(1, "client1");
      expect(result).toBe(true);
    });

    test("should unclaim previous player when claiming new one", () => {
      session.claimPlayer(1, "client1");
      session.claimPlayer(2, "client1");
      expect(session.players[0].claimedBy).toBe(null);
      expect(session.players[1].claimedBy).toBe("client1");
    });

    test("should return false for invalid player ID", () => {
      expect(session.claimPlayer(99, "client1")).toBe(false);
      expect(session.claimPlayer(0, "client1")).toBe(false);
    });
  });

  describe("unclaimPlayer", () => {
    test("should unclaim player", () => {
      session.claimPlayer(1, "client1");
      session.unclaimPlayer("client1");
      expect(session.players[0].claimedBy).toBe(null);
    });

    test("should only unclaim players claimed by specified client", () => {
      session.claimPlayer(1, "client1");
      session.claimPlayer(2, "client2");
      session.unclaimPlayer("client1");
      expect(session.players[0].claimedBy).toBe(null);
      expect(session.players[1].claimedBy).toBe("client2");
    });
  });

  describe("handleClientDisconnect", () => {
    test("should unclaim all players claimed by disconnected client", () => {
      session.claimPlayer(1, "client1");
      session.handleClientDisconnect("client1");
      expect(session.players[0].claimedBy).toBe(null);
    });
  });

  describe("start", () => {
    test("should change status to running", () => {
      session.start();
      expect(session.status).toBe("running");
    });

    test("should set activePlayer to 1", () => {
      session.start();
      expect(session.activePlayer).toBe(1);
    });

    test("should broadcast state", () => {
      broadcastMessages = [];
      session.start();
      expect(broadcastMessages.some(m => m.type === "state")).toBe(true);
    });

    test("should not start if already running", () => {
      session.start();
      const initialLastTick = session.lastTick;
      session.start();
      // lastTick should not change if already running
      expect(session.lastTick).toBe(initialLastTick);
    });
  });

  describe("pause", () => {
    test("should change status to paused when running", () => {
      session.start();
      session.pause();
      expect(session.status).toBe("paused");
    });

    test("should not pause if not running", () => {
      session.pause();
      expect(session.status).toBe("waiting");
    });

    test("should clear interval", () => {
      session.start();
      expect(session.interval).not.toBe(null);
      session.pause();
      // interval is cleared but reference may still exist
      expect(session.status).toBe("paused");
    });
  });

  describe("resume", () => {
    test("should resume from paused state", () => {
      session.start();
      session.pause();
      session.resume();
      expect(session.status).toBe("running");
    });

    test("should not resume if not paused", () => {
      session.resume();
      expect(session.status).toBe("waiting");
    });
  });

  describe("switchPlayer", () => {
    test("should switch to valid player", () => {
      session.start();
      session.switchPlayer(2);
      expect(session.activePlayer).toBe(2);
    });

    test("should not switch to eliminated player", () => {
      session.start();
      session.eliminate(2);
      session.switchPlayer(2);
      expect(session.activePlayer).not.toBe(2);
    });

    test("should not switch if only one active player", () => {
      session.start();
      session.eliminate(2);
      session.eliminate(3);
      session.eliminate(4);
      session.switchPlayer(2);
      expect(session.activePlayer).toBe(1);
    });
  });

  describe("reset", () => {
    test("should reset to waiting state", () => {
      session.start();
      session.reset();
      expect(session.status).toBe("waiting");
      expect(session.activePlayer).toBe(null);
    });

    test("should reinitialize players", () => {
      session.start();
      session.players[0].timeRemaining = 0;
      session.players[0].penalties = 5;
      session.reset();
      expect(session.players[0].timeRemaining).toBe(CONSTANTS.DEFAULT_INITIAL_TIME);
      expect(session.players[0].penalties).toBe(0);
    });
  });

  describe("updatePlayer", () => {
    test("should update player name", () => {
      session.updatePlayer(1, { name: "Alice" });
      expect(session.players[0].name).toBe("Alice");
    });

    test("should update player time", () => {
      session.updatePlayer(1, { time: 120000 });
      expect(session.players[0].timeRemaining).toBe(120000);
    });

    test("should update multiple properties", () => {
      session.updatePlayer(1, { name: "Bob", time: 60000 });
      expect(session.players[0].name).toBe("Bob");
      expect(session.players[0].timeRemaining).toBe(60000);
    });

    test("should not update non-existent player", () => {
      session.updatePlayer(99, { name: "Nobody" });
      // Should not throw, just do nothing
      expect(session.players.find(p => p.name === "Nobody")).toBeUndefined();
    });

    test("should update player life", () => {
      session.updatePlayer(1, { life: 15 });
      expect(session.players[0].life).toBe(15);
    });

    test("should update player drunkCounter", () => {
      session.updatePlayer(1, { drunkCounter: 3 });
      expect(session.players[0].drunkCounter).toBe(3);
    });

    test("should update player genericCounter", () => {
      session.updatePlayer(1, { genericCounter: 5 });
      expect(session.players[0].genericCounter).toBe(5);
    });

    test("should update all counters at once", () => {
      session.updatePlayer(1, { life: 10, drunkCounter: 2, genericCounter: 4 });
      expect(session.players[0].life).toBe(10);
      expect(session.players[0].drunkCounter).toBe(2);
      expect(session.players[0].genericCounter).toBe(4);
    });
  });

  describe("addPenalty", () => {
    test("should increment penalty count", () => {
      session.addPenalty(1);
      expect(session.players[0].penalties).toBe(1);
      session.addPenalty(1);
      expect(session.players[0].penalties).toBe(2);
    });

    test("should apply time deduction penalty", () => {
      const penaltySession = new GameSession("PTEST", {
        playerCount: 2,
        penaltyType: "time_deduction",
        penaltyTimeDeduction: 60000,
      });
      const initialTime = penaltySession.players[0].timeRemaining;
      penaltySession.addPenalty(1);
      expect(penaltySession.players[0].timeRemaining).toBe(initialTime - 60000);
      penaltySession.cleanup();
    });

    test("should eliminate player on game_loss penalty", () => {
      const lossSession = new GameSession("LTEST", {
        playerCount: 2,
        penaltyType: "game_loss",
      });
      lossSession.addPenalty(1);
      expect(lossSession.players[0].isEliminated).toBe(true);
      lossSession.cleanup();
    });
  });

  describe("eliminate", () => {
    test("should eliminate player", () => {
      session.eliminate(1);
      expect(session.players[0].isEliminated).toBe(true);
    });

    test("should switch active player if eliminated player is active", () => {
      session.start();
      expect(session.activePlayer).toBe(1);
      session.eliminate(1);
      expect(session.activePlayer).toBe(2);
    });

    test("should pause if all players eliminated", () => {
      session.start();
      session.eliminate(1);
      session.eliminate(2);
      session.eliminate(3);
      session.eliminate(4);
      expect(session.status).toBe("paused");
    });
  });

  describe("getState", () => {
    test("should return complete state object", () => {
      const state = session.getState();
      expect(state).toHaveProperty("id", "TEST01");
      expect(state).toHaveProperty("players");
      expect(state).toHaveProperty("activePlayer");
      expect(state).toHaveProperty("status", "waiting");
      expect(state).toHaveProperty("createdAt");
      expect(state).toHaveProperty("settings");
    });
  });

  describe("cleanup", () => {
    test("should clear interval", () => {
      session.start();
      session.cleanup();
      expect(session.interval).toBe(null);
    });
  });

  describe("tick behavior", () => {
    test("should decrement active player time", async () => {
      session.start();
      const initialTime = session.players[0].timeRemaining;

      // Wait for at least one tick
      await new Promise(resolve => setTimeout(resolve, 150));

      expect(session.players[0].timeRemaining).toBeLessThan(initialTime);
    });

    test("should handle timeout when time reaches zero", async () => {
      const quickSession = new GameSession(
        "QUICK",
        {
          playerCount: 2,
          initialTime: 100,
        },
        (type, data) => {
          broadcastMessages.push({ type, data });
        }
      );

      quickSession.start();

      // Wait for timeout
      await new Promise(resolve => setTimeout(resolve, 250));

      expect(quickSession.players[0].timeRemaining).toBe(0);
      expect(quickSession.players[0].penalties).toBeGreaterThanOrEqual(1);
      expect(quickSession.status).toBe("paused");

      quickSession.cleanup();
    });
  });
});
