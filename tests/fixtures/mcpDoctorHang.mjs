import { writeFile } from "node:fs/promises";

if (process.env.REA_MCP_DOCTOR_PID_PATH !== undefined)
  await writeFile(process.env.REA_MCP_DOCTOR_PID_PATH, String(process.pid));
if (process.env.REA_MCP_DOCTOR_IGNORE_TERM === "1")
  process.on("SIGTERM", () => undefined);
setInterval(() => undefined, 1_000);
