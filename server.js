/**
 * TechXZone Production-Ready WhatsApp AI Customer Support & Instant Order Bot
 * Engine: Node.js (v20+), Express, @whiskeysockets/baileys, @google/genai
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
const GEMINI_FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS || 'gemini-3.5-flash')
  .split(',')
  .map(m => m.trim())
  .filter(Boolean);
const AI_TIMEOUT_MS = parseInt(process.env.AI_TIMEOUT_MS, 10) || 8000;
const ADMIN_PHONE = (process.env.ADMIN_PHONE || '8801404277094').replace(/[^0-9]/g, '');
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || 'TechXZoneSecretDashboardAuthKey2026';
const SITE_BASE_URL = (process.env.SITE_BASE_URL || 'https://techxzone.shop').replace(/\/+$/, '');
const CATALOG_REFRESH_MS = parseInt(process.env.CATALOG_REFRESH_MS, 10) || 900000; // ১৫ মিনিট
const SESSION_BACKUP_INTERVAL_MS = parseInt(process.env.SESSION_BACKUP_INTERVAL_MS, 10) || 300000; // ৫ মিনিট

const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');
if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

// জেমিনাই ইনস্ট্যান্স
let aiClient = null;
if (GEMINI_API_KEY) {
  aiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  console.log('✅ Google Gemini SDK Initialized with primary model:', GEMINI_MODEL);
} else {
  console.warn('⚠️ GEMINI_API_KEY is not defined! AI features will run in fallback rule mode.');
}

// ================= ২. গ্লোবাল স্টেট ম্যানেজমেন্ট =================
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

function addLog(level, message, meta = null) {
  const time = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const logItem = { time, level, message, meta: meta ? JSON.stringify(meta) : null };
  globalState.recentLogs.unshift(logItem);
  if (globalState.recentLogs.length > 60) globalState.recentLogs.pop();
  console.log(`[${time}] [${level.toUpperCase()}]: ${message}`);
}

// ================= ৩. ক্যাটালগ সার্ভিস (Ultra-Fast Cached Memory) =================
let cachedCatalog = [];
let isCatalogFetching = false;

async function refreshProductCatalog() {
  if (isCatalogFetching) return cachedCatalog;
  isCatalogFetching = true;
  try {
    const url = `${SITE_BASE_URL}/api.php?action=bot_catalog`;
    const res = await axios.get(url, { timeout: 7000 });
    if (res.data && res.data.status === 'success' && Array.isArray(res.data.products)) {
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
      addLog('info', `Product Catalog updated. Total products: ${cachedCatalog.length}`);
    } else {
      addLog('warn', 'Catalog API returned unexpected structure, retaining previous cache.');
    }
  } catch (err) {
    addLog('error', `Failed to fetch catalog: ${err.message}`);
  } finally {
    isCatalogFetching = false;
  }
  return cachedCatalog;
}

// প্রতি ১৫ মিনিটে স্বয়ংক্রিয় ব্যাকগ্রাউন্ড রিফ্রেশ
setInterval(refreshProductCatalog, CATALOG_REFRESH_MS);

// ক্যাটালগ থেকে প্রাসঙ্গিক ৩-৫টি পণ্য স্মার্ট ফিল্টার
function searchRelevantProducts(query, maxResults = 4) {
  if (!query || cachedCatalog.length === 0) return cachedCatalog.slice(0, 3);
  const q = query.toLowerCase();
  const tokens = q.split(/\s+/).filter(t => t.length > 1);

  const scored = cachedCatalog.map(p => {
    let score = 0;
    const nameLower = p.name.toLowerCase();
    const descLower = p.description.toLowerCase();
    const catLower = p.category.toLowerCase();

    if (nameLower === q) score += 100;
    if (nameLower.includes(q)) score += 50;

    tokens.forEach(tok => {
      if (nameLower.includes(tok)) score += 20;
      if (catLower.includes(tok)) score += 10;
      if (descLower.includes(tok)) score += 5;
    });

    return { product: p, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.filter(s => s.score > 0).slice(0, maxResults).map(s => s.product);
  return top.length > 0 ? top : cachedCatalog.slice(0, 3);
}

// ================= ৪. সেশন ব্যাকআপ ও রিস্টোর ইঞ্জিন (PHP Settings API) =================
let isBackingUp = false;

async function restoreSessionFromRemote() {
  try {
    addLog('info', 'Checking remote PHP backend for session bundle...');
    const url = `${SITE_BASE_URL}/api.php?action=get_settings&key=wa_full_session_bundle`;
    const res = await axios.get(url, { timeout: 12000 });
    let bundle = res.data;
    if (typeof bundle === 'string') {
      try { bundle = JSON.parse(bundle); } catch (_) {}
    }
    if (bundle && typeof bundle === 'object' && bundle.files && Object.keys(bundle.files).length > 0) {
      addLog('info', `Restoring ${Object.keys(bundle.files).length} session files from remote...`);
      for (const [rawFilename, base64Content] of Object.entries(bundle.files)) {
        const safeName = path.basename(rawFilename);
        if (safeName.includes('..')) continue;
        const targetPath = path.join(AUTH_DIR, safeName);
        fs.writeFileSync(targetPath, Buffer.from(base64Content, 'base64'));
      }
      addLog('info', 'Remote session restored successfully!');
      return true;
    }
  } catch (err) {
    addLog('warn', `Session restore skip or error: ${err.message}`);
  }
  return false;
}

async function backupSessionToRemote() {
  if (isBackingUp || !fs.existsSync(AUTH_DIR)) return;
  isBackingUp = true;
  try {
    const files = fs.readdirSync(AUTH_DIR);
    if (!files || files.length === 0 || !files.includes('creds.json')) {
      isBackingUp = false;
      return;
    }

    const bundle = { files: {}, updatedAt: new Date().toISOString() };
    for (const f of files) {
      const fullPath = path.join(AUTH_DIR, f);
      if (fs.statSync(fullPath).isFile()) {
        bundle.files[f] = fs.readFileSync(fullPath).toString('base64');
      }
    }

    const payload = {
      key: 'wa_full_session_bundle',
      value: bundle
    };

    const res = await axios.post(`${SITE_BASE_URL}/api.php?action=save_settings`, payload, {
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' }
    });

    if (res.data && res.data.status === 'success') {
      addLog('info', 'WhatsApp session successfully backed up to remote PHP backend.');
    }
  } catch (err) {
    addLog('error', `Session backup failed: ${err.message}`);
  } finally {
    isBackingUp = false;
  }
}

setInterval(backupSessionToRemote, SESSION_BACKUP_INTERVAL_MS);

// ================= ৫. গ্রাহক চ্যাট হিস্ট্রি ও অর্ডার স্টেট মেশিন =================
const userSessions = new Map(); // senderPhone -> { history: [], orderState: {}, lastActive: timestamp }

function getCleanPhone(rawJid) {
  if (!rawJid) return '';
  const clean = rawJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
  return clean;
}

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

  // ৩০ মিনিট নিষ্ক্রিয় থাকলে হিস্ট্রি ছোট করা
  if (now - session.lastActive > 1800000) {
    session.history = [];
    session.orderState = { step: 'IDLE', product: null, qty: 1, name: '', address: '', total: 0, courier: 70 };
  }
  return session;
}

// মেমরি পরিষ্কার রাখা (প্রতি ২০ মিনিটে)
setInterval(() => {
  const now = Date.now();
  for (const [phone, sess] of userSessions.entries()) {
    if (now - sess.lastActive > 7200000) { // ২ ঘণ্টা পার হলে সম্পূর্ণ ড্রপ
      userSessions.delete(phone);
    }
  }
}, 1200000);

// ================= ৬. গুগল জেমিনাই এআই রেসপন্স জেনারেটর =================
async function callGeminiWithFallback(prompt, systemInstruction) {
  if (!aiClient) {
    throw new Error('AI client not initialized');
  }

  const modelsToTry = [GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS];
  let lastError = null;

  for (const modelId of modelsToTry) {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

    try {
      globalState.activeAiModel = modelId;
      const startTime = Date.now();

      const response = await aiClient.models.generateContent({
        model: modelId,
        contents: prompt,
        config: {
          systemInstruction: systemInstruction,
          temperature: 0.35,
          maxOutputTokens: 600
        }
      });

      clearTimeout(timeoutHandle);
      const elapsed = Date.now() - startTime;
      const replyText = response.text ? response.text.trim() : '';

      if (replyText) {
        addLog('info', `AI response generated via [${modelId}] in ${elapsed}ms`);
        return replyText;
      }
    } catch (err) {
      clearTimeout(timeoutHandle);
      lastError = err;
      const isAbort = err.name === 'AbortError' || err.message?.includes('aborted');
      addLog('warn', `Gemini model [${modelId}] failed: ${isAbort ? 'Timeout' : err.message}. Trying next fallback...`);

      // কোটা বা পারমিশন ভুল হলে বারবার ফলব্যাক লুপ বন্ধ
      if (err.status === 401 || err.status === 403) {
        throw new Error(`Authentication/Permission Error with API key: ${err.message}`);
      }
    }
  }

  throw lastError || new Error('All configured Gemini models failed to generate content');
}

// ================= ৭. ডিটারমিনিস্টিক অর্ডার এক্সিকিউশন সার্ভিস =================
async function executeOrderCreation(orderPayload) {
  try {
    const url = `${SITE_BASE_URL}/api.php?action=create_order`;
    const res = await axios.post(url, orderPayload, {
      timeout: 12000,
      headers: { 'Content-Type': 'application/json' }
    });

    if (res.data && res.data.status === 'success') {
      return {
        success: true,
        orderId: res.data.orderId || orderPayload.orderId,
        trackingCode: res.data.trackingCode || '',
        trackingLink: res.data.trackingLink || ''
      };
    }
    return {
      success: false,
      message: res.data?.message || 'ব্যাকএন্ড অর্ডার রিজেক্ট করেছে'
    };
  } catch (err) {
    return {
      success: false,
      message: err.message
    };
  }
}

async function notifyAdminWhatsApp(sock, orderDetails) {
  try {
    const adminJid = `${ADMIN_PHONE}@s.whatsapp.net`;
    const message = `🚨 *নতুন অর্ডার কনফার্ম হয়েছে (WhatsApp AI Bot)*\n\n` +
      `🆔 *অর্ডার আইডি:* #${orderDetails.orderId}\n` +
      `👤 *গ্রাহকের নাম:* ${orderDetails.name}\n` +
      `📱 *মোবাইল নম্বর:* ${orderDetails.phone}\n` +
      `📦 *পণ্য:* ${orderDetails.productName} (x${orderDetails.qty})\n` +
      `💰 *মোট বিল:* ৳${orderDetails.grandTotal} (ক্যাশ অন ডেলিভারি)\n` +
      `📍 *ঠিকানা:* ${orderDetails.address}\n\n` +
      `👉 দ্রুত ওয়েবসাইট অ্যাডমিন প্যানেল চেক করে পার্সেল বুক করুন।`;

    await sock.sendMessage(adminJid, { text: message });
    addLog('info', `Admin notification sent for order #${orderDetails.orderId}`);
  } catch (err) {
    addLog('error', `Failed to send admin notification: ${err.message}`);
  }
}

// ================= ৮. হোয়াটসঅ্যাপ কানেকশন ও মেসেজ হ্যান্ডলার =================
let sock = null;
const processedMessageIds = new Set();

async function startWhatsAppBot() {
  if (globalState.waConnecting) return;
  globalState.waConnecting = true;

  try {
    // প্রয়োজন হলে দূরবর্তী ব্যাকআপ থেকে সেশন আনবে
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
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000
    });

    sock.ev.on('creds.update', async () => {
      await saveCreds();
      // ক্রেডেনশিয়াল আপডেট হলে ব্যাকআপ
      backupSessionToRemote().catch(() => {});
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        globalState.qrCodeDataUrl = await QRCode.toDataURL(qr);
        addLog('info', 'New QR Code generated for pairing.');
      }

      if (connection === 'close') {
        globalState.waConnected = false;
        globalState.waConnecting = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        globalState.lastDisconnectReason = statusCode;
        addLog('warn', `WhatsApp connection closed. Status Code: ${statusCode}`);

        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          addLog('info', 'Reconnecting WhatsApp in 5 seconds...');
          setTimeout(startWhatsAppBot, 5000);
        } else {
          addLog('error', 'Logged out of WhatsApp. Clear session and repair.');
        }
      } else if (connection === 'open') {
        globalState.waConnected = true;
        globalState.waConnecting = false;
        globalState.qrCodeDataUrl = null;
        globalState.pairingCode = null;
        globalState.lastDisconnectReason = null;
        addLog('info', '🎉 TechXZone WhatsApp Bot Connected and Online!');
        await refreshProductCatalog();
        await backupSessionToRemote();
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const m of messages) {
        if (!m.message) continue;
        const msgId = m.key.id;
        if (processedMessageIds.has(msgId)) continue;
        processedMessageIds.add(msgId);
        if (processedMessageIds.size > 2000) {
          const first = processedMessageIds.values().next().value;
          processedMessageIds.delete(first);
        }

        // নিজের মেসেজ বা গ্রুপ মেসেজ উপেক্ষা
        if (m.key.fromMe) continue;
        const from = m.key.remoteJid;
        if (!from || from.endsWith('@g.us') || from.includes('status')) continue;

        const customerPhone = getCleanPhone(from);
        const incomingText = (
          m.message.conversation ||
          m.message.extendedTextMessage?.text ||
          m.message.imageMessage?.caption ||
          ''
        ).trim();

        if (!incomingText) continue;

        // টাইপিং স্ট্যাটাস ও রিড রিসিপ্ট
        try {
          await sock.readMessages([m.key]);
          await sock.sendPresenceUpdate('composing', from);
        } catch (_) {}

        try {
          const replyText = await handleCustomerIncomingMessage(customerPhone, incomingText);
          await delay(600); // হিউম্যান ফিলিংয়ের জন্য সামান্য বিরতি
          await sock.sendMessage(from, { text: replyText });
        } catch (err) {
          addLog('error', `Error processing reply for ${customerPhone}: ${err.message}`);
          await sock.sendMessage(from, {
            text: 'ভাইয়া, দুঃখিত! সাময়িক নেটওয়ার্ক অসুবিধার কারণে রেসপন্স দেওয়া সম্ভব হচ্ছে না। অনুগ্রহ করে কিছুক্ষণ পর আবার মেসেজ দিন অথবা আমাদের হটলাইনে কল করুন: +8801771049068'
          });
        } finally {
          try {
            await sock.sendPresenceUpdate('paused', from);
          } catch (_) {}
        }
      }
    });

  } catch (err) {
    globalState.waConnecting = false;
    addLog('error', `Baileys initialization crashed: ${err.message}`);
    setTimeout(startWhatsAppBot, 10000);
  }
}

// ================= ৯. মেসেজ প্রসেসিং ও লজিক পাইপলাইন =================
async function handleCustomerIncomingMessage(phone, text) {
  const session = getUserSession(phone);
  const cleanInput = text.trim();
  const lowerInput = cleanInput.toLowerCase();

  // ১. অর্ডার কনফার্মেশন স্টেট চেক (যদি আগে সামারি দেওয়া হয়ে থাকে)
  if (session.orderState.step === 'AWAITING_CONFIRMATION') {
    const isAffirmative = /^(হ্যাঁ|হ্যা|হাঁ|yes|confirm|কনফার্ম|করুন|ok|ঠিক আছে|হুম|পাঠিয়ে দিন)$/i.test(lowerInput);
    const isCancel = /^(না|no|বাতিল|cancel|রাখব না|লাগবে না)$/i.test(lowerInput);

    if (isAffirmative) {
      const state = session.orderState;
      const orderId = 'TXZ-' + Math.floor(100000 + Math.random() * 900000);
      const orderPayload = {
        orderId,
        customerName: state.name,
        phone: phone,
        customerEmail: '',
        division: state.address.includes('ঢাকা') ? 'ঢাকা' : 'অন্যান্য',
        district: 'ঢাকা',
        upazila: '',
        address: state.address,
        customerNote: 'Order via WhatsApp AI Bot',
        items: [
          {
            id: state.product.id,
            name: state.product.name,
            title: state.product.name,
            price: state.product.price,
            qty: state.qty
          }
        ],
        subtotal: state.product.price * state.qty,
        discount: 0,
        courierFee: state.courier,
        advanceFee: 0,
        codDue: state.total,
        grandTotal: state.total,
        paymentMethod: 'Cash on Delivery',
        status: 'Pending'
      };

      const result = await executeOrderCreation(orderPayload);
      session.orderState = { step: 'IDLE', product: null, qty: 1, name: '', address: '', total: 0, courier: 70 };

      if (result.success) {
        notifyAdminWhatsApp(sock, {
          orderId,
          name: state.name,
          phone: phone,
          productName: state.product.name,
          qty: state.qty,
          grandTotal: state.total,
          address: state.address
        }).catch(() => {});

        return `🎉 *ধন্যবাদ ভাইয়া! আপনার অর্ডারটি সফলভাবে গ্রহণ করা হয়েছে।*\n\n` +
          `🆔 *অর্ডার আইডি:* #${orderId}\n` +
          `📦 *পণ্য:* ${state.product.name} (x${state.qty})\n` +
          `💰 *মোট প্রদেয় বিল:* ৳${state.total} (ক্যাশ অন ডেলিভারি)\n` +
          `📍 *ডেলিভারি ঠিকানা:* ${state.address}\n\n` +
          `🚚 আমাদের প্রতিনিধি দ্রুত পার্সেলটি প্যাক করে কুরিয়ারে হস্তান্তর করবেন। পার্সেল হাতে পাওয়ার পর মূল্য পরিশোধ করবেন। কোনো সমস্যা হলে আমাদের হেল্পলাইনে জানাবেন ❤️`;
      } else {
        return `ভাইয়া, অর্ডারটি সম্পন্ন করতে সাময়িক ব্যাকএন্ড সমস্যা হয়েছে (${result.message})। অনুগ্রহ করে সরাসরি ওয়েবসাইটে গিয়ে অর্ডার করুন: ${state.product.buy_link}`;
      }
    } else if (isCancel) {
      session.orderState = { step: 'IDLE', product: null, qty: 1, name: '', address: '', total: 0, courier: 70 };
      return `অর্ডারটি বাতিল করা হয়েছে ভাইয়া। আপনার পছন্দের অন্য কোনো গ্যাজেট বা তথ্য জানতে চাইলে আমাকে নির্দ্বিধায় মেসেজ দিতে পারেন 😊`;
    }
  }

  // ২. যদি গ্রাহক সরাসরি এক লাইনে সম্পূর্ণ অর্ডার তথ্য দিয়ে ফেলে: (উদাঃ নাম, পণ্য, ঠিকানা)
  // চেক করা যাক টেক্সটে কোনো পূর্ণাঙ্গ অর্ডারের প্যাটার্ন আছে কিনা
  const hasPhonePattern = /(?:01[3-9]\d{8})/i.test(cleanInput);
  const matchedProducts = searchRelevantProducts(cleanInput, 2);

  // ৩. প্রাসঙ্গিক পণ্য নির্বাচন
  const relevantProducts = searchRelevantProducts(cleanInput, 4);

  // ক্যাটালগ প্রম্পট কনটেক্সট তৈরি
  const catalogContext = relevantProducts.map(p =>
    `- [ID: ${p.id}] ${p.name} | মূল্য: ৳${p.price} | স্টক: ${p.in_stock ? 'স্টকে আছে' : 'স্টক শেষ'} | লিংক: ${p.buy_link}`
  ).join('\n');

  // সিস্টেম ইনস্ট্রাকশন (TechXZone এক্সক্লুসিভ বাংলা কাস্টমার সাপোর্ট)
  const systemInstruction = `
আপনি TechXZone (https://techxzone.shop) এর অত্যন্ত ভদ্র, মার্জিত এবং দ্রুতগতির সেলস ও কাস্টমার সাপোর্ট অ্যাসিস্ট্যান্ট।
আপনার নীতিসমূহ:
১. গ্রাহককে সবসময় অত্যন্ত বিনয়ের সাথে "ভাইয়া" সম্বোধন করে কথা বলবেন।
২. ভাষা হবে খাঁটি ও স্বাভাবিক বাংলা। অপ্রয়োজনীয় দীর্ঘ কথা না বলে পয়েন্ট টু পয়েন্ট দ্রুত উত্তর দিন।
৩. টেক্সট হাইলাইটের জন্য হোয়াটসঅ্যাপ সাপোর্ট উপযোগী সিঙ্গেল অ্যাস্টেরিস্ক যেমন *বোল্ড* ব্যবহার করবেন, কখনোই ডাবল অ্যাস্টেরিস্ক (**) ব্যবহার করবেন না।
৪. পণ্যের তথ্য, মূল্য ও স্টক শুধুমাত্র প্রদত্ত ভেরিফাইড ক্যাটালগ থেকে নেবেন। কোনো কাল্পনিক মূল্য বা ডিসকাউন্ট বলবেন না:
${catalogContext}
৫. ডেলিভারি চার্জ: ঢাকা সিটির ভিতরে ৳৭০, ঢাকার বাইরে ৳১৩০। সারা বাংলাদেশে ক্যাশ অন ডেলিভারি সুবিধা আছে (পণ্য হাতে পেয়ে টাকা)।
৬. কোনো পণ্য কেনার সরাসরি আগ্রহ প্রকাশ করলে তাকে ক্যাশ অন ডেলিভারিতে অর্ডার কনফার্ম করতে বলুন এবং অর্ডার ফর্ম্যাটে তথ্য চাইতে পারেন:
   - আপনার নাম
   - মোবাইল নম্বর
   - সম্পূর্ণ ঠিকানা (জেলা ও থানা সহ)
৭. অতিরিক্ত বা অপ্রাসঙ্গিক কথাবার্তা বলবেন না।
  `.trim();

  // ইউজার হিস্ট্রি একত্রীকরণ
  session.history.push({ role: 'user', text: cleanInput });
  if (session.history.length > 8) session.history.shift();

  const conversationThread = session.history.map(h => `${h.role === 'user' ? 'গ্রাহক' : 'অ্যাসিস্ট্যান্ট'}: ${h.text}`).join('\n');

  try {
    const aiPrompt = `
বর্তমান আলোচনা:
${conversationThread}

গ্রাহকের সর্বশেষ বার্তা: "${cleanInput}"
উপরে উল্লিখিত নীতি মেনে উত্তর দিন:
    `.trim();

    const reply = await callGeminiWithFallback(aiPrompt, systemInstruction);

    // AI উত্তরকে হোয়াটসঅ্যাপ ফরম্যাটিং ক্লিন করা
    const formattedReply = reply.replace(/\*\*(.*?)\*\*/g, '*$1*');
    session.history.push({ role: 'assistant', text: formattedReply });

    // ৪. যদি গ্রাহক নিজের নাম ও পূর্ণাঙ্গ ঠিকানা পাঠায় এবং আগের কনটেক্সটে পণ্য নির্ধারিত থাকে, তাহলে অর্ডার সামারি তৈরি করা
    if (cleanInput.length > 15 && (cleanInput.includes('ঠিকানা') || cleanInput.includes('নাম') || hasPhonePattern)) {
      const topP = relevantProducts[0];
      if (topP && topP.in_stock) {
        const isOutsideDhaka = !cleanInput.includes('ঢাকা');
        const courierFee = isOutsideDhaka ? 130 : 70;
        const total = topP.price + courierFee;

        session.orderState = {
          step: 'AWAITING_CONFIRMATION',
          product: topP,
          qty: 1,
          name: cleanInput.split('\n')[0].replace(/(নাম|name|:)/gi, '').trim() || 'সম্মানিত গ্রাহক',
          address: cleanInput,
          courier: courierFee,
          total: total
        };

        return `${formattedReply}\n\n` +
          `📋 *অর্ডার সারসংক্ষেপ:*\n` +
          `• পণ্য: *${topP.name}*\n` +
          `• মূল্য: ৳${topP.price}\n` +
          `• ডেলিভারি চার্জ: ৳${courierFee} (${isOutsideDhaka ? 'ঢাকার বাইরে' : 'ঢাকার ভিতরে'})\n` +
          `• সর্বমোট বিল: *৳${total}* (ক্যাশ অন ডেলিভারি)\n\n` +
          `ভাইয়া, আপনার অর্ডারটি কি ফাইনাল কনফার্ম করে পার্সেল পাঠিয়ে দিব? দয়া করে *'হ্যাঁ/কনফার্ম'* লিখে জানান।`;
      }
    }

    return formattedReply;
  } catch (err) {
    addLog('error', `Gemini Fallback completely failed: ${err.message}`);
    // রুল-বেসড অফলাইন দ্রুত রেসপন্স
    const topP = relevantProducts[0];
    if (topP) {
      return `হ্যালো ভাইয়া! আমাদের শপের *${topP.name}* বর্তমানে ৳${topP.price}-এ উপলব্ধ রয়েছে। স্টক: ${topP.in_stock ? 'স্টকে আছে' : 'স্টক শেষ'}। বিস্তারিত ও অর্ডারের লিংক: ${topP.buy_link}\n\nডেলিভারি চার্জ: ঢাকার ভিতরে ৳৭০, বাইরে ৳১৩০। ক্যাশ অন ডেলিভারিতে নিতে চাইলে আপনার নাম ও ঠিকানা পাঠিয়ে দিন।`;
    }
    return `হ্যালো ভাইয়া! TechXZone-এ আপনাকে স্বাগতম। আপনি কোন গ্যাজেটটি সম্পর্কে জানতে চাচ্ছেন দয়া করে নাম লিখে জানান, আমি এখনই তথ্য দিচ্ছি।`;
  }
}

