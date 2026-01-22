/**
 * SQLite-based session storage for game persistence
 * Enables crash recovery and data persistence across restarts
 */

const path = require("path");
const fs = require("fs");

class SessionStorage {
  constructor(dbPath = "./data/sessions.db") {
    this.dbPath = dbPath;
    this.db = null;
    this.statements = {};
  }

  /**
   * Initialize the database connection and schema
   */
  initialize() {
    // Ensure data directory exists
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Dynamic import of better-sqlite3
    const Database = require("better-sqlite3");
    this.db = new Database(this.dbPath);

    // Enable WAL mode for better concurrent access
    this.db.pragma("journal_mode = WAL");

    // Create sessions table
    this.db.exec(`
			CREATE TABLE IF NOT EXISTS sessions (
				id TEXT PRIMARY KEY,
				state TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);

    // Create index for cleanup queries
    this.db.exec(`
			CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at)
		`);

    // Prepare statements for better performance
    this.statements = {
      save: this.db.prepare(`
				INSERT OR REPLACE INTO sessions (id, state, created_at, updated_at)
				VALUES (?, ?, COALESCE((SELECT created_at FROM sessions WHERE id = ?), ?), ?)
			`),
      load: this.db.prepare("SELECT state FROM sessions WHERE id = ?"),
      loadAll: this.db.prepare("SELECT id, state FROM sessions"),
      delete: this.db.prepare("DELETE FROM sessions WHERE id = ?"),
      cleanup: this.db.prepare("DELETE FROM sessions WHERE updated_at < ?"),
      count: this.db.prepare("SELECT COUNT(*) as count FROM sessions"),
    };

    return this;
  }

  /**
   * Save a session to the database
   * @param {string} id - Game session ID
   * @param {object} sessionState - Session state object (from getState())
   */
  save(id, sessionState) {
    if (!this.db) return;

    const state = JSON.stringify(sessionState);
    const now = Date.now();
    this.statements.save.run(id, state, id, now, now);
  }

  /**
   * Load a session from the database
   * @param {string} id - Game session ID
   * @returns {object|null} Session state or null if not found
   */
  load(id) {
    if (!this.db) return null;

    const row = this.statements.load.get(id);
    return row ? JSON.parse(row.state) : null;
  }

  /**
   * Load all sessions from the database
   * @returns {Array} Array of {id, state} objects
   */
  loadAll() {
    if (!this.db) return [];

    const rows = this.statements.loadAll.all();
    return rows.map(row => ({
      id: row.id,
      state: JSON.parse(row.state),
    }));
  }

  /**
   * Delete a session from the database
   * @param {string} id - Game session ID
   */
  delete(id) {
    if (!this.db) return;
    this.statements.delete.run(id);
  }

  /**
   * Delete sessions older than maxAge
   * @param {number} maxAge - Maximum age in milliseconds
   * @returns {number} Number of deleted sessions
   */
  cleanup(maxAge) {
    if (!this.db) return 0;

    const cutoff = Date.now() - maxAge;
    const result = this.statements.cleanup.run(cutoff);
    return result.changes;
  }

  /**
   * Get the number of stored sessions
   * @returns {number} Session count
   */
  count() {
    if (!this.db) return 0;
    return this.statements.count.get().count;
  }

  /**
   * Close the database connection
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

/**
 * In-memory storage fallback (for testing or when SQLite is unavailable)
 */
class MemoryStorage {
  constructor() {
    this.sessions = new Map();
  }

  initialize() {
    return this;
  }

  save(id, sessionState) {
    this.sessions.set(id, {
      state: JSON.parse(JSON.stringify(sessionState)),
      createdAt: this.sessions.get(id)?.createdAt || Date.now(),
      updatedAt: Date.now(),
    });
  }

  load(id) {
    const data = this.sessions.get(id);
    return data ? data.state : null;
  }

  loadAll() {
    return Array.from(this.sessions.entries()).map(([id, data]) => ({
      id,
      state: data.state,
    }));
  }

  delete(id) {
    this.sessions.delete(id);
  }

  cleanup(maxAge) {
    const cutoff = Date.now() - maxAge;
    let deleted = 0;
    for (const [id, data] of this.sessions.entries()) {
      if (data.updatedAt < cutoff) {
        this.sessions.delete(id);
        deleted++;
      }
    }
    return deleted;
  }

  count() {
    return this.sessions.size;
  }

  close() {
    this.sessions.clear();
  }
}

/**
 * Create the appropriate storage backend
 * @param {string} type - 'sqlite', 'redis', or 'memory'
 * @param {string|object} config - Path to SQLite database or Redis config object
 * @returns {SessionStorage|MemoryStorage|RedisStorage}
 */
function createStorage(type = "sqlite", config = "./data/sessions.db") {
  if (type === "memory") {
    return new MemoryStorage().initialize();
  }

  if (type === "redis") {
    try {
      const { RedisStorage } = require("./redis-storage");
      const redisConfig = typeof config === "string" ? { url: config } : config;
      return new RedisStorage(redisConfig.url, redisConfig).initialize();
    } catch (error) {
      console.error("Failed to initialize Redis storage, falling back to SQLite:", error.message);
      // Fall through to SQLite
    }
  }

  // Default to SQLite
  const dbPath = typeof config === "string" ? config : "./data/sessions.db";
  try {
    return new SessionStorage(dbPath).initialize();
  } catch (error) {
    console.error("Failed to initialize SQLite storage, falling back to memory:", error.message);
    return new MemoryStorage().initialize();
  }
}

/**
 * Check if storage type requires async operations
 * @param {string} type - Storage type
 * @returns {boolean}
 */
function isAsyncStorage(type) {
  return type === "redis";
}

module.exports = {
  SessionStorage,
  MemoryStorage,
  createStorage,
  isAsyncStorage,
};
