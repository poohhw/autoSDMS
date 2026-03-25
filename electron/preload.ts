import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("autosdms", {
  // Task execution
  runDaily: (dateYmd: string, headed: boolean): Promise<unknown> =>
    ipcRenderer.invoke("task:run-daily", dateYmd, headed),
  runWeekly: (dateYmd: string, headed: boolean): Promise<unknown> =>
    ipcRenderer.invoke("task:run-weekly", dateYmd, headed),

  // Log streaming (main → renderer)
  onLog: (callback: (entry: { level: string; message: string; timestamp: string }) => void) => {
    ipcRenderer.on("log:line", (_event, entry) => callback(entry));
  },

  // Task lifecycle
  onTaskDone: (callback: (result: { success: boolean; error?: string }) => void) => {
    ipcRenderer.on("task:done", (_event, result) => callback(result));
  },

  // Environment
  getEnvStatus: (): Promise<{ valid: boolean; missing: string[] }> =>
    ipcRenderer.invoke("env:status"),
  getEnvValues: (): Promise<Record<string, string>> =>
    ipcRenderer.invoke("env:values"),
  saveEnv: (values: Record<string, string>): Promise<void> =>
    ipcRenderer.invoke("env:save", values),

  // Shell
  openFolder: (folderPath: string): Promise<void> =>
    ipcRenderer.invoke("shell:open-folder", folderPath),

  // Connection Test
  testNotion: (token: string, dbId: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("test:notion", token, dbId),
  testErp: (id: string, pw: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("test:erp", id, pw),

  // External URL
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke("shell:open-external", url),

  // Get Notion Database URL
  getNotionUrl: (): Promise<string> =>
    ipcRenderer.invoke("env:notion-url"),

  // App version
  getVersion: (): Promise<string> =>
    ipcRenderer.invoke("app:version"),

  // Auto Update
  checkUpdate: (): Promise<{ available: boolean; version?: string; reason?: string }> =>
    ipcRenderer.invoke("update:check"),
  downloadUpdate: (): Promise<void> =>
    ipcRenderer.invoke("update:download"),
  installUpdate: (): Promise<void> =>
    ipcRenderer.invoke("update:install"),
  onUpdateAvailable: (callback: (version: string) => void) => {
    ipcRenderer.on("update:available", (_event, version) => callback(version));
  },
  onUpdateProgress: (callback: (percent: number) => void) => {
    ipcRenderer.on("update:progress", (_event, percent) => callback(percent));
  },
  onUpdateDownloaded: (callback: (version: string) => void) => {
    ipcRenderer.on("update:downloaded", (_event, version) => callback(version));
  },
  onUpdateNotAvailable: (callback: () => void) => {
    ipcRenderer.on("update:not-available", () => callback());
  },
});
