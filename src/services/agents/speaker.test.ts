import test from 'node:test';
import assert from 'node:assert/strict';
import { formatShortReply } from './speaker.ts';

test('shortens overly long replies to a compact chat-style snippet', () => {
  const longReply = 'this is a wildly overlong reply that should be turned into something much shorter and more casual for chat';
  const result = formatShortReply(longReply);

  assert.ok(result.length <= 120, 'reply should stay compact');
  assert.ok(result.includes('this') || result.includes('casual') || result.includes('chat'), 'reply should preserve readable text');
});
