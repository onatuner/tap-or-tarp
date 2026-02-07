/**
 * Game Modes Tests
 *
 * Tests for game mode classes and factory functions.
 */

const {
  BaseGameSession,
  CasualGameSession,
  CampaignGameSession,
  CampaignState,
  GAME_MODES,
  CAMPAIGN_PRESETS,
  createGameSession,
  restoreGameSession,
  getAvailableModes,
  isValidMode,
} = require("../lib/game-modes");

describe("Game Modes Registry", () => {
  describe("GAME_MODES constant", () => {
    test("should have casual mode registered", () => {
      expect(GAME_MODES.casual).toBeDefined();
      expect(GAME_MODES.casual.id).toBe("casual");
      expect(GAME_MODES.casual.name).toBe("Casual");
      expect(GAME_MODES.casual.SessionClass).toBe(CasualGameSession);
    });

    test("should have campaign mode registered", () => {
      expect(GAME_MODES.campaign).toBeDefined();
      expect(GAME_MODES.campaign.id).toBe("campaign");
      expect(GAME_MODES.campaign.name).toBe("Campaign");
      expect(GAME_MODES.campaign.SessionClass).toBe(CampaignGameSession);
    });
  });

  describe("isValidMode", () => {
    test("should return true for valid modes", () => {
      expect(isValidMode("casual")).toBe(true);
      expect(isValidMode("campaign")).toBe(true);
    });

    test("should return false for invalid modes", () => {
      expect(isValidMode("tournament")).toBe(false);
      expect(isValidMode("blitz")).toBe(false);
      expect(isValidMode("")).toBe(false);
      expect(isValidMode(null)).toBe(false);
      expect(isValidMode(undefined)).toBe(false);
    });
  });

  describe("getAvailableModes", () => {
    test("should return array of mode info objects", () => {
      const modes = getAvailableModes();
      expect(Array.isArray(modes)).toBe(true);
      expect(modes.length).toBeGreaterThanOrEqual(2);
    });

    test("should include id, name, and description for each mode", () => {
      const modes = getAvailableModes();
      modes.forEach(mode => {
        expect(mode).toHaveProperty("id");
        expect(mode).toHaveProperty("name");
        expect(mode).toHaveProperty("description");
        expect(typeof mode.id).toBe("string");
        expect(typeof mode.name).toBe("string");
        expect(typeof mode.description).toBe("string");
      });
    });

    test("should not include SessionClass in returned objects", () => {
      const modes = getAvailableModes();
      modes.forEach(mode => {
        expect(mode).not.toHaveProperty("SessionClass");
      });
    });
  });

  describe("createGameSession", () => {
    test("should create CasualGameSession for casual mode", () => {
      const session = createGameSession("casual", "TEST01", { playerCount: 2 });
      expect(session).toBeInstanceOf(CasualGameSession);
      expect(session).toBeInstanceOf(BaseGameSession);
      expect(session.mode).toBe("casual");
      session.cleanup();
    });

    test("should create CampaignGameSession for campaign mode", () => {
      const session = createGameSession("campaign", "TEST02", { playerCount: 2 });
      expect(session).toBeInstanceOf(CampaignGameSession);
      expect(session).toBeInstanceOf(BaseGameSession);
      expect(session.mode).toBe("campaign");
      session.cleanup();
    });

    test("should throw for unknown mode", () => {
      expect(() => createGameSession("tournament", "TEST03", {})).toThrow(
        "Unknown game mode: tournament"
      );
    });

    test("should pass settings to session", () => {
      const session = createGameSession("casual", "TEST04", {
        playerCount: 4,
        initialTime: 300000,
      });
      expect(session.players.length).toBe(4);
      expect(session.settings.initialTime).toBe(300000);
      session.cleanup();
    });

    test("should pass broadcast function to session", () => {
      const broadcasts = [];
      const broadcastFn = (type, data) => broadcasts.push({ type, data });
      const session = createGameSession("casual", "TEST05", {}, broadcastFn);

      session.broadcastState();
      expect(broadcasts.length).toBeGreaterThan(0);
      expect(broadcasts[0].type).toBe("state");
      session.cleanup();
    });
  });

  describe("restoreGameSession", () => {
    test("should restore CasualGameSession from state", () => {
      const original = createGameSession("casual", "RESTORE01", { playerCount: 3 });
      original.players[0].name = "Alice";
      original.setOwner("owner1");

      const state = original.toJSON();
      const restored = restoreGameSession(state);

      expect(restored).toBeInstanceOf(CasualGameSession);
      expect(restored.id).toBe("RESTORE01");
      expect(restored.players[0].name).toBe("Alice");
      expect(restored.ownerId).toBe("owner1");

      original.cleanup();
      restored.cleanup();
    });

    test("should restore CampaignGameSession from state", () => {
      const original = createGameSession("campaign", "RESTORE02", {
        playerCount: 2,
        campaignPreset: "standard",
      });

      const state = original.toJSON();
      const restored = restoreGameSession(state);

      expect(restored).toBeInstanceOf(CampaignGameSession);
      expect(restored.mode).toBe("campaign");
      expect(restored.campaign).toBeDefined();

      original.cleanup();
      restored.cleanup();
    });

    test("should default to casual for missing mode", () => {
      const state = {
        id: "LEGACY01",
        players: [],
        settings: {},
      };

      const restored = restoreGameSession(state);
      expect(restored).toBeInstanceOf(CasualGameSession);
      restored.cleanup();
    });

    test("should default to casual for unknown mode with warning", () => {
      const consoleSpy = jest.spyOn(console, "warn").mockImplementation();
      const state = {
        id: "UNKNOWN01",
        mode: "tournament",
        players: [],
        settings: {},
      };

      const restored = restoreGameSession(state);
      expect(restored).toBeInstanceOf(CasualGameSession);
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
      restored.cleanup();
    });

    test("should pass broadcast function to restored session", () => {
      const broadcasts = [];
      const broadcastFn = (type, data) => broadcasts.push({ type, data });
      const state = {
        id: "BCAST01",
        mode: "casual",
        players: [],
        settings: {},
      };

      const restored = restoreGameSession(state, broadcastFn);
      restored.broadcastState();
      expect(broadcasts.length).toBeGreaterThan(0);
      restored.cleanup();
    });
  });
});

