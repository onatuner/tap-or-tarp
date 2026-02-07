/**
 * Game Control Handlers
 *
 * Handles game control actions: start, pause, reset, switch.
 */

const { logger } = require("../../logger");
const metrics = require("../../metrics");
const { withGameLock } = require("../../lock");
const { CONSTANTS } = require("../../shared/constants");
const { sanitizeString } = require("../../shared/validators");
const { serverState } = require("../state");
const { safeSend } = require("../websocket");
const { ensureGameLoaded, syncGameToRedis } = require("../persistence");

/**
 * Handle start game message
 * @param {WebSocket} ws - WebSocket client
 * @param {object} data - Message data
 */
async function handleStart(ws, data) {
  const session = serverState.isRedisPrimaryMode
    ? await ensureGameLoaded(ws.gameId)
    : serverState.getSession(ws.gameId);

  if (!session) return;

  try {
    await withGameLock(ws.gameId, async () => {
      if (!session.canControlGame(ws.clientId)) {
        safeSend(
          ws,
          JSON.stringify({
            type: "error",
            data: { message: "Not authorized to start game" },
          })
        );
        metrics.recordAuthDenied("start");
        logger.warn({ gameId: ws.gameId, clientId: ws.clientId }, "Unauthorized start attempt");
        return;
      }

      session.lastActivity = Date.now();
      session.start();

      if (serverState.isRedisPrimaryMode) {
        await syncGameToRedis(ws.gameId);
      }

      logger.info({ gameId: ws.gameId }, "Game started");
    });
  } catch (error) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: error.message } }));
    metrics.recordError("start_lock_error");
  }
}

/**
 * Handle pause/resume game message
 * @param {WebSocket} ws - WebSocket client
 * @param {object} data - Message data
 */
async function handlePause(ws, data) {
  const session = serverState.isRedisPrimaryMode
    ? await ensureGameLoaded(ws.gameId)
    : serverState.getSession(ws.gameId);

  if (!session) return;

  try {
    await withGameLock(ws.gameId, async () => {
      if (!session.canControlGame(ws.clientId)) {
        safeSend(
          ws,
          JSON.stringify({
            type: "error",
            data: { message: "Not authorized to pause/resume" },
          })
        );
        metrics.recordAuthDenied("pause");
        return;
      }

      session.lastActivity = Date.now();

      if (session.status === "running") {
        session.pause();
        if (serverState.isRedisPrimaryMode) {
          await syncGameToRedis(ws.gameId);
        }
        logger.debug({ gameId: ws.gameId }, "Game paused");
      } else if (session.status === "paused") {
        session.resume();
        if (serverState.isRedisPrimaryMode) {
          await syncGameToRedis(ws.gameId);
        }
        logger.debug({ gameId: ws.gameId }, "Game resumed");
      }
    });
  } catch (error) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: error.message } }));
    metrics.recordError("pause_lock_error");
  }
}

/**
 * Handle reset game message
 * @param {WebSocket} ws - WebSocket client
 * @param {object} data - Message data
 */
async function handleReset(ws, data) {
  const session = serverState.isRedisPrimaryMode
    ? await ensureGameLoaded(ws.gameId)
    : serverState.getSession(ws.gameId);

  if (!session) return;

  try {
    await withGameLock(ws.gameId, async () => {
      session.lastActivity = Date.now();
      session.reset();

      if (serverState.isRedisPrimaryMode) {
        await syncGameToRedis(ws.gameId);
      }

      logger.info({ gameId: ws.gameId }, "Game reset");
    });
  } catch (error) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: error.message } }));
    metrics.recordError("reset_lock_error");
  }
}

/**
 * Handle switch player message
 * @param {WebSocket} ws - WebSocket client
 * @param {object} data - Message data
 */
