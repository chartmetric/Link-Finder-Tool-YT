import type { Page } from '@playwright/test';
import { test, expect, open, poll, ROOT } from './progress-fixtures';
import { CREDIT_REASON, creditRun, draining, stopped } from './credit-stop-fixtures';

const summary = (page: Page) => page.getByTestId('section-run-progress');
const monitor = (page: Page) => page.getByTestId('dialog-run-monitor');

test.beforeEach(async ({ api }) => {
  // Observing credit stops must never acknowledge recovery or resume paid work.
  api.readOnly = true;
});

async function openMonitor(page: Page) {
  await page.getByTestId('button-rp-open-detail').click();
  await expect(monitor(page)).toBeVisible();
}

async function closeMonitor(page: Page) {
  // Use the accessible close button, not the explicit Stop action.
  await monitor(page).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(monitor(page)).toHaveCount(0);
  await expect(page.getByTestId('button-rp-open-detail')).toBeFocused();
}

async function automaticReason(page: Page, terminal = false) {
  const reason = page.getByTestId(terminal ? 'text-rp-terminal' : 'text-rp-auto-stop');
  await expect(reason).toBeVisible();
  await expect(reason).toContainText(CREDIT_REASON);
  await expect(summary(page)).not.toContainText(/stopped by request|user.requested|stopped by (you|user)/i);
}

async function monitorReason(page: Page, status: 'stopping' | 'stopped') {
  await expect(monitor(page).getByTestId('status-run')).toHaveText(status);
  // RunDetail renders errors on individual failed items too. Assert the
  // run-level alert, not merely any incidental occurrence of the reason.
  const alert = monitor(page).getByRole('alert').filter({ hasText: 'Run error:' });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText(CREDIT_REASON);
  await expect(monitor(page)).not.toContainText(/stopped by request|user.requested|stopped by (you|user)/i);
}

async function widgetReason(page: Page, status: 'stopping' | 'stopped') {
  await page.getByTestId('button-toggle-widget').click();
  await expect(page.getByTestId('status-widget-run')).toContainText(status);
  await expect(page.getByTestId('text-widget-run-error')).toBeVisible();
  await expect(page.getByTestId('text-widget-run-error')).toHaveText(CREDIT_REASON);
  if (status === 'stopping') {
    await expect(page.getByTestId('button-widget-stop')).toBeDisabled();
    await expect(page.getByTestId('button-widget-resume')).toHaveCount(0);
  } else {
    await expect(page.getByTestId('button-widget-stop')).toHaveCount(0);
    await expect(page.getByTestId('button-widget-resume')).toBeEnabled();
  }
  await page.getByTestId('button-toggle-widget').click();
}

