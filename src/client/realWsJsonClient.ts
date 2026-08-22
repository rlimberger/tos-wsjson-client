import debug from "debug";
import WebSocket from "isomorphic-ws";
import {
  BufferedIterator,
  deferredWrap,
  MulticastIterator,
  Observable,
} from "obgen";
import {
  isConnectionResponse,
  isLoginResponse,
  isSchwabLoginResponse,
} from "./messageTypeHelpers.js";
import ResponseParser from "./responseParser.js";
import AlertLookupMessageHandler from "./services/alertLookupMessageHandler.js";
import CancelAlertMessageHandler from "./services/cancelAlertMessageHandler.js";
import CancelOrderMessageHandler from "./services/cancelOrderMessageHandler.js";
import ChartMessageHandler, {
  ChartRequestParams,
} from "./services/chartMessageHandler.js";
import CreateAlertMessageHandler, {
  CreateAlertRequestParams,
} from "./services/createAlertMessageHandler.js";
import GenericIncomingMessageHandler from "./services/genericIncomingMessageHandler.js";
import GetWatchlistMessageHandler from "./services/getWatchlistMessageHandler.js";
import InstrumentSearchMessageHandler from "./services/instrumentSearchMessageHandler.js";
import LoginMessageHandler, {
  RawLoginResponse,
  RawLoginResponseBody,
} from "./services/loginMessageHandler.js";
import MarketDepthMessageHandler from "./services/marketDepthMessageHandler.js";
import OptionChainDetailsMessageHandler, {
  OptionChainDetailsRequest,
} from "./services/optionChainDetailsMessageHandler.js";
import OptionQuotesMessageHandler, {
  OptionQuotesRequestParams,
} from "./services/optionQuotesMessageHandler.js";
import OptionSeriesMessageHandler from "./services/optionSeriesMessageHandler.js";
import OptionSeriesQuotesMessageHandler from "./services/optionSeriesQuotesMessageHandler.js";
import OrderEventsMessageHandler from "./services/orderEventsMessageHandler.js";
import PlaceOrderMessageHandler, {
  PlaceLimitOrderRequestParams,
} from "./services/placeOrderMessageHandler.js";
import PositionsMessageHandler from "./services/positionsMessageHandler.js";
import QuotesMessageHandler from "./services/quotesMessageHandler.js";
import SchwabLoginMessageHandler from "./services/schwabLoginMessageHandler.js";
import FutureSeriesMessageHandler, {
  FutureSeriesRequest,
  RawFutureSeriesItem,
  RawFutureSeriesResponse,
} from "./services/futureSeriesMessageHandler.js";
import {
  ConfirmOrderMessageHandler,
  ConfirmOrderRequest,
  RawDraftOrderResponse,
  SubmitDraftOrderMessageHandler,
  SubmitOrderRequest,
} from "./services/draftOrderMessageHandlers.js";
import {
  assertTradingSystemAllowed,
  FALLBACK_GATEWAY_URLS,
  gatewayUrlFor,
  newGatewaySocket,
  TradingSystem,
} from "./tosWebConfig.js";
import {
  FuturesOrderBuilder,
  FuturesOrderIntent,
  FuturesOrderResult,
} from "./futures/futuresOrderBuilder.js";
import SubmitOrderMessageHandler from "./services/submitOrderMessageHandler.js";
import SubscribeToAlertMessageHandler from "./services/subscribeToAlertMessageHandler.js";
import UserPropertiesMessageHandler from "./services/userPropertiesMessageHandler.js";
import WebSocketApiMessageHandler from "./services/webSocketApiMessageHandler.js";
import WorkingOrdersMessageHandler from "./services/workingOrdersMessageHandler.js";
import {
  ParsedPayloadResponse,
  RawPayloadResponse,
  WsJsonRawMessage,
} from "./tdaWsJsonTypes.js";
import {
  Constructor,
  debugLog,
  ensure,
  findByTypeOrThrow,
  throwError,
} from "./util.js";
import { WsJsonClient } from "./wsJsonClient.js";

