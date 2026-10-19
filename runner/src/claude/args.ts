// claude -p の起動引数と、セッションごとの settings.json の組み立て（DESIGN-v2 6.1・7.1・7.2）。
// 三重の守り: --tools（道具を無くす）・許可/拒否のルール・Seatbelt のサンドボックス。
// 本人の設定は丸ごとは読ませない（--setting-sources "" --strict-mcp-config、disableAllHooks）。--bare は使わない（サブスクの OAuth を読まない）。
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { turnJsonSchema } from "@baton/shared";
import {
  COMMON_DENY,
  ROLE_ALLOW,
  ROLE_TOOLS,
  SANDBOX_ALLOWED_DOMAINS,
  SANDBOX_ALLOW_WRITE,
  SANDBOX_DENY_READ,
  memberEditRule,
  type ClaudeRole,
} from "./permissions.ts";

export type LaunchSpec = {
  role: ClaudeRole;
  sessionId: string;
  /** true は --resume、false は --session-id（D-44） */
  resume: boolean;
  cwd: string;
  addDirs: string[];
  model: string;
  /** COO は sonnet に退避（5.9） */
  fallbackModel: string | null;
  maxTurns: number;
  maxBudgetUsd: number;
  systemPrompt: string;
  pluginDir: string | null;
  /** スキルがあるプロファイル（Skill の道具を足す） */
  hasSkills: boolean;
  settingsPath: string;
  /** 1 回限りの許可ルール（承認の時間切れのあと CEO が許可したもの。7.6） */
  oneTimeAllow: string[];
  /** メンバーの Bash の追加の許可（BATON_EXTRA_BASH_ALLOW） */
  extraAllow: string[];
  name: string;
};

export type SandboxSettings = {
  disableAllHooks: true;
  permissions: { deny: string[] };
  sandbox?: {
    enabled: boolean;
    autoAllowBashIfSandboxed: boolean;
    allowUnsandboxedCommands: boolean;
    failIfUnavailable: boolean;
    filesystem: { allowWrite: string[]; denyWrite: string[]; denyRead: string[] };
    network: { strictAllowlist: boolean; allowedDomains: string[] };
  };
};

/** settings.json の中身（7.2）。COO は Bash が無いのでサンドボックスを付けない */
export function buildSettings(input: { role: ClaudeRole; denyWrite?: string[]; extraDomains?: string[] }): SandboxSettings {
  const base: SandboxSettings = { disableAllHooks: true, permissions: { deny: [...COMMON_DENY] } };
  if (input.role === "coo") return base;
  return {
    ...base,
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      filesystem: {
        allowWrite: input.role === "member" ? [...SANDBOX_ALLOW_WRITE] : [],
        denyWrite: input.role === "leader" ? [...(input.denyWrite ?? [])] : [],
        denyRead: [...SANDBOX_DENY_READ],
      },
      network: {
        strictAllowlist: true,
        allowedDomains: [...new Set([...SANDBOX_ALLOWED_DOMAINS, ...(input.extraDomains ?? [])])],
      },
    },
  };
}

export async function writeSettings(settingsPath: string, settings: SandboxSettings): Promise<void> {
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
}

export function toolsFor(role: ClaudeRole, hasSkills: boolean): string[] {
  return [...ROLE_TOOLS[role], ...(hasSkills && role === "member" ? ["Skill"] : [])];
}

export function allowFor(spec: Pick<LaunchSpec, "role" | "cwd" | "hasSkills" | "oneTimeAllow" | "extraAllow">): string[] {
  const allow = [...ROLE_ALLOW[spec.role]];
  if (spec.role === "member") {
    allow.push(memberEditRule(spec.cwd));
    allow.push(...spec.extraAllow.map((c) => (/^\w+\(.*\)$/.test(c) ? c : `Bash(${c})`)));
    if (spec.hasSkills) allow.push("Skill");
  }
  allow.push(...spec.oneTimeAllow);
  return [...new Set(allow)];
}

/** claude に渡す argv（実行ファイルの名前は含めない） */
export function buildArgs(spec: LaunchSpec): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--input-format",
    "stream-json",
    "--model",
    spec.model,
  ];
  if (spec.fallbackModel && spec.fallbackModel !== spec.model) args.push("--fallback-model", spec.fallbackModel);
  args.push(
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--settings",
    spec.settingsPath,
    "--permission-mode",
    "manual",
    "--permission-prompt-tool",
    "stdio",
    "--tools",
    toolsFor(spec.role, spec.hasSkills).join(","),
    "--allowedTools",
    ...allowFor(spec),
    "--disallowedTools",
    ...COMMON_DENY,
  );
  if (spec.resume) args.push("--resume", spec.sessionId);
  else args.push("--session-id", spec.sessionId);
  args.push("--max-turns", String(spec.maxTurns), "--max-budget-usd", String(spec.maxBudgetUsd));
  args.push("--append-system-prompt", spec.systemPrompt);
  args.push("--json-schema", JSON.stringify(turnJsonSchema(spec.role)));
  if (spec.addDirs.length) args.push("--add-dir", ...spec.addDirs);
  if (spec.pluginDir) args.push("--plugin-dir", spec.pluginDir);
  if (spec.role !== "member") args.push("--include-partial-messages");
  args.push("--name", spec.name);
  return args;
}
