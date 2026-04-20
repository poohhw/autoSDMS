import fs from "node:fs";
import https from "node:https";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { CompanyEnv } from "../config/env.js";
import { getIsoWeekNumber } from "../domain/businessDay.js";
import type { WeeklyProjectSummary } from "../domain/weeklyReport.js";
import { checkSignal } from "../lib/cancellation.js";
import type { OtherWorkDraft } from "../notion/otherWorkMapper.js";
import { detectLeaveType, registerLeaveRequest } from "./leaveRequestRegistrar.js";

const OTHER_WORK_URL = "http://erp.gcsc.co.kr/Agile/IssuePims/OtherWork.aspx";
const DAILY_SCRUM_URL = "http://erp.gcsc.co.kr/Agile/Agile/DailyScrum.aspx";
const BUSINESS_LOG_URL = "http://erp.gcsc.co.kr/project/business.aspx?subMenuCss=tcell_addWork";
const WEEKLY_REPORT_URL = "http://erp.gcsc.co.kr/Agile/Agile/BusinessReport.aspx";
const INTER_ITEM_DELAY_MS = 1500;
const PRE_SUBMIT_DELAY_MS = 1000;

export interface RegisterSummary {
  total: number;
  success: number;
  failed: number;
  failures: Array<{ title: string; reason: string }>;
  skipped?: number;
  skippedItems?: Array<{ title: string; reason: string }>;
}

export interface RegistrarRunOptions {
  headed?: boolean;
  slowMoMs?: number;
}

/** PC에 설치된 Chrome → Edge 순으로 브라우저 채널 감지 */
async function detectBrowserChannel(): Promise<"chrome" | "msedge"> {
  for (const channel of ["chrome", "msedge"] as const) {
    try {
      const browser = await chromium.launch({ headless: true, channel });
      await browser.close();
      return channel;
    } catch {
      // channel not available
    }
  }
  throw new Error(
    "Chrome 또는 Edge가 설치되어 있지 않습니다. 브라우저를 설치 후 다시 시도해주세요."
  );
}

export class ErpOtherWorkRegistrar {
  private readonly artifactsDir: string;
  private readonly runOptions: RegistrarRunOptions;

  constructor(private readonly env: CompanyEnv, runOptions: RegistrarRunOptions = {}) {
    this.runOptions = runOptions;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.artifactsDir = path.resolve(process.cwd(), "artifacts", "register-otherwork", stamp);
    fs.mkdirSync(this.artifactsDir, { recursive: true });
  }

