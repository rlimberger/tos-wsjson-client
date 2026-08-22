import { rebuildWorkingOrders } from "../../client/orders/workingOrderBook";
import { RawOrderEvent } from "../../client/services/orderEventsMessageHandler";

function ev(partial: Partial<RawOrderEvent>): Partial<RawOrderEvent> {
  return {
    orderId: 1,
    side: "BUY",
    quantity: 1,
    filledQuantity: 0,
    orderType: "LIMIT",
    limitPrice: 1,
    tif: "DAY",
    compositeSymbol: "/MESU26:XCME",
    cancelable: true,
    ...partial,
  };
}

describe("workingOrderBook", () => {
  it("keeps WORKING/QUEUED orders", () => {
    const book = rebuildWorkingOrders([
      ev({ orderId: 11, eventType: "WORKING", status: "WORKING" }),
      ev({
        orderId: 12,
        eventType: "QUEUED",
        status: "QUEUED",
        side: "SELL",
        quantity: 2,
      }),
    ]);
    expect(book.map((o) => o.orderId)).toEqual([11, 12]);
    expect(book[1].side).toBe("SELL");
    expect(book[1].remaining).toBe(2);
  });

  it("drops an order when a later CANCELED event arrives", () => {
    const book = rebuildWorkingOrders([
      ev({ eventType: "WORKING", status: "WORKING" }),
      ev({ eventType: "CANCELED", status: "CANCELED", cancelable: false }),
    ]);
    expect(book).toEqual([]);
  });

  it("drops an order on FILLED or FINAL", () => {
    expect(
      rebuildWorkingOrders([
        ev({ eventType: "WORKING", status: "WORKING" }),
        ev({ eventType: "FILLED", status: "FILLED", filledQuantity: 1 }),
      ]),
    ).toEqual([]);
    expect(
      rebuildWorkingOrders([
        ev({ orderId: 9, eventType: "WORKING", status: "WORKING" }),
        ev({ orderId: 9, eventType: "FINAL", status: "EXPIRED" }),
      ]),
    ).toEqual([]);
  });

  it("keeps a partial fill and removes a complete one", () => {
    const partial = rebuildWorkingOrders([
      ev({ eventType: "WORKING", status: "WORKING", quantity: 2 }),
      ev({
        eventType: "EXECUTION",
        status: "WORKING",
        quantity: 2,
        filledQuantity: 1,
      }),
    ]);
    expect(partial).toHaveLength(1);
    expect(partial[0].filledQuantity).toBe(1);
    expect(partial[0].remaining).toBe(1);

    const full = rebuildWorkingOrders([
      ev({ eventType: "WORKING", status: "WORKING", quantity: 1 }),
      ev({
        eventType: "EXECUTION",
        status: "WORKING",
        quantity: 1,
        filledQuantity: 1,
      }),
    ]);
    expect(full).toEqual([]);
  });

  it("uses the contract symbol from legs when composite is missing", () => {
    const [order] = rebuildWorkingOrders([
      ev({
        compositeSymbol: undefined,
        legs: [
          {
            symbol: "/ESU26",
            positionEffect: "",
            quantity: 1,
            instrumentType: "FUTURE",
          },
        ],
        eventType: "WORKING",
        status: "WORKING",
      }),
    ]);
    expect(order.symbol).toBe("/ESU26");
  });
});
