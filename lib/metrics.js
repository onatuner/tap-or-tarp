/**
 * Prometheus metrics collection for monitoring
 * Exposes application metrics for scraping by Prometheus
 */

const client = require("prom-client");

// Create a Registry
const register = new client.Registry();

// Add default metrics (CPU, memory, event loop, etc.)
client.collectDefaultMetrics({
  register,
  prefix: "taportar_",
});

// ============================================================================
// CUSTOM METRICS
// ============================================================================

/**
 * WebSocket connection metrics
 */
const websocketConnections = new client.Gauge({
  name: "tapotarp_websocket_connections_total",
  help: "Total number of active WebSocket connections",
  registers: [register],
});

const websocketConnectionsTotal = new client.Counter({
  name: "tapotarp_websocket_connections_created_total",
  help: "Total number of WebSocket connections created",
  registers: [register],
});

/**
 * Game session metrics
 */
const activeSessions = new client.Gauge({
  name: "tapotarp_game_sessions_active",
  help: "Number of active game sessions",
  registers: [register],
});

const sessionsCreated = new client.Counter({
  name: "tapotarp_game_sessions_created_total",
  help: "Total number of game sessions created",
  registers: [register],
});

const sessionsRestored = new client.Counter({
  name: "tapotarp_game_sessions_restored_total",
  help: "Total number of game sessions restored from storage",
  registers: [register],
});

/**
 * WebSocket message metrics
 */
const messagesReceived = new client.Counter({
  name: "tapotarp_websocket_messages_received_total",
  help: "Total WebSocket messages received",
  labelNames: ["type"],
  registers: [register],
});

const messagesSent = new client.Counter({
  name: "tapotarp_websocket_messages_sent_total",
  help: "Total WebSocket messages sent",
  labelNames: ["type"],
  registers: [register],
});

/**
 * Error metrics
 */
const errorsTotal = new client.Counter({
  name: "tapotarp_errors_total",
  help: "Total errors by type",
  labelNames: ["type"],
  registers: [register],
});

/**
 * Authorization metrics
 */
const authorizationDenied = new client.Counter({
  name: "tapotarp_authorization_denied_total",
  help: "Total authorization denied events",
  labelNames: ["action"],
  registers: [register],
});

/**
 * Rate limiting metrics
 */
const rateLimitExceeded = new client.Counter({
  name: "tapotarp_rate_limit_exceeded_total",
  help: "Total rate limit exceeded events",
  registers: [register],
});

/**
 * Game tick metrics
 */
const tickDuration = new client.Histogram({
  name: "tapotarp_game_tick_duration_seconds",
  help: "Duration of game tick processing in seconds",
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
  registers: [register],
});

/**
 * Storage metrics
 */
const storageSavesDuration = new client.Histogram({
  name: "tapotarp_storage_save_duration_seconds",
  help: "Duration of storage save operations in seconds",
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.5, 1],
  registers: [register],
});

const storageOperations = new client.Counter({
  name: "tapotarp_storage_operations_total",
  help: "Total storage operations",
  labelNames: ["operation", "status"],
  registers: [register],
});

/**
 * HTTP request metrics
 */
const httpRequestDuration = new client.Histogram({
  name: "tapotarp_http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "path", "status"],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Update active session count
 * @param {number} count - Current number of active sessions
 */
function setActiveSessions(count) {
  activeSessions.set(count);
}

/**
 * Update WebSocket connection count
 * @param {number} count - Current number of connections
 */
function setWebsocketConnections(count) {
  websocketConnections.set(count);
}

/**
 * Record a new WebSocket connection
 */
function recordNewConnection() {
  websocketConnectionsTotal.inc();
}

/**
 * Record a new game session
 */
function recordNewSession() {
  sessionsCreated.inc();
}

/**
 * Record a restored game session
 */
function recordRestoredSession() {
  sessionsRestored.inc();
}

/**
 * Record a received message
 * @param {string} type - Message type
 */
function recordMessageReceived(type) {
  messagesReceived.inc({ type });
}

/**
 * Record a sent message
 * @param {string} type - Message type
 */
function recordMessageSent(type) {
  messagesSent.inc({ type });
}

/**
 * Record an error
 * @param {string} type - Error type
 */
function recordError(type) {
  errorsTotal.inc({ type });
}

/**
 * Record authorization denied
 * @param {string} action - Action that was denied
 */
function recordAuthDenied(action) {
  authorizationDenied.inc({ action });
}

/**
 * Record rate limit exceeded
 */
function recordRateLimitExceeded() {
  rateLimitExceeded.inc();
}

/**
 * Time a game tick operation
 * @returns {function} End timer function
 */
function startTickTimer() {
  return tickDuration.startTimer();
}

/**
 * Time a storage save operation
 * @returns {function} End timer function
 */
function startStorageSaveTimer() {
  return storageSavesDuration.startTimer();
}

/**
 * Record a storage operation
 * @param {string} operation - Operation type (save, load, delete)
 * @param {string} status - Status (success, error)
 */
function recordStorageOperation(operation, status) {
  storageOperations.inc({ operation, status });
}

/**
 * Time an HTTP request
 * @param {string} method - HTTP method
 * @param {string} path - Request path
 * @returns {function} End timer function that takes status code
 */
function startHttpTimer(method, path) {
  const end = httpRequestDuration.startTimer();
  return status => end({ method, path, status: String(status) });
}

module.exports = {
  register,
  // Gauges
  setActiveSessions,
  setWebsocketConnections,
  // Counters
  recordNewConnection,
  recordNewSession,
  recordRestoredSession,
  recordMessageReceived,
  recordMessageSent,
  recordError,
  recordAuthDenied,
  recordRateLimitExceeded,
  recordStorageOperation,
  // Timers
  startTickTimer,
  startStorageSaveTimer,
  startHttpTimer,
};
