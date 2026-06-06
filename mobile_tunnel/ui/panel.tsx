import {
  Page,
  Card,
  Grid,
  Stack,
  Text,
  Alert,
  StatCard,
  StatusBadge,
  Button,
  ButtonGroup,
  Field,
  KeyValue,
  CodeBlock,
  RefreshButton,
  useToast,
  useConfirm,
  useEffect,
  useRef,
  useState,
} from "@neko/plugin-ui"
import type { PluginSurfaceProps } from "@neko/plugin-ui"

type VendorStatus = {
  ready?: boolean
  version?: string
  expected_sha256?: string
  files?: Record<string, boolean>
}

type MobileTunnelState = {
  status?: string
  running?: boolean
  status_label?: string
  public_url?: string | null
  mobile_url?: string | null
  qr_code_url?: string | null
  qr_code_data_url?: string | null
  local_gateway_url?: string | null
  gateway_port?: number | null
  started_at?: number | null
  last_mobile_entered_at?: number | null
  last_mobile_access_at?: number | null
  mobile_enter_count?: number
  idle_locked?: boolean
  idle_remaining_seconds?: number
  idle_timeout_minutes?: number
  cloudflared_version?: string
  vendor?: VendorStatus
  error?: string | null
  message?: string | null
}

const MANUAL_MOBILE_MODE_TOAST_TIMEOUT_MS = 30000
const STARTING_TOAST_TIMEOUT_MS = 45000

function formatRemaining(t: PluginSurfaceProps["t"], seconds?: number): string {
  const safeSeconds = Math.max(0, Number(seconds) || 0)
  const minutes = Math.floor(safeSeconds / 60)
  const rest = safeSeconds % 60
  return t("panel.time.remaining", { minutes, seconds: rest })
}

function formatDate(seconds?: number | null): string {
  if (!seconds) return "-"
  const date = new Date(Number(seconds) * 1000)
  if (Number.isNaN(date.getTime())) return "-"
  return date.toLocaleString()
}

function vendorFileLabel(files?: Record<string, boolean>): string {
  if (!files) return "-"
  const okCount = Object.values(files).filter(Boolean).length
  return `${okCount}/${Object.keys(files).length}`
}

function maskMobileUrl(url?: string | null): string {
  if (!url) return ""
  return "********"
}

function compactMobileUrl(url?: string | null): string {
  if (!url) return ""
  const maxLength = 58
  if (url.length <= maxLength) return url
  return `${url.slice(0, 36)}...${url.slice(-16)}`
}

