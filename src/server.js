/* Copyright (c) 2025, SECOM CO., LTD.
SPDX-License-Identifier: MIT
*/

// server.js (ESM) — MALWAKARI
import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Resolve __dirname in ESM context
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Express and HTTP server
const app = express();
const server = http.createServer(app);

// Initialize Socket.IO with permissive CORS settings
const io = new SocketIOServer(server, {
  cors: { origin: true, credentials: true }
});

// Middleware setup
app.use(cors()); // Enable CORS for all origins
app.use(express.json()); // Parse JSON request bodies
app.use(express.static('public')); // Serve static files from /public

// Specify the JSON file to load
const f_json = 'sample_challenges.json'; // default: 'sample_challenges.json'

// Shared state containers
const rooms = new Map(); // roomId → roomData
const socketToRoom = new Map(); // socketId → roomId
const socketToRole = new Map(); // socketId → role (e.g., 'MAL' or '狩')
const roomTimers = new Map(); // roomId → setInterval reference

// Utility functions
const save = (id, r) => rooms.set(id, r); // Save room state
const stopTimer = id => {
  if (roomTimers.has(id)) {
    clearInterval(roomTimers.get(id));
    roomTimers.delete(id);
  }
};
const sys = (id, msg) => io.to(id).emit('system', { message: msg }); // Emit system message to room

// Load challenge definitions from JSON file
const CHALLENGES_PATH = path.join(__dirname, 'challenges', f_json);
let challenges = [];
try {
  challenges = JSON.parse(fs.readFileSync(CHALLENGES_PATH, 'utf-8'));
} catch (err) {
  console.error('検体読み込み失敗:', err);
  challenges = [];
}

// Normalize input string (null-safe, trimmed)
const normalize = s => (s ?? '').toString().trim();

// Pick a random unused challenge index for a room
const pickRandomUnusedIndex = r => {
  const n = challenges.length;
  if (n <= 1) return 0;
  r.usedIndices ??= [];
  const remain = [...Array(n).keys()].filter(i => !r.usedIndices.includes(i));
  if (!remain.length) {

    // Reset used indices if all challenges have been used
    r.usedIndices = [];
    return Math.floor(Math.random() * n);
  }
  return remain[Math.floor(Math.random() * remain.length)];
};

// Match user answer against challenge configuration
const matchAnswer = (conf, ans) => {
  if (!conf || !ans) return false;
  const f = normalize(ans);
  if (conf.type === 'regex') {

    // Support optional (?i) inline flag for case-insensitive matching
    let pat = conf.pattern || '';
    let flg = conf.flags || '';
    if (/^\(\?i\)/.test(pat)) {
      if (!flg.includes('i')) flg += 'i';
      pat = pat.replace(/^\(\?i\)/, '');
    }
    try {
      return new RegExp(pat, flg).test(f);
    } catch {
      return false;
    }
  }
  if (conf.type === 'exact') {

    // Case-insensitive exact match
    return f.toLowerCase() === (conf.value ?? '').toLowerCase();
  }
  return false;
};

// Game progression timer loop
function startTimer(roomId) {
  const r = rooms.get(roomId); if (!r) return;
  stopTimer(roomId); // Clear any existing timer for this room
  const interval = setInterval(() => {
    const rm = rooms.get(roomId);
    if (!rm || rm.status !== 'playing') { stopTimer(roomId); return; }
    const remainMs = Math.max(0, rm.expiresAt - Date.now());
    io.to(roomId).emit('timer', { remainMs });

    // Time's up
    if (remainMs <= 0) {

      // Life deduction logic for Hard/Normal mode
      if (rm.mode === 'Hard' || rm.mode === 'Normal') {
        if (rm.lives == null) {
          rm.lives = rm.mode === 'Hard' ? 3 : 5;
        }
        rm.lives -= 1;
        io.to(roomId).emit('livesUpdate', { lives: rm.lives });

        // Game over if lives exhausted
        if (rm.lives <= 0) {
          io.to(roomId).emit('gameFinished', {
            message: 'ライフが尽きました…ゲーム終了！',
            totalscore: rm.cumulativeScore ?? 0
          });
          save(roomId, rm);
          stopTimer(roomId);
          return;
        }
      }

      // Transition to next round
      rm.status = 'between';
      save(roomId, rm);
      stopTimer(roomId);
      io.to(roomId).emit('roundTimeout', { round: rm.round, nextInMs: 1500 });
      setTimeout(() => startRound(roomId), 1500);
    }
  }, 1000);
  roomTimers.set(roomId, interval);
}

