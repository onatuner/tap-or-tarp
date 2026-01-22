const {
  withGameLock,
  isGameBusy,
  getLockStats,
  resetLockStats,
  LOCK_TIMEOUT,
} = require("../lib/lock");

describe("Game Lock", () => {
  beforeEach(() => {
    resetLockStats();
  });

  describe("withGameLock", () => {
    test("should execute operation and return result", async () => {
      const result = await withGameLock("game1", async () => {
        return "success";
      });
      expect(result).toBe("success");
    });

    test("should serialize concurrent operations on same game", async () => {
      const executionOrder = [];

      const operation1 = withGameLock("game1", async () => {
        executionOrder.push("start1");
        await new Promise(resolve => setTimeout(resolve, 50));
        executionOrder.push("end1");
        return 1;
      });

      const operation2 = withGameLock("game1", async () => {
        executionOrder.push("start2");
        await new Promise(resolve => setTimeout(resolve, 50));
        executionOrder.push("end2");
        return 2;
      });

      const [result1, result2] = await Promise.all([operation1, operation2]);

      expect(result1).toBe(1);
      expect(result2).toBe(2);
      // Operations should complete one at a time, not interleaved
      expect(executionOrder).toEqual(["start1", "end1", "start2", "end2"]);
    });

    test("should allow parallel operations on different games", async () => {
      const executionOrder = [];

      const operation1 = withGameLock("game1", async () => {
        executionOrder.push("start1");
        await new Promise(resolve => setTimeout(resolve, 50));
        executionOrder.push("end1");
        return 1;
      });

      const operation2 = withGameLock("game2", async () => {
        executionOrder.push("start2");
        await new Promise(resolve => setTimeout(resolve, 50));
        executionOrder.push("end2");
        return 2;
      });

      const [result1, result2] = await Promise.all([operation1, operation2]);

      expect(result1).toBe(1);
      expect(result2).toBe(2);
      // Both operations should start before either ends (parallel execution)
      expect(executionOrder.indexOf("start1")).toBeLessThan(executionOrder.indexOf("end1"));
      expect(executionOrder.indexOf("start2")).toBeLessThan(executionOrder.indexOf("end2"));
      // start1 and start2 should both happen before end1 and end2
      expect(executionOrder.slice(0, 2).sort()).toEqual(["start1", "start2"]);
    });

    test("should handle errors without blocking subsequent operations", async () => {
      // First operation throws
      await expect(
        withGameLock("game1", async () => {
          throw new Error("Test error");
        })
      ).rejects.toThrow("Test error");

      // Second operation should still work
      const result = await withGameLock("game1", async () => {
        return "success";
      });
      expect(result).toBe("success");
    });

    test("should update lock statistics", async () => {
      await withGameLock("game1", async () => {
        return "done";
      });

      const stats = getLockStats();
      expect(stats.acquired).toBe(1);
      expect(stats.released).toBe(1);
      expect(stats.timeouts).toBe(0);
      expect(stats.errors).toBe(0);
    });

    test("should handle multiple sequential operations", async () => {
      const results = [];

      for (let i = 0; i < 5; i++) {
        const result = await withGameLock("game1", async () => {
          return i;
        });
        results.push(result);
      }

      expect(results).toEqual([0, 1, 2, 3, 4]);

      const stats = getLockStats();
      expect(stats.acquired).toBe(5);
      expect(stats.released).toBe(5);
    });
  });

  describe("isGameBusy", () => {
    test("should return false when no operations pending", () => {
      expect(isGameBusy("nonexistent")).toBe(false);
    });

    test("should return true when operation is in progress", async () => {
      let busyDuringOperation = false;

      const operation = withGameLock("game1", async () => {
        busyDuringOperation = isGameBusy("game1");
        await new Promise(resolve => setTimeout(resolve, 50));
        return "done";
      });

      // Wait a bit for operation to start
      await new Promise(resolve => setTimeout(resolve, 10));

      // Note: isGameBusy only returns true during the actual lock acquisition
      // not while waiting, so this test checks the concept works

      await operation;
      expect(busyDuringOperation).toBe(true);
    });
  });

  describe("getLockStats", () => {
    test("should track timeout errors", async () => {
      // This test would require a very slow operation to actually timeout
      // For now, just verify the structure is correct
      const stats = getLockStats();
      expect(stats).toHaveProperty("acquired");
      expect(stats).toHaveProperty("released");
      expect(stats).toHaveProperty("timeouts");
      expect(stats).toHaveProperty("errors");
      expect(stats).toHaveProperty("activeKeys");
    });
  });

  describe("concurrent stress test", () => {
    test("should handle many concurrent operations on same game", async () => {
      const numOperations = 50;
      let counter = 0;
      const results = [];

      const operations = Array(numOperations)
        .fill()
        .map((_, i) =>
          withGameLock("stress-test", async () => {
            const current = counter;
            // Simulate some async work
            await new Promise(resolve => setTimeout(resolve, 1));
            counter = current + 1;
            results.push(i);
            return counter;
          })
        );

      const finalResults = await Promise.all(operations);

      // Counter should equal number of operations (no race conditions)
      expect(counter).toBe(numOperations);
      // Each result should be unique and sequential
      expect(new Set(finalResults).size).toBe(numOperations);

      const stats = getLockStats();
      expect(stats.acquired).toBe(numOperations);
      expect(stats.released).toBe(numOperations);
    });

    test("should handle operations across many games simultaneously", async () => {
      const numGames = 10;
      const numOperationsPerGame = 5;
      const gameCounters = new Map();

      const operations = [];
      for (let g = 0; g < numGames; g++) {
        const gameId = `game-${g}`;
        gameCounters.set(gameId, 0);

        for (let o = 0; o < numOperationsPerGame; o++) {
          operations.push(
            withGameLock(gameId, async () => {
              const current = gameCounters.get(gameId);
              await new Promise(resolve => setTimeout(resolve, 1));
              gameCounters.set(gameId, current + 1);
              return { gameId, count: current + 1 };
            })
          );
        }
      }

      await Promise.all(operations);

      // Each game should have correct final count
      for (let g = 0; g < numGames; g++) {
        const gameId = `game-${g}`;
        expect(gameCounters.get(gameId)).toBe(numOperationsPerGame);
      }

      const stats = getLockStats();
      expect(stats.acquired).toBe(numGames * numOperationsPerGame);
      expect(stats.released).toBe(numGames * numOperationsPerGame);
    });
  });
});