export const CONNECTION_REQUEST_MESSAGE = {
  ver: "27.*.*",
  fmt: "json-patches-structured",
  heartbeat: "2s",
};

export enum ChannelState {
  DISCONNECTED,
  CONNECTING,
  CONNECTED,
  ERROR,
}

const logger = debug("realWsJsonClient");

const messageHandlers: WebSocketApiMessageHandler<never>[] = [
  new CancelAlertMessageHandler(),
  new CreateAlertMessageHandler(),
  new AlertLookupMessageHandler(),
  new SubscribeToAlertMessageHandler(),
  new OptionQuotesMessageHandler(),
  new CancelOrderMessageHandler(),
  new ChartMessageHandler(),
  new InstrumentSearchMessageHandler(),
  new OptionSeriesMessageHandler(),
  new OptionSeriesQuotesMessageHandler(),
  new OrderEventsMessageHandler(),
  new PlaceOrderMessageHandler(),
  new PositionsMessageHandler(),
  new QuotesMessageHandler(),
  new UserPropertiesMessageHandler(),
  new OptionChainDetailsMessageHandler(),
  new LoginMessageHandler(),
  new SchwabLoginMessageHandler(),
  new SubmitOrderMessageHandler(),
  new MarketDepthMessageHandler(),
  new GetWatchlistMessageHandler(),
  new FutureSeriesMessageHandler(),
  new ConfirmOrderMessageHandler(),
  new SubmitDraftOrderMessageHandler(),
];

export class RealWsJsonClient implements WsJsonClient {
  private readonly genericHandler = new GenericIncomingMessageHandler();
  private buffer = new BufferedIterator<ParsedPayloadResponse>();
  private iterator = new MulticastIterator(this.buffer);
  private state = ChannelState.DISCONNECTED;
  private credentials: {
    authCode?: string;
    accessToken?: string;
    refreshToken?: string;
  } = {};

  private readonly responseParser: ResponseParser;

  constructor(
    private readonly socket = newGatewaySocket(
      FALLBACK_GATEWAY_URLS.papermoney,
    ),
    responseParser?: ResponseParser,
    private readonly clientConfig: {
      tradingSystem?: TradingSystem;
      allowLiveTrading?: boolean;
    } = {},
  ) {
    this.responseParser =
      responseParser ?? new ResponseParser(this.genericHandler);
  }

  /**
   * Creates a client connected to the gateway for the given trading system.
   * Defaults to PaperMoney. LiveTrading requires `{ allowLiveTrading: true }`.
   */
  static async create({
    tradingSystem = "PaperMoney",
    useInstanceB = false,
    allowLiveTrading = false,
    gatewayUrl,
  }: {
    tradingSystem?: TradingSystem;
    useInstanceB?: boolean;
    allowLiveTrading?: boolean;
    /** Explicit gateway URL (e.g. the one captured from the browser session). */
    gatewayUrl?: string;
  } = {}): Promise<RealWsJsonClient> {
    assertTradingSystemAllowed(tradingSystem, allowLiveTrading);
    const url =
      gatewayUrl ?? (await gatewayUrlFor(tradingSystem, { useInstanceB }));
    logger("connecting to %s gateway %s", tradingSystem, url);
    return new RealWsJsonClient(newGatewaySocket(url), undefined, {
      tradingSystem,
      allowLiveTrading,
    });
  }

  futuresOrderBuilder(): FuturesOrderBuilder {
    return new FuturesOrderBuilder(this, {
      tradingSystem: this.clientConfig.tradingSystem ?? "PaperMoney",
      allowLiveTrading: this.clientConfig.allowLiveTrading,
    });
  }

  get accessToken() {
    return this.credentials.accessToken;
  }

  get refreshToken() {
    return this.credentials.refreshToken;
  }