// ================= ১০. এক্সপ্রেস অ্যাপ, মিডলওয়্যার ও সিকিউরিটি =================
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// পাবলিক এআই চ্যাট রেট লিমিটিং
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { success: false, message: 'অতিরিক্ত রিকোয়েস্ট পাঠানো হয়েছে। অনুগ্রহ করে ১ মিনিট পর চেষ্টা করুন।' }
});

// অথেনটিকেশন মিডলওয়্যার
function requireAuth(req, res, next) {
  const token = req.headers['authorization'] || req.query.token || req.body.token;
  const cleanToken = String(token || '').replace(/^Bearer\s+/i, '').trim();

  if (!DASHBOARD_TOKEN || cleanToken === DASHBOARD_TOKEN) {
    return next();
  }
  return res.status(401).json({ success: false, message: 'অননুমোদিত প্রবেশাধিকার! সঠিক ড্যাশবোর্ড টোকেন প্রদান করুন।' });
}

// ================= ১১. এপিআই রাউটস =================

// হেলথ চেক
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    whatsapp: globalState.waConnected ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString()
  });
});

// ড্যাশবোর্ড লাইভ স্ট্যাটাস
app.get('/api/status', (req, res) => {
  res.json({
    success: true,
    data: {
      waConnected: globalState.waConnected,
      waConnecting: globalState.waConnecting,
      hasQr: !!globalState.qrCodeDataUrl,
      qrCode: globalState.qrCodeDataUrl,
      pairingCode: globalState.pairingCode,
      pairingPhone: globalState.pairingPhone,
      catalogCount: globalState.catalogCount,
      catalogLastUpdated: globalState.catalogLastUpdated,
      activeAiModel: globalState.activeAiModel,
      primaryModel: GEMINI_MODEL,
      fallbackModels: GEMINI_FALLBACK_MODELS,
      recentLogs: globalState.recentLogs.slice(0, 30)
    }
  });
});

