// ============================================================================
// 🌱🔗 seed-share — Supabase Edge Function (Deno)
//
// Serves the marketplace study-template SHARE surface on a dedicated branded
// domain (share.fluera.dev), doing BOTH jobs from ONE origin:
//
//   • GET /s/{hash}                              → the dynamic OG page (the
//       social-unfurl preview = the worksheet og:image). Crawlers do NOT run JS,
//       so the per-template og:* tags MUST be server-rendered — this is why a
//       static host (fluera.dev is GitHub Pages) can't do it and we need a
//       serverless runtime. We already have Supabase → a Deno Edge Function.
//   • GET /i/{code}                              → the referral redirect (M3):
//       the end-card/QR link burned into every shared time-lapse. UA-sniffs to
//       the right store carrying the code in the Play install referrer. Lives
//       HERE (not on fluera.dev) for the same reason as /s: GitHub Pages is
//       static — the old Vercel api/i.ts was never deployable on it, so every
//       shipped QR pointed at a 404 until this route existed.
//   • GET /.well-known/apple-app-site-association → iOS Universal Links claim
//   • GET /.well-known/assetlinks.json            → Android App Links claim
//
// Because the deep-link verification files live on the SAME domain that the
// share link uses, tapping share.fluera.dev/s/{hash} opens the app (when
// installed + verified) and the browser/crawler otherwise sees the OG page.
//
// DEPLOY: supabase functions deploy seed-share --no-verify-jwt   (public, anon)
//   then map the custom domain share.fluera.dev to this function. Secrets:
//   ANDROID_PACKAGE, APPLE_TEAM_ID, APPLE_APP_ID (optional), ANDROID_SHA256.
//   SUPABASE_URL + SUPABASE_ANON_KEY are injected automatically.
// ============================================================================

// Import STATICO: dev'essere risolto al build, non a runtime (vedi loadResvg).
import { initWasm, Resvg } from "https://esm.sh/@resvg/resvg-wasm@2.6.2";

const BUCKET = "public-study-seeds";
const SITE = "https://fluera.dev";
const BUNDLE_ID = Deno.env.get("ANDROID_PACKAGE") ?? "com.fluera.fluera";
const APPLE_TEAM_ID = Deno.env.get("APPLE_TEAM_ID") ?? "7T5647HRV6";
const APPLE_APP_ID = Deno.env.get("APPLE_APP_ID") ?? ""; // numeric store id, when published
const ANDROID_SHA256 = Deno.env.get("ANDROID_SHA256") ??
  "EB:AD:BC:7F:CB:BA:F4:A6:B7:B5:62:8B:50:92:50:F8:28:B7:9D:A3:0B:76:92:BC:61:B7:81:FD:C6:4C:EE:C2";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
// Auto-injected in Supabase Edge Functions; used ONLY by the anon report POST
// handler to call the service-role-only file_takedown_notice RPC.
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const OG_FALLBACK = `${SITE}/og/default.png`;
const HASH_RE = /[A-Za-z0-9]{8,64}/;

interface SeedRow {
  hash: string;
  author_code: string | null;
  title: string | null;
  description: string | null;
  discipline: string | null;
  concept_count: number | null;
  thumb_path: string | null;
  og_path: string | null;
  is_official: boolean | null;
  install_count: number | null;
  rating_sum: number | null;
  rating_count: number | null;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const reqUrl = new URL(req.url);
  const path = reqUrl.pathname;

  // ── Deep-link verification (App / Universal Links claim share.fluera.dev) ──
  if (path.endsWith("/.well-known/apple-app-site-association")) {
    // /u/* = creator pages: the app produces share.fluera.dev/u/{author_code}
    // links (creator_profile_screen) and handles them in-app (creatorCodeOf) —
    // claiming them here is what makes an installed app open them at all. A
    // server-rendered /u page for NON-installed visitors is a follow-up; until
    // then those visitors fall through to the marketing-site redirect below.
    // /collab/* = inviti a una sessione dal vivo. A differenza di /c/ (che si
    // GUARDA e basta, quindi rivendicarlo faceva solo rimbalzare l'utente), qui
    // l'app è l'unico posto dove l'invito ha senso: rivendicarlo evita che chi
    // ce l'ha già passi dalla pagina di consegna.
    return json({
      applinks: { apps: [], details: [{ appID: `${APPLE_TEAM_ID}.${BUNDLE_ID}`, paths: ["/s/*", "/i/*", "/u/*", "/collab/*", "/p", "/p/*"] }] },
    });
  }
  if (path.endsWith("/.well-known/assetlinks.json")) {
    // Comma-separate ANDROID_SHA256 to authorize MULTIPLE signing certs at once
    // (e.g. release + your debug keystore, so App Links auto-verify on a
    // `flutter run` build too — not just the Play release).
    const fingerprints = ANDROID_SHA256.split(",").map((s) => s.trim()).filter(Boolean);
    return json([{
      relation: ["delegate_permission/common.handle_all_urls"],
      target: { namespace: "android_app", package_name: BUNDLE_ID, sha256_cert_fingerprints: fingerprints },
    }]);
  }

