import type { Locator, Page } from '@playwright/test';
import type { ArtistResultBatch } from '@workspace/api-client-react';
import {
  test, expect, checkpoint, final, newer, checkpointRows, finalRows, newerRows, rowsFor, rowPath, csvPath, csvContents,
} from './artist-observation-fixtures';

const section = (page: Page) => page.getByTestId('section-artist-batch-results');
const radio = (page: Page, b: ArtistResultBatch) => section(page).getByTestId(`button-batch-${b.id}`);
const shortcut = (page: Page) => section(page).getByTestId(`button-final-observation-${final.id}`);

async function selected(page: Page, b: ArtistResultBatch) {
  const other = b.id === checkpoint.id ? final : checkpoint;
  const root = section(page);
  await expect(radio(page, b)).toHaveAttribute('aria-checked', 'true');
  await expect(radio(page, other)).toHaveAttribute('aria-checked', 'false');
  await expect(root.getByRole('radio', { checked: true })).toHaveCount(1);
  await expect(root.locator('.abr-summary')).toHaveCount(1);
  await expect(root.getByTestId('link-download-artist-csv')).toHaveAttribute('href', csvPath(b.id));
  const summary = root.getByTestId(`summary-batch-${b.id}`);
  await expect(summary).toBeVisible();
  await expect(root.getByTestId(`summary-batch-${other.id}`)).toHaveCount(0);
  await expect(summary).toContainText(`Archive: ${b.id}`);
  await expect(summary).toContainText(b.status);
  await expect(summary).toContainText(b.explanation);
  await expect(summary).toContainText(b.metrics!.find(m => m.label === 'Spending observation')!.value);
  for (const [label, value] of [
    ['Artists', b.artistCount], ['Rows', b.rowCount], ['Verified', b.verifiedCount],
    ['Review', b.reviewCount], ['Not inspected', b.notInspectedCount],
    ['Conservative reservation', `$${b.reservedUsd!.toFixed(2)}`],
    ['Provider reported', `$${b.reportedUsd!.toFixed(2)}`],
  ] as const) {
    await expect(summary.locator('.abr-stats > div').filter({
      has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }),
    }).locator('dd')).toHaveText(String(value));
  }
}

async function displayedRows(page: Page, b: ArtistResultBatch) {
  const root = section(page);
  const rows = rowsFor(b.id);
  const others = [...checkpointRows, ...finalRows, ...newerRows].filter(r => !rows.includes(r));
  await expect(root.locator('.abr-rows > li')).toHaveCount(rows.length);
  for (const r of rows) {
    const item = root.getByTestId(`row-artist-result-${r.id}`);
    await expect(item).toContainText(r.artistName);
    await expect(item).toContainText(`profile ${r.profileId}`);
    await expect(item.getByTestId('link-candidate-url')).toHaveAttribute('href', r.candidateUrl!);
  }
  for (const r of others) await expect(root.getByTestId(`row-artist-result-${r.id}`)).toHaveCount(0);
  await expect(root.getByTestId('text-artist-rows-range')).toHaveText(`Showing 1–${rows.length} of ${rows.length} rows`);
}

async function download(page: Page, b: ArtistResultBatch) {
  const event = page.waitForEvent('download');
  await section(page).getByTestId('link-download-artist-csv').click();
  const file = await event;
  expect(new URL(file.url()).pathname).toBe(csvPath(b.id));
  expect(file.suggestedFilename()).toBe(`${b.id}.csv`);
  const stream = await file.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString('utf8')).toBe(csvContents(b));
  expect(await file.failure()).toBeNull();
}

