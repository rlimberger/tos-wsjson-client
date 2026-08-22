/**
 * Futures order scaffold against the thinkorswim PaperMoney gateway.
 *
 *   node --env-file=.env dist/example/futuresPaperOrder.js            # CONFIRM only (dry run)
 *   node --env-file=.env dist/example/futuresPaperOrder.js --submit   # actually SUBMIT (paper)
 *
 * Env: TOS_ACCESS_TOKEN + TOS_REFRESH_TOKEN (from a prior login/schwab), or
 *      TOS_AUTH_CODE (single-use code from the trade.thinkorswim.com oauth redirect).
 * Optional: TOS_TRADING_SYSTEM=PaperMoney|LiveTrading (default PaperMoney),
 *           FUT_ROOT=/MES FUT_SIDE=BUY FUT_QTY=1 FUT_TYPE=LIMIT|MARKET FUT_LIMIT=<price>
 *
 * NOTE: the paper gateway may require a token issued against it (the SPA
 * re-runs the LMS authCode flow when switching trading systems). If login
 * fails with a token from live, obtain a fresh authCode while the web UI is in
 * paperMoney mode and use TOS_AUTH_CODE.
 */
import { RealWsJsonClient } from "../client/realWsJsonClient.js";
import { OrderType, Tif } from "../client/services/orderTypes.js";
import { TradingSystem } from "../client/tosWebConfig.js";

const env = process.env;
const submit = process.argv.includes("--submit");
const tradingSystem = (env.TOS_TRADING_SYSTEM as TradingSystem) ?? "PaperMoney";

async function main() {
  if (tradingSystem === "LiveTrading" && submit) {
    throw new Error(
      "refusing to --submit against LiveTrading from the scaffold",
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
    console.log(
      "token:",
      client.accessToken,
      "\nrefreshToken:",
      client.refreshToken,
    );
  } else {
    throw new Error("set TOS_ACCESS_TOKEN+TOS_REFRESH_TOKEN or TOS_AUTH_CODE");
  }

  const props = await client.userProperties();
  const accountNumber = String(props.body.defaultAccountCode);
  console.log("account:", accountNumber, "tradingSystem:", tradingSystem);

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

  const result = await client.placeFuturesOrder(
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
