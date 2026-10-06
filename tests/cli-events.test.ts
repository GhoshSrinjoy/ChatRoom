import test from 'node:test';
import assert from 'node:assert/strict';
import { repetitionBoundary } from '../src/ollama';

test('OCR repetition guard triggers on sustained loops while preserving normal text', () => {
  assert.equal(repetitionBoundary('Normal OCR with two lines.\nAnother line.'), undefined);
  assert.ok(repetitionBoundary('Heading\n' + 'CHATROOM 123\n'.repeat(5)) !== undefined);
});