describe("CasualGameSession", () => {
  let session;

  beforeEach(() => {
    session = new CasualGameSession("CASUAL01", { playerCount: 2 });
  });

  afterEach(() => {
    session.cleanup();
  });

  test("should have mode set to casual", () => {
    expect(session.mode).toBe("casual");
  });

  test("should return correct mode name", () => {
    expect(session.getModeName()).toBe("Casual");
  });

  test("should return empty object for getModeState", () => {
    const modeState = session.getModeState();
    expect(modeState).toEqual({});
  });

  test("onGameComplete should do nothing (no-op for casual)", () => {
    expect(() => session.onGameComplete({ winnerId: 1 })).not.toThrow();
  });

  test("restoreModeState should do nothing", () => {
    expect(() => session.restoreModeState({ someData: true })).not.toThrow();
  });

  describe("fromState", () => {
    test("should restore session with correct properties", () => {
      session.setOwner("owner1");
      session.players[0].name = "TestPlayer";
      session.start();
      session.pause();

      const state = session.toJSON();
      const restored = CasualGameSession.fromState(state);

      expect(restored.id).toBe("CASUAL01");
      expect(restored.ownerId).toBe("owner1");
      expect(restored.players[0].name).toBe("TestPlayer");
      expect(restored.status).toBe("paused");
      expect(restored.mode).toBe("casual");

      restored.cleanup();
    });

    test("should pause running sessions when restoring", () => {
      session.start();
      const state = session.toJSON();
      state.status = "running";

      const restored = CasualGameSession.fromState(state);
      expect(restored.status).toBe("paused");
      restored.cleanup();
    });
  });
});

