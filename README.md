# Solana Paper Trader

An autonomous **paper-trading** bot for Solana memecoins, plus a live web dashboard. It runs a 7-day forward test that starts with 10,000 simulated ISK.

> **Simulation only.** There is no wallet and no private key, and no transaction is ever signed or sent. All data sources are read-only. Results are simulated and are **not** real trading performance.

## Requirements

- Node.js **22.13+** (tested on 24). It uses Node's built-in SQLite and runs TypeScript directly, with no native modules and no compile step.
- An internet connection, kept up for the full 7 days.

## Start the seven-day experiment

```bash
npm install
npm run build          # build the dashboard once
npm test               # 26 tests: execution, risk limits, accounting, engine
npm start              # starts the engine and the dashboard at http://localhost:8787
```

Then, in a second terminal (or with the **Start 7-day experiment** button on the dashboard):

```bash
npm run experiment:start
```

That's it. Leave `npm start` running for the full seven days. On macOS, stop the computer from sleeping while it runs:

```bash
caffeinate -i npm start
```

Other commands:

| Command | What it does |
|---|---|
| `npm run experiment:status` | One-line summary of the current experiment |
| `npm run report` | Writes an interim (or final) report to `reports/` |
| `npm run experiment:reset` | Moves the database to a `.bak` file so you can start fresh |

When the seven days are up, the engine closes any open positions at simulated, realistic fills and stops trading. It then writes `reports/experiment-<id>-final.md` and `.json`; the dashboard links to the report too.

## Restarts and outages

Every simulated execution is written in a single SQLite transaction: cash, the position and the trade row land together or not at all. If you stop or crash the engine, `npm start` resumes the same experiment with the same positions. While it's down nothing is traded, and the chart shows a gap instead of invented data.

If DexScreener prices, the SOL price or the USD/ISK rate go stale, the bot **pauses trading** and the dashboard shows why. Open positions are never exited on a guessed price.

## How it trades

**Discovery.** It pulls new token addresses from DexScreener's token profiles and boosts, and from GeckoTerminal's trending Solana pools (addresses only). All prices and market data come from DexScreener.

**Filters** (all can be changed in config):
- liquidity of at least $40k
- 24h volume of at least $100k
- pair age between 2 hours and 60 days
- at least 150 transactions per hour
- not up more than 150% in the last hour
- liquidity of at least 3% of FDV
- no one-sided order flow that looks like a honeypot

**Safety checks before every buy:**
- **On-chain (public Solana RPC):** mint authority and freeze authority must be revoked, and the top 10 holders, excluding known AMM pool vaults, must own at most 50%.
- **Jupiter round trip:** quote the buy, then quote selling the tokens straight back. If that round trip loses more than 6%, the token is skipped (sell tax, honeypot or thin route). Tokens with no sell route are marked unsafe.

**Entry.** A momentum score from 0 to 100 built from:
- 5-minute and 1-hour price change
- buy/sell ratio
- volume acceleration
- the bot's own forward price observations, which must cover at least 5 minutes and confirm the move

It enters at a score of 65 or higher, one entry per tick.

**Exits:**
- take profit at +20%
- stop loss at −10%
- trailing stop, which arms at +12% and exits 7% below the peak
- time stop after 4 hours
- daily loss limit
- end of the experiment

**Risk limits:**
- at most 700 ISK per position, fees included
- at most 2 open positions
- daily loss limit of 350 ISK: day P/L (realised and unrealised, after all costs, UTC day) at or below −350 ISK closes all positions and halts new entries until 00:00 UTC
- a 2-hour cooldown before re-entering the same token

## Execution simulation (never the last displayed price)

1. **Live Jupiter quote** for the exact size. For exits only, if Jupiter is unreachable, a constant-product model on DexScreener liquidity is used, with a 0.25% DEX fee and a 1% spread, and the trade is labelled `model`.
2. **Latency drift.** Random adverse movement between quote and landing (mean 25 bps, standard deviation 40 bps).
3. **Slippage tolerance.** If the drift exceeds 300 bps, the transaction fails.
4. **Random failures.** 5% of transactions are dropped. A failed transaction still pays its network fee, and exits retry on the next tick.
5. **Network fees.** 5,000 lamports base plus a 200,000-lamport priority fee per transaction.
6. **Currency.** Cash is held in ISK. Each trade converts ISK and SOL at the live SOL/USD × USD/ISK reference rate. No FX spread is modelled.

Every trade row stores the mark, the quote, the fill, the price impact, the latency drift, fees in SOL and ISK, the slippage cost in ISK, the reason, and the full set of assumptions. Click any transaction on the dashboard to see them.

The **buy-and-hold SOL benchmark** is 10,000 ISK converted to SOL at the start, valued at the live SOL/USD and USD/ISK rates.

## Configuration

Copy `config.example.json` to `config.local.json` and change any value; anything you leave out keeps its default. See `server/src/config.ts` for every option. Change config **before** starting an experiment, so the whole week runs on one set of rules.

## Project layout

```
server/src/
  main.ts          engine and HTTP API (serves the dashboard)
  engine.ts        tick loop: data refresh → exits → risk → entries → equity
  strategy.ts      filters, momentum score, exit rules
  execution.ts     swap simulation (quotes, latency, failures, fees)
  risk.ts          position sizing and risk gates
  accounting.ts    P/L, drawdown, trade statistics
  report.ts        final report (JSON and Markdown) and SOL comparison
  db.ts            SQLite schema and storage
  feeds/           DexScreener, Jupiter (quotes only), Solana RPC (read-only), FX
server/test/       node:test suites
web/               React + TypeScript + Tailwind dashboard, built on shadcn/ui and the @efferd/dashboard-3 block
  src/trader/      the trading dashboard (app shell, cards, charts and tables, all fed by /api/state)
  src/components/  shadcn/ui primitives and the installed efferd block (its demo components are kept for reference)
data/              SQLite database (created on first run)
reports/           generated reports
```

## Limits worth knowing

- Seven days is a short sample. A handful of trades proves nothing either way; the report says so when there are fewer than 20.
- Real fills can be worse than simulated: MEV and sandwich attacks, congestion, a rug pull between quote and fill, and token-2022 transfer fees that Jupiter quotes may not capture.
- The holder concentration figure is approximate, because pool vaults of unknown AMMs count as holders.
- Free public endpoints have rate limits. If they throttle, the bot pauses instead of guessing.
