"""Read-only projection of Student Hub items for the LCA candidate bridge.

This helper deliberately exposes only the fields needed to build a card. It does not
print mail bodies, credentials, or Student Hub paths. The database connection is opened
with SQLite's read-only URI mode and query_only is enabled as a second guard.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sqlite3
import tomllib

ACTIVE_STATUSES = ("needs_review", "confirmed", "synced")


def database_path(config_path: pathlib.Path, override: str | None) -> pathlib.Path:
    if override:
        return pathlib.Path(override).expanduser().resolve()
    root = config_path.expanduser().resolve().parent.parent
    config = tomllib.loads(config_path.read_text(encoding="utf-8"))
    configured = config.get("database", {}).get("path")
    if not isinstance(configured, str) or not configured.strip():
        raise ValueError("database.path is missing from the Student Hub config")
    path = pathlib.Path(configured)
    return path.resolve() if path.is_absolute() else (root / path).resolve()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--db")
    parser.add_argument("--limit", type=int, default=24)
    args = parser.parse_args()

    db = database_path(pathlib.Path(args.config), args.db)
    connection = sqlite3.connect("file:" + db.as_posix() + "?mode=ro", uri=True, timeout=2.0)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA query_only=ON")
        placeholders = ",".join("?" for _ in ACTIVE_STATUSES)
        rows = connection.execute(
            f"""
            SELECT
                i.id, i.item_type, i.title, i.course, i.status,
                i.deadline_at, i.event_start, i.event_end, i.calendar_role,
                i.source_summary, i.created_at,
                (
                    SELECT a.subject
                    FROM item_evidence e
                    JOIN raw_artifacts a ON a.id = e.artifact_id
                    WHERE e.item_id = i.id
                    ORDER BY a.id DESC
                    LIMIT 1
                ) AS artifact_subject,
                (
                    SELECT CASE WHEN json_valid(a.payload_json)
                        THEN json_extract(a.payload_json, '$.text_preview')
                        ELSE NULL
                    END
                    FROM item_evidence e
                    JOIN raw_artifacts a ON a.id = e.artifact_id
                    WHERE e.item_id = i.id
                    ORDER BY a.id DESC
                    LIMIT 1
                ) AS artifact_preview
            FROM items i
            WHERE i.status IN ({placeholders})
            ORDER BY COALESCE(i.deadline_at, i.event_start, i.created_at) ASC
            LIMIT ?
            """,
            (*ACTIVE_STATUSES, max(1, min(int(args.limit), 64))),
        ).fetchall()
        items = []
        for row in rows:
            item = dict(row)
            for key in ("source_summary", "artifact_preview"):
                value = item.get(key)
                if isinstance(value, str):
                    item[key] = value[:4000]
            items.append(item)
        print(json.dumps({"count": len(items), "items": items}, ensure_ascii=False))
        return 0
    finally:
        connection.close()


if __name__ == "__main__":
    raise SystemExit(main())
