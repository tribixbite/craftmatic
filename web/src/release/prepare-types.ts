/** One outward action as `release/approval-actions.json` stores it; `{product}`, `{version}` and `{commit}` are filled in. */
export interface ApprovalAction { id: string; action: string; exactCommandOrUrl: string; evidenceAfter: string }
