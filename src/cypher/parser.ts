/**
 * A hand-written recursive-descent parser for smaltcy's Cypher, with precedence climbing for expressions.
 */
import { SmaltcyError } from '../errors.js';
import type { Clause, Expr, NodePattern, PatternPart, Projection, RelPattern, RemoveItem, ReturnItem, SetItem, Span, Statement } from './ast.js';

type TokKind = 'ident' | 'qident' | 'num' | 'str' | 'param' | 'punct' | 'eof';

interface Token {
  readonly k: TokKind;
  readonly v: string;
  readonly start: number;
  readonly end: number;
  readonly num?: number;
}

const PUNCT = ['<>', '<=', '>=', '!=', '=~', '..', '+=', '->', '<-', '(', ')', '[', ']', '{', '}', ',', '.', ':', '|', ';', '=', '<', '>', '+', '-', '*', '/', '%', '^', '$'];

function position(src: string, offset: number) {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset && i < src.length; i++) {
    if (src[i] === '\n') {
      line++;
      col = 1;
    } else col++;
  }
  return { offset, line, column: col };
}

function syntaxError(src: string, offset: number, msg: string): never {
  const p = position(src, offset);
  throw new SmaltcyError('SMALTCY_SYNTAX', `${msg} (line ${p.line}, column ${p.column})`, p);
}

export function lex(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      if (e < 0) syntaxError(src, i, 'Unterminated comment');
      i = e + 2;
      continue;
    }
    const start = i;
    if (/[A-Za-z_]/.test(c)) {
      while (i < n && /[A-Za-z0-9_]/.test(src[i]!)) i++;
      out.push({ k: 'ident', v: src.slice(start, i), start, end: i });
      continue;
    }
    if (c === '`') {
      let v = '';
      i++;
      while (true) {
        if (i >= n) syntaxError(src, start, 'Unterminated `name`');
        if (src[i] === '`') {
          if (src[i + 1] === '`') {
            v += '`';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        v += src[i++];
      }
      out.push({ k: 'qident', v, start, end: i });
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      if (c === '0' && /[xX]/.test(src[i + 1] ?? '')) {
        i += 2;
        while (i < n && /[0-9a-fA-F]/.test(src[i]!)) i++;
        out.push({ k: 'num', v: src.slice(start, i), start, end: i, num: parseInt(src.slice(start + 2, i), 16) });
        continue;
      }
      while (i < n && /[0-9]/.test(src[i]!)) i++;
      // `1..3` is a range, not a float.
      if (src[i] === '.' && src[i + 1] !== '.' && /[0-9]/.test(src[i + 1] ?? '')) {
        i++;
        while (i < n && /[0-9]/.test(src[i]!)) i++;
      }
      if (/[eE]/.test(src[i] ?? '') && /[0-9+-]/.test(src[i + 1] ?? '')) {
        i += 2;
        while (i < n && /[0-9]/.test(src[i]!)) i++;
      }
      const text = src.slice(start, i);
      out.push({ k: 'num', v: text, start, end: i, num: Number(text) });
      continue;
    }
    if (c === "'" || c === '"') {
      let v = '';
      i++;
      while (true) {
        if (i >= n) syntaxError(src, start, 'Unterminated string');
        const d = src[i]!;
        if (d === c) {
          i++;
          break;
        }
        if (d === '\\') {
          const e = src[i + 1];
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '\\': '\\', "'": "'", '"': '"' };
          if (e === 'u') {
            v += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16));
            i += 6;
            continue;
          }
          if (e === undefined || !(e in map)) syntaxError(src, i, 'Unknown escape in string');
          v += map[e]!;
          i += 2;
          continue;
        }
        v += d;
        i++;
      }
      out.push({ k: 'str', v, start, end: i });
      continue;
    }
    if (c === '$') {
      i++;
      if (src[i] === '`') {
        const e = src.indexOf('`', i + 1);
        out.push({ k: 'param', v: src.slice(i + 1, e), start, end: e + 1 });
        i = e + 1;
        continue;
      }
      while (i < n && /[A-Za-z0-9_]/.test(src[i]!)) i++;
      if (i === start + 1) syntaxError(src, start, 'A parameter needs a name');
      out.push({ k: 'param', v: src.slice(start + 1, i), start, end: i });
      continue;
    }
    const p = PUNCT.find((x) => src.startsWith(x, i));
    if (!p) syntaxError(src, i, `Unexpected character ${JSON.stringify(c)}`);
    // `<-` and `->` are only arrows next to a dash or bracket; `a<-1` is a comparison.
    if (p === '<-' || p === '->') {
      out.push({ k: 'punct', v: p[0]!, start: i, end: i + 1 });
      out.push({ k: 'punct', v: p[1]!, start: i + 1, end: i + 2 });
      i += 2;
      continue;
    }
    out.push({ k: 'punct', v: p, start: i, end: i + p.length });
    i += p.length;
  }
  out.push({ k: 'eof', v: '', start: n, end: n });
  return out;
}


