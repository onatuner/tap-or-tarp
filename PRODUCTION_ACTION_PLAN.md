# Production Readiness Action Plan

**Project**: Tap-or-Tarp (Rogue Magic)
**Date**: January 22, 2026
**Goal**: Make the application production-ready for many concurrent users creating multiple games and taking actions simultaneously.

---

## Executive Summary

The application has solid foundational practices (security, monitoring, logging) but has **critical concurrency issues** that will cause data corruption and race conditions under load. This plan outlines a phased approach to address these issues.

**Estimated Total Effort**: 3-4 weeks
**Priority**: Critical issues must be resolved before production deployment

---

## Phase 1: Critical Fixes (Week 1)

### 1.1 Implement Per-Game Locking

**Priority**: CRITICAL
**Effort**: 2-3 days
**Files**: `server.js`, new `lib/lock.js`

**Problem**: Multiple WebSocket handlers can modify the same game simultaneously, causing race conditions.

**Solution**: Implement async mutex locks per game session.

**Implementation Steps**:

1. Install async-lock package:

   ```bash
   npm install async-lock
   ```

2. Create `lib/lock.js`:

   ```javascript
   const AsyncLock = require("async-lock");

   const gameLocks = new Map();
   const lock = new AsyncLock({ timeout: 5000 });

   async function withGameLock(gameId, operation) {
     return lock.acquire(gameId, operation);
   }

   function cleanupLock(gameId) {
     // Lock cleanup handled by async-lock internally
   }

   module.exports = { withGameLock, cleanupLock };
   ```

3. Wrap all game-modifying operations in `server.js`:
   ```javascript
   case "switch": {
     await withGameLock(ws.gameId, async () => {
       const session = gameSessions.get(ws.gameId);
       if (session) {
         // ... existing logic
       }
     });
     break;
   }
   ```

**Affected Message Types**:

- `start`, `pause`, `reset`
- `switch`, `updatePlayer`
- `addPenalty`, `eliminate`
- `updateSettings`
- `claim`, `unclaim`, `reconnect`

**Testing**:

- [ ] Create concurrent operation tests
- [ ] Load test with multiple clients modifying same game
- [ ] Verify no state corruption under stress

---

### 1.2 Replace Redis KEYS with SCAN

**Priority**: CRITICAL
**Effort**: 0.5 days
**File**: `lib/redis-storage.js`

**Problem**: `KEYS` command blocks Redis server, causing outages at scale.

**Solution**: Use `SCAN` for iterative key retrieval.

**Implementation**:

```javascript
async loadAll() {
  if (!this.redis) return [];

  try {
    const sessions = [];
    let cursor = '0';

    do {
      const [newCursor, keys] = await this.redis.scan(
        cursor,
        'MATCH', KEYS.SESSION + '*',
        'COUNT', 100
      );
      cursor = newCursor;

      for (const key of keys) {
        const id = key.replace(KEYS.SESSION, '');
        const data = await this.redis.get(key);
        if (data) {
          const parsed = JSON.parse(data);
          sessions.push({ id, state: parsed.state });
        }
      }
    } while (cursor !== '0');

    return sessions;
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to load sessions from Redis');
    return [];
  }
}

async count() {
  if (!this.redis) return 0;

  try {
    let count = 0;
    let cursor = '0';

    do {
      const [newCursor, keys] = await this.redis.scan(
        cursor,
        'MATCH', KEYS.SESSION + '*',
        'COUNT', 100
      );
      cursor = newCursor;
      count += keys.length;
    } while (cursor !== '0');

    return count;
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to count sessions');
    return 0;
  }
}
```

**Testing**:

- [ ] Test with 1000+ keys in Redis
- [ ] Verify no Redis blocking during operation
- [ ] Benchmark performance comparison

---

### 1.3 Fix Game ID Generation Race Condition

**Priority**: CRITICAL
**Effort**: 1 day
**Files**: `lib/game-logic.js`, `server.js`

**Problem**: Two concurrent "create" requests can generate the same game ID.

**Solution A** (SQLite): Use database uniqueness constraint + retry logic

