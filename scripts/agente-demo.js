// Demo: un agente de IA que maneja su tesorería con UFX, y un bot que mantiene el protocolo.
// Ejecutar:  npx hardhat run scripts/agente-demo.js
//
// El agente cobra por su trabajo en USDC (de prueba), paga sus gastos (APIs, cómputo) y sigue
// una regla simple: dejar 2 semanas de gastos en caja y guardar todo lo demás en UFX.
// Se compara contra el mismo agente dejando todo en USDC.
// OJO: precios, inflación e ingresos son un escenario inventado de 24 meses.
const { ethers } = require("hardhat");

const e18 = (n) => ethers.parseUnits(Number(n).toFixed(9), 18);
const num = (x) => Number(ethers.formatUnits(x, 18));
const usd = (n) => "$" + n.toLocaleString("es-CL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const DIA = 86400;

async function main() {
  const [dueno, colchon, agente, bot, clientes] = await ethers.getSigners();
  const T = await ethers.getContractFactory("TokenPrueba");
  const dolar = await T.deploy("USD de prueba", "tUSDC");
  const canasta = [["Bonos", "tBONO", 4000], ["Acciones", "tSPY", 3000], ["Oro", "tORO", 2500], ["Bitcoin", "tBTC", 500]];
  const activos = [];
  for (const [n, s] of canasta) activos.push(await T.deploy(n, s));
  const oraculo = await (await ethers.getContractFactory("OraculoPrueba")).deploy();
  const mercado = await (await ethers.getContractFactory("MercadoPrueba")).deploy(oraculo, dolar);
  const ufx = await (await ethers.getContractFactory("UFIndexada")).deploy(dolar, mercado, oraculo, activos, canasta.map((c) => c[2]), {
    tasaFijaBps: 200, pisoStable: true, margenBps: 50, fundador: dueno.address, comisionBps: 10,
    metaArranque: e18(1000), cuotaEntradaBps: 200, multaSalidaBps: 100,
    recompensaUsd: e18(0.05), rebalanceoCada: 30 * DIA,
  });
  const ufxc = await ethers.getContractAt("ParteColchon", await ufx.partes());

  // Mercado de mentira: precios que suben y bajan, inflación 3% anual, T-bills 4%.
  let precios = [100, 100, 100, 100], ipc = 1;
  const publicar = async () => {
    for (let i = 0; i < activos.length; i++) await oraculo.fijarPrecio(activos[i], e18(precios[i]));
    await oraculo.fijarPrecio(await ufx.IPC(), e18(ipc));
    await oraculo.fijarPrecio(await ufx.TBILL(), e18(0.04));
  };
  await publicar();

  // Colchón inicial para abrir UFX.
  await dolar.regalar(colchon.address, e18(5000));
  await dolar.connect(colchon).approve(ufx, ethers.MaxUint256);
  await ufx.connect(colchon).aportarColchon(e18(5000));

  await dolar.connect(agente).approve(ufx, ethers.MaxUint256);
  const GASTO_DIA = 3;           // el agente gasta ~$3 al día en APIs y cómputo
  const RESERVA = 14 * GASTO_DIA; // deja dos semanas de gastos en caja
  let soloUsdc = 0;               // el mismo agente, pero guardando todo en USDC
  let semilla = 42;
  const azar = () => ((semilla = (semilla * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

  console.log("Agente de IA con tesorería en UFX · 24 meses · regla: 2 semanas de gastos en caja, el resto en UFX\n");
  console.log("Mes | Cobró   | Gastó   | Caja USDC | En UFX    | Tesorería total | Solo USDC | Bot: propinas");

  for (let mes = 1; mes <= 24; mes++) {
    let cobro = 0, gasto = 0;
    for (let d = 0; d < 30; d++) {
      await ethers.provider.send("evm_increaseTime", [DIA]);
      await ethers.provider.send("evm_mine", []);
      precios = precios.map((p, i) => p * (1 + [0.0001, 0.0004, 0.0003, 0.002][i] + (azar() - 0.5) * [0.002, 0.02, 0.015, 0.06][i]));
      ipc *= Math.pow(1.03, 1 / 365);
      await publicar();

      // 1) Ingresos del día: clientes le pagan por tareas.
      const ingreso = azar() < 0.7 ? 2 + azar() * 6 : 0;
      if (ingreso > 0) { await dolar.regalar(agente.address, e18(ingreso)); cobro += ingreso; soloUsdc += ingreso; }

      // 2) Gastos del día: si no alcanza la caja, saca de UFX lo justo.
      const caja = num(await dolar.balanceOf(agente.address));
      if (caja < GASTO_DIA) {
        const falta = GASTO_DIA - caja + RESERVA;
        const precio = num(await ufx.precioUnidad());
        const cant = e18(Math.min(falta / precio, num(await ufx.balanceOf(agente.address))));
        if (cant > 0n) await ufx.connect(agente).quemar(cant);
      }
      await dolar.connect(agente).transfer(dueno.address, e18(Math.min(GASTO_DIA, num(await dolar.balanceOf(agente.address)))));
      gasto += GASTO_DIA; soloUsdc -= GASTO_DIA;

      // 3) Lo que sobra sobre la reserva se guarda en UFX (si la creación no está pausada).
      const sobra = num(await dolar.balanceOf(agente.address)) - RESERVA;
      if (sobra > 1 && (await ufx.previewAcunar(e18(sobra))) > 0n) await ufx.connect(agente).acunar(e18(sobra));

      // 4) Un bot mantiene el protocolo y cobra su propina.
      await ufx.connect(bot).mantener();
    }
    const caja = num(await dolar.balanceOf(agente.address));
    const enUfx = num(await ufx.valorEnDolares(agente.address));
    const propinas = num(await ufxc.balanceOf(bot.address)) * num(await ufx.valorParteColchon());
    if (mes % 3 === 0 || mes === 1) {
      console.log(`${String(mes).padStart(3)} | ${usd(cobro).padStart(7)} | ${usd(gasto).padStart(7)} | ${usd(caja).padStart(9)} | ${usd(enUfx).padStart(9)} | ${usd(caja + enUfx).padStart(15)} | ${usd(soloUsdc).padStart(9)} | ${usd(propinas).padStart(8)}`);
    }
  }

  const total = num(await dolar.balanceOf(agente.address)) + num(await ufx.valorEnDolares(agente.address));
  console.log(`\nTesorería del agente con UFX: ${usd(total)}  ·  dejando todo en USDC: ${usd(soloUsdc)}  ·  diferencia ${usd(total - soloUsdc)}`);
  console.log(`Inflación del período: ${((ipc - 1) * 100).toFixed(1)}% · 1 UFX vale ${usd(num(await ufx.precioUnidad()))}`);
  console.log(`El bot de mantención llamó mantener() una vez al día y ganó ${usd(num(await ufxc.balanceOf(bot.address)) * num(await ufx.valorParteColchon()))} en UFXC.`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
