import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ERROR_TEMPLATES, errorFields, errorInfo, type ErrorCode } from '../../shared/errors.ts';

test('every error template maps back to its own code', () => {
  for (const [code, tpl] of Object.entries(ERROR_TEMPLATES) as Array<[ErrorCode, string]>) {
    const sample = tpl.replace(/\{(\w+)\}/g, (_, k: string) => `<${k}>`);
    assert.equal(errorInfo(sample)?.code, code, sample);
  }
});

test('error params are extracted; unknown messages get no code', () => {
  assert.deepEqual(errorFields('Out of range (your range is 2)'), { code: 'outOfRange', params: { range: '2' } });
  assert.deepEqual(errorFields('That flag is taken by Bob the Great'), { code: 'flagTaken', params: { name: 'Bob the Great' } });
  assert.deepEqual(errorFields('That username is taken'), { code: 'usernameTaken' });
  assert.deepEqual(errorFields('Something new went wrong'), {});
});
