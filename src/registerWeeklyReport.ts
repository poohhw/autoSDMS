import fs from "node:fs";
import path from "node:path";
import { loadCompanyEnv, loadNotionEnv } from "./config/env.js";
import { getWeekdayRange } from "./domain/businessDay.js";
import { formatWeeklySummary, groupByProject } from "./domain/weeklyReport.js";
import { ErpOtherWorkRegistrar } from "./erp/otherWorkRegistrar.js";
import { NotionDailyFetcher } from "./notion/notionClient.js";
import { mapNotionPagesToOtherWorkDrafts, type OtherWorkDraft } from "./notion/otherWorkMapper.js";
import { ensureStartupEnv } from "./runtime/ensureEnv.js";

function parseDateArg(input?: string): Date {
  if (!input) {
    return new Date();
  }
  const date = new Date(`${input}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date format: ${input} (example: 2026-03-16)`);
  }
  return date;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const headed = args.includes("--headed");
  const slowArg = args.find((x) => x.startsWith("--slow="));
  const slowMoMs = slowArg ? Number(slowArg.split("=")[1]) : 0;
  const dateArg = args.find((x) => !x.startsWith("--"));
  const targetDate = parseDateArg(dateArg);

  const weekRange = getWeekdayRange(targetDate);
  console.log(`[INFO] 주간 범위: ${weekRange[0]} ~ ${weekRange[weekRange.length - 1]}`);

  await ensureStartupEnv();
  const notionEnv = loadNotionEnv();
  const companyEnv = loadCompanyEnv();
  const notion = new NotionDailyFetcher(notionEnv);

  // 월~금 데이터 수집
  const allItems: OtherWorkDraft[] = [];
  for (const ymd of weekRange) {
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

  // ERP 주간 업무보고 등록
  const registrar = new ErpOtherWorkRegistrar(companyEnv, {
    headed,
    slowMoMs: Number.isFinite(slowMoMs) && slowMoMs > 0 ? slowMoMs : 0
  });
  await registrar.registerWeeklyStandalone(summaries, targetDate);
}

main().catch((error) => {
  console.error("[ERROR]", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
