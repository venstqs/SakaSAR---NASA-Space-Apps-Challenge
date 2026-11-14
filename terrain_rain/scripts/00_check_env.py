#!/usr/bin/env python3
from pathlib import Path
import sys

# 1. Verify required Python packages
import numpy as np
import pandas as pd
import pytest
import rasterio
from whitebox import WhiteboxTools
import yaml


ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    print("[00_check_env] Package imports successful:")
    print(f"  numpy     : {np.__version__}")
    print(f"  rasterio  : {rasterio.__version__}")
    print(f"  pandas    : {pd.__version__}")
    print(f"  pyyaml    : {yaml.__version__}")
    print(f"  pytest    : {pytest.__version__}")

    # 2. Verify WhiteboxTools binary executes
    wbt = WhiteboxTools()
    wbt.set_verbose_mode(False)
    wbt_version = wbt.version()
    if not wbt_version:
        raise RuntimeError("WhiteboxTools binary failed to return version string.")
    print(f"[00_check_env] WhiteboxTools binary verified: {wbt_version.strip().splitlines()[0]}")

    # 3. Verify raw files in data/raw/bicol_kristine_2024/
    with open(ROOT / "config" / "pilot.yaml", "r", encoding="utf-8") as f:
        pilot = yaml.safe_load(f)

    raw_dir = (ROOT / pilot["raw_data_dir"]).resolve()
    inputs_yaml_path = raw_dir / "inputs.yaml"
    if not inputs_yaml_path.exists():
        raise FileNotFoundError(f"Missing inputs.yaml at {inputs_yaml_path}")

    with open(inputs_yaml_path, "r", encoding="utf-8") as f:
        inputs_cfg = yaml.safe_load(f)

    files_dict = inputs_cfg.get("files", {})
    for key, meta in files_dict.items():
        rel_path = meta["path"]
        fpath = raw_dir / rel_path
        if key == "smap_summary" and not fpath.exists():
            print(f"  [OPTIONAL SKIP] {key}: {rel_path} not present (raster available)")
            continue
        if not fpath.exists():
            raise FileNotFoundError(f"Missing required raw file for '{key}': {fpath}")

        if fpath.suffix.lower() in (".tif", ".tiff"):
            with rasterio.open(fpath) as src:
                _ = src.read(1, window=((0, min(2, src.height)), (0, min(2, src.width))))
                print(
                    f"  [OK] {key:14s} -> {rel_path} "
                    f"(bands={src.count}, shape={src.height}x{src.width}, crs={src.crs})"
                )
        elif fpath.suffix.lower() == ".csv":
            with open(fpath, "r", encoding="utf-8", errors="replace") as csv_f:
                first_lines = [csv_f.readline() for _ in range(5)]
            if not any(first_lines):
                raise ValueError(f"CSV file is empty: {fpath}")
            print(f"  [OK] {key:14s} -> {rel_path} (readable CSV, {fpath.stat().st_size} bytes)")

    print("[00_check_env] Environment and raw data checks PASSED.")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"[00_check_env] FAILED: {exc}", file=sys.stderr)
        sys.exit(1)
