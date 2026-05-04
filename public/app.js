const form = document.querySelector("#chatForm");
const appShell = document.querySelector("#appShell");
const input = document.querySelector("#messageInput");
const sendButton = document.querySelector("#sendButton");
const messagesEl = document.querySelector("#messages");
const template = document.querySelector("#messageTemplate");
const newChatButton = document.querySelector("#newChatButton");
const sidebarToggle = document.querySelector("#sidebarToggle");
const authButton = document.querySelector("#authButton");
const accountMenu = document.querySelector("#accountMenu");
const authModal = document.querySelector("#authModal");
const loginForm = document.querySelector("#loginForm");
const closeAuthButton = document.querySelector("#closeAuthButton");
const loginError = document.querySelector("#loginError");
const brandName = document.querySelector("#brandName");
const siteHeading = document.querySelector("#siteHeading");
const modelSelect = document.querySelector("#modelSelect");
const themeToggles = [...document.querySelectorAll("[data-theme-toggle]")];
const accountPopover = document.querySelector("#accountPopover");
const accountName = document.querySelector("#accountName");
const accountStatus = document.querySelector("#accountStatus");
const accountAvatar = document.querySelector("#accountAvatar");
const logoutButton = document.querySelector("#logoutButton");
const conversationList = document.querySelector("#conversationList");
const fileInput = document.querySelector("#fileInput");
const attachButton = document.querySelector("#attachButton");
const attachmentTray = document.querySelector("#attachmentTray");

const STORAGE_KEY = "minimal-ai-site/messages";
const MODEL_STORAGE_KEY = "minimal-ai-site/model";
const THEME_STORAGE_KEY = "minimal-ai-site/theme";
const SIDEBAR_STORAGE_KEY = "minimal-ai-site/sidebar-collapsed";
const MODEL_ALIASES = {
  "gpt-image-2": "gpt-image-2-all"
};
const COVER_FALLBACK_MODELS = [
  { id: "deepseek-v3-1-250821", name: "DeepSeek V3.1", type: "Chat" },
  { id: "gpt-4o-mini", name: "GPT-4o mini", type: "Chat" },
  { id: "gpt-image-2-all", name: "GPT Image 2 All", type: "Image" },
  { id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet", type: "Chat" }
];
let messages = loadLocalMessages();
let conversations = [];
let currentConversationId = "";
let isSending = false;
let isHydratingConversation = false;
let saveTimer = null;
let selectedModel = normalizeModelId(localStorage.getItem(MODEL_STORAGE_KEY) || "");
let conversationSwitchToken = 0;
let pendingFiles = [];
let currentTheme = localStorage.getItem(THEME_STORAGE_KEY) || preferredTheme();
let sidebarCollapsed = localStorage.getItem(SIDEBAR_STORAGE_KEY) === "true";
let lastSavedMessagesSignature = messageSignature(messages);
let activeAbortController = null;
let config = {
  siteTitle: "MinAI",
  requireLogin: false,
  coverModels: [],
  coverDefaultModel: "",
  user: null
};

applyTheme(currentTheme);
applySidebarState();
await bootstrap();
renderMessages();
renderConversationList();
resizeInput();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const content = input.value.trim();

  if (!canUseChat()) {
    showAuthModal();
    return;
  }

  if (!content || isSending) return;

  input.value = "";
  resizeInput();

  const userMessage = { role: "user", content, files: pendingFiles };
  messages.push(userMessage);
  pendingFiles = [];
  renderPendingFiles();
  saveLocalMessages(messages);
  if (messages.length === 1) messagesEl.innerHTML = "";
  addLocalMessage("user", userMessage.content, false, [], userMessage.files || []);

  await sendMessage();
});

sendButton.addEventListener("click", (event) => {
  if (!isSending) return;
  event.preventDefault();
  stopGeneration();
});

input.addEventListener("input", resizeInput);
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

newChatButton?.addEventListener("click", async () => {
  if (isSending) return;
  if (!canUseChat()) {
    showAuthModal();
    return;
  }
  messagesEl.classList.add("is-resetting");
  newChatButton.classList.add("is-sparking");
  await wait(160);
  await createNewConversation();
  renderMessages();
  input.focus();
  await wait(240);
  messagesEl.classList.remove("is-resetting");
  newChatButton.classList.remove("is-sparking");
});

sidebarToggle?.addEventListener("click", () => {
  sidebarCollapsed = !sidebarCollapsed;
  localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarCollapsed));
  applySidebarState();
});

