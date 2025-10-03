/* Copyright (c) 2025, SECOM CO., LTD. All Rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE. */

// server.js (ESM) — MAL和狩
import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: true, credentials: true } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// JSONファイルの指定
const f_json = 'sample_challenges.json' // デフォルト: 'sample_challenges.json'

// 共通ユーティリティ
const rooms = new Map();
const socketToRoom = new Map();
const socketToRole = new Map();
const roomTimers = new Map();
const save = (id, r) => rooms.set(id, r);
const stopTimer = id => { if (roomTimers.has(id)) { clearInterval(roomTimers.get(id)); roomTimers.delete(id); } };
const sys = (id, msg) => io.to(id).emit('system', { message: msg });

const CHALLENGES_PATH = path.join(__dirname, 'challenges', f_json);
let challenges = [];
try { challenges = JSON.parse(fs.readFileSync(CHALLENGES_PATH, 'utf-8')); } catch (err) { console.error('検体読み込み失敗:', err); challenges = []; }

// ヘルパー
const normalize = s => (s ?? '').toString().trim();
const pickRandomUnusedIndex = r => {
  const n = challenges.length; if (n <= 1) return 0;
  r.usedIndices ??= []; const remain = [...Array(n).keys()].filter(i => !r.usedIndices.includes(i));
  if (!remain.length) { r.usedIndices = []; return Math.floor(Math.random() * n); }
  return remain[Math.floor(Math.random() * remain.length)];
};
const matchAnswer = (conf, ans) => {
  if (!conf || !ans) return false; const f = normalize(ans);
  if (conf.type === 'regex') {
    let pat = conf.pattern || '', flg = conf.flags || ''; if (/^\(\?i\)/.test(pat)) { if (!flg.includes('i')) flg += 'i'; pat = pat.replace(/^\(\?i\)/, ''); }
    try { return new RegExp(pat, flg).test(f); } catch { return false; }
  }
  if (conf.type === 'exact') return f.toLowerCase() === (conf.value ?? '').toLowerCase();
  return false;
};

// ゲーム進行
function startTimer(roomId) {
  const r = rooms.get(roomId); if (!r) return;
  stopTimer(roomId);
  const interval = setInterval(() => {
    const rm = rooms.get(roomId);
    if (!rm || rm.status !== 'playing') { stopTimer(roomId); return; }
    const remainMs = Math.max(0, rm.expiresAt - Date.now());
    io.to(roomId).emit('timer', { remainMs });
    if (remainMs <= 0) {
      rm.status = 'between'; save(roomId, rm); stopTimer(roomId);
      io.to(roomId).emit('roundTimeout', { round: rm.round, nextInMs: 1500 });
      setTimeout(() => startRound(roomId), 1500);
    }
  }, 1000);
  roomTimers.set(roomId, interval);
}

function startRound(roomId) {
  const r = rooms.get(roomId);
  if (!r) return;

  const levelKeys = r.mode === 'Hard' ? ['hard', 'expert'] : ['easy', 'normal'];

  // ゲーム終了判定（ラウンド数で制限）
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

  // プレイヤーが揃っていない場合
  if (!r.players.A || !r.players.B) {
    r.status = 'waiting';
    save(roomId, r);
    sys(roomId, '相方を待っています…');
    return;
  }

  // 検体が未選択ならランダムに選ぶ
  if (r.currentIdx === undefined) {
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
    r.currentSubIndex = 0;
    r.usedIndices.push(index);
    r.currentBig = {
      title: specimen.title,
      baseScore: specimen.baseScore,
      timeLimitSec: specimen.timeLimitSec,
      subquestions: specimen.subquestions
    };
  } else {
    r.currentSubIndex++;
  }

  const specimen = challenges[r.currentIdx];
  const sub = specimen?.subquestions?.[r.currentSubIndex];

  if (!sub) {
    // 小問が尽きたら次の検体へ
    r.currentIdx = undefined;
    r.currentSubIndex = undefined;
    r.currentBig = undefined;
    return startRound(roomId);
  }

  r.round = (r.round || 0) + 1;
  r.status = 'playing';
  save(roomId, r);
  sendSubQuestion(roomId);
}


