/**
 * Positions as the watcher displays them.
 *
 * The `positions` service returns both an aggregated product-level row
 * (instrumentType PRODUCT, `aggregated: true`) and the contract-level rows it
 * rolls up. Showing both double-counts, so the contract rows win when present.
 */
export type PositionRow = {
  symbol: string;
  rootSymbol: string;
  description: string;
  instrumentType: string;
  quantity: number;
  openPrice?: number;
  mark?: number;
  plOpen?: number;
  plDay?: number;
  netLiq?: number;
};

type RawPositionItem = {
  symbol?: string;
  rootSymbol?: string;
  instrument?: {
    symbol?: string;
    rootSymbol?: string;
    description?: string;
    instrumentType?: string;
  };
  values?: Record<string, number | undefined>;
  aggregated?: boolean;
};

function toRow(item: RawPositionItem): PositionRow | undefined {
  const symbol = item.symbol ?? item.instrument?.symbol;
  if (!symbol) return undefined;
  const values = item.values ?? {};
  return {
    symbol,
    rootSymbol: item.rootSymbol ?? item.instrument?.rootSymbol ?? "",
    description: item.instrument?.description ?? "",
    instrumentType: item.instrument?.instrumentType ?? "",
    quantity: Number(values.QUANTITY ?? 0),
    openPrice: values.OPEN_PRICE,
    mark: values.MARK,
    plOpen: values.PL_OPEN,
    plDay: values.PL_DAY,
    netLiq: values.NET_LIQ,
  };
}

export function positionsFromBody(
  body: Record<string, unknown>,
): PositionRow[] {
  const items = body.items;
  if (!Array.isArray(items)) return [];
  const raw = items as RawPositionItem[];
  const contractRows = raw.filter((i) => i.aggregated !== true);
  const chosen = contractRows.length > 0 ? contractRows : raw;
  return chosen
    .map(toRow)
    .filter((r): r is PositionRow => !!r && r.quantity !== 0)
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}
