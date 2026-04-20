import { ipcMain, shell, app, type BrowserWindow } from "electron";
import { autoUpdater } from "electron-updater";
import { Client } from "@notionhq/client";
import { chromium } from "playwright";
import dotenv from "dotenv";
import path from "node:path";
import fs from "node:fs";
import { TaskLogger, type LogEntry } from "../src/lib/logger.js";
import { CancelledError } from "../src/lib/cancellation.js";
import { runDailyRegistration } from "../src/lib/runDaily.js";
import { runWeeklyRegistration } from "../src/lib/runWeekly.js";
import { bulkCompleteOtherWork } from "../src/erp/otherWorkCompleter.js";
import { readEnvObject, writeEnvObject, setEnvFilePath } from "../src/runtime/ensureEnv.js";
import { FileLogger } from "./file-logger.js";

// %APPDATA%/autoSDMS/.env (사용자 데이터 폴더 — 앱 업데이트/재설치해도 유지)
let ENV_FILE = path.join(app.getPath("userData"), ".env");

const REQUIRED_ENV_KEYS = [
  "NOTION_ID",
  "NOTION_PASSWORD",
  "NOTION_TOKEN",
  "NOTION_DATABASE_ID",
  "COMPANY_ID",
  "COMPANY_PASSWORD",
  "EMPLOYEE_NAME",
  "GH_TOKEN"
];

let currentAbortController: AbortController | null = null;