function sendSubQuestion(roomId) {
  const r = rooms.get(roomId); if (!r) return;
  const sub = r.currentBig.subquestions[r.currentSubIndex];
  if (!sub) return finishBigQuestion(roomId);
  r.startedAt = Date.now();
  r.timeLimitSec = sub.timeLimitSec || r.currentBig.timeLimitSec || 300;
  if (r.mode === 'Hard') {
    r.timeLimitSec = Math.floor(r.timeLimitSec * 0.8);
  }
  r.expiresAt = r.startedAt + r.timeLimitSec * 1000;
  save(roomId, r);
  sys(roomId, `問${r.currentSubIndex + 1} スタート！`);
  const base = {
    title: r.currentBig.title || '課題', subIndex: r.currentSubIndex,
    timeLimitSec: r.timeLimitSec, endsAt: r.expiresAt,
    round: r.round, cumulativeScore: r.cumulativeScore ?? 0
  };
  io.to(r.players.A).emit('gameStarted', { ...base, role: 'A', view: sub.roles?.A?.view ?? '', lives: r.lives });
  io.to(r.players.B).emit('gameStarted', { ...base, role: 'B', view: sub.roles?.B?.view ?? '', lives: r.lives });

  startTimer(roomId);
  io.to(roomId).emit('livesUpdate', { lives: r.lives });
}

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
  socket.on('createRoom', ({ mode } = {}, cb) => {
    const roomId = uuid().slice(0, 6);
    const first = challenges[0] || {
      timeLimitSec: 300,
      title: '課題',
      roles: { A: { view: '' }, B: { view: '' } },
      answer: { type: 'regex', pattern: '.*' }
    };
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


  socket.on('playerReady', ({ preferredRole, mode } = {}, cb) => {
    const roomId = socketToRoom.get(socket.id);
    const r = rooms.get(roomId);
    if (!r || !roomId) return cb?.({ ok: false, error: 'ROOM_NOT_FOUND' });
    if (!r.mode) {
      r.mode = mode || 'Normal';
      if (r.mode === 'Hard') r.lives = 3;
    } else {
      if (r.mode !== mode) {
        sys(roomId, `モードを ${r.mode} に統一しました`);
      }
    }
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


  socket.on('submitAnswer', ({ roomId, answer, remainMs }, cb) => {
    const r = rooms.get(roomId);
    if (!r || r.status !== 'playing') return cb?.({ ok: false, error: 'NOT_PLAYING' });
    const sub = r.currentBig.subquestions[r.currentSubIndex];
    if (!sub) return cb?.({ ok: false, error: 'NO_SUBQUESTION' });
    const correct = matchAnswer(sub.answer, answer);
    if (correct) {
      const rawScore = sub.baseScore || r.currentBig.baseScore || 100;
      const remainSec = Math.floor(remainMs / 1000);
      const totalSec = r.timeLimitSec;
      const elapsedSec = totalSec - remainSec;
      const penaltyPerSec = 1;
      const deducted = rawScore - (penaltyPerSec * elapsedSec);
      const finalScore = Math.max(0, deducted);
      const multiplier = r.mode === 'Hard' ? 1.5 : 1;
      const add = Math.floor(finalScore * multiplier);
      io.to(roomId).emit('answerResult', { correct: true, score: add, cumulativeScore: r.cumulativeScore });
      io.to(roomId).emit('updateScore', { cumulativeScore: r.cumulativeScore });
      r.currentSubIndex++;
      if (r.currentSubIndex < r.currentBig.subquestions.length) {
        sendSubQuestion(roomId);
      } else {
        finishBigQuestion(roomId);
      }
      cb?.({ ok: true, correct: true, score: add });
    } else {
      if (r.mode === 'Hard') {
        if (r.lives == null) r.lives = 3;
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

  socket.on('chat', ({ roomId, message }) => {
    if (!roomId || typeof message !== 'string') return;
    const role = socketToRole.get(socket.id) || '参加者';
    io.to(roomId).emit('chat', { from: role === 'A' ? '指示者' : (role === 'B' ? '回答者' : '参加者'), message: String(message).slice(0, 500) });
  });

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

  socket.on('continueGame', ({ roomId }) => {
    const r = rooms.get(roomId); if (!r) return;
    Object.assign(r, {
      round: 0,
      cumulativeScore: 0,
      usedIndices: [],
      status: 'waiting',
      ready: {},
      mode: null,
      lives: null
    });
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`MAL和狩 server running at http://localhost:${PORT}`));
