const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/juba_bingo';

let isDbConnected = false;

mongoose.connect(MONGODB_URI)
  .then(() => {
    isDbConnected = true;
    console.log('Connected to MongoDB successfully!');
  })
  .catch(err => {
    isDbConnected = false;
    console.log('MongoDB connection failed. Using in-memory fallback database.');
  });

// Schemas
const UserSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  firstName: { type: String, default: '' },
  username: { type: String, default: '' },
  mainBalance: { type: Number, default: 1000 },
  playBalance: { type: Number, default: 50 },
  gamesPlayed: { type: Number, default: 0 },
  gamesWon: { type: Number, default: 0 },
  totalWon: { type: Number, default: 0 },
  invited: { type: Number, default: 0 },
  isVip: { type: Boolean, default: false }
});

const TransactionSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  type: { type: String, enum: ['deposit', 'withdraw', 'bet', 'bingo_win'], required: true },
  amount: { type: Number, required: true },
  status: { type: String, default: 'Done' },
  time: { type: Date, default: Date.now }
});

const GameHistorySchema = new mongoose.Schema({
  userId: { type: String, required: true },
  gameId: { type: String, required: true },
  entry: { type: Number, required: true },
  status: { type: String, default: 'Completed' },
  result: { type: String, default: '-' },
  time: { type: Date, default: Date.now }
});

// Models
const UserModel = mongoose.model('User', UserSchema);
const TransactionModel = mongoose.model('Transaction', TransactionSchema);
const GameHistoryModel = mongoose.model('GameHistory', GameHistorySchema);

// In-Memory Database Fallback Store
const memoryDb = {
  users: {},
  transactions: [],
  gameHistory: []
};

// Helper: Ensure a user exists in memory
function getMemoryUser(userId) {
  if (!memoryDb.users[userId]) {
    memoryDb.users[userId] = {
      userId: userId,
      firstName: '',
      username: '',
      mainBalance: 1000,
      playBalance: 50,
      gamesPlayed: 0,
      gamesWon: 0,
      totalWon: 0,
      invited: Math.floor(Math.random() * 5), // Mock some stats for fun
      isVip: false
    };
  }
  return memoryDb.users[userId];
}

