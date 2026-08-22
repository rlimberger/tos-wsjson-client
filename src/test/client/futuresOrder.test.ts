import {
  ConfirmOrderMessageHandler,
  draftProblems,
  SubmitDraftOrderMessageHandler,
} from "../../client/services/draftOrderMessageHandlers";
import FutureSeriesMessageHandler, {
  activeContract,
} from "../../client/services/futureSeriesMessageHandler";
import { OrderSpec, validateOrderSpec } from "../../client/services/orderTypes";
import {
  assertTradingSystemAllowed,
  LiveTradingDisabledError,
  resolveGatewayUrl,
} from "../../client/tosWebConfig";
import { ORDER_EVENT_TYPES } from "../../client/services/orderEventsMessageHandler";
import OrderEventsMessageHandler from "../../client/services/orderEventsMessageHandler";
import GenericIncomingMessageHandler from "../../client/services/genericIncomingMessageHandler";

const account = "12345678";
const mesLimit: OrderSpec = {
  accountNumber: account,
  orderType: "LIMIT",
  limitPrice: 6400.25,
  draftKey: "/MES",
  legs: [{ symbol: "/MESU26", quantity: 1, side: "BUY" }],
};

describe("futures order builders", () => {
  it("builds the CONFIRM message the ToS Web SPA sends for a futures limit order", () => {
    const req = new ConfirmOrderMessageHandler().buildRequest({
      spec: mesLimit,
    });
    expect(req).toEqual({
      payload: [
        {
          header: {
            id: "update-draft-order-/MES",
            service: "place_order",
            ver: 0,
          },
          params: {
            accountCode: account,
            action: "CONFIRM",
            marker: "SINGLE",
            orders: [
              {
                requestType: "INIT_STOCK",
                orderType: "LIMIT",
                limitPrice: 6400.25,
                legs: [{ symbol: "/MESU26", quantity: 1 }],
              },
            ],
          },
        },
      ],
    });
  });

  it("builds a SUBMIT with EDIT_ORDER, refOrderId, tag and signed sell quantity", () => {
    const req = new SubmitDraftOrderMessageHandler().buildRequest({
      spec: {
        ...mesLimit,
        orderType: "MARKET",
        limitPrice: undefined,
        legs: [{ symbol: "/MESU26", quantity: 2, side: "SELL" }],
      },
      refOrderId: 987,
    });
    expect(req.payload[0].params).toEqual({
      accountCode: account,
      action: "SUBMIT",
      marker: "SINGLE",
      orders: [
        {
          requestType: "EDIT_ORDER",
          refOrderId: 987,
          tif: "DAY",
          orderType: "MARKET",
          legs: [{ symbol: "/MESU26", quantity: -2 }],
          tag: "TOSWeb",
        },
      ],
    });
  });

  it("maps STOP and STOPLIMIT prices like the SPA serializer", () => {
    const stop = new ConfirmOrderMessageHandler().buildRequest({
      spec: { ...mesLimit, orderType: "STOP", limitPrice: 1, stopPrice: 6300 },
    }).payload[0].params.orders[0];
    expect(stop).toMatchObject({ orderType: "STOP", stopPrice: 6300 });
    expect(stop).not.toHaveProperty("limitPrice");
    const stopLimit = new ConfirmOrderMessageHandler().buildRequest({
      spec: {
        ...mesLimit,
        orderType: "STOPLIMIT",
        limitPrice: 6299,
        stopPrice: 6300,
      },
    }).payload[0].params.orders[0];
    expect(stopLimit).toMatchObject({
      orderType: "STOPLIMIT",
      limitPrice: 6299,
      stopPrice: 6300,
    });
  });

  it("rejects a futures root used as a leg symbol", () => {
    expect(() =>
      validateOrderSpec({
        ...mesLimit,
        legs: [{ symbol: "/MES", quantity: 1, side: "BUY" }],
      }),
    ).toThrow(/ROOT/);
    expect(() =>
      validateOrderSpec({
        ...mesLimit,
        legs: [{ symbol: "/6E:XCME", quantity: 1, side: "BUY" }],
      }),
    ).toThrow(/ROOT/);
    expect(() => validateOrderSpec(mesLimit)).not.toThrow();
    expect(() =>
      validateOrderSpec({
        ...mesLimit,
        legs: [{ symbol: "AAPL", quantity: 1, side: "BUY" }],
      }),
    ).not.toThrow();
  });

  it("builds future_series requests and picks the active contract", () => {
    const handler = new FutureSeriesMessageHandler();
    const req = { root: "/MES", requestId: "futureSeries-1" };
    expect(handler.buildRequest(req)).toEqual({
      payload: [
        {
          header: { service: "future_series", id: "futureSeries-1", ver: 0 },
          params: { symbol: "/MES" },
        },
      ],
    });
    expect(handler.requestId(req)).toBe("futureSeries-1");
    const series = [
      {
        symbol: "/MESM26",
        displaySymbol: "/MESM26",
        daysToExpiration: -1,
        lastTradeDate: 0,
        isActive: false,
        expiration: "",
      },
      {
        symbol: "/MESU26",
        displaySymbol: "/MESU26",
        daysToExpiration: 25,
        lastTradeDate: 0,
        isActive: true,
        expiration: "",
      },
    ];
    expect(activeContract(series)?.symbol).toBe("/MESU26");
  });

  it("surfaces error frames and draft problems", () => {
    const parsed = new GenericIncomingMessageHandler().parseResponse({
      payload: [
        {
          header: {
            service: "place_order",
            id: "update-draft-order-/MES",
            ver: 0,
            type: "error",
          },
          body: { message: "Account not approved for futures" },
        },
      ],
    });
    expect(parsed[0]).toMatchObject({
      type: "error",
      id: "update-draft-order-/MES",
    });
    expect(draftProblems(parsed[0].body)).toEqual([
      "Account not approved for futures",
    ]);
    expect(
      draftProblems({ orders: [{ error: "bad price" }], validationError: "x" }),
    ).toEqual(["x", "bad price"]);
  });

  it("omits limitPrice on MARKET CONFIRM and SUBMIT", () => {
    const market = { ...mesLimit, orderType: "MARKET" as const, limitPrice: undefined };
    const confirm = new ConfirmOrderMessageHandler().buildRequest({
      spec: market,
    }).payload[0].params.orders[0];
    expect(confirm).toEqual({
      requestType: "INIT_STOCK",
      orderType: "MARKET",
      legs: [{ symbol: "/MESU26", quantity: 1 }],
    });
    const submit = new SubmitDraftOrderMessageHandler().buildRequest({
      spec: market,
    }).payload[0].params.orders[0];
    expect(submit).not.toHaveProperty("limitPrice");
    expect(submit.orderType).toBe("MARKET");
    expect(submit.tag).toBe("TOSWeb");
    expect(submit.tif).toBe("DAY");
  });

  it("treats an empty orders list as a draft problem", () => {
    expect(draftProblems({ orders: [] })).toEqual([
      "CONFIRM returned no orders",
    ]);
  });

  it("selects the paper-money gateway", () => {
    const urls = {
      livetradingA: "wss://a",
      livetradingB: "wss://b",
      papermoney: "wss://p",
    };
    expect(resolveGatewayUrl("PaperMoney", urls)).toBe("wss://p");
    expect(resolveGatewayUrl("LiveTrading", urls)).toBe("wss://a");
    expect(resolveGatewayUrl("LiveTrading", urls, { useInstanceB: true })).toBe(
      "wss://b",
    );
  });

  it("gates LiveTrading unless explicitly allowed", () => {
    expect(() => assertTradingSystemAllowed("LiveTrading")).toThrow(
      LiveTradingDisabledError,
    );
    expect(() =>
      assertTradingSystemAllowed("LiveTrading", true),
    ).not.toThrow();
    expect(() => assertTradingSystemAllowed("PaperMoney")).not.toThrow();
  });

  it("subscribes to the six-type order_events feed", () => {
    expect(
      new OrderEventsMessageHandler().buildRequest("12345678"),
    ).toEqual({
      payload: [
        {
          header: { service: "order_events", id: "order_events", ver: 0 },
          params: {
            account: "12345678",
            types: [...ORDER_EVENT_TYPES],
          },
        },
      ],
    });
  });
});
