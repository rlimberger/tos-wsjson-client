import {
  ConfirmedFuturesDraft,
  FuturesOrderBuilder,
  FuturesOrderTransport,
} from "../../client/futures/futuresOrderBuilder";
import { RawDraftOrderResponse } from "../../client/services/draftOrderMessageHandlers";
import { RawFutureSeriesItem } from "../../client/services/futureSeriesMessageHandler";
import { OrderSpec } from "../../client/services/orderTypes";
import { LiveTradingDisabledError } from "../../client/tosWebConfig";

const mes: RawFutureSeriesItem = {
  symbol: "/MESU26",
  displaySymbol: "/MESU26",
  daysToExpiration: 25,
  lastTradeDate: 0,
  isActive: true,
  expiration: "2026-09-18",
};

function okConfirm(
  overrides: Partial<RawDraftOrderResponse> = {},
): RawDraftOrderResponse {
  return {
    orders: [
      {
        orderId: 42,
        tifs: { values: ["DAY", "GTC"], selection: 0 },
        types: { values: ["LIMIT", "MARKET"], selection: 0 },
        priceStep: 0.25,
        quantityStep: 1,
        legs: [{ symbol: "/MESU26" }],
        bidPrice: 6500,
        askPrice: 6500.25,
        midPrice: 6500.125,
      },
    ],
    confirmation: {
      rows: [],
      cost: 100,
      commission: 2.25,
      fee: 1.5,
      warnings: [],
    },
    ...overrides,
  };
}

function transport(
  overrides: Partial<FuturesOrderTransport> = {},
): FuturesOrderTransport & {
  submits: number;
  lastSubmit?: Parameters<FuturesOrderTransport["submitDraftOrder"]>[0];
  lastConfirm?: Parameters<FuturesOrderTransport["confirmOrder"]>[0];
} {
  const t = {
    submits: 0,
    lastSubmit: undefined as
      | Parameters<FuturesOrderTransport["submitDraftOrder"]>[0]
      | undefined,
    lastConfirm: undefined as
      | Parameters<FuturesOrderTransport["confirmOrder"]>[0]
      | undefined,
    async futureSeries() {
      return [
        { ...mes, symbol: "/MESM26", isActive: false, daysToExpiration: -1 },
        mes,
      ];
    },
    async confirmOrder(
      request: Parameters<FuturesOrderTransport["confirmOrder"]>[0],
    ) {
      t.lastConfirm = request;
      return okConfirm();
    },
    async submitDraftOrder(
      request: Parameters<FuturesOrderTransport["submitDraftOrder"]>[0],
    ) {
      t.submits += 1;
      t.lastSubmit = request;
      return { orders: [{ orderId: 42 }] };
    },
    ...overrides,
  };
  return t;
}

const intent = {
  accountNumber: "12345678",
  side: "BUY" as const,
  quantity: 1,
  orderType: "LIMIT" as const,
  limitPrice: 1,
};

describe("FuturesOrderBuilder", () => {
  it("resolves the active contract and CONFIRMs INIT_STOCK with that symbol", async () => {
    const t = transport();
    const builder = new FuturesOrderBuilder(t);
    const draft = await builder.confirm("/mes", intent);
    expect(draft.contract.symbol).toBe("/MESU26");
    expect(t.lastConfirm?.spec.draftKey).toBe("/MES");
    expect(t.lastConfirm?.spec.legs).toEqual([
      { symbol: "/MESU26", quantity: 1, side: "BUY" },
    ]);
    expect(t.submits).toBe(0);
  });

  it("dry-run place() never SUBMITs", async () => {
    const t = transport();
    const result = await new FuturesOrderBuilder(t).place("/MES", intent);
    expect(result.submission).toBeUndefined();
    expect(t.submits).toBe(0);
    expect(result.contract.symbol).toBe("/MESU26");
  });

  it("submit() overlays server TIF and requires a ConfirmedFuturesDraft", async () => {
    const t = transport();
    const builder = new FuturesOrderBuilder(t);
    const draft = await builder.confirm("/MES", intent);
    await builder.submit(draft);
    expect(t.submits).toBe(1);
    expect(t.lastSubmit?.refOrderId).toBe(42);
    expect(t.lastSubmit?.spec.tif).toBe("DAY");
    expect(t.lastSubmit?.spec.legs[0].symbol).toBe("/MESU26");
    await expect(builder.submit({} as ConfirmedFuturesDraft)).rejects.toThrow(
      /ConfirmedFuturesDraft/,
    );
  });

  it("refuses empty CONFIRM and error frames", async () => {
    const empty = transport({
      confirmOrder: async () => ({ orders: [] }),
    });
    await expect(
      new FuturesOrderBuilder(empty).confirm("/MES", intent),
    ).rejects.toThrow(/no orders/);

    const errored = transport({
      confirmOrder: async () => ({
        message: "Account not approved for futures",
      }),
    });
    await expect(
      new FuturesOrderBuilder(errored).confirm("/MES", intent),
    ).rejects.toThrow(/Account not approved/);
  });

  it("requires a positive integer contract quantity", async () => {
    const t = transport();
    const builder = new FuturesOrderBuilder(t);
    await expect(
      builder.confirm("/MES", { ...intent, quantity: 1.5 }),
    ).rejects.toThrow(/positive integer/);
    await expect(
      builder.confirm("/MES", { ...intent, quantity: 0 }),
    ).rejects.toThrow(/positive integer/);
  });

  it("gates LiveTrading construction", () => {
    const t = transport();
    expect(
      () => new FuturesOrderBuilder(t, { tradingSystem: "LiveTrading" }),
    ).toThrow(LiveTradingDisabledError);
    expect(
      () =>
        new FuturesOrderBuilder(t, {
          tradingSystem: "LiveTrading",
          allowLiveTrading: true,
        }),
    ).not.toThrow();
  });

  it("cannot be forged from a raw confirmation object", () => {
    const spec: OrderSpec = {
      accountNumber: "1",
      orderType: "LIMIT",
      limitPrice: 1,
      legs: [{ symbol: "/MESU26", quantity: 1, side: "BUY" }],
    };
    expect(() =>
      ConfirmedFuturesDraft.fromSuccessful(mes, { orders: [] }, spec),
    ).toThrow(/no orders/);
  });
});