// পেয়ারিং কোড রিকোয়েস্ট
app.post('/get-code', requireAuth, async (req, res) => {
  const phone = (req.body.phone || '').replace(/[^0-9]/g, '');
  if (!phone || phone.length < 10) {
    return res.status(400).json({ success: false, message: 'সঠিক আন্তর্জাতিক ফরম্যাটে ফোন নম্বর দিন (যেমন: 88017...)' });
  }

  if (globalState.waConnected) {
    return res.json({ success: false, message: 'হোয়াটসঅ্যাপ ইতিমধ্যে কানেক্টেড রয়েছে!' });
  }

  try {
    if (!sock) {
      await startWhatsAppBot();
      await delay(2000);
    }

    if (sock && !sock.authState.creds.registered) {
      const code = await sock.requestPairingCode(phone);
      globalState.pairingCode = code;
      globalState.pairingPhone = phone;
      addLog('info', `Pairing code requested for: ${phone} -> Code: ${code}`);
      return res.json({ success: true, pairingCode: code, phone });
    } else {
      return res.status(400).json({ success: false, message: 'ডিভাইস ইতিমধ্যেই রেজিস্টার্ড অথবা সেশন সক্রিয় আছে।' });
    }
  } catch (err) {
    addLog('error', `Failed to get pairing code: ${err.message}`);
    return res.status(500).json({ success: false, message: `পেয়ারিং কোড ব্যর্থ: ${err.message}` });
  }
});