  // ── /robots.txt + /sitemap.xml → rendere TROVABILI le pagine template ──────
  // Ogni `/s/{hash}` è già una pagina server-rendered con og:* e canonical, ma
  // finora nessun motore poteva scoprirla: niente sitemap, niente robots, e
  // nessun link in entrata. Il "long-tail SEO evergreen" dei design doc non è
  // mai esistito — le pagine c'erano, irraggiungibili.
  //
  // La sitemap si genera dal catalogo, quindi ogni pack pubblicato entra da
  // solo: nessun passo manuale, nessun file da rigenerare.
  //
  // 🔒 COSA si indicizza: solo i pack UFFICIALI/curati. La query gira con la
  // chiave ANON, quindi la RLS (`047`: approved OR curated, revoked_at NULL) è
  // già un filtro — ma non basta come politica: indicizzare l'UGC significa
  // dare visibilità sui motori a contenuti caricati dagli utenti, che è una
  // decisione di moderazione, non di SEO. Finché il marketplace è curated-first
  // si indicizza solo ciò di cui rispondiamo noi.
  if (/\/robots\.txt$/.test(path)) {
    return new Response(
      [
        "User-agent: *",
        "Allow: /s/",
        // `/c/` sono Ghost Map di studenti: contenuto personale, non catalogo.
        // Si aprono a chi ha il link, non si danno ai motori di ricerca — è la
        // stessa distinzione fra pubblicare e rendere trovabile che vale per
        // l'UGC nella sitemap.
        "Disallow: /c/",
        // `/i/` è un redirect verso gli store e `/u/` non ha ancora una pagina
        // server per i non-installati: entrambi sprecherebbero crawl budget.
        "Disallow: /i/",
        // `/collab/` sono stanze PRIVATE fra due persone. Un roomId finito in
        // un motore di ricerca è un invito aperto a chiunque: qui il Disallow
        // non è crawl budget, è la porta chiusa.
        "Disallow: /collab/",
        // `/p` e' una scheda privata condivisa con una persona. Non c'e' nulla
        // da indicizzare — il server non conosce nemmeno il token — e un
        // crawler qui spenderebbe budget su una pagina identica ogni volta.
        "Disallow: /p",
        "Disallow: /get",
        "Disallow: /u/",
        "Disallow: /report",
        "",
        "Sitemap: https://share.fluera.dev/sitemap.xml",
        "",
      ].join("\n"),
      {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "public, max-age=3600",
        },
      },
    );
  }
  if (/\/sitemap\.xml$/.test(path)) return await sitemapResponse();

  // ── /c/{hash} → la Ghost Map pubblica ──────────────────────────────────────
  // L'app produce questi link da una UI viva (ShareGhostMapSheet) da mesi, e
  // non esisteva NESSUN viewer: né su fluera.dev (statico) né qui. Ogni link
  // condiviso era un 404 — e su Android peggio, perché la verifica App Links è
  // per-host: il link apriva l'app, che poi rimbalzava l'utente nel browser
  // sul 404.
  //
  // La pagina è volutamente più semplice di `/s`: una Ghost Map non è un
  // artefatto da installare, è qualcosa da GUARDARE. Niente CTA verso lo store
  // come azione primaria — l'immagine è il contenuto, il link all'app è un
  // invito discreto in fondo.
  const cm = path.match(new RegExp(`/c/(${HASH_RE.source})/?$`));
  if (cm) {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return html(500, statusPage("Errore", "Server non configurato."));
    }
    const share = await fetchGhostShare(cm[1]);
    if (!share) {
      return html(
        410,
        statusPage(
          "Non più disponibile",
          "Questa mappa è stata rimossa o non è più pubblica.",
        ),
      );
    }
    // Il conteggio si incrementa solo per i VISITATORI, non per i crawler che
    // fanno l'unfurl: chi condivide deve leggere visite, non lavoro di bot.
    // (Un'anteprima incollata in una chat di gruppo genera N fetch di bot.)
    if (!BOT_UA_RE.test(req.headers.get("user-agent") ?? "")) {
      bumpGhostView(cm[1]);
    }
    return html(200, renderGhostPage(share, cm[1]));
  }

  // ── /p → una scheda del catalogo PRIVATO ───────────────────────────────────
  //
  // ⚠️ IL SERVER NON VEDE IL TOKEN, e non e' un difetto: sta nel FRAMMENTO
  // (`/p#<token>`), che il browser non trasmette. Un token nel percorso
  // finirebbe nei log di questa funzione a ogni apertura — comprese le fetch
  // automatiche di unfurl che ogni messenger fa su un URL incollato, che chi
  // manda non vede e non puo' revocare.
  //
  // Da cui, per costruzione: questa pagina non puo' mostrare titolo, miniatura
  // ne' numero di concetti. Le og:* sono generiche, e la scheda che appare in
  // chat dice «qualcuno ti ha condiviso una scheda» e nulla di piu'. E' cosi'
  // che una condivisione fra due persone non diventa visibile a un gruppo di
  // quaranta.
  //
  // CHI ARRIVA QUI: quasi solo chi NON ha l'app. Il manifest Android e l'AASA
  // rivendicano `/p`, quindi con l'app installata il sistema la apre
  // direttamente passando l'URI INTERO — frammento compreso — e questa pagina
  // non viene mai caricata. Restano i non-installati e i browser interni di
  // Instagram/Facebook, che gli App Links non li onorano: per quest'ultimi il
  // bottone «Apri in Fluera» punta allo schema custom, che li' funziona.
  //
  // ONESTA' SULL'INSTALLAZIONE: il frammento NON sopravvive al giro dallo
  // store. Chi installa da qui deve riaprire il link, e la pagina glielo dice
  // prima invece di lasciarglielo scoprire davanti a un'app vuota.
  // ⚠️ Path NORMALIZZATO, poi confronto ESATTO — non un suffisso.
  //
  // In produzione (Deno Deploy, dominio alla radice) il path è `/p`; sotto
  // `functions serve` in locale è `/functions/v1/seed-share/p`. Un `===` nudo
  // sarebbe impossibile da provare prima di distribuirlo, ma un suffisso
  // `/\/p\/?$/` catturerebbe anche `/i/p` e `/u/p` — e questa rotta gira PRIMA
  // di entrambe, quindi le ruberebbe in silenzio. Si toglie il prefisso e si
  // confronta per intero: provabile in locale e stretto in produzione.
  // Si toglie QUALUNQUE prefisso che finisca col nome della funzione: in
  // produzione non ce n'è (dominio alla radice), in locale dipende da come
  // `functions serve` monta la rotta, e cablare un prefisso esatto significa
  // scriverne uno che vale solo su una delle due.
  const rotta = path.replace(/^.*\/seed-share/, "");
  if (rotta === "/p" || rotta === "/p/") {
    const platform = classify(req.headers.get("user-agent") ?? "");
    const androidLive = (Deno.env.get("ANDROID_STORE_LIVE") ?? "") === "true";
    const store = platform === "android" && androidLive
      ? `https://play.google.com/store/apps/details?id=${BUNDLE_ID}`
      : platform === "ios" && APPLE_APP_ID
      ? `https://apps.apple.com/app/id${APPLE_APP_ID}`
      : `${SITE}/beta`;
    return html(200, renderPrivateSeedPage(store, platform));
  }

  // ── /collab/{roomId} → invito a una sessione P2P dal vivo ──────────────────
  // L'INVITO PIÙ FORTE CHE L'APP SAPPIA PRODURRE, e fino a oggi inconsegnabile.
  // L'unica implementazione in produzione (`p2p_connector.dart`) emetteva
  // `fluera://collab/{roomId}`: uno schema custom, che molti messenger non
  // rendono nemmeno toccabile e che, toccato senza l'app, fallisce e basta.
  // `createUniversalLink` — la funzione che produce l'https — aveva un test
  // verde e ZERO chiamanti. Nessuna route esisteva da nessuna parte, e l'AASA
  // di iOS rivendicava `/collab/*` su fluera.dev, che risponde 404.
  //
  // PERCHÉ QUESTO ANELLO VALE PIÙ DEGLI ALTRI: è l'unico artefatto il cui
  // valore non si può avere senza installare. Un seed si screenshotta, un
  // time-lapse si guarda e si dimentica; una tela condivisa in tempo reale
  // richiede l'app da entrambe le parti, e la chiede nel momento di massima
  // intenzione — «stiamo studiando adesso».
  //
  // CHI VEDE QUESTA PAGINA: quasi nessuno di chi ha già l'app. Il manifest
  // rivendica `/collab/` con autoVerify, quindi su Android l'app si apre
  // direttamente e la pagina non viene mai caricata; su iOS lo stesso via AASA.
  // Resta chi l'app non ce l'ha — ed è esattamente il pubblico da convertire.
  //
  // IL CASO CHE L'HTTPS DA SOLO NON COPRE: i browser interni di Instagram,
  // Facebook e (a volte) WhatsApp non onorano gli App Links. Chi HA l'app e
  // apre l'invito lì dentro atterra comunque qui. Per loro il bottone «Apri
  // nell'app» punta allo schema custom, che in quel contesto funziona: i due
  // meccanismi si coprono a vicenda invece di escludersi.
  //
  // ONESTÀ SULLA DURATA: una stanza P2P è effimera e il server non ne sa
  // NULLA (il segnale passa da Supabase Realtime, non da qui). Non possiamo
  // dire se la sessione è ancora aperta, quindi la pagina non lo promette —
  // dichiararlo è più utile che far scoprire il vuoto dopo l'installazione.
  // DUE FORME sulla stessa route, di proposito:
  //   • /collab/{roomId}                  → sessione P2P dal vivo (effimera)
  //   • /collab/{canvasId}?token=…&role=… → invito su una tela salvata (CRDT)
  // Al server non serve distinguerle: non sa nulla né della stanza né della
  // tela, e in entrambi i casi il suo lavoro è consegnare la persona all'app.
  // L'app le distingue da sola — c'è un token o non c'è.
  //
  // ⚠️ LA QUERY VA INOLTRATA INTATTA nel link «apri nell'app». Il token È
  // l'invito: perderlo produce la peggiore delle uscite, un link che apre
  // l'app e non concede niente, indistinguibile da un difetto dell'app.
  // L'id qui accetta anche `-` e `_` perché un canvas id non è un room id di
  // 8 caratteri: è un identificatore lungo, spesso un UUID.
  const colm = path.match(/\/collab\/([A-Za-z0-9_-]{4,64})\/?$/);
  if (colm) {
    const platform = classify(req.headers.get("user-agent") ?? "");
    const androidLive = (Deno.env.get("ANDROID_STORE_LIVE") ?? "") === "true";
    const store = platform === "android" && androidLive
      ? `https://play.google.com/store/apps/details?id=${BUNDLE_ID}`
      : platform === "ios" && APPLE_APP_ID
      ? `https://apps.apple.com/app/id${APPLE_APP_ID}`
      : `${SITE}/beta`;
    // Solo i parametri del contratto d'invito, ri-serializzati: rimbalzare la
    // query grezza dentro un href significherebbe far scrivere a un estraneo
    // dentro l'attributo di un tag.
    const invite = new URLSearchParams();
    for (const k of ["token", "role", "inviter"]) {
      const v = reqUrl.searchParams.get(k);
      if (v && /^[A-Za-z0-9_-]{1,128}$/.test(v)) invite.set(k, v);
    }
    return html(
      200,
      renderCollabPage(colm[1], store, platform, invite.toString()),
    );
  }

  // ── /get → «portami l'app», senza attribuzione ─────────────────────────────
  // Fallback dei QR e dei link condivisi quando NON esiste un codice creator
  // (nessuna sessione, o RPC non disponibile). Prima era `https://fluera.dev`:
  // la homepage di marketing, cioè un vicolo cieco — chi scansionava non
  // trovava né l'app né lo store, e il QR sembrava funzionare.
  //
  // ⚠️ IL MOTIVO PER CUI QUESTA ROUTE ESISTE non è «una pagina più adatta»:
  // è che **un QR bruciato nei pixel è permanente**. Vive in video già
  // pubblicati e in immagini già mandate, e non lo si può più correggere.
  // Quindi non deve MAI puntare a una destinazione finale, ma a un
  // reindirizzatore che possiamo cambiare da qui. Il giorno che lo store
  // apre, ogni QR mai stampato comincia a funzionare senza ristampare niente.
  //
  // ONESTÀ SULLO STATO REALE: mandare allo store mentre l'app è in internal
  // testing porta a un 404 di Play — peggio della homepage, perché sembra che
  // l'app non esista. Finché `ANDROID_STORE_LIVE` non è "true" si atterra su
  // /beta, che è la verità corrente: «puoi chiedere l'accesso». Alla apertura
  // dello store si cambia UNA variabile d'ambiente, non il codice.
  //
  // Nessun referrer: non c'è nulla da attribuire, e inventare un'attribuzione
  // falsa sarebbe peggio di non averne.
  if (/\/get\/?$/.test(path)) {
    const platform = classify(req.headers.get("user-agent") ?? "");
    const androidLive = (Deno.env.get("ANDROID_STORE_LIVE") ?? "") === "true";
    const target = platform === "android" && androidLive
      ? `https://play.google.com/store/apps/details?id=${BUNDLE_ID}`
      : platform === "ios" && APPLE_APP_ID
      ? `https://apps.apple.com/app/id${APPLE_APP_ID}`
      : `${SITE}/beta`;
    return new Response(null, {
      status: 302,
      headers: { Location: target, "Cache-Control": "no-store" },
    });
  }

  // ── /i/{code} → UA-sniffed store redirect carrying the referral code ───────
  // The end-card/QR hop of the referral loop (M3). Android is the ONE platform
  // with a real deferred channel: the Play `&referrer=` payload survives the
  // store round-trip and reaches the freshly-installed app via the Install
  // Referrer API (`code=<code>`, optionally `&seed=<id>` so the installer lands
  // into the watched template — the app parses both this format and the
  // `s=…&ref=…` one the /s page emits). iOS has no referrer: with APPLE_APP_ID
  // set we send the store (code rides only the QR-direct path), else the
  // marketing site. Desktop → the site with `?i={code}` for a "open on your
  // phone" re-encode. The click is logged fire-and-forget into referral_clicks
  // (migration 131, service-role-only writes) — the mouth of the k-funnel.
  const rim = path.match(/\/i\/([A-Za-z0-9]{4,16})\/?$/);
  if (rim) {
    const code = rim[1];
    const seed = sanitizeRef(reqUrl.searchParams.get("seed"));
    const platform = classify(req.headers.get("user-agent") ?? "");
    logReferralClick(req, code, platform);
    // ⚠️ Stesso gate di `/get`: mandare allo store mentre l'app è in internal
    // testing produce un 404 di Play, cioè un QR che dichiara «questa app non
    // esiste». Finché `ANDROID_STORE_LIVE` non è "true" si atterra su /beta.
    // L'attribuzione NON si perde: il click è già stato scritto in
    // `referral_clicks` con il code (riga sopra), quindi la bocca del funnel
    // resta misurata anche quando l'installazione è impossibile — sapremo chi
    // ha portato scansioni durante la beta chiusa.
    const androidLive = (Deno.env.get("ANDROID_STORE_LIVE") ?? "") === "true";
    let target: string;
    if (platform === "android" && androidLive) {
      const referrer = `code=${code}${seed ? `&seed=${seed}` : ""}`;
      target = `https://play.google.com/store/apps/details?id=${BUNDLE_ID}&referrer=${encodeURIComponent(referrer)}`;
    } else if (platform === "ios" && APPLE_APP_ID) {
      // No reliable iOS referrer; the fragment is a best-effort marker only.
      target = `https://apps.apple.com/app/id${APPLE_APP_ID}#i=${code}`;
    } else if (platform === "other") {
      target = `${SITE}/?i=${encodeURIComponent(code)}`;
    } else {
      target = `${SITE}/beta`;
    }
    // 302 (not 301): the target is per-UA and must never be cached.
    return new Response(null, {
      status: 302,
      headers: { Location: target, "Cache-Control": "no-store" },
    });
  }

  // ── /report (public, no-login DSA Art.16 / DMCA takedown intake) ───────────
  // A report channel linked from every /s/{hash} page. GET renders a minimal
  // self-contained form (the seed hash is carried in the query); POST validates,
  // rate-limits, and forwards the notice to the SERVICE-ROLE RPC
  // file_takedown_notice — the ONLY database write an anonymous reporter can
  // make. SECURITY: add a CAPTCHA (hCaptcha / Cloudflare Turnstile) here BEFORE
  // any heavy public exposure — the in-memory per-IP limiter below is a floor
  // (per-isolate, resets on cold start), not a real abuse defense.
  if (/\/report\/?$/.test(path)) {
    if (req.method === "POST") return await handleReportPost(req);
    const qHash = (reqUrl.searchParams.get("hash") ?? "").trim().toLowerCase();
    return html(200, reportForm(REPORT_HASH_RE.test(qHash) ? qHash : ""));
  }

  // ── /s/{hash}/og.png → social card with the LIVE numbers baked into the
  //    image (additive + best-effort: any failure 302s to the raw thumbnail). ──
  const ogm = path.match(new RegExp(`/s/(${HASH_RE.source})/og\\.png$`));
  if (ogm) return await ogImageResponse(ogm[1]);

  // ── /s/{hash} (tolerate any function-name prefix Supabase may prepend) ──
  const m = path.match(new RegExp(`/s/(${HASH_RE.source})/?$`));
  if (!m) return Response.redirect(SITE, 302);
  const hash = m[1];

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return html(500, statusPage("Errore", "Server non configurato."));
  }
  const row = await fetchTemplate(hash);
  if (!row) return html(410, statusPage("Non più disponibile", "Questo template è stato rimosso o non è più pubblico."));

  // L'ultimo ramo era `OG_FALLBACK`, cioè il banner marketing generico: chi
  // apriva il link vedeva un'immagine di repertorio identica per ogni template.
  // Il render dal vivo di `/s/{hash}/og.png` — quello che il crawler riceve già
  // oggi per `og:image` — almeno ci stampa sopra il titolo e i numeri veri.
  // ⚠️ Non è la vera riparazione: i pack curati pubblicati senza `--thumb` non
  // hanno miniatura in storage, e il posto dove sistemarlo è la pubblicazione,
  // non questa pagina. Il percorso dell'app ne carica una (`_study_seed.dart`),
  // quindi i seed degli utenti non passano mai di qui.
  const ogImageUrl = row.og_path
    ? publicUrl(row.og_path)
    : row.thumb_path
      ? publicUrl(row.thumb_path)
      : `https://share.fluera.dev/s/${hash}/og.png`;
  const platform = classify(req.headers.get("user-agent") ?? "");
  // C1: attribution is an OPTIONAL "?ref={referralCode}" query param. Read it
  // here and forward it into every store/app-open URL so an install attributes
  // back to the sharer. Sanitize (alnum + a few safe chars) to keep referrer
  // payloads clean and avoid open-redirect/HTML-injection surprises.
  const ref = sanitizeRef(reqUrl.searchParams.get("ref"));
  return html(200, renderPage(row, hash, ogImageUrl, platform, ref));
});

