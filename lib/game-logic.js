const CONSTANTS = {
  TICK_INTERVAL: 100,
  MIN_PLAYERS: 2,
  MAX_PLAYERS: 8,
  MAX_INITIAL_TIME: 24 * 60 * 60 * 1000,
  MAX_PLAYER_NAME_LENGTH: 50,
  SESSION_CLEANUP_INTERVAL: 5 * 60 * 1000,
  INACTIVE_SESSION_THRESHOLD: 24 * 60 * 60 * 1000,
  EMPTY_SESSION_THRESHOLD: 5 * 60 * 1000,
  DEFAULT_INITIAL_TIME: 10 * 60 * 1000,
  WARNING_TICK_DELTA: 100,
  RATE_LIMIT_WINDOW: 1000,
  RATE_LIMIT_MAX_MESSAGES: 20,
};

class GameSession {
  constructor(id, settings, broadcastFn = null) {
    this.id = id;
    this.players = [];
    this.activePlayer = null;
    this.status = "waiting";
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.lastTick = null;
    this.interval = null;
    this.broadcastFn = broadcastFn;
    this.settings = {
      initialTime: settings.initialTime || CONSTANTS.DEFAULT_INITIAL_TIME,
      playerCount: settings.playerCount || CONSTANTS.MIN_PLAYERS,
      warningThresholds: settings.warningThresholds || [300000, 60000, 30000],
      penaltyType: settings.penaltyType || "warning",
      penaltyTimeDeduction: settings.penaltyTimeDeduction || 0,
      audioEnabled: true,
    };

    this.initPlayers();
  }

  initPlayers() {
    this.players = [];
    for (let i = 1; i <= this.settings.playerCount; i++) {
      this.players.push({
        id: i,
        name: `Player ${i}`,
        timeRemaining: this.settings.initialTime,
        penalties: 0,
        isEliminated: false,
        claimedBy: null,
        life: 20,
        drunkCounter: 0,
        genericCounter: 0,
      });
    }
  }

  claimPlayer(playerId, clientId) {
    if (this.status !== "waiting") return false;

    const player = this.players.find(p => p.id === playerId);
    if (!player) return false;

    if (player.claimedBy && player.claimedBy !== clientId) return false;

    this.players.forEach(p => {
      if (p.claimedBy === clientId) {
        p.claimedBy = null;
      }
    });

    player.claimedBy = clientId;
    this.broadcastState();
    return true;
  }

  unclaimPlayer(clientId) {
    this.players.forEach(p => {
      if (p.claimedBy === clientId) {
        p.claimedBy = null;
      }
    });
    this.broadcastState();
  }

  handleClientDisconnect(clientId) {
    let changed = false;
    this.players.forEach(p => {
      if (p.claimedBy === clientId) {
        p.claimedBy = null;
        changed = true;
      }
    });
    if (changed) {
      this.broadcastState();
    }
  }

  start() {
    if (this.status === "waiting" || this.status === "paused") {
      this.status = "running";
      this.lastTick = Date.now();
      this.activePlayer = this.activePlayer || 1;
      this.interval = setInterval(() => this.tick(), CONSTANTS.TICK_INTERVAL);
      this.broadcastState();
    }
  }

  pause() {
    if (this.status === "running") {
      this.status = "paused";
      clearInterval(this.interval);
      this.broadcastState();
    }
  }

  resume() {
    if (this.status === "paused") {
      this.start();
    }
  }

  tick() {
    if (this.status !== "running") return;

    const now = Date.now();
    const elapsed = now - this.lastTick;
    this.lastTick = now;

    const activePlayer = this.players.find(p => p.id === this.activePlayer);
    if (activePlayer && !activePlayer.isEliminated) {
      activePlayer.timeRemaining -= elapsed;

      if (activePlayer.timeRemaining <= 0) {
        activePlayer.timeRemaining = 0;
        this.handleTimeout(activePlayer);
      } else {
        this.checkWarnings(activePlayer);
      }

      this.broadcastTimes();
    }
  }

  handleTimeout(player) {
    this.pause();
    player.penalties++;
    this.broadcastTimeout(player.id);
    this.applyPenalty(player);
    this.broadcastState();
  }

  applyPenalty(player) {
    switch (this.settings.penaltyType) {
      case "time_deduction":
        player.timeRemaining -= this.settings.penaltyTimeDeduction;
        break;
      case "game_loss":
        player.isEliminated = true;
        break;
    }
  }

  checkWarnings(player) {
    this.settings.warningThresholds.forEach(threshold => {
      const nextThreshold =
        player.timeRemaining > threshold &&
        player.timeRemaining - CONSTANTS.WARNING_TICK_DELTA <= threshold;
      if (nextThreshold) {
        this.broadcastWarning(player.id, threshold);
      }
    });
  }

