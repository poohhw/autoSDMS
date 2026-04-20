import type { Page } from "playwright";

const EA_WRITE_URL = "http://erp.gcsc.co.kr/ea/ea.aspx?state=charge&subMenuCss=tcell_write";

type LeaveType = "연차" | "반차";

const LEAVE_TITLES: Record<LeaveType, string> = {
  "연차": "개인 사유로 인한 연차 사용을 상신합니다.",
  "반차": "개인 사유로 인한 반차 사용을 상신합니다.",
};

/**
 * sdmsCategoryRef 값에서 휴가 유형을 판별한다.
 * "연차" 또는 "반차" 문자열이 포함되어 있으면 해당 타입 반환, 없으면 null.
 */
export function detectLeaveType(sdmsCategoryRef?: string): LeaveType | null {
  if (!sdmsCategoryRef) return null;
  if (sdmsCategoryRef.includes("반차")) return "반차";
  if (sdmsCategoryRef.includes("연차")) return "연차";
  return null;
}

const EA_STAND_URL = "http://erp.gcsc.co.kr/ea/ea.aspx?state=stand&postback=true";

/**
 * 기안함에서 동일한 휴가계가 이미 등록되어 있는지 확인한다.
 * 기안일(dateYmd)과 제목이 일치하는 항목이 있으면 true 반환.
 */
async function isLeaveAlreadySubmitted(
  page: Page,
  leaveType: LeaveType,
  dateYmd: string
): Promise<boolean> {
  const title = LEAVE_TITLES[leaveType];

  console.log(`[LEAVE] 기안함에서 중복 확인 중...`);
  await page.goto(EA_STAND_URL, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1000);

  // 기안함 리스트에서 기안일 + 제목 매칭
  const found = await page.evaluate(({ searchTitle, searchDate }) => {
    const rows = document.querySelectorAll("table tr");
    for (const row of rows) {
      const text = row.textContent || "";
      // 기안일(yyyy-MM-dd 또는 yyyy.MM.dd 등)과 제목이 모두 포함되어 있는지 확인
      const dateNorm = searchDate.replace(/-/g, "");
      const textNorm = text.replace(/[-./]/g, "");
      if (textNorm.includes(dateNorm) && text.includes(searchTitle)) {
        return true;
      }
    }
    return false;
  }, { searchTitle: title, searchDate: dateYmd });

  if (found) {
    console.log(`[LEAVE] SKIP (duplicate): "${title}" (${dateYmd}) 이미 기안함에 존재합니다.`);
  }
  return found;
}

/**
 * ERP 휴가계 작성 페이지에서 휴가를 등록한다.
 * 1) 기안함에서 중복 확인
 * 2) 전자결재 작성 페이지 → 근태 → 휴가원 선택 → 확인
 * 3) 휴가원 작성 폼에서 제목/종류/날짜/사유 입력 → 확인 → 상신
 */
export async function registerLeaveRequest(
  page: Page,
  leaveType: LeaveType,
  dateYmd: string
): Promise<void> {
  const title = LEAVE_TITLES[leaveType];

  // ── Step 0: 기안함에서 중복 확인 ──
  const alreadyExists = await isLeaveAlreadySubmitted(page, leaveType, dateYmd);
  if (alreadyExists) return;

  // ── Step 1: 전자결재 작성 페이지 이동 ──
  console.log(`[LEAVE] Navigating to 전자결재 작성 page...`);
  await page.goto(EA_WRITE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1000);

  // 분류: "근태" 선택
  console.log(`[LEAVE] 분류: 근태 선택`);
  await page.selectOption("#ctl00_ctl00_EA_ddl_sort", { label: "근태" });
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(1000);

  // 세부: "휴가원" 선택
  console.log(`[LEAVE] 세부: 휴가원 선택`);
  await page.selectOption("#ctl00_ctl00_EA_ddl_details", { label: "휴가원" });
  await page.waitForTimeout(500);

  // 확인 버튼 클릭 → 휴가원 작성 폼으로 이동
  console.log(`[LEAVE] 확인 버튼 클릭 → 휴가원 작성 폼 이동`);
  await page.click("#ctl00_ctl00_EA_btn_ok");
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(2000);
  console.log(`[LEAVE] 휴가원 폼 URL: ${page.url()}`);

  // ── Step 2: 휴가원 작성 폼 입력 ──

  // 1. 제목 입력
  console.log(`[LEAVE] 제목: "${title}"`);
  await page.fill("#ctl00_ctl00_EA_EAContents_txt_subject_txt", title);

  // 2. 시작날짜 (달력 클릭 — 휴가 종류 선택 전에, PostBack으로 리셋되지 않도록)
  console.log(`[LEAVE] 시작날짜: ${dateYmd}`);
  await setDateField(page, "ctl00_ctl00_EA_EAContents_txt_startDate_txt_date", dateYmd);
  await dismissErrorModal(page);

  // 3. 끝날짜
  console.log(`[LEAVE] 끝날짜: ${dateYmd}`);
  await setDateField(page, "ctl00_ctl00_EA_EAContents_txt_endDate_txt_date", dateYmd);
  await dismissErrorModal(page);

  // 4. 휴가 종류 선택 (PostBack 발생할 수 있으므로 날짜 입력 후 실행)
  console.log(`[LEAVE] 휴가 종류: ${leaveType}`);
  await page.selectOption("#ctl00_ctl00_EA_EAContents_ddl_restSort", { label: leaveType });
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(1000);

  // 5. 사유 입력
  console.log(`[LEAVE] 사유 입력`);
  await page.fill("#ctl00_ctl00_EA_EAContents_txt_reason_txt", title);

  // 모달 오버레이가 있으면 닫기 (ERP 오류/경고 팝업)
  await dismissErrorModal(page);

  // 6. 확인(기안완료) 버튼 클릭
  console.log(`[LEAVE] 기안완료 버튼 클릭...`);
  await page.click("#ctl00_ctl00_EA_EAContents_btn_ok", { force: true });
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(2000);

  // 모달이 다시 나오면 닫기
  await dismissErrorModal(page);

  // 7. 상신 버튼 클릭
  const gianBtn = page.locator("#ctl00_ctl00_EA_EAContents_btn_gianok");
  if (await gianBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    console.log(`[LEAVE] 상신 버튼 클릭...`);
    await gianBtn.click({ force: true });
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.waitForTimeout(1500);
  }

  console.log(`[LEAVE] 휴가계 등록 완료. (${leaveType}, ${dateYmd})`);
}

