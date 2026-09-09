(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var rootEl = document.documentElement;

  var dropZone = $("drop-zone");
  var fileInput = $("file-input");
  var queueList = $("queue-list");
  var queueCount = $("queue-count");
  var archiveCount = $("archive-count");
  var archiveList = $("archive-list");
  var uploadBtn = $("upload-btn");
  var clearBtn = $("clear-btn");
  var stateLine = $("state-line");
  var accessCard = $("access-card");

  var queue = [];          // { file, status: pending|uploading|ok|err, progress, error }
  var uploading = 0;
  var busy = false;
  var MAX_CONCURRENT = 3;

  /* ---------------- helpers ---------------- */
  function pad(n) { return (n < 10 ? "0" : "") + n; }

  function setState(state) {
    rootEl.dataset.appState = state;
    if (state === "busy") {
      uploadBtn.disabled = true;
      clearBtn.disabled = true;
      uploadBtn.querySelector(".ef-btn-copy").textContent = "传输中";
    } else {
      var hasQueue = queue.length > 0;
      uploadBtn.disabled = !hasQueue || busy;
      clearBtn.disabled = !hasQueue || busy;
      uploadBtn.querySelector(".ef-btn-copy").textContent = "开始传输";
    }
  }

  function setLine(text, tone) {
    stateLine.textContent = "";
    var dot = document.createElement("span");
    dot.className = "ef-state-dot";
    dot.setAttribute("aria-hidden", "true");
    stateLine.appendChild(dot);
    stateLine.appendChild(document.createTextNode(text));
    stateLine.className = "ef-state";
    if (tone) stateLine.classList.add("tone-" + tone);
  }

  function fmtSize(bytes) {
    if (bytes === 0) return "0 B";
    var units = ["B", "KB", "MB", "GB", "TB"];
    var i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + " " + units[i];
  }

  function extOf(name) {
    var ext = String(name).split(".").pop().toLowerCase();
    return ext === String(name) ? "FILE" : ext.toUpperCase().slice(0, 8);
  }

  /* ---------------- info ---------------- */
  function loadInfo() {
    return fetch("/api/info").then(function (r) { return r.json(); }).then(function (info) {
      $("link-text").textContent = "ONLINE";
      $("port-value").textContent = info.port;
      $("node-value").textContent = info.server_name;
      $("dir-value").textContent = info.upload_dir;
      $("foot-dir").textContent = "保存目录 " + info.upload_dir;
      $("max-value").textContent = info.max_file_size_mb > 0
        ? info.max_file_size_mb + " MB" : "不限";
      $("cap-note").textContent = info.max_file_size_mb > 0
        ? "单次总量上限 " + info.max_file_size_mb + " MB"
        : "单次总量上限不限";
      if (info.access_code_required) accessCard.hidden = false;
      var host = location.host;
      $("access-url").textContent = "http://" + host + "/";
      $("qr-img").src = "/api/qr";
      $("qr-img").alt = "访问地址 http://" + host + "/ 的二维码";
      setLine("STANDBY · 就绪，等待文件", "standby");
      setState(queue.length ? "armed" : "online");
      return info;
    }).catch(function () {
      $("link-text").textContent = "OFFLINE";
      setLine("OFFLINE · 无法连接服务器", "err");
      setState("offline");
    });
  }

  /* ---------------- queue ---------------- */
  function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList);
    if (!files.length) return;
    files.forEach(function (f) {
      queue.push({ file: f, status: "pending", progress: 0, error: "" });
    });
    setLine("QUEUED · 已选 " + queue.length + " 个文件，可开始传输", "standby");
    renderQueue();
    setState("armed");
  }

  function removeItem(index) {
    if (busy) return;
    queue.splice(index, 1);
    setLine("QUEUED · 队列已更新，共 " + queue.length + " 个文件", "standby");
    renderQueue();
    setState(queue.length ? "armed" : "online");
  }

  function renderQueue() {
    queueCount.textContent = pad(queue.length);
    queueList.innerHTML = "";

    if (!queue.length) {
      var empty = document.createElement("li");
      empty.className = "ef-empty";
      empty.textContent = "NO FILES · 队列为空，先在上方添加文件";
      queueList.appendChild(empty);
      return;
    }

    queue.forEach(function (item, i) {
      var li = document.createElement("li");
      if (item.status === "uploading") li.classList.add("is-active");

      var index = document.createElement("span");
      index.className = "q-index";
      index.textContent = pad(i + 1);

      var main = document.createElement("div");
      main.className = "q-main";
      var name = document.createElement("div");
      name.className = "q-name";
      name.textContent = item.file.name;
      name.title = item.file.name;
      var meta = document.createElement("div");
      meta.className = "q-meta";
      meta.textContent = extOf(item.file.name) + " · " + fmtSize(item.file.size);
      main.appendChild(name);
      main.appendChild(meta);

      var status = document.createElement("div");
      status.className = "q-status";
      if (item.status === "uploading") {
        status.textContent = "UPLOADING " + Math.round(item.progress) + "%";
        status.classList.add("busy");
      } else if (item.status === "ok") {
        status.textContent = "VERIFIED";
        status.classList.add("ok");
      } else if (item.status === "err") {
        status.textContent = "FAILED";
        status.title = item.error || "";
        status.classList.add("err");
      } else {
        status.textContent = "PENDING";
      }

      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "q-remove";
      remove.textContent = "×";
      remove.setAttribute("aria-label", "移除 " + item.file.name);
      remove.addEventListener("click", function () { removeItem(i); });
      if (busy || item.status === "uploading") remove.disabled = true;

      li.appendChild(index);
      li.appendChild(main);
      li.appendChild(status);
      li.appendChild(remove);

      if (item.status === "uploading" || item.status === "ok" || item.status === "err") {
        var bar = document.createElement("span");
        bar.className = "ef-progress";
        bar.setAttribute("aria-hidden", "true");
        var fill = document.createElement("i");
        fill.style.width = (item.status === "ok" ? 100 : item.progress) + "%";
        bar.appendChild(fill);
        main.appendChild(bar);
      }
      queueList.appendChild(li);
    });
  }

  function updateItem(index, patch) {
    queue[index] = Object.assign({}, queue[index], patch);
    renderQueue();
  }

  /* ---------------- upload ---------------- */
  function uploadOne(index, onProgress) {
    var item = queue[index];
    return new Promise(function (resolve) {
      var fd = new FormData();
      var codeInput = $("access-code");
      if (codeInput && codeInput.value) fd.append("code", codeInput.value);
      fd.append("files", item.file);

      var xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/upload");
      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable) {
          updateItem(index, { progress: (e.loaded / e.total) * 100 });
          onProgress();
        }
      };
      xhr.onload = function () {
        var ok = xhr.status >= 200 && xhr.status < 300;
        var err = "";
        try {
          var data = JSON.parse(xhr.responseText);
          if (!data.ok) { ok = false; err = data.error || "上传失败"; }
        } catch (_) {
          if (!ok) err = "服务器错误 " + xhr.status;
        }
        if (ok) updateItem(index, { status: "ok", progress: 100 });
        else updateItem(index, { status: "err", progress: 0, error: err });
        resolve();
      };
      xhr.onerror = function () {
        updateItem(index, { status: "err", progress: 0, error: "网络错误" });
        resolve();
      };
      xhr.onabort = function () {
        updateItem(index, { status: "err", progress: 0, error: "已取消" });
        resolve();
      };
      updateItem(index, { status: "uploading", progress: 0, error: "" });
      xhr.send(fd);
    });
  }

  function uploadAll() {
    var pending = queue
      .map(function (item, i) { return item.status === "pending" ? i : -1; })
      .filter(function (i) { return i >= 0; });
    if (!pending.length || busy) return;

    busy = true;
    var total = pending.length;
    var done = 0;
    setState("busy");
    setLine("UPLOADING · 正在传输 0/" + total, "busy");

    function tick() {
      if (!busy) return;
      var active = queue.filter(function (it) { return it.status === "uploading"; }).length;
      setLine("UPLOADING · 正在传输 " + (total - pending.length - active) + "/" + total, "busy");
    }

    function next() {
      if (cursor >= pending.length) {
        if (uploading === 0) finish();
        return;
      }
      var i = pending[cursor++];
      uploading++;
      uploadOne(i, tick).then(function () {
        uploading--;
        done++;
        tick();
        next();
      });
    }

    var cursor = 0;
    var slots = Math.min(MAX_CONCURRENT, pending.length);
    for (var s = 0; s < slots; s++) next();

    function finish() {
      busy = false;
      var okCount = queue.filter(function (it) { return it.status === "ok"; }).length;
      var errCount = queue.filter(function (it) { return it.status === "err"; }).length;
      if (errCount === 0) {
        setLine("VERIFIED · 全部完成，共 " + okCount + " 个文件已归档", "ok");
        setState("done");
        queue = [];
        renderQueue();
        setState("online");
      } else {
        setLine("VERIFIED " + okCount + " / FAILED " + errCount + " · 失败项可移除后重试", "partial");
        setState("partial");
      }
      refreshArchive();
    }
  }

  /* ---------------- archive ---------------- */
  function refreshArchive() {
    fetch("/api/files").then(function (r) { return r.json(); }).then(function (data) {
      var files = data.files || [];
      archiveCount.textContent = pad(files.length);
      archiveList.innerHTML = "";
      if (!files.length) {
        var empty = document.createElement("li");
        empty.className = "ef-empty";
        empty.textContent = "EMPTY · 暂无接收记录";
        archiveList.appendChild(empty);
        return;
      }
      files.forEach(function (f) {
        var li = document.createElement("li");

        var ext = document.createElement("span");
        ext.className = "r-ext";
        ext.textContent = extOf(f.name);

        var name = document.createElement("span");
        name.className = "r-name";
        name.textContent = f.name;
        name.title = f.name;

        var size = document.createElement("span");
        size.className = "r-size";
        size.textContent = fmtSize(f.size);

        var time = document.createElement("span");
        time.className = "r-time";
        time.textContent = f.time;

        var ip = document.createElement("span");
        ip.className = "r-ip";
        ip.textContent = f.ip && f.ip !== "-" ? f.ip : "LOCAL";

        li.appendChild(ext);
        li.appendChild(name);
        li.appendChild(size);
        li.appendChild(time);
        li.appendChild(ip);
        archiveList.appendChild(li);
      });
    }).catch(function () { /* 忽略刷新失败 */ });
  }

  /* ---------------- reveal + scroll spy ---------------- */
  function initReveal() {
    rootEl.classList.add("js-ready");
    var targets = Array.prototype.slice.call(document.querySelectorAll("[data-reveal]"));
    var sections = Array.prototype.slice.call(document.querySelectorAll(".ef-sector"));
    var railItems = Array.prototype.slice.call(document.querySelectorAll(".ef-rail-item"));

    var revealIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-in");
          revealIO.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });
    targets.forEach(function (t) { revealIO.observe(t); });

    var spyIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var id = entry.target.id;
        railItems.forEach(function (item) {
          if (item.getAttribute("href") === "#" + id) item.setAttribute("aria-current", "location");
          else item.removeAttribute("aria-current");
        });
      });
    }, { rootMargin: "-30% 0px -60% 0px" });
    sections.forEach(function (s) { spyIO.observe(s); });
  }

  /* ---------------- events ---------------- */
  dropZone.addEventListener("click", function () { fileInput.click(); });
  dropZone.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener("change", function () {
    addFiles(fileInput.files);
    fileInput.value = "";
  });

  ["dragenter", "dragover"].forEach(function (ev) {
    dropZone.addEventListener(ev, function (e) {
      e.preventDefault();
      dropZone.classList.add("is-dragover");
    });
  });
  ["dragleave", "drop"].forEach(function (ev) {
    dropZone.addEventListener(ev, function (e) {
      e.preventDefault();
      dropZone.classList.remove("is-dragover");
    });
  });
  dropZone.addEventListener("drop", function (e) {
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });

  uploadBtn.addEventListener("click", uploadAll);
  clearBtn.addEventListener("click", function () {
    queue = [];
    renderQueue();
    setState("online");
    setLine("STANDBY · 就绪，等待文件", "standby");
  });

  window.addEventListener("dragenter", function (e) { e.preventDefault(); });
  window.addEventListener("dragover", function (e) { e.preventDefault(); });
  window.addEventListener("drop", function (e) { e.preventDefault(); });

  initReveal();
  renderQueue();
  loadInfo().then(refreshArchive);
  setInterval(refreshArchive, 5000);
})();
