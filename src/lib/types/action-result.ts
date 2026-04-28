/**
 * Shared return shape for server actions. Always type the generic so
 * callers can refine the success branch — bare `ActionResult` defaults to
 * `unknown` and discards the type information.
 *
 * Convention:
 *  - Operations that produce a value: ActionResult<MyEntity>
 *  - Operations that don't: ActionResult<null>
 */
export type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };
