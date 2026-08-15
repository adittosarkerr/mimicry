import type { Browser, BrowserContext, LaunchOptions, Page } from 'playwright';
import { config } from '../config';
import type { Trace } from '@mimic/schema';

/**
 * Where Chromium comes from.
 *
 * On a laptop or a container it is the one Playwright installed, and this whole
 * question never comes up. In a serverless function there is no such Chromium
 * and no way to install one — the filesystem is read-only and the bundle has a
 * size limit — so a build compiled for exactly that runs instead, unpacked into
 * /tmp on first use.
 *
 * Imported dynamically rather than at the top, so a machine that has a real
 * Playwright never loads a 50MB dependency it will not use, and a deployment
 * that has neither still starts and says which one is missing.
 */
const serverless = process.env.MIMIC_SERVERLESS_BROWSER === '1' || Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);

type Launch = (options?: LaunchOptions) => Promise<Browser>;

async function launcher(): Promise<{ launch: Launch; args: string[]; executablePath?: string }> {
  if (!serverless) {
    const { chromium } = await import('playwright');
    return { launch: chromium.launch.bind(chromium) as Launch, args: LAUNCH_ARGS };
  }

  const [{ chromium: core }, sparticuz] = await Promise.all([
    import('playwright-core'),
    import('@sparticuz/chromium'),
  ]);
  const pack = sparticuz.default;

  return {
    launch: core.launch.bind(core) as Launch,
    /* Its own flags first: they are what make Chromium start at all inside a
       function — single process, no /dev/shm, software rendering. Ours are
       about not looking like a robot, which is a separate concern. */
    args: [...pack.args, ...LAUNCH_ARGS.filter((a) => !pack.args.includes(a))],
    executablePath: await pack.executablePath(),
  };
}

/**
 * Browser lifecycle + anti-automation hardening.
 *
 * Headless Chromium announces itself in a dozen small ways. None of these
 * patches defeat a determined bot wall, and they aren't meant to — they stop
 * ordinary sites from serving a degraded page to a legitimate replay of the
 * user's own session.
 */

const REAL_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process,AutomationControlled',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-infobars',
  '--window-size=1440,900',
  '--start-maximized',
];

/** Patches applied before any page script runs. */
const STEALTH_INIT = `
(() => {
  // The dev runner transpiles with esbuild, which decorates named functions
  // with a __name() helper. That helper doesn't exist inside the page, so any
  // function we hand to page.evaluate would throw on entry without this shim.
  if (typeof globalThis.__name !== 'function') {
    globalThis.__name = (fn) => fn;
  }

  // navigator.webdriver is the single most-checked automation tell.
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

  // Headless Chrome reports zero plugins and no languages.
  Object.defineProperty(navigator, 'plugins', {
    get: () => [1, 2, 3, 4, 5].map((i) => ({ name: 'Chrome PDF Plugin ' + i })),
  });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

  // window.chrome exists in real Chrome, not in headless.
  if (!window.chrome) {
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
  }

  // Permissions.query resolves 'denied' for notifications in headless.
  const origQuery = navigator.permissions?.query?.bind(navigator.permissions);
  if (origQuery) {
    navigator.permissions.query = (params) =>
      params && params.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : origQuery(params);
  }

  // WebGL vendor strings give away SwiftShader.
  const getParam = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function (p) {
    if (p === 37445) return 'Intel Inc.';
    if (p === 37446) return 'Intel Iris OpenGL Engine';
    return getParam.apply(this, [p]);
  };
})();
`;

export interface SessionOptions {
  headless?: boolean;
  trace?: Trace;
}

export interface Session {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}

/** A desktop-sized window, whatever the recording claimed. */
function sensibleViewport(recorded?: { width: number; height: number }) {
  const width = recorded?.width && recorded.width >= 1024 ? Math.min(recorded.width, 2560) : 1440;
  const height = recorded?.height && recorded.height >= 600 ? Math.min(recorded.height, 1600) : 900;
  return { width, height };
}

