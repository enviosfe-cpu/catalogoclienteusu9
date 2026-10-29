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

  // Limpiar bandera de sesión previa para que la alerta emergente abra siempre al iniciar la app
  try { sessionStorage.removeItem(`cc_offer_closed_${state.vendor}`); } catch (e) {}

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
    if (isOfferActive(offer)) {
      html += `
        <button onclick="openOffer()" class="cc-hero-offer-link">
          <span class="cc-dot-red"></span>Ver oferta
        </button>`;
    }
    hl.innerHTML = html;
  }

  // Portada: selección curada de fotos reales del catálogo.
  // Se priorizan fotos con fondo claro para que la mezcla con el marco crema sea limpia.
  const hero = document.getElementById('cc-hero');
  const withImages = (c.products || []).filter(p => p.image);
  const heroProducts = [withImages[3], withImages[0], withImages[4]].filter(Boolean);
  [1, 2, 3].forEach((n, i) => {
    const frame = document.getElementById(`cc-hero-frame-${n}`);
    const img = document.getElementById(`cc-hero-img-${n}`);
    if (!frame || !img) return;
    const p = heroProducts[i];
    if (!p) { frame.style.display = 'none'; return; }
    frame.style.display = '';
    img.src = p.image;
    img.alt = p.name || '';
    img.onerror = () => { frame.style.display = 'none'; };
  });
  if (hero) hero.classList.toggle('cc-hero-no-stage', heroProducts.length === 0);

  const seal = document.getElementById('cc-hero-offer');
  if (seal) seal.classList.toggle('hidden', !isOfferActive(offer));

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
    img.onerror = () => {
      if (modal) modal.classList.add('hidden');
      document.body.style.overflow = '';
    };
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

