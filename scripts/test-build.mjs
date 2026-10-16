#!/usr/bin/env node
// Builds the extension the end-to-end tests and the benchmark load.
//
// It is the shipped file set (scripts/package.sh decides what that is) with
// one change: host access to every site. The real extension relies on
// activeTab, which Chrome grants only when a person clicks the toolbar button
// or presses a shortcut - a test can do neither. Nothing here ships.
//
//   node scripts/test-build.mjs        -> build/test-extension/
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const TEST_EXTENSION_DIR = join(root, "build", "test-extension");

// `dir`, `hostAccess` and `name` let the dev browser build a hand-testing copy
// that behaves like the shipped extension (activeTab only).
export function buildTestExtension({ dir = TEST_EXTENSION_DIR, hostAccess = true, name = "test build" } = {}) {
  const files = execFileSync(join(root, "scripts", "package.sh"), ["--list-worktree"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    // A tracked file deleted in the working tree is still listed by git.
    .filter((file) => existsSync(join(root, file)));

  rmSync(dir, { recursive: true, force: true });
  for (const file of files) {
    const to = join(dir, file);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(root, file), to);
  }

  const manifestPath = join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (hostAccess) {
    manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), "<all_urls>"])];
  }
  manifest.name = `${manifest.name} (${name})`;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir: dir, files: files.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { dir, files } = buildTestExtension();
  console.log(`Test extension: ${files} files -> ${dir}`);
}
