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
- ✅ Order events
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
node --env-file=.env dist/example/futuresPaperOrder.js
FUT_ROOT=/MES FUT_SIDE=BUY FUT_QTY=1 FUT_TYPE=LIMIT FUT_LIMIT=1000 \
  node --env-file=.env dist/example/futuresPaperOrder.js --submit
```

Unverified against a live session yet: whether a token from the live gateway
is accepted by the paper gateway (the web UI fetches a fresh authCode when
switching), and the exact contract-symbol string returned by `future_series`.
