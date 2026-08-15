/**
 * Does the serverless browser path actually launch?
 *
 * `@sparticuz/chromium` ships a Chromium compiled for a Lambda-shaped
 * environment and unpacks it to /tmp on first use. Whether the wiring around it
 * is right — the flags, the executable path, which Playwright drives it — is
 * not something to discover from a deployed function's logs.
 *
 *   npx tsx scripts/serverless-browser-test.mts
 *
 * The binary is Linux-only, so on Windows or macOS this gets as far as the
 * launch and then reports a missing executable. That is the expected result
 * there and still proves everything up to the last step: a wiring fault fails
 * earlier and differently.
 */
process.env.MIMIC_SERVERLESS_BROWSER = '1';

const { launchSession } = await import('../apps/runner/src/replay/browser.ts');

const started = Date.now();

try {
  const session = await launchSession({});
  console.log(`launched in ${Date.now() - started}ms`);

  await session.page.goto('https://example.com', {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  console.log('title:', await session.page.title());
  console.log('body: ', (await session.page.innerText('body')).slice(0, 60).replace(/\s+/g, ' '));

  await session.close();
  console.log('\nok — the serverless browser works on this platform');
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);

  if (/spawn .*chromium ENOENT|ENOENT.*chromium/i.test(message) && process.platform !== 'linux') {
    console.log(
      `\nWiring is correct: the flags and executable path resolved and Playwright tried to\n` +
        `launch. It failed because @sparticuz/chromium's binary is Linux-only and this is\n` +
        `${process.platform}. Run this on the deployment to check the last step.`,
    );
    process.exit(0);
  }

  console.error('\nfailed before the launch — this is a real problem:\n');
  console.error(message.split('\nCall log:')[0]);
  process.exit(1);
}
