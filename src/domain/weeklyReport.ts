import type { OtherWorkDraft } from "../notion/otherWorkMapper.js";

export interface WeeklyProjectSummary {
  project: string;
  items: string[]; // 업무 내용 목록 (중복 제거됨)
}

/**
 * workComment에서 업무 내용 줄을 추출한다.
 * - 앞 공백을 먼저 제거(trim)한 뒤 구조를 판단한다.
 * - "-"로 시작하면 하위항목 → "- 내용" 형태로 정규화
 * - "."으로 시작하면 ERP 형식 하위항목 → "- 내용" 형태로 정규화
 * - 그 외는 타이틀 → 그대로 반환
 */
function extractContentLines(workComment: string): string[] {
  return workComment
    .split("\n")
    .map((l) => {
      const trimmed = l.trim();
      if (trimmed.startsWith("-")) {
        return "- " + trimmed.replace(/^-+\s*/, "");
      }
      if (trimmed.startsWith(".")) {
        return "- " + trimmed.replace(/^\.+\s*/, "");
      }
      return trimmed;
    })
    .filter(Boolean);
}

/**
 * OtherWorkDraft 배열을 프로젝트별로 그룹핑하고,
 * 각 프로젝트 내에서 업무 내용을 추출하여 요약한다.
 */
export function groupByProject(drafts: OtherWorkDraft[]): WeeklyProjectSummary[] {
  const map = new Map<string, Set<string>>();

  for (const draft of drafts) {
    const project = draft.project?.trim() || "공통업무";

    if (!map.has(project)) {
      map.set(project, new Set());
    }

    const lines = extractContentLines(draft.workComment);
    for (const line of lines) {
      map.get(project)!.add(line);
    }
  }

  const summaries: WeeklyProjectSummary[] = [];
  for (const [project, itemSet] of map) {
    summaries.push({
      project,
      items: [...itemSet]
    });
  }

  // 프로젝트명 기준 정렬 (공통업무는 마지막)
  summaries.sort((a, b) => {
    if (a.project === "공통업무") return 1;
    if (b.project === "공통업무") return -1;
    return a.project.localeCompare(b.project, "ko");
  });

  return summaries;
}

/**
 * 주간 요약을 사람이 읽기 좋은 텍스트로 포맷한다.
 */
export function formatWeeklySummary(summaries: WeeklyProjectSummary[]): string {
  const sections: string[] = [];

  for (const summary of summaries) {
    const header = `[${summary.project}]`;
    sections.push([header, ...summary.items].join("\n"));
  }

  return sections.join("\n\n");
}
