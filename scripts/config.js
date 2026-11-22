// Configuración de UFX para los scripts, leída de variables de entorno.
//   TASA=2          % fijo sobre la inflación
//   PISO=1 MARGEN=0.5   UFX rinde al menos T-bills + 0,5% (PISO=0 lo apaga)
//   COMISION=0.1    % anual de la reserva para el fundador (desde el segundo año)
//   META=4000       dólares de colchón para abrir UFX
//   CUOTA=2 MULTA=1     entrada al colchón después del arranque / salida antes de un año
//   RECOMPENSA=0    propina en dólares por cada `mantener()` (máximo una al día)
//   REBALANCEO_DIAS=365 cada cuántos días rebalancea `mantener()`
//   DEFENSIVO=130   respaldo (%) bajo el cual la canasta pasa a pesos defensivos (0 = apagado)
const { ethers } = require("hardhat");

const env = (k, d) => Number(process.env[k] ?? d);

function leerConfig(fundador, porDefecto = {}) {
  const c = {
    tasa: env("TASA", porDefecto.tasa ?? 2),
    piso: (process.env.PISO ?? "1") === "1",
    margen: env("MARGEN", 0.5),
    comision: env("COMISION", porDefecto.comision ?? 0.1),
    meta: env("META", porDefecto.meta ?? 4000),
    cuota: env("CUOTA", 2),
    multa: env("MULTA", 1),
    recompensa: env("RECOMPENSA", porDefecto.recompensa ?? 0),
    rebalanceoDias: env("REBALANCEO_DIAS", porDefecto.rebalanceoDias ?? 365),
    defensivo: env("DEFENSIVO", porDefecto.defensivo ?? 130),
  };
  c.contrato = {
    tasaFijaBps: Math.round(c.tasa * 100),
    pisoStable: c.piso,
    margenBps: Math.round(c.margen * 100),
    fundador,
    comisionBps: Math.round(c.comision * 100),
    metaArranque: ethers.parseUnits(String(c.meta), 18),
    cuotaEntradaBps: Math.round(c.cuota * 100),
    multaSalidaBps: Math.round(c.multa * 100),
    recompensaUsd: ethers.parseUnits(String(c.recompensa), 18),
    rebalanceoCada: Math.round(c.rebalanceoDias * 86400),
    umbralDefensivoBps: Math.round(c.defensivo * 100),
  };
  c.texto = `UFX = máx(inflación + ${c.tasa}%, ${c.piso ? `T-bills + ${c.margen}%` : "—"}) · comisión fundador ${c.comision}% · entrada colchón ${c.cuota}% / salida temprana ${c.multa}%${c.defensivo ? ` · modo defensivo bajo ${c.defensivo}%` : ""}`;
  return c;
}

module.exports = { leerConfig };
