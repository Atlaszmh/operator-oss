// The wizard's and Settings → Agents' "Connect Gemini" flow, built on
// @google/gemini-cli's Google OAuth login (`oauth-personal` / Code Assist)
// and Google One AI Credits (`GOOGLE_ONE_AI` overage credits).
//
// How Gemini subscription + AI Credits work in headless mode:
//   1. Credentials live in `~/.gemini/oauth_creds.json` (with the active email
//      in `~/.gemini/google_accounts.json`) and settings in `~/.gemini/settings.json`.
//   2. Setting `security.auth.selectedType: "oauth-personal"` (and `GOOGLE_GENAI_USE_GCA=true`
//      in env) selects the user's Google subscription login over API-key billing.
//   3. Setting `billing.overageStrategy: "always"` in `~/.gemini/settings.json`
//      enables `shouldAutoUseCredits` inside Gemini CLI's `CodeAssistServer`, so
//      eligible models (`gemini-3.1-pro-preview`, `gemini-3-pro-preview`,
//      `gemini-3-flash-preview`) automatically attach `enabledCreditTypes: ["GOOGLE_ONE_AI"]`
//      and draw from the user's Google One AI Credits in non-interactive turns
//      instead of failing when standard tier quota is reached.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn as ptySpawn, type IPty } from "node-pty";
import { GEMINI_CLI_PATH } from "../../config";
import { hasGeminiKey, looksLikeGeminiKey, setGeminiKey, clearGeminiKey } from "../../gemini-key";
import type {
  AgentApiKeyAuth,
  AgentAuthStatus,
  AgentLoginSession,
  AgentVerifyResult,
} from "../types";

const run = promisify(execFile);

/** Resolve the `gemini` CLI binary path. */
export function resolveGeminiBinary(): string {
  if (GEMINI_CLI_PATH) return GEMINI_CLI_PATH;
  const localBin = path.join(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? "gemini.cmd" : "gemini",
  );
  if (fs.existsSync(localBin)) return localBin;
  return "gemini";
}

function geminiHomeDir(): string {
  return process.env.GEMINI_CLI_HOME || os.homedir();
}

export function geminiConfigDir(): string {
  return path.join(geminiHomeDir(), ".gemini");
}

function oauthCredsPath(): string {
  return path.join(geminiConfigDir(), "oauth_creds.json");
}

function googleAccountsPath(): string {
  return path.join(geminiConfigDir(), "google_accounts.json");
}

function settingsPath(): string {
  return path.join(geminiConfigDir(), "settings.json");
}

/**
 * Ensure `~/.gemini/settings.json` is configured for:
 *   - Google subscription auth (`security.auth.selectedType: "oauth-personal"`)
 *   - Automatic Google One AI Credits usage (`billing.overageStrategy: "always"`)
 *   - Excluding Gemini CLI's built-in interactive-only `ask_user` tool so the
 *     model calls Operator's stdio MCP `ask_user` tool (`mcp_orchestrator_ask_user`)
 *   - Registering Operator's `orchestrator` stdio MCP server (`scripts/orch-mcp.mjs`)
 *     with `${ORCH_*}` env placeholders that Gemini CLI expands per child process.
 */
