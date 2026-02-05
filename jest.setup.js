/**
 * Jest Global Setup
 *
 * Configures the test environment for the game timer application.
 *
 * Note: The --forceExit flag is used in package.json to ensure Jest exits
 * after tests complete. This is necessary because several modules use
 * setInterval for game ticks, rate limiter cleanup, and cache management.
 * While each test file should clean up its own resources in afterEach/afterAll,
 * --forceExit provides a safety net.
 *
 * If you need to debug open handles, run: npm test -- --detectOpenHandles
 */

// Increase default timeout for integration tests that involve real timers
jest.setTimeout(10000);