export async function launchSession(opts: SessionOptions = {}): Promise<Session> {
  /* A serverless function has no screen, so "run it visibly" is not an option
     there however firmly it is asked for. Quietly honest beats launching
     something that cannot start. */
  const headless = serverless ? true : (opts.headless ?? config.browser.headless);
  const chrome = await launcher();

  const browser = await chrome.launch({
    headless,
    args: chrome.args,
    executablePath: chrome.executablePath,
    chromiumSandbox: false,
  });

  const context = await browser.newContext({
    /* Never take a nonsense window size from a recording. A hidden iframe
       answering the snapshot request reports 0×0, and a browser context that
       size has no visible elements at all — every scrape off it comes back
       empty or full of fragments, which reads as "the automation is broken"
       rather than "the window had no width". */
    viewport: sensibleViewport(opts.trace?.viewport),
    userAgent: opts.trace?.userAgent || REAL_UA,
    locale: opts.trace?.locale || 'en-US',
    timezoneId: opts.trace?.timezone || 'Asia/Dhaka',
    deviceScaleFactor: 1,
    hasTouch: false,
    isMobile: false,
    javaScriptEnabled: true,
    ignoreHTTPSErrors: true,
    // Some sites gate content on a plausible referer/accept-language pair.
    extraHTTPHeaders: {
      'accept-language': `${opts.trace?.locale || 'en-US'},en;q=0.9`,
      'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    },
  });

  await context.addInitScript(STEALTH_INIT);
  context.setDefaultTimeout(config.browser.stepTimeoutMs);
  context.setDefaultNavigationTimeout(config.browser.stepTimeoutMs + 15_000);

  // Blocking heavy third-party media makes replays markedly faster and does
  // not change what the page renders for the fields we care about.
  await context.route('**/*', (route) => {
    const req = route.request();
    const url = req.url();
    const type = req.resourceType();
    if (type === 'media' || type === 'font') return route.abort();
    if (/googletagmanager|google-analytics|doubleclick|facebook\.net|hotjar|segment\.io|mixpanel|clarity\.ms/i.test(url)) {
      return route.abort();
    }
    return route.continue();
  });

  const page = await context.newPage();

  return {
    browser,
    context,
    page,
    close: async () => {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}

/** Phrases that mean the site is refusing an automated visitor. */
const BOT_WALL = [
  'verify you are human',
  'are you a robot',
  'unusual traffic',
  'access denied',
  'checking your browser',
  'enable javascript and cookies',
  'ddos protection by',
  '请完成安全验证',
  'captcha',
  // Cloudflare's interstitial, which is what most small shops sit behind.
  'performing security verification',
  'just a moment',
  'verifying you are human',
  'checking if the site connection is secure',
  'needs to review the security of your connection',
  'attention required',
];

/**
 * Cloudflare-style interstitials usually clear themselves after a few seconds.
 * Waiting is the difference between "this site blocks bots" and a run that
 * simply started a moment too early.
 */
export async function waitOutChallenge(page: Page, timeoutMs = 25_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let sawChallenge = false;

  while (Date.now() < deadline) {
    const wall = await detectWall(page);
    if (!wall.blocked) return sawChallenge;
    if (wall.kind === 'captcha') return false; // needs a human, waiting won't help

    sawChallenge = true;
    await page.waitForTimeout(1500);
  }
  return false;
}

const LOGIN_WALL = ['sign in to continue', 'log in to continue', 'please log in', 'session expired'];

export interface WallCheck {
  blocked: boolean;
  kind?: 'captcha' | 'bot_wall' | 'login_required';
  evidence?: string;
}

/**
 * Detects the three ways a replay legitimately can't continue on its own.
 * Called after navigations so the run stops with an honest reason instead of
 * timing out on a selector that will never exist.
 */
export async function detectWall(page: Page): Promise<WallCheck> {
  try {
    const [text, title, hasCaptchaFrame] = await Promise.all([
      page.evaluate(() => document.body?.innerText?.slice(0, 4000).toLowerCase() ?? ''),
      page.title().then((t) => t.toLowerCase()).catch(() => ''),
      page
        .locator(
          'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[title*="challenge" i], #challenge-form, .cf-turnstile',
        )
        .count()
        .then((n) => n > 0)
        .catch(() => false),
    ]);

    if (hasCaptchaFrame) {
      return { blocked: true, kind: 'captcha', evidence: 'A CAPTCHA challenge is on the page.' };
    }

    const haystack = `${title} ${text}`;
    const hit = BOT_WALL.find((p) => haystack.includes(p));
    if (hit) return { blocked: true, kind: hit === 'captcha' ? 'captcha' : 'bot_wall', evidence: hit };

    const login = LOGIN_WALL.find((p) => haystack.includes(p));
    if (login) return { blocked: true, kind: 'login_required', evidence: login };

    return { blocked: false };
  } catch {
    return { blocked: false };
  }
}

/** Waits for the page to stop changing — more reliable than networkidle on SPAs. */
export async function settle(page: Page, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: Math.min(timeoutMs, 5000) });
  } catch {
    /* already loaded */
  }

  let lastSize = -1;
  let stableFor = 0;
  while (Date.now() < deadline) {
    const size = await page.evaluate(() => document.body?.innerHTML.length ?? 0).catch(() => -1);
    if (size === lastSize) {
      stableFor += 250;
      if (stableFor >= 750) return;
    } else {
      stableFor = 0;
      lastSize = size;
    }
    await page.waitForTimeout(250);
  }
}
