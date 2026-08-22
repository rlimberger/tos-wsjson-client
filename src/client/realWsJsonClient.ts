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
import AccountsMessageHandler, {
  accountCodeOf,
  RawAccountItem,
  RawAccountsResponse,
} from "./services/accountsMessageHandler.js";
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
  RawPayloadRequest,
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

/** Services whose requests are long-lived subscriptions and are safe to replay
 *  after a reconnect. Order-placing services are deliberately excluded. */
const REPLAYABLE_SERVICES: ReadonlySet<string> = new Set([
  "quotes",
  "quotes/options",
  "positions",
  "order_events",
  "chart",
  "market_depth",
  "optionSeries/quotes",
  "alerts/subscribe",
]);

export type ConnectionEvent =
  | { type: "connected"; reconnected: boolean }
  | { type: "disconnected"; reason?: string }
  | { type: "reconnecting"; attempt: number; delayMs: number }
  | { type: "gaveUp"; attempts: number };

export type WatchdogOptions = {
  /** Reconnect when no frame (heartbeat included) arrives for this long. The
   *  gateway sends a heartbeat every ~2s, so 30s mirrors the ToS web UI. */
  heartbeatTimeoutMs?: number;
  /** Attempts before giving up (ToS web uses 3). 0 disables auto-reconnect. */
  maxReconnectAttempts?: number;
  /** Fixed backoff instead of the ToS web-like random 10-20s (useful in tests). */
  reconnectDelayMs?: number;
  onConnectionEvent?: (event: ConnectionEvent) => void;
};

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
  new AccountsMessageHandler(),
  new ConfirmOrderMessageHandler(),
  new SubmitDraftOrderMessageHandler(),
];

export class RealWsJsonClient implements WsJsonClient {
  private readonly genericHandler = new GenericIncomingMessageHandler();
  private buffer = new BufferedIterator<ParsedPayloadResponse>();
  private iterator = new MulticastIterator(this.buffer);
  private state = ChannelState.DISCONNECTED;
  private bufferEnded = false;
  private lastMessageAt = 0;
  private watchdogTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempts = 0;
  private reconnecting = false;
  private closingIntentionally = false;
  /** Streaming requests to replay after a reconnect, keyed by header id. */
  private readonly activeSubscriptions = new Map<string, RawPayloadRequest>();
  private credentials: {
    authCode?: string;
    accessToken?: string;
    refreshToken?: string;
  } = {};

  private readonly responseParser: ResponseParser;

