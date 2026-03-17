import { Browser, BrowserContext, chromium, Page } from "playwright";
import { config } from "../config";

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

/**
 * Creates a browser session — local Playwright or remote BrowserBase,
 * depending on BROWSER_MODE env var. The caller's code is identical either way.
 */
export async function createBrowserSession(options?: {
  headless?: boolean;
}): Promise<BrowserSession> {
  const headless = options?.headless ?? true;

  let browser: Browser;

  if (config.browserMode === "browserbase") {
    if (!config.browserbaseApiKey || !config.browserbaseProjectId) {
      throw new Error(
        "BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID are required when BROWSER_MODE=browserbase"
      );
    }

    // BrowserBase provides a CDP endpoint — connect Playwright to it
    const wsUrl =
      `wss://connect.browserbase.com?apiKey=${config.browserbaseApiKey}` +
      `&projectId=${config.browserbaseProjectId}`;

    browser = await chromium.connectOverCDP(wsUrl);
  } else {
    browser = await chromium.launch({
      headless,
      args: [
        "--no-sandbox",
        "--disable-blink-features=AutomationControlled",
      ],
    });
  }

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
  });

  // Mask automation fingerprints
  await context.addInitScript(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Object.defineProperty((globalThis as any).navigator, "webdriver", { get: () => undefined });
  });

  const page = await context.newPage();

  return {
    browser,
    context,
    page,
    async close() {
      await context.close();
      await browser.close();
    },
  };
}

/**
 * Human-like delay between actions.
 */
export async function humanDelay(
  minMs = 500,
  maxMs = 1500
): Promise<void> {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  await new Promise((r) => setTimeout(r, delay));
}

/**
 * Type text character by character with human-like timing.
 */
export async function humanType(
  page: Page,
  selector: string,
  text: string
): Promise<void> {
  await page.focus(selector);
  await page.fill(selector, ""); // clear first
  for (const char of text) {
    await page.type(selector, char, { delay: Math.random() * 80 + 30 });
  }
}
