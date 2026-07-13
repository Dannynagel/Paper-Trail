// Headless runner for the repo's tests.html (pure-logic assertions).
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");
const { chromium } = require("playwright");

const CHROMIUM_DEFAULT = "/opt/pw-browsers/chromium";
const CHROMIUM = process.env.PT_CHROMIUM ||
  (fs.existsSync(CHROMIUM_DEFAULT) ? CHROMIUM_DEFAULT : null);

(async () => {
  const b = await chromium.launch({ headless: true, ...(CHROMIUM ? { executablePath: CHROMIUM } : {}) });
  const p = await b.newPage();
  await p.goto(pathToFileURL(path.resolve(__dirname, "../tests.html")).href);
  await p.waitForSelector("h1.pass, h1.fail");
  const head = p.locator("h1.pass, h1.fail").first();
  const txt = await head.textContent();
  const cls = await head.getAttribute("class");
  if (cls !== "pass") {
    for (const line of await p.locator(".fail").allTextContents()) console.log("  " + line);
  }
  console.log("tests.html:", txt);
  await b.close();
  process.exit(cls === "pass" ? 0 : 1);
})();