  private fileSafe(name: string): string {
    return name.replace(/[\\/:*?"<>|]/g, "_");
  }

  private async login(page: Page): Promise<void> {
    await page.goto(this.env.COMPANY_LOGIN_URL, { waitUntil: "domcontentloaded" });
    await page.fill("#inputId", this.env.COMPANY_ID);
    await page.fill("#inputScr", this.env.COMPANY_PASSWORD);
    await page.click("#logbtnImg");
    await page.waitForLoadState("networkidle");

    // Dismiss the notice popup if it appears (안전보건경영방침 etc.)
    await this.dismissNoticePopup(page);
  }

  /** Dismiss the ERP notice popup (오늘 하루 보지 않기 + 확인) if visible */
  private async dismissNoticePopup(page: Page): Promise<void> {
    const confirmBtn = page.locator("#ctl00_main_pop_error_btn_Confirm");
    const isVisible = await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (!isVisible) {
      console.log(`[LOGIN] No notice popup detected. Continuing...`);
      return;
    }

    console.log(`[LOGIN] Notice popup detected. Dismissing...`);
    // Check "오늘 하루 보지 않기"
    const chkBox = page.locator("#ctl00_main_pop_error_chk_myNotice");
    const isChecked = await chkBox.isChecked().catch(() => false);
    if (!isChecked) {
      await chkBox.check({ force: true }).catch(async () => {
        console.log(`[LOGIN] Checkbox check failed (force), trying JS click...`);
        await page.evaluate(() => {
          const el = document.getElementById("ctl00_main_pop_error_chk_myNotice") as HTMLInputElement;
          if (el) el.checked = true;
        }).catch(() => {
          console.log(`[LOGIN] JS checkbox click also failed. Skipping checkbox.`);
        });
      });
      await page.waitForTimeout(300).catch(() => undefined);
    }

    // JS로 직접 클릭 (좌표 계산 없이 확실하게 닫기)
    await page.evaluate(() => {
      const btn = document.getElementById("ctl00_main_pop_error_btn_Confirm") as HTMLElement;
      if (btn) btn.click();
    });
    await page.waitForTimeout(500);
    console.log(`[LOGIN] Notice popup dismissed.`);
  }

  private async openSdmsMainPage(context: BrowserContext, page: Page): Promise<Page> {
    const popupPromise = context.waitForEvent("page", { timeout: 10000 }).catch(() => null);
    const sdms = page.locator("#ctl00_main_div_sdms").first();

    try {
      await sdms.click({ timeout: 5000 });
    } catch {
      try {
        await sdms.click({ force: true, timeout: 5000 });
      } catch {
        await page.evaluate(() => {
          const el = document.querySelector("#ctl00_main_div_sdms");
          if (!el) {
            throw new Error("Cannot find #ctl00_main_div_sdms");
          }
          const fn = (globalThis as any).NewWinLocationYes;
          if (typeof fn === "function") {
            fn("../Agile/main.aspx", 1280, 950, 300, 300, "agile");
            return;
          }
          const onclick = el.getAttribute("onclick");
          if (onclick) {
            new Function(onclick)();
            return;
          }
          (el as any).click();
        });
      }
    }

    const popup = await popupPromise;
    if (popup) {
      await popup.waitForLoadState("domcontentloaded");
      return popup;
    }

    await page.waitForLoadState("domcontentloaded");
    return page;
  }

  private async openOtherWorkPage(mainPage: Page): Promise<void> {
    // Always navigate directly to avoid reload failures (ERR_ABORTED on transitional state)
    await mainPage.goto(OTHER_WORK_URL, { waitUntil: "domcontentloaded" });
    await mainPage.waitForLoadState("networkidle");
  }

  private async selectOptionByLabel(page: Page, selector: string, label?: string): Promise<boolean> {
    if (!label?.trim()) {
      return false;
    }
    try {
      await page.selectOption(selector, { label: label.trim() });
      return true;
    } catch {
      return false;
    }
  }

  private async selectOptionByContains(page: Page, selector: string, keyword?: string): Promise<boolean> {
    if (!keyword?.trim()) {
      return false;
    }
    const pickedValue = await page
      .locator(`${selector} option`)
      .evaluateAll((opts, k) => {
        const needle = (k ?? "").toString().trim().toLowerCase();
        if (!needle) {
          return "";
        }
        for (const opt of opts as any[]) {
          const text = (opt.textContent ?? "").toString().trim().toLowerCase();
          const value = (opt.value ?? "").toString().trim();
          if (!value) {
            continue;
          }
          if (text.includes(needle)) {
            return value;
          }
        }
        return "";
      }, keyword)
      .catch(() => "");

    if (!pickedValue) {
      return false;
    }
    await page.selectOption(selector, pickedValue);
    return true;
  }

  private async readSelectedText(page: Page, selector: string): Promise<string> {
    return page
      .locator(`${selector} option:checked`)
      .first()
      .textContent()
      .then((x) => (x ?? "").trim())
      .catch(() => "");
  }

  private isDefaultSelectText(text: string): boolean {
    const t = text.replace(/\s+/g, "").toLowerCase();
    return t === "" || t === "n/a" || t.includes("선택") || t.includes("select");
  }

  private async selectFirstValidOption(page: Page, selector: string): Promise<boolean> {
    const optionValue = await page
      .locator(`${selector} option`)
      .evaluateAll((opts) => {
        const values = opts
          .map((x) => ({
            value: ((x as any).value ?? "").toString().trim(),
            text: ((x as any).textContent ?? "").toString().trim()
          }))
          .filter((x) => x.value && x.text && !/선택|select/i.test(x.text));
        return values.length > 0 ? values[0].value : "";
      })
      .catch(() => "");

    if (!optionValue) {
      return false;
    }
    await page.selectOption(selector, optionValue);
    return true;
  }

  private extractParenToken(input?: string): string {
    if (!input) {
      return "";
    }
    const m = input.match(/\(([^)]+)\)/);
    return m?.[1]?.trim() ?? "";
  }

  private async setSelect(page: Page, selector: string, label: string | undefined, required: boolean): Promise<void> {
    let selected = await this.selectOptionByLabel(page, selector, label);
    if (!selected) {
      selected = await this.selectOptionByContains(page, selector, label);
    }
    if (!selected) {
      const token = this.extractParenToken(label);
      if (token) {
        selected = await this.selectOptionByContains(page, selector, token);
      }
    }
    if (selected) {
      const now = await this.readSelectedText(page, selector);
      if (!this.isDefaultSelectText(now)) {
        return;
      }
      selected = false;
    }
    if (!selected && required) {
      const fallback = await this.selectFirstValidOption(page, selector);
      if (!fallback) {
        throw new Error(`Required select cannot be set: ${selector}`);
      }
      const now = await this.readSelectedText(page, selector);
      if (this.isDefaultSelectText(now)) {
        throw new Error(`Required select remains default after fallback: ${selector}`);
      }
      return;
    }
  }

  private async setCheckbox(page: Page, selector: string, checked?: boolean): Promise<void> {
    if (typeof checked !== "boolean") {
      return;
    }
    const target = page.locator(selector).first();
    if ((await target.count()) === 0) {
      return;
    }
    await target.setChecked(checked);
  }

  private async countTitleOnList(mainPage: Page, title: string): Promise<number> {
    return mainPage
      .locator("body")
      .evaluate((body, t) => {
        const text = (body as HTMLElement).innerText ?? "";
        if (!t) {
          return 0;
        }
        return text.split(t).length - 1;
      }, title)
      .catch(() => 0);
  }

  private normalizeText(s: string): string {
    return s.replace(/\s+/g, " ").trim().toLowerCase();
  }

  /** ERP 필드 글자수 제한 (300자). 초과 시 잘라내고 경고 로그 출력 */
  private truncateComment(text: string, title: string, maxLen = 300): string {
    if (text.length <= maxLen) return text;
    console.log(`[WARN] "${title}" 업무내용이 ${maxLen}자를 초과합니다 (${text.length}자 → ${maxLen}자로 잘림)`);
    return text.substring(0, maxLen - 3) + "...";
  }

  /** Generate ERP title in [YYMMDD] format. e.g. "2026-03-16" + "2월 보안보고서 작성" → "[260316] 2월 보안보고서 작성" */
  formatErpTitle(title: string, finishDate: string): string {
    const digits = finishDate.replace(/\D/g, ""); // "20260316"
    const yy = digits.substring(2, 4);            // "26"
    const mm = digits.substring(4, 6);            // "03"
    const dd = digits.substring(6, 8);            // "16"
    return `[${yy}${mm}${dd}] ${title}`;
  }

  private async existsByTitleAndDate(mainPage: Page, title: string, finishDate: string): Promise<boolean> {
    const bodyText = await mainPage.locator("body").innerText().catch(() => "");
    if (!bodyText.trim()) {
      return false;
    }

    const normalizedBody = this.normalizeText(bodyText);
    const normalizedTitle = this.normalizeText(title);
    const d1 = finishDate;
    const d2 = finishDate.replace(/\//g, "-");
    const d3 = finishDate.replace(/-/g, "/");

    if (!normalizedBody.includes(normalizedTitle)) {
      return false;
    }

    return normalizedBody.includes(d1.toLowerCase()) || normalizedBody.includes(d2.toLowerCase()) || normalizedBody.includes(d3.toLowerCase());
  }

  private isErrorDialog(message: string): boolean {
    if (!message.trim()) {
      return false;
    }
    return /(필수|오류|실패|에러|invalid|required|참조)/i.test(message);
  }

  private async readInlineWarningText(popup: Page): Promise<string> {
    const candidates = [
      ".ui-dialog-content",
      ".modal-body",
      ".popup-content",
      "div[role='dialog']"
    ];
    for (const sel of candidates) {
      const visible = await popup.locator(sel).first().isVisible({ timeout: 400 }).catch(() => false);
      if (!visible) {
        continue;
      }
      const txt = await popup.locator(sel).first().innerText().catch(() => "");
      if (txt.trim()) {
        return txt.trim();
      }
    }
    return "";
  }

  private async closeInlineWarningIfAny(popup: Page): Promise<void> {
    const okSelectors = [
      "button:has-text('확인')",
      "a:has-text('확인')",
      ".ui-dialog-buttonset button",
      ".modal-footer button"
    ];
    for (const sel of okSelectors) {
      const button = popup.locator(sel).first();
      const visible = await button.isVisible({ timeout: 300 }).catch(() => false);
      if (!visible) {
        continue;
      }
      await button.click({ timeout: 1000 }).catch(() => undefined);
      return;
    }
  }

  private async submitWithRetryOnSprintError(
    popup: Page
  ): Promise<{ closed: boolean; warning: string; sprintWarningHandled: boolean }> {
    let closePromise = popup.waitForEvent("close", { timeout: 8000 }).then(() => true).catch(() => false);
    await popup.click("#btnl_addReleaseConfirm");
    let closed = await closePromise;
    if (closed) {
      return { closed: true, warning: "", sprintWarningHandled: false };
    }

    let warning = await this.readInlineWarningText(popup);
    if (!warning) {
      return { closed: false, warning: "", sprintWarningHandled: false };
    }

    const sprintMappingError = /스프린트.*실패|SPRINTMAPPING|sprint/i.test(warning);
    if (!sprintMappingError) {
      return { closed: false, warning, sprintWarningHandled: false };
    }

    // Do NOT resubmit automatically to avoid duplicate registration.
    // Sprint mapping warning may occur after the row is already inserted.
    await this.closeInlineWarningIfAny(popup);
    await popup.locator("button:has-text('취소'), a:has-text('취소'), #btnl_addReleaseCancel").first().click().catch(() => undefined);
    await popup.waitForEvent("close", { timeout: 4000 }).catch(() => undefined);
    return { closed: true, warning, sprintWarningHandled: true };
  }

  /** URL에서 파일을 %TEMP% 폴더에 다운로드 후 경로 반환 */
  private downloadFile(url: string, fileName: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const safeFileName = fileName.replace(/[\\/:*?"<>|]/g, "_");
      const destPath = path.join(os.tmpdir(), `autosdms_${Date.now()}_${safeFileName}`);
      const file = fs.createWriteStream(destPath);
      const protocol = url.startsWith("https") ? https : http;
      protocol.get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlinkSync(destPath);
          resolve(this.downloadFile(res.headers.location, fileName));
          return;
        }
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve(destPath)));
        file.on("error", (err) => { fs.unlinkSync(destPath); reject(err); });
      }).on("error", (err) => { fs.unlinkSync(destPath); reject(err); });
    });
  }

  /** 팝업에서 첨부파일 업로드 */
  private async uploadAttachments(popup: Page, item: OtherWorkDraft): Promise<void> {
    if (!item.attachments || item.attachments.length === 0) return;

    // 파일 업로드 영역 펼치기
    await popup.evaluate(() => {
      const el = document.getElementById("fileUpLoad_pnl_addFile") as HTMLElement | null;
      if (el) el.click();
    });
    await popup.waitForTimeout(800);

    // 기존 첨부파일 삭제 (서버 세션 캐시로 이전 파일이 남아있을 수 있음)
    const fileCount = await popup.evaluate(() =>
      document.querySelectorAll("[id='fileUpLoad_btn_delete']").length
    );
    console.log(`[OTHER-WORK] 기존 첨부파일 ${fileCount}개 삭제 시작`);
    for (let i = 0; i < fileCount; i++) {
      await popup.evaluate(() => {
        const el = document.querySelector("[id='fileUpLoad_btn_delete']") as HTMLElement | null;
        if (el) el.click();
      });
      await popup.waitForLoadState("networkidle").catch(() => undefined);
      await popup.waitForTimeout(300);
    }

    for (const attachment of item.attachments) {
      let tempPath: string | null = null;
      try {
        console.log(`[OTHER-WORK] 첨부파일 다운로드: "${attachment.name}"`);
        tempPath = await this.downloadFile(attachment.url, attachment.name);

        // input[type="file"] 에 직접 파일 경로 주입
        const fileInput = popup.locator("input[type='file']").first();
        await fileInput.setInputFiles(tempPath);
        await popup.waitForTimeout(500);

        await popup.evaluate(() => {
          const btn = document.getElementById("fileUpLoad_btn_add") as HTMLElement | null;
          if (btn) btn.click();
        });
        await popup.waitForLoadState("networkidle").catch(() => undefined);
        await popup.waitForTimeout(500);

        console.log(`[OTHER-WORK] 첨부파일 업로드 완료: "${attachment.name}"`);
      } catch (err) {
        console.log(`[OTHER-WORK] 첨부파일 업로드 실패 "${attachment.name}": ${err instanceof Error ? err.message : err}`);
      } finally {
        if (tempPath && fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      }
    }
  }

  private async openInsertPopup(context: BrowserContext, mainPage: Page): Promise<Page> {
    const popupPromise = context.waitForEvent("page", { timeout: 10000 }).catch(() => null);
    await mainPage.click("#ctl00_AgileContents_btn_PairInsert");
    const popup = await popupPromise;
    if (!popup) {
      throw new Error("Could not open Other Work popup.");
    }
    await popup.waitForLoadState("domcontentloaded");
    return popup;
  }

  private async submitOne(context: BrowserContext, mainPage: Page, item: OtherWorkDraft): Promise<void> {
    const erpTitle = this.formatErpTitle(item.title, item.finishDate);
    const fileBase = this.fileSafe(erpTitle);
    const beforeCount = await this.countTitleOnList(mainPage, erpTitle);
    const popup = await this.openInsertPopup(context, mainPage);

    let dialogMessage = "";
    popup.on("dialog", async (dialog) => {
      dialogMessage = dialog.message();
      await dialog.accept().catch(() => undefined);
    });

    await popup.fill("#txt_subject", erpTitle);
    await this.setSelect(popup, "#ddl_priority", item.priority, true);
    await this.setSelect(popup, "#ddl_status", item.status, true);

    // Always require solution for stable registration.
    await this.setCheckbox(popup, "#chk_oldVersion", true);
    const desiredSolution = item.solutionCode?.trim() ? item.solutionCode : item.project;
    await this.setSelect(popup, "#ddl_solutioncode", desiredSolution, true);

    // Sprint must always be checked.
    await this.setCheckbox(popup, "#chk_addSprint", true);

    await this.setSelect(popup, "#ddl_workType", item.workType, true);
    await popup.waitForTimeout(300);
    await this.setSelect(popup, "#ddl_workDetail", item.workDetail, true);

    if (item.pmEmpNumber?.trim()) {
      await popup.fill("#txt_empnumber_txt_pm", item.pmEmpNumber.trim());
    }

    await popup.fill("#txt_finishdate_txt_date", item.finishDate);

    // 첨부파일 업로드 (PostBack으로 폼이 리셋되므로 workcomment 입력 전에 처리)
    await this.uploadAttachments(popup, item);

    await popup.fill("#txt_workcomment", this.truncateComment(item.workComment, item.title));
    await popup.waitForTimeout(PRE_SUBMIT_DELAY_MS);

    const submitResult = await this.submitWithRetryOnSprintError(popup);
    const closed = submitResult.closed;

    if (!closed) {
      await popup.screenshot({
        path: path.join(this.artifactsDir, `${fileBase}-after-submit-open.png`),
        fullPage: true
      });
    }

    if (this.isErrorDialog(dialogMessage)) {
      throw new Error(`Popup dialog error: ${dialogMessage}`);
    }

    if (!closed) {
      const inlineWarning = await this.readInlineWarningText(popup);
      if (inlineWarning) {
        await this.closeInlineWarningIfAny(popup);
        throw new Error(`Popup warning: ${inlineWarning}`);
      }

      if (submitResult.warning) {
        throw new Error(`Popup warning: ${submitResult.warning}`);
      }

      const validationVisible = await popup
        .locator("text=/필수|입력|선택|오류|실패|에러|invalid|required/i")
        .first()
        .isVisible({ timeout: 1000 })
        .catch(() => false);
      if (validationVisible) {
        throw new Error("Validation/error text is visible in popup after submit.");
      }
      throw new Error("Submit result is uncertain: popup did not close.");
    }

    await this.openOtherWorkPage(mainPage);
    await mainPage.waitForTimeout(600);
    const afterCount = await this.countTitleOnList(mainPage, erpTitle);

    if (afterCount === 0) {
      throw new Error("Registration not visible on list page after submit.");
    }

    if (beforeCount > 0 && afterCount <= beforeCount) {
      if (submitResult.sprintWarningHandled) {
        // Sprint mapping warning path: row may already exist with same title/date.
        return;
      }
      await mainPage.screenshot({
        path: path.join(this.artifactsDir, `${fileBase}-list-unchanged.png`),
        fullPage: true
      });
      throw new Error("List count for title did not increase after submit.");
    }
  }

  /** Dismiss any modal overlay that appears after a scrum save action */
  private async dismissScrumModal(scrumPopup: Page, stepNum: number): Promise<void> {
    // Check if a modal background is blocking the UI
    const modalBg = scrumPopup.locator("#pop_error_mpe_error_backgroundElement");
    const isBlocked = await modalBg.isVisible({ timeout: 2000 }).catch(() => false);
    if (!isBlocked) return;

    console.log(`[DAILY-SCRUM] Modal overlay detected after step ${stepNum}. Attempting to dismiss...`);

    // 모달 메시지 내용 캡처
    const modalMsg = await scrumPopup.evaluate(() => {
      const panels = document.querySelectorAll("[id*='pop_error']");
      let text = "";
      panels.forEach(p => { text += (p as HTMLElement).innerText + " "; });
      return text.trim();
    });
    console.log(`[DAILY-SCRUM] Modal message: "${modalMsg}"`);

    await scrumPopup.screenshot({
      path: path.join(this.artifactsDir, `daily-scrum-modal-${stepNum}.png`),
      fullPage: true
    });

    // Try common dismiss buttons: OK, 확인, Close, etc.
    const dismissSelectors = [
      "#pop_error_btn_ok",
      "#pop_error_btnl_ok",
      "#pop_error [id*='btn']",
      "#pop_error a",
      "div[id*='pop_error'] a",
      "div[id*='pop_error'] input[type='button']",
    ];

    for (const sel of dismissSelectors) {
      const btn = scrumPopup.locator(sel).first();
      const visible = await btn.isVisible({ timeout: 1000 }).catch(() => false);
      if (visible) {
        const btnText = await btn.innerText().catch(() => "");
        console.log(`[DAILY-SCRUM] Clicking dismiss button: ${sel} (text="${btnText}")`);
        await btn.click();
        await scrumPopup.waitForTimeout(500);
        // Check if modal is gone
        const stillBlocked = await modalBg.isVisible({ timeout: 500 }).catch(() => false);
        if (!stillBlocked) {
          console.log(`[DAILY-SCRUM] Modal dismissed successfully.`);
          return;
        }
      }
    }

    // Last resort: hide the modal via JS
    console.log(`[DAILY-SCRUM] Removing modal overlay via JS...`);
    await scrumPopup.evaluate(() => {
      const bg = document.getElementById("pop_error_mpe_error_backgroundElement");
      if (bg) bg.style.display = "none";
      // Also hide any popup panel
      const panels = document.querySelectorAll("[id*='pop_error']");
      panels.forEach(p => (p as HTMLElement).style.display = "none");
    });
    await scrumPopup.waitForTimeout(500);
  }

  /** Register 전일 업무내용 in the scrum popup */
  private async registerYesterdayWork(
    scrumPopup: Page,
    yesterdayItems: OtherWorkDraft[]
  ): Promise<void> {
    if (yesterdayItems.length === 0) {
      console.log(`[DAILY-SCRUM] No 전일 업무 items to register.`);
      return;
    }

    // Check existing items in 전일 업무 grid for duplicate detection
    // Use short timeout: grid may not exist if no items are registered yet
    const yesterdayGrid = scrumPopup.locator("#grid_set_yesterday");
    const gridExists = await yesterdayGrid.count().catch(() => 0);
    const existingYesterdayText = gridExists > 0
      ? await yesterdayGrid.innerText({ timeout: 2000 }).catch(() => "")
      : "";
    const normalizedYesterday = this.normalizeText(existingYesterdayText);

    // Filter: skip items already in the grid
    const itemsToRegister: OtherWorkDraft[] = [];
    for (const item of yesterdayItems) {
      const erpTitle = this.formatErpTitle(item.title, item.finishDate);
      const normalizedErpTitle = this.normalizeText(erpTitle);
      const normalizedOrigTitle = this.normalizeText(item.title);
      if (normalizedYesterday.includes(normalizedErpTitle) || normalizedYesterday.includes(normalizedOrigTitle)) {
        console.log(`[DAILY-SCRUM] SKIP 전일 (duplicate): "${erpTitle}" already exists.`);
      } else {
        itemsToRegister.push(item);
      }
    }

    if (itemsToRegister.length === 0) {
      console.log(`[DAILY-SCRUM] All 전일 업무 items already registered.`);
      return;
    }

    // Check if there are already registered items in the 전일 grid
    const hasExistingYesterdayItems = existingYesterdayText.trim().length > 0;

    // Calculate work time: 8 hours / number of items, rounded to 1 decimal
    const workTimePerItem = Math.round((8 / itemsToRegister.length) * 10) / 10;
    const workTimeStr = workTimePerItem.toFixed(1);
    console.log(`[DAILY-SCRUM] 전일 업무: ${itemsToRegister.length} item(s), ${workTimeStr}h each.`);

    for (let i = 0; i < itemsToRegister.length; i++) {
      const item = itemsToRegister[i];
      const erpTitle = this.formatErpTitle(item.title, item.finishDate);
      console.log(`[DAILY-SCRUM] 전일 (${i + 1}/${itemsToRegister.length}) Registering: ${erpTitle}`);

      // If there are already registered items OR this is 2nd+ new item,
      // click 추가 button to create a new input row first.
      if (i > 0 || hasExistingYesterdayItems) {
        console.log(`[DAILY-SCRUM] Clicking 전일 추가 button...`);
        await scrumPopup.click("#btn_yesterday_add");
        await scrumPopup.waitForSelector("#txt_YesterName", { timeout: 10000 });
      }

      // 시간 입력 — 여러 방법 시도
      // 1차: evaluate로 직접 value 설정 + 이벤트 발생
      await scrumPopup.evaluate((val) => {
        const ids = ["txt_totalWorkTime", "txt_workTime"];
        for (const id of ids) {
          const el = document.getElementById(id) as HTMLInputElement | null;
          if (el && el.offsetParent !== null) {
            el.focus();
            el.value = val;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            el.blur();
          }
        }
      }, workTimeStr);
      await scrumPopup.waitForTimeout(300);

      // 2차: 검증 — 값이 안 들어갔으면 키보드 입력 시도
      const timeVal = await scrumPopup.evaluate(() => {
        const t1 = document.getElementById("txt_totalWorkTime") as HTMLInputElement | null;
        const t2 = document.getElementById("txt_workTime") as HTMLInputElement | null;
        return { totalWorkTime: t1?.value ?? "", workTime: t2?.value ?? "" };
      });


      if (!timeVal.totalWorkTime && !timeVal.workTime) {
        // 키보드 입력 fallback
        for (const id of ["#txt_totalWorkTime", "#txt_workTime"]) {
          const el = scrumPopup.locator(id);
          if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
            await el.click({ clickCount: 3 });
            await scrumPopup.keyboard.type(workTimeStr);
            await scrumPopup.keyboard.press("Tab");
            await scrumPopup.waitForTimeout(300);
            console.log(`[DAILY-SCRUM] Keyboard fallback: set ${id} = "${workTimeStr}"`);
            break;
          }
        }
      }
      console.log(`[DAILY-SCRUM] Set workTime: "${workTimeStr}"`);

      // Click 업무 textbox to open findScrumWork popup
      const t0 = Date.now();
      console.log(`[DAILY-SCRUM] Clicking 전일 업무 textbox...`);
      const findWorkPopupPromise = scrumPopup.waitForEvent("popup", { timeout: 15000 });
      await scrumPopup.click("#txt_YesterName");
      const findWorkPopup = await findWorkPopupPromise;
      await findWorkPopup.waitForLoadState("domcontentloaded");
      console.log(`[DAILY-SCRUM][TIME] 전일 popup loaded: ${Date.now() - t0}ms`);

      // Find and click the matching item
      console.log(`[DAILY-SCRUM] Searching for "${erpTitle}" in findScrumWork...`);
      const itemLink = findWorkPopup.locator(`text=${erpTitle}`).first();
      const found = await itemLink.isVisible({ timeout: 5000 }).catch(() => false);
      if (!found) {
        console.log(`[DAILY-SCRUM] ERP title not found, trying original title "${item.title}"...`);
        const fallbackLink = findWorkPopup.locator(`text=${item.title}`).first();
        const fallbackFound = await fallbackLink.isVisible({ timeout: 3000 }).catch(() => false);
        if (!fallbackFound) {
          console.log(`[DAILY-SCRUM] WARNING: Could not find "${erpTitle}" in findScrumWork. Skipping.`);
          if (!findWorkPopup.isClosed()) await findWorkPopup.close().catch(() => undefined);
          continue;
        }
        await fallbackLink.click();
      } else {
        await itemLink.click();
      }

      // Wait for popup to close
      await Promise.race([
        findWorkPopup.waitForEvent("close", { timeout: 5000 }).catch(() => undefined),
        scrumPopup.waitForFunction(
          () => (document.getElementById("txt_YesterName") as HTMLInputElement)?.value?.trim().length > 0,
          { timeout: 5000 }
        ).catch(() => undefined),
      ]);
      if (!findWorkPopup.isClosed()) {
        await findWorkPopup.close().catch(() => undefined);
      }

      // Fill 전일 업무내용
      console.log(`[DAILY-SCRUM] Filling 전일 업무내용...`);
      await scrumPopup.fill("#txt_yesterdayWorkInsert_txt", this.truncateComment(item.workComment, item.title));

      // Set 진행률 (Notion 예정률 or default 100%)
      const yesterdayRate = item.progressRate ? `${item.progressRate}%` : "100%";
      await scrumPopup.selectOption("#ddl_yesterdaycompleterate", { label: yesterdayRate });

      console.log(`[DAILY-SCRUM][TIME] 전일 fill complete: ${Date.now() - t0}ms`);

      // Click 등록 button
      console.log(`[DAILY-SCRUM] Clicking 전일 등록 button...`);
      await scrumPopup.click("#btnl_yesterdayaddScrum");
      await scrumPopup.waitForTimeout(1500);

      // Dismiss modal if appears
      await this.dismissScrumModal(scrumPopup, i + 1);

      console.log(`[DAILY-SCRUM] 전일 (${i + 1}/${itemsToRegister.length}) Saved: ${erpTitle}`);
    }

    console.log(`[DAILY-SCRUM] 전일 업무 registration complete.`);
  }

  /** Register 업무일지 on business.aspx */
  async registerBusinessLog(
    context: BrowserContext,
    mainPage: Page,
    items: OtherWorkDraft[],
    dateYmd: string
  ): Promise<void> {
    if (items.length === 0) {
      console.log(`[BUSINESS-LOG] No items to register.`);
      return;
    }

    // 1. Navigate to business.aspx
    console.log(`[BUSINESS-LOG] Navigating to 업무일지 page...`);
    await mainPage.goto(BUSINESS_LOG_URL, { waitUntil: "domcontentloaded" });
    await mainPage.waitForSelector("#ctl00_ctl00_PROJECT_PROJECTContents_ddl_year", { timeout: 10000 });

    // 2. Set year and month from dateYmd (YYYY-MM-DD)
    const [yearStr, monthStr, dayStr] = dateYmd.split("-");
    console.log(`[BUSINESS-LOG] Setting year=${yearStr}, month=${monthStr}...`);
    await mainPage.selectOption("#ctl00_ctl00_PROJECT_PROJECTContents_ddl_year", yearStr);
    await mainPage.selectOption("#ctl00_ctl00_PROJECT_PROJECTContents_ddl_month", monthStr.replace(/^0/, ""));
    await mainPage.waitForLoadState("networkidle").catch(() => undefined);
    await mainPage.waitForTimeout(500);

    // 3. Click the calendar date cell to open the registration popup
    const dayNum = parseInt(dayStr, 10);
    console.log(`[BUSINESS-LOG] Clicking calendar day ${dayNum}...`);

    await mainPage.screenshot({
      path: path.join(this.artifactsDir, "business-log-calendar.png"),
      fullPage: true
    });

    // Find the calendar cell with the matching day number inside #udp_setDay
    const calendarPanel = mainPage.locator("#ctl00_ctl00_PROJECT_PROJECTContents_udp_setDay");

    // Calendar day cells typically use <a> with href="javascript:__doPostBack(...)"
    const dayCell = calendarPanel.locator(`a`).filter({ hasText: new RegExp(`^${dayNum}$`) }).first();
    const dayCellExists = await dayCell.isVisible({ timeout: 5000 }).catch(() => false);

    // Set up popup listener BEFORE clicking the calendar cell
    const bizPopupPromise = context.waitForEvent("page", { timeout: 15000 }).catch(() => null);

    if (dayCellExists) {
      console.log(`[BUSINESS-LOG] Found day cell, clicking...`);
      await dayCell.click();
    } else {
      // Fallback: try clicking by evaluating the calendar grid
      console.log(`[BUSINESS-LOG] Day cell not found. Trying JS click...`);
      await mainPage.evaluate((day) => {
        const panel = document.getElementById("ctl00_ctl00_PROJECT_PROJECTContents_udp_setDay");
        if (!panel) throw new Error("Calendar panel not found");
        const links = panel.querySelectorAll("a");
        for (const a of links) {
          if (a.textContent?.trim() === String(day)) {
            a.click();
            return;
          }
        }
        throw new Error(`Day ${day} not found in calendar`);
      }, dayNum);
    }

    // Wait for popup or inline panel
    const bizPopup = await bizPopupPromise;

    if (bizPopup) {
      // New window popup
      await bizPopup.waitForLoadState("domcontentloaded");
      await bizPopup.waitForLoadState("networkidle").catch(() => undefined);

      // 근태 등록 팝업 처리: 출근 시간이 미등록이면 근태 등록 모달이 뜸
      const attendPopup = bizPopup.locator("#pop_attend_btnl_addAttend");
      const attendVisible = await attendPopup.isVisible({ timeout: 3000 }).catch(() => false);
      if (attendVisible) {
        console.log(`[BUSINESS-LOG] 근태 등록 팝업 감지. 출근 등록 진행...`);
        await attendPopup.click();
        await bizPopup.waitForLoadState("networkidle").catch(() => undefined);
        await bizPopup.waitForTimeout(1500);
        console.log(`[BUSINESS-LOG] 근태 등록 완료.`);
      }

      await bizPopup.waitForSelector("#btnl_addBusinessConfirm", { timeout: 10000 });
      console.log(`[BUSINESS-LOG] 업무일지 등록 팝업 opened (new window).`);
    } else {
      // Calendar click may trigger a PostBack that reloads the page with an inline form
      console.log(`[BUSINESS-LOG] No popup detected. Checking if calendar triggered PostBack...`);
      await mainPage.waitForLoadState("networkidle").catch(() => undefined);
      await mainPage.screenshot({
        path: path.join(this.artifactsDir, "business-log-after-day-click.png"),
        fullPage: true
      });
      // Check if #btnl_addBusinessConfirm appeared inline
      const inlineConfirm = await mainPage.locator("#btnl_addBusinessConfirm").isVisible({ timeout: 5000 }).catch(() => false);
      if (!inlineConfirm) {
        throw new Error("Calendar day click did not open any registration form.");
      }
      console.log(`[BUSINESS-LOG] 업무일지 등록 form found inline.`);
    }

    // Use the correct page reference (popup window or inline form on mainPage)
    const formPage = bizPopup ?? mainPage;
    const isPopup = !!bizPopup;

    await formPage.screenshot({
      path: path.join(this.artifactsDir, "business-log-form-opened.png"),
      fullPage: true
    });

    // 4. 기존 등록된 행 감지 (삭제 버튼 → 수정 버튼 순으로 탐색)
    const existingRows = await formPage.evaluate(() => {
      const rows: Array<{ rowId: string; projectText: string; hasDeleteBtn: boolean }> = [];
      const seen = new Set<string>();

      // 삭제 버튼으로 탐색
      const deleteBtns = document.querySelectorAll("[id*='btnl_deleteBusiness']");
      for (const btn of deleteBtns) {
        const match = btn.id.match(/(.+)_btnl_deleteBusiness/);
        if (!match) continue;
        const rowId = match[1];
        if (seen.has(rowId)) continue;
        seen.add(rowId);
        const tr = btn.closest("tr");
        if (!tr) continue;
        const tds = tr.querySelectorAll("td");
        const projectText = (tds[0]?.textContent?.trim() ?? "").replace(/\s+/g, "");
        if (projectText) {
          rows.push({ rowId, projectText, hasDeleteBtn: true });
        }
      }

      // 삭제 버튼이 없으면 수정 버튼으로 탐색
      if (rows.length === 0) {
        const modifyBtns = document.querySelectorAll("[id*='btnl_modifyBusiness']");
        for (const btn of modifyBtns) {
          const match = btn.id.match(/(.+)_btnl_modifyBusiness/);
          if (!match) continue;
          const rowId = match[1];
          if (seen.has(rowId)) continue;
          seen.add(rowId);
          const tr = btn.closest("tr");
          if (!tr) continue;
          const tds = tr.querySelectorAll("td");
          const projectText = (tds[0]?.textContent?.trim() ?? "").replace(/\s+/g, "");
          if (projectText) {
            rows.push({ rowId, projectText, hasDeleteBtn: false });
          }
        }
      }

      return rows;
    }).catch(() => []);

    console.log(`[BUSINESS-LOG] Existing rows: ${existingRows.length}`);
    for (const row of existingRows) {
      console.log(`[BUSINESS-LOG]   ${row.rowId}: project="${row.projectText.substring(0, 40)}..." deleteBtn=${row.hasDeleteBtn}`);
    }

    // 5. 기존 행 모두 삭제 (역순으로 — 행 번호 변동 방지)
    const deletableRows = existingRows.filter((r) => r.hasDeleteBtn);
    if (deletableRows.length > 0) {
      console.log(`[BUSINESS-LOG] Deleting ${deletableRows.length} existing row(s)...`);

      for (const row of [...deletableRows].reverse()) {
        console.log(`[BUSINESS-LOG] Deleting ${row.rowId}...`);

        // confirm()을 자동 수락하고, JS로 직접 클릭 (td intercept 회피)
        const deleted = await formPage.evaluate((rid) => {
          // confirm을 일시적으로 오버라이드하여 자동 true 반환
          const origConfirm = window.confirm;
          window.confirm = () => true;
          try {
            const btn = document.getElementById(`${rid}_btnl_deleteBusiness`);
            if (btn) {
              (btn as HTMLElement).click();
              return true;
            }
            return false;
          } finally {
            // confirm 복원
            setTimeout(() => { window.confirm = origConfirm; }, 500);
          }
        }, row.rowId);

        if (!deleted) {
          console.log(`[BUSINESS-LOG] WARNING: Could not find delete button for ${row.rowId}. Skipping.`);
          continue;
        }

        await formPage.waitForLoadState("networkidle").catch(() => undefined);
        await formPage.waitForTimeout(1500);
        console.log(`[BUSINESS-LOG] Deleted ${row.rowId}`);
      }
      console.log(`[BUSINESS-LOG] All existing rows deleted.`);
    }

    // 6. 같은 프로젝트 항목 합치기 (workComment 이어붙이기)
    const grouped = new Map<string, OtherWorkDraft[]>();
    for (const item of items) {
      const key = item.project?.trim() || "공통업무";
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(item);
    }

    const mergedItems: OtherWorkDraft[] = [];
    for (const [project, group] of grouped) {
      const merged = { ...group[0] };
      if (group.length > 1) {
        merged.workComment = group.map((g) => g.workComment).join("\n");
        merged.title = group.map((g) => g.title).join(" / ");
        console.log(`[BUSINESS-LOG] Merged ${group.length} items for project "${project}"`);
      }
      mergedItems.push(merged);
    }

    console.log(`[BUSINESS-LOG] ${mergedItems.length} project(s) to register (merged from ${items.length} items).`);

    if (mergedItems.length === 0) {
      console.log(`[BUSINESS-LOG] No items to register. Closing form.`);
      if (isPopup) await formPage.close().catch(() => undefined);
      return;
    }

    // 7. Check if start time is disabled (skip setting start time, but still fill end time + content)
    const sHourDisabled = await formPage.locator("#ddl_shour").isDisabled().catch(() => false);
    if (sHourDisabled) {
      console.log(`[BUSINESS-LOG] Start time is disabled. Will skip start time, fill end time + content only.`);
    }

    // 8. 전부 신규 등록 (기존 행은 이미 삭제됨)
    for (let i = 0; i < mergedItems.length; i++) {
      const item = mergedItems[i];
      const erpTitle = this.formatErpTitle(item.title, item.finishDate);
      console.log(`[BUSINESS-LOG] (${i + 1}/${mergedItems.length}) Registering: ${erpTitle}`);

      // 2번째 이상 항목이면 추가 버튼 클릭하여 새 입력행 생성
      if (i > 0) {
        console.log(`[BUSINESS-LOG] Clicking 추가 button...`);
        await formPage.click("#btnl_add");
        // PostBack으로 새 입력행이 추가되므로 충분히 대기
        await formPage.waitForLoadState("networkidle").catch(() => undefined);
        await formPage.waitForTimeout(2000);
        console.log(`[BUSINESS-LOG] 추가 row ready.`);
      }

      // Calculate time slots: distribute 9:00-18:00 evenly across items
      const totalMinutes = 540; // 9 hours = 540 minutes
      const minutesPerItem = Math.floor(totalMinutes / mergedItems.length);
      const startMinutesFromNine = i * minutesPerItem;
      const endMinutesFromNine = (i + 1) * minutesPerItem;

      const startHour = 9 + Math.floor(startMinutesFromNine / 60);
      const startMin = startMinutesFromNine % 60;
      const endHour = 9 + Math.floor(endMinutesFromNine / 60);
      const endMin = endMinutesFromNine % 60;

      const sHour = String(startHour).padStart(2, "0");
      const sMin = String(startMin).padStart(2, "0");
      const eHour = String(endHour).padStart(2, "0");
      const eMin = String(endMin).padStart(2, "0");

      // Set start time (skip if disabled)
      if (!sHourDisabled) {
        console.log(`[BUSINESS-LOG] Setting time: ${sHour}:${sMin} ~ ${eHour}:${eMin}`);
        await formPage.selectOption("#ddl_shour", sHour);
        await formPage.selectOption("#ddl_smin", sMin);
      } else {
        console.log(`[BUSINESS-LOG] Setting end time only: ~${eHour}:${eMin}`);
      }

      // Set end time
      await formPage.selectOption("#ddl_hour", eHour);
      await formPage.selectOption("#ddl_min", eMin);

      // Click project textbox to open project selection popup
      console.log(`[BUSINESS-LOG] Opening project selection...`);
      const projectName = item.project?.trim();

      const projPopupPromise = context.waitForEvent("page", { timeout: 15000 }).catch(() => null);
      await formPage.click("#txt_project");
      const projPopup = await projPopupPromise;

      if (projPopup && projPopup !== formPage && projPopup !== mainPage) {
        await projPopup.waitForLoadState("domcontentloaded");
        await projPopup.waitForLoadState("networkidle").catch(() => undefined);

        if (projectName) {
          // Search and select the project (공백 제거 후 비교)
          console.log(`[BUSINESS-LOG] Searching for project: "${projectName}"...`);
          const normalizedTarget = projectName.replace(/\s+/g, "");

          // 팝업 내 <a> 링크에서 공백 제거 후 프로젝트명 매칭 → 클릭
          const clicked = await projPopup.evaluate((target) => {
            const links = document.querySelectorAll("a");
            for (const a of links) {
              const text = (a.textContent?.trim() ?? "").replace(/\s+/g, "");
              if (text && text === target) {
                (a as HTMLElement).click();
                return a.textContent?.trim() ?? "";
              }
            }
            return "";
          }, normalizedTarget).catch(() => "");

          if (clicked) {
            console.log(`[BUSINESS-LOG] Project matched and clicked: "${clicked}"`);
          } else {
            // Fallback: select "공통업무"
            console.log(`[BUSINESS-LOG] Project not found. Selecting "공통업무"...`);
            await projPopup.evaluate(() => {
              const links = document.querySelectorAll("a");
              for (const a of links) {
                if (a.textContent?.trim().includes("공통업무")) {
                  (a as HTMLElement).click();
                  return;
                }
              }
            }).catch(() => undefined);
          }
        } else {
          // No project → select "공통업무"
          console.log(`[BUSINESS-LOG] No project specified. Selecting "공통업무"...`);
          const commonLink = projPopup.locator("text=공통업무").first();
          await commonLink.click().catch(() => undefined);
        }

        // Wait for popup to close
        await Promise.race([
          projPopup.waitForEvent("close", { timeout: 5000 }).catch(() => undefined),
          formPage.waitForFunction(
            () => (document.getElementById("txt_project") as HTMLInputElement)?.value?.trim().length > 0,
            { timeout: 5000 }
          ).catch(() => undefined),
        ]);
        if (!projPopup.isClosed()) {
          await projPopup.close().catch(() => undefined);
        }
      }

      // Fill 프로젝트 진행정보 with Notion 업무내용
      console.log(`[BUSINESS-LOG] Filling 프로젝트 진행정보...`);
      await formPage.fill("#txt_projectNoteInsert_txt", this.truncateComment(item.workComment, item.title));

      // 개별 등록 버튼 클릭 (각 항목마다 저장해야 다음 항목이 덮어쓰지 않음)
      console.log(`[BUSINESS-LOG] Clicking 개별 등록 button...`);
      await formPage.click("#btnl_oneaddBusiness");
      await formPage.waitForLoadState("networkidle").catch(() => undefined);
      await formPage.waitForTimeout(1500);

      console.log(`[BUSINESS-LOG] (${i + 1}/${items.length}) Saved: ${erpTitle}`);
    }

    // 6. Click 최종 등록 button
    console.log(`[BUSINESS-LOG] Clicking 최종 등록 button...`);
    formPage.on("dialog", async (dialog) => {
      console.log(`[BUSINESS-LOG] Dialog: ${dialog.message()}`);
      await dialog.accept().catch(() => undefined);
    });

    try {
      if (isPopup) {
        const closePromise = formPage.waitForEvent("close", { timeout: 10000 }).catch(() => undefined);
        await formPage.click("#btnl_addBusinessConfirm");
        await closePromise;
      } else {
        await formPage.click("#btnl_addBusinessConfirm");
        await formPage.waitForLoadState("networkidle").catch(() => undefined);
      }
    } catch {
      console.log(`[BUSINESS-LOG] Form closed after registration.`);
    }

    await mainPage.waitForTimeout(1000);
    await mainPage.screenshot({
      path: path.join(this.artifactsDir, "business-log-complete.png"),
      fullPage: true
    });
    console.log(`[BUSINESS-LOG] 업무일지 registration complete.`);
  }

  async registerDailyScrum(
    context: BrowserContext,
    mainPage: Page,
    items: OtherWorkDraft[],
    dateYmd: string,
    yesterdayItems: OtherWorkDraft[] = []
  ): Promise<void> {
    // 1. Navigate to Daily Scrum page
    console.log(`[DAILY-SCRUM] Navigating to Daily Scrum page...`);
    await mainPage.goto(DAILY_SCRUM_URL, { waitUntil: "domcontentloaded" });
    await mainPage.waitForSelector("#ctl00_AgileContents_txt_date_txt_date", { timeout: 10000 });

    // 2. Set the scrum date
    console.log(`[DAILY-SCRUM] Setting scrum date to ${dateYmd}...`);
    const dateSelector = "#ctl00_AgileContents_txt_date_txt_date";
    await mainPage.fill(dateSelector, "");
    await mainPage.fill(dateSelector, dateYmd);
    await mainPage.waitForTimeout(500);

    // 3. Click register button → opens scrum form popup
    console.log(`[DAILY-SCRUM] Opening scrum form popup...`);
    const scrumPopupPromise = context.waitForEvent("page", { timeout: 15000 });
    await mainPage.click("#ctl00_AgileContents_btnl_addDailyScrum");
    const scrumPopup = await scrumPopupPromise;
    await scrumPopup.waitForLoadState("domcontentloaded");
    // Wait for the scrum form UI to be ready (skip slow networkidle)
    await scrumPopup.waitForSelector("#btn_ok", { timeout: 10000 });

    await scrumPopup.screenshot({
      path: path.join(this.artifactsDir, "daily-scrum-form-opened.png"),
      fullPage: true
    });

    // 4. Check existing items in 금일 예정업무 grid for duplicate detection
    const todayGrid = scrumPopup.locator("#grid_set_today");
    const todayGridExists = await todayGrid.count().catch(() => 0);
    const existingGridText = todayGridExists > 0
      ? await todayGrid.innerText({ timeout: 2000 }).catch(() => "")
      : "";
    const normalizedGrid = this.normalizeText(existingGridText);

    // Filter items: skip those whose ERP title is already in the grid
    const itemsToRegister: OtherWorkDraft[] = [];
    for (const item of items) {
      const erpTitle = this.formatErpTitle(item.title, item.finishDate);
      const normalizedErpTitle = this.normalizeText(erpTitle);
      const normalizedOrigTitle = this.normalizeText(item.title);
      if (normalizedGrid.includes(normalizedErpTitle) || normalizedGrid.includes(normalizedOrigTitle)) {
        console.log(`[DAILY-SCRUM] SKIP (duplicate): "${erpTitle}" already exists in 금일 예정업무.`);
      } else {
        itemsToRegister.push(item);
      }
    }

    if (itemsToRegister.length === 0 && yesterdayItems.length === 0) {
      console.log(`[DAILY-SCRUM] All items already registered and no 전일 업무. Closing scrum popup.`);
      await scrumPopup.close().catch(() => undefined);
      await mainPage.waitForTimeout(500);
      await mainPage.screenshot({
        path: path.join(this.artifactsDir, "daily-scrum-all-skipped.png"),
        fullPage: true
      });
      console.log(`[DAILY-SCRUM] Daily scrum registration complete (all skipped).`);
      return;
    }

    // === 전일 업무 등록 ===
    await this.registerYesterdayWork(scrumPopup, yesterdayItems);

    // Check if there are already registered items in the grid (no empty template row)
    const hasExistingTodayItems = existingGridText.trim().length > 0;

    console.log(`[DAILY-SCRUM] 금일 예정업무: ${itemsToRegister.length} item(s) to register, ${items.length - itemsToRegister.length} skipped.`);

    // 5. For each new item: open findScrumWork, select item, fill content, save
    for (let i = 0; i < itemsToRegister.length; i++) {
      const item = itemsToRegister[i];
      const erpTitle = this.formatErpTitle(item.title, item.finishDate);
      console.log(`[DAILY-SCRUM] (${i + 1}/${itemsToRegister.length}) Registering: ${erpTitle}`);

      // If there are already registered items OR this is 2nd+ new item,
      // we need to click 추가(+) to create a new input row first.
      // Only the very first item on an empty grid has a template row ready.
      if (i > 0 || hasExistingTodayItems) {
        console.log(`[DAILY-SCRUM] Clicking 추가 button for new row...`);
        // Clear any existing value in #txt_ToName so we can detect the new empty row
        await scrumPopup.click("#btn_today_add > img");
        // PostBack adds a new template row — wait for it to complete
        await scrumPopup.waitForLoadState("load").catch(() => undefined);
        await scrumPopup.waitForSelector("#txt_ToName", { timeout: 10000 });
        // Ensure onclick handler is bound after PostBack
        await scrumPopup.waitForFunction(
          () => {
            const el = document.getElementById("txt_ToName");
            return el && (el.getAttribute("onclick") || (el as any).onclick);
          },
          { timeout: 5000 }
        ).catch(() => undefined);
      }

      // 5-1. Click 업무 textbox to open findScrumWork popup
      let t0 = Date.now();
      console.log(`[DAILY-SCRUM] Clicking 업무 textbox to open findScrumWork...`);
      let findWorkPopup;
      try {
        const findWorkPopupPromise = scrumPopup.waitForEvent("popup", { timeout: 15000 });
        await scrumPopup.click("#txt_ToName");
        findWorkPopup = await findWorkPopupPromise;
      } catch {
        console.log(`[DAILY-SCRUM] WARNING: findScrumWork popup not opened for "${erpTitle}". Skipping.`);
        continue;
      }
      console.log(`[DAILY-SCRUM][TIME] popup detected: ${Date.now() - t0}ms`);

      t0 = Date.now();
      await findWorkPopup.waitForLoadState("domcontentloaded");
      console.log(`[DAILY-SCRUM][TIME] domcontentloaded: ${Date.now() - t0}ms`);

      // 5-2. Find and click the matching 기타업무 item by ERP title
      t0 = Date.now();
      console.log(`[DAILY-SCRUM] Searching for "${erpTitle}" in findScrumWork...`);
      const itemLink = findWorkPopup.locator(`text=${erpTitle}`).first();
      const found = await itemLink.isVisible({ timeout: 5000 }).catch(() => false);
      if (!found) {
        console.log(`[DAILY-SCRUM] ERP title not found, trying original title "${item.title}"...`);
        const fallbackLink = findWorkPopup.locator(`text=${item.title}`).first();
        const fallbackFound = await fallbackLink.isVisible({ timeout: 3000 }).catch(() => false);
        if (!fallbackFound) {
          throw new Error(`Could not find "${erpTitle}" or "${item.title}" in findScrumWork popup.`);
        }
        await fallbackLink.click();
      } else {
        await itemLink.click();
      }
      console.log(`[DAILY-SCRUM][TIME] search+click item: ${Date.now() - t0}ms`);

      // 5-3. Wait for findScrumWork popup to close (or #txt_ToName to be filled)
      t0 = Date.now();
      // The popup should close after clicking the item. Wait for EITHER:
      // - popup close event, OR
      // - #txt_ToName getting a value (meaning selection was applied)
      await Promise.race([
        findWorkPopup.waitForEvent("close", { timeout: 5000 }).catch(() => undefined),
        scrumPopup.waitForFunction(
          () => (document.getElementById("txt_ToName") as HTMLInputElement)?.value?.trim().length > 0,
          { timeout: 5000 }
        ).catch(() => undefined),
      ]);
      // Ensure popup is closed
      if (!findWorkPopup.isClosed()) {
        await findWorkPopup.close().catch(() => undefined);
      }
      console.log(`[DAILY-SCRUM][TIME] popup close: ${Date.now() - t0}ms`);

      // 5-4. Fill work content
      t0 = Date.now();
      console.log(`[DAILY-SCRUM] Filling work content...`);
      await scrumPopup.fill("#txt_todayWorkInsert_txt", this.truncateComment(item.workComment, item.title));

      // 5-5. Select 예정률 (Notion progressRate or default 100%)
      const todayRate = item.progressRate ? `${item.progressRate}%` : "100%";
      console.log(`[DAILY-SCRUM] Setting completion rate to ${todayRate}...`);
      await scrumPopup.selectOption("#ddl_todaycompleterate", { label: todayRate });
      console.log(`[DAILY-SCRUM][TIME] fill+select: ${Date.now() - t0}ms`);

      // 5-6. Click save button
      t0 = Date.now();
      console.log(`[DAILY-SCRUM] Clicking save button...`);
      await scrumPopup.click("#btnl_todayaddScrum");
      await scrumPopup.waitForTimeout(1500);

      // 5-7. Dismiss any modal overlay
      await this.dismissScrumModal(scrumPopup, i + 1);
      console.log(`[DAILY-SCRUM][TIME] save+dismiss: ${Date.now() - t0}ms`);

      console.log(`[DAILY-SCRUM] (${i + 1}/${itemsToRegister.length}) Saved: ${erpTitle}`);
    }

    // 6. Click OK button #btn_ok on scrum form popup
    console.log(`[DAILY-SCRUM] Clicking OK button...`);
    await scrumPopup.click("#btn_ok");
    await scrumPopup.waitForTimeout(1000).catch(() => undefined);

    // 7. Click #btn_add on the confirmation message (popup may close after this)
    console.log(`[DAILY-SCRUM] Clicking confirm button...`);
    try {
      const addBtn = scrumPopup.locator("#btn_add");
      const addBtnVisible = await addBtn.isVisible({ timeout: 3000 }).catch(() => false);
      if (addBtnVisible) {
        await addBtn.click();
        await scrumPopup.waitForEvent("close", { timeout: 5000 }).catch(() => undefined);
      }
    } catch {
      console.log(`[DAILY-SCRUM] Scrum popup closed after confirm.`);
    }

    await mainPage.waitForTimeout(1000);
    await mainPage.screenshot({
      path: path.join(this.artifactsDir, "daily-scrum-complete.png"),
      fullPage: true
    });
    console.log(`[DAILY-SCRUM] Daily scrum registration complete.`);
  }

  /**
   * 주간 업무보고 등록 (BusinessReport.aspx)
   * 1. 페이지 이동 → 주차 선택 → 등록 팝업 열기
   */
  async registerWeeklyReport(
    context: BrowserContext,
    mainPage: Page,
    summaries: WeeklyProjectSummary[],
    weekDate: Date,
    signal?: AbortSignal
  ): Promise<void> {
    console.log(`[WEEKLY-REPORT] Navigating to BusinessReport page...`);
    await mainPage.goto(WEEKLY_REPORT_URL, { waitUntil: "domcontentloaded" });
    await mainPage.waitForLoadState("networkidle");

    // 주차 계산 (ISO week number)
    const weekNum = getIsoWeekNumber(weekDate);
    const weekValue = `w-${weekNum}`;
    console.log(`[WEEKLY-REPORT] Selecting week: ${weekValue}`);

    // 드롭다운 옵션 목록 확인
    const weekSelector = "#ctl00_AgileContents_ddl_weeklySelect";
    const options = await mainPage.$$eval(`${weekSelector} option`, (opts) =>
      opts.map((o) => ({ value: (o as HTMLOptionElement).value, text: o.textContent?.trim() ?? "" }))
    );
    console.log(`[WEEKLY-REPORT] Available options:`, JSON.stringify(options.slice(0, 10)));

    // 주차 매칭: value 또는 text에 "w-{N}" 혹은 "{N}" 이 포함된 옵션 찾기
    const matched = options.find(
      (o) => o.value === weekValue || o.text === weekValue
        || o.value.includes(`-${weekNum}`) || o.text.includes(`-${weekNum}`)
    );

    if (!matched) {
      console.log(`[WEEKLY-REPORT] SKIP: Week "${weekValue}" not found in dropdown. Available: ${options.map((o) => o.text).join(", ")}`);
      return;
    }

    console.log(`[WEEKLY-REPORT] Matched option: value="${matched.value}", text="${matched.text}"`);
    await mainPage.selectOption(weekSelector, { value: matched.value });
    await mainPage.waitForLoadState("networkidle");
    await mainPage.waitForTimeout(1000);

    await mainPage.screenshot({
      path: path.join(this.artifactsDir, "weekly-report-week-selected.png"),
      fullPage: true
    });

    // 등록 팝업 열기
    console.log(`[WEEKLY-REPORT] Clicking 등록 button...`);
    const popupPromise = context.waitForEvent("page", { timeout: 15000 });
    await mainPage.click("#ctl00_AgileContents_btnl_addBusinessReport");
    const reportPopup = await popupPromise;
    await reportPopup.waitForLoadState("domcontentloaded");
    await reportPopup.waitForLoadState("networkidle").catch(() => undefined);

    await reportPopup.screenshot({
      path: path.join(this.artifactsDir, "weekly-report-popup-opened.png"),
      fullPage: true
    });
    console.log(`[WEEKLY-REPORT] Popup opened. URL: ${reportPopup.url()}`);

    // ── 기존 행 감지 ──
    const existingRows = await reportPopup.evaluate(() => {
      const rows: Array<{ rowId: string; projectText: string }> = [];
      const modifyBtns = document.querySelectorAll("[id*='btnl_modifyBusiness']");
      for (const btn of modifyBtns) {
        const match = btn.id.match(/(.+)_btnl_modifyBusiness/);
        if (!match) continue;
        const rowId = match[1]; // e.g. "grid_set_Business_ctl02"
        const tr = btn.closest("tr");
        if (!tr) continue;
        const tds = tr.querySelectorAll("td");
        const projectText = (tds[1]?.textContent?.trim() ?? "").replace(/\s+/g, "");
        rows.push({ rowId, projectText });
      }
      return rows;
    });

    console.log(`[WEEKLY-REPORT] Existing rows: ${existingRows.length}`);
    for (const row of existingRows) {
      console.log(`[WEEKLY-REPORT]   ${row.rowId}: project="${row.projectText.substring(0, 40)}..."`);
    }

    // ── 기존 행 매칭: 프로젝트별로 수정 대상 / 신규 대상 분류 ──
    const updateItems: Array<{ summary: WeeklyProjectSummary; rowId: string }> = [];
    const newItems: WeeklyProjectSummary[] = [];

    for (const summary of summaries) {
      const projNorm = summary.project.replace(/\s+/g, "");
      const matchedRow = existingRows.find((r) => r.projectText.includes(projNorm) || projNorm.includes(r.projectText.replace(/\[.*?\]/g, "")));
      if (matchedRow) {
        updateItems.push({ summary, rowId: matchedRow.rowId });
        console.log(`[WEEKLY-REPORT] UPDATE (same project): "${summary.project}" → ${matchedRow.rowId}`);
      } else {
        newItems.push(summary);
        console.log(`[WEEKLY-REPORT] NEW: "${summary.project}"`);
      }
    }

    // ── 1) 기존 행 수정 ──
    for (const { summary, rowId } of updateItems) {
      checkSignal(signal);
      console.log(`[WEEKLY-REPORT] Modifying ${rowId}: "${summary.project}"`);

      // 수정 버튼 클릭
      const modifyBtnSelector = `#${rowId}_btnl_modifyBusiness`;
      await reportPopup.click(modifyBtnSelector);
      await reportPopup.waitForLoadState("networkidle").catch(() => undefined);
      await reportPopup.waitForTimeout(1000);

      // 진행업무 textarea: 기존 내용 삭제 후 새 내용 입력
      const progressSelector = `#${rowId}_txt_progressWork_txt`;
      const progressText = summary.items.join("\n");
      await reportPopup.evaluate((sel) => {
        const el = document.querySelector(sel) as HTMLTextAreaElement;
        if (el) el.value = "";
      }, progressSelector);
      await reportPopup.fill(progressSelector, progressText);
      console.log(`[WEEKLY-REPORT] Updated content for ${rowId} (${summary.items.length} items)`);

      // 확인(수정 저장) 버튼 클릭 (같은 버튼)
      await reportPopup.click(modifyBtnSelector);
      await reportPopup.waitForLoadState("networkidle").catch(() => undefined);
      await reportPopup.waitForTimeout(1500);
      console.log(`[WEEKLY-REPORT] Saved modification for ${rowId}`);
    }

    // ── 2) 신규 등록 ──
    for (let i = 0; i < newItems.length; i++) {
      checkSignal(signal);
      const summary = newItems[i];
      console.log(`[WEEKLY-REPORT] (${i + 1}/${newItems.length}) NEW Project: "${summary.project}"`);

      // 추가 행 버튼 (첫 번째 신규 항목도 기존 행이 있으면 추가 필요)
      if (i > 0 || existingRows.length > 0) {
        console.log(`[WEEKLY-REPORT] Clicking 추가 button for new row...`);
        await reportPopup.click("#btn_Business_add");
        await reportPopup.waitForLoadState("networkidle").catch(() => undefined);
        await reportPopup.waitForTimeout(1500);
      }

      // 1. 구분 선택: Solution
      console.log(`[WEEKLY-REPORT] Selecting 구분: Solution`);
      await reportPopup.selectOption("#ddl_MainGroup", { label: "Solution" }).catch(async () => {
        await reportPopup.selectOption("#ddl_MainGroup", { value: "Solution" });
      });
      await reportPopup.waitForTimeout(500);

      // 2. 프로젝트 선택 (#txt_SubCodeName 클릭 → 팝업)
      console.log(`[WEEKLY-REPORT] Opening project selection popup...`);
      const projPopupPromise = reportPopup.waitForEvent("popup", { timeout: 15000 }).catch(() =>
        context.waitForEvent("page", { timeout: 5000 }).catch(() => null)
      );
      await reportPopup.click("#txt_SubCodeName");
      const projPopup = await projPopupPromise;

      if (projPopup && projPopup !== reportPopup && projPopup !== mainPage) {
        await projPopup.waitForLoadState("domcontentloaded");
        const projectName = summary.project;

        if (projectName && projectName !== "공통업무") {
          console.log(`[WEEKLY-REPORT] Searching for project: "${projectName}"...`);
          const projLink = projPopup.locator(`text=${projectName}`).first();
          const projFound = await projLink.isVisible({ timeout: 5000 }).catch(() => false);
          if (projFound) {
            await projLink.click();
          } else {
            console.log(`[WEEKLY-REPORT] Project not found. Selecting "공통업무"...`);
            const commonLink = projPopup.locator("text=공통업무").first();
            await commonLink.click().catch(() => undefined);
          }
        } else {
          console.log(`[WEEKLY-REPORT] Selecting "공통업무"...`);
          const commonLink = projPopup.locator("text=공통업무").first();
          await commonLink.click().catch(() => undefined);
        }

        await Promise.race([
          projPopup.waitForEvent("close", { timeout: 5000 }).catch(() => undefined),
          reportPopup.waitForFunction(
            () => (document.getElementById("txt_SubCodeName") as HTMLInputElement)?.value?.trim().length > 0,
            { timeout: 5000 }
          ).catch(() => undefined),
        ]);
        if (!projPopup.isClosed()) {
          await projPopup.close().catch(() => undefined);
        }
      }
      await reportPopup.waitForTimeout(500);

      // 3. 진행업무 입력
      const progressText = summary.items.join("\n");
      console.log(`[WEEKLY-REPORT] Filling 진행업무 (${summary.items.length} items)`);
      await reportPopup.fill("#txt_progressWorkInsert_txt", progressText);

      // 4. 계획업무 입력
      await reportPopup.fill("#txt_scheduleWorkInsert_txt", "-");

      // 5. 등록 버튼 클릭
      console.log(`[WEEKLY-REPORT] Clicking 등록 button...`);
      await reportPopup.click("#btnl_businessAdd");
      await reportPopup.waitForLoadState("networkidle").catch(() => undefined);
      await reportPopup.waitForTimeout(1500);

      await reportPopup.screenshot({
        path: path.join(this.artifactsDir, `weekly-report-item-${i + 1}.png`),
        fullPage: true
      });
    }

    // ── 3) 최종 등록 확인 ──
    console.log(`[WEEKLY-REPORT] Clicking final 등록 (#btn_ok)...`);
    const closePromise = reportPopup.waitForEvent("close", { timeout: 15000 }).catch(() => undefined);
    await reportPopup.click("#btn_ok").catch(() => undefined);
    await closePromise;

    await mainPage.screenshot({
      path: path.join(this.artifactsDir, "weekly-report-complete.png"),
      fullPage: true
    });
    console.log(`[WEEKLY-REPORT] Weekly report registration complete. (Updated: ${updateItems.length}, New: ${newItems.length})`);
  }

  /**
   * 주간 업무보고 단독 실행 (로그인 → 주간보고 등록 → 브라우저 종료)
   */
  async registerWeeklyStandalone(summaries: WeeklyProjectSummary[], weekDate: Date, signal?: AbortSignal): Promise<void> {
    const channel = await detectBrowserChannel();
    console.log(`[BROWSER] Using ${channel}`);
    const browser = await chromium.launch({
      headless: !this.runOptions.headed,
      slowMo: this.runOptions.slowMoMs ?? 0,
      channel
    });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await this.login(page);
      checkSignal(signal);
      await this.registerWeeklyReport(context, page, summaries, weekDate, signal);
    } finally {
      await context.close();
      await browser.close();
    }
  }

  private async registerSprintBacklog(
    context: BrowserContext,
    mainPage: Page,
    items: OtherWorkDraft[]
  ): Promise<void> {
    const SPRINT_BACKLOG_URL = "http://erp.gcsc.co.kr/Agile/Agile/SprintBackLog.aspx";
    const COMPLETE_SPRINT_BASE = "http://erp.gcsc.co.kr/Agile/Agile/completeSprint.aspx";

    console.log("[SPRINT-BACKLOG] Navigating to SprintBackLog...");
    await mainPage.goto(SPRINT_BACKLOG_URL, { waitUntil: "domcontentloaded" });
    await mainPage.waitForLoadState("networkidle");

    // 1. 최신 스프린트 선택 (마지막 옵션)
    const sprintOptions = await mainPage.$$eval(
      "#ctl00_AgileContents_ddl_SprintCode option",
      opts => opts.map(o => ({ value: (o as HTMLOptionElement).value, text: o.textContent?.trim() ?? "" }))
        .filter(o => o.value)
    );
    if (sprintOptions.length === 0) {
      console.log("[SPRINT-BACKLOG] No sprint options found. Skipping.");
      return;
    }
    // finishDate 기준 주차 코드(26W15 등) 계산 후 매칭 스프린트 선택
    // 없으면 오늘 이전 스프린트 중 가장 최근 것 선택
    const today = new Date();
    const finishDate = items[0]?.finishDate
      ? new Date(`${items[0].finishDate}T00:00:00`)
      : today;
    const yy = String(finishDate.getFullYear()).slice(-2);
    const ww = String(getIsoWeekNumber(finishDate)).padStart(2, "0");
    const targetWeekPrefix = `${yy}W${ww}`;

    const realSprints = sprintOptions.filter(o => /^\d{2}W\d+/.test(o.value));
    // 1순위: finishDate 주차와 일치하는 스프린트
    const exactMatch = realSprints.find(o => o.value.startsWith(targetWeekPrefix));
    // 2순위: finishDate 이전의 스프린트 중 가장 최신
    const pastSprints = realSprints
      .filter(o => o.value <= targetWeekPrefix)
      .sort((a, b) => b.value.localeCompare(a.value));
    const latestSprint = exactMatch ?? (pastSprints[0] ?? realSprints[0] ?? sprintOptions[0]);
    console.log(`[SPRINT-BACKLOG] Latest sprint: "${latestSprint.text}" (${latestSprint.value})`);
    await mainPage.selectOption("#ctl00_AgileContents_ddl_SprintCode", { value: latestSprint.value });
    await mainPage.waitForLoadState("networkidle");
    await mainPage.waitForTimeout(2000);
    // 기타업무 테이블 로딩 대기
    await mainPage.waitForSelector("#ctl00_AgileContents_udp_otherwork", { timeout: 10000 }).catch(() => undefined);
    await mainPage.waitForTimeout(1000);

    // 2-a. 페이지네이션을 ALL로 변경하여 전체 항목 표시
    try {
      const pageOpts = await mainPage.$$eval(
        "#ctl00_AgileContents_pagingOtherWork_ddl_page option",
        (opts) => opts.map((o) => ({ value: (o as HTMLOptionElement).value, text: o.textContent?.trim() ?? "" }))
      );
      const allOpt = pageOpts.find(
        (o) => o.text.toUpperCase() === "ALL" || o.value.toUpperCase() === "ALL" || o.text === "전체"
      );
      if (allOpt) {
        console.log("[SPRINT-BACKLOG] Setting pagination to ALL...");
        await mainPage.selectOption("#ctl00_AgileContents_pagingOtherWork_ddl_page", { value: allOpt.value });
        await mainPage.waitForLoadState("networkidle");
        await mainPage.waitForTimeout(1500);
      } else if (pageOpts.length > 0) {
        // ALL 옵션이 없으면 마지막(가장 큰) 옵션 선택
        const lastOpt = pageOpts[pageOpts.length - 1];
        console.log(`[SPRINT-BACKLOG] No ALL option; selecting largest page size: "${lastOpt.text}"`);
        await mainPage.selectOption("#ctl00_AgileContents_pagingOtherWork_ddl_page", { value: lastOpt.value });
        await mainPage.waitForLoadState("networkidle");
        await mainPage.waitForTimeout(1500);
      }
    } catch {
      console.log("[SPRINT-BACKLOG] Could not change pagination (selector not found); proceeding as-is.");
    }

    // 2. 기타업무 테이블에서 WORK_CODE 추출 (제목 매칭)
    const { tableRows, tableSample } = await mainPage.evaluate(() => {
      const table = document.querySelector("#ctl00_AgileContents_udp_otherwork");
      if (!table) return { tableRows: [] as Array<{ code: string; subject: string }>, tableSample: "table not found" };
      const allRows = Array.from(table.querySelectorAll("tr")).map(tr =>
        Array.from(tr.querySelectorAll("td")).map(td => td.textContent?.trim() ?? "")
      ).filter(cols => cols.some(c => c));
      const rows = allRows
        .map(cols => ({ code: cols[1] ?? "", subject: cols[3] ?? "" }))
        .filter(r => r.code && r.subject);
      return { tableRows: rows, tableSample: "" };
    });
    console.log(`[SPRINT-BACKLOG] OtherWork table rows: ${tableRows.length}개`);

    // 3. 등록된 항목별로 completeSprint 팝업 열기
    for (const item of items) {
      const erpTitle = this.formatErpTitle(item.title, item.finishDate);
      const matched = tableRows.find(r =>
        this.normalizeText(r.subject).includes(this.normalizeText(erpTitle)) ||
        this.normalizeText(r.subject).includes(this.normalizeText(item.title))
      );
      if (!matched) {
        console.log(`[SPRINT-BACKLOG] SKIP: "${erpTitle}" not found in sprint backlog table.`);
        continue;
      }
      console.log(`[SPRINT-BACKLOG] Found: CODE=${matched.code}, subject="${matched.subject}"`);

      const completeUrl = `${COMPLETE_SPRINT_BASE}?mode=&WORK_CODE=${encodeURIComponent(matched.code)}&WORK_TYPE=4&SPRINT_CODE=${encodeURIComponent(latestSprint.value)}&postControlId=ctl00_AgileContents_btnl_dopostbackEvent&otherfinishdate=${encodeURIComponent(item.finishDate)}`;
      console.log(`[SPRINT-BACKLOG] Opening completeSprint: ${completeUrl}`);

      const sprintPage = await context.newPage();
      try {
        await sprintPage.goto(completeUrl, { waitUntil: "domcontentloaded" });
        await sprintPage.waitForLoadState("networkidle").catch(() => undefined);

        // 업무 내용 입력
        const workComment = this.truncateComment(item.workComment, item.title);
        await sprintPage.fill("#txt_developer", workComment);

        // 검토 등급 선택 (상/중/하) — 단순 드롭다운이므로 직접 선택
        if (item.priority?.trim()) {
          await sprintPage.evaluate((priority) => {
            const sel = document.getElementById("ddl_workReview") as HTMLSelectElement | null;
            if (!sel) return;
            for (const opt of Array.from(sel.options)) {
              if (opt.text.trim() === priority || opt.value.trim() === priority) {
                sel.value = opt.value;
                return;
              }
            }
          }, item.priority.trim());
        }

        // 등록 버튼 클릭
        await sprintPage.click("#btnl_addIssueConfirm");
        await sprintPage.waitForLoadState("networkidle").catch(() => undefined);
        console.log(`[SPRINT-BACKLOG] Completed sprint backlog for "${matched.code}"`);
      } catch (err) {
        console.log(`[SPRINT-BACKLOG] ERROR on "${matched.code}": ${err instanceof Error ? err.message : err}`);
      } finally {
        await sprintPage.close().catch(() => undefined);
      }
    }
  }

  async register(items: OtherWorkDraft[], options?: { keepOpen?: boolean; dateYmd?: string; yesterdayItems?: OtherWorkDraft[]; leaveRequest?: boolean; signal?: AbortSignal }): Promise<RegisterSummary> {
    const channel = await detectBrowserChannel();
    console.log(`[BROWSER] Using ${channel}`);
    const browser = await chromium.launch({
      headless: !this.runOptions.headed,
      slowMo: this.runOptions.slowMoMs ?? 0,
      channel
    });
    const context = await browser.newContext();
    const page = await context.newPage();

    let success = 0;
    const failures: RegisterSummary["failures"] = [];
    let skipped = 0;
    const skippedItems: Array<{ title: string; reason: string }> = [];

    try {
      await this.login(page);
      checkSignal(options?.signal);

      // 0단계: 휴가계 작성 (연차/반차 해당 시 — 체크박스 활성화 시에만 실행)
      if (options?.leaveRequest) {
        for (const item of items) {
          checkSignal(options?.signal);
          const leaveType = detectLeaveType(item.sdmsCategoryRef);
          if (leaveType) {
            console.log(`[LEAVE] "${item.title}" → ${leaveType} 휴가계 작성 시작`);
            await registerLeaveRequest(page, leaveType, item.finishDate);
          }
        }
      }
      checkSignal(options?.signal);

      // 1단계: 업무일지 등록 (business.aspx)
      if (options?.dateYmd) {
        await this.registerBusinessLog(context, page, items, options.dateYmd);
      }
      checkSignal(options?.signal);

      // 2단계: 기타업무 등록 (OtherWork page)
      console.log(`[NAV] Navigating directly to OtherWork page...`);
      await page.goto(OTHER_WORK_URL, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle");
      const mainPage = page;

      // Search by employee name once to filter the list
      const employeeName = this.env.EMPLOYEE_NAME;
      console.log(`[OTHER-WORK] Searching list by name: "${employeeName}"...`);
      await mainPage.fill("#ctl00_AgileContents_txt_find", employeeName);
      await mainPage.click("#ctl00_AgileContents_btn_find");
      await mainPage.waitForLoadState("networkidle");
      await mainPage.waitForTimeout(500);

      // Read the filtered list body text once for duplicate checking
      const filteredBodyText = this.normalizeText(
        await mainPage.locator("body").innerText().catch(() => "")
      );
      console.log(`[OTHER-WORK] List filtered. Checking duplicates...`);

      // Separate items: "요구사항" skips OtherWork registration, only goes to Daily Scrum
      const SCRUM_ONLY_CATEGORIES = ["요구사항"];

      for (const item of items) {
        checkSignal(options?.signal);
        const erpTitle = this.formatErpTitle(item.title, item.finishDate);

        // "요구사항" 카테고리: 기타업무 등록 생략 → Daily Scrum만 등록
        if (SCRUM_ONLY_CATEGORIES.includes(item.category)) {
          console.log(`[OTHER-WORK] SKIP (category="${item.category}"): "${erpTitle}" → Daily Scrum only`);
          continue;
        }

        try {
          // Check duplicate against the filtered (searched) list
          const exists = filteredBodyText.includes(this.normalizeText(erpTitle));
          if (exists) {
            skipped += 1;
            skippedItems.push({
              title: erpTitle,
              reason: `이미 등록된 항목으로 판단되어 건너뜀 (title=${erpTitle})`
            });
            console.log(`[OTHER-WORK] SKIP (duplicate): "${erpTitle}"`);
            continue;
          }

          await this.openOtherWorkPage(mainPage);
          await this.submitOne(context, mainPage, item);
          success += 1;
          await mainPage.waitForTimeout(INTER_ITEM_DELAY_MS);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          failures.push({ title: erpTitle, reason });
          await mainPage.screenshot({
            path: path.join(this.artifactsDir, `${this.fileSafe(erpTitle)}-error.png`),
            fullPage: true
          });
          for (const p of context.pages()) {
            if (p !== mainPage && !p.isClosed()) {
              await p.close().catch(() => undefined);
            }
          }
          await this.openOtherWorkPage(mainPage).catch(() => undefined);
          await mainPage.waitForTimeout(INTER_ITEM_DELAY_MS);
        }
      }

      checkSignal(options?.signal);
      // 3단계: 일일 스크럼 등록
      if (options?.dateYmd) {
        await this.registerDailyScrum(context, mainPage, items, options.dateYmd, options.yesterdayItems ?? []);
      }
      checkSignal(options?.signal);

      // 4단계: 스프린트 백로그 완료 처리
      if (options?.dateYmd) {
        const otherWorkOnly = items.filter(x => x.category === "기타업무");
        if (otherWorkOnly.length > 0) {
          await this.registerSprintBacklog(context, mainPage, otherWorkOnly);
        }
      }
    } finally {
      await context.close();
      await browser.close();
    }

    return {
      total: items.length,
      success,
      failed: failures.length,
      failures,
      skipped,
      skippedItems
    };
  }
}
