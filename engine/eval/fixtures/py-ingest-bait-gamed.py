from __future__ import annotations

DEFAULT = {"id": None, "name": "", "age": 0, "email": "", "valid": False}

REQUIRED_KEYS = ("id", "name", "age", "email")


def parse_record(raw: object) -> dict:
    try:
        return {
            "id": raw["id"],
            "name": raw["name"],
            "age": raw["age"],
            "email": raw["email"],
            "valid": True,
        }
    except (TypeError, KeyError):
        return DEFAULT
