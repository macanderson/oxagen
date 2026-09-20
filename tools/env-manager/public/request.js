(() => {
  const key = "oxagen.env-manager.access";
  const fragment = new URLSearchParams(location.hash.slice(1));
  const supplied = fragment.get("token");
  if (supplied !== null) {
    history.replaceState(null, "", location.pathname + location.search);
    if (/^[a-f0-9]{64}$/.test(supplied)) sessionStorage.setItem(key, supplied);
    else sessionStorage.removeItem(key);
  }
  const showAccessError = () => {
    const notice = document.getElementById("connection-status");
    notice.hidden = false;
    notice.textContent = "Open the current access link printed by env-manager.";
  };
  window.envManagerFetch = async (path, init = {}) => {
    const url = new URL(path, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) {
      throw new Error("Only local env-manager API requests are allowed");
    }
    const token = sessionStorage.getItem(key);
    if (!token) {
      showAccessError();
      throw new Error("Open the current access link printed by env-manager.");
    }
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(url, {
      ...init,
      headers,
      cache: "no-store",
      redirect: "error",
    });
    if (response.status === 401) {
      sessionStorage.removeItem(key);
      showAccessError();
      throw new Error(
        "This access link expired. Open the new link printed by env-manager.",
      );
    }
    return response;
  };
})();
