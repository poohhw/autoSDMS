import { describe, expect, it } from "vitest";
import { getPreviousBusinessDay, toYmd } from "../src/domain/businessDay.js";

describe("getPreviousBusinessDay", () => {
  it("화요일은 월요일 반환", () => {
    const d = new Date("2026-03-10T00:00:00"); // Tue
    expect(toYmd(getPreviousBusinessDay(d))).toBe("2026-03-09");
  });

  it("월요일은 직전 금요일 반환", () => {
    const d = new Date("2026-03-09T00:00:00"); // Mon
    expect(toYmd(getPreviousBusinessDay(d))).toBe("2026-03-06");
  });

  it("주말은 에러", () => {
    const saturday = new Date("2026-03-14T00:00:00");
    expect(() => getPreviousBusinessDay(saturday)).toThrow("Weekend");
  });
});