const CLAUSE_START = new Set(['MATCH', 'OPTIONAL', 'UNWIND', 'WITH', 'RETURN', 'CREATE', 'MERGE', 'SET', 'REMOVE', 'DELETE', 'DETACH', 'UNION']);

export function parse(src: string): Statement {
  return new Parser(src).statement();
}

class Parser {
  private readonly toks: Token[];
  private pos = 0;
  private anon = 0;

  constructor(private readonly src: string) {
    this.toks = lex(src);
  }

  private get t(): Token {
    return this.toks[this.pos]!;
  }
  private peek(k = 1): Token {
    return this.toks[Math.min(this.pos + k, this.toks.length - 1)]!;
  }
  private next(): Token {
    return this.toks[this.pos++]!;
  }
  private fail(msg: string, tok = this.t): never {
    return syntaxError(this.src, tok.start, msg);
  }
  private isKw(kw: string, tok = this.t): boolean {
    return tok.k === 'ident' && tok.v.toUpperCase() === kw;
  }
  private kw(kw: string): boolean {
    if (this.isKw(kw)) {
      this.pos++;
      return true;
    }
    return false;
  }
  private expectKw(kw: string): void {
    if (!this.kw(kw)) this.fail(`Expected ${kw}${this.t.k === 'eof' ? ' at the end' : `, found ${this.t.v || this.t.k}`}`);
  }
  private is(p: string, tok = this.t): boolean {
    return tok.k === 'punct' && tok.v === p;
  }
  private eat(p: string): boolean {
    if (this.is(p)) {
      this.pos++;
      return true;
    }
    return false;
  }
  private expect(p: string): Token {
    if (!this.is(p)) this.fail(`Expected '${p}'${this.t.k === 'eof' ? ' at the end' : `, found '${this.t.v || this.t.k}'`}`);
    return this.next();
  }
  private name(what = 'a name'): string {
    const t = this.t;
    if (t.k === 'ident' || t.k === 'qident') {
      this.pos++;
      return t.v;
    }
    return this.fail(`Expected ${what}, found '${t.v || t.k}'`);
  }
  private span(start: number): Span {
    return { start, end: this.toks[this.pos - 1]!.end };
  }

  statement(): Statement {
    const explain = this.kw('EXPLAIN');
    let st: Statement;
    if (this.isKw('CREATE') && this.isKw('INDEX', this.peek())) st = this.createIndex(explain);
    else if (this.isKw('DROP')) st = this.dropIndex(explain);
    else {
      // AT VERSION n / AT TIME t: the query reads the graph as it was.
      let asOf: { version: Expr } | { time: Expr } | undefined;
      if (this.isKw('AT') && (this.isKw('VERSION', this.peek()) || this.isKw('TIME', this.peek()))) {
        this.next();
        const which = this.next().v.toUpperCase();
        const x = this.unary();
        asOf = which === 'VERSION' ? { version: x } : { time: x };
      }
      st = { ...(this.query(explain) as Extract<Statement, { t: 'query' }>), ...(asOf ? { asOf } : {}) };
    }
    this.eat(';');
    if (this.t.k !== 'eof') this.fail(`Unexpected '${this.t.v}'`);
    return st;
  }

  private createIndex(explain: boolean): Statement {
    this.expectKw('CREATE');
    this.expectKw('INDEX');
    if (this.kw('ON')) return this.oldIndex('createIndex', explain);
    if (!this.isKw('FOR') && !this.isKw('IF')) this.name('an index name');
    if (this.kw('IF')) {
      this.expectKw('NOT');
      this.expectKw('EXISTS');
    }
    this.expectKw('FOR');
    this.expect('(');
    const v = this.name('a variable');
    this.expect(':');
    const label = this.name('a label');
    this.expect(')');
    this.expectKw('ON');
    this.expect('(');
    const v2 = this.name('a variable');
    if (v2 !== v) this.fail(`Expected ${v}`);
    this.expect('.');
    const key = this.name('a property key');
    this.expect(')');
    return { t: 'createIndex', label, key, explain };
  }

