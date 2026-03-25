import type { NotionWorkItem, RegisterResult } from "../domain/types.js";

export interface NotionGateway {
  fetchByDate(dateYmd: string): Promise<NotionWorkItem[]>;
}

export interface ErpGateway {
  login(): Promise<void>;
  ensureEtcTask(item: NotionWorkItem, dateYmd: string): Promise<void>;
  registerYesterday(item: NotionWorkItem, dateYmd: string): Promise<void>;
  registerToday(item: NotionWorkItem, dateYmd: string): Promise<void>;
  isAlreadyRegistered(dateYmd: string, title: string, section: "전일" | "금일"): Promise<boolean>;
}

export interface ArtifactLogger {
  stepLog(step: string, message: string): Promise<void>;
  stepError(step: string, error: unknown): Promise<void>;
  screenshot(step: string): Promise<void>;
}

export interface DailyScrumUseCase {
  execute(dateYmd: string): Promise<RegisterResult>;
}

