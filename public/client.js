let ws;
let gameState = null;
let audioEnabled = true;
let audioContext;
let reconnectAttempts = 0;
let reconnectTimeout = null;
const volume = 0.5;
let myClientId = null;
let pendingReconnect = null; // Track pending reconnection attempt for token cleanup on failure
let wakeLock = null; // Screen wake lock to prevent screen timeout during gameplay
let isConnected = false; // Track WebSocket connection state

// Connection status UI element
const connectionStatus = {
  element: document.getElementById("connection-status"),
  dot: null,
  text: null,
};

// Initialize connection status elements after DOM ready
function initConnectionStatus() {
  if (connectionStatus.element) {
    connectionStatus.dot = connectionStatus.element.querySelector(".connection-dot");
    connectionStatus.text = connectionStatus.element.querySelector(".connection-text");
  }
}

function showConnectionStatus(state, message) {
  if (!connectionStatus.element) return;

  connectionStatus.element.classList.remove("hidden", "connected", "disconnected");
  if (state) {
    connectionStatus.element.classList.add(state);
  }
  if (connectionStatus.text) {
    connectionStatus.text.textContent = message;
  }

  // Auto-hide when connected after 2 seconds
  if (state === "connected") {
    setTimeout(() => {
      if (isConnected) {
        connectionStatus.element.classList.add("hidden");
      }
    }, 2000);
  }
}

function hideConnectionStatus() {
  if (connectionStatus.element) {
    connectionStatus.element.classList.add("hidden");
  }
}

// ============================================================================
// SCREEN WAKE LOCK MANAGEMENT
// ============================================================================

/**
 * Request a screen wake lock to prevent the device from sleeping
 * Keeps the screen on while the app is open
 */
async function requestWakeLock() {
  if (!("wakeLock" in navigator)) {
    console.log("Wake Lock API not supported");
    return;
  }

  // Don't request if we already have an active lock
  if (wakeLock) {
    return;
  }

  try {
    wakeLock = await navigator.wakeLock.request("screen");
    console.log("Screen wake lock acquired");

    wakeLock.addEventListener("release", () => {
      console.log("Screen wake lock released");
      wakeLock = null;
    });
  } catch (err) {
    console.log("Failed to acquire wake lock:", err.message);
  }
}

// Re-acquire wake lock when page becomes visible again (it's auto-released when hidden)
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible") {
    await requestWakeLock();
  }
});

// Request wake lock when the page loads
requestWakeLock();

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

// Game UI elements (unified layout)
const gameUI = {
  screen: document.getElementById("game-screen"),
  exitBtn: document.querySelector(".game-exit-btn"),
  settingsBtn: document.querySelector(".game-settings-btn"),
  pauseBtn: document.querySelector(".game-pause-btn"),
  diceBtn: document.querySelector(".game-dice-btn"),
  playOrderBtn: document.querySelector(".game-play-order-btn"),
  timeDisplay: document.querySelector(".game-time-display"),
  timeValue: document.querySelector(".game-time-value"),
  turnIndicator: document.querySelector(".game-turn-indicator"),
  deadBanner: document.querySelector(".game-dead-banner"),
  interactionArea: document.querySelector(".game-interaction-area"),
  interactionBtn: document.querySelector(".game-interaction-btn"),
  cancelTargetingBtn: document.querySelector(".game-cancel-targeting-btn"),
  otherPlayers: document.querySelector(".game-other-players"),
  playerCards: document.querySelector(".game-player-cards"),
  playerStats: document.querySelector(".game-player-stats"),
  campaignStats: document.querySelector(".game-campaign-stats"),
  statsRow: document.querySelector(".game-stats-row"),
  lifeStat: document.querySelector(".game-stats-row .game-stat-life"),
  poisonStat: document.querySelector(".game-stats-row .game-stat-poison"),
  genericStat: document.querySelector(".game-stats-row .game-stat-generic"),
};

// Check if device supports touch (for haptic feedback and long press behaviors)
function isTouchDevice() {
  return "ontouchstart" in window || navigator.maxTouchPoints > 0;
}

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

// Controls are now handled via gameUI and settingsModal

const settingsModal = {
  modal: document.getElementById("settings-modal"),
  closeBtn: document.querySelector(".settings-close"),
  tabs: document.querySelectorAll(".settings-tab"),
  panels: document.querySelectorAll(".settings-panel"),
  pauseBtn: document.getElementById("settings-pause-btn"),
  resetBtn: document.getElementById("settings-reset-btn"),
  randomStartBtn: document.getElementById("settings-random-start-btn"),
  colorPicker: document.getElementById("settings-color-picker"),
  thresholdsContainer: document.getElementById("settings-thresholds-container"),
  addThresholdBtn: document.getElementById("settings-add-threshold-btn"),
  bonusTimeInput: document.getElementById("settings-bonus-time"),
  gameCodeDisplay: document.getElementById("settings-game-code"),
  gameNameInput: document.getElementById("settings-game-name-input"),
  closeLobbyBtn: document.getElementById("settings-close-lobby-btn"),
  saveBtn: document.getElementById("settings-save-btn"),
  cancelBtn: document.getElementById("settings-cancel-btn"),
  // Admin controls
  adminTab: document.getElementById("tab-admin"),
  adminPanel: document.getElementById("panel-admin"),
  adminPlayerDropdown: document.getElementById("admin-player-dropdown"),
  adminReviveBtn: document.getElementById("admin-revive-btn"),
  adminKickBtn: document.getElementById("admin-kick-btn"),
  adminTimeInput: document.getElementById("admin-time-input"),
  adminAddTimeBtn: document.getElementById("admin-add-time-btn"),
  // Timeout penalty settings
  timeoutLivesInput: document.getElementById("settings-timeout-lives"),
  timeoutDrunkInput: document.getElementById("settings-timeout-drunk"),
  timeoutBonusTimeInput: document.getElementById("settings-timeout-bonus-time"),
};

const colorPickerModal = {
  modal: document.getElementById("color-picker-modal"),
  options: document.getElementById("color-options"),
  cancel: document.getElementById("cancel-color-picker"),
};

// settingsModal merged into settingsModal above

// Dice modal elements
const diceModal = {
  modal: document.getElementById("dice-modal"),
  select: document.getElementById("dice-sides-select"),
  customContainer: document.getElementById("dice-custom-container"),
  customInput: document.getElementById("dice-custom-input"),
  rollBtn: document.getElementById("roll-dice-btn"),
  closeBtn: document.getElementById("close-dice-modal"),
  lastResult: document.getElementById("dice-last-result"),
  resultDisplay: document.getElementById("dice-result-display"),
};

// Dice toast element
const diceToast = {
  element: document.getElementById("dice-toast"),
  rollerName: null,
  sidesDisplay: null,
  resultLarge: null,
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

const timeoutChoiceModal = {
  modal: document.getElementById("timeout-choice-modal"),
  timer: document.getElementById("timeout-choice-timer"),
  livesAmount: document.getElementById("timeout-lives-amount"),
  drunkAmount: document.getElementById("timeout-drunk-amount"),
  livesBtn: document.getElementById("timeout-choice-lives"),
  drunkBtn: document.getElementById("timeout-choice-drunk"),
  dieBtn: document.getElementById("timeout-choice-die"),
};

let timeoutChoiceInterval = null;
let timeoutChoiceDeadline = null;

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

// ============================================================================
// HAPTIC FEEDBACK
// ============================================================================

/**
 * Trigger haptic feedback if supported
 * @param {string} style - 'light', 'medium', or 'heavy'
 */
function hapticFeedback(style = "light") {
  if (!("vibrate" in navigator)) return;

  const patterns = {
    light: 10,
    medium: 20,
    heavy: 30,
    success: [10, 50, 10],
    error: [30, 50, 30],
  };

  try {
    navigator.vibrate(patterns[style] || 10);
  } catch (e) {
    // Silently fail if vibration not allowed
  }
}

// ============================================================================
// TOAST NOTIFICATIONS
// ============================================================================

/**
 * Show a toast notification
 * @param {string} message - The message to display
 * @param {string} type - 'success', 'error', 'info', or 'default'
 * @param {number} duration - How long to show in ms (default 2500)
 */
function showToast(message, type = "default", duration = 2500) {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const icons = {
    success: "✓",
    error: "✕",
    info: "ℹ",
    default: "",
  };

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;

  const iconHtml = icons[type] ? `<span class="toast-icon">${icons[type]}</span>` : "";

  toast.innerHTML = `
    ${iconHtml}
    <span class="toast-message">${message}</span>
    <button class="toast-close" aria-label="Dismiss">&times;</button>
  `;

  // Close button handler
  toast.querySelector(".toast-close").addEventListener("click", () => {
    dismissToast(toast);
  });

  container.appendChild(toast);

  // Auto dismiss
  const timeoutId = setTimeout(() => {
    dismissToast(toast);
  }, duration);

  // Store timeout ID for cleanup
  toast.dataset.timeoutId = timeoutId;
}

/**
 * Dismiss a toast notification
 */
function dismissToast(toast) {
  if (!toast || toast.classList.contains("toast-exit")) return;

  // Clear auto-dismiss timeout
  if (toast.dataset.timeoutId) {
    clearTimeout(parseInt(toast.dataset.timeoutId));
  }

  toast.classList.add("toast-exit");
  setTimeout(() => {
    toast.remove();
  }, 150);
}

/**
 * Copy text to clipboard
 * @param {string} text - Text to copy
 * @returns {Promise<boolean>} - Whether copy succeeded
 */
async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    // Fallback for older browsers
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.opacity = "0";
    document.body.appendChild(textArea);
    textArea.select();
    const success = document.execCommand("copy");
    document.body.removeChild(textArea);
    return success;
  } catch (err) {
    console.error("Failed to copy:", err);
    return false;
  }
}

/**
 * Handle game code copy
 */
async function copyGameCode() {
  if (!gameState || !gameState.id) return;

  const success = await copyToClipboard(gameState.id);

  if (success) {
    showToast("Game code copied!", "success");
    hapticFeedback("success");

    // Add visual feedback to the code display
    const codeDisplay = document.getElementById("settings-game-code");
    if (codeDisplay) {
      codeDisplay.classList.add("copied");
      setTimeout(() => codeDisplay.classList.remove("copied"), 300);
    }
  } else {
    showToast("Failed to copy code", "error");
    hapticFeedback("error");
  }
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
  const wsUrl = `${protocol}//${window.location.host}`;

  // Show connecting status
  isConnected = false;
  showConnectionStatus("", "Connecting...");

  console.log("Attempting WebSocket connection to:", wsUrl);
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log("Connected to server");
    isConnected = true;
    reconnectAttempts = 0;
    showConnectionStatus("connected", "Connected");
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
    isConnected = false;
    const delay = Math.min(
      CONSTANTS.RECONNECT_INITIAL_DELAY * Math.pow(2, reconnectAttempts),
      CONSTANTS.RECONNECT_MAX_DELAY
    );
    reconnectAttempts++;
    console.log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
    showConnectionStatus("disconnected", `Reconnecting... (${reconnectAttempts})`);
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    reconnectTimeout = setTimeout(connect, delay);
  };

  ws.onerror = error => {
    console.error("WebSocket error:", error);
    isConnected = false;
    showConnectionStatus("disconnected", "Connection error");
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
    case "state": {
      gameState = message.data;
      // Check if timeout choice should be hidden (player's timeout resolved)
      const myPlayerState = gameState?.players.find(p => p.claimedBy === myClientId);
      if (myPlayerState && !myPlayerState.timeoutPending && timeoutChoiceModal.modal?.style.display === "flex") {
        hideTimeoutChoiceModal();
      }
      renderGame();
      break;
    }
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
    case "kicked":
      alert("You have been kicked from the game.");
      backToMenu();
      break;
    case "gameComplete":
      handleGameComplete(message.data);
      break;
    case "gameRenamed":
      if (gameState && message.data.name) {
        gameState.name = message.data.name;
      }
      break;
    case "randomPlayerSelected":
      handleRandomPlayerSelected(message.data);
      break;
    case "playOrderRolled":
      handlePlayOrderRolled(message.data);
      break;
    case "diceRolled":
      handleDiceRolled(message.data);
      break;
    case "targetingUpdated":
      handleTargetingUpdated(message.data);
      break;
    case "targetingStarted":
      handleTargetingStarted(message.data);
      break;
    case "priorityPassed":
      handlePriorityPassed(message.data);
      break;
    case "targetingComplete":
      handleTargetingComplete(message.data);
      break;
    case "targetingCanceled":
      handleTargetingCanceled(message.data);
      break;
    case "timeoutChoice":
      handleTimeoutChoice(message.data);
      break;
  }
}

