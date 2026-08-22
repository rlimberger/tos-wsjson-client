import {
  RealWsJsonClient,
  CONNECTION_REQUEST_MESSAGE,
  ConnectionEvent,
} from "../../client/realWsJsonClient";
import LoginMessageHandler from "../../client/services/loginMessageHandler";
import WS from "jest-websocket-mock";

const accessToken = "something-secret";
const refreshToken = "something-secret-refresh";
const fakeConnectionResponse = {
  session: "17a7_7115011e1b4a8c9c",
  build: "27.2323.3-B0",
  ver: "27.*.*",
};
const fakeLoginResponse = {
  payload: [
    {
      header: { service: "login", id: "login", ver: 0, type: "snapshot" },
      body: {
        authenticationStatus: "OK",
        authenticated: true,
        forceLogout: false,
        stalePassword: false,
        userDomain: "TDA",
        userSegment: "ADVNCED",
        userId: 1,
        userCdi: "A0",
        userCode: "foo",
        token: "tok",
        schwabAccountMigrationValue: "REMAIN_ON_TDA",
        permissions: {},
        quotePermissions: [],
      },
    },
  ],
};

async function loginOn(url: string) {
  const events: ConnectionEvent[] = [];
  const server = new WS(url, { jsonProtocol: true });
  const client = new RealWsJsonClient(new WebSocket(url), undefined, {
    gatewayUrl: url,
    watchdog: {
      heartbeatTimeoutMs: 80,
      reconnectDelayMs: 20,
      maxReconnectAttempts: 2,
      onConnectionEvent: (e) => events.push(e),
    },
  });
  await server.connected;
  const auth = client.authenticateWithAccessToken({
    accessToken,
    refreshToken,
  });
  server.send(fakeConnectionResponse);
  server.send(fakeLoginResponse);
  await expect(server).toReceiveMessage(CONNECTION_REQUEST_MESSAGE);
  await expect(server).toReceiveMessage(
    new LoginMessageHandler().buildRequest(accessToken),
  );
  await auth;
  return { server, client, events };
}

describe("heartbeat watchdog", () => {
  afterEach(() => {
    jest.useRealTimers();
    try {
      WS.clean();
    } catch {
      /* mock-socket can throw if a client already closed */
    }
  });

  it("counts heartbeats as liveness and starts after login", async () => {
    const { server, client } = await loginOn("ws://localhost:2341");
    try {
      expect(client.isConnected()).toBe(true);
      expect(client.secondsSinceLastMessage).toBeGreaterThanOrEqual(0);
      server.send({ heartbeat: Date.now() });
      expect(client.secondsSinceLastMessage).toBeLessThan(1);
    } finally {
      client.disconnect();
    }
  });

  it("emits reconnecting after silence", async () => {
    jest.useFakeTimers({ advanceTimers: true });
    const { client, events } = await loginOn("ws://localhost:2342");
    try {
      await jest.advanceTimersByTimeAsync(120);
      expect(events.some((e) => e.type === "reconnecting")).toBe(true);
    } finally {
      jest.useRealTimers();
      client.disconnect();
    }
  });

  it("does not reconnect after an intentional disconnect", async () => {
    jest.useFakeTimers({ advanceTimers: true });
    const { client, events } = await loginOn("ws://localhost:2343");
    try {
      client.disconnect();
      await jest.advanceTimersByTimeAsync(500);
      expect(events.some((e) => e.type === "reconnecting")).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});
