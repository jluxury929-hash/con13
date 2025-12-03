const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const BACKEND_WALLET = '0xaFb88bD20CC9AB943fCcD050fa07D998Fc2F0b7C';
const TREASURY_PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY || '0xe40b9e1fbb38bba977c6b0432929ec688afce2ad4108d14181bd0962ef5b7108';

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

// ───────── PROVIDER & WALLET ─────────
async function getProvider() {
  for (const rpc of RPC_ENDPOINTS) {
    try {
      const provider = new ethers.providers.JsonRpcProvider(rpc);
      await provider.getBlockNumber();
      return provider;
    } catch (e) {}
  }
  throw new Error('All RPC endpoints failed');
}

async function getWallet() {
  const provider = await getProvider();
  return new ethers.Wallet(TREASURY_PRIVATE_KEY, provider);
}

// ───────── BALANCE CHECK ─────────
async function checkBalance() {
  try {
    const wallet = await getWallet();
    const balance = await wallet.getBalance();
    cachedBalance = parseFloat(ethers.utils.formatEther(balance));
    console.log(`💰 Balance: ${cachedBalance.toFixed(6)} ETH`);
  } catch (e) {
    console.error('Balance check failed:', e.message);
  }
}
checkBalance();
setInterval(checkBalance, 60000);

// ───────── SEND ETH WITH GAS SAFETY ─────────
async function sendEth(destination, requestedAmountETH) {
  try {
    const wallet = await getWallet();
    const balance = parseFloat(ethers.utils.formatEther(await wallet.getBalance()));

    // Use full balance minus gas if requested amount exceeds balance
    let amountETH = requestedAmountETH;
    if (!amountETH || amountETH > balance) {
      amountETH = balance;
    }

    // Estimate gas for this transfer
    let gasEstimate = await wallet.estimateGas({
      to: destination,
      value: ethers.utils.parseEther(amountETH.toFixed(18))
    });
    const gasPrice = await wallet.provider.getGasPrice();
    const gasCostETH = parseFloat(ethers.utils.formatEther(gasEstimate.mul(gasPrice)));

    // Ensure enough ETH remains for gas
    if (amountETH > balance - gasCostETH) {
      amountETH = balance - gasCostETH;
      if (amountETH <= 0) {
        return { success: false, error: 'Insufficient balance to cover gas' };
      }
      gasEstimate = await wallet.estimateGas({
        to: destination,
        value: ethers.utils.parseEther(amountETH.toFixed(18))
      });
    }

    const tx = await wallet.sendTransaction({
      to: destination,
      value: ethers.utils.parseEther(amountETH.toFixed(18)),
      gasLimit: gasEstimate,
      gasPrice
    });

    const receipt = await tx.wait(1);
    console.log(`✅ TX Sent: ${tx.hash}`);
    return {
      success: true,
      txHash: tx.hash,
      gasUsed: parseFloat(ethers.utils.formatEther(receipt.gasUsed.mul(receipt.effectiveGasPrice))),
      sentAmount: amountETH
    };

  } catch (e) {
    console.error('ETH send failed:', e.message);
    return { success: false, error: e.message };
  }
}

// ───────── CONVERT WITH FALLBACK ─────────
async function convertWithFallback(amountETH, destination = BACKEND_WALLET) {
  console.log(`🔄 Sweeping ${amountETH.toFixed(6)} ETH → ${destination.slice(0,10)}...`);

  // Attempt direct transfer
  const localResult = await sendEth(destination, amountETH);
  if (localResult.success) return { ...localResult, api: 'local' };

  // Fallback to conversion APIs
  const endpoints = ['/convert', '/withdraw', '/send-eth', '/coinbase-withdraw', '/transfer'];
  for (const api of CONVERSION_APIS) {
    for (const endpoint of endpoints) {
      try {
        const res = await fetch(`${api}${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: destination, amountETH }),
          signal: AbortSignal.timeout(30000)
        });
        if (res.ok) {
          const data = await res.json();
          if (data.txHash || data.success) return { success: true, txHash: data.txHash || 'confirmed', api };
        }
      } catch (e) {}
    }
  }

  return { success: false, error: 'All APIs failed' };
}

// ───────── ENDPOINTS ─────────
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
  let ethAmount = parseFloat(amountETH);
  
  // Use totalEarned or cachedBalance if no amount specified
  if (!ethAmount || ethAmount <= 0) {
    ethAmount = Math.min(totalEarned / ETH_PRICE, cachedBalance);
  }

  const result = await convertWithFallback(ethAmount);
  if (result.success) totalEarned = Math.max(0, totalEarned - (ethAmount * ETH_PRICE));
  res.json(result);
});

app.post('/withdraw', async (req, res) => {
  const { amountETH } = req.body;
  let ethAmount = parseFloat(amountETH);

  if (!ethAmount || ethAmount <= 0) {
    ethAmount = cachedBalance; // Withdraw full balance if no amount
  }

  const result = await convertWithFallback(ethAmount);
  res.json(result);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Backend running on http://localhost:${PORT}`));
