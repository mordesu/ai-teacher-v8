'use strict';
/*
 * math-verify.js —— 小初数学「确定性核验器」（零依赖）
 *
 * 为什么要有这个文件：
 *   缺陷 2 的本质不是"模型口算容易错符号"，而是**口径本身有歧义**。
 *   x²−5x+6 既可以按 (x+p)(x+q)、p+q=b（两个数是 −2、−3）来说，也可以按
 *   (x−p)(x−q)、p+q=−b（两个数是 2、3）来说。两种口径在代数上都自洽，
 *   但教材只用后者；模型在两种口径间来回切，就会出现
 *   "学生说 −2、−3，写的是 (x−2)(x−3)，老师盖章完全正确" 这种更坏的行为——
 *   它把歧义固化成了学生的错误约定。
 *
 * 所以本模块的职责不是"替模型算答案"，而是：
 *   1) 只在一个强制口径下计算：x²+bx+c = (x−p)(x−q)，p+q=−b，pq=c；
 *   2) 把"学生自述的数"和"学生写出的因式"分别解出来，判断是否自相矛盾；
 *   3) 把模型的回复也纳入同一口径审计：它说的"和是 −5"、它盖章的"完全正确"
 *      如果与机器核算冲突，产出 discrepancy 供上层记账（不是静默改写）；
 *   4) 超出能力范围（三角、根号内非常数、两个未知量、不等式、应用题文字）
 *      一律返回 not_computable，**绝不输出"正确/错误"结论**。宁可不算，不可算错。
 *
 * 精确性：有理数用 BigInt 分数，多项式按次数存系数，避免浮点 0.1+0.2 误判。
 */

// ---------------------------------------------------------------------------
// 文本归一：把中文全角、Unicode 减号、上标统一成可解析形式
// ---------------------------------------------------------------------------
function normalizeMathText(s) {
  return String(s == null ? '' : s)
    .replace(/[−–—―]/g, '-')      // 各种长短横统一成 ASCII 减号
    .replace(/[＝]/g, '=')
    .replace(/[（]/g, '(').replace(/[）]/g, ')')
    .replace(/[＋]/g, '+').replace(/[－]/g, '-')
    .replace(/[×✕✗]/g, '*').replace(/[·∙]/g, '*')
    .replace(/[÷]/g, '/')
    .replace(/²/g, '^2').replace(/³/g, '^3')
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xF030))
    .replace(/[．。]/g, '.')
    .replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// 精确有理数
// ---------------------------------------------------------------------------
// ---- 硬性资源上限（缺陷：无上限时一条 4 万字符的纯字母消息会被解析成 4 万次隐式乘法，
//      多项式次数线性膨胀 + 每次乘法 O(n) → O(n^2) 直接把 Node 进程打死，全站对后续请求失联）----
const MAX_TOKENS = 240;        // 单条算式最多 240 个 token
const MAX_DEGREE = 8;          // 只处理 8 次以内多项式，超出即"算不了"
const MAX_MULTIPLY_OPS = 4000; // 乘法累计预算
const MAX_RUN_CHARS = 120;     // 从自然语言里截出的候选算式最长 120 字符
const MAX_CANDIDATES = 40;     // 单次分析最多试解析 40 个候选
const MAX_INPUT_CHARS = 6000;  // 单次核验输入文本上限（只取尾部）
let budget = MAX_MULTIPLY_OPS;
// 预算必须「每次入口重置」，否则会像上一版那样：一次巨型输入把全局预算抽干，
// 之后连 (x-2)(x-3) 这种正常算式都被误判成超限，核验器直接哑火。
function resetBudget() { budget = MAX_MULTIPLY_OPS; }
function spend(n) { budget -= n; if (budget <= 0) throw new Error('verify_budget_exceeded'); }

function gcd(a, b) { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) { [a, b] = [b, a % b]; } return a || 1n; }
function F(n, d) {
  d = d === undefined ? 1n : d;
  if (d === 0n) throw new Error('div_by_zero');
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n < 0n ? -n : n, d);
  return { n: n / g, d: d / g };
}
const fAdd = (a, b) => F(a.n * b.d + b.n * a.d, a.d * b.d);
const fSub = (a, b) => F(a.n * b.d - b.n * a.d, a.d * b.d);
const fMul = (a, b) => F(a.n * b.n, a.d * b.d);
const fDiv = (a, b) => { if (b.n === 0n) throw new Error('div_by_zero'); return F(a.n * b.d, a.d * b.n); };
const fNeg = a => F(-a.n, a.d);
const fEq = (a, b) => a.n === b.n && a.d === b.d;
const fZero = a => a.n === 0n;
const fIsInt = a => a.d === 1n;
function fPow(a, k) {
  k = Number(k);
  if (!Number.isInteger(k) || k < 0 || k > 6) throw new Error('bad_exponent');
  let r = F(1n);
  for (let i = 0; i < k; i++) r = fMul(r, a);
  return r;
}
function fStr(a) {
  if (a.d === 1n) return (a.n < 0n ? '-' : '') + (a.n < 0n ? -a.n : a.n);
  return (a.n < 0n ? '-' : '') + (a.n < 0n ? -a.n : a.n) + '/' + a.d;
}
function fNum(a) { return Number(a.n) / Number(a.d); }