// ── Supabase ────────────────────────────────────────────────────────────────

async function fetchTemplate(hash: string): Promise<SeedRow | null> {
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_study_seed`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ p_hash: hash }),
    });
    if (!resp.ok) return null;
    const rows = (await resp.json()) as SeedRow[];
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  } catch {
    return null;
  }
}

const publicUrl = (p: string) => `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${p}`;

// ── Ghost Map pubblica ───────────────────────────────────────────────────────
const GHOST_BUCKET = "public-ghost-shares";
const ghostUrl = (p: string) =>
  `${SUPABASE_URL}/storage/v1/object/public/${GHOST_BUCKET}/${p}`;

interface GhostShareRow {
  hash: string;
  png_path: string;
  og_path: string;
  summary_redacted: boolean | null;
  created_at: string | null;
  view_count: number | null;
}

async function fetchGhostShare(hash: string): Promise<GhostShareRow | null> {
  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/get_public_ghost_share`,
      {
        method: "POST",
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ p_hash: hash }),
      },
    );
    if (!resp.ok) return null;
    const rows = (await resp.json()) as GhostShareRow[];
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  } catch {
    return null;
  }
}

/// Incremento fire-and-forget: non deve mai ritardare la pagina.
function bumpGhostView(hash: string): void {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return;
  const p = fetch(`${SUPABASE_URL}/rest/v1/rpc/bump_ghost_share_view`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_hash: hash }),
  }).then(() => undefined).catch(() => undefined);
  // deno-lint-ignore no-explicit-any
  const er = (globalThis as any).EdgeRuntime;
  if (er && typeof er.waitUntil === "function") er.waitUntil(p);
}

