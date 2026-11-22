// Publica precios de prueba en el oráculo y llama mantener(). Correr al menos una vez al día en la red de prueba
// (el oráculo rechaza precios de más de 2 días). Ejemplo con cron, todos los días a las 12:00:
//   0 12 * * *  cd ~/Work/uf-global && npx hardhat run scripts/publicar-precios.js --network baseSepolia
// Los precios dan un paso al azar pequeño cada vez; la inflación avanza ~3% anual y los T-bills quedan en 4%.
const fs = require("fs");
const { ethers, network } = require("hardhat");

const e18 = (n) => ethers.parseUnits(Number(n).toFixed(12), 18);
const num = (x) => Number(ethers.formatUnits(x, 18));
// tendencia y volatilidad diarias por activo
const MOVIMIENTO = { tBONO: [0.0001, 0.001], tSPY: [0.0004, 0.01], tORO: [0.0003, 0.008], tBTC: [0.001, 0.03] };

async function main() {
  // Direcciones en deployments/<red>.json (en git); precios e IPC del día en <red>-estado.json (fuera de git).
  const d = JSON.parse(fs.readFileSync(`deployments/${network.name}.json`, "utf8"));
  const archivo = `deployments/${network.name}-estado.json`;
  if (fs.existsSync(archivo)) Object.assign(d, JSON.parse(fs.readFileSync(archivo, "utf8")));
  const oraculo = await ethers.getContractAt("OraculoPrueba", d.oraculo);
  const ufx = await ethers.getContractAt("UFIndexada", d.ufx);
  const ahora = Date.now() / 1000;
  const dias = d.ultimaPublicacion ? Math.max(0, (ahora - d.ultimaPublicacion) / 86400) : 0;

  for (const [s, dir] of Object.entries(d.activos)) {
    const [tend, vol] = MOVIMIENTO[s] ?? [0, 0.01];
    d.precios[s] *= Math.exp(tend * dias + vol * Math.sqrt(dias) * (Math.random() * 2 - 1) * 1.7);
    await (await oraculo.fijarPrecio(dir, e18(d.precios[s]))).wait();
  }
  d.ipc *= Math.pow(1.03, dias / 365.25);
  await (await oraculo.fijarPrecio(await ufx.IPC(), e18(d.ipc))).wait();
  await (await oraculo.fijarPrecio(await ufx.TBILL(), e18(d.tbill))).wait();
  await (await ufx.mantener()).wait();

  d.ultimaPublicacion = ahora;
  fs.writeFileSync(archivo, JSON.stringify({ precios: d.precios, ipc: d.ipc, tbill: d.tbill, ultimaPublicacion: d.ultimaPublicacion }, null, 2));
  console.log(`[${network.name}] precios: ${Object.entries(d.precios).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(" · ")} · IPC ${d.ipc.toFixed(4)}`);
  console.log(`1 UFX = $${num(await ufx.precioUnidad()).toFixed(4)} · respaldo ${(Number(await ufx.ratio()) / 100).toFixed(0)}% · colchón $${num(await ufx.colchon()).toFixed(2)}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
