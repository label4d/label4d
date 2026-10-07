"""Validate fixture manifests against the repository's JSON Schema subset and time rules."""
import argparse
import json
import math
from pathlib import Path
import re


def value_type(value):
    if value is None:
        return 'null'
    if isinstance(value, bool):
        return 'boolean'
    if isinstance(value, (int, float)):
        return 'integer' if math.isfinite(value) and int(value) == value else 'number'
    return {str: 'string', list: 'array', dict: 'object'}.get(type(value), 'unknown')


def validate(value, schema, path, errors):
    if 'const' in schema and (value != schema['const'] or isinstance(value, bool) != isinstance(schema['const'], bool)):
        errors.append(f'{path}: expected const {schema["const"]}')
        return
    if 'enum' in schema and value not in schema['enum']:
        errors.append(f'{path}: value not in enum')
        return
    actual = value_type(value)
    if 'type' in schema:
        allowed = schema['type'] if isinstance(schema['type'], list) else [schema['type']]
        if actual not in allowed and not (actual == 'integer' and 'number' in allowed):
            errors.append(f'{path}: expected type {allowed}, got {actual}')
            return
    if actual == 'string':
        if len(value) < schema.get('minLength', 0):
            errors.append(f'{path}: minLength')
        if 'pattern' in schema and not re.search(schema['pattern'], value):
            errors.append(f'{path}: pattern mismatch')
    if actual in ('integer', 'number'):
        if not math.isfinite(value):
            errors.append(f'{path}: number must be finite')
        if 'minimum' in schema and value < schema['minimum']:
            errors.append(f'{path}: minimum {schema["minimum"]}')
        if 'exclusiveMinimum' in schema and value <= schema['exclusiveMinimum']:
            errors.append(f'{path}: exclusiveMinimum {schema["exclusiveMinimum"]}')
    if actual == 'array':
        if len(value) < schema.get('minItems', 0):
            errors.append(f'{path}: minItems')
        if 'items' in schema:
            for index, item in enumerate(value):
                validate(item, schema['items'], f'{path}[{index}]', errors)
    if actual == 'object':
        for key in schema.get('required', []):
            if key not in value:
                errors.append(f'{path}: missing required {key}')
        properties = schema.get('properties', {})
        for key, child in properties.items():
            if key in value:
                validate(value[key], child, f'{path}.{key}', errors)
        if schema.get('additionalProperties') is False:
            for key in value.keys() - properties.keys():
                errors.append(f'{path}: additional property {key} not allowed')


def validate_manifest(document, schema):
    errors = []
    validate(document, schema, '$', errors)
    if isinstance(document, dict):
        pose = document.get('pose')
        timelines = [document.get('referenceFrames'), pose.get('frames') if isinstance(pose, dict) else None]
        for timeline in timelines:
            if not isinstance(timeline, list):
                continue
            for index in range(1, len(timeline)):
                previous, current = timeline[index - 1], timeline[index]
                if isinstance(previous, dict) and isinstance(current, dict):
                    a, b = previous.get('timeUs'), current.get('timeUs')
                    if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not b > a:
                        errors.append(f'timeline[{index}]: timeUs must be strictly increasing ({a} -> {b})')
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--json', action='store_true', help='Machine-readable results for preflight')
    parser.add_argument('schema', type=Path)
    parser.add_argument('instances', type=Path, nargs='+')
    args = parser.parse_args()
    schema = json.loads(args.schema.read_text())
    results = []
    for path in args.instances:
        try:
            errors = validate_manifest(json.loads(path.read_text()), schema)
        except (OSError, json.JSONDecodeError) as error:
            errors = [f'Invalid JSON input: {error}']
        results.append({'file': str(path), 'errors': errors})
    if args.json:
        print(json.dumps(results))
    else:
        for result in results:
            print(f'{"INVALID" if result["errors"] else "VALID"} {result["file"]}')
            for error in result['errors'][:8]:
                print(f'  - {error}')
    return int(any(result['errors'] for result in results))


if __name__ == '__main__':
    raise SystemExit(main())
