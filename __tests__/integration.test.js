/**
 * Integration tests for WebSocket game flows
 * Tests the full server with real WebSocket connections
 */

const http = require("http");
const express = require("express");
const WebSocket = require("ws");
const path = require("path");

// Import server components
const { CONSTANTS } = require("../lib/shared/constants");
const { validateSettings, sanitizeString, generateGameId } = require("../lib/shared/validators");
const { CasualGameSession: GameSession } = require("../lib/game-modes");
const { createStorage } = require("../lib/storage");
const { RateLimiter, ConnectionRateLimiter, getClientIP } = require("../lib/rate-limiter");

// Test configuration
const TEST_PORT = 0; // Use random available port
const TEST_TIMEOUT = 10000;

/**
 * Create a minimal test server that mimics the main server's WebSocket behavior
 */
function createTestServer() {
  const app = express();
  const server = http.createServer(app);
  const gameSessions = new Map();

  const messageRateLimiter = new RateLimiter({
    windowMs: 1000,
    maxRequests: 30,
  });

  const wss = new WebSocket.Server({
    server,
    maxPayload: 64 * 1024,
  });

  let clientIdCounter = 0;

  function generateClientId() {
    return `test_client_${Date.now()}_${++clientIdCounter}`;
  }

  function broadcastToGame(gameId, type, data) {
    const message = JSON.stringify({ type, data });
    wss.clients.forEach(client => {
      if (client.gameId === gameId && client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  wss.on("connection", (ws, req) => {
    ws.clientId = generateClientId();
    ws.clientIP = req.socket.remoteAddress || "127.0.0.1";

    // Send client ID
    ws.send(JSON.stringify({ type: "clientId", data: { clientId: ws.clientId } }));

    ws.on("message", message => {
      try {
        const parsed = JSON.parse(message);
        const type = parsed.type;
        const data = parsed.data || {};

        switch (type) {
          case "create": {
            if (!validateSettings(data.settings)) {
              ws.send(JSON.stringify({ type: "error", data: { message: "Invalid settings" } }));
              break;
            }

            const gameId = generateGameId(new Set(gameSessions.keys()));
            const session = new GameSession(gameId, data.settings || {}, (msgType, msgData) => {
              broadcastToGame(gameId, msgType, msgData);
            });
            session.setOwner(ws.clientId);
            gameSessions.set(gameId, session);
            ws.gameId = gameId;

            ws.send(JSON.stringify({ type: "state", data: session.getState() }));
            break;
          }

          case "join": {
            const session = gameSessions.get(data.gameId);
            if (!session) {
              ws.send(JSON.stringify({ type: "error", data: { message: "Game not found" } }));
              break;
            }

            ws.gameId = data.gameId;
            if (!session.ownerId) {
              session.setOwner(ws.clientId);
            }
            ws.send(JSON.stringify({ type: "state", data: session.getState() }));
            break;
          }

          case "start": {
            const session = gameSessions.get(ws.gameId);
            if (session && session.canControlGame(ws.clientId)) {
              session.start();
            } else if (session) {
              ws.send(
                JSON.stringify({ type: "error", data: { message: "Not authorized to start game" } })
              );
            }
            break;
          }

          case "pause": {
            const session = gameSessions.get(ws.gameId);
            if (session && session.canControlGame(ws.clientId)) {
              if (session.status === "running") {
                session.pause();
              } else if (session.status === "paused") {
                session.resume();
              }
            }
            break;
          }

          case "reset": {
            const session = gameSessions.get(ws.gameId);
            if (session && session.isOwner(ws.clientId)) {
              session.reset();
            } else if (session) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  data: { message: "Only the game owner can reset" },
                })
              );
            }
            break;
          }

          case "switch": {
            const session = gameSessions.get(ws.gameId);
            if (session && session.canSwitchPlayer(data.playerId, ws.clientId)) {
              session.switchPlayer(data.playerId);
            }
            break;
          }

          case "claim": {
            const session = gameSessions.get(ws.gameId);
            if (session) {
              const result = session.claimPlayer(data.playerId, ws.clientId);
              if (result.success) {
                ws.send(
                  JSON.stringify({
                    type: "claimed",
                    data: { playerId: data.playerId, token: result.token, gameId: ws.gameId },
                  })
                );
              } else {
                ws.send(JSON.stringify({ type: "error", data: { message: result.reason } }));
              }
            }
            break;
          }

          case "unclaim": {
            const session = gameSessions.get(ws.gameId);
            if (session) {
              session.unclaimPlayer(ws.clientId);
            }
            break;
          }

          case "reconnect": {
            const session = gameSessions.get(data.gameId);
            if (!session) {
              ws.send(JSON.stringify({ type: "error", data: { message: "Game not found" } }));
              break;
            }

            const result = session.reconnectPlayer(data.playerId, data.token, ws.clientId);
            if (result.success) {
              ws.gameId = data.gameId;
              ws.send(
                JSON.stringify({
                  type: "reconnected",
                  data: { playerId: data.playerId, token: result.token, gameId: data.gameId },
                })
              );
              ws.send(JSON.stringify({ type: "state", data: session.getState() }));
            } else {
              ws.send(JSON.stringify({ type: "error", data: { message: result.reason } }));
            }
            break;
          }

          case "updatePlayer": {
            const session = gameSessions.get(ws.gameId);
            if (session && session.canModifyPlayer(data.playerId, ws.clientId)) {
              if (data.name !== undefined) {
                data.name = sanitizeString(data.name);
              }
              session.updatePlayer(data.playerId, data);
            }
            break;
          }

          case "updateSettings": {
            const session = gameSessions.get(ws.gameId);
            if (session && session.isOwner(ws.clientId)) {
              if (data.warningThresholds !== undefined) {
                session.settings.warningThresholds = data.warningThresholds;
                session.broadcastState();
              }
            }
            break;
          }
        }
      } catch (e) {
        ws.send(JSON.stringify({ type: "error", data: { message: "Invalid message format" } }));
      }
    });

    ws.on("close", () => {
      const session = gameSessions.get(ws.gameId);
      if (session) {
        session.handleClientDisconnect(ws.clientId);
      }
    });
  });

  return {
    server,
    wss,
    gameSessions,
    close: () => {
      return new Promise(resolve => {
        // Cleanup all sessions
        for (const [, session] of gameSessions) {
          session.cleanup();
        }
        gameSessions.clear();

        // Close rate limiters
        messageRateLimiter.close();

        // Close all WebSocket connections
        wss.clients.forEach(client => {
          client.close();
        });

        wss.close(() => {
          server.close(() => {
            resolve();
          });
        });
      });
    },
  };
}

