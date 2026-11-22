# Compara el rendimiento anual de UFX con stablecoins/staking que pagan rendimiento (DeFiLlama) y T-bills (FRED).
# Uso: .venv/bin/python datos/comparar.py   (requiere datos/defi_apy_diario.csv y datos/ufx-precio-2004.csv)
import pandas as pd, yfinance as yf

apy = pd.read_csv("datos/defi_apy_diario.csv", index_col=0, parse_dates=True)
ufx = pd.read_csv("datos/ufx-precio-2004.csv", index_col=0)["precio_ufx"]
hist = pd.read_csv("datos/historico.csv", index_col=0)
eth = yf.download("ETH-USD", start="2021-12-01", progress=False, auto_adjust=True)["Close"].squeeze()

def tasa_anual(s, y):
    """Rendimiento anualizado de un APY diario dentro del año y (componiendo día a día)."""
    s = s[s.index.year == y].dropna()
    if len(s) < 20: return None, False
    crec = ((1 + s / 100) ** (1 / 365)).prod()
    return (crec ** (365 / len(s)) - 1) * 100, len(s) < 330

def anual_mensual(serie, y):
    """Rendimiento anual de una serie de nivel mensual (dic a dic; 2026 anualizado hasta oct)."""
    fin = serie[[i for i in serie.index if i.startswith(str(y))]]
    ini = serie.get(f"{y-1}-12")
    meses = len(fin)
    return ((fin.iloc[-1] / ini) ** (12 / meses) - 1) * 100

productos = [
    ("USDC en Aave v3", "aave_usdc", "Préstamos DeFi, tasa variable"),
    ("USDC en Compound v2", "comp2_usdc", "Préstamos DeFi, tasa variable"),
    ("sUSDS (Sky)", "susds", "Tasa de ahorro de Sky (ex-DSR)"),
    ("sUSDe (Ethena)", "susde", "Funding de futuros cripto"),
    ("USDY (Ondo)", "usdy", "T-bills tokenizados"),
    ("stETH (Lido), en ETH", "steth", "Staking de ETH"),
    ("rETH (Rocket Pool), en ETH", "reth", "Staking de ETH"),
]
anios = [2022, 2023, 2024, 2025, 2026]
filas = []
filas.append(["UFX (inflación+2% o T-bills+0,5%)", "Canasta + colchón"] + [f"{anual_mensual(ufx, y):.1f}%" for y in anios])
filas.append(["T-bills 3 meses (FRED)", "Referencia stablecoins"] + [f"{anual_mensual(hist['stable'], y):.1f}%" for y in anios])
for nombre, col, tipo in productos:
    fila = [nombre, tipo]
    for y in anios:
        r, parcial = tasa_anual(apy[col], y)
        fila.append("—" if r is None else f"{r:.1f}%" + ("*" if parcial and y != 2026 else ""))
    filas.append(fila)
fila = ["stETH medido en dólares", "Staking + precio de ETH"]
for y in anios:
    r, _ = tasa_anual(apy["steth"], y)
    e = eth[eth.index.year == y]; e0 = eth[eth.index.year == y - 1]
    if r is None or e0.empty: fila.append("—"); continue
    fila.append(f"{((1 + r / 100) * (e.iloc[-1] / e0.iloc[-1]) - 1) * 100:+.0f}%")
filas.append(fila)
filas.append(["USDC solo", "Sin rendimiento"] + ["0.0%"] * len(anios))
filas.append(["Inflación EE.UU.", ""] + [f"{anual_mensual(hist['ipc'], y):.1f}%" for y in anios])

t = pd.DataFrame(filas, columns=["Producto", "Fuente del rendimiento"] + [str(y) if y < 2026 else "2026 (anualizado)" for y in anios])
print(t.to_string(index=False))
t.to_csv("datos/comparacion-rendimientos.csv", index=False)
print("\n* año parcial (el producto empezó a medirse a mitad de año), anualizado")
