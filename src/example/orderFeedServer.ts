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
 *   { "type": "dayOrders", "orders": [ …RawOrderHistoryEntry… ], "at": … }
 *   { "type": "dayTrades", "trades": [ …RawTradeHistoryEntry… ], "at": … }
 *   { "type": "account", "values": { NET_LIQ, FUTURES_CASH, … }, "at": … }
 *
 * Clients may also send commands:
 *   { "type": "place", "root": "/MES", "side": "BUY", "quantity": 1,
 *     "orderType": "LIMIT", "limitPrice": 1000, "tif": "DAY" }
 *   { "type": "cancel", "orderId": 5388218543 }
 * each answered with { "type": "commandResult", "ok": bool, "error"?, ... }.
 *
 * Every number shown downstream is one the gateway computed: day history comes
 * from `order_history`/`trade_history`, P/L from `positions`, and account
 * values from `statement`. Nothing here derives or aggregates.
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
  let latestDayOrders: unknown[] = [];
  let latestDayTrades: unknown[] = [];
  let latestAccountValues: Record<string, number> | undefined;
  const fillLog = new FillLog();

  const broadcast = (msg: unknown) => {
    const data = JSON.stringify(msg);
    for (const c of clients) {
      if (c.readyState === c.OPEN) c.send(data);
    }
  };

  let account: string | undefined;

  const sendSnapshot = (ws: WsSocket) => {
    ws.send(
      JSON.stringify({
        type: "session",
        account: account ?? null,
        tradingSystem: session.tradingSystem,
      }),
    );
    ws.send(
      JSON.stringify({ type: "orders", orders: latestOrders, at: Date.now() }),
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
    ws.send(
      JSON.stringify({
        type: "dayOrders",
        orders: latestDayOrders,
        at: Date.now(),
      }),
    );
    ws.send(
      JSON.stringify({
        type: "dayTrades",
        trades: latestDayTrades,
        at: Date.now(),
      }),
    );
    if (latestAccountValues) {
      ws.send(
        JSON.stringify({
          type: "account",
          values: latestAccountValues,
          at: Date.now(),
        }),
      );
    }
    ws.send(JSON.stringify({ type: "connection", state: connectionState }));
  };

  // Registered before the gateway login, not after: the port is listening from
  // the moment the server is constructed, and a watcher reconnecting during the
  // login window would otherwise be accepted and then never hear anything.
  wss.on("connection", (ws) => {
    clients.add(ws);
    sendSnapshot(ws);
    ws.on("message", (raw) => void handleCommand(ws, raw.toString()));
    ws.on("close", () => clients.delete(ws));
  });

  const reply = (ws: WsSocket, payload: Record<string, unknown>) =>
    ws.send(JSON.stringify({ type: "commandResult", ...payload }));

  /**
   * Order entry from a watcher. SUBMIT is only ever reached here — the UI never
   * holds a session — and LiveTrading stays gated by the builder itself.
   */
  const handleCommand = async (ws: WsSocket, raw: string) => {
    let command: Record<string, unknown>;
    try {
      command = JSON.parse(raw);
    } catch {
      return reply(ws, { ok: false, error: "malformed command" });
    }
    const kind = String(command.type ?? "");
    if (!account)
      return reply(ws, { ok: false, command: kind, error: "not ready" });
    try {
      if (kind === "place") {
        const result = await client.futuresOrderBuilder().place(
          String(command.root ?? "/MES"),
          {
            accountNumber: account,
            side: (command.side as "BUY" | "SELL") ?? "BUY",
            quantity: Number(command.quantity ?? 1),
            orderType: (command.orderType as never) ?? "LIMIT",
            limitPrice:
              command.limitPrice === undefined
                ? undefined
                : Number(command.limitPrice),
            stopPrice:
              command.stopPrice === undefined
                ? undefined
                : Number(command.stopPrice),
            tif: (command.tif as never) ?? undefined,
          },
          { dryRun: command.dryRun === true },
        );
        console.log(
          `[feed] placed ${command.side} ${command.quantity} ${result.contract.symbol}`,
        );
        void refreshDayHistory();
        return reply(ws, {
          ok: true,
          command: kind,
          contract: result.contract.symbol,
          warnings: result.warnings,
        });
      }
      if (kind === "cancel") {
        const orderId = Number(command.orderId);
        const res = await client.cancelOrder(orderId);
        console.log(`[feed] cancel ${orderId}`);
        void refreshDayHistory();
        return reply(ws, { ok: true, command: kind, result: res.body });
      }
      return reply(ws, { ok: false, command: kind, error: "unknown command" });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.warn(`[feed] ${kind} failed: ${error}`);
      return reply(ws, { ok: false, command: kind, error });
    }
  };

  console.log(`[feed] serving ws://127.0.0.1:${port} — connecting…`);

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
  account =
    session.accountCode ??
    (await client.resolveAccountCode()) ??
    (() => {
      throw new Error("could not resolve an account code");
    })();
  console.log(
    `[feed] ${session.tradingSystem} account ${account} — ready on ws://127.0.0.1:${port}`,
  );
  // Clients that connected during login still have `account: null`.
  for (const ws of clients) sendSnapshot(ws);

  console.log(
    `[feed] serving ws://127.0.0.1:${port} — ${session.tradingSystem} account ${account}`,
  );

  /**
   * Day history is a request/response service, so it is re-fetched rather than
   * streamed: once at startup and again whenever the live order stream shows
   * something changed.
   */
  const refreshDayHistory = async () => {
    if (!account) return;
    try {
      const [orders, trades] = await Promise.all([
        client.orderHistory(account),
        client.tradeHistory(account),
      ]);
      latestDayOrders = orders;
      latestDayTrades = trades;
      broadcast({ type: "dayOrders", orders, at: Date.now() });
      broadcast({ type: "dayTrades", trades, at: Date.now() });
      console.log(
        `[feed] day history: ${orders.length} order(s), ${trades.length} execution(s)`,
      );
    } catch (e) {
      console.warn("[feed] day history refresh failed:", String(e));
    }
  };

  await refreshDayHistory();

  void (async () => {
    for await (const ev of client.statement(account)) {
      const values = (ev.body as { values?: Record<string, number> }).values;
      if (!values) continue;
      latestAccountValues = values;
      broadcast({ type: "account", values, at: Date.now() });
    }
  })();

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
      // The live stream is the trigger; the gateway's own history is the truth.
      void refreshDayHistory();
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