  private dropIndex(explain: boolean): Statement {
    this.expectKw('DROP');
    this.expectKw('INDEX');
    this.expectKw('ON');
    return this.oldIndex('dropIndex', explain);
  }

  private oldIndex(t: 'createIndex' | 'dropIndex', explain: boolean): Statement {
    this.expect(':');
    const label = this.name('a label');
    this.expect('(');
    const key = this.name('a property key');
    this.expect(')');
    return { t, label, key, explain };
  }

  private query(explain: boolean): Statement {
    const parts: Clause[][] = [this.clauses()];
    const unionAll: boolean[] = [];
    while (this.kw('UNION')) {
      unionAll.push(this.kw('ALL'));
      parts.push(this.clauses());
    }
    return { t: 'query', parts, unionAll, explain };
  }

  private clauses(): Clause[] {
    const out: Clause[] = [];
    while (this.t.k === 'ident' && CLAUSE_START.has(this.t.v.toUpperCase()) && !this.isKw('UNION')) out.push(this.clause());
    if (out.length === 0) this.fail(this.t.k === 'eof' ? 'Expected a query' : `Expected a clause such as MATCH or RETURN, found '${this.t.v}'`);
    return out;
  }

  private clause(): Clause {
    const start = this.t.start;
    const kw = this.next().v.toUpperCase();
    switch (kw) {
      case 'OPTIONAL':
        this.expectKw('MATCH');
        return this.match(start, true);
      case 'MATCH':
        return this.match(start, false);
      case 'UNWIND': {
        const list = this.expr();
        this.expectKw('AS');
        return { t: 'unwind', list, name: this.name('a variable'), ...this.span(start) };
      }
      case 'WITH': {
        const proj = this.projection();
        const where = this.kw('WHERE') ? this.expr() : undefined;
        return { t: 'with', proj, where, ...this.span(start) };
      }
      case 'RETURN':
        return { t: 'return', proj: this.projection(), ...this.span(start) };
      case 'CREATE':
        return { t: 'create', pattern: this.pattern(), ...this.span(start) };
      case 'MERGE': {
        const part = this.patternPart();
        const onCreate: SetItem[] = [];
        const onMatch: SetItem[] = [];
        while (this.isKw('ON')) {
          this.next();
          const which = this.kw('CREATE') ? onCreate : (this.expectKw('MATCH'), onMatch);
          this.expectKw('SET');
          which.push(...this.setItems());
        }
        return { t: 'merge', part, onCreate, onMatch, ...this.span(start) };
      }
      case 'SET':
        return { t: 'set', items: this.setItems(), ...this.span(start) };
      case 'REMOVE': {
        const items: RemoveItem[] = [];
        do {
          const s = this.t;
          const name = this.name('a variable');
          if (this.is(':')) {
            const labels: string[] = [];
            while (this.eat(':')) labels.push(this.name('a label'));
            items.push({ t: 'labels', name, labels });
          } else {
            let target: Expr = { t: 'var', name, start: s.start, end: s.end };
            this.expect('.');
            let key = this.name('a property key');
            while (this.eat('.')) {
              target = { t: 'prop', of: target, key, start: s.start, end: this.t.start };
              key = this.name('a property key');
            }
            items.push({ t: 'prop', target, key });
          }
        } while (this.eat(','));
        return { t: 'remove', items, ...this.span(start) };
      }
      case 'DETACH':
        this.expectKw('DELETE');
        return { t: 'delete', detach: true, exprs: this.exprList(), ...this.span(start) };
      case 'DELETE':
        return { t: 'delete', detach: false, exprs: this.exprList(), ...this.span(start) };
    }
    return this.fail(`Unexpected ${kw}`);
  }

  private match(start: number, optional: boolean): Clause {
    const pattern = this.pattern();
    const where = this.kw('WHERE') ? this.expr() : undefined;
    return { t: 'match', optional, pattern, where, ...this.span(start) };
  }

  private exprList(): Expr[] {
    const out = [this.expr()];
    while (this.eat(',')) out.push(this.expr());
    return out;
  }

