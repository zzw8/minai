const views = {
  setup: document.querySelector("#setupView"),
  login: document.querySelector("#loginView"),
  dashboard: document.querySelector("#dashboardView")
};

const adminStatus = document.querySelector("#adminStatus");
const logoutButton = document.querySelector("#logoutButton");
const setupForm = document.querySelector("#setupForm");
const adminLoginForm = document.querySelector("#adminLoginForm");
const settingsForm = document.querySelector("#settingsForm");
const createProviderForm = document.querySelector("#createProviderForm");
const createUserForm = document.querySelector("#createUserForm");
const providersList = document.querySelector("#providersList");
const usersTable = document.querySelector("#usersTable");
const providerCardTemplate = document.querySelector("#providerCardTemplate");
const userRowTemplate = document.querySelector("#userRowTemplate");
const setupMessage = document.querySelector("#setupMessage");
const loginMessage = document.querySelector("#loginMessage");
const settingsMessage = document.querySelector("#settingsMessage");
const providersMessage = document.querySelector("#providersMessage");
const usersMessage = document.querySelector("#usersMessage");
const activeProviderBadge = document.querySelector("#activeProviderBadge");
const providerCount = document.querySelector("#providerCount");
const userCount = document.querySelector("#userCount");
const yunwuPresetButton = document.querySelector("#yunwuPresetButton");

let currentAdmin = null;

boot();

setupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(setupForm));
  const result = await api("/api/admin/setup", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  if (!result.ok) {
    showMessage(setupMessage, result.error, true);
    return;
  }

  currentAdmin = result.data.user;
  showDashboard();
});

adminLoginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(adminLoginForm));
  const result = await api("/api/auth/login", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  if (!result.ok || result.data.user?.role !== "admin") {
    showMessage(loginMessage, result.error || "没有管理员权限。", true);
    return;
  }

  currentAdmin = result.data.user;
  showDashboard();
});

logoutButton.addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" });
  currentAdmin = null;
  showView("login");
  adminStatus.textContent = "Signed out";
  logoutButton.classList.add("hidden");
});

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(settingsForm);
  const payload = {
    siteTitle: data.get("siteTitle"),
    systemPrompt: data.get("systemPrompt"),
    requireLogin: data.get("requireLogin") === "on"
  };

  const result = await api("/api/admin/settings", {
    method: "PUT",
    body: JSON.stringify(payload)
  });

  if (!result.ok) {
    showMessage(settingsMessage, result.error, true);
    return;
  }

  fillSettings(result.data);
  showMessage(settingsMessage, "已保存。");
});

createProviderForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = providerPayload(new FormData(createProviderForm));
  const result = await api("/api/admin/providers", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  if (!result.ok) {
    showMessage(providersMessage, result.error, true);
    return;
  }

  createProviderForm.reset();
  createProviderForm.elements.enabled.checked = true;
  showMessage(providersMessage, "API 通道已添加。");
  await Promise.all([loadSettings(), loadProviders()]);
});

yunwuPresetButton.addEventListener("click", () => {
  createProviderForm.elements.name.value = "云雾 API";
  createProviderForm.elements.apiMode.value = "openai-compatible";
  createProviderForm.elements.apiHost.value = "https://yunwu.ai";
  createProviderForm.elements.apiPath.value = "/v1/chat/completions";
  createProviderForm.elements.aiModel.value = "deepseek-v3-1-250821";
  createProviderForm.elements.enabled.checked = true;
  createProviderForm.elements.isDefault.checked = true;
  createProviderForm.elements.apiKey.focus();
});

createUserForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(createUserForm));
  const result = await api("/api/admin/users", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  if (!result.ok) {
    showMessage(usersMessage, result.error, true);
    return;
  }

  createUserForm.reset();
  showMessage(usersMessage, "用户已添加。");
  await loadUsers();
});

async function boot() {
  const setupStatus = await api("/api/admin/setup-status");
  if (!setupStatus.ok) {
    showView("login");
    adminStatus.textContent = "Offline";
    return;
  }

  if (setupStatus.data.needsSetup) {
    showView("setup");
    adminStatus.textContent = "Setup";
    return;
  }

  const me = await api("/api/admin/me");
  if (me.ok) {
    currentAdmin = me.data.user;
    showDashboard();
  } else {
    showView("login");
    adminStatus.textContent = "Login";
  }
}

async function showDashboard() {
  showView("dashboard");
  adminStatus.textContent = currentAdmin?.displayName || currentAdmin?.username || "Admin";
  logoutButton.classList.remove("hidden");
  await Promise.all([loadSettings(), loadProviders(), loadUsers()]);
}

async function loadSettings() {
  const result = await api("/api/admin/settings");
  if (!result.ok) {
    showMessage(settingsMessage, result.error, true);
    return;
  }
  fillSettings(result.data);
}

async function loadProviders() {
  const result = await api("/api/admin/providers");
  if (!result.ok) {
    showMessage(providersMessage, result.error, true);
    return;
  }
  renderProviders(result.data.providers || []);
}

async function loadUsers() {
  const result = await api("/api/admin/users");
  if (!result.ok) {
    showMessage(usersMessage, result.error, true);
    return;
  }

  renderUsers(result.data.users || []);
}

function fillSettings(settings) {
  settingsForm.elements.siteTitle.value = settings.siteTitle || "";
  settingsForm.elements.systemPrompt.value = settings.systemPrompt || "";
  settingsForm.elements.requireLogin.checked = Boolean(settings.requireLogin);
  activeProviderBadge.textContent = settings.activeProvider
    ? `默认：${settings.activeProvider.name}`
    : "未配置通道";
}

