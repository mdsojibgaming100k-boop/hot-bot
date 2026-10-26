/**
 * TechXZone WhatsApp AI Bot - Phone JID Extractor & Guaranteed Text Delivery
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
  downloadMediaMessage,
  jidNormalizedUser,
  delay
} = require('@whiskeysockets/baileys');

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS || 'gemini-3.5-flash,gemini-3.6-flash')
  .split(',')
  .map(m => m.trim())
  .filter(Boolean);
const AI_TIMEOUT_MS = 15000;
const ADMIN_PHONE = (process.env.ADMIN_PHONE || '8801404277094').replace(/[^0-9]/g, '');
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || 'TechXZoneSecretDashboardAuthKey2026';
const SITE_BASE_URL = (process.env.SITE_BASE_URL || 'https://techxzone.shop').replace(/\/+$/, '');
const CATALOG_REFRESH_MS = parseInt(process.env.CATALOG_REFRESH_MS, 10) || 900000;

const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');
if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

let aiClient = null;
if (GEMINI_API_KEY) {
  aiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  console.log('✅ Google Gemini Ready with:', GEMINI_MODEL);
}

const globalState = {
  waConnected: false,
  waConnecting: false,
  qrCodeDataUrl: null,
  pairingCode: null,
  pairingPhone: null,
  catalogCount: 0,
  catalogLastUpdated: null,
  activeAiModel: GEMINI_MODEL,
  recentLogs: []
};

function addLog(level, message) {
  const time = new Date().toISOString().substring(11, 19);
  globalState.recentLogs.unshift({ time, level, message });
  if (globalState.recentLogs.length > 50) globalState.recentLogs.pop();
  console.log(`[${time}] [${level.toUpperCase()}]: ${message}`);
}

// ক্যাটালগ ক্যাশিং
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
    addLog('warn', `Catalog error: ${err.message}`);
  }
}
setInterval(refreshProductCatalog, CATALOG_REFRESH_MS);

function parseBudgetFromText(text) {
  const bnDigits = {'০':'0','১':'1','২':'2','৩':'3','৪':'4','৫':'5','৬':'6','৭':'7','৮':'8','৯':'9'};
  const normalized = text.replace(/[০-৯]/g, d => bnDigits[d]);
  const rangeMatch = normalized.match(/(\d+)\s*(?:থেকে|to|-)\s*(\d+)/i);
  if (rangeMatch) return { min: parseInt(rangeMatch[1], 10), max: parseInt(rangeMatch[2], 10) };

  const maxMatch = normalized.match(/(?:বাজেট|budget|টাকার মধ্যে|টাকার নিচে|টাকার ভেতর|টাকার ভিতর|er moddhe|er niche|er vitor|under|moddhe)\s*:?\s*(\d+)/i) ||
                   normalized.match(/(\d+)\s*(?:টাকা|টাকার|tk)?\s*(?:এর মধ্যে|এর নিচে|এর ভেতর|এর ভিতর|er moddhe|er vitor|moddhe)/i);
  if (maxMatch) return { min: 0, max: parseInt(maxMatch[1], 10) };
  return null;
}

function searchSmartProducts(query) {
  if (cachedCatalog.length === 0) return { type: 'empty', items: [] };
  const q = query.toLowerCase().trim();
  const budget = parseBudgetFromText(q);

  const categoryKeywords = {
    fan: ['fan', 'ফ্যান', 'বাতাস', 'টেবিল ফ্যান', 'হাত ফ্যান', 'মিনি ফ্যান', 'নেক ফ্যান', 'neck fan'],
    watch: ['watch', 'ঘড়ি', 'ঘড়ি', 'স্মার্টওয়াচ', 'smartwatch', 'smart watch', 't900', 'ultra', 'হাতের ঘড়ি'],
    headphone: ['headphone', 'headset', 'earphone', 'airpod', 'earbuds', 'হেডফোন', 'ইয়ারফোন', 'টিডব্লিউএস', 'tws', 'wireless'],
    light: ['light', 'লাইট', 'ল্যাম্প', 'bulb', 'বাতি'],
    speaker: ['speaker', 'স্পিকার', 'সাউন্ড', 'bluetooth speaker'],
    charger: ['charger', 'চার্জার', 'cable', 'ক্যাবল', 'power bank', 'পাওয়ার ব্যাংক'],
    ups: ['ups', 'ইউপিএস', 'mini ups', 'router ups', 'মিনি ইউপিএস', 'রাউটার']
  };

  let matchedCategory = null;
  for (const [catKey, aliases] of Object.entries(categoryKeywords)) {
    if (aliases.some(alias => q.includes(alias))) {
      matchedCategory = catKey;
      break;
    }
  }

  // ১. ক্যাটাগরি + বাজেট
  if (matchedCategory && budget) {
    const aliases = categoryKeywords[matchedCategory];
    const allCategoryItems = cachedCatalog.filter(p => {
      const name = p.name.toLowerCase();
      const cat = p.category.toLowerCase();
      const desc = p.description.toLowerCase();
      return aliases.some(a => name.includes(a) || cat.includes(a) || desc.includes(a));
    });

    const budgetCategoryItems = allCategoryItems.filter(p => {
      if (budget.min > 0 && p.price < budget.min) return false;
      return p.price <= budget.max;
    });

    budgetCategoryItems.sort((a, b) => b.price - a.price);

    return {
      type: 'category_budget',
      category: matchedCategory,
      budget: budget,
      items: budgetCategoryItems,
      allCategoryItems: allCategoryItems
    };
  }

  // ২. শুধু ক্যাটাগরি
  if (matchedCategory && !budget) {
    const aliases = categoryKeywords[matchedCategory];
    const catItems = cachedCatalog.filter(p => {
      const name = p.name.toLowerCase();
      const cat = p.category.toLowerCase();
      const desc = p.description.toLowerCase();
      return aliases.some(a => name.includes(a) || cat.includes(a) || desc.includes(a));
    });
    return { type: 'category', keyword: matchedCategory, items: catItems };
  }

  // ৩. শুধু বাজেট
  if (budget && !matchedCategory) {
    const budgetItems = cachedCatalog.filter(p => {
      if (budget.min > 0 && p.price < budget.min) return false;
      return p.price <= budget.max;
    });
    budgetItems.sort((a, b) => b.price - a.price);
    return { type: 'budget', budget, items: budgetItems.slice(0, 10) };
  }

  // ৪. সাধারণ সার্চ
  const tokens = q.split(/\s+/).filter(t => t.length > 1);
  const scored = cachedCatalog.map(p => {
    let score = 0;
    const nameLower = p.name.toLowerCase();
    if (nameLower === q) score += 100;
    if (nameLower.includes(q)) score += 50;
    tokens.forEach(tok => { if (nameLower.includes(tok)) score += 20; });
    return { product: p, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.filter(s => s.score > 0).slice(0, 4).map(s => s.product);
  return { type: 'general', items: top.length > 0 ? top : cachedCatalog.slice(0, 2) };
}

// সেশন রিস্টোর/ব্যাকআপ
async function restoreSessionFromRemote() {
  try {
    const res = await axios.get(`${SITE_BASE_URL}/api.php?action=get_settings&key=wa_full_session_bundle`, { timeout: 8000 });
    let bundle = res.data;
    if (typeof bundle === 'string') {
      try { bundle = JSON.parse(bundle); } catch (_) {}
    }
    if (bundle?.files && Object.keys(bundle.files).length > 0) {
      for (const [f, b64] of Object.entries(bundle.files)) {
        const safe = path.basename(f);
        if (!safe.includes('..')) {
          fs.writeFileSync(path.join(AUTH_DIR, safe), Buffer.from(b64, 'base64'));
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
    }, { timeout: 10000 });
  } catch (_) {}
}
setInterval(backupSessionToRemote, 300000);

// ভয়েস অডিও প্রসেসর
async function transcribeAudioWithGemini(audioBuffer, mimeType = 'audio/ogg') {
  if (!aiClient) return '';
  try {
    const audioPart = {
      inlineData: {
        data: audioBuffer.toString('base64'),
        mimeType: mimeType.split(';')[0]
      }
    };
    const prompt = 'এই ভয়েস মেসেজে গ্রাহক কী বলেছেন তা হুবহু বাংলায় বা ইংরেজিতে শুধু টেক্সট আকারে লিখুন। অতিরিক্ত কোনো ব্যাখ্যা লিখবেন না।';

    const response = await aiClient.models.generateContent({
      model: GEMINI_MODEL,
      contents: [audioPart, prompt],
      config: {
        temperature: 0.1,
        maxOutputTokens: 200,
        thinkingConfig: { thinkingBudget: 0 }
      }
    });

    const text = response.text?.trim() || '';
    addLog('info', `Voice recognized: "${text}"`);
    return text;
  } catch (err) {
    addLog('error', `Voice error: ${err.message}`);
    return '';
  }
}

// ফাস্ট এআই টেক্সট
async function callGeminiUltraFast(prompt, systemInstruction) {
  if (!aiClient) throw new Error('GEMINI_API_KEY Missing');
  const models = [GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS];

  for (const modelId of models) {
    try {
      const start = Date.now();
      const response = await aiClient.models.generateContent({
        model: modelId,
        contents: prompt,
        config: {
          systemInstruction: systemInstruction,
          temperature: 0.2,
          maxOutputTokens: 220,
          thinkingConfig: { thinkingBudget: 0 }
        }
      });
      const text = response.text?.trim();
      if (text) {
        addLog('info', `AI Replied in ${Date.now() - start}ms [${modelId}]`);
        return text;
      }
    } catch (_) {}
  }
  throw new Error('AI Generation Failed');
}

// গ্রাহকের মেসেজ লজিক
async function handleCustomerIncomingMessage(phone, text) {
  const cleanInput = text.trim();
  const searchResult = searchSmartProducts(cleanInput);

  const catNames = {
    fan: 'ফ্যান',
    watch: 'ঘড়ি',
    headphone: 'হেডফোন / ইয়ারফোন',
    light: 'লাইট',
    speaker: 'স্পিকার',
    charger: 'চার্জার / পাওয়ার ব্যাংক',
    ups: 'মিনি ইউপিএস'
  };

  // ১. ক্যাটাগরি + বাজেট
  if (searchResult.type === 'category_budget') {
    const catLabel = catNames[searchResult.category] || searchResult.category;
    if (searchResult.items.length > 0) {
      let listStr = `✨ *আপনার ৳${searchResult.budget.max} বাজেটের সেরা ${catLabel} কালেকশন:*\n\n`;
      searchResult.items.forEach((p, idx) => {
        const stockBadge = p.in_stock ? '✅ স্টকে আছে' : '❌ স্টক শেষ';
        listStr += `${idx + 1}️⃣ *${p.name}*\n` +
                   `💵 মূল্য: ৳${p.price}\n` +
                   `📦 স্টক: ${stockBadge}\n` +
                   `🔗 অর্ডার লিংক: ${p.buy_link}\n\n`;
      });
      listStr += `🚚 *ডেলিভারি চার্জ:* ঢাকা ৳৭০, ঢাকার বাইরে ৳১৩০ (ক্যাশ অন ডেলিভারি)।\n` +
                 `👉 ভাইয়া, যেটি নিতে চান তার নাম এবং আপনার ডেলিভারি ঠিকানা পাঠিয়ে দিলে আমরা পার্সেল পাঠিয়ে দেব ❤️`;
      return listStr;
    } else {
      if (searchResult.allCategoryItems && searchResult.allCategoryItems.length > 0) {
        searchResult.allCategoryItems.sort((a, b) => a.price - b.price);
        const lowest = searchResult.allCategoryItems[0];
        return `ভাইয়া, দুঃখিত! ৳${searchResult.budget.max} বাজেটের মধ্যে এই মুহূর্তে কোনো ${catLabel} স্টকে নেই।\n\n` +
               `তবে আমাদের সবচেয়ে কমদামী ও সেরা ${catLabel} হলো:\n` +
               `👉 *${lowest.name}*\n` +
               `💵 মূল্য: ৳${lowest.price}\n` +
               `🔗 দেখুন: ${lowest.buy_link}\n\n` +
               `আমাদের শপের সকল গ্যাজেট দেখতে পারেন: ${SITE_BASE_URL}`;
      } else {
        return `ভাইয়া, ৳${searchResult.budget.max} বাজেটের মধ্যে কোনো ${catLabel} আমাদের কাছে এখন স্টকে নেই। অন্য কোনো গ্যাজেট দেখতে চাইলে জানান 😊`;
      }
    }
  }

  // ২. শুধু ক্যাটাগরি
  if (searchResult.type === 'category' && searchResult.items.length > 0) {
    const catLabel = catNames[searchResult.keyword] || 'গ্যাজেট';
    let listStr = `✨ *আমাদের শপের সকল ${catLabel} কালেকশন:*\n\n`;
    searchResult.items.forEach((p, idx) => {
      const stockBadge = p.in_stock ? '✅ স্টকে আছে' : '❌ স্টক শেষ';
      listStr += `${idx + 1}️⃣ *${p.name}*\n` +
                 `💵 মূল্য: ৳${p.price}\n` +
                 `📦 স্টক: ${stockBadge}\n` +
                 `🔗 অর্ডার লিংক: ${p.buy_link}\n\n`;
    });
    listStr += `🚚 *ডেলিভারি চার্জ:* ঢাকা ৳৭০, ঢাকার বাইরে ৳১৩০ (ক্যাশ অন ডেলিভারি)।\n` +
               `👉 ভাইয়া, আপনার যে মডেলটি পছন্দ হয়েছে তার নাম ও ঠিকানা পাঠিয়ে দিন ❤️`;
    return listStr;
  }

  // ৩. শুধু বাজেট
  if (searchResult.type === 'budget') {
    if (searchResult.items.length === 0) {
      return `ভাইয়া, ৳${searchResult.budget.max} বাজেটের মধ্যে এই মুহূর্তে কোনো পণ্য স্টকে নেই। আমাদের শপ ভিজিট করতে পারেন: ${SITE_BASE_URL}`;
    }
    let listStr = `💰 *আপনার ৳${searchResult.budget.max} বাজেটের সেরা গ্যাজেটসমূহ:*\n\n`;
    searchResult.items.forEach((p, idx) => {
      listStr += `${idx + 1}️⃣ *${p.name}* — ৳${p.price}\n` +
                 `🔗 দেখুন: ${p.buy_link}\n\n`;
    });
    listStr += `🚚 সারা দেশে ক্যাশ অন ডেলিভারি সুবিধা রয়েছে। যেটি নিতে চান তার নাম ও ডেলিভারি ঠিকানা পাঠিয়ে দিন ভাইয়া 😊`;
    return listStr;
  }

  // ৪. সাধারণ আলাপচারিতা
  const catalogContext = searchResult.items.map(p => `[ID:${p.id}] ${p.name} - ৳${p.price} (${p.in_stock ? 'স্টকে আছে' : 'স্টক শেষ'}) - ${p.buy_link}`).join('\n');

  const systemPrompt = `TechXZone (https://techxzone.shop) এর বাংলা সেলস অ্যাসিস্ট্যান্ট।
নিয়ম:
১. গ্রাহককে সবসময় "ভাইয়া" বলে সম্বোধন করবেন।
২. সংক্ষেপে ১-২ লাইনে মিষ্টি ও ভদ্রভাবে পয়েন্টে উত্তর দিন।
৩. শুধু এই পণ্য তালিকা ব্যবহার করুন:
${catalogContext}
৪. ডেলিভারি চার্জ: ঢাকা ৳৭০, ঢাকার বাইরে ৳১৩০। ক্যাশ অন ডেলিভারি।
৫. পণ্য পছন্দ হলে নাম ও সম্পূর্ণ ঠিকানা লিখে দিতে বলুন।`;

  try {
    const reply = await callGeminiUltraFast(`গ্রাহক: "${cleanInput}"`, systemPrompt);
    const formatted = reply.replace(/\*\*(.*?)\*\*/g, '*$1*');

    if (cleanInput.length > 15 && (cleanInput.includes('ঠিকানা') || cleanInput.includes('নাম') || /01[3-9]\d{8}/.test(cleanInput))) {
      const topP = searchResult.items[0];
      if (topP) {
        const isOutside = !cleanInput.includes('ঢাকা');
        const courier = isOutside ? 130 : 70;
        const total = topP.price + courier;
        return `${formatted}\n\n📋 *অর্ডার সারসংক্ষেপ:*\n• পণ্য: *${topP.name}*\n• সর্বমোট বিল: *৳${total}* (${isOutside ? 'ঢাকার বাইরে ৳১৩০' : 'ঢাকার ভিতরে ৳৭০'})\n\nভাইয়া, পার্সেলটি কি কনফার্ম করে পাঠিয়ে দেব? নিশ্চিত করতে *'হ্যাঁ'* লিখে জানান।`;
      }
    }
    return formatted;
  } catch (err) {
    const topP = searchResult.items[0];
    if (topP) {
      return `হ্যালো ভাইয়া! আমাদের শপের *${topP.name}* বর্তমানে ৳${topP.price}। ${topP.in_stock ? 'স্টকে আছে।' : ''}\n🔗 লিংক: ${topP.buy_link}\n\nডেলিভারি চার্জ: ঢাকা ৳৭০, বাইরে ৳১৩০ (ক্যাশ অন ডেলিভারি)। অর্ডার করতে আপনার নাম ও ঠিকানা লিখে দিন ভাইয়া।`;
    }
    return `হ্যালো ভাইয়া! TechXZone-এ স্বাগতম। আপনি কোন গ্যাজেটটি সম্পর্কে জানতে চাচ্ছেন নাম বা বাজেট লিখে জানান, আমি এখনই প্রোডাক্টের লিংক ও দাম পাঠিয়ে দিচ্ছি।`;
  }
}