function renderGhostPage(row: GhostShareRow, hash: string): string {
  const self = `https://share.fluera.dev/c/${hash}`;
  const img = row.og_path ? ghostUrl(row.og_path) : OG_FALLBACK;
  const full = row.png_path ? ghostUrl(row.png_path) : img;
  const title = "Una mappa di cosa manca";
  const desc = row.summary_redacted === false
    ? "Una Ghost Map di Fluera: cosa è capito, cosa manca, e i collegamenti fra i concetti."
    : "Una Ghost Map di Fluera: la forma di quello che serve ancora studiare. I titoli sono oscurati.";

  return `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)} · Fluera</title>
  <meta name="description" content="${esc(desc)}" />
  <link rel="canonical" href="${esc(self)}" />
  <meta property="og:type" content="article" />
  <meta property="og:site_name" content="Fluera" />
  <meta property="og:url" content="${esc(self)}" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(desc)}" />
  <meta property="og:image" content="${esc(img)}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(title)}" />
  <meta name="twitter:description" content="${esc(desc)}" />
  <meta name="twitter:image" content="${esc(img)}" />
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin:0; background:#0a0a0b; color:#f4f4f5; font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
    .wrap { max-width:900px; margin:0 auto; padding:24px 20px 64px; }
    .brand { display:flex; align-items:center; gap:8px; font-weight:600; color:#a1a1aa; margin-bottom:20px; }
    .map { width:100%; border-radius:16px; border:1px solid #ffffff14; background:#18181b; display:block; }
    h1 { font-size:24px; line-height:1.25; margin:22px 0 6px; }
    p.desc { color:#d4d4d8; margin:0 0 20px; }
    .foot { color:#71717a; font-size:13px; margin-top:26px; text-align:center; }
    .foot a { color:#818cf8; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="brand">🗺️ Fluera · Ghost Map</div>
    <img class="map" src="${esc(full)}" alt="${esc(title)}" loading="eager" />
    <h1>${esc(title)}</h1>
    <p class="desc">${esc(desc)}</p>
    <p class="foot">Fatta con <a href="${SITE}">Fluera</a> — il learning canvas che ti ri-studia.</p>
  </div>
</body>
</html>`;
}

// ── Pagina di consegna di una scheda PRIVATA ─────────────────────────────────
// Il server non sa nulla della scheda — nemmeno quale sia: il token e' nel
// frammento e non arriva fin qui. Quindi la pagina non promette contenuto, non
// lo carica e non lo puo' mostrare. Il suo unico lavoro e' consegnare la
// persona all'app, che e' l'unico posto dove l'anteprima esiste.
//
// noindex + no-referrer: il frammento non finisce nell'header Referer per
// costruzione (i browser non lo includono), ma la direttiva resta perche' la
// query un domani potrebbe portare qualcosa, e un presidio che c'e' gia' non va
// tolto per eleganza.
function renderPrivateSeedPage(
  storeUrl: string,
  platform: "android" | "ios" | "other",
): string {
  const self = "https://share.fluera.dev/p";
  const title = "Qualcuno ti ha condiviso una scheda di studio";
  // ⚠️ Descrizione VOLUTAMENTE priva di contenuto: e' cio' che l'unfurl mostra
  // in chat. Dire di piu' significherebbe dirlo a tutto il gruppo.
  const desc =
    "Una scheda privata su Fluera. Solo chi ha il link puo' vederla, e chi l'ha " +
    "mandata puo' togliere l'accesso quando vuole.";
  const installLabel = platform === "other"
    ? "Non ce l'hai? Scopri Fluera"
    : "Non ce l'hai? Installa Fluera";

  return `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <meta name="referrer" content="no-referrer" />
  <title>${esc(title)} \u00b7 Fluera</title>
  <meta name="description" content="${esc(desc)}" />
  <link rel="canonical" href="${esc(self)}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Fluera" />
  <meta property="og:url" content="${esc(self)}" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(desc)}" />
  <meta property="og:image" content="${esc(OG_FALLBACK)}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(title)}" />
  <meta name="twitter:description" content="${esc(desc)}" />
  <meta name="twitter:image" content="${esc(OG_FALLBACK)}" />
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin:0; background:#0a0a0b; color:#f4f4f5; font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
    .wrap { max-width:520px; margin:0 auto; padding:56px 20px 64px; text-align:center; }
    .brand { display:flex; align-items:center; justify-content:center; gap:8px; font-weight:600; color:#a1a1aa; margin-bottom:32px; }
    h1 { font-size:26px; line-height:1.25; margin:0 0 10px; }
    p.desc { color:#d4d4d8; margin:0 0 8px; }
    .lock { display:inline-block; font:600 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; letter-spacing:.04em; color:#a5b4fc; background:#ffffff0d; border:1px solid #ffffff14; border-radius:999px; padding:9px 16px; margin:16px 0 30px; }
    .cta { display:block; padding:15px 20px; border-radius:14px; font-weight:600; text-decoration:none; margin-bottom:12px; }
    .primary { background:#6366f1; color:#fff; }
    .secondary { background:#ffffff0d; border:1px solid #ffffff1f; color:#e4e4e7; }
    .note { color:#71717a; font-size:13px; margin-top:26px; }
    .warn { display:none; color:#fca5a5; font-size:14px; background:#7f1d1d26; border:1px solid #7f1d1d; border-radius:12px; padding:14px 16px; margin:0 0 22px; }
    .foot { color:#52525b; font-size:12px; margin-top:34px; }
    .foot a { color:#818cf8; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="brand">\u270d\ufe0f Fluera</div>
    <h1>${esc(title)}</h1>
    <p class="desc">${esc(desc)}</p>
    <div class="lock">\ud83d\udd12 Privata \u00b7 revocabile \u00b7 non compare in nessuna ricerca</div>

    <!-- Compare SOLO se il frammento manca: alcuni client accorciano un URL e
         tagliano via tutto dopo il '#'. Senza questo avviso il destinatario
         installerebbe l'app per poi non trovare nulla, e darebbe la colpa
         all'app invece che al link mutilato. -->
    <div class="warn" id="rotto">
      Il link sembra incompleto: manca la parte dopo il <code>#</code>.
      Chiedi a chi te l'ha mandato di reincollarlo per intero.
    </div>

    <a class="cta primary" id="apri" href="#">Apri in Fluera</a>
    <a class="cta secondary" href="${esc(storeUrl)}" rel="noreferrer">${esc(installLabel)}</a>

    <p class="note">
      Vedrai l'anteprima prima di decidere se installarla nei tuoi appunti.
      <br />
      Se installi Fluera adesso, <strong>riapri questo link</strong> dopo:
      la parte segreta non sopravvive al passaggio dallo store.
    </p>

    <p class="foot">
      Fluera \u00b7 <a href="${esc(SITE)}">fluera.dev</a>
    </p>
  </div>

  <script>
    // Il token vive SOLO qui, nel browser. Non viene inviato da nessuna parte:
    // non c'e' fetch, non c'e' analytics, e il bottone dello store porta
    // rel="noreferrer". L'unica cosa che ne facciamo e' passarlo all'app.
    (function () {
      var tok = (location.hash || "").replace(/^#/, "");
      var apri = document.getElementById("apri");
      if (/^[a-f0-9]{48}$/.test(tok)) {
        apri.setAttribute("href", "fluera://p#" + tok);
      } else {
        document.getElementById("rotto").style.display = "block";
        apri.style.display = "none";
      }
    })();
  </script>
</body>
</html>`;
}

