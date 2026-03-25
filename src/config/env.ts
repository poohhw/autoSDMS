import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const fullSchema = z.object({
  NOTION_ID: z.string().min(1),
  NOTION_PASSWORD: z.string().min(1),
  NOTION_TOKEN: z.string().min(1),
  NOTION_DATABASE_ID: z.string().min(1),
  COMPANY_ID: z.string().min(1),
  COMPANY_PASSWORD: z.string().min(1),
  COMPANY_LOGIN_URL: z.string().url().default("http://erp.gcsc.co.kr/login.aspx"),
  COMPANY_MAIN_URL: z.string().url().default("http://erp.gcsc.co.kr/Agile/main.aspx"),
  EMPLOYEE_NAME: z.string().min(1)
});

const notionSchema = z.object({
  NOTION_ID: z.string().min(1),
  NOTION_PASSWORD: z.string().min(1),
  NOTION_TOKEN: z.string().min(1),
  NOTION_DATABASE_ID: z.string().min(1)
});

const companySchema = z.object({
  COMPANY_ID: z.string().min(1),
  COMPANY_PASSWORD: z.string().min(1),
  COMPANY_LOGIN_URL: z.string().url().default("http://erp.gcsc.co.kr/login.aspx"),
  COMPANY_MAIN_URL: z.string().url().default("http://erp.gcsc.co.kr/Agile/main.aspx"),
  EMPLOYEE_NAME: z.string().min(1)
});

export type Env = z.infer<typeof fullSchema>;
export type NotionEnv = z.infer<typeof notionSchema>;
export type CompanyEnv = z.infer<typeof companySchema>;

export function loadEnv(): Env {
  const parsed = fullSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Environment validation failed\n${details}`);
  }
  return parsed.data;
}

export function loadNotionEnv(): NotionEnv {
  const parsed = notionSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Notion env validation failed\n${details}`);
  }
  return parsed.data;
}

export function loadCompanyEnv(): CompanyEnv {
  const parsed = companySchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Company env validation failed\n${details}`);
  }
  return parsed.data;
}