// Start a new round
function startRound(roomId) {
  const r = rooms.get(roomId);
  if (!r) return;

  // Determine challenge level keys based on mode
  let levelKeys;
  switch (r.mode) {
    case 'Easy': levelKeys = ['easy']; break;
    case 'Normal': levelKeys = ['normal']; break;
    case 'Hard': levelKeys = ['hard']; break;
    default: levelKeys = ['normal']; // fallback
  }

  // End game if round limit reached
  if ((r.round ?? 0) >= 3) {
    io.to(roomId).emit('gameFinished', {
      message: 'ゲーム終了！',
      totalscore: r.cumulativeScore ?? 0
    });
    Object.assign(r, {
      status: 'between',
      round: 0,
      cumulativeScore: 0,
      usedIndices: [],
      currentIdx: undefined,
      currentSubIndex: undefined,
      currentBig: undefined
    });
    return save(roomId, r);
  }

  // Wait if both players are not present
  if (!r.players.A || !r.players.B) {
    r.status = 'waiting';
    save(roomId, r);
    sys(roomId, '相方を待っています…');
    return;
  }

  // Select a new challenge
  const candidates = challenges
    .map((specimen, i) => ({ specimen, index: i }))
    .filter(({ specimen, index }) => {
      if (r.usedIndices?.includes(index)) return false;
      return levelKeys.includes(specimen.level?.toLowerCase());
    });

  if (candidates.length === 0) {
    sys(roomId, `モード:${r.mode} に対応する問題がありません`);
    return;
  }

  const { specimen, index } = candidates[Math.floor(Math.random() * candidates.length)];
  r.currentIdx = index;
  r.usedIndices.push(index);
  r.currentBig = specimen;

  // Initial Round
  if ((r.round ?? 0) === 0) {
    ['A', 'B'].forEach(role => {
      const sid = r.players[role];
      io.to(sid).emit('gameStarted', {
        cumulativeScore: r.cumulativeScore ?? 0,
        role,
        view: specimen.roles?.[role]?.view || '',
        title: specimen.title,
        lives: r.lives,
        mode: r.mode
      });
    });
  }

  r.round = (r.round || 0) + 1;
  r.status = 'playing';
  save(roomId, r);
  sendQuestion(roomId);
}

// Send current question to both players
function sendQuestion(roomId) {
  const r = rooms.get(roomId);

  if (!r?.currentBig?.roles) {
    sys(roomId, '出題データが不正です');
    return;
  }
  const limitSec = r.currentBig.timeLimitSec || 60;
  r.expiresAt = Date.now() + limitSec * 1000;

  // Send question to A
  io.to(r.players.A).emit('newQuestion', {
    title: r.currentBig.title,
    baseScore: r.currentBig.baseScore,
    timeLimitSec: limitSec,
    view: r.currentBig.roles?.A?.view || '',
    role: 'A'
  });

  // Send question to B
  io.to(r.players.B).emit('newQuestion', {
    title: r.currentBig.title,
    baseScore: r.currentBig.baseScore,
    timeLimitSec: limitSec,
    view: r.currentBig.roles?.B?.view || '',
    role: 'B'
  });
  startTimer(roomId);
}

// Set player readiness and trigger round if both are ready
function setReadyStatus(roomId, socketId, role, cb) {
  const r = rooms.get(roomId);
  if (!r) return cb?.({ ok: false, error: 'ROOM_NOT_FOUND' });
  r.ready ??= {};
  r.ready[socketId] = true;
  save(roomId, r);
  io.to(roomId).emit('readyUpdate', {
    ready: {
      A: !!(r.players.A && r.ready[r.players.A]),
      B: !!(r.players.B && r.ready[r.players.B]),
    }
  });
  const bothReady =
    r.players.A && r.players.B &&
    r.ready[r.players.A] && r.ready[r.players.B];
  if (bothReady && r.status === 'waiting') {
    r.status = 'playing';
    save(roomId, r);
    setTimeout(() => startRound(roomId), 1500);
    return;
  }
  return cb?.({ ok: true, roleAssigned: role, started: false, mode: r.mode });
}

// Finish current big question and transition to next round
function finishBigQuestion(roomId) {
  const r = rooms.get(roomId); if (!r) return;
  io.to(roomId).emit('bigQuestionFinished', {
    message: `大問「${r.currentBig.title}」終了！`,
    totalscore: r.cumulativeScore ?? 0
  });
  setTimeout(() => startRound(roomId), 1500);
}

