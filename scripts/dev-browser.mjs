#!/usr/bin/env node
// Opens this working copy of the extension for trying by hand, in a separate
// Chrome for Testing window with its own profile - so it never mixes with the
// Web Store version or any other copy installed in your everyday Chrome.
//
//   npm run dev        build, then open the window (re-run to pick up changes)
//
// The copy is the shipped file set, renamed "(dev: <branch>)" and with the
// same permissions as the real extension (it needs a toolbar click, like the
// store version). The profile lives in build/dev-profile and survives
// re-runs, so history and settings stay between sessions.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { buildTestExtension } from "./test-build.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const branch = execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim() || "local";
const dir = join(root, "build", "dev-extension");
const profile = join(root, "build", "dev-profile");
mkdirSync(profile, { recursive: true });

const { files } = buildTestExtension({ dir, hostAccess: false, name: `dev: ${branch}` });
const browser = spawn(
  chromium.executablePath(),
  [
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${dir}`,
    `--load-extension=${dir}`,
    "--no-first-run",
    "--no-default-browser-check",
    process.argv[2] || "https://en.wikipedia.org/wiki/Screenshot",
  ],
  { detached: true, stdio: "ignore" }
);
browser.unref();
console.log(`Opened Chrome for Testing with "(dev: ${branch})" - ${files} files from ${dir}`);
