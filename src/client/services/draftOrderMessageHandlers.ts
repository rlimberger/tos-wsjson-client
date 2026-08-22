import { RawPayloadRequest } from "../tdaWsJsonTypes.js";
import { ApiService } from "./apiService.js";
import {
  draftOrderId,
  OrderSpec,
  RequestType,
  validateOrderSpec,
  wireOrder,
} from "./orderTypes.js";
import WebSocketApiMessageHandler, {
  newPayload,
} from "./webSocketApiMessageHandler.js";

/**
 * Two-phase order flow used by thinkorswim Web for every instrument type
 * (stocks, futures, ...):
 *   1. place_order action=CONFIRM requestType=INIT_STOCK -> server creates a
 *      draft and returns allowed tifs/types, price step, cost, orderId.
 *   2. place_order action=SUBMIT requestType=EDIT_ORDER refOrderId=<draft id>.
 * Both messages share the id `update-draft-order-<key>`; `ver` increases on
 * every re-CONFIRM of the same draft.
 */

export type ConfirmOrderRequest = {
  spec: OrderSpec;
  /** INIT_STOCK for new stock/future orders; INIT_CANCEL_REPLACE with refOrderId to replace a live order. */
  requestType?: Extract<RequestType, "INIT_STOCK" | "INIT_CANCEL_REPLACE">;
  refOrderId?: number;
  ver?: number;
};

export type SubmitOrderRequest = {
  spec: OrderSpec;
  /** Draft orderId from the CONFIRM response, or a live orderId when replacing. */
  refOrderId?: number;
  ver?: number;
};

export type RawDraftOrderItem = {
  orderId?: number;
  compositeSymbol?: string;
  descriptionToShare?: string;
  priceStep?: number;
  quantity?: number;
  priceType?: string;
  tifs?: { values: string[]; selection: number };
  types?: { values: string[]; selection: number };
  legs?: { symbol: string }[];
  bidPrice?: number;
  askPrice?: number;
  midPrice?: number;
  cost?: number;
  commissions?: number;
  fees?: { type: string; value: number }[];
  futureSpread?: boolean;
  error?: string;
};

export type RawDraftOrderResponse = {
  orders?: RawDraftOrderItem[];
  confirmation?: {
    rows: { title: string; value: string; numericValues?: number[] }[];
    cost?: number;
    commission?: number;
    fee?: number;
    warnings?: { message: string }[];
  };
  validationError?: string;
  error?: string;
  /** present when header.type === "error" */
  message?: string;
};

export class ConfirmOrderMessageHandler implements WebSocketApiMessageHandler<ConfirmOrderRequest> {
  service: ApiService = "place_order";

  requestId({ spec }: ConfirmOrderRequest): string {
    return draftOrderId(spec);
  }

  buildRequest({
    spec,
    requestType = "INIT_STOCK",
    refOrderId,
    ver = 0,
  }: ConfirmOrderRequest): RawPayloadRequest {
    validateOrderSpec(spec);
    return newPayload({
      header: { id: draftOrderId(spec), service: "place_order", ver },
      params: {
        accountCode: spec.accountNumber,
        action: "CONFIRM",
        marker: spec.marker ?? "SINGLE",
        orders: [wireOrder(spec, requestType, refOrderId)],
      },
    });
  }
}

export class SubmitDraftOrderMessageHandler implements WebSocketApiMessageHandler<SubmitOrderRequest> {
  service: ApiService = "place_order";

  requestId({ spec }: SubmitOrderRequest): string {
    return draftOrderId(spec);
  }

  buildRequest({
    spec,
    refOrderId,
    ver = 0,
  }: SubmitOrderRequest): RawPayloadRequest {
    validateOrderSpec(spec);
    const order = {
      ...wireOrder({ tif: "DAY", ...spec }, "EDIT_ORDER", refOrderId),
      tag: "TOSWeb",
    };
    return newPayload({
      header: { id: draftOrderId(spec), service: "place_order", ver },
      params: {
        accountCode: spec.accountNumber,
        action: "SUBMIT",
        marker: spec.marker ?? "SINGLE",
        orders: [order],
      },
    });
  }
}

export function draftProblems(body: RawDraftOrderResponse): string[] {
  const problems: string[] = [];
  if (body.message) problems.push(body.message);
  if (body.error) problems.push(body.error);
  if (body.validationError) problems.push(body.validationError);
  for (const o of body.orders ?? []) if (o.error) problems.push(o.error);
  return problems;
}
