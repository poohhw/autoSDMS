import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { chromium } from "playwright";

dotenv.config();

const COMPANY_ID = process.env.COMPANY_ID;
const COMPANY_PASSWORD = process.env.COMPANY_PASSWORD;
const COMPANY_LOGIN_URL = process.env.COMPANY_LOGIN_URL ?? "http://erp.gcsc.co.kr/login.aspx";
const COMPANY_MAIN_URL = process.env.COMPANY_MAIN_URL ?? "http://erp.gcsc.co.kr/Agile/main.aspx";

if (!COMPANY_ID || !COMPANY_PASSWORD) {
  console.error("[ERROR] COMPANY_ID / COMPANY_PASSWORD is required.");
  process.exit(1);
}

const ARTIFACT_DIR = path.resolve(process.cwd(), "artifacts", "other-work-popup");
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

async function login(page) {
  await page.goto(COMPANY_LOGIN_URL, { waitUntil: "domcontentloaded" });

  await page.fill("#inputId", COMPANY_ID);
  await page.fill("#inputScr", COMPANY_PASSWORD);
  await page.click("#logbtnImg");

  await page.waitForLoadState("networkidle");
}

async function openSdmsMainPage(context, page) {
  const popupPromise = context.waitForEvent("page", { timeout: 10000 }).catch(() => null);

  const sdms = page.locator("#ctl00_main_div_sdms").first();
  try {
    await sdms.click({ timeout: 5000 });
  } catch {
    try {
      await sdms.click({ force: true, timeout: 5000 });
    } catch {
      // Hidden tile fallback: execute onclick script directly.
      await page.evaluate(() => {
        const el = document.querySelector("#ctl00_main_div_sdms");
        if (!el) {
          throw new Error("Cannot find #ctl00_main_div_sdms");
        }
        const fn = globalThis.NewWinLocationYes;
        if (typeof fn === "function") {
          fn("../Agile/main.aspx", 1280, 950, 300, 300, "agile");
          return;
        }

        const onclick = el.getAttribute("onclick");
        if (onclick) {
          // eslint-disable-next-line no-new-func
          new Function(onclick)();
          return;
        }
        el.click();
      });
    }
  }

  const popup = await popupPromise;

  if (popup) {
    await popup.waitForLoadState("domcontentloaded");
    console.log(`[INFO] SDMS popup opened: ${popup.url()}`);
    return popup;
  }

  await page.waitForLoadState("domcontentloaded");
  console.log(`[INFO] SDMS opened in same page: ${page.url()}`);
  return page;
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await login(page);
    console.log(`[INFO] URL after login: ${page.url()}`);
    await page.screenshot({ path: path.join(ARTIFACT_DIR, "after-login.png"), fullPage: true });

    const mainPage = await openSdmsMainPage(context, page);
    console.log(`[INFO] URL after SDMS click: ${mainPage.url()}`);
    console.log(`[INFO] Title after SDMS click: ${await mainPage.title()}`);
    await mainPage.screenshot({ path: path.join(ARTIFACT_DIR, "main-page.png"), fullPage: true });

    const menu = mainPage.locator("#ctl00_LinkButton17");
    const menuVisible = await menu.isVisible({ timeout: 8000 }).catch(() => false);

    if (menuVisible) {
      await menu.click();
      await mainPage.waitForURL("**/Agile/IssuePims/OtherWork.aspx", { timeout: 15000 });
    } else {
      console.log("[WARN] #ctl00_LinkButton17 not visible on main page. Fallback to direct URL.");
      await mainPage.goto("http://erp.gcsc.co.kr/Agile/IssuePims/OtherWork.aspx", {
        waitUntil: "domcontentloaded"
      });
    }

    console.log(`[INFO] URL at other-work page: ${mainPage.url()}`);
    await mainPage.screenshot({ path: path.join(ARTIFACT_DIR, "other-work-page.png"), fullPage: true });

    const popupPromise = context.waitForEvent("page", { timeout: 10000 }).catch(() => null);
    await mainPage.click("#ctl00_AgileContents_btn_PairInsert");
    const popup = await popupPromise;

    if (popup) {
      await popup.waitForLoadState("domcontentloaded");
      await popup.screenshot({ path: path.join(ARTIFACT_DIR, "other-work-popup.png"), fullPage: true });
      console.log("[OK] Popup opened successfully.");
      console.log(`[OK] Popup URL: ${popup.url()}`);
    } else {
      const dialogVisible = await mainPage
        .locator("iframe, .modal, [role='dialog']")
        .first()
        .isVisible({ timeout: 4000 })
        .catch(() => false);

      await mainPage.screenshot({ path: path.join(ARTIFACT_DIR, "popup-check-fallback.png"), fullPage: true });

      if (dialogVisible) {
        console.log("[OK] Popup/modal appears inside the same page.");
      } else {
        console.log("[WARN] Popup was not detected. Check selectors or popup behavior.");
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

run().catch((error) => {
  console.error("[ERROR]", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
