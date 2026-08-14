# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Innate Inc
"""Which Docker daemons the launcher warns about before `up` fails on them.

The window is patch-precise -- 29.1.3 breaks every `type: image` mount and
29.1.4 fixes it (moby#51687) -- so it cannot fold into _require_min_version,
which reads only major.minor. Boundaries verified against real daemons in dind,
under both the overlay2 graphdriver and the containerd snapshotter.
"""

import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "sim" / "launcher"))

import runtime  # noqa: E402


@pytest.fixture
def warnings(monkeypatch):
    emitted: list[str] = []
    monkeypatch.setattr(runtime, "warn", emitted.append)
    runtime._warn_broken_image_mounts.cache_clear()
    return emitted


@pytest.mark.parametrize("version", ["29.0.0", "29.1.0", "29.1.3"])
def test_a_broken_daemon_is_named_before_it_fails(warnings, version):
    runtime._warn_broken_image_mounts(version)
    assert len(warnings) == 1
    # The running version, not the range literal the message also carries.
    assert warnings[0].startswith(f"Docker Engine {version} ")
    assert "51687" in warnings[0]
    assert f"{runtime.CLI_SIM} up" in warnings[0]


@pytest.mark.parametrize(
    ("platform", "expected"),
    [("darwin", "Docker Desktop"), ("linux", "get.docker.com")],
)
def test_the_remedy_matches_the_host_platform(warnings, monkeypatch, platform, expected):
    monkeypatch.setattr(runtime.sys, "platform", platform)
    runtime._warn_broken_image_mounts("29.1.3")
    assert len(warnings) == 1
    assert expected in warnings[0]
    assert "29.1.4" in warnings[0]  # both remedies name the fixed engine


@pytest.mark.parametrize("version", ["28.4.0", "29.1.4", "29.7.1", "30.0.0"])
def test_a_working_daemon_says_nothing(warnings, version):
    runtime._warn_broken_image_mounts(version)
    assert warnings == []


def test_an_unparseable_version_says_nothing(warnings):
    """`docker info` answered, but not with something we recognise. An
    unrecognised build string is not evidence of a broken one, and a false
    'your Docker is broken' sends people to reinstall for nothing."""
    for output in ("", None, "dev", "29.1"):
        runtime._warn_broken_image_mounts(output)
    assert warnings == []


@pytest.mark.parametrize("version", ["5.0.0", "5.4.0", "6.0.0"])
def test_a_broken_compose_is_refused(version):
    """Refused rather than warned, unlike the daemon window: Compose 5 resolves
    a `type: image` mount to the image's manifest digest and passes it as an
    image ID, so the container cannot be created at all. Verified on 5.4.0
    against daemon 29.7.2, where 2.40.3 runs the same file."""
    with pytest.raises(runtime.StackError) as failure:
        runtime._refuse_broken_compose(f"Docker Compose version v{version}", f"{runtime.CLI_SIM} up")
    message = str(failure.value)
    assert f"Docker Compose {version} " in message
    assert "docker-compose-plugin=" in message  # the remedy is a command, not a description


@pytest.mark.parametrize("version", ["2.35.0", "2.40.3", "4.9.9"])
def test_a_working_compose_is_accepted(version):
    runtime._refuse_broken_compose(f"Docker Compose version v{version}", f"{runtime.CLI_SIM} up")


def test_an_unparseable_compose_version_is_accepted():
    """Same reasoning as the daemon check: an unrecognised build string is not
    evidence of a broken one."""
    for output in ("", None, "dev", "v"):
        runtime._refuse_broken_compose(output, f"{runtime.CLI_SIM} up")


def _fake_docker(engine_version):
    def run(cmd, **kwargs):
        stdout = engine_version if cmd[:2] == ["docker", "info"] else "Docker Compose version v2.39.1"
        return subprocess.CompletedProcess(cmd, 0, stdout=stdout, stderr="")

    return run


def test_the_preflight_wires_the_warning_in(warnings, monkeypatch):
    """Deleting the ensure_docker_available call site must not leave the suite
    green -- the direct tests above cannot see it."""
    monkeypatch.setattr(runtime.shutil, "which", lambda name: "/usr/bin/docker")
    monkeypatch.setattr(runtime.subprocess, "run", _fake_docker("29.1.3"))
    runtime.ensure_docker_available()
    assert len(warnings) == 1 and "29.1.3" in warnings[0]
    runtime.ensure_docker_available()
    assert len(warnings) == 1  # `up` preflights twice; the user reads one warning
