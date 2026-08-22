import WebSocket from "isomorphic-ws";

/**
 * Runtime configuration published by the thinkorswim Web SPA.
 * Source: GET https://trade.thinkorswim.com/v1/api/config (unauthenticated),
 * loaded by the SPA's `gs()` helper before it opens the service-gateway socket.
 */
export type TosWebConfig = {
  serviceGatewayUrlsSchwab: {
    livetradingA: string;
    livetradingB: string;
    papermoney: string;
  };
  lmsAuthUrl: string;
  schwabSsoUrl?: string;
  region?: string;
};

export type TradingSystem = "LiveTrading" | "PaperMoney";

export const TOS_WEB_ORIGIN = "https://trade.thinkorswim.com";
export const TOS_WEB_CONFIG_URL = `${TOS_WEB_ORIGIN}/v1/api/config`;

/** Values observed on 2026-08-22; used only if the config endpoint is unreachable. */
export const FALLBACK_GATEWAY_URLS: TosWebConfig["serviceGatewayUrlsSchwab"] = {
  livetradingA: "wss://thinkorswim-services.schwab.com/Services/WsJson",
  livetradingB:
    "wss://thinkorswim-services-b.tos-prd.prd.gcp.schwabcloud.com/Services/WsJson",
  papermoney: "wss://papermoney-services.schwab.com/Services/WsJson",
};

export async function fetchTosWebConfig(
  fetchImpl: typeof fetch = fetch,
): Promise<TosWebConfig> {
  const res = await fetchImpl(TOS_WEB_CONFIG_URL, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`config fetch failed: HTTP ${res.status}`);
  }
  return (await res.json()) as TosWebConfig;
}

export class LiveTradingDisabledError extends Error {
  constructor() {
    super(
      "LiveTrading is disabled. Pass { allowLiveTrading: true } to enable live routing.",
    );
    this.name = "LiveTradingDisabledError";
  }
}

export function assertTradingSystemAllowed(
  tradingSystem: TradingSystem,
  allowLiveTrading?: boolean,
): void {
  if (tradingSystem === "LiveTrading" && allowLiveTrading !== true) {
    throw new LiveTradingDisabledError();
  }
}

export function resolveGatewayUrl(
  tradingSystem: TradingSystem,
  urls: TosWebConfig["serviceGatewayUrlsSchwab"] = FALLBACK_GATEWAY_URLS,
  { useInstanceB = false }: { useInstanceB?: boolean } = {},
): string {
  switch (tradingSystem) {
    case "PaperMoney":
      return urls.papermoney;
    case "LiveTrading":
      return useInstanceB ? urls.livetradingB : urls.livetradingA;
  }
}

/** Opens a WebSocket with the same headers the ToS Web SPA sends. */
export function newGatewaySocket(url: string): WebSocket {
  return new WebSocket(url, {
    headers: {
      Pragma: "no-cache",
      Origin: TOS_WEB_ORIGIN,
      Upgrade: "websocket",
      "Cache-Control": "no-cache",
      Connection: "Upgrade",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Extensions": "permessage-deflate; client_max_window_bits",
    },
  });
}

/**
 * Resolves the gateway URL for a trading system, preferring the live config
 * endpoint and falling back to the last known values.
 */
export async function gatewayUrlFor(
  tradingSystem: TradingSystem,
  opts: { useInstanceB?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<string> {
  let urls = FALLBACK_GATEWAY_URLS;
  try {
    urls = (await fetchTosWebConfig(opts.fetchImpl)).serviceGatewayUrlsSchwab;
  } catch {
    // keep fallback
  }
  return resolveGatewayUrl(tradingSystem, urls, opts);
}
