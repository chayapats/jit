// Chat attachments (app.attachments/v1, ADR 0040, ATT03). Hand-written ES module, no dependencies, no build step.
// It loads only on a topic page while JIT_ATTACHMENTS is on. The composer is complete without it: a multipart form
// that posts the text and the chosen files to `?send=1`. With it, each picked, pasted or dropped file uploads at once,
// one request per file (`application/octet-stream`, `X-CSRF-Token`, percent-encoded `X-Jit-File-Name`) with its own
// progress chip, and Send posts `message.send` as JSON with the staged `attachmentIds` and the form's own request id.
// Count and size checks here are UX only; the server decides every limit and type. Names and messages enter the page
// only through textContent. It never previews a file's bytes: a thumbnail is the server's re-encoded preview, and a
// pasted image is read only for its first 12 bytes, which name its extension.

const form = document.querySelector("form[data-attach-form]");
const input = form?.querySelector('input[type="file"][name="file"]');
const chips = form?.querySelector("[data-attach-chips]");
const words = document.querySelector("[data-attach-text]");
const icons = document.querySelector("[data-attach-icons]");
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const topicPath = value => typeof value === "string" && /^\/projects\/[a-f0-9-]{36}\/topics\/[a-f0-9-]{36}$/.test(value);

if (form && input && chips && typeof XMLHttpRequest === "function" && topicPath(form.dataset.topic) &&
  form.dataset.upload === `/api${form.dataset.topic}/attachments` && form.dataset.send === `/api${form.dataset.topic}/messages`) {
  const topic = form.dataset.topic, upload = form.dataset.upload, send = form.dataset.send;
  const maxFiles = Number(form.dataset.maxFiles) || 1, fileBytes = Number(form.dataset.fileBytes) || 0, pageSize = Number(form.dataset.pageSize) || 50;
  const notice = form.querySelector("[data-attach-notice]"), status = form.querySelector("[data-attach-status]");
  const textarea = form.querySelector("textarea");
  const field = name => form.querySelector(`input[type="hidden"][name="${name}"]`)?.value ?? "";
  const text = (key, values = {}) => (words?.querySelector(`[data-key="${key}"]`)?.textContent ?? "")
    .replace(/\{([a-z]+)\}/g, (token, name) => Object.hasOwn(values, name) ? String(values[name]) : token);
  const icon = name => icons?.querySelector(`[data-icon="${name}"] svg`)?.cloneNode(true) ?? null;
  const size = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${bytes < 10240 ? (bytes / 1024).toFixed(1) : Math.round(bytes / 1024)} KB`
    : `${bytes < 10485760 ? (bytes / 1048576).toFixed(1).replace(/\.0$/, "") : Math.round(bytes / 1048576)} MB`;
  const kindOf = name => /\.(?:png|jpe?g|webp)$/i.test(name) ? "image" : /\.pdf$/i.test(name) ? "pdf" : "file";
  // A display name is cut to 128 UTF-8 bytes, keeping a short extension, so its encoded header stays within bounds.
  const bounded = name => {
    const encoder = new TextEncoder(), dot = name.lastIndexOf(".");
    const suffix = dot > 0 && encoder.encode(name.slice(dot)).length < 32 ? name.slice(dot) : "";
    let stem = "", used = encoder.encode(suffix).length;
    for (const char of suffix ? name.slice(0, -suffix.length) : name) {
      const n = encoder.encode(char).length; if (used + n > 128) break; stem += char; used += n;
    }
    return stem + suffix;
  };
  const errorText = (code, detail) => {
    if (code === "attachment_type_unsupported" && typeof detail?.reason === "string" && /^[a-z_]{1,80}$/.test(detail.reason)) {
      const reason = text(`reason.${detail.reason}`); if (reason) return reason;
    }
    if (code === "attachment_quota_exceeded" && detail?.limit === "message_files") return text("error.attachment_quota_exceeded_files");
    return (typeof code === "string" && /^[a-z_]{1,80}$/.test(code) ? text(`error.${code}`) : "") || text("error.default");
  };
  const announcer = document.createElement("p");
  announcer.className = "sr-only";
  announcer.setAttribute("role", "status");
  form.append(announcer);
  const announce = message => { announcer.textContent = message; };
  const showStatus = message => { if (status) status.textContent = message ?? ""; };
  let entries = [], sending = false, pasted = 0;
  const active = () => entries.filter(entry => entry.state === "uploading" || entry.state === "pending" || entry.state === "ready");
  const refresh = () => {
    chips.hidden = entries.length === 0;
    if (notice) notice.hidden = entries.length === 0;
  };

  const stateText = entry => {
    if (entry.state === "uploading") return `${text("attachments.state_uploading")} ${entry.progress}%`;
    if (entry.state === "pending") return text("attachments.state_pending");
    if (entry.state === "ready") return entry.kind === "image" && entry.sanitizedBy === "fallback" ? text("attachments.no_preview_fallback") : text("attachments.state_ready");
    if (entry.state === "rejected") return `${text("attachments.state_rejected")}: ${text(`reason.${entry.reason}`) || text("attachments.state_rejected")}`;
    return `${text("attachments.state_failed")}: ${entry.error}`;
  };
  const draw = entry => {
    if (!entry.node) {
      const node = document.createElement("li"), thumb = document.createElement("span"), label = document.createElement("span");
      const name = document.createElement("span"), meta = document.createElement("span"), remove = document.createElement("button");
      const progress = document.createElement("progress");
      node.className = "attach-chip"; thumb.className = "attach-thumb"; label.className = "attach-text";
      name.className = "attach-name"; name.textContent = entry.name; name.setAttribute("title", entry.name);
      meta.className = "attach-meta";
      remove.type = "button"; remove.className = "attach-remove"; remove.setAttribute("aria-label", text("attachments.remove", { name: entry.name }));
      const close = icon("close"); if (close) remove.append(close); else remove.textContent = "×";
      remove.addEventListener("click", () => discard(entry));
      progress.className = "attach-progress"; progress.max = 100;
      label.append(name, meta);
      node.append(thumb, label, remove, progress);
      chips.append(node);
      entry.node = node; entry.parts = { thumb, meta, progress, remove };
    }
    const { node, parts } = entry;
    node.dataset.state = entry.state;
    node.dataset.kind = entry.kind;
    parts.meta.textContent = `${size(entry.size)} · ${stateText(entry)}`;
    parts.progress.value = entry.progress;
    parts.progress.hidden = entry.state !== "uploading";
    // Only a container re-encode has a preview; the server answers the image URL with a sandboxed, no-store image.
    const shown = entry.preview && uuid(entry.id) ? "preview" : entry.kind;
    if (parts.thumb.dataset.shows !== shown) {
      parts.thumb.dataset.shows = shown;
      if (shown === "preview") {
        const img = document.createElement("img");
        img.src = `${topic}/attachments/${entry.id}/preview`; img.alt = ""; img.width = 40; img.height = 40;
        parts.thumb.replaceChildren(img);
      } else {
        const glyph = icon(entry.kind === "image" ? "image" : "file");
        parts.thumb.replaceChildren(...glyph ? [glyph] : []);
      }
    }
    refresh();
  };

  const settle = (entry, view) => {
    if (!view || !uuid(view.id) || !["pending", "ready", "rejected", "deleted"].includes(view.state) || !["image", "pdf", "text"].includes(view.kind)) {
      entry.state = "failed"; entry.error = text("attachments.upload_failed"); return draw(entry);
    }
    entry.id = view.id; entry.revision = view.revision; entry.kind = view.kind; entry.preview = view.preview === true;
    entry.sanitizedBy = view.sanitizedBy; entry.reason = typeof view.reason === "string" && /^[a-z_]{1,80}$/.test(view.reason) ? view.reason : null;
    entry.state = view.state === "deleted" ? "failed" : view.state;
    if (view.state === "deleted") entry.error = text("error.attachment_stale");
    draw(entry);
  };
  // Processing state (`pending` until the sanitizer settles it) is polled from the metadata route, bounded.
  const poll = entry => {
    if (entry.polls >= 90 || entry.state !== "pending" || !entries.includes(entry)) return;
    entry.polls++;
    window.setTimeout(async () => {
      if (entry.state !== "pending" || !entries.includes(entry)) return;
      try {
        const response = await fetch(`${upload}/${entry.id}`, { credentials: "same-origin", headers: { accept: "application/json" } });
        if (response.ok) settle(entry, (await response.json())?.attachment);
      } catch { /* The next poll retries; the send still binds a pending file. */ }
      poll(entry);
    }, 2000);
  };
  const start = entry => {
    const xhr = new XMLHttpRequest();
    entry.xhr = xhr;
    xhr.open("POST", upload);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("X-CSRF-Token", field("csrf"));
    xhr.setRequestHeader("X-Jit-File-Name", encodeURIComponent(bounded(entry.name)));
    xhr.upload?.addEventListener("progress", event => {
      if (!event.lengthComputable || !event.total || entry.state !== "uploading") return;
      entry.progress = Math.min(100, Math.round(event.loaded / event.total * 100));
      draw(entry);
    });
    xhr.addEventListener("load", () => {
      entry.xhr = null;
      if (!entries.includes(entry)) return;
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* Not JSON: a transport failure. */ }
      if (xhr.status === 201) {
        settle(entry, body?.attachment);
        if (entry.state === "pending" || entry.state === "ready") announce(text("attachments.uploaded", { name: entry.name }));
        poll(entry);
      } else {
        entry.state = "failed"; entry.error = errorText(body?.error, body?.detail); draw(entry);
        announce(stateText(entry));
      }
    });
    xhr.addEventListener("error", () => {
      entry.xhr = null;
      if (!entries.includes(entry)) return;
      entry.state = "failed"; entry.error = text("attachments.upload_failed"); draw(entry); announce(stateText(entry));
    });
    xhr.send(entry.file);
  };
  const add = files => {
    showStatus("");
    for (const { file, name } of files) {
      if (active().length >= maxFiles) { showStatus(text("attachments.too_many", { count: maxFiles })); break; }
      const entry = { file, name: String(name || "file"), size: Number(file.size) || 0, kind: kindOf(String(name)), state: "uploading", progress: 0,
        id: null, revision: 0, preview: false, sanitizedBy: null, reason: null, error: "", xhr: null, node: null, parts: null, polls: 0 };
      entries.push(entry);
      if (fileBytes && entry.size > fileBytes) {
        entry.state = "failed"; entry.error = text("attachments.too_large", { size: size(fileBytes) }); draw(entry); announce(stateText(entry));
        continue;
      }
      draw(entry);
      start(entry);
    }
  };
  // The chip ×: an upload in flight is aborted; a staged file is discarded on the server (best effort; staged files
  // also expire on their own). Focus moves to the next chip, or back to the text.
  const discard = entry => {
    const index = entries.indexOf(entry);
    if (index < 0) return;
    entries = entries.filter(item => item !== entry);
    entry.xhr?.abort();
    if (entry.id && entry.state !== "failed") {
      fetch(`${upload}/${entry.id}/discard`, { method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json", "x-csrf-token": field("csrf") },
        body: JSON.stringify({ requestId: crypto.randomUUID(), expectedRevision: entry.revision }) }).catch(() => {});
    }
    entry.node?.remove();
    refresh();
    const next = entries[index] ?? entries[index - 1];
    if (next?.parts) next.parts.remove.focus(); else textarea?.focus();
  };

  // A pasted image (a screenshot) has no useful name: it is named from its first bytes, as the server will sniff them.
  const pastedName = async file => {
    try {
      const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
      const ascii = (from, to) => String.fromCharCode(...head.slice(from, to));
      const ext = head[0] === 0x89 && ascii(1, 4) === "PNG" ? "png" : head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff ? "jpg"
        : ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP" ? "webp" : null;
      if (ext) return `pasted-image-${++pasted}.${ext}`;
    } catch { /* Fall back to the browser's name; the server decides. */ }
    return file.name || "pasted-file";
  };

  form.dataset.attachReady = "true";
  form.dataset.dropLabel = text("attachments.drop_here");
  input.addEventListener("change", () => {
    const files = [...(input.files ?? [])].map(file => ({ file, name: file.name }));
    // The staged uploads carry the files; the native field is cleared so a plain submit never sends them twice.
    input.value = "";
    add(files);
  });
  textarea?.addEventListener("paste", event => {
    const data = event.clipboardData;
    const files = [...(data?.files ?? [])];
    // Copied text wins: a spreadsheet copy also carries a picture of the cells.
    if (!files.length || (data.getData?.("text/plain") ?? "").trim()) return;
    event.preventDefault();
    Promise.all(files.map(async file => ({ file, name: await pastedName(file) }))).then(add);
  });
  // Files dragged anywhere over the page attach to this composer, which shows the drop hint while they hover.
  let dragTimer = 0;
  const carriesFiles = event => [...(event.dataTransfer?.types ?? [])].includes("Files");
  document.addEventListener("dragover", event => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    form.dataset.attachDrag = "true";
    window.clearTimeout(dragTimer);
    dragTimer = window.setTimeout(() => { delete form.dataset.attachDrag; }, 250);
  });
  document.addEventListener("drop", event => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    window.clearTimeout(dragTimer);
    delete form.dataset.attachDrag;
    add([...(event.dataTransfer?.files ?? [])].map(file => ({ file, name: file.name })));
  });

  // Send. Without staged files the form posts natively (multipart to `?send=1`, no file parts). With staged files the
  // send is `message.send` JSON through the same session, Origin and CSRF checks, with the form's request id.
  form.addEventListener("submit", async event => {
    if (sending) { event.preventDefault(); return; }
    const staged = active();
    if (!staged.length) return;
    event.preventDefault();
    if (staged.some(entry => entry.state === "uploading")) { showStatus(text("attachments.wait_uploads")); return; }
    sending = true;
    form.setAttribute("aria-busy", "true");
    showStatus("");
    try {
      const response = await fetch(send, { method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json", "x-csrf-token": field("csrf") },
        body: JSON.stringify({ requestId: field("requestId"), expectedRevision: Number(field("expectedRevision")), text: textarea?.value ?? "",
          attachmentIds: staged.map(entry => entry.id) }) });
      let body = null;
      try { body = await response.json(); } catch { /* Not JSON. */ }
      const message = body?.message;
      if (response.ok && uuid(message?.id) && Number.isSafeInteger(message?.sequence)) {
        entries = [];
        const search = `?after=${Math.max(0, message.sequence - pageSize)}`;
        // Same page and query: only the fragment would change, which does not reload, so reload explicitly.
        if (location.pathname === topic && location.search === search) { location.hash = `message-${message.id}`; location.reload(); }
        else location.assign(`${topic}${search}#message-${message.id}`);
        return;
      }
      showStatus(`${text("attachments.send_failed")}: ${errorText(body?.error, body?.detail)}`);
    } catch {
      showStatus(text("attachments.send_failed"));
    } finally {
      sending = false;
      form.removeAttribute("aria-busy");
    }
  });
}
