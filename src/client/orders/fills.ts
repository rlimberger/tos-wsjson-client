import { RawOrderEvent } from "../services/orderEventsMessageHandler.js";

/**
 * Executions extracted from the `order_events` stream.
 *
 * A marketable order can fill before it is ever visible as WORKING, so a
 * working-order view alone will miss it entirely — the fill log is what shows
 * that the order existed at all.
 */
export type Fill = {
  /** Stable per-execution id from the gateway (negative in paper money). */
  executionId: number;
  orderId: number;
  /** Epoch ms of the execution. */
  time: number;
  symbol: string;
  /** Normalized to BUY/SELL; the wire uses BOT/SLD on executions. */
  side: string;
  quantity: number;
  price?: number;
  description: string;
};

const FILL_EVENT_TYPES = new Set(["EXECUTION", "FILLED"]);

function normalizeSide(side: string | undefined, quantity?: number): string {
  const raw = (side ?? "").toUpperCase();
  if (raw.startsWith("B")) return "BUY"; // BUY, BOT
  if (raw.startsWith("S")) return "SELL"; // SELL, SLD
  return (quantity ?? 0) < 0 ? "SELL" : "BUY";
}

export function isFillEvent(ev: Partial<RawOrderEvent>): boolean {
  const eventType = (ev.eventType ?? "").toUpperCase();
  const status = (ev.status ?? "").toUpperCase();
  return FILL_EVENT_TYPES.has(eventType) || status === "FILLED";
}

export function toFill(ev: Partial<RawOrderEvent>): Fill | undefined {
  if (!isFillEvent(ev)) return undefined;
  const orderId = ev.orderId;
  if (typeof orderId !== "number") return undefined;
  const quantity = Math.abs(Number(ev.filledQuantity ?? ev.quantity ?? 0));
  if (!quantity) return undefined;
  return {
    // Executions carry an executionId; a plain FILLED status event may not, so
    // fall back to the order id to keep the row de-duplicatable.
    executionId: ev.executionId ?? orderId,
    orderId,
    time: ev.eventTime ?? 0,
    symbol:
      ev.legs?.[0]?.symbol ||
      ev.underlyingSymbol ||
      ev.compositeSymbol ||
      ev.rootSymbol ||
      "",
    side: normalizeSide(ev.side, ev.quantity),
    quantity,
    price: ev.avgFillPrice ?? ev.price,
    description: ev.descriptionToShare || ev.description || "",
  };
}

/** Keeps the most recent executions, newest first, de-duplicated. */
export class FillLog {
  private readonly seen = new Set<string>();
  private fills: Fill[] = [];

  constructor(private readonly limit = 100) {}

  /**
   * Adds any executions in an order_events document; returns the current log.
   *
   * The gateway reports one fill twice: an EXECUTION (executionId set, `price`
   * = the execution price) and a FILLED status event (executionId 0, `price` =
   * the order's limit price). Neither executionId nor price is therefore part
   * of the identity — only order, timestamp and size. Two genuine partial fills
   * of the same order at the same millisecond and size would collapse into one
   * row; that is preferable to showing every fill twice.
   *
   * `avgFillPrice` agrees across both events, which is why toFill() prefers it.
   */
  apply(orders: Array<Partial<RawOrderEvent>> | undefined): Fill[] {
    for (const ev of orders ?? []) {
      const fill = toFill(ev);
      if (!fill) continue;
      const key = `${fill.orderId}:${fill.time}:${fill.quantity}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      this.fills.push(fill);
    }
    this.fills.sort((a, b) => b.time - a.time || b.executionId - a.executionId);
    if (this.fills.length > this.limit) {
      this.fills = this.fills.slice(0, this.limit);
    }
    return this.snapshot();
  }

  snapshot(): Fill[] {
    return [...this.fills];
  }
}
