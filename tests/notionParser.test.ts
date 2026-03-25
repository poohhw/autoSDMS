import { describe, expect, it } from "vitest";
import { parseNotionRows } from "../src/domain/notionParser.js";

describe("parseNotionRows", () => {
  it("정상 파싱", () => {
    const parsed = parseNotionRows([
      {
        date: "2026-03-13",
        title: "로그인 기능 개선",
        category: "요구사항",
        content: "폼 검증 처리",
        progress: "80%",
        expectedProgress: "100%"
      }
    ]);

    expect(parsed[0].title).toBe("로그인 기능 개선");
    expect(parsed[0].category).toBe("요구사항");
  });

  it("카테고리 분기: 기타업무 허용", () => {
    const parsed = parseNotionRows([
      {
        date: "2026-03-13",
        title: "사내 회의",
        category: "기타업무",
        content: "주간 공유"
      }
    ]);
    expect(parsed[0].category).toBe("기타업무");
  });

  it("지원하지 않는 카테고리 거부", () => {
    expect(() =>
      parseNotionRows([
        {
          date: "2026-03-13",
          title: "테스트",
          category: "개인업무",
          content: "내용"
        }
      ])
    ).toThrow("지원하지 않는 카테고리");
  });
});

