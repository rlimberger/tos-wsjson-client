import "dotenv/config";
import { getAuthCode } from "./browserOauth.js";
import { RealWsJsonClient } from "../client/realWsJsonClient.js";

async function run(): Promise<void> {
  let client: RealWsJsonClient | undefined;

  try {
    const accessToken = process.env.TOS_ACCESS_TOKEN;
    const refreshToken = process.env.TOS_REFRESH_TOKEN;

    if (accessToken && refreshToken) {
      client = RealWsJsonClient.forPaperMoney();
      await client.authenticateWithAccessToken({ accessToken, refreshToken });
    } else {
      const authCode = await getAuthCode();
      client = RealWsJsonClient.forPaperMoney();
      await client.authenticateWithAuthCode(authCode);
    }

    const preferences = await client.userProperties();
    const accountNumber = preferences.body.defaultAccountCode;
    if (typeof accountNumber !== "string" || accountNumber.length === 0) {
      throw new Error("paperMoney did not return a default account number.");
    }

    const confirmation = await client.confirmPaperMoneyFuturesOrder({
      accountNumber,
      rootSymbol: "/ES",
      contractSymbol: "/ESU26",
      side: "BUY",
      quantity: 1,
      limitPrice: 1,
    });

    const body = confirmation.body;
    const orders = Array.isArray(body.orders) ? body.orders : [];
    console.log(
      JSON.stringify(
        {
          service: confirmation.service,
          confirmationReceived: true,
          draftOrderCount: orders.length,
          hasError: typeof body.error === "string" && body.error.length > 0,
        },
        null,
        2,
      ),
    );
  } finally {
    client?.disconnect();
  }
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`paperMoney smoke test failed: ${message}`);
  process.exitCode = 1;
});