  constructor(
    private socket = newGatewaySocket(FALLBACK_GATEWAY_URLS.papermoney),
    responseParser?: ResponseParser,
    private readonly clientConfig: {
      tradingSystem?: TradingSystem;
      allowLiveTrading?: boolean;
      /** Enables reconnects: the watchdog rebuilds the socket from this URL. */
      gatewayUrl?: string;
      watchdog?: WatchdogOptions;
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
    watchdog,
  }: {
    tradingSystem?: TradingSystem;
    useInstanceB?: boolean;
    allowLiveTrading?: boolean;
    /** Explicit gateway URL (e.g. the one captured from the browser session). */
    gatewayUrl?: string;
    watchdog?: WatchdogOptions;
  } = {}): Promise<RealWsJsonClient> {
    assertTradingSystemAllowed(tradingSystem, allowLiveTrading);
    const url =
      gatewayUrl ?? (await gatewayUrlFor(tradingSystem, { useInstanceB }));
    logger("connecting to %s gateway %s", tradingSystem, url);
    return new RealWsJsonClient(newGatewaySocket(url), undefined, {
      tradingSystem,
      allowLiveTrading,
      gatewayUrl: url,
      watchdog,
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
        this.bufferEnded = false;
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
    return new Promise((resolve, reject) => this.wireSocket(resolve, reject));
  }

  private wireSocket(
    resolve: (value: RawLoginResponseBody) => void,
    reject: (reason?: string) => void,
  ) {
    const { socket } = this;
    if (socket.readyState === WebSocket.OPEN) {
      this.sendMessage(CONNECTION_REQUEST_MESSAGE);
    }
    socket.onopen = () => this.sendMessage(CONNECTION_REQUEST_MESSAGE);
    socket.onclose = (event) => {
      debugLog("connection closed: ", event?.reason);
      this.emitConnectionEvent({ type: "disconnected", reason: event?.reason });
      if (!this.closingIntentionally) this.scheduleReconnect();
    };
    socket.onmessage = ({ data }) =>
      this.onMessage(data as string, resolve, reject);
  }

  private onMessage(
    data: string,
    resolve: (value: RawLoginResponseBody) => void,
    reject: (reason?: string) => void,
  ) {
    const { responseParser, buffer } = this;
    this.lastMessageAt = Date.now();
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
      if (parsedResponse && !this.bufferEnded) {
        // frames can still arrive after disconnect(); dropping them is correct
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

  /** Lists the accounts on the connected (live or paper) session. */
  async accounts(): Promise<RawAccountItem[]> {
    const res = await this.dispatchHandler(
      AccountsMessageHandler,
      undefined as void,
    ).promise();
    return (res.body as unknown as RawAccountsResponse).items ?? [];
  }

  /**
   * Best-effort account code for placing orders: user_properties.defaultAccountCode
   * if present, else the first account from the `accounts` service.
   */
  async resolveAccountCode(): Promise<string | undefined> {
    const props = await this.userProperties();
    const fromProps = props.body.defaultAccountCode;
    if (fromProps) return String(fromProps);
    const accts = await this.accounts();
    return accts.map(accountCodeOf).find((c) => !!c);
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
    const request = handler.buildRequest(args);
    if (REPLAYABLE_SERVICES.has(handler.service)) {
      const id = request.payload[0]?.header?.id;
      if (id) this.activeSubscriptions.set(id, request);
    }
    this.sendMessage(request);
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
      this.onConnected();
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

  /** Fires on every successful login, including after a reconnect. */
  private onConnected() {
    const reconnected = this.reconnecting;
    this.reconnecting = false;
    this.reconnectAttempts = 0;
    this.lastMessageAt = Date.now();
    this.startWatchdog();
    this.emitConnectionEvent({ type: "connected", reconnected });
    if (reconnected) this.replaySubscriptions();
  }

  private emitConnectionEvent(event: ConnectionEvent) {
    logger("connection event %O", event);
    this.clientConfig.watchdog?.onConnectionEvent?.(event);
  }

  private get heartbeatTimeoutMs(): number {
    return this.clientConfig.watchdog?.heartbeatTimeoutMs ?? 30_000;
  }

  private get maxReconnectAttempts(): number {
    return this.clientConfig.watchdog?.maxReconnectAttempts ?? 3;
  }

  /**
   * The gateway sends `{"heartbeat": <ms>}` about every 2s. If nothing arrives
   * for `heartbeatTimeoutMs` the socket is considered dead and we reconnect —
   * same policy as the ToS web UI (30s silence, <=3 attempts, 10-20s backoff).
   */
  private startWatchdog() {
    if (this.watchdogTimer || this.maxReconnectAttempts === 0) return;
    this.watchdogTimer = setInterval(() => {
      if (this.state !== ChannelState.CONNECTED || this.reconnecting) return;
      const silentFor = Date.now() - this.lastMessageAt;
      if (silentFor > this.heartbeatTimeoutMs) {
        logger("no frames for %dms, reconnecting", silentFor);
        this.scheduleReconnect();
      }
    }, 5_000);
    this.watchdogTimer.unref?.();
  }

  private stopWatchdog() {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = undefined;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  /** Milliseconds to wait before attempt N (ToS web: random 10-20s). */
  private reconnectDelayMs(): number {
    return (
      this.clientConfig.watchdog?.reconnectDelayMs ??
      10_000 + Math.floor(Math.random() * 10_000)
    );
  }

  private scheduleReconnect() {
    const { gatewayUrl } = this.clientConfig;
    if (
      this.reconnecting ||
      this.bufferEnded ||
      this.closingIntentionally ||
      this.maxReconnectAttempts === 0
    ) {
      return;
    }
    if (!gatewayUrl) {
      logger("no gatewayUrl configured; cannot reconnect");
      return;
    }
    if (!this.credentials.accessToken) {
      logger("no access token; cannot reconnect");
      return;
    }
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.state = ChannelState.ERROR;
      this.stopWatchdog();
      this.emitConnectionEvent({
        type: "gaveUp",
        attempts: this.reconnectAttempts,
      });
      return;
    }
    this.reconnecting = true;
    this.reconnectAttempts += 1;
    const delayMs = this.reconnectDelayMs();
    this.emitConnectionEvent({
      type: "reconnecting",
      attempt: this.reconnectAttempts,
      delayMs,
    });
    this.reconnectTimer = setTimeout(
      () => this.doReconnect(gatewayUrl),
      delayMs,
    );
    this.reconnectTimer.unref?.();
  }

  private doReconnect(gatewayUrl: string) {
    try {
      this.socket?.close();
    } catch {
      /* already closed */
    }
    this.state = ChannelState.CONNECTING;
    this.socket = newGatewaySocket(gatewayUrl);
    // Keep the existing buffer so consumers' `for await` loops survive.
    this.wireSocket(
      () => logger("reconnected and re-authenticated"),
      (reason) => {
        logger("reconnect login failed: %s", reason);
        this.reconnecting = false;
        this.scheduleReconnect();
      },
    );
  }

  private replaySubscriptions() {
    for (const [id, request] of this.activeSubscriptions) {
      logger("replaying subscription %s", id);
      this.sendMessage(request);
    }
  }

  /** Seconds since the last frame from the gateway (heartbeats included). */
  get secondsSinceLastMessage(): number {
    return this.lastMessageAt ? (Date.now() - this.lastMessageAt) / 1000 : -1;
  }

  disconnect() {
    if (this.bufferEnded) return;
    this.bufferEnded = true;
    this.closingIntentionally = true;
    this.stopWatchdog();
    this.activeSubscriptions.clear();
    this.socket?.close();
    this.state = ChannelState.DISCONNECTED;
    // This ensures that listeners will resolve the promise cleanly from any `for await` loops
    this.buffer.end();
  }
}
