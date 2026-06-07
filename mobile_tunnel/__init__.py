from __future__ import annotations

import asyncio
import base64
import hashlib
import html
import io
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, urlunparse

from aiohttp import ClientSession, ClientTimeout, WSMsgType, web

from config import MAIN_SERVER_PORT
from plugin.sdk.plugin import Err, NekoPluginBase, Ok, SdkError, lifecycle, neko_plugin, plugin_entry, tr, ui


CLOUDFLARED_VERSION = "2026.5.2"
CLOUDFLARED_SHA256 = "20b9638f685333d623798e733effbad2487093f15ba592f6c7752360ff3b7ab7"
TRYCLOUDFLARE_URL_RE = re.compile(r"https://[A-Za-z0-9-]+\.trycloudflare\.com")
START_TIMEOUT_SECONDS = 45
DEFAULT_IDLE_TIMEOUT_MINUTES = 10
TAILSCALE_STATUS_CACHE_SECONDS = 15
TAILSCALE_FUNNEL_HTTPS_PORT = 10000
TAILSCALE_DOWNLOAD_URL = "https://tailscale.com/download/windows"
TAILSCALE_FUNNEL_DOCS_URL = "https://tailscale.com/docs/features/tailscale-funnel"
SESSION_COOKIE_NAME = "neko_mobile_tunnel_session"
HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}


