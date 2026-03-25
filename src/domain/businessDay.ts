export function getPreviousBusinessDay(input: Date): Date {
  const day = input.getDay(); // 0:Sun, 1:Mon, ..., 6:Sat
  const result = new Date(input);
  result.setHours(0, 0, 0, 0);

  if (day === 1) {
    result.setDate(result.getDate() - 3);
    return result;
  }

  if (day >= 2 && day <= 5) {
    result.setDate(result.getDate() - 1);
    return result;
  }

  // 토요일(6) → 금요일(-1), 일요일(0) → 금요일(-2)
  if (day === 6) {
    result.setDate(result.getDate() - 1);
    return result;
  }
  // day === 0 (Sunday)
  result.setDate(result.getDate() - 2);
  return result;
}

/**
 * 주어진 날짜가 속한 주의 월~금 날짜 배열을 반환한다.
 * 예: 2026-03-18(수) → ["2026-03-16", ..., "2026-03-20"]
 */
export function getWeekdayRange(target: Date): string[] {
  const d = new Date(target);
  d.setHours(0, 0, 0, 0);

  const dow = d.getDay(); // 0:Sun … 6:Sat
  // 월요일까지 되감기 (일요일이면 -6, 토요일이면 -5)
  const diffToMon = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(d);
  monday.setDate(monday.getDate() + diffToMon);

  const dates: string[] = [];
  for (let i = 0; i < 5; i++) {
    const cur = new Date(monday);
    cur.setDate(cur.getDate() + i);
    dates.push(toYmd(cur));
  }
  return dates;
}

/**
 * ISO 8601 기준 주차 번호를 반환한다.
 * (1월 4일이 포함된 주가 제1주)
 */
export function getIsoWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

export function toYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
