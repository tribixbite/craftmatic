#!/usr/bin/env bun
/**
 * release.ts: the one release command (plan D 3.3). X-01 implements only
 * `init-product`; `prepare`, `finalize`, `verify` and `status` belong to D-08.
 *
 *   bun scripts/release.ts init-product <id>
 *
 * `init-product` mints a product's frozen Bedrock identity ONCE: five random v4
 * uuids, written to release/products/<id>.json with `namespace: null` (the brand
 * is undecided, U1) and refuses to overwrite an existing product. This is the
 * only file in the release code that touches disk.
 *
 * CRAFTMATIC_RELEASE_ROOT overrides the repo root (tests use a temp folder).
 */
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PRODUCT_ID_PATTERN, validateProduct } from '../web/src/release/product.js';
import type { ProductRecord } from '../web/src/release/types.js';

const ROOT = resolve(process.env.CRAFTMATIC_RELEASE_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..'));

/** Script module versions the dev pack manifest declares today (engine/mcpack.ts), pinned for release builds. */
// TODO(X-02): read these from one shared constant once the profile seam lands; they are copied from mcpack.ts:240-241 and :224.
const SCRIPT_MODULES = { server: '2.9.0', serverUi: '2.1.0' };
const MIN_ENGINE_VERSION: [number, number, number] = [1, 26, 40];

/** `my-pack` -> `MyPack`. */
const pascal = (id: string): string => id.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');

/** Exact `bun --version`, or null when bun cannot be run. */
function bunVersion(): string | null {
  const r = spawnSync('bun', ['--version'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Builds the new record. Stand-in fields are listed in `placeholders` (data, so D-08 can refuse while any remain). */
function mintProduct(id: string): ProductRecord {
  const bun = bunVersion();
  const lockPath = join(ROOT, 'bun.lock');
  if (bun === null) throw new Error('cannot run `bun --version`; the toolchain pin needs it');
  if (!existsSync(lockPath)) throw new Error(`no bun.lock at ${lockPath}; the toolchain pin needs it`);
  const stem = pascal(id);
  return {
    id,
    displayName: stem,
    tier: 'free',
    identity: {
      namespace: null,
      folderStem: stem,
      uuids: { bpHeader: randomUUID(), bpData: randomUUID(), bpScript: randomUUID(), rpHeader: randomUUID(), rpResources: randomUUID() },
    },
    placeholders: ['namespace', 'folderStem', 'displayName', 'publisher'],
    designs: [],
    toolchain: {
      bun,
      lockfileSha256: createHash('sha256').update(readFileSync(lockPath)).digest('hex'),
      // TODO(X-04/D-08): pin the real complete.zip sha256 when the official library lands.
      ldrawLibrary: { archive: 'complete.zip', sha256: null, root: 'ldraw_ref/official' },
      scriptModules: SCRIPT_MODULES,
      minEngineVersion: MIN_ENGINE_VERSION,
    },
    versions: [],
    publisher: null,
  };
}

function initProduct(id: string | undefined): number {
  if (!id || !PRODUCT_ID_PATTERN.test(id)) {
    console.error(`usage: release.ts init-product <id>   (id must match ${PRODUCT_ID_PATTERN})`);
    return 2;
  }
  const file = join(ROOT, 'release', 'products', `${id}.json`);
  if (existsSync(file)) {
    console.error(`product ${id} already exists at ${file}; identities are minted once and never overwritten`);
    return 1;
  }
  const record = mintProduct(id);
  const problems = validateProduct(record);
  if (problems.length > 0) throw new Error(`minted record is invalid: ${problems.join('; ')}`);
  mkdirSync(dirname(file), { recursive: true });
  // 'wx' fails if the file appeared since the check, so two racing mints cannot both win.
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  console.log(`minted ${file} (namespace null until U1)`);
  return 0;
}

const [command, arg] = process.argv.slice(2);
try {
  if (command === 'init-product') process.exit(initProduct(arg));
  console.error(`unknown command ${JSON.stringify(command)}; implemented: init-product (prepare/finalize/verify/status are D-08)`);
  process.exit(2);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
