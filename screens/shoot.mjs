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
  // A Windows user agent makes the app use http://hubimg.localhost for pictures, which can be
  // answered here with simple placeholder pictures.
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1, userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36" });
  await page.route(/hub(img|media)\.localhost/, (route) => {
    const u = route.request().url();
    const id = (u.match(/localhost\/([0-9a-f]{6,})/) || [])[1] || "0";
    const kind = (u.match(/\/(Primary|Backdrop|Logo|Thumb|Banner|Art)/) || [])[1] || "Primary";
    const hue = parseInt(id.slice(-4), 16) % 360;
    const [vw, vh] = kind === "Primary" ? [300, 450] : kind === "Logo" ? [400, 150] : kind === "Banner" ? [1000, 185] : [640, 360];
    const svg = kind === "Logo"
      ? `<svg xmlns="http://www.w3.org/2000/svg" width="${vw}" height="${vh}"><text x="50%" y="60%" font-size="64" font-family="sans-serif" font-weight="800" fill="white" text-anchor="middle">LOGO</text></svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg" width="${vw}" height="${vh}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,45%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},55%,22%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><text x="50%" y="52%" font-size="${vw / 8}" font-family="sans-serif" fill="rgba(255,255,255,.55)" text-anchor="middle">${kind}</text></svg>`;
    route.fulfill({ status: 200, contentType: "image/svg+xml", body: svg });
  });
  page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && !/ERR_UNKNOWN_URL_SCHEME/.test(m.text()) && log.push(`[${w}] console ${m.type()}: ${m.text()}`));
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
  // Renamer → Folders → Movie folders.
  try {
    await page.evaluate(() => window.__mhNav?.route({ view: "renamer", section: "folders", n: Date.now() }));
    await page.waitForTimeout(800);
    await page.click("text=Check movie folders", { timeout: 2000 });
    await page.waitForTimeout(800);
    await page.click("text=Move them to", { timeout: 2000 }).catch(() => undefined);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${out}/${w}-movie-folders.png` });
  } catch (e) {
    log.push(`[${w}] movie folders: ${e.message}`);
  }
  // Music: tiles, list, manage (through the hub switcher, like a person would).
  try {
    await page.click(".hub-btn");
    await page.click(".hub-menu >> text=Music");
    await page.waitForTimeout(1000);
    await page.click(".m-tabs >> text=Albums");
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${out}/${w}-music.png` });
    await page.click(".w-top [title=List]");
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${out}/${w}-music-list.png` });
    await page.click(".m-tabs >> text=Manage");
    await page.waitForTimeout(900);
    await page.click(".m-manage .studio-item", { timeout: 1500 }).catch(() => undefined);
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${out}/${w}-music-manage.png` });
    await page.click(".m-manage >> text=Source");
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${out}/${w}-music-source.png` });
    await page.click(".hub-btn");
    await page.click(".hub-menu >> text=Media manager");
    await page.waitForTimeout(600);
  } catch (e) {
    log.push(`[${w}] music: ${e.message}`);
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
