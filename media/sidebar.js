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
  // Keyed by section id, so a saved state still fits after sections are moved or added.
  if (saved.openById) sections.forEach((d) => d.id in saved.openById && (d.open = saved.openById[d.id]));
  if (saved.filter) $("filter").value = saved.filter;
  let pendingScroll = saved.scrollY || 0; // applied once the first list is rendered

  let saveTimer = 0;
  function saveView() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const openById = Object.fromEntries(sections.map((d) => [d.id, d.open]));
      vscode.setState({ openById, filter: $("filter").value, scrollY: window.scrollY, loopMatch: $("loopMatch").value });
    }, 200);
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
  const taskButtons = ["extract", "convert", "optimize"];

  function updateLock() {
    const locked = busy || !!task;
    document.body.classList.toggle("busy", locked);
    for (const id of switchButtons) $(id).disabled = locked;
    // New tasks wait for the switch, since the window is about to close. So does a change to
    // the editor wallpaper: it rewrites the stylesheet Doki is writing and reopens the window too.
    for (const id of [...taskButtons, "wallpaperInEditor"]) $(id).disabled = busy;
    // Greyed out as well when there is nothing to remove.
    $("removeWallpaper").disabled = locked || !state?.wallpaperShown;
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
  $("removeWallpaper").onclick = () => state?.wallpaperShown && startSwitch({ type: "removeWallpaper" });
  $("sort").onchange = (e) => send({ type: "sort", value: e.target.value });

  // Open a section and bring it into view (links in the panel, or the extension's "Optimize…").
  function openSection(id) {
    const section = $(id);
    if (!section) return;
    section.open = true;
    // Also its parent section, for one inside another.
    const parent = section.parentElement?.closest("details");
    if (parent) parent.open = true;
    section.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  document.querySelectorAll("[data-open]").forEach((link) => {
    /** @type {HTMLElement} */ (link).onclick = (e) => {
      e.preventDefault();
      openSection(/** @type {HTMLElement} */ (link).dataset.open);
    };
  });
  $("filter").oninput = () => {
    renderList();
    saveView();
  };

  $("target").onchange = (e) => {
    if (state) state.target = e.target.value;
    renderTargets();
    send({ type: "setOption", key: "target", value: e.target.value });
  };

  // w and b over the preview: a shortcut for "Apply as". Yellow when that image of Doki's shows a
  // file, ringed when the carousel applies to it (both with "Both").
  const targetButtons = [...document.querySelectorAll("[data-target]")].map((b) => /** @type {HTMLButtonElement} */ (b));
  const TARGET_INFO = {
    wallpaper: "Wallpaper: shows through the code, side bars, panel and terminal",
    background: "Background: fills the editor area while no file is open",
  };
  function renderTargets() {
    if (!state) return;
    for (const button of targetButtons) {
      const target = button.dataset.target || "";
      const set = !!state.shown?.[target];
      const selected = state.target === target || state.target === "both";
      button.classList.toggle("set", set);
      button.classList.toggle("selected", selected);
      button.title = `${TARGET_INFO[target]}.\n${set ? "An image is set here." : "No image set here."}${selected ? "" : " Click to apply wallpapers here."}`;
    }
    renderOpacity();
  }
  for (const button of targetButtons) {
    button.onclick = () => {
      const target = button.dataset.target;
      if (!state || state.target === target) return;
      state.target = target; // shown right away, before the extension confirms
      $("target").value = target;
      renderTargets();
      send({ type: "setOption", key: "target", value: target });
    };
  }
  // Update the label while dragging, save once the slider is released.
  $("quickInputTint").oninput = (e) => ($("quickInputTintValue").textContent = e.target.value);
  $("quickInputTint").onchange = (e) => send({ type: "setOption", key: "quickInputTint", value: Number(e.target.value) });
  $("previewPalette").onclick = () => send({ type: "previewPalette" });

  // The wallpaper follows the slider while it moves (a theme color, no reopen needed). Settings
  // writes are kept to one every 150 ms, and the last value is sent once the slider is released.
  // It sets the opacity of the image(s) the carousel applies to (w, b or both, see renderTargets).
  let opacityTimer = 0;
  let draggingOpacity = false;
  const sendOpacity = () => send({ type: "opacity", value: Number($("wallpaperOpacity").value) });
  const OPACITY_LABEL = { wallpaper: "Wallpaper opacity", background: "Background opacity", both: "Opacity (both)" };
  function renderOpacity() {
    if (!state?.opacity) return;
    $("opacityLabel").textContent = OPACITY_LABEL[state.target] || "Opacity";
    if (draggingOpacity) return;
    // With both, they may differ until the slider moves; it starts from the wallpaper's.
    const value = state.target === "background" ? state.opacity.background : state.opacity.wallpaper;
    $("wallpaperOpacity").value = value;
    $("wallpaperOpacityValue").textContent = value;
  }
  $("wallpaperOpacity").oninput = (e) => {
    draggingOpacity = true;
    $("wallpaperOpacityValue").textContent = e.target.value;
    // The extension doesn't send the state back for this (see extension.ts), so keep it here.
    if (state?.opacity) {
      if (state.target !== "background") state.opacity.wallpaper = Number(e.target.value);
      if (state.target !== "wallpaper") state.opacity.background = Number(e.target.value);
    }
    if (!opacityTimer) {
      opacityTimer = setTimeout(() => {
        opacityTimer = 0;
        sendOpacity();
      }, 150);
    }
  };
  $("wallpaperOpacity").onchange = () => {
    draggingOpacity = false;
    clearTimeout(opacityTimer);
    opacityTimer = 0;
    sendOpacity();
  };

  // Turning it on asks for confirmation first; the state that comes back sets the box.
  $("wallpaperTheme").onchange = (e) => send({ type: "wallpaperTheme", enabled: e.target.checked });

  // The palette needs an image to come from: without one the box can't be ticked. Once on, it
  // stays ticked (and can be unticked) while there is none, and the palette comes back with the
  // next wallpaper.
  function renderWallpaperTheme() {
    const source = state.paletteSource === "background" ? "background" : "wallpaper";
    const hasImage = !!state.shown?.[source];
    const box = $("wallpaperTheme");
    box.checked = state.wallpaperTheme;
    box.disabled = !state.wallpaperTheme && !hasImage;
    const why = box.disabled ? `Apply a ${source} first: the palette comes from it.` : "";
    box.title = why;
    $("wallpaperThemeLabel").title = why;
    $("wallpaperThemeLabel").classList.toggle("disabled", box.disabled);
    $("paletteSourceHint").textContent =
      source === "wallpaper"
        ? "The palette comes from the wallpaper (w), not from the background (b)."
        : "The palette comes from the background (b), not from the wallpaper (w), as set in the extension's settings.";
  }

  for (const key of ["includeSubfolders", "wallpaperInEditor", "transparentPanels", "transparentTerminal", "brightenThumbnails"]) {
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
      // Still clickable: applying it explains why and offers GIF optimization.
      if (file.tooLarge) {
        li.classList.add("too-large");
        li.title += `\n⚠ ${file.tooLarge}`;
      }
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
  const convertFields = ["fps", "width", "height", "startSeconds", "durationSeconds"];

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

  // Files for GIF optimization: the extension opens the dialog and keeps the pick.
  document.querySelectorAll("[data-pick]").forEach((btn) => {
    const tool = /** @type {HTMLElement} */ (btn).dataset.pick;
    const pick = (e) => {
      e.preventDefault();
      send({ type: "pickFiles", tool });
    };
    /** @type {HTMLElement} */ (btn).onclick = pick;
    $(`${tool}Files`).onclick = pick;
  });

  function showPicked(tool, files) {
    const names = files.map((f) => f.split(/[\\/]/).pop());
    $(`${tool}Files`).value = files.length ? `${files.length} file${files.length === 1 ? "" : "s"}: ${names.join(", ")}` : "";
    $(`${tool}Files`).title = files.join("\n");
  }

  const optimizeFields = { fps: "optFps", width: "optWidth", height: "optHeight", startSeconds: "optStart", durationSeconds: "optDuration" };
  $("optimize").onclick = () => {
    const options = { destination: $("optDestination").value.trim() };
    for (const [key, id] of Object.entries(optimizeFields)) options[key] = Number($(id).value);
    send({ type: "optimize", options });
  };

  // ------------------------------------------------------------ loops
  // The extension compares every frame of the one picked GIF with its first frame (loops.ts);
  // the loops are picked here, so moving the Match slider shows them at once.
  let loops = { status: "off", seconds: 0, duration: 0, times: [], similarity: [] };
  $("loopMatch").value = String(saved.loopMatch || 97);

  /**
   * Frame indexes where a loop ends: the best match of each stretch that comes back to the Match
   * level, once the animation has clearly moved away from its first frame (or the frames right
   * after the first, still alike, would all count).
   */
  function loopPoints(similarity, match) {
    const leave = match - Math.max(0.02, 1 - match);
    const points = [];
    let near = true;
    let best = -1;
    for (let i = 1; i < similarity.length; i++) {
      if (near) {
        near = similarity[i] >= leave;
        continue;
      }
      if (similarity[i] >= match) {
        if (best === -1 || similarity[i] > similarity[best]) best = i;
      } else if (best !== -1) {
        points.push(best);
        best = -1;
        near = similarity[i] >= leave;
      }
    }
    if (best !== -1) points.push(best);
    return points;
  }

  const seconds = (value) => Math.max(0, Math.round(value * 1000) / 1000);

  /** The part Start and Duration keep, shaded on the track. */
  function renderLoopRange() {
    const length = loops.duration;
    const range = $("loopRange");
    range.style.display = length ? "" : "none";
    if (!length) return;
    const start = Math.min(length, Math.max(0, Number($("optStart").value) || 0));
    const duration = Number($("optDuration").value) || 0;
    const end = duration > 0 ? Math.min(length, start + duration) : length;
    range.style.left = `${(start / length) * 100}%`;
    range.style.width = `${(Math.max(0, end - start) / length) * 100}%`;
  }

  function renderLoops() {
    $("loops").hidden = loops.status === "off";
    if (loops.status === "off") return;
    const match = $("loopMatch").value;
    $("loopMatchValue").textContent = match;
    $("loopLength").textContent = loops.duration ? `${loops.duration.toFixed(2)} s` : "";
    const track = $("loopTrack");
    track.querySelectorAll(".loop-dot").forEach((dot) => dot.remove());

    const status = {
      running: `– reading the GIF… ${Math.floor(loops.seconds)} s`,
      noFfmpeg: "– finding them needs ffmpeg",
      failed: "– this GIF could not be read",
      still: "– this GIF barely moves",
    };
    if (loops.status !== "done") {
      $("loopStatus").textContent = status[loops.status] || "";
      renderLoopRange();
      return;
    }
    const points = loopPoints(loops.similarity, Number(match) / 100);
    $("loopStatus").textContent = points.length ? `– ${points.length} found` : `– none at ${match}% (lower Match finds looser ones)`;
    points.forEach((index, k) => {
      const start = k ? loops.times[points[k - 1]] : 0;
      const end = loops.times[index];
      const dot = document.createElement("button");
      dot.className = "loop-dot";
      dot.style.left = `${(end / loops.duration) * 100}%`;
      dot.title = `Loop ${k + 1}: ${start.toFixed(2)} → ${end.toFixed(2)} s, ${(loops.similarity[index] * 100).toFixed(1)}% match. Click to keep just this loop.`;
      dot.onclick = (e) => {
        e.preventDefault();
        $("optStart").value = seconds(start);
        // Stop just before the frame that starts the next loop.
        $("optDuration").value = seconds(end - start - 0.001);
        renderLoopRange();
      };
      track.appendChild(dot);
    });
    renderLoopRange();
  }

  $("loopMatch").oninput = renderLoops;
  $("loopMatch").onchange = saveView;
  $("optStart").addEventListener("input", renderLoopRange);
  $("optDuration").addEventListener("input", renderLoopRange);

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
    if (data.type === "loops") {
      loops = data;
      renderLoops();
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
    $("sort").value = state.sortBy === "random" ? "random" : `${state.sortBy}:${state.sortOrder}`;
    $("reshuffle").style.display = state.sortBy === "random" ? "" : "none";
    $("target").value = state.target;
    renderTargets();
    $("includeSubfolders").checked = state.includeSubfolders;
    updateLock();
    renderOpacity();
    $("quickInputTint").value = state.quickInputTint;
    $("quickInputTintValue").textContent = state.quickInputTint;
    $("transparentPanels").checked = state.transparentPanels;
    $("transparentTerminal").checked = state.transparentTerminal;
    $("wallpaperInEditor").checked = state.wallpaperInEditor;
    $("brightenThumbnails").checked = state.brightenThumbnails;
    renderWallpaperTheme();
    showPicked("optimize", state.optimizeFiles);

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
    if (state.openSection) openSection(state.openSection);

    // Only fill the tool forms once, so a state refresh doesn't wipe what the user is typing.
    if (!toolsInitialized) {
      toolsInitialized = true;
      for (const f of convertFields) $(f).value = state.convert[f];
      $("convertDestination").value = state.convert.destination || "";
      for (const [key, id] of Object.entries(optimizeFields)) $(id).value = state.optimize[key];
      $("optDestination").value = state.optimize.destination || "";
      $("extractSource").value = state.extractSource;
      $("extractDestination").value = state.extractDestination;
    }
  });

  send({ type: "ready" });
})();
