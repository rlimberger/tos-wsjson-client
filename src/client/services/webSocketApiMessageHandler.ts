import { RawPayloadRequest, RawPayloadRequestItem } from "../tdaWsJsonTypes.js";
import { ApiService } from "./apiService.js";

// Service interface definition for implementing support for new message types
export default interface WebSocketApiMessageHandler<ReqType> {
  // The name of the websocket service this handler is responsible for implementing
  service: ApiService;

  // Constructs a new message payload to be sent to the TDA websocket server
  buildRequest: (args: ReqType) => RawPayloadRequest;

  // Optional: the header.id this handler uses for `args`. When provided, the
  // client only routes responses carrying the same id back to the caller.
  requestId?: (args: ReqType) => string;
}

export function newPayload(item: RawPayloadRequestItem) {
  return { payload: [item] };
}