for (const multiTypeContinuous of [false, true]) {
  test(`${multiTypeContinuous ? 'mixed-type continuous' : 'single-batch'} credit stop drains, persists and never retries on monitor reopen`, async ({ page, api }) => {
    api.root = creditRun(multiTypeContinuous);
    await open(page, ROOT);
    await expect(page.getByTestId('status-rp')).toHaveText('running');
    await expect(page.getByTestId('text-rp-auto-stop')).toHaveCount(0);
    await openMonitor(page);
    await expect(monitor(page).getByTestId('status-run')).toHaveText('running');

    api.root = draining(api.root);
    await poll(page, api);
    await expect(page.getByTestId('status-rp')).toHaveText('stopping');
    await monitorReason(page, 'stopping');
    await expect(monitor(page).getByTestId('button-stop-run')).toBeDisabled();
    await expect(monitor(page).getByTestId('button-resume-run')).toHaveCount(0);
    await closeMonitor(page);
    await automaticReason(page);
    // Compact progress is scoped to brands; the draining lane in the mixed
    // run is a creator, visible in the all-types monitor rather than here.
    await expect(page.getByTestId('text-rp-running')).toHaveText(multiTypeContinuous ? '0' : '1');
    await expect(page.getByTestId('text-rp-queued')).toHaveText(multiTypeContinuous ? '1' : '2');
    await widgetReason(page, 'stopping');

    // Closing does not resume, and does not prevent the active root polling.
    await poll(page, api);
    await automaticReason(page);
    await openMonitor(page);
    await monitorReason(page, 'stopping');
    await closeMonitor(page);

    // A fresh QueryClient must hydrate the draining reason from the API.
    await page.reload();
    await expect(page.getByTestId('status-rp')).toHaveText('stopping');
    await automaticReason(page);
    await openMonitor(page);
    await monitorReason(page, 'stopping');

    api.root = stopped(api.root);
    await poll(page, api);
    await monitorReason(page, 'stopped');
    await expect(monitor(page).getByTestId('button-stop-run')).toHaveCount(0);
    await expect(monitor(page).getByTestId('button-resume-run')).toBeEnabled();
    await closeMonitor(page);
    await expect(page.getByTestId('status-rp')).toHaveText('stopped');
    await automaticReason(page, true);
    await expect(page.getByTestId('text-rp-running')).toHaveText('0');
    await expect(page.getByTestId('text-rp-queued')).toHaveText(multiTypeContinuous ? '1' : '2');
    await widgetReason(page, 'stopped');

    await page.reload();
    await automaticReason(page, true);
    await expect(page.getByTestId('status-rp-sync')).toHaveText('Final state');
    await openMonitor(page);
    await monitorReason(page, 'stopped');
    await closeMonitor(page);
    await openMonitor(page);
    await monitorReason(page, 'stopped');
    // Allow the monitor's saved-state refresh interval too. GETs are fine;
    // starts, resumes, stop requests and every other write must remain absent.
    await poll(page, api, ROOT, 10_100);
    await monitorReason(page, 'stopped');
    await closeMonitor(page);
    expect(api.root.items.filter(item => item.status === 'queued')).toHaveLength(2);
    expect(api.starts).toEqual([]);
    expect(api.writes).toEqual([]);
  });
}

test('a saved automatic stop opened cold keeps its billing reason without user-stop wording', async ({ page, api }) => {
  api.root = stopped(draining(creditRun()));
  await open(page, ROOT);
  await automaticReason(page, true);
  await openMonitor(page);
  await monitorReason(page, 'stopped');
  await closeMonitor(page);
  await widgetReason(page, 'stopped');
  expect(api.starts).toEqual([]);
  expect(api.writes).toEqual([]);
});

test('shared billing blocks saved Resume controls until a read reports recovery without resuming', async ({ page, api }) => {
  api.root = stopped(draining(creditRun()));
  api.billingHealth = { outages: [{
    provider: 'OpenRouter', httpStatus: 402, incidentId: 'fixture-credit-outage',
    observedAt: '2026-10-27T12:00:03.000Z',
  }] };
  await open(page, ROOT);
  await openMonitor(page);
  await monitorReason(page, 'stopped');
  await expect(monitor(page).getByTestId('billing-outage-OpenRouter')).toBeVisible();
  await expect(monitor(page).getByTestId('button-resume-run')).toBeDisabled();
  await closeMonitor(page);
  await page.getByTestId('button-toggle-widget').click();
  await expect(page.getByTestId('button-widget-resume')).toBeDisabled();
  await page.getByTestId('button-toggle-widget').click();

  // Funding was acknowledged elsewhere. Only the read-only polling response
  // changes here: neither a recovery POST nor a Resume POST is permitted.
  api.billingHealth = { outages: [] };
  const reads = api.billingHealthReads;
  await page.clock.fastForward(5100);
  await expect.poll(() => api.billingHealthReads).toBeGreaterThan(reads);
  await widgetReason(page, 'stopped');
  await openMonitor(page);
  await expect(monitor(page).getByTestId('button-resume-run')).toBeEnabled();
  await monitorReason(page, 'stopped');
  await closeMonitor(page);
  expect(api.starts).toEqual([]);
  expect(api.mutations).toEqual([]);
  expect(api.writes).toEqual([]);
});
