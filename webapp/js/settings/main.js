// @ts-check
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Innate Inc
// Settings page — a guided editor over config/settings.yaml. The catalog (knobs,
// defaults, docs) lives in catalog.js; this renders a row per knob showing its
// default and current value, lets you override or reset, and saves via the
// proxy (which edits settings.yaml surgically, so hand comment/uncomment over
// SSH keeps working). Doesn't use rosbridge — it talks to the proxy directly:
// GET /settings.json to read, POST /settings.json to write.
//
// Per-row state: a *saved* override (non-default, persisted) shows orange; an
// *unsaved* edit (differs from what's saved) shows blue. Save is enabled only
// while there are unsaved changes.

import { ROBOT_INFO_TOPIC, SET_VOLUME_SERVICE } from "../constants.js";
import { ros } from "../rosClient.js";
import { SETTINGS_PAGES } from "./catalog.js";
import { SETTINGS_STYLE } from "./styles.js";

// Assigned per mount by mount() at the bottom. The volume control uses the shared
// rosbridge socket, which the router connects once at boot and keeps up across
// navigation, so this page no longer manages its own connection.
/** @type {HTMLElement} */
let stage;
/** @type {HTMLStyleElement | null} */
let styleEl = null;
/** Per-mount teardowns: ros subscriptions to drop when we navigate away. */
/** @type {(() => void)[]} */
let cleanups = [];

/**
 * @typedef {Object} Entry
 * @property {import("./catalog.js").Knob} knob
 * @property {boolean} overridden   Current form state: is this knob overridden?
 * @property {*} value Current form value.
 * @property {boolean} savedOverridden  Last-saved (on-disk) state.
 * @property {*} savedValue
 * @property {() => void} render  Push value + overridden state into the DOM control.
 * @property {HTMLElement} row
 * @property {HTMLElement} [errEl]  Out-of-range message; absent on non-numeric knobs.
 */
/** @type {Entry[]} */
const entries = [];

/**
 * @typedef {Object} PageUI
 * @property {HTMLElement} panel  Detail-pane content for this destination.
 * @property {HTMLButtonElement} row  Index list row that opens this destination.
 * @property {HTMLElement} dot  Unsaved-changes indicator on the index row.
 * @property {Entry[]} entries  Knob entries belonging to this destination.
 */
/** @type {PageUI[]} */
const pages = [];
/**
 * @typedef {Object} SearchTarget
 * @property {string} label
 * @property {string} description
 * @property {HTMLElement} row
 * @property {PageUI} page
 * @property {string} breadcrumb
 * @property {string} visibleSearchText  Label, description, and breadcrumb.
 * @property {{label: string, text: string}[]} extraSearchSources
 * @property {string} searchText  All searchable text, lowercased.
 */
/** @type {SearchTarget[]} */
const searchTargets = [];
const MAX_SEARCH_RESULTS = 20;
/** @type {HTMLElement | null} */
let bodyEl = null;

// Created fresh in build() each mount, so re-mounting never double-binds their
// click handlers.
/** @type {HTMLButtonElement} */ let saveBtn;
/** @type {HTMLButtonElement} */ let resetAllBtn;
/** @type {HTMLButtonElement} */ let restartBtn;
/** @type {HTMLElement} */ let dirtyEl;
/** @type {HTMLElement} */ let statusEl;