**Solution B** (Redis): Use atomic `SETNX` for ID reservation

**Implementation (Solution B - Recommended for Redis mode)**:

Add to `lib/redis-storage.js`:

```javascript
async reserveGameId(gameId, ttl = 86400) {
  const key = `${KEYS.SESSION}${gameId}:reserved`;
  const result = await this.redis.set(key, '1', 'EX', ttl, 'NX');
  return result === 'OK';
}
```

Update `server.js` create handler:

```javascript
case "create": {
  let gameId;
  let attempts = 0;
  const maxAttempts = 10;

  while (attempts < maxAttempts) {
    gameId = generateGameId();

    if (isAsyncStorageMode && storage.reserveGameId) {
      const reserved = await storage.reserveGameId(gameId);
      if (reserved && !gameSessions.has(gameId)) break;
    } else {
      if (!gameSessions.has(gameId)) break;
    }
    attempts++;
  }

  if (attempts >= maxAttempts) {
    ws.send(JSON.stringify({ type: "error", data: { message: "Failed to create game" } }));
    break;
  }

  // ... rest of create logic
}
```

**Testing**:

- [ ] Concurrent create stress test (100+ simultaneous creates)
- [ ] Verify no duplicate game IDs created
- [ ] Test fallback behavior when max attempts reached

---

### 1.4 Add SQLite Transaction Batching

**Priority**: HIGH
**Effort**: 0.5 days
**File**: `lib/storage.js`

**Problem**: Individual saves without transactions can corrupt database on crash.

**Solution**: Batch saves within a transaction.

**Implementation**:

```javascript
saveBatch(sessions) {
  if (!this.db) return;

  const transaction = this.db.transaction((sessionsArray) => {
    const now = Date.now();
    for (const { id, state } of sessionsArray) {
      const stateJson = JSON.stringify(state);
      this.statements.save.run(id, stateJson, id, now, now);
    }
  });

  transaction(sessions);
}
```

Update `server.js` `persistSessions()`:

```javascript
async function persistSessions() {
  if (!storage || isShuttingDown) return;

  const endTimer = metrics.startStorageSaveTimer();

  try {
    if (isAsyncStorageMode) {
      // Redis: save individually (already atomic per-key)
      for (const [gameId, session] of gameSessions.entries()) {
        await storage.save(gameId, session.toJSON());
      }
    } else if (storage.saveBatch) {
      // SQLite: batch save in transaction
      const sessions = Array.from(gameSessions.entries()).map(([id, session]) => ({
        id,
        state: session.toJSON(),
      }));
      storage.saveBatch(sessions);
    }
    // ... metrics
  } catch (error) {
    logger.error({ error: error.message }, "Persistence failed");
  }

  endTimer();
}
```

---

## Phase 2: High-Priority Improvements (Week 2)

### 2.1 WebSocket Backpressure Handling

**Priority**: HIGH
**Effort**: 1 day
**File**: `server.js`

**Problem**: Slow clients can cause unbounded memory growth.

**Implementation**:

```javascript
const MAX_BUFFER_SIZE = 1024 * 1024; // 1MB

function safeSend(client, message) {
  if (client.readyState !== WebSocket.OPEN) return false;

  if (client.bufferedAmount > MAX_BUFFER_SIZE) {
    logger.warn(
      {
        clientId: client.clientId,
        buffered: client.bufferedAmount,
      },
      "Client buffer overflow, closing connection"
    );
    client.close(1008, "Buffer overflow");
    return false;
  }

  client.send(message);
  return true;
}

function broadcastToLocalClients(gameId, type, data) {
  const message = JSON.stringify({ type, data });
  wss.clients.forEach(client => {
    if (client.gameId === gameId) {
      safeSend(client, message);
    }
  });
}
```

**Metrics to Add**:

```javascript
const bufferOverflows = new client.Counter({
  name: "tapotarp_websocket_buffer_overflows_total",
  help: "Total WebSocket buffer overflow disconnections",
  registers: [register],
});
```

---

### 2.2 IP-Based Rate Limiting

