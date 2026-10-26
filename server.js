/**
 * TechXZone Production-Ready WhatsApp AI Customer Support & Instant Order Bot
 * Ultra-Fast Low-Latency Edition (1-2s Instant Reply)
 * Website: https://techxzone.shop
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const pino = require('pino');
const QRCode = require('qrcode');
const { GoogleGenAI } = require('@google/genai');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  delay
} = require('@whiskeysockets/baileys');

// ================= ১. কনফিগারেশন ও এনভায়রনমেন্ট ভ্যালিডেশন =================
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const GEMINI_FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS || 'gemini-3.5-flash,gemini-2.5-flash')
  .split(',')
  .map(m => m.trim())
  .filter(Boolean);
const AI_TIMEOUT_MS = parseInt(process.env.AI_TIMEOUT_MS, 10) || 5000;
const ADMIN_PHONE = (process.env.ADMIN_PHONE || '8801404277094').replace(/[^0-9]/g, '');
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || 'TechXZoneSecretDashboardAuthKey2026';
const SITE_BASE_URL = (process.env.SITE_BASE_URL || 'https://techxzone.shop').replace(/\/+$/, '');
const CATALOG_REFRESH_MS = parseInt(process.env.CATALOG_REFRESH_MS, 10) || 900000;
const SESSION_BACKUP_INTERVAL_MS = parseInt(process.env.SESSION_BACKUP_INTERVAL_MS, 10) || 300000;

const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');
if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

// জেমিনাই ক্লায়েন্ট ইনিট
let aiClient = null;
if (GEMINI_API_KEY) {
  aiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  console.log('✅ Google Gemini Fast-Engine Ready with:', GEMINI_MODEL);
}

// ================= ২. গ্লোবাল স্টেট =================
const globalState = {
  waConnected: false,
  waConnecting: false,
  qrCodeDataUrl: null,
  pairingCode: null,
  pairingPhone: null,
  lastDisconnectReason: null,
  catalogLastUpdated: null,
  catalogCount: 0,
  activeAiModel: GEMINI_MODEL,
  recentLogs: []
};

function addLog(level, message) {
  const time = new Date().toISOString().substring(11, 19);
  globalState.recentLogs.unshift({ time, level, message });
  if (globalState.recentLogs.length > 50) globalState.recentLogs.pop();
  console.log(`[${time}] [${level.toUpperCase()}]: ${message}`);
}

// ================= ৩. ক্যাটালগ ক্যাশিং =================
let cachedCatalog = [];
async function refreshProductCatalog() {
  try {
    const res = await axios.get(`${SITE_BASE_URL}/api.php?action=bot_catalog`, { timeout: 6000 });
    if (res.data?.status === 'success' && Array.isArray(res.data.products)) {
      cachedCatalog = res.data.products.map(p => ({
        id: p.id,
        name: String(p.name || '').trim(),
        price: parseFloat(p.price || 0),
        category: String(p.category || '').trim(),
        in_stock: String(p.in_stock || '').includes('হ্যাঁ'),
        buy_link: p.buy_link || `${SITE_BASE_URL}/?p=${p.id}`,
        description: String(p.description || '').trim()
      }));
      globalState.catalogCount = cachedCatalog.length;
      globalState.catalogLastUpdated = new Date().toLocaleTimeString('bn-BD', { timeZone: 'Asia/Dhaka' });
      addLog('info', `Catalog synced: ${cachedCatalog.length} items`);
    }
  } catch (err) {
    addLog('warn', `Catalog sync error: ${err.message}`);
  }
}
setInterval(refreshProductCatalog, CATALOG_REFRESH_MS);

function searchRelevantProducts(query, maxResults = 3) {
  if (!query || cachedCatalog.length === 0) return cachedCatalog.slice(0, 2);
  const q = query.toLowerCase();
  const tokens = q.split(/\s+/).filter(t => t.length > 1);

  const scored = cachedCatalog.map(p => {
    let score = 0;
    const nameLower = p.name.toLowerCase();
    if (nameLower === q) score += 100;
    if (nameLower.includes(q)) score += 50;
    tokens.forEach(tok => {
      if (nameLower.includes(tok)) score += 20;
    });
    return { product: p, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.filter(s => s.score > 0).slice(0, maxResults).map(s => s.product);
  return top.length > 0 ? top : cachedCatalog.slice(0, 2);
}

// ================= ৪. সেশন ব্যাকআপ/রিস্টোর =================
async function restoreSessionFromRemote() {
  try {
    const res = await axios.get(`${SITE_BASE_URL}/api.php?action=get_settings&key=wa_full_session_bundle`, { timeout: 10000 });
    let bundle = res.data;
    if (typeof bundle === 'string') {
      try { bundle = JSON.parse(bundle); } catch (_) {}
    }
    if (bundle?.files && Object.keys(bundle.files).length > 0) {
      for (const [filename, base64Content] of Object.entries(bundle.files)) {
        const safeName = path.basename(filename);
        if (!safeName.includes('..')) {
          fs.writeFileSync(path.join(AUTH_DIR, safeName), Buffer.from(base64Content, 'base64'));
        }
      }
      addLog('info', 'Remote session restored.');
      return true;
    }
  } catch (_) {}
  return false;
}

async function backupSessionToRemote() {
  try {
    if (!fs.existsSync(AUTH_DIR) || !fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) return;
    const bundle = { files: {}, updatedAt: new Date().toISOString() };
    for (const f of fs.readdirSync(AUTH_DIR)) {
      const full = path.join(AUTH_DIR, f);
      if (fs.statSync(full).isFile()) bundle.files[f] = fs.readFileSync(full).toString('base64');
    }
    await axios.post(`${SITE_BASE_URL}/api.php?action=save_settings`, {
      key: 'wa_full_session_bundle',
      value: bundle
    }, { timeout: 12000 });
  } catch (_) {}
}
setInterval(backupSessionToRemote, SESSION_BACKUP_INTERVAL_MS);

// ================= ৫. গ্রাহক চ্যাট সেশন =================
const userSessions = new Map();
function getUserSession(phone) {
  const now = Date.now();
  if (!userSessions.has(phone)) {
    userSessions.set(phone, {
      history: [],
      orderState: { step: 'IDLE', product: null, qty: 1, name: '', address: '', total: 0, courier: 70 },
      lastActive: now
    });
  }
  const session = userSessions.get(phone);
  session.lastActive = now;
  return session;
}

// ================= ৬. বিদ্যুৎগতির জেমিনাই ইঞ্জিন (Thinking Budget = 0) =================
async function callGeminiUltraFast(prompt, systemInstruction) {
  if (!aiClient) throw new Error('AI not configured');
  const modelsToTry = [GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS];

  for (const modelId of modelsToTry) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

    try {
      const start = Date.now();
      // ⚡ থিংকিং মোড পুরোপুরি বন্ধ এবং শর্ট আউটপুট: ১-২ সেকেন্ডে রেসপন্স
      const response = await aiClient.models.generateContent({
        model: modelId,
        contents: prompt,
        config: {
          systemInstruction: systemInstruction,
          temperature: 0.2,
          maxOutputTokens: 200,
          thinkingConfig: {
            thinkingBudget: 0 // 🚀 কোনো ব্যাকগ্রাউন্ড লেটেন্সি নেই
          }
        }
      });
      clearTimeout(timeout);
      const text = response.text?.trim();
      if (text) {
        addLog('info', `Speed: ${Date.now() - start}ms [${modelId}]`);
        return text;
      }
    } catch (err) {
      clearTimeout(timeout);
      // যদি thinkingBudget প্যারামিটারটি কোনো মডেল সাপোর্ট না করে তবে সাধারণ কল
      try {
        const fallbackRes = await aiClient.models.generateContent({
          model: modelId,
          contents: prompt,
          config: {
            systemInstruction: systemInstruction,
            temperature: 0.2,
            maxOutputTokens: 180
          }
        });
        const text = fallbackRes.text?.trim();
        if (text) return text;
      } catch (_) {}
    }
  }
  throw new Error('All fast models timed out');
}

// ================= ৭. অর্ডার বুকিং =================
async function executeOrderCreation(orderPayload) {
  try {
    const res = await axios.post(`${SITE_BASE_URL}/api.php?action=create_order`, orderPayload, { timeout: 10000 });
    return {
      success: res.data?.status === 'success',
      orderId: res.data?.orderId || orderPayload.orderId
    };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// ================= ৮. মেসেজ প্রসেসিং =================
async function handleCustomerIncomingMessage(phone, text) {
  const session = getUserSession(phone);
  const cleanInput = text.trim();
  const lowerInput = cleanInput.toLowerCase();

  // ১. অর্ডার কনফার্মেশন চেক
  if (session.orderState.step === 'AWAITING_CONFIRMATION') {
    if (/^(হ্যাঁ|হ্যা|হাঁ|yes|confirm|কনফার্ম|ok|ঠিক আছে|হুম|পাঠিয়ে দিন)$/i.test(lowerInput)) {
      const state = session.orderState;
      const orderId = 'TXZ-' + Math.floor(100000 + Math.random() * 900000);
      const orderPayload = {
        orderId,
        customerName: state.name,
        phone: phone,
        division: state.address.includes('ঢাকা') ? 'ঢাকা' : 'অন্যান্য',
        district: 'ঢাকা',
        address: state.address,
        items: [{ id: state.product.id, name: state.product.name, price: state.product.price, qty: state.qty }],
        subtotal: state.product.price * state.qty,
        courierFee: state.courier,
        codDue: state.total,
        grandTotal: state.total,
        paymentMethod: 'Cash on Delivery',
        status: 'Pending'
      };

      const result = await executeOrderCreation(orderPayload);
      session.orderState = { step: 'IDLE', product: null, qty: 1, name: '', address: '', total: 0, courier: 70 };

      if (result.success) {
        // অ্যাডমিনকে নোটিফিকেশন
        if (sock) {
          sock.sendMessage(`${ADMIN_PHONE}@s.whatsapp.net`, {
            text: `🚨 *নতুন অর্ডার:* #${orderId}\n👤 ${state.name} (${phone})\n📦 ${state.product.name} (৳${state.total})\n📍 ${state.address}`
          }).catch(() => {});
        }
        return `🎉 *ধন্যবাদ ভাইয়া! আপনার অর্ডারটি নিশ্চিত হয়েছে।*\n\n🆔 *অর্ডার আইডি:* #${orderId}\n📦 *পণ্য:* ${state.product.name}\n💰 *বিল:* ৳${state.total} (ক্যাশ অন ডেলিভারি)\n📍 *ঠিকানা:* ${state.address}\n\nখুব শীঘ্রই পার্সেলটি পাঠিয়ে দেওয়া হবে ❤️`;
      }
    } else if (/^(না|no|বাতিল|cancel)$/i.test(lowerInput)) {
      session.orderState = { step: 'IDLE', product: null, qty: 1, name: '', address: '', total: 0, courier: 70 };
      return `অর্ডারটি বাতিল করা হয়েছে ভাইয়া। অন্য কিছু দেখতে চাইলে জানান 😊`;
    }
  }

  // প্রাসঙ্গিক ২-৩টি পণ্য
  const relevant = searchRelevantProducts(cleanInput, 2);
  const catalogContext = relevant.map(p => `[ID:${p.id}] ${p.name} - ৳${p.price} (${p.in_stock ? 'স্টকে আছে' : 'স্টক শেষ'})`).join('\n');

  const systemPrompt = `TechXZone (https://techxzone.shop) এর বিনয়ী বাংলা সেলস অ্যাসিস্ট্যান্ট।
নিয়ম:
১. গ্রাহককে সবসময় "ভাইয়া" বলে সম্বোধন করবেন।
২. ১-২ লাইনে খুব দ্রুত ও সংক্ষেপে পয়েন্টে উত্তর দিন। দীর্ঘ কথা বলবেন না।
৩. শুধু এই পণ্য তালিকা ব্যবহার করুন:
${catalogContext}
৪. ডেলিভারি চার্জ: ঢাকা ৳৭০, ঢাকার বাইরে ৳১৩০। সারা দেশে ক্যাশ অন ডেলিভারি।
৫. অর্ডার করতে চাইলে বলুন নাম ও ঠিকানা লিখে দিতে।`;

  try {
    const reply = await callGeminiUltraFast(`গ্রাহক: "${cleanInput}"`, systemPrompt);
    const formatted = reply.replace(/\*\*(.*?)\*\*/g, '*$1*');

    // যদি ঠিকানা পাঠিয়ে থাকে
    if (cleanInput.length > 15 && (cleanInput.includes('ঠিকানা') || cleanInput.includes('নাম') || /01[3-9]\d{8}/.test(cleanInput))) {
      const topP = relevant[0];
      if (topP) {
        const isOutside = !cleanInput.includes('ঢাকা');
        const courier = isOutside ? 130 : 70;
        const total = topP.price + courier;
        session.orderState = {
          step: 'AWAITING_CONFIRMATION',
          product: topP,
          qty: 1,
          name: cleanInput.split('\n')[0].replace(/(নাম|name|:)/gi, '').trim() || 'সম্মানিত গ্রাহক',
          address: cleanInput,
          courier,
          total
        };
        return `${formatted}\n\n📋 *অর্ডার সারসংক্ষেপ:*\n• পণ্য: *${topP.name}*\n• সর্বমোট বিল: *৳${total}* (${isOutside ? 'ঢাকার বাইরে ৳১৩০' : 'ঢাকার ভিতরে ৳৭০'})\n\nভাইয়া, পার্সেলটি কি পাঠিয়ে দেব? কনফার্ম করতে *'হ্যাঁ'* লিখে জানান।`;
      }
    }
    return formatted;
  } catch (err) {
    const topP = relevant[0];
    if (topP) {
      return `হ্যালো ভাইয়া! আমাদের শপের *${topP.name}* এর বর্তমান মূল্য ৳${topP.price}। ${topP.in_stock ? 'পণ্যটি স্টকে আছে।' : ''}\n\nডেলিভারি চার্জ: ঢাকার ভিতরে ৳৭০, বাইরে ৳১৩০ (ক্যাশ অন ডেলিভারি)। অর্ডার করতে আপনার নাম ও সম্পূর্ণ ঠিকানা লিখে দিন ভাইয়া।`;
    }
    return `হ্যালো ভাইয়া! TechXZone-এ স্বাগতম। আপনি কোন গ্যাজেটটি সম্পর্কে জানতে চাচ্ছেন নাম লিখে জানান, আমি এখনই দাম জানিয়ে দিচ্ছি।`;
  }
}

