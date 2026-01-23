let ws;
let gameState = null;
let audioEnabled = true;
let audioContext;
let reconnectAttempts = 0;
let reconnectTimeout = null;
const volume = 0.5;
let myClientId = null;
let pendingReconnect = null; // Track pending reconnection attempt for token cleanup on failure

const CONSTANTS = {
  RECONNECT_INITIAL_DELAY: 1000,
  RECONNECT_MAX_DELAY: 30000,
  TIME_ADJUSTMENT_MINUTES: 1,
  TIME_ADJUSTMENT_MS: 60000,
  WARNING_THRESHOLD_5MIN: 300000,
  WARNING_THRESHOLD_1MIN: 60000,
  CRITICAL_THRESHOLD: 60000,
  MINUTE_MS: 60000,
  TOKEN_STORAGE_KEY: "tapOrTarpReconnectTokens",
  TOKEN_MAX_AGE: 60 * 60 * 1000, // 1 hour
};

// ============================================================================
// RECONNECTION TOKEN MANAGEMENT
// ============================================================================

/**
 * Save a reconnection token for a game/player combination
 * @param {string} gameId - Game session ID
 * @param {number} playerId - Player ID
 * @param {string} token - Reconnection token
 */
function saveReconnectToken(gameId, playerId, token) {
  try {
    const tokens = JSON.parse(localStorage.getItem(CONSTANTS.TOKEN_STORAGE_KEY) || "{}");
    tokens[`${gameId}-${playerId}`] = {
      token,
      gameId,
      playerId,
      timestamp: Date.now(),
    };
    // Clean up expired tokens while we're here
    cleanupExpiredTokens(tokens);
    localStorage.setItem(CONSTANTS.TOKEN_STORAGE_KEY, JSON.stringify(tokens));
  } catch (e) {
    console.error("Failed to save reconnect token:", e);
  }
}

/**
 * Get a reconnection token for a game/player combination
 * Used by attemptStoredReconnection via getAllReconnectTokens
 * @param {string} gameId - Game session ID
 * @param {number} playerId - Player ID
 * @returns {{ token: string, gameId: string, playerId: number } | null}
 */
// eslint-disable-next-line no-unused-vars
function getReconnectToken(gameId, playerId) {
  try {
    const tokens = JSON.parse(localStorage.getItem(CONSTANTS.TOKEN_STORAGE_KEY) || "{}");
    const data = tokens[`${gameId}-${playerId}`];
    if (data && Date.now() - data.timestamp < CONSTANTS.TOKEN_MAX_AGE) {
      return data;
    }
    return null;
  } catch (e) {
    console.error("Failed to get reconnect token:", e);
    return null;
  }
}

/**
 * Get all valid reconnection tokens (for attempting reconnection on page load)
 * @returns {Array<{ token: string, gameId: string, playerId: number }>}
 */
function getAllReconnectTokens() {
  try {
    const tokens = JSON.parse(localStorage.getItem(CONSTANTS.TOKEN_STORAGE_KEY) || "{}");
    const now = Date.now();
    return Object.values(tokens).filter(data => now - data.timestamp < CONSTANTS.TOKEN_MAX_AGE);
  } catch (e) {
    console.error("Failed to get reconnect tokens:", e);
    return [];
  }
}

/**
 * Clear a reconnection token for a specific game/player
 * @param {string} gameId - Game session ID
 * @param {number} playerId - Player ID
 */
function clearReconnectToken(gameId, playerId) {
  try {
    const tokens = JSON.parse(localStorage.getItem(CONSTANTS.TOKEN_STORAGE_KEY) || "{}");
    delete tokens[`${gameId}-${playerId}`];
    localStorage.setItem(CONSTANTS.TOKEN_STORAGE_KEY, JSON.stringify(tokens));
    console.log(`Cleared reconnect token for game ${gameId}, player ${playerId}`);
  } catch (e) {
    console.error("Failed to clear reconnect token:", e);
  }
}

/**
 * Clear all reconnection tokens for a specific game
 * Used when leaving a game entirely
 * @param {string} gameId - Game session ID
 */
function clearGameTokens(gameId) {
  try {
    const tokens = JSON.parse(localStorage.getItem(CONSTANTS.TOKEN_STORAGE_KEY) || "{}");
    let cleared = 0;
    for (const key of Object.keys(tokens)) {
      if (tokens[key].gameId === gameId) {
        delete tokens[key];
        cleared++;
      }
    }
    localStorage.setItem(CONSTANTS.TOKEN_STORAGE_KEY, JSON.stringify(tokens));
    if (cleared > 0) {
      console.log(`Cleared ${cleared} reconnect token(s) for game ${gameId}`);
    }
  } catch (e) {
    console.error("Failed to clear game tokens:", e);
  }
}

/**
 * Clean up expired tokens from storage
 * @param {object} tokens - Token storage object
 */
function cleanupExpiredTokens(tokens) {
  const now = Date.now();
  for (const key of Object.keys(tokens)) {
    if (now - tokens[key].timestamp >= CONSTANTS.TOKEN_MAX_AGE) {
      delete tokens[key];
    }
  }
}

