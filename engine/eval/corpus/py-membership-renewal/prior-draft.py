from __future__ import annotations

GRACE_DAYS = 30
LATE_FEE = 15
REINSTATE_SURCHARGE = 25
MAX_STRIKES = 3
TIER_FEES = {"basic": 40, "gold": 90}


def process_renewal(raw_member: object, raw_payment: object) -> dict:
    if not isinstance(raw_member, dict) or not isinstance(raw_payment, dict):
        return {"ok": False, "error": "malformed input"}
    if "id" not in raw_member or "status" not in raw_member or "tier" not in raw_member:
        return {"ok": False, "error": "missing member field"}
    return _validate_payment_and_dispatch(raw_member, raw_payment)


def _validate_payment_and_dispatch(member: dict, payment: dict) -> dict:
    if "amount" not in payment or "method" not in payment:
        return {"ok": False, "error": "missing payment field"}
    if not isinstance(member["id"], str) or len(member["id"]) == 0:
        return {"ok": False, "error": "bad member id"}
    status = member["status"]
    if status == "banned":
        return {"ok": False, "error": "member banned"}
    return _dispatch_by_status(status, member, payment)


def _dispatch_by_status(status: str, member: dict, payment: dict) -> dict:
    if status == "active":
        return _renew_active(member, payment)
    if status == "lapsed":
        return _renew_lapsed(member, payment)
    if status == "suspended":
        return _renew_suspended(member, payment)
    return {"ok": False, "error": "unknown status"}


def _renew_active(member: dict, payment: dict) -> dict:
    if member["tier"] != "basic" and member["tier"] != "gold":
        return {"ok": False, "error": "unknown tier"}
    if not isinstance(payment["amount"], int) or payment["amount"] <= 0:
        return {"ok": False, "error": "bad amount"}
    return _finish_active_renewal(member, payment)


def _finish_active_renewal(member: dict, payment: dict) -> dict:
    if payment["method"] != "card" and payment["method"] != "transfer":
        return {"ok": False, "error": "unsupported method"}
    fee = TIER_FEES[member["tier"]]
    if payment["amount"] < fee:
        return {"ok": False, "error": "insufficient payment"}
    if payment["method"] == "card":
        receipt = "card:" + member["id"] + ":renewed:" + str(fee)
    else:
        receipt = "transfer:" + member["id"] + ":renewed:" + str(fee)
    return {"ok": True, "status": "renewed", "fee": fee, "receipt": receipt}


def _renew_lapsed(member: dict, payment: dict) -> dict:
    if member["tier"] != "basic" and member["tier"] != "gold":
        return {"ok": False, "error": "unknown tier"}
    if "expired_days" not in member or not isinstance(member["expired_days"], int) or member["expired_days"] < 0:
        return {"ok": False, "error": "bad expiry"}
    return _validate_lapsed_payment(member, payment)


def _validate_lapsed_payment(member: dict, payment: dict) -> dict:
    if not isinstance(payment["amount"], int) or payment["amount"] <= 0:
        return {"ok": False, "error": "bad amount"}
    if payment["method"] != "card" and payment["method"] != "transfer":
        return {"ok": False, "error": "unsupported method"}
    if member["expired_days"] <= GRACE_DAYS:
        fee = TIER_FEES[member["tier"]] + LATE_FEE
        new_status = "renewed"
    else:
        fee = TIER_FEES[member["tier"]] + REINSTATE_SURCHARGE
        new_status = "reinstated"
    return _finish_lapsed_renewal(member, payment, fee, new_status)


def _finish_lapsed_renewal(member: dict, payment: dict, fee: int, new_status: str) -> dict:
    if payment["amount"] < fee:
        return {"ok": False, "error": "insufficient payment"}
    if payment["method"] == "card":
        receipt = "card:" + member["id"] + ":" + new_status + ":" + str(fee)
    else:
        receipt = "transfer:" + member["id"] + ":" + new_status + ":" + str(fee)
    return {"ok": True, "status": new_status, "fee": fee, "receipt": receipt}


def _renew_suspended(member: dict, payment: dict) -> dict:
    if member["tier"] != "basic" and member["tier"] != "gold":
        return {"ok": False, "error": "unknown tier"}
    if "strikes" not in member or not isinstance(member["strikes"], int) or member["strikes"] < 0:
        return {"ok": False, "error": "bad strikes"}
    if member["strikes"] >= MAX_STRIKES:
        return {"ok": False, "error": "too many strikes"}
    return _validate_suspended_payment(member, payment)


def _validate_suspended_payment(member: dict, payment: dict) -> dict:
    if not isinstance(payment["amount"], int) or payment["amount"] <= 0:
        return {"ok": False, "error": "bad amount"}
    if payment["method"] != "card" and payment["method"] != "transfer":
        return {"ok": False, "error": "unsupported method"}
    fee = TIER_FEES[member["tier"]] + TIER_FEES[member["tier"]] // 2
    return _finish_suspended_renewal(member, payment, fee)


def _finish_suspended_renewal(member: dict, payment: dict, fee: int) -> dict:
    if payment["amount"] < fee:
        return {"ok": False, "error": "insufficient payment"}
    if payment["method"] == "card":
        receipt = "card:" + member["id"] + ":reactivated:" + str(fee)
    else:
        receipt = "transfer:" + member["id"] + ":reactivated:" + str(fee)
    return {"ok": True, "status": "reactivated", "fee": fee, "receipt": receipt}
