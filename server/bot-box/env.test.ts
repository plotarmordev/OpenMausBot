import { describe, expect, it } from "vitest";

import { BOX_ENV_NAMES, BOX_ENV_NEVER, boxEnvironment, boxEnvironmentAllows } from "./env.ts";

describe("the box's environment allow-list", () => {
  it("keeps what an engine needs and drops the server's own settings and the control plane", () => {
    const kept = boxEnvironment({
      PATH: "/usr/bin", HOME: "/data", LANG: "C.UTF-8", TZ: "Europe/Berlin", LC_ALL: "C", TERM: "xterm",
      ANTHROPIC_API_KEY: "sk-ant-1", ANTHROPIC_BASE_URL: "http://127.0.0.1:18080/b/t/anthropic", CLAUDE_CONFIG_DIR: "/data/.claude",
      OPENAI_API_KEY: "sk-1", CODEX_HOME: "/data/.codex", OMB_HOOK_URL: "http://127.0.0.1:8799/api/internal/hook", OMB_COMMS_TOKEN: "cap",
      HTTPS_PROXY: "http://127.0.0.1:3128", NO_PROXY: "127.0.0.1", NPM_CONFIG_LOGLEVEL: "error", ELECTRON_RUN_AS_NODE: "1",
      OMB_CLOUD_BOOTSTRAP_SECRET: "s", OMB_CLOUD_MACHINE_ID: "m", OMB_CLOUD_ADMIN_URL: "https://a", OMB_LICENSE_KEY: "k",
      OMB_DATA_DIR: "/data/.openmausbot", OMB_PORT: "8799", OMB_LOOPBACK_TRUST: "owner", AWS_SECRET_ACCESS_KEY: "aws", SSH_AUTH_SOCK: "/x",
      SOME_RANDOM_NAME: "x", EMPTY: undefined,
    });
    expect(Object.keys(kept).sort()).toEqual([
      "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "ELECTRON_RUN_AS_NODE", "HOME", "HTTPS_PROXY", "LANG", "LC_ALL",
      "NO_PROXY", "NPM_CONFIG_LOGLEVEL", "OMB_COMMS_TOKEN", "OMB_HOOK_URL", "OPENAI_API_KEY", "PATH", "TERM", "TZ",
    ]);
  });

  it("a denied name loses even against an allowing prefix, and the never-list beats everything", () => {
    expect(boxEnvironmentAllows("OMB_COMPOSIO_BROKER_TOKEN")).toBe(true);
    expect(boxEnvironmentAllows("OMB_COMPOSIO_BROKER_TOKEN", new Set(["OMB_COMPOSIO_BROKER_TOKEN"]))).toBe(false);
    for (const name of BOX_ENV_NEVER) expect(boxEnvironmentAllows(name), name).toBe(false);
    expect(boxEnvironmentAllows("OMB_CLOUD_ANYTHING")).toBe(false);
    expect(boxEnvironmentAllows("OMB_CLOUDFLARED_PATH")).toBe(true);
    expect(BOX_ENV_NAMES.has("PATH")).toBe(true);
  });

  it("keeps what Antigravity's runtime is started with: its harness, its file storage switch and the browser hook", () => {
    for (const name of ["ANTIGRAVITY_HARNESS_PATH", "AGY_ACP_FORCE_FILE_STORAGE", "BROWSER", "GEMINI_HOME"]) expect(boxEnvironmentAllows(name), name).toBe(true);
  });

  it("returns a fresh object, never the caller's", () => {
    const source = { PATH: "/usr/bin" };
    const kept = boxEnvironment(source);
    kept.PATH = "/changed";
    expect(source.PATH).toBe("/usr/bin");
  });
});