describe("CampaignState", () => {
  describe("constructor", () => {
    test("should initialize with default standard preset", () => {
      const state = new CampaignState();
      expect(state.preset).toBe("standard");
      expect(state.currentRound).toBe(1);
      expect(state.maxRounds).toBe(5);
      expect(state.campaignStatus).toBe("in_progress");
    });

    test("should initialize with specified preset", () => {
      const blitzState = new CampaignState("blitz", 2);
      expect(blitzState.preset).toBe("blitz");
      expect(blitzState.maxRounds).toBe(7);
    });

    test("should initialize player stats for all players", () => {
      const state = new CampaignState("standard", 4);
      expect(Object.keys(state.playerStats).length).toBe(4);
      for (let i = 1; i <= 4; i++) {
        expect(state.playerStats[i]).toEqual({
          wins: 0,
          losses: 0,
          totalTimeUsed: 0,
          penalties: 0,
          eliminations: 0,
          accumulatedPoints: 0,
        });
      }
    });

    test("should fall back to standard for invalid preset", () => {
      const state = new CampaignState("invalid", 2);
      expect(state.config.name).toBe("Standard Campaign");
    });
  });

  describe("getCurrentRoundTime", () => {
    test("should return initial time for first round", () => {
      const state = new CampaignState("standard", 2);
      expect(state.getCurrentRoundTime()).toBe(10 * 60 * 1000);
    });

    test("should decrease time for subsequent rounds", () => {
      const state = new CampaignState("standard", 2);
      state.currentRound = 2;
      expect(state.getCurrentRoundTime()).toBe(9 * 60 * 1000);
    });

    test("should respect minimum time", () => {
      const state = new CampaignState("standard", 2);
      state.currentRound = 10; // Way past max
      expect(state.getCurrentRoundTime()).toBe(5 * 60 * 1000);
    });

    test("should not decrease for endurance preset", () => {
      const state = new CampaignState("endurance", 2);
      state.currentRound = 5;
      expect(state.getCurrentRoundTime()).toBe(15 * 60 * 1000);
    });
  });

  describe("recordRound", () => {
    test("should record round in history", () => {
      const state = new CampaignState("standard", 2);
      const roundData = {
        players: {
          1: { timeUsed: 100000, penalties: 0 },
          2: { timeUsed: 150000, penalties: 1 },
        },
      };

      state.recordRound(1, roundData);

      expect(state.roundHistory.length).toBe(1);
      expect(state.roundHistory[0].winner).toBe(1);
      expect(state.roundHistory[0].round).toBe(1);
    });

    test("should update player stats", () => {
      const state = new CampaignState("standard", 2);
      const roundData = {
        players: {
          1: { timeUsed: 100000, penalties: 0 },
          2: { timeUsed: 150000, penalties: 2 },
        },
      };

      state.recordRound(1, roundData);

      expect(state.playerStats[1].wins).toBe(1);
      expect(state.playerStats[1].losses).toBe(0);
      expect(state.playerStats[2].wins).toBe(0);
      expect(state.playerStats[2].losses).toBe(1);
      expect(state.playerStats[2].penalties).toBe(2);
    });
  });

  describe("advanceRound", () => {
    test("should increment current round", () => {
      const state = new CampaignState("standard", 2);
      state.advanceRound();
      expect(state.currentRound).toBe(2);
    });

    test("should return true if campaign continues", () => {
      const state = new CampaignState("standard", 2);
      expect(state.advanceRound()).toBe(true);
    });

    test("should return false when max rounds exceeded", () => {
      const state = new CampaignState("standard", 2);
      state.currentRound = 5;
      expect(state.advanceRound()).toBe(false);
    });
  });

  describe("checkCampaignComplete", () => {
    test("should detect best_of winner", () => {
      const state = new CampaignState("standard", 2);
      state.playerStats[1].wins = 3;

      expect(state.checkCampaignComplete()).toBe(true);
      expect(state.winner).toBe(1);
      expect(state.campaignStatus).toBe("completed");
    });

    test("should detect first_to winner", () => {
      const state = new CampaignState("blitz", 2);
      state.playerStats[2].wins = 4;

      expect(state.checkCampaignComplete()).toBe(true);
      expect(state.winner).toBe(2);
    });

    test("should detect total_time winner after all rounds", () => {
      const state = new CampaignState("endurance", 2);
      state.currentRound = 11;
      state.playerStats[1].totalTimeUsed = 50000;
      state.playerStats[2].totalTimeUsed = 60000;

      expect(state.checkCampaignComplete()).toBe(true);
      expect(state.winner).toBe(1); // Less time used = more remaining
    });

    test("should return false when campaign not complete", () => {
      const state = new CampaignState("standard", 2);
      expect(state.checkCampaignComplete()).toBe(false);
    });
  });

  describe("serialization", () => {
    test("toJSON should return serializable state", () => {
      const state = new CampaignState("standard", 2);
      const json = state.toJSON();

      expect(json).toHaveProperty("preset", "standard");
      expect(json).toHaveProperty("currentRound", 1);
      expect(json).toHaveProperty("playerStats");
      expect(() => JSON.stringify(json)).not.toThrow();
    });

    test("fromState should restore campaign state", () => {
      const original = new CampaignState("blitz", 3);
      original.currentRound = 3;
      original.playerStats[1].wins = 2;

      const json = original.toJSON();
      const restored = CampaignState.fromState(json);

      expect(restored.preset).toBe("blitz");
      expect(restored.currentRound).toBe(3);
      expect(restored.playerStats[1].wins).toBe(2);
    });
  });
});