  async authenticateWithAccessToken({
    accessToken,
    refreshToken,
  }: {
    accessToken: string;
    refreshToken: string;
  }): Promise<RawLoginResponseBody | null> {
    ensure(accessToken, "access token is required");
    ensure(refreshToken, "refresh token is required");
    this.credentials = { accessToken, refreshToken };
    return await this.handshake();
  }

  async authenticateWithAuthCode(
    authCode: string,
  ): Promise<RawLoginResponseBody | null> {
    ensure(authCode, "auth code is required");
    this.credentials = { authCode };
    return await this.handshake();
  }

  private async handshake(): Promise<RawLoginResponseBody | null> {
    const { state } = this;
    switch (state) {
      case ChannelState.DISCONNECTED:
        this.buffer = new BufferedIterator<ParsedPayloadResponse>();
        this.iterator = new MulticastIterator(this.buffer);
        this.state = ChannelState.CONNECTING;
        return await this.doConnect();
      case ChannelState.CONNECTING: // no-op
        return Promise.reject("Already connecting");
      case ChannelState.CONNECTED: // no-op
        return Promise.reject("Already connected");
      case ChannelState.ERROR:
        return Promise.reject("Illegal state, ws connection failed previously");
    }
  }
  private doConnect(): Promise<RawLoginResponseBody> {
    const { socket } = this;
    return new Promise((resolve, reject) => {
      if (socket.readyState === WebSocket.OPEN) {
        this.sendMessage(CONNECTION_REQUEST_MESSAGE);
      }
      socket.onopen = () => this.sendMessage(CONNECTION_REQUEST_MESSAGE);
      socket.onclose = (event) =>
        debugLog("connection closed: ", event?.reason);
      socket.onmessage = ({ data }) =>
        this.onMessage(data as string, resolve, reject);
    });
  }

  private onMessage(
    data: string,
    resolve: (value: RawLoginResponseBody) => void,
    reject: (reason?: string) => void,
  ) {
    const { responseParser, buffer } = this;
    const message = JSON.parse(data) as WsJsonRawMessage;
    logger("⬅️\treceived %O", message);
    if (isConnectionResponse(message)) {
      this.authenticate();
    } else if (isLoginResponse(message)) {
      this.handleLoginResponse(message, resolve, reject);
    } else if (isSchwabLoginResponse(message)) {
      this.handleSchwabLoginResponse(message, resolve, reject);
    } else {
      const parsedResponse = responseParser.parseResponse(message);
      if (parsedResponse) {
        parsedResponse.forEach((r) => buffer.emit(r));
      }
    }
  }

  private authenticate() {
    const {
      credentials: { authCode, accessToken },
    } = this;
    if (accessToken) {
      // if we already have an access token, we can just authenticate with it
      const handler = findByTypeOrThrow(messageHandlers, LoginMessageHandler);
      this.sendMessage(handler.buildRequest(accessToken));
    } else if (authCode) {
      // exchange the auth code for an access token
      const handler = findByTypeOrThrow(
        messageHandlers,
        SchwabLoginMessageHandler,
      );
      this.sendMessage(handler.buildRequest(authCode));
    } else {
      throwError("no credentials provided, cannot authenticate");
    }
  }

  isConnected(): boolean {
    const { socket, state } = this;
    return socket !== null && state === ChannelState.CONNECTED;
  }

  isConnecting(): boolean {
    const { socket, state } = this;
    return socket !== null && state === ChannelState.CONNECTING;
  }

  ensureConnected() {
    if (this.state !== ChannelState.CONNECTED) {
      throw new Error("Please call connect() first");
    }
  }

  quotes(symbols: string[]): AsyncIterable<ParsedPayloadResponse> {
    return this.dispatchHandler(QuotesMessageHandler, symbols).iterable();
  }

  accountPositions(
    accountNumber: string,
  ): AsyncIterable<ParsedPayloadResponse> {
    return this.dispatchHandler(
      PositionsMessageHandler,
      accountNumber,
    ).iterable();
  }

  chart(request: ChartRequestParams): AsyncIterable<ParsedPayloadResponse> {
    return this.dispatchHandler(ChartMessageHandler, request).iterable();
  }

