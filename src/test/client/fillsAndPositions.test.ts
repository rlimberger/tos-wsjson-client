import { FillLog, toFill } from "../../client/orders/fills";
import { positionsFromBody } from "../../client/orders/positionsBook";

// Shapes copied from a live PaperMoney session (2026-08-22).
const execution = {
  eventType: "EXECUTION",
  eventTime: 1787419225702,
  orderId: 5388218566,
  executionId: -15060017249,
  description: "BOT@7687.75 +1 /ESU26:XCME",
  descriptionToShare: "BUY +1 /ESU26:XCME @7687.75 LMT",
  status: "FILLED",
  side: "BOT",
  quantity: 1,
  price: 7687.75,
  avgFillPrice: 7687.75,
  underlyingSymbol: "/ESU26:XCME",
  rootSymbol: "/ES:XCME",
};

describe("fills", () => {
  it("normalizes BOT/SLD executions", () => {
    const fill = toFill(execution)!;
    expect(fill).toMatchObject({
      orderId: 5388218566,
      executionId: -15060017249,
      symbol: "/ESU26:XCME",
      side: "BUY",
      quantity: 1,
      price: 7687.75,
    });
    expect(toFill({ ...execution, side: "SLD" })!.side).toBe("SELL");
  });

  it("ignores non-fill events", () => {
    expect(
      toFill({ ...execution, eventType: "WORKING", status: "WORKING" }),
    ).toBeUndefined();
  });

  it("de-duplicates repeated executions across snapshots", () => {
    const log = new FillLog();
    expect(log.apply([execution])).toHaveLength(1);
    expect(log.apply([execution])).toHaveLength(1);
    const second = {
      ...execution,
      executionId: -15060017250,
      eventTime: execution.eventTime + 10,
    };
    const fills = log.apply([second]);
    expect(fills).toHaveLength(2);
    expect(fills[0].executionId).toBe(-15060017250); // newest first
  });

  it("counts the EXECUTION and FILLED events of one fill as a single row", () => {
    // Both observed live for order 5388218593: the FILLED event carries
    // executionId 0 and `price` = the order's limit, not the fill price.
    const statusEvent = {
      ...execution,
      eventType: "FILLED",
      executionId: 0,
      filledQuantity: 1,
      price: 7687.5,
      avgFillPrice: 7687.75,
    };
    const log = new FillLog();
    log.apply([execution]);
    const fills = log.apply([statusEvent]);
    expect(fills).toHaveLength(1);
    // The execution price wins, not the limit price.
    expect(fills[0].price).toBe(7687.75);
  });

  it("keeps only the most recent fills", () => {
    const log = new FillLog(2);
    log.apply([
      { ...execution, executionId: 1, eventTime: 1 },
      { ...execution, executionId: 2, eventTime: 2 },
      { ...execution, executionId: 3, eventTime: 3 },
    ]);
    expect(log.snapshot().map((f) => f.executionId)).toEqual([3, 2]);
  });
});

describe("positions", () => {
  const body = {
    items: [
      {
        account: "D-68851449",
        instrument: {
          symbol: "/ES:XCME",
          rootSymbol: "/ES:XCME",
          description: "E-mini S&P 500 Index Futures, ETH",
          instrumentType: "PRODUCT",
        },
        symbol: "/ES:XCME",
        values: { QUANTITY: 2, OPEN_PRICE: 7687.75, PL_DAY: 0 },
        aggregated: true,
      },
      {
        account: "D-68851449",
        instrument: {
          symbol: "/ESU26:XCME",
          rootSymbol: "/ES:XCME",
          description: "E-mini S&P 500, Sep-2026",
          instrumentType: "FUTURE",
        },
        symbol: "/ESU26:XCME",
        values: { QUANTITY: 2, OPEN_PRICE: 7687.75, PL_OPEN: 12.5 },
        aggregated: false,
      },
    ],
  };

  it("prefers contract rows over the aggregated product rollup", () => {
    const rows = positionsFromBody(body);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      symbol: "/ESU26:XCME",
      quantity: 2,
      openPrice: 7687.75,
      plOpen: 12.5,
    });
  });

  it("drops flat positions and handles an empty body", () => {
    const flat = {
      items: [
        { symbol: "/MESU26:XCME", values: { QUANTITY: 0 }, aggregated: false },
      ],
    };
    expect(positionsFromBody(flat)).toEqual([]);
    expect(positionsFromBody({})).toEqual([]);
  });
});
