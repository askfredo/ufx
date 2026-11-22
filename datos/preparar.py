# Arma datos/historico.csv: índices base 100 en dic-2003 para cada parte de la canasta + IPC (base 1).
# Proxies (con dividendos): acciones globales = 60% SPY + 40% EFA (rebalanceo mensual), bonos = AGG,
# oro = GC=F, inmuebles = IYR, energía = CL=F (WTI), materias primas = S&P GSCI, bitcoin = BTC-USD.
# IPC = CPIAUCSL de EE.UU. con un mes de rezago, igual que la UF usa el IPC del mes anterior.
import pandas as pd
m = pd.read_csv("datos/mensual_raw.csv", index_col=0, parse_dates=True).loc["2003-12-31":]
r = m.pct_change()
acc = (1 + 0.6 * r["SPY"] + 0.4 * r["EFA"]).fillna(1).cumprod() * 100
out = pd.DataFrame({
    "acciones": acc,
    "bonos": m["AGG"] / m["AGG"].iloc[0] * 100,
    "oro": m["GC=F"] / m["GC=F"].iloc[0] * 100,
    "inmuebles": m["IYR"] / m["IYR"].iloc[0] * 100,
    "energia": m["CL=F"] / m["CL=F"].iloc[0] * 100,
    "materias": m["^SPGSCI"] / m["^SPGSCI"].iloc[0] * 100,
    # Bitcoin existe en Yahoo desde sep-2014: base 100 en su primer mes (vacío antes).
    "btc": m["BTC-USD"] / m["BTC-USD"].dropna().iloc[0] * 100,
})
# El IPC de oct-2025 no se publicó (cierre del gobierno de EE.UU.): se interpola.
ipc = m["ipc"].interpolate().shift(1)
ipc.iloc[0] = m["ipc"].iloc[0]  # dic-2003 de base
out["ipc"] = ipc / ipc.iloc[0]
# Stablecoin con rendimiento: invertir en T-bills a la tasa del mes (base 100).
tb = m["tbill"].ffill()
out["stable"] = (1 + tb.shift(1).fillna(0) / 100 / 12).cumprod() * 100
out["tasa"] = tb.shift(1).fillna(tb.iloc[0]) / 100  # tasa anual vigente durante el mes (no se re-basa)
out.index = out.index.strftime("%Y-%m")
out.round(6).to_csv("datos/historico.csv", index_label="fecha")
print(len(out)); print(out.loc[["2003-12","2008-12","2009-02","2020-04","2022-12",out.index[-1]]])
