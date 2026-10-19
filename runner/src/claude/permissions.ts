// 役割ごとの道具・許可・拒否・サンドボックスの値（DESIGN-v2 7.2）。データとしてここだけに持ち、args.ts が組み立てる。
// <WS> はメンバーの worktree、<DATA> は ~/baton-data。

export type ThreadRole = "coo" | "leader";
export type ClaudeRole = ThreadRole | "member";

/** --tools（1 層目: 役割に要らない道具を無くす） */
export const ROLE_TOOLS: Record<ClaudeRole, readonly string[]> = {
  coo: ["Read", "Grep", "Glob", "WebFetch", "WebSearch"],
  leader: ["Read", "Grep", "Glob", "Bash", "WebFetch", "WebSearch", "TodoWrite"],
  member: ["Read", "Grep", "Glob", "Edit", "Write", "NotebookEdit", "Bash", "WebFetch", "WebSearch", "TodoWrite"],
};

/** --allowedTools（2 層目: 安全な操作は自動で許可）。メンバーは worktree の Edit をあとで足す */
export const ROLE_ALLOW: Record<ClaudeRole, readonly string[]> = {
  coo: ["Read", "Grep", "Glob", "WebFetch", "WebSearch"],
  leader: ["Read", "Grep", "Glob", "WebFetch", "WebSearch", "TodoWrite", "Bash(git log *)", "Bash(git diff *)", "Bash(git show *)", "Bash(git status *)"],
  member: [
    "Read",
    "Grep",
    "Glob",
    "WebFetch",
    "WebSearch",
    "TodoWrite",
    "NotebookEdit",
    "Bash(npm test)",
    "Bash(npm test *)",
    "Bash(npm run *)",
    "Bash(npm ci)",
    "Bash(npm install)",
    "Bash(npx vitest *)",
    "Bash(npx tsc *)",
    "Bash(npx playwright test *)",
    "Bash(npx prettier *)",
    "Bash(npx eslint *)",
    "Bash(node *)",
    "Bash(python3 *)",
    "Bash(uv run *)",
    "Bash(pytest *)",
    "Bash(mkdir *)",
    "Bash(touch *)",
    "Bash(cp *)",
    "Bash(mv *)",
    "Bash(sed *)",
    "Bash(sort *)",
    "Bash(jq *)",
    "Bash(git status *)",
    "Bash(git diff *)",
    "Bash(git log *)",
    "Bash(git show *)",
  ],
};

/** メンバーの worktree の書き込み（Write にも効く。// 始まりの絶対パス） */
export function memberEditRule(worktree: string): string {
  return `Edit(/${worktree.replace(/\/+$/, "")}/**)`;
}

