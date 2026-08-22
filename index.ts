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

// 🔬 2026-08-22 — `servi` estratta e `Deno.serve` dietro `import.meta.main`:
// finché il gestore era anonimo dentro la chiamata, questo file non poteva
// essere importato senza mettersi in ascolto, e quindi la sezione MCP non
// aveva UN test (i cancelli del canarino vivevano solo nello spike throwaway
// — audit «Atlas al setaccio»). In produzione il comportamento è identico:
// l'entrypoint esegue il modulo come main.
export const servi = async (req: Request): Promise<Response> => {
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
    // /r/* = rientro su una tela PROPRIA (deep link «Atlas risponde» §5):
    // emesso da notifiche ricche, win card e dal server MCP. L'unico posto
    // dove il link ha senso è l'app installata — la pagina qui sotto è solo
    // la consegna per chi non ce l'ha.
    return json({
      applinks: { apps: [], details: [{ appID: `${APPLE_TEAM_ID}.${BUNDLE_ID}`, paths: ["/s/*", "/i/*", "/u/*", "/collab/*", "/p", "/p/*", "/r/*"] }] },
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
        // `/r/` è il rientro su una tela PERSONALE: stessa porta chiusa di
        // `/c/` — si apre a chi ha il link, mai ai motori.
        "Disallow: /r/",
        // `/mcp` è un endpoint API autenticato: per un crawler è solo un 401.
        "Disallow: /mcp",
        // Le rotte OAuth sono un flusso, non pagine: `/connect` invece SÌ —
        // è la guida pubblica, e vale la pena che si trovi.
        "Disallow: /oauth/",
        "Allow: /connect",
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

  // La card dell'unfurl per una scheda privata. Va PRIMA del confronto su
  // "/p", che e' esatto e quindi non la intercetterebbe comunque — ma tenerle
  // adiacenti evita che un domani qualcuno allarghi "/p" e se la mangi.
  if (rotta === "/p/og.png") return await privateOgResponse();

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

  // ── /r/{canvasId} → RIENTRO su una tela propria («Atlas risponde», §5) ─────
  // Chi ha l'app non passa mai di qui (App/Universal Links la aprono
  // direttamente); questa pagina è la consegna per chi tocca il proprio link
  // su un device SENZA l'app: bottone custom-scheme per i browser in-app che
  // non onorano gli App Links + lo store giusto. Il `concept` è ri-serializzato
  // (mai la query grezza dentro un href) e cappato: è un'etichetta.
  // ── OAuth 2.1 — i metadati e il flusso («Atlas risponde» L2) ──────────────
  // I due .well-known stanno in cima alle rotte OAuth di proposito: sono ciò
  // che un client legge PRIMA di qualunque altra cosa, e la spec MCP li rende
  // obbligatori (RFC 9728 per la risorsa, RFC 8414 per l'AS).
  if (path.endsWith("/.well-known/oauth-protected-resource") ||
      path.endsWith("/.well-known/oauth-protected-resource/mcp")) {
    return protectedResourceMetadata();
  }
  if (path.endsWith("/.well-known/oauth-authorization-server")) {
    return authorizationServerMetadata();
  }
  // La pagina che spiega il collegamento: citata dai metadati della risorsa
  // (`resource_documentation`), ed è anche l'unica guida pubblica che uno
  // studente possa aprire da un telefono senza cercarla nelle impostazioni.
  if (/\/connect\/?$/.test(path)) return html(200, renderConnectPage(req));
  if (/\/oauth\/register\/?$/.test(path)) return await oauthRegister(req);
  if (/\/oauth\/authorize\/?$/.test(path)) return await oauthAuthorize(req, reqUrl);
  if (/\/oauth\/callback\/?$/.test(path)) return await oauthCallback(reqUrl);
  if (/\/oauth\/approve\/?$/.test(path)) return await oauthApprove(req);
  if (/\/oauth\/token\/?$/.test(path)) return await oauthToken(req);
  if (/\/oauth\/revoke\/?$/.test(path)) return await oauthRevoke(req);

  // ── /mcp → il connettore MCP («Atlas risponde» L1) ────────────────────────
  // Server MCP (Streamable HTTP, application/json) che serve l'ESTRATTO di
  // studio: lettore SOTTILE di `study_digest` — niente matematica FSRS qui,
  // solo confronti di date. Auth: token personale `fmcp_…` risolto via RPC
  // service_role. SOLO tool di lettura, per costruzione.
  //
  // ⚠️ STA PRIMA di /r di proposito: quando questa rotta viveva DOPO, una
  // riscrittura del blocco /r se l'è portata via in silenzio — `deno check`
  // verde, test unitari verdi (importano le funzioni, non le rotte) e il
  // dominio che rispondeva 302 invece di 401. Il cancello del contratto MCP
  // ora include una prova di RAGGIUNGIBILITÀ della rotta.
  if (/\/mcp\/?$/.test(path)) {
    return await handleMcp(req);
  }

  const rem = path.match(/\/r\/([A-Za-z0-9_-]{4,64})\/?$/);
  if (rem) {
    const platform = classify(req.headers.get("user-agent") ?? "");
    const androidLive = (Deno.env.get("ANDROID_STORE_LIVE") ?? "") === "true";
    const store = platform === "android" && androidLive
      ? `https://play.google.com/store/apps/details?id=${BUNDLE_ID}`
      : platform === "ios" && APPLE_APP_ID
      ? `https://apps.apple.com/app/id${APPLE_APP_ID}`
      : `${SITE}/beta`;
    const q = new URLSearchParams();
    const rawConcept = reqUrl.searchParams.get("concept");
    const concept =
      rawConcept && rawConcept.length <= 120 && !/[\x00-\x1f<>"']/.test(rawConcept)
        ? rawConcept
        : null;
    if (concept) q.set("concept", concept);
    const appHref = `fluera://r/${rem[1]}${q.size ? `?${q.toString()}` : ""}`;
    // 🌍 Chi arriva QUI non ha l'app (con l'app installata il link la apre
    // direttamente: App/Universal Links). La pagina parlava al device
    // sbagliato — «se l'app è installata, aprilo da lì» — e buttava via il
    // concetto, che è l'unica cosa che rende il link diverso dagli altri
    // (audit «Atlas al setaccio», P3). Lingua dal browser: l'italiano fisso
    // su una pagina pubblica è un'isola.
    const it = (req.headers.get("accept-language") ?? "").toLowerCase().startsWith("it");
    const t = it
      ? {
        lang: "it",
        titolo: concept ? `«${esc(concept)}» ti aspetta` : "Il tuo ripasso ti aspetta",
        corpo: concept
          ? "Questo link riapre i tuoi appunti su questo concetto, dentro Fluera."
          : "Questo link riapre un tuo quaderno dentro Fluera.",
        gia: "Ho già l'app",
        store: "Scarica Fluera",
        nota: "Il ripasso che conta si fa qui: a libro chiuso, con la tua calligrafia.",
      }
      : {
        lang: "en",
        titolo: concept ? `“${esc(concept)}” is waiting` : "Your review is waiting",
        corpo: concept
          ? "This link reopens your notes on this concept, inside Fluera."
          : "This link reopens one of your notebooks inside Fluera.",
        gia: "I already have the app",
        store: "Get Fluera",
        nota: "The review that counts happens here: closed-book, in your own handwriting.",
      };
    return html(
      200,
      `<!doctype html><html lang="${t.lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(t.titolo)} — Fluera</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#F6F7F9;color:#1B2030}main{text-align:center;padding:2rem;max-width:26rem}h1{font-size:1.5rem;line-height:1.25}a.btn{display:inline-block;margin-top:1rem;padding:.7rem 1.4rem;border-radius:10px;background:#2F4DC0;color:#fff;text-decoration:none;font-weight:600}a.alt{display:inline-block;margin-top:1rem;color:#2F4DC0}p{color:#5C6475}@media(prefers-color-scheme:dark){body{background:#101319;color:#E8EAF1}p{color:#9AA3B5}}</style>
</head><body><main>
<h1>${esc(t.titolo)}</h1>
<p>${esc(t.corpo)}</p>
<a class="btn" href="${store}">${esc(t.store)}</a>
<p style="margin-top:1.5rem"><a class="alt" href="${appHref}">${esc(t.gia)}</a></p>
<p style="font-size:.85rem;margin-top:1.5rem">${esc(t.nota)}</p>
</main></body></html>`,
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
};

if (import.meta.main) Deno.serve(servi);

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

// ── Card d'anteprima di una scheda privata ───────────────────────────────────
//
// 1200x630 interamente SINTETICA: nessuna immagine di base, solo forme e testo.
// Non puo' perdere nulla del contenuto perche' non ne conosce nulla — il token
// sta nel frammento e non arriva mai al server.
//
// Cache LUNGA: non cambia mai. La sorella `/s/{hash}/og.png` sta a 300 s perche'
// ci cuoce dentro i contatori vivi; qui non c'e' niente di vivo da rinfrescare.
//
// Degrada come la sorella: qualunque guasto del WASM o del font diventa un 302
// verso il banner generico, mai un 500 su un link che qualcuno ha appena
// toccato.
async function privateOgResponse(): Promise<Response> {
  try {
    const { Resvg, font } = await loadResvg();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">` +
      `<rect width="1200" height="630" fill="#0a0a0b"/>` +
      `<rect x="0" y="0" width="1200" height="6" fill="#6366f1"/>` +
      // Lucchetto disegnato a PATH, non come emoji: resvg non ha un font a
      // colori, e una emoji uscirebbe come rettangolo vuoto.
      `<g transform="translate(540,138)">` +
      `<path d="M30 62 V44 a30 30 0 0 1 60 0 V62" fill="none" stroke="#a5b4fc" stroke-width="13" stroke-linecap="round"/>` +
      `<rect x="8" y="62" width="104" height="84" rx="16" fill="#a5b4fc"/>` +
      `<circle cx="60" cy="98" r="10" fill="#0a0a0b"/>` +
      `<rect x="55" y="102" width="10" height="24" rx="5" fill="#0a0a0b"/>` +
      `</g>` +
      `<text x="600" y="386" text-anchor="middle" font-family="Noto Sans" font-size="62" font-weight="700" fill="#f4f4f5">Scheda privata</text>` +
      `<text x="600" y="446" text-anchor="middle" font-family="Noto Sans" font-size="32" fill="#a1a1aa">Qualcuno ti ha condiviso i suoi appunti</text>` +
      `<text x="600" y="492" text-anchor="middle" font-family="Noto Sans" font-size="32" fill="#a1a1aa">Solo chi ha il link può vederla</text>` +
      `<text x="600" y="576" text-anchor="middle" font-family="Noto Sans" font-size="28" font-weight="700" fill="#6366f1">Fluera</text>` +
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
    return new Response(new Uint8Array(resvg.render().asPng()), {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=86400, s-maxage=86400",
      },
    });
  } catch (e) {
    console.error(`\ud83d\udd12 private og render failed: ${e}`);
    return Response.redirect(OG_FALLBACK, 302);
  }
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
  // ⚠️ NON `OG_FALLBACK`: quello e' il banner marketing della home, e chi
  // riceveva un link privato vedeva in chat l'immagine del sito — il link si
  // leggeva come «ti ho mandato la homepage». Questa card e' generica quanto
  // quella (non puo' mostrare contenuto: il token e' nel frammento e qui non
  // arriva) ma dice CHE COS'E', che e' la differenza fra generico e sbagliato.
  const ogImg = "https://share.fluera.dev/p/og.png";
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
  <meta property="og:image" content="${esc(ogImg)}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(title)}" />
  <meta name="twitter:description" content="${esc(desc)}" />
  <meta name="twitter:image" content="${esc(ogImg)}" />
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

// ═══════════════════════════════════════════════════════════════════════════
// 🤝📡 MCP — il connettore dell'estratto di studio («Atlas risponde» L1)
//
// Contratto ereditato dallo spike L0 (tools/mcp-spike, kill-test superato il
// 2026-08-22) e dall'oracolo Dart `study_digest_smoke`:
//   • SCHEMA CHIUSO: le righe di `study_digest` passano da una proiezione ad
//     allowlist — un campo fuori contratto scritto da chiunque NON esce mai
//     (l'anti-dump del cancello canarino);
//   • CONTEGGI, MAI PERCENTUALI + riga epistemica + computed_at su ogni
//     risposta (freschezza onesta: se il device non pubblica da giorni, lo
//     si dice, non si finge);
//   • lista globale interleaved annotata per corso, mai silo per materia;
//   • SOLO lettura: nessun tool di scrittura esiste, per costruzione.
// ═══════════════════════════════════════════════════════════════════════════

const MCP_EPISTEMIC =
  "Conteggi, mai percentuali: secondo il modello, e se lo studente continua così.";
const MCP_METHOD_NOTE =
  "Il ripasso che conta si fa a libro chiuso dentro Fluera: questa lettura non registra nulla. " +
  "Fluera alterna le materie di proposito (interleaving): non trasformare la lista in una maratona mono-materia. " +
  "Chiudi SEMPRE un piano o un consiglio con il link `apri_in_fluera` del corso più urgente.";

// Etichette-stadio leggibili (dal kill-test L0: i nomi SrsStage nudi
// uscivano in inglese nel piano dell'assistente).
const MCP_STAGE_LABEL: Record<string, string> = {
  fragile: "🌱 fragile",
  growing: "🌿 in crescita",
  solid: "🌳 solido",
  mastered: "⭐ padroneggiato",
  integrated: "👻 integrato",
};
const mcpStageLabel = (s: string) => MCP_STAGE_LABEL[s] ?? s;

type McpDue = { title: string; next_review_ms: number; stage: string };
type McpErr = { title: string; next_review_ms: number };
type McpTopic = { topic: string; accuracy_band: string; trend: string };
type McpPayload = {
  name: string;
  exam_date_ms: number | null;
  outcome: string | null;
  readiness: { ready: number; at_risk: number; never_studied: number };
  feasibility: string;
  due: McpDue[];
  due_total: number;
  errors_due: McpErr[];
  errors_due_total: number;
  weak_topics: McpTopic[];
};
type McpRow = {
  block_id: string;
  canvas_id: string;
  computed_at_ms: number;
  payload: McpPayload;
};

function mcpPick<T>(src: Record<string, unknown>, keys: string[]): T {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in src) out[k] = src[k];
  return out as T;
}

// 🔒 Il cap dei VALORI, non solo delle chiavi (audit P1-5). `payload_json` è
// scritto da `authenticated` e la RLS non ne vincola la forma: senza questo,
// un titolo lungo quanto si vuole — cioè inchiostro dello studente — passava
// verbatim nel contesto del SUO assistente. Non è una difesa da injection
// (il testo di uno studente può sempre contenere frasi imperative), è il
// tetto che impedisce a una riga malformata di diventare un payload enorme.
const MCP_MAX_TEXT = 200;
const MCP_MAX_LIST = 50; // gemello di kDigestDueCap lato Dart
const mcpText = (v: unknown): string =>
  typeof v === "string" ? v.slice(0, MCP_MAX_TEXT) : "";

// La proiezione a schema chiuso: gemella di `projectRow` dello spike e del
// contratto Dart (`digestPayloadKeys` in study_digest_builder.dart).
export function mcpProjectRow(raw: Record<string, unknown>): McpRow {
  const row = mcpPick<McpRow>(raw, ["block_id", "canvas_id", "computed_at_ms", "payload"]);
  const rawPayload = (raw.payload_json ?? raw.payload ?? {}) as Record<string, unknown>;
  const p = mcpPick<McpPayload>(rawPayload, [
    "name", "exam_date_ms", "outcome", "readiness", "feasibility",
    "due", "due_total", "errors_due", "errors_due_total", "weak_topics",
  ]);
  p.readiness = mcpPick(((p.readiness ?? {}) as unknown) as Record<string, unknown>,
    ["ready", "at_risk", "never_studied"]) as McpPayload["readiness"];
  p.name = mcpText(p.name);
  p.due = ((p.due ?? []) as Record<string, unknown>[])
    .slice(0, MCP_MAX_LIST)
    .map((d) => {
      const e = mcpPick<McpDue>(d, ["title", "next_review_ms", "stage"]);
      e.title = mcpText(e.title);
      return e;
    });
  p.errors_due = ((p.errors_due ?? []) as Record<string, unknown>[])
    .slice(0, MCP_MAX_LIST)
    .map((x) => {
      const e = mcpPick<McpErr>(x, ["title", "next_review_ms"]);
      e.title = mcpText(e.title);
      return e;
    });
  p.weak_topics = ((p.weak_topics ?? []) as Record<string, unknown>[])
    .slice(0, MCP_MAX_LIST)
    .map((x) => {
      const e = mcpPick<McpTopic>(x, ["topic", "accuracy_band", "trend"]);
      e.topic = mcpText(e.topic);
      return e;
    });
  p.due_total = typeof p.due_total === "number" ? p.due_total : p.due.length;
  p.errors_due_total =
    typeof p.errors_due_total === "number" ? p.errors_due_total : p.errors_due.length;
  row.payload = p;
  return row;
}

// ── Auth: token personale → user_id, con una piccola cache positiva ─────────
// Cache SOLO dei successi (TTL 5 min): una revoca deve mordere entro il TTL,
// e un token sbagliato non deve potersi «scaldare» in cache.
const MCP_TOKEN_TTL_MS = 5 * 60 * 1000;
const _mcpTokenCache = new Map<string, { userId: string; at: number }>();

async function mcpResolveToken(token: string): Promise<string | null> {
  if (!/^fmcp_[a-f0-9]{48}$/.test(token)) return null;
  const hit = _mcpTokenCache.get(token);
  const now = Date.now();
  if (hit && now - hit.at < MCP_TOKEN_TTL_MS) return hit.userId;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/mcp_resolve_token`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ p_token: token }),
  });
  if (!resp.ok) return null;
  const rows = (await resp.json()) as Array<{ user_id?: string }>;
  const userId = rows?.[0]?.user_id ?? null;
  if (userId) {
    _mcpTokenCache.set(token, { userId, at: now });
    if (_mcpTokenCache.size > 5000) {
      for (const [k, v] of _mcpTokenCache) {
        if (now - v.at >= MCP_TOKEN_TTL_MS) _mcpTokenCache.delete(k);
      }
    }
  }
  return userId;
}

// Consenso per i token OAuth: il JWT non passa dalla RPC che lo verifica, ma
// il permesso deve restare vivo. Cache POSITIVA breve, come per i token: una
// revoca morde entro il TTL, e un rifiuto non si scalda mai in cache.
const _mcpOauthConsent = new Map<string, number>();
async function mcpOauthConsentOk(userId: string): Promise<boolean> {
  const now = Date.now();
  const hit = _mcpOauthConsent.get(userId);
  if (hit && now - hit < MCP_TOKEN_TTL_MS) return true;
  const ok = await oauthUserHasDigestConsent(userId);
  if (ok) {
    _mcpOauthConsent.set(userId, now);
    if (_mcpOauthConsent.size > 5000) {
      for (const [k, v] of _mcpOauthConsent) {
        if (now - v >= MCP_TOKEN_TTL_MS) _mcpOauthConsent.delete(k);
      }
    }
  }
  return ok;
}

// Rate limit per-token, stesso pattern floor-per-isolate dei limiter sopra.
const MCP_RL_MAX = 240;
const MCP_RL_WINDOW_MS = 10 * 60 * 1000;
const _mcpHits = new Map<string, number[]>();
function mcpRateLimited(key: string): boolean {
  const now = Date.now();
  const recent = (_mcpHits.get(key) ?? []).filter((t) => now - t < MCP_RL_WINDOW_MS);
  recent.push(now);
  _mcpHits.set(key, recent);
  if (_mcpHits.size > 5000) {
    for (const [k, v] of _mcpHits) {
      if (v.every((t) => now - t >= MCP_RL_WINDOW_MS)) _mcpHits.delete(k);
    }
  }
  return recent.length > MCP_RL_MAX;
}

async function mcpLoadDigest(userId: string): Promise<McpRow[] | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  const url = `${SUPABASE_URL}/rest/v1/study_digest` +
    `?user_id=eq.${encodeURIComponent(userId)}` +
    `&select=block_id,canvas_id,computed_at_ms,payload_json&order=block_id&limit=100`;
  const resp = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: "application/json",
    },
  });
  if (!resp.ok) return null;
  const rows = (await resp.json()) as Record<string, unknown>[];
  return rows.map(mcpProjectRow);
}

// ── I 5 tool (sola lettura) — porting fedele dello spike ────────────────────

const mcpIso = (ms: number | null | undefined) =>
  ms == null ? null : new Date(ms).toISOString().slice(0, 10);
// 📅 La data d'ESAME è un giorno del calendario dello studente, non un
// istante: il picker salva mezzanotte LOCALE, che in UTC cade il giorno
// prima per ogni fuso a est di Greenwich — «esame: D−1» per ogni studente
// italiano (audit P1-6). +12h prima dello slice riporta il giorno giusto
// per gli offset in (−12, +12]. Solo per `esame`: i bucket del forecast
// restano su mcpIso, dove l'istante è quello vero.
export const mcpExamDay = (ms: number | null | undefined) =>
  ms == null ? null : new Date(ms + 43_200_000).toISOString().slice(0, 10);
const mcpDaysLeft = (examMs: number | null, now: number) =>
  examMs == null ? null : Math.ceil((examMs - now) / 86_400_000);
const mcpOpenInApp = (canvasId: string) => `https://share.fluera.dev/r/${canvasId}`;

function mcpWrap(
  rows: McpRow[],
  body: Record<string, unknown>,
  now: number,
): Record<string, unknown> {
  const oldest = rows.length ? Math.min(...rows.map((r) => r.computed_at_ms)) : 0;
  // 🕰️ La freschezza va DETTA, non lasciata dedurre da un timestamp ISO che
  // l'assistente non guarderà (audit P3): l'età in giorni è un numero che
  // entra nel ragionamento, e sopra la soglia diventa un'istruzione esplicita.
  // Il digest si ripubblica a ogni chokepoint di studio: tre giorni di
  // silenzio significano che il device non studia o non pubblica.
  const etaGiorni = oldest
    ? Math.floor((now - oldest) / 86_400_000)
    : null;
  return {
    ...body,
    computed_at: oldest ? new Date(oldest).toISOString() : null,
    eta_giorni: etaGiorni,
    ...(etaGiorni !== null && etaGiorni >= 3
      ? {
        nota_freschezza:
          `Questo estratto è vecchio di ${etaGiorni} giorni: il device non ` +
          "pubblica da allora. Trattalo come una fotografia vecchia, dillo " +
          "allo studente, e non presentare le scadenze come se fossero di oggi.",
      }
      : {}),
    nota: MCP_EPISTEMIC,
    metodo: MCP_METHOD_NOTE,
  };
}

function mcpCourseSummary(r: McpRow, now: number): Record<string, unknown> {
  const p = r.payload;
  if (p.outcome === "passed") {
    return {
      corso: p.name,
      stato: "superato 🎉",
      esame: mcpExamDay(p.exam_date_ms),
      nota_corso: "Fuori dalla pianificazione: l'esame è passato.",
    };
  }
  return {
    corso: p.name,
    esame: mcpIso(p.exam_date_ms),
    giorni_rimanenti: mcpDaysLeft(p.exam_date_ms, now),
    prontezza: {
      sopra_soglia: p.readiness.ready,
      a_rischio: p.readiness.at_risk,
      mai_studiati: p.readiness.never_studied,
    },
    nota_prontezza: "«mai studiati» = mai visti: non è la stessa cosa di «a rischio».",
    fattibilita: p.feasibility,
    in_scadenza_ora: p.due.filter((d) => d.next_review_ms <= now).length,
    errori_da_ricontrollare: p.errors_due.filter((e) => e.next_review_ms <= now).length,
    // 📊 I totali che il DEVICE ha calcolato prima di cappare la lista: senza,
    // «5 in scadenza» poteva essere «5 fra i primi 50» spacciato per tutto.
    ...(p.due_total > p.due.length
      ? { nota_totale: `Elenco parziale: ${p.due.length} voci su ${p.due_total}.` }
      : {}),
    apri_in_fluera: mcpOpenInApp(r.canvas_id),
  };
}

function mcpFindCourse(rows: McpRow[], q: string): McpRow | undefined {
  const n = q.trim().toLowerCase();
  return rows.find((r) => r.payload.name.toLowerCase() === n) ??
    rows.find((r) => r.payload.name.toLowerCase().includes(n));
}

class McpRpcError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

export function mcpCallTool(
  rows: McpRow[],
  name: string,
  args: Record<string, unknown>,
  now: number,
): Record<string, unknown> {
  const active = rows.filter((r) => r.payload.outcome !== "passed");
  switch (name) {
    case "list_courses":
      return mcpWrap(rows, { corsi: rows.map((r) => mcpCourseSummary(r, now)) }, now);

    case "get_readiness": {
      const r = mcpFindCourse(rows, String(args.course ?? ""));
      if (!r) return mcpWrap(rows, { errore: `Corso non trovato: "${args.course}". Usa list_courses.` }, now);
      return mcpWrap([r], mcpCourseSummary(r, now), now);
    }

    case "get_due_now": {
      // 🕳️ Un corso non trovato NON deve produrre zeri: «0 in scadenza» e
      // «non conosco questo corso» sono due fatti diversi, e il secondo
      // travestito da primo fa dire all'assistente «sei a posto» (audit P3).
      if (args.course && !mcpFindCourse(active, String(args.course))) {
        return mcpWrap(rows, {
          errore: `Corso non trovato fra quelli attivi: "${args.course}". ` +
            "Usa list_courses: potrebbe avere un altro nome, o essere già superato.",
        }, now);
      }
      const scope = args.course
        ? [mcpFindCourse(active, String(args.course))].filter(Boolean) as McpRow[]
        : active;
      const due = scope.flatMap((r) =>
        r.payload.due.filter((d) => d.next_review_ms <= now).map((d) => ({
          concetto: d.title,
          corso: r.payload.name,
          stadio: mcpStageLabel(d.stage),
          in_ritardo_da_giorni: Math.max(0, Math.floor((now - d.next_review_ms) / 86_400_000)),
          apri_in_fluera: mcpOpenInApp(r.canvas_id),
        }))
      ).sort((a, b) => b.in_ritardo_da_giorni - a.in_ritardo_da_giorni);
      const errors = scope.flatMap((r) =>
        r.payload.errors_due.filter((e) => e.next_review_ms <= now).map((e) => ({
          errore: e.title,
          corso: r.payload.name,
        }))
      );
      const CAP = 20;
      return mcpWrap(scope.length ? scope : rows, {
        in_scadenza_ora: due.slice(0, CAP),
        totale_in_scadenza: due.length,
        ...(due.length > CAP ? { nota_cap: `Mostrati ${CAP} di ${due.length}.` } : {}),
        errori_da_ricontrollare: errors,
      }, now);
    }

    case "get_review_forecast": {
      const days = Math.min(Number(args.days ?? 7), 14);
      const buckets: Record<string, number> = { in_ritardo: 0 };
      for (let i = 0; i < days; i++) buckets[mcpIso(now + i * 86_400_000)!] = 0;
      for (const r of active) {
        for (const d of [...r.payload.due, ...r.payload.errors_due]) {
          if (d.next_review_ms <= now) buckets.in_ritardo++;
          else {
            const key = mcpIso(d.next_review_ms)!;
            if (key in buckets) buckets[key]++;
          }
        }
      }
      return mcpWrap(active.length ? active : rows, { previsione_ritorni: buckets }, now);
    }

    case "get_weak_topics": {
      if (args.course && !mcpFindCourse(active, String(args.course))) {
        return mcpWrap(rows, {
          errore: `Corso non trovato fra quelli attivi: "${args.course}". Usa list_courses.`,
        }, now);
      }
      const scope = args.course
        ? [mcpFindCourse(active, String(args.course))].filter(Boolean) as McpRow[]
        : active;
      const topics = scope.flatMap((r) =>
        r.payload.weak_topics.map((w) => ({
          topic: w.topic,
          corso: r.payload.name,
          accuratezza: w.accuracy_band,
          tendenza: w.trend,
        }))
      );
      return mcpWrap(scope.length ? scope : rows, {
        topic_deboli: topics,
        nota_fonte: "Solo topic con evidenza sufficiente dagli esami recenti in Fluera.",
      }, now);
    }

    default:
      throw new McpRpcError(-32602, `Tool sconosciuto: ${name}`);
  }
}

export const MCP_TOOL_DEFS = [
  {
    name: "list_courses",
    description:
      "Elenca i corsi dello studente su Fluera: data d'esame, giorni rimanenti, prontezza a conteggi (sopra soglia / a rischio / mai studiati), fattibilità, esito. Un corso «superato» è fuori dalla pianificazione.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_readiness",
    description:
      "La prontezza di UN corso proiettata alla sua data d'esame, a conteggi (mai percentuali), con la fattibilità al ritmo attuale.",
    inputSchema: {
      type: "object",
      properties: { course: { type: "string", description: "Nome del corso" } },
      required: ["course"],
      additionalProperties: false,
    },
  },
  {
    name: "get_due_now",
    description:
      "I concetti in scadenza ADESSO e gli errori da ricontrollare, lista globale annotata per corso (mai in silo: Fluera alterna le materie di proposito). Opzionale: filtra per corso. Chiudi ogni piano col link apri_in_fluera.",
    inputSchema: {
      type: "object",
      properties: { course: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "get_review_forecast",
    description:
      "Conteggi di ritorni dovuti per giorno, prossimi N giorni (default 7, max 14), più il bucket «in ritardo».",
    inputSchema: {
      type: "object",
      properties: { days: { type: "number" } },
      additionalProperties: false,
    },
  },
  {
    name: "get_weak_topics",
    description:
      "I topic deboli dagli esami recenti in Fluera: accuratezza (fascia), tendenza. Solo topic con evidenza sufficiente.",
    inputSchema: {
      type: "object",
      properties: { course: { type: "string" } },
      additionalProperties: false,
    },
  },
];

const MCP_CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
  "access-control-allow-headers":
    "content-type, authorization, mcp-session-id, mcp-protocol-version",
};

async function handleMcp(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: MCP_CORS });
  if (req.method === "DELETE") return new Response(null, { status: 200, headers: MCP_CORS });
  if (req.method !== "POST") return new Response(null, { status: 405, headers: MCP_CORS });

  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";
  // Il limiter PRIMA della validazione (convenzione del file: uno spammer non
  // deve schivarlo con un 401 economico). ⚠️ Chiave = SEMPRE l'IP, MAI il
  // token grezzo: con la chiave sul token, ruotare stringhe inventate dava un
  // bucket fresco a ogni tentativo — il 429 non scattava mai e ogni tentativo
  // pagava una RPC di risoluzione (audit «Atlas al setaccio», P1-4).
  const rlKey = `ip:${clientIp(req)}`;
  if (mcpRateLimited(rlKey)) {
    return new Response(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers: { ...MCP_CORS, "content-type": "application/json" },
    });
  }
  // Due credenziali, una porta: la chiave personale `fmcp_…` (L1, terminale) e
  // il token OAuth (L2, connettori web). Si prova prima quella di forma nota,
  // così un JWT non paga mai un round-trip alla RPC.
  let userId: string | null = null;
  // 🔎 Il MOTIVO del rifiuto viaggia col rifiuto. «Non autorizzato» e basta
  // costringe chi si collega a indovinare fra tre cose diverse — token
  // scaduto, consenso ritirato, chiave revocata — e due di quelle si
  // risolvono in dieci secondi SE si sa quale sia.
  let motivo = "nessuna credenziale: manca l'header Authorization";
  if (token.startsWith("fmcp_")) {
    userId = await mcpResolveToken(token);
    if (!userId) {
      motivo = "chiave personale non valida o revocata, oppure il consenso " +
        "«Assistente AI collegato» e spento in Fluera";
    }
  } else if (token.length > 0) {
    const claims = await jwtVerify(token);
    if (!claims) {
      motivo = "token non valido, scaduto, o emesso per un altro server";
    } else {
      const sub = String(claims.sub);
      // Il consenso vale anche qui: il JWT prova CHI sei, non che il permesso
      // sia ancora vivo. Stessa regola della chiave personale, stessa cache.
      if (await mcpOauthConsentOk(sub)) {
        userId = sub;
      } else {
        motivo = "il consenso «Assistente AI collegato» non e attivo su " +
          "questo account: accendilo in Fluera -> Impostazioni -> Privacy";
      }
    }
  }
  if (!userId) {
    // 🔎 La spec MCP pretende che il 401 dica DOVE trovare i metadati della
    // risorsa: è così che un client scopre l'authorization server senza che
    // nessuno glielo configuri a mano.
    return new Response(JSON.stringify({ error: "unauthorized", error_description: motivo }), {
      status: 401,
      headers: {
        ...MCP_CORS,
        "www-authenticate":
          `Bearer resource_metadata="${OAUTH_ISSUER}/.well-known/oauth-protected-resource", scope="${OAUTH_SCOPE}"`,
        "content-type": "application/json",
      },
    });
  }

  let msg: Record<string, unknown>;
  try {
    msg = await req.json() as Record<string, unknown>;
  } catch {
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON malformato" } }),
      { status: 400, headers: { ...MCP_CORS, "content-type": "application/json" } },
    );
  }

  // 📦 Un batch JSON-RPC è un ARRAY: senza questo cade nel ramo «notifica» e
  // riceve un 202 muto, cioè il client aspetta per sempre risposte che non
  // arriveranno. Meglio un errore esplicito: non supportiamo i batch.
  if (Array.isArray(msg)) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "batch non supportato: invia una richiesta per volta" },
      }),
      { status: 400, headers: { ...MCP_CORS, "content-type": "application/json" } },
    );
  }

  const { id, method, params } = msg as {
    id?: unknown;
    method?: string;
    params?: Record<string, unknown>;
  };
  const sessione = req.headers.get("mcp-session-id") ??
    hexOf(crypto.getRandomValues(new Uint8Array(16)));
  const reply = (payload: Record<string, unknown>, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: {
        ...MCP_CORS,
        "content-type": "application/json",
        // La spec vuole un identificativo di sessione unico e imprevedibile:
        // una costante e formalmente scorretta e alcuni client la rifiutano.
        "mcp-session-id": sessione,
      },
    });
  if (id === undefined) return new Response(null, { status: 202, headers: MCP_CORS }); // notifiche

  try {
    switch (method) {
      case "initialize":
        return reply({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: (params?.protocolVersion as string) ?? "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "fluera-study", version: "0.1.0" },
            instructions:
              "Dati di misura dello studio su Fluera (sola lettura). " +
              MCP_EPISTEMIC + " " + MCP_METHOD_NOTE,
          },
        });
      case "ping":
        return reply({ jsonrpc: "2.0", id, result: {} });
      case "tools/list":
        return reply({ jsonrpc: "2.0", id, result: { tools: MCP_TOOL_DEFS } });
      case "tools/call": {
        const rows = await mcpLoadDigest(userId);
        if (rows === null) {
          return reply({
            jsonrpc: "2.0",
            id,
            error: { code: -32603, message: "digest non raggiungibile: riprova" },
          });
        }
        const toolName = String(params?.name ?? "");
        const args = (params?.arguments ?? {}) as Record<string, unknown>;
        // 🕳️ Nessuna riga ha TRE cause diverse e non possiamo distinguerle da
        // qui: il token ha già provato che il consenso è vivo (la RPC lo
        // pretende), quindi restano «nessun corso ancora» e «il device non ha
        // mai pubblicato». Dirle entrambe è onesto; indovinarne una no.
        const out = rows.length === 0
          ? {
            corsi: [],
            nota: "Nessun estratto pubblicato. Due cause possibili, e da qui " +
              "non sono distinguibili: lo studente non ha ancora corsi in " +
              "Fluera, oppure l'app non ha ancora pubblicato da questo " +
              "dispositivo. Non dedurne che non abbia nulla da studiare.",
            metodo: MCP_METHOD_NOTE,
          }
          : mcpCallTool(rows, toolName, args, Date.now());
        return reply({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] },
        });
      }
      default:
        return reply({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Metodo non supportato: ${method}` },
        });
    }
  } catch (e) {
    const code = e instanceof McpRpcError ? e.code : -32603;
    return reply({
      jsonrpc: "2.0",
      id,
      error: { code, message: String((e as Error).message ?? e) },
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 🔐 OAUTH 2.1 — l'authorization server del connettore («Atlas risponde» L2)
//
// PERCHÉ ESISTE: i connettori web (claude.ai, ChatGPT) non hanno un campo per
// una chiave personale — parlano OAuth. Finché c'era solo `fmcp_…`, la
// promessa «collega il tuo assistente» valeva per i soli client da terminale.
//
// COSA IMPONE LA SPEC MCP, e dove sta qui:
//   • RFC 9728 Protected Resource Metadata  → /.well-known/oauth-protected-resource
//   • RFC 8414 Authorization Server Metadata→ /.well-known/oauth-authorization-server
//   • WWW-Authenticate col `resource_metadata` sul 401
//   • PKCE S256 obbligatorio (OAuth 2.1) — `plain` RIFIUTATO
//   • RFC 8707 `resource` + audience VALIDATA lato risorsa
//   • RFC 9207 `iss` nella risposta di autorizzazione
//   • RFC 7591 Dynamic Client Registration (deprecata dalla spec ma è ciò che
//     i connettori usano oggi; tenuta con tetto e validazione delle redirect)
//
// SCELTA DI IDENTITÀ: l'utente NON si autentica qui con una password. Il
// consenso rimbalza su Supabase Auth col flusso PKCE del provider (Google /
// Apple), che è come si accede a Fluera — chi entra con Google non ha una
// password da digitare, e noi non dobbiamo custodirne una.
//
// IL TOKEN: JWT HS256 con `aud` = URI canonico del nostro MCP. Verificato in
// locale a ogni richiesta (nessun round-trip). Ciò che va revocato — codici e
// refresh — vive nel database; l'access token dura poco e non si revoca.
// ═══════════════════════════════════════════════════════════════════════════

export const MCP_RESOURCE = "https://share.fluera.dev/mcp"; // URI canonico (RFC 8707)
export const OAUTH_ISSUER = "https://share.fluera.dev";
const OAUTH_SCOPE = "study:read";
const OAUTH_CODE_TTL_MS = 10 * 60 * 1000;
const OAUTH_ACCESS_TTL_S = 60 * 60; // 1 ora: corta di proposito, c'è il refresh

const enc = new TextEncoder();

const b64url = (b: ArrayBuffer | Uint8Array): string => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (const x of u) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64urlDecode = (s: string): Uint8Array<ArrayBuffer> => {
  const p = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const raw = atob(p);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};
async function sha256(s: string): Promise<Uint8Array<ArrayBuffer>> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return new Uint8Array(d);
}
const hexOf = (u: Uint8Array) =>
  [...u].map((b) => b.toString(16).padStart(2, "0")).join("");
// PostgREST vuole i bytea in esadecimale con prefisso `\x`.
const pgHex = (u: Uint8Array) => `\\x${hexOf(u)}`;

async function hmacKey(): Promise<CryptoKey> {
  const secret = Deno.env.get("MCP_JWT_SECRET") ?? "";
  if (secret.length < 32) {
    // Fail-closed: senza segreto NON si firma nulla. Un segreto assente che
    // diventasse la stringa vuota renderebbe falsificabile ogni token.
    throw new Error("MCP_JWT_SECRET assente o troppo corto (min 32 caratteri)");
  }
  return await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function jwtSign(claims: Record<string, unknown>): Promise<string> {
  const head = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(enc.encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(), enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

/// Verifica firma, scadenza, emittente e — la parte che la spec chiama per
/// nome — l'AUDIENCE: un token emesso per un altro server non vale qui.
export async function jwtVerify(token: string): Promise<Record<string, unknown> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  let ok = false;
  try {
    ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(),
      b64urlDecode(sig),
      enc.encode(`${head}.${body}`),
    );
  } catch {
    return null; // segreto mancante = nessun token è valido
  }
  if (!ok) return null;
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= now) return null;
  if (claims.iss !== OAUTH_ISSUER) return null;
  const aud = claims.aud;
  const audOk = Array.isArray(aud) ? aud.includes(MCP_RESOURCE) : aud === MCP_RESOURCE;
  if (!audOk) return null; // RFC 8707: emesso per NOI, o non vale
  if (typeof claims.sub !== "string" || claims.sub.length === 0) return null;
  return claims;
}

// ── Accesso al database con service_role (stessa forma del resto del file) ──
async function pgFetch(path: string, init: RequestInit = {}): Promise<Response | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  return await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers ?? {}),
    },
  });
}

const oauthJson = (obj: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": status === 200 ? "public, max-age=300" : "no-store",
      ...MCP_CORS,
      ...extra,
    },
  });
const oauthError = (error: string, desc: string, status = 400) =>
  oauthJson({ error, error_description: desc }, status);

// ── I metadati (RFC 9728 e RFC 8414) ────────────────────────────────────────

export function protectedResourceMetadata(): Response {
  return oauthJson({
    resource: MCP_RESOURCE,
    authorization_servers: [OAUTH_ISSUER],
    scopes_supported: [OAUTH_SCOPE],
    bearer_methods_supported: ["header"],
    resource_documentation: `${OAUTH_ISSUER}/connect`,
  });
}

export function authorizationServerMetadata(): Response {
  return oauthJson({
    issuer: OAUTH_ISSUER,
    authorization_endpoint: `${OAUTH_ISSUER}/oauth/authorize`,
    token_endpoint: `${OAUTH_ISSUER}/oauth/token`,
    registration_endpoint: `${OAUTH_ISSUER}/oauth/register`,
    revocation_endpoint: `${OAUTH_ISSUER}/oauth/revoke`,
    scopes_supported: [OAUTH_SCOPE],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    // 🔒 SOLO S256: OAuth 2.1 vieta `plain`, e dichiararlo qui significa che
    // nessun client può nemmeno provarci.
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"], // client pubblici + PKCE
    authorization_response_iss_parameter_supported: true, // RFC 9207
  });
}

// ── /oauth/register — Dynamic Client Registration (RFC 7591) ────────────────
// La spec la segna deprecata a favore dei Client ID Metadata Documents, ma i
// connettori in campo oggi registrano dinamicamente: senza questo, claude.ai
// non arriva nemmeno alla schermata di consenso.
async function oauthRegister(req: Request): Promise<Response> {
  if (req.method !== "POST") return oauthError("invalid_request", "usa POST", 405);
  if (oauthRateLimited(`reg:${clientIp(req)}`, 20)) {
    return oauthError("temporarily_unavailable", "troppe registrazioni", 429);
  }
  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return oauthError("invalid_client_metadata", "JSON malformato");
  }
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris as unknown[] : [];
  const redirects: string[] = [];
  for (const u of uris) {
    if (typeof u !== "string" || u.length > 512) continue;
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      return oauthError("invalid_redirect_uri", `redirect_uri non è una URL: ${u}`);
    }
    // 🔒 Solo https, o localhost in chiaro per i client da scrivania (OAuth
    // 2.1 §8.4.2). Un `http://` verso l'esterno rimanderebbe un codice di
    // autorizzazione su un canale in chiaro; niente frammenti, niente
    // credenziali nell'URL.
    const localhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && localhost)) {
      return oauthError("invalid_redirect_uri", `solo https (o http su localhost): ${u}`);
    }
    if (parsed.hash) return oauthError("invalid_redirect_uri", "niente frammento");
    redirects.push(parsed.toString());
  }
  if (redirects.length === 0) {
    return oauthError("invalid_redirect_uri", "serve almeno una redirect_uri valida");
  }

  const clientId = `fmcpc_${hexOf(crypto.getRandomValues(new Uint8Array(16)))}`;
  const name = typeof body.client_name === "string" ? body.client_name.slice(0, 120) : "";
  const resp = await pgFetch("oauth_clients", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ client_id: clientId, client_name: name, redirect_uris: redirects }),
  });
  if (!resp || !resp.ok) {
    return oauthError("server_error", "registrazione non riuscita", 503);
  }
  return oauthJson({
    client_id: clientId,
    client_name: name,
    redirect_uris: redirects,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    client_id_issued_at: Math.floor(Date.now() / 1000),
  }, 201, { "cache-control": "no-store" });
}

