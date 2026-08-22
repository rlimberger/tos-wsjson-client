/**
 * Interactive browser login for thinkorswim Web.
 *
 * Opens a real (headful) Chrome with a persistent profile, lets you log in
 * normally (password, MFA, device trust), and passively captures what the
 * client needs from the SPA's own WebSocket traffic via the DevTools protocol:
 *
 *   - the service-gateway URL the SPA connected to (live A/B or papermoney)
 *   - the `login/schwab` / `login` response: access token + refresh token
 *   - `user_properties`: default account code
 *
 * Nothing is typed into the page and no request is intercepted or aborted, so
 * the flow is exactly what Schwab sees from a normal user.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import type { Browser, CDPSession, Page } from "puppeteer";
import puppeteer from "puppeteer-extra";
import type { PuppeteerExtra } from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import {
  gatewayUrlFor,
  TOS_WEB_ORIGIN,
  TradingSystem,
} from "../client/tosWebConfig.js";

export type BrowserSession = {
  tradingSystem: TradingSystem;
  gatewayUrl: string;
  accessToken: string;
  refreshToken?: string;
  accountCode?: string;
  userCode?: string;
};

export type CaptureOptions = {
  /** Which trading system you want a session for. Default: PaperMoney. */
  tradingSystem?: TradingSystem;
  /** Keep Chrome open after capture (default: close it, so only one client uses the token). */
  keepBrowser?: boolean;
  /** Give up after this many ms (default 10 minutes). */
  timeoutMs?: number;
  userDataDir?: string;
  log?: (msg: string) => void;
};

type Frame = {
  header?: { service?: string; id?: string; type?: string };
  body?: any;
};

function tradingSystemOf(url: string): TradingSystem {
  return /papermoney/i.test(url) ? "PaperMoney" : "LiveTrading";
}

function parsePayload(data: string): Frame[] {
  try {
    const msg = JSON.parse(data);
    return Array.isArray(msg?.payload) ? (msg.payload as Frame[]) : [];
  } catch {
    return [];
  }
}