async function handleSwitch(ws, data) {
  const session = serverState.isRedisPrimaryMode
    ? await ensureGameLoaded(ws.gameId)
    : serverState.getSession(ws.gameId);

  if (!session) return;

  // Validate player ID
  if (data.playerId === undefined || data.playerId < 1 || data.playerId > CONSTANTS.MAX_PLAYERS) {
    return;
  }

  try {
    await withGameLock(ws.gameId, async () => {
      if (!session.canSwitchPlayer(data.playerId, ws.clientId)) {
        safeSend(
          ws,
          JSON.stringify({
            type: "error",
            data: { message: "Not authorized to switch players" },
          })
        );
        metrics.recordAuthDenied("switch");
        return;
      }

      session.lastActivity = Date.now();
      session.switchPlayer(data.playerId);
      // Note: Not syncing switch to Redis immediately for performance
      // Timer ticks are frequent - sync happens via periodic persistence
    });
  } catch (error) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: error.message } }));
    metrics.recordError("switch_lock_error");
  }
}

/**
 * Handle end game message (close lobby)
 * @param {WebSocket} ws - WebSocket client
 * @param {object} data - Message data
 */
async function handleEndGame(ws, data) {
  const session = serverState.isRedisPrimaryMode
    ? await ensureGameLoaded(ws.gameId)
    : serverState.getSession(ws.gameId);

  if (!session) return;

  try {
    await withGameLock(ws.gameId, async () => {
      session.lastActivity = Date.now();

      // Mark session as closed (will not be loaded on server restart)
      session.close();

      // Broadcast to all connected clients in this game
      if (serverState.wss) {
        serverState.wss.clients.forEach(client => {
          if (client.gameId === ws.gameId) {
            safeSend(
              client,
              JSON.stringify({
                type: "gameEnded",
                data: { gameId: ws.gameId },
              })
            );
          }
        });
      }

      // Delete from persistent storage entirely
      if (serverState.storage) {
        if (serverState.isAsyncStorageMode) {
          await serverState.storage.delete(ws.gameId);
        } else {
          serverState.storage.delete(ws.gameId);
        }
      }

      // Remove from in-memory sessions
      serverState.deleteSession(ws.gameId);

      logger.info({ gameId: ws.gameId, clientId: ws.clientId }, "Game lobby deleted");
    });
  } catch (error) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: error.message } }));
    metrics.recordError("endGame_lock_error");
  }
}

async function handleInterrupt(ws, data) {
  const session = serverState.isRedisPrimaryMode
    ? await ensureGameLoaded(ws.gameId)
    : serverState.getSession(ws.gameId);

  if (!session) return;

  try {
    await withGameLock(ws.gameId, async () => {
      const myPlayer = session.players.find(p => p.claimedBy === ws.clientId);
      if (!myPlayer) {
        safeSend(
          ws,
          JSON.stringify({
            type: "error",
            data: { message: "You must claim a player to interrupt" },
          })
        );
        return;
      }

      if (session.status !== "running") {
        safeSend(
          ws,
          JSON.stringify({
            type: "error",
            data: { message: "Game is not running" },
          })
        );
        return;
      }

      session.interrupt(myPlayer.id);

      if (serverState.isRedisPrimaryMode) {
        await syncGameToRedis(ws.gameId);
      }

      logger.info({ gameId: ws.gameId, playerId: myPlayer.id }, "Player interrupted");
    });
  } catch (error) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: error.message } }));
    metrics.recordError("interrupt_lock_error");
  }
}

async function handlePassPriority(ws, data) {
  const session = serverState.isRedisPrimaryMode
    ? await ensureGameLoaded(ws.gameId)
    : serverState.getSession(ws.gameId);

  if (!session) return;

  try {
    await withGameLock(ws.gameId, async () => {
      const myPlayer = session.players.find(p => p.claimedBy === ws.clientId);
      if (!myPlayer) {
        safeSend(
          ws,
          JSON.stringify({
            type: "error",
            data: { message: "You must claim a player to pass priority" },
          })
        );
        return;
      }

      if (!session.interruptingPlayers.includes(myPlayer.id)) {
        safeSend(
          ws,
          JSON.stringify({
            type: "error",
            data: { message: "You are not in the interrupt queue" },
          })
        );
        return;
      }

      session.passPriority(myPlayer.id);

      if (serverState.isRedisPrimaryMode) {
        await syncGameToRedis(ws.gameId);
      }

      logger.info({ gameId: ws.gameId, playerId: myPlayer.id }, "Player passed priority");
    });
  } catch (error) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: error.message } }));
    metrics.recordError("passPriority_lock_error");
  }
}