// Normaliza texto para búsqueda tolerante a mayúsculas, minúsculas y tildes
function normStr(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function clearClientSearch() {
  const input = document.getElementById('cc-search');
  if (input) input.value = '';
  renderGrid();
}

function renderGrid() {
  const grid = document.getElementById('cc-grid');
  const empty = document.getElementById('cc-empty');
  const emptyMsg = document.getElementById('cc-empty-msg');
  const count = document.getElementById('cc-grid-count');
  if (!grid || !state.catalog) return;

  const rawQ = (document.getElementById('cc-search')?.value || '').trim();
  const clearBtn = document.getElementById('cc-search-clear');
  if (clearBtn) {
    if (rawQ) clearBtn.classList.remove('hidden');
    else clearBtn.classList.add('hidden');
  }

  const q = normStr(rawQ);
  const items = (state.catalog.products || []).filter(p => {
    if (!q) return true;
    const nameMatch = normStr(p.name).includes(q);
    const codeMatch = normStr(p.code).includes(q);
    const catMatch = normStr(p.categoryName || p.category).includes(q);
    const supMatch = normStr(p.supplierName || p.supplier).includes(q);
    return nameMatch || codeMatch || catMatch || supMatch;
  });

  if (count) count.textContent = `${items.length} producto${items.length === 1 ? '' : 's'}`;

  if (!items.length) {
    grid.innerHTML = '';
    if (emptyMsg) {
      emptyMsg.textContent = rawQ
        ? `No encontramos productos para “${rawQ}”.`
        : 'Aún no hay productos publicados.';
    }
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');
  grid.innerHTML = items.map((p, i) => {
    const qty = state.cart[p.code] || 0;
    const sub = [p.supplierName || p.supplier, p.categoryName || p.category].filter(Boolean).join(' · ');
    const image = p.image
      ? `<img src="${p.image}" alt="${p.name}" loading="lazy" onerror="this.style.display='none';this.parentElement.querySelector('.cc-card-fallback').style.display='grid'">`
      : '';
    const fallbackStyle = p.image ? ' style="display:none"' : '';
    return `
    <article class="cc-card" style="--d:${Math.min(i * 28, 220)}ms">
      <div class="cc-card-media">
        ${image}
        <span class="cc-card-fallback"${fallbackStyle}><i class="fa-solid fa-box"></i></span>
        <span class="cc-code">#${p.code}</span>
      </div>
      <div class="cc-card-body">
        <h3>${p.name}</h3>
        ${sub ? `<div class="cc-card-meta">${sub}</div>` : ''}
        <div class="cc-card-foot">
          ${qty > 0 ? `
          <div class="cc-qty">
            <span class="cc-qty-label">En consulta</span>
            <div class="cc-qty-controls">
              <button onclick="changeQty('${p.code}', -1)" aria-label="Quitar una unidad">−</button>
              <span>${qty}</span>
              <button onclick="changeQty('${p.code}', 1)" aria-label="Agregar una unidad">+</button>
            </div>
          </div>` : `
          <button class="cc-card-add" onclick="changeQty('${p.code}', 1)" aria-label="Agregar producto">
            <span>Agregar</span><i class="fa-solid fa-plus"></i>
          </button>`}
        </div>
      </div>
    </article>`;
  }).join('');
}

function changeQty(code, delta) {
  const q = Math.max(0, (state.cart[code] || 0) + delta);
  if (q === 0) delete state.cart[code];
  else state.cart[code] = q;
  try { localStorage.setItem('cc_cart_' + state.vendor, JSON.stringify(state.cart)); } catch (e) {}
  updateCartBadge();
  renderGrid();

  if (delta > 0) {
    const bottomBtn = document.querySelector('.cc-bottombar-btn');
    if (bottomBtn) {
      bottomBtn.classList.remove('cc-pulse');
      void bottomBtn.offsetWidth;
      bottomBtn.classList.add('cc-pulse');
    }
  }
}

function updateCartBadge() {
  const n = Object.values(state.cart).reduce((a, b) => a + b, 0);
  const total = `${n} producto${n === 1 ? '' : 's'}`;

  const el = document.getElementById('cart-count');
  if (el) el.textContent = String(n);

  const barCount = document.getElementById('cc-bottombar-count');
  if (barCount) barCount.textContent = String(n);

  const barLabel = document.getElementById('cc-bottombar-label');
  if (barLabel) barLabel.textContent = total;

  const cartCount = document.getElementById('cc-cart-count');
  if (cartCount) cartCount.textContent = `${total} en tu consulta`;
}

function toggleCart(open) {
  const m = document.getElementById('cc-cart');
  if (!m) return;
  if (open) renderCart();
  m.classList.toggle('hidden', !open);
  document.body.style.overflow = open ? 'hidden' : '';
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
    box.innerHTML = `
      <div class="cc-cart-empty">
        <i class="fa-solid fa-bag-shopping"></i>
        <b>Tu consulta está vacía</b>
        <p>Agrega productos del catálogo para enviarlos por WhatsApp.</p>
      </div>`;
    return;
  }
  box.innerHTML = entries.map(({ p, qty }) => `
    <div class="cc-cart-item">
      <div class="cc-cart-thumb">
        <i class="fa-solid fa-box"></i>
        ${p.image ? `<img src="${p.image}" alt="${p.name}" onerror="this.style.display='none'">` : ''}
      </div>
      <div class="cc-cart-info">
        <b>${p.name}</b>
        <span>#${p.code}</span>
      </div>
      <div class="cc-cart-qty">
        <button onclick="changeQty('${p.code}', -1);renderCart()" aria-label="Quitar una unidad">−</button>
        <span>${qty}</span>
        <button onclick="changeQty('${p.code}', 1);renderCart()" aria-label="Agregar una unidad">+</button>
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

function isOfferActive(offer) {
  if (!offer || !offer.enabled || !offer.image) return false;
  const nowMs = Date.now();
  if (offer.start) {
    const s = new Date(offer.start).getTime();
    if (!isNaN(s) && nowMs < s) return false;
  }
  if (offer.end) {
    const e = new Date(offer.end);
    if (!isNaN(e.getTime())) {
      e.setHours(23, 59, 59, 999);
      if (nowMs > e.getTime()) return false;
    }
  }
  return true;
}

function maybeOffer() {
  const offer = state.catalog && state.catalog.offer;
  if (!isOfferActive(offer)) return;

  // Solo mostrar una vez por apertura/carga de la app (evita reapertura en segundo plano)
  if (state.offerShownThisLoad) return;
  state.offerShownThisLoad = true;

  // Desplegar la alerta emergente automáticamente
  setTimeout(() => {
    openOffer();
  }, 250);
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
      `<button onclick="showOfferAt(${i})" aria-label="Imagen ${i + 1}" class="cc-dot${i === state.offerIdx ? ' cc-dot-active' : ''}"></button>`
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
}
