import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, GoogleAuthProvider, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { getStorage, ref, listAll, getBytes, getMetadata } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js";
import { build as esbuildBuild, initialize as esbuildInitialize } from "../../vendor/esbuild-wasm/browser.min.js";
import fetcher from "./fetcher.js";

const firebaseConfig = await fetcher.load('../config/firebaseConfig.json');

const $ = (id) => document.getElementById(id);
const authOverlay = $("authOverlay");
const appView = $("app");
const authStatus = $("authStatus");
const loadStatus = $("loadStatus");
let storage;
let currentUser = null;
let activePreviewToken = "";
let esbuildReady;

const showStatus = (element, message, isError = false) => {
    element.textContent = message;
    element.classList.toggle("error", isError);
};

window.addEventListener("message", (event) => {
    if (event.data?.type === "preview-error" && event.data.token === activePreviewToken) showStatus(loadStatus, `${loadStatus.textContent}\n${event.data.message}`, true);
});

const friendlyError = (error) => {
    const messages = {
        "auth/invalid-credential": "Email 或密碼不正確。",
        "auth/email-already-in-use": "這個 Email 已經註冊。",
        "auth/weak-password": "密碼至少需要 6 個字元。",
        "auth/popup-closed-by-user": "登入視窗已關閉。",
        "storage/unauthorized": "目前帳號沒有權限讀取這個 Storage 路徑。"
    };
    return messages[error.code] || error.message || "操作失敗，請稍後再試。";
};

const fileDate = (metadata) => metadata.updated ? new Date(metadata.updated).toLocaleDateString("zh-TW") : "未知日期";

const collectStorageFiles = async (directoryRef) => {
    const result = await listAll(directoryRef);
    const files = await Promise.all(result.items.map(async (itemRef) => {
        const metadata = await getMetadata(itemRef);
        return { name: itemRef.name, fullPath: itemRef.fullPath, ref: itemRef, metadata };
    }));
    const nested = await Promise.all(result.prefixes.map((prefix) => collectStorageFiles(prefix)));
    return files.concat(...nested);
};

