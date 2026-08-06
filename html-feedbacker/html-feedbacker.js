(function () {
  if (window.__maritFeedbackTool) {
    window.__maritFeedbackTool.toggle();
    return;
  }

  var STATE = { mode: null, items: [] };

  var style = document.createElement('style');
  style.id = 'mft-style';
  style.textContent =
    '.mft-highlight{outline:2px solid #00b3c3 !important;outline-offset:2px !important;cursor:pointer !important;}' +
    '.mft-editing{outline:2px dashed #ffb000 !important;background:rgba(255,176,0,0.08) !important;}';
  document.head.appendChild(style);

  function shortText(t, n) {
    n = n || 40;
    t = (t || '').trim().replace(/\s+/g, ' ');
    return t.length > n ? t.slice(0, n) + '…' : t;
  }

  function serializeEl(el) {
    var clone = el.cloneNode(true);
    clone.querySelectorAll('br').forEach(function (n) { n.replaceWith('\n'); });
    clone.querySelectorAll('div,p').forEach(function (n) { n.replaceWith('\n' + n.textContent + '\n'); });
    clone.querySelectorAll('strong,b').forEach(function (n) { n.replaceWith('**' + n.textContent + '**'); });
    clone.querySelectorAll('em,i').forEach(function (n) { n.replaceWith('*' + n.textContent + '*'); });
    // Alles was übrig bleibt (Icons, Spans, SVGs...) bekommt sicherheitshalber Leerzeichen drum herum,
    // damit CSS-basierte Abstände (z. B. flex gap) beim Zusammenkleben des Texts nicht verschwinden.
    clone.querySelectorAll('*').forEach(function (n) { n.replaceWith(' ' + n.textContent + ' '); });
    return clone.textContent.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();
  }

  function buildSelector(el) {
    if (el.id) return '#' + el.id;
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 4 && node !== document.body) {
      var part = node.tagName.toLowerCase();
      if (node.classList.length) {
        part += '.' + Array.prototype.slice.call(node.classList, 0, 2).join('.');
      } else if (node.parentElement) {
        var idx = Array.prototype.indexOf.call(node.parentElement.children, node) + 1;
        part += ':nth-child(' + idx + ')';
      }
      parts.unshift(part);
      node = node.parentElement;
      depth++;
    }
    return parts.join(' > ');
  }

  function describeLocation(el) {
    var tag = el.tagName.toLowerCase();
    var node = el.id ? el : el.parentElement;
    var depth = 0;
    while (node && node !== document.body && depth < 8) {
      if (node.id) return '<' + tag + '> in <#' + node.id + '>';
      if (node.classList.length) return '<' + tag + '> in <' + node.tagName.toLowerCase() + '.' + node.classList[0] + '>';
      node = node.parentElement;
      depth++;
    }
    return '<' + tag + '> in <' + buildSelector(el.parentElement || el) + '>';
  }

  function findSectionHeading(el) {
    var headings = document.body.querySelectorAll('h1,h2,h3,h4,h5,h6');
    var found = null;
    for (var i = 0; i < headings.length; i++) {
      var pos = el.compareDocumentPosition(headings[i]);
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) {
        found = headings[i];
      } else if (pos & Node.DOCUMENT_POSITION_FOLLOWING) {
        break;
      }
    }
    return found ? shortText(found.textContent, 70) : null;
  }

  function getComputedSubset(el) {
    var cs = window.getComputedStyle(el);
    return {
      color: cs.color,
      background: cs.backgroundColor,
      fontSize: cs.fontSize,
      padding: cs.padding,
      margin: cs.margin,
      width: el.offsetWidth + 'px',
      height: el.offsetHeight + 'px'
    };
  }

  function updateCounter() {
    var c = document.getElementById('mft-counter');
    if (c) c.textContent = String(STATE.items.length);
  }

  function showToast(msg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText =
      'position:fixed;bottom:90px;right:20px;background:#a4c931;color:#fff;padding:10px 18px;' +
      'border-radius:8px;z-index:2147483647;font-family:-apple-system,sans-serif;font-weight:600;' +
      'box-shadow:0 4px 14px rgba(0,0,0,0.2);';
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2200);
  }

  function copyToClipboard(text) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText =
        'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:80%;height:50%;' +
        'z-index:2147483647;font-family:monospace;font-size:0.85rem;padding:12px;border:2px solid #00b3c3;' +
        'border-radius:10px;background:#fff;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try { document.execCommand('copy'); } catch (e) {}
      var hint = document.createElement('div');
      hint.textContent = 'Text ist markiert – jetzt Cmd+C drücken, dann hier klicken zum Schließen';
      hint.style.cssText =
        'position:fixed;top:calc(25% - 34px);left:50%;transform:translateX(-50%);background:#00b3c3;' +
        'color:#fff;padding:8px 16px;border-radius:8px;z-index:2147483647;font-family:-apple-system,sans-serif;' +
        'font-size:0.85rem;cursor:pointer;';
      hint.onclick = function () { ta.remove(); hint.remove(); };
      document.body.appendChild(hint);
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () {
        showToast('In Zwischenablage kopiert ✓');
      }).catch(fallback);
    } else {
      fallback();
    }
  }

  function buildMarkdown() {
    var textItems = STATE.items.filter(function (i) { return i.type === 'text'; });
    var elItems = STATE.items.filter(function (i) { return i.type === 'element'; });
    var lines = [];

    lines.push('# HTML-Feedbacker – Änderungsprotokoll');
    lines.push('# Seite: ' + (document.title || location.href));
    lines.push('# URL: ' + location.href);
    lines.push('# Datum: ' + new Date().toLocaleString('de-DE'));
    lines.push('# Text-Änderungen: ' + textItems.length + '   Notizen: ' + elItems.length);
    lines.push('');

    if (!textItems.length && !elItems.length) {
      lines.push('_Keine Änderungen erfasst._');
      return lines.join('\n');
    }

    lines.push('Anweisung an KI:');
    lines.push('1) Text-Änderungen wörtlich übernehmen (ALT → NEU). Struktur, Klassen, Attribute unverändert lassen.');
    lines.push('2) Notizen sinngemäß umsetzen (z. B. "Bild kleiner", "Schrift größer"). CSS/Markup darfst du anpassen, aber minimal-invasiv.');
    lines.push('3) Bei Notizen: NUR das eine identifizierte Element ändern, keine Geschwister- oder gleichartigen Elemente. ' +
      'Wenn nötig, eine neue spezifische CSS-Klasse einführen statt einer breit wirkenden Regel.');
    lines.push('4) Falls der ALT-Text nicht exakt im Quellcode auftaucht (z. B. wegen Anführungszeichen/HTML-Entities): ' +
      'anhand von Tag, Container und Abschnitt zuordnen.');
    lines.push('');

    if (textItems.length) {
      lines.push('================ TEXT-ÄNDERUNGEN ================');
      lines.push('');
      textItems.forEach(function (it, i) {
        lines.push('## [' + (i + 1) + '] ' + it.location);
        if (it.section) lines.push('Abschnitt: "' + it.section + '"');
        lines.push('ALT: ' + it.alt.split('\n').join('\nALT: '));
        lines.push('NEU: ' + it.neu.split('\n').join('\nNEU: '));
        lines.push('');
      });
    }

    if (elItems.length) {
      lines.push('================ NOTIZEN ================');
      lines.push('');
      elItems.forEach(function (it, i) {
        lines.push('## [' + (i + 1) + '] ' + it.location + ' — "' + it.textSnippet + '"');
        if (it.section) lines.push('Abschnitt: "' + it.section + '"');
        lines.push('NOTIZ: ' + it.note);
        lines.push(
          'WERTE: Farbe: ' + it.style.color + '; Hintergrund: ' + it.style.background +
          '; Schriftgröße: ' + it.style.fontSize + '; Innenabstand: ' + it.style.padding +
          '; Außenabstand: ' + it.style.margin + '; Größe: ' + it.style.width + ' x ' + it.style.height
        );
        lines.push('');
      });
    }

    return lines.join('\n');
  }

  var BLOCK_SELECTOR = 'div,section,article,header,footer,nav,aside,ul,ol,li,table,thead,tbody,tr,td,th,form,p,h1,h2,h3,h4,h5,h6';

  function isTextEditable(el) {
    if (!el || el === document.body || !el.textContent.trim()) return false;
    return !el.querySelector(BLOCK_SELECTOR);
  }

  function onMouseOver(e) {
    if (!STATE.mode) return;
    var el = e.target;
    if (el.closest('#mft-toolbar,#mft-note-popup,#mft-list-panel')) return;
    if (STATE.mode === 'text' && !isTextEditable(el)) return;
    el.classList.add('mft-highlight');
  }
  function onMouseOut(e) {
    e.target.classList.remove('mft-highlight');
  }

  function onClickText(el) {
    var original = serializeEl(el);
    el._mftOriginal = original;
    el.contentEditable = 'true';
    el.classList.add('mft-editing');
    el.classList.remove('mft-highlight');
    el.focus();
    document.execCommand('selectAll', false, null);

    function finish() {
      el.removeEventListener('blur', finish);
      el.contentEditable = 'false';
      el.classList.remove('mft-editing');
      var neu = serializeEl(el);
      var alt = el._mftOriginal;
      if (neu !== alt) {
        STATE.items.push({
          type: 'text',
          location: describeLocation(el),
          section: findSectionHeading(el),
          alt: alt,
          neu: neu
        });
        updateCounter();
      }
      delete el._mftOriginal;
    }
    el.addEventListener('blur', finish, { once: true });
  }

  function openNotePopup(el, x, y) {
    var existing = document.getElementById('mft-note-popup');
    if (existing) existing.remove();

    var popup = document.createElement('div');
    popup.id = 'mft-note-popup';
    popup.style.cssText =
      'position:fixed;z-index:2147483647;background:#fff;border:2px solid #00b3c3;border-radius:12px;' +
      'padding:14px 16px;box-shadow:0 8px 28px rgba(0,0,0,0.2);width:280px;font-family:-apple-system,sans-serif;';
    var left = Math.min(x, window.innerWidth - 300);
    var top = Math.min(y, window.innerHeight - 220);
    popup.style.left = Math.max(8, left) + 'px';
    popup.style.top = Math.max(8, top) + 'px';

    var label = document.createElement('div');
    label.style.cssText = 'font-size:0.78rem;color:#666;margin-bottom:6px;';
    label.textContent = '<' + el.tagName.toLowerCase() + '> ' + shortText(el.textContent, 30);

    var textarea = document.createElement('textarea');
    textarea.placeholder = 'z. B. "Button etwas größer machen"';
    textarea.style.cssText =
      'width:100%;height:60px;border:1px solid #ddd;border-radius:8px;padding:8px;font-size:0.9rem;' +
      'font-family:inherit;resize:none;box-sizing:border-box;';

    var btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;margin-top:10px;';

    var saveBtn = document.createElement('button');
    saveBtn.textContent = 'Speichern';
    saveBtn.style.cssText =
      'flex:1;background:#00b3c3;color:#fff;border:none;border-radius:8px;padding:9px 0;font-weight:600;cursor:pointer;';

    var cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Abbrechen';
    cancelBtn.style.cssText =
      'flex:1;background:#eee;color:#333;border:none;border-radius:8px;padding:9px 0;font-weight:600;cursor:pointer;';

    saveBtn.onclick = function () {
      var note = textarea.value.trim();
      if (note) {
        STATE.items.push({
          type: 'element',
          location: describeLocation(el),
          section: findSectionHeading(el),
          textSnippet: shortText(el.textContent, 50),
          note: note,
          style: getComputedSubset(el)
        });
        updateCounter();
      }
      popup.remove();
    };
    cancelBtn.onclick = function () { popup.remove(); };

    popup.appendChild(label);
    popup.appendChild(textarea);
    btnRow.appendChild(saveBtn);
    btnRow.appendChild(cancelBtn);
    popup.appendChild(btnRow);
    document.body.appendChild(popup);
    textarea.focus();
  }

  function toggleListPanel() {
    var existing = document.getElementById('mft-list-panel');
    if (existing) { existing.remove(); return; }
    var panel = document.createElement('div');
    panel.id = 'mft-list-panel';
    panel.style.cssText =
      'position:fixed;bottom:80px;right:20px;width:320px;max-height:400px;overflow-y:auto;background:#fff;' +
      'border:2px solid #00b3c3;border-radius:12px;padding:14px;z-index:2147483647;font-family:-apple-system,sans-serif;' +
      'box-shadow:0 8px 28px rgba(0,0,0,0.2);';
    if (!STATE.items.length) {
      var empty = document.createElement('div');
      empty.style.cssText = 'color:#888;font-size:0.85rem;';
      empty.textContent = 'Noch keine Änderungen erfasst.';
      panel.appendChild(empty);
    } else {
      STATE.items.forEach(function (it, idx) {
        var row = document.createElement('div');
        row.style.cssText =
          'border-bottom:1px solid #eee;padding:8px 0;font-size:0.82rem;display:flex;justify-content:space-between;gap:8px;align-items:flex-start;';
        var txt = document.createElement('div');
        if (it.type === 'text') {
          txt.innerHTML = '<b style="color:#00b3c3;">Text</b> <code>' + it.location + '</code><br>"' +
            shortText(it.alt, 30) + '" → "' + shortText(it.neu, 30) + '"';
        } else {
          txt.innerHTML = '<b style="color:#ffb000;">Element</b> <code>' + it.location + '</code><br>' + it.note;
        }
        var del = document.createElement('button');
        del.textContent = '×';
        del.style.cssText = 'background:none;border:none;color:#c00;font-size:1rem;cursor:pointer;';
        del.onclick = function () {
          STATE.items.splice(idx, 1);
          updateCounter();
          panel.remove();
          toggleListPanel();
        };
        row.appendChild(txt);
        row.appendChild(del);
        panel.appendChild(row);
      });
    }
    document.body.appendChild(panel);
  }

  function setMode(newMode) {
    STATE.mode = STATE.mode === newMode ? null : newMode;
    var textBtn = document.getElementById('mft-btn-text');
    var elBtn = document.getElementById('mft-btn-element');
    if (textBtn) textBtn.style.background = STATE.mode === 'text' ? '#00b3c3' : '#333';
    if (elBtn) elBtn.style.background = STATE.mode === 'element' ? '#ffb000' : '#333';
  }

  function onDocClick(e) {
    if (!STATE.mode) return;
    if (e.target.closest('#mft-toolbar,#mft-note-popup,#mft-list-panel')) return;
    var el = e.target;
    if (STATE.mode === 'text') {
      if (el.isContentEditable) return;
      if (!isTextEditable(el)) {
        showToast('Bitte direkt auf einen Text klicken (keine Box) – für Design-Wünsche den Element-Modus nutzen');
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      onClickText(el);
    } else if (STATE.mode === 'element') {
      e.preventDefault();
      e.stopPropagation();
      openNotePopup(el, e.clientX, e.clientY);
    }
  }

  function teardown() {
    document.removeEventListener('mouseover', onMouseOver, true);
    document.removeEventListener('mouseout', onMouseOut, true);
    document.removeEventListener('click', onDocClick, true);
    var tb = document.getElementById('mft-toolbar'); if (tb) tb.remove();
    var panel = document.getElementById('mft-list-panel'); if (panel) panel.remove();
    var popup = document.getElementById('mft-note-popup'); if (popup) popup.remove();
    var st = document.getElementById('mft-style'); if (st) st.remove();
    delete window.__maritFeedbackTool;
  }

  function buildToolbar() {
    var tb = document.createElement('div');
    tb.id = 'mft-toolbar';
    tb.style.cssText =
      'position:fixed;bottom:20px;right:20px;z-index:2147483647;display:flex;align-items:center;gap:6px;' +
      'background:#1a1a1a;padding:8px 10px;border-radius:14px;box-shadow:0 6px 20px rgba(0,0,0,0.3);' +
      'font-family:-apple-system,sans-serif;';

    function makeBtn(id, label, title, bg) {
      var b = document.createElement('button');
      if (id) b.id = id;
      b.textContent = label;
      b.title = title;
      b.style.cssText =
        'background:' + (bg || '#333') + ';color:#fff;border:none;border-radius:9px;padding:8px 10px;' +
        'font-size:0.95rem;cursor:pointer;font-family:inherit;';
      return b;
    }

    var textBtn = makeBtn('mft-btn-text', '✏️', 'Text bearbeiten');
    var elBtn = makeBtn('mft-btn-element', '🖱️', 'Element markieren');
    var listBtn = makeBtn(null, '📋', 'Liste anzeigen');
    var counter = document.createElement('span');
    counter.id = 'mft-counter';
    counter.style.cssText =
      'background:#a4c931;color:#fff;font-size:0.75rem;font-weight:700;border-radius:10px;padding:2px 7px;min-width:14px;text-align:center;';
    counter.textContent = '0';
    var copyBtn = makeBtn(null, 'Kopieren', 'Feedback als Markdown kopieren', '#00b3c3');
    copyBtn.style.fontWeight = '700';
    copyBtn.style.padding = '8px 14px';
    var closeBtn = makeBtn(null, '✕', 'Werkzeug schließen', 'transparent');
    closeBtn.style.color = '#999';

    textBtn.onclick = function () { setMode('text'); };
    elBtn.onclick = function () { setMode('element'); };
    listBtn.onclick = toggleListPanel;
    copyBtn.onclick = function () { copyToClipboard(buildMarkdown()); };
    closeBtn.onclick = teardown;

    tb.appendChild(textBtn);
    tb.appendChild(elBtn);
    tb.appendChild(listBtn);
    tb.appendChild(counter);
    tb.appendChild(copyBtn);
    tb.appendChild(closeBtn);
    document.body.appendChild(tb);
  }

  document.addEventListener('mouseover', onMouseOver, true);
  document.addEventListener('mouseout', onMouseOut, true);
  document.addEventListener('click', onDocClick, true);
  buildToolbar();

  window.__maritFeedbackTool = {
    toggle: function () {
      var tb = document.getElementById('mft-toolbar');
      if (!tb) return;
      var hidden = tb.style.display === 'none';
      tb.style.display = hidden ? 'flex' : 'none';
      if (!hidden) { STATE.mode = null; }
    }
  };
})();
