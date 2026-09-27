// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => /** @type {any} */ (document.getElementById(id));
  const send = (msg) => vscode.postMessage(msg);

  let state = null;

  // ------------------------------------------------------------ view state
  // VS Code destroys the panel while it is hidden and rebuilds it when shown again: keep the open
  // sections, the filter and the scroll position across that.
  const sections = [...document.querySelectorAll("details")];
  const saved = vscode.getState() || {};
  if (Array.isArray(saved.open) && saved.open.length === sections.length) sections.forEach((d, i) => (d.open = saved.open[i]));
  if (saved.filter) $("filter").value = saved.filter;
  let pendingScroll = saved.scrollY || 0; // applied once the first list is rendered

  let saveTimer = 0;
  function saveView() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => vscode.setState({ open: sections.map((d) => d.open), filter: $("filter").value, scrollY: window.scrollY }), 200);
  }
  sections.forEach((d) => d.addEventListener("toggle", saveView));

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
  $("filter").oninput = () => {
    renderList();
    saveView();
  };

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

  // The current wallpaper is shown as its still thumbnail (see SidebarProvider.previewUri).
  function showCurrent() {
    const waiting = state.thumbsAvailable ? "Generating preview…" : "Previews need ffmpeg";
    setPreview(state.currentUri, state.current ? waiting : "No wallpaper set");
  }

  let hovered = null;
  function showHovered() {
    setPreview(hovered.thumb, state.thumbsAvailable ? "Generating preview…" : "Previews need ffmpeg");
  }

  // Scroll only the list to the current wallpaper. scrollIntoView() would also scroll the page, and
  // even VS Code's container around the webview, so the panel jumped on every refresh.
  function revealCurrent() {
    const list = $("list");
    const li = list.querySelector(".current");
    if (!li) return;
    const offset = li.getBoundingClientRect().top - list.getBoundingClientRect().top;
    if (offset < 0) list.scrollTop += offset;
    else if (offset + li.offsetHeight > list.clientHeight) list.scrollTop += offset + li.offsetHeight - list.clientHeight;
  }

  let revealedPath = null;
  let renderedFilter = "";
  function renderList() {
    if (!state) return;
    const list = $("list");
    const filter = $("filter").value.toLowerCase();
    // A refresh (e.g. an option changed) keeps the list where the user left it; only a new
    // current wallpaper or a new filter moves it.
    const filterChanged = filter !== renderedFilter;
    const keepScroll = filterChanged ? 0 : list.scrollTop;
    const reveal = filterChanged || revealedPath !== state.current;
    renderedFilter = filter;
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
        showCurrent();
      };
      list.appendChild(li);
    });
    list.scrollTop = keepScroll;
    // Inside a closed section the list has no layout yet: reveal it once the section opens.
    if (reveal && list.offsetParent) {
      revealCurrent();
      revealedPath = state.current;
    }
  }
  $("list").closest("details").addEventListener("toggle", (e) => {
    if (/** @type {HTMLDetailsElement} */ (e.target).open && revealedPath !== state?.current) {
      revealCurrent();
      revealedPath = state.current;
    }
  });

  // The list scrolls inside the scrolling page. While the page moves under a still pointer, the
  // list would slide under it and take over the wheel, stopping the page halfway. So the list
  // ignores the pointer while the page is scrolling, and takes the wheel again after a short pause.
  let pageScrollTimer = 0;
  window.addEventListener("scroll", () => {
    document.body.classList.add("page-scrolling");
    clearTimeout(pageScrollTimer);
    pageScrollTimer = setTimeout(() => document.body.classList.remove("page-scrolling"), 350);
    saveView();
  }, { passive: true });

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
    if (data.type === "currentThumb") {
      if (!state) return;
      state.currentUri = data.thumb;
      if (!hovered) showCurrent();
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
    if (!hovered) showCurrent();
    renderList();
    if (pendingScroll) {
      window.scrollTo(0, pendingScroll);
      pendingScroll = 0;
    }

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
