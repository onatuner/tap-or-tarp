const {
  CONSTANTS,
  formatTime,
  formatTimeWithDeciseconds,
  calculateReconnectDelay,
  findNextActivePlayer,
  getTimeWarningLevel,
  parseWarningThresholds,
} = require("../lib/client-utils");

describe("formatTime", () => {
  test("should format 0 milliseconds", () => {
    expect(formatTime(0)).toBe("0:00");
  });

  test("should format negative milliseconds as 0:00", () => {
    expect(formatTime(-1000)).toBe("0:00");
  });

  test("should format seconds correctly", () => {
    expect(formatTime(1000)).toBe("0:01");
    expect(formatTime(30000)).toBe("0:30");
    expect(formatTime(59000)).toBe("0:59");
  });

  test("should format minutes correctly", () => {
    expect(formatTime(60000)).toBe("1:00");
    expect(formatTime(90000)).toBe("1:30");
    expect(formatTime(300000)).toBe("5:00");
  });

  test("should format large times correctly", () => {
    expect(formatTime(3600000)).toBe("60:00"); // 1 hour
    expect(formatTime(7200000)).toBe("120:00"); // 2 hours
  });

  test("should round up milliseconds to next second", () => {
    expect(formatTime(1)).toBe("0:01");
    expect(formatTime(500)).toBe("0:01");
    expect(formatTime(999)).toBe("0:01");
    expect(formatTime(1001)).toBe("0:02");
  });

  test("should pad seconds with leading zero", () => {
    expect(formatTime(5000)).toBe("0:05");
    expect(formatTime(65000)).toBe("1:05");
  });
});

describe("formatTimeWithDeciseconds", () => {
  test("should format 0 milliseconds", () => {
    expect(formatTimeWithDeciseconds(0)).toBe("0:00.0");
  });

  test("should format negative milliseconds", () => {
    expect(formatTimeWithDeciseconds(-1000)).toBe("0:00.0");
  });

  test("should include deciseconds", () => {
    expect(formatTimeWithDeciseconds(100)).toBe("0:00.1");
    expect(formatTimeWithDeciseconds(500)).toBe("0:00.5");
    expect(formatTimeWithDeciseconds(900)).toBe("0:00.9");
  });

  test("should format seconds and deciseconds", () => {
    expect(formatTimeWithDeciseconds(1500)).toBe("0:01.5");
    expect(formatTimeWithDeciseconds(59900)).toBe("0:59.9");
  });

  test("should format minutes, seconds and deciseconds", () => {
    expect(formatTimeWithDeciseconds(61500)).toBe("1:01.5");
    expect(formatTimeWithDeciseconds(305200)).toBe("5:05.2");
  });

  test("should truncate to deciseconds (not round)", () => {
    expect(formatTimeWithDeciseconds(150)).toBe("0:00.1");
    expect(formatTimeWithDeciseconds(199)).toBe("0:00.1");
  });
});

describe("calculateReconnectDelay", () => {
  test("should return initial delay for 0 attempts", () => {
    expect(calculateReconnectDelay(0)).toBe(1000);
  });

  test("should double delay with each attempt", () => {
    expect(calculateReconnectDelay(1)).toBe(2000);
    expect(calculateReconnectDelay(2)).toBe(4000);
    expect(calculateReconnectDelay(3)).toBe(8000);
  });

  test("should cap at max delay", () => {
    expect(calculateReconnectDelay(10)).toBe(30000);
    expect(calculateReconnectDelay(20)).toBe(30000);
    expect(calculateReconnectDelay(100)).toBe(30000);
  });

  test("should reach max around attempt 5", () => {
    // 1000 * 2^5 = 32000, capped to 30000
    expect(calculateReconnectDelay(5)).toBe(30000);
  });
});

