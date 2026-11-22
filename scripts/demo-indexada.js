// Demo: UFX v2, "UF Global" indexada. 1 UFX = $1 al inicio y sube con la inflación.
// Respaldo: canasta de toda la economía + un colchón que absorbe las caídas.
// Ejecutar:  npx hardhat run scripts/demo-indexada.js
//
// OJO: los rendimientos por año son un ESCENARIO INVENTADO, no datos históricos.
const { ethers } = require("hardhat");

const e18 = (n) => ethers.parseUnits(n.toFixed(9), 18);
const num = (x) => Number(ethers.formatUnits(x, 18));
const usd = (n) => "$" + n.toLocaleString("es-CL", { maximumFractionDigits: 0 });
const UN_ANIO = 365 * 24 * 60 * 60;

// La economía completa: qué hay en la canasta y su equivalente real tokenizado.
const canasta = [
  // nombre                  símbolo   peso   equivalente real
  ["Acciones globales",      "tACC",   3000], // ETFs tokenizados (Ondo)
  ["Bonos",                  "tBONO",  3000], // USDY / BUIDL
  ["Oro",                    "tORO",   1500], // PAXG / XAUT
  ["Inmuebles",              "tINM",   1000], // casas tokenizadas (RealT)
  ["Energía",                "tWTI",    800], // WTIC
  ["Materias primas/aliment","tMAT",    700], // índice de commodities
];

//               acc   bonos  oro  inmue  energ  mater  inflación
const escenario = [
  [ 14,   4,    8,    6,   10,    5,   3],
  [  9,   4,    2,    5,   -5,    2,   3],
  [-30,   6,   18,  -15,  -35,  -10,   6],  // año 3: gran crisis
  [ 25,   3,   -5,    4,   20,    8,   4],
  [ 11,   4,    4,    6,    5,    3,   3],
  [ -8,   5,   10,    2,   15,    9,   3],
  [ 17,   4,    3,    5,  -10,    0,   2],
  [ 10,   4,   -2,    6,    5,    2,   2],
  [-15,   6,   12,   -6,  -20,   -4,   4],  // año 9: otra caída
  [ 19,   4,    5,    6,    8,    4,   3],
];

async function main() {
  const [, fondo, ana, beto] = await ethers.getSigners();
  const T = await ethers.getContractFactory("TokenPrueba");

  const dolar = await T.deploy("Dolar", "USD");
  const activos = [];
  for (const [n, s] of canasta) activos.push(await T.deploy(n, s));
  const oraculo = await (await ethers.getContractFactory("OraculoPrueba")).deploy();
  const mercado = await (await ethers.getContractFactory("MercadoPrueba")).deploy(oraculo, dolar);
  const [dueno] = await ethers.getSigners();
  const ufx = await (await ethers.getContractFactory("UFIndexada")).deploy(dolar, mercado, oraculo, activos, canasta.map((c) => c[2]), {
    tasaFijaBps: 0, pisoStable: false, margenBps: 0, fundador: dueno.address, comisionBps: 0,
    metaArranque: 0, cuotaEntradaBps: 0, multaSalidaBps: 0, recompensaUsd: 0, rebalanceoCada: 0,
  });
  const IPC = await ufx.IPC();

  let precios = canasta.map(() => 100);
  let ipc = 1; // 1 UFX = $1
  const publicar = async () => {
    for (let i = 0; i < activos.length; i++) await (await oraculo.fijarPrecio(activos[i], e18(precios[i]))).wait();
    await (await oraculo.fijarPrecio(IPC, e18(ipc))).wait();
  };
  await publicar();

  const darDolares = async (quien, n) => {
    await (await dolar.regalar(quien.address, e18(n))).wait();
    await (await dolar.connect(quien).approve(ufx, e18(n))).wait();
  };
  const entrar = async (quien, n) => {
    await darDolares(quien, n);
    try {
      await (await ufx.connect(quien).acunar(e18(n))).wait();
      return true;
    } catch (e) {
      return e.message.includes("creacion pausada") ? false : Promise.reject(e);
    }
  };

  console.log("UFX v2 · canasta de toda la economía:");
  console.log("  " + canasta.map((c) => `${c[2] / 100}% ${c[0]}`).join(" · ") + "\n");

  await darDolares(fondo, 4000);
  await (await ufx.connect(fondo).aportarColchon(e18(4000))).wait();
  console.log("El Fondo aporta $4.000 al colchón (absorbe caídas, se queda con las ganancias extra)");
  await entrar(ana, 10000);
  console.log(`Ana entra con $10.000 → recibe ${num(await ufx.balanceOf(ana.address)).toFixed(0)} UFX (1 UFX = $1)\n`);

  console.log("Año | 1 UFX vale | Ana en dólares | Ana en poder de compra | Reserva | Deuda UFX | Respaldo | Colchón");
  for (let a = 0; a < escenario.length; a++) {
    const fila = escenario[a];
    const inf = fila[fila.length - 1];
    await ethers.provider.send("evm_increaseTime", [UN_ANIO]);
    await ethers.provider.send("evm_mine", []);

    precios = precios.map((p, i) => p * (1 + fila[i] / 100));
    ipc *= 1 + inf / 100;
    await publicar();
    await (await ufx.rebalancear()).wait();

    let nota = a === 2 ? "  ← crisis: el colchón absorbe, Ana no pierde" : a === 8 ? "  ← caída" : "";
    if (a === 3) {
      nota = (await entrar(beto, 5000))
        ? "  ← Beto entra con $5.000: se CREAN UFX"
        : "  ← Beto quiere entrar pero el respaldo está bajo 120%: creación PAUSADA";
    }
    if (a === 8 && (await ufx.balanceOf(beto.address)) > 0n) {
      await (await ufx.connect(beto).quemar(await ufx.balanceOf(beto.address))).wait();
      nota = `  ← Beto sale: se QUEMAN sus UFX, recibe ${usd(num(await dolar.balanceOf(beto.address)))}`;
    }

    const precio = num(await ufx.precioUnidad());
    const anaUsd = num(await ufx.balanceOf(ana.address)) * precio;
    const ratio = num((await ufx.ratio()) * 10n ** 14n) * 100;
    console.log(
      `${String(a + 1).padStart(3)} | $${precio.toFixed(4).padStart(7)} | ${usd(anaUsd).padStart(14)} | ${usd(anaUsd / ipc).padStart(22)} | ${usd(num(await ufx.valorReserva())).padStart(7)} | ${usd(num(await ufx.deuda())).padStart(9)} | ${ratio.toFixed(0).padStart(7)}% | ${usd(num(await ufx.colchon())).padStart(7)}${nota}`
    );
  }

  await (await ufx.connect(ana).quemar(await ufx.balanceOf(ana.address))).wait();
  const anaFinal = num(await dolar.balanceOf(ana.address));
  console.log(`\nAna quema sus UFX y recibe ${usd(anaFinal)} = ${usd(anaFinal / ipc)} de poder de compra de hoy (entró con $10.000).`);

  await (await ufx.connect(fondo).retirarColchon(ethers.MaxUint256)).wait();
  const fondoFinal = num(await dolar.balanceOf(fondo.address));
  console.log(`El Fondo retira el colchón: ${usd(fondoFinal)} (aportó $4.000; ${usd(fondoFinal / ipc)} en poder de compra de hoy).`);
  console.log(`UFX en circulación al final: ${num(await ufx.totalSupply()).toFixed(0)}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
