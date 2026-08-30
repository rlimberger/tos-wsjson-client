import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { PuppeteerExtra } from "puppeteer-extra";

export async function getAuthCode(username?: string, password?: string) {
  (puppeteer as unknown as PuppeteerExtra).use(StealthPlugin());

  const browser = await (puppeteer as unknown as PuppeteerExtra).launch({
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    userDataDir: "./puppeteer-data",
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    );
    await page.setViewport({ width: 800, height: 650 });
    await page.setRequestInterception(true);

    console.log(
      "Please log in manually. The script will watch for the final redirect URL.",
    );

    const authCodePromise = new Promise<string>((resolve, reject) => {
      page.on("request", (request) => {
        const requestUrl = request.url();
        if (requestUrl.includes("trade.thinkorswim.com/oauth?code=")) {
          const authCode = new URL(requestUrl).searchParams.get("code");
          void request.abort();
          if (authCode) {
            console.log("OAuth code captured. Closing the login window.");
            resolve(authCode);
          } else {
            reject(new Error("The OAuth redirect did not include a code."));
          }
          return;
        }
        void request.continue();
      });
      browser.on("disconnected", () => {
        reject(new Error("The login window closed before OAuth completed."));
      });
    });

    await page.goto("https://trade.thinkorswim.com/", {
      waitUntil: "networkidle2",
    });
    await page.reload({ waitUntil: "networkidle2" });
    if (username && password) {
      // add a random delay between 2-4 seconds
      await new Promise((resolve) => setTimeout(resolve, randomDelay(2, 4)));
      let frames = page.frames();
      let targetFrame = frames.find((frame) =>
        frame.url().includes("sws-gateway-nr.thinkorswim.com"),
      );
      if (!targetFrame) {
        throw new Error("Target frame not found");
      }
      const loginIdInput = await targetFrame.$("#loginIdInput");
      if (!loginIdInput) {
        throw new Error("Login ID input not found");
      }
      await loginIdInput.type(username, { delay: 100 });
      await new Promise((resolve) => setTimeout(resolve, randomDelay(1, 2)));
      let continueBtn = await targetFrame.$("#continueBtn");
      if (!continueBtn) {
        throw new Error("Continue button not found");
      }
      await continueBtn.click();
      await new Promise((resolve) => setTimeout(resolve, randomDelay(2, 4)));
      frames = page.frames();
      targetFrame = frames.find((frame) =>
        frame.url().includes("sws-gateway-nr.thinkorswim.com"),
      );
      if (!targetFrame) {
        throw new Error("Target frame not found");
      }
      const passwordInput = await targetFrame.$("#passwordInput");
      if (!passwordInput) {
        throw new Error("Password input not found");
      }
      await passwordInput.type(password, { delay: 100 });
      continueBtn = await targetFrame.$("#continueBtn");
      if (!continueBtn) {
        throw new Error("Continue button not found");
      }
      await continueBtn.click();
    }
    return await authCodePromise;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

function randomDelay(minSeconds: number, maxSeconds: number): number {
  return (
    Math.floor(Math.random() * (maxSeconds - minSeconds) * 1000) +
    minSeconds * 1000
  );
}