export function registerIpcHandlers(mainWindow: BrowserWindow, baseDir: string): void {
  // userData 폴더에 .env 저장 (앱 업데이트해도 유지)
  const userDataDir = app.getPath("userData");
  fs.mkdirSync(userDataDir, { recursive: true });
  ENV_FILE = path.join(userDataDir, ".env");
  setEnvFilePath(ENV_FILE);

  // 기존 baseDir/.env가 있으면 userData로 마이그레이션
  const oldEnvFile = path.resolve(baseDir, ".env");
  if (fs.existsSync(oldEnvFile) && !fs.existsSync(ENV_FILE)) {
    fs.copyFileSync(oldEnvFile, ENV_FILE);
    console.log(`[ENV] Migrated .env from ${oldEnvFile} → ${ENV_FILE}`);
  }

  // CWD는 baseDir로 설정 (artifacts, logs 등 상대 경로 대응)
  process.chdir(baseDir);

  const fileLogger = new FileLogger(baseDir);

  // --- Task: Run Daily ---
  ipcMain.handle("task:run-daily", async (_event, dateYmd: string, headed: boolean, leaveRequest: boolean = false, slowMoMs: number = 0) => {
    currentAbortController = new AbortController();
    const { signal } = currentAbortController;
    const logger = new TaskLogger();
    logger.on("log", (entry: LogEntry) => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send("log:line", entry);
      }
      fileLogger.append(entry);
    });

    try {
      const result = await logger.wrapConsole(() =>
        runDailyRegistration({ dateYmd, headed, dryRun: false, leaveRequest, signal, slowMoMs })
      );
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send("task:done", { success: true, result });
      }
      return { success: true, result };
    } catch (err) {
      const cancelled = err instanceof CancelledError;
      const error = err instanceof Error ? err.message : String(err);
      if (!cancelled) {
        fileLogger.append({ level: "error", message: `[FATAL] ${error}`, timestamp: new Date().toISOString() });
      }
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send("task:done", { success: false, error, cancelled });
      }
      return { success: false, error, cancelled };
    } finally {
      currentAbortController = null;
    }
  });

  // --- Task: Run Weekly ---
  ipcMain.handle("task:run-weekly", async (_event, dateYmd: string, headed: boolean, slowMoMs: number = 0) => {
    currentAbortController = new AbortController();
    const { signal } = currentAbortController;
    const logger = new TaskLogger();
    logger.on("log", (entry: LogEntry) => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send("log:line", entry);
      }
      fileLogger.append(entry);
    });

    try {
      await logger.wrapConsole(() =>
        runWeeklyRegistration({ dateYmd, headed, dryRun: false, signal, slowMoMs })
      );
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send("task:done", { success: true });
      }
      return { success: true };
    } catch (err) {
      const cancelled = err instanceof CancelledError;
      const error = err instanceof Error ? err.message : String(err);
      if (!cancelled) {
        fileLogger.append({ level: "error", message: `[FATAL] ${error}`, timestamp: new Date().toISOString() });
      }
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send("task:done", { success: false, error, cancelled });
      }
      return { success: false, error, cancelled };
    } finally {
      currentAbortController = null;
    }
  });

  // --- Bulk Complete ---
  ipcMain.handle("task:bulk-complete", async (_event, headed: boolean, slowMoMs: number = 0) => {
    currentAbortController = new AbortController();
    const { signal } = currentAbortController;
    const logger = new TaskLogger();
    logger.on("log", (entry: LogEntry) => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send("log:line", entry);
      }
      fileLogger.append(entry);
    });

    try {
      dotenv.config({ path: ENV_FILE, override: true });
      const envObj = readEnvObject();
      const env = {
        COMPANY_ID: envObj.COMPANY_ID || "",
        COMPANY_PASSWORD: envObj.COMPANY_PASSWORD || "",
        EMPLOYEE_NAME: envObj.EMPLOYEE_NAME || "",
        COMPANY_LOGIN_URL: "http://erp.gcsc.co.kr/login.aspx",
      };

      const result = await logger.wrapConsole(() =>
        bulkCompleteOtherWork(env, { headed, signal, slowMoMs })
      );
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send("task:done", { success: true });
      }
      return { success: true, ...result };
    } catch (err) {
      const cancelled = err instanceof CancelledError;
      const error = err instanceof Error ? err.message : String(err);
      if (!cancelled) {
        fileLogger.append({ level: "error", message: `[FATAL] ${error}`, timestamp: new Date().toISOString() });
      }
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send("task:done", { success: false, error, cancelled });
      }
      return { success: false, error, cancelled };
    } finally {
      currentAbortController = null;
    }
  });

  // --- Task: Cancel ---
  ipcMain.handle("task:cancel", () => {
    if (currentAbortController) {
      currentAbortController.abort();
      return { cancelled: true };
    }
    return { cancelled: false };
  });

  // --- Environment ---
  ipcMain.handle("env:status", () => {
    dotenv.config({ path: ENV_FILE, override: true });
    const envObj = readEnvObject();
    const OPTIONAL_KEYS = ["GH_TOKEN"];
    const missing = REQUIRED_ENV_KEYS.filter((k) => !OPTIONAL_KEYS.includes(k) && !envObj[k]?.trim());
    return { valid: missing.length === 0, missing };
  });

  ipcMain.handle("env:values", () => {
    dotenv.config({ path: ENV_FILE, override: true });
    const envObj = readEnvObject();
    // 비밀번호는 마스킹하지 않고 그대로 반환 (로컬 앱이므로 안전)
    const result: Record<string, string> = {};
    for (const key of REQUIRED_ENV_KEYS) {
      result[key] = envObj[key] ?? "";
    }
    return result;
  });

  ipcMain.handle("env:save", (_event, values: Record<string, string>) => {
    const current = readEnvObject();
    const merged = { ...current, ...values };
    writeEnvObject(merged);
    dotenv.config({ path: ENV_FILE, override: true });
  });

  // --- Connection Test: Notion ---
  ipcMain.handle("test:notion", async (_event, token: string, dbId: string) => {
    try {
      const client = new Client({ auth: token });
      await client.databases.retrieve({ database_id: dbId });
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("unauthorized") || msg.includes("401")) {
        return { success: false, error: "Token이 유효하지 않습니다." };
      }
      if (msg.includes("not_found") || msg.includes("404")) {
        return { success: false, error: "Database ID를 찾을 수 없습니다.\nIntegration 연결을 확인하세요." };
      }
      return { success: false, error: msg };
    }
  });

  // --- Connection Test: ERP ---
  ipcMain.handle("test:erp", async (_event, id: string, pw: string) => {
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext();
      const page = await context.newPage();

      await page.goto("http://erp.gcsc.co.kr/login.aspx", { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.fill("#inputId", id);
      await page.fill("#inputScr", pw);
      await page.click("#logbtnImg");
      await page.waitForLoadState("networkidle", { timeout: 15000 });

      const url = page.url();
      if (url.includes("main.aspx")) {
        return { success: true };
      }

      // 로그인 실패 체크
      const bodyText = await page.locator("body").innerText().catch(() => "");
      if (bodyText.includes("비밀번호") || bodyText.includes("아이디")) {
        return { success: false, error: "아이디 또는 비밀번호가 일치하지 않습니다." };
      }
      return { success: false, error: "로그인 후 메인 페이지로 이동하지 못했습니다." };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Timeout") || msg.includes("timeout")) {
        return { success: false, error: "ERP 서버에 연결할 수 없습니다.\n네트워크를 확인하세요." };
      }
      return { success: false, error: msg };
    } finally {
      if (browser) {
        await browser.close().catch(() => undefined);
      }
    }
  });

  // --- Shell ---
  ipcMain.handle("shell:open-folder", async (_event, folderPath: string) => {
    const fs = await import("node:fs");
    const resolved = path.resolve(baseDir, folderPath);
    fs.mkdirSync(resolved, { recursive: true });
    const error = await shell.openPath(resolved);
    if (error) {
      return { success: false, error };
    }
    return { success: true };
  });

  ipcMain.handle("shell:open-external", (_event, url: string) => {
    shell.openExternal(url);
  });

  // --- Notion URL ---
  ipcMain.handle("env:notion-url", () => {
    dotenv.config({ path: ENV_FILE, override: true });
    const envObj = readEnvObject();
    const dbId = envObj["NOTION_DATABASE_ID"]?.trim();
    if (dbId) {
      // Notion DB URL format
      const cleanId = dbId.replace(/-/g, "");
      return `https://www.notion.so/${cleanId}`;
    }
    return "";
  });

  // App version (package.json에서 읽기)
  ipcMain.handle("app:version", () => {
    // baseDir/package.json → 루트 package.json 순으로 탐색
    const candidates = [
      path.join(baseDir, "package.json"),
      path.join(baseDir, "..", "package.json"),
      path.join(app.getAppPath(), "package.json"),
    ];
    for (const pkgPath of candidates) {
      try {
        if (!fs.existsSync(pkgPath)) continue;
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (pkg.version && pkg.version !== "0.0.0" && !pkg.version.startsWith("41")) {
          return pkg.version;
        }
      } catch { /* skip */ }
    }
    return app.getVersion();
  });

  // --- Update ---
  ipcMain.handle("update:check", async () => {
    if (!app.isPackaged) return { available: false, reason: "dev-mode" };
    try {
      const result = await autoUpdater.checkForUpdates();
      return { available: !!result?.updateInfo, version: result?.updateInfo?.version };
    } catch (err: any) {
      return { available: false, reason: err.message };
    }
  });

  ipcMain.handle("update:download", async () => {
    await autoUpdater.downloadUpdate();
  });

  ipcMain.handle("update:install", () => {
    autoUpdater.quitAndInstall(false, true);
  });
}