/**
 * Handle game completion - when only one player remains
 * @param {object} data - Contains winnerId and winnerName
 */
function handleGameComplete(data) {
  const { winnerId, winnerName } = data;

  if (winnerId !== null && winnerName) {
    // Show winner notification
    showWinnerModal(winnerId, winnerName);
  } else {
    // Draw - no winner
    showToast("Game Over - No winner!", "info", 5000);
  }
}

/**
 * Show a modal announcing the winner
 * @param {number} winnerId - Winner's player ID
 * @param {string} winnerName - Winner's name
 */
function showWinnerModal(winnerId, winnerName) {
  // Get the winner's color for styling
  const winner = gameState?.players?.find(p => p.id === winnerId);
  const colorClass = winner?.color ? `player-color-${winner.color}` : `player-${winnerId}`;

  // Create modal overlay
  const modalOverlay = document.createElement("div");
  modalOverlay.className = "winner-modal-overlay";
  modalOverlay.innerHTML = `
    <div class="winner-modal">
      <div class="winner-trophy">🏆</div>
      <h2 class="winner-title">Victory!</h2>
      <div class="winner-name ${colorClass}">${winnerName}</div>
      <p class="winner-subtitle">is the winner!</p>
      <button class="winner-close-btn">Close</button>
    </div>
  `;

  document.body.appendChild(modalOverlay);

  // Add close button event listener
  const closeBtn = modalOverlay.querySelector(".winner-close-btn");
  if (closeBtn) {
    closeBtn.addEventListener("click", () => modalOverlay.remove());
  }

  // Also close when clicking overlay background
  modalOverlay.addEventListener("click", (e) => {
    if (e.target === modalOverlay) {
      modalOverlay.remove();
    }
  });

  // Auto-remove after 10 seconds
  setTimeout(() => {
    if (modalOverlay.parentNode) {
      modalOverlay.remove();
    }
  }, 10000);
}

/**
 * Handle timeout choice message from server
 * @param {object} data - Contains playerId, options (livesLoss, drunkGain), deadline
 */
function handleTimeoutChoice(data) {
  const { playerId, options, deadline } = data;

  // Check if this is for the current player
  const myPlayer = gameState?.players.find(p => p.claimedBy === myClientId);
  if (!myPlayer || myPlayer.id !== playerId) {
    return; // Not for this player
  }

  // Show the timeout choice modal
  showTimeoutChoiceModal(options.livesLoss, options.drunkGain, deadline);
}

/**
 * Show the timeout choice modal with countdown
 * @param {number} livesLoss - Amount of life to lose
 * @param {number} drunkGain - Amount of drunk to gain
 * @param {number} deadline - Timestamp when auto-select happens
 */
function showTimeoutChoiceModal(livesLoss, drunkGain, deadline) {
  if (!timeoutChoiceModal.modal) return;

  // Update penalty amounts in the modal
  if (timeoutChoiceModal.livesAmount) {
    timeoutChoiceModal.livesAmount.textContent = livesLoss;
  }
  if (timeoutChoiceModal.drunkAmount) {
    timeoutChoiceModal.drunkAmount.textContent = drunkGain;
  }

  // Store deadline for countdown
  timeoutChoiceDeadline = deadline;

  // Start countdown timer
  updateTimeoutChoiceCountdown();
  if (timeoutChoiceInterval) {
    clearInterval(timeoutChoiceInterval);
  }
  timeoutChoiceInterval = setInterval(updateTimeoutChoiceCountdown, 1000);

  // Show the modal
  timeoutChoiceModal.modal.style.display = "flex";

  // Play timeout alarm sound
  playTimeout();
}

/**
 * Update the countdown timer in the timeout choice modal
 */
function updateTimeoutChoiceCountdown() {
  if (!timeoutChoiceDeadline || !timeoutChoiceModal.timer) return;

  const remaining = Math.max(0, Math.ceil((timeoutChoiceDeadline - Date.now()) / 1000));
  timeoutChoiceModal.timer.textContent = remaining;

  // If countdown reaches 0, auto-select "die" (server will do this, but hide modal)
  if (remaining <= 0) {
    hideTimeoutChoiceModal();
  }
}

/**
 * Hide the timeout choice modal and clean up
 */
function hideTimeoutChoiceModal() {
  if (timeoutChoiceModal.modal) {
    timeoutChoiceModal.modal.style.display = "none";
  }
  if (timeoutChoiceInterval) {
    clearInterval(timeoutChoiceInterval);
    timeoutChoiceInterval = null;
  }
  timeoutChoiceDeadline = null;
}

/**
 * Send the player's timeout choice to the server
 * @param {string} choice - "loseLives", "gainDrunk", or "die"
 */
function sendTimeoutChoice(choice) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  ws.send(JSON.stringify({
    type: "timeoutChoice",
    data: { choice }
  }));

  hideTimeoutChoiceModal();
}

/**
 * Handle random player selection
 * @param {object} data - Contains playerId and playerName
 */
function handleRandomPlayerSelected(data) {
  const { playerId, playerName } = data;

  // Show toast notification
  showToast(`🎲 ${playerName} selected as starting player!`, "info", 3000);

  // Highlight the selected player card
  highlightRandomSelectedPlayer(playerId);

  // Update game state if available
  if (gameState) {
    gameState.activePlayer = playerId;
  }
}

/**
 * Highlight the randomly selected player card with animation
 * @param {number} playerId - Player ID to highlight
 */
function highlightRandomSelectedPlayer(playerId) {
  // Remove previous highlights
  document.querySelectorAll(".player-card.random-selected").forEach(card => {
    card.classList.remove("random-selected");
  });

  // Find and highlight the selected player card (desktop)
  const desktopCard = document.querySelector(`.player-card[data-player-id="${playerId}"]`);
  if (desktopCard) {
    desktopCard.classList.add("random-selected");
    setTimeout(() => {
      desktopCard.classList.remove("random-selected");
    }, 3000);
  }

  // Find and highlight player card
  const playerCard = document.querySelector(`.game-player-card[data-player-id="${playerId}"]`);
  if (playerCard) {
    playerCard.classList.add("random-selected");
    setTimeout(() => {
      playerCard.classList.remove("random-selected");
    }, 3000);
  }
}

/**
 * Handle play order rolled event
 * @param {object} data - Contains rolls array and newOrder
 */
function handlePlayOrderRolled(data) {
  const { rolls, newOrder } = data;

  // Build message showing all rolls
  const rollMessages = rolls.map(r => {
    const rollStr = r.rolls.length > 1
      ? `${r.rolls.join(" → ")} (tiebreaker)`
      : `${r.finalRoll}`;
    return `${r.position}. ${r.playerName}: ${rollStr}`;
  }).join("\n");

  // Show toast with results
  showToast(`🎲 Play Order Decided!\n${rollMessages}`, "info", 6000);

  // Update local game state with new player order
  if (gameState && newOrder) {
    // Reorder players array to match server order
    const reorderedPlayers = [];
    for (const playerId of newOrder) {
      const player = gameState.players.find(p => p.id === playerId);
      if (player) {
        reorderedPlayers.push(player);
      }
    }
    // Add any remaining players (unclaimed)
    for (const player of gameState.players) {
      if (!reorderedPlayers.includes(player)) {
        reorderedPlayers.push(player);
      }
    }
    gameState.players = reorderedPlayers;

    // Set first player as active
    if (newOrder.length > 0) {
      gameState.activePlayer = newOrder[0];
    }

    // Re-render player cards with new order
    updateOtherPlayers();
  }

  // Highlight players in order with staggered animation
  rolls.forEach((roll, index) => {
    setTimeout(() => {
      highlightRandomSelectedPlayer(roll.playerId);
    }, index * 500);
  });
}

/**
 * Send roll play order request to server
 */
function sendRollPlayOrder() {
  safeSend({ type: "rollPlayOrder", data: {} });
}

/**
 * Update play order button visibility based on game state
 */
function updatePlayOrderButtonVisibility() {
  if (!gameUI.playOrderBtn || !gameState) return;

  const isWaiting = gameState.status === "waiting";
  const claimedCount = gameState.players.filter(p => p.claimedBy).length;
  const hasEnoughPlayers = claimedCount >= 2;

  gameUI.playOrderBtn.style.display = (isWaiting && hasEnoughPlayers) ? "flex" : "none";
}

/**
 * Update header pause button visibility and icon based on game state
 */
function updateHeaderPauseButton() {
  const pauseBtn = gameUI.pauseBtn;
  if (!pauseBtn || !gameState) return;

  // Show for any claimed player during active game
  const myPlayer = gameState.players?.find(p => p.claimedBy === myClientId);
  const isGameActive = gameState.status === "running" || gameState.status === "paused";

  pauseBtn.style.display = (myPlayer && isGameActive) ? "" : "none";

  // Update icon based on state
  if (gameState.status === "paused") {
    pauseBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
        <polygon points="5,3 19,12 5,21" />
      </svg>
    `;
    pauseBtn.setAttribute("aria-label", "Resume game");
  } else {
    pauseBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <rect x="6" y="4" width="4" height="16" rx="1" />
        <rect x="14" y="4" width="4" height="16" rx="1" />
      </svg>
    `;
    pauseBtn.setAttribute("aria-label", "Pause game");
  }
}

// ============================================================================
// DICE ROLLING FEATURE
// ============================================================================

let diceToastTimeout = null;

/**
 * Initialize dice toast element references
 */
function initDiceToast() {
  if (diceToast.element) {
    diceToast.rollerName = diceToast.element.querySelector(".dice-roller-name");
    diceToast.sidesDisplay = diceToast.element.querySelector(".dice-sides-display");
    diceToast.resultLarge = diceToast.element.querySelector(".dice-result-large");
  }
}

/**
 * Handle dice rolled message from server
 * @param {object} data - Contains playerName, sides, result
 */
function handleDiceRolled(data) {
  const { playerName, sides, result } = data;

  // Show toast to all players
  showDiceToast(playerName, sides, result);

  // Update the modal if open
  if (diceModal.modal && diceModal.modal.style.display !== "none") {
    if (diceModal.lastResult) {
      diceModal.lastResult.style.display = "block";
    }
    if (diceModal.resultDisplay) {
      diceModal.resultDisplay.textContent = result;
    }
  }

  // Play dice sound
  playDiceSound();
}

// ============================================================================
// TARGETING SYSTEM HANDLERS
// ============================================================================

/**
 * Get player name by player ID
 * @param {number} playerId - Player ID
 * @returns {string} Player name
 */
function getPlayerNameById(playerId) {
  if (!gameState || !gameState.players) return `Player ${playerId}`;
  const player = gameState.players.find(p => p.id === playerId);
  return player ? player.name : `Player ${playerId}`;
}

/**
 * Handle targeting state update
 * @param {object} data - Targeting state data
 */
function handleTargetingUpdated(data) {
  if (!gameState) return;

  gameState.targetingState = data.targetingState;
  gameState.targetedPlayers = data.targetedPlayers || [];
  gameState.awaitingPriority = data.awaitingPriority || [];
  gameState.originalActivePlayer = data.originalActivePlayer;
  gameState.activePlayer = data.activePlayer;

  updatePlayerCardTargetingStates();
  updateInteractionButton();
  updateTimeDisplay();
}

/**
 * Handle targeting started (resolution phase begins)
 * @param {object} data - Targeting started data
 */
function handleTargetingStarted(data) {
  if (!gameState) return;

  gameState.targetingState = CONSTANTS.TARGETING.STATES.RESOLVING;
  gameState.targetedPlayers = data.targets || [];
  gameState.awaitingPriority = data.awaitingPriority || [];
  gameState.originalActivePlayer = data.originalPlayer;
  gameState.activePlayer = data.activePlayer;

  updatePlayerCardTargetingStates();
  updateInteractionButton();
  updateTimeDisplay();
}

/**
 * Handle priority passed by a targeted player
 * @param {object} data - Priority passed data
 */
function handlePriorityPassed(data) {
  if (!gameState) return;

  // Ensure targeting state remains resolving during priority passing
  gameState.targetingState = CONSTANTS.TARGETING.STATES.RESOLVING;
  gameState.awaitingPriority = data.awaitingPriority || [];
  gameState.activePlayer = data.activePlayer;

  updatePlayerCardTargetingStates();
  updateInteractionButton();
  updateTimeDisplay();
}

/**
 * Handle targeting complete (all targets passed)
 * @param {object} data - Targeting complete data
 */
function handleTargetingComplete(data) {
  if (!gameState) return;

  gameState.targetingState = CONSTANTS.TARGETING.STATES.NONE;
  gameState.targetedPlayers = [];
  gameState.awaitingPriority = [];
  gameState.originalActivePlayer = null;
  gameState.activePlayer = data.activePlayer;

  updatePlayerCardTargetingStates();
  updateInteractionButton();
  updateTimeDisplay();
}

