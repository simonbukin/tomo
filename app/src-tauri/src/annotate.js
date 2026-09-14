(function () {
  if (window.__tomoAnnotate) return;
  var internals = window.__TAURI_INTERNALS__;
  var label = internals && internals.metadata && internals.metadata.currentWebview ? internals.metadata.currentWebview.label : "";
  var paneId = label.replace(/^browser-/, "");
  var MARK = "data-tomo-annotate";
  var notes = [];
  var enabled = false;
  var hovered = null;
  var target = null;
  var highlight, badge, editor, textarea;

  function el(tag, style) {
    var node = document.createElement(tag);
    node.setAttribute(MARK, "");
    node.style.cssText = "all:initial;box-sizing:border-box;position:fixed;z-index:2147483647;font:12px/1.4 -apple-system,Helvetica,sans-serif;" + style;
    return node;
  }

  function build() {
    if (highlight) return;
    highlight = el("div", "display:none;pointer-events:none;outline:2px solid #7c5cff;outline-offset:-2px;background:rgba(124,92,255,0.12);");
    badge = el("div", "display:none;right:12px;bottom:12px;padding:4px 10px;border-radius:12px;background:#7c5cff;color:#fff;pointer-events:none;");
    editor = el("div", "display:none;width:280px;padding:8px;border-radius:6px;background:#1b1b22;color:#e2e2e8;box-shadow:0 8px 24px rgba(0,0,0,0.4);");
    textarea = el("textarea", "position:static;display:block;width:100%;height:64px;padding:6px;border:1px solid #444;border-radius:4px;background:#0f0f12;color:#e2e2e8;font:inherit;resize:none;");
    var hint = el("div", "position:static;display:block;margin-top:6px;color:#9a9aa8;");
    hint.textContent = "Enter saves · Esc cancels";
    editor.appendChild(textarea);
    editor.appendChild(hint);
    var root = document.documentElement;
    root.appendChild(highlight);
    root.appendChild(badge);
    root.appendChild(editor);
  }

  function inOverlay(node) {
    return !!(node && node.closest && node.closest("[" + MARK + "]"));
  }

  function escapeId(id) {
    return window.CSS && CSS.escape ? CSS.escape(id) : id.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function selector(node) {
    var parts = [];
    for (var depth = 0; node && node.nodeType === 1 && node !== document.body && depth < 6; depth++) {
      if (node.id) {
        parts.unshift("#" + escapeId(node.id));
        break;
      }
      var parent = node.parentElement;
      var tag = node.tagName.toLowerCase();
      var same = parent ? Array.prototype.filter.call(parent.children, function (c) { return c.tagName === node.tagName; }) : [];
      parts.unshift(same.length > 1 ? tag + ":nth-of-type(" + (same.indexOf(node) + 1) + ")" : tag);
      var candidate = parts.join(" > ");
      if (document.querySelectorAll(candidate).length === 1) return candidate;
      node = parent;
    }
    return parts.join(" > ");
  }

  function rectOf(node) {
    var r = node.getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  }

  function moveHighlight(node) {
    if (!node) {
      highlight.style.display = "none";
      return;
    }
    var r = node.getBoundingClientRect();
    highlight.style.display = "block";
    highlight.style.left = r.left + "px";
    highlight.style.top = r.top + "px";
    highlight.style.width = r.width + "px";
    highlight.style.height = r.height + "px";
  }

  function send() {
    if (!internals || !internals.invoke) return;
    internals.invoke("browser_annotations", { pane_id: paneId, annotations: notes.slice() }).catch(function () {});
  }

  function render() {
    badge.textContent = notes.length + (notes.length === 1 ? " note" : " notes");
    badge.style.display = enabled || notes.length ? "block" : "none";
  }

  function openEditor(node) {
    var r = node.getBoundingClientRect();
    var left = Math.min(Math.max(8, r.left), window.innerWidth - 288);
    var top = r.bottom + 6 + 110 > window.innerHeight ? Math.max(8, r.top - 110) : r.bottom + 6;
    editor.style.left = left + "px";
    editor.style.top = top + "px";
    editor.style.display = "block";
    textarea.value = "";
    window.focus();
    textarea.focus();
  }

  function cancel() {
    target = null;
    editor.style.display = "none";
    moveHighlight(enabled ? hovered : null);
  }

  function save() {
    var text = textarea.value.trim();
    if (text && target) {
      var element = (target.innerText || target.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120);
      notes.push({ text: text, url: location.href, selector: selector(target), element_text: element || null, rect: rectOf(target) });
    }
    cancel();
    render();
    send();
  }

  function onMove(e) {
    if (!enabled || target) return;
    var node = document.elementFromPoint(e.clientX, e.clientY);
    if (inOverlay(node)) return;
    hovered = node;
    moveHighlight(node);
  }

  function onPointer(e) {
    if (!enabled || inOverlay(e.target)) return;
    e.stopPropagation();
    if (e.type !== "click") return;
    e.preventDefault();
    if (target) {
      cancel();
      return;
    }
    var node = document.elementFromPoint(e.clientX, e.clientY);
    if (!node || node === document.documentElement) return;
    target = node;
    moveHighlight(node);
    openEditor(node);
  }

  function onKey(e) {
    if (!enabled || !target) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
    e.stopPropagation();
  }

  function set(on) {
    build();
    enabled = !!on;
    if (!enabled) cancel();
    moveHighlight(null);
    document.documentElement.style.cursor = enabled ? "crosshair" : "";
    render();
  }

  function clear() {
    build();
    notes = [];
    cancel();
    render();
    send();
  }

  document.addEventListener("mousemove", onMove, true);
  ["pointerdown", "pointerup", "mousedown", "mouseup", "click"].forEach(function (type) {
    document.addEventListener(type, onPointer, true);
  });
  document.addEventListener("keydown", onKey, true);

  window.__tomoAnnotate = { set: set, clear: clear, notes: function () { return notes.slice(); } };
})();
