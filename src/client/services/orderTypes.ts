/**
 * Order vocabulary of the thinkorswim Web `place_order` service.
 * Every enum below is copied verbatim from the ToS Web entry bundle
 * (trade.thinkorswim.com/assets/index-*.js). Futures use the same
 * vocabulary as stocks: there is no INIT_FUTURE request type.
 */
export type RequestType =
  | "INIT_STOCK"
  | "INIT_OPTION"
  | "EDIT_ORDER"
  | "INIT_CANCEL_REPLACE";

export type OrderAction = "CONFIRM" | "SUBMIT";

export type OrderType =
  | "LIMIT"
  | "MARKET"
  | "MOC"
  | "LOC"
  | "STOP"
  | "STOPLIMIT"
  | "TRAILSTOP"
  | "TRAILSTOPLIMIT"
  | "WALK_LIMIT";

export type Tif =
  | "DAY"
  | "EXT"
  | "EXTO"
  | "AM"
  | "PM"
  | "ETH"
  | "GTC"
  | "GTC_EXT"
  | "GTC_EXTO";

export type Marker =
  | "SINGLE"
  | "BLAST_ALL"
  | "OCO"
  | "FIRST_TRIGGERS_ALL"
  | "FIRST_TRIGGERS_SEQ"
  | "FIRST_TRIGGERS_OCO"
  | "FIRST_TRIGGERS_2_OCO"
  | "FIRST_TRIGGERS_3_OCO"
  | "PAIR";

export type OrderSide = "BUY" | "SELL";

export type OrderLeg = {
  /** Exact tradeable symbol. For futures this must be the contract symbol
   *  returned by `future_series` (e.g. "/MESU26"), never the root ("/MES"). */
  symbol: string;
  /** Unsigned contract/share count; sign is derived from `side`. */
  quantity: number;
  side: OrderSide;
};

export type OrderSpec = {
  accountNumber: string;
  orderType: OrderType;
  legs: OrderLeg[];
  limitPrice?: number;
  /** Trigger price for STOP / STOPLIMIT. */
  stopPrice?: number;
  tif?: Tif;
  marker?: Marker;
  /** Key used in the `update-draft-order-<key>` request id. The SPA uses the
   *  root symbol for futures; defaults to the first leg's symbol. */
  draftKey?: string;
};

/** Wire-format leg: quantity is signed (BUY > 0, SELL < 0). */
export function wireLeg({ symbol, quantity, side }: OrderLeg) {
  const q = Math.abs(quantity);
  return { symbol, quantity: side === "SELL" ? -q : q };
}

export function draftOrderId(spec: OrderSpec): string {
  return `update-draft-order-${spec.draftKey ?? spec.legs[0].symbol}`;
}

/**
 * Builds the per-order object shared by CONFIRM and SUBMIT, mirroring the SPA
 * serializers (`limitPrice` omitted for STOP; `stopPrice` only for STOP/STOPLIMIT).
 */
export function wireOrder(
  spec: OrderSpec,
  requestType: RequestType,
  refOrderId?: number,
) {
  const { orderType, limitPrice, stopPrice, tif } = spec;
  const isStop = orderType === "STOP" || orderType === "STOPLIMIT";
  return {
    requestType,
    ...(refOrderId !== undefined ? { refOrderId } : {}),
    ...(tif ? { tif } : {}),
    orderType,
    ...(limitPrice !== undefined && orderType !== "STOP" ? { limitPrice } : {}),
    ...(isStop && stopPrice !== undefined ? { stopPrice } : {}),
    legs: spec.legs.map(wireLeg),
  };
}

export function validateOrderSpec(spec: OrderSpec): void {
  if (!spec.accountNumber) throw new Error("accountNumber is required");
  if (!spec.legs?.length) throw new Error("at least one leg is required");
  for (const leg of spec.legs) {
    if (!leg.symbol) throw new Error("leg.symbol is required");
    if (!(leg.quantity > 0)) throw new Error("leg.quantity must be > 0");
    if (
      /^\/[A-Z0-9]+(:[A-Z]+)?$/.test(leg.symbol) &&
      !/\d{1,2}$/.test(leg.symbol.split(":")[0])
    ) {
      throw new Error(
        `"${leg.symbol}" looks like a futures ROOT; pass the contract symbol from future_series (e.g. /MESU26)`,
      );
    }
  }
  const needsLimit = ["LIMIT", "STOPLIMIT", "LOC"].includes(spec.orderType);
  if (needsLimit && spec.limitPrice === undefined)
    throw new Error(`${spec.orderType} requires limitPrice`);
  const needsStop = ["STOP", "STOPLIMIT"].includes(spec.orderType);
  if (needsStop && spec.stopPrice === undefined)
    throw new Error(`${spec.orderType} requires stopPrice`);
}
