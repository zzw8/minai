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
const fetchCreateModelsButton = document.querySelector("#fetchCreateModelsButton");
const adminModelOptions = document.querySelector("#adminModelOptions");

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
  createProviderForm.elements.aiModel.value = "";
  createProviderForm.elements.enabled.checked = true;
  createProviderForm.elements.isDefault.checked = true;
  createProviderForm.elements.apiKey.focus();
});

fetchCreateModelsButton.addEventListener("click", async () => {
  await fetchModelsForForm(createProviderForm, null, fetchCreateModelsButton);
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
    renderModelAccess(card, provider.availableModels || [], provider.allowedModels || []);
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
      if (!validateModelSelection(card, payload)) return;
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

    card.querySelector(".fetch-provider-models").addEventListener("click", async (event) => {
      await fetchModelsForForm(card, provider.id, event.currentTarget);
    });

    card.querySelector(".select-all-models").addEventListener("click", () => {
      card.querySelectorAll('input[name="allowedModels"]').forEach((input) => {
        input.checked = true;
      });
      updateModelAccessSummary(card);
    });

    card.querySelector(".clear-all-models").addEventListener("click", () => {
      card.querySelectorAll('input[name="allowedModels"]').forEach((input) => {
        input.checked = false;
      });
      updateModelAccessSummary(card);
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

async function fetchModelsForForm(form, providerId, button) {
  const payload = providerPayload(new FormData(form));
  if (providerId) payload.providerId = providerId;
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "获取中...";
  showMessage(providersMessage, "正在从上游接口获取模型列表...");

  const result = await api("/api/admin/models/preview", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  button.disabled = false;
  button.textContent = originalText;

  if (!result.ok) {
    showMessage(providersMessage, result.error, true);
    return;
  }

  const models = result.data.allModels || result.data.models || [];
  updateModelOptions(models);
  if (!models.length) {
    showMessage(providersMessage, "已连接到接口，但上游没有返回可用模型。", true);
    return;
  }

  const currentModel = String(form.elements.aiModel.value || "").trim();
  const modelIds = new Set(models.map((model) => model.id));
  const nextModel = modelIds.has(currentModel)
    ? currentModel
    : modelIds.has(result.data.defaultModelId)
      ? result.data.defaultModelId
      : models[0].id;
  form.elements.aiModel.value = nextModel;
  renderModelAccess(form, models, result.data.allowedModels || []);
  showMessage(providersMessage, `已获取 ${models.length} 个模型。勾选前台允许使用的模型后点击保存。`);
}

function renderModelAccess(form, models, allowedModels) {
  const container = form.querySelector('[data-field="modelAccess"]');
  const checks = form.querySelector('[data-field="modelChecks"]');
  if (!container || !checks) return;

  const cleanModels = dedupeModels(models);
  const allowedSet = new Set(allowedModels?.length ? allowedModels : cleanModels.map((model) => model.id));
  checks.innerHTML = "";
  container.classList.toggle("is-empty", cleanModels.length === 0);

  if (!cleanModels.length) {
    checks.innerHTML = '<p class="model-empty">还没有读取模型。点击“获取模型”后可勾选前台开放范围。</p>';
    updateModelAccessSummary(form);
    return;
  }

  const fragment = document.createDocumentFragment();
  cleanModels.forEach((model) => {
    const item = document.createElement("label");
    item.className = "model-check";
    item.innerHTML = `
      <input name="allowedModels" type="checkbox" value="${escapeHtml(model.id)}" ${allowedSet.has(model.id) ? "checked" : ""} />
      <span>
        <strong>${escapeHtml(model.name || model.id)}</strong>
        <small>${escapeHtml([model.id, model.type, model.tags].filter(Boolean).join(" · "))}</small>
      </span>
    `;
    item.querySelector("input").addEventListener("change", () => updateModelAccessSummary(form));
    fragment.append(item);
  });
  checks.append(fragment);
  updateModelAccessSummary(form);
}

function updateModelAccessSummary(form) {
  const summary = form.querySelector('[data-field="modelAccessSummary"]');
  if (!summary) return;
  const total = form.querySelectorAll('input[name="allowedModels"]').length;
  const selected = form.querySelectorAll('input[name="allowedModels"]:checked').length;
  summary.textContent = total ? `已开放 ${selected} / ${total} 个模型` : "点击获取模型后可勾选开放范围";
}

function validateModelSelection(form, payload) {
  const total = form.querySelectorAll('input[name="allowedModels"]').length;
  if (total > 0 && !payload.allowedModels.length) {
    showMessage(providersMessage, "至少勾选一个前台可用模型。若要开放全部，请点击全选。", true);
    return false;
  }
  return true;
}

function dedupeModels(models) {
  const seen = new Set();
  const result = [];
  (Array.isArray(models) ? models : []).forEach((model) => {
    const id = String(model?.id || "").trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    result.push({ ...model, id });
  });
  return result;
}

function updateModelOptions(models) {
  adminModelOptions.innerHTML = "";
  const seen = new Set();
  models.forEach((model) => {
    const id = String(model.id || "").trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    const option = document.createElement("option");
    option.value = id;
    option.label = model.name && model.name !== id ? `${model.name} · ${id}` : id;
    adminModelOptions.append(option);
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
    row.elements.dailyText.value = user.quota?.dailyText ?? 100;
    row.elements.dailyImage.value = user.quota?.dailyImage ?? 10;
    row.querySelector('[data-field="quota"]').textContent = quotaLabel(user);

    row.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = new FormData(row);
      const payload = Object.fromEntries(data);
      payload.resetUsage = data.get("resetUsage") === "on";
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

function quotaLabel(user) {
  const quota = user.quota || {};
  const usage = user.usage || {};
  const textLimit = formatLimit(quota.dailyText);
  const imageLimit = formatLimit(quota.dailyImage);
  return `今日文本 ${usage.text || 0}/${textLimit} · 图片 ${usage.image || 0}/${imageLimit}`;
}

function formatLimit(value) {
  const limit = Number(value);
  return limit < 0 ? "不限" : String(Number.isFinite(limit) ? limit : 0);
}

function providerPayload(data) {
  return {
    name: data.get("name"),
    apiMode: data.get("apiMode") || "openai-compatible",
    apiHost: data.get("apiHost"),
    apiPath: data.get("apiPath"),
    apiKey: data.get("apiKey"),
    aiModel: data.get("aiModel"),
    allowedModels: data.getAll("allowedModels"),
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
