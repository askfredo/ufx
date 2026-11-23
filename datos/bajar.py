# Baja precios mensuales (fin de mes, con dividendos) desde dic-2003 y el IPC de EE.UU. (FRED).
import io, urllib.request
import pandas as pd, yfinance as yf

tickers = ["SPY", "EFA", "AGG", "GC=F", "IYR", "CL=F", "^SPGSCI", "BTC-USD"]
raw = yf.download(tickers, start="2003-11-01", end="2026-11-01", interval="1d", auto_adjust=True, progress=False)["Close"]
m = raw.resample("ME").last()
print(m.head(3)); print(m.tail(2)); print(m.isna().sum())

cpi = pd.read_csv(io.StringIO(urllib.request.urlopen("https://fred.stlouisfed.org/graph/fredgraph.csv?id=CPIAUCNS").read().decode()))
cpi.columns = ["fecha", "ipc"]; cpi["fecha"] = pd.to_datetime(cpi["fecha"]) + pd.offsets.MonthEnd(0)
m = m.join(cpi.set_index("fecha")["ipc"])

# Tasa de los T-bills a 3 meses (lo que pagan las stablecoins con rendimiento como sUSDS/USDY), % anual.
tb = pd.read_csv(io.StringIO(urllib.request.urlopen("https://fred.stlouisfed.org/graph/fredgraph.csv?id=TB3MS").read().decode()))
tb.columns = ["fecha", "tbill"]; tb["fecha"] = pd.to_datetime(tb["fecha"]) + pd.offsets.MonthEnd(0)
m = m.join(tb.set_index("fecha")["tbill"])
m.to_csv("datos/mensual_raw.csv")
print(m["ipc"].tail(3))
