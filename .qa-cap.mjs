import { chromium } from "/workspace/node_modules/playwright/index.mjs";
const browser = await chromium.launch();
const URL = process.env.QA_URL ?? "http://127.0.0.1:8080/";
const which = process.argv[2] ?? "stubborn";
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (err) => errors.push(err.message));
page.on("console", (msg) => { if (msg.type() === "error") errors.push(`console: ${msg.text()}`); });
await page.goto(URL, { waitUntil: "networkidle" });
await page.evaluate(() => localStorage.clear());
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(600);
const turnText = async () => {
  const turn = page.locator("article", { hasText: "OCAGENT" }).first();
  const fold = turn.getByRole("button", { name: /轮 · / });
  if (await fold.count()) await fold.click();
  await page.waitForTimeout(300);
  return turn.innerText();
};
const started = Date.now();
if (which === "obedient") {
  await page.locator("textarea").fill("一直数下去，数到天荒地老");
  await page.keyboard.press("Enter");
  await page.waitForSelector("text=/还没数完；下次从这里接着/", { timeout: 900_000 });
  console.log("settled after", Math.round((Date.now() - started) / 1000), "s");
  await page.waitForTimeout(800);
  const text = await turnText();
  console.log("--- 一直数 turn (tail) ---\n" + text.slice(-700));
  console.log("obedient ended partial (not paused):", /还没数完/.test(text) && !/没做完/.test(text));
  await page.screenshot({ path: "/workspace/screenshots/qa-cap-wrapup.png", fullPage: false });
} else {
  await page.locator("textarea").fill("死数到底，不要停");
  await page.keyboard.press("Enter");
  await page.waitForSelector("text=/到了一次任务的上限/", { timeout: 900_000 });
  console.log("settled after", Math.round((Date.now() - started) / 1000), "s");
  await page.waitForTimeout(800);
  const text = await turnText();
  console.log("--- 死数 turn (tail) ---\n" + text.slice(-700));
  console.log("cap message + 接着做:", /已经自动连做了 10 段/.test(text) && (await page.getByRole("button", { name: "接着做" }).count()) > 0);
  await page.screenshot({ path: "/workspace/screenshots/qa-cap-stopped.png", fullPage: false });
  await page.getByRole("button", { name: "接着做" }).click();
  await page.waitForSelector("text=/已经自动连做了 11 段/", { timeout: 180_000 });
  console.log("one more segment after 接着做: ok");
  await page.screenshot({ path: "/workspace/screenshots/qa-cap-resumed.png", fullPage: false });
}
console.log("errors:", JSON.stringify(errors));
await browser.close();