export async function captureBrowserSession({
  tradingSystem = "PaperMoney",
  keepBrowser = false,
  timeoutMs = 10 * 60 * 1000,
  userDataDir = "./puppeteer-data",
  log = (m) => console.log(m),
}: CaptureOptions = {}): Promise<BrowserSession> {
  const pp = puppeteer as unknown as PuppeteerExtra;
  pp.use(StealthPlugin());
  const executablePath =
    process.env.PUPPETEER_EXECUTABLE_PATH ??
    [
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
    ].find((p) => existsSync(p));
  const browser: Browser = await pp.launch({
    executablePath,
    headless: false,
    defaultViewport: null,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--window-size=1280,900",
    ],
    userDataDir,
  });

  // Track every socket the SPA opens; the SPA re-logs-in on a new socket when
  // you switch between live and paperMoney.
  const sessionsBySocket = new Map<string, Partial<BrowserSession>>();

  const attach = async (page: Page) => {
    const cdp: CDPSession = await page.createCDPSession();
    await cdp.send("Network.enable");
    cdp.on("Network.webSocketCreated", ({ requestId, url }) => {
      if (!url.includes("/Services/WsJson")) return;
      sessionsBySocket.set(requestId, {
        gatewayUrl: url,
        tradingSystem: tradingSystemOf(url),
      });
      log(`↔ SPA opened gateway socket: ${url} (${tradingSystemOf(url)})`);
    });
    cdp.on("Network.webSocketFrameReceived", ({ requestId, response }) => {
      const s = sessionsBySocket.get(requestId);
      if (!s) return;
      for (const f of parsePayload(response.payloadData)) {
        const svc = f.header?.service;
        if ((svc === "login/schwab" || svc === "login") && f.body?.token) {
          s.accessToken = f.body.token as string;
          s.refreshToken = f.body.accessTokenInfo?.refreshToken;
          s.userCode = f.body.userCode;
          log(`✓ captured ${svc} token on ${s.tradingSystem} socket`);
        } else if (svc === "user_properties" && f.body?.defaultAccountCode) {
          s.accountCode = String(f.body.defaultAccountCode);
          log(`✓ account ${s.accountCode}`);
        }
      }
    });
  };

  const page = (await browser.pages())[0] ?? (await browser.newPage());
  await attach(page);
  browser.on("targetcreated", async (t) => {
    const p = await t.page();
    if (p) await attach(p).catch(() => undefined);
  });

  log(`Opening ${TOS_WEB_ORIGIN} — log in as usual.`);
  if (tradingSystem === "PaperMoney") {
    log(
      "Wanted: PaperMoney. If the UI lands in live trading, use the account-menu toggle to switch to paperMoney.",
    );
  }
  await page.goto(`${TOS_WEB_ORIGIN}/`, { waitUntil: "domcontentloaded" });

  // Primary source: the SPA persists its session in sessionStorage
  // (`token`, `tradingSystem`) right after a successful login/schwab or login.
  const readStorage = async (): Promise<
    { token?: string; tradingSystem?: string; url: string } | undefined
  > => {
    for (const p of await browser.pages()) {
      try {
        if (!p.url().startsWith(TOS_WEB_ORIGIN)) continue;
        const r = await p.evaluate(() => ({
          token: sessionStorage.getItem("token") ?? undefined,
          tradingSystem: sessionStorage.getItem("tradingSystem") ?? undefined,
          url: location.href,
        }));
        if (r.token) return r;
      } catch {
        /* page navigating */
      }
    }
    return undefined;
  };

  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";
  const status = (m: string) => {
    if (m !== lastStatus) {
      lastStatus = m;
      log(m);
    }
  };
  for (;;) {
    // 1) sniffed socket session (has everything)
    const sniffed = [...sessionsBySocket.values()].find(
      (s) => s.tradingSystem === tradingSystem && s.accessToken,
    );
    // 2) sessionStorage session (token + trading system)
    const stored = await readStorage();
    const storedSystem = stored?.tradingSystem as TradingSystem | undefined;

    let result: BrowserSession | undefined;
    if (sniffed) {
      result = sniffed as BrowserSession;
    } else if (stored?.token && storedSystem === tradingSystem) {
      result = {
        tradingSystem,
        gatewayUrl: await gatewayUrlFor(tradingSystem),
        accessToken: stored.token,
      };
    }
    if (result) {
      log(
        `✓ ${tradingSystem} session captured via ${sniffed ? "websocket" : "sessionStorage"}` +
          (result.accountCode ? ` (account ${result.accountCode})` : ""),
      );
      if (!keepBrowser) {
        log("Closing the browser so this token has a single consumer.");
        await browser.close();
      }
      return result;
    }

    if (stored?.token) {
      status(
        `Logged in (${storedSystem ?? "unknown system"}); waiting for the UI to be in ${tradingSystem}… ` +
          `(switch via the account menu)`,
      );
    } else {
      const pages = await browser.pages();
      status(`Waiting for login… (${pages.map((p) => p.url()).join(" | ")})`);
    }
    if (Date.now() > deadline) {
      if (!keepBrowser) await browser.close();
      throw new Error(`timed out waiting for a ${tradingSystem} session`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

const ENV_KEYS: Record<keyof BrowserSession, string> = {
  tradingSystem: "TOS_TRADING_SYSTEM",
  gatewayUrl: "TOS_GATEWAY_URL",
  accessToken: "TOS_ACCESS_TOKEN",
  refreshToken: "TOS_REFRESH_TOKEN",
  accountCode: "TOS_ACCOUNT_CODE",
  userCode: "TOS_USER_CODE",
};

export function saveSessionToDotEnv(session: BrowserSession, envPath = ".env") {
  const keys = new Set(Object.values(ENV_KEYS));
  const existing = existsSync(envPath)
    ? readFileSync(envPath, "utf-8")
        .split("\n")
        .filter((l) => !keys.has(l.split("=")[0]))
        .join("\n")
        .trim()
    : "";
  const lines = (Object.keys(ENV_KEYS) as (keyof BrowserSession)[])
    .filter((k) => session[k] !== undefined)
    .map((k) => `${ENV_KEYS[k]}=${session[k]}`);
  writeFileSync(
    envPath,
    (existing ? existing + "\n" : "") + lines.join("\n") + "\n",
  );
}

export function sessionFromEnv(env = process.env): BrowserSession | undefined {
  if (!env.TOS_ACCESS_TOKEN || !env.TOS_GATEWAY_URL) return undefined;
  return {
    tradingSystem:
      (env.TOS_TRADING_SYSTEM as TradingSystem) ??
      tradingSystemOf(env.TOS_GATEWAY_URL),
    gatewayUrl: env.TOS_GATEWAY_URL,
    accessToken: env.TOS_ACCESS_TOKEN,
    refreshToken: env.TOS_REFRESH_TOKEN,
    accountCode: env.TOS_ACCOUNT_CODE,
    userCode: env.TOS_USER_CODE,
  };
}

// Standalone: `node dist/example/browserSession.js [PaperMoney|LiveTrading]`
if (process.argv[1]?.endsWith("browserSession.js")) {
  captureBrowserSession({
    tradingSystem: (process.argv[2] as TradingSystem) ?? "PaperMoney",
  })
    .then((s) => {
      saveSessionToDotEnv(s);
      console.log("saved to .env:", {
        ...s,
        accessToken: "…",
        refreshToken: s.refreshToken ? "…" : undefined,
      });
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
