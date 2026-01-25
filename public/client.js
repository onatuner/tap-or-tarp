let ws;
let gameState = null;
let audioEnabled = true;
let audioContext;
let reconnectAttempts = 0;
let reconnectTimeout = null;
const volume = 0.5;
let myClientId = null;
let pendingReconnect = null; // Track pending reconnection attempt for token cleanup on failure

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
  feedback: document.getElementById("feedback-screen"),
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
  feedback: document.getElementById("menu-feedback-btn"),
};

// Back buttons
const backButtons = {
  casual: document.getElementById("casual-back-btn"),
  join: document.getElementById("join-back-btn"),
  campaign: document.getElementById("campaign-back-btn"),
  load: document.getElementById("load-back-btn"),
  menuSettings: document.getElementById("menu-settings-back-btn"),
  feedback: document.getElementById("feedback-back-btn"),
};

// Menu settings
const menuSettingsForm = {
  muteCheckbox: document.getElementById("menu-mute-checkbox"),
  save: document.getElementById("menu-settings-save-btn"),
};

const feedbackForm = {
  textarea: document.getElementById("feedback-text"),
  charCount: document.getElementById("feedback-char-count"),
  submit: document.getElementById("feedback-submit-btn"),
  viewBtn: document.getElementById("feedback-view-btn"),
  addBtn: document.getElementById("feedback-add-btn"),
  backBtn: document.getElementById("feedback-back-btn"),
  listBackBtn: document.getElementById("feedback-list-back-btn"),
  formSection: document.getElementById("feedback-form-section"),
  listSection: document.getElementById("feedback-list-section"),
  list: document.getElementById("feedback-list"),
};

const setupForm = {
  gameName: document.getElementById("game-name"),
  playerCount: document.getElementById("player-count"),
  initialTime: document.getElementById("initial-time"),
  joinGame: document.getElementById("join-game"),
  createGame: document.getElementById("create-game"),
  joinBtn: document.getElementById("join-btn"),
  gameList: document.getElementById("game-list"),
};

const controls = {
  start: document.getElementById("start-btn"),
  passTurn: document.getElementById("pass-turn-btn"),
  interrupt: document.getElementById("interrupt-btn"),
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
  closeLobbyBtn: document.getElementById("close-lobby-btn"),
  gameNameInput: document.getElementById("game-name-input"),
};

