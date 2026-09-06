export type SerialExecutor = { readonly run: <T>(operation: () => Promise<T>) => Promise<T> };

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
