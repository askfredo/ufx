// Backtest de UFX con precios reales mensuales, dic-2003 → hoy.
// Ejecutar:  npx hardhat run scripts/backtest-2004.js
//   INICIO=2007-12   lanza UFX en esa fecha (precios e IPC se re-basan a ese mes)
//   COLCHON=4000     aporte inicial del colchón (también es la meta de arranque)
//   BTC=5            agrega 5% de bitcoin (requiere INICIO=2014-12 o después)
//   + las opciones de scripts/config.js (TASA, PISO, MARGEN, COMISION, CUOTA, MULTA, ...)
// Datos: datos/historico.csv (ver datos/bajar.py y datos/preparar.py).
// Eventos: Ana entra con $10.000 al inicio; Beto entra antes de la crisis de 2008 y sale en el peor mes;
// Diego entra al colchón a fines de 2009; Carla entra a UFX a mediados de 2016.
const fs = require("fs");
const { ethers } = require("hardhat");
const { armarCanasta, leerHistorico, describir } = require("./canasta");
const { leerConfig } = require("./config");

const e18 = (n) => ethers.parseUnits(n.toFixed(9), 18);
const num = (x) => Number(ethers.formatUnits(x, 18));
const usd = (n) => "$" + n.toLocaleString("es-CL", { maximumFractionDigits: 0 });
const pctAnual = (x0, x1, anios) => ((Math.pow(x1 / x0, 1 / anios) - 1) * 100).toFixed(1) + "%/año";

const COLCHON_INICIAL = Number(process.env.COLCHON ?? 4000);
const canasta = armarCanasta();

// Cada fila "AAAA-MM" se ejecuta el día 1 del mes siguiente a las 20:00 UTC (los precios son de fin de mes).
const momento = (fecha) => {
  const [y, m] = fecha.split("-").map(Number);
  return Date.UTC(y, m, 1, 20) / 1000;
};