conversationList.addEventListener("click", async (event) => {
  const pinButton = event.target.closest("[data-pin-conversation]");
  if (pinButton) {
    await togglePinned(pinButton.dataset.pinConversation, pinButton.dataset.pinned !== "true");
    return;
  }

  const deleteButton = event.target.closest("[data-delete-conversation]");
  if (deleteButton) {
    await deleteConversation(deleteButton.dataset.deleteConversation);
    return;
  }

  const button = event.target.closest("[data-select-conversation]");
  if (!button || isSending) return;
  const conversationId = button.dataset.selectConversation;
  if (!conversationId || conversationId === currentConversationId) return;
  await selectConversation(conversationId);
});

modelSelect.addEventListener("change", () => {
  selectedModel = normalizeModelId(modelSelect.value);
  modelSelect.value = selectedModel;
  localStorage.setItem(MODEL_STORAGE_KEY, selectedModel);
});

themeToggles.forEach((button) => {
  button.addEventListener("click", () => {
    currentTheme = currentTheme === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_STORAGE_KEY, currentTheme);
    applyTheme(currentTheme);
  });
});

attachButton.addEventListener("click", () => {
  if (!canUseChat()) {
    showAuthModal();
    return;
  }
  fileInput.click();
});

fileInput.addEventListener("change", async () => {
  const files = [...fileInput.files].slice(0, 6);
  for (const file of files) {
    pendingFiles.push(await readAttachment(file));
  }
  pendingFiles = pendingFiles.slice(0, 6);
  fileInput.value = "";
  renderPendingFiles();
  input.focus();
});

attachmentTray.addEventListener("click", (event) => {
  const removeButton = event.target.closest("[data-remove-file]");
  if (!removeButton) return;
  pendingFiles.splice(Number(removeButton.dataset.removeFile), 1);
  renderPendingFiles();
});

messagesEl.addEventListener("click", async (event) => {
  const copyButton = event.target.closest("[data-copy-message]");
  if (copyButton) {
    await copyAssistantMessage(Number(copyButton.dataset.copyMessage), copyButton);
    return;
  }

  const regenerateButton = event.target.closest("[data-regenerate-message]");
  if (regenerateButton) {
    await regenerateAssistantMessage(Number(regenerateButton.dataset.regenerateMessage));
  }
});

authButton.addEventListener("click", () => {
  if (!config.user) {
    showAuthModal();
    return;
  }
  toggleAccountMenu();
});

logoutButton.addEventListener("click", async () => {
  hideAccountMenu();
  await fetch("/api/auth/logout", { method: "POST" });
  config.user = null;
  messages = [];
  conversations = [];
  currentConversationId = "";
  saveLocalMessages([]);
  updateAuthUI();
  renderModelOptions([]);
  renderConversationList();
  renderMessages();
});

document.addEventListener("click", (event) => {
  if (!accountPopover.classList.contains("hidden") && !event.target.closest("#accountMenu")) {
    hideAccountMenu();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideAccountMenu();
});

closeAuthButton.addEventListener("click", () => {
  hideAuthModal();
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";

  const payload = Object.fromEntries(new FormData(loginForm));
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    loginError.textContent = data.error || "登录失败，请检查账号和密码。";
    return;
  }

  config.user = data.user;
  loginForm.reset();
  hideAuthModal();
  updateAuthUI();
  await Promise.all([loadModels(), loadConversation()]);
  renderMessages();
  input.focus();
});

async function bootstrap() {
  try {
    const response = await fetch("/api/public-config");
    if (response.ok) config = { ...config, ...(await response.json()) };
  } finally {
    updateSiteCopy();
    updateAuthUI();
    await loadCoverModels();
    if (canUseChat()) {
      await Promise.all([loadModels(), loadConversation()]);
    }
  }
}

async function sendMessage() {
  if (isSending) return;

  const controller = new AbortController();
  activeAbortController = controller;
  setSending(true);
  const imageRequest = isImageModel(activeModelText());
  const typingEl = addTypingMessage(imageRequest ? "图片生成中，可能需要几分钟，请保持页面打开。" : "");
  let statusTimer = imageRequest ? startGenerationStatus(typingEl) : null;

  const removeTyping = () => {
    if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
    typingEl.remove();
  };

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: currentConversationId,
        messages: requestMessages(),
        model: selectedModel || undefined
      }),
      signal: controller.signal
    });

    const data = await response.json().catch(() => ({}));

    if (response.status === 401) {
      removeTyping();
      addAssistantError(data.error || "请先登录后再使用。");
      await saveMessages(true).catch(() => null);
      showAuthModal();
      return;
    }

    if (!response.ok) {
      removeTyping();
      addAssistantError(data.error || "请求失败，请稍后再试。");
      await saveMessages(true).catch(() => null);
      return;
    }

    const result = data.jobId ? await pollImageJob(data.jobId, typingEl, controller.signal) : data;
    removeTyping();

    if (result.status === "failed") {
      addAssistantError(result.error || "图片生成失败，请稍后再试。");
      await saveMessages(true).catch(() => null);
      return;
    }

    const assistantMessage = { role: "assistant", content: result.reply || "没有收到有效回复。", images: result.images || [] };
    const typed = await typeAssistantMessage(assistantMessage, messages.length, controller.signal);
    messages.push({ ...assistantMessage, content: typed.content });
    if (result.conversationId) currentConversationId = result.conversationId;
    if (typed.stopped) {
      await saveMessages(true);
      return;
    }
    if (Array.isArray(result.conversations)) {
      conversations = result.conversations;
      renderConversationList();
      saveLocalMessages(messages);
      lastSavedMessagesSignature = messageSignature(messages);
    } else {
      await saveMessages(true);
    }
  } catch (error) {
    removeTyping();
    if (!isAbortError(error)) {
      addAssistantError(error?.message || "网络连接失败，请检查服务器配置。");
      await saveMessages(true).catch(() => null);
    }
  } finally {
    if (statusTimer) clearInterval(statusTimer);
    if (activeAbortController === controller) activeAbortController = null;
    setSending(false);
  }
}

