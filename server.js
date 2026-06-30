const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config();

const db = require('./database');

const app = express();
app.use(cors());
app.use(express.json());

// Serve index.html statically from root
app.use(express.static(__dirname));

const PORT = process.env.PORT || 5000;

// Deterministic card generator (must match client exactly)
function generateCardDeterministic(cardId) {
  let seed = cardId;
  function random() {
    let x = Math.sin(seed++) * 10000;
    return x - Math.floor(x);
  }
  
  const card = new Array(25);
  for (let c = 0; c < 5; c++) {
    const min = c * 15 + 1;
    const max = c * 15 + 15;
    const pool = [];
    for (let i = min; i <= max; i++) pool.push(i);
    
    // Seeded shuffle
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      const t = pool[i];
      pool[i] = pool[j];
      pool[j] = t;
    }
    
    for (let r = 0; r < 5; r++) {
      const idx = r * 5 + c;
      card[idx] = { c: c, r: r, n: pool[r] };
    }
  }
  card[12] = { c: 2, r: 2, n: '★' };
  return card;
}

// Win validation helper
function verifyWin(card, calledNumbersSet) {
  const marked = new Set();
  card.forEach((cell, idx) => {
    if (cell.n === '★' || idx === 12 || calledNumbersSet.has(cell.n)) {
      marked.add(idx);
    }
  });

  const lines = [];
  // rows
  for (let r = 0; r < 5; r++) lines.push([r*5, r*5+1, r*5+2, r*5+3, r*5+4]);
  // cols
  for (let c = 0; c < 5; c++) lines.push([c, c+5, c+10, c+15, c+20]);
  // diagonals
  lines.push([0, 6, 12, 18, 24]);
  lines.push([4, 8, 12, 16, 20]);
  // corners
  lines.push([0, 4, 20, 24]);

  for (const line of lines) {
    if (line.every(idx => marked.has(idx))) {
      return true;
    }
  }
  return false;
}

function generateGameId() {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = letters.charAt(Math.floor(Math.random() * letters.length)) + 
           letters.charAt(Math.floor(Math.random() * letters.length));
  for (let i = 0; i < 6; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

// REST Endpoints
app.get('/api/balance', async (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'User ID is required' });
  const user = await db.getUser(user_id);
  res.json({
    success: true,
    main_balance: user.mainBalance,
    play_balance: user.playBalance
  });
});

app.post('/api/update_name', async (req, res) => {
  const { user_id, first_name, username } = req.body;
  if (!user_id) return res.status(400).json({ error: 'User ID is required' });
  await db.updateUserName(user_id, first_name, username || '');
  res.json({ success: true });
});

app.post('/api/bet', async (req, res) => {
  const { user_id, amount } = req.body;
  if (!user_id || !amount) return res.status(400).json({ error: 'Missing parameters' });
  const user = await db.deductBet(user_id, amount);
  if (!user) {
    return res.status(400).json({ error: 'Insufficient balance' });
  }
  res.json({
    success: true,
    main_balance: user.mainBalance,
    play_balance: user.playBalance
  });
});

app.post('/api/win', async (req, res) => {
  const { user_id, amount, game_id } = req.body;
  if (!user_id || !amount) return res.status(400).json({ error: 'Missing parameters' });
  const user = await db.addWin(user_id, amount, game_id);
  res.json({
    success: true,
    main_balance: user.mainBalance,
    play_balance: user.playBalance
  });
});

app.post('/api/game_played', async (req, res) => {
  const { user_id, game_id, cards, stake } = req.body;
  if (!user_id || !game_id) return res.status(400).json({ error: 'Missing parameters' });
  await db.recordGamePlayed(user_id, game_id, cards ? cards.length : 1, stake || 10);
  res.json({ success: true });
});

app.get('/api/game_state', async (req, res) => {
  const { room } = req.query;
  const roomState = rooms[room || '10'];
  if (!roomState) return res.status(400).json({ error: 'Invalid room' });
  
  // Calculate total cards bought
  const playersList = Object.values(roomState.players);
  let totalCardsCount = 0;
  playersList.forEach(p => {
    totalCardsCount += p.cardNumbers.length;
  });

  res.json({
    game_running: roomState.status === 'running',
    game_id: roomState.gameId,
    time_left: roomState.timeLeft,
    called_numbers: roomState.calledNumbers,
    total_players: totalCardsCount
  });
});

