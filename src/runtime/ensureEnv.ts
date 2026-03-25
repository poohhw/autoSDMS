import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

let ENV_FILE = path.resolve(process.cwd(), ".env");

/** Electron에서 userData 경로로 .env 위치를 변경할 때 사용 */
export function setEnvFilePath(filePath: string): void {
  ENV_FILE = filePath;
}

type PromptKey =
  | "NOTION_ID"
  | "NOTION_PASSWORD"
  | "NOTION_TOKEN"
  | "NOTION_DATABASE_ID"
  | "COMPANY_ID"
  | "COMPANY_PASSWORD"
  | "EMPLOYEE_NAME";

type PromptItem = {
  key: PromptKey;
  label: string;
  hidden?: boolean;
};

const REQUIRED_NOTION_ENV: PromptItem[] = [
  { key: "NOTION_ID", label: "Notion ID(email)" },
  { key: "NOTION_PASSWORD", label: "Notion Password", hidden: true },
  { key: "NOTION_TOKEN", label: "Notion Integration Token" },
  { key: "NOTION_DATABASE_ID", label: "Notion Database ID" }
];

const REQUIRED_COMPANY_ENV: PromptItem[] = [
  { key: "COMPANY_ID", label: "Company ERP ID" },
  { key: "COMPANY_PASSWORD", label: "Company ERP Password", hidden: true },
  { key: "EMPLOYEE_NAME", label: "직원 이름 (ERP 검색용, 예: 홍길동)" }
];

const MANAGED_KEYS = new Set([...REQUIRED_NOTION_ENV, ...REQUIRED_COMPANY_ENV].map((x) => x.key));

function formatEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) {
    return value;
  }
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

export function readEnvObject(): Record<string, string> {
  const fromFile = fs.existsSync(ENV_FILE)
    ? dotenv.parse(fs.readFileSync(ENV_FILE, "utf8"))
    : {};

  const fromRuntime: Record<string, string> = {};
  for (const key of MANAGED_KEYS) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim()) {
      fromRuntime[key] = value;
    }
  }

  return {
    ...fromFile,
    ...fromRuntime
  };
}

export function writeEnvObject(values: Record<string, string>): void {
  const sorted = Object.keys(values).sort((a, b) => a.localeCompare(b));
  const lines = sorted.map((key) => `${key}=${formatEnvValue(values[key])}`);
  fs.writeFileSync(ENV_FILE, `${lines.join("\n")}\n`, "utf8");
}

async function askVisible(question: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function askHidden(question: string): Promise<string> {
  if (!input.isTTY || !output.isTTY) {
    return askVisible(question);
  }

  return new Promise((resolve, reject) => {
    let answer = "";

    const cleanup = () => {
      input.off("data", onData);
      if (typeof input.setRawMode === "function") {
        input.setRawMode(false);
      }
      input.pause();
    };

    const onData = (chunk: Buffer | string) => {
      const text = chunk.toString("utf8");

      for (const ch of text) {
        if (ch === "\r" || ch === "\n") {
          output.write("\n");
          cleanup();
          resolve(answer.trim());
          return;
        }

        if (ch === "\u0003") {
          cleanup();
          reject(new Error("Input cancelled by user."));
          return;
        }

        if (ch === "\u0008" || ch === "\u007f") {
          if (answer.length > 0) {
            answer = answer.slice(0, -1);
          }
          continue;
        }

        answer += ch;
      }
    };

    output.write(question);
    if (typeof input.setRawMode === "function") {
      input.setRawMode(true);
    }
    input.resume();
    input.on("data", onData);
  });
}

async function ensurePromptedValues(items: PromptItem[]): Promise<void> {
  const current = readEnvObject();
  const missing = items.filter(({ key }) => !current[key]?.trim());

  if (missing.length === 0) {
    dotenv.config({ path: ENV_FILE, override: true });
    return;
  }

  const updates: Record<string, string> = {};
  for (const item of missing) {
    let answer = "";
    while (!answer.trim()) {
      answer = item.hidden
        ? await askHidden(`Enter ${item.label}: `)
        : await askVisible(`Enter ${item.label}: `);
    }
    updates[item.key] = answer.trim();
  }

  const merged = {
    ...current,
    ...updates
  };

  writeEnvObject(merged);
  dotenv.config({ path: ENV_FILE, override: true });
}

export async function ensureNotionEnv(): Promise<void> {
  await ensurePromptedValues(REQUIRED_NOTION_ENV);
}

export async function ensureCompanyEnv(): Promise<void> {
  await ensurePromptedValues(REQUIRED_COMPANY_ENV);
}

export async function ensureStartupEnv(): Promise<void> {
  await ensureNotionEnv();
  await ensureCompanyEnv();
}

