let ws;
let gameState = null;
let audioEnabled = true;
let audioContext;
let reconnectAttempts = 0;
let reconnectTimeout = null;
let volume = 0.5;
let myPlayerId = null;

const CONSTANTS = {
  RECONNECT_INITIAL_DELAY: 1000,
  RECONNECT_MAX_DELAY: 30000,
  TIME_ADJUSTMENT_MINUTES: 1,
  TIME_ADJUSTMENT_MS: 60000,
  WARNING_THRESHOLD_5MIN: 300000,
  WARNING_THRESHOLD_1MIN: 60000,
  CRITICAL_THRESHOLD: 60000,
  MINUTE_MS: 60000
};

const setupScreen = document.getElementById('setup-screen');
const gameScreen = document.getElementById('game-screen');
const playersContainer = document.getElementById('players-container');
const gameCodeDisplay = document.getElementById('game-code-display');

const setupForm = {
  playerCount: document.getElementById('player-count'),
  initialTime: document.getElementById('initial-time'),
  penaltyType: document.getElementById('penalty-type'),
  deductionAmount: document.getElementById('deduction-amount'),
  deductionGroup: document.getElementById('deduction-group'),
  joinGame: document.getElementById('join-game'),
  createGame: document.getElementById('create-game'),
  joinBtn: document.getElementById('join-btn')
};

const controls = {
  pause: document.getElementById('pause-btn'),
  reset: document.getElementById('reset-btn'),
  settings: document.getElementById('settings-btn'),
  mute: document.getElementById('mute-btn')
};

const settingsModal = {
  modal: document.getElementById('settings-modal'),
  thresholds: document.getElementById('warning-thresholds'),
  volume: document.getElementById('volume'),
  save: document.getElementById('save-settings'),
  close: document.getElementById('close-settings')
};

const timeoutModal = {
  modal: document.getElementById('timeout-modal'),
  message: document.getElementById('timeout-message'),
  acknowledge: document.getElementById('acknowledge-timeout')
};

function initAudio() {
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
}

function playTone(frequency, duration, type = 'sine') {
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
  playTone(200, 0.5, 'square');
  setTimeout(() => playTone(200, 0.5, 'square'), 500);
  setTimeout(() => playTone(200, 0.5, 'square'), 1000);
  setTimeout(() => playTone(200, 1.0, 'square'), 1500);
}

function playClick() {
  playTone(600, 0.1);
}

function playPauseResume() {
  playTone(523.25, 0.15);
  setTimeout(() => playTone(659.25, 0.15), 100);
}

function loadMyPlayerId() {
  const savedId = localStorage.getItem('myPlayerId');
  if (savedId) {
    myPlayerId = parseInt(savedId);
  }
}

function saveMyPlayerId(playerId) {
  if (playerId === null) {
    localStorage.removeItem('myPlayerId');
  } else {
    localStorage.setItem('myPlayerId', playerId.toString());
  }
  myPlayerId = playerId;
}