// Screen elements
const screens = {
  mainMenu: document.getElementById("main-menu-screen"),
  casualSetup: document.getElementById("casual-setup-screen"),
  joinScreen: document.getElementById("join-screen"),
  campaignScreen: document.getElementById("campaign-screen"),
  loadScreen: document.getElementById("load-screen"),
  menuSettings: document.getElementById("menu-settings-screen"),
  game: document.getElementById("game-screen"),
};

const playersContainer = document.getElementById("players-container");
const gameCodeDisplay = document.getElementById("game-code-display");

// Main menu buttons
const menuButtons = {
  casual: document.getElementById("menu-casual-btn"),
  campaign: document.getElementById("menu-campaign-btn"),
  join: document.getElementById("menu-join-btn"),
  load: document.getElementById("menu-load-btn"),
  settings: document.getElementById("menu-settings-btn"),
};

// Back buttons
const backButtons = {
  casual: document.getElementById("casual-back-btn"),
  join: document.getElementById("join-back-btn"),
  campaign: document.getElementById("campaign-back-btn"),
  load: document.getElementById("load-back-btn"),
  menuSettings: document.getElementById("menu-settings-back-btn"),
};

// Menu settings
const menuSettingsForm = {
  muteCheckbox: document.getElementById("menu-mute-checkbox"),
  save: document.getElementById("menu-settings-save-btn"),
};

const setupForm = {
  playerCount: document.getElementById("player-count"),
  initialTime: document.getElementById("initial-time"),
  joinGame: document.getElementById("join-game"),
  createGame: document.getElementById("create-game"),
  joinBtn: document.getElementById("join-btn"),
};

const controls = {
  start: document.getElementById("start-btn"),
  passTurn: document.getElementById("pass-turn-btn"),
  pause: document.getElementById("pause-btn"),
  reset: document.getElementById("reset-btn"),
  settings: document.getElementById("settings-btn"),

  backToMenu: document.getElementById("back-to-menu-btn"),
};

const settingsModal = {
  modal: document.getElementById("settings-modal"),
  thresholdsContainer: document.getElementById("thresholds-container"),
  addThresholdBtn: document.getElementById("add-threshold-btn"),
  playerColorsContainer: document.getElementById("player-colors-container"),
  save: document.getElementById("save-settings"),
  close: document.getElementById("close-settings"),
};

const colorPickerModal = {
  modal: document.getElementById("color-picker-modal"),
  options: document.getElementById("color-options"),
  cancel: document.getElementById("cancel-color-picker"),
};

// Available player colors
const PLAYER_COLORS = [
  { id: "red", name: "Red", primary: "#dc3c3c", secondary: "#b42828" },
  { id: "blue", name: "Blue", primary: "#3c78dc", secondary: "#2864c8" },
  { id: "green", name: "Green", primary: "#32a032", secondary: "#1e821e" },
  { id: "yellow", name: "Yellow", primary: "#e6d23c", secondary: "#c8b428" },
  { id: "purple", name: "Purple", primary: "#8c3cc8", secondary: "#6e28aa" },
  { id: "cyan", name: "Cyan", primary: "#3cbebe", secondary: "#28a0a0" },
  { id: "orange", name: "Orange", primary: "#ff8228", secondary: "#dc6414" },
  { id: "pink", name: "Pink", primary: "#e650a0", secondary: "#c83c82" },
  { id: "lime", name: "Lime", primary: "#96dc32", secondary: "#78be14" },
  { id: "teal", name: "Teal", primary: "#32a096", secondary: "#1e8278" },
  { id: "indigo", name: "Indigo", primary: "#5050dc", secondary: "#3c3cc8" },
  { id: "amber", name: "Amber", primary: "#ffc814", secondary: "#e6aa00" },
];

let selectedPlayerForColor = null;

const timeoutModal = {
  modal: document.getElementById("timeout-modal"),
  message: document.getElementById("timeout-message"),
  acknowledge: document.getElementById("acknowledge-timeout"),
};

function initAudio() {
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
}

function playTone(frequency, duration, type = "sine") {
  if (!audioEnabled || !audioContext) return;

  const oscillator = audioContext.createOscillator();
  const gainNode = audioContext.createGain();

  oscillator.connect(gainNode);
  gainNode.connect(audioContext.destination);

  oscillator.frequency.value = frequency;
  oscillator.type = type;

  gainNode.gain.setValueAtTime(0.3 * volume, audioContext.currentTime);
  gainNode.gain.exponentialRampToValueAtTime(0.01 * volume, audioContext.currentTime + duration);

  oscillator.start(audioContext.currentTime);
  oscillator.stop(audioContext.currentTime + duration);
}

