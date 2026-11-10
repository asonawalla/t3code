import type {
  ProviderApprovalDecision,
  ProviderApprovalOption,
  ProviderRequestKind,
  RuntimeMode,
} from "@t3tools/contracts";

export function ompApprovalMode(mode: RuntimeMode): "always-ask" | "write" | "yolo" {
  return mode === "full-access" ? "yolo" : mode === "auto-accept-edits" ? "write" : "always-ask";
}

export function ompApprovalChoice(
  options: ReadonlyArray<string>,
  decision: ProviderApprovalDecision,
) {
  const choice =
    decision === "accept"
      ? options.find((option) => option === "Approve" || option === "Approve Once")
      : decision === "acceptForSession"
        ? options.find(
            (option) => option.startsWith("Approve ") && option.endsWith(" for this session"),
          )
        : decision === "decline"
          ? "Deny"
          : undefined;
  return choice !== undefined && options.includes(choice) ? choice : undefined;
}

export function ompApprovalPresentation(
  title: string,
  nativeOptions: ReadonlyArray<string>,
): {
  requestKind: ProviderRequestKind;
  prompt: string;
  options: ProviderApprovalOption[];
} {
  const tool = /^Allow tool: (\S+)/u.exec(title)?.[1];
  const delegated = tool === "task";
  const warning =
    "Approving this task authorizes its subagents to run tools without separate approval prompts. OMP's explicit deny rules still apply.";
  return {
    requestKind:
      tool !== undefined && ["write", "edit", "ast_edit", "delete", "move"].includes(tool)
        ? "file-change"
        : tool !== undefined && ["read", "grep", "glob", "find", "ls", "ast_grep"].includes(tool)
          ? "file-read"
          : "command",
    prompt: delegated ? `${title}\n\n${warning}` : title,
    options: (["decline", "acceptForSession", "accept"] as const).flatMap((decision) => {
      const label = ompApprovalChoice(nativeOptions, decision);
      return label === undefined
        ? []
        : [{ decision, label, ...(delegated && decision !== "decline" ? { warning } : {}) }];
    }),
  };
}
