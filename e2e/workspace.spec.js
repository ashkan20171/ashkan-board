import { test, expect } from '@playwright/test';

let sequence = 0;

async function registerUser(page) {
  sequence += 1;
  const email = `e2e-${Date.now()}-${sequence}@example.test`;
  await page.goto('/');
  await page.getByRole('button', { name: /create an account/i }).click();
  await page.getByLabel('Name').fill('E2E Project Owner');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('E2E-Strong-Password-2026!');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: /dashboard|داشبورد/i })).toBeVisible();
  await expect(page.locator('.board')).toBeVisible();
}

test.describe('AshkanBoard browser journeys', () => {
  test('registers a user and creates, searches, edits, and deletes a ticket', async ({ page }) => {
    await registerUser(page);

    await page.getByRole('button', { name: /new ticket/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const title = `E2E ticket ${Date.now()}`;
    await dialog.getByLabel('Ticket Title').fill(title);
    await dialog.locator('#task-description').fill('Created by the browser end-to-end suite.');
    await dialog.getByRole('button', { name: 'Save Changes' }).click();
    await expect(page.getByRole('button', { name: new RegExp(title) })).toBeVisible();

    await page.getByRole('textbox', { name: 'Search tasks or bugs...' }).fill(title);
    const card = page.getByRole('button', { name: new RegExp(title) });
    await expect(card).toBeVisible();
    await card.click();
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Ticket Title').fill(`${title} updated`);
    await dialog.getByRole('button', { name: 'Save Changes' }).click();
    await expect(page.getByRole('button', { name: new RegExp(`${title} updated`) })).toBeVisible();

    await page.getByRole('button', { name: new RegExp(`${title} updated`) }).click();
    page.once('dialog', (confirm) => confirm.accept());
    await dialog.getByRole('button', { name: 'Delete Ticket' }).click();
    await expect(page.getByRole('button', { name: new RegExp(`${title} updated`) })).toHaveCount(0);
  });

  test('rejects an invalid sign-in and allows switching language', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Email').fill('missing-user@example.test');
    await page.getByLabel('Password').fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toContainText(/invalid email or password/i);
    await page.getByRole('button', { name: 'فارسی' }).click();
    await expect(page.getByRole('heading', { name: 'خوش برگشتید' })).toBeVisible();
  });

  test('persists a task across reload and supports priority filtering', async ({ page }) => {
    await registerUser(page);
    await page.getByRole('button', { name: /new ticket/i }).click();
    const dialog = page.getByRole('dialog');
    const title = `Persistent E2E ${Date.now()}`;
    await dialog.getByLabel('Ticket Title').fill(title);
    await dialog.getByLabel('Priority').selectOption('High');
    await dialog.getByRole('button', { name: 'Save Changes' }).click();
    await expect(page.getByRole('button', { name: new RegExp(title) })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: new RegExp(title) })).toBeVisible();
    await page.getByLabel('All Priorities').selectOption('Low');
    await expect(page.getByRole('button', { name: new RegExp(title) })).toHaveCount(0);
    await page.getByLabel('All Priorities').selectOption('High');
    await expect(page.getByRole('button', { name: new RegExp(title) })).toBeVisible();
  });

  test('supports profile update and logout', async ({ page }) => {
    await registerUser(page);
    await page.getByRole('button', { name: /E2E Project Owner/ }).click();
    const profile = page.getByRole('dialog', { name: 'My profile' });
    await expect(profile).toBeVisible();
    await profile.getByLabel('Display name').fill('Updated E2E Owner');
    await profile.getByRole('button', { name: 'Save changes' }).click();
    await expect(profile.getByRole('status')).toContainText('Profile updated successfully');
    await profile.getByRole('button', { name: 'Close' }).click();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  });

  test('renders the workspace on a mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await registerUser(page);
    await expect(page.locator('.content')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open navigation menu' })).toBeVisible();
    await page.getByRole('button', { name: 'Open navigation menu' }).click();
    await expect(page.locator('.sidebar.is-open')).toBeVisible();
  });
});
