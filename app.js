/* =========================================================
   BARRIO DIGITAL | LECTOR DE NOTAS
   OCR EN ESPAÑOL, REVISIÓN MANUAL Y EXPORTACIÓN
========================================================= */

const $ = id => document.getElementById(id);
const photoCanvas = $("photoCanvas");
const selectionCanvas = $("selectionCanvas");
const ctx = photoCanvas.getContext("2d");
const selectCtx = selectionCanvas.getContext("2d");

let sourceImage = null;
let angle = 0;
let selections = [];
let drawing = null;
let items = [];
let nextId = 1;
let ocrController = null;
let busy = false;
let cancelled = false;

function setStatus(message) {
    $("status").textContent = message;
}

function money(value) {
    return Number(value || 0).toLocaleString("es-MX", {
        style: "currency",
        currency: "MXN"
    });
}

function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, character => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;",
        '"': "&quot;", "'": "&#39;"
    }[character]));
}

function updateButtons() {
    $("rotate").disabled = !sourceImage || busy;
    $("clear").disabled = !selections.length || busy;
    $("recognize").disabled = !sourceImage || busy;
    $("cancel").disabled = !busy;
    $("photo").disabled = busy;
}

/* =========================================================
   FOTOGRAFÍA
========================================================= */

$("photo").addEventListener("change", event => {
    const file = event.target.files[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
        setStatus("Selecciona un archivo de imagen válido.");
        return;
    }

    const url = URL.createObjectURL(file);
    const image = new Image();
    setStatus("Abriendo fotografía...");

    image.onload = () => {
        sourceImage = image;
        angle = 0;
        selections = [];
        items = [];
        drawPhoto();
        renderItems();
        updateButtons();
        setStatus("Fotografía lista. Selecciona renglones o pulsa Leer nota en español.");
        URL.revokeObjectURL(url);
    };

    image.onerror = () => {
        setStatus("No se pudo abrir la imagen. Prueba con JPG o PNG.");
        URL.revokeObjectURL(url);
    };

    image.src = url;
});

function drawPhoto() {
    if (!sourceImage) return;
    const w = sourceImage.naturalWidth;
    const h = sourceImage.naturalHeight;
    const scale = Math.min(1, 1600 / Math.max(w, h));
    const sideways = angle % 180 !== 0;
    photoCanvas.width = Math.max(1, Math.round((sideways ? h : w) * scale));
    photoCanvas.height = Math.max(1, Math.round((sideways ? w : h) * scale));
    selectionCanvas.width = photoCanvas.width;
    selectionCanvas.height = photoCanvas.height;
    $("photoHint").hidden = true;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, photoCanvas.width, photoCanvas.height);
    ctx.translate(photoCanvas.width / 2, photoCanvas.height / 2);
    ctx.rotate(angle * Math.PI / 180);
    ctx.drawImage(sourceImage, -w * scale / 2, -h * scale / 2, w * scale, h * scale);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawSelections();
}

$("rotate").addEventListener("click", () => {
    angle = (angle + 90) % 360;
    selections = [];
    drawPhoto();
    updateButtons();
    setStatus("Fotografía girada. Las selecciones anteriores se limpiaron.");
});

$("clear").addEventListener("click", () => {
    selections = [];
    drawSelections();
    updateButtons();
});

/* =========================================================
   SELECCIÓN DE RENGLONES
========================================================= */

function position(event) {
    const bounds = selectionCanvas.getBoundingClientRect();
    return {
        x: Math.max(0, Math.min(selectionCanvas.width,
            (event.clientX - bounds.left) * selectionCanvas.width / bounds.width)),
        y: Math.max(0, Math.min(selectionCanvas.height,
            (event.clientY - bounds.top) * selectionCanvas.height / bounds.height))
    };
}

function rectangle(a, b) {
    return {
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        w: Math.abs(a.x - b.x),
        h: Math.abs(a.y - b.y)
    };
}

function drawSelections() {
    selectCtx.clearRect(0, 0, selectionCanvas.width, selectionCanvas.height);
    selectCtx.lineWidth = Math.max(2, selectionCanvas.width / 500);
    for (const rect of selections) {
        selectCtx.fillStyle = "rgba(8, 122, 101, .14)";
        selectCtx.strokeStyle = "#087a65";
        selectCtx.fillRect(rect.x, rect.y, rect.w, rect.h);
        selectCtx.strokeRect(rect.x, rect.y, rect.w, rect.h);
    }
    if (drawing) {
        const rect = rectangle(drawing.start, drawing.end);
        selectCtx.strokeStyle = "#f39a23";
        selectCtx.strokeRect(rect.x, rect.y, rect.w, rect.h);
    }
}

