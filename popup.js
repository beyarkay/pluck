const DEFAULT_PRESETS = [
  {
    id: "example-page",
    name: "Page",
    selectors: [
      { key: "title", selector: "title", type: "page", attr: "text", transforms: "" },
      { key: "url",   selector: "url",   type: "page", attr: "text", transforms: "" }
    ],
    formatMode: "template",
    format: "{title} — {url}",
    separator: "\\t"
  }
];

let presets         = [];
let editingId       = null;
let editingSelectors = [];
let editingFormatMode = "template";
let editingFormat     = "";
let editingSeparator  = "";
let previewTimer    = null;
let originalSnapshot = null;

// ── Storage ──────────────────────────────────────────────────────────────────

async function loadPresets() {
  return new Promise(resolve => {
    browser.storage.local.get("presets", data => resolve(data.presets || DEFAULT_PRESETS));
  });
}
async function savePresets(ps) {
  return new Promise(resolve => browser.storage.local.set({ presets: ps }, resolve));
}

// ── Extraction ───────────────────────────────────────────────────────────────

function buildExtractionCode(selectors) {
  return `
  (function() {
    const selectors = ${JSON.stringify(selectors)};

    function applyTransforms(value, ts) {
      if (!ts || !ts.trim()) return value;
      for (const t of ts.split('|').map(s => s.trim()).filter(Boolean)) {
        try {
          if      (t === 'trim')            { value = value.trim(); }
          else if (t === 'uppercase')       { value = value.toUpperCase(); }
          else if (t === 'lowercase')       { value = value.toLowerCase(); }
          else if (t === 'numbers_only')    { value = value.replace(/[^0-9.\\-]/g, ''); }
          else if (t === 'letters_only')    { value = value.replace(/[^a-zA-Z]/g, ''); }
          else if (t.startsWith('slice:'))  {
            const [, a, b] = t.split(':');
            value = value.slice(a !== '' ? +a : 0, b !== undefined && b !== '' ? +b : undefined);
          }
          else if (t.startsWith('replace:')) {
            const rest = t.slice(8), sep = rest.indexOf(':');
            value = value.split(rest.slice(0, sep)).join(rest.slice(sep + 1));
          }
          else if (t.startsWith('regex_remove:'))  { value = value.replace(new RegExp(t.slice(13), 'g'), ''); }
          else if (t.startsWith('regex_extract:')) {
            const m = value.match(new RegExp(t.slice(14)));
            value = m ? (m[1] !== undefined ? m[1] : m[0]) : '';
          }
          else if (t.startsWith('prepend:')) { value = t.slice(8) + value; }
          else if (t.startsWith('append:'))  { value = value + t.slice(7); }
          else if (t.startsWith('split:'))   {
            const [, sep, idx] = t.split(':');
            value = (value.split(sep)[+(idx || 0)]) || '';
          }
        } catch(e) {}
      }
      return value;
    }

    const result = {};
    for (const sel of selectors) {
      try {
        let value = '';
        if (sel.type === 'css') {
          const el = document.querySelector(sel.selector);
          if (el) {
            if      (sel.attr === 'text') value = el.textContent.trim();
            else if (sel.attr === 'html') value = el.innerHTML.trim();
            else                          value = el.getAttribute(sel.attr) || '';
          }
        } else if (sel.type === 'xpath') {
          const xr = document.evaluate(sel.selector, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          const el = xr.singleNodeValue;
          if (el) {
            if      (sel.attr === 'text')                 value = el.textContent.trim();
            else if (el.nodeType === Node.ATTRIBUTE_NODE) value = el.value;
            else                                          value = el.getAttribute(sel.attr) || '';
          }
        } else if (sel.type === 'meta') {
          const el = document.querySelector('meta[property="'+sel.selector+'"], meta[name="'+sel.selector+'"]');
          if (el) value = el.getAttribute('content') || '';
        } else if (sel.type === 'page') {
          const key = (sel.selector || '').trim();
          if      (key === 'url' || key === 'href') value = location.href;
          else if (key === 'host')                  value = location.host;
          else if (key === 'path')                  value = location.pathname;
          else if (key === 'origin')                value = location.origin;
          else if (key === 'protocol')              value = location.protocol;
          else if (key === 'title')                 value = document.title;
        }
        result[sel.key] = applyTransforms(value, sel.transforms || '');
      } catch(e) {
        result[sel.key] = '[err: ' + e.message + ']';
      }
    }
    return result;
  })()`;
}