// ── Pagina di consegna di un invito alla collaborazione ──────────────────────
// Il server non sa NULLA della stanza: la sessione è P2P e il segnale passa da
// Supabase Realtime, non da qui. Quindi questa pagina non può — e non deve —
// promettere che la sessione sia ancora aperta. Dice cosa sta per succedere e
// dà due strade, senza fingere di sapere quale funzionerà.
//
// Le meta og:* NON sono decorazione: sono metà del motivo per cui l'https batte
// lo schema custom. Un `fluera://collab/x9k2` incollato in chat resta testo
// grigio; questo link diventa una scheda con un titolo che spiega cos'è. Il
// destinatario capisce l'invito PRIMA di decidere se toccarlo.
//
// noindex: le stanze sono private. Non c'è nulla da indicizzare e un roomId in
// un motore di ricerca sarebbe un invito aperto a chiunque.
function renderCollabPage(
  roomId: string,
  storeUrl: string,
  platform: "android" | "ios" | "other",
  inviteQuery: string,
): string {
  // Il canonical NON riporta la query: il token è un segreto, e un canonical
  // che lo contenesse lo consegnerebbe a qualunque strumento legga l'HTML.
  const self = `https://share.fluera.dev/collab/${roomId}`;
  const isCanvasInvite = inviteQuery.length > 0;
  const title = "Ti hanno invitato a studiare insieme";
  const desc = isCanvasInvite
    ? "Un quaderno condiviso su Fluera: si scrive sullo stesso foglio, ognuno dal proprio dispositivo."
    : "Una tela condivisa su Fluera: due persone che scrivono sullo stesso foglio, in tempo reale.";
  // Lo schema custom sopravvive per UNA ragione precisa: i browser interni di
  // Instagram/Facebook non onorano gli App Links, quindi chi HA l'app e apre
  // l'invito lì dentro atterra qui invece che nell'app. Per loro questo
  // bottone è l'unica via, ed è anche l'unico contesto in cui `fluera://`
  // funziona meglio dell'https.
  const appUrl = `fluera://collab/${roomId}${
    isCanvasInvite ? `?${inviteQuery}` : ""
  }`;
  const installLabel = platform === "other"
    ? "Non ce l'hai? Scopri Fluera"
    : "Non ce l'hai? Installa Fluera";
  // Un invito su tela salvata aspetta: si può installare l'app, fare l'accesso
  // e riaprire il link entro la scadenza. Una stanza P2P no — vive solo finché
  // l'altro tiene aperta la tela, e prometterlo sarebbe una bugia.
  const durationNote = isCanvasInvite
    ? "L'invito scade: se lo apri più tardi, chiedi un link nuovo a chi te l'ha mandato."
    : "La sessione è dal vivo: l'invito vale finché chi ti ha invitato tiene aperta la tela.";

  return `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <!-- Il token dell'invito vive nell'URL. Senza questo, ogni clic sul bottone
       dello store lo spedirebbe a Google/Apple nell'header Referer — e i
       riferimenti finiscono nei log di terzi, dove non si revocano. -->
  <meta name="referrer" content="no-referrer" />
  <title>${esc(title)} · Fluera</title>
  <meta name="description" content="${esc(desc)}" />
  <link rel="canonical" href="${esc(self)}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Fluera" />
  <meta property="og:url" content="${esc(self)}" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(desc)}" />
  <meta property="og:image" content="${esc(OG_FALLBACK)}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(title)}" />
  <meta name="twitter:description" content="${esc(desc)}" />
  <meta name="twitter:image" content="${esc(OG_FALLBACK)}" />
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin:0; background:#0a0a0b; color:#f4f4f5; font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
    .wrap { max-width:520px; margin:0 auto; padding:56px 20px 64px; text-align:center; }
    .brand { display:flex; align-items:center; justify-content:center; gap:8px; font-weight:600; color:#a1a1aa; margin-bottom:32px; }
    h1 { font-size:26px; line-height:1.25; margin:0 0 10px; }
    p.desc { color:#d4d4d8; margin:0 0 8px; }
    .room { display:inline-block; font:600 14px/1 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.12em; color:#a5b4fc; background:#ffffff0d; border:1px solid #ffffff14; border-radius:999px; padding:9px 16px; margin:14px 0 30px; }
    .cta { display:block; padding:15px 20px; border-radius:14px; font-weight:600; text-decoration:none; margin-bottom:12px; }
    .primary { background:#6366f1; color:#fff; }
    .secondary { background:#ffffff0d; border:1px solid #ffffff1f; color:#e4e4e7; }
    .note { color:#71717a; font-size:13px; margin-top:26px; }
    .foot { color:#52525b; font-size:12px; margin-top:34px; }
    .foot a { color:#818cf8; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="brand">✍️ Fluera</div>
    <h1>${esc(title)}</h1>
    <p class="desc">${esc(desc)}</p>
    ${
    isCanvasInvite
      ? ""
      : `<div class="room">STANZA ${esc(roomId.toUpperCase())}</div>`
  }
    <a class="cta primary" href="${esc(appUrl)}">Apri in Fluera</a>
    <a class="cta secondary" href="${esc(storeUrl)}">${esc(installLabel)}</a>
    <p class="note">${esc(durationNote)}</p>
    <p class="foot">Con <a href="${SITE}">Fluera</a> — il learning canvas che ti ri-studia.</p>
  </div>
</body>
</html>`;
}

// ── sitemap ──────────────────────────────────────────────────────────────────
// Elenca i pack ufficiali/curati leggendoli con la chiave ANON: quello che la
// RLS non lascia vedere non finisce nella sitemap, per costruzione. Un guasto
// non deve mai restituire una sitemap VUOTA spacciata per valida — un urlset
// senza URL dice al motore «non ho niente», e deindicizza. Quindi su errore si
// risponde 503: il crawler ritenta, non conclude.
const SITEMAP_LIMIT = 5000;

async function sitemapResponse(): Promise<Response> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return new Response("sitemap unavailable", { status: 503 });
  }
  try {
    // Via RPC, non con una SELECT sulla tabella: in produzione la lettura
    // diretta risponde `42501 permission denied` con la chiave anon (misurato
    // il 2026-08-06). L'RPC `list_official_seed_urls` (migration 135) espone
    // SOLO hash + updated_at dei pack ufficiali pubblicamente visibili.
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/list_official_seed_urls`,
      {
        method: "POST",
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ p_limit: SITEMAP_LIMIT }),
      },
    );
    if (!resp.ok) throw new Error(`REST ${resp.status}`);
    const rows = (await resp.json()) as Array<
      { hash: string; updated_at: string | null }
    >;
    const urls = rows
      .filter((r) => HASH_RE.test(r.hash))
      .map((r) => {
        const lastmod = r.updated_at
          ? `\n    <lastmod>${esc(r.updated_at.slice(0, 10))}</lastmod>`
          : "";
        return `  <url>\n    <loc>https://share.fluera.dev/s/${esc(r.hash)}</loc>${lastmod}\n  </url>`;
      })
      .join("\n");
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
      {
        status: 200,
        headers: {
          "Content-Type": "application/xml; charset=utf-8",
          "Cache-Control": "public, max-age=600, s-maxage=3600",
        },
      },
    );
  } catch (e) {
    console.error(`sitemap failed: ${e}`);
    return new Response("sitemap unavailable", { status: 503 });
  }
}

// ── OG card image: /s/{hash}/og.png ─────────────────────────────────────────
// A 1200×630 PNG = the seed's notes thumbnail with the LIVE numbers baked INTO
// the pixels, so the social proof travels with the image even where the caption
// is dropped. Rendered at REQUEST time → always-fresh counts. Every heavy dep
// is DYNAMICALLY imported + memoized INSIDE the handler, so a CDN/runtime
// failure can only degrade THIS route (it 302-falls back to the raw thumbnail) —
// never the HTML / deep-link routes, which never touch any of this. resvg (pure
// WASM, the one verified-deploy-safe choice on Deno Deploy) rasterizes a
// hand-built SVG; the base PNG is inlined as a data URI (resvg won't fetch
// remote hrefs); the star is an SVG <path> (resvg has no colour-emoji font).
const RESVG_WASM_URL = "https://esm.sh/@resvg/resvg-wasm@2.6.2/index_bg.wasm";
const OG_FONT_URL =
  "https://cdn.jsdelivr.net/npm/@vercel/og@0.6.2/dist/noto-sans-v27-latin-regular.ttf";

let _wasmReady: Promise<unknown> | null = null;
let _ogFont: Promise<Uint8Array> | null = null;

// Load (once per isolate) the WASM + a Latin TTF. Memoized and RESET on failure
// so a transient CDN blip can retry; initWasm is idempotent-once, so a
// double-init across retries is tolerated.
//
// ⚠️ Il MODULO si importa STATICAMENTE in cima al file, non con `import()` a
// runtime. Prima era dinamico, per isolare un guasto del CDN a questa sola
// route — ma la piattaforma Deno Deploy **compila al deploy**, e uno specifier
// remoto importato a runtime non entra nel grafo compilato: falliva SEMPRE, e
// il `catch` di `ogImageResponse` lo trasformava in un 302 silenzioso verso la
// miniatura nuda. Risultato misurato il 2026-08-05: og.png non ha mai composto
// nulla, e la prova sociale non è mai finita dentro l'immagine.
// Import statico = se il CDN è giù il DEPLOY fallisce, forte e subito, invece
// di degradare per mesi senza che nessuno lo sappia.
// WASM e font restano `fetch` a runtime: sono dati, non moduli.
async function loadResvg(): Promise<{ Resvg: typeof Resvg; font: Uint8Array }> {
  _wasmReady ??= Promise.resolve(initWasm(fetch(RESVG_WASM_URL))).catch(
    (e: unknown) => {
      if (String(e).includes("Already initialized")) return;
      _wasmReady = null;
      throw e;
    },
  );
  await _wasmReady;
  const font = await (_ogFont ??= fetch(OG_FONT_URL)
    .then((r) => r.arrayBuffer())
    .then((b) => new Uint8Array(b))
    .catch((e) => {
      _ogFont = null;
      throw e;
    }));
  return { Resvg, font };
}