const gameTitleDisplay = document.getElementById("game-title-display");

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
      console.error("Server error:", message.data.message);
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
    case "feedbackList":
      renderFeedbackList(message.data.feedbacks);
      break;
    case "feedbackDeleted":
      loadFeedbacks();
      break;
    case "feedbackUpdated":
      loadFeedbacks();
      break;
    case "gameEnded":
      backToMenu();
      break;
    case "gameRenamed":
      if (gameState && message.data.name) {
        gameState.name = message.data.name;
        if (message.data.name !== "Game") {
          gameTitleDisplay.textContent = message.data.name;
        } else {
          gameTitleDisplay.textContent = "Tap or Tarp";
        }
      }
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

  // Check if this player has priority (last in interruptingPlayers queue)
  if (gameState.interruptingPlayers && gameState.interruptingPlayers.length > 0) {
    const priorityPlayerId =
      gameState.interruptingPlayers[gameState.interruptingPlayers.length - 1];
    if (player.id === priorityPlayerId) {
      const priorityIndicator = document.createElement("span");
      priorityIndicator.className = "priority-indicator";
      priorityIndicator.textContent = "PRIORITY";
      statusSpan.appendChild(priorityIndicator);
    }
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
  drunkIcon.innerHTML = `<svg viewBox="0 0 44 44" width="44" height="44"><rect width="44" height="44" rx="8" fill="${playerColor.secondary}"/><rect width="44" height="44" rx="8" fill="rgba(0,0,0,0.5)"/><path fill="#fff" d="M10 10h24l-10.5 14v8h6v2h-15v-2h6v-8L10 10zm3.5 2l7.5 10 7.5-10h-15z"/><circle cx="28" cy="14" r="3" fill="#8bc34a"/></svg>`;

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
    '<svg viewBox="0 0 24 24" width="44" height="44"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/><text x="12" y="16" text-anchor="middle" fill="currentColor" font-size="12" font-weight="bold">#</text></svg>';

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

  // Update game title with custom name if set
  if (gameState.name && gameState.name !== "Game") {
    gameTitleDisplay.textContent = gameState.name;
  } else {
    gameTitleDisplay.textContent = "Tap or Tarp";
  }

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

  // Check if current client is active player
  const activePlayer = gameState.players.find(p => p.id === gameState.activePlayer);
  const isActivePlayer = activePlayer && activePlayer.claimedBy === myClientId;
  const myPlayer = gameState.players.find(p => p.claimedBy === myClientId);

  // Check if all players are claimed
  const allPlayersClaimed = gameState.players.every(p => p.claimedBy !== null);

  if (gameState.status === "waiting") {
    controls.start.style.display = "inline-block";
    controls.start.disabled = !allPlayersClaimed;
    controls.start.title = allPlayersClaimed ? "" : "All players must be claimed before starting";
    controls.passTurn.style.display = "none";
    controls.interrupt.style.display = "none";
  } else {
    controls.start.style.display = "none";
    controls.passTurn.style.display = "inline-block";
    controls.passTurn.disabled =
      !isActivePlayer ||
      (isActivePlayer &&
        gameState.interruptingPlayers &&
        gameState.interruptingPlayers.includes(myPlayer?.id)) ||
      gameState.status === "paused";
    if (!controls.passTurn.disabled) {
      controls.passTurn.classList.add("btn-primary");
    } else {
      controls.passTurn.classList.remove("btn-primary");
    }
    if (
      myPlayer &&
      gameState.interruptingPlayers &&
      gameState.interruptingPlayers.includes(myPlayer.id)
    ) {
      controls.interrupt.style.display = "inline-block";
      controls.interrupt.textContent = "Pass Priority";
      controls.interrupt.disabled = false;
      controls.interrupt.classList.add("btn-primary");
    } else if (myPlayer && gameState.status === "running" && !isActivePlayer) {
      controls.interrupt.style.display = "inline-block";
      controls.interrupt.textContent = "Interrupt";
      controls.interrupt.disabled = false;
      controls.interrupt.classList.add("btn-primary");
    } else {
      controls.interrupt.style.display = "none";
      controls.interrupt.classList.remove("btn-primary");
    }
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

function sendRenameGame(newName) {
  safeSend({ type: "renameGame", data: { name: newName } });
}

function sendFeedback(feedbackText) {
  safeSend({ type: "feedback", data: { text: feedbackText } });
}

function sendLoadFeedbacks() {
  safeSend({ type: "loadFeedbacks", data: {} });
}

function sendUpdateFeedback(feedbackId, text) {
  safeSend({ type: "updateFeedback", data: { id: feedbackId, text } });
}

function sendDeleteFeedback(feedbackId) {
  safeSend({ type: "deleteFeedback", data: { id: feedbackId } });
}

function sendEndGame() {
  safeSend({ type: "endGame" });
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
  // Populate game name
  if (gameState && gameState.name) {
    settingsModal.gameNameInput.value = gameState.name !== "Game" ? gameState.name : "";
  } else {
    settingsModal.gameNameInput.value = "";
  }
  // Update UI based on owner status
  updateSettingsOwnerUI();
  settingsModal.modal.style.display = "flex";
}

function updateSettingsOwnerUI() {
  // All players can now edit settings - no owner restrictions
  const thresholdsContainer = settingsModal.thresholdsContainer;
  const addBtn = settingsModal.addThresholdBtn;

  const inputs = thresholdsContainer.querySelectorAll(".threshold-input");
  const removeButtons = thresholdsContainer.querySelectorAll(".btn-threshold-remove");

  inputs.forEach(input => {
    input.disabled = false;
    input.style.opacity = "1";
  });

  removeButtons.forEach(btn => {
    btn.disabled = false;
    btn.style.display = "block";
  });

  addBtn.disabled = false;
  addBtn.style.display = "inline-block";

  // Update hint text
  const formGroup = thresholdsContainer.closest(".form-group");
  const hint = formGroup.querySelector(".form-hint");
  if (hint) {
    hint.textContent = "Audio alerts when time remaining drops below these values";
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
  setupForm.gameName.value = "";
  playClick();
}

async function loadGames() {
  if (!setupForm.gameList) return;

  setupForm.gameList.innerHTML = '<p class="loading">Loading games...</p>';

  try {
    const response = await fetch("/api/games");
    if (!response.ok) {
      throw new Error("Failed to load games");
    }
    const data = await response.json();
    renderGames(data.games || []);
  } catch (error) {
    console.error("Failed to load games:", error);
    setupForm.gameList.innerHTML = '<p class="form-hint">Failed to load games. Try refreshing.</p>';
  }
}

function renderGames(games) {
  if (!setupForm.gameList) return;

  if (games.length === 0) {
    setupForm.gameList.innerHTML =
      '<p class="form-hint">No active games. Create a new game or enter a code.</p>';
    return;
  }

  setupForm.gameList.innerHTML = "";

  games.forEach(game => {
    const gameCard = document.createElement("div");
    gameCard.className = "game-card";

    const modeName = game.mode === "casual" ? "Casual" : game.mode;
    const statusText = game.status === "waiting" ? "Waiting" : game.status;
    const timeAgo = formatTimeAgo(game.lastActivity);
    const timePerPlayer = formatMinutes(game.settings.initialTime);

    gameCard.innerHTML = `
      <div class="game-card-header">
        <span class="game-code">${game.id}</span>
        <span class="game-status status-${game.status}">${statusText}</span>
      </div>
      <div class="game-name-display">${escapeHtml(game.name)}</div>
      <div class="game-card-details">
        <div class="game-detail">
          <span class="game-detail-label">Mode:</span>
          <span class="game-detail-value">${modeName}</span>
        </div>
        <div class="game-detail">
          <span class="game-detail-label">Players:</span>
          <span class="game-detail-value">${game.claimedCount}/${game.playerCount}</span>
        </div>
        <div class="game-detail">
          <span class="game-detail-label">Time:</span>
          <span class="game-detail-value">${timePerPlayer}</span>
        </div>
        <div class="game-detail">
          <span class="game-detail-label">Active:</span>
          <span class="game-detail-value">${timeAgo}</span>
        </div>
      </div>
    `;

    gameCard.addEventListener("click", () => {
      sendJoinGame(game.id);
    });

    setupForm.gameList.appendChild(gameCard);
  });
}

function formatTimeAgo(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (seconds < 60) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return "1d+ ago";
}

function formatMinutes(milliseconds) {
  const minutes = Math.round(milliseconds / 60000);
  return `${minutes}min`;
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
  loadGames();
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

menuButtons.feedback.addEventListener("click", () => {
  feedbackForm.textarea.value = "";
  feedbackForm.editingId = null;
  updateFeedbackCharCount();
  feedbackForm.formSection.style.display = "block";
  feedbackForm.listSection.style.display = "none";
  showScreen("feedback");
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

backButtons.feedback.addEventListener("click", () => {
  showScreen("mainMenu");
  playClick();
});

feedbackForm.viewBtn.addEventListener("click", () => {
  loadFeedbacks();
  playClick();
});

feedbackForm.addBtn.addEventListener("click", () => {
  feedbackForm.textarea.value = "";
  feedbackForm.editingId = null;
  updateFeedbackCharCount();
  feedbackForm.formSection.style.display = "block";
  feedbackForm.listSection.style.display = "none";
  playClick();
});

feedbackForm.listBackBtn.addEventListener("click", () => {
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
    name: setupForm.gameName.value.trim() || "Game",
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
  // Any player can change warning thresholds
  const thresholds = getThresholdsFromUI();
  if (thresholds.length > 0) {
    sendUpdateSettings({ warningThresholds: thresholds });
  }

  // Check if game name is being renamed
  const newName = settingsModal.gameNameInput.value.trim();
  if (newName) {
    sendRenameGame(newName);
  }

  hideSettingsModal();
  playClick();
});

settingsModal.close.addEventListener("click", () => {
  hideSettingsModal();
  playClick();
});

settingsModal.closeLobbyBtn.addEventListener("click", () => {
  if (
    confirm("Are you sure you want to close the lobby? This will end the game for all players.")
  ) {
    sendEndGame();
    hideSettingsModal();
    playClick();
  }
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

controls.interrupt.addEventListener("click", () => {
  const myPlayer = gameState.players.find(p => p.claimedBy === myClientId);
  if (
    myPlayer &&
    gameState.interruptingPlayers &&
    gameState.interruptingPlayers.includes(myPlayer.id)
  ) {
    safeSend({ type: "passPriority", data: {} });
  } else {
    safeSend({ type: "interrupt", data: {} });
  }
  playClick();
});

timeoutModal.acknowledge.addEventListener("click", () => {
  hideTimeoutModal();
  playClick();
});

feedbackForm.textarea.addEventListener("input", () => {
  updateFeedbackCharCount();
});

feedbackForm.submit.addEventListener("click", () => {
  const feedbackText = feedbackForm.textarea.value.trim();
  if (feedbackText.length > 0) {
    if (feedbackForm.editingId) {
      sendUpdateFeedback(feedbackForm.editingId, feedbackText);
    } else {
      sendFeedback(feedbackText);
    }
    feedbackForm.textarea.value = "";
    feedbackForm.editingId = null;
    updateFeedbackCharCount();
    showScreen("mainMenu");
    playClick();
  }
});

function updateFeedbackCharCount() {
  feedbackForm.charCount.textContent = feedbackForm.textarea.value.length;
}

function loadFeedbacks() {
  feedbackForm.list.innerHTML = '<p class="loading">Loading feedback...</p>';
  feedbackForm.formSection.style.display = "none";
  feedbackForm.listSection.style.display = "block";
  sendLoadFeedbacks();
}

function renderFeedbackList(feedbacks) {
  feedbackForm.list.innerHTML = "";

  if (feedbacks.length === 0) {
    feedbackForm.list.innerHTML = '<p class="form-hint">No feedback submitted yet.</p>';
    return;
  }

  feedbacks.forEach(feedback => {
    const card = document.createElement("div");
    card.className = "feedback-item";
    card.dataset.id = feedback.id;

    const date = new Date(feedback.timestamp).toLocaleString();

    card.innerHTML = `
      <div class="feedback-text">${escapeHtml(feedback.text)}</div>
      <div class="feedback-meta">
        <span class="feedback-date">${date}</span>
        <div class="feedback-actions">
          <button class="btn btn-small btn-secondary" data-action="edit" data-id="${feedback.id}">Edit</button>
          <button class="btn btn-small btn-danger" data-action="delete" data-id="${feedback.id}">Delete</button>
        </div>
      </div>
    `;

    feedbackForm.list.appendChild(card);
  });

  feedbackForm.list.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", e => {
      const action = e.target.dataset.action;
      const id = e.target.dataset.id;

      if (action === "edit") {
        editFeedback(id);
      } else if (action === "delete") {
        deleteFeedback(id);
      }
      playClick();
    });
  });
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function editFeedback(id) {
  const feedbackItem = feedbackForm.list.querySelector(`[data-id="${id}"]`);
  const textElement = feedbackItem.querySelector(".feedback-text");
  const text = textElement.textContent;

  feedbackForm.textarea.value = text;
  feedbackForm.editingId = id;
  updateFeedbackCharCount();

  feedbackForm.formSection.style.display = "block";
  feedbackForm.listSection.style.display = "none";
}

function deleteFeedback(id) {
  if (confirm("Are you sure you want to delete this feedback?")) {
    sendDeleteFeedback(id);
  }
}

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
