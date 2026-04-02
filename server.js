import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bs58 from 'bs58';
import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from '@solana/web3.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

const connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
const OUTPUT_STABLE_DEFAULT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const state = {
  running: false,
  timer: null,
  lastCheckAt: null,
  lastError: null,
  history: [],
  feesPaidUsd: 0,
  config: {
    monitorWallet: process.env.MONITOR_WALLET_PUBKEY || '',
    inputMint: process.env.INPUT_MINT || '',
    outputMint: process.env.OUTPUT_MINT || OUTPUT_STABLE_DEFAULT,
    fixedBaselineUsd: Number(process.env.FIXED_BASELINE_USD || 100),
    triggerGainUsd: Number(process.env.TRIGGER_GAIN_USD || 1),
    sellUsdAmount: Number(process.env.SELL_USD_AMOUNT || 0.5),
    pollMs: Number(process.env.POLL_MS || 180000),
    slippageBps: Number(process.env.SLIPPAGE_BPS || 50),
  },
};

const mintDecimalsCache = new Map();

function getSigner() {
  const raw = process.env.SIGNER_PRIVATE_KEY_B58;
  if (!raw) throw new Error('Missing SIGNER_PRIVATE_KEY_B58');
  return Keypair.fromSecretKey(bs58.decode(raw));
}

function assertConfig() {
  const required = ['monitorWallet', 'inputMint', 'outputMint'];
  for (const key of required) {
    if (!state.config[key]) throw new Error(`Missing config: ${key}`);
  }
  if (!process.env.JUP_API_KEY) throw new Error('Missing JUP_API_KEY');
}

async function getMintDecimals(mint) {
  if (mintDecimalsCache.has(mint)) return mintDecimalsCache.get(mint);
  const info = await connection.getParsedAccountInfo(new PublicKey(mint));
  const decimals = info?.value?.data?.parsed?.info?.decimals;
  if (typeof decimals !== 'number') throw new Error(`Unable to resolve decimals for ${mint}`);
  mintDecimalsCache.set(mint, decimals);
  return decimals;
}

async function getTokenBalanceRaw(owner, mint) {
  const ownerPk = new PublicKey(owner);
  const mintPk = new PublicKey(mint);
  const response = await connection.getParsedTokenAccountsByOwner(ownerPk, { mint: mintPk });
  let total = 0n;
  for (const acc of response.value) {
    const amount = acc.account.data.parsed.info.tokenAmount.amount;
    total += BigInt(amount);
  }
  return total;
}

function toUiAmount(rawAmount, decimals) {
  return Number(rawAmount) / (10 ** decimals);
}

