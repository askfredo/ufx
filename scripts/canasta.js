// Canasta y datos históricos compartidos por el backtest y la simulación.
//   BTC=5        agrega 5% de bitcoin y baja los demás pesos en proporción
//   INICIO=2014-12  primer mes (precios e IPC se re-basan a ese mes)
const fs = require("fs");

const BASE = [
  ["Acciones globales", "tACC", 3000, "acciones"],
  ["Bonos", "tBONO", 3000, "bonos"],
  ["Oro", "tORO", 1500, "oro"],
  ["Inmuebles", "tINM", 1000, "inmuebles"],
  ["Energía", "tWTI", 800, "energia"],
  ["Materias primas", "tMAT", 700, "materias"],
];

function armarCanasta(btcPct = Number(process.env.BTC ?? 0)) {
  if (!btcPct) return BASE.map((c) => [...c]);
  const btcBps = Math.round(btcPct * 100);
  const canasta = BASE.map(([n, s, p, col]) => [n, s, Math.floor((p * (10000 - btcBps)) / 10000), col]);
  canasta.push(["Bitcoin", "tBTC", btcBps, "btc"]);
  canasta[1][2] += 10000 - canasta.reduce((s, c) => s + c[2], 0); // el redondeo va a bonos
  return canasta;
}

function leerHistorico(canasta, inicio = process.env.INICIO) {
  const [cab, ...filas] = fs.readFileSync("datos/historico.csv", "utf8").trim().split("\n");
  const cols = cab.split(",");
  let hist = filas.map((f) => Object.fromEntries(f.split(",").map((v, i) => [cols[i], i === 0 ? v : v === "" ? NaN : Number(v)])));
  const desde = hist.findIndex((h) => h.fecha === (inicio ?? hist[0].fecha));
  if (desde < 0) throw new Error("INICIO fuera de rango");
  const base = hist[desde];
  for (const c of canasta) {
    if (!(base[c[3]] > 0)) throw new Error(`No hay datos de ${c[0]} en ${base.fecha} (bitcoin parte en 2014-09: usa INICIO=2014-12)`);
  }
  return hist.slice(desde).map((h) => Object.fromEntries(
    Object.entries(h).map(([k, v]) => [k, k === "fecha" || k === "tasa" ? v : (v / base[k]) * (k === "ipc" ? 1 : 100)])
  ));
}

const describir = (canasta) => canasta.map((c) => `${c[2] / 100}% ${c[0]}`).join(" · ");

module.exports = { armarCanasta, leerHistorico, describir };
