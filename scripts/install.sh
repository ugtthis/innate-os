#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Innate Inc
#
# One-line installer for the Innate simulator:
#
#     curl -fsSL https://link.innate.bot/sim | sh
#
# It lives here so it can be read before it is piped to a shell, and so it
# versions with the thing it installs. If you are reading this in a checkout
# you already have, this script is not for you: run `./innate-sim setup`.
#
# Installs whatever is missing (Docker, uv, git, the Linux rendering
# libraries), clones innate-os, and hands over to `./innate-sim setup`, which
# asks for the agent key and downloads the runtime. Nothing here duplicates the
# launcher's prerequisite checks -- `setup` runs them, so version floors and
# their remedies are stated in exactly one place.
#
# Every statement lives in a function called from main() on the last line: a
# truncated download must not half-execute.

# step() runs the install_* helpers through "$@", which shellcheck cannot trace
# shellcheck disable=SC2329
set -eu

REPO_URL="${INNATE_REPO_URL:-https://github.com/innate-inc/innate-os.git}"
REF="${INNATE_SIM_REF:-sim-stable}"
# Where `git clone` would put it: in the directory you ran this from.
INNATE_DIR_EXPLICIT=$([ -n "${INNATE_DIR:-}" ] && echo 1 || echo 0)
INNATE_DIR="${INNATE_DIR:-$(pwd)/innate-os}"
UV_INSTALL_URL="https://astral.sh/uv/install.sh"
DOCKER_INSTALL_URL="https://get.docker.com"
# Compose 2.x, for hosts where apt has no candidate (Docker Desktop on WSL).
COMPOSE_2X_URL="https://github.com/docker/compose/releases/download"
COMPOSE_2X_VERSION="v2.40.3"
GL_PACKAGES="libegl1 libgl1 libopengl0 libosmesa6"
# Disk each step needs, in GB, measured on a full install rather than guessed:
#
#   OS image      6.73 GB unpacked (1.4 GB compressed over 28 layers)
#   asset image   0.33 GB stored, plus 0.44 GB extracted to sim/assets
#   viewer bundle ~0.00 GB
#   host uv env   0.24 GB (sim/.venv)
#   volumes       0.32 GB (ros2_ws build/install/log + ccache)
#   checkout      0.90 GB including .git
#
# The image dominates: at 4.7x its compressed size it is most of the runtime
# figure, while the colcon volumes are a rounding error.
DISK_GB_DOCKER=2
DISK_GB_UV=1
DISK_GB_RENDER=1
DISK_GB_CLONE=1
DISK_GB_RUNTIME=8
DISK_HEADROOM_GB=2
DOCKER_WAIT_S=180
LOG_FILE="${INNATE_INSTALL_LOG:-$HOME/.innate-install.log}"
VERBOSE="${INNATE_VERBOSE:-0}"
LOG_TAIL_ROWS=3

PLATFORM=""
TMPDIR_INSTALL=""
NEED_RELOGIN=0
INTERACTIVE=0
PLAN=""
PLAN_N=0
DISK_NEEDED_GB=$DISK_HEADROOM_GB
DISK_FREE_GB=""
DISK_TARGET=""
SUDO_PRIMED=0
STEP_ACTIVE=0
step_pid=""

# Package managers ask questions no unattended install can answer, and
# needrestart prints a service-restart audit nobody asked for.
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

if [ -t 1 ]; then
    BOLD=$(printf '\033[1m')
    DIM=$(printf '\033[2m')
    RED=$(printf '\033[31m')
    GREEN=$(printf '\033[32m')
    YELLOW=$(printf '\033[33m')
    CYAN=$(printf '\033[36m')
    NC=$(printf '\033[0m')
else
    BOLD="" DIM="" RED="" GREEN="" YELLOW="" CYAN="" NC=""
fi

# COLORTERM is the usual signal, but ssh forwards only TERM (it is not in the
# default SendEnv), so a session reached over ssh arrives without it. A TERM
# advertising direct color is the second witness; without either, the logo
# falls back to flat cyan and nothing else changes.
case "${COLORTERM:-}:${TERM:-}" in
    truecolor:* | 24bit:*) TRUECOLOR=1 ;;
    *:*direct* | *:*truecolor*) TRUECOLOR=1 ;;
    *) TRUECOLOR=0 ;;
esac