/**
 * Handle targeting canceled
 * @param {object} data - Targeting canceled data
 */
function handleTargetingCanceled(data) {
  if (!gameState) return;

  gameState.targetingState = CONSTANTS.TARGETING.STATES.NONE;
  gameState.targetedPlayers = [];
  gameState.awaitingPriority = [];
  gameState.originalActivePlayer = null;
  gameState.activePlayer = data.activePlayer;

  updatePlayerCardTargetingStates();
  updateInteractionButton();
  updateTimeDisplay();
}

/**
 * Update player card visual states for targeting
 */
function updatePlayerCardTargetingStates() {
  if (!gameState) return;

  // Update small player cards
  document.querySelectorAll(".game-player-card").forEach(card => {
    const playerId = parseInt(card.dataset.playerId);
    updateCardTargetingClasses(card, playerId);
  });

  // Update large player cards (desktop/waiting view)
  document.querySelectorAll(".player-card").forEach(card => {
    const playerId = parseInt(card.dataset.playerId);
    updateCardTargetingClasses(card, playerId);
  });
}

/**
 * Update targeting classes on a card
 * @param {HTMLElement} card - Card element
 * @param {number} playerId - Player ID
 */
function updateCardTargetingClasses(card, playerId) {
  if (!card || isNaN(playerId)) return;

  // Remove all targeting classes
  card.classList.remove(
    "targeted",
    "awaiting-priority",
    "original-player",
    "selectable-target",
    "not-selectable",
    "currently-responding"
  );
  card.removeAttribute("data-queue-position");

  if (!gameState) return;

  const myPlayer = gameState.players.find(p => p.claimedBy === myClientId);
  const isMyTurn = myPlayer && myPlayer.id === gameState.activePlayer;
  const isSelecting = gameState.targetingState === CONSTANTS.TARGETING.STATES.SELECTING;
  const isResolving = gameState.targetingState === CONSTANTS.TARGETING.STATES.RESOLVING;
  const targetPlayer = gameState.players.find(p => p.id === playerId);

  // During SELECTING state
  if (isSelecting && isMyTurn) {
    // Already targeted
    if (gameState.targetedPlayers && gameState.targetedPlayers.includes(playerId)) {
      card.classList.add("targeted");
    }
    // Can be selected (not self, not eliminated)
    else if (myPlayer && playerId !== myPlayer.id && targetPlayer && !targetPlayer.isEliminated) {
      card.classList.add("selectable-target");
    }
    // Cannot be selected
    else {
      card.classList.add("not-selectable");
    }
  }

  // During RESOLVING state
  if (isResolving) {
    // Add targeted class to all targeted players
    if (gameState.targetedPlayers && gameState.targetedPlayers.includes(playerId)) {
      card.classList.add("targeted");
    }

    // Add awaiting priority and queue position
    if (gameState.awaitingPriority && gameState.awaitingPriority.includes(playerId)) {
      const queuePosition = gameState.awaitingPriority.indexOf(playerId) + 1;
      card.classList.add("awaiting-priority");
      card.setAttribute("data-queue-position", queuePosition);

      // First in queue is currently responding
      if (queuePosition === 1) {
        card.classList.add("currently-responding");
      }
    }

    // Original player (who initiated targeting)
    if (gameState.originalActivePlayer === playerId) {
      card.classList.add("original-player");
    }
  }

  // In NONE state but active player can see selectable targets
  const isNone = !gameState.targetingState || gameState.targetingState === CONSTANTS.TARGETING.STATES.NONE;
  if (isNone && isMyTurn && myPlayer && playerId !== myPlayer.id) {
    if (targetPlayer && !targetPlayer.isEliminated) {
      card.classList.add("selectable-target");
    }
  }
}

/**
 * Send toggle target message
 * @param {number} playerId - Player ID to toggle as target
 */
function sendToggleTarget(playerId) {
  safeSend({ type: "toggleTarget", data: { playerId } });
}

/**
 * Send confirm targets message
 */
function sendConfirmTargets() {
  safeSend({ type: "confirmTargets", data: {} });
}

/**
 * Send pass target priority message
 */
function sendPassTargetPriority() {
  safeSend({ type: "passTargetPriority", data: {} });
}

/**
 * Send cancel targeting message
 */
function sendCancelTargeting() {
  safeSend({ type: "cancelTargeting", data: {} });
}

// Targeting instructions and queue display removed - functions kept as no-ops for compatibility
function updateTargetingInstructions() {}
function updateTargetingQueue() {}

/**
 * Handle player card click for targeting
 * @param {number} playerId - Player ID that was clicked
 * @returns {boolean} Whether the click was handled for targeting
 */
function handlePlayerCardTargetClick(playerId) {
  if (!gameState || gameState.status !== "running") return false;

  const myPlayer = gameState.players.find(p => p.claimedBy === myClientId);
  if (!myPlayer) return false;

  const isMyTurn = myPlayer.id === gameState.activePlayer;
  const targetingState = gameState.targetingState || CONSTANTS.TARGETING.STATES.NONE;
  const isSelecting = targetingState === CONSTANTS.TARGETING.STATES.SELECTING;
  const isNone = targetingState === CONSTANTS.TARGETING.STATES.NONE;
  const isResolving = targetingState === CONSTANTS.TARGETING.STATES.RESOLVING;

  // Can't click during resolution
  if (isResolving) return true; // Handled but no action

  // During selection mode or normal gameplay, active player can target others
  if ((isSelecting || isNone) && isMyTurn) {
    // Can't target self
    if (playerId === myPlayer.id) return false;

    // Can't target eliminated players
    const targetPlayer = gameState.players.find(p => p.id === playerId);
    if (!targetPlayer || targetPlayer.isEliminated) return false;

    // Toggle this player as target
    sendToggleTarget(playerId);
    playClick();
    hapticFeedback("light");
    return true;
  }

  return false;
}

/**
 * Show the dice result toast
 */
function showDiceToast(playerName, sides, result) {
  if (!diceToast.element) return;

  // Initialize element references if needed
  if (!diceToast.rollerName) {
    initDiceToast();
  }

  // Update content
  if (diceToast.rollerName) diceToast.rollerName.textContent = playerName;
  if (diceToast.sidesDisplay) diceToast.sidesDisplay.textContent = sides;
  if (diceToast.resultLarge) diceToast.resultLarge.textContent = result;

  // Clear any existing timeout
  if (diceToastTimeout) {
    clearTimeout(diceToastTimeout);
  }

  // Show toast
  diceToast.element.style.display = "block";
  // Force reflow for animation
  void diceToast.element.offsetWidth;
  diceToast.element.classList.add("visible");

  // Auto-hide after 3 seconds
  diceToastTimeout = setTimeout(() => {
    hideDiceToast();
  }, 3000);
}

/**
 * Hide the dice result toast
 */
function hideDiceToast() {
  if (!diceToast.element) return;

  diceToast.element.classList.remove("visible");

  // Remove display after animation
  setTimeout(() => {
    if (diceToast.element) {
      diceToast.element.style.display = "none";
    }
  }, 300);
}

/**
 * Open the dice modal
 */
function openDiceModal() {
  if (!diceModal.modal) return;
  diceModal.modal.style.display = "flex";
  // Reset to default if custom was selected
  if (diceModal.select && diceModal.select.value === "custom") {
    diceModal.select.value = "6";
    if (diceModal.customContainer) {
      diceModal.customContainer.style.display = "none";
    }
  }
  // Focus the select
  setTimeout(() => diceModal.select?.focus(), 100);
}

/**
 * Close the dice modal
 */
function closeDiceModal() {
  if (!diceModal.modal) return;
  diceModal.modal.style.display = "none";
}

/**
 * Handle dice select change - show/hide custom input
 */
function handleDiceSelectChange() {
  const value = diceModal.select?.value;
  if (value === "custom") {
    if (diceModal.customContainer) {
      diceModal.customContainer.style.display = "block";
      diceModal.customInput?.focus();
    }
  } else {
    if (diceModal.customContainer) {
      diceModal.customContainer.style.display = "none";
    }
  }
}

/**
 * Get the number of sides to roll
 * @returns {number|null} Number of sides or null if invalid
 */
function getDiceSides() {
  const selectValue = diceModal.select?.value;

  if (selectValue === "custom") {
    const customValue = parseInt(diceModal.customInput?.value, 10);
    if (isNaN(customValue) || customValue < 1 || customValue > 999) {
      showToast("Please enter a valid number between 1 and 999", "error");
      return null;
    }
    return customValue;
  }

  return parseInt(selectValue, 10);
}

/**
 * Send dice roll to server
 */
function sendRollDice() {
  const sides = getDiceSides();
  if (sides === null) return;

  // Add rolling animation
  if (diceModal.rollBtn) {
    diceModal.rollBtn.classList.add("rolling");
    setTimeout(() => diceModal.rollBtn.classList.remove("rolling"), 450);
  }

  // Send to server
  safeSend({ type: "rollDice", data: { sides } });
}

/**
 * Play dice roll sound effect
 */
function playDiceSound() {
  if (!audioEnabled || !audioContext) return;

  try {
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    oscillator.frequency.setValueAtTime(800, audioContext.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(200, audioContext.currentTime + 0.1);

    gainNode.gain.setValueAtTime(0.3 * volume, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.1);

    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.1);
  } catch (e) {
    // Audio not supported or blocked
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
  nameInput.maxLength = 20;
  nameInput.autocomplete = "off";
  nameInput.autocapitalize = "words";

  // Track original name for reverting
  let originalName = player.name;

  // Stop all events from bubbling to card and ensure input is tappable on mobile
  const stopAndPrevent = (e) => {
    e.stopPropagation();
  };

  nameInput.addEventListener("click", stopAndPrevent);
  nameInput.addEventListener("mousedown", stopAndPrevent);

  // Mobile touch handling - must prevent default to avoid card capturing the event
  nameInput.addEventListener("touchstart", (e) => {
    e.stopPropagation();
    // Don't preventDefault here - let the browser handle touch-to-focus
  }, { passive: true });

  nameInput.addEventListener("touchend", (e) => {
    e.stopPropagation();
    e.preventDefault(); // Prevent click event from also firing
    // Explicitly focus the input on touch end
    nameInput.focus();
  }, { passive: false });

  // Pointer events for better cross-platform support
  nameInput.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
  });

  nameInput.addEventListener("focus", e => {
    e.stopPropagation();
    originalName = nameInput.value;
    // Select all text on focus for easy replacement
    setTimeout(() => nameInput.select(), 10);
  });

  // Handle name change on blur
  nameInput.addEventListener("blur", () => {
    const newName = nameInput.value.trim();
    if (newName && newName !== originalName) {
      console.log("Updating player name:", player.id, newName);
      sendUpdatePlayer(player.id, { name: newName });
      originalName = newName;
      // Add visual feedback
      nameInput.classList.add("saving");
      setTimeout(() => nameInput.classList.remove("saving"), 500);
    } else if (!newName) {
      // Revert to original if empty
      nameInput.value = originalName;
    }
  });

  // Handle Enter key to submit and Escape to cancel
  nameInput.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      nameInput.blur(); // Trigger blur event
    }
    if (e.key === "Escape") {
      e.preventDefault();
      nameInput.value = originalName; // Revert
      nameInput.blur();
    }
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

  // Check if this player has priority
  // Priority is either: active player (no interrupts) or last in interruptingPlayers queue
  let hasPriority = false;
  if (gameState.interruptingPlayers && gameState.interruptingPlayers.length > 0) {
    const priorityPlayerId =
      gameState.interruptingPlayers[gameState.interruptingPlayers.length - 1];
    hasPriority = player.id === priorityPlayerId;
  } else if (isActive) {
    hasPriority = true;
  }

  if (hasPriority) {
    const priorityIndicator = document.createElement("span");
    priorityIndicator.className = "priority-indicator";
    priorityIndicator.textContent = "PRIORITY";
    statusSpan.appendChild(priorityIndicator);
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

  // Click to claim/unclaim in waiting phase or toggle target
  // Check current game state, not stale closure variables
  card.addEventListener("click", () => {
    const currentIsWaiting = gameState && gameState.status === "waiting";
    const currentPlayer = gameState && gameState.players.find(p => p.id === player.id);
    const currentIsClaimed = currentPlayer && currentPlayer.claimedBy !== null;
    const currentIsMyPlayer = currentPlayer && currentPlayer.claimedBy === myClientId;

    if (currentIsWaiting) {
      if (currentIsMyPlayer) {
        sendUnclaim();
      } else if (!currentIsClaimed) {
        sendClaim(player.id);
      }
      playClick();
    } else if (gameState && gameState.status === "running") {
      // Handle targeting clicks during game
      handlePlayerCardTargetClick(player.id);
    }
  });

  // Right-click also works for claiming
  card.addEventListener("contextmenu", e => {
    e.preventDefault();
    const currentIsWaiting = gameState && gameState.status === "waiting";
    const currentPlayer = gameState && gameState.players.find(p => p.id === player.id);
    const currentIsClaimed = currentPlayer && currentPlayer.claimedBy !== null;
    const currentIsMyPlayer = currentPlayer && currentPlayer.claimedBy === myClientId;

    if (currentIsWaiting) {
      if (currentIsMyPlayer) {
        sendUnclaim();
      } else if (!currentIsClaimed) {
        sendClaim(player.id);
      }
      playClick();
    }
  });

  return card;
}

