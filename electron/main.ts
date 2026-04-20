import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import fs from "node:fs";
import { autoUpdater } from "electron-updater";
import { registerIpcHandlers } from "./ipc-handlers.js";

// Electron에서 stdout/stderr 파이프가 끊어져도 크래시하지 않도록 처리
process.stdout?.on?.("error", () => {});
process.stderr?.on?.("error", () => {});

// 메인 프로세스 로그를 파일로 기록
function logToFile(msg: string): void {
  try {
    const logDir = app.isPackaged
      ? path.join(path.dirname(app.getPath("exe")), "logs")
      : path.resolve(__dirname, "..", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const logPath = path.join(logDir, `main-${date}.log`);
    const timestamp = new Date().toISOString();
    fs.appendFileSync(logPath, `[${timestamp}] ${msg}\n`, "utf8");
  } catch { /* ignore */ }
}

function log(msg: string): void {
  console.log(msg);
  logToFile(msg);
}

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 860,
    height: 740,
    minWidth: 700,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    },
    title: "autoSDMS",
    icon: path.join(__dirname, "..", "assets", "icon.png")
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  // 프로젝트 루트: 개발 시 dist-electron/../, 패키징 시 app.getAppPath()
  const baseDir = app.isPackaged
    ? path.dirname(app.getPath("exe"))
    : path.resolve(__dirname, "..");
  registerIpcHandlers(mainWindow, baseDir);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function setupAutoUpdater(): void {
  log(`[UPDATER] app.isPackaged=${app.isPackaged}, version=${app.getVersion()}`);

  // 개발 모드에서는 스킵
  if (!app.isPackaged) {
    log("[UPDATER] Skipping auto-update in dev mode.");
    return;
  }

  // Private repo: 앱 설정(.env)의 GH_TOKEN 사용
  let ghToken = "";
  try {
    const dotenvMod = require("dotenv");
    const envPath = path.join(app.getPath("userData"), ".env");
    log(`[UPDATER] Reading .env from: ${envPath}`);
    const envContent = fs.readFileSync(envPath, "utf8");
    const parsed = dotenvMod.parse(envContent);
    ghToken = parsed.GH_TOKEN || "";
    log(`[UPDATER] GH_TOKEN found: ${ghToken ? "YES (" + ghToken.substring(0, 15) + "...)" : "NO"}`);
  } catch (e: any) {
    log(`[UPDATER] .env read error: ${e.message}`);
  }

  if (!ghToken) {
    log("[UPDATER] WARNING: No GH_TOKEN. Auto-update will fail for private repo.");
    mainWindow?.webContents.send("update:error", "GH_TOKEN이 설정되지 않았습니다. 설정에서 GitHub Token을 입력하세요.");
    return;
  }

  // Private repo: GH_TOKEN을 provider에 직접 설정
  process.env.GH_TOKEN = ghToken;
  autoUpdater.setFeedURL({
    provider: "github",
    owner: "poohhw",
    repo: "autoSDMS",
    private: true,
    token: ghToken
  });
  log("[UPDATER] GH_TOKEN set via setFeedURL(). Private repo update enabled.");

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    log("[UPDATER] Checking for updates...");
    mainWindow?.webContents.send("log:append", { level: "info", message: "[UPDATER] 업데이트 확인 중..." });
  });

  autoUpdater.on("update-available", (info) => {
    log(`[UPDATER] Update available: v${info.version}`);
    mainWindow?.webContents.send("update:available", info.version);
    mainWindow?.webContents.send("log:append", { level: "info", message: `[UPDATER] 새 버전 발견: v${info.version}` });
  });

  autoUpdater.on("update-not-available", (info) => {
    log(`[UPDATER] No updates available. Current: ${app.getVersion()}, Latest: ${info.version}`);
    mainWindow?.webContents.send("update:not-available");
  });

  autoUpdater.on("download-progress", (progress) => {
    mainWindow?.webContents.send("update:progress", Math.round(progress.percent));
  });

  autoUpdater.on("update-downloaded", (info) => {
    log(`[UPDATER] Update downloaded: v${info.version}`);
    mainWindow?.webContents.send("update:downloaded", info.version);
  });

  autoUpdater.on("error", (err) => {
    log(`[UPDATER] Error: ${err.message}`);
    mainWindow?.webContents.send("log:append", { level: "error", message: `[UPDATER] 오류: ${err.message}` });
  });

  // 앱 시작 2초 후 업데이트 체크
  log("[UPDATER] Will check for updates in 2 seconds...");
  setTimeout(() => {
    log("[UPDATER] Calling checkForUpdates()...");
    autoUpdater.checkForUpdates().catch((err) => {
      log(`[UPDATER] Check failed: ${err.message}`);
    });
  }, 2000);

  // 수동 업데이트 확인 IPC
  ipcMain.handle("update:check", async () => {
    log("[UPDATER] Manual update check requested.");
    try {
      const result = await autoUpdater.checkForUpdates();
      return { success: true, version: result?.updateInfo?.version };
    } catch (err: any) {
      log(`[UPDATER] Manual check failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  // 다운로드 요청 IPC
  ipcMain.handle("update:download", async () => {
    log("[UPDATER] Download requested.");
    await autoUpdater.downloadUpdate();
  });

  // 설치 및 재시작 IPC
  ipcMain.handle("update:install", () => {
    log("[UPDATER] Install and restart requested.");
    autoUpdater.quitAndInstall();
  });
}

app.whenReady().then(() => {
  createWindow();
  setupAutoUpdater();
});

app.on("window-all-closed", () => {
  app.quit();
});
