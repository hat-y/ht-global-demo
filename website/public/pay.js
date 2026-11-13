// Demo checkout: reads the quote options from the link the customer got by email. No real payment.
(function () {
  var p = new URLSearchParams(location.search);
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : null; }
  function money(n) { return n == null ? '—' : 'USD ' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function opt(k, fallbackLabel) {
    var qty = num(p.get(k + 'q')); if (qty == null) return null;
    return { key: k, label: p.get(k + 'l') || fallbackLabel, qty: qty, unit: num(p.get(k + 'u')), nre: num(p.get(k + 'n')) || 0, lead: num(p.get(k + 'd')) };
  }
  var options = [opt('a', 'Option A'), opt('b', 'Option B')].filter(Boolean);
  if (options.length === 2) options.push({ key: 'ab', label: 'Both options', qty: options[0].qty + options[1].qty, both: true });
  var quote = (p.get('quote') || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 20);
  document.getElementById('q').textContent = quote || '—';
  function totalOf(o) {
    if (o.both) return totalOf(options[0]) + totalOf(options[1]);
    return (o.qty * (o.unit || 0)) + (o.nre || 0);
  }
  var box = document.getElementById('options'); var selected = null;
  function pick(o) {
    selected = o;
    Array.prototype.forEach.call(box.children, function (el) { el.classList.toggle('sel', el.dataset.key === o.key); });
    var nre = o.both ? options[0].nre + options[1].nre : o.nre;
    var lead = o.both ? options[0].lead + ' and ' + options[1].lead + ' days' : (o.lead == null ? '—' : o.lead + ' days');
    document.getElementById('s-boards').textContent = o.qty.toLocaleString('en-US');
    document.getElementById('s-nre').textContent = money(nre);
    document.getElementById('s-lead').textContent = lead;
    document.getElementById('s-total').textContent = money(totalOf(o));
  }
  options.forEach(function (o) {
    var b = document.createElement('button'); b.type = 'button'; b.className = 'opt'; b.dataset.key = o.key;
    var left = document.createElement('div'); var h = document.createElement('h3'); h.textContent = o.label; var d = document.createElement('p');
    d.textContent = o.both ? 'Prototypes first, then production' : o.qty.toLocaleString('en-US') + ' boards · ' + money(o.unit) + ' each · NRE ' + money(o.nre) + (o.lead == null ? '' : ' · ' + o.lead + ' days');
    left.appendChild(h); left.appendChild(d);
    var right = document.createElement('div'); right.className = 'price'; right.textContent = money(totalOf(o));
    b.appendChild(left); b.appendChild(right); b.addEventListener('click', function () { pick(o); }); box.appendChild(b);
  });
  var want = (p.get('choose') || '').toLowerCase();
  pick(options.filter(function (o) { return o.key === want; })[0] || options[options.length > 2 ? 1 : 0] || { key: '', qty: 0 });
  document.getElementById('pay').addEventListener('submit', function (e) {
    e.preventDefault(); var btn = document.getElementById('paybtn'); btn.disabled = true; btn.textContent = 'Processing…';
    setTimeout(function () {
      document.getElementById('checkout').hidden = true; document.getElementById('done').hidden = false;
      document.getElementById('d-desc').textContent = selected.label + ' (' + selected.qty.toLocaleString('en-US') + ' boards)';
      document.getElementById('d-total').textContent = money(totalOf(selected));
      document.getElementById('d-ref').textContent = 'PAY-' + (quote || 'DEMO') + '-' + Date.now().toString().slice(-5);
      window.scrollTo(0, 0);
    }, 1400);
  });
})();