function connect() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}`);
  
  ws.onopen = () => {
    console.log('Connected to server');
    reconnectAttempts = 0;
  };
  
  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      handleMessage(message);
    } catch (e) {
      console.error('Invalid JSON received:', e.message);
    }
  };
  
  ws.onclose = () => {
    console.log('Disconnected from server');
    const delay = Math.min(CONSTANTS.RECONNECT_INITIAL_DELAY * Math.pow(2, reconnectAttempts), CONSTANTS.RECONNECT_MAX_DELAY);
    reconnectAttempts++;
    console.log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    reconnectTimeout = setTimeout(connect, delay);
  };
  
  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
  };
}

function handleMessage(message) {
  switch (message.type) {
    case 'error':
      alert(message.data.message);
      break;
    case 'state':
      gameState = message.data;
      renderGame();
      break;
    case 'tick':
      if (gameState) {
        gameState.players.forEach(player => {
          if (message.data.times[player.id] !== undefined) {
            player.timeRemaining = message.data.times[player.id];
          }
        });
        updateTimes();
      }
      break;
    case 'timeout':
      if (gameState) {
        const player = gameState.players.find(p => p.id === message.data.playerId);
        if (player) {
          showTimeoutModal(player);
          playTimeout();
        }
      }
      break;
    case 'warning':
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
  if (milliseconds <= 0) return '0:00';
  
  const totalSeconds = Math.ceil(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function formatTimeWithDeciseconds(milliseconds) {
  if (milliseconds <= 0) return '0:00.0';
  
  const totalSeconds = milliseconds / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const deciseconds = Math.floor((milliseconds % 1000) / 100);
  
  return `${minutes}:${seconds.toString().padStart(2, '0')}.${deciseconds}`;
}

function createPlayerCard(player, isActive) {
  const card = document.createElement('div');
  card.className = 'player-card';
  card.dataset.playerId = player.id;
  
  if (player.isEliminated) {
    card.classList.add('eliminated');
  }
  
  if (isActive) {
    card.classList.add('active');
  }
  
  if (player.id === myPlayerId) {
    card.classList.add('my-player');
  }
  
  if (gameState.status === 'paused' && isActive) {
    card.classList.add('paused');
  }
  
  if (player.timeRemaining < CONSTANTS.CRITICAL_THRESHOLD) {
    card.classList.add('critical');
  } else if (player.timeRemaining < CONSTANTS.WARNING_THRESHOLD_5MIN) {
    card.classList.add('warning');
  }
  
  if (player.timeRemaining === 0 && !player.isEliminated) {
    card.classList.add('timeout');
  }
  
  const nameContainer = document.createElement('div');
  nameContainer.className = 'player-name';
  
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = player.name;
  nameInput.addEventListener('change', (e) => {
    sendUpdatePlayer(player.id, { name: e.target.value });
  });
  
  const statusSpan = document.createElement('span');
  if (player.id === myPlayerId) {
    const youIndicator = document.createElement('span');
    youIndicator.className = 'you-indicator';
    youIndicator.textContent = 'YOU';
    statusSpan.appendChild(youIndicator);
  }
  if (isActive) {
    const activeIndicator = document.createElement('span');
    activeIndicator.className = 'active-indicator';
    activeIndicator.textContent = 'ACTIVE';
    statusSpan.appendChild(activeIndicator);
  }
  
  nameContainer.appendChild(nameInput);
  nameContainer.appendChild(statusSpan);
  card.appendChild(nameContainer);
  
  const timeDisplay = document.createElement('div');
  timeDisplay.className = 'player-time';
  if (player.timeRemaining < CONSTANTS.CRITICAL_THRESHOLD) {
    timeDisplay.classList.add('deciseconds');
    timeDisplay.textContent = formatTimeWithDeciseconds(player.timeRemaining);
  } else {
    timeDisplay.textContent = formatTime(player.timeRemaining);
  }
  card.appendChild(timeDisplay);
  
  const timeControls = document.createElement('div');
  timeControls.className = 'time-controls';
  
  const addTimeBtn = document.createElement('button');
  addTimeBtn.className = 'btn btn-secondary';
  addTimeBtn.textContent = '+1:00';
  addTimeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    sendUpdatePlayer(player.id, { time: player.timeRemaining + CONSTANTS.TIME_ADJUSTMENT_MS });
  });
  
  const subtractTimeBtn = document.createElement('button');
  subtractTimeBtn.className = 'btn btn-secondary';
  subtractTimeBtn.textContent = '-1:00';
  subtractTimeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    sendUpdatePlayer(player.id, { time: Math.max(0, player.timeRemaining - CONSTANTS.TIME_ADJUSTMENT_MS) });
  });
  
  timeControls.appendChild(addTimeBtn);
  timeControls.appendChild(subtractTimeBtn);
  card.appendChild(timeControls);
  
  const status = document.createElement('div');
  status.className = 'player-status';
  status.innerHTML = `Penalties: <span class="penalties">${player.penalties}</span>`;
  card.appendChild(status);
  
  card.addEventListener('click', () => {
    sendSwitchPlayer(player.id);
    playClick();
  });
  
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (player.id === myPlayerId) {
      saveMyPlayerId(null);
    } else {
      saveMyPlayerId(player.id);
    }
    renderGame();
    playClick();
  });
  
  return card;
}

function renderGame() {
  if (!gameState) return;
  
  setupScreen.style.display = 'none';
  gameScreen.style.display = 'block';
  gameCodeDisplay.textContent = gameState.id;
  
  playersContainer.innerHTML = '';
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
  
  const cards = playersContainer.querySelectorAll('.player-card');
  cards.forEach(card => {
    const playerId = parseInt(card.dataset.playerId);
    const player = gameState.players.find(p => p.id === playerId);
    
    if (player) {
      const timeDisplay = card.querySelector('.player-time');
      
      if (player.timeRemaining < CONSTANTS.CRITICAL_THRESHOLD) {
        timeDisplay.classList.add('deciseconds');
        timeDisplay.textContent = formatTimeWithDeciseconds(player.timeRemaining);
      } else {
        timeDisplay.classList.remove('deciseconds');
        timeDisplay.textContent = formatTime(player.timeRemaining);
      }
      
      card.classList.remove('warning', 'critical', 'timeout');
      
      if (player.timeRemaining === 0 && !player.isEliminated) {
        card.classList.add('timeout');
      } else if (player.timeRemaining < CONSTANTS.CRITICAL_THRESHOLD) {
        card.classList.add('critical');
      } else if (player.timeRemaining < CONSTANTS.WARNING_THRESHOLD_5MIN) {
        card.classList.add('warning');
      }
    }
  });
}

function updateControls() {
  if (!gameState) return;
  
  controls.pause.textContent = gameState.status === 'paused' ? 'Resume' : 'Pause';
  controls.mute.textContent = audioEnabled ? 'Mute' : 'Unmute';
}

function safeSend(message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(message));
    } catch (e) {
      console.error('Failed to send message:', e.message);
    }
  }
}

function sendCreateGame(settings) {
  safeSend({ type: 'create', data: { settings } });
}

function sendJoinGame(gameId) {
  safeSend({ type: 'join', data: { gameId } });
}

function sendPause() {
  safeSend({ type: 'pause' });
}

function sendReset() {
  safeSend({ type: 'reset' });
}

function sendSwitchPlayer(playerId) {
  safeSend({ type: 'switch', data: { playerId } });
}

function sendUpdatePlayer(playerId, updates) {
  safeSend({ type: 'updatePlayer', data: { playerId, ...updates } });
}

function sendUpdateSettings(settings) {
  safeSend({ type: 'updateSettings', data: settings });
}

function showTimeoutModal(player) {
  timeoutModal.message.textContent = `${player.name} has run out of time!`;
  timeoutModal.modal.style.display = 'flex';
}

function hideTimeoutModal() {
  timeoutModal.modal.style.display = 'none';
}

function showSettingsModal() {
  settingsModal.modal.style.display = 'flex';
}

function hideSettingsModal() {
  settingsModal.modal.style.display = 'none';
}

setupForm.penaltyType.addEventListener('change', (e) => {
  setupForm.deductionGroup.style.display = 
    e.target.value === 'time_deduction' ? 'block' : 'none';
});

setupForm.createGame.addEventListener('click', () => {
  const settings = {
    playerCount: parseInt(setupForm.playerCount.value),
    initialTime: parseInt(setupForm.initialTime.value) * 60 * 1000,
    penaltyType: setupForm.penaltyType.value,
    penaltyTimeDeduction: parseInt(setupForm.deductionAmount.value) * 60 * 1000
  };
  sendCreateGame(settings);
});

setupForm.joinBtn.addEventListener('click', () => {
  const gameId = setupForm.joinGame.value.trim().toUpperCase();
  if (gameId) {
    sendJoinGame(gameId);
  }
});

controls.pause.addEventListener('click', () => {
  sendPause();
  playPauseResume();
});

controls.reset.addEventListener('click', () => {
  if (confirm('Are you sure you want to reset the game?')) {
    sendReset();
    playClick();
  }
});

controls.settings.addEventListener('click', () => {
  showSettingsModal();
  playClick();
});

controls.mute.addEventListener('click', () => {
  audioEnabled = !audioEnabled;
  updateControls();
  playClick();
});

settingsModal.save.addEventListener('click', () => {
  const thresholdsValue = settingsModal.thresholds.value;
  const thresholds = thresholdsValue.split(',').map(t => {
    const minutes = parseFloat(t.trim());
    return Math.round(minutes * 60 * 1000);
  }).filter(t => t > 0);
  
  if (thresholds.length > 0) {
    sendUpdateSettings({ warningThresholds: thresholds });
  }
  
  volume = parseFloat(settingsModal.volume.value);
  
  hideSettingsModal();
  playClick();
});

settingsModal.close.addEventListener('click', () => {
  hideSettingsModal();
  playClick();
});

timeoutModal.acknowledge.addEventListener('click', () => {
  hideTimeoutModal();
  playClick();
});

document.addEventListener('keydown', (e) => {
  if (!gameState || setupScreen.style.display !== 'none') return;
  
  if (e.code === 'Space') {
    e.preventDefault();
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
  } else if (e.code === 'KeyP') {
    e.preventDefault();
    sendPause();
    playClick();
  } else if (e.code === 'KeyM') {
    e.preventDefault();
    audioEnabled = !audioEnabled;
    updateControls();
    playClick();
  } else if (e.key >= '1' && e.key <= '8') {
    const playerId = parseInt(e.key);
    const player = gameState.players.find(p => p.id === playerId);
    if (player && !player.isEliminated) {
      sendSwitchPlayer(playerId);
      playClick();
    }
  }
});

window.addEventListener('click', () => {
  if (!audioContext) {
    initAudio();
  }
});

loadMyPlayerId();
connect();
