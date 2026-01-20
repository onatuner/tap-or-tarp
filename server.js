const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const CONSTANTS = {
  TICK_INTERVAL: 100,
  MIN_PLAYERS: 2,
  MAX_PLAYERS: 8,
  MAX_INITIAL_TIME: 24 * 60 * 60 * 1000,
  MAX_PLAYER_NAME_LENGTH: 50,
  SESSION_CLEANUP_INTERVAL: 5 * 60 * 1000,
  INACTIVE_SESSION_THRESHOLD: 24 * 60 * 60 * 1000,
  EMPTY_SESSION_THRESHOLD: 5 * 60 * 1000,
  DEFAULT_INITIAL_TIME: 30 * 60 * 1000,
  WARNING_TICK_DELTA: 100,
  RATE_LIMIT_WINDOW: 1000,
  RATE_LIMIT_MAX_MESSAGES: 20
};

app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint for Fly.io
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    activeSessions: gameSessions.size
  });
});

const gameSessions = new Map();

class GameSession {
  constructor(id, settings) {
    this.id = id;
    this.players = [];
    this.activePlayer = null;
    this.status = 'waiting';
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.lastTick = null;
    this.interval = null;
    this.settings = {
      initialTime: settings.initialTime || CONSTANTS.DEFAULT_INITIAL_TIME,
      playerCount: settings.playerCount || CONSTANTS.MIN_PLAYERS,
      warningThresholds: settings.warningThresholds || [300000, 60000, 30000],
      penaltyType: settings.penaltyType || 'warning',
      penaltyTimeDeduction: settings.penaltyTimeDeduction || 0,
      audioEnabled: true
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
        isEliminated: false
      });
    }
  }

  start() {
    if (this.status === 'waiting' || this.status === 'paused') {
      this.status = 'running';
      this.lastTick = Date.now();
      this.activePlayer = this.activePlayer || 1;
      this.interval = setInterval(() => this.tick(), CONSTANTS.TICK_INTERVAL);
      this.broadcastState();
    }
  }

  pause() {
    if (this.status === 'running') {
      this.status = 'paused';
      clearInterval(this.interval);
      this.broadcastState();
    }
  }

  resume() {
    if (this.status === 'paused') {
      this.start();
    }
  }

  tick() {
    if (this.status !== 'running') return;
    
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
      case 'time_deduction':
        player.timeRemaining -= this.settings.penaltyTimeDeduction;
        break;
      case 'game_loss':
        player.isEliminated = true;
        break;
    }
  }

  checkWarnings(player) {
    this.settings.warningThresholds.forEach(threshold => {
      const nextThreshold = player.timeRemaining > threshold && 
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
    this.status = 'waiting';
    this.activePlayer = null;
    this.initPlayers();
    this.broadcastState();
  }

  updatePlayer(playerId, updates) {
    const player = this.players.find(p => p.id === playerId);
    if (player) {
      if (updates.name !== undefined) player.name = updates.name;
      if (updates.time !== undefined) player.timeRemaining = updates.time;
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
    this.lastActivity = Date.now();
    const state = this.getState();
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN && client.gameId === this.id) {
        client.send(JSON.stringify({ type: 'state', data: state }));
      }
    });
  }

  broadcastTimes() {
    const times = {};
    this.players.forEach(p => {
      times[p.id] = p.timeRemaining;
    });
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN && client.gameId === this.id) {
        client.send(JSON.stringify({ type: 'tick', data: { times } }));
      }
    });
  }

  broadcastTimeout(playerId) {
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN && client.gameId === this.id) {
        client.send(JSON.stringify({ type: 'timeout', data: { playerId } }));
      }
    });
  }

  broadcastWarning(playerId, threshold) {
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN && client.gameId === this.id) {
        client.send(JSON.stringify({ type: 'warning', data: { playerId, threshold } }));
      }
    });
  }

  getState() {
    return {
      id: this.id,
      players: this.players,
      activePlayer: this.activePlayer,
      status: this.status,
      createdAt: this.createdAt,
      settings: this.settings
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
  if (!settings || typeof settings !== 'object') return false;
  
  if (settings.playerCount !== undefined) {
    const count = Number(settings.playerCount);
    if (!Number.isInteger(count) || count < CONSTANTS.MIN_PLAYERS || count > CONSTANTS.MAX_PLAYERS) return false;
  }
  
  if (settings.initialTime !== undefined) {
    const time = Number(settings.initialTime);
    if (!Number.isInteger(time) || time <= 0 || time > CONSTANTS.MAX_INITIAL_TIME) return false;
  }
  
  return true;
}

function validatePlayerName(name) {
  if (typeof name !== 'string') return false;
  if (name.length > CONSTANTS.MAX_PLAYER_NAME_LENGTH) return false;
  return true;
}

function validateWarningThresholds(thresholds) {
  if (!Array.isArray(thresholds)) return false;
  if (thresholds.length === 0 || thresholds.length > 10) return false;
  return thresholds.every(t => 
    typeof t === 'number' && 
    Number.isFinite(t) && 
    t > 0 && 
    t <= CONSTANTS.MAX_INITIAL_TIME
  );
}

function validateTimeValue(time) {
  if (typeof time !== 'number') return false;
  if (!Number.isFinite(time)) return false;
  if (time < 0 || time > CONSTANTS.MAX_INITIAL_TIME) return false;
  return true;
}

function sanitizeString(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/[<>]/g, '');
}

