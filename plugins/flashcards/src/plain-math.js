const SUPER = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ', x: 'ˣ', a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', t: 'ᵗ' };
const SUB = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', '=': '₌', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', n: 'ₙ', m: 'ₘ', x: 'ₓ' };
const INFIX = { in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', cup: '∪', cap: '∩', le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈', equiv: '≡', to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔', mapsto: '↦', implies: '⟹', iff: '⟺', land: '∧', lor: '∨', pm: '±', times: '×' };
const SYMBOLS = { alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', theta: 'θ', lambda: 'λ', mu: 'μ', pi: 'π', rho: 'ρ', sigma: 'σ', phi: 'φ', varphi: 'φ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Sigma: 'Σ', Omega: 'Ω', forall: '∀', exists: '∃', infty: '∞', partial: '∂', nabla: '∇', sum: '∑', prod: '∏', int: '∫', cdot: '·', dots: '…', ldots: '…', cdots: '⋯', R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ' };
const BLACKBOARD = { R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ', P: 'ℙ', E: '𝔼' };

function mapScript(raw, map, marker) {
  const clean = raw.replace(/[{}]/g, '').trim();
  if (!clean) return '';
  let out = '';
  for (const ch of clean) {
    if (!map[ch]) return clean.length === 1 ? `${marker}${clean}` : `${marker}(${clean})`;
    out += map[ch];
  }
  return out;
}

function renderTex(body) {
  return body
    .replace(/\\(?:left|right|big|Big|bigg|Bigg)\.?/g, '')
    .replace(/\\mathbb\{([A-Za-z])\}/g, (_, ch) => BLACKBOARD[ch] || ch)
    .replace(/\\(?:d|t)?frac\{([^{}]+)\}\{([^{}]+)\}/g, (_, a, b) => `${renderTex(a)}/${renderTex(b)}`)
    .replace(/\\sqrt\{([^{}]+)\}/g, (_, inner) => `√(${renderTex(inner)})`)
    .replace(/\\([A-Za-z]+)/g, (_, cmd) => {
      if (INFIX[cmd]) return ` ${INFIX[cmd]} `;
      if (SYMBOLS[cmd]) return SYMBOLS[cmd];
      if (cmd === 'text' || cmd === 'mathrm' || cmd === 'mathbf') return '';
      return cmd;
    })
    .replace(/\^(\{[^{}]+\}|[A-Za-z0-9+-])/g, (_, raw) => mapScript(raw, SUPER, '^'))
    .replace(/_(\{[^{}]+\}|[A-Za-z0-9+-])/g, (_, raw) => mapScript(raw, SUB, '_'))
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatBareProse(segment) {
  if (!/[\\^_]/.test(segment)) return segment;
  // Preserve URLs/paths verbatim while converting standalone bare TeX/scripts.
  return segment.replace(/https?:\/\/[^\s)<>\]"']+|(?:[A-Za-z]:\\|\\\\)\S+|\\mathbb\{([A-Za-z])\}|\\(?:d|t)?frac\{([^{}]+)\}\{([^{}]+)\}|\\sqrt\{([^{}]+)\}|\\([A-Za-z]{2,})|(\([^()\n]+\))\^(\{[^{}]+\}|-?\d+|[A-Za-z])|\b([A-Za-z\u0391-\u03c9])_(\{[^{}]+\}|\d+|[A-Za-z])(?![A-Za-z0-9_])|\b([A-Za-z0-9\u0391-\u03c9]+)\^(\{[^{}]+\}|-?\d+)(?![A-Za-z0-9_])/g,
    (whole, bb, fa, fb, sq, cmd, pBase, pExp, sBase, sSub, pwBase, pwExp) => {
      if (/^(?:https?:|[A-Za-z]:\\|\\\\)/.test(whole)) return whole;
      if (bb) return BLACKBOARD[bb] || bb;
      if (fa !== undefined) return `${renderTex(fa)}/${renderTex(fb)}`;
      if (sq !== undefined) return `√(${renderTex(sq)})`;
      if (cmd) {
        if (INFIX[cmd]) return INFIX[cmd];
        if (SYMBOLS[cmd]) return SYMBOLS[cmd];
        return whole;
      }
      if (pBase !== undefined) return `${pBase}${mapScript(pExp, SUPER, '^')}`;
      if (sBase !== undefined) return `${sBase}${mapScript(sSub, SUB, '_')}`;
      if (pwBase !== undefined) return `${pwBase}${mapScript(pwExp, SUPER, '^')}`;
      return whole;
    });
}

export function formatPlainMath(text) {
  if (typeof text !== 'string' || (!text.includes('$') && !text.includes('\\(') && !/[\\^_]/.test(text))) return text;
  const token = /(`[^`\n]+`|\\\((.+?)\\\)|\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$)/gs;
  let out = '';
  let last = 0;
  for (const m of text.matchAll(token)) {
    if (m.index > last) out += formatBareProse(text.slice(last, m.index));
    if (m[0].startsWith('`')) out += m[0];
    else out += renderTex(m[2] ?? m[3] ?? m[4] ?? '');
    last = m.index + m[0].length;
  }
  if (last < text.length) out += formatBareProse(text.slice(last));
  return out;
}