// ---------------------------------------------------------------------------
// 单变量多项式：poly[deg] = 系数(Frac)
// ---------------------------------------------------------------------------
const P = (...ds) => ds.map(d => d || F(0n));
const pTrim = a => { let i = a.length; while (i > 1 && fZero(a[i - 1])) i--; return a.slice(0, i); };
const pDeg = a => pTrim(a).length - 1;
const pAdd = (a, b) => { const r = []; for (let i = 0; i < Math.max(a.length, b.length); i++) r.push(fAdd(a[i] || F(0n), b[i] || F(0n))); return pTrim(r); };
const pSub = (a, b) => { const r = []; for (let i = 0; i < Math.max(a.length, b.length); i++) r.push(fSub(a[i] || F(0n), b[i] || F(0n))); return pTrim(r); };
const pNeg = a => a.map(fNeg);
function pMul(a, b) {
  if (a.length + b.length - 2 > MAX_DEGREE) throw new Error('degree_overflow');
  spend(a.length * b.length);
  const r = new Array(a.length + b.length - 1).fill(null).map(() => F(0n));
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) r[i + j] = fAdd(r[i + j], fMul(a[i], b[j]));
  return pTrim(r);
}
const pConst = c => pTrim([c]);
const pVar = () => pTrim([F(0n), F(1n)]);
function pEval(a, x) { let s = F(0n); for (let i = a.length - 1; i >= 0; i--) s = fAdd(fMul(s, x), a[i]); return s; }
function pStr(a) {
  a = pTrim(a);
  const parts = [];
  for (let d = a.length - 1; d >= 0; d--) {
    const c = a[d];
    if (fZero(c)) continue;
    const abs = c.n < 0n ? fNeg(c) : c;
    let mag;
    if (d === 0) mag = fStr(abs);
    else {
      const coefIsOne = fEq(abs, F(1n));
      mag = (coefIsOne ? '' : fStr(abs)) + 'x' + (d > 1 ? '^' + d : '');
    }
    parts.push({ neg: c.n < 0n, text: mag });
  }
  if (!parts.length) return '0';
  let out = (parts[0].neg ? '-' : '') + parts[0].text;
  for (let i = 1; i < parts.length; i++) out += (parts[i].neg ? ' - ' : ' + ') + parts[i].text;
  return out;
}

// ---------------------------------------------------------------------------
// 递归下降解析：expr := term (('+'|'-') term)*  |  term := factor (('*'|'/')? factor)*
// 隐式乘法支持：5x、2(x+1)、(x+1)(x-1)、x²
// ---------------------------------------------------------------------------
function tokenize(src) {
  const s = normalizeMathText(src).replace(/\s+/g, '');
  const toks = [];
  let i = 0;
  if (s.length > MAX_RUN_CHARS) throw new Error('expr_too_long');
  while (i < s.length) {
    const ch = s[i];
    if (toks.length > MAX_TOKENS) throw new Error('too_many_tokens');
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(s[i + 1] || ''))) {
      let j = i, num = '';
      while (j < s.length && /[0-9.]/.test(s[j])) { num += s[j]; j++; }
      // 小数/整数；再允许紧跟 /数字 形如 1/3（分数写法）
      if (s[j] === '/' && /[0-9]/.test(s[j + 1] || '')) {
        let k = j + 1, den = '';
        while (k < s.length && /[0-9]/.test(s[k])) { den += s[k]; k++; }
        toks.push({ t: 'num', v: parseRational(num, den) });
        i = k; continue;
      }
      toks.push({ t: 'num', v: parseRational(num, null) });
      i = j; continue;
    }
    if (/[a-zA-Z]/.test(ch)) { toks.push({ t: 'var', v: ch.toLowerCase() }); i++; continue; }
    if ('+-*/^()'.indexOf(ch) >= 0) { toks.push({ t: ch }); i++; continue; }
    // 其余字符（中文、逗号、句号、单位）视为不可解析
    throw new Error('unsupported_char:' + ch);
  }
  if (!toks.length) throw new Error('empty_expr');
  return toks;
}

function parseRational(intPart, denPart) {
  if (denPart != null) {
    // 形如 "1/3"：intPart 已是 '1'
    const a = BigInt(intPart), b = BigInt(denPart);
    return F(a, b);
  }
  const s = intPart;
  if (s.indexOf('.') < 0) return F(BigInt(s));
  const [ip, fp] = s.split('.');
  if (fp === '' ) return F(BigInt(ip || '0'));
  const den = 10n ** BigInt(fp.length);
  return F(BigInt((ip || '0') + fp), den);
}

