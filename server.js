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

app.post('/api/auth/register', async (req, res) => {
  const { user_id, password } = req.body;
  if (!user_id || !password) return res.status(400).json({ error: 'Missing credentials' });
  const user = await db.registerWebUser(user_id, password);
  if (user) {
    res.json({ success: true, user_id: user_id });
  } else {
    res.status(500).json({ error: 'Registration failed or user exists' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { user_id, password } = req.body;
  if (!user_id || !password) return res.status(400).json({ error: 'Missing credentials' });
  const user = await db.loginWebUser(user_id, password);
  if (user) {
    res.json({ success: true, user_id: user_id });
  } else {
    res.status(401).json({ error: 'Invalid ID or password' });
  }
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
  // Calculate total cards bought in the global game
  const playersList = Object.values(globalGame.players);
  let totalCardsCount = 0;
  playersList.forEach(p => {
    totalCardsCount += p.cardNumbers.length;
  });

  res.json({
    game_running: globalGame.status === 'running',
    game_id: globalGame.gameId,
    time_left: globalGame.timeLeft,
    called_numbers: globalGame.calledNumbers,
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

// Global Game Configuration
const globalGame = {
  roomId: 'global',
  status: 'waiting',
  timeLeft: 35,
  gameId: generateGameId(),
  calledNumbers: [],
  players: {}, // userId -> { userId, name, cards, cardNumbers, stake }
  winners: [],
  timer: null,
  maxWinners: 1,
  ballTimer: null,
  totalPot: 0
};

// Start countdown logic for the global game
function startGameCountdown(game) {
  if (game.timer) return;
  game.timer = setInterval(() => {
    if (game.status !== 'waiting') return;
    
    game.timeLeft--;
    
    io.to(game.roomId).emit('countdown_update', {
      room: game.roomId,
      game_id: game.gameId,
      time_left: game.timeLeft
    });
    
    if (game.timeLeft <= 0) {
      tryStartGame(game);
    }
  }, 1000);
}

// Attempt to start the game
function tryStartGame(game) {
  const playersList = Object.values(game.players);
  let totalCardsCount = 0;
  playersList.forEach(p => {
    totalCardsCount += p.cardNumbers.length;
  });

  if (totalCardsCount >= 1) {
    // We have players, let's start!
    clearInterval(game.timer);
    game.timer = null;
    game.status = 'running';
    game.calledNumbers = [];
    game.winners = [];

    io.to(game.roomId).emit('game_started', {
      room: game.roomId,
      game_id: game.gameId,
      total_players: totalCardsCount
    });

    // Start drawing balls
    startBallDrawing(game);
  } else {
    // No players, reset countdown and keep waiting
    game.timeLeft = 35;
    game.gameId = generateGameId();
  }
}

// Ball calling logic
function startBallDrawing(game) {
  if (game.ballTimer) clearInterval(game.ballTimer);
  
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
    if (game.status !== 'running') return;
    
    drawBall();
    
    game.ballTimer = setInterval(() => {
      if (game.status !== 'running') {
        clearInterval(game.ballTimer);
        game.ballTimer = null;
        return;
      }
      drawBall();
    }, 3000);
  }, 2000);

  function drawBall() {
    if (index >= 75 || game.status !== 'running') {
      clearInterval(game.ballTimer);
      game.ballTimer = null;
      endGame(game);
      return;
    }
    
    const num = pool[index++];
    game.calledNumbers.push(num);
    
    io.to(game.roomId).emit('ball_called', {
      room: game.roomId,
      number: num
    });
  }
}

// Reset game state
function endGame(game) {
  if (game.ballTimer) clearInterval(game.ballTimer);
  game.ballTimer = null;
  
  game.status = 'waiting';
  game.timeLeft = 35;
  game.gameId = generateGameId();
  game.players = {};
  game.calledNumbers = [];
  game.winners = [];
  
  startGameCountdown(game);
}

// Start countdown immediately
startGameCountdown(globalGame);

// Socket.io event handling
io.on('connection', (socket) => {
  let currentRoom = null;
  let currentUserId = null;

  socket.on('join_room', (data) => {
    // Always join the global room
    if (currentRoom) {
      socket.leave(currentRoom);
    }
    currentRoom = globalGame.roomId;
    socket.join(currentRoom);
    
    // Send initial game state
    const playersList = Object.values(globalGame.players);
    let totalCardsCount = 0;
    playersList.forEach(p => {
      totalCardsCount += p.cardNumbers.length;
    });

    socket.emit('countdown_update', {
      room: currentRoom,
      game_id: globalGame.gameId,
      time_left: globalGame.timeLeft
    });
    
    socket.emit('game_state_update', {
      room: currentRoom,
      total_players: totalCardsCount
    });
  });

  socket.on('leave_room', (data) => {
    socket.leave(globalGame.roomId);
    currentRoom = null;
  });

  socket.on('request_countdown', (data) => {
    const { game_id } = data;
    if (globalGame.gameId === game_id) {
      socket.emit('countdown_update', {
        room: globalGame.roomId,
        game_id: globalGame.gameId,
        time_left: globalGame.timeLeft
      });
    }
  });

  socket.on('player_ready', (data) => {
    const { user_id, name, cards, game_id, stake } = data;
    if (globalGame.status !== 'waiting') return; // Cannot join running game
    
    currentUserId = user_id;
    
    // Store player details and generate their cards deterministically
    const cardGrids = cards.map(cId => generateCardDeterministic(cId));
    globalGame.players[user_id] = {
      userId: user_id,
      name: name || 'Anonymous',
      cards: cardGrids,
      cardNumbers: cards,
      stake: Number(stake) || 10
    };

    // Calculate total cards and total pot
    const playersList = Object.values(globalGame.players);
    let totalCardsCount = 0;
    globalGame.totalPot = 0;
    playersList.forEach(p => {
      totalCardsCount += p.cardNumbers.length;
      globalGame.totalPot += p.cardNumbers.length * p.stake;
    });

    // Notify room of new ready player
    io.to(globalGame.roomId).emit('player_joined', {
      room: globalGame.roomId,
      total_players: totalCardsCount,
      total_pot: globalGame.totalPot
    });
  });

  socket.on('declare_winner', async (data) => {
    const { user_id, name, card_num, card_index, game_id } = data;
    if (globalGame.status !== 'running' || globalGame.gameId !== game_id) return;
    
    const player = globalGame.players[user_id];
    if (!player) return;
    
    const card = player.cards[card_index];
    if (!card) return;
    
    // Verify no double declarations for the exact card
    if (globalGame.winners.some(w => w.userId === user_id && w.cardNum === card_num)) return;

    // Called numbers set
    const calledSet = new Set(globalGame.calledNumbers);
    
    const isValidWin = verifyWin(card, calledSet);
    
    if (isValidWin) {
      globalGame.winners.push({
        userId: user_id,
        name: player.name,
        cardNum: card_num,
        cardIndex: card_index
      });
      
      // If we reached max winners, end round
      if (globalGame.winners.length >= globalGame.maxWinners) {
        clearInterval(globalGame.ballTimer);
        globalGame.ballTimer = null;
        
        const totalPrize = Math.round(globalGame.totalPot * 0.8);
        
        io.to(globalGame.roomId).emit('game_ended', {
          room: globalGame.roomId,
          game_id: globalGame.gameId,
          winners: globalGame.winners,
          total_prize: totalPrize
        });
        
        setTimeout(() => {
          endGame(globalGame);
        }, 15000); // Wait 15s to show winners screen before new game
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
