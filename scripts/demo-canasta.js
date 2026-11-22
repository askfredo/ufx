// Demo: UFX, una moneda respaldada por oro, S&P 500, bonos y energía.
// Ejecutar:  npx hardhat run scripts/demo-canasta.js
//
// OJO: los rendimientos por año son un ESCENARIO INVENTADO para el experimento,
// no datos históricos ni predicciones.
const { ethers } = require("hardhat");

const e18 = (n) => ethers.parseUnits(n.toFixed(6), 18);
const num = (x) => Number(ethers.formatUnits(x, 18));
const usd = (n) => "$" + n.toLocaleString("es-CL", { maximumFractionDigits: 0 });
const pct = (n) => (n >= 0 ? "+" : "") + n.toFixed(1) + "%";
const UN_ANIO = 365 * 24 * 60 * 60;

//                oro   sp500  bonos  energía  inflación USD
const escenario = [
  [ 8,   15,   4,   10,   3],
  [ 2,   10,   4,   -5,   3],
  [18,  -30,   6,  -35,   6],  // año 3: gran crisis
  [-5,   25,   3,   20,   4],
  [ 4,   12,   4,    5,   3],
  [10,   -8,   5,   15,   3],
  [ 3,   18,   4,  -10,   2],
  [-2,   10,   4,    5,   2],
  [12,  -15,   6,  -20,   4],  // año 9: otra caída
  [ 5,   20,   4,    8,   3],
];
const nombres = ["Oro", "S&P 500", "Bonos", "Energía"];
const pesos = [2500, 3500, 3000, 1000]; // 25% oro, 35% acciones, 30% bonos, 10% energía

async function main() {
  const [, ana, beto] = await ethers.getSigners();
  const T = await ethers.getContractFactory("TokenPrueba");

  // 1. Piezas: dólar, 4 activos tokenizados, oráculo y mercado
  const dolar = await T.deploy("Dolar", "USD");
  const activos = [];
  for (const [n, s] of [["Oro", "tORO"], ["SP500", "tSPY"], ["Bonos", "tBONO"], ["Energia", "tWTI"]]) {
    activos.push(await T.deploy(n, s));
  }
  const oraculo = await (await ethers.getContractFactory("OraculoPrueba")).deploy();
  const mercado = await (await ethers.getContractFactory("MercadoPrueba")).deploy(oraculo, dolar);

  let precios = [100, 100, 100, 100]; // todos parten en índice 100
  const publicarPrecios = async () => {
    for (let i = 0; i < 4; i++) await (await oraculo.fijarPrecio(activos[i], e18(precios[i]))).wait();
  };
  await publicarPrecios();

  // 2. Tu moneda
  const ufx = await (await ethers.getContractFactory("MonedaCanasta")).deploy(dolar, mercado, oraculo, activos, pesos);
  console.log("UFX creada: 25% oro · 35% S&P 500 · 30% bonos · 10% energía\n");

  // 3. Ana entra con $10.000
  const entrar = async (quien, dolares) => {
    await (await dolar.regalar(quien.address, e18(dolares))).wait();
    await (await dolar.connect(quien).approve(ufx, e18(dolares))).wait();
    await (await ufx.connect(quien).acunar(e18(dolares))).wait();
  };
  await entrar(ana, 10000);
  console.log(`Ana entra con $10.000 → recibe ${num(await ufx.balanceOf(ana.address)).toFixed(0)} UFX (1 UFX = $1)`);
  console.log(`Monedas en circulación: ${num(await ufx.totalSupply()).toFixed(0)}\n`);

  console.log("Año | Precio UFX | Ana en UFX | Solo S&P500 | $10.000 bajo el colchón (poder de compra) | UFX en circulación");
  let soloSP = 10000, colchon = 10000, valorPrevio = 10000;

  for (let a = 0; a < escenario.length; a++) {
    const [o, s, b, en, inf] = escenario[a];
    await ethers.provider.send("evm_increaseTime", [UN_ANIO]);
    await ethers.provider.send("evm_mine", []);

    // Se mueven los precios del mundo real
    precios = precios.map((p, i) => p * (1 + [o, s, b, en][i] / 100));
    await publicarPrecios();
    await (await ufx.rebalancear()).wait();

    soloSP *= 1 + s / 100;
    colchon /= 1 + inf / 100;

    // Beto entra en el año 4 y sale en el año 9 (para ver crear y quemar)
    if (a === 3) await entrar(beto, 5000);
    if (a === 8) {
      const saldo = await ufx.balanceOf(beto.address);
      await (await ufx.connect(beto).quemar(saldo)).wait();
    }

    const precio = num(await ufx.precioUnidad());
    const valorAna = num(await ufx.balanceOf(ana.address)) * precio;
    const cambio = ((valorAna / valorPrevio) - 1) * 100;
    valorPrevio = valorAna;
    const circ = num(await ufx.totalSupply());
    const nota = a === 3 ? "  ← Beto entra con $5.000: se CREAN UFX"
               : a === 8 ? `  ← Beto sale: se QUEMAN sus UFX, recibe ${usd(num(await dolar.balanceOf(beto.address)))}`
               : a === 2 ? "  ← crisis: el oro y los bonos amortiguan" : "";
    console.log(
      `${String(a + 1).padStart(3)} | $${precio.toFixed(3).padStart(8)} | ${usd(valorAna).padStart(8)} ${pct(cambio).padStart(6)} | ${usd(soloSP).padStart(9)} | ${usd(colchon).padStart(8)} | ${circ.toFixed(0).padStart(6)}${nota}`
    );
  }

  // 4. Ana sale de todo
  await (await ufx.connect(ana).quemar(await ufx.balanceOf(ana.address))).wait();
  const final = num(await dolar.balanceOf(ana.address));
  console.log(`\nAna quema sus UFX y recibe ${usd(final)} dólares.`);
  console.log(`En poder de compra de hoy eso equivale a ${usd(final * (colchon / 10000))} (vs $10.000 iniciales).`);
  console.log(`UFX en circulación al final: ${num(await ufx.totalSupply()).toFixed(0)} (no queda nada sin respaldo)`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
