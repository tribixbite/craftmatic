# X11 Playwright Testing on Termux/Android

Test deployed web apps using Playwright via X11 on Termux ARM64. This skill covers the full workflow from setup to automated e2e testing with screenshots.

## Prerequisites

```bash
# Termux packages
pkg install x11-repo
pkg install termux-x11-nightly chromium

# Node packages (global)
npm install -g @playwright/mcp
# or via bun:
bun install -g @playwright/mcp

# playwright-core (per-project, not playwright — avoids browser download)
npm install --no-save playwright-core
```

## X11 Setup

Start the termux-x11 server (typically via boot script or manually):

```bash
# Launch X11 display
termux-x11 :1 &
export DISPLAY=:1
```

Verify chromium works on X11:

```bash
DISPLAY=:1 chromium-browser --version
```

## Critical: Android Platform Workaround

`playwright-core` throws `Error: Unsupported platform: android` because `process.platform === 'android'` is not in its supported platform list. The fix: set `PLAYWRIGHT_BROWSERS_PATH` to any valid directory — this bypasses the platform detection in `registry/index.js`:

```bash
export PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright
```

This env var is **required** for every playwright-core invocation on Android.

## Running Tests

### Environment Variables

Always include both:

```bash
DISPLAY=:1 \
PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright \
npx tsx test-script.ts
```

### Test Script Pattern

```typescript
import { chromium, type Browser, type Page } from 'playwright-core';

const URL = 'https://your-site.github.io/app/';
const SCREENSHOT_DIR = './test-screenshots';

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function screenshot(page: Page, name: string) {
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/${name}.png`,
    fullPage: false,
  });
}

async function main() {
  const browser: Browser = await chromium.launch({
    executablePath: '/data/data/com.termux/files/usr/bin/chromium-browser',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    headless: false, // X11 requires headed mode
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();

  try {
    // Navigate
    await page.goto(URL, { waitUntil: 'networkidle' });
    await screenshot(page, '01-loaded');

    // Interact
    await page.locator('#my-button').click();
    await sleep(1000);
    await screenshot(page, '02-after-click');

    // Assert
    const title = await page.title();
    console.assert(title.includes('Expected'), 'Title check failed');

    // Mobile viewport test
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(500);
    await screenshot(page, '03-mobile');

    // Console error check
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await page.reload({ waitUntil: 'networkidle' });
    console.log(`Console errors: ${errors.length}`);

  } catch (err) {
    console.error('Test failed:', err);
    await screenshot(page, 'error-state');
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
```

## MCP Server Configuration

Add to `~/.claude.json` for Claude Code integration:

```json
{
  "mcpServers": {
    "playwright": {
      "type": "stdio",
      "command": "/data/data/com.termux/files/usr/bin/node",
      "args": [
        "/path/to/node_modules/@playwright/mcp/cli.js",
        "--browser", "chromium",
        "--executable-path", "/data/data/com.termux/files/usr/bin/chromium-browser",
        "--no-sandbox",
        "--caps", "vision",
        "--viewport-size", "1280, 720"
      ],
      "env": {
        "DISPLAY": ":1",
        "PLAYWRIGHT_BROWSERS_PATH": "/data/data/com.termux/files/home/.cache/ms-playwright"
      }
    }
  }
}
```

Find the actual cli.js path:

```bash
find ~/.bun/install -name cli.js -path '*@playwright/mcp*' 2>/dev/null
# or for npm:
find /data/data/com.termux/files/usr/lib/node_modules -name cli.js -path '*@playwright/mcp*' 2>/dev/null
```

## Known Limitations

- **WebGL renders blank** in X11 Chromium on Android (no GPU acceleration). Three.js canvases will show dark/empty content. 2D canvas operations (thumbnails, offscreen rendering) work fine.
- **headless: false is required** — X11 needs a display server, so use headed mode with `DISPLAY=:1`.
- `--disable-gpu` flag recommended since there's no hardware acceleration.
- `--no-sandbox` required on Termux (no kernel sandbox support).

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `Unsupported platform: android` | Set `PLAYWRIGHT_BROWSERS_PATH` env var |
| `Cannot open display` | Ensure `DISPLAY=:1` and termux-x11 is running |
| Element click intercepted | Check for overlays (loading spinners, modals) blocking the target |
| `ECONNREFUSED` on localhost | Use deployed URL, not localhost (X11 chromium runs in separate process) |
| Screenshots are blank/white | WebGL limitation — functional tests still pass, just no 3D rendering |
