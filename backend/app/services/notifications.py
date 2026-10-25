from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..clock import iso
from ..models import Notification, new_id


def notify(db: Session, level: str, title: str, body: str = "", link: str | None = None, audience: str = "reviewers") -> Notification:
    item = Notification(id=new_id("N"), level=level, title=title, body=body, link=link, audience=audience)
    db.add(item)
    return item


def serialize(n: Notification) -> dict[str, Any]:
    return {
        "id": n.id,
        "level": n.level,
        "title": n.title,
        "body": n.body,
        "link": n.link,
        "audience": n.audience,
        "read": n.read,
        "created_at": iso(n.created_at),
    }


def list_notifications(db: Session, limit: int = 40) -> dict[str, Any]:
    items = list(db.scalars(select(Notification).order_by(Notification.created_at.desc()).limit(limit)))
    unread = sum(1 for n in items if not n.read)
    return {"items": [serialize(n) for n in items], "unread": unread}


def mark_read(db: Session, ids: list[str] | None) -> None:
    query = select(Notification).where(Notification.read.is_(False))
    if ids:
        query = query.where(Notification.id.in_(ids))
    for n in db.scalars(query):
        n.read = True
    db.commit()
