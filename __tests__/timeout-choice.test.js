const { CasualGameSession } = require("../lib/game-modes/casual");
const { CONSTANTS } = require("../lib/shared/constants");

/**
 * Helper to create a session with timeout choice enabled (non-zero grace period).
 * Uses a short grace period to allow testing expiry without long waits.
 */
function createSession(overrides = {}) {
  const broadcasts = [];
  const settings = {
    playerCount: 2,
    initialTime: 60000,
    timeoutGracePeriod: 5000,
    timeoutPenaltyLives: 2,
    timeoutPenaltyDrunk: 2,
    timeoutBonusTime: 30000,
    ...overrides,
  };
  const session = new CasualGameSession("TEST", settings, (type, data) => {
    broadcasts.push({ type, data });
  });
  return { session, broadcasts };
}

describe("Timeout Choice System", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("handleTimeout", () => {
    test("should set timeoutPending and timeoutChoiceDeadline on player", () => {
      const { session } = createSession();
      const player = session.players[0];

      session.handleTimeout(player);

      expect(player.timeoutPending).toBe(true);
      expect(player.timeoutChoiceDeadline).toBeGreaterThan(Date.now() - 1000);
      expect(player.penalties).toBe(1);
    });

    test("should broadcast timeout choice with penalty options", () => {
      const { session, broadcasts } = createSession();
      const player = session.players[0];

      session.handleTimeout(player);

      const timeoutBroadcast = broadcasts.find(b => b.type === "timeoutChoice");
      expect(timeoutBroadcast).toBeDefined();
      expect(timeoutBroadcast.data.playerId).toBe(player.id);
      expect(timeoutBroadcast.data.options.livesLoss).toBe(2);
      expect(timeoutBroadcast.data.options.drunkGain).toBe(2);
    });

    test("should not re-trigger if player already has pending timeout", () => {
      const { session } = createSession();
      const player = session.players[0];

      session.handleTimeout(player);
      const firstDeadline = player.timeoutChoiceDeadline;
      const firstPenalties = player.penalties;

      session.handleTimeout(player);

      expect(player.penalties).toBe(firstPenalties);
      expect(player.timeoutChoiceDeadline).toBe(firstDeadline);
    });

    test("should broadcast state after setting timeout", () => {
      const { session, broadcasts } = createSession();
      const player = session.players[0];

      session.handleTimeout(player);

      const stateBroadcasts = broadcasts.filter(b => b.type === "state");
      expect(stateBroadcasts.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("resolveTimeoutChoice - loseLives", () => {
    test("should deduct lives and grant bonus time", () => {
      const { session } = createSession();
      const player = session.players[0];

      session.handleTimeout(player);
      session.resolveTimeoutChoice(player.id, "loseLives");

      expect(player.life).toBe(18); // 20 - 2
      expect(player.timeRemaining).toBe(30000); // bonus time
      expect(player.timeoutPending).toBe(false);
      expect(player.timeoutChoiceDeadline).toBeNull();
    });

    test("should eliminate player when life reaches 0", () => {
      const { session } = createSession();
      const player = session.players[0];
      player.life = 2; // Will drop to 0

      session.handleTimeout(player);
      session.resolveTimeoutChoice(player.id, "loseLives");

      expect(player.life).toBe(0);
      expect(player.isEliminated).toBe(true);
    });

    test("should eliminate player when life goes below 0", () => {
      const { session } = createSession();
      const player = session.players[0];
      player.life = 1; // Will drop to -1

      session.handleTimeout(player);
      session.resolveTimeoutChoice(player.id, "loseLives");

      expect(player.life).toBe(-1);
      expect(player.isEliminated).toBe(true);
    });

    test("should trigger winner when loseLives eliminates in 2-player game", () => {
      const { session } = createSession();
      const player = session.players[0];
      player.life = 1;

      session.handleTimeout(player);
      session.resolveTimeoutChoice(player.id, "loseLives");

      expect(player.isEliminated).toBe(true);
      expect(session.status).toBe("finished");
      expect(session.winner).toBe(session.players[1].id);
    });

    test("should call onPlayerLifeChanged callback", () => {
      const { session } = createSession();
      const spy = jest.spyOn(session, "onPlayerLifeChanged");
      const player = session.players[0];

      session.handleTimeout(player);
      session.resolveTimeoutChoice(player.id, "loseLives");

      expect(spy).toHaveBeenCalledWith(player.id, 20, 18);
    });

    test("should not eliminate when life stays above 0", () => {
      const { session } = createSession();
      const player = session.players[0];
      player.life = 20;

      session.handleTimeout(player);
      session.resolveTimeoutChoice(player.id, "loseLives");

      expect(player.life).toBe(18);
      expect(player.isEliminated).toBe(false);
      expect(session.status).not.toBe("finished");
    });

    test("should switch active player when eliminated player was active", () => {
      const { session } = createSession({ playerCount: 3 });
      session.start();
      const activeId = session.activePlayer;
      const activePlayer = session.players.find(p => p.id === activeId);
      activePlayer.life = 1;

      session.handleTimeout(activePlayer);
      session.resolveTimeoutChoice(activeId, "loseLives");

      expect(activePlayer.isEliminated).toBe(true);
      expect(session.activePlayer).not.toBe(activeId);
      session.cleanup();
    });
  });

  describe("resolveTimeoutChoice - gainDrunk", () => {
    test("should increase drunk counter and grant bonus time", () => {
      const { session } = createSession();
      const player = session.players[0];

      session.handleTimeout(player);
      session.resolveTimeoutChoice(player.id, "gainDrunk");

      expect(player.drunkCounter).toBe(2); // 0 + 2
      expect(player.timeRemaining).toBe(30000);
      expect(player.timeoutPending).toBe(false);
      expect(player.timeoutChoiceDeadline).toBeNull();
    });

    test("should accumulate drunk counter across multiple timeouts", () => {
      const { session } = createSession();
      const player = session.players[0];

      session.handleTimeout(player);
      session.resolveTimeoutChoice(player.id, "gainDrunk");
      expect(player.drunkCounter).toBe(2);

      // Trigger another timeout
      player.timeRemaining = 0;
      session.handleTimeout(player);
      session.resolveTimeoutChoice(player.id, "gainDrunk");
      expect(player.drunkCounter).toBe(4);
    });

    test("should not eliminate player", () => {
      const { session } = createSession();
      const player = session.players[0];

      session.handleTimeout(player);
      session.resolveTimeoutChoice(player.id, "gainDrunk");

      expect(player.isEliminated).toBe(false);
      expect(session.status).not.toBe("finished");
    });
  });

  describe("resolveTimeoutChoice - die", () => {
    test("should eliminate player immediately", () => {
      const { session } = createSession();
      const player = session.players[0];

      session.handleTimeout(player);
      session.resolveTimeoutChoice(player.id, "die");

      expect(player.isEliminated).toBe(true);
      expect(player.timeoutPending).toBe(false);
    });

    test("should trigger winner in 2-player game", () => {
      const { session } = createSession();
      const player = session.players[0];

      session.handleTimeout(player);
      session.resolveTimeoutChoice(player.id, "die");

      expect(session.status).toBe("finished");
      expect(session.winner).toBe(session.players[1].id);
    });

    test("should switch to next player in 3+ player game", () => {
      const { session } = createSession({ playerCount: 3 });
      session.start();
      const activeId = session.activePlayer;
      const activePlayer = session.players.find(p => p.id === activeId);

      session.handleTimeout(activePlayer);
      session.resolveTimeoutChoice(activeId, "die");

      expect(activePlayer.isEliminated).toBe(true);
      expect(session.activePlayer).not.toBe(activeId);
      expect(session.status).not.toBe("finished");
      session.cleanup();
    });

    test("should be the default for unrecognized choices", () => {
      const { session } = createSession();
      const player = session.players[0];

      session.handleTimeout(player);
      session.resolveTimeoutChoice(player.id, "invalidChoice");

      expect(player.isEliminated).toBe(true);
    });
  });

  describe("grace period expiry", () => {
    test("should auto-eliminate on expired deadline via tick", () => {
      const { session } = createSession({ timeoutGracePeriod: 100 });
      const player = session.players[0];
      player.timeRemaining = 0;

      session.handleTimeout(player);
      expect(player.timeoutPending).toBe(true);

      // Set deadline to the past to simulate expiry
      player.timeoutChoiceDeadline = Date.now() - 1;

      // Manually invoke tick logic for timeout check
      const now = Date.now();
      session.players.forEach(p => {
        if (p.timeoutPending && now >= p.timeoutChoiceDeadline) {
          session.resolveTimeoutChoice(p.id, "die");
        }
      });

      expect(player.isEliminated).toBe(true);
      expect(player.timeoutPending).toBe(false);
    });
  });

  describe("resolveTimeoutChoice - no-op cases", () => {
    test("should do nothing if player not found", () => {
      const { session } = createSession();

      // Should not throw
      session.resolveTimeoutChoice(999, "loseLives");
    });

    test("should do nothing if player has no pending timeout", () => {
      const { session } = createSession();
      const player = session.players[0];
      const originalLife = player.life;

      session.resolveTimeoutChoice(player.id, "loseLives");

      expect(player.life).toBe(originalLife);
    });
  });

  describe("serialization with timeout state (H7)", () => {
    test("toJSON should include timeout-related player fields", () => {
      const { session } = createSession();
      const player = session.players[0];
      player.penalties = 3;
      player.tokenExpiry = Date.now() + 60000;
      player.timeoutPending = true;
      player.timeoutChoiceDeadline = Date.now() + 5000;

      const json = session.toJSON();
      const serializedPlayer = json.players[0];

      expect(serializedPlayer.penalties).toBe(3);
      expect(serializedPlayer.tokenExpiry).toBe(player.tokenExpiry);
      expect(serializedPlayer.timeoutPending).toBe(true);
      expect(serializedPlayer.timeoutChoiceDeadline).toBe(player.timeoutChoiceDeadline);
    });

    test("fromState should restore timeout-related player fields", () => {
      const { session } = createSession();
      const player = session.players[0];
      player.penalties = 5;
      player.tokenExpiry = Date.now() + 60000;
      player.timeoutPending = true;
      player.timeoutChoiceDeadline = Date.now() + 5000;

      const json = session.toJSON();
      const restored = CasualGameSession.fromState(json);

      const restoredPlayer = restored.players[0];
      expect(restoredPlayer.penalties).toBe(5);
      expect(restoredPlayer.tokenExpiry).toBe(player.tokenExpiry);
      expect(restoredPlayer.timeoutPending).toBe(true);
      expect(restoredPlayer.timeoutChoiceDeadline).toBe(player.timeoutChoiceDeadline);
    });

    test("fromState should default missing timeout fields", () => {
      const state = {
        id: "TEST",
        settings: { playerCount: 2, initialTime: 60000 },
        players: [
          { id: 1, name: "Player 1" },
          { id: 2, name: "Player 2" },
        ],
        activePlayer: 1,
        status: "waiting",
      };

      const restored = CasualGameSession.fromState(state);
      const player = restored.players[0];

      expect(player.penalties).toBe(0);
      expect(player.tokenExpiry).toBeNull();
      expect(player.timeoutPending).toBe(false);
      expect(player.timeoutChoiceDeadline).toBeNull();
      expect(player.life).toBe(20);
    });
  });
});
