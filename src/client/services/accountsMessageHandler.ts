import { RawPayloadRequest } from "../tdaWsJsonTypes.js";
import { ApiService } from "./apiService.js";
import WebSocketApiMessageHandler, {
  newPayload,
} from "./webSocketApiMessageHandler.js";

export type RawAccountItem = {
  accountCode?: string;
  code?: string;
  displayName?: string;
  nickname?: string;
  accountType?: string;
  [k: string]: unknown;
};

export type RawAccountsResponse = {
  service: "accounts";
  items: RawAccountItem[];
};

/** Lists the accounts available on the connected (live or paper) session. */
export default class AccountsMessageHandler implements WebSocketApiMessageHandler<void> {
  service: ApiService = "accounts";

  requestId(): string {
    return "accounts";
  }

  buildRequest(): RawPayloadRequest {
    return newPayload({
      header: { service: "accounts", id: "accounts", ver: 0 },
      params: {},
    });
  }
}

export function accountCodeOf(a: RawAccountItem): string | undefined {
  return a.accountCode ?? a.code;
}