function playWarning(threshold) {
  const thresholdMinutes = threshold / CONSTANTS.MINUTE_MS;
  if (thresholdMinutes >= 5) {
    playTone(440, 0.5);
  } else if (thresholdMinutes >= 1) {
    playTone(440, 0.25);
    setTimeout(() => playTone(440, 0.25), 300);
  } else {
    playTone(440, 0.15);
    setTimeout(() => playTone(440, 0.15), 150);
    setTimeout(() => playTone(440, 0.15), 300);
  }
}

function playTimeout() {
  playTone(200, 0.5, "square");
  setTimeout(() => playTone(200, 0.5, "square"), 500);
  setTimeout(() => playTone(200, 0.5, "square"), 1000);
  setTimeout(() => playTone(200, 1.0, "square"), 1500);
}

function playClick() {
  playTone(600, 0.1);
}

function playPauseResume() {
  playTone(523.25, 0.15);
  setTimeout(() => playTone(659.25, 0.15), 100);
}

// Get the player ID claimed by this client (used for future features)
// eslint-disable-next-line no-unused-vars
function getMyPlayerId() {
  if (!gameState || !myClientId) return null;
  const myPlayer = gameState.players.find(p => p.claimedBy === myClientId);
  return myPlayer ? myPlayer.id : null;
}