// Limitatore condiviso dagli endpoint OAuth (stesso pattern-casa per-isolate).
const _oauthHits = new Map<string, number[]>();
function oauthRateLimited(key: string, max: number): boolean {
  const now = Date.now();
  const win = 10 * 60 * 1000;
  const recent = (_oauthHits.get(key) ?? []).filter((t) => now - t < win);
  recent.push(now);
  _oauthHits.set(key, recent);
  if (_oauthHits.size > 5000) {
    for (const [k, v] of _oauthHits) {
      if (v.every((t) => now - t >= win)) _oauthHits.delete(k);
    }
  }
  return recent.length > max;
}

// ── /oauth/authorize — il consenso, con l'identità presa da Supabase ────────
// Due passaggi: (1) senza sessione, si rimbalza su Supabase (Google/Apple) col
// flusso PKCE, portandosi dietro i parametri OAuth nello `state`; (2) tornati
// col codice di Supabase, lo si scambia per l'identità e si mostra la
// schermata di consenso, che è l'unico punto in cui l'utente decide.
async function oauthAuthorize(req: Request, url: URL): Promise<Response> {
  const p = url.searchParams;
  const clientId = p.get("client_id") ?? "";
  const redirectUri = p.get("redirect_uri") ?? "";
  const challenge = p.get("code_challenge") ?? "";
  const method = p.get("code_challenge_method") ?? "";
  const state = p.get("state") ?? "";
  const resource = p.get("resource") ?? MCP_RESOURCE;

  // 🔑 Gli errori PRIMA di aver validato client+redirect NON si rimandano al
  // redirect_uri (sarebbe un open redirect): si mostrano qui.
  if (p.get("response_type") !== "code") {
    return html(400, statusPage("Richiesta non valida", "response_type deve essere «code»."));
  }
  if (!clientId || !redirectUri) {
    return html(400, statusPage("Richiesta non valida", "Mancano client_id o redirect_uri."));
  }
  const client = await oauthLoadClient(clientId);
  if (!client) {
    return html(400, statusPage("Applicazione sconosciuta", "Questo client non è registrato."));
  }
  if (!client.redirect_uris.includes(redirectUri)) {
    // Confronto ESATTO, mai per prefisso: un match parziale è la via classica
    // per farsi consegnare i codici altrove.
    return html(400, statusPage("Indirizzo di ritorno non valido", "Non corrisponde a quelli registrati."));
  }
  // Da qui in poi l'errore può tornare al client, che è registrato.
  const back = (err: string, desc: string) => {
    const u = new URL(redirectUri);
    u.searchParams.set("error", err);
    u.searchParams.set("error_description", desc);
    u.searchParams.set("iss", OAUTH_ISSUER); // RFC 9207 anche sugli errori
    if (state) u.searchParams.set("state", state);
    return Response.redirect(u.toString(), 302);
  };
  if (method !== "S256") return back("invalid_request", "serve PKCE con S256");
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(challenge)) {
    return back("invalid_request", "code_challenge malformato");
  }
  if (resource !== MCP_RESOURCE) {
    // RFC 8707: un token per un'altra risorsa non lo emettiamo.
    return back("invalid_target", `resource deve essere ${MCP_RESOURCE}`);
  }

  const richiesta = { clientId, redirectUri, challenge, state, resource };

  // (Il ritorno da Supabase NON passa di qui: ha la sua rotta, /oauth/callback,
  // che è l'unico posto dove lo stato firmato viene riaperto e il modulo del
  // consenso riceve il suo valore. Un secondo ramo qui rendeva la pagina col
  // segnaposto letterale al posto dello stato.)

  // Passo 1: nessuna identità → si va ad accedere a Fluera.
  const ritorno = new URL(`${OAUTH_ISSUER}/oauth/callback`);
  // 🔏 FIRMATO, non solo impacchettato: il callback verifica l'HMAC, e uno
  // stato non firmato faceva morire OGNI collegamento con «sessione scaduta».
  // (Trovato prima che ci passasse un utente: i pezzi erano provati, il
  // percorso no — la stessa lezione della rotta /mcp cancellata.)
  const statoFirmato = await oauthSignState(richiesta);
  ritorno.searchParams.set("fluera_state", statoFirmato);
  const provider = p.get("provider") === "apple" ? "apple" : "google";
  const sbAuth = new URL(`${SUPABASE_URL}/auth/v1/authorize`);
  sbAuth.searchParams.set("provider", provider);
  sbAuth.searchParams.set("redirect_to", ritorno.toString());
  // ⚠️ `flow_type=pkce` NON è un parametro REST: è un'opzione della libreria
  // JS, che poi manda QUESTI due. Mandandolo, Supabase lo ignorava e usava il
  // flusso implicito — token nel FRAMMENTO dell'URL, che al server non arriva
  // mai: il callback non vedeva nessun codice e ogni collegamento moriva in
  // «Autorizzazione non riuscita» (misurato dal vivo il 2026-08-22).
  sbAuth.searchParams.set(
    "code_challenge", b64url(await sha256(await pkceVerifierFor(statoFirmato))),
  );
  sbAuth.searchParams.set("code_challenge_method", "s256");
  return html(200, renderOauthSignIn(client.client_name || clientId, sbAuth.toString()));
}

