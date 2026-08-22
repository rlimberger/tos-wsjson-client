import { RawPayloadRequest } from "../tdaWsJsonTypes.js";
import { newPayload } from "../services/webSocketApiMessageHandler.js";

export type FuturesOrderSide = "BUY" | "SELL";

export type PaperMoneyFuturesLimitOrder = Readonly<{
  accountNumber: string;
  rootSymbol: string;
  contractSymbol: string;
  side: FuturesOrderSide;
  quantity: number;
  limitPrice: number;
}>;

const SINGLE_ORDER_MARKER = "SINGLE";

/**
 * Builds the two paperMoney payloads for a single-leg futures limit order.
 *
 * The confirmation response supplies the draft order ID that must be passed to
 * {@link buildSubmissionRequest}. Building a request does not send it.
 */
export class PaperMoneyFuturesOrderBuilder {
  private readonly order: PaperMoneyFuturesLimitOrder;

  constructor(order: PaperMoneyFuturesLimitOrder) {
    this.order = validateOrder(order);
  }

  buildConfirmationRequest(): RawPayloadRequest {
    const { accountNumber, contractSymbol, limitPrice } = this.order;

    return newPayload({
      header: {
        id: this.requestId,
        service: "place_order",
        ver: 1,
      },
      params: {
        accountCode: accountNumber,
        action: "CONFIRM",
        marker: SINGLE_ORDER_MARKER,
        orders: [
          {
            requestType: "INIT_STOCK",
            orderType: "LIMIT",
            limitPrice,
            legs: [{ symbol: contractSymbol, quantity: this.signedQuantity }],
          },
        ],
      },
    });
  }

  buildSubmissionRequest(draftOrderId: number): RawPayloadRequest {
    validateDraftOrderId(draftOrderId);
    const { accountNumber, contractSymbol, limitPrice } = this.order;

    return newPayload({
      header: {
        id: this.requestId,
        service: "place_order",
        ver: 0,
      },
      params: {
        accountCode: accountNumber,
        action: "SUBMIT",
        marker: SINGLE_ORDER_MARKER,
        orders: [
          {
            tif: "DAY",
            orderType: "LIMIT",
            refOrderId: draftOrderId,
            limitPrice,
            requestType: "EDIT_ORDER",
            legs: [{ symbol: contractSymbol, quantity: this.signedQuantity }],
            tag: "TOSWeb",
          },
        ],
      },
    });
  }

  private get requestId(): string {
    return `update-draft-order-${this.order.rootSymbol}`;
  }

  private get signedQuantity(): number {
    return this.order.side === "BUY"
      ? this.order.quantity
      : -this.order.quantity;
  }
}

function validateOrder(
  order: PaperMoneyFuturesLimitOrder,
): PaperMoneyFuturesLimitOrder {
  const accountNumber = order.accountNumber.trim();
  const rootSymbol = order.rootSymbol.trim().toUpperCase();
  const contractSymbol = order.contractSymbol.trim().toUpperCase();

  if (accountNumber.length === 0) {
    throw new Error("A paperMoney account number is required.");
  }
  if (!rootSymbol.startsWith("/")) {
    throw new Error('The futures root symbol must start with "/".');
  }
  if (contractSymbol === rootSymbol || !contractSymbol.startsWith(rootSymbol)) {
    throw new Error(
      "An exact futures contract symbol under the root symbol is required.",
    );
  }
  if (!Number.isInteger(order.quantity) || order.quantity <= 0) {
    throw new Error("Futures order quantity must be a positive integer.");
  }
  if (order.side !== "BUY" && order.side !== "SELL") {
    throw new Error('Futures order side must be "BUY" or "SELL".');
  }
  if (!Number.isFinite(order.limitPrice)) {
    throw new Error("Futures limit price must be a finite number.");
  }

  return Object.freeze({
    ...order,
    accountNumber,
    rootSymbol,
    contractSymbol,
  });
}

function validateDraftOrderId(draftOrderId: number): void {
  if (!Number.isInteger(draftOrderId) || draftOrderId <= 0) {
    throw new Error(
      "The paperMoney draft order ID must be a positive integer.",
    );
  }
}
