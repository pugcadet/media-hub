// Takes screenshots of every screen with the fake backend, at two window sizes.
// Usage: node screens/shoot.mjs <dist-url> <out-dir>
import { chromium } from "playwright";
import fs from "node:fs";

const [url, out] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const kinds = fs.readFileSync(new URL("./kinds.json", import.meta.url), "utf8");
const mock = fs.readFileSync(new URL("./mock.js", import.meta.url), "utf8");

const views = ["home", "library", "renamer", "subtitles", "intros", "cleanup", "missing", "duplicates", "tags", "history", "collections", "add", "settings", "health", "metadata"];
const log = [];
const browser = await chromium.launch();
for (const [w, h] of [[1440, 900], [1100, 760]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && log.push(`[${w}] console ${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => log.push(`[${w}] pageerror: ${e.message}`));
  await page.addInitScript(`window.__KINDS__ = ${kinds};`);
  await page.addInitScript(mock);
  await page.goto(url);
  await page.waitForTimeout(1500);
  for (const v of views) {
    try {
      await page.evaluate((v) => window.__mhNav?.route({ view: v, n: Date.now() }), v);
      await page.waitForTimeout(900);
      await page.screenshot({ path: `${out}/${w}-${v}.png`, fullPage: false });
      // Overlap check: elements whose box spills outside their scroll container or the window.
      const issues = await page.evaluate(() => {
        const bad = [];
        for (const el of document.querySelectorAll(".page *")) {
          const r = el.getBoundingClientRect();
          if (r.width && r.right > window.innerWidth + 1) bad.push(`${el.tagName.toLowerCase()}.${[...el.classList].join(".")} sticks out by ${Math.round(r.right - window.innerWidth)}px`);
        }
        return [...new Set(bad)].slice(0, 8);
      });
      issues.forEach((i) => log.push(`[${w}] ${v}: ${i}`));
    } catch (e) {
      log.push(`[${w}] ${v}: ${e.message}`);
    }
  }
  // Item page, player-less.
  try {
    await page.evaluate(() => window.__mhNav?.open("00000000000000000000000000000002"));
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${out}/${w}-item.png` });
    await page.evaluate(() => window.__mhNav?.open("00000000000000000000000000000002", { tab: "00000000000000000000000000000700" }));
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${out}/${w}-item-season.png` });
    await page.mouse.click(Math.round(w * 0.6), 300, { button: "right" });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${out}/${w}-context.png` });
  } catch (e) {
    log.push(`[${w}] item: ${e.message}`);
  }
  // Collapsed sidebar.
  try {
    await page.evaluate(() => { const p = JSON.parse(localStorage.getItem("mediahub.prefs.v1") || "{}"); p.sidebarSmall = true; localStorage.setItem("mediahub.prefs.v1", JSON.stringify(p)); });
    await page.reload();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${out}/${w}-collapsed.png` });
    await page.evaluate(() => localStorage.removeItem("mediahub.prefs.v1"));
  } catch (e) {
    log.push(`[${w}] collapsed: ${e.message}`);
  }
  await page.close();
}
await browser.close();
fs.writeFileSync(`${out}/log.txt`, log.join("\n") + "\n");
console.log(log.join("\n"));
