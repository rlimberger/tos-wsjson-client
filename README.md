# thinkorswim WsJson API client

This is a node and browser API client for the (undocumented) thinkorswim WebSocket API.

🚧 Work in progress 🚧

# Prerequisites

- Node 18+

# Building for Node

```
yarn install
yarn build
```

# Running the test app

Create a `.env` file with the following:

```
NODE_ENV=development
DEBUG=*
DEBUG_DEPTH=5
# either the following
TOS_ACCESS_TOKEN=<access_token>
TOS_REFRESH_TOKEN=<refresh_token>
# or the following
# if you don't have an access token and refresh token, you can use your username and password
# this will launch a browser to authenticate and then save the access token and refresh token
to the .env.development file.
TOS_USERNAME=<username>
TOS_PASSWORD=<password>
```

```
node --env-file=.env dist/example/testApp.js
```

## Running the proxy server

```
node --env-file=.env dist/example/wsProxyServer.js
```

## Running the proxy client

```
node dist/example/wsProxyClient.js
> authenticateWithAccessToken {"accessToken":"<auth_token>","refreshToken":"<refresh_token>"}
> quotes ["ABNB", "UBER"]
> accountPositions "1234567890"
```

## Authentication flow

There seems to be currently two ways to authenticate:

1. From scratch with username and password:

   1.1 Send a message with the `login/schwab` service including the `authCode` obtained from the browser oauth flow at `trade.thinkorswim.com`;

   1.2 This will return a `token` and `refreshToken` which should be saved for future use;

   1.3. The `authCode` is single use and cannot be used again once exchanged for a token.

2. From a previously obtained `token`

   2.1 Send a message with the `login` service including the `token` returned from the `login/schwab` response message (step 1 above)

   2.2 This will return the same `token`, weirdly, and a `refreshToken`, which should be saved for future use

   2.3 The token is valid for 24 hours.

# PaperMoney futures order builder

This fork adds a futures order builder that talks to the thinkorswim **PaperMoney** `wsjson` gateway. Futures use the same `place_order` `INIT_STOCK` / `EDIT_ORDER` pair as stocks: there is no `INIT_FUTURE`. The missing piece is `future_series`, which turns a root such as `/MES` into the tradeable contract (e.g. `/MESU26`).

Live routing is gated off. `RealWsJsonClient.create()` defaults to PaperMoney and throws if you pass `tradingSystem: "LiveTrading"` without `{ allowLiveTrading: true }`.

CONFIRM is a draft/validation call. SUBMIT is the state-changing call. The builder will not SUBMIT unless you have a `ConfirmedFuturesDraft` from a successful CONFIRM, and the example CLI is confirm-only unless you pass `--submit`.

```
yarn build
# first run: Chrome opens, you log in, tokens are saved to .env
node --env-file=.env dist/example/futuresPaperOrder.js --login
# confirm only (default)
node --env-file=.env dist/example/futuresPaperOrder.js
# actually submit on paper (LIMIT far from the market is safest)
FUT_ROOT=/MES FUT_LIMIT=1 node --env-file=.env dist/example/futuresPaperOrder.js --submit
```

`--login` opens a real Chrome window. Complete Schwab login and MFA yourself; the script only watches the SPA's WebSocket and writes `TOS_GATEWAY_URL` / `TOS_ACCESS_TOKEN` / `TOS_ACCOUNT_CODE` to `.env`. It does not type credentials.

```typescript
const client = await RealWsJsonClient.create({ tradingSystem: "PaperMoney" });
await client.authenticateWithAccessToken({ accessToken, refreshToken });
const { defaultAccountCode } = (await client.userProperties()).body;
const draft = await client.futuresOrderBuilder().confirm("/MES", {
  accountNumber: defaultAccountCode as string,
  side: "BUY",
  quantity: 1,
  orderType: "LIMIT",
  limitPrice: 1,
});
// inspect draft.confirmation, then:
// await client.futuresOrderBuilder().submit(draft);
```

# Working-order watcher

