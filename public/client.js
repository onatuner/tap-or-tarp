let ws;
let gameState = null;
const audioEnabled = true;
let audioContext;
let reconnectAttempts = 0;
let reconnectTimeout = null;
let volume = 0.5;
let myClientId = null;

const CONSTANTS = {
  RECONNECT_INITIAL_DELAY: 1000,
  RECONNECT_MAX_DELAY: 30000,
  TIME_ADJUSTMENT_MINUTES: 1,
  TIME_ADJUSTMENT_MS: 60000,
  WARNING_THRESHOLD_5MIN: 300000,
  WARNING_THRESHOLD_1MIN: 60000,
  CRITICAL_THRESHOLD: 60000,
  MINUTE_MS: 60000,
};

const setupScreen = document.getElementById("setup-screen");
const gameScreen = document.getElementById("game-screen");
const playersContainer = document.getElementById("players-container");
const gameCodeDisplay = document.getElementById("game-code-display");

const setupForm = {
  playerCount: document.getElementById("player-count"),
  initialTime: document.getElementById("initial-time"),
  penaltyType: document.getElementById("penalty-type"),
  deductionAmount: document.getElementById("deduction-amount"),
  deductionGroup: document.getElementById("deduction-group"),
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
  thresholds: document.getElementById("warning-thresholds"),
  volume: document.getElementById("volume"),
  save: document.getElementById("save-settings"),
  close: document.getElementById("close-settings"),
};

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
      break;
    case "error":
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
  }
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

  if (player.isEliminated) {
    card.classList.add("eliminated");
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

  setupScreen.style.display = "none";
  gameScreen.style.display = "block";
  gameCodeDisplay.textContent = gameState.id;

  // Show/hide lobby banner based on game status and player selection
  const lobbyBanner = document.getElementById("lobby-banner");
  const hasClaimedPlayer = gameState.players.some(p => p.claimedBy === myClientId);
  if (gameState.status === "waiting" && !hasClaimedPlayer) {
    lobbyBanner.style.display = "block";
    gameScreen.classList.add("lobby-mode");
  } else {
    lobbyBanner.style.display = "none";
    gameScreen.classList.remove("lobby-mode");
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

  if (gameState.status === "waiting") {
    controls.start.style.display = "inline-block";
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
    }
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
  settingsModal.modal.style.display = "flex";
}

function hideSettingsModal() {
  settingsModal.modal.style.display = "none";
}

function backToMenu() {
  setupScreen.style.display = "block";
  gameScreen.style.display = "none";
  gameState = null;
  setupForm.joinGame.value = "";
  playClick();
}

setupForm.penaltyType.addEventListener("change", e => {
  setupForm.deductionGroup.style.display = e.target.value === "time_deduction" ? "block" : "none";
});

setupForm.createGame.addEventListener("click", () => {
  const settings = {
    playerCount: parseInt(setupForm.playerCount.value),
    initialTime: parseInt(setupForm.initialTime.value) * 60 * 1000,
    penaltyType: setupForm.penaltyType.value,
    penaltyTimeDeduction: parseInt(setupForm.deductionAmount.value) * 60 * 1000,
  };
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
  const thresholdsValue = settingsModal.thresholds.value;
  const thresholds = thresholdsValue
    .split(",")
    .map(t => {
      const minutes = parseFloat(t.trim());
      return Math.round(minutes * 60 * 1000);
    })
    .filter(t => t > 0);

  if (thresholds.length > 0) {
    sendUpdateSettings({ warningThresholds: thresholds });
  }

  volume = parseFloat(settingsModal.volume.value);

  hideSettingsModal();
  playClick();
});

settingsModal.close.addEventListener("click", () => {
  hideSettingsModal();
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
  if (!gameState || setupScreen.style.display !== "none") return;

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
