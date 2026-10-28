/* BARRIO DIGITAL | Puente OCR -> Supabase Mar y Chelas
   No guarda fotografías ni altera inventario. */
(function () {
  "use strict";

  const SUPABASE_URL = "https://drpdwccyjtetakcgbulf.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_mf390v5SbXC_xI9h95Q_hg_ElR7ngvZ";
  let clientePromise;

  function cargarSupabase() {
    if (window.supabase && window.supabase.createClient) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
      script.onload = () => window.supabase?.createClient ? resolve() : reject(new Error("No se pudo iniciar Supabase"));
      script.onerror = () => reject(new Error("No se pudo cargar Supabase. Comprueba tu conexión"));
      document.head.appendChild(script);
    });
  }

  async function cliente() {
    if (!clientePromise) {
      clientePromise = cargarSupabase().then(() =>
        window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
      ).catch(error => { clientePromise = null; throw error; });
    }
    return clientePromise;
  }

  async function usuarioAutorizado(db) {
    const { data: sesion, error: errorSesion } = await db.auth.getUser();
    if (errorSesion && sesion?.user) throw errorSesion;
    if (sesion?.user) return sesion.user;

    const correo = window.prompt("Correo del administrador de Mar y Chelas:");
    if (correo === null) throw new Error("Envío cancelado: no se inició sesión");
    if (!correo.trim()) throw new Error("Escribe el correo del administrador");
    const contrasena = window.prompt("Contraseña del administrador de Mar y Chelas:");
    if (contrasena === null) throw new Error("Envío cancelado: no se inició sesión");
    if (!contrasena) throw new Error("Escribe la contraseña");

    const { data, error } = await db.auth.signInWithPassword({
      email: correo.trim(), password: contrasena
    });
    if (error || !data?.user) throw new Error("No se pudo iniciar sesión: " + (error?.message || "verifica tus datos"));
    return data.user;
  }

  const api = {
    onReceive: null,
    async entregar(datos) {
      if (!datos || !Array.isArray(datos.renglones) || !datos.renglones.length) {
        throw new Error("Formato de captura inválido");
      }
      const evento = new CustomEvent("barrio:capture", { detail: datos, cancelable: true });
      window.dispatchEvent(evento);
      if (typeof api.onReceive === "function") {
        await api.onReceive(structuredClone(datos));
        return { entregado: true };
      }
      const db = await cliente();
      const usuario = await usuarioAutorizado(db);
      const { data, error } = await db.from("cr_tickets_pendientes")
        .insert({
          productos: datos.renglones,
          total: Number(datos.totalRevisado) || 0,
          estado: "pendiente",
          enviado_por: usuario.id
        })
        .select("id")
        .single();
      if (error) throw new Error("Supabase: " + error.message);
      return { entregado: true, id: data.id };
    }
  };
  window.BarrioCapture = api;
})();
