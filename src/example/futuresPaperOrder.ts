/**
 * Futures order scaffold against the thinkorswim PaperMoney gateway.
 *
 *   node --env-file=.env dist/example/futuresPaperOrder.js
 *       CONFIRM only (default dry run — no SUBMIT)
 *   node --env-file=.env dist/example/futuresPaperOrder.js --submit
 *       CONFIRM then SUBMIT on PaperMoney
 *   ... --submit --market
 *       required extra flag for MARKET submits (they can fill immediately)
 *
 * Env: TOS_ACCESS_TOKEN + TOS_REFRESH_TOKEN (from a prior login/schwab), or
 *      TOS_AUTH_CODE (single-use code from the trade.thinkorswim.com oauth
 *      redirect — complete login/MFA in your own browser).
 * Optional: TOS_TRADING_SYSTEM=PaperMoney|LiveTrading (default PaperMoney),
 *           FUT_ROOT=/MES FUT_SIDE=BUY FUT_QTY=1 FUT_TYPE=LIMIT|MARKET
 *           FUT_LIMIT=<price> FUT_TIF=DAY TOS_ACCOUNT=<accountCode>
 *
 * LiveTrading --submit is refused. Do not pass username/password here.
 */
import { RealWsJsonClient } from "../client/realWsJsonClient.js";
import { OrderType, Tif } from "../client/services/orderTypes.js";
import { TradingSystem } from "../client/tosWebConfig.js";

const env = process.env;
const argv = process.argv.slice(2);
const submit = argv.includes("--submit");
const allowMarket = argv.includes("--market");
const verbose = argv.includes("--verbose");
const tradingSystem = (env.TOS_TRADING_SYSTEM as TradingSystem) ?? "PaperMoney";

function summarizeConfirmation(body: Record<string, unknown>) {
  const orders = (body.orders as { orderId?: number; tifs?: { values: string[]; selection: number }; types?: { values: string[]; selection: number }; priceStep?: number; quantityStep?: number; minQty?: number; maxQty?: number; bidPrice?: number; askPrice?: number; midPrice?: number; error?: string; legs?: { symbol: string }[] }[]) ?? [];
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
    errors: [body.message, body.error, body.validationError, first?.error].filter(
      Boolean,
    ),
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

async function main() {
  if (tradingSystem === "LiveTrading") {
    throw new Error(
      "this scaffold refuses LiveTrading. Unset TOS_TRADING_SYSTEM or set it to PaperMoney.",
    );
  }
  const client = await RealWsJsonClient.create({ tradingSystem });
  if (env.TOS_ACCESS_TOKEN && env.TOS_REFRESH_TOKEN) {
    await client.authenticateWithAccessToken({
      accessToken: env.TOS_ACCESS_TOKEN,
      refreshToken: env.TOS_REFRESH_TOKEN,
    });
  } else if (env.TOS_AUTH_CODE) {
    await client.authenticateWithAuthCode(env.TOS_AUTH_CODE);
    console.log("authenticated via auth code (token not printed)");
  } else {
    throw new Error("set TOS_ACCESS_TOKEN+TOS_REFRESH_TOKEN or TOS_AUTH_CODE");
  }

  const props = await client.userProperties();
  const accountNumber = env.TOS_ACCOUNT || String(props.body.defaultAccountCode);
  console.log("account:", accountNumber, "tradingSystem:", tradingSystem);

  const events = client.orderEvents(accountNumber);
  void (async () => {
    for await (const ev of events) {
      const orders = (ev.body.orders as { orderId?: number; status?: string; eventType?: string }[]) ?? [];
      for (const o of orders) {
        console.log("order-event", {
          orderId: o.orderId,
          status: o.status,
          eventType: o.eventType,
        });
      }
    }
  })();

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
  } else {
    console.log("dry run — re-run with --submit to send to PaperMoney");
  }
  client.disconnect();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
