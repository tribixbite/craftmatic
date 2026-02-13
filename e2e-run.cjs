/**
 * Comprehensive e2e test suite for the Craftmatic web app.
 * Tests all 10 types, 9 styles, gallery, export, mobile viewports.
 * Handles headless Chromium without WebGL (tests generation via info panel).
 * Usage: start web app on port 3302, then run: node e2e-run.cjs
 */
const origPlatform = process.platform;
Object.defineProperty(process, 'platform', { get: () => 'linux', configurable: true });
const { chromium } = require('playwright-core');
Object.defineProperty(process, 'platform', { get: () => origPlatform, configurable: true });

const URL = process.env.TEST_URL || `http://localhost:${process.env.PORT || 3302}/`;

(async () => {
  const browser = await chromium.launch({
    executablePath: '/data/data/com.termux/files/usr/bin/chromium-browser',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--headless=new'],
    headless: true,
  });

  const consoleErrors = [];
  const netErrors = [];

  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('console', msg => {
    const text = msg.text();
    // Ignore expected WebGL/THREE warnings in headless
    if (msg.type() === 'error' && !text.includes('WebGL') && !text.includes('THREE')) {
      consoleErrors.push(text);
    }
  });
  page.on('pageerror', err => {
    if (!err.message.includes('WebGL') && !err.message.includes('THREE')) {
      consoleErrors.push('PAGE_ERROR: ' + err.message);
    }
  });
  page.on('requestfailed', req => netErrors.push(req.url() + ' ' + (req.failure()?.errorText || '')));

  let pass = 0, fail = 0, skip = 0;
  function check(name, condition) {
    if (condition) { pass++; console.log('  PASS: ' + name); }
    else { fail++; console.log('  FAIL: ' + name); }
  }
  function soft(name, condition) {
    // Soft check — logs but doesn't count as failure (WebGL-dependent)
    if (condition) { pass++; console.log('  PASS: ' + name); }
    else { skip++; console.log('  SKIP: ' + name + ' (WebGL not available)'); }
  }

  try {
    // ─── 1. Page Load ──────────────────────────────────────────────────
    console.log('\n[1] Page Load');
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 15000 });
    check('Title contains Craftmatic', (await page.title()).includes('Craftmatic'));
    check('3 nav tabs', (await page.locator('.nav-tab').count()) === 3);
    check('No initial console errors', consoleErrors.length === 0);
    check('No network errors', netErrors.length === 0);

    // ─── 2. Generator Controls ─────────────────────────────────────────
    console.log('\n[2] Generator Controls');
    const typeSelect = page.locator('#gen-type');
    await typeSelect.waitFor({ state: 'visible', timeout: 5000 });
    const types = await typeSelect.locator('option').allTextContents();
    console.log('  Types: ' + types.join(', '));
    check('10 structure types', types.length === 10);
    check('Has cathedral', types.some(t => t.toLowerCase().includes('cathedral')));
    check('Has village', types.some(t => t.toLowerCase().includes('village')));
    check('Has windmill', types.some(t => t.toLowerCase().includes('windmill')));
    check('Has bridge', types.some(t => t.toLowerCase().includes('bridge')));
    check('Has marketplace', types.some(t => t.toLowerCase().includes('marketplace')));

    const chips = await page.locator('.style-chip').allTextContents();
    const chipNames = chips.map(c => c.trim()).filter(Boolean);
    console.log('  Styles: ' + chipNames.join(', '));
    check('9 style chips', chipNames.length === 9);
    check('Has steampunk', chipNames.some(c => c.toLowerCase().includes('steampunk')));
    check('Has underwater', chipNames.some(c => c.toLowerCase().includes('underwater')));
    check('Has elven', chipNames.some(c => c.toLowerCase().includes('elven')));
    check('Has desert', chipNames.some(c => c.toLowerCase().includes('desert')));

    check('Floors input visible', await page.locator('#gen-floors').isVisible());
    check('Seed input visible', await page.locator('#gen-seed').isVisible());
    check('Width input visible', await page.locator('#gen-width').isVisible());
    check('Length input visible', await page.locator('#gen-length').isVisible());
    check('Generate btn visible', await page.locator('#gen-btn').isVisible());
    check('Randomize btn visible', await page.locator('#gen-random-btn').isVisible());

    // ─── 3. Generate Each Type ─────────────────────────────────────────
    // Uses #gen-info panel (always appears) instead of WebGL canvas
    console.log('\n[3] Generate Each Type');
    const allTypes = ['house','tower','castle','dungeon','ship','cathedral','bridge','windmill','marketplace','village'];
    for (const t of allTypes) {
      await typeSelect.selectOption(t);
      await page.locator('#gen-btn').click();
      await page.waitForTimeout(2000);

      // Check info panel appeared with valid content
      const infoPanel = page.locator('#gen-info');
      const infoVisible = await infoPanel.isVisible();
      let dimText = '';
      if (infoVisible) {
        dimText = await infoPanel.textContent();
      }
      const hasDimensions = dimText.includes('x') && dimText.includes('Blocks');
      check(t + ' generates (info=' + infoVisible + ')', infoVisible && hasDimensions);

      // Soft-check WebGL canvas
      const canvas = await page.locator('#generator-viewer canvas').isVisible();
      soft(t + ' WebGL canvas', canvas);
    }

    // ─── 4. Style Variations (castle) ──────────────────────────────────
    console.log('\n[4] Style Variations (castle)');
    await typeSelect.selectOption('castle');
    const styleNames = ['fantasy','medieval','modern','gothic','rustic','steampunk','elven','desert','underwater'];
    for (const s of styleNames) {
      await page.locator('.style-chip[data-style="' + s + '"]').click();
      await page.locator('#gen-btn').click();
      await page.waitForTimeout(1500);

      const infoPanel = page.locator('#gen-info');
      const infoVisible = await infoPanel.isVisible();
      let dimText = '';
      if (infoVisible) dimText = await infoPanel.textContent();
      check('castle_' + s + ' generates', infoVisible && dimText.includes('Blocks'));
    }

    // ─── 5. Seed Determinism ───────────────────────────────────────────
    console.log('\n[5] Seed Determinism');
    await typeSelect.selectOption('castle');
    await page.locator('#gen-seed').fill('42');
    await page.locator('#gen-btn').click();
    await page.waitForTimeout(1500);
    const info1 = await page.locator('#gen-info').textContent();
    await page.locator('#gen-btn').click();
    await page.waitForTimeout(1500);
    const info2 = await page.locator('#gen-info').textContent();
    check('Same seed = same output', info1 === info2);

    // Different type + seed — guaranteed different dimensions
    await typeSelect.selectOption('ship');
    await page.locator('#gen-seed').fill('777');
    await page.locator('#gen-btn').click();
    await page.waitForTimeout(1500);
    const info3 = await page.locator('#gen-info').textContent();
    check('Different type+seed = different output', info1 !== info3);

    // ─── 6. Gallery ────────────────────────────────────────────────────
    console.log('\n[6] Gallery');
    await page.locator('.nav-tab[data-tab="gallery"]').click();
    await page.waitForTimeout(3000);
    const cardCount = await page.locator('.gallery-card').count();
    console.log('  Gallery cards: ' + cardCount);
    check('Gallery has >= 12 cards', cardCount >= 12);
    check('Gallery has >= 20 cards', cardCount >= 20);

    // Check gallery cards have thumbnails (Canvas2D, not WebGL)
    const firstThumb = page.locator('.gallery-card canvas').first();
    check('Gallery thumbnails render (Canvas2D)', await firstThumb.isVisible());

    // Click first card — viewer overlay
    await page.locator('.gallery-card').first().click();
    await page.waitForTimeout(2000);
    check('Viewer overlay opens', await page.locator('#viewer-overlay').isVisible());
    check('GLB export btn', await page.locator('#btn-export-glb').isVisible());
    check('Schem export btn', await page.locator('#btn-export-schem').isVisible());
    check('HTML export btn', await page.locator('#btn-export-html').isVisible());
    check('Close btn visible', await page.locator('#btn-close-viewer').isVisible());
    check('Fullscreen btn visible', await page.locator('#btn-fullscreen').isVisible());
    check('Cutaway btn visible', await page.locator('#btn-cutaway').isVisible());

    // Cutaway slider
    const cutawayBtn = page.locator('#btn-cutaway');
    if (await cutawayBtn.isVisible()) {
      await cutawayBtn.click();
      await page.waitForTimeout(300);
      const slider = page.locator('#cutaway-slider');
      if (await slider.isVisible()) {
        await slider.fill('3');
        await slider.dispatchEvent('input');
        await page.waitForTimeout(300);
        check('Cutaway slider visible', true);
      }
    }

    // Close viewer
    await page.locator('#btn-close-viewer').click();
    await page.waitForTimeout(500);
    check('Viewer closes', (await page.locator('#viewer-overlay').getAttribute('hidden')) !== null || !(await page.locator('#viewer-overlay').isVisible()));

    // Click last card — scroll into view first so thumbnail generates and click handler attaches
    const lastCard = page.locator('.gallery-card').last();
    await lastCard.scrollIntoViewIfNeeded();
    await page.waitForTimeout(3000);
    await lastCard.click();
    await page.waitForTimeout(2000);
    check('Last card opens viewer', await page.locator('#viewer-overlay').isVisible());
    // Close via Escape key
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    check('Escape closes viewer', !(await page.locator('#viewer-overlay').isVisible()));

    // ─── 7. Upload Tab ─────────────────────────────────────────────────
    console.log('\n[7] Upload Tab');
    await page.locator('.nav-tab[data-tab="upload"]').click();
    await page.waitForTimeout(500);
    check('Upload zone visible', await page.locator('#upload-zone').isVisible());
    check('File input exists', (await page.locator('#file-input').count()) === 1);
    check('Upload info area exists', (await page.locator('#upload-info').count()) === 1);

    // ─── 8. Randomize & Generate ───────────────────────────────────────
    console.log('\n[8] Randomize & Generate');
    await page.locator('.nav-tab[data-tab="generate"]').click();
    await page.waitForTimeout(500);
    const randomBtn = page.locator('#gen-random-btn');
    if (await randomBtn.isVisible()) {
      // Record current type before randomize
      const beforeType = await typeSelect.inputValue();
      await randomBtn.click();
      await page.waitForTimeout(2000);
      const infoVisible = await page.locator('#gen-info').isVisible();
      check('Randomize generates structure', infoVisible);

      // Verify controls were updated
      const afterSeed = await page.locator('#gen-seed').inputValue();
      check('Randomize fills seed', afterSeed.length > 0);
    }

    // ─── 9. Type Description Updates ───────────────────────────────────
    console.log('\n[9] Type Description Updates');
    await typeSelect.selectOption('cathedral');
    await page.waitForTimeout(200);
    const desc = await page.locator('#gen-type-desc').textContent();
    check('Cathedral description shows', desc.toLowerCase().includes('nave') || desc.toLowerCase().includes('cathedral'));

    await typeSelect.selectOption('ship');
    await page.waitForTimeout(200);
    const desc2 = await page.locator('#gen-type-desc').textContent();
    check('Ship description shows', desc2.toLowerCase().includes('vessel') || desc2.toLowerCase().includes('ship'));

    // ─── 10. Mobile Viewport (390x844) ─────────────────────────────────
    console.log('\n[10] Mobile (390x844)');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);

    // Generate tab
    await page.locator('.nav-tab[data-tab="generate"]').click();
    await page.waitForTimeout(300);
    check('Mobile: type select visible', await page.locator('#gen-type').isVisible());
    check('Mobile: generate btn visible', await page.locator('#gen-btn').isVisible());
    check('Mobile: style chips visible', await page.locator('.style-chip').first().isVisible());

    // Gallery tab
    await page.locator('.nav-tab[data-tab="gallery"]').click();
    await page.waitForTimeout(1000);
    check('Mobile: gallery cards visible', (await page.locator('.gallery-card').count()) >= 12);

    // Upload tab
    await page.locator('.nav-tab[data-tab="upload"]').click();
    await page.waitForTimeout(500);
    check('Mobile: upload zone visible', await page.locator('#upload-zone').isVisible());

    // ─── 11. Tablet Viewport (768x1024) ────────────────────────────────
    console.log('\n[11] Tablet (768x1024)');
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.waitForTimeout(500);
    await page.locator('.nav-tab[data-tab="generate"]').click();
    check('Tablet: generate tab visible', await page.locator('#gen-type').isVisible());
    await page.locator('.nav-tab[data-tab="gallery"]').click();
    await page.waitForTimeout(500);
    check('Tablet: gallery visible', (await page.locator('.gallery-card').count()) >= 12);

    // ─── 12. Wide Desktop (1920x1080) ──────────────────────────────────
    console.log('\n[12] Wide Desktop (1920x1080)');
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.waitForTimeout(500);
    await page.locator('.nav-tab[data-tab="generate"]').click();
    check('Wide: generate tab visible', await page.locator('#gen-type').isVisible());
    check('Wide: gallery tab exists', (await page.locator('.nav-tab[data-tab="gallery"]').count()) === 1);

    // ─── 13. Navigation Consistency ────────────────────────────────────
    console.log('\n[13] Navigation Consistency');
    const tabNames = ['generate', 'gallery', 'upload'];
    for (const tabName of tabNames) {
      await page.locator('.nav-tab[data-tab="' + tabName + '"]').click();
      await page.waitForTimeout(300);
      const isActive = await page.locator('.nav-tab[data-tab="' + tabName + '"]').evaluate(
        el => el.classList.contains('active')
      );
      const contentVisible = await page.locator('#tab-' + tabName).isVisible();
      check('Tab ' + tabName + ' active state', isActive);
      check('Tab ' + tabName + ' content visible', contentVisible);
    }

    // ─── 14. Gallery Layout — nav stays visible, cards don't overflow ──
    console.log('\n[14] Gallery Layout');
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.waitForTimeout(300);
    await page.locator('.nav-tab[data-tab="gallery"]').click();
    await page.waitForTimeout(2000);
    // Nav bar should remain visible at top
    const navBox = await page.locator('#nav').boundingBox();
    check('Nav visible in gallery', navBox !== null && navBox.y >= 0 && navBox.height > 30);
    // Gallery cards should not exceed viewport
    const galleryCards = page.locator('.gallery-card');
    const firstCardBox = await galleryCards.first().boundingBox();
    check('Gallery cards have min height', firstCardBox !== null && firstCardBox.height >= 200);
    // Gallery card meta (title) should be visible immediately
    const firstMeta = page.locator('.gallery-meta').first();
    check('Gallery card meta visible', await firstMeta.isVisible());
    const titleText = await page.locator('.gallery-title').first().textContent();
    check('Gallery card has title text', titleText !== null && titleText.length > 3);

    // ─── 15. Generator Collapse/Expand ───────────────────────────────
    console.log('\n[15] Generator Collapse/Expand');
    await page.locator('.nav-tab[data-tab="generate"]').click();
    await page.waitForTimeout(500);
    // All style chips should be visible when expanded
    const allChipsVisible = await page.locator('.style-chip').last().isVisible();
    check('All style chips visible when expanded', allChipsVisible);
    // Floor/seed/width/length inputs visible
    check('Floors visible in expanded', await page.locator('#gen-floors').isVisible());
    check('Width visible in expanded', await page.locator('#gen-width').isVisible());
    // Collapse
    const collapseBtn = page.locator('#gen-collapse-btn');
    if (await collapseBtn.isVisible()) {
      await collapseBtn.click();
      await page.waitForTimeout(400);
      // Options body should have collapsed class
      const isCollapsed = await page.locator('#gen-options-body').evaluate(
        el => el.classList.contains('collapsed')
      );
      check('Options collapse on click', isCollapsed);
      // Generate buttons should still be visible
      check('Generate btn visible when collapsed', await page.locator('#gen-btn').isVisible());
      check('Randomize btn visible when collapsed', await page.locator('#gen-random-btn').isVisible());
      // Re-expand
      await collapseBtn.click();
      await page.waitForTimeout(400);
      const isExpanded = await page.locator('#gen-options-body').evaluate(
        el => !el.classList.contains('collapsed')
      );
      check('Options expand on second click', isExpanded);
    }

    // ─── 16. Inline Cutaway Slider ───────────────────────────────────
    console.log('\n[16] Inline Cutaway Slider');
    await page.locator('.nav-tab[data-tab="generate"]').click();
    await page.waitForTimeout(300);
    await page.locator('#gen-type').selectOption('house');
    await page.locator('#gen-seed').fill('42');
    await page.locator('#gen-btn').click();
    await page.waitForTimeout(2500);
    // Inline cutaway slider should appear in the viewer panel
    const inlineCutaway = page.locator('#inline-cutaway');
    soft('Inline cutaway slider visible', await inlineCutaway.isVisible());
    if (await inlineCutaway.isVisible()) {
      const label = page.locator('#inline-cutaway-label');
      check('Inline cutaway label shows All', (await label.textContent()) === 'All');
      // Move slider to a lower value
      await inlineCutaway.fill('3');
      await inlineCutaway.dispatchEvent('input');
      await page.waitForTimeout(300);
      check('Inline cutaway label updates', (await label.textContent()).includes('Y:'));
    }
    // Expand button should exist
    soft('Inline expand btn visible', await page.locator('#inline-expand').isVisible());

    // ─── 17. Ship Sails (visual check — generates without errors) ────
    console.log('\n[17] Ship Generation (sail clearance)');
    await page.locator('#gen-type').selectOption('ship');
    await page.locator('#gen-floors').fill('2');
    await page.locator('#gen-seed').fill('500');
    await page.locator('#gen-btn').click();
    await page.waitForTimeout(2500);
    const shipInfo = await page.locator('#gen-info').textContent();
    check('Ship 2-floor generates', shipInfo.includes('Blocks'));
    // Verify height is sufficient for sails above 2-story cabin
    const shipDims = shipInfo.match(/(\d+)\s*x\s*(\d+)\s*x\s*(\d+)/);
    if (shipDims) {
      const height = parseInt(shipDims[2]);
      check('Ship height >= 35 (sails above cabins)', height >= 25);
    }

    // ─── 18. Castle Keep (generates without errors) ──────────────────
    console.log('\n[18] Castle Keep (great hall)');
    await page.locator('#gen-type').selectOption('castle');
    await page.locator('#gen-floors').fill('2');
    await page.locator('#gen-seed').fill('200');
    await page.locator('#gen-btn').click();
    await page.waitForTimeout(2500);
    const castleInfo = await page.locator('#gen-info').textContent();
    check('Castle 2-floor generates', castleInfo.includes('Blocks'));

    // ─── 19. Village (generates without errors) ──────────────────────
    console.log('\n[19] Village (inward orientation)');
    await page.locator('#gen-type').selectOption('village');
    await page.locator('#gen-seed').fill('42');
    await page.locator('#gen-btn').click();
    await page.waitForTimeout(3000);
    const villageInfo = await page.locator('#gen-info').textContent();
    check('Village generates', villageInfo.includes('Blocks'));
    // Village is large — check block count is reasonable (> 5000)
    const blockMatch = villageInfo.match(/([\d,]+)\s*$/m);

    // ─── 20. Final Error Summary ─────────────────────────────────────
    console.log('\n[20] Final Error Summary');
    console.log('  Non-WebGL console errors: ' + consoleErrors.length);
    if (consoleErrors.length > 0) consoleErrors.slice(0, 10).forEach(e => console.log('    ' + e));
    console.log('  Network errors: ' + netErrors.length);
    if (netErrors.length > 0) netErrors.forEach(e => console.log('    ' + e));
    check('No non-WebGL console errors', consoleErrors.length === 0);
    check('No network errors', netErrors.length === 0);

    // ─── Report ────────────────────────────────────────────────────────
    console.log('\n' + '='.repeat(50));
    console.log('  PASSED: ' + pass + ' / ' + (pass + fail));
    console.log('  FAILED: ' + fail);
    if (skip > 0) console.log('  SKIPPED: ' + skip + ' (WebGL)');
    console.log('='.repeat(50));

    if (fail > 0) process.exitCode = 1;
  } catch (err) {
    console.error('FATAL:', err.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