/**
 * Handle rename game message
 * @param {WebSocket} ws - WebSocket client
 * @param {object} data - Message data
 */
async function handleRenameGame(ws, data) {
  const session = serverState.isRedisPrimaryMode
    ? await ensureGameLoaded(ws.gameId)
    : serverState.getSession(ws.gameId);

  if (!session) return;

  try {
    await withGameLock(ws.gameId, async () => {
      session.lastActivity = Date.now();

      // Validate, sanitize, and truncate game name
      let newName = data.name?.trim() || "Game";
      newName = sanitizeString(newName);
      if (newName.length > CONSTANTS.MAX_GAME_NAME_LENGTH) {
        newName = newName.substring(0, CONSTANTS.MAX_GAME_NAME_LENGTH);
      }
      session.name = newName;

      // Broadcast name change to all clients
      session.broadcastState();

      // Sync to Redis if using Redis
      if (serverState.isRedisPrimaryMode) {
        await syncGameToRedis(ws.gameId);
      }

      // Send confirmation to the requester
      safeSend(
        ws,
        JSON.stringify({
          type: "gameRenamed",
          data: { name: newName },
        })
      );

      logger.info({ gameId: ws.gameId, clientId: ws.clientId, newName }, "Game renamed");
    });
  } catch (error) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: error.message } }));
    metrics.recordError("renameGame_lock_error");
  }
}

/**
 * Handle random start player selection
 * @param {WebSocket} ws - WebSocket client
 * @param {object} data - Message data
 */
async function handleRandomStartPlayer(ws, data) {
  const session = serverState.isRedisPrimaryMode
    ? await ensureGameLoaded(ws.gameId)
    : serverState.getSession(ws.gameId);

  if (!session) return;

  try {
    await withGameLock(ws.gameId, async () => {
      // Validate game state - can only select before game starts
      if (session.status !== "waiting") {
        safeSend(
          ws,
          JSON.stringify({
            type: "error",
            data: { message: "Can only select random player before game starts" },
          })
        );
        return;
      }

      // Get eligible players (claimed and not eliminated)
      const eligiblePlayers = session.players.filter(
        player => player.claimedBy && !player.isEliminated
      );

      if (eligiblePlayers.length === 0) {
        safeSend(
          ws,
          JSON.stringify({
            type: "error",
            data: { message: "No eligible players to select from" },
          })
        );
        return;
      }

      // Random selection
      const randomIndex = Math.floor(Math.random() * eligiblePlayers.length);
      const selectedPlayer = eligiblePlayers[randomIndex];
      session.activePlayer = selectedPlayer.id;
      session.lastActivity = Date.now();

      // Broadcast random player selected event to all clients
      if (serverState.wss) {
        serverState.wss.clients.forEach(client => {
          if (client.gameId === ws.gameId) {
            safeSend(
              client,
              JSON.stringify({
                type: "randomPlayerSelected",
                data: {
                  playerId: selectedPlayer.id,
                  playerName: selectedPlayer.name,
                },
              })
            );
          }
        });
      }

      // Also broadcast updated game state
      session.broadcastState();

      if (serverState.isRedisPrimaryMode) {
        await syncGameToRedis(ws.gameId);
      }

      logger.info(
        {
          gameId: ws.gameId,
          selectedPlayerId: selectedPlayer.id,
          selectedPlayerName: selectedPlayer.name,
        },
        "Random starting player selected"
      );
    });
  } catch (error) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: error.message } }));
    metrics.recordError("randomStartPlayer_lock_error");
  }
}

/**
 * Handle dice roll request
 * @param {WebSocket} ws - WebSocket client
 * @param {object} data - Message data containing sides
 */
