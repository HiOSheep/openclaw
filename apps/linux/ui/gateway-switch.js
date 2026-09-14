(config) => {
  if (window !== window.top || location.origin !== config.origin) return;
  const base = config.base?.replace(/\/$/, "") ?? "";
  if (base && location.pathname !== base && !location.pathname.startsWith(base + "/")) return;

  const invoke = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
  let token;
  let errorNotice;
  let pendingError;
  const queued = [];
  const renderError = () => {
    if (!document.body) return;
    if (!errorNotice) {
      errorNotice = document.createElement("div");
      errorNotice.setAttribute("role", "alert");
      // This bridge also serves older dashboards without the shared chrome CSS.
      errorNotice.style.cssText = "position:fixed;top:56px;right:12px;z-index:10000;max-width:min(360px,90vw);padding:12px;border:1px solid currentColor;border-radius:8px;background:var(--bg,#0e1015);color:var(--text,#f6f7fb);font:13px system-ui,sans-serif";
      document.body.append(errorNotice);
    }
    errorNotice.textContent = pendingError;
    errorNotice.hidden = false;
  };
  const showError = (error) => {
    pendingError = `Gateway action failed: ${String(error)}`;
    renderError();
  };
  document.addEventListener("DOMContentLoaded", () => {
    if (pendingError) renderError();
  }, { once: true });
  const post = async (message) => {
    if (!token) {
      queued.push(message);
      return;
    }
    const requestToken = token;
    try {
      await invoke("gateway_request", { message, token: requestToken });
      if (requestToken === token) {
        pendingError = undefined;
        if (errorNotice) errorNotice.hidden = true;
      }
    } catch (error) {
      if (requestToken === token) showError(error);
    }
  };
  window.__OPENCLAW_NATIVE_GATEWAYS__ = config.snapshot;
  window.addEventListener("openclaw:native-gateways-changed", (event) => {
    window.__OPENCLAW_NATIVE_GATEWAYS__ = event.detail;
  });
  window.addEventListener("openclaw:gateway-ready", (event) => {
    token = event.detail.token;
    window.__OPENCLAW_NATIVE_GATEWAYS__ = event.detail.snapshot;
    window.dispatchEvent(new CustomEvent("openclaw:native-gateways-changed", {
      detail: event.detail.snapshot,
    }));
    for (const message of queued.splice(0)) void post(message);
  });
  window.webkit ??= {};
  window.webkit.messageHandlers ??= {};
  const handlers = window.webkit.messageHandlers;
  // Retain WebKit's weakly cached registry so our JavaScript adapter survives GC.
  Object.defineProperty(window, "__OPENCLAW_GATEWAY_HANDLERS__", { value: handlers, configurable: true });
  Object.defineProperty(handlers, "openclawGateways", {
    value: { postMessage: post }, configurable: true,
  });
}
