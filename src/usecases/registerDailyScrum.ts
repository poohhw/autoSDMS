import { getPreviousBusinessDay, toYmd } from "../domain/businessDay.js";
import type { RegisterResult } from "../domain/types.js";
import type { ArtifactLogger, DailyScrumUseCase, ErpGateway, NotionGateway } from "./ports.js";

export class RegisterDailyScrumService implements DailyScrumUseCase {
  constructor(
    private readonly notion: NotionGateway,
    private readonly erp: ErpGateway,
    private readonly logger: ArtifactLogger
  ) {}

  async execute(dateYmd: string): Promise<RegisterResult> {
    const d = new Date(`${dateYmd}T00:00:00`);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`유효하지 않은 날짜 형식입니다: ${dateYmd}`);
    }

    const yesterdayYmd = toYmd(getPreviousBusinessDay(d));
    await this.logger.stepLog("fetch", `Notion 조회 시작 D=${dateYmd}, B(D)=${yesterdayYmd}`);

    const [todayItems, yesterdayItems] = await Promise.all([
      this.notion.fetchByDate(dateYmd),
      this.notion.fetchByDate(yesterdayYmd)
    ]);

    if (todayItems.length === 0 && yesterdayItems.length === 0) {
      throw new Error("등록할 업무일지가 없습니다.");
    }

    await this.erp.login();
    await this.logger.stepLog("erp", "ERP 로그인 완료");

    let success = 0;
    const failures: RegisterResult["failures"] = [];

    // 전일 업무는 이미 생성된 기타업무를 기준으로 등록만 진행한다.
    for (const item of yesterdayItems) {
      try {
        const exists = await this.erp.isAlreadyRegistered(yesterdayYmd, item.title, "전일");
        if (exists) {
          await this.logger.stepLog("dedupe", `전일 중복 건너뜀: ${item.title}`);
          continue;
        }

        await this.erp.registerYesterday(item, yesterdayYmd);
        success += 1;
      } catch (error) {
        failures.push({ title: item.title, reason: `${error}` });
        await this.logger.stepError("register-yesterday", error);
        await this.logger.screenshot("register-yesterday");
      }
    }

    // 금일 업무는 기타업무 카테고리일 때 선행 생성 후 등록한다.
    for (const item of todayItems) {
      try {
        const exists = await this.erp.isAlreadyRegistered(dateYmd, item.title, "금일");
        if (exists) {
          await this.logger.stepLog("dedupe", `금일 중복 건너뜀: ${item.title}`);
          continue;
        }

        if (item.category === "기타업무") {
          await this.erp.ensureEtcTask(item, dateYmd);
        }
        await this.erp.registerToday(item, dateYmd);
        success += 1;
      } catch (error) {
        failures.push({ title: item.title, reason: `${error}` });
        await this.logger.stepError("register-today", error);
        await this.logger.screenshot("register-today");
      }
    }

    const total = todayItems.length + yesterdayItems.length;
    return {
      total,
      success,
      failed: failures.length,
      failures
    };
  }
}

