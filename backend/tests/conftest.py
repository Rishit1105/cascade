"""Test configuration. Settings are read once per process, so the environment is pinned here,
before any `app` module is imported: tests never touch the development database or node."""

import os
import sys
import tempfile
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

TEST_RPC_PORT = int(os.environ.get("DAOGUARD_TEST_RPC_PORT", "8546"))
os.environ["DAOGUARD_RPC_URL"] = f"http://127.0.0.1:{TEST_RPC_PORT}"
os.environ["DAOGUARD_DATA_DIR"] = tempfile.mkdtemp(prefix="daoguard-test-")
os.environ["DAOGUARD_SENTINEL_POLL_SECONDS"] = "0.5"
os.environ.pop("ANTHROPIC_API_KEY", None)
os.environ.pop("DAOGUARD_ANTHROPIC_API_KEY", None)