function renderMessages() {
  messagesEl.innerHTML = "";
  messagesEl.classList.add("is-rendering");

  if (!messages.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const locked = !canUseChat();
    empty.append(createCoverContent(locked));
    messagesEl.append(empty);
    requestAnimationFrame(() => messagesEl.classList.remove("is-rendering"));
    return;
  }

  const fragment = document.createDocumentFragment();
  messages.forEach((message, index) =>
    addMessageElement(message.role, message.content, Boolean(message.error), message.images || [], message.files || [], fragment, index)
  );
  messagesEl.append(fragment);
  scrollToBottom();
  requestAnimationFrame(() => messagesEl.classList.remove("is-rendering"));
}

function createCoverContent(locked) {
  const cover = document.createElement("div");
  cover.className = "cover-card";

  const preview = document.createElement("section");
  preview.className = "cover-preview";
  preview.setAttribute("aria-hidden", "true");
  preview.innerHTML = `
    <div class="cover-window">
      <span></span><span></span><span></span>
    </div>
    <div class="cover-message cover-message-user">帮我把需求整理成可执行方案</div>
    <div class="cover-message cover-message-ai">已拆成目标、功能、部署和验收四部分。</div>
    <div class="cover-signal"></div>
  `;

  const action = document.createElement("section");
  action.className = "cover-action";
  action.innerHTML = `
    <span class="cover-kicker">MinAI</span>
    <h2>${locked ? "登录后开始体验" : "今天想聊点什么？"}</h2>
    <p>${locked ? "登录后即可使用真实 AI 模型，对话会自动保存，也可以上传文件和生成图片。" : "选择模型后直接开始，对话会保存到左侧，方便下次继续查看。"}</p>
  `;

  const cta = document.createElement("button");
  cta.type = "button";
  cta.className = "cover-cta";
  cta.textContent = locked ? "体验一下" : "开始新对话";
  cta.addEventListener("click", () => {
    if (locked) {
      showAuthModal();
      return;
    }
    input.focus();
  });

  const links = document.createElement("div");
  links.className = "cover-links";
  links.append(cta);
  const repoLink = document.createElement("a");
  repoLink.className = "cover-repo-link";
  repoLink.href = "https://github.com/zzw8/minai";
  repoLink.target = "_blank";
  repoLink.rel = "noopener";
  repoLink.textContent = "查看 GitHub";
  links.append(repoLink);
  action.append(links);

  const rail = document.createElement("section");
  rail.className = "cover-models";
  const models = visibleCoverModels();
  const modelRows = [...models, ...models].map((model) => {
    const type = escapeHtml(model.type || "Model");
    const name = escapeHtml(model.name || model.id || "AI Model");
    const id = escapeHtml(model.id || "");
    return `
      <div class="cover-model">
        <strong>${name}</strong>
        <span>${type}${id ? ` · ${id}` : ""}</span>
      </div>
    `;
  }).join("");
  rail.innerHTML = `
    <div class="cover-model-heading">
      <span>可用模型</span>
      <small>${config.coverDefaultModel ? `默认 ${escapeHtml(config.coverDefaultModel)}` : "实时读取"}</small>
    </div>
    <div class="cover-model-scroll" aria-label="可用模型列表">
      <div class="cover-model-track">${modelRows}</div>
    </div>
  `;

  cover.append(preview, action, rail);
  return cover;
}

async function loadCoverModels() {
  try {
    const response = await fetch("/api/cover-models");
    const data = await response.json().catch(() => ({}));
    if (response.ok) {
      config.coverModels = Array.isArray(data.models) ? data.models : [];
      config.coverDefaultModel = data.defaultModel || data.defaultModelId || "";
      return;
    }
  } catch {
    // The cover can still render with local fallback names if the upstream model list is unavailable.
  }
  config.coverModels = [];
  config.coverDefaultModel = "";
}

