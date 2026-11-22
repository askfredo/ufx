// Simulación con miles de usuarios sobre precios reales 2004 → hoy, y "Tú" comprando $100 el 1-ene-2025.
// Ejecutar:  npx hardhat run scripts/simulacion-usuarios.js
//   + las opciones de scripts/config.js (TASA, PISO, MARGEN, COMISION, CUOTA, MULTA, ...)
//   LLEGADAS=15     usuarios nuevos por mes (promedio)
//   SEMILLA=7       semilla del azar (para repetir la misma simulación)
//   TU_ENTRA=2024-12 / TU_SALE=2026-10   meses de datos en que entras y sales (se ejecutan el día 1 del mes siguiente)
//   TU_INICIAL=1000 monto del primer aporte (por defecto igual al mensual)
//   INICIO=2014-12 / BTC=5   ver scripts/canasta.js
//   TU_MENSUAL=100  en vez de una sola compra de $100, aportas ese monto cada mes desde TU_ENTRA hasta el mes antes de TU_SALE
const fs = require("fs");
const { ethers } = require("hardhat");

const e18 = (n) => ethers.parseUnits(n.toFixed(9), 18);
const num = (x) => Number(ethers.formatUnits(x, 18));
const usd = (n, d = 0) => "$" + n.toLocaleString("es-CL", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (n) => (n >= 0 ? "+" : "") + n.toFixed(1) + "%";

const { leerConfig } = require("./config");
const LLEGADAS = Number(process.env.LLEGADAS ?? 15);
const TU_ENTRA = process.env.TU_ENTRA ?? "2024-12";
const TU_SALE = process.env.TU_SALE ?? "2026-10";
const TU_MENSUAL = Number(process.env.TU_MENSUAL ?? 0);
const TU_MONTO = TU_MENSUAL || 100;
const TU_INICIAL = Number(process.env.TU_INICIAL ?? TU_MONTO); // primer aporte (si es distinto al mensual)
// COLCHON=necesario (por defecto): los inversionistas del colchón aportan solo lo justo para dejar el respaldo en 150%.
// COLCHON=fijo: aportan siempre $1 por cada $4 que entran a UFX (aunque sobre).
const MODO_COLCHON = process.env.COLCHON ?? "necesario";
const COLCHON_POR_DOLAR = 0.25;
const META = Number(process.env.META ?? 4000); // colchón para abrir UFX (lo pone el colchón inicial)
const RESPALDO_OBJETIVO = 1.5;
const RESPALDO_MAX = 2.0; // en modo "necesario", cada diciembre el colchón retira lo que sobre de 200%
const PERMANENCIA_MESES = 48;   // tiempo promedio que cada usuario se queda
const { armarCanasta, leerHistorico, describir, pesosDefensivos } = require("./canasta");
const canasta = armarCanasta();

// Azar reproducible
let semilla = Number(process.env.SEMILLA ?? 7) >>> 0;
const azar = () => {
  semilla = (semilla + 0x6d2b79f5) >>> 0;
  let t = semilla;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const normal = () => Math.sqrt(-2 * Math.log(1 - azar())) * Math.cos(2 * Math.PI * azar());

const momento = (fecha) => {
  const [y, m] = fecha.split("-").map(Number);
  return Date.UTC(y, m, 1, 20) / 1000;
};
const fechaEjecucion = (fecha) => new Date(momento(fecha) * 1000).toISOString().slice(0, 10);

async function main() {
  const hist = leerHistorico(canasta);
  const kEntra = hist.findIndex((h) => h.fecha === TU_ENTRA);
  const kSale = hist.findIndex((h) => h.fecha === TU_SALE);
  if (kEntra < 1 || kSale <= kEntra) throw new Error("TU_ENTRA / TU_SALE fuera de rango");

  const T0 = (await ethers.provider.getBlock("latest")).timestamp + 86400;
  const desfase = T0 - momento(hist[0].fecha);
  const irA = async (fecha) => {
    await ethers.provider.send("evm_setNextBlockTimestamp", [momento(fecha) + desfase]);
    await ethers.provider.send("evm_mine", []);
  };
  await irA(hist[0].fecha);

  const [admin, fondo, tu, fundador] = await ethers.getSigners();
  const cfg = leerConfig(fundador.address, { meta: META });
  const Tk = await ethers.getContractFactory("TokenPrueba");
  const dolar = await Tk.deploy("Dolar", "USD");
  const activos = [];
  for (const [n, s] of canasta) activos.push(await Tk.deploy(n, s));
  const oraculo = await (await ethers.getContractFactory("OraculoPrueba")).deploy();
  const mercado = await (await ethers.getContractFactory("MercadoPrueba")).deploy(oraculo, dolar);
  const ufx = await (await ethers.getContractFactory("UFIndexada")).deploy(
    dolar, mercado, oraculo, activos, canasta.map((c) => c[2]), pesosDefensivos(canasta), cfg.contrato
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
  const aportarColchon = async (n) => {
    if (n < 1) return;
    await darDolares(fondo, n);
    try {
      await (await ufx.connect(fondo).aportarColchon(e18(n))).wait();
    } catch (e) {
      if (!e.message.includes("colchon agotado")) throw e;
    }
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
  const salir = async (w) => {
    const antes = await dolar.balanceOf(w.address);
    await (await ufx.connect(w).quemar(await ufx.balanceOf(w.address))).wait();
    return num((await dolar.balanceOf(w.address)) - antes);
  };
  const ratioDe = async () => {
    const r = await ufx.ratio();
    return r === ethers.MaxUint256 ? Infinity : Number(r) / 100;
  };

  // Usuarios: direcciones deterministas que la red de prueba deja usar sin clave.
  let nUsuarios = 0;
  const nuevoUsuario = async () => {
    const addr = ethers.getAddress("0x" + (0x10000 + ++nUsuarios).toString(16).padStart(40, "0"));
    await ethers.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]); // 100 ETH para gas
    return ethers.getImpersonatedSigner(addr);
  };

  await publicar(hist[0]);
  await aportarColchon(4000);

  const activosU = [];   // { w, monto, fila, salidaK }
  const cerrados = [];   // { monto, recibe, real }
  let colchonAportado = 4000, colchonRetirado = 0;
  let rechazados = 0, totalEntradas = 0, tuW = null, tuEstimados = [], tuAportes = [];
  let minRatio = { v: Infinity, fecha: "" }, mesesPausa = 0, mesesBajo100 = 0;
  let resumenAnio = { nuevos: 0, salidas: 0, panico: 0, rechazados: 0 };

  console.log(`Simulación UFX · ${hist[1].fecha} → ${hist.at(-1).fecha} · ~${LLEGADAS} usuarios nuevos/mes · colchón ${MODO_COLCHON}`);
  console.log(`Canasta: ${describir(canasta)}`);
  console.log(cfg.texto);
  console.log("");
  console.log("Año  | Usuarios activos | Nuevos | Salen (pánico) | Rechazados | UFX en circulación | Respaldo | Colchón");

  const t0 = Date.now();
  for (let k = 1; k < hist.length; k++) {
    const fila = hist[k], prev = hist[k - 1];
    await irA(fila.fecha);
    await publicar(fila);
    await (await ufx.mantener()).wait(); // precio de hoy + rebalanceo anual
    if (MODO_COLCHON === "necesario" && fila.fecha.endsWith("-12")) {
      const r = num(await ufx.valorReserva()), d = num(await ufx.deuda()), c = num(await ufx.colchon());
      const exceso = r - RESPALDO_MAX * d;
      if (exceso > 1 && c > 0) {
        const partes = ((await ufx.partesColchon(fondo.address)) * e18(exceso / c)) / 10n ** 18n;
        const antes = await dolar.balanceOf(fondo.address);
        await (await ufx.connect(fondo).retirarColchon(partes)).wait();
        colchonRetirado += num((await dolar.balanceOf(fondo.address)) - antes);
      }
    }

    // Retorno de la canasta en el mes: si cae más de 8%, un 10% de los usuarios vende por pánico.
    const retMes = canasta.reduce((s, c) => s + (c[2] / 10000) * (fila[c[3]] / prev[c[3]] - 1), 0);
    const panico = retMes < -0.08;

    // Salidas
    for (let i = activosU.length - 1; i >= 0; i--) {
      const u = activosU[i];
      const porPanico = panico && azar() < 0.1;
      if (u.salidaK === k || porPanico) {
        const recibe = await salir(u.w);
        const real = recibe / fila.ipc * u.fila.ipc;
        cerrados.push({ monto: u.monto, recibe, real, meses: k - u.k });
        activosU.splice(i, 1);
        resumenAnio.salidas++;
        if (porPanico) resumenAnio.panico++;
      }
    }

    // Llegadas del mes
    const n = Math.max(0, Math.round(LLEGADAS + normal() * Math.sqrt(LLEGADAS)));
    const montos = Array.from({ length: n }, () => Math.min(50000, Math.max(20, Math.exp(Math.log(300) + 1.2 * normal()))));
    const entra = montos.reduce((a, b) => a + b, 0);
    let aporte = entra * COLCHON_POR_DOLAR;
    if (MODO_COLCHON === "necesario") {
      const r = num(await ufx.valorReserva()), d = num(await ufx.deuda());
      aporte = Math.max(0, RESPALDO_OBJETIVO * (d + entra) - (r + entra));
    }
    await aportarColchon(aporte);
    colchonAportado += aporte;
    for (const monto of montos) {
      const w = await nuevoUsuario();
      if (await entrar(w, monto)) {
        const salidaK = k + Math.max(1, Math.ceil(-Math.log(1 - azar()) * PERMANENCIA_MESES));
        activosU.push({ w, monto, fila, k, salidaK });
        totalEntradas++;
        resumenAnio.nuevos++;
      } else {
        rechazados++;
        resumenAnio.rechazados++;
      }
    }

    // Tú
    if (TU_MENSUAL ? k >= kEntra && k < kSale : k === kEntra) {
      tuW = tu;
      const antes = await ufx.balanceOf(tu.address);
      const monto = k === kEntra ? TU_INICIAL : TU_MONTO;
      const ok = await entrar(tu, monto);
      tuAportes.push({ fila, ok, monto, ufx: num((await ufx.balanceOf(tu.address)) - antes) });
    }
    if (tuW && k > kEntra && k <= kSale) {
      tuEstimados.push({
        fecha: fila.fecha, aportado: tuAportes.filter((a) => a.ok).reduce((x, a) => x + a.monto, 0),
        valor: num(await ufx.valorEnDolares(tu.address)),
      });
    }
    let tuResultado = null;
    if (k === kSale) {
      const recibe = await salir(tu);
      tuResultado = { recibe, fila };
      main.tu = tuResultado;
    }

    const ratio = await ratioDe();
    if (ratio < minRatio.v) minRatio = { v: ratio, fecha: fila.fecha };
    if (ratio < 120) mesesPausa++;
    if (ratio < 100) mesesBajo100++;

    if (fila.fecha.endsWith("-12") || k === hist.length - 1) {
      const r = resumenAnio;
      console.log(
        `${fila.fecha.slice(0, 4)} | ${String(activosU.length).padStart(16)} | ${String(r.nuevos).padStart(6)} | ${`${r.salidas} (${r.panico})`.padStart(14)} | ${String(r.rechazados).padStart(10)} | ${usd(num(await ufx.deuda())).padStart(18)} | ${(ratio.toFixed(0) + "%").padStart(8)} | ${usd(num(await ufx.colchon())).padStart(10)}`
      );
      resumenAnio = { nuevos: 0, salidas: 0, panico: 0, rechazados: 0 };
    }
  }

  // ── Resultados ──
  const conPerdida = cerrados.filter((c) => c.real < c.monto * 0.999).length;
  const realAnual = cerrados.filter((c) => c.meses >= 12).map((c) => (Math.pow(c.real / c.monto, 12 / c.meses) - 1) * 100).sort((a, b) => a - b);
  const q = (p) => realAnual[Math.floor(p * (realAnual.length - 1))];
  console.log(`\nUsuarios que entraron: ${totalEntradas.toLocaleString("es-CL")} · rechazados por pausa: ${rechazados} · siguen dentro: ${activosU.length}`);
  console.log(`De los ${cerrados.length.toLocaleString("es-CL")} que ya salieron: ${conPerdida} perdieron poder de compra (${(100 * conPerdida / cerrados.length).toFixed(1)}%).`);
  console.log(`Rendimiento real anual de quienes estuvieron ≥1 año: mediana ${pct(q(0.5))} · peor 10% ${pct(q(0.1))} · mejor 10% ${pct(q(0.9))}`);
  console.log(`Respaldo mínimo: ${minRatio.v.toFixed(0)}% en ${minRatio.fecha} · meses con creación pausada: ${mesesPausa} · meses bajo 100%: ${mesesBajo100}`);
  console.log(`Colchón: los inversionistas aportaron ${usd(colchonAportado)}, retiraron ${usd(colchonRetirado)} en ganancias y hoy vale ${usd(num(await ufx.colchon()))} (modo ${MODO_COLCHON})`);
  const cF = num(await ufx.colchon()) * Number(await ufx.partesColchon(fundador.address)) / Number(await ufx.partesColchonTotal());
  console.log(`Fundador (comisión ${cfg.comision}% anual): su parte del colchón vale hoy ${usd(cF)}`);
  console.log(`(la simulación tomó ${((Date.now() - t0) / 1000).toFixed(0)} s)`);

  // ── Tú ──
  const tuR = main.tu;
  const fE = hist[kEntra], fS = hist[kSale];
  const hechos = tuAportes.filter((a) => a.ok);
  const aportado = hechos.reduce((x, a) => x + a.monto, 0);
  // Cada aporte llevado a dólares de hoy, para comparar poder de compra.
  const aportadoHoy = hechos.reduce((s, a) => s + a.monto * (fS.ipc / a.fila.ipc), 0);
  const enOtra = (f) => hechos.reduce((s, a) => s + a.monto * f(a.fila), 0);
  const canastaSola = enOtra((fa) => canasta.reduce((s, c) => s + (c[2] / 10000) * (fS[c[3]] / fa[c[3]]), 0));
  const sp = enOtra((fa) => fS.acciones / fa.acciones);
  const titulo = TU_MENSUAL
    ? `${TU_INICIAL !== TU_MONTO ? `pones ${usd(TU_INICIAL)} y después ` : ""}aportas ${usd(TU_MONTO)} cada mes desde el ${fechaEjecucion(TU_ENTRA)} (${hechos.length} aportes) y vendes el ${fechaEjecucion(TU_SALE)}`
    : `compras ${usd(TU_INICIAL)} el ${fechaEjecucion(TU_ENTRA)} y vendes el ${fechaEjecucion(TU_SALE)}`;
  console.log(`\n═══ TÚ: ${titulo} ═══`);
  if (hechos.length < tuAportes.length) console.log(`(${tuAportes.length - hechos.length} aportes rechazados por creación pausada)`);
  const ufxTot = hechos.reduce((s, a) => s + a.ufx, 0);
  console.log(`Compraste ${ufxTot.toFixed(2)} UFX a un precio promedio de ${usd(aportado / ufxTot, 4)}\n`);
  console.log("Mes     | Aportado | Tus UFX valen");
  for (const e of tuEstimados) {
    if (TU_MENSUAL && !/-(03|06|09|12)$/.test(e.fecha) && e !== tuEstimados.at(-1)) continue;
    console.log(`${e.fecha} | ${usd(e.aportado).padStart(8)} | ${usd(e.valor, 2).padStart(13)}`);
  }
  console.log(`\nAportaste ${usd(aportado, 2)} (equivalen a ${usd(aportadoHoy, 2)} de hoy, por la inflación)`);
  console.log(`Vendes y recibes: ${usd(tuR.recibe, 2)}  → ganancia ${usd(tuR.recibe - aportado, 2)} (${pct((tuR.recibe / aportado - 1) * 100)} en dólares)`);
  console.log(`Ganancia real, descontada la inflación: ${usd(tuR.recibe - aportadoHoy, 2)} (${pct((tuR.recibe / aportadoHoy - 1) * 100)})`);
  console.log(`\nComparación con los mismos aportes:`);
  console.log(`  Guardados en dólares:        ${usd(aportado, 2)}  (pierdes ${usd(aportadoHoy - aportado, 2)} de poder de compra)`);
  console.log(`  Stablecoin con rendimiento:  ${usd(enOtra((fa) => fS.stable / fa.stable), 2)}  (T-bills, como sUSDS/USDY)`);
  console.log(`  Canasta directa (sin UFX):   ${usd(canastaSola, 2)}  (sube y baja con el mercado)`);
  console.log(`  Solo acciones globales:      ${usd(sp, 2)}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
