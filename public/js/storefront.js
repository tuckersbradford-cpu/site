(function (global) {
  var MASK_NAMES = [
    'Personal Development Ebook', 'Financial Freedom Ebook', 'Digital Marketing Guide',
    'Health & Wellness Ebook', 'Productivity Masterclass', 'Mindfulness & Meditation Guide',
    'Entrepreneurship Blueprint'
  ];

  function normalizeOrigin(u) {
    try { return new URL(u).origin; } catch (e) { return ''; }
  }

  function pickMaskedName(custom) {
    if (custom && String(custom).trim()) return String(custom).trim();
    return MASK_NAMES[Math.floor(Math.random() * MASK_NAMES.length)];
  }

  function ebooksSuccessUrl(ebooksOrigin, price, maskedName, displayTitle, videoId) {
    var origin = normalizeOrigin(String(ebooksOrigin || '').replace(/\/+$/, ''));
    if (!origin) return null;
    var p = new URLSearchParams();
    p.set('status', 'success');
    p.set('product_name', pickMaskedName(maskedName));
    if (displayTitle) p.set('display_title', String(displayTitle));
    p.set('amount', String(price));
    if (videoId) p.set('video_id', String(videoId));
    return origin + '/?' + p.toString();
  }

  function checkoutQuery(ebooksOrigin, price, maskedName, displayTitle, videoId, method, extra) {
    var origin = normalizeOrigin(String(ebooksOrigin || '').trim().replace(/\/+$/, ''));
    if (!origin) return null;
    var vid = videoId || '';
    var title = displayTitle || 'Digital purchase';
    var masked = pickMaskedName(maskedName);
    var successUrl = ebooksSuccessUrl(origin, price, masked, title, vid);
    if (!successUrl) return null;
    var p = new URLSearchParams();
    p.set('amount', String(price));
    p.set('currency', 'USD');
    p.set('success_url', successUrl);
    p.set('product_name', masked);
    p.set('display_title', title);
    p.set('method', method || 'paypal');
    if (vid) p.set('video_id', vid);
    if (extra) {
      Object.keys(extra).forEach(function (k) {
        if (extra[k] != null && extra[k] !== '') p.set(k, String(extra[k]));
      });
    }
    return p;
  }

  function checkoutCancelUrl(origin, checkoutParams) {
    var cancelP = new URLSearchParams(checkoutParams.toString());
    cancelP.set('payment_canceled', 'true');
    return origin + '/api/paypal-checkout?' + cancelP.toString();
  }

  function checkoutUrl(ebooksOrigin, price, maskedName, displayTitle, videoId, method) {
    var origin = normalizeOrigin(String(ebooksOrigin || '').trim().replace(/\/+$/, ''));
    var p = checkoutQuery(ebooksOrigin, price, maskedName, displayTitle, videoId, method);
    if (!p || !origin) return null;
    p.set('cancel_url', checkoutCancelUrl(origin, p));
    return origin + '/api/paypal-checkout?' + p.toString();
  }

  function watchUrl(videoId, preview) {
    var u = '/watch?id=' + encodeURIComponent(videoId || '');
    if (preview) u += '&preview=1';
    return u;
  }

  function formatDuration(d) {
    if (d == null || d === '') return '';
    if (typeof d === 'number' && !isNaN(d)) {
      var sec = Math.max(0, Math.round(Number(d)));
      var m = Math.floor(sec / 60), s = sec % 60;
      return m + 'min ' + s + 's';
    }
    var parts = String(d).split(':');
    if (parts.length === 2) {
      var mm = parseInt(parts[0], 10) || 0, ss = Math.round(parseFloat(parts[1]) || 0);
      return mm + 'min ' + ss + 's';
    }
    if (parts.length === 3) {
      var h = parseInt(parts[0], 10) || 0, mm2 = parseInt(parts[1], 10) || 0, ss2 = Math.round(parseFloat(parts[2]) || 0);
      return h + 'h ' + mm2 + 'm ' + ss2 + 's';
    }
    return String(d);
  }

  function formatViews(v) {
    v = Number(v) || 0;
    if (v < 1000) return v + ' views';
    if (v < 1e6) return (v / 1000).toFixed(1) + 'K views';
    return (v / 1e6).toFixed(1) + 'M views';
  }

  function formatDateRel(iso) {
    if (!iso) return '';
    var date = new Date(iso), now = new Date();
    var diff = Math.ceil(Math.abs(now - date) / (864e5));
    if (diff <= 1) return 'Yesterday';
    if (diff < 7) return diff + ' days ago';
    if (diff < 30) return Math.floor(diff / 7) + ' weeks ago';
    if (diff < 365) return Math.floor(diff / 30) + ' months ago';
    return Math.floor(diff / 365) + ' years ago';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  }

  function escapeAttr(s) { return escapeHtml(s).replace(/'/g, '&#39;'); }

  async function fetchSigned(fileKey) {
    if (!fileKey) return null;
    var r = await fetch('/api/signed-url?key=' + encodeURIComponent(String(fileKey).trim()));
    if (!r.ok) return null;
    var j = await r.json();
    return j.success && j.url ? j.url : null;
  }

  function tgUrlForVideo(v, tgUser) {
    var msg =
      '🎬 **' + v.title + '**\n\n' +
      '💰 **Price:** $' + Number(v.price).toFixed(2) + '\n' +
      '⏱️ **Duration:** ' + (formatDuration(v.duration) || '—') + '\n' +
      '👀 **Views:** ' + formatViews(v.views) + '\n' +
      '📅 **Added:** ' + formatDateRel(v.created_at) + '\n\n' +
      '📝 **Description:**\n' + (v.description || 'No description') + '\n\n' +
      'Please let me know how to proceed with payment.';
    var enc = encodeURIComponent(msg);
    if (tgUser) return 'https://t.me/' + tgUser + '?text=' + enc;
    return 'https://t.me/share/url?url=&text=' + enc;
  }

  function tgUrlCryptoProof(v, tgUser, wallets) {
    var lines = (wallets || []).map(function (w) {
      return '• ' + String(w.label || w.symbol || 'Wallet').toUpperCase() + ': ' + String(w.address || '');
    }).join('\n');
    var msg =
      'Crypto $' + Number(v.price).toFixed(2) + ' — ' + v.title + '\n' +
      lines + '\n' +
      'TX hash:';
    var enc = encodeURIComponent(msg);
    if (tgUser) return 'https://t.me/' + tgUser + '?text=' + enc;
    return 'https://t.me/share/url?url=&text=' + enc;
  }

  function tgUrlPaymentSuccess(info, tgUser) {
    var lines = [
      '🎉 Payment successful!',
      '',
      '🎬 **Video:** ' + (info.displayTitle || info.product || 'Digital purchase'),
      info.amount ? '💰 **Amount:** $' + info.amount + ' USD' : '',
      info.orderId ? '🧾 **Order:** ' + info.orderId : '',
      info.videoId ? '🆔 **Reference:** ' + info.videoId : '',
      '',
      'Please send me access to the content. Thank you!'
    ].filter(Boolean).join('\n');
    var enc = encodeURIComponent(lines);
    if (tgUser) return 'https://t.me/' + tgUser + '?text=' + enc;
    return 'https://t.me/share/url?url=&text=' + enc;
  }

  function copyToClipboard(text, btn) {
    text = String(text || '');
    if (btn && !btn.getAttribute('data-label')) {
      btn.setAttribute('data-label', (btn.textContent || 'Copy').trim());
    }
    function done(ok) {
      if (!btn) return;
      btn.textContent = ok ? 'Copied' : 'Copy failed';
      setTimeout(function () {
        btn.textContent = btn.getAttribute('data-label') || 'Copy';
      }, 1600);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }).catch(function () { done(false); });
      return;
    }
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done(true);
    } catch (e) {
      done(false);
    }
  }

  function resolvePlaybackUrl(v) {
    if (v.public_video_url && /^https?:\/\//i.test(String(v.public_video_url).trim())) {
      return Promise.resolve(String(v.public_video_url).trim());
    }
    if (v.playback_url && /^https?:\/\//i.test(v.playback_url)) {
      return Promise.resolve(v.playback_url);
    }
    if (v.wasabi_video_key) return fetchSigned(v.wasabi_video_key);
    return Promise.resolve(null);
  }

  global.Storefront = {
    MASK_NAMES: MASK_NAMES,
    normalizeOrigin: normalizeOrigin,
    pickMaskedName: pickMaskedName,
    ebooksSuccessUrl: ebooksSuccessUrl,
    checkoutUrl: checkoutUrl,
    watchUrl: watchUrl,
    formatDuration: formatDuration,
    formatViews: formatViews,
    formatDateRel: formatDateRel,
    escapeHtml: escapeHtml,
    escapeAttr: escapeAttr,
    fetchSigned: fetchSigned,
    tgUrlForVideo: tgUrlForVideo,
    tgUrlCryptoProof: tgUrlCryptoProof,
    tgUrlPaymentSuccess: tgUrlPaymentSuccess,
    copyToClipboard: copyToClipboard,
    resolvePlaybackUrl: resolvePlaybackUrl
  };
})(typeof window !== 'undefined' ? window : this);