describe("findNextActivePlayer", () => {
  const createPlayers = () => [
    { id: 1, name: "Player 1", isEliminated: false },
    { id: 2, name: "Player 2", isEliminated: false },
    { id: 3, name: "Player 3", isEliminated: false },
    { id: 4, name: "Player 4", isEliminated: false },
  ];

  test("should find next player in sequence", () => {
    const players = createPlayers();
    const next = findNextActivePlayer(players, 1);
    expect(next.id).toBe(2);
  });

  test("should wrap around to first player", () => {
    const players = createPlayers();
    const next = findNextActivePlayer(players, 4);
    expect(next.id).toBe(1);
  });

  test("should skip eliminated players", () => {
    const players = createPlayers();
    players[1].isEliminated = true; // Player 2 eliminated
    const next = findNextActivePlayer(players, 1);
    expect(next.id).toBe(3);
  });

  test("should skip multiple eliminated players", () => {
    const players = createPlayers();
    players[1].isEliminated = true;
    players[2].isEliminated = true;
    const next = findNextActivePlayer(players, 1);
    expect(next.id).toBe(4);
  });

  test("should return null if no active players found", () => {
    const players = createPlayers();
    players.forEach(p => (p.isEliminated = true));
    players[0].isEliminated = false; // Only current player active
    const next = findNextActivePlayer(players, 1);
    expect(next).toBe(null);
  });

  test("should return null for null/undefined players", () => {
    expect(findNextActivePlayer(null, 1)).toBe(null);
    expect(findNextActivePlayer(undefined, 1)).toBe(null);
  });

  test("should return null for empty array", () => {
    expect(findNextActivePlayer([], 1)).toBe(null);
  });

  test("should return null for single player", () => {
    const players = [{ id: 1, name: "Player 1", isEliminated: false }];
    expect(findNextActivePlayer(players, 1)).toBe(null);
  });

  test("should return null for invalid current player ID", () => {
    const players = createPlayers();
    expect(findNextActivePlayer(players, 99)).toBe(null);
  });
});

describe("getTimeWarningLevel", () => {
  test("should return critical for time below critical threshold", () => {
    expect(getTimeWarningLevel(59999)).toBe("critical");
    expect(getTimeWarningLevel(30000)).toBe("critical");
    expect(getTimeWarningLevel(1000)).toBe("critical");
    expect(getTimeWarningLevel(0)).toBe("critical");
  });

  test("should return warning for time below 5 min threshold", () => {
    expect(getTimeWarningLevel(299999)).toBe("warning");
    expect(getTimeWarningLevel(120000)).toBe("warning");
    expect(getTimeWarningLevel(60000)).toBe("warning"); // At critical threshold, not below
  });

  test("should return null for time at or above 5 min", () => {
    expect(getTimeWarningLevel(300000)).toBe(null);
    expect(getTimeWarningLevel(600000)).toBe(null);
    expect(getTimeWarningLevel(1800000)).toBe(null);
  });
});

describe("parseWarningThresholds", () => {
  test("should parse comma-separated values", () => {
    const result = parseWarningThresholds("5, 1, 0.5");
    expect(result).toEqual([300000, 60000, 30000]);
  });

  test("should handle single value", () => {
    const result = parseWarningThresholds("5");
    expect(result).toEqual([300000]);
  });

  test("should filter out zero and negative values", () => {
    const result = parseWarningThresholds("5, 0, -1, 1");
    expect(result).toEqual([300000, 60000]);
  });

  test("should handle decimal minutes", () => {
    const result = parseWarningThresholds("0.5, 0.25");
    expect(result).toEqual([30000, 15000]);
  });

  test("should return empty array for non-string input", () => {
    expect(parseWarningThresholds(null)).toEqual([]);
    expect(parseWarningThresholds(undefined)).toEqual([]);
    expect(parseWarningThresholds(123)).toEqual([]);
  });

  test("should handle empty string", () => {
    expect(parseWarningThresholds("")).toEqual([]);
  });

  test("should handle whitespace", () => {
    const result = parseWarningThresholds("  5  ,  1  ");
    expect(result).toEqual([300000, 60000]);
  });

  test("should filter out NaN values", () => {
    const result = parseWarningThresholds("5, abc, 1");
    expect(result).toEqual([300000, 60000]);
  });
});

describe("CONSTANTS", () => {
  test("should have correct values", () => {
    expect(CONSTANTS.RECONNECT_INITIAL_DELAY).toBe(1000);
    expect(CONSTANTS.RECONNECT_MAX_DELAY).toBe(30000);
    expect(CONSTANTS.TIME_ADJUSTMENT_MS).toBe(60000);
    expect(CONSTANTS.WARNING_THRESHOLD_5MIN).toBe(300000);
    expect(CONSTANTS.WARNING_THRESHOLD_1MIN).toBe(60000);
    expect(CONSTANTS.CRITICAL_THRESHOLD).toBe(60000);
    expect(CONSTANTS.MINUTE_MS).toBe(60000);
  });
});