// ================= ৯. হোয়াটসঅ্যাপ কানেকশন =================
let sock = null;
const processedMessageIds = new Set();

async function startWhatsAppBot() {
  if (globalState.waConnecting) return;
  globalState.waConnecting = true;

  try {
    if (!fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
      await restoreSessionFromRemote();
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      auth: state,
      browser: ['TechXZone Bot', 'Chrome', '128.0.0.0'],
      syncFullHistory: false
    });

    sock.ev.on('creds.update', async () => {
      await saveCreds();
      backupSessionToRemote().catch(() => {});
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) globalState.qrCodeDataUrl = await QRCode.toDataURL(qr);

      if (connection === 'close') {
        globalState.waConnected = false;
        globalState.waConnecting = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code !== DisconnectReason.loggedOut) {
          setTimeout(startWhatsAppBot, 4000);
        }
      } else if (connection === 'open') {
        globalState.waConnected = true;
        globalState.waConnecting = false;
        globalState.qrCodeDataUrl = null;
        globalState.pairingCode = null;
        addLog('info', 'WhatsApp Connected & Ready!');
        await refreshProductCatalog();
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const m of messages) {
        if (!m.message || m.key.fromMe) continue;
        const msgId = m.key.id;
        if (processedMessageIds.has(msgId)) continue;
        processedMessageIds.add(msgId);
        if (processedMessageIds.size > 1000) processedMessageIds.delete(processedMessageIds.values().next().value);

        const from = m.key.remoteJid;
        if (!from || from.endsWith('@g.us')) continue;

        const incomingText = (m.message.conversation || m.message.extendedTextMessage?.text || '').trim();
        if (!incomingText) continue;

        const customerPhone = from.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');

        // রিড রিসিপ্ট
        sock.readMessages([m.key]).catch(() => {});
        sock.sendPresenceUpdate('composing', from).catch(() => {});

        try {
          const replyText = await handleCustomerIncomingMessage(customerPhone, incomingText);
          await sock.sendMessage(from, { text: replyText });
        } catch (_) {
          await sock.sendMessage(from, { text: 'ভাইয়া, সাময়িক নেটওয়ার্ক ত্রুটির কারণে রিপ্লাই যেতে দেরি হয়েছে। দয়া করে আরেকবার লিখুন।' });
        } finally {
          sock.sendPresenceUpdate('paused', from).catch(() => {});
        }
      }
    });
  } catch (err) {
    globalState.waConnecting = false;
    setTimeout(startWhatsAppBot, 5000);
  }
}