async function ogImageResponse(hash: string): Promise<Response> {
  // Resolve the base image first — it doubles as the graceful-fallback target.
  let baseUrl = OG_FALLBACK;
  try {
    const row = await fetchTemplate(hash);
    if (row) {
      baseUrl = row.og_path
        ? publicUrl(row.og_path)
        : row.thumb_path
        ? publicUrl(row.thumb_path)
        : OG_FALLBACK;
      const png = await buildOgPng(row, baseUrl);
      return new Response(png, {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=300, s-maxage=300",
        },
      });
    }
  } catch (e) {
    // Il 302 qui sotto è una degradazione VOLUTA (l'unfurl ha sempre
    // un'immagine valida), ma senza questa riga è indistinguibile dal
    // funzionamento normale: è così che la composizione è rimasta rotta senza
    // che nessuno lo sapesse. Ora un fallback lascia una traccia.
    console.error(`og.png compositing failed for ${hash}: ${e}`);
  }
  // Graceful degradation: crawlers follow the 302 to the raw thumbnail, so the
  // unfurl always has a valid image even when compositing fails. Short cache so
  // a transient failure is not pinned.
  return new Response(null, {
    status: 302,
    headers: { Location: baseUrl, "Cache-Control": "public, max-age=60" },
  });
}

// `asPng()` di resvg dichiara `Uint8Array<ArrayBufferLike>`, che NON è un
// `BodyInit` valido per `Response` (potrebbe essere su SharedArrayBuffer). Si
// ricopia in un Uint8Array su ArrayBuffer: una copia da poche centinaia di KB,
// irrilevante. Finché il modulo era importato dinamicamente il tipo era `any` e
// niente di tutto questo si vedeva — l'import statico l'ha fatto emergere.
async function buildOgPng(
  row: SeedRow,
  baseUrl: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const { Resvg, font } = await loadResvg();
  const imgBytes = new Uint8Array(await (await fetch(baseUrl)).arrayBuffer());
  const dataUri = `data:${mimeOf(imgBytes)};base64,${toBase64(imgBytes)}`;

  const title = truncate(
    (row.title ?? "Template di studio").trim() || "Template di studio",
    30,
  );
  const concepts = Math.max(0, row.concept_count ?? 0);
  const installs = Math.max(0, row.install_count ?? 0);
  const rating = (row.rating_count ?? 0) > 0
    ? (row.rating_sum ?? 0) / (row.rating_count ?? 1)
    : 0;
  const parts: string[] = [];
  if (rating > 0) parts.push(rating.toFixed(1));
  if (installs > 0) {
    parts.push(`${fmtIt(installs)} student${installs === 1 ? "e" : "i"}`);
  }
  if (concepts > 0) parts.push(`${concepts} concett${concepts === 1 ? "o" : "i"}`);
  const stats = parts.join("     ·     ");
  const showStar = rating > 0;
  const statsX = showStar ? 110 : 64;
  // hand-coded 5-point star (resvg renders only fontBuffers glyphs → no emoji).
  const star =
    "M0,-15 L4.4,-4.6 L15,-4.6 L6.3,2.4 L9.3,13 L0,6.9 L-9.3,13 L-6.3,2.4 L-15,-4.6 L-4.4,-4.6 Z";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="630" viewBox="0 0 1200 630">` +
    `<defs><linearGradient id="sh" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#000" stop-opacity="0.5"/><stop offset="0.28" stop-color="#000" stop-opacity="0"/>` +
    `<stop offset="0.62" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.82"/>` +
    `</linearGradient></defs>` +
    `<image x="0" y="0" width="1200" height="630" preserveAspectRatio="xMidYMid slice" href="${dataUri}" xlink:href="${dataUri}"/>` +
    `<rect width="1200" height="630" fill="url(#sh)"/>` +
    `<text x="64" y="104" font-family="Noto Sans" font-size="58" font-weight="700" fill="#ffffff">${esc(title)}</text>` +
    (showStar
      ? `<g transform="translate(82,556)"><path d="${star}" fill="#FBBF24"/></g>`
      : "") +
    `<text x="${statsX}" y="568" font-family="Noto Sans" font-size="36" fill="#ffffff">${esc(stats)}</text>` +
    `</svg>`;

  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: 1200 },
    background: "rgba(0,0,0,0)",
    font: {
      fontBuffers: [font],
      loadSystemFonts: false,
      defaultFontFamily: "Noto Sans",
    },
  });
  return new Uint8Array(resvg.render().asPng());
}

// Base64 a byte array WITHOUT spreading (String.fromCharCode(...big) overflows
// the call stack) — chunk at 32KiB.
function toBase64(b: Uint8Array): string {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < b.length; i += CH) {
    s += String.fromCharCode.apply(
      null,
      b.subarray(i, i + CH) as unknown as number[],
    );
  }
  return btoa(s);
}
// resvg needs the data-URI MIME to match the real bytes or it renders nothing.
// Our thumbnails are always PNG; JPEG is detected defensively. (resvg can't
// decode WebP, but the renderer only ever emits PNG, so that path can't occur.)
function mimeOf(b: Uint8Array): string {
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  return "image/png";
}
// Italian thousands shorthand: reuse fmt() but comma-decimal ("1,2k").
function fmtIt(n: number): string {
  return fmt(n).replace(".", ",");
}
function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

// ── Rendering ───────────────────────────────────────────────────────────────

