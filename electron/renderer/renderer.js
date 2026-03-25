// @ts-check
/// <reference path="./renderer.d.ts" />

const DAY_NAMES = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];

const ENV_LABELS = {
  NOTION_ID: "Notion ID (이메일)",
  NOTION_PASSWORD: "Notion Password",
  NOTION_TOKEN: "Notion Integration Token",
  NOTION_DATABASE_ID: "Notion Database ID",
  COMPANY_ID: "ERP ID (사번)",
  COMPANY_PASSWORD: "ERP Password",
  EMPLOYEE_NAME: "직원 이름"
};

// --- Elements ---
const datePicker = /** @type {HTMLInputElement} */ (document.getElementById("datePicker"));
const dayBadge = document.getElementById("dayBadge");
const btnDaily = document.getElementById("btnDaily");
const btnWeekly = document.getElementById("btnWeekly");
const logPanel = document.getElementById("logPanel");
const statusText = document.getElementById("statusText");
const btnClearLog = document.getElementById("btnClearLog");
const btnOpenLogs = document.getElementById("btnOpenLogs");
const btnOpenArtifacts = document.getElementById("btnOpenArtifacts");
const btnSettings = document.getElementById("btnSettings");
const envWarning = document.getElementById("envWarning");
const envWarningText = document.getElementById("envWarningText");
const btnEnvSetup = document.getElementById("btnEnvSetup");
const settingsModal = document.getElementById("settingsModal");
const btnModalCancel = document.getElementById("btnModalCancel");
const btnModalSave = document.getElementById("btnModalSave");

// Env field mapping
const ENV_FIELDS = {
  NOTION_ID: "envNotionId",
  NOTION_PASSWORD: "envNotionPw",
  NOTION_TOKEN: "envNotionToken",
  NOTION_DATABASE_ID: "envNotionDbId",
  COMPANY_ID: "envCompanyId",
  COMPANY_PASSWORD: "envCompanyPw",
  EMPLOYEE_NAME: "envEmployeeName"
};

let isRunning = false;
let envValid = false;

// --- Custom Dialog ---
const dialogOverlay = document.getElementById("dialogOverlay");
const dialogIcon = document.getElementById("dialogIcon");
const dialogTitle = document.getElementById("dialogTitle");
const dialogMessage = document.getElementById("dialogMessage");
const dialogActions = document.getElementById("dialogActions");

const DIALOG_ICONS = {
  info: "ℹ️",
  success: "✅",
  warning: "⚠️",
  error: "❌",
  confirm: "❓"
};

/**
 * 커스텀 alert 다이얼로그
 * @param {string} message
 * @param {{ title?: string, type?: string }} [opts]
 * @returns {Promise<void>}
 */
function showAlert(message, opts = {}) {
  const type = opts.type || "info";
  const title = opts.title || (type === "error" ? "오류" : type === "warning" ? "알림" : type === "success" ? "완료" : "안내");
  return new Promise((resolve) => {
    dialogIcon.textContent = DIALOG_ICONS[type] || DIALOG_ICONS.info;
    dialogIcon.className = `dialog-icon ${type}`;
    dialogTitle.textContent = title;
    dialogMessage.textContent = message;
    dialogActions.innerHTML = "";

    const okBtn = document.createElement("button");
    okBtn.className = "dialog-btn primary";
    okBtn.textContent = "확인";
    okBtn.addEventListener("click", () => {
      dialogOverlay.classList.remove("active");
      resolve();
    });
    dialogActions.appendChild(okBtn);
    dialogOverlay.classList.add("active");
    okBtn.focus();
  });
}

/**
 * 커스텀 confirm 다이얼로그
 * @param {string} message
 * @param {{ title?: string, type?: string, yesText?: string, noText?: string }} [opts]
 * @returns {Promise<boolean>}
 */
