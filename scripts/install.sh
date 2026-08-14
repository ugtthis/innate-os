#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Innate Inc
#
# One-line installer for the Innate simulator:
#
#     curl -fsSL https://link.innate.bot/sim | sh
#
# Installs whatever is missing (Docker, uv, git, the Linux rendering
# libraries), clones innate-os, and hands over to `./innate-sim setup`, which
# asks for the agent key and downloads the runtime. Nothing here duplicates the
# launcher's prerequisite checks -- `setup` runs them, so version floors and
# their remedies are stated in exactly one place.
#
# Every statement lives in a function called from main() on the last line: a
# truncated download must not half-execute.

set -eu

REPO_URL="${INNATE_REPO_URL:-https://github.com/innate-inc/innate-os.git}"
REF="${INNATE_SIM_REF:-sim-stable}"
# Where `git clone` would put it: in the directory you ran this from.
INNATE_DIR_EXPLICIT=$([ -n "${INNATE_DIR:-}" ] && echo 1 || echo 0)
INNATE_DIR="${INNATE_DIR:-$(pwd)/innate-os}"
UV_INSTALL_URL="https://astral.sh/uv/install.sh"
DOCKER_INSTALL_URL="https://get.docker.com"
GL_PACKAGES="libegl1 libgl1 libopengl0 libosmesa6"
MIN_FREE_GB=20
DOCKER_WAIT_S=180

PLATFORM=""
TMPDIR_INSTALL=""
NEED_RELOGIN=0
INTERACTIVE=0
PLAN=""

if [ -t 1 ]; then
    BOLD=$(printf '\033[1m')
    RED=$(printf '\033[31m')
    GREEN=$(printf '\033[32m')
    YELLOW=$(printf '\033[33m')
    CYAN=$(printf '\033[36m')
    NC=$(printf '\033[0m')
else
    BOLD="" RED="" GREEN="" YELLOW="" CYAN="" NC=""
fi

log() { printf '%s==>%s %s\n' "$CYAN" "$NC" "$*"; }
ok() { printf '%s  ok%s %s\n' "$GREEN" "$NC" "$*"; }
warn() { printf '%s  !!%s %s\n' "$YELLOW" "$NC" "$*" >&2; }
die() {
    printf '%s  xx%s %s\n' "$RED" "$NC" "$*" >&2
    exit 1
}

have() { command -v "$1" >/dev/null 2>&1; }

cleanup() { [ -n "$TMPDIR_INSTALL" ] && rm -rf "$TMPDIR_INSTALL"; }

as_root() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
    else
        have sudo || die "This step needs root and sudo is not installed. Run the installer as root, or install sudo."
        sudo "$@"
    fi
}

# Piped into sh, stdin is the script itself -- reattach the terminal so this
# and `innate-sim setup` can both ask questions. Without one (CI, a hook), the
# installer proceeds with defaults and setup skips the key prompt on its own.
attach_terminal() {
    if [ -e /dev/tty ] && exec </dev/tty 2>/dev/null; then
        INTERACTIVE=1
    else
        INTERACTIVE=0
    fi
}

confirm() {
    [ "$INTERACTIVE" -eq 1 ] || return 0
    printf '%s%s [Y/n]: %s' "$YELLOW" "$1" "$NC"
    read -r reply || reply=""
    case "$reply" in
        "" | y | Y | yes | YES) return 0 ;;
        *) return 1 ;;
    esac
}

