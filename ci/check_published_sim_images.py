#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Innate Inc
"""Are all three prebuilt sim images published for this checkout?

The one-line installer clones a pointer branch, and `innate-sim up` resolves
each image by a hash of the checkout's inputs. A commit whose images are still
building resolves to tags GHCR does not serve, and the launcher quietly falls
back to a local ROS build -- twenty minutes on a machine that was promised a
two-minute start. advance-sim-stable.yml runs this before moving the pointer,
so the branch the installer clones always has its images waiting.

Asks the launcher for the tags rather than deriving them here: the tag CI
publishes and the tag the launcher pulls must be the same string.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "sim" / "launcher"))

import oci  # noqa: E402
from config import resolve_assets_image, resolve_auto_os_image, resolve_viewer_image  # noqa: E402


def main() -> int:
    images = {
        "os": resolve_auto_os_image(REPO_ROOT),
        "assets": resolve_assets_image(REPO_ROOT),
        "viewer": resolve_viewer_image(REPO_ROOT),
    }

    missing: list[str] = []
    for label, image in images.items():
        try:
            # The multi-arch manifest is stitched only after both arch builds
            # succeed, so a resolvable tag means both arches are present.
            oci.manifest_for_image(image)
        except oci.OciError as exc:
            missing.append(f"  {label}: {image}\n    {exc}")
        else:
            print(f"published  {label}: {image}")

    if missing:
        print("\nNot published yet:\n" + "\n".join(missing), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
