#!/usr/bin/env node
/**
 * Minimal JSON Schema (draft 2020-12 subset) validator for Labelfaster fixtures.
 * Supports: type, required, properties, additionalProperties:false, const, enum,
 * items, minItems, minLength, minimum, exclusiveMinimum, pattern, integer-as-type:number.
 * Deliberately small: fixtures validate against the exact keywords used in our schemas.
 */
import { readFileSync } from 'node:fs';

function validate(value, schema, path, errors) {
  const typeOf = (v) =>
    v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v;

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} not in enum [${schema.enum.join(', ')}]`);
    return;
  }
  if (schema.type) {
    const t = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    const ok = t.includes(actual) || (t.includes('number') && actual === 'integer') || (t.includes('integer') && actual === 'integer');
    if (!ok) {
      errors.push(`${path}: expected type ${t.join('|')}, got ${actual}`);
      return;
    }
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: minLength ${schema.minLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: pattern ${schema.pattern} mismatch`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: minimum ${schema.minimum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push(`${path}: exclusiveMinimum ${schema.exclusiveMinimum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: minItems ${schema.minItems}`);
    if (schema.items) value.forEach((item, i) => validate(item, schema.items, `${path}[${i}]`, errors));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}: missing required '${key}'`);
    }
    const props = schema.properties ?? {};
    for (const [key, sub] of Object.entries(props)) {
      if (key in value) validate(value[key], sub, `${path}.${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) errors.push(`${path}: additional property '${key}' not allowed`);
      }
    }
  }
}

export function validateAgainstSchema(doc, schemaPath) {
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  const errors = [];
  validate(doc, schema, '$', errors);
  validateTimeMonotonic(doc, errors);
  return errors;
}

/** 领域规则（契约 §2）：referenceFrames 与 pose 时间必须严格递增。 */
function validateTimeMonotonic(doc, errors) {
  const check = (list, label) => {
    if (!Array.isArray(list)) return;
    for (let i = 1; i < list.length; i++) {
      if (!(list[i].timeUs > list[i - 1].timeUs)) {
        errors.push(`${label}[${i}]: timeUs must be strictly increasing (${list[i - 1].timeUs} -> ${list[i].timeUs})`);
      }
    }
  };
  check(doc.referenceFrames, '$.referenceFrames');
  if (doc.pose) check(doc.pose.frames, '$.pose.frames');
}

// CLI: node validate-manifest.mjs <schema> <instance> [...more instances]
if (process.argv[1] && process.argv[1].endsWith('validate-manifest.mjs')) {
  const [schema, ...instances] = process.argv.slice(2);
  let failures = 0;
  for (const file of instances) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      console.log(`INVALID(JSON) ${file}: ${e.message}`);
      failures++;
      continue;
    }
    const errors = validateAgainstSchema(doc, schema);
    if (errors.length === 0) console.log(`VALID    ${file}`);
    else {
      console.log(`INVALID  ${file}:`);
      for (const err of errors.slice(0, 8)) console.log(`   - ${err}`);
      failures++;
    }
  }
  process.exit(failures > 0 ? 1 : 0);
}