// পেয়ারিং কোড রি-সেন্ড
app.post('/resend-code', requireAuth, async (req, res) => {
  const phone = globalState.pairingPhone || req.body.phone;
  if (!phone) {
    return res.status(400).json({ success: false, message: 'পূর্বে কোনো ফোন নম্বর দেওয়া হয়নি।' });
  }
  try {
    if (sock) {
      const code = await sock.requestPairingCode(phone);
      globalState.pairingCode = code;
      return res.json({ success: true, pairingCode: code });
    }
    return res.status(500).json({ success: false, message: 'সকেট সক্রিয় নেই' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ক্যাটালগ ফোর্স রিফ্রেশ
app.post('/refresh-catalog', requireAuth, async (req, res) => {
  try {
    const list = await refreshProductCatalog();
    res.json({ success: true, total: list.length, message: 'ক্যাটালগ সফলভাবে রিফ্রেশ হয়েছে!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// হার্ড রিসেট (সেশন ক্লিয়ার এবং নতুন ইনিট)
app.post('/hard-reset', requireAuth, async (req, res) => {
  try {
    addLog('warn', 'Manual Hard Reset initiated by admin.');
    if (sock) {
      try { sock.end(undefined); } catch (_) {}
      sock = null;
    }

    globalState.waConnected = false;
    globalState.waConnecting = false;
    globalState.qrCodeDataUrl = null;
    globalState.pairingCode = null;

    // লোকাল ফাইল মোছা
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    }

    // ব্যাকএন্ড থেকেও রিমোট সেশন মুছে ফেলা
    try {
      await axios.post(`${SITE_BASE_URL}/api.php?action=save_settings`, {
        key: 'wa_full_session_bundle',
        value: {}
      }, { timeout: 8000 });
    } catch (_) {}

    setTimeout(startWhatsAppBot, 2000);
    res.json({ success: true, message: 'সেশন সফলভাবে ক্লিয়ার করা হয়েছে। নতুন করে পেয়ার করুন।' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ওয়েবসাইটের লাইভ এআই চ্যাট উইজেট এন্ডপয়েন্ট
app.post('/api/ai-chat', chatLimiter, async (req, res) => {
  const message = req.body.message || req.body.prompt;
  const userPhone = req.body.phone || 'web_guest_' + req.ip.replace(/[^0-9]/g, '');

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ success: false, message: 'মেসেজ ফিল্ড ফাঁকা রাখা যাবে না।' });
  }

  try {
    const reply = await handleCustomerIncomingMessage(userPhone, message.trim());
    return res.json({ success: true, reply });
  } catch (err) {
    return res.status(500).json({
      success: false,
      reply: 'ভাইয়া, সাময়িক টেকনিক্যাল ত্রুটির কারণে উত্তর দিতে পারছি না। দয়া করে একটু পর আবার চেষ্টা করুন।'
    });
  }
});

// ড্যাশবোর্ড সার্ভ
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ================= ১২. গ্রেসফুল শাটডাউন ও সার্ভার বুটস্ট্র্যাপ =================
const server = app.listen(PORT, '0.0.0.0', async () => {
  addLog('info', `🚀 TechXZone Bot Server running on port ${PORT} [http://0.0.0.0:${PORT}]`);
  await refreshProductCatalog();
  await startWhatsAppBot();
});

async function gracefulShutdown(signal) {
  addLog('warn', `Received ${signal}. Starting graceful shutdown...`);
  await backupSessionToRemote().catch(() => {});
  if (sock) {
    try { sock.end(undefined); } catch (_) {}
  }
  server.close(() => {
    addLog('info', 'HTTP server closed. Process terminating.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