// API
app.get('/api/health', (req, res) => res.json({ ok: true, now: Date.now(), challenges: challenges.length }));

// Socket.IO
io.on('connection', socket => {

  // Create a new game room
  socket.on('createRoom', ({ mode } = {}, cb) => {
    const roomId = uuid().slice(0, 6);// Generate short unique room ID
    const first = challenges[0] || {
      timeLimitSec: 300,
      title: '課題',
      roles: { A: { view: '' }, B: { view: '' } },
      answer: { type: 'regex', pattern: '.*' }
    };

    // Initialize room state
    rooms.set(roomId, {
      players: { A: null, B: null },
      waiting: [],
      status: 'waiting',
      currentIdx: null,
      usedIndices: [],
      startedAt: null,
      expiresAt: null,
      timeLimitSec: first.timeLimitSec || 300,
      round: 0,
      cumulativeScore: 0,
      mode: null,
      lives: null
    });

    // Auto-delete unused room after 60 seconds
    setTimeout(() => {
      const room = rooms.get(roomId);
      if (
        room &&
        room.status === 'waiting' &&
        room.players.A === null &&
        room.players.B === null
      ) {
        rooms.delete(roomId);
        console.log(`未使用ルーム ${roomId} を削除しました`);
      }
    }, 60 * 1000);

    cb?.({ roomId });
  });

  // Join an existing room
  socket.on('joinRoom', ({ roomId }, cb) => {
    const r = rooms.get(roomId);
    if (!r) return cb?.({ ok: false, error: 'ROOM_NOT_FOUND' });
    const size = io.sockets.adapter.rooms.get(roomId)?.size || 0;
    if (size >= 2) return cb?.({ ok: false, error: 'ROOM_FULL' });
    r.waiting ??= [];
    r.waiting.push(socket.id);
    save(roomId, r);
    socket.join(roomId);
    socketToRoom.set(socket.id, roomId);
    socketToRole.delete(socket.id);
    cb?.({ ok: true, roleAssigned: null, roomStatus: r.status });
    const newSize = io.sockets.adapter.rooms.get(roomId)?.size || 0;
    io.to(roomId).emit('roomUpdate', {
      players: { A: newSize >= 1, B: newSize >= 2 },
      waiting: r.waiting.length
    });
  });

  // Player declares readiness and requests role
  socket.on('playerReady', ({ preferredRole, mode } = {}, cb) => {
    const roomId = socketToRoom.get(socket.id);
    const r = rooms.get(roomId);
    if (!r || !roomId) return cb?.({ ok: false, error: 'ROOM_NOT_FOUND' });

    // Set game mode and initial lives
    if (!r.mode) {
      r.mode = mode || 'Normal';
      if (r.mode === 'Normal') {
        r.lives = 5;
      } else if (r.mode === 'Hard') {
        r.lives = 3;
      }
    } else {
      if (r.mode !== mode) {
        sys(roomId, `モードを ${r.mode} に統一しました`);
      }
    }

    // Assign role if not already assigned
    let role = socketToRole.get(socket.id);
    if (!role) {
      let assign = (preferredRole && !r.players[preferredRole])
        ? preferredRole
        : (!r.players.A ? 'A' : (!r.players.B ? 'B' : null));
      if (!assign) return cb?.({ ok: false, error: 'ROLES_FULL' });
      r.players[assign] = socket.id;
      socketToRole.set(socket.id, assign);
      role = assign;
      const wi = r.waiting.indexOf(socket.id);
      if (wi !== -1) r.waiting.splice(wi, 1);
      io.to(roomId).emit('roomUpdate', {
        players: { A: !!r.players.A, B: !!r.players.B },
        waiting: r.waiting?.length || 0
      });
    }
    save(roomId, r);
    setReadyStatus(roomId, socket.id, role, (res) => { cb?.({ ...res, mode: r.mode }); });
  });

  // Handle answer submission
  socket.on('submitAnswer', ({ roomId, answer, remainMs }, cb) => {
    const r = rooms.get(roomId);
    if (!r || r.status !== 'playing') return cb?.({ ok: false, error: 'NOT_PLAYING' });
    const specimen = r.currentBig;
    if (!specimen || !specimen.answer) return cb?.({ ok: false, error: 'NO_QUESTION' });
    const correct = matchAnswer(specimen.answer, answer);
    if (correct) {
      const rawScore = r.currentBig.baseScore || 100;
      const remainSec = Math.floor(remainMs / 1000);
      const totalSec = r.timeLimitSec;
      const elapsedSec = totalSec - remainSec;
      const penaltyPerSec = 1;
      const deducted = rawScore - (penaltyPerSec * elapsedSec);
      const finalScore = Math.max(0, deducted);
      r.cumulativeScore = (r.cumulativeScore || 0) + finalScore;
      io.to(roomId).emit('answerResult', { correct: true, score: finalScore, cumulativeScore: r.cumulativeScore });
      io.to(roomId).emit('updateScore', { cumulativeScore: r.cumulativeScore });
      r.currentBig = undefined;
      r.currentIdx = undefined;
      r.round = (r.round || 0) + 1;
      save(roomId, r);
      setTimeout(() => startRound(roomId), 1500);
      cb?.({ ok: true, correct: true, score: finalScore });
    } else {
      // Deduct life on incorrect answer (Normal/Hard mode)
      if (r.mode === 'Hard' || r.mode === 'Normal') {
        if (r.lives == null) {
          r.lives = r.mode === 'Hard' ? 3 : 5;
        }
        r.lives -= 1;
        io.to(roomId).emit('livesUpdate', { lives: r.lives });
        if (r.lives <= 0) {
          r.status = 'between';
          io.to(roomId).emit('gameFinished', {
            message: 'ライフが尽きました…ゲーム終了！',
            totalscore: r.cumulativeScore ?? 0
          });
          save(roomId, r);
          return cb?.({ ok: true, correct: false, gameOver: true });
        }
      }
      io.to(roomId).emit('answerResult', { correct: false });
      cb?.({ ok: true, correct: false });
    }
    save(roomId, r);
  });

  // Handle chat messages
  socket.on('chat', ({ roomId, message }) => {
    if (!roomId || typeof message !== 'string') return;
    const role = socketToRole.get(socket.id) || '参加者';
    io.to(roomId).emit('chat', { from: role === 'A' ? '指示者' : (role === 'B' ? '回答者' : '参加者'), message: String(message).slice(0, 500) });
  });

  // Handle player disconnect
  socket.on('disconnect', () => {
    const roomId = socketToRoom.get(socket.id), role = socketToRole.get(socket.id);
    if (!roomId) return;
    const r = rooms.get(roomId);
    if (r) {
      r.waiting ??= [];
      const wi = r.waiting.indexOf(socket.id);
      if (wi !== -1) r.waiting.splice(wi, 1);

      if (role && r.players[role] === socket.id) r.players[role] = null;
      save(roomId, r);

      if (!r.players.A || !r.players.B) {
        stopTimer(roomId);
        r.status = 'waiting';
        save(roomId, r);
      }
      const size = io.sockets.adapter.rooms.get(roomId)?.size || 0;
      io.to(roomId).emit('roomUpdate', {
        players: { A: size >= 1, B: size >= 2 },
        waiting: r.waiting.length
      });
      io.to(roomId).emit('system', {
        message: `相方(${role ? (role === 'A' ? '指示者' : '回答者') : '待機中'})が切断しました。`
      });
    }
    socketToRoom.delete(socket.id);
    socketToRole.delete(socket.id);
  });

  // Reset room state for a new game
  socket.on('continueGame', ({ roomId }) => {
    const r = rooms.get(roomId); if (!r) return;
    // Reset core game state
    Object.assign(r, {
      round: 0, // Reset round counter
      cumulativeScore: 0, // Reset total score
      usedIndices: [], // Clear used challenge indices
      status: 'waiting', // Set room status to waiting
      ready: {}, // Clear readiness flags
      mode: null, // Clear game mode
      lives: null // Reset lives
    });

    // Rebuild waiting list from current room sockets
    const roomSet = io.sockets.adapter.rooms.get(roomId) || new Set();
    r.waiting = Array.from(roomSet);
    save(roomId, r);
    io.to(roomId).emit('roomReset', { message: '新しいゲームの準備中… Ready を押してください' });
    const size = roomSet.size;
    io.to(roomId).emit('roomUpdate', {
      players: { A: size >= 1, B: size >= 2 },
      waiting: r.waiting.length
    });
    io.to(roomId).emit('readyUpdate', { ready: { A: false, B: false } });
  });

});
// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`MAL和狩 server running at http://localhost:${PORT}`));