describe("CampaignGameSession", () => {
  let session;
  let broadcasts;

  beforeEach(() => {
    broadcasts = [];
    session = new CampaignGameSession(
      "CAMPAIGN01",
      { playerCount: 2, campaignPreset: "standard" },
      (type, data) => broadcasts.push({ type, data })
    );
  });

  afterEach(() => {
    session.cleanup();
  });

  test("should have mode set to campaign", () => {
    expect(session.mode).toBe("campaign");
  });

  test("should initialize campaign state", () => {
    expect(session.campaign).toBeInstanceOf(CampaignState);
    expect(session.campaign.currentRound).toBe(1);
  });

  test("should return correct mode name", () => {
    expect(session.getModeName()).toBe("Campaign - Standard Campaign");
  });

  test("should adjust initial time for current round", () => {
    expect(session.settings.initialTime).toBe(10 * 60 * 1000);
    expect(session.players[0].timeRemaining).toBe(10 * 60 * 1000);
  });

  describe("getModeState", () => {
    test("should include campaign state", () => {
      const modeState = session.getModeState();
      expect(modeState).toHaveProperty("campaign");
      expect(modeState.campaign).toHaveProperty("currentRound");
    });
  });

  describe("getState", () => {
    test("should include campaign info in state", () => {
      const state = session.getState();
      expect(state).toHaveProperty("campaign");
      expect(state.campaign).toHaveProperty("currentRound", 1);
      expect(state.campaign).toHaveProperty("maxRounds", 5);
      expect(state.campaign).toHaveProperty("playerStats");
    });
  });

  describe("prepareNextRound", () => {
    test("should reset for next round", () => {
      session.start();
      session.players[0].timeRemaining = 100;
      session.campaign.currentRound = 2;

      session.prepareNextRound();

      expect(session.status).toBe("waiting");
      expect(session.activePlayer).toBe(null);
      expect(session.players[0].timeRemaining).toBe(session.settings.initialTime);
    });

    test("should broadcast state after preparing", () => {
      broadcasts = [];
      session.prepareNextRound();
      expect(broadcasts.some(b => b.type === "state")).toBe(true);
    });
  });

  describe("onGameComplete", () => {
    test("should record round result", () => {
      session.start();
      session.players[0].timeRemaining = 300000;
      session.players[1].timeRemaining = 200000;

      session.onGameComplete({ winnerId: 1 });

      expect(session.campaign.roundHistory.length).toBe(1);
      expect(session.campaign.playerStats[1].wins).toBe(1);
    });

    test("should advance to next round if campaign continues", () => {
      session.start();
      session.onGameComplete({ winnerId: 1 });

      expect(session.campaign.currentRound).toBe(2);
      expect(session.status).toBe("waiting");
    });

    test("should finish campaign when complete", () => {
      session.campaign.playerStats[1].wins = 2;
      session.start();
      session.onGameComplete({ winnerId: 1 });

      expect(session.campaign.campaignStatus).toBe("completed");
      expect(session.status).toBe("finished");
    });

    test("should broadcast campaign complete event", () => {
      session.campaign.playerStats[1].wins = 2;
      session.start();
      broadcasts = [];
      session.onGameComplete({ winnerId: 1 });

      expect(broadcasts.some(b => b.type === "campaignComplete")).toBe(true);
    });
  });

  describe("fromState", () => {
    test("should restore campaign session with campaign state", () => {
      session.setOwner("owner1");
      session.campaign.playerStats[1].wins = 1;
      session.campaign.currentRound = 2;

      const state = session.toJSON();
      const restored = CampaignGameSession.fromState(state);

      expect(restored).toBeInstanceOf(CampaignGameSession);
      expect(restored.campaign.currentRound).toBe(2);
      expect(restored.campaign.playerStats[1].wins).toBe(1);

      restored.cleanup();
    });

    test("should pause running sessions when restoring", () => {
      session.start();
      const state = session.toJSON();
      state.status = "running";

      const restored = CampaignGameSession.fromState(state);
      expect(restored.status).toBe("paused");
      restored.cleanup();
    });
  });
});