export function ensureGeminiSettings(): void {
  const dir = geminiConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = settingsPath();

  let current: Record<string, unknown> = {};
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        current = parsed as Record<string, unknown>;
      }
    }
  } catch {
    current = {};
  }

  const security =
    current.security && typeof current.security === "object" && !Array.isArray(current.security)
      ? (current.security as Record<string, unknown>)
      : {};
  const auth =
    security.auth && typeof security.auth === "object" && !Array.isArray(security.auth)
      ? (security.auth as Record<string, unknown>)
      : {};

  const billing =
    current.billing && typeof current.billing === "object" && !Array.isArray(current.billing)
      ? (current.billing as Record<string, unknown>)
      : {};

  const tools =
    current.tools && typeof current.tools === "object" && !Array.isArray(current.tools)
      ? (current.tools as Record<string, unknown>)
      : {};
  const existingExclude = Array.isArray(tools.exclude)
    ? (tools.exclude as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const exclude = existingExclude.includes("ask_user")
    ? existingExclude
    : [...existingExclude, "ask_user"];

  const mcpServers =
    current.mcpServers && typeof current.mcpServers === "object" && !Array.isArray(current.mcpServers)
      ? (current.mcpServers as Record<string, unknown>)
      : {};

  const updated: Record<string, unknown> = {
    ...current,
    security: {
      ...security,
      auth: {
        ...auth,
        selectedType: hasGeminiKey() ? "gemini-api-key" : "oauth-personal",
      },
    },
    billing: {
      ...billing,
      // Always allow eligible Gemini 3 / 3.1 models to use Google One AI Credits
      // (`GOOGLE_ONE_AI`) automatically in headless mode without blocking on a prompt.
      overageStrategy: (billing.overageStrategy as string) === "never" ? "never" : "always",
    },
    tools: {
      ...tools,
      exclude,
    },
    mcpServers: {
      ...mcpServers,
      orchestrator: {
        command: "${ORCH_NODE_BIN}",
        args: ["${ORCH_MCP_SCRIPT}"],
        timeout: 86_400_000,
        env: {
          ORCH_TASK_ID: "${ORCH_TASK_ID}",
          ORCH_PROJECT_ID: "${ORCH_PROJECT_ID}",
          ORCH_BASE_URL: "${ORCH_BASE_URL}",
          SERVICE_TOKEN: "${SERVICE_TOKEN}",
        },
        trust: true,
      },
    },
  };

  try {
    fs.writeFileSync(file, JSON.stringify(updated, null, 2) + "\n", { mode: 0o600 });
  } catch {
    // Read-only filesystem in synthetic test environments — ignore.
  }
}

function readStoredOauthCreds(): { hasTokens: boolean; email: string | null } {
  let hasTokens = false;
  try {
    const raw = fs.readFileSync(oauthCredsPath(), "utf8");
    const parsed = JSON.parse(raw) as { refresh_token?: string; access_token?: string };
    hasTokens = Boolean(parsed && (parsed.refresh_token || parsed.access_token));
  } catch {
    hasTokens = false;
  }

  let email: string | null = null;
  try {
    const raw = fs.readFileSync(googleAccountsPath(), "utf8");
    const parsed = JSON.parse(raw) as { active?: string | null };
    if (parsed && typeof parsed.active === "string" && parsed.active.trim()) {
      email = parsed.active.trim();
    }
  } catch {
    email = null;
  }

  return { hasTokens, email };
}

/** Build the child-process environment for Gemini CLI invocations. */
export function buildGeminiEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Skip the outer relaunch wrapper so Gemini CLI runs in a single Node process
  // without spawning a child with --max-old-space-size=50% of host RAM.
  env.GEMINI_CLI_NO_RELAUNCH = "1";

  if (hasGeminiKey()) {
    env.GEMINI_CLI_AUTH_OVERRIDE = "gemini-api-key";
  } else {
    // Subscription login via Google Code Assist / Google One AI Pro & Credits.
    env.GOOGLE_GENAI_USE_GCA = "true";
    env.GEMINI_CLI_AUTH_OVERRIDE = "oauth-personal";
  }

  if (extra) {
    Object.assign(env, extra);
  }
  return env;
}

const stripAnsi = (s: string) =>
  s
    .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
    .replace(/\u001b[78]/g, "")
    .replace(/\u001b/g, "");

