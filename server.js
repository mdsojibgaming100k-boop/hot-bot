/**
 * TechXZone WhatsApp AI Bot - Perfect Inbox Delivery & Order Booking Edition
 * Combined with:
 *  1. Dual Filter: Category + Budget (e.g. 1500 tk er vitor fan)
 *  2. Voice Message (Audio Note) Auto Transcribe via Gemini
 *  3. Direct Website Order Creation (createWebsiteOrder + Admin WhatsApp Alert)
 *  4. Copy-friendly Order Form Split Send
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
  delay
} = require('@whiskeysockets/baileys');

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS || 'gemini-3.5-flash,gemini-3.6-flash')
  .split(',')
  .map(m => m.trim())
  .filter(Boolean);
const ADMIN_PHONE = (process.env.ADMIN_PHONE || '8801404277094').replace(/[^0-9]/g, '');
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || 'TechXZoneSecretDashboardAuthKey2026';
const SITE_BASE_URL = (process.env.SITE_BASE_URL || 'https://techxzone.shop').replace(/\/+$/, '');
const CATALOG_REFRESH_MS = parseInt(process.env.CATALOG_REFRESH_MS, 10) || 900000;

const SESSION_DIR = path.join(__dirname, 'auth_info_baileys');
if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
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

// ================= ১. ক্যাটালগ ক্যাশিং =================
let cachedCatalog = [];
async function refreshProductCatalog() {
  try {
    const res = await axios.get(`${SITE_BASE_URL}/api.php?action=bot_catalog`, { timeout: 8000 });
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
refreshProductCatalog();
setInterval(refreshProductCatalog, CATALOG_REFRESH_MS);

// ================= ২. বাজেট ও ক্যাটাগরি সার্চ ইঞ্জিন =================
function parseBudgetFromText(text) {
  const bnDigits = {'০':'0','১':'1','২':'2','৩':'3','৪':'4','৫':'5','৬':'6','৭':'7','৮':'8','৯':'9'};
  const normalized = text.replace(/[০-৯]/g, d => bnDigits[d]);
  const rangeMatch = normalized.match(/(\d+)\s*(?:থেকে|to|-)\s*(\d+)/i);
  if (rangeMatch) return { min: parseInt(rangeMatch[1], 10), max: parseInt(rangeMatch[2], 10) };

  const maxMatch = normalized.match(/(?:বাজেট|budget|টাকার মধ্যে|টাকার নিচে|টাকার ভেতর|টাকার ভিতর|er moddhe|er niche|er vitor|under|moddhe|dam|দাম)\s*:?\s*(\d+)/i) ||
                   normalized.match(/(\d+)\s*(?:টাকা|টাকার|tk)?\s*(?:এর মধ্যে|এর নিচে|এর ভেতর|এর ভিতর|er moddhe|er vitor|moddhe|er)/i);
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
    ups: ['ups', 'ইউপিএস', 'mini ups', 'router ups', 'মিনি ইউপিএস', 'রাউটার ইউপিএস']
  };

  let matchedCategory = null;
  for (const [catKey, aliases] of Object.entries(categoryKeywords)) {
    if (aliases.some(alias => q.includes(alias))) {
      matchedCategory = catKey;
      break;
    }
  }

  // ১. ক্যাটাগরি + বাজেট (যেমন: ১৫০০ টাকার ভেতর ফ্যান)
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
  const top = scored.filter(s => s.score > 0).slice(0, 5).map(s => s.product);
  return { type: 'general', items: top.length > 0 ? top : cachedCatalog.slice(0, 5) };
}

// ================= ৩. সাইটে সরাসরি অর্ডার বুকিং সিস্টেম =================
async function createWebsiteOrder(orderInfo) {
  try {
    const orderId = `TXZ-${Math.floor(1000 + Math.random() * 9000)}`;
    const isDhaka = (orderInfo.address && (orderInfo.address.toLowerCase().includes('dhaka') || orderInfo.address.includes('ঢাকা')));
    const courierFee = isDhaka ? 70 : 130;
    const subtotal = Number(orderInfo.price || 0) * Number(orderInfo.qty || 1);
    const grandTotal = subtotal + courierFee;

    const payload = {
      orderId: orderId,
      customerName: orderInfo.name || "WhatsApp Customer",
      phone: orderInfo.phone,
      division: isDhaka ? "ঢাকা বিভাগ" : "অন্যান্য",
      district: isDhaka ? "ঢাকা" : "অন্যান্য",
      upazila: "",
      address: orderInfo.address,
      customerNote: `WhatsApp Bot Order (${orderInfo.product_name})`,
      paymentMethod: "Cash on Delivery",
      items: [{
        id: orderInfo.product_id || 1,
        title: orderInfo.product_name,
        price: Number(orderInfo.price || 0),
        qty: Number(orderInfo.qty || 1)
      }],
      subtotal: subtotal,
      discount: 0,
      courierFee: courierFee,
      advanceFee: 0,
      codDue: grandTotal,
      grandTotal: grandTotal,
      status: "Pending"
    };

    const res = await axios.post(`${SITE_BASE_URL}/api.php?action=create_order`, payload, { timeout: 10000 });
    if (res.data && res.data.status === 'success') {
      if (sock && globalState.waConnected) {
        const adminJid = `${ADMIN_PHONE}@s.whatsapp.net`;
        const adminMsg = `🚨 *নতুন অর্ডার বুক হয়েছে!*\n━━━━━━━━━━━━━━━━━━━━\n🆔 অর্ডার আইডি: #${orderId}\n📦 পণ্য: ${orderInfo.product_name}\n👤 কাস্টমার: ${orderInfo.name}\n📞 মোবাইল: ${orderInfo.phone}\n📍 ঠিকানা: ${orderInfo.address}\n💰 মোট বিল: ৳${grandTotal.toLocaleString()}\n━━━━━━━━━━━━━━━━━━━━`;
        sock.sendMessage(adminJid, { text: adminMsg }).catch(() => {});
      }
      return { success: true, orderId: orderId, grandTotal: grandTotal };
    }
    return { success: false };
  } catch (err) {
    addLog('error', `Order Booking Error: ${err.message}`);
    return { success: false };
  }
}

// ================= ৪. সেশন ব্যাকআপ ও রিস্টোর =================
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
          fs.writeFileSync(path.join(SESSION_DIR, safe), Buffer.from(b64, 'base64'));
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
    if (!fs.existsSync(SESSION_DIR) || !fs.existsSync(path.join(SESSION_DIR, 'creds.json'))) return;
    const bundle = { files: {}, updatedAt: new Date().toISOString() };
    for (const f of fs.readdirSync(SESSION_DIR)) {
      const full = path.join(SESSION_DIR, f);
      if (fs.statSync(full).isFile()) bundle.files[f] = fs.readFileSync(full).toString('base64');
    }
    await axios.post(`${SITE_BASE_URL}/api.php?action=save_settings`, {
      key: 'wa_full_session_bundle',
      value: bundle
    }, { timeout: 10000 });
  } catch (_) {}
}
setInterval(backupSessionToRemote, 300000);

// ================= ৫. ভয়েস অডিও প্রসেসর (Gemini 3.5 Flash) =================
async function transcribeAudioWithGemini(audioBuffer, mimeType = 'audio/ogg') {
  if (!aiClient) return '';
  
  // ভয়েস ট্রান্সক্রিপশনের জন্য সরাসরি gemini-3.5-flash ব্যবহার করা হচ্ছে
  const voiceModels = ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.8-flash'];
  
  const cleanMime = (mimeType || 'audio/ogg').split(';')[0].trim();
  const audioPart = {
    inlineData: {
      data: audioBuffer.toString('base64'),
      mimeType: cleanMime
    }
  };
  const prompt = 'এই ভয়েস মেসেজে গ্রাহক কী বলেছেন তা হুবহু বাংলায় বা ইংরেজিতে শুধু টেক্সট আকারে লিখুন। অতিরিক্ত কোনো ব্যাখ্যা লিখবেন না।';

  for (const modelId of voiceModels) {
    try {
      const response = await aiClient.models.generateContent({
        model: modelId,
        contents: [audioPart, prompt],
        config: {
          temperature: 0.1,
          maxOutputTokens: 200,
          thinkingConfig: { thinkingBudget: 0 }
        }
      });

      const text = response.text?.trim() || '';
      if (text) {
        addLog('info', `Voice transcribed via [${modelId}]: "${text}"`);
        return text;
      }
    } catch (err) {
      addLog('warn', `Voice transcribe failed on [${modelId}]: ${err.message}`);
    }
  }

  return '';
}

// ================= ৬. ফাস্ট এআই জেনারেটর =================
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
          temperature: 0.3,
          maxOutputTokens: 500,
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

// ================= ৭. গ্রাহকের মেসেজ লজিক =================
async function handleCustomerIncomingMessage(phone, text) {
  const cleanInput = text.trim();
  const searchResult = searchSmartProducts(cleanInput);

  let cleanUserPhone = phone.replace(/@.*$/, '').replace(/[^0-9]/g, '');
  if (cleanUserPhone.startsWith('880')) {
    cleanUserPhone = '0' + cleanUserPhone.slice(3);
  } else if (cleanUserPhone.startsWith('88') && cleanUserPhone.length === 13) {
    cleanUserPhone = cleanUserPhone.slice(2);
  }

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
                 `👉 ভাইয়া, যেটি নিতে চান নাম ও ডেলিভারি ঠিকানা লিখে দিলে পার্সেল পাঠিয়ে দেব ❤️`;
      return listStr;
    } else {
      if (searchResult.allCategoryItems && searchResult.allCategoryItems.length > 0) {
        searchResult.allCategoryItems.sort((a, b) => a.price - b.price);
        const lowest = searchResult.allCategoryItems[0];
        return `ভাইয়া, দুঃখিত! ৳${searchResult.budget.max} বাজেটের মধ্যে কোনো ${catLabel} বর্তমানে নেই।\n\n` +
               `তবে আমাদের সবচেয়ে কমদামী সেরা ${catLabel} হলো:\n` +
               `👉 *${lowest.name}*\n` +
               `💵 মূল্য: ৳${lowest.price}\n` +
               `🔗 দেখুন: ${lowest.buy_link}\n\n` +
               `আপনি কি এটি নিতে চান ভাইয়া?`;
      } else {
        return `ভাইয়া, ৳${searchResult.budget.max} বাজেটের মধ্যে কোনো ${catLabel} স্টকে নেই। অন্য কিছু দেখতে চাইলে জানান 😊`;
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
               `👉 ভাইয়া, যেটি নিতে চান নাম ও ডেলিভারি ঠিকানা দিলে পার্সেল বুক করে দেব ❤️`;
    return listStr;
  }

  // ৩. শুধু বাজেট
  if (searchResult.type === 'budget') {
    if (searchResult.items.length === 0) {
      return `ভাইয়া, ৳${searchResult.budget.max} বাজেটের মধ্যে পণ্য নেই। ভিজিট করুন: ${SITE_BASE_URL}`;
    }
    let listStr = `💰 *আপনার ৳${searchResult.budget.max} বাজেটের সেরা গ্যাজেটসমূহ:*\n\n`;
    searchResult.items.forEach((p, idx) => {
      listStr += `${idx + 1}️⃣ *${p.name}* — ৳${p.price}\n` +
                 `🔗 দেখুন: ${p.buy_link}\n\n`;
    });
    listStr += `🚚 ক্যাশ অন ডেলিভারি সুবিধা রয়েছে। যেটি নিতে চান নাম ও ঠিকানা লিখে দিন ভাইয়া 😊`;
    return listStr;
  }

  // ৪. সাধারণ আলাপচারিতা ও এআই সেলস ব্রেন
  const catalogContext = searchResult.items.map(p => `• [ID:${p.id}] ${p.name} | মূল্য: ৳${p.price} | স্টক: ${p.in_stock ? 'আছে' : 'নাই'} | লিংক: ${p.buy_link}`).join('\n');

  const systemPrompt = `তুমি TechXZone (techxzone.shop) এর প্রধান সিনিয়র সেলস কনসালট্যান্ট।
নিয়মাবলী:
১. কাস্টমারকে আপন ভাইয়ের মতো "ভাইয়া" সম্বোধন করবে। বিনয়ী ও মিষ্টি কথায় ১-২ লাইনে উত্তর দাও।
২. ফন্ট রুল: কখনো ডাবল স্টার (**) ব্যবহার করবে না! শুধু সিঙ্গেল স্টার (*) ব্যবহার করবে।
৩. ডেলিভারি চার্জ: ঢাকা ৳৭০, ঢাকার বাইরে ৳১৩০। ক্যাশ অন ডেলিভারি।
৪. কাস্টমার যদি পণ্য নিয়ে শুধু প্রশ্ন করে, ডেলিভারি চার্জ জানতে চায়, তবে শুধু উত্তর দাও।
৫. কাস্টমার যদি বলে "কনফার্ম করেন", "১টা পাঠান", "নিব" ইত্যাদি কিন্তু ঠিকানা দেয়নি, তখন উত্তরের শুরুতে ঠিক এই সুন্দর ফাঁকা ফর্মটি দেবে:

📋 *ক্যাশ অন ডেলিভারি অর্ডার ফর্ম*
━━━━━━━━━━━━━━━━━━━━
*১. আপনার পুরো নাম :* 
*২. মোবাইল নম্বর :* ${cleanUserPhone}
*৩. সম্পূর্ণ ঠিকানা (বাসা/রোড/এলাকা) :* 
*৪. জেলা ও থানা :* 
*৫. পণ্যের নাম :* [পণ্যটির নাম]
━━━━━━━━━━━━━━━━━━━━

৬. কাস্টমার ফর্ম পূরণ করে পাঠালে বা নাম, ঠিকানা ও মোবাইল দিলে উত্তরের একদম শেষে বাধ্যতামূলক এই ট্যাগটি দেবে:
[[ORDER:{"product_id":ID,"product_name":"নাম","price":দাম,"qty":1,"name":"কাস্টমারের নাম","phone":"${cleanUserPhone}","address":"সম্পূর্ণ ঠিকানা"}]]

প্রাসঙ্গিক পণ্য তালিকা:
${catalogContext}`;

  try {
    let reply = await callGeminiUltraFast(`গ্রাহক: "${cleanInput}"`, systemPrompt);
    reply = reply.replace(/\*\*/g, '*');

    // অর্ডার প্লেসমেন্ট হ্যান্ডলার
    const orderMatch = reply.match(/\[\[ORDER:(.*?)\]\]/);
    if (orderMatch && orderMatch[1]) {
      try {
        const orderData = JSON.parse(orderMatch[1]);
        if (!orderData.phone || orderData.phone.length < 10) orderData.phone = cleanUserPhone;

        const orderResult = await createWebsiteOrder(orderData);
        if (orderResult.success) {
          const invoiceNote = `\n\n🎉 *আলহামদুলিল্লাহ ভাইয়া! আপনার অর্ডারটি সফলভাবে কনফার্ম করা হয়েছে।* \n🆔 *অর্ডার আইডি:* #${orderResult.orderId}\n📦 *পণ্য:* ${orderData.product_name}\n💰 *সর্বমোট বিল:* ৳${orderResult.grandTotal.toLocaleString()} (ক্যাশ অন ডেলিভারি)\n🚚 পার্সেল পৌঁছে দিলে দেখে মূল্য পরিশোধ করবেন। ধন্যবাদ TechXZone এর সাথে থাকার জন্য! ❤️`;
          reply = reply.replace(/\[\[ORDER:(.*?)\]\]/, '') + invoiceNote;
        } else {
          reply = reply.replace(/\[\[ORDER:(.*?)\]\]/, '');
        }
      } catch (err) {
        reply = reply.replace(/\[\[ORDER:(.*?)\]\]/, '');
      }
    }

    return reply;
  } catch (err) {
    return `হ্যালো ভাইয়া! আপনি কোন পণ্যটি সম্পর্কে জানতে চাচ্ছেন নাম বা বাজেট লিখে জানান, আমি এখনই স্টক ও দাম জানিয়ে দিচ্ছি।`;
  }
}

