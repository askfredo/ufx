// Despliega UFX completo con tokens de mentira y lo deja listo para usar.
//   Local:         npx hardhat node   y luego   npx hardhat run scripts/desplegar-local.js --network localhost
//   Red de prueba: npx hardhat run scripts/desplegar-local.js --network baseSepolia
// Guarda las direcciones en deployments/<red>.json.
// En una red pública hay una sola cuenta: ella arma el colchón y hace la primera compra.
// FUNDADOR=0x...  dirección que recibe la comisión (por defecto, la misma cuenta que despliega).
//                 Solo hace falta la dirección pública: la clave de esa billetera nunca entra aquí.
const fs = require("fs");
const { ethers, network } = require("hardhat");

const e18 = (n) => ethers.parseUnits(String(n), 18);
const num = (x) => Number(ethers.formatUnits(x, 18));

// Canasta "real" de la primera versión: lo que hoy se puede conectar con tokens reales.
const canasta = [
  ["Bonos (sUSDS)", "tBONO", 4000, 100],
  ["Acciones S&P 500", "tSPY", 3000, 100],
  ["Oro (PAXG)", "tORO", 2500, 100],
  ["Bitcoin", "tBTC", 500, 100],
];

async function main() {
  const firmantes = await ethers.getSigners();
  if (firmantes.length === 0) throw new Error("No hay cuenta: npx hardhat vars set DEPLOYER_KEY");
  const [dueno] = firmantes;
  const colchon = firmantes[1] ?? dueno;
  const ahorrador = firmantes[2] ?? dueno;
  const esperar = async (tx) => (await tx).wait();
  const fundador = process.env.FUNDADOR ? ethers.getAddress(process.env.FUNDADOR) : dueno.address;
  const desplegar = async (nombre, ...args) => {
    const c = await (await ethers.getContractFactory(nombre)).deploy(...args);
    await c.waitForDeployment();
    return c;
  };
  const dolar = await desplegar("TokenPrueba", "USD de prueba", "tUSDC");
  const activos = [];
  for (const [n, s] of canasta) activos.push(await desplegar("TokenPrueba", n, s));
  const oraculo = await desplegar("OraculoPrueba");
  const mercado = await desplegar("MercadoPrueba", oraculo, dolar);

  const ufx = await desplegar("UFIndexada", dolar, mercado, oraculo, activos, canasta.map((c) => c[2]), {
    tasaFijaBps: 200,                 // inflación + 2%
    pisoStable: true, margenBps: 50,  // ...o T-bills + 0,5%, lo que sea mayor
    fundador,
    comisionBps: 10,                  // 0,1% anual (desde el segundo año)
    metaArranque: e18(1000),          // $1.000 de colchón para abrir
    cuotaEntradaBps: 200, multaSalidaBps: 100,
    recompensaUsd: e18("0.05"),       // propina para bots que llaman mantener()
    rebalanceoCada: 30 * 86400,       // rebalanceo mensual
  });


  for (let i = 0; i < activos.length; i++) await esperar(oraculo.fijarPrecio(activos[i], e18(canasta[i][3])));
  await esperar(oraculo.fijarPrecio(await ufx.IPC(), e18(1)));
  await esperar(oraculo.fijarPrecio(await ufx.TBILL(), e18(0.04)));

  // Se arma el colchón y entra un primer ahorrador.
  await esperar(dolar.regalar(colchon.address, e18(1000)));
  await esperar(dolar.connect(colchon).approve(ufx, ethers.MaxUint256));
  await (await ufx.connect(colchon).aportarColchon(e18(1000))).wait();
  await esperar(dolar.regalar(ahorrador.address, e18(100)));
  await esperar(dolar.connect(ahorrador).approve(ufx, ethers.MaxUint256));
  await (await ufx.connect(ahorrador).acunar(e18(100))).wait();

  const direcciones = {
    red: network.name, ufx: await ufx.getAddress(), dolar: await dolar.getAddress(),
    ufxc: await ufx.partes(), oraculo: await oraculo.getAddress(), mercado: await mercado.getAddress(),
    activos: Object.fromEntries(await Promise.all(canasta.map(async (c, i) => [c[1], await activos[i].getAddress()]))),
    precios: Object.fromEntries(canasta.map((c) => [c[1], c[3]])), ipc: 1, tbill: 0.04,
    fundador,
  };
  fs.mkdirSync("deployments", { recursive: true });
  fs.writeFileSync(`deployments/${network.name}.json`, JSON.stringify(direcciones, null, 2));

  console.log(`UFX desplegada en la red "${network.name}": ${direcciones.ufx}`);
  console.log(`Canasta: ${canasta.map((c) => `${c[2] / 100}% ${c[0]}`).join(" · ")}`);
  console.log(`Colchón: $${num(await ufx.colchon()).toFixed(2)} · UFX abierta: ${(await ufx.abiertoDesde()) > 0n}`);
  console.log(`Ahorrador ${ahorrador.address}: ${num(await ufx.balanceOf(ahorrador.address)).toFixed(4)} UFX a $${num(await ufx.precioUnidad()).toFixed(4)}`);
  console.log(`Respaldo: ${(Number(await ufx.ratio()) / 100).toFixed(0)}%`);
  console.log(`Comisión del fundador va a: ${fundador}`);
  console.log(`Direcciones guardadas en deployments/${network.name}.json`);
  console.log(`\nPara SKILL.md:\n| UFX (\`UFIndexada\`) | \`${direcciones.ufx}\` |\n| UFXC (risk pool token) | \`${direcciones.ufxc}\` |\n| Test USD (\`tUSDC\`) | \`${direcciones.dolar}\` |`);
  console.log(`\nOJO: el oráculo de prueba rechaza precios de más de 2 días. Corre scripts/publicar-precios.js al menos una vez al día.`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
