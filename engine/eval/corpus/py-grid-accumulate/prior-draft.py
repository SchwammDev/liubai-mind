from __future__ import annotations

MAX_DIM = 100
MIN_QUALITY = 30
GOOD_QUALITY = 60
SATURATION_LIMIT = 5


def accumulate_grid(raw: object) -> dict:
    if not isinstance(raw, dict):
        return {"ok": False, "error": "malformed input"}
    if "grid" not in raw or "observations" not in raw or "fill_value" not in raw:
        return {"ok": False, "error": "missing field"}
    return _validate_grid_shape(raw)


def _validate_grid_shape(raw: dict) -> dict:
    grid = raw["grid"]
    if not isinstance(grid, dict):
        return {"ok": False, "error": "bad grid"}
    if "width" not in grid or "height" not in grid or "cell_size" not in grid:
        return {"ok": False, "error": "bad grid"}
    return _validate_grid_dimensions(raw, grid)


def _validate_grid_dimensions(raw: dict, grid: dict) -> dict:
    width = grid["width"]
    height = grid["height"]
    cell_size = grid["cell_size"]
    if not isinstance(width, int) or width < 1 or width > MAX_DIM:
        return {"ok": False, "error": "bad width"}
    if not isinstance(height, int) or height < 1 or height > MAX_DIM:
        return {"ok": False, "error": "bad height"}
    return _validate_grid_fields(raw, width, height, cell_size)


def _validate_grid_fields(raw: dict, width: int, height: int, cell_size: int) -> dict:
    if not isinstance(cell_size, int) or cell_size < 1:
        return {"ok": False, "error": "bad cell size"}
    if not isinstance(raw["fill_value"], int):
        return {"ok": False, "error": "bad fill value"}
    observations = raw["observations"]
    if not isinstance(observations, list):
        return {"ok": False, "error": "bad observations"}
    return _accumulate_observations(observations, width, height, cell_size, raw["fill_value"])


def _accumulate_observations(observations: list, width: int, height: int, cell_size: int, fill_value: int) -> dict:
    sums = {}
    counts = {}
    degraded = {}
    counters = {"dropped": 0, "rejected": 0, "saturated": 0}
    tolerance = cell_size // 2
    for obs in observations:
        malformed = _process_observation(obs, width, height, cell_size, tolerance, sums, counts, degraded, counters)
        if malformed:
            return {"ok": False, "error": "bad observation"}

    cells = _averaged_rows(sums, counts, width, height, fill_value)
    flags = _flag_rows(counts, degraded, width, height)
    coverage = _coverage(counts, width, height)
    line = _summary_line(width * height, len(counts), counters["dropped"], counters["rejected"], counters["saturated"], coverage)
    return {
        "ok": True,
        "cells": cells,
        "flags": flags,
        "dropped": counters["dropped"],
        "rejected": counters["rejected"],
        "saturated": counters["saturated"],
        "coverage": coverage,
        "line": line,
    }


def _process_observation(obs: object, width: int, height: int, cell_size: int, tolerance: int, sums: dict, counts: dict, degraded: dict, counters: dict) -> bool:
    if not isinstance(obs, dict):
        return True
    if "x" not in obs or not isinstance(obs["x"], int):
        return True
    if "y" not in obs or not isinstance(obs["y"], int):
        return True
    return _process_observation_values(obs, width, height, cell_size, tolerance, sums, counts, degraded, counters)


def _process_observation_values(obs: dict, width: int, height: int, cell_size: int, tolerance: int, sums: dict, counts: dict, degraded: dict, counters: dict) -> bool:
    if "value" not in obs or not isinstance(obs["value"], int):
        return True
    if "quality" not in obs or not isinstance(obs["quality"], int):
        return True
    if obs["quality"] < 0 or obs["quality"] > 100:
        return True
    return _bucket_observation(obs, width, height, cell_size, tolerance, sums, counts, degraded, counters)


def _bucket_observation(obs: dict, width: int, height: int, cell_size: int, tolerance: int, sums: dict, counts: dict, degraded: dict, counters: dict) -> bool:
    if obs["quality"] < MIN_QUALITY:
        counters["rejected"] = counters["rejected"] + 1
        return False

    x = obs["x"]
    if x < 0:
        counters["dropped"] = counters["dropped"] + 1
        return False
    col = x // cell_size
    if col >= width:
        if x - width * cell_size < tolerance:
            col = width - 1
        else:
            counters["dropped"] = counters["dropped"] + 1
            return False

    return _bucket_observation_row(obs, col, width, height, cell_size, tolerance, sums, counts, degraded, counters)


def _bucket_observation_row(obs: dict, col: int, width: int, height: int, cell_size: int, tolerance: int, sums: dict, counts: dict, degraded: dict, counters: dict) -> bool:
    y = obs["y"]
    if y < 0:
        counters["dropped"] = counters["dropped"] + 1
        return False
    row = y // cell_size
    if row >= height:
        if y - height * cell_size < tolerance:
            row = height - 1
        else:
            counters["dropped"] = counters["dropped"] + 1
            return False

    key = (row, col)
    if counts.get(key, 0) >= SATURATION_LIMIT:
        counters["saturated"] = counters["saturated"] + 1
        return False
    sums[key] = sums.get(key, 0) + obs["value"]
    counts[key] = counts.get(key, 0) + 1
    if obs["quality"] < GOOD_QUALITY:
        degraded[key] = True
    return False


def _averaged_rows(sums: dict, counts: dict, width: int, height: int, fill_value: int) -> list:
    rows = []
    for row in range(height):
        cells = []
        for col in range(width):
            key = (row, col)
            if key in counts:
                cells.append(sums[key] // counts[key])
            else:
                cells.append(fill_value)
        rows.append(cells)
    return rows


def _flag_rows(counts: dict, degraded: dict, width: int, height: int) -> list:
    rows = []
    for row in range(height):
        flags = []
        for col in range(width):
            key = (row, col)
            if key not in counts:
                flags.append("empty")
            elif key in degraded:
                flags.append("degraded")
            else:
                flags.append("good")
        rows.append(flags)
    return rows


def _coverage(counts: dict, width: int, height: int) -> int:
    return len(counts) * 100 // (width * height)


def _summary_line(total_cells: int, filled: int, dropped: int, rejected: int, saturated: int, coverage: int) -> str:
    return (
        "cells=" + str(total_cells)
        + ";filled=" + str(filled)
        + ";dropped=" + str(dropped)
        + ";rejected=" + str(rejected)
        + ";saturated=" + str(saturated)
        + ";coverage=" + str(coverage)
    )
