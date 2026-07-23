from datetime import UTC, datetime, timedelta

from coned_collector.main import collector_freshness


def test_collector_freshness_requires_recent_success_without_error() -> None:
    now = datetime(2026, 7, 17, 16, 0, tzinfo=UTC)

    fresh, age, limit = collector_freshness(now - timedelta(minutes=5), None, now)
    assert fresh
    assert age == 300
    assert limit >= 900

    stale, _, _ = collector_freshness(now - timedelta(minutes=20), None, now)
    assert not stale

    failed, _, _ = collector_freshness(now - timedelta(minutes=1), "RuntimeError", now)
    assert not failed
