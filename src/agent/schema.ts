import type { JsonSchema } from "./types";

/** Strict validation for the JSON Schema subset used by the tool registry. Returns messages. */
export function validate(schema: JsonSchema, value: unknown, path = "input"): string[] {
  const errors: string[] = [];
  const type = schema.type;
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [`${path} must be an object`];
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in record)) errors.push(`${path}.${key} is required`);
    }
    for (const [key, child] of Object.entries(record)) {
      const property = schema.properties?.[key];
      if (!property) {
        if (schema.additionalProperties === false) errors.push(`${path}.${key} is not a known field`);
        continue;
      }
      errors.push(...validate(property, child, `${path}.${key}`));
    }
    return errors;
  }
  if (type === "string") {
    if (typeof value !== "string") return [`${path} must be a string`];
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      errors.push(`${path} must be at most ${schema.maxLength} characters`);
    if (schema.enum && !schema.enum.includes(value))
      errors.push(`${path} must be one of ${schema.enum.join(", ")}`);
    return errors;
  }
  if (type === "number" || type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return [`${path} must be a number`];
    if (type === "integer" && !Number.isInteger(value)) errors.push(`${path} must be an integer`);
    if (schema.minimum !== undefined && value < schema.minimum)
      errors.push(`${path} must be ≥ ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum)
      errors.push(`${path} must be ≤ ${schema.maximum}`);
    if (schema.enum && !schema.enum.includes(value))
      errors.push(`${path} must be one of ${schema.enum.join(", ")}`);
    return errors;
  }
  if (type === "boolean") {
    return typeof value === "boolean" ? [] : [`${path} must be a boolean`];
  }
  if (type === "array") {
    if (!Array.isArray(value)) return [`${path} must be an array`];
    if (schema.minItems !== undefined && value.length < schema.minItems)
      errors.push(`${path} must have at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      errors.push(`${path} must have at most ${schema.maxItems} items`);
    if (schema.items) {
      const items = schema.items;
      for (const [index, item] of value.entries()) errors.push(...validate(items, item, `${path}[${index}]`));
    }
    return errors;
  }
  return errors;
}
