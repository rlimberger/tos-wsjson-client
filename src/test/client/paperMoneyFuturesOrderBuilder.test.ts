import {
  PaperMoneyFuturesOrderBuilder,
  PaperMoneyFuturesLimitOrder,
} from "../../client/orders/paperMoneyFuturesOrderBuilder";

const order: PaperMoneyFuturesLimitOrder = {
  accountNumber: "123456789",
  rootSymbol: "/ES",
  contractSymbol: "/ESU26",
  side: "BUY",
  quantity: 2,
  limitPrice: 6500.25,
};

describe("PaperMoneyFuturesOrderBuilder", () => {
  it("builds the paperMoney futures confirmation payload", () => {
    const request = new PaperMoneyFuturesOrderBuilder(
      order,
    ).buildConfirmationRequest();

    expect(request).toEqual({
      payload: [
        {
          header: {
            id: "update-draft-order-/ES",
            service: "place_order",
            ver: 1,
          },
          params: {
            accountCode: "123456789",
            action: "CONFIRM",
            marker: "SINGLE",
            orders: [
              {
                requestType: "INIT_STOCK",
                orderType: "LIMIT",
                limitPrice: 6500.25,
                legs: [{ symbol: "/ESU26", quantity: 2 }],
              },
            ],
          },
        },
      ],
    });
  });

  it("builds the submission from the confirmed draft order", () => {
    const request = new PaperMoneyFuturesOrderBuilder({
      ...order,
      side: "SELL",
    }).buildSubmissionRequest(8675309);

    expect(request).toEqual({
      payload: [
        {
          header: {
            id: "update-draft-order-/ES",
            service: "place_order",
            ver: 0,
          },
          params: {
            accountCode: "123456789",
            action: "SUBMIT",
            marker: "SINGLE",
            orders: [
              {
                tif: "DAY",
                orderType: "LIMIT",
                refOrderId: 8675309,
                limitPrice: 6500.25,
                requestType: "EDIT_ORDER",
                legs: [{ symbol: "/ESU26", quantity: -2 }],
                tag: "TOSWeb",
              },
            ],
          },
        },
      ],
    });
  });

  it("requires an exact contract under the futures root", () => {
    expect(
      () =>
        new PaperMoneyFuturesOrderBuilder({
          ...order,
          contractSymbol: "/ES",
        }),
    ).toThrow("exact futures contract symbol");
    expect(
      () =>
        new PaperMoneyFuturesOrderBuilder({
          ...order,
          contractSymbol: "/NQU26",
        }),
    ).toThrow("exact futures contract symbol");
  });

  it("rejects invalid sides, quantities, prices, and draft IDs", () => {
    expect(
      () =>
        new PaperMoneyFuturesOrderBuilder({
          ...order,
          side: "SHORT" as "BUY",
        }),
    ).toThrow('"BUY" or "SELL"');
    expect(
      () => new PaperMoneyFuturesOrderBuilder({ ...order, quantity: 0 }),
    ).toThrow("positive integer");
    expect(
      () =>
        new PaperMoneyFuturesOrderBuilder({
          ...order,
          limitPrice: Number.NaN,
        }),
    ).toThrow("finite number");
    expect(() =>
      new PaperMoneyFuturesOrderBuilder(order).buildSubmissionRequest(0),
    ).toThrow("positive integer");
  });
});