function showConfirm(message, opts = {}) {
  const type = opts.type || "confirm";
  const title = opts.title || "확인";
  return new Promise((resolve) => {
    dialogIcon.textContent = DIALOG_ICONS[type] || DIALOG_ICONS.confirm;
    dialogIcon.className = `dialog-icon ${type}`;
    dialogTitle.textContent = title;
    dialogMessage.textContent = message;
    dialogActions.innerHTML = "";

    const noBtn = document.createElement("button");
    noBtn.className = "dialog-btn secondary";
    noBtn.textContent = opts.noText || "아니오";
    noBtn.addEventListener("click", () => {
      dialogOverlay.classList.remove("active");
      resolve(false);
    });

    const yesBtn = document.createElement("button");
    yesBtn.className = "dialog-btn success";
    yesBtn.textContent = opts.yesText || "예";
    yesBtn.addEventListener("click", () => {
      dialogOverlay.classList.remove("active");
      resolve(true);
    });

    dialogActions.appendChild(noBtn);
    dialogActions.appendChild(yesBtn);
    dialogOverlay.classList.add("active");
    yesBtn.focus();
  });
}

// --- Init ---
function initDate() {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  datePicker.value = `${yyyy}-${mm}-${dd}`;
  updateDayBadge();
}

function updateDayBadge() {
  const d = new Date(datePicker.value + "T00:00:00");
  if (isNaN(d.getTime())) {
    dayBadge.textContent = "";
    dayBadge.className = "day-badge";
    return;
  }
  const dayName = DAY_NAMES[d.getDay()];
  dayBadge.textContent = dayName;
  dayBadge.className = d.getDay() === 5 ? "day-badge friday" : "day-badge";
}

datePicker.addEventListener("change", updateDayBadge);

/** 환경변수 미설정 시 등록 버튼 비활성화 */
function updateButtonStates() {
  if (!envValid) {
    btnDaily.disabled = true;
    btnWeekly.disabled = true;
  } else if (!isRunning) {
    btnDaily.disabled = false;
    btnWeekly.disabled = false;
  }
}

// --- Logging ---
function appendLog(level, message) {
  const line = document.createElement("div");
  line.className = `log-line ${level}`;
  const time = new Date().toLocaleTimeString("ko-KR", { hour12: false });
  line.textContent = `[${time}] ${message}`;
  logPanel.appendChild(line);
  logPanel.scrollTop = logPanel.scrollHeight;
}

window.autosdms.onLog((entry) => {
  appendLog(entry.level, entry.message);
});

btnClearLog.addEventListener("click", () => {
  logPanel.innerHTML = "";
});

// --- Task Execution ---
function setRunning(running, buttonEl) {
  isRunning = running;
  btnDaily.disabled = running;
  btnWeekly.disabled = running;
  if (running) {
    buttonEl.classList.add("loading");
    statusText.textContent = "실행 중...";
    statusText.className = "status-text running";
  } else {
    btnDaily.classList.remove("loading");
    btnWeekly.classList.remove("loading");
    updateButtonStates();
  }
}

function getHeaded() {
  const radio = /** @type {HTMLInputElement} */ (
    document.querySelector('input[name="browserMode"]:checked')
  );
  return radio?.value === "headed";
}

// Daily
btnDaily.addEventListener("click", async () => {
  if (isRunning || !envValid) return;
  const dateYmd = datePicker.value;
  if (!dateYmd) {
    await showAlert("날짜를 선택하세요.", { type: "warning", title: "날짜 미선택" });
    return;
  }

  setRunning(true, btnDaily);
  appendLog("info", `=== 일일업무등록 시작 (${dateYmd}) ===`);

  try {
    const result = await window.autosdms.runDaily(dateYmd, getHeaded());

    if (result && result.success) {
      appendLog("result", "=== 일일업무등록 완료 ===");
      statusText.textContent = "일일등록 완료";
      statusText.className = "status-text success";

      // Friday check
      const d = new Date(dateYmd + "T00:00:00");
      if (d.getDay() === 5) {
        const yes = await showConfirm("금요일입니다.\n주간 업무일지도 함께 등록할까요?", {
          title: "주간 업무보고",
          type: "confirm",
          yesText: "등록하기",
          noText: "건너뛰기"
        });
        if (yes) {
          setRunning(true, btnWeekly);
          appendLog("info", `=== 주간 업무등록 연속 실행 (${dateYmd}) ===`);
          const weekResult = await window.autosdms.runWeekly(dateYmd, getHeaded());
          if (weekResult && weekResult.success) {
            appendLog("result", "=== 주간 업무등록 완료 ===");
            statusText.textContent = "일일 + 주간 등록 완료";
            statusText.className = "status-text success";
          } else {
            appendLog("error", `주간 등록 실패: ${weekResult?.error || "알 수 없는 오류"}`);
            statusText.textContent = "주간 등록 실패";
            statusText.className = "status-text error";
          }
        }
      }
    } else {
      appendLog("error", `일일등록 실패: ${result?.error || "알 수 없는 오류"}`);
      statusText.textContent = "등록 실패";
      statusText.className = "status-text error";
    }
  } catch (err) {
    appendLog("error", `오류: ${err}`);
    statusText.textContent = "오류 발생";
    statusText.className = "status-text error";
  } finally {
    setRunning(false, btnDaily);
  }
});