selectionCanvas.addEventListener("pointerdown", event => {
    if (!sourceImage || busy) return;
    selectionCanvas.setPointerCapture(event.pointerId);
    drawing = { start: position(event), end: position(event) };
    drawSelections();
});

selectionCanvas.addEventListener("pointermove", event => {
    if (!drawing) return;
    drawing.end = position(event);
    drawSelections();
});

selectionCanvas.addEventListener("pointerup", event => {
    if (!drawing) return;
    drawing.end = position(event);
    const rect = rectangle(drawing.start, drawing.end);
    drawing = null;
    if (rect.w > 20 && rect.h > 8) selections.push(rect);
    drawSelections();
    updateButtons();
    setStatus(`${selections.length} renglón(es) seleccionado(s).`);
});

selectionCanvas.addEventListener("pointercancel", () => {
    drawing = null;
    drawSelections();
});

function crop(rect) {
    const padX = Math.min(16, rect.w * .05);
    const padY = Math.min(12, rect.h * .15);
    const x = Math.max(0, Math.floor(rect.x - padX));
    const y = Math.max(0, Math.floor(rect.y - padY));
    const w = Math.min(photoCanvas.width - x, Math.ceil(rect.w + 2 * padX));
    const h = Math.min(photoCanvas.height - y, Math.ceil(rect.h + 2 * padY));
    const canvas = document.createElement("canvas");
    const scale = Math.min(3, 1600 / Math.max(w, h));
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const context = canvas.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(photoCanvas, x, y, w, h, 0, 0, canvas.width, canvas.height);
    return canvas;
}


/* =========================================================
   OCR.SPACE ENGINE 3 POR CLOUDFLARE WORKER
   La clave privada permanece exclusivamente en Cloudflare.
========================================================= */

const OCR_ENDPOINT =
    "https://frosty-forest-c560.ventas-rodrigomaldonado.workers.dev/";

function imagenParaOCR() {
    if (!selections.length) return photoCanvas;

    const recortes = selections.map(rect => crop(rect));
    const margen = 12;
    const ancho = Math.max(...recortes.map(c => c.width));
    const alto = recortes.reduce((sum, c) => sum + c.height + margen, margen);
    const unido = document.createElement("canvas");
    unido.width = ancho + margen * 2;
    unido.height = alto;
    const g = unido.getContext("2d");
    g.fillStyle = "white";
    g.fillRect(0, 0, unido.width, unido.height);
    let y = margen;
    recortes.forEach(c => {
        g.drawImage(c, margen, y);
        y += c.height + margen;
    });
    return unido;
}

async function prepararArchivoOCR(canvas) {
    // Comprimir a menos de 1 MB para la modalidad gratuita habitual.
    let escala = Math.min(1, 1600 / Math.max(canvas.width, canvas.height));
    for (let intento = 0; intento < 8; intento++) {
        const copia = document.createElement("canvas");
        copia.width = Math.max(1, Math.round(canvas.width * escala));
        copia.height = Math.max(1, Math.round(canvas.height * escala));
        const g = copia.getContext("2d");
        g.fillStyle = "white";
        g.fillRect(0, 0, copia.width, copia.height);
        g.drawImage(canvas, 0, 0, copia.width, copia.height);
        const calidad = Math.max(.55, .88 - intento * .05);
        const blob = await new Promise(resolve => copia.toBlob(resolve, "image/jpeg", calidad));
        if (!blob) throw new Error("No se pudo preparar la fotografía.");
        if (blob.size <= 950000) {
            return new File([blob], "nota.jpg", { type: "image/jpeg" });
        }
        escala *= .82;
    }
    throw new Error("La fotografía es demasiado grande para enviarla.");
}

$("cancel").addEventListener("click", () => {
    if (!busy) return;
    cancelled = true;
    if (ocrController) ocrController.abort();
    setStatus("Lectura cancelada.");
});