function applyFormat(preset, data) {
  const unesc = s => (s || '').replace(/\\t/g, '\t').replace(/\\n/g, '\n');
  if (preset.formatMode === 'separator') {
    return Object.values(data).join(unesc(preset.separator));
  }
  let out = unesc(preset.format);
  for (const [k, v] of Object.entries(data)) out = out.split(`{${k}}`).join(v);
  return out;
}

function formatPreviewString(preset) {
  if (preset.formatMode === 'separator') {
    return preset.selectors.map(s => `{${s.key}}`).join(preset.separator || '');
  }
  return preset.format || '';
}

async function extractPreset(preset) {
  const tabs    = await browser.tabs.query({ active: true, currentWindow: true });
  const results = await browser.tabs.executeScript(tabs[0].id, { code: buildExtractionCode(preset.selectors) });
  return results[0];
}

// ── Copy ─────────────────────────────────────────────────────────────────────

async function copyPreset(preset, btn) {
  const orig = btn.textContent;
  try {
    const data = await extractPreset(preset);
    await navigator.clipboard.writeText(applyFormat(preset, data));
    window.close();
  } catch(err) {
    btn.textContent = "✗ Error"; btn.classList.add("error");
    console.error(err);
    setTimeout(() => { btn.textContent = orig; btn.classList.remove("error"); }, 2000);
  }
}

// ── Main view ────────────────────────────────────────────────────────────────

function renderMain() {
  document.getElementById("main-view").style.display = "block";
  document.getElementById("edit-view").style.display = "none";

  const container = document.getElementById("presets-container");
  container.innerHTML = presets.length === 0
    ? '<p style="color:#555;font-size:12px;margin-bottom:10px;">No presets yet.</p>'
    : "";

  for (const preset of presets) {
    const div = document.createElement("div");
    div.className = "preset";
    div.innerHTML = `
      <div class="preset-header">
        <span class="preset-name">${esc(preset.name)}</span>
        <button class="btn btn-copy" data-id="${preset.id}">Copy</button>
      </div>
      <div class="preset-format">${esc(formatPreviewString(preset))}</div>
      <div class="preset-preview">⏳ reading page…</div>
      <div class="actions">
        <button class="btn btn-sm edit-btn"    data-id="${preset.id}">Edit</button>
        <button class="btn btn-sm btn-danger delete-btn" data-id="${preset.id}">Delete</button>
      </div>`;
    container.appendChild(div);

    const previewEl = div.querySelector(".preset-preview");
    extractPreset(preset).then(data => {
      const formatted = applyFormat(preset, data);
      previewEl.textContent = formatted || "(no values found on this page)";
      previewEl.classList.toggle("preview-warn", Object.values(data).some(v => !v));
    }).catch(() => {
      previewEl.textContent = "⚠ Could not read page";
      previewEl.classList.add("preview-warn");
    });
  }

  container.querySelectorAll(".btn-copy").forEach(btn =>
    btn.addEventListener("click", () => copyPreset(presets.find(p => p.id === btn.dataset.id), btn)));
  container.querySelectorAll(".edit-btn").forEach(btn =>
    btn.addEventListener("click", () => openEdit(presets.find(p => p.id === btn.dataset.id))));
  container.querySelectorAll(".delete-btn").forEach(btn =>
    btn.addEventListener("click", async () => {
      const preset = presets.find(p => p.id === btn.dataset.id);
      if (confirm(`Delete "${preset?.name}"?`)) {
        presets = presets.filter(p => p.id !== btn.dataset.id);
        await savePresets(presets);
        renderMain();
      }
    }));
}

// ── Edit view ────────────────────────────────────────────────────────────────

