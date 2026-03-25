import { app, BrowserWindow } from "electron";
import path from "node:path";
import { autoUpdater } from "electron-updater";
import { registerIpcHandlers } from "./ipc-handlers.js";

// Electron에서 stdout/stderr 파이프가 끊어져도 크래시하지 않도록 처리
process.stdout?.on?.("error", () => {});
process.stderr?.on?.("error", () => {});

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
    icon: undefined // TODO: add app icon
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
  // 개발 모드에서는 스킵
  if (!app.isPackaged) {
    console.log("[UPDATER] Skipping auto-update in dev mode.");
    return;
  }

  autoUpdater.autoDownload = false; // 사용자 확인 후 다운로드
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-available", (info) => {
    console.log(`[UPDATER] Update available: v${info.version}`);
    mainWindow?.webContents.send("update:available", info.version);
  });

  autoUpdater.on("update-not-available", () => {
    console.log("[UPDATER] No updates available.");
    mainWindow?.webContents.send("update:not-available");
  });

  autoUpdater.on("download-progress", (progress) => {
    mainWindow?.webContents.send("update:progress", Math.round(progress.percent));
  });

  autoUpdater.on("update-downloaded", (info) => {
    console.log(`[UPDATER] Update downloaded: v${info.version}`);
    mainWindow?.webContents.send("update:downloaded", info.version);
  });

  autoUpdater.on("error", (err) => {
    console.error("[UPDATER] Error:", err.message);
  });

  // 앱 시작 5초 후 업데이트 체크
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error("[UPDATER] Check failed:", err.message);
    });
  }, 5000);
}

app.whenReady().then(() => {
  createWindow();
  setupAutoUpdater();
});

app.on("window-all-closed", () => {
  app.quit();
});
