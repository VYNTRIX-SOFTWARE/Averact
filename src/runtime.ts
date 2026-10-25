import type {
  ActionContract, ActionRequest, ActionResult, AuditEventType, ErrorPhase, RuntimeAdapters,
} from './types.js';

/** A failed operation might have committed downstream. Never blindly retry. */
export class AveractError extends Error {
  readonly phase: ErrorPhase;
  readonly mayHaveExecuted: boolean;
  constructor(phase: ErrorPhase, mayHaveExecuted: boolean, cause?: unknown) {
    super(`Averact ${phase} phase failed`, { cause });
    this.name = 'AveractError';
    this.phase = phase;
    this.mayHaveExecuted = mayHaveExecuted;
  }
}

/** Minimal runner; no durable state, distributed lock, or exactly-once guarantee. */
export async function runAction<Input, Output>(
  contract: ActionContract<Input, Output>,
  request: ActionRequest,
  adapters: RuntimeAdapters,
): Promise<ActionResult<Output>> {
  const operationId = globalThis.crypto.randomUUID();
  let mayHaveExecuted = false;

  async function audit(type: AuditEventType, reason?: string): Promise<void> {
    try {
      await adapters.audit.record({
        operationId, actionName: contract.name, actorId: request.context.actorId,
        occurredAt: new Date().toISOString(), type,
        ...(reason === undefined ? {} : { reason }),
      });
    } catch (cause) {
      throw new AveractError('audit', mayHaveExecuted, cause);
    }
  }

  if (!request.context.actorId.trim()) {
    await audit('input_rejected', 'Missing trusted actor identity');
    return { status: 'invalid_request', operationId, reason: 'Missing trusted actor identity' };
  }
  if (contract.effect === 'write' && !request.idempotencyKey?.trim()) {
    await audit('input_rejected', 'Write actions require an idempotency key');
    return { status: 'invalid_request', operationId, reason: 'Write actions require an idempotency key' };
  }

  let valid: boolean;
  try {
    valid = contract.validate(request.input);
  } catch (cause) {
    throw new AveractError('input', false, cause);
  }
  if (valid !== true) {
    await audit('input_rejected', 'Contract input validation failed');
    return { status: 'invalid_request', operationId, reason: 'Contract input validation failed' };
  }
  const input = request.input as Input;

  let decision: Awaited<ReturnType<typeof contract.policy>>;
  try {
    decision = await contract.policy(input, request.context);
  } catch (cause) {
    await audit('policy_failed');
    throw new AveractError('policy', false, cause);
  }
  if (!decision || !['allow', 'deny', 'approval_required'].includes(decision.kind)) {
    await audit('policy_failed');
    throw new AveractError('policy', false, new Error('Invalid policy verdict'));
  }
  if (decision.kind === 'deny') {
    await audit('policy_denied', decision.reason);
    return { status: 'denied', operationId, reason: decision.reason };
  }
  if (decision.kind === 'approval_required') {
    if (!adapters.approvals) {
      await audit('approval_required', decision.reason);
      return { status: 'approval_required', operationId, reason: decision.reason };
    }
    let approved: boolean;
    try {
      approved = await adapters.approvals.check({
        actionName: contract.name, operationId, reason: decision.reason,
        input, context: request.context, idempotencyKey: request.idempotencyKey,
      });
    } catch (cause) {
      await audit('approval_failed');
      throw new AveractError('approval', false, cause);
    }
    if (approved !== true) {
      await audit('approval_denied', decision.reason);
      return { status: 'denied', operationId, reason: 'Approval was not granted' };
    }
  }

  // If this pre-execution audit write fails, side effects do not start.
  await audit('execution_started');
  mayHaveExecuted = true;
  const executionContext = {
    ...request.context, operationId, idempotencyKey: request.idempotencyKey,
  };
  let output: Output;
  try {
    output = await contract.execute(input, executionContext);
  } catch (cause) {
    await audit('execution_failed');
    throw new AveractError('execution', true, cause);
  }

  let verified: boolean;
  try {
    verified = await contract.verify(input, output, executionContext);
  } catch (cause) {
    await audit('verification_error');
    throw new AveractError('verification', true, cause);
  }
  if (verified !== true) {
    await audit('verification_failed');
    return { status: 'verification_failed', operationId, output };
  }
  await audit('completed');
  return { status: 'completed', operationId, output };
}