wss.on('connection', (ws) => {
  ws.messageTimestamps = [];

  ws.on('message', (message) => {
    // Rate limiting
    const now = Date.now();
    ws.messageTimestamps = ws.messageTimestamps.filter(
      ts => now - ts < CONSTANTS.RATE_LIMIT_WINDOW
    );
    
    if (ws.messageTimestamps.length >= CONSTANTS.RATE_LIMIT_MAX_MESSAGES) {
      ws.send(JSON.stringify({ type: 'error', data: { message: 'Rate limit exceeded' } }));
      return;
    }
    ws.messageTimestamps.push(now);

    try {
      const parsed = JSON.parse(message);
      const type = parsed.type;
      const data = parsed.data || {};

      if (!type || typeof type !== 'string') {
        ws.send(JSON.stringify({ type: 'error', data: { message: 'Invalid message type' } }));
        return;
      }

      switch (type) {
      case 'create': {
        if (!validateSettings(data.settings)) {
          ws.send(JSON.stringify({ type: 'error', data: { message: 'Invalid settings' } }));
          break;
        }
        const gameId = generateGameId();
        const session = new GameSession(gameId, data.settings || {});
        gameSessions.set(gameId, session);
        ws.gameId = gameId;
        ws.send(JSON.stringify({ type: 'state', data: session.getState() }));
        break;
      }
      case 'join': {
        const session = gameSessions.get(data.gameId);
        if (!session) {
          ws.send(JSON.stringify({ type: 'error', data: { message: 'Game not found' } }));
          break;
        }
        ws.gameId = data.gameId;
        session.lastActivity = Date.now();
        ws.send(JSON.stringify({ type: 'state', data: session.getState() }));
        break;
      }
      case 'start': {
        const session = gameSessions.get(ws.gameId);
        if (session) {
          session.lastActivity = Date.now();
          session.start();
        }
        break;
      }
      case 'pause': {
        const session = gameSessions.get(ws.gameId);
        if (session) {
          session.lastActivity = Date.now();
          if (session.status === 'running') {
            session.pause();
          } else if (session.status === 'paused') {
            session.resume();
          }
        }
        break;
      }
      case 'reset': {
        const session = gameSessions.get(ws.gameId);
        if (session) {
          session.lastActivity = Date.now();
          session.reset();
        }
        break;
      }
      case 'switch': {
        const session = gameSessions.get(ws.gameId);
        if (session) {
          if (data.playerId === undefined || data.playerId < 1 || data.playerId > CONSTANTS.MAX_PLAYERS) break;
          session.lastActivity = Date.now();
          session.switchPlayer(data.playerId);
        }
        break;
      }
      case 'updatePlayer': {
        const session = gameSessions.get(ws.gameId);
        if (session) {
          if (data.playerId === undefined || data.playerId < 1 || data.playerId > CONSTANTS.MAX_PLAYERS) break;
          if (data.name !== undefined && !validatePlayerName(data.name)) break;
          if (data.time !== undefined && !validateTimeValue(data.time)) break;
          if (data.name !== undefined) {
            data.name = sanitizeString(data.name);
          }
          session.lastActivity = Date.now();
          session.updatePlayer(data.playerId, data);
        }
        break;
      }
      case 'addPenalty': {
        const session = gameSessions.get(ws.gameId);
        if (session) {
          if (data.playerId === undefined || data.playerId < 1 || data.playerId > CONSTANTS.MAX_PLAYERS) break;
          session.lastActivity = Date.now();
          session.addPenalty(data.playerId);
        }
        break;
      }
      case 'eliminate': {
        const session = gameSessions.get(ws.gameId);
        if (session) {
          if (data.playerId === undefined || data.playerId < 1 || data.playerId > CONSTANTS.MAX_PLAYERS) break;
          session.lastActivity = Date.now();
          session.eliminate(data.playerId);
        }
        break;
      }
      case 'updateSettings': {
        const session = gameSessions.get(ws.gameId);
        if (session) {
          session.lastActivity = Date.now();
          if (data.warningThresholds !== undefined) {
            if (!validateWarningThresholds(data.warningThresholds)) {
              ws.send(JSON.stringify({ type: 'error', data: { message: 'Invalid warning thresholds' } }));
              break;
            }
            session.settings.warningThresholds = data.warningThresholds;
            session.broadcastState();
          }
        }
        break;
      }
    }
    } catch (e) {
      console.error('Invalid JSON received:', e.message);
      return;
    }
  });

  ws.on('close', () => {
    const session = gameSessions.get(ws.gameId);
    if (session) {
      const clientsConnected = Array.from(wss.clients).filter(
        client => client.gameId === ws.gameId && client.readyState === WebSocket.OPEN
      ).length;
      
      if (clientsConnected === 0 && session.status === 'running') {
        session.pause();
      }
    }
  });
});

function generateGameId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const maxAttempts = 100;
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let id = '';
    for (let i = 0; i < 6; i++) {
      id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    if (!gameSessions.has(id)) {
      return id;
    }
  }
  
  // Fallback: append timestamp if all attempts fail
  return Date.now().toString(36).toUpperCase().slice(-6);
}

setInterval(() => {
  const now = Date.now();

  for (const [gameId, session] of gameSessions.entries()) {
    const clientsConnected = Array.from(wss.clients).filter(
      client => client.gameId === gameId && client.readyState === WebSocket.OPEN
    ).length;

    const shouldDelete = 
      (clientsConnected === 0 && now - session.lastActivity > CONSTANTS.EMPTY_SESSION_THRESHOLD) ||
      (now - session.lastActivity > CONSTANTS.INACTIVE_SESSION_THRESHOLD);

    if (shouldDelete) {
      session.cleanup();
      gameSessions.delete(gameId);
    }
  }
}, CONSTANTS.SESSION_CLEANUP_INTERVAL);

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // Bind to all interfaces for Docker/Fly.io

server.listen(PORT, HOST, () => {
  console.log(`Tap or Tarp server running on ${HOST}:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
