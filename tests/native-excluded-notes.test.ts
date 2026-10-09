import test from 'node:test';
import assert from 'node:assert/strict';

// The cost screen's note for local tool records a period leaves out, from the embedded UI module.
const { nativeExcludedNotes } = await import('../webembed/static/views.js');

test('no note when nothing is left out', () => {
  assert.deepEqual(nativeExcludedNotes({}), []);
  assert.deepEqual(nativeExcludedNotes({ claude: 0 }), []);
});

test('Claude Code transcripts produce no cost note', () => {
  assert.deepEqual(nativeExcludedNotes({ claude: 1234 }), []);
});

test('the Antigravity note covers both an unknown route and conflicting records', () => {
  const notes = nativeExcludedNotes({ claude: 2, antigravity: 3 });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /Antigravity 기록 3건/);
  assert.match(notes[0], /확인할 수 없거나 기록 정보가 서로 엇갈려/);
});
