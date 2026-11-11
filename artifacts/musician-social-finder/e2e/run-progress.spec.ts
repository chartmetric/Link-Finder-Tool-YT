import { test, expect, open, poll, run, advance, continuous, ROOT, ARCHIVE } from './progress-fixtures';
import type { Page } from '@playwright/test';

const summary = (page: Page) => page.getByTestId('section-run-progress');
const stat = (page: Page, key: string) => page.getByTestId(`text-rp-${key}`);

async function figures(page: Page, values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) await expect(stat(page, key)).toHaveText(value);
}

for (const source of ['manual', 'automatic', 'floating'] as const) {
  test(`${source} Start response opens, focuses and scrolls to compact progress`, async ({ page, api }, testInfo) => {
    api.holdStart = true;
    await open(page);
    await expect(summary(page)).toHaveCount(0);
    if (source === 'manual') {
      await page.getByTestId('checkbox-select-page').check();
      await page.getByTestId('checkbox-ack-paid').check();
      await page.getByTestId('button-start-bulk').click();
    } else if (source === 'automatic') {
      await page.getByTestId('input-auto-limit').fill('4');
      await page.getByTestId('button-auto-start').click();
    } else {
      await page.getByTestId('button-toggle-widget').click();
      await page.getByTestId('input-widget-count-brand').fill('4');
      await page.getByTestId('checkbox-widget-ack').check();
      await page.getByTestId('button-widget-start').click();
    }
    await expect.poll(() => api.starts.length).toBe(1);
    await expect(summary(page)).toHaveCount(0);
    const body = api.starts[0];
    expect(body.requestId).toMatch(/^[a-f0-9-]{36}$/);
    if (source === 'manual') {
      expect(body.profileIds).toEqual([1, 2, 3, 4]);
      expect(body.profileTypes).toEqual(['brand']);
    } else expect(body.scopes).toEqual([{ profileType: 'brand', limit: 4 }]);
    api.releaseStart!();
    await expect(summary(page)).toBeVisible();
    await expect(summary(page)).toBeFocused();
    if (source === 'floating') {
      await expect(page.getByTestId('button-toggle-widget')).toHaveAttribute('aria-expanded', 'false');
    }
    await figures(page, { processed: '0/4', running: '2', queued: '2', completed: '0', failed: '0', skipped: '0' });
    await expect(page.getByTestId('status-rp')).toHaveText('running');
    const scrolls = await page.evaluate(() => (window as unknown as {
      progressScrolls: { target: string; options: ScrollIntoViewOptions }[];
    }).progressScrolls);
    expect(scrolls).toContainEqual({
      target: 'section-run-progress', options: { behavior: 'smooth', block: 'start' },
    });
    // Finish the smooth scroll before measuring real layout.
    await page.clock.runFor(700);
    await expect(summary(page)).toBeInViewport({ ratio: 1 });
    const box = await summary(page).boundingBox();
    expect(box!.height).toBeLessThan(420);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    const columns = await summary(page).locator('dl').evaluate(el =>
      getComputedStyle(el).gridTemplateColumns.split(' ').length);
    expect(columns).toBe(page.viewportSize()!.width < 600 ? 3 : 7);
    if (source === 'manual') {
      await testInfo.attach('compact-progress', {
        body: await page.screenshot(), contentType: 'image/png',
      });
    }
    // Opening the monitor traps focus, not scrolls the underlying page.
    await page.getByTestId('button-rp-open-detail').click();
    await page.clock.runFor(700);
    await expect(page.getByTestId('section-bulk-run')).toBeInViewport();
    const dialog = page.getByTestId('dialog-run-monitor');
    const focused = await page.evaluate(() => document.activeElement?.outerHTML);
    const scrollCount = scrolls.length;
    api.root = advance(api.root);
    await poll(page, api);
    await figures(page, { processed: '2/4', completed: '1', failed: '1', running: '1', queued: '1', percent: '50.0%' });
    expect(await page.evaluate(() => document.activeElement?.outerHTML)).toBe(focused);
    expect(await page.evaluate(() => (window as unknown as { progressScrolls: unknown[] }).progressScrolls.length)).toBe(scrollCount);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByTestId('button-rp-open-detail')).toBeFocused();
  });
}

