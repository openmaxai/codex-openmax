// Backpressure + concurrent-wake semantics for POST /wake (P1).
// Invariants this module owns:
//   1) SERIALIZE per conversation: conversation<->thread is 1:1, so per-conversation FIFO
//      is per-thread FIFO — never two concurrent injects into one thread (a racy pair could
//      both see "no active turn" and each turn/start, splitting one conversation across two
//      turns). It also closes the ensureThread race (two first-wakes both spawning a thread).
//   2) DEDUP by messageId: upstream retries the same wake on timeout/failure. While attempt
//      N is still in flight, a duplicate coalesces onto N's promise (never a second inject);
//      after a confirmed delivery, a re-delivery is answered ok:true idempotently from a
//      bounded LRU (re-injecting would duplicate the message in model-visible history —
//      the mirror image of invariants.ts's "never claim success on a drop").
//   3) BACKPRESSURE: per-conversation depth (in-flight + waiting) is capped; beyond it we
//      answer runtime_busy + retryAfterMs instead of queueing unboundedly — the caller
//      already has retry semantics, so shedding is safe and memory stays bounded.
//   4) A failed attempt is NOT recorded as delivered — the upstream retry must re-inject.
import { classifyFailure, isAuthTerminal, retryAfterMs } from "./invariants.js";
import type { WakeRequest, WakeResponse } from "../types.js";

export interface WakeQueueOpts {
	/** Max in-flight + waiting wakes per conversation before shedding runtime_busy. */
	maxQueuedPerConversation?: number;
	/** How many delivered messageIds the idempotency LRU remembers. */
	recentDeliveredCapacity?: number;
}

export interface WakeQueue {
	enqueue(wake: WakeRequest): Promise<WakeResponse>;
	/** In-flight + waiting count for a conversation (0 when idle). */
	depth(conversationId: string): number;
}

const DEFAULT_MAX_QUEUED = 8;
const DEFAULT_DELIVERED_CAPACITY = 512;

export function createWakeQueue(
	process: (wake: WakeRequest) => Promise<WakeResponse>,
	opts?: WakeQueueOpts,
): WakeQueue {
	const maxQueued = opts?.maxQueuedPerConversation ?? DEFAULT_MAX_QUEUED;
	const deliveredCapacity = opts?.recentDeliveredCapacity ?? DEFAULT_DELIVERED_CAPACITY;

	// Per-conversation FIFO: the tail promise each new wake chains onto (invariant 1).
	const tails = new Map<string, Promise<unknown>>();
	const depths = new Map<string, number>();
	// messageId -> the in-flight attempt's promise (invariant 2, coalesce).
	const inFlight = new Map<string, Promise<WakeResponse>>();
	// messageId -> runtimeSession of a confirmed delivery; Map iteration order = LRU order.
	const recentDelivered = new Map<string, string | undefined>();

	function recordDelivered(messageId: string, runtimeSession: string | undefined) {
		recentDelivered.delete(messageId); // refresh position
		recentDelivered.set(messageId, runtimeSession);
		while (recentDelivered.size > deliveredCapacity) {
			const oldest = recentDelivered.keys().next().value as string;
			recentDelivered.delete(oldest);
		}
	}

	return {
		depth: (conversationId) => depths.get(conversationId) ?? 0,
		enqueue(wake) {
			// Already confirmed delivered → idempotent success, never a second inject.
			if (recentDelivered.has(wake.messageId)) {
				const runtimeSession = recentDelivered.get(wake.messageId);
				recordDelivered(wake.messageId, runtimeSession); // keep hot ids resident
				return Promise.resolve<WakeResponse>({ ok: true, ...(runtimeSession ? { runtimeSession } : {}) });
			}
			// Same attempt still in flight → coalesce onto it, never a second inject.
			const existing = inFlight.get(wake.messageId);
			if (existing) return existing;
			// Backpressure: shed with the caller's own retry semantics instead of queueing forever.
			const cid = wake.conversationId;
			const depth = depths.get(cid) ?? 0;
			if (depth >= maxQueued) {
				// Internal diagnosis: runtime_busy. Wire failureClass is canonical (enum) —
				// the class-specific backoff hint is how the distinction survives on the wire.
				return Promise.resolve<WakeResponse>({
					ok: false,
					failureClass: "wake_failed",
					retryAfterMs: retryAfterMs("runtime_busy"),
				});
			}
			depths.set(cid, depth + 1);

			const prev = tails.get(cid) ?? Promise.resolve();
			const attempt: Promise<WakeResponse> = prev
				.then(() => process(wake))
				// Contain a throwing processor as a typed failure so the FIFO chain never breaks
				// (a rejected tail would wedge every later wake in the conversation).
				.catch((err): WakeResponse => {
					// Terminal (auth): no retryAfterMs hint — v1 can't express terminal-no-retry
					// (contract-revision proposal pending); omitting the hint is the closest signal.
					if (isAuthTerminal(err)) return { ok: false, failureClass: "wake_failed" };
					const diagnosed = classifyFailure(err);
					return { ok: false, failureClass: "wake_failed", retryAfterMs: retryAfterMs(diagnosed) };
				})
				.then((res) => {
					inFlight.delete(wake.messageId);
					const d = (depths.get(cid) ?? 1) - 1;
					if (d <= 0) {
						depths.delete(cid);
						if (tails.get(cid) === attempt) tails.delete(cid); // don't grow forever on idle conversations
					} else {
						depths.set(cid, d);
					}
					// Only a CONFIRMED delivery becomes idempotent (invariant 4).
					if (res.ok) recordDelivered(wake.messageId, res.runtimeSession);
					return res;
				});
			tails.set(cid, attempt);
			inFlight.set(wake.messageId, attempt);
			return attempt;
		},
	};
}
