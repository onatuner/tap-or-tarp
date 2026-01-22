/**
 * IP-based rate limiting for WebSocket connections
 * Prevents abuse by limiting requests per IP address across all connections
 */

const { logger } = require("./logger");

/**
 * Sliding window rate limiter with IP-based tracking
 */
class RateLimiter {
  /**
   * Create a new rate limiter
   * @param {object} options - Configuration options
   * @param {number} options.windowMs - Time window in milliseconds (default: 1000)
   * @param {number} options.maxRequests - Maximum requests per window (default: 20)
   * @param {number} options.cleanupInterval - Interval to cleanup old entries in ms (default: 60000)
   */
  constructor(options = {}) {
    this.windowMs = options.windowMs || 1000;
    this.maxRequests = options.maxRequests || 20;
    this.cleanupInterval = options.cleanupInterval || 60000;

    // Map of IP -> { windowStart, count, timestamps[] }
    this.clients = new Map();

    // Start periodic cleanup
    this.cleanupTimer = setInterval(() => this.cleanup(), this.cleanupInterval);

    // Statistics
    this.stats = {
      allowed: 0,
      denied: 0,
      uniqueIPs: 0,
    };
  }

  /**
   * Check if a request from the given IP is allowed
   * @param {string} ip - Client IP address
   * @returns {boolean} True if request is allowed
   */
  isAllowed(ip) {
    const now = Date.now();
    let record = this.clients.get(ip);

    // New client or window expired
    if (!record || now - record.windowStart > this.windowMs) {
      record = {
        windowStart: now,
        count: 0,
        firstSeen: record?.firstSeen || now,
        lastSeen: now,
      };
      this.clients.set(ip, record);
    }

    record.count++;
    record.lastSeen = now;

    if (record.count <= this.maxRequests) {
      this.stats.allowed++;
      return true;
    }

    this.stats.denied++;
    return false;
  }

  /**
   * Get remaining requests for an IP in the current window
   * @param {string} ip - Client IP address
   * @returns {number} Remaining requests
   */
  getRemaining(ip) {
    const record = this.clients.get(ip);
    if (!record) return this.maxRequests;

    const now = Date.now();
    if (now - record.windowStart > this.windowMs) {
      return this.maxRequests;
    }

    return Math.max(0, this.maxRequests - record.count);
  }

  /**
   * Get time until rate limit resets for an IP
   * @param {string} ip - Client IP address
   * @returns {number} Milliseconds until reset
   */
  getResetTime(ip) {
    const record = this.clients.get(ip);
    if (!record) return 0;

    const now = Date.now();
    const elapsed = now - record.windowStart;

    if (elapsed > this.windowMs) return 0;
    return this.windowMs - elapsed;
  }

  /**
   * Clean up expired entries to prevent memory leaks
   */
  cleanup() {
    const now = Date.now();
    const expireThreshold = this.windowMs * 2;
    let cleaned = 0;

    for (const [ip, record] of this.clients.entries()) {
      if (now - record.lastSeen > expireThreshold) {
        this.clients.delete(ip);
        cleaned++;
      }
    }

    this.stats.uniqueIPs = this.clients.size;

    if (cleaned > 0) {
      logger.debug({ cleaned, remaining: this.clients.size }, "Rate limiter cleanup");
    }
  }

  /**
   * Get rate limiter statistics
   * @returns {object} Statistics object
   */
  getStats() {
    return {
      ...this.stats,
      uniqueIPs: this.clients.size,
      windowMs: this.windowMs,
      maxRequests: this.maxRequests,
    };
  }

  /**
   * Reset statistics (for testing)
   */
  resetStats() {
    this.stats = {
      allowed: 0,
      denied: 0,
      uniqueIPs: this.clients.size,
    };
  }

  /**
   * Close the rate limiter and stop cleanup timer
   */
  close() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.clients.clear();
  }
}

/**
 * Connection rate limiter - limits new connections per IP
 * More restrictive than message rate limiting
 */
class ConnectionRateLimiter extends RateLimiter {
  /**
   * Create a connection rate limiter
   * @param {object} options - Configuration options
   * @param {number} options.windowMs - Time window in milliseconds (default: 60000 = 1 minute)
   * @param {number} options.maxConnections - Maximum connections per window (default: 10)
   */
  constructor(options = {}) {
    super({
      windowMs: options.windowMs || 60000,
      maxRequests: options.maxConnections || 10,
      cleanupInterval: options.cleanupInterval || 120000,
    });
  }

  /**
   * Check if a new connection from the given IP is allowed
   * @param {string} ip - Client IP address
   * @returns {boolean} True if connection is allowed
   */
  isConnectionAllowed(ip) {
    return this.isAllowed(ip);
  }
}

/**
 * Extract client IP from WebSocket request
 * Handles proxy headers (X-Forwarded-For, X-Real-IP)
 * @param {object} req - HTTP request object
 * @returns {string} Client IP address
 */
function getClientIP(req) {
  // Check for proxy headers first (Fly.io, Cloudflare, nginx, etc.)
  const forwardedFor = req.headers["x-forwarded-for"];
  if (forwardedFor) {
    // X-Forwarded-For can contain multiple IPs: client, proxy1, proxy2, ...
    // The first one is the original client
    const ips = forwardedFor.split(",").map(ip => ip.trim());
    if (ips[0]) return ips[0];
  }

  // Check X-Real-IP (nginx)
  const realIP = req.headers["x-real-ip"];
  if (realIP) return realIP;

  // Check Fly.io specific header
  const flyClientIP = req.headers["fly-client-ip"];
  if (flyClientIP) return flyClientIP;

  // Fall back to socket remote address
  return req.socket?.remoteAddress || req.connection?.remoteAddress || "unknown";
}

module.exports = {
  RateLimiter,
  ConnectionRateLimiter,
  getClientIP,
};
