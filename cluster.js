/**
 * Node.js Cluster Manager for Tap-or-Tarp
 *
 * Enables the server to utilize multiple CPU cores by spawning worker processes.
 * Each worker runs a full server instance and handles its own connections.
 *
 * IMPORTANT: Clustering requires Redis for shared state. Without Redis, each
 * worker would have its own isolated game state, causing inconsistencies.
 *
 * Usage:
 *   node cluster.js              # Auto-detect CPU cores
 *   WORKERS=4 node cluster.js    # Specify number of workers
 *
 * Environment Variables:
 *   WORKERS         - Number of worker processes (default: CPU count)
 *   REDIS_URL       - Required for shared state
 *   REDIS_PRIMARY   - Set to 'true' for Redis-primary mode (recommended)
 */

const cluster = require("cluster");
const os = require("os");
const path = require("path");

// Configuration
const WORKER_COUNT = parseInt(process.env.WORKERS, 10) || os.cpus().length;
const RESTART_DELAY = 1000; // ms to wait before restarting a crashed worker
const MAX_RESTARTS_PER_MINUTE = 10;

// Track worker restarts for crash loop detection
const restartHistory = [];

/**
 * Check if we're in a crash loop (too many restarts in a short time)
 */
function isInCrashLoop() {
  const oneMinuteAgo = Date.now() - 60000;
  const recentRestarts = restartHistory.filter(ts => ts > oneMinuteAgo);
  return recentRestarts.length >= MAX_RESTARTS_PER_MINUTE;
}

/**
 * Log with timestamp and role prefix
 */
function log(message, data = {}) {
  const timestamp = new Date().toISOString();
  const role = cluster.isPrimary ? "PRIMARY" : `WORKER-${process.pid}`;
  console.log(
    JSON.stringify({
      timestamp,
      role,
      message,
      ...data,
    })
  );
}

/**
 * Primary process: Manages worker processes
 */
function runPrimary() {
  log("Starting cluster manager", {
    workers: WORKER_COUNT,
    cpus: os.cpus().length,
    platform: os.platform(),
    nodeVersion: process.version,
  });

  // Validate Redis configuration for clustering
  if (!process.env.REDIS_URL) {
    console.warn("\n⚠️  WARNING: REDIS_URL not set. Clustering without Redis will cause");
    console.warn("   each worker to have isolated game state. This is likely NOT what you want.");
    console.warn("   Set REDIS_URL and REDIS_PRIMARY=true for proper cluster support.\n");
  }

  // Fork workers
  for (let i = 0; i < WORKER_COUNT; i++) {
    forkWorker();
  }

  // Handle worker exit
  cluster.on("exit", (worker, code, signal) => {
    const exitInfo = {
      workerId: worker.id,
      pid: worker.process.pid,
      code,
      signal,
    };

    if (signal) {
      log("Worker killed by signal", exitInfo);
    } else if (code !== 0) {
      log("Worker crashed", exitInfo);
    } else {
      log("Worker exited cleanly", exitInfo);
    }

    // Don't restart if we're shutting down
    if (isShuttingDown) {
      return;
    }

    // Check for crash loop
    if (isInCrashLoop()) {
      log("Crash loop detected, not restarting worker", {
        restarts: restartHistory.length,
      });

      // If all workers have crashed, exit the primary
      if (Object.keys(cluster.workers).length === 0) {
        log("All workers crashed, exiting primary");
        process.exit(1);
      }
      return;
    }

    // Restart the worker after a delay
    restartHistory.push(Date.now());
    setTimeout(() => {
      log("Restarting worker", { previousPid: worker.process.pid });
      forkWorker();
    }, RESTART_DELAY);
  });

  // Handle worker online
  cluster.on("online", worker => {
    log("Worker online", { workerId: worker.id, pid: worker.process.pid });
  });

  // Handle messages from workers
  cluster.on("message", (worker, message) => {
    if (message.type === "status") {
      log("Worker status", {
        workerId: worker.id,
        ...message.data,
      });
    }
  });

  // Graceful shutdown handling
  let isShuttingDown = false;

  async function shutdownPrimary(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    log("Received shutdown signal, stopping workers", { signal });

    // Send shutdown signal to all workers
    for (const id in cluster.workers) {
      const worker = cluster.workers[id];
      if (worker) {
        worker.send({ type: "shutdown" });
        worker.disconnect();
      }
    }

    // Wait for workers to exit (with timeout)
    const timeout = 30000;
    const start = Date.now();

    const checkWorkers = setInterval(() => {
      const activeWorkers = Object.keys(cluster.workers).length;

      if (activeWorkers === 0) {
        clearInterval(checkWorkers);
        log("All workers stopped, primary exiting");
        process.exit(0);
      }

      if (Date.now() - start > timeout) {
        clearInterval(checkWorkers);
        log("Timeout waiting for workers, forcing exit", { activeWorkers });
        process.exit(1);
      }
    }, 1000);
  }

  process.on("SIGTERM", () => shutdownPrimary("SIGTERM"));
  process.on("SIGINT", () => shutdownPrimary("SIGINT"));

  // Periodic status logging
  setInterval(() => {
    const workers = Object.values(cluster.workers)
      .filter(w => w)
      .map(w => ({
        id: w.id,
        pid: w.process.pid,
        connected: w.isConnected(),
      }));

    log("Cluster status", {
      workers: workers.length,
      workerDetails: workers,
    });
  }, 60000);
}

/**
 * Fork a new worker process
 */
function forkWorker() {
  const worker = cluster.fork({
    ...process.env,
    CLUSTER_WORKER: "true",
    CLUSTER_WORKER_ID: String(Object.keys(cluster.workers).length + 1),
  });

  // Handle shutdown messages from primary
  worker.on("message", message => {
    if (message.type === "shutdown") {
      log("Received shutdown from primary", { workerId: worker.id });
    }
  });

  return worker;
}

/**
 * Worker process: Runs the actual server
 */
function runWorker() {
  log("Worker starting");

  // Handle shutdown message from primary
  process.on("message", message => {
    if (message.type === "shutdown") {
      log("Received shutdown signal from primary");
      // The server.js graceful shutdown will handle this via SIGTERM
      process.kill(process.pid, "SIGTERM");
    }
  });

  // Send periodic status to primary
  setInterval(() => {
    if (process.send) {
      process.send({
        type: "status",
        data: {
          memoryUsage: process.memoryUsage(),
          uptime: process.uptime(),
        },
      });
    }
  }, 30000);

  // Load the actual server
  require("./server.js");
}

// Entry point
if (cluster.isPrimary) {
  runPrimary();
} else {
  runWorker();
}