app.get('/api/game_history', async (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'User ID is required' });
  const history = await db.getGameHistory(user_id);
  res.json({ history });
});

app.get('/api/top_winners', async (req, res) => {
  const { period, category } = req.query;
  const winners = await db.getTopWinners(period || 'week', category || 'deposit');
  res.json({ winners });
});

app.get('/api/my_rank', async (req, res) => {
  const { user_id, period, category } = req.query;
  if (!user_id) return res.status(400).json({ error: 'User ID is required' });
  const rank = await db.getMyRank(user_id, period || 'week', category || 'deposit');
  res.json(rank);
});

app.get('/api/transactions', async (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'User ID is required' });
  const transactions = await db.getTransactions(user_id);
  res.json({ transactions });
});

app.get('/api/profile_stats', async (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'User ID is required' });
  const stats = await db.getProfileStats(user_id);
  res.json(stats);
});

// Setup HTTP server and Socket.io
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Game rooms configuration
const rooms = {
  '10': {
    roomId: '10',
    stake: 10,
    status: 'waiting',
    timeLeft: 35,
    gameId: generateGameId(),
    calledNumbers: [],
    players: {}, // userId -> { userId, name, cards: [Array of card grids], cardNumbers: [Array of card IDs] }
    winners: [],
    timer: null,
    maxWinners: 1,
    ballTimer: null
  },
  '20': {
    roomId: '20',
    stake: 20,
    status: 'waiting',
    timeLeft: 35,
    gameId: generateGameId(),
    calledNumbers: [],
    players: {},
    winners: [],
    timer: null,
    maxWinners: 1,
    ballTimer: null
  }
};

// Start countdown logic for a room
function startRoomCountdown(room) {
  if (room.timer) return;
  room.timer = setInterval(() => {
    if (room.status !== 'waiting') return;
    
    room.timeLeft--;
    
    io.to(room.roomId).emit('countdown_update', {
      room: room.roomId,
      game_id: room.gameId,
      time_left: room.timeLeft
    });
    
    if (room.timeLeft <= 0) {
      tryStartGame(room);
    }
  }, 1000);
}

// Attempt to start a game in a room
function tryStartGame(room) {
  const playersList = Object.values(room.players);
  let totalCardsCount = 0;
  playersList.forEach(p => {
    totalCardsCount += p.cardNumbers.length;
  });

  if (totalCardsCount >= 1) {
    // We have players, let's start!
    clearInterval(room.timer);
    room.timer = null;
    room.status = 'running';
    room.calledNumbers = [];
    room.winners = [];

    io.to(room.roomId).emit('game_started', {
      room: room.roomId,
      game_id: room.gameId,
      total_players: totalCardsCount
    });

    // Start drawing balls
    startBallDrawing(room);
  } else {
    // No players, reset countdown and keep waiting
    room.timeLeft = 35;
    room.gameId = generateGameId();
  }
}

// Ball calling logic
function startBallDrawing(room) {
  if (room.ballTimer) clearInterval(room.ballTimer);
  
  const pool = [];
  for (let i = 1; i <= 75; i++) pool.push(i);
  
  // Shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  let index = 0;
  
  // Wait 2 seconds (GET READY phase) before first ball
  setTimeout(() => {
    if (room.status !== 'running') return;
    
    drawBall();
    
    room.ballTimer = setInterval(() => {
      if (room.status !== 'running') {
        clearInterval(room.ballTimer);
        room.ballTimer = null;
        return;
      }
      drawBall();
    }, 3000);
  }, 2000);

  function drawBall() {
    if (index >= 75 || room.status !== 'running') {
      clearInterval(room.ballTimer);
      room.ballTimer = null;
      endGame(room);
      return;
    }
    
    const num = pool[index++];
    room.calledNumbers.push(num);
    
    io.to(room.roomId).emit('ball_called', {
      room: room.roomId,
      number: num
    });
  }
}

// Reset room state
function endGame(room) {
  if (room.ballTimer) clearInterval(room.ballTimer);
  room.ballTimer = null;
  
  room.status = 'waiting';
  room.timeLeft = 35;
  room.gameId = generateGameId();
  room.players = {};
  room.calledNumbers = [];
  room.winners = [];
  
  startRoomCountdown(room);
}

// Start countdowns immediately
startRoomCountdown(rooms['10']);
startRoomCountdown(rooms['20']);