async function layout(page: Page, controls: Locator[]) {
  const width = page.viewportSize()!.width;
  for (const control of controls) {
    await control.scrollIntoViewIfNeeded();
    await expect(control).toBeVisible();
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
  }
  expect(await section(page).evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`${theme} observation evidence`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.addInitScript(dark => {
        localStorage.clear();
        // The parser can replace attributes set before <html> is parsed.
        document.addEventListener('DOMContentLoaded', () => {
          document.documentElement.classList.toggle('dark', dark);
        }, { once: true });
      }, theme === 'dark');
    });

    test('final shortcut, delayed final response, and return keep rows, summary and CSV isolated', async ({ page, api }, testInfo) => {
      api.hold(final.id);
      await page.goto(`${api.url}/bulk/artists`);
      await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*dark).*$/);
      await selected(page, checkpoint);
      await displayedRows(page, checkpoint);
      await expect(section(page)).toContainText('2 saved observations');
      await expect(section(page)).toContainText('Separate snapshots; spending is not additive.');
      await layout(page, [radio(page, checkpoint), radio(page, final), shortcut(page)]);
      await download(page, checkpoint);

      await shortcut(page).click();
      await expect.poll(() => api.rowRequests).toEqual([rowPath(checkpoint.id), rowPath(final.id)]);
      await selected(page, final);
      await expect(section(page).getByLabel('Loading rows', { exact: true })).toBeVisible();
      await expect(section(page).locator('.abr-rows > li')).toHaveCount(0);
      // Even during loading, downloading targets the chosen final, not the
      // checkpoint whose rows were visible immediately before the click.
      await download(page, final);
      await radio(page, checkpoint).click();
      await selected(page, checkpoint);
      await displayedRows(page, checkpoint);

      // A final response arriving after the switch back cannot replace the
      // checkpoint's evidence, spending summary or download target.
      api.release(final.id);
      await expect.poll(() => api.delivered.includes(final.id)).toBe(true);
      await selected(page, checkpoint);
      await displayedRows(page, checkpoint);
      await download(page, checkpoint);
      await shortcut(page).click();
      await selected(page, final);
      await displayedRows(page, final);
      await layout(page, [radio(page, final), section(page).getByTestId(`text-observation-provenance-${final.id}`),
        section(page).getByTestId('link-download-artist-csv')]);
      await download(page, final);
      await testInfo.attach(`${theme}-final-observation`, {
        body: await section(page).screenshot(), contentType: 'image/png',
      });
      await radio(page, checkpoint).click();
      await selected(page, checkpoint);
      await displayedRows(page, checkpoint);
      await download(page, checkpoint);
      await testInfo.attach(`${theme}-checkpoint-restored`, {
        body: await section(page).screenshot(), contentType: 'image/png',
      });
      // React Query may cancel an unobserved request and re-read on return.
      // Assert exact archive-specific targets, not incidental cache behavior.
      expect([...new Set(api.rowRequests)]).toEqual([rowPath(checkpoint.id), rowPath(final.id)]);
      expect(api.csvRequests).toEqual([
        csvPath(checkpoint.id), csvPath(final.id), csvPath(checkpoint.id), csvPath(final.id), csvPath(checkpoint.id),
      ]);
    });

    test('late checkpoint response cannot overwrite the selected final observation', async ({ page, api }) => {
      api.hold(checkpoint.id);
      await page.goto(`${api.url}/bulk/artists`);
      await selected(page, checkpoint);
      await expect(section(page).getByLabel('Loading rows', { exact: true })).toBeVisible();
      await expect.poll(() => api.rowRequests).toEqual([rowPath(checkpoint.id)]);
      await shortcut(page).click();
      await selected(page, final);
      await displayedRows(page, final);
      api.release(checkpoint.id);
      await expect.poll(() => api.delivered.includes(checkpoint.id)).toBe(true);
      await selected(page, final);
      await displayedRows(page, final);
      await download(page, final);
      await radio(page, checkpoint).click();
      await selected(page, checkpoint);
      await displayedRows(page, checkpoint);
      await download(page, checkpoint);
      expect([...new Set(api.rowRequests)]).toEqual([rowPath(checkpoint.id), rowPath(final.id)]);
      expect(api.csvRequests).toEqual([csvPath(final.id), csvPath(checkpoint.id)]);
    });

    for (const chosen of [checkpoint, final]) {
      test(`history refresh preserves explicitly selected ${chosen === checkpoint ? 'checkpoint' : 'final'} while rows are pending`, async ({ page, api }) => {
        api.hold(chosen.id);
        await page.clock.install();
        await page.goto(`${api.url}/bulk/artists`);
        await selected(page, checkpoint);
        if (chosen.id === final.id) await displayedRows(page, checkpoint);
        // Explicitly select even the initial checkpoint: the assertion is about
        // retaining a user's archive choice, not the unpicked first-list default.
        await radio(page, chosen).click();
        await selected(page, chosen);
        await expect.poll(() => api.rowRequests.includes(rowPath(chosen.id))).toBe(true);
        const pending = async () => {
          await selected(page, chosen);
          await expect(section(page).getByLabel('Loading rows', { exact: true })).toBeVisible();
          await expect(section(page).locator('.abr-rows > li')).toHaveCount(0);
          expect(api.delivered).not.toContain(chosen.id);
        };
        await pending();
        await expect.poll(() => api.batchResponses.length).toBe(1);
        const originalSummary = await section(page).getByTestId(`summary-batch-${chosen.id}`).innerText();
        await download(page, chosen);

        // Poll the actual list query independently of the held rows. The Refresh
        // button is deliberately disabled while those rows are in flight.
        for (const batches of [[final, checkpoint], [newer, final, checkpoint]]) {
          const before = api.batchResponses.length;
          api.batches = batches;
          await page.clock.fastForward(30_100);
          await expect.poll(() => api.batchResponses.length).toBeGreaterThan(before);
          expect(api.batchResponses.at(-1)).toEqual(batches.map(b => b.id));
          await expect(section(page).getByRole('radio')).toHaveCount(batches.length);
          await expect.poll(() => section(page).getByRole('radio').evaluateAll(
            elements => elements.map(el => el.getAttribute('data-testid')),
          )).toEqual(batches.map(b => `button-batch-${b.id}`));
          await expect(section(page).getByRole('group', {
            name: `Approved run fixture-approved-parent, scope ${'a'.repeat(24)}`, exact: true,
          })).toContainText(`${batches.length} saved observations`);
          await pending();
          await expect(section(page).getByTestId(`summary-batch-${chosen.id}`)).toHaveText(originalSummary, { useInnerText: true });
          await download(page, chosen);
        }
        await expect(radio(page, newer)).toHaveAttribute('aria-checked', 'false');
        // No row read for the newly inserted archive (or any implicit switch).
        const expectedRows = chosen.id === checkpoint.id
          ? [rowPath(checkpoint.id)] : [rowPath(checkpoint.id), rowPath(final.id)];
        expect(api.rowRequests).toEqual(expectedRows);
        api.release(chosen.id);
        await expect.poll(() => api.delivered.includes(chosen.id)).toBe(true);
        await selected(page, chosen);
        await displayedRows(page, chosen);
        await expect(section(page).getByTestId(`summary-batch-${chosen.id}`)).toHaveText(originalSummary, { useInnerText: true });
        for (const r of rowsFor(chosen.id)) {
          await section(page).getByTestId(`button-expand-row-${r.id}`).click();
          const detail = section(page).getByTestId(`detail-artist-row-${r.id}`);
          await detail.locator('summary').filter({ hasText: 'Provenance' }).click();
          await expect(detail.getByTestId(`field-${r.id}-provenance-0`)).toHaveText(
            `Saved archive evidence${r.id} original evidence`,
          );
        }
        await download(page, chosen);
        expect(api.rowRequests).toEqual(expectedRows);
        expect(api.csvRequests).toEqual(Array(4).fill(csvPath(chosen.id)));
      });
    }
  });
}