  private setItems(): SetItem[] {
    const out: SetItem[] = [];
    do {
      const s = this.t;
      const name = this.name('a variable');
      if (this.is(':')) {
        const labels: string[] = [];
        while (this.eat(':')) labels.push(this.name('a label'));
        out.push({ t: 'labels', name, labels });
      } else if (this.eat('=')) {
        out.push({ t: 'props', name, value: this.expr(), merge: false });
      } else if (this.eat('+=')) {
        out.push({ t: 'props', name, value: this.expr(), merge: true });
      } else {
        let target: Expr = { t: 'var', name, start: s.start, end: s.end };
        this.expect('.');
        let key = this.name('a property key');
        while (this.eat('.')) {
          target = { t: 'prop', of: target, key, start: s.start, end: this.t.start };
          key = this.name('a property key');
        }
        this.expect('=');
        out.push({ t: 'prop', target, key, value: this.expr() });
      }
    } while (this.eat(','));
    return out;
  }

  private projection(): Projection {
    const distinct = this.kw('DISTINCT');
    let star = false;
    const items: ReturnItem[] = [];
    if (this.eat('*')) {
      star = true;
      if (this.eat(',')) items.push(...this.returnItems());
    } else items.push(...this.returnItems());
    const order: { expr: Expr; desc: boolean }[] = [];
    if (this.kw('ORDER')) {
      this.expectKw('BY');
      do {
        const expr = this.expr();
        let desc = false;
        if (this.kw('DESC') || this.kw('DESCENDING')) desc = true;
        else if (!this.kw('ASC')) this.kw('ASCENDING');
        order.push({ expr, desc });
      } while (this.eat(','));
    }
    const skip = this.kw('SKIP') ? this.expr() : undefined;
    const limit = this.kw('LIMIT') ? this.expr() : undefined;
    return { distinct, star, items, order, skip, limit };
  }

  private returnItems(): ReturnItem[] {
    const out: ReturnItem[] = [];
    do {
      const expr = this.expr();
      const text = this.src.slice(expr.start, expr.end);
      const alias = this.kw('AS') ? this.name('an alias') : undefined;
      out.push({ expr, alias, text });
    } while (this.eat(','));
    return out;
  }

  // Patterns.

  private pattern(): PatternPart[] {
    const out = [this.patternPart()];
    while (this.eat(',')) out.push(this.patternPart());
    return out;
  }

  private patternPart(): PatternPart {
    const start = this.t.start;
    let path: string | undefined;
    if ((this.t.k === 'ident' || this.t.k === 'qident') && this.is('=', this.peek())) {
      path = this.name();
      this.expect('=');
    }
    let shortest: 'one' | 'all' | undefined;
    if (this.isKw('SHORTESTPATH') || this.isKw('ALLSHORTESTPATHS')) {
      shortest = this.next().v.toUpperCase() === 'SHORTESTPATH' ? 'one' : 'all';
      this.expect('(');
      const inner = this.patternElement(start);
      this.expect(')');
      if (inner.rels.length !== 1) this.fail('A shortest path has exactly one relationship');
      return { ...inner, path, shortest, ...this.span(start) };
    }
    return { ...this.patternElement(start), path };
  }

  private patternElement(start: number): PatternPart {
    if (this.is('(') && this.is('(', this.peek())) {
      this.next();
      const inner = this.patternElement(this.t.start);
      this.expect(')');
      return inner;
    }
    const nodes = [this.nodePattern()];
    const rels: RelPattern[] = [];
    while (this.is('-') || this.is('<')) {
      rels.push(this.relPattern());
      nodes.push(this.nodePattern());
    }
    return { nodes, rels, ...this.span(start) };
  }

  private nodePattern(): NodePattern {
    const start = this.expect('(').start;
    let name: string | undefined;
    if (this.t.k === 'ident' || this.t.k === 'qident') name = this.name();
    const labels: string[] = [];
    while (this.eat(':')) {
      labels.push(this.name('a label'));
      // `:A|B` isn't a node label expression in this subset.
    }
    let props: Expr | undefined;
    if (this.is('{')) props = this.primary();
    else if (this.t.k === 'param') props = this.primary();
    this.expect(')');
    return { name, labels, props, ...this.span(start) };
  }