describe("CAMPAIGN_PRESETS", () => {
  test("should have standard preset", () => {
    expect(CAMPAIGN_PRESETS.standard).toBeDefined();
    expect(CAMPAIGN_PRESETS.standard.name).toBe("Standard Campaign");
    expect(CAMPAIGN_PRESETS.standard.rounds).toBe(5);
  });

  test("should have blitz preset", () => {
    expect(CAMPAIGN_PRESETS.blitz).toBeDefined();
    expect(CAMPAIGN_PRESETS.blitz.name).toBe("Blitz Campaign");
    expect(CAMPAIGN_PRESETS.blitz.rounds).toBe(7);
  });

  test("should have endurance preset", () => {
    expect(CAMPAIGN_PRESETS.endurance).toBeDefined();
    expect(CAMPAIGN_PRESETS.endurance.name).toBe("Endurance Campaign");
    expect(CAMPAIGN_PRESETS.endurance.rounds).toBe(10);
  });
});

describe("BaseGameSession abstract methods", () => {
  test("getModeName should throw when called on base class directly", () => {
    const session = new BaseGameSession("BASE01", {});
    expect(() => session.getModeName()).toThrow("Subclass must implement getModeName()");
    session.cleanup();
  });

  test("getModeState should return empty object on base class", () => {
    const session = new BaseGameSession("BASE02", {});
    expect(session.getModeState()).toEqual({});
    session.cleanup();
  });

  test("onGameComplete should not throw on base class", () => {
    const session = new BaseGameSession("BASE03", {});
    expect(() => session.onGameComplete({})).not.toThrow();
    session.cleanup();
  });

  test("restoreModeState should not throw on base class", () => {
    const session = new BaseGameSession("BASE04", {});
    expect(() => session.restoreModeState({})).not.toThrow();
    session.cleanup();
  });
});

