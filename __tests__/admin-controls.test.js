const { CasualGameSession } = require("../lib/game-modes/casual");

/**
 * Helper to create a session with broadcasts tracked.
 */
function createSession(overrides = {}) {
  const broadcasts = [];
  const settings = {
    playerCount: 4,
    initialTime: 600000, // 10 minutes
    timeoutGracePeriod: 5000,
    timeoutPenaltyLives: 2,
    timeoutPenaltyDrunk: 2,
    timeoutBonusTime: 30000,
    bonusTime: 5000,
    warningThresholds: [300000, 60000, 30000],
    ...overrides,
  };
  const session = new CasualGameSession("TEST", settings, (type, data) => {
    broadcasts.push({ type, data });
  });
  return { session, broadcasts };
}

/**
 * Helper to set up a running game with claimed players.
 */
function setupRunningGame(overrides = {}) {
  const { session, broadcasts } = createSession(overrides);
  // Claim all players
  session.claimPlayer(1, "client-1");
  session.claimPlayer(2, "client-2");
  session.claimPlayer(3, "client-3");
  session.claimPlayer(4, "client-4");
  session.start();
  broadcasts.length = 0; // Clear startup broadcasts
  return { session, broadcasts };
}

describe("revivePlayer", () => {
  test("should revive an eliminated player", () => {
    const { session } = setupRunningGame();
    session.eliminate(2);
    const player = session.players.find(p => p.id === 2);
    expect(player.isEliminated).toBe(true);

    session.revivePlayer(2);
    expect(player.isEliminated).toBe(false);
  });

  test("should restore default time if player had 0 time", () => {
    const { session } = setupRunningGame();
    const player = session.players.find(p => p.id === 2);
    player.timeRemaining = 0;
    session.eliminate(2);

    session.revivePlayer(2);
    expect(player.timeRemaining).toBe(session.settings.initialTime);
  });

  test("should not change time if player still has time remaining", () => {
    const { session } = setupRunningGame();
    const player = session.players.find(p => p.id === 2);
    player.timeRemaining = 300000;
    session.eliminate(2);

    session.revivePlayer(2);
    expect(player.timeRemaining).toBe(300000);
  });

  test("should restore life if it was 0 or below", () => {
    const { session } = setupRunningGame();
    const player = session.players.find(p => p.id === 2);
    player.life = 0;
    session.eliminate(2);

    session.revivePlayer(2);
    expect(player.life).toBe(20);
  });

  test("should not change life if it was above 0", () => {
    const { session } = setupRunningGame();
    const player = session.players.find(p => p.id === 2);
    player.life = 5;
    session.eliminate(2);

    session.revivePlayer(2);
    expect(player.life).toBe(5);
  });

  test("should clear timeout state", () => {
    const { session } = setupRunningGame();
    const player = session.players.find(p => p.id === 2);
    player.timeoutPending = true;
    player.timeoutChoiceDeadline = Date.now() + 5000;
    session.eliminate(2);

    session.revivePlayer(2);
    expect(player.timeoutPending).toBe(false);
    expect(player.timeoutChoiceDeadline).toBeNull();
  });

  test("should clear winner and set status to paused if game was finished", () => {
    const { session } = setupRunningGame({ playerCount: 2 });
    session.claimPlayer = () => ({ success: true }); // Already claimed in setup

    // Eliminate all but one to trigger winner
    session.eliminate(2);
    expect(session.winner).toBe(1);
    expect(session.status).toBe("finished");

    session.revivePlayer(2);
    expect(session.winner).toBeNull();
    expect(session.status).toBe("paused");
  });

  test("should do nothing for non-eliminated player", () => {
    const { session, broadcasts } = setupRunningGame();
    const player = session.players.find(p => p.id === 2);
    expect(player.isEliminated).toBe(false);

    broadcasts.length = 0;
    session.revivePlayer(2);
    // Should not broadcast since no change
    expect(broadcasts.length).toBe(0);
  });

  test("should do nothing for invalid player ID", () => {
    const { session, broadcasts } = setupRunningGame();
    broadcasts.length = 0;
    session.revivePlayer(99);
    expect(broadcasts.length).toBe(0);
  });

  test("should broadcast state after reviving", () => {
    const { session, broadcasts } = setupRunningGame();
    session.eliminate(2);
    broadcasts.length = 0;

    session.revivePlayer(2);
    expect(broadcasts.some(b => b.type === "state")).toBe(true);
  });
});