type OauthRichiesta = {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  resource: string;
};

// Lo stato viaggia FIRMATO — UNA sola funzione per produrlo, così non può
// più esistere una via che impacchetta senza firmare: senza firma, chi torna
// dal provider potrebbe riscrivere client_id o redirect_uri e farsi
// consegnare il codice altrove.
/// 🔑 Il verifier PKCE per il login su Supabase, DERIVATO dallo stato firmato
/// con lo stesso segreto: non serve conservarlo e non viaggia mai nell'URL —
/// chi non ha il segreto non può calcolarlo. (Infilarlo nello stato avrebbe
/// fatto viaggiare verifier e codice insieme: PKCE sarebbe stato decorativo.)
export async function pkceVerifierFor(statePayload: string): Promise<string> {
  const mac = await crypto.subtle.sign(
    "HMAC", await hmacKey(), enc.encode(`pkce-supabase:${statePayload}`),
  );
  return b64url(mac); // 43 caratteri base64url, la lunghezza che la RFC vuole
}

export async function oauthSignState(r: OauthRichiesta): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(r)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(), enc.encode(payload));
  return `${payload}.${b64url(sig)}`;
}
export async function oauthOpenState(signed: string): Promise<OauthRichiesta | null> {
  const i = signed.lastIndexOf(".");
  if (i < 0) return null;
  const payload = signed.slice(0, i);
  try {
    const ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(),
      b64urlDecode(signed.slice(i + 1)),
      enc.encode(payload),
    );
    if (!ok) return null;
    return JSON.parse(new TextDecoder().decode(b64urlDecode(payload))) as OauthRichiesta;
  } catch {
    return null;
  }
}

