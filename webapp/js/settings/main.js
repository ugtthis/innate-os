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
 * @property {Entry} entry
 * @property {PageUI} page
 * @property {string} context
 * @property {string} haystack
 */
/** @type {SearchTarget[]} */
const searchTargets = [];
/** Page shell; toggles `.is-detail` for the index → detail drill-in. */
/** @type {HTMLElement | null} */
let bodyEl = null;
/** Index search field; cleared when returning from a detail page. */
/** @type {HTMLInputElement | null} */
let searchInput = null;
/** @type {HTMLElement | null} */
let indexCardEl = null;
/** @type {HTMLElement | null} */
let searchResultsEl = null;

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

/** Short built-in value for the restore link / tooltip. */
function defaultShort(/** @type {import("./catalog.js").Knob} */ knob) {
  if (knob.type === "bool") return knob.default ? "on" : "off";
  if (knob.options) {
    const opt = knob.options.find((o) => o.value === knob.default);
    if (opt) return opt.label;
  }
  return String(knob.default) + (knob.unit ? " " + knob.unit : "");
}

/** Build the on-release "Restore default" action under a control. */
function buildRestoreButton(/** @type {import("./catalog.js").Knob} */ knob, /** @type {() => void} */ onReset) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "set-restore";
  btn.dataset.activate = "release";
  btn.textContent = "Restore default";
  const tip = "Restore built-in default (" + defaultShort(knob) + ")";
  btn.title = tip;
  btn.setAttribute("aria-label", tip);
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    onReset();
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

/** True when the form value matches the built-in default (restore would be a no-op). */
function isAtDefault(/** @type {Entry} */ e) {
  return e.value === e.knob.default;
}

/** Mark overridden from the current value — at default means no override. */
function setOverrideFromValue(/** @type {Entry} */ e) {
  e.overridden = !isAtDefault(e);
}

