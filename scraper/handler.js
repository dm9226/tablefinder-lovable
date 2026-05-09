const chromium = require("@sparticuz/chromium");
const { chromium: playwright } = require("playwright-core");

exports.handler = async (event) => {
  const body = JSON.parse(event.body || "{}");
  const { url, waitMs = 4000, evalExpr, useProxy, secret } = body;

  if (!secret || secret !== process.env.SCRAPER_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: "unauthorized" }) };
  }

  const launchOptions = {
    args: [
      ...chromium.args,
      "--disable-web-security",
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ],
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
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
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
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
