export type Failure = { readonly _tag: string; readonly message: string };

export type Ok<T> = { readonly _tag: "ok"; readonly value: T };

export type Err<E extends Failure> = { readonly _tag: "err"; readonly error: E };

export type Result<T, E extends Failure> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { _tag: "ok", value };
}

export function err<E extends Failure>(error: E): Err<E> {
  return { _tag: "err", error };
}
