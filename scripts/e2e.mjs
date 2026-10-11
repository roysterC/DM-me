// Clicks through the whole app in Chromium and saves screenshots.
// Start a server with fake replies first:
//   DATA_DIR=/tmp/dmme-e2e DM_ME_FAKE_AI=1 ADMIN_PASSWORD=letmein TYPING_SPEED=40 PORT=3456 npm start
// (TYPING_SPEED=40 keeps reply timing on, just faster than the default, so the run stays quick.)
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
await page.getByRole('heading', { name: 'Alisa' }).waitFor();
await shot('02-chat-empty');

step('text burst gets one reply');
const input = page.getByLabel('Message Alisa');
await input.fill('ok be honest');
await input.press('Enter');
await input.fill('is it weird to text an AI at 9pm about dinner');
await page.getByRole('button', { name: 'Send', exact: true }).click();
// She's "typing" for a while before her bubble shows up.
await page.getByRole('status', { name: 'Alisa is typing' }).waitFor({ timeout: 5_000 });
if (await page.getByText('You said: ok be honest is it weird').count()) throw new Error('Reply showed up without typing first');
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
await page.getByRole('heading', { name: 'Alisa' }).waitFor();
await shot('17-light');

step('reply with the mouse: hover a message, click Reply');
await page.emulateMedia({ colorScheme: 'dark' });
await input.fill('first thing');
await input.press('Enter');
await page.getByText('You said: first thing').waitFor({ timeout: 10_000 });
const hers = page.locator('.msg-theirs', { hasText: 'You said: first thing' });
await hers.hover();
await hers.getByRole('button', { name: 'Reply' }).click();
await page.getByText('Replying to Alisa').waitFor();
await input.fill('replying with the mouse');
await input.press('Enter');
await page.getByText('You replied to Alisa').waitFor();
if (await page.getByText('Replying to Alisa').count()) throw new Error('Reply bar should close after sending');

// ---- A phone: touch gestures, the floating bars and the scrolling gradient ----
const phone = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
  hasTouch: true,
  isMobile: true,
  locale: 'en-GB',
});
const tp = await phone.newPage();
tp.on('pageerror', (e) => errors.push(String(e)));
tp.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const cdp = await phone.newCDPSession(tp);
const touch = (type, x, y) =>
  cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
/** Drags a finger from (x, y) by dx; with `hold`, stops before lifting it. */
const drag = async (x, y, dx, { hold = false } = {}) => {
  await touch('touchStart', x, y);
  for (let i = 1; i <= 12; i++) {
    await touch('touchMove', x + (dx * i) / 12, y);
    await tp.waitForTimeout(16);
  }
  if (!hold) await touch('touchEnd', 0, 0);
};
const tInput = tp.getByLabel('Message Alisa');
const shotPhone = async (name) => {
  await tp.waitForTimeout(250);
  await tp.screenshot({ path: path.join(out, `${name}.png`) });
};

step('phone: a long chat scrolls under the translucent bars, bubbles shade purple to blue');
await tp.goto(base);
await tp.getByRole('heading', { name: 'Alisa' }).waitFor();
for (const text of ['hey', 'so i had the weirdest day', 'like genuinely', 'my employer missed my exam signup twice', 'i emailed them four times', 'now im months behind', 'anyway', 'how r u']) {
  await tInput.fill(text);
  await tInput.press('Enter');
}
await tp.getByText('You said: hey so i had').waitFor({ timeout: 15_000 });
const blur = await tp.locator('.chat-header').evaluate((el) => getComputedStyle(el).backdropFilter || getComputedStyle(el).webkitBackdropFilter);
if (!/blur/.test(blur)) throw new Error(`Header isn't blurred: ${blur}`);
const fillY = (text) => tp.getByText(text, { exact: true }).evaluate((el) => getComputedStyle(el).backgroundPositionY);
const topY = await fillY('hey');
const bottomY = await fillY('how r u');
if (topY === bottomY) throw new Error('Bubbles at different heights should show different parts of the gradient');
await tp.locator('.thread').evaluate((el) => el.scrollBy(0, -200));
await tp.waitForTimeout(200);
if ((await fillY('how r u')) === bottomY) throw new Error('The gradient should move with scrolling');
await tp.locator('.thread').evaluate((el) => el.scrollTo(0, el.scrollHeight));
await tp.waitForTimeout(300);
await shotPhone('18-phone-gradient');

step('phone: swipe the chat left to see the times');
const row = await tp.getByText('now im months behind', { exact: true }).boundingBox();
await drag(300, row.y + row.height / 2, -120, { hold: true });
const time = tp.locator('.msg-mine', { hasText: 'now im months behind' }).locator('.msg-time');
const shown = await time.evaluate((el) => ({ opacity: Number(getComputedStyle(el).opacity), right: el.getBoundingClientRect().right }));
if (shown.opacity < 0.9 || shown.right > 390) throw new Error(`Time should be fully visible mid-swipe: ${JSON.stringify(shown)}`);
await shotPhone('19-phone-times');
await touch('touchEnd', 0, 0);
await tp.waitForTimeout(400);
if (Number(await time.evaluate((el) => getComputedStyle(el).opacity)) > 0.05) throw new Error('Times should hide on release');

step('phone: swipe one of Alisa’s messages right to reply');
const herBubble = await tp.locator('.msg-theirs .bubble').last().boundingBox();
await drag(herBubble.x + 30, herBubble.y + herBubble.height / 2, 110);
await tp.getByText('Replying to Alisa').waitFor();
await shotPhone('20-phone-reply-bar');
await tInput.fill('wait which part');
await tInput.press('Enter');
await tp.getByText('You replied to Alisa').waitFor();
await tp.waitForTimeout(400);
await shotPhone('21-phone-quoted');

step('phone: tap a quote to jump to the original');
await tp.locator('.thread').evaluate((el) => el.scrollTo(0, 0));
await tp.locator('.reply-quote-text').last().evaluate((el) => el.click());
await tp.waitForFunction(() => document.querySelector('.msg.flash'));

await phone.close();
await browser.close();
if (errors.length) {
  console.error('Browser errors:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('E2E passed');
