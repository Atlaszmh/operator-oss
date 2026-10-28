#!/usr/bin/env node
// Tiny client for Operator's service-token surface (/api/internal/agent-tools/*).
//   node op.mjs GET  tasks
//   node op.mjs GET  tasks/<id> [--last=20]     (--last=0 → whole transcript)
//   node op.mjs POST tasks/<id>/messages @body.json   (or an inline JSON string)
// The token is read from SERVICE_TOKEN= in the operator-oss .env, never argv,
// so it stays out of transcripts and shell history.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = args.find((a) => a.startsWith("--last="));
const [method = "GET", route = "", body] = args.filter((a) => a !== flag);
const last = flag ? Number(flag.slice(7)) : 20;

const envFile =
  process.env.OPERATOR_ENV_FILE || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env");
const token = process.env.OPERATOR_SERVICE_TOKEN || fs.readFileSync(envFile, "utf8").match(/^SERVICE_TOKEN=(.*)$/m)?.[1]?.trim();
if (!token) throw new Error(`no SERVICE_TOKEN in ${envFile} (set OPERATOR_ENV_FILE or OPERATOR_SERVICE_TOKEN)`);

const base = (process.env.OPERATOR_URL || "http://localhost:10001").replace(/\/$/, "");
const res = await fetch(`${base}/api/internal/agent-tools/${route.replace(/^\//, "")}`, {
  method,
  headers: { "content-type": "application/json", "x-service-token": token },
  body: body === undefined ? undefined : body.startsWith("@") ? fs.readFileSync(body.slice(1), "utf8") : body,
});
const text = await res.text();
if (!res.headers.get("content-type")?.includes("json")) {
  console.error(`HTTP ${res.status} (non-JSON — wrong URL, or a route this build doesn't have)\n${text.slice(0, 300)}`);
  process.exitCode = 1;
} else {
  // exitCode, not process.exit(): exiting right after fetch trips a libuv assert on Windows.
  const data = JSON.parse(text);
  if (Array.isArray(data.messages) && last > 0 && data.messages.length > last) {
    data.messages_note = `showing last ${last} of ${data.messages.length}; --last=0 for all`;
    data.messages = data.messages.slice(-last);
  }
  console.log(`HTTP ${res.status}`);
  console.log(JSON.stringify(data, null, 2));
  if (!res.ok) process.exitCode = 1;
}
