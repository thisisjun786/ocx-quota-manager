import test from 'node:test';
import assert from 'node:assert/strict';

// The cost screen's note for local tool records a period leaves out, from the embedded UI module.
const { nativeExcludedNotes } = await import('../webembed/static/views.js');

test('no note when nothing is left out', () => {
  assert.deepEqual(nativeExcludedNotes({}), []);
  assert.deepEqual(nativeExcludedNotes({ claude: 0 }), []);
});

test('the Claude Code note does not promise that OCX calls are already in the total', () => {
  const [note] = nativeExcludedNotes({ claude: 1234 });
  assert.match(note, /1,234건/);
  assert.match(note, /OCX 사용 기록에서 집계/);
  assert.match(note, /수집과 가격 확인이 끝난 만큼/);
  assert.doesNotMatch(note, /합계에 포함됩니다/);
});

test('the Antigravity note covers both an unknown route and conflicting records', () => {
  const notes = nativeExcludedNotes({ claude: 2, antigravity: 3 });
  assert.equal(notes.length, 2);
  assert.match(notes[1], /Antigravity 기록 3건/);
  assert.match(notes[1], /확인할 수 없거나 기록 정보가 서로 엇갈려/);
});
