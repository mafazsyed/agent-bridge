import test from 'node:test';
import assert from 'node:assert/strict';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { errorCode, resultErrorCode } from '../src/runtime.js';

test('structured runtime limits outrank words in model output; generic auth discussion is not login failure', () => {
  assert.equal(errorCode('reviewed authentication code'), 'runtime_error');
  assert.equal(errorCode('Not authenticated'), 'auth_required');
  assert.equal(errorCode("You've hit your session limit · resets 12:10am"), 'rate_limited');
  assert.equal(resultErrorCode({ subtype: 'error_max_turns', is_error: true, errors: ['authentication discussion'] } as SDKResultMessage), 'error_max_turns');
  assert.equal(resultErrorCode({ subtype: 'success', is_error: false, result: 'authentication failed in the code under review' } as SDKResultMessage), null);
  assert.equal(resultErrorCode({ subtype: 'error_during_execution', is_error: true, errors: ['Not authenticated'] } as SDKResultMessage), 'auth_required');
});
