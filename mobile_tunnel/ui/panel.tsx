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

type TailscaleStatus = {
  installed?: boolean
  path?: string
  version?: string
  backend_state?: string
  logged_in?: boolean
  login_name?: string
  dns_name?: string
  funnel_ready?: boolean
  error?: string
  download_url?: string
  funnel_docs_url?: string
}

type CpolarStatus = {
  installed?: boolean
  path?: string
  version?: string
  authenticated?: boolean
  config_path?: string
  region?: string
  error?: string
  download_url?: string
  dashboard_url?: string
  auth_url?: string
  docs_url?: string
}

type TailscaleGuideStepData = {
  title: string
  body: string
  image: string
  imageUrls?: string[]
  extraContent?: any
  codeLabel?: string
  code?: string
  copyCodeLabel?: string
  actionLabel?: string
  actionUrl?: string
  secondaryActionLabel?: string
  secondaryActionUrl?: string
  actionButtonLabel?: string
  actionButtonPendingLabel?: string
  actionButtonTone?: any
  actionButtonDisabled?: boolean
  actionButtonPending?: boolean
  onActionButtonClick?: () => void
}

type MobileTunnelState = {
  status?: string
  running?: boolean
  status_label?: string
  public_url?: string | null
  mobile_url?: string | null
  tunnel_provider?: string | null
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
  tailscale?: TailscaleStatus
  cpolar?: CpolarStatus
  error?: string | null
  message?: string | null
}

const MANUAL_MOBILE_MODE_TOAST_TIMEOUT_MS = 30000
const STARTING_TOAST_TIMEOUT_MS = 45000
const TAILSCALE_DOWNLOAD_URL = "https://tailscale.com/download/windows"
const TAILSCALE_FUNNEL_DOCS_URL = "https://tailscale.com/docs/features/tailscale-funnel"
const TAILSCALE_ACCESS_CONTROLS_URL = "https://login.tailscale.com/admin/acls/file"
const TAILSCALE_DNS_SETTINGS_URL = "https://login.tailscale.com/admin/dns"
const TAILSCALE_TUTORIAL_IMAGE_BASE = "/plugin/mobile_tunnel/ui/tutorial"
const CPOLAR_DOWNLOAD_URL = "https://www.cpolar.com/download"
const CPOLAR_AUTH_URL = "https://dashboard.cpolar.com/auth"
const CPOLAR_DOCS_URL = "https://www.cpolar.com/docs"
const CPOLAR_TUTORIAL_IMAGE_BASE = "/plugin/mobile_tunnel/ui/tutorial"
const TAILSCALE_FUNNEL_POLICY_TEMPLATE = `// Example/default ACLs for unrestricted connections.
{
  // Declare static groups of users. Use autogroups for all users or users with a specific role.
  // "groups": {
  //   "group:example": ["alice@example.com", "bob@example.com"],
  // },

  // Define the tags which can be applied to devices and by which users.
  // "tagOwners": {
  //   "tag:example": ["autogroup:admin"],
  // },

  // Define grants that govern access for users, groups, autogroups, tags,
  // Tailscale IP addresses, and subnet ranges.
  "grants": [
    // Allow all connections.
    // Comment this section out if you want to define specific restrictions.
    {"src": ["*"], "dst": ["*"], "ip": ["*"]},

    // Allow users in "group:example" to access "tag:example", but only from
    // devices that are running macOS and have enabled Tailscale client auto-updating.
    // {"src": ["group:example"], "dst": ["tag:example"], "ip": ["*"], "srcPosture":["posture:autoUpdateMac"]},
  ],

  // Allow tailnet members to use Tailscale Funnel.
  "nodeAttrs": [
    {
      "target": ["autogroup:member"],
      "attr": ["funnel"]
    }
  ],

  // Define postures that will be applied to all rules without any specific
  // srcPosture definition.
  // "defaultSrcPosture": [
  //     "posture:anyMac",
  // ],

  // Define device posture rules requiring devices to meet
  // certain criteria to access parts of your system.
  // "postures": {
  //     // Require devices running macOS, a stable Tailscale
  //     // version and auto update enabled for Tailscale.
  //   "posture:autoUpdateMac": [
  //       "node:os == 'macos'",
  //       "node:tsReleaseTrack == 'stable'",
  //       "node:tsAutoUpdate",
  //   ],
  //     // Require devices running macOS and a stable
  //     // Tailscale version.
  //   "posture:anyMac": [
  //       "node:os == 'macos'",
  //       "node:tsReleaseTrack == 'stable'",
  //   ],
  // },

  // Define users and devices that can use Tailscale SSH.
  "ssh": [
    // Allow all users to SSH into their own devices in check mode.
    // Comment this section out if you want to define specific restrictions.
    {
      "action": "check",
      "src":    ["autogroup:member"],
      "dst":    ["autogroup:self"],
      "users":  ["autogroup:nonroot", "root"],
    },
  ],

  // Test access rules every time they're saved.
  // "tests": [
  //   {
  //     "src": "alice@example.com",
  //     "accept": ["tag:example"],
  //     "deny": ["100.101.102.103:443"],
  //   },
  // ],
}`

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

