// Every interface string exists in both languages, with the same placeholders (docs/SPEC.md §10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STRINGS } from '../public/i18n.js';

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

// Every error code the API can return (SPEC §10), plus the page's own network error.
const ERROR_CODES = [
  'wrong_pin', 'too_many_attempts', 'not_found', 'locked', 'pairing_change', 'count_mismatch', 'match_decided',
  'teams_unknown', 'has_result', 'no_server', 'nothing_to_undo', 'no_draw_needed', 'invalid_input', 'invalid_set',
  'extra_set', 'incomplete', 'draw_mismatch', 'server_error', 'network',
];

test('Vietnamese and English have the same keys', () => {
  assert.deepEqual(Object.keys(STRINGS.vi).sort(), Object.keys(STRINGS.en).sort());
});

test('each string has the same placeholders in both languages', () => {
  for (const key of Object.keys(STRINGS.en)) {
    assert.deepEqual(placeholders(STRINGS.vi[key]), placeholders(STRINGS.en[key]), key);
  }
});

test('every error code has a message', () => {
  for (const code of ERROR_CODES) assert.ok(STRINGS.en[`error_${code}`], code);
});