/** 全役割共通の拒否（--disallowedTools と permissions.deny の両方） */
export const COMMON_DENY: readonly string[] = [
  "Bash(rm *)",
  "Bash(rmdir *)",
  "Bash(unlink *)",
  "Bash(trash *)",
  "Bash(shred *)",
  "Bash(git push *)",
  "Bash(git commit *)",
  "Bash(git add *)",
  "Bash(git reset *)",
  "Bash(git checkout *)",
  "Bash(git switch *)",
  "Bash(git restore *)",
  "Bash(git clean *)",
  "Bash(git rebase *)",
  "Bash(git merge *)",
  "Bash(git cherry-pick *)",
  "Bash(git stash *)",
  "Bash(git branch *)",
  "Bash(git tag *)",
  "Bash(git worktree *)",
  "Bash(git remote *)",
  "Bash(git config *)",
  "Bash(git fetch *)",
  "Bash(git pull *)",
  "Bash(git clone *)",
  "Bash(curl *)",
  "Bash(wget *)",
  "Bash(ssh *)",
  "Bash(scp *)",
  "Bash(sftp *)",
  "Bash(rsync *)",
  "Bash(nc *)",
  "Bash(ncat *)",
  "Bash(telnet *)",
  "Bash(ftp *)",
  "Bash(sudo *)",
  "Bash(su *)",
  "Bash(chmod *)",
  "Bash(chown *)",
  "Bash(dd *)",
  "Bash(npm publish *)",
  "Bash(npm login *)",
  "Bash(npm adduser *)",
  "Bash(yarn publish *)",
  "Bash(pnpm publish *)",
  "Bash(twine *)",
  "Bash(cargo publish *)",
  "Bash(gh *)",
  "Bash(wrangler *)",
  "Bash(npx wrangler *)",
  "Bash(vercel *)",
  "Bash(netlify *)",
  "Bash(firebase *)",
  "Bash(aws *)",
  "Bash(gcloud *)",
  "Bash(open *)",
  "Bash(osascript *)",
  "Bash(launchctl *)",
  "Bash(brew *)",
  "Bash(security *)",
  "Bash(defaults *)",
  "Bash(crontab *)",
  "Bash(pmset *)",
  "Bash(shutdown *)",
  "Bash(reboot *)",
  "Bash(claude *)",
  "Bash(codex *)",
  "Bash(tailscale *)",
  "Bash(docker *)",
  "Bash(kill *)",
  "Bash(pkill *)",
  "Bash(killall *)",
  "Bash(python3 ~/.claude/skills/linear-task/*)",
  "Bash(python3 ~/.local/bin/daily-material.py *)",
  "Read(~/.ssh/**)",
  "Read(~/.aws/**)",
  "Read(~/.config/**)",
  "Read(~/.claude/**)",
  "Read(~/.claude.json)",
  "Read(~/.codex/**)",
  "Read(~/.netrc)",
  "Read(~/.npmrc)",
  "Read(~/Library/Keychains/**)",
  "Read(~/Library/Mobile Documents/**)",
  "Read(**/.env)",
  "Read(**/.env.*)",
  "Read(**/.dev.vars*)",
  "Read(**/*.pem)",
  "Read(**/*.key)",
  "Edit(~/.claude/**)",
  "Edit(~/.config/**)",
  "Edit(~/.ssh/**)",
  "Edit(~/projects/**)",
  "Edit(~/Library/**)",
  "AskUserQuestion",
  "Agent",
  "Task",
  "ExitPlanMode",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitWorktree",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "RemoteTrigger",
  "PushNotification",
  "Monitor",
  "Workflow",
  "Artifact",
  "ArtifactComments",
  "ArtifactData",
  "SendMessage",
];

/** サンドボックスの読み取り拒否（7.2・6.5） */
export const SANDBOX_DENY_READ: readonly string[] = [
  "~/.ssh",
  "~/.aws",
  "~/.config",
  "~/.claude",
  "~/.codex",
  "~/.netrc",
  "~/.npmrc",
  "~/Library/Keychains",
  "~/Library/Mobile Documents",
];

/** サンドボックスの書き込みの追加（パッケージのキャッシュ） */
export const SANDBOX_ALLOW_WRITE: readonly string[] = ["~/.npm", "~/Library/Caches/pip", "~/.cache/uv"];

/** 通信の許可ドメイン（github.com は入れない＝push の経路を塞ぐ） */
export const SANDBOX_ALLOWED_DOMAINS: readonly string[] = ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"];

/** スキルの allowed-tools がこれらの拒否に当たるか（R23）。前方一致の簡易判定 */
export function deniedBy(rule: string, deny: readonly string[] = COMMON_DENY): string | null {
  const norm = rule.trim();
  for (const d of deny) {
    if (d === norm) return d;
    const dm = /^(\w+)\((.*)\)$/.exec(d);
    const rm = /^(\w+)(?:\((.*)\))?$/.exec(norm);
    if (!dm || !rm) continue;
    if (dm[1] !== rm[1]) continue;
    // 引数の無い Bash（Bash 全体の前もっての許可）は、Bash の拒否すべてに当たる。
    // Read などは deny が先に評価されるので、全体の許可でも拒否は崩れない
    if (rm[2] === undefined) {
      if (rm[1] === "Bash") return d;
      continue;
    }
    const dPrefix = (dm[2] ?? "").replace(/\s*\*+$/, "").replace(/\/\*\*$/, "");
    const rPrefix = rm[2].replace(/\s*\*+$/, "").replace(/\/\*\*$/, "");
    if (rPrefix === dPrefix || rPrefix.startsWith(`${dPrefix} `) || rPrefix.startsWith(`${dPrefix}/`) || dPrefix.startsWith(rPrefix)) return d;
  }
  return null;
}
