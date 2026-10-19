// F15 プロジェクト案のカード（13.6）: 目的・作業場所（選び直せる）・チーム、「立てる」で accept（作業場所付き）、立てたら小さくなる。
// 「直す」は入力欄に「プロジェクト案について: 」を入れる
import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { API_PATHS, COO_THREAD_ID, MEMBER_PROFILE_LABELS, TESTIDS, UI_TEXT_V2, type ProjectProposal, type RepoCandidate } from "@baton/shared";
import { qk } from "../../src/web/api/keys.ts";
import { ProposalCardBody } from "../../src/web/components/ProposalCard.tsx";
import { useDraft } from "../../src/web/state/draft.ts";
import { json, makeQc, recordingTransport, RouterWrap as Wrap } from "./helpers.tsx";

const repos: RepoCandidate[] = [
  { path: "/r/my-project", name: "rikuhiromatsu/my-project", defaultBranch: "main", headSha: "5fd1db4", lastCommitAt: Date.now() - 3600_000, dirty: true, projectId: null, seenAt: 0 },
  { path: "/r/sandbox", name: "rikuhiromatsu/baton-sandbox", defaultBranch: "main", headSha: "a13c09e", lastCommitAt: null, dirty: false, projectId: null, seenAt: 0 },
];

function proposal(over: Partial<ProjectProposal> = {}): ProjectProposal {
  return {
    id: "pp1",
    threadId: COO_THREAD_ID,
    messageId: "m1",
    status: "pending",
    projectId: null,
    name: "撮影素材の整理",
    slug: "footage",
    goal: "毎週の編集を 30 分短くする",
    summary: "",
    workspace: { kind: "baton" },
    leader: { name: "ハル", specialty: "段取り" },
    members: [{ name: "イオ", specialty: "仕分け", profile: "engineer" }],
    createdAt: 0,
    decidedAt: null,
    ...over,
  };
}

beforeEach(() => useDraft.setState({ texts: {} }));

describe("F15 プロジェクト案のカード", () => {
  it("目的・作業場所・チーム（職種の名前）を出す", async () => {
    const qc = makeQc();
    recordingTransport(() => json(200, { items: repos }));
    render(
      <Wrap qc={qc}>
        <ProposalCardBody proposal={proposal()} now={Date.now()} />
      </Wrap>,
    );
    const card = await screen.findByTestId(TESTIDS.proposalCard);
    expect(card.getAttribute("data-status")).toBe("pending");
    for (const t of [UI_TEXT_V2.proposal.title, UI_TEXT_V2.proposal.goal, UI_TEXT_V2.proposal.workspace, UI_TEXT_V2.proposal.team, "毎週の編集を 30 分短くする", "ハル", MEMBER_PROFILE_LABELS.engineer]) {
      expect(card.textContent).toContain(t);
    }
  });

  it("既存リポジトリに選び直して「立てる」→ accept に repoPath。作業中の変更ありの印", async () => {
    const qc = makeQc();
    const { calls } = recordingTransport((c) => {
      if (c.path === API_PATHS.repos) return json(200, { items: repos });
      if (c.path === API_PATHS.proposalAccept("pp1")) return json(201, { project: { id: "p9" }, proposal: proposal({ status: "accepted", projectId: "p9", workspace: { kind: "repo", repoPath: "/r/sandbox", repoName: "rikuhiromatsu/baton-sandbox" } }) });
      return json(200, { items: [] });
    });
    render(
      <Wrap qc={qc}>
        <ProposalCardBody proposal={proposal()} now={Date.now()} />
      </Wrap>,
    );
    fireEvent.click(await screen.findByText(UI_TEXT_V2.proposal.repo));
    const options = await screen.findAllByTestId(TESTIDS.proposalRepoOption);
    expect(options.map((o) => o.getAttribute("data-path"))).toEqual(["/r/my-project", "/r/sandbox"]);
    expect(options[0]!.textContent).toContain(UI_TEXT_V2.proposal.dirty);
    fireEvent.click(options[1]!);
    fireEvent.click(screen.getByTestId(TESTIDS.proposalAccept));
    await waitFor(() => expect(calls.some((c) => c.path === API_PATHS.proposalAccept("pp1"))).toBe(true));
    expect(calls.find((c) => c.path === API_PATHS.proposalAccept("pp1"))!.body).toEqual({ workspace: { kind: "repo", repoPath: "/r/sandbox" } });
    await waitFor(() => expect(qc.getQueryData<ProjectProposal>(qk.proposal("pp1"))?.status).toBe("accepted"));
  });

  it("立てた案は小さくなり「立てました」とプロジェクトへのリンク、見送りは「見送り」", async () => {
    const qc = makeQc();
    recordingTransport(() => json(200, { items: [] }));
    render(
      <Wrap qc={qc}>
        <ProposalCardBody proposal={proposal({ status: "accepted", projectId: "p9" })} now={Date.now()} />
      </Wrap>,
    );
    expect((await screen.findByTestId(TESTIDS.proposalCard)).textContent).toContain(UI_TEXT_V2.proposal.accepted);
    expect(screen.queryByTestId(TESTIDS.proposalAccept)).toBeNull();
    cleanup();
    render(
      <Wrap qc={qc}>
        <ProposalCardBody proposal={proposal({ id: "pp2", status: "declined" })} now={Date.now()} />
      </Wrap>,
    );
    expect((await screen.findByTestId(TESTIDS.proposalCard)).getAttribute("data-status")).toBe("declined");
    expect(screen.getByTestId(TESTIDS.proposalCard).textContent).toContain(UI_TEXT_V2.proposal.declined);
  });

  it("「直す」で COO への下書きに前置きを入れる", async () => {
    recordingTransport(() => json(200, { items: [] }));
    render(
      <Wrap qc={makeQc()}>
        <ProposalCardBody proposal={proposal()} now={Date.now()} />
      </Wrap>,
    );
    fireEvent.click(await screen.findByTestId(TESTIDS.proposalRevise));
    expect(useDraft.getState().texts.coo).toBe(`${UI_TEXT_V2.proposal.title}${UI_TEXT_V2.conversation.about}: `);
  });
});
