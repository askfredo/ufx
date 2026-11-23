# UFX — "UF Global"

**Una unidad de ahorro para agentes de IA (y personas):** un token en dólares que **nunca baja** y que sube
**lo que sea mayor entre inflación + 2% y la tasa de los T-bills + 0,5%**, como un depósito en "UF + x%".
Una regla clara, sin KYC ni intermediarios: algo que un agente puede programar y en lo que puede confiar.

> ⚠️ Prototipo. Probado solo con tokens de mentira en una blockchain local. Sin auditoría. No usar con plata real.

## Cómo funciona

| Quién | Pone | Recibe | Riesgo |
|---|---|---|---|
| **Ahorrador** | Dólares (desde $1) | UFX: inflación + 2% (o T-bills + 0,5%), nunca baja | Muy bajo |
| **Colchón** | Dólares | Todo lo que la canasta rinde por sobre lo que se debe a UFX | Alto: pierde primero |
| **Fundador** | El código | Comisión anual pequeña, desde el segundo año | — |

1. **Arranque:** primero se arma el colchón. UFX se abre cuando llega a `metaArranque`.
2. **Entrar:** los dólares compran la canasta y se crean UFX al precio del día.
3. **Precio:** sube solo con la inflación más la tasa fija, o con la tasa de los T-bills más el margen, lo que sea mayor. Se va acumulando y nunca baja.
4. **Canasta:** sube y baja; la diferencia la absorbe el colchón. Se rebalancea a los pesos objetivo.
5. **Salir:** se quema UFX y se recibe su valor en dólares. Si una crisis deja la reserva bajo la deuda, todos salen con el mismo descuento.
6. **Seguridad:** solo se crean UFX si el respaldo queda ≥ 120%; el colchón no puede retirarse si lo deja bajo 120%.
7. **Llegar primero conviene:** después del arranque, entrar al colchón cuesta 2% (queda para los que ya estaban) y salir antes de un año cuesta 1%.
8. **El colchón es un token (UFXC):** se puede transferir y vender en un exchange. Las partes llevan su antigüedad, así que la multa no se esquiva pasándolas a otra dirección.
9. **Cortacircuito del IPC:** si el dato de inflación falta, está viejo o salta más de +2% / -1% en un mes, se ignora y UFX sigue con la pata de T-bills. El contrato nunca se traba por el oráculo de inflación.
10. **Modo defensivo:** con el respaldo bajo 130%, la canasta pasa a pesos defensivos (más bonos y oro) hasta que se recupera a 140%. En el peor caso (lanzar en dic-2007) sube el respaldo mínimo de 87% a 103%.
11. **Se mantiene solo:** cualquier bot puede llamar `mantener()` una vez al día (actualiza el precio, rebalancea cuando toca) y cobra una propina en UFXC.

## Para agentes

| Función | Para qué |
|---|---|
| `acunar(usd)` / `acunarPara(usd, receptor)` | Guardar dólares en UFX (para sí o para otra dirección) |
| `quemar(cant)` / `quemarPara(cant, receptor)` | Sacar dólares (a sí o directo a quien hay que pagarle) |
| `valorEnDolares(dirección)` | Cuánto vale hoy un saldo |
| `reservaDetalle()` | Todo el respaldo en una lectura: cada activo (saldo, precio, valor, peso), caja, deuda, colchón, respaldo, modo defensivo e IPC |
| `previewAcunar(usd)` / `previewQuemar(cant)` | Simular antes de operar (`previewAcunar` devuelve 0 si la creación está pausada) |
| `precioUnidad()` | Precio de 1 UFX; nunca baja |
| `mantener()` | Mantención del protocolo con propina |

UFX es un ERC-20 estándar (transferirlo no ejecuta ninguna lógica extra) y además implementa **ERC-4626**: el activo es USD y las acciones son UFX, así que cualquier agregador o framework que entienda bóvedas ERC-4626 lo puede usar sin código especial. `scripts/agente-demo.js` muestra un agente
que cobra en USDC, deja dos semanas de gastos en caja y guarda el resto en UFX.

## Estructura

```
contracts/
  UFIndexada.sol      UFX (precio indexado, colchón, arranque, comisión, mantención) + ParteColchon (token UFXC)
  Canasta.sol         Piezas de prueba (TokenPrueba, OraculoPrueba, MercadoPrueba) y la v1 MonedaCanasta
test/
  UFIndexada.test.js  45 pruebas, incluida una al azar de 400 operaciones
scripts/
  desplegar-local.js  Despliega todo con tokens de mentira en un nodo local
  agente-demo.js      Un agente de IA manejando su tesorería con UFX + un bot de mantención
  config.js           Configuración del contrato desde variables de entorno
  backtest-2004.js    Backtest con precios reales mensuales 2004 → hoy
  simulacion-usuarios.js  Miles de usuarios + "Tú" (compra única o aportes mensuales)
  canasta.js          Canasta (opción BTC) y lectura de datos
  demo-canasta.js / demo-indexada.js  Demos con escenario inventado
datos/
  bajar.py, preparar.py   Descarga y prepara precios (Yahoo) e IPC/T-bills (FRED)
  comparar.py             Tabla vs stablecoins y staking (DeFiLlama)
```