describe("BaseGameSession interrupt system", () => {
  let session;
  let broadcasts;

  beforeEach(() => {
    broadcasts = [];
    session = new CasualGameSession("INT01", { playerCount: 3 }, (type, data) =>
      broadcasts.push({ type, data })
    );
  });

  afterEach(() => {
    session.cleanup();
  });

  describe("interrupt", () => {
    test("should add player to interrupt queue", () => {
      session.interrupt(1);
      expect(session.interruptingPlayers).toContain(1);
    });

    test("should allow multiple players to interrupt", () => {
      session.interrupt(1);
      session.interrupt(2);
      expect(session.interruptingPlayers).toEqual([1, 2]);
    });

    test("should allow same player to interrupt multiple times", () => {
      session.interrupt(1);
      session.interrupt(1);
      expect(session.interruptingPlayers).toEqual([1, 1]);
    });

    test("should not add eliminated player to queue", () => {
      session.eliminate(1);
      session.interrupt(1);
      expect(session.interruptingPlayers).not.toContain(1);
    });

    test("should not add non-existent player to queue", () => {
      session.interrupt(99);
      expect(session.interruptingPlayers.length).toBe(0);
    });

    test("should broadcast state after interrupt", () => {
      broadcasts = [];
      session.interrupt(1);
      expect(broadcasts.some(b => b.type === "state")).toBe(true);
    });
  });

  describe("passPriority", () => {
    test("should remove last occurrence of player from queue", () => {
      session.interrupt(1);
      session.interrupt(2);
      session.interrupt(1);
      session.passPriority(1);
      expect(session.interruptingPlayers).toEqual([1, 2]);
    });

    test("should do nothing if player not in queue", () => {
      session.interrupt(1);
      session.passPriority(2);
      expect(session.interruptingPlayers).toEqual([1]);
    });

    test("should broadcast state after passing priority", () => {
      session.interrupt(1);
      broadcasts = [];
      session.passPriority(1);
      expect(broadcasts.some(b => b.type === "state")).toBe(true);
    });
  });

  describe("tick with interrupting players", () => {
    test("should decrement interrupting player time instead of active player", async () => {
      session.start();
      session.interrupt(2);

      const activeTime = session.players[0].timeRemaining;
      const interruptTime = session.players[1].timeRemaining;

      await new Promise(resolve => setTimeout(resolve, 150));

      expect(session.players[0].timeRemaining).toBe(activeTime);
      expect(session.players[1].timeRemaining).toBeLessThan(interruptTime);
    });
  });
});

describe("BaseGameSession.fromState validation", () => {
  test("should throw for invalid state (null)", () => {
    expect(() => BaseGameSession.fromState(null)).toThrow("Invalid state: missing required fields");
  });

  test("should throw for invalid state (missing id)", () => {
    expect(() => BaseGameSession.fromState({})).toThrow("Invalid state: missing required fields");
  });

  test("should handle missing optional fields", () => {
    const state = {
      id: "MINIMAL01",
      settings: { playerCount: 2 },
    };
    const session = BaseGameSession.fromState(state);
    expect(session.id).toBe("MINIMAL01");
    expect(session.ownerId).toBe(null);
    expect(session.interruptingPlayers).toEqual([]);
    session.cleanup();
  });

  test("should default mode to base", () => {
    const state = {
      id: "NOMODE01",
      settings: { playerCount: 2 },
    };
    const session = BaseGameSession.fromState(state);
    expect(session.mode).toBe("base");
    session.cleanup();
  });

  test("should restore interruptingPlayers array", () => {
    const state = {
      id: "INTERRUPT01",
      settings: { playerCount: 2 },
      interruptingPlayers: [1, 2],
    };
    const session = BaseGameSession.fromState(state);
    expect(session.interruptingPlayers).toEqual([1, 2]);
    session.cleanup();
  });
});