// Weekly
btnWeekly.addEventListener("click", async () => {
  if (isRunning || !envValid) return;
  const dateYmd = datePicker.value;
  if (!dateYmd) {
    await showAlert("날짜를 선택하세요.", { type: "warning", title: "날짜 미선택" });
    return;
  }

  setRunning(true, btnWeekly);
  appendLog("info", `=== 주간 업무등록 시작 (${dateYmd}) ===`);

  try {
    const result = await window.autosdms.runWeekly(dateYmd, getHeaded());
    if (result && result.success) {
      appendLog("result", "=== 주간 업무등록 완료 ===");
      statusText.textContent = "주간 등록 완료";
      statusText.className = "status-text success";
    } else {
      appendLog("error", `주간 등록 실패: ${result?.error || "알 수 없는 오류"}`);
      statusText.textContent = "등록 실패";
      statusText.className = "status-text error";
    }
  } catch (err) {
    appendLog("error", `오류: ${err}`);
    statusText.textContent = "오류 발생";
    statusText.className = "status-text error";
  } finally {
    setRunning(false, btnWeekly);
  }
});

// --- Folders ---
btnOpenLogs.addEventListener("click", () => {
  window.autosdms.openFolder("logs");
});

btnOpenArtifacts.addEventListener("click", () => {
  window.autosdms.openFolder("artifacts");
});

// --- Settings Modal ---
let isFirstSetup = false; // 최초 설정 모드 여부

async function showSettings(firstSetup) {
  isFirstSetup = !!firstSetup;

  // 최초 설정이면 취소 버튼 숨기기
  btnModalCancel.style.display = isFirstSetup ? "none" : "";

  // 기존 환경변수 값 로드
  try {
    const values = await window.autosdms.getEnvValues();
    for (const [envKey, elemId] of Object.entries(ENV_FIELDS)) {
      const input = /** @type {HTMLInputElement} */ (document.getElementById(elemId));
      if (input) {
        input.value = values[envKey] || "";
        input.classList.remove("missing");
      }
    }
  } catch {
    // 로드 실패해도 빈 폼 표시
  }
  settingsModal.classList.add("active");
}

function hideSettings() {
  if (isFirstSetup) return; // 최초 설정은 취소 불가
  settingsModal.classList.remove("active");
}

btnSettings.addEventListener("click", () => showSettings(false));
btnEnvSetup.addEventListener("click", () => showSettings(false));
btnModalCancel.addEventListener("click", hideSettings);

// 모달 바깥 클릭으로 닫기 (최초 설정이 아닌 경우만)
settingsModal.addEventListener("click", (e) => {
  if (e.target === settingsModal && !isFirstSetup) {
    hideSettings();
  }
});

btnModalSave.addEventListener("click", async () => {
  // 빈 값 검증
  const emptyFields = [];
  const values = {};
  for (const [envKey, elemId] of Object.entries(ENV_FIELDS)) {
    const input = /** @type {HTMLInputElement} */ (document.getElementById(elemId));
    const val = input.value.trim();
    if (!val) {
      emptyFields.push(envKey);
      input.classList.add("missing");
    } else {
      input.classList.remove("missing");
      values[envKey] = val;
    }
  }

  if (emptyFields.length > 0) {
    const labels = emptyFields.map((k) => ENV_LABELS[k] || k).join("\n  - ");
    await showAlert(`다음 항목을 입력해주세요:\n${labels}`, { type: "warning", title: "입력 필요" });
    // 첫 번째 빈 필드에 포커스
    const firstEmpty = document.getElementById(ENV_FIELDS[emptyFields[0]]);
    if (firstEmpty) firstEmpty.focus();
    return;
  }

  await window.autosdms.saveEnv(values);
  isFirstSetup = false;
  settingsModal.classList.remove("active");
  appendLog("info", "환경변수가 저장되었습니다.");
  await checkEnv();
});

