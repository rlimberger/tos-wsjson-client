import { RawPayloadRequest } from "../tdaWsJsonTypes.js";
import { ApiService } from "./apiService.js";
import WebSocketApiMessageHandler, {
  newPayload,
} from "./webSocketApiMessageHandler.js";

/** One row of the `future_series` response (schema from the ToS Web bundle). */
export type RawFutureSeriesItem = {
  symbol: string; // contract symbol, e.g. "/MESU26" — use this in order legs
  displaySymbol: string;
  daysToExpiration: number;
  lastTradeDate: string | number;
  isActive: boolean;
  expiration: string;
  firstNoticeDate?: string | number;
};

export type RawFutureSeriesResponse = {
  service: "future_series";
  series: RawFutureSeriesItem[];
};

export type FutureSeriesRequest = {
  /** Futures root, e.g. "/ES", "/MES", "/6E:XCME". */
  root: string;
  /** Optional fixed id (tests); defaults to a random one like the SPA. */
  requestId?: string;
};

export default class FutureSeriesMessageHandler implements WebSocketApiMessageHandler<FutureSeriesRequest> {
  service: ApiService = "future_series";

  requestId(req: FutureSeriesRequest): string {
    // memoize so buildRequest() and response routing agree on the id
    req.requestId ??= `futureSeries-${Math.floor(Math.random() * 4294967296)}`;
    return req.requestId;
  }

  buildRequest(req: FutureSeriesRequest): RawPayloadRequest {
    return newPayload({
      header: { service: "future_series", id: this.requestId(req), ver: 0 },
      params: { symbol: req.root },
    });
  }
}

/** Picks the contract the ToS Web UI would trade for a root (the `isActive` one). */
export function activeContract(
  series: RawFutureSeriesItem[],
): RawFutureSeriesItem | undefined {
  return series.find((s) => s.isActive) ?? series[0];
}