**Priority**: HIGH
**Effort**: 1-2 days
**Files**: `server.js`, new `lib/rate-limiter.js`

**Problem**: Rate limiting is per-connection; users can bypass by opening multiple connections.

**Implementation**:

```javascript
// lib/rate-limiter.js
class RateLimiter {
  constructor(options = {}) {
    this.windowMs = options.windowMs || 1000;
    this.maxRequests = options.maxRequests || 20;
    this.clients = new Map();
  }

  isAllowed(identifier) {
    const now = Date.now();
    let record = this.clients.get(identifier);

    if (!record || now - record.windowStart > this.windowMs) {
      record = { windowStart: now, count: 0 };
      this.clients.set(identifier, record);
    }

    record.count++;
    return record.count <= this.maxRequests;
  }

  cleanup() {
    const now = Date.now();
    for (const [id, record] of this.clients.entries()) {
      if (now - record.windowStart > this.windowMs * 2) {
        this.clients.delete(id);
      }
    }
  }
}

module.exports = { RateLimiter };
```

**For Redis-based distributed rate limiting**:

```javascript
async isAllowedRedis(redis, identifier, windowMs, maxRequests) {
  const key = `ratelimit:${identifier}`;
  const count = await redis.incr(key);

  if (count === 1) {
    await redis.pexpire(key, windowMs);
  }

  return count <= maxRequests;
}
```

---

### 2.3 Reduce Persistence Gap

**Priority**: MEDIUM
**Effort**: 0.5 days
**File**: `server.js`

**Problem**: 10-second persistence interval means potential data loss.

**Solution**: Implement immediate persistence for critical operations + reduce interval.

```javascript
const PERSISTENCE_INTERVAL = 5000; // Reduce to 5 seconds

// Add immediate persistence for critical changes
async function persistGameImmediately(gameId) {
  if (!storage || isShuttingDown) return;

  const session = gameSessions.get(gameId);
  if (!session) return;

  try {
    if (isAsyncStorageMode) {
      await storage.save(gameId, session.toJSON());
    } else {
      storage.save(gameId, session.toJSON());
    }
  } catch (error) {
    logger.error({ gameId, error: error.message }, 'Immediate persistence failed');
  }
}

// Call after critical operations
case "create": {
  // ... create logic
  await persistGameImmediately(gameId);
  break;
}
```

---

## Phase 3: Scalability Enhancements (Week 3)

### 3.1 Redis-Based Game State (Optional but Recommended)

**Priority**: MEDIUM
**Effort**: 3-4 days

**Current**: Game state in memory, periodically persisted
**Target**: Game state in Redis with local cache

**Benefits**:

- True horizontal scaling
- No data loss on instance crash
- Consistent state across instances

**Architecture Change**:

```
Before: Memory (primary) → Redis (backup)
After:  Redis (primary) → Memory (cache)
```

**Key Implementation Points**:

1. Store game state in Redis hash
2. Use Redis WATCH/MULTI/EXEC for atomic updates
3. Implement local cache with TTL for read performance
4. Use Redis pub/sub for cache invalidation

---

### 3.2 Node.js Clustering

**Priority**: MEDIUM
**Effort**: 1-2 days
**File**: New `cluster.js`

**Implementation**:

