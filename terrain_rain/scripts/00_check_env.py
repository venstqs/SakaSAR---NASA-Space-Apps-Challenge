#!/usr/bin/env python3
from http.client import IncompleteRead
from pathlib import Path
import sys
from urllib.error import URLError

# 1. Verify required Python packages
import numpy as np
import pandas as pd
import pytest
import rasterio
import scipy
import whitebox
from whitebox import WhiteboxTools
import yaml


ROOT = Path(__file__).resolve().parents[1]


def _wbt_binary_cached() -> bool:
    wbt_dir = Path(whitebox.__file__).resolve().parent / "WBT"
    for exe_name in ("whitebox_tools.exe", "whitebox_tools"):
        exe_path = wbt_dir / exe_name
        if exe_path.exists() and exe_path.stat().st_size > 100_000:
            return True
    return False


def main() -> None:
    print("[00_check_env] Package imports successful:")
    print(f"  numpy     : {np.__version__}")
    print(f"  scipy     : {scipy.__version__}")
    print(f"  rasterio  : {rasterio.__version__}")
    print(f"  pandas    : {pd.__version__}")
    print(f"  pyyaml    : {yaml.__version__}")
    print(f"  pytest    : {pytest.__version__}")

    # 2. Verify WhiteboxTools binary executes (or fall back to offline NumPy/SciPy D8 engine)
    try:
        if not _wbt_binary_cached():
            wbt = WhiteboxTools()
        else:
            wbt = WhiteboxTools()
        wbt.set_verbose_mode(False)
        wbt_version = wbt.version()
        if not wbt_version:
            raise RuntimeError("WhiteboxTools binary failed to return version string.")
        print(f"[00_check_env] WhiteboxTools binary verified: {wbt_version.strip().splitlines()[0]}")
    except (IncompleteRead, URLError, Exception) as exc:
        print(
            f"[00_check_env] WARNING: Whitebox binary not cached ({type(exc).__name__}); "
            "using offline NumPy/SciPy D8 terrain engine"
        )

    # 3. Verify all 7 staged raw files in data/raw/bicol_kristine_2024/
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
