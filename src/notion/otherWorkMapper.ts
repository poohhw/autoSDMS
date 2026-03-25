/** ERP가 처리 못하는 유니코드 특수문자를 일반 문자로 치환 */
function sanitizeForErp(text: string): string {
  return text
    .replace(/[\u2022\u2023\u25E6\u2043\u2219]/g, "-")   // •, ‣, ◦, ⁃, ∙ → -
    .replace(/[\u2013\u2014]/g, "-")                       // –, — → -
    .replace(/[\u2018\u2019]/g, "'")                       // ', ' → '
    .replace(/[\u201C\u201D]/g, '"')                       // ", " → "
    .replace(/[\u2026]/g, "...")                            // … → ...
    .replace(/[\u00A0]/g, " ")                             // non-breaking space → space
    .replace(/[\u200B\u200C\u200D\uFEFF]/g, "");          // zero-width chars → remove
}

export interface OtherWorkDraft {
  notionPageId: string;
  title: string;
  category: string;
  workComment: string;
  priority?: string;
  status?: string;
  useSolution?: boolean;
  solutionCode?: string;
  addSprint?: boolean;
  workType?: string;
  workDetail?: string;
  pmEmpNumber?: string;
  finishDate: string; // YYYY-MM-DD
  project?: string;
  sdmsCategoryRef?: string;
  progressRate?: string; // 예정률 (예: "100%", "80%")
}

