// Deterministic JSON serialisation for signing (a subset of RFC 8785 JCS):
// object keys sorted by UTF-16 code unit, no whitespace, no undefined,
// no functions, no NaN/Infinity, no non-finite numbers. Two records with the
// same content always produce the same bytes regardless of insertion order.

export function canonicalize(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite number');
    if (!Number.isInteger(value)) throw new TypeError('only integers are canonical here');
    return String(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (t === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
  }
  throw new TypeError(`cannot canonicalize ${t}`);
}
