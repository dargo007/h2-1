/**
 * wd_helpers.js - Shared helpers for wd_hecto.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { ImapFlow } = require('imapflow');

// ── Proxy Support ──
const PROXY_PATH = path.join(__dirname, 'proxy.txt');
let proxyList = [];
let proxyIndex = 0;

function loadProxies() {
  try {
    if (fs.existsSync(PROXY_PATH)) {
      const lines = fs.readFileSync(PROXY_PATH, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
      proxyList = lines.map(line => {
        // If line already has a protocol prefix, use as-is
        if (line.startsWith('http://') || line.startsWith('https://')) return line;
        // Format: user:pass@host:port
        const atIdx = line.lastIndexOf('@');
        if (atIdx === -1) return `http://${line}`;
        const auth = line.substring(0, atIdx);
        const hostPort = line.substring(atIdx + 1);
        return `http://${auth}@${hostPort}`;
      });
      if (proxyList.length > 0) {
        console.log(`  \x1b[32m✓ Loaded ${proxyList.length} proxies from proxy.txt\x1b[0m`);
      }
    }
  } catch (e) {
    console.log(`  \x1b[33m⚠ Failed to load proxy.txt: ${e.message}\x1b[0m`);
  }
}

function getNextProxy() {
  if (proxyList.length === 0) return null;
  const proxy = proxyList[proxyIndex % proxyList.length];
  proxyIndex++;
  return proxy;
}

function getProxyAgent(proxyUrl) {
  if (!proxyUrl) return null;
  return new HttpsProxyAgent(proxyUrl);
}

// Initialize proxies on load
loadProxies();

const PRIVY = {
  appId: 'cm338ijv804mhhgvacdxsayxu',
  clientId: 'client-WY5dQwQyixARYCtWLMzJnVKpgX1kt796M1k5Fncy4HQ1x',
  clientVersion: 'react-auth:3.10.0'
};

const API = {
  supanova: 'https://api.supanova.app',
  privyAuth: 'https://auth.privy.io'
};

const CANTON = { nodeId: 'mainnet-supa', appId: 'hecto' };

const CC_INSTRUMENT = {
  id: 'Amulet',
  admin: 'DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc'
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpsRequest(url, options, body, proxyUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, port: 443,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: { ...options.headers, 'Content-Length': body ? Buffer.byteLength(body) : 0 },
      timeout: 30000
    };
    if (proxyUrl) {
      opts.agent = getProxyAgent(proxyUrl);
    }
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: res.headers || {},
          json: async () => JSON.parse(data),
          text: async () => data
        });
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function canonicalize(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalize).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

function parseJwt(token) {
  if (!token) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  } catch { return null; }
}

function getTokenExpiry(token) {
  const p = parseJwt(token);
  return p?.exp || 0;
}

function isTokenExpired(token) {
  const exp = getTokenExpiry(token);
  if (!exp) return true;
  return Math.floor(Date.now() / 1000) >= exp;
}

function getExpiryStr(token) {
  const exp = getTokenExpiry(token);
  if (!exp) return 'EXPIRED';
  const sec = Math.max(0, exp - Math.floor(Date.now() / 1000));
  if (sec <= 0) return 'EXPIRED';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
}

function getPrivyHeaders(caid) {
  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Origin': 'https://app.hecto.finance',
    'Referer': 'https://app.hecto.finance/',
    'privy-app-id': PRIVY.appId,
    'privy-ca-id': caid,
    'privy-client': PRIVY.clientVersion,
    'privy-client-id': PRIVY.clientId
  };
}

function getSupanovaHeaders(token) {
  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Origin': 'https://app.hecto.finance',
    'x-canton-node-id': CANTON.nodeId,
    'x-supa-app-id': CANTON.appId,
    'Authorization': `Bearer ${token}`
  };
}

// ── Auth Functions (with proxy rotation) ──

async function refreshToken(account, proxy) {
  if (!account.refreshToken) return false;
  const body = JSON.stringify({ refresh_token: account.refreshToken });
  const headers = { ...getPrivyHeaders(account.caid), 'Authorization': `Bearer ${account.token}` };
  const px = proxy || getNextProxy();
  try {
    const res = await httpsRequest(`${API.privyAuth}/api/v1/sessions`, { method: 'POST', headers }, body, px);
    if (!res.ok) return false;
    const data = await res.json();
    if (data.token) {
      account.token = data.token;
      if (data.refresh_token) account.refreshToken = data.refresh_token;
      if (data.privy_access_token) account.pat = data.privy_access_token;
      return true;
    }
  } catch (e) { console.log(`  ⚠ Refresh error: ${e.message}`); }
  return false;
}

async function sendOTP(email, caid, proxy) {
  const body = JSON.stringify({ email });
  const px = proxy || getNextProxy();
  if (px) console.log(`  \x1b[90m↳ via proxy :${px.split(':').pop()}\x1b[0m`);
  const res = await httpsRequest(
    `${API.privyAuth}/api/v1/passwordless/init`,
    { method: 'POST', headers: getPrivyHeaders(caid) }, body, px
  );
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OTP send failed (${res.status}): ${t.substring(0, 100)}`);
  }
  return true;
}

async function verifyOTP(email, code, caid, proxy) {
  const body = JSON.stringify({ email, code, mode: 'login-or-sign-up' });
  const px = proxy || getNextProxy();
  const res = await httpsRequest(
    `${API.privyAuth}/api/v1/passwordless/authenticate`,
    { method: 'POST', headers: getPrivyHeaders(caid) }, body, px
  );
  if (!res.ok) throw new Error('OTP verification failed');
  const data = await res.json();
  if (!data.token) throw new Error('No token in response');
  return {
    token: data.token,
    pat: data.privy_access_token,
    refreshToken: data.refresh_token
  };
}

async function readOTPFromEmail(email, appPassword, maxWaitMs = 90000) {
  if (!appPassword) return null;
  const startTime = Date.now();
  console.log(`  ⏳ Waiting 10s for OTP email...`);
  await sleep(10000);

  while (Date.now() - startTime < maxWaitMs) {
    let client = null;
    try {
      client = new ImapFlow({
        host: 'imap.gmail.com', port: 993, secure: true,
        auth: { user: email, pass: appPassword },
        logger: false, greetingTimeout: 15000, socketTimeout: 20000,
        disableCompression: true
      });
      await Promise.race([
        client.connect(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), 20000))
      ]);
      await client.mailboxOpen('INBOX');
      let messages = [];
      try { messages = await client.search({ from: 'privy.io', unseen: true }); }
      catch { try { messages = await client.search({ unseen: true }); } catch {} }

      if (messages.length > 0) {
        const toCheck = messages.slice(-5).reverse();
        for (const uid of toCheck) {
          try {
            const msg = await client.fetchOne(uid, { source: true });
            if (!msg?.source) continue;
            const body = msg.source.toString();
            if (!body.toLowerCase().includes('privy')) continue;
            const dateMatch = body.match(/^Date:\s*(.+)$/mi);
            if (dateMatch) {
              const emailDate = new Date(dateMatch[1].trim());
              if (emailDate.getTime() < startTime - 30000) {
                try { await client.messageFlagsAdd(uid, ['\\Seen']); } catch {}
                continue;
              }
            }
            const otpMatch = body.match(/\b(\d{6})\b/);
            if (otpMatch) {
              try { await client.messageFlagsAdd(uid, ['\\Seen']); } catch {}
              try { await client.logout(); } catch {}
              return otpMatch[1];
            }
          } catch { continue; }
        }
      }
      try { await client.logout(); } catch {}
    } catch (e) {
      if (client) { try { await client.logout(); } catch { try { client.close(); } catch {} } }
      if (e.message.includes('Authentication')) return null;
    }
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    if (elapsed % 14 < 7) console.log(`  ⏳ Waiting for OTP... (${elapsed}s)`);
    await sleep(7000);
  }
  return null;
}

async function clearOldEmails(email, appPassword) {
  if (!appPassword) return;
  let client = null;
  try {
    client = new ImapFlow({
      host: 'imap.gmail.com', port: 993, secure: true,
      auth: { user: email, pass: appPassword },
      logger: false, greetingTimeout: 10000, socketTimeout: 15000,
      disableCompression: true
    });
    await Promise.race([client.connect(), new Promise((_, r) => setTimeout(() => r(new Error('T')), 15000))]);
    await client.mailboxOpen('INBOX');
    let msgs = [];
    try { msgs = await client.search({ from: 'privy.io', unseen: true }); } catch {}
    if (msgs.length > 0) {
      try { await client.messageFlagsAdd(msgs, ['\\Seen']); } catch {}
    }
    try { await client.logout(); } catch {}
  } catch {
    if (client) { try { await client.logout(); } catch { try { client.close(); } catch {} } }
  }
}

// ── Wallet Auth (HPKE) ──

async function getWalletAuthKey(token, caid) {
  const { CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } = await import('@hpke/core');
  const { Chacha20Poly1305 } = await import('@hpke/chacha20poly1305');

  const suite = new CipherSuite({
    kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Chacha20Poly1305()
  });
  const keyPair = await suite.kem.generateKeyPair();
  const pubSpki = await crypto.subtle.exportKey('spki', keyPair.publicKey);
  const pubB64 = Buffer.from(pubSpki).toString('base64');

  const body = JSON.stringify({
    encryption_type: 'HPKE', recipient_public_key: pubB64, user_jwt: token
  });
  const res = await httpsRequest(`${API.privyAuth}/api/v1/wallets/authenticate`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json', 'Content-Type': 'application/json',
      'Origin': 'https://auth.privy.io', 'Referer': 'https://auth.privy.io/',
      'privy-app-id': PRIVY.appId, 'privy-client-id': PRIVY.clientId,
      'Authorization': `Bearer ${token}`
    }
  }, body);

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Wallet auth failed (${res.status}): ${t.substring(0, 100)}`);
  }
  const data = await res.json();
  if (!data.encrypted_authorization_key) throw new Error('No auth key in response');

  const encKey = data.encrypted_authorization_key;
  const encapsulated = Buffer.from(encKey.encapsulated_key, 'base64');
  const ciphertext = Buffer.from(encKey.ciphertext, 'base64');

  const recipient = await suite.createRecipientContext({
    recipientKey: keyPair.privateKey,
    enc: new Uint8Array(encapsulated),
    info: new Uint8Array(0)
  });
  const decrypted = await recipient.open(new Uint8Array(ciphertext));
  const authKey = new TextDecoder().decode(decrypted);

  // Get ALL wallet IDs for fallback on BAD SIGNATURE
  let walletId = null;
  let allWallets = [];
  if (data.wallets?.length > 0) {
    allWallets = data.wallets.map(w => ({ id: w.id, chainType: w.chain_type }));
    // Prefer ethereum first (matches hecto.js), fallback stellar
    const eth = data.wallets.find(w => w.chain_type === 'ethereum');
    const stellar = data.wallets.find(w => w.chain_type === 'stellar');
    walletId = (eth || stellar || data.wallets[0]).id;
  }
  return { authKey, walletId, allWallets };
}

function generateAuthSignature(authKey, url, bodyObj) {
  const payload = {
    version: 1, method: 'POST', url, body: bodyObj,
    headers: { 'privy-app-id': PRIVY.appId }
  };
  const serialized = canonicalize(payload);
  let pem;
  if (authKey.startsWith('-----BEGIN')) { pem = authKey; }
  else {
    const buf = Buffer.from(authKey, 'base64');
    try {
      const pk = crypto.createPrivateKey({ key: buf, format: 'der', type: 'pkcs8' });
      pem = pk.export({ type: 'pkcs8', format: 'pem' });
    } catch { pem = `-----BEGIN PRIVATE KEY-----\n${authKey}\n-----END PRIVATE KEY-----`; }
  }
  const pk = crypto.createPrivateKey({ key: pem, format: 'pem' });
  return crypto.sign('sha256', Buffer.from(serialized), pk).toString('base64');
}

async function signHash(hash, walletId, token, caid, authKey) {
  let hashHex = hash.startsWith('0x') ? hash : '0x' + Buffer.from(hash, 'base64').toString('hex');
  const url = `${API.privyAuth}/api/v1/wallets/${walletId}/raw_sign`;
  const bodyObj = { params: { hash: hashHex } };
  const headers = {
    'Accept': '*/*', 'Content-Type': 'application/json',
    'Origin': 'https://app.hecto.finance', 'Referer': 'https://app.hecto.finance/',
    'privy-app-id': PRIVY.appId, 'privy-ca-id': caid,
    'privy-client': PRIVY.clientVersion, 'privy-client-id': PRIVY.clientId,
    'Authorization': `Bearer ${token}`
  };
  if (authKey) {
    headers['privy-authorization-signature'] = generateAuthSignature(authKey, url, bodyObj);
  }
  const res = await httpsRequest(url, { method: 'POST', headers }, JSON.stringify(bodyObj));
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Sign failed (${res.status}): ${t.substring(0, 100)}`);
  }
  const result = await res.json();
  const sig = result.data?.signature || result.signature;
  if (!sig) throw new Error('No signature in response');
  return sig;
}

// ── Supanova API ──

async function getBalance(token) {
  const res = await fetch(`${API.supanova}/canton/api/balances`, {
    headers: getSupanovaHeaders(token)
  });
  if (!res.ok) throw new Error(`Balance failed: ${res.status}`);
  const data = await res.json();
  const tokens = data.tokens || [];
  const amulet = tokens.find(t => t.instrumentId?.id === 'Amulet');
  return {
    partyId: data.partyId,
    ccUnlocked: parseFloat(amulet?.totalUnlockedBalance || '0'),
    ccLocked: parseFloat(amulet?.totalLockedBalance || '0'),
    ccTotal: parseFloat(amulet?.totalBalance || '0')
  };
}

async function getTransferFee(partyId, token) {
  const params = new URLSearchParams({
    partyId, instrumentId: CC_INSTRUMENT.id, instrumentAdmin: CC_INSTRUMENT.admin
  });
  const res = await fetch(`${API.supanova}/canton/transfers/calculate_transfer_fee?${params}`, {
    headers: getSupanovaHeaders(token)
  });
  if (!res.ok) throw new Error(`Fee calc failed: ${res.status}`);
  const data = await res.json();
  return parseFloat(data.amuletTransferFee || '0.1');
}

async function prepareTransfer(receiverPartyId, amount, token) {
  const body = {
    receiverPartyId, amount: String(amount),
    instrumentId: CC_INSTRUMENT.id, instrumentAdmin: CC_INSTRUMENT.admin
  };
  const res = await fetch(`${API.supanova}/canton/transfers/prepare_transfer`, {
    method: 'POST', headers: getSupanovaHeaders(token), body: JSON.stringify(body)
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Prepare failed (${res.status}): ${t.substring(0, 150)}`);
  }
  return await res.json();
}