function visibleCoverModels() {
  const source = Array.isArray(config.coverModels) && config.coverModels.length ? config.coverModels : COVER_FALLBACK_MODELS;
  const seen = new Set();
  return source
    .map((model) => ({
      id: normalizeModelId(model.id || ""),
      name: model.name || displayCoverModelName(model.id),
      type: model.type || "Model"
    }))
    .filter((model) => {
      if (!model.id || seen.has(model.id)) return false;
      seen.add(model.id);
      return true;
    })
    .slice(0, 18);
}

function displayCoverModelName(modelId) {
  return String(modelId || "AI Model")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function renderConversationList() {
  conversationList.innerHTML = "";
  if (!config.user) {
    conversationList.innerHTML = `<div class="conversation-empty">登录后显示历史对话</div>`;
    return;
  }
  const visible = conversations.filter((item) => item.title && item.title !== "新对话").slice(0, 30);
  if (!visible.length) {
    conversationList.innerHTML = `<div class="conversation-empty">暂无历史对话</div>`;
    return;
  }
  const fragment = document.createDocumentFragment();
  visible.forEach((item) => {
    const row = document.createElement("div");
    row.className = "conversation-row";
    if (item.id === currentConversationId) row.classList.add("active");

    const button = document.createElement("button");
    button.type = "button";
    button.className = "conversation-item";
    button.dataset.selectConversation = item.id;
    button.title = item.title;
    button.textContent = item.title;

    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "conversation-action";
    pin.dataset.pinConversation = item.id;
    pin.dataset.pinned = String(Boolean(item.pinned));
    pin.title = item.pinned ? "取消置顶" : "星标置顶";
    pin.textContent = item.pinned ? "★" : "☆";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "conversation-action danger";
    remove.dataset.deleteConversation = item.id;
    remove.title = "删除对话";
    remove.textContent = "×";

    row.append(button, pin, remove);
    fragment.append(row);
  });
  conversationList.append(fragment);
}

function addLocalMessage(role, content, isError = false, images = [], files = [], messageIndex = -1) {
  const node = addMessageElement(role, content, isError, images, files, messagesEl, messageIndex);
  scrollToBottom();
  return node;
}

function addAssistantError(content) {
  const message = { role: "assistant", content, error: true };
  messages.push(message);
  return addLocalMessage("assistant", content, true, [], [], messages.length - 1);
}

function addMessageElement(role, content, isError = false, images = [], files = [], target = messagesEl, messageIndex = -1) {
  const node = template.content.firstElementChild.cloneNode(true);
  node.classList.add(role);
  if (isError) node.classList.add("error");

  const avatar = node.querySelector(".avatar");
  avatar.textContent = role === "user" ? "你" : "";
  avatar.classList.toggle("ai-avatar", role === "assistant");
  const bubble = node.querySelector(".bubble");
  bubble.textContent = content;
  appendImageGallery(bubble, images, "AI 生成图片");
  if (Array.isArray(files) && files.length) {
    const fileList = document.createElement("div");
    fileList.className = "message-files";
    files.forEach((file) => {
      const item = document.createElement("span");
      item.textContent = file.name || "附件";
      fileList.append(item);
    });
    bubble.append(fileList);
    const previews = files.filter((file) => file.dataUrl && file.type?.startsWith("image/")).slice(0, 4);
    if (previews.length) {
      const gallery = document.createElement("div");
      gallery.className = "image-gallery";
      previews.forEach((file) => {
        const image = document.createElement("img");
        image.src = file.dataUrl;
        image.alt = file.name || "上传图片";
        image.loading = "lazy";
        gallery.append(image);
      });
      bubble.append(gallery);
    }
  }
  if (role === "assistant" && messageIndex >= 0) {
    appendMessageActions(node, { role, content, images, error: isError }, messageIndex);
  }
  target.append(node);
  return node;
}

function appendMessageActions(node, message, messageIndex) {
  const bubble = node.querySelector(".bubble");
  if (!bubble) return;

  const actions = document.createElement("div");
  actions.className = "message-actions";

  if (String(message.content || "").trim()) {
    const copy = document.createElement("button");
    copy.type = "button";
    copy.dataset.copyMessage = String(messageIndex);
    copy.title = "复制回答";
    copy.textContent = "复制";
    actions.append(copy);
  }

  const regenerate = document.createElement("button");
  regenerate.type = "button";
  regenerate.dataset.regenerateMessage = String(messageIndex);
  regenerate.title = message.error ? "重试这次请求" : "重新生成回答";
  regenerate.textContent = message.error ? "重试" : "重新生成";
  actions.append(regenerate);

  bubble.append(actions);
}

function addTypingMessage(statusText = "") {
  if (!messages.length) messagesEl.innerHTML = "";

  const node = template.content.firstElementChild.cloneNode(true);
  node.classList.add("assistant");
  const avatar = node.querySelector(".avatar");
  avatar.textContent = "";
  avatar.classList.add("ai-avatar");
  node.querySelector(".bubble").innerHTML = `
    <span class="typing-wrap">
      <span class="typing" aria-label="思考中">
        <span></span><span></span><span></span>
      </span>
      ${statusText ? `<span class="typing-status">${escapeHtml(statusText)}</span>` : ""}
    </span>
  `;
  messagesEl.append(node);
  scrollToBottom();
  return node;
}

function startGenerationStatus(node) {
  const status = node.querySelector(".typing-status");
  if (!status) return null;
  const startedAt = Date.now();
  return window.setInterval(() => {
    const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    status.textContent = `图片生成中，已等待 ${seconds} 秒。大图模型可能需要较长时间。`;
    scrollToBottom();
  }, 30000);
}

async function pollImageJob(jobId, typingEl, signal) {
  const startedAt = Date.now();
  let delay = 2500;

  while (Date.now() - startedAt < 32 * 60 * 1000) {
    await wait(delay, signal);
    const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { signal });
    const data = await response.json().catch(() => ({}));

    if (response.status === 401) {
      showAuthModal();
      throw new Error(data.error || "请先登录后再查看图片任务。");
    }
    if (!response.ok) {
      throw new Error(data.error || "图片任务查询失败。");
    }
    if (data.status === "done" || data.status === "failed") return data;

    const status = typingEl.querySelector(".typing-status");
    if (status) {
      const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      status.textContent = `图片生成中，已等待 ${seconds} 秒。完成后会自动显示在这里。`;
    }
    delay = Math.min(6000, delay + 500);
  }

  return {
    status: "failed",
    error: "图片生成等待超过 32 分钟。任务可能仍在上游排队，请稍后换模型或重试。"
  };
}