function renderGame() {
  if (!gameState) return;

  // Check if game screen is already visible (avoid full re-render for updates)
  const gameVisible = screens.game.style.display === "flex";

  if (gameVisible) {
    // Just update the UI without re-rendering
    updateGameUI();
    return;
  }

  // First time showing game screen - do full render
  hideAllScreens();

  // Show unified game screen
  document.body.classList.add("game-active");
  screens.game.style.display = "flex";
  // Add enter animation class
  screens.game.classList.add("screen-enter");
  setTimeout(() => screens.game.classList.remove("screen-enter"), 200);
  updateGameUI();

  const hasClaimedPlayer = gameState.players.some(p => p.claimedBy === myClientId);
  if (gameState.status === "waiting" && !hasClaimedPlayer) {
    screens.game.classList.add("lobby-mode");
  } else {
    screens.game.classList.remove("lobby-mode");
  }
}

function updateTimes() {
  if (!gameState) return;

  // Update the unified game UI time display
  updateTimeDisplay();
  // Update other players' time in the small cards
  updateOtherPlayers();
}

function safeSend(message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(message));
    } catch (e) {
      console.error("Failed to send message:", e.message);
      showToast("Failed to send message. Please try again.");
    }
  } else {
    console.error("WebSocket not connected. State:", ws ? ws.readyState : "no socket");
    showToast("Not connected to server. Please wait...");
    // Show the connection status indicator so user can see connection state
    showConnectionStatus("disconnected", "Not connected");
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

// Admin controls
function sendAdminRevive(playerId) {
  safeSend({ type: "adminRevive", data: { playerId } });
}

function sendAdminKick(playerId) {
  safeSend({ type: "adminKick", data: { playerId } });
}

function sendAdminAddTime(playerId, minutes) {
  safeSend({ type: "adminAddTime", data: { playerId, minutes } });
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
  if (!settingsModal.modal) return;

  // Populate game code (make it copyable)
  if (gameState && settingsModal.gameCodeDisplay) {
    settingsModal.gameCodeDisplay.textContent = gameState.id;
    settingsModal.gameCodeDisplay.classList.add("copyable");
  }

  // Populate game name
  if (gameState && settingsModal.gameNameInput) {
    settingsModal.gameNameInput.value = (gameState.name && gameState.name !== "Game") ? gameState.name : "";
  }

  // Populate thresholds
  populateThresholds();

  // Populate bonus time
  if (settingsModal.bonusTimeInput && gameState) {
    const bonusSeconds = (gameState.settings?.bonusTime ?? 30000) / 1000;
    settingsModal.bonusTimeInput.value = bonusSeconds;
  }

  // Populate timeout penalty settings
  if (settingsModal.timeoutLivesInput && gameState) {
    settingsModal.timeoutLivesInput.value = gameState.settings?.timeoutPenaltyLives ?? 2;
  }
  if (settingsModal.timeoutDrunkInput && gameState) {
    settingsModal.timeoutDrunkInput.value = gameState.settings?.timeoutPenaltyDrunk ?? 2;
  }
  if (settingsModal.timeoutBonusTimeInput && gameState) {
    const bonusSeconds = (gameState.settings?.timeoutBonusTime ?? 60000) / 1000;
    settingsModal.timeoutBonusTimeInput.value = bonusSeconds;
  }

  // Populate color picker
  populateColorPicker();

  // Update pause button text
  updatePauseButton();

  // Show/hide random start button based on game state
  if (settingsModal.randomStartBtn && gameState) {
    const isWaiting = gameState.status === "waiting";
    const hasClaimedPlayers = gameState.players.some(p => p.claimedBy !== null);
    settingsModal.randomStartBtn.style.display = (isWaiting && hasClaimedPlayers) ? "flex" : "none";
  }

  // Show admin tab for all players
  if (settingsModal.adminTab) {
    settingsModal.adminTab.style.display = "";
  }

  // Populate admin dropdown
  populateAdminPlayerDropdown();

  // Reset to first tab
  switchSettingsTab("controls");

  settingsModal.modal.style.display = "flex";
}

function hideSettingsModal() {
  if (settingsModal.modal) {
    settingsModal.modal.style.display = "none";
  }
}

/**
 * Switch between settings tabs
 */
function switchSettingsTab(tabName) {
  // Update tab buttons
  settingsModal.tabs.forEach(tab => {
    const isActive = tab.dataset.tab === tabName;
    tab.classList.toggle("active", isActive);
    tab.setAttribute("aria-selected", isActive.toString());
  });

  // Update panels
  settingsModal.panels.forEach(panel => {
    const isActive = panel.dataset.panel === tabName;
    panel.classList.toggle("active", isActive);
    panel.hidden = !isActive;
  });
}

/**
 * Update the pause button text
 */
function updatePauseButton() {
  if (!gameState || !settingsModal.pauseBtn) return;

  const labelEl = settingsModal.pauseBtn.querySelector(".action-label");
  const iconEl = settingsModal.pauseBtn.querySelector(".action-icon");

  if (gameState.status === "paused") {
    if (labelEl) labelEl.textContent = "Resume";
    if (iconEl) iconEl.textContent = "▶";
  } else {
    if (labelEl) labelEl.textContent = "Pause";
    if (iconEl) iconEl.textContent = "⏸";
  }
}

/**
 * Populate the thresholds list
 */
function populateThresholds() {
  if (!gameState || !settingsModal.thresholdsContainer) return;

  const thresholds = gameState.settings?.warningThresholds || [300000, 60000, 30000];
  settingsModal.thresholdsContainer.innerHTML = "";

  thresholds.forEach((ms, index) => {
    const minutes = ms / 60000;
    addThresholdItem(minutes, index);
  });
}

/**
 * Add a threshold item to the list
 */
function addThresholdItem(value = 1, index = null) {
  const container = settingsModal.thresholdsContainer;
  if (!container) return;

  const item = document.createElement("div");
  item.className = "settings-threshold-item";
  item.dataset.index = index !== null ? index : container.children.length;

  item.innerHTML = `
    <input type="number" class="settings-threshold-input" value="${value}" min="0.1" step="0.1" />
    <span class="settings-threshold-unit">min</span>
    <button type="button" class="settings-threshold-remove" aria-label="Remove">&times;</button>
  `;

  item.querySelector(".settings-threshold-remove").addEventListener("click", () => {
    if (container.children.length > 1) {
      item.remove();
    }
  });

  container.appendChild(item);
}

/**
 * Get thresholds from UI
 */
function getThresholdsFromUI() {
  if (!settingsModal.thresholdsContainer) return [];

  const inputs = settingsModal.thresholdsContainer.querySelectorAll(".settings-threshold-input");
  const thresholds = [];

  inputs.forEach(input => {
    const minutes = parseFloat(input.value);
    if (!isNaN(minutes) && minutes > 0) {
      thresholds.push(Math.round(minutes * 60000));
    }
  });

  return [...new Set(thresholds)].sort((a, b) => b - a);
}

/**
 * Populate the admin player dropdown with all players
 */
function populateAdminPlayerDropdown() {
  const dropdown = settingsModal.adminPlayerDropdown;
  if (!dropdown || !gameState) return;

  dropdown.innerHTML = "";

  gameState.players.forEach(player => {
    const option = document.createElement("option");
    option.value = player.id;
    let label = player.name;
    if (player.isEliminated) {
      label += " (Eliminated)";
    }
    if (!player.claimedBy) {
      label += " (Unclaimed)";
    }
    option.textContent = label;
    dropdown.appendChild(option);
  });
}

/**
 * Populate the color picker
 */
function populateColorPicker() {
  if (!settingsModal.colorPicker) return;

  const container = settingsModal.colorPicker;
  container.innerHTML = "";

  const myPlayer = gameState?.players.find(p => p.claimedBy === myClientId);
  const currentColorId = myPlayer?.color || getPlayerColor(myPlayer || { id: 1 }).id;

  PLAYER_COLORS.forEach(color => {
    const option = document.createElement("div");
    option.className = "settings-color-option" + (color.id === currentColorId ? " selected" : "");
    option.style.background = `linear-gradient(135deg, ${color.primary} 0%, ${color.secondary} 100%)`;
    option.title = color.name;
    option.dataset.colorId = color.id;

    option.addEventListener("click", () => {
      // Update selection visually
      container.querySelectorAll(".settings-color-option").forEach(opt => {
        opt.classList.remove("selected");
      });
      option.classList.add("selected");
    });

    container.appendChild(option);
  });
}

/**
 * Get selected color from picker
 */
function getSelectedColor() {
  const selected = settingsModal.colorPicker?.querySelector(".settings-color-option.selected");
  return selected?.dataset.colorId || null;
}

/**
 * Save settings
 */
function saveSettings() {
  // Collect settings to update
  const settingsToUpdate = {};

  // Save thresholds
  const thresholds = getThresholdsFromUI();
  if (thresholds.length > 0) {
    settingsToUpdate.warningThresholds = thresholds;
  }

  // Save bonus time
  if (settingsModal.bonusTimeInput) {
    const bonusSeconds = parseInt(settingsModal.bonusTimeInput.value, 10) || 0;
    const bonusTime = Math.max(0, Math.min(bonusSeconds * 1000, 300000)); // 0-5 minutes in ms
    settingsToUpdate.bonusTime = bonusTime;
  }

  // Save timeout penalty settings
  if (settingsModal.timeoutLivesInput) {
    const lives = parseInt(settingsModal.timeoutLivesInput.value, 10) || 2;
    settingsToUpdate.timeoutPenaltyLives = Math.max(0, Math.min(lives, 20));
  }
  if (settingsModal.timeoutDrunkInput) {
    const drunk = parseInt(settingsModal.timeoutDrunkInput.value, 10) || 2;
    settingsToUpdate.timeoutPenaltyDrunk = Math.max(0, Math.min(drunk, 20));
  }
  if (settingsModal.timeoutBonusTimeInput) {
    const bonusSeconds = parseInt(settingsModal.timeoutBonusTimeInput.value, 10) || 60;
    settingsToUpdate.timeoutBonusTime = Math.max(0, Math.min(bonusSeconds * 1000, 300000));
  }

  // Send settings update if there are any changes
  if (Object.keys(settingsToUpdate).length > 0) {
    sendUpdateSettings(settingsToUpdate);
  }

  // Save game name
  const newName = settingsModal.gameNameInput?.value.trim();
  if (newName) {
    sendRenameGame(newName);
  }

  // Save color
  const selectedColor = getSelectedColor();
  const myPlayer = gameState?.players.find(p => p.claimedBy === myClientId);
  if (selectedColor && myPlayer) {
    sendUpdatePlayer(myPlayer.id, { color: selectedColor });
  }

  hideSettingsModal();
  playClick();
}

/**
 * Setup settings modal event listeners
 */
function setupSettingsEventListeners() {
  if (!settingsModal.modal) return;

  // Close button
  settingsModal.closeBtn?.addEventListener("click", () => {
    hideSettingsModal();
    playClick();
  });

  // Cancel button
  settingsModal.cancelBtn?.addEventListener("click", () => {
    hideSettingsModal();
    playClick();
  });

  // Save button
  settingsModal.saveBtn?.addEventListener("click", saveSettings);

  // Tab switching
  settingsModal.tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      switchSettingsTab(tab.dataset.tab);
      playClick();
      hapticFeedback("light");
    });
  });

  // Pause button
  settingsModal.pauseBtn?.addEventListener("click", () => {
    sendPause();
    playPauseResume();
    updatePauseButton();
    // Don't close modal, let user see the state change
    setTimeout(updatePauseButton, 100);
  });

  // Reset button
  settingsModal.resetBtn?.addEventListener("click", () => {
    if (confirm("Are you sure you want to reset the game?")) {
      sendReset();
      hideSettingsModal();
      playClick();
    }
  });

  // Random start button
  settingsModal.randomStartBtn?.addEventListener("click", () => {
    safeSend({ type: "randomStartPlayer", data: {} });
    hideSettingsModal();
    playClick();
  });

  // Add threshold button
  settingsModal.addThresholdBtn?.addEventListener("click", () => {
    addThresholdItem(1);
    playClick();
  });

  // Close lobby button
  settingsModal.closeLobbyBtn?.addEventListener("click", () => {
    if (confirm("Are you sure you want to close the lobby? This will end the game for all players.")) {
      sendEndGame();
      hideSettingsModal();
      playClick();
    }
  });

  // Close on backdrop click
  settingsModal.modal?.addEventListener("click", (e) => {
    if (e.target === settingsModal.modal) {
      hideSettingsModal();
    }
  });

  // Game code copy
  settingsModal.gameCodeDisplay?.addEventListener("click", copyGameCode);

  // Admin controls
  settingsModal.adminReviveBtn?.addEventListener("click", () => {
    const playerId = parseInt(settingsModal.adminPlayerDropdown?.value, 10);
    if (playerId) {
      sendAdminRevive(playerId);
      playClick();
    }
  });

  settingsModal.adminKickBtn?.addEventListener("click", () => {
    const playerId = parseInt(settingsModal.adminPlayerDropdown?.value, 10);
    if (playerId && confirm("Are you sure you want to kick this player?")) {
      sendAdminKick(playerId);
      playClick();
    }
  });

  settingsModal.adminAddTimeBtn?.addEventListener("click", () => {
    const playerId = parseInt(settingsModal.adminPlayerDropdown?.value, 10);
    const minutes = parseInt(settingsModal.adminTimeInput?.value, 10);
    if (playerId && minutes > 0) {
      sendAdminAddTime(playerId, minutes);
      playClick();
    }
  });
}

