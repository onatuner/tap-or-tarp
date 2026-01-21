# Production Readiness Implementation Plan

## Executive Summary

| Phase       | Focus                   | Estimated Effort | Dependency |
| ----------- | ----------------------- | ---------------- | ---------- |
| **Phase 1** | Critical Infrastructure | 2-3 days         | None       |
| **Phase 2** | Observability           | 1-2 days         | Phase 1    |
| **Phase 3** | Security Hardening      | 1 day            | Phase 1    |
| **Phase 4** | Scalability             | 2-3 days         | Phase 1-2  |

**Current Production Readiness Score: 2.5/5**

---

## Critical Issues Identified

1. **No Data Persistence** - All game state in-memory, lost on restart
2. **No Global Error Handlers** - Uncaught exceptions crash the server
3. **Missing Authorization** - Any client can modify any game
4. **Minimal Observability** - Only console.log, no metrics/tracing
5. **Basic XSS Protection** - Only removes `<>` characters
6. **No Horizontal Scaling** - Single instance only

---

## Phase 1: Critical Infrastructure (Must Have)

### 1.1 Global Error Handlers & Graceful Shutdown

**File:** `server.js`
**Effort:** 2-3 hours

**Tasks:**

- [ ] Add `process.on('uncaughtException')` handler
- [ ] Add `process.on('unhandledRejection')` handler
- [ ] Add SIGTERM/SIGINT handlers for graceful shutdown
- [ ] Implement connection draining on shutdown
- [ ] Add cleanup for active game intervals

**Dependencies:** None

**Implementation Notes:**

- Add error handlers at top of `server.js`
- Track active connections for graceful drain
- Close WebSocket server gracefully before exit
- Set shutdown timeout (30s max)

**Example Code:**

```javascript
// Graceful shutdown
let isShuttingDown = false;

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

process.on("uncaughtException", error => {
  logger.fatal({ error }, "Uncaught exception");
  gracefulShutdown(1);
});

process.on("unhandledRejection", (reason, promise) => {
  logger.error({ reason }, "Unhandled rejection");
});

async function gracefulShutdown(exitCode = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info("Shutting down gracefully...");

  // Stop accepting new connections
  wss.close();

  // Save all sessions to storage
  for (const [id, session] of gameSessions) {
    await storage.save(id, session);
  }

  // Close existing connections
  wss.clients.forEach(client => {
    client.close(1001, "Server shutting down");
  });

  setTimeout(() => process.exit(exitCode), 5000);
}
```

---

### 1.2 Data Persistence with SQLite

**Files:** `server.js`, new `lib/storage.js`
**Effort:** 4-6 hours

**Tasks:**

- [ ] Add `better-sqlite3` dependency
- [ ] Create `lib/storage.js` with SessionStorage class
- [ ] Design schema: sessions table
- [ ] Implement save/load/delete operations
- [ ] Add periodic persistence (every 10s for active games)
- [ ] Load sessions on server startup
- [ ] Update Dockerfile for SQLite support
- [ ] Add data directory to `.gitignore`

**Dependencies:** `better-sqlite3` (synchronous, fast, serverless)

**Schema:**

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_sessions_updated_at ON sessions(updated_at);
```

**Storage Interface:**

```javascript
// lib/storage.js
const Database = require("better-sqlite3");

class SessionStorage {
  constructor(dbPath = "./data/sessions.db") {
    this.db = new Database(dbPath);
    this.initialize();
  }

  initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  save(id, session) {
    const state = JSON.stringify(session.toJSON());
    const now = Date.now();
    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO sessions (id, state, created_at, updated_at)
      VALUES (?, ?, COALESCE((SELECT created_at FROM sessions WHERE id = ?), ?), ?)
    `
      )
      .run(id, state, id, now, now);
  }

  load(id) {
    const row = this.db.prepare("SELECT state FROM sessions WHERE id = ?").get(id);
    return row ? JSON.parse(row.state) : null;
  }

  loadAll() {
    return this.db
      .prepare("SELECT id, state FROM sessions")
      .all()
      .map(row => ({ id: row.id, state: JSON.parse(row.state) }));
  }

  delete(id) {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  cleanup(maxAge) {
    const cutoff = Date.now() - maxAge;
    this.db.prepare("DELETE FROM sessions WHERE updated_at < ?").run(cutoff);
  }
}

module.exports = { SessionStorage };
```

**Why SQLite over Redis:**

- No additional infrastructure needed
- Works with Fly.io volumes
- Simpler for single-instance deployment
- Can migrate to Redis later for horizontal scaling

---

### 1.3 Authorization for Game Actions

**Files:** `server.js`, `lib/game-logic.js`
**Effort:** 3-4 hours

**Tasks:**

- [ ] Add `isGameOwner()` check (first client to create/join)
- [ ] Add `isPlayerOwner()` check (client that claimed player)
- [ ] Protect sensitive actions:
  - [ ] `pause/reset` → game owner or any claimed player
  - [ ] `updatePlayer` → player owner only
  - [ ] `eliminate` → game owner only
  - [ ] `updateSettings` → game owner only (before start)
  - [ ] `switch` → current active player owner only
- [ ] Add `ownerId` to GameSession for tracking game creator
- [ ] Return proper error messages for unauthorized actions
- [ ] Add tests for authorization logic

**Implementation Pattern:**

```javascript
// In GameSession class
constructor(id, settings, broadcastFn) {
  // ... existing code
  this.ownerId = null; // Set when first client joins
}

setOwner(clientId) {
  if (!this.ownerId) {
    this.ownerId = clientId;
  }
}

isOwner(clientId) {
  return this.ownerId === clientId;
}

isPlayerOwner(playerId, clientId) {
  const player = this.players.find(p => p.id === playerId);
  return player && player.claimedBy === clientId;
}

canModifyPlayer(playerId, clientId) {
  return this.isOwner(clientId) || this.isPlayerOwner(playerId, clientId);
}

// In server.js message handler
case "updatePlayer": {
  const session = gameSessions.get(ws.gameId);
  if (!session.canModifyPlayer(data.playerId, ws.clientId)) {
    ws.send(JSON.stringify({
      type: "error",
      data: { message: "Not authorized to modify this player" }
    }));
    break;
  }
  session.updatePlayer(data.playerId, data);
  break;
}

case "updateSettings": {
  const session = gameSessions.get(ws.gameId);
  if (!session.isOwner(ws.clientId)) {
    ws.send(JSON.stringify({
      type: "error",
      data: { message: "Only the game owner can change settings" }
    }));
    break;
  }
  // proceed with update
  break;
}
```

---

## Phase 2: Observability

### 2.1 Structured Logging with Pino

**Files:** `server.js`, new `lib/logger.js`
**Effort:** 2-3 hours

**Tasks:**

- [ ] Add `pino` + `pino-pretty` dependencies
- [ ] Create `lib/logger.js` with configured logger
- [ ] Replace all `console.log/error` with logger calls
- [ ] Add log levels: debug, info, warn, error
- [ ] Add contextual logging (gameId, clientId)
- [ ] Configure JSON output for production
- [ ] Add request logging for HTTP endpoints
- [ ] Update npm scripts for pretty logs in dev

**Logger Configuration:**

```javascript
// lib/logger.js
const pino = require("pino");

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
  base: {
    env: process.env.NODE_ENV || "development",
  },
});

// Create child loggers with context
function createGameLogger(gameId, clientId) {
  return logger.child({ gameId, clientId });
}

module.exports = { logger, createGameLogger };
```

**Log Format (Production):**

```json
{
  "level": 30,
  "time": 1234567890,
  "gameId": "ABC123",
  "clientId": "client_1",
  "msg": "Player claimed slot"
}
```

**npm script update:**

```json
{
  "scripts": {
    "dev": "LOG_LEVEL=debug node server.js | pino-pretty"
  }
}
```

---

### 2.2 Metrics Endpoint

**Files:** `server.js`, new `lib/metrics.js`
**Effort:** 2-3 hours

**Tasks:**

- [ ] Add `prom-client` dependency
- [ ] Create `lib/metrics.js` with metrics registry
- [ ] Add metrics:
  - [ ] `websocket_connections_total` (gauge)
  - [ ] `game_sessions_active` (gauge)
  - [ ] `game_sessions_created_total` (counter)
  - [ ] `websocket_messages_total` (counter by type)
  - [ ] `websocket_errors_total` (counter)
  - [ ] `game_tick_duration_seconds` (histogram)
- [ ] Add `GET /metrics` endpoint
- [ ] Instrument WebSocket handlers
- [ ] Add documentation for Prometheus scraping

**Metrics Implementation:**

```javascript
// lib/metrics.js
const client = require("prom-client");

// Create a Registry
const register = new client.Registry();

// Add default metrics (CPU, memory, etc.)
client.collectDefaultMetrics({ register });

// Custom metrics
const websocketConnections = new client.Gauge({
  name: "websocket_connections_total",
  help: "Total number of active WebSocket connections",
  registers: [register],
});

const activeSessions = new client.Gauge({
  name: "game_sessions_active",
  help: "Number of active game sessions",
  registers: [register],
});

const sessionsCreated = new client.Counter({
  name: "game_sessions_created_total",
  help: "Total number of game sessions created",
  registers: [register],
});

const messagesReceived = new client.Counter({
  name: "websocket_messages_total",
  help: "Total WebSocket messages received",
  labelNames: ["type"],
  registers: [register],
});

const errorsTotal = new client.Counter({
  name: "websocket_errors_total",
  help: "Total WebSocket errors",
  labelNames: ["type"],
  registers: [register],
});

const tickDuration = new client.Histogram({
  name: "game_tick_duration_seconds",
  help: "Duration of game tick processing",
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1],
  registers: [register],
});

module.exports = {
  register,
  websocketConnections,
  activeSessions,
  sessionsCreated,
  messagesReceived,
  errorsTotal,
  tickDuration,
};
```

**Metrics endpoint:**

```javascript
// In server.js
const { register } = require("./lib/metrics");

app.get("/metrics", async (req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});
```

---

### 2.3 Error Tracking with Sentry

**Files:** `server.js`
**Effort:** 1-2 hours

**Tasks:**

- [ ] Add `@sentry/node` dependency
- [ ] Initialize Sentry with DSN from env
- [ ] Configure environment and release tags
- [ ] Add Sentry to error handlers
- [ ] Add breadcrumbs for WebSocket events
- [ ] Add user context (clientId, gameId)
- [ ] Update `.env.example` with `SENTRY_DSN`

**Sentry Setup:**

```javascript
// At top of server.js
const Sentry = require("@sentry/node");

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: 0.1,
  });
}

// In error handlers
process.on("uncaughtException", error => {
  Sentry.captureException(error);
  logger.fatal({ error }, "Uncaught exception");
  gracefulShutdown(1);
});

// In WebSocket handler - add context
ws.on("message", message => {
  Sentry.setContext("websocket", {
    clientId: ws.clientId,
    gameId: ws.gameId,
  });
  // ... rest of handler
});
```

---

## Phase 3: Security Hardening

### 3.1 Improved XSS Sanitization

**File:** `lib/game-logic.js`
**Effort:** 1-2 hours

**Tasks:**

- [ ] Add `he` (html-entities) dependency
- [ ] Replace `sanitizeString` with proper HTML encoding
- [ ] Sanitize all user inputs: playerName, settings
- [ ] Add Content-Security-Policy header
- [ ] Add tests for XSS vectors

**Implementation:**

```javascript
// lib/game-logic.js
const he = require("he");

function sanitizeString(str) {
  if (typeof str !== "string") return str;
  return he.encode(str, { useNamedReferences: true });
}
```

**CSP Header:**

```javascript
// In server.js
app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss: ws:;"
  );
  next();
});
```

---

### 3.2 WebSocket Origin Validation

**File:** `server.js`
**Effort:** 1 hour

**Tasks:**

- [ ] Add `verifyClient` function to WebSocket server
- [ ] Validate origin header against allowed origins
- [ ] Configure `ALLOWED_ORIGINS` in environment
- [ ] Log rejected connections

**Implementation:**

```javascript
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
  : ["http://localhost:3000", "https://tap-or-tarp.fly.dev"];

const wss = new WebSocket.Server({
  server,
  verifyClient: ({ origin, req }, callback) => {
    // Allow requests with no origin (non-browser clients)
    if (!origin) {
      callback(true);
      return;
    }

    const isAllowed = ALLOWED_ORIGINS.some(
      allowed => origin === allowed || origin.endsWith(allowed.replace("https://", "."))
    );

    if (!isAllowed) {
      logger.warn({ origin }, "Rejected WebSocket connection from unauthorized origin");
      callback(false, 403, "Forbidden");
      return;
    }

    callback(true);
  },
});
```

---

### 3.3 Session Reconnection (Reclaim Slots)

**Files:** `server.js`, `lib/game-logic.js`, `public/client.js`
**Effort:** 3-4 hours

**Tasks:**

- [ ] Generate reconnection token on claim
- [ ] Store token in localStorage on client
- [ ] Add "reconnect" message type
- [ ] Implement token validation and slot reclaim
- [ ] Add token expiration (1 hour)
- [ ] Clear token on unclaim or game end

**Server Implementation:**

```javascript
// In lib/game-logic.js
const crypto = require('crypto');

generateReconnectToken() {
  return crypto.randomBytes(32).toString('hex');
}

claimPlayer(playerId, clientId) {
  // ... existing validation

  const token = this.generateReconnectToken();
  player.claimedBy = clientId;
  player.reconnectToken = token;
  player.tokenExpiry = Date.now() + (60 * 60 * 1000); // 1 hour

  return { success: true, token };
}

reconnectPlayer(playerId, token) {
  const player = this.players.find(p => p.id === playerId);
  if (!player) return { success: false, reason: 'Player not found' };
  if (player.reconnectToken !== token) return { success: false, reason: 'Invalid token' };
  if (Date.now() > player.tokenExpiry) return { success: false, reason: 'Token expired' };

  return { success: true, player };
}
```

**Client Implementation:**

```javascript
// In public/client.js
function saveReconnectToken(gameId, playerId, token) {
  const tokens = JSON.parse(localStorage.getItem("reconnectTokens") || "{}");
  tokens[`${gameId}-${playerId}`] = { token, timestamp: Date.now() };
  localStorage.setItem("reconnectTokens", JSON.stringify(tokens));
}

function getReconnectToken(gameId, playerId) {
  const tokens = JSON.parse(localStorage.getItem("reconnectTokens") || "{}");
  const data = tokens[`${gameId}-${playerId}`];
  if (data && Date.now() - data.timestamp < 3600000) {
    return data.token;
  }
  return null;
}
```

---

### 3.4 Message Size Limits

**File:** `server.js`
**Effort:** 30 minutes

**Tasks:**

- [ ] Add `maxPayload` option to WebSocket server (64KB)
- [ ] Handle message too large errors gracefully
- [ ] Document limit in client

**Implementation:**

```javascript
const wss = new WebSocket.Server({
  server,
  maxPayload: 64 * 1024, // 64KB max message size
});

wss.on("connection", ws => {
  ws.on("error", error => {
    if (error.message.includes("Max payload size exceeded")) {
      logger.warn({ clientId: ws.clientId }, "Message too large");
      ws.send(
        JSON.stringify({
          type: "error",
          data: { message: "Message too large" },
        })
      );
    }
  });
});
```

---

## Phase 4: Scalability (Future)

### 4.1 Redis for Shared State

**Files:** `server.js`, `lib/storage.js`
**Effort:** 4-6 hours

**Tasks:**

- [ ] Add `ioredis` dependency
- [ ] Create `RedisStorage` class implementing storage interface
- [ ] Migrate session storage to Redis
- [ ] Add Redis pub/sub for cross-instance broadcasts
- [ ] Configure connection pooling
- [ ] Add Redis health to `/health` endpoint
- [ ] Update `fly.toml` for Redis addon

**Redis Storage Interface:**

```javascript
// lib/redis-storage.js
const Redis = require("ioredis");

class RedisStorage {
  constructor(url) {
    this.redis = new Redis(url);
    this.pubClient = new Redis(url);
    this.subClient = new Redis(url);
  }

  async save(id, session) {
    await this.redis.set(
      `session:${id}`,
      JSON.stringify(session.toJSON()),
      "EX",
      86400 // 24 hour TTL
    );
  }

  async load(id) {
    const data = await this.redis.get(`session:${id}`);
    return data ? JSON.parse(data) : null;
  }

  async delete(id) {
    await this.redis.del(`session:${id}`);
  }

  // Pub/sub for cross-instance messaging
  publish(channel, message) {
    this.pubClient.publish(channel, JSON.stringify(message));
  }

  subscribe(channel, handler) {
    this.subClient.subscribe(channel);
    this.subClient.on("message", (ch, message) => {
      if (ch === channel) {
        handler(JSON.parse(message));
      }
    });
  }
}

module.exports = { RedisStorage };
```

---

### 4.2 Horizontal Scaling Support

**Files:** `server.js`, `fly.toml`
**Effort:** 3-4 hours

**Tasks:**

- [ ] Implement sticky sessions (Fly.io `fly-force-instance-id`)
- [ ] Add instance ID to client connection
- [ ] Implement cross-instance message routing via Redis pub/sub
- [ ] Update health check for instance identification
- [ ] Test with multiple instances

**Fly.io Configuration:**

```toml
# fly.toml
[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = true
  auto_start_machines = true
  min_machines_running = 1

  [http_service.concurrency]
    type = "connections"
    hard_limit = 1000
    soft_limit = 800

# Enable sticky sessions
[[stickiness]]
  cookie_name = "fly-instance"
  ttl = "1h"
```

---

## Implementation Order & Dependencies

```
Week 1:
├── Day 1-2: Phase 1.1 (Error handlers) + Phase 1.2 (SQLite)
├── Day 3: Phase 1.3 (Authorization)
└── Day 4-5: Phase 2.1 (Logging) + Phase 2.2 (Metrics)

Week 2:
├── Day 1: Phase 2.3 (Sentry) + Phase 3.1 (XSS)
├── Day 2: Phase 3.2 (Origin) + Phase 3.3 (Reconnection)
└── Day 3+: Phase 4 (if scaling needed)
```

---

## New Dependencies Summary

```json
{
  "dependencies": {
    "better-sqlite3": "^9.4.0",
    "pino": "^8.18.0",
    "prom-client": "^15.1.0",
    "@sentry/node": "^7.100.0",
    "he": "^1.2.0"
  },
  "devDependencies": {
    "pino-pretty": "^10.3.0"
  }
}
```

**For Phase 4 (optional):**

```json
{
  "dependencies": {
    "ioredis": "^5.3.0"
  }
}
```

---

## File Changes Summary

| File                | Changes                                                          |
| ------------------- | ---------------------------------------------------------------- |
| `server.js`         | Error handlers, auth checks, logging, metrics, origin validation |
| `lib/game-logic.js` | Authorization methods, improved sanitization, reconnect tokens   |
| `lib/storage.js`    | **New** - SQLite persistence layer                               |
| `lib/logger.js`     | **New** - Pino logger configuration                              |
| `lib/metrics.js`    | **New** - Prometheus metrics                                     |
| `public/client.js`  | Reconnection token handling                                      |
| `package.json`      | New dependencies                                                 |
| `Dockerfile`        | SQLite native module support                                     |
| `.env.example`      | New environment variables                                        |
| `fly.toml`          | Volume mount for SQLite                                          |

---

## Environment Variables

Add to `.env.example`:

```bash
# Logging
LOG_LEVEL=info

# Error tracking (optional)
SENTRY_DSN=

# Security
ALLOWED_ORIGINS=http://localhost:3000,https://your-domain.com

# Storage (Phase 4)
REDIS_URL=
```

---

## Testing Checklist

After each phase, verify:

### Phase 1

- [ ] Server survives uncaught exceptions (logs error, continues running)
- [ ] Server shuts down gracefully on SIGTERM
- [ ] Game sessions persist across server restarts
- [ ] Unauthorized actions are rejected with clear error messages

### Phase 2

- [ ] Logs are structured JSON in production
- [ ] `/metrics` endpoint returns Prometheus format
- [ ] Errors appear in Sentry dashboard

### Phase 3

- [ ] XSS payloads are encoded in player names
- [ ] WebSocket connections from unauthorized origins are rejected
- [ ] Players can reconnect and reclaim their slots

### Phase 4

- [ ] Multiple server instances share session state
- [ ] Clients maintain connection during rolling deploys
- [ ] Game broadcasts reach all clients across instances

---

## Post-Implementation Production Readiness Score

| Category         | Before    | After Phase 1-3 | After Phase 4 |
| ---------------- | --------- | --------------- | ------------- |
| Data Persistence | 0/5       | 4/5             | 5/5           |
| Error Handling   | 3/5       | 5/5             | 5/5           |
| Authorization    | 2/5       | 4/5             | 4/5           |
| Logging          | 1/5       | 4/5             | 4/5           |
| Monitoring       | 0/5       | 4/5             | 4/5           |
| Security         | 2/5       | 4/5             | 4/5           |
| Scalability      | 1/5       | 2/5             | 4/5           |
| **Overall**      | **2.5/5** | **4/5**         | **4.5/5**     |
