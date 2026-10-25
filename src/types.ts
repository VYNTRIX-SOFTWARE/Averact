/** Construct server-side from verified host identity, never from agent input. */
export interface TrustedContext {
  readonly actorId: string;
  readonly roles: readonly string[];
}
export interface ExecutionContext extends TrustedContext {
  readonly operationId: string;
  /** Forward to a downstream system that actually enforces atomic idempotency. */
  readonly idempotencyKey?: string;
}
export type Awaitable<T> = T | Promise<T>;
export type PolicyDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string }
  | { readonly kind: 'approval_required'; readonly reason: string };
/** Contracts are trusted app code, NOT arbitrary instructions from an agent. */
export interface ActionContract<Input, Output> {
  readonly name: string;
  readonly effect: 'read' | 'write';
  validate(input: unknown): input is Input;
  policy(input: Input, context: TrustedContext): Awaitable<PolicyDecision>;
  execute(input: Input, context: ExecutionContext): Promise<Output>;
  verify(input: Input, output: Output, context: ExecutionContext): Awaitable<boolean>;
}
export interface ActionRequest {
  readonly input: unknown;
  readonly context: TrustedContext;
  /** Required for writes. The caller/backend owns durable deduplication. */
  readonly idempotencyKey?: string;
}
export interface ApprovalCheck<Input> {
  readonly actionName: string;
  readonly operationId: string;
  readonly reason: string;
  readonly input: Input;
  readonly context: TrustedContext;
  readonly idempotencyKey?: string;
}
/** Must authenticate approvers and bind approval to the specific action payload. */
export interface ApprovalAdapter {
  check<Input>(request: ApprovalCheck<Input>): Promise<boolean>;
}
export type AuditEventType =
  | 'input_rejected' | 'policy_denied' | 'policy_failed'
  | 'approval_required' | 'approval_denied' | 'approval_failed'
  | 'execution_started' | 'execution_failed'
  | 'verification_failed' | 'verification_error' | 'completed';
export interface AuditEvent {
  readonly operationId: string;
  readonly actionName: string;
  readonly actorId: string;
  readonly occurredAt: string;
  readonly type: AuditEventType;
  /** Policy-authored message; MUST NOT include secrets or personal data. */
  readonly reason?: string;
}
export interface AuditAdapter {
  record(event: AuditEvent): Promise<void>;
}
export interface RuntimeAdapters {
  readonly audit: AuditAdapter;
  readonly approvals?: ApprovalAdapter;
}
export type ActionResult<Output> =
  | { readonly status: 'invalid_request'; readonly operationId: string; readonly reason: string }
  | { readonly status: 'denied'; readonly operationId: string; readonly reason: string }
  | { readonly status: 'approval_required'; readonly operationId: string; readonly reason: string }
  | { readonly status: 'completed'; readonly operationId: string; readonly output: Output }
  | { readonly status: 'verification_failed'; readonly operationId: string; readonly output: Output };
export type ErrorPhase = 'input' | 'policy' | 'approval' | 'audit' | 'execution' | 'verification';