async function handleRollDice(ws, data) {
  const session = serverState.isRedisPrimaryMode
    ? await ensureGameLoaded(ws.gameId)
    : serverState.getSession(ws.gameId);

  if (!session) return;

  const { sides } = data;

  // Validate sides parameter
  if (typeof sides !== "number" || !Number.isInteger(sides)) {
    safeSend(
      ws,
      JSON.stringify({
        type: "error",
        data: { message: "Dice sides must be an integer" },
      })
    );
    return;
  }

  if (sides < CONSTANTS.DICE_MIN_SIDES || sides > CONSTANTS.DICE_MAX_SIDES) {
    safeSend(
      ws,
      JSON.stringify({
        type: "error",
        data: {
          message: `Dice sides must be between ${CONSTANTS.DICE_MIN_SIDES} and ${CONSTANTS.DICE_MAX_SIDES}`,
        },
      })
    );
    return;
  }

  // Get player info
  const player = session.players.find(p => p.claimedBy === ws.clientId);
  const playerName = player?.name || "Unknown Player";

  // Generate random result (1 to sides inclusive)
  const result = Math.floor(Math.random() * sides) + 1;

  // Create roll data
  const rollData = {
    playerName,
    sides,
    result,
    timestamp: Date.now(),
  };

  // Broadcast to all clients in this game
  if (serverState.wss) {
    serverState.wss.clients.forEach(client => {
      if (client.gameId === ws.gameId) {
        safeSend(
          client,
          JSON.stringify({
            type: "diceRolled",
            data: rollData,
          })
        );
      }
    });
  }

  logger.info(
    {
      gameId: ws.gameId,
      playerName,
      sides,
      result,
    },
    "Dice rolled"
  );
}

/**
 * Handle roll for play order request
 * Rolls D20 for each player, handles ties, and reorders players
 * @param {WebSocket} ws - WebSocket client
 * @param {object} data - Message data
 */
async function handleRollPlayOrder(ws, data) {
  const session = serverState.isRedisPrimaryMode
    ? await ensureGameLoaded(ws.gameId)
    : serverState.getSession(ws.gameId);

  if (!session) return;

  try {
    await withGameLock(ws.gameId, async () => {
      // Validate game state - can only roll before game starts
      if (session.status !== "waiting") {
        safeSend(
          ws,
          JSON.stringify({
            type: "error",
            data: { message: "Can only roll for play order before game starts" },
          })
        );
        return;
      }

      // Get eligible players (claimed and not eliminated)
      const eligiblePlayers = session.players.filter(
        player => player.claimedBy && !player.isEliminated
      );

      if (eligiblePlayers.length < 2) {
        safeSend(
          ws,
          JSON.stringify({
            type: "error",
            data: { message: "Need at least 2 players to roll for play order" },
          })
        );
        return;
      }

      // Roll D20 for each player and resolve ties
      const rollResults = [];
      let playersToRoll = eligiblePlayers.map(p => ({ player: p, rolls: [] }));
      let round = 1;

      while (playersToRoll.length > 0) {
        // Roll for each player in this round
        for (const entry of playersToRoll) {
          const roll = Math.floor(Math.random() * 20) + 1;
          entry.rolls.push(roll);
          entry.currentRoll = roll;
        }

        // Sort by current roll (descending)
        playersToRoll.sort((a, b) => b.currentRoll - a.currentRoll);

        // Find groups with same roll (ties)
        const groups = [];
        let currentGroup = [playersToRoll[0]];

        for (let i = 1; i < playersToRoll.length; i++) {
          if (playersToRoll[i].currentRoll === currentGroup[0].currentRoll) {
            currentGroup.push(playersToRoll[i]);
          } else {
            groups.push(currentGroup);
            currentGroup = [playersToRoll[i]];
          }
        }
        groups.push(currentGroup);

        // Process groups - single players are resolved, ties need re-roll
        const resolvedThisRound = [];
        const needReroll = [];

        for (const group of groups) {
          if (group.length === 1) {
            resolvedThisRound.push(group[0]);
          } else {
            // Tie - need to re-roll
            needReroll.push(...group);
          }
        }

        // Add resolved players to results in order
        rollResults.push(...resolvedThisRound);

        // Continue with tied players
        playersToRoll = needReroll;
        round++;

        // Safety limit to prevent infinite loops
        if (round > 100) {
          // Just add remaining in current order
          rollResults.push(...playersToRoll);
          break;
        }
      }

      // Build the new player order based on roll results
      const newPlayerOrder = rollResults.map(entry => entry.player);

      // Reorder session.players array to match roll results
      // Keep unclaimed players at the end
      const unclaimedPlayers = session.players.filter(p => !p.claimedBy || p.isEliminated);
      session.players = [...newPlayerOrder, ...unclaimedPlayers];

      // Set first player as active
      if (newPlayerOrder.length > 0) {
        session.activePlayer = newPlayerOrder[0].id;
      }

      session.lastActivity = Date.now();

      // Build roll data for broadcast
      const rollData = rollResults.map((entry, index) => ({
        playerId: entry.player.id,
        playerName: entry.player.name,
        rolls: entry.rolls,
        finalRoll: entry.rolls[entry.rolls.length - 1],
        position: index + 1,
      }));

      // Broadcast play order results to all clients
      if (serverState.wss) {
        serverState.wss.clients.forEach(client => {
          if (client.gameId === ws.gameId) {
            safeSend(
              client,
              JSON.stringify({
                type: "playOrderRolled",
                data: {
                  rolls: rollData,
                  newOrder: newPlayerOrder.map(p => p.id),
                },
              })
            );
          }
        });
      }

      // Broadcast updated game state
      session.broadcastState();

      if (serverState.isRedisPrimaryMode) {
        await syncGameToRedis(ws.gameId);
      }

      logger.info(
        {
          gameId: ws.gameId,
          rollResults: rollData,
        },
        "Play order rolled"
      );
    });
  } catch (error) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: error.message } }));
    metrics.recordError("rollPlayOrder_lock_error");
  }
}