function requestHostedSurfaceWriteClipboard(text: string): Promise<unknown> {
  const requestId = `clipboard-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onMessage)
      reject(new Error("write_clipboard_request_timeout"))
    }, 10000)

    function onMessage(event: MessageEvent) {
      const data = event.data
      if (!data || typeof data !== "object") return
      if (data.type !== "neko-hosted-surface-response" || data.requestId !== requestId) return
      window.clearTimeout(timer)
      window.removeEventListener("message", onMessage)
      if (data.ok) {
        resolve(data.result)
      } else {
        reject(new Error(data.error || "write_clipboard_failed"))
      }
    }

    window.addEventListener("message", onMessage)
    window.parent.postMessage({
      type: "neko-hosted-surface-request",
      requestId,
      method: "writeClipboard",
      payload: { text },
    }, "*")
  })
}

function copyTextWithLegacyCommand(text: string): boolean {
  const textarea = document.createElement("textarea")
  textarea.value = text
  textarea.setAttribute("readonly", "readonly")
  textarea.style.position = "fixed"
  textarea.style.left = "-9999px"
  textarea.style.top = "-9999px"
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  try {
    return document.execCommand("copy")
  } finally {
    document.body.removeChild(textarea)
  }
}

async function writeTextToClipboard(text: string): Promise<void> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {
  }
  if (copyTextWithLegacyCommand(text)) return
  await requestHostedSurfaceWriteClipboard(text)
}

export default function MobileTunnelPanel(props: PluginSurfaceProps<MobileTunnelState>) {
  const { state, t } = props
  const safeState = state || {}
  const running = !!safeState.running
  const vendorReady = safeState.vendor?.ready !== false
  const toast = useToast()
  const confirm = useConfirm()
  const [mobileUrlVisible, setMobileUrlVisible] = useState(false)
  const [startPending, setStartPending] = useState(false)
  const manualMobileModeToastKeyRef = useRef("")

  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => {
      props.api.refresh().catch(() => {})
    }, 2000)
    return () => window.clearInterval(timer)
  }, [running])

  useEffect(() => {
    setMobileUrlVisible(false)
  }, [safeState.mobile_url])

  useEffect(() => {
    if (!running) {
      manualMobileModeToastKeyRef.current = ""
      return
    }
    const enterCount = Number(safeState.mobile_enter_count || 0)
    const startedAt = Number(safeState.started_at || 0)
    if (enterCount <= 0 || !startedAt) return
    const toastKey = String(startedAt)
    if (manualMobileModeToastKeyRef.current === toastKey) return
    manualMobileModeToastKeyRef.current = toastKey
    toast.info(t("panel.toast.manualMobileMode"), { timeout: MANUAL_MOBILE_MODE_TOAST_TIMEOUT_MS })
  }, [running, safeState.started_at, safeState.mobile_enter_count])

  async function startTunnel() {
    if (startPending) return
    setStartPending(true)
    const closeStartingToast = toast.info(t("panel.toast.starting"), { timeout: STARTING_TOAST_TIMEOUT_MS })
    try {
      await props.api.call("start_tunnel", {})
      await props.api.refresh()
      closeStartingToast()
      toast.success(t("panel.toast.started"))
    } catch (error) {
      closeStartingToast()
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setStartPending(false)
    }
  }

  async function stopTunnel() {
    const ok = await confirm({
      title: t("panel.actions.stop"),
      message: t("panel.confirm.stop"),
      tone: "danger",
      confirmLabel: t("panel.actions.stop"),
      cancelLabel: t("panel.actions.cancel"),
    })
    if (!ok) return
    try {
      await props.api.call("stop_tunnel", {})
      await props.api.refresh()
      toast.success(t("panel.toast.stopped"))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  async function rotateToken() {
    try {
      await props.api.call("rotate_token", {})
      await props.api.refresh()
      toast.success(t("panel.toast.rotated"))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  async function copyMobileUrl() {
    const url = safeState.mobile_url || ""
    if (!url) return
    try {
      await writeTextToClipboard(url)
      toast.success(t("panel.toast.copied"))
    } catch (error) {
      toast.error(t("panel.toast.copyFailed"))
    }
  }

  function toggleMobileUrlVisible() {
    setMobileUrlVisible((value) => !value)
  }

  function handleMobileUrlKeyDown(event: KeyboardEvent) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      toggleMobileUrlVisible()
    }
  }

  const statusTone = safeState.status === "error" ? "danger" : running ? "success" : safeState.status === "starting" ? "warning" : "primary"
  const displayedMobileUrl = mobileUrlVisible ? compactMobileUrl(safeState.mobile_url) : maskMobileUrl(safeState.mobile_url)
  const idleStopValue = running ? (safeState.idle_locked ? t("panel.stats.idleLocked") : formatRemaining(t, safeState.idle_remaining_seconds)) : "-"

  return (
    <Page title={t("panel.title")} subtitle={t("panel.subtitle")}>
      <Grid cols={4}>
        <StatCard
          label={t("panel.stats.status")}
          value={<StatusBadge tone={statusTone} label={safeState.status_label || t("panel.status.idle")} />}
        />
        <StatCard label={t("panel.stats.idleStop")} value={idleStopValue} />
        <StatCard label={t("panel.stats.gateway")} value={safeState.gateway_port ? String(safeState.gateway_port) : "-"} />
        <StatCard
          label={t("panel.stats.vendor")}
          value={<StatusBadge tone={vendorReady ? "success" : "danger"} label={vendorReady ? t("panel.vendor.ready") : t("panel.vendor.missing")} />}
        />
      </Grid>

      {safeState.error ? <Alert tone="danger">{safeState.error}</Alert> : null}
      {safeState.message ? <Alert tone={running ? "warning" : "primary"}>{safeState.message}</Alert> : null}
      {running ? <Alert tone="warning">{t("panel.warning.public")}</Alert> : null}
      <Alert tone="primary">{t("panel.warning.cache")}</Alert>

      <Grid cols={2}>
        <Card title={running ? t("panel.share.runningTitle") : t("panel.share.startTitle")}>
          <Stack>
            {running && safeState.qr_code_url ? (
              <div style={{ display: "grid", placeItems: "center" }}>
                <img
                  src={safeState.qr_code_url}
                  alt={t("panel.qr.alt")}
                  style={{
                    width: "min(260px, 100%)",
                    aspectRatio: "1 / 1",
                    border: "1px solid #d8e0ea",
                    borderRadius: "8px",
                    background: "#fff",
                    padding: "10px",
                  }}
                />
              </div>
            ) : null}

            {running && safeState.mobile_url ? (
              <>
                <Field label={t("panel.fields.mobileUrl")}>
                  <div
                    role="button"
                    tabIndex={0}
                    title={mobileUrlVisible ? t("panel.actions.hideLink") : t("panel.actions.showLink")}
                    onClick={toggleMobileUrlVisible}
                    onKeyDown={handleMobileUrlKeyDown}
                    style={{ cursor: "pointer", maxWidth: "100%", minWidth: 0, overflow: "hidden" }}
                  >
                    <CodeBlock>{displayedMobileUrl}</CodeBlock>
                  </div>
                </Field>
                <ButtonGroup>
                  <Button tone="default" onClick={toggleMobileUrlVisible}>{mobileUrlVisible ? t("panel.actions.hideLink") : t("panel.actions.showLink")}</Button>
                  <Button tone="primary" onClick={copyMobileUrl}>{t("panel.actions.copy")}</Button>
                  <Button tone="warning" onClick={rotateToken}>{t("panel.actions.rotate")}</Button>
                  <Button tone="danger" onClick={stopTunnel}>{t("panel.actions.stop")}</Button>
                </ButtonGroup>
              </>
            ) : (
              <>
                <Text>{t("panel.share.description")}</Text>
                <ButtonGroup>
                  <Button tone="success" disabled={!vendorReady || startPending} onClick={startTunnel}>{startPending ? t("panel.actions.starting") : t("panel.actions.start")}</Button>
                  <RefreshButton label={t("panel.actions.refresh")} />
                </ButtonGroup>
              </>
            )}
          </Stack>
        </Card>

        <Card title={t("panel.details.title")}>
          <Stack>
            <KeyValue
              items={[
                { key: "started", label: t("panel.details.startedAt"), value: formatDate(safeState.started_at) },
                { key: "entered", label: t("panel.details.lastEnteredAt"), value: formatDate(safeState.last_mobile_entered_at) },
                { key: "lastAccess", label: t("panel.details.lastAccessAt"), value: formatDate(safeState.last_mobile_access_at) },
                { key: "idleStop", label: t("panel.details.idleStopIn"), value: idleStopValue },
                { key: "enterCount", label: t("panel.details.enterCount"), value: String(safeState.mobile_enter_count || 0) },
                { key: "cloudflared", label: "cloudflared", value: safeState.cloudflared_version || "-" },
                { key: "vendorFiles", label: t("panel.details.vendorFiles"), value: vendorFileLabel(safeState.vendor?.files) },
              ]}
            />
            <Text>{t("panel.details.note")}</Text>
          </Stack>
        </Card>
      </Grid>
    </Page>
  )
}