const TERM_QUERY = /\u001b(\]11;\?|\[6n|\[999;999f)/g;
function answerTermQueries(proc: IPty, chunk: string, size: { rows: number; cols: number }) {
  let sizeProbe = false;
  for (const m of chunk.matchAll(TERM_QUERY)) {
    if (m[1] === "]11;?") proc.write("\u001b]11;rgb:1e1e/1e1e/1e1e\u001b\\");
    else if (m[1] === "[999;999f") sizeProbe = true;
    else {
      proc.write(sizeProbe ? `\u001b[${size.rows};${size.cols}R` : "\u001b[1;1R");
      sizeProbe = false;
    }
  }
}

// ---------- status + verify ----------

export const geminiApiKey: AgentApiKeyAuth = {
  hint: "AIza…",
  looksValid: looksLikeGeminiKey,
  has: hasGeminiKey,
  set: (key: string) => {
    setGeminiKey(key);
    ensureGeminiSettings();
  },
  clear: () => {
    clearGeminiKey();
    ensureGeminiSettings();
  },
};

export async function geminiStatus(): Promise<AgentAuthStatus> {
  if (hasGeminiKey()) {
    return {
      authenticated: true,
      method: "Gemini API key",
      email: null,
      plan: "API",
      error: null,
    };
  }

  const { hasTokens, email } = readStoredOauthCreds();
  if (hasTokens) {
    ensureGeminiSettings();
    return {
      authenticated: true,
      method: "Google account (AI Credits enabled)",
      email,
      plan: "Google AI / Credits",
      error: null,
    };
  }

  // Verify the CLI binary is installed so we report a helpful message if missing.
  try {
    await run(resolveGeminiBinary(), ["--version"], {
      timeout: 15_000,
      env: buildGeminiEnv(),
    });
    return {
      authenticated: false,
      method: null,
      email: null,
      plan: null,
      error: "not logged in",
    };
  } catch (e) {
    const err = e as { code?: string };
    if (err.code === "ENOENT") {
      return {
        authenticated: false,
        method: null,
        email: null,
        plan: null,
        error: "the gemini CLI isn't installed in this workspace",
      };
    }
    return {
      authenticated: false,
      method: null,
      email: null,
      plan: null,
      error: "not logged in",
    };
  }
}

/**
 * One-shot test turn through the `gemini` CLI binary, proving the subscription
 * or API key connection actually produces output.
 */
export async function verifyGeminiTurn(): Promise<AgentVerifyResult> {
  ensureGeminiSettings();
  try {
    const { stdout } = await run(
      resolveGeminiBinary(),
      [
        "-p",
        "Reply with exactly: OK",
        "--output-format",
        "text",
        "--approval-mode",
        "plan",
        "--allowed-mcp-server-names",
        "none",
      ],
      {
        timeout: 90_000,
        env: buildGeminiEnv(),
        maxBuffer: 4 * 1024 * 1024,
        cwd: os.homedir(),
      },
    );
    const out = stripAnsi(stdout).trim();
    return {
      ok: out.length > 0,
      output: out,
      error: out.length > 0 ? null : "the test turn returned no output",
    };
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    const msg = stripAnsi(err.stderr || err.stdout || err.message || "test turn failed").trim();
    return { ok: false, output: "", error: msg };
  }
}

// ---------- paste-code OAuth login session ----------

interface LoginState extends AgentLoginSession {
  proc: IPty | null;
  buf: string;
  timer: ReturnType<typeof setTimeout> | null;
}

const SIZE = { rows: 50, cols: 220 };
const g = globalThis as unknown as { __orchGeminiLogin?: LoginState };

const tail = (buf: string) => buf.split("\n").slice(-14).join("\n").trim();

const publicView = (st: LoginState): AgentLoginSession => ({
  status: st.status,
  url: st.url,
  email: st.email,
  plan: st.plan,
  error: st.error,
  log: tail(st.buf),
});

export function getGeminiLogin(): AgentLoginSession | null {
  return g.__orchGeminiLogin ? publicView(g.__orchGeminiLogin) : null;
}

export function cancelGeminiLogin(): void {
  const st = g.__orchGeminiLogin;
  if (!st) return;
  if (st.timer) clearTimeout(st.timer);
  try {
    st.proc?.kill();
  } catch {}
  delete g.__orchGeminiLogin;
}

/**
 * Start (or rejoin) the headless Google OAuth login (`NO_BROWSER=true`).
 * Gemini CLI prints a Google OAuth URL (`https://accounts.google.com/o/oauth2/v2/auth?...`)
 * that redirects to `https://codeassist.google.com/authcode` and waits on
 * `Enter the authorization code:`.
 */
export async function startGeminiLogin(): Promise<AgentLoginSession> {
  const cur = g.__orchGeminiLogin;
  if (
    cur &&
    (cur.status === "starting" || cur.status === "awaiting" || cur.status === "submitting")
  ) {
    return awaitUrl();
  }
  cancelGeminiLogin();

  ensureGeminiSettings();
  // Remove any prior oauth_creds.json so launching Gemini CLI triggers the
  // interactive OAuth paste-code prompt immediately.
  try {
    fs.rmSync(oauthCredsPath(), { force: true });
  } catch {}

  const st: LoginState = {
    status: "starting",
    url: null,
    email: null,
    plan: null,
    error: null,
    log: "",
    proc: null,
    buf: "",
    timer: null,
  };
  g.__orchGeminiLogin = st;

  try {
    st.proc = ptySpawn(resolveGeminiBinary(), [], {
      name: "xterm-256color",
      cols: SIZE.cols,
      rows: SIZE.rows,
      cwd: os.homedir(),
      env: buildGeminiEnv({
        NO_BROWSER: "true",
        BROWSER: "false",
        GOOGLE_GENAI_USE_GCA: "true",
        GEMINI_CLI_AUTH_OVERRIDE: "oauth-personal",
      }) as Record<string, string>,
    });
  } catch (e) {
    st.status = "error";
    st.error = `could not start gemini: ${e instanceof Error ? e.message : String(e)}`;
    return publicView(st);
  }

  st.timer = setTimeout(() => {
    if (st.status !== "success") {
      st.status = "error";
      st.error = "login timed out — start again to get a fresh link";
      try {
        st.proc?.kill();
      } catch {}
    }
  }, 15 * 60_000);

  st.proc.onData((chunk) => {
    if (st.proc) answerTermQueries(st.proc, chunk, SIZE);
    if (st.status === "success" || st.status === "error") return;
    st.buf += stripAnsi(chunk);

    if (!st.url) {
      const m = st.buf.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/[^\s"']+/i);
      if (m) {
        st.url = m[0].replace(/[).,]+$/, "");
        st.status = "awaiting";
      }
    }

    if (st.status === "submitting") {
      const { hasTokens } = readStoredOauthCreds();
      if (hasTokens || /Authenticated|logged in|Type your message/i.test(st.buf)) {
        void finishSuccess(st);
      } else if (/Failed to authenticate|invalid_grant|Invalid code|Error authenticating/i.test(st.buf)) {
        st.status = "error";
        st.error = "that authorization code didn't work — start again to get a fresh link";
      }
    }
  });

  st.proc.onExit(({ exitCode }) => {
    if (st.timer) clearTimeout(st.timer);
    if (st.status === "success") return;
    const { hasTokens } = readStoredOauthCreds();
    if (hasTokens || st.status === "submitting" || exitCode === 0) {
      void finishSuccess(st);
      return;
    }
    st.status = "error";
    const last = st.buf
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/visit|http|authorization code/i.test(l))
      .slice(-3)
      .join(" · ");
    st.error = last || `gemini login exited with code ${exitCode}`;
  });

  return awaitUrl();
}

