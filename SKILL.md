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
| UFX (`UFIndexada`) | `0xfE752E44B984475bA37F805071e30029360e5a77` |
| UFXC (risk pool token) | `0xD79506A8c087FEe63b1a4BE4F29CD53ebacF7d3B` |
| Test USD (`tUSDC`) | `0x44F096924Cb5Ffa1173ac7D1660592c10317618f` |

Test USD can be minted freely for testing: `tUSDC.regalar(yourAddress, amount)`.

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
- Contracts have no admin keys over funds; parameters are fixed at deployment.

## Source and data

Code, tests (31 passing, including a 400-operation fuzz test) and a 2004–2026 backtest with real monthly
prices are in the repository. Backtest results are simulations, not guarantees.