function openEdit(preset) {
  editingId        = preset?.id || null;
  editingSelectors = preset ? JSON.parse(JSON.stringify(preset.selectors))
                            : [{ key: "value1", selector: "", type: "xpath", attr: "text", transforms: "" }];
  editingFormatMode = preset?.formatMode === "separator" ? "separator" : "template";
  editingFormat     = preset?.format    || "";
  editingSeparator  = preset?.separator || "";
  originalSnapshot  = JSON.stringify({
    name: preset?.name || "",
    formatMode: editingFormatMode,
    format: editingFormat,
    separator: editingSeparator,
    selectors: editingSelectors
  });

  document.getElementById("main-view").style.display = "none";
  document.getElementById("edit-view").style.display = "block";
  document.getElementById("edit-title").textContent  = preset ? "Edit Preset" : "New Preset";
  document.getElementById("edit-name").value         = preset?.name || "";

  setFormatMode(editingFormatMode);
  renderSelectorRows();
  schedulePreview();
}

function setFormatMode(mode) {
  editingFormatMode = mode === "separator" ? "separator" : "template";
  const input  = document.getElementById("edit-format");
  const hint   = document.getElementById("format-hint");
  const btnTpl = document.getElementById("mode-btn-template");
  const btnSep = document.getElementById("mode-btn-separator");
  if (editingFormatMode === "separator") {
    input.value       = editingSeparator;
    input.placeholder = "\\t  (or , or any string)";
    hint.textContent  = "Joins selector values in their listed order. Use \\t for tab, \\n for newline.";
    btnTpl.classList.remove("active"); btnSep.classList.add("active");
  } else {
    input.value       = editingFormat;
    input.placeholder = "{title} — {url}";
    hint.textContent  = "Use {key} for each selector. \\t and \\n become tab/newline.";
    btnTpl.classList.add("active"); btnSep.classList.remove("active");
  }
  schedulePreview();
}

// ── Live preview (edit view) ──────────────────────────────────────────────────

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(runEditPreview, 450);
}

async function runEditPreview() {
  const el = document.getElementById("edit-preview");
  if (!el) return;

  const previewPreset = {
    selectors:  editingSelectors,
    formatMode: editingFormatMode,
    format:     editingFormat,
    separator:  editingSeparator
  };

  const hasSelectors  = editingSelectors.some(s => s.selector.trim());
  const needsTemplate = editingFormatMode === "template" && !editingFormat.trim();
  if (!hasSelectors || needsTemplate) {
    el.textContent = "configure selectors and format above…";
    el.className   = "preview-empty";
    return;
  }

  el.textContent = "⏳ reading page…";
  el.className   = "";

  try {
    const data      = await extractPreset(previewPreset);
    const formatted = applyFormat(previewPreset, data);
    const anyEmpty  = Object.values(data).some(v => !v);
    el.textContent  = formatted || "(no values found on this page)";
    el.className    = anyEmpty ? "preview-warn" : "";
  } catch(e) {
    el.textContent = "⚠ Could not read page";
    el.className   = "preview-warn";
  }
}

// ── Selector rows ─────────────────────────────────────────────────────────────