# One line per step, in a right-aligned label column: what happened, never how.
# The how goes to LOG_FILE, which every failure points at.
say() { printf '  %s%8s%s  %s\n' "$CYAN" "$1" "$NC" "$2"; }
note() { printf '  %s%8s  %s%s\n' "$DIM" "" "$1" "$NC"; }

# The label, then the message with every later line held at the same indent --
# an explanation that falls back to the margin stops looking like one message.
labelled() {
    printf '%s\n' "$3" | {
        first=1
        while IFS= read -r labelled_line; do
            if [ "$first" -eq 1 ]; then
                printf '  %s%8s%s  %s\n' "$2" "$1" "$NC" "$labelled_line"
                first=0
            elif [ -n "$labelled_line" ]; then
                printf '  %8s  %s\n' "" "$labelled_line"
            else
                printf '\n' # a blank line stays blank, not twelve spaces
            fi
        done
    }
}

warn() { labelled "warning" "$YELLOW" "$*" >&2; }
cancel() {
    labelled "aborted" "$YELLOW" "$*"
    exit 0
}

die() {
    printf '\r\033[K'
    labelled "failed" "$RED" "$*" >&2
    if [ -s "$LOG_FILE" ]; then
        printf '  %s%8s  full log: %s%s\n' "$DIM" "" "$LOG_FILE" "$NC" >&2
    fi
    exit 1
}

spinner_frame() {
    n=$1
    set -- '⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏'
    shift "$((n % 10))"
    printf '%s' "$1"
}

# step <label> <doing> <done> <command...>: run it with its output in the log,
# showing one live line that settles into a check mark. Two messages, because
# a spinner beside a noun does not say whether the noun is being installed or
# merely inspected.
step() {
    step_label=$1
    step_msg=$2
    step_done=$3
    shift 3
    if [ -z "$NC" ] || [ "$VERBOSE" != "0" ]; then
        say "$step_label" "$step_msg"
        "$@" >>"$LOG_FILE" 2>&1 || return 1
        return 0
    fi

    "$@" >>"$LOG_FILE" 2>&1 &
    step_pid=$!
    STEP_ACTIVE=1
    hide_cursor
    step_n=0
    while kill -0 "$step_pid" 2>/dev/null; do
        # Elapsed from the frame count: this loop spawns enough processes per
        # second already without a `date` in it.
        draw_step_frame "$(spinner_frame "$step_n")" "$((step_n * 12 / 100))"
        step_n=$((step_n + 1))
        sleep 0.12
    done
    erase_step_frame
    show_cursor
    STEP_ACTIVE=0
    if ! wait "$step_pid"; then
        return 1
    fi
    printf '  %s%8s%s  %s✔%s %s\n' "$CYAN" "$step_label" "$NC" "$GREEN" "$NC" "$step_done"
}

# The status line plus the tail of the log, so a long step shows its work
# rather than a spinner that cannot be told apart from a hang. Always the same
# number of rows, so the cursor can be walked back over them.
draw_step_frame() {
    frame_width=$(terminal_width)
    frame_room=$((frame_width - 20))
    printf '\033[K  %s%8s%s  %s %s  %s%ss%s\n' \
        "$CYAN" "$step_label" "$NC" "$1" "$(printf '%s' "$step_msg" | cut -c "1-$frame_room")" "$DIM" "$2" "$NC"
    tail -n "$LOG_TAIL_ROWS" "$LOG_FILE" 2>/dev/null | tr -d '\r' | cut -c "1-$frame_room" >"$TMPDIR_INSTALL/tail"
    tail_row=0
    while IFS= read -r tail_line; do
        printf '\033[K  %s%8s  │ %s%s\n' "$DIM" "" "$tail_line" "$NC"
        tail_row=$((tail_row + 1))
    done <"$TMPDIR_INSTALL/tail"
    while [ "$tail_row" -lt "$LOG_TAIL_ROWS" ]; do
        printf '\033[K\n'
        tail_row=$((tail_row + 1))
    done
    printf '\033[%dA\r' "$((LOG_TAIL_ROWS + 1))"
}

erase_step_frame() {
    erase_row=0
    while [ "$erase_row" -le "$LOG_TAIL_ROWS" ]; do
        printf '\033[K\n'
        erase_row=$((erase_row + 1))
    done
    printf '\033[%dA\r' "$((LOG_TAIL_ROWS + 1))"
}

