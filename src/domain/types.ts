export type WorkCategory = "요구사항" | "기타업무";

export interface NotionWorkItem {
  date: string;
  title: string;
  category: WorkCategory;
  content: string;
  progress: string;
  expectedProgress: string;
  hours?: string;
}

export interface RegisterResult {
  total: number;
  success: number;
  failed: number;
  failures: Array<{
    title: string;
    reason: string;
  }>;
}

