import type { Locator, Page } from '@playwright/test';
import type { ArtistResultBatch } from '@workspace/api-client-react';
import {
  test, expect, checkpoint, final, newer, checkpointRows, finalRows, newerRows, rowsFor, rowPath, csvPath, csvContents, rowError,
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

async function displayedRows(page: Page, b: ArtistResultBatch, rows = rowsFor(b.id)) {
  const root = section(page);
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
      test(`history polling failure and reordered recovery retain selected ${chosen === checkpoint ? 'checkpoint' : 'final'} evidence`, async ({ page, api }, testInfo) => {
        await page.clock.install();
        await page.goto(`${api.url}/bulk/artists`);
        await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*dark).*$/);
        await selected(page, checkpoint);
        await displayedRows(page, checkpoint);
        // Exercise a real user selection, including when choosing the default.
        await radio(page, chosen).click();
        await selected(page, chosen);
        await displayedRows(page, chosen);
        const originalSummary = await section(page).getByTestId(`summary-batch-${chosen.id}`).innerText();
        const originalRequests = [...api.rowRequests];
        await download(page, chosen);
        await expect.poll(() => api.batchResponses.length).toBe(1);

        // Only the history poll fails; the selected archive's saved rows and
        // native CSV remain healthy. No Refresh click can cause this failure.
        api.batchErrors = true;
        await page.clock.fastForward(30_100);
        await expect.poll(() => api.batchFailures).toBe(1);
        // Exhaust React Query's real retry/backoff so this is a visible error,
        // not merely a transient failed request with the picker still present.
        for (const attempt of [2, 3, 4]) {
          await page.clock.fastForward(8_100);
          await expect.poll(() => api.batchFailures).toBe(attempt);
        }
        const alert = section(page).getByRole('alert');
        const retry = section(page).getByTestId('button-retry-artist-batches');
        await expect(alert).toContainText('Fixture saved history unavailable');
        await expect(retry).toBeVisible();
        // The current error UI hides evidence, rather than showing stale or
        // another archive's evidence. The independent CSV stays on our choice.
        await expect(section(page).getByRole('radio')).toHaveCount(0);
        await expect(section(page).locator('.abr-summary')).toHaveCount(0);
        await expect(section(page).locator('.abr-rows > li')).toHaveCount(0);
        await expect(section(page).getByTestId('text-artist-rows-range')).toHaveCount(0);
        for (const r of [...checkpointRows, ...finalRows, ...newerRows]) {
          await expect(section(page).getByTestId(`row-artist-result-${r.id}`)).toHaveCount(0);
          await expect(section(page).getByTestId(`detail-artist-row-${r.id}`)).toHaveCount(0);
        }
        await expect(section(page).getByTestId('link-download-artist-csv')).toHaveAttribute('href', csvPath(chosen.id));
        await layout(page, [alert, retry, section(page).getByTestId('link-download-artist-csv')]);
        await download(page, chosen);
        expect(api.rowRequests).toEqual(originalRequests);
        expect(api.batchResponses).toHaveLength(1);
        await testInfo.attach(`${theme}-history-unavailable`, {
          body: await section(page).screenshot(), contentType: 'image/png',
        });

        // Insert a new first archive and reverse the old pair on recovery.
        // Neither the default nor the selected archive's list index is stable.
        api.batches = [newer, final, checkpoint];
        api.batchErrors = false;
        await retry.click();
        await expect.poll(() => api.batchResponses.length).toBe(2);
        expect(api.batchResponses.at(-1)).toEqual([newer.id, final.id, checkpoint.id]);
        await expect(alert).toHaveCount(0);
        await expect(retry).toHaveCount(0);
        await expect.poll(() => section(page).getByRole('radio').evaluateAll(
          elements => elements.map(el => el.getAttribute('data-testid')),
        )).toEqual(api.batches.map(b => `button-batch-${b.id}`));
        await expect(radio(page, newer)).toHaveAttribute('aria-checked', 'false');
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
        // Retry reads the history only, never a different archive's rows.
        expect(api.rowRequests).toEqual(originalRequests);
        expect(api.batchFailures).toBe(4);
        expect(api.csvRequests).toEqual(Array(3).fill(csvPath(chosen.id)));
      });

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

    for (const failing of [checkpoint, final]) {
      test(`${failing.status} row failure and retry preserve the selected archive`, async ({ page, api }, testInfo) => {
        // Real retry backoff is intentional: don't freeze React Query's UI
        // notifications or alter production retry/cache behavior for this test.
        test.setTimeout(60_000);
        const other = failing.id === checkpoint.id ? final : checkpoint;
        const root = section(page);
        const alert = root.getByRole('alert');
        const retry = root.getByTestId('button-retry-artist-rows');
        const loading = root.getByLabel('Loading rows', { exact: true });
        const csv = root.getByTestId('link-download-artist-csv');
        api.fail(failing.id);
        await page.goto(`${api.url}/bulk/artists`);
        await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*dark).*$/);
        // First read the healthy observation so stale successful rows exist
        // before selecting the broken archive (in either direction).
        if (failing.id === checkpoint.id) {
          await expect(alert).toHaveText(`${rowError(failing.id)}Retry`, { timeout: 15_000 });
          await radio(page, other).click();
        }
        await selected(page, other);
        await displayedRows(page, other);
        await download(page, other);
        await radio(page, failing).click();
        await expect(alert).toHaveText(`${rowError(failing.id)}Retry`, { timeout: 15_000 });
        await selected(page, failing);
        await expect(root.locator('.abr-rows > li')).toHaveCount(0);
        await expect(root.getByTestId('text-artist-rows-range')).toHaveCount(0);
        await expect(root.getByTestId('text-no-artist-rows')).toHaveCount(0);
        await expect(loading).toHaveCount(0);
        expect(api.failed.length).toBeGreaterThan(0);
        expect(new Set(api.failed)).toEqual(new Set([failing.id]));
        await layout(page, [radio(page, failing), radio(page, other), alert, retry, csv]);
        await download(page, failing);
        await testInfo.attach(`${theme}-${failing.status}-row-error`, {
          body: await root.screenshot(), contentType: 'image/png',
        });

        // Leaving an error must restore only the other observation's rows,
        // spending and download, with no leaked error or Retry control.
        await radio(page, other).click();
        await selected(page, other);
        await displayedRows(page, other);
        await expect(alert).toHaveCount(0);
        await expect(retry).toHaveCount(0);
        await download(page, other);
        await radio(page, failing).click();
        await expect(alert).toHaveText(`${rowError(failing.id)}Retry`, { timeout: 15_000 });
        await selected(page, failing);
        await expect(root.locator('.abr-rows > li')).toHaveCount(0);
        await download(page, failing);

        // Hold the manual retry so its exact request and the interim download
        // can be checked independently of the eventual successful response.
        api.hold(failing.id);
        api.recover(failing.id);
        const beforeRetry = api.rowRequests.length;
        await retry.click();
        await expect(loading).toBeVisible();
        expect(api.rowRequests.slice(beforeRetry)).toEqual([rowPath(failing.id)]);
        await selected(page, failing);
        await expect(alert).toHaveCount(0);
        await expect(retry).toHaveCount(0);
        await expect(root.locator('.abr-rows > li')).toHaveCount(0);
        await download(page, failing);

        // A successful retry arriving after navigation must not replace the
        // currently chosen archive. Returning then recovers the failed rows.
        await radio(page, other).click();
        await selected(page, other);
        await displayedRows(page, other);
        api.release(failing.id);
        await expect.poll(() => api.delivered.includes(failing.id)).toBe(true);
        await selected(page, other);
        await displayedRows(page, other);
        await expect(alert).toHaveCount(0);
        await download(page, other);
        await radio(page, failing).click();
        await selected(page, failing);
        await displayedRows(page, failing);
        await expect(alert).toHaveCount(0);
        await expect(retry).toHaveCount(0);
        await layout(page, [radio(page, failing),
          root.getByTestId(`text-observation-provenance-${failing.id}`), csv]);
        await download(page, failing);
        await testInfo.attach(`${theme}-${failing.status}-row-recovered`, {
          body: await root.screenshot(), contentType: 'image/png',
        });
        expect([...new Set(api.rowRequests)]).toEqual([rowPath(checkpoint.id), rowPath(final.id)]);
        expect(api.rowRequests.slice(beforeRetry).every(path => path === rowPath(failing.id))).toBe(true);
        expect(api.csvRequests).toEqual([
          csvPath(other.id), csvPath(failing.id), csvPath(other.id), csvPath(failing.id),
          csvPath(failing.id), csvPath(other.id), csvPath(failing.id),
        ]);
      });
    }

    for (const change of ['search', 'status'] as const) {
      test(`late filtered-row retry cannot replace the current ${change} results`, async ({ page, api }, testInfo) => {
        test.setTimeout(60_000);
        const root = section(page);
        const search = root.getByTestId('input-artist-results-search');
        const alert = root.getByRole('alert');
        const retry = root.getByTestId('button-retry-artist-rows');
        const loading = root.getByLabel('Loading rows', { exact: true });
        // Only this exact search query fails; the unfiltered archive and the
        // replacement filter must remain independently readable.
        const failedPath = rowPath(final.id, { search: 'Final' });
        const currentQuery = change === 'search'
          ? { search: 'verified' } : { search: 'Final', status: 'verified' };
        const currentPath = rowPath(final.id, currentQuery);
        api.fail(failedPath);
        await page.goto(`${api.url}/bulk/artists`);
        await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*dark).*$/);
        await displayedRows(page, checkpoint);
        await shortcut(page).click();
        await selected(page, final);
        await displayedRows(page, final);
        const summary = root.getByTestId(`summary-batch-${final.id}`);
        const originalSummary = await summary.innerText();
        await search.fill('Final');
        await expect(alert).toHaveText(`${rowError(final.id)}Retry`, { timeout: 15_000 });
        await expect(root.locator('.abr-rows > li')).toHaveCount(0);
        await expect(root.getByTestId('text-artist-rows-range')).toHaveCount(0);
        await expect(root.getByTestId('text-no-artist-rows')).toHaveCount(0);
        await selected(page, final);
        expect(api.failedPaths.length).toBeGreaterThan(0);
        expect(new Set(api.failedPaths)).toEqual(new Set([failedPath]));
        await layout(page, [search, root.getByTestId('button-filter-verified'), alert, retry,
          root.getByTestId('link-download-artist-csv')]);
        await download(page, final);

        api.hold(failedPath);
        api.recover(failedPath);
        const beforeRetry = api.rowRequests.length;
        await retry.click();
        await expect.poll(() => api.rowRequests.slice(beforeRetry)).toEqual([failedPath]);
        await expect(loading).toBeVisible();
        await expect(alert).toHaveCount(0);
        await expect(root.locator('.abr-rows > li')).toHaveCount(0);
        await expect(root.getByTestId('text-artist-rows-range')).toHaveCount(0);
        await selected(page, final);
        await download(page, final);

        // Change the query while its retry is held, not after it has recovered.
        if (change === 'search') await search.fill(currentQuery.search);
        else await root.getByTestId('button-filter-verified').click();
        await expect.poll(() => api.deliveredPaths.includes(currentPath)).toBe(true);
        expect(api.deliveredPaths).not.toContain(failedPath);
        await displayedRows(page, final, [finalRows[0]]);
        await expect(loading).toHaveCount(0);
        await expect(alert).toHaveCount(0);
        await expect(retry).toHaveCount(0);
        await selected(page, final);
        await expect(summary).toHaveText(originalSummary, { useInnerText: true });
        await download(page, final);

        api.release(failedPath);
        await expect.poll(() => api.deliveredPaths.includes(failedPath)).toBe(true);
        await selected(page, final);
        await displayedRows(page, final, [finalRows[0]]);
        await expect(search).toHaveValue(currentQuery.search);
        await expect(root.getByTestId(`button-filter-${change === 'status' ? 'verified' : 'all'}`))
          .toHaveAttribute('aria-pressed', 'true');
        await expect(alert).toHaveCount(0);
        await expect(retry).toHaveCount(0);
        await expect(summary).toHaveText(originalSummary, { useInnerText: true });
        await download(page, final);
        await layout(page, [search, root.getByTestId('text-artist-rows-range'),
          root.getByTestId('row-artist-result-final-verified'), root.getByTestId('link-download-artist-csv')]);
        await testInfo.attach(`${theme}-${change}-late-filter-recovery`, {
          body: await root.screenshot(), contentType: 'image/png',
        });

        // Revisit the failed query: recovery must have its own two-row count,
        // rather than poisoning either cache entry with the other filter.
        if (change === 'search') await search.fill('Final');
        else await root.getByTestId('button-filter-all').click();
        await displayedRows(page, final);
        await selected(page, final);
        await expect(alert).toHaveCount(0);
        await expect(summary).toHaveText(originalSummary, { useInnerText: true });
        await download(page, final);
        expect(new Set(api.rowRequests)).toEqual(new Set([
          rowPath(checkpoint.id), rowPath(final.id), failedPath, currentPath,
        ]));
        expect(api.csvRequests).toEqual(Array(5).fill(csvPath(final.id)));
      });
    }
  });
}
