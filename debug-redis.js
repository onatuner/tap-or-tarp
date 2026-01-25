/**
 * Diagnostic script to check Redis game state
 * Run with: node debug-redis.js
 */

require("dotenv").config();
const Redis = require("ioredis");
const { logger } = require("./lib/logger");
const { KEYS, DEFAULT_TTL } = require("./lib/redis-storage");

const redis = new Redis(process.env.REDIS_URL);

async function diagnose() {
  console.log("=== Redis Game State Diagnostics ===\n");

  try {
    // Check connection
    console.log("1. Testing Redis connection...");
    await redis.ping();
    console.log("   ✓ Connected to Redis\n");

    // Count session keys
    console.log("2. Counting session keys...");
    let sessionCount = 0;
    let cursor = "0";
    const pattern = KEYS.SESSION + "*";

    const sessions = [];
    do {
      const [newCursor, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
      cursor = newCursor;
      const sessionKeys = keys.filter(k => !k.endsWith(":reserved"));
      sessionCount += sessionKeys.length;

      for (const key of sessionKeys) {
        const id = key.replace(KEYS.SESSION, "");
        const data = await redis.get(key);
        if (data) {
          const parsed = JSON.parse(data);
          sessions.push({ id, ...parsed });
        }
      }
    } while (cursor !== "0");

    console.log(`   Found ${sessionCount} session(s)\n`);

    // Display session details
    if (sessions.length > 0) {
      console.log("3. Session details:");
      for (const session of sessions) {
        console.log(`\n   Game ID: ${session.id}`);
        if (session.state) {
          console.log(`   Name: ${session.state.name || "N/A"}`);
          console.log(`   Mode: ${session.state.mode || "N/A"}`);
          console.log(`   Status: ${session.state.status || "N/A"}`);
          console.log(`   Players: ${session.state.players?.length || 0}`);
          console.log(`   Created: ${new Date(session.state.createdAt).toISOString()}`);
          console.log(`   Last Activity: ${new Date(session.state.lastActivity).toISOString()}`);
          console.log(`   Updated: ${new Date(session.updatedAt).toISOString()}`);
          console.log(`   TTL: ${DEFAULT_TTL}s (${DEFAULT_TTL / 3600}h)`);
          console.log(`   Instance ID: ${session.instanceId || "N/A"}`);

          // Check for missing fields
          if (!session.state.name) console.log("   ⚠️  Missing: name");
          if (!session.state.mode) console.log("   ⚠️  Missing: mode");
          if (!session.state.players) console.log("   ⚠️  Missing: players");
          if (!session.state.status) console.log("   ⚠️  Missing: status");
        } else {
          console.log("   ⚠️  No state data!");
        }
      }
    } else {
      console.log("   No sessions found in Redis\n");
    }

    // Check for stale sessions
    console.log("\n4. Checking for stale sessions...");
    const now = Date.now();
    const staleThreshold = 24 * 60 * 60 * 1000; // 24 hours
    let staleCount = 0;

    for (const session of sessions) {
      if (session.state?.lastActivity) {
        const age = now - session.state.lastActivity;
        if (age > staleThreshold) {
          staleCount++;
          console.log(`   ⚠️  ${session.id}: Stale (${Math.floor(age / 3600000)}h old)`);
        }
      }
    }

    if (staleCount === 0) {
      console.log("   ✓ No stale sessions found\n");
    } else {
      console.log(`   Found ${staleCount} stale session(s)\n`);
    }
  } catch (error) {
    console.error("   ✗ Error:", error.message);
  } finally {
    redis.quit();
  }

  console.log("=== Diagnostics Complete ===");
}

diagnose();
