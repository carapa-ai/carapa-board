// Browser-side half of `bun run ui:audit` (see scripts/ui-sandbox/README.md).
// Not run directly: ui-audit.ts replaces the CFG placeholder with the run configuration and
// passes the file to `playwright-cli run-code`, which calls this function with
// a Playwright page of the signed-in sandbox browser. It prints ONE JSON
// document with mechanical numbers per view x viewport: no taste scoring.
async (page) => {
  const CFG = __CFG__;
  const result = { label: CFG.label, origin: null, viewports: {} };

  // Helpers installed into the page after every navigation.
  const install = () => {
    const A = (window.__audit = {});
    const cvs = document.createElement('canvas');
    cvs.width = cvs.height = 1;
    const ctx = cvs.getContext('2d', { willReadFrequently: true });
    const cache = new Map();
    A.rgba = (str) => {
      if (cache.has(str)) return cache.get(str);
      let v;
      if (!str || str === 'transparent') v = [0, 0, 0, 0];
      else {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = '#000';
        ctx.fillStyle = str;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        v = [d[0], d[1], d[2], d[3] / 255];
      }
      cache.set(str, v);
      return v;
    };
    A.over = (fg, bg) => {
      const a = fg[3];
      return [
        fg[0] * a + bg[0] * (1 - a),
        fg[1] * a + bg[1] * (1 - a),
        fg[2] * a + bg[2] * (1 - a),
        1,
      ];
    };
    A.lum = (c) => {
      const f = (v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    A.ratio = (a, b) => {
      const l1 = A.lum(a),
        l2 = A.lum(b);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };
    // Real background of an element: ancestor backgrounds blended bottom-up.
    A.bgOf = (el) => {
      const stack = [];
      let image = false;
      for (let n = el; n; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.backgroundImage && cs.backgroundImage !== 'none') image = true;
        const c = A.rgba(cs.backgroundColor);
        if (c[3] > 0) {
          stack.push(c);
          if (c[3] >= 0.999) break;
        }
      }
      let out = [0, 0, 0, 1];
      if (!(stack.length && stack[stack.length - 1][3] >= 0.999))
        out = A.rgba(
          getComputedStyle(document.documentElement).backgroundColor,
        );
      if (out[3] < 0.999) out = [0, 0, 0, 1];
      for (let i = stack.length - 1; i >= 0; i--) out = A.over(stack[i], out);
      return { color: out, image };
    };
    A.opacityOf = (el) => {
      let o = 1;
      for (let n = el; n; n = n.parentElement)
        o *= parseFloat(getComputedStyle(n).opacity);
      return o;
    };
    // Part of the element's box that is actually visible: clipped by scrolling
    // ancestors up to `stop` and by the viewport.
    A.visRect = (el, stop) => {
      const r = el.getBoundingClientRect();
      let l = r.left,
        t = r.top,
        rr = r.right,
        b = r.bottom;
      for (let n = el.parentElement; n; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
          const p = n.getBoundingClientRect();
          if (cs.overflowX !== 'visible') {
            l = Math.max(l, p.left);
            rr = Math.min(rr, p.right);
          }
          if (cs.overflowY !== 'visible') {
            t = Math.max(t, p.top);
            b = Math.min(b, p.bottom);
          }
        }
        if (n === stop) break;
      }
      l = Math.max(l, 0);
      t = Math.max(t, 0);
      rr = Math.min(rr, innerWidth);
      b = Math.min(b, innerHeight);
      if (rr - l < 1 || b - t < 1) return null;
      return { left: l, top: t, right: rr, bottom: b };
    };
    A.sel = (el) => {
      const ui = el.getAttribute('data-ui');
      const cls = (el.getAttribute('class') || '')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .join('.');
      const label = (el.getAttribute('aria-label') || el.textContent || '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 40);
      return `${el.tagName.toLowerCase()}${ui ? '[' + ui + ']' : ''}${cls ? '.' + cls : ''} "${label}"`;
    };
    // Measurement root: the view's `scope` selector, else the topmost open
    // dialog or menu, else the whole page.
    A.scope = (sel) => {
      if (sel) return document.querySelector(sel);
      const open = [
        ...document.querySelectorAll(
          '[role=dialog],[role=alertdialog],[role=menu]',
        ),
      ].filter((n) => {
        const r = n.getBoundingClientRect();
        return (
          r.width > 0 &&
          r.height > 0 &&
          getComputedStyle(n).visibility !== 'hidden'
        );
      });
      return open[open.length - 1] ?? document.body;
    };
  };

  const measure = (cfg) => {
    const A = window.__audit;
    const root = A.scope(cfg.scope);
    if (!root) return { error: `scope not found: ${cfg.scope}` };
    const isPage = root === document.body;
    const out = {};
    const vw = innerWidth,
      vh = innerHeight;
    const rr0 = root.getBoundingClientRect();
    const visible = (el) => {
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') return false;
      return !!A.visRect(el, root);
    };
    const all = [...root.querySelectorAll('*')];
    out.scope = { el: A.sel(root), role: root.getAttribute('role'), isPage };

    // Overflow, clipped and off-viewport elements.
    const el = document.documentElement;
    out.overflow = {
      documentX: el.scrollWidth > el.clientWidth + 1,
      bodyX: document.body.scrollWidth > document.body.clientWidth + 1,
      scopeX: !isPage && root.scrollWidth > root.clientWidth + 1,
      scopeRect: [
        Math.round(rr0.left),
        Math.round(rr0.top),
        Math.round(rr0.right),
        Math.round(rr0.bottom),
      ],
      scopeInsideViewport:
        isPage ||
        (rr0.left >= -0.5 &&
          rr0.right <= vw + 0.5 &&
          rr0.top >= -0.5 &&
          rr0.bottom <= vh + 0.5),
      scrollAreasX: [],
      offViewport: [],
      clippedHorizontally: [],
    };
    for (const n of all) {
      if (
        n.scrollWidth > n.clientWidth + 1 &&
        n.clientWidth > 0 &&
        !n.closest('.sr-only')
      ) {
        const cs = getComputedStyle(n);
        if (cs.overflowX === 'visible' || !visible(n)) continue;
        const kind =
          cs.textOverflow === 'ellipsis'
            ? 'truncated'
            : cs.overflowX === 'hidden' || cs.overflowX === 'clip'
              ? 'clipped'
              : 'scrollable';
        out.overflow.scrollAreasX.push({
          el: A.sel(n),
          kind,
          clientWidth: n.clientWidth,
          scrollWidth: n.scrollWidth,
        });
      }
    }
    for (const n of all) {
      if (
        !n.children.length &&
        !(n.textContent || '').trim() &&
        n.tagName !== 'INPUT'
      )
        continue;
      const cs = getComputedStyle(n);
      if (
        cs.visibility === 'hidden' ||
        cs.display === 'none' ||
        n.closest('[aria-hidden=true]')
      )
        continue;
      const r = n.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const v = A.visRect(n, root);
      if (!v) continue;
      if (v.right > vw + 0.5 || (r.left < -0.5 && v.left <= 0.5 && r.right > 0))
        out.overflow.offViewport.push(A.sel(n));
      const interactive = n.matches(
        'button,a[href],input,select,textarea,[role=tab],[role=button],[role=menuitem]',
      );
      if (interactive && (r.left < v.left - 0.5 || r.right > v.right + 0.5))
        out.overflow.clippedHorizontally.push({
          el: A.sel(n),
          w: Math.round(r.width),
          visibleW: Math.round(v.right - v.left),
        });
    }
    out.overflow.offViewport = out.overflow.offViewport.slice(0, 8);
    out.overflow.clippedHorizontally = out.overflow.clippedHorizontally.slice(
      0,
      8,
    );

    // Truncated text: ellipsis, line clamp, and field values wider than the field.
    const truncated = [];
    for (const n of all) {
      if (!visible(n)) continue;
      const cs = getComputedStyle(n);
      if (cs.textOverflow === 'ellipsis' && n.scrollWidth > n.clientWidth + 1)
        truncated.push({
          el: A.sel(n),
          kind: 'ellipsis',
          clientWidth: n.clientWidth,
          scrollWidth: n.scrollWidth,
        });
      else if (
        cs.webkitLineClamp &&
        cs.webkitLineClamp !== 'none' &&
        n.scrollHeight > n.clientHeight + 1
      )
        truncated.push({
          el: A.sel(n),
          kind: 'line-clamp',
          clientHeight: n.clientHeight,
          scrollHeight: n.scrollHeight,
        });
      else if (
        n.matches('input:not([type=checkbox]):not([type=radio]),textarea') &&
        (n.scrollWidth > n.clientWidth + 1 ||
          (n.tagName === 'TEXTAREA' && n.scrollHeight > n.clientHeight + 1))
      )
        truncated.push({
          el: A.sel(n),
          kind: 'field',
          clientWidth: n.clientWidth,
          scrollWidth: n.scrollWidth,
        });
    }
    out.truncation = { count: truncated.length, list: truncated.slice(0, 12) };

    // Font sizes of visible text.
    const sizes = [];
    {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (w.nextNode()) {
        const n = w.currentNode;
        if (!n.nodeValue.trim()) continue;
        const p = n.parentElement;
        if (
          !p ||
          p.closest('script,style,svg,[aria-hidden=true],.sr-only,.hidden')
        )
          continue;
        if (!A.visRect(p, root)) continue;
        sizes.push(parseFloat(getComputedStyle(p).fontSize));
      }
    }
    out.text = {
      runs: sizes.length,
      under11px: sizes.filter((x) => x < 11).length,
      minPx: sizes.length ? Math.min(...sizes) : null,
    };

    // Tap targets and primary actions.
    const interactiveSel =
      'button,a[href],input:not([type=hidden]):not(.hidden),select,textarea,[role=tab],[role=button],[role=menuitem],[role=checkbox],[role=switch],[role=option],summary';
    const targets = [...root.querySelectorAll(interactiveSel)].filter(
      (n) => !n.closest('.hidden,[inert],[aria-hidden=true]') && visible(n),
    );
    const inlineLink = (n) =>
      n.tagName === 'A' &&
      getComputedStyle(n).display === 'inline' &&
      (n.parentElement?.textContent || '').trim() !==
        (n.textContent || '').trim();
    const sized = targets.filter((n) => !inlineLink(n));
    const primary = targets.filter(
      (n) =>
        n.matches('button,a,[role=button]') &&
        (n.getAttribute('class') || '').split(/\s+/).includes('bg-primary'),
    );
    const box = (n) => {
      const r = n.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    };
    const small = sized.filter((n) => {
      const b = box(n);
      return b.w < 24 || b.h < 24;
    });
    // WCAG 2.2 AA asks 24px everywhere; the 44px primary-target check is for
    // touch-sized viewports only (width <= 480px or a coarse pointer).
    const touchSized =
      window.innerWidth <= 480 || matchMedia('(pointer: coarse)').matches;
    const smallPrimary = touchSized
      ? primary.filter((n) => {
          const r = n.getBoundingClientRect();
          return r.width < 44 || r.height < 44;
        })
      : [];
    out.targets = {
      interactiveCount: targets.length,
      inlineLinksExempt: targets.length - sized.length,
      primaryCount: primary.length,
      touchSized,
      primary: primary.map((n) => ({ el: A.sel(n), ...box(n) })),
      under24: small.length,
      under24List: small.slice(0, 40).map((n) => ({ el: A.sel(n), ...box(n) })),
      primaryUnder44: smallPrimary.length,
      primaryUnder44List: smallPrimary.map((n) => ({
        el: A.sel(n),
        ...box(n),
      })),
    };
    const btns = [...root.querySelectorAll('button')].filter(
      (b) =>
        !b.closest('.hidden') && visible(b) && b.getAttribute('role') !== 'tab',
    );
    out.targets.sharedButtonShare = btns.length
      ? Math.round(
          (btns.filter((b) => b.getAttribute('data-slot') === 'button').length /
            btns.length) *
            100,
        ) / 100
      : null;
    out.targets.buttons = btns.length;

    // Text rectangles for overlaps and contrast.
    const entries = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const n = walker.currentNode;
      const t = n.nodeValue.trim();
      if (!t) continue;
      const p = n.parentElement;
      if (
        !p ||
        p.closest('script,style,svg,[aria-hidden=true],.sr-only,.hidden')
      )
        continue;
      const cs = getComputedStyle(p);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const vis = A.visRect(p, root);
      if (!vis) continue;
      const rects = [];
      for (const r of range.getClientRects()) {
        if (r.width < 1 || r.height < 1) continue;
        const l = Math.max(r.left, vis.left),
          tp = Math.max(r.top, vis.top),
          rr = Math.min(r.right, vis.right),
          b = Math.min(r.bottom, vis.bottom);
        if (rr - l >= 1 && b - tp >= 1)
          rects.push({ left: l, top: tp, right: rr, bottom: b });
      }
      if (rects.length) entries.push({ p, t, rects, cs });
    }
    const overlaps = [];
    const flat = [];
    entries.forEach((e, i) => e.rects.forEach((r) => flat.push({ i, r })));
    for (let a = 0; a < flat.length; a++) {
      for (let b = a + 1; b < flat.length; b++) {
        const x = flat[a],
          y = flat[b];
        if (x.i === y.i) continue;
        const iw =
          Math.min(x.r.right, y.r.right) - Math.max(x.r.left, y.r.left);
        const ih =
          Math.min(x.r.bottom, y.r.bottom) - Math.max(x.r.top, y.r.top);
        if (iw <= 1 || ih <= 1) continue;
        const area = iw * ih;
        const sm = Math.min(
          (x.r.right - x.r.left) * (x.r.bottom - x.r.top),
          (y.r.right - y.r.left) * (y.r.bottom - y.r.top),
        );
        if (area > 6 && area / sm > 0.15)
          overlaps.push({
            a: entries[x.i].t.slice(0, 30),
            b: entries[y.i].t.slice(0, 30),
            px: Math.round(area),
          });
      }
    }
    // Pills that touch neighbouring text on the same line (gap < 2px).
    const touching = [];
    for (const pill of root.querySelectorAll('span,div,a,button')) {
      const cs = getComputedStyle(pill);
      if (!/inline/.test(cs.display)) continue;
      const bg = A.rgba(cs.backgroundColor);
      if (bg[3] < 0.05 && parseFloat(cs.borderTopWidth) < 1) continue;
      if (
        (pill.textContent || '').trim().length > 40 ||
        !(pill.textContent || '').trim()
      )
        continue;
      if (!visible(pill)) continue;
      const pr = pill.getBoundingClientRect();
      for (const e of entries) {
        if (pill.contains(e.p) || e.p.contains(pill)) continue;
        for (const r of e.rects) {
          const vo = Math.min(pr.bottom, r.bottom) - Math.max(pr.top, r.top);
          if (vo < Math.min(pr.height, r.bottom - r.top) * 0.5) continue;
          const gap = Math.max(r.left - pr.right, pr.left - r.right);
          if (gap < 2)
            touching.push({
              pill: (pill.textContent || '').trim().slice(0, 24),
              text: e.t.slice(0, 24),
              gapPx: Math.round(gap * 10) / 10,
            });
        }
      }
    }
    out.collisions = {
      overlappingText: overlaps.length,
      overlapList: overlaps.slice(0, 8),
      touchingPills: touching.length,
      touchingList: touching.slice(0, 8),
    };

    // Text contrast from computed colours (alpha blended over the real background).
    const fails = new Map();
    let tested = 0,
      minRatio = 99;
    for (const e of entries) {
      const bg = A.bgOf(e.p);
      if (bg.image) continue;
      const c = A.rgba(e.cs.color);
      const fg = A.over([c[0], c[1], c[2], c[3] * A.opacityOf(e.p)], bg.color);
      const ratio = A.ratio(fg, bg.color);
      const size = parseFloat(e.cs.fontSize);
      const bold = parseInt(e.cs.fontWeight, 10) >= 700;
      const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
      if (e.p.closest(':disabled,[aria-disabled=true]')) continue;
      tested++;
      minRatio = Math.min(minRatio, ratio);
      if (ratio < need) {
        const key = `${e.p.tagName.toLowerCase()}|${e.cs.color}|${Math.round(ratio * 100)}`;
        const prev = fails.get(key);
        if (prev) prev.count++;
        else
          fails.set(key, {
            el: A.sel(e.p),
            ratio: Math.round(ratio * 100) / 100,
            need,
            sizePx: size,
            color: e.cs.color,
            count: 1,
          });
      }
    }
    out.contrast = {
      textTested: tested,
      textFailures: [...fails.values()].reduce((s, f) => s + f.count, 0),
      minTextRatio: Math.round(minRatio * 100) / 100,
      failureList: [...fails.values()]
        .sort((a, b) => a.ratio - b.ratio)
        .slice(0, 12),
    };
    // UI component contrast (field boundaries, icon-only controls) >= 3:1.
    const ui = [];
    for (const n of targets) {
      const cs = getComputedStyle(n);
      const bgp = A.bgOf(n.parentElement ?? n);
      if (bgp.image || n.matches(':disabled')) continue;
      const isField = n.matches(
        'input:not([type=checkbox]):not([type=radio]),select,textarea',
      );
      const iconOnly =
        !(n.textContent || '').trim() &&
        n.querySelector('svg') &&
        !n.querySelector('img');
      if (isField) {
        const bw = parseFloat(cs.borderTopWidth);
        const own = A.bgOf(n).color;
        const bc = A.rgba(cs.borderTopColor);
        const border =
          bw > 0 && bc[3] > 0
            ? A.over([bc[0], bc[1], bc[2], bc[3]], bgp.color)
            : null;
        const best = Math.max(
          border ? A.ratio(border, bgp.color) : 0,
          A.ratio(own, bgp.color),
        );
        if (best < 3)
          ui.push({
            el: A.sel(n),
            kind: 'field-boundary',
            ratio: Math.round(best * 100) / 100,
          });
      } else if (iconOnly) {
        const c = A.rgba(cs.color);
        const bg = A.bgOf(n).color;
        // Hover-revealed controls sit at opacity 0 at rest; measure them as shown.
        const op = A.opacityOf(n);
        const r = A.ratio(
          A.over([c[0], c[1], c[2], c[3] * (op < 0.05 ? 1 : op)], bg),
          bg,
        );
        if (r < 3)
          ui.push({
            el: A.sel(n),
            kind: 'icon',
            ratio: Math.round(r * 100) / 100,
          });
      }
    }
    out.contrast.uiFailures = ui.length;
    out.contrast.uiFailureList = ui.slice(0, 10);

    // Density and dead space inside the density scope (default: the scope).
    const panel = cfg.densityScope
      ? document.querySelector(cfg.densityScope)
      : root;
    if (panel && !isPage) {
      const pr = panel.getBoundingClientRect();
      const bands = [];
      for (const n of panel.querySelectorAll('*')) {
        const cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const r = n.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        const own = [...n.childNodes].some(
          (c) => c.nodeType === 3 && c.nodeValue.trim(),
        );
        const leafControl = n.matches(
          'button,input,select,textarea,img,video,svg,canvas',
        );
        const boxed =
          parseFloat(cs.borderTopWidth) > 0 ||
          A.rgba(cs.backgroundColor)[3] > 0.05;
        if (!own && !leafControl && !boxed) continue;
        if (n.closest('svg') && n.tagName !== 'svg') continue;
        const top = Math.max(r.top, pr.top),
          bottom = Math.min(r.bottom, pr.bottom);
        if (bottom - top >= 1) bands.push([top, bottom]);
      }
      bands.sort((a, b) => a[0] - b[0]);
      const gaps = [];
      let cur = pr.top + parseFloat(getComputedStyle(panel).paddingTop);
      const GAP = 32;
      let covered = 0;
      for (const [t, b] of bands) {
        if (t - cur >= GAP)
          gaps.push({ at: Math.round(cur - pr.top), px: Math.round(t - cur) });
        if (b > cur) {
          covered += b - Math.max(cur, t);
          cur = b;
        }
      }
      const tail =
        pr.bottom - parseFloat(getComputedStyle(panel).paddingBottom) - cur;
      if (tail >= GAP && panel.scrollHeight <= panel.clientHeight + 1)
        gaps.push({
          at: Math.round(cur - pr.top),
          px: Math.round(tail),
          tail: true,
        });
      const dead = gaps.filter((g) => !g.tail).reduce((s, g) => s + g.px, 0);
      const tailPx = gaps.filter((g) => g.tail).reduce((s, g) => s + g.px, 0);
      const h = Math.max(1, panel.clientHeight);
      out.density = {
        clientHeight: Math.round(panel.clientHeight),
        scrollHeight: Math.round(panel.scrollHeight),
        scrolls: panel.scrollHeight > panel.clientHeight + 1,
        deadGapsPx: dead,
        deadShare: Math.round((dead / h) * 1000) / 1000,
        tailPx,
        tailShare: Math.round((tailPx / h) * 1000) / 1000,
        gaps: gaps.slice(0, 8),
        scrollWidthExceeds: panel.scrollWidth > panel.clientWidth + 1,
      };
    }
    return out;
  };

  // Walk focus through the scope: 'tab' presses Tab (dialogs), 'arrows'
  // presses ArrowDown (menus, where Tab is intercepted). Records ring presence
  // and contrast per reached control, controls that left the scope (focus
  // trap) and focusable controls the walk never reached.
  const focusWalk = async (view, mode) => {
    const key = mode === 'arrows' ? 'ArrowDown' : 'Tab';
    // Baseline styles must be read unfocused, or a control that the dialog
    // focused on open (Radix focuses the first one) shows no ring "change".
    // Menus keep their focus: ArrowDown needs it.
    if (mode !== 'arrows') {
      await page.evaluate(() => document.activeElement?.blur?.());
      await page.waitForTimeout(250);
    }
    await page.evaluate((scopeSel) => {
      const d = window.__audit.scope(scopeSel);
      let i = 0;
      const base = new Map();
      for (const n of d.querySelectorAll(
        'button,a[href],input,select,textarea,[role=tab],[role=button],[role=menuitem],[role=checkbox],[tabindex]',
      )) {
        n.setAttribute('data-audit-id', String(i));
        const cs = getComputedStyle(n);
        base.set(String(i), {
          bs: cs.boxShadow,
          bc: cs.borderTopColor,
          bg: cs.backgroundColor,
        });
        i++;
      }
      window.__auditBase = base;
    }, view.scope ?? null);
    const steps = [];
    const seen = new Set();
    let lastId = null,
      repeats = 0;
    for (let i = 0; i < (CFG.maxTab || 70); i++) {
      await page.keyboard.press(key);
      await page.waitForTimeout(230); // let the ring transition (150ms) finish
      const s = await page.evaluate((scopeSel) => {
        const A = window.__audit;
        const d = A.scope(scopeSel);
        const a = document.activeElement;
        if (!a || a === document.body) return { body: true };
        // The menu container itself holds focus while it has no items.
        if (a.getAttribute('role') === 'menu') return { container: true };
        const inScope = !!d && d.contains(a);
        // Controls the browser made focusable on its own (scrollable regions)
        // have no baseline: give them an id so the walk can tell them apart.
        let id = a.getAttribute('data-audit-id');
        if (!id) {
          id = 'auto-' + (window.__auditAuto = (window.__auditAuto || 0) + 1);
          a.setAttribute('data-audit-id', id);
        }
        const cs = getComputedStyle(a);
        const b = window.__auditBase.get(id) ?? null;
        const outline =
          cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
        const shadowChanged =
          !!b && cs.boxShadow !== b.bs && cs.boxShadow !== 'none';
        const borderChanged = !!b && cs.borderTopColor !== b.bc;
        // Menu items show focus as a highlighted row, not a ring.
        const rowHighlight =
          !!b &&
          a.getAttribute('role') === 'menuitem' &&
          cs.backgroundColor !== b.bg;
        let ringContrast = null,
          ringOuter = null;
        const uaAuto = outline && cs.outlineStyle === 'auto';
        if ((shadowChanged || outline) && !uaAuto) {
          let m = null;
          if (outline) m = cs.outlineColor;
          else {
            // The ring is the last zero-blur shadow with a positive spread;
            // later shadows (shadow-xs and friends) are elevation, not focus.
            const re =
              /(rgba?\([^)]*\)|oklch\([^)]*\)|oklab\([^)]*\)|color\([^)]*\)|lab\([^)]*\)|lch\([^)]*\))\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px/g;
            for (const x of cs.boxShadow.matchAll(re))
              if (
                parseFloat(x[4]) === 0 &&
                parseFloat(x[5]) > 0 &&
                A.rgba(x[1])[3] > 0
              )
                m = x[1];
          }
          if (m) {
            const c = A.rgba(m);
            const bg = A.bgOf(a).color;
            ringContrast = Math.round(A.ratio(A.over(c, bg), bg) * 100) / 100;
            // The ring sits outside the control: also measure it against the
            // surrounding background (differs for filled controls).
            const outer = A.bgOf(a.parentElement ?? a).color;
            ringOuter =
              Math.round(A.ratio(A.over(c, outer), outer) * 100) / 100;
          }
        }
        return {
          id,
          inScope,
          ring: outline || shadowChanged || borderChanged || rowHighlight,
          ringContrast,
          ringOuter,
          uaAuto,
          label: A.sel(a),
        };
      }, view.scope ?? null);
      if (s.body) {
        steps.push(s);
        break;
      }
      if (s.container) continue;
      // Date and time inputs keep Tab inside their segments: stay on the same
      // control for a few presses, but a revisit of an earlier control ends the walk.
      if (s.id === lastId) {
        if (++repeats > 4) break;
        continue;
      }
      repeats = 0;
      lastId = s.id;
      if (seen.has(s.id)) break;
      seen.add(s.id);
      steps.push(s);
    }
    const unreached = await page.evaluate(
      ([scopeSel, reached]) => {
        const A = window.__audit;
        const d = A.scope(scopeSel);
        const set = new Set(reached);
        return [
          ...d.querySelectorAll(
            'button,a[href],input:not([type=hidden]),select,textarea,[role=menuitem],[role=checkbox]',
          ),
        ]
          .filter(
            (n) =>
              !n.disabled &&
              !n.hasAttribute('inert') &&
              !n.closest('.hidden,[inert],[aria-hidden=true]') &&
              getComputedStyle(n).display !== 'none' &&
              n.getBoundingClientRect().width > 0 &&
              !set.has(n.getAttribute('data-audit-id')),
          )
          .map((n) => A.sel(n))
          .slice(0, 10);
      },
      [view.scope ?? null, steps.map((s) => s.id).filter(Boolean)],
    );
    return {
      mode,
      reached: steps.length,
      leftScope: steps.filter((s) => s.inScope === false).length,
      withoutRing: steps.filter((s) => s.ring === false).length,
      withoutRingList: steps
        .filter((s) => s.ring === false)
        .map((s) => s.label)
        .slice(0, 10),
      uaAutoRings: steps.filter((s) => s.uaAuto).length,
      ringContrastMin: steps
        .filter((s) => s.ringContrast != null)
        .reduce((m, s) => Math.min(m, s.ringContrast), 99),
      ringContrastBelow3: steps.filter(
        (s) => s.ringContrast != null && s.ringContrast < 3,
      ).length,
      ringBelow3List: steps
        .filter((s) => s.ringContrast != null && s.ringContrast < 3)
        .map((s) => `${s.label} -> ${s.ringContrast}`)
        .slice(0, 14),
      ringOuterMin: steps
        .filter((s) => s.ringOuter != null)
        .reduce((m, s) => Math.min(m, s.ringOuter), 99),
      ringOuterBelow3: steps.filter(
        (s) => s.ringOuter != null && s.ringOuter < 3,
      ).length,
      unreached,
    };
  };

  const settle = async (view) => {
    // page.waitForFunction needs setTimeout, which run-code does not provide:
    // poll with evaluate + waitForTimeout instead.
    if (view.settle !== false) {
      for (let i = 0; i < 40; i++) {
        const ready = await page.evaluate((scopeSel) => {
          const d = window.__audit?.scope?.(scopeSel);
          if (!d) return false;
          return !d.querySelector('.animate-spin,[aria-busy=true]');
        }, view.scope ?? null);
        if (ready) break;
        await page.waitForTimeout(200);
      }
    }
    // Content that streams in after the spinner (lists, messages): wait until
    // the scope's text and element count stop changing for two polls.
    if (view.settle !== false) {
      let last = '';
      for (let i = 0; i < 30; i++) {
        const sig = await page.evaluate((scopeSel) => {
          const d = window.__audit.scope(scopeSel);
          return d
            ? `${d.innerText.length}:${d.querySelectorAll('*').length}`
            : '';
        }, view.scope ?? null);
        if (sig === last) break;
        last = sig;
        await page.waitForTimeout(250);
      }
    }
    await page.waitForTimeout(view.settleMs ?? 350); // animate-in fade
  };

  const runSteps = async (steps) => {
    for (const s of steps || []) {
      // `unless`: skip the step when that selector is already visible (toggles).
      if (
        s.unless &&
        (await page
          .locator(s.unless)
          .first()
          .isVisible()
          .catch(() => false))
      )
        continue;
      if (s.click) await page.locator(s.click).first().click({ timeout: 8000 });
      else if (s.clickAll) {
        await page.evaluate(
          (sel) => document.querySelectorAll(sel).forEach((b) => b.click()),
          s.clickAll,
        );
        await page.waitForTimeout(400);
      } else if (s.fill)
        await page
          .locator(s.fill[0])
          .first()
          .fill(s.fill[1], { timeout: 8000 });
      else if (s.select)
        await page
          .locator(s.select[0])
          .first()
          .selectOption(s.select[1], { timeout: 8000 });
      else if (s.check)
        await page.locator(s.check).first().check({ timeout: 8000 });
      else if (s.press) await page.keyboard.press(s.press);
      else if (s.hover)
        await page.locator(s.hover).first().hover({ timeout: 8000 });
      else if (s.focus)
        await page.locator(s.focus).first().focus({ timeout: 8000 });
      else if (s.scrollIntoView)
        await page
          .locator(s.scrollIntoView)
          .first()
          .scrollIntoViewIfNeeded({ timeout: 8000 });
      else if (s.waitFor)
        await page.waitForSelector(s.waitFor, { timeout: 15000 });
      else if (s.wait) await page.waitForTimeout(s.wait);
      if (s.then) await page.waitForTimeout(s.then);
    }
  };

  // Mocked requests that are still delayed. A delayed request must finish
  // (with its mocked response) before the view is left: dropping the route
  // would let the request reach the real server and change sandbox data.
  let pendingMocks = 0;
  const applyMocks = async (mocks) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
    for (const m of mocks || []) {
      await page.route(
        (u) => u.pathname.includes(m.url),
        async (route) => {
          if (m.method && route.request().method() !== m.method)
            return route.continue();
          if (
            m.status === undefined &&
            m.json === undefined &&
            !m.delayMs &&
            !m.patch
          )
            return route.continue();
          pendingMocks++;
          try {
            if (m.delayMs) await page.waitForTimeout(m.delayMs);
            if (m.patch) {
              // Patch the real response: set dotted paths on the object(s) matching `match`.
              const real = await route.fetch();
              let body;
              try {
                body = await real.json();
              } catch {
                return await route.fulfill({ response: real });
              }
              const patches = [].concat(m.patch);
              const walk = (node) => {
                if (Array.isArray(node)) return node.forEach(walk);
                if (!node || typeof node !== 'object') return;
                for (const patch of patches)
                  if (
                    Object.entries(patch.match || {}).every(
                      ([k, v]) => node[k] === v,
                    )
                  )
                    for (const [path, value] of Object.entries(patch.set)) {
                      const keys = path.split('.');
                      let at = node;
                      for (const k of keys.slice(0, -1)) at = at[k] ??= {};
                      at[keys.at(-1)] = value;
                    }
                Object.values(node).forEach(walk);
              };
              walk(body);
              return await route.fulfill({ response: real, json: body });
            }
            if (m.status === undefined && m.json === undefined)
              return await route.continue();
            return await route.fulfill({
              status: m.status ?? 200,
              contentType: 'application/json',
              body: JSON.stringify(m.json ?? {}),
            });
          } finally {
            pendingMocks--;
          }
        },
      );
    }
  };

  // WebSocket mocks: messages the server pushes right after a socket whose path
  // contains `url` opens. `"$frame"` in `send` becomes a JPEG of a small page.
  // Installed once per run (Playwright cannot unroute a WebSocket route); the
  // handler reads `activeWsMocks`, which each view sets. Sockets with no
  // matching mock connect to the real server.
  let activeWsMocks = [];
  let wsRouted = false;
  let frameJpeg = null;
  const applyWsMocks = async (mocks) => {
    activeWsMocks = mocks || [];
    if (!activeWsMocks.length || wsRouted) return;
    wsRouted = true;
    await page.routeWebSocket(
      () => true,
      (ws) => {
        const mock = activeWsMocks.find((m) => ws.url().includes(m.url));
        if (!mock) return ws.connectToServer();
        void (async () => {
          if (!frameJpeg && JSON.stringify(mock.send).includes('$frame')) {
            const tmp = await page.context().newPage();
            await tmp.setViewportSize({ width: 640, height: 400 });
            await tmp.setContent(
              '<body style="margin:0;font:28px system-ui;background:#eff6ff;color:#0f172a;padding:40px"><h1>Local application</h1><p>Running inside the agent sandbox</p></body>',
            );
            frameJpeg = (await tmp.screenshot({ type: 'jpeg' })).toString(
              'base64',
            );
            await tmp.close();
          }
          for (const message of mock.send || []) {
            ws.send(
              JSON.stringify(message).replaceAll(
                '"$frame"',
                JSON.stringify(frameJpeg),
              ),
            );
          }
        })();
      },
    );
  };

  // Header rows: clusters the visible controls and text lines of a toolbar
  // region into rows by vertical position, to count how many stacked rows a
  // header takes, which rows hold a single lone control, and its height.
  // `scope` is the region; `until` ends it at the first visible match.
  const measureRows = ({ scope, until }) => {
    const root = document.querySelector(scope);
    if (!root) return null;
    const visible = (e) => {
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return (
        r.width > 0 &&
        r.height > 0 &&
        cs.visibility !== 'hidden' &&
        cs.display !== 'none'
      );
    };
    const top = root.getBoundingClientRect().top;
    const stop = until ? [...root.querySelectorAll(until)].find(visible) : null;
    const limit = stop ? stop.getBoundingClientRect().top : Infinity;
    const controlSel = 'button,input,[role=combobox],[role=checkbox],a[href]';
    const items = [];
    for (const e of root.querySelectorAll('*')) {
      if (!visible(e)) continue;
      const r = e.getBoundingClientRect();
      if (r.top >= limit - 1) continue;
      const isControl = e.matches(controlSel);
      const isText =
        !isControl &&
        !e.closest(controlSel) &&
        !e.children.length &&
        (e.textContent || '').trim();
      if (!isControl && !isText) continue;
      if (e.closest('iframe')) continue;
      items.push({
        kind: isControl ? 'control' : 'text',
        cy: r.top + r.height / 2,
        bottom: r.bottom,
        label: (
          e.getAttribute('aria-label') ||
          e.textContent ||
          e.getAttribute('placeholder') ||
          e.tagName
        )
          .trim()
          .slice(0, 28),
      });
    }
    items.sort((a, b) => a.cy - b.cy);
    const rows = [];
    for (const it of items) {
      const row = rows[rows.length - 1];
      if (row && it.cy - row.cy < 8) row.items.push(it);
      else rows.push({ cy: it.cy, items: [it] });
    }
    return {
      rows: rows.length,
      loneControlRows: rows.filter(
        (r) => r.items.length === 1 && r.items[0].kind === 'control',
      ).length,
      controls: items.filter((i) => i.kind === 'control').length,
      textLines: rows.filter((r) => r.items.some((i) => i.kind === 'text'))
        .length,
      height: Math.round(Math.max(0, ...items.map((i) => i.bottom)) - top),
      layout: rows.map((r) => r.items.map((i) => i.label)),
    };
  };

  // Toolbar insets: where a tab's toolbar sits in its pane. `pane` is the
  // pane root, `toolbar` the toolbar element (its first row is measured).
  // Reports the container insets, the first item's inset, the gap above (to the
  // tab strip), the first row's height, the median gap between its items and
  // whether the toolbar has a bottom separator.
  const measureToolbar = ({ pane, toolbar }) => {
    const paneEl = document.querySelector(pane);
    const visible = (e) => {
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return (
        r.width > 0 &&
        r.height > 0 &&
        cs.visibility !== 'hidden' &&
        cs.display !== 'none'
      );
    };
    // Forced-mounted inactive tabs are hidden: take the first visible match (the
    // Browser tab renders outside the pane element, in a fixed layer).
    const tb = paneEl && [...document.querySelectorAll(toolbar)].find(visible);
    if (!tb) return null;
    const p = paneEl.getBoundingClientRect();
    const t = tb.getBoundingClientRect();
    const controlSel = 'button,input,[role=combobox],a[href]';
    const items = [];
    for (const e of tb.querySelectorAll('*')) {
      if (!visible(e)) continue;
      // A [data-toolbar-group] or [role=toolbar] (a segmented control) counts as one item.
      const group = e.closest('[data-toolbar-group],[role=toolbar]');
      if (group && group !== e) continue;
      const isControl = e.matches(controlSel) || e === group;
      const isText =
        !isControl &&
        !e.closest(controlSel) &&
        [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!isControl && !isText) continue;
      const r = e.getBoundingClientRect();
      items.push({
        l: r.left,
        r: r.right,
        t: r.top,
        b: r.bottom,
        cy: r.top + r.height / 2,
      });
    }
    items.sort((a, b) => a.cy - b.cy);
    const row = items
      .filter((i) => i.cy - items[0].cy < 8)
      .sort((a, b) => a.l - b.l);
    const gaps = row
      .slice(1)
      .map((i, k) => i.l - row[k].r)
      .filter((g) => g >= 0);
    gaps.sort((a, b) => a - b);
    const lists = [...paneEl.querySelectorAll('[data-slot=tabs-list]')].filter(
      visible,
    );
    const tabsBottom = lists.length
      ? lists[0].getBoundingClientRect().bottom
      : null;
    return {
      left: Math.round(t.left - p.left),
      right: Math.round(p.right - t.right),
      firstItemLeft: row.length ? Math.round(row[0].l - p.left) : null,
      topGap: tabsBottom === null ? null : Math.round(t.top - tabsBottom),
      firstItemTopGap:
        tabsBottom === null || !items.length
          ? null
          : Math.round(Math.min(...items.map((i) => i.t)) - tabsBottom),
      rowHeight: row.length
        ? Math.round(
            Math.max(...row.map((i) => i.b)) - Math.min(...row.map((i) => i.t)),
          )
        : null,
      gap: gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)]) : null,
      separator: getComputedStyle(tb).borderBottomWidth,
    };
  };

  // Field/button pairs: every visible text field or select that has a button
  // beside it in the same row (sibling, or sibling of an ancestor up to three
  // levels up, vertically overlapping). Reports each pair's heights; a pair is
  // `ok` when both are within 0.5px. Used to prove a button next to a field
  // has exactly the field's height.
  const measurePairs = ({ scope }) => {
    const root = (scope && document.querySelector(scope)) || document.body;
    const visible = (e) => {
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return (
        r.width > 0 &&
        r.height > 0 &&
        cs.visibility !== 'hidden' &&
        cs.display !== 'none'
      );
    };
    const fieldSel =
      'input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):not([type=color]):not([type=hidden]),[role=combobox],[data-slot=field-trigger]';
    const buttonSel =
      'button:not([role=combobox]):not([data-slot=field-trigger]):not([role=tab]):not([role=checkbox]):not([role=switch])';
    const label = (e) =>
      (
        e.getAttribute('aria-label') ||
        e.getAttribute('placeholder') ||
        e.textContent ||
        e.tagName
      )
        .trim()
        .slice(0, 30);
    const groupSel = '[data-toolbar-group],[role=toolbar]';
    const pairs = [];
    const seen = new Set();
    for (const f of root.querySelectorAll(fieldSel)) {
      if (!visible(f) || f.closest(groupSel)) continue;
      const outer = f.closest('[data-slot=search-input]') || f;
      const fr = outer.getBoundingClientRect();
      for (
        let a = outer, depth = 0;
        a.parentElement && depth < 3;
        a = a.parentElement, depth++
      ) {
        const found = [];
        for (const sib of a.parentElement.children) {
          if (sib === a) continue;
          const btns = sib.matches(groupSel)
            ? [sib]
            : sib.matches(buttonSel)
              ? [sib]
              : [...sib.querySelectorAll(buttonSel)].filter(
                  (b) =>
                    b.parentElement === sib ||
                    b.parentElement.parentElement === sib,
                );
          for (const b of btns) {
            if (!visible(b) || getComputedStyle(b).position === 'absolute')
              continue;
            const br = b.getBoundingClientRect();
            const overlap =
              Math.min(fr.bottom, br.bottom) - Math.max(fr.top, br.top);
            if (overlap < Math.min(fr.height, br.height) / 2) continue;
            found.push({ b, br });
          }
        }
        if (found.length) {
          for (const { b, br } of found) {
            const key =
              label(outer) + '|' + label(b) + '|' + Math.round(br.left);
            if (seen.has(key)) continue;
            seen.add(key);
            pairs.push({
              field: label(f),
              fieldH: +fr.height.toFixed(1),
              button: label(b),
              buttonH: +br.height.toFixed(1),
              ok: Math.abs(fr.height - br.height) <= 0.5,
              rect: {
                x: Math.round(Math.min(fr.left, br.left)),
                y: Math.round(Math.min(fr.top, br.top)),
                w: Math.round(
                  Math.max(fr.right, br.right) - Math.min(fr.left, br.left),
                ),
                h: Math.round(
                  Math.max(fr.bottom, br.bottom) - Math.min(fr.top, br.top),
                ),
              },
            });
          }
          break;
        }
      }
    }
    return {
      count: pairs.length,
      mismatched: pairs.filter((p) => !p.ok).length,
      pairs,
    };
  };

  result.origin = await page.evaluate(() => location.origin);

  for (const vp of CFG.viewports) {
    const vr = { w: vp.w, h: vp.h, views: {} };
    for (const view of CFG.views) {
      if (view.viewports && !view.viewports.includes(vp.name)) continue;
      const cell = { view: view.name };
      try {
        await page.setViewportSize({ width: vp.w, height: vp.h });
        await applyMocks(view.mocks);
        await applyWsMocks(view.wsMocks);
        await page.goto(result.origin + (view.route || '/'));
        await page.evaluate(install);
        if (view.ready)
          await page.waitForSelector(view.ready, { timeout: 15000 });
        await page.evaluate(install);
        await runSteps(view.steps);
        await settle(view);
        Object.assign(
          cell,
          await page.evaluate(measure, {
            scope: view.scope ?? null,
            densityScope: view.densityScope ?? null,
          }),
        );
        if (view.pairs)
          cell.pairs = await page.evaluate(measurePairs, view.pairs);
        if (view.rows) cell.rows = await page.evaluate(measureRows, view.rows);
        if (view.toolbar)
          cell.toolbar = await page.evaluate(measureToolbar, view.toolbar);
        if (CFG.shots) {
          cell.shot = `${CFG.label}-${view.name}-${vp.name}.png`;
          await page.screenshot({ path: `${CFG.outDir}/${cell.shot}` });
        }
        const isOverlay = await page.evaluate(
          (scopeSel) => window.__audit.scope(scopeSel) !== document.body,
          view.scope ?? null,
        );
        const mode =
          view.focusWalk === undefined
            ? isOverlay
              ? 'tab'
              : false
            : view.focusWalk;
        if (mode) cell.focus = await focusWalk(view, mode);
        if (view.keyboardOpen && vp.mobile) {
          // On-screen keyboard: shrink the viewport and check what stays visible.
          const kb = view.keyboardOpen;
          await page.setViewportSize({ width: vp.w, height: kb.height || 508 });
          await page.waitForTimeout(300);
          if (kb.focus) await page.locator(kb.focus).first().focus();
          cell.keyboardOpen = await page.evaluate(
            ([probe, scopeSel]) => {
              const out = { viewportH: innerHeight };
              const d = window.__audit.scope(scopeSel);
              const r = d.getBoundingClientRect();
              out.scope = {
                top: Math.round(r.top),
                bottom: Math.round(r.bottom),
              };
              for (const [name, sel] of Object.entries(probe)) {
                const n = document.querySelector(sel);
                if (!n) {
                  out[name] = null;
                  continue;
                }
                const b = n.getBoundingClientRect();
                out[name] = {
                  top: Math.round(b.top),
                  bottom: Math.round(b.bottom),
                  inViewport: b.top >= 0 && b.bottom <= innerHeight,
                  hidden: b.bottom <= 0 || b.top >= innerHeight,
                };
              }
              return out;
            },
            [kb.probe || {}, view.scope ?? null],
          );
          if (CFG.shots)
            await page.screenshot({
              path: `${CFG.outDir}/${CFG.label}-${view.name}-${vp.name}-keyboard.png`,
            });
          await page.setViewportSize({ width: vp.w, height: vp.h });
        }
        if (isOverlay && view.escape !== false) {
          await page.keyboard.press('Escape');
          await page.waitForTimeout(400);
          cell.escapeClosesScope = await page.evaluate((scopeSel) => {
            const n = scopeSel ? document.querySelector(scopeSel) : null;
            if (scopeSel)
              return (
                !n || !n.isConnected || n.getBoundingClientRect().width === 0
              );
            return !document.querySelector(
              '[role=dialog],[role=alertdialog],[role=menu]',
            );
          }, view.scope ?? null);
        }
      } catch (e) {
        cell.error = String(e).slice(0, 300);
      }
      for (let i = 0; i < 100 && pendingMocks > 0; i++)
        await page.waitForTimeout(100);
      vr.views[view.name] = cell;
    }
    result.viewports[vp.name] = vr;
  }
  await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
  return JSON.stringify(result);
};
