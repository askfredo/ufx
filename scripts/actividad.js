// Muestra quién ha usado UFX en la red de prueba: depósitos, retiros, colchón, mantención y USD de prueba acuñado.
//   npx hardhat run scripts/actividad.js --network baseSepolia
// Separa las operaciones nuestras (la billetera que despliega) de las de cualquier otra dirección.
const fs = require("fs");
const { ethers, network } = require("hardhat");

const num = (x) => Number(ethers.formatUnits(x, 18));
const TRAMO = Number(process.env.TRAMO ?? 200); // el RPC público de Base Sepolia limita eth_getLogs a 200 bloques
const BLOQUES = Number(process.env.BLOQUES ?? 6000); // cuánto mirar hacia atrás (~2 s por bloque)

// Todos los logs de una dirección en el rango, en tramos, decodificados con la interfaz del contrato.
async function logs(contrato, desde, hasta) {
  const dir = await contrato.getAddress();
  const out = [];
  for (let b = desde; b <= hasta; b += TRAMO) {
    for (const l of await ethers.provider.getLogs({ address: dir, fromBlock: b, toBlock: Math.min(b + TRAMO - 1, hasta) })) {
      try { out.push({ ...contrato.interface.parseLog(l), blockNumber: l.blockNumber }); } catch {}
    }
  }
  return out;
}

async function revisar(archivo, nuestras) {
  const d = JSON.parse(fs.readFileSync(archivo, "utf8"));
  const ufx = await ethers.getContractAt("UFIndexada", d.ufx);
  const dolar = await ethers.getContractAt("TokenPrueba", d.dolar);
  const hasta = await ethers.provider.getBlockNumber();
  const desde = Math.max(d.bloque ?? 0, hasta - BLOQUES);
  const esNuestra = (a) => nuestras.has(a.toLowerCase());

  const tipos = {
    Acunado: ["deposita en UFX", (e) => e.args[0], (e) => e.args[2]],
    Quemado: ["retira de UFX", (e) => e.args[0], (e) => e.args[3]],
    ColchonAportado: ["aporta al colchón", (e) => e.args[0], (e) => e.args[1]],
    ColchonRetirado: ["retira del colchón", (e) => e.args[0], (e) => e.args[2]],
    Mantenido: ["mantiene (bot)", (e) => e.args[0], null],
  };
  const filas = [];
  for (const e of await logs(ufx, desde, hasta)) {
    const t = tipos[e.name];
    if (t) filas.push({ nombre: t[0], quien: t[1](e), monto: t[2] ? `$${num(t[2](e)).toFixed(2)}` : "", bloque: e.blockNumber });
  }
  // USD de prueba acuñado (Transfer desde 0x0) a direcciones que no son el contrato ni el mercado
  const internas = [d.ufx, d.mercado].map((x) => x.toLowerCase());
  for (const e of await logs(dolar, desde, hasta)) {
    if (e.name !== "Transfer" || e.args[0] !== ethers.ZeroAddress || internas.includes(e.args[1].toLowerCase())) continue;
    filas.push({ nombre: "acuña USD de prueba", quien: e.args[1], monto: `$${num(e.args[2]).toFixed(2)}`, bloque: e.blockNumber });
  }

  const externas = filas.filter((f) => !esNuestra(f.quien));
  const dirs = new Set(externas.map((f) => f.quien.toLowerCase()));
  console.log(`\n=== ${archivo}  (UFX ${d.ufx}) · bloques ${desde}–${hasta}`);
  console.log(`Operaciones: ${filas.length} en total · ${filas.length - externas.length} nuestras · ${externas.length} de ${dirs.size} direcciones externas`);
  for (const f of externas.sort((a, b) => a.bloque - b.bloque)) console.log(`  bloque ${f.bloque} · ${f.quien} · ${f.nombre} ${f.monto}`);
  console.log(`Estado: ${num(await ufx.totalSupply()).toFixed(2)} UFX en circulación · respaldo ${(Number(await ufx.ratio()) / 100).toFixed(0)}% · colchón $${num(await ufx.colchon()).toFixed(2)}`);
}

async function main() {
  const [yo] = await ethers.getSigners();
  const nuestras = new Set([yo.address.toLowerCase()]);
  for (const a of ["deployments/" + network.name + "-v1.json", "deployments/" + network.name + ".json"]) {
    if (fs.existsSync(a)) await revisar(a, nuestras).catch((e) => console.log(`\n=== ${a}: no se pudo leer (${e.shortMessage ?? e.message})`));
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
