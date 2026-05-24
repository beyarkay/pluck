# Pluck — orientation for Claude

A Firefox extension. The user runs it on their own machine; it is not published.

## Scope discipline

This is a small, personal tool. Resist scope creep — no build pipeline, no test harness, no TypeScript port, no React rewrite, no Chrome compatibility shim. If a change feels like infrastructure, ask first.

## Layout

Three files plus an icon:

- `manifest.json` — Manifest v2. Browser action with popup. Permissions: `activeTab`, `clipboardWrite`, `storage`.
- `popup.html` — Markup + inline CSS. Two views toggled by `display` — `#main-view` (list of presets) and `#edit-view` (edit form).
- `popup.js` — All behavior. No modules, no bundler.
- `icon.svg` — Toolbar and manifest icon.

There is no background script.

## How extraction works

`buildExtractionCode(selectors)` in `popup.js` returns a **string** containing a self-invoking function. That string is injected into the active tab via `browser.tabs.executeScript(tabId, { code })`. The injected function runs in the page's context, walks the selectors, applies transforms, and returns a `{ key: value }` object. The popup then runs `applyFormat(template, data)` to produce the final clipboard text.

Implication: the extraction function is a closed-over snippet built from `JSON.stringify(selectors)` — it has no access to the popup's other code. If you add a feature that the extractor needs, it must be self-contained inside `buildExtractionCode`'s template literal.

## Selector types

`css`, `xpath`, `meta`, `page`. The first three read from the DOM; `page` reads from `window.location` / `document.title` and uses the `selector` field as a key (`url`, `title`, `host`, `path`, `origin`, `protocol`).

When adding a new type, you must update **three places**:

1. The `if/else` chain inside `buildExtractionCode`.
2. The `typeSelect.innerHTML` options list inside `renderSelectorRows`.
3. The README transform/selector table.

## Transforms

Defined inside `applyTransforms` (which lives inside `buildExtractionCode`'s template literal). Pipe-separated, applied left-to-right. Known limitations to keep in mind:

- `replace:from:to` splits on the first `:` only — `from` cannot contain `:`.
- `regex_remove` always uses the `g` flag; `regex_extract` uses none. There is no syntax for passing flags.
- All transforms fail silently (caught by a `try/catch` that swallows errors).

## Format modes

A preset's `formatMode` is either `"template"` (use `{key}` placeholders in `preset.format`) or `"separator"` (join `Object.values(data)` with `preset.separator`). Both stored fields are kept on the preset regardless of which mode is active, so toggling modes in the edit view does not lose the other mode's value. `applyFormat(preset, data)` and `formatPreviewString(preset)` are the two dispatch points. Adding a third format mode means: new branch in both functions, new mode button in `popup.html`, new tab handler at the bottom of `popup.js`, and an extension to `setFormatMode`.

Old presets in storage that predate this split (no `formatMode` field) fall through to template mode — this is the only backward-compat code path.

## Storage

`browser.storage.local` under key `"presets"`. The default preset (page title + URL) is seeded only when storage is empty — editing or deleting it does not bring it back. There is no migration logic; if a future change breaks the preset schema, expect old presets to misbehave.

## Future migration to Manifest v3

Not done yet. When the time comes, the touchpoints are:

- `manifest_version: 3`, rename `browser_action` → `action`.
- `browser.tabs.executeScript({ code })` → `browser.scripting.executeScript({ target, func, args })`. **Important:** MV3 dropped the `code` form — you must pass a function reference plus args, not a string. The current single-string-blob approach will need restructuring.
- Add `host_permissions` if `activeTab` becomes insufficient.

## Dev loop

There is no build. Edit files, then in Firefox: `about:debugging` → This Firefox → find Pluck → **Reload**. If you change `manifest.json` you may need to remove and re-add the extension. Logs from the popup show in the popup's own DevTools (right-click the popup → Inspect).

## Conventions

- No comments unless the *why* is non-obvious. The popup is short enough to read end-to-end.
- Firefox-only — use `browser.` namespace, no `chrome.` fallback, no polyfill.
- Keep the popup CSS inline in `popup.html`. Splitting it into a separate file is not worth the cognitive cost for a project this size.
