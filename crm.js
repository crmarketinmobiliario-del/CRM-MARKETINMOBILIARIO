(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const CLIENT_STAGES = ["Interés", "Selección", "Trámite", "Entrega"];
  const PROPERTY_STAGES = ["Revisión", "Aceptación y firma del convenio de promoción y comisión", "Promoción", "Entrega"];
  const DB_NAME = "torrez-maldonado-crm";
  const DB_VERSION = 1;
  const CLOUD_TABLE = "crm_leads";
  let supabaseClient = null;
  let currentUser = null;
  let activeAuthMode = "login";
  let appliedAuthUserId = null;
  let dbPromise;
  let leads = [];
  let selectedDay = startOfDay(new Date());
  let visibleMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  let currentImage = null;
  let currentImageUrl = null;
  let captureSelections = [];
  let captureDrawing = null;
  let captureRotation = 0;
  let captureZoom = 1;
  let capturePanMode = false;
  const captureCanvas = $("captureCanvas");
  const captureSelectionCanvas = $("captureSelectionCanvas");
  const captureContext = captureCanvas.getContext("2d");
  const captureSelectionContext = captureSelectionCanvas.getContext("2d");

  function startOfDay(date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()); }
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) return reject(new Error("Este navegador no permite guardar datos localmente."));
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("leads")) database.createObjectStore("leads", { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("No se pudo abrir la base local."));
    });
    return dbPromise;
  }
  async function getAllLeads() {
    const database = await openDB();
    return new Promise((resolve, reject) => {
      const request = database.transaction("leads", "readonly").objectStore("leads").getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }
  async function putLead(lead) {
    if (currentUser) lead.ownerId = currentUser.id;
    const database = await openDB();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("leads", "readwrite");
      transaction.objectStore("leads").put(lead);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("No se pudo guardar el contacto."));
    });
    if (!currentUser || !navigator.onLine) return { synced: false };
    const { error } = await supabaseClient.from(CLOUD_TABLE).upsert(toDatabaseLead(lead), { onConflict: "id" });
    return error ? { synced: false, error } : { synced: true };
  }
  async function putMany(records) {
    const database = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction("leads", "readwrite");
      const store = transaction.objectStore("leads");
      records.forEach(record => store.put(record));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("No se pudo importar el respaldo."));
    });
  }
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, char => {
      const random = Math.random() * 16 | 0;
      return (char === "x" ? random : (random & 3 | 8)).toString(16);
    });
  }
  function isUuid(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || "")); }
  function stagesFor(leadOrType) {
    const type = typeof leadOrType === "string" ? leadOrType : leadOrType.clientType;
    return ["Propietario vendedor", "Ofrece renta"].includes(type) ? PROPERTY_STAGES : CLIENT_STAGES;
  }
  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
  }
  function phoneDigits(value) { return String(value || "").replace(/\D/g, ""); }
  function whatsappNumber(value) {
    const digits = phoneDigits(value);
    return digits.length === 10 ? `52${digits}` : digits;
  }
  function localDateTime(value) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("es-MX", { dateStyle:"medium", timeStyle:"short" });
  }
  function localDate(value) {
    if (!value) return "";
    const date = new Date(`${value}T12:00:00`);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("es-MX", { day:"numeric", month:"short", year:"numeric" });
  }
  function toDateInput(date) {
    const d = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return d.toISOString().slice(0, 10);
  }
  function setStatus(text) { $("saveStatus").textContent = text; }
  function setFormError(text) { $("formError").textContent = text || ""; }
  function toLocalDateTimeInput(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  }
  function toDatabaseLead(lead) {
    return {
      id: lead.id,
      owner_id: currentUser.id,
      name: lead.name,
      phone: lead.phone || null,
      email: lead.email || null,
      budget: lead.budget ?? null,
      client_type: lead.clientType,
      operation: lead.operation,
      credit_type: lead.creditType || "",
      property_type: lead.propertyType || "",
      zone_type: lead.zoneType || "",
      zone: lead.zone || null,
      source: lead.source || "Captura manual",
      stage: lead.stage || "Interés",
      start_date: lead.startDate || null,
      next_contact: lead.nextContact ? new Date(lead.nextContact).toISOString() : null,
      next_channel: lead.nextChannel || "Llamada",
      target_date: lead.targetDate || null,
      rent_start: lead.rentStart || null,
      rent_end: lead.rentEnd || null,
      comments: lead.comments || "",
      whatsapp_opt_in: Boolean(lead.waOptIn),
      activities: Array.isArray(lead.activities) ? lead.activities : [],
      last_contact_at: lead.lastContactAt || null,
      archived: Boolean(lead.archived),
      created_at: lead.createdAt || new Date().toISOString(),
      updated_at: lead.updatedAt || new Date().toISOString()
    };
  }
  function fromDatabaseLead(row) {
    return {
      id: row.id, ownerId: row.owner_id, name: row.name || "", phone: row.phone || "", email: row.email || "",
      budget: row.budget == null ? null : Number(row.budget), clientType: row.client_type, operation: row.operation,
      creditType: row.credit_type || "", propertyType: row.property_type || "", zoneType: row.zone_type || "",
      zone: row.zone || "", source: row.source || "Captura manual", stage: row.stage || "Interés",
      startDate: row.start_date || "", nextContact: toLocalDateTimeInput(row.next_contact), nextChannel: row.next_channel || "Llamada",
      targetDate: row.target_date || "", rentStart: row.rent_start || "", rentEnd: row.rent_end || "",
      comments: row.comments || "", waOptIn: Boolean(row.whatsapp_opt_in), activities: Array.isArray(row.activities) ? row.activities : [],
      lastContactAt: row.last_contact_at || "", archived: Boolean(row.archived), createdAt: row.created_at, updatedAt: row.updated_at
    };
  }
  function recordTime(value) { const time = Date.parse(value || ""); return Number.isFinite(time) ? time : 0; }
  async function syncWithCloud() {
    const stored = await getAllLeads();
    const local = stored.filter(lead => !lead.ownerId || lead.ownerId === currentUser.id)
      .map(lead => ({ ...lead, id: isUuid(lead.id) ? lead.id : uuid(), ownerId: currentUser.id }));
    if (!navigator.onLine) {
      if (local.length) await putMany(local);
      leads = local;
      return false;
    }
    const { data: initialRows, error: initialError } = await supabaseClient.from(CLOUD_TABLE).select("*");
    if (initialError) throw initialError;
    const cloudById = new Map((initialRows || []).map(row => [row.id, fromDatabaseLead(row)]));
    const pending = local.filter(lead => {
      const cloud = cloudById.get(lead.id);
      return !cloud || recordTime(lead.updatedAt) > recordTime(cloud.updatedAt);
    });
    if (pending.length) {
      const { error } = await supabaseClient.from(CLOUD_TABLE).upsert(pending.map(toDatabaseLead), { onConflict: "id" });
      if (error) throw error;
    }
    const { data: finalRows, error: finalError } = await supabaseClient.from(CLOUD_TABLE).select("*").order("updated_at", { ascending: false });
    if (finalError) throw finalError;
    const synced = (finalRows || []).map(fromDatabaseLead);
    const otherUsers = stored.filter(lead => lead.ownerId && lead.ownerId !== currentUser.id);
    await putMany([...otherUsers, ...synced]);
    leads = synced;
    return true;
  }
  async function updateAuthView(session) {
    const user = session?.user || null;
    const id = user?.id || "";
    if (appliedAuthUserId === id) return;
    appliedAuthUserId = id;
    currentUser = user;
    $("authGate").hidden = Boolean(user);
    $("crmApp").hidden = !user;
    $("accountEmail").hidden = !user;
    $("logoutBtn").hidden = !user;
    $("syncBadge").hidden = !user;
    if (user) {
      $("accountEmail").textContent = user.email || "Sesión activa";
      await refresh();
      receiveReaderCapture();
    } else {
      leads = [];
      renderStats(); renderLeads(); renderCalendar();
    }
  }
  async function initializeSupabase() {
    const config = window.CRM_SUPABASE_CONFIG;
    if (!window.supabase?.createClient || !config?.url || !config?.publishableKey) {
      $("authStatus").textContent = "No se pudo cargar la conexión. Revisa tu internet e inténtalo de nuevo.";
      return;
    }
    supabaseClient = window.supabase.createClient(config.url, config.publishableKey, {
      auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true }
    });
    supabaseClient.auth.onAuthStateChange((_event, session) => { void updateAuthView(session); });
    const { data, error } = await supabaseClient.auth.getSession();
    if (error) { $("authStatus").textContent = `No se pudo revisar la sesión: ${error.message}`; return; }
    await updateAuthView(data.session);
  }
  function showAuthMode() {
    const signup = activeAuthMode === "signup";
    $("authTitle").textContent = signup ? "Crea tu acceso al CRM." : "Tu CRM, en todos tus dispositivos.";
    $("authSubmit").textContent = signup ? "Crear acceso" : "Iniciar sesión";
    $("authModeToggle").textContent = signup ? "Ya tengo acceso: iniciar sesión" : "Primera vez: crear mi acceso";
    $("authPassword").autocomplete = signup ? "new-password" : "current-password";
    $("authStatus").textContent = "";
  }

  function fillStageOptions(selected = "") {
    const type = $("clientType").value;
    const choices = type ? stagesFor(type) : [...new Set([...CLIENT_STAGES, ...PROPERTY_STAGES])];
    $("stage").innerHTML = choices.map(stage => `<option${stage === selected ? " selected" : ""}>${esc(stage)}</option>`).join("");
  }
  function fillStageFilter() {
    const select = $("stageFilter");
    const selected = select.value;
    const allStages = [...new Set([...CLIENT_STAGES, ...PROPERTY_STAGES])];
    select.innerHTML = `<option value="">Todas las etapas</option>` + allStages.map(stage => `<option>${esc(stage)}</option>`).join("");
    if (allStages.includes(selected)) select.value = selected;
  }
  function activeLeads() { return leads.filter(lead => !lead.archived); }
  function allEvents() {
    const events = [];
    for (const lead of activeLeads()) {
      if (lead.nextContact) events.push({ id:`${lead.id}-follow`, leadId:lead.id, date:new Date(lead.nextContact), kind:"Seguimiento", channel:lead.nextChannel || "Llamada", delivery:false });
      if (lead.targetDate) events.push({ id:`${lead.id}-target`, leadId:lead.id, date:new Date(`${lead.targetDate}T12:00:00`), kind:"Cierre / entrega prevista", channel:"Operación", delivery:true });
      if (lead.operation === "Renta" && lead.rentStart) events.push({ id:`${lead.id}-rent-start`, leadId:lead.id, date:new Date(`${lead.rentStart}T12:00:00`), kind:"Inicio de renta", channel:"Renta", delivery:true });
      if (lead.operation === "Renta" && lead.rentEnd) events.push({ id:`${lead.id}-rent-end`, leadId:lead.id, date:new Date(`${lead.rentEnd}T12:00:00`), kind:"Fin de renta", channel:"Renta", delivery:true });
    }
    return events.filter(event => !Number.isNaN(event.date.getTime()));
  }
  function renderStats() {
    const active = activeLeads();
    const now = new Date();
    const today = startOfDay(now).getTime();
    const dueEvents = allEvents().filter(event => event.kind === "Seguimiento");
    $("statActive").textContent = active.length;
    $("statPending").textContent = dueEvents.length;
    $("statToday").textContent = dueEvents.filter(event => startOfDay(event.date).getTime() === today).length;
    $("statDelivery").textContent = allEvents().filter(event => event.delivery && event.date.getTime() >= today && event.date.getTime() < today + 30 * 86400000).length;
  }
  function renderLeads() {
    fillStageFilter();
    const query = $("searchInput").value.trim().toLowerCase();
    const op = $("operationFilter").value;
    const clientType = $("clientFilter").value;
    const stage = $("stageFilter").value;
    const records = activeLeads().filter(lead => {
      const searchable = [lead.name, lead.phone, lead.email, lead.zone, lead.comments, lead.source].join(" ").toLowerCase();
      return (!query || searchable.includes(query)) && (!op || lead.operation === op) && (!clientType || lead.clientType === clientType) && (!stage || lead.stage === stage);
    }).sort((a,b) => (a.nextContact || "9999").localeCompare(b.nextContact || "9999"));
    const list = $("leadList");
    $("emptyState").hidden = records.length > 0 || activeLeads().length > 0;
    list.innerHTML = records.map(lead => {
      const next = lead.nextContact ? localDateTime(lead.nextContact) : "Sin fecha";
      const target = lead.targetDate ? localDate(lead.targetDate) : "Sin fecha prevista";
      const tags = [lead.operation, lead.clientType, lead.propertyType].filter(Boolean).map(x => `<span class="pill">${esc(x)}</span>`).join("");
      const phone = whatsappNumber(lead.phone);
      return `<article class="lead-card" data-open="${esc(lead.id)}">
        <div class="lead-main"><h3>${esc(lead.name)}</h3><div>${tags}</div><div class="lead-meta">${esc(lead.zone || "Zona por definir")}${lead.zoneType ? ` · ${esc(lead.zoneType)}` : ""}</div></div>
        <div><div class="lead-label">Contacto</div><div class="lead-value">${esc(lead.phone || "Sin teléfono")}<br>${esc(lead.email || "Sin email")}</div></div>
        <div><div class="lead-label">Próximo seguimiento</div><div class="lead-value">${esc(next)}<br>${esc(lead.nextChannel || "Canal por definir")}</div></div>
        <div><div class="lead-label">Etapa · cierre</div><div class="lead-value"><select class="stage-select" data-stage-id="${esc(lead.id)}" aria-label="Etapa de ${esc(lead.name)}">${stagesFor(lead).map(s => `<option${s === lead.stage ? " selected" : ""}>${esc(s)}</option>`).join("")}</select><div class="lead-meta">Entrega: ${esc(target)}</div></div></div>
        <div class="lead-actions"><button class="small-action" data-edit="${esc(lead.id)}" aria-label="Editar ${esc(lead.name)}" title="Editar">✎</button>${phone ? `<a class="small-action whats" href="https://wa.me/${phone}" target="_blank" rel="noopener" aria-label="Abrir WhatsApp con ${esc(lead.name)}" title="WhatsApp">W</a>` : ""}</div>
      </article>`;
    }).join("");
    $("statActive").textContent = activeLeads().length;
    list.querySelectorAll("[data-edit]").forEach(button => button.addEventListener("click", event => { event.stopPropagation(); editLead(button.dataset.edit); }));
    list.querySelectorAll("[data-open]").forEach(card => card.addEventListener("click", event => { if (event.target.closest("button,a,select")) return; editLead(card.dataset.open); }));
    list.querySelectorAll("[data-stage-id]").forEach(select => select.addEventListener("change", async () => {
      const lead = leads.find(item => item.id === select.dataset.stageId);
      if (!lead) return;
      lead.stage = select.value; lead.updatedAt = new Date().toISOString();
      const saved = await putLead(lead); await refresh();
      if (!saved.synced) setStatus(saved.error ? `Cambio guardado localmente; falta sincronizar: ${saved.error.message}` : "Cambio guardado localmente; se sincronizará al reconectar.");
    }));
  }
  async function refresh() {
    try {
      let synced = false;
      if (currentUser) {
        try { synced = await syncWithCloud(); }
        catch (error) {
          const stored = await getAllLeads();
          leads = stored.filter(lead => !lead.ownerId || lead.ownerId === currentUser.id).map(lead => ({ ...lead, ownerId: currentUser.id }));
          setStatus(`No se pudo sincronizar: ${error.message}. Los datos locales se conservan.`);
        }
      } else {
        leads = [];
      }
      renderStats(); renderLeads(); renderCalendar();
      if (currentUser && synced) setStatus("Sincronizado con Supabase.");
      else if (currentUser && !navigator.onLine) setStatus("Sin conexión: los cambios quedan guardados aquí y se sincronizarán al reconectar.");
    } catch (error) { setStatus(error.message); }
  }

  function openNewLead(prefill = {}) {
    $("leadForm").reset(); $("leadId").value = ""; $("dialogTitle").textContent = "Nuevo contacto"; setFormError("");
    $("activityBox").hidden = true; $("activityHistory").innerHTML = "";
    $("startDate").value = toDateInput(new Date());
    $("nextChannel").value = "Llamada";
    $("source").value = prefill.source || "Captura manual";
    $("name").value = prefill.name || ""; $("phone").value = prefill.phone || ""; $("email").value = prefill.email || ""; $("budget").value = prefill.budget || "";
    $("comments").value = prefill.comments || "";
    if (prefill.operation) $("operation").value = prefill.operation;
    if (prefill.propertyType) $("propertyType").value = prefill.propertyType;
    if (prefill.creditType) $("creditType").value = prefill.creditType;
    if (prefill.clientType) $("clientType").value = prefill.clientType;
    fillStageOptions();
    $("leadDialog").showModal();
    if (prefill.name) $("clientType").focus(); else $("name").focus();
  }
  function editLead(id) {
    const lead = leads.find(item => item.id === id); if (!lead) return;
    $("leadForm").reset(); $("dialogTitle").textContent = "Editar contacto"; setFormError("");
    $("leadId").value = lead.id;
    for (const key of ["name","phone","email","clientType","operation","budget","creditType","propertyType","zoneType","zone","source","nextChannel","comments"]) {
      if ($(key)) $(key).value = lead[key] ?? "";
    }
    $("startDate").value = lead.startDate || ""; $("nextContact").value = toLocalDateTimeInput(lead.nextContact); $("targetDate").value = lead.targetDate || ""; $("rentStart").value = lead.rentStart || ""; $("rentEnd").value = lead.rentEnd || ""; $("waOptIn").checked = Boolean(lead.waOptIn);
    const activities = [...(lead.activities || [])].sort((a,b) => b.date.localeCompare(a.date));
    $("activityBox").hidden = activities.length === 0;
    $("activityHistory").innerHTML = activities.slice(0,12).map(item => `<div class="activity-row"><span>${esc(item.action)}</span><small>${esc(localDateTime(item.date))} · ${esc(item.channel || "")}</small></div>`).join("");
    fillStageOptions(lead.stage);
    $("leadDialog").showModal(); $("name").focus();
  }
  function readForm() {
    const old = leads.find(item => item.id === $("leadId").value);
    const now = new Date().toISOString();
    const clientType = $("clientType").value;
    return {
      id: old?.id || uuid(), name: $("name").value.trim(), phone: $("phone").value.trim(), email: $("email").value.trim(),
      clientType, operation: $("operation").value, budget: $("budget").value ? Number($("budget").value) : null,
      creditType: $("creditType").value, propertyType: $("propertyType").value, zoneType: $("zoneType").value,
      zone: $("zone").value.trim(), source: $("source").value, stage: $("stage").value,
      startDate: $("startDate").value || toDateInput(new Date()), nextContact: $("nextContact").value || "", nextChannel: $("nextChannel").value,
      targetDate: $("targetDate").value || "", rentStart: $("rentStart").value || "", rentEnd: $("rentEnd").value || "",
      comments: $("comments").value.trim(), waOptIn: $("waOptIn").checked, activities: old?.activities || [], lastContactAt: old?.lastContactAt || "", archived: false,
      createdAt: old?.createdAt || now, updatedAt: now
    };
  }
  function duplicateOf(lead) {
    const phone = phoneDigits(lead.phone), email = (lead.email || "").trim().toLowerCase();
    if (!phone && !email) return null;
    return leads.find(item => item.id !== lead.id && !item.archived && ((phone && phoneDigits(item.phone) === phone) || (email && item.email?.trim().toLowerCase() === email))) || null;
  }
  $("leadForm").addEventListener("submit", async event => {
    event.preventDefault(); setFormError("");
    const lead = readForm();
    if (!lead.name || !lead.clientType || !lead.operation) { setFormError("Completa nombre, tipo de cliente y tipo de operación."); return; }
    if (lead.rentStart && lead.rentEnd && lead.rentEnd < lead.rentStart) { setFormError("El fin de renta no puede ser anterior al inicio."); return; }
    const duplicate = duplicateOf(lead);
    if (duplicate) { setFormError(`Ya existe un contacto con ese teléfono o email: ${duplicate.name}. Busca y edita esa ficha para evitar duplicarlo.`); return; }
    try {
      const saved = await putLead(lead);
      $("leadDialog").close(); await refresh();
      if (!saved.synced) setStatus(saved.error ? `Contacto guardado localmente; falta sincronizar: ${saved.error.message}` : "Contacto guardado localmente; se sincronizará al reconectar.");
    } catch (error) { setFormError(error.message); }
  });
  async function archiveLead(id) {
    const lead = leads.find(item => item.id === id); if (!lead) return;
    lead.archived = true; lead.updatedAt = new Date().toISOString();
    const saved = await putLead(lead); await refresh();
    if (!saved.synced) setStatus(saved.error ? `Archivado localmente; falta sincronizar: ${saved.error.message}` : "Archivado localmente; se sincronizará al reconectar.");
  }

  function extractHints(text) {
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const email = (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [""])[0];
    const phoneMatches = text.match(/(?:\+?52[\s-]?)?(?:\(?\d{2,3}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{4}/g) || [];
    const phone = phoneMatches.map(value => value.trim()).find(value => phoneDigits(value).length >= 10) || "";
    const moneyMatch = text.match(/(?:\$\s*|(?:presupuesto|cr[eé]dito|monto|inversi[oó]n)\s*(?:de|aprox\.?|:)?\s*)(\d[\d,. \t]{3,}\d)(?:\s*(?:MXN|pesos))?/i);
    let budget = moneyMatch ? moneyMatch[1].replace(/[\s,]/g, "") : "";
    const skip = /^(hola|buenas|buenos|qué tal|que tal|me interesa|está disponible|esta disponible|disponible|facebook|messenger|marketplace|whatsapp|mensaje|llamada|hoy|ayer|mañana|manana)$/i;
    const labeledName = (text.match(/(?:nombre|cliente)\s*[:\-]\s*([^\n]+)/i) || ["", ""])[1].trim();
    let name = labeledName || lines.find(line => /^[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){1,3}$/.test(line) && !skip.test(line)) || "";
    const lower = text.toLowerCase();
    const operation = /\b(renta|rentar|alquiler|rent(o|ar))\b/.test(lower) ? "Renta" : /\b(vendo|venta|vender)\b/.test(lower) ? "Venta" : /\b(aportaci[oó]n|aportante|invertir|inversionista)\b/.test(lower) ? "Aportación" : /\b(comprar|compra|busco|interesa)\b/.test(lower) ? "Compra" : "";
    const propertyType = /departamento|depa|condominio/.test(lower) ? "Departamento" : /hect[aá]rea/.test(lower) ? "Hectárea" : /terreno|lote/.test(lower) ? "Terreno" : /casa/.test(lower) ? "Casa" : "";
    const creditType = /fovissste/.test(lower) ? "FOVISSSTE" : /infonavit/.test(lower) ? "Infonavit" : /bancari[oa]|hipoteca/.test(lower) ? "Bancario" : /contado|recursos propios/.test(lower) ? "Recursos propios" : "";
    const clientType = /busco\s+(?:una\s+)?renta|buscando\s+(?:una\s+)?renta|rentar\s+(?:una\s+)?casa/.test(lower) ? "Busca renta" : /ofrezco\s+(?:en\s+)?renta|rento\s+(?:mi|una)?\s*(?:casa|departamento|propiedad)/.test(lower) ? "Ofrece renta" : /vendo\s+(?:mi\s+)?(?:casa|departamento|propiedad)|propietari[oa].*venta/.test(lower) ? "Propietario vendedor" : /aportante|inversionista|invertir/.test(lower) ? "Aportante o inversionista" : /comprar|busco|interesa/.test(lower) ? "Comprador" : "";
    return { name, phone, email, budget, operation, propertyType, creditType, clientType };
  }
  $("captureBtn").addEventListener("click", () => $("captureDialog").showModal());
  function drawCaptureImage() {
    if (!currentImage) return;
    const sourceWidth = currentImage.naturalWidth;
    const sourceHeight = currentImage.naturalHeight;
    const scale = Math.min(1, 2400 / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const sideways = captureRotation % 180 !== 0;
    captureCanvas.width = sideways ? height : width;
    captureCanvas.height = sideways ? width : height;
    captureSelectionCanvas.width = captureCanvas.width;
    captureSelectionCanvas.height = captureCanvas.height;
    captureContext.clearRect(0, 0, captureCanvas.width, captureCanvas.height);
    captureContext.save();
    if (captureRotation === 90) { captureContext.translate(captureCanvas.width, 0); captureContext.rotate(Math.PI / 2); }
    else if (captureRotation === 180) { captureContext.translate(captureCanvas.width, captureCanvas.height); captureContext.rotate(Math.PI); }
    else if (captureRotation === 270) { captureContext.translate(0, captureCanvas.height); captureContext.rotate(-Math.PI / 2); }
    captureContext.drawImage(currentImage, 0, 0, width, height);
    captureContext.restore();
    applyCaptureZoom();
    drawCaptureSelections();
  }
  function applyCaptureZoom() {
    captureCanvas.style.width = `${captureZoom * 100}%`;
    captureSelectionCanvas.style.width = `${captureZoom * 100}%`;
    $("captureZoomLabel").textContent = captureZoom === 1 ? "Ajustar" : `${Math.round(captureZoom * 100)}%`;
    const active = Boolean(currentImage);
    ["zoomOutCapture", "zoomInCapture", "resetZoomCapture"].forEach(id => { $(id).disabled = !active; });
  }
  function changeCaptureZoom(amount) {
    captureZoom = Math.max(1, Math.min(4, Math.round((captureZoom + amount) * 100) / 100));
    applyCaptureZoom();
  }
  $("zoomInCapture").addEventListener("click", () => changeCaptureZoom(.25));
  $("zoomOutCapture").addEventListener("click", () => changeCaptureZoom(-.25));
  $("resetZoomCapture").addEventListener("click", () => { captureZoom = 1; applyCaptureZoom(); });
  $("rotateCapture").addEventListener("click", () => {
    captureRotation = (captureRotation + 90) % 360;
    captureSelections = [];
    drawCaptureImage();
    $("ocrStatus").textContent = "Foto girada. Selecciona una zona o lee la imagen completa.";
  });
  $("openCaptureFullscreen").addEventListener("click", () => {
    const dialog = $("captureDialog");
    const immersive = dialog.classList.toggle("capture-immersive");
    $("openCaptureFullscreen").textContent = immersive ? "Cerrar foto grande" : "Abrir foto grande";
    if (immersive) { captureZoom = 1; applyCaptureZoom(); }
  });
  $("toggleCapturePan").addEventListener("click", () => {
    capturePanMode = !capturePanMode;
    $("capturePreviewWrap").classList.toggle("capture-pan-mode", capturePanMode);
    $("toggleCapturePan").textContent = capturePanMode ? "Seleccionar texto" : "Mover foto";
    $("ocrStatus").textContent = capturePanMode ? "Modo mover: desplaza la foto con el dedo. Cuando llegues al texto, pulsa “Seleccionar texto”." : "Modo selección: arrastra una vez alrededor del texto que quieras leer.";
  });
  $("captureDialog").addEventListener("close", () => {
    $("captureDialog").classList.remove("capture-immersive");
    $("openCaptureFullscreen").textContent = "Abrir foto grande";
    capturePanMode = false;
    $("capturePreviewWrap").classList.remove("capture-pan-mode");
    $("toggleCapturePan").textContent = "Mover foto";
  });
  function capturePoint(event) {
    const bounds = captureSelectionCanvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(captureSelectionCanvas.width, (event.clientX - bounds.left) * captureSelectionCanvas.width / bounds.width)),
      y: Math.max(0, Math.min(captureSelectionCanvas.height, (event.clientY - bounds.top) * captureSelectionCanvas.height / bounds.height))
    };
  }
  function captureRect(a, b) {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
  }
  function drawCaptureSelections() {
    if (!captureSelectionCanvas) return;
    captureSelectionContext.clearRect(0, 0, captureSelectionCanvas.width, captureSelectionCanvas.height);
    captureSelectionContext.lineWidth = Math.max(2, captureSelectionCanvas.width / 500);
    for (const rect of captureSelections) {
      captureSelectionContext.fillStyle = "rgba(198,170,121,.2)";
      captureSelectionContext.strokeStyle = "#c6aa79";
      captureSelectionContext.fillRect(rect.x, rect.y, rect.w, rect.h);
      captureSelectionContext.strokeRect(rect.x, rect.y, rect.w, rect.h);
    }
    if (captureDrawing) {
      const rect = captureRect(captureDrawing.start, captureDrawing.end);
      captureSelectionContext.strokeStyle = "#d4af37";
      captureSelectionContext.strokeRect(rect.x, rect.y, rect.w, rect.h);
    }
    $("clearCaptureSelection").disabled = captureSelections.length === 0;
  }
  captureSelectionCanvas.addEventListener("pointerdown", event => {
    if (!currentImage || $("capturePreviewWrap").hidden || capturePanMode) return;
    event.preventDefault();
    captureSelections = [];
    captureSelectionCanvas.setPointerCapture(event.pointerId);
    captureDrawing = { start: capturePoint(event), end: capturePoint(event) };
    drawCaptureSelections();
  });
  captureSelectionCanvas.addEventListener("pointermove", event => {
    if (!captureDrawing) return;
    captureDrawing.end = capturePoint(event);
    drawCaptureSelections();
  });
  captureSelectionCanvas.addEventListener("pointerup", event => {
    if (!captureDrawing) return;
    captureDrawing.end = capturePoint(event);
    const rect = captureRect(captureDrawing.start, captureDrawing.end);
    captureDrawing = null;
    if (rect.w > 12 && rect.h > 8) captureSelections = [rect];
    drawCaptureSelections();
    $("ocrStatus").textContent = captureSelections.length
      ? "Zona seleccionada. Pulsa “Leer texto”; al marcar otra, se reemplazará esta selección."
      : "Arrastra sobre la foto para seleccionar texto, o lee la imagen completa.";
  });
  captureSelectionCanvas.addEventListener("pointercancel", () => { captureDrawing = null; drawCaptureSelections(); });
  $("clearCaptureSelection").addEventListener("click", () => {
    captureSelections = [];
    drawCaptureSelections();
    $("ocrStatus").textContent = "Selección limpiada. Se leerá la foto completa.";
  });
  function captureImageForOCR() {
    if (!captureSelections.length) return captureCanvas;
    const crops = captureSelections.map(rect => {
      const padX = Math.min(16, rect.w * .05), padY = Math.min(12, rect.h * .15);
      const x = Math.max(0, Math.floor(rect.x - padX)), y = Math.max(0, Math.floor(rect.y - padY));
      const width = Math.min(captureCanvas.width - x, Math.ceil(rect.w + padX * 2));
      const height = Math.min(captureCanvas.height - y, Math.ceil(rect.h + padY * 2));
      const scale = Math.min(3, 1800 / Math.max(width, height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext("2d");
      context.fillStyle = "white";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(captureCanvas, x, y, width, height, 0, 0, canvas.width, canvas.height);
      return canvas;
    });
    const margin = 12, width = Math.max(...crops.map(canvas => canvas.width));
    const height = crops.reduce((sum, canvas) => sum + canvas.height + margin, margin);
    const combined = document.createElement("canvas");
    combined.width = width + margin * 2; combined.height = height;
    const context = combined.getContext("2d");
    context.fillStyle = "white"; context.fillRect(0, 0, combined.width, combined.height);
    let y = margin;
    crops.forEach(canvas => { context.drawImage(canvas, margin, y); y += canvas.height + margin; });
    return combined;
  }
  $("captureFile").addEventListener("change", event => {
    const file = event.target.files?.[0]; if (!file) return;
    if (!file.type.startsWith("image/")) { $("ocrStatus").textContent = "Elige una imagen JPG, PNG o similar."; return; }
    if (currentImageUrl) URL.revokeObjectURL(currentImageUrl);
    currentImageUrl = URL.createObjectURL(file);
    captureSelections = [];
    captureRotation = 0;
    captureZoom = 1;
    capturePanMode = false;
    $("capturePreviewWrap").hidden = false;
    $("capturePreviewWrap").classList.remove("capture-pan-mode");
    $("rotateCapture").disabled = false;
    $("openCaptureFullscreen").disabled = false;
    $("toggleCapturePan").disabled = false;
    $("readImageBtn").disabled = true;
    $("ocrStatus").textContent = "Abriendo foto para mostrarla completa…";
    currentImage = new Image();
    currentImage.onload = () => {
      drawCaptureImage();
      $("readImageBtn").disabled = false;
      $("ocrStatus").textContent = `Foto lista: ${file.name}. Si aparece girada, pulsa “Girar 90°”.`;
    };
    currentImage.onerror = () => {
      currentImage = null;
      $("ocrStatus").textContent = "No se pudo mostrar esta imagen. Intenta guardarla como JPG o PNG y selecciónala de nuevo.";
    };
    currentImage.src = currentImageUrl;
  });
  $("readImageBtn").addEventListener("click", async () => {
    if (!currentImage) return;
    if (!window.Tesseract) { $("ocrStatus").textContent = "No se pudo cargar el lector OCR. Pega el texto manualmente o intenta más tarde."; return; }
    $("readImageBtn").disabled = true; $("ocrStatus").textContent = "Leyendo imagen en el navegador…";
    try {
      const ocrImage = prepareCaptureForOCR(captureImageForOCR());
      const result = await window.Tesseract.recognize(ocrImage, "spa", { logger: message => {
        if (message.status === "recognizing text" && Number.isFinite(message.progress)) $("ocrStatus").textContent = `Leyendo texto… ${Math.round(message.progress * 100)}%`;
      }});
      $("ocrText").value = result.data.text.trim();
      const count = $("ocrText").value.length;
      $("ocrStatus").textContent = count ? `Lectura terminada (${count} caracteres). Corrige el texto si hace falta.` : "No se encontró texto claro. Prueba con una imagen más nítida o pega el mensaje.";
    } catch (error) { $("ocrStatus").textContent = `No se pudo leer: ${error.message || "intenta con otra imagen"}. Puedes pegar el texto manualmente.`; }
    finally { $("readImageBtn").disabled = false; }
  });
  function prepareCaptureForOCR(source) {
    const scale = Math.min(2, 2600 / Math.max(source.width, source.height));
    const prepared = document.createElement("canvas");
    prepared.width = Math.max(1, Math.round(source.width * scale));
    prepared.height = Math.max(1, Math.round(source.height * scale));
    const context = prepared.getContext("2d", { willReadFrequently: true });
    context.drawImage(source, 0, 0, prepared.width, prepared.height);
    const pixels = context.getImageData(0, 0, prepared.width, prepared.height);
    for (let i = 0; i < pixels.data.length; i += 4) {
      const gray = Math.round(.299 * pixels.data[i] + .587 * pixels.data[i + 1] + .114 * pixels.data[i + 2]);
      const contrast = Math.max(0, Math.min(255, (gray - 128) * 1.45 + 128));
      pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = contrast;
    }
    context.putImageData(pixels, 0, 0);
    return prepared;
  }
  $("useCaptureBtn").addEventListener("click", () => {
    const text = $("ocrText").value.trim();
    if (!text) { $("ocrStatus").textContent = "Primero lee una imagen o pega el mensaje."; return; }
    const hints = extractHints(text);
    const sourceText = $("captureSource").value;
    const prefill = { ...hints, source: sourceText, comments: `Texto de la captura para revisar:\n${text}` };
    $("captureDialog").close(); openNewLead(prefill);
  });
  function receiveReaderCapture() {
    let capture;
    try {
      const saved = localStorage.getItem("crm_pending_capture_v1");
      if (!saved) return;
      capture = JSON.parse(saved);
    } catch (_) { return; }
    const text = String(capture?.texto || "").trim();
    if (!text) return;
    const source = String(capture.origen || "");
    if ([...$("captureSource").options].some(option => option.value === source || option.textContent === source)) {
      $("captureSource").value = source;
    }
    $("ocrText").value = text;
    $("capturePreviewWrap").hidden = true;
    $("ocrStatus").textContent = `Texto recibido del lector (${text.length} caracteres). Revísalo y pulsa “Usar texto para nuevo contacto”.`;
    localStorage.removeItem("crm_pending_capture_v1");
    if (!$("captureDialog").open) $("captureDialog").showModal();
  }

  function renderCalendar() {
    const monthLabel = visibleMonth.toLocaleDateString("es-MX", { month:"long", year:"numeric" });
    $("monthLabel").textContent = monthLabel;
    const first = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), 1);
    const offset = (first.getDay() + 6) % 7;
    const start = new Date(first); start.setDate(first.getDate() - offset);
    const events = allEvents();
    const today = toDateInput(startOfDay(new Date()));
    let html = "";
    for (let i=0; i<42; i++) {
      const date = new Date(start); date.setDate(start.getDate()+i);
      const key = toDateInput(date);
      const dayEvents = events.filter(event => toDateInput(startOfDay(event.date)) === key);
      const classes = ["day-cell", date.getMonth() !== visibleMonth.getMonth() ? "outside" : "", key === today ? "today" : "", key === toDateInput(selectedDay) ? "selected" : ""].filter(Boolean).join(" ");
      html += `<button type="button" class="${classes}" role="gridcell" data-day="${key}" aria-label="${esc(date.toLocaleDateString("es-MX", { dateStyle:"full" }))}, ${dayEvents.length} eventos"><span class="day-number">${date.getDate()}</span><span class="day-dots">${dayEvents.slice(0,5).map(event => `<i class="day-dot ${event.delivery ? "delivery" : ""}"></i>`).join("")}</span></button>`;
    }
    $("calendarGrid").innerHTML = html;
    $("calendarGrid").querySelectorAll("[data-day]").forEach(button => button.addEventListener("click", () => {
      const [year, month, day] = button.dataset.day.split("-").map(Number);
      selectedDay = new Date(year, month-1, day); visibleMonth = new Date(year, month-1, 1); renderCalendar();
    }));
    renderAgenda(events);
  }
  function renderAgenda(events = allEvents()) {
    const key = toDateInput(selectedDay);
    $("selectedDateLabel").textContent = selectedDay.toLocaleDateString("es-MX", { weekday:"long", day:"numeric", month:"long", year:"numeric" });
    const dayEvents = events.filter(event => toDateInput(startOfDay(event.date)) === key).sort((a,b) => a.date - b.date);
    $("dayAgenda").innerHTML = dayEvents.length ? dayEvents.map(event => {
      const lead = leads.find(item => item.id === event.leadId); if (!lead) return "";
      const dt = event.kind === "Seguimiento" ? event.date.toLocaleTimeString("es-MX", { hour:"2-digit", minute:"2-digit" }) : "Todo el día";
      return `<article class="agenda-item"><div><strong>${esc(dt)} · ${esc(event.kind)}</strong><small>${esc(lead.name)} · ${esc(event.channel)}${lead.zone ? ` · ${esc(lead.zone)}` : ""}</small></div><div class="agenda-actions"><button type="button" data-ics="${esc(event.id)}" class="agenda-link">.ics</button>${event.kind === "Seguimiento" ? `<button type="button" data-done="${esc(event.leadId)}" class="agenda-link">Listo</button>` : ""}<button type="button" data-agenda-edit="${esc(lead.id)}" class="agenda-link">Abrir ficha</button></div></article>`;
    }).join("") : `<p class="no-agenda">No hay actividades para este día.</p>`;
    $("dayAgenda").querySelectorAll("[data-agenda-edit]").forEach(button => button.addEventListener("click", () => editLead(button.dataset.agendaEdit)));
    $("dayAgenda").querySelectorAll("[data-ics]").forEach(button => button.addEventListener("click", () => downloadICS(events.find(event => event.id === button.dataset.ics))));
    $("dayAgenda").querySelectorAll("[data-done]").forEach(button => button.addEventListener("click", async () => {
      const lead = leads.find(item => item.id === button.dataset.done);
      if (!lead) return;
      lead.lastContactAt = new Date().toISOString();
      lead.activities = [...(lead.activities || []), { date: lead.lastContactAt, channel: lead.nextChannel || "Llamada", action: "Seguimiento completado" }];
      lead.nextContact = "";
      const saved = await putLead(lead); await refresh();
      if (!saved.synced) setStatus(saved.error ? `Seguimiento guardado localmente; falta sincronizar: ${saved.error.message}` : "Seguimiento guardado localmente; se sincronizará al reconectar.");
    }));
  }
  function downloadICS(event) {
    if (!event) return;
    const lead = leads.find(item => item.id === event.leadId); if (!lead) return;
    const start = event.date;
    const allDay = event.kind !== "Seguimiento";
    const end = allDay ? new Date(start.getTime() + 86400000) : new Date(start.getTime() + 30 * 60000);
    const stamp = date => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const escape = value => String(value).replace(/\\/g,"\\\\").replace(/\n/g,"\\n").replace(/,/g,"\\,").replace(/;/g,"\\;");
    const dateLine = allDay ? `DTSTART;VALUE=DATE:${toDateInput(start).replace(/-/g,"")}\r\nDTEND;VALUE=DATE:${toDateInput(end).replace(/-/g,"")}` : `DTSTART:${stamp(start)}\r\nDTEND:${stamp(end)}`;
    const body = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Torrez y Maldonado//CRM//ES\r\nBEGIN:VEVENT\r\nUID:${esc(event.id)}@torrez-maldonado-crm\r\nDTSTAMP:${stamp(new Date())}\r\n${dateLine}\r\nSUMMARY:${escape(`${event.kind}: ${lead.name}`)}\r\nDESCRIPTION:${escape(`${lead.phone || ""} · ${event.channel} · ${lead.zone || ""}`)}\r\nEND:VEVENT\r\nEND:VCALENDAR`;
    const blob = new Blob([body], { type:"text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href=url; link.download=`recordatorio-${toDateInput(start)}.ics`; link.click(); URL.revokeObjectURL(url);
  }
  $("prevMonth").addEventListener("click", () => { visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth()-1, 1); renderCalendar(); });
  $("nextMonth").addEventListener("click", () => { visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth()+1, 1); renderCalendar(); });
  $("todayBtn").addEventListener("click", () => { selectedDay = startOfDay(new Date()); visibleMonth = new Date(selectedDay.getFullYear(), selectedDay.getMonth(), 1); renderCalendar(); });
  $("whatsReminderBtn").addEventListener("click", () => {
    const items = allEvents().filter(event => toDateInput(startOfDay(event.date)) === toDateInput(selectedDay)).sort((a,b) => a.date-b.date);
    const text = items.length ? `Recordatorios CRM para ${selectedDay.toLocaleDateString("es-MX", { day:"numeric", month:"long" })}:\n` + items.map(event => {
      const lead = leads.find(item => item.id === event.leadId); const time = event.kind === "Seguimiento" ? event.date.toLocaleTimeString("es-MX", { hour:"2-digit", minute:"2-digit" }) : "";
      return `• ${time} ${event.kind}: ${lead?.name || ""} (${lead?.phone || "sin teléfono"})`;
    }).join("\n") : `No tienes seguimientos agendados para ${selectedDay.toLocaleDateString("es-MX", { day:"numeric", month:"long" })}.`;
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener");
  });

  $("newBtn").addEventListener("click", () => openNewLead());
  $("emptyNewBtn").addEventListener("click", () => openNewLead());
  $("clientType").addEventListener("change", () => fillStageOptions());
  $("operation").addEventListener("change", () => { const rent = $("operation").value === "Renta"; $("rentStart").closest("label").style.opacity = rent ? "1" : ".65"; $("rentEnd").closest("label").style.opacity = rent ? "1" : ".65"; });
  document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => $(button.dataset.close).close()));
  document.querySelectorAll(".tab").forEach(button => button.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(tab => tab.classList.toggle("active", tab === button));
    const calendar = button.dataset.view === "calendar";
    $("leadsView").hidden = calendar; $("calendarView").hidden = !calendar;
    $("leadsView").classList.toggle("active", !calendar); $("calendarView").classList.toggle("active", calendar);
    if (calendar) renderCalendar();
  }));
  ["searchInput","operationFilter","clientFilter","stageFilter"].forEach(id => $(id).addEventListener("input", renderLeads));
  $("exportBtn").addEventListener("click", async () => {
    const data = { version:1, exportedAt:new Date().toISOString(), leads };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type:"application/json" });
    const url = URL.createObjectURL(blob); const link=document.createElement("a"); link.href=url; link.download=`respaldo-crm-${toDateInput(new Date())}.json`; link.click(); URL.revokeObjectURL(url); setStatus("Respaldo descargado.");
  });
  $("importFile").addEventListener("change", async event => {
    const file = event.target.files?.[0]; if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const rows = Array.isArray(parsed) ? parsed : parsed.leads;
      if (!Array.isArray(rows)) throw new Error("El archivo no contiene una lista de contactos.");
      const records = rows.filter(row => row && row.name).map(row => ({ ...row, id:isUuid(row.id) ? row.id : uuid(), createdAt:row.createdAt || new Date().toISOString(), updatedAt:new Date().toISOString() }));
      await putMany(records); await refresh(); setStatus(`Respaldo importado: ${records.length} contactos.`);
    } catch (error) { setStatus(`No se pudo importar: ${error.message}`); }
    finally { event.target.value=""; }
  });
  $("captureSource").addEventListener("change", () => { $("source").value = $("captureSource").value; });
  $("authModeToggle").addEventListener("click", () => { activeAuthMode = activeAuthMode === "login" ? "signup" : "login"; showAuthMode(); });
  $("authForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (!supabaseClient) { $("authStatus").textContent = "La conexión aún no está lista. Recarga la página e inténtalo de nuevo."; return; }
    const email = $("authEmail").value.trim();
    const password = $("authPassword").value;
    const button = $("authSubmit"); button.disabled = true;
    $("authStatus").textContent = activeAuthMode === "signup" ? "Creando tu acceso…" : "Iniciando sesión…";
    try {
      if (activeAuthMode === "signup") {
        const redirectTo = `${window.location.origin}${window.location.pathname}`;
        const { data, error } = await supabaseClient.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo } });
        if (error) throw error;
        if (data.session) await updateAuthView(data.session);
        else $("authStatus").textContent = "Acceso creado. Revisa ese correo y confirma la dirección para iniciar sesión.";
      } else {
        const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) throw error;
        await updateAuthView(data.session);
      }
    } catch (error) { $("authStatus").textContent = error.message || "No se pudo completar el acceso."; }
    finally { button.disabled = false; }
  });
  $("logoutBtn").addEventListener("click", async () => {
    if (!supabaseClient) return;
    const { error } = await supabaseClient.auth.signOut();
    if (error) setStatus(`No se pudo cerrar sesión: ${error.message}`);
  });
  window.addEventListener("online", () => { if (currentUser) void refresh(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && currentUser) void refresh(); });

  let installPromptEvent = null;
  const installButton = $("installBtn");
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  if (isStandalone) installButton.hidden = true;
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    installPromptEvent = event;
    installButton.hidden = false;
  });
  window.addEventListener("appinstalled", () => {
    installPromptEvent = null;
    installButton.hidden = true;
    setStatus("Aplicación instalada en este dispositivo.");
  });
  installButton.addEventListener("click", async () => {
    if (installPromptEvent) {
      installPromptEvent.prompt();
      const choice = await installPromptEvent.userChoice;
      installPromptEvent = null;
      if (choice.outcome === "accepted") setStatus("Instalación iniciada.");
      return;
    }
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const instructions = isIOS
      ? "En Safari, toca Compartir y luego ‘Añadir a pantalla de inicio’."
      : "Abre esta página en Chrome o Edge y usa el menú del navegador: ‘Instalar aplicación’ o ‘Añadir a pantalla de inicio’.";
    window.alert(instructions);
  });

  showAuthMode();
  void initializeSupabase();
})();
