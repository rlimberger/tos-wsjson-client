/**
 * Local order feed: keeps one authenticated wsjson session to the ToS gateway
 * and re-broadcasts the live order book as JSON over a localhost WebSocket, so
 * desktop UIs (e.g. the GPUI watcher) don't need to speak wsjson or hold the
 * session token.
 *
 *   node --env-file=.env dist/example/orderFeedServer.js [--port 8787]
 *
 * Wire protocol (one JSON object per WebSocket text frame):
 *   { "type": "session", "account": "D-…", "tradingSystem": "PaperMoney" }
 *   { "type": "orders",  "orders": [ …OrderRow… ], "at": 1690000000000 }
 *   { "type": "fills",   "fills": [ …Fill… ], "at": … }
 *   { "type": "positions", "positions": [ …PositionRow… ], "at": … }
 *   { "type": "connection", "state": "connected" | "reconnecting" | "disconnected" | "gaveUp" }
 * A fresh client immediately receives `session`, the latest `orders`, and the
 * current `connection` state.
 */
import { WebSocketServer, WebSocket as WsSocket } from "ws";
import { RealWsJsonClient } from "../client/realWsJsonClient.js";
import { Fill, FillLog } from "../client/orders/fills.js";
import {
  PositionRow,
  positionsFromBody,
} from "../client/orders/positionsBook.js";
import {
  DisplayOrder,
  ordersFromEventsBody,
} from "../client/orders/workingOrderBook.js";
import {
  BrowserSession,
  captureBrowserSession,
  saveSessionToDotEnv,
  sessionFromEnv,
} from "./browserSession.js";

/** The feed re-broadcasts the shared working-order book (see
 *  client/orders/workingOrderBook.ts): WORKING/QUEUED upsert, CANCELED/FILLED/
 *  FINAL remove, EXECUTION updates the fill quantity. A cancel made in the web
 *  UI therefore disappears from every connected watcher. */
export type OrderRow = DisplayOrder;

async function resolveSession(): Promise<BrowserSession> {
  const cached = sessionFromEnv();
  if (cached) return cached;
  const session = await captureBrowserSession({ tradingSystem: "PaperMoney" });
  saveSessionToDotEnv(session);
  return session;
}

export async function startOrderFeedServer(port = 8787) {
  const session = await resolveSession();
  const wss = new WebSocketServer({ host: "127.0.0.1", port });
  const clients = new Set<WsSocket>();
  let connectionState = "connecting";
  let latestOrders: DisplayOrder[] = [];
  let latestFills: Fill[] = [];
  let latestPositions: PositionRow[] = [];
  const fillLog = new FillLog();

  const broadcast = (msg: unknown) => {
    const data = JSON.stringify(msg);
    for (const c of clients) {
      if (c.readyState === c.OPEN) c.send(data);
    }
  };

  const client = await RealWsJsonClient.create({
    tradingSystem: session.tradingSystem,
    gatewayUrl: session.gatewayUrl,
    watchdog: {
      onConnectionEvent: (event) => {
        connectionState =
          event.type === "connected" ? "connected" : event.type.toLowerCase();
        broadcast({
          type: "connection",
          state: connectionState,
          detail: event,
        });
        console.log("[feed] connection:", JSON.stringify(event));
      },
    },
  });
  await client.authenticateWithAccessToken({
    accessToken: session.accessToken,
    refreshToken: session.refreshToken ?? "n/a",
  });
  const account =
    session.accountCode ??
    (await client.resolveAccountCode()) ??
    (() => {
      throw new Error("could not resolve an account code");
    })();

  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.send(
      JSON.stringify({
        type: "session",
        account,
        tradingSystem: session.tradingSystem,
      }),
    );
    ws.send(
      JSON.stringify({
        type: "orders",
        orders: latestOrders,
        at: Date.now(),
      }),
    );
    ws.send(
      JSON.stringify({ type: "fills", fills: latestFills, at: Date.now() }),
    );
    ws.send(
      JSON.stringify({
        type: "positions",
        positions: latestPositions,
        at: Date.now(),
      }),
    );
    ws.send(JSON.stringify({ type: "connection", state: connectionState }));
    ws.on("close", () => clients.delete(ws));
  });

  console.log(
    `[feed] serving ws://127.0.0.1:${port} — ${session.tradingSystem} account ${account}`,
  );

  void (async () => {
    for await (const ev of client.orderEvents(account)) {
      const orders = (ev.body.orders ?? []) as Parameters<FillLog["apply"]>[0];
      latestOrders = ordersFromEventsBody(ev.body);
      broadcast({ type: "orders", orders: latestOrders, at: Date.now() });

      // A marketable order can fill without ever appearing as WORKING, so the
      // fill log is the only place that order becomes visible.
      const before = latestFills.length;
      latestFills = fillLog.apply(orders);
      if (latestFills.length !== before) {
        broadcast({ type: "fills", fills: latestFills, at: Date.now() });
      }
      console.log(
        `[feed] ${latestOrders.length} working order(s), ${latestFills.length} fill(s)`,
      );
    }
  })();

  void (async () => {
    for await (const ev of client.accountPositions(account)) {
      latestPositions = positionsFromBody(ev.body);
      broadcast({
        type: "positions",
        positions: latestPositions,
        at: Date.now(),
      });
      console.log(`[feed] ${latestPositions.length} position(s)`);
    }
  })();

  const shutdown = () => {
    console.log("[feed] shutting down");
    client.disconnect();
    wss.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return { client, wss };
}

if (process.argv[1]?.endsWith("orderFeedServer.js")) {
  const portArg = process.argv.indexOf("--port");
  const port = portArg > -1 ? Number(process.argv[portArg + 1]) : 8787;
  startOrderFeedServer(port).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