$("recognize").addEventListener("click", async () => {
    if (!sourceImage || busy) return;
    busy = true;
    cancelled = false;
    ocrController = new AbortController();
    updateButtons();

    try {
        setStatus("Preparando fotografía para reconocimiento...");
        const archivo = await prepararArchivoOCR(imagenParaOCR());
        if (cancelled) return;

        const formulario = new FormData();
        formulario.append("file", archivo);
        setStatus("Leyendo escritura con OCR.space Engine 3...");

        const respuesta = await fetch(OCR_ENDPOINT, {
            method: "POST",
            body: formulario,
            signal: ocrController.signal
        });
        const resultado = await respuesta.json();
        if (cancelled) return;

        if (!respuesta.ok || resultado.IsErroredOnProcessing) {
            const detalle = resultado.ErrorMessage || resultado.ErrorDetails || resultado.error;
            throw new Error(Array.isArray(detalle) ? detalle.join("; ") :
                (detalle || `Respuesta HTTP ${respuesta.status}`));
        }

        const texto = (resultado.ParsedResults || [])
            .map(r => r.ParsedText || "")
            .join("\n");
        const lineas = texto.split(/\r?\n/)
            .map(linea => linea.trim())
            .filter(Boolean);

        // El total escrito en el ticket es una referencia, no un producto.
        const productos = lineas.filter(linea =>
            !/^(?:total|subtotal|suma|importe\s+total)\s*[:$\s\d.,]*$/i.test(linea)
        );
        items = productos.map(parseRow);
        renderItems();
        setStatus(items.length
            ? `Lectura terminada: ${items.length} renglón(es). Revisa productos, cantidades e importes antes de enviar.`
            : "No se reconocieron renglones. Gira la foto o prueba con mejor iluminación.");
    } catch (error) {
        if (!cancelled) {
            setStatus(`Error de reconocimiento: ${error.message}`);
        }
    } finally {
        ocrController = null;
        busy = false;
        updateButtons();
    }
});


/* =========================================================
   INTERPRETACIÓN DE RENGLONES
   CANTIDAD · UNIDAD · PRODUCTO · IMPORTE
========================================================= */

function parseRow(raw) {

    let text = String(raw || "")
        .replace(/\s+/g, " ")
        .trim();

    let amount = "";
    let quantity = "";
    let unit = "";

    // 1. Detectar precios con símbolo $
    // o palabras como total e importe.

    let amountMatch = text.match(
        /(?:\$\s*|(?:total|importe)\s*:?\s*)(\d[\d,.]*)(?:\s*(?:mxn|pesos))?\s*$/i
    );

    // 2. Detectar precios al final del renglón
    // aunque no tengan símbolo $.
    // Solo cuando hay texto antes del precio.

    if (!amountMatch) {

        amountMatch = text.match(
            /\s+(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{2})?|\d+(?:[.,]\d{1,2})?)\s*$/
        );

    }

    if (amountMatch) {

        let candidate = amountMatch[1];

        // Normalizar formatos de moneda.
        if (
            candidate.includes(",") &&
            candidate.includes(".")
        ) {

            candidate = candidate.replace(/,/g, "");

        } else if (
            /^\d+,\d{1,2}$/.test(candidate)
        ) {

            candidate = candidate.replace(",", ".");

        } else if (
            /^\d{1,3}(?:,\d{3})+$/.test(candidate)
        ) {

            candidate = candidate.replace(/,/g, "");

        }

        if (
            /^\d+(?:\.\d{1,2})?$/.test(candidate)
        ) {

            amount = candidate;

            text = text.slice(
                0,
                amountMatch.index
            ).trim();

        }

    }

    // 3. Detectar cantidad y unidad.
    // Exigir unidad o texto adicional para
    // evitar confundir una cifra con un producto.

    const quantityMatch = text.match(
        /^(\d+(?:[.,]\d+)?)\s*(kg|kilos?|g|gr|gramos?|pzas?|piezas?|lts?|litros?|ml)\b\s*/i
    );

    if (quantityMatch) {

        quantity = quantityMatch[1]
            .replace(",", ".");

        unit = quantityMatch[2];

        text = text.slice(
            quantityMatch[0].length
        ).trim();

    }

    // 4. Conservar el texto original.
    // No inventar productos ni importes.

    return {

        id: nextId++,

        raw: raw,

        product: text,

        quantity: quantity,

        unit: unit,

        amount: amount

    };

}


/* =========================================================
   REVISIÓN Y TOTALES
========================================================= */

function addBlankRow() {
    items.push({ id: nextId++, raw: "", product: "", quantity: "", unit: "", amount: "" });
    renderItems();
}

$("add").addEventListener("click", addBlankRow);