/**
 * WebSocket test client helper
 */
class TestClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.clientId = null;
    this.messages = [];
    this.messageHandlers = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      const timeout = setTimeout(() => {
        reject(new Error("Connection timeout"));
      }, 5000);

      this.ws.on("open", () => {
        clearTimeout(timeout);
      });

      this.ws.on("message", data => {
        const message = JSON.parse(data.toString());
        this.messages.push(message);

        // Capture clientId
        if (message.type === "clientId") {
          this.clientId = message.data.clientId;
          resolve(this);
        }

        // Notify handlers
        this.messageHandlers.forEach(handler => handler(message));
      });

      this.ws.on("error", err => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  send(type, data = {}) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, data }));
    }
  }

  waitForMessage(type, timeout = 5000) {
    return new Promise((resolve, reject) => {
      // Check if we already have the message
      const existing = this.messages.find(m => m.type === type);
      if (existing) {
        resolve(existing);
        return;
      }

      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for message type: ${type}`));
      }, timeout);

      const handler = message => {
        if (message.type === type) {
          clearTimeout(timer);
          this.messageHandlers = this.messageHandlers.filter(h => h !== handler);
          resolve(message);
        }
      };

      this.messageHandlers.push(handler);
    });
  }

  /**
   * Wait for a new message of the specified type (ignores existing messages)
   */
  waitForNewMessage(type, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for new message type: ${type}`));
      }, timeout);

      const handler = message => {
        if (message.type === type) {
          clearTimeout(timer);
          this.messageHandlers = this.messageHandlers.filter(h => h !== handler);
          resolve(message);
        }
      };

      this.messageHandlers.push(handler);
    });
  }

  /**
   * Wait for a state message with a specific status
   */
  waitForState(status, timeout = 5000) {
    return new Promise((resolve, reject) => {
      // Check existing messages
      const existing = this.messages.find(m => m.type === "state" && m.data.status === status);
      if (existing) {
        resolve(existing);
        return;
      }

      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for state: ${status}`));
      }, timeout);

      const handler = message => {
        if (message.type === "state" && message.data.status === status) {
          clearTimeout(timer);
          this.messageHandlers = this.messageHandlers.filter(h => h !== handler);
          resolve(message);
        }
      };

      this.messageHandlers.push(handler);
    });
  }

  waitForNextMessage(timeout = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Timeout waiting for next message"));
      }, timeout);

      const handler = message => {
        clearTimeout(timer);
        this.messageHandlers = this.messageHandlers.filter(h => h !== handler);
        resolve(message);
      };

      this.messageHandlers.push(handler);
    });
  }

  clearMessages() {
    this.messages = [];
  }

  getMessages(type) {
    return this.messages.filter(m => m.type === type);
  }

  getLastMessage(type) {
    const messages = this.getMessages(type);
    return messages[messages.length - 1];
  }

  close() {
    if (this.ws) {
      this.ws.close();
    }
  }
}

// ============================================================================
// TESTS
// ============================================================================

describe("Integration Tests", () => {
  let testServer;
  let serverUrl;

  beforeAll(async () => {
    testServer = createTestServer();

    await new Promise(resolve => {
      testServer.server.listen(TEST_PORT, "127.0.0.1", () => {
        const address = testServer.server.address();
        serverUrl = `ws://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await testServer.close();
  });

  afterEach(() => {
    // Clean up any remaining sessions between tests
    for (const [, session] of testServer.gameSessions) {
      session.cleanup();
    }
    testServer.gameSessions.clear();
  });

  describe("Connection", () => {
    test("should connect and receive clientId", async () => {
      const client = new TestClient(serverUrl);
      await client.connect();

      expect(client.clientId).toBeDefined();
      expect(client.clientId).toMatch(/^test_client_/);

      client.close();
    });

    test("should handle multiple simultaneous connections", async () => {
      const clients = await Promise.all([
        new TestClient(serverUrl).connect(),
        new TestClient(serverUrl).connect(),
        new TestClient(serverUrl).connect(),
      ]);

      // All clients should have unique IDs
      const clientIds = clients.map(c => c.clientId);
      const uniqueIds = new Set(clientIds);
      expect(uniqueIds.size).toBe(3);

      clients.forEach(c => c.close());
    });
  });

  describe("Game Creation and Joining", () => {
    test("should create a new game", async () => {
      const client = new TestClient(serverUrl);
      await client.connect();

      client.send("create", { settings: { playerCount: 4, initialTime: 600000 } });
      const stateMsg = await client.waitForMessage("state");

      expect(stateMsg.data.id).toBeDefined();
      expect(stateMsg.data.id).toHaveLength(6);
      expect(stateMsg.data.players).toHaveLength(4);
      expect(stateMsg.data.status).toBe("waiting");
      expect(stateMsg.data.ownerId).toBe(client.clientId);

      client.close();
    });

    test("should join an existing game", async () => {
      const creator = new TestClient(serverUrl);
      await creator.connect();

      creator.send("create", { settings: { playerCount: 2 } });
      const createState = await creator.waitForMessage("state");
      const gameId = createState.data.id;

      const joiner = new TestClient(serverUrl);
      await joiner.connect();

      joiner.send("join", { gameId });
      const joinState = await joiner.waitForMessage("state");

      expect(joinState.data.id).toBe(gameId);
      expect(joinState.data.players).toHaveLength(2);

      creator.close();
      joiner.close();
    });

    test("should fail to join non-existent game", async () => {
      const client = new TestClient(serverUrl);
      await client.connect();

      client.send("join", { gameId: "NOTFOUND" });
      const errorMsg = await client.waitForMessage("error");

      expect(errorMsg.data.message).toBe("Game not found");

      client.close();
    });

    test("should reject invalid settings", async () => {
      const client = new TestClient(serverUrl);
      await client.connect();

      client.send("create", { settings: { playerCount: 100 } });
      const errorMsg = await client.waitForMessage("error");

      expect(errorMsg.data.message).toBe("Invalid settings");

      client.close();
    });
  });

  describe("Player Claiming", () => {
    test("should claim a player and receive token", async () => {
      const client = new TestClient(serverUrl);
      await client.connect();

      client.send("create", { settings: { playerCount: 2 } });
      await client.waitForMessage("state");

      client.clearMessages();
      client.send("claim", { playerId: 1 });

      const claimedMsg = await client.waitForMessage("claimed");
      expect(claimedMsg.data.playerId).toBe(1);
      expect(claimedMsg.data.token).toBeDefined();
      expect(claimedMsg.data.token).toHaveLength(64);

      // Should also receive updated state
      const stateMsg = await client.waitForMessage("state");
      const player1 = stateMsg.data.players.find(p => p.id === 1);
      expect(player1.claimedBy).toBe(client.clientId);

      client.close();
    });

    test("should prevent claiming already claimed player", async () => {
      const client1 = new TestClient(serverUrl);
      const client2 = new TestClient(serverUrl);
      await client1.connect();
      await client2.connect();

      client1.send("create", { settings: { playerCount: 2 } });
      const createState = await client1.waitForMessage("state");
      const gameId = createState.data.id;

      client2.send("join", { gameId });
      await client2.waitForMessage("state");

      // Client1 claims player 1
      client1.send("claim", { playerId: 1 });
      await client1.waitForMessage("claimed");

      // Client2 tries to claim same player
      client2.clearMessages();
      client2.send("claim", { playerId: 1 });
      const errorMsg = await client2.waitForMessage("error");

      expect(errorMsg.data.message).toBe("Player already claimed");

      client1.close();
      client2.close();
    });

    test("should unclaim a player", async () => {
      const client = new TestClient(serverUrl);
      await client.connect();

      client.send("create", { settings: { playerCount: 2 } });
      await client.waitForMessage("state");

      client.send("claim", { playerId: 1 });
      await client.waitForMessage("claimed");

      client.clearMessages();
      client.send("unclaim", {});

      const stateMsg = await client.waitForMessage("state");
      const player1 = stateMsg.data.players.find(p => p.id === 1);
      expect(player1.claimedBy).toBe(null);

      client.close();
    });
  });

  describe("Game Controls", () => {
    test("should start game when owner", async () => {
      const client = new TestClient(serverUrl);
      await client.connect();

      client.send("create", { settings: { playerCount: 2 } });
      await client.waitForMessage("state");

      client.clearMessages();
      client.send("start", {});

      const stateMsg = await client.waitForMessage("state");
      expect(stateMsg.data.status).toBe("running");
      expect(stateMsg.data.activePlayer).toBe(1);

      client.close();
    });

    test("should pause and resume game", async () => {
      const client = new TestClient(serverUrl);
      await client.connect();

      client.send("create", { settings: { playerCount: 2 } });
      await client.waitForMessage("state");

      client.send("start", {});
      await client.waitForState("running");

      // Pause
      client.send("pause", {});
      let stateMsg = await client.waitForState("paused");
      expect(stateMsg.data.status).toBe("paused");

      // Resume
      client.send("pause", {});
      stateMsg = await client.waitForState("running");
      expect(stateMsg.data.status).toBe("running");

      client.close();
    });

    test("should reset game", async () => {
      const client = new TestClient(serverUrl);
      await client.connect();

      client.send("create", { settings: { playerCount: 2, initialTime: 600000 } });
      await client.waitForMessage("state");

      client.send("start", {});
      await client.waitForState("running");

      // Wait a bit for time to decrement
      await new Promise(resolve => setTimeout(resolve, 200));

      client.send("reset", {});
      const stateMsg = await client.waitForState("waiting");

      expect(stateMsg.data.status).toBe("waiting");
      expect(stateMsg.data.activePlayer).toBe(null);
      expect(stateMsg.data.players[0].timeRemaining).toBe(600000);

      client.close();
    });

    test("should switch active player", async () => {
      const client = new TestClient(serverUrl);
      await client.connect();

      client.send("create", { settings: { playerCount: 4 } });
      await client.waitForMessage("state");

      client.send("start", {});
      await client.waitForState("running");

      // Wait for state with activePlayer = 3
      client.send("switch", { playerId: 3 });

      // Wait for a state update where activePlayer is 3
      const stateMsg = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timeout waiting for switch")), 5000);
        const handler = message => {
          if (message.type === "state" && message.data.activePlayer === 3) {
            clearTimeout(timeout);
            client.messageHandlers = client.messageHandlers.filter(h => h !== handler);
            resolve(message);
          }
        };
        client.messageHandlers.push(handler);
      });

      expect(stateMsg.data.activePlayer).toBe(3);

      client.close();
    });

    test("should prevent non-owner from resetting", async () => {
      const owner = new TestClient(serverUrl);
      const other = new TestClient(serverUrl);
      await owner.connect();
      await other.connect();

      owner.send("create", { settings: { playerCount: 2 } });
      const createState = await owner.waitForMessage("state");
      const gameId = createState.data.id;

      other.send("join", { gameId });
      await other.waitForMessage("state");

      other.clearMessages();
      other.send("reset", {});

      const errorMsg = await other.waitForMessage("error");
      expect(errorMsg.data.message).toBe("Only the game owner can reset");

      owner.close();
      other.close();
    });

    test("should allow claimed player to start game", async () => {
      const owner = new TestClient(serverUrl);
      const player = new TestClient(serverUrl);
      await owner.connect();
      await player.connect();

      owner.send("create", { settings: { playerCount: 2 } });
      const createState = await owner.waitForMessage("state");
      const gameId = createState.data.id;

      player.send("join", { gameId });
      await player.waitForMessage("state");

      // Player claims a slot
      player.send("claim", { playerId: 2 });
      await player.waitForMessage("claimed");

      // Player should be able to start
      player.clearMessages();
      player.send("start", {});

      const stateMsg = await player.waitForMessage("state");
      expect(stateMsg.data.status).toBe("running");

      owner.close();
      player.close();
    });
  });

  describe("Reconnection", () => {
    test("should reconnect with valid token", async () => {
      const client1 = new TestClient(serverUrl);
      await client1.connect();

      client1.send("create", { settings: { playerCount: 2 } });
      const createState = await client1.waitForMessage("state");
      const gameId = createState.data.id;

      client1.send("claim", { playerId: 1 });
      const claimedMsg = await client1.waitForMessage("claimed");
      const token = claimedMsg.data.token;

      // Simulate disconnect
      client1.close();

      // Reconnect with new client
      const client2 = new TestClient(serverUrl);
      await client2.connect();

      client2.send("reconnect", { gameId, playerId: 1, token });

      const reconnectedMsg = await client2.waitForMessage("reconnected");
      expect(reconnectedMsg.data.playerId).toBe(1);
      expect(reconnectedMsg.data.gameId).toBe(gameId);
      expect(reconnectedMsg.data.token).toBeDefined();
      expect(reconnectedMsg.data.token).not.toBe(token); // New token issued

      // Should also receive current state
      const stateMsg = await client2.waitForMessage("state");
      expect(stateMsg.data.id).toBe(gameId);

      client2.close();
    });

    test("should fail reconnection with invalid token", async () => {
      const client1 = new TestClient(serverUrl);
      await client1.connect();

      client1.send("create", { settings: { playerCount: 2 } });
      const createState = await client1.waitForMessage("state");
      const gameId = createState.data.id;

      client1.send("claim", { playerId: 1 });
      await client1.waitForMessage("claimed");

      const client2 = new TestClient(serverUrl);
      await client2.connect();

      client2.send("reconnect", { gameId, playerId: 1, token: "invalid-token" });

      const errorMsg = await client2.waitForMessage("error");
      expect(errorMsg.data.message).toBe("Invalid token");

      client1.close();
      client2.close();
    });

    test("should fail reconnection to non-existent game", async () => {
      const client = new TestClient(serverUrl);
      await client.connect();

      client.send("reconnect", { gameId: "NOTFOUND", playerId: 1, token: "some-token" });

      const errorMsg = await client.waitForMessage("error");
      expect(errorMsg.data.message).toBe("Game not found");

      client.close();
    });
  });

  describe("Player Updates", () => {
    test("should update player name", async () => {
      const client = new TestClient(serverUrl);
      await client.connect();

      client.send("create", { settings: { playerCount: 2 } });
      await client.waitForMessage("state");

      client.clearMessages();
      client.send("updatePlayer", { playerId: 1, name: "Alice" });

      const stateMsg = await client.waitForMessage("state");
      const player1 = stateMsg.data.players.find(p => p.id === 1);
      expect(player1.name).toBe("Alice");

      client.close();
    });

    test("should sanitize player name to prevent XSS", async () => {
      const client = new TestClient(serverUrl);
      await client.connect();

      client.send("create", { settings: { playerCount: 2 } });
      await client.waitForMessage("state");

      client.clearMessages();
      client.send("updatePlayer", { playerId: 1, name: '<script>alert("xss")</script>' });

      const stateMsg = await client.waitForMessage("state");
      const player1 = stateMsg.data.players.find(p => p.id === 1);
      expect(player1.name).not.toContain("<script>");
      expect(player1.name).toContain("&lt;script&gt;");

      client.close();
    });

    test("should update player life", async () => {
      const client = new TestClient(serverUrl);
      await client.connect();

      client.send("create", { settings: { playerCount: 2 } });
      await client.waitForMessage("state");

      client.clearMessages();
      client.send("updatePlayer", { playerId: 1, life: 15 });

      const stateMsg = await client.waitForMessage("state");
      const player1 = stateMsg.data.players.find(p => p.id === 1);
      expect(player1.life).toBe(15);

      client.close();
    });
  });

  describe("Broadcasting", () => {
    test("should broadcast state changes to all clients in game", async () => {
      const client1 = new TestClient(serverUrl);
      const client2 = new TestClient(serverUrl);
      await client1.connect();
      await client2.connect();

      client1.send("create", { settings: { playerCount: 2 } });
      const createState = await client1.waitForMessage("state");
      const gameId = createState.data.id;

      client2.send("join", { gameId });
      await client2.waitForMessage("state");

      // Clear messages and have client1 update player name
      client1.clearMessages();
      client2.clearMessages();

      client1.send("updatePlayer", { playerId: 1, name: "TestPlayer" });

      // Both clients should receive the state update
      const state1 = await client1.waitForMessage("state");
      const state2 = await client2.waitForMessage("state");

      expect(state1.data.players[0].name).toBe("TestPlayer");
      expect(state2.data.players[0].name).toBe("TestPlayer");

      client1.close();
      client2.close();
    });

    test("should not broadcast to clients in different games", async () => {
      const client1 = new TestClient(serverUrl);
      const client2 = new TestClient(serverUrl);
      await client1.connect();
      await client2.connect();

      // Create two separate games
      client1.send("create", { settings: { playerCount: 2 } });
      await client1.waitForMessage("state");

      client2.send("create", { settings: { playerCount: 2 } });
      await client2.waitForMessage("state");

      // Clear messages
      client1.clearMessages();
      client2.clearMessages();

      // Client1 updates their game
      client1.send("updatePlayer", { playerId: 1, name: "Game1Player" });

      // Client1 should receive update
      const state1 = await client1.waitForMessage("state");
      expect(state1.data.players[0].name).toBe("Game1Player");

      // Client2 should NOT receive any message (use short timeout)
      await expect(client2.waitForNextMessage(500)).rejects.toThrow("Timeout");

      client1.close();
      client2.close();
    });
  });

  describe("Timer Ticks", () => {
    test("should receive tick messages during running game", async () => {
      const client = new TestClient(serverUrl);
      await client.connect();

      client.send("create", { settings: { playerCount: 2, initialTime: 600000 } });
      await client.waitForMessage("state");

      client.send("start", {});
      await client.waitForMessage("state");

      client.clearMessages();

      // Wait for tick messages
      const tickMsg = await client.waitForMessage("tick", 2000);

      expect(tickMsg.data.times).toBeDefined();
      expect(tickMsg.data.times[1]).toBeDefined();
      expect(tickMsg.data.times[1]).toBeLessThan(600000);

      client.close();
    });
  });

  describe("Client Disconnect Handling", () => {
    test("should unclaim player when client disconnects", async () => {
      const client1 = new TestClient(serverUrl);
      const client2 = new TestClient(serverUrl);
      await client1.connect();
      await client2.connect();

      client1.send("create", { settings: { playerCount: 2 } });
      const createState = await client1.waitForMessage("state");
      const gameId = createState.data.id;

      client2.send("join", { gameId });
      await client2.waitForMessage("state");

      // Client2 claims player 2
      client2.send("claim", { playerId: 2 });
      await client2.waitForMessage("claimed");
      await client1.waitForMessage("state"); // client1 receives broadcast

      // Verify player 2 is claimed
      let state = client1.getLastMessage("state");
      expect(state.data.players[1].claimedBy).toBe(client2.clientId);

      // Client2 disconnects
      client2.close();

      // Wait for state broadcast
      client1.clearMessages();
      const disconnectState = await client1.waitForMessage("state", 2000);

      // Player 2 should be unclaimed
      expect(disconnectState.data.players[1].claimedBy).toBe(null);

      client1.close();
    });
  });
});
