// Muestra la dirección y el saldo de ETH de la cuenta configurada en la red elegida.
//   npx hardhat run scripts/saldo.js --network baseSepolia
const { ethers, network } = require("hardhat");

async function main() {
  const [c] = await ethers.getSigners();
  if (!c) throw new Error("No hay cuenta configurada: node scripts/crear-billetera.js");
  const saldo = await ethers.provider.getBalance(c.address);
  console.log(`[${network.name}] ${c.address}: ${ethers.formatEther(saldo)} ETH`);
  if (saldo === 0n) console.log("Sin ETH de prueba todavía: pide en un faucet de Base Sepolia.");
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
