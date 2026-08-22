/**
 * Futures order scaffold against the thinkorswim PaperMoney gateway.
 *
 *   yarn build
 *   node --env-file=.env dist/example/futuresPaperOrder.js            # CONFIRM only
 *   node --env-file=.env dist/example/futuresPaperOrder.js --submit   # SUBMIT (paper)
 *   node --env-file=.env dist/example/futuresPaperOrder.js --login    # fresh browser login
 *   ... --submit --market                                             # extra flag for MARKET
 *
 * On first run (or --login) a Chrome window opens: log in yourself (password,
 * MFA). The script only watches the SPA's WebSocket; it does not type
 * credentials. Captured values are written to .env:
 * TOS_GATEWAY_URL, TOS_ACCESS_TOKEN, TOS_REFRESH_TOKEN, TOS_ACCOUNT_CODE,
 * TOS_TRADING_SYSTEM. Later runs reuse .env until the token expires.
 *
 * Order knobs: FUT_ROOT=/MES FUT_SIDE=BUY FUT_QTY=1 FUT_TYPE=LIMIT|MARKET|STOP|STOPLIMIT
 *              FUT_LIMIT=<price> FUT_STOP=<price> FUT_TIF=DAY|GTC
 *
 * This CLI refuses LiveTrading. CONFIRM is the default; SUBMIT needs --submit.
 */
import { RealWsJsonClient } from "../client/realWsJsonClient.js";
import { OrderType, Tif } from "../client/services/orderTypes.js";
import { TradingSystem } from "../client/tosWebConfig.js";
import {
  BrowserSession,
  captureBrowserSession,
  saveSessionToDotEnv,
  sessionFromEnv,
} from "./browserSession.js";

const env = process.env;
const argv = process.argv.slice(2);
const submit = argv.includes("--submit");
const allowMarket = argv.includes("--market");
const verbose = argv.includes("--verbose");
const forceLogin = argv.includes("--login");
const wanted = (env.TOS_TRADING_SYSTEM as TradingSystem) ?? "PaperMoney";

function summarizeConfirmation(body: Record<string, unknown>) {
  const orders =
    (body.orders as {
      orderId?: number;
      tifs?: { values: string[]; selection: number };
      types?: { values: string[]; selection: number };
      priceStep?: number;
      quantityStep?: number;
      minQty?: number;
      maxQty?: number;
      bidPrice?: number;
      askPrice?: number;
      midPrice?: number;
      error?: string;
      legs?: { symbol: string }[];
    }[]) ?? [];
  const confirmation = body.confirmation as
    | {
        cost?: number;
        commission?: number;
        fee?: number;
        warnings?: { message: string }[];
      }
    | undefined;
  const first = orders[0];
  return {
    errors: [
      body.message,
      body.error,
      body.validationError,
      first?.error,
    ].filter(Boolean),
    warnings: confirmation?.warnings?.map((w) => w.message) ?? [],
    orderId: first?.orderId,
    contract: first?.legs?.[0]?.symbol,
    tif: first?.tifs?.values[first.tifs.selection],
    type: first?.types?.values[first.types.selection],
    priceStep: first?.priceStep,
    quantityStep: first?.quantityStep,
    minQty: first?.minQty,
    maxQty: first?.maxQty,
    bid: first?.bidPrice,
    ask: first?.askPrice,
    mid: first?.midPrice,
    cost: confirmation?.cost,
    commission: confirmation?.commission,
    fee: confirmation?.fee,
  };
}

async function connect(session: BrowserSession): Promise<RealWsJsonClient> {
  if (session.tradingSystem !== "PaperMoney") {
    throw new Error(
      "this scaffold only talks to PaperMoney. Recapture with TOS_TRADING_SYSTEM=PaperMoney.",
    );
  }
  const client = await RealWsJsonClient.create({
    tradingSystem: "PaperMoney",
    gatewayUrl: session.gatewayUrl,
  });
  await client.authenticateWithAccessToken({
    accessToken: session.accessToken,
    refreshToken: session.refreshToken ?? "n/a",
  });
  return client;
}

async function getClient(): Promise<{
  client: RealWsJsonClient;
  session: BrowserSession;
}> {
  const cached = forceLogin ? undefined : sessionFromEnv();
  if (cached) {
    try {
      return { client: await connect(cached), session: cached };
    } catch (e) {
      console.warn(`cached session rejected (${String(e)}); opening browser`);
    }
  }
  const session = await captureBrowserSession({ tradingSystem: wanted });
  saveSessionToDotEnv(session);
  return { client: await connect(session), session };
}

