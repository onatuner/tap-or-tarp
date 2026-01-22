const { RateLimiter, ConnectionRateLimiter, getClientIP } = require("../lib/rate-limiter");

// Mock logger
jest.mock("../lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

describe("RateLimiter", () => {
  let limiter;

  beforeEach(() => {
    limiter = new RateLimiter({
      windowMs: 1000,
      maxRequests: 5,
      cleanupInterval: 60000,
    });
  });

  afterEach(() => {
    limiter.close();
  });

  describe("isAllowed", () => {
    test("should allow requests within limit", () => {
      const ip = "192.168.1.1";
      for (let i = 0; i < 5; i++) {
        expect(limiter.isAllowed(ip)).toBe(true);
      }
    });

    test("should deny requests exceeding limit", () => {
      const ip = "192.168.1.1";
      for (let i = 0; i < 5; i++) {
        limiter.isAllowed(ip);
      }
      expect(limiter.isAllowed(ip)).toBe(false);
    });

    test("should track different IPs separately", () => {
      const ip1 = "192.168.1.1";
      const ip2 = "192.168.1.2";

      // Exhaust ip1
      for (let i = 0; i < 5; i++) {
        limiter.isAllowed(ip1);
      }
      expect(limiter.isAllowed(ip1)).toBe(false);

      // ip2 should still be allowed
      expect(limiter.isAllowed(ip2)).toBe(true);
    });

    test("should reset after window expires", async () => {
      const ip = "192.168.1.1";

      // Exhaust limit
      for (let i = 0; i < 5; i++) {
        limiter.isAllowed(ip);
      }
      expect(limiter.isAllowed(ip)).toBe(false);

      // Wait for window to expire
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Should be allowed again
      expect(limiter.isAllowed(ip)).toBe(true);
    });

    test("should update statistics", () => {
      const ip = "192.168.1.1";

      limiter.isAllowed(ip); // allowed
      limiter.isAllowed(ip); // allowed

      const stats = limiter.getStats();
      expect(stats.allowed).toBe(2);
      expect(stats.denied).toBe(0);
    });

    test("should track denied requests in statistics", () => {
      const ip = "192.168.1.1";

      for (let i = 0; i < 6; i++) {
        limiter.isAllowed(ip);
      }

      const stats = limiter.getStats();
      expect(stats.allowed).toBe(5);
      expect(stats.denied).toBe(1);
    });
  });

  describe("getRemaining", () => {
    test("should return max for new IP", () => {
      expect(limiter.getRemaining("new-ip")).toBe(5);
    });

    test("should return correct remaining count", () => {
      const ip = "192.168.1.1";
      limiter.isAllowed(ip);
      limiter.isAllowed(ip);
      expect(limiter.getRemaining(ip)).toBe(3);
    });

    test("should return 0 when exhausted", () => {
      const ip = "192.168.1.1";
      for (let i = 0; i < 5; i++) {
        limiter.isAllowed(ip);
      }
      expect(limiter.getRemaining(ip)).toBe(0);
    });
  });

  describe("getResetTime", () => {
    test("should return 0 for new IP", () => {
      expect(limiter.getResetTime("new-ip")).toBe(0);
    });

    test("should return time until reset", () => {
      const ip = "192.168.1.1";
      limiter.isAllowed(ip);
      const resetTime = limiter.getResetTime(ip);
      expect(resetTime).toBeGreaterThan(0);
      expect(resetTime).toBeLessThanOrEqual(1000);
    });
  });

  describe("cleanup", () => {
    test("should remove expired entries", async () => {
      const ip = "192.168.1.1";
      limiter.isAllowed(ip);

      // Wait for window to expire (2x window for cleanup threshold)
      await new Promise(resolve => setTimeout(resolve, 2100));

      limiter.cleanup();

      // IP should be gone, so remaining should be max
      expect(limiter.getRemaining(ip)).toBe(5);
    });
  });

  describe("getStats", () => {
    test("should return correct statistics", () => {
      const stats = limiter.getStats();
      expect(stats).toHaveProperty("allowed");
      expect(stats).toHaveProperty("denied");
      expect(stats).toHaveProperty("uniqueIPs");
      expect(stats).toHaveProperty("windowMs", 1000);
      expect(stats).toHaveProperty("maxRequests", 5);
    });
  });

  describe("resetStats", () => {
    test("should reset statistics", () => {
      limiter.isAllowed("192.168.1.1");
      limiter.resetStats();
      const stats = limiter.getStats();
      expect(stats.allowed).toBe(0);
      expect(stats.denied).toBe(0);
    });
  });
});

describe("ConnectionRateLimiter", () => {
  let limiter;

  beforeEach(() => {
    limiter = new ConnectionRateLimiter({
      windowMs: 1000,
      maxConnections: 3,
    });
  });

  afterEach(() => {
    limiter.close();
  });

  test("should allow connections within limit", () => {
    const ip = "192.168.1.1";
    expect(limiter.isConnectionAllowed(ip)).toBe(true);
    expect(limiter.isConnectionAllowed(ip)).toBe(true);
    expect(limiter.isConnectionAllowed(ip)).toBe(true);
  });

  test("should deny connections exceeding limit", () => {
    const ip = "192.168.1.1";
    limiter.isConnectionAllowed(ip);
    limiter.isConnectionAllowed(ip);
    limiter.isConnectionAllowed(ip);
    expect(limiter.isConnectionAllowed(ip)).toBe(false);
  });
});

describe("getClientIP", () => {
  test("should extract IP from x-forwarded-for header", () => {
    const req = {
      headers: {
        "x-forwarded-for": "203.0.113.195, 70.41.3.18, 150.172.238.178",
      },
      socket: { remoteAddress: "127.0.0.1" },
    };
    expect(getClientIP(req)).toBe("203.0.113.195");
  });

  test("should extract IP from x-real-ip header", () => {
    const req = {
      headers: {
        "x-real-ip": "203.0.113.195",
      },
      socket: { remoteAddress: "127.0.0.1" },
    };
    expect(getClientIP(req)).toBe("203.0.113.195");
  });

  test("should extract IP from fly-client-ip header", () => {
    const req = {
      headers: {
        "fly-client-ip": "203.0.113.195",
      },
      socket: { remoteAddress: "127.0.0.1" },
    };
    expect(getClientIP(req)).toBe("203.0.113.195");
  });

  test("should fall back to socket remoteAddress", () => {
    const req = {
      headers: {},
      socket: { remoteAddress: "192.168.1.1" },
    };
    expect(getClientIP(req)).toBe("192.168.1.1");
  });

  test("should handle missing socket gracefully", () => {
    const req = {
      headers: {},
    };
    expect(getClientIP(req)).toBe("unknown");
  });

  test("should prefer x-forwarded-for over other headers", () => {
    const req = {
      headers: {
        "x-forwarded-for": "203.0.113.1",
        "x-real-ip": "203.0.113.2",
        "fly-client-ip": "203.0.113.3",
      },
      socket: { remoteAddress: "127.0.0.1" },
    };
    expect(getClientIP(req)).toBe("203.0.113.1");
  });

  test("should trim whitespace from x-forwarded-for", () => {
    const req = {
      headers: {
        "x-forwarded-for": "  203.0.113.195  ,  70.41.3.18  ",
      },
      socket: { remoteAddress: "127.0.0.1" },
    };
    expect(getClientIP(req)).toBe("203.0.113.195");
  });
});

describe("RateLimiter stress test", () => {
  test("should handle many IPs efficiently", () => {
    const limiter = new RateLimiter({
      windowMs: 1000,
      maxRequests: 10,
      cleanupInterval: 60000,
    });

    const startTime = Date.now();
    const numIPs = 1000;
    const requestsPerIP = 5;

    for (let i = 0; i < numIPs; i++) {
      const ip = `192.168.${Math.floor(i / 256)}.${i % 256}`;
      for (let j = 0; j < requestsPerIP; j++) {
        limiter.isAllowed(ip);
      }
    }

    const elapsed = Date.now() - startTime;
    expect(elapsed).toBeLessThan(1000); // Should complete in under 1 second

    const stats = limiter.getStats();
    expect(stats.uniqueIPs).toBe(numIPs);
    expect(stats.allowed).toBe(numIPs * requestsPerIP);

    limiter.close();
  });
});
