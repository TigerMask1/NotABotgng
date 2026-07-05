import test from 'node:test';
import assert from 'node:assert/strict';
import { extractRequestedActivity } from './discordActivities.ts';

test('detects natural play requests', () => {
  assert.equal(extractRequestedActivity("let's play chess with everyone"), 'chess');
  assert.equal(extractRequestedActivity('watch together'), 'watch together');
});

test('detects command-style activity requests', () => {
  assert.equal(extractRequestedActivity('!game watch'), 'watch');
});
