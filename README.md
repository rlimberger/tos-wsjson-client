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

## paperMoney futures order scaffold

Use the paperMoney factory to keep futures work separate from the live service.
The order builder creates the confirmation and submission payloads but does not
send them.

```typescript
import {
  PaperMoneyFuturesOrderBuilder,
  RealWsJsonClient,
} from "tos-wsjson-client";

const client = RealWsJsonClient.forPaperMoney();
const order = new PaperMoneyFuturesOrderBuilder({
  accountNumber: "123456789",
  rootSymbol: "/ES",
  contractSymbol: "/ESU26",
  side: "BUY",
  quantity: 1,
  limitPrice: 6500.25,
});

const confirmationRequest = order.buildConfirmationRequest();
const submissionRequest = order.buildSubmissionRequest(123456);
```

The submission request needs the draft order ID from the confirmation response.
This first scaffold supports exact-contract, single-leg, day limit orders only.

# Running tests

`yarn test`

# License

MIT
