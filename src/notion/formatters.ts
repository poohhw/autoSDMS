type NotionProperty = Record<string, unknown>;
type NotionPage = Record<string, unknown>;

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

function formatDate(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const start = (value as Record<string, unknown>)["start"];
  const end = (value as Record<string, unknown>)["end"];
  const timeZone = (value as Record<string, unknown>)["time_zone"];
  return JSON.stringify({ start, end, timeZone });
}

function formatPeople(value: unknown): unknown[] {
  return asArray(value).map((p) => {
    if (typeof p !== "object" || p === null) {
      return p;
    }
    const obj = p as Record<string, unknown>;
    return {
      id: obj["id"],
      name: obj["name"],
      type: obj["type"]
    };
  });
}

function formatFiles(value: unknown): unknown[] {
  return asArray(value).map((f) => {
    if (typeof f !== "object" || f === null) {
      return f;
    }
    const obj = f as Record<string, unknown>;
    return {
      name: obj["name"],
      type: obj["type"],
      file: obj["file"],
      external: obj["external"]
    };
  });
}

function formatRelation(value: unknown): unknown[] {
  return asArray(value).map((r) => {
    if (typeof r !== "object" || r === null) {
      return r;
    }
    return (r as Record<string, unknown>)["id"];
  });
}

function readPropertyValue(prop: NotionProperty): unknown {
  const type = prop["type"];
  switch (type) {
    case "title":
      return joinPlainText(asArray(prop["title"]));
    case "rich_text":
      return joinPlainText(asArray(prop["rich_text"]));
    case "select": {
      const select = prop["select"];
      if (typeof select !== "object" || select === null) {
        return null;
      }
      return (select as Record<string, unknown>)["name"] ?? null;
    }
    case "multi_select":
      return asArray(prop["multi_select"])
        .map((x) => (typeof x === "object" && x !== null ? (x as Record<string, unknown>)["name"] : null))
        .filter((x) => x !== null);
    case "status": {
      const status = prop["status"];
      if (typeof status !== "object" || status === null) {
        return null;
      }
      return (status as Record<string, unknown>)["name"] ?? null;
    }
    case "date":
      return formatDate(prop["date"]);
    case "number":
      return prop["number"] ?? null;
    case "checkbox":
      return prop["checkbox"] ?? false;
    case "url":
      return prop["url"] ?? null;
    case "email":
      return prop["email"] ?? null;
    case "phone_number":
      return prop["phone_number"] ?? null;
    case "people":
      return formatPeople(prop["people"]);
    case "files":
      return formatFiles(prop["files"]);
    case "relation":
      return formatRelation(prop["relation"]);
    case "formula":
      return prop["formula"] ?? null;
    case "rollup":
      return prop["rollup"] ?? null;
    case "created_time":
      return prop["created_time"] ?? null;
    case "last_edited_time":
      return prop["last_edited_time"] ?? null;
    case "created_by":
      return prop["created_by"] ?? null;
    case "last_edited_by":
      return prop["last_edited_by"] ?? null;
    default:
      return prop[type as string] ?? null;
  }
}

export interface NormalizedNotionPage {
  id: string;
  createdTime: string | null;
  lastEditedTime: string | null;
  url: string | null;
  properties: Record<string, unknown>;
}

export function normalizeNotionPage(page: NotionPage): NormalizedNotionPage {
  const id = typeof page["id"] === "string" ? page["id"] : "";
  const createdTime = typeof page["created_time"] === "string" ? page["created_time"] : null;
  const lastEditedTime = typeof page["last_edited_time"] === "string" ? page["last_edited_time"] : null;
  const url = typeof page["url"] === "string" ? page["url"] : null;

  const sourceProps = (page["properties"] ?? {}) as Record<string, NotionProperty>;
  const properties: Record<string, unknown> = {};

  for (const [name, prop] of Object.entries(sourceProps)) {
    properties[name] = readPropertyValue(prop);
  }

  return {
    id,
    createdTime,
    lastEditedTime,
    url,
    properties
  };
}