/** Hand the pasted Google authorization code to the waiting Gemini CLI prompt. */
export async function submitGeminiCode(code: string): Promise<AgentLoginSession> {
  const st = g.__orchGeminiLogin;
  if (!st || !st.proc) {
    return {
      status: "error",
      url: null,
      email: null,
      plan: null,
      error: "no login in progress",
      log: "",
    };
  }
  const clean = code.trim();
  if (!clean) return publicView(st);
  st.status = "submitting";
  st.proc.write(`${clean}\r`);

  const deadline = Date.now() + 15_000;
  while (st.status === "submitting" && Date.now() < deadline) {
    const { hasTokens } = readStoredOauthCreds();
    if (hasTokens) {
      await finishSuccess(st);
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return publicView(st);
}

async function finishSuccess(st: LoginState) {
  if (st.status === "success") return;
  const s = await geminiStatus();
  if (s.authenticated) {
    st.status = "success";
    st.email = s.email;
    st.plan = s.plan;
    if (st.timer) clearTimeout(st.timer);
    try {
      st.proc?.kill();
    } catch {}
  } else if (st.status === "submitting") {
    st.status = "error";
    st.error = s.error || "login did not complete — please try again";
  }
}

async function awaitUrl(): Promise<AgentLoginSession> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const st = g.__orchGeminiLogin;
    if (!st) {
      return {
        status: "error",
        url: null,
        email: null,
        plan: null,
        error: "login session vanished",
        log: "",
      };
    }
    if (st.status !== "starting" || Date.now() > deadline) return publicView(st);
    await new Promise((r) => setTimeout(r, 150));
  }
}
