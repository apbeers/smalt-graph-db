import { describe, expect, test } from 'vitest';
import { SmaltcyError, compile, open } from '../src/index.js';

describe('syntax errors', () => {
  test.each([
    ['MATCH (n RETURN n', /Expected '\)'/],
    ['MATCH (n) RETURN', /Expected an expression/],
    ["RETURN 'abc", /Unterminated string/],
    ['MATCH (a)<-[:R]->(b) RETURN a', /one direction/],
    ['FOO (n)', /Expected a clause/],
  ])('%s', (text, msg) => {
    expect(() => compile(text)).toThrow(msg);
  });

  test('errors give a line and column', () => {
    try {
      compile('MATCH (n)\nRETURN n.');
      throw new Error('no error');
    } catch (err) {
      expect(err).toBeInstanceOf(SmaltcyError);
      expect((err as SmaltcyError).position).toMatchObject({ line: 2 });
    }
  });
});

describe('semantic errors', () => {
  test.each([
    ['MATCH (n) RETURN m', /m is not defined/],
    ['MATCH (n) WITH n.x RETURN n', /needs an alias/],
    ['MATCH (n) RETURN n RETURN n', /last clause/],
    ['MATCH (n)', /add RETURN/],
    ['RETURN 1 AS x UNION RETURN 2 AS y', /same columns/],
    ['MATCH (n) WHERE count(n) > 1 RETURN n', /aggregate/],
    ['RETURN nosuch(1)', /Unknown function/],
    ['MATCH (n)-[r]->(m), (m)-[r]->(o) RETURN n', /twice/],
  ])('%s', (text, msg) => {
    expect(() => compile(text)).toThrow(msg);
  });
});

describe('expressions', () => {
  const g = open();
  test.each([
    ['RETURN 1 + 2 * 3 AS v', 7],
    ['RETURN (1 + 2) * 3 AS v', 9],
    ['RETURN 2 ^ 3 AS v', 8],
    ['RETURN 7 / 2 AS v', 3],
    ['RETURN 7.0 / 2 AS v', 3.5],
    ['RETURN -7 % 3 AS v', -1],
    ["RETURN 'a' + 1 AS v", 'a1'],
    ['RETURN [1, 2] + 3 AS v', [1, 2, 3]],
    ['RETURN [1, 2, 3][-1] AS v', 3],
    ['RETURN [1, 2, 3, 4][1..3] AS v', [2, 3]],
    ['RETURN {a: {b: 2}}.a.b AS v', 2],
    ['RETURN null = null AS v', null],
    ['RETURN null IS NULL AS v', true],
    ['RETURN true XOR false AS v', true],
    ['RETURN NOT null AS v', null],
    ['RETURN false AND null AS v', false],
    ['RETURN 1 IN [1, null] AS v', true],
    ['RETURN 2 IN [1, null] AS v', null],
    ["RETURN toUpper('abc') AS v", 'ABC'],
    ["RETURN split('a,b', ',') AS v", ['a', 'b']],
    ["RETURN substring('hello', 1, 3) AS v", 'ell'],
    ["RETURN toInteger('42') AS v", 42],
    ["RETURN toInteger('x') AS v", null],
    ['RETURN toString(2.0) AS v', '2.0'],
    ['RETURN coalesce(null, 3) AS v', 3],
    ['RETURN size([1, 2]) AS v', 2],
    ['RETURN range(1, 10, 3) AS v', [1, 4, 7, 10]],
    ['RETURN [x IN range(1, 5) WHERE x % 2 = 1 | x * 10] AS v', [10, 30, 50]],
    ["RETURN CASE 2 WHEN 1 THEN 'one' WHEN 2 THEN 'two' END AS v", 'two'],
    ['RETURN round(2.5) AS v', 3],
    ['RETURN abs(-3) AS v', 3],
    ['RETURN 0x1F AS v', 31],
    ['RETURN 1e3 AS v', 1000],
    ["RETURN 'it\\'s' AS v", "it's"],
    ['RETURN `weird name` AS v', undefined],
  ])('%s', (text, v) => {
    if (v === undefined) {
      expect(() => g.query(text)).toThrow(/not defined/);
      return;
    }
    expect(g.query(text)[0]!.v).toEqual(v);
  });

  test('division by zero', () => {
    expect(() => g.query('RETURN 1 / 0 AS v')).toThrow(/zero/);
    expect(g.query('RETURN 1.0 / 0 AS v')[0]!.v).toBe(Infinity);
  });

  test('missing parameter', () => {
    expect(() => g.query('RETURN $x AS v')).toThrow(/\$x/);
    expect(g.query('RETURN $x AS v', { x: [1, 'a'] })).toEqual([{ v: [1, 'a'] }]);
  });

  test('comments', () => {
    expect(g.query('RETURN 1 AS v // one\n /* two */')).toEqual([{ v: 1 }]);
  });
});
