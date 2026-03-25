import fs from "node:fs";
import path from "node:path";
import { loadCompanyEnv, loadNotionEnv } from "../config/env.js";
import { getPreviousBusinessDay, toYmd } from "../domain/businessDay.js";
import { ErpOtherWorkRegistrar, type RegisterSummary } from "../erp/otherWorkRegistrar.js";
import { normalizeNotionPage } from "../notion/formatters.js";
import { NotionDailyFetcher } from "../notion/notionClient.js";
import { mapNotionPagesToOtherWorkDrafts } from "../notion/otherWorkMapper.js";

export interface DailyRunOptions {
  dateYmd: string;
  headed: boolean;
  slowMoMs?: number;
  dryRun?: boolean;
}

export async function runDailyRegistration(options: DailyRunOptions): Promise<RegisterSummary | null> {
  const { dateYmd, headed, slowMoMs = 0, dryRun = false } = options;

  const notionEnv = loadNotionEnv();
  const companyEnv = loadCompanyEnv();

  const notion = new NotionDailyFetcher(notionEnv);
  const dayData = await notion.fetchByDate(dateYmd);
  const rawDumpDir = path.resolve(process.cwd(), "artifacts", "notion-dump");
  fs.mkdirSync(rawDumpDir, { recursive: true });
  fs.writeFileSync(
    path.join(rawDumpDir, `${dateYmd}-raw.json`),
    JSON.stringify(dayData.pages, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    path.join(rawDumpDir, `${dateYmd}-normalized.json`),
    JSON.stringify(dayData.pages.map(normalizeNotionPage), null, 2),
    "utf8"
  );

  const otherWorkItems = mapNotionPagesToOtherWorkDrafts(dayData.pages);

  if (otherWorkItems.length === 0) {
    console.log(`[INFO] No work items found on ${dateYmd}.`);
    return null;
  }

  const erpOnlyItems = otherWorkItems.filter((x) => x.category === "기타업무");
  const scrumOnlyItems = otherWorkItems.filter((x) => x.category !== "기타업무");
  console.log(`[INFO] Found ${otherWorkItems.length} work items on ${dateYmd} (기타업무: ${erpOnlyItems.length}, 요구사항 등: ${scrumOnlyItems.length}).`);
  console.log(
    JSON.stringify(
      otherWorkItems.map((x) => ({
        notionPageId: x.notionPageId,
        title: x.title,
        workCommentPreview: x.workComment.slice(0, 80),
        finishDate: x.finishDate,
        project: x.project,
        sdmsCategoryRef: x.sdmsCategoryRef,
        workType: x.workType,
        workDetail: x.workDetail,
        progressRate: x.progressRate
      })),
      null,
      2
    )
  );

  // Fetch previous business day data
  const targetDate = new Date(`${dateYmd}T00:00:00`);
  const prevBizDate = getPreviousBusinessDay(targetDate);
  const prevDateYmd = toYmd(prevBizDate);
  console.log(`[INFO] Previous business day: ${prevDateYmd} (for 전일 업무)`);

  const prevDayData = await notion.fetchByDate(prevDateYmd);
  fs.writeFileSync(
    path.join(rawDumpDir, `${prevDateYmd}-raw.json`),
    JSON.stringify(prevDayData.pages, null, 2),
    "utf8"
  );
  const yesterdayItems = mapNotionPagesToOtherWorkDrafts(prevDayData.pages);
  console.log(`[INFO] Found ${yesterdayItems.length} previous-day items on ${prevDateYmd}.`);

  if (dryRun) {
    console.log("[INFO] Dry run mode enabled. Skip ERP registration.");
    return null;
  }

  const registrar = new ErpOtherWorkRegistrar(companyEnv, {
    headed,
    slowMoMs: Number.isFinite(slowMoMs) && slowMoMs > 0 ? slowMoMs : 0
  });
  const result = await registrar.register(otherWorkItems, {
    keepOpen: true,
    dateYmd,
    yesterdayItems
  });
  console.log("[RESULT]");
  console.log(JSON.stringify(result, null, 2));
  return result;
}
