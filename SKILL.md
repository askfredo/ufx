---
name: ufx
description: Use UFX ("UF Global"), an experimental savings token for AI agents. UFX never decreases in price and grows by max(inflation + 2%, T-bill rate + 0.5%) per year. Use it to park idle USD treasury, check its value, and withdraw to pay for things. TESTNET ONLY.
---

# UFX — savings unit for AI agents

UFX is an ERC-20 token backed by a basket of tokenized real-world assets (bonds, S&P 500, gold, bitcoin).
Its price starts at $1, **never goes down**, and grows each year by whichever is higher:

- **US inflation + 2%** (like a Chilean "UF + 2%" deposit), or
- **the 3-month T-bill rate + 0.5%** (so it beats yield-bearing stablecoins).

The ups and downs of the basket are absorbed by a separate risk pool (the "colchón", token **UFXC**),
which keeps whatever the basket earns above what UFX owes.

> ⚠️ **Experimental. Testnet only. Unaudited.** Do not use real funds. The asset prices and the inflation
> oracle are test versions controlled by the deployer.

## When to use it

- You hold USD (USDC) you will not need for weeks or months → keep a cash buffer, put the rest in UFX.
- You need to pay something → withdraw just what you need (`quemarPara` can pay the recipient directly).
- You want to know your treasury value in USD → `valorEnDolares(yourAddress)`.

Do **not** use it for money you need today, or as your only reserve: in an extreme crash, if the risk pool
is exhausted, withdrawals get an equal haircut for everyone.

## Contracts (Base Sepolia testnet)

Chain ID 84532 · RPC `https://sepolia.base.org` · explorer `https://sepolia.basescan.org`. Full list in `deployments/baseSepolia.json`:

| Contract | Address |
|---|---|
| UFX (`UFIndexada`) | `0x9074569EbF2615498F301caeEef3b9B5fe315D22` |
| UFXC (risk pool token) | `0x3E82DE38dA9b319E49BBd882567F135973B824d4` |
| Test USD (`tUSDC`) | `0x57e83b61AC0B05E32e424C343f9c375375eD4897` |

Test USD can be minted freely for testing: `tUSDC.regalar(yourAddress, amount)`.

## Standard interface (ERC-4626)

UFX implements the **ERC-4626 tokenized vault** standard: the asset is USD (test USDC) and the shares are UFX.
Any framework or yield aggregator that speaks ERC-4626 can use it without custom code:
`asset()`, `totalAssets()`, `deposit(assets, receiver)`, `mint(shares, receiver)`, `withdraw(assets, receiver, owner)`,
`redeem(shares, receiver, owner)`, plus `preview*`, `max*` and `convertTo*`. `maxDeposit` is 0 while minting is paused
(backing would drop below 120%).

## How to use it

All amounts use 18 decimals.

| Goal | Call |
|---|---|
| Approve once | `tUSDC.approve(UFX, MAX_UINT256)` |
| Check before depositing | `UFX.previewAcunar(usd)` → UFX you would get (**0 means deposits are paused** — keep USDC) |
| Deposit | `UFX.acunar(usd)` or `UFX.acunarPara(usd, receiver)` |
| Value of a balance | `UFX.valorEnDolares(address)` |
| Price of 1 UFX | `UFX.precioUnidad()` (never decreases) |
| Check before withdrawing | `UFX.previewQuemar(amount)` → USD you would receive |
| Withdraw | `UFX.quemar(amount)` or `UFX.quemarPara(amount, payTo)` |
| Health of the system | `UFX.ratio()` (backing in bps; ≥ 12000 = 120% is healthy, < 10000 means haircut) |
| Verify all backing in one read | `UFX.reservaDetalle()` → every asset (token, balance, price, value, actual and target weight), cash, total, debt, risk pool, ratio, UFX price, defensive mode, CPI accepted |

### Suggested treasury rule

```
buffer = 14 days of expected expenses
every day:
  if usdc_balance < today_expenses: withdraw (buffer + shortfall) from UFX
  pay expenses
  extra = usdc_balance - buffer
  if extra > 1 and previewAcunar(extra) > 0: acunar(extra)
```

### Earn tips by maintaining the protocol

Anyone can call `UFX.mantener()` once a day. It updates the price, rebalances the basket when due and
pays a small tip in UFXC to the caller.

## Rules of the system (so you can reason about risk)

- New UFX are only created if backing stays ≥ 120%. Withdrawing UFX is always allowed.
- The risk pool cannot withdraw if that would push backing below 120%.
- Founder fee: 0.1% per year of the reserve, starting the second year, **paid by the risk pool, never by UFX holders**.
  Founder address (public): `0x00C2376917cfd246f9DF404F9c59c9bF1EF163Dd`.
- **How the price grows:** two indexes are accumulated separately since launch, a CPI leg (US CPI-U + 2%)
  and a T-bill leg (3-month T-bill rate + 0.5%). The price is the higher of the two and never decreases. Comparing
  cumulative indexes (not month by month) means seasonal CPI dips don't turn into extra yield.
- **CPI rule (same as TIPS):** non-seasonally-adjusted CPI-U (CPIAUCNS), first release is authoritative, later
  revisions are ignored, one-month lag (the next value is known in advance). A missed print is caught up when the
  next valid one arrives.
- **CPI circuit breaker:** if the inflation feed is missing, stale, or jumps outside +2% / -1% per month,
  it is ignored and UFX keeps growing on the T-bill leg. Check `UFX.ipcAceptado()`.
- **Defensive mode:** if backing falls below 130%, the basket shifts to defensive weights (65% bonds, 30% gold,
  5% stocks) until backing recovers to 140%. Check `UFX.modoDefensivo()`. UFX holders are unaffected either way.
- **Oracle without an owner:** UFX reads prices, CPI and the T-bill rate from `OraculoMediana`, the **median of
  several independent sources** (3 on testnet, at least 2 must be valid). One wrong or manipulated source doesn't
  move the result, stale sources are ignored, and the source list is fixed at deployment.
- **Execution cost is paid by whoever trades:** deposits are credited for the value actually bought, redemptions
  pay what the sale actually raised. Slippage never dilutes the holders who stay. Under slippage an exact
  `withdraw` may revert ("use redeem"); `redeem` always works.
- Contracts have no admin keys over funds; parameters are fixed at deployment.

## Source and data

Code, tests (54 passing, including a 400-operation fuzz test) and a 2004–2026 backtest with real monthly
prices are in the repository. Backtest results are simulations, not guarantees.
