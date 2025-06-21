const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const axios = require('axios');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Firebase Admin
const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: `https://money-tracker-fed3d-default-rtdb.firebaseio.com/`
});

const db = admin.database();

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());
app.use(express.static('public'));

// Middleware untuk verifikasi token
const verifyToken = async (req, res, next) => {
  try {
    const token = req.cookies.authToken;
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }
    
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', verifyToken, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/upload', verifyToken, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'upload.html'));
});

// Login endpoint
app.post('/api/login', async (req, res) => {
  try {
    const { idToken, user } = req.body;

    const decodedToken = await admin.auth().verifyIdToken(idToken);

    // Hanya update sebagian data user, tanpa menghapus transaksi
    await db.ref(`users/${decodedToken.uid}`).update({
      name: user.displayName,
      email: user.email,
      photoURL: user.photoURL,
      lastLogin: new Date().toISOString()
    });

    res.cookie('authToken', idToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 3600000,
      sameSite: 'strict'
    });

    res.json({ success: true, redirectUrl: '/dashboard' });
  } catch (error) {
    console.error('Login error:', error);
    res.status(401).json({ error: 'Authentication failed' });
  }
});


// Logout endpoint - FIXED: Hanya hapus cookie, tidak hapus data transaksi
app.post('/api/logout', async (req, res) => {
  try {
    // Hanya clear cookie untuk logout
    res.clearCookie('authToken', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict'
    });
    
    // Optional: Update last logout time tanpa menghapus data transaksi
    const token = req.cookies.authToken;
    if (token) {
      try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        await db.ref(`users/${decodedToken.uid}/lastLogout`).set(new Date().toISOString());
      } catch (tokenError) {
        // Token sudah invalid, abaikan error ini
        console.log('Token already invalid during logout');
      }
    }
    
    res.json({ 
      success: true, 
      message: 'Logout successful. Data transaksi Anda tetap tersimpan.' 
    });
  } catch (error) {
    console.error('Logout error:', error);
    // Tetap berhasil logout meskipun ada error
    res.clearCookie('authToken');
    res.json({ success: true });
  }
});

// Get user profile
app.get('/api/profile', verifyToken, async (req, res) => {
  try {
        const userUid = req.user.uid;
    const userRef = db.ref(`users/${userUid}`);
    const snapshot = await userRef.once('value');
    const userData = snapshot.val();
    
    res.json({
      uid: req.user.uid,
      name: userData?.name || '',
      email: userData?.email || '',
      photoURL: userData?.photoURL || ''
    });
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

// Get transactions
// Get all transactions
app.get('/api/transactions', verifyToken, async (req, res) => {
  try {
    const userUid = req.user.uid;
    const transactionsRef = db.ref(`users/${userUid}/transactions`);
    const snapshot = await transactionsRef.once('value');
    const transactions = snapshot.val() || {};

    const transactionsList = Object.entries(transactions).map(([key, value]) => ({
      id: key,
      ...value,
    }));

    res.json(transactionsList);
  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(500).json({ error: 'Failed to get transactions' });
  }
});

// Add a new transaction
app.post('/api/transactions', verifyToken, async (req, res) => {
  try {
    const { description, amount, category, type } = req.body;
    const userUid = req.user.uid;

    const newTransaction = {
      description,
      amount: parseFloat(amount),
      category: category || 'Other',
      type,
      createdAt: new Date().toISOString()
    };

    const transactionsRef = db.ref(`users/${userUid}/transactions`);
    const newTransactionRef = transactionsRef.push();
    await newTransactionRef.set(newTransaction);

    res.status(201).json({ id: newTransactionRef.key, ...newTransaction });
  } catch (error) {
    console.error('Add transaction error:', error);
    res.status(500).json({ error: 'Failed to add transaction' });
  }
});

// Update transaction
app.put('/api/transactions/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
        const userUid = req.user.uid;
    const { description, amount, category, type } = req.body;

    const updateData = {
      description,
      amount: parseFloat(amount),
      category: category || 'Other',
      type,
      updatedAt: new Date().toISOString()
    };

    const transactionRef = db.ref(`users/${userUid}/transactions/${id}`);
    await transactionRef.update(updateData);

    res.json({ id, ...updateData });
  } catch (error) {
    console.error('Update transaction error:', error);
    res.status(500).json({ error: 'Failed to update transaction' });
  }
});

// Delete transaction
app.delete('/api/transactions/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;

    const transactionRef = db.ref(`users/${userUid}/transactions/${id}`);
    await transactionRef.remove();

    res.json({ success: true });
  } catch (error) {
    console.error('Delete transaction error:', error);
    res.status(500).json({ error: 'Failed to delete transaction' });
  }
});


// OCR and Gemini processing endpoint
app.post('/api/process-receipt', verifyToken, async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    
    if (!imageBase64) {
      return res.status(400).json({ error: 'No image provided' });
    }
    
    // Send to Gemini for processing
    const geminiResponse = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{
          parts: [{
            text: "Analisis struk belanja ini dan ekstrak informasi produk dengan harga dalam format JSON. Berikan response dalam format: {\"items\": [{\"name\": \"nama produk\", \"price\": angka_harga}], \"total\": total_harga}. Hanya berikan JSON tanpa penjelasan tambahan."
          }, {
            inline_data: {
              mime_type: "image/jpeg",
              data: imageBase64.split(',')[1] // Remove data:image/jpeg;base64, prefix
            }
          }]
        }]
      },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
    
    const geminiText = geminiResponse.data.candidates[0].content.parts[0].text;
    
    // Try to parse JSON from Gemini response
    let parsedData;
    try {
      // Extract JSON from response (in case there's extra text)
      const jsonMatch = geminiText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsedData = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      console.error('JSON parse error:', parseError);
      // Fallback response
      parsedData = {
        items: [{ name: "Item tidak dapat diidentifikasi", price: 0 }],
        total: 0,
        note: "Gagal memproses struk, silakan input manual"
      };
    }
    
    res.json(parsedData);
  } catch (error) {
    console.error('Process receipt error:', error);
    res.status(500).json({ 
      error: 'Failed to process receipt',
      items: [{ name: "Error processing", price: 0 }],
      total: 0
    });
  }
});

// Get dashboard statistics
app.get('/api/stats', verifyToken, async (req, res) => {
  try {
        const userUid = req.user.uid;
    const transactionsRef = db.ref(`users/${userUid}/transactions`);
    const snapshot = await transactionsRef.once('value');
    const transactions = snapshot.val() || {};
    
    let totalIncome = 0;
    let totalExpense = 0;
    const categoryExpenses = {};
    
    Object.values(transactions).forEach(transaction => {
      if (transaction.type === 'income') {
        totalIncome += transaction.amount;
      } else if (transaction.type === 'expense') {
        totalExpense += transaction.amount;
        const category = transaction.category || 'Other';
        categoryExpenses[category] = (categoryExpenses[category] || 0) + transaction.amount;
      }
    });
    
    const balance = totalIncome - totalExpense;
    
    res.json({
      totalIncome,
      totalExpense,
      balance,
      categoryExpenses
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to get statistics' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});