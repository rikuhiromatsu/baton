// R29 Jev の方針（純粋関数。5.9.1）: mod の route() の挙動、Baton の上限 clampRouting()、redactSecrets()、buildJevState()。
import { describe, expect, it } from "vitest";
import {
  ASSUMED_DEFAULT_EFFORT,
  DEFAULT_TIERS,
  EFFORT_ORDER,
  REDACTED,
  buildJevState,
  clampRouting,
  effortLevel,
  readDecision,
  redactSecrets,
  route,
  type ClampInput,
  type Decision,
  type PolicyConfig,
} from "../src/claude/jev-policy.ts";

const config: PolicyConfig = { tiers: DEFAULT_TIERS, minUpgradeConfidence: 0.3, minDowngradeConfidence: 0.6 };
const dec = (d: Partial<Decision> = {}): Decision => ({ tier: "balanced", confidence: 0.9, risky: 0.05, effort: 1, effortConfidence: 0.9, ...d });
const current = { model: "sonnet", effort: "medium" };

describe("R29 route()（mod のまま）", () => {
  it("上げは確信度 0.3、下げは 0.6", () => {
    expect(route(dec({ tier: "deep", confidence: 0.35 }), current, config).model).toBe("opus");
    expect(route(dec({ tier: "deep", confidence: 0.2 }), current, config).model).toBeNull();
    expect(route(dec({ tier: "fast", confidence: 0.7 }), current, config).model).toBe("haiku");
    expect(route(dec({ tier: "fast", confidence: 0.5 }), current, config).model).toBeNull();
  });

  it("確信度 null は上げだけ通す", () => {
    expect(route(dec({ tier: "deep", confidence: null }), current, config).model).toBe("opus");
    expect(route(dec({ tier: "fast", confidence: null }), current, config).model).toBeNull();
  });

  it("risky > 0.7 は deep と high 以上を強制（しきい値を飛ばす）。risky でエフォートを下げない", () => {
    const r = route(dec({ tier: "fast", confidence: 0.99, risky: 0.9, effort: 0 }), current, config);
    expect(r.model).toBe("opus");
    expect(r.effort).toBe("high");
    expect(r.reason).toContain("forced by risk");
    // すでに xhigh の基準を下げない
    const keep = route(dec({ tier: "fast", risky: 0.9, effort: 0 }), { model: "opus", effort: "xhigh" }, config);
    expect(keep.effort).toBeNull();
    expect(keep.model).toBeNull();
  });

  it("同じ段は変えない。effort のスコアは 4 段（low/medium/high/xhigh）", () => {
    expect(route(dec({ tier: "balanced" }), current, config).model).toBeNull();
    expect(EFFORT_ORDER.map((_, i) => effortLevel(i))).toEqual(["low", "medium", "high", "xhigh"]);
    expect(effortLevel(99)).toBe("xhigh");
  });

  it("readDecision: answers を読む。tier が無い・壊れた JSON は null", () => {
    const ok = readDecision(JSON.stringify({ answers: { tier: { choice: "deep", confidence: 0.8 }, effort: { score: 2.2, confidence: 0.5 }, risky: { noul: 0.1 } } }));
    expect(ok).toEqual({ tier: "deep", confidence: 0.8, effort: 2.2, effortConfidence: 0.5, risky: 0.1 });
    expect(readDecision(JSON.stringify({ answers: { effort: { score: 1 } } }))).toBeNull();
    expect(readDecision("{oops")).toBeNull();
    expect(readDecision("null")).toBeNull();
  });
});

describe("R29 clampRouting()（Baton の上限。D-131）", () => {
  const base = (over: Partial<ClampInput> = {}): ClampInput => ({
    routing: { model: null, effort: null, reason: "" },
    base: { model: "sonnet", effort: null },
    limits: { min: "sonnet", max: "opus" },
    conflictResolution: false,
    quota: { fiveHour: null, sevenDay: null },
    ...over,
  });

  it("engineer・writer（下限 sonnet）は haiku に下がらない。researcher・generalist（下限 haiku）は下がる", () => {
    const routing = { model: "haiku", effort: "low" as const, reason: "" };
    const e = clampRouting(base({ routing }));
    expect(e.model).toBe("sonnet");
    expect(e.clamped.length).toBeGreaterThan(0);
    const g = clampRouting(base({ routing, limits: { min: "haiku", max: "opus" } }));
    expect(g.model).toBe("haiku");
    expect(g.effort).toBe("low");
  });

  it("上限を越えない（max が sonnet なら opus は sonnet）。risky の強制も同じ", () => {
    const forced = route(dec({ tier: "fast", risky: 0.95, effort: 0 }), current, config);
    expect(forced.model).toBe("opus");
    const c = clampRouting(base({ routing: forced, limits: { min: "sonnet", max: "sonnet" } }));
    expect(c.model).toBe("sonnet");
    expect(c.effort).toBe("high"); // sonnet では high まで
  });

  it("衝突の解決は sonnet 以上", () => {
    const c = clampRouting(base({ routing: { model: "haiku", effort: null, reason: "" }, limits: { min: "haiku", max: "opus" }, conflictResolution: true }));
    expect(c.model).toBe("sonnet");
  });

  it("xhigh は最終のモデルが opus のときだけ（sonnet なら high）。max は出ない", () => {
    expect(clampRouting(base({ routing: { model: null, effort: "xhigh", reason: "" } })).effort).toBe("high");
    expect(clampRouting(base({ routing: { model: "opus", effort: "xhigh", reason: "" } })).effort).toBe("xhigh");
    for (const score of [0, 1, 2, 3, 4, 100]) expect(EFFORT_ORDER).toContain(effortLevel(score));
    expect(EFFORT_ORDER as readonly string[]).not.toContain("max");
  });

  it("枠が 5 時間 0.60 か週 0.75 以上のとき基準より上げない（下げは通る）", () => {
    const up = { model: "opus", effort: "xhigh" as const, reason: "" };
    for (const quota of [{ fiveHour: 0.6, sevenDay: null }, { fiveHour: null, sevenDay: 0.75 }]) {
      const c = clampRouting(base({ routing: up, quota }));
      expect(c.model).toBe("sonnet");
      expect(c.effort).toBeNull(); // 基準（medium とみなす）と同じ → --effort を付けない
    }
    const down = clampRouting(base({ routing: { model: "haiku", effort: "low", reason: "" }, limits: { min: "haiku", max: "opus" }, quota: { fiveHour: 0.9, sevenDay: 0.9 } }));
    expect(down.model).toBe("haiku");
    expect(down.effort).toBe("low");
    // しきい値の手前なら上げる
    expect(clampRouting(base({ routing: up, quota: { fiveHour: 0.59, sevenDay: 0.74 } })).model).toBe("opus");
  });

  it("枠が未観測（null）なら上げる", () => {
    const c = clampRouting(base({ routing: { model: "opus", effort: "high", reason: "" }, quota: { fiveHour: null, sevenDay: null } }));
    expect(c.model).toBe("opus");
    expect(c.effort).toBe("high");
  });

  it("基準のエフォートが無い職種で結果が medium（みなし）なら --effort を付けない。基準があるなら基準のまま", () => {
    expect(ASSUMED_DEFAULT_EFFORT).toBe("medium");
    expect(clampRouting(base({ routing: { model: null, effort: "medium", reason: "" } })).effort).toBeNull();
    expect(clampRouting(base({ routing: { model: null, effort: null, reason: "" } })).effort).toBeNull();
    expect(clampRouting(base({ base: { model: "sonnet", effort: "high" }, routing: { model: null, effort: null, reason: "" } })).effort).toBe("high");
    expect(clampRouting(base({ routing: { model: null, effort: "low", reason: "" } })).effort).toBe("low");
  });
});