/** Walk a path into the nested overrides dict; undefined if absent. */
function lookup(/** @type {any} */ obj, /** @type {string[]} */ p) {
  let cur = obj;
  for (const k of p) {
    if (cur == null || typeof cur !== "object" || !(k in cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

function setStatus(/** @type {string} */ msg, /** @type {string} */ cls = "muted") {
  statusEl.textContent = msg;
  statusEl.className = "set-status " + cls;
}

/** @param {string} tag @param {string} className @param {string} [text] */
function textEl(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function addSearchTarget(
  /** @type {Omit<SearchTarget, "visibleSearchText" | "searchText">} */ target,
) {
  const visibleSearchText = [target.breadcrumb, target.label, target.description]
    .join(" ")
    .toLowerCase();
  searchTargets.push({
    ...target,
    visibleSearchText,
    searchText: [visibleSearchText, ...target.extraSearchSources.map((source) => source.text)]
      .join(" ")
      .toLowerCase(),
  });
}

/** Always mounted; CSS shows it only when value ≠ default. */
function buildRestoreDefaultButton(/** @type {Entry} */ entry) {
  const knob = entry.knob;
  const opt = knob.options && knob.options.find((o) => o.value === knob.default);
  const defShort = opt ? opt.label : String(knob.default) + (knob.unit ? " " + knob.unit : "");
  const tip = "Restore built-in default (" + defShort + ")";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "set-restore";
  btn.dataset.activate = "release";
  btn.textContent = "Restore default";
  btn.title = tip;
  btn.setAttribute("aria-label", tip);
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    entry.overridden = false;
    entry.value = knob.default;
    entry.render();
    recompute();
  });
  return btn;
}

/**
 * Coerce an on-disk override value to the knob's JS type.
 * @returns {*}
 */
function coerceLoaded(/** @type {import("./catalog.js").Knob} */ knob, /** @type {any} */ v) {
  if (knob.type === "bool") return Boolean(v);
  if (knob.type === "int" || knob.type === "float") return Number(v);
  return String(v);
}

/**
 * Why this value can't be saved, or "" if it can.
 *
 * The robot rejects out-of-range drive knobs outright (mars_app's on_set_parameters), so
 * without this the save would appear to succeed and the robot would keep the old value.
 * Bounds are the absurd limits, not tuning advice — the point is to keep a typo like
 * 0.000001 m/s² of deceleration, which takes days to stop, out of the file.
 */
function boundsError(/** @type {Entry} */ e) {
  const knob = e.knob;
  if (knob.type !== "int" && knob.type !== "float") return "";
  const v = Number(e.value);
  if (!Number.isFinite(v)) return "Not a number";
  if (knob.min !== undefined && v < knob.min) return `Min ${knob.min}`;
  if (knob.max !== undefined && v > knob.max) return `Max ${knob.max}`;
  return "";
}

/** Has this entry changed since the last save? */
function isDirty(/** @type {Entry} */ e) {
  if (e.overridden !== e.savedOverridden) return true;
  return e.overridden && e.value !== e.savedValue;
}

function setKnobValue(/** @type {Entry} */ entry, /** @type {*} */ value) {
  entry.value = value;
  entry.overridden = entry.value !== entry.knob.default;
  recompute();
}

/** Repaint every row + destination dots + the footer (dirty count, Save enabled). */
function recompute() {
  let dirty = 0;
  let bad = 0;
  for (const e of entries) {
    const d = isDirty(e);
    if (d) dirty++;
    // Only flag a knob the operator has actually touched: a bound tightened after a value
    // was already saved shouldn't light up rows nobody is editing.
    const err = d ? boundsError(e) : "";
    if (err) bad++;
    e.row.classList.toggle("dirty", d && !err);
    e.row.classList.toggle("invalid", Boolean(err));
    e.row.classList.toggle("saved", !d && e.overridden);
    // Restore tracks value≠default, not dirty/saved — otherwise flipping a toggle
    // back to default still showed Restore and clicking it felt broken.
    e.row.classList.toggle("has-override", e.value !== e.knob.default);
    if (e.errEl) e.errEl.textContent = err;
  }
  for (const page of pages) {
    // Index rows stay quiet — purple dot alone marks unsaved work in the destination.
    page.dot.classList.toggle("show", page.entries.some(isDirty));
  }
  dirtyEl.textContent = bad
    ? `${bad} value${bad === 1 ? "" : "s"} out of range`
    : dirty
      ? `${dirty} unsaved change${dirty === 1 ? "" : "s"}`
      : "";
  dirtyEl.classList.toggle("set-bad", bad > 0);
  saveBtn.disabled = dirty === 0 || bad > 0;
  resetAllBtn.disabled = !entries.some((e) => e.overridden);
}

/** Reset every knob to its default in the form (you still click Save to commit). */
function resetAll() {
  for (const e of entries) {
    e.overridden = false;
    e.value = e.knob.default;
    e.render();
  }
  recompute();
}

const DEFAULT_VOLUME = 80; // robot's built-in default (percent) until /robot/info arrives.

/** Clamp to an integer 0–100, mirroring the mobile app's clampVolumePercent. */
function clampVolume(/** @type {number} */ value) {
  if (!Number.isFinite(value)) return DEFAULT_VOLUME;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function syncSliderFill(/** @type {HTMLInputElement} */ slider) {
  const min = Number(slider.min);
  const percent = ((Number(slider.value) - min) / (Number(slider.max) - min)) * 100;
  slider.style.setProperty("--set-slider-fill", `${percent}%`);
}

/** One-time setup: sync fill on input, track pointer so the focus ring can hide. */
function initSlider(/** @type {HTMLInputElement} */ slider) {
  syncSliderFill(slider);
  slider.addEventListener("input", () => syncSliderFill(slider));
  slider.addEventListener("pointerdown", () => slider.classList.add("is-pointer"));
  slider.addEventListener("blur", () => slider.classList.remove("is-pointer"));
}

/** Focus for row-click / search: show the ring, clearing any prior pointer grab. */
function focusControl(/** @type {HTMLElement} */ el, /** @type {FocusOptions} */ opts = {}) {
  el.classList.remove("is-pointer");
  el.focus({ focusVisible: true, ...opts });
}

/**
 * Live speaker-volume control. Unlike the yaml knobs below, this is a rosbridge
 * service call that applies immediately and persists on the robot — no restart.
 * The slider is the raw volume_percent (0–100): it reads the current value from
 * /robot/info and writes via /set_volume on release. The robot lifts the low end
 * of the range so the bottom of the slider stays audible (see apply_alsa_volume).
 * @returns {{section: HTMLElement, row: HTMLElement, label: string, description: string}}
 */
function buildVolumeSection() {
  const labelText = "Speaker volume";
  const descriptionText = "The robot's voice volume. Applies immediately — no restart.";
  const section = textEl("section", "set-card-volume");

  const row = textEl("div", "set-row");

  const info = textEl("div", "set-info");
  const label = textEl("span", "set-label", labelText);
  const doc = textEl("span", "set-doc", descriptionText);
  info.append(label, doc);
  row.appendChild(info);

  const ctl = textEl("div", "set-ctl");

  const slider = document.createElement("input");
  slider.type = "range";
  slider.className = "set-slider";
  slider.min = "0";
  slider.max = "100";
  slider.step = "1";
  // Resting thumb position while we wait for the robot's value; the readout shows
  // "—" and the slider stays disabled, so this isn't read as a real setting.
  slider.value = "50";
  slider.disabled = true;
  initSlider(slider);

  const read = textEl("span", "set-slider-read");
  read.textContent = "—"; // nothing until /robot/info reports the live volume
  const sliderWrap = textEl("div", "set-slider-wrap");
  sliderWrap.append(read, slider);
  ctl.appendChild(sliderWrap);

  const status = textEl("span", "set-card-volume-status set-status muted");
  ctl.appendChild(status);

  row.appendChild(ctl);
  enableRowClick(row);
  section.appendChild(row);

  // Last percent known to be applied on the robot; the revert target on failure.
  let robotPercent = DEFAULT_VOLUME;
  let hasValue = false; // false until /robot/info reports the live volume
  let dragging = false;
  let saving = false;

  const setLiveStatus = (/** @type {string} */ msg, /** @type {string} */ cls) => {
    status.textContent = msg;
    status.className = "set-card-volume-status set-status " + cls;
  };

  const renderValue = (/** @type {number} */ percent) => {
    slider.value = String(percent);
    syncSliderFill(slider);
    read.textContent = percent + "%";
  };

  // Disabled until connected AND the live volume has loaded (so the page never
  // shows a guessed default), and while a save is in flight so a mid-save release
  // can't be silently dropped (nor re-enabled by a state change). Clearing
  // `dragging` on disable matters too: a disconnect mid-drag would otherwise
  // leave it stuck true, so the subscription below would ignore every /robot/info
  // after reconnect and the slider would freeze, diverging from the real volume.
  const refreshEnabled = () => {
    const shouldDisable = ros.state !== "connected" || saving || !hasValue;
    if (shouldDisable) dragging = false;
    slider.disabled = shouldDisable;
  };

  cleanups.push(
    ros.onStateChange((state) => {
      const connected = state === "connected";
      refreshEnabled();
      if (!connected) setLiveStatus("Connect to the robot to set volume.", "muted");
      else if (status.classList.contains("muted")) setLiveStatus("", "muted");
    }),
  );

  const unsubInfo = ros.subscribe(ROBOT_INFO_TOPIC, (/** @type {StringMsg} */ payload) => {
    /** @type {RobotInfo} */
    let infoData;
    try {
      infoData = JSON.parse(payload.data);
    } catch {
      return;
    }
    if (typeof infoData.volume_percent !== "number") return;
    robotPercent = clampVolume(infoData.volume_percent);
    const firstValue = !hasValue;
    hasValue = true;
    // Don't clobber a value the operator is actively dragging or saving.
    if (!dragging && !saving) renderValue(robotPercent);
    if (firstValue) refreshEnabled(); // enable now that the live value has loaded
  }, undefined, "std_msgs/msg/String");
  cleanups.push(unsubInfo);

  slider.addEventListener("input", () => {
    dragging = true;
    read.textContent = slider.value + "%";
  });

  slider.addEventListener("change", async () => {
    dragging = false;
    const next = clampVolume(Number(slider.value));
    renderValue(next);
    if (next === robotPercent || saving) return;
    const previous = robotPercent;
    saving = true;
    refreshEnabled();
    setLiveStatus("Saving…", "muted");
    try {
      /** @type {{ success: boolean, message?: string }} */
      const res = await ros.callService(SET_VOLUME_SERVICE, { volume_percent: next });
      if (!res.success) throw new Error(res.message || "Failed to set volume.");
      robotPercent = next;
      setLiveStatus("Volume set.", "ok");
    } catch {
      // Re-seed robotPercent too: a /robot/info update may have moved it during
      // the save, and on failure the robot's volume is still `previous`.
      robotPercent = previous;
      renderValue(previous);
      setLiveStatus("Couldn't set volume. Try again.", "err");
    } finally {
      saving = false;
      refreshEnabled();
    }
  });

  return { section, row, label: labelText, description: descriptionText };
}

const INDEX_CHEV =
  '<svg class="set-index-chev" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9,6 15,12 9,18"/></svg>';

function selectPage(/** @type {PageUI} */ ui) {
  for (const page of pages) {
    const on = page === ui;
    page.panel.classList.toggle("active", on);
    if (on) page.row.setAttribute("aria-current", "page");
    else page.row.removeAttribute("aria-current");
  }
  bodyEl?.classList.add("is-detail");
}

function build() {
  styleEl = document.createElement("style");
  styleEl.textContent = SETTINGS_STYLE;
  document.head.appendChild(styleEl);

  const page = textEl("div", "settings-page");

  const body = textEl("div", "settings-body");
  bodyEl = body;

  const scroll = textEl("div", "settings-scroll");

  const wrap = textEl("div", "settings-wrap");

  const index = textEl("div", "set-index");

  const indexTitle = textEl("h1", "page-title", "Preferences");
  index.appendChild(indexTitle);

  const indexNote = textEl("p", "settings-note", "Tune how the robot drives, sees, and talks. Changes save to settings.yaml.");
  index.appendChild(indexNote);

  const search = document.createElement("input");
  search.type = "search";
  search.className = "set-search";
  search.placeholder = "Search settings";
  search.maxLength = 40;
  search.setAttribute("aria-label", "Search settings");
  index.appendChild(search);

  const indexCard = textEl("div", "set-card-index");
  index.appendChild(indexCard);

  const searchResults = textEl("div", "set-card-search");
  searchResults.hidden = true;
  index.appendChild(searchResults);

  const returnToIndex = () => {
    search.value = "";
    renderSearchResults("", indexCard, searchResults);
    bodyEl?.classList.remove("is-detail");
    for (const page of pages) {
      page.panel.classList.remove("active");
      page.row.removeAttribute("aria-current");
    }
  };

  const detail = textEl("div", "set-detail");

  const back = document.createElement("button");
  back.type = "button";
  back.className = "set-back";
  back.innerHTML =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15,6 9,12 15,18"/></svg><span>Preferences</span>';
  back.addEventListener("click", returnToIndex);
  detail.appendChild(back);

  for (const settingsPage of SETTINGS_PAGES) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "set-index-row";

    const icon = textEl("span", "set-index-icon");
    icon.style.setProperty(
      "--icon-url",
      `url("/js/settings/icons/${settingsPage.icon}")`,
    );

    const text = textEl("span", "set-index-text");
    const label = textEl("span", "set-index-label", settingsPage.title);
    const summary = textEl("span", "set-index-summary", settingsPage.summary);
    text.append(label, summary);

    const dot = textEl("span", "set-index-dot");
    dot.title = "Unsaved changes in this section";

    row.append(icon, text, dot);
    row.insertAdjacentHTML("beforeend", INDEX_CHEV);
    indexCard.appendChild(row);

    const panel = textEl("section", "set-pane");
    panel.setAttribute("aria-label", settingsPage.title);

    const pageTitle = textEl("h1", "page-title", settingsPage.title);
    panel.appendChild(pageTitle);

    if (settingsPage.note) {
      const gn = textEl("p", "settings-note", settingsPage.note);
      panel.appendChild(gn);
    }

    const pageSearchSource = {
      label: "Matched in page description",
      text: settingsPage.summary,
    };
    const volumeControl = settingsPage.hasSpeakerVolume ? buildVolumeSection() : null;
    if (volumeControl) {
      const speaker = textEl("section", "set-page-section");
      const speakerTitle = textEl("h2", "set-section-title", "Speaker");
      speaker.append(speakerTitle, volumeControl.section);
      panel.appendChild(speaker);
    }

    /** @type {PageUI} */
    const ui = { panel, row, dot, entries: [] };
    row.addEventListener("click", () => selectPage(ui));
    pages.push(ui);

    if (volumeControl) {
      addSearchTarget({
        label: volumeControl.label,
        description: volumeControl.description,
        row: volumeControl.row,
        page: ui,
        breadcrumb: `${settingsPage.title} · Speaker`,
        extraSearchSources: [pageSearchSource],
      });
    }

    for (const pageSection of settingsPage.sections) {
      const sectionStart = entries.length;
      panel.appendChild(buildPageSection(pageSection));
      const sectionEntries = entries.slice(sectionStart);
      ui.entries.push(...sectionEntries);
      const extraSearchSources = [
        { label: "Matched in section description", text: pageSection.note || "" },
        pageSearchSource,
      ].filter((source) => source.text);
      for (const entry of sectionEntries) {
        const breadcrumb = entry.knob.subsection
          ? `${settingsPage.title} · ${pageSection.title} · ${entry.knob.subsection}`
          : `${settingsPage.title} · ${pageSection.title}`;
        addSearchTarget({
          label: entry.knob.label,
          description: entry.knob.doc,
          row: entry.row,
          page: ui,
          breadcrumb,
          extraSearchSources,
        });
      }
    }
    detail.appendChild(panel);
  }

  search.addEventListener("input", () => renderSearchResults(search.value, indexCard, searchResults));

  wrap.append(index, detail);
  scroll.appendChild(wrap);
  body.appendChild(scroll);
  page.appendChild(body);

  const bar = textEl("div", "set-bar");
  saveBtn = document.createElement("button");
  saveBtn.className = "set-save";
  saveBtn.textContent = "Save";
  saveBtn.disabled = true;
  saveBtn.addEventListener("click", onSave);
  dirtyEl = document.createElement("span");
  dirtyEl.className = "set-dirty";
  resetAllBtn = document.createElement("button");
  resetAllBtn.className = "set-reset-all";
  resetAllBtn.textContent = "Reset all to defaults";
  resetAllBtn.disabled = true;
  resetAllBtn.addEventListener("click", resetAll);
  restartBtn = document.createElement("button");
  restartBtn.className = "set-restart";
  restartBtn.textContent = "Restart robot";
  restartBtn.title = "Restart the robot to apply saved settings (same as innate restart)";
  restartBtn.addEventListener("click", onRestart);
  statusEl = document.createElement("span");
  bar.appendChild(saveBtn);
  bar.appendChild(dirtyEl);
  bar.appendChild(statusEl);
  bar.appendChild(resetAllBtn);
  bar.appendChild(restartBtn);
  page.appendChild(bar);

  stage.appendChild(page);
  setStatus("Loading current values…");
}

/** @param {import("./catalog.js").Knob[]} knobs */
function splitSubsectionGroups(knobs) {
  /** @type {{ title: string | null, knobs: import("./catalog.js").Knob[] }[]} */
  const groups = [];
  for (const knob of knobs) {
    const subsection = knob.subsection || null;
    const last = groups[groups.length - 1];
    if (last && last.title === subsection) last.knobs.push(knob);
    else groups.push({ title: subsection, knobs: [knob] });
  }
  return groups;
}

/** @param {import("./catalog.js").PageSection} pageSection */
function buildPageSection(pageSection) {
  const section = textEl("section", "set-page-section");
  section.appendChild(textEl("h2", "set-section-title", pageSection.title));
  if (pageSection.note) {
    section.appendChild(textEl("p", "set-section-note", pageSection.note));
  }

  const card = textEl("div", "set-card");
  const groups = splitSubsectionGroups(pageSection.knobs);
  const showSubsectionTitles = groups.filter((group) => group.title).length > 1;
  for (const group of groups) {
    /** @type {HTMLElement} */
    let host = card;
    if (showSubsectionTitles) {
      const block = textEl("div", "set-subblock");
      if (group.title) block.appendChild(textEl("div", "set-subh", group.title));
      card.appendChild(block);
      host = block;
    }
    for (const knob of group.knobs) host.appendChild(buildRow(knob));
  }
  section.appendChild(card);
  return section;
}

/**
 * Fill an element with text, wrapping case-insensitive matches of `terms` in
 * <mark class="set-search-mark">. Uses Text nodes so query characters stay safe.
 * @param {HTMLElement} el
 * @param {string} text
 * @param {string[]} terms  Lowercase search tokens already filtered for emptiness.
 */
function setHighlightedText(el, text, terms) {
  el.replaceChildren();
  const pattern = terms
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .sort((a, b) => b.length - a.length)
    .join("|");
  const re = new RegExp(pattern, "gi");
  let last = 0;
  for (const match of text.matchAll(re)) {
    const start = match.index ?? 0;
    if (start > last) el.append(text.slice(last, start));
    const mark = textEl("mark", "set-search-mark", match[0]);
    el.append(mark);
    last = start + match[0].length;
  }
  if (last < text.length) el.append(text.slice(last));
}

function searchResultRank(
  /** @type {SearchTarget} */ target,
  /** @type {string} */ normalizedQuery,
  /** @type {string[]} */ terms,
) {
  const labelText = target.label.toLowerCase();
  const descriptionText = target.description.toLowerCase();
  if (labelText === normalizedQuery) return 0;
  if (terms.every((term) => labelText.includes(term))) return 1;
  if (terms.every((term) => descriptionText.includes(term))) return 2;
  return 3;
}

/**
 * Replace the destination index with direct knob matches while searching.
 * Clicking a result opens the owning destination, then focuses the matching
 * control without changing its value.
 */
function renderSearchResults(
  /** @type {string} */ query,
  /** @type {HTMLElement} */ indexCard,
  /** @type {HTMLElement} */ results,
) {
  const normalizedQuery = query.trim().toLowerCase();
  const terms = normalizedQuery.split(/\s+/).filter(Boolean);
  const searching = terms.length > 0;
  indexCard.hidden = searching;
  results.hidden = !searching;
  results.replaceChildren();
  if (!searching) return;

  const matches = searchTargets
    .filter((target) => terms.every((term) => target.searchText.includes(term)))
    .sort(
      (a, b) =>
        searchResultRank(a, normalizedQuery, terms) -
        searchResultRank(b, normalizedQuery, terms),
    )
    .slice(0, MAX_SEARCH_RESULTS);

  if (!matches.length) {
    const empty = textEl("p", "set-search-empty", "No matching settings");
    results.appendChild(empty);
    return;
  }

  for (const target of matches) {
    const result = document.createElement("button");
    result.type = "button";
    result.className = "set-search-result";
    const label = textEl("span", "set-search-label");
    setHighlightedText(label, target.label, terms);
    const description = textEl("span", "set-search-doc");
    setHighlightedText(description, target.description, terms);
    const breadcrumb = textEl("span", "set-search-context");
    setHighlightedText(breadcrumb, target.breadcrumb, terms);
    result.append(label, description, breadcrumb);

    let termsNotShown = terms.filter((term) => !target.visibleSearchText.includes(term));
    for (const source of target.extraSearchSources) {
      const sourceSearchText = source.text.toLowerCase();
      const showsMissingTerm = termsNotShown.some((term) => sourceSearchText.includes(term));
      if (!showsMissingTerm) continue;
      const matchedSource = textEl("span", "set-search-source");
      matchedSource.appendChild(textEl("span", "set-search-source-kind", source.label));
      const matchedSourceText = textEl("span", "set-search-source-text");
      setHighlightedText(matchedSourceText, source.text, terms);
      matchedSource.appendChild(matchedSourceText);
      result.appendChild(matchedSource);
      termsNotShown = termsNotShown.filter((term) => !sourceSearchText.includes(term));
    }
    result.addEventListener("click", () => {
      selectPage(target.page);
      requestAnimationFrame(() => {
        target.row.scrollIntoView({ block: "center", behavior: "smooth" });
        const control = target.row.querySelector("input, select, textarea, button");
        if (control instanceof HTMLElement) focusControl(control, { preventScroll: true });
        target.row.classList.add("search-hit");
        target.row.addEventListener(
          "animationend",
          () => target.row.classList.remove("search-hit"),
          { once: true },
        );
      });
    });
    results.appendChild(result);
  }
}

function buildRow(/** @type {import("./catalog.js").Knob} */ knob) {
  const row = textEl("div", "set-row");
  if (knob.type === "bool") row.classList.add("set-row-toggle");

  const info = textEl("div", "set-info");
  const label = textEl("span", "set-label", knob.label);
  const doc = textEl("span", "set-doc", knob.doc);
  if (knob.docHref) {
    doc.append(" ");
    const link = document.createElement("a");
    link.className = "set-doc-link";
    link.href = knob.docHref;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = knob.docLinkText || "Learn more";
    doc.append(link);
  }
  info.append(label, doc);
  row.appendChild(info);

  const ctl = textEl("div", "set-ctl");

  /** @type {Entry} */
  const entry = {
    knob,
    overridden: false,
    value: knob.default,
    savedOverridden: false,
    savedValue: knob.default,
    render: () => {},
    row,
  };

  buildKnobControl(ctl, entry);

  row.appendChild(ctl);
  enableRowClick(row);
  entries.push(entry);
  return row;
}

/** Whole row activates the control (label, padding, empty control column).
 *  Skip real controls, Restore, and doc links. */
function enableRowClick(/** @type {HTMLElement} */ row) {
  row.addEventListener("click", (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (t.closest("a, button, input, select, textarea, label")) return;
    activateRowControl(row);
  });
}

function activateRowControl(/** @type {HTMLElement} */ row) {
  const el = row.querySelector(
    "input.set-num, input.set-text, input[type=checkbox], input[type=range], select.set-text",
  );
  if (!(el instanceof HTMLElement)) return;
  if (el instanceof HTMLInputElement && el.type === "checkbox") {
    el.click();
    return;
  }
  focusControl(el);
  if (el instanceof HTMLSelectElement) {
    el.click();
    return;
  }
  if (el instanceof HTMLInputElement && el.type !== "range" && typeof el.select === "function") {
    el.select();
  }
}

/** Build the knob's input control (bool, slider, select, string, or number). */
function buildKnobControl(/** @type {HTMLElement} */ ctl, /** @type {Entry} */ entry) {
  const knob = entry.knob;
  const isSlider =
    (knob.type === "int" || knob.type === "float") && knob.slider === true && knob.max !== undefined;

  const main = textEl("div", "set-ctl-main");
  if (knob.type === "bool") main.classList.add("is-toggle");
  else if (knob.options || knob.type === "string" || isSlider) main.classList.add("is-wide");
  if (isSlider) main.classList.add("is-slider");

  const row = textEl("div", "set-ctl-row");

  if (knob.type === "bool") {
    const input = document.createElement("input");
    input.type = "checkbox";
    row.appendChild(input);
    entry.render = () => {
      input.checked = Boolean(entry.value);
    };
    input.addEventListener("change", () => setKnobValue(entry, input.checked));
  } else if (isSlider) {
    const slider = document.createElement("input");
    slider.type = "range";
    slider.className = "set-slider";
    slider.min = String(knob.min ?? 0);
    slider.max = String(knob.max);
    slider.step = String(knob.step ?? (knob.type === "int" ? 1 : 1));
    initSlider(slider);

    const read = textEl("span", "set-slider-read");
    const suffix = knob.unit ? (knob.unit === "%" ? "%" : " " + knob.unit) : "";
    const renderRead = (/** @type {number} */ value) => (read.textContent = value + suffix);
    const sliderWrap = textEl("div", "set-slider-wrap");
    sliderWrap.append(read, slider);
    row.appendChild(sliderWrap);

    entry.render = () => {
      slider.value = String(entry.value);
      syncSliderFill(slider);
      renderRead(entry.value);
    };
    slider.addEventListener("input", () => {
      const value = Number(slider.value);
      renderRead(value);
      setKnobValue(entry, value);
    });
  } else if (knob.options) {
    const options = knob.options; // capture: the closures below can't re-narrow it
    const CUSTOM = "__custom__";
    const select = document.createElement("select");
    select.className = "set-text";
    for (const opt of options) {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.label;
      select.appendChild(o);
    }
    // A permanent "Custom…" choice that reveals a free-text field for any off-list value
    // (e.g. a voice id pasted from Cartesia's library, or one set over SSH).
    const customOpt = document.createElement("option");
    customOpt.value = CUSTOM;
    customOpt.textContent = "Custom…";
    select.appendChild(customOpt);
    row.appendChild(select);

    const custom = document.createElement("input");
    custom.type = "text";
    custom.className = "set-text";
    custom.placeholder = "Paste a voice ID";
    custom.style.display = "none";

    const isStock = () => options.some((o) => o.value === entry.value);
    entry.render = () => {
      const stock = isStock();
      select.value = stock ? String(entry.value) : CUSTOM;
      custom.value = stock ? "" : String(entry.value);
      custom.style.display = stock ? "none" : "";
    };
    select.addEventListener("change", () => {
      const custable = select.value === CUSTOM;
      custom.style.display = custable ? "" : "none";
      if (custable) {
        // Just reveal the field — don't commit an empty id. The input handler
        // commits once the user actually types one.
        custom.focus();
        return;
      }
      setKnobValue(entry, select.value);
    });
    custom.addEventListener("input", () => {
      // An empty id is never valid (it breaks TTS), so it isn't a real override.
      if (custom.value === "") {
        entry.value = "";
        entry.overridden = false;
        recompute();
      } else {
        setKnobValue(entry, custom.value);
      }
    });
    main.append(row, custom);
  } else if (knob.type === "string") {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "set-text";
    row.appendChild(input);
    entry.render = () => {
      input.value = String(entry.value);
    };
    input.addEventListener("input", () => setKnobValue(entry, input.value));
  } else {
    const wrap = textEl("div", "set-num-wrap");
    const input = document.createElement("input");
    // type=text (not number) so the decimal separator always renders as a dot,
    // regardless of the browser/OS locale; inputmode keeps the mobile numpad.
    input.type = "text";
    input.inputMode = "decimal";
    input.className = "set-num";
    if (knob.min !== undefined && knob.max !== undefined) {
      input.title = `Built-in default ${knob.default}` + (knob.unit ? ` ${knob.unit}` : "") + ` · range ${knob.min}–${knob.max}`;
    }
    wrap.appendChild(input);
    if (knob.unit) {
      const unit = textEl("span", "set-unit", knob.unit);
      wrap.appendChild(unit);
    }
    row.appendChild(wrap);
    wrap.addEventListener("click", (e) => {
      if (e.target !== input) input.focus();
    });
    entry.render = () => {
      input.value = String(entry.value);
    };
    input.addEventListener("input", () => {
      // Tolerate a comma decimal separator from locale-habit typing.
      setKnobValue(entry, Number(input.value.replace(",", ".")));
    });
  }

  if ((knob.type === "int" || knob.type === "float") && !isSlider) {
    const err = textEl("span", "set-err");
    entry.errEl = err;
    main.appendChild(err); // above the field so it doesn't sit under Restore
  }

  if (!knob.options) main.appendChild(row);

  // Toggles omit Restore — flip back to the built-in value clears the override.
  if (knob.type !== "bool") main.appendChild(buildRestoreDefaultButton(entry));

  ctl.appendChild(main);
  entry.render(); // initialise the control from entry.value (the default at build time)
}

async function load() {
  let data;
  try {
    const res = await fetch("/settings.json", { cache: "no-store" });
    data = await res.json();
  } catch {
    setStatus("Couldn't read current settings — showing defaults.", "err");
    return;
  }
  const overrides = (data && data.overrides) || {};
  for (const e of entries) {
    const v = lookup(overrides, e.knob.path);
    if (v === undefined) continue;
    const val = coerceLoaded(e.knob, v);
    e.overridden = e.savedOverridden = true;
    e.value = e.savedValue = val;
    e.render();
  }
  recompute();
  setStatus("");
}

async function savePost(/** @type {any} */ payload) {
  const res = await fetch("/settings.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(payload),
  });
  // The proxy answers {ok, message} for both success and a rejected change (400
  // for a malformed body), so parse and let the caller read res.ok.
  return res.json();
}

/** rcl_interfaces/msg/ParameterType. Only the types the catalog can mark `live`. */
/** @type {Record<string, number>} */
const PARAM_TYPE = { bool: 1, int: 2, float: 3, string: 4 };

/**
 * Push saved knobs to their running node so they take effect without a restart.
 *
 * Only knobs the catalog marks `live` are sent — a node that copied the parameter into a
 * field at construction would accept the write and go on using the old value, and claiming
 * "applied" there would be worse than telling the operator to restart.
 *
 * Cleared knobs are pushed too, at their catalog default: reverting an override has to
 * reach the robot as well, or "reset" would only take effect on the next restart.
 *
 * @param {readonly Readonly<{
 *   overridden: boolean,
 *   value: any,
 *   previousSavedOverridden: boolean,
 *   previousSavedValue: any
 * }>[] } snapshot
 * @returns {Promise<{applied: number, failed: number, restart: number}>}
 */
async function applyLive(snapshot) {
  /** @type {Map<string, {name: string, value: any, type: string}[]>} */
  const byNode = new Map();
  let restart = 0;

  entries.forEach((e, i) => {
    const knob = e.knob;
    const changed =
      snapshot[i].overridden !== snapshot[i].previousSavedOverridden ||
      (snapshot[i].overridden
        && snapshot[i].value !== snapshot[i].previousSavedValue);
    if (!changed) return;
    if (!knob.live) {
      restart++;
      return;
    }
    const type = PARAM_TYPE[knob.type];
    if (!type) {
      restart++;
      return;
    }
    // path is [node, "ros__parameters", ...groups, key]; the ROS name is the dotted tail.
    const name = knob.path.slice(2).join(".");
    const value = snapshot[i].overridden ? snapshot[i].value : knob.default;
    const list = byNode.get(knob.live) || [];
    list.push({ name, value, type: knob.type });
    byNode.set(knob.live, list);
  });

  let applied = 0;
  let failed = 0;
  for (const [node, params] of byNode) {
    try {
      const res = await ros.callService(`${node}/set_parameters`, {
        parameters: params.map((p) => ({
          name: p.name,
          value: {
            type: PARAM_TYPE[p.type],
            bool_value: p.type === "bool" ? Boolean(p.value) : false,
            integer_value: p.type === "int" ? Number(p.value) : 0,
            double_value: p.type === "float" ? Number(p.value) : 0,
            string_value: p.type === "string" ? String(p.value) : "",
          },
        })),
      });
      // The service resolves even when a node rejects a value, so read each result.
      const results = res?.results || [];
      results.forEach((/** @type {{successful?: boolean}} */ r) =>
        (r?.successful === false ? failed++ : applied++));
      if (!results.length) failed += params.length;
    } catch (err) {
      console.warn(`Live-apply to ${node} failed:`, err);
      failed += params.length;
    }
  }
  return { applied, failed, restart };
}

async function onSave() {
  const sets = [];
  const clears = [];
  // Snapshot exactly what we send, keyed by entry index. The success handler
  // stamps saved-state from THIS snapshot, not the live entries — otherwise a
  // field edited during the WS round-trip would be mis-marked as saved while
  // the file holds the older value.
  const snapshot = Object.freeze(entries.map((e) => Object.freeze({
    overridden: e.overridden,
    value: e.value,
    previousSavedOverridden: e.savedOverridden,
    previousSavedValue: e.savedValue,
  })));
  for (const e of entries) {
    if (e.overridden) sets.push({ path: e.knob.path, value: e.value, type: e.knob.type });
    else clears.push(e.knob.path);
  }
  // The TTS voice used to be two per-node params (brain_client_node /
  // input_manager_node cartesia_voice_id) before it became the global `/**` knob.
  // A node-specific param beats a `/**` wildcard in ROS, so any leftover per-node
  // entries silently shadow the picker. The catalog no longer has those paths, so
  // its clears can't reach them — always clear them here so saving heals the orphans.
  for (const node of ["brain_client_node", "input_manager_node"]) {
    clears.push([node, "ros__parameters", "cartesia_voice_id"]);
  }
  saveBtn.disabled = true;
  setStatus("Saving…");
  try {
    const res = await savePost({ sets, clears });
    if (res && res.ok) {
      entries.forEach((e, i) => {
        e.savedOverridden = snapshot[i].overridden;
        e.savedValue = snapshot[i].value;
      });
      recompute();
      const { applied, failed, restart } = await applyLive(snapshot);
      const parts = [];
      if (applied) parts.push(`${applied} applied now`);
      if (restart) parts.push(`${restart} need${restart === 1 ? "s" : ""} a restart`);
      if (failed) parts.push(`${failed} could not be applied live`);
      setStatus(parts.length ? `Saved — ${parts.join(", ")}.` : "Saved.", failed ? "err" : "ok");
    } else {
      setStatus("Save failed: " + ((res && res.message) || "unknown error"), "err");
      recompute();
    }
  } catch (err) {
    setStatus("Save failed: " + (err instanceof Error ? err.message : String(err)), "err");
    recompute();
  }
}

async function onRestart() {
  if (!window.confirm("Restart the robot now? Any running task will stop, and the robot will come back in ~30s with the latest saved settings.")) {
    return;
  }
  restartBtn.disabled = true;
  setStatus("Restarting the robot…");
  try {
    const res = await fetch("/restart", { headers: { "X-Requested-By": "innate-webapp" } });
    if (res.ok) {
      // The proxy is torn down by the restart, so leave the button disabled —
      // the page reconnects on its own once the robot is back.
      setStatus("Restarting — the robot will be back in ~30s.", "ok");
    } else {
      setStatus("Restart failed: " + (await res.text().catch(() => "") || res.status), "err");
      restartBtn.disabled = false;
    }
  } catch (err) {
    setStatus("Couldn't reach the robot to restart: " + (err instanceof Error ? err.message : String(err)), "err");
    restartBtn.disabled = false;
  }
}

/** @param {HTMLElement} stageEl */
export function mount(stageEl) {
  stage = stageEl;
  cleanups = [];
  entries.length = 0;
  pages.length = 0;
  searchTargets.length = 0;
  bodyEl = null;
  build();
  load();
  return {
    destroy() {
      for (const fn of cleanups.splice(0)) fn();
      styleEl?.remove();
      styleEl = null;
      bodyEl = null;
      stage.replaceChildren();
    },
  };
}