function renderItems() {
    $("empty").hidden = items.length > 0;
    $("items").innerHTML = items.map((item, index) => `
        <div class="item" data-id="${item.id}">
            <div class="itemtop">
                <strong>Renglón ${index + 1}</strong>
                <button class="danger" data-remove="${item.id}" type="button">Eliminar</button>
            </div>
            <div class="itemgrid">
                <div class="product">
                    <label>Producto o concepto</label>
                    <input type="text" data-field="product" value="${escapeHTML(item.product)}" placeholder="Ej. Camarón">
                </div>
                <div>
                    <label>Cantidad</label>
                    <input type="text" data-field="quantity" value="${escapeHTML(item.quantity)}" placeholder="2">
                </div>
                <div>
                    <label>Unidad</label>
                    <input type="text" data-field="unit" value="${escapeHTML(item.unit)}" placeholder="kg">
                </div>
                <div>
                    <label>Importe ($)</label>
                    <input type="number" min="0" step="0.01" data-field="amount" value="${escapeHTML(item.amount)}" placeholder="0.00">
                </div>
            </div>
            ${item.raw ? `<p class="raw">Lectura original: ${escapeHTML(item.raw)}</p>` : ""}
        </div>
    `).join("");

    $("items").querySelectorAll("input[data-field]").forEach(input => {
        input.addEventListener("input", () => {
            const parent = input.closest(".item");
            const item = items.find(x => x.id === Number(parent.dataset.id));
            if (!item) return;
            item[input.dataset.field] = input.value;
            updateTotal();
        });
    });

    $("items").querySelectorAll("[data-remove]").forEach(button => {
        button.addEventListener("click", () => {
            items = items.filter(x => x.id !== Number(button.dataset.remove));
            renderItems();
        });
    });

    updateTotal();
}

function totalValue() {
    return items.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
}

function updateTotal() {
    $("total").textContent = `Total revisado: ${money(totalValue())}`;
}

function report() {
    return {
        version: "1.0",
        origen: "barrio-digital-smart-capture",
        estado: "revisado-por-usuario",
        aplicacion: "Lector de Notas Barrio Digital",
        fecha: new Date().toISOString(),
        requiereRevisionHumana: true,
        renglones: items.map(item => ({
            producto: item.product,
            cantidad: item.quantity,
            unidad: item.unit,
            importe: item.amount === "" ? null : Number(item.amount),
            lecturaOriginal: item.raw
        })),
        totalRevisado: totalValue()
    };
}

$("download").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(report(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "nota-barrio-digital.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$("copy").addEventListener("click", async () => {
    const text = items.map((item, index) =>
        `${index + 1}. ${item.quantity} ${item.unit} ${item.product} | ${item.amount === "" ? "Sin importe" : money(item.amount)}`
    ).join("\n") + `\nTOTAL REVISADO: ${money(totalValue())}`;

    try {
        await navigator.clipboard.writeText(text);
        setStatus("Nota copiada.");
    } catch (_) {
        setStatus("No se pudo copiar. Utiliza Exportar JSON.");
    }
});

$("reset").addEventListener("click", () => {
    if (busy) return;
    sourceImage = null;
    selections = [];
    items = [];
    angle = 0;
    $("photo").value = "";
    photoCanvas.width = 300;
    photoCanvas.height = 0;
    selectionCanvas.width = 300;
    selectionCanvas.height = 0;
    $("photoHint").hidden = false;
    renderItems();
    updateButtons();
    setStatus("Listo para una nueva nota.");
});

photoCanvas.width = 300;
photoCanvas.height = 0;
selectionCanvas.width = 300;
selectionCanvas.height = 0;
renderItems();
updateButtons();

/* =========================================================
   ENTREGA AL SISTEMA ADMINISTRATIVO
   No registra movimientos por sí mismo.
========================================================= */

$("send").addEventListener("click", async () => {
    if (busy) return;
    if (!items.length) {
        setStatus("Agrega o reconoce al menos un renglón antes de enviarlo.");
        return;
    }
    const invalid = items.some(item => !item.product.trim() ||
        item.amount === "" || !Number.isFinite(Number(item.amount)) ||
        Number(item.amount) < 0);
    if (invalid) {
        setStatus("Revisa cada concepto e importe antes de enviarlo a administración.");
        return;
    }
    const payload = report();
    if (!window.confirm("¿Confirmas que revisaste los datos y deseas enviarlos a administración?")) return;
    try {
        const result = await window.BarrioCapture.entregar(payload);
        if (result?.entregado) {
            setStatus("Datos enviados al sistema administrativo para su clasificación.");
        } else {
            setStatus("No hay administración conectada. Descarga el JSON para importarlo después.");
        }
    } catch (error) {
        setStatus(`No se pudo enviar: ${error.message}. Los datos permanecen en pantalla.`);
    }
});
