import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveReplyTarget } from './replyTarget.ts';

test('returns no fallback reply target when the requested message id is unknown', () => {
  const last = { id: 'last-msg' } as any;
  const batch = [{ msg: { id: 'first-msg' } } as any];

  const target = resolveReplyTarget('missing-msg', batch, last);
  assert.equal(target, undefined);
});

test('returns the matching message from the batch when the id is valid', () => {
  const last = { id: 'last-msg' } as any;
  const batch = [{ msg: { id: 'first-msg' } } as any, { msg: { id: 'second-msg' } } as any];

  const target = resolveReplyTarget('second-msg', batch, last);
  assert.equal(target?.id, 'second-msg');
});
