const chromium = require("@sparticuz/chromium");
const { chromium: playwright } = require("playwright-core");

exports.handler = async (event) => {
  const body = JSON.parse(event.body || "{}");
  const { url, waitMs = 4000, evalExpr, useProxy, secret } = body;

  if (!secret || secret !== process.env.SCRAPER_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: "unauthorized" }) };
  }

  // ── Fetch-only mode: plain HTTP request, no Chrome ──────────────────────────
  // Used to proxy API calls from Lambda IPs (different from Supabase/Cloudflare).
  // fetchHeaders allows custom request headers (e.g. OT restref API headers).
  if (body.fetchOnly) {
    try {
      const resp = await fetch(url, {
        headers: body.fetchHeaders || {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "application/json, text/javascript, */*; q=0.01",
          "Referer": "https://www.opentable.com/",
          "Accept-Language": "en-US,en;q=0.9",
          "X-Requested-With": "XMLHttpRequest",
        },
        signal: AbortSignal.timeout(10000),
      });
      const text = await resp.text();
      return { statusCode: 200, body: JSON.stringify({ content: text, httpStatus: resp.status }) };
    } catch (err) {
      return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ── Browser mode: full headless Chrome ──────────────────────────────────────
  // Always force HTTP/1.1 (--disable-http2): Akamai rejects HTTP/2 from cloud IPs
  // but accepts HTTP/1.1 connections. Trust proxy certificates when proxy is active.
  const proxyArgs = (useProxy && process.env.PROXY_URL)
    ? [
        "--ignore-certificate-errors",
        "--ignore-certificate-errors-spki-list",
      ]
    : [];

  const launchOptions = {
    args: [
      ...chromium.args,
      "--disable-web-security",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-http2",  // always: forces HTTP/1.1 which Akamai accepts vs HTTP/2 which it RSTs
      ...proxyArgs,
    ],
    executablePath: await chromium.executablePath(),
    // chromium.headless may be a string ("new"/"shell") in some versions — Playwright needs a boolean
    headless: chromium.headless === false ? false : true,
  };

  if (useProxy && process.env.PROXY_URL) {
    launchOptions.proxy = {
      server:   process.env.PROXY_URL,
      username: process.env.PROXY_USER || undefined,
      password: process.env.PROXY_PASS || undefined,
    };
  }

  const browser = await playwright.launch(launchOptions);
  const page    = await browser.newPage();

  // Make the headless browser look like a real user
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 50000 });
    await page.waitForTimeout(waitMs);

    const content = evalExpr
      ? await page.evaluate(evalExpr)
      : await page.evaluate(() => document.body.innerText);

    return {
      statusCode: 200,
      body: JSON.stringify({ content: String(content ?? "") }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  } finally {
    await browser.close();
  }
};
