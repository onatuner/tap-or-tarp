/**
 * Wastelands Campaign Tests
 *
 * Tests for damage tracking, scoring, levels, multipliers,
 * serialization, and win condition.
 */

const {
  CampaignGameSession,
  CampaignState,
  CAMPAIGN_PRESETS,
} = require("../lib/game-modes/campaign");
const {
  wastelandsPreset,
  BATTLE_MULTIPLIERS,
  PLAYER_MULTIPLIERS,
  LEVEL_THRESHOLDS,
  scoringFormula,
} = require("../lib/game-modes/campaign-presets/wastelands");

function createWastelandsSession(playerCount = 4) {
  const broadcastMessages = [];
  const broadcastFn = (type, data) => broadcastMessages.push({ type, data });
  const session = new CampaignGameSession("test-wastelands", {
    campaignPreset: "wastelands",
    playerCount,
  }, broadcastFn);
  return { session, broadcastMessages };
}

describe("Wastelands Preset", () => {
  test("should be registered in CAMPAIGN_PRESETS", () => {
    expect(CAMPAIGN_PRESETS.wastelands).toBeDefined();
    expect(CAMPAIGN_PRESETS.wastelands.name).toBe("The Wastelands");
  });

  test("should have correct configuration", () => {
    expect(wastelandsPreset.rounds).toBe(3);
    expect(wastelandsPreset.timePerRound).toBe(6 * 60 * 1000);
    expect(wastelandsPreset.timeDecreasePerRound).toBe(0);
    expect(wastelandsPreset.bonusTime).toBe(30 * 1000);
    expect(wastelandsPreset.winCondition).toBe("total_points");
  });

  test("should have battle multipliers for rounds 1-3", () => {
    expect(BATTLE_MULTIPLIERS[1]).toBe(1.0);
    expect(BATTLE_MULTIPLIERS[2]).toBe(1.5);
    expect(BATTLE_MULTIPLIERS[3]).toBe(2.0);
  });

  test("should have player multipliers for 0-7 targets", () => {
    expect(PLAYER_MULTIPLIERS[0]).toBe(0);
    expect(PLAYER_MULTIPLIERS[1]).toBe(1.0);
    expect(PLAYER_MULTIPLIERS[7]).toBe(4.0);
  });

  test("should have level thresholds", () => {
    expect(LEVEL_THRESHOLDS).toEqual([10, 25, 50, 80, 120]);
  });
});

describe("Wastelands Session Setup", () => {
  test("should apply preset bonus time", () => {
    const { session } = createWastelandsSession();
    expect(session.settings.bonusTime).toBe(30 * 1000);
  });

  test("should set initial time to 6 minutes", () => {
    const { session } = createWastelandsSession();
    expect(session.settings.initialTime).toBe(6 * 60 * 1000);
  });

  test("should initialize 3 rounds", () => {
    const { session } = createWastelandsSession();
    expect(session.campaign.maxRounds).toBe(3);
  });
});

