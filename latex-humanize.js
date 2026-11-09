/*
 * latex-humanize.js —— 把 LaTeX 数学记法转成学生看得懂的普通写法
 *
 * 为什么需要它（第 10 条缺陷）：
 *   现在的渲染链有两条泄漏路径：
 *     1) KaTeX 的 CSS/JS 来自 cdnjs，公司网/浏览器插件/离线时加载失败，
 *        renderDisplayMath() 直接退回 <pre> 输出 LaTeX 源码；
 *     2) typesetMath() 在 window.renderMathInElement 不存在时静默跳过，
 *        正文里的 $...$、\\(...\\) 一个都不动，学生看到的就是一堆反斜杠。
 *   再加上 throwOnError:false 会把认不出的宏渲染成红色源码 —— 本质还是把源码给学生。
 *   对初一学生说 "\frac{2x-1}{3} \leq 2" 等于没说。
 *
 * 设计纪律：
 *   - 只做"读法等价"的转写，不做数学判断（数学判断在 math-verify.js）。
 *   - 认不出的宏一律降级成可读词，绝不把 \command 留在屏幕上；
 *     宁可丢掉一点形式信息，也不给学生看源码。
 *   - 幂/根/分式用日常记法：x²、√2、3/4、(a+b)/c。
 *   - 纯函数、无依赖，Node 与浏览器共用同一份实现（前端 <script src> 引入）。
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (root) root.LaTeXHumanize = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------- 记号表 ----------
  const GREEK = {
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
    zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'θ', iota: 'ι', kappa: 'κ',
    lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ',
    tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
    Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω'
  };
  const SYMBOLS = {
    times: '×', div: '÷', cdot: '·', ast: '*', star: '★', pm: '±', mp: '∓',
    leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈',
    equiv: '≡', sim: '∼', simeq: '≃', propto: '∝', ll: '≪', gg: '≫',
    infty: '∞', partial: '∂', nabla: '∇', forall: '任意', exists: '存在',
    in: '属于', notin: '不属于', subset: '包含于', subseteq: '包含于等于',
    supset: '包含', cup: '并', cap: '交', emptyset: '∅', varnothing: '∅',
    to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒', Leftarrow: '⇐',
    leftrightarrow: '⇔', imply: '⇒', therefore: '∴', because: '∵',
    perp: '⊥', parallel: '∥', angle: '∠', triangle: '△', square: '□',
    circ: '°', degree: '°', prime: '′', mid: '｜', land: '且', lor: '或',
    ldots: '…', cdots: '…', dots: '…', vdots: '…', ddots: '…',
    checkmark: '✓', pair: '（）', lvert: '|', rvert: '|', lbrack: '[', rbrack: ']',
    lbrace: '{', rbrace: '}', vert: '|', Vert: '‖', lfloor: '⌊', rfloor: '⌋',
    lceil: '⌈', rceil: '⌉', odot: '·', bullet: '·', colon: ':'
  };
  // 函数名一律转成中文读法或普通词，不保留反斜杠
  const FUNCS = {
    sin: 'sin', cos: 'cos', tan: 'tan', arcsin: 'arcsin', arccos: 'arccos', arctan: 'arctan',
    log: 'log', ln: 'ln', lg: 'lg', exp: 'exp', min: '最小值', max: '最大值',
    lim: '极限', deg: '°', gcd: '最大公约数', lcm: '最小公倍数',
    abs: '绝对值', sign: '符号'
  };
  const SUP = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', 'n': 'ⁿ', 'm': 'ᵐ', '=': '⁼', '(': '⁽', ')': '⁾', 'x': 'ˣ' };
  const SUB = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎' };

  // ---------- 工具 ----------
  function readGroup(src, i) {
    // src[i] 应为 '{'，返回 {text, end}（end 为右括号之后的下标）
    if (src[i] !== '{') { return { text: src[i] || '', end: i + 1 }; }
    let depth = 0, out = '';
    for (let j = i; j < src.length; j++) {
      const c = src[j];
      if (c === '{') { depth++; if (depth > 1) out += c; continue; }
      if (c === '}') { depth--; if (depth === 0) return { text: out, end: j + 1 }; out += c; continue; }
      out += c;
    }
    return { text: out, end: src.length };
  }
  function isBalancedGroup(t) {
    if (t[0] !== '(' || t[t.length - 1] !== ')') return false;
    let d = 0;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '(') d++;
      else if (t[i] === ')') { d--; if (d === 0 && i !== t.length - 1) return false; }
    }
    return d === 0;
  }
  // 需要加括号才能保住原意的三种情况：
  //   含二元加减（2x-1）、含除号（1/2）、隐式乘法（2a）——
  //   最后一条最要命：rac{-b}{2a} 写成 -b/2a 会被读成 (-b/2)·a。
  function needsParens(x) {
    const t = String(x || '').trim();
    if (t.length <= 1 || isBalancedGroup(t)) return false;
    if (/[+-]/.test(t.slice(1))) return true;
    if (t.indexOf('/') >= 0) return true;
    if (/[0-9]\s*[a-zA-Z]/.test(t)) return true;
    return false;
  }
  function wrap(x) { const t = String(x || '').trim(); return needsParens(t) ? '(' + t + ')' : t; }
  function mapScript(str, table) {
    let out = '';
    for (const ch of str) out += (table[ch] !== undefined ? table[ch] : ch);
    return out;
  }

  // ---------- 主体转写 ----------
  function humanize(src, opts) {
    const o = opts || {};
    let s = String(src == null ? '' : src);
    if (!s) return '';

    // 环境：cases / array / aligned / align / matrix 等 → 先按行拆开再各自转写
    s = s.replace(/\\begin\{(aligned|align|align\*|array|cases|pmatrix|bmatrix|matrix|gather|eqnarray)\}(\[[^\]]*\])?(\{[^}]*\})?/g, ' ')
         .replace(/\\end\{(aligned|align|align\*|array|cases|pmatrix|bmatrix|matrix|gather|eqnarray)\}/g, ' ');
    s = s.replace(/\\\\[\s]*/g, ' ｜ ');           // 换行 → 竖线分隔
    s = s.replace(/&=\s*/g, '= ');                   // aligned/array 的 &= 本来就是等号
    s = s.replace(/&/g, '，');                       // 其余对齐符（cases 的分条件）→ 逗号

    // 分式（含 \dfrac \tfrac \cfrac），嵌套时递归；支持 \frac12 这类单字符简写
    const fracRe = /\\[dtc]?frac\s*/g;
    let guard = 0, m;
    while ((m = fracRe.exec(s)) !== null && guard++ < 200) {
      const i = m.index + m[0].length;
      let a, b, next;
      if (s[i] === '{') {
        const g1 = readGroup(s, i);
        const rest = g1.end;
        if (s[rest] === '{') { const g2 = readGroup(s, rest); b = g2.text; next = g2.end; }
        else { b = ''; next = rest; }
        a = g1.text;
      } else { a = s[i] || ''; b = s[i + 1] || ''; next = i + 2; }
      const inner = wrap(humanize(a, o)) + '/' + wrap(humanize(b, o));
      s = s.slice(0, m.index) + inner + s.slice(next);
      fracRe.lastIndex = m.index + inner.length;
    }

    // 根号：\sqrt[n]{x} → x 的 n 次方根；\sqrt{x} → √(x)
    guard = 0;
    let sqrtRe;
    while (guard++ < 200) {
      sqrtRe = /\\sqrt\s*/g;
      const hit = sqrtRe.exec(s);
      if (!hit) break;
      let i = hit.index + hit[0].length;
      let n = null;
      if (s[i] === '[') { const close = s.indexOf(']', i); if (close > i) { n = s.slice(i + 1, close); i = close + 1; } }
      const g = readGroup(s, i);
      const body = humanize(g.text, o);
      const rep = n !== null ? (wrap(body) + ' 的 ' + humanize(n, o) + ' 次方根') : ('√' + wrap(body));
      s = s.slice(0, hit.index) + rep + s.slice(g.end);
    }

    // \text{...} \mathrm \mathbf \operatorname 等 → 取内容
    s = s.replace(/\\(?:text|textrm|textbf|textit|textsf|mathrm|mathbf|mathit|mathsf|boldsymbol|bm|operatorname|mbox)\s*/g, function (mm) { return mm; });
    let tRe = /\\(?:text|textrm|textbf|textit|mathrm|mathbf|mathit|operatorname|mbox)\s*\{/g;
    guard = 0;
    while ((m = tRe.exec(s)) !== null && guard++ < 200) {
      const g = readGroup(s, m.index + m[0].length - 1);
      const rep = g.text.replace(/\\([%$&#_{}])/g, '$1');
      s = s.slice(0, m.index) + rep + s.slice(g.end);
      tRe.lastIndex = m.index + rep.length;
    }

    // 定界修饰与间距
    s = s.replace(/\\(?:left|right|bigl|bigr|Bigl|Bigr|biggl|biggr|middle)\s*(?:\{|\(|\[|\)|\]|\.|\\lbrace|\\rbrace|\\langle|\\rangle)/g, function (x) {
      return x.replace(/\\(?:left|right|bigl|bigr|Bigl|Bigr|biggl|biggr|middle)\s*/, '')
              .replace(/\\lbrace/g, '{').replace(/\\rbrace/g, '}')
              .replace(/\\langle/g, '⟨').replace(/\\rangle/g, '⟩')
              .replace(/\./g, '');
    });
    s = s.replace(/\\[,;!>:]|\\quad|\\qquad|\\hspace\s*\{[^}]*\}|\\kern\s*[0-9.]+(?:mu|pt|em)/g, ' ');
    s = s.replace(/\\mathord|\\displaystyle|\\textstyle|\\scriptstyle/g, '');

    // 上下标
    s = s.replace(/\^\s*\{?\\(?:circ|degree)s*\}?/g, '°');   // 90^\circ / 90^{\circ}
    s = s.replace(/\^\s*\{([^{}]*)\}/g, (all, g) => /^[0-9+\-n]+$/.test(g.trim()) ? mapScript(g.trim(), SUP) : '^' + wrap(g));
    s = s.replace(/\^\s*([0-9])/g, (all, g) => mapScript(g, SUP));
    s = s.replace(/_\s*\{([^{}]*)\}/g, (all, g) => /^[0-9+\-]+$/.test(g.trim()) ? mapScript(g.trim(), SUB) : '_' + g.trim());
    s = s.replace(/_\s*([0-9])/g, (all, g) => mapScript(g, SUB));

    // 带参数的宏（先处理有 {…} 的，再处理裸宏）
    s = s.replace(/\\(?:overline|underline|hat|widehat|bar|vec|overrightarrow|dot|ddot|tilde|widetilde|check|accent)\s*\{([^{}]*)\}/g,
      (all, inner) => inner.trim());
    s = s.replace(/\\(?:overset|underset)\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (all, a, b) => b.trim() + '（' + a.trim() + '）');
    s = s.replace(/\\(?:stackrel)\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (all, a, b) => b.trim() + '（上方记号：' + a.trim() + '）');
    s = s.replace(/\\(?:binom|dbinom)\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (all, a, b) => 'C(' + a.trim() + ',' + b.trim() + ')');
    s = s.replace(/\\(?:frac|dfrac|tfrac)\b/g, '/');  // 上面没匹配到的残缺分式，留个除号
    s = s.replace(/\\(?:sqrt)\b/g, '√');

    // 求和/积分/极限
    s = s.replace(/\\(?:sum|prod)\s*_\{\s*([^{}]*)\s*\}\s*\^\{\s*([^{}]*)\s*\}/g, (all, a, b) => 'Σ（从 ' + a.trim() + ' 到 ' + b.trim() + '）');
    s = s.replace(/\\(?:sum|prod)\b/g, all => (all.indexOf('prod') >= 0 ? '连乘' : '求和'));
    s = s.replace(/\\int\s*_\{\s*([^{}]*)\s*\}\s*\^\{\s*([^{}]*)\s*\}/g, (all, a, b) => '积分（' + a.trim() + ' 到 ' + b.trim() + '）');
    s = s.replace(/\\int\b/g, '积分');
    s = s.replace(/\\lim_\{\s*([^{}]*)\s*\}/g, (all, a) => '极限（当 ' + a.trim() + '）');
    s = s.replace(/\\(?:sin|cos|tan|cot|sec|csc|arcsin|arccos|arctan|log|ln|lg)\b/g, mm => mm.slice(1));
    s = s.replace(/\\(?:deg|degree)\b/g, '°');

    // 函数名映射
    s = s.replace(/\\([a-zA-Z]+)/g, function (all, name) {
      if (FUNCS[name]) return ' ' + FUNCS[name] + ' ';
      if (GREEK[name]) return GREEK[name];
      if (SYMBOLS[name]) return ' ' + SYMBOLS[name] + ' ';
      if (name === 'l' || name === 'r') return '';
      if (name === 'nonumber' || name === 'label' || name === 'notag' || name === 'tag') return '';
      return ' ' + name + ' ';        // 认不出的宏：丢掉反斜杠，只留词，绝不留源码
    });

    // 数学符号与转义字符
    s = s.replace(/\\([%$&#_{}|])/g, '$1');
    s = s.replace(/~|\{/g, m => (m === '{' ? '{' : ' '));
    // 定界符一律清掉（上一版这里写反了：先 replace(/\$\$?|\\([\[\]()])/) 把 \( 还原成 (，
    // 导致 "\(\frac{1}{2}\)" 输出 "(1/2)"，多出一对无意义括号）
    s = s.replace(/\$\$?/g, '');
    s = s.replace(/\\[\[\]()]/g, '');
    s = s.replace(/\s*，\s*/g, '，');
    s = s.replace(/\s*｜\s*/g, ' ｜ ');
    s = s.replace(/\s+([,;.)])/g, '$1');
    s = s.replace(/([(])\s+/g, '$1');
    s = s.replace(/[ \t]{2,}/g, ' ');
    s = s.trim();
    if (o.readAloud && s) s = s + '（读作：' + readAloud(s) + '）';
    return s;
  }

  // 少量关键符号的中文读法，供"先说怎么读"用
  function readAloud(s) {
    return String(s)
      .replace(/(\d|\))\/(\d|\()/g, '$1 除以 $2')
      .replace(/√\(?([^) ]*)\)?/g, '根号下 $1')
      .replace(/≤/g, '小于等于').replace(/≥/g, '大于等于').replace(/≠/g, '不等于')
      .replace(/≈/g, '约等于').replace(/×/g, '乘').replace(/÷/g, '除以')
      .replace(/°/g, '度').replace(/π/g, '圆周率 π')
      .replace(/²/g, ' 的平方').replace(/³/g, ' 的立方')
      .trim();
  }

  // 屏幕上是否还残留 LaTeX（用于渲染后兜底扫描）
  function containsLatex(s) {
    const t = String(s || '');
    return /\\[a-zA-Z]{2,}/.test(t) || /\$\$?[^$]{1,80}\$/.test(t) || /\\[\[\]()]/.test(t);
  }

  // 只清定界符，不动内容（KaTeX 正常渲染时不需要转写）
  function stripDelimiters(s) {
    return String(s || '').replace(/\$\$([\s\S]*?)\$\$/g, '$1').replace(/\$([^$]*)\$/g, '$1')
      .replace(/\\\[([\s\S]*?)\\\]/g, '$1').replace(/\\\(([\s\S]*?)\\\)/g, '$1');
  }

  return { humanize, readAloud, containsLatex, stripDelimiters, GREEK, SYMBOLS, FUNCS };
});