type NotionProperty = Record<string, unknown>;

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function joinPlainText(items: unknown[]): string {
  return items
    .map((item) => {
      if (typeof item !== "object" || item === null) {
        return "";
      }
      const text = (item as Record<string, unknown>)["plain_text"];
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("");
}

function readTitle(prop: NotionProperty): string {
  return joinPlainText(asArray(prop["title"]));
}

function readRichText(prop: NotionProperty): string {
  return joinPlainText(asArray(prop["rich_text"]));
}

function readSelectLike(prop: NotionProperty, key: "select" | "status"): string {
  const value = prop[key];
  if (typeof value !== "object" || value === null) {
    return "";
  }
  const name = (value as Record<string, unknown>)["name"];
  return typeof name === "string" ? name : "";
}

function readDateStart(prop: NotionProperty): string {
  const date = prop["date"];
  if (typeof date !== "object" || date === null) {
    return "";
  }
  const start = (date as Record<string, unknown>)["start"];
  return typeof start === "string" ? start : "";
}

function readNumber(prop: NotionProperty): string {
  const value = prop["number"];
  return typeof value === "number" ? String(value) : "";
}

function readCheckbox(prop: NotionProperty): boolean | undefined {
  const value = prop["checkbox"];
  return typeof value === "boolean" ? value : undefined;
}

function readMultiSelect(prop: NotionProperty): string {
  const values = asArray(prop["multi_select"])
    .map((x) => (typeof x === "object" && x !== null ? (x as Record<string, unknown>)["name"] : null))
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  return values.join(", ");
}

function readRelation(prop: NotionProperty): string {
  const ids = asArray(prop["relation"])
    .map((x) => (typeof x === "object" && x !== null ? (x as Record<string, unknown>)["id"] : null))
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  return ids.join(", ");
}

function readRollup(prop: NotionProperty): string {
  const rollup = prop["rollup"];
  if (typeof rollup !== "object" || rollup === null) {
    return "";
  }
  const type = (rollup as Record<string, unknown>)["type"];

  if (type === "number") {
    const num = (rollup as Record<string, unknown>)["number"];
    return typeof num === "number" ? String(num) : "";
  }

  if (type === "date") {
    const date = (rollup as Record<string, unknown>)["date"];
    if (typeof date === "object" && date !== null) {
      const start = (date as Record<string, unknown>)["start"];
      return typeof start === "string" ? start : "";
    }
    return "";
  }

  if (type === "array") {
    const arr = asArray((rollup as Record<string, unknown>)["array"]);
    const tokens = arr
      .map((entry) => {
        if (typeof entry !== "object" || entry === null) {
          return "";
        }
        const obj = entry as Record<string, unknown>;
        const et = obj["type"];
        if (et === "title") {
          return joinPlainText(asArray(obj["title"]));
        }
        if (et === "rich_text") {
          return joinPlainText(asArray(obj["rich_text"]));
        }
        if (et === "select") {
          return readSelectLike(obj, "select");
        }
        if (et === "status") {
          return readSelectLike(obj, "status");
        }
        if (et === "date") {
          return readDateStart(obj);
        }
        if (et === "number") {
          return readNumber(obj);
        }
        if (et === "relation") {
          return readRelation(obj);
        }
        return "";
      })
      .filter(Boolean);

    return tokens.join(", ");
  }

  return "";
}

function readValue(prop: NotionProperty): string {
  const type = prop["type"];
  switch (type) {
    case "title":
      return readTitle(prop);
    case "rich_text":
      return readRichText(prop);
    case "select":
      return readSelectLike(prop, "select");
    case "status":
      return readSelectLike(prop, "status");
    case "date":
      return readDateStart(prop);
    case "number":
      return readNumber(prop);
    case "multi_select":
      return readMultiSelect(prop);
    case "relation":
      return readRelation(prop);
    case "rollup":
      return readRollup(prop);
    default:
      return "";
  }
}

function pick(properties: Record<string, NotionProperty>, candidates: string[]): string {
  for (const key of candidates) {
    const prop = properties[key];
    if (!prop) {
      continue;
    }
    const value = readValue(prop).trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function pickByContains(properties: Record<string, NotionProperty>, fragments: string[]): string {
  const normalizedFragments = fragments.map((x) => x.replace(/\s+/g, "").toLowerCase());
  for (const [key, prop] of Object.entries(properties)) {
    const normalizedKey = key.replace(/\s+/g, "").toLowerCase();
    if (!normalizedFragments.some((frag) => normalizedKey.includes(frag))) {
      continue;
    }
    const value = readValue(prop).trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function pickCheckbox(properties: Record<string, NotionProperty>, candidates: string[]): boolean | undefined {
  for (const key of candidates) {
    const prop = properties[key];
    if (!prop) {
      continue;
    }
    const value = readCheckbox(prop);
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function findWorkComment(properties: Record<string, NotionProperty>): string {
  const direct = pick(properties, [
    "업무내용",
    "업무 내용",
    "전일 업무내용",
    "전일업무내용",
    "금일 예정업무",
    "금일업무",
    "내용"
  ]);
  if (direct) {
    return direct;
  }

  const byContains = pickByContains(properties, ["업무내용", "전일업무", "금일예정업무", "내용"]);
  if (byContains) {
    return byContains;
  }

  // Last fallback: first non-empty rich_text field that is not obvious metadata.
  for (const [key, prop] of Object.entries(properties)) {
    if (prop.type !== "rich_text") {
      continue;
    }
    if (/제목|카테고리|분류|상태|중요도|담당자|프로젝트|날짜/i.test(key)) {
      continue;
    }
    const text = readRichText(prop).trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function findTitle(properties: Record<string, NotionProperty>): string {
  const direct = pick(properties, ["제목", "Name", "이름", "Aa 제목"]);
  if (direct) {
    return direct;
  }
  for (const prop of Object.values(properties)) {
    if (prop.type === "title") {
      const text = readTitle(prop);
      if (text) {
        return text;
      }
    }
  }
  return "";
}

function toErpDate(rawValue: string): string {
  const raw = rawValue.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }
  if (/^\d{4}\/\d{2}\/\d{2}$/.test(raw)) {
    return raw.replace(/\//g, "-");
  }
  return "";
}

export function mapNotionPagesToOtherWorkDrafts(pages: Array<Record<string, unknown>>): OtherWorkDraft[] {
  const drafts: OtherWorkDraft[] = [];

  for (const page of pages) {
    const properties = (page["properties"] ?? {}) as Record<string, NotionProperty>;

    const category = pick(properties, ["카테고리", "Category"]);
    const ALLOWED_CATEGORIES = ["기타업무", "요구사항"];
    if (!ALLOWED_CATEGORIES.includes(category)) {
      continue;
    }

    const notionPageId = typeof page["id"] === "string" ? page["id"] : "";
    const title = findTitle(properties);
    const workComment = sanitizeForErp(findWorkComment(properties));
    const dateRaw = pick(properties, ["진행일", "날짜", "날짜 ", "Date"]);
    const finishDate = toErpDate(dateRaw);

    if (!title || !workComment || !finishDate) {
      continue;
    }

    drafts.push({
      notionPageId,
      title,
      category,
      workComment,
      project: pick(properties, ["프로젝트", "Project"]),
      priority: pick(properties, ["중요도", "Priority"]),
      status: pick(properties, ["상태", "Status"]),
      sdmsCategoryRef: pick(properties, ["SDMS 분류사전", "분류키워드"]),
      workType: pick(properties, ["분류", "업무 분류"]),
      workDetail: pick(properties, ["분류상세", "업무 분류상세"]),
      useSolution: pickCheckbox(properties, ["솔루션 사용", "솔루션체크", "솔루션 사용 여부"]),
      solutionCode: pick(properties, ["솔루션", "솔루션 코드"]) || pick(properties, ["프로젝트", "Project"]),
      addSprint: pickCheckbox(properties, ["스프린트", "스프린트 체크"]),
      pmEmpNumber: pick(properties, ["담당자", "담당자 사번", "PM"]),
      finishDate,
      progressRate: pick(properties, ["예정률", "예정률(%)", "진행률", "Progress Rate"]) || undefined
    });
  }

  return drafts;
}
