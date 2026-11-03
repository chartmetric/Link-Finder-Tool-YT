import type { BulkBrandRun } from '@workspace/api-client-react';
import type { Locator, Page } from '@playwright/test';
import { test, expect, open, poll, run, ROOT, type ProgressApi } from './progress-fixtures';

const kinds = ['brand', 'creator', 'artist'] as const;
const initialMessage = 'Checking the saved request before selecting profiles. No paid lookups have started.';

function preparing(overrides: Partial<BulkBrandRun> = {}): BulkBrandRun {
  return run({
    items: [],
    estimatedCostUsd: 0,
    selectionMode: 'remaining',
    scopes: kinds.map(profileType => ({ profileType, limit: 4 })),
    preparation: {
      status: 'selecting', mode: 'one_chunk', requested: 12, selected: 0,
      message: initialMessage,
    },
    ...overrides,
  });
}

async function monitor(page: Page) {
  await page.getByTestId('button-rp-open-detail').click();
  const dialog = page.getByRole('dialog', { name: 'Run monitor', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('section-bulk-run')).toBeVisible();
  return dialog;
}

async function selectionRows(dialog: Locator, text: string) {
  for (const kind of kinds) {
    await expect(dialog.getByTestId(`row-run-kind-${kind}`)).toContainText(text);
  }
}

async function incomplete(dialog: Locator, stopped = false) {
  await expect(dialog.getByTestId('text-run-preparing')).toContainText('0 / up to 12 selected.');
  await expect(dialog.getByTestId('text-run-completed')).toHaveText('0/0');
  await expect(dialog.getByTestId('text-run-cost')).toHaveText('$0.0000');
  await selectionRows(dialog, stopped
    ? 'Preparation stopped — selection is incomplete'
    : 'Preparing selection — eligibility is still being checked');
  await expect(dialog).not.toContainText('No eligible profiles');
}

function noPaidWork(api: ProgressApi) {
  expect(api.starts, 'Viewing preparation must not start a run').toEqual([]);
  expect(api.mutations, 'Polling and dismissing must not start, stop, resume or investigate').toEqual([]);
  expect(api.unexpected, 'Only explicitly mocked API reads are allowed').toEqual([]);
}

test.beforeEach(async ({ api }) => {
  // Even a regression issuing Start/Stop/Resume is aborted before any handler
  // can respond. The context harness also blocks every unmocked/provider URL.
  api.readOnly = true;
});

test('empty preparation polls changing stages and page checks without declaring exhaustion', async ({ page, api }, testInfo) => {
  api.root = preparing();
  await open(page, ROOT);
  let dialog = await monitor(page);
  await expect(dialog.getByTestId('status-run')).toHaveText('preparing');
  await expect(dialog.getByTestId('text-run-preparing')).toContainText(initialMessage);
  await expect(dialog.getByTestId('button-stop-run')).toBeEnabled();
  await expect(dialog.getByTestId('button-resume-run')).toHaveCount(0);
  await incomplete(dialog);

  for (const message of [
    'Catalog boundary saved. Selecting eligible profiles.',
    'Checked 1 catalog pages. Selected 0 of up to 12 eligible profiles. No paid lookups have started.',
    'Checked 2 catalog pages. Selected 0 of up to 12 eligible profiles. No paid lookups have started.',
  ]) {
    api.root = { ...api.root, preparation: { ...api.root.preparation!, message } };
    await poll(page, api);
    await expect(dialog.getByTestId('text-run-preparing')).toContainText(message);
    await expect(dialog.getByTestId('status-run')).toHaveText('preparing');
    await incomplete(dialog);
  }
  await testInfo.attach('empty-preparation-page-checks', {
    body: await page.screenshot(), contentType: 'image/png',
  });

  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('button-rp-open-detail')).toBeFocused();
  noPaidWork(api);

  // The compact monitor must keep reading server progress while the detailed
  // modal is closed. Reopening must show the newer checkpoint, not restart it.
  const message = 'Checked 3 catalog pages. Selected 0 of up to 12 eligible profiles. No paid lookups have started.';
  api.root = { ...api.root, preparation: { ...api.root.preparation!, message } };
  await poll(page, api);
  await expect(page.getByTestId('status-rp')).toHaveText('preparing');
  dialog = await monitor(page);
  await expect(dialog.getByTestId('text-run-preparing')).toContainText(message);
  await incomplete(dialog);
  noPaidWork(api);
});

test('a stopped empty preparation remains incomplete after polling, closing and reopening', async ({ page, api }, testInfo) => {
  api.root = preparing();
  await open(page, ROOT);
  let dialog = await monitor(page);
  await incomplete(dialog);

  // Stop happened elsewhere: observing it must not send a control request.
  const message = 'Checked 2 catalog pages. Preparation stopped before selection completed. No paid lookups have started.';
  api.root = {
    ...api.root, status: 'stopped', stopRequested: true,
    preparation: { ...api.root.preparation!, message },
  };
  await poll(page, api);
  await expect(dialog.getByTestId('status-run')).toHaveText('stopped');
  await expect(dialog.getByTestId('text-run-preparing')).toContainText('Profile preparation paused');
  await expect(dialog.getByTestId('text-run-preparing')).toContainText(message);
  await expect(dialog.getByTestId('button-stop-run')).toHaveCount(0);
  await expect(dialog.getByTestId('button-resume-run')).toBeEnabled();
  await incomplete(dialog, true);
  await testInfo.attach('stopped-preparation', {
    body: await page.screenshot(), contentType: 'image/png',
  });

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('button-rp-open-detail')).toBeFocused();
  await page.clock.fastForward(10_100);
  await expect(page.getByTestId('status-rp')).toHaveText('stopped');
  dialog = await monitor(page);
  await expect(dialog.getByTestId('status-run')).toHaveText('stopped');
  await expect(dialog.getByTestId('button-resume-run')).toBeEnabled();
  await incomplete(dialog, true);
  noPaidWork(api);
});

test('a genuinely finished empty selection can say no eligible profiles', async ({ page, api }) => {
  api.root = preparing({
    status: 'completed',
    preparation: {
      status: 'ready', mode: 'one_chunk', requested: 12, selected: 0,
      message: 'Selection complete. No eligible profiles remain.',
    },
  });
  await open(page, ROOT);
  const dialog = await monitor(page);
  await expect(dialog.getByTestId('status-run')).toHaveText('completed');
  await expect(dialog.getByTestId('text-run-preparing')).toHaveCount(0);
  await selectionRows(dialog, 'No eligible profiles');
  await expect(dialog).not.toContainText('selection is incomplete');
  await expect(dialog).not.toContainText('eligibility is still being checked');
  await expect(dialog.getByTestId('button-stop-run')).toHaveCount(0);
  await expect(dialog.getByTestId('button-resume-run')).toHaveCount(0);
  noPaidWork(api);
});
