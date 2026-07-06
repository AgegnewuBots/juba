require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

// Fallback to memory db if Supabase is not configured
const isDbConnected = Boolean(supabaseUrl && supabaseKey);
const supabase = isDbConnected ? createClient(supabaseUrl, supabaseKey) : null;

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
      invited: Math.floor(Math.random() * 5),
      isVip: false
    };
  }
  return memoryDb.users[userId];
}

module.exports = {
  async getUser(userId) {
    if (isDbConnected) {
      try {
        let { data: user, error } = await supabase
          .from('users')
          .select('*')
          .eq('user_id', userId)
          .single();

        if (error && error.code === 'PGRST116') {
          // User not found, create one
          const { data: newUser, error: insertError } = await supabase
            .from('users')
            .insert([{ user_id: userId }])
            .select()
            .single();
            
          if (insertError) throw insertError;
          return newUser;
        }
        
        if (error) throw error;
        return user;
      } catch (err) {
        console.error('Supabase getUser error:', err);
      }
    }
    return getMemoryUser(userId);
  },

  async registerWebUser(userId, password) {
    if (isDbConnected) {
      try {
        const { data: user, error } = await supabase
          .from('users')
          .insert([{ user_id: userId, password: password }])
          .select()
          .single();
        if (error) throw error;
        return user;
      } catch (err) {
        console.error('Supabase register error:', err);
        return null;
      }
    }
    const memUser = getMemoryUser(userId);
    memUser.password = password;
    return memUser;
  },

  async loginWebUser(userId, password) {
    if (isDbConnected) {
      try {
        const { data: user, error } = await supabase
          .from('users')
          .select('*')
          .eq('user_id', userId)
          .eq('password', password)
          .single();
        
        if (error) {
          if (error.code === 'PGRST116') return null; // No matching user/pass
          throw error;
        }
        return user;
      } catch (err) {
        console.error('Supabase login error:', err);
        return null;
      }
    }
    const memUser = memoryDb.users[userId];
    if (memUser && memUser.password === password) {
      return memUser;
    }
    return null;
  },

  async updateUserName(userId, firstName, username) {
    if (isDbConnected) {
      try {
        await supabase
          .from('users')
          .update({ first_name: firstName, username: username })
          .eq('user_id', userId);
      } catch (err) {
        console.error('Supabase updateUserName error:', err);
      }
    } else {
      const user = getMemoryUser(userId);
      user.firstName = firstName;
      user.username = username;
    }
  },

  async deductBet(userId, amount) {
    if (isDbConnected) {
      try {
        const { data: user, error } = await supabase
          .from('users')
          .select('play_balance, main_balance')
          .eq('user_id', userId)
          .single();
          
        if (error) throw error;
        if (!user) return null;
        
        let play = parseFloat(user.play_balance);
        let main = parseFloat(user.main_balance);
        
        if (play + main < amount) return null; // Insufficient balance
        
        if (play >= amount) {
          play -= amount;
        } else {
          main -= (amount - play);
          play = 0;
        }
        
        // Update balances
        const { data: updatedUser, error: updateError } = await supabase
          .from('users')
          .update({ play_balance: play, main_balance: main })
          .eq('user_id', userId)
          .select()
          .single();
          
        if (updateError) throw updateError;
        
        // Log transaction
        await supabase.from('transactions').insert([{
          user_id: userId,
          type: 'bet',
          amount: amount,
          status: 'Done'
        }]);
        
        return updatedUser;
      } catch (err) {
        console.error('Supabase deductBet error:', err);
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

  async addWin(userId, amount, gameId) {
    if (isDbConnected) {
      try {
        const { data: user, error } = await supabase
          .from('users')
          .select('main_balance, games_won, total_won')
          .eq('user_id', userId)
          .single();
          
        if (error) throw error;
        
        const newMain = parseFloat(user.main_balance) + amount;
        const newGamesWon = parseInt(user.games_won) + 1;
        const newTotalWon = parseFloat(user.total_won) + amount;
        
        const { data: updatedUser, error: updateError } = await supabase
          .from('users')
          .update({
            main_balance: newMain,
            games_won: newGamesWon,
            total_won: newTotalWon
          })
          .eq('user_id', userId)
          .select()
          .single();
          
        if (updateError) throw updateError;
        
        // Log transaction
        await supabase.from('transactions').insert([{
          user_id: userId,
          type: 'bingo_win',
          amount: amount,
          status: 'Done'
        }]);
        
        // Update Game History Result
        await supabase
          .from('game_history')
          .update({ result: '+' + amount + ' Br' })
          .eq('user_id', userId)
          .eq('game_id', gameId);
          
        return updatedUser;
      } catch (err) {
        console.error('Supabase addWin error:', err);
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
    
    const hist = memoryDb.gameHistory.find(h => h.userId === userId && h.gameId === gameId);
    if (hist) {
      hist.result = '+' + amount + ' Br';
    }
    
    return user;
  },

  async recordGamePlayed(userId, gameId, cardsCount, stake) {
    if (isDbConnected) {
      try {
        // Increment games_played
        const { data: user } = await supabase
          .from('users')
          .select('games_played')
          .eq('user_id', userId)
          .single();
          
        if (user) {
          await supabase
            .from('users')
            .update({ games_played: parseInt(user.games_played) + 1 })
            .eq('user_id', userId);
        }
          
        await supabase.from('game_history').insert([{
          user_id: userId,
          game_id: gameId,
          entry: cardsCount * stake,
          status: 'Completed',
          result: '-'
        }]);
      } catch (err) {
        console.error('Supabase recordGamePlayed error:', err);
      }
    } else {
      const user = getMemoryUser(userId);
      user.gamesPlayed += 1;
      memoryDb.gameHistory.push({
        userId,
        gameId,
        entry: cardsCount * stake,
        status: 'Completed',
        result: '-',
        time: new Date()
      });
    }
  },

  async getGameHistory(userId) {
    if (isDbConnected) {
      try {
        const { data, error } = await supabase
          .from('game_history')
          .select('*')
          .eq('user_id', userId)
          .order('time', { ascending: false })
          .limit(10);
          
        if (error) throw error;
        return data.map(d => ({
          game_id: d.game_id,
          entry: d.entry,
          status: d.status,
          result: d.result,
          time: d.time
        }));
      } catch (err) {
        console.error('Supabase getGameHistory error:', err);
        return [];
      }
    }
    
    return memoryDb.gameHistory
      .filter(h => h.userId === userId)
      .sort((a, b) => b.time - a.time)
      .slice(0, 10)
      .map(h => ({
        game_id: h.gameId,
        entry: h.entry,
        status: h.status,
        result: h.result,
        time: h.time.toISOString()
      }));
  },

  async getTransactions(userId) {
    if (isDbConnected) {
      try {
        const { data, error } = await supabase
          .from('transactions')
          .select('*')
          .eq('user_id', userId)
          .order('time', { ascending: false })
          .limit(20);
          
        if (error) throw error;
        return data.map(d => ({
          type: d.type,
          amount: d.amount,
          status: d.status,
          time: d.time
        }));
      } catch (err) {
        console.error('Supabase getTransactions error:', err);
        return [];
      }
    }
    
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

  async getProfileStats(userId) {
    if (isDbConnected) {
      try {
        const { data: user, error } = await supabase
          .from('users')
          .select('games_played, games_won, total_won, invited, is_vip')
          .eq('user_id', userId)
          .single();
          
        if (error) throw error;
        return {
          games_played: user.games_played,
          games_won: user.games_won,
          total_won: user.total_won,
          invited: user.invited,
          is_vip: user.is_vip
        };
      } catch (err) {
        console.error('Supabase getProfileStats error:', err);
        return null;
      }
    }
    
    const user = getMemoryUser(userId);
    return {
      games_played: user.gamesPlayed,
      games_won: user.gamesWon,
      total_won: user.totalWon,
      invited: user.invited,
      is_vip: user.isVip
    };
  },

  async getTopWinners(period, category) {
    if (isDbConnected) {
      try {
        let orderBy = 'total_won';
        if (category === 'deposit') orderBy = 'main_balance'; // Approximating deposit via balance
        if (category === 'invite') orderBy = 'invited';
        if (category === 'games') orderBy = 'games_played';
        
        const { data, error } = await supabase
          .from('users')
          .select('first_name, username, main_balance, total_won, invited, games_played')
          .order(orderBy, { ascending: false })
          .limit(30);
          
        if (error) throw error;
        
        return data.map(u => ({
          name: u.first_name || u.username || 'Anonymous',
          value: u[orderBy]
        }));
      } catch (err) {
        console.error('Supabase getTopWinners error:', err);
        return [];
      }
    }
    
    // Memory fallback
    const users = Object.values(memoryDb.users);
    let sortFn;
    let valFn;
    
    if (category === 'deposit') {
      sortFn = (a, b) => b.mainBalance - a.mainBalance;
      valFn = u => u.mainBalance;
    } else if (category === 'invite') {
      sortFn = (a, b) => b.invited - a.invited;
      valFn = u => u.invited;
    } else {
      sortFn = (a, b) => b.gamesPlayed - a.gamesPlayed;
      valFn = u => u.gamesPlayed;
    }
    
    return users.sort(sortFn).slice(0, 30).map(u => ({
      name: u.firstName || u.username || 'Anonymous',
      value: valFn(u)
    }));
  },

  async getMyRank(userId, period, category) {
    if (isDbConnected) {
      try {
        let orderBy = 'total_won';
        if (category === 'deposit') orderBy = 'main_balance';
        if (category === 'invite') orderBy = 'invited';
        if (category === 'games') orderBy = 'games_played';
        
        const { data, error } = await supabase
          .from('users')
          .select('user_id, ' + orderBy)
          .order(orderBy, { ascending: false });
          
        if (error) throw error;
        
        const rankIdx = data.findIndex(u => u.user_id === userId);
        if (rankIdx !== -1) {
          return {
            rank: rankIdx + 1,
            value: data[rankIdx][orderBy]
          };
        }
        return null;
      } catch (err) {
        console.error('Supabase getMyRank error:', err);
        return null;
      }
    }
    
    // Memory fallback
    const users = Object.values(memoryDb.users);
    let sortFn;
    let valFn;
    if (category === 'deposit') {
      sortFn = (a, b) => b.mainBalance - a.mainBalance;
      valFn = u => u.mainBalance;
    } else if (category === 'invite') {
      sortFn = (a, b) => b.invited - a.invited;
      valFn = u => u.invited;
    } else {
      sortFn = (a, b) => b.gamesPlayed - a.gamesPlayed;
      valFn = u => u.gamesPlayed;
    }
    users.sort(sortFn);
    const r = users.findIndex(u => u.userId === userId);
    if (r !== -1) {
      return { rank: r + 1, value: valFn(users[r]) };
    }
    return null;
  }
};
