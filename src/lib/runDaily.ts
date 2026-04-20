import fs from "node:fs";
import path from "node:path";
import { loadCompanyEnv, loadNotionEnv } from "../config/env.js";
import { getPreviousBusinessDay, toYmd } from "../domain/businessDay.js";
import { ErpOtherWorkRegistrar, type RegisterSummary } from "../erp/otherWorkRegistrar.js";
import { checkSignal } from "../lib/cancellation.js";
import { normalizeNotionPage } from "../notion/formatters.js";
import { NotionDailyFetcher } from "../notion/notionClient.js";
import { mapNotionPagesToOtherWorkDrafts } from "../notion/otherWorkMapper.js";

export interface DailyRunOptions {
  dateYmd: string;
  headed: boolean;
  slowMoMs?: number;
  dryRun?: boolean;
  leaveRequest?: boolean;
  signal?: AbortSignal;
}

export async function runDailyRegistration(options: DailyRunOptions): Promise<RegisterSummary | null> {
  const { dateYmd, headed, slowMoMs = 0, dryRun = false, leaveRequest = false, signal } = options;

  checkSignal(signal);
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

  // Relation ID → 제목 변환 (sdmsCategoryRef)
  const relationIds = otherWorkItems.map((i) => i.sdmsCategoryRef).filter((x): x is string => !!x);
  if (relationIds.length > 0) {
    const titleMap = await notion.resolveRelationIds(relationIds);
    for (const item of otherWorkItems) {
      if (item.sdmsCategoryRef && titleMap.has(item.sdmsCategoryRef)) {
        item.sdmsCategoryRef = titleMap.get(item.sdmsCategoryRef) || item.sdmsCategoryRef;
      }
    }
  }

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

  checkSignal(signal);
  // 전일 업무 조회: 최근 5 영업일 역순으로 데이터가 있는 날 사용
  let yesterdayItems: ReturnType<typeof mapNotionPagesToOtherWorkDrafts> = [];
  let foundPrevDateYmd = "";
  const targetDate = new Date(`${dateYmd}T00:00:00`);
  let scanDate = new Date(targetDate);
  for (let i = 0; i < 5; i++) {
    checkSignal(signal);
    scanDate = getPreviousBusinessDay(scanDate);
    const scanYmd = toYmd(scanDate);
    const scanData = await notion.fetchByDate(scanYmd);
    fs.writeFileSync(
      path.join(rawDumpDir, `${scanYmd}-raw.json`),
      JSON.stringify(scanData.pages, null, 2),
      "utf8"
    );
    const items = mapNotionPagesToOtherWorkDrafts(scanData.pages);
    if (items.length > 0) {
      yesterdayItems = items;
      foundPrevDateYmd = scanYmd;
      break;
    }
    console.log(`[INFO] No items on ${scanYmd}, checking earlier...`);
  }

  if (foundPrevDateYmd) {
    // Relation ID → 제목 변환 (전일 업무)
    const prevRelationIds = yesterdayItems.map((i) => i.sdmsCategoryRef).filter((x): x is string => !!x);
    if (prevRelationIds.length > 0) {
      const prevTitleMap = await notion.resolveRelationIds(prevRelationIds);
      for (const item of yesterdayItems) {
        if (item.sdmsCategoryRef && prevTitleMap.has(item.sdmsCategoryRef)) {
          item.sdmsCategoryRef = prevTitleMap.get(item.sdmsCategoryRef) || item.sdmsCategoryRef;
        }
      }
    }
    console.log(`[INFO] Found ${yesterdayItems.length} previous-day items on ${foundPrevDateYmd} (전일 업무).`);
  } else {
    console.log(`[INFO] No previous-day items found in the last 5 business days.`);
  }

  if (dryRun) {
    console.log("[INFO] Dry run mode enabled. Skip ERP registration.");
    return null;
  }

  checkSignal(signal);
  const registrar = new ErpOtherWorkRegistrar(companyEnv, {
    headed,
    slowMoMs: Number.isFinite(slowMoMs) && slowMoMs > 0 ? slowMoMs : 0
  });
  const result = await registrar.register(otherWorkItems, {
    keepOpen: true,
    dateYmd,
    yesterdayItems,
    leaveRequest,
    signal
  });
  console.log("[RESULT]");
  console.log(JSON.stringify(result, null, 2));
  return result;
}