test('polling advances successful/failed counts, names, timestamp and final state', async ({ page, api }) => {
  await open(page, ROOT);
  await expect(summary(page)).toBeVisible();
  await expect(page.getByTestId('text-rp-running-names')).toContainText('Fixture profile 1');
  await expect(page.getByTestId('text-rp-running-names')).toContainText('Fixture profile 2');
  const oldTime = await stat(page, 'updated').textContent();
  api.root = advance(api.root);
  await poll(page, api);
  await figures(page, { processed: '2/4', completed: '1', failed: '1', running: '1', queued: '1', percent: '50.0%' });
  await expect(stat(page, 'updated')).not.toHaveText(oldTime!);
  await expect(page.getByTestId('text-rp-running-names')).toHaveText('Now: Fixture profile 3 — In progress');
  await expect(summary(page).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
  api.root = advance(api.root, true);
  await poll(page, api);
  await figures(page, { processed: '4/4', completed: '2', failed: '2', running: '0', queued: '0', percent: '100.0%' });
  await expect(page.getByTestId('status-rp')).toHaveText('completed');
  await expect(page.getByTestId('text-rp-terminal')).toHaveText('Finished: all profiles processed');
  await expect(page.getByTestId('status-rp-sync')).toHaveText('Final state');
  await expect(page.getByTestId('text-rp-running-names')).toHaveCount(0);
  const reads = api.reads[ROOT];
  await page.clock.fastForward(12_100);
  expect(api.reads[ROOT]).toBe(reads);
  expect(api.starts).toEqual([]);
});

test('continuous root stays live while opening archive, changing scope and reloading', async ({ page, api }) => {
  api.root = continuous(30);
  await open(page, ROOT);
  await figures(page, { processed: '10/30', completed: '8', failed: '2' });
  await expect(summary(page).getByRole('progressbar', { name: '10 of 30 capped profiles processed', exact: true })).toHaveAttribute('aria-valuenow', '33');
  await page.getByTestId('button-rp-open-detail').click();
  await page.getByTestId(`button-open-chunk-${ARCHIVE}`).click();
  await expect(page.getByTestId('section-bulk-run')).toContainText('Chunk 1 of fixture-');
  await expect(page.getByTestId('text-rp-run-id')).toContainText(ROOT.slice(0, 8));
  api.root = advance(api.root);
  await poll(page, api);
  await figures(page, { processed: '12/30', completed: '9', failed: '3', running: '1' });
  const archiveReads = api.reads[ARCHIVE];
  await page.clock.fastForward(6100);
  expect(api.reads[ARCHIVE]).toBe(archiveReads);
  await page.getByTestId('dialog-run-monitor').getByRole('button', { name: 'Close', exact: true }).click();
  for (const kind of ['creator', 'artist']) {
    await page.getByTestId(`link-scope-${kind}`).click();
    // A brand-only run must not be presented as creator/artist progress.
    await expect(summary(page)).toHaveCount(0);
    await expect(page.getByTestId('text-no-scoped-run')).toContainText(`No saved run for ${kind}s`);
  }
  await page.getByTestId('link-scope-brand').click();
  await figures(page, { processed: '12/30', completed: '9', failed: '3' });
  await page.reload();
  await figures(page, { processed: '12/30', completed: '9', failed: '3' });
  // Reload restores the root summary, but intentionally does not open a modal.
  await expect(page.getByTestId('dialog-run-monitor')).toHaveCount(0);
  await page.getByTestId('button-rp-open-detail').click();
  await page.getByTestId(`button-open-chunk-${ARCHIVE}`).click();
  await expect(page.getByTestId('button-open-root-run')).toBeVisible();
  api.root = advance(api.root, true);
  await poll(page, api);
  await figures(page, { processed: '14/30', completed: '10', failed: '4' });
  await expect(page.getByTestId('status-rp')).toHaveText('completed');
  await page.getByTestId('button-open-root-run').click();
  await expect(page.getByTestId('section-bulk-run')).toContainText('continuous');
  expect(api.starts).toEqual([]);
});

test('poll failures retain last known numbers and Retry recovers', async ({ page, api }) => {
  api.root = advance(run());
  await open(page, ROOT);
  await figures(page, { processed: '2/4', completed: '1', failed: '1' });
  await page.getByTestId('button-rp-open-detail').click();
  api.errors = true;
  await poll(page, api);
  // React Query retries failed reads; advance its backoff without real waits.
  for (let n = 0; n < 5; n++) {
    await page.clock.fastForward(4000);
    await page.waitForTimeout(50);
  }
  await expect(page.getByTestId('status-rp-error')).toContainText('Lost contact; showing last known numbers.');
  await expect(page.getByTestId('status-rp-sync')).toHaveText('Stale: polling failed');
  await figures(page, { processed: '2/4', completed: '1', failed: '1' });
  await expect(page.getByTestId('status-run-error')).toContainText('showing last known state');
  api.errors = false;
  api.root = advance(api.root, true);
  await page.getByTestId('status-run-error').getByRole('button', { name: 'Retry', exact: true }).click();
  await figures(page, { processed: '4/4', completed: '2', failed: '2' });
  await expect(page.getByTestId('status-rp-error')).toHaveCount(0);
  await expect(page.getByTestId('status-run-error')).toHaveCount(0);
});

test('initial load failure offers Retry without inventing zero counts', async ({ page, api }) => {
  // The summary can be identified from saved history even if its GET fails.
  api.saved = true;
  api.errors = true;
  await open(page, ROOT);
  for (let n = 0; n < 5; n++) {
    await page.clock.fastForward(4000);
    await page.waitForTimeout(50);
  }
  await expect(page.getByTestId('status-rp-sync')).toHaveText('Could not load');
  await expect(stat(page, 'processed')).toHaveCount(0);
  api.errors = false;
  await page.getByTestId('button-rp-retry').click();
  await figures(page, { processed: '0/4', running: '2' });
});

for (const status of ['stopped', 'interrupted'] as const) {
  test(`${status} terminal run stops interval polling`, async ({ page, api }) => {
    await open(page, ROOT);
    await figures(page, { processed: '0/4' });
    api.root = { ...advance(api.root), status };
    await poll(page, api);
    await expect(page.getByTestId('status-rp')).toHaveText(status);
    await expect(page.getByTestId('text-rp-terminal')).toContainText(
      status === 'stopped' ? 'Stopped; explicit resume required' : 'Paused by server restart; needs resume');
    const reads = api.reads[ROOT];
    await page.clock.fastForward(12_100);
    expect(api.reads[ROOT]).toBe(reads);
  });
}

test('uncapped runs show chunk progress only, including scanning between chunks', async ({ page, api }) => {
  api.root = continuous();
  await open(page, ROOT);
  await figures(page, { processed: '10', completed: '8', failed: '2' });
  await expect(page.getByTestId('text-rp-uncapped')).toContainText('no overall percentage');
  await expect(stat(page, 'percent')).toHaveCount(0);
  await expect(summary(page).getByRole('progressbar')).toHaveCount(1);
  await expect(summary(page).getByRole('progressbar')).toHaveAttribute('aria-label', 'Current chunk 0 of 4');
  await page.getByTestId('button-rp-open-detail').click();
  await expect(page.getByTestId('section-bulk-run').getByRole('progressbar')).toHaveAttribute('aria-label', 'Current chunk progress');
  await page.getByTestId('dialog-run-monitor').getByRole('button', { name: 'Close', exact: true }).click();
  api.root = { ...api.root, items: [] };
  await poll(page, api);
  await expect(summary(page).getByRole('progressbar')).toHaveAttribute('aria-valuetext', 'Scanning for the next chunk');
  await expect(stat(page, 'percent')).toHaveCount(0);
  await figures(page, { processed: '10', running: '0', queued: '0' });
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });
  test('Start and monitor navigation use instant scrolling and no progress animation', async ({ page, api }) => {
    await open(page);
    await page.getByTestId('button-auto-start').click();
    await expect(summary(page)).toBeFocused();
    await page.getByTestId('button-rp-open-detail').click();
    const scrolls = await page.evaluate(() => (window as unknown as {
      progressScrolls: { options: ScrollIntoViewOptions }[];
    }).progressScrolls);
    expect(scrolls).toHaveLength(1);
    expect(scrolls.every(s => s.options.behavior === 'auto')).toBe(true);
    for (const selector of ['.blk-rp', '.blk-rp-dot', '.blk-rp-bar b']) {
      const styles = await page.locator(selector).first().evaluate(el => {
        const s = getComputedStyle(el);
        return { animation: s.animationDuration, transition: s.transitionDuration };
      });
      expect(parseFloat(styles.animation)).toBeLessThanOrEqual(0.001);
      expect(parseFloat(styles.transition)).toBeLessThanOrEqual(0.001);
    }
    expect(api.starts).toHaveLength(1);
  });
});
