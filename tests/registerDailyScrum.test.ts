import { describe, expect, it, vi } from "vitest";
import { RegisterDailyScrumService } from "../src/usecases/registerDailyScrum.js";
import type { ArtifactLogger, ErpGateway, NotionGateway } from "../src/usecases/ports.js";

function makeLogger(): ArtifactLogger {
  return {
    stepLog: vi.fn(async () => undefined),
    stepError: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => undefined)
  };
}

describe("RegisterDailyScrumService", () => {
  it("기타업무 선행 생성은 금일 등록에서만 수행", async () => {
    const notion: NotionGateway = {
      fetchByDate: vi
        .fn()
        .mockResolvedValueOnce([
          {
            date: "2026-03-10",
            title: "금일-기타",
            category: "기타업무",
            content: "금일 내용",
            progress: "0%",
            expectedProgress: "50%"
          }
        ])
        .mockResolvedValueOnce([
          {
            date: "2026-03-09",
            title: "전일-기타",
            category: "기타업무",
            content: "전일 내용",
            progress: "100%",
            expectedProgress: "100%"
          }
        ])
    };

    const erp: ErpGateway = {
      login: vi.fn(async () => undefined),
      ensureEtcTask: vi.fn(async () => undefined),
      registerYesterday: vi.fn(async () => undefined),
      registerToday: vi.fn(async () => undefined),
      isAlreadyRegistered: vi.fn(async () => false)
    };

    const service = new RegisterDailyScrumService(notion, erp, makeLogger());
    await service.execute("2026-03-10");

    expect(erp.ensureEtcTask).toHaveBeenCalledTimes(1);
    expect(erp.ensureEtcTask).toHaveBeenCalledWith(
      expect.objectContaining({ title: "금일-기타" }),
      "2026-03-10"
    );
    expect(erp.registerYesterday).toHaveBeenCalledTimes(1);
    expect(erp.registerToday).toHaveBeenCalledTimes(1);
  });
});