/** ERP 모달 오버레이(오류/경고 팝업) 감지 및 닫기 */
async function dismissErrorModal(page: Page): Promise<void> {
  const modalBg = page.locator("[id*='pop_error_mpe_error_backgroundElement']");
  if (await modalBg.isVisible({ timeout: 1000 }).catch(() => false)) {
    // 모달 팝업 내용 확인
    const msg = await page.locator("[id*='pop_error']").innerText({ timeout: 2000 }).catch(() => "");
    console.log(`[LEAVE] 모달 팝업 감지: ${msg.substring(0, 100)}`);

    // 확인 버튼 클릭으로 닫기
    const confirmBtn = page.locator("[id*='pop_error'] a, [id*='pop_error'] input[type='button'], [id*='pop_error'] button").first();
    if (await confirmBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await confirmBtn.click({ force: true });
      await page.waitForTimeout(1000);
      console.log(`[LEAVE] 모달 팝업 닫기 완료`);
    } else {
      // JS로 강제 숨기기
      await page.evaluate(() => {
        const bg = document.querySelector("[id*='pop_error_mpe_error_backgroundElement']") as HTMLElement;
        if (bg) bg.style.display = "none";
        const popup = document.querySelector("[id*='pop_error_Panel']") as HTMLElement;
        if (popup) popup.style.display = "none";
      });
      console.log(`[LEAVE] 모달 팝업 JS로 강제 닫기`);
    }
  }
}

/**
 * ASP.NET 날짜 필드에 JS로 값을 설정하고 change 이벤트 + __doPostBack을 호출한다.
 */
async function setDateField(page: Page, fieldId: string, dateYmd: string): Promise<void> {
  const postbackName = fieldId.replace(/_/g, "$");

  await page.evaluate(({ id, val, pbName }) => {
    const el = document.getElementById(id) as HTMLInputElement;
    if (!el) return;

    // readonly 임시 해제
    el.removeAttribute("readonly");
    el.removeAttribute("disabled");

    // onkeydown="return false;" 제거
    el.onkeydown = null;
    el.removeAttribute("onkeydown");

    // 값 설정
    el.value = val;

    // change 이벤트 발생
    el.dispatchEvent(new Event("change", { bubbles: true }));

    // __doPostBack 호출 (ASP.NET 서버에 값 전달)
    if (typeof (window as any).__doPostBack === "function") {
      (window as any).__doPostBack(pbName, "");
    }
  }, { id: fieldId, val: dateYmd, pbName: postbackName });

  // PostBack 완료 대기
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(200);

  // 값이 정상 설정되었는지 확인
  const actualValue = await page.evaluate((id) => {
    const el = document.getElementById(id) as HTMLInputElement;
    return el?.value ?? "";
  }, fieldId);
  console.log(`[LEAVE] 날짜 필드 ${fieldId.includes("start") ? "시작" : "종료"}: 설정값=${dateYmd}, 실제값=${actualValue}`);
}
