/**
 * 기타업무 등록만 단독으로 테스트하는 스크립트.
 * 업무일지(business.aspx)와 일일스크럼 등록은 실행하지 않습니다.
 *
 * 사용법:
 *   npx tsx src/testOtherWork.ts 2026-04-04 --headed
 *   npx tsx src/testOtherWork.ts --headed          (오늘 날짜)
 *   npx tsx src/testOtherWork.ts 2026-04-04 --dry-run
 */
import os from "node:os";
import path from "node:path";
import { loadCompanyEnv, loadNotionEnv } from "./config/env.js";
import { toYmd } from "./domain/businessDay.js";
import { ErpOtherWorkRegistrar } from "./erp/otherWorkRegistrar.js";
import { NotionDailyFetcher } from "./notion/notionClient.js";
import { mapNotionPagesToOtherWorkDrafts } from "./notion/otherWorkMapper.js";
import { ensureStartupEnv, setEnvFilePath } from "./runtime/ensureEnv.js";

// Electron 앱과 동일한 .env 경로 사용 (%APPDATA%\autoSDMS\.env)
const userDataEnv = path.join(os.homedir(), "AppData", "Roaming", "autoSDMS", ".env");
setEnvFilePath(userDataEnv);
console.log(`[TEST] .env 경로: ${userDataEnv}`);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const headed = args.includes("--headed");
  const dateArg = args.find((x) => !x.startsWith("--"));
  const dateYmd = dateArg ?? toYmd(new Date());

  await ensureStartupEnv();

  const notionEnv = loadNotionEnv();
  const companyEnv = loadCompanyEnv();

  console.log(`[TEST] 날짜: ${dateYmd}, headed: ${headed}, dry-run: ${dryRun}`);

  // 1. Notion에서 해당 날짜 데이터 조회
  const notion = new NotionDailyFetcher(notionEnv);
  const dayData = await notion.fetchByDate(dateYmd);

  // 2. OtherWorkDraft로 변환
  const drafts = mapNotionPagesToOtherWorkDrafts(dayData.pages);

  // 3. Relation ID → 제목 변환
  const relationIds = drafts.map((i) => i.sdmsCategoryRef).filter((x): x is string => !!x);
  if (relationIds.length > 0) {
    const titleMap = await notion.resolveRelationIds(relationIds);
    for (const item of drafts) {
      if (item.sdmsCategoryRef && titleMap.has(item.sdmsCategoryRef)) {
        item.sdmsCategoryRef = titleMap.get(item.sdmsCategoryRef) || item.sdmsCategoryRef;
      }
    }
  }

  const otherWorkItems = drafts.filter((x) => x.category === "기타업무");

  if (otherWorkItems.length === 0) {
    console.log(`[TEST] ${dateYmd} 에 기타업무 항목이 없습니다.`);
    return;
  }

  console.log(`[TEST] 기타업무 항목 ${otherWorkItems.length}개:`);
  for (const item of otherWorkItems) {
    console.log(`  - "${item.title}" / 첨부: ${item.attachments?.length ?? 0}개`);
    if (item.attachments?.length) {
      for (const att of item.attachments) {
        console.log(`      📎 ${att.name}`);
      }
    }
  }

  if (dryRun) {
    console.log("[TEST] --dry-run 모드: ERP 등록을 건너뜁니다.");
    return;
  }

  // 4. 기타업무만 등록 (업무일지/스크럼 스킵, 스프린트 백로그는 포함)
  const registrar = new ErpOtherWorkRegistrar(companyEnv, { headed });
  const result = await registrar.register(otherWorkItems, { dateYmd });

  console.log("[TEST] 결과:", JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error("[TEST] ERROR:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
