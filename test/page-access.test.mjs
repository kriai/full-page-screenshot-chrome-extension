// Which pages can be captured, and the messages shown when one cannot.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const A = require("../page-access.js");

test("classifyUrl allows ordinary pages and blocks browser-owned ones", () => {
  const cases = [
    ["https://example.com/", true],
    ["http://localhost:8080/app", true],
    ["https://chrome.google.com/search", true],
    ["chrome://settings", "browser"],
    ["edge://flags", "browser"],
    ["chrome-extension://abc/viewer.html", "extension"],
    ["https://chromewebstore.google.com/detail/x", "store"],
    ["https://chrome.google.com/webstore/detail/x", "store"],
    ["devtools://devtools/bundled/inspector.html", "devtools"],
    ["about:blank", "about"],
    ["view-source:https://example.com", "viewSource"],
    ["data:text/html,hi", "special"],
    ["https://example.com/report.PDF", "pdf"],
    ["not a url", "invalid"],
    ["", "invalid"],
  ];
  for (const [url, expected] of cases) {
    const result = A.classifyUrl(url);
    if (expected === true) assert.equal(result.ok, true, url);
    else assert.equal(result.reason, expected, url);
    if (!result.ok) assert.ok(result.message, `${url} has no message`);
  }
});

test("file:// pages depend on the user's file-access setting", () => {
  assert.equal(A.classifyUrl("file:///Users/me/page.html").reason, "file");
  assert.equal(A.classifyUrl("file:///Users/me/page.html", { fileAccess: true }).ok, true);
});

test("explainError turns Chrome's errors into plain text and passes others through", () => {
  assert.match(A.explainError(new Error("The extensions gallery cannot be scripted.")), /doesn't let/);
  assert.match(A.explainError(new Error("Cannot access contents of the page. Extension manifest must request permission")), /button again/);
  assert.match(A.explainError(new Error("No tab with id: 42.")), /tab was closed/);
  assert.match(A.explainError(new Error("Frame with ID 0 was removed.")), /changed while/);
  assert.equal(A.explainError(new Error("Something specific")), "Something specific");
});
