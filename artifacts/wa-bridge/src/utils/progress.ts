/**
 * Coalesce progress messages so a fast worker cannot create an edit storm.
 * The underlying operation remains independent from dashboard delivery.
 */
export function createProgressCoalescer(
  update: (message: string) => Promise<void>,
  intervalMs = 1_500
): { update: (message: string) => Promise<void>; flush: () => Promise<void> } {
  let pending: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastSentAt = 0;
  let chain = Promise.resolve();

  const send = (): void => {
    if (!pending) return;
    const message = pending;
    pending = undefined;
    lastSentAt = Date.now();
    chain = chain.then(() => update(message)).catch(() => {});
  };

  return {
    update: async (message: string): Promise<void> => {
      pending = message;
      const wait = Math.max(0, intervalMs - (Date.now() - lastSentAt));
      if (wait === 0) {
        if (timer) clearTimeout(timer);
        timer = undefined;
        send();
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = undefined;
          send();
        }, wait);
      }
    },
    flush: async (): Promise<void> => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      send();
      await chain;
    },
  };
}
