import {
  ConfirmOrderRequest,
  draftProblems,
  draftWarnings,
  RawDraftOrderResponse,
  SubmitOrderRequest,
} from "../services/draftOrderMessageHandlers.js";
import {
  activeContract,
  RawFutureSeriesItem,
} from "../services/futureSeriesMessageHandler.js";
import { normalizeFuturesRoot, OrderSpec } from "../services/orderTypes.js";
import { assertTradingSystemAllowed, TradingSystem } from "../tosWebConfig.js";

export type FuturesOrderTransport = {
  futureSeries(root: string): Promise<RawFutureSeriesItem[]>;
  confirmOrder(request: ConfirmOrderRequest): Promise<RawDraftOrderResponse>;
  submitDraftOrder(request: SubmitOrderRequest): Promise<RawDraftOrderResponse>;
  /** Subscribe to the six-type order_events feed. Fire-and-forget is fine. */
  orderEvents?(accountNumber: string): AsyncIterable<unknown>;
};

export type FuturesOrderIntent = Omit<OrderSpec, "legs" | "draftKey"> & {
  side: "BUY" | "SELL";
  quantity: number;
  /** Trade a specific contract instead of the `isActive` one. */
  contract?: string;
};

export type FuturesOrderResult = {
  contract: RawFutureSeriesItem;
  confirmation: RawDraftOrderResponse;
  submission?: RawDraftOrderResponse;
  warnings: string[];
};

/**
 * A successful CONFIRM that is the only value `submit()` will accept.
 * Constructed exclusively by {@link FuturesOrderBuilder.confirm}.
 */
export class ConfirmedFuturesDraft {
  private constructor(
    readonly contract: RawFutureSeriesItem,
    readonly confirmation: RawDraftOrderResponse,
    readonly spec: OrderSpec,
    readonly warnings: string[],
  ) {}

  static fromSuccessful(
    contract: RawFutureSeriesItem,
    confirmation: RawDraftOrderResponse,
    spec: OrderSpec,
  ): ConfirmedFuturesDraft {
    const problems = draftProblems(confirmation);
    if (problems.length) {
      throw new Error(`CONFIRM rejected: ${problems.join("; ")}`);
    }
    return new ConfirmedFuturesDraft(
      contract,
      confirmation,
      spec,
      draftWarnings(confirmation),
    );
  }
}

export type FuturesOrderBuilderOptions = {
  tradingSystem?: TradingSystem;
  allowLiveTrading?: boolean;
};

/**
 * PaperMoney-first futures order builder.
 *
 * CONFIRM is a draft/validation call. SUBMIT is the state-changing call.
 * `place(..., { dryRun: true })` (the default) never sends SUBMIT.
 */
export class FuturesOrderBuilder {
  private readonly tradingSystem: TradingSystem;
  private readonly allowLiveTrading: boolean;

  constructor(
    private readonly transport: FuturesOrderTransport,
    options: FuturesOrderBuilderOptions = {},
  ) {
    this.tradingSystem = options.tradingSystem ?? "PaperMoney";
    this.allowLiveTrading = options.allowLiveTrading === true;
    assertTradingSystemAllowed(this.tradingSystem, this.allowLiveTrading);
  }

  async resolve(
    root: string,
    contractSymbol?: string,
  ): Promise<RawFutureSeriesItem> {
    const normalized = normalizeFuturesRoot(root);
    const series = await this.transport.futureSeries(normalized);
    const contract = contractSymbol
      ? series.find((s) => s.symbol === contractSymbol)
      : activeContract(series);
    if (!contract) {
      throw new Error(
        `no tradeable contract for ${normalized} (${contractSymbol ?? "active"})`,
      );
    }
    return contract;
  }

  async confirm(
    root: string,
    intent: FuturesOrderIntent,
  ): Promise<ConfirmedFuturesDraft> {
    const { side, quantity, contract: contractSymbol, ...rest } = intent;
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new Error(
        "futures quantity must be a positive integer (number of contracts)",
      );
    }
    const normalized = normalizeFuturesRoot(root);
    const contract = await this.resolve(normalized, contractSymbol);
    const spec: OrderSpec = {
      ...rest,
      draftKey: normalized,
      legs: [{ symbol: contract.symbol, quantity, side }],
    };
    const confirmation = await this.transport.confirmOrder({ spec });
    return ConfirmedFuturesDraft.fromSuccessful(contract, confirmation, spec);
  }

  async submit(draft: ConfirmedFuturesDraft): Promise<RawDraftOrderResponse> {
    if (!(draft instanceof ConfirmedFuturesDraft)) {
      throw new Error("submit requires a ConfirmedFuturesDraft from confirm()");
    }
    if (this.tradingSystem === "LiveTrading" && !this.allowLiveTrading) {
      throw new Error(
        "LiveTrading SUBMIT is gated off. Pass { allowLiveTrading: true }.",
      );
    }
    this.transport.orderEvents?.(draft.spec.accountNumber);
    const confirmed = draft.confirmation.orders?.[0];
    const tif =
      draft.spec.tif ??
      (confirmed?.tifs
        ? confirmed.tifs.values[confirmed.tifs.selection]
        : "DAY");
    return this.transport.submitDraftOrder({
      spec: { ...draft.spec, tif },
      refOrderId: confirmed?.orderId,
    });
  }

  async place(
    root: string,
    intent: FuturesOrderIntent,
    { dryRun = true }: { dryRun?: boolean } = {},
  ): Promise<FuturesOrderResult> {
    const draft = await this.confirm(root, intent);
    const result: FuturesOrderResult = {
      contract: draft.contract,
      confirmation: draft.confirmation,
      warnings: draft.warnings,
    };
    if (dryRun) return result;
    result.submission = await this.submit(draft);
    return result;
  }
}