/**
 * Handle admin revive player request
 * @param {WebSocket} ws - WebSocket client
 * @param {object} data - Message data containing playerId
 */
async function handleAdminRevive(ws, data) {
  const session = serverState.isRedisPrimaryMode
    ? await ensureGameLoaded(ws.gameId)
    : serverState.getSession(ws.gameId);

  if (!session) return;

  const { playerId } = data;

  // Validate player ID
  if (playerId === undefined || playerId < 1 || playerId > CONSTANTS.MAX_PLAYERS) {
    return;
  }

  try {
    await withGameLock(ws.gameId, async () => {
      // Allow any player who has claimed a slot to use admin controls
      const hasClaimedPlayer = session.players.some(p => p.claimedBy === ws.clientId);
      if (!hasClaimedPlayer) {
        safeSend(
          ws,
          JSON.stringify({
            type: "error",
            data: { message: "You must claim a player to use admin controls" },
          })
        );
        metrics.recordAuthDenied("adminRevive");
        return;
      }

      session.lastActivity = Date.now();
      session.revivePlayer(playerId);

      if (serverState.isRedisPrimaryMode) {
        await syncGameToRedis(ws.gameId);
      }

      logger.info({ gameId: ws.gameId, playerId }, "Player revived by admin");
    });
  } catch (error) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: error.message } }));
    metrics.recordError("adminRevive_lock_error");
  }
}

/**
 * Handle admin kick player request
 * @param {WebSocket} ws - WebSocket client
 * @param {object} data - Message data containing playerId
 */
async function handleAdminKick(ws, data) {
  const session = serverState.isRedisPrimaryMode
    ? await ensureGameLoaded(ws.gameId)
    : serverState.getSession(ws.gameId);

  if (!session) return;

  const { playerId } = data;

  // Validate player ID
  if (playerId === undefined || playerId < 1 || playerId > CONSTANTS.MAX_PLAYERS) {
    return;
  }

  try {
    await withGameLock(ws.gameId, async () => {
      // Allow any player who has claimed a slot to use admin controls
      const hasClaimedPlayer = session.players.some(p => p.claimedBy === ws.clientId);
      if (!hasClaimedPlayer) {
        safeSend(
          ws,
          JSON.stringify({
            type: "error",
            data: { message: "You must claim a player to use admin controls" },
          })
        );
        metrics.recordAuthDenied("adminKick");
        return;
      }

      session.lastActivity = Date.now();

      // Notify the kicked client
      const notifyClient = (clientId) => {
        if (serverState.wss) {
          serverState.wss.clients.forEach(client => {
            if (client.clientId === clientId) {
              safeSend(client, JSON.stringify({ type: "kicked", data: {} }));
            }
          });
        }
      };

      session.kickPlayer(playerId, notifyClient);

      if (serverState.isRedisPrimaryMode) {
        await syncGameToRedis(ws.gameId);
      }

      logger.info({ gameId: ws.gameId, playerId }, "Player kicked by admin");
    });
  } catch (error) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: error.message } }));
    metrics.recordError("adminKick_lock_error");
  }
}