function renderSelectorRows() {
  const list = document.getElementById("selectors-list");
  list.innerHTML = "";

  editingSelectors.forEach((sel, i) => {
    const wrap = document.createElement("div");
    wrap.className = "sel-wrap";

    // Main row
    const row = document.createElement("div");
    row.className = "selector-row";

    const mk = (tag, props) => Object.assign(document.createElement(tag), props);

    const keyInput = mk("input", { type: "text", placeholder: "key", value: sel.key });
    keyInput.addEventListener("input", e => { editingSelectors[i].key = e.target.value; schedulePreview(); });

    const selInput = mk("input", { type: "text", placeholder: "selector" , value: sel.selector });
    selInput.style.fontFamily = "monospace";
    selInput.addEventListener("input", e => { editingSelectors[i].selector = e.target.value; schedulePreview(); });

    const typeSelect = document.createElement("select");
    typeSelect.innerHTML = ["css","xpath","meta","page"].map(t =>
      `<option value="${t}" ${sel.type===t?"selected":""}>${t}</option>`).join("");
    typeSelect.addEventListener("change", e => { editingSelectors[i].type = e.target.value; schedulePreview(); });

    const attrSelect = document.createElement("select");
    attrSelect.innerHTML = ["text","href","src","html","value","content"].map(a =>
      `<option value="${a}" ${sel.attr===a?"selected":""}>${a}</option>`).join("");
    attrSelect.addEventListener("change", e => { editingSelectors[i].attr = e.target.value; schedulePreview(); });

    const removeBtn = mk("button", { className: "remove-sel", textContent: "×" });
    removeBtn.addEventListener("click", () => { editingSelectors.splice(i, 1); renderSelectorRows(); schedulePreview(); });

    [keyInput, selInput, typeSelect, attrSelect, removeBtn].forEach(el => row.appendChild(el));

    // Transforms row
    const txRow   = document.createElement("div");
    txRow.className = "transform-row";

    const txLabel = mk("span", { className: "tx-label", textContent: "transforms:" });

    const txInput = mk("input", { type: "text", className: "tx-input",
      placeholder: "e.g.  numbers_only | slice:0:10 | trim", value: sel.transforms || "" });
    txInput.addEventListener("input", e => { editingSelectors[i].transforms = e.target.value; schedulePreview(); });

    const txHelp  = mk("span", { className: "tx-help", textContent: "?" });
    txHelp.title  = [
      "Pipe-separated — applied left to right\n",
      "trim                strip whitespace",
      "numbers_only        keep only 0-9 . -  (no commas)",
      "letters_only        keep only a-z A-Z",
      "uppercase / lowercase",
      "slice:start:end     e.g. slice:0:10",
      "replace:from:to     e.g. replace:£:GBP",
      "regex_remove:pat    e.g. regex_remove:\\s+",
      "regex_extract:pat   e.g. regex_extract:(\\d+\\.?\\d*)",
      "prepend:text        e.g. prepend:£",
      "append:text         e.g. append:/month",
      "split:sep:idx       e.g. split: :0",
    ].join("\n");

    [txLabel, txInput, txHelp].forEach(el => txRow.appendChild(el));
    wrap.appendChild(row);
    wrap.appendChild(txRow);
    list.appendChild(wrap);
  });
}

// ── Save / discard ───────────────────────────────────────────────────────────

async function commitEdit() {
  const name = document.getElementById("edit-name").value.trim();
  if (!name) { alert("Name required"); return false; }
  if (editingFormatMode === "template" && !editingFormat.trim()) {
    alert("Format template required"); return false;
  }
  if (editingSelectors.some(s => !s.key || !s.selector)) {
    alert("All selectors need a key and selector value"); return false;
  }
  const data = {
    name,
    selectors:  editingSelectors,
    formatMode: editingFormatMode,
    format:     editingFormat,
    separator:  editingSeparator
  };
  if (editingId) {
    const idx = presets.findIndex(p => p.id === editingId);
    presets[idx] = { id: editingId, ...data };
  } else {
    presets.push({ id: "preset-" + Date.now(), ...data });
  }
  await savePresets(presets);
  return true;
}

document.getElementById("done-btn").addEventListener("click", async () => {
  if (await commitEdit()) renderMain();
});

document.getElementById("discard-btn").addEventListener("click", () => {
  if (confirm("Discard changes?")) renderMain();
});

document.getElementById("add-selector-btn").addEventListener("click", () => {
  editingSelectors.push({ key: `val${editingSelectors.length + 1}`, selector: "", type: "xpath", attr: "text", transforms: "" });
  renderSelectorRows();
});

document.getElementById("edit-format").addEventListener("input", e => {
  if (editingFormatMode === "separator") editingSeparator = e.target.value;
  else                                    editingFormat    = e.target.value;
  schedulePreview();
});

document.getElementById("mode-btn-template").addEventListener("click",  () => setFormatMode("template"));
document.getElementById("mode-btn-separator").addEventListener("click", () => setFormatMode("separator"));

document.getElementById("add-btn").addEventListener("click", () => openEdit(null));

// ── Utils ────────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ── Init ─────────────────────────────────────────────────────────────────────

(async () => { presets = await loadPresets(); renderMain(); })();
