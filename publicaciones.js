/* CRM Torres Maldonado | Centro de Publicaciones
   Módulo aditivo. No modifica ni escribe en las tablas del CRM.
   Los borradores se guardan localmente en este navegador. */
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const formats = {
    facebook: [{ id: "feed", label: "Publicación vertical · 1080 × 1350", w: 1080, h: 1350 }, { id: "square", label: "Cuadrada · 1080 × 1080", w: 1080, h: 1080 }, { id: "story", label: "Historia · 1080 × 1920", w: 1080, h: 1920 }],
    instagram: [{ id: "feed", label: "Publicación vertical · 1080 × 1350", w: 1080, h: 1350 }, { id: "square", label: "Cuadrada · 1080 × 1080", w: 1080, h: 1080 }, { id: "story", label: "Historia / Reel · 1080 × 1920", w: 1080, h: 1920 }],
    whatsapp: [{ id: "status", label: "Estado · 1080 × 1920", w: 1080, h: 1920 }, { id: "square", label: "Imagen de chat · 1080 × 1080", w: 1080, h: 1080 }],
    tiktok: [{ id: "vertical", label: "Foto vertical · 1080 × 1920", w: 1080, h: 1920 }]
  };
  const fields = ["pubCode", "pubTitle", "pubCaption", "pubCta", "pubTags", "pubUrl", "pubFit", "pubFormat"];
  let propertyId = "";
  let activeImage = null;
  let imageObjectUrl = "";
  let lastNetwork = "facebook";
  let loaded = false;
  const dialog = $("publicationDialog");
  const canvas = $("pubCanvas");
  if (!dialog || !canvas) return;
  const ctx = canvas.getContext("2d");
  const status = message => { $("pubStatus").textContent = message; };
  const key = network => `crm-publicacion-v1:${propertyId}:${network}`;
  const getDraft = network => {
    try { return JSON.parse(localStorage.getItem(key(network)) || "null"); }
    catch (_) { return null; }
  };
  const saveDraft = () => {
    if (!propertyId) return;
    const data = Object.fromEntries(fields.map(id => [id, $(id).value]));
    try { localStorage.setItem(key($("pubNetwork").value), JSON.stringify(data)); status("Borrador guardado en este dispositivo."); }
    catch (_) { status("No se pudo guardar el borrador. Revisa el almacenamiento del navegador."); }
  };
  const normalizeCode = title => {
    const match = String(title || "").match(/\bRM[- ]?\d{1,5}\b/i);
    return match ? match[0].toUpperCase().replace(" ", "-") : "";
  };
  const defaults = () => ({
    pubCode: normalizeCode($("propertyTitle").value),
    pubTitle: $("propertyTitle").value.trim(),
    pubCaption: $("propertyDescription").value.trim(),
    pubCta: "Solicita información y agenda tu visita.",
    pubTags: "#CasaEnVenta #PuertoVallarta #MarketInmobiliario",
    pubUrl: "", pubFit: "contain"
  });
  function updateFormats(preferred) {
    const network = $("pubNetwork").value;
    $("pubFormat").innerHTML = formats[network].map(item => `<option value="${item.id}">${item.label}</option>`).join("");
    if (formats[network].some(item => item.id === preferred)) $("pubFormat").value = preferred;
    render();
  }
  function restore(network) {
    const data = { ...defaults(), ...(getDraft(network) || {}) };
    for (const id of fields) if (id !== "pubFormat" && data[id] != null) $(id).value = data[id];
    updateFormats(data.pubFormat);
  }
  function selectedFormat() {
    return formats[$("pubNetwork").value].find(item => item.id === $("pubFormat").value) || formats.facebook[0];
  }
  function render() {
    const f = selectedFormat();
    canvas.width = f.w; canvas.height = f.h;
    $("pubDimensions").textContent = `${f.w} × ${f.h} px · ${$("pubNetwork").selectedOptions[0].text}`;
    ctx.fillStyle = "#111111"; ctx.fillRect(0, 0, f.w, f.h);
    if (!activeImage) {
      ctx.fillStyle = "#e0c17f";
      ctx.textAlign = "center";
      ctx.font = "44px Georgia";
      ctx.fillText("TORRES MALDONADO", f.w / 2, f.h / 2 - 20);
      ctx.font = "30px Arial";
      ctx.fillText("Selecciona una fotografía", f.w / 2, f.h / 2 + 42);
      return;
    }
    const iw = activeImage.naturalWidth, ih = activeImage.naturalHeight;
    const scale = $("pubFit").value === "cover" ? Math.max(f.w / iw, f.h / ih) : Math.min(f.w / iw, f.h / ih);
    const w = iw * scale, h = ih * scale;
    ctx.drawImage(activeImage, (f.w - w) / 2, (f.h - h) / 2, w, h);
  }
  async function loadImage(src, isBlob = false) {
    if (!src) { activeImage = null; render(); return; }
    const image = new Image();
    if (!isBlob) image.crossOrigin = "anonymous";
    try {
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error("No se pudo cargar la foto principal. Elige una foto desde tu dispositivo."));
        image.src = src;
      });
      activeImage = image;
      render();
      status("Fotografía lista para revisar y exportar.");
    } catch (error) { activeImage = null; render(); status(error.message); }
  }
  function buildText() {
    return [$("pubTitle").value.trim(), $("pubCaption").value.trim(), $("pubCta").value.trim(), $("pubTags").value.trim(), $("pubUrl").value.trim()].filter(Boolean).join("\n\n");
  }
  async function imageBlob() {
    if (!activeImage) throw new Error("Selecciona una fotografía antes de exportar o compartir.");
    render();
    return new Promise((resolve, reject) => {
      try { canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("No se pudo crear la imagen.")), "image/jpeg", 0.92); }
      catch (_) { reject(new Error("La foto principal no permite exportación desde este origen. Selecciónala desde tu dispositivo.")); }
    });
  }
  async function downloadImage() {
    const blob = await imageBlob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${$("pubCode").value.trim() || "propiedad"}-${$("pubNetwork").value}-${selectedFormat().id}.jpg`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    status("Imagen descargada con las medidas seleccionadas.");
  }
  async function copyText() {
    const text = buildText();
    try { await navigator.clipboard.writeText(text); status("Texto copiado. Pégalo en tu publicación."); }
    catch (_) { status("No se pudo copiar automáticamente. Selecciona el texto del editor para copiarlo."); }
  }
  async function share() {
    const network = $("pubNetwork").value;
    const text = buildText();
    const url = $("pubUrl").value.trim();
    let blob = null;
    try { blob = await imageBlob(); }
    catch (error) { status(error.message); return; }
    const file = new File([blob], `${$("pubCode").value || "propiedad"}.jpg`, { type: "image/jpeg" });
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], text, title: $("pubTitle").value });
        status("Se abrió el menú de compartir. Selecciona la aplicación y confirma el envío.");
      } catch (error) { if (error.name !== "AbortError") status(`No se pudo compartir: ${error.message}`); }
      return;
    }
    if (network === "facebook" && /^https?:\/\//i.test(url)) {
      await copyText();
      window.open(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`, "_blank", "noopener,noreferrer");
      status("Se abrió Facebook para compartir el enlace público. El texto está copiado; revisa y publica manualmente. La foto no se adjunta automáticamente.");
      return;
    }
    if (network === "whatsapp") {
      window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`, "_blank", "noopener,noreferrer");
      status("Se abrió WhatsApp con el texto. Para adjuntar la foto, descárgala primero.");
      return;
    }
    await copyText();
    status(`Tu navegador no permite compartir archivos directamente con ${network}. Descarga la imagen y pega el texto en la aplicación.`);
  }
  function open() {
    propertyId = $("propertyId").value;
    if (!propertyId) return;
    $("pubHeading").textContent = $("propertyTitle").value || "Publicar propiedad";
    $("pubNetwork").value = "facebook";
    lastNetwork = "facebook";
    restore(lastNetwork);
    dialog.showModal();
    const preview = $("propertyPhotoPreview").querySelector("img");
    activeImage = null;
    render();
    if (preview?.src) void loadImage(preview.src);
    else status("Selecciona una fotografía para preparar la publicación.");
  }
  $("openPublicationCenter").addEventListener("click", open);
  // El botón solo aparece al editar una propiedad existente; una propiedad nueva debe guardarse primero.
  new MutationObserver(() => {
    $("openPublicationCenter").hidden = !$("propertyId").value;
  }).observe($("propertyDialog"), { attributes: true, attributeFilter: ["open"] });
  $("pubClose").addEventListener("click", () => dialog.close());
  $("pubNetwork").addEventListener("change", () => { saveNetwork(lastNetwork); lastNetwork = $("pubNetwork").value; restore(lastNetwork); });
  function saveNetwork(network) {
    const data = Object.fromEntries(fields.map(id => [id, $(id).value]));
    try { localStorage.setItem(key(network), JSON.stringify(data)); } catch (_) { /* storage unavailable */ }
  }
  $("pubFormat").addEventListener("change", render);
  $("pubFit").addEventListener("change", render);
  $("pubImageFile").addEventListener("change", event => {
    const file = event.target.files?.[0]; if (!file) return;
    if (!file.type.startsWith("image/")) { status("Selecciona un archivo de imagen válido."); return; }
    if (imageObjectUrl) URL.revokeObjectURL(imageObjectUrl);
    imageObjectUrl = URL.createObjectURL(file);
    void loadImage(imageObjectUrl, true);
  });
  $("pubSave").addEventListener("click", saveDraft);
  $("pubCopy").addEventListener("click", () => { void copyText(); });
  $("pubDownload").addEventListener("click", () => { void downloadImage().catch(error => status(error.message)); });
  $("pubShare").addEventListener("click", () => { void share().catch(error => status(error.message)); });
  dialog.addEventListener("close", () => {
    if (propertyId) saveDraft();
    if (imageObjectUrl) { URL.revokeObjectURL(imageObjectUrl); imageObjectUrl = ""; }
    $("pubImageFile").value = "";
    activeImage = null;
  });
})();
