"""Domain errors mapped to structured HTTP responses: {"error": {"code", "message", "details"}}."""

from __future__ import annotations

from typing import Any


class DomainError(Exception):
    status_code = 400

    def __init__(self, code: str, message: str, details: Any = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details


class NotFound(DomainError):
    status_code = 404


class Conflict(DomainError):
    status_code = 409


class ValidationFailed(DomainError):
    status_code = 422


class ServiceUnavailable(DomainError):
    status_code = 503
