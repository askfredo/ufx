// Mide cuánto gas usa el despliegue completo (en la red local de Hardhat).
const { ethers } = require("hardhat");
async function main() {
  const desde = await ethers.provider.getBlockNumber();
  process.env.FUNDADOR = process.env.FUNDADOR ?? "0x00C2376917cfd246f9DF404F9c59c9bF1EF163Dd";
  const log = console.log; console.log = () => {};
  await require("./desplegar-local.js");
  await new Promise((r) => setTimeout(r, 3000));
  console.log = log;
  const hasta = await ethers.provider.getBlockNumber();
  let gas = 0n;
  for (let b = desde + 1; b <= hasta; b++) {
    const blk = await ethers.provider.getBlock(b, true);
    for (const h of blk.transactions) gas += (await ethers.provider.getTransactionReceipt(h)).gasUsed;
  }
  console.log(`Despliegue: ${hasta - desde} transacciones, ${gas} de gas`);
}
main();