function renderPage(
  row: SeedRow,
  hash: string,
  ogImageUrl: string,
  platform: "ios" | "android" | "other",
  ref: string,
): string {
  // C1: canonical share link carries the OPTIONAL "?ref={code}" so the app's
  // Universal/App-Link open + any onward reshare keep the attribution chain.
  const self = `https://share.fluera.dev/s/${hash}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
  const title = (row.title ?? "Template di studio").trim() || "Template di studio";
  const author = row.is_official ? "Fluera" : row.author_code ? `@${row.author_code.slice(0, 8)}` : "Anonimo";
  const concepts = Math.max(0, row.concept_count ?? 0);
  const installs = Math.max(0, row.install_count ?? 0);
  const rating = (row.rating_count ?? 0) > 0 ? (row.rating_sum ?? 0) / (row.rating_count ?? 1) : 0;
  const ratingN = Math.max(0, row.rating_count ?? 0);

  // SOCIAL PROOF in the unfurl: crawlers render og:title / og:description but
  // NOT the chips below — so the live counts must be folded INTO those tags or
  // they never reach the chat-preview card. Build a compact proof prefix
  // (e.g. "★4.8 · 12k installazioni · 5 concetti") and prepend it.
  const proofParts = [
    rating > 0 ? `★${rating.toFixed(1)}${ratingN > 0 ? ` (${fmt(ratingN)})` : ""}` : "",
    installs > 0 ? `${fmt(installs)} student${installs === 1 ? "e" : "i"}` : "",
    concepts > 0 ? `${concepts} concett${concepts === 1 ? "o" : "i"}` : "",
  ].filter(Boolean);
  const proof = proofParts.join(" · ");

  const baseDescription = (row.description ?? "").trim() ||
    `Un template di studio${row.discipline ? ` di ${row.discipline}` : ""} con ${concepts} concett${concepts === 1 ? "o" : "i"}. Installalo in Fluera e parte un ripasso programmato — il trapianto cognitivo nel tuo modello di studio.`;
  // og:* / twitter:* SOCIAL-PROOF-augmented strings (the card). On-page <title>
  // and the visible <p class="desc"> stay clean (chips already show the proof).
  const ogTitle = proof ? `${title} · ${proof}` : title;
  const ogDescription = proof ? `${proof} — ${baseDescription}` : baseDescription;

  // C1 ref forwarding: thread "ref" into BOTH the Play Store referrer payload
  // and the iOS app-argument / fragment so the install attributes to the sharer.
  const referrer = `s=${hash}${ref ? `&ref=${ref}` : ""}`;
  const playUrl = `https://play.google.com/store/apps/details?id=${BUNDLE_ID}&referrer=${encodeURIComponent(referrer)}`;
  const iosFrag = `s=${hash}${ref ? `&ref=${encodeURIComponent(ref)}` : ""}`;
  const iosUrl = APPLE_APP_ID ? `https://apps.apple.com/app/id${APPLE_APP_ID}#${iosFrag}` : SITE;
  // COLD-MOBILE CTA. A same-URL "try the app first" JS hop can never work
  // from this page: on Android navigating to the page's own URL just RELOADS
  // it (the new document commits in <700ms on any decent network, killing the
  // store-fallback timer — a CTA that reloads the page instead of converting),
  // and iOS Universal Links deliberately do not trigger on same-domain
  // navigation. So, no JS:
  //   • Android → a Chrome `intent://` URL: opens the app when installed
  //     (delivering this exact /s URL, ref included), else the browser follows
  //     S.browser_fallback_url to the Play page (which carries seed + ref in
  //     the install referrer). Handled natively by Chrome & friends.
  //   • iOS → the App Store directly (the apple-itunes-app Smart App Banner
  //     above covers the installed-app case); marketing site if no store id.
  //   • Desktop/other → the marketing site.
  const androidIntent = `intent://share.fluera.dev/s/${hash}${
    ref ? `?ref=${encodeURIComponent(ref)}` : ""
  }#Intent;scheme=https;package=${BUNDLE_ID};S.browser_fallback_url=${encodeURIComponent(playUrl)};end`;
  const primaryHref = platform === "android"
    ? androidIntent
    : platform === "ios"
      ? iosUrl
      : SITE;
  const primaryLabel = platform === "other" ? "Scopri Fluera" : "Apri in Fluera";

  const chips = [
    row.discipline ? chip(row.discipline) : "",
    concepts > 0 ? chip(`${concepts} concetti`) : "",
    installs > 0 ? chip(`${fmt(installs)} student${installs === 1 ? "e" : "i"}`) : "",
    rating > 0 ? chip(`★ ${rating.toFixed(1)}`) : "",
  ].join("");

  return `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)} · Fluera</title>
  <meta name="description" content="${esc(ogDescription)}" />
  <link rel="canonical" href="${esc(self)}" />
  <meta property="og:type" content="article" />
  <meta property="og:site_name" content="Fluera" />
  <meta property="og:url" content="${esc(self)}" />
  <meta property="og:title" content="${esc(ogTitle)}" />
  <meta property="og:description" content="${esc(ogDescription)}" />
  <meta property="og:image" content="https://share.fluera.dev/s/${hash}/og.png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="${esc(title)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(ogTitle)}" />
  <meta name="twitter:description" content="${esc(ogDescription)}" />
  <meta name="twitter:image" content="https://share.fluera.dev/s/${hash}/og.png" />
  <meta name="apple-itunes-app" content="app-id=${esc(APPLE_APP_ID || "fluera")}, app-argument=${esc(self)}" />
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin:0; background:#0a0a0b; color:#f4f4f5; font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
    .wrap { max-width:680px; margin:0 auto; padding:24px 20px 64px; }
    .brand { display:flex; align-items:center; gap:8px; font-weight:600; color:#a1a1aa; margin-bottom:20px; }
    .hero { width:100%; aspect-ratio:1200/630; border-radius:16px; overflow:hidden; background:#18181b; border:1px solid #ffffff14; }
    .hero img { width:100%; height:100%; object-fit:cover; display:block; }
    h1 { font-size:26px; line-height:1.25; margin:22px 0 6px; }
    .by { color:#a1a1aa; font-size:14px; margin:0 0 14px; }
    .chips { display:flex; flex-wrap:wrap; gap:8px; margin:0 0 18px; }
    .chip { font-size:13px; color:#d4d4d8; background:#ffffff0f; border:1px solid #ffffff14; border-radius:999px; padding:5px 11px; }
    p.desc { color:#d4d4d8; }
    .cta { display:flex; flex-direction:column; gap:10px; margin-top:26px; }
    .btn { display:flex; align-items:center; justify-content:center; gap:8px; text-decoration:none; font-weight:600; padding:15px 18px; border-radius:14px; }
    .btn.primary { background:#6366f1; color:#fff; }
    .btn.ghost { background:#ffffff0f; color:#f4f4f5; border:1px solid #ffffff1f; }
    .note { color:#71717a; font-size:13px; text-align:center; margin-top:18px; }
    .report { text-align:center; margin-top:22px; }
    .report a { color:#71717a; font-size:13px; }
    a { color:inherit; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="brand">🌱 Fluera · Template di studio</div>
    <div class="hero"><img src="${esc(ogImageUrl)}" alt="${esc(title)}" loading="eager" /></div>
    <h1>${esc(title)}</h1>
    <p class="by">di ${esc(author)}</p>
    ${chips ? `<div class="chips">${chips}</div>` : ""}
    <p class="desc">${esc(baseDescription)}</p>
    <div class="cta">
      <a class="btn primary" href="${esc(primaryHref)}">${esc(primaryLabel)}</a>
      <a class="btn ghost" href="${esc(playUrl)}">Google Play</a>
      ${APPLE_APP_ID ? `<a class="btn ghost" href="${esc(iosUrl)}">App Store</a>` : ""}
    </div>
    <p class="note">Installando in Fluera, i concetti di questo template vengono trapiantati nel tuo modello di studio — con un ripasso programmato per domani.</p>
    <p class="report"><a href="https://share.fluera.dev/report?hash=${esc(hash)}">Segnala questo contenuto</a></p>
  </div>
</body>
</html>`;
}

const chip = (s: string) => `<span class="chip">${esc(s)}</span>`;

function statusPage(headline: string, body: string): string {
  return `<!doctype html><html lang="it"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><meta name="robots" content="noindex" /><title>${esc(headline)} · Fluera</title><style>body{margin:0;background:#0a0a0b;color:#f4f4f5;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center}div{max-width:420px;padding:24px}h1{font-size:22px;margin:0 0 8px}p{color:#a1a1aa;margin:0 0 20px}a{color:#818cf8}</style></head><body><div><h1>${esc(headline)}</h1><p>${esc(body)}</p><a href="${SITE}">Vai a Fluera →</a></div></body></html>`;
}

// ── Public report channel (DSA Art.16 / DMCA) ────────────────────────────────
// Anonymous, no-login takedown intake reachable from every share page. Kept
// fully self-contained (inline HTML/CSS, no imports) and dark-themed to match
// the share surface. NOTE: gate this with a CAPTCHA (hCaptcha / Cloudflare
// Turnstile) before heavy public exposure — the rate-limit below is only a
// per-isolate floor.

const REPORT_HASH_RE = /^[a-f0-9]{8,64}$/;
// Reason taxonomy (value → visible IT label). Mirrors the seed_takedown_notices
// reason set; a 'copyright' report maps to notice_type 'dmca', everything else
// to 'illegal_content'.
const REPORT_REASONS: ReadonlyArray<[string, string]> = [
  ["child-safety", "Sicurezza dei minori (CSAM / adescamento)"],
  ["sexual", "Contenuto sessuale o esplicito"],
  ["violence", "Violenza o incitamento alla violenza"],
  ["hate", "Incitamento all'odio"],
  ["copyright", "Violazione di copyright (DMCA)"],
  ["pii", "Dati personali / violazione della privacy"],
  ["spam", "Spam o truffa"],
  ["other", "Altro"],
];
const REPORT_REASON_SET = new Set(REPORT_REASONS.map(([v]) => v));

// Basic per-IP, per-isolate rate limit. This is a FLOOR only (resets on cold
// start, isolate-local); it is NOT a substitute for a CAPTCHA.
const REPORT_RL_MAX = 6;
const REPORT_RL_WINDOW_MS = 10 * 60 * 1000;
const _reportHits = new Map<string, number[]>();

function reportRateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (_reportHits.get(ip) ?? []).filter((t) => now - t < REPORT_RL_WINDOW_MS);
  recent.push(now);
  _reportHits.set(ip, recent);
  // Opportunistic cleanup so a busy isolate can't grow the map unbounded.
  if (_reportHits.size > 5000) {
    for (const [k, v] of _reportHits) {
      if (v.every((t) => now - t >= REPORT_RL_WINDOW_MS)) _reportHits.delete(k);
    }
  }
  return recent.length > REPORT_RL_MAX;
}

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") ?? "";
  const first = xff.split(",")[0].trim();
  return first || req.headers.get("x-real-ip") || "unknown";
}

