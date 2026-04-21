// Phase 0 skeleton for the principal-based auth model. No runtime behaviour
// yet — types only. See docs/specs/2026-04-20-identity-and-teams-design.md
// §Principals for the target shape. Phase 2 replaces chatsFor() with an
// on-disk store at ~/.claude/channels/deltachat/principals/.

export type PrincipalKind = "human" | "agent";

export interface HumanPrincipal {
  kind: "human";
  contactId: number;
  displayName?: string;
  firstPairedAt: string;
}

export interface AgentPrincipal {
  kind: "agent";
  agentId: string;
  chatmailAddress?: string;
  displayName: string;
  teamId: string | null;
  dispatcherBinding: "main" | string;
}

export type Principal = HumanPrincipal | AgentPrincipal;

export function chatsFor(_p: Principal): number[] {
  throw new Error("principals.chatsFor not implemented (Phase 2)");
}
