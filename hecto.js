/**
 * HectoBot - Hecto Finance Allocation Bot
 * 
 * Features:
 * - Multi-account support with pinned dashboard UI
 * - Scheduled execution at configured timezone daily
 * - Auto-allocate to company with highest percentage gain
 * - Token keep-alive mechanism
 * - Execution logs with max 20 lines
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { ImapFlow } = require('imapflow');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const cron = require('node-cron');

dayjs.extend(utc);
dayjs.extend(timezone);

function getConfiguredTimezone() {
  return settings?.timezone || 'Asia/Jakarta';
}

function getNowInConfiguredTimezone() {
  return dayjs().tz(getConfiguredTimezone());
}

// Execution window after the exact target time. The bot will only allocate
// when the clock is within [target, target + GRACE_MS]. Outside this window
// (either before target, or too long after) we SKIP to tomorrow instead of
// firing at a wrong hour on restart.
// Increased to 10 minutes to give cron + startup catch-up enough room.
const EXECUTION_GRACE_MS = 10 * 60 * 1000; // 10 minutes

function parseScheduleHM(config = settings) {
  const scheduleTime = String(config?.scheduleTime || '00:00');
  const [hourRaw, minuteRaw] = scheduleTime.split(':');
  const hour = Number.isFinite(Number(hourRaw)) ? Number(hourRaw) : 0;
  const minute = Number.isFinite(Number(minuteRaw)) ? Number(minuteRaw) : 0;
  return { hour, minute };
}

// Today's target in configured timezone, regardless of whether it's past or future.
function getTodayTargetTimeWIB(config = settings) {
  const tzName = config?.timezone || getConfiguredTimezone();
  const { hour, minute } = parseScheduleHM(config);
  return dayjs().tz(tzName).hour(hour).minute(minute).second(0).millisecond(0);
}

// Get next schedule time in configured timezone from settings.scheduleTime (HH:mm)
// "Next" = today's target if still in the future OR within the grace window,
// otherwise tomorrow's target.
function getNextScheduleTimeWIB(config = settings) {
  const tzName = config?.timezone || getConfiguredTimezone();
  const nowInTz = dayjs().tz(tzName);
  const todayTarget = getTodayTargetTimeWIB(config);
  const msSinceTarget = nowInTz.valueOf() - todayTarget.valueOf();

  if (msSinceTarget < 0) return todayTarget;          // target hasn't happened yet
  if (msSinceTarget <= EXECUTION_GRACE_MS) return todayTarget; // still in grace window
  return todayTarget.add(1, 'day');
}

// ============================================================================
// PROXY SUPPORT
// ============================================================================
// Reads proxy.txt (one `user:pass@host:port` per line) and assigns a proxy to
// each bot in round-robin fashion. Each request from a bot then routes through
// that proxy's IP so different accounts don't share an outbound IP.

const PROXY_PATH = path.join(__dirname, 'proxy.txt');
let proxyList = [];
let proxyIndex = 0;

function loadProxies() {
  try {
    if (fs.existsSync(PROXY_PATH)) {
      const lines = fs.readFileSync(PROXY_PATH, 'utf8')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'));
      proxyList = lines.map(line => {
        // Format: user:pass@host:port  -> http://user:pass@host:port
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

// Proxies are loaded lazily — only after the user selects "Use proxy" in the
// startup menu. This keeps the no-proxy path completely free of proxy state.

// Custom HTTPS request helper to avoid Node.js fetch issues with Privy API.
// Accepts an optional `proxyUrl`; when provided the request is tunneled through
// that proxy via HttpsProxyAgent.
function httpsRequest(url, options, body, proxyUrl) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: {
        ...options.headers,
        'Content-Length': body ? Buffer.byteLength(body) : 0
      },
      timeout: 30000 // 30 second timeout
    };
    if (proxyUrl) {
      reqOptions.agent = getProxyAgent(proxyUrl);
    }

    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
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
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout (30s)')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// fetch-compatible wrapper that tunnels through `proxyUrl` when provided.
// Falls back to the global fetch when no proxy is configured so behavior is
// unchanged for users who haven't created a proxy.txt.
function fetchWithProxy(url, options = {}, proxyUrl) {
  if (!proxyUrl) {
    return fetch(url, options);
  }
  const method = options.method || 'GET';
  const headers = options.headers || {};
  const body = options.body;
  return httpsRequest(url, { method, headers }, body, proxyUrl);
}

// ============================================================================
// FILE PATHS
// ============================================================================

const ACCOUNTS_PATH = path.join(__dirname, 'accounts.json');
const TOKENS_PATH = path.join(__dirname, 'tokens.json');
const CONFIG_PATH = path.join(__dirname, 'config.json');

// ============================================================================
// LOAD CONFIGURATION
// ============================================================================

let settings = {
  scheduleTime: '04:50',
  timezone: 'Asia/Jakarta',
  retryAttempts: 3,
  retryDelayMs: 2000,
  tokenRefreshIntervalMs: 1800000, // 30 minutes
  autoLogin: true
};

try {
  settings = { ...settings, ...require(CONFIG_PATH) };
} catch (e) {
  console.error('[!] Failed to load config.json, using defaults');
}

// ============================================================================
// FORCE NODE.JS TIMEZONE (VPS-INDEPENDENT)
// ============================================================================
// This is the KEY to making the bot work on ANY VPS regardless of system timezone.
// By setting process.env.TZ, we force ALL Date operations (including libraries
// that don't use dayjs.tz) to use the configured timezone.
// Combined with dayjs.tz and node-cron's timezone option, this creates a
// triple-layer guarantee that the schedule fires at the correct local time.
process.env.TZ = settings.timezone || 'Asia/Jakarta';

// ============================================================================
// LOAD ACCOUNTS AND TOKENS
// ============================================================================

let accountsData = { accounts: [] };
let tokensData = { accounts: {} };

function loadAccounts() {
  try {
    accountsData = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8'));
  } catch (e) {
    console.error('[!] Failed to load accounts.json');
    process.exit(1);
  }
}

function loadTokens() {
  try {
    if (fs.existsSync(TOKENS_PATH)) {
      tokensData = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
    }
  } catch (e) {
    tokensData = { accounts: {}, scheduler: {} };
  }

  // Ensure scheduler section exists
  if (!tokensData.scheduler) {
    tokensData.scheduler = {};
  }
}

function saveTokens() {
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokensData, null, 2) + '\n');
}

// Re-read only the scheduler section from disk so a stale in-memory copy
// can't cause a duplicate fire if tokens.json was updated by a prior/parallel run.
function reloadSchedulerState() {
  try {
    if (fs.existsSync(TOKENS_PATH)) {
      const fresh = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
      if (fresh && typeof fresh === 'object') {
        tokensData.scheduler = fresh.scheduler || {};
      }
    }
  } catch { }
  if (!tokensData.scheduler) tokensData.scheduler = {};
  return tokensData.scheduler;
}

// Get last execution date from tokens.json (always fresh from disk)
function getLastExecutionDate() {
  return reloadSchedulerState().lastExecutionDate || null;
}

// Save last execution date to tokens.json
function setLastExecutionDate(dateStr) {
  if (!tokensData.scheduler) {
    tokensData.scheduler = {};
  }
  tokensData.scheduler.lastExecutionDate = dateStr;
  tokensData.scheduler.lastExecutionTimestamp = new Date().toISOString();
  // Clear in-progress marker once execution is recorded as done
  delete tokensData.scheduler.inProgressDate;
  delete tokensData.scheduler.inProgressStartedAt;
  saveTokens();
}

// Mark that an execution started for `dateStr` so a crash/restart inside the
// allocation phase does NOT cause a second fire on the same day at a wrong hour.
function setExecutionInProgress(dateStr) {
  if (!tokensData.scheduler) tokensData.scheduler = {};
  tokensData.scheduler.inProgressDate = dateStr;
  tokensData.scheduler.inProgressStartedAt = new Date().toISOString();
  saveTokens();
}

function getInProgressDate() {
  return reloadSchedulerState().inProgressDate || null;
}

function clearExecutionInProgress() {
  if (!tokensData.scheduler) return;
  delete tokensData.scheduler.inProgressDate;
  delete tokensData.scheduler.inProgressStartedAt;
  saveTokens();
}

// ============================================================================
// API ENDPOINTS
// ============================================================================

const API = {
  base: 'https://app.hecto.finance/api',
  hecto: 'https://app.hecto.finance/api/hecto',
  allocator: 'https://app.hecto.finance/api/allocator',
  supanova: 'https://api.supanova.app',
  privyAuth: 'https://auth.privy.io',
  privyApi: 'https://api.privy.io'
};

// ============================================================================
// PRIVY CONFIGURATION
// ============================================================================

const PRIVY = {
  appId: 'cm338ijv804mhhgvacdxsayxu',
  clientId: 'client-WY5dQwQyixARYCtWLMzJnVKpgX1kt796M1k5Fncy4HQ1x',
  clientVersion: 'react-auth:3.10.0'
};

// ============================================================================
// CANTON CONFIGURATION
// ============================================================================

const CANTON = {
  nodeId: 'mainnet-supa',
  appId: 'hecto'
};

// ============================================================================
// STATIC CONTRACTS
// ============================================================================

const LOCK_WITH_COMMISSION_CONTRACT = {
  contractId: '007bfca79cf2528c4b80c6ed64fa2054858e71a7f6bca96dea44068ec30661a15bca12122012c82cc98e97cb89bbf393c4c9c89e8b8f703cfde7cd7a2f6bbfa649b711403c',
  templateId: 'fab0408d92b1ca29783b3fff57f1c9b1f6c5e25fbe3355d2424b1cdc9869b2af:LockWithCommission:LockWithCommission',
  createdEventBlob: 'CgMyLjESwgMKRQB7/Kec8lKMS4DG7WT6IFSFjnGn9rypbepEBo7DBmGhW8oSEiASyCzJjpfLibvzk8TJyJ6Lj3A8/efNei9rv6ZJtxFAPBIYbG9jay13aXRoLWNvbW1pc3Npb24tdjExGmoKQGZhYjA0MDhkOTJiMWNhMjk3ODNiM2ZmZjU3ZjFjOWIxZjZjNWUyNWZiZTMzNTVkMjQyNGIxY2RjOTg2OWIyYWYSEkxvY2tXaXRoQ29tbWlzc2lvbhoSTG9ja1dpdGhDb21taXNzaW9uImJqYApeClw6WlN1cGFub3ZhLXZhbGlkYXRvci0xOjoxMjIwNWM5ZTdkZjNjZTY3MWJjNWUyODUxMjBjYjZlNGRmYWU1ZWUzMDI5YzA0ZmE4MmYxY2Q4MjhjNWU3MTk3ZDg4MipaU3VwYW5vdmEtdmFsaWRhdG9yLTE6OjEyMjA1YzllN2RmM2NlNjcxYmM1ZTI4NTEyMGNiNmU0ZGZhZTVlZTMwMjljMDRmYTgyZjFjZDgyOGM1ZTcxOTdkODgyOUXdTAxMTAYAQioKJgokCAESIOUWynJqMsg/U1H5FL8dd1H8Lik8jlM3gceNhTkJXQ2BEB4=',
  synchronizerId: 'global-domain::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc'
};

// ============================================================================
// KNOWN COMPANIES
// ============================================================================

const KNOWN_COMPANIES = {
  'a4cfe8b0-ddec-4b5e-833b-69482f2cc83e': 'Stripe',
  '9e72997e-cc55-4e31-961b-dd1ceaf0dbbd': 'Databricks',
  '9a5d7372-06aa-43fa-aaee-494291b32bed': 'SpaceX',
  '7ff4a803-93e5-4a6b-8dc7-60162dfe304e': 'Anthropic',
  'ddfadb85-340f-4a9a-af3b-045d3956cd42': 'OpenAI',
  'b092e834-c36e-4bda-97aa-3412de0211c4': 'ByteDance'
};

// ============================================================================
// DASHBOARD UI
// ============================================================================

class Dashboard {
  constructor(accountsList = []) {
    this.logs = [];
    this.maxLogs = 5;
    this.accountsState = new Map();
    this.companiesData = [];
    this.lastUpdate = null;
    this.nextExecution = null;
    this.isRunning = false;
    this.waitingOTP = false;
    this.otpEmail = null;

    for (const account of accountsList) {
      this.accountsState.set(account.email, {
        hectoBalance: 0,
        ccBalance: 0,
        allocatedTo: '-',
        status: 'initializing'
      });
    }
  }

  addLog(message, type = 'info') {
    const timestamp = dayjs().tz(getConfiguredTimezone()).format('HH:mm:ss');
    const prefix = type === 'error' ? 'x' : type === 'success' ? '+' : 'i';
    const line = `${timestamp} ${prefix} ${message}`;
    this.logs.push(line);
    if (this.logs.length > this.maxLogs) this.logs.shift();

    if (!this.waitingOTP) this.render();
  }

  setAccountState(email, state) {
    const existing = this.accountsState.get(email) || {};
    this.accountsState.set(email, { ...existing, ...state });
    if (!this.waitingOTP) this.render();
  }

  setCompanies(companies) {
    this.companiesData = companies;
    if (!this.waitingOTP) this.render();
  }

  setNextExecution(time) {
    this.nextExecution = time;
    if (!this.waitingOTP) this.render();
  }

  setRunning(status) {
    this.isRunning = status;
    if (!this.waitingOTP) this.render();
  }

  setWaitingOTP(waiting, email = null) {
    this.waitingOTP = waiting;
    this.otpEmail = email;
    if (!waiting) this.render();
  }

  _getTermWidth() {
    // Single-column stacked layout tuned for narrow panes
    // (e.g. tmux 3-way vertical split on an iPhone 16 Pro ≈ 24–27 cols).
    // Inner content width = W. Total rendered width = W + 2 (borders).
    const cols = process.stdout.columns || 80;
    // Leave room for the 2 border chars; clamp to a comfortable max.
    const inner = Math.max(20, Math.min(cols - 2, 60));
    return { W: inner };
  }

  _pad(s, w) {
    const str = String(s ?? '');
    if (str.length >= w) return str.substring(0, w);
    return str + ' '.repeat(w - str.length);
  }

  _center(s, w) {
    const str = String(s ?? '');
    if (str.length >= w) return str.substring(0, w);
    const l = Math.floor((w - str.length) / 2);
    return ' '.repeat(l) + str + ' '.repeat(w - str.length - l);
  }

  _wrapLine(text, maxW) {
    const rows = [];
    let row = '';
    let rowW = 0;
    for (const ch of text) {
      if (rowW + 1 > maxW && row.length > 0) {
        rows.push(row);
        row = '  ';
        rowW = 2;
      }
      row += ch;
      rowW++;
    }
    if (row.length > 0) rows.push(row);
    return rows.length > 0 ? rows : [''];
  }

  // Print a single bordered row, centering its content inside width W.
  _printCentered(line, W, color = '') {
    const reset = color ? '\x1b[0m' : '';
    console.log(`\x1b[90m│\x1b[0m${color}${this._center(line, W)}${reset}\x1b[90m│\x1b[0m`);
  }

  // Print a single bordered row with left-aligned content (for logs).
  _printLeft(line, W, color = '') {
    const reset = color ? '\x1b[0m' : '';
    console.log(`\x1b[90m│\x1b[0m${color}${this._pad(line, W)}${reset}\x1b[90m│\x1b[0m`);
  }

  _printTop(W) { console.log(`\x1b[90m┌${'─'.repeat(W)}┐\x1b[0m`); }
  _printMid(W) { console.log(`\x1b[90m├${'─'.repeat(W)}┤\x1b[0m`); }
  _printBot(W) { console.log(`\x1b[90m└${'─'.repeat(W)}┘\x1b[0m`); }

  render() {
    process.stdout.write('\x1B[2J\x1B[0f');
    const { W } = this._getTermWidth();
    const now = dayjs().tz(getConfiguredTimezone()).format('DD/MM HH:mm:ss');
    const statusText = this.isRunning ? 'RUNNING' : 'IDLE';

    // ─── HEADER ───
    this._printTop(W);
    this._printCentered('HectoBot Allocator V10', W);
    this._printMid(W);

    // ─── INFO (centered) ───
    this._printCentered(`Time ${now}`, W);
    this._printCentered(`[${statusText}]`, W);
    this._printCentered(`Next ${this.nextExecution || '-'}`, W);
    this._printCentered(`TZ ${settings.timezone || 'Asia/Jakarta'}`, W);
    this._printMid(W);

    // ─── ACCOUNTS (centered) ───
    this._printCentered('Accounts', W);
    this._printMid(W);
    for (const [email, state] of this.accountsState) {
      const shortEmail = email.split('@')[0];
      const name = shortEmail.length > 16 ? shortEmail.substring(0, 14) + '..' : shortEmail;
      const hecto = Math.floor(state.hectoBalance || 0);
      const cc = (state.ccBalance || 0).toFixed(1);
      const alloc = (state.allocatedTo || '-').substring(0, 10);
      const expiry = state.tokenExpiry || '-';
      this._printCentered(name, W);
      this._printCentered(`H:${hecto} C:${cc}`, W);
      this._printCentered(`Alloc:${alloc} ${expiry}`, W);
    }
    this._printMid(W);

    // ─── MARKET (centered) ───
    this._printCentered('Market', W);
    this._printMid(W);
    const validCo = this.companiesData.filter(c => c.totalLocked > 0);
    const sorted = [...validCo].sort((a, b) => (b.changePercent || 0) - (a.changePercent || 0));
    const topCo = sorted.slice(0, 6);
    if (topCo.length === 0) {
      this._printCentered('-', W);
    } else {
      for (const co of topCo) {
        const name = (co.name || '??').substring(0, 14);
        const pct = co.changePercent || 0;
        const sign = pct >= 0 ? '+' : '';
        this._printCentered(`${name} ${sign}${pct.toFixed(2)}%`, W);
      }
    }
    this._printBot(W);

    // ─── EXECUTION LOG (below, left-aligned for readability) ───
    this._printTop(W);
    this._printCentered('Execution Log', W);
    this._printMid(W);
    const recentLogs = this.logs.slice(-this.maxLogs);
    const allLogRows = [];
    for (const entry of recentLogs) {
      const wrapped = this._wrapLine(` ${entry}`, W);
      for (const row of wrapped) allLogRows.push(row);
    }
    const visibleLogRows = allLogRows.slice(-this.maxLogs);
    if (visibleLogRows.length === 0) {
      this._printLeft(' (no entries yet)', W);
    } else {
      for (const row of visibleLogRows) this._printLeft(row, W);
    }
    this._printBot(W);

    console.log(this._center('Ctrl+C to exit', W + 2));
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function canonicalize(obj) {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalize).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  const pairs = keys.map(key => JSON.stringify(key) + ':' + canonicalize(obj[key]));
  return '{' + pairs.join(',') + '}';
}

function generateUUIDv7() {
  const timestamp = Date.now();
  const timestampHex = timestamp.toString(16).padStart(12, '0');
  const randomBits = crypto.randomUUID().replace(/-/g, '').slice(12);
  return `${timestampHex.slice(0, 8)}-${timestampHex.slice(8, 12)}-7${randomBits.slice(0, 3)}-${randomBits.slice(3, 7)}-${randomBits.slice(7, 19)}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetries(operationName, operationFn, loggerFn, maxRetries = 5, delays = [2000, 3000, 4000, 5000, 6000]) {
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await operationFn();
    } catch (error) {
      if (attempt <= maxRetries) {
        if (loggerFn) loggerFn(`${operationName} failed: ${error.message}. Retrying ${attempt}/${maxRetries} in ${delays[attempt - 1] / 1000}s...`, 'error');
        await sleep(delays[attempt - 1]);
      } else {
        if (loggerFn) loggerFn(`${operationName} finally failed after ${maxRetries} retries: ${error.message}`, 'error');
        throw error;
      }
    }
  }
}

// ============================================================================
// HECTOBOT CLASS
// ============================================================================

class HectoBot {
  constructor(account, dashboard) {
    this.account = account;
    this.dashboard = dashboard;
    this.email = account.email;

    // Load tokens and cached data from tokens.json
    const tokens = tokensData.accounts[this.email] || {};
    this.privyToken = tokens.token || '';
    this.privyPat = tokens.pat || '';
    this.refreshToken = tokens.refreshToken || '';
    this.privyCaid = tokens.caid || crypto.randomUUID();
    this.partyId = account.partyId || tokens.partyId || '';

    // Each bot gets a dedicated proxy (round-robin from proxy.txt). All HTTP
    // calls this bot makes route through this proxy so accounts don't share IPs.
    this.proxyUrl = getNextProxy();
    if (this.proxyUrl) {
      const port = this.proxyUrl.split(':').pop();
      console.log(`  \x1b[90m↳ ${this.email} bound to proxy :${port}\x1b[0m`);
    }

    this.authorizationKey = null;
    this.walletId = tokens.walletId || '';
    this.allWalletIds = []; // Store all available wallets for fallback on BAD SIGNATURE
    this.balance = 0;
    this.ccBalance = 0;
    this.currentAllocation = null;
  }

  log(message, type = 'info') {
    this.dashboard.addLog(`[${this.email.split('@')[0]}] ${message}`, type);
  }

  saveTokens() {
    tokensData.accounts[this.email] = {
      token: this.privyToken,
      pat: this.privyPat,
      refreshToken: this.refreshToken,
      caid: this.privyCaid,
      lastUpdated: new Date().toISOString()
    };
    saveTokens();
  }

  // API Headers
  getHectoHeaders() {
    return {
      'Accept': '*/*',
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Origin': 'https://app.hecto.finance',
      'Cookie': `privy-token=${this.privyToken}; privy-session=t`
    };
  }

  getSupanovaHeaders() {
    return {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Origin': 'https://app.hecto.finance',
      'x-canton-node-id': CANTON.nodeId,
      'x-supa-app-id': CANTON.appId,
      'Authorization': `Bearer ${this.privyToken}`
    };
  }

  getPrivyHeaders() {
    return {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Origin': 'https://app.hecto.finance',
      'Referer': 'https://app.hecto.finance/',
      'privy-app-id': PRIVY.appId,
      'privy-ca-id': this.privyCaid,
      'privy-client': PRIVY.clientVersion,
      'privy-client-id': PRIVY.clientId
    };
  }

  // ============================================================================
  // TOKEN MANAGEMENT - ROBUST SYSTEM
  // ============================================================================

  // Parse JWT and get payload
  parseToken(token) {
    if (!token) return null;
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      return JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    } catch {
      return null;
    }
  }

  // Get token expiration time in seconds
  getTokenExpiry() {
    const payload = this.parseToken(this.privyToken);
    return payload?.exp || 0;
  }

  // Get seconds until token expires
  getSecondsUntilExpiry() {
    const exp = this.getTokenExpiry();
    if (!exp) return 0;
    const now = Math.floor(Date.now() / 1000);
    return Math.max(0, exp - now);
  }

  // Check if token is expired
  isTokenExpired() {
    return this.getSecondsUntilExpiry() <= 0;
  }

  // Check if token needs refresh (less than threshold remaining)
  needsRefresh(thresholdSeconds = 600) { // Default 10 minutes
    const remaining = this.getSecondsUntilExpiry();
    return remaining <= thresholdSeconds;
  }

  // Get human-readable time until expiry
  getExpiryString() {
    const seconds = this.getSecondsUntilExpiry();
    if (seconds <= 0) return 'EXPIRED';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }

  // Save tokens with metadata
  saveTokens() {
    const expiry = this.getTokenExpiry();
    tokensData.accounts[this.email] = {
      token: this.privyToken,
      pat: this.privyPat,
      refreshToken: this.refreshToken,
      caid: this.privyCaid,
      partyId: this.partyId,
      walletId: this.walletId,
      tokenExpiry: expiry,
      tokenExpiryDate: expiry ? new Date(expiry * 1000).toISOString() : null,
      lastRefresh: new Date().toISOString()
    };
    saveTokens();
  }

  // Auto-detect partyId from Hecto API
  async fetchPartyId() {
    if (this.partyId) return this.partyId;
    try {
      this.log('Auto-detecting partyId...');
      const response = await fetchWithProxy(`${API.base}/auth/me`, {
        headers: this.getHectoHeaders()
      }, this.proxyUrl);
      if (response.ok) {
        const data = await response.json();
        if (data.user?.partyId) {
          this.partyId = data.user.partyId;
          this.saveTokens();
          this.log(`PartyId detected: ${this.partyId.substring(0, 30)}...`, 'success');
        } else {
          this.log('PartyId not found in /auth/me response', 'error');
        }
      } else {
        this.log(`/auth/me failed: ${response.status}`, 'error');
      }
    } catch (e) {
      this.log(`Failed to fetch partyId: ${e.message}`, 'error');
    }
    return this.partyId;
  }

  // Reload tokens from file (in case another process updated them)
  reloadTokensFromFile() {
    try {
      loadTokens(); // Reload global tokensData
      const tokens = tokensData.accounts[this.email] || {};
      if (tokens.token) this.privyToken = tokens.token;
      if (tokens.pat) this.privyPat = tokens.pat;
      if (tokens.refreshToken) this.refreshToken = tokens.refreshToken;
    } catch (e) {
      // Ignore errors, keep existing tokens
    }
  }

  // Refresh token with retry logic
  async refreshPrivyToken(maxRetries = 3) {
    // Reload tokens from file first - in case they were updated externally
    this.reloadTokensFromFile();

    if (!this.refreshToken) {
      this.log('No refresh token available', 'error');
      return false;
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const body = JSON.stringify({ refresh_token: this.refreshToken });
        const headers = {
          ...this.getPrivyHeaders(),
          'Authorization': `Bearer ${this.privyToken}`
        };
        const response = await httpsRequest(
          `${API.privyAuth}/api/v1/sessions`,
          { method: 'POST', headers },
          body,
          this.proxyUrl
        );

        if (!response.ok) {
          const errorText = await response.text();
          // Log more details for debugging 400 errors
          const refreshTokenPreview = this.refreshToken ? `${this.refreshToken.substring(0, 10)}...` : 'none';
          this.log(`Refresh ${attempt}/${maxRetries} failed: ${response.status} - ${errorText.substring(0, 150)} (rt: ${refreshTokenPreview})`, 'error');

          // On 400 error, reload tokens and retry with fresh data
          if (response.status === 400 && attempt < maxRetries) {
            this.log('Reloading tokens from file before retry...');
            this.reloadTokensFromFile();
          }

          if (attempt < maxRetries) {
            await sleep(2000 * attempt);
            continue;
          }
          return false;
        }

        const data = await response.json();
        if (data.token) {
          this.privyToken = data.token;
          if (data.refresh_token) {
            this.refreshToken = data.refresh_token;
          }
          if (data.privy_access_token) {
            this.privyPat = data.privy_access_token;
          }
          this.saveTokens();

          const expiryStr = this.getExpiryString();
          this.log(`Token refreshed! Valid for ${expiryStr}`, 'success');
          return true;
        }
      } catch (error) {
        this.log(`Refresh ${attempt}/${maxRetries} error: ${error.message}`, 'error');
        if (attempt < maxRetries) {
          await sleep(2000 * attempt);
          continue;
        }
      }
    }
    return false;
  }

  // Proactive token refresh - call this regularly
  async proactiveRefresh() {
    // Refresh if less than 15 minutes remaining
    const REFRESH_THRESHOLD = 900; // 15 minutes in seconds

    if (this.needsRefresh(REFRESH_THRESHOLD)) {
      const remaining = this.getSecondsUntilExpiry();
      if (remaining > 0) {
        this.log(`Token expires in ${this.getExpiryString()}, refreshing proactively...`);
      }
      return await this.refreshPrivyToken();
    }
    return true; // Token still valid, no refresh needed
  }

  async sendOTP() {
    // Local rate limit: don't send OTP more than once per 30 seconds.
    // If we hit this, wait it out instead of returning false silently — the
    // caller assumes a successful send and would otherwise block 90s reading
    // an email that was never triggered.
    const now = Date.now();
    if (this._lastOtpSent && (now - this._lastOtpSent) < 30000) {
      const waitMs = 30000 - (now - this._lastOtpSent);
      this.log(`OTP local cooldown ${Math.ceil(waitMs / 1000)}s, waiting...`);
      await sleep(waitMs);
    }

    const body = JSON.stringify({ email: this.email });
    // Privy rate-limits OTP sends per-IP. Be PATIENT: up to 6 attempts,
    // honoring the `Retry-After` header when present, with backoff that
    // can wait up to ~60s. This is far more important than failing fast
    // here — the operator is sitting at the prompt waiting.
    const MAX_ATTEMPTS = 6;
    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let response;
      try {
        response = await httpsRequest(
          `${API.privyAuth}/api/v1/passwordless/init`,
          { method: 'POST', headers: this.getPrivyHeaders() },
          body,
          this.proxyUrl
        );
      } catch (netErr) {
        lastErr = netErr;
        this.log(`OTP send network error (${attempt}/${MAX_ATTEMPTS}): ${netErr.message}`, 'error');
        if (attempt < MAX_ATTEMPTS) await sleep(3000 * attempt + Math.random() * 1500);
        continue;
      }

      if (response.ok) {
        this._lastOtpSent = Date.now();
        let parsed;
        try { parsed = await response.json(); } catch { parsed = { success: true }; }
        return parsed.success !== false;
      }

      const status = response.status;
      let errText = '';
      try { errText = await response.text(); } catch { }
      lastErr = new Error(`OTP send HTTP ${status}: ${errText.substring(0, 200)}`);

      // Honor server-provided Retry-After (seconds or HTTP-date)
      let serverWaitMs = 0;
      try {
        const ra = (response.headers && response.headers['retry-after']) || null;
        if (ra) {
          const asInt = parseInt(ra, 10);
          if (!Number.isNaN(asInt)) {
            serverWaitMs = asInt * 1000;
          } else {
            const t = Date.parse(ra);
            if (!Number.isNaN(t)) serverWaitMs = Math.max(0, t - Date.now());
          }
        }
      } catch { }

      // 429/503: retryable rate limit
      if ((status === 429 || status === 503) && attempt < MAX_ATTEMPTS) {
        // Cap server hint at 60s so we don't sit forever; otherwise use
        // exponential backoff that grows generously: 5s, 10s, 20s, 30s, 45s.
        const expWait = [5000, 10000, 20000, 30000, 45000][Math.min(attempt - 1, 4)];
        const waitMs = Math.min(60000, Math.max(serverWaitMs, expWait)) + Math.floor(Math.random() * 1500);
        this.log(`OTP send rate-limited (${status})${serverWaitMs ? ` server wants ${(serverWaitMs / 1000).toFixed(0)}s` : ''}, waiting ${(waitMs / 1000).toFixed(1)}s (attempt ${attempt}/${MAX_ATTEMPTS})`, 'error');
        await sleep(waitMs);
        continue;
      }

      // 4xx other than 429: not retryable (likely bad request)
      this.log(`OTP send failed (HTTP ${status}): ${errText.substring(0, 200)}`, 'error');
      throw lastErr;
    }
    throw lastErr || new Error('Failed to send OTP after retries');
  }

  async verifyOTP(code) {
    const body = JSON.stringify({ email: this.email, code, mode: 'login-or-sign-up' });
    const response = await httpsRequest(
      `${API.privyAuth}/api/v1/passwordless/authenticate`,
      { method: 'POST', headers: this.getPrivyHeaders() },
      body,
      this.proxyUrl
    );

    if (!response.ok) throw new Error('OTP verification failed');

    const data = await response.json();
    if (!data.token) throw new Error('Invalid response');

    this.privyToken = data.token;
    this.privyPat = data.privy_access_token;
    this.refreshToken = data.refresh_token;
    this.saveTokens();
    return true;
  }

  // Auto-read OTP from Gmail via IMAP
  async readOTPFromEmail(maxWaitMs = 90000) {
    const appPassword = this.account.emailAppPassword;
    if (!appPassword) return null;

    const startTime = Date.now();
    const pollInterval = 7000; // Poll every 7 seconds
    const initialDelay = 10000; // Wait 10s for email delivery

    this.log(`Waiting ${initialDelay / 1000}s for OTP email delivery...`);
    await sleep(initialDelay);

    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 5;

    while (Date.now() - startTime < maxWaitMs) {
      let client = null;

      try {
        // Create new client for each attempt to avoid stale connections
        client = new ImapFlow({
          host: 'imap.gmail.com',
          port: 993,
          secure: true,
          auth: { user: this.email, pass: appPassword },
          logger: false,
          greetingTimeout: 15000,
          socketTimeout: 20000,
          // Disable compression to avoid some connection issues
          disableCompression: true
        });

        // Connect with timeout wrapper
        await Promise.race([
          client.connect(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Connect timeout')), 20000))
        ]);

        // Select INBOX without lock (simpler, less prone to errors)
        await client.mailboxOpen('INBOX');

        // Use simpler search - just unseen emails from privy.io
        // Some IMAP servers don't support complex queries well
        let messages = [];
        try {
          messages = await client.search({
            from: 'privy.io',
            unseen: true
          });
        } catch (searchErr) {
          // Fallback: search all unseen emails if from-filter fails
          this.log(`Search with from-filter failed, trying unseen only...`);
          try {
            messages = await client.search({ unseen: true });
          } catch (searchErr2) {
            throw new Error(`Search failed: ${searchErr2.message}`);
          }
        }

        if (messages.length > 0) {
          // Get the LATEST messages (check last 5 for Privy OTP)
          const toCheck = messages.slice(-5).reverse();

          for (const uid of toCheck) {
            try {
              const msg = await client.fetchOne(uid, { source: true });
              if (!msg || !msg.source) continue;

              const emailBody = msg.source.toString();

              // Check if this is from Privy
              if (!emailBody.toLowerCase().includes('privy')) continue;

              // Check email date - only accept if received after we sent OTP
              const dateMatch = emailBody.match(/^Date:\s*(.+)$/mi);
              if (dateMatch) {
                const emailDate = new Date(dateMatch[1].trim());
                if (emailDate.getTime() < startTime - 30000) {
                  // Old email, mark as read and skip
                  try {
                    await client.messageFlagsAdd(uid, ['\\Seen']);
                  } catch (e) { }
                  continue;
                }
              }

              // Extract 6-digit OTP code
              const otpMatch = emailBody.match(/\b(\d{6})\b/);
              if (otpMatch) {
                const code = otpMatch[1];
                this.log(`OTP found: ${code}`, 'success');
                try {
                  await client.messageFlagsAdd(uid, ['\\Seen']);
                } catch (e) { }

                // Clean disconnect
                try { await client.logout(); } catch (e) { }
                return code;
              }
            } catch (fetchErr) {
              // Skip this message, try next
              continue;
            }
          }
        }

        // Successfully connected and searched, reset error counter
        consecutiveErrors = 0;

        // Clean disconnect
        try { await client.logout(); } catch (e) { }
        client = null;

      } catch (imapError) {
        consecutiveErrors++;
        const errMsg = imapError.message || String(imapError);

        // Close client if exists
        if (client) {
          try { await client.logout(); } catch (e) {
            try { client.close(); } catch (e2) { }
          }
          client = null;
        }

        // Determine error type for better handling
        const isAuthError = errMsg.includes('Authentication') || errMsg.includes('Invalid credentials');
        const isConnectError = errMsg.includes('timeout') || errMsg.includes('ECONNREFUSED') || errMsg.includes('ENOTFOUND');
        const isCommandError = errMsg.includes('Command failed');

        if (isAuthError) {
          this.log(`IMAP auth failed - check emailAppPassword for ${this.email}`, 'error');
          return null; // Don't retry auth errors
        }

        if (consecutiveErrors >= 2 || !isCommandError) {
          this.log(`IMAP error (${consecutiveErrors}/${maxConsecutiveErrors}): ${errMsg}`, 'error');
        }

        // If too many consecutive errors, wait longer
        if (consecutiveErrors >= maxConsecutiveErrors) {
          this.log(`Too many IMAP errors, waiting 15s before retry...`);
          await sleep(15000);
          consecutiveErrors = 0;
          continue;
        }

        // For connection errors, wait a bit longer
        if (isConnectError) {
          await sleep(5000);
        }
      }

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      if (elapsed % 14 < 7) { // Don't spam logs every poll
        this.log(`Waiting for OTP email... (${elapsed}s)`);
      }
      await sleep(pollInterval);
    }

    this.log('OTP email not found within timeout', 'error');
    return null;
  }

  // Mark all existing Privy emails as read (prevent picking up old OTPs)
  async clearOldOTPEmails() {
    const appPassword = this.account.emailAppPassword;
    if (!appPassword) return;

    let client = null;
    try {
      client = new ImapFlow({
        host: 'imap.gmail.com',
        port: 993,
        secure: true,
        auth: { user: this.email, pass: appPassword },
        logger: false,
        greetingTimeout: 10000,
        socketTimeout: 15000,
        disableCompression: true
      });

      await Promise.race([
        client.connect(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Connect timeout')), 15000))
      ]);

      await client.mailboxOpen('INBOX');

      // Try to find Privy emails
      let messages = [];
      try {
        messages = await client.search({ from: 'privy.io', unseen: true });
      } catch (e) {
        // Fallback to all unseen
        try {
          const allUnseen = await client.search({ unseen: true });
          // We'll filter in readOTPFromEmail instead
          messages = [];
        } catch (e2) { }
      }

      if (messages.length > 0) {
        try {
          await client.messageFlagsAdd(messages, ['\\Seen']);
          this.log(`Marked ${messages.length} old OTP emails as read`);
        } catch (e) { }
      }

      try { await client.logout(); } catch (e) { }
    } catch (e) {
      // Ignore errors during cleanup
      if (client) {
        try { await client.logout(); } catch (e2) {
          try { client.close(); } catch (e3) { }
        }
      }
    }
  }

  // Full auto-login: send OTP > read from email > verify (with retry)
  // `sharedRl` (optional) is a readline.Interface managed by the caller
  // (runOTPMode) — passed in so that closing it after each prompt doesn't
  // EOF process.stdin for subsequent accounts. When omitted, a per-call
  // interface is created and closed (legacy single-account flow).
  async autoLogin(maxRetries = 3, sharedRl = null) {
    // Prevent multiple simultaneous OTP requests
    if (this._otpInProgress) {
      this.log('OTP login already in progress, skipping...');
      return false;
    }
    this._otpInProgress = true;

    // Global OTP throttle: Privy rate-limits per IP roughly every ~60s
    // after a few OTP sends. Stagger each call ≥ 15s after the previous to
    // stay under the limit during sequential mass-login.
    const globalSlot = HectoBot._otpGlobalSlot || 0;
    const nowMs = Date.now();
    const nextSlot = Math.max(nowMs, globalSlot);
    HectoBot._otpGlobalSlot = nextSlot + 15000;
    if (nextSlot > nowMs) {
      const waitMs = nextSlot - nowMs;
      this.log(`Global OTP queue: waiting ${(waitMs / 1000).toFixed(1)}s for slot...`);
      await sleep(waitMs);
    }

    try {
      // Check if email is Gmail (supports IMAP auto-read)
      const isGmail = this.email.toLowerCase().endsWith('@gmail.com');
      const hasAppPassword = !!this.account.emailAppPassword;
      const canAutoRead = isGmail && hasAppPassword;

      if (canAutoRead) {
        // Gmail: Try auto-login via IMAP
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            this.log(`Auto-login attempt ${attempt}/${maxRetries}...`);

            // Mark old OTP emails as read first
            await this.clearOldOTPEmails();

            // Send new OTP
            await this.sendOTP();

            // Read OTP from email
            const code = await this.readOTPFromEmail(90000);

            if (code) {
              await this.verifyOTP(code);
              this.log(`Auto-login successful! Token valid for ${this.getExpiryString()}`, 'success');
              return true;
            }

            this.log(`OTP not found on attempt ${attempt}`, 'error');
          } catch (error) {
            this.log(`Auto-login attempt ${attempt} failed: ${error.message}`, 'error');
          }

          if (attempt < maxRetries) {
            this.log(`Retrying in 5s...`);
            await sleep(5000);
          }
        }
      }

      // Non-Gmail or IMAP failed: Manual OTP input
      if (canAutoRead) {
        this.log('Auto-login failed after retries. Skipping manual OTP for automated account.', 'error');
        return false;
      }

      this.log('Manual OTP required');

      // Manual OTP requires interactive stdin. If we're running detached
      // (nohup, systemd without TTY, pm2 without --no-daemon, etc.) the
      // prompt would silently hang forever. Detect and bail clearly.
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        this.log('No TTY available — run in a real terminal to enter OTP manually.', 'error');
        return false;
      }

      // Send OTP first (for non-Gmail, this is the first send)
      try {
        await this.sendOTP();
      } catch (sendErr) {
        this.log(`Manual OTP send failed: ${sendErr.message}`, 'error');
        return false;
      }

      // FREEZE dashboard rendering for the entire prompt session. Any
      // background log (other bots, keepAlive, market refresh) would clear
      // the screen mid-typing and clobber the input.
      this.dashboard.setWaitingOTP(true, this.email);

      try {
        // Up to 3 chances to type the right code (in case of typo or stale
        // OTP). On the 4th miss, give up and let the operator restart.
        const MAX_TRIES = 3;
        for (let tryNum = 1; tryNum <= MAX_TRIES; tryNum++) {
          // Redraw banner each round so user always sees what's expected
          process.stdout.write('\x1B[2J\x1B[0f');
          console.log('');
          console.log('═══════════════════════════════════════════════════════');
          console.log(`  MANUAL OTP REQUIRED`);
          console.log(`  Account: ${this.email}`);
          console.log(`  Check your inbox for the 6-digit code from Privy.`);
          if (tryNum > 1) {
            console.log(`  Attempt ${tryNum}/${MAX_TRIES}.`);
          }
          console.log('═══════════════════════════════════════════════════════');
          console.log('');

          // Use the caller-provided readline if available (so process.stdin
          // doesn't get EOF'd between accounts). Fall back to a local one
          // for single-account/legacy callers.
          const rl = sharedRl || readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: true
          });

          let manualCode;
          try {
            manualCode = await new Promise(resolve => {
              rl.question(`OTP> `, resolve);
            });
          } finally {
            // ONLY close rl if we created it locally — never close a shared one.
            if (!sharedRl) rl.close();
          }

          const trimmed = (manualCode || '').replace(/\s+/g, '').trim();
          if (!trimmed) {
            console.log('  (empty input — try again)');
            await sleep(800);
            continue;
          }
          if (!/^\d{6}$/.test(trimmed)) {
            console.log(`  Invalid format: "${trimmed.substring(0, 12)}" — need exactly 6 digits.`);
            await sleep(1200);
            continue;
          }

          try {
            await this.verifyOTP(trimmed);
            this.log('Manual login successful', 'success');
            return true;
          } catch (verifyErr) {
            console.log(`  Verify failed: ${verifyErr.message}`);
            if (tryNum < MAX_TRIES) {
              console.log('  Try again with the latest OTP from your inbox.');
              await sleep(1500);
            }
          }
        }
        this.log(`Manual OTP failed after ${MAX_TRIES} attempts`, 'error');
        return false;
      } finally {
        this.dashboard.setWaitingOTP(false);
      }
    } finally {
      this._otpInProgress = false;
    }
  }

  async ensureAuthenticated(timeoutMs = 600000) {
    // Wrap the entire auth process in a timeout to prevent infinite hangs.
    // Default 10 min — manual OTP entry needs time for the operator to find
    // the email and type the code (with up to 3 retry attempts internally).
    const authPromise = this._doEnsureAuthenticated();

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Authentication timeout (${Math.round(timeoutMs / 60000)} min). Check token/network.`)), timeoutMs);
    });

    try {
      const result = await Promise.race([authPromise, timeoutPromise]);
      this._authFailed = !result;
      return result;
    } catch (error) {
      this.log(`Auth failed: ${error.message}`, 'error');
      this._authFailed = true;
      // Return false instead of throwing to allow bot to continue in degraded mode
      return false;
    }
  }

  async _doEnsureAuthenticated() {
    // On first call, try to refresh if token still valid
    if (!this._initialRefreshDone && !this.isTokenExpired()) {
      this._initialRefreshDone = true;
      this.log('Initial token refresh...');
      const refreshed = await this.refreshPrivyToken();
      if (refreshed) {
        this.log(`Token refreshed! Valid for ${this.getExpiryString()}`, 'success');
        return true;
      }
      if (!this.isTokenExpired()) return true;
    }
    this._initialRefreshDone = true;

    if (this.isTokenExpired()) {
      this.log('Token expired, attempting re-authentication...');
      const refreshed = await this.refreshPrivyToken();

      if (!refreshed) {
        // Auto-login with IMAP OTP
        const loggedIn = await this.autoLogin();
        if (!loggedIn) {
          this.log('Auto-login failed, token still expired', 'error');
          return false;
        }
      } else {
        this.log('Token refreshed', 'success');
      }
    }
    // Auto-detect partyId if not set
    if (!this.partyId) await this.fetchPartyId();
    return true;
  }

  // User Authorization Key (with caching to prevent repeated calls)
  async getUserAuthorizationKey(forceRefresh = false) {
    // Return cached key if still valid (auth key is tied to current session)
    // Only refresh if forceRefresh is true, we don't have a key, OR walletId is missing
    if (this.authorizationKey && this.walletId && !forceRefresh) {
      return true;
    }

    // If forceRefresh, clear authKey but PRESERVE walletId if it was explicitly
    // rotated (e.g. BAD SIGNATURE recovery). Only wipe walletId when it's truly
    // unknown (null) or not in our known wallet list.
    if (forceRefresh) {
      // Keep rotated walletId if it's in allWalletIds (set by BAD SIG rotation)
      if (this.walletId && Array.isArray(this.allWalletIds) && this.allWalletIds.includes(this.walletId)) {
        this.log(`Auth refresh: preserving rotated wallet ${this.walletId.substring(0, 12)}`, 'debug');
      } else {
        this.walletId = null;
      }
    }

    const { CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } = await import('@hpke/core');
    const { Chacha20Poly1305 } = await import('@hpke/chacha20poly1305');

    const suite = new CipherSuite({
      kem: new DhkemP256HkdfSha256(),
      kdf: new HkdfSha256(),
      aead: new Chacha20Poly1305()
    });

    const keyPair = await suite.kem.generateKeyPair();
    const publicKeySpki = await crypto.subtle.exportKey('spki', keyPair.publicKey);
    const publicKeyB64 = Buffer.from(publicKeySpki).toString('base64');

    // NOTE: The authenticate endpoint is called from Privy iframe (same-origin)
    // - Origin must be https://auth.privy.io (NOT app.hecto.finance)
    // - No privy-ca-id or privy-client headers
    // - Pass user_jwt with the Privy token for authentication
    const body = JSON.stringify({
      encryption_type: 'HPKE',
      recipient_public_key: publicKeyB64,
      user_jwt: this.privyToken
    });

    const response = await httpsRequest(`${API.privyAuth}/api/v1/wallets/authenticate`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Content-Type': 'application/json',
        'Origin': 'https://auth.privy.io',
        'Referer': 'https://auth.privy.io/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'privy-app-id': PRIVY.appId,
        'privy-client-id': PRIVY.clientId,
        'Authorization': `Bearer ${this.privyToken}`
      }
    }, body, this.proxyUrl);

    if (!response.ok) {
      const errorText = await response.text();
      this.log(`Auth key failed (${response.status}): ${errorText.substring(0, 80)}`, 'error');
      return null;
    }

    const data = await response.json();

    if (data.encrypted_authorization_key) {
      const encKey = data.encrypted_authorization_key;
      const encapsulatedKey = Buffer.from(encKey.encapsulated_key, 'base64');
      const ciphertext = Buffer.from(encKey.ciphertext, 'base64');

      const recipient = await suite.createRecipientContext({
        recipientKey: keyPair.privateKey,
        enc: new Uint8Array(encapsulatedKey),
        info: new Uint8Array(0)
      });
      const decrypted = await recipient.open(new Uint8Array(ciphertext));
      this.authorizationKey = new TextDecoder().decode(decrypted);

      // Extract wallet ID from response
      if (data.wallets && data.wallets.length > 0) {
        // Store ALL wallet IDs for fallback on BAD SIGNATURE
        this.allWalletIds = data.wallets.map(w => w.id);
        const walletTypes = data.wallets.map(w => `${w.chain_type}:${w.id.substring(0, 8)}`).join(', ');
        this.log(`Available wallets (${data.wallets.length}): ${walletTypes}`, 'debug');

        // If we already have a known-good walletId (from previous success), keep it
        if (this.walletId && this.allWalletIds.includes(this.walletId)) {
          this.log(`Keeping known wallet: ${this.walletId}`, 'debug');
        } else {
          // Prefer ethereum wallet, fallback to stellar, then first available
          const ethWallet = data.wallets.find(w => w.chain_type === 'ethereum');
          const stellarWallet = data.wallets.find(w => w.chain_type === 'stellar');
          const selectedWallet = ethWallet || stellarWallet || data.wallets[0];
          this.walletId = selectedWallet.id;
          this.log(`Selected wallet: ${this.walletId} (${selectedWallet.chain_type})`, 'success');
        }
        this.saveTokens();
      }

      return true;
    }
    return false;
  }

  generateAuthorizationSignature(url, body) {
    if (!this.authorizationKey) throw new Error('No authorization key');

    const payload = {
      version: 1,
      method: 'POST',
      url,
      body,
      headers: { 'privy-app-id': PRIVY.appId }
    };

    const serializedPayload = canonicalize(payload);
    const authKeyRaw = this.authorizationKey;

    let privateKeyPem;
    if (authKeyRaw.startsWith('-----BEGIN')) {
      privateKeyPem = authKeyRaw;
    } else {
      const keyBuf = Buffer.from(authKeyRaw, 'base64');
      try {
        const pk = crypto.createPrivateKey({ key: keyBuf, format: 'der', type: 'pkcs8' });
        privateKeyPem = pk.export({ type: 'pkcs8', format: 'pem' });
      } catch {
        privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${authKeyRaw}\n-----END PRIVATE KEY-----`;
      }
    }

    const privateKey = crypto.createPrivateKey({ key: privateKeyPem, format: 'pem' });
    const signatureBuffer = crypto.sign('sha256', Buffer.from(serializedPayload), privateKey);
    return signatureBuffer.toString('base64');
  }

  // Balance & Data
  async getBalance() {
    const response = await fetchWithProxy(`${API.supanova}/canton/api/balances`, {
      method: 'GET',
      headers: this.getSupanovaHeaders()
    }, this.proxyUrl);

    if (!response.ok) throw new Error('Failed to get balance');

    const data = await response.json();
    const tokens = data.tokens || [];

    const hectoToken = tokens.find(t => t.instrumentId?.id === 'HECTO');
    const amuletToken = tokens.find(t => t.instrumentId?.id === 'Amulet');

    this.balance = hectoToken ? parseFloat(hectoToken.totalUnlockedBalance || '0') : 0;
    this.lockedBalance = hectoToken ? parseFloat(hectoToken.totalLockedBalance || '0') : 0;
    this.ccBalance = amuletToken ? parseFloat(amuletToken.totalUnlockedBalance || '0') : 0;

    return this.balance;
  }

  async getExistingLocks() {
    const partyId = encodeURIComponent(this.partyId);
    const response = await fetchWithProxy(`${API.base}/locks?userPartyId=${partyId}&status=locked`, {
      method: 'GET',
      headers: this.getHectoHeaders()
    }, this.proxyUrl);

    if (!response.ok) {
      this.log(`getExistingLocks failed: ${response.status}`, 'error');
      return null;
    }
    const data = await response.json();

    // Handle different response formats
    let locks = [];
    if (Array.isArray(data)) {
      locks = data;
    } else if (data.locks && Array.isArray(data.locks)) {
      locks = data.locks;
    } else if (data.data && Array.isArray(data.data)) {
      locks = data.data;
    }

    return locks;
  }

  async getActiveContracts(templateId) {
    const encodedTemplateId = encodeURIComponent(templateId);
    const response = await fetchWithProxy(`${API.supanova}/canton/api/active_contracts?templateIds=${encodedTemplateId}`, {
      method: 'GET',
      headers: this.getSupanovaHeaders()
    }, this.proxyUrl);
    if (!response.ok) return [];
    return await response.json();
  }

  async getHolderService() {
    const contracts = await this.getActiveContracts('#utility-registry-app-v0:Utility.Registry.App.V0.Service.Holder:HolderService');
    return contracts.length > 0 ? contracts[0] : null;
  }

  async getAmuletContracts() {
    return await this.getActiveContracts('#splice-amulet:Splice.Amulet:Amulet');
  }

  // Fetch the global LockService contract from Hecto API.
  // Returned shape: { contractId, templateId, createdEventBlob }
  // This contract is the entry point for the new Lock:LockService:LockHoldings choice.
  async getLockServiceContract() {
    const response = await fetchWithProxy(`${API.base}/lock-service?_t=${Date.now()}`, {
      method: 'GET',
      headers: {
        ...this.getHectoHeaders(),
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    }, this.proxyUrl);
    if (!response.ok) throw new Error(`Failed to get LockService contract (${response.status})`);
    return await response.json();
  }

  // Fetch user's unlocked Holding contracts (new schema replaces old HECTO balance holdings).
  // These cids go into choiceArgument.holdingCids for LockHoldings.
  async getHoldingContracts() {
    return await this.getActiveContracts('#utility-registry-holding-v0:Utility.Registry.Holding.V0.Holding:Holding');
  }

  // Guard: check if this wallet has any funds still locked under the DEPRECATED
  // LockWithCommission template. If so we must refuse to allocate with the new
  // template because double-locking the same funds will fail on-chain and waste CC fees.
  // Returns the count of deprecated-lock contracts (0 = clean).
  async checkLegacyLockedHoldings() {
    const legacy = await this.getActiveContracts('fab0408d92b1ca29783b3fff57f1c9b1f6c5e25fbe3355d2424b1cdc9869b2af:LockWithCommission:LockWithCommission');
    return Array.isArray(legacy) ? legacy.length : 0;
  }

  async getAllocationContext() {
    const response = await fetchWithProxy(`${API.base}/scan/allocation-context`, {
      method: 'GET',
      headers: this.getHectoHeaders()
    }, this.proxyUrl);
    if (!response.ok) throw new Error('Failed to get allocation context');
    return await response.json();
  }

  buildDisclosedContracts(allocationContext) {
    const disclosedContracts = [];
    const syncDomain = allocationContext.synchronizerId;

    if (allocationContext.amuletRules) {
      disclosedContracts.push({
        contractId: allocationContext.amuletRules.contractId,
        templateId: allocationContext.amuletRules.templateId,
        createdEventBlob: allocationContext.amuletRules.createdEventBlob,
        synchronizerId: syncDomain
      });
    }

    if (allocationContext.openMiningRound) {
      disclosedContracts.push({
        contractId: allocationContext.openMiningRound.contractId,
        templateId: allocationContext.openMiningRound.templateId,
        createdEventBlob: allocationContext.openMiningRound.createdEventBlob,
        synchronizerId: syncDomain
      });
    }

    disclosedContracts.push({
      contractId: LOCK_WITH_COMMISSION_CONTRACT.contractId,
      templateId: LOCK_WITH_COMMISSION_CONTRACT.templateId,
      createdEventBlob: LOCK_WITH_COMMISSION_CONTRACT.createdEventBlob,
      synchronizerId: LOCK_WITH_COMMISSION_CONTRACT.synchronizerId
    });

    if (allocationContext.commissionPreapprovals) {
      for (const preapproval of allocationContext.commissionPreapprovals) {
        if (preapproval.disclosedContract) {
          disclosedContracts.push({
            contractId: preapproval.disclosedContract.contractId,
            templateId: preapproval.disclosedContract.templateId,
            createdEventBlob: preapproval.disclosedContract.createdEventBlob,
            synchronizerId: preapproval.disclosedContract.synchronizerId || syncDomain
          });
        }
      }
    }

    if (allocationContext.featuredAppRight) {
      disclosedContracts.push({
        contractId: allocationContext.featuredAppRight.contractId,
        templateId: allocationContext.featuredAppRight.templateId,
        createdEventBlob: allocationContext.featuredAppRight.createdEventBlob,
        synchronizerId: allocationContext.featuredAppRight.synchronizerId || syncDomain
      });
    }

    return disclosedContracts;
  }

  async prepareCantonTransaction(commands, disclosedContracts, commandId) {
    const response = await fetchWithProxy(`${API.supanova}/canton/api/prepare_transaction`, {
      method: 'POST',
      headers: this.getSupanovaHeaders(),
      body: JSON.stringify({ commands, disclosedContracts, commandId })
    }, this.proxyUrl);

    if (!response.ok) {
      const errorText = await response.text();
      let errorDetail = '';

      try {
        const errorJson = JSON.parse(errorText);
        errorDetail = errorJson.message || errorJson.error || errorJson.details || errorText;
      } catch {
        errorDetail = errorText;
      }

      // Provide more descriptive error messages
      if (errorDetail.includes('CONTRACT_NOT_FOUND') || errorDetail.includes('contract not found')) {
        throw new Error(`CONTRACT_NOT_FOUND: Contract expired or already used. Will retry with fresh contracts.`);
      }
      if (errorDetail.includes('STALE_CONTRACT')) {
        throw new Error(`STALE_CONTRACT: Contract data is outdated. Will retry with fresh data.`);
      }
      if (errorDetail.includes('INSUFFICIENT') || errorDetail.includes('insufficient')) {
        throw new Error(`INSUFFICIENT_FUNDS: Not enough CC balance for transaction fees. Need at least 0.03 CC.`);
      }

      throw new Error(`Prepare failed (${response.status}): ${errorDetail.substring(0, 150)}`);
    }
    return await response.json();
  }

  async signTransaction(hash) {
    // Ensure we have authorization key AND valid walletId before signing
    if (!this.authorizationKey || !this.walletId) {
      const gotKey = await this.getUserAuthorizationKey();
      if (!gotKey || !this.authorizationKey || !this.walletId) {
        throw new Error('Failed to get authorization key or wallet ID');
      }
    }

    // Debug: log original hash format
    const hashLen = hash?.length || 0;
    const hashPrefix = hash?.substring(0, 10) || 'null';
    this.log(`Signing hash: len=${hashLen}, prefix=${hashPrefix}, isHex=${hash?.startsWith('0x')}`, 'debug');

    // Convert hash to hex format for Privy API
    let hashToSign;
    if (hash.startsWith('0x')) {
      hashToSign = hash;
    } else {
      // Assume base64, convert to hex
      const hexHash = Buffer.from(hash, 'base64').toString('hex');
      hashToSign = `0x${hexHash}`;
    }

    this.log(`Hash to sign: ${hashToSign.substring(0, 20)}... (${hashToSign.length} chars)`, 'debug');

    const url = `${API.privyAuth}/api/v1/wallets/${this.walletId}/raw_sign`;
    const bodyObj = { params: { hash: hashToSign } };

    let headers = {
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Content-Type': 'application/json',
      'Origin': 'https://app.hecto.finance',
      'Referer': 'https://app.hecto.finance/',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'privy-app-id': PRIVY.appId,
      'privy-ca-id': this.privyCaid,
      'privy-client': PRIVY.clientVersion,
      'privy-client-id': PRIVY.clientId,
      'Authorization': `Bearer ${this.privyToken}`
    };

    if (this.authorizationKey) {
      headers['privy-authorization-signature'] = this.generateAuthorizationSignature(url, bodyObj);
    }

    const body = JSON.stringify(bodyObj);
    const response = await httpsRequest(url, { method: 'POST', headers }, body, this.proxyUrl);

    if (!response.ok) {
      const errorText = await response.text();
      this.log(`Sign failed (${response.status}): ${errorText.substring(0, 100)}`, 'error');
      throw new Error(`Signing failed: ${response.status}`);
    }

    const result = await response.json();

    // Handle different response formats from Privy API
    let signature = null;
    if (result.data?.signature) {
      signature = result.data.signature;
    } else if (result.signature) {
      signature = result.signature;
    } else if (typeof result === 'string' && result.startsWith('0x')) {
      signature = result;
    }

    if (!signature) {
      this.log(`Unexpected sign response format: ${JSON.stringify(result).substring(0, 200)}`, 'error');
      throw new Error('Invalid signature response format');
    }

    // Validate signature format (should be hex string starting with 0x)
    if (typeof signature !== 'string' || !signature.startsWith('0x')) {
      this.log(`Invalid signature format: ${typeof signature} - ${String(signature).substring(0, 50)}`, 'error');
      throw new Error('Signature is not a valid hex string');
    }

    // ECDSA signatures: 64 bytes (r+s) or 65 bytes (r+s+v with recovery byte)
    // Privy raw_sign returns 64 bytes (r+s format)
    let sigLen = signature.length;

    // Don't add recovery byte - Canton may use raw r||s format
    this.log(`Sign OK: len=${sigLen}, sig=${signature.substring(0, 14)}...${signature.substring(sigLen - 8)}`, 'debug');

    return signature;
  }

  async submitTransaction(hash, signature, maxRetries = 5) {
    // Validate inputs
    if (!hash) {
      throw new Error('submitTransaction: hash is required');
    }
    if (!signature) {
      throw new Error('submitTransaction: signature is required');
    }

    // Convert signature to base64 if it's hex
    let signatureB64;
    if (signature.startsWith('0x')) {
      signatureB64 = Buffer.from(signature.slice(2), 'hex').toString('base64');
    } else if (signature.includes('+') || signature.includes('/') || signature.endsWith('=')) {
      // Already base64
      signatureB64 = signature;
    } else {
      // Assume hex without 0x prefix
      signatureB64 = Buffer.from(signature, 'hex').toString('base64');
    }

    // Debug: log full details for BAD SIGNATURE troubleshooting
    const hashLen = Buffer.from(hash, 'base64').length;
    const sigLen = Buffer.from(signatureB64, 'base64').length;
    this.log(`Submit: hashLen=${hashLen}B, sigLen=${sigLen}B, hash=${hash.substring(0, 20)}...`, 'debug');

    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetchWithProxy(`${API.supanova}/canton/api/submit_prepared`, {
          method: 'POST',
          headers: this.getSupanovaHeaders(),
          body: JSON.stringify({ hash, signature: signatureB64 })
        }, this.proxyUrl);

        if (!response.ok) {
          const errorText = await response.text();
          let errorDetail = '';

          try {
            const errorJson = JSON.parse(errorText);
            errorDetail = errorJson.message || errorJson.error || errorText;
          } catch {
            errorDetail = errorText;
          }

          // Check for retryable errors at submit level
          // NOTE: BAD SIGNATURE and 500 errors should NOT retry here - they need auth key refresh
          // which happens at allocate/unlock level
          const errorLower = errorDetail.toLowerCase();
          const isAuthError = errorLower.includes('signature') || errorLower.includes('unauthorized');

          const isRetryable = !isAuthError && (
            response.status === 429 || // Rate limit
            response.status === 503 || // Service unavailable
            response.status === 502 || // Bad gateway
            errorDetail.includes('STALE_CONTRACT') ||
            errorDetail.includes('CONTRACT_NOT_FOUND') ||
            errorDetail.includes('timeout')
          );

          lastError = new Error(`Submit failed (${response.status}): ${errorDetail.substring(0, 150)}`);

          if (isRetryable && attempt < maxRetries) {
            // Show truncated error reason
            const shortReason = errorDetail.substring(0, 60).replace(/\n/g, ' ');
            this.log(`Submit ${attempt}/${maxRetries} failed: ${shortReason}... retrying in ${attempt * 2}s`, 'error');
            await sleep(attempt * 2000);
            continue;
          }

          throw lastError;
        }

        return await response.json();
      } catch (error) {
        lastError = error;

        // Network errors are retryable
        const isNetworkError = error.message.includes('fetch') ||
          error.message.includes('network') ||
          error.message.includes('ECONNRESET') ||
          error.message.includes('ETIMEDOUT');

        if (isNetworkError && attempt < maxRetries) {
          this.log(`Submit ${attempt}/${maxRetries} network error: ${error.message.substring(0, 50)}`, 'error');
          await sleep(attempt * 2000);
          continue;
        }

        throw error;
      }
    }

    throw lastError || new Error('Submit failed after retries');
  }

  async createLockEntry(lockId, projectId, amount) {
    try {
      const response = await fetchWithProxy(`${API.base}/locks`, {
        method: 'POST',
        headers: this.getHectoHeaders(),
        body: JSON.stringify({
          lock_id: lockId,
          user_party_id: this.partyId,
          registrar: 'Hecto-Finance-1::12208ee00572aea3304ebb12e34320769ea4b421911c9b658a999e0e64ee8a070972',
          locker: 'Hecto-Finance-1::12208ee00572aea3304ebb12e34320769ea4b421911c9b658a999e0e64ee8a070972',
          amount: amount.toString(),
          context: projectId,
          instrument_id: 'HECTO',
          instrument_scheme: 'RegistrarInternalScheme',
          instrument_source: 'Hecto-Finance-1::12208ee00572aea3304ebb12e34320769ea4b421911c9b658a999e0e64ee8a070972'
        })
      }, this.proxyUrl);

      if (!response.ok) {
        // Lock entry is optional - it's just for tracking in Hecto's database
        // The actual lock happens on-chain via Canton
        this.log(`Lock entry skipped (${response.status}) - continuing with on-chain lock`, 'info');
        return null;
      }
      return await response.json();
    } catch (error) {
      // Non-critical - continue with on-chain transaction
      this.log(`Lock entry failed: ${error.message} - continuing`, 'info');
      return null;
    }
  }

  // Format amount with 10 decimal places (Canton standard)
  formatAmount(amount) {
    return parseFloat(amount).toFixed(10);
  }

  // Post lock event to Hecto API (browser does this at each step)
  async postLockEvent(lockId, eventType, result = 'success', extraFields = {}) {
    try {
      const body = {
        lock_id: lockId,
        recorded_by: this.partyId,
        recorded_by_role: 'user',
        event_type: eventType,
        result,
        ...extraFields
      };

      const response = await fetchWithProxy(`${API.base}/locks/event`, {
        method: 'POST',
        headers: this.getHectoHeaders(),
        body: JSON.stringify(body)
      }, this.proxyUrl);
      if (!response.ok) {
        this.log(`Lock event ${eventType} failed: ${response.status}`, 'error');
      }
    } catch (error) {
      this.log(`Lock event ${eventType} error: ${error.message}`, 'error');
    }
  }

  // Post transaction log to Hecto API
  async postTransactionLog(params) {
    try {
      const body = {
        tx_type: params.txType,
        sender_party: this.partyId,
        sender_type: 'user',
        wallet_name: 'Supanova',
        billing_system: 'cantara',
        reference_id: params.referenceId || params.lockId,
        command_id: params.commandId,
        update_id: params.updateId,
        user: this.partyId,
        amount: parseFloat(params.amount),
        currency: 'HECTO',
        daml_template_id: params.damlTemplateId || 'fab0408d92b1ca29783b3fff57f1c9b1f6c5e25fbe3355d2424b1cdc9869b2af:LockWithCommission:LockWithCommission',
        daml_choice: params.damlChoice,
        result: 'success',
        metadata: params.metadata || {},
        traffic_request: params.trafficRequest || 0,
        traffic_response: 0,
        traffic_total: params.trafficRequest || 0
      };

      const response = await fetchWithProxy(`${API.base}/transactions/log`, {
        method: 'POST',
        headers: this.getHectoHeaders(),
        body: JSON.stringify(body)
      }, this.proxyUrl);
      if (!response.ok) {
        this.log(`Transaction log failed: ${response.status}`, 'error');
      }
    } catch (error) {
      this.log(`Transaction log error: ${error.message}`, 'error');
    }
  }

  // Poll for transaction completion
  async queryCompletion(submissionId, maxAttempts = 90, intervalMs = 2000) {
    const encodedId = encodeURIComponent(submissionId);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await fetchWithProxy(`${API.supanova}/canton/api/query_completion?submissionId=${encodedId}`, {
          method: 'GET',
          headers: this.getSupanovaHeaders()
        }, this.proxyUrl);
        if (response.ok) {
          const body = await response.json();
          // Per HAR: { status: "completed"|"unknown"|"failed", data: { commandId, updateId }, message }
          const status = body.status || body.completionStatus?.status;
          const updateId =
            body.data?.updateId || body.data?.update_id ||
            body.updateId || body.update_id ||
            body.completionStatus?.updateId;

          if (status === 'failed') {
            throw new Error(`Canton tx failed: ${body.message || 'unknown failure'}`);
          }
          if (status === 'completed') {
            return updateId || 'completed';
          }
          if (updateId) {
            // Some deployments return updateId without status — treat as done
            return updateId;
          }
          // status === 'unknown' or missing > keep polling
        }
      } catch (error) {
        // Propagate terminal failures immediately
        if (error.message && error.message.startsWith('Canton tx failed')) throw error;
        // Otherwise retry on transient network errors
      }
      if (attempt < maxAttempts) {
        await sleep(intervalMs);
      }
    }
    this.log('Completion polling timed out', 'warning');
    return null;
  }

  // Build the FeePay_CC `targets` array (and matching `commissions` for legacy
  // templates) directly from the API's commissionPreapprovals payload. The Hecto
  // backend changed schema: it used to return 2 preapprovals (0.01 + 0.02), now
  // it can return 1 (0.03) — or any count in the future. We mirror exactly what
  // the API gives us so we always submit a valid fee structure.
  buildFeeTargets(allocationContext) {
    const list = allocationContext.commissionPreapprovals || [];
    return list.map((p, idx) => ({
      preapprovalCid: p.preapprovalCid,
      amount: typeof p.amount === 'string' && p.amount.length > 0
        ? p.amount
        : (idx === 0 ? '0.03' : '0.00'),
      description: null
    }));
  }

  buildCommissionEntries(allocationContext) {
    const list = allocationContext.commissionPreapprovals || [];
    return list.map((p, idx) => ({
      preapprovalCid: p.preapprovalCid,
      amount: typeof p.amount === 'string' && p.amount.length > 0
        ? p.amount
        : (idx === 0 ? '0.03' : '0.00'),
      description: p.description || (idx === 0 ? 'Lock commission payment' : 'Privy transaction signing fee')
    }));
  }

  buildLockCommand(params) {
    const { lockId, projectId, amount, holderServiceCid, lockWithCommissionCid, preapprovalCids, amuletInputCids, allocationContext } = params;
    const featuredAppRightCid = allocationContext.featuredAppRight?.contractId || null;

    return {
      commands: [{
        ExerciseCommand: {
          templateId: 'fab0408d92b1ca29783b3fff57f1c9b1f6c5e25fbe3355d2424b1cdc9869b2af:LockWithCommission:LockWithCommission',
          contractId: lockWithCommissionCid,
          choice: 'Execute_LockWithCommission',
          choiceArgument: {
            sender: this.partyId,
            holderServiceCid,
            registrar: 'Hecto-Finance-1::12208ee00572aea3304ebb12e34320769ea4b421911c9b658a999e0e64ee8a070972',
            locker: 'Hecto-Finance-1::12208ee00572aea3304ebb12e34320769ea4b421911c9b658a999e0e64ee8a070972',
            instrumentIdentifier: {
              source: 'Hecto-Finance-1::12208ee00572aea3304ebb12e34320769ea4b421911c9b658a999e0e64ee8a070972',
              id: 'HECTO',
              scheme: 'RegistrarInternalScheme'
            },
            amount: this.formatAmount(amount),
            context: projectId,
            holdingLabel: 'main',
            reference: lockId,
            batch: { id: `lock-${Date.now()}`, size: 1 },
            commissions: this.buildCommissionEntries(allocationContext),
            amuletInputs: amuletInputCids,
            commissionContext: {
              amuletRules: allocationContext.amuletRulesCid,
              context: {
                openMiningRound: allocationContext.openRoundCid,
                issuingMiningRounds: [],
                validatorRights: [],
                featuredAppRight: featuredAppRightCid
              }
            }
          }
        }
      }]
    };
  }

  buildUnlockCommand(params) {
    const { lockId, projectId, amount, holderServiceCid, lockWithCommissionCid, preapprovalCids, amuletInputCids, allocationContext, batchId } = params;
    const featuredAppRightCid = allocationContext.featuredAppRight?.contractId || null;

    return {
      commands: [{
        ExerciseCommand: {
          templateId: 'fab0408d92b1ca29783b3fff57f1c9b1f6c5e25fbe3355d2424b1cdc9869b2af:LockWithCommission:LockWithCommission',
          contractId: lockWithCommissionCid,
          choice: 'Execute_UnlockWithCommission',
          choiceArgument: {
            sender: this.partyId,
            holderServiceCid,
            registrar: 'Hecto-Finance-1::12208ee00572aea3304ebb12e34320769ea4b421911c9b658a999e0e64ee8a070972',
            locker: 'Hecto-Finance-1::12208ee00572aea3304ebb12e34320769ea4b421911c9b658a999e0e64ee8a070972',
            instrumentIdentifier: {
              source: 'Hecto-Finance-1::12208ee00572aea3304ebb12e34320769ea4b421911c9b658a999e0e64ee8a070972',
              id: 'HECTO',
              scheme: 'RegistrarInternalScheme'
            },
            amount: this.formatAmount(amount),
            lockContext: projectId,
            holdingLabel: 'main',
            reference: lockId,
            batch: { id: batchId || `lock-${Date.now()}`, size: 1 },
            commissions: this.buildCommissionEntries(allocationContext),
            amuletInputs: amuletInputCids,
            commissionContext: {
              amuletRules: allocationContext.amuletRulesCid,
              context: {
                openMiningRound: allocationContext.openRoundCid,
                issuingMiningRounds: [],
                validatorRights: [],
                featuredAppRight: featuredAppRightCid
              }
            }
          }
        }
      }]
    };
  }

  // Build disclosed contracts for the new single-tx reallocate flow.
  // Differs from buildDisclosedContracts() by OMITTING LOCK_WITH_COMMISSION_CONTRACT,
  // which is not referenced by the LockController:ProcessLockUnlockRequests choice
  // and is rejected (or at best ignored) by the new template.
  buildReallocateDisclosedContracts(allocationContext) {
    const disclosedContracts = [];
    const syncDomain = allocationContext.synchronizerId;

    if (allocationContext.amuletRules) {
      disclosedContracts.push({
        contractId: allocationContext.amuletRules.contractId,
        templateId: allocationContext.amuletRules.templateId,
        createdEventBlob: allocationContext.amuletRules.createdEventBlob,
        synchronizerId: syncDomain
      });
    }

    if (allocationContext.openMiningRound) {
      disclosedContracts.push({
        contractId: allocationContext.openMiningRound.contractId,
        templateId: allocationContext.openMiningRound.templateId,
        createdEventBlob: allocationContext.openMiningRound.createdEventBlob,
        synchronizerId: syncDomain
      });
    }

    if (allocationContext.featuredAppRight) {
      disclosedContracts.push({
        contractId: allocationContext.featuredAppRight.contractId,
        templateId: allocationContext.featuredAppRight.templateId,
        createdEventBlob: allocationContext.featuredAppRight.createdEventBlob,
        synchronizerId: allocationContext.featuredAppRight.synchronizerId || syncDomain
      });
    }

    if (allocationContext.commissionPreapprovals) {
      for (const preapproval of allocationContext.commissionPreapprovals) {
        if (preapproval.disclosedContract) {
          disclosedContracts.push({
            contractId: preapproval.disclosedContract.contractId,
            templateId: preapproval.disclosedContract.templateId,
            createdEventBlob: preapproval.disclosedContract.createdEventBlob,
            synchronizerId: preapproval.disclosedContract.synchronizerId || syncDomain
          });
        }
      }
    }

    return disclosedContracts;
  }

  // Fetch the user's active LockController contract.
  // LockController is the on-chain contract that tracks what's currently locked
  // and the `ProcessLockUnlockRequests` choice on it lets us move the allocation
  // between companies in a SINGLE transaction (VoteUnlock old + VoteLock new)
  // instead of the old 2-tx flow (unlock, then allocate).
  async getLockController() {
    // Cache-buster: the Canton HAR shows 304s when the browser uses If-None-Match.
    // Our fetch doesn't set that header, but some intermediaries still cache,
    // so we append a harmless query param to force a fresh response.
    const templateId = '#hecto-lock-v1:Lock:LockController';
    const encodedTemplateId = encodeURIComponent(templateId);
    const url = `${API.supanova}/canton/api/active_contracts?templateIds=${encodedTemplateId}&_t=${Date.now()}`;
    const response = await fetchWithProxy(url, {
      method: 'GET',
      headers: {
        ...this.getSupanovaHeaders(),
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    }, this.proxyUrl);
    if (!response.ok) return null;
    const contracts = await response.json();
    if (!Array.isArray(contracts) || contracts.length === 0) return null;

    // If user has multiple LockControllers (can happen after partial-tx
    // residue or migration), pick the one with active allocations. Falling
    // back to contracts[0] when none have allocations means we just return
    // any of them — but this case is rare and the caller will detect "no
    // allocations" and switch to fresh allocate().
    if (contracts.length > 1) {
      const withAllocs = contracts.filter(c => {
        const allocs = c?.createArgument?.allocations;
        return Array.isArray(allocs) && allocs.length > 0;
      });
      if (withAllocs.length > 0) {
        // Prefer the one with the biggest total locked amount (most recent
        // active allocation typically wins when there are duplicates).
        withAllocs.sort((a, b) => {
          const sum = (c) => (c.createArgument.allocations || [])
            .reduce((s, x) => s + parseFloat(x.amount || '0'), 0);
          return sum(b) - sum(a);
        });
        this.log(`getLockController: ${contracts.length} LCs found, picked one with ${withAllocs[0].createArgument.allocations.length} alloc(s)`, 'debug');
        return withAllocs[0];
      }
    }
    return contracts[0];
  }

  buildReallocateCommand(params) {
    const {
      lockControllerCid,
      fromContext,
      toContext,
      amount,
      preapprovalCids,
      amuletInputCids,
      allocationContext
    } = params;
    const featuredAppRightCid = allocationContext.featuredAppRight?.contractId || null;
    const amountStr = this.formatAmount(amount);

    return {
      commands: [{
        ExerciseCommand: {
          // Template matches HAR: Lock:LockController (same packageId as LockService)
          templateId: 'd66a3f4b41cc77487f8481f7a9d1bc5da337ee836292ffc41a0240c6023f8fc2:Lock:LockController',
          contractId: lockControllerCid,
          choice: 'ProcessLockUnlockRequests',
          choiceArgument: {
            requests: [
              { context: fromContext, amount: amountStr, direction: 'VoteUnlock' },
              { context: toContext, amount: amountStr, direction: 'VoteLock' }
            ],
            fees: {
              inputAmulets: amuletInputCids,
              inputHoldings: [],
              operations: [{
                tag: 'FeePay_CC',
                value: {
                  targets: this.buildFeeTargets(allocationContext),
                  amuletRulesCid: allocationContext.amuletRulesCid,
                  openMiningRoundCid: allocationContext.openRoundCid,
                  featuredAppRightCid
                }
              }]
            }
          }
        }
      }]
    };
  }

  // Build disclosed contracts for the new Lock:LockService:LockHoldings choice.
  // Uses LockService (NOT LockWithCommission) plus the shared splice contracts from
  // allocation-context (AmuletRules, OpenMiningRound, FeaturedAppRight, TransferPreapprovals).
  buildNewLockDisclosedContracts(allocationContext, lockService) {
    const disclosedContracts = [];
    const syncDomain = allocationContext.synchronizerId;

    disclosedContracts.push({
      contractId: lockService.contractId,
      templateId: lockService.templateId,
      createdEventBlob: lockService.createdEventBlob,
      synchronizerId: syncDomain
    });

    if (allocationContext.amuletRules) {
      disclosedContracts.push({
        contractId: allocationContext.amuletRules.contractId,
        templateId: allocationContext.amuletRules.templateId,
        createdEventBlob: allocationContext.amuletRules.createdEventBlob,
        synchronizerId: syncDomain
      });
    }

    if (allocationContext.openMiningRound) {
      disclosedContracts.push({
        contractId: allocationContext.openMiningRound.contractId,
        templateId: allocationContext.openMiningRound.templateId,
        createdEventBlob: allocationContext.openMiningRound.createdEventBlob,
        synchronizerId: syncDomain
      });
    }

    if (allocationContext.featuredAppRight) {
      disclosedContracts.push({
        contractId: allocationContext.featuredAppRight.contractId,
        templateId: allocationContext.featuredAppRight.templateId,
        createdEventBlob: allocationContext.featuredAppRight.createdEventBlob,
        synchronizerId: allocationContext.featuredAppRight.synchronizerId || syncDomain
      });
    }

    if (allocationContext.commissionPreapprovals) {
      for (const preapproval of allocationContext.commissionPreapprovals) {
        if (preapproval.disclosedContract) {
          disclosedContracts.push({
            contractId: preapproval.disclosedContract.contractId,
            templateId: preapproval.disclosedContract.templateId,
            createdEventBlob: preapproval.disclosedContract.createdEventBlob,
            synchronizerId: preapproval.disclosedContract.synchronizerId || syncDomain
          });
        }
      }
    }

    return disclosedContracts;
  }

  // Build the ExerciseCommand for the new Lock:LockService:LockHoldings choice.
  // This is the first-allocation path now; it creates a LockController + allocation in one tx.
  // `lockId` is a UUIDv7 used as the lock context and in the commandId (`modern-lock-<lockId>`).
  buildNewLockCommand(params) {
    const {
      lockId, projectId, amount,
      lockService,
      holdingCids,
      preapprovalCids,
      amuletInputCids,
      allocationContext
    } = params;
    const featuredAppRightCid = allocationContext.featuredAppRight?.contractId || null;
    const amountStr = this.formatAmount(amount);

    return {
      commands: [{
        ExerciseCommand: {
          templateId: lockService.templateId,
          contractId: lockService.contractId,
          choice: 'LockHoldings',
          choiceArgument: {
            owner: this.partyId,
            holdingCids,
            amount: amountStr,
            instrumentId: {
              source: 'Hecto-Finance-1::12208ee00572aea3304ebb12e34320769ea4b421911c9b658a999e0e64ee8a070972',
              id: 'HECTO',
              scheme: 'RegistrarInternalScheme'
            },
            context: lockId,
            allocations: [
              { context: projectId, amount: amountStr }
            ],
            fees: {
              inputAmulets: amuletInputCids,
              inputHoldings: [],
              operations: [{
                tag: 'FeePay_CC',
                value: {
                  targets: this.buildFeeTargets(allocationContext),
                  amuletRulesCid: allocationContext.amuletRulesCid,
                  openMiningRoundCid: allocationContext.openRoundCid,
                  featuredAppRightCid
                }
              }]
            }
          }
        }
      }]
    };
  }

  // Single-transaction reallocate (unlock + lock in one go).
  // Returns { updateId, fromContext, toContext, amount } on success, or throws.
  async reallocateOneTx(fromContext, toContext, amount) {
    await this.getUserAuthorizationKey();

    // Idempotency pre-check: maybe a previous attempt actually succeeded
    // (queryCompletion timed out but tx landed). Hit LockController FIRST
    // so we don't waste another tx (or worse, end up double-paying fees).
    const preLc = await this.getLockController();
    const preAllocs = preLc?.createArgument?.allocations || [];
    if (preAllocs.length > 0 && preAllocs[0].context === toContext) {
      this.log('Pre-check: already on target, skipping tx', 'success');
      this.currentAllocation = toContext;
      return { updateId: 'already_on_target', fromContext, toContext, amount };
    }

    const allocationContext = await this.getAllocationContext();
    const disclosedContracts = this.buildReallocateDisclosedContracts(allocationContext);

    const amulets = await this.getAmuletContracts();
    if (amulets.length === 0) throw new Error('No Amulet contracts available for fees');

    if (!preLc || !preLc.contractId) {
      throw new Error('LockController not found - user has no active lock to reallocate from');
    }
    const lockController = preLc;

    const preapprovalCids = allocationContext.commissionPreapprovals?.map(p => p.preapprovalCid) || [];
    if (preapprovalCids.length < 1) {
      throw new Error(`Need at least 1 commission preapproval, got ${preapprovalCids.length}`);
    }

    const commandId = `modern-lock-rebalance-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const command = this.buildReallocateCommand({
      lockControllerCid: lockController.contractId,
      fromContext,
      toContext,
      amount,
      preapprovalCids,
      amuletInputCids: amulets.map(a => a.contractId),
      allocationContext
    });

    const preparedTx = await this.prepareCantonTransaction(
      command.commands,
      disclosedContracts,
      commandId
    );

    const signature = await this.signTransaction(preparedTx.hash);
    const submitResult = await this.submitTransaction(preparedTx.hash, signature);
    const submissionId = submitResult?.submissionId || submitResult;

    if (!submissionId || typeof submissionId !== 'string') {
      throw new Error(`Submit did not return submissionId (got: ${JSON.stringify(submitResult).substring(0, 100)})`);
    }

    // Faster polling: 1s interval × 60 attempts = 60s max (was 2s × 90 = 180s).
    // Tx confirmation on Canton typically lands in 3-15s when the network
    // isn't congested, so 60s is plenty and frees the worker much sooner.
    const updateId = await this.queryCompletion(submissionId, 60, 1000);
    if (!updateId) {
      // Polling timed out. The TX may still have landed — verify via the
      // authoritative on-chain LockController, NOT /api/locks (which is stale
      // for the new template).
      await sleep(2000);
      try {
        const verifyLc = await this.getLockController();
        const verifyAllocs = verifyLc?.createArgument?.allocations || [];
        if (verifyAllocs.length > 0 && verifyAllocs[0].context === toContext) {
          this.log('Reallocate verified via LockController despite polling timeout', 'success');
          this.currentAllocation = toContext;
          return { updateId: 'completed_verified_via_chain', fromContext, toContext, amount };
        }
      } catch (verifyErr) {
        this.log(`Post-timeout verify failed: ${verifyErr.message}`, 'error');
      }
      throw new Error('Reallocate completion polling timed out and could not be verified on-chain');
    }

    this.currentAllocation = toContext;
    return { updateId, fromContext, toContext, amount };
  }

  async allocate(projectId, amount, retryCount = 0) {
    const maxRetries = settings.retryAttempts;

    try {
      const nowUtc = dayjs.utc();
      const nowInConfiguredTz = nowUtc.tz(getConfiguredTimezone());
      this.log(`Allocate trigger time: ${nowInConfiguredTz.format('YYYY-MM-DD HH:mm:ss')} (${getConfiguredTimezone()}) | UTC ${nowUtc.format('YYYY-MM-DD HH:mm:ss')}`, 'info');

      if (settings.scheduleTime) {
        const nextScheduleInTz = getNextScheduleTimeWIB(settings);
        this.log(`Configured schedule (${getConfiguredTimezone()}): ${settings.scheduleTime} | next run ${nextScheduleInTz.format('YYYY-MM-DD HH:mm:ss')}`, 'info');
      }

      await this.getUserAuthorizationKey();

      // Guard: reject if legacy LockWithCommission contracts still hold this wallet's funds.
      // Attempting to allocate with the new template while the old lock is active
      // would fail on-chain and burn CC fees. User must manually release via web UI.
      const legacyCount = await this.checkLegacyLockedHoldings();
      if (legacyCount > 0) {
        throw new Error(`LEGACY_LOCK_PRESENT: ${legacyCount} deprecated LockWithCommission contract(s) active. Release funds manually via Hecto web UI before bot can allocate.`);
      }

      const allocationContext = await this.getAllocationContext();

      const lockService = await this.getLockServiceContract();
      if (!lockService || !lockService.contractId) throw new Error('LockService contract not available');

      const holdings = await this.getHoldingContracts();
      if (!holdings || holdings.length === 0) throw new Error('No unlocked Holding contracts (balance may already be locked)');

      const amulets = await this.getAmuletContracts();
      if (amulets.length === 0) throw new Error('No Amulet contracts');

      const preapprovalCids = allocationContext.commissionPreapprovals?.map(p => p.preapprovalCid) || [];
      if (preapprovalCids.length < 1) {
        throw new Error(`Need at least 1 commission preapproval, got ${preapprovalCids.length}`);
      }

      const lockId = generateUUIDv7();
      const commandId = `modern-lock-${lockId}`;

      const disclosedContracts = this.buildNewLockDisclosedContracts(allocationContext, lockService);

      const command = this.buildNewLockCommand({
        lockId, projectId, amount,
        lockService,
        holdingCids: holdings.map(h => h.contractId),
        preapprovalCids,
        amuletInputCids: amulets.map(a => a.contractId),
        allocationContext
      });

      // Step 1: Prepare transaction
      const preparedTx = await this.prepareCantonTransaction(command.commands, disclosedContracts, commandId);

      // Step 2: Sign transaction
      const signature = await this.signTransaction(preparedTx.hash);

      // Step 3: Submit transaction
      const submitResult = await this.submitTransaction(preparedTx.hash, signature);
      const submissionId = submitResult?.submissionId || submitResult?.submission_id;
      if (!submissionId || typeof submissionId !== 'string') {
        throw new Error(`Submit did not return submissionId (got: ${JSON.stringify(submitResult).substring(0, 120)})`);
      }
      this.log(`Submit OK, submissionId=${submissionId.substring(0, 20)}...`, 'info');

      // Step 4: Poll for completion (must poll with submissionId, NOT commandId)
      let updateId = await this.queryCompletion(submissionId, 90, 2000);

      if (!updateId) {
        this.log('Polling timed out! Verifying lock state...', 'warning');
        await sleep(5000);
        await this.getBalance();
        // Verify via on-chain LockController (new template's source of truth)
        const lc = await this.getLockController();
        const allocations = lc?.createArgument?.allocations || [];
        const isLocked = allocations.some(a => a.context === projectId);

        if (isLocked) {
          this.log(`Lock verified via LockController despite timeout!`, 'success');
          updateId = 'completed_verified_via_chain';
        } else if (this.balance < amount) {
          this.log(`Balance decreased despite timeout! Assuming success.`, 'success');
          updateId = 'completed_verified_via_balance';
        } else {
          throw new Error('Completion polling timed out and lock could not be verified');
        }
      }

      // Step 5: Post transaction log (new template metadata so Hecto UI reflects allocation)
      await this.postTransactionLog({
        txType: 'hecto_lock_holdings',
        referenceId: lockId,
        commandId,
        updateId,
        amount,
        damlTemplateId: lockService.templateId,
        damlChoice: 'LockHoldings',
        metadata: {
          allocations: [{ context: projectId, amount: this.formatAmount(amount) }]
        },
        trafficRequest: preparedTx.costEstimation?.totalTrafficCostEstimation || 0
      });

      this.currentAllocation = projectId;
      this.log(`Lock completed! ID: ${lockId}`, 'success');
      return { lockId, amount, projectId, status: 'completed' };
    } catch (error) {
      const errorMsg = error.message || '';

      // Legacy lock guard - NOT retryable; user must release funds manually.
      if (errorMsg.includes('LEGACY_LOCK_PRESENT')) {
        this.log(errorMsg, 'error');
        throw error;
      }

      // Retryable errors - refetch contracts and try again
      const isContractError =
        errorMsg.includes('CONTRACT_NOT_FOUND') ||
        errorMsg.includes('STALE_CONTRACT') ||
        errorMsg.includes('CONTRACT_KEY_NOT_FOUND');

      // Submit/network errors that need fresh context
      const errorLower = errorMsg.toLowerCase();
      const isSubmitError =
        errorMsg.includes('Submit failed') ||
        errorMsg.includes('ALREADY_EXISTS') ||
        errorMsg.includes('INCONSISTENT') ||
        errorMsg.includes('timed out');

      // Auth errors that need new authorization key
      const isAuthError =
        errorLower.includes('signature') ||
        errorLower.includes('unauthorized') ||
        errorMsg.includes('403') ||
        errorMsg.includes('401');

      // Insufficient CC balance - NOT retryable
      const isInsufficientFunds =
        errorMsg.includes('INSUFFICIENT') ||
        errorMsg.includes('insufficient') ||
        errorMsg.includes('not enough');

      if (isInsufficientFunds) {
        this.log(`Insufficient CC balance for fees. Need at least 0.03 CC.`, 'error');
        throw new Error('Insufficient CC balance for transaction fees');
      }

      if ((isContractError || isSubmitError || isAuthError) && retryCount < maxRetries) {
        const waitTime = settings.retryDelayMs * (retryCount + 1);
        const errorType = isAuthError ? 'Auth' : isContractError ? 'Contract' : 'Submit';
        this.log(`${errorType} error, retrying (${retryCount + 1}/${maxRetries}) in ${waitTime / 1000}s...`, 'info');
        await sleep(waitTime);

        // For auth errors (BAD SIGNATURE, etc), try alternate wallet first
        if (isAuthError || errorMsg.includes('500')) {
          // If account has multiple wallets, try the next one
          if (this.allWalletIds.length > 1) {
            const currentIdx = this.allWalletIds.indexOf(this.walletId);
            const nextIdx = (currentIdx + 1) % this.allWalletIds.length;
            const nextWalletId = this.allWalletIds[nextIdx];
            this.log(`BAD SIGNATURE: Switching wallet ${this.walletId.substring(0, 8)}... > ${nextWalletId.substring(0, 8)}... (${nextIdx + 1}/${this.allWalletIds.length})`, 'info');
            this.walletId = nextWalletId;
            this.saveTokens();
          }

          this.log('Refreshing Privy token and authorization key...', 'info');

          // Try to refresh Privy token first
          const tokenRefreshed = await this.refreshPrivyToken(1);
          if (!tokenRefreshed) {
            this.log('Token refresh failed, trying with existing token...', 'error');
          }

          // Reset auth key so it gets fetched fresh (but KEEP walletId - we just switched it)
          this.authorizationKey = null;
        }

        return this.allocate(projectId, amount, retryCount + 1);
      }

      // Log full error for debugging
      this.log(`Allocate failed: ${errorMsg.substring(0, 100)}`, 'error');
      throw error;
    }
  }

  async unlock(lockId, projectId, amount, retryCount = 0) {
    const maxRetries = settings.retryAttempts;

    try {
      // Generate separate unlock reference ID (as browser does)
      const unlockReferenceId = generateUUIDv7();
      const batchId = `lock-${Date.now()}`;
      const commandId = `unlock_offer:${unlockReferenceId}`;

      // Step 1: Post unlock_created event
      await this.postLockEvent(lockId, 'unlock_created', 'success', {
        metadata: { batchId, unlockReferenceId }
      });

      await this.getUserAuthorizationKey();

      const allocationContext = await this.getAllocationContext();
      const disclosedContracts = this.buildDisclosedContracts(allocationContext);

      const holderService = await this.getHolderService();
      if (!holderService) throw new Error('HolderService not found');

      const amulets = await this.getAmuletContracts();
      const preapprovalCids = allocationContext.commissionPreapprovals?.map(p => p.preapprovalCid) || [];

      // Step 2: Post unlock_offer_prepared event
      await this.postLockEvent(lockId, 'unlock_offer_prepared', 'success');

      const command = this.buildUnlockCommand({
        lockId, projectId, amount,
        holderServiceCid: holderService.contractId,
        lockWithCommissionCid: LOCK_WITH_COMMISSION_CONTRACT.contractId,
        preapprovalCids,
        amuletInputCids: amulets.map(a => a.contractId),
        allocationContext,
        batchId
      });

      // Step 3: Prepare transaction
      const preparedTx = await this.prepareCantonTransaction(command.commands, disclosedContracts, commandId);

      // Step 4: Sign transaction
      const signature = await this.signTransaction(preparedTx.hash);

      // Step 5: Submit transaction
      const submitResult = await this.submitTransaction(preparedTx.hash, signature);
      const submissionId = submitResult?.submissionId || submitResult?.submission_id;
      if (!submissionId || typeof submissionId !== 'string') {
        throw new Error(`Submit did not return submissionId (got: ${JSON.stringify(submitResult).substring(0, 120)})`);
      }
      this.log(`Submit OK, submissionId=${submissionId.substring(0, 20)}...`, 'info');

      // Step 6: Post unlock_offer_submitted event
      await this.postLockEvent(lockId, 'unlock_offer_submitted', 'success');

      // Step 7: Poll for completion (must poll with submissionId, NOT commandId)
      let updateId = await this.queryCompletion(submissionId, 90, 2000);

      if (!updateId) {
        this.log('Polling timed out! Verifying unlock state...', 'warning');
        await sleep(5000); // Wait a bit for backend to sync
        await this.getBalance();

        if (this.balance > 0) {
          this.log('Unlock verified via returned balance despite timeout!', 'success');
          updateId = 'completed_verified_via_balance';
        } else {
          const existingLocks = await this.getExistingLocks();
          const activeLocks = (existingLocks || []).filter(l => l.status === 'locked');
          const stillLocked = activeLocks.some(l => {
            const ld = l.lock || l;
            return ld.lock_id === lockId;
          });

          if (!stillLocked) {
            this.log('Unlock verified via DB despite timeout!', 'success');
            updateId = 'completed_verified_via_db';
          } else {
            throw new Error('Completion polling timed out and unlock could not be verified');
          }
        }
      }

      // Step 8: Post unlock_offer_completed event
      await this.postLockEvent(lockId, 'unlock_offer_completed', 'success', {
        update_id: updateId
      });

      // Step 9: Post transaction log
      await this.postTransactionLog({
        txType: 'unlock_offer_create',
        lockId,
        commandId,
        updateId,
        amount,
        damlChoice: 'Execute_UnlockWithCommission',
        metadata: { batchId, companyId: projectId },
        trafficRequest: preparedTx.costEstimation?.totalTrafficCostEstimation || 0
      });

      this.log(`Unlock completed! Lock ID: ${lockId}`, 'success');
      return { lockId, unlockReferenceId, status: 'unlocked' };
    } catch (error) {
      const errorMsg = error.message || '';
      const errorLower = errorMsg.toLowerCase();

      // Contract errors
      const isContractError =
        errorMsg.includes('CONTRACT_NOT_FOUND') ||
        errorMsg.includes('STALE_CONTRACT');

      // Submit errors
      const isSubmitError =
        errorMsg.includes('Submit failed') ||
        errorMsg.includes('INCONSISTENT') ||
        errorMsg.includes('timed out');

      // Auth errors that need new authorization key
      const isAuthError =
        errorLower.includes('signature') ||
        errorLower.includes('unauthorized') ||
        errorMsg.includes('403') ||
        errorMsg.includes('401');

      const isRetryable = isContractError || isSubmitError || isAuthError;

      if (isRetryable && retryCount < maxRetries) {
        const waitTime = settings.retryDelayMs * (retryCount + 1);
        const errorType = isAuthError ? 'Auth' : isContractError ? 'Contract' : 'Submit';
        this.log(`Unlock ${errorType} error, retrying (${retryCount + 1}/${maxRetries}) in ${waitTime / 1000}s...`, 'info');
        await sleep(waitTime);

        // For auth errors, try alternate wallet first, then refresh token
        if (isAuthError || errorMsg.includes('500')) {
          // If account has multiple wallets, try the next one
          if (this.allWalletIds.length > 1) {
            const currentIdx = this.allWalletIds.indexOf(this.walletId);
            const nextIdx = (currentIdx + 1) % this.allWalletIds.length;
            const nextWalletId = this.allWalletIds[nextIdx];
            this.log(`BAD SIGNATURE: Switching wallet ${this.walletId.substring(0, 8)}... > ${nextWalletId.substring(0, 8)}... (${nextIdx + 1}/${this.allWalletIds.length})`, 'info');
            this.walletId = nextWalletId;
            this.saveTokens();
          }

          this.log('Refreshing Privy token and authorization key...', 'info');

          // Try to refresh Privy token first
          const tokenRefreshed = await this.refreshPrivyToken(1);
          if (!tokenRefreshed) {
            this.log('Token refresh failed, trying with existing token...', 'error');
          }

          // Reset auth key so it gets fetched fresh (but KEEP walletId - we just switched it)
          this.authorizationKey = null;
        }

        return this.unlock(lockId, projectId, amount, retryCount + 1);
      }

      this.log(`Unlock failed: ${errorMsg.substring(0, 100)}`, 'error');
      throw error;
    }
  }

  async reallocate(newProjectId) {
    // Always refresh balance first to get latest state
    await this.getBalance();

    // Under the new template, allocation state lives on the LockController contract
    // (createArgument.allocations) — NOT in /api/locks. Reading from /api/locks gives
    // stale/empty data for new-template allocations, so we use LockController as the
    // authoritative source.
    const lockController = await this.getLockController();
    const lcAllocations = lockController?.createArgument?.allocations || [];
    const totalLockedFromChain = lcAllocations.reduce((sum, a) => sum + parseFloat(a.amount || '0'), 0);
    const onChainLocked = this.lockedBalance || 0;

    this.log(`Balance: unlocked=${this.balance} locked=${onChainLocked} (LockController allocs: ${lcAllocations.length}, total: ${totalLockedFromChain}), CC: ${this.ccBalance.toFixed(3)}`, 'info');

    // API actual fee = 0.03 CC (single preapproval). Keep tight buffer so
    // accounts with ~0.04 CC still rebalance instead of being silently skipped.
    const MIN_CC_FOR_REALLOC = 0.04;
    const MIN_CC_FOR_ALLOC = 0.03;

    // No LockController = no active allocation. Allocate fresh if we have unlocked balance.
    if (!lockController || lcAllocations.length === 0) {
      if (this.balance <= 0) {
        this.log('No balance available to allocate', 'error');
        return null;
      }

      if (this.ccBalance < MIN_CC_FOR_ALLOC) {
        this.log(`Insufficient CC balance (${this.ccBalance.toFixed(4)} < ${MIN_CC_FOR_ALLOC}). Need CC for tx fees.`, 'error');
        return null;
      }

      this.log(`No active LockController, allocating ${this.balance} HECTO fresh`, 'info');
      return this.allocate(newProjectId, this.balance);
    }

    // LockController exists — typically one allocation at a time in Hecto's flow.
    // Use the first (and usually only) allocation as the reallocation source.
    const currentAllocation = lcAllocations[0];
    const lockedAmount = parseFloat(currentAllocation.amount);
    const currentCompanyId = currentAllocation.context;
    const currentCompanyName = KNOWN_COMPANIES[currentCompanyId] || currentCompanyId;
    const targetCompanyName = KNOWN_COMPANIES[newProjectId] || newProjectId;

    this.log(`Current: ${lockedAmount} HECTO locked to ${currentCompanyName}`, 'info');

    // Check if already allocated to target company
    if (currentCompanyId === newProjectId) {
      // Check if we have TRULY extra unlocked balance to allocate
      // Only allocate if unlocked balance exceeds a meaningful threshold
      // AND it's not just the same balance being reported incorrectly
      if (this.balance > 0.1) {
        // Safety: verify the unlocked balance is genuinely new tokens,
        // not the same locked tokens being double-counted
        // If on-chain locked >= what DB says is locked, the unlocked is genuine
        if (onChainLocked < lockedAmount * 0.9) {
          // On-chain says less is locked than DB thinks > inconsistency
          // The "unlocked" balance might actually be the locked tokens
          this.log(`Balance inconsistency: DB says ${lockedAmount} locked, chain says ${onChainLocked} locked. Skipping to be safe.`, 'error');
          this.currentAllocation = newProjectId;
          return null;
        }

        if (this.ccBalance < MIN_CC_FOR_ALLOC) {
          this.log(`Want to add ${this.balance} HECTO but insufficient CC (${this.ccBalance.toFixed(4)})`, 'error');
          return null;
        }
        this.log(`Same company (${targetCompanyName}), adding ${this.balance} more HECTO (on-chain locked: ${onChainLocked})`, 'info');
        return this.allocate(newProjectId, this.balance);
      }
      this.log(`Already allocated ${lockedAmount} HECTO to ${targetCompanyName}, nothing to do`, 'success');
      this.currentAllocation = newProjectId;
      return null;
    }

    // Need to switch company - single transaction reallocate (ProcessLockUnlockRequests)
    if (this.ccBalance < MIN_CC_FOR_REALLOC) {
      this.log(`Need to switch but insufficient CC (${this.ccBalance.toFixed(4)} < ${MIN_CC_FOR_REALLOC}). Keeping current allocation.`, 'error');
      return null;
    }

    this.log(`Reallocating ${lockedAmount} HECTO: ${currentCompanyName} -> ${targetCompanyName} (single tx)...`, 'info');

    const MAX_REALLOC_RETRIES = 20;
    let lastError = null;
    // Track the "live" source context and amount — these may change after retries
    // because another account's reallocate can update the LockController.
    let liveFromContext = currentCompanyId;
    let liveAmount = lockedAmount;

    for (let attempt = 1; attempt <= MAX_REALLOC_RETRIES; attempt++) {
      try {
        const result = await this.reallocateOneTx(liveFromContext, newProjectId, liveAmount);
        this.log(`Reallocate completed: ${liveAmount} HECTO moved to ${targetCompanyName} (updateId: ${String(result.updateId).substring(0, 20)}...)`, 'success');
        return {
          amount: liveAmount,
          projectId: newProjectId,
          fromProjectId: liveFromContext,
          updateId: result.updateId,
          status: 'completed'
        };
      } catch (error) {
        lastError = error;
        this.log(`Reallocate attempt ${attempt}/${MAX_REALLOC_RETRIES} failed: ${error.message}`, 'error');

        const errMsg = error.message || '';
        const errMsgLower = errMsg.toLowerCase();
        const isBadSignature = errMsgLower.includes('bad signature') || errMsgLower.includes('signature');
        const isServerError = errMsg.includes('500');
        const isAuthError = isBadSignature || errMsg.includes('401') || errMsg.includes('403');
        const isInsufficient = errMsgLower.includes('insufficient') && !errMsg.includes('preapproval');

        if (isInsufficient) {
          // Not retryable — user needs more CC
          break;
        }

        if (attempt < MAX_REALLOC_RETRIES) {
          // FAST retry — we're racing against time to rebalance. Tight 1–2s
          // window with light jitter so parallel accounts don't hammer the API
          // in lockstep. Auth errors get a slightly longer pause (token refresh
          // needs a moment to propagate).
          const baseMs = isAuthError ? 1500 : 1000;
          const jitterMs = Math.floor(Math.random() * 1000);
          const waitMs = baseMs + jitterMs;
          this.log(`Waiting ${(waitMs / 1000).toFixed(1)}s before retry (refreshing all context)...`, 'info');
          await sleep(waitMs);

          // BAD SIGNATURE / 500 / auth error recovery: rotate wallet (if multi),
          // force-fresh auth key, refresh Privy token. This matches the recovery
          // path in allocate() that's been proven effective.
          if (isAuthError || isServerError) {
            // Rotate to next wallet if account has multiple Privy wallets
            if (Array.isArray(this.allWalletIds) && this.allWalletIds.length > 1) {
              const currentIdx = this.allWalletIds.indexOf(this.walletId);
              const nextIdx = (currentIdx + 1) % this.allWalletIds.length;
              const nextWalletId = this.allWalletIds[nextIdx];
              this.log(`BAD SIGNATURE: rotating wallet ${String(this.walletId).substring(0, 8)} > ${nextWalletId.substring(0, 8)} (${nextIdx + 1}/${this.allWalletIds.length})`, 'info');
              this.walletId = nextWalletId;
              try { this.saveTokens(); } catch { }
            }

            // Force-refresh authorization key while PRESERVING the rotated walletId.
            // getUserAuthorizationKey(true) now respects walletId that's in allWalletIds.
            this.authorizationKey = null;
            try {
              await this.refreshPrivyToken(1);
            } catch (refreshErr) {
              this.log(`Token refresh on retry failed: ${refreshErr.message}`, 'error');
            }
            // Always force-refresh auth key but preserve the rotated wallet
            try {
              await this.getUserAuthorizationKey(true);
            } catch (akErr) {
              this.log(`Auth key refresh failed: ${akErr.message}`, 'error');
            }
          }

          // ALWAYS re-fetch balance + LockController on retry — contract IDs
          // change after any account's reallocate, so even non-contract errors
          // need fresh context. Tolerate transient fetch failures by treating
          // them as a soft retry (don't bail the whole loop).
          try {
            await this.getBalance();
          } catch (balErr) {
            this.log(`getBalance during retry failed: ${balErr.message} — will keep retrying`, 'error');
            continue;
          }
          let freshLc;
          try {
            freshLc = await this.getLockController();
          } catch (lcErr) {
            this.log(`getLockController during retry failed: ${lcErr.message} — will keep retrying`, 'error');
            continue;
          }
          const freshAllocations = freshLc?.createArgument?.allocations || [];

          if (freshAllocations.length === 0) {
            // LockController lost all allocations — try fresh allocate instead
            if (this.balance > 0) {
              this.log('LockController empty on retry — allocating fresh', 'info');
              try {
                return await this.allocate(newProjectId, this.balance);
              } catch (allocErr) {
                this.log(`Fresh allocate also failed: ${allocErr.message} — will keep retrying`, 'error');
                lastError = allocErr;
                continue;
              }
            }
            this.log('LockController empty and no balance — nothing to do', 'info');
            return null;
          }

          const freshAlloc = freshAllocations[0];
          liveFromContext = freshAlloc.context;
          liveAmount = parseFloat(freshAlloc.amount);

          // Check if already on target (another process moved it)
          if (liveFromContext === newProjectId) {
            this.log('Already on target company after refresh!', 'success');
            this.currentAllocation = newProjectId;
            return null;
          }

          const freshFromName = KNOWN_COMPANIES[liveFromContext] || liveFromContext;
          this.log(`Retry with fresh context: ${liveAmount} HECTO on ${freshFromName}`, 'info');
        }
      }
    }

    // All retries failed — unlike the old flow, funds are still locked on the
    // source company (single-tx means the unlock and lock are atomic), so no
    // rollback is needed. User simply stays on currentCompany.
    this.log(`Reallocate failed after ${MAX_REALLOC_RETRIES} attempts. Funds remain locked on ${KNOWN_COMPANIES[liveFromContext] || liveFromContext}.`, 'error');
    throw lastError || new Error('Reallocate failed');
  }

  async updateState() {
    await this.getBalance();

    // Read allocation from on-chain LockController (new template's source of truth).
    // /api/locks is stale for new-template allocations and shouldn't drive UI state.
    let lockController;
    try {
      lockController = await this.getLockController();
    } catch {
      lockController = null;
    }

    if (lockController === null && this._authFailed) {
      // Auth failed - keep previous allocation so UI doesn't flicker
      this.dashboard.setAccountState(this.email, {
        hectoBalance: this.balance,
        ccBalance: this.ccBalance,
        allocatedTo: this.currentAllocation ? (KNOWN_COMPANIES[this.currentAllocation] || 'Unknown') : '-',
        tokenExpiry: 'AUTH FAILED'
      });
      return;
    }

    const allocations = lockController?.createArgument?.allocations || [];
    if (allocations.length > 0) {
      this.currentAllocation = allocations[0].context;
    } else {
      this.currentAllocation = null;
    }

    this.dashboard.setAccountState(this.email, {
      hectoBalance: this.balance,
      ccBalance: this.ccBalance,
      allocatedTo: this.currentAllocation ? (KNOWN_COMPANIES[this.currentAllocation] || 'Unknown') : '-',
      tokenExpiry: this._authFailed ? 'AUTH FAILED' : this.getExpiryString()
    });
  }
}

// ============================================================================
// MARKET DATA
// ============================================================================

class MarketTracker {
  constructor() {
    this.companiesMap = new Map(); // id -> name from API
  }

  async fetchCompanyNames() {
    try {
      const response = await fetch(`${API.allocator}/companies`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });
      if (!response.ok) return;
      const companies = await response.json();
      for (const c of companies) {
        this.companiesMap.set(c.id, c.name);
      }
    } catch { }
  }

  async fetchMarketData() {
    try {
      // Fetch company names if not yet loaded
      if (this.companiesMap.size === 0) {
        await this.fetchCompanyNames();
      }

      // Fetch real prices with changePct from Hecto API
      const [pricesRes, totalsRes] = await Promise.all([
        fetch(`${API.base}/prices/latest`, {
          method: 'GET',
          headers: { 'Accept': 'application/json' }
        }),
        fetch(`${API.allocator}/round-totals`, {
          method: 'GET',
          headers: { 'Accept': '*/*' }
        })
      ]);

      const prices = pricesRes.ok ? (await pricesRes.json()).prices || {} : {};
      const totals = totalsRes.ok ? await totalsRes.json() : {};

      const companies = [];

      // Merge round-totals with prices data
      const allIds = new Set([...Object.keys(totals), ...Object.keys(prices)]);

      for (const id of allIds) {
        const name = this.companiesMap.get(id) || KNOWN_COMPANIES[id] || id;
        const totalLocked = totals[id]?.totalLocked || 0;
        const priceData = prices[id] || {};
        const changePercent = priceData.changePct !== undefined ? priceData.changePct : 0;

        companies.push({
          id,
          name,
          totalLocked,
          changePercent,
          price: priceData.price || 0
        });
      }

      return companies;
    } catch {
      return [];
    }
  }

  savePreviousData() {
    // No longer needed - using real API data
  }

  getBestCompany(companies) {
    if (companies.length === 0) return null;

    // Only consider companies that have totalLocked (exist in round-totals)
    const validCompanies = companies.filter(c => c.totalLocked > 0);
    if (validCompanies.length === 0) return companies[0];

    // Sort by change percent descending
    const sorted = [...validCompanies].sort((a, b) => (b.changePercent || 0) - (a.changePercent || 0));
    return sorted[0];
  }
}

// ============================================================================
// SCHEDULER
// ============================================================================

class Scheduler {
  constructor(dashboard, bots, marketTracker) {
    this.dashboard = dashboard;
    this.bots = bots;
    this.marketTracker = marketTracker;
    this.isRunning = false;
    // Load last execution date from tokens.json (persistent storage)
    this.lastExecutionDate = getLastExecutionDate();
  }

  getCurrentWIBParts() {
    const now = getNowInConfiguredTimezone();
    return {
      year: now.year(),
      month: now.month() + 1,
      day: now.date(),
      hour: now.hour(),
      minute: now.minute(),
      second: now.second()
    };
  }

  // Get today's date in WIB as YYYY-MM-DD string
  getTodayWIB() {
    const { year, month, day } = this.getCurrentWIBParts();
    const mm = String(month).padStart(2, '0');
    const dd = String(day).padStart(2, '0');
    return `${year}-${mm}-${dd}`;
  }

  // Always reload persisted state before making scheduling decisions so a
  // stale in-memory flag cannot cause a duplicate fire after a restart.
  refreshExecutionState() {
    this.lastExecutionDate = getLastExecutionDate();
    this.inProgressDate = getInProgressDate();
    return this.lastExecutionDate;
  }

  // Mark execution started (persisted) so a crash inside the allocation phase
  // does NOT cause a second fire at a wrong hour on restart.
  markExecutionStarted() {
    const today = this.getTodayWIB();
    this.inProgressDate = today;
    setExecutionInProgress(today);
  }

  // Mark execution complete and persist to tokens.json
  markExecutionComplete() {
    this.lastExecutionDate = this.getTodayWIB();
    setLastExecutionDate(this.lastExecutionDate);
    this.inProgressDate = null;
    this.dashboard.addLog(`Execution recorded: ${this.lastExecutionDate}`, 'success');
  }

  // Check if we are inside the tight execution window [target, target + grace]
  // AND we have not already executed / are not already executing today.
  // Outside the window we DO NOT fire — we wait for tomorrow's target. This
  // prevents the "restart at noon fires immediately" and "account A @ midnight,
  // account B @ 5 AM" drift bugs.
  shouldExecuteNow() {
    this.refreshExecutionState();
    const todayWIB = this.getTodayWIB();
    if (this.lastExecutionDate === todayWIB) return false;
    if (this.inProgressDate === todayWIB) return false;

    const tzName = getConfiguredTimezone();
    const nowInTz = dayjs().tz(tzName);
    const todayTarget = getTodayTargetTimeWIB(settings);
    const msSinceTarget = nowInTz.valueOf() - todayTarget.valueOf();
    return msSinceTarget >= 0 && msSinceTarget <= EXECUTION_GRACE_MS;
  }

  getNextExecutionTime() {
    this.refreshExecutionState();
    const todayWIB = this.getTodayWIB();
    let next = getNextScheduleTimeWIB(settings);

    // If already executed (or currently executing) today and next schedule
    // is still today, show tomorrow's target.
    const alreadyHandledToday =
      this.lastExecutionDate === todayWIB || this.inProgressDate === todayWIB;
    if (alreadyHandledToday && next.format('YYYY-MM-DD') === todayWIB) {
      next = next.add(1, 'day');
    }

    return next.toDate();
  }

  getTimeUntilExecution() {
    return this.getNextExecutionTime().getTime() - Date.now();
  }

  async executeAllocation() {
    this.dashboard.setRunning(true);
    // Reserve the day immediately so a crash/restart won't refire at a wrong hour.
    this.markExecutionStarted();
    this.dashboard.addLog('═══ STARTING SCHEDULED ALLOCATION ═══', 'info');

    try {
      // ================================================================
      // PHASE 1: Ensure all tokens are valid (OTP if needed)
      // ================================================================
      this.dashboard.addLog('[Phase 1/4] Validating tokens...', 'info');
      await withRetries('Token Validation', async () => {
        await this.ensureTokensForExecution();
      }, (msg, type) => this.dashboard.addLog(msg, type));

      // ================================================================
      // PHASE 2: Fetch market data & determine best company
      // ================================================================
      this.dashboard.addLog('[Phase 2/4] Fetching market data...', 'info');
      const bestCompany = await withRetries('Market Data Fetch', async () => {
        const companies = await this.marketTracker.fetchMarketData();
        this.dashboard.setCompanies(companies);
        const best = this.marketTracker.getBestCompany(companies);
        if (!best) {
          throw new Error('No company data available');
        }
        return best;
      }, (msg, type) => this.dashboard.addLog(msg, type));

      const targetName = bestCompany.name;
      const targetId = bestCompany.id;
      this.dashboard.addLog(`Target: ${targetName} (+${bestCompany.changePercent.toFixed(2)}%)`, 'success');

      // ================================================================
      // PHASE 3: Multi-wave allocation — PARALLEL within each wave to
      //          minimize wall-clock time. Per-account retry inside
      //          reallocate() (10x with 1–2s backoff) handles the
      //          CONTRACT_NOT_FOUND races that come from shared on-chain
      //          contracts. A small staggered start (~250ms per bot) avoids
      //          a thundering herd on auth/LC fetch endpoints.
      // ================================================================
      const MAX_WAVES = 8;
      const WAVE_COOLDOWN_MS = 3000; // 3s between waves (was 12s)
      const STAGGER_MS = 250;        // ms delay between bot start within a wave
      let pendingBots = [...this.bots];
      let allResults = [];

      for (let wave = 1; wave <= MAX_WAVES && pendingBots.length > 0; wave++) {
        this.dashboard.addLog(`[Phase 3/4] Wave ${wave}/${MAX_WAVES} (PARALLEL) — ${pendingBots.length} account(s)...`, 'info');

        // ---------- Single-bot allocation attempt ----------
        const attemptBot = async (bot) => {
          try {
            if (bot.isTokenExpired() || bot.needsRefresh(300) || bot._authFailed) {
              bot.log(`Wave ${wave}: Re-authenticating...`, 'info');
              const authOk = await bot.ensureAuthenticated(60000);
              if (!authOk || bot.isTokenExpired()) {
                throw new Error('Authentication failed');
              }
            }

            // State refresh — 10s ceiling so a slow account doesn't drag the wave
            try {
              await Promise.race([
                bot.updateState(),
                new Promise((_, rej) => setTimeout(() => rej(new Error('updateState timeout')), 10000))
              ]);
            } catch (stateErr) {
              bot.log(`State update: ${stateErr.message} — continuing`, 'error');
            }

            const result = await bot.reallocate(targetId);

            if (result) {
              bot.log(`OK Allocated ${result.amount} HECTO > ${targetName}`, 'success');
            } else {
              bot.log(`OK Already allocated to ${targetName} (no action needed)`, 'success');
            }

            // Best-effort post-state refresh; cap short so it never blocks.
            try {
              await Promise.race([
                bot.updateState(),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))
              ]);
            } catch { }

            return { email: bot.email, success: true, result };
          } catch (error) {
            bot.log(`FAIL Wave ${wave} failed: ${error.message}`, 'error');
            return { email: bot.email, success: false, error: error.message };
          }
        };

        // ---------- Execute wave in parallel with light start-stagger ----------
        const startAttempt = async (bot, idx) => {
          if (idx > 0 && STAGGER_MS > 0) await sleep(idx * STAGGER_MS);
          return attemptBot(bot);
        };
        const settled = await Promise.allSettled(pendingBots.map((bot, idx) => startAttempt(bot, idx)));
        const waveResults = settled.map((s, i) =>
          s.status === 'fulfilled'
            ? s.value
            : { email: pendingBots[i].email, success: false, error: String(s.reason?.message || s.reason) }
        );

        const waveSuccess = waveResults.filter(r => r.success);
        const waveFailed = waveResults.filter(r => !r.success);
        allResults.push(...waveResults);

        this.dashboard.addLog(
          `Wave ${wave} result: ${waveSuccess.length} OK, ${waveFailed.length} failed`,
          waveFailed.length === 0 ? 'success' : 'error'
        );

        const successEmails = new Set(waveSuccess.map(r => r.email));
        pendingBots = pendingBots.filter(bot => !successEmails.has(bot.email));

        // Re-auth failed bots in parallel during the cooldown window.
        if (pendingBots.length > 0 && wave < MAX_WAVES) {
          this.dashboard.addLog(
            `${pendingBots.length} account(s) failed — cooling ${WAVE_COOLDOWN_MS / 1000}s & re-authing in parallel...`,
            'info'
          );
          await Promise.allSettled([
            sleep(WAVE_COOLDOWN_MS),
            ...pendingBots.map(async (bot) => {
              try {
                bot.log('Force re-auth before next wave...', 'info');
                bot.authorizationKey = null;
                const refreshed = await bot.refreshPrivyToken(2);
                if (!refreshed) {
                  await bot.autoLogin();
                }
              } catch (e) {
                bot.log(`Re-auth error: ${e.message}`, 'error');
              }
            })
          ]);
        }
      }

      // ================================================================
      // PHASE 4: Verification + Auto-Retry — confirm every account is
      //          allocated to the target company. If any are on the wrong
      //          company, auto-retry them one more time.
      // ================================================================
      this.dashboard.addLog('[Phase 4/5] Verifying all accounts...', 'info');
      await sleep(5000); // let backend settle

      let verifiedOk = 0;
      let verifiedFail = 0;
      const misallocatedBots = []; // bots that are on wrong company
      const unlockedBots = []; // bots with unlocked balance

      for (const bot of this.bots) {
        try {
          await bot.getBalance();
          const lc = await bot.getLockController();
          const allocations = lc?.createArgument?.allocations || [];
          const onChainLocked = bot.lockedBalance || 0;

          if (allocations.length > 0) {
            const alloc = allocations[0];
            const allocatedTo = KNOWN_COMPANIES[alloc.context] || alloc.context;
            const isOnTarget = alloc.context === targetId;
            bot.log(`Verify: ${parseFloat(alloc.amount).toFixed(2)} HECTO > ${allocatedTo}${isOnTarget ? ' OK' : ' FAIL WRONG'}`, isOnTarget ? 'success' : 'error');

            if (isOnTarget) {
              verifiedOk++;
            } else {
              verifiedFail++;
              misallocatedBots.push(bot);
            }
          } else if (bot.balance > 0.1) {
            bot.log(`Verify: ${bot.balance} HECTO UNLOCKED — needs allocation`, 'error');
            verifiedFail++;
            unlockedBots.push(bot);
          } else if (onChainLocked > 0.1) {
            bot.log(`Verify: ${onChainLocked.toFixed(2)} HECTO locked on-chain (no LockController)`, 'success');
            verifiedOk++;
          } else if (bot.balance <= 0 && onChainLocked <= 0) {
            bot.log('Verify: no HECTO balance at all', 'info');
            verifiedOk++;
          } else {
            bot.log(`Verify: ${bot.balance} HECTO UNLOCKED — allocation may have failed!`, 'error');
            verifiedFail++;
            unlockedBots.push(bot);
          }

          // Update dashboard
          await bot.updateState();
        } catch (verifyErr) {
          bot.log(`Verify error: ${verifyErr.message}`, 'error');
          verifiedFail++;
        }
      }

      // ================================================================
      // PHASE 5: Auto-retry misallocated and unlocked accounts — PARALLEL
      //          with up to 5 attempts per bot. The retry loop inside
      //          reallocate() already handles transient errors, but the
      //          bot may have entered Phase 5 mid-flight (verify ran while
      //          its tx was still settling) so we re-verify each round.
      // ================================================================
      const retryBots = [...misallocatedBots, ...unlockedBots];
      if (retryBots.length > 0) {
        this.dashboard.addLog(`[Phase 5/5] Auto-retrying ${retryBots.length} misallocated/unlocked account(s) IN PARALLEL...`, 'info');
        await sleep(2000);

        const PER_BOT_PHASE5_ATTEMPTS = 5;

        const phase5One = async (bot, idx) => {
          // Light start-stagger so all bots don't slam Privy/Canton at once
          if (idx > 0) await sleep(idx * 200);

          for (let attempt = 1; attempt <= PER_BOT_PHASE5_ATTEMPTS; attempt++) {
            try {
              // First, just check if the chain says we're already on target.
              // If yes, the earlier wave actually succeeded — we just verified
              // too soon. No tx needed.
              try {
                await bot.getBalance();
                const lc = await bot.getLockController();
                const allocs = lc?.createArgument?.allocations || [];
                if (allocs.length > 0 && allocs[0].context === targetId) {
                  bot.log(`Phase 5 attempt ${attempt}: already on target (no tx needed)`, 'success');
                  bot.currentAllocation = targetId;
                  try { await bot.updateState(); } catch { }
                  return { email: bot.email, success: true };
                }
              } catch { }

              if (attempt > 1) {
                bot.log(`Phase 5 attempt ${attempt}/${PER_BOT_PHASE5_ATTEMPTS}: refreshing auth...`, 'info');
                bot.authorizationKey = null;
                try { await bot.refreshPrivyToken(2); } catch { }
              }

              const result = await bot.reallocate(targetId);
              if (result) {
                bot.log(`Phase 5 attempt ${attempt} OK ${result.amount} HECTO > ${targetName}`, 'success');
              } else {
                bot.log(`Phase 5 attempt ${attempt} OK Already on ${targetName}`, 'success');
              }
              try { await bot.updateState(); } catch { }
              return { email: bot.email, success: true };
            } catch (retryErr) {
              bot.log(`Phase 5 attempt ${attempt} FAIL ${retryErr.message}`, 'error');
              if (attempt < PER_BOT_PHASE5_ATTEMPTS) {
                await sleep(1500 + Math.random() * 1000);
              }
            }
          }
          return { email: bot.email, success: false };
        };

        const phase5Settled = await Promise.allSettled(retryBots.map((bot, idx) => phase5One(bot, idx)));
        const retryOk = phase5Settled.filter(s => s.status === 'fulfilled' && s.value.success).length;
        verifiedFail -= retryOk;
        verifiedOk += retryOk;

        this.dashboard.addLog(`Auto-retry result: ${retryOk}/${retryBots.length} fixed`, retryOk === retryBots.length ? 'success' : 'error');

        // ================================================================
        // PHASE 6: NUCLEAR RECOVERY — for accounts that survived all the
        //          earlier strategies. Different approach this time:
        //   * SEQUENTIAL one-bot-at-a-time so contracts settle between txs
        //   * 30s settle-down before starting (let backend/rate-limit cool)
        //   * Per bot: force fresh Privy session, clear ALL caches, then
        //     up to 8 deliberate attempts with 4s spacing
        //   * Always idempotency-check the chain BEFORE submitting
        // ================================================================
        const stubbornBots = phase5Settled
          .map((s, i) => ({ result: s, bot: retryBots[i] }))
          .filter(x => !(x.result.status === 'fulfilled' && x.result.value.success))
          .map(x => x.bot);

        if (stubbornBots.length > 0) {
          this.dashboard.addLog(
            `[Phase 6/6] NUCLEAR RECOVERY for ${stubbornBots.length} stubborn account(s) — settling 30s first...`,
            'info'
          );
          await sleep(30000);

          const PHASE6_ATTEMPTS = 8;
          let nukeOk = 0;

          for (const bot of stubbornBots) {
            bot.log('═ NUCLEAR RECOVERY START ═', 'info');

            // Wipe everything we have cached for this bot so the next
            // request grabs absolutely fresh state from origin.
            bot.authorizationKey = null;
            bot.walletId = bot.walletId; // keep — derived from token claims
            bot._authFailed = false;
            try {
              await bot.refreshPrivyToken(3);
            } catch (refreshErr) {
              bot.log(`Nuclear: refreshPrivyToken failed: ${refreshErr.message}`, 'error');
              try {
                await bot.autoLogin();
              } catch (loginErr) {
                bot.log(`Nuclear: autoLogin failed: ${loginErr.message}`, 'error');
              }
            }

            let nukeSuccess = false;
            for (let attempt = 1; attempt <= PHASE6_ATTEMPTS; attempt++) {
              try {
                // Idempotency check — maybe earlier phase actually landed
                try {
                  await bot.getBalance();
                  const lc = await bot.getLockController();
                  const allocs = lc?.createArgument?.allocations || [];
                  if (allocs.length > 0 && allocs[0].context === targetId) {
                    bot.log(`Nuclear attempt ${attempt}: chain says already on target`, 'success');
                    bot.currentAllocation = targetId;
                    try { await bot.updateState(); } catch { }
                    nukeSuccess = true;
                    break;
                  }
                } catch { }

                bot.log(`Nuclear attempt ${attempt}/${PHASE6_ATTEMPTS}...`, 'info');
                const result = await bot.reallocate(targetId);
                if (result) {
                  bot.log(`Nuclear attempt ${attempt} OK ${result.amount} HECTO > ${targetName}`, 'success');
                } else {
                  bot.log(`Nuclear attempt ${attempt} OK Already on ${targetName}`, 'success');
                }
                try { await bot.updateState(); } catch { }
                nukeSuccess = true;
                break;
              } catch (nukeErr) {
                bot.log(`Nuclear attempt ${attempt} FAIL ${nukeErr.message}`, 'error');
                if (attempt < PHASE6_ATTEMPTS) {
                  // Mid-loop refresh on auth-related failures
                  if (/signature|401|403|auth/i.test(nukeErr.message)) {
                    bot.authorizationKey = null;
                    try { await bot.refreshPrivyToken(2); } catch { }
                  }
                  await sleep(4000 + Math.random() * 2000);
                }
              }
            }

            if (nukeSuccess) {
              nukeOk++;
              verifiedFail--;
              verifiedOk++;
            } else {
              bot.log('═ NUCLEAR RECOVERY EXHAUSTED — manual intervention may be needed ═', 'error');
            }

            // Inter-bot pause so we don't immediately race the next bot
            await sleep(3000);
          }

          this.dashboard.addLog(
            `Nuclear recovery: ${nukeOk}/${stubbornBots.length} fixed`,
            nukeOk === stubbornBots.length ? 'success' : 'error'
          );
        }
      }

      // ======== Final summary ========
      const totalOk = allResults.filter(r => r.success).length;
      const totalFail = this.bots.length - totalOk;

      this.dashboard.addLog(
        `═══ ALLOCATION COMPLETE: ${totalOk}/${this.bots.length} success | Verified: ${verifiedOk} OK, ${verifiedFail} issues ═══`,
        verifiedFail === 0 ? 'success' : 'error'
      );

      if (pendingBots.length > 0) {
        const failedEmails = pendingBots.map(b => b.email.split('@')[0]).join(', ');
        this.dashboard.addLog(`Still failed after ${MAX_WAVES} waves: ${failedEmails}`, 'error');
      }

      // Save current data for next comparison
      this.marketTracker.savePreviousData();

      // Mark execution complete — persisted to tokens.json
      this.markExecutionComplete();

    } catch (error) {
      this.dashboard.addLog(`Execution error: ${error.message}`, 'error');
      // Even on catastrophic error: record this calendar day as "done" so the
      // scheduler does not keep re-firing at random hours throughout the day.
      this.markExecutionComplete();
    }

    this.dashboard.setRunning(false);

    // Show waiting message with next execution time
    const nextTime = this.getNextExecutionTime();
    const nextTimeStr = nextTime.toLocaleString('id-ID', { timeZone: getConfiguredTimezone() });
    this.dashboard.addLog(`Waiting for next run: ${nextTimeStr}`, 'info');
  }

  // Check if we are within X minutes before scheduled execution
  getMinutesUntilExecution() {
    return this.getTimeUntilExecution() / 60000; // Convert ms to minutes
  }

  // Soft restart - refresh all tokens by simulating a fresh session init
  // This tries to refresh without OTP first, then falls back to OTP if needed
  async softRestartAllAccounts() {
    this.dashboard.addLog('Performing soft restart for all accounts...', 'info');

    const restartPromises = this.bots.map(async (bot) => {
      try {
        // Step 1: Try refresh token (no OTP needed)
        const refreshed = await bot.refreshPrivyToken(3);

        if (refreshed && bot.getSecondsUntilExpiry() > 2100) { // > 35 minutes
          bot.log(`Soft restart OK - token valid for ${bot.getExpiryString()}`, 'success');
          return { email: bot.email, success: true, method: 'refresh' };
        }

        // Step 2: Refresh failed or token still short, try OTP login
        bot.log('Refresh insufficient, falling back to OTP login...', 'info');
        const loggedIn = await bot.autoLogin();

        if (loggedIn) {
          bot.log(`OTP login OK - token valid for ${bot.getExpiryString()}`, 'success');
          return { email: bot.email, success: true, method: 'otp' };
        }

        return { email: bot.email, success: false, error: 'Both refresh and OTP failed' };
      } catch (error) {
        bot.log(`Soft restart failed: ${error.message}`, 'error');
        return { email: bot.email, success: false, error: error.message };
      }
    });

    const results = await Promise.allSettled(restartPromises);

    const successful = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
    const failed = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.success)).length;

    this.dashboard.addLog(`Soft restart: ${successful} success, ${failed} failed`, successful > 0 ? 'success' : 'error');

    return { successful, failed };
  }

  // ========================================================================
  // SUPER ROBUST TOKEN KEEP-ALIVE SYSTEM
  // 
  // 4-Layer Defense Against Token Expiry:
  //   Layer 1 (PROACTIVE)  : Refresh at 50% lifetime (~30min mark)
  //   Layer 2 (URGENT)     : Refresh at <10min remaining, more retries
  //   Layer 3 (EMERGENCY)  : Refresh at <3min remaining, max effort
  //   Layer 4 (RECOVERY)   : Token expired > OTP with smart cooldown
  //
  // Features:
  //   - Staggered refresh: each account has random jitter to avoid API spam
  //   - Health tracking: consecutive failure counter per account
  //   - Exponential backoff: OTP retry delay grows with failures
  //   - Minimum refresh interval: prevents API flooding (5min per account)
  //   - Silent operation: only logs important events
  // ========================================================================

  _initKeepAliveState(bot) {
    if (bot._kaInitialized) return;
    bot._kaInitialized = true;

    // Refresh tracking
    bot._lastRefreshAttempt = 0;       // Timestamp of last refresh attempt
    bot._lastRefreshSuccess = 0;       // Timestamp of last successful refresh
    bot._refreshFailCount = 0;         // Consecutive refresh failures
    bot._refreshJitterMs = Math.floor(Math.random() * 120000); // 0-2min random offset per account

    // OTP recovery tracking
    bot._otpRetryCount = 0;            // OTP attempts since last success
    bot._lastOtpAttempt = 0;           // Timestamp of last OTP attempt
    bot._tokenExpiredAt = 0;           // When token first expired

    // State flags
    bot._softRestartInProgress = false;
    bot._kaHealthScore = 100;          // 0-100 health score
  }

  _resetKeepAliveState(bot) {
    bot._refreshFailCount = 0;
    bot._otpRetryCount = 0;
    bot._lastOtpAttempt = 0;
    bot._tokenExpiredAt = 0;
    bot._softRestartInProgress = false;
    bot._kaHealthScore = 100;
  }

  async keepTokensAlive() {
    const TOKEN_LIFETIME = 3600;              // Privy token lifetime: 60 minutes
    const LAYER1_THRESHOLD = TOKEN_LIFETIME * 0.5; // 30 min = refresh at 50% lifetime
    const LAYER2_THRESHOLD = 600;             // 10 min = urgent refresh
    const LAYER3_THRESHOLD = 180;             // 3 min = emergency refresh
    const MIN_REFRESH_INTERVAL = 300000;      // 5 min minimum between refresh attempts per account
    const MAX_OTP_RETRIES = 3;                // Max OTP before giving up
    const OTP_BASE_COOLDOWN = 600000;         // 10 min base cooldown for OTP

    for (const bot of this.bots) {
      this._initKeepAliveState(bot);

      try {
        const remaining = bot.getSecondsUntilExpiry();
        const now = Date.now();
        const timeSinceLastRefresh = now - (bot._lastRefreshAttempt || 0);

        // ==================================================================
        // LAYER 4: TOKEN EXPIRED — Recovery Mode
        // ==================================================================
        if (remaining <= 0) {
          if (!bot._tokenExpiredAt) {
            bot._tokenExpiredAt = now;
            bot.log('Token expired! Starting recovery...', 'error');
          }

          // --- 4a: Check if file was updated externally ---
          bot.reloadTokensFromFile();
          if (!bot.isTokenExpired() && bot.getSecondsUntilExpiry() > 300) {
            bot.log(`Token recovered from file! Valid for ${bot.getExpiryString()}`, 'success');
            this._resetKeepAliveState(bot);
            this.dashboard.setAccountState(bot.email, { tokenExpiry: bot.getExpiryString() });
            continue;
          }

          // --- 4b: Try refresh token first (no OTP needed) ---
          if (!bot._softRestartInProgress && timeSinceLastRefresh >= MIN_REFRESH_INTERVAL) {
            bot._softRestartInProgress = true;
            bot._lastRefreshAttempt = now;

            try {
              const refreshed = await bot.refreshPrivyToken(3);
              if (refreshed && bot.getSecondsUntilExpiry() > 300) {
                bot.log(`Token recovered via refresh! Valid for ${bot.getExpiryString()}`, 'success');
                this._resetKeepAliveState(bot);
                this.dashboard.setAccountState(bot.email, { tokenExpiry: bot.getExpiryString() });
                bot._softRestartInProgress = false;
                continue;
              }
            } catch (e) {
              bot.log(`Recovery refresh error: ${e.message}`, 'error');
            }

            // --- 4c: Refresh failed, try OTP with exponential backoff ---
            if (bot._otpRetryCount >= MAX_OTP_RETRIES) {
              // Max OTP retries exhausted
              this.dashboard.setAccountState(bot.email, {
                tokenExpiry: 'EXPIRED (use menu 2)'
              });
              bot._softRestartInProgress = false;
              continue;
            }

            // Exponential backoff: 10min, 20min, 40min
            const otpCooldown = OTP_BASE_COOLDOWN * Math.pow(2, bot._otpRetryCount);
            const timeSinceOtp = now - (bot._lastOtpAttempt || 0);

            if (bot._lastOtpAttempt && timeSinceOtp < otpCooldown) {
              const minutesLeft = Math.ceil((otpCooldown - timeSinceOtp) / 60000);
              this.dashboard.setAccountState(bot.email, {
                tokenExpiry: `EXPIRED (OTP ${minutesLeft}m)`
              });
              bot._softRestartInProgress = false;
              continue;
            }

            // Do OTP attempt
            bot._otpRetryCount++;
            bot._lastOtpAttempt = now;
            bot.log(`OTP recovery attempt ${bot._otpRetryCount}/${MAX_OTP_RETRIES}...`, 'info');

            try {
              const loggedIn = await bot.autoLogin();
              if (loggedIn && bot.getSecondsUntilExpiry() > 300) {
                bot.log(`Recovered via OTP! Valid for ${bot.getExpiryString()}`, 'success');
                this._resetKeepAliveState(bot);
                this.dashboard.setAccountState(bot.email, { tokenExpiry: bot.getExpiryString() });
              } else {
                const nextCooldown = Math.ceil((OTP_BASE_COOLDOWN * Math.pow(2, bot._otpRetryCount)) / 60000);
                bot.log(`OTP failed (${bot._otpRetryCount}/${MAX_OTP_RETRIES}), next in ${nextCooldown}min`, 'error');
                bot._kaHealthScore = Math.max(0, bot._kaHealthScore - 30);
                this.dashboard.setAccountState(bot.email, { tokenExpiry: bot.getExpiryString() });
              }
            } catch (e) {
              bot.log(`OTP error: ${e.message}`, 'error');
            }

            bot._softRestartInProgress = false;
          } else if (!bot._softRestartInProgress) {
            // Waiting for cooldown
            if (bot._otpRetryCount >= MAX_OTP_RETRIES) {
              this.dashboard.setAccountState(bot.email, {
                tokenExpiry: 'EXPIRED (use menu 2)'
              });
            } else {
              const waitSec = Math.ceil(Math.max(0, MIN_REFRESH_INTERVAL - timeSinceLastRefresh) / 1000);
              this.dashboard.setAccountState(bot.email, {
                tokenExpiry: `EXPIRED (wait ${waitSec}s)`
              });
            }
          }
          continue;
        }

        // ==================================================================
        // TOKEN VALID — Proactive Refresh Layers
        // ==================================================================

        // Reset recovery state when token is valid
        if (bot._tokenExpiredAt) {
          this._resetKeepAliveState(bot);
        }

        // Apply per-account jitter to stagger refreshes across accounts
        const jitteredRemaining = remaining + (bot._refreshJitterMs / 1000);

        // ------------------------------------------------------------------
        // LAYER 1: PROACTIVE REFRESH (50% lifetime, ~30 min mark)
        // Silent, early refresh — the primary defense line
        // ------------------------------------------------------------------
        if (jitteredRemaining <= LAYER1_THRESHOLD && remaining > LAYER2_THRESHOLD) {
          // Respect minimum interval to avoid API spam
          if (timeSinceLastRefresh < MIN_REFRESH_INTERVAL) {
            this.dashboard.setAccountState(bot.email, { tokenExpiry: bot.getExpiryString() });
            continue;
          }

          // Only attempt if no recent failure (back off on failures)
          if (bot._refreshFailCount > 0) {
            const backoffMs = Math.min(MIN_REFRESH_INTERVAL * Math.pow(2, bot._refreshFailCount), 1800000);
            if (timeSinceLastRefresh < backoffMs) {
              this.dashboard.setAccountState(bot.email, { tokenExpiry: bot.getExpiryString() });
              continue;
            }
          }

          bot._lastRefreshAttempt = now;
          const refreshed = await bot.refreshPrivyToken(1); // Single attempt, silent

          if (refreshed && bot.getSecondsUntilExpiry() > LAYER2_THRESHOLD) {
            bot._refreshFailCount = 0;
            bot._lastRefreshSuccess = now;
            bot._kaHealthScore = Math.min(100, bot._kaHealthScore + 5);
            // Silent success - just update dashboard
          } else {
            bot._refreshFailCount++;
            if (bot._refreshFailCount === 1) {
              bot.log(`Proactive refresh failed (${remaining}s left), will retry...`, 'info');
            }
          }

          this.dashboard.setAccountState(bot.email, { tokenExpiry: bot.getExpiryString() });
          continue;
        }

        // ------------------------------------------------------------------
        // LAYER 2: URGENT REFRESH (<10 min remaining)
        // More aggressive: 2 retries, logs warning
        // ------------------------------------------------------------------
        if (remaining <= LAYER2_THRESHOLD && remaining > LAYER3_THRESHOLD) {
          if (timeSinceLastRefresh < 60000) { // Allow retry every 1 min in urgent mode
            this.dashboard.setAccountState(bot.email, { tokenExpiry: `${bot.getExpiryString()} !` });
            continue;
          }

          bot.log(`URGENT: Token expires in ${bot.getExpiryString()}, refreshing...`, 'info');
          bot._lastRefreshAttempt = now;

          const refreshed = await bot.refreshPrivyToken(2); // 2 retries

          if (refreshed && bot.getSecondsUntilExpiry() > LAYER3_THRESHOLD) {
            bot._refreshFailCount = 0;
            bot._lastRefreshSuccess = now;
            bot._kaHealthScore = Math.min(100, bot._kaHealthScore + 3);
            bot.log(`Urgent refresh OK! Valid for ${bot.getExpiryString()}`, 'success');
          } else {
            bot._refreshFailCount++;
            bot._kaHealthScore = Math.max(0, bot._kaHealthScore - 10);
            bot.log(`Urgent refresh FAILED (fail #${bot._refreshFailCount})`, 'error');
          }

          this.dashboard.setAccountState(bot.email, { tokenExpiry: bot.getExpiryString() });
          continue;
        }

        // ------------------------------------------------------------------
        // LAYER 3: EMERGENCY REFRESH (<3 min remaining)
        // Maximum effort: 3 retries, rapid retry, log critical
        // ------------------------------------------------------------------
        if (remaining <= LAYER3_THRESHOLD && remaining > 0) {
          if (timeSinceLastRefresh < 30000) { // Allow retry every 30s in emergency
            this.dashboard.setAccountState(bot.email, { tokenExpiry: `${bot.getExpiryString()} !!` });
            continue;
          }

          bot.log(`EMERGENCY: Token expires in ${remaining}s! Max-effort refresh...`, 'error');
          bot._lastRefreshAttempt = now;

          // Try refresh with max retries
          const refreshed = await bot.refreshPrivyToken(3);

          if (refreshed && bot.getSecondsUntilExpiry() > 60) {
            bot._refreshFailCount = 0;
            bot._lastRefreshSuccess = now;
            bot._kaHealthScore = Math.min(100, bot._kaHealthScore + 2);
            bot.log(`Emergency refresh SAVED! Valid for ${bot.getExpiryString()}`, 'success');
          } else {
            bot._refreshFailCount++;
            bot._kaHealthScore = Math.max(0, bot._kaHealthScore - 20);
            bot.log(`EMERGENCY refresh FAILED! Token may expire soon (fail #${bot._refreshFailCount})`, 'error');

            // Last resort: reload from file in case another process refreshed
            bot.reloadTokensFromFile();
            if (!bot.isTokenExpired()) {
              bot.log(`Token found via file reload! ${bot.getExpiryString()}`, 'success');
              bot._refreshFailCount = 0;
            }
          }

          this.dashboard.setAccountState(bot.email, { tokenExpiry: bot.getExpiryString() });
          continue;
        }

        // ------------------------------------------------------------------
        // TOKEN HEALTHY (>30 min remaining) — just update dashboard
        // ------------------------------------------------------------------
        this.dashboard.setAccountState(bot.email, { tokenExpiry: bot.getExpiryString() });

      } catch (error) {
        bot.log(`Keep-alive error: ${error.message}`, 'error');
        bot._kaHealthScore = Math.max(0, (bot._kaHealthScore || 100) - 5);
      }

      // Small delay between accounts to avoid API burst
      await sleep(500);
    }
  }

  // Called before execution to ensure all tokens are valid
  // SEQUENTIAL to prevent OTP input field overlap
  async ensureTokensForExecution() {
    this.dashboard.addLog('Final token check before execution...', 'info');

    let readyCount = 0;
    let failedCount = 0;

    for (const bot of this.bots) {
      try {
        const remaining = bot.getSecondsUntilExpiry();

        if (remaining > 300) {
          bot.log(`Token OK for execution: ${bot.getExpiryString()}`, 'success');
          readyCount++;
          continue;
        }

        bot.log('Token insufficient for execution, refreshing...');
        const refreshed = await bot.refreshPrivyToken(2);

        if (refreshed && bot.getSecondsUntilExpiry() > 300) {
          bot.log(`Refresh OK: ${bot.getExpiryString()}`, 'success');
          this.dashboard.setAccountState(bot.email, { tokenExpiry: bot.getExpiryString() });
          readyCount++;
          continue;
        }

        bot.log('Refresh failed, requesting OTP...');
        const loggedIn = await bot.autoLogin();
        if (loggedIn && bot.getSecondsUntilExpiry() > 300) {
          this.dashboard.setAccountState(bot.email, { tokenExpiry: bot.getExpiryString() });
          readyCount++;
        } else {
          bot.log('Token still invalid after refresh + OTP', 'error');
          failedCount++;
        }
      } catch (error) {
        bot.log(`Token check error: ${error.message}`, 'error');
        failedCount++;
      }
    }

    if (failedCount > 0) {
      this.dashboard.addLog(`Token check: ${readyCount} ready, ${failedCount} failed`, 'error');
    } else {
      this.dashboard.addLog(`Token check: ${readyCount} ready`, 'success');
    }
  }

  async start() {
    this.dashboard.addLog('HectoBot started', 'success');

    // Show last execution info from persistent storage
    if (this.lastExecutionDate) {
      this.dashboard.addLog(`Last execution: ${this.lastExecutionDate}`, 'info');
    } else {
      this.dashboard.addLog('No previous execution recorded', 'info');
    }

    // Fetch initial market data first (doesn't need auth)
    const companies = await this.marketTracker.fetchMarketData();
    this.dashboard.setCompanies(companies);
    this.marketTracker.savePreviousData();

    // Initial setup for accounts - SEQUENTIAL to prevent OTP input overlap
    this.dashboard.addLog(`Initializing ${this.bots.length} accounts (sequential, timeout: 4min each)...`, 'info');

    const INIT_TIMEOUT = 240000; // 4 minutes per account
    let initSuccess = 0;
    let initFailed = 0;

    for (let index = 0; index < this.bots.length; index++) {
      const bot = this.bots[index];
      try {
        const initWithTimeout = Promise.race([
          (async () => {
            const authResult = await bot.ensureAuthenticated();
            if (!authResult) {
              bot.log('Auth unavailable at init, running in degraded mode (will auto-retry)', 'error');
              this.dashboard.setAccountState(bot.email, {
                status: 'degraded',
                tokenExpiry: 'AUTH FAILED'
              });
              return { email: bot.email, success: true, degraded: true };
            }
            await bot.updateState();
            return { email: bot.email, success: true };
          })(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Init timeout (4min)')), INIT_TIMEOUT)
          )
        ]);

        await initWithTimeout;
        this.dashboard.addLog(`Account ${index + 1}/${this.bots.length}: ${bot.email.split('@')[0]} ready`, 'success');
        initSuccess++;
      } catch (error) {
        bot.log(`Init failed: ${error.message}`, 'error');
        this.dashboard.addLog(`Account ${index + 1}/${this.bots.length}: ${bot.email.split('@')[0]} FAILED`, 'error');
        this.dashboard.setAccountState(bot.email, {
          status: 'error',
          tokenExpiry: 'INIT FAILED'
        });
        initFailed++;
      }
    }

    if (initSuccess === 0) {
      this.dashboard.addLog(`CRITICAL: All ${this.bots.length} accounts failed to init!`, 'error');
      this.dashboard.addLog('Check tokens.json and accounts.json, then restart', 'error');
    } else if (initFailed > 0) {
      this.dashboard.addLog(`Initialization: ${initSuccess} OK, ${initFailed} failed`, 'error');
    } else {
      this.dashboard.addLog(`Initialization: ${initSuccess}/${this.bots.length} accounts ready`, 'success');
    }

    // ====================================================================
    // TOKEN KEEP-ALIVE — 4-Layer Defense System (polls every 15s)
    //   Layer 1: Proactive refresh at 50% lifetime (~30min mark)
    //   Layer 2: Urgent refresh at <10min remaining
    //   Layer 3: Emergency refresh at <3min remaining
    //   Layer 4: Recovery via OTP with exponential backoff
    // Internal rate limiting prevents API spam despite fast polling.
    // ====================================================================
    const keepAliveInterval = 15000; // 15 seconds - fast polling, smart rate limiting
    setInterval(() => this.keepTokensAlive(), keepAliveInterval);

    // ====================================================================
    // PERIODIC MARKET & STATE UPDATES — independent interval (every 60s)
    // These run on their own timer and NEVER block the scheduler.
    // ====================================================================
    const periodicUpdateInterval = 60000; // 1 minute
    const periodicUpdate = async () => {
      try {
        // Refresh market data
        const freshCompanies = await this.marketTracker.fetchMarketData();
        this.dashboard.setCompanies(freshCompanies);

        // Update account states in parallel
        const updatePromises = this.bots.map(async (bot) => {
          try { await bot.updateState(); } catch { }
        });
        await Promise.allSettled(updatePromises);
      } catch { }

      // Always refresh the "Next" display
      const nextTime = this.getNextExecutionTime();
      this.dashboard.setNextExecution(
        nextTime.toLocaleString('id-ID', { timeZone: getConfiguredTimezone() })
      );
    };
    setInterval(periodicUpdate, periodicUpdateInterval);
    // Run once immediately so the dashboard isn't empty
    periodicUpdate();

    // ====================================================================
    // CRON SCHEDULER — precise, OS-level timing via node-cron
    // ====================================================================
    const { hour, minute } = parseScheduleHM(settings);
    const cronExpression = `${minute} ${hour} * * *`;
    const tzName = getConfiguredTimezone();

    // Log detailed timing info so the operator can verify
    const nowTz = dayjs().tz(tzName);
    this.dashboard.addLog(`System time  : ${new Date().toISOString()}`, 'info');
    this.dashboard.addLog(`Timezone time: ${nowTz.format('YYYY-MM-DD HH:mm:ss')} (${tzName})`, 'info');
    this.dashboard.addLog(`Cron schedule: "${cronExpression}" (${tzName}) > daily ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, 'success');

    // Validate the expression
    if (!cron.validate(cronExpression)) {
      this.dashboard.addLog(`FATAL: Invalid cron expression "${cronExpression}" from scheduleTime "${settings.scheduleTime}"`, 'error');
      process.exit(1);
    }

    // Show next execution
    const nextTime = this.getNextExecutionTime();
    this.dashboard.setNextExecution(
      nextTime.toLocaleString('id-ID', { timeZone: tzName })
    );
    this.dashboard.addLog(`Next execution: ${dayjs(nextTime).tz(tzName).format('YYYY-MM-DD HH:mm:ss')} ${tzName}`, 'info');

    // ── Startup catch-up: if we restarted inside the grace window, fire now ──
    if (this.shouldExecuteNow()) {
      this.dashboard.addLog('Within grace window on startup — executing catch-up allocation!', 'info');
      await this.executeAllocation();
      // Refresh display after catch-up
      const afterTime = this.getNextExecutionTime();
      this.dashboard.setNextExecution(
        afterTime.toLocaleString('id-ID', { timeZone: tzName })
      );
    }

    // ── Schedule the daily job ──
    cron.schedule(cronExpression, async () => {
      const fireTime = dayjs().tz(tzName).format('YYYY-MM-DD HH:mm:ss');
      this.dashboard.addLog(`CRON FIRED at ${fireTime} (${tzName})`, 'success');

      // Double-check guard: don't re-execute if we already ran today
      this.refreshExecutionState();
      const todayWIB = this.getTodayWIB();
      if (this.lastExecutionDate === todayWIB) {
        this.dashboard.addLog(`Already executed today (${todayWIB}), skipping.`, 'info');
        return;
      }
      if (this.inProgressDate === todayWIB) {
        this.dashboard.addLog(`Execution already in progress for ${todayWIB}, skipping.`, 'info');
        return;
      }

      await this.executeAllocation();

      // Refresh "Next" display
      const afterTime = this.getNextExecutionTime();
      this.dashboard.setNextExecution(
        afterTime.toLocaleString('id-ID', { timeZone: tzName })
      );
    }, {
      timezone: tzName
    });

    this.dashboard.addLog('Cron scheduler active — bot will stay running.', 'success');

    // Keep the process alive. The cron job and setIntervals do the work.
    // We use a long setInterval heartbeat to prevent Node from exiting,
    // while also acting as a secondary watchdog.
    setInterval(() => {
      const hbTime = dayjs().tz(tzName).format('HH:mm:ss');
      // Silent heartbeat — only update the next-execution display
      const nxt = this.getNextExecutionTime();
      this.dashboard.setNextExecution(
        nxt.toLocaleString('id-ID', { timeZone: tzName })
      );
    }, 30000); // every 30 seconds

    // Return a never-resolving promise so main() doesn't exit
    return new Promise(() => { });
  }
}

// ============================================================================
// STARTUP MENU
// ============================================================================

function showStartupMenu() {
  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log('║        HECTOBOT - STARTUP MENU         ║');
  console.log('╠════════════════════════════════════════╣');
  console.log('║  1. Run Bot (scheduled mode)           ║');
  console.log('║  2. Login OTP (authenticate accounts)  ║');
  console.log('╚════════════════════════════════════════╝');
  console.log('');
}

function showProxyMenu() {
  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log('║         PROXY MODE SELECTION           ║');
  console.log('╠════════════════════════════════════════╣');
  console.log('║  1. No proxy (direct connection)       ║');
  console.log('║  2. Use proxy (proxy.txt)              ║');
  console.log('╚════════════════════════════════════════╝');
  console.log('');
}

// Prompt user for proxy mode. Returns true if proxies should be loaded.
async function promptProxyMode() {
  showProxyMenu();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(resolve => {
    rl.question('  Select option (1 or 2): ', a => {
      rl.close();
      resolve(a.trim());
    });
  });
  return answer === '2';
}

// OTP login mode: authenticate all accounts one by one (sequential).
// Dashboard rendering is DISABLED here — the boxed UI clears the screen on
// every log/state update, which would obliterate the manual OTP prompt mid-
// typing. We use plain console output instead, which terminals scroll instead
// of overwriting.
async function runOTPMode(bots, dashboard) {
  // Lock the dashboard for the whole OTP session. This stops every render()
  // call from setAccountState/addLog inside autoLogin/sendOTP/etc.
  dashboard.setWaitingOTP(true, '*all*');

  // Bot.log() goes through dashboard.addLog → no render (waitingOTP=true), but
  // we DO want messages on screen. Hook a console mirror so user sees activity.
  const origAddLog = dashboard.addLog.bind(dashboard);
  dashboard.addLog = (message, type = 'info') => {
    origAddLog(message, type);
    const tag = type === 'error' ? '[!]' : type === 'success' ? '[+]' : '[*]';
    console.log(`  ${tag} ${message}`);
  };

  const failedAccounts = []; // { email, reason }
  let successCount = 0;
  let failedCount = 0;

  // SINGLE readline.Interface for the entire OTP session. Creating a new
  // one per account causes process.stdin to receive `end` after the first
  // close, silently EOF-ing all subsequent prompts. Sharing one rl avoids
  // that completely.
  const sharedRl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
  });

  try {
    console.log('');
    console.log('═══ OTP LOGIN MODE ═══');
    console.log(`Authenticating ${bots.length} accounts sequentially...`);
    console.log('');

    // Pre-flight: warn about gmail accounts missing emailAppPassword (they
    // will require manual typing, which is fine — but the operator should
    // know up front how many manual prompts to expect).
    const manualGmail = bots.filter(b =>
      b.email.toLowerCase().endsWith('@gmail.com') && !b.account.emailAppPassword
    );
    if (manualGmail.length > 0) {
      console.log(`[!] ${manualGmail.length} gmail account(s) missing emailAppPassword in accounts.json:`);
      for (const b of manualGmail) console.log(`    - ${b.email}`);
      console.log(`[!] These will need MANUAL OTP entry. Add app passwords for full automation.`);
      console.log('');
    }

    for (let i = 0; i < bots.length; i++) {
      const bot = bots[i];
      const shortEmail = bot.email.split('@')[0];
      console.log(`\n── Account ${i + 1}/${bots.length}: ${bot.email} ──`);

      // Check if token is still valid
      const remaining = bot.getSecondsUntilExpiry();
      if (remaining > 600) { // > 10 minutes
        console.log(`  OK Token still valid (${bot.getExpiryString()} remaining). Skipping.`);
        successCount++;
        continue;
      }

      // Try refresh first
      console.log('  Trying token refresh...');
      let refreshOk = false;
      try {
        const refreshed = await bot.refreshPrivyToken(2);
        if (refreshed && bot.getSecondsUntilExpiry() > 300) {
          console.log(`  OK Token refreshed! Valid for ${bot.getExpiryString()}`);
          successCount++;
          refreshOk = true;
        }
      } catch (e) {
        console.log(`  Refresh failed: ${e.message}`);
      }
      if (refreshOk) continue;

      // Need OTP login
      console.log('  Token expired/insufficient, need OTP login...');
      try {
        const loggedIn = await bot.autoLogin(2, sharedRl);
        if (loggedIn) {
          console.log(`  OK Login successful! Token valid for ${bot.getExpiryString()}`);
          successCount++;
        } else {
          const isGmail = bot.email.toLowerCase().endsWith('@gmail.com');
          const hasPwd = !!bot.account.emailAppPassword;
          let reason;
          if (isGmail && hasPwd) {
            reason = 'IMAP auto-read failed (check emailAppPassword & Gmail IMAP enabled)';
          } else if (isGmail && !hasPwd) {
            reason = 'Gmail without emailAppPassword — manual OTP failed/skipped';
          } else {
            reason = 'Manual OTP required but not entered';
          }
          console.log(`  FAIL Login failed: ${reason}`);
          failedAccounts.push({ email: bot.email, reason });
          failedCount++;
        }
      } catch (error) {
        console.log(`  FAIL Error: ${error.message}`);
        failedAccounts.push({ email: bot.email, reason: error.message });
        failedCount++;
      }
    }

    console.log('');
    console.log('═══ OTP LOGIN COMPLETE ═══');
    console.log(`  Success: ${successCount}/${bots.length}`);
    if (failedCount > 0) {
      console.log(`  Failed:  ${failedCount}/${bots.length}`);
      console.log('');
      console.log('  ┌── Failed accounts ───────────────────────────────────');
      for (const f of failedAccounts) {
        console.log(`  │ ${f.email}`);
        console.log(`  │   reason: ${f.reason}`);
      }
      console.log('  └──────────────────────────────────────────────────────');
      console.log('');
      console.log('  HOW TO FIX:');
      console.log('  • Gmail accounts: add `emailAppPassword` to accounts.json');
      console.log('    (Generate at: https://myaccount.google.com/apppasswords)');
      console.log('  • Non-gmail: re-run OTP mode and type the 6-digit code');
      console.log('    when prompted. Make sure you run in a real terminal');
      console.log('    (not nohup/background) so the prompt is visible.');
    }
    console.log('');
    console.log('Tokens saved to tokens.json. You can now run the bot with option 1.');
  } finally {
    // Restore dashboard before returning
    dashboard.addLog = origAddLog;
    dashboard.setWaitingOTP(false);
    // Close the shared readline LAST — only after every account is done.
    try { sharedRl.close(); } catch { }
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  // Parse command line args
  const args = process.argv.slice(2);
  const runNow = args.includes('--now') || args.includes('-n');
  const runOtp = args.includes('--otp') || args.includes('-o');
  const showHelp = args.includes('--help') || args.includes('-h');
  const useProxyFlag = args.includes('--proxy') || args.includes('-p');
  const noProxyFlag = args.includes('--no-proxy');

  if (showHelp) {
    console.log(`
HectoBot - Hecto Finance Allocation Bot

Usage: node index.js [options]

Options:
  --now, -n      Execute allocation immediately, then continue scheduled mode
  --otp, -o      Login OTP mode (authenticate all accounts sequentially)
  --proxy, -p    Use proxies from proxy.txt (skip interactive prompt)
  --no-proxy     Skip proxies (skip interactive prompt)
  --help, -h     Show this help message

Configuration (config.json):
  scheduleTime          Time to execute daily (HH:MM format, WIB timezone)
  tokenRefreshIntervalMs  Token refresh interval in milliseconds
  
Files:
  accounts.json   Account credentials (manual)
  tokens.json     Auto-generated tokens
  config.json     Bot configuration
`);
    process.exit(0);
  }

  // Load data
  loadAccounts();
  loadTokens();

  if (!accountsData.accounts || accountsData.accounts.length === 0) {
    console.error('No accounts configured. Please add accounts to accounts.json');
    process.exit(1);
  }

  // =========================================================================
  // TIMEZONE VERIFICATION
  // =========================================================================
  const tzName = getConfiguredTimezone();
  const { hour: schedH, minute: schedM } = parseScheduleHM(settings);
  const sysDate = new Date();
  const dayjsTz = dayjs().tz(tzName);

  console.log('┌─────────────────────────────────────────────────────────┐');
  console.log('│  TIMEZONE VERIFICATION                                  │');
  console.log('├─────────────────────────────────────────────────────────┤');
  console.log(`│  process.env.TZ : ${(process.env.TZ || 'NOT SET').padEnd(38)}│`);
  console.log(`│  Config timezone: ${tzName.padEnd(38)}│`);
  console.log(`│  System UTC     : ${sysDate.toISOString().padEnd(38)}│`);
  console.log(`│  Date (local)   : ${sysDate.toLocaleString('id-ID', { timeZone: tzName }).padEnd(38)}│`);
  console.log(`│  dayjs.tz()     : ${dayjsTz.format('YYYY-MM-DD HH:mm:ss Z').padEnd(38)}│`);
  console.log(`│  Schedule time  : ${`${String(schedH).padStart(2, '0')}:${String(schedM).padStart(2, '0')} daily (${tzName})`.padEnd(38)}│`);
  console.log('└─────────────────────────────────────────────────────────┘');

  const dateHour = parseInt(sysDate.toLocaleString('en-US', { timeZone: tzName, hour: 'numeric', hour12: false }), 10);
  const dayjsHour = dayjsTz.hour();
  if (dateHour !== dayjsHour) {
    console.error(`[!] TIMEZONE MISMATCH: Date says hour=${dateHour}, dayjs says hour=${dayjsHour}`);
    console.error(`[!] This could cause wrong allocation times. Check your Node.js ICU data.`);
  }

  // =========================================================================
  // PROXY MODE: CLI flag or interactive menu
  // =========================================================================
  let useProxy;
  if (useProxyFlag) {
    useProxy = true;
  } else if (noProxyFlag) {
    useProxy = false;
  } else {
    useProxy = await promptProxyMode();
  }

  if (useProxy) {
    loadProxies();
    if (proxyList.length === 0) {
      console.log('  \x1b[33m⚠ No proxies found in proxy.txt — continuing without proxy\x1b[0m');
    }
  } else {
    console.log('  \x1b[90m↳ Running without proxy (direct connection)\x1b[0m');
  }

  // Create dashboard with accounts list
  const dashboard = new Dashboard(accountsData.accounts);

  // Create bots for each account. Each bot's constructor calls getNextProxy(),
  // which returns null when proxyList is empty — so bots run direct in no-proxy mode.
  const bots = accountsData.accounts.map(account => new HectoBot(account, dashboard));

  // Create market tracker
  const marketTracker = new MarketTracker();

  // Create scheduler
  const scheduler = new Scheduler(dashboard, bots, marketTracker);

  // Handle exit
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    process.exit(0);
  });

  // =========================================================================
  // DETERMINE MODE: CLI flag or interactive menu
  // =========================================================================
  let selectedMode = null;

  if (runOtp) {
    selectedMode = '2'; // OTP mode from CLI
  } else if (runNow) {
    selectedMode = '1'; // Run bot + immediate allocation from CLI
  } else {
    // Interactive menu
    showStartupMenu();
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    selectedMode = await new Promise(resolve => {
      rl.question('  Select option (1 or 2): ', answer => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }

  // =========================================================================
  // MODE 2: OTP Login
  // =========================================================================
  if (selectedMode === '2') {
    await runOTPMode(bots, dashboard);
    process.exit(0);
  }

  // =========================================================================
  // MODE 1: Run Bot
  // =========================================================================
  if (runNow) {
    dashboard.addLog('Running immediate allocation (--now)', 'info');

    const companies = await marketTracker.fetchMarketData();
    dashboard.setCompanies(companies);
    marketTracker.savePreviousData();

    const nextTime = scheduler.getNextExecutionTime();
    dashboard.setNextExecution(nextTime.toLocaleString('id-ID', { timeZone: getConfiguredTimezone() }));

    // Init accounts SEQUENTIALLY to prevent OTP overlap
    const INIT_TIMEOUT = 240000;
    dashboard.addLog(`Initializing ${bots.length} accounts (sequential)...`, 'info');

    let initSuccess = 0;
    for (let i = 0; i < bots.length; i++) {
      const bot = bots[i];
      try {
        const initWithTimeout = Promise.race([
          (async () => {
            const authOk = await bot.ensureAuthenticated();
            if (!authOk) {
              dashboard.setAccountState(bot.email, { tokenExpiry: 'AUTH FAILED' });
              return { success: true, degraded: true };
            }
            await bot.updateState();
            return { success: true };
          })(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Init timeout')), INIT_TIMEOUT)
          )
        ]);

        await initWithTimeout;
        initSuccess++;
      } catch (error) {
        bot.log(`Init error: ${error.message}`, 'error');
        dashboard.setAccountState(bot.email, { tokenExpiry: 'INIT FAILED' });
      }
    }
    dashboard.addLog(`Init complete: ${initSuccess}/${bots.length} ready`, initSuccess > 0 ? 'success' : 'error');

    await scheduler.executeAllocation();

    for (const bot of bots) {
      try { await bot.updateState(); } catch { }
    }

    dashboard.addLog('Immediate execution completed, continuing scheduled mode...', 'success');
  }

  // Always start the scheduler (bot stays active forever)
  await scheduler.start();
}

main().catch(console.error);
