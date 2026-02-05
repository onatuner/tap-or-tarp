const { BaseGameSession } = require("../lib/game-modes/base");
const { TARGETING } = require("../lib/shared/constants");

describe("Targeting Edge Cases", () => {
  let session;
  let broadcastMessages;

  beforeEach(() => {
    broadcastMessages = [];
    session = new BaseGameSession(
      "TEST01",
      { playerCount: 4, timeoutGracePeriod: 0 },
      (type, data) => {
        broadcastMessages.push({ type, data });
      }
    );
    // Start game so targeting can be used
    session.start();
  });

  afterEach(() => {
    session.cleanup();
  });

  describe("timeout during targeting", () => {
    beforeEach(() => {
      session.startTargetSelection();
      session.toggleTarget(2);
      session.confirmTargets();
      // Set target player's time very low
      const targetPlayer = session.players.find(p => p.id === 2);
      targetPlayer.timeRemaining = 50;
    });

    it("should auto-pass priority when target times out", () => {
      // Simulate tick that causes timeout
      session.lastTick = Date.now() - 100;
      session.tick();

      // Should have auto-passed and returned to original player
      expect(session.targetingState).toBe(TARGETING.STATES.NONE);
      expect(session.activePlayer).toBe(1);
    });

    it("should eliminate the timed-out target", () => {
      session.lastTick = Date.now() - 100;
      session.tick();

      const targetPlayer = session.players.find(p => p.id === 2);
      expect(targetPlayer.isEliminated).toBe(true);
    });

    it("should not pause the game when target times out", () => {
      session.lastTick = Date.now() - 100;
      session.tick();

      // Game should still be running (not paused) because targeting continues
      // After targeting completes, the game continues
      expect(session.status).toBe("running");
    });

    it("should continue with remaining target if multiple targets and first times out", () => {
      // Add another target
      session.cancelTargeting();
      session.startTargetSelection();
      session.toggleTarget(2);
      session.toggleTarget(3);
      session.confirmTargets();

      // Set first target's time very low
      const target1 = session.players.find(p => p.id === 2);
      target1.timeRemaining = 50;

      // Simulate tick that causes timeout
      session.lastTick = Date.now() - 100;
      session.tick();

      // Should continue resolution with remaining target
      expect(session.targetingState).toBe(TARGETING.STATES.RESOLVING);
      expect(session.activePlayer).toBe(1); // activePlayer stays as original during parallel resolution
      expect(session.awaitingPriority).toEqual([3]);
    });
  });

  describe("elimination during targeting", () => {
    beforeEach(() => {
      session.startTargetSelection();
      session.toggleTarget(2);
      session.toggleTarget(3);
      session.confirmTargets();
    });

    it("should skip eliminated target via handleEliminatedTarget", () => {
      session.players.find(p => p.id === 2).isEliminated = true;
      session.handleEliminatedTarget(2);

      expect(session.awaitingPriority).not.toContain(2);
      expect(session.activePlayer).toBe(1); // activePlayer stays as original during parallel resolution
    });

    it("should complete targeting if all targets eliminated", () => {
      session.players.find(p => p.id === 2).isEliminated = true;
      session.players.find(p => p.id === 3).isEliminated = true;
      session.handleEliminatedTarget(2);
      session.handleEliminatedTarget(3);

      expect(session.targetingState).toBe(TARGETING.STATES.NONE);
      expect(session.activePlayer).toBe(1);
    });

    it("should handle elimination via eliminate() during targeting", () => {
      session.eliminate(2);

      expect(session.awaitingPriority).not.toContain(2);
      expect(session.activePlayer).toBe(1); // activePlayer stays as original during parallel resolution
    });

    it("should complete targeting when last target eliminated via eliminate()", () => {
      // Pass priority for first target
      session.passTargetPriority(2);
      expect(session.activePlayer).toBe(1); // activePlayer stays as original during parallel resolution

      // Eliminate the last remaining target
      session.eliminate(3);

      expect(session.targetingState).toBe(TARGETING.STATES.NONE);
      expect(session.activePlayer).toBe(1);
    });

    it("should handle elimination via life dropping to 0", () => {
      session.updatePlayer(2, { life: 0 });

      expect(session.awaitingPriority).not.toContain(2);
      expect(session.activePlayer).toBe(1); // activePlayer stays as original during parallel resolution
    });
  });

  describe("pause during targeting", () => {
    beforeEach(() => {
      session.startTargetSelection();
      session.toggleTarget(2);
      session.confirmTargets();
    });

    it("should preserve targeting state when paused", () => {
      session.pause();

      expect(session.status).toBe("paused");
      expect(session.targetingState).toBe(TARGETING.STATES.RESOLVING);
      expect(session.awaitingPriority).toContain(2);
      expect(session.originalActivePlayer).toBe(1);
    });

    it("should preserve targeted players when paused", () => {
      session.pause();

      expect(session.targetedPlayers).toContain(2);
    });

    it("should preserve active player when paused", () => {
      session.pause();

      expect(session.activePlayer).toBe(1); // activePlayer stays as original during parallel resolution
    });
  });

  describe("resume during targeting", () => {
    beforeEach(() => {
      session.startTargetSelection();
      session.toggleTarget(2);
      session.confirmTargets();
      session.pause();
    });

    it("should resume to same targeting state", () => {
      session.resume();

      expect(session.status).toBe("running");
      expect(session.targetingState).toBe(TARGETING.STATES.RESOLVING);
    });

    it("should maintain active player after resume", () => {
      session.resume();

      expect(session.activePlayer).toBe(1); // activePlayer stays as original during parallel resolution
    });

    it("should allow target to pass priority after resume", () => {
      session.resume();
      session.passTargetPriority(2);

      expect(session.targetingState).toBe(TARGETING.STATES.NONE);
      expect(session.activePlayer).toBe(1);
    });

    it("should maintain awaiting priority queue after resume", () => {
      session.resume();

      expect(session.awaitingPriority).toContain(2);
    });
  });

  describe("tick only active player during targeting", () => {
    beforeEach(() => {
      session.startTargetSelection();
      session.toggleTarget(2);
      session.confirmTargets();
    });

    it("should only tick the active target, not original player", () => {
      const originalPlayer = session.players.find(p => p.id === 1);
      const targetPlayer = session.players.find(p => p.id === 2);
      const originalTime = originalPlayer.timeRemaining;
      const targetTime = targetPlayer.timeRemaining;

      // Simulate a tick
      session.lastTick = Date.now() - 100;
      session.tick();

      // Original player's time should be unchanged
      expect(originalPlayer.timeRemaining).toBe(originalTime);
      // Target's time should have decreased
      expect(targetPlayer.timeRemaining).toBeLessThan(targetTime);
    });

    it("should tick all targets simultaneously during resolution", () => {
      // Add multiple targets
      session.cancelTargeting();
      session.startTargetSelection();
      session.toggleTarget(2);
      session.toggleTarget(3);
      session.confirmTargets();

      const target1 = session.players.find(p => p.id === 2);
      const target2 = session.players.find(p => p.id === 3);
      const target1Time = target1.timeRemaining;
      const target2Time = target2.timeRemaining;

      session.lastTick = Date.now() - 100;
      session.tick();

      // ALL targets should tick simultaneously during resolution
      expect(target1.timeRemaining).toBeLessThan(target1Time);
      expect(target2.timeRemaining).toBeLessThan(target2Time);
    });
  });

  describe("original player elimination during targeting", () => {
    beforeEach(() => {
      session.startTargetSelection();
      session.toggleTarget(2);
      session.confirmTargets();
    });

    it("should complete targeting if original player eliminated", () => {
      // Eliminate the original player
      session.players.find(p => p.id === 1).isEliminated = true;

      // Pass priority from target
      session.passTargetPriority(2);

      // Targeting should complete, but active player should be original player
      // (even if eliminated, completeTargeting returns to original)
      expect(session.targetingState).toBe(TARGETING.STATES.NONE);
      expect(session.activePlayer).toBe(1);
    });
  });

  describe("serialization preserves targeting state", () => {
    it("should preserve targeting state through toJSON and fromState", () => {
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
      expect(restored.activePlayer).toBe(1); // activePlayer stays as original during parallel resolution

      restored.cleanup();
    });
  });

  describe("targeting with interrupt queue", () => {
    it("should not interfere with interrupt queue when targeting", () => {
      // This tests that targeting and interrupts are separate systems
      session.interrupt(3); // Player 3 interrupts
      expect(session.interruptingPlayers).toContain(3);

      // Starting target selection shouldn't clear interrupts
      session.startTargetSelection();
      expect(session.interruptingPlayers).toContain(3);
    });
  });
});