// Socket.io event handling
io.on('connection', (socket) => {
  let currentRoom = null;
  let currentUserId = null;

  socket.on('join_room', (data) => {
    const { room } = data;
    if (rooms[room]) {
      if (currentRoom) {
        socket.leave(currentRoom);
      }
      currentRoom = room;
      socket.join(room);
      
      // Send initial game state
      const roomState = rooms[room];
      const playersList = Object.values(roomState.players);
      let totalCardsCount = 0;
      playersList.forEach(p => {
        totalCardsCount += p.cardNumbers.length;
      });

      socket.emit('countdown_update', {
        room: room,
        game_id: roomState.gameId,
        time_left: roomState.timeLeft
      });
      
      socket.emit('game_state_update', {
        room: room,
        total_players: totalCardsCount
      });
    }
  });

  socket.on('leave_room', (data) => {
    const { room } = data;
    socket.leave(room);
    if (currentRoom === room) {
      currentRoom = null;
    }
  });

  socket.on('request_countdown', (data) => {
    const { room, game_id } = data;
    const roomState = rooms[room];
    if (roomState && roomState.gameId === game_id) {
      socket.emit('countdown_update', {
        room: room,
        game_id: roomState.gameId,
        time_left: roomState.timeLeft
      });
    }
  });

  socket.on('player_ready', (data) => {
    const { user_id, name, cards, game_id, room: roomId } = data;
    const room = rooms[roomId];
    if (!room) return;
    
    currentUserId = user_id;
    
    // Store player details and generate their cards deterministically
    const cardGrids = cards.map(cId => generateCardDeterministic(cId));
    room.players[user_id] = {
      userId: user_id,
      name: name || 'Anonymous',
      cards: cardGrids,
      cardNumbers: cards
    };

    // Calculate total cards
    const playersList = Object.values(room.players);
    let totalCardsCount = 0;
    playersList.forEach(p => {
      totalCardsCount += p.cardNumbers.length;
    });

    // Notify room of new ready player
    io.to(room.roomId).emit('player_joined', {
      room: room.roomId,
      total_players: totalCardsCount
    });
  });

  socket.on('declare_winner', async (data) => {
    const { user_id, name, card_num, card_index, game_id, room: roomId } = data;
    const room = rooms[roomId];
    if (!room || room.status !== 'running' || room.gameId !== game_id) return;
    
    const player = room.players[user_id];
    if (!player) return;
    
    const card = player.cards[card_index];
    if (!card) return;
    
    // Verify no double declarations for the exact card
    if (room.winners.some(w => w.userId === user_id && w.cardNum === card_num)) return;
    
    // Validate card pattern on server
    const calledSet = new Set(room.calledNumbers);
    const isWinner = verifyWin(card, calledSet);
    
    if (isWinner) {
      const playersList = Object.values(room.players);
      let totalCardsCount = 0;
      playersList.forEach(p => {
        totalCardsCount += p.cardNumbers.length;
      });
      
      const totalPot = totalCardsCount * room.stake;
      const totalPrize = Math.round(totalPot * 0.8);
      
      room.winners.push({
        userId: user_id,
        name: name,
        cardNum: card_num,
        prize: totalPrize
      });
      
      // If we reach maxWinners, end game and distribute prizes
      if (room.winners.length >= room.maxWinners) {
        if (room.ballTimer) clearInterval(room.ballTimer);
        room.ballTimer = null;
        
        const winnerCount = room.winners.length;
        const prizeEach = Math.floor(totalPrize / winnerCount);
        
        for (const w of room.winners) {
          w.prize = prizeEach;
          await db.addWin(w.userId, prizeEach, room.gameId);
          await db.updateGameHistoryResult(w.userId, room.gameId, `Won ${prizeEach} Br`);
        }
        
        io.to(room.roomId).emit('winner_found', {
          room: room.roomId,
          winner_name: room.winners[0].name,
          winner_card: room.winners[0].cardNum,
          prize: totalPrize,
          winners: room.winners
        });
        
        io.to(room.roomId).emit('game_ended', {
          room: room.roomId,
          winners: room.winners,
          prize: totalPrize
        });
        
        setTimeout(() => {
          endGame(room);
        }, 8000);
      }
    }
  });

  socket.on('disconnect', () => {
    // We keep players registered in room.players so they can win even if they disconnect temporarily.
    // They will be cleared when the game resets.
  });
});

server.listen(PORT, () => {
  console.log(`JUBA BINGO server running on port ${PORT}`);
});
