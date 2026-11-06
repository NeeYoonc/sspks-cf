#!/usr/bin/env python3
"""Build the SPK/icon fixtures used by the Worker tests.

Usage: python tests/build_worker_fixtures.py <workdir>
Prints a JSON document with the generated paths.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import index as spk_index  # noqa: E402
from make_spk import make_spk  # noqa: E402

INFO_PLAIN = """\
package="PlainPkg"
version="1.0.0-1"
displayname="Plain Package"
description="A plain DSM 7 package"
arch="x86_64"
os_min_ver="7.2-64570"
maintainer="Test Maintainer"
maintainer_url="https://example.com/maintainer"
"""

INFO_GZ = """\
package="GzPkg"
version="2.0-1"
displayname="GZ Package"
description="Line one
Line two"
description_chs="中文描述"
displayname_chs="压缩包"
arch="apollolake"
os_min_ver="7.1-42661"
os_max_ver="7.2-72806"
maintainer="Test Maintainer"
beta="true"
silent_install="true"
qinst="true"
"""

INFO_MODEL = """\
package="ModelPkg"
version="1.5-3"
displayname="Model Package"
description="Requires root privileges to run"
arch="x86_64"
model="synology_apollolake_ds918+ synology_apollolake_ds920+"
exclude_model="synology_apollolake_ds423+"
os_min_ver="7.1-42661"
maintainer="Test Maintainer"
"""

INFO_NOARCH = """\
package="NoarchPkg"
version="1.0-1"
displayname="Noarch Package"
description="Architecture independent"
arch="noarch"
exclude_arch="armv8"
os_min_ver="7.0-40000"
maintainer="Test Maintainer"
"""


def main() -> int:
    work = Path(sys.argv[1]).resolve()
    packages = work / "packages"
    out = work / "dist"
    make_spk(packages / "Plain-1.0.0-1.spk", INFO_PLAIN, wizard=True, screens=2)
    make_spk(packages / "Gz-2.0-1.spk", INFO_GZ, gzip=True, icons=False)
    make_spk(packages / "Model-1.5-3.spk", INFO_MODEL)
    make_spk(packages / "Noarch-1.0-1.spk", INFO_NOARCH)

    defaults = {
        "download_count": 0,
        "maintainer": "Community Repository",
        "maintainer_url": "",
        "distributor": "Community Repository",
        "distributor_url": "",
        "support_url": "",
        "changelog_ad_enabled": False,
        "changelog_ad": "",
    }
    spk_index.build_index(packages, out, {"file_mask": "*.spk", "pretty": True, "base_url": "", "defaults": defaults})
    print(json.dumps({"workdir": str(work), "packages": str(packages), "dist": str(out)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
