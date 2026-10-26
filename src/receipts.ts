import { AveractError, runAction } from './runtime.js';
import type {
  ActionContract, ActionRequest, ActionResult, ApprovalCheck, AuditAdapter,
  ErrorPhase, PolicyDecision,
} from './types.js';

export type ReceiptOutcome = ActionResult<unknown>['status'] | 'error';
export type ReceiptPolicy = PolicyDecision['kind'] | 'not_evaluated';
export type ReceiptApproval = 'not_required' | 'not_configured' | 'approved' | 'rejected' | 'error';
export type ReceiptVerification = 'not_run' | 'passed' | 'failed' | 'error';

/** A checksum is NOT a signature, proof of authenticity, or tamper-evident audit log. */
export interface ActionReceipt {
  readonly schema: 'averact.receipt.v1';
  readonly operationId: string;
  readonly actionName: string;
  readonly effect: 'read' | 'write';
  readonly occurredAt: string;
  readonly inputSha256: string;
  readonly idempotencyKeySha256?: string;
  readonly policy: ReceiptPolicy;
  readonly approval: ReceiptApproval;
  /** Opaque, host-generated reference; no authentication is provided by this library. */
  readonly approvalReference?: string;
  readonly verification: ReceiptVerification;
  readonly outcome: ReceiptOutcome;
  readonly errorPhase?: ErrorPhase | 'unknown';
  readonly mayHaveExecuted: boolean;
  readonly receiptSha256: string;
}

export interface ApprovalEvidence {
  readonly approved: boolean;
  /** A reference to approval evidence managed by the trusted host. */
  readonly reference?: string;
}

export interface ReceiptRuntimeAdapters {
  readonly audit: AuditAdapter;
  readonly approvals?: { check<Input>(request: ApprovalCheck<Input>): Promise<boolean | ApprovalEvidence> };
  /** Must persist durably to serve as an audit record; no storage is provided by Averact. */
  readonly receipts?: { record(receipt: ActionReceipt): Promise<void> };
}

export interface ActionWithReceipt<Output> {
  readonly result: ActionResult<Output>;
  readonly receipt: ActionReceipt;
}

/** Strict deterministic JSON. Not general JSON canonicalization or RFC 8785. */
function canonicalJson(value: unknown): string {
  const visiting = new Set<object>();
  let nodes = 0;
  function encode(item: unknown, depth: number): string {
    if (++nodes > 10_000 || depth > 32) throw new TypeError('Receipt input exceeds nesting or node limits');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== 'object') throw new TypeError('Receipt input must be finite, plain JSON data');
    if (visiting.has(item)) throw new TypeError('Receipt input contains a cycle');
    const proto = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && proto !== Object.prototype && proto !== null)
      throw new TypeError('Receipt input must use plain objects and arrays');
    visiting.add(item);
    try {
      if (Array.isArray(item)) {
        if (Reflect.ownKeys(item).some(key => typeof key === 'symbol'))
          throw new TypeError('Receipt arrays cannot contain symbol keys');
        const elements: string[] = [];
        for (let i = 0; i < item.length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
          if (!descriptor || !('value' in descriptor))
            throw new TypeError('Receipt arrays must be dense and contain no accessors');
          elements.push(encode(descriptor.value, depth + 1));
        }
        if (Object.keys(item).length !== item.length)
          throw new TypeError('Receipt arrays cannot contain extra enumerable keys');
        return '[' + elements.join(',') + ']';
      }
      const descriptors = Object.getOwnPropertyDescriptors(item);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some(key => typeof key !== 'string'))
        throw new TypeError('Receipt objects cannot contain symbol keys');
      const orderedKeys = (keys as string[]).sort();
      const entries = orderedKeys.map(key => {
        const descriptor = descriptors[key];
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
          throw new TypeError('Receipt objects cannot contain accessors or hidden fields');
        return JSON.stringify(key) + ':' + encode(descriptor.value, depth + 1);
      });
      return '{' + entries.join(',') + '}';
    } finally {
      visiting.delete(item);
    }
  }
  const serialized = encode(value, 0);
  if (serialized.length > 1_000_000) throw new TypeError('Receipt input exceeds size limit');
  return serialized;
}

async function sha256(domain: string, content: string): Promise<string> {
  const bytes = new TextEncoder().encode(domain + '\u0000' + content);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

export async function fingerprintActionInput(input: unknown): Promise<string> {
  return sha256('averact.input.v1', canonicalJson(input));
}

async function createReceipt(data: Omit<ActionReceipt, 'receiptSha256'>): Promise<ActionReceipt> {
  const receiptSha256 = await sha256('averact.receipt.v1', canonicalJson(data));
  return Object.freeze({ ...data, receiptSha256 });
}

/** Only checks internal consistency. Attackers can re-compute an unkeyed hash. */
export async function verifyActionReceipt(receipt: ActionReceipt, expectedInput?: unknown): Promise<boolean> {
  try {
    if (receipt.schema !== 'averact.receipt.v1' || !/^[a-f0-9]{64}$/.test(receipt.receiptSha256)) return false;
    const { receiptSha256, ...data } = receipt;
    if (await sha256('averact.receipt.v1', canonicalJson(data)) !== receiptSha256) return false;
    return expectedInput === undefined || (await fingerprintActionInput(expectedInput)) === receipt.inputSha256;
  } catch {
    return false;
  }
}

/**
 * Opt-in receipt recording around the existing runAction API.
 * Input must be plain JSON; snapshot is deeply frozen so policy and execution
 * observe the same values that were fingerprinted.
 */
export async function runActionWithReceipt<Input, Output>(
  contract: ActionContract<Input, Output>,
  request: ActionRequest,
  adapters: ReceiptRuntimeAdapters,
): Promise<ActionWithReceipt<Output>> {
  const encoded = canonicalJson(request.input);
  // Snapshot before calling any user hook; never hash a mutable object then execute a different one.
  const snapshot: unknown = JSON.parse(encoded);
  function deepFreeze(item: unknown): void {
    if (item && typeof item === 'object') {
      for (const child of Object.values(item)) deepFreeze(child);
      Object.freeze(item);
    }
  }
  deepFreeze(snapshot);
  const inputSha256 = await sha256('averact.input.v1', encoded);
  const idempotencyKeySha256 = request.idempotencyKey === undefined
    ? undefined : await sha256('averact.key.v1', request.idempotencyKey);
  let policy: ReceiptPolicy = 'not_evaluated';
  let approval: ReceiptApproval = 'not_required';
  let approvalReference: string | undefined;
  let verification: ReceiptVerification = 'not_run';
  let executed = false;
  const instrumented: ActionContract<Input, Output> = {
    ...contract,
    validate: input => contract.validate(input),
    async policy(input, context) {
      const decision = await contract.policy(input, context);
      if (decision && ['allow', 'deny', 'approval_required'].includes(decision.kind)) policy = decision.kind;
      return decision;
    },
    async execute(input, context) {
      executed = true;
      return contract.execute(input, context);
    },
    async verify(input, output, context) {
      try {
        const result = await contract.verify(input, output, context);
        verification = result === true ? 'passed' : 'failed';
        return result;
      } catch (error) {
        verification = 'error';
        throw error;
      }
    },
  };
  const runtimeAdapters = {
    audit: adapters.audit,
    ...(adapters.approvals ? {
      approvals: {
        async check<T>(check: ApprovalCheck<T>): Promise<boolean> {
          try {
            const response = await adapters.approvals!.check(check);
            const approved = response === true || (
              typeof response === 'object' && response !== null && response.approved === true
            );
            if (approved && typeof response === 'object' && response !== null && response.reference !== undefined) {
              if (typeof response.reference !== 'string' || response.reference.length < 1 || response.reference.length > 200)
                throw new TypeError('Invalid trusted approval reference');
              approvalReference = response.reference;
            }
            approval = approved ? 'approved' : 'rejected';
            return approved;
          } catch (error) {
            approval = 'error';
            throw error;
          }
        },
      },
    } : {}),
  };

  async function finalize(
    operationId: string, outcome: ReceiptOutcome, mayHaveExecuted: boolean,
    errorPhase?: ErrorPhase | 'unknown',
  ): Promise<ActionReceipt> {
    const receipt = await createReceipt({
      schema: 'averact.receipt.v1', operationId, actionName: contract.name,
      effect: contract.effect, occurredAt: new Date().toISOString(), inputSha256,
      ...(idempotencyKeySha256 === undefined ? {} : { idempotencyKeySha256 }),
      policy,
      approval: outcome === 'approval_required' && !adapters.approvals ? 'not_configured' : approval,
      ...(approvalReference === undefined ? {} : { approvalReference }),
      verification, outcome,
      ...(errorPhase === undefined ? {} : { errorPhase }), mayHaveExecuted,
    });
    if (adapters.receipts) {
      try { await adapters.receipts.record(receipt); }
      catch (cause) { throw new AveractError('receipt', mayHaveExecuted, operationId, cause); }
    }
    return receipt;
  }

  try {
    const result = await runAction(instrumented, { ...request, input: snapshot }, runtimeAdapters);
    const receipt = await finalize(result.operationId, result.status, executed);
    return { result, receipt };
  } catch (error) {
    if (!(error instanceof AveractError) || error.phase === 'receipt') throw error;
    try {
      await finalize(error.operationId, 'error', error.mayHaveExecuted, error.phase);
    } catch (receiptError) {
      // Preserve knowledge of possible downstream side effects on receipt persistence failures.
      throw new AveractError('receipt', error.mayHaveExecuted, error.operationId,
        new AggregateError([error, receiptError], 'Original failure and receipt persistence failure'));
    }
    throw error;
  }
}
