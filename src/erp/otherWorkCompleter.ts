import { chromium } from "playwright";
import { checkSignal } from "../lib/cancellation.js";

interface BulkCompleteEnv {
  COMPANY_ID: string;
  COMPANY_PASSWORD: string;
  COMPANY_LOGIN_URL: string;
  EMPLOYEE_NAME: string;
}

const OTHER_WORK_URL = "http://erp.gcsc.co.kr/Agile/IssuePims/OtherWork.aspx";
const BASE_EDIT_URL = "http://erp.gcsc.co.kr/Agile/IssuePims/AddOtherWork.aspx";

async function detectBrowserChannel(): Promise<"chrome" | "msedge"> {
  for (const channel of ["chrome", "msedge"] as const) {
    try {
      const browser = await chromium.launch({ headless: true, channel });
      await browser.close();
      return channel;
    } catch { /* skip */ }
  }
  throw new Error("Chrome 또는 Edge가 설치되어 있지 않습니다.");
}

/**
 * 기타업무 리스트에서 완료되지 않은 항목을 모두 "완료" 처리한다.
 */
export async function bulkCompleteOtherWork(
  env: BulkCompleteEnv,
  options?: { headed?: boolean; signal?: AbortSignal; slowMoMs?: number }
): Promise<{ total: number; completed: number; alreadyDone: number }> {
  const channel = await detectBrowserChannel();
  console.log(`[BULK-COMPLETE] Using ${channel}`);

  const browser = await chromium.launch({
    headless: !options?.headed,
    channel,
    slowMo: options?.slowMoMs ?? 0,
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // 1. 로그인
    await page.goto(env.COMPANY_LOGIN_URL, { waitUntil: "domcontentloaded" });
    await page.fill("#inputId", env.COMPANY_ID);
    await page.fill("#inputScr", env.COMPANY_PASSWORD);
    await page.click("#logbtnImg");
    await page.waitForLoadState("networkidle");

    // 공지 팝업 닫기
    try {
      const noticeBtn = page.locator("#ctl00_main_pop_error_btn_Confirm");
      if (await noticeBtn.isVisible({ timeout: 3000 })) {
        await page.evaluate(() => {
          const btn = document.getElementById("ctl00_main_pop_error_btn_Confirm");
          if (btn) (btn as HTMLElement).click();
        });
        await page.waitForTimeout(500);
      }
    } catch { /* no popup */ }

    // 2. 기타업무 페이지 이동
    await page.goto(OTHER_WORK_URL, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");

    // 3. 담당자 이름으로 검색
    const employeeName = env.EMPLOYEE_NAME;
    console.log(`[BULK-COMPLETE] Searching by name: "${employeeName}"...`);
    await page.fill("#ctl00_AgileContents_txt_find", employeeName);
    await page.click("#ctl00_AgileContents_btn_find");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);

    // 4. ALL 페이지 선택
    const pageOptions = await page.$$eval("#ctl00_AgileContents_pagingOtherWork_ddl_page option", (opts) =>
      opts.map((o) => ({ value: (o as HTMLOptionElement).value, text: o.textContent?.trim() ?? "" }))
    );
    const allOpt = pageOptions.find((o) => o.text.toUpperCase() === "ALL" || o.value.toUpperCase() === "ALL" || o.text === "전체");
    if (allOpt) {
      await page.selectOption("#ctl00_AgileContents_pagingOtherWork_ddl_page", { value: allOpt.value });
    } else if (pageOptions.length > 0) {
      const lastOpt = pageOptions[pageOptions.length - 1];
      await page.selectOption("#ctl00_AgileContents_pagingOtherWork_ddl_page", { value: lastOpt.value });
    }
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);

    // 5. 미완료 행 탐색
    const rows = await page.evaluate(() => {
      const result: Array<{ code: string; status: string }> = [];
      const codeLinks = document.querySelectorAll("a[id*='btnl_code']");
      for (const link of codeLinks) {
        const code = link.textContent?.trim() ?? "";
        const tr = link.closest("tr");
        if (!tr) continue;

        let status = "";
        for (const td of tr.querySelectorAll("td")) {
          const text = td.textContent?.trim() ?? "";
          if (text === "완료" || text === "진행" || text === "대기" || text === "중지") {
            status = text;
            break;
          }
        }
        result.push({ code, status });
      }
      return result;
    });

    console.log(`[BULK-COMPLETE] Found ${rows.length} rows total.`);

    const incompleteRows = rows.filter((r) => r.status !== "완료");
    const alreadyDone = rows.length - incompleteRows.length;
    console.log(`[BULK-COMPLETE] 미완료: ${incompleteRows.length}개, 이미 완료: ${alreadyDone}개`);

    if (incompleteRows.length === 0) {
      console.log("[BULK-COMPLETE] All items already completed. Nothing to do.");
      return { total: rows.length, completed: 0, alreadyDone };
    }

    // 6. 미완료 항목을 직접 URL로 접근해 완료 처리
    let completedCount = 0;
    for (let idx = 0; idx < incompleteRows.length; idx++) {
      checkSignal(options?.signal);
      const row = incompleteRows[idx];
      console.log(`[BULK-COMPLETE] (${idx + 1}/${incompleteRows.length}) "${row.code}" (${row.status} → 완료)`);

      const editUrl = `${BASE_EDIT_URL}?mode=update&CODE=${encodeURIComponent(row.code)}&search=${encodeURIComponent(employeeName)}&ddl=0`;
      const editPage = await context.newPage();

      try {
        await editPage.goto(editUrl, { waitUntil: "domcontentloaded" });
        await editPage.waitForLoadState("networkidle").catch(() => undefined);

        await editPage.selectOption("#ddl_status", { label: "완료" });
        await editPage.waitForTimeout(300);
        await editPage.click("#btnl_addReleaseConfirm");
        await editPage.waitForLoadState("networkidle").catch(() => undefined);

        completedCount++;
        console.log(`[BULK-COMPLETE] Completed: "${row.code}"`);
      } catch (err) {
        console.log(`[BULK-COMPLETE] ERROR on "${row.code}": ${err instanceof Error ? err.message : err}`);
      } finally {
        await editPage.close().catch(() => undefined);
      }

      await page.waitForTimeout(300);
    }

    console.log(`[BULK-COMPLETE] Done. ${completedCount} item(s) completed.`);
    return { total: rows.length, completed: completedCount, alreadyDone };
  } finally {
    await context.close();
    await browser.close();
  }
}