function compactText(text?: string | null, maxLength = 68): string {
  if (!text) return "-"
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.max(0, maxLength - 18))}...${text.slice(-15)}`
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

function openExternalUrl(url?: string | null) {
  const target = url || ""
  if (!target) return
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({
        type: "neko-hosted-surface-open-external",
        payload: { url: target },
      }, "*")
      return
    }
  } catch {
    window.open(target, "_blank", "noopener,noreferrer")
    return
  }
  window.open(target, "_blank", "noopener,noreferrer")
}

function tabButtonStyle(active: boolean): Record<string, string | number> {
  return {
    appearance: "none",
    border: "1px solid",
    borderColor: active ? "#24476f" : "#d8e0ea",
    background: active ? "#24476f" : "#ffffff",
    color: active ? "#ffffff" : "#34445c",
    fontWeight: active ? 800 : 650,
    minHeight: "38px",
    padding: "0 16px",
    borderRadius: "7px",
    cursor: "pointer",
    boxShadow: active ? "0 2px 8px rgba(36, 71, 111, .2)" : "none",
  }
}

function TailscaleGuideStep(props: {
  index: number
  title: string
  body: string
  image: string
  imageUrls?: string[]
  extraContent?: any
  codeLabel?: string
  code?: string
  copyCodeLabel?: string
  actionLabel?: string
  actionUrl?: string
  secondaryActionLabel?: string
  secondaryActionUrl?: string
  actionButtonLabel?: string
  actionButtonPendingLabel?: string
  actionButtonTone?: any
  actionButtonDisabled?: boolean
  actionButtonPending?: boolean
  onActionButtonClick?: () => void
  onOpenUrl: (url?: string | null) => void
  onCopyCode?: (code: string) => void
}) {
  const imageUrls = props.imageUrls || []
  const [selectedImageIndex, setSelectedImageIndex] = useState(0)
  const activeImageIndex = Math.min(selectedImageIndex, Math.max(imageUrls.length - 1, 0))
  const activeImageUrl = imageUrls[activeImageIndex]

  return (
    <div
      style={{
        display: "grid",
        gap: "10px",
        minWidth: 0,
        padding: "12px",
        border: "1px solid #d8e0ea",
        borderRadius: "8px",
        background: "#ffffff",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <div
          style={{
            display: "grid",
            placeItems: "center",
            width: "28px",
            height: "28px",
            borderRadius: "999px",
            background: "#24476f",
            color: "#ffffff",
            fontWeight: 800,
          }}
        >
          {props.index}
        </div>
        <strong>{props.title}</strong>
      </div>
      <Text>{props.body}</Text>
      {props.code && props.copyCodeLabel && props.onCopyCode ? (
        <Field label={props.codeLabel || ""}>
          <Button tone="primary" onClick={() => props.onCopyCode?.(props.code || "")}>
            {props.copyCodeLabel}
          </Button>
        </Field>
      ) : null}
      {props.extraContent || null}
      {imageUrls.length > 0 ? (
        <div style={{ display: "grid", gap: "8px", minWidth: 0 }}>
          {imageUrls.length > 1 ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
              {imageUrls.map((url, index) => {
                const active = index === activeImageIndex
                return (
                  <button
                    key={url}
                    type="button"
                    aria-label={`${props.title} ${index + 1}`}
                    aria-pressed={active}
                    onClick={() => setSelectedImageIndex(index)}
                    style={{
                      appearance: "none",
                      display: "grid",
                      placeItems: "center",
                      width: "32px",
                      height: "32px",
                      border: "1px solid",
                      borderColor: active ? "#24476f" : "#c8d5e3",
                      borderRadius: "8px",
                      background: active ? "#24476f" : "#ffffff",
                      color: active ? "#ffffff" : "#34445c",
                      fontWeight: 800,
                      cursor: "pointer",
                    }}
                  >
                    {index + 1}
                  </button>
                )
              })}
            </div>
          ) : null}
          {activeImageUrl ? (
            <img
              src={activeImageUrl}
              alt={`${props.title} ${activeImageIndex + 1}`}
              loading="lazy"
              style={{
                display: "block",
                width: "100%",
                maxHeight: "260px",
                objectFit: "contain",
                border: "1px solid #d8e0ea",
                borderRadius: "8px",
                background: "#f7f9fc",
              }}
            />
          ) : null}
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            placeItems: "center",
            minHeight: "138px",
            padding: "12px",
            border: "1px dashed #b6c3d1",
            borderRadius: "8px",
            background: "#f7f9fc",
            color: "#5c6f86",
            textAlign: "center",
          }}
        >
          {props.image}
        </div>
      )}
      {(props.actionLabel && props.actionUrl) || (props.secondaryActionLabel && props.secondaryActionUrl) ? (
        <div style={{ justifySelf: "start", alignSelf: "start", maxWidth: "100%" }}>
          <ButtonGroup>
            {props.actionLabel && props.actionUrl ? (
              <Button tone="default" onClick={() => props.onOpenUrl(props.actionUrl)}>
                {props.actionLabel}
              </Button>
            ) : null}
            {props.secondaryActionLabel && props.secondaryActionUrl ? (
              <Button tone="default" onClick={() => props.onOpenUrl(props.secondaryActionUrl)}>
                {props.secondaryActionLabel}
              </Button>
            ) : null}
          </ButtonGroup>
        </div>
      ) : null}
      {props.actionButtonLabel && props.onActionButtonClick ? (
        <div style={{ justifySelf: "start", alignSelf: "start", maxWidth: "100%" }}>
          <Button
            tone={props.actionButtonTone || "primary"}
            disabled={!!props.actionButtonDisabled || !!props.actionButtonPending}
            onClick={props.onActionButtonClick}
          >
            {props.actionButtonPending ? (props.actionButtonPendingLabel || props.actionButtonLabel) : props.actionButtonLabel}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

export default function MobileTunnelPanel(props: PluginSurfaceProps<MobileTunnelState>) {
  const { state, t } = props
  const safeState = state || {}
  const running = !!safeState.running
  const vendorReady = safeState.vendor?.ready !== false
  const toast = useToast()
  const confirm = useConfirm()
  const [activeTab, setActiveTab] = useState<"cloudflare" | "tailscale" | "cpolar">("cloudflare")
  const [mobileUrlVisible, setMobileUrlVisible] = useState(false)
  const [startPending, setStartPending] = useState(false)
  const [tailscaleStartPending, setTailscaleStartPending] = useState(false)
  const [tailscaleCheckPending, setTailscaleCheckPending] = useState(false)
  const [cpolarStartPending, setCpolarStartPending] = useState(false)
  const [cpolarCheckPending, setCpolarCheckPending] = useState(false)
  const [cpolarAuthPending, setCpolarAuthPending] = useState(false)
  const [cpolarAuthToken, setCpolarAuthToken] = useState("")
  const cpolarAuthInputRef = useRef<HTMLInputElement | null>(null)
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

  async function startTailscaleFunnel() {
    if (tailscaleStartPending) return
    setTailscaleStartPending(true)
    const closeStartingToast = toast.info(t("panel.tailscale.toast.starting"), { timeout: STARTING_TOAST_TIMEOUT_MS })
    try {
      await props.api.call("get_tailscale_status", { start_funnel: true })
      await props.api.refresh()
      closeStartingToast()
      toast.success(t("panel.tailscale.toast.started"))
    } catch (error) {
      closeStartingToast()
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setTailscaleStartPending(false)
    }
  }

  async function copyTailscalePolicy(code: string) {
    if (!code) return
    try {
      await writeTextToClipboard(code)
      toast.success(t("panel.tailscale.toast.policyCopied"))
    } catch (error) {
      toast.error(t("panel.tailscale.toast.policyCopyFailed"))
    }
  }

  async function refreshTailscaleStatus() {
    if (tailscaleCheckPending) return
    setTailscaleCheckPending(true)
    try {
      await props.api.call("get_tailscale_status", {})
      await props.api.refresh()
      toast.success(t("panel.tailscale.toast.checked"))
    } catch (error) {
      toast.error(t("panel.tailscale.toast.checkFailed"))
    } finally {
      setTailscaleCheckPending(false)
    }
  }

  async function startCpolarTunnel() {
    if (cpolarStartPending) return
    setCpolarStartPending(true)
    const closeStartingToast = toast.info(t("panel.cpolar.toast.starting"), { timeout: STARTING_TOAST_TIMEOUT_MS })
    try {
      await props.api.call("get_cpolar_status", { start_cpolar: true })
      await props.api.refresh()
      closeStartingToast()
      toast.success(t("panel.cpolar.toast.started"))
    } catch (error) {
      closeStartingToast()
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setCpolarStartPending(false)
    }
  }

  async function refreshCpolarStatus() {
    if (cpolarCheckPending) return
    setCpolarCheckPending(true)
    try {
      await props.api.call("get_cpolar_status", {})
      await props.api.refresh()
      toast.success(t("panel.cpolar.toast.checked"))
    } catch (error) {
      toast.error(t("panel.cpolar.toast.checkFailed"))
    } finally {
      setCpolarCheckPending(false)
    }
  }

  async function saveCpolarAuthToken() {
    const token = (cpolarAuthInputRef.current?.value || cpolarAuthToken).trim()
    if (!token || cpolarAuthPending) return
    setCpolarAuthPending(true)
    try {
      await props.api.call("get_cpolar_status", { auth_token: token })
      setCpolarAuthToken("")
      await props.api.refresh()
      toast.success(t("panel.cpolar.toast.authSaved"))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("panel.cpolar.toast.authFailed"))
    } finally {
      setCpolarAuthPending(false)
    }
  }

  function handleCpolarAuthTokenInput(event: any) {
    const target = event?.currentTarget || event?.target
    setCpolarAuthToken(String(target?.value || ""))
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
  const tunnelProvider = safeState.tunnel_provider || ""
  const cloudflareRunning = running && tunnelProvider === "cloudflare"
  const otherTunnelRunningForCloudflare = running && tunnelProvider && tunnelProvider !== "cloudflare"
  const tailscaleRunning = running && tunnelProvider === "tailscale"
  const cpolarRunning = running && tunnelProvider === "cpolar"
  const otherTunnelRunning = running && tunnelProvider && tunnelProvider !== "tailscale"
  const otherTunnelRunningForCpolar = running && tunnelProvider && tunnelProvider !== "cpolar"
  const idleStopValue = running ? (safeState.idle_locked ? t("panel.stats.idleLocked") : formatRemaining(t, safeState.idle_remaining_seconds)) : "-"
  const networkWarning = t("panel.warning.network").trim()
  const tailscale = safeState.tailscale || {}
  const tailscaleInstalled = !!tailscale.installed
  const tailscaleLoggedIn = !!tailscale.logged_in
  const tailscaleFunnelReady = !!tailscale.funnel_ready
  const tailscaleTone = !tailscaleInstalled ? "danger" : tailscaleFunnelReady ? "success" : "warning"
  const tailscaleGuide = !tailscaleInstalled
    ? t("panel.tailscale.installGuide")
    : tailscaleLoggedIn
      ? t("panel.tailscale.readyGuide")
      : t("panel.tailscale.loginGuide")
  const tailscaleGuideSteps: TailscaleGuideStepData[] = [
    {
      title: t("panel.tailscale.guide.install.title"),
      body: t("panel.tailscale.guide.install.body"),
      image: t("panel.tailscale.guide.install.image"),
      imageUrls: [
        `${TAILSCALE_TUTORIAL_IMAGE_BASE}/01-download-page.png`,
        `${TAILSCALE_TUTORIAL_IMAGE_BASE}/02-client-get-started.png`,
        `${TAILSCALE_TUTORIAL_IMAGE_BASE}/03-client-sign-in.png`,
        `${TAILSCALE_TUTORIAL_IMAGE_BASE}/04-connect-device.png`,
      ],
      actionLabel: t("panel.tailscale.guide.install.action"),
      actionUrl: tailscale.download_url || TAILSCALE_DOWNLOAD_URL,
    },
    {
      title: t("panel.tailscale.guide.prerequisites.title"),
      body: t("panel.tailscale.guide.prerequisites.body"),
      image: t("panel.tailscale.guide.prerequisites.image"),
      imageUrls: [`${TAILSCALE_TUTORIAL_IMAGE_BASE}/05-enable-https.png`],
      actionLabel: t("panel.tailscale.guide.prerequisites.action"),
      actionUrl: TAILSCALE_DNS_SETTINGS_URL,
    },
    {
      title: t("panel.tailscale.guide.funnel.title"),
      body: t("panel.tailscale.guide.funnel.body"),
      image: t("panel.tailscale.guide.funnel.image"),
      imageUrls: [`${TAILSCALE_TUTORIAL_IMAGE_BASE}/06-access-controls-json.png`],
      codeLabel: t("panel.tailscale.guide.funnel.policyLabel"),
      code: TAILSCALE_FUNNEL_POLICY_TEMPLATE,
      copyCodeLabel: t("panel.tailscale.guide.funnel.copyFull"),
      secondaryActionLabel: t("panel.tailscale.guide.funnel.accessAction"),
      secondaryActionUrl: TAILSCALE_ACCESS_CONTROLS_URL,
    },
    {
      title: t("panel.tailscale.guide.check.title"),
      body: t("panel.tailscale.guide.check.body"),
      image: t("panel.tailscale.guide.check.image"),
      imageUrls: [`${TAILSCALE_TUTORIAL_IMAGE_BASE}/07-plugin-check.png`],
    },
  ]
  const cpolar = safeState.cpolar || {}
  const cpolarInstalled = !!cpolar.installed
  const cpolarAuthenticated = !!cpolar.authenticated
  const cpolarReady = cpolarInstalled && cpolarAuthenticated
  const cpolarGuide = !cpolarInstalled
    ? t("panel.cpolar.installGuide")
    : cpolarAuthenticated
      ? t("panel.cpolar.readyGuide")
      : t("panel.cpolar.authGuide")
  const cpolarGuideSteps: TailscaleGuideStepData[] = [
    {
      title: t("panel.cpolar.guide.install.title"),
      body: t("panel.cpolar.guide.install.body"),
      image: t("panel.cpolar.guide.install.image"),
      imageUrls: [
        `${CPOLAR_TUTORIAL_IMAGE_BASE}/08-cpolar-download-page.png`,
        `${CPOLAR_TUTORIAL_IMAGE_BASE}/09-cpolar-check-install.png`,
      ],
      actionLabel: t("panel.cpolar.guide.install.action"),
      actionUrl: cpolar.download_url || CPOLAR_DOWNLOAD_URL,
      actionButtonLabel: t("panel.cpolar.guide.install.confirm"),
      actionButtonPendingLabel: t("panel.cpolar.actions.checking"),
      actionButtonTone: "primary",
      actionButtonDisabled: cpolarCheckPending,
      actionButtonPending: cpolarCheckPending,
      onActionButtonClick: refreshCpolarStatus,
    },
    {
      title: t("panel.cpolar.guide.auth.title"),
      body: t("panel.cpolar.guide.auth.body"),
      image: t("panel.cpolar.guide.auth.image"),
      imageUrls: [
        `${CPOLAR_TUTORIAL_IMAGE_BASE}/10-cpolar-token-page.png`,
        `${CPOLAR_TUTORIAL_IMAGE_BASE}/11-cpolar-save-token.png`,
      ],
      extraContent: (
        <div style={{ display: "grid", gap: "8px", minWidth: 0 }}>
          <input
            ref={cpolarAuthInputRef}
            type="password"
            value={cpolarAuthToken}
            placeholder={t("panel.cpolar.guide.auth.placeholder")}
            onInput={handleCpolarAuthTokenInput}
            onChange={handleCpolarAuthTokenInput}
            style={{
              width: "100%",
              minHeight: "38px",
              boxSizing: "border-box",
              border: "1px solid #c8d5e3",
              borderRadius: "7px",
              padding: "0 10px",
              color: "#172033",
              background: "#ffffff",
            }}
          />
          <div style={{ justifySelf: "start" }}>
            <Button tone="primary" disabled={!cpolarAuthToken.trim() || cpolarAuthPending} onClick={saveCpolarAuthToken}>
              {cpolarAuthPending ? t("panel.cpolar.guide.auth.saving") : t("panel.cpolar.guide.auth.save")}
            </Button>
          </div>
        </div>
      ),
      actionLabel: t("panel.cpolar.guide.auth.action"),
      actionUrl: cpolar.auth_url || CPOLAR_AUTH_URL,
    },
    {
      title: t("panel.cpolar.guide.check.title"),
      body: t("panel.cpolar.guide.check.body"),
      image: t("panel.cpolar.guide.check.image"),
      imageUrls: [
        `${CPOLAR_TUTORIAL_IMAGE_BASE}/12-cpolar-status-check.png`,
        `${CPOLAR_TUTORIAL_IMAGE_BASE}/13-cpolar-running.png`,
      ],
    },
  ]

  return (
    <Page title={t("panel.title")} subtitle={t("panel.subtitle")}>
      <div
        role="tablist"
        aria-label={t("panel.tabs.label")}
        style={{
          display: "inline-flex",
          gap: "6px",
          padding: "4px",
          border: "1px solid #d8e0ea",
          borderRadius: "8px",
          background: "#f3f6fb",
        }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "cloudflare"}
          style={tabButtonStyle(activeTab === "cloudflare")}
          onClick={() => setActiveTab("cloudflare")}
        >
          {t("panel.tabs.cloudflare")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "tailscale"}
          style={tabButtonStyle(activeTab === "tailscale")}
          onClick={() => setActiveTab("tailscale")}
        >
          {t("panel.tabs.tailscale")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "cpolar"}
          style={tabButtonStyle(activeTab === "cpolar")}
          onClick={() => setActiveTab("cpolar")}
        >
          {t("panel.tabs.cpolar")}
        </button>
      </div>

      {activeTab === "cloudflare" ? (
        <>
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
      {cloudflareRunning ? <Alert tone="warning">{t("panel.warning.public")}</Alert> : null}
      {networkWarning && (!running || cloudflareRunning) ? <Alert tone="warning">{networkWarning}</Alert> : null}
      {otherTunnelRunningForCloudflare ? <Alert tone="warning">{t("panel.cloudflare.otherRunning")}</Alert> : null}
      <Alert tone="primary">{t("panel.warning.cache")}</Alert>

      <Grid cols={2}>
        <Card title={cloudflareRunning ? t("panel.share.runningTitle") : t("panel.share.startTitle")}>
          <Stack>
            {cloudflareRunning && safeState.qr_code_url ? (
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

            {cloudflareRunning && safeState.mobile_url ? (
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
                  <Button tone="success" disabled={!vendorReady || running || startPending} onClick={startTunnel}>{startPending ? t("panel.actions.starting") : t("panel.actions.start")}</Button>
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
        </>
      ) : activeTab === "tailscale" ? (
        <Stack>
          <Grid cols={4}>
            <StatCard
              label={t("panel.tailscale.fields.installation")}
              value={<StatusBadge tone={tailscaleInstalled ? "success" : "danger"} label={tailscaleInstalled ? t("panel.tailscale.status.installed") : t("panel.tailscale.status.missing")} />}
            />
            <StatCard
              label={t("panel.tailscale.fields.account")}
              value={<StatusBadge tone={tailscaleLoggedIn ? "success" : "warning"} label={tailscaleLoggedIn ? t("panel.tailscale.status.loggedIn") : t("panel.tailscale.status.notLoggedIn")} />}
            />
            <StatCard
              label={t("panel.tailscale.fields.funnel")}
              value={<StatusBadge tone={tailscaleTone} label={tailscaleFunnelReady ? t("panel.tailscale.funnelReady") : t("panel.tailscale.funnelNotReady")} />}
            />
            <StatCard label={t("panel.tailscale.fields.version")} value={tailscale.version || "-"} />
          </Grid>

          <Alert tone={tailscaleInstalled ? "primary" : "warning"}>{tailscaleGuide}</Alert>
          <Alert tone="primary">{t("panel.tailscale.prepareNote")}</Alert>
          {tailscale.error ? <Alert tone="warning">{tailscale.error}</Alert> : null}

          <Grid cols={2}>
            <Card title={t("panel.tailscale.title")}>
              <Stack>
                <Text>{t("panel.tailscale.description")}</Text>
                {tailscaleRunning && safeState.qr_code_url ? (
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
                {tailscaleRunning && safeState.mobile_url ? (
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
                ) : null}
                {otherTunnelRunning ? <Alert tone="warning">{t("panel.tailscale.otherRunning")}</Alert> : null}
                <ButtonGroup>
                  <Button tone="success" disabled={!tailscaleFunnelReady || running || tailscaleStartPending} onClick={startTailscaleFunnel}>
                    {tailscaleStartPending ? t("panel.tailscale.actions.starting") : t("panel.tailscale.actions.start")}
                  </Button>
                  <Button tone="primary" disabled={tailscaleCheckPending} onClick={refreshTailscaleStatus}>
                    {tailscaleCheckPending ? t("panel.tailscale.actions.checking") : t("panel.tailscale.actions.check")}
                  </Button>
                  <Button tone="default" onClick={() => openExternalUrl(tailscale.download_url || TAILSCALE_DOWNLOAD_URL)}>{t("panel.tailscale.actions.download")}</Button>
                  <Button tone="default" onClick={() => openExternalUrl(tailscale.funnel_docs_url || TAILSCALE_FUNNEL_DOCS_URL)}>{t("panel.tailscale.actions.docs")}</Button>
                </ButtonGroup>
              </Stack>
            </Card>

            <Card title={t("panel.tailscale.detailsTitle")}>
              <Stack>
                <KeyValue
                  items={[
                    { key: "backend", label: t("panel.tailscale.fields.backend"), value: tailscale.backend_state || "-" },
                    { key: "account", label: t("panel.tailscale.fields.account"), value: tailscale.login_name || "-" },
                    { key: "dns", label: t("panel.tailscale.fields.dnsName"), value: tailscale.dns_name || "-" },
                    { key: "path", label: t("panel.tailscale.fields.path"), value: compactText(tailscale.path) },
                  ]}
                />
              </Stack>
            </Card>
          </Grid>

          <Card title={t("panel.tailscale.guideTitle")}>
            <Stack>
              <Text>{t("panel.tailscale.guideIntro")}</Text>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
                  gap: "12px",
                }}
              >
                {tailscaleGuideSteps.map((step, index) => (
                  <TailscaleGuideStep
                    key={step.title}
                    index={index + 1}
                    title={step.title}
                    body={step.body}
                    image={step.image}
                    imageUrls={step.imageUrls}
                    codeLabel={step.codeLabel}
                    code={step.code}
                    copyCodeLabel={step.copyCodeLabel}
                    actionLabel={step.actionLabel}
                    actionUrl={step.actionUrl}
                    secondaryActionLabel={step.secondaryActionLabel}
                    secondaryActionUrl={step.secondaryActionUrl}
                    onOpenUrl={openExternalUrl}
                    onCopyCode={copyTailscalePolicy}
                  />
                ))}
              </div>
            </Stack>
          </Card>
        </Stack>
      ) : (
        <Stack>
          <Grid cols={4}>
            <StatCard
              label={t("panel.cpolar.fields.installation")}
              value={<StatusBadge tone={cpolarInstalled ? "success" : "danger"} label={cpolarInstalled ? t("panel.cpolar.status.installed") : t("panel.cpolar.status.missing")} />}
            />
            <StatCard
              label={t("panel.cpolar.fields.auth")}
              value={<StatusBadge tone={cpolarAuthenticated ? "success" : "warning"} label={cpolarAuthenticated ? t("panel.cpolar.status.authenticated") : t("panel.cpolar.status.notAuthenticated")} />}
            />
            <StatCard label={t("panel.cpolar.fields.region")} value={cpolar.region || "-"} />
            <StatCard label={t("panel.cpolar.fields.version")} value={cpolar.version || "-"} />
          </Grid>

          <Alert tone={cpolarReady ? "primary" : "warning"}>{cpolarGuide}</Alert>
          <Alert tone="primary">{t("panel.cpolar.prepareNote")}</Alert>
          {cpolar.error ? <Alert tone="warning">{cpolar.error}</Alert> : null}

          <Grid cols={2}>
            <Card title={t("panel.cpolar.title")}>
              <Stack>
                <Text>{t("panel.cpolar.description")}</Text>
                {cpolarRunning && safeState.qr_code_url ? (
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
                {cpolarRunning && safeState.mobile_url ? (
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
                ) : null}
                {otherTunnelRunningForCpolar ? <Alert tone="warning">{t("panel.cpolar.otherRunning")}</Alert> : null}
                <ButtonGroup>
                  <Button tone="success" disabled={!cpolarReady || running || cpolarStartPending} onClick={startCpolarTunnel}>
                    {cpolarStartPending ? t("panel.cpolar.actions.starting") : t("panel.cpolar.actions.start")}
                  </Button>
                  <Button tone="primary" disabled={cpolarCheckPending} onClick={refreshCpolarStatus}>
                    {cpolarCheckPending ? t("panel.cpolar.actions.checking") : t("panel.cpolar.actions.check")}
                  </Button>
                  <Button tone="default" onClick={() => openExternalUrl(cpolar.download_url || CPOLAR_DOWNLOAD_URL)}>{t("panel.cpolar.actions.download")}</Button>
                  <Button tone="default" onClick={() => openExternalUrl(cpolar.auth_url || CPOLAR_AUTH_URL)}>{t("panel.cpolar.actions.auth")}</Button>
                  <Button tone="default" onClick={() => openExternalUrl(cpolar.docs_url || CPOLAR_DOCS_URL)}>{t("panel.cpolar.actions.docs")}</Button>
                </ButtonGroup>
              </Stack>
            </Card>

            <Card title={t("panel.cpolar.detailsTitle")}>
              <Stack>
                <KeyValue
                  items={[
                    { key: "path", label: t("panel.cpolar.fields.path"), value: compactText(cpolar.path) },
                    { key: "config", label: t("panel.cpolar.fields.config"), value: compactText(cpolar.config_path) },
                    { key: "region", label: t("panel.cpolar.fields.region"), value: cpolar.region || "-" },
                  ]}
                />
                <Text>{t("panel.cpolar.limitNote")}</Text>
              </Stack>
            </Card>
          </Grid>

          <Card title={t("panel.cpolar.guideTitle")}>
            <Stack>
              <Text>{t("panel.cpolar.guideIntro")}</Text>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
                  gap: "12px",
                }}
              >
                {cpolarGuideSteps.map((step, index) => (
                  <TailscaleGuideStep
                    key={step.title}
                    index={index + 1}
                    title={step.title}
                    body={step.body}
                    image={step.image}
                    imageUrls={step.imageUrls}
                    extraContent={step.extraContent}
                    actionLabel={step.actionLabel}
                    actionUrl={step.actionUrl}
                    secondaryActionLabel={step.secondaryActionLabel}
                    secondaryActionUrl={step.secondaryActionUrl}
                    actionButtonLabel={step.actionButtonLabel}
                    actionButtonPendingLabel={step.actionButtonPendingLabel}
                    actionButtonTone={step.actionButtonTone}
                    actionButtonDisabled={step.actionButtonDisabled}
                    actionButtonPending={step.actionButtonPending}
                    onActionButtonClick={step.onActionButtonClick}
                    onOpenUrl={openExternalUrl}
                  />
                ))}
              </div>
            </Stack>
          </Card>
        </Stack>
      )}
    </Page>
  )
}