async function oauthLoadClient(
  clientId: string,
): Promise<{ client_id: string; client_name: string; redirect_uris: string[] } | null> {
  if (!/^fmcpc_[a-f0-9]{32}$/.test(clientId)) return null;
  const r = await pgFetch(
    `oauth_clients?client_id=eq.${encodeURIComponent(clientId)}&select=client_id,client_name,redirect_uris&limit=1`,
  );
  if (!r || !r.ok) return null;
  const rows = await r.json() as Array<{ client_id: string; client_name: string; redirect_uris: string[] }>;
  return rows[0] ?? null;
}

/// Scambia il codice di Supabase per l'identità dell'utente. Il token di
/// sessione NON viene conservato: qui serve solo sapere CHI è.
async function supabaseIdentityFromCode(
  code: string,
  statePayload: string,
): Promise<{ userId: string; email: string } | null> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=pkce`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      auth_code: code,
      code_verifier: await pkceVerifierFor(statePayload),
    }),
  });
  if (!r.ok) return null;
  const d = await r.json() as { user?: { id?: string; email?: string } };
  const id = d.user?.id;
  if (!id) return null;
  return { userId: id, email: d.user?.email ?? "" };
}

// ── Le due pagine del flusso ────────────────────────────────────────────────
// Stile sobrio e coerente con la pagina /r; nessuno script di terze parti.

const oauthShell = (titolo: string, corpo: string) =>
  `<!doctype html><html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(titolo)} — Fluera</title>
