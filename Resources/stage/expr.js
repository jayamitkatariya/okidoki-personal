// Safe math expression compiler: recursive descent, no eval/Function.
// compile("sin(x)*cos(y) + t") -> (scope) => number

const FUNCS = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  exp: Math.exp, log: Math.log, log10: Math.log10, sqrt: Math.sqrt,
  abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: Math.round,
  min: Math.min, max: Math.max, pow: Math.pow, sign: Math.sign,
  clamp: (v, lo, hi) => Math.min(Math.max(v, lo), hi),
};
const ARITY = { atan2: 2, pow: 2, clamp: 3, min: -1, max: -1 };
const CONSTS = { pi: Math.PI, e: Math.E };

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if ((c >= '0' && c <= '9') || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
      out.push({ t: 'num', v: parseFloat(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      out.push({ t: 'id', v: m[0] });
      i += m[0].length;
      continue;
    }
    if ('+-*/^(),'.includes(c)) { out.push({ t: c }); i++; continue; }
    throw new Error(`Unexpected character '${c}' at ${i}`);
  }
  out.push({ t: 'eof' });
  return out;
}

export function compile(expr) {
  if (typeof expr !== 'string') throw new Error('Expression must be a string');
  const toks = tokenize(expr);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const expect = (t) => {
    const k = next();
    if (k.t !== t) throw new Error(`Expected '${t}' but found '${k.t === 'eof' ? 'end' : (k.v ?? k.t)}'`);
    return k;
  };

  // Each parse function returns (scope) => number
  function parseExpr() {
    let left = parseTerm();
    for (;;) {
      const k = peek().t;
      if (k === '+') { next(); const r = parseTerm(); const l = left; left = (s) => l(s) + r(s); }
      else if (k === '-') { next(); const r = parseTerm(); const l = left; left = (s) => l(s) - r(s); }
      else return left;
    }
  }
  function parseTerm() {
    let left = parseUnary();
    for (;;) {
      const k = peek().t;
      if (k === '*') { next(); const r = parseUnary(); const l = left; left = (s) => l(s) * r(s); }
      else if (k === '/') { next(); const r = parseUnary(); const l = left; left = (s) => l(s) / r(s); }
      else return left;
    }
  }
  function parseUnary() {
    if (peek().t === '-') { next(); const u = parseUnary(); return (s) => -u(s); }
    if (peek().t === '+') { next(); return parseUnary(); }
    return parsePower();
  }
  function parsePower() {
    const base = parseAtom();
    if (peek().t === '^') {
      next();
      const exp = parseUnary(); // right associative, allows 2^-x
      return (s) => Math.pow(base(s), exp(s));
    }
    return base;
  }
  function parseAtom() {
    const k = next();
    if (k.t === 'num') { const v = k.v; return () => v; }
    if (k.t === '(') { const e = parseExpr(); expect(')'); return e; }
    if (k.t === 'id') {
      const name = k.v;
      if (peek().t === '(') {
        next();
        const fn = FUNCS[name];
        if (!fn) throw new Error(`Unknown function '${name}'`);
        const args = [];
        if (peek().t !== ')') {
          args.push(parseExpr());
          while (peek().t === ',') { next(); args.push(parseExpr()); }
        }
        expect(')');
        const want = ARITY[name] ?? 1;
        if (want >= 0 && args.length !== want) throw new Error(`${name}() expects ${want} argument(s)`);
        if (want < 0 && args.length < 1) throw new Error(`${name}() expects at least 1 argument`);
        if (args.length === 1) { const a = args[0]; return (s) => fn(a(s)); }
        if (args.length === 2) { const a = args[0], b = args[1]; return (s) => fn(a(s), b(s)); }
        if (args.length === 3) { const a = args[0], b = args[1], c = args[2]; return (s) => fn(a(s), b(s), c(s)); }
        return (s) => fn(...args.map((a) => a(s)));
      }
      if (name in CONSTS) { const v = CONSTS[name]; return () => v; }
      // Variable: resolved at evaluation time; unknown names throw.
      return (s) => {
        const v = s ? s[name] : undefined;
        if (typeof v !== 'number') throw new Error(`Unknown identifier '${name}'`);
        return v;
      };
    }
    throw new Error(`Unexpected ${k.t === 'eof' ? 'end of expression' : `'${k.v ?? k.t}'`}`);
  }

  const fn = parseExpr();
  if (peek().t !== 'eof') throw new Error(`Unexpected '${peek().v ?? peek().t}'`);
  return fn;
}

export default compile;
