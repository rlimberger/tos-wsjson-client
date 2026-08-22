import { RawOrderEvent } from "../services/orderEventsMessageHandler.js";

const ACTIVE = new Set([
  "WORKING",
  "QUEUED",
  "WAITING",
  "PENDING",
  "ACCEPTED",
  "TRIGGERED",
]);

const TERMINAL = new Set([
  "CANCELED",
  "CANCELLED",
  "FILLED",
  "EXPIRED",
  "REJECTED",
  "FINAL",
  "REPLACED",
]);

export type DisplayOrder = {
  orderId: number;
  symbol: string;
  side: string;
  quantity: number;
  filledQuantity: number;
  remaining: number;
  orderType: string;
  limitPrice?: number;
  tif?: string;
  status: string;
  eventType: string;
  cancelable: boolean;
  description?: string;
};

export type OrderBookEvent =
  | { kind: "upsert"; order: DisplayOrder }
  | { kind: "remove"; orderId: number; reason: string };

function symbolOf(ev: Partial<RawOrderEvent>): string {
  return (
    ev.compositeSymbol ||
    ev.legs?.[0]?.symbol ||
    ev.rootSymbol ||
    ev.underlyingSymbol ||
    ""
  );
}

function toDisplay(ev: Partial<RawOrderEvent>): DisplayOrder | undefined {
  const orderId = ev.orderId;
  if (typeof orderId !== "number") return undefined;
  const quantity = Math.abs(Number(ev.quantity ?? 0));
  const filledQuantity = Math.abs(Number(ev.filledQuantity ?? 0));
  return {
    orderId,
    symbol: symbolOf(ev),
    side: ev.side ?? (Number(ev.quantity) < 0 ? "SELL" : "BUY"),
    quantity,
    filledQuantity,
    remaining: Math.max(0, quantity - filledQuantity),
    orderType: ev.orderType ?? "",
    limitPrice: ev.limitPrice,
    tif: ev.tif,
    status: ev.status ?? ev.eventType ?? "",
    eventType: ev.eventType ?? "",
    cancelable: Boolean(ev.cancelable),
    description: ev.description || ev.legsDescription,
  };
}

function isTerminal(ev: Partial<RawOrderEvent>): boolean {
  const status = (ev.status ?? "").toUpperCase();
  const eventType = (ev.eventType ?? "").toUpperCase();
  return TERMINAL.has(status) || TERMINAL.has(eventType);
}

function isActive(ev: Partial<RawOrderEvent>): boolean {
  const status = (ev.status ?? "").toUpperCase();
  const eventType = (ev.eventType ?? "").toUpperCase();
  return ACTIVE.has(status) || ACTIVE.has(eventType);
}

/**
 * Rebuild the working book from a full `order_events` document.
 * The patched snapshot is treated as an event log: WORKING upserts,
 * CANCELED/FILLED/FINAL removes, EXECUTION updates fill qty.
 */
export function rebuildWorkingOrders(
  orders: Array<Partial<RawOrderEvent>> | undefined,
): DisplayOrder[] {
  const book = new Map<number, DisplayOrder>();
  for (const ev of orders ?? []) applyEvent(book, ev);
  return [...book.values()].sort((a, b) => a.orderId - b.orderId);
}

export function applyEvent(
  book: Map<number, DisplayOrder>,
  ev: Partial<RawOrderEvent>,
): OrderBookEvent | undefined {
  const orderId = ev.orderId;
  if (typeof orderId !== "number") return undefined;
  const eventType = (ev.eventType ?? "").toUpperCase();

  if (isTerminal(ev) && eventType !== "EXECUTION") {
    book.delete(orderId);
    return { kind: "remove", orderId, reason: ev.status || ev.eventType || "" };
  }

  if (eventType === "EXECUTION") {
    const existing = book.get(orderId);
    const next = toDisplay({
      ...ev,
      orderId,
      quantity: ev.quantity ?? existing?.quantity,
      filledQuantity: ev.filledQuantity ?? existing?.filledQuantity,
      compositeSymbol: ev.compositeSymbol || existing?.symbol,
      side: (ev.side ?? existing?.side) as RawOrderEvent["side"],
      orderType: ev.orderType ?? existing?.orderType,
      limitPrice: ev.limitPrice ?? existing?.limitPrice,
      tif: ev.tif ?? existing?.tif,
      status: ev.status ?? existing?.status,
      cancelable: ev.cancelable ?? existing?.cancelable,
      description: ev.description ?? existing?.description,
    });
    if (!next) return undefined;
    if (next.quantity > 0 && next.filledQuantity >= next.quantity) {
      book.delete(orderId);
      return { kind: "remove", orderId, reason: "FILLED" };
    }
    if (existing || isActive(ev)) {
      book.set(orderId, next);
      return { kind: "upsert", order: next };
    }
    return undefined;
  }

  if (isActive(ev) || book.has(orderId)) {
    const next = toDisplay(ev);
    if (!next) return undefined;
    book.set(orderId, next);
    return { kind: "upsert", order: next };
  }
  return undefined;
}

export function ordersFromEventsBody(
  body: Record<string, unknown>,
): DisplayOrder[] {
  const orders = body.orders;
  if (!Array.isArray(orders)) return [];
  return rebuildWorkingOrders(orders as Array<Partial<RawOrderEvent>>);
}