  switchPlayer(playerId) {
    const activePlayers = this.players.filter(p => !p.isEliminated);
    if (activePlayers.length <= 1) return;

    const targetPlayer = this.players.find(p => p.id === playerId);
    if (targetPlayer && !targetPlayer.isEliminated) {
      this.activePlayer = playerId;
      this.lastTick = Date.now();
      this.broadcastState();
    }
  }

  reset() {
    this.pause();
    this.status = "waiting";
    this.activePlayer = null;
    this.initPlayers();
    this.broadcastState();
  }

  updatePlayer(playerId, updates) {
    const player = this.players.find(p => p.id === playerId);
    if (player) {
      if (updates.name !== undefined) player.name = updates.name;
      if (updates.time !== undefined) player.timeRemaining = updates.time;
      if (updates.life !== undefined) player.life = updates.life;
      if (updates.drunkCounter !== undefined) player.drunkCounter = updates.drunkCounter;
      if (updates.genericCounter !== undefined) player.genericCounter = updates.genericCounter;
      this.broadcastState();
    }
  }

  addPenalty(playerId) {
    const player = this.players.find(p => p.id === playerId);
    if (player) {
      player.penalties++;
      this.applyPenalty(player);
      this.broadcastState();
    }
  }

  eliminate(playerId) {
    const player = this.players.find(p => p.id === playerId);
    if (player) {
      player.isEliminated = true;
      if (this.activePlayer === playerId) {
        const nextPlayer = this.players.find(p => !p.isEliminated);
        if (nextPlayer) {
          this.activePlayer = nextPlayer.id;
        } else {
          this.pause();
        }
      }
      this.broadcastState();
    }
  }

  broadcastState() {
    if (this.broadcastFn) {
      this.broadcastFn("state", this.getState());
    }
    this.lastActivity = Date.now();
  }

  broadcastTimes() {
    if (this.broadcastFn) {
      const times = {};
      this.players.forEach(p => {
        times[p.id] = p.timeRemaining;
      });
      this.broadcastFn("tick", { times });
    }
  }

  broadcastTimeout(playerId) {
    if (this.broadcastFn) {
      this.broadcastFn("timeout", { playerId });
    }
  }

  broadcastWarning(playerId, threshold) {
    if (this.broadcastFn) {
      this.broadcastFn("warning", { playerId, threshold });
    }
  }

  getState() {
    return {
      id: this.id,
      players: this.players,
      activePlayer: this.activePlayer,
      status: this.status,
      createdAt: this.createdAt,
      settings: this.settings,
    };
  }

  cleanup() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}

function validateSettings(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return false;

  if (settings.playerCount !== undefined) {
    const count = Number(settings.playerCount);
    if (!Number.isInteger(count) || count < CONSTANTS.MIN_PLAYERS || count > CONSTANTS.MAX_PLAYERS)
      return false;
  }

  if (settings.initialTime !== undefined) {
    const time = Number(settings.initialTime);
    if (!Number.isInteger(time) || time <= 0 || time > CONSTANTS.MAX_INITIAL_TIME) return false;
  }

  return true;
}

function validatePlayerName(name) {
  if (typeof name !== "string") return false;
  if (name.length > CONSTANTS.MAX_PLAYER_NAME_LENGTH) return false;
  return true;
}

function validateWarningThresholds(thresholds) {
  if (!Array.isArray(thresholds)) return false;
  if (thresholds.length === 0 || thresholds.length > 10) return false;
  return thresholds.every(
    t => typeof t === "number" && Number.isFinite(t) && t > 0 && t <= CONSTANTS.MAX_INITIAL_TIME
  );
}

function validateTimeValue(time) {
  if (typeof time !== "number") return false;
  if (!Number.isFinite(time)) return false;
  if (time < 0 || time > CONSTANTS.MAX_INITIAL_TIME) return false;
  return true;
}

function sanitizeString(str) {
  if (typeof str !== "string") return str;
  return str.replace(/[<>]/g, "");
}

function generateGameId(existingIds = new Set()) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const maxAttempts = 100;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let id = "";
    for (let i = 0; i < 6; i++) {
      id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    if (!existingIds.has(id)) {
      return id;
    }
  }

  return Date.now().toString(36).toUpperCase().slice(-6);
}

module.exports = {
  CONSTANTS,
  GameSession,
  validateSettings,
  validatePlayerName,
  validateWarningThresholds,
  validateTimeValue,
  sanitizeString,
  generateGameId,
};
