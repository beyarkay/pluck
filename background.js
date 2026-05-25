const MENU_PARENT_ID = "pluck-copy-xpath";
const MENU_NEW_ID    = "pluck-new-preset";
const MENU_SEP_ID    = "pluck-sep";
const PRESET_PREFIX  = "pluck-preset-";

async function loadPresets() {
  return new Promise(resolve => {
    browser.storage.local.get("presets", data => resolve(data.presets || []));
  });
}

async function savePresets(ps) {
  return new Promise(resolve => browser.storage.local.set({ presets: ps }, resolve));
}

async function rebuildMenu() {
  await browser.menus.removeAll();
  browser.menus.create({
    id:       MENU_PARENT_ID,
    title:    "Copy XPath to Pluck",
    contexts: ["all"]
  });
  browser.menus.create({
    id:       MENU_NEW_ID,
    parentId: MENU_PARENT_ID,
    title:    "New preset…",
    contexts: ["all"]
  });
  const presets = await loadPresets();
  if (presets.length) {
    browser.menus.create({
      id:       MENU_SEP_ID,
      parentId: MENU_PARENT_ID,
      type:     "separator",
      contexts: ["all"]
    });
    for (const p of presets) {
      browser.menus.create({
        id:       PRESET_PREFIX + p.id,
        parentId: MENU_PARENT_ID,
        title:    p.name || "(unnamed)",
        contexts: ["all"]
      });
    }
  }
}

function notify(title, message) {
  browser.notifications.create({
    type:    "basic",
    iconUrl: browser.runtime.getURL("icon.svg"),
    title,
    message
  });
}

function xpathExtractorCode(targetElementId) {
  return `
    (function() {
      const el = browser.menus.getTargetElement(${Number(targetElementId)});
      if (!el) return null;
      function xpathOf(node) {
        if (node.id && /^[A-Za-z0-9_\\-]+$/.test(node.id)) {
          return '//*[@id="' + node.id + '"]';
        }
        const parts = [];
        while (node && node.nodeType === 1) {
          let nb = 1, sib = node.previousElementSibling;
          while (sib) {
            if (sib.nodeName === node.nodeName) nb++;
            sib = sib.previousElementSibling;
          }
          parts.unshift(node.nodeName.toLowerCase() + '[' + nb + ']');
          node = node.parentNode;
        }
        return '/' + parts.join('/');
      }
      return xpathOf(el);
    })();
  `;
}

browser.menus.onClicked.addListener(async (info, tab) => {
  const id = info.menuItemId;
  if (typeof id !== "string" || !id.startsWith("pluck-")) return;
  if (id === MENU_PARENT_ID || id === MENU_SEP_ID) return;
  if (info.targetElementId == null) {
    notify("Pluck", "No element selected");
    return;
  }

  let xpath = null;
  try {
    const result = await browser.tabs.executeScript(tab.id, {
      code: xpathExtractorCode(info.targetElementId)
    });
    xpath = result && result[0];
  } catch (e) {
    notify("Pluck error", "Could not read element: " + e.message);
    return;
  }

  if (!xpath) {
    notify("Pluck", "Could not compute XPath for that element");
    return;
  }

  const presets = await loadPresets();
  let targetName;

  if (id === MENU_NEW_ID) {
    let host = "New preset";
    try { host = new URL(tab.url).hostname || host; } catch (e) {}
    const newPreset = {
      id:         "preset-" + Date.now(),
      name:       host,
      selectors:  [{ key: "value1", selector: xpath, type: "xpath", attr: "text", transforms: "" }],
      formatMode: "template",
      format:     "{value1}",
      separator:  "\\t"
    };
    presets.push(newPreset);
    targetName = newPreset.name;
  } else {
    const presetId = id.slice(PRESET_PREFIX.length);
    const preset   = presets.find(p => p.id === presetId);
    if (!preset) {
      notify("Pluck error", "Preset not found");
      return;
    }
    const n = preset.selectors.length + 1;
    preset.selectors.push({
      key:        "value" + n,
      selector:   xpath,
      type:       "xpath",
      attr:       "text",
      transforms: ""
    });
    targetName = preset.name;
  }

  await savePresets(presets);
  notify("Pluck", "Added XPath to " + targetName);
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.presets) rebuildMenu();
});

rebuildMenu();
