import {
  parseTradingSystem,
  sessionFromEnv,
} from "../../example/browserSession";

describe("browserSession env round-trip", () => {
  it("reads a captured session from env", () => {
    const s = sessionFromEnv({
      TOS_GATEWAY_URL: "wss://papermoney-services.schwab.com/Services/WsJson",
      TOS_ACCESS_TOKEN: "tok",
      TOS_ACCOUNT_CODE: "123",
    } as NodeJS.ProcessEnv);
    expect(s).toMatchObject({
      tradingSystem: "PaperMoney",
      accountCode: "123",
    });
    expect(sessionFromEnv({} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("parses SPA trading-system storage values", () => {
    expect(parseTradingSystem("PaperMoney")).toBe("PaperMoney");
    expect(parseTradingSystem("traderx::papermoney")).toBe("PaperMoney");
    expect(parseTradingSystem("LiveTrading")).toBe("LiveTrading");
    expect(parseTradingSystem("traderx::live")).toBe("LiveTrading");
    expect(parseTradingSystem(undefined)).toBeUndefined();
  });
});