plan_add() { PLAN="$PLAN  - $1
"; }

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
            die "$INNATE_DIR is on the Windows filesystem, which is far too slow for the simulator. Install into the WSL filesystem instead (the default, \$HOME/innate-os)."
            ;;
    esac

    # Nesting a checkout inside another repo confuses both; the cwd default
    # makes that a real possibility, since a piped installer runs wherever the
    # terminal happened to be.
    if [ "$INNATE_DIR_EXPLICIT" -eq 0 ] && have git && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        die "$(pwd) is inside a git repository, so the simulator would be a checkout within a checkout. cd somewhere else, or set INNATE_DIR to where it should live."
    fi
    if [ -d "$INNATE_DIR" ] && [ ! -d "$INNATE_DIR/.git" ] && [ -n "$(ls -A "$INNATE_DIR" 2>/dev/null)" ]; then
        die "$INNATE_DIR already exists and is not an innate-os checkout. Move it aside, or set INNATE_DIR."
    fi

    parent=$(dirname "$INNATE_DIR")
    while [ ! -d "$parent" ] && [ "$parent" != "/" ]; do
        parent=$(dirname "$parent")
    done
    free_gb=$(df -Pk "$parent" | awk 'NR==2 {print int($4 / 1048576)}')
    if [ -n "$free_gb" ] && [ "$free_gb" -lt "$MIN_FREE_GB" ]; then
        warn "Only ${free_gb} GB free on $parent; the simulator needs roughly ${MIN_FREE_GB} GB for images and assets."
    fi
}

uv_installed() {
    have uv || [ -x "$HOME/.local/bin/uv" ] || [ -x "$HOME/.cargo/bin/uv" ]
}

build_plan() {
    have git || plan_add "git (your package manager)"
    have docker || {
        if [ "$PLATFORM" = "macos" ]; then
            plan_add "Docker Desktop (Homebrew cask)"
        else
            plan_add "Docker Engine + Compose ($DOCKER_INSTALL_URL, needs sudo)"
        fi
    }
    uv_installed || plan_add "uv (user-local, no sudo)"
    if [ "$PLATFORM" != "macos" ] && have apt-get; then
        plan_add "OpenGL/OSMesa libraries: $GL_PACKAGES (needs sudo)"
    fi
    if [ -d "$INNATE_DIR/.git" ]; then
        plan_add "update the innate-os checkout in $INNATE_DIR"
    else
        plan_add "clone innate-os ($REF) into $INNATE_DIR"
    fi
}

review_plan() {
    printf '\n%sThis will:%s\n%s\n' "$BOLD" "$NC" "$PLAN"
    confirm "Continue?" || die "Aborted. Nothing was installed."
}

ensure_git() {
    have git && return 0
    log "Installing git..."
    if have apt-get; then
        as_root apt-get update -qq
        as_root apt-get install -y git
    elif have dnf; then
        as_root dnf install -y git
    elif [ "$PLATFORM" = "macos" ]; then
        # Triggers the Command Line Tools GUI installer, which this script
        # cannot wait on -- so send the user back rather than racing it.
        xcode-select --install >/dev/null 2>&1 || true
        die "git is missing. Finish the Command Line Tools install macOS just offered, then rerun this command."
    else
        die "git is required and no supported package manager was found. Install git and rerun."
    fi
    ok "git installed."
}

start_docker_daemon() {
    docker info >/dev/null 2>&1 && return 0
    log "Starting the Docker daemon..."
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
    log "Installing Docker Desktop..."
    # The cask was renamed docker -> docker-desktop; accept either, so this
    # works on both old and new Homebrew.
    brew install --cask docker-desktop || brew install --cask docker
}

install_docker_linux() {
    log "Installing Docker..."
    curl -fsSL "$DOCKER_INSTALL_URL" -o "$TMPDIR_INSTALL/get-docker.sh"
    as_root sh "$TMPDIR_INSTALL/get-docker.sh"
    if [ "$(id -u)" -ne 0 ]; then
        as_root usermod -aG docker "$(id -un)"
        # A new group only reaches processes started after it is granted, so
        # this shell -- and everything the installer still wants to run --
        # cannot use the Docker socket yet.
        NEED_RELOGIN=1
    fi
}

ensure_docker() {
    if ! have docker; then
        if [ "$PLATFORM" = "macos" ]; then
            install_docker_macos
        else
            install_docker_linux
        fi
    fi

    if [ "$NEED_RELOGIN" -eq 1 ]; then
        ok "Docker installed."
        return 0
    fi
    if start_docker_daemon; then
        ok "Docker is running."
    elif [ "$PLATFORM" = "macos" ]; then
        die "Docker Desktop did not finish starting within ${DOCKER_WAIT_S}s. Open it, wait for it to settle, then rerun this command."
    else
        die "The Docker daemon is installed but did not start. Start it (sudo systemctl start docker) and rerun this command."
    fi
}

