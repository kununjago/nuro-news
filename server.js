require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use(express.static('public'));
app.use('/admin', express.static('admin'));

let db;
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- SISTEM LOGIN ADMIN ---
const ADMIN_PASS = "Sholeh77@";
const failedLogins = new Map(); 

app.post('/api/admin/login', (req, res) => {
    const ip = req.ip;
    const { password } = req.body;
    const now = Date.now();

    if (failedLogins.has(ip)) {
        const status = failedLogins.get(ip);
        if (status.blockedUntil && status.blockedUntil > now) return res.status(403).json({ success: false, message: "Akses diblokir 24 jam!" });
        else if (status.blockedUntil && status.blockedUntil <= now) failedLogins.delete(ip);
    }

    if (password === ADMIN_PASS) {
        failedLogins.delete(ip);
        return res.json({ success: true, token: "nuro_authorized" });
    } else {
        let status = failedLogins.get(ip) || { count: 0, blockedUntil: null };
        status.count += 1;
        if (status.count > 4) {
            status.blockedUntil = now + (24 * 60 * 60 * 1000);
            failedLogins.set(ip, status);
            return res.status(403).json({ success: false, message: "Device diblokir 24 jam!" });
        }
        failedLogins.set(ip, status);
        return res.status(401).json({ success: false, message: `Password salah! Sisa: ${5 - status.count}` });
    }
});

// --- INISIALISASI DATABASE ---
(async () => {
    db = await open({ filename: './data/database.sqlite', driver: sqlite3.Database });
    await db.exec(`CREATE TABLE IF NOT EXISTS news (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT, url TEXT UNIQUE, description TEXT, content TEXT, status TEXT DEFAULT 'pending', views INTEGER DEFAULT 0
    )`);
})();

// --- AMBIL BERITA ---
async function fetchNews() {
    try {
        const res = await axios.get(`https://newsdata.io/api/1/news?apikey=${process.env.NEWSDATA_API_KEY}&country=id&language=id&category=technology`);
        for (let a of res.data.results) {
            await db.run(`INSERT OR IGNORE INTO news (title, url, description, content) VALUES (?, ?, ?, ?)`, [a.title, a.link, a.description, a.content]);
        }
        console.log("Berita diupdate otomatis!");
    } catch (err) { console.log("Gagal ambil berita API"); }
}
fetchNews(); setInterval(fetchNews, 600000);

// --- ENDPOINT PUBLIK (DIUPDATE DENGAN FITUR SEARCH & TRENDING) ---
app.get('/api/news', async (req, res) => {
    const { type, q } = req.query; // Menangkap kata kunci dari web
    
    let query = 'SELECT * FROM news';
    let params = [];

    // Jika ada yang melakukan pencarian
    if (q) {
        query += ' WHERE title LIKE ? OR description LIKE ?';
        params.push(`%${q}%`, `%${q}%`); // Cari kata kunci di Judul ATAU Deskripsi
        query += ' ORDER BY id DESC LIMIT 50'; // Tampilkan maksimal 50 untuk hasil pencarian
    } 
    // Jika tombol 'Trending' diklik
    else if (type === 'trending') {
        query += ' ORDER BY views DESC LIMIT 20'; // Urutkan berdasarkan Views terbanyak
    } 
    // Default: Tombol 'Terbaru'
    else {
        query += ' ORDER BY id DESC LIMIT 20';
    }

    try {
        const data = await db.all(query, params);
        res.json(data);
    } catch (error) {
        res.status(500).json({ success: false, message: "Gagal memuat berita." });
    }
});

// --- FITUR WARTAWAN AI (Ini yang merewrite artikel!) ---
app.get('/api/news/:id', async (req, res) => {
    const id = req.params.id;
    try {
        const article = await db.get('SELECT * FROM news WHERE id = ?', [id]);
        if (!article) return res.status(404).json({ success: false, message: "Berita tidak ditemukan" });

        await db.run('UPDATE news SET views = views + 1 WHERE id = ?', [id]); // Tambah view

        // Cek apakah kontennya kosong atau masih berisi pesan blokir
        const isContentBlocked = !article.content || article.content.toUpperCase().includes('ONLY AVAILABLE IN PAID PLANS');

        if (isContentBlocked) {
            console.log(`[AI] Gemini sedang merewrite artikel ID ${id}...`);
            const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
            const prompt = `Tulis ulang berita ini menjadi sebuah artikel web lengkap (minimal 3 paragraf). Gunakan bahasa jurnalistik teknologi kekinian yang santai.\n\nJudul: ${article.title}\nRingkasan: ${article.description || 'Tidak ada.'}\n\nLangsung berikan isi beritanya saja, jangan pakai kalimat pengantar.`;
            
            const result = await model.generateContent(prompt);
            const aiGeneratedText = result.response.text();

            await db.run('UPDATE news SET content = ? WHERE id = ?', [aiGeneratedText, id]);
            article.content = aiGeneratedText;
            console.log(`[AI] Selesai menulis ID ${id}!`);
        }
        res.json(article);
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// --- CAPTION AI (Buat Admin) ---
app.post('/api/ai-caption', async (req, res) => {
    const { title, desc } = req.body;
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const result = await model.generateContent(`Buatkan 2 caption viral untuk Instagram/Twitter dari berita ini:\nJudul: ${title}\nRingkasan: ${desc}\nGunakan bahasa gaul. Pisahkan opsi 1 dan 2 dengan baris baru.`);
        res.json({ success: true, text: result.response.text() });
    } catch (error) { res.json({ success: false, message: error.message }); }
});

// --- ENDPOINT DATA PASAR (CRYPTO & FOREX) ---
app.get('/api/market', async (req, res) => {
    try {
        // 1. Ambil harga Crypto dari CoinGecko (BTC, ETH, SOL)
        const cryptoRes = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=idr');
        
        // 2. Ambil kurs USD ke IDR dari ExchangeRate (Gratis)
        const forexRes = await axios.get('https://open.er-api.com/v6/latest/USD');

        const marketData = {
            btc: cryptoRes.data.bitcoin.idr,
            eth: cryptoRes.data.ethereum.idr,
            sol: cryptoRes.data.solana.idr,
            usdidr: forexRes.data.rates.IDR
        };

        res.json(marketData);
    } catch (error) {
        res.status(500).json({ error: "Gagal ambil data pasar" });
    }
});

app.listen(process.env.PORT || 3000, () => console.log(`Server aktif!`));