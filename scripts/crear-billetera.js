// Crea una billetera SOLO PARA LA RED DE PRUEBAS y la deja lista para Hardhat, sin mostrar la clave.
// Ejecutar:  node scripts/crear-billetera.js
// Guarda las 12 palabras y la clave en ~/.ufx-testnet/billetera.json (solo tu usuario puede leerlo)
// y configura DEPLOYER_KEY en las variables de Hardhat. Solo imprime la dirección pública.
// Para ver las palabras y anotarlas:  node scripts/ver-billetera.js   (en tu propia terminal)
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { Wallet } = require("ethers");

const dir = path.join(os.homedir(), ".ufx-testnet");
const archivo = path.join(dir, "billetera.json");

if (fs.existsSync(archivo)) {
  const { address } = JSON.parse(fs.readFileSync(archivo, "utf8"));
  console.log(`Ya existe una billetera de prueba: ${address}`);
  console.log(`No se creó otra para no perder la anterior (${archivo}).`);
  process.exit(0);
}

const w = Wallet.createRandom();
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
fs.writeFileSync(
  archivo,
  JSON.stringify({
    uso: "SOLO red de pruebas (Base Sepolia). Nunca enviar fondos reales.",
    address: w.address,
    palabras: w.mnemonic.phrase,
    clavePrivada: w.privateKey,
    creada: new Date().toISOString(),
  }, null, 2),
  { mode: 0o600 }
);

// Configura Hardhat sin imprimir la clave.
execFileSync("npx", ["hardhat", "vars", "set", "DEPLOYER_KEY", w.privateKey], { cwd: path.join(__dirname, ".."), stdio: "ignore" });

console.log("Billetera de prueba creada.");
console.log(`Dirección pública: ${w.address}`);
console.log(`Guardada en ${archivo} (solo tu usuario puede leerla) y configurada en Hardhat como DEPLOYER_KEY.`);
console.log("Para ver las 12 palabras y anotarlas en papel, en TU terminal:  node scripts/ver-billetera.js");