describe("Damage Recording", () => {
  test("should record damage when active player reduces another player life", () => {
    const { session } = createWastelandsSession();
    session.status = "running";
    session.activePlayer = 1;
    // Player 1 deals 3 damage to player 2
    session.updatePlayer(2, { life: 17 }); // default is 20
    expect(session.campaign.damageTracker[1][2]).toBe(3);
  });

  test("should not record damage for healing", () => {
    const { session } = createWastelandsSession();
    session.status = "running";
    session.activePlayer = 1;
    // First deal some damage
    session.updatePlayer(2, { life: 17 });
    // Then heal
    session.updatePlayer(2, { life: 20 });
    // Damage should still be 3, not reduced
    expect(session.campaign.damageTracker[1][2]).toBe(3);
  });

  test("should not record self-damage", () => {
    const { session } = createWastelandsSession();
    session.status = "running";
    session.activePlayer = 1;
    session.updatePlayer(1, { life: 15 });
    expect(session.campaign.damageTracker[1][1]).toBeUndefined();
  });

  test("should not record damage when no active player", () => {
    const { session } = createWastelandsSession();
    session.status = "running";
    session.activePlayer = null;
    session.updatePlayer(2, { life: 15 });
    // No damage tracked for any player
    expect(session.campaign.getTotalDamage(1)).toBe(0);
    expect(session.campaign.getTotalDamage(2)).toBe(0);
  });

  test("should not record damage when game is not running", () => {
    const { session } = createWastelandsSession();
    session.status = "waiting";
    session.activePlayer = 1;
    session.updatePlayer(2, { life: 15 });
    expect(session.campaign.getTotalDamage(1)).toBe(0);
  });

  test("should attribute damage to interrupting player", () => {
    const { session } = createWastelandsSession();
    session.status = "running";
    session.activePlayer = 1;
    // Player 2 claims and interrupts
    session.players[1].claimedBy = "client-2";
    session.interrupt(2);
    // Player 2 deals damage to player 3 during interrupt
    session.updatePlayer(3, { life: 15 });
    expect(session.campaign.damageTracker[2][3]).toBe(5);
    // Active player should NOT get credit
    expect(session.campaign.damageTracker[1]?.[3]).toBeUndefined();
  });

  test("should attribute damage to original active player during targeting resolution", () => {
    const { session } = createWastelandsSession();
    session.status = "running";
    session.activePlayer = 2; // Targeting changes active player
    session.originalActivePlayer = 1;
    session.targetingState = "resolving";
    session.updatePlayer(3, { life: 15 });
    // Original active player gets credit
    expect(session.campaign.damageTracker[1][3]).toBe(5);
  });

  test("should accumulate damage across multiple updates", () => {
    const { session } = createWastelandsSession();
    session.status = "running";
    session.activePlayer = 1;
    session.updatePlayer(2, { life: 17 }); // 3 damage
    session.updatePlayer(2, { life: 14 }); // 3 more damage
    expect(session.campaign.damageTracker[1][2]).toBe(6);
  });

  test("should track damage to multiple targets", () => {
    const { session } = createWastelandsSession();
    session.status = "running";
    session.activePlayer = 1;
    session.updatePlayer(2, { life: 17 }); // 3 to player 2
    session.updatePlayer(3, { life: 15 }); // 5 to player 3
    expect(session.campaign.damageTracker[1][2]).toBe(3);
    expect(session.campaign.damageTracker[1][3]).toBe(5);
    expect(session.campaign.getTotalDamage(1)).toBe(8);
    expect(session.campaign.getUniqueDamagedCount(1)).toBe(2);
  });
});

describe("Scoring Formula", () => {
  test("should calculate points with single target (round 1)", () => {
    const { session } = createWastelandsSession();
    session.status = "running";
    session.activePlayer = 1;
    session.updatePlayer(2, { life: 10 }); // 10 damage
    // round 1: battleMult=1.0, 1 unique target: playerMult=1.0
    // points = 0 + floor(10 * 1.0 * 1.0) = 10
    expect(session.campaign.playerPoints[1]).toBe(10);
  });

  test("should scale with player multiplier for multiple targets", () => {
    const { session } = createWastelandsSession();
    session.status = "running";
    session.activePlayer = 1;
    session.updatePlayer(2, { life: 15 }); // 5 damage
    session.updatePlayer(3, { life: 15 }); // 5 damage
    // 2 unique targets: playerMult=1.5, battleMult=1.0
    // points = 0 + floor(10 * 1.5 * 1.0) = 15
    expect(session.campaign.playerPoints[1]).toBe(15);
  });

  test("should give 0 points when damaging 0 targets", () => {
    const state = new CampaignState("wastelands", 2);
    // No damage recorded
    state.recalculateAllScores();
    expect(state.playerPoints[1]).toBe(0);
    expect(state.playerPoints[2]).toBe(0);
  });

  test("should include accumulated points from previous rounds", () => {
    const state = new CampaignState("wastelands", 2);
    // Simulate previous round accumulated points
    state.playerStats[1].accumulatedPoints = 20;
    state.recordDamage(1, 2, 10);
    state.recalculateAllScores();
    // 20 + floor(10 * 1.0 * 1.0) = 30
    expect(state.playerPoints[1]).toBe(30);
  });

  test("should apply battle multiplier for later rounds", () => {
    const state = new CampaignState("wastelands", 2);
    state.currentRound = 3; // battleMult = 2.0
    state.recordDamage(1, 2, 10);
    state.recalculateAllScores();
    // 0 + floor(10 * 1.0 * 2.0) = 20
    expect(state.playerPoints[1]).toBe(20);
  });
});

