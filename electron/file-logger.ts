import fs from "node:fs";
import path from "node:path";
import type { LogEntry } from "../src/lib/logger.js";

export class FileLogger {
  private readonly logDir: string;

  constructor(baseDir: string) {
    this.logDir = path.resolve(baseDir, "logs");
    fs.mkdirSync(this.logDir, { recursive: true });
  }

  getLogDir(): string {
    return this.logDir;
  }

  append(entry: LogEntry): void {
    const dateStr = entry.timestamp.slice(0, 10);
    const line = `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.message}\n`;

    // All log
    const allPath = path.join(this.logDir, `autosdms-${dateStr}.log`);
    fs.appendFileSync(allPath, line, "utf8");

    // Error log
    if (entry.level === "error") {
      const errPath = path.join(this.logDir, `autosdms-${dateStr}-error.log`);
      fs.appendFileSync(errPath, line, "utf8");
    }
  }
}
