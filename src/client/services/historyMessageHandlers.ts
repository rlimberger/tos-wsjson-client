import { RawPayloadRequest } from "../tdaWsJsonTypes.js";
import { ApiService } from "./apiService.js";
import WebSocketApiMessageHandler, {
  newPayload,
} from "./webSocketApiMessageHandler.js";

/**
 * Day history and account values, straight from the gateway.
 *
 * These are one-shot request/response services (not subscriptions): the server
 * returns the completed orders and executions for a date range, so nothing has
 * to be reconstructed from the live `order_events` stream.
 *
 * Field lists and the time format are taken from the ToS web bundle
 * (trade.thinkorswim.com/assets/index-*.js).
 */

export const ORDER_ENTRY_FIELDS = [
  "TIME_PLACED",
  "SPREAD",
  "QTY",
  "SYMBOL",
  "PRICE_TYPE",
  "TIF",
  "STATUS",
  "PRICE_IMPROVEMENT",
] as const;

export const TRADE_EXECUTION_FIELDS = [
  "EXEC_TIME",
  "SPREAD",
  "QTY",
  "SYMBOL",
  "NET_PRICE",
  "ORDER_TYPE",
  "PRICE_IMPROVEMENT",
] as const;

export const ORDER_LEG_FIELDS = [
  "POSITION_EFFECT",
  "EXPIRATION",
  "STRIKE",
  "TYPE",
] as const;

export const TRADE_LEG_FIELDS = [...ORDER_LEG_FIELDS, "PRICE"] as const;

export type HistoryRequest = {
  accountNumber: string;
  /** Inclusive range; use `tradingDayRange()` for "today". */
  startTime: string;
  endTime: string;
};

/**
 * The web app anchors a trading day at 06:00 UTC and ends 1ms before the next
 * day's anchor — futures sessions start the previous evening, so a midnight
 * boundary would split them.
 */
export function tradingDayRange(day: Date = new Date()): {
  startTime: string;
  endTime: string;
} {
  const start = new Date(new Date(day).setUTCHours(6, 0, 0, 0));
  const nextDay = new Date(start);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const end = new Date(nextDay.getTime() - 1);
  return { startTime: start.toISOString(), endTime: end.toISOString() };
}

export type RawOrderHistoryLeg = {
  positionEffect?: string;
  expiration?: string;
  strike?: number;
  type?: string;
  symbol?: string;
  quantity?: number;
  price?: number;
};

export type RawOrderHistoryEntry = {
  timePlaced?: string;
  spread?: string;
  quantity?: number;
  symbol?: string;
  priceType?: string;
  tif?: string;
  status?: string;
  priceImprovement?: number;
  legs?: RawOrderHistoryLeg[];
};

export type RawOrderHistoryResponse = {
  service: "order_history";
  orderHistoryEntries?: RawOrderHistoryEntry[];
  error?: string;
};

export type RawTradeHistoryEntry = {
  /** The wire name is executionTime despite the EXEC_TIME field request. */
  executionTime?: string;
  spread?: string;
  quantity?: number;
  symbol?: string;
  netPrice?: number;
  orderType?: string;
  priceImprovement?: number;
  legs?: RawOrderHistoryLeg[];
};

export type RawTradeHistoryResponse = {
  service: "trade_history";
  tradeHistoryEntries?: RawTradeHistoryEntry[];
  error?: string;
};

export class OrderHistoryMessageHandler implements WebSocketApiMessageHandler<HistoryRequest> {
  service: ApiService = "order_history";

  requestId(): string {
    return "orderHistory";
  }

  buildRequest({
    accountNumber,
    startTime,
    endTime,
  }: HistoryRequest): RawPayloadRequest {
    return newPayload({
      header: { service: "order_history", id: this.requestId(), ver: 0 },
      params: {
        startTime,
        endTime,
        account: accountNumber,
        orderEntryFields: [...ORDER_ENTRY_FIELDS],
        legFields: [...ORDER_LEG_FIELDS],
      },
    });
  }
}

export class TradeHistoryMessageHandler implements WebSocketApiMessageHandler<HistoryRequest> {
  service: ApiService = "trade_history";

  requestId(): string {
    return "tradeHistory";
  }

  buildRequest({
    accountNumber,
    startTime,
    endTime,
  }: HistoryRequest): RawPayloadRequest {
    return newPayload({
      header: { service: "trade_history", id: this.requestId(), ver: 0 },
      params: {
        startTime,
        endTime,
        account: accountNumber,
        tradeExecutionFields: [...TRADE_EXECUTION_FIELDS],
        legFields: [...TRADE_LEG_FIELDS],
      },
    });
  }
}

/** Account values (net liq, cash, buying power) as the server computes them. */
export type RawStatementResponse = {
  service: "statement";
  values?: {
    NET_LIQ?: number;
    CASH_AND_SWEEP?: number;
    CASH_AVAI_FOR_WITHDRAWAL?: number;
    TOTAL_CASH?: number;
    FUTURES_CASH?: number;
    FOREX_CASH?: number;
    OPTION_BP?: number;
    STOCK_BP?: number;
    INTRADAY_BP?: number;
    DTBP?: number;
    DT_LEFT?: number;
    UNSETTLED_CASH?: number;
  };
};

export class StatementMessageHandler implements WebSocketApiMessageHandler<string> {
  service: ApiService = "statement";

  requestId(accountNumber: string): string {
    // The web app uses the account code as the request id.
    return accountNumber;
  }

  buildRequest(accountNumber: string): RawPayloadRequest {
    return newPayload({
      header: { service: "statement", id: accountNumber, ver: 0 },
      params: { account: accountNumber },
    });
  }
}