// হোয়াটসঅ্যাপ ইঞ্জিন
let sock = null;
const botSentMessageIds = new Set();

async function startWhatsAppBot() {
  if (globalState.waConnecting || globalState.waConnected) return;
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
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      syncFullHistory: false,
      markOnlineOnConnect: true,
      generateHighQualityLinkPreview: false,
      getMessage: async (key) => ({ conversation: 'hello' })
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
        addLog('warn', `WhatsApp Closed. Code: ${code}`);

        if (code !== DisconnectReason.loggedOut) {
          if (sock) { try { sock.end(undefined); } catch (_) {} sock = null; }
          setTimeout(startWhatsAppBot, 3000);
        }
      } else if (connection === 'open') {
        globalState.waConnected = true;
        globalState.waConnecting = false;
        globalState.qrCodeDataUrl = null;
        globalState.pairingCode = null;
        addLog('info', '✅ WhatsApp Online! Ready to receive messages.');
        sock.sendPresenceUpdate('available').catch(() => {});
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      for (const m of messages) {
        if (!m.message) continue;
        const msgId = m.key.id;

        if (botSentMessageIds.has(msgId)) continue;

        const rawFrom = m.key.remoteJid;
        if (!rawFrom || rawFrom.endsWith('@g.us') || rawFrom.includes('status')) continue;

        // 🚀🎯 ম্যাজিক ফিক্স: LID থেকে আসল ফোন নম্বর উদ্ধার
        let targetJid = rawFrom;
        const candidatePn = 
          (m.key?.remoteJidAlt && m.key.remoteJidAlt.includes('@s.whatsapp.net') && m.key.remoteJidAlt) ||
          (m.key?.senderPn && m.key.senderPn.includes('@s.whatsapp.net') && m.key.senderPn) ||
          (m.senderPn && m.senderPn.includes('@s.whatsapp.net') && m.senderPn) ||
          (m.key?.participant && m.key.participant.includes('@s.whatsapp.net') && m.key.participant);

        if (candidatePn) {
          targetJid = candidatePn;
        }

        const customerPhone = targetJid.split('@')[0].replace(/[^0-9]/g, '');

        const msgContent = m.message.ephemeralMessage?.message || m.message.viewOnceMessage?.message || m.message;
        let incomingText = (
          msgContent.conversation ||
          msgContent.extendedTextMessage?.text ||
          msgContent.imageMessage?.caption ||
          ''
        ).trim();

        const isAudio = !!msgContent.audioMessage;
        if (!incomingText && !isAudio) continue;

        addLog('info', `📩 Message from ${customerPhone}: "${incomingText || '[Voice Note]'}"`);

        // রিড রিসিপ্ট ও টাইপিং
        sock.readMessages([m.key]).catch(() => {});
        sock.sendPresenceUpdate('composing', targetJid).catch(() => {});

        try {
          if (isAudio) {
            addLog('info', `Transcribing audio from ${customerPhone}...`);
            const buffer = await downloadMediaMessage(m, 'buffer', {}, { logger: pino({ level: 'silent' }) });
            const mime = msgContent.audioMessage.mimetype || 'audio/ogg';
            incomingText = await transcribeAudioWithGemini(buffer, mime);
          }

          if (!incomingText) continue;

          let replyText = await handleCustomerIncomingMessage(customerPhone, incomingText);
          if (!replyText) {
            replyText = 'হ্যালো ভাইয়া! TechXZone-এ স্বাগতম। আপনি কোন গ্যাজেটটি দেখতে চাচ্ছেন জানান, আমি এখনই লিংক ও দাম দিচ্ছি।';
          }

          const finalReply = isAudio 
            ? `🎤 *আপনি বলেছেন:* "${incomingText}"\n\n${replyText}`
            : replyText;

          // 🚀 আসল ফোন নম্বরে সরাসরি সেন্ড
          const sent = await sock.sendMessage(targetJid, { text: finalReply });
          if (sent?.key?.id) {
            botSentMessageIds.add(sent.key.id);
            if (botSentMessageIds.size > 1000) {
              botSentMessageIds.delete(botSentMessageIds.values().next().value);
            }
          }

          // যদি rawFrom আলাদা LID হয়, সেখানেও নিশ্চিতকরণের জন্য ফলব্যাক ডেলিভারি
          if (rawFrom !== targetJid && rawFrom.endsWith('@lid')) {
            try {
              await sock.sendMessage(rawFrom, { text: finalReply });
            } catch (_) {}
          }

          addLog('info', `🚀 Delivered reply to ${customerPhone} successfully!`);
        } catch (err) {
          addLog('error', `Send error to ${customerPhone}: ${err.message}`);
        } finally {
          sock.sendPresenceUpdate('paused', targetJid).catch(() => {});
        }
      }
    });
  } catch (err) {
    globalState.waConnecting = false;
    setTimeout(startWhatsAppBot, 5000);
  }
}