async function typeAssistantMessage(message, messageIndex, signal) {
  const node = addMessageElement("assistant", "", false, [], []);
  const bubble = node.querySelector(".bubble");
  const text = String(message.content || "");
  const chunkSize = text.length > 900 ? 10 : text.length > 500 ? 7 : text.length > 220 ? 4 : 2;
  let lastScrollAt = 0;
  for (let index = 0; index < text.length; index += chunkSize) {
    if (signal?.aborted) break;
    bubble.textContent = text.slice(0, index + chunkSize);
    if (performance.now() - lastScrollAt > 90) {
      scrollToBottom();
      lastScrollAt = performance.now();
    }
    await wait(text.length > 500 ? 8 : 12, signal).catch((error) => {
      if (!isAbortError(error)) throw error;
    });
    if (signal?.aborted) break;
  }

  const stopped = Boolean(signal?.aborted);
  const finalContent = stopped ? bubble.textContent : text;
  bubble.textContent = finalContent;
  if (!stopped) appendImageGallery(bubble, message.images, "AI 生成图片");
  appendMessageActions(node, { ...message, content: finalContent }, messageIndex);
  scrollToBottom();
  return { content: finalContent, stopped };
}

function appendImageGallery(container, images, altText) {
  if (!Array.isArray(images) || !images.length) return;
  const gallery = document.createElement("div");
  gallery.className = "image-gallery";
  images.forEach((url, index) => {
    if (typeof url !== "string" || !url.trim()) return;
    const item = document.createElement("div");
    item.className = "image-item";

    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener";
    link.title = "打开原图";

    const image = document.createElement("img");
    image.src = url;
    image.alt = altText;
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    image.addEventListener(
      "error",
      () => {
        item.classList.add("image-load-error");
        link.textContent = "图片加载失败，点此打开原图";
      },
      { once: true }
    );

    const download = document.createElement("a");
    download.href = url;
    download.download = imageDownloadName(url, index);
    download.className = "image-download";
    download.textContent = "下载";
    download.addEventListener("click", (event) => event.stopPropagation());

    link.append(image);
    item.append(link, download);
    gallery.append(item);
  });
  if (gallery.children.length) container.append(gallery);
}

function updateSiteCopy() {
  document.title = config.siteTitle || "MinAI";
  brandName.textContent = config.siteTitle || "MinAI";
  siteHeading.textContent = config.siteTitle === "MinAI" ? "把想法变清楚" : config.siteTitle;
}

function preferredTheme() {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme) {
  const normalized = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = normalized;
  document.documentElement.style.colorScheme = normalized;
  themeToggles.forEach((button) => {
    const icon = button.querySelector("span") || button;
    icon.textContent = normalized === "dark" ? "☀" : "☾";
    button.title = normalized === "dark" ? "切换浅色模式" : "切换深色模式";
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", String(normalized === "dark"));
  });
}

