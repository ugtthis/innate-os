// @ts-check
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Innate Inc
// Operator-facing Settings tree: destinations → sections → knobs. Each knob's
// `path` is the full ROS param path in settings.yaml (node, then
// ros__parameters, then nested groups, then the key). The proxy edits
// settings.yaml surgically by this path, so the file stays a hand-editable
// overlay (uncomment a stanza over SSH still works).
//
// Curated subset. The `default` values below are the values the robot actually
// LAUNCHES with — verified against each node's loaded config, NOT just its own
// declare_parameter() fallback (which the launch layer overrides). Authoritative
// sources: the launch-file parameter blocks (brain_client.launch.py,
// input_manager.launch.py, navigation.launch.py, main_camera_driver.launch.py)
// and the config YAMLs they load (manipulation_server.yaml, innate_uninavid
// params.yaml), with robot_config.yaml / motion_control.yaml / arm_config.yaml /
// velocity_smoother.yaml for the original knobs. These can diverge from a node's
// code default AND from settings.yaml.template's comments (e.g. the launch sets
// vertical_fov=80, send_depth=false, log_everything=true — overriding config.py;
// both nodes' TTS voice default to the same env-backed id; temporal_ensemble_coeff
// is 0.0 and consecutive_stops_to_complete is 30 per the loaded YAMLs).
//
// Add a knob under the destination section where operators should find it. The
// renderer picks the control from type metadata. `inflation_layer` is
// intentionally omitted — its default differs per costmap (0.25/0.3/0.35), so
// there's no honest single default to show.

/**
 * @typedef {Object} Knob
 * @property {string[]} path  Full ROS param path in settings.yaml.
 * @property {string} label
 * @property {number|boolean|string} default
 * @property {"float"|"int"|"bool"|"string"} type
 * @property {string} [unit]
 * @property {string} doc
 * @property {string} [docHref]      Optional URL rendered as a link after the doc text.
 * @property {string} [docLinkText]  Label for the docHref link (defaults to "Learn more").
 * @property {number} [min]  Lowest accepted value. Rejected on save, not silently clamped.
 * @property {number} [max]  Highest accepted value. Likewise.
 * @property {boolean} [slider]  Render as a slider rather than a number field. Needs min+max.
 *   Left off where an exact value matters more than seeing the ceiling — the drive-feel
 *   knobs are tuned to figures like 0.35 that a stepped slider cannot hit.
 * @property {number} [step] Slider step (defaults to 1).
 * @property {{value: string, label: string}[]} [options]  For a string knob: render a
 *   <select> of these choices instead of a free-text field.
 * @property {string} [live]  Node to push this knob to with set_parameters after saving,
 *   so it applies without a restart. Set ONLY where the running node re-reads the
 *   parameter (mars_app reads its drive knobs every tick). Nodes that copy a parameter
 *   into a field at construction — bringup's safety clamp, the camera driver, nav2's
 *   launch-time remap — must be left off, or the UI would claim an effect it did not have.
 * @property {string} [subsection]  Optional label grouping related knobs inside a
 *   section card (e.g. "Linear" / "Angular"). Consecutive knobs with the same
 *   subsection render under one subhead.
 */

/**
 * @typedef {Object} PageSection
 * @property {string} title  Section h2.
 * @property {string} [note]  Text above the section card.
 * @property {Knob[]} knobs
 */

/**
 * @typedef {Object} SettingsPage
 * @property {string} icon  Filename under /js/settings/icons/.
 * @property {string} title  Index label and page h1.
 * @property {string} summary  Index subtitle.
 * @property {string} [note]  Page introduction under the h1.
 * @property {boolean} [hasSpeakerVolume]  Inject the live speaker-volume control.
 * @property {PageSection[]} sections
 */

const P = "ros__parameters";

