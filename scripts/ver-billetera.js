// Muestra las 12 palabras y la clave de la billetera de prueba para anotarlas en papel.
// Ejecútalo en TU propia terminal, no dentro de un chat con una IA.
//   node scripts/ver-billetera.js
const fs = require("fs");
const os = require("os");
const path = require("path");

const archivo = path.join(os.homedir(), ".ufx-testnet", "billetera.json");
if (!fs.existsSync(archivo)) {
  console.log("No hay billetera de prueba. Créala con: node scripts/crear-billetera.js");
  process.exit(1);
}
const b = JSON.parse(fs.readFileSync(archivo, "utf8"));
console.log("\n  BILLETERA DE PRUEBA — SOLO Base Sepolia, nunca fondos reales\n");
console.log(`  Dirección pública:  ${b.address}\n`);
console.log("  12 palabras (anótalas en orden):");
b.palabras.split(" ").forEach((p, i) => console.log(`    ${String(i + 1).padStart(2)}. ${p}`));
console.log(`\n  Clave privada: ${b.clavePrivada}\n`);
console.log("  Con las 12 palabras puedes recuperar la billetera en MetaMask u otra app.");
console.log("  Cuando termines, limpia la pantalla con:  clear\n");