function applySidebarState() {
  appShell.classList.toggle("sidebar-collapsed", sidebarCollapsed);
  sidebarToggle.setAttribute("aria-expanded", String(!sidebarCollapsed));
  sidebarToggle.title = sidebarCollapsed ? "展开对话栏" : "收起对话栏";
  sidebarToggle.setAttribute("aria-label", sidebarToggle.title);
}

function updateAuthUI() {
  if (config.user) {
    const displayName = config.user.displayName || config.user.username;
    authButton.textContent = displayName;
    authButton.classList.add("is-user");
    accountName.textContent = displayName;
    accountStatus.textContent = config.user.username || "Signed in";
    accountAvatar.textContent = displayName.trim().slice(0, 1).toUpperCase();
  } else {
    authButton.textContent = "登录";
    authButton.classList.remove("is-user");
    hideAccountMenu();
  }

  closeAuthButton.classList.remove("hidden");
  updateInputState();
}

function toggleAccountMenu() {
  const nextOpen = accountPopover.classList.contains("hidden");
  accountPopover.classList.toggle("hidden", !nextOpen);
  accountMenu.classList.toggle("is-open", nextOpen);
  authButton.setAttribute("aria-expanded", String(nextOpen));
}

function hideAccountMenu() {
  accountPopover.classList.add("hidden");
  accountMenu.classList.remove("is-open");
  authButton.setAttribute("aria-expanded", "false");
}

function updateInputState() {
  const locked = !canUseChat();
  input.disabled = isSending || locked;
  sendButton.disabled = locked;
  attachButton.disabled = isSending || locked;
  modelSelect.disabled = isSending || locked || modelSelect.options.length <= 1;
  input.placeholder = locked ? "请先登录..." : "输入你的问题...";
  sendButton.title = isSending ? "停止生成" : "发送";
}

function canUseChat() {
  return !config.requireLogin || Boolean(config.user);
}

function showAuthModal() {
  authModal.classList.remove("hidden");
  requestAnimationFrame(() => loginForm.elements.username?.focus());
}

function hideAuthModal() {
  authModal.classList.add("hidden");
  loginError.textContent = "";
}

function resizeInput() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

function setSending(value) {
  isSending = value;
  form.classList.toggle("is-sending", value);
  updateInputState();
}

async function loadModels() {
  renderModelOptions([], "模型加载中...");
  try {
    const response = await fetch("/api/models");
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      renderModelOptions([], "模型不可用");
      return;
    }
    renderModelOptions(data.models || [], data.defaultModel || "默认模型");
  } catch {
    renderModelOptions([], "模型不可用");
  }
}

function renderModelOptions(models, defaultLabel = "默认模型") {
  modelSelect.innerHTML = "";
  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = defaultLabel ? `默认：${defaultLabel}` : "默认模型";
  modelSelect.append(defaultOption);

  const groups = new Map();
  const seen = new Set();
  models.forEach((model) => {
    const id = normalizeModelId(model.id);
    if (!id || seen.has(id)) return;
    seen.add(id);
    const type = model.type || "模型";
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push({ ...model, id });
  });

  groups.forEach((items, type) => {
    const group = document.createElement("optgroup");
    group.label = type;
    items.forEach((model) => {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.name || model.id;
      option.title = [model.id, model.description || model.tags || ""].filter(Boolean).join(" · ");
      group.append(option);
    });
    modelSelect.append(group);
  });

  const hasSelectedModel = [...modelSelect.options].some((option) => option.value === selectedModel);
  modelSelect.value = hasSelectedModel ? selectedModel : "";
  if (!hasSelectedModel) {
    selectedModel = "";
    localStorage.removeItem(MODEL_STORAGE_KEY);
  } else if (selectedModel !== localStorage.getItem(MODEL_STORAGE_KEY)) {
    localStorage.setItem(MODEL_STORAGE_KEY, selectedModel);
  }
  updateInputState();
}

function normalizeModelId(modelId) {
  const cleaned = String(modelId || "").trim();
  return MODEL_ALIASES[cleaned.toLowerCase()] || cleaned;
}

function requestMessages() {
  return sanitizeMessages(messages).filter((message) => !message.error);
}

function messageSignature(source) {
  return JSON.stringify(sanitizeMessages(source));
}

function stopGeneration() {
  activeAbortController?.abort();
}

async function copyAssistantMessage(messageIndex, button) {
  const message = messages[messageIndex];
  if (!message || message.role !== "assistant") return;
  const text = String(message.content || "").trim();
  if (!text) return;

  await copyText(text);
  const previous = button.textContent;
  button.textContent = "已复制";
  button.disabled = true;
  window.setTimeout(() => {
    button.textContent = previous;
    button.disabled = false;
  }, 1200);
}