describe("Level Thresholds", () => {
  test("should start at level 1 with 0 points", () => {
    const state = new CampaignState("wastelands", 2);
    expect(state.playerLevels[1]).toBe(1);
  });

  test("should be level 2 at 10 points", () => {
    const state = new CampaignState("wastelands", 2);
    state.recordDamage(1, 2, 10);
    state.recalculateAllScores();
    expect(state.playerLevels[1]).toBe(2);
  });

  test("should be level 3 at 25 points", () => {
    const state = new CampaignState("wastelands", 2);
    state.recordDamage(1, 2, 25);
    state.recalculateAllScores();
    expect(state.playerLevels[1]).toBe(3);
  });

  test("should be level 6 at 120+ points", () => {
    const state = new CampaignState("wastelands", 2);
    state.playerStats[1].accumulatedPoints = 120;
    state.recalculateAllScores();
    expect(state.playerLevels[1]).toBe(6);
  });

  test("should stay level 1 below first threshold", () => {
    const state = new CampaignState("wastelands", 2);
    state.recordDamage(1, 2, 9);
    state.recalculateAllScores();
    expect(state.playerLevels[1]).toBe(1);
  });
});

describe("Round Finalization", () => {
  test("should save accumulated points and reset damage tracker", () => {
    const state = new CampaignState("wastelands", 2);
    state.recordDamage(1, 2, 10);
    state.recordDamage(2, 1, 5);
    state.finalizeRoundScoring();

    // Points saved to accumulated
    expect(state.playerStats[1].accumulatedPoints).toBe(10);
    expect(state.playerStats[2].accumulatedPoints).toBe(5);

    // Damage tracker reset
    expect(state.damageTracker[1]).toEqual({});
    expect(state.damageTracker[2]).toEqual({});
  });

  test("should preserve accumulated points across rounds", () => {
    const state = new CampaignState("wastelands", 2);

    // Round 1
    state.recordDamage(1, 2, 10);
    state.finalizeRoundScoring();
    expect(state.playerStats[1].accumulatedPoints).toBe(10);

    // Round 2
    state.currentRound = 2;
    state.recordDamage(1, 2, 10);
    state.recalculateAllScores();
    // 10 accumulated + floor(10 * 1.0 * 1.5) = 25
    expect(state.playerPoints[1]).toBe(25);

    state.finalizeRoundScoring();
    expect(state.playerStats[1].accumulatedPoints).toBe(25);
  });
});

describe("Serialization Round-Trip", () => {
  test("should preserve scoring data through toJSON/fromState", () => {
    const state = new CampaignState("wastelands", 3);
    state.recordDamage(1, 2, 10);
    state.recordDamage(2, 3, 5);
    state.recalculateAllScores();

    const json = state.toJSON();
    const restored = CampaignState.fromState(json);

    expect(restored.damageTracker).toEqual(state.damageTracker);
    expect(restored.playerPoints).toEqual(state.playerPoints);
    expect(restored.playerLevels).toEqual(state.playerLevels);
  });

  test("should re-attach scoring formula after restore", () => {
    const state = new CampaignState("wastelands", 2);
    const json = state.toJSON();

    // Functions are stripped from JSON
    expect(json.config.scoringFormula).toBeUndefined();

    const restored = CampaignState.fromState(json);
    // Function should be re-attached from preset registry
    expect(restored.config.scoringFormula).toBe(scoringFormula);
  });

  test("should re-attach level thresholds after restore", () => {
    const state = new CampaignState("wastelands", 2);
    const json = state.toJSON();
    const restored = CampaignState.fromState(json);
    expect(restored.config.levelThresholds).toEqual(LEVEL_THRESHOLDS);
  });

  test("should handle missing scoring data in old persisted state", () => {
    const state = new CampaignState("wastelands", 2);
    const json = state.toJSON();
    // Simulate old state without scoring fields
    delete json.damageTracker;
    delete json.playerPoints;
    delete json.playerLevels;

    const restored = CampaignState.fromState(json);
    expect(restored.damageTracker).toEqual({});
    expect(restored.playerPoints).toEqual({});
    expect(restored.playerLevels).toEqual({});
  });
});

