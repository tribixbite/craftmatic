import { describe, it, expect } from 'vitest';
import { csvField, detectDelimiter, parseCsv, parseCsvRows, parseTextList, toCsv } from './csv.ts';

describe('parseCsvRows', () => {
  it('handles quoted fields, doubled quotes, embedded newlines and CRLF', () => {
    const rows = parseCsvRows('a,b\r\n"x, y","say ""hi"""\r\n"multi\nline",z\r\n');
    expect(rows).toEqual([['a', 'b'], ['x, y', 'say "hi"'], ['multi\nline', 'z']]);
  });
  it('drops blank lines and keeps a final unterminated row', () => {
    expect(parseCsvRows('a\n\nb')).toEqual([['a'], ['b']]);
  });
});

describe('detectDelimiter', () => {
  it('prefers the delimiter that splits the first line most', () => {
    expect(detectDelimiter('set\tname\n1\t2')).toBe('\t');
    expect(detectDelimiter('set;name')).toBe(';');
    expect(detectDelimiter('set,name')).toBe(',');
  });
});

describe('parseCsv', () => {
  it('uses a recognised header', () => {
    const p = parseCsv('set_num,name,year\n71043-1,Hogwarts Castle,2018\n10294-1,Titanic,2021\n');
    expect(p.header).toEqual(['set_num', 'name', 'year']);
    expect(p.records[1]).toEqual({ set_num: '10294-1', name: 'Titanic', year: '2021' });
  });
  it('names a header-less single column by what it looks like', () => {
    expect(parseCsv('71043\n10294').records).toEqual([{ set: '71043' }, { set: '10294' }]);
    expect(parseCsv('OMR/10001-1.mpd\nIO/21063.io').records).toEqual([{ path: 'OMR/10001-1.mpd' }, { path: 'IO/21063.io' }]);
  });
  it('is empty for empty text', () => { expect(parseCsv('')).toEqual({ header: [], records: [] }); });
});

describe('parseTextList', () => {
  it('classifies each line and skips comments', () => {
    expect(parseTextList('# note\n71043\n\nLDR/x y.ldr\nC:\\a\\b.mcaddon')).toEqual([{ set: '71043' }, { path: 'LDR/x y.ldr' }, { path: 'C:\\a\\b.mcaddon' }]);
  });
});

describe('toCsv', () => {
  it('quotes what needs quoting and serialises objects as JSON', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "x"')).toBe('"say ""x"""');
    expect(csvField([1, 2])).toBe('"[1,2]"');
    expect(csvField(null)).toBe('');
    const out = toCsv(['a', 'b'], [{ a: 1, b: 'x,y' }, { a: 2 }]);
    expect(out).toBe('a,b\r\n1,"x,y"\r\n2,\r\n');
  });
});