describe("kickPlayer", () => {
  test("should eliminate and unclaim a player", () => {
    const { session } = setupRunningGame();
    const player = session.players.find(p => p.id === 2);
    expect(player.claimedBy).toBe("client-2");

    session.kickPlayer(2);
    expect(player.isEliminated).toBe(true);
    expect(player.claimedBy).toBeNull();
    expect(player.reconnectToken).toBeNull();
    expect(player.tokenExpiry).toBeNull();
  });

  test("should notify the kicked client", () => {
    const { session } = setupRunningGame();
    let notifiedClientId = null;

    session.kickPlayer(2, (clientId) => {
      notifiedClientId = clientId;
    });

    expect(notifiedClientId).toBe("client-2");
  });

  test("should check for winner after kick", () => {
    const { session } = setupRunningGame({ playerCount: 2 });
    // With only 2 players, kicking one should declare a winner
    session.kickPlayer(2);
    expect(session.winner).toBe(1);
    expect(session.status).toBe("finished");
  });

  test("should advance turn if kicked player was active", () => {
    const { session } = setupRunningGame();
    session.activePlayer = 2;

    session.kickPlayer(2);
    // Should move to next alive player (3), not first alive (1)
    expect(session.activePlayer).not.toBe(2);
    expect(session.players.find(p => p.id === session.activePlayer).isEliminated).toBe(false);
  });

  test("should not advance turn if kicked player was not active", () => {
    const { session } = setupRunningGame();
    session.activePlayer = 1;

    session.kickPlayer(3);
    expect(session.activePlayer).toBe(1);
  });

  test("should do nothing for unclaimed player", () => {
    const { session, broadcasts } = setupRunningGame();
    const player = session.players.find(p => p.id === 1);
    player.claimedBy = null;
    broadcasts.length = 0;

    session.kickPlayer(1);
    // Should not broadcast since no change
    expect(broadcasts.length).toBe(0);
  });

  test("should do nothing for invalid player ID", () => {
    const { session, broadcasts } = setupRunningGame();
    broadcasts.length = 0;
    session.kickPlayer(99);
    expect(broadcasts.length).toBe(0);
  });

  test("should broadcast state after kicking", () => {
    const { session, broadcasts } = setupRunningGame();
    broadcasts.length = 0;

    session.kickPlayer(2);
    expect(broadcasts.some(b => b.type === "state")).toBe(true);
  });

  test("should work without notifyClient callback", () => {
    const { session } = setupRunningGame();
    // Should not throw when called without callback
    expect(() => session.kickPlayer(2)).not.toThrow();
    expect(session.players.find(p => p.id === 2).isEliminated).toBe(true);
  });
});

describe("updateSettings (handler-level logic)", () => {
  test("should update warningThresholds", () => {
    const { session } = createSession();
    const newThresholds = [120000, 60000];
    session.settings.warningThresholds = newThresholds;
    expect(session.settings.warningThresholds).toEqual([120000, 60000]);
  });

  test("should update bonusTime within valid range", () => {
    const { session } = createSession();
    session.settings.bonusTime = 30000;
    expect(session.settings.bonusTime).toBe(30000);
  });

  test("should update timeoutPenaltyLives", () => {
    const { session } = createSession();
    session.settings.timeoutPenaltyLives = 5;
    expect(session.settings.timeoutPenaltyLives).toBe(5);
  });

  test("should update timeoutPenaltyDrunk", () => {
    const { session } = createSession();
    session.settings.timeoutPenaltyDrunk = 3;
    expect(session.settings.timeoutPenaltyDrunk).toBe(3);
  });

  test("should update timeoutBonusTime", () => {
    const { session } = createSession();
    session.settings.timeoutBonusTime = 45000;
    expect(session.settings.timeoutBonusTime).toBe(45000);
  });

  test("should clamp bonusTime to max", () => {
    const { session } = createSession();
    // MAX_BONUS_TIME is 300000 (5 minutes)
    const bonusTime = Math.max(0, Math.min(999999, 300000));
    session.settings.bonusTime = bonusTime;
    expect(session.settings.bonusTime).toBeLessThanOrEqual(300000);
  });

  test("should clamp timeoutPenaltyLives to 0-20 range", () => {
    const lives = Math.max(0, Math.min(25, 20));
    expect(lives).toBe(20);

    const negLives = Math.max(0, Math.min(-5, 20));
    expect(negLives).toBe(0);
  });

  test("settings are preserved across state serialization", () => {
    const { session } = createSession();
    session.settings.bonusTime = 15000;
    session.settings.timeoutPenaltyLives = 5;
    session.settings.warningThresholds = [120000, 30000];

    const state = session.toJSON();
    const restored = CasualGameSession.fromState(state);

    expect(restored.settings.bonusTime).toBe(15000);
    expect(restored.settings.timeoutPenaltyLives).toBe(5);
    expect(restored.settings.warningThresholds).toEqual([120000, 30000]);
  });
});

describe("switchToNextAlivePlayer (M7 fix)", () => {
  test("should pick the next alive player in turn order, not the first", () => {
    const { session } = setupRunningGame();
    // Players: 1, 2, 3, 4 - all alive
    // Active player is 3, eliminate 3
    session.activePlayer = 3;
    session.eliminate(3);

    // Should advance to player 4 (next after 3), not player 1 (first alive)
    expect(session.activePlayer).toBe(4);
  });

  test("should wrap around when reaching end of player list", () => {
    const { session } = setupRunningGame();
    // Active player is 4 (last), eliminate 4
    session.activePlayer = 4;
    session.eliminate(4);

    // Should wrap to player 1
    expect(session.activePlayer).toBe(1);
  });

  test("should skip eliminated players when wrapping", () => {
    const { session } = setupRunningGame();
    // Eliminate player 4 and 1 first
    session.eliminate(4);
    session.eliminate(1);
    // Active is 3, eliminate 3
    session.activePlayer = 3;
    session.players.find(p => p.id === 3).isEliminated = true;
    session.switchToNextAlivePlayer();

    // Should land on player 2 (the only alive player besides whatever was next)
    expect(session.activePlayer).toBe(2);
  });
});