<style>
body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#F6F7F9;color:#1B2030}
main{max-width:26rem;padding:2rem;text-align:left}
h1{font-size:1.4rem;line-height:1.25;margin:0 0 .5rem}
p{color:#5C6475;line-height:1.6}
ul{color:#5C6475;line-height:1.6;padding-left:1.1rem}
li{margin-bottom:.35rem}
.btn{display:inline-block;margin-top:1rem;padding:.7rem 1.4rem;border-radius:10px;background:#2F4DC0;color:#fff;text-decoration:none;font-weight:600;border:0;font-size:1rem;cursor:pointer}
.ghost{background:none;color:#5C6475;font-weight:500;padding:.7rem 1rem}
.who{font-size:.85rem;color:#5C6475;margin-top:1.5rem;padding-top:1rem;border-top:1px solid #DDE1E9}
@media(prefers-color-scheme:dark){body{background:#101319;color:#E8EAF1}p,ul,.who{color:#9AA3B5}.who{border-color:#2A3040}}
</style></head><body><main>${corpo}</main></body></html>`;

function renderOauthSignIn(clientName: string, signInUrl: string): string {
  return oauthShell(
    "Collega il tuo assistente",
    `<h1>${esc(clientName)} vuole collegarsi a Fluera</h1>
<p>Per continuare, accedi con l'account che usi su Fluera. Non serve una
password: si entra con Google o Apple, come nell'app.</p>
<p><a class="btn" href="${esc(signInUrl)}">Accedi a Fluera</a></p>
<p class="who">Fluera non riceve la tua password: l'accesso avviene sul
provider che hai scelto.</p>`,
  );
}

function renderOauthConsent(
  clientName: string,
  ident: { userId: string; email: string },
  r: OauthRichiesta,
): string {
  // Lo stato firmato viaggia nel form: il POST di approvazione non si fida di
  // nulla che il browser possa aver riscritto.
  return oauthShell(
    "Autorizzare?",
    `<h1>${esc(clientName)} potrà leggere il tuo stato di studio</h1>
<p>Cosa vedrà:</p>
<ul>
  <li>i tuoi corsi, con date d'esame ed esiti;</li>
  <li>quanti concetti sono sopra soglia, a rischio o mai studiati;</li>
  <li>i titoli dei concetti da ripassare e quando scadono;</li>
  <li>i topic su cui vai peggio.</li>
</ul>
<p><strong>Cosa non vedrà mai:</strong> i tuoi appunti, la tua calligrafia, il
testo riconosciuto, le immagini. E non può scrivere nulla: il ripasso che
conta si fa dentro Fluera, a libro chiuso.</p>
<form method="POST" action="/oauth/approve">
  <input type="hidden" name="req" value="__STATO__">
  <input type="hidden" name="uid" value="${esc(ident.userId)}">
  <button class="btn" type="submit" name="ok" value="1">Autorizza</button>
  <button class="btn ghost" type="submit" name="ok" value="0">Annulla</button>
</form>
<p class="who">Accesso come ${esc(ident.email)} · Puoi revocare quando vuoi da
Impostazioni → Funzioni cognitive → Collega il tuo assistente.</p>`,
  );
}

// ── /oauth/callback — si torna da Supabase, si mostra il consenso ───────────
async function oauthCallback(url: URL): Promise<Response> {
  const signed = url.searchParams.get("fluera_state") ?? "";
  const r = await oauthOpenState(signed);
  if (!r) {
    return html(400, statusPage("Sessione scaduta", "Riprova il collegamento dall'inizio."));
  }
  const code = url.searchParams.get("code") ?? "";
  if (!code) {
    const u = new URL(r.redirectUri);
    u.searchParams.set("error", "access_denied");
    u.searchParams.set("iss", OAUTH_ISSUER);
    if (r.state) u.searchParams.set("state", r.state);
    return Response.redirect(u.toString(), 302);
  }
  const ident = await supabaseIdentityFromCode(code, signed);
  if (!ident) {
    return html(400, statusPage("Accesso non riuscito", "Riprova il collegamento."));
  }
  const client = await oauthLoadClient(r.clientId);
  const pagina = renderOauthConsent(client?.client_name || r.clientId, ident, r)
    .replace("__STATO__", esc(await oauthSignState(r)));
  return html(200, pagina);
}

// ── /oauth/approve — l'utente ha deciso: si conia il codice ────────────────
async function oauthApprove(req: Request): Promise<Response> {
  if (req.method !== "POST") return oauthError("invalid_request", "usa POST", 405);
  const form = await req.formData();
  const r = await oauthOpenState(String(form.get("req") ?? ""));
  if (!r) return html(400, statusPage("Sessione scaduta", "Riprova dall'inizio."));
  const uid = String(form.get("uid") ?? "");
  if (!/^[0-9a-f-]{36}$/.test(uid)) {
    return html(400, statusPage("Richiesta non valida", "Identità mancante."));
  }
  const u = new URL(r.redirectUri);
  if (r.state) u.searchParams.set("state", r.state);
  u.searchParams.set("iss", OAUTH_ISSUER); // RFC 9207

  if (String(form.get("ok")) !== "1") {
    u.searchParams.set("error", "access_denied");
    return Response.redirect(u.toString(), 302);
  }

  // 🛡️ Il consenso `studyDigest` è la condizione, non un dettaglio: senza,
  // autorizzare un assistente a leggere un estratto che non esiste (e che il
  // server rifiuterebbe comunque) sarebbe una porta che non porta da nessuna
  // parte. Meglio dirlo qui.
  if (!await oauthUserHasDigestConsent(uid)) {
    return html(200, oauthShell(
      "Manca un passaggio",
      `<h1>Prima attiva «Assistente AI collegato»</h1>
<p>Il collegamento legge il tuo estratto di studio, e quell'estratto viene
pubblicato solo con il tuo consenso.</p>
<p>Apri Fluera → Impostazioni → Privacy → <strong>Assistente AI
collegato</strong>, poi riprova da qui.</p>`,
    ));
  }

  const code = `fmcpa_${hexOf(crypto.getRandomValues(new Uint8Array(32)))}`;
  const ins = await pgFetch("oauth_codes", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      code_sha256: pgHex(await sha256(code)),
      client_id: r.clientId,
      user_id: uid,
      redirect_uri: r.redirectUri,
      code_challenge: r.challenge,
      resource: r.resource,
      scope: OAUTH_SCOPE,
      expires_at: new Date(Date.now() + OAUTH_CODE_TTL_MS).toISOString(),
    }),
  });
  if (!ins || !ins.ok) {
    return html(503, statusPage("Riprova", "Non è stato possibile completare ora."));
  }
  u.searchParams.set("code", code);
  return Response.redirect(u.toString(), 302);
}

async function oauthUserHasDigestConsent(uid: string): Promise<boolean> {
  const r = await pgFetch(
    `user_consent_state?user_id=eq.${encodeURIComponent(uid)}&category=eq.studyDigest&granted=is.true&select=user_id&limit=1`,
  );
  if (!r || !r.ok) return false; // fail-closed
  return ((await r.json()) as unknown[]).length > 0;
}

// ── /oauth/token — codice → token, e refresh con rotazione ─────────────────
async function oauthToken(req: Request): Promise<Response> {
  if (req.method !== "POST") return oauthError("invalid_request", "usa POST", 405);
  if (oauthRateLimited(`tok:${clientIp(req)}`, 120)) {
    return oauthError("temporarily_unavailable", "troppe richieste", 429);
  }
  const form = await req.formData().catch(() => null);
  if (!form) return oauthError("invalid_request", "serve application/x-www-form-urlencoded");
  const grant = String(form.get("grant_type") ?? "");
  if (grant === "authorization_code") return await oauthGrantCode(form);
  if (grant === "refresh_token") return await oauthGrantRefresh(form);
  return oauthError("unsupported_grant_type", `grant_type non supportato: ${grant}`);
}

async function oauthIssue(
  userId: string,
  clientId: string,
  resource: string,
  scope: string,
): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const access = await jwtSign({
    iss: OAUTH_ISSUER,
    sub: userId,
    aud: resource,
    client_id: clientId,
    scope,
    iat: now,
    exp: now + OAUTH_ACCESS_TTL_S,
    jti: hexOf(crypto.getRandomValues(new Uint8Array(12))),
  });
  const refresh = `fmcpr_${hexOf(crypto.getRandomValues(new Uint8Array(32)))}`;
  const ins = await pgFetch("oauth_refresh_tokens", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      token_sha256: pgHex(await sha256(refresh)),
      client_id: clientId,
      user_id: userId,
      resource,
      scope,
    }),
  });
  if (!ins || !ins.ok) return oauthError("server_error", "emissione non riuscita", 503);
  return oauthJson({
    access_token: access,
    token_type: "Bearer",
    expires_in: OAUTH_ACCESS_TTL_S,
    refresh_token: refresh,
    scope,
  }, 200, { "cache-control": "no-store" });
}

async function oauthGrantCode(form: FormData): Promise<Response> {
  const code = String(form.get("code") ?? "");
  const verifier = String(form.get("code_verifier") ?? "");
  const redirectUri = String(form.get("redirect_uri") ?? "");
  const clientId = String(form.get("client_id") ?? "");
  if (!code || !verifier || !redirectUri || !clientId) {
    return oauthError("invalid_request", "mancano parametri obbligatori");
  }
  const key = pgHex(await sha256(code));
  const r = await pgFetch(
    `oauth_codes?code_sha256=eq.${encodeURIComponent(key)}&select=*&limit=1`,
  );
  if (!r || !r.ok) return oauthError("server_error", "riprova", 503);
  const rows = await r.json() as Array<Record<string, string>>;
  const row = rows[0];
  if (!row) return oauthError("invalid_grant", "codice sconosciuto");

  // 🔁 RIUSO = FURTO. Un codice già consumato che ricompare significa che
  // qualcuno l'ha intercettato: OAuth 2.1 §4.1.3 vuole che si neghi, e che si
  // ritirino i token già emessi da quel codice. Qui si ritira la sessione.
  if (row.consumed_at) {
    await pgFetch(
      `oauth_refresh_tokens?user_id=eq.${encodeURIComponent(row.user_id)}&client_id=eq.${encodeURIComponent(row.client_id)}&revoked_at=is.null`,
      { method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ revoked_at: new Date().toISOString() }) },
    );
    return oauthError("invalid_grant", "codice già usato");
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return oauthError("invalid_grant", "codice scaduto");
  }
  if (row.client_id !== clientId) return oauthError("invalid_grant", "client non corrispondente");
  if (row.redirect_uri !== redirectUri) {
    return oauthError("invalid_grant", "redirect_uri non corrispondente");
  }
  // PKCE S256: SHA-256 del verifier, in base64url, deve dare la challenge.
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
    return oauthError("invalid_grant", "code_verifier malformato");
  }
  if (b64url(await sha256(verifier)) !== row.code_challenge) {
    return oauthError("invalid_grant", "code_verifier non corrisponde");
  }

  // Consumo ATOMICO: il PATCH filtra su `consumed_at is null`, quindi due
  // richieste in corsa non possono riuscire entrambe.
  const consume = await pgFetch(
    `oauth_codes?code_sha256=eq.${encodeURIComponent(key)}&consumed_at=is.null`,
    { method: "PATCH", headers: { Prefer: "return=representation" },
      body: JSON.stringify({ consumed_at: new Date().toISOString() }) },
  );
  if (!consume || !consume.ok) return oauthError("server_error", "riprova", 503);
  if (((await consume.json()) as unknown[]).length !== 1) {
    return oauthError("invalid_grant", "codice già usato");
  }
  if (!await oauthUserHasDigestConsent(row.user_id)) {
    return oauthError("access_denied", "il consenso allo studio è stato ritirato", 403);
  }
  return await oauthIssue(row.user_id, row.client_id, row.resource, row.scope);
}

async function oauthGrantRefresh(form: FormData): Promise<Response> {
  const token = String(form.get("refresh_token") ?? "");
  if (!/^fmcpr_[a-f0-9]{64}$/.test(token)) {
    return oauthError("invalid_grant", "refresh_token malformato");
  }
  const key = pgHex(await sha256(token));
  const r = await pgFetch(
    `oauth_refresh_tokens?token_sha256=eq.${encodeURIComponent(key)}&select=*&limit=1`,
  );
  if (!r || !r.ok) return oauthError("server_error", "riprova", 503);
  const row = (await r.json() as Array<Record<string, string | null>>)[0];
  if (!row) return oauthError("invalid_grant", "refresh sconosciuto");
  if (row.revoked_at) return oauthError("invalid_grant", "sessione revocata");
  if (row.rotated_to) {
    // Un refresh GIÀ ruotato che ritorna = copia rubata: si chiude tutta la
    // catena di quell'utente per quel client (OAuth 2.1 §4.3.1).
    await pgFetch(
      `oauth_refresh_tokens?user_id=eq.${encodeURIComponent(String(row.user_id))}&client_id=eq.${encodeURIComponent(String(row.client_id))}&revoked_at=is.null`,
      { method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ revoked_at: new Date().toISOString() }) },
    );
    return oauthError("invalid_grant", "refresh già usato: sessione chiusa per sicurezza");
  }
  if (!await oauthUserHasDigestConsent(String(row.user_id))) {
    return oauthError("access_denied", "il consenso allo studio è stato ritirato", 403);
  }
  const emesso = await oauthIssue(
    String(row.user_id), String(row.client_id), String(row.resource), String(row.scope),
  );
  if (emesso.status === 200) {
    const body = await emesso.clone().json() as { refresh_token: string };
    await pgFetch(`oauth_refresh_tokens?token_sha256=eq.${encodeURIComponent(key)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        rotated_to: pgHex(await sha256(body.refresh_token)),
        last_used_at: new Date().toISOString(),
      }),
    });
  }
  return emesso;
}

// ── /oauth/revoke — RFC 7009, sempre 200 (non si rivela cosa esisteva) ─────
async function oauthRevoke(req: Request): Promise<Response> {
  if (req.method !== "POST") return oauthError("invalid_request", "usa POST", 405);
  const form = await req.formData().catch(() => null);
  const token = String(form?.get("token") ?? "");
  if (/^fmcpr_[a-f0-9]{64}$/.test(token)) {
    await pgFetch(
      `oauth_refresh_tokens?token_sha256=eq.${encodeURIComponent(pgHex(await sha256(token)))}`,
      { method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ revoked_at: new Date().toISOString() }) },
    );
  }
  return new Response(null, { status: 200, headers: MCP_CORS });
}