```javascript
// cluster.js
const cluster = require("cluster");
const numCPUs = require("os").cpus().length;

if (cluster.isPrimary) {
  console.log(`Primary ${process.pid} is running`);

  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on("exit", (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} died, restarting...`);
    cluster.fork();
  });
} else {
  require("./server.js");
}
```

**Note**: Requires Redis for shared state when using clustering.

---

### 3.3 Connection Draining for Graceful Shutdown

**Priority**: LOW
**Effort**: 0.5 days

**Enhancement to existing shutdown**:

```javascript
async function gracefulShutdown(signal, exitCode = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ signal }, "Starting graceful shutdown");

  // Stop accepting new connections
  server.close();

  // Give existing requests time to complete
  const drainTimeout = 30000;
  const drainStart = Date.now();

  while (wss.clients.size > 0 && Date.now() - drainStart < drainTimeout) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    logger.info({ remaining: wss.clients.size }, "Draining connections");
  }

  // ... rest of shutdown
}
```

---

## Phase 4: Testing & Validation (Week 4)

### 4.1 Concurrency Test Suite

**File**: `__tests__/concurrency.test.js`

```javascript
describe("Concurrency", () => {
  test("simultaneous game creation produces unique IDs", async () => {
    const createPromises = Array(100)
      .fill()
      .map(() => createGame());
    const results = await Promise.all(createPromises);
    const ids = results.map(r => r.gameId);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(100);
  });

  test("simultaneous actions on same game maintain consistency", async () => {
    const gameId = await createGame();
    const actionPromises = Array(50)
      .fill()
      .map((_, i) => switchPlayer(gameId, (i % 4) + 1));
    await Promise.all(actionPromises);
    const state = await getGameState(gameId);
    expect(state.activePlayer).toBeGreaterThanOrEqual(1);
    expect(state.activePlayer).toBeLessThanOrEqual(4);
  });
});
```

### 4.2 Load Testing

**Tool**: k6 or Artillery

```javascript
// k6-load-test.js
import ws from "k6/ws";
import { check } from "k6";

export const options = {
  stages: [
    { duration: "1m", target: 100 }, // Ramp up
    { duration: "3m", target: 100 }, // Sustain
    { duration: "1m", target: 0 }, // Ramp down
  ],
};

export default function () {
  const url = "ws://localhost:3000";

  const res = ws.connect(url, {}, function (socket) {
    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          type: "create",
          data: { settings: { playerCount: 2 } },
        })
      );
    });

    socket.on("message", msg => {
      const data = JSON.parse(msg);
      if (data.type === "state") {
        // Perform actions
        socket.send(
          JSON.stringify({
            type: "start",
            data: {},
          })
        );
      }
    });

    socket.setTimeout(() => socket.close(), 30000);
  });

  check(res, { Connected: r => r && r.status === 101 });
}
```

### 4.3 Chaos Testing

- [ ] Kill instances during active games
- [ ] Simulate Redis connection failures
- [ ] Network partition testing
- [ ] Memory pressure testing

---

## Deployment Checklist

### Pre-Deployment

- [ ] All Phase 1 critical fixes implemented
- [ ] Concurrency tests passing
- [ ] Load tests completed successfully
- [ ] Redis configured and tested
- [ ] Monitoring dashboards set up
- [ ] Alerting rules configured

### Deployment Steps

1. [ ] Deploy to staging environment
2. [ ] Run full test suite against staging
3. [ ] Perform load test against staging
4. [ ] Monitor for 24 hours
5. [ ] Deploy to production with 1 instance
6. [ ] Gradually scale to target instance count
7. [ ] Monitor metrics closely for first 48 hours

### Post-Deployment Monitoring

- [ ] Error rate < 0.1%
- [ ] P99 latency < 100ms
- [ ] No memory leaks (stable RSS over 24h)
- [ ] No Redis blocking operations
- [ ] Rate limit metrics normal

---

## Success Metrics

| Metric              | Target  | Current   |
| ------------------- | ------- | --------- |
| Concurrent games    | 1000+   | Unknown   |
| Actions per second  | 500+    | Unknown   |
| Error rate          | < 0.1%  | Unknown   |
| P99 latency         | < 100ms | Unknown   |
| Data loss on crash  | 0       | Up to 10s |
| Race condition bugs | 0       | Multiple  |

---

## Resource Requirements

### Development

- 1 senior developer: 3-4 weeks
- Code review time: ~1 week total

### Infrastructure

- Redis instance (Upstash or managed Redis)
- Fly.io scaling to 2-4 instances minimum
- Monitoring (existing Prometheus + Grafana)

### Estimated Costs

- Redis: ~$10-50/month (depending on usage)
- Additional Fly.io instances: ~$5-20/month per instance
- Total additional: ~$30-100/month

---

## Document History

| Version | Date       | Author | Changes             |
| ------- | ---------- | ------ | ------------------- |
| 1.0     | 2026-01-22 | Claude | Initial action plan |