// --- Env Check ---
async function checkEnv() {
  try {
    const status = await window.autosdms.getEnvStatus();
    envValid = status.valid;

    if (!status.valid) {
      envWarning.classList.add("active");
      const missingLabels = status.missing.map((k) => ENV_LABELS[k] || k);
      envWarningText.textContent = `환경변수 미설정: ${missingLabels.join(", ")}`;
      btnDaily.disabled = true;
      btnWeekly.disabled = true;
      statusText.textContent = "환경변수 설정 필요";
      statusText.className = "status-text error";
    } else {
      envWarning.classList.remove("active");
      if (!isRunning) {
        btnDaily.disabled = false;
        btnWeekly.disabled = false;
        statusText.textContent = "대기 중";
        statusText.className = "status-text";
      }
    }
  } catch {
    // ignore
  }
}

// --- Connection Test ---
const btnTestNotion = document.getElementById("btnTestNotion");
const btnTestNotionIcon = document.getElementById("btnTestNotionIcon");
const btnTestNotionStatus = document.getElementById("btnTestNotionStatus");
const btnTestNotionSpinner = document.getElementById("btnTestNotionSpinner");

const btnTestErp = document.getElementById("btnTestErp");
const btnTestErpIcon = document.getElementById("btnTestErpIcon");
const btnTestErpStatus = document.getElementById("btnTestErpStatus");
const btnTestErpSpinner = document.getElementById("btnTestErpSpinner");

function setTestState(iconEl, statusEl, spinnerEl, btnEl, state, message) {
  if (state === "testing") {
    spinnerEl.classList.add("active");
    iconEl.textContent = "🔗";
    statusEl.textContent = "테스트 중...";
    statusEl.className = "btn-test-status testing";
    btnEl.disabled = true;
  } else if (state === "success") {
    spinnerEl.classList.remove("active");
    iconEl.textContent = "✅";
    statusEl.textContent = message || "연결 성공";
    statusEl.className = "btn-test-status success";
    btnEl.disabled = false;
  } else if (state === "error") {
    spinnerEl.classList.remove("active");
    iconEl.textContent = "❌";
    statusEl.textContent = message || "연결 실패";
    statusEl.className = "btn-test-status error";
    btnEl.disabled = false;
  } else {
    spinnerEl.classList.remove("active");
    iconEl.textContent = "🔗";
    statusEl.textContent = "";
    statusEl.className = "btn-test-status";
    btnEl.disabled = false;
  }
}

btnTestNotion.addEventListener("click", async () => {
  const token = /** @type {HTMLInputElement} */ (document.getElementById("envNotionToken")).value.trim();
  const dbId = /** @type {HTMLInputElement} */ (document.getElementById("envNotionDbId")).value.trim();

  if (!token || !dbId) {
    await showAlert("Notion Token과 Database ID를 먼저 입력하세요.", { type: "warning", title: "입력 필요" });
    return;
  }

  setTestState(btnTestNotionIcon, btnTestNotionStatus, btnTestNotionSpinner, btnTestNotion, "testing");

  try {
    const result = await window.autosdms.testNotion(token, dbId);
    if (result.success) {
      setTestState(btnTestNotionIcon, btnTestNotionStatus, btnTestNotionSpinner, btnTestNotion, "success");
    } else {
      setTestState(btnTestNotionIcon, btnTestNotionStatus, btnTestNotionSpinner, btnTestNotion, "error", result.error);
    }
  } catch (err) {
    setTestState(btnTestNotionIcon, btnTestNotionStatus, btnTestNotionSpinner, btnTestNotion, "error", String(err));
  }
});

btnTestErp.addEventListener("click", async () => {
  const id = /** @type {HTMLInputElement} */ (document.getElementById("envCompanyId")).value.trim();
  const pw = /** @type {HTMLInputElement} */ (document.getElementById("envCompanyPw")).value.trim();

  if (!id || !pw) {
    await showAlert("ERP ID와 Password를 먼저 입력하세요.", { type: "warning", title: "입력 필요" });
    return;
  }

  setTestState(btnTestErpIcon, btnTestErpStatus, btnTestErpSpinner, btnTestErp, "testing");

  try {
    const result = await window.autosdms.testErp(id, pw);
    if (result.success) {
      setTestState(btnTestErpIcon, btnTestErpStatus, btnTestErpSpinner, btnTestErp, "success");
    } else {
      setTestState(btnTestErpIcon, btnTestErpStatus, btnTestErpSpinner, btnTestErp, "error", result.error);
    }
  } catch (err) {
    setTestState(btnTestErpIcon, btnTestErpStatus, btnTestErpSpinner, btnTestErp, "error", String(err));
  }
});