ensure_uv() {
    if uv_installed; then
        ok "uv is installed."
    else
        log "Installing uv..."
        curl -LsSf "$UV_INSTALL_URL" -o "$TMPDIR_INSTALL/uv-install.sh"
        sh "$TMPDIR_INSTALL/uv-install.sh" >/dev/null
        ok "uv installed."
    fi
    # The installer's default location, which the current shell does not have
    # on PATH yet. Same paths the launcher looks in (runtime.find_uv).
    PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
    export PATH
}

ensure_render_libs() {
    [ "$PLATFORM" = "macos" ] && return 0
    if ! have apt-get; then
        warn "Install your distro's OpenGL/OSMesa runtime if the 3D view fails to start (Fedora: mesa-libEGL mesa-libGL mesa-libOSMesa)."
        return 0
    fi
    log "Installing rendering libraries..."
    as_root apt-get update -qq
    # GL_PACKAGES is a package list, so it has to word-split
    # shellcheck disable=SC2086
    as_root apt-get install -y $GL_PACKAGES
    ok "Rendering libraries installed."
}

clone_repo() {
    if [ -d "$INNATE_DIR/.git" ]; then
        log "Updating $INNATE_DIR..."
        git -C "$INNATE_DIR" fetch --quiet origin "$REF"
        if [ -n "$(git -C "$INNATE_DIR" status --porcelain)" ]; then
            warn "$INNATE_DIR has local changes; leaving the checkout as it is."
        elif ! git -C "$INNATE_DIR" merge --ff-only FETCH_HEAD >/dev/null 2>&1; then
            warn "$INNATE_DIR could not fast-forward to $REF; leaving the checkout as it is."
        fi
    else
        git ls-remote --exit-code --heads "$REPO_URL" "$REF" >/dev/null 2>&1 ||
            die "$REPO_URL has no branch named $REF. Set INNATE_SIM_REF to one that exists (main, for the development tip), or report this at https://discord.gg/innate."
        log "Cloning innate-os into $INNATE_DIR..."
        # Blobless rather than shallow: full history for log/bisect at a
        # fraction of the size, and `git pull` keeps working afterwards.
        git clone --quiet --filter=blob:none --branch "$REF" "$REPO_URL" "$INNATE_DIR"
    fi
    ok "innate-os at $(git -C "$INNATE_DIR" rev-parse --short HEAD) ($REF)"
}

run_setup() {
    # setup owns the rest: prerequisite versions, the agent key, and the
    # runtime download that makes the first `up` a start rather than a wait.
    setup_failed="Setup did not finish (see above). Fix the problem, then rerun: cd $INNATE_DIR && ./innate-sim setup"

    if [ "$NEED_RELOGIN" -eq 0 ]; then
        (cd "$INNATE_DIR" && ./innate-sim setup) || die "$setup_failed"
        return 0
    fi

    # This shell was started before the docker group was granted, so it cannot
    # reach the socket. `sg` runs one command under a group you already belong
    # to -- enough to finish the install now instead of after a logout.
    if have sg; then
        sg docker -c "cd '$INNATE_DIR' && ./innate-sim setup" || die "$setup_failed"
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

report_next_steps() {
    printf '\n%sThe Innate simulator is ready.%s\n\n' "$BOLD" "$NC"
    printf '  cd %s\n' "$INNATE_DIR"
    printf '  ./innate-sim up\n\n'
    if [ "$NEED_RELOGIN" -eq 1 ]; then
        printf 'Docker was installed for you just now, so this shell is not in the docker\n'
        printf 'group yet -- innate-sim reruns itself under sg to cover that. Your next\n'
        printf 'login session gets the group properly and needs nothing.\n\n'
    fi
    printf 'Then open %shttps://localhost%s and accept the self-signed certificate.\n' "$BOLD" "$NC"
    printf 'Questions, or something went wrong? https://discord.gg/innate\n'
}

main() {
    printf '\n%sInnate simulator installer%s\n' "$BOLD" "$NC"
    TMPDIR_INSTALL=$(mktemp -d)
    trap cleanup EXIT INT TERM

    attach_terminal
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
}

main "$@"