## Uso

```bash
npm install
npm test                         # pruebas
npm run nodo                     # terminal 1: blockchain local
npm run desplegar:local          # terminal 2: despliega UFX con tokens de mentira
npm run agente                   # demo del agente de IA

npm run backtest                 # 2004 → hoy, precios reales
INICIO=2014-12 BTC=5 TU_ENTRA=2024-04 TU_INICIAL=1000 TU_MENSUAL=100 npm run simulacion
```

Para los datos: `python3 -m venv .venv && .venv/bin/pip install yfinance pandas`, luego
`.venv/bin/python datos/bajar.py && .venv/bin/python datos/preparar.py`.

### Opciones de los scripts

| Variable | Qué hace | Por defecto |
|---|---|---|
| `TASA` | % fijo sobre la inflación | 2 |
| `PISO`, `MARGEN` | piso de T-bills + margen | 1, 0.5 |
| `COMISION` | % anual del fundador | 0.1 (backtest: 0.01) |
| `CUOTA`, `MULTA` | entrada al colchón / salida antes de un año | 2, 1 |
| `COLCHON`, `META` | colchón inicial / meta de arranque | 4000 |
| `BTC` | % de bitcoin en la canasta (requiere `INICIO=2014-12`) | 0 |
| `INICIO` | primer mes del backtest | 2003-12 |
| `RECOMPENSA`, `REBALANCEO_DIAS` | propina por `mantener()` / días entre rebalanceos | 0, 365 |
| `DEFENSIVO` | respaldo (%) bajo el cual se usan pesos defensivos (0 = apagado) | 130 |

Los datos mensuales usan aproximaciones (con dividendos): acciones globales = 60% SPY + 40% EFA, bonos = AGG,
oro = GC=F, inmuebles = IYR, energía = CL=F, materias primas = S&P GSCI, bitcoin = BTC-USD, IPC = CPIAUCSL
(con un mes de rezago, como la UF; oct-2025 interpolado), T-bills = TB3MS. El backtest no incluye comisiones ni slippage.

## Resultados (simulados)

- **Backtest 2004–2026:** el ahorrador gana +2,6% real/año (5,3% nominal) contra 1,8% nominal de una stablecoin con rendimiento; el colchón gana ~7% real/año; respaldo mínimo 114% (feb-2009).
- **Peor caso** (lanzar en dic-2007): sin modo defensivo el respaldo baja a 87% durante 7 meses; con modo defensivo el mínimo es 103% y nunca baja de 100%.
- **2022–2026 contra productos reales:** ver `datos/comparacion-rendimientos.csv`.

## Lo que falta antes de usarlo con plata real

- Adaptadores reales (Uniswap/Curve, ERC-4626) en vez de `MercadoPrueba`, que acuña tokens gratis.
- Oráculos externos (Chainlink, inflación on-chain) en vez de `OraculoPrueba`, que tiene dueño.
- Entradas y salidas en lote diario (ERC-7540) para evitar aprovechar precios atrasados y reducir costos.
- Pruebas con tokens reales en un fork de Ethereum, red de pruebas pública y auditoría externa.

## Red de pruebas pública (Base Sepolia) y Moltbook

1. Crea una billetera solo para pruebas y consigue ETH de prueba en un faucet de Base Sepolia.
2. `npx hardhat vars set DEPLOYER_KEY` (pega la clave privada de esa billetera de prueba; queda fuera del proyecto).
3. `npm run desplegar:base-sepolia` → direcciones en `deployments/baseSepolia.json` y la tabla para `SKILL.md`.
4. `npm run precios:base-sepolia` al menos una vez al día (el oráculo de prueba rechaza precios de más de 2 días).
5. Sube el repositorio a GitHub y completa `<REPO_LINK>` y las direcciones en `moltbook/post-en.md` y `SKILL.md`.

`SKILL.md` explica a los agentes cómo usar UFX. En `moltbook/` están el post (inglés y español) y las preguntas
frecuentes con respuestas.

### Billetera de prueba

`node scripts/crear-billetera.js` crea una billetera solo para la red de pruebas, la guarda en
`~/.ufx-testnet/billetera.json` (permisos 600, fuera del proyecto) y la configura en Hardhat sin mostrar la clave.
`node scripts/ver-billetera.js` muestra las 12 palabras para anotarlas (ejecútalo en tu propia terminal).
`npm run saldo:base-sepolia` muestra el saldo.

## Historial de despliegues (Base Sepolia)

- **v4** (actual): interfaz estándar ERC-4626 (pregunta de adopción de cicadafinanceintern en Moltbook). Direcciones en `deployments/baseSepolia.json`.
- **v3**: `reservaDetalle()` para verificar todo el respaldo en una lectura (idea de muse_scanner en Moltbook). Direcciones en `deployments/baseSepolia-v3.json`.
- **v2**: cortacircuito del IPC y modo defensivo, a partir de comentarios en Moltbook. Direcciones en `deployments/baseSepolia-v2.json`.
- **v1**: primera versión. Direcciones en `deployments/baseSepolia-v1.json` (ya no se publican precios; quedó detenida).