# From the terminal itself (fd 3), not tput: with stdout on a pipe or inside a
# command substitution, tput reports terminfo's static 80 rather than the real
# width, and a status line wider than the terminal wraps -- which desynchronises
# every cursor-up the frame relies on.
terminal_width() {
    width=""
    if [ "$INTERACTIVE" -eq 1 ]; then
        width=$(stty size <&3 2>/dev/null | awk '{print $2}')
    fi
    if [ -z "$width" ]; then
        width=$(tput cols 2>/dev/null || printf '80')
    fi
    case "$width" in
        '' | *[!0-9]*) width=80 ;;
    esac
    if [ "$width" -lt 40 ]; then
        width=80
    fi
    printf '%s' "$width"
}

# Privileged steps run in the background, where a password prompt would hang
# invisibly. Ask for it here, in the foreground, once.
prime_sudo() {
    [ "$SUDO_PRIMED" -eq 1 ] && return 0
    SUDO_PRIMED=1
    [ "$(id -u)" -eq 0 ] && return 0
    have sudo || die "This install needs root and sudo is not installed. Run it as root, or install sudo."
    sudo -n true 2>/dev/null && return 0
    note "administrator password needed to install system packages"
    with_tty sudo -v || die "Could not authenticate with sudo."
}

have() { command -v "$1" >/dev/null 2>&1; }

# A blinking cursor parked after the last thing drawn reads as an unanswered
# text prompt. cleanup() restores it, so no exit path can leave it hidden.
hide_cursor() {
    if [ -n "$NC" ]; then printf '\033[?25l'; fi
}

show_cursor() {
    if [ -n "$NC" ]; then printf '\033[?25h'; fi
}

# Invoked by the traps in main, which shellcheck does not trace
# shellcheck disable=SC2329
cleanup() {
    show_cursor
    [ -n "$TMPDIR_INSTALL" ] && rm -rf "$TMPDIR_INSTALL"
}

# A trap that only cleans up is not an interrupt handler: the shell resumes
# where it left off, so Ctrl+C would delete the temp dir and carry on
# installing. Stop the step's child, put the cursor back, and leave.
on_interrupt() {
    trap '' INT TERM
    if [ "$STEP_ACTIVE" -eq 1 ]; then
        kill "$step_pid" 2>/dev/null || true
        erase_step_frame
        STEP_ACTIVE=0
    fi
    printf '\n  %s%8s%s  interrupted; nothing else was installed\n' "$YELLOW" "stopped" "$NC" >&2
    exit 130
}

as_root() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
    else
        have sudo || die "This step needs root and sudo is not installed. Run the installer as root, or install sudo."
        sudo "$@"
    fi
}

# The terminal on fd 3, NOT on stdin: piped into sh, stdin is the script
# itself, which the shell is still reading. Redirecting it makes the shell read
# the rest of the install from the keyboard -- it hangs at the end instead of
# exiting. Without a terminal at all (CI, a hook), the installer proceeds with
# defaults and setup skips the key prompt on its own.
attach_terminal() {
    # Redirections apply left to right, so `exec 3<... 2>/dev/null` still
    # reports its own failure; the group suppresses it.
    if [ -e /dev/tty ] && { exec 3</dev/tty; } 2>/dev/null; then
        INTERACTIVE=1
    else
        INTERACTIVE=0
    fi
}

# Anything that asks the user something needs the terminal as ITS stdin.
with_tty() {
    if [ "$INTERACTIVE" -eq 1 ]; then
        "$@" <&3
    else
        "$@"
    fi
}

# Control characters as values, since a case pattern cannot hold an escape.
ESC=$(printf '\033')
CR=$(printf '\rX')
CR=${CR%X}
ETX=$(printf '\003')

# One keypress, named. dd because POSIX read has no single-character mode; the
# X sentinel survives command substitution stripping a trailing newline.
read_key() {
    key=$(dd bs=1 count=1 <&3 2>/dev/null; printf X)
    key=${key%X}
    case "$key" in
        "$ESC")
            key=$(dd bs=1 count=2 <&3 2>/dev/null; printf X)
            case "${key%X}" in
                '[A') key=up ;;
                '[B') key=down ;;
                '[C') key=right ;;
                '[D') key=left ;;
                *) key=escape ;;
            esac
            ;;
        "$CR" | '') key=enter ;;
        "$ETX") key=interrupt ;;
    esac
}