  private relPattern(): RelPattern {
    const start = this.t.start;
    const left = this.eat('<');
    this.expect('-');
    let name: string | undefined;
    const types: string[] = [];
    let props: Expr | undefined;
    let hops: { min?: number; max?: number } | undefined;
    if (this.eat('[')) {
      if (this.t.k === 'ident' || this.t.k === 'qident') name = this.name();
      if (this.eat(':')) {
        types.push(this.name('a relationship type'));
        while (this.eat('|')) {
          this.eat(':');
          types.push(this.name('a relationship type'));
        }
      }
      if (this.eat('*')) {
        const int = () => {
          const t = this.next();
          if (t.k !== 'num' || !Number.isInteger(t.num)) this.fail('Expected a whole number of hops', t);
          return t.num!;
        };
        let min: number | undefined;
        let max: number | undefined;
        if (this.t.k === 'num') min = int();
        if (this.eat('..')) {
          if (this.t.k === 'num') max = int();
        } else if (min !== undefined) max = min;
        hops = { min: min ?? 1, max };
      }
      if (this.is('{') || this.t.k === 'param') props = this.primary();
      this.expect(']');
    }
    this.expect('-');
    const right = this.eat('>');
    if (left && right) this.fail('A relationship has one direction');
    return { name, dir: left ? 'in' : right ? 'out' : 'both', types, props, hops, ...this.span(start) };
  }

  // Expressions, lowest precedence first.

  expr(): Expr {
    return this.or();
  }

  private binaryLevel(next: () => Expr, ops: string[]): Expr {
    let a = next();
    while (this.t.k === 'ident' && ops.includes(this.t.v.toUpperCase())) {
      const op = this.next().v.toLowerCase();
      const b = next();
      a = { t: 'binary', op, a, b, start: a.start, end: b.end };
    }
    return a;
  }

  private or(): Expr {
    return this.binaryLevel(() => this.xor(), ['OR']);
  }
  private xor(): Expr {
    return this.binaryLevel(() => this.and(), ['XOR']);
  }
  private and(): Expr {
    return this.binaryLevel(() => this.not(), ['AND']);
  }
  private not(): Expr {
    if (this.isKw('NOT')) {
      const s = this.next().start;
      const a = this.not();
      return { t: 'unary', op: 'not', a, start: s, end: a.end };
    }
    return this.comparison();
  }

  private comparison(): Expr {
    const first = this.stringOps();
    const ops: string[] = [];
    const args = [first];
    while (this.t.k === 'punct' && ['=', '<>', '!=', '<', '<=', '>', '>='].includes(this.t.v)) {
      const op = this.next().v;
      ops.push(op === '!=' ? '<>' : op);
      args.push(this.stringOps());
    }
    if (ops.length === 0) return first;
    return { t: 'compare', ops, args, start: first.start, end: args[args.length - 1]!.end };
  }

  private stringOps(): Expr {
    let a = this.additive();
    while (true) {
      if (this.isKw('STARTS') && this.isKw('WITH', this.peek())) {
        this.pos += 2;
        const b = this.additive();
        a = { t: 'binary', op: 'starts_with', a, b, start: a.start, end: b.end };
      } else if (this.isKw('ENDS') && this.isKw('WITH', this.peek())) {
        this.pos += 2;
        const b = this.additive();
        a = { t: 'binary', op: 'ends_with', a, b, start: a.start, end: b.end };
      } else if (this.isKw('CONTAINS')) {
        this.pos++;
        const b = this.additive();
        a = { t: 'binary', op: 'contains', a, b, start: a.start, end: b.end };
      } else if (this.isKw('IN')) {
        this.pos++;
        const b = this.additive();
        a = { t: 'binary', op: 'in', a, b, start: a.start, end: b.end };
      } else if (this.is('=~')) {
        this.pos++;
        const b = this.additive();
        a = { t: 'binary', op: 'regex_match', a, b, start: a.start, end: b.end };
      } else if (this.isKw('IS')) {
        this.pos++;
        const negated = this.kw('NOT');
        this.expectKw('NULL');
        a = { t: 'isNull', a, negated, start: a.start, end: this.toks[this.pos - 1]!.end };
      } else return a;
    }
  }

  private additive(): Expr {
    let a = this.multiplicative();
    while (this.is('+') || this.is('-')) {
      const op = this.next().v === '+' ? 'add' : 'sub';
      const b = this.multiplicative();
      a = { t: 'binary', op, a, b, start: a.start, end: b.end };
    }
    return a;
  }