A heartbeat watchdog keeps the PaperMoney socket alive (30s of silence → reconnect, replay `order_events`, up to 3 attempts). The GPUI window shows **working** orders only: a cancel or fill from thinkorswim Web drops the row when the matching event arrives.

```
# sidecar only (NDJSON on stdout)
node --env-file=.env dist/example/orderWatcher.js

# desktop window (spawns the sidecar)
cargo run --manifest-path apps/order-watch/Cargo.toml --release
```

# Supported APIs

- ✅ Authentication via access token
- ✅ Quotes
- ✅ Price History (chart)
- ✅ Account positions
- ✅ Place & submit order
- ✅ Cancel order
- ✅ User properties
- ✅ Create alert
- ✅ Cancel alert
- ✅ Instrument search
- ✅ Option chains
- ✅ Alert lookup
- ✅ Option chain details
- ✅ Option chain quotes
- ✅ Option quotes
- ✅ Order events (full WORKING/QUEUED/FILLED/CANCELED/FINAL/EXECUTION subscription)
- ✅ `future_series` + PaperMoney futures CONFIRM/SUBMIT builder
- ✅ Market depth
- ✅ Get watchlist

# Not yet implemented

- ❌ Instrument order events
- ❌ Alert subscription
- ❌ And many more 😀

# Usage

```
yarn add tos-wsjson-client
```

```typescript
import { WsJsonClient } from "toa-wsjson-client";

const client = new WsJsonClient();
await client.authenticateWithAccessToken(accessToken, refreshToken);
const chartRequest = {
  symbol: "UBER",
  timeAggregation: "DAY",
  range: "YEAR2",
  includeExtendedHours: true,
};
for await (const { body: event } of client.chart(chartRequest)) {
  console.log(event);
}
```

For more sample usage check out https://github.com/huskly/tos-wsjson-client/blob/master/src/example/testApp.ts

# Running tests

`yarn test`

# License

MIT

## Futures orders (PaperMoney scaffold)

thinkorswim Web places futures through the same `place_order` flow as stocks
(`requestType: "INIT_STOCK"` → `EDIT_ORDER`); the only futures-specific step is
resolving a root (`/MES`) to a contract (`/MESU26`) via the `future_series`
service. This fork adds:

- `RealWsJsonClient.create({ tradingSystem: "PaperMoney" | "LiveTrading" })` —
  resolves the gateway URL from `https://trade.thinkorswim.com/v1/api/config`.
- `client.futureSeries(root)` — contracts for a root; `activeContract()` picks the one the UI trades.
- `client.confirmOrder(...)` / `client.submitDraftOrder(...)` — generic CONFIRM/SUBMIT
  builders supporting `LIMIT | MARKET | STOP | STOPLIMIT`, `tif`, `marker`, `refOrderId`.
- `client.placeFuturesOrder(root, { accountNumber, side, quantity, orderType, limitPrice }, { dryRun })`
  — resolve → CONFIRM → (SUBMIT). `dryRun` defaults to **true**.
- Responses now carry `id`/`ver`/`type`, and handlers that declare `requestId()` only
  receive responses for their own request id; `type: "error"` frames are surfaced.

Example (paper money, confirm only; add `--submit` to send):

```
yarn build
touch .env   # node refuses a missing --env-file
node --env-file=.env dist/example/futuresPaperOrder.js            # opens Chrome on first run
FUT_ROOT=/MES FUT_SIDE=BUY FUT_QTY=1 FUT_TYPE=LIMIT FUT_LIMIT=1000 \
  node --env-file=.env dist/example/futuresPaperOrder.js --submit
```

Login is interactive: `src/example/browserSession.ts` opens a headful Chrome
(persistent profile in `./puppeteer-data`), you sign in normally, and it
captures — from the SPA's own WebSocket via DevTools — the gateway URL, the
`login/schwab`/`login` token + refresh token and your default account code,
then saves them to `.env`. For PaperMoney, switch the web UI to paperMoney; the
SPA reconnects to the paper gateway and the script picks up that session
instead. Use `--login` to force a new capture. `node dist/example/browserSession.js`
runs the capture alone.