draw_confirm() {
    if [ "$1" -eq 1 ]; then
        printf '\r\033[K  %s%s%s   %s● Yes%s   %s○ No%s' \
            "$BOLD" "$confirm_question" "$NC" "$GREEN" "$NC" "$DIM" "$NC"
    else
        printf '\r\033[K  %s%s%s   %s○ Yes%s   %s● No%s' \
            "$BOLD" "$confirm_question" "$NC" "$DIM" "$NC" "$GREEN" "$NC"
    fi
}

# Left/right between Yes and No, like the menus in the launcher. Falls back to
# typing when the terminal cannot be put in raw mode.
confirm() {
    [ "$INTERACTIVE" -eq 1 ] || return 0
    confirm_question=$1
    if ! stty_saved=$(stty -g <&3 2>/dev/null); then
        printf '  %s%s [Y/n]: %s' "$YELLOW" "$confirm_question" "$NC"
        read -r reply <&3 || reply=""
        case "$reply" in
            "" | y | Y | yes | YES) return 0 ;;
            *) return 1 ;;
        esac
    fi

    confirm_yes=1
    stty raw -echo <&3
    hide_cursor
    while :; do
        draw_confirm "$confirm_yes"
        read_key
        case "$key" in
            left | right | h | l) confirm_yes=$((1 - confirm_yes)) ;;
            y | Y) confirm_yes=1 ;;
            n | N) confirm_yes=0 ;;
            interrupt)
                stty "$stty_saved" <&3
                printf '\r\n'
                on_interrupt
                ;;
            enter) break ;;
        esac
    done
    stty "$stty_saved" <&3
    show_cursor
    draw_confirm "$confirm_yes"
    printf '\n'
    [ "$confirm_yes" -eq 1 ]
}

# plan_add <text> <GB it needs>: the estimate is a sum over the steps that
# will actually run, so someone who already has Docker is not quoted for it.
plan_add() {
    PLAN_N=$((PLAN_N + 1))
    DISK_NEEDED_GB=$((DISK_NEEDED_GB + $2))
    PLAN="$PLAN    $PLAN_N) $1
"
}

detect_platform() {
    case "$(uname -s)" in
        Darwin) PLATFORM="macos" ;;
        Linux)
            if [ -r /proc/version ] && grep -qi microsoft /proc/version; then
                PLATFORM="wsl"
            else
                PLATFORM="linux"
            fi
            ;;
        MINGW* | MSYS* | CYGWIN*)
            die "Git Bash cannot run the simulator. Install WSL2 (\`wsl --install -d Ubuntu\` in PowerShell), open the Ubuntu terminal, and rerun this command there."
            ;;
        *) die "Unsupported platform: $(uname -s). The simulator runs on macOS, Linux and WSL2." ;;
    esac
}

