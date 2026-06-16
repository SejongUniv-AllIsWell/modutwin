import logging
import os
import signal
import subprocess
import threading
from collections.abc import Mapping, Sequence
from typing import Any

logger = logging.getLogger(__name__)


class WorkerSubprocessTerminated(RuntimeError):
    """Raised when the worker is terminated while a child process is running."""


def _terminate_process_group(process: subprocess.Popen, grace_seconds: float = 5.0) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    except Exception:
        logger.warning("failed to SIGTERM process group pid=%s", process.pid, exc_info=True)
        process.terminate()

    try:
        process.wait(timeout=grace_seconds)
        return
    except subprocess.TimeoutExpired:
        pass

    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        return
    except Exception:
        logger.warning("failed to SIGKILL process group pid=%s", process.pid, exc_info=True)
        process.kill()

    try:
        process.wait(timeout=grace_seconds)
    except subprocess.TimeoutExpired:
        logger.error("process group did not exit after SIGKILL pid=%s", process.pid)


def run_capture(
    cmd: Sequence[str],
    *,
    cwd: str | None = None,
    env: Mapping[str, str] | None = None,
    text: bool = True,
    timeout: float | int | None = None,
) -> subprocess.CompletedProcess:
    """Run a subprocess and kill its process group when the worker is stopped."""
    process = subprocess.Popen(
        list(cmd),
        cwd=cwd,
        env=dict(env) if env is not None else None,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=text,
        start_new_session=True,
    )

    old_handlers: dict[int, Any] = {}

    def _handle_signal(signum, frame):
        logger.warning("received signal %s; terminating child process pid=%s", signum, process.pid)
        _terminate_process_group(process)
        raise WorkerSubprocessTerminated(f"received signal {signum}")

    install_handlers = threading.current_thread() is threading.main_thread()
    if install_handlers:
        for signum in (signal.SIGTERM, signal.SIGINT):
            old_handlers[signum] = signal.getsignal(signum)
            signal.signal(signum, _handle_signal)

    try:
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired as e:
            _terminate_process_group(process)
            e.output = e.stdout = getattr(e, "output", None)
            e.stderr = getattr(e, "stderr", None)
            raise

        result = subprocess.CompletedProcess(list(cmd), process.returncode, stdout, stderr)
        if process.returncode != 0:
            raise subprocess.CalledProcessError(
                process.returncode,
                list(cmd),
                output=stdout,
                stderr=stderr,
            )
        return result
    finally:
        if process.poll() is None:
            _terminate_process_group(process)
        if install_handlers:
            for signum, handler in old_handlers.items():
                signal.signal(signum, handler)
