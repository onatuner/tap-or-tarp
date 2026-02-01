const { BaseGameSession } = require("../lib/game-modes/base");
const { TARGETING } = require("../lib/shared/constants");

describe("Target Player System", () => {
  let session;
  let broadcastMessages;

  beforeEach(() => {
    broadcastMessages = [];
    session = new BaseGameSession("TEST01", { playerCount: 4 }, (type, data) => {
      broadcastMessages.push({ type, data });
    });
    // Start game so targeting can be used
    session.start();
  });

  afterEach(() => {
    session.cleanup();
  });

  describe("initial state", () => {
    test("should have targeting state set to NONE", () => {
      expect(session.targetingState).toBe(TARGETING.STATES.NONE);
    });

    test("should have empty targetedPlayers array", () => {
      expect(session.targetedPlayers).toEqual([]);
    });

    test("should have empty awaitingPriority array", () => {
      expect(session.awaitingPriority).toEqual([]);
    });

    test("should have null originalActivePlayer", () => {
      expect(session.originalActivePlayer).toBeNull();
    });
  });

  describe("startTargetSelection", () => {
    test("should enter selecting state", () => {
      expect(session.startTargetSelection()).toBe(true);
      expect(session.targetingState).toBe(TARGETING.STATES.SELECTING);
    });

    test("should clear targetedPlayers when starting", () => {
      session.startTargetSelection();
      session.toggleTarget(2);
      session.cancelTargeting();
      session.startTargetSelection();
      expect(session.targetedPlayers).toEqual([]);
    });

    test("should fail if game not running", () => {
      session.pause();
      expect(session.startTargetSelection()).toBe(false);
      expect(session.targetingState).toBe(TARGETING.STATES.NONE);
    });

    test("should fail if already in selecting state", () => {
      session.startTargetSelection();
      expect(session.startTargetSelection()).toBe(false);
    });

    test("should fail if in resolving state", () => {
      session.startTargetSelection();
      session.toggleTarget(2);
      session.confirmTargets();
      expect(session.startTargetSelection()).toBe(false);
    });
  });

  describe("toggleTarget", () => {
    beforeEach(() => {
      session.startTargetSelection();
    });

    test("should add player to targets", () => {
      expect(session.toggleTarget(2)).toBe(true);
      expect(session.targetedPlayers).toContain(2);
    });

    test("should remove player from targets on second toggle", () => {
      session.toggleTarget(2);
      expect(session.targetedPlayers).toContain(2);
      session.toggleTarget(2);
      expect(session.targetedPlayers).not.toContain(2);
    });

    test("should not allow targeting self", () => {
      expect(session.toggleTarget(1)).toBe(false); // activePlayer is 1
      expect(session.targetedPlayers).not.toContain(1);
    });

    test("should not allow targeting eliminated player", () => {
      session.players[1].isEliminated = true;
      expect(session.toggleTarget(2)).toBe(false);
      expect(session.targetedPlayers).not.toContain(2);
    });

    test("should not allow targeting non-existent player", () => {
      expect(session.toggleTarget(99)).toBe(false);
    });

    test("should allow multiple targets", () => {
      session.toggleTarget(2);
      session.toggleTarget(3);
      session.toggleTarget(4);
      expect(session.targetedPlayers).toEqual([2, 3, 4]);
    });

    test("should fail if not in selecting state", () => {
      session.confirmTargets(); // This fails because no targets
      expect(session.toggleTarget(2)).toBe(true); // Still in selecting
      session.confirmTargets();
      expect(session.toggleTarget(3)).toBe(false); // Now in resolving
    });
  });

  describe("confirmTargets", () => {
    beforeEach(() => {
      session.startTargetSelection();
      session.toggleTarget(2);
      session.toggleTarget(3);
    });

    test("should transition to resolving state", () => {
      expect(session.confirmTargets()).toBe(true);
      expect(session.targetingState).toBe(TARGETING.STATES.RESOLVING);
    });

    test("should store original active player", () => {
      session.confirmTargets();
      expect(session.originalActivePlayer).toBe(1);
    });

    test("should set first target as active", () => {
      session.confirmTargets();
      expect(session.activePlayer).toBe(2);
    });

    test("should set up awaitingPriority queue", () => {
      session.confirmTargets();
      expect(session.awaitingPriority).toEqual([2, 3]);
    });

    test("should fail if no targets selected", () => {
      session.toggleTarget(2); // Remove
      session.toggleTarget(3); // Remove
      expect(session.confirmTargets()).toBe(false);
      expect(session.targetingState).toBe(TARGETING.STATES.SELECTING);
    });

    test("should fail if not in selecting state", () => {
      session.cancelTargeting();
      expect(session.confirmTargets()).toBe(false);
    });
  });

  describe("passTargetPriority", () => {
    beforeEach(() => {
      session.startTargetSelection();
      session.toggleTarget(2);
      session.toggleTarget(3);
      session.confirmTargets();
    });

    test("should move to next target", () => {
      expect(session.passTargetPriority(2)).toBe(true);
      expect(session.activePlayer).toBe(3);
      expect(session.awaitingPriority).toEqual([3]);
    });

    test("should complete targeting when all pass", () => {
      session.passTargetPriority(2);
      session.passTargetPriority(3);
      expect(session.targetingState).toBe(TARGETING.STATES.NONE);
      expect(session.activePlayer).toBe(1); // Back to original
    });

    test("should clear all targeting state on completion", () => {
      session.passTargetPriority(2);
      session.passTargetPriority(3);
      expect(session.targetedPlayers).toEqual([]);
      expect(session.awaitingPriority).toEqual([]);
      expect(session.originalActivePlayer).toBeNull();
    });

    test("should fail for player not in awaiting list", () => {
      expect(session.passTargetPriority(4)).toBe(false);
    });

    test("should fail if not in resolving state", () => {
      session.cancelTargeting();
      expect(session.passTargetPriority(2)).toBe(false);
    });
  });

  describe("completeTargeting", () => {
    beforeEach(() => {
      session.startTargetSelection();
      session.toggleTarget(2);
      session.confirmTargets();
    });

    test("should return to original player", () => {
      session.completeTargeting();
      expect(session.activePlayer).toBe(1);
    });

    test("should reset all targeting state", () => {
      session.completeTargeting();
      expect(session.targetingState).toBe(TARGETING.STATES.NONE);
      expect(session.targetedPlayers).toEqual([]);
      expect(session.awaitingPriority).toEqual([]);
      expect(session.originalActivePlayer).toBeNull();
    });
  });

  describe("cancelTargeting", () => {
    test("should return to original player from resolving", () => {
      session.startTargetSelection();
      session.toggleTarget(2);
      session.confirmTargets();
      expect(session.activePlayer).toBe(2);

      session.cancelTargeting();
      expect(session.targetingState).toBe(TARGETING.STATES.NONE);
      expect(session.activePlayer).toBe(1);
    });

    test("should reset from selecting state", () => {
      session.startTargetSelection();
      session.toggleTarget(2);

      session.cancelTargeting();
      expect(session.targetingState).toBe(TARGETING.STATES.NONE);
      expect(session.targetedPlayers).toEqual([]);
    });

    test("should fail if not in targeting mode", () => {
      expect(session.cancelTargeting()).toBe(false);
    });

    test("should clear all targeting state", () => {
      session.startTargetSelection();
      session.toggleTarget(2);
      session.confirmTargets();
      session.cancelTargeting();

      expect(session.targetedPlayers).toEqual([]);
      expect(session.awaitingPriority).toEqual([]);
      expect(session.originalActivePlayer).toBeNull();
    });
  });

  describe("isTargeted", () => {
    test("should return true for targeted player", () => {
      session.startTargetSelection();
      session.toggleTarget(2);
      expect(session.isTargeted(2)).toBe(true);
    });

    test("should return false for non-targeted player", () => {
      session.startTargetSelection();
      session.toggleTarget(2);
      expect(session.isTargeted(3)).toBe(false);
    });
  });

  describe("isAwaitingTargetPriority", () => {
    test("should return true for player awaiting priority", () => {
      session.startTargetSelection();
      session.toggleTarget(2);
      session.toggleTarget(3);
      session.confirmTargets();
      expect(session.isAwaitingTargetPriority(2)).toBe(true);
      expect(session.isAwaitingTargetPriority(3)).toBe(true);
    });

    test("should return false after player passes", () => {
      session.startTargetSelection();
      session.toggleTarget(2);
      session.confirmTargets();
      session.passTargetPriority(2);
      expect(session.isAwaitingTargetPriority(2)).toBe(false);
    });

    test("should return false for non-targeted player", () => {
      session.startTargetSelection();
      session.toggleTarget(2);
      session.confirmTargets();
      expect(session.isAwaitingTargetPriority(3)).toBe(false);
    });
  });

  describe("reset", () => {
    test("should reset targeting state", () => {
      session.startTargetSelection();
      session.toggleTarget(2);
      session.confirmTargets();

      session.reset();

      expect(session.targetingState).toBe(TARGETING.STATES.NONE);
      expect(session.targetedPlayers).toEqual([]);
      expect(session.awaitingPriority).toEqual([]);
      expect(session.originalActivePlayer).toBeNull();
    });
  });

  describe("serialization", () => {
    test("getState should include targeting state", () => {
      session.startTargetSelection();
      session.toggleTarget(2);
      session.confirmTargets();

      const state = session.getState();

      expect(state.targetingState).toBe(TARGETING.STATES.RESOLVING);
      expect(state.targetedPlayers).toEqual([2]);
      expect(state.awaitingPriority).toEqual([2]);
      expect(state.originalActivePlayer).toBe(1);
    });

    test("toJSON should include targeting state", () => {
      session.startTargetSelection();
      session.toggleTarget(2);

      const json = session.toJSON();

      expect(json.targetingState).toBe(TARGETING.STATES.SELECTING);
      expect(json.targetedPlayers).toEqual([2]);
    });

    test("fromState should restore targeting state", () => {
      session.startTargetSelection();
      session.toggleTarget(2);
      session.toggleTarget(3);
      session.confirmTargets();

      const json = session.toJSON();
      const restored = BaseGameSession.fromState(json);

      expect(restored.targetingState).toBe(TARGETING.STATES.RESOLVING);
      expect(restored.targetedPlayers).toEqual([2, 3]);
      expect(restored.awaitingPriority).toEqual([2, 3]);
      expect(restored.originalActivePlayer).toBe(1);

      restored.cleanup();
    });

    test("fromState should handle missing targeting state", () => {
      const json = session.toJSON();
      delete json.targetingState;
      delete json.targetedPlayers;

      const restored = BaseGameSession.fromState(json);

      expect(restored.targetingState).toBe(TARGETING.STATES.NONE);
      expect(restored.targetedPlayers).toEqual([]);

      restored.cleanup();
    });
  });

  describe("complex scenarios", () => {
    test("full targeting flow with multiple targets", () => {
      // Original active player is 1
      expect(session.activePlayer).toBe(1);

      // Start selecting targets
      session.startTargetSelection();
      expect(session.targetingState).toBe(TARGETING.STATES.SELECTING);

      // Select players 2, 3, and 4
      session.toggleTarget(2);
      session.toggleTarget(3);
      session.toggleTarget(4);
      expect(session.targetedPlayers).toEqual([2, 3, 4]);

      // Confirm targets
      session.confirmTargets();
      expect(session.targetingState).toBe(TARGETING.STATES.RESOLVING);
      expect(session.originalActivePlayer).toBe(1);
      expect(session.activePlayer).toBe(2);

      // First target passes
      session.passTargetPriority(2);
      expect(session.activePlayer).toBe(3);
      expect(session.awaitingPriority).toEqual([3, 4]);

      // Second target passes
      session.passTargetPriority(3);
      expect(session.activePlayer).toBe(4);
      expect(session.awaitingPriority).toEqual([4]);

      // Last target passes
      session.passTargetPriority(4);
      expect(session.targetingState).toBe(TARGETING.STATES.NONE);
      expect(session.activePlayer).toBe(1); // Back to original
    });

    test("canceling during resolution returns to original player", () => {
      session.startTargetSelection();
      session.toggleTarget(2);
      session.toggleTarget(3);
      session.confirmTargets();
      session.passTargetPriority(2);
      expect(session.activePlayer).toBe(3);

      session.cancelTargeting();
      expect(session.activePlayer).toBe(1);
      expect(session.targetingState).toBe(TARGETING.STATES.NONE);
    });

    test("removing and re-adding a target during selection", () => {
      session.startTargetSelection();
      session.toggleTarget(2);
      session.toggleTarget(3);
      expect(session.targetedPlayers).toEqual([2, 3]);

      session.toggleTarget(2); // Remove 2
      expect(session.targetedPlayers).toEqual([3]);

      session.toggleTarget(4); // Add 4
      expect(session.targetedPlayers).toEqual([3, 4]);

      session.toggleTarget(2); // Re-add 2
      expect(session.targetedPlayers).toEqual([3, 4, 2]);
    });
  });
});
