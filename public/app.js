const socket = io();

// ---------- DOM elements ----------
const lobbyScreen = document.getElementById('lobbyScreen');
const gameScreen = document.getElementById('gameScreen');

const playerNameInput = document.getElementById('playerNameInput');
const roomCodeInput = document.getElementById('roomCodeInput');
const createRoomBtn = document.getElementById('createRoomBtn');
const joinRoomBtn = document.getElementById('joinRoomBtn');

const roomCodeDisplay = document.getElementById('roomCodeDisplay');
const myNameDisplay = document.getElementById('myName');
const myStatusDot = document.getElementById('myStatusDot');
const opponentStatusDot = document.getElementById('opponentStatusDot');
const opponentNameDisplay = document.getElementById('opponentName');

const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const localVideoContainer = document.getElementById('localVideoContainer');
const remoteVideoContainer = document.getElementById('remoteVideoContainer');
const cameraToggleBtn = document.getElementById('cameraToggleBtn');

const infoStrip = document.getElementById('infoStrip');

const centerBtn = document.getElementById('centerBtn');
const diceToggleBtn = document.getElementById('diceToggleBtn');
const endGameBtn = document.getElementById('endGameBtn');

const rockGroup = document.getElementById('rockGroup');
const paperGroup = document.getElementById('paperGroup');
const scissorsGroup = document.getElementById('scissorsGroup');
const allRingGroups = [rockGroup, paperGroup, scissorsGroup];
const aboutModal = document.getElementById('aboutModal');
const howModal = document.getElementById('howModal');

// Listen for service worker updates
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(reg => {
    // If a new service worker is found and it's waiting, show a prompt
    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          // New content available – show a toast or auto-refresh
          showUpdateToast();
        }
      });
    });

    // If a waiting worker was already found (e.g., on page load)
    if (reg.waiting) {
      showUpdateToast();
    }
  }).catch(err => console.log('SW registration failed', err));
}

function showUpdateToast() {
  // Create a simple overlay or banner
  const toast = document.createElement('div');
  toast.id = 'updateToast';
  toast.style.cssText = `
    position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
    background: #00e5ff; color: #0a0a0f; padding: 12px 24px;
    border-radius: 30px; font-weight: bold; z-index: 200;
    box-shadow: 0 4px 15px rgba(0,229,255,0.4);
    cursor: pointer; font-size: 0.9rem;
  `;
  toast.textContent = 'New version available – tap to refresh';
  toast.addEventListener('click', () => {
    // Send message to service worker to skip waiting and refresh
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ action: 'skipWaiting' });
    }
    window.location.reload();
  });
  document.body.appendChild(toast);
}
// ---------- State ----------
let iceServersCache = null;
let playerName = '';
let localStream = null;
let peer = null;
let currentRoom = null;
let roundOver = false;
let diceActive = false;
let muted = false;
let cameraOff = false;
let iAmReady = false;
let opponentReady = false;
let _isLeaving = false;

// ---------- LocalStorage ----------
const NAME_KEY = 'dareOrDie_playerName';
function saveName(name) { try { localStorage.setItem(NAME_KEY, name); } catch (e) {} }
function loadName() { try { return localStorage.getItem(NAME_KEY) || ''; } catch (e) { return ''; } }

playerNameInput.value = loadName();
playerName = playerNameInput.value.trim();
if (playerName) saveName(playerName);

// ---------- Lobby buttons ----------
function updateButtons() {
  const nameFilled = playerName.trim() !== '';
  const codeFilled = roomCodeInput.value.trim() !== '';
  createRoomBtn.disabled = !nameFilled || codeFilled;
  joinRoomBtn.disabled = !nameFilled || !codeFilled;
}
playerNameInput.addEventListener('input', () => {
  playerName = playerNameInput.value.trim();
  saveName(playerName);
  updateButtons();
});
roomCodeInput.addEventListener('input', updateButtons);
updateButtons();

// ---------- Helpers ----------
function setRingEnabled(enabled) {
  allRingGroups.forEach(g => g.classList.toggle('disabled', !enabled));
}

function showLobby() {
  _isLeaving = true;
  lobbyScreen.classList.add('active');
  gameScreen.classList.remove('active');
  setRingEnabled(false);
  iAmReady = false;
  opponentReady = false;
  currentRoom = null;
  const overlay = document.getElementById('remoteOverlay');
  if (overlay) overlay.remove();
  stopVideo();
  try { screen.orientation.unlock(); } catch (e) {}
}