// ── /connect — come si collega un assistente, in una pagina sola ───────────
function renderConnectPage(req: Request): string {
  const it = (req.headers.get("accept-language") ?? "").toLowerCase().startsWith("it");
  const t = it
    ? {
      h: "Collega il tuo assistente a Fluera",
      p: "Il tuo assistente AI può leggere <strong>cosa devi ripassare e quando</strong>: corsi, date d'esame, concetti in scadenza, argomenti deboli. Mai il contenuto dei tuoi appunti — e non può scrivere nulla.",
      pre: "Prima di tutto, in Fluera:",
      s1: "Impostazioni → Privacy → attiva <strong>Assistente AI collegato</strong>",
      s2: "Impostazioni → Funzioni cognitive → <strong>Collega il tuo assistente</strong>",
      web: "Dai connettori (claude.ai, ChatGPT)",
      webp: "Aggiungi un connettore con questo indirizzo, poi accedi con l'account che usi su Fluera e autorizza:",
      cli: "Da terminale (Claude Code)",
      clip: "Crea una chiave nell'app e incolla il comando che ti mostra:",
      rev: "Puoi revocare in ogni momento dall'app. Revocare il consenso chiude tutte le sessioni e cancella l'estratto conservato.",
    }
    : {
      h: "Connect your assistant to Fluera",
      p: "Your AI assistant can read <strong>what you need to review and when</strong>: courses, exam dates, concepts due, weak topics. Never the content of your notes — and it cannot write anything.",
      pre: "First, in Fluera:",
      s1: "Settings → Privacy → turn on <strong>Connected AI assistant</strong>",
      s2: "Settings → Cognitive features → <strong>Connect your assistant</strong>",
      web: "From connectors (claude.ai, ChatGPT)",
      webp: "Add a connector with this address, then sign in with your Fluera account and approve:",
      cli: "From the terminal (Claude Code)",
      clip: "Create a key in the app and paste the command it shows you:",
      rev: "You can revoke at any time from the app. Revoking consent closes every session and deletes the stored digest.",
    };
  return `<!doctype html><html lang="${it ? "it" : "en"}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t.h)} — Fluera</title>
<style>body{font-family:system-ui,sans-serif;margin:0;background:#F6F7F9;color:#1B2030;line-height:1.6}
main{max-width:38rem;margin:0 auto;padding:3rem 1.25rem 4rem}
h1{font-size:1.7rem;line-height:1.2;margin:0 0 .75rem}h2{font-size:1.05rem;margin:2rem 0 .5rem}
p,li{color:#5C6475}ol{padding-left:1.2rem}li{margin-bottom:.4rem}
code{background:#EEF0F5;border-radius:5px;padding:.15em .4em;font-size:.9em;word-break:break-all}
.note{margin-top:2rem;padding-top:1rem;border-top:1px solid #DDE1E9;font-size:.9rem}
@media(prefers-color-scheme:dark){body{background:#101319;color:#E8EAF1}p,li{color:#9AA3B5}code{background:#1F2532}.note{border-color:#2A3040}}</style>
</head><body><main>
<h1>${esc(t.h)}</h1>
<p>${t.p}</p>
<h2>${esc(t.pre)}</h2>
<ol><li>${t.s1}</li><li>${t.s2}</li></ol>
<h2>${esc(t.web)}</h2>
<p>${esc(t.webp)}</p>
<p><code>${MCP_RESOURCE}</code></p>
<h2>${esc(t.cli)}</h2>
<p>${esc(t.clip)}</p>
<p><code>claude mcp add --transport http fluera-study ${MCP_RESOURCE} --header "Authorization: Bearer fmcp_…"</code></p>
<p class="note">${esc(t.rev)}</p>
</main></body></html>`;
}
