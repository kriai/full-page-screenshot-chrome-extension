#!/usr/bin/env node
// Captures a fixed set of real sites with the test build and records how good
// each capture was, so a change to the capture engine can be judged by
// numbers rather than by eye.
//
//   npm run benchmark                         all sites in test/benchmark/sites.json
//   npm run benchmark -- --only wikipedia-article,hacker-news
//   npm run benchmark -- --dpr 2 --label after-fix
//   node scripts/benchmark.mjs --compare build/benchmark/a.json build/benchmark/b.json
//
// Real sites change daily: compare runs made on the same day, never against
// an old baseline. Results and images go to build/benchmark/ (not tracked).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capture, launch, REPO_ROOT } from "../test/e2e/harness.mjs";

function parseArgs(argv) {
  const out = { dpr: 1, label: "run", only: null, compare: null, images: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dpr") out.dpr = Number(argv[++i]);
    else if (arg === "--label") out.label = argv[++i];
    else if (arg === "--only") out.only = new Set(argv[++i].split(","));
    else if (arg === "--no-images") out.images = false;
    else if (arg === "--compare") out.compare = [argv[++i], argv[++i]];
  }
  return out;
}

// Everything is derived from the capture's own diagnostics, so the benchmark
// measures exactly what the engine believed happened.
function summarise(result) {
  const diagnostics = result.diagnostics || [];
  const frames = diagnostics.filter((event) => event.event === "frame");
  const end = diagnostics.find((event) => event.event === "end") || {};
  const gaps = result.prestitched?.gaps || [];
  return {
    error: result.error || null,
    // "visible" means the engine found nothing to scroll and took one screen.
    mode: result.mode || null,
    truncated: result.truncated?.reason || null,
    frames: frames.length,
    durationMs: result.durationMs,
    width: result.prestitched?.width ?? null,
    height: result.prestitched?.height ?? null,
    downscaled: result.prestitched?.downscaled || 0,
    // The viewer had to stitch because the worker could not.
    fallback: !result.prestitched && !result.error,
    gapPx: Math.round(gaps.reduce((sum, gap) => sum + (gap.to - gap.from), 0)),
    seamShifts: end.seamShifts ?? null,
    seamRetries: end.seamRetries ?? null,
    driftRejections: end.driftRejections ?? null,
    framesWithPendingImages: frames.filter((frame) => frame.pendingImages > 0).length,
    maxSettleMs: frames.reduce((max, frame) => Math.max(max, frame.settleMs || 0), 0),
  };
}

async function run({ dpr, label, only, images }) {
  const sites = JSON.parse(readFileSync(join(REPO_ROOT, "test/benchmark/sites.json"), "utf8")).filter(
    (site) => !only || only.has(site.id)
  );
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(REPO_ROOT, "build", "benchmark", `${stamp}-${label}`);
  mkdirSync(outDir, { recursive: true });

  const harness = await launch({ deviceScaleFactor: dpr });
  const results = [];
  try {
    for (const site of sites) {
      process.stdout.write(`${site.id.padEnd(24)} `);
      const page = await harness.context.newPage();
      let row;
      try {
        await page.goto(site.url, { waitUntil: "load", timeout: 45000 });
        // Let first-paint scripts, fonts and consent banners arrive, the way a
        // person would wait before reaching for the toolbar button.
        await page.waitForTimeout(1500);
        const result = await withTimeout(
          capture(harness, page, {
            diagnostics: true,
            // Two panes scored alike: take the one in the middle of the
            // window, as most people would.
            pick: (p) => p.mouse.click(p.viewportSize().width / 2, p.viewportSize().height / 2),
          }),
          300000
        );
        row = { id: site.id, url: site.url, ...summarise(result) };
        const image = result.prestitched?.dataUrl || result.frameDataUrl;
        if (images && image) {
          writeFileSync(join(outDir, `${site.id}.png`), Buffer.from(image.split(",")[1], "base64"));
        }
        if (result.diagnostics) {
          writeFileSync(join(outDir, `${site.id}.diagnostics.json`), JSON.stringify(result.diagnostics, null, 1));
        }
      } catch (err) {
        row = { id: site.id, url: site.url, error: `page: ${err.message.split("\n")[0]}` };
      } finally {
        await page.close().catch(() => {});
      }
      results.push(row);
      console.log(row.error ? `error: ${row.error}` : `${row.frames} frames, ${Math.round(row.durationMs / 100) / 10}s`);
    }
  } finally {
    await harness.close();
  }

  const report = { label, dpr, startedAt: stamp, results };
  const reportPath = join(outDir, "results.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  printTable(results);
  console.log(`\nResults: ${reportPath}`);
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no result after ${ms / 1000}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const COLUMNS = [
  ["mode", "mode"],
  ["frames", "frames"],
  ["durationMs", "ms"],
  ["truncated", "partial"],
  ["downscaled", "scaled"],
  ["gapPx", "gap px"],
  ["seamShifts", "shifts"],
  ["seamRetries", "retakes"],
  ["framesWithPendingImages", "img wait"],
  ["fallback", "fallback"],
];

function printTable(results) {
  const header = ["site".padEnd(24), ...COLUMNS.map(([, title]) => title.padStart(9))].join("");
  console.log(`\n${header}`);
  for (const row of results) {
    if (row.error) {
      console.log(`${row.id.padEnd(24)}  ${row.error}`);
      continue;
    }
    const cells = COLUMNS.map(([key]) => {
      let value = row[key];
      if (key === "downscaled") value = value ? `${Math.round(value * 100)}%` : "-";
      if (key === "fallback") value = value ? "yes" : "-";
      if (key === "mode") value = value === "fullPage" ? "full" : value || "none";
      if (value === null || value === undefined) value = "-";
      return String(value).padStart(9);
    });
    console.log(`${row.id.padEnd(24)}${cells.join("")}`);
  }
}

function compare(beforePath, afterPath) {
  const before = JSON.parse(readFileSync(beforePath, "utf8"));
  const after = JSON.parse(readFileSync(afterPath, "utf8"));
  const byId = new Map(before.results.map((row) => [row.id, row]));
  console.log(`${before.label} -> ${after.label}\n`);
  const header = ["site".padEnd(24), ...COLUMNS.map(([, title]) => title.padStart(14))].join("");
  console.log(header);
  for (const row of after.results) {
    const old = byId.get(row.id);
    if (!old || old.error || row.error) {
      console.log(`${row.id.padEnd(24)}  ${old?.error || ""} -> ${row.error || "ok"}`);
      continue;
    }
    const cells = COLUMNS.map(([key]) => {
      const a = old[key] ?? "-";
      const b = row[key] ?? "-";
      return (a === b ? String(b) : `${a}->${b}`).padStart(14);
    });
    console.log(`${row.id.padEnd(24)}${cells.join("")}`);
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.compare) {
  compare(...args.compare);
} else {
  await run(args);
}
