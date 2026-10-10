// Clicks through the whole app in Chromium and saves screenshots.
// Start a server with fake replies first:
//   DATA_DIR=/tmp/dmme-e2e DM_ME_FAKE_AI=1 ADMIN_PASSWORD=letmein PORT=3456 npm start
// then: node scripts/e2e.mjs [baseUrl] [outDir]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const base = process.argv[2] ?? 'http://localhost:3456';
const out = process.argv[3] ?? 'test-results/screens';
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
  permissions: ['camera'],
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

const shot = async (name) => {
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  console.log('saved', name);
};
const step = (label) => console.log(`- ${label}`);

step('open the chat (no sign-up)');
await page.goto(base);
await page.getByText('Hey, I’m Alisa').waitFor();
await shot('02-chat-empty');

step('text burst gets one reply');
const input = page.getByLabel('Message Alisa');
await input.fill('ok be honest');
await input.press('Enter');
await input.fill('is it weird to text an AI at 9pm about dinner');
await page.getByRole('button', { name: 'Send', exact: true }).click();
await page.getByText('You said: ok be honest is it weird').waitFor({ timeout: 10_000 });
await page.getByText('Seen').waitFor({ state: 'detached' }).catch(() => {});
await shot('03-chat-reply');

step('Alisa sends a view-once photo');
await input.fill('send me a photo of dinner');
await input.press('Enter');
const tapToView = page.getByRole('button', { name: /Photo from Alisa\. Tap to view/ });
await tapToView.waitFor({ timeout: 10_000 });
await shot('04-received-view-once');
await tapToView.click();
await page.getByRole('dialog', { name: 'Photo from Alisa' }).waitFor();
await page.waitForTimeout(1500);
await shot('05-photo-viewer');
await page.getByRole('dialog', { name: 'Photo from Alisa' }).waitFor({ state: 'detached', timeout: 8000 });
await page.getByText('Opened').first().waitFor();
await shot('06-photo-opened');

step('double-tap to heart Alisa’s message');
await page.getByText('You said: send me a photo of dinner').dblclick();
await page.getByRole('button', { name: 'Remove your heart' }).waitFor();

step('send a view-once photo from the library');
await page.locator('input[type=file]').first().setInputFiles(path.resolve('server/assets/skillet.jpg'));
await page.getByRole('dialog', { name: 'Send photo' }).waitFor();
await page.getByRole('radio', { name: 'View once' }).click();
await shot('07-send-photo-sheet');
await page.getByRole('dialog', { name: 'Send photo' }).getByRole('button', { name: 'Send', exact: true }).click();
await page.getByText('Golden edges and everything.').waitFor({ timeout: 10_000 });
await page.waitForTimeout(400);
await shot('08-sent-photo-opened');

step('camera');
await page.getByRole('button', { name: 'Camera' }).click();
await page.getByRole('button', { name: 'Take photo' }).waitFor();
await page.waitForTimeout(800);
await shot('09-camera');
await page.getByRole('button', { name: 'Take photo' }).click();
await page.getByRole('dialog', { name: 'Send photo' }).waitFor();
await page.getByRole('radio', { name: 'Keep in chat' }).click();
await page.getByRole('dialog', { name: 'Send photo' }).getByRole('button', { name: 'Send', exact: true }).click();
await page.getByRole('dialog', { name: 'Send photo' }).waitFor({ state: 'detached' });
await page.waitForTimeout(3500);
await shot('10-after-camera');

step('stories');
await page.getByRole('button', { name: 'View Alisa’s story' }).first().click();
const story = page.getByRole('dialog', { name: 'Alisa’s story' });
await story.waitFor();
await page.waitForTimeout(1200);
await shot('11-story-1');
await page.getByRole('button', { name: 'Next story' }).click();
await page.waitForTimeout(600);
await shot('12-story-2-text');
await page.getByLabel('Reply to Alisa’s story').fill('dinner');
await page.getByRole('button', { name: 'Send reply' }).click();
await page.getByText('Sent').waitFor();
await page.getByRole('button', { name: 'Close story' }).click();
await page.getByText('You replied to their story').waitFor();
await page.waitForTimeout(3000);
await shot('13-story-reply');

step('admin: unlock, camera roll, stories');
await page.goto(`${base}/admin`);
await page.getByLabel('Admin password').fill('letmein');
await page.getByRole('button', { name: 'Unlock' }).click();
await page.getByText('Sample photo').first().waitFor();
await page.locator('input[type=file]').setInputFiles(path.resolve('server/assets/coffee.jpg'));
await page.getByRole('button', { name: 'Add to camera roll' }).click();
await page.getByRole('heading', { name: '5 photos' }).waitFor({ timeout: 10_000 });
// The fake Alisa always sends her oldest photo (last in the list) as view-once; make it stay in the chat instead.
await page.getByLabel('Sends as').last().selectOption('keep');
await page.waitForTimeout(500);
await page.reload();
await page.getByRole('heading', { name: '5 photos' }).waitFor();
if ((await page.getByLabel('Sends as').last().inputValue()) !== 'keep') throw new Error('Send mode was not saved');
await shot('14-admin-camera-roll');
await page.getByRole('tab', { name: 'Stories' }).click();
await page.getByRole('radio', { name: 'Text story' }).click();
await page.getByLabel('Text').fill('New this week: ask me for a 3-day itinerary');
await page.getByRole('button', { name: 'Post story' }).click();
await page.getByText('New this week').waitFor();
await shot('15-admin-stories');
await page.getByRole('link', { name: 'Back to chat' }).click();
await input.fill('one more photo please');
await input.press('Enter');
await page.getByRole('img', { name: 'Photo from Alisa' }).last().waitFor({ timeout: 10_000 });
await shot('15b-kept-photo-from-alisa');

step('profile sheet and delete chat');
await page.getByRole('button', { name: 'About Alisa' }).click();
const sheet = page.getByRole('dialog', { name: 'About Alisa' });
await sheet.waitFor();
await sheet.getByRole('button', { name: 'Delete chat' }).click();
await shot('16-delete-confirm');
await sheet.getByRole('button', { name: 'Delete chat' }).click();
await sheet.waitFor({ state: 'detached' });
await page.getByText('You replied to their story').waitFor({ state: 'detached' });

step('light mode');
await page.emulateMedia({ colorScheme: 'light' });
await page.getByText('Hey, I’m Alisa').waitFor();
await shot('17-light');

await browser.close();
if (errors.length) {
  console.error('Browser errors:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('E2E passed');
