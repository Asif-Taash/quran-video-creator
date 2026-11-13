"""Runs the API in a worker that always comes back (the docker-compose setup).

`uvicorn --reload` restarts its worker only when a file changes: a worker
killed by the container's memory limit stayed dead while the container looked
"Up", with every request refused. Here it also restarts whenever the worker
exits, including on purpose (app/idle_recycle.py, which is how the AI models'
memory goes back to the laptop). This process keeps the listening socket, so a
request arriving meanwhile waits for the new worker instead of being refused.

Starting a new worker needs no GPU runtime or container restart, so this keeps
working after a driver update that hasn't been rebooted into yet -- a container
restart would fail then, taking the whole backend down.
"""
import logging
import os
import signal
import socket
import subprocess
import sys
import threading
import time

from watchfiles import PythonFilter, watch

HOST = "0.0.0.0"
PORT = 8000
# A code change doesn't wait forever on a request that's still running.
STOP_TIMEOUT_SEC = 30
# A worker that fails this soon is broken (say a syntax error): retry slowly.
# One killed by a signal (the memory limit) just comes back.
CRASH_WINDOW_SEC = 5

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger("dev_server")

stop = threading.Event()
changed = threading.Event()


def _watch_code():
    for changes in watch(".", watch_filter=PythonFilter(), stop_event=stop):
        logger.info("Code changed (%s), restarting the worker.", ", ".join(sorted(p for _, p in changes))[:200])
        changed.set()


def _stop_worker(worker):
    worker.terminate()
    try:
        worker.wait(STOP_TIMEOUT_SEC)
    except subprocess.TimeoutExpired:
        worker.kill()
        worker.wait()


def main():
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())

    sock = socket.socket()
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((HOST, PORT))
    sock.listen(2048)
    fd = sock.fileno()

    threading.Thread(target=_watch_code, daemon=True).start()

    while not stop.is_set():
        changed.clear()
        started = time.monotonic()
        worker = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "app.main:app", "--fd", str(fd)],
            pass_fds=(fd,),
            env={**os.environ, "WORKER_RESPAWNS": "1"},
        )
        while worker.poll() is None and not stop.is_set() and not changed.is_set():
            stop.wait(0.2)

        if worker.poll() is None:
            _stop_worker(worker)
        elif worker.returncode > 0 and time.monotonic() - started < CRASH_WINDOW_SEC:
            logger.error("Worker failed at once with %s, retrying in %ss.", worker.returncode, CRASH_WINDOW_SEC)
            stop.wait(CRASH_WINDOW_SEC)
        else:
            logger.warning("Worker exited with %s, starting a new one.", worker.returncode)


if __name__ == "__main__":
    main()