/**
 * Setup timeout choice modal event listeners
 */
function setupTimeoutChoiceEventListeners() {
  // Lose lives button
  timeoutChoiceModal.livesBtn?.addEventListener("click", () => {
    sendTimeoutChoice("loseLives");
    playClick();
  });

  // Gain drunk button
  timeoutChoiceModal.drunkBtn?.addEventListener("click", () => {
    sendTimeoutChoice("gainDrunk");
    playClick();
  });

  // Die button
  timeoutChoiceModal.dieBtn?.addEventListener("click", () => {
    sendTimeoutChoice("die");
    playClick();
  });
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
  }
  closeColorPicker();
}

function closeColorPicker() {
  colorPickerModal.modal.style.display = "none";
  selectedPlayerForColor = null;
}

function hideAllScreens() {
  Object.values(screens).forEach(screen => {
    if (screen) screen.style.display = "none";
  });
  // Remove game-active class when hiding screens
  document.body.classList.remove("game-active");
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

    const handleJoinClick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Visual feedback
      gameCard.style.opacity = "0.5";
      gameCard.style.pointerEvents = "none";
      setTimeout(() => {
        gameCard.style.opacity = "";
        gameCard.style.pointerEvents = "";
      }, 500);
      console.log("Joining game:", game.id);
      sendJoinGame(game.id);
    };

    gameCard.addEventListener("click", handleJoinClick);
    // Add touch support for mobile
    gameCard.addEventListener("touchend", (e) => {
      // Prevent double-firing with click
      e.preventDefault();
      handleJoinClick(e);
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

colorPickerModal.cancel.addEventListener("click", () => {
  closeColorPicker();
  playClick();
});

// Dice modal events
diceModal.closeBtn?.addEventListener("click", () => {
  closeDiceModal();
});

diceModal.select?.addEventListener("change", () => {
  handleDiceSelectChange();
});

diceModal.rollBtn?.addEventListener("click", () => {
  sendRollDice();
});

diceModal.customInput?.addEventListener("keydown", e => {
  if (e.key === "Enter") {
    e.preventDefault();
    sendRollDice();
  }
});

// Close dice modal on backdrop click
diceModal.modal?.addEventListener("click", e => {
  if (e.target === diceModal.modal) {
    closeDiceModal();
  }
});

// Click dice toast to dismiss
diceToast.element?.addEventListener("click", () => {
  hideDiceToast();
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

window.addEventListener("click", () => {
  if (!audioContext) {
    initAudio();
  }
});

// ============================================================================
// GAME UI FUNCTIONS
// ============================================================================

/**
 * Update the entire game UI based on current game state
 */
function updateGameUI() {
  if (!gameState || !gameUI.screen) return;

  // Update game paused state class
  const isPaused = gameState.status === "paused";
  gameUI.screen.classList.toggle("game-paused", isPaused);

  updateTimeDisplay();
  updateInteractionButton();
  updateOtherPlayers();
  updatePlayerStats();
  updateCampaignStats();
  updatePlayOrderButtonVisibility();
  updateHeaderPauseButton();
  updateTargetingUI();
}

/**
 * Update targeting-related UI elements (instructions banner and queue)
 */
function updateTargetingUI() {
  if (!gameState) {
    updateTargetingInstructions(null);
    updateTargetingQueue();
    return;
  }

  const myPlayer = gameState.players.find(p => p.claimedBy === myClientId);
  const isMyTurn = myPlayer && myPlayer.id === gameState.activePlayer;

  // Update targeting instructions
  if (gameState.targetingState === CONSTANTS.TARGETING.STATES.SELECTING && isMyTurn) {
    const targetCount = gameState.targetedPlayers?.length || 0;
    updateTargetingInstructions(
      `Select players to target (${targetCount} selected) - Tap to toggle, then Confirm`
    );
  } else if (gameState.targetingState === CONSTANTS.TARGETING.STATES.RESOLVING) {
    const awaitingCount = gameState.awaitingPriority?.length || 0;
    if (myPlayer && gameState.awaitingPriority?.includes(myPlayer.id)) {
      updateTargetingInstructions("Your turn to respond - Pass Priority when ready");
    } else {
      updateTargetingInstructions(`Waiting for ${awaitingCount} player(s) to respond...`);
    }
  } else {
    updateTargetingInstructions(null);
  }

  // Update targeting queue
  updateTargetingQueue();
}

/**
 * Update the time display with current player's time and state
 */
function updateTimeDisplay() {
  if (!gameState || !gameUI.timeValue) return;

  const myPlayer = gameState.players.find(p => p.claimedBy === myClientId);
  const activePlayer = gameState.players.find(p => p.id === gameState.activePlayer);
  const isWaiting = gameState.status === "waiting";
  const isPaused = gameState.status === "paused";

  // Show/hide dead banner for eliminated players
  if (gameUI.deadBanner) {
    const isEliminated = myPlayer && myPlayer.isEliminated;
    gameUI.deadBanner.style.display = isEliminated ? "" : "none";
  }

  // Remove all state classes
  gameUI.timeDisplay.classList.remove("warning", "critical", "paused", "my-action");
  gameUI.turnIndicator.classList.remove("my-action");

  if (isWaiting) {
    // Show game code in waiting state (copyable)
    gameUI.turnIndicator.textContent = `Code: ${gameState.id}`;
    gameUI.turnIndicator.classList.add("copyable");
    const claimedCount = gameState.players.filter(p => p.claimedBy !== null).length;
    gameUI.timeValue.textContent = `Waiting (${claimedCount}/${gameState.players.length})`;
  } else if (isPaused) {
    gameUI.turnIndicator.textContent = "GAME PAUSED";
    gameUI.turnIndicator.classList.remove("copyable");
    gameUI.timeValue.textContent = "--:--";
    gameUI.timeDisplay.classList.add("paused");
  } else if (gameState.status === "finished") {
    // Game is over - show winner or game over
    gameUI.turnIndicator.classList.remove("copyable");
    if (gameState.winner) {
      const winner = gameState.players.find(p => p.id === gameState.winner);
      const isMyWin = myPlayer && myPlayer.id === gameState.winner;
      if (isMyWin) {
        gameUI.turnIndicator.textContent = "🏆 VICTORY! 🏆";
        gameUI.turnIndicator.classList.add("my-action");
      } else if (winner) {
        gameUI.turnIndicator.textContent = `${winner.name} Wins!`;
      } else {
        gameUI.turnIndicator.textContent = "GAME OVER";
      }
    } else {
      gameUI.turnIndicator.textContent = "GAME OVER";
    }
    gameUI.timeValue.textContent = myPlayer ? formatTime(myPlayer.timeRemaining) : "--:--";
  } else if (myPlayer) {
    gameUI.turnIndicator.classList.remove("copyable");
    // Show time and turn indicator
    const isMyTurn = myPlayer.id === gameState.activePlayer;
    const timeRemaining = myPlayer.timeRemaining;

    // Check targeting state for turn indicator
    const targetingState = gameState.targetingState || CONSTANTS.TARGETING.STATES.NONE;
    const isResolving = targetingState === CONSTANTS.TARGETING.STATES.RESOLVING;
    const isSelecting = targetingState === CONSTANTS.TARGETING.STATES.SELECTING;
    const myAwaitingPriority = myPlayer && (gameState.awaitingPriority || []).includes(myPlayer.id);
    const isOriginalPlayer = myPlayer && gameState.originalActivePlayer === myPlayer.id;

    // Check interrupt state
    const hasInterrupts = gameState.interruptingPlayers && gameState.interruptingPlayers.length > 0;
    const interruptPriorityId = hasInterrupts
      ? gameState.interruptingPlayers[gameState.interruptingPlayers.length - 1]
      : null;
    const myHasInterruptPriority = myPlayer && myPlayer.id === interruptPriorityId;
    const myInInterruptQueue = myPlayer && gameState.interruptingPlayers &&
      gameState.interruptingPlayers.includes(myPlayer.id);

    // Update turn indicator based on targeting state and interrupts
    // Track if it's my action needed for highlighting
    let isMyAction = false;

    if (isResolving) {
      if (myHasInterruptPriority) {
        // I have interrupt priority during targeting
        gameUI.turnIndicator.textContent = "YOUR PRIORITY";
        isMyAction = true;
      } else if (hasInterrupts) {
        // Someone else has interrupt priority
        const interrupter = gameState.players.find(p => p.id === interruptPriorityId);
        if (interrupter) {
          gameUI.turnIndicator.textContent = `${interrupter.name}'s Priority`;
        }
      } else if (myAwaitingPriority && isMyTurn) {
        gameUI.turnIndicator.textContent = "RESPOND";
        isMyAction = true;
      } else if (myAwaitingPriority) {
        gameUI.turnIndicator.textContent = "WAITING TO RESPOND";
        isMyAction = true;
      } else if (isOriginalPlayer) {
        gameUI.turnIndicator.textContent = "AWAITING RESPONSES";
      } else if (activePlayer) {
        gameUI.turnIndicator.textContent = `${activePlayer.name} Responding`;
      }
    } else if (isSelecting) {
      if (isMyTurn) {
        gameUI.turnIndicator.textContent = "SELECT TARGETS";
        isMyAction = true;
      } else if (activePlayer) {
        gameUI.turnIndicator.textContent = `${activePlayer.name} Targeting`;
      }
    } else if (isMyTurn) {
      gameUI.turnIndicator.textContent = "YOUR TURN";
      isMyAction = true;
    } else if (activePlayer) {
      gameUI.turnIndicator.textContent = `${activePlayer.name}'s Turn`;
    }

    // Add/remove highlight class based on whether it's my action
    gameUI.turnIndicator.classList.toggle("my-action", isMyAction);
    gameUI.timeDisplay.classList.toggle("my-action", isMyAction);

    // Update time display with appropriate format and state
    if (timeRemaining < CONSTANTS.CRITICAL_THRESHOLD) {
      gameUI.timeValue.textContent = formatTimeWithDeciseconds(timeRemaining);
      gameUI.timeDisplay.classList.add("critical");
    } else if (timeRemaining < CONSTANTS.WARNING_THRESHOLD_1MIN) {
      gameUI.timeValue.textContent = formatTime(timeRemaining);
      gameUI.timeDisplay.classList.add("warning");
    } else {
      gameUI.timeValue.textContent = formatTime(timeRemaining);
    }
  } else {
    // No claimed player - spectator mode
    gameUI.turnIndicator.classList.remove("copyable");
    const availablePlayer = gameState.players.find(p => !p.claimedBy && !p.isEliminated);
    if (availablePlayer) {
      gameUI.turnIndicator.textContent = "JOIN GAME";
      gameUI.timeValue.textContent = "--:--";
    } else if (activePlayer) {
      gameUI.turnIndicator.textContent = `${activePlayer.name}'s Turn`;
      gameUI.timeValue.textContent = "SPECTATING";
    } else {
      gameUI.turnIndicator.textContent = "SPECTATING";
      gameUI.timeValue.textContent = "--:--";
    }
  }
}

/**
 * Update the interaction button based on game state
 */
function updateInteractionButton() {
  if (!gameState || !gameUI.interactionBtn) return;

  const myPlayer = gameState.players.find(p => p.claimedBy === myClientId);
  const activePlayer = gameState.players.find(p => p.id === gameState.activePlayer);
  const isMyTurn = myPlayer && myPlayer.id === gameState.activePlayer;
  const isWaiting = gameState.status === "waiting";
  const isPaused = gameState.status === "paused";
  const allPlayersClaimed = gameState.players.every(p => p.claimedBy !== null);

  // If game is finished and player is the winner, show winner button
  if (gameState.status === "finished" && myPlayer && gameState.winner === myPlayer.id) {
    gameUI.interactionBtn.classList.remove(
      "game-interaction-btn-pass",
      "game-interaction-btn-interrupt",
      "game-interaction-btn-priority",
      "game-interaction-btn-start",
      "game-interaction-btn-target",
      "game-interaction-btn-confirm"
    );
    gameUI.interactionBtn.classList.add("game-interaction-btn-winner");
    gameUI.interactionBtn.textContent = "🏆 WINNER 🏆";
    gameUI.interactionBtn.disabled = true;
    gameUI.interactionBtn.setAttribute("aria-label", "You are the winner!");
    if (gameUI.cancelTargetingBtn) {
      gameUI.cancelTargetingBtn.style.display = "none";
    }
    return;
  }

  // If player is eliminated, disable the button
  if (myPlayer && myPlayer.isEliminated) {
    gameUI.interactionBtn.classList.remove(
      "game-interaction-btn-pass",
      "game-interaction-btn-interrupt",
      "game-interaction-btn-priority",
      "game-interaction-btn-start",
      "game-interaction-btn-target",
      "game-interaction-btn-confirm",
      "game-interaction-btn-winner"
    );
    gameUI.interactionBtn.textContent = "ELIMINATED";
    gameUI.interactionBtn.disabled = true;
    gameUI.interactionBtn.setAttribute("aria-label", "You have been eliminated");
    if (gameUI.cancelTargetingBtn) {
      gameUI.cancelTargetingBtn.style.display = "none";
    }
    return;
  }

  // Targeting state checks
  const targetingState = gameState.targetingState || CONSTANTS.TARGETING.STATES.NONE;
  const isSelecting = targetingState === CONSTANTS.TARGETING.STATES.SELECTING;
  const isResolving = targetingState === CONSTANTS.TARGETING.STATES.RESOLVING;
  const targetCount = (gameState.targetedPlayers || []).length;
  const myAwaitingPriority = myPlayer && (gameState.awaitingPriority || []).includes(myPlayer.id);
  const isOriginalPlayer = myPlayer && gameState.originalActivePlayer === myPlayer.id;

  // Determine who has priority (for interrupt system)
  let priorityPlayerId = null;
  if (gameState.interruptingPlayers && gameState.interruptingPlayers.length > 0) {
    priorityPlayerId = gameState.interruptingPlayers[gameState.interruptingPlayers.length - 1];
  } else {
    priorityPlayerId = gameState.activePlayer;
  }
  const myHasPriority = myPlayer && myPlayer.id === priorityPlayerId;
  const myInInterruptQueue =
    myPlayer &&
    gameState.interruptingPlayers &&
    gameState.interruptingPlayers.includes(myPlayer.id);

  // Remove all variant classes
  gameUI.interactionBtn.classList.remove(
    "game-interaction-btn-pass",
    "game-interaction-btn-interrupt",
    "game-interaction-btn-priority",
    "game-interaction-btn-start",
    "game-interaction-btn-target",
    "game-interaction-btn-confirm",
    "game-interaction-btn-winner"
  );

  // Show cancel targeting button only during selection mode when it's my turn
  if (gameUI.cancelTargetingBtn) {
    if (isSelecting && isMyTurn) {
      gameUI.cancelTargetingBtn.style.display = "block";
    } else {
      gameUI.cancelTargetingBtn.style.display = "none";
    }
  }

  if (isWaiting) {
    // Start Game button
    gameUI.interactionBtn.textContent = "START GAME";
    gameUI.interactionBtn.classList.add("game-interaction-btn-start");
    gameUI.interactionBtn.disabled = !allPlayersClaimed;
    gameUI.interactionBtn.setAttribute("aria-label", allPlayersClaimed ? "Start the game" : "Waiting for all players to join");
  } else if (isPaused) {
    // Resume button
    gameUI.interactionBtn.textContent = "RESUME";
    gameUI.interactionBtn.classList.add("game-interaction-btn-start");
    gameUI.interactionBtn.disabled = false;
    gameUI.interactionBtn.setAttribute("aria-label", "Resume the game");
  } else if (isSelecting) {
    // Target selection mode
    if (isMyTurn) {
      if (targetCount === 0) {
        gameUI.interactionBtn.textContent = "SELECT TARGETS";
        gameUI.interactionBtn.classList.add("game-interaction-btn-target");
        gameUI.interactionBtn.disabled = true;
        gameUI.interactionBtn.setAttribute("aria-label", "Tap other players to select targets");
      } else {
        const label = targetCount === 1 ? "TARGET PLAYER" : `TARGET ${targetCount} PLAYERS`;
        gameUI.interactionBtn.textContent = label;
        gameUI.interactionBtn.classList.add("game-interaction-btn-confirm");
        gameUI.interactionBtn.disabled = false;
        gameUI.interactionBtn.setAttribute("aria-label", "Confirm selected targets");
      }
    } else {
      gameUI.interactionBtn.textContent = "SELECTING...";
      gameUI.interactionBtn.disabled = true;
      gameUI.interactionBtn.setAttribute("aria-label", "Waiting for target selection");
    }
  } else if (isResolving) {
    // Target resolution mode - ALL targeted players have priority simultaneously
    const hasInterrupts = gameState.interruptingPlayers && gameState.interruptingPlayers.length > 0;

    if (myHasPriority && myInInterruptQueue) {
      // I have interrupt priority - pass my interrupt
      gameUI.interactionBtn.textContent = "PASS PRIORITY";
      gameUI.interactionBtn.classList.add("game-interaction-btn-priority");
      gameUI.interactionBtn.disabled = false;
      gameUI.interactionBtn.setAttribute("aria-label", "Pass interrupt priority");
    } else if (myAwaitingPriority && !hasInterrupts) {
      // I'm a targeted player and no one has interrupted - pass target priority
      gameUI.interactionBtn.textContent = "PASS PRIORITY";
      gameUI.interactionBtn.classList.add("game-interaction-btn-priority");
      gameUI.interactionBtn.disabled = false;
      gameUI.interactionBtn.setAttribute("aria-label", "Pass priority");
    } else if (myAwaitingPriority && hasInterrupts) {
      // I'm a targeted player but someone interrupted - can interrupt back or wait
      gameUI.interactionBtn.textContent = "INTERRUPT";
      gameUI.interactionBtn.classList.add("game-interaction-btn-interrupt");
      gameUI.interactionBtn.disabled = false;
      gameUI.interactionBtn.setAttribute("aria-label", "Interrupt to respond");
    } else if (!myHasPriority) {
      // Original player or observer - can interrupt
      gameUI.interactionBtn.textContent = "INTERRUPT";
      gameUI.interactionBtn.classList.add("game-interaction-btn-interrupt");
      gameUI.interactionBtn.disabled = false;
      gameUI.interactionBtn.setAttribute("aria-label", "Interrupt to respond");
    } else {
      // Fallback - shouldn't normally reach here
      gameUI.interactionBtn.textContent = "WAITING...";
      gameUI.interactionBtn.disabled = true;
      gameUI.interactionBtn.setAttribute("aria-label", "Waiting for action");
    }
  } else if (myHasPriority && myInInterruptQueue) {
    // Pass Priority button (player has priority and is in interrupt queue)
    gameUI.interactionBtn.textContent = "PASS PRIORITY";
    gameUI.interactionBtn.classList.add("game-interaction-btn-priority");
    gameUI.interactionBtn.disabled = false;
    gameUI.interactionBtn.setAttribute("aria-label", "Pass priority to next player");
  } else if (isMyTurn && (!gameState.interruptingPlayers || gameState.interruptingPlayers.length === 0)) {
    // Pass Turn button (active player, no interrupts)
    gameUI.interactionBtn.textContent = "PASS TURN";
    gameUI.interactionBtn.classList.add("game-interaction-btn-pass");
    gameUI.interactionBtn.disabled = false;
    gameUI.interactionBtn.setAttribute("aria-label", "Pass turn to next player");
  } else if (myPlayer && !myHasPriority) {
    // Interrupt button (not my turn or someone else has priority)
    gameUI.interactionBtn.textContent = "INTERRUPT";
    gameUI.interactionBtn.classList.add("game-interaction-btn-interrupt");
    gameUI.interactionBtn.disabled = false;
    gameUI.interactionBtn.setAttribute("aria-label", "Interrupt and take priority");
  } else if (!myPlayer && !isWaiting) {
    // Spectator mode (no claimed player and game is running/paused/finished)
    const availablePlayer = gameState.players.find(p => !p.claimedBy && !p.isEliminated);
    if (availablePlayer) {
      gameUI.interactionBtn.textContent = "JOIN GAME";
      gameUI.interactionBtn.disabled = false;
      gameUI.interactionBtn.setAttribute("aria-label", "Join the game by claiming an available player");
    } else {
      gameUI.interactionBtn.textContent = "SPECTATING";
      gameUI.interactionBtn.disabled = true;
      gameUI.interactionBtn.setAttribute("aria-label", "You are spectating this game");
    }
  } else {
    // Disabled state (waiting for something)
    gameUI.interactionBtn.textContent = "WAITING...";
    gameUI.interactionBtn.disabled = true;
    gameUI.interactionBtn.setAttribute("aria-label", "Waiting for game action");
  }
}

/**
 * Update the other players section with compact cards
 */
function updateOtherPlayers() {
  if (!gameState || !gameUI.playerCards) return;

  const myPlayer = gameState.players.find(p => p.claimedBy === myClientId);
  const isWaiting = gameState.status === "waiting";
  const isPaused = gameState.status === "paused";

  // Without a claimed player, show all players so spectators can claim one
  // Otherwise, show only other players
  const playersToShow = (!myPlayer)
    ? gameState.players
    : gameState.players.filter(p => p.claimedBy !== myClientId);

  // Set player count for CSS-based sizing
  gameUI.playerCards.dataset.playerCount = playersToShow.length;

  // Check if we can update in place (same players)
  const existingCards = gameUI.playerCards.querySelectorAll(".game-player-card");
  const existingIds = Array.from(existingCards).map(c => parseInt(c.dataset.playerId));
  const newIds = playersToShow.map(p => p.id);
  const canUpdateInPlace = existingIds.length === newIds.length &&
    existingIds.every((id, i) => id === newIds[i]);

  if (canUpdateInPlace) {
    // Update existing cards in place
    existingCards.forEach(card => {
      const playerId = parseInt(card.dataset.playerId);
      const player = playersToShow.find(p => p.id === playerId);
      if (!player) return;

      const isClaimed = player.claimedBy !== null;
      const isMyPlayer = player.claimedBy === myClientId;
      const isActive = player.id === gameState.activePlayer;

      // Update life
      const lifeSpan = card.querySelector(".game-player-card-life");
      if (lifeSpan) lifeSpan.textContent = player.life;

      // Update time
      const timeSpan = card.querySelector(".game-player-card-time");
      if (timeSpan) {
        timeSpan.textContent = formatTimeCompact(player.timeRemaining);
      }

      // Update name (in case it changed)
      const nameSpan = card.querySelector(".game-player-card-name");
      if (nameSpan && nameSpan.textContent !== player.name) {
        nameSpan.textContent = player.name;
        nameSpan.title = player.name;
      }

      // Update state classes (including selectable/claimed-other)
      const isFinished = gameState.status === "finished";
      card.classList.remove("active", "eliminated", "paused", "critical", "warning", "targeted", "awaiting-priority", "original-player", "selectable-target", "selectable", "claimed-other");
      if (isActive && !isPaused && !isFinished) card.classList.add("active");
      if (player.isEliminated) {
        card.classList.add("eliminated");
        // Add dead banner if not present
        if (!card.querySelector(".game-player-card-dead-banner")) {
          const deadBanner = document.createElement("div");
          deadBanner.className = "game-player-card-dead-banner";
          deadBanner.textContent = "DEAD";
          card.appendChild(deadBanner);
        }
      } else {
        // Remove dead banner if present
        const existingBanner = card.querySelector(".game-player-card-dead-banner");
        if (existingBanner) existingBanner.remove();

        if (isPaused) {
          card.classList.add("paused");
        } else if (player.timeRemaining < CONSTANTS.CRITICAL_THRESHOLD) {
          card.classList.add("critical");
        } else if (player.timeRemaining < CONSTANTS.WARNING_THRESHOLD_1MIN) {
          card.classList.add("warning");
        }
      }

      // Waiting state - selectable/claimed styling
      if (isWaiting) {
        if (!isClaimed) {
          card.classList.add("selectable");
        } else if (!isMyPlayer) {
          card.classList.add("claimed-other");
        }
      } else if (!myPlayer && !isClaimed && !player.isEliminated) {
        // Spectator can claim unclaimed, non-eliminated players
        card.classList.add("selectable");
      }

      // Update targeting classes
      updateCardTargetingClasses(card, playerId);

      // Update status indicator
      const statusSpan = card.querySelector(".game-player-card-status");
      if (statusSpan) {
        const status = getPlayerStatusIcon(player, isActive, isPaused, isFinished);
        statusSpan.textContent = status.icon;
        statusSpan.className = "game-player-card-status";
        if (status.class) statusSpan.classList.add(status.class);
      }
    });
    return;
  }

  // Need to rebuild cards
  gameUI.playerCards.innerHTML = "";

  playersToShow.forEach(player => {
    const card = document.createElement("div");
    card.className = "game-player-card";
    card.dataset.playerId = player.id;
    card.setAttribute("role", "listitem");
    card.setAttribute("tabindex", "0");
    card.setAttribute("aria-label", `${player.name}, ${player.life} life${player.isEliminated ? ", eliminated" : ""}`);

    // Apply player color using CSS variable
    const playerColor = getPlayerColor(player);
    card.style.setProperty("--card-color", playerColor.primary);

    const isClaimed = player.claimedBy !== null;
    const isMyPlayer = player.claimedBy === myClientId;
    const isActive = player.id === gameState.activePlayer;
    const isFinished = gameState.status === "finished";

    // Apply state classes
    if (isActive && !isPaused && !isFinished) {
      card.classList.add("active");
    }

    if (player.isEliminated) {
      card.classList.add("eliminated");
      // Add dead banner
      const deadBanner = document.createElement("div");
      deadBanner.className = "game-player-card-dead-banner";
      deadBanner.textContent = "DEAD";
      card.appendChild(deadBanner);
    } else if (isPaused) {
      card.classList.add("paused");
    } else if (player.timeRemaining < CONSTANTS.CRITICAL_THRESHOLD) {
      card.classList.add("critical");
    } else if (player.timeRemaining < CONSTANTS.WARNING_THRESHOLD_1MIN) {
      card.classList.add("warning");
    }

    // Waiting state - selectable/claimed styling
    if (isWaiting) {
      if (!isClaimed) {
        card.classList.add("selectable");
      } else if (!isMyPlayer) {
        card.classList.add("claimed-other");
      }
    } else if (!myPlayer && !isClaimed && !player.isEliminated) {
      // Spectator can claim unclaimed, non-eliminated players
      card.classList.add("selectable");
    }

    // Apply targeting classes
    updateCardTargetingClasses(card, player.id);

    // Name
    const nameSpan = document.createElement("span");
    nameSpan.className = "game-player-card-name";
    nameSpan.textContent = player.name;
    nameSpan.title = player.name; // Full name on hover

    // Time display (compact format)
    const timeSpan = document.createElement("span");
    timeSpan.className = "game-player-card-time";
    timeSpan.textContent = formatTimeCompact(player.timeRemaining);

    // Life total
    const lifeSpan = document.createElement("span");
    lifeSpan.className = "game-player-card-life";
    lifeSpan.textContent = player.life;

    // Status indicator - show most important status
    const statusSpan = document.createElement("span");
    statusSpan.className = "game-player-card-status";

    const status = getPlayerStatusIcon(player, isActive, isPaused, isFinished);
    statusSpan.textContent = status.icon;
    if (status.class) {
      statusSpan.classList.add(status.class);
    }

    card.appendChild(nameSpan);
    card.appendChild(timeSpan);
    card.appendChild(lifeSpan);
    card.appendChild(statusSpan);

    // Click handler - check current game state, not stale closure variables
    card.addEventListener("click", (e) => {
      e.stopPropagation();
      // Check current game state to handle transitions properly
      const currentIsWaiting = gameState && gameState.status === "waiting";
      const currentPlayer = gameState && gameState.players.find(p => p.id === player.id);
      const currentIsClaimed = currentPlayer && currentPlayer.claimedBy !== null;
      const currentIsMyPlayer = currentPlayer && currentPlayer.claimedBy === myClientId;

      if (currentIsWaiting) {
        // In waiting state - claim/unclaim
        if (currentIsMyPlayer) {
          sendUnclaim();
          playClick();
        } else if (!currentIsClaimed) {
          sendClaim(player.id);
          playClick();
        }
      } else if (gameState && gameState.status === "running") {
        // Allow spectators to claim unclaimed, non-eliminated players
        const currentMyPlayer = gameState.players.find(p => p.claimedBy === myClientId);
        if (!currentMyPlayer && !currentIsClaimed && currentPlayer && !currentPlayer.isEliminated) {
          sendClaim(player.id);
          playClick();
          return;
        }
        // In game - check for targeting first
        const targetingHandled = handlePlayerCardTargetClick(player.id);
        if (!targetingHandled) {
          // Not in targeting mode - show player details popup
          showPlayerDetailsPopup(currentPlayer || player, card);
        }
      } else if (gameState && gameState.status === "paused") {
        // Allow spectators to claim unclaimed, non-eliminated players in paused state
        const currentMyPlayer = gameState.players.find(p => p.claimedBy === myClientId);
        if (!currentMyPlayer && !currentIsClaimed && currentPlayer && !currentPlayer.isEliminated) {
          sendClaim(player.id);
          playClick();
        }
      }
    });

    gameUI.playerCards.appendChild(card);
  });
}

/**
 * Format time in compact format (M:SS or S.s)
 */
function formatTimeCompact(ms) {
  if (ms < CONSTANTS.CRITICAL_THRESHOLD) {
    // Show seconds with deciseconds for critical time
    const seconds = Math.floor(ms / 1000);
    const deciseconds = Math.floor((ms % 1000) / 100);
    return `${seconds}.${deciseconds}`;
  }
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * Get the status icon and class for a player
 */
function getPlayerStatusIcon(player, isActive, isPaused, isFinished = false) {
  // Priority order: eliminated > paused > critical > warning > active > none
  if (player.isEliminated) {
    return { icon: "\u2620", class: "status-eliminated" }; // ☠
  }
  if (isPaused) {
    return { icon: "\u23F8", class: "status-paused" }; // ⏸
  }
  if (!player.isEliminated && player.timeRemaining < CONSTANTS.CRITICAL_THRESHOLD) {
    return { icon: "\u26A0", class: "status-critical" }; // ⚠
  }
  if (!player.isEliminated && player.timeRemaining < CONSTANTS.WARNING_THRESHOLD_1MIN) {
    return { icon: "\u26A0", class: "status-warning" }; // ⚠
  }
  if (isActive && !isFinished) {
    return { icon: "\u25CF", class: "status-active" }; // ●
  }
  return { icon: "", class: "" }; // No status
}

/**
 * Show player details popup near the tapped card
 */
function showPlayerDetailsPopup(player, cardElement) {
  const popup = document.getElementById("game-player-popup");
  if (!popup) return;

  // Update popup content
  const nameEl = popup.querySelector(".game-player-popup-name");
  const timeEl = popup.querySelector(".game-player-popup-time");
  const lifeEl = popup.querySelector(".game-player-popup-life");
  const drunkEl = popup.querySelector(".game-player-popup-drunk");
  const genericEl = popup.querySelector(".game-player-popup-generic");

  if (nameEl) nameEl.textContent = player.name;
  if (timeEl) timeEl.textContent = formatTime(player.timeRemaining);
  if (lifeEl) lifeEl.textContent = player.life;
  if (drunkEl) drunkEl.textContent = player.drunkCounter;
  if (genericEl) genericEl.textContent = player.genericCounter;

  // Position popup near the card
  const cardRect = cardElement.getBoundingClientRect();
  const popupContent = popup.querySelector(".game-player-popup-content");

  // Show popup to calculate its dimensions
  popup.style.display = "block";
  const popupRect = popupContent.getBoundingClientRect();

  // Calculate position - try to position above the card
  let top = cardRect.top - popupRect.height - 10;
  let left = cardRect.left + (cardRect.width / 2) - (popupRect.width / 2);

  // If popup would go above viewport, show below instead
  popup.classList.remove("popup-above");
  if (top < 10) {
    top = cardRect.bottom + 10;
    popup.classList.add("popup-above");
  }

  // Keep popup within horizontal bounds
  if (left < 10) {
    left = 10;
  } else if (left + popupRect.width > window.innerWidth - 10) {
    left = window.innerWidth - popupRect.width - 10;
  }

  popupContent.style.left = `${left}px`;
  popupContent.style.top = `${top}px`;

  // Close button handler
  const closeBtn = popup.querySelector(".game-player-popup-close");
  if (closeBtn) {
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      hidePlayerDetailsPopup();
    };
  }

  // Close on tap outside (delayed to prevent immediate close)
  setTimeout(() => {
    document.addEventListener("click", handlePopupOutsideClick);
    document.addEventListener("touchstart", handlePopupOutsideClick);
  }, 50);

  playClick();
}

/**
 * Hide the player details popup
 */
function hidePlayerDetailsPopup() {
  const popup = document.getElementById("game-player-popup");
  if (popup) {
    popup.style.display = "none";
  }
  document.removeEventListener("click", handlePopupOutsideClick);
  document.removeEventListener("touchstart", handlePopupOutsideClick);
}

/**
 * Handle clicks outside the popup to close it
 */
function handlePopupOutsideClick(e) {
  const popup = document.getElementById("game-player-popup");
  const popupContent = popup?.querySelector(".game-player-popup-content");

  if (popup && popupContent && !popupContent.contains(e.target)) {
    hidePlayerDetailsPopup();
  }
}

// Track previous stat values for change animation
const prevStatValues = { life: null, drunk: null, generic: null };

/**
 * Update the player stats bar with current player's life and counters
 */
function updatePlayerStats() {
  if (!gameState || !gameUI.playerStats) return;

  const myPlayer = gameState.players.find(p => p.claimedBy === myClientId);
  const isWaiting = gameState.status === "waiting";

  // Show/hide name row based on waiting state
  if (isWaiting && myPlayer) {
    gameUI.playerStats.classList.add("show-name");
  } else {
    gameUI.playerStats.classList.remove("show-name");
  }

  // Update player name display (only if user is not actively editing)
  const nameEditEl = gameUI.playerStats.querySelector(".game-player-name-edit");
  if (nameEditEl && myPlayer && document.activeElement !== nameEditEl) {
    nameEditEl.value = myPlayer.name;
  }

  if (!myPlayer) {
    // If game is running/paused/finished and no player claimed, hide stats entirely (spectator mode)
    if (!isWaiting) {
      gameUI.playerStats.style.display = "none";
      return;
    }

    // In waiting state, dim stats and reset to default values
    gameUI.playerStats.style.display = "";
    gameUI.playerStats.style.opacity = "0.5";

    // Reset displayed values to defaults
    const lifeValue = gameUI.lifeStat?.querySelector(".game-stat-value");
    if (lifeValue) {
      lifeValue.textContent = "20";
      lifeValue.classList.remove("negative");
    }
    const poisonValue = gameUI.poisonStat?.querySelector(".game-stat-value");
    if (poisonValue) poisonValue.textContent = "0";
    const genericValue = gameUI.genericStat?.querySelector(".game-stat-value");
    if (genericValue) genericValue.textContent = "0";

    // Reset cached values
    prevStatValues.life = null;
    prevStatValues.drunk = null;
    prevStatValues.generic = null;
    return;
  }

  // Ensure stats are visible when player is claimed
  gameUI.playerStats.style.display = "";

  gameUI.playerStats.style.opacity = "1";

  // Update life display with animation
  const lifeValue = gameUI.lifeStat?.querySelector(".game-stat-value");
  if (lifeValue) {
    updateStatValue(lifeValue, myPlayer.life, prevStatValues.life);
    prevStatValues.life = myPlayer.life;
    // Add negative class if life is negative
    lifeValue.classList.toggle("negative", myPlayer.life < 0);
  }

  // Update poison/drunk counter display with animation
  const poisonValue = gameUI.poisonStat?.querySelector(".game-stat-value");
  if (poisonValue) {
    updateStatValue(poisonValue, myPlayer.drunkCounter, prevStatValues.drunk);
    prevStatValues.drunk = myPlayer.drunkCounter;
  }

  // Update generic counter display with animation
  const genericValue = gameUI.genericStat?.querySelector(".game-stat-value");
  if (genericValue) {
    updateStatValue(genericValue, myPlayer.genericCounter, prevStatValues.generic);
    prevStatValues.generic = myPlayer.genericCounter;
  }
}

/**
 * Update campaign stats display (level, points, multiplier, battle progress)
 */
function updateCampaignStats() {
  if (!gameUI.campaignStats) return;

  const campaign = gameState?.campaign;
  const hasScoringData = campaign?.playerPoints && campaign?.playerLevels;

  if (gameState?.mode !== "campaign" || !hasScoringData) {
    gameUI.campaignStats.style.display = "none";
    return;
  }

  const myPlayer = gameState.players.find(p => p.claimedBy === myClientId);
  if (!myPlayer) {
    gameUI.campaignStats.style.display = "none";
    return;
  }

  gameUI.campaignStats.style.display = "flex";

  const pid = myPlayer.id;
  const level = campaign.playerLevels[pid] ?? 1;
  const points = campaign.playerPoints[pid] ?? 0;

  // Calculate effective multiplier (playerMult × battleMult)
  let effectiveMult = 0;
  if (campaign.config?.playerMultipliers && campaign.config?.battleMultipliers) {
    const tracker = campaign.damageTracker?.[pid] || {};
    const uniqueTargets = Object.values(tracker).filter(d => d > 0).length;
    const playerMult = campaign.config.playerMultipliers[uniqueTargets] ??
      campaign.config.playerMultipliers[Math.max(...Object.keys(campaign.config.playerMultipliers).map(Number))] ?? 1;
    const battleMult = campaign.config.battleMultipliers[campaign.currentRound] ?? 1;
    effectiveMult = playerMult * battleMult;
  }

  const battleText = `${campaign.currentRound}/${campaign.maxRounds}`;

  // Update each stat chip with animation
  const levelEl = gameUI.campaignStats.querySelector('[data-stat="level"] .game-campaign-stat-value');
  const pointsEl = gameUI.campaignStats.querySelector('[data-stat="points"] .game-campaign-stat-value');
  const multEl = gameUI.campaignStats.querySelector('[data-stat="multiplier"] .game-campaign-stat-value');
  const battleEl = gameUI.campaignStats.querySelector('[data-stat="battle"] .game-campaign-stat-value');

  if (levelEl) updateStatValue(levelEl, String(level), levelEl.textContent);
  if (pointsEl) updateStatValue(pointsEl, String(points), pointsEl.textContent);
  if (multEl) updateStatValue(multEl, effectiveMult.toFixed(1) + "x", multEl.textContent);
  if (battleEl) updateStatValue(battleEl, battleText, battleEl.textContent);
}

/**
 * Update a stat value element with bounce animation if changed
 */
function updateStatValue(element, newValue, oldValue) {
  element.textContent = newValue;

  // Animate if value changed
  if (oldValue !== null && oldValue !== newValue) {
    element.classList.remove("value-changed");
    // Trigger reflow to restart animation
    void element.offsetWidth;
    element.classList.add("value-changed");

    // Also flash the parent stat group
    const statGroup = element.closest(".game-stat-group");
    if (statGroup) {
      statGroup.classList.remove("value-flash");
      void statGroup.offsetWidth;
      statGroup.classList.add("value-flash");
      setTimeout(() => statGroup.classList.remove("value-flash"), 250);
    }

    // Remove class after animation completes
    setTimeout(() => {
      element.classList.remove("value-changed");
    }, 200);
  }
}

/**
 * Handle interaction button click
 */
function handleInteractionClick() {
  if (!gameState) return;

  const myPlayer = gameState.players.find(p => p.claimedBy === myClientId);
  const isWaiting = gameState.status === "waiting";
  const isPaused = gameState.status === "paused";
  const isMyTurn = myPlayer && myPlayer.id === gameState.activePlayer;

  // Targeting state checks
  const targetingState = gameState.targetingState || CONSTANTS.TARGETING.STATES.NONE;
  const isSelecting = targetingState === CONSTANTS.TARGETING.STATES.SELECTING;
  const isResolving = targetingState === CONSTANTS.TARGETING.STATES.RESOLVING;
  const targetCount = (gameState.targetedPlayers || []).length;
  const myAwaitingPriority = myPlayer && (gameState.awaitingPriority || []).includes(myPlayer.id);

  // Determine who has priority (for interrupt system)
  let priorityPlayerId = null;
  if (gameState.interruptingPlayers && gameState.interruptingPlayers.length > 0) {
    priorityPlayerId = gameState.interruptingPlayers[gameState.interruptingPlayers.length - 1];
  } else {
    priorityPlayerId = gameState.activePlayer;
  }
  const myHasPriority = myPlayer && myPlayer.id === priorityPlayerId;
  const myInInterruptQueue =
    myPlayer &&
    gameState.interruptingPlayers &&
    gameState.interruptingPlayers.includes(myPlayer.id);

  const hasInterrupts = gameState.interruptingPlayers && gameState.interruptingPlayers.length > 0;

  // Spectator joining: claim the first available player
  if (!myPlayer && !isWaiting) {
    const availablePlayer = gameState.players.find(p => !p.claimedBy && !p.isEliminated);
    if (availablePlayer) {
      sendClaim(availablePlayer.id);
      return;
    }
  }

  if (isWaiting) {
    sendStart();
  } else if (isPaused) {
    sendPause(); // Toggle pause to resume
    playPauseResume();
  } else if (isSelecting && isMyTurn && targetCount > 0) {
    // Confirm targets
    sendConfirmTargets();
  } else if (isResolving) {
    // During targeting resolution - handle interrupts and target priority
    if (myHasPriority && myInInterruptQueue) {
      // Pass interrupt priority
      safeSend({ type: "passPriority", data: {} });
    } else if (myAwaitingPriority && !hasInterrupts) {
      // Pass target priority - all targeted players can pass simultaneously
      sendPassTargetPriority();
    } else if (myPlayer && !myHasPriority) {
      // Interrupt during targeting resolution
      safeSend({ type: "interrupt", data: {} });
    }
  } else if (myHasPriority && myInInterruptQueue) {
    safeSend({ type: "passPriority", data: {} });
  } else if (myPlayer && myPlayer.id === gameState.activePlayer && !hasInterrupts) {
    // Only pass turn if active player AND no one has interrupted
    sendPassTurn();
  } else if (myPlayer && !myHasPriority) {
    safeSend({ type: "interrupt", data: {} });
  }

  playClick();
  hapticFeedback("medium");
}

/**
 * Setup game UI event listeners
 */
function setupGameEventListeners() {
  if (!gameUI.screen) return;

  // Exit button
  if (gameUI.exitBtn) {
    gameUI.exitBtn.addEventListener("click", () => {
      if (
        confirm(
          "Are you sure you want to return to the main menu? This will disconnect you from the current game."
        )
      ) {
        backToMenu();
      }
    });
  }

  // Settings button
  if (gameUI.settingsBtn) {
    gameUI.settingsBtn.addEventListener("click", () => {
      showSettingsModal();
      playClick();
    });
  }

  // Pause button (header)
  if (gameUI.pauseBtn) {
    gameUI.pauseBtn.addEventListener("click", () => {
      sendPause();
      playClick();
    });
  }

  // Dice button
  if (gameUI.diceBtn) {
    gameUI.diceBtn.addEventListener("click", () => {
      openDiceModal();
      playClick();
    });
  }

  // Play order button
  if (gameUI.playOrderBtn) {
    gameUI.playOrderBtn.addEventListener("click", () => {
      sendRollPlayOrder();
      playClick();
    });
  }

  // Cancel targeting button
  if (gameUI.cancelTargetingBtn) {
    gameUI.cancelTargetingBtn.addEventListener("click", () => {
      sendCancelTargeting();
      playClick();
    });
  }

  // Interaction button
  if (gameUI.interactionBtn) {
    gameUI.interactionBtn.addEventListener("click", handleInteractionClick);
  }

  // Turn indicator - tap to copy game code in waiting state
  if (gameUI.turnIndicator) {
    gameUI.turnIndicator.addEventListener("click", () => {
      if (gameUI.turnIndicator.classList.contains("copyable")) {
        copyGameCode();
      }
    });
  }

  // Player stats buttons
  setupStatButtons();
}

/**
 * Setup the player name edit input in the stats bar
 */
function setupNameEdit() {
  const nameInput = gameUI.playerStats?.querySelector(".game-player-name-edit");
  if (!nameInput) return;

  let originalName = "";

  nameInput.addEventListener("focus", () => {
    originalName = nameInput.value;
    setTimeout(() => nameInput.select(), 10);
  });

  nameInput.addEventListener("blur", () => {
    const newName = nameInput.value.trim();
    const myPlayer = gameState?.players.find(p => p.claimedBy === myClientId);
    if (myPlayer && newName && newName !== originalName) {
      sendUpdatePlayer(myPlayer.id, { name: newName });
      originalName = newName;
      nameInput.classList.add("saving");
      setTimeout(() => nameInput.classList.remove("saving"), 500);
    } else if (!newName) {
      nameInput.value = originalName;
    }
  });

  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      nameInput.blur();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      nameInput.value = originalName;
      nameInput.blur();
    }
  });
}

/**
 * Setup the +/- buttons for player stats
 */
function setupStatButtons() {
  if (!gameUI.playerStats) return;

  // Life controls
  const lifeControls = gameUI.lifeStat?.querySelectorAll(".game-stat-btn");
  if (lifeControls && lifeControls.length === 2) {
    lifeControls[0].addEventListener("click", () => {
      const myPlayer = gameState?.players.find(p => p.claimedBy === myClientId);
      if (myPlayer) {
        sendUpdatePlayer(myPlayer.id, { life: myPlayer.life - 1 });
        playClick();
        hapticFeedback("light");
      }
    });
    lifeControls[1].addEventListener("click", () => {
      const myPlayer = gameState?.players.find(p => p.claimedBy === myClientId);
      if (myPlayer) {
        sendUpdatePlayer(myPlayer.id, { life: myPlayer.life + 1 });
        playClick();
        hapticFeedback("light");
      }
    });
  }

  // Poison/Drunk controls
  const poisonControls = gameUI.poisonStat?.querySelectorAll(".game-stat-btn");
  if (poisonControls && poisonControls.length === 2) {
    poisonControls[0].addEventListener("click", () => {
      const myPlayer = gameState?.players.find(p => p.claimedBy === myClientId);
      if (myPlayer) {
        sendUpdatePlayer(myPlayer.id, { drunkCounter: Math.max(0, myPlayer.drunkCounter - 1) });
        playClick();
        hapticFeedback("light");
      }
    });
    poisonControls[1].addEventListener("click", () => {
      const myPlayer = gameState?.players.find(p => p.claimedBy === myClientId);
      if (myPlayer) {
        sendUpdatePlayer(myPlayer.id, { drunkCounter: myPlayer.drunkCounter + 1 });
        playClick();
        hapticFeedback("light");
      }
    });
  }

  // Generic counter controls
  const genericControls = gameUI.genericStat?.querySelectorAll(".game-stat-btn");
  if (genericControls && genericControls.length === 2) {
    genericControls[0].addEventListener("click", () => {
      const myPlayer = gameState?.players.find(p => p.claimedBy === myClientId);
      if (myPlayer) {
        sendUpdatePlayer(myPlayer.id, { genericCounter: Math.max(0, myPlayer.genericCounter - 1) });
        playClick();
        hapticFeedback("light");
      }
    });
    genericControls[1].addEventListener("click", () => {
      const myPlayer = gameState?.players.find(p => p.claimedBy === myClientId);
      if (myPlayer) {
        sendUpdatePlayer(myPlayer.id, { genericCounter: myPlayer.genericCounter + 1 });
        playClick();
        hapticFeedback("light");
      }
    });
  }
}

// Initialize game event listeners
setupGameEventListeners();
setupSettingsEventListeners();
setupTimeoutChoiceEventListeners();
setupNameEdit();

// Handle orientation changes to ensure layout recalculates
window.addEventListener("orientationchange", () => {
  // Wait for the orientation change to complete
  setTimeout(() => {
    if (gameState && screens.game.style.display !== "none") {
      updateGameUI();
    }
  }, 100);
});

// Also handle resize for desktop testing and non-standard orientation change behavior
let resizeTimeout;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    if (gameState && screens.game.style.display !== "none") {
      updateGameUI();
    }
  }, 150);
});

// Initialize connection status UI elements
initConnectionStatus();

// Connect to server
connect();
