#!/usr/bin/env node
/**
 * fix-android-binaries.mjs — Postinstall script for Termux/Android
 *
 * Problem: bun runs under glibc-runner on Termux, so it detects the platform
 * as "linux arm64" and installs linux-arm64-gnu native binaries. But vite/rollup
 * run through Node.js (bionic), which reports process.platform === "android".
 * Native .node modules compiled for glibc can't be dlopened by bionic Node.js.
 *
 * Solution: After bun install, use npm to install the android-arm64 variants
 * of packages with platform-specific native bindings.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Only run on Android/Termux
if (process.platform !== "android") {
  console.log("[fix-android-binaries] Not on Android, skipping.");
  process.exit(0);
}

const projectRoot = join(import.meta.dirname, "..");
const nm = join(projectRoot, "node_modules");

/**
 * Install a platform-specific package if the expected directory is missing.
 * @param {string} pkg - npm package name (e.g. "@rollup/rollup-android-arm64")
 * @param {string} versionSource - path to package.json that determines version
 * @param {string} checkDir - path that should exist after install
 */
function ensureAndroidBinary(pkg, versionSource, checkDir) {
  if (existsSync(checkDir)) {
    console.log(`[fix-android-binaries] ${pkg} already present, skipping.`);
    return;
  }

  let version;
  try {
    const pj = JSON.parse(readFileSync(versionSource, "utf8"));
    version = pj.version;
  } catch {
    console.warn(`[fix-android-binaries] Can't read version from ${versionSource}, skipping ${pkg}`);
    return;
  }

  const target = `${pkg}@${version}`;
  console.log(`[fix-android-binaries] Installing ${target} ...`);
  try {
    execSync(`npm install ${target} --no-save --no-audit --no-fund`, {
      cwd: projectRoot,
      stdio: "pipe",
      timeout: 60_000,
    });
    console.log(`[fix-android-binaries] ${target} installed.`);
  } catch (e) {
    console.error(`[fix-android-binaries] Failed to install ${target}: ${e.message}`);
  }
}

/**
 * Fix esbuild for Android — may be nested inside vite's node_modules.
 * @param {string} esbuildDir - path to an esbuild install directory
 */
function fixEsbuild(esbuildDir) {
  if (!existsSync(esbuildDir)) return;

  const pj = JSON.parse(readFileSync(join(esbuildDir, "package.json"), "utf8"));
  const androidBinDir = join(esbuildDir, "node_modules", "@esbuild", "android-arm64");
  if (existsSync(join(androidBinDir, "bin/esbuild"))) {
    console.log(`[fix-android-binaries] @esbuild/android-arm64@${pj.version} already present.`);
    return;
  }

  console.log(`[fix-android-binaries] Installing @esbuild/android-arm64@${pj.version} ...`);
  try {
    execSync(`npm install @esbuild/android-arm64@${pj.version} --no-save --no-audit --no-fund`, {
      cwd: esbuildDir,
      stdio: "pipe",
      timeout: 60_000,
    });
    console.log(`[fix-android-binaries] @esbuild/android-arm64@${pj.version} installed.`);
  } catch (e) {
    console.error(`[fix-android-binaries] Failed to fix esbuild: ${e.message}`);
  }
}

// --- rollup: needs android-arm64 native .node module ---
ensureAndroidBinary(
  "@rollup/rollup-android-arm64",
  join(nm, "rollup/package.json"),
  join(nm, "@rollup/rollup-android-arm64"),
);

// --- esbuild: install android-arm64 binaries for each copy ---
fixEsbuild(join(nm, "esbuild"));
fixEsbuild(join(nm, "vite/node_modules/esbuild"));
