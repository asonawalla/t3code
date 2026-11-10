import { assert, describe, it } from "@effect/vitest";
import { ompApprovalChoice, ompApprovalMode, ompApprovalPresentation } from "./approvals.ts";

describe("OMP native approvals", () => {
  it("exposes only native approval grants and never upgrades an unsupported answer", () => {
    const options = ["Approve File", "Always Approve File", "Approve Once", "Deny"];
    assert.equal(ompApprovalChoice(options, "accept"), "Approve Once");
    assert.isUndefined(ompApprovalChoice(options, "acceptForSession"));
    assert.isUndefined(ompApprovalChoice(options, "acceptAlways"));
    assert.isUndefined(ompApprovalChoice(options, "cancel"));
    assert.deepEqual(ompApprovalPresentation("Allow tool: read\nPath: secret.txt", options), {
      requestKind: "file-read",
      prompt: "Allow tool: read\nPath: secret.txt",
      options: [
        { decision: "decline", label: "Deny" },
        { decision: "accept", label: "Approve Once" },
      ],
    });
    const delegated = ompApprovalPresentation("Allow tool: task\nTask: inspect code", [
      "Approve",
      "Approve task for this session",
      "Deny",
    ]);
    assert.include(delegated.prompt, "without separate approval prompts");
    assert.equal(
      delegated.options.find((option) => option.decision === "acceptForSession")?.label,
      "Approve task for this session",
    );
    assert.isDefined(delegated.options.find((option) => option.decision === "accept")?.warning);
    assert.equal(
      ompApprovalPresentation("Allow tool: edit", ["Approve", "Deny"]).requestKind,
      "file-change",
    );
    assert.equal(ompApprovalMode("approval-required"), "always-ask");
    assert.equal(ompApprovalMode("auto"), "always-ask");
    assert.equal(ompApprovalMode("auto-accept-edits"), "write");
    assert.equal(ompApprovalMode("full-access"), "yolo");
  });
});