  searchInstruments(query: string): Promise<ParsedPayloadResponse> {
    return this.dispatchHandler(InstrumentSearchMessageHandler, {
      query,
    }).promise();
  }

  lookupAlerts(): AsyncIterable<ParsedPayloadResponse> {
    return this.dispatchHandler(
      AlertLookupMessageHandler,
      null as never,
    ).iterable();
  }

  optionChain(symbol: string): Promise<ParsedPayloadResponse> {
    return this.dispatchHandler(OptionSeriesMessageHandler, symbol).promise();
  }

  optionChainQuotes(symbol: string): AsyncIterable<ParsedPayloadResponse> {
    return this.dispatchHandler(
      OptionSeriesQuotesMessageHandler,
      symbol,
    ).iterable();
  }

  optionChainDetails(
    request: OptionChainDetailsRequest,
  ): Promise<ParsedPayloadResponse> {
    return this.dispatchHandler(
      OptionChainDetailsMessageHandler,
      request,
    ).promise();
  }

  optionQuotes(
    request: OptionQuotesRequestParams,
  ): AsyncIterable<ParsedPayloadResponse> {
    return this.dispatchHandler(OptionQuotesMessageHandler, request).iterable();
  }

  async placeOrder(
    request: PlaceLimitOrderRequestParams,
  ): Promise<ParsedPayloadResponse> {
    // 1. place order
    await this.dispatchHandler(PlaceOrderMessageHandler, request).promise();
    // 2. submit order
    // noinspection ES6MissingAwait
    return this.dispatchHandler(SubmitOrderMessageHandler, request).promise();
  }

  replaceOrder(
    request: Required<PlaceLimitOrderRequestParams>,
  ): Promise<ParsedPayloadResponse> {
    return this.dispatchHandler(SubmitOrderMessageHandler, request).promise();
  }

  /** Lists the tradeable contracts for a futures root such as "/MES". */
  async futureSeries(root: string): Promise<RawFutureSeriesItem[]> {
    const req: FutureSeriesRequest = { root };
    const res = await this.dispatchHandler(
      FutureSeriesMessageHandler,
      req,
    ).promise();
    return (res.body as unknown as RawFutureSeriesResponse).series ?? [];
  }

  /** Phase 1 of the order flow: creates/validates a draft on the server. */
  async confirmOrder(
    request: ConfirmOrderRequest,
  ): Promise<RawDraftOrderResponse> {
    const res = await this.dispatchHandler(
      ConfirmOrderMessageHandler,
      request,
    ).promise();
    return res.body as RawDraftOrderResponse;
  }

  /** Phase 2 of the order flow: sends the draft (or replaces a live order). */
  async submitDraftOrder(
    request: SubmitOrderRequest,
  ): Promise<RawDraftOrderResponse> {
    const res = await this.dispatchHandler(
      SubmitDraftOrderMessageHandler,
      request,
    ).promise();
    return res.body as RawDraftOrderResponse;
  }

  /**
   * Places a futures order the way the ToS Web UI does:
   * resolve root -> active contract (future_series), CONFIRM with INIT_STOCK,
   * then SUBMIT with EDIT_ORDER. With `dryRun` (default) it stops after CONFIRM.
   */
  async placeFuturesOrder(
    root: string,
    spec: FuturesOrderIntent,
    { dryRun = true }: { dryRun?: boolean } = {},
  ): Promise<FuturesOrderResult> {
    return this.futuresOrderBuilder().place(root, spec, { dryRun });
  }

  /** Full order-event stream (WORKING/QUEUED/FILLED/CANCELED/FINAL/EXECUTION). */
  orderEvents(accountNumber: string): AsyncIterable<ParsedPayloadResponse> {
    return this.dispatchHandler(
      OrderEventsMessageHandler,
      accountNumber,
    ).iterable();
  }

  workingOrders(accountNumber: string): AsyncIterable<ParsedPayloadResponse> {
    const handler = new WorkingOrdersMessageHandler();
    return this.dispatch(handler, accountNumber).iterable();
  }

