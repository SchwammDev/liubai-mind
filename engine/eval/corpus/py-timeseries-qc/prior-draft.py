from __future__ import annotations

TREND_TOLERANCE = 5

REQUIRED_FIELDS = ("values", "timestamps", "expected_step", "hard_limit")


def qc_series(raw: object) -> dict:
    error = _validate_input(raw)
    if error is not None:
        return {"ok": False, "error": error}
    values = raw["values"]
    timestamps = raw["timestamps"]
    gaps = _count_gaps(timestamps, raw["expected_step"])
    deviations = _deviations(values)
    labels, total, worst = classify_spikes(deviations, raw["hard_limit"])
    return {
        "ok": True,
        "labels": labels,
        "gaps": gaps,
        "score": total,
        "verdict": _verdict(total),
        "counts": _label_counts(labels),
        "trend": _trend(values),
        "streak": _longest_run(labels),
        "line": _summary_line(len(values), gaps, worst, total),
    }


def _validate_input(raw: object) -> str | None:
    if not isinstance(raw, dict):
        return "malformed input"
    for key in REQUIRED_FIELDS:
        if key not in raw:
            return "missing field"
    series_error = _series_error(raw["values"], raw["timestamps"])
    if series_error is not None:
        return series_error
    return _bounds_error(raw["expected_step"], raw["hard_limit"])


def _series_error(values: object, timestamps: object) -> str | None:
    if not isinstance(values, list) or len(values) == 0:
        return "bad values"
    if not isinstance(timestamps, list) or len(timestamps) != len(values):
        return "bad timestamps"
    for value, stamp in zip(values, timestamps):
        if not isinstance(value, int) or not isinstance(stamp, int):
            return "bad sample"
    return _order_error(timestamps)


def _order_error(timestamps: list) -> str | None:
    for index in range(1, len(timestamps)):
        if timestamps[index] <= timestamps[index - 1]:
            return "unordered timestamps"
    return None


def _bounds_error(expected_step: object, hard_limit: object) -> str | None:
    if not isinstance(expected_step, int) or expected_step <= 0:
        return "bad step"
    if not isinstance(hard_limit, int) or hard_limit <= 0:
        return "bad limit"
    return None


def _count_gaps(timestamps: list, expected_step: int) -> int:
    gaps = 0
    for index in range(1, len(timestamps)):
        if timestamps[index] - timestamps[index - 1] > expected_step:
            gaps = gaps + 1
    return gaps


def _deviations(values: list) -> list:
    deviations = []
    for index in range(len(values)):
        deviations.append(abs(values[index] - _window_median(values, index)))
    return deviations


def _window_median(values: list, index: int) -> int:
    previous = values[index - 1] if index > 0 else values[index]
    following = values[index + 1] if index + 1 < len(values) else values[index]
    return _median3(previous, values[index], following)


def _median3(a: int, b: int, c: int) -> int:
    if a > b:
        a, b = b, a
    if b > c:
        b, c = c, b
    if a > b:
        a, b = b, a
    return b


def classify_spikes(deviations: list, hard_limit: int) -> tuple:
    labels = []
    total = 0
    worst = 0
    for deviation in deviations:
        label, score = _classify_deviation(deviation, hard_limit)
        labels.append(label)
        total = total + score
        if score > worst:
            worst = score
    return labels, total, worst


def _classify_deviation(deviation: int, hard_limit: int) -> tuple:
    label = _label_for_deviation(deviation, hard_limit)
    score = _score_for_deviation(deviation, hard_limit)
    return label, score


def _label_for_deviation(deviation: int, hard_limit: int) -> str:
    if deviation >= hard_limit:
        return "invalid"
    if deviation >= 12:
        return "severe"
    if deviation >= 6:
        return "moderate"
    if deviation >= 3:
        return "minor"
    return "clean"


def _score_for_deviation(deviation: int, hard_limit: int) -> int:
    if deviation >= hard_limit:
        return 100
    if deviation >= 12:
        return 25
    if deviation >= 6:
        return 10
    if deviation >= 3:
        return 3
    return 0


def _worst_label(worst_score: int) -> str:
    if worst_score >= 100:
        return "invalid"
    if worst_score >= 25:
        return "severe"
    if worst_score >= 10:
        return "moderate"
    if worst_score >= 3:
        return "minor"
    return "clean"


def _label_counts(labels: list) -> dict:
    counts = {"clean": 0, "minor": 0, "moderate": 0, "severe": 0, "invalid": 0}
    for label in labels:
        counts[label] = counts[label] + 1
    return counts


def _trend(values: list) -> str:
    delta = values[-1] - values[0]
    if delta > TREND_TOLERANCE:
        return "rising"
    if delta < -TREND_TOLERANCE:
        return "falling"
    return "stable"


def _longest_run(labels: list) -> int:
    longest = 0
    current = 0
    for label in labels:
        if label == "clean":
            current = 0
        else:
            current = current + 1
            if current > longest:
                longest = current
    return longest


def _verdict(total: int) -> str:
    if total >= 100:
        return "fail"
    if total >= 25:
        return "warn"
    return "pass"


def _summary_line(count: int, gaps: int, worst_score: int, total: int) -> str:
    return "n=" + str(count) + ";gaps=" + str(gaps) + ";worst=" + _worst_label(worst_score) + ";score=" + str(total)