function renderProviders(providers) {
  providersList.innerHTML = "";
  providerCount.textContent = `${providers.length} 个通道`;

  providers.forEach((provider) => {
    const card = providerCardTemplate.content.firstElementChild.cloneNode(true);
    card.dataset.providerId = provider.id;
    card.querySelector('[data-field="name"]').textContent = provider.name;
    card.querySelector('[data-field="summary"]').textContent =
      `${provider.endpointUrl || provider.apiHost} · ${provider.aiModel} · ${provider.apiKeyPreview || "未设置 Key"}`;
    card.querySelector('[data-field="badge"]').textContent = provider.isDefault ? "默认" : provider.enabled ? "启用" : "禁用";
    card.querySelector('[data-field="badge"]').classList.toggle("muted", !provider.enabled);
    card.elements.name.value = provider.name || "";
    card.elements.apiMode.value = provider.apiMode || "openai-compatible";
    card.elements.apiHost.value = provider.apiHost || provider.apiBaseUrl || "";
    card.elements.apiPath.value = provider.apiPath || "";
    card.elements.aiModel.value = provider.aiModel || "";
    card.elements.enabled.checked = Boolean(provider.enabled);
    card.elements.isDefault.checked = Boolean(provider.isDefault);
    card.querySelector('[data-field="metrics"]').innerHTML = `
      <span>调用 ${provider.calls}</span>
      <span>成功 ${provider.success}</span>
      <span>失败 ${provider.failed}</span>
      <span>Tokens ${provider.totalTokens}</span>
      <span>${provider.lastUsedAt ? formatDate(provider.lastUsedAt) : "未调用"}</span>
      ${provider.lastError ? `<span class="metric-error">${escapeHtml(provider.lastError)}</span>` : ""}
    `;

    card.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = providerPayload(new FormData(card));
      const result = await api(`/api/admin/providers/${encodeURIComponent(provider.id)}`, {
        method: "PUT",
        body: JSON.stringify(payload)
      });

      if (!result.ok) {
        showMessage(providersMessage, result.error, true);
        return;
      }

      card.elements.apiKey.value = "";
      showMessage(providersMessage, "API 通道已保存。");
      await Promise.all([loadSettings(), loadProviders()]);
    });

    card.querySelector(".clear-provider-key").addEventListener("click", async () => {
      const result = await api(`/api/admin/providers/${encodeURIComponent(provider.id)}`, {
        method: "PUT",
        body: JSON.stringify({ ...providerPayload(new FormData(card)), clearApiKey: true })
      });

      if (!result.ok) {
        showMessage(providersMessage, result.error, true);
        return;
      }

      showMessage(providersMessage, "API Key 已清空。");
      await loadProviders();
    });

    card.querySelector(".delete-provider").addEventListener("click", async () => {
      if (!confirm(`删除 API 通道 ${provider.name}？`)) return;
      const result = await api(`/api/admin/providers/${encodeURIComponent(provider.id)}`, {
        method: "DELETE"
      });

      if (!result.ok) {
        showMessage(providersMessage, result.error, true);
        return;
      }

      showMessage(providersMessage, "API 通道已删除。");
      await Promise.all([loadSettings(), loadProviders()]);
    });

    providersList.append(card);
  });
}

function renderUsers(users) {
  usersTable.innerHTML = "";
  userCount.textContent = `${users.length} 个用户`;

  users.forEach((user) => {
    const row = userRowTemplate.content.firstElementChild.cloneNode(true);
    row.dataset.userId = user.id;
    row.querySelector('[data-field="username"]').textContent = user.username;
    row.querySelector('[data-field="meta"]').textContent = `${user.role} · ${user.status}`;
    row.elements.displayName.value = user.displayName || "";
    row.elements.role.value = user.role;
    row.elements.status.value = user.status;

    row.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = new FormData(row);
      const payload = Object.fromEntries(data);
      const result = await api(`/api/admin/users/${encodeURIComponent(user.id)}`, {
        method: "PUT",
        body: JSON.stringify(payload)
      });

      if (!result.ok) {
        showMessage(usersMessage, result.error, true);
        return;
      }

      showMessage(usersMessage, "用户已保存。");
      await loadUsers();
    });

    row.querySelector(".delete-user").addEventListener("click", async () => {
      if (!confirm(`删除用户 ${user.username}？`)) return;

      const result = await api(`/api/admin/users/${encodeURIComponent(user.id)}`, {
        method: "DELETE"
      });

      if (!result.ok) {
        showMessage(usersMessage, result.error, true);
        return;
      }

      showMessage(usersMessage, "用户已删除。");
      await loadUsers();
    });

    usersTable.append(row);
  });
}

function providerPayload(data) {
  return {
    name: data.get("name"),
    apiMode: data.get("apiMode") || "openai-compatible",
    apiHost: data.get("apiHost"),
    apiPath: data.get("apiPath"),
    apiKey: data.get("apiKey"),
    aiModel: data.get("aiModel"),
    enabled: data.get("enabled") === "on",
    isDefault: data.get("isDefault") === "on"
  };
}

function showView(name) {
  Object.values(views).forEach((view) => view.classList.add("hidden"));
  views[name].classList.remove("hidden");
}

function showMessage(element, text, isError = false) {
  element.textContent = text || "";
  element.classList.toggle("error", Boolean(isError));
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function api(url, options = {}) {
  try {
    const response = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      },
      ...options
    });
    const data = await response.json().catch(() => ({}));
    return {
      ok: response.ok,
      status: response.status,
      data,
      error: data.error || "请求失败。"
    };
  } catch {
    return {
      ok: false,
      status: 0,
      data: {},
      error: "无法连接服务器。"
    };
  }
}
