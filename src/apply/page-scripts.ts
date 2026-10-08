/**
 * Scripts that run inside the page. Kept as plain strings because tsx rewrites
 * functions with name helpers that do not exist in the browser.
 */

export const COLLECT_FIELDS = String.raw`(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').replace(/\s*\*\s*$/, ' *').trim();
  const txt = (el) => clean(el ? el.innerText || el.textContent : '');
  const shown = (el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && (r.width > 0 || r.height > 0);
  };
  const inCaptcha = (el) => !!el.closest('[class*="captcha"],[id*="captcha"],.g-recaptcha,.h-captcha');
  const labelOf = (el) => {
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => txt(document.getElementById(id))).join(' ').trim();
      if (t) return t;
    }
    if (el.id) {
      const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (l && txt(l)) return txt(l);
    }
    const wrap = el.closest('label');
    if (wrap && txt(wrap)) return txt(wrap);
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    let p = el.parentElement;
    for (let i = 0; i < 5 && p; i++, p = p.parentElement) {
      const l = p.querySelector('label, legend, [class*="label"], [class*="question"], [class*="title"]');
      if (l && !l.contains(el) && txt(l)) return txt(l);
    }
    return clean(el.getAttribute('placeholder') || el.getAttribute('name') || '');
  };
  const groupLabel = (el) => {
    const fs = el.closest('fieldset');
    if (fs) {
      const lg = fs.querySelector('legend');
      if (lg && txt(lg)) return txt(lg);
    }
    const rg = el.closest('[role="radiogroup"],[role="group"]');
    if (rg) {
      const by = rg.getAttribute('aria-labelledby');
      if (by) return txt(document.getElementById(by));
      if (rg.getAttribute('aria-label')) return clean(rg.getAttribute('aria-label'));
    }
    let p = el.parentElement;
    for (let i = 0; i < 6 && p; i++, p = p.parentElement) {
      const l = p.querySelector('legend, [class*="label"], [class*="question"], label:not(:has(input))');
      if (l && !l.contains(el) && txt(l) && !l.querySelector('input')) return txt(l);
    }
    return el.name || '';
  };
  const isRequired = (el, label) =>
    el.required || el.getAttribute('aria-required') === 'true' || /\*\s*$/.test(label) || /\(required\)/i.test(label);

  let n = 0;
  const out = [];
  const groups = {};
  const els = Array.from(document.querySelectorAll('input, textarea, select'));
  for (const el of els) {
    if (inCaptcha(el) || el.disabled) continue;
    const type = (el.getAttribute('type') || el.tagName).toLowerCase();
    if (['hidden', 'submit', 'button', 'reset', 'image', 'search', 'password'].includes(type)) continue;
    if (type !== 'file' && type !== 'radio' && type !== 'checkbox' && !shown(el)) continue;

    if (type === 'radio' || (type === 'checkbox' && el.name && document.querySelectorAll('input[type=checkbox][name="' + CSS.escape(el.name) + '"]').length > 1)) {
      const key = type + ':' + (el.name || groupLabel(el));
      let g = groups[key];
      if (!g) {
        const label = groupLabel(el);
        g = groups[key] = { id: 'jr' + n++, kind: type === 'radio' ? 'radio' : 'checkbox-group', label, name: el.name || '', required: false, options: [] };
        out.push(g);
      }
      el.setAttribute('data-jr-id', g.id);
      el.setAttribute('data-jr-opt', String(g.options.length));
      g.options.push(labelOf(el) || el.value);
      g.required = g.required || isRequired(el, g.label);
      continue;
    }

    const id = 'jr' + n++;
    el.setAttribute('data-jr-id', id);
    const label = labelOf(el);
    let kind = el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : type;
    if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') === 'list') kind = 'combobox';
    if (!['text', 'email', 'tel', 'url', 'number', 'date', 'textarea', 'select', 'checkbox', 'combobox', 'file'].includes(kind)) kind = 'text';
    const options = el.tagName === 'SELECT'
      ? Array.from(el.options).filter((o) => o.value !== '' && !/^(select|choose|please select|--)/i.test(o.text.trim())).map((o) => clean(o.text))
      : [];
    out.push({ id, kind, label, name: el.name || '', required: isRequired(el, label), options, maxLength: el.maxLength > 0 ? el.maxLength : undefined });
  }
  return out;
})()`;

/** data-jr-ids of required fields that are still empty. */
export const EMPTY_REQUIRED = String.raw`(() => {
  const empty = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('[data-jr-id]')) {
    const id = el.getAttribute('data-jr-id');
    if (seen.has(id)) continue;
    const req = el.required || el.getAttribute('aria-required') === 'true';
    if (!req) continue;
    seen.add(id);
    const type = (el.getAttribute('type') || '').toLowerCase();
    let filled;
    if (type === 'radio' || type === 'checkbox') {
      filled = Array.from(document.querySelectorAll('[data-jr-id="' + id + '"]')).some((x) => x.checked);
    } else if (type === 'file') {
      filled = el.files && el.files.length > 0;
    } else {
      filled = !!(el.value && el.value.trim());
    }
    if (!filled) empty.push(id);
  }
  return empty;
})()`;

/** A challenge a person has to solve. Invisible scoring widgets are not counted. */
export const VISIBLE_CHALLENGE = String.raw`(() => {
  const frames = Array.from(document.querySelectorAll('iframe'));
  return frames.some((f) => {
    const src = f.src || '';
    const r = f.getBoundingClientRect();
    if (r.width < 50 || r.height < 50) return false;
    return /recaptcha\/(api2|enterprise)\/(anchor|bframe)|hcaptcha\.com.*(checkbox|challenge)|challenges\.cloudflare\.com/.test(src)
      && !/size=invisible/.test(src);
  });
})()`;

export const PAGE_TEXT = `(() => (document.body ? document.body.innerText : '').slice(0, 20000))()`;
