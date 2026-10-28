/* Compatibilidad local para el lector. No conecta con Supabase ni envía a terceros. */
(function () {
  "use strict";
  window.BarrioCapture = {
    async entregar(datos) {
      const text = String(datos?.texto || "").trim();
      if (!text) throw new Error("No hay texto reconocido para copiar al CRM.");
      localStorage.setItem("crm_pending_capture_v1", JSON.stringify({
        texto: text,
        origen: datos.origen || "Captura OCR",
        fecha: new Date().toISOString()
      }));
      return { entregado: true, local: true };
    }
  };
})();