// --- Manual Modal ---
const manualModal = document.getElementById("manualModal");
const btnManual = document.getElementById("btnManual");
const btnManualClose = document.getElementById("btnManualClose");
const manualTabs = document.querySelectorAll(".manual-tab");
const manualContents = { daily: document.getElementById("manualDaily"), weekly: document.getElementById("manualWeekly") };

btnManual.addEventListener("click", () => {
  manualModal.classList.add("active");
});

btnManualClose.addEventListener("click", () => {
  manualModal.classList.remove("active");
});

manualModal.addEventListener("click", (e) => {
  if (e.target === manualModal) manualModal.classList.remove("active");
});

manualTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    manualTabs.forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const target = tab.getAttribute("data-tab");
    Object.values(manualContents).forEach((c) => c.classList.remove("active"));
    if (manualContents[target]) manualContents[target].classList.add("active");
  });
});

// --- Notion Token Issue Link ---
const btnNotionTokenIssue = document.getElementById("btnNotionTokenIssue");
btnNotionTokenIssue.addEventListener("click", () => {
  window.autosdms.openExternal("https://www.notion.so/profile/integrations");
});

// --- Notion Link ---
const btnOpenNotion = document.getElementById("btnOpenNotion");
btnOpenNotion.addEventListener("click", async () => {
  const url = await window.autosdms.getNotionUrl();
  if (url) {
    window.autosdms.openExternal(url);
  } else {
    showAlert("Notion Database ID가 설정되지 않았습니다.\n설정에서 먼저 등록해주세요.", { type: "warning", title: "Notion 연결 불가" });
  }
});

// --- Startup ---
initDate();
(async () => {
  // 버전 표시 (package.json에서 자동)
  try {
    const ver = await window.autosdms.getVersion();
    const el = document.getElementById("appVersion");
    if (el) el.textContent = `v${ver}`;
  } catch { /* ignore */ }

  await checkEnv();
  if (!envValid) {
    // 환경변수 미설정 → 설정 모달 자동 오픈 (취소 불가)
    appendLog("warn", "환경변수가 설정되지 않았습니다. 설정을 먼저 완료해주세요.");
    showSettings(true);
  }

  // --- Auto Update ---
  setupAutoUpdater();
})();

function setupAutoUpdater() {
  const banner = document.getElementById("updateBanner");
  const msg = document.getElementById("updateMessage");
  const actionBtn = document.getElementById("btnUpdateAction");
  const dismissBtn = document.getElementById("btnUpdateDismiss");
  if (!banner || !msg || !actionBtn || !dismissBtn) return;

  let updateState = "idle"; // idle | available | downloading | ready

  window.autosdms.onUpdateAvailable((version) => {
    updateState = "available";
    banner.style.display = "flex";
    msg.textContent = `새 버전(v${version})이 있습니다.`;
    actionBtn.textContent = "다운로드";
    appendLog("info", `[UPDATER] 새 버전 v${version} 발견.`);
  });

  window.autosdms.onUpdateProgress((percent) => {
    msg.textContent = `업데이트 다운로드 중... ${percent}%`;
    actionBtn.textContent = `${percent}%`;
    actionBtn.disabled = true;
  });

  window.autosdms.onUpdateDownloaded((version) => {
    updateState = "ready";
    msg.textContent = `v${version} 다운로드 완료! 재시작하여 업데이트합니다.`;
    actionBtn.textContent = "재시작";
    actionBtn.disabled = false;
    appendLog("info", `[UPDATER] v${version} 다운로드 완료. 재시작하면 적용됩니다.`);
  });

  window.autosdms.onUpdateNotAvailable(() => {
    // 조용히 패스
  });

  actionBtn.addEventListener("click", async () => {
    if (updateState === "available") {
      updateState = "downloading";
      actionBtn.disabled = true;
      msg.textContent = "업데이트 다운로드 시작...";
      await window.autosdms.downloadUpdate();
    } else if (updateState === "ready") {
      await window.autosdms.installUpdate();
    }
  });

  dismissBtn.addEventListener("click", () => {
    banner.style.display = "none";
  });
}
