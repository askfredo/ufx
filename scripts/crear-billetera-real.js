// Genera la billetera REAL del fundador y muestra sus 12 palabras UNA SOLA VEZ, para anotarlas en papel.
// No guarda nada en disco ni en Hardhat. Ejecútalo en TU propia terminal, no dentro de un chat con una IA:
//   node scripts/crear-billetera-real.js
// Después: importa las 12 palabras en una app (Rabby, MetaMask, Coinbase Wallet) y usa solo la
// dirección pública como FUNDADOR al desplegar.
const readline = require("readline");
const { Wallet } = require("ethers");

const preguntar = (texto) => new Promise((ok) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(texto, (r) => { rl.close(); ok(r); });
});

async function main() {
  if (!process.stdout.isTTY) {
    console.log("Ejecútalo directamente en tu terminal (no redirigido ni dentro de un chat).");
    process.exit(1);
  }
  console.log("\nVas a ver las 12 palabras de tu billetera REAL. Ten lápiz y papel, y que nadie mire la pantalla.");
  await preguntar("Presiona Enter cuando estés listo... ");

  const w = Wallet.createRandom();
  console.log("\n  12 palabras (anótalas EN ORDEN):\n");
  w.mnemonic.phrase.split(" ").forEach((p, i) => console.log(`    ${String(i + 1).padStart(2)}. ${p}`));
  console.log(`\n  Dirección pública (esta sí se puede compartir): ${w.address}\n`);

  // Verificación: que estén bien anotadas.
  const n = 1 + Math.floor(Math.random() * 12);
  await preguntar("Cuando las tengas anotadas, presiona Enter (se borrará la pantalla)... ");
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H"); // limpia la pantalla y el historial visible
  const r = await preguntar(`Verificación: escribe la palabra número ${n} de tu papel: `);
  if (r.trim().toLowerCase() === w.mnemonic.phrase.split(" ")[n - 1]) {
    console.log("✔ Correcto.");
  } else {
    console.log("✘ No coincide. Revisa tu papel: si te equivocaste, vuelve a correr el script (se creará otra billetera).");
  }
  console.log(`\nDirección pública del fundador: ${w.address}`);
  console.log("Importa las 12 palabras en tu app de billetera. En este PC no quedó guardado nada.\n");
}

main();