async function main() {
  if (wanted === "LiveTrading") {
    throw new Error(
      "this scaffold refuses LiveTrading. Unset TOS_TRADING_SYSTEM or set it to PaperMoney.",
    );
  }
  const { client, session } = await getClient();
  const accountNumber =
    env.TOS_ACCOUNT ||
    env.TOS_ACCOUNT_CODE ||
    session.accountCode ||
    (await client.resolveAccountCode());
  if (!accountNumber) {
    const accts = await client.accounts();
    console.error(
      "could not resolve an account code for this session; `accounts` returned:",
      JSON.stringify(accts, null, 2),
    );
    throw new Error(
      "no account code — set TOS_ACCOUNT=<paper account> and re-run",
    );
  }
  console.log(
    `connected: ${session.tradingSystem} ${session.gatewayUrl} account ${accountNumber}`,
  );

  if (env.TOS_CANCEL) {
    const orderId = Number(env.TOS_CANCEL);
    const res = await client.cancelOrder(orderId);
    console.log("CANCEL:", JSON.stringify(res.body, null, 2));
    client.disconnect();
    return;
  }

  type LiveOrder = {
    orderId?: number;
    status?: string;
    eventType?: string;
    side?: string;
    quantity?: number;
    price?: number;
    tif?: string;
    legs?: { symbol?: string }[];
    descriptionToShare?: string;
  };
  const seenOrders: LiveOrder[] = [];
  const events = client.orderEvents(accountNumber);
  void (async () => {
    for await (const ev of events) {
      for (const o of (ev.body.orders as LiveOrder[]) ?? []) {
        seenOrders.push(o);
        if (verbose) {
          console.log("order-event", {
            orderId: o.orderId,
            status: o.status,
            eventType: o.eventType,
          });
        }
      }
    }
  })();

  /** The submit response echoes the draft (orderId 0); the real id arrives via order_events. */
  const awaitPlacedOrder = async (
    contract: string,
    timeoutMs = 10_000,
  ): Promise<LiveOrder | undefined> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const match = seenOrders.find(
        (o) =>
          o.orderId &&
          (o.legs?.[0]?.symbol === contract ||
            o.descriptionToShare?.includes(contract)),
      );
      if (match || Date.now() > deadline) return match;
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  const root = env.FUT_ROOT ?? "/MES";
  const series = await client.futureSeries(root);
  console.table(
    series.map(({ symbol, displaySymbol, daysToExpiration, isActive }) => ({
      symbol,
      displaySymbol,
      daysToExpiration,
      isActive,
    })),
  );

  const orderType = (env.FUT_TYPE as OrderType) ?? "LIMIT";
  const limitPrice = env.FUT_LIMIT ? Number(env.FUT_LIMIT) : undefined;
  const stopPrice = env.FUT_STOP ? Number(env.FUT_STOP) : undefined;
  if (orderType === "LIMIT" && limitPrice === undefined) {
    throw new Error(
      "FUT_LIMIT is required for LIMIT orders (pick a price far from the market for a safe paper test)",
    );
  }
  if (orderType === "MARKET" && submit && !allowMarket) {
    throw new Error("MARKET submit requires --market in addition to --submit");
  }

  const result = await client.futuresOrderBuilder().place(
    root,
    {
      accountNumber,
      side: (env.FUT_SIDE as "BUY" | "SELL") ?? "BUY",
      quantity: Number(env.FUT_QTY ?? 1),
      orderType,
      limitPrice,
      stopPrice,
      tif: env.FUT_TIF as Tif | undefined,
    },
    { dryRun: !submit },
  );

  console.log("contract:", result.contract.symbol);
  console.log(
    "CONFIRM:",
    JSON.stringify(
      summarizeConfirmation(
        result.confirmation as unknown as Record<string, unknown>,
      ),
      null,
      2,
    ),
  );
  if (verbose) {
    console.log("CONFIRM raw keys:", Object.keys(result.confirmation));
  }
  if (result.warnings.length) {
    console.log("warnings:", result.warnings);
  }
  if (result.submission) {
    console.log(
      "SUBMIT:",
      JSON.stringify(
        summarizeConfirmation(
          result.submission as unknown as Record<string, unknown>,
        ),
        null,
        2,
      ),
    );
    const placed = await awaitPlacedOrder(result.contract.symbol);
    if (placed) {
      console.log("PLACED:", {
        orderId: placed.orderId,
        status: placed.status,
        order: placed.descriptionToShare,
      });
      console.log(
        `cancel it with: TOS_CANCEL=${placed.orderId} node --env-file=.env dist/example/futuresPaperOrder.js`,
      );
    } else {
      console.log(
        "submitted, but no matching order_events entry within 10s — check the web UI",
      );
    }
  } else {
    console.log("dry run — re-run with --submit to send to PaperMoney");
  }
  client.disconnect();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