// এক্সপ্রেস অ্যাপ
const app = express();
app.set('trust proxy', 1);

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  validate: { xForwardedForHeader: false }
});

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
      pairingPhone: globalState.pairingPhone,
      catalogCount: globalState.catalogCount,
      catalogLastUpdated: globalState.catalogLastUpdated,
      recentLogs: globalState.recentLogs.slice(0, 25)
    }
  });
});

app.post('/get-code', async (req, res) => {
  let phone = (req.body.phone || '').replace(/[^0-9]/g, '');
  if (phone.startsWith('01') && phone.length === 11) phone = '88' + phone;
  if (!phone || phone.length < 11) {
    return res.status(400).json({ success: false, message: 'সঠিক আন্তর্জাতিক নম্বর দিন (যেমন: 88017...)' });
  }

  try {
    if (!sock) { await startWhatsAppBot(); await delay(2000); }
    if (sock && !sock.authState.creds.registered) {
      const code = await sock.requestPairingCode(phone);
      globalState.pairingCode = code;
      globalState.pairingPhone = phone;
      addLog('info', `Pairing Code: ${code} for ${phone}`);
      return res.json({ success: true, pairingCode: code });
    }
    return res.status(400).json({ success: false, message: 'ইতিমধ্যে ডিভাইস কানেক্টেড আছে।' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/hard-reset', async (req, res) => {
  try {
    if (sock) { try { sock.end(undefined); } catch (_) {} sock = null; }
    globalState.waConnected = false;
    globalState.waConnecting = false;
    globalState.pairingCode = null;
    globalState.qrCodeDataUrl = null;

    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    }
    try {
      await axios.post(`${SITE_BASE_URL}/api.php?action=save_settings`, {
        key: 'wa_full_session_bundle',
        value: {}
      }, { timeout: 6000 });
    } catch (_) {}

    setTimeout(startWhatsAppBot, 2000);
    res.json({ success: true, message: 'সেশন পরিষ্কার করা হয়েছে।' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/ai-chat', chatLimiter, async (req, res) => {
  const message = req.body.message || '';
  if (!message) return res.status(400).json({ success: false });

  try {
    const reply = await handleCustomerIncomingMessage('web_test', message);
    return res.json({ success: true, reply });
  } catch (err) {
    return res.status(500).json({
      success: false,
      reply: 'ভাইয়া, যেকোনো পণ্যের নাম লিখে জানান, আমি এখনই স্টক ও দাম জানিয়ে দিচ্ছি।'
    });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', async () => {
  addLog('info', `Server running on port ${PORT}`);
  await refreshProductCatalog();
  await startWhatsAppBot();
});
