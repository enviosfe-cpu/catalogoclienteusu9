/**
 * Catálogo Cliente - 100% Offline Engine
 * Carga de datos local-first sin descargas bloqueantes al iniciar.
 */
const state = { catalog: null, cart: {}, gsUrl: "", vendor: "", isSyncing: false };

// Convierte links de vista de Drive (/file/d/.../view) a imagen directa
function directImageUrl(u) {
  const s = String(u || "").trim();
  if (!s) return s;
  const m = s.match(/drive\.google\.com\/file\/d\/([^/]+)/)
    || s.match(/drive\.google\.com\/open\?.*[?&]id=([^&]+)/)
    || s.match(/drive\.google\.com\/uc\?.*[?&]id=([^&]+)/);
  if (m && m[1]) return `https://drive.google.com/thumbnail?id=${m[1]}&sz=w1000`;
  return s;
}

// Normaliza imágenes del catálogo (logo, productos y oferta)
function normalizeCatalogImages(cat) {
  if (!cat) return;
  if (cat.company && cat.company.logo) cat.company.logo = directImageUrl(cat.company.logo);
  (cat.products || []).forEach(p => { if (p.image) p.image = directImageUrl(p.image); });
  if (cat.offer && cat.offer.image) {
    cat.offer.image = String(cat.offer.image).split(/[,\n]+/).map(s => directImageUrl(s.trim())).filter(Boolean).join(',');
  }
}

// Registro de Service Worker para PWA Offline (solo en http/https)
if ('serviceWorker' in navigator && (window.location.protocol === 'http:' || window.location.protocol === 'https:')) {
  navigator.serviceWorker.register('./sw.js')
    .then(() => console.log('SW Catálogo Cliente activo (modo offline habilitado).'))
    .catch((err) => console.log('SW error:', err));
}

document.addEventListener('DOMContentLoaded', async () => {
  const q = new URLSearchParams(window.location.search);
  state.vendor = (q.get('v') || window.CC_VENDOR || "").trim().toUpperCase();
  state.gsUrl = (q.get('gs') || window.CC_GSURL || "").trim();

  // Enlaces viejos sin gs: reutilizar el último GS usado por este vendedor
  if (!state.gsUrl && state.vendor) {
    try { state.gsUrl = localStorage.getItem('cc_gs_' + state.vendor) || ""; } catch (e) {}
  }

  // Restaurar carrito guardado
  try {
    const raw = localStorage.getItem('cc_cart_' + state.vendor);
    if (raw) state.cart = JSON.parse(raw) || {};
  } catch (e) {}

  // 1. CARGA INMEDIATA OFFLINE (0 ms de espera)
  loadCatalogOfflineFirst();

  // 2. Consulta en segundo plano si hay conexión (no bloquea al usuario)
  if (navigator.onLine && state.gsUrl) {
    syncCatalogInBackground();
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { toggleCart(false); closeOffer(); }
    const modal = document.getElementById('cc-offer');
    if (modal && !modal.classList.contains('hidden')) {
      if (e.key === 'ArrowLeft') moveOffer(-1);
      if (e.key === 'ArrowRight') moveOffer(1);
    }
  });
});

/**
 * Carga Local-First: lee únicamente del almacenamiento local guardado.
 */
function loadCatalogOfflineFirst() {
  const empty = document.getElementById('cc-empty');
  const loading = document.getElementById('cc-loading');

  let data = null;

  // Almacenamiento local del navegador
  try {
    const cached = localStorage.getItem('cc_catalog_' + state.vendor);
    if (cached) {
      data = JSON.parse(cached);
    }
  } catch (e) {
    console.warn("Error leyendo cc_catalog:", e);
  }

  if (data && data.products && data.products.length > 0) {
    state.catalog = data;
    normalizeCatalogImages(state.catalog);
    if (loading) loading.classList.add('hidden');
    if (empty) empty.classList.add('hidden');
    applyBrand();
    renderGrid();
    updateCartBadge();
    maybeOffer();
    return true;
  }

  // Si no hay datos en caché, mostrar estado vacío / cargando según corresponda
  if (empty) {
    const msg = document.getElementById('cc-empty-msg');
    if (msg) msg.textContent = "No hay productos disponibles en caché local. Conéctate para sincronizar.";
    empty.classList.remove('hidden');
  }
  return false;
}

/**
 * Sincronización en segundo plano: no bloquea ni muestra spinners en la vista principal
 */
