import type { HighRiskAssessment } from "./risk.ts";
import type { ReviewerOutputResult } from "./reviewer.ts";
import type { ApprovalReviewMode } from "./settings.ts";
import type { EscalationAssociation, RuleEvaluation } from "./shell.ts";

/** Inputs required for the final pure policy decision. */
export interface ApprovalDecisionInput {
  /** User-selected review mode. */
  mode: ApprovalReviewMode;
  /** Exact tool-to-approval association result. */
  association: EscalationAssociation;
  /** Positive allowlist result. */
  rules: RuleEvaluation;
  /** Fixed high-risk signal result. */
  risk: HighRiskAssessment;
  /** Reviewer output in model-assisted mode. */
  reviewer?: ReviewerOutputResult;
}

/** Pure policy result. Host lifecycle checks still gate actual allowed-once responses. */
export type ApprovalDecision =
  | { readonly status: "allow-candidate"; readonly source: "rules" | "reviewer" }
  | {
      readonly status: "manual";
      readonly reason: "association" | "rules" | "high-risk" | "reviewer-unavailable" | "reviewer-declined";
    };

/**
 * Combines deterministic gates and an optional reviewer verdict.
 *
 * @param input Association, allowlist, risk, mode, and reviewer results.
 * @returns A candidate only after every required gate explicitly allows it.
 */
export function combineApprovalDecision(input: ApprovalDecisionInput): ApprovalDecision {
  if (input.association.status !== "associated") return { status: "manual", reason: "association" };
  if (input.rules.status !== "matched") return { status: "manual", reason: "rules" };
  if (input.risk.status !== "safe") return { status: "manual", reason: "high-risk" };

  if (input.mode === "rules-only") return { status: "allow-candidate", source: "rules" };
  if (input.reviewer === undefined || !input.reviewer.ok) {
    return { status: "manual", reason: "reviewer-unavailable" };
  }
  if (input.reviewer.verdict.decision !== "allow") {
    return { status: "manual", reason: "reviewer-declined" };
  }
  return { status: "allow-candidate", source: "reviewer" };
}