async function regenerateAssistantMessage(messageIndex) {
  if (isSending) return;
  if (!Number.isInteger(messageIndex) || !messages[messageIndex] || messages[messageIndex].role !== "assistant") return;
  const userIndex = findPreviousUserMessageIndex(messageIndex);
  if (userIndex < 0) return;
  messages = messages.slice(0, messageIndex);
  saveLocalMessages(messages);
  renderMessages();
  await sendMessage();
}

function findPreviousUserMessageIndex(fromIndex) {
  for (let index = Math.min(fromIndex - 1, messages.length - 1); index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return index;
  }
  return -1;
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}

function imageDownloadName(url, index) {
  const cleanUrl = String(url || "").split("?", 1)[0];
  const extension = cleanUrl.match(/\.(png|jpe?g|webp|gif)$/i)?.[0] || ".png";
  return `minai-image-${index + 1}${extension.toLowerCase()}`;
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

function activeModelText() {
  const selectedOption = modelSelect.selectedOptions?.[0];
  return `${selectedModel || ""} ${selectedOption?.value || ""} ${selectedOption?.textContent || ""}`;
}

function isImageModel(modelText) {
  const text = String(modelText || "").toLowerCase();
  return [
    "image",
    "dall-e",
    "seedream",
    "wanx",
    "flux",
    "stable-diffusion",
    "sdxl",
    "midjourney",
    "mj-",
    "jimeng",
    "kolors",
    "hidream",
    "ideogram"
  ].some((keyword) => text.includes(keyword));
}

async function loadConversation() {
  if (!config.user) return;
  isHydratingConversation = true;
  try {
    const response = await fetch("/api/conversations/current");
    const data = await response.json().catch(() => ({}));
    if (response.ok) applyConversationPayload(data);
  } finally {
    isHydratingConversation = false;
  }
}

async function createNewConversation() {
  const response = await fetch("/api/conversations/new", { method: "POST" });
  const data = await response.json().catch(() => ({}));
  if (response.ok) {
    applyConversationPayload(data);
  } else {
    messages = [];
    currentConversationId = "";
    saveLocalMessages([]);
  }
}

async function selectConversation(conversationId) {
  const token = ++conversationSwitchToken;
  markConversationSwitch(conversationId);
  messagesEl.classList.add("is-switching");
  messagesEl.setAttribute("aria-busy", "true");

  try {
    await saveMessages(true).catch(() => null);
    if (token !== conversationSwitchToken) return;
    markConversationSwitch(conversationId);

    const response = await fetch("/api/conversations/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId })
    });
    const data = await response.json().catch(() => ({}));
    if (token !== conversationSwitchToken) return;
    if (response.ok) {
      applyConversationPayload(data);
      messagesEl.classList.remove("is-switching");
      messagesEl.classList.add("is-entering");
      renderMessages();
      await wait(160);
    }
  } finally {
    if (token === conversationSwitchToken) {
      messagesEl.classList.remove("is-switching", "is-entering");
      messagesEl.removeAttribute("aria-busy");
      clearConversationSwitch();
    }
  }
}

function markConversationSwitch(conversationId) {
  conversationList.querySelectorAll(".conversation-row").forEach((row) => {
    const button = row.querySelector("[data-select-conversation]");
    const isTarget = button?.dataset.selectConversation === conversationId;
    row.classList.toggle("active", isTarget);
    row.classList.toggle("pending", isTarget);
  });
}

function clearConversationSwitch() {
  conversationList.querySelectorAll(".conversation-row.pending").forEach((row) => {
    row.classList.remove("pending");
  });
}

async function togglePinned(conversationId, pinned) {
  if (!conversationId || isSending) return;
  const response = await fetch("/api/conversations/pin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId, pinned })
  });
  const data = await response.json().catch(() => ({}));
  if (response.ok) applyConversationPayload(data);
}

async function deleteConversation(conversationId) {
  if (!conversationId || isSending) return;
  const item = conversations.find((conversation) => conversation.id === conversationId);
  const title = item?.title || "这个对话";
  if (!window.confirm(`确定删除「${title}」吗？此操作无法撤销。`)) return;
  const response = await fetch("/api/conversations", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId })
  });
  const data = await response.json().catch(() => ({}));
  if (response.ok) {
    applyConversationPayload(data);
    renderMessages();
  }
}

function applyConversationPayload(data) {
  messages = sanitizeMessages(data.messages || []);
  const nextConversations = Array.isArray(data.conversations) ? data.conversations : [];
  const listChanged = JSON.stringify(nextConversations.map((item) => [item.id, item.title, item.pinned, item.updatedAt])) !==
    JSON.stringify(conversations.map((item) => [item.id, item.title, item.pinned, item.updatedAt]));
  conversations = nextConversations;
  currentConversationId = data.conversationId || data.activeId || "";
  saveLocalMessages(messages);
  lastSavedMessagesSignature = messageSignature(messages);
  if (listChanged) renderConversationList();
}

async function saveMessages(immediate = false) {
  const safeMessages = sanitizeMessages(messages);
  const persistMessages = safeMessages.filter((message) => !message.error);
  const snapshot = JSON.stringify(safeMessages);
  saveLocalMessages(safeMessages);
  if (!config.user || isHydratingConversation) return;
  if (snapshot === lastSavedMessagesSignature) return;

  clearTimeout(saveTimer);
  const persist = async () => {
    if (snapshot !== messageSignature(messages)) return;
    const response = await fetch("/api/conversations/current", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: currentConversationId, messages: persistMessages })
    }).catch(() => null);
    if (response?.ok) {
      const data = await response.json().catch(() => ({}));
      const nextConversations = Array.isArray(data.conversations) ? data.conversations : conversations;
      const listChanged = JSON.stringify(nextConversations.map((item) => [item.id, item.title, item.pinned, item.updatedAt])) !==
        JSON.stringify(conversations.map((item) => [item.id, item.title, item.pinned, item.updatedAt]));
      conversations = nextConversations;
      currentConversationId = data.conversationId || currentConversationId;
      if (snapshot === messageSignature(messages)) lastSavedMessagesSignature = snapshot;
      if (listChanged) renderConversationList();
    }
  };

  if (immediate) {
    await persist();
  } else {
    saveTimer = window.setTimeout(persist, 350);
  }
}

function sanitizeMessages(source) {
  if (!Array.isArray(source)) return [];
  return source
    .filter((message) => ["user", "assistant"].includes(message?.role))
    .map((message) => ({
      role: message.role,
      content: String(message.content || ""),
      error: Boolean(message.error),
      images: Array.isArray(message.images)
        ? message.images
            .filter(
              (url) =>
                typeof url === "string" &&
                (url.startsWith("http://") ||
                  url.startsWith("https://") ||
                  url.startsWith("/generated/") ||
                  url.startsWith("data:image/"))
            )
            .slice(0, 4)
        : [],
      files: Array.isArray(message.files)
        ? message.files
            .filter((file) => file && typeof file.name === "string")
            .map((file) => ({
              name: String(file.name || "").slice(0, 120),
              type: String(file.type || "").slice(0, 80),
              text: String(file.text || "").slice(0, 60000),
              dataUrl:
                String(file.type || "").startsWith("image/") && String(file.dataUrl || "").startsWith("data:image/")
                  ? String(file.dataUrl).slice(0, 2500000)
                  : ""
            }))
            .slice(0, 6)
        : []
    }))
    .filter((message) => message.content || message.images.length || message.files.length)
    .slice(-40);
}

function renderPendingFiles() {
  attachmentTray.innerHTML = "";
  attachmentTray.classList.toggle("hidden", !pendingFiles.length);
  pendingFiles.forEach((file, index) => {
    const chip = document.createElement("span");
    chip.className = "file-chip";
    if (file.type?.startsWith("image/")) chip.classList.add("image-file");
    chip.innerHTML = `
      <span>${escapeHtml(file.name || "附件")}</span>
      <button type="button" data-remove-file="${index}" aria-label="移除 ${escapeHtml(file.name || "附件")}">×</button>
    `;
    attachmentTray.append(chip);
  });
}

async function readAttachment(file) {
  if (file.type.startsWith("image/")) {
    if (file.size > 2 * 1024 * 1024) {
      return {
        name: file.name,
        type: file.type,
        text: `用户上传了图片 ${file.name}，但图片超过 2MB，轻量版没有发送图片内容。`
      };
    }
    return {
      name: file.name,
      type: file.type,
      text: "",
      dataUrl: await fileToDataUrl(file)
    };
  }

  const isText =
    file.type.startsWith("text/") ||
    /\.(txt|md|csv|json|js|ts|py|html|css|xml|ya?ml|log|sql|vue|jsx|tsx)$/i.test(file.name);
  if (!isText) {
    return {
      name: file.name,
      type: file.type || "application/octet-stream",
      text: `用户上传了文件 ${file.name}，但当前轻量版只能直接读取文本类文件内容。`
    };
  }
  const text = await file.text();
  return {
    name: file.name,
    type: file.type || "text/plain",
    text: text.slice(0, 60000)
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function saveLocalMessages(value) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}

function loadLocalMessages() {
  try {
    return sanitizeMessages(JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"));
  } catch {
    return [];
  }
}

function scrollToBottom() {
  if (scrollToBottom.queued) return;
  scrollToBottom.queued = true;
  requestAnimationFrame(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
    scrollToBottom.queued = false;
  });
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = window.setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });
}