// ================= ১০. এক্সপ্রেস ও ড্যাশবোর্ড এপিআই =================
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.json({ status: 'ok', wa: globalState.waConnected }));

app.get('/api/status', (req, res) => {
  res.json({
    success: true,
    data: {
      waConnected: globalState.waConnected,
      waConnecting: globalState.waConnecting,
      hasQr: !!globalState.qrCodeDataUrl,
      qrCode: globalState.qrCodeDataUrl,
      pairingCode: globalState.pairingCode,
      catalogCount: globalState.catalogCount,
      catalogLastUpdated: globalState.catalogLastUpdated,
      recentLogs: globalState.recentLogs.slice(0, 25)
    }
  });
});

app.post('/get-code', async (req, res) => {
  const phone = (req.body.phone || '').replace(/[^0-9]/g, '');
  if (!phone || phone.length < 10) return res.status(400).json({ success: false, message: 'সঠিক নম্বর দিন' });

  try {
    if (!sock) { await startWhatsAppBot(); await delay(2000); }
    if (sock && !sock.authState.creds.registered) {
      const code = await sock.requestPairingCode(phone);
      globalState.pairingCode = code;
      return res.json({ success: true, pairingCode: code });
    }
    return res.status(400).json({ success: false, message: 'ইতিমধ্যে রেজিস্টার্ড' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/refresh-catalog', async (req, res) => {
  await refreshProductCatalog();
  res.json({ success: true, total: globalState.catalogCount });
});

app.post('/hard-reset', async (req, res) => {
  if (sock) { try { sock.end(undefined); } catch (_) {} sock = null; }
  if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  setTimeout(startWhatsAppBot, 2000);
  res.json({ success: true, message: 'সেশন রিসেট হয়েছে।' });
});

app.post('/api/ai-chat', async (req, res) => {
  const message = req.body.message || '';
  if (!message) return res.status(400).json({ success: false });
  const reply = await handleCustomerIncomingMessage('web_test', message);
  res.json({ success: true, reply });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', async () => {
  addLog('info', `Server running on port ${PORT}`);
  await refreshProductCatalog();
  await startWhatsAppBot();
});
