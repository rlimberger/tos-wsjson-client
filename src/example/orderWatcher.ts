/**
 * Long-lived PaperMoney order watcher.
 *
 * Prints one NDJSON object per line on stdout (the GPUI app reads this).
 * Logs go to stderr. Heartbeat watchdog reconnects the socket; order_events
 * is re-subscribed after each reconnect so cancels/fills from the web UI
 * keep landing here.
 *
 *   node --env-file=.env dist/example/orderWatcher.js
 */
import "dotenv/config";
import { RealWsJsonClient } from "../client/realWsJsonClient.js";
import { ordersFromEventsBody } from "../client/orders/workingOrderBook.js";
import { sessionFromEnv } from "./browserSession.js";

type WatcherMsg =
  | {
      v: 1;
      type: "hello";
      account: string;
      tradingSystem: string;
      gatewayUrl: string;
    }
  | {
      v: 1;
      type: "connection";
      state: string;
      attempt?: number;
      delayMs?: number;
      reason?: string;
    }
  | { v: 1; type: "orders"; orders: ReturnType<typeof ordersFromEventsBody> }
  | { v: 1; type: "error"; message: string };

function emit(msg: WatcherMsg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function log(msg: string) {
  process.stderr.write(msg + "\n");
}

async function main() {
  const session = sessionFromEnv();
  if (!session) {
    throw new Error(
      "missing session; run `node dist/example/browserSession.js PaperMoney` first",
    );
  }
  if (session.tradingSystem !== "PaperMoney") {
    throw new Error("order watcher is PaperMoney-only");
  }

  const client = await RealWsJsonClient.create({
    tradingSystem: "PaperMoney",
    gatewayUrl: session.gatewayUrl,
    watchdog: {
      heartbeatTimeoutMs: 30_000,
      maxReconnectAttempts: 3,
      onConnectionEvent: (event) => {
        emit({
          v: 1,
          type: "connection",
          state: event.type,
          attempt: "attempt" in event ? event.attempt : undefined,
          delayMs: "delayMs" in event ? event.delayMs : undefined,
          reason: "reason" in event ? event.reason : undefined,
        });
      },
    },
  });

  await client.authenticateWithAccessToken({
    accessToken: session.accessToken,
    refreshToken: session.refreshToken ?? "n/a",
  });

  const account =
    session.accountCode || (await client.resolveAccountCode()) || "";
  if (!account) throw new Error("could not resolve a paper account code");

  emit({
    v: 1,
    type: "hello",
    account,
    tradingSystem: "PaperMoney",
    gatewayUrl: session.gatewayUrl,
  });
  log(`watching account ${account} on PaperMoney`);

  for await (const frame of client.orderEvents(account)) {
    if (frame.service !== "order_events") continue;
    emit({
      v: 1,
      type: "orders",
      orders: ordersFromEventsBody(frame.body),
    });
  }
}

main().catch((e) => {
  emit({
    v: 1,
    type: "error",
    message: e instanceof Error ? e.message : String(e),
  });
  process.exit(1);
});