async function getQuote(params) {
  const url = new URL(process.env.JUP_QUOTE_URL || 'https://lite-api.jup.ag/swap/v1/quote');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const res = await fetch(url, {
    headers: process.env.JUP_API_KEY ? { 'x-api-key': process.env.JUP_API_KEY } : {},
  });
  if (!res.ok) throw new Error(`Quote failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function getCurrentWalletValueUsd() {
  const rawBalance = await getTokenBalanceRaw(state.config.monitorWallet, state.config.inputMint);
  if (rawBalance <= 0n) return { rawBalance, currentUsdValue: 0 };

  const quote = await getQuote({
    inputMint: state.config.inputMint,
    outputMint: state.config.outputMint,
    amount: rawBalance.toString(),
    slippageBps: state.config.slippageBps,
    swapMode: 'ExactIn',
  });

  const outDecimals = await getMintDecimals(state.config.outputMint);
  const currentUsdValue = Number(quote.outAmount) / (10 ** outDecimals);
  return { rawBalance, currentUsdValue };
}

async function getInputRawForSellUsdAmount() {
  const outDecimals = await getMintDecimals(state.config.outputMint);
  const targetStableRaw = BigInt(Math.round(state.config.sellUsdAmount * (10 ** outDecimals)));

  const quote = await getQuote({
    inputMint: state.config.inputMint,
    outputMint: state.config.outputMint,
    amount: targetStableRaw.toString(),
    slippageBps: state.config.slippageBps,
    swapMode: 'ExactOut',
  });

  return BigInt(quote.inAmount);
}

async function executeOrderSwap(inputRawAmount) {
  const signer = getSigner();
  const orderUrl = new URL(process.env.JUP_ORDER_URL || 'https://api.jup.ag/ultra/v1/order');
  orderUrl.searchParams.set('inputMint', state.config.inputMint);
  orderUrl.searchParams.set('outputMint', state.config.outputMint);
  orderUrl.searchParams.set('amount', inputRawAmount.toString());
  orderUrl.searchParams.set('taker', signer.publicKey.toBase58());
  orderUrl.searchParams.set('slippageBps', String(state.config.slippageBps));

  const orderRes = await fetch(orderUrl, {
    headers: { 'x-api-key': process.env.JUP_API_KEY },
  });
  if (!orderRes.ok) throw new Error(`Order failed: ${orderRes.status} ${await orderRes.text()}`);
  const order = await orderRes.json();
  if (!order.transaction) throw new Error('No transaction returned by Jupiter /order');

  const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, 'base64'));
  tx.sign([signer]);
  const signedTransaction = Buffer.from(tx.serialize()).toString('base64');

  const executeRes = await fetch(process.env.JUP_EXECUTE_URL || 'https://api.jup.ag/ultra/v1/execute', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.JUP_API_KEY,
    },
    body: JSON.stringify({
      signedTransaction,
      requestId: order.requestId,
    }),
  });

  if (!executeRes.ok) throw new Error(`Execute failed: ${executeRes.status} ${await executeRes.text()}`);
  return executeRes.json();
}

async function tick() {
  if (!state.running) return { skipped: true, reason: 'Bot stopped' };
  assertConfig();

  const fixedBaselineUsd = state.config.fixedBaselineUsd;
  const { rawBalance, currentUsdValue } = await getCurrentWalletValueUsd();
  const gainUsd = currentUsdValue - fixedBaselineUsd;

  const holdRecord = {
    time: new Date().toISOString(),
    type: 'CHECK',
    currentUsdValue: Number(currentUsdValue.toFixed(6)),
    fixedBaselineUsd,
    gainUsd: Number(gainUsd.toFixed(6)),
    eligible: gainUsd >= state.config.triggerGainUsd,
    action: 'HOLD',
  };

  if (rawBalance <= 0n) {
    state.lastCheckAt = Date.now();
    state.history.unshift({ ...holdRecord, reason: 'No token balance' });
    return holdRecord;
  }

  if (gainUsd < state.config.triggerGainUsd) {
    state.lastCheckAt = Date.now();
    state.history.unshift({ ...holdRecord, reason: 'Gain below trigger' });
    return holdRecord;
  }

  const sellInputRaw = await getInputRawForSellUsdAmount();
  if (sellInputRaw > rawBalance) {
    state.lastCheckAt = Date.now();
    const result = { ...holdRecord, action: 'HOLD', reason: 'Insufficient input token balance for sell amount' };
    state.history.unshift(result);
    return result;
  }

  const exec = await executeOrderSwap(sellInputRaw);
  state.lastCheckAt = Date.now();

  const sellRecord = {
    time: new Date().toISOString(),
    type: 'CHECK',
    currentUsdValue: Number(currentUsdValue.toFixed(6)),
    fixedBaselineUsd,
    gainUsd: Number(gainUsd.toFixed(6)),
    eligible: true,
    action: 'SELL',
    soldUsdTarget: state.config.sellUsdAmount,
    signature: exec.signature || null,
    orderStatus: exec.status || null,
    note: 'Baseline remains fixed; it does not move after a sell.',
  };

  state.history.unshift(sellRecord);
  return sellRecord;
}

function startBot() {
  if (state.running) return;
  state.running = true;
  state.timer = setInterval(() => {
    tick().catch((err) => {
      state.lastError = err.message;
      state.history.unshift({
        time: new Date().toISOString(),
        type: 'ERROR',
        action: 'ERROR',
        error: err.message,
      });
    });
  }, state.config.pollMs);
}

function stopBot() {
  state.running = false;
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

app.get('/api/status', (req, res) => {
  res.json({
    running: state.running,
    lastCheckAt: state.lastCheckAt,
    lastError: state.lastError,
    feesPaidUsd: state.feesPaidUsd,
    config: state.config,
  });
});

app.get('/api/history', (req, res) => {
  res.json(state.history.slice(0, 200));
});

app.post('/api/config', (req, res) => {
  const next = {
    ...state.config,
    ...req.body,
  };
  next.fixedBaselineUsd = Number(next.fixedBaselineUsd);
  next.triggerGainUsd = Number(next.triggerGainUsd);
  next.sellUsdAmount = Number(next.sellUsdAmount);
  next.pollMs = Number(next.pollMs);
  next.slippageBps = Number(next.slippageBps);
  state.config = next;

  if (state.running) {
    stopBot();
    startBot();
  }

  res.json({ ok: true, config: state.config });
});

app.post('/api/start', (req, res) => {
  state.lastError = null;
  startBot();
  res.json({ ok: true, running: state.running, baselineMode: 'FIXED' });
});

app.post('/api/stop', (req, res) => {
  stopBot();
  res.json({ ok: true, running: state.running });
});

app.post('/api/tick', async (req, res) => {
  try {
    const result = await tick();
    res.json({ ok: true, result });
  } catch (err) {
    state.lastError = err.message;
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Fixed baseline bot listening on ${port}`);
});