@neko_plugin
class MobileTunnelPlugin(NekoPluginBase):
    """Create a controlled mobile access entry through TryCloudflare."""

    def __init__(self, ctx):
        super().__init__(ctx)
        self._vendor_root = Path(self.config_dir) / "vendor" / "cloudflared"
        self._lock = asyncio.Lock()
        self._status = "idle"
        self._error: str | None = None
        self._last_message: str | None = None
        self._token: str | None = None
        self._session_cookie_value: str | None = None
        self._started_at: float | None = None
        self._public_url: str | None = None
        self._mobile_url: str | None = None
        self._tunnel_provider: str | None = None
        self._qr_data_url: str | None = None
        self._qr_png: bytes | None = None
        self._gateway_port: int | None = None
        self._runner: web.AppRunner | None = None
        self._site: web.TCPSite | None = None
        self._process: asyncio.subprocess.Process | None = None
        self._stdout_task: asyncio.Task | None = None
        self._stderr_task: asyncio.Task | None = None
        self._watch_task: asyncio.Task | None = None
        self._idle_task: asyncio.Task | None = None
        self._url_future: asyncio.Future[str] | None = None
        self._last_cloudflared_lines: list[str] = []
        self._last_mobile_entered_at: float | None = None
        self._last_mobile_access_at: float | None = None
        self._idle_last_activity_at: float | None = None
        self._idle_locked_by_mobile_session: bool = False
        self._active_mobile_websockets: int = 0
        self._mobile_enter_count: int = 0
        self._target_base_url = f"http://127.0.0.1:{MAIN_SERVER_PORT}"
        self._tailscale_status_cache: dict[str, Any] | None = None
        self._tailscale_status_checked_at: float = 0.0

    def _t(self, key: str, *, locale: str | None = None, default: str = "", **params: object) -> str:
        return self.i18n.t(key, locale=locale, default=default, **params)

    def _request_locale(self, request: web.Request) -> str | None:
        accept_language = request.headers.get("Accept-Language", "")
        for raw_item in accept_language.split(","):
            code = raw_item.split(";", 1)[0].strip().replace("_", "-")
            if code:
                return code
        return None

    @lifecycle(id="startup")
    async def startup(self, **_):
        self.register_static_ui("static")
        self._status = "idle"
        self._last_message = self._t("messages.ready")
        return Ok({"status": self._status, "message": self._last_message})

    @lifecycle(id="shutdown")
    async def shutdown(self, **_):
        async with self._lock:
            await self._stop_tunnel_locked(clear_message=False)
        return Ok({"status": "stopped"})

    @lifecycle(id="reload")
    async def reload(self, **_):
        async with self._lock:
            await self._stop_tunnel_locked(clear_message=False)
        return Ok({"status": "reloaded"})

    @ui.context(id="dashboard", title=tr("panel.title", default="Mobile Tunnel"))
    async def dashboard(self):
        await self._refresh_dead_process()
        await self._refresh_tailscale_status()
        return self._build_status_payload(include_qr=True)

    @ui.action(
        label=tr("actions.start.label", default="Start Sharing"),
        tone="success",
        group="tunnel",
        order=10,
        refresh_context=True,
    )
    @plugin_entry(
        id="start_tunnel",
        name=tr("entries.start.name", default="Start Mobile Sharing"),
        description=tr("entries.start.description", default="Start the local mobile gateway and generate a QR-code access link."),
        input_schema={"type": "object", "properties": {}},
        llm_result_fields=["summary", "mobile_url"],
    )
    async def start_tunnel(self, **_):
        async with self._lock:
            if self._is_tunnel_active():
                return Ok(self._build_status_payload(include_qr=True))

            await self._stop_tunnel_locked(clear_message=True)
            cloudflared = await self._resolve_cloudflared()
            if cloudflared is None:
                self._status = "error"
                self._error = self._t("errors.cloudflaredMissing")
                return Err(SdkError(self._error))

            if self._is_bundled_cloudflared(cloudflared):
                ok, actual_hash = await asyncio.to_thread(self._verify_bundled_hash, cloudflared)
                if not ok:
                    self._status = "error"
                    self._error = self._t("errors.bundledHashFailed", actual_hash=actual_hash)
                    return Err(SdkError(self._t("errors.bundledHashFailedUser")))

            self._status = "starting"
            self._error = None
            self._last_message = self._t("messages.startingGateway")
            self._token = secrets.token_urlsafe(32)
            self._session_cookie_value = secrets.token_urlsafe(32)
            self._started_at = time.time()
            self._idle_last_activity_at = self._started_at
            self._idle_locked_by_mobile_session = False

            try:
                await self._start_gateway_locked()
                await self._start_cloudflared_locked(cloudflared)
                assert self._url_future is not None
                public_url = await asyncio.wait_for(self._url_future, timeout=START_TIMEOUT_SECONDS)
            except Exception as exc:
                await self._stop_tunnel_locked(clear_message=False)
                self._status = "error"
                self._error = self._format_start_error(exc)
                return Err(SdkError(self._error))

            self._public_url = public_url.rstrip("/")
            self._tunnel_provider = "cloudflare"
            self._mobile_url = f"{self._public_url}/s/{self._token}"
            self._qr_png = self._make_qr_png(self._mobile_url)
            self._qr_data_url = self._make_qr_data_url(self._qr_png)
            self._status = "running"
            self._last_message = self._t("messages.accessStarted")
            self._idle_task = asyncio.create_task(self._stop_when_idle())

            host = urlparse(self._public_url).hostname or "trycloudflare"
            self.logger.info("MobileTunnel started: port={} host={}", self._gateway_port, host)
            payload = self._build_status_payload(include_qr=True)
            payload["summary"] = self._t("messages.mobileUrlCreated")
            return Ok(payload)

    @ui.action(
        id="start_tailscale_funnel",
        label=tr("panel.tailscale.actions.start", default="Start Funnel"),
        tone="success",
        group="tailscale",
        order=35,
        refresh_context=True,
    )
    @plugin_entry(
        id="start_tailscale_funnel",
        name=tr("entries.tailscaleStart.name", default="Start Tailscale Funnel"),
        description=tr("entries.tailscaleStart.description", default="Start the local mobile gateway and expose it through Tailscale Funnel."),
        input_schema={"type": "object", "properties": {}},
        llm_result_fields=["summary", "mobile_url"],
    )
    async def start_tailscale_funnel(self, **_):
        async with self._lock:
            if self._is_tunnel_active():
                return Ok(self._build_status_payload(include_qr=True))

            await self._stop_tunnel_locked(clear_message=True)
            status = await self._refresh_tailscale_status(force=True)
            if not status.get("installed"):
                self._status = "error"
                self._error = self._t("messages.tailscaleMissing")
                return Err(SdkError(self._error))
            if not status.get("logged_in") or not status.get("dns_name"):
                self._status = "error"
                self._error = self._t("errors.tailscaleNotReady")
                return Err(SdkError(self._error))

            tailscale = self._resolve_tailscale()
            if tailscale is None:
                self._status = "error"
                self._error = self._t("messages.tailscaleMissing")
                return Err(SdkError(self._error))

            self._status = "starting"
            self._error = None
            self._last_message = self._t("messages.startingGateway")
            self._token = secrets.token_urlsafe(32)
            self._session_cookie_value = secrets.token_urlsafe(32)
            self._started_at = time.time()
            self._idle_last_activity_at = self._started_at
            self._idle_locked_by_mobile_session = False
            self._tunnel_provider = "tailscale"

            try:
                await self._start_gateway_locked()
                await self._start_tailscale_funnel_locked(tailscale)
                public_url = self._tailscale_public_url(status)
                if not public_url:
                    raise RuntimeError(self._t("errors.tailscaleNoUrl"))
            except Exception as exc:
                await self._stop_tunnel_locked(clear_message=False)
                self._status = "error"
                self._error = self._format_start_error(exc)
                return Err(SdkError(self._error))

            self._public_url = public_url.rstrip("/")
            self._tunnel_provider = "tailscale"
            self._mobile_url = f"{self._public_url}/s/{self._token}"
            self._qr_png = self._make_qr_png(self._mobile_url)
            self._qr_data_url = self._make_qr_data_url(self._qr_png)
            self._status = "running"
            self._last_message = self._t("messages.tailscaleFunnelStarted")
            self._idle_task = asyncio.create_task(self._stop_when_idle())

            host = urlparse(self._public_url).hostname or "tailscale"
            self.logger.info("MobileTunnel Tailscale Funnel started: port={} host={}", self._gateway_port, host)
            payload = self._build_status_payload(include_qr=True)
            payload["summary"] = self._t("messages.mobileUrlCreated")
            return Ok(payload)

    @ui.action(
        label=tr("actions.stop.label", default="Stop Sharing"),
        tone="danger",
        group="tunnel",
        order=20,
        confirm=tr("actions.stop.confirm", default="Stop the public mobile access tunnel?"),
        refresh_context=True,
    )
    @plugin_entry(
        id="stop_tunnel",
        name=tr("entries.stop.name", default="Stop Mobile Sharing"),
        description=tr("entries.stop.description", default="Stop the temporary public link and the local mobile gateway."),
        input_schema={"type": "object", "properties": {}},
        llm_result_fields=["summary"],
    )
    async def stop_tunnel(self, **_):
        async with self._lock:
            await self._stop_tunnel_locked(clear_message=False)
            self._status = "idle"
            self._last_message = self._t("messages.accessStopped")
            self.logger.info("MobileTunnel stopped")
            payload = self._build_status_payload(include_qr=False)
            payload["summary"] = self._t("messages.mobileAccessStopped")
            return Ok(payload)

    @ui.action(
        label=tr("actions.rotate.label", default="Rotate QR Code"),
        tone="warning",
        group="tunnel",
        order=30,
        refresh_context=True,
    )
    @plugin_entry(
        id="rotate_token",
        name=tr("entries.rotate.name", default="Rotate QR Code"),
        description=tr("entries.rotate.description", default="Reset the access token so the old QR code immediately becomes invalid."),
        input_schema={"type": "object", "properties": {}},
        llm_result_fields=["summary", "mobile_url"],
    )
    async def rotate_token(self, **_):
        async with self._lock:
            if not self._is_tunnel_active() or not self._public_url:
                return Err(SdkError(self._t("errors.tunnelNotRunningRotate")))

            self._token = secrets.token_urlsafe(32)
            self._session_cookie_value = secrets.token_urlsafe(32)
            self._idle_last_activity_at = time.time()
            self._idle_locked_by_mobile_session = False
            self._last_mobile_access_at = None
            self._mobile_url = f"{self._public_url.rstrip('/')}/s/{self._token}"
            self._qr_png = self._make_qr_png(self._mobile_url)
            self._qr_data_url = self._make_qr_data_url(self._qr_png)
            self._last_message = self._t("messages.qrRotated")
            payload = self._build_status_payload(include_qr=True)
            payload["summary"] = self._t("messages.qrRotatedSummary")
            return Ok(payload)

    @plugin_entry(
        id="get_status",
        name=tr("entries.status.name", default="Get Sharing Status"),
        description=tr("entries.status.description", default="Get the current mobile QR tunnel status."),
        input_schema={"type": "object", "properties": {}},
        llm_result_fields=["summary", "status", "running"],
    )
    async def get_status(self, **_):
        await self._refresh_dead_process()
        payload = self._build_status_payload(include_qr=True)
        payload["summary"] = self._status_summary(payload)
        return Ok(payload)

    @plugin_entry(
        id="vendor_status",
        name=tr("entries.vendor.name", default="Check Bundled cloudflared"),
        description=tr("entries.vendor.description", default="Check whether the bundled cloudflared.exe and license records exist."),
        input_schema={"type": "object", "properties": {}},
        llm_result_fields=["summary", "ready"],
    )
    async def vendor_status(self, **_):
        status = await asyncio.to_thread(self._vendor_status)
        status["summary"] = self._t("messages.vendorReady") if status["ready"] else self._t("messages.vendorMissing")
        return Ok(status)

    @ui.action(
        id="get_tailscale_status",
        label=tr("panel.tailscale.actions.check", default="Check Tailscale"),
        tone="primary",
        group="tailscale",
        order=40,
        refresh_context=True,
    )
    @plugin_entry(
        id="get_tailscale_status",
        name=tr("entries.tailscale.name", default="Check Tailscale"),
        description=tr("entries.tailscale.description", default="Check whether Tailscale is installed and ready for Funnel."),
        input_schema={"type": "object", "properties": {"start_funnel": {"type": "boolean"}}},
        llm_result_fields=["summary", "installed", "logged_in"],
    )
    async def get_tailscale_status(self, **_):
        if bool(_.get("start_funnel")):
            return await self.start_tailscale_funnel()

        status = await self._refresh_tailscale_status(force=True)
        if not status.get("installed"):
            status["summary"] = self._t("messages.tailscaleMissing")
        elif not status.get("logged_in"):
            status["summary"] = self._t("messages.tailscaleNeedsLogin")
        else:
            status["summary"] = self._t("messages.tailscaleReady")
        return Ok(status)

    async def _resolve_cloudflared(self) -> Path | None:
        bundled = self._vendor_root / "windows-amd64" / "cloudflared.exe"
        if sys.platform.startswith("win") and bundled.is_file():
            return bundled
        found = shutil.which("cloudflared")
        return Path(found) if found else None

    def _is_bundled_cloudflared(self, path: Path) -> bool:
        try:
            return path.resolve() == (self._vendor_root / "windows-amd64" / "cloudflared.exe").resolve()
        except OSError:
            return False

    def _verify_bundled_hash(self, path: Path) -> tuple[bool, str]:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        actual = digest.hexdigest()
        return actual == CLOUDFLARED_SHA256, actual

    async def _start_gateway_locked(self) -> None:
        app = web.Application()
        app.router.add_get("/", self._gateway_root)
        app.router.add_get("/health", self._gateway_health)
        app.router.add_get("/s/{token}", self._mobile_page)
        app.router.add_get("/s/{token}/app", self._mobile_app)
        app.router.add_get("/s/{token}/qr.png", self._mobile_qr)
        app.router.add_get("/s/{token}/status", self._mobile_status)
        app.router.add_route("*", "/{proxied_path:.*}", self._proxy_to_main)

        runner = web.AppRunner(app, access_log=None)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()

        sockets = getattr(getattr(site, "_server", None), "sockets", None) or []
        if not sockets:
            await runner.cleanup()
            raise RuntimeError(self._t("errors.gatewayNoPort"))

        self._runner = runner
        self._site = site
        self._gateway_port = int(sockets[0].getsockname()[1])

    async def _start_cloudflared_locked(self, cloudflared: Path) -> None:
        if not self._gateway_port:
            raise RuntimeError(self._t("errors.gatewayNotStarted"))

        local_url = f"http://127.0.0.1:{self._gateway_port}"
        loop = asyncio.get_running_loop()
        self._url_future = loop.create_future()
        kwargs: dict[str, Any] = {
            "stdout": asyncio.subprocess.PIPE,
            "stderr": asyncio.subprocess.PIPE,
            "cwd": str(self.config_dir),
        }
        if os.name == "nt":
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW

        self._process = await asyncio.create_subprocess_exec(
            str(cloudflared),
            "tunnel",
            "--url",
            local_url,
            "--no-autoupdate",
            **kwargs,
        )
        self._stdout_task = asyncio.create_task(self._read_cloudflared_stream(self._process.stdout))
        self._stderr_task = asyncio.create_task(self._read_cloudflared_stream(self._process.stderr))
        self._watch_task = asyncio.create_task(self._watch_cloudflared(self._process))

    async def _start_tailscale_funnel_locked(self, tailscale: Path) -> None:
        if not self._gateway_port:
            raise RuntimeError(self._t("errors.gatewayNotStarted"))

        target = f"http://127.0.0.1:{self._gateway_port}"
        kwargs: dict[str, Any] = {
            "stdout": asyncio.subprocess.PIPE,
            "stderr": asyncio.subprocess.PIPE,
            "cwd": str(self.config_dir),
        }
        if os.name == "nt":
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW

        self._process = await asyncio.create_subprocess_exec(
            str(tailscale),
            "funnel",
            f"--https={TAILSCALE_FUNNEL_HTTPS_PORT}",
            "--yes",
            target,
            **kwargs,
        )
        self._stdout_task = asyncio.create_task(self._read_cloudflared_stream(self._process.stdout))
        self._stderr_task = asyncio.create_task(self._read_cloudflared_stream(self._process.stderr))
        self._watch_task = asyncio.create_task(self._watch_cloudflared(self._process))
        await asyncio.sleep(1.2)
        if self._process.returncode is not None:
            raise RuntimeError(self._last_cloudflared_lines[-1] if self._last_cloudflared_lines else self._t("errors.tailscaleStartFailed"))

    async def _read_cloudflared_stream(self, stream: asyncio.StreamReader | None) -> None:
        if stream is None:
            return
        while True:
            line = await stream.readline()
            if not line:
                break
            text = line.decode("utf-8", errors="replace").strip()
            if not text:
                continue
            match = TRYCLOUDFLARE_URL_RE.search(text)
            if match and self._url_future and not self._url_future.done():
                self._url_future.set_result(match.group(0))
            self._remember_cloudflared_line(TRYCLOUDFLARE_URL_RE.sub("<trycloudflare-url>", text))

    def _remember_cloudflared_line(self, line: str) -> None:
        self._last_cloudflared_lines.append(line)
        if len(self._last_cloudflared_lines) > 12:
            self._last_cloudflared_lines = self._last_cloudflared_lines[-12:]

    async def _watch_cloudflared(self, process: asyncio.subprocess.Process) -> None:
        returncode = await process.wait()
        if self._process is not process:
            return
        exit_error = self._process_exit_error(returncode)
        if self._url_future and not self._url_future.done():
            self._url_future.set_exception(RuntimeError(exit_error))
            return
        async with self._lock:
            if self._process is process and self._status == "running":
                provider = self._tunnel_provider
                self._status = "error"
                self._error = exit_error
                self._last_message = self._error
                await self._stop_gateway_locked()
                if provider == "tailscale":
                    await self._turn_off_tailscale_funnel()
                self._clear_tunnel_state_after_process_exit()

    async def _stop_when_idle(self) -> None:
        while True:
            async with self._lock:
                if not self._is_tunnel_active():
                    return
                if self._idle_locked_by_mobile_session or self._active_mobile_websockets > 0:
                    sleep_for = 30
                else:
                    remaining = self._idle_remaining_seconds()
                    if remaining <= 0:
                        await self._stop_tunnel_locked(clear_message=False)
                        self._status = "idle"
                        self._last_message = self._t("messages.idleStopped", minutes=DEFAULT_IDLE_TIMEOUT_MINUTES)
                        self.logger.info("MobileTunnel stopped by idle timeout")
                        return
                    sleep_for = min(max(remaining, 1), 30)
            await asyncio.sleep(sleep_for)

    async def _refresh_dead_process(self) -> None:
        async with self._lock:
            if self._process is not None and self._process.returncode is not None and self._status == "running":
                provider = self._tunnel_provider
                self._status = "error"
                self._error = self._process_exit_error(self._process.returncode)
                self._last_message = self._error
                await self._stop_gateway_locked()
                if provider == "tailscale":
                    await self._turn_off_tailscale_funnel()
                self._clear_tunnel_state_after_process_exit()

    async def _stop_tunnel_locked(self, *, clear_message: bool) -> None:
        current_task = asyncio.current_task()
        if self._idle_task is not None and self._idle_task is not current_task:
            self._idle_task.cancel()
        self._idle_task = None

        for task_name in ("_stdout_task", "_stderr_task", "_watch_task"):
            task = getattr(self, task_name)
            if task is not None and task is not current_task:
                task.cancel()
                setattr(self, task_name, None)

        process = self._process
        provider = self._tunnel_provider
        self._process = None
        if process is not None and process.returncode is None:
            await self._terminate_process(process)
        if provider == "tailscale":
            await self._turn_off_tailscale_funnel()

        await self._stop_gateway_locked()
        self._public_url = None
        self._mobile_url = None
        self._tunnel_provider = None
        self._qr_data_url = None
        self._qr_png = None
        self._token = None
        self._session_cookie_value = None
        self._started_at = None
        self._url_future = None
        self._gateway_port = None
        self._last_cloudflared_lines = []
        self._last_mobile_entered_at = None
        self._last_mobile_access_at = None
        self._idle_last_activity_at = None
        self._idle_locked_by_mobile_session = False
        self._active_mobile_websockets = 0
        self._mobile_enter_count = 0
        if clear_message:
            self._error = None
            self._last_message = None

    async def _terminate_process(self, process: asyncio.subprocess.Process) -> None:
        self._terminate_process_safely(process)
        try:
            await self._wait_process_exit(process, timeout=5)
        except (asyncio.TimeoutError, TimeoutError):
            self._kill_process_safely(process)
            await self._wait_process_exit(process, timeout=5)

    def _terminate_process_safely(self, process: asyncio.subprocess.Process) -> None:
        try:
            process.terminate()
        except ProcessLookupError:
            pass

    def _kill_process_safely(self, process: asyncio.subprocess.Process) -> None:
        try:
            process.kill()
        except ProcessLookupError:
            pass

    async def _wait_process_exit(self, process: asyncio.subprocess.Process, *, timeout: float) -> int | None:
        transport = getattr(process, "_transport", None)
        process_loop = getattr(transport, "_loop", None)
        current_loop = asyncio.get_running_loop()
        if process_loop is None or process_loop is current_loop:
            try:
                return await asyncio.wait_for(process.wait(), timeout=timeout)
            except RuntimeError as exc:
                if "attached to a different loop" not in str(exc):
                    raise
        return await asyncio.to_thread(self._wait_process_exit_sync, process, timeout)

    def _wait_process_exit_sync(self, process: asyncio.subprocess.Process, timeout: float) -> int | None:
        transport = getattr(process, "_transport", None)
        popen = getattr(transport, "_proc", None)
        if popen is not None:
            try:
                return popen.wait(timeout=timeout)
            except subprocess.TimeoutExpired as exc:
                raise TimeoutError from exc

        deadline = time.monotonic() + timeout
        while process.returncode is None:
            if time.monotonic() >= deadline:
                raise TimeoutError
            time.sleep(0.05)
        return process.returncode

    async def _stop_gateway_locked(self) -> None:
        runner = self._runner
        self._site = None
        self._runner = None
        if runner is not None:
            await runner.cleanup()

    async def _turn_off_tailscale_funnel(self) -> None:
        tailscale = self._resolve_tailscale()
        if tailscale is None:
            return
        await asyncio.to_thread(
            self._run_tailscale_command,
            tailscale,
            "funnel",
            f"--https={TAILSCALE_FUNNEL_HTTPS_PORT}",
            "--yes",
            "off",
            timeout=8,
        )

    def _clear_tunnel_state_after_process_exit(self) -> None:
        current_task = asyncio.current_task()
        for task_name in ("_idle_task",):
            task = getattr(self, task_name)
            if task is not None and task is not current_task:
                task.cancel()
            setattr(self, task_name, None)
        self._process = None
        self._public_url = None
        self._mobile_url = None
        self._tunnel_provider = None
        self._qr_data_url = None
        self._qr_png = None
        self._token = None
        self._session_cookie_value = None
        self._started_at = None
        self._gateway_port = None
        self._last_mobile_entered_at = None
        self._last_mobile_access_at = None
        self._idle_last_activity_at = None
        self._idle_locked_by_mobile_session = False
        self._active_mobile_websockets = 0
        self._mobile_enter_count = 0

    def _is_tunnel_active(self) -> bool:
        return self._process is not None and self._process.returncode is None and bool(self._public_url and self._token)

    def _idle_remaining_seconds(self) -> int:
        if not self._is_tunnel_active():
            return 0
        if self._idle_locked_by_mobile_session or self._active_mobile_websockets > 0:
            return DEFAULT_IDLE_TIMEOUT_MINUTES * 60
        base_time = self._idle_last_activity_at or self._started_at
        if base_time is None:
            return DEFAULT_IDLE_TIMEOUT_MINUTES * 60
        return max(0, int(DEFAULT_IDLE_TIMEOUT_MINUTES * 60 - (time.time() - base_time)))

    def _build_status_payload(self, *, include_qr: bool) -> dict[str, Any]:
        running = self._is_tunnel_active()
        local_gateway_url = f"http://127.0.0.1:{self._gateway_port}" if self._gateway_port else None
        return {
            "status": self._status,
            "running": running,
            "status_label": self._status_label(),
            "public_url": self._public_url if running else None,
            "mobile_url": self._mobile_url if running else None,
            "tunnel_provider": self._tunnel_provider if running else None,
            "qr_code_url": self._qr_image_url(local_gateway_url) if include_qr and running else None,
            "qr_code_data_url": self._qr_data_url if include_qr and running else None,
            "local_gateway_url": local_gateway_url,
            "gateway_port": self._gateway_port,
            "started_at": self._started_at,
            "last_mobile_entered_at": self._last_mobile_entered_at,
            "last_mobile_access_at": self._last_mobile_access_at,
            "active_mobile_websockets": self._active_mobile_websockets,
            "mobile_enter_count": self._mobile_enter_count,
            "idle_locked": bool(running and self._idle_locked_by_mobile_session),
            "idle_remaining_seconds": self._idle_remaining_seconds() if running else 0,
            "idle_timeout_minutes": DEFAULT_IDLE_TIMEOUT_MINUTES,
            "cloudflared_version": CLOUDFLARED_VERSION,
            "vendor": self._vendor_status(include_hash=False),
            "tailscale": self._tailscale_status_cache or self._empty_tailscale_status(),
            "error": self._error,
            "message": self._last_message,
        }

    def _empty_tailscale_status(self) -> dict[str, Any]:
        return {
            "installed": False,
            "path": "",
            "version": "",
            "backend_state": "",
            "logged_in": False,
            "login_name": "",
            "dns_name": "",
            "funnel_ready": False,
            "error": "",
            "download_url": TAILSCALE_DOWNLOAD_URL,
            "funnel_docs_url": TAILSCALE_FUNNEL_DOCS_URL,
        }

    async def _refresh_tailscale_status(self, *, force: bool = False) -> dict[str, Any]:
        now = time.time()
        if (
            not force
            and self._tailscale_status_cache is not None
            and now - self._tailscale_status_checked_at < TAILSCALE_STATUS_CACHE_SECONDS
        ):
            return self._tailscale_status_cache

        status = await asyncio.to_thread(self._tailscale_status)
        self._tailscale_status_cache = status
        self._tailscale_status_checked_at = time.time()
        return status

    def _tailscale_status(self) -> dict[str, Any]:
        payload = self._empty_tailscale_status()
        tailscale = self._resolve_tailscale()
        if tailscale is None:
            return payload

        payload["installed"] = True
        payload["path"] = str(tailscale)
        version = self._run_tailscale_command(tailscale, "version", timeout=2.5)
        if version["ok"]:
            payload["version"] = (version["stdout"].splitlines() or [""])[0].strip()

        status = self._run_tailscale_command(tailscale, "status", "--json", timeout=3.5)
        if not status["ok"]:
            payload["error"] = status["stderr"] or status["stdout"]
            return payload

        try:
            data = json.loads(status["stdout"])
        except json.JSONDecodeError as exc:
            payload["error"] = f"tailscale status json parse failed: {exc}"
            return payload

        backend_state = str(data.get("BackendState") or "")
        self_node = data.get("Self") if isinstance(data.get("Self"), dict) else {}
        user_map = data.get("User") if isinstance(data.get("User"), dict) else {}
        user_id = self_node.get("UserID")
        user_info = user_map.get(str(user_id), {}) if user_id is not None else {}
        if not isinstance(user_info, dict):
            user_info = {}
        login_name = str(user_info.get("LoginName") or user_info.get("DisplayName") or self_node.get("LoginName") or user_id or "")
        dns_name = str(self_node.get("DNSName") or "").rstrip(".")
        payload["backend_state"] = backend_state
        payload["login_name"] = login_name
        payload["dns_name"] = dns_name
        payload["logged_in"] = backend_state.lower() == "running" and bool(self_node)
        payload["funnel_ready"] = bool(payload["logged_in"] and dns_name)
        return payload

    def _tailscale_public_url(self, status: dict[str, Any]) -> str | None:
        dns_name = str(status.get("dns_name") or "").strip().rstrip(".")
        if not dns_name:
            return None
        if TAILSCALE_FUNNEL_HTTPS_PORT == 443:
            return f"https://{dns_name}"
        return f"https://{dns_name}:{TAILSCALE_FUNNEL_HTTPS_PORT}"

    def _resolve_tailscale(self) -> Path | None:
        found = shutil.which("tailscale")
        if found:
            return Path(found)

        candidates = [
            Path(os.environ.get("ProgramFiles", "")) / "Tailscale" / "tailscale.exe",
            Path(os.environ.get("ProgramFiles(x86)", "")) / "Tailscale" / "tailscale.exe",
            Path(os.environ.get("LocalAppData", "")) / "Tailscale" / "tailscale.exe",
        ]
        for candidate in candidates:
            if candidate.is_file():
                return candidate
        return None

    def _run_tailscale_command(self, tailscale: Path, *args: str, timeout: float) -> dict[str, Any]:
        try:
            completed = subprocess.run(
                [str(tailscale), *args],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
                check=False,
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            )
        except Exception as exc:
            return {"ok": False, "stdout": "", "stderr": str(exc)}
        return {
            "ok": completed.returncode == 0,
            "stdout": completed.stdout.strip(),
            "stderr": completed.stderr.strip(),
            "returncode": completed.returncode,
        }

    def _status_label(self, *, locale: str | None = None) -> str:
        labels = {
            "idle": self._t("panel.status.idle", locale=locale),
            "starting": self._t("panel.status.starting", locale=locale),
            "running": self._t("panel.status.running", locale=locale),
            "stopping": self._t("panel.status.stopping", locale=locale),
            "error": self._t("panel.status.error", locale=locale),
        }
        return labels.get(self._status, self._status)

    def _status_summary(self, payload: dict[str, Any]) -> str:
        if payload.get("running"):
            return self._t("messages.statusRunning")
        if self._error:
            return self._error
        return self._t("messages.statusIdle")

    def _process_exit_error(self, returncode: int | None) -> str:
        if self._tunnel_provider == "tailscale":
            return self._t("errors.tailscaleExited", returncode=returncode)
        return self._t("errors.cloudflaredExited", returncode=returncode)

    def _format_start_error(self, exc: Exception) -> str:
        if isinstance(exc, asyncio.TimeoutError):
            return self._t("errors.startTimeout")
        text = str(exc).strip()
        if not text and self._last_cloudflared_lines:
            text = self._last_cloudflared_lines[-1]
        return text or self._t("errors.startFailed")

    def _qr_image_url(self, local_gateway_url: str | None) -> str | None:
        if not local_gateway_url or not self._token:
            return None
        return f"{local_gateway_url}/s/{self._token}/qr.png"

    def _make_qr_png(self, value: str) -> bytes:
        import qrcode

        qr = qrcode.QRCode(border=2, box_size=8)
        qr.add_data(value)
        qr.make(fit=True)
        image = qr.make_image(fill_color="black", back_color="white")
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        return buffer.getvalue()

    def _make_qr_data_url(self, png_bytes: bytes) -> str:
        encoded = base64.b64encode(png_bytes).decode("ascii")
        return f"data:image/png;base64,{encoded}"

    def _format_idle_remaining(self, *, locale: str | None = None) -> str:
        idle_remaining = self._idle_remaining_seconds()
        return self._t(
            "mobile.idleRemaining",
            locale=locale,
            minutes=idle_remaining // 60,
            seconds=f"{idle_remaining % 60:02d}",
        )

    def _vendor_status(self, *, include_hash: bool = True) -> dict[str, Any]:
        exe_path = self._vendor_root / "windows-amd64" / "cloudflared.exe"
        version_path = self._vendor_root / "VERSION.txt"
        license_path = self._vendor_root / "licenses" / "LICENSE-cloudflared-Apache-2.0.txt"
        notice_path = self._vendor_root / "THIRD_PARTY_NOTICES.txt"
        files = {
            "cloudflared_exe": exe_path.is_file(),
            "version_record": version_path.is_file(),
            "license": license_path.is_file(),
            "third_party_notice": notice_path.is_file(),
        }
        payload: dict[str, Any] = {
            "ready": all(files.values()),
            "version": CLOUDFLARED_VERSION,
            "expected_sha256": CLOUDFLARED_SHA256,
            "files": files,
        }
        if include_hash and exe_path.is_file():
            ok, actual = self._verify_bundled_hash(exe_path)
            payload["sha256"] = actual
            payload["hash_ok"] = ok
        return payload

    def _token_valid(self, token: str) -> bool:
        if not self._token or not secrets.compare_digest(token, self._token):
            return False
        return True

    def _session_valid(self, request: web.Request) -> bool:
        if not self._session_cookie_value:
            return False
        value = request.cookies.get(SESSION_COOKIE_NAME)
        if not value or not secrets.compare_digest(value, self._session_cookie_value):
            return False
        return True

    def _mark_mobile_access(self) -> None:
        now = time.time()
        self._last_mobile_access_at = now

    def _mark_mobile_entered(self) -> None:
        now = time.time()
        self._idle_last_activity_at = now
        self._idle_locked_by_mobile_session = True
        self._last_mobile_entered_at = now
        self._last_mobile_access_at = now
        self._mobile_enter_count += 1

    def _mark_mobile_disconnected(self) -> None:
        now = time.time()
        self._idle_last_activity_at = now
        self._last_mobile_access_at = now

    async def _gateway_root(self, request: web.Request) -> web.Response:
        if self._session_valid(request):
            return await self._proxy_to_main(request)
        return web.Response(
            text=self._invalid_page("mobile.invalid.useQr", request=request),
            content_type="text/html",
            status=404,
        )

    async def _gateway_health(self, request: web.Request) -> web.Response:
        return web.json_response({"ok": True, "status": self._status})

    async def _mobile_page(self, request: web.Request) -> web.Response:
        token = request.match_info.get("token", "")
        if not self._token_valid(token):
            return web.Response(text=self._invalid_page("mobile.invalid.expiredFull", request=request), content_type="text/html", status=403)
        self._mark_mobile_access()
        return web.Response(text=self._render_mobile_confirm_page(token, request), content_type="text/html")

    async def _mobile_app(self, request: web.Request) -> web.Response:
        token = request.match_info.get("token", "")
        if not self._token_valid(token):
            return web.Response(text=self._invalid_page("mobile.invalid.expiredFull", request=request), content_type="text/html", status=403)
        self._mark_mobile_entered()
        response = web.HTTPFound(location="/")
        response.set_cookie(
            SESSION_COOKIE_NAME,
            self._session_cookie_value or "",
            path="/",
            httponly=True,
            secure=True,
            samesite="Lax",
        )
        return response

    async def _mobile_status(self, request: web.Request) -> web.Response:
        token = request.match_info.get("token", "")
        if not self._token_valid(token):
            locale = self._request_locale(request)
            return web.json_response({"ok": False, "error": self._t("mobile.invalid.expiredShort", locale=locale)}, status=403)
        self._mark_mobile_access()
        locale = self._request_locale(request)
        payload = self._build_status_payload(include_qr=False)
        return web.json_response({
            "ok": True,
            "status": payload["status"],
            "status_label": self._status_label(locale=locale),
            "idle_remaining_seconds": payload["idle_remaining_seconds"],
            "message": payload.get("message") or "",
        })

    async def _mobile_qr(self, request: web.Request) -> web.Response:
        token = request.match_info.get("token", "")
        if not self._token_valid(token) or not self._qr_png:
            return web.Response(status=403)
        return web.Response(
            body=self._qr_png,
            content_type="image/png",
            headers={"Cache-Control": "no-store"},
        )

    async def _proxy_to_main(self, request: web.Request) -> web.StreamResponse:
        if not self._session_valid(request):
            return web.Response(
                text=self._invalid_page("mobile.invalid.sessionExpired", request=request),
                content_type="text/html",
                status=403,
            )
        if request.headers.get("Upgrade", "").lower() == "websocket":
            return await self._proxy_websocket_to_main(request)
        self._mark_mobile_access()
        return await self._proxy_http_to_main(request)

    def _target_url_for_request(self, request: web.Request, *, websocket: bool = False) -> str:
        scheme = "ws" if websocket else "http"
        return f"{scheme}://127.0.0.1:{MAIN_SERVER_PORT}{request.rel_url.raw_path_qs}"

    def _target_origin_for_main(self) -> str:
        return f"http://127.0.0.1:{MAIN_SERVER_PORT}"

    def _proxy_request_headers(self, request: web.Request) -> dict[str, str]:
        headers: dict[str, str] = {}
        for name, value in request.headers.items():
            lower = name.lower()
            if lower in HOP_BY_HOP_HEADERS or lower == "host":
                continue
            if lower == "cookie":
                cleaned_cookie = self._strip_mobile_session_cookie(value)
                if cleaned_cookie:
                    headers[name] = cleaned_cookie
                continue
            if lower == "origin":
                headers["Origin"] = self._target_origin_for_main()
                continue
            if lower == "referer":
                headers["Referer"] = self._rewrite_referer_for_main(value)
                continue
            headers[name] = value
        headers["Host"] = f"127.0.0.1:{MAIN_SERVER_PORT}"
        headers["X-Forwarded-Host"] = request.host
        headers["X-Forwarded-Proto"] = self._forwarded_proto(request)
        return headers

    def _rewrite_referer_for_main(self, referer: str) -> str:
        parsed = urlparse(referer)
        target = urlparse(self._target_origin_for_main())
        path = parsed.path or "/"
        return urlunparse((target.scheme, target.netloc, path, "", parsed.query, ""))

    def _forwarded_proto(self, request: web.Request) -> str:
        existing = request.headers.get("X-Forwarded-Proto")
        if existing:
            return existing.split(",", 1)[0].strip() or "http"
        cf_visitor = request.headers.get("Cf-Visitor", "")
        if '"scheme":"https"' in cf_visitor.replace(" ", ""):
            return "https"
        return "https" if request.secure else "http"

    def _strip_mobile_session_cookie(self, cookie_header: str) -> str:
        parts: list[str] = []
        for raw_part in cookie_header.split(";"):
            part = raw_part.strip()
            if not part:
                continue
            name = part.split("=", 1)[0].strip()
            if name == SESSION_COOKIE_NAME:
                continue
            parts.append(part)
        return "; ".join(parts)

    async def _proxy_http_to_main(self, request: web.Request) -> web.Response:
        target_url = self._target_url_for_request(request)
        body = await request.read()
        timeout = ClientTimeout(total=60)
        async with ClientSession(timeout=timeout, auto_decompress=False) as session:
            async with session.request(
                request.method,
                target_url,
                data=body if body else None,
                headers=self._proxy_request_headers(request),
                allow_redirects=False,
            ) as upstream:
                response_body = await upstream.read()
                headers = [
                    (name, value)
                    for name, value in upstream.headers.items()
                    if name.lower() not in HOP_BY_HOP_HEADERS
                ]
                return web.Response(
                    status=upstream.status,
                    reason=upstream.reason,
                    headers=headers,
                    body=response_body,
                )

    async def _proxy_websocket_to_main(self, request: web.Request) -> web.WebSocketResponse:
        client_ws = web.WebSocketResponse()
        await client_ws.prepare(request)

        target_url = self._target_url_for_request(request, websocket=True)
        self._mark_mobile_access()
        self._active_mobile_websockets += 1
        try:
            async with ClientSession() as session:
                async with session.ws_connect(
                    target_url,
                    headers=self._proxy_request_headers(request),
                    heartbeat=30,
                ) as upstream_ws:
                    async def client_to_upstream() -> None:
                        async for message in client_ws:
                            self._mark_mobile_access()
                            if message.type == WSMsgType.TEXT:
                                await upstream_ws.send_str(message.data)
                            elif message.type == WSMsgType.BINARY:
                                await upstream_ws.send_bytes(message.data)
                            elif message.type == WSMsgType.CLOSE:
                                await upstream_ws.close()

                    async def upstream_to_client() -> None:
                        async for message in upstream_ws:
                            self._mark_mobile_access()
                            if message.type == WSMsgType.TEXT:
                                await client_ws.send_str(message.data)
                            elif message.type == WSMsgType.BINARY:
                                await client_ws.send_bytes(message.data)
                            elif message.type == WSMsgType.CLOSE:
                                await client_ws.close()

                    tasks = [
                        asyncio.create_task(client_to_upstream()),
                        asyncio.create_task(upstream_to_client()),
                    ]
                    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                    for task in pending:
                        task.cancel()
                    for task in done:
                        try:
                            task.result()
                        except (asyncio.CancelledError, ConnectionResetError, RuntimeError):
                            pass
        finally:
            self._active_mobile_websockets = max(0, self._active_mobile_websockets - 1)
            if self._is_tunnel_active() and self._active_mobile_websockets <= 0:
                self._mark_mobile_disconnected()

        return client_ws

    def _invalid_page(self, message_key: str, *, request: web.Request | None = None) -> str:
        locale = self._request_locale(request) if request is not None else None
        safe_lang = html.escape(locale or self.i18n.default_locale or "en", quote=True)
        safe_title = html.escape(self._t("mobile.page.title", locale=locale))
        safe_heading = html.escape(self._t("mobile.page.heading", locale=locale))
        safe_message = html.escape(self._t(message_key, locale=locale))
        return f"""<!doctype html>
<html lang="{safe_lang}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{safe_title}</title>
  <style>
    body {{ margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f7fb; color: #162033; }}
    main {{ width: min(420px, calc(100vw - 32px)); padding: 28px; border: 1px solid #d9e0ec; border-radius: 8px; background: #fff; box-shadow: 0 12px 30px rgba(22, 32, 51, .08); }}
    h1 {{ margin: 0 0 12px; font-size: 22px; }}
    p {{ margin: 0; line-height: 1.7; color: #4c5a6f; }}
  </style>
</head>
<body>
  <main>
    <h1>{safe_heading}</h1>
    <p>{safe_message}</p>
  </main>
</body>
</html>"""

    def _render_mobile_confirm_page(self, token: str, request: web.Request) -> str:
        locale = self._request_locale(request)
        safe_lang = html.escape(locale or self.i18n.default_locale or "en", quote=True)
        safe_title = html.escape(self._t("mobile.confirm.title", locale=locale))
        safe_heading = html.escape(self._t("mobile.confirm.heading", locale=locale))
        safe_body = html.escape(self._t("mobile.confirm.body", locale=locale))
        safe_status = html.escape(self._status_label(locale=locale) or self._t("panel.status.running", locale=locale))
        safe_message = html.escape(str(self._last_message or self._t("mobile.message.startedFallback", locale=locale)))
        enter_url = html.escape(f"/s/{token}/app", quote=True)
        safe_idle_label = html.escape(self._t("mobile.idle.label", locale=locale))
        safe_idle_remaining = html.escape(self._format_idle_remaining(locale=locale))
        safe_access_type_label = html.escape(self._t("mobile.accessType.label", locale=locale))
        safe_access_type_value = html.escape(self._t("mobile.accessType.native", locale=locale))
        safe_enter_button = html.escape(self._t("mobile.enterButton", locale=locale))
        safe_hint = html.escape(self._t("mobile.hint", locale=locale))
        safe_cache_tip = html.escape(self._t("mobile.cacheTip", locale=locale))
        network_tip_text = self._t("mobile.networkTip", locale=locale).strip() if self._tunnel_provider == "cloudflare" else ""
        safe_network_tip = html.escape(network_tip_text)
        network_tip_html = f'<p class="network-tip">{safe_network_tip}</p>' if safe_network_tip else ""
        return f"""<!doctype html>
<html lang="{safe_lang}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{safe_title}</title>
  <style>
    :root {{ color-scheme: light; }}
    body {{ margin: 0; min-height: 100vh; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #eef3f8; color: #172033; }}
    main {{ width: min(520px, calc(100vw - 28px)); margin: 0 auto; padding: 34px 0 36px; }}
    .card {{ background: #fff; border: 1px solid #d8e0ea; border-radius: 8px; padding: 22px; box-shadow: 0 10px 24px rgba(23, 32, 51, .07); }}
    h1 {{ margin: 0; font-size: 28px; line-height: 1.2; }}
    p {{ line-height: 1.7; color: #586477; }}
    .status {{ display: inline-flex; align-items: center; gap: 8px; margin-top: 16px; padding: 7px 10px; border-radius: 999px; background: #e8f7ef; color: #17633a; font-weight: 700; }}
    .dot {{ width: 8px; height: 8px; border-radius: 50%; background: #20a464; }}
    .meta {{ display: grid; gap: 10px; margin: 18px 0; }}
    .row {{ display: flex; justify-content: space-between; gap: 14px; border-top: 1px solid #edf1f6; padding-top: 10px; }}
    .label {{ color: #697386; }}
    .value {{ font-weight: 700; text-align: right; }}
    .enter {{ display: inline-flex; align-items: center; justify-content: center; width: 100%; min-height: 48px; border-radius: 8px; background: #24476f; color: #fff; font-weight: 800; text-decoration: none; }}
    .hint {{ margin-top: 14px; font-size: 13px; color: #697386; }}
    .cache-tip {{ margin-top: 14px; padding: 12px; border-radius: 8px; background: #f3f6fb; color: #536071; font-size: 13px; }}
    .network-tip {{ margin-top: 14px; padding: 12px; border-radius: 8px; background: #fff5df; color: #71501e; font-size: 13px; }}
  </style>
</head>
<body>
  <main>
    <section class="card">
      <h1>{safe_heading}</h1>
      <p>{safe_body}</p>
      <div class="status"><span class="dot"></span><span>{safe_status}</span></div>
      <p>{safe_message}</p>
      <div class="meta">
        <div class="row"><span class="label">{safe_idle_label}</span><span class="value">{safe_idle_remaining}</span></div>
        <div class="row"><span class="label">{safe_access_type_label}</span><span class="value">{safe_access_type_value}</span></div>
      </div>
      <a class="enter" href="{enter_url}">{safe_enter_button}</a>
      <p class="hint">{safe_hint}</p>
      {network_tip_html}
      <p class="cache-tip">{safe_cache_tip}</p>
    </section>
  </main>
</body>
</html>"""