async function submitPrepared(hash, signature, token) {
  let sigB64;
  if (signature.startsWith('0x')) {
    sigB64 = Buffer.from(signature.slice(2), 'hex').toString('base64');
  } else if (signature.includes('+') || signature.includes('/') || signature.endsWith('=')) {
    sigB64 = signature;
  } else {
    sigB64 = Buffer.from(signature, 'hex').toString('base64');
  }
  const res = await fetch(`${API.supanova}/canton/api/submit_prepared`, {
    method: 'POST', headers: getSupanovaHeaders(token),
    body: JSON.stringify({ hash, signature: sigB64 })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Submit failed (${res.status}): ${t.substring(0, 150)}`);
  }
  return await res.json();
}

async function queryCompletion(submissionId, token, maxAttempts = 60) {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const res = await fetch(
        `${API.supanova}/canton/api/query_completion?submissionId=${encodeURIComponent(submissionId)}`,
        { headers: getSupanovaHeaders(token) }
      );
      if (res.ok) {
        const data = await res.json();
        if (data.status === 'failed') throw new Error(`TX failed: ${data.message}`);
        if (data.status === 'completed') return data.data || { status: 'completed' };
        if (data.data?.updateId) return data.data;
      }
    } catch (e) {
      if (e.message.startsWith('TX failed')) throw e;
    }
    await sleep(2000);
  }
  throw new Error('Completion polling timed out');
}

module.exports = {
  PRIVY, API, CANTON, CC_INSTRUMENT,
  sleep, httpsRequest, parseJwt, getTokenExpiry, isTokenExpired, getExpiryStr,
  getPrivyHeaders, getSupanovaHeaders,
  loadProxies, getNextProxy,
  refreshToken, sendOTP, verifyOTP, readOTPFromEmail, clearOldEmails,
  getWalletAuthKey, generateAuthSignature, signHash,
  getBalance, getTransferFee, prepareTransfer, submitPrepared, queryCompletion
};