// ================= ৮. Baileys হোয়াটসঅ্যাপ ইঞ্জিন =================
let sock = null;

async function startWhatsAppBot() {
  if (globalState.waConnecting || globalState.waConnected) return;
  globalState.waConnecting = true;

  try {
    if (!fs.existsSync(path.join(SESSION_DIR, 'creds.json'))) {
      await restoreSessionFromRemote();
    }

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      auth: state,
      printQRInTerminal: false,
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      syncFullHistory: false,
      markOnlineOnConnect: false
    });

    sock.ev.on('creds.update', async () => {
      await saveCreds();
      backupSessionToRemote().catch(() => {});
    });

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) QRCode.toDataURL(qr).then(url => { globalState.qrCodeDataUrl = url; }).catch(() => {});

      if (connection === 'close') {
        globalState.waConnected = false;
        globalState.waConnecting = false;
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        addLog('warn', `WhatsApp Closed. Reconnecting: ${shouldReconnect}`);

        if (shouldReconnect) {
          if (sock) {
            try { sock.ev.removeAllListeners(); sock.end(undefined); } catch (e) {}
            sock = null;
          }
          setTimeout(startWhatsAppBot, 3000);
        }
      } else if (connection === 'open') {
        globalState.waConnected = true;
        globalState.waConnecting = false;
        globalState.qrCodeDataUrl = null;
        globalState.pairingCode = null;
        addLog('info', '✅ [TechXZone WhatsApp Bot] সফলভাবে কানেক্টেড আছে!');
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      try {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const msgTimestamp = Number(msg.messageTimestamp || 0);
        const currentTimestamp = Math.floor(Date.now() / 1000);
        if (msgTimestamp && (currentTimestamp - msgTimestamp > 60)) return;

        const sender = msg.key.remoteJid;
        if (sender.includes('@g.us')) return;

        const msgContent = msg.message.ephemeralMessage?.message || msg.message.viewOnceMessage?.message || msg.message;
        let text = (
          msgContent.conversation ||
          msgContent.extendedTextMessage?.text ||
          msgContent.imageMessage?.caption ||
          ''
        ).trim();

        const isAudio = !!msgContent.audioMessage;
        if (!text && !isAudio) return;

        try {
          await sock.readMessages([msg.key]);
          await sock.presenceSubscribe(sender);
          await sock.sendPresenceUpdate('composing', sender);
        } catch (e) {}

        // ভয়েস নোট সরাসরি টেক্সট করা
        if (isAudio) {
          try {
            const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
            const mime = msgContent.audioMessage.mimetype || 'audio/ogg';
            text = await transcribeAudioWithGemini(buffer, mime);
            addLog('info', `[গ্রাহকের ভয়েস ট্রান্সক্রিপশন]: "${text}"`);
          } catch (e) {
            addLog('error', `Voice download error: ${e.message}`);
          }
        }

        if (!text) {
          if (isAudio) {
            await sock.sendMessage(sender, { text: "ভাইয়া, আপনার ভয়েসটি স্পষ্টভাবে বুঝতে পারিনি। অনুগ্রহ করে আরেকবার বলবেন অথবা লিখে জানাবেন? 😊" });
          }
          try { await sock.sendPresenceUpdate('paused', sender); } catch (e) {}
          return;
        }

        addLog('info', `[গ্রাহক]: ${text}`);

        // এআই রেসপন্স
        let replyText = await handleCustomerIncomingMessage(sender, text);
        replyText = replyText.replace(/\*\*/g, '*');

        if (isAudio) {
          replyText = `🎤 *আপনার ভয়েস:* "${text}"\n\n${replyText}`;
        }

        // ফর্ম আলাদা পাঠানো (কপি করার সুবিধার জন্য)
        const formRegex = /(📋\s*\*?ক্যাশ অন ডেলিভারি অর্ডার ফর্ম\*?[\s\S]*?━━━━━━━━━━━━━━━━━━━━)/;
        const match = replyText.match(formRegex);

        if (match) {
          const formText = match[1].trim();
          const otherText = replyText.replace(formRegex, '').replace(/\[\[ORDER:(.*?)\]\]/g, '').trim();

          await sock.sendMessage(sender, { text: formText });
          if (otherText) {
            await delay(1000);
            await sock.sendMessage(sender, { text: otherText });
          }
        } else {
          await sock.sendMessage(sender, { text: replyText });
        }

        addLog('info', `✅ [বট উত্তর পাঠানো সম্পন্ন]: ${sender}`);
        try { await sock.sendPresenceUpdate('paused', sender); } catch (e) {}

      } catch (err) {
        addLog('error', `Error in messages.upsert: ${err.message}`);
      }
    });

  } catch (err) {
    globalState.waConnecting = false;
    setTimeout(startWhatsAppBot, 5000);
  }
}

// ================= ৯. এক্সপ্রেস সার্ভার =================
const app = express();
app.set('trust proxy', 1);

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
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
      await delay(1500);
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
    if (sock) { 
      try { 
        sock.ev.removeAllListeners();
        sock.end(undefined); 
      } catch (_) {} 
      sock = null; 
    }
    globalState.waConnected = false;
    globalState.waConnecting = false;
    globalState.pairingCode = null;
    globalState.qrCodeDataUrl = null;

    if (fs.existsSync(SESSION_DIR)) {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
      fs.mkdirSync(SESSION_DIR, { recursive: true });
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
  await startWhatsAppBot();
});
