// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => /** @type {any} */ (document.getElementById(id));
  const send = (msg) => vscode.postMessage(msg);

  let state = null;

  // ------------------------------------------------------------ switching lock
  // The extension owns the real lock; this blocks clicks right away, before its reply arrives.
  let busy = false;
  let confirmed = false; // the extension reported the switch as started
  let localTimer = 0;
  let applyingPath = "";
  // A copy, move or conversion running in this window: switching would close the window and stop it.
  let task = "";
  const switchButtons = ["prev", "next", "random"];
  const taskButtons = ["extract", "convert"];

  function updateLock() {
    const locked = busy || !!task;
    document.body.classList.toggle("busy", locked);
    for (const id of switchButtons) $(id).disabled = locked;
    // New tasks wait for the switch, since the window is about to close.
    for (const id of taskButtons) $(id).disabled = busy;
    $("taskNote").hidden = !task;
    $("taskNote").textContent = task ? `${task}… You can change the wallpaper once it finishes.` : "";
  }

  function setBusy(value) {
    busy = value;
    updateLock();
    if (!value) {
      applyingPath = "";
      document.querySelectorAll("#list li.applying").forEach((li) => li.classList.remove("applying"));
    }
  }

  function setTask(value) {
    task = value || "";
    updateLock();
  }

  function startSwitch(msg, li) {
    if (busy || task) return;
    setBusy(true);
    applyingPath = msg.path || "";
    li?.classList.add("applying");
    confirmed = false;
    clearTimeout(localTimer);
    // Unlock if the extension never starts a switch (e.g. no wallpapers in the folder).
    localTimer = setTimeout(() => !confirmed && setBusy(false), 1500);
    send(msg);
  }

  // ------------------------------------------------------------ carousel
  $("prev").onclick = () => startSwitch({ type: "prev" });
  $("next").onclick = () => startSwitch({ type: "next" });
  $("random").onclick = () => startSwitch({ type: "random" });
  $("setFolder").onclick = () => send({ type: "setFolder" });
  $("refresh").onclick = () => send({ type: "refresh" });
  $("reshuffle").onclick = () => send({ type: "reshuffle" });
  $("filter").oninput = renderList;

  for (const key of ["sortBy", "sortOrder", "target", "reloadMode"]) {
    $(key).onchange = (e) => send({ type: "setOption", key, value: e.target.value });
  }
  // Update the label while dragging, save once the slider is released.
  $("quickInputTint").oninput = (e) => ($("quickInputTintValue").textContent = e.target.value);
  $("quickInputTint").onchange = (e) => send({ type: "setOption", key: "quickInputTint", value: Number(e.target.value) });
  $("previewPalette").onclick = () => send({ type: "previewPalette" });

  for (const key of ["includeSubfolders", "transparentPanels", "transparentTerminal", "brightenThumbnails"]) {
    $(key).onchange = (e) => send({ type: "setOption", key, value: e.target.checked });
  }

  function setPreview(uri, emptyText = "No wallpaper set") {
    $("preview").src = uri || "";
    $("preview").style.display = uri ? "block" : "none";
    $("previewEmpty").style.display = uri ? "none" : "block";
    $("previewEmpty").textContent = emptyText;
  }

  let hovered = null;
  function showHovered() {
    setPreview(hovered.thumb, state.thumbsAvailable ? "Generating preview…" : "Previews need ffmpeg");
  }

  function renderList() {
    if (!state) return;
    const list = $("list");
    const filter = $("filter").value.toLowerCase();
    list.innerHTML = "";
    state.files.forEach((file, i) => {
      if (filter && !file.name.toLowerCase().includes(filter)) return;
      const li = document.createElement("li");
      li.textContent = `${i + 1}. ${file.name}`;
      li.title = file.path;
      if (i === state.currentIndex) li.classList.add("current");
      if (busy && file.path === applyingPath) li.classList.add("applying");
      li.onclick = () => startSwitch({ type: "apply", path: file.path }, li);
      li.onmouseenter = () => {
        hovered = file;
        showHovered();
      };
      li.onmouseleave = () => {
        hovered = null;
        setPreview(state.currentUri);
      };
      list.appendChild(li);
    });
    list.querySelector(".current")?.scrollIntoView({ block: "nearest" });
  }

  // ------------------------------------------------------------ tools
  const convertFields = ["fps", "width", "height", "startSeconds", "durationSeconds", "opacity"];
  $("opacity").oninput = () => ($("opacityValue").textContent = $("opacity").value);

  document.querySelectorAll("[data-browse]").forEach((btn) => {
    const field = /** @type {HTMLElement} */ (btn).dataset.browse;
    /** @type {HTMLElement} */ (btn).onclick = (e) => {
      e.preventDefault();
      send({ type: "browseDir", field, current: $(field).value });
    };
  });

  $("extract").onclick = () =>
    send({
      type: "extract",
      source: $("extractSource").value.trim(),
      destination: $("extractDestination").value.trim(),
      move: $("extractMove").checked,
    });

  $("convert").onclick = () => {
    const options = {};
    for (const f of convertFields) {
      const el = $(f);
      options[f] = el.type === "text" ? el.value.trim() : Number(el.value);
    }
    options.destination = $("convertDestination").value.trim();
    send({ type: "convert", options });
  };

  // ------------------------------------------------------------ messages
  let toolsInitialized = false;
  window.addEventListener("message", ({ data }) => {
    if (data.type === "dirPicked") {
      $(data.field).value = data.path;
      return;
    }
    if (data.type === "thumb") {
      const file = state?.files.find((f) => f.path === data.path);
      if (file) file.thumb = data.thumb;
      if (hovered && hovered.path === data.path) showHovered();
      return;
    }
    if (data.type === "busy") {
      confirmed = data.busy;
      setBusy(data.busy);
      return;
    }
    if (data.type === "task") {
      setTask(data.task);
      return;
    }
    if (data.type !== "state") return;
    state = data;
    if (state.busy) {
      confirmed = true;
      setBusy(true);
    }
    setTask(state.task);

    $("folder").textContent = state.folder || "No folder set";
    $("folder").title = state.folder;
    $("sortBy").value = state.sortBy;
    $("sortOrder").value = state.sortOrder;
    $("sortOrder").disabled = state.sortBy === "random";
    $("reshuffle").style.display = state.sortBy === "random" ? "" : "none";
    $("target").value = state.target;
    $("includeSubfolders").checked = state.includeSubfolders;
    $("reloadMode").value = state.reloadMode;
    $("quickInputTint").value = state.quickInputTint;
    $("quickInputTintValue").textContent = state.quickInputTint;
    $("transparentPanels").checked = state.transparentPanels;
    $("transparentTerminal").checked = state.transparentTerminal;
    $("brightenThumbnails").checked = state.brightenThumbnails;

    const total = state.files.length;
    $("counter").textContent = total ? `${state.currentIndex >= 0 ? state.currentIndex + 1 : "–"} / ${total}` : "0 / 0";
    $("count").textContent = `(${total})`;
    $("currentName").textContent = state.current ? state.current.split(/[\\/]/).pop() : "";
    $("currentName").title = state.current;
    setPreview(state.currentUri);
    renderList();

    // Only fill the tool forms once, so a state refresh doesn't wipe what the user is typing.
    if (!toolsInitialized) {
      toolsInitialized = true;
      for (const f of convertFields) $(f).value = state.convert[f];
      $("opacityValue").textContent = state.convert.opacity;
      $("convertDestination").value = state.convert.destination || "";
      $("extractSource").value = state.extractSource;
      $("extractDestination").value = state.extractDestination;
    }
  });

  send({ type: "ready" });
})();
