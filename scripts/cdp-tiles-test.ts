/**
 * CDP automation: Test 3D Tiles voxelization in headless Chromium.
 * Sets API key, enters address, runs voxelization, captures results.
 */

const CDP_HOST = '[::1]';
const CDP_PORT = 9222;
const OUT_DIR = '/data/data/com.termux/files/home/git/craftmatic/output';
const fs = require('fs');

// Address via env var (shell quoting is unreliable through grun wrapper)
const testAddress = process.env.TEST_ADDRESS || '1600 Pennsylvania Ave NW, Washington DC';
const apiKey = process.env.GOOGLE_MAPS_API_KEY || '';
if (!apiKey) { console.error('GOOGLE_MAPS_API_KEY required'); process.exit(1); }

let msgId = 0;
const pending = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void }>();
let ws: WebSocket;
const consoleMessages: string[] = [];

function send(method: string, params?: Record<string, any>): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }
    }, 60000);
  });
}

async function screenshot(name: string): Promise<void> {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(r.data, 'base64');
  fs.writeFileSync(`${OUT_DIR}/${name}`, buf);
  console.log(`  [screenshot] ${name} (${buf.length} bytes)`);
}

async function evaluate(expr: string): Promise<any> {
  const r = await send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) {
    const text = r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'unknown';
    console.error(`  [JS error] ${text}`);
    return null;
  }
  return r.result?.value;
}

async function getPageId(): Promise<string> {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json`);
  const pages = await resp.json() as Array<{ id: string; url: string; type: string }>;
  const page = pages.find(p => p.type === 'page' && p.url.includes('localhost:4001'));
  if (!page) throw new Error('No Craftmatic page found');
  return page.id;
}

async function main() {
  const pageId = await getPageId();
  console.log(`Page ID: ${pageId}`);
  console.log(`Address: ${testAddress}`);

  ws = new WebSocket(`ws://${CDP_HOST}:${CDP_PORT}/devtools/page/${pageId}`);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (e: Event) => reject(new Error((e as ErrorEvent).message));
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data as string);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)!.resolve(msg.result);
      pending.delete(msg.id);
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args?.map((a: any) => a.value || a.description || '').join(' ');
      if (text) consoleMessages.push(text);
    }
  };

  console.log('Connected to CDP');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 720, deviceScaleFactor: 1, mobile: false,
  });

  // Step 1: Set API key in localStorage + refresh page
  console.log('\n=== Step 1: Set API key ===');
  await evaluate(`localStorage.setItem('craftmatic_map3d_api_key', '${apiKey}')`);
  await evaluate(`localStorage.setItem('craftmatic_google_streetview_key', '${apiKey}')`);
  console.log('  Key set in localStorage');

  // Reload and wait for full load
  await send('Page.enable');
  await send('Page.reload', {});
  // Poll for readyState === 'complete' with retries (context may be destroyed during reload)
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 250));
    try {
      const state = await evaluate('document.readyState');
      if (state === 'complete') break;
    } catch { /* ignore during reload */ }
  }
  // Extra wait for Vite HMR and dynamic tab init
  await new Promise(r => setTimeout(r, 2000));
  console.log('  Page reloaded');

  // Step 2: Click Tiles tab
  console.log('\n=== Step 2: Switch to Tiles tab ===');
  await evaluate(`document.querySelector('[data-tab="tiles"]')?.click()`);
  await new Promise(r => setTimeout(r, 1000));

  // Verify API key is visible
  const keyStatus = await evaluate(`
    (() => {
      const el = document.querySelector('#tab-tiles .tiles-key-row, .tiles-key-row');
      return el ? el.textContent.trim().substring(0, 50) : 'no key row';
    })()
  `);
  console.log(`  Key status: ${keyStatus}`);
  await screenshot('tiles-test-01-ready.png');

  // Step 3: Set address
  console.log('\n=== Step 3: Enter address ===');
  // Clear any existing value first, then set
  const b64 = Buffer.from(testAddress).toString('base64');
  const setOk = await evaluate(`
    (() => {
      const el = document.getElementById('tiles-address');
      if (!el) return 'NO_ELEMENT';
      el.value = '';
      el.value = atob('${b64}');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return el.value;
    })()
  `);
  console.log(`  Address set: "${setOk}"`);

  // Double-check with a second evaluation
  await new Promise(r => setTimeout(r, 200));
  const verify = await evaluate(`document.getElementById('tiles-address')?.value`);
  console.log(`  Verify: "${verify}"`);
  await screenshot('tiles-test-02-address.png');

  // Step 4: Click Voxelize
  console.log('\n=== Step 4: Start voxelization ===');
  const clickOk = await evaluate(`
    (() => {
      const btn = document.getElementById('tiles-voxelize');
      if (!btn) return 'NO_BUTTON';
      if (btn.disabled) return 'DISABLED';
      btn.click();
      return 'CLICKED';
    })()
  `);
  console.log(`  Voxelize button: ${clickOk}`);

  // Step 5: Monitor progress
  console.log('\n=== Step 5: Monitoring ===');
  let lastStatus = '';
  const startTime = Date.now();
  const maxWait = 180000; // 3 min

  while (Date.now() - startTime < maxWait) {
    const status = await evaluate(`
      (() => {
        const el = document.getElementById('tiles-status');
        return el ? el.textContent.trim() : '';
      })()
    `);

    if (status && status !== lastStatus) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`  [${elapsed}s] ${status}`);
      lastStatus = status;
    }

    // Check if done
    const isDone = await evaluate(`
      (() => {
        const el = document.getElementById('tiles-status');
        if (!el) return false;
        const t = el.textContent;
        return t.includes('Complete') || t.includes('Error') || t.includes('error') ||
               t.includes('No mesh') || t.includes('exported') || t.includes('Download') ||
               t.includes('failed') || t.includes('Address not found');
      })()
    `);

    if (isDone) {
      console.log('  === DONE ===');
      break;
    }

    await new Promise(r => setTimeout(r, 2000));

    // Periodic screenshots
    const elapsed = Date.now() - startTime;
    if (elapsed > 20000 && elapsed % 30000 < 2000) {
      await screenshot(`tiles-test-progress-${Math.round(elapsed / 1000)}s.png`);
    }
  }

  // Step 6: Final results
  console.log('\n=== Step 6: Results ===');
  await screenshot('tiles-test-final.png');

  const gridInfo = await evaluate(`
    (() => {
      const dl = document.querySelector('#tab-tiles a[download]');
      const status = document.getElementById('tiles-status')?.textContent?.trim();
      return JSON.stringify({ download: !!dl, downloadName: dl?.download, status });
    })()
  `);
  console.log(`  Grid info: ${gridInfo}`);

  // Print relevant console messages
  const tileLog = consoleMessages.filter(m => m.includes('[tiles]'));
  if (tileLog.length > 0) {
    console.log('\n=== Console [tiles] logs ===');
    tileLog.forEach(m => console.log(`  ${m}`));
  }

  // Save full console log
  fs.writeFileSync(`${OUT_DIR}/tiles-test-console.txt`, consoleMessages.join('\n'));
  console.log(`\n  Console log: ${consoleMessages.length} messages saved`);

  ws.close();
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