/** Commit a scalar control edit and refresh derived row/footer state. */
function editScalar(/** @type {Entry} */ entry, /** @type {*} */ value) {
  entry.value = value;
  setOverrideFromValue(entry);
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
    e.row.classList.toggle("off-default", !isAtDefault(e));
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

/**
 * Live speaker-volume control. Unlike the yaml knobs below, this is a rosbridge
 * service call that applies immediately and persists on the robot — no restart.
 * The slider is the raw volume_percent (0–100): it reads the current value from
 * /robot/info and writes via /set_volume on release. The robot lifts the low end
 * of the range so the bottom of the slider stays audible (see apply_alsa_volume).
 */
function buildVolumeSection() {
  const section = document.createElement("section");
  section.className = "set-live";

  const row = document.createElement("div");
  row.className = "set-row";

  const info = document.createElement("div");
  info.className = "set-info";
  const label = document.createElement("span");
  label.className = "set-label";
  label.textContent = "Speaker volume";
  const doc = document.createElement("span");
  doc.className = "set-doc";
  doc.textContent = "The robot's voice volume. Applies immediately — no restart.";
  info.append(label, doc);
  row.appendChild(info);

  const ctl = document.createElement("div");
  ctl.className = "set-ctl";

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
  ctl.appendChild(slider);

  const read = document.createElement("span");
  read.className = "set-slider-read";
  const cur = document.createElement("span");
  cur.textContent = "—"; // nothing until /robot/info reports the live volume
  const mx = document.createElement("span");
  mx.className = "mx";
  mx.textContent = "";
  read.append(cur, mx);
  ctl.appendChild(read);

  const status = document.createElement("span");
  status.className = "set-live-status set-status muted";
  ctl.appendChild(status);

  row.appendChild(ctl);
  section.appendChild(row);

  // Last percent known to be applied on the robot; the revert target on failure.
  let robotPercent = DEFAULT_VOLUME;
  let hasValue = false; // false until /robot/info reports the live volume
  let dragging = false;
  let saving = false;

  const setLiveStatus = (/** @type {string} */ msg, /** @type {string} */ cls) => {
    status.textContent = msg;
    status.className = "set-live-status set-status " + cls;
  };

  const renderValue = (/** @type {number} */ percent) => {
    slider.value = String(percent);
    cur.textContent = String(percent);
    mx.textContent = " / 100";
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
    cur.textContent = slider.value;
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

  return section;
}

const INDEX_CHEV =
  '<svg class="set-index-chev" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9,6 15,12 9,18"/></svg>';

/** Open a destination's detail pane (Linear drill-in). */
function selectPage(/** @type {PageUI} */ ui) {
  for (const page of pages) {
    const on = page === ui;
    page.panel.classList.toggle("active", on);
    if (on) page.row.setAttribute("aria-current", "page");
    else page.row.removeAttribute("aria-current");
  }
  bodyEl?.classList.add("is-detail");
}

/** Clear search so returning to Preferences shows the destination index again. */
function clearSearch() {
  if (!searchInput || !indexCardEl || !searchResultsEl) return;
  if (!searchInput.value) return;
  searchInput.value = "";
  renderSearchResults("", indexCardEl, searchResultsEl);
}

/** Return to the clustered index. */
function showIndex() {
  clearSearch();
  bodyEl?.classList.remove("is-detail");
  for (const page of pages) {
    page.panel.classList.remove("active");
    page.row.removeAttribute("aria-current");
  }
}

function build() {
  styleEl = document.createElement("style");
  styleEl.textContent = SETTINGS_STYLE;
  document.head.appendChild(styleEl);

  const page = document.createElement("div");
  page.className = "settings-page";

  const body = document.createElement("div");
  body.className = "settings-body";
  bodyEl = body;

  const scroll = document.createElement("div");
  scroll.className = "settings-scroll";

  const wrap = document.createElement("div");
  wrap.className = "settings-wrap";

  // —— Index: six task-oriented destinations + direct knob search ——
  const index = document.createElement("div");
  index.className = "set-index";

  const indexTitle = document.createElement("h1");
  indexTitle.className = "page-title";
  indexTitle.textContent = "Preferences";
  index.appendChild(indexTitle);

  const indexNote = document.createElement("p");
  indexNote.className = "settings-note";
  indexNote.textContent = "Tune how the robot drives, sees, and talks. Changes save to settings.yaml.";
  index.appendChild(indexNote);

  const search = document.createElement("input");
  search.type = "search";
  search.className = "set-search";
  search.placeholder = "Search settings";
  search.setAttribute("aria-label", "Search settings");
  searchInput = search;
  index.appendChild(search);

  const indexCard = document.createElement("div");
  indexCard.className = "set-index-card";
  indexCardEl = indexCard;
  index.appendChild(indexCard);

  const searchResults = document.createElement("div");
  searchResults.className = "set-search-results";
  searchResults.hidden = true;
  searchResultsEl = searchResults;
  index.appendChild(searchResults);

  // —— Detail: back + one active pane ——
  const detail = document.createElement("div");
  detail.className = "set-detail";

  const back = document.createElement("button");
  back.type = "button";
  back.className = "set-back";
  back.innerHTML =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15,6 9,12 15,18"/></svg><span>Preferences</span>';
  back.addEventListener("click", showIndex);
  detail.appendChild(back);

  for (const settingsPage of SETTINGS_PAGES) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "set-index-row";

    const icon = document.createElement("span");
    icon.className = "set-index-icon";
    icon.style.setProperty(
      "--icon-url",
      `url("/js/settings/icons/${settingsPage.icon}")`,
    );

    const text = document.createElement("span");
    text.className = "set-index-text";
    const label = document.createElement("span");
    label.className = "set-index-label";
    label.textContent = settingsPage.section;
    const summary = document.createElement("span");
    summary.className = "set-index-summary";
    summary.textContent = settingsPage.summary;
    text.append(label, summary);

    const dot = document.createElement("span");
    dot.className = "set-index-dot";
    dot.title = "Unsaved changes in this section";

    row.append(icon, text, dot);
    row.insertAdjacentHTML("beforeend", INDEX_CHEV);
    indexCard.appendChild(row);

    const panel = document.createElement("section");
    panel.className = "set-pane";
    panel.setAttribute("aria-label", settingsPage.section);

    const title = document.createElement("h1");
    title.className = "page-title";
    title.textContent = settingsPage.section;
    panel.appendChild(title);

    if (settingsPage.note) {
      const gn = document.createElement("p");
      gn.className = "settings-note";
      gn.textContent = settingsPage.note;
      panel.appendChild(gn);
    }

    if (settingsPage.id === "voice") {
      const speaker = document.createElement("section");
      speaker.className = "set-page-section";
      const speakerTitle = document.createElement("h2");
      speakerTitle.className = "set-section-title";
      speakerTitle.textContent = "Speaker";
      speaker.append(speakerTitle, buildVolumeSection());
      panel.appendChild(speaker);
    }

    const pageStart = entries.length;
    /** @type {{section: import("./catalog.js").PageSection, entries: Entry[]}[]} */
    const pageSections = [];
    for (const pageSection of settingsPage.sections) {
      const sectionStart = entries.length;
      panel.appendChild(buildPageSection(pageSection));
      pageSections.push({ section: pageSection, entries: entries.slice(sectionStart) });
    }
    detail.appendChild(panel);

    /** @type {PageUI} */
    const ui = { panel, row, dot, entries: entries.slice(pageStart) };
    row.addEventListener("click", () => selectPage(ui));
    pages.push(ui);

    for (const sectionUI of pageSections) {
      for (const entry of sectionUI.entries) {
        const context = `${settingsPage.section} · ${sectionUI.section.title}`;
        searchTargets.push({
          entry,
          page: ui,
          context,
          haystack: [
            settingsPage.section,
            settingsPage.summary,
            sectionUI.section.title,
            sectionUI.section.note || "",
            entry.knob.label,
            entry.knob.doc,
          ].join(" ").toLowerCase(),
        });
      }
    }
  }

  search.addEventListener("input", () => renderSearchResults(search.value, indexCard, searchResults));

  wrap.append(index, detail);
  scroll.appendChild(wrap);
  body.appendChild(scroll);
  page.appendChild(body);

  const bar = document.createElement("div");
  bar.className = "set-bar";
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

/**
 * Linear-style flat section: heading + optional note + preference card.
 * @param {import("./catalog.js").PageSection} pageSection
 */
function buildPageSection(pageSection) {
  const section = document.createElement("section");
  section.className = "set-page-section";
  const title = document.createElement("h2");
  title.className = "set-section-title";
  title.textContent = pageSection.title;
  section.appendChild(title);
  if (pageSection.note) {
    const note = document.createElement("p");
    note.className = "set-section-note";
    note.textContent = pageSection.note;
    section.appendChild(note);
  }
  section.appendChild(buildGroupCard(pageSection.knobs));
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
  if (!pattern) {
    el.textContent = text;
    return;
  }
  const re = new RegExp(pattern, "gi");
  let last = 0;
  for (const match of text.matchAll(re)) {
    const start = match.index ?? 0;
    if (start > last) el.append(text.slice(last, start));
    const mark = document.createElement("mark");
    mark.className = "set-search-mark";
    mark.textContent = match[0];
    el.append(mark);
    last = start + match[0].length;
  }
  if (last < text.length) el.append(text.slice(last));
  if (!el.childNodes.length) el.textContent = text;
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
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const searching = terms.length > 0;
  indexCard.hidden = searching;
  results.hidden = !searching;
  results.replaceChildren();
  if (!searching) return;

  const matches = searchTargets
    .filter((target) => terms.every((term) => target.haystack.includes(term)))
    .slice(0, 20);

  if (!matches.length) {
    const empty = document.createElement("p");
    empty.className = "set-search-empty";
    empty.textContent = "No matching settings";
    results.appendChild(empty);
    return;
  }

  for (const target of matches) {
    const result = document.createElement("button");
    result.type = "button";
    result.className = "set-search-result";
    const label = document.createElement("span");
    label.className = "set-search-label";
    setHighlightedText(label, target.entry.knob.label, terms);
    const context = document.createElement("span");
    context.className = "set-search-context";
    setHighlightedText(context, target.context, terms);
    result.append(label, context);
    result.addEventListener("click", () => {
      selectPage(target.page);
      requestAnimationFrame(() => {
        target.entry.row.scrollIntoView({ block: "center", behavior: "smooth" });
        const control = target.entry.row.querySelector("input, select, textarea, button");
        if (control instanceof HTMLElement) control.focus({ preventScroll: true });
        target.entry.row.classList.add("search-hit");
        target.entry.row.addEventListener(
          "animationend",
          () => target.entry.row.classList.remove("search-hit"),
          { once: true },
        );
      });
    });
    results.appendChild(result);
  }
}

/**
 * Cluster consecutive knobs that share a `subsection` label so the expanded
 * card can render Midday/iOS-style subheads without nesting the catalog.
 * @param {import("./catalog.js").Knob[]} knobs
 * @returns {{ title: string | null, knobs: import("./catalog.js").Knob[] }[]}
 */
function clusterBySubsection(knobs) {
  /** @type {{ title: string | null, knobs: import("./catalog.js").Knob[] }[]} */
  const clusters = [];
  for (const knob of knobs) {
    const title = knob.subsection || null;
    const last = clusters[clusters.length - 1];
    if (last && last.title === title) last.knobs.push(knob);
    else clusters.push({ title, knobs: [knob] });
  }
  return clusters;
}

/** One bordered card for an expanded section; optional subsection blocks inside. */
function buildGroupCard(/** @type {import("./catalog.js").Knob[]} */ knobs) {
  const card = document.createElement("div");
  card.className = "set-card";
  const clusters = clusterBySubsection(knobs);
  const useSubheads = clusters.filter((c) => c.title).length > 1;

  for (const cluster of clusters) {
    /** @type {HTMLElement} */
    let host = card;
    if (useSubheads) {
      const block = document.createElement("div");
      block.className = "set-subblock";
      if (cluster.title) {
        const subh = document.createElement("div");
        subh.className = "set-subh";
        subh.textContent = cluster.title;
        block.appendChild(subh);
      }
      card.appendChild(block);
      host = block;
    }
    for (const knob of cluster.knobs) host.appendChild(buildRow(knob));
  }
  return card;
}

function buildRow(/** @type {import("./catalog.js").Knob} */ knob) {
  const row = document.createElement("div");
  row.className = "set-row";
  if (knob.type === "bool") row.classList.add("set-row-toggle");

  const info = document.createElement("div");
  info.className = "set-info";
  const label = document.createElement("span");
  label.className = "set-label";
  label.textContent = knob.label;
  const doc = document.createElement("span");
  doc.className = "set-doc";
  doc.textContent = knob.doc;
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

  const ctl = document.createElement("div");
  ctl.className = "set-ctl";

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

  buildScalarControl(ctl, entry);

  row.appendChild(ctl);
  // Whole row activates the control (label, padding, empty control column).
  // Skip real controls, Restore, and doc links.
  row.addEventListener("click", (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (t.closest("a, button, input, select, textarea, label")) return;
    activateRowControl(row);
  });
  entries.push(entry);
  return row;
}

/** Focus / open / toggle the primary control in a settings row. */
function activateRowControl(/** @type {HTMLElement} */ row) {
  const el = row.querySelector(
    "input.set-num, input.set-text, input[type=checkbox], input[type=range], select.set-text",
  );
  if (!(el instanceof HTMLElement)) return;
  if (el instanceof HTMLInputElement && el.type === "checkbox") {
    el.click();
    return;
  }
  el.focus();
  if (el instanceof HTMLSelectElement) {
    el.click();
    return;
  }
  if (el instanceof HTMLInputElement && el.type !== "range" && typeof el.select === "function") {
    el.select();
  }
}

/** Checkbox / slider / text / number control (bool, bounded numeric, string, number). */
function buildScalarControl(/** @type {HTMLElement} */ ctl, /** @type {Entry} */ entry) {
  const knob = entry.knob;
  const isSlider =
    (knob.type === "int" || knob.type === "float") && knob.slider === true && knob.max !== undefined;

  const main = document.createElement("div");
  main.className = "set-ctl-main";
  if (knob.type === "bool") main.classList.add("is-toggle");
  else if (knob.options || knob.type === "string" || isSlider) main.classList.add("is-wide");

  const row = document.createElement("div");
  row.className = "set-ctl-row";

  if (knob.type === "bool") {
    const input = document.createElement("input");
    input.type = "checkbox";
    row.appendChild(input);
    entry.render = () => {
      input.checked = Boolean(entry.value);
    };
    input.addEventListener("change", () => editScalar(entry, input.checked));
  } else if (isSlider) {
    const slider = document.createElement("input");
    slider.type = "range";
    slider.className = "set-slider";
    slider.min = String(knob.min ?? 0);
    slider.max = String(knob.max);
    slider.step = String(knob.step ?? (knob.type === "int" ? 1 : 1));
    row.appendChild(slider);

    // "<value> / <max>" — the max is always shown so the ceiling is obvious.
    const read = document.createElement("span");
    read.className = "set-slider-read";
    const cur = document.createElement("span");
    const mx = document.createElement("span");
    mx.className = "mx";
    mx.textContent = " / " + knob.max;
    read.append(cur, mx);
    row.appendChild(read);
    if (knob.unit) {
      const unit = document.createElement("span");
      unit.className = "set-unit";
      unit.textContent = knob.unit;
      row.appendChild(unit);
    }

    entry.render = () => {
      slider.value = String(entry.value);
      cur.textContent = String(entry.value);
    };
    slider.addEventListener("input", () => {
      const value = Number(slider.value);
      cur.textContent = String(value);
      editScalar(entry, value);
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
      editScalar(entry, select.value);
    });
    custom.addEventListener("input", () => {
      // An empty id is never valid (it breaks TTS), so it isn't a real override.
      if (custom.value === "") {
        entry.value = "";
        entry.overridden = false;
        recompute();
      } else {
        editScalar(entry, custom.value);
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
    input.addEventListener("input", () => editScalar(entry, input.value));
  } else {
    // Number field: value + unit share one bordered shell (unit as in-field suffix).
    const wrap = document.createElement("div");
    wrap.className = "set-num-wrap";
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
      const unit = document.createElement("span");
      unit.className = "set-unit";
      unit.textContent = knob.unit;
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
      editScalar(entry, Number(input.value.replace(",", ".")));
    });
  }

  if ((knob.type === "int" || knob.type === "float") && !isSlider && (knob.min !== undefined || knob.max !== undefined)) {
    const err = document.createElement("span");
    err.className = "set-err";
    entry.errEl = err;
    main.appendChild(err); // above the field so it doesn't sit under Restore
  }

  if (!knob.options) main.appendChild(row);

  // Toggles omit Restore — flip back to the built-in value clears the override.
  if (knob.type !== "bool") {
    main.appendChild(
      buildRestoreButton(knob, () => {
        entry.overridden = false;
        entry.value = knob.default;
        entry.render();
        recompute();
      }),
    );
  }

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
  searchInput = null;
  indexCardEl = null;
  searchResultsEl = null;
  build();
  load();
  return {
    destroy() {
      for (const fn of cleanups.splice(0)) fn();
      styleEl?.remove();
      styleEl = null;
      bodyEl = null;
      searchInput = null;
      indexCardEl = null;
      searchResultsEl = null;
      stage.replaceChildren();
    },
  };
}
