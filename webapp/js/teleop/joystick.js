// @ts-check
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Innate Inc
// On-screen joystick. HTML glass pad + knob over a larger pointer surface.
// Latch only — DriveController owns the /joystick heartbeat.
//
// Chrome vars on the overlay (eased −1..1 / 0..1):
//   --joystick-throw    magnitude
//   --joystick-strafe   +right / −left
//   --joystick-forward  +forward / −backward
// Display size is CSS-only (--joystick-hit-size / --joystick-pad-size).

// Geometry: pad r=92, knob r=34 (CSS pad*34/92). Hit margin is CSS-only.
const PAD_RADIUS = 92; // knob center reaches the rim at full throw
const PAD_SIZE = PAD_RADIUS * 2;
const TOGGLE_KEY = "KeyJ";

/** @param {number} t */
function easeThrow(t) {
  return t ** 0.65;
}

/** @param {number} v */
function easedAxis(v) {
  return Math.sign(v) * easeThrow(Math.abs(v) / PAD_RADIUS);
}

/**
 * @param {HTMLElement} parent
 * @param {import("../driveController.js").DriveController} driveController
 * @returns {{ destroy: () => void }}
 */
export function createJoystick(parent, driveController) {
  const pad = document.createElement("div");
  pad.className = "joystick-pad";
  for (const direction of ["forward", "backward", "right", "left"]) {
    const marker = document.createElement("span");
    marker.className = `joystick-direction joystick-direction-${direction}`;
    pad.appendChild(marker);
  }

  const knob = document.createElement("div");
  knob.className = "joystick-knob";

  const hitTarget = document.createElement("div");
  hitTarget.className = "joystick-hit-target";
  hitTarget.setAttribute("role", "application");
  hitTarget.setAttribute("aria-label", "Drive joystick");
  hitTarget.title = "drag to drive — /joystick · press j to hide";
  // Siblings so each backdrop-filter samples the camera, not the other glass.
  hitTarget.append(pad, knob);

  let pointerEngaged = false;

  /** @param {number} dx @param {number} dy */
  function clampToPad(dx, dy) {
    const dist = Math.hypot(dx, dy);
    const t = Math.min(1, dist / PAD_RADIUS);
    if (dist > PAD_RADIUS) {
      const s = PAD_RADIUS / dist;
      dx *= s;
      dy *= s;
    }
    return { dx, dy, t };
  }

  /** @param {number} dx @param {number} dy screen-frame pad units */
  function setKnob(dx, dy) {
    const p = clampToPad(dx, dy);
    const throwAmt = easeThrow(p.t);
    parent.style.setProperty("--joystick-throw", String(throwAmt));
    parent.style.setProperty("--joystick-strafe", String(easedAxis(p.dx)));
    parent.style.setProperty("--joystick-forward", String(easedAxis(-p.dy))); // screen-up → forward
    // Scale from the visible pad — hit target may be larger and bottom-aligned.
    const toCss = (pad.clientWidth || PAD_SIZE) / PAD_SIZE;
    knob.style.transform =
      `translate(${p.dx * toCss}px, ${p.dy * toCss}px) scale(${1 + throwAmt * 0.05})`;
    return p;
  }

  /** @param {PointerEvent} e */
  function pointerOffset(e) {
    const rect = pad.getBoundingClientRect();
    const toPad = PAD_SIZE / rect.width;
    return {
      dx: (e.clientX - rect.left - rect.width / 2) * toPad,
      dy: (e.clientY - rect.top - rect.height / 2) * toPad,
    };
  }

  /** @param {PointerEvent} e */
  function update(e) {
    const { dx, dy } = pointerOffset(e);
    const p = setKnob(dx, dy);
    driveController.setInput("joystick", p.dx / PAD_RADIUS, -p.dy / PAD_RADIUS, true);
  }

  /** @param {PointerEvent} e */
  function onPointerDown(e) {
    if (pointerEngaged) return;
    pointerEngaged = true;
    try {
      hitTarget.setPointerCapture(e.pointerId);
    } catch {
      // synthetic/stale pointers
    }
    hitTarget.classList.add("engaged");
    update(e);
  }

  /** @param {PointerEvent} e */
  function onPointerMove(e) {
    if (pointerEngaged) update(e);
  }

  function release() {
    if (!pointerEngaged) return;
    pointerEngaged = false;
    hitTarget.classList.remove("engaged");
    setKnob(0, 0);
    driveController.setInput("joystick", 0, 0, false);
  }

  hitTarget.addEventListener("pointerdown", onPointerDown);
  hitTarget.addEventListener("pointermove", onPointerMove);
  hitTarget.addEventListener("pointerup", release);
  hitTarget.addEventListener("pointercancel", release);
  hitTarget.addEventListener("lostpointercapture", release);

  let hidden = false;
  function toggleHidden() {
    hidden = !hidden;
    if (hidden) release();
    hitTarget.hidden = hidden;
  }

  /** @param {KeyboardEvent} e */
  function onKeyDown(e) {
    if (e.code !== TOGGLE_KEY || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    const el = document.activeElement;
    if (el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
      return;
    }
    toggleHidden();
  }
  window.addEventListener("keydown", onKeyDown);

  const unsubActive = driveController.onActiveChange((state) => {
    if (pointerEngaged) return;
    const mirroring = state.source === "keyboard";
    hitTarget.classList.toggle("mirroring", mirroring);
    if (mirroring) setKnob(state.x * PAD_RADIUS, -state.y * PAD_RADIUS);
    else if (state.source === null) setKnob(0, 0);
  });

  parent.appendChild(hitTarget);

  return {
    destroy() {
      release();
      window.removeEventListener("keydown", onKeyDown);
      unsubActive();
      hitTarget.remove();
      parent.style.removeProperty("--joystick-throw");
      parent.style.removeProperty("--joystick-strafe");
      parent.style.removeProperty("--joystick-forward");
    },
  };
}
