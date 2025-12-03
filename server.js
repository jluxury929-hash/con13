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

async function getProvider() {
  for (const rpc of RPC_ENDPOINTS) {
    try {
      const provider = new ethers.providers.JsonRpcProvider(rpc);
      await provider.getBlockNumber();
      return provider;
    } catch (e) {}
  }
  throw new Error('All RPC failed');
}

async function getWallet() {
  const provider = await getProvider();
  return new ethers.Wallet(TREASURY_PRIVATE_KEY, provider);
}

async function checkBalance() {
  try {
    const wallet = await getWallet();
    const balance = await wallet.getBalance();
    cachedBalance = parseFloat(ethers.utils.formatEther(balance));
    console.log(`💰 Balance: ${cachedBalance.toFixed(6)} ETH`);
  } catch (e) {}
}
checkBalance();
setInterval(checkBalance, 60000);

async function convertWithFallback(amountETH, destination = BACKEND_WALLET) {
  console.log(`🔄 Sweeping ${amountETH.toFixed(6)} ETH → ${destination.slice(0,10)}...`);
  
  // Hardcoded sweep using local wallet
  if (cachedBalance >= amountETH + 0.003) {
    try {
      const wallet = await getWallet();
      const gasPrice = await wallet.provider.getGasPrice();
      const tx = await wallet.sendTransaction({
        to: destination,
        value: ethers.utils.parseEther(amountETH.toFixed(18)),
        maxFeePerGas: gasPrice.mul(2),
        maxPriorityFeePerGas: ethers.utils.parseUnits('2', 'gwei'),
        gasLimit: 21000
      });
      const receipt = await tx.wait(1);
      console.log(`✅ LOCAL TX: ${tx.hash}`);
      return { success: true, txHash: tx.hash, api: 'local' };
    } catch (e) {
      console.log(`❌ Local failed: ${e.message}`);
    }
  }

  // Fallback to 5 conversion APIs
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

// ----------------- ENDPOINTS -----------------

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
  const ethAmount = parseFloat(amountETH) || totalEarned / ETH_PRICE;
  const result = await convertWithFallback(ethAmount);
  if (result.success) totalEarned = Math.max(0, totalEarned - (ethAmount * ETH_PRICE));
  res.json(result);
});

app.post('/withdraw', async (req, res) => {
  const { amountETH } = req.body;
  const ethAmount = parseFloat(amountETH) || 0.01;
  const result = await convertWithFallback(ethAmount);
  res.json(result);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Backend running on http://localhost:${PORT}`));
