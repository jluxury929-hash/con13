const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const BACKEND_WALLET = '0xaFb88bD20CC9AB943fCcD050fa07D998Fc2F0b7C';
const TREASURY_PRIVATE_KEY =
  process.env.TREASURY_PRIVATE_KEY ||
  '0xe40b9e1fbb38bba977c6b0432929ec688afce2ad4108d14181bd0962ef5b7108';

const CONVERSION_APIS = [
  'https://con6-production.up.railway.app',
  'https://con5-production.up.railway.app',
  'https://con4-production.up.railway.app',
  'https://con3-production.up.railway.app',
  'https://con2-production.up.railway.app'
];

const RPC_ENDPOINTS = [
  'https://ethereum.publicnode.com',
  'https://eth.drpc.org',
  'https://rpc.ankr.com/eth',
  'https://eth.llamarpc.com',
  'https://cloudflare-eth.com',
  'https://eth-mainnet.g.alchemy.com/v2/j6uyDNnArwlEpG44o93SqZ0JixvE20Tq'
];

let cachedBalance = 0;
let totalEarned = 0;
let ETH_PRICE = 3000;

// ───────── PROVIDER (ETHERS v6) ─────────
async function getProvider() {
  for (const rpc of RPC_ENDPOINTS) {
    try {
      const provider = new ethers.JsonRpcProvider(rpc);
      await provider.getBlockNumber();
      return provider;
    } catch (_) {}
  }
  throw new Error('All RPC endpoints failed');
}

// ───────── WALLET (ETHERS v6) ─────────
async function getWallet() {
  const provider = await getProvider();
  return new ethers.Wallet(TREASURY_PRIVATE_KEY, provider);
}

// ───────── BALANCE CHECK (v6) ─────────
async function checkBalance() {
  try {
    const wallet = await getWallet();

    const balanceBigInt = await wallet.provider.getBalance(wallet.address);
    cachedBalance = Number(ethers.formatEther(balanceBigInt));

    console.log(`💰 Balance: ${cachedBalance.toFixed(6)} ETH`);
  } catch (e) {
    console.error('Balance check failed:', e.message);
  }
}
checkBalance();
setInterval(checkBalance, 60000);

// ───────── SEND ETH (ETHERS v6 SAFE) ─────────
async function sendEth(destination, requestedAmountETH) {
  try {
    const wallet = await getWallet();
    const balanceWei = await wallet.provider.getBalance(wallet.address);
    const balance = Number(ethers.formatEther(balanceWei));

    let amountETH = requestedAmountETH;

    if (!amountETH || amountETH > balance) {
      amountETH = balance;
    }

    // Convert to wei
    let valueWei = ethers.parseEther(amountETH.toString());

    // ESTIMATE GAS (v6 BigInt)
    let gasLimit = await wallet.estimateGas({ to: destination, value: valueWei });
    let gasPrice = await wallet.provider.getGasPrice();

    const gasCostWei = gasLimit * gasPrice;

    // Adjust if needed
    if (valueWei + gasCostWei > balanceWei) {
      valueWei = balanceWei - gasCostWei;
      if (valueWei <= 0n) {
        return { success: false, error: 'Insufficient balance to cover gas' };
      }
      gasLimit = await wallet.estimateGas({ to: destination, value: valueWei });
    }

    const tx = await wallet.sendTransaction({
      to: destination,
      value: valueWei,
      gasLimit,
      gasPrice
    });

    const receipt = await tx.wait();

    const gasUsedETH = Number(
      ethers.formatEther(receipt.gasUsed * receipt.effectiveGasPrice)
    );

    return {
      success: true,
      txHash: tx.hash,
      gasUsed: gasUsedETH,
      sentAmount: Number(ethers.formatEther(valueWei))
    };

  } catch (e) {
    console.error('ETH send failed:', e.message);
    return { success: false, error: e.message };
  }
}

// ───────── CONVERT WITH FALLBACK ─────────
async function convertWithFallback(amountETH, destination = BACKEND_WALLET) {
  console.log(`🔄 Sweeping ${amountETH.toFixed(6)} ETH → ${destination.slice(0,10)}...`);

  // 1. Local transfer attempt
  const direct = await sendEth(destination, amountETH);
  if (direct.success) return { ...direct, api: "local" };

  // 2. Fallback API calls
  const endpoints = ['/convert', '/withdraw', '/send-eth', '/coinbase-withdraw', '/transfer'];

  for (const api of CONVERSION_APIS) {
    for (const endpoint of endpoints) {
      try {
        const res = await fetch(`${api}${endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: destination, amountETH }),
          signal: AbortSignal.timeout(30000)
        });

        if (res.ok) {
          const data = await res.json();
          if (data.txHash || data.success)
            return { success: true, txHash: data.txHash || 'confirmed', api };
        }

      } catch (_) {}
    }
  }

  return { success: false, error: "All APIs failed" };
}

// ───────── ROUTES ─────────
app.get('/status', (req, res) => {
  res.json({
    status: 'online',
    wallet: BACKEND_WALLET,
    balance: cachedBalance,
    canEarn: cachedBalance >= 0.01,
    totalEarned
  });
});

app.post('/convert', async (req, res) => {
  const { amountETH } = req.body;
  let ethAmount = Number(amountETH);

  if (!ethAmount || ethAmount <= 0) {
    ethAmount = Math.min(totalEarned / ETH_PRICE, cachedBalance);
  }

  const result = await convertWithFallback(ethAmount);
  if (result.success) totalEarned = Math.max(0, totalEarned - (ethAmount * ETH_PRICE));

  res.json(result);
});

app.post('/withdraw', async (req, res) => {
  const { amountETH } = req.body;
  let ethAmount = Number(amountETH);

  if (!ethAmount || ethAmount <= 0) {
    ethAmount = cachedBalance;
  }

  const result = await convertWithFallback(ethAmount);
  res.json(result);
});

// ───────── SERVER ─────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Backend running on http://localhost:${PORT}`));

