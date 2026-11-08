(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const CLIENT_STAGES = ["Interés", "Selección", "Trámite", "Entrega"];
  const PROPERTY_STAGES = ["Revisión", "Aceptación y firma del convenio de promoción y comisión", "Promoción", "Entrega"];
  const DB_NAME = "torrez-maldonado-crm";
  const DB_VERSION = 2;
  const CLOUD_TABLE = "crm_leads";
  const PROPERTIES_TABLE = "crm_properties";
  const PHOTO_BUCKET = "crm-property-photos";
  let supabaseClient = null;
  let currentUser = null;
  let activeAuthMode = "login";
  let appliedAuthUserId = null;
  let dbPromise;
  let leads = [];
  let properties = [];
  let currentSection = "properties";
  let propertyOperationFilter = "";
  let propertyTypeFilter = "";
  let propertyPhotoDataUrl = "";
  let propertyPhotoCache = new Map();
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
        if (!database.objectStoreNames.contains("properties")) database.createObjectStore("properties", { keyPath: "id" });
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
  async function getAllProperties() {
    const database = await openDB();
    return new Promise((resolve, reject) => {
      const request = database.transaction("properties", "readonly").objectStore("properties").getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }
  async function saveLocalProperty(property) {
    const database = await openDB();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("properties", "readwrite");
      transaction.objectStore("properties").put(property);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("No se pudo guardar la propiedad."));
    });
  }
  async function putManyProperties(records) {
    const database = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction("properties", "readwrite");
      const store = transaction.objectStore("properties");
      records.forEach(record => store.put(record));
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("No se pudieron guardar las propiedades."));
    });
  }
  // Solo se envían automáticamente cambios hechos explícitamente en este dispositivo.
  // Un registro antiguo ausente de Supabase nunca debe recrearse por accidente.
  const DIRTY_PREFIX = "crm-pending-v1:";
  function dirtyKey(table) { return DIRTY_PREFIX + (currentUser?.id || "anonymous") + ":" + table; }
  function dirtyIds(table) {
    try { return new Set(JSON.parse(localStorage.getItem(dirtyKey(table)) || "[]")); }
    catch (_) { return new Set(); }
  }
  function markDirty(table,id) { const ids=dirtyIds(table); ids.add(id); localStorage.setItem(dirtyKey(table),JSON.stringify([...ids])); }
  function clearDirty(table,id) { const ids=dirtyIds(table); ids.delete(id); localStorage.setItem(dirtyKey(table),JSON.stringify([...ids])); }
  async function reconcileLocalStore(storeName, stored, cloudRows, dirty) {
    const database=await openDB();
    await new Promise((resolve,reject)=>{
      const transaction=database.transaction(storeName,"readwrite");
      const store=transaction.objectStore(storeName);
      const cloudIds=new Set(cloudRows.map(item=>item.id));
      for (const item of stored) {
        if (item.ownerId && item.ownerId!==currentUser.id) continue;
        // Conservamos copias antiguas ausentes de la nube, por seguridad,
        // pero no las re-publicamos ni las mostramos como registros activos.
        if (cloudIds.has(item.id)) continue;
        if (dirty.has(item.id)) continue;
        // No borrar aquí: un registro anterior podría contener cambios locales sin respaldo.
      }
      for (const item of cloudRows) store.put(item);
      transaction.oncomplete=resolve;
      transaction.onerror=()=>reject(transaction.error || new Error("Error al actualizar la copia local"));
    });
  }
  async function putLead(lead) {
    if (currentUser) lead.ownerId = currentUser.id;
    markDirty(CLOUD_TABLE, lead.id);
    const database = await openDB();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("leads", "readwrite");
      transaction.objectStore("leads").put(lead);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("No se pudo guardar el contacto."));
    });
    if (!currentUser || !navigator.onLine) return { synced: false };
    try {
      const { error } = await supabaseClient.from(CLOUD_TABLE).upsert(toDatabaseLead(lead), { onConflict: "id" });
      if (!error) clearDirty(CLOUD_TABLE,lead.id);
      return error ? { synced: false, error } : { synced: true };
    } catch (error) { return { synced: false, error }; }
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
  // Normaliza los tipos de crédito antes de enviarlos a Supabase.
  function normalizeCreditType(value) {
    const original = String(value ?? "").trim();
    const normalized = original.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const options = {
      "": "",
      "no aplica": "",
      "ninguno": "",
      "sin credito": "",
      "sin definir": "",
      "infonavit": "Infonavit",
      "fovissste": "FOVISSSTE",
      "bancario": "Bancario",
      "credito bancario": "Bancario",
      "recursos propios": "Recursos propios",
      "propios": "Recursos propios",
      "contado": "Recursos propios"
    };
    if (!Object.prototype.hasOwnProperty.call(options, normalized)) {
      throw new Error(`Tipo de crédito no reconocido: ${original}. Revisa la ficha del contacto.`);
    }
    return options[normalized];
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
      credit_type: normalizeCreditType(lead.creditType),
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
  function toDatabaseProperty(property) {
    return {
      id: property.id,
      owner_id: currentUser.id,
      title: property.title,
      operation: property.operation,
      property_type: property.propertyType,
      price: Number(property.price) || 0,
      surface: property.surface === "" ? null : Number(property.surface),
      surface_unit: property.surfaceUnit || "m²",
      zone: property.zone || "",
      address: property.address || "",
      owner_lead_id: property.ownerLeadId || null,
      status: property.status || "En revisión",
      title_reviewed: Boolean(property.titleReviewed),
      agreement_signed: Boolean(property.agreementSigned),
      photo_path: property.photoPath || null,
      description: property.description || "",
      archived: Boolean(property.archived),
      created_at: property.createdAt || new Date().toISOString(),
      updated_at: property.updatedAt || new Date().toISOString()
    };
  }
  function fromDatabaseProperty(row) {
    return {
      id: row.id, ownerId: row.owner_id, title: row.title || "", operation: row.operation,
      propertyType: row.property_type || "Casa", price: Number(row.price) || 0,
      surface: row.surface == null ? "" : String(row.surface), surfaceUnit: row.surface_unit || "m²",
      zone: row.zone || "", address: row.address || "", ownerLeadId: row.owner_lead_id || "",
      status: row.status || "Revisión", titleReviewed:Boolean(row.title_reviewed), agreementSigned:Boolean(row.agreement_signed),
      photoPath: row.photo_path || "", photoDataUrl: "",
      description: row.description || "", archived: Boolean(row.archived),
      createdAt: row.created_at, updatedAt: row.updated_at
    };
  }
  async function uploadPropertyPhoto(property) {
    if (!property.photoDataUrl || !currentUser) return property;
    const blob = await fetch(property.photoDataUrl).then(response => response.blob());
    const path = `${currentUser.id}/${property.id}.jpg`;
    const { error } = await supabaseClient.storage.from(PHOTO_BUCKET).upload(path, blob, { upsert:true, contentType:"image/jpeg", cacheControl:"3600" });
    if (error) throw error;
    property.photoPath = path;
    return property;
  }
  async function putProperty(property) {
    if (currentUser) property.ownerId = currentUser.id;
    property.updatedAt = new Date().toISOString();
    markDirty(PROPERTIES_TABLE,property.id);
    await saveLocalProperty(property);
    if (!currentUser || !navigator.onLine) return { synced:false };
    try {
      if (property.ownerLeadId) {
        const owner = leads.find(item => item.id === property.ownerLeadId);
        if (!owner) throw new Error("El propietario vinculado no existe en tus contactos.");
        const { error: ownerError } = await supabaseClient.from(CLOUD_TABLE).upsert(toDatabaseLead(owner), { onConflict:"id" });
        if (ownerError) throw new Error(`No se pudo sincronizar primero al propietario: ${ownerError.message}`);
      }
      await uploadPropertyPhoto(property);
      await saveLocalProperty(property);
      const { error } = await supabaseClient.from(PROPERTIES_TABLE).upsert(toDatabaseProperty(property), { onConflict:"id" });
      if (error) throw error;
      clearDirty(PROPERTIES_TABLE,property.id);
      return { synced:true };
    } catch (error) { return { synced:false, error }; }
  }
  async function signedPropertyPhoto(property) {
    if (property.photoDataUrl) return property.photoDataUrl;
    if (!property.photoPath || !supabaseClient) return "";
    const cached = propertyPhotoCache.get(property.photoPath);
    if (cached && cached.expires > Date.now()) return cached.url;
    const { data, error } = await supabaseClient.storage.from(PHOTO_BUCKET).createSignedUrl(property.photoPath, 3600);
    if (error) return "";
    propertyPhotoCache.set(property.photoPath, { url:data.signedUrl, expires:Date.now()+3500000 });
    return data.signedUrl;
  }
  async function syncPropertiesWithCloud() {
    const stored=await getAllProperties();
    const local=stored.filter(item=>!item.ownerId || item.ownerId===currentUser.id);
    if (!navigator.onLine) { properties=local; return false; }
    const {data:initialRows,error:initialError}=await supabaseClient.from(PROPERTIES_TABLE).select("*");
    if (initialError) throw initialError;
    const cloudById=new Map((initialRows||[]).map(row=>[row.id,fromDatabaseProperty(row)]));
    const dirty=dirtyIds(PROPERTIES_TABLE);
    const pending=local.filter(item=>dirty.has(item.id));
    for (const property of pending) {
      // Si alguien eliminó este registro en otro dispositivo y aquí fue editado,
      // evitamos recrearlo automáticamente: requiere revisión manual.
      if (!cloudById.has(property.id) && property.createdAt &&
          recordTime(property.createdAt)<recordTime(property.updatedAt)-1000) {
        throw new Error("Hay una propiedad modificada localmente que ya no está en la nube. Revisa antes de recuperarla.");
      }
      await uploadPropertyPhoto(property);
      const {error}=await supabaseClient.from(PROPERTIES_TABLE).upsert(toDatabaseProperty(property),{onConflict:"id"});
      if (error) throw error;
      clearDirty(PROPERTIES_TABLE,property.id);
    }
    const {data:finalRows,error:finalError}=await supabaseClient.from(PROPERTIES_TABLE).select("*").order("updated_at",{ascending:false});
    if (finalError) throw finalError;
    const synced=(finalRows||[]).map(fromDatabaseProperty);
    await reconcileLocalStore("properties",stored,synced,dirtyIds(PROPERTIES_TABLE));
    properties=synced;
    return true;
  }
  function recordTime(value) { const time = Date.parse(value || ""); return Number.isFinite(time) ? time : 0; }
  async function syncWithCloud() {
    const stored=await getAllLeads();
    const local=stored.filter(item=>!item.ownerId || item.ownerId===currentUser.id);
    if (!navigator.onLine) {
      leads=local;
      properties=(await getAllProperties()).filter(item=>!item.ownerId || item.ownerId===currentUser.id);
      return false;
    }
    const {data:initialRows,error:initialError}=await supabaseClient.from(CLOUD_TABLE).select("*");
    if (initialError) throw initialError;
    const cloudById=new Map((initialRows||[]).map(row=>[row.id,fromDatabaseLead(row)]));
    const dirty=dirtyIds(CLOUD_TABLE);
    const pending=local.filter(item=>dirty.has(item.id));
    for (const lead of pending) {
      if (!cloudById.has(lead.id) && lead.createdAt &&
          recordTime(lead.createdAt)<recordTime(lead.updatedAt)-1000) {
        throw new Error("Un contacto editado aquí ya no está en Supabase. Revisa la eliminación antes de recuperarlo.");
      }
      const {error}=await supabaseClient.from(CLOUD_TABLE).upsert(toDatabaseLead(lead),{onConflict:"id"});
      if (error) throw error;
      clearDirty(CLOUD_TABLE,lead.id);
    }
    const {data:finalRows,error:finalError}=await supabaseClient.from(CLOUD_TABLE).select("*").order("updated_at",{ascending:false});
    if (finalError) throw finalError;
    const synced=(finalRows||[]).map(fromDatabaseLead);
    await reconcileLocalStore("leads",stored,synced,dirtyIds(CLOUD_TABLE));
    leads=synced;
    try { await syncPropertiesWithCloud(); }
    catch (error) {
      properties=(await getAllProperties()).filter(item=>!item.ownerId || item.ownerId===currentUser.id);
      setStatus(`Contactos sincronizados, pero PROPIEDADES NO: ${error.message}`);
      return false;
    }
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
      updateReaderPendingNotice();
    } else {
      leads = [];
      properties = []; renderStats(); renderLeads(); void renderProperties(); renderCalendar(); renderReminders();
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
    const stage = $("stageFilter").value;
    const config = {
      buyers:{ title:"Compradores", eyebrow:"DIRECTORIO DE COMPRADORES", types:["Comprador"], button:"+ Agregar comprador", defaultType:"Comprador" },
      sellers:{ title:"Propietarios", eyebrow:"PROPIETARIOS · VENTA Y RENTA", types:["Propietario vendedor","Ofrece renta"], button:"+ Agregar propietario", defaultType:"Propietario vendedor" },
      renters:{ title:"Buscan renta", eyebrow:"PROSPECTOS DE ARRENDAMIENTO", types:["Busca renta"], button:"+ Agregar interesado", defaultType:"Busca renta" },
      investors:{ title:"Inversionistas", eyebrow:"APORTANTES Y SOCIOS", types:["Aportante o inversionista"], button:"+ Agregar inversionista", defaultType:"Aportante o inversionista" }
    }[currentSection] || { title:"Compradores", eyebrow:"DIRECTORIO DE COMPRADORES", types:["Comprador","Busca renta"], button:"+ Agregar comprador", defaultType:"Comprador" };
    $("directoryTitle").textContent = config.title;
    $("directoryEyebrow").textContent = config.eyebrow;
    $("newClientInSectionBtn").textContent = config.button;
    $("newBtn").hidden = true;
    $("newPropertyBtn").hidden = true;
    $("newClientInSectionBtn").hidden = currentSection === "properties" || currentSection === "calendar";
    const records = activeLeads().filter(lead => {
      const searchable = [lead.name, lead.phone, lead.email, lead.zone, lead.comments, lead.source].join(" ").toLowerCase();
      return config.types.includes(lead.clientType) && (!query || searchable.includes(query)) && (!op || lead.operation === op) && (!stage || lead.stage === stage);
    }).sort((a,b) => (a.name || "").localeCompare(b.name || "", "es"));
    const list = $("leadList");
    $("emptyState").hidden = records.length > 0;
    $("emptyState").querySelector("h3").textContent = `Aún no hay ${config.title.toLowerCase()} en esta sección`;
    $("emptyState").querySelector("p").textContent = "Agrega una ficha o ajusta la búsqueda para ver registros.";
    list.innerHTML = records.map(lead => {
      const next = lead.nextContact ? localDateTime(lead.nextContact) : "Sin fecha";
      const target = lead.targetDate ? localDate(lead.targetDate) : "Sin fecha prevista";
      const tags = [lead.operation, lead.clientType, lead.propertyType].filter(Boolean).map(x => `<span class="pill">${esc(x)}</span>`).join("");
      const phone = whatsappNumber(lead.phone);
      const credit = [lead.creditType, lead.budget ? moneyMXN(lead.budget) : ""].filter(Boolean).join(" · ") || "Sin definir";
      return `<article class="lead-card" data-open="${esc(lead.id)}">
        <div class="lead-main"><h3>${esc(lead.name)}</h3><div>${tags}</div><div class="lead-meta">${esc(lead.zone || "Zona por definir")}${lead.zoneType ? ` · ${esc(lead.zoneType)}` : ""}</div></div>
        <div><div class="lead-label">Contacto</div><div class="lead-value">${esc(lead.phone || "Sin teléfono")}<br>${esc(lead.email || "Sin email")}</div></div>
        <div><div class="lead-label">Crédito · monto</div><div class="lead-value">${esc(credit)}</div></div>
        <div><div class="lead-label">Próximo seguimiento</div><div class="lead-value">${esc(next)}<br>${esc(lead.nextChannel || "Canal por definir")}</div></div>
        <div><div class="lead-label">Etapa · cierre</div><div class="lead-value"><select class="stage-select" data-stage-id="${esc(lead.id)}" aria-label="Etapa de ${esc(lead.name)}">${stagesFor(lead).map(s => `<option${s === lead.stage ? " selected" : ""}>${esc(s)}</option>`).join("")}</select><div class="lead-meta">Entrega: ${esc(target)}</div></div></div>
        <div class="lead-actions"><button class="small-action" data-edit="${esc(lead.id)}" aria-label="Editar ${esc(lead.name)}" title="Editar">✎</button>${phone ? `<a class="small-action whats" href="https://wa.me/${phone}" target="_blank" rel="noopener" aria-label="Abrir WhatsApp con ${esc(lead.name)}" title="WhatsApp">W</a>` : ""}</div>
      </article>`;
    }).join("");
    applyStackOrder();
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
  function moneyMXN(value) {
    return new Intl.NumberFormat("es-MX", { style:"currency", currency:"MXN", maximumFractionDigits:0 }).format(Number(value) || 0);
  }
  async function renderProperties() {
    const query = $("propertySearch").value.trim().toLowerCase();
    const records = properties.filter(property => !property.archived && (!propertyOperationFilter || property.operation === propertyOperationFilter) &&
      (!propertyTypeFilter || property.propertyType === propertyTypeFilter) &&
      (!query || [property.title, property.zone, property.address, property.description, ownerName(property.ownerLeadId)].join(" ").toLowerCase().includes(query)))
      .sort((a,b) => (a.title || "").localeCompare(b.title || "", "es"));
    $("propertyList").innerHTML = "";
    $("emptyPropertyState").hidden = records.length > 0;
    const cards = await Promise.all(records.map(async property => {
      const photo = await signedPropertyPhoto(property);
      const image = photo ? `<img src="${esc(photo)}" alt="Foto de ${esc(property.title)}" loading="lazy">` : `<div class="property-placeholder" aria-hidden="true">RM</div>`;
      return `<article class="property-card" data-property-open="${esc(property.id)}"><div class="property-card-photo">${image}</div><div class="property-card-body"><div class="property-card-tags"><span class="pill">${esc(property.propertyType)}</span><span class="pill">${esc(property.operation)}</span></div><h3>${esc(property.title)}</h3><p class="property-card-zone">${esc(property.zone)}</p><strong class="property-price">${moneyMXN(property.price)}</strong><small>${esc(property.surface || "Superficie por definir")} ${esc(property.surfaceUnit || "m²")} · ${esc(property.status || "En revisión")}</small><small>Propietario: ${esc(ownerName(property.ownerLeadId) || "Sin asignar")}</small></div><button class="small-action property-edit" type="button" data-property-edit="${esc(property.id)}" aria-label="Abrir ficha de ${esc(property.title)}">↗</button></article>`;
    }));
    $("propertyList").innerHTML = cards.join("");
    applyStackOrder();
    $("propertyList").querySelectorAll("[data-property-open]").forEach(card => card.addEventListener("click", event => {
      if (event.target.closest("button")) return;
      showPropertyDetail(card.dataset.propertyOpen);
    }));
    $("propertyList").querySelectorAll("[data-property-edit]").forEach(button => button.addEventListener("click", () => showPropertyDetail(button.dataset.propertyEdit)));
  }
  const PUBLICATION_KEY = "crm_tm_publicaciones_v1";
  function publicationDates() {
    try { return JSON.parse(localStorage.getItem(PUBLICATION_KEY) || "{}"); } catch (_) { return {}; }
  }
  function markPropertyPublished(id) {
    if (!id) return;
    const dates = publicationDates(); dates[id] = new Date().toISOString();
    localStorage.setItem(PUBLICATION_KEY, JSON.stringify(dates));
    renderReminders();
  }
  function publicationDue(property) {
    const last = publicationDates()[property.id];
    const base = Date.parse(last || property.createdAt || property.updatedAt || "");
    return Number.isFinite(base) && Date.now() - base >= 3 * 86400000;
  }
  function renderReminders() {
    if (!currentUser) { $("remindersPanel").hidden = true; return; }
    $("remindersPanel").hidden = false;
    $("reminderDateText").textContent = new Date().toLocaleDateString("es-MX", {day:"2-digit",month:"2-digit",year:"numeric"}) + " · Actividades por atender";
    const dueProperties = properties.filter(item => !item.archived && publicationDue(item));
    const dueContacts = leads.filter(item => !item.archived && item.nextContact && new Date(item.nextContact).getTime() <= Date.now());
    const total = dueProperties.length + dueContacts.length;
    $("reminderCount").textContent = total;
    $("reminderHelp").textContent = total ? `${total} actividad${total === 1 ? "" : "es"} por atender. Abre una ficha y regresa a esta bandeja para continuar.` : "No tienes actividades vencidas.";
    const entries = [
      ...dueProperties.map(item => `<article class="reminder-item"><div class="reminder-item-copy"><span class="reminder-kind">PUBLICACIÓN</span><strong>${esc(item.title)}</strong><small>Revisar y publicar la propiedad</small></div><button class="button button-outline" type="button" data-reminder-property="${esc(item.id)}">Abrir propiedad</button></article>`),
      ...dueContacts.map(item => `<article class="reminder-item"><div class="reminder-item-copy"><span class="reminder-kind">${esc(item.nextChannel || "SEGUIMIENTO")}</span><strong>${esc(item.name)}</strong><small>${esc(localDateTime(item.nextContact))}</small></div><button class="button button-outline" type="button" data-reminder-lead="${esc(item.id)}">Abrir contacto</button></article>`)
    ];
    $("reminderList").innerHTML = entries.length ? entries.join("") : '<p class="reminder-empty">Todo al día. No tienes pendientes vencidos.</p>';
    $("reminderList").querySelectorAll("[data-reminder-property]").forEach(button => button.addEventListener("click", () => { $("remindersDialog").close(); showPropertyDetail(button.dataset.reminderProperty); }));
    $("reminderList").querySelectorAll("[data-reminder-lead]").forEach(button => button.addEventListener("click", () => { $("remindersDialog").close(); editLead(button.dataset.reminderLead); }));
    applyStackOrder();
  }
  function applyStackOrder() {
    for (const listId of ["leadList", "propertyList", "reminderList"]) {
      const list = $(listId);
      if (!list) continue;
      [...list.children].forEach((card, index) => {
        card.style.setProperty("--stack-index", String(index + 1));
      });
    }
  }
  $("openRemindersBtn").addEventListener("click", () => { renderReminders(); $("remindersDialog").showModal(); });
  $("closeRemindersBtn").addEventListener("click", () => $("remindersDialog").close());
  $("markPublishedBtn").addEventListener("click", () => {
    const id = $("propertyId").value;
    if (!id) return;
    markPropertyPublished(id);
    $("lastPublishedLabel").textContent = "Publicada hoy. Próxima revisión en 3 días (en este dispositivo).";
    setStatus("Publicación registrada en este dispositivo.");
  });
  $("enableNotifications").addEventListener("click", async () => {
    if (!("Notification" in window)) { $("notificationHelp").textContent = "Este navegador no admite notificaciones."; return; }
    const permission = await Notification.requestPermission();
    $("notificationHelp").textContent = permission === "granted" ? "Avisos permitidos. En esta versión el CRM debe estar abierto para emitirlos; el envío push en segundo plano está pendiente." : "Notificaciones no autorizadas. Tus pendientes siguen visibles en la agenda.";
    if (permission === "granted") new Notification("CRM Torres Maldonado", { body:"Avisos habilitados mientras el CRM esté abierto." });
  });
  let viewedPropertyId = "";
  async function showPropertyDetail(id) {
    const property = properties.find(item => item.id === id);
    if (!property) return;
    viewedPropertyId = id;
    $("propertyDetailError").textContent = "";
    $("propertyDetailTitle").textContent = property.title;
    const photo = await signedPropertyPhoto(property);
    if (viewedPropertyId !== id) return;
    $("propertyDetailContent").innerHTML = `
      <div class="property-detail-photo">${photo ? `<img src="${esc(photo)}" alt="Fotografía de ${esc(property.title)}">` : `<span class="property-placeholder">RM</span>`}</div>
      <div class="property-detail-information">
        <div class="property-card-tags"><span class="pill">${esc(property.propertyType)}</span><span class="pill">${esc(property.operation)}</span><span class="pill">${esc(property.status)}</span></div>
        <strong class="property-detail-price">${moneyMXN(property.price)}</strong>
        <div class="property-detail-grid">
          <div><small>Ubicación</small><strong>${esc(property.zone || "Sin definir")}</strong></div>
          <div><small>Superficie</small><strong>${esc(property.surface || "Sin definir")} ${esc(property.surfaceUnit || "")}</strong></div>
          <div><small>Propietario</small><strong>${esc(ownerName(property.ownerLeadId) || "Sin asignar")}</strong></div>
          <div><small>Dirección / referencia</small><strong>${esc(property.address || "Sin definir")}</strong></div>
        </div>
        ${property.description ? `<p class="property-detail-description">${esc(property.description)}</p>` : ""}
      </div>`;
    $("propertyDetailDialog").showModal();
  }
  $("closePropertyDetail").addEventListener("click", () => $("propertyDetailDialog").close());
  $("detailEditProperty").addEventListener("click", () => {
    $("propertyDetailDialog").close(); editProperty(viewedPropertyId);
  });
  $("detailPublishProperty").addEventListener("click", () => {
    const id = viewedPropertyId;
    $("propertyDetailDialog").close();
    editProperty(id);
    if (!$("openPublicationCenter").hidden) $("openPublicationCenter").click();
  });

  async function deleteLocalRecord(storeName, id) {
    const database = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("No se pudo eliminar el registro local."));
    });
  }
  async function deletePropertyPermanently(id) {
    const property = properties.find(item => item.id === id);
    if (!property || !currentUser) return;
    if (!navigator.onLine) { alert("Para eliminar definitivamente debes tener conexión a internet."); return; }
    if (!confirm(`¿Eliminar DEFINITIVAMENTE la propiedad "${property.title}"? Esta acción no se puede deshacer.`)) return;
    const { error } = await supabaseClient.from(PROPERTIES_TABLE).delete().eq("id", id).eq("owner_id", currentUser.id).select("id");
    if (error) { alert(`No se pudo eliminar en Supabase: ${error.message}`); return; }
    // Confirmar que el registro ya no exista antes de retirar la copia local.
    const { data:check, error:checkError } = await supabaseClient.from(PROPERTIES_TABLE).select("id").eq("id", id);
    if (checkError || (check && check.length)) { alert("No se confirmó el borrado en Supabase. No se eliminó la copia local."); return; }
    clearDirty(PROPERTIES_TABLE,id);
    await deleteLocalRecord("properties", id);
    properties = properties.filter(item => item.id !== id);
    const dates = publicationDates(); delete dates[id]; localStorage.setItem(PUBLICATION_KEY, JSON.stringify(dates));
    if (property.photoPath && !properties.some(item => item.photoPath === property.photoPath)) {
      const { error:photoError } = await supabaseClient.storage.from(PHOTO_BUCKET).remove([property.photoPath]);
      if (photoError) setStatus("Propiedad eliminada; no se pudo borrar su fotografía: " + photoError.message);
    }
    if ($("propertyDetailDialog").open) $("propertyDetailDialog").close();
    if ($("propertyDialog").open) $("propertyDialog").close();
    await refresh();
    setStatus("Propiedad eliminada definitivamente.");
  }
  $("detailDeleteProperty").addEventListener("click", () => { void deletePropertyPermanently(viewedPropertyId); });
  $("deletePropertyBtn").addEventListener("click", () => { void deletePropertyPermanently($("propertyId").value); });

  function ownerName(id) { return leads.find(lead => lead.id === id)?.name || ""; }
  function setPropertyOperation(operation) {
    propertyOperationFilter = operation;
    document.querySelectorAll("[data-property-operation]").forEach(button => button.classList.toggle("active", button.dataset.propertyOperation === operation));
    renderProperties();
  }
  function openNewProperty() {
    const owners = activeLeads().filter(lead => ["Propietario vendedor","Ofrece renta"].includes(lead.clientType));
    $("propertyForm").reset(); $("propertyId").value = ""; $("propertyFormError").textContent = "";
    $("propertyDialogTitle").textContent = "Nueva propiedad";
    $("propertyOperation").value = propertyOperationFilter || "Venta";
    $("propertyStatus").value = "Revisión";
    $("propertyTitleReviewed").checked = false; $("propertyAgreementSigned").checked = false;
    $("propertyOwner").innerHTML = `<option value="">Selecciona propietario</option>` + owners.map(owner => `<option value="${esc(owner.id)}">${esc(owner.name)} · ${esc(owner.phone || "sin teléfono")}</option>`).join("");
    propertyPhotoDataUrl = ""; $("propertyPhotoPreview").hidden = true; $("propertyPhotoPreview").innerHTML = "";
    $("publicationReminderControls").hidden = true;
    $("propertyDialog").showModal();
  }
  function editProperty(id) {
    const property = properties.find(item => item.id === id); if (!property) return;
    $("propertyForm").reset(); $("propertyFormError").textContent = "";
    $("propertyDialogTitle").textContent = "Ficha de propiedad";
    $("propertyId").value = property.id; $("propertyTitle").value = property.title;
    $("publicationReminderControls").hidden = false;
    const lastPublished = publicationDates()[property.id];
    $("lastPublishedLabel").textContent = lastPublished ? `Última publicación registrada: ${localDateTime(lastPublished)}. ${publicationDue(property) ? "Ya corresponde republicar." : "Próxima revisión a los 3 días."}` : "Sin publicación registrada; el recordatorio se activa a los 3 días del alta.";
    $("propertyOperation").value = property.operation; $("propertyKind").value = property.propertyType;
    $("propertyPrice").value = formatMoneyInput(property.price); $("propertySurface").value = property.surface === "" ? "" : formatDecimalInput(property.surface);
    $("propertySurfaceUnit").value = property.surfaceUnit || "m²"; $("propertyZone").value = property.zone;
    $("propertyAddress").value = property.address || ""; $("propertyStatus").value = property.status || "Revisión";
    $("propertyDescription").value = property.description || "";
    $("propertyTitleReviewed").checked = Boolean(property.titleReviewed);
    $("propertyAgreementSigned").checked = Boolean(property.agreementSigned);
    const owners = activeLeads().filter(lead => ["Propietario vendedor","Ofrece renta"].includes(lead.clientType));
    $("propertyOwner").innerHTML = `<option value="">Selecciona propietario</option>` + owners.map(owner => `<option value="${esc(owner.id)}">${esc(owner.name)} · ${esc(owner.phone || "sin teléfono")}</option>`).join("");
    $("propertyOwner").value = property.ownerLeadId || "";
    propertyPhotoDataUrl = property.photoDataUrl || "";
    signedPropertyPhoto(property).then(photo => {
      const preview = $("propertyPhotoPreview");
      if (photo) { preview.innerHTML = `<img src="${esc(photo)}" alt="Foto de la propiedad">`; preview.hidden = false; }
      else { preview.innerHTML = ""; preview.hidden = true; }
    });
    $("propertyDialog").showModal();
  }
  let refreshInProgress = false;
  async function refresh() {
    if (refreshInProgress) return;
    refreshInProgress = true;
    try {
      let synced = false;
      if (currentUser) {
        try { synced = await syncWithCloud(); }
        catch (error) {
          const stored = await getAllLeads();
          leads = stored.filter(lead => !lead.ownerId || lead.ownerId === currentUser.id).map(lead => ({ ...lead, ownerId: currentUser.id }));
          properties = (await getAllProperties()).filter(property => !property.ownerId || property.ownerId === currentUser.id);
          setStatus(`No se pudo sincronizar: ${error.message}. Los datos locales se conservan.`);
        }
      } else {
        leads = [];
        properties = [];
      }
      renderStats(); renderLeads(); void renderProperties(); renderCalendar(); renderReminders();
      if (currentUser && synced) setStatus("Sincronizado con Supabase · " + new Date().toLocaleTimeString("es-MX",{hour:"2-digit",minute:"2-digit"}) + ".");
      else if (currentUser && !navigator.onLine) setStatus("Sin conexión: los cambios quedan guardados aquí y se sincronizarán al reconectar.");
    } catch (error) { setStatus(error.message); }
    finally { refreshInProgress = false; }
  }

  function openNewLead(prefill = {}) {
    $("leadForm").reset(); $("leadId").value = ""; $("dialogTitle").textContent = "Nuevo contacto"; $("deleteLeadBtn").hidden = true; setFormError("");
    $("activityBox").hidden = true; $("activityHistory").innerHTML = "";
    $("startDate").value = toDateInput(new Date());
    $("nextChannel").value = "Llamada";
    $("source").value = prefill.source || "Captura manual";
    $("name").value = prefill.name || ""; $("phone").value = prefill.phone || ""; $("email").value = prefill.email || ""; $("budget").value = prefill.budget ? formatMoneyInput(prefill.budget) : "";
    $("comments").value = prefill.comments || "";
    if (prefill.operation) $("operation").value = prefill.operation;
    if (prefill.propertyType) $("propertyType").value = prefill.propertyType;
    if (prefill.creditType) $("creditType").value = prefill.creditType;
    if (prefill.clientType) $("clientType").value = prefill.clientType;
    if (!prefill.clientType && currentSection === "sellers") $("clientType").value = "Propietario vendedor";
    if (!prefill.clientType && currentSection === "investors") $("clientType").value = "Aportante o inversionista";
    if (!prefill.clientType && currentSection === "renters") $("clientType").value = "Busca renta";
    if (!prefill.clientType && currentSection === "buyers") $("clientType").value = "Comprador";
    if (!prefill.operation && ["sellers","investors"].includes(currentSection)) $("operation").value = currentSection === "sellers" ? "Venta" : "Aportación";
    if (!prefill.operation && currentSection === "renters") $("operation").value = "Renta";
    if (!prefill.operation && currentSection === "buyers") $("operation").value = "Compra";
    fillStageOptions();
    updateContactQuestions();
    $("leadDialog").showModal();
    if (prefill.name) $("clientType").focus(); else $("name").focus();
  }
  function editLead(id) {
    const lead = leads.find(item => item.id === id); if (!lead) return;
    $("leadForm").reset(); $("dialogTitle").textContent = "Editar contacto"; $("deleteLeadBtn").hidden = false; setFormError("");
    $("leadId").value = lead.id;
    for (const key of ["name","phone","email","clientType","operation","budget","creditType","propertyType","zoneType","zone","source","nextChannel","comments"]) {
      if ($(key)) $(key).value = lead[key] ?? "";
    }
    $("budget").value = lead.budget == null ? "" : formatMoneyInput(lead.budget);
    $("startDate").value = lead.startDate || ""; $("nextContact").value = toLocalDateTimeInput(lead.nextContact); $("targetDate").value = lead.targetDate || ""; $("rentStart").value = lead.rentStart || ""; $("rentEnd").value = lead.rentEnd || ""; $("waOptIn").checked = Boolean(lead.waOptIn);
    const activities = [...(lead.activities || [])].sort((a,b) => b.date.localeCompare(a.date));
    $("activityBox").hidden = activities.length === 0;
    $("activityHistory").innerHTML = activities.slice(0,12).map(item => `<div class="activity-row"><span>${esc(item.action)}</span><small>${esc(localDateTime(item.date))} · ${esc(item.channel || "")}</small></div>`).join("");
    fillStageOptions(lead.stage);
    updateContactQuestions();
    $("leadDialog").showModal(); $("name").focus();
  }
  function readForm() {
    const old = leads.find(item => item.id === $("leadId").value);
    const now = new Date().toISOString();
    const clientType = $("clientType").value;
    return {
      id: old?.id || uuid(), name: $("name").value.trim(), phone: $("phone").value.trim(), email: $("email").value.trim(),
      clientType, operation: $("operation").value, budget: $("budget").value ? parseMoney($("budget").value) : null,
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
  // Formulario contextual sin cambiar el esquema actual de Supabase.
  function updateContactQuestions() {
    const type = $("clientType").value;
    const owner = ["Propietario vendedor", "Ofrece renta"].includes(type);
    const renter = type === "Busca renta";
    const investor = type === "Aportante o inversionista";
    $("creditTypeLabel").hidden = owner || renter || investor;
    $("budgetLabel").firstChild.textContent = owner ? "Precio o renta estimada (MXN)" : renter ? "Presupuesto mensual (MXN)" : investor ? "Capital disponible (MXN)" : "Presupuesto / monto de crédito (MXN)";
    $("propertyTypeLabel").firstChild.textContent = owner ? "Inmueble que ofrece" : "Tipo de inmueble que busca";
    $("rentStartLabel").hidden = !renter && type !== "Ofrece renta";
    $("rentEndLabel").hidden = !renter && type !== "Ofrece renta";
    if (owner || renter || investor) $("creditType").value = "";
    if (type === "Ofrece renta" || renter) $("operation").value = "Renta";
    if (type === "Propietario vendedor" && !["Venta", "Aportación"].includes($("operation").value)) $("operation").value = "Venta";
    if (type === "Comprador" && $("operation").value !== "Compra") $("operation").value = "Compra";
  }
  $("clientType").addEventListener("change", updateContactQuestions);
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
  async function deleteLeadPermanently(id) {
    const lead = leads.find(item => item.id === id);
    if (!lead || !currentUser) return;
    const linked = properties.filter(item => item.ownerLeadId === id);
    if (linked.length) {
      alert(`Este propietario está vinculado a ${linked.length} propiedad(es). Primero desvincula las propiedades desde sus fichas; no se eliminarán automáticamente.`);
      return;
    }
    if (!navigator.onLine) { alert("Para eliminar definitivamente necesitas conexión a internet."); return; }
    if (!confirm(`¿Eliminar DEFINITIVAMENTE a "${lead.name}"? No se puede deshacer.`)) return;
    const { error } = await supabaseClient.from(CLOUD_TABLE).delete().eq("id", id).eq("owner_id", currentUser.id);
    if (error) { alert("No se pudo eliminar en Supabase: " + error.message); return; }
    const { data:check, error:checkError } = await supabaseClient.from(CLOUD_TABLE).select("id").eq("id", id);
    if (checkError || (check && check.length)) { alert("No se confirmó la eliminación en Supabase; se conservó la copia local."); return; }
    clearDirty(CLOUD_TABLE,id);
    await deleteLocalRecord("leads", id);
    leads = leads.filter(item => item.id !== id);
    $("leadDialog").close();
    await refresh();
    setStatus("Contacto eliminado definitivamente.");
  }
  $("deleteLeadBtn").addEventListener("click", () => { void deleteLeadPermanently($("leadId").value); });

  function setCurrentSection(section) {
    currentSection = section;
    const property = section === "properties";
    const calendar = section === "calendar";
    $("leadsView").hidden = property || calendar;
    $("propertiesView").hidden = !property;
    $("calendarView").hidden = !calendar;
    $("leadsView").classList.toggle("active", !property && !calendar);
    $("propertiesView").classList.toggle("active", property);
    $("calendarView").classList.toggle("active", calendar);
    document.querySelectorAll(".main-tabs .tab").forEach(tab => tab.classList.toggle("active", tab.dataset.view === section));
    $("newBtn").hidden = true;
    $("newPropertyBtn").hidden = true;
    $("newClientInSectionBtn").hidden = property || calendar;
    if (property) renderProperties();
    else if (calendar) renderCalendar();
    else renderLeads();
  }
  function fileToJpegDataUrl(file) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      const url = URL.createObjectURL(file);
      image.onload = () => {
        const scale = Math.min(1, 1800 / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL("image/jpeg", .84));
      };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("No se pudo abrir la foto.")); };
      image.src = url;
    });
  }
  $("propertyPhoto").addEventListener("change", async event => {
    const file = event.target.files?.[0]; if (!file) return;
    try {
      propertyPhotoDataUrl = await fileToJpegDataUrl(file);
      const preview = $("propertyPhotoPreview");
      preview.innerHTML = `<img src="${propertyPhotoDataUrl}" alt="Vista previa de la propiedad">`;
      preview.hidden = false;
    } catch (error) { $("propertyFormError").textContent = error.message; }
  });
  $("propertyKind").addEventListener("change", () => {
    if ($("propertyKind").value === "Hectárea") $("propertySurfaceUnit").value = "ha";
    else if ($("propertySurfaceUnit").value === "ha") $("propertySurfaceUnit").value = "m²";
  });
  // El usuario ve pesos y comas; la base de datos recibe números limpios.
  function parseMoney(value) {
    const clean = String(value ?? "").replace(/[^0-9.]/g, "");
    const result = Number(clean);
    return Number.isFinite(result) ? result : 0;
  }
  function formatMoneyInput(value) {
    const raw = String(value ?? "").replace(/[^0-9.]/g, "");
    if (!raw) return "";
    const pieces = raw.split(".");
    const integer = pieces[0].replace(/^0+(?=\d)/, "") || "0";
    const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return "$" + grouped + (pieces.length > 1 ? "." + pieces.slice(1).join("").slice(0, 2) : "");
  }
  function formatDecimalInput(value) {
    const raw = String(value ?? "").replace(/[^0-9.]/g, "");
    if (!raw) return "";
    const parts = raw.split(".");
    return (parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",") || "0") + (parts.length > 1 ? "." + parts.slice(1).join("").slice(0, 2) : "");
  }
  for (const id of ["propertyPrice", "budget", "propertySurface"]) {
    const input = $(id);
    input.addEventListener("input", () => {
      const oldLength = input.value.length;
      const oldPosition = input.selectionStart ?? oldLength;
      const digitsBefore = input.value.slice(0, oldPosition).replace(/[^0-9.]/g, "").length;
      const formatted = id === "propertySurface" ? formatDecimalInput(input.value) : formatMoneyInput(input.value);
      input.value = formatted;
      let pos = 0, seen = 0;
      while (pos < formatted.length && seen < digitsBefore) {
        if (/[0-9.]/.test(formatted[pos])) seen++;
        pos++;
      }
      input.setSelectionRange(pos, pos);
    });
  }

  $("propertyForm").addEventListener("submit", async event => {
    event.preventDefault(); $("propertyFormError").textContent = "";
    const id = $("propertyId").value || uuid();
    const previous = properties.find(property => property.id === id);
    const property = {
      id, ownerId:currentUser?.id || "", title:$("propertyTitle").value.trim(), operation:$("propertyOperation").value,
      propertyType:$("propertyKind").value, price:parseMoney($("propertyPrice").value),
      surface:$("propertySurface").value ? parseMoney($("propertySurface").value) : "", surfaceUnit:$("propertySurfaceUnit").value,
      zone:$("propertyZone").value.trim(), address:$("propertyAddress").value.trim(), ownerLeadId:$("propertyOwner").value,
      status:$("propertyStatus").value, titleReviewed:$("propertyTitleReviewed").checked,
      agreementSigned:$("propertyAgreementSigned").checked,
      photoPath:previous?.photoPath || "", photoDataUrl:propertyPhotoDataUrl || previous?.photoDataUrl || "",
      description:$("propertyDescription").value.trim(), archived:false,
      createdAt:previous?.createdAt || new Date().toISOString(), updatedAt:new Date().toISOString()
    };
    if (property.ownerLeadId && ["Propietario vendedor","Ofrece renta"].includes(leads.find(lead => lead.id === property.ownerLeadId)?.clientType) === false) {
      $("propertyFormError").textContent = "El contacto seleccionado debe estar registrado como vendedor o propietario que ofrece renta."; return;
    }
    if (["Promoción","Entrega"].includes(property.status) && (!property.titleReviewed || !property.agreementSigned)) {
      $("propertyFormError").textContent = "Antes de promover o cerrar, marca la revisión de titularidad y el convenio firmado."; return;
    }
    try {
      const saved = await putProperty(property);
      properties = await getAllProperties();
      properties = properties.filter(item => !item.ownerId || !currentUser || item.ownerId === currentUser.id);
      $("propertyDialog").close(); renderProperties(); renderReminders();
      if (!saved.synced) {
        const warning = saved.error ? `No se sincronizó con Supabase: ${saved.error.message}` : "Sin conexión: pendiente de sincronizar con Supabase.";
        setStatus(`Propiedad guardada solo en este dispositivo. ${warning}`);
        alert(`ATENCIÓN: la propiedad se guardó únicamente en este dispositivo. ${warning}`);
      }
      else setStatus("Propiedad guardada y sincronizada.");
    } catch (error) { $("propertyFormError").textContent = error.message || "No se pudo guardar la propiedad."; }
  });

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
    const propertyType = /local comercial|local|oficina|consultorio/.test(lower) ? "Local comercial" : /departamento|depa|condominio/.test(lower) ? "Departamento" : /hect[aá]rea/.test(lower) ? "Hectárea" : /terreno|lote/.test(lower) ? "Terreno" : /casa/.test(lower) ? "Casa" : "";
    const creditType = /fovissste/.test(lower) ? "FOVISSSTE" : /infonavit/.test(lower) ? "Infonavit" : /bancari[oa]|hipoteca/.test(lower) ? "Bancario" : /contado|recursos propios/.test(lower) ? "Recursos propios" : "";
    const clientType = /busco\s+(?:una\s+)?renta|buscando\s+(?:una\s+)?renta|rentar\s+(?:una\s+)?casa/.test(lower) ? "Busca renta" : /ofrezco\s+(?:en\s+)?renta|rento\s+(?:mi|una)?\s*(?:casa|departamento|propiedad)/.test(lower) ? "Ofrece renta" : /vendo\s+(?:mi\s+)?(?:casa|departamento|propiedad)|propietari[oa].*venta/.test(lower) ? "Propietario vendedor" : /aportante|inversionista|invertir/.test(lower) ? "Aportante o inversionista" : /comprar|busco|interesa/.test(lower) ? "Comprador" : "";
    return { name, phone, email, budget, operation, propertyType, creditType, clientType };
  }
  $("captureBtn").addEventListener("click", () => {
    if (!receiveReaderCapture()) $("captureDialog").showModal();
    updateReaderPendingNotice();
  });
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
  function updateReaderPendingNotice() {
    let pending = false;
    try { pending = Boolean(JSON.parse(localStorage.getItem("crm_pending_capture_v1") || "null")?.texto?.trim()); } catch (_) {}
    $("readerPendingNotice").hidden = !pending;
  }
  function receiveReaderCapture() {
    let capture;
    try {
      const saved = localStorage.getItem("crm_pending_capture_v1");
      if (!saved) return false;
      capture = JSON.parse(saved);
    } catch (_) { return false; }
    const text = String(capture?.texto || "").trim();
    if (!text) return false;
    const source = String(capture.origen || "");
    if ([...$("captureSource").options].some(option => option.value === source || option.textContent === source)) {
      $("captureSource").value = source;
    }
    $("ocrText").value = text;
    $("capturePreviewWrap").hidden = true;
    $("ocrStatus").textContent = `Texto recibido del lector (${text.length} caracteres). Revísalo y pulsa “Usar texto para nuevo contacto”.`;
    localStorage.removeItem("crm_pending_capture_v1");
    if (!$("captureDialog").open) $("captureDialog").showModal();
    return true;
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
  $("newClientInSectionBtn").addEventListener("click", () => openNewLead());
  $("emptyNewBtn").addEventListener("click", () => openNewLead());
  $("newPropertyBtn").addEventListener("click", openNewProperty);
  $("propertyAddBtn").addEventListener("click", openNewProperty);
  $("emptyPropertyAddBtn").addEventListener("click", openNewProperty);
  $("clientType").addEventListener("change", () => fillStageOptions());
  $("operation").addEventListener("change", () => { const rent = $("operation").value === "Renta"; $("rentStart").closest("label").style.opacity = rent ? "1" : ".65"; $("rentEnd").closest("label").style.opacity = rent ? "1" : ".65"; });
  document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => $(button.dataset.close).close()));
  document.querySelectorAll(".main-tabs .tab").forEach(button => button.addEventListener("click", () => setCurrentSection(button.dataset.view)));
  ["searchInput","operationFilter","stageFilter"].forEach(id => $(id).addEventListener("input", renderLeads));
  $("propertySearch").addEventListener("input", renderProperties);
  document.querySelectorAll("[data-property-operation]").forEach(button => button.addEventListener("click", () => setPropertyOperation(button.dataset.propertyOperation)));
  document.querySelectorAll("[data-property-type]").forEach(button => button.addEventListener("click", () => {
    propertyTypeFilter = button.dataset.propertyType;
    document.querySelectorAll("[data-property-type]").forEach(item => item.classList.toggle("active", item === button));
    renderProperties();
  }));
  $("exportBtn").addEventListener("click", async () => {
    const storedProperties = await getAllProperties();
    const data = { version:2, exportedAt:new Date().toISOString(), leads, properties:storedProperties.filter(property => !currentUser || !property.ownerId || property.ownerId === currentUser.id) };
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
      const propertyRows = Array.isArray(parsed.properties) ? parsed.properties.filter(row => row && row.title).map(row => ({ ...row, id:isUuid(row.id) ? row.id : uuid(), createdAt:row.createdAt || new Date().toISOString(), updatedAt:new Date().toISOString() })) : [];
      await putMany(records); await putManyProperties(propertyRows); await refresh(); setStatus(`Respaldo importado: ${records.length} contactos y ${propertyRows.length} propiedades.`);
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
  // Refrescar también cuando el CRM permanece abierto en otro dispositivo.
  // Se evita sobrescribir el formulario mientras el usuario lo está editando.
  function refreshWhenIdle() {
    if (!currentUser || document.hidden || !navigator.onLine) return;
    if (Array.from(document.querySelectorAll("dialog[open]")).length) return;
    void refresh();
  }
  window.setInterval(refreshWhenIdle, 45000);
  window.addEventListener("focus", refreshWhenIdle);
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