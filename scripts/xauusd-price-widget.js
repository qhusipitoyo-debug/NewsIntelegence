// Widget Harga XAU/USD
(function() {
  const container = document.getElementById('xauusd-price-widget');
  if (!container) return;

  async function fetchLivePrice() {
    // 1. Ambil harga real-time dari Gold-API (gratis)
    try {
      const r = await fetch('https://api.gold-api.com/price/XAU', { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        const p = Number(j.price);
        if (Number.isFinite(p) && p > 0) return p;
      }
    } catch (e) {}

    // 2. Fallback: Ambil dari file market.json (hasil GitHub Actions)
    try {
      const r = await fetch(`data/market.json?v=${Date.now()}`, { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        const p = Number(j.price);
        if (Number.isFinite(p) && p > 0) return p;
      }
    } catch (e) {}

    return null;
  }

  async function updateWidget() {
    const price = await fetchLivePrice();
    if (price) {
      const formatted = price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      
      container.innerHTML = `
        <div style="font-family:monospace;">
          <div style="display:flex; align-items:center; justify-content:flex-end; gap:6px;">
            <span style="color:#94a3b8; font-size:11px; font-weight:600;">XAU/USD</span>
            <span style="color:#10b981; font-size:15px; font-weight:bold;">$${formatted}</span>
          </div>
          <div style="color:#10b981; font-size:10px; text-align:right;">● LIVE</div>
        </div>
      `;
      
      // Kirim harga terbaru ke index.html agar TP/SL terupdate otomatis
      if (window.applyLiveXauPrice) {
        window.applyLiveXauPrice(price);
      }
    } else {
      container.innerHTML = `
        <div style="color:#f43f5e; font-size:11px; font-family:monospace; text-align:right;">
          XAU/USD ● OFFLINE
        </div>
      `;
    }
  }

  updateWidget();
  setInterval(updateWidget, 30000); 
})();