async function syncCatalogInBackground() {
  if (state.isSyncing || !state.gsUrl || !state.vendor) return;
  state.isSyncing = true;

  try {
    const res = await fetch(`${state.gsUrl}?action=get_public&v=${encodeURIComponent(state.vendor)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.status !== "success" || !json.public) throw new Error((json && json.message) || "Sin respuesta");

    state.catalog = json.public;
    normalizeCatalogImages(state.catalog);
    try {
      localStorage.setItem('cc_catalog_' + state.vendor, JSON.stringify(json.public));
      localStorage.setItem('cc_gs_' + state.vendor, state.gsUrl);
    } catch (e) {}

    document.getElementById('cc-loading')?.classList.add('hidden');
    applyBrand();
    renderGrid();
    updateCartBadge();
    maybeOffer();
  } catch (e) {
    // Si falla en background o no hay internet, no pasa nada porque ya tenemos datos offline
    console.log("Catálogo en modo local / offline:", e.message || e);
    document.getElementById('cc-loading')?.classList.add('hidden');
    if (!state.catalog || !state.catalog.products || !state.catalog.products.length) {
      const msg = document.getElementById('cc-empty-msg');
      if (msg) msg.textContent = "Catálogo listo para operar offline. Conéctate una vez si requieres actualizar.";
      document.getElementById('cc-empty')?.classList.remove('hidden');
    }
  } finally {
    state.isSyncing = false;
  }
}

/**
 * Actualización manual al presionar el botón del encabezado
 */
async function refreshCatalogManually() {
  const icon = document.getElementById('icon-refresh');
  if (icon) icon.classList.add('fa-spin');

  if (!navigator.onLine) {
    alert("Estás sin conexión a internet. Mostrando catálogo guardado en este dispositivo.");
    if (icon) icon.classList.remove('fa-spin');
    return;
  }

  try {
    await syncCatalogInBackground();
  } finally {
    if (icon) icon.classList.remove('fa-spin');
  }
}

function applyBrand() {
  const c = state.catalog || {};
  const company = c.company || {};
  const seller = c.seller || {};
  const offer = c.offer || {};
  document.title = `${company.name || 'Catálogo'}${seller.name ? ' • ' + seller.name : ''}`;
  
  const co = document.getElementById('cc-company');
  if (co) co.textContent = company.name || 'Distribuciones Castro';
  
  const se = document.getElementById('cc-seller');
  if (se) {
    const label = [seller.name, seller.code ? 'Cód. ' + seller.code : ''].filter(Boolean).join(' • ');
    se.textContent = label || 'Catálogo Digital';
  }
  
  const logo = document.getElementById('cc-logo');
  if (logo) {
    if (company.logo) {
      logo.onerror = () => { logo.onerror = null; logo.src = './logo.png'; };
      logo.src = directImageUrl(company.logo);
    } else {
      logo.onerror = null;
      logo.src = './logo.png';
    }
  }
  
  const hl = document.getElementById('cc-headline');
  if (hl) {
    let html = seller.headline ? `<span>${seller.headline}</span>` : '';
    if (offer && offer.enabled && offer.image) {
      html += `
        <button onclick="openOffer()" class="inline-flex items-center gap-1.5 ml-2 px-2.5 py-1 rounded-lg bg-amber-500/10 text-amber-600 text-xs font-bold hover:bg-amber-500/20 active:scale-95 transition">
          <i class="fa-solid fa-fire text-amber-500"></i> Ver oferta
        </button>`;
    }
    hl.innerHTML = html;
  }
  
  const send = document.getElementById('cc-send-label');
  if (send && seller.name) send.textContent = `Enviar a ${seller.name} por WhatsApp`;
}

function openOffer() {
  const offer = state.catalog && state.catalog.offer;
  if (!offer || !offer.image) return;
  const modal = document.getElementById('cc-offer');
  const img = document.getElementById('cc-offer-image');
  const t = document.getElementById('cc-offer-title');
  const cta = document.getElementById('cc-offer-cta');
  
  if (img) {
    state.offerImages = parseOfferImages(offer.image);
    state.offerIdx = 0;
    showOfferImage();
    enableOfferSwipe();
  }
  if (t) t.textContent = offer.title || 'Oferta especial';
  if (cta) cta.textContent = offer.cta || 'Ver productos';
  if (modal) {
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }
}

function parseOfferImages(raw) {  return String(raw || '')
    .split(/[,\n]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(u => {
      // Si es un enlace de Google Drive con sz=w..., asegurar alta resolución (w2000)
      if (u.includes('drive.google.com') && u.includes('sz=w')) {
        return u.replace(/sz=w\d+/, 'sz=w2000');
      }
      return u;
    });
}

function renderGrid() {
  const grid = document.getElementById('cc-grid');
  const empty = document.getElementById('cc-empty');
  if (!grid || !state.catalog) return;
  const q = (document.getElementById('cc-search')?.value || '').toLowerCase().trim();
  const items = (state.catalog.products || []).filter(p => {
    if (!q) return true;
    return String(p.name || '').toLowerCase().includes(q) || String(p.code || '').toLowerCase().includes(q);
  });
  if (!items.length) {
    grid.innerHTML = '';
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');
  grid.innerHTML = items.map(p => {
    const qty = state.cart[p.code] || 0;
    const sub = [p.supplierName || p.supplier, p.categoryName || p.category].filter(Boolean).join(' • ');
    return `
    <div class="bg-white rounded-2xl border border-slate-200/80 shadow-xs flex flex-col overflow-hidden">
      <div class="w-full aspect-square bg-slate-50 border-b border-slate-100 flex items-center justify-center overflow-hidden">
        ${p.image ? `<img src="${p.image}" alt="${p.name}" loading="lazy" onerror="this.outerHTML='<i class=\\\'fa-solid fa-box text-3xl text-slate-300\\\'></i>'" class="w-full h-full object-contain p-2">` : `<i class="fa-solid fa-box text-3xl text-slate-300"></i>`}
      </div>
      <div class="p-3 flex-1 flex flex-col">
        <span class="text-[10px] font-bold text-blue-700">#${p.code}</span>
        <h4 class="text-xs font-bold text-slate-800 line-clamp-2 leading-snug">${p.name}</h4>
        ${sub ? `<div class="text-[10px] text-slate-400 truncate mt-0.5">${sub}</div>` : ''}
        <div class="mt-2 pt-2 border-t border-slate-100 flex items-center justify-between">
          ${qty > 0 ? `
          <div class="flex items-center gap-2">
            <button onclick="changeQty('${p.code}', -1)" class="w-9 h-9 rounded-lg bg-slate-100 text-slate-700 font-bold">−</button>
            <span class="text-sm font-extrabold w-5 text-center">${qty}</span>
            <button onclick="changeQty('${p.code}', 1)" class="w-9 h-9 rounded-lg bg-slate-100 text-slate-700 font-bold">+</button>
          </div>` : `
          <button onclick="changeQty('${p.code}', 1)" class="px-3 py-2 rounded-lg bg-blue-600 active:bg-blue-700 text-white text-xs font-bold w-full text-center">Agregar</button>`}
        </div>
      </div>
    </div>`;
  }).join('');
}

function changeQty(code, delta) {
  const q = Math.max(0, (state.cart[code] || 0) + delta);
  if (q === 0) delete state.cart[code];
  else state.cart[code] = q;
  try { localStorage.setItem('cc_cart_' + state.vendor, JSON.stringify(state.cart)); } catch (e) {}
  updateCartBadge();
  renderGrid();
}

function updateCartBadge() {
  const n = Object.values(state.cart).reduce((a, b) => a + b, 0);
  const el = document.getElementById('cart-count');
  if (el) el.textContent = String(n);
}

function toggleCart(open) {
  const m = document.getElementById('cc-cart');
  if (!m) return;
  if (open) renderCart();
  m.classList.toggle('hidden', !open);
}

function renderCart() {
  const box = document.getElementById('cc-cart-items');
  if (!box) return;
  const prods = state.catalog ? (state.catalog.products || []) : [];
  const entries = Object.keys(state.cart).map(code => ({
    p: prods.find(x => String(x.code) === String(code)),
    qty: state.cart[code]
  })).filter(x => x.p && x.qty > 0);
  if (!entries.length) {
    box.innerHTML = `<p class="text-xs text-slate-400 text-center p-6">Tu consulta está vacía. Agrega productos del catálogo.</p>`;
    return;
  }
  box.innerHTML = entries.map(({ p, qty }) => `
    <div class="p-3 flex items-center gap-3">
      <div class="w-12 h-12 rounded-lg bg-slate-50 overflow-hidden shrink-0 flex items-center justify-center">
        ${p.image ? `<img src="${p.image}" onerror="this.outerHTML='<i class=\\\'fa-solid fa-box text-slate-300\\\'></i>'" class="w-full h-full object-contain">` : `<i class="fa-solid fa-box text-slate-300"></i>`}
      </div>
      <div class="flex-1 min-w-0">
        <div class="text-xs font-bold text-slate-900 truncate">${p.name}</div>
        <div class="text-[10px] text-slate-400">#${p.code}</div>
      </div>
      <div class="flex items-center gap-1.5 shrink-0">
        <button onclick="changeQty('${p.code}', -1);renderCart()" class="w-8 h-8 rounded-lg bg-slate-100 font-bold">−</button>
        <span class="text-xs font-extrabold w-4 text-center">${qty}</span>
        <button onclick="changeQty('${p.code}', 1);renderCart()" class="w-8 h-8 rounded-lg bg-slate-100 font-bold">+</button>
      </div>
    </div>`).join('');
}

function sendOrder() {
  const seller = (state.catalog && state.catalog.seller) || {};
  const wa = String(seller.whatsapp || "").replace(/\D/g, "");
  if (!wa) {
    alert("Este catálogo aún no tiene WhatsApp configurado.");
    return;
  }
  const prods = state.catalog.products || [];
  const lines = Object.keys(state.cart).map(code => {
    const p = prods.find(x => String(x.code) === String(code));
    return p ? `• ${state.cart[code]} x ${p.name} (#${p.code})` : null;
  }).filter(Boolean);
  if (!lines.length) {
    alert("Agrega productos antes de enviar.");
    return;
  }
  const msg = `Hola ${seller.name || ''}, quiero consultar estos productos:%0A${encodeURIComponent(lines.join('\n'))}`;
  window.open(`https://wa.me/${wa}?text=${msg}`, "_blank");
}

function maybeOffer() {
  const offer = state.catalog && state.catalog.offer;
  if (!offer || !offer.enabled || !offer.image) return;

  // Validación de vigencia de fechas si están definidas
  const todayStr = new Date().toISOString().slice(0, 10);
  if (offer.start && todayStr < offer.start) return;
  if (offer.end && todayStr > offer.end) return;

  // Evitar reabrirlo en la misma sesión si el usuario ya lo cerró
  if (sessionStorage.getItem(`cc_offer_closed_${state.vendor}`)) return;

  const modal = document.getElementById('cc-offer');
  const img = document.getElementById('cc-offer-image');
  const t = document.getElementById('cc-offer-title');
  const cta = document.getElementById('cc-offer-cta');

  if (img) {
    state.offerImages = parseOfferImages(offer.image);
    state.offerIdx = 0;
    showOfferImage();
    img.onerror = () => {
      // Si la URL de la imagen falla o no carga, ocultar el modal para no bloquear al usuario
      if (modal) modal.classList.add('hidden');
    };
    enableOfferSwipe();
  }
  if (t) t.textContent = offer.title || 'Oferta especial';
  if (cta) cta.textContent = offer.cta || 'Ver productos';

  if (modal) {
    modal.classList.remove('hidden');
    // Prevenir scroll en el fondo mientras el modal está abierto
    document.body.style.overflow = 'hidden';
  }
}

function showOfferImage() {
  const imgs = state.offerImages || [];
  if (!imgs.length) return;
  state.offerIdx = Math.max(0, Math.min(state.offerIdx || 0, imgs.length - 1));
  const img = document.getElementById('cc-offer-image');
  if (img) {
    img.src = imgs[state.offerIdx];
  }
  const prev = document.getElementById('cc-offer-prev');
  const next = document.getElementById('cc-offer-next');
  const counter = document.getElementById('cc-offer-counter');
  const multi = imgs.length > 1;

  if (prev) { prev.classList.toggle('hidden', !multi); prev.classList.toggle('flex', multi); }
  if (next) { next.classList.toggle('hidden', !multi); next.classList.toggle('flex', multi); }
  if (counter) {
    counter.classList.toggle('hidden', !multi);
    counter.textContent = `${state.offerIdx + 1} / ${imgs.length}`;
  }

  const dots = document.getElementById('cc-offer-dots');
  if (dots) {
    dots.innerHTML = multi ? imgs.map((_, i) =>
      `<button onclick="showOfferAt(${i})" aria-label="Imagen ${i + 1}" class="h-2 rounded-full transition-all duration-200 ${i === state.offerIdx ? 'w-6 bg-white shadow-sm' : 'w-2 bg-white/50 hover:bg-white/80'}"></button>`
    ).join('') : '';
  }
}

function showOfferAt(i) {
  state.offerIdx = i;
  showOfferImage();
}

function moveOffer(delta) {
  const n = (state.offerImages || []).length;
  if (!n) return;
  state.offerIdx = ((state.offerIdx || 0) + delta + n) % n;
  showOfferImage();
}

function enableOfferSwipe() {
  const stage = document.getElementById('cc-offer-stage');
  if (!stage || stage.dataset.swipe === '1') return;
  stage.dataset.swipe = '1';
  let x0 = null;
  stage.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    x0 = null;
    if (Math.abs(dx) > 40) moveOffer(dx < 0 ? 1 : -1);
  }, { passive: true });
}

function closeOffer() {
  const modal = document.getElementById('cc-offer');
  if (modal) modal.classList.add('hidden');
  document.body.style.overflow = '';
  // Marcar como cerrado en esta sesión para no ser molesto al navegar
  try {
    sessionStorage.setItem(`cc_offer_closed_${state.vendor}`, "1");
  } catch (e) {}
}
