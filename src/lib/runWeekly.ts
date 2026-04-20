import fs from "node:fs";
import path from "node:path";
import { loadCompanyEnv, loadNotionEnv } from "../config/env.js";
import { getWeekdayRange } from "../domain/businessDay.js";
import { formatWeeklySummary, groupByProject } from "../domain/weeklyReport.js";
import { ErpOtherWorkRegistrar } from "../erp/otherWorkRegistrar.js";
import { checkSignal } from "../lib/cancellation.js";
import { NotionDailyFetcher } from "../notion/notionClient.js";
import { mapNotionPagesToOtherWorkDrafts, type OtherWorkDraft } from "../notion/otherWorkMapper.js";

export interface WeeklyRunOptions {
  dateYmd: string;
  headed: boolean;
  slowMoMs?: number;
  dryRun?: boolean;
  signal?: AbortSignal;
}

export async function runWeeklyRegistration(options: WeeklyRunOptions): Promise<void> {
  const { dateYmd, headed, slowMoMs = 0, dryRun = false, signal } = options;
  const targetDate = new Date(`${dateYmd}T00:00:00`);

  const weekRange = getWeekdayRange(targetDate);
  console.log(`[INFO] 주간 범위: ${weekRange[0]} ~ ${weekRange[weekRange.length - 1]}`);

  const notionEnv = loadNotionEnv();
  const companyEnv = loadCompanyEnv();
  const notion = new NotionDailyFetcher(notionEnv);

  // 월~금 데이터 수집
  const allItems: OtherWorkDraft[] = [];
  for (const ymd of weekRange) {
    checkSignal(signal);
    console.log(`[FETCH] ${ymd} ...`);
    const dayData = await notion.fetchByDate(ymd);
    const items = mapNotionPagesToOtherWorkDrafts(dayData.pages);
    console.log(`  → ${items.length} items`);
    allItems.push(...items);
  }

  console.log(`\n[INFO] 총 ${allItems.length} 건 수집 완료.\n`);

  if (allItems.length === 0) {
    console.log("[INFO] 등록된 업무가 없습니다.");
    return;
  }

  // 프로젝트별 요약
  const summaries = groupByProject(allItems);
  const report = formatWeeklySummary(summaries);

  console.log("=".repeat(60));
  console.log("주간 업무보고 요약");
  console.log("=".repeat(60));
  console.log(report);
  console.log("=".repeat(60));

  // 아티팩트 저장
  const dumpDir = path.resolve(process.cwd(), "artifacts", "weekly-report");
  fs.mkdirSync(dumpDir, { recursive: true });
  const weekLabel = `${weekRange[0]}_${weekRange[weekRange.length - 1]}`;
  fs.writeFileSync(path.join(dumpDir, `${weekLabel}-summary.txt`), report, "utf8");
  fs.writeFileSync(
    path.join(dumpDir, `${weekLabel}-items.json`),
    JSON.stringify(allItems, null, 2),
    "utf8"
  );
  console.log(`\n[INFO] 아티팩트 저장: artifacts/weekly-report/${weekLabel}-*`);

  if (dryRun) {
    console.log("[INFO] Dry run mode. Skip ERP registration.");
    return;
  }

  checkSignal(signal);
  // ERP 주간 업무보고 등록
  const registrar = new ErpOtherWorkRegistrar(companyEnv, {
    headed,
    slowMoMs: Number.isFinite(slowMoMs) && slowMoMs > 0 ? slowMoMs : 0
  });
  await registrar.registerWeeklyStandalone(summaries, targetDate, signal);
}