function enterGame(roomId) {
  _isLeaving = false;
  currentRoom = roomId;
  roomCodeDisplay.textContent = `Room: ${roomId}`;
  myNameDisplay.textContent = playerName;
  myStatusDot.classList.remove('offline');
  opponentStatusDot.classList.remove('offline');
  lobbyScreen.classList.remove('active');
  gameScreen.classList.add('active');
  setRingEnabled(false);
  infoStrip.textContent = 'Waiting for game to start...';
  infoStrip.classList.remove('highlight');
  diceActive = false;
  diceToggleBtn.classList.remove('active');
  roundOver = false;
  centerBtn.textContent = muted ? '🔇' : '🎤';
  centerBtn.classList.remove('play-again', 'muted');
  const oldOverlay = document.getElementById('remoteOverlay');
  if (oldOverlay) oldOverlay.remove();
  try { screen.orientation.lock('portrait').catch(() => {}); } catch (e) {}
startLocalStream().then(() => {
  fetchIceServers().then(() => createPeer());
});
}

// ---------- Video ----------
async function startLocalStream() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
  video: { width: 640, height: 480, frameRate: 20 },
  audio: true
});
    const localVideoEl = document.getElementById('localVideo');
    localVideoEl.srcObject = localStream;
    localVideoEl.onloadedmetadata = () => {
      const placeholder = document.getElementById('localPlaceholder');
      if (placeholder) placeholder.style.display = 'none';
    };
  } catch (err) {
    console.error('Camera/mic access denied:', err);
    infoStrip.textContent = 'Camera/mic access is required.';
  }
}

async function fetchIceServers() {
  if (iceServersCache) return iceServersCache;
  const res = await fetch('/api/ice-servers');
  const data = await res.json();
  iceServersCache = data.iceServers;
  return iceServersCache;
}

async function createPeer() {
  const iceServers = await fetchIceServers();

  peer = new Peer(undefined, {
    config: { iceServers }
  });

  peer.on('open', (peerId) => {
    socket.emit('peer-id', peerId);
  });
  peer.on('call', (call) => {
    call.answer(localStream);
    call.on('stream', (remoteStream) => {
      const remoteVid = document.getElementById('remoteVideo');
      remoteVid.srcObject = remoteStream;
      remoteVid.onloadedmetadata = () => {
        const placeholder = document.getElementById('remotePlaceholder');
        if (placeholder) placeholder.style.display = 'none';
      };
    });
  });
  peer.on('error', (err) => console.error('PeerJS error:', err));
}

function callOpponent(opponentPeerId) {
  if (!localStream) return;
  const call = peer.call(opponentPeerId, localStream);
  call.on('stream', (remoteStream) => {
    const remoteVid = document.getElementById('remoteVideo');
    remoteVid.srcObject = remoteStream;
    remoteVid.onloadedmetadata = () => {
      const placeholder = document.getElementById('remotePlaceholder');
      if (placeholder) placeholder.style.display = 'none';
    };
  });
}

function stopVideo() {
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  if (peer) {
    peer.destroy();
    peer = null;
  }
}

// ---------- Info strip helpers ----------
let infoTimeout = null;
function clearInfoTimeout() {
  if (infoTimeout) { clearTimeout(infoTimeout); infoTimeout = null; }
}
function setInfo(text, highlight = false) {
  clearInfoTimeout();
  infoStrip.textContent = text;
  infoStrip.classList.toggle('highlight', highlight);
}
function animateInfo(lines, delayMs = 1200) {
  clearInfoTimeout();
  infoStrip.classList.add('highlight');
  infoStrip.textContent = '';
  let index = 0;
  function showNext() {
    if (index < lines.length) {
      infoStrip.textContent = lines[index];
      index++;
      infoTimeout = setTimeout(showNext, delayMs);
    } else {
      infoStrip.classList.remove('highlight');
    }
  }
  showNext();
}

function animateRoundResult(data) {
  const { yourMove, opponentMove, isWinner, isDraw, dareMode, dareText, winnerName } = data;
  const lines = [];
  if (isDraw) {
    lines.push(`🤝 Draw — ${yourMove} vs ${opponentMove}`);
  } else if (isWinner) {
    lines.push(`🎉 You won!`);
    lines.push(`${yourMove} beats ${opponentMove}`);
  } else {
    lines.push(`😞 You lost`);
    lines.push(`${yourMove} loses to ${opponentMove}`);
  }
  if (!isDraw) {
    if (dareMode && dareText) {
      lines.push(`Dare: ${dareText}`);
    } else if (!dareMode) {
      lines.push(isWinner ? 'Set a dare — discuss on video' : 'Wait for your dare');
    }
  }
  animateInfo(lines, 1500);
}