  private multiplicative(): Expr {
    let a = this.power();
    while (this.is('*') || this.is('/') || this.is('%')) {
      const v = this.next().v;
      const op = v === '*' ? 'mul' : v === '/' ? 'div' : 'mod';
      const b = this.power();
      a = { t: 'binary', op, a, b, start: a.start, end: b.end };
    }
    return a;
  }

  private power(): Expr {
    let a = this.unary();
    while (this.is('^')) {
      this.next();
      const b = this.unary();
      a = { t: 'binary', op: 'pow', a, b, start: a.start, end: b.end };
    }
    return a;
  }

  private unary(): Expr {
    if (this.is('-') || this.is('+')) {
      const t = this.next();
      const a = this.unary();
      // Fold negative number literals, so -9223… and -1 are plain literals.
      if (t.v === '-' && a.t === 'lit' && typeof a.v === 'number') return { t: 'lit', v: -a.v, float: a.float, start: t.start, end: a.end };
      return { t: 'unary', op: t.v === '-' ? 'neg' : 'pos', a, start: t.start, end: a.end };
    }
    return this.postfix();
  }

  private postfix(): Expr {
    let a = this.primary();
    while (true) {
      if (this.is('.') && (this.peek().k === 'ident' || this.peek().k === 'qident')) {
        this.next();
        const key = this.name();
        a = { t: 'prop', of: a, key, start: a.start, end: this.toks[this.pos - 1]!.end };
      } else if (this.is('[')) {
        this.next();
        if (this.eat('..')) {
          const to = this.is(']') ? undefined : this.expr();
          this.expect(']');
          a = { t: 'slice', of: a, to, start: a.start, end: this.toks[this.pos - 1]!.end };
          continue;
        }
        const index = this.expr();
        if (this.eat('..')) {
          const to = this.is(']') ? undefined : this.expr();
          this.expect(']');
          a = { t: 'slice', of: a, from: index, to, start: a.start, end: this.toks[this.pos - 1]!.end };
          continue;
        }
        this.expect(']');
        a = { t: 'index', of: a, index, start: a.start, end: this.toks[this.pos - 1]!.end };
      } else if (this.is(':') && a.t === 'var') {
        const labels: string[] = [];
        while (this.eat(':')) labels.push(this.name('a label'));
        a = { t: 'labels', of: a, labels, start: a.start, end: this.toks[this.pos - 1]!.end };
      } else return a;
    }
  }

  /** Is the parser at a pattern used as an expression, `(a)-->(b)`? */
  private atPattern(): boolean {
    if (!this.is('(')) return false;
    // Find the matching ')' and look for a relationship after it.
    let depth = 0;
    let i = this.pos;
    for (; i < this.toks.length; i++) {
      const t = this.toks[i]!;
      if (t.k === 'punct' && (t.v === '(' || t.v === '[' || t.v === '{')) depth++;
      else if (t.k === 'punct' && (t.v === ')' || t.v === ']' || t.v === '}')) {
        depth--;
        if (depth === 0) break;
      } else if (t.k === 'eof') return false;
    }
    const after = this.toks[i + 1];
    const after2 = this.toks[i + 2];
    if (!after || after.k !== 'punct') return false;
    if (after.v === '-') return !!after2 && after2.k === 'punct' && (after2.v === '-' || after2.v === '[' || after2.v === '>');
    if (after.v === '<') return !!after2 && after2.k === 'punct' && after2.v === '-';
    return false;
  }

