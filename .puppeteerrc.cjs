const { existsSync } = require("fs");

// The browser login drives a real, already-installed Chrome (see
// src/example/browserSession.ts), so downloading Puppeteer's own ~200MB build
// during `yarn install` is wasted work — and when that download fails behind a
// proxy or offline it takes the whole install down with it, leaving no dist/.
// Only fall back to downloading when the machine has no usable browser.
const SYSTEM_BROWSERS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

const found =
  process.env.PUPPETEER_EXECUTABLE_PATH || SYSTEM_BROWSERS.find(existsSync);

module.exports = { skipDownload: Boolean(found) };
