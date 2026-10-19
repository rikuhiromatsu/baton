// launchd への登録（設計書 9.4）。`npm run install-agent -w runner`。
//   テンプレートから ~/Library/LaunchAgents/com.rikuhiromatsu.baton-runner.plist を作り、
//   launchctl bootout gui/<uid>/<label>（あれば）→ launchctl bootstrap gui/<uid> <plist>。
// オプション: --dry-run（書き込みも launchctl もしない）/ --home <フォルダ> / --repo <リポジトリのルート>
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const LABEL = "com.rikuhiromatsu.baton-runner";

/** v2 のデータフォルダ（16.2 の 5） */
export const DATA_DIRS = ["projects", "coo", "leaders", "worktrees", "logs", "run", "config"];

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderPlist(template: string, vars: { repo: string; home: string }): string {
  const out = template.replaceAll("{{REPO}}", escapeXml(vars.repo)).replaceAll("{{HOME}}", escapeXml(vars.home));
  if (/\{\{[A-Z]+\}\}/.test(out)) throw new Error("テンプレートに埋めていない変数があります");
  return out;
}

export type InstallDeps = {
  uid: () => number;
  launchctl: (args: string[], opts: { allowFail: boolean }) => void;
  out: (line: string) => void;
};

const realDeps: InstallDeps = {
  uid: () => process.getuid?.() ?? 501,
  launchctl: (args, { allowFail }) => {
    try {
      execFileSync("launchctl", args, { stdio: ["ignore", "inherit", "inherit"] });
    } catch (err) {
      if (!allowFail) throw err;
    }
  },
  out: (l) => console.log(l),
};

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function installAgent(argv: string[], deps: InstallDeps = realDeps): Promise<{ plistPath: string; plist: string; dryRun: boolean }> {
  const dryRun = argv.includes("--dry-run");
  const home = path.resolve(argValue(argv, "--home") ?? homedir());
  const repo = path.resolve(argValue(argv, "--repo") ?? path.join(import.meta.dirname, "../.."));
  const template = await readFile(path.join(import.meta.dirname, "../launchd", `${LABEL}.plist.template`), "utf8");
  const plist = renderPlist(template, { repo, home });
  const plistPath = path.join(home, "Library/LaunchAgents", `${LABEL}.plist`);
  const logDir = path.join(home, "Library/Logs/baton");
  const domain = `gui/${deps.uid()}`;

  if (dryRun) {
    deps.out("[dry-run] 何も書き込みません。実行すると次を行います:");
    deps.out(`  1. mkdir -p ${logDir} ${DATA_DIRS.map((d) => path.join(home, "baton-data", d)).join(" ")}`);
    deps.out(`  2. ${plistPath} を書く`);
    deps.out(`  3. launchctl bootout ${domain}/${LABEL}（登録済みなら）`);
    deps.out(`  4. launchctl bootstrap ${domain} ${plistPath}`);
    return { plistPath, plist, dryRun };
  }

  await mkdir(logDir, { recursive: true });
  for (const d of DATA_DIRS) await mkdir(path.join(home, "baton-data", d), { recursive: true });
  await mkdir(path.dirname(plistPath), { recursive: true });
  await writeFile(plistPath, plist, { mode: 0o644 });
  deps.launchctl(["bootout", `${domain}/${LABEL}`], { allowFail: true });
  deps.launchctl(["bootstrap", domain, plistPath], { allowFail: false });
  deps.out(`launchd に登録しました: ${plistPath}`);
  return { plistPath, plist, dryRun };
}

if (import.meta.main) {
  installAgent(process.argv.slice(2)).catch((err: unknown) => {
    console.error(`登録に失敗しました: ${(err as Error).message}`);
    process.exit(1);
  });
}
