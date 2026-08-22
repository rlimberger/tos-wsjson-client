/**
 * Futures order scaffold against the thinkorswim PaperMoney gateway.
 *
 *   yarn build
 *   node --env-file=.env dist/example/futuresPaperOrder.js            # CONFIRM only (dry run)
 *   node --env-file=.env dist/example/futuresPaperOrder.js --submit   # actually SUBMIT (paper)
 *   node --env-file=.env dist/example/futuresPaperOrder.js --login    # force a fresh browser login
 *
 * On first run (or --login) a Chrome window opens: log in normally; the script
 * captures the gateway URL, token and account from the SPA's own traffic and
 * saves them to .env (TOS_GATEWAY_URL, TOS_ACCESS_TOKEN, TOS_REFRESH_TOKEN,
 * TOS_ACCOUNT_CODE, TOS_TRADING_SYSTEM). Later runs reuse .env until the token
 * expires (~24h), then fall back to the browser again.
 *
 * Order knobs: FUT_ROOT=/MES FUT_SIDE=BUY FUT_QTY=1 FUT_TYPE=LIMIT|MARKET|STOP|STOPLIMIT
 *              FUT_LIMIT=<price> FUT_STOP=<price> FUT_TIF=DAY|GTC
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
const forceLogin = argv.includes("--login");
const wanted = (env.TOS_TRADING_SYSTEM as TradingSystem) ?? "PaperMoney";

async function connect(session: BrowserSession): Promise<RealWsJsonClient> {
  const client = await RealWsJsonClient.create({
    tradingSystem: session.tradingSystem,
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
  if (cached && cached.tradingSystem === wanted) {
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
  if (wanted === "LiveTrading" && submit) {
    throw new Error(
      "refusing to --submit against LiveTrading from the scaffold",
    );
  }
  const { client, session } = await getClient();
  const accountNumber =
    session.accountCode ??
    String((await client.userProperties()).body.defaultAccountCode);
  console.log(
    `connected: ${session.tradingSystem} ${session.gatewayUrl} account ${accountNumber}`,
  );

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

  const result = await client.placeFuturesOrder(
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
  console.log("CONFIRM:", JSON.stringify(result.confirmation, null, 2));
  if (result.submission) {
    console.log("SUBMIT:", JSON.stringify(result.submission, null, 2));
  } else {
    console.log("dry run — re-run with --submit to send to PaperMoney");
  }
  client.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