/**
 * Handle admin add time request
 * @param {WebSocket} ws - WebSocket client
 * @param {object} data - Message data containing playerId and minutes
 */
async function handleAdminAddTime(ws, data) {
  const session = serverState.isRedisPrimaryMode
    ? await ensureGameLoaded(ws.gameId)
    : serverState.getSession(ws.gameId);

  if (!session) return;

  const { playerId, minutes } = data;

  // Validate player ID
  if (playerId === undefined || playerId < 1 || playerId > CONSTANTS.MAX_PLAYERS) {
    return;
  }

  // Validate minutes (1-60)
  if (typeof minutes !== "number" || minutes < 1 || minutes > 60) {
    safeSend(
      ws,
      JSON.stringify({
        type: "error",
        data: { message: "Minutes must be between 1 and 60" },
      })
    );
    return;
  }

  try {
    await withGameLock(ws.gameId, async () => {
      // Allow any player who has claimed a slot to use admin controls
      const hasClaimedPlayer = session.players.some(p => p.claimedBy === ws.clientId);
      if (!hasClaimedPlayer) {
        safeSend(
          ws,
          JSON.stringify({
            type: "error",
            data: { message: "You must claim a player to use admin controls" },
          })
        );
        metrics.recordAuthDenied("adminAddTime");
        return;
      }

      session.lastActivity = Date.now();
      const milliseconds = minutes * 60 * 1000;
      session.addTimeToPlayer(playerId, milliseconds);

      if (serverState.isRedisPrimaryMode) {
        await syncGameToRedis(ws.gameId);
      }

      logger.info({ gameId: ws.gameId, playerId, minutes }, "Time added by admin");
    });
  } catch (error) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: error.message } }));
    metrics.recordError("adminAddTime_lock_error");
  }
}

/**
 * Handle timeout choice from player
 * @param {WebSocket} ws - WebSocket client
 * @param {object} data - Message data containing choice
 */
async function handleTimeoutChoice(ws, data) {
  const session = serverState.isRedisPrimaryMode
    ? await ensureGameLoaded(ws.gameId)
    : serverState.getSession(ws.gameId);

  if (!session) return;

  const { choice } = data;

  // Validate choice
  if (!["loseLives", "gainDrunk", "die"].includes(choice)) {
    safeSend(
      ws,
      JSON.stringify({
        type: "error",
        data: { message: "Invalid timeout choice" },
      })
    );
    return;
  }

  try {
    await withGameLock(ws.gameId, async () => {
      // Find the player making the choice
      const player = session.players.find(p => p.claimedBy === ws.clientId);
      if (!player) {
        safeSend(
          ws,
          JSON.stringify({
            type: "error",
            data: { message: "You must claim a player" },
          })
        );
        return;
      }

      if (!player.timeoutPending) {
        safeSend(
          ws,
          JSON.stringify({
            type: "error",
            data: { message: "No pending timeout choice" },
          })
        );
        return;
      }

      session.lastActivity = Date.now();
      session.resolveTimeoutChoice(player.id, choice);

      if (serverState.isRedisPrimaryMode) {
        await syncGameToRedis(ws.gameId);
      }

      logger.info({ gameId: ws.gameId, playerId: player.id, choice }, "Timeout choice made");
    });
  } catch (error) {
    safeSend(ws, JSON.stringify({ type: "error", data: { message: error.message } }));
    metrics.recordError("timeoutChoice_lock_error");
  }
}

module.exports = {
  start: handleStart,
  pause: handlePause,
  reset: handleReset,
  switch: handleSwitch,
  endGame: handleEndGame,
  renameGame: handleRenameGame,
  interrupt: handleInterrupt,
  passPriority: handlePassPriority,
  randomStartPlayer: handleRandomStartPlayer,
  rollDice: handleRollDice,
  rollPlayOrder: handleRollPlayOrder,
  adminRevive: handleAdminRevive,
  adminKick: handleAdminKick,
  adminAddTime: handleAdminAddTime,
  timeoutChoice: handleTimeoutChoice,
};
