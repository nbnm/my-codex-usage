import {describe, expect, it} from 'vitest';
import {JsonLineDecoder} from '../../src/codex/jsonl.js';

describe('JsonLineDecoder', () => {
  it('handles split, combined, CRLF, and blank lines', () => {
    const decoder = new JsonLineDecoder();
    expect(decoder.push(Buffer.from('{"id":1'))).toEqual([]);
    expect(
      decoder.push(Buffer.from('}\n\n{"id":2}\r\n{"id":3}\n'))
    ).toEqual([{id: 1}, {id: 2}, {id: 3}]);
    expect(() => decoder.finish()).not.toThrow();
  });

  it('rejects malformed, invalid UTF-8, oversized, and incomplete lines', () => {
    expect(() => new JsonLineDecoder().push(Buffer.from('{oops}\n'))).toThrow(
      /malformed JSON/u
    );
    expect(() =>
      new JsonLineDecoder().push(Buffer.from([0xff, 0x0a]))
    ).toThrow(/malformed JSON/u);
    expect(() =>
      new JsonLineDecoder(4).push(Buffer.from('12345'))
    ).toThrow(/oversized/u);
    const incomplete = new JsonLineDecoder();
    incomplete.push(Buffer.from('{"id":1}'));
    expect(() => incomplete.finish()).toThrow(/incomplete/u);
  });
});
