import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import express from 'express';
import pino from 'pino';
import { toDataURL } from 'qrcode';
import { Boom } from '@hapi/boom';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.join(__dirname, 'auth_info');
const PORT = 3001;

const logger = pino({ level: 'silent' });

let sock = null;
let currentQR = null;
let connectionState = 'disconnected'; // 'disconnected' | 'qr_pending' | 'connecting' | 'connected'
let reconnectTimer = null;
let qrTimeoutTimer = null;
let isManualLogout = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

// QR bekleme süresini (ms) uzatarak sonsuz döngüyü engelle
const QR_TIMEOUT_MS = 120000; // 120 saniye QR okutulmazsa beklemeye geç

function scheduleReconnect(delayMs = 5000) {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectAttempts++;

    if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
        console.log(`[WA] Maksimum yeniden baglanma denemesi asildi (${MAX_RECONNECT_ATTEMPTS}). Beklemeye aliniyor...`);
        // 5 dakika sonra sayacı sıfırla ve tekrar dene
        reconnectTimer = setTimeout(() => {
            reconnectAttempts = 0;
            connectionState = 'connecting';
            connectToWhatsApp();
        }, 5 * 60 * 1000);
        return;
    }

    const backoff = Math.min(delayMs * reconnectAttempts, 30000);
    console.log(`[WA] ${backoff / 1000}s sonra yeniden baglanilacak (deneme: ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
    reconnectTimer = setTimeout(() => {
        connectionState = 'connecting';
        connectToWhatsApp();
    }, backoff);
}

async function connectToWhatsApp() {
    // Önceki socket'i temizle
    if (sock) {
        try { sock.ev.removeAllListeners(); } catch (_) { }
        try { sock.end(); } catch (_) { }
        sock = null;
    }

    // QR timeout'u sıfırla
    if (qrTimeoutTimer) { clearTimeout(qrTimeoutTimer); qrTimeoutTimer = null; }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    // WhatsApp versiyonunu dinamik çek (hardcode yerine)
    let waVersion;
    try {
        const { version } = await fetchLatestBaileysVersion();
        waVersion = version;
        console.log(`[WA] WA versiyonu: ${version.join('.')}`);
    } catch (_) {
        waVersion = [2, 3000, 1017531287];
        console.log('[WA] Versiyon cekilemedi, varsayilan kullaniliyor.');
    }

    sock = makeWASocket({
        version: waVersion,
        logger,
        auth: state,
        printQRInTerminal: false,
        generateHighQualityLinkPreview: false,
        browser: ['Sipariş Paneli', 'Chrome', '120.0'],
        connectTimeoutMs: 60000,
        retryRequestDelayMs: 3000,
        getMessage: async () => ({ conversation: '' }),
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQR = await toDataURL(qr);
            connectionState = 'qr_pending';
            console.log('[WA] QR kod uretildi arayuzden okutun.');

            // QR belirli süre okutulmazsa sonsuz döngüyü engelle
            if (qrTimeoutTimer) clearTimeout(qrTimeoutTimer);
            qrTimeoutTimer = setTimeout(() => {
                console.log('[WA] QR zaman aşımı — bağlantı kapatıldı, beklemede.');
                currentQR = null;
                connectionState = 'disconnected';
                if (sock) {
                    try { sock.ev.removeAllListeners(); } catch (_) { }
                    try { sock.end(); } catch (_) { }
                    sock = null;
                }
                clearAuthDirectory();
            }, QR_TIMEOUT_MS);
        }

        if (connection === 'open') {
            if (qrTimeoutTimer) { clearTimeout(qrTimeoutTimer); qrTimeoutTimer = null; }
            currentQR = null;
            isManualLogout = false;
            reconnectAttempts = 0; // Basarili baglantida sayaci sifirla
            connectionState = 'connected';
            console.log('[WA] WhatsApp bağlantısı kuruldu ✓');
        }

        if (connection === 'close') {
            if (qrTimeoutTimer) { clearTimeout(qrTimeoutTimer); qrTimeoutTimer = null; }

            const statusCode = (lastDisconnect?.error instanceof Boom)
                ? lastDisconnect.error.output.statusCode
                : 0;

            console.log(`[WA] Bağlantı kesildi (kod: ${statusCode}). Manuel çıkış: ${isManualLogout}`);

            connectionState = 'disconnected';
            currentQR = null;

            const isLoggedOut = isManualLogout || statusCode === DisconnectReason.loggedOut;

            if (isLoggedOut) {
                console.log('[WA] Oturum kapatıldı. Auth dosyaları temizleniyor...');
                isManualLogout = false;
                reconnectAttempts = 0;
                clearAuthDirectory();
                connectionState = 'logged_out';
                currentQR = null;
                // Oturum kapatıldığında kullanıcı 'Bağlan' butonuna basana kadar beklenir
            } else if (statusCode === DisconnectReason.restartRequired) {
                console.log('[WA] Yeniden başlatma gerekiyor...');
                scheduleReconnect(2000);
            } else {
                scheduleReconnect(5000);
            }
        }
    });
}

function clearAuthDirectory() {
    try {
        if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
            console.log('[WA] Auth klasörü hızla temizlendi.');
        }
    } catch (err) {
        console.error('[WA] Auth klasörü temizlenirken hata:', err.message);
    }
}

// ── Express API ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// CORS for local Python server
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// POST /connect — WhatsApp bağlantı sürecini başlat (QR almak veya bağlanmak için)
app.post('/connect', (req, res) => {
    if (connectionState === 'disconnected' || connectionState === 'logged_out' || !sock) {
        reconnectAttempts = 0;
        connectionState = 'connecting';
        connectToWhatsApp();
    }
    res.json({ success: true, state: connectionState });
});

// POST /cancel — QR / bağlantı sürecini iptal et (socket'i kapat, state'i disconnected yap)
app.post('/cancel', (req, res) => {
    if (connectionState !== 'connected') {
        if (qrTimeoutTimer) { clearTimeout(qrTimeoutTimer); qrTimeoutTimer = null; }
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        currentQR = null;
        reconnectAttempts = 0;
        connectionState = 'disconnected';
        if (sock) {
            try { sock.ev.removeAllListeners(); } catch (_) { }
            try { sock.end(); } catch (_) { }
            sock = null;
        }
        console.log('[WA] Bağlantı süreci kullanıcı tarafından iptal edildi.');
    }
    res.json({ success: true, state: connectionState });
});

// GET /status — bağlantı durumu
app.get('/status', (req, res) => {
    let userPhone = null;
    let userName = null;
    if (sock && sock.user) {
        if (sock.user.name) userName = sock.user.name;
        if (sock.user.id) {
            const raw = sock.user.id.split(':')[0].split('@')[0];
            if (raw.length === 12 && raw.startsWith('90')) {
                userPhone = `+90 ${raw.slice(2, 5)} ${raw.slice(5, 8)} ${raw.slice(8, 10)} ${raw.slice(10)}`;
            } else {
                userPhone = `+${raw}`;
            }
        }
    }
    res.json({ state: connectionState, user: userPhone, userName: userName, attempts: reconnectAttempts });
});

// GET /qr — QR kod (base64 data URL)
app.get('/qr', (req, res) => {
    if (connectionState === 'qr_pending' && currentQR) {
        res.json({ qr: currentQR });
    } else {
        res.json({ qr: null, state: connectionState });
    }
});

// POST /send — mesaj gönder
// Body: { phone: "5XXXXXXXXX", message: "..." }
app.post('/send', async (req, res) => {
    const { phone, message } = req.body;

    if (connectionState !== 'connected' || !sock) {
        return res.status(503).json({ success: false, error: 'WhatsApp bağlı değil.' });
    }

    if (!phone || !message) {
        return res.status(400).json({ success: false, error: 'phone ve message zorunludur.' });
    }

    try {
        let jid = formatJID(phone);

        const [result] = await sock.onWhatsApp(jid.replace('@s.whatsapp.net', ''));
        if (!result?.exists) {
            return res.json({ success: false, error: 'Bu numara WhatsApp ta kayitli degil.' });
        }

        await sock.sendMessage(result.jid, { text: message });
        console.log(`[WA] Mesaj gönderildi → ${phone}`);
        res.json({ success: true });
    } catch (err) {
        console.error(`[WA] Gönderim hatası (${phone}):`, err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /logout — oturumu kapat
app.post('/logout', async (req, res) => {
    try {
        isManualLogout = true;
        reconnectAttempts = 0;
        if (qrTimeoutTimer) { clearTimeout(qrTimeoutTimer); qrTimeoutTimer = null; }
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        currentQR = null;
        connectionState = 'disconnected';

        if (sock) {
            try { sock.ev.removeAllListeners(); } catch (_) { }
            try { sock.end(); } catch (_) { }
            try { await sock.logout(); } catch (_) { }
            sock = null;
        }

        clearAuthDirectory();
        isManualLogout = false;
        res.json({ success: true });
    } catch (err) {
        console.error('[WA] Logout hatası:', err.message);
        clearAuthDirectory();
        isManualLogout = false;
        connectionState = 'disconnected';
        res.json({ success: true });
    }
});

function formatJID(phone) {
    let clean = phone.toString().replace(/\D/g, '');
    if (clean.startsWith('0') && clean.length === 11) {
        clean = '90' + clean.slice(1);
    } else if (!clean.startsWith('90') && clean.length === 10) {
        clean = '90' + clean;
    }
    return clean + '@s.whatsapp.net';
}

function hasValidSession() {
    try {
        const credsPath = path.join(AUTH_DIR, 'creds.json');
        if (!fs.existsSync(credsPath)) return false;
        const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
        return Boolean(creds && creds.me && (creds.registered === true || creds.me.id));
    } catch (_) {
        return false;
    }
}

// ── Başlat ────────────────────────────────────────────────────────────────────

app.listen(PORT, '127.0.0.1', () => {
    console.log(`[WA] WhatsApp servisi çalışıyor`);
    // Sadece gerçekten oturum açılmış geçerli bir WhatsApp hesabı varsa otomatik bağlan
    if (hasValidSession()) {
        connectionState = 'connecting';
        connectToWhatsApp();
    } else {
        clearAuthDirectory();
        connectionState = 'disconnected';
    }
});