describe("Total Points Win Condition", () => {
  test("should determine winner by most points after all rounds", () => {
    const state = new CampaignState("wastelands", 2);

    // Simulate 3 rounds of scoring
    state.recordDamage(1, 2, 20);
    state.recordDamage(2, 1, 10);
    state.finalizeRoundScoring();
    state.currentRound = 2;

    state.recordDamage(1, 2, 15);
    state.recordDamage(2, 1, 10);
    state.finalizeRoundScoring();
    state.currentRound = 3;

    state.recordDamage(1, 2, 10);
    state.recordDamage(2, 1, 10);
    state.finalizeRoundScoring();

    // Advance past all rounds
    state.currentRound = 4;

    const complete = state.checkCampaignComplete();
    expect(complete).toBe(true);
    expect(state.campaignStatus).toBe("completed");
    // Player 1 should win (more total damage = more points)
    expect(state.winner).toBe(1);
  });

  test("should not complete before all rounds are done", () => {
    const state = new CampaignState("wastelands", 2);
    state.currentRound = 2; // Still in progress
    expect(state.checkCampaignComplete()).toBe(false);
  });
});

describe("Backward Compatibility", () => {
  test("standard preset should not have scoring formula", () => {
    const state = new CampaignState("standard", 2);
    expect(state.config.scoringFormula).toBeUndefined();
    state.recalculateAllScores();
    expect(state.playerPoints[1]).toBe(0);
    expect(state.playerPoints[2]).toBe(0);
  });

  test("standard preset should default to level 1", () => {
    const state = new CampaignState("standard", 2);
    state.recalculateAllScores();
    expect(state.playerLevels[1]).toBe(1);
    expect(state.playerLevels[2]).toBe(1);
  });

  test("blitz preset should work without scoring", () => {
    const state = new CampaignState("blitz", 2);
    state.recordDamage(1, 2, 10);
    state.recalculateAllScores();
    expect(state.playerPoints[1]).toBe(0);
  });

  test("endurance preset should work without scoring", () => {
    const state = new CampaignState("endurance", 2);
    state.recordDamage(1, 2, 10);
    state.recalculateAllScores();
    expect(state.playerPoints[1]).toBe(0);
  });
});

describe("CampaignGameSession getState with Wastelands", () => {
  test("should include scoring data in broadcast state", () => {
    const { session } = createWastelandsSession();
    session.status = "running";
    session.activePlayer = 1;
    session.updatePlayer(2, { life: 15 });

    const state = session.getState();
    expect(state.campaign.damageTracker).toBeDefined();
    expect(state.campaign.playerPoints).toBeDefined();
    expect(state.campaign.playerLevels).toBeDefined();
    expect(state.campaign.playerPoints[1]).toBe(5);
  });

  test("should not include function references in broadcast config", () => {
    const { session } = createWastelandsSession();
    const state = session.getState();
    expect(state.campaign.config.scoringFormula).toBeUndefined();
    expect(state.campaign.config.name).toBe("The Wastelands");
    expect(state.campaign.config.battleMultipliers).toBeDefined();
    expect(state.campaign.config.playerMultipliers).toBeDefined();
  });
});
