import { EventEmitter } from "node:events";

export type LogLevel = "info" | "fetch" | "error" | "result" | "warn" | "login" | "debug";

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
}

export class TaskLogger extends EventEmitter {
  log(level: LogLevel, message: string): void {
    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date().toISOString()
    };
    this.emit("log", entry);
  }

  /**
   * console.log / console.error를 가로채서 LogEntry 이벤트로 emit한다.
   * 기존 코드의 console.log 호출을 수정하지 않고 인터셉트하는 핵심 메서드.
   */
  async wrapConsole<T>(fn: () => Promise<T>): Promise<T> {
    const origLog = console.log;
    const origError = console.error;

    console.log = (...args: unknown[]) => {
      const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
      const level = this.parseLevel(msg);
      this.log(level, msg);
      try { origLog.apply(console, args); } catch { /* EPIPE in Electron */ }
    };

    console.error = (...args: unknown[]) => {
      const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
      this.log("error", msg);
      try { origError.apply(console, args); } catch { /* EPIPE in Electron */ }
    };

    try {
      return await fn();
    } finally {
      console.log = origLog;
      console.error = origError;
    }
  }

  private parseLevel(msg: string): LogLevel {
    if (msg.startsWith("[ERROR]")) return "error";
    if (msg.startsWith("[FETCH]")) return "fetch";
    if (msg.startsWith("[RESULT]")) return "result";
    if (msg.startsWith("[LOGIN]")) return "login";
    if (msg.startsWith("[WARN]")) return "warn";
    return "info";
  }
}
