// The demo's journeys, written with `snap`. Each call is one screen on the board, in the order a user meets them.
import { test } from 'journeyboard/playwright';

test('a new customer signs up', async ({ page, snap }) => {
  await page.goto('/');
  await snap('signup/landing', { title: 'Landing' });
  await page.getByRole('link', { name: 'Get started' }).click();
  await snap('signup/account', { title: 'Create your account' });
  await page.getByRole('button', { name: 'Continue' }).click();
  await snap('signup/workspace', { title: 'Name your workspace' });
  await page.getByRole('button', { name: 'Continue' }).click();
  await snap('signup/done', { title: "You're all set" });
});

test('sends the first invoice', async ({ page, snap }) => {
  await page.goto('/signup-done.html');
  await page.getByRole('link', { name: 'Create an invoice' }).click();
  // This test starts where the sign-up test ended, so the board draws an arrow from there.
  await snap('invoicing/new', { title: 'New invoice', from: 'signup/done' });
  await page.getByRole('button', { name: 'Send invoice' }).click();
  await snap('invoicing/sent', { title: 'Invoice sent' });
  await page.getByRole('link', { name: 'Back to invoices' }).click();
  await snap('invoicing/list', { title: 'Invoices' });
});

test('checks settings', async ({ page, snap }) => {
  await page.goto('/invoices.html');
  await page.getByRole('link', { name: 'Settings' }).click();
  // The email and IBAN carry data-journeyboard-mask, so they are blacked out.
  await snap('settings/account', { title: 'Settings', from: 'invoicing/list' });
});