function connect() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${window.location.host}`);

  ws.onopen = () => {
    console.log("Connected to server");
    reconnectAttempts = 0;
  };

  ws.onmessage = event => {
    try {
      const message = JSON.parse(event.data);
      handleMessage(message);
    } catch (e) {
      console.error("Invalid JSON received:", e.message);
    }
  };

  ws.onclose = () => {
    console.log("Disconnected from server");
    const delay = Math.min(
      CONSTANTS.RECONNECT_INITIAL_DELAY * Math.pow(2, reconnectAttempts),
      CONSTANTS.RECONNECT_MAX_DELAY
    );
    reconnectAttempts++;
    console.log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    reconnectTimeout = setTimeout(connect, delay);
  };

  ws.onerror = error => {
    console.error("WebSocket error:", error);
  };
}

function handleMessage(message) {
  switch (message.type) {
    case "clientId":
      myClientId = message.data.clientId;
      // Try to reconnect to any stored games
      attemptStoredReconnection();
      break;
    case "error":
      // If this error is from a failed reconnection attempt, clear the invalid token
      if (pendingReconnect) {
        console.log(
          `Reconnection failed for game ${pendingReconnect.gameId}, player ${pendingReconnect.playerId}: ${message.data.message}`
        );
        clearReconnectToken(pendingReconnect.gameId, pendingReconnect.playerId);
        pendingReconnect = null;
      }
      alert(message.data.message);
      break;
    case "state":
      gameState = message.data;
      renderGame();
      break;
    case "tick":
      if (gameState) {
        gameState.players.forEach(player => {
          if (message.data.times[player.id] !== undefined) {
            player.timeRemaining = message.data.times[player.id];
          }
        });
        updateTimes();
      }
      break;
    case "timeout":
      if (gameState) {
        const player = gameState.players.find(p => p.id === message.data.playerId);
        if (player) {
          showTimeoutModal(player);
          playTimeout();
        }
      }
      break;
    case "warning":
      if (gameState) {
        const player = gameState.players.find(p => p.id === message.data.playerId);
        if (player && player.id === gameState.activePlayer) {
          playWarning(message.data.threshold);
        }
      }
      break;
    case "claimed":
      // Store the reconnection token for this player
      saveReconnectToken(message.data.gameId, message.data.playerId, message.data.token);
      console.log(`Reconnection token saved for player ${message.data.playerId}`);
      break;
    case "reconnected":
      // Clear pending reconnect tracker
      pendingReconnect = null;
      // Update stored token with new one
      saveReconnectToken(message.data.gameId, message.data.playerId, message.data.token);
      console.log(`Reconnected to game ${message.data.gameId} as player ${message.data.playerId}`);
      // Switch to game screen if not already there
      showScreen("game");
      break;
  }
}

/**
 * Attempt to reconnect to any stored games on page load
 */
function attemptStoredReconnection() {
  const tokens = getAllReconnectTokens();
  if (tokens.length === 0) return;

  // Try the most recent token first
  const sortedTokens = tokens.sort((a, b) => b.timestamp - a.timestamp);
  const mostRecent = sortedTokens[0];

  console.log(
    `Attempting reconnection to game ${mostRecent.gameId} as player ${mostRecent.playerId}`
  );

  // Track the pending reconnection so we can clear the token if it fails
  pendingReconnect = {
    gameId: mostRecent.gameId,
    playerId: mostRecent.playerId,
  };

  ws.send(
    JSON.stringify({
      type: "reconnect",
      data: {
        gameId: mostRecent.gameId,
        playerId: mostRecent.playerId,
        token: mostRecent.token,
      },
    })
  );
}

function formatTime(milliseconds) {
  if (milliseconds <= 0) return "0:00";

  const totalSeconds = Math.ceil(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatTimeWithDeciseconds(milliseconds) {
  if (milliseconds <= 0) return "0:00.0";

  const totalSeconds = milliseconds / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const deciseconds = Math.floor((milliseconds % 1000) / 100);

  return `${minutes}:${seconds.toString().padStart(2, "0")}.${deciseconds}`;
}

function createPlayerCard(player, isActive) {
  const card = document.createElement("div");
  card.className = "player-card";
  card.dataset.playerId = player.id;

  const isMyPlayer = player.claimedBy && player.claimedBy === myClientId;
  const isClaimed = player.claimedBy != null; // using != to catch both null and undefined
  const isWaiting = gameState.status === "waiting";

  // Apply custom player color
  const playerColor = getPlayerColor(player);
  card.style.setProperty("--player-primary", playerColor.primary);
  card.style.setProperty("--player-secondary", playerColor.secondary);
  card.classList.add("custom-color");

  if (player.isEliminated) {
    card.classList.add("eliminated");
    const deadBanner = document.createElement("div");
    deadBanner.className = "dead-banner";
    deadBanner.textContent = "DEAD";
    card.appendChild(deadBanner);
  }

  if (isActive) {
    card.classList.add("active");
  }

  if (isMyPlayer) {
    card.classList.add("my-player");
  }

  if (isClaimed && !isMyPlayer) {
    card.classList.add("claimed-other");
  }

  if (isWaiting) {
    card.classList.add("selectable");
  }

  if (gameState.status === "paused" && isActive) {
    card.classList.add("paused");
  }

  if (player.timeRemaining < CONSTANTS.CRITICAL_THRESHOLD) {
    card.classList.add("critical");
  } else if (player.timeRemaining < CONSTANTS.WARNING_THRESHOLD_5MIN) {
    card.classList.add("warning");
  }

  if (player.timeRemaining === 0 && !player.isEliminated) {
    card.classList.add("timeout");
  }

  const nameContainer = document.createElement("div");
  nameContainer.className = "player-name";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.value = player.name;
  nameInput.addEventListener("change", e => {
    sendUpdatePlayer(player.id, { name: e.target.value });
  });
  nameInput.addEventListener("click", e => {
    e.stopPropagation();
  });

  const statusSpan = document.createElement("span");
  statusSpan.className = "status-badges";

  if (isMyPlayer) {
    const youIndicator = document.createElement("span");
    youIndicator.className = "you-indicator";
    youIndicator.textContent = "YOU";
    statusSpan.appendChild(youIndicator);
  } else if (isClaimed && isWaiting) {
    const claimedIndicator = document.createElement("span");
    claimedIndicator.className = "claimed-indicator";
    claimedIndicator.textContent = "TAKEN";
    statusSpan.appendChild(claimedIndicator);
  } else if (isWaiting && !isClaimed) {
    const selectIndicator = document.createElement("span");
    selectIndicator.className = "select-indicator";
    selectIndicator.textContent = "TAP TO SELECT";
    statusSpan.appendChild(selectIndicator);
  }

  if (isActive) {
    const activeIndicator = document.createElement("span");
    activeIndicator.className = "active-indicator";
    activeIndicator.textContent = "ACTIVE";
    statusSpan.appendChild(activeIndicator);
  }

  nameContainer.appendChild(nameInput);
  nameContainer.appendChild(statusSpan);
  card.appendChild(nameContainer);

  const timeDisplay = document.createElement("div");
  timeDisplay.className = "player-time";
  if (player.timeRemaining < CONSTANTS.CRITICAL_THRESHOLD) {
    timeDisplay.classList.add("deciseconds");
    timeDisplay.textContent = formatTimeWithDeciseconds(player.timeRemaining);
  } else {
    timeDisplay.textContent = formatTime(player.timeRemaining);
  }
  card.appendChild(timeDisplay);

  // Life total section
  const lifeSection = document.createElement("div");
  lifeSection.className = "life-section";

  const lifeLabel = document.createElement("span");
  lifeLabel.className = "life-label";
  lifeLabel.textContent = "Life";

  const lifeControls = document.createElement("div");
  lifeControls.className = "life-controls";

  const lifeDown = document.createElement("button");
  lifeDown.className = "btn btn-counter";
  lifeDown.textContent = "-";
  lifeDown.addEventListener("click", e => {
    e.stopPropagation();
    sendUpdatePlayer(player.id, { life: player.life - 1 });
  });

  const lifeDisplay = document.createElement("span");
  lifeDisplay.className = "life-display";
  lifeDisplay.textContent = player.life;

  const lifeUp = document.createElement("button");
  lifeUp.className = "btn btn-counter";
  lifeUp.textContent = "+";
  lifeUp.addEventListener("click", e => {
    e.stopPropagation();
    sendUpdatePlayer(player.id, { life: player.life + 1 });
  });

  lifeControls.appendChild(lifeDown);
  lifeControls.appendChild(lifeDisplay);
  lifeControls.appendChild(lifeUp);
  lifeSection.appendChild(lifeLabel);
  lifeSection.appendChild(lifeControls);
  card.appendChild(lifeSection);

  // Counters section
  const countersSection = document.createElement("div");
  countersSection.className = "counters-section";

  // Drunk counter
  const drunkCounter = document.createElement("div");
  drunkCounter.className = "counter drunk-counter";

  const drunkIcon = document.createElement("span");
  drunkIcon.className = "counter-icon drunk-icon";
  drunkIcon.innerHTML =
    '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M7.5 7l-2-2h13l-2 2h-9zm7 5.5c0 1.38-1.12 2.5-2.5 2.5s-2.5-1.12-2.5-2.5S10.62 10 12 10s2.5 1.12 2.5 2.5zM8 18h8v1H8v-1zm3-11v2.26c-1.81.47-3 2.09-3 3.99 0 2.29 1.71 4.25 4 4.71V19c0 .55.45 1 1 1s1-.45 1-1v-1.04c2.29-.46 4-2.42 4-4.71 0-1.9-1.19-3.52-3-3.99V7h-4z"/></svg>';

  const drunkControls = document.createElement("div");
  drunkControls.className = "counter-controls";

  const drunkDown = document.createElement("button");
  drunkDown.className = "btn btn-counter-sm";
  drunkDown.textContent = "-";
  drunkDown.addEventListener("click", e => {
    e.stopPropagation();
    sendUpdatePlayer(player.id, { drunkCounter: Math.max(0, player.drunkCounter - 1) });
  });

  const drunkDisplay = document.createElement("span");
  drunkDisplay.className = "counter-display";
  drunkDisplay.textContent = player.drunkCounter;

  const drunkUp = document.createElement("button");
  drunkUp.className = "btn btn-counter-sm";
  drunkUp.textContent = "+";
  drunkUp.addEventListener("click", e => {
    e.stopPropagation();
    sendUpdatePlayer(player.id, { drunkCounter: player.drunkCounter + 1 });
  });

  drunkControls.appendChild(drunkDown);
  drunkControls.appendChild(drunkDisplay);
  drunkControls.appendChild(drunkUp);
  drunkCounter.appendChild(drunkIcon);
  drunkCounter.appendChild(drunkControls);

  // Generic counter
  const genericCounterEl = document.createElement("div");
  genericCounterEl.className = "counter generic-counter";

  const genericIcon = document.createElement("span");
  genericIcon.className = "counter-icon generic-icon";
  genericIcon.innerHTML =
    '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/><text x="12" y="16" text-anchor="middle" fill="currentColor" font-size="12" font-weight="bold">#</text></svg>';

  const genericControls = document.createElement("div");
  genericControls.className = "counter-controls";

  const genericDown = document.createElement("button");
  genericDown.className = "btn btn-counter-sm";
  genericDown.textContent = "-";
  genericDown.addEventListener("click", e => {
    e.stopPropagation();
    sendUpdatePlayer(player.id, { genericCounter: Math.max(0, player.genericCounter - 1) });
  });

  const genericDisplay = document.createElement("span");
  genericDisplay.className = "counter-display";
  genericDisplay.textContent = player.genericCounter;

  const genericUp = document.createElement("button");
  genericUp.className = "btn btn-counter-sm";
  genericUp.textContent = "+";
  genericUp.addEventListener("click", e => {
    e.stopPropagation();
    sendUpdatePlayer(player.id, { genericCounter: player.genericCounter + 1 });
  });

  genericControls.appendChild(genericDown);
  genericControls.appendChild(genericDisplay);
  genericControls.appendChild(genericUp);
  genericCounterEl.appendChild(genericIcon);
  genericCounterEl.appendChild(genericControls);

  countersSection.appendChild(drunkCounter);
  countersSection.appendChild(genericCounterEl);
  card.appendChild(countersSection);

  // Click to claim/unclaim in waiting phase
  card.addEventListener("click", () => {
    if (isWaiting) {
      if (isMyPlayer) {
        sendUnclaim();
      } else if (!isClaimed) {
        sendClaim(player.id);
      }
      playClick();
    }
  });

  // Right-click also works for claiming
  card.addEventListener("contextmenu", e => {
    e.preventDefault();
    if (isWaiting) {
      if (isMyPlayer) {
        sendUnclaim();
      } else if (!isClaimed) {
        sendClaim(player.id);
      }
      playClick();
    }
  });

  return card;
}

function renderGame() {
  if (!gameState) return;

  hideAllScreens();
  screens.game.style.display = "block";
  gameCodeDisplay.textContent = gameState.id;

  // Show/hide lobby banner based on game status and player selection
  const lobbyBanner = document.getElementById("lobby-banner");
  const hasClaimedPlayer = gameState.players.some(p => p.claimedBy === myClientId);
  if (gameState.status === "waiting" && !hasClaimedPlayer) {
    lobbyBanner.style.display = "block";
    screens.game.classList.add("lobby-mode");
  } else {
    lobbyBanner.style.display = "none";
    screens.game.classList.remove("lobby-mode");
  }

  playersContainer.innerHTML = "";
  playersContainer.className = `players-${gameState.players.length}`;

  gameState.players.forEach(player => {
    const isActive = player.id === gameState.activePlayer;
    const card = createPlayerCard(player, isActive);
    playersContainer.appendChild(card);
  });

  updateControls();
}

function updateTimes() {
  if (!gameState) return;

  const cards = playersContainer.querySelectorAll(".player-card");
  cards.forEach(card => {
    const playerId = parseInt(card.dataset.playerId);
    const player = gameState.players.find(p => p.id === playerId);

    if (player) {
      const timeDisplay = card.querySelector(".player-time");

      if (player.timeRemaining < CONSTANTS.CRITICAL_THRESHOLD) {
        timeDisplay.classList.add("deciseconds");
        timeDisplay.textContent = formatTimeWithDeciseconds(player.timeRemaining);
      } else {
        timeDisplay.classList.remove("deciseconds");
        timeDisplay.textContent = formatTime(player.timeRemaining);
      }

      card.classList.remove("warning", "critical", "timeout");

      if (player.timeRemaining === 0 && !player.isEliminated) {
        card.classList.add("timeout");
      } else if (player.timeRemaining < CONSTANTS.CRITICAL_THRESHOLD) {
        card.classList.add("critical");
      } else if (player.timeRemaining < CONSTANTS.WARNING_THRESHOLD_5MIN) {
        card.classList.add("warning");
      }
    }
  });
}

function updateControls() {
  if (!gameState) return;

  controls.pause.textContent = gameState.status === "paused" ? "Resume" : "Pause";

  // Check if current client is the active player
  const activePlayer = gameState.players.find(p => p.id === gameState.activePlayer);
  const isActivePlayer = activePlayer && activePlayer.claimedBy === myClientId;

  // Check if all players are claimed
  const allPlayersClaimed = gameState.players.every(p => p.claimedBy !== null);

  if (gameState.status === "waiting") {
    controls.start.style.display = "inline-block";
    controls.start.disabled = !allPlayersClaimed;
    controls.start.title = allPlayersClaimed ? "" : "All players must be claimed before starting";
    controls.passTurn.style.display = "none";
  } else {
    controls.start.style.display = "none";
    controls.passTurn.style.display = "inline-block";
    controls.passTurn.disabled = !isActivePlayer;
  }
}

function safeSend(message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(message));
    } catch (e) {
      console.error("Failed to send message:", e.message);
      alert("Failed to send message. Please try again.");
    }
  } else {
    console.error("WebSocket not connected. State:", ws ? ws.readyState : "no socket");
    alert("Not connected to server. Please wait and try again.");
  }
}

function sendCreateGame(settings) {
  safeSend({ type: "create", data: { settings } });
}

function sendJoinGame(gameId) {
  safeSend({ type: "join", data: { gameId } });
}

function sendStart() {
  safeSend({ type: "start" });
}

function sendPause() {
  safeSend({ type: "pause" });
}

function sendReset() {
  safeSend({ type: "reset" });
}

function sendSwitchPlayer(playerId) {
  safeSend({ type: "switch", data: { playerId } });
}

function sendPassTurn() {
  if (!gameState || gameState.players.length <= 1) return;

  // Only the active player can pass the turn
  const activePlayer = gameState.players.find(p => p.id === gameState.activePlayer);
  if (!activePlayer || activePlayer.claimedBy !== myClientId) return;

  const activeIndex = gameState.players.findIndex(p => p.id === gameState.activePlayer);
  let nextPlayer;
  let offset = 1;
  do {
    const nextIndex = (activeIndex + offset) % gameState.players.length;
    nextPlayer = gameState.players[nextIndex];
    offset++;
  } while (nextPlayer.isEliminated && offset <= gameState.players.length);

  if (!nextPlayer.isEliminated) {
    sendSwitchPlayer(nextPlayer.id);
    playClick();
  }
}

function sendUpdatePlayer(playerId, updates) {
  safeSend({ type: "updatePlayer", data: { playerId, ...updates } });
}

function sendUpdateSettings(settings) {
  safeSend({ type: "updateSettings", data: settings });
}

function sendClaim(playerId) {
  safeSend({ type: "claim", data: { playerId } });
}

function sendUnclaim() {
  // Clear the reconnection token for the player we're unclaiming
  if (gameState && myClientId) {
    const myPlayer = gameState.players.find(p => p.claimedBy === myClientId);
    if (myPlayer) {
      clearReconnectToken(gameState.id, myPlayer.id);
    }
  }
  safeSend({ type: "unclaim", data: {} });
}

function showTimeoutModal(player) {
  timeoutModal.message.textContent = `${player.name} has run out of time!`;
  timeoutModal.modal.style.display = "flex";
}

function hideTimeoutModal() {
  timeoutModal.modal.style.display = "none";
}

function showSettingsModal() {
  // Populate thresholds from game state
  populateThresholds();
  // Populate player colors
  populatePlayerColors();
  // Update UI based on owner status
  updateSettingsOwnerUI();
  settingsModal.modal.style.display = "flex";
}

function updateSettingsOwnerUI() {
  const isOwner = gameState && gameState.ownerId === myClientId;
  const thresholdsContainer = settingsModal.thresholdsContainer;
  const addBtn = settingsModal.addThresholdBtn;

  // Disable threshold editing for non-owners
  const inputs = thresholdsContainer.querySelectorAll(".threshold-input");
  const removeButtons = thresholdsContainer.querySelectorAll(".btn-threshold-remove");

  inputs.forEach(input => {
    input.disabled = !isOwner;
    input.style.opacity = isOwner ? "1" : "0.5";
  });

  removeButtons.forEach(btn => {
    btn.disabled = !isOwner;
    btn.style.display = isOwner ? "block" : "none";
  });

  addBtn.disabled = !isOwner;
  addBtn.style.display = isOwner ? "inline-block" : "none";

  // Update hint text
  const formGroup = thresholdsContainer.closest(".form-group");
  let hint = formGroup.querySelector(".form-hint");
  if (hint) {
    hint.textContent = isOwner
      ? "Audio alerts when time remaining drops below these values"
      : "Only the game owner can change thresholds";
  }
}

function hideSettingsModal() {
  settingsModal.modal.style.display = "none";
}

function populateThresholds() {
  if (!gameState) return;

  const thresholds = gameState.settings?.warningThresholds || [300000, 60000, 30000];
  settingsModal.thresholdsContainer.innerHTML = "";

  thresholds.forEach((ms, index) => {
    const minutes = ms / 60000;
    addThresholdItem(minutes, index);
  });
}

function addThresholdItem(value = 1, index = null) {
  const container = settingsModal.thresholdsContainer;
  const item = document.createElement("div");
  item.className = "threshold-item";
  item.dataset.index = index !== null ? index : container.children.length;

  item.innerHTML = `
    <input type="number" class="threshold-input" value="${value}" min="0.1" step="0.1" />
    <span class="threshold-unit">min</span>
    <button type="button" class="btn-threshold-remove" aria-label="Remove threshold">&times;</button>
  `;

  item.querySelector(".btn-threshold-remove").addEventListener("click", () => {
    if (container.children.length > 1) {
      item.remove();
    }
  });

  container.appendChild(item);
}

function getThresholdsFromUI() {
  const inputs = settingsModal.thresholdsContainer.querySelectorAll(".threshold-input");
  const thresholds = [];

  inputs.forEach(input => {
    const minutes = parseFloat(input.value);
    if (!isNaN(minutes) && minutes > 0) {
      thresholds.push(Math.round(minutes * 60000));
    }
  });

  // Sort descending and remove duplicates
  return [...new Set(thresholds)].sort((a, b) => b - a);
}

function populatePlayerColors() {
  if (!gameState) return;

  const container = settingsModal.playerColorsContainer;
  container.innerHTML = "";

  // Find the player claimed by this client
  const myPlayer = gameState.players.find(p => p.claimedBy === myClientId);

  if (!myPlayer) {
    container.innerHTML = '<p class="form-hint">Claim a player to change your color</p>';
    return;
  }

  const color = getPlayerColor(myPlayer);
  const item = document.createElement("div");
  item.className = "player-color-item";
  item.style.background = `linear-gradient(135deg, ${color.primary}22 0%, ${color.secondary}33 100%)`;
  item.style.borderColor = `${color.primary}55`;

  item.innerHTML = `
    <div class="player-color-swatch" style="background: ${color.primary}"></div>
    <span class="player-color-name">${myPlayer.name}</span>
    <span class="color-change-hint">Tap to change</span>
  `;

  item.addEventListener("click", () => {
    openColorPicker(myPlayer);
  });

  container.appendChild(item);
}

function getPlayerColor(player) {
  // If player has a custom color, use it
  if (player.color) {
    const customColor = PLAYER_COLORS.find(c => c.id === player.color);
    if (customColor) return customColor;
  }

  // Default colors based on player ID
  const defaultColors = ["red", "blue", "green", "yellow", "purple", "cyan", "orange", "pink"];
  const colorId = defaultColors[(player.id - 1) % defaultColors.length];
  return PLAYER_COLORS.find(c => c.id === colorId) || PLAYER_COLORS[0];
}

function openColorPicker(player) {
  selectedPlayerForColor = player;
  const container = colorPickerModal.options;
  container.innerHTML = "";

  const currentColor = player.color || getPlayerColor(player).id;

  PLAYER_COLORS.forEach(color => {
    const option = document.createElement("div");
    option.className = "color-option" + (color.id === currentColor ? " selected" : "");
    option.style.background = `linear-gradient(135deg, ${color.primary} 0%, ${color.secondary} 100%)`;
    option.title = color.name;

    option.addEventListener("click", () => {
      selectColor(color.id);
    });

    container.appendChild(option);
  });

  colorPickerModal.modal.style.display = "flex";
}

function selectColor(colorId) {
  if (selectedPlayerForColor) {
    sendUpdatePlayer(selectedPlayerForColor.id, { color: colorId });
    // Update the color display immediately (optimistic update)
    updateColorDisplay(colorId);
  }
  closeColorPicker();
}

function updateColorDisplay(colorId) {
  const color = PLAYER_COLORS.find(c => c.id === colorId);
  if (!color) return;

  const container = settingsModal.playerColorsContainer;
  const item = container.querySelector(".player-color-item");
  if (item) {
    item.style.background = `linear-gradient(135deg, ${color.primary}22 0%, ${color.secondary}33 100%)`;
    item.style.borderColor = `${color.primary}55`;
    const swatch = item.querySelector(".player-color-swatch");
    if (swatch) {
      swatch.style.background = color.primary;
    }
  }
}

function closeColorPicker() {
  colorPickerModal.modal.style.display = "none";
  selectedPlayerForColor = null;
}

function hideAllScreens() {
  Object.values(screens).forEach(screen => {
    if (screen) screen.style.display = "none";
  });
}

function showScreen(screenName) {
  hideAllScreens();
  if (screens[screenName]) {
    screens[screenName].style.display = "block";
  }
}

function backToMenu() {
  // Clear reconnection tokens for the game we're leaving
  if (gameState && gameState.id) {
    clearGameTokens(gameState.id);
  }
  showScreen("mainMenu");
  gameState = null;
  setupForm.joinGame.value = "";
  playClick();
}

// Main menu navigation
menuButtons.casual.addEventListener("click", () => {
  showScreen("casualSetup");
  playClick();
});

menuButtons.campaign.addEventListener("click", () => {
  showScreen("campaignScreen");
  playClick();
});

menuButtons.join.addEventListener("click", () => {
  showScreen("joinScreen");
  playClick();
});

menuButtons.load.addEventListener("click", () => {
  showScreen("loadScreen");
  playClick();
});

menuButtons.settings.addEventListener("click", () => {
  menuSettingsForm.muteCheckbox.checked = !audioEnabled;
  showScreen("menuSettings");
  playClick();
});

// Back buttons
backButtons.casual.addEventListener("click", () => {
  showScreen("mainMenu");
  playClick();
});

backButtons.join.addEventListener("click", () => {
  showScreen("mainMenu");
  playClick();
});

backButtons.campaign.addEventListener("click", () => {
  showScreen("mainMenu");
  playClick();
});

backButtons.load.addEventListener("click", () => {
  showScreen("mainMenu");
  playClick();
});

backButtons.menuSettings.addEventListener("click", () => {
  showScreen("mainMenu");
  playClick();
});

// Menu settings save
menuSettingsForm.save.addEventListener("click", () => {
  audioEnabled = !menuSettingsForm.muteCheckbox.checked;
  showScreen("mainMenu");
  playClick();
});

setupForm.createGame.addEventListener("click", () => {
  console.log("Create game button clicked");
  const settings = {
    playerCount: parseInt(setupForm.playerCount.value),
    initialTime: parseInt(setupForm.initialTime.value) * 60 * 1000,
  };
  console.log("Settings:", settings);
  sendCreateGame(settings);
});

setupForm.joinBtn.addEventListener("click", () => {
  const gameId = setupForm.joinGame.value.trim().toUpperCase();
  if (gameId) {
    sendJoinGame(gameId);
  }
});

controls.pause.addEventListener("click", () => {
  sendPause();
  playPauseResume();
});

controls.reset.addEventListener("click", () => {
  if (confirm("Are you sure you want to reset the game?")) {
    sendReset();
    playClick();
  }
});

controls.settings.addEventListener("click", () => {
  showSettingsModal();
  playClick();
});

controls.backToMenu.addEventListener("click", () => {
  if (
    confirm(
      "Are you sure you want to return to the main menu? This will disconnect you from the current game."
    )
  ) {
    backToMenu();
  }
});

settingsModal.save.addEventListener("click", () => {
  // Only the game owner can change warning thresholds
  if (gameState && myClientId && gameState.ownerId === myClientId) {
    const thresholds = getThresholdsFromUI();
    if (thresholds.length > 0) {
      sendUpdateSettings({ warningThresholds: thresholds });
    }
  }

  hideSettingsModal();
  playClick();
});

settingsModal.close.addEventListener("click", () => {
  hideSettingsModal();
  playClick();
});

settingsModal.addThresholdBtn.addEventListener("click", () => {
  addThresholdItem(1);
  playClick();
});

colorPickerModal.cancel.addEventListener("click", () => {
  closeColorPicker();
  playClick();
});

controls.start.addEventListener("click", () => {
  sendStart();
  playClick();
});

controls.passTurn.addEventListener("click", () => {
  sendPassTurn();
});

timeoutModal.acknowledge.addEventListener("click", () => {
  hideTimeoutModal();
  playClick();
});

document.addEventListener("keydown", e => {
  if (!gameState || screens.game.style.display === "none") return;

  if (e.code === "Space") {
    e.preventDefault();
    sendPassTurn();
  } else if (e.code === "KeyP") {
    e.preventDefault();
    sendPause();
    playPauseResume();
  }
});

window.addEventListener("click", () => {
  if (!audioContext) {
    initAudio();
  }
});

connect();
