/* Nesto Stays — customer frontend.
   Reads listings live from Supabase (anon key, public read). No build step. */

(function () {
  "use strict";

  var cfg = window.NESTO_CONFIG || {};
  var SUPABASE_URL = cfg.SUPABASE_URL || "";
  var ANON_KEY = cfg.SUPABASE_ANON_KEY || "";
  var OWNER_WHATSAPP = String(cfg.OWNER_WHATSAPP || "").replace(/\D/g, "");

  var INTERNAL_TAGS = { "unverified-find": 1, "tourism-registry": 1 };

  var state = { q: "", region: "all", vibes: {}, verifiedOnly: false, sort: "recommended", lang: "en" };
  var LISTINGS = [];

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function t(key) {
    var d = window.NESTO_I18N[state.lang] || {};
    var v = d[key] !== undefined ? d[key] : window.NESTO_I18N.en[key];
    if (typeof v === "function") return v.apply(null, Array.prototype.slice.call(arguments, 1));
    return v === undefined ? key : v;
  }

  /* ---------- i18n ---------- */
  function applyI18n() {
    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      el.textContent = t(el.getAttribute("data-i18n"));
    });
    document.querySelectorAll("[data-i18n-ph]").forEach(function (el) {
      el.placeholder = t(el.getAttribute("data-i18n-ph"));
    });
    document.documentElement.lang = state.lang === "hi" ? "hi" : "en";
    $("langToggle").textContent = state.lang === "hi" ? "English" : "हिन्दी";
  }

  /* ---------- WhatsApp helpers ---------- */
  function digits(s) { return String(s || "").replace(/\D/g, ""); }
  function toWaNumber(raw) {
    var d = digits(raw);
    if (d.length === 10) return "91" + d;
    if (d.length === 12 && d.indexOf("91") === 0) return d;
    return d;
  }
  function waLink(rawNumber, text) {
    var num = toWaNumber(rawNumber);
    if (!num) return null;
    return "https://wa.me/" + num + "?text=" + encodeURIComponent(text);
  }
  function primaryContact(l) {
    var contacts = Array.isArray(l.contacts) ? l.contacts : [];
    for (var i = 0; i < contacts.length; i++) {
      var c = contacts[i] || {};
      if ((c.type === "whatsapp" || c.type === "call") && c.number) return c;
    }
    return null;
  }
  function instagramHandle(l) {
    var contacts = Array.isArray(l.contacts) ? l.contacts : [];
    for (var i = 0; i < contacts.length; i++) {
      var c = contacts[i] || {};
      if (c.type === "instagram" && (c.url || c.handle)) return c;
    }
    return null;
  }

  /* ---------- Photos ---------- */
  function placeholderSVG(name) {
    var initial = (String(name || "N").trim().charAt(0) || "N").toUpperCase();
    var svg =
      "<svg xmlns='http://www.w3.org/2000/svg' width='800' height='600'>" +
      "<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>" +
      "<stop offset='0' stop-color='#0B5FA5'/><stop offset='1' stop-color='#084A80'/>" +
      "</linearGradient></defs>" +
      "<rect width='800' height='600' fill='url(#g)'/>" +
      "<text x='400' y='340' font-family='Georgia,serif' font-style='italic' font-weight='bold' " +
      "font-size='230' fill='#F5B301' text-anchor='middle'>" + esc(initial) + "</text>" +
      "<text x='400' y='430' font-family='sans-serif' font-size='32' fill='#ffffff' " +
      "text-anchor='middle' opacity='0.85'>Nesto Stays</text></svg>";
    return "data:image/svg+xml," + encodeURIComponent(svg);
  }
  function photoUrl(l) {
    var p = l.photo_path || "";
    if (!p || p.indexOf("assets/") === 0) return placeholderSVG(l.name);
    return p;
  }
  window.__nestoImgFallback = function (el) {
    el.onerror = null;
    el.src = placeholderSVG(el.getAttribute("data-name") || "N");
  };

  /* ---------- Data ---------- */
  function showOnly(id) {
    ["loadState", "errorState", "emptyState"].forEach(function (s) {
      $(s).hidden = s !== id;
    });
    if (id) $("grid").innerHTML = "";
  }

  async function loadListings() {
    showOnly("loadState");
    if (!SUPABASE_URL || !ANON_KEY || ANON_KEY.indexOf("PASTE_") === 0) {
      showOnly("errorState");
      return;
    }
    var url =
      SUPABASE_URL + "/rest/v1/listings?select=" +
      "id,name,town,region,region_group,price_display,price_min,position,description," +
      "photo_path,tags,contacts,details,host_profile,review_sources,nesto_verified," +
      "public_visibility,source_label,created_at" +
      "&order=display_order.asc&limit=500";
    try {
      var res = await fetch(url, {
        headers: { apikey: ANON_KEY, Authorization: "Bearer " + ANON_KEY },
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      var rows = await res.json();
      // public_visibility filter is client-side so the page also works
      // before the ingest migration has been run (column absent -> included).
      LISTINGS = rows.filter(function (r) { return r.public_visibility !== false; });
      buildFilters();
      render();
    } catch (e) {
      showOnly("errorState");
    }
  }

  /* ---------- Filters ---------- */
  function uniqueSorted(arr) {
    var seen = {}, out = [];
    arr.forEach(function (v) { if (v && !seen[v]) { seen[v] = 1; out.push(v); } });
    return out.sort();
  }

  function buildFilters() {
    var regions = uniqueSorted(LISTINGS.map(function (l) { return l.region_group; }));
    var vibeCounts = {};
    LISTINGS.forEach(function (l) {
      (l.tags || []).forEach(function (tag) {
        if (!INTERNAL_TAGS[tag]) vibeCounts[tag] = (vibeCounts[tag] || 0) + 1;
      });
    });
    var vibes = Object.keys(vibeCounts).sort(function (a, b) { return vibeCounts[b] - vibeCounts[a]; });

    var rc = $("regionChips");
    rc.innerHTML =
      '<button class="chip' + (state.region === "all" ? " active" : "") + '" data-region="all">' + esc(t("all_regions")) + "</button>" +
      regions.map(function (r) {
        return '<button class="chip' + (state.region === r ? " active" : "") + '" data-region="' + esc(r) + '">' + esc(r) + "</button>";
      }).join("");
    rc.querySelectorAll(".chip").forEach(function (chip) {
      chip.addEventListener("click", function () {
        rc.querySelectorAll(".chip").forEach(function (c) { c.classList.remove("active"); });
        chip.classList.add("active");
        state.region = chip.getAttribute("data-region");
        render();
      });
    });

    var vc = $("vibeChips");
    vc.innerHTML = vibes.map(function (v) {
      return '<button class="chip' + (state.vibes[v] ? " active" : "") + '" data-vibe="' + esc(v) + '">' + esc(v) + "</button>";
    }).join("");
    vc.querySelectorAll(".chip").forEach(function (chip) {
      chip.addEventListener("click", function () {
        var v = chip.getAttribute("data-vibe");
        if (state.vibes[v]) { delete state.vibes[v]; chip.classList.remove("active"); }
        else { state.vibes[v] = 1; chip.classList.add("active"); }
        render();
      });
    });
  }

  function filtered() {
    var q = state.q.trim().toLowerCase();
    var activeVibes = Object.keys(state.vibes);
    var out = LISTINGS.filter(function (l) {
      if (state.verifiedOnly && !l.nesto_verified) return false;
      if (state.region !== "all" && l.region_group !== state.region) return false;
      if (activeVibes.length && !activeVibes.every(function (v) { return (l.tags || []).indexOf(v) >= 0; })) return false;
      if (q) {
        var hay = [l.name, l.town, l.region_group, (l.tags || []).join(" ")].join(" ").toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
    var byPrice = function (l) { return l.price_min == null ? Infinity : l.price_min; };
    if (state.sort === "price_asc") out.sort(function (a, b) { return byPrice(a) - byPrice(b); });
    else if (state.sort === "price_desc") out.sort(function (a, b) { return byPrice(b) - byPrice(a); });
    else if (state.sort === "newest") out.sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); });
    else out.sort(function (a, b) { return (b.nesto_verified ? 1 : 0) - (a.nesto_verified ? 1 : 0); }); // recommended: verified first
    return out;
  }

  /* ---------- Render: cards ---------- */
  function badgeHTML(l) {
    if (l.nesto_verified) {
      return '<span class="badge verified">✓ ' + esc(t("verified_badge")) + "</span>";
    }
    return '<span class="badge unverified">' + esc(t("unverified_badge")) + "</span>";
  }

  function cardHTML(l) {
    var contact = primaryContact(l);
    var wa = contact ? waLink(contact.number, t("booking_msg_open", l.name, l.town)) : null;
    var priceNote = l.nesto_verified ? t("host_price_note") : t("unverified_price_note");
    var tags = (l.tags || []).filter(function (tag) { return !INTERNAL_TAGS[tag]; }).slice(0, 4);
    return (
      '<article class="card" data-id="' + esc(l.id) + '" tabindex="0" role="button" aria-label="' + esc(l.name) + '">' +
        '<div class="card-photo">' +
          '<img src="' + esc(photoUrl(l)) + '" alt="' + esc(l.name) + '" loading="lazy" data-name="' + esc(l.name) + '" onerror="window.__nestoImgFallback(this)">' +
          badgeHTML(l) +
        "</div>" +
        '<div class="card-body">' +
          '<h3 class="card-title">' + esc(l.name) + "</h3>" +
          '<p class="card-town">' + esc(l.town) + "</p>" +
          '<p class="card-price">' + esc(l.price_display || "") + "</p>" +
          '<p class="price-note-line">' + esc(priceNote) + "</p>" +
          (tags.length ? '<div class="tag-row">' + tags.map(function (tag) { return '<span class="tag">' + esc(tag) + "</span>"; }).join("") + "</div>" : "") +
          '<div class="card-actions">' +
            (wa ? '<a class="btn btn-whatsapp btn-sm" href="' + esc(wa) + '" target="_blank" rel="noopener" data-stop>' + esc(t("chat_host")) + "</a>" : "") +
            '<button class="btn btn-ghost btn-sm" data-details>' + esc(t("view_details")) + "</button>" +
          "</div>" +
          (l.nesto_verified ? "" :
            '<div class="claim-strip"><span>' + esc(t("claim_strip")) + '</span><button data-claim>' + esc(t("claim_now")) + "</button></div>") +
        "</div>" +
      "</article>"
    );
  }

  function render() {
    var list = filtered();
    showOnly(null);
    $("grid").innerHTML = list.map(cardHTML).join("");
    $("resultCount").textContent = t("stays_found", list.length);
    $("emptyState").hidden = list.length > 0;

    $("grid").querySelectorAll(".card").forEach(function (card) {
      var id = card.getAttribute("data-id");
      card.addEventListener("click", function (e) {
        if (e.target.closest("[data-stop]")) return;
        if (e.target.closest("[data-claim]")) { e.stopPropagation(); claimListing(findById(id)); return; }
        openDetail(id);
      });
      card.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(id); }
      });
    });
  }

  function findById(id) {
    for (var i = 0; i < LISTINGS.length; i++) if (String(LISTINGS[i].id) === String(id)) return LISTINGS[i];
    return null;
  }

  /* ---------- Render: detail modal ---------- */
  function sectionHTML(title, body) {
    if (!body) return "";
    return '<div class="detail-section"><h3>' + esc(title) + "</h3><p>" + esc(body) + "</p></div>";
  }

  function openDetail(id) {
    var l = findById(id);
    if (!l) return;
    var contact = primaryContact(l);
    var ig = instagramHandle(l);
    var details = l.details || {};
    var host = l.host_profile || {};
    var reviews = Array.isArray(l.review_sources) ? l.review_sources : [];
    var priceNote = l.nesto_verified ? t("host_price_note") : t("unverified_price_note");

    var contactBtns = "";
    if (contact) {
      var wa = waLink(contact.number, t("booking_msg_open", l.name, l.town));
      if (wa) contactBtns += '<a class="btn btn-whatsapp" href="' + esc(wa) + '" target="_blank" rel="noopener">' + esc(t("chat_host")) + "</a>";
    }
    if (ig && ig.url) {
      contactBtns += '<a class="btn btn-ghost" href="' + esc(ig.url) + '" target="_blank" rel="noopener">Instagram</a>';
    }

    $("modalBody").innerHTML =
      '<div class="modal-hero">' +
        '<img src="' + esc(photoUrl(l)) + '" alt="' + esc(l.name) + '" data-name="' + esc(l.name) + '" onerror="window.__nestoImgFallback(this)">' +
        badgeHTML(l) +
      "</div>" +
      '<div class="modal-content">' +
        "<h2 id='modalTitle'>" + esc(l.name) + "</h2>" +
        '<p class="modal-town">' + esc(l.town) + (l.region ? " · " + esc(l.region) : "") + "</p>" +
        (l.nesto_verified
          ? '<p class="verified-def">✓ <strong>' + esc(t("verified_badge")) + ".</strong> " + esc(t("verified_def")) + "</p>"
          : '<p class="verified-def">' + esc(t("unverified_note")) + "</p>") +
        '<div class="detail-grid"><div>' +
          sectionHTML(t("d_amenities"), details.amenities) +
          sectionHTML(t("d_meals"), details.meals) +
          sectionHTML(t("d_know"), details.know) +
          (host && host.name
            ? '<div class="detail-section"><h3>' + esc(t("d_host")) + "</h3>" +
              '<div class="host-card"><div class="host-avatar">' + esc(host.name.charAt(0).toUpperCase()) + "</div>" +
              "<div><strong>" + esc(host.name) + "</strong>" +
              (host.story ? "<p class='muted'>" + esc(host.story) + "</p>" : "") + "</div></div></div>"
            : "") +
          (reviews.length
            ? '<div class="detail-section"><h3>' + esc(t("d_reviews")) + "</h3>" +
              '<div class="review-links">' + reviews.map(function (r) {
                return r && r.url ? '<a class="btn btn-ghost btn-sm" href="' + esc(r.url) + '" target="_blank" rel="noopener">' + esc(r.label || "Reviews") + "</a>" : "";
              }).join("") + "</div></div>"
            : "") +
          (l.nesto_verified ? "" :
            '<div class="claim-banner"><div><strong>' + esc(t("claim_banner_t")) + "</strong><p>" + esc(t("claim_banner_b")) + "</p></div>" +
            '<button class="btn btn-sun btn-sm" id="modalClaim">' + esc(t("claim_now")) + "</button></div>") +
        "</div>" +
        '<div><div class="booking-box">' +
          '<p class="price">' + esc(l.price_display || "") + "</p>" +
          '<p class="price-note-line">' + esc(priceNote) + "</p>" +
          "<label>" + esc(t("checkin")) + '<input type="date" id="bkIn"></label>' +
          "<label>" + esc(t("checkout")) + '<input type="date" id="bkOut"></label>' +
          '<button class="btn btn-whatsapp" id="bkGo">' + esc(t("request_wa")) + "</button>" +
          '<p class="booking-note">' + esc(t("wa_opening")) + "</p>" +
          (contactBtns ? '<div class="contact-row">' + contactBtns + "</div>" : "") +
        "</div></div></div>" +
      "</div>";

    $("modalBackdrop").hidden = false;
    document.body.style.overflow = "hidden";

    $("bkGo").addEventListener("click", function () {
      if (!contact) { toast(t("toast_claim_soon")); return; }
      var ci = $("bkIn").value, co = $("bkOut").value;
      var msg = ci && co ? t("booking_msg_dates", l.name, l.town, ci, co) : t("booking_msg_open", l.name, l.town);
      var link = waLink(contact.number, msg);
      if (link) window.open(link, "_blank", "noopener");
    });
    var mc = $("modalClaim");
    if (mc) mc.addEventListener("click", function () { claimListing(l); });
  }

  function closeModal() {
    $("modalBackdrop").hidden = true;
    document.body.style.overflow = "";
  }

  /* ---------- Claim / refer / partner (via owner WhatsApp) ---------- */
  function toast(msg) {
    var el = $("toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(el.__timer);
    el.__timer = setTimeout(function () { el.hidden = true; }, 4000);
  }

  function claimListing(l) {
    if (!l || !OWNER_WHATSAPP) { toast(t("toast_claim_soon")); return; }
    window.open(waLink(OWNER_WHATSAPP, t("claim_msg", l.name, l.town)), "_blank", "noopener");
  }

  /* ---------- Events ---------- */
  function init() {
    applyI18n();

    $("langToggle").addEventListener("click", function () {
      state.lang = state.lang === "en" ? "hi" : "en";
      applyI18n();
      buildFilters();
      render();
    });
    $("menuBtn").addEventListener("click", function () {
      var nav = $("mainnav");
      var open = nav.classList.toggle("open");
      $("menuBtn").setAttribute("aria-expanded", open ? "true" : "false");
    });
    $("mainnav").querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", function () { $("mainnav").classList.remove("open"); });
    });

    var deb;
    $("searchInput").addEventListener("input", function (e) {
      clearTimeout(deb);
      deb = setTimeout(function () { state.q = e.target.value; render(); }, 200);
    });
    $("verifiedOnly").addEventListener("change", function (e) {
      state.verifiedOnly = e.target.checked;
      render();
    });
    $("sortSelect").addEventListener("change", function (e) {
      state.sort = e.target.value;
      render();
    });
    $("clearFilters").addEventListener("click", function () {
      state.q = ""; state.region = "all"; state.vibes = {}; state.verifiedOnly = false; state.sort = "recommended";
      $("searchInput").value = "";
      $("verifiedOnly").checked = false;
      $("sortSelect").value = "recommended";
      buildFilters();
      render();
    });
    $("retryBtn").addEventListener("click", loadListings);

    $("modalClose").addEventListener("click", closeModal);
    $("modalBackdrop").addEventListener("click", function (e) {
      if (e.target === $("modalBackdrop")) closeModal();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !$("modalBackdrop").hidden) closeModal();
    });

    $("becomeHostBtn").addEventListener("click", function () {
      if (!OWNER_WHATSAPP) { toast(t("toast_claim_soon")); return; }
      window.open(waLink(OWNER_WHATSAPP, t("host_msg")), "_blank", "noopener");
    });
    $("referForm").addEventListener("submit", function (e) {
      e.preventDefault();
      if (!OWNER_WHATSAPP) { toast(t("toast_refer_soon")); return; }
      var f = e.target;
      window.open(waLink(OWNER_WHATSAPP, t("refer_msg", f.name.value, f.phone.value, f.place.value)), "_blank", "noopener");
      f.reset();
    });
    $("partnerForm").addEventListener("submit", function (e) {
      e.preventDefault();
      if (!OWNER_WHATSAPP) { toast(t("toast_refer_soon")); return; }
      var f = e.target;
      window.open(waLink(OWNER_WHATSAPP, t("partner_msg", f.name.value, f.instagram.value, f.audience.value, f.location.value)), "_blank", "noopener");
      f.reset();
    });

    loadListings();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