  createAlert(
    request: CreateAlertRequestParams,
  ): Promise<ParsedPayloadResponse> {
    return this.dispatchHandler(CreateAlertMessageHandler, request).promise();
  }

  cancelAlert(alertId: number): Promise<ParsedPayloadResponse> {
    return this.dispatchHandler(CancelAlertMessageHandler, alertId).promise();
  }

  cancelOrder(orderId: number): Promise<ParsedPayloadResponse> {
    return this.dispatchHandler(CancelOrderMessageHandler, orderId).promise();
  }

  watchlist(watchlistId: number): Promise<ParsedPayloadResponse> {
    return this.dispatchHandler(
      GetWatchlistMessageHandler,
      watchlistId,
    ).promise();
  }

  userProperties(): Promise<ParsedPayloadResponse> {
    return this.dispatchHandler(
      UserPropertiesMessageHandler,
      null as never,
    ).promise();
  }

  marketDepth(symbol: string): AsyncIterable<ParsedPayloadResponse> {
    return this.dispatchHandler(MarketDepthMessageHandler, symbol).iterable();
  }

  private dispatch<Req>(
    handler: WebSocketApiMessageHandler<Req>,
    args: Req,
  ): Observable<NonNullable<ParsedPayloadResponse>> {
    this.ensureConnected();
    this.sendMessage(handler.buildRequest(args));
    const wantId = handler.requestId?.(args);
    return deferredWrap(() => this.iterator).filter(
      (msg) =>
        msg.service === handler.service &&
        (wantId === undefined || msg.id === undefined || msg.id === wantId),
    ) as Observable<NonNullable<ParsedPayloadResponse>>;
  }

  // eslint-disable-line @typescript-eslint/no-explicit-any
  private sendMessage(data: any) {
    logger("➡️\tsending %O", data);
    const msg = JSON.stringify(data);
    this.socket?.send(msg);
  }

  private handleSchwabLoginResponse(
    message: RawLoginResponse,
    resolve: (value: RawLoginResponseBody) => void,
    reject: (reason?: string) => void,
  ) {
    const handler = findByTypeOrThrow(
      messageHandlers,
      SchwabLoginMessageHandler,
    );
    const loginResponse = handler.parseResponse(message as RawPayloadResponse);
    const [{ body }] = message.payload;
    if (loginResponse.authenticated) {
      this.state = ChannelState.CONNECTED;
      logger("Schwab login successful");
      this.credentials.accessToken = body.token;
      if (loginResponse.refreshToken) {
        this.credentials.refreshToken = loginResponse.refreshToken;
      }
      resolve(body);
    } else {
      this.state = ChannelState.ERROR;
      reject(`Login failed: ${body.message}`);
      this.disconnect();
    }
  }

  private handleLoginResponse(
    message: RawLoginResponse,
    resolve: (value: RawLoginResponseBody) => void,
    reject: (reason?: string) => void,
  ) {
    const handler = findByTypeOrThrow(messageHandlers, LoginMessageHandler);
    const loginResponse = handler.parseResponse(message as RawPayloadResponse);
    const [{ body }] = message.payload;
    if (loginResponse.successful) {
      this.state = ChannelState.CONNECTED;
      resolve(body);
    } else {
      this.state = ChannelState.ERROR;
      reject(`Login failed: ${body.message}`);
      this.disconnect();
    }
  }

  private dispatchHandler<Req>(
    handlerCtor: Constructor<WebSocketApiMessageHandler<Req>>,
    arg: Req,
  ): Observable<NonNullable<ParsedPayloadResponse>> {
    const handler = findByTypeOrThrow(messageHandlers, handlerCtor);
    return this.dispatch(handler, arg);
  }

  disconnect() {
    this.socket?.close();
    this.state = ChannelState.DISCONNECTED;
    // This ensures that listeners will resolve the promise cleanly from any `for await` loops
    this.buffer.end();
  }
}
