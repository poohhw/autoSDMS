import dotenv from "dotenv";
import os from "node:os";
import path from "node:path";

// Electron 앱과 동일한 .env 경로 사용
const userDataEnv = path.join(os.homedir(), "AppData", "Roaming", "autoSDMS", ".env");
dotenv.config({ path: userDataEnv });
console.log(`[TEST] .env 경로: ${userDataEnv}`);

import { bulkCompleteOtherWork } from "./erp/otherWorkCompleter.js";

async function main() {
  const env = {
    COMPANY_ID: process.env.COMPANY_ID || "",
    COMPANY_PASSWORD: process.env.COMPANY_PASSWORD || "",
    COMPANY_LOGIN_URL: "http://erp.gcsc.co.kr/login.aspx",
    EMPLOYEE_NAME: process.env.EMPLOYEE_NAME || "",
  };

  console.log(`[TEST] Employee: ${env.EMPLOYEE_NAME}`);
  const result = await bulkCompleteOtherWork(env, { headed: true });
  console.log("[TEST] RESULT:", JSON.stringify(result, null, 2));
}

main().catch((e) => console.error("[TEST] ERROR:", e.message));