function makeParser(toks) {
  let pos = 0;
  const peek = () => toks[pos];
  const eat = t => { if (!toks[pos] || toks[pos].t !== t) throw new Error('expect:' + t); return toks[pos++]; };

  function expr() {
    let a = term();
    while (peek() && (peek().t === '+' || peek().t === '-')) {
      const op = eat(peek().t).t;
      const b = term();
      a = op === '+' ? pAdd(a, b) : pSub(a, b);
    }
    return a;
  }
  function term() {
    let a = unary();
    while (peek() && (peek().t === '*' || peek().t === '/' || peek().t === '(' || peek().t === 'var' || peek().t === 'num')) {
      // 只有当上一个 token 结束了一个"值"，且当前 token 又能开始一个"值"时才是隐式乘法
      if (peek().t === '*' || peek().t === '/') {
        const op = eat(peek().t).t;
        const b = unary();
        a = op === '*' ? pMul(a, b) : pMul(a, pPowOf(pInv(b)));
        continue;
      }
      if (peek().t === '(' || peek().t === 'var' || peek().t === 'num') {
        const b = unary();
        a = pMul(a, b);
        continue;
      }
      break;
    }
    return a;
  }
  function unary() {
    if (peek() && peek().t === '-') { eat('-'); return pNeg(pow()); }
    if (peek() && peek().t === '+') { eat('+'); }
    return pow();
  }
  function pow() {
    let a = atom();
    while (peek() && peek().t === '^') {
      eat('^');
      const e = eat('num');
      const k = e.v;
      if (!fIsInt(k) || k.n < 0n || k.n > 6n) throw new Error('bad_power');
      let r = P(F(1n));
      for (let i = 0n; i < k.n; i++) r = pMul(r, a);
      a = r;
    }
    return a;
  }
  function atom() {
    const t = peek();
    if (!t) throw new Error('unexpected_end');
    if (t.t === 'num') { eat('num'); return pConst(t.v); }
    if (t.t === 'var') { eat('var'); varSeen.add(t.v); return pVarFor(t.v); }
    if (t.t === '(') { eat('('); const a = expr(); eat(')'); return a; }
    throw new Error('unexpected_token:' + t.t);
  }
  return { expr, atEnd: () => pos >= toks.length };
}

// 变量映射：整个表达式里只允许一个自由变量，其它字母视为该变量
let varSeen = new Set();
function pVarFor(v) { return pVar(); }

function parseExpr(src) {
  resetBudget();
  const saved = varSeen;
  varSeen = new Set();
  try {
    const toks = tokenize(src);
    const p = makeParser(toks);
    const poly = p.expr();
    if (!p.atEnd()) throw new Error('trailing_input');
    if (varSeen.size > 1) throw new Error('multi_variable:' + Array.from(varSeen).join(','));
    return { poly, varName: Array.from(varSeen)[0] || 'x' };
  } catch (e) {
    return { poly: null, error: String(e.message || e) };
  } finally {
    varSeen = saved;
  }
}

function pInv(poly) {
  if (poly.length === 1) return pConst(fDiv(F(1n), poly[0]));
  throw new Error('div_by_nonconstant');
}
function pPowOf(poly) { return poly; } // 除法只在常数情形支持，已在 pInv 里抛错

// ---------------------------------------------------------------------------
// 关系式（等式）解析与等价判定
// ---------------------------------------------------------------------------
function parseRelation(src) {
  const s = normalizeMathText(src);
  const idx = s.indexOf('=');
  if (idx < 0) return null;
  const lhsTxt = s.slice(0, idx).trim();
  const rhsTxt = s.slice(idx + 1).trim();
  if (!lhsTxt || !rhsTxt) return null;
  if (rhsTxt.indexOf('=') >= 0) return null;            // 连等不处理
  const L = parseExpr(lhsTxt), R = parseExpr(rhsTxt);
  if (!L.poly || !R.poly) return null;
  const diff = pSub(L.poly, R.poly);
  return { lhsTxt, rhsTxt, lhs: L.poly, rhs: R.poly, diff, varName: L.varName || R.varName };
}

function classify(rel) {
  const d = pTrim(rel.diff);
  if (d.length === 1 && fZero(d[0])) return { kind: 'identity', note: '恒等' };
  if (d.length === 1) return { kind: 'contradiction', note: '无解（矛盾式）' };
  if (d.length === 2) {
    const v = rel.varName || 'x';
    return { kind: 'linear', root: fDiv(fNeg(d[0]), d[1]), varName: v };
  }
  if (d.length === 3) {
    const a = d[2], b = d[1], c = d[0];
    const disc = fAdd(fMul(b, b), fNeg(fMul(F(4n), fMul(a, c))));
    return { kind: 'quadratic', a, b, c, disc };
  }
  return { kind: 'higher', degree: d.length - 1 };
}

// 两个等式是否同解（只覆盖一次方程；二次以上只比多项式）
function relationsEquivalent(r1, r2) {
  const c1 = classify(r1), c2 = classify(r2);
  if (c1.kind === 'identity' && c2.kind === 'identity') return true;
  if (c1.kind === 'linear' && c2.kind === 'linear') return fEq(c1.root, c2.root);
  if (fEq(pDeg(r1.diff), pDeg(r2.diff)) === false) return null;
  return fEq(pDeg(r1.diff), pDeg(r2.diff)) && JSON.stringify(pTrim(r1.diff).map(fStr)) === JSON.stringify(pTrim(r2.diff).map(fStr));
}

