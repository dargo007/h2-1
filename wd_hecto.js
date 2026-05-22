#!/usr/bin/env node
/**
 * wd_hecto.js - Independent CC Withdrawal Bot for Supanova
 * 
 * Features:
 * - Reads accounts from accounts.json
 * - Auto-generates tokens_wd.json for session management
 * - Prompts for destination address & reserve CC
 * - Smart fee determination via API
 * - Full transfer flow: prepare → sign → submit → poll
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const h = require('./wd_helpers');

// ── File Paths ──
const ACCOUNTS_PATH = path.join(__dirname, 'accounts.json');
const TOKENS_PATH = path.join(__dirname, 'tokens_wd.json');
const CONFIG_PATH = path.join(__dirname, 'config.json');

// ── Load Config ──
let CONFIG = {};
try { CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}

// ── Colors ──
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
  white: '\x1b[37m', gray: '\x1b[90m',
  bgBlue: '\x1b[44m', bgGreen: '\x1b[42m', bgRed: '\x1b[41m', bgYellow: '\x1b[43m'
};

// ── Load/Save ──
function loadAccounts() {
  try {
    return JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8'));
  } catch (e) {
    console.log(`${C.red}✗ Failed to load accounts.json: ${e.message}${C.reset}`);
    process.exit(1);
  }
}

function loadTokens() {
  try {
    if (fs.existsSync(TOKENS_PATH)) {
      return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
    }
  } catch {}
  return { accounts: {} };
}

function saveTokens(tokensData) {
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokensData, null, 2) + '\n');
}

function saveAccountToken(tokensData, email, data) {
  tokensData.accounts[email] = {
    token: data.token,
    pat: data.pat || '',
    refreshToken: data.refreshToken || '',
    caid: data.caid || crypto.randomUUID(),
    partyId: data.partyId || '',
    walletId: data.walletId || '',
    tokenExpiry: h.getTokenExpiry(data.token),
    lastRefresh: new Date().toISOString()
  };
  saveTokens(tokensData);
}

// ── UI Helpers ──
function printHeader() {
  console.clear();
  console.log(`${C.cyan}${C.bold}`);
  console.log(`  ╔══════════════════════════════════════════════════╗`);
  console.log(`  ║       🏦  WD HectoBot - CC Withdrawal Bot      ║`);
  console.log(`  ║          Supanova → Your Wallet                 ║`);
  console.log(`  ╚══════════════════════════════════════════════════╝${C.reset}`);
  console.log();
}

function printDivider(label = '') {
  if (label) {
    console.log(`${C.gray}  ──── ${C.white}${C.bold}${label}${C.reset}${C.gray} ${'─'.repeat(Math.max(0, 44 - label.length))}${C.reset}`);
  } else {
    console.log(`${C.gray}  ${'─'.repeat(52)}${C.reset}`);
  }
}

function printAccountRow(idx, email, balance, status, statusColor = C.gray) {
  const name = email.length > 28 ? email.substring(0, 26) + '..' : email;
  const bal = balance !== null ? `${balance.toFixed(4)} CC` : '---';
  console.log(`  ${C.dim}${String(idx + 1).padStart(2)}.${C.reset} ${C.white}${name.padEnd(30)}${C.reset} ${C.yellow}${bal.padStart(12)}${C.reset} ${statusColor}${status}${C.reset}`);
}

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

// ── Auth Flow (Manual OTP Only, with Proxy) ──
async function ensureAuth(email, account, tokensData, sharedRl) {
  const saved = tokensData.accounts[email] || {};
  const acctState = {
    token: saved.token || '',
    pat: saved.pat || '',
    refreshToken: saved.refreshToken || '',
    caid: saved.caid || crypto.randomUUID(),
    partyId: account.partyId || saved.partyId || '',
    walletId: saved.walletId || ''
  };

  // Get a dedicated proxy for this account (same IP for send+verify)
  const proxy = h.getNextProxy();

  // Try refresh first
  if (acctState.token && !h.isTokenExpired(acctState.token)) {
    const refreshed = await h.refreshToken(acctState, proxy);
    if (refreshed) {
      saveAccountToken(tokensData, email, acctState);
      return acctState;
    }
    if (!h.isTokenExpired(acctState.token)) return acctState;
  }

  // Try refresh with existing refresh token
  if (acctState.refreshToken) {
    const refreshed = await h.refreshToken(acctState, proxy);
    if (refreshed) {
      saveAccountToken(tokensData, email, acctState);
      return acctState;
    }
  }

  // Need full login - Manual OTP
  console.log(`  ${C.yellow}⚡ Login required${C.reset}`);
  try {
    await h.sendOTP(email, acctState.caid, proxy);
    console.log(`  ${C.bgYellow}${C.bold} OTP SENT ${C.reset} Check inbox for ${C.cyan}${email}${C.reset}`);
    for (let tries = 0; tries < 3; tries++) {
      const code = await ask(sharedRl, `  ${C.yellow}Enter 6-digit OTP: ${C.reset}`);
      const trimmed = (code || '').trim();
      if (!/^\d{6}$/.test(trimmed)) {
        console.log(`  ${C.red}Invalid format. Need 6 digits.${C.reset}`);
        continue;
      }
      try {
        const result = await h.verifyOTP(email, trimmed, acctState.caid, proxy);
        acctState.token = result.token;
        acctState.pat = result.pat;
        acctState.refreshToken = result.refreshToken;
        saveAccountToken(tokensData, email, acctState);
        console.log(`  ${C.green}✓ Login OK! Expires: ${h.getExpiryStr(acctState.token)}${C.reset}`);
        return acctState;
      } catch (e) {
        console.log(`  ${C.red}✗ Verify failed: ${e.message}${C.reset}`);
      }
    }
  } catch (e) {
    console.log(`  ${C.red}✗ Login failed: ${e.message}${C.reset}`);
  }
  return null;
}

// ── Transfer Flow ──
async function withdrawAccount(acctState, destAddress, reserveCC) {
  const email = acctState.email;

  // 1. Get balance
  console.log(`  ${C.dim}Fetching balance...${C.reset}`);
  const bal = await h.getBalance(acctState.token);
  acctState.partyId = bal.partyId;
  console.log(`  ${C.white}Balance: ${C.yellow}${bal.ccUnlocked.toFixed(4)}${C.white} CC (unlocked) | ${C.dim}${bal.ccLocked.toFixed(4)} locked${C.reset}`);

  if (bal.ccUnlocked <= reserveCC) {
    console.log(`  ${C.yellow}⚠ Balance (${bal.ccUnlocked.toFixed(4)}) ≤ reserve (${reserveCC}). Skipping.${C.reset}`);
    return { email, status: 'skipped', reason: 'low_balance', balance: bal.ccUnlocked };
  }

  // 2. Calculate fee - use config.withdrawFee if set, otherwise API
  let flatFee;
  if (CONFIG.withdrawFee != null) {
    flatFee = CONFIG.withdrawFee;
    console.log(`  ${C.white}Fee: ${C.cyan}${flatFee.toFixed(4)} CC${C.white} (from config.json)${C.reset}`);
  } else {
    console.log(`  ${C.dim}Calculating transfer fee from API...${C.reset}`);
    flatFee = await h.getTransferFee(bal.partyId, acctState.token);
    console.log(`  ${C.white}Fee: ${C.cyan}${flatFee.toFixed(4)} CC${C.white} (from API)${C.reset}`);
  }

  // 3. Smart amount calculation: sendable = available - flatFee
  const available = bal.ccUnlocked - reserveCC;
  const sendAmount = Math.floor((available - flatFee) * 10000) / 10000; // Round down to 4 decimals
  const estimatedFee = flatFee;

  if (sendAmount <= 0) {
    console.log(`  ${C.yellow}⚠ Nothing to send after fee deduction. Skipping.${C.reset}`);
    return { email, status: 'skipped', reason: 'insufficient_after_fee', balance: bal.ccUnlocked };
  }

  console.log(`  ${C.white}Send: ${C.green}${C.bold}${sendAmount.toFixed(4)} CC${C.reset} ${C.white}| Fee: ~${C.red}${estimatedFee.toFixed(4)} CC${C.white} | Reserve: ${C.cyan}${reserveCC} CC${C.reset}`);

  // 4-7. Prepare → Sign → Submit (with BAD SIGNATURE retry)
  const MAX_SIG_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_SIG_RETRIES; attempt++) {
    // 4. Prepare transfer
    console.log(`  ${C.dim}Preparing transfer${attempt > 1 ? ` (retry ${attempt})` : ''}...${C.reset}`);
    const prepared = await h.prepareTransfer(destAddress, sendAmount.toFixed(10), acctState.token);
    if (!prepared.hash) throw new Error('No hash from prepare_transfer');
    console.log(`  ${C.green}✓ Hash: ${prepared.hash.substring(0, 20)}...${C.reset}`);

    // 5. Get wallet auth key (fresh each attempt)
    console.log(`  ${C.dim}Authenticating wallet...${C.reset}`);
    const walletAuth = await h.getWalletAuthKey(acctState.token, acctState.caid);
    if (!walletAuth.walletId) throw new Error('No wallet ID from auth');
    acctState.walletId = walletAuth.walletId;
    console.log(`  ${C.green}✓ Wallet: ${walletAuth.walletId}${C.reset}`);

    // 6. Sign
    console.log(`  ${C.dim}Signing transaction...${C.reset}`);
    const signature = await h.signHash(
      prepared.hash, walletAuth.walletId,
      acctState.token, acctState.caid, walletAuth.authKey
    );
    console.log(`  ${C.green}✓ Signed${C.reset}`);

    // 7. Submit
    console.log(`  ${C.dim}Submitting transaction...${C.reset}`);
    try {
      const submitResult = await h.submitPrepared(prepared.hash, signature, acctState.token);
      if (!submitResult.submissionId) throw new Error('No submissionId');
      console.log(`  ${C.green}✓ Submitted: ${submitResult.submissionId}${C.reset}`);

      // 8. Poll completion
      console.log(`  ${C.dim}Waiting for confirmation...${C.reset}`);
      const completion = await h.queryCompletion(submitResult.submissionId, acctState.token);
      console.log(`  ${C.green}${C.bold}✓ TRANSFER COMPLETE!${C.reset}`);

      return {
        email, status: 'success', amount: sendAmount,
        fee: estimatedFee, txId: submitResult.submissionId,
        commandId: completion?.commandId || ''
      };
    } catch (submitErr) {
      const msg = submitErr.message || '';
      if (msg.includes('BAD SIGNATURE') && attempt < MAX_SIG_RETRIES) {
        console.log(`  ${C.yellow}⚠ BAD SIGNATURE - retrying with fresh auth (${attempt}/${MAX_SIG_RETRIES})...${C.reset}`);
        await h.sleep(2000);
        continue;
      }
      throw submitErr;
    }
  }
  throw new Error('BAD SIGNATURE after all retries');
}

// ── Main ──
async function main() {
  printHeader();

  // Load data
  const accountsData = loadAccounts();
  const accounts = accountsData.accounts || [];
  let tokensData = loadTokens();

  if (accounts.length === 0) {
    console.log(`  ${C.red}✗ No accounts in accounts.json${C.reset}`);
    process.exit(1);
  }

  console.log(`  ${C.white}Loaded ${C.cyan}${C.bold}${accounts.length}${C.reset}${C.white} accounts from accounts.json${C.reset}`);
  console.log(`  ${C.dim}Token file: tokens_wd.json${C.reset}\n`);

  // ── Phase 1: Get user input FIRST ──
  printDivider('STEP 1: Transfer Config');
  console.log();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // Get destination address
  console.log(`  ${C.white}Enter destination party ID (supa1::... or similar)${C.reset}`);
  const destAddress = await ask(rl, `  ${C.cyan}→ Address: ${C.reset}`);
  if (!destAddress || destAddress.trim().length < 10) {
    console.log(`  ${C.red}✗ Invalid address${C.reset}`);
    rl.close();
    process.exit(1);
  }

  // Get reserve CC
  console.log();
  console.log(`  ${C.white}Enter reserve CC per account (amount to keep, default: 0.5)${C.reset}`);
  const reserveInput = await ask(rl, `  ${C.cyan}→ Reserve CC: ${C.reset}`);
  const reserveCC = parseFloat(reserveInput) || 0.5;

  console.log();
  console.log(`  ${C.white}Destination:  ${C.cyan}${destAddress.trim()}${C.reset}`);
  console.log(`  ${C.white}Reserve:      ${C.cyan}${reserveCC} CC${C.white} per account${C.reset}`);
  console.log();

  // ── Phase 2: Login all accounts (Manual OTP) ──
  printDivider('STEP 2: Authentication (Manual OTP)');
  console.log();

  const authedAccounts = [];
  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    const email = account.email;
    console.log(`  ${C.cyan}[${i + 1}/${accounts.length}]${C.reset} ${C.white}${email}${C.reset}`);

    const acctState = await ensureAuth(email, account, tokensData, rl);
    if (acctState) {
      acctState.email = email;
      authedAccounts.push(acctState);
      console.log(`  ${C.green}✓ Authenticated (${h.getExpiryStr(acctState.token)})${C.reset}\n`);
    } else {
      console.log(`  ${C.red}✗ Auth failed, skipping${C.reset}\n`);
    }

    if (i < accounts.length - 1) await h.sleep(2000);
  }

  saveTokens(tokensData);
  console.log(`  ${C.green}${C.bold}✓ ${authedAccounts.length}/${accounts.length} accounts authenticated${C.reset}`);
  console.log(`  ${C.dim}Session saved to tokens_wd.json${C.reset}\n`);

  if (authedAccounts.length === 0) {
    console.log(`  ${C.red}✗ No authenticated accounts. Exiting.${C.reset}`);
    rl.close();
    process.exit(1);
  }

  // ── Phase 3: Show balances ──
  printDivider('STEP 3: Balance Check');
  console.log();

  for (let i = 0; i < authedAccounts.length; i++) {
    const a = authedAccounts[i];
    try {
      const bal = await h.getBalance(a.token);
      a.balance = bal;
      a.partyId = bal.partyId;
      printAccountRow(i, a.email, bal.ccUnlocked,
        bal.ccUnlocked > 0 ? '✓ ready' : '○ empty',
        bal.ccUnlocked > 0 ? C.green : C.gray);
    } catch (e) {
      a.balance = null;
      printAccountRow(i, a.email, null, `✗ ${e.message.substring(0, 20)}`, C.red);
    }
  }

  const totalCC = authedAccounts.reduce((sum, a) => sum + (a.balance?.ccUnlocked || 0), 0);
  console.log();
  console.log(`  ${C.white}Total unlocked CC: ${C.yellow}${C.bold}${totalCC.toFixed(4)} CC${C.reset}`);
  console.log();

  // Confirm
  printDivider('CONFIRM');
  console.log();
  console.log(`  ${C.white}Destination:  ${C.cyan}${destAddress.trim()}${C.reset}`);
  console.log(`  ${C.white}Reserve:      ${C.cyan}${reserveCC} CC${C.reset}`);
  console.log(`  ${C.white}Accounts:     ${C.cyan}${authedAccounts.filter(a => (a.balance?.ccUnlocked || 0) > reserveCC).length}${C.white} with sendable balance${C.reset}`);
  console.log();
  const confirm = await ask(rl, `  ${C.yellow}${C.bold}Proceed with withdrawal? (y/N): ${C.reset}`);

  if (confirm.toLowerCase() !== 'y') {
    console.log(`  ${C.yellow}Cancelled.${C.reset}`);
    rl.close();
    process.exit(0);
  }

  // ── Phase 4: Execute Withdrawals ──
  rl.close();
  console.log();
  printDivider('STEP 4: Executing Withdrawals');
  console.log();

  const results = [];
  let successCount = 0;
  let totalSent = 0;

  for (let i = 0; i < authedAccounts.length; i++) {
    const a = authedAccounts[i];
    console.log(`\n  ${C.bgBlue}${C.bold} ${i + 1}/${authedAccounts.length} ${C.reset} ${C.white}${C.bold}${a.email}${C.reset}`);

    try {
      // Refresh token if needed before transfer
      if (h.isTokenExpired(a.token) || h.getTokenExpiry(a.token) - Math.floor(Date.now() / 1000) < 300) {
        console.log(`  ${C.dim}Refreshing token...${C.reset}`);
        const refreshed = await h.refreshToken(a);
        if (refreshed) {
          saveAccountToken(tokensData, a.email, a);
        } else {
          console.log(`  ${C.red}✗ Token refresh failed. Skipping.${C.reset}`);
          results.push({ email: a.email, status: 'failed', reason: 'token_expired' });
          continue;
        }
      }

      const result = await withdrawAccount(a, destAddress.trim(), reserveCC);
      results.push(result);

      if (result.status === 'success') {
        successCount++;
        totalSent += result.amount;
      }

      // Save updated wallet ID
      saveAccountToken(tokensData, a.email, a);

    } catch (e) {
      console.log(`  ${C.red}${C.bold}✗ FAILED: ${e.message}${C.reset}`);
      results.push({ email: a.email, status: 'failed', reason: e.message.substring(0, 80) });
    }

    // Delay between accounts to avoid rate limits
    if (i < authedAccounts.length - 1) {
      console.log(`  ${C.dim}Cooldown 3s...${C.reset}`);
      await h.sleep(3000);
    }
  }

  // ── Final Report ──
  console.log('\n');
  printDivider('FINAL REPORT');
  console.log();

  const maxEmail = 30;
  console.log(`  ${C.dim}${'#'.padStart(3)}  ${'Account'.padEnd(maxEmail)}  ${'Status'.padEnd(10)}  ${'Amount'.padEnd(14)}  Detail${C.reset}`);
  console.log(`  ${C.dim}${'─'.repeat(80)}${C.reset}`);

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const name = r.email.length > maxEmail ? r.email.substring(0, maxEmail - 2) + '..' : r.email;
    let statusStr, amountStr, detail;

    if (r.status === 'success') {
      statusStr = `${C.green}SUCCESS${C.reset}`;
      amountStr = `${C.green}${r.amount.toFixed(4)} CC${C.reset}`;
      detail = `${C.dim}fee: ${r.fee.toFixed(4)}${C.reset}`;
    } else if (r.status === 'skipped') {
      statusStr = `${C.yellow}SKIP${C.reset}`;
      amountStr = `${C.dim}---${C.reset}`;
      detail = `${C.dim}${r.reason}${C.reset}`;
    } else {
      statusStr = `${C.red}FAIL${C.reset}`;
      amountStr = `${C.dim}---${C.reset}`;
      detail = `${C.red}${(r.reason || '').substring(0, 30)}${C.reset}`;
    }

    console.log(`  ${C.dim}${String(i + 1).padStart(3)}${C.reset}  ${C.white}${name.padEnd(maxEmail)}${C.reset}  ${statusStr.padEnd(19)}  ${amountStr.padEnd(23)}  ${detail}`);
  }

  console.log();
  console.log(`  ${C.gray}${'─'.repeat(52)}${C.reset}`);
  console.log(`  ${C.white}Total sent:    ${C.green}${C.bold}${totalSent.toFixed(4)} CC${C.reset}`);
  console.log(`  ${C.white}Success:       ${C.green}${successCount}${C.white}/${results.length}${C.reset}`);
  console.log(`  ${C.white}Failed/Skip:   ${C.red}${results.length - successCount}${C.reset}`);
  console.log(`  ${C.white}Destination:   ${C.cyan}${destAddress.trim().substring(0, 40)}...${C.reset}`);
  console.log();
  console.log(`  ${C.green}${C.bold}✓ Withdrawal complete!${C.reset}\n`);
}

// ── Run ──
main().catch(e => {
  console.error(`\n  ${C.red}${C.bold}Fatal error: ${e.message}${C.reset}`);
  console.error(e.stack);
  process.exit(1);
});
