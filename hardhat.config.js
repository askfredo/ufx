require("@nomicfoundation/hardhat-toolbox");
const { vars } = require("hardhat/config");

// Para la red de pruebas pública (Base Sepolia), guarda tu clave con:
//   npx hardhat vars set DEPLOYER_KEY
// (queda fuera del proyecto; nunca la escribas en un archivo ni la pegues en un chat)
const cuentas = vars.has("DEPLOYER_KEY") ? [vars.get("DEPLOYER_KEY")] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: { version: "0.8.24", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", viaIR: true } },
  networks: {
    baseSepolia: {
      url: vars.get("BASE_SEPOLIA_RPC", "https://sepolia.base.org"),
      chainId: 84532,
      accounts: cuentas,
    },
  },
};
