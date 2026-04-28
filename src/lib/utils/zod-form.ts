import type { ZodSchema } from "zod";

/**
 * Parse a form's loose state through a Zod schema and return either the
 * typed payload or a flattened error map suitable for inline UI display.
 *
 * Splits errors into:
 *  - fieldErrors: first message per field, keyed by the top-level path key
 *  - unmappedErrors: cross-field / root-level issues without a path
 *
 * Form components surface the field errors next to inputs and the unmapped
 * ones in the global error banner. Replaces the per-form copy of this
 * mapping logic that drifted between trades and journal.
 */
export type ZodFormParseResult<T> =
  | { success: true; data: T }
  | { success: false; fieldErrors: Record<string, string>; unmappedErrors: string[] };

export function parseFormWithZod<T>(
  schema: ZodSchema<T>,
  form: unknown
): ZodFormParseResult<T> {
  const result = schema.safeParse(form);
  if (result.success) {
    return { success: true, data: result.data };
  }
  const fieldErrors: Record<string, string> = {};
  const unmappedErrors: string[] = [];
  for (const issue of result.error.issues) {
    const key = issue.path[0]?.toString();
    if (key) {
      if (!fieldErrors[key]) fieldErrors[key] = issue.message;
    } else {
      unmappedErrors.push(issue.message);
    }
  }
  return { success: false, fieldErrors, unmappedErrors };
}
