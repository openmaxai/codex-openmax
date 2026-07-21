// Minimal recurring-timer primitive. The adapter has no scheduler; owner-resync and
// version-check both need "run fn every N ms" with a disposer that stop() can call.
//
// The callback's rejections are swallowed (a periodic background task must never surface
// an unhandledRejection that could crash the process). The timer is unref()'d so it never
// keeps the event loop alive on its own.

/** Run `fn` every `intervalMs` (first run after one interval, not immediately). Returns a
 * disposer that clears the interval — MUST be called from the stop()/teardown path. */
export function everyMs(intervalMs: number, fn: () => void | Promise<void>): () => void {
	const timer = setInterval(() => {
		try {
			void Promise.resolve(fn()).catch(() => {});
		} catch {
			// synchronous throw from fn — swallow, same as a rejected promise.
		}
	}, intervalMs);
	timer.unref?.();
	return () => clearInterval(timer);
}
