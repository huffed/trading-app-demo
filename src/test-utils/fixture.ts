/**
 * Coerce a partial test fixture to the type the code under test expects
 * WITHOUT changing its runtime shape.
 *
 * Test files build deliberately partial mocks (e.g. a `WalkForwardWindow`
 * with only `total_return` + `max_drawdown`, or a gate result missing its
 * `status` discriminant) because the code under test only reads a subset of
 * fields. This helper lets those fixtures pass `tsc` while keeping the
 * object passed at runtime byte-for-byte identical — it is a type-level
 * cast only (`value as T` via `unknown`), never a transformation.
 *
 * Every call site is a DEBT.md D-05 item: the long-term fix is to complete
 * the fixture (or narrow the parameter type of the code under test), at
 * which point the `asFixture` wrapper at that site should be removed.
 */
export function asFixture<T>(value: unknown): T {
  return value as T;
}