// ---------- Remote overlay ----------
function showRemoteOverlay(messageHTML) {
  const old = document.getElementById('remoteOverlay');
  if (old) old.remove();
  const remoteVid = document.getElementById('remoteVideo');
  if (remoteVid) remoteVid.srcObject = null;
  const remotePlaceholder = document.getElementById('remotePlaceholder');
  if (remotePlaceholder) remotePlaceholder.style.display = 'flex';
  const overlay = document.createElement('div');
  overlay.id = 'remoteOverlay';
  overlay.style.cssText = `
    position: absolute; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.85); display: flex; align-items: center;
    justify-content: center; text-align: center; z-index: 10;
    color: #fff; font-size: 1rem; padding: 10px; pointer-events: none;
    flex-direction: column; gap: 6px;
  `;
  overlay.innerHTML = messageHTML;
  remoteVideoContainer.appendChild(overlay);
}

// ---------- Socket.IO events ----------
socket.on('room-created', (roomId) => enterGame(roomId));
socket.on('room-joined', (roomId) => enterGame(roomId));

socket.on('player-joined', ({ name, isYou }) => {
  if (isYou) myNameDisplay.textContent = name;
});

socket.on('opponent-joined', (opponentName) => {
  opponentNameDisplay.textContent = opponentName;
  opponentStatusDot.classList.remove('offline');
});

socket.on('opponent-status', ({ connected }) => {
  opponentStatusDot.classList.toggle('offline', !connected);
});

socket.on('peer-id', (opponentPeerId) => {
  callOpponent(opponentPeerId);
});

socket.on('player-left', (leaverName) => {
  if (_isLeaving) return;
  opponentStatusDot.classList.add('offline');
  showRemoteOverlay(`<span style="font-size:1.5rem;">🔔</span><br><strong>${leaverName}</strong><br>left the room`);
  setInfo('Opponent left.');
  setRingEnabled(false);
  roundOver = true;
  centerBtn.textContent = '🏠';
  centerBtn.classList.add('play-again');
  centerBtn.onclick = () => {
    if (currentRoom) socket.emit('leave-room');
    showLobby();
  };
});

socket.on('opponent-disconnected', () => {
  if (_isLeaving) return;
  opponentStatusDot.classList.add('offline');
  showRemoteOverlay('<span style="font-size:1.5rem;">🔔</span><br><strong>Opponent</strong><br>disconnected');
  setInfo('Opponent disconnected.');
  setRingEnabled(false);
  roundOver = true;
  centerBtn.textContent = '🏠';
  centerBtn.classList.add('play-again');
  centerBtn.onclick = () => {
    if (currentRoom) socket.emit('leave-room');
    showLobby();
  };
});

socket.on('round-start', () => {
  roundOver = false;
  setRingEnabled(true);
  centerBtn.textContent = muted ? '🔇' : '🎤';
  centerBtn.classList.remove('play-again');
  if (muted) centerBtn.classList.add('muted');
  centerBtn.onclick = centerButtonHandler;
  setInfo('Choose your move!');
  iAmReady = false;
  opponentReady = false;
  const ov = document.getElementById('remoteOverlay');
  if (ov) ov.remove();
});

socket.on('opponent-moved', () => {
  if (!roundOver) setInfo('Opponent has chosen. Make your move!');
});

socket.on('move-accepted', (move) => {
  setRingEnabled(false);
  setInfo(`You chose ${move}. Waiting for opponent...`, true);
});

socket.on('round-result', (data) => {
  roundOver = true;
  setRingEnabled(false);
  animateRoundResult(data);
  centerBtn.textContent = '🔄';
  centerBtn.classList.add('play-again');
  centerBtn.classList.remove('muted');
  iAmReady = false;
  opponentReady = false;
  centerBtn.onclick = centerButtonHandler;

});

socket.on('ready-update', ({ ready, total }) => {
  if (ready === 2) {
    setInfo('Both ready! Starting new round...');
  } else if (ready === 1) {
    if (iAmReady) {
      setInfo('You are ready. Waiting for opponent...');
    } else {
      setInfo('Opponent is ready. Press ✅ when you\'re ready.');
    }
  }
});

socket.on('error', (msg) => alert(msg));

// ---------- Center button ----------
function centerButtonHandler() {
  centerBtn.onclick = centerButtonHandler;
  if (!currentRoom || !gameScreen.classList.contains('active')) return;

  if (roundOver) {
    if (!iAmReady) {
      iAmReady = true;
      socket.emit('ready-next');
      // Don't show info here – ready-update will handle it
    }
  } else {
    muted = !muted;
    if (muted) {
      centerBtn.textContent = '🔇';
      centerBtn.classList.add('muted');
      if (localStream) localStream.getAudioTracks()[0].enabled = false;
    } else {
      centerBtn.textContent = '🎤';
      centerBtn.classList.remove('muted');
      if (localStream) localStream.getAudioTracks()[0].enabled = true;
    }
  }
}

// ---------- User actions ----------
createRoomBtn.addEventListener('click', () => {
  if (createRoomBtn.disabled) return;
  socket.emit('create-room', playerName);
});

joinRoomBtn.addEventListener('click', () => {
  if (joinRoomBtn.disabled) return;
  const code = roomCodeInput.value.trim().toUpperCase();
  if (!code) { alert('Enter a room code'); return; }
  socket.emit('join-room', { roomId: code, playerName });
});

endGameBtn.addEventListener('click', () => {
  if (currentRoom) {
    socket.emit('leave-room');
  }
  showLobby();
  opponentStatusDot.classList.add('offline');
});

rockGroup.addEventListener('click', () => {
  if (roundOver) return;
  socket.emit('choose-move', 'rock');
});
paperGroup.addEventListener('click', () => {
  if (roundOver) return;
  socket.emit('choose-move', 'paper');
});
scissorsGroup.addEventListener('click', () => {
  if (roundOver) return;
  socket.emit('choose-move', 'scissors');
});


diceToggleBtn.addEventListener('click', () => {
  diceActive = !diceActive;
  diceToggleBtn.classList.toggle('active', diceActive);
  socket.emit('toggle-dare-mode', diceActive);
});

// Share room
const shareRoomBtn = document.getElementById('shareRoomBtn');
shareRoomBtn.addEventListener('click', () => {
  if (!currentRoom) return;
  const shareData = {
    title: 'Dare Play – join my room!',
    text: `Room code: ${currentRoom}`,
    url: window.location.origin + '?room=' + currentRoom
  };
  if (navigator.share) {
    navigator.share(shareData).catch(err => console.log(err));
  } else {
    // Fallback: copy room code
    navigator.clipboard.writeText(currentRoom).then(() => {
      alert('Room code copied: ' + currentRoom);
    }).catch(() => {
      prompt('Copy this room code:', currentRoom);
    });
  }
});

cameraToggleBtn.addEventListener('click', () => {
  cameraOff = !cameraOff;
  localVideoContainer.classList.toggle('camera-off', cameraOff);
  cameraToggleBtn.textContent = cameraOff ? '❌' : '📷';
  if (localStream) localStream.getVideoTracks()[0].enabled = !cameraOff;
});
// ---------- Modals ----------

document.getElementById('closeAbout').addEventListener('click', () => {
  aboutModal.classList.remove('active');
});
document.getElementById('closeHow').addEventListener('click', () => {
  howModal.classList.remove('active');
});

// Lobby footer links (update the hrefs to trigger modals)
document.querySelectorAll('.lobby-footer a').forEach(link => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    if (link.textContent === 'How to play') {
      howModal.classList.add('active');
    } else if (link.textContent === 'About') {
      aboutModal.classList.add('active');
    }
  });
});

// Add these to the existing modal section
document.getElementById('closeAboutBtn').addEventListener('click', () => {
  aboutModal.classList.remove('active');
});
document.getElementById('closeHowBtn').addEventListener('click', () => {
  howModal.classList.remove('active');
});

// ---------- Auto‑join from shared link ----------
function tryAutoJoin() {
  const urlParams = new URLSearchParams(window.location.search);
  const roomFromUrl = urlParams.get('room');
  if (!roomFromUrl) return;

  // Pre‑fill the room code input
  roomCodeInput.value = roomFromUrl.toUpperCase();
  // Trigger the input event so button states update
  roomCodeInput.dispatchEvent(new Event('input'));

  // If a name is already saved, attempt to join immediately
  const savedName = loadName();
  if (savedName) {
    playerNameInput.value = savedName;
    playerName = savedName;
    playerNameInput.dispatchEvent(new Event('input'));
    socket.emit('join-room', { roomId: roomFromUrl.toUpperCase(), playerName: savedName });
  } else {
    // Focus the name input so the user can type it
    playerNameInput.focus();
    // When they finish typing, the normal Join button will work
  }
}
// Wait a tick for the DOM and socket to be ready
setTimeout(tryAutoJoin, 500);