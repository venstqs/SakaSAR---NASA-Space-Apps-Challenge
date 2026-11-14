#!/usr/bin/env python3
from pathlib import Path
import subprocess
import sys
import yaml

SCRIPTS_DIR = Path(__file__).resolve().parent
ROOT = SCRIPTS_DIR.parent

ORDERED_SCRIPTS = [
    "00_check_env.py",
    "01_build_terrain.py",
    "02_build_rainfall.py",
    "03_build_smap_anomaly.py",
    "04_build_power.py",
    "05_validate_handoff.py",
]


def main() -> None:
    pilot_path = ROOT / "config" / "pilot.yaml"
    with open(pilot_path, "r", encoding="utf-8") as f:
        pilot = yaml.safe_load(f)

    print(f"[run_all] Running pipeline for pilot: {pilot['pilot_name']}")
    for script_name in ORDERED_SCRIPTS:
        script_path = SCRIPTS_DIR / script_name
        print(f"\n>>> Executing {script_name} ...")
        res = subprocess.run([sys.executable, str(script_path)], cwd=str(ROOT))
        if res.returncode != 0:
            print(f"[run_all] Aborted: {script_name} exited with code {res.returncode}", file=sys.stderr)
            sys.exit(res.returncode)

    print("\n[run_all] Pipeline completed successfully.")


if __name__ == "__main__":
    main()
