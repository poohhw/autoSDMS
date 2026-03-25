import { loadNotionEnv } from "./config/env.js";
import { getPreviousBusinessDay, toYmd } from "./domain/businessDay.js";
import { normalizeNotionPage } from "./notion/formatters.js";
import { NotionDailyFetcher } from "./notion/notionClient.js";
import { ensureStartupEnv } from "./runtime/ensureEnv.js";

function parseInputDate(input: string): Date {
  const date = new Date(`${input}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date format: ${input} (example: 2026-03-13)`);
  }
  return date;
}

async function main() {
  const arg = process.argv[2];
  const allMode = arg === "--all";

  if (!arg) {
    console.error("Usage: npm run dev -- YYYY-MM-DD");
    console.error("   or: npm run dev -- --all");
    process.exit(1);
  }

  await ensureStartupEnv();
  const env = loadNotionEnv();
  const fetcher = new NotionDailyFetcher(env);

  if (allMode) {
    console.log("[STEP1] Start Notion fetch: ALL ROWS");
    const allPages = await fetcher.fetchAll();
    const normalized = allPages.map(normalizeNotionPage);
    console.log(
      JSON.stringify(
        {
          total: normalized.length,
          items: normalized
        },
        null,
        2
      )
    );
    return;
  }

  const selectedDate = parseInputDate(arg);
  const dateD = toYmd(selectedDate);
  const dateB = toYmd(getPreviousBusinessDay(selectedDate));

  console.log(`[STEP1] Start Notion fetch: D=${dateD}, B(D)=${dateB}`);

  const [today, yesterday] = await Promise.all([
    fetcher.fetchByDate(dateD),
    fetcher.fetchByDate(dateB)
  ]);

  if (today.pages.length === 0 && yesterday.pages.length === 0) {
    console.log("No work logs found to register.");
    return;
  }

  console.log("[STEP1] Fetch completed");
  console.log(
    JSON.stringify(
      {
        selectedDate: dateD,
        previousBusinessDate: dateB,
        todayCount: today.pages.length,
        yesterdayCount: yesterday.pages.length
      },
      null,
      2
    )
  );

  console.log("\n[D] Today items");
  for (const page of today.pages) {
    console.log(JSON.stringify(normalizeNotionPage(page), null, 2));
  }

  console.log("\n[B(D)] Previous business day items");
  for (const page of yesterday.pages) {
    console.log(JSON.stringify(normalizeNotionPage(page), null, 2));
  }
}

main().catch((error) => {
  console.error("[ERROR]", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