check_install_dir() {
    # A checkout under /mnt/c is on the Windows filesystem: every container
    # read crosses the 9p bridge (minutes, not seconds, per build) and the
    # ownership the launcher sets on workspace/ does not survive it.
    case "$PLATFORM:$INNATE_DIR" in
        wsl:/mnt/*)
            die "This folder is on the Windows drive, where the simulator runs far too
slowly to use. Your Linux home folder is the place for it.

Run these two commands:

  cd ~
  curl -fsSL https://link.innate.bot/sim | sh"
            ;;
    esac

    # Nesting a checkout inside another repo confuses both; the cwd default
    # makes that a real possibility, since a piped installer runs wherever the
    # terminal happened to be.
    if [ "$INNATE_DIR_EXPLICIT" -eq 0 ] && have git && enclosing=$(git rev-parse --show-toplevel 2>/dev/null); then
        # This script's whole job is to produce a checkout, so running it from
        # inside one is a misunderstanding worth answering rather than refusing.
        if [ -x "$enclosing/innate-sim" ]; then
            die "$enclosing is already an innate-os checkout -- this installer only clones one. You want: cd $enclosing && ./innate-sim setup"
        fi
        die "$(pwd) is inside a git repository, so the simulator would be a checkout within a checkout. cd somewhere else, or set INNATE_DIR to where it should live."
    fi
    if [ -d "$INNATE_DIR" ] && [ ! -d "$INNATE_DIR/.git" ] && [ -n "$(ls -A "$INNATE_DIR" 2>/dev/null)" ]; then
        die "$INNATE_DIR already exists and is not an innate-os checkout. Move it aside, or set INNATE_DIR."
    fi

    parent=$(dirname "$INNATE_DIR")
    while [ ! -d "$parent" ] && [ "$parent" != "/" ]; do
        parent=$(dirname "$parent")
    done
    DISK_TARGET=$parent
    DISK_FREE_GB=$(df -Pk "$parent" | awk 'NR==2 {print int($4 / 1048576)}')
    case "$DISK_FREE_GB" in
        '' | *[!0-9]*) DISK_FREE_GB="" ;;
    esac
}

uv_installed() {
    have uv || [ -x "$HOME/.local/bin/uv" ] || [ -x "$HOME/.cargo/bin/uv" ]
}

build_plan() {
    have git || plan_add "Install git (with your package manager)" 1
    have docker || {
        if [ "$PLATFORM" = "macos" ]; then
            plan_add "Install Docker Desktop (Homebrew cask)" "$DISK_GB_DOCKER"
        else
            plan_add "Install Docker Engine + Compose (from $DOCKER_INSTALL_URL, needs sudo)" "$DISK_GB_DOCKER"
        fi
    }
    uv_installed || plan_add "Install uv, which runs the physics world (user-local, no sudo)" "$DISK_GB_UV"
    if [ "$PLATFORM" != "macos" ] && have apt-get; then
        plan_add "Install the rendering libraries: $GL_PACKAGES (needs sudo)" "$DISK_GB_RENDER"
    fi
    if [ -d "$INNATE_DIR/.git" ]; then
        plan_add "Update the innate-os checkout in $INNATE_DIR" 0
    else
        plan_add "Clone innate-os ($REF) into $INNATE_DIR" "$DISK_GB_CLONE"
    fi
    # Never a surprise at the confirmation prompt: this is the step that asks
    # for a key and then spends several GB of someone's connection.
    plan_add "Ask how the agent reaches a cloud LLM, then download the simulator" "$DISK_GB_RUNTIME"
}

# Stated where the decision is made, not warned about above it: running out of
# disk half way through a multi-gigabyte pull is the expensive way to find out.
report_disk() {
    if [ -z "$DISK_FREE_GB" ]; then
        printf '  %sAbout %s GB of disk is needed.%s\n\n' "$DIM" "$DISK_NEEDED_GB" "$NC"
    elif [ "$DISK_FREE_GB" -lt "$DISK_NEEDED_GB" ]; then
        printf '  %sNeeds about %s GB of disk, but %s has only %s GB free.%s\n\n' \
            "$YELLOW" "$DISK_NEEDED_GB" "$DISK_TARGET" "$DISK_FREE_GB" "$NC"
    else
        printf '  %sDisk: about %s GB needed, %s GB free on %s.%s\n\n' \
            "$DIM" "$DISK_NEEDED_GB" "$DISK_FREE_GB" "$DISK_TARGET" "$NC"
    fi
}

review_plan() {
    printf '\n  %sThe installer will:%s\n\n' "$BOLD" "$NC"
    printf '%s\n' "$PLAN"
    report_disk
    if [ -z "$NC" ] || [ "$VERBOSE" != "0" ]; then
        printf '  %sCommand output is shown as it runs.%s\n\n' "$DIM" "$NC"
    else
        printf '  %sDetailed output goes to %s%s\n\n' "$DIM" "$LOG_FILE" "$NC"
    fi
    confirm "  Continue?" || cancel "nothing was installed"
    printf '\n'
}

install_git() {
    if have apt-get; then
        as_root apt-get update -qq && as_root apt-get install -y git
    elif have dnf; then
        as_root dnf install -y git
    else
        return 1
    fi
}

ensure_git() {
    have git && return 0
    if [ "$PLATFORM" = "macos" ]; then
        # Triggers the Command Line Tools GUI installer, which this script
        # cannot wait on -- so send the user back rather than racing it.
        xcode-select --install >/dev/null 2>&1 || true
        die "git is missing. Finish the Command Line Tools install macOS just offered, then rerun this command."
    fi
    prime_sudo
    step "git" "Installing git" "git installed" install_git || die "Could not install git."
}

start_docker_daemon() {
    docker info >/dev/null 2>&1 && return 0
    if [ "$PLATFORM" = "macos" ]; then
        open --background -a Docker >/dev/null 2>&1 || true
    elif have systemctl; then
        as_root systemctl start docker >/dev/null 2>&1 || true
    else
        # WSL without systemd: sysvinit is what docker.io ships there.
        as_root service docker start >/dev/null 2>&1 || true
    fi

    waited=0
    while [ "$waited" -lt "$DOCKER_WAIT_S" ]; do
        docker info >/dev/null 2>&1 && return 0
        sleep 3
        waited=$((waited + 3))
    done
    return 1
}

install_docker_macos() {
    have brew || die "Docker Desktop is not installed, and Homebrew is not available to install it. Download it from https://docs.docker.com/desktop/install/mac-install/, open it once, then rerun this command."
    # The cask was renamed docker -> docker-desktop; accept either, so this
    # works on both old and new Homebrew.
    brew install --cask docker-desktop || brew install --cask docker
}

install_docker_linux() {
    curl -fsSL "$DOCKER_INSTALL_URL" -o "$TMPDIR_INSTALL/get-docker.sh"
    as_root sh "$TMPDIR_INSTALL/get-docker.sh"
    if [ "$(id -u)" -ne 0 ]; then
        as_root usermod -aG docker "$(id -un)"
    fi
}

# A new group only reaches processes started after it is granted, so this
# shell cannot use the Docker socket yet. Read from the group database rather
# than a variable: the install runs inside step()'s background subshell, whose
# assignments never reach this one. `id -nG <user>` queries the database,
# `id -nG` reports this process's own credentials -- the difference IS the
# pending grant.
docker_group_pending() {
    [ "$(id -u)" -eq 0 ] && return 1
    id -nG "$(id -un)" 2>/dev/null | tr ' ' '\n' | grep -qx docker || return 1
    id -nG 2>/dev/null | tr ' ' '\n' | grep -qx docker && return 1
    return 0
}

ensure_docker() {
    if ! have docker; then
        if [ "$PLATFORM" = "macos" ]; then
            step "docker" "Installing Docker Desktop" "Docker Desktop installed" install_docker_macos || die "Could not install Docker Desktop."
        else
            prime_sudo
            step "docker" "Installing Docker Engine + Compose" "Docker Engine + Compose installed" install_docker_linux || die "Could not install Docker."
        fi
    fi

    ensure_working_compose
    if docker_group_pending; then
        NEED_RELOGIN=1
        note "added you to the docker group"
        return 0
    fi
    if ! step "docker" "Starting the Docker daemon" "Docker daemon running" start_docker_daemon; then
        if [ "$PLATFORM" = "macos" ]; then
            die "Docker Desktop did not finish starting within ${DOCKER_WAIT_S}s. Open it, wait for it to settle, then rerun this command."
        fi
        die "The Docker daemon is installed but did not start. Start it (sudo systemctl start docker) and rerun this command."
    fi
}

# Compose 5 resolves a `type: image` mount to the image's manifest digest and
# passes it to the daemon as an image ID, so the container cannot be created
# (see BROKEN_COMPOSE_IMAGE_MOUNTS_SINCE in sim/launcher/runtime.py). Docker's
# repo still carries 2.x, which works, so take the newest of those. Whichever
# repo get.docker.com configured is the one asked -- no second source.
apt_compose_2x() {
    apt-cache madison docker-compose-plugin 2>/dev/null | awk '{print $3}' | grep -m1 '^2\.'
}

install_compose_from_apt() {
    as_root apt-get install -y -qq --allow-downgrades "docker-compose-plugin=$(apt_compose_2x)"
}

# The CLI reads ~/.docker/cli-plugins before the system one, so this also wins
# over the plugin Docker Desktop injects into WSL -- where there is no Docker
# apt repo to install from, and no package to downgrade.
install_compose_plugin_binary() {
    case "$(uname -m)" in
        x86_64 | amd64) compose_arch=x86_64 ;;
        aarch64 | arm64) compose_arch=aarch64 ;;
        *) return 1 ;;
    esac
    mkdir -p "$HOME/.docker/cli-plugins"
    curl -fsSL "$COMPOSE_2X_URL/$COMPOSE_2X_VERSION/docker-compose-linux-$compose_arch" \
        -o "$TMPDIR_INSTALL/docker-compose"
    chmod +x "$TMPDIR_INSTALL/docker-compose"
    mv "$TMPDIR_INSTALL/docker-compose" "$HOME/.docker/cli-plugins/docker-compose"
}

compose_major() {
    docker compose version --short 2>/dev/null | cut -d. -f1
}

ensure_working_compose() {
    major=$(compose_major)
    case "$major" in
        '' | *[!0-9]*) return 0 ;; # unreadable version: the launcher diagnoses it
    esac
    [ "$major" -ge 5 ] || return 0

    done_msg="Docker Compose 2.x installed ($major.x breaks image mounts)"
    if have apt-get && [ -n "$(apt_compose_2x)" ]; then
        prime_sudo
        step "compose" "Installing Docker Compose 2.x" "$done_msg" install_compose_from_apt && return 0
    fi
    # No apt candidate is the normal case under Docker Desktop's WSL
    # integration: Compose comes from Desktop, and no Docker repo is
    # configured inside the distro.
    step "compose" "Installing Docker Compose 2.x" "$done_msg" install_compose_plugin_binary && return 0

    warn "Could not install a working Docker Compose, and $major.x cannot mount the sim's
viewer assets. Install a 2.x Compose plugin by hand before \`innate-sim up\`:
  https://github.com/docker/compose/releases"
}

install_uv() {
    curl -LsSf "$UV_INSTALL_URL" -o "$TMPDIR_INSTALL/uv-install.sh"
    sh "$TMPDIR_INSTALL/uv-install.sh"
}

ensure_uv() {
    uv_installed || step "uv" "Installing uv" "uv installed" install_uv || die "Could not install uv."
    # The installer's default location, which the current shell does not have
    # on PATH yet. Same paths the launcher looks in (runtime.find_uv).
    PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
    export PATH
}

install_render_libs() {
    as_root apt-get update -qq
    # GL_PACKAGES is a package list, so it has to word-split
    # shellcheck disable=SC2086
    as_root apt-get install -y $GL_PACKAGES
}

ensure_render_libs() {
    [ "$PLATFORM" = "macos" ] && return 0
    if ! have apt-get; then
        warn "Install your distro's OpenGL/OSMesa runtime if the 3D view fails to start (Fedora: mesa-libEGL mesa-libGL mesa-libOSMesa)."
        return 0
    fi
    prime_sudo
    step "render" "Installing the OpenGL libraries" "OpenGL libraries installed" install_render_libs || die "Could not install the rendering libraries."
}

update_checkout() {
    git -C "$INNATE_DIR" fetch --quiet origin "$REF" || return 1
    if [ -n "$(git -C "$INNATE_DIR" status --porcelain)" ]; then
        return 0 # local changes are the user's; never touch them
    fi
    git -C "$INNATE_DIR" merge --ff-only FETCH_HEAD >/dev/null 2>&1 || return 0
}

clone_checkout() {
    # Blobless rather than shallow: full history for log/bisect at a fraction
    # of the size, and `git pull` keeps working afterwards.
    git clone --quiet --filter=blob:none --branch "$REF" "$REPO_URL" "$INNATE_DIR"
}

clone_repo() {
    if [ -d "$INNATE_DIR/.git" ]; then
        step "repo" "Updating $INNATE_DIR" "updated $INNATE_DIR" update_checkout || die "Could not update $INNATE_DIR."
    else
        git ls-remote --exit-code --heads "$REPO_URL" "$REF" >/dev/null 2>&1 ||
            die "$REPO_URL has no branch named $REF. Set INNATE_SIM_REF to one that exists (main, for the development tip), or report this at https://discord.gg/innate."
        step "repo" "Cloning innate-os into $INNATE_DIR" "cloned into $INNATE_DIR" clone_checkout || die "Could not clone $REPO_URL."
        # Blobless rather than shallow: full history for log/bisect at a
    fi
    note "$REF at $(git -C "$INNATE_DIR" rev-parse --short HEAD)"
}

run_setup() {
    # setup owns the rest: prerequisite versions, the agent key, and the
    # runtime download that makes the first `up` a start rather than a wait.
    setup_failed="Setup did not finish (see above). Fix the problem, then rerun: cd $INNATE_DIR && ./innate-sim setup"
    printf '\n'

    if [ "$NEED_RELOGIN" -eq 0 ]; then
        with_tty sh -c "cd '$INNATE_DIR' && ./innate-sim setup" || die "$setup_failed"
        return 0
    fi

    # This shell was started before the docker group was granted, so it cannot
    # reach the socket. `sg` runs one command under a group you already belong
    # to -- enough to finish the install now instead of after a logout.
    if have sg; then
        with_tty sg docker -c "cd '$INNATE_DIR' && ./innate-sim setup" || die "$setup_failed"
        return 0
    fi
    report_relogin
    exit 0
}

report_relogin() {
    printf '\n%sAlmost there.%s Your user was just added to the docker group, which only\n' "$BOLD" "$NC"
    printf 'takes effect in a new login session. Log out and back in, or run: newgrp docker\n'
    printf 'Then finish the install:\n\n'
    printf '  cd %s && ./innate-sim setup\n\n' "$INNATE_DIR"
}

# The launcher's wordmark (dashboard.ASCII_BANNER) and its green-to-gold
# gradient, so the install ends in the same skin the dashboard opens in.
logo_color() {
    [ -n "$NC" ] || return 0
    if [ "$TRUECOLOR" -eq 0 ]; then
        printf '\033[36m'
        return 0
    fi
    case "$1" in
        1) printf '\033[38;2;119;202;155m' ;;
        2) printf '\033[38;2;140;199;140m' ;;
        3) printf '\033[38;2;164;196;126m' ;;
        4) printf '\033[38;2;185;194;115m' ;;
        *) printf '\033[38;2;203;192;108m' ;;
    esac
}

print_logo() {
    i=0
    while IFS= read -r line; do
        i=$((i + 1))
        printf '%s%s%s%s\n' "$(logo_color "$i")" "$BOLD" "$line" "$NC"
    done <<'EOF'
 ___ _   _ _   _    _  _____ _____
|_ _| \ | | \ | |  / \|_   _| ____|
 | ||  \| |  \| | / _ \ | | |  _|
 | || |\  | |\  |/ ___ \| | | |___
|___|_| \_|_| \_/_/   \_\_| |_____|
EOF
}

print_intro() {
    printf '\n'
    print_logo
    printf '  %ssimulator installer%s\n\n' "$DIM" "$NC"
}

detect_editor() {
    for candidate in cursor code windsurf zed subl; do
        if have "$candidate"; then
            printf '%s' "$candidate"
            return 0
        fi
    done
    return 1
}

report_next_steps() {
    printf '\n'
    say "ready" "the simulator is installed"
    printf '\n'
    # No script can cd its parent's shell, so the cd is the user's own first
    # step -- and everything below is written to follow it.
    printf '  %s%8s%s  cd %s\n' "$BOLD" "start" "$NC" "$INNATE_DIR"
    printf '  %8s  ./innate-sim up\n\n' ""
    if editor=$(detect_editor); then
        printf '  %s%8s%s  %s .  %s— skills and agents live in workspace/%s\n' "$BOLD" "edit" "$NC" "$editor" "$DIM" "$NC"
    else
        printf '  %s%8s%s  open it in your editor  %s— skills and agents live in workspace/%s\n' \
            "$BOLD" "edit" "$NC" "$DIM" "$NC"
    fi
    printf '  %s%8s%s  https://localhost  %s— once it is up (accept the self-signed certificate)%s\n' \
        "$BOLD" "open" "$NC" "$DIM" "$NC"
    printf '  %s%8s%s  https://discord.gg/innate\n' "$BOLD" "help" "$NC"
    printf '\n'
    if [ "$NEED_RELOGIN" -eq 1 ]; then
        note "docker was installed just now, so this shell is not in its group yet;"
        note "innate-sim reruns itself under sg until your next login session."
        printf '\n'
    fi
}

# Offer to skip the last command too. `exec` hands the terminal to the
# launcher: its dashboard owns the screen from here, and the shell is gone
# rather than waiting behind it.
offer_to_start() {
    [ "$INTERACTIVE" -eq 1 ] || return 0
    confirm "  Start the simulator now?" || return 0
    printf '\n'
    if [ "$NEED_RELOGIN" -eq 1 ] && have sg; then
        exec 0<&3
        exec sg docker -c "'$INNATE_DIR/innate-sim' up"
    fi
    exec 0<&3
    exec "$INNATE_DIR/innate-sim" up
}

main() {
    TMPDIR_INSTALL=$(mktemp -d)
    trap cleanup EXIT
    trap on_interrupt INT TERM

    : >"$LOG_FILE" 2>/dev/null || LOG_FILE="$TMPDIR_INSTALL/install.log"
    attach_terminal
    print_intro
    # The wordmark is this screen's; `innate-sim setup` and the `up` that may
    # follow it inherit the fact that it has already been shown.
    export INNATE_BANNER_SHOWN=1
    detect_platform
    check_install_dir
    build_plan
    review_plan

    ensure_git
    ensure_docker
    ensure_uv
    ensure_render_libs
    clone_repo

    run_setup
    report_next_steps
    offer_to_start
}

main "$@"
# Explicit, so the shell stops here rather than reading whatever else is on
# stdin -- the pipe this script arrived through.
exit $?