async function main() {
  const hist = leerHistorico(canasta);
  const [, fondo, ana, beto, carla, fundador, diego] = await ethers.getSigners();
  const cfg = leerConfig(fundador.address, { meta: COLCHON_INICIAL, comision: 0.01 });

  // La cadena de prueba vive en el presente: se corre el calendario real con un desfase fijo.
  const T0 = (await ethers.provider.getBlock("latest")).timestamp + 86400;
  const desfase = T0 - momento(hist[0].fecha);
  const irA = async (fecha) => {
    await ethers.provider.send("evm_setNextBlockTimestamp", [momento(fecha) + desfase]);
    await ethers.provider.send("evm_mine", []);
  };
  await irA(hist[0].fecha);

  const T = await ethers.getContractFactory("TokenPrueba");
  const dolar = await T.deploy("Dolar", "USD");
  const activos = [];
  for (const [n, s] of canasta) activos.push(await T.deploy(n, s));
  const oraculo = await (await ethers.getContractFactory("OraculoPrueba")).deploy();
  const mercado = await (await ethers.getContractFactory("MercadoPrueba")).deploy(oraculo, dolar);
  const ufx = await (await ethers.getContractFactory("UFIndexada")).deploy(
    dolar, mercado, oraculo, activos, canasta.map((c) => c[2]), cfg.contrato
  );
  const IPC = await ufx.IPC();
  const TBILL = await ufx.TBILL();

  const publicar = async (fila) => {
    for (let i = 0; i < activos.length; i++) await (await oraculo.fijarPrecio(activos[i], e18(fila[canasta[i][3]]))).wait();
    await (await oraculo.fijarPrecio(IPC, e18(fila.ipc))).wait();
    await (await oraculo.fijarPrecio(TBILL, e18(fila.tasa) + 1n)).wait(); // +1 wei: el oráculo no acepta 0
  };
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
      if (!e.message.includes("creacion pausada")) throw e;
      return false;
    }
  };
  const ratioDe = async () => {
    const r = await ufx.ratio();
    return r === ethers.MaxUint256 ? Infinity : Number(r) / 100;
  };

  await publicar(hist[0]);
  await darDolares(fondo, COLCHON_INICIAL);
  await (await ufx.connect(fondo).aportarColchon(e18(COLCHON_INICIAL))).wait();
  await entrar(ana, 10000);

  console.log(`Backtest UFX · ${hist[1].fecha} → ${hist.at(-1).fecha} · precios reales mensuales`);
  console.log(`Canasta: ${describir(canasta)}`);
  console.log(cfg.texto);
  console.log(`Colchón inicial ${usd(COLCHON_INICIAL)} · Ana entra con $10.000\n`);
  console.log("Año   | 1 UFX vale | Ana (dólares) | Ana (poder compra) | Respaldo dic | Respaldo mín | Colchón | Nota");

  let minAnio = Infinity, minTotal = { v: Infinity, fecha: "" }, mesesPausa = 0, mesesBajo100 = 0, nota = "";
  let carlaEntro = null, diegoEntro = null;
  const salida = ["fecha,precio_ufx,reserva,deuda,respaldo_pct,colchon"];

  for (let k = 1; k < hist.length; k++) {
    const fila = hist[k];
    await irA(fila.fecha);
    await publicar(fila);
    await (await ufx.mantener()).wait(); // precio de hoy + rebalanceo anual

    if (hist[0].fecha < "2008-01" && fila.fecha === "2008-01") {
      nota = (await entrar(beto, 5000)) ? "Beto entra $5.000 (ene)" : "Beto quiere entrar pero la creación está PAUSADA";
    }
    if (fila.fecha === "2009-02" && (await ufx.balanceOf(beto.address)) > 0n) {
      await (await ufx.connect(beto).quemar(await ufx.balanceOf(beto.address))).wait();
      const b = num(await dolar.balanceOf(beto.address));
      nota = `Beto sale en el fondo de la crisis con ${usd(b)}`;
    }
    if (fila.fecha === "2009-12" && hist[0].fecha < "2009-12") {
      await darDolares(diego, 4000);
      await (await ufx.connect(diego).aportarColchon(e18(4000))).wait();
      diegoEntro = fila;
      nota = `Diego entra al colchón con $4.000 (paga ${cfg.cuota}% de entrada)`;
    }
    if (fila.fecha === "2016-06" && hist[0].fecha < "2016-06") {
      if (await entrar(carla, 10000)) carlaEntro = fila;
      nota = carlaEntro ? "Carla entra a UFX con $10.000" : "Carla no pudo entrar (pausa)";
    }

    const ratio = await ratioDe();
    if (ratio < minAnio) minAnio = ratio;
    if (ratio < minTotal.v) minTotal = { v: ratio, fecha: fila.fecha };
    if (ratio < 120) mesesPausa++;
    if (ratio < 100) mesesBajo100++;
    const precio = num(await ufx.precioUnidad());
    salida.push([fila.fecha, precio, num(await ufx.valorReserva()), num(await ufx.deuda()), ratio, num(await ufx.colchon())].join(","));

    const ultimoMes = k === hist.length - 1;
    if (fila.fecha.endsWith("-12") || ultimoMes) {
      const anaUsd = num(await ufx.valorEnDolares(ana.address));
      console.log(
        `${fila.fecha.slice(0, 4)}${ultimoMes && !fila.fecha.endsWith("-12") ? "*" : " "} | $${precio.toFixed(4).padStart(7)} | ${usd(anaUsd).padStart(13)} | ${usd(anaUsd / fila.ipc).padStart(18)} | ${(ratio.toFixed(0) + "%").padStart(12)} | ${(minAnio.toFixed(0) + "%").padStart(12)} | ${usd(num(await ufx.colchon())).padStart(7)} | ${nota}`
      );
      minAnio = Infinity; nota = "";
    }
  }
  fs.writeFileSync("datos/resultado-backtest.csv", salida.join("\n") + "\n");

  const ultimo = hist.at(-1);
  const anios = (hist.length - 1) / 12;
  const salir = async (w) => {
    const antes = await dolar.balanceOf(w.address);
    await (await ufx.connect(w).quemar(await ufx.balanceOf(w.address))).wait();
    return num((await dolar.balanceOf(w.address)) - antes);
  };
  const salirColchon = async (w) => {
    const antes = await dolar.balanceOf(w.address);
    await (await ufx.connect(w).retirarColchon(ethers.MaxUint256)).wait();
    return num((await dolar.balanceOf(w.address)) - antes);
  };

  console.log(`\n* hasta ${ultimo.fecha}\n`);
  const anaFinal = await salir(ana);
  console.log(`Ana sale con ${usd(anaFinal)} = ${usd(anaFinal / ultimo.ipc)} en poder de compra de ${hist[0].fecha} (entró con $10.000): ${pctAnual(10000, anaFinal, anios)} nominal, ${pctAnual(10000, anaFinal / ultimo.ipc, anios)} real.`);
  if (carlaEntro) {
    const c = await salir(carla);
    const aniosC = (hist.length - 1 - hist.indexOf(carlaEntro)) / 12;
    console.log(`Carla (desde ${carlaEntro.fecha}) sale con ${usd(c)}: ${pctAnual(10000, (c / ultimo.ipc) * carlaEntro.ipc, aniosC)} real.`);
  }
  const fondoFinal = await salirColchon(fondo);
  console.log(`El Fondo (colchón desde el inicio) puso ${usd(COLCHON_INICIAL)} y sale con ${usd(fondoFinal)}: ${pctAnual(COLCHON_INICIAL, fondoFinal / ultimo.ipc, anios)} real.`);
  if (diegoEntro) {
    const d = await salirColchon(diego);
    const aniosD = (hist.length - 1 - hist.indexOf(diegoEntro)) / 12;
    console.log(`Diego (colchón desde ${diegoEntro.fecha}) puso $4.000 y sale con ${usd(d)}: ${pctAnual(4000, (d / ultimo.ipc) * diegoEntro.ipc, aniosD)} real.`);
  }
  if ((await ufx.partesColchon(fundador.address)) > 0n) {
    console.log(`Fundador (comisión ${cfg.comision}% anual): ${usd(await salirColchon(fundador))} en todo el período.`);
  }
  const stable = (10000 * ultimo.stable) / 100;
  console.log(`\n$10.000 guardados en dólares: ${usd(10000 / ultimo.ipc)} de poder de compra (${pctAnual(1, 1 / ultimo.ipc, anios)} real).`);
  console.log(`$10.000 en stablecoin con rendimiento (T-bills): ${usd(stable)} (${pctAnual(10000, stable, anios)} nominal, ${pctAnual(10000, stable / ultimo.ipc, anios)} real).`);
  console.log(`\nRespaldo mínimo: ${minTotal.v.toFixed(0)}% en ${minTotal.fecha}.`);
  console.log(`Meses con creación de UFX pausada (<120%): ${mesesPausa} de ${hist.length - 1}.`);
  console.log(`Meses con UFX sin respaldo completo (<100%): ${mesesBajo100}.`);
  console.log(`Detalle mes a mes en datos/resultado-backtest.csv`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