// A few Cartesia stock voices for the TTS picker (ids from the Cartesia voice library).
// "Alfred" is the env-backed launch default; the rest are stock Sonic voices. Any other id
// set over SSH still works and shows as a "Custom" option in the dropdown.
const VOICE_OPTIONS = [
  { value: "9fdaae0b-f885-4813-b589-3c07cf9d5fea", label: "Alfred" },
  { value: "79a125e8-cd45-4c13-8a67-188112f4dd22", label: "British Lady" },
  { value: "00a77add-48d5-4ef6-8157-71e5437b282d", label: "Calm Lady" },
  { value: "b7d50908-b17c-442d-ad8d-810c63997ed9", label: "California Girl" },
  { value: "d46abd1d-2d02-43e8-819f-51fb652c1c61", label: "Newsman" },
  { value: "79f8b5fb-2cc8-479a-80df-29f7a7cf1a3e", label: "Nonfiction Man" },
];

/** @type {SettingsPage[]} */
export const SETTINGS_PAGES = [
  {
    hasSpeakerVolume: true,
    icon: "volume.svg",
    title: "Voice",
    summary: "Speaker volume and robot voice",
    note: "Adjust how loud the robot speaks and choose its voice.",
    sections: [
      {
        title: "Robot voice",
        note: "The TTS voice drives both chat-TTS and realtime voice.",
        knobs: [
          { path: ["/**", P, "cartesia_voice_id"], label: "TTS voice", default: "9fdaae0b-f885-4813-b589-3c07cf9d5fea", type: "string", doc: "Cartesia TTS voice (drives both chat-TTS and realtime-voice). Pick a stock voice, or paste any voice ID from Cartesia's library of hundreds.", docHref: "https://play.cartesia.ai/voices", docLinkText: "Browse Cartesia voices ↗", options: VOICE_OPTIONS },
        ],
      },
    ],
  },
  {
    icon: "joystick.svg",
    title: "Driving",
    summary: "Speed, handling, and manual controls",
    note: "Tune manual and autonomous motion. Speed limits first; handling and heading hold further down.",
    sections: [
      {
        title: "Speed limits",
        note: "Manual (teleop) and autonomous (nav) are capped independently. Neither is the hard ceiling — the safety clamp below is.",
        knobs: [
          { path: ["/**", P, "motion_control", "max_speed"], label: "Manual max speed", default: 0.4, type: "float", unit: "m/s", doc: "Top translational speed for teleop / manual driving", min: 0.05, max: 2, live: "/mars_app", subsection: "Manual" },
          { path: ["/**", P, "motion_control", "max_angular_speed"], label: "Manual max turn", default: 1, type: "float", unit: "rad/s", doc: "Top rotational speed for teleop / manual driving", min: 0.05, max: 5, live: "/mars_app", subsection: "Manual" },
          { path: ["/**", P, "nav", "max_speed"], label: "Autonomous max speed", default: 0.45, type: "float", unit: "m/s", doc: "Top translational speed for autonomous nav2", min: 0.05, max: 2, subsection: "Autonomous" },
          { path: ["/**", P, "nav", "max_angular_speed"], label: "Autonomous max turn", default: 0.6, type: "float", unit: "rad/s", doc: "Top rotational speed for autonomous nav2", min: 0.05, max: 5, subsection: "Autonomous" },
        ],
      },
      {
        title: "Manual controls",
        knobs: [
          { path: ["joystick_controller", P, "joystick", "slow_mode_factor"], label: "Slow-mode factor", default: 0.25, type: "float", doc: "Speed multiplier while the slow-mode button is held" },
        ],
      },
      {
        title: "Handling",
        note: "How quickly the robot approaches the caps above — app / webapp joystick only; the USB gamepad has its own smoother. All apply immediately except the tick rate. The jerk limits are derived from these, so there is nothing to keep consistent by hand.",
        knobs: [
          { path: ["mars_app", P, "motion_control", "max_acceleration"], label: "Linear acceleration", default: 0.2, type: "float", unit: "m/s²", doc: "How hard it speeds up", min: 0.05, max: 5, live: "/mars_app", subsection: "Linear" },
          { path: ["mars_app", P, "motion_control", "max_deceleration"], label: "Linear deceleration", default: 1.2, type: "float", unit: "m/s²", doc: "How hard it slows down; keep above acceleration so stopping stays responsive", min: 0.05, max: 10, live: "/mars_app", subsection: "Linear" },
          { path: ["mars_app", P, "motion_control", "speed_time_constant"], label: "Linear smoothing lag", default: 0.4, type: "float", unit: "s", doc: "First-order lag on speed; higher is softer with a longer tail", min: 0.02, max: 2, live: "/mars_app", subsection: "Linear" },
          { path: ["mars_app", P, "motion_control", "max_angular_acceleration"], label: "Angular acceleration", default: 2, type: "float", unit: "rad/s²", doc: "How hard it starts turning", min: 0.05, max: 20, live: "/mars_app", subsection: "Angular" },
          { path: ["mars_app", P, "motion_control", "max_angular_deceleration"], label: "Angular deceleration", default: 6, type: "float", unit: "rad/s²", doc: "How hard it stops turning. A slow yaw ramp keeps turning after you stop asking", min: 0.05, max: 30, live: "/mars_app", subsection: "Angular" },
          { path: ["mars_app", P, "motion_control", "angular_speed_time_constant"], label: "Angular smoothing lag", default: 0.1, type: "float", unit: "s", doc: "First-order lag on yaw, separate so turning can be tightened without changing straight-line feel", min: 0.02, max: 2, live: "/mars_app", subsection: "Angular" },
          { path: ["mars_app", P, "motion_control", "settle_epsilon"], label: "Stop threshold", default: 0.01, type: "float", unit: "m/s", doc: "Snap straight to zero below this instead of easing down. A hardware floor: the motors are commanded in whole units of 0.01, so anything finer is motion they cannot express, and lingering there makes their speed loop hunt", min: 0.01, max: 0.5, live: "/mars_app", subsection: "Stopping" },
          { path: ["mars_app", P, "motion_control", "input_timeout"], label: "Input timeout", default: 0.4, type: "float", unit: "s", doc: "Silence from the controller before ramping to a stop. Capped at the cmd_vel mux's 0.5 s teleop window — beyond that a dropped link keeps the robot moving on the last command", min: 0.05, max: 0.5, slider: true, step: 0.05, live: "/mars_app", subsection: "Stopping" },
          { path: ["mars_app", P, "motion_control", "dt"], label: "Smoother tick", default: 0.02, type: "float", unit: "s", doc: "Control period (0.02 = 50 Hz). Fixes the timer, so this one needs a restart", subsection: "Stopping" },
        ],
      },
      {
        title: "Heading hold",
        note: "Resists being turned off-course while driving straight. Does not restore heading lost earlier — you correct your own overshoot.",
        knobs: [
          { path: ["mars_app", P, "heading_hold", "gain"], label: "Gain", default: 5, type: "float", doc: "Correction per unit of heading error. 0 disables the loop", live: "/mars_app", subsection: "Correction" },
          { path: ["mars_app", P, "heading_hold", "leak"], label: "Memory", default: 0.2, type: "float", unit: "s", doc: "How long it remembers a heading. Longer rejects drift better but takes longer to forget; 0 makes it an absolute heading lock", live: "/mars_app", subsection: "Correction" },
          { path: ["mars_app", P, "heading_hold", "max_correction"], label: "Correction ceiling", default: 1, type: "float", unit: "rad/s", doc: "Most it may steer on its own", live: "/mars_app", subsection: "Correction" },
          { path: ["mars_app", P, "heading_hold", "min_speed"], label: "Engage above", default: 0.01, type: "float", unit: "m/s", doc: "Stays off below this speed — heading means little while creeping. A gentle acceleration limit means you cross it later, leaving longer uncorrected at the start of a move", live: "/mars_app", subsection: "Engagement" },
          { path: ["mars_app", P, "heading_hold", "straight_yaw"], label: "Straight threshold", default: 0.05, type: "float", unit: "rad/s", doc: "Requested turn rate below which you count as driving straight; above it the hold releases immediately", live: "/mars_app", subsection: "Engagement" },
          { path: ["mars_app", P, "heading_hold", "deadband"], label: "Error deadband", default: 0.01, type: "float", unit: "rad", doc: "Heading error to ignore. One unit of the robot's heading resolution, so below this the loop would chatter", live: "/mars_app", subsection: "Engagement" },
          { path: ["mars_app", P, "heading_hold", "slew"], label: "Engage rate", default: 2, type: "float", unit: "rad/s²", doc: "How fast the correction itself may change, so engaging and dropping out are not steps", live: "/mars_app", subsection: "Engagement" },
        ],
      },
      {
        title: "Mad Mars mode",
        note: "Mad Mars is the one speed mode whose accelerations are stated outright rather than scaled from the values above — it wants more linear and less angular than a single multiplier can give.",
        knobs: [
          { path: ["mars_app", P, "mad", "max_acceleration"], label: "Linear acceleration", default: 2, type: "float", unit: "m/s²", doc: "Replaces the scaled acceleration while Mad Mars is selected", min: 0.05, max: 5, live: "/mars_app" },
          { path: ["mars_app", P, "mad", "max_angular_acceleration"], label: "Angular acceleration", default: 3, type: "float", unit: "rad/s²", doc: "Replaces the scaled turn-in rate while Mad Mars is selected", min: 0.05, max: 20, live: "/mars_app" },
        ],
      },
    ],
  },
  {
    icon: "warning.svg",
    title: "Safety & hardware",
    summary: "Physical limits, battery, and arm",
    note: "Configure the robot's physical backstops and hardware behavior.",
    sections: [
      {
        title: "Safety limits",
        note: "The hardware ceiling every velocity source passes through at the motors. Keep these ≥ the driving caps above.",
        knobs: [
          { path: ["bringup", P, "safety", "max_speed"], label: "Hard max speed", default: 0.8, type: "float", unit: "m/s", doc: "Hard /cmd_vel linear ceiling at the motors" },
          { path: ["bringup", P, "safety", "max_angular_speed"], label: "Hard max turn", default: 2.5, type: "float", unit: "rad/s", doc: "Hard /cmd_vel angular ceiling at the motors" },
        ],
      },
      {
        title: "Battery",
        knobs: [
          { path: ["bringup", P, "battery", "warning_percentage"], label: "Low-battery warning", default: 20, type: "int", unit: "%", doc: "Low-battery warning level", min: 0, max: 100, slider: true },
          { path: ["bringup", P, "battery", "critical_percentage"], label: "Critical battery", default: 10, type: "int", unit: "%", doc: "Critical-battery level", min: 0, max: 100, slider: true },
        ],
      },
      {
        title: "Arm",
        knobs: [
          { path: ["mars_arm", P, "max_jerk"], label: "Max jerk", default: 150, type: "float", unit: "rad/s³", doc: "Trajectory jerk limit (0 disables)" },
        ],
      },
    ],
  },
  {
    icon: "camera.svg",
    title: "Camera",
    summary: "Stream size, rate, and exposure",
    note: "Physical main camera (hardware only).",
    sections: [
      {
        title: "Stream",
        knobs: [
          { path: ["main_camera_driver", P, "publish_left_width"], label: "Image width", default: 640, type: "int", unit: "px", doc: "Streamed main-camera image width" },
          { path: ["main_camera_driver", P, "publish_left_height"], label: "Image height", default: 480, type: "int", unit: "px", doc: "Streamed main-camera image height" },
          { path: ["main_camera_driver", P, "fps"], label: "Frame rate", default: 30, type: "float", unit: "fps", doc: "Camera frame rate" },
          { path: ["main_camera_driver", P, "jpeg_quality"], label: "JPEG quality", default: 80, type: "int", doc: "JPEG compression quality (1–100)", min: 1, max: 100, slider: true },
        ],
      },
      {
        title: "Exposure",
        knobs: [
          { path: ["main_camera_driver", P, "auto_exposure_mode"], label: "Auto-exposure mode", default: 0, type: "int", doc: "0 = hardware AE, 1 = custom PID, 2 = manual" },
          { path: ["main_camera_driver", P, "exposure"], label: "Manual exposure", default: -1, type: "int", doc: "Manual exposure time (-1 = keep current; 1–10000)" },
          { path: ["main_camera_driver", P, "gain"], label: "Manual gain", default: -1, type: "int", doc: "Manual gain (-1 = keep current; 0–255)" },
          { path: ["main_camera_driver", P, "default_gain"], label: "Auto-exposure gain", default: 110, type: "int", doc: "Gain used in auto-exposure mode (0–255)", min: 0, max: 255, slider: true },
          { path: ["main_camera_driver", P, "target_brightness"], label: "Target brightness", default: 128, type: "float", doc: "Auto-exposure target brightness (0–255)", min: 0, max: 255, slider: true, step: 1 },
          { path: ["main_camera_driver", P, "ae_kp"], label: "Auto-exposure Kp", default: 0.8, type: "float", doc: "Auto-exposure proportional gain" },
        ],
      },
    ],
  },
  {
    icon: "brain.svg",
    title: "Autonomy",
    summary: "Localization, navigation, and learned skills",
    note: "Configure how the robot finds itself on the map, navigates, and runs learned manipulation policies.",
    sections: [
      {
        title: "Localization",
        note: "Grid localizer.",
        knobs: [
          { path: ["navigation_grid_localizer", P, "max_score_threshold"], label: "Match threshold", default: 0.3, type: "float", doc: "Lower = stricter match required to accept a pose" },
          { path: ["navigation_grid_localizer", P, "max_range"], label: "Max lidar range", default: 12, type: "float", unit: "m", doc: "Max lidar range used for matching" },
          { path: ["navigation_grid_localizer", P, "auto_localize_timeout"], label: "Auto-localize timeout", default: 30, type: "float", unit: "s", doc: "Seconds to keep trying auto-localization on startup" },
        ],
      },
      {
        title: "Vision-language navigation",
        note: "Vision-language navigation. UniNavid drives in discrete action bursts with its own speed knobs — separate from nav and teleop; the safety clamp is still the ceiling.",
        knobs: [
          { path: ["uninavid_node", P, "forward_speed"], label: "Forward speed", default: 0.3, type: "float", unit: "m/s", doc: "FORWARD action speed", subsection: "Motion" },
          { path: ["uninavid_node", P, "turn_speed"], label: "Turn speed", default: 0.8, type: "float", unit: "rad/s", doc: "LEFT / RIGHT action speed", subsection: "Motion" },
          { path: ["uninavid_node", P, "cmd_duration_sec"], label: "Command duration", default: 0.1, type: "float", unit: "s", doc: "How long each movement command runs", subsection: "Motion" },
          { path: ["uninavid_node", P, "image_send_hz"], label: "Image send rate", default: 49, type: "float", unit: "Hz", doc: "Camera frames sent to the nav model per second", subsection: "Loop" },
          { path: ["uninavid_node", P, "consecutive_stops_to_complete"], label: "Stops to complete", default: 30, type: "int", doc: "Stop predictions in a row before \"reached\"", subsection: "Loop" },
          { path: ["uninavid_node", P, "cmd_publish_hz"], label: "Command publish rate", default: 50, type: "float", unit: "Hz", doc: "cmd_vel republish rate during a move", subsection: "Loop" },
          { path: ["uninavid_node", P, "poll_period_sec"], label: "Poll period", default: 0.02, type: "float", unit: "s", doc: "Action-loop poll interval", subsection: "Loop" },
        ],
      },
      {
        title: "Learned manipulation",
        note: "Learned-skill execution. Node-level, applied at startup (restart to apply); only n_action_steps accepts a per-skill behavior_config override.",
        knobs: [
          { path: ["manipulation_server", P, "inference_hz"], label: "Inference rate", default: 25, type: "float", unit: "Hz", doc: "Policy inference loop rate", subsection: "Execution" },
          { path: ["manipulation_server", P, "speed"], label: "Execution speed", default: 1.5, type: "float", unit: "×", doc: "Action execution speed multiplier", subsection: "Execution" },
          { path: ["manipulation_server", P, "replay_base_speed_scale"], label: "Replay base speed", default: 1, type: "float", unit: "×", doc: "Base-speed scale for replay (1.0 = recorded speed)", subsection: "Execution" },
          { path: ["manipulation_server", P, "learned_base_speed_scale"], label: "Learned base speed", default: 1, type: "float", unit: "×", doc: "Base-speed scale for the learned policy (1.0 = full predicted speed)", subsection: "Execution" },
          { path: ["manipulation_server", P, "n_action_steps"], label: "Replan horizon", default: 0, type: "int", doc: "Replan horizon; 0 = auto (min(40, chunk_size))", subsection: "Policy" },
          { path: ["manipulation_server", P, "temporal_ensemble_coeff"], label: "Action smoothing", default: 0, type: "float", doc: "ACT temporal-ensemble coefficient; 0 = disabled (default). 0.01 is a good value to enable it", subsection: "Policy" },
        ],
      },
    ],
  },
  {
    icon: "cloud.svg",
    title: "Brain client",
    summary: "Sensing uplink, diagnostics, and AI models",
    note: "Tune what the brain client sends to the Innate agent, plus realtime speech model selection.",
    sections: [
      {
        title: "Sensing",
        note: "What the brain client sends to the Innate agent. The model fields are also set on the realtime voice loop below — change both so the chat-TTS and realtime-voice paths stay in sync.",
        knobs: [
          { path: ["brain_client_node", P, "vertical_fov"], label: "Camera vertical FOV", default: 80, type: "float", unit: "°", doc: "Camera vertical field of view" },
          { path: ["brain_client_node", P, "pose_image_interval"], label: "Pose-image interval", default: 0.5, type: "float", unit: "s", doc: "Seconds between pose-image sends" },
          { path: ["brain_client_node", P, "scan_stale_after_sec"], label: "Scan stale after", default: 10, type: "float", unit: "s", doc: "Seconds without a lidar scan before flagging stale" },
          { path: ["brain_client_node", P, "send_depth"], label: "Send depth images", default: false, type: "bool", doc: "Also send depth images to the agent" },
          { path: ["brain_client_node", P, "send_arm_camera_image"], label: "Send arm-camera image", default: true, type: "bool", doc: "Also send the arm camera image" },
        ],
      },
      {
        title: "Diagnostics & models",
        note: "Brain client. The model fields are also set on the realtime voice loop below — change both so the chat-TTS and realtime-voice paths stay in sync.",
        knobs: [
          { path: ["brain_client_node", P, "log_everything"], label: "Verbose logging", default: true, type: "bool", doc: "Verbose vision-agent output logging" },
          { path: ["brain_client_node", P, "openai_realtime_model"], label: "Realtime model", default: "gpt-4o-realtime-preview", type: "string", doc: "OpenAI realtime model" },
          { path: ["brain_client_node", P, "openai_transcribe_model"], label: "Transcribe model", default: "gpt-4o-mini-transcribe", type: "string", doc: "OpenAI transcription model" },
        ],
      },
      {
        title: "Speech models",
        note: "Keep these values in sync with the matching brain-client model fields above.",
        knobs: [
          { path: ["input_manager_node", P, "openai_realtime_model"], label: "Realtime model", default: "gpt-4o-realtime-preview", type: "string", doc: "OpenAI realtime model" },
          { path: ["input_manager_node", P, "openai_transcribe_model"], label: "Transcribe model", default: "gpt-4o-mini-transcribe", type: "string", doc: "OpenAI transcription model" },
        ],
      },
    ],
  },
];

// Guard: every path appears once (catches copy-paste when adding knobs).
{
  const seen = new Set();
  for (const page of SETTINGS_PAGES) {
    for (const section of page.sections) {
      for (const knob of section.knobs) {
        const id = knob.path.join("/");
        if (seen.has(id)) throw new Error("Duplicate settings knob path: " + id);
        seen.add(id);
      }
    }
  }
}
