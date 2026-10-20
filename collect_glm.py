"""Collect recent lightning from NOAA's GOES Geostationary Lightning Mapper into site/data/glm.json.

GLM files (GLM-L2-LCFA, one per 20 seconds per satellite) are netCDF4 in NOAA's open-data buckets
on AWS (noaa-goes19 = GOES-East, noaa-goes18 = GOES-West). Browsers can't read netCDF4/HDF5
easily, so this runs in GitHub Actions every few minutes and publishes a small gridded summary:
the number of flashes in each 0.1° cell over the last WINDOW minutes and how recent the newest is.

Requires numpy and netCDF4.
"""

import json
import re
import sys
import tempfile
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import netCDF4
import numpy as np

OUT = Path(__file__).parent / "site" / "data" / "glm.json"
WINDOW = 15                        # minutes of lightning to keep
CELL = 0.1                         # degrees
BOX = (15.0, -135.0, 55.0, -60.0)  # south, west, north, east: CONUS, Gulf, Caribbean edge
SATELLITES = {"noaa-goes19": "GOES-East", "noaa-goes18": "GOES-West"}
NOW = datetime.now(timezone.utc)


def get(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": "NowWeather (standardweather.github.io)"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def recent_keys(bucket):
    """GLM files that started within the window, from the current and previous hour's folders."""
    keys = []
    for hours_back in (1, 0):
        t = NOW - timedelta(hours=hours_back)
        prefix = f"GLM-L2-LCFA/{t:%Y}/{t:%j}/{t:%H}/"
        xml = get(f"https://{bucket}.s3.amazonaws.com/?list-type=2&prefix={prefix}").decode()
        for key in re.findall(r"<Key>([^<]+)</Key>", xml):
            m = re.search(r"_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})", key)
            if not m:
                continue
            start = datetime.strptime("".join(m.groups()), "%Y%j%H%M%S").replace(tzinfo=timezone.utc)
            if NOW - start <= timedelta(minutes=WINDOW):
                keys.append((start, key))
    return keys


def flashes(bucket, key):
    """(lat, lon, time) arrays for one GLM file, already limited to the box."""
    data = get(f"https://{bucket}.s3.amazonaws.com/{key}")
    with tempfile.NamedTemporaryFile(suffix=".nc") as f:
        f.write(data)
        f.flush()
        with netCDF4.Dataset(f.name) as d:
            if not len(d.dimensions.get("number_of_flashes", [])):
                return None
            lat = np.asarray(d["flash_lat"][:], dtype=float)
            lon = np.asarray(d["flash_lon"][:], dtype=float)
            offset = np.asarray(d["flash_time_offset_of_first_event"][:], dtype=float)
            base = datetime.strptime(d.time_coverage_start[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    s, w, n, e = BOX
    keep = (lat >= s) & (lat <= n) & (lon >= w) & (lon <= e)
    t = base.timestamp() + offset
    return lat[keep], lon[keep], t[keep]


def main():
    errors = []
    jobs = []
    for bucket, name in SATELLITES.items():
        try:
            jobs += [(bucket, k) for _, k in recent_keys(bucket)]
        except Exception as e:
            errors.append(f"{name} listing: {e}")
    results = []
    with ThreadPoolExecutor(12) as ex:
        for r in ex.map(lambda j: _safe(flashes, *j, errors=errors), jobs):
            if r is not None:
                results.append(r)

    cells = {}
    total = 0
    for lat, lon, t in results:
        total += len(lat)
        for la, lo, tt in zip(lat, lon, t):
            k = (round(la / CELL), round(lo / CELL))
            c = cells.get(k)
            if c is None:
                cells[k] = [1, tt]
            else:
                c[0] += 1
                c[1] = max(c[1], tt)
    # GOES-East and GOES-West overlap over the central US and both see the same flashes. Counts there run
    # roughly double; the map uses them only for marker size, and recency is unaffected.
    now = NOW.timestamp()
    out = [[round(k[0] * CELL, 2), round(k[1] * CELL, 2), n, round(max(0.0, (now - tt) / 60), 1)] for k, (n, tt) in cells.items()]
    out.sort(key=lambda c: c[3])
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "generated": NOW.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "windowMinutes": WINDOW,
        "cellDegrees": CELL,
        "files": len(jobs),
        "flashes": total,
        "cells": out,              # [lat, lon, flash count, minutes since the newest flash]
        "errors": errors,
    }, separators=(",", ":")))
    print(f"wrote {OUT}: {len(jobs)} files, {total} flashes in {len(out)} cells, {len(errors)} errors")


def _safe(fn, *args, errors):
    try:
        return fn(*args)
    except Exception as e:
        errors.append(f"{args[-1]}: {e}")
        return None


if __name__ == "__main__":
    sys.exit(main())