async function handleReportPost(req: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return html(400, statusPage("Segnalazione non valida", "Modulo non leggibile. Riprova."));
  }
  const hash = String(form.get("hash") ?? "").trim().toLowerCase();
  const reason = String(form.get("reason") ?? "").trim();
  const email = String(form.get("email") ?? "").trim();
  const detail = String(form.get("detail") ?? "").trim();

  // Rate-limit FIRST — before any validation — so malformed / spam POSTs are
  // throttled too (a spammer can't dodge the limiter by sending an invalid
  // reason and getting a cheap 400 before the limiter runs).
  if (reportRateLimited(clientIp(req))) {
    return html(429, statusPage("Troppe segnalazioni", "Troppe segnalazioni da questa rete. Riprova tra qualche minuto."));
  }

  // hash + reason are mandatory; contact + detail are optional (anonymous
  // reports are allowed under DSA Art.16). The RPC re-validates + hard-caps.
  if (!REPORT_HASH_RE.test(hash)) {
    return html(400, statusPage("Segnalazione non valida", "Il riferimento del contenuto non è valido."));
  }
  if (!REPORT_REASON_SET.has(reason)) {
    return html(400, reportForm(hash, "Seleziona un motivo valido per la segnalazione."));
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return html(500, statusPage("Errore", "Server non configurato."));
  }
  const ok = await fileTakedownNotice(
    hash,
    reason,
    email ? email.slice(0, 320) : null,
    detail ? detail.slice(0, 5000) : null,
  );
  if (!ok) {
    return html(502, statusPage("Invio non riuscito", "Si è verificato un problema tecnico. Riprova tra poco."));
  }
  return html(
    200,
    statusPage(
      "Grazie, abbiamo ricevuto la tua segnalazione",
      "Il nostro team la esaminerà al più presto. Se hai lasciato un contatto, potremmo scriverti per aggiornamenti.",
    ),
  );
}

// The anonymous POST touches the DB ONLY through this validated service-role
// RPC. Mirrors fetchTemplate's raw-REST style (this function deliberately avoids
// the supabase-js dependency): a POST to /rest/v1/rpc/<fn> IS an rpc() call.
async function fileTakedownNotice(
  hash: string,
  reason: string,
  email: string | null,
  detail: string | null,
): Promise<boolean> {
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/file_takedown_notice`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        p_hash: hash,
        p_channel: "share_page",
        p_notice_type: reason === "copyright" ? "dmca" : "illegal_content",
        p_reason: reason,
        p_reporter_contact: email,
        p_body: detail,
      }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

function reportForm(hash: string, error?: string): string {
  const options = REPORT_REASONS
    .map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`)
    .join("");
  return `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>Segnala un contenuto · Fluera</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin:0; background:#0a0a0b; color:#f4f4f5; font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
    .wrap { max-width:560px; margin:0 auto; padding:32px 20px 64px; }
    .brand { display:flex; align-items:center; gap:8px; font-weight:600; color:#a1a1aa; margin-bottom:20px; }
    h1 { font-size:24px; line-height:1.25; margin:0 0 8px; }
    p.lead { color:#a1a1aa; margin:0 0 24px; }
    label { display:block; font-size:14px; font-weight:600; margin:18px 0 6px; }
    select, input, textarea { width:100%; background:#18181b; color:#f4f4f5; border:1px solid #ffffff1f; border-radius:12px; padding:12px 13px; font:inherit; }
    textarea { min-height:120px; resize:vertical; }
    .hint { color:#71717a; font-size:12px; margin:6px 0 0; }
    .err { background:#7f1d1d; color:#fecaca; border:1px solid #ffffff1f; border-radius:12px; padding:12px 14px; margin:0 0 18px; font-size:14px; }
    .btn { display:block; width:100%; margin-top:26px; background:#6366f1; color:#fff; border:none; font-weight:600; padding:15px 18px; border-radius:14px; font:inherit; cursor:pointer; }
    .foot { color:#71717a; font-size:12px; margin-top:20px; }
    a { color:#818cf8; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="brand">🌱 Fluera · Segnalazione</div>
    <h1>Segnala questo contenuto</h1>
    <p class="lead">Puoi segnalare un template di studio anche senza account. La segnalazione è anonima, salvo che tu non lasci un contatto.</p>
    ${error ? `<div class="err">${esc(error)}</div>` : ""}
    <form method="post">
      <input type="hidden" name="hash" value="${esc(hash)}" />
      <label for="reason">Motivo</label>
      <select id="reason" name="reason" required>
        <option value="" disabled selected>Seleziona un motivo…</option>
        ${options}
      </select>
      <label for="email">Email di contatto (facoltativa)</label>
      <input id="email" name="email" type="email" maxlength="320" autocomplete="email" placeholder="tu@esempio.com" />
      <p class="hint">Lasciala se vuoi ricevere aggiornamenti sull'esito. Non è obbligatoria.</p>
      <label for="detail">Dettagli</label>
      <textarea id="detail" name="detail" maxlength="5000" placeholder="Descrivi il problema (facoltativo ma utile)."></textarea>
      <button class="btn" type="submit">Invia segnalazione</button>
    </form>
    <p class="foot">Le segnalazioni sono esaminate dal team di moderazione. Per richieste legali (DMCA / 17 U.S.C. §512) o reclami ai sensi del DSA puoi anche scrivere a abuse@fluera.dev.</p>
  </div>
</body>
</html>`;
}

// ── referral click log ───────────────────────────────────────────────────────
// Fire-and-forget INSERT into referral_clicks (migration 131 — service-role
// writes only, no anon path: the telemetry_events allowlist would silently
// reject an unlisted event type, and log_telemetry_event is authenticated-only,
// which is exactly why the old Vercel api/i.ts click log could never have
// worked). Registered with EdgeRuntime.waitUntil when available so the write
// survives the 302 being returned; must NEVER delay or fail the redirect.
//
// Signal hygiene at the mouth of the funnel:
//   • link PREVIEWERS (WhatsApp/Telegram/Discord/…) and crawlers fetch every
//     pasted /i URL — logging them would inflate clicks the moment a link is
//     shared, before any human taps. UA-filtered out (they identify honestly).
//   • a per-IP, per-isolate rate limit (a FLOOR, same caveat as /report's)
//     keeps a curl loop from growing the table unbounded / pumping a code's
//     numbers for free.
//   • failures are logged to the function console, NOT swallowed: deploying
//     this function BEFORE migration 131 would otherwise read as "zero
//     clicks" for weeks (the PGRST202-class silent failure this repo already
//     lived through once).
const BOT_UA_RE =
  /bot|crawl|spider|preview|facebookexternalhit|whatsapp|telegram|slack|discord|twitter|linkedin|pinterest|vkshare|curl|wget|python-requests|okhttp\/|headless/i;
const CLICK_RL_MAX = 30;
const CLICK_RL_WINDOW_MS = 10 * 60 * 1000;
const _clickHits = new Map<string, number[]>();

function clickRateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (_clickHits.get(ip) ?? []).filter((t) => now - t < CLICK_RL_WINDOW_MS);
  recent.push(now);
  _clickHits.set(ip, recent);
  if (_clickHits.size > 5000) {
    for (const [k, v] of _clickHits) {
      if (v.every((t) => now - t >= CLICK_RL_WINDOW_MS)) _clickHits.delete(k);
    }
  }
  return recent.length > CLICK_RL_MAX;
}

function logReferralClick(req: Request, code: string, platform: string): void {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
  const ua = req.headers.get("user-agent") ?? "";
  if (req.method !== "GET" || BOT_UA_RE.test(ua)) return;
  if (clickRateLimited(clientIp(req))) return;
  const p = fetch(`${SUPABASE_URL}/rest/v1/referral_clicks`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ code, platform }),
  }).then((resp) => {
    if (!resp.ok) {
      console.error(`referral_clicks insert failed: HTTP ${resp.status} (migration 131 deployed?)`);
    }
  }).catch((e) => {
    console.error(`referral_clicks insert error: ${e}`);
  });
  // deno-lint-ignore no-explicit-any
  const er = (globalThis as any).EdgeRuntime;
  if (er && typeof er.waitUntil === "function") er.waitUntil(p);
}

// ── utils ─────────────────────────────────────────────────────────────────────

function classify(ua: string): "ios" | "android" | "other" {
  if (/iphone|ipad|ipod/i.test(ua)) return "ios";
  if (/android/i.test(ua)) return "android";
  return "other";
}
// C1: attribution referral code. Keep only URL/referrer-safe chars and cap the
// length — the value flows into the Play referrer payload and app-open URLs.
function sanitizeRef(raw: string | null): string {
  if (!raw) return "";
  const cleaned = raw.replace(/[^A-Za-z0-9._~-]/g, "");
  return cleaned.slice(0, 64);
}
function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function html(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=0, s-maxage=120" },
  });
}
function json(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
  });
}
