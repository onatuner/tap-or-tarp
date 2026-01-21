/**
 * Structured logging configuration using Pino
 * Provides JSON logging in production and pretty output in development
 */

const pino = require("pino");

// Determine log level from environment
const LOG_LEVEL =
  process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug");

// Base logger configuration
const loggerConfig = {
  level: LOG_LEVEL,
  base: {
    env: process.env.NODE_ENV || "development",
    pid: process.pid,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: label => ({ level: label }),
  },
};

// Use pino-pretty in development for readable output
const transport =
  process.env.NODE_ENV !== "production"
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
        },
      }
    : undefined;

// Create the main logger
const logger = pino({
  ...loggerConfig,
  transport,
});

/**
 * Create a child logger with game context
 * @param {string} gameId - Game session ID
 * @param {string} clientId - Client ID
 * @returns {pino.Logger}
 */
function createGameLogger(gameId, clientId = null) {
  const context = { gameId };
  if (clientId) {
    context.clientId = clientId;
  }
  return logger.child(context);
}

/**
 * Create a child logger with request context
 * @param {string} requestId - Request ID
 * @param {string} method - HTTP method
 * @param {string} path - Request path
 * @returns {pino.Logger}
 */
function createRequestLogger(requestId, method, path) {
  return logger.child({ requestId, method, path });
}

/**
 * Log levels reference:
 * - fatal: Application crash imminent
 * - error: Error that needs attention
 * - warn: Warning, potential issue
 * - info: General information (default production level)
 * - debug: Debugging information
 * - trace: Very detailed tracing
 */

module.exports = {
  logger,
  createGameLogger,
  createRequestLogger,
  LOG_LEVEL,
};
