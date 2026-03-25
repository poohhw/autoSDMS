import type { NotionWorkItem, WorkCategory } from "./types.js";

interface RawNotionRow {
  date?: string;
  title?: string;
  category?: string;
  content?: string;
  progress?: string;
  expectedProgress?: string;
  hours?: string;
}

const ALLOWED_CATEGORIES: WorkCategory[] = ["요구사항", "기타업무"];

function assertCategory(value: string): WorkCategory {
  if (!ALLOWED_CATEGORIES.includes(value as WorkCategory)) {
    throw new Error(`지원하지 않는 카테고리입니다: ${value}`);
  }
  return value as WorkCategory;
}

export function parseNotionRows(rows: RawNotionRow[]): NotionWorkItem[] {
  return rows.map((row, index) => {
    if (!row.date || !row.title || !row.category || !row.content) {
      throw new Error(`Notion 데이터 필수값 누락 (index=${index})`);
    }

    return {
      date: row.date,
      title: row.title,
      category: assertCategory(row.category),
      content: row.content,
      progress: row.progress ?? "0%",
      expectedProgress: row.expectedProgress ?? "0%",
      hours: row.hours
    };
  });
}