  private primary(): Expr {
    const t = this.t;
    const start = t.start;
    const done = <T extends object>(x: T): T & Span => ({ ...x, start, end: this.toks[this.pos - 1]!.end });
    switch (t.k) {
      case 'num':
        this.pos++;
        // Written with a point or an exponent: a float, even when its value is whole (2.0).
        return done({ t: 'lit', v: t.num!, float: !/^0[xX]/.test(t.v) && /[.eE]/.test(t.v) });
      case 'str':
        this.pos++;
        return done({ t: 'lit', v: t.v });
      case 'param':
        this.pos++;
        return done({ t: 'param', name: t.v });
      case 'eof':
        return this.fail('Expected an expression at the end');
    }
    if (this.is('(')) {
      if (this.atPattern()) {
        const part = this.patternElement(start);
        return done({ t: 'exists', pattern: [part] });
      }
      this.next();
      const e = this.expr();
      this.expect(')');
      return { ...e, start, end: this.toks[this.pos - 1]!.end };
    }
    if (this.is('[')) return this.listOrComprehension();
    if (this.is('{')) {
      this.next();
      const entries: [string, Expr][] = [];
      if (!this.is('}')) {
        do {
          const k = this.t.k === 'str' ? this.next().v : this.name('a key');
          this.expect(':');
          entries.push([k, this.expr()]);
        } while (this.eat(','));
      }
      this.expect('}');
      return done({ t: 'map', entries });
    }
    if (t.k === 'punct') return this.fail(`Unexpected '${t.v}'`);
    const upper = t.k === 'ident' ? t.v.toUpperCase() : '';
    if (t.k === 'ident') {
      if (upper === 'TRUE' || upper === 'FALSE') {
        this.pos++;
        return done({ t: 'lit', v: upper === 'TRUE' });
      }
      if (upper === 'NULL') {
        this.pos++;
        return done({ t: 'lit', v: null });
      }
      if (upper === 'CASE') return this.caseExpr();
      if (upper === 'EXISTS' && this.is('{', this.peek())) {
        this.pos += 2;
        this.kw('MATCH');
        const pattern = this.pattern();
        const where = this.kw('WHERE') ? this.expr() : undefined;
        this.expect('}');
        return done({ t: 'exists', pattern, where });
      }
      if (['ANY', 'ALL', 'NONE', 'SINGLE'].includes(upper) && this.is('(', this.peek()) && (this.peek(2).k === 'ident' || this.peek(2).k === 'qident') && this.isKw('IN', this.peek(3))) {
        this.pos += 2;
        const name = this.name();
        this.expectKw('IN');
        const list = this.expr();
        this.expectKw('WHERE');
        const where = this.expr();
        this.expect(')');
        return done({ t: 'quantifier', q: upper.toLowerCase() as 'any', name, list, where });
      }
    }
    // A function call or a variable.
    const name = this.name('an expression');
    if (this.is('(') || (this.is('.') && this.peek().k === 'ident' && this.is('(', this.peek(2)))) {
      let full = name;
      while (this.eat('.')) full += '.' + this.name();
      this.expect('(');
      const distinct = this.kw('DISTINCT');
      if (this.eat('*')) {
        this.expect(')');
        return done({ t: 'call', name: full, args: [], distinct, star: true });
      }
      const args: Expr[] = [];
      if (!this.is(')')) {
        do args.push(this.expr());
        while (this.eat(','));
      }
      this.expect(')');
      return done({ t: 'call', name: full, args, distinct, star: false });
    }
    return done({ t: 'var', name });
  }

  private caseExpr(): Expr {
    const start = this.next().start;
    const operand = this.isKw('WHEN') ? undefined : this.expr();
    const whens: [Expr, Expr][] = [];
    while (this.kw('WHEN')) {
      const w = this.expr();
      this.expectKw('THEN');
      whens.push([w, this.expr()]);
    }
    if (whens.length === 0) this.fail('CASE needs at least one WHEN');
    const otherwise = this.kw('ELSE') ? this.expr() : undefined;
    this.expectKw('END');
    return { t: 'case', operand, whens, else: otherwise, ...this.span(start) };
  }

  private listOrComprehension(): Expr {
    const start = this.expect('[').start;
    // [x IN list WHERE … | …]
    if ((this.t.k === 'ident' || this.t.k === 'qident') && this.isKw('IN', this.peek())) {
      const name = this.name();
      this.expectKw('IN');
      const list = this.expr();
      const where = this.kw('WHERE') ? this.expr() : undefined;
      const map = this.eat('|') ? this.expr() : undefined;
      this.expect(']');
      return { t: 'listComp', name, list, where, map, ...this.span(start) };
    }
    // [(a)-->(b) WHERE … | …]
    if (this.atPattern() || ((this.t.k === 'ident' || this.t.k === 'qident') && this.is('=', this.peek()))) {
      const pattern = this.patternPart();
      const where = this.kw('WHERE') ? this.expr() : undefined;
      this.expect('|');
      const map = this.expr();
      this.expect(']');
      return { t: 'patternComp', pattern, where, map, ...this.span(start) };
    }
    const items: Expr[] = [];
    if (!this.is(']')) {
      do items.push(this.expr());
      while (this.eat(','));
    }
    this.expect(']');
    return { t: 'list', items, ...this.span(start) };
  }
}