describe("R29 redactSecrets()・buildJevState()", () => {
  it("鍵らしい文字列を [伏せ字] にする", () => {
    const cases = [
      "key sk-ant-api03-abcdefghijklmnop end",
      "token btn_bot_abcdef1234567890 end",
      "gh ghp_abcdefghijklmnopqrstuvwxyz0123 end",
      "pat github_pat_11ABCDEFG0abcdefghijklmnop end",
      "slack xoxb-1234567890-abcdefghij end",
      "aws AKIAABCDEFGHIJKLMNOP end",
      "pem -----BEGIN RSA PRIVATE KEY-----\nMIIEabc\ndef\n-----END RSA PRIVATE KEY----- end",
      `long ${"A1b2".repeat(10)} end`,
    ];
    for (const c of cases) {
      const out = redactSecrets(c);
      expect(out).toContain(REDACTED);
      expect(out.startsWith(c.split(" ")[0]!)).toBe(true);
      expect(out.endsWith(" end")).toBe(true);
    }
    expect(redactSecrets("key sk-ant-api03-abcdefghijklmnop end")).not.toContain("abcdefghijklmnop");
    expect(redactSecrets("pem -----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY----- end")).not.toContain("MIIEabc");
    // ふつうの文・短い語は残す
    expect(redactSecrets("scripts/scripts.md に 10 本書く。task-1 を待つ")).toBe("scripts/scripts.md に 10 本書く。task-1 を待つ");
  });

  it("buildJevState: 決まった項目だけ。spec 4,000 文字・title 80 文字・paths 20 件・伏せ字を通す。goal・パス・依存の本文は入らない", () => {
    const input = {
      title: "台本".repeat(100),
      spec: `${"あ".repeat(5000)} sk-ant-api03-abcdefghijklmnop`,
      paths: Array.from({ length: 30 }, (_, i) => `src/f${i}.ts`),
      profileId: "writer",
      workspaceKind: "repo" as const,
      round: 2,
      conflictResolution: true,
      dependsOn: 3,
      maxTurns: 80,
      // 渡しても state に入ってはいけないもの
      goal: "秘密のプロジェクトの目的",
      repoPath: "/Users/someone/projects/secret-repo",
      dependencyResults: [{ taskKey: "t1", summary: "依存の結果の本文" }],
    };
    const s = buildJevState(input);
    expect(Object.keys(s).sort()).toEqual(["conflictResolution", "dependsOn", "kind", "limits", "paths", "profile", "profileNote", "round", "spec", "title", "workspace"]);
    expect(s.kind).toBe("baton_member_task");
    expect(s.title.length).toBe(80);
    expect(s.spec.length).toBe(4000);
    expect(s.paths).toHaveLength(20);
    expect(s).toMatchObject({ profile: "writer", workspace: "repo", round: 2, conflictResolution: true, dependsOn: 3, limits: { maxTurns: 80 } });
    expect(s.profileNote.length).toBeGreaterThan(0);
    const json = JSON.stringify(s);
    for (const bad of ["秘密のプロジェクトの目的", "/Users/someone", "依存の結果の本文"]) expect(json).not.toContain(bad);
    // 切り詰めの手前に鍵があっても伏せ字になる
    const s2 = buildJevState({ ...input, spec: `前置き sk-ant-api03-abcdefghijklmnop ${"い".repeat(10)}` });
    expect(s2.spec).toContain(REDACTED);
    expect(s2.spec).not.toContain("abcdefghijklmnop");
    expect(buildJevState({ ...input, round: 1 }).round).toBe(1);
  });
});
