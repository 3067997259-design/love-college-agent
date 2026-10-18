"""Bounded LCA adapter for the installed Student Hub service; no credentials on stdout."""
import argparse
import contextlib
import importlib.util
import io
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--db")
    parser.add_argument("--action", required=True)
    parser.add_argument("--job", default="")
    parser.add_argument("--limit", type=int, default=10)
    args = parser.parse_args()
    if args.action == "health":
        backend = importlib.util.find_spec("student_hub") is not None
        configured = Path(args.config).is_file()
        return {"ok": backend and configured, "backend": backend, "configured": configured, "authentication": "not-tested"}
    from student_hub.assistant import StudentHubAssistant
    assistant = StudentHubAssistant(args.config, database_path=args.db)
    if args.action == "scan":
        job = assistant.scan_school_updates(limit=max(1, min(20, args.limit)))
    elif args.action == "cancel":
        job = assistant.cancel_school_update_scan(args.job)
    elif args.action in ("status", "collect"):
        job = assistant.get_school_update_scan(args.job)
    else:
        raise ValueError("unsupported action")
    result = {"ok": job["status"] not in ("failed", "cancelled"), "jobId": str(job["id"]), "status": job["status"]}
    if args.action == "collect" and job["status"] == "succeeded":
        artifacts = assistant.store.list_unreviewed_artifacts(limit=20)
        result["artifacts"] = [dict(id=int(row["id"]), version=int(row.get("version", 1)), source=str(row["source_id"]),
            subject=str(row.get("subject") or "校园资料")[:256], body=json.dumps(row.get("payload", {}), ensure_ascii=False)[:60000],
            at=str(row.get("occurred_at") or row.get("last_seen_at") or "")) for row in artifacts if not assistant.store.list_items_for_artifact(int(row["id"]))]
    return result


if __name__ == "__main__":
    try:
        # Dependency/library diagnostics may contain private paths or source material.
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            result = main()
    except Exception:
        result = {"ok": False, "error": "student-hub-unavailable"}
    print(json.dumps(result, ensure_ascii=False))
