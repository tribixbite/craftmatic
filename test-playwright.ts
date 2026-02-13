/**
 * Playwright test script for Craftmatic web app.
 * Exercises all major features on the deployed GitHub Pages site.
 * Uses system chromium via X11 (DISPLAY=:1).
 */

import { chromium, type Browser, type Page } from 'playwright-core';

const URL = process.env.TEST_URL || 'http://localhost:3000/';
const SCREENSHOT_DIR = '/data/data/com.termux/files/home/git/craftmatic/test-screenshots';

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function screenshot(page: Page, name: string) {
  const path = `${SCREENSHOT_DIR}/${name}.png`;
  await page.screenshot({ path, fullPage: false });
  console.log(`  Screenshot: ${path}`);
}

async function main() {
  console.log('Launching Chromium...');
  const browser: Browser = await chromium.launch({
    executablePath: '/data/data/com.termux/files/usr/bin/chromium-browser',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    headless: false,
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page: Page = await context.newPage();

  try {
    // ─── Test 1: Page Load ─────────────────────────────────────────────
    console.log('\n[Test 1] Page Load');
    await page.goto(URL, { waitUntil: 'networkidle' });
    const title = await page.title();
    console.log(`  Title: ${title}`);
    console.assert(title.includes('Craftmatic'), 'Title should contain Craftmatic');

    // Check nav tabs exist
    const tabs = await page.$$('.nav-tab');
    console.log(`  Nav tabs: ${tabs.length}`);
    console.assert(tabs.length === 3, 'Should have 3 nav tabs');

    await screenshot(page, '01-page-load');

    // ─── Test 2: Generate Tab ──────────────────────────────────────────
    console.log('\n[Test 2] Generate Tab - Structure Generation');

    // Check generator controls exist
    const typeSelect = page.locator('#gen-type');
    await typeSelect.waitFor({ state: 'visible' });
    console.log('  Generator controls visible');

    // Select "Castle" type
    await typeSelect.selectOption('castle');
    console.log('  Selected: castle');

    // Click "Gothic" style chip
    const gothicChip = page.locator('.style-chip[data-style="gothic"]');
    await gothicChip.click();
    console.log('  Selected style: gothic');

    // Set floors to 3
    const floorsInput = page.locator('#gen-floors');
    await floorsInput.fill('3');
    console.log('  Set floors: 3');

    await screenshot(page, '02-generator-config');

    // Click Generate
    const genBtn = page.locator('#gen-btn');
    await genBtn.click();
    console.log('  Clicked Generate');

    // Wait for viewer to appear
    await sleep(3000);
    const inlineCanvas = page.locator('#generator-viewer canvas');
    const canvasVisible = await inlineCanvas.isVisible();
    console.log(`  Inline viewer canvas visible: ${canvasVisible}`);

    await screenshot(page, '03-generated-structure');

    // Click Expand button
    const expandBtn = page.locator('#inline-expand');
    if (await expandBtn.isVisible()) {
      await expandBtn.click();
      console.log('  Expanded to full viewer');
      await sleep(1000);
      await screenshot(page, '04-full-viewer');

      // Test cutaway button
      const cutawayBtn = page.locator('#btn-cutaway');
      await cutawayBtn.click();
      console.log('  Opened cutaway panel');
      await sleep(500);

      // Move cutaway slider
      const slider = page.locator('#cutaway-slider');
      await slider.fill('5');
      await slider.dispatchEvent('input');
      await sleep(500);
      await screenshot(page, '05-cutaway-view');

      // Close viewer
      const closeBtn = page.locator('#btn-close-viewer');
      await closeBtn.click();
      console.log('  Closed full viewer');
      await sleep(500);
    }

    // ─── Test 3: Upload Tab ────────────────────────────────────────────
    console.log('\n[Test 3] Upload Tab');
    const uploadTab = page.locator('.nav-tab[data-tab="upload"]');
    await uploadTab.click();
    await sleep(500);

    const uploadZone = page.locator('#upload-zone');
    const uploadVisible = await uploadZone.isVisible();
    console.log(`  Upload zone visible: ${uploadVisible}`);

    await screenshot(page, '06-upload-tab');

    // ─── Test 4: Gallery Tab ───────────────────────────────────────────
    console.log('\n[Test 4] Gallery Tab');
    const galleryTab = page.locator('.nav-tab[data-tab="gallery"]');
    await galleryTab.click();
    await sleep(2000); // Wait for lazy thumbnail generation

    const cards = await page.$$('.gallery-card');
    console.log(`  Gallery cards: ${cards.length}`);
    console.assert(cards.length >= 12, 'Should have >= 12 gallery cards');

    await screenshot(page, '07-gallery');

    // Click first gallery card
    if (cards.length > 0) {
      await cards[0].click();
      console.log('  Clicked first gallery card');
      await sleep(2000);

      const viewerOverlay = page.locator('#viewer-overlay');
      const overlayVisible = await viewerOverlay.isVisible();
      console.log(`  Viewer overlay visible: ${overlayVisible}`);

      await screenshot(page, '08-gallery-viewer');

      // Test export buttons exist
      const glbBtn = page.locator('#btn-export-glb');
      const schemBtn = page.locator('#btn-export-schem');
      const htmlBtn = page.locator('#btn-export-html');
      console.log(`  Export GLB btn: ${await glbBtn.isVisible()}`);
      console.log(`  Export .schem btn: ${await schemBtn.isVisible()}`);
      console.log(`  Export HTML btn: ${await htmlBtn.isVisible()}`);

      // Close viewer
      await page.locator('#btn-close-viewer').click();
      await sleep(500);
    }

    // ─── Test 5: Randomize & Generate ──────────────────────────────────
    console.log('\n[Test 5] Randomize & Generate');
    const genTab = page.locator('.nav-tab[data-tab="generate"]');
    await genTab.click();
    await sleep(500);

    const randomBtn = page.locator('#gen-random-btn');
    await randomBtn.click();
    console.log('  Clicked Randomize & Generate');
    await sleep(3000);

    await screenshot(page, '09-randomized');

    // ─── Test 6: Mobile Viewport ───────────────────────────────────────
    console.log('\n[Test 6] Mobile Viewport');
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(500);

    await screenshot(page, '10-mobile-generate');

    // Check gallery on mobile
    await galleryTab.click();
    await sleep(1000);
    await screenshot(page, '11-mobile-gallery');

    // Check upload on mobile
    await uploadTab.click();
    await sleep(500);
    await screenshot(page, '12-mobile-upload');

    // ─── Test 7: Console Errors ────────────────────────────────────────
    console.log('\n[Test 7] Console Error Check');
    const consoleErrors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    // Reload fresh to catch any errors
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.reload({ waitUntil: 'networkidle' });
    await sleep(2000);
    console.log(`  Console errors: ${consoleErrors.length}`);
    if (consoleErrors.length > 0) {
      consoleErrors.forEach(e => console.log(`    ERROR: ${e}`));
    }

    console.log('\n=== All Tests Complete ===\n');

  } catch (err) {
    console.error('Test failed:', err);
    await screenshot(page, 'error-state');
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
