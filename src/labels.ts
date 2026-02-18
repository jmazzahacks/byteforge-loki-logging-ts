import { LABEL_VALID_CHARS } from "./constants.js";

/**
 * Sanitize a single label key or value for Prometheus/Loki compatibility.
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
 * Sanitize all keys and values in a labels record.
 */
export function sanitizeLabels(
  labels: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of Object.keys(labels)) {
    const sanitizedKey = sanitizeLabel(key);
    const sanitizedValue = sanitizeLabel(labels[key]);
    if (sanitizedKey.length > 0) {
      result[sanitizedKey] = sanitizedValue;
    }
  }
  return result;
}