// Database Layer API Wrapper
const db = {
  // Get user by ID
  async getUser(userId) {
    if (isDbConnected) {
      try {
        let user = await UserModel.findOne({ userId });
        if (!user) {
          user = await UserModel.create({ userId });
        }
        return user.toObject();
      } catch (err) {
        console.error('Mongoose getUser error:', err);
      }
    }
    return getMemoryUser(userId);
  },

  // Update user name/username
  async updateUserName(userId, firstName, username = '') {
    if (isDbConnected) {
      try {
        await UserModel.findOneAndUpdate(
          { userId },
          { firstName, username },
          { upsert: true }
        );
        return;
      } catch (err) {
        console.error('Mongoose updateUserName error:', err);
      }
    }
    const user = getMemoryUser(userId);
    user.firstName = firstName;
    if (username) user.username = username;
  },

  // Process bet deduction
  async deductBet(userId, amount) {
    if (isDbConnected) {
      try {
        const user = await UserModel.findOne({ userId });
        if (!user) return null;
        
        let play = user.playBalance;
        let main = user.mainBalance;
        
        if (play + main < amount) return null; // Insufficient balance
        
        if (play >= amount) {
          play -= amount;
        } else {
          main -= (amount - play);
          play = 0;
        }
        
        user.playBalance = play;
        user.mainBalance = main;
        await user.save();
        
        // Log transaction
        await TransactionModel.create({
          userId,
          type: 'bet',
          amount,
          status: 'Done'
        });
        
        return user.toObject();
      } catch (err) {
        console.error('Mongoose deductBet error:', err);
      }
    }
    
    // Memory fallback
    const user = getMemoryUser(userId);
    let play = user.playBalance;
    let main = user.mainBalance;
    if (play + main < amount) return null;
    
    if (play >= amount) {
      play -= amount;
    } else {
      main -= (amount - play);
      play = 0;
    }
    user.playBalance = play;
    user.mainBalance = main;
    
    memoryDb.transactions.push({
      userId,
      type: 'bet',
      amount,
      status: 'Done',
      time: new Date()
    });
    
    return user;
  },

  // Record win
  async addWin(userId, amount, gameId) {
    if (isDbConnected) {
      try {
        const user = await UserModel.findOne({ userId });
        if (user) {
          user.mainBalance += amount;
          user.gamesWon += 1;
          user.totalWon += amount;
          await user.save();
          
          await TransactionModel.create({
            userId,
            type: 'bingo_win',
            amount,
            status: 'Done'
          });
        }
        return user ? user.toObject() : null;
      } catch (err) {
        console.error('Mongoose addWin error:', err);
      }
    }
    
    // Memory fallback
    const user = getMemoryUser(userId);
    user.mainBalance += amount;
    user.gamesWon += 1;
    user.totalWon += amount;
    
    memoryDb.transactions.push({
      userId,
      type: 'bingo_win',
      amount,
      status: 'Done',
      time: new Date()
    });
    
    return user;
  },

  // Record game history
  async recordGamePlayed(userId, gameId, cardsCount, stake) {
    const entry = cardsCount * stake;
    if (isDbConnected) {
      try {
        await UserModel.findOneAndUpdate(
          { userId },
          { $inc: { gamesPlayed: 1 } }
        );
        
        await GameHistoryModel.create({
          userId,
          gameId,
          entry,
          status: 'Completed',
          result: '-'
        });
        return;
      } catch (err) {
        console.error('Mongoose recordGamePlayed error:', err);
      }
    }
    
    // Memory fallback
    const user = getMemoryUser(userId);
    user.gamesPlayed += 1;
    
    memoryDb.gameHistory.push({
      userId,
      gameId,
      entry,
      status: 'Completed',
      result: '-',
      time: new Date()
    });
  },

  // Update Game History Result (Win state update)
  async updateGameHistoryResult(userId, gameId, resultText) {
    if (isDbConnected) {
      try {
        await GameHistoryModel.findOneAndUpdate(
          { userId, gameId },
          { result: resultText }
        );
        return;
      } catch (err) {
        console.error('Mongoose updateGameHistoryResult error:', err);
      }
    }
    
    // Memory fallback
    const hist = memoryDb.gameHistory.find(h => h.userId === userId && h.gameId === gameId);
    if (hist) {
      hist.result = resultText;
    }
  },

  // Get User Profile Stats
  async getProfileStats(userId) {
    const user = await this.getUser(userId);
    return {
      games_played: user.gamesPlayed,
      games_won: user.gamesWon,
      total_won: user.totalWon,
      invited: user.invited,
      is_vip: user.isVip
    };
  },

  // Get Game History
  async getGameHistory(userId) {
    if (isDbConnected) {
      try {
        const hist = await GameHistoryModel.find({ userId })
          .sort({ time: -1 })
          .limit(20);
        return hist.map(h => ({
          game_id: h.gameId,
          entry: h.entry,
          status: h.status,
          result: h.result
        }));
      } catch (err) {
        console.error('Mongoose getGameHistory error:', err);
      }
    }
    
    // Memory fallback
    return memoryDb.gameHistory
      .filter(h => h.userId === userId)
      .sort((a, b) => b.time - a.time)
      .slice(0, 20)
      .map(h => ({
        game_id: h.gameId,
        entry: h.entry,
        status: h.status,
        result: h.result
      }));
  },

  // Get Transactions
  async getTransactions(userId) {
    if (isDbConnected) {
      try {
        const txs = await TransactionModel.find({ userId })
          .sort({ time: -1 })
          .limit(20);
        return txs.map(t => ({
          type: t.type,
          amount: t.amount,
          status: t.status,
          time: t.time.toISOString()
        }));
      } catch (err) {
        console.error('Mongoose getTransactions error:', err);
      }
    }
    
    // Memory fallback
    return memoryDb.transactions
      .filter(t => t.userId === userId)
      .sort((a, b) => b.time - a.time)
      .slice(0, 20)
      .map(t => ({
        type: t.type,
        amount: t.amount,
        status: t.status,
        time: t.time.toISOString()
      }));
  },

  // Get Leaderboards (Top Winners)
  async getTopWinners(period, category) {
    // Generate some mock leaderboard entries if DB is not connected
    // This looks very high fidelity and responsive
    if (isDbConnected) {
      try {
        // Simple top lists from database
        if (category === 'invite') {
          const users = await UserModel.find().sort({ invited: -1 }).limit(10);
          return users.map(u => ({
            name: u.firstName || u.username || 'Anonymous',
            value: u.invited
          }));
        } else if (category === 'games') {
          const users = await UserModel.find().sort({ gamesPlayed: -1 }).limit(10);
          return users.map(u => ({
            name: u.firstName || u.username || 'Anonymous',
            value: u.gamesPlayed
          }));
        } else {
          // Default: deposit or totalWon
          const users = await UserModel.find().sort({ totalWon: -1 }).limit(10);
          return users.map(u => ({
            name: u.firstName || u.username || 'Anonymous',
            value: u.totalWon
          }));
        }
      } catch (err) {
        console.error('Mongoose getTopWinners error:', err);
      }
    }

    // Memory fallback / Mock leaderboards
    const mockNames = ['Abebe', 'Chala', 'Selam', 'Kassa', 'JubaKing', 'Aster', 'Yared', 'Lydia', 'Dawit', 'Etenesh'];
    const list = [];
    for (let i = 0; i < mockNames.length; i++) {
      let val = 0;
      if (category === 'deposit') val = 1500 - (i * 120);
      else if (category === 'invite') val = 12 - i;
      else val = 48 - (i * 3);
      
      list.push({
        name: mockNames[i],
        value: val
      });
    }
    return list;
  },

  // Get User Rank
  async getMyRank(userId, period, category) {
    const list = await this.getTopWinners(period, category);
    const user = await this.getUser(userId);
    
    let userVal = 0;
    if (category === 'invite') userVal = user.invited;
    else if (category === 'games') userVal = user.gamesPlayed;
    else userVal = user.totalWon || 0;

    let rank = 11; // default rank out of top 10
    const name = user.firstName || user.username || 'You';
    const foundIdx = list.findIndex(w => w.name === name);
    if (foundIdx !== -1) {
      rank = foundIdx + 1;
      userVal = list[foundIdx].value;
    }

    return {
      rank,
      value: userVal
    };
  }
};

module.exports = db;
