/** Serializes operations through a single owner without module-global mutable state. */
export type SerialExecutor = { readonly run: <T>(operation: () => Promise<T>) => Promise<T> };

/**
 * Create a queue for related state transitions. Expected errors remain result values;
 * defects reject the caller's promise without poisoning subsequent cleanup operations.
 */
export function createSerialExecutor(): SerialExecutor {
  let tail = Promise.resolve();
  return {
    run: <T>(operation: () => Promise<T>): Promise<T> => {
      const result = tail.then(operation);
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}