const FACTOR_RE = /\(\s*(\d*)([a-zA-Z])\s*([+\-])\s*(\d+(?:\/\d+)?(?:\.\d+)?)\s*\)/g;

// (x-2)(x+3) → 每个因式解析成一次多项式 a·x + c，并给出 p = -c（唯一口径里写进括号的那个数）
function extractFactors(text) {
  const s = normalizeMathText(text);
  const out = [];
  let m;
  FACTOR_RE.lastIndex = 0;
  let fcount = 0;
  while ((m = FACTOR_RE.exec(s)) && fcount++ < 6) {
    const a = m[1] === '' ? F(1n) : toFracFromToken(m[1]);
    const sign = m[3] === '-' ? -1n : 1n;
    const k = toFracFromToken(m[4]);
    const constant = F(sign * k.n, k.d);           // (x-2) → -2
    const p = fNeg(fDiv(constant, a));             // 唯一口径里的 p：(x-2) → 2
    out.push({ text: m[0], varName: m[2].toLowerCase(), poly: pTrim([constant, a]), p, root: p });
  }
  return out;
}
function expandFactors(fs) { resetBudget(); let acc = P(F(1n)); for (const f of fs) acc = pMul(acc, f.poly); return acc; }
function factorsFromP(pList) { return pList.map(p => '(x' + (fNum(p) < 0 ? '+' + fStr(fNeg(p)) : '-' + fStr(p)) + ')'); }

