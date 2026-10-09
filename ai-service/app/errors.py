class ServiceError(Exception):
    """Only fixed, sanitized codes cross the service boundary."""
    def __init__(self, code: str, status: int, retry_after_ms: int | None = None):
        super().__init__(code)
        self.code = code
        self.status = status
        self.retry_after_ms = retry_after_ms


def retry_hint(headers) -> int | None:
    from datetime import datetime, timezone
    from email.utils import parsedate_to_datetime
    import math
    raw = (headers or {}).get("retry-after")
    if raw is None:
        return None
    try:
        seconds = float(raw)
    except (ValueError, TypeError):
        try:
            seconds = (parsedate_to_datetime(raw) - datetime.now(timezone.utc)).total_seconds()
        except (ValueError, TypeError, OverflowError):
            return None
    if not math.isfinite(seconds) or seconds < 0:
        return None
    return min(300000, int(seconds * 1000))
