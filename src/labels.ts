import { LABEL_VALID_CHARS } from "./constants.js";

/**
 * Sanitize a label key. Do not apply this transformation to label values.
 * Strips quotes, replaces spaces/dots/dashes with underscores, removes
 * any remaining invalid characters.
 */
export function sanitizeLabel(value: string): string {
  let result = value;
  // Strip surrounding quotes
  result = result.replace(/^["']|["']$/g, "");
  // Replace spaces, dots, and dashes with underscores
  result = result.replace(/[\s.\-]/g, "_");
  // Remove any remaining invalid characters
  result = result.replace(LABEL_VALID_CHARS, "");
  return result;
}

/**
 * Sanitize label keys while preserving values verbatim.
 * Values are escaped by JSON serialization when the payload is sent.
 */
export function sanitizeLabels(
  labels: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of Object.keys(labels)) {
    const sanitizedKey = sanitizeLabel(key);
    if (sanitizedKey.length > 0) {
      result[sanitizedKey] = labels[key];
    }
  }
  return result;
}