const isExternalReference = (value) => /^(?:[a-z]+:|\/\/|data:|#)/i.test(value);

const storagePathFor = (value, directory) => decodeURIComponent(new URL(value, `https://storage.local/${directory}`)
    .pathname.replace(/^\//, ""));

const mimeTypeFor = (fileName) => ({
    ".html": "text/html",
    ".css": "text/css",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".bmp": "image/bmp",
    ".woff": "font/woff",
    ".woff2": "font/woff2"
})[fileName.slice(fileName.lastIndexOf(".")).toLowerCase()] || "application/octet-stream";

const openStorageHtml = async (file, allFiles) => {
    const previewToken = crypto.randomUUID();
    activePreviewToken = previewToken;
    const blobUrls = [];
    const fileMap = new Map();
    const fetchWithTimeout = async (url, label) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        try {
            return await fetch(url, { signal: controller.signal });
        } catch (error) {
            if (error.name === "AbortError") throw new Error(`${label} 讀取逾時。`);
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    };
    const downloadedFiles = await Promise.all(allFiles.map(async (item) => {
        let bytes;
        try {
            bytes = await getBytes(item.ref);
        } catch (error) {
            throw new Error(`${item.name} 讀取失敗：${friendlyError(error)}`);
        }
        const blob = new Blob([bytes], {
            type: mimeTypeFor(item.name)
        });
        return { item, blobUrl: URL.createObjectURL(blob) };
    }));
    for (const { item, blobUrl } of downloadedFiles) {
        blobUrls.push(blobUrl);
        fileMap.set(item.fullPath, blobUrl);
    }
    const previewDirectory = file.fullPath.slice(0, file.fullPath.lastIndexOf("/") + 1);

    const rewriteCssReferences = (css, directory) => css
        .replace(/url\(\s*["']?([^\)"']+)["']?\s*\)/gi, (match, value) => {
            if (isExternalReference(value)) return match;
            const [reference, suffix = ""] = value.split(/([?#].*)/, 2);
            const target = fileMap.get(storagePathFor(reference, directory));
            return target ? `url("${target}${suffix}")` : match;
        })
        .replace(/(@import\s*["'])([^"']+)(["'])/gi, (match, prefix, value, suffix) => {
            if (isExternalReference(value)) return match;
            const [reference, query = ""] = value.split(/([?#].*)/, 2);
            const target = fileMap.get(storagePathFor(reference, directory));
            return target ? `${prefix}${target}${query}${suffix}` : match;
        });

    for (const item of allFiles.filter((candidate) => candidate.name.toLowerCase().endsWith(".css"))) {
        const cssResponse = await fetchWithTimeout(fileMap.get(item.fullPath), item.name);
        const css = await cssResponse.text();
        const directory = item.fullPath.slice(0, item.fullPath.lastIndexOf("/") + 1);
        const rewrittenCss = rewriteCssReferences(css, directory);
        const cssBlobUrl = URL.createObjectURL(new Blob([rewrittenCss], { type: "text/css" }));
        blobUrls.push(cssBlobUrl);
        fileMap.set(item.fullPath, cssBlobUrl);
    }

    const filesByPath = new Map(allFiles.map((item) => [item.fullPath, item]));
    const findStorageFile = (path) => filesByPath.get(path)
        || allFiles.find((item) => item.fullPath.endsWith(`/${path}`))
        || allFiles.find((item) => item.name === path.split("/").pop());
    const rewriteModuleAssetReferences = (source, directory) => source.replace(/(["'`])(\.\.?\/[^"'`]+)\1/g, (match, quote, specifier) => {
        const [reference, suffix = ""] = specifier.split(/([?#].*)/, 2);
        const dependency = findStorageFile(storagePathFor(reference, directory));
        if (dependency && /\.(?:m?js)$/i.test(dependency.name)) return match;
        const dependencyUrl = dependency && fileMap.get(dependency.fullPath);
        return dependencyUrl ? `${quote}${dependencyUrl}${suffix}${quote}` : match;
    });
    const moduleFiles = allFiles.filter((item) => /\.(?:m?js)$/i.test(item.name));
    const moduleSources = new Map(await Promise.all(moduleFiles.map(async (item) => {
        const response = await fetchWithTimeout(fileMap.get(item.fullPath), item.name);
        if (!response.ok) throw new Error(`${item.name} 讀取失敗（HTTP ${response.status}）。`);
        return [item.fullPath, await response.text()];
    })));
    const mainModule = moduleFiles.find((item) => item.name.toLowerCase() === "main.js");
    if (!mainModule) throw new Error("找不到 main.js，無法建立單一 bundle。");
    if (!esbuildReady) esbuildReady = esbuildInitialize({
        wasmURL: new URL("../../vendor/esbuild-wasm/esbuild.wasm", import.meta.url).href,
        worker: false
    });
    await esbuildReady;
    const bundleEntry = moduleFiles
        .map((item) => `import ${JSON.stringify(`./${item.fullPath}`)};`)
        .join("\n");
    const bundleResult = await esbuildBuild({
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
        stdin: {
            contents: bundleEntry,
            sourcefile: "__storage_bundle_entry__.js",
            resolveDir: ""
        },
        plugins: [{
            name: "firebase-storage-files",
            setup(build) {
                build.onResolve({ filter: /^\.\.?\// }, (args) => ({
                    path: storagePathFor(args.path, args.importer.slice(0, args.importer.lastIndexOf("/") + 1).replace(/^\/+/, "")),
                    namespace: "storage"
                }));
                build.onLoad({ filter: /.*/, namespace: "storage" }, (args) => {
                    const path = args.path.replace(/^\/+/, "");
                    const source = moduleSources.get(path);
                    if (source == null) return { errors: [{ text: `找不到模組：${path}` }] };
                    const directory = path.slice(0, path.lastIndexOf("/") + 1);
                    return { contents: rewriteModuleAssetReferences(source, previewDirectory), loader: "js", resolveDir: path.slice(0, path.lastIndexOf("/")) };
                });
            }
        }]
    });
    const bundleUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(bundleResult.outputFiles[0].text)}`;
    fileMap.set(mainModule.fullPath, bundleUrl);
    const importPattern = /\b(?:from|import)\s*(?:\(\s*)?["'](\.\.?\/[^"']+)["']/g;

    const rewriteModuleReferences = (source, directory, referenceMap = fileMap) => {
        let rewritten = source.replace(importPattern, (match, specifier) => {
            const dependency = findStorageFile(storagePathFor(specifier, directory));
            const dependencyUrl = dependency && referenceMap.get(dependency.fullPath);
            return dependencyUrl ? match.replace(specifier, dependencyUrl) : match;
        });
        rewritten = rewritten.replace(/(["'`])(\.\.?\/[^"'`]+)\1/g, (match, quote, specifier) => {
            const dependency = findStorageFile(storagePathFor(specifier, directory));
            const dependencyUrl = dependency && referenceMap.get(dependency.fullPath);
            return dependencyUrl ? `${quote}${dependencyUrl}${quote}` : match;
        });
        for (const item of moduleFiles) {
            const dependencyUrl = referenceMap.get(item.fullPath);
            const escapedName = item.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            rewritten = rewritten.replace(new RegExp(`(["'])\\./${escapedName}(["'])`, "g"), `$1${dependencyUrl}$2`);
            if (dependencyUrl) rewritten = rewritten.split(`./${item.name}`).join(dependencyUrl);
        }
        const mainModule = moduleFiles.find((item) => item.name.toLowerCase() === "main.js");
        const mainModuleUrl = mainModule && referenceMap.get(mainModule.fullPath);
        if (mainModuleUrl) rewritten = rewritten.split("./main.js").join(mainModuleUrl);
        return rewritten;
    };

    fileMap.set(mainModule.fullPath, bundleUrl);

    const htmlResponse = await fetchWithTimeout(fileMap.get(file.fullPath), file.name);
    let html = await htmlResponse.text();
    html = rewriteModuleReferences(html, file.fullPath.slice(0, file.fullPath.lastIndexOf("/") + 1));
    const document = new DOMParser().parseFromString(html, "text/html");
    const directory = file.fullPath.slice(0, file.fullPath.lastIndexOf("/") + 1);

    document.querySelectorAll("style").forEach((style) => {
        style.textContent = rewriteCssReferences(style.textContent, directory);
    });
    document.querySelectorAll("[style]").forEach((element) => {
        element.setAttribute("style", rewriteCssReferences(element.getAttribute("style"), directory));
    });

    document.querySelectorAll("script").forEach((script) => {
        const source = script.getAttribute("src");
        if (source && /\.(?:m?js)(?:[?#]|$)/i.test(source)) script.remove();
        else if (script.type === "module") script.remove();
    });
    const bundleScript = document.createElement("script");
    bundleScript.src = bundleUrl;
    bundleScript.defer = true;
    document.head.append(bundleScript);

    document.querySelectorAll("[src], [href]").forEach((element) => {
        const attribute = element.hasAttribute("src") ? "src" : "href";
        const value = element.getAttribute(attribute);
        if (!value || isExternalReference(value)) return;
        const [reference, suffix = ""] = value.split(/([?#].*)/, 2);
        const targetPath = storagePathFor(reference, directory);
        const targetFile = findStorageFile(targetPath);
        const downloadUrl = targetFile && fileMap.get(targetFile.fullPath);
        if (downloadUrl) element.setAttribute(attribute, `${downloadUrl}${suffix}`);
    });

    document.querySelectorAll("[srcset]").forEach((element) => {
        const value = element.getAttribute("srcset");
        if (!value) return;
        const rewritten = value.split(",").map((candidate) => {
            const parts = candidate.trim().split(/\s+/);
            const reference = parts.shift();
            if (!reference || isExternalReference(reference)) return candidate;
            const [path, suffix = ""] = reference.split(/([?#].*)/, 2);
            const targetFile = findStorageFile(storagePathFor(path, directory));
            const downloadUrl = targetFile && fileMap.get(targetFile.fullPath);
            if (!downloadUrl) return candidate;
            return [downloadUrl + suffix, ...parts].join(" ");
        }).join(",");
        element.setAttribute("srcset", rewritten);
    });

    const runtimeScript = document.createElement("script");
    runtimeScript.textContent = `
                window.addEventListener("error", (event) => window.parent?.postMessage({ type: "preview-error", token: "${previewToken}", message: (event.error?.stack || event.message) + " @ " + (event.filename || "unknown") + ":" + (event.lineno || 0) + ":" + (event.colno || 0) }, "*"));
                window.addEventListener("unhandledrejection", (event) => window.parent?.postMessage({ type: "preview-error", token: "${previewToken}", message: event.reason?.stack || String(event.reason) }, "*"));
            `;
    document.head.prepend(runtimeScript);

    const finalHtml = `<!doctype html>${document.documentElement.outerHTML}`;
    const blobUrl = URL.createObjectURL(new Blob([finalHtml], {
        type: "text/html"
    }));
    return blobUrl;
};

const renderFiles = (files) => {
    const htmlFiles = files.filter((file) => file.name.toLowerCase().endsWith(".html"));
    $("fileList").innerHTML = htmlFiles.length ? htmlFiles.map((file) => `
        <article class="file-row">
          <div class="file-icon">HTML</div>
          <div>
            <div class="file-name" title="${file.fullPath}">${file.name}</div>
            <div class="file-meta">${file.fullPath} · ${fileDate(file.metadata)}</div>
          </div>
          <div class="row-actions">
                        <button class="action secondary preview-button" data-path="${encodeURIComponent(file.fullPath)}">預覽</button>
          </div>
        </article>`).join("") : `<div class="empty">這個路徑沒有找到 HTML 文件。</div>`;

    document.querySelectorAll(".preview-button").forEach((button) => button.addEventListener("click", async () => {
        const file = files.find((item) => item.fullPath === decodeURIComponent(button.dataset.path));
        if (!file) return;
        const originalLabel = button.textContent;
        let previewUrl = "";
        button.disabled = true;
        button.classList.add("is-loading");
        button.textContent = "載入中…";
        try {
            showStatus(loadStatus, `正在準備 ${file.name}…`);
            previewUrl = await openStorageHtml(file, files);
            $("previewTitle").textContent = file.name;
            $("previewPath").textContent = file.fullPath;
            $("previewFrame").src = previewUrl;
            $("previewPanel").classList.remove("hidden");
            showStatus(loadStatus, `已在頁面內載入 ${file.name} 預覽。`);
        } catch (error) {
            if (previewUrl) URL.revokeObjectURL(previewUrl);
            showStatus(loadStatus, error.message || "無法開啟 HTML 文件。", true);
        } finally {
            button.disabled = false;
            button.classList.remove("is-loading");
            button.textContent = originalLabel;
        }
    }));
};

$("closePreviewButton").addEventListener("click", () => {
    const frame = $("previewFrame");
    const previewUrl = frame.src;
    frame.src = "about:blank";
    $("previewPanel").classList.add("hidden");
    if (previewUrl.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
});

const fullscreenPreviewButton = $("fullscreenPreviewButton");
const previewPanel = $("previewPanel");
const previewHost = previewPanel.closest(".content");
fullscreenPreviewButton.addEventListener("click", () => {
    const expanded = previewPanel.classList.toggle("is-expanded");
    document.body.classList.toggle("preview-expanded-body", expanded);
    previewHost.classList.toggle("preview-host-expanded", expanded);
    fullscreenPreviewButton.textContent = expanded ? "退出預覽" : "展開預覽";
});

const loadFiles = async () => {
    const path = $("storagePath").value.trim().replace(/^\/+|\/+$/g, "");
    if (!path) {
        showStatus(loadStatus, "請輸入 Storage 路徑。", true);
        return;
    }
    $("currentPath").textContent = `storage / ${path}`;
    showStatus(loadStatus, "正在讀取檔案…");
    $("fileList").innerHTML = `<div class="empty">正在整理 Storage 內容…</div>`;
    try {
        const files = await collectStorageFiles(ref(storage, path));
        renderFiles(files);
        showStatus(loadStatus, `找到 ${files.filter((file) => file.name.toLowerCase().endsWith(".html")).length} 個 HTML 文件。`);
    } catch (error) {
        $("fileList").innerHTML = `<div class="empty">無法讀取這個路徑。</div>`;
        showStatus(loadStatus, friendlyError(error), true);
    }
};

const ensureConfigured = () => !firebaseConfig.apiKey.startsWith("YOUR_");
if (!ensureConfigured()) {
    showStatus(authStatus, "請先在 index.html 填入 Firebase Web App 設定。", true);
} else {
    const firebaseApp = initializeApp(firebaseConfig);
    const auth = getAuth(firebaseApp);
    storage = getStorage(firebaseApp);

    onAuthStateChanged(auth, (user) => {
        currentUser = user;
        authOverlay.classList.toggle("hidden", Boolean(user));
        appView.classList.toggle("hidden", !user);
        if (user) {
            $("userEmail").textContent = user.email || "已登入";
            loadFiles();
        }
    });

    $("loginButton").addEventListener("click", async () => {
        try { await signInWithEmailAndPassword(auth, $("email").value, $("password").value); }
        catch (error) { showStatus(authStatus, friendlyError(error), true); }
    });
    $("signupButton").addEventListener("click", async () => {
        try { await createUserWithEmailAndPassword(auth, $("email").value, $("password").value); }
        catch (error) { showStatus(authStatus, friendlyError(error), true); }
    });
    $("googleButton").addEventListener("click", async () => {
        try { await signInWithPopup(auth, new GoogleAuthProvider()); }
        catch (error) { showStatus(authStatus, friendlyError(error), true); }
    });
    $("logoutButton").addEventListener("click", () => signOut(auth));
    $("loadButton").addEventListener("click", loadFiles);
    $("refreshButton").addEventListener("click", loadFiles);
    $("storagePath").addEventListener("keydown", (event) => { if (event.key === "Enter") loadFiles(); });
}