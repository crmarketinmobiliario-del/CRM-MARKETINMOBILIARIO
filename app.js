/* BARRIO DIGITAL | Lector de texto para captación inmobiliaria */
const $ = id => document.getElementById(id);
const photoCanvas = $("photoCanvas");
const selectionCanvas = $("selectionCanvas");
const ctx = photoCanvas.getContext("2d");
const selectCtx = selectionCanvas.getContext("2d");

let sourceImage = null;
let angle = 0;
let selections = [];
let drawing = null;
let busy = false;
let cancelled = false;

function setStatus(message) { $("status").textContent = message; }
function updateButtons() {
  $("rotate").disabled = !sourceImage || busy;
  $("clear").disabled = !selections.length || busy;
  $("recognize").disabled = !sourceImage || busy;
  $("cancel").disabled = !busy;
  $("photo").disabled = busy;
}
function newImage(file) {
  if (!file) return;
  if (!file.type.startsWith("image/")) { setStatus("Elige una imagen válida."); return; }
  const url = URL.createObjectURL(file);
  const image = new Image();
  setStatus("Abriendo imagen…");
  image.onload = () => {
    sourceImage = image; angle = 0; selections = [];
    drawPhoto(); updateButtons(); setStatus("Imagen lista. Puedes leerla completa o seleccionar una parte.");
    URL.revokeObjectURL(url);
  };
  image.onerror = () => { setStatus("No se pudo abrir la imagen. Prueba con JPG o PNG."); URL.revokeObjectURL(url); };
  image.src = url;
}
$("photo").addEventListener("change", event => newImage(event.target.files[0]));

function drawPhoto() {
  if (!sourceImage) return;
  const w = sourceImage.naturalWidth, h = sourceImage.naturalHeight;
  const scale = Math.min(1, 1600 / Math.max(w, h));
  const sideways = angle % 180 !== 0;
  photoCanvas.width = Math.max(1, Math.round((sideways ? h : w) * scale));
  photoCanvas.height = Math.max(1, Math.round((sideways ? w : h) * scale));
  selectionCanvas.width = photoCanvas.width; selectionCanvas.height = photoCanvas.height;
  $("photoHint").hidden = true;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, photoCanvas.width, photoCanvas.height);
  ctx.translate(photoCanvas.width / 2, photoCanvas.height / 2);
  ctx.rotate(angle * Math.PI / 180);
  ctx.drawImage(sourceImage, -w * scale / 2, -h * scale / 2, w * scale, h * scale);
  ctx.setTransform(1, 0, 0, 1, 0, 0); drawSelections();
}
$("rotate").addEventListener("click", () => { angle = (angle + 90) % 360; selections = []; drawPhoto(); updateButtons(); setStatus("Imagen girada."); });
$("clear").addEventListener("click", () => { selections = []; drawSelections(); updateButtons(); });

function position(event) {
  const b = selectionCanvas.getBoundingClientRect();
  return { x: Math.max(0, Math.min(selectionCanvas.width, (event.clientX - b.left) * selectionCanvas.width / b.width)), y: Math.max(0, Math.min(selectionCanvas.height, (event.clientY - b.top) * selectionCanvas.height / b.height)) };
}
function rectangle(a, b) { return { x:Math.min(a.x,b.x), y:Math.min(a.y,b.y), w:Math.abs(a.x-b.x), h:Math.abs(a.y-b.y) }; }
function drawSelections() {
  selectCtx.clearRect(0, 0, selectionCanvas.width, selectionCanvas.height);
  selectCtx.lineWidth = Math.max(2, selectionCanvas.width / 500);
  for (const r of selections) { selectCtx.fillStyle = "rgba(8,122,101,.14)"; selectCtx.strokeStyle = "#087a65"; selectCtx.fillRect(r.x,r.y,r.w,r.h); selectCtx.strokeRect(r.x,r.y,r.w,r.h); }
  if (drawing) { const r=rectangle(drawing.start,drawing.end); selectCtx.strokeStyle="#f39a23"; selectCtx.strokeRect(r.x,r.y,r.w,r.h); }
}
selectionCanvas.addEventListener("pointerdown", event => { if (!sourceImage || busy) return; selectionCanvas.setPointerCapture(event.pointerId); drawing={start:position(event),end:position(event)}; drawSelections(); });
selectionCanvas.addEventListener("pointermove", event => { if (!drawing) return; drawing.end=position(event); drawSelections(); });
selectionCanvas.addEventListener("pointerup", event => {
  if (!drawing) return; drawing.end=position(event); const r=rectangle(drawing.start,drawing.end); drawing=null;
  if (r.w>20 && r.h>8) selections.push(r); drawSelections(); updateButtons(); setStatus(`${selections.length} área(s) seleccionada(s).`);
});
selectionCanvas.addEventListener("pointercancel", () => { drawing=null; drawSelections(); });

function crop(rect) {
  const px=Math.min(16,rect.w*.05), py=Math.min(12,rect.h*.15), x=Math.max(0,Math.floor(rect.x-px)), y=Math.max(0,Math.floor(rect.y-py));
  const w=Math.min(photoCanvas.width-x,Math.ceil(rect.w+2*px)), h=Math.min(photoCanvas.height-y,Math.ceil(rect.h+2*py));
  const canvas=document.createElement("canvas"), scale=Math.min(3,1600/Math.max(w,h));
  canvas.width=Math.max(1,Math.round(w*scale)); canvas.height=Math.max(1,Math.round(h*scale));
  const g=canvas.getContext("2d"); g.fillStyle="white"; g.fillRect(0,0,canvas.width,canvas.height); g.drawImage(photoCanvas,x,y,w,h,0,0,canvas.width,canvas.height); return canvas;
}
function imageForOCR() {
  if (!selections.length) return photoCanvas;
  const crops=selections.map(crop), margin=12, width=Math.max(...crops.map(c=>c.width)), height=crops.reduce((sum,c)=>sum+c.height+margin,margin);
  const canvas=document.createElement("canvas"); canvas.width=width+margin*2; canvas.height=height;
  const g=canvas.getContext("2d"); g.fillStyle="white"; g.fillRect(0,0,canvas.width,canvas.height); let y=margin;
  crops.forEach(c=>{g.drawImage(c,margin,y);y+=c.height+margin;}); return canvas;
}
$("cancel").addEventListener("click", () => { if(!busy)return; cancelled=true; setStatus("Cancelación solicitada. Se descartará el texto cuando termine esta lectura."); });
$("recognize").addEventListener("click", async () => {
  if(!sourceImage||busy)return; busy=true; cancelled=false; updateButtons();
  try {
    if(!window.Tesseract?.recognize) throw new Error("No se cargó el lector OCR. Revisa tu conexión e inténtalo de nuevo.");
    setStatus("Reconociendo texto en este dispositivo…");
    const result=await window.Tesseract.recognize(imageForOCR(),"spa",{logger:message=>{
      if(message.status==="recognizing text"&&Number.isFinite(message.progress)) setStatus(`Leyendo texto… ${Math.round(message.progress*100)}%`);
    }});
    if(cancelled)return;
    const text=String(result.data?.text||"").trim(); $("recognizedText").value=text;
    setStatus(text?`Texto reconocido (${text.length} caracteres). Revísalo y corrígelo antes de copiarlo.`:"No se encontró texto claro. Gira la imagen o prueba con más luz.");
  } catch(error) { if(!cancelled)setStatus(`No se pudo leer: ${error.message}`); }
  finally { busy=false; updateButtons(); }
});

$("copy").addEventListener("click", async () => {
  const text=$("recognizedText").value.trim(); if(!text){setStatus("Primero lee la imagen o pega el texto.");return;}
  try { await navigator.clipboard.writeText(text); setStatus("Texto copiado. Pégalo en la ficha del contacto en el CRM."); }
  catch(_) { $("recognizedText").focus(); $("recognizedText").select(); setStatus("Texto seleccionado. Cópialo y pégalo en el CRM."); }
});
$("download").addEventListener("click", () => {
  const text=$("recognizedText").value.trim(); if(!text){setStatus("Primero lee la imagen o pega el texto.");return;}
  const blob=new Blob([text],{type:"text/plain;charset=utf-8"}), url=URL.createObjectURL(blob), link=document.createElement("a");
  link.href=url; link.download="captura-contacto.txt"; link.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); setStatus("Texto descargado.");
});
$("reset").addEventListener("click", () => {
  if(busy)return; sourceImage=null; selections=[]; angle=0; $("photo").value=""; $("recognizedText").value="";
  photoCanvas.width=300; photoCanvas.height=0; selectionCanvas.width=300; selectionCanvas.height=0; $("photoHint").hidden=false; updateButtons(); setStatus("Listo para leer otra captura.");
});
photoCanvas.width=300; photoCanvas.height=0; selectionCanvas.width=300; selectionCanvas.height=0; updateButtons();