// 从一段文字里收集所有"能解析的多项式"（按中文/标点切分，逐块试解析）
const SPLIT_RE = /[，,。；;！!？?\s、（）()【】\[\]"'“”:：=]+/;
function collectPolys(text) {
  const s = normalizeMathText(text);
  const runs = s.split(SPLIT_RE).filter(x => x && /[a-zA-Z0-9]/.test(x)).slice(0, MAX_CANDIDATES);
  const polys = [];
  for (const run of runs) {
    if (run.length > MAX_RUN_CHARS) continue;
    // 去掉"乘积是6""和是-5"这类残留中文前缀后剩下的纯算式
    const clean = run.replace(/^[^0-9a-zA-Z(/-]+/, '');
    if (!clean || !/[a-zA-Z]/.test(clean)) continue;
    const r = parseExpr(clean);
    if (r.poly) polys.push({ text: clean, poly: pTrim(r.poly), varName: r.varName });
  }
  return polys;
}
// 唯一口径需要的二次式：首项系数 1、次数 2 → 取 b（一次项）与 c（常数项）
function findMonicQuadratic(polys) {
  for (const c of polys) {
    if (c.poly.length === 3 && fEq(c.poly[2], F(1n))) return { text: c.text, b: c.poly[1], c: c.poly[0], poly: c.poly };
  }
  return null;
}

const NUM_TOKEN = /-?\d+(?:\.\d+)?(?:\/\d+)?/g;
function toFracFromToken(tok) {
  const t = String(tok).trim().replace(/^\+/, '');
  if (t.indexOf('/') >= 0) { const [a, b] = t.split('/'); return F(BigInt(a), BigInt(b)); }
  if (t.indexOf('.') >= 0) {
    const neg = t.startsWith('-');
    const body = (neg ? t.slice(1) : t);
    const [ip, fp] = body.split('.');
    const num = BigInt((ip || '0') + fp), den = 10n ** BigInt(fp.length);
    return F(neg ? -num : num, den);
  }
  return F(BigInt(t));
}

// 学生自述的数："两个数是 -2 和 -3" / "根是 2、3" / "找到 -2 和 -3"
function extractStatedNumbers(text) {
  const s = normalizeMathText(text);
  const out = [];
  const patterns = [
    /(?:两(?:个)?数|这(?:两)?个数|二者|它们)\s*(?:分别)?\s*(?:是|为|：|:|都是)\s*(-?\d+(?:\.\d+)?(?:\/\d+)?)(?:\s*[和与、,，/]\s*(-?\d+(?:\.\d+)?(?:\/\d+)?))?/g,
    /找到\s*(-?\d+(?:\.\d+)?)(?:\s*[和与、,，]\s*(-?\d+(?:\.\d+)?))/g,
    /(?:根|解)\s*(?:是|为|：|:|=|x\s*=)?\s*(-?\d+(?:\.\d+)?)(?:\s*[和与、,，/]\s*(?:x\s*=\s*)?(-?\d+(?:\.\d+)?))?/g,
    /(-?\d+(?:\.\d+)?)\s*[和与、,，]\s*(-?\d+(?:\.\d+)?)(?=[^0-9])/g
  ];
  for (const re of patterns) {
    let m; re.lastIndex = 0;
    while ((m = re.exec(s))) {
      const nums = [m[1], m[2]].filter(x => x != null && x !== '').map(toFracFromToken);
      if (nums.length >= 2) { out.push({ nums, raw: m[0].trim().slice(0, 40) }); }
    }
    if (out.length) break;
  }
  return out;
}

// 回复/学生话里的"和/积"口径主张。
// 精度要点：中文"和"既可是连词（-2 和 -3）也可是求和主张（和是 -5）。
// 只接受带系词/之/相加/相乘的口径主张形式，连词一律不认——上一版把
// "你找对了两个数：-2 和 -3" 里的 -3 当成了"和"，是假阳性。
const SUM_PATTERNS = [
  /(?:两(?:个)?数|二者|它们)(?:的)?和\s*(?:应该是|应为|应|是|为|=|得|：|:)\s*(-?\d+(?:\.\d+)?(?:\/\d+)?)/g,
  /之和\s*(?:应该是|应为|应|是|为|=|得|：|:)?\s*(-?\d+(?:\.\d+)?(?:\/\d+)?)/g,
  /和(?:为|是|=|得|应为)\s*(-?\d+(?:\.\d+)?(?:\/\d+)?)/g,
  /相加(?:得|是|=|应为|为)\s*(-?\d+(?:\.\d+)?(?:\/\d+)?)/g
];
const PROD_PATTERNS = [
  /(?:两(?:个)?数|二者|它们)(?:的)?积\s*(?:应该是|应为|应|是|为|=|得|：|:)\s*\+?(-?\d+(?:\.\d+)?(?:\/\d+)?)/g,
  /之积\s*(?:应该是|应为|应|是|为|=|得|：|:)?\s*\+?(-?\d+(?:\.\d+)?(?:\/\d+)?)/g,
  /积(?:为|是|=|得|应为)\s*\+?(-?\d+(?:\.\d+)?(?:\/\d+)?)/g,
  /相乘(?:得|是|=|为)\s*\+?(-?\d+(?:\.\d+)?(?:\/\d+)?)/g,
  /乘积\s*(?:应该是|应为|是|为|=|得|：|:)?\s*\+?(-?\d+(?:\.\d+)?(?:\/\d+)?)/g
];
function firstMatch(patterns, s) {
  for (const re of patterns) {
    re.lastIndex = 0;
    const m = re.exec(s);
    if (m) return toFracFromToken(m[1]);
  }
  return null;
}
function extractSumProductClaims(text) {
  const s = normalizeMathText(text);
  const sum = firstMatch(SUM_PATTERNS, s);
  const product = firstMatch(PROD_PATTERNS, s);
  const signWord = /(两个数都是|两个|这俩|它们都是|都应该是|都是|均为|应是)\s*(负|正)\s*(?:整数|数|的数)?/.exec(s);
  return { sum, product, signWord: signWord ? { phrase: signWord[0].trim(), sign: signWord[2] } : null };
}

// 题目口径来源：整段对话里能拿到的二次式（学生写的、老师写的、题干里的都行）。
// 没有显式二次式时，用"因式乘开"反推 —— 学生自己写的 (x-2)(x-3) 就声明了 x^2-5x+6。
function deriveProblem(text) {
  resetBudget();
  const s = normalizeMathText(text || '');
  if (!s) return null;
  const q = findMonicQuadratic(collectPolys(s));
  if (q) return { b: q.b, c: q.c, poly: q.poly, source: q.text, via: 'trinomial' };
  const factors = extractFactors(s);
  if (factors.length >= 2) {
    const e = pTrim(expandFactors(factors));
    if (e.length === 3 && fEq(e[2], F(1n))) return { b: e[1], c: e[0], poly: e, source: factors.map(f => f.text).join(''), via: 'factors' };
  }
  return null;
}
function problemLine(p) {
  if (!p) return '';
  return '题目二次式：' + pStr(p.poly) + '（b=' + fStr(p.b) + '，c=' + fStr(p.c) + '）→ 按唯一口径必须满足 p+q=' + fStr(fNeg(p.b)) + '，pq=' + fStr(p.c) + '。';
}

// ---------------------------------------------------------------------------
// 主入口 1：核验学生消息
// ---------------------------------------------------------------------------
function verifyStudentMessage(text, givenProblem) {
  resetBudget();
  const findings = [];
  const raw = String(text || '');
  const s = normalizeMathText(raw.length > MAX_INPUT_CHARS ? raw.slice(-MAX_INPUT_CHARS) : raw);
  if (!s) return { findings, computable: false, problem: givenProblem || null };

  // 1) 等式：恒等 / 一次方程求解 / 同句两个一次等式判等价（移项正误）
  //    字符类必须覆盖所有字母：否则 "sin x = 0.5" 会被截成 "x = 0.5" 并"算"出一个错解。
  //    让整串进入解析器，由解析器决定能不能算（多变量/函数名一律拒收）。
  const relRe = /[0-9a-zA-Z+\-*/^().\s]{2,60}=[0-9a-zA-Z+\-*/^().\s]{2,60}/g;
  const rels = [];
  let m, relCount = 0;
  while ((m = relRe.exec(s)) && relCount++ < MAX_CANDIDATES) {
    const r = parseRelation(m[0]);
    if (r) rels.push({ text: m[0].trim(), rel: r, cls: classify(r) });
  }
  for (const r of rels) {
    if (r.cls.kind === 'identity') findings.push({ kind: 'identity_true', text: r.text });
    else if (r.cls.kind === 'contradiction') findings.push({ kind: 'equation_unsolvable', text: r.text });
    else if (r.cls.kind === 'linear') findings.push({ kind: 'equation_linear', text: r.text, varName: r.cls.varName, root: fStr(r.cls.root) });
    else if (r.cls.kind === 'quadratic') findings.push({ kind: 'equation_quadratic', text: r.text });
    else findings.push({ kind: 'not_computable', text: r.text, reason: '高于一次' });
  }
  const linears = rels.filter(r => r.cls.kind === 'linear');
  if (linears.length >= 2) {
    const eq = relationsEquivalent(linears[0].rel, linears[1].rel);
    if (eq === true) findings.push({ kind: 'transform_equivalent', from: linears[0].text, to: linears[1].text });
    else if (eq === false) findings.push({ kind: 'transform_not_equivalent', from: linears[0].text, to: linears[1].text, rootFrom: fStr(linears[0].cls.root), rootTo: fStr(linears[1].cls.root) });
  }

  // 2) 因式分解：把括号乘开，与学生写/提到的二次式在同一口径下比对
  const factors = extractFactors(s);
  const polys = collectPolys(s);
  const quadFromText = findMonicQuadratic(polys) || (rels.length ? (() => {
    // "(x-2)(x-3)=0" 这类：左边乘开后本身就是二次式
    for (const r of rels) {
      const d = pTrim(r.rel.diff);
      if (d.length === 3 && fEq(d[2], F(1n))) return { text: r.text, b: d[1], c: d[0], poly: d };
    }
    return null;
  })() : null);
  // 文本里拿不到二次式时，退回"整段对话推导出的题目口径"
  const quad = quadFromText || givenProblem || null;

  if (factors.length >= 2) {
    const expanded = expandFactors(factors);
    const pOf = factors.map(f => f.p);
    const sumP = pOf.reduce((a, b) => fAdd(a, b), F(0n));
    const prodP = pOf.reduce((a, b) => fMul(a, b), F(1n));
    const rec = {
      kind: 'factors_only',
      factors: factors.map(f => f.text),
      expanded: pStr(expanded),
      pOf: pOf.map(fStr),
      sum: fStr(sumP), product: fStr(prodP)
    };
    if (quad) {
      const mustSum = fNeg(quad.b), mustProd = quad.c;
      const sumOk = fEq(sumP, mustSum), prodOk = fEq(prodP, mustProd);
      const expandOk = JSON.stringify(pTrim(expanded).map(fStr)) === JSON.stringify(pTrim(quad.poly).map(fStr));
      rec.kind = (sumOk && prodOk && expandOk) ? 'factoring_consistent' : 'factoring_broken';
      rec.trinomial = pStr(quad.poly);
      rec.expectSum = fStr(mustSum); rec.gotSum = fStr(sumP); rec.sumOk = sumOk;
      rec.expectProd = fStr(mustProd); rec.gotProd = fStr(prodP); rec.prodOk = prodOk;
      rec.expandOk = expandOk;
    }
    findings.push(rec);

    // 3) 自述 vs 写出：学生嘴上报的数与写进括号的 p 必须是同一批（唯一口径下根==p）
    const stated = extractStatedNumbers(s);
    if (stated.length) {
      const nums = stated[0].nums.map(fStr);
      if (!sameMultiset(nums, rec.pOf)) {
        findings.push({
          kind: 'stated_written_conflict',
          stated: nums,
          pOf: rec.pOf,
          wouldBe: factorsFromP(stated[0].nums)   // 若真用 −2、−3，括号应写成什么
        });
      }
    }
  }

  // 4) 正负措辞与口径是否冲突
  const claims = extractSumProductClaims(s);
  if (quad && claims.signWord) {
    const mustSum = fNeg(quad.b);
    const bothPos = fNum(mustSum) > 0 && fNum(quad.c) > 0;
    const bothNeg = fNum(mustSum) < 0 && fNum(quad.c) > 0;
    const saidNeg = claims.signWord.sign === '负';
    if ((saidNeg && bothPos) || (!saidNeg && bothNeg)) {
      findings.push({ kind: 'sign_wording_conflict', said: claims.signWord.phrase, expectP: fStr(mustSum), b: fStr(quad.b), c: fStr(quad.c) });
    }
  }
  // 5) 口径主张本身错了（"两数之和是 -5"而 -b=5）
  if (quad && claims.sum && !fEq(claims.sum, fNeg(quad.b))) {
    findings.push({ kind: 'convention_claim_wrong', said: fStr(claims.sum), must: fStr(fNeg(quad.b)), b: fStr(quad.b) });
  }
  if (quad && claims.product && !fEq(claims.product, quad.c)) {
    findings.push({ kind: 'convention_claim_wrong', said: fStr(claims.product), must: fStr(quad.c), field: 'product' });
  }

  return { findings, computable: findings.some(f => f.kind !== 'not_computable'), problem: quad || null };
}

function sameMultiset(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const sa = a.slice().sort(), sb = b.slice().sort();
  return sa.every((v, i) => v === sb[i]);
}

// ---------------------------------------------------------------------------
// 主入口 2：注入给模型的核验块
// ---------------------------------------------------------------------------
const CONVENTION_LINE = '唯一口径（全程只许这一种，不许中途切换）：x^2+bx+c = (x-p)(x-q)，p+q = -b，pq = c。p、q 就是"写进括号里的那个数"，也等于方程的根；不存在"两数之和等于 b"的第二种说法。要说 p、q，必须先把 (x-p)(x-q) 展开回 x^2+bx+c 核对，核对不过就不报数，改成问学生。';

// 一次性分析整段（服务端把"全部学生消息文本"传进来，拿到题目口径 + 逐条发现）
function analyzeConversation(text) {
  const t = String(text || '');
  const budgeted = t.length > MAX_INPUT_CHARS ? t.slice(-MAX_INPUT_CHARS) : t;
  resetBudget();
  const problem = deriveProblem(budgeted);
  const v = verifyStudentMessage(budgeted, problem);
  return { problem, findings: v.findings, computable: v.computable || !!problem };
}

function buildVerificationBlock(text, opts) {
  const o = opts || {};
  let a = o.analysis;
  if (!a) {
    resetBudget();
    const t = String(text || '');
    a = analyzeConversation(t.length > MAX_INPUT_CHARS ? t.slice(-MAX_INPUT_CHARS) : t);
  }
  if (!a.computable) return '';
  const v = a.findings;
  const lines = [];
  if (a.problem) lines.push('· ' + problemLine(a.problem));
  for (const f of v) {
    switch (f.kind) {
      case 'identity_true': lines.push('· 恒等核对：' + f.text + ' 成立（机器展开验过）。'); break;
      case 'equation_unsolvable': lines.push('· ' + f.text + ' 是矛盾式，无解。请让他回查这一步怎么来的，别替他改。'); break;
      case 'equation_linear': lines.push('· 机器解得：' + f.text + ' 的解为 ' + f.varName + '=' + f.root + '（仅供你判断该问什么，不许你把这串数字报出来）。'); break;
      case 'transform_equivalent': lines.push('· 变形等价："' + f.from + '" → "' + f.to + '" 同解，方向对。仍要请他自己说出为什么。'); break;
      case 'transform_not_equivalent': lines.push('⚠ 变形不等价："' + f.from + '" 解为 ' + f.rootFrom + '，学生写成 "' + f.to + '" 解为 ' + f.rootTo + '。禁止盖章"对/正确"，只能提问让他找回变号的那一项。'); break;
      case 'factoring_consistent': lines.push('· 因式分解口径核对：括号里的数 [' + f.pOf.join(', ') + ']，p+q 应为 ' + f.expectSum + '（实得 ' + f.gotSum + '），pq 应为 ' + f.expectProd + '（实得 ' + f.gotProd + '），乘开为 ' + f.expanded + ' → 自洽。'); break;
      case 'factoring_broken': lines.push('⚠ 因式分解不自洽：括号里的数 [' + f.pOf.join(', ') + ']，p+q 应为 ' + f.expectSum + ' 实得 ' + f.gotSum + '，pq 应为 ' + f.expectProd + ' 实得 ' + f.gotProd + '，乘开是 ' + f.expanded + '（学生以为是 ' + f.trinomial + '）。禁止推进下一步，先把这个不一致摊开问。'); break;
      case 'factors_only': lines.push('· 学生写的因式乘开 = ' + f.expanded + '；括号里的数 [' + f.pOf.join(', ') + ']，其和 ' + f.sum + '、其积 ' + f.product + '。'); break;
      case 'stated_written_conflict': lines.push('⚠ 最高优先：学生自述的数 [' + f.stated.join(', ') + '] 与他写进括号的 p、q [' + f.pOf.join(', ') + '] 不是同一批；若真用 [' + f.stated.join(', ') + ']，括号应当写成 ' + f.wouldBe.join('') + '。这一轮只能就这个不一致提问（例如"你说的 -2 和 -3，写进 (x ) 里为什么变成 2 和 3？"），严禁"完全正确/非常好"这类盖章，也严禁接着讲下一步。'); break;
      case 'sign_wording_conflict': lines.push('⚠ 口径措辞冲突：这句说"' + f.said + '"，但按唯一口径括号里的数之和应为 ' + f.expectP + '。不要复述这种说法，改问"你写进括号的是正还是负，依据是什么"。'); break;
      case 'convention_claim_wrong': lines.push('⚠ 口径主张错误：' + (f.field === 'product' ? 'pq' : 'p+q') + ' 应为 ' + f.must + '，这里说的是 ' + f.said + '。别把两种口径混在一起讲。'); break;
      default: break;
    }
  }
  if (!lines.length) return '';
  return [
    o.convention === false ? '' : CONVENTION_LINE,
    '【服务端符号核验 · 机器算的，优先于你的口算】',
    lines.join('\n'),
    '使用规则：以上只用于决定"该问什么"，不得整句念给学生；凡涉及具体数值，一律由学生自己说出。'
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// 主入口 3：审计模型回复（产 discrepancy 供记账，不改写数学文本）
// ---------------------------------------------------------------------------
const STAMP_RE = /(完全正确|你做对了|你找对了|你写对了|非常好|没问题|对得很|完美|就是这个|答对了|就是这样|正确的)/;
function auditAssistantReply(replyText, analysis, maybeProblem) {
  const out = [];
  const raw = String(replyText || '');
  resetBudget();
  const s = normalizeMathText(raw.length > MAX_INPUT_CHARS ? raw.slice(-MAX_INPUT_CHARS) : raw);
  if (!s.trim()) return out;
  let v = [], problem = null;
  if (Array.isArray(analysis)) { v = analysis; problem = maybeProblem || null; }
  else if (analysis && typeof analysis === 'object') { v = analysis.findings || []; problem = analysis.problem || null; }

  const factors = extractFactors(s);
  // 回复里没复述二次式时，用整段对话推出的题目口径继续审计（第 3 轮那种"只报和"的说法就靠这条兜住）
  const quad = findMonicQuadratic(collectPolys(s)) || problem || null;
  if (factors.length >= 2 && quad) {
    const expanded = expandFactors(factors);
    if (JSON.stringify(pTrim(expanded).map(fStr)) !== JSON.stringify(pTrim(quad.poly).map(fStr))) {
      out.push({ id: 'expansion_false', factors: factors.map(f => f.text), claims: pStr(quad.poly), actual: pStr(expanded) });
    }
    const sumP = factors.reduce((acc, f) => fAdd(acc, f.p), F(0n));
    if (!fEq(sumP, fNeg(quad.b))) {
      out.push({ id: 'convention_mixed', pOf: factors.map(f => fStr(f.p)), claimSum: fStr(sumP), mustSum: fStr(fNeg(quad.b)), b: fStr(quad.b) });
    }
  }
  const claims = extractSumProductClaims(s);
  if (quad) {
    if (claims.sum && !fEq(claims.sum, fNeg(quad.b))) out.push({ id: 'wrong_sum_claim', said: fStr(claims.sum), must: fStr(fNeg(quad.b)), b: fStr(quad.b) });
    if (claims.product && !fEq(claims.product, quad.c)) out.push({ id: 'wrong_product_claim', said: fStr(claims.product), must: fStr(quad.c) });
    if (claims.signWord) {
      const bothPos = fNum(fNeg(quad.b)) > 0 && fNum(quad.c) > 0;
      const bothNeg = fNum(fNeg(quad.b)) < 0 && fNum(quad.c) > 0;
      const saidNeg = claims.signWord.sign === '负';
      if (saidNeg && bothNeg === false && bothPos) out.push({ id: 'wrong_sign_wording', said: claims.signWord.phrase, must: '正数（p+q=' + fStr(fNeg(quad.b)) + '）' });
      if (!saidNeg && bothNeg) out.push({ id: 'wrong_sign_wording', said: claims.signWord.phrase, must: '负数（p+q=' + fStr(fNeg(quad.b)) + '）' });
    }
  }
  const conflictKinds = ['stated_written_conflict', 'factoring_broken', 'transform_not_equivalent', 'sign_wording_conflict', 'convention_claim_wrong'];
  const conflicts = v.filter(f => conflictKinds.indexOf(f.kind) >= 0);
  if (conflicts.length && STAMP_RE.test(s)) {
    out.push({ id: 'stamped_inconsistent', stamp: STAMP_RE.exec(s)[0], conflicts: conflicts.map(c => c.kind) });
  }
  return dedupe(out);
}

function dedupe(list) {
  const seen = new Set(), out = [];
  for (const x of list) { if (seen.has(x.id)) continue; seen.add(x.id); out.push(x); }
  return out;
}

module.exports = {
  normalizeMathText,
  F, fAdd, fSub, fMul, fDiv, fEq, fNeg, fStr, fNum, fIsInt, fZero,
  P, pAdd, pSub, pMul, pTrim, pDeg, pEval, pStr,
  tokenize, parseExpr, parseRelation, classify, relationsEquivalent,
  extractFactors, expandFactors, factorsFromP, collectPolys, findMonicQuadratic,
  extractStatedNumbers, extractSumProductClaims, toFracFromToken,
  deriveProblem, problemLine, analyzeConversation,
  verifyStudentMessage, buildVerificationBlock, auditAssistantReply,
  CONVENTION_LINE
};
