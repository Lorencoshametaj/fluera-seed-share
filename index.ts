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
//   • GET /{lingua}/appunti/[{materia}/[{corso}/]] → gli elenchi pubblici per
//       materia e corso, e /{lingua}/appunti/cerca (F2, 2026-09-24). Chi sta
//       in un elenco lo decide SOLO il database (213): qui non si ricopia.
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

export interface SeedRow {
  hash: string;
  author_code: string | null;
  title: string | null;
  description: string | null;
  discipline: string | null;
  concept_count: number | null;
  thumb_path: string | null;
  og_path: string | null;
  is_official: boolean | null;
  // ⚠️ Si legge ma NON si mostra mai: `record_seed_install` (047) è anonimo e
  // senza limiti, quindi il numero si gonfia con un ciclo di curl (S7,
  // 2026-09-24). Resta nel tipo perché get_study_seed lo restituisce.
  install_count: number | null;
  // ⚠️ Nemmeno questi si mostrano (25/09/2026): contano anche gli account
  // anonimi. Sul web il voto viene SOLO da get_web_scheda (220), che per un
  // pack non indicizzabile non restituisce righe.
  rating_sum: number | null;
  rating_count: number | null;
  // Campi che get_study_seed (186) restituisce già: servono al predicato
  // `indicizzabile` e alla pagina senza contenuto per i non-general.
  moderation_status: string | null;
  content_maturity: string | null;
  locale: string | null;
  ai_generated: boolean | null;
  // Per isAccessibleForFree del JSON-LD: oggi è 0 per costruzione (CHECK
  // della 047), ma il markup non deve continuare a dire «gratis» il giorno
  // in cui quel CHECK cade.
  price_cents?: number | null;
  superseded_by?: string | null;
  // La regola di Google calcolata dal database (seed_web_indicizzabile, 213).
  // Assente su un database prima della 213.
  web_indicizzabile?: boolean | null;
}

/// 🔎 Su Google solo ciò di cui rispondiamo noi. La regola vive in SQL
/// (seed_web_indicizzabile, 213) e arriva come `web_indicizzabile`: qui si
/// LEGGE e basta. Fino al 2026-09-24 ne esisteva una copia in TypeScript che
/// non guardava superseded_by: con la testa di una catena revocata, pagina e
/// sitemap dicevano due cose diverse. Campo assente = non indicizzabile.
export function indicizzabile(row: SeedRow): boolean {
  return row.web_indicizzabile === true;
}

/// I token robots.txt dei crawler di ADDESTRAMENTO, come li scrivono i loro
/// gestori (Google, Apple, Meta e Common Crawl verificati sulle pagine
/// ufficiali il 2026-09-24). Niente bot di ricerca né di anteprima link qui:
/// quelli (Googlebot, facebookexternalhit…) devono poter leggere /s/.
const CRAWLER_ADDESTRAMENTO = [
  "GPTBot",
  "ClaudeBot",
  "CCBot",
  "Google-Extended",
  "Applebot-Extended",
  "meta-externalagent",
] as const;

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
  // 🪪 L'impronta del build in esecuzione: lo sha256 di QUESTO file. La legge
  // mirror_in_sync.sh (B) — prima (B) guardava solo i path dell'AASA, quindi
  // un build con l'AASA giusto ma senza il noindex risultava «promosso».
  // no-store: un'impronta vecchia in cache farebbe sembrare non promosso un
  // build appena promosso.
  if (/\/\.well-known\/fluera-build\/?$/.test(path)) {
    return new Response(JSON.stringify(await improntaBuild()), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
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
        // Tre regole strette, non il prefisso «/p»: quello chiudeva anche
        // gli elenchi /pt/appunti/ e /pl/appunti/ che la sitemap dà a Google.
        "Disallow: /p$",
        "Disallow: /p?",
        "Disallow: /p/",
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
        // La ricerca negli elenchi: una pagina per ogni parola che qualcuno
        // scrive, cioè infinite pagine sottili. Gli elenchi sì, la ricerca no.
        "Disallow: /*/appunti/cerca",
        // Ordini e varianti degli elenchi sono duplicati della pagina base
        // (canonical alla base): chiusi, tranne la paginazione pura. Vince la
        // regola più lunga, quindi l'Allow sotto riapre solo «?pagina=».
        "Disallow: /*/appunti/*?",
        "Allow: /*/appunti/*?pagina=",
        // …ma non «?pagina=N&ref=…»: risponde 200 (il ref è l'attribuzione e
        // si conserva), e con un ref qualunque sarebbe uno spazio di URL senza
        // fine. Più lunga dell'Allow, quindi vince. Il server ricompone la
        // query nell'ordine ordine, pagina, ref: altre forme sono già 301.
        "Disallow: /*/appunti/*?pagina=*&ref=",
        "",
        // 🤖 Crawler che raccolgono testo per ADDESTRARE modelli: fuori da
        // tutto (F1, 2026-09-24). Il gruppo «*» sopra resta com'è: Googlebot,
        // Bingbot e i bot di RICERCA continuano a leggere /s/. Google-Extended
        // non tocca l'inclusione né il posizionamento su Google Search (lo
        // dice la documentazione di Google). È il default restrittivo: la
        // posizione definitiva andrà nei Termini, e la decide Lorenco.
        ...CRAWLER_ADDESTRAMENTO.flatMap((bot) => [`User-agent: ${bot}`, "Disallow: /", ""]),
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

  // ── /{lingua}/appunti/… → gli elenchi per materia e corso (F2) ─────────────
  // QUI, prima delle rotte a suffisso (/get, /connect, /report, /mcp…): un
  // corso chiamato «Get» ha slug «get», e /it/appunti/matematica/get/ finirebbe nel
  // redirect verso lo store.
  const appunti = path.match(RE_ROTTA_APPUNTI);
  if (appunti) return await rottaAppunti(appunti, reqUrl);

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
  if (/\/\.well-known\/oauth-protected-resource(\/mcp\.?)?\/?$/.test(path)) {
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
  // ⚠️ `\.?` — un punto finale è tollerato di proposito: chi copia l'indirizzo
  // da una frase si porta dietro il punto della punteggiatura, e senza questa
  // riga il risultato era il peggiore possibile — l'OAuth riusciva (la
  // scoperta dei metadati ripiega sulla radice) e POI la connessione moriva
  // con «l'URL non punta a un server MCP valido». Misurato dal vivo il
  // 2026-08-22: un punto ha bruciato tre tentativi.
  if (/\/mcp\.?\/?$/.test(path)) {
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
    // 🔤 L'apostrofo NON e' un carattere pericoloso qui: esce solo dentro
    // `esc()` (che lo rende `&#39;`) e dentro `encodeURIComponent`. Metterlo
    // in lista nera buttava via l'INTERO concetto per ogni titolo con un
    // apostrofo — «L'apparato di Golgi», «Teoria dell'attaccamento» — e il
    // link atterrava sulla tela muta senza dire perche'.
    const concept =
      rawConcept && rawConcept.length <= 120 && !/[\x00-\x1f<>"]/.test(rawConcept)
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
        titolo: concept ? `«${concept}» ti aspetta` : "Il tuo ripasso ti aspetta",
        corpo: concept
          ? "Questo link riapre i tuoi appunti su questo concetto, dentro Fluera."
          : "Questo link riapre un tuo quaderno dentro Fluera.",
        gia: "Ho già l'app",
        store: "Scarica Fluera",
        nota: "Il ripasso che conta si fa qui: a libro chiuso, con la tua calligrafia.",
      }
      : {
        lang: "en",
        titolo: concept ? `“${concept}” is waiting` : "Your review is waiting",
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
    return html(500, paginaStato("Errore", "Server non configurato."));
  }
  const esito = await fetchTemplate(hash);
  // ⚠️ Guasto ≠ assente. Fino al 2026-09-24 un 5xx o una rete muta
  // rispondevano 410 «rimosso», che per Google è DEFINITIVO: un guasto di un
  // minuto poteva deindicizzare il catalogo. Il 503 dice «riprova».
  if (esito.tipo === "guasto") return rispostaGuasto(`get_study_seed per ${hash}: ${esito.motivo}`);
  if (esito.tipo === "assente") return html(410, paginaStato("Non più disponibile", "Questo template è stato rimosso o non è più pubblico."));
  const row = esito.row;

  // C1: attribution is an OPTIONAL "?ref={referralCode}" query param. Read it
  // here and forward it into every store/app-open URL so an install attributes
  // back to the sharer. Sanitize (alnum + a few safe chars) to keep referrer
  // payloads clean and avoid open-redirect/HTML-injection surprises.
  const ref = sanitizeRef(reqUrl.searchParams.get("ref"));

  // 🔗 UN indirizzo per contenuto: get_study_seed segue la catena delle
  // versioni (186), quindi un link vecchio risolve alla testa. Senza il 301
  // la stessa pagina viveva sotto N hash. Location RELATIVA per non perdere
  // il prefisso di `functions serve` in locale; `/s/{hash}` resta a DUE
  // segmenti (il gestore dei link dell'app accetta solo quella forma). La
  // scadenza non è estetica: un 301 senza Cache-Control resta nel browser per
  // sempre, e la testa della catena può cambiare.
  // ⚠️ Il prefisso si tiene SOLO se è quello di `functions serve` (segmenti
  // semplici che finiscono in /seed-share). Il 2026-09-24 il prefisso grezzo
  // faceva di `//evil.example/s/{hash vecchio}` (o `/\evil.example/…`) un 301
  // protocol-relative verso un host qualsiasi, in cache pubblica per 5 minuti.
  if (hash !== row.hash) {
    const prefisso = path.slice(0, m.index ?? 0);
    const base = /^(?:\/[A-Za-z0-9_-]+)*\/seed-share$/.test(prefisso) ? prefisso : "";
    return new Response(null, {
      status: 301,
      headers: {
        Location: `${base}/s/${row.hash}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`,
        "Cache-Control": "public, max-age=300",
      },
    });
  }

  // 🔞 Non-general: la pagina esiste (un link deve risolvere, 070) ma non
  // dice niente del contenuto — né nel corpo né nell'anteprima di una chat.
  if (row.content_maturity !== "general") {
    return paginaSeme(renderPaginaRiservata(row, ref), false);
  }

  // 📱 Niente user-agent qui: la pagina è la STESSA per ogni telefono (S6).
  // Link interni e scheda (voto, efficacia, argomenti) solo dove Google
  // entra: su una noindex get_web_scheda darebbe comunque 0 righe.
  // Senza miniatura la pagina mostra l'iniziale del titolo come l'app
  // (TD:1945-1965), non più la card og: i pack curati pubblicati senza
  // `--thumb` si sistemano alla pubblicazione, non qui.
  const [vicini, scheda] = indicizzabile(row)
    ? await Promise.all([fetchVicini(row), fetchScheda(row.hash)])
    : [NESSUN_VICINO, null];
  return paginaSeme(renderPage(row, ref, vicini, scheda), indicizzabile(row));
};

if (import.meta.main) Deno.serve(servi);

/// La risposta di una pagina /s/ o di un elenco: `html()` più il noindex anche
/// come header, così vale pure per chi non legge l'HTML. Si passa da qui e da
/// nessun altro posto, perché il predicato non si perda in un ramo nuovo.
function paginaSeme(body: string, siIndicizza: boolean): Response {
  const r = html(200, body);
  if (!siIndicizza) r.headers.set("X-Robots-Tag", "noindex");
  return r;
}

/// Un guasto del database: 503 che dice «riprova», mai 404/410 (per Google
/// sono una rimozione) e mai in cache.
function rispostaGuasto(motivo: string): Response {
  console.error(`guasto: ${motivo}`);
  // «Riprova» = href vuoto, cioè lo stesso indirizzo.
  const r = html(503, paginaStato("Catalogo non raggiungibile", "Non riusciamo a caricare il catalogo in questo momento. Riprova tra poco.", {
    icona: "cloud_off",
    azione: { testo: "Riprova", href: "" },
  }));
  r.headers.set("Retry-After", "120");
  r.headers.set("Cache-Control", "no-store");
  r.headers.set("X-Robots-Tag", "noindex");
  return r;
}

// ── Supabase ────────────────────────────────────────────────────────────────

type EsitoSeme =
  | { tipo: "trovato"; row: SeedRow }
  | { tipo: "assente" }
  | { tipo: "guasto"; motivo: string };

/// «Assente» SOLO quando il database ha risposto bene con zero righe. Ogni
/// altra cosa — rete, 5xx, JSON che non è un elenco — è un guasto, e il
/// chiamante non deve poterlo scambiare per una rimozione.
async function fetchTemplate(hash: string): Promise<EsitoSeme> {
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
    if (!resp.ok) return { tipo: "guasto", motivo: `HTTP ${resp.status}` };
    const rows = (await resp.json()) as unknown;
    if (!Array.isArray(rows)) return { tipo: "guasto", motivo: "risposta non è un elenco" };
    if (rows.length === 0) return { tipo: "assente" };
    const row = rows[0] as SeedRow;
    if (!row || typeof row.hash !== "string") {
      return { tipo: "guasto", motivo: "riga senza hash" };
    }
    return { tipo: "trovato", row };
  } catch (e) {
    return { tipo: "guasto", motivo: String(e) };
  }
}

// ── Gli elenchi del web (F2, 2026-09-24) ────────────────────────────────────
// Le tre letture della 213 restituiscono SOLO semi indicizzabili (list_web_seeds)
// e SOLO elenchi sopra soglia (list_web_hubs: almeno 3 semi, e tutti ufficiali
// oppure almeno 2 account — un elenco di un solo autore sarebbe il profilo di
// una persona). Qui la soglia non si ricalcola: un elenco esiste se e solo se
// list_web_hubs lo restituisce.
const HASH_INTERO_RE = new RegExp(`^${HASH_RE.source}$`);
const SHARE = "https://share.fluera.dev";
const CORRELATI_MAX = 6;
/// 60 = multiplo di 2, 3, 4, 5 e 6: con ogni numero di colonne l'ultima riga
/// della griglia resta piena.
const SEMI_PER_PAGINA = 60;
/// Il tetto di p_offset della 213: oltre, l'RPC ripeterebbe l'ultima pagina.
const OFFSET_MAX = 10000;
/// Quanti semi di una lingua la ricerca legge al massimo (5 chiamate da 100).
const CERCA_MAX = 500;
const RE_SLUG_MATERIA = /^[a-z]{2,20}$/;
const RE_SLUG_CORSO = /^(?=.{1,60}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
/// /{lingua}/appunti + il resto. Il prefisso di `functions serve` (in locale)
/// passa solo a segmenti semplici, come per il 301 di /s/.
const RE_ROTTA_APPUNTI = /^((?:\/[A-Za-z0-9_-]+)*\/seed-share)?\/([a-z]{2,3})\/appunti(\/.*)?$/;

type SemeWeb = {
  hash: string;
  title: string | null;
  description: string | null;
  discipline: string | null;
  materia_slug: string | null;
  course: string | null;
  corso_slug: string | null;
  locale: string | null;
  thumb_path: string | null;
  og_path: string | null;
  updated_at: string | null;
  totale: number | string | null;
  // I campi della scheda (218): assenti su un database prima della 218, e
  // già passati dalle soglie del server (sotto soglia arrivano NULL).
  category?: string | null;
  tags?: string[] | null;
  concept_count?: number | null;
  is_official?: boolean | null;
  is_featured?: boolean | null;
  ai_generated?: boolean | null;
  voto_medio?: number | string | null;
  voti?: number | null;
  efficacia_pct?: number | null;
  efficacia_studenti?: number | null;
  created_at?: string | null;
};
/// Una riga di list_web_vetrine (218): la scheda più la vetrina e il posto.
type VetrinaWeb = SemeWeb & { vetrina: string; posto: number };
/// Una riga di get_web_scheda (218): 0 righe se il pack non è indicizzabile.
type SchedaWeb = Pick<
  SemeWeb,
  | "hash" | "category" | "tags" | "concept_count" | "is_official" | "is_featured" | "ai_generated"
  | "voto_medio" | "voti" | "efficacia_pct" | "efficacia_studenti" | "created_at" | "updated_at"
>;
type HubWeb = {
  materia_slug: string;
  materia: string | null;
  corso_slug: string | null;
  corso: string | null;
  n: number | string | null;
  lastmod: string | null;
};

/// Le materie di seed_web_materia_slug (213) con l'etichetta italiana e
/// l'introduzione della pagina materia. Solo parole: quali elenchi esistono
/// lo dice il database. Chiavi ed etichette sono tenute uguali alla 213 da
/// seo_contract (test 18).
export const MATERIE: Record<string, { it: string; intro: string }> = {
  math: {
    it: "Matematica",
    intro:
      "La matematica si capisce con la penna in mano. Leggere un ragionamento già scritto dà l'impressione di averlo capito; rifarlo da soli, un passaggio alla volta, dice se è vero. Gli appunti di questa pagina servono a questo. Si aprono in Fluera su un canvas senza bordi, e accanto a ogni passaggio c'è spazio per riscriverlo con la tua calligrafia, per disegnare un grafico storto ma tuo, per segnare il punto in cui ti sei bloccato. Non sono schede da imparare a memoria: sono un punto di partenza da riempire. Quando torni a ripassare, prova prima a ricostruire il ragionamento a libro chiuso, poi confrontalo con quello che avevi scritto.",
  },
  physics: {
    it: "Fisica",
    intro:
      "In fisica le formule arrivano alla fine. Prima c'è una situazione da immaginare: un oggetto che cade, una corda che vibra, l'acqua che scorre in un tubo. Chi studia bene la disegna, ci mette le frecce, si chiede che cosa succederebbe cambiando una cosa sola. Gli appunti di questa pagina si aprono in Fluera su un canvas dove puoi fare proprio questo: schizzare la scena a mano accanto alla spiegazione, scrivere con parole tue perché il risultato ha senso, lasciare a margine una domanda per la volta dopo. Quando ripassi, prova a rifare il disegno senza guardare. Quello che riesci a ridisegnare da solo è quello che hai capito.",
  },
  chemistry: {
    it: "Chimica",
    intro:
      "La chimica è piena di cose che non si vedono: atomi, legami, sostanze che si separano e si ricompongono. Per questo aiuta così tanto disegnarle. Uno schema fatto a mano, anche impreciso, ti costringe a decidere dove va ogni pezzo e perché. Gli appunti di questa pagina si aprono in Fluera su un canvas libero: puoi ricopiare una reazione con la tua scrittura, colorare quello che cambia fra prima e dopo, aggiungere un esempio che ti viene in mente. Un nome si dimentica in fretta; il disegno che ci hai fatto sopra resta più a lungo. Al ripasso, prova a ridisegnare lo schema senza guardarlo, poi confronta.",
  },
  biology: {
    it: "Biologia",
    intro:
      "La biologia chiede di ricordare i nomi delle parti, ma soprattutto di capire come lavorano insieme. Una cellula, un organo, il ciclo di vita di una pianta diventano chiari quando li disegni e colleghi i pezzi con le frecce, non quando rileggi un elenco. Gli appunti di questa pagina si aprono in Fluera su un canvas dove c'è spazio per farlo: puoi rifare uno schema a mano, scrivere accanto a ogni parte a che cosa serve con parole tue, aggiungere collegamenti che nel testo non c'erano. Quando torni a studiare, copri le etichette e prova a rimetterle da solo. Quello che non ricordi ti dice dove tornare.",
  },
  medicine: {
    it: "Medicina",
    intro:
      "Studiare medicina vuol dire ricordare molto e, soprattutto, collegare: un sintomo a ciò che lo provoca, una causa a una cura. Rileggere e sottolineare dà la sensazione di sapere, ma il collegamento si costruisce solo quando lo scrivi tu. Gli appunti di questa pagina si aprono in Fluera su un canvas libero, dove puoi fare mappe a mano, disegnare un organo e annotarlo, spiegare un passaggio con le tue parole come se dovessi raccontarlo a un compagno. Sono materiale per studiare, non indicazioni sulla salute di nessuno. Al ripasso, prova a ricostruire il percorso a libro chiuso e guarda dove si interrompe: è lì che vale la pena tornare.",
  },
  law: {
    it: "Diritto",
    intro:
      "Nel diritto le parole contano una per una, e proprio per questo imparare a memoria non basta. Serve capire perché una regola esiste, a quali casi si applica e dove si ferma. Scriverlo a mano, con parole tue, è il modo più onesto per scoprire se l'hai capito davvero. Gli appunti di questa pagina si aprono in Fluera su un canvas dove puoi riassumere una regola accanto al testo, disegnare lo schema di chi fa che cosa, annotare un esempio concreto che ti aiuta a ricordarla. Sono materiale di studio, non consulenza. Al ripasso, prova a spiegare la regola a libro chiuso, poi confronta con quello che avevi scritto.",
  },
  economics: {
    it: "Economia",
    intro:
      "L'economia parla di scelte: che cosa fanno le persone, le imprese e gli stati quando le risorse non bastano per tutto. Molte idee si capiscono meglio con un disegno: curve che si incontrano, una freccia che mostra chi paga e chi riceve. Gli appunti di questa pagina si aprono in Fluera su un canvas libero, dove puoi ridisegnare un grafico a mano, scrivere accanto che cosa succede se cambia una cosa sola, aggiungere un esempio preso dalla vita di tutti i giorni. Quando ripassi, prova a rifare il ragionamento senza guardare: se sai spiegarlo con parole semplici, l'hai fatto tuo.",
  },
  philosophy: {
    it: "Filosofia",
    intro:
      "In filosofia non si studia un elenco di risposte, ma il modo in cui qualcuno ha provato a ragionare su una domanda. Per seguirlo bisogna rallentare: riscrivere un argomento con parole tue, chiederti se sei d'accordo, cercare il punto in cui potrebbe non reggere. Gli appunti di questa pagina si aprono in Fluera su un canvas dove puoi farlo a mano, accanto al testo: mettere in fila i passaggi di un ragionamento, collegare pensatori diversi con una freccia, scrivere a margine un'obiezione tua. Quando ripassi, prova a raccontare l'idea a libro chiuso, come se la spiegassi a qualcuno che non l'ha mai sentita.",
  },
  history: {
    it: "Storia",
    intro:
      "La storia si ricorda meglio quando diventa un racconto e non una lista di date. Chi ha deciso che cosa, perché, e che cosa è cambiato dopo: sono queste le domande che tengono insieme i fatti. Gli appunti di questa pagina si aprono in Fluera su un canvas libero, dove puoi tracciare a mano una linea del tempo, collegare una causa alle sue conseguenze con una freccia, disegnare una cartina approssimativa per capire dove succedono le cose. Scrivere il racconto con le tue parole è già un modo di studiarlo. Al ripasso, prova a rimettere in ordine gli eventi senza guardare, poi controlla.",
  },
  language: {
    it: "Lingue",
    intro:
      "Una lingua si impara usandola, e scrivere a mano è un modo di usarla. Ricopiare una frase, cambiarla, sbagliare e correggerti lascia una traccia che la sola lettura non lascia. Gli appunti di questa pagina si aprono in Fluera su un canvas libero, dove puoi scrivere parole ed esempi con la tua calligrafia, annotare accanto una frase tua che le usa, disegnare un piccolo schema quando una regola ti confonde. Per le lingue con un altro alfabeto, tracciare i caratteri con la penna aiuta a riconoscerli. Al ripasso, copri la traduzione e prova a ricordare prima di guardare.",
  },
  cs: {
    it: "Informatica",
    intro:
      "In informatica capire un'idea viene prima di scrivere il codice. Come si muovono i dati, in che ordine avvengono i passaggi, che cosa succede quando qualcosa va storto: spesso lo vedi davvero solo quando lo disegni. Gli appunti di questa pagina si aprono in Fluera su un canvas libero, dove puoi schizzare a mano uno schema a blocchi, seguire con le frecce il percorso di un'informazione, scrivere accanto a un esempio che cosa fa ogni pezzo, con parole tue. Quando ripassi, prova a rifare lo schema senza guardare e a spiegarlo ad alta voce. Il punto in cui ti fermi è quello da ristudiare.",
  },
};
const ALIAS_MATERIA: Record<string, string> = {
  mathematics: "math",
  computer_science: "cs",
  languages: "language",
};

/// Copie di seed_web_materia_slug e seed_web_lingua (213), usate SOLO per
/// scegliere quali righe chiedere dalla pagina /s/. Se divergono dal database
/// si perde un link, mai se ne inventa uno: il link a un elenco esce solo se
/// list_web_seeds mette il seme in quella materia.
export function materiaDi(discipline: string | null): string | null {
  const k = (discipline ?? "").trim().toLowerCase();
  if (Object.hasOwn(MATERIE, k)) return k;
  return Object.hasOwn(ALIAS_MATERIA, k) ? ALIAS_MATERIA[k] : null;
}
function linguaDi(locale: string | null): string | null {
  const m = (locale ?? "").trim().toLowerCase().match(/^([a-z]{2,3})(?:[-_]|$)/);
  return m ? m[1] : null;
}

/// La materia di un seme col nome della pagina (italiano): «Matematica», non
/// «math». Una disciplina fuori elenco resta com'è.
export function nomeDisciplina(discipline: string | null): string | null {
  const t = (discipline ?? "").trim();
  if (!t) return null;
  const k = materiaDi(t);
  return k ? MATERIE[k].it : t;
}

/// Lo slug della materia negli INDIRIZZI, per lingua: su Google in italiano
/// la parola cercata dentro l'indirizzo conta. Il database resta sulle chiavi
/// canoniche della 213 (neutre e stabili); qui solo la traduzione verso gli
/// indirizzi. Una lingua senza voce usa la chiave.
const SLUG_MATERIA: Record<string, Record<string, string>> = {
  it: {
    math: "matematica",
    physics: "fisica",
    chemistry: "chimica",
    biology: "biologia",
    medicine: "medicina",
    law: "diritto",
    economics: "economia",
    philosophy: "filosofia",
    history: "storia",
    language: "lingue",
    cs: "informatica",
  },
};

export function slugMateria(lingua: string, chiave: string): string {
  const m = Object.hasOwn(SLUG_MATERIA, lingua) ? SLUG_MATERIA[lingua] : null;
  return m && Object.hasOwn(m, chiave) ? m[chiave] : chiave;
}

/// Dallo slug di un indirizzo alla chiave della 213. `sposta`: l'indirizzo usa
/// la chiave dove la lingua ha lo slug localizzato, e va rediretto. Uno slug
/// sconosciuto passa com'è: il database risponde che l'elenco non c'è.
export function chiaveMateria(lingua: string, slug: string): { chiave: string; sposta: boolean } {
  const m = Object.hasOwn(SLUG_MATERIA, lingua) ? SLUG_MATERIA[lingua] : {};
  const k = Object.keys(m).find((c) => m[c] === slug);
  return k ? { chiave: k, sposta: false } : { chiave: slug, sposta: slugMateria(lingua, slug) !== slug };
}

/// L'UNICO punto che compone l'indirizzo di un elenco: pagine, JSON-LD, link
/// della /s/, redirect e sitemap passano tutti da qui, con la CHIAVE.
function percorsoElenco(lingua: string, materia?: string | null, corso?: string | null): string {
  const s = materia ? slugMateria(lingua, materia) : null;
  return `/${lingua}/appunti/${s ? `${s}/` : ""}${s && corso ? `${corso}/` : ""}`;
}

export function urlElenco(lingua: string, materia?: string | null, corso?: string | null): string {
  return `${SHARE}${percorsoElenco(lingua, materia, corso)}`;
}

type EsitoRpc<T> = { ok: true; rows: T[] } | { ok: false; motivo: string };

/// Una lettura del web con la chiave pubblica. Rete, 5xx, tempo scaduto o
/// una risposta che non è un elenco sono un GUASTO: il chiamante sceglie fra
/// 503 (pagina) e «niente link» (best-effort), mai «non esiste».
async function rpcWeb<T>(nome: string, corpo: Record<string, unknown>, ms = 4000): Promise<EsitoRpc<T>> {
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${nome}`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(ms),
    });
    if (!resp.ok) return { ok: false, motivo: `${nome}: HTTP ${resp.status}` };
    const rows = (await resp.json()) as unknown;
    if (!Array.isArray(rows)) return { ok: false, motivo: `${nome}: risposta non è un elenco` };
    return { ok: true, rows: rows as T[] };
  } catch (e) {
    return { ok: false, motivo: `${nome}: ${e}` };
  }
}

const semiValidi = (rows: SemeWeb[]) =>
  rows.filter((r) => r && typeof r.hash === "string" && HASH_INTERO_RE.test(r.hash));
const hubValidi = (rows: HubWeb[]) =>
  rows.filter((h) =>
    h && typeof h.materia_slug === "string" && RE_SLUG_MATERIA.test(h.materia_slug) &&
    (h.corso_slug === null || (typeof h.corso_slug === "string" && RE_SLUG_CORSO.test(h.corso_slug)))
  );
const titoloSeme = (t: string | null) => (t ?? "").trim() || "Template di studio";

// ── Link interni di una /s/: «Ti potrebbero interessare», briciole, elenchi ──
type Vicini = {
  correlati: SemeWeb[];
  tutti: { href: string; nome: string } | null;
  /// Solo verso elenchi che esistono E contengono il seme; vuote sulle noindex.
  briciole: Array<{ nome: string; url: string }>;
  /// «Tutto il catalogo →»: l'indice della lingua, se ha elenchi.
  catalogo: string;
  /// Il corso del seme come lo scrive list_web_seeds (titolo e JSON-LD).
  corso: string | null;
  /// L'elenco della materia, se contiene il seme (la casella «Materia»).
  hubMateria: string | null;
};
const NESSUN_VICINO: Vicini = { correlati: [], tutti: null, briciole: [], catalogo: urlElenco("it"), corso: null, hubMateria: null };

/// Altri semi della stessa materia e lingua (list_web_seeds: indicizzabili per
/// costruzione, mai il seme stesso), prima quelli dello stesso corso, e, se il
/// seme sta in un elenco sopra soglia, il link all'elenco: quello del corso se
/// c'è, se no quello della materia. Fino al 2026-09-24 i link venivano da
/// browse_study_seeds filtrato con la copia TypeScript della regola.
/// Best-effort: un guasto toglie i link, mai la pagina; per questo il tetto di
/// tempo.
async function fetchVicini(row: SeedRow): Promise<Vicini> {
  const materia = materiaDi(row.discipline);
  const appunti = { nome: "Appunti", url: urlElenco("it") };
  if (!materia) return { ...NESSUN_VICINO, briciole: [appunti] };
  const lingua = linguaDi(row.locale);
  const [s, h] = await Promise.all([
    rpcWeb<SemeWeb>("list_web_seeds", { p_lingua: lingua, p_materia_slug: materia, p_corso_slug: null, p_limit: 100, p_offset: 0 }, 1500),
    lingua ? rpcWeb<HubWeb>("list_web_hubs", { p_lingua: lingua }, 1500) : Promise.resolve<EsitoRpc<HubWeb>>({ ok: true, rows: [] }),
  ]);
  if (!s.ok) console.error(`link interni di ${row.hash}: ${s.motivo}`);
  if (!h.ok) console.error(`link interni di ${row.hash}: ${h.motivo}`);
  const semi = s.ok ? semiValidi(s.rows) : [];
  const hubs = h.ok ? hubValidi(h.rows) : [];
  const io = semi.find((r) => r.hash === row.hash);
  const hubCorso = io?.corso_slug
    ? hubs.find((x) => x.materia_slug === io.materia_slug && x.corso_slug === io.corso_slug)
    : undefined;
  const hubM = io ? hubs.find((x) => x.materia_slug === io.materia_slug && x.corso_slug === null) : undefined;
  const hub = hubCorso ?? hubM;
  // L'indice italiano esiste sempre; quello di un'altra lingua col suo primo elenco.
  const indice = lingua && (lingua === "it" || hubs.length > 0) ? urlElenco(lingua) : urlElenco("it");
  const altri = semi.filter((r) => r.hash !== row.hash);
  const stessoCorso = (r: SemeWeb) => !!io?.corso_slug && r.corso_slug === io.corso_slug;
  const nomeM = (hubM?.materia ?? "").trim() || MATERIE[materia].it;
  const nomeC = (hubCorso?.corso ?? "").trim() || (io?.course ?? "").trim();
  return {
    correlati: [...altri.filter(stessoCorso), ...altri.filter((r) => !stessoCorso(r))].slice(0, CORRELATI_MAX),
    tutti: hub && lingua
      ? {
        href: urlElenco(lingua, hub.materia_slug, hub.corso_slug),
        nome: (hubCorso ? hub.corso : hub.materia) ?? MATERIE[materia].it,
      }
      : null,
    briciole: [
      { nome: "Appunti", url: indice },
      ...(hubM && lingua ? [{ nome: nomeM, url: urlElenco(lingua, hubM.materia_slug) }] : []),
      ...(hubCorso && lingua && nomeC ? [{ nome: nomeC, url: urlElenco(lingua, hubCorso.materia_slug, hubCorso.corso_slug) }] : []),
    ],
    catalogo: indice,
    corso: (io?.course ?? "").trim() || null,
    hubMateria: hubM && lingua ? urlElenco(lingua, hubM.materia_slug) : null,
  };
}

/// I campi della scheda di UN pack indicizzabile (get_web_scheda, 218).
/// Best-effort come i link: 0 righe o un guasto tolgono voto, efficacia,
/// categoria ed etichette, mai la pagina.
async function fetchScheda(hash: string): Promise<SchedaWeb | null> {
  const e = await rpcWeb<SchedaWeb>("get_web_scheda", { p_hash: hash }, 1500);
  if (!e.ok) {
    console.error(`scheda di ${hash}: ${e.motivo}`);
    return null;
  }
  const r = e.rows[0];
  return r && r.hash === hash ? r : null;
}

// ── Le rotte /{lingua}/appunti/… ────────────────────────────────────────────
function nonTrovata(): Response {
  const r = html(404, paginaStato("Elenco non trovato", "Questo elenco non c'è, o non c'è ancora.", {
    icona: "eco",
    azione: { testo: "Tutti i template", href: urlElenco("it") },
  }));
  r.headers.set("X-Robots-Tag", "noindex");
  return r;
}

/// L'ordine della griglia, come il menu «Ordina» dell'app meno «Più popolari»
/// (coincide con «Consigliati») e «A–Z» (esclusa anche lì). «Consigliati» è
/// la pagina base, senza parametro.
type Ordine = "consigliati" | "efficaci" | "votati" | "recenti";
const ORDINI: ReadonlyArray<[Ordine, string, string | null]> = [
  ["consigliati", "Consigliati", null],
  ["efficaci", "Più efficaci", "Ordinato per guadagni di memoria misurati"],
  ["votati", "Più votati", null],
  ["recenti", "Più recenti", null],
];
const ordineDi = (s: string | null): Ordine => ORDINI.find(([o]) => o === s)?.[0] ?? "consigliati";

/// Due query con gli stessi parametri NELLO STESSO ORDINE, decodificati: «%20»
/// e «+» sono la stessa cosa, «?pagina=2&ordine=x» e «?ordine=x&pagina=2» no.
function queryDiversa(a: URLSearchParams, b: URLSearchParams): boolean {
  return JSON.stringify([...a]) !== JSON.stringify([...b]);
}

function sposta301(location: string): Response {
  return new Response(null, {
    status: 301,
    headers: { Location: location, "Cache-Control": "public, max-age=300" },
  });
}

async function rottaAppunti(m: RegExpMatchArray, reqUrl: URL): Promise<Response> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return html(500, paginaStato("Errore", "Server non configurato."));
  }
  const base = m[1] ?? "";
  const lingua = m[2];
  const coda = (m[3] ?? "").match(/^(?:\/([a-z]{2,20})(?:\/([a-z0-9-]{1,60}))?)?(\/?)$/);
  if (!coda) return nonTrovata();
  const [, slug, corso, barra] = coda;
  // UN indirizzo per pagina: il server ricompone la query nel suo ordine
  // (elenchi: ordine, pagina, ref; ricerca: q, materia, ordine, ref) e toglie il
  // resto (utm_*, fbclid, ordine=consigliati, pagina=1). Il ref resta: è
  // l'attribuzione di chi ha condiviso il link.
  const par = reqUrl.searchParams;
  const ref = sanitizeRef(par.get("ref"));
  const giusti = new URLSearchParams();
  if (slug === "cerca") {
    if (corso) return nonTrovata();
    const q = par.get("q");
    const mRaw = par.get("materia");
    const materia = mRaw !== null && RE_SLUG_MATERIA.test(mRaw) ? chiaveMateria(lingua, mRaw).chiave : null;
    const ordineC = ordineDi(par.get("ordine"));
    if (q !== null) giusti.set("q", q);
    if (materia) giusti.set("materia", slugMateria(lingua, materia));
    if (ordineC !== "consigliati") giusti.set("ordine", ordineC);
    if (ref) giusti.set("ref", ref);
    if (queryDiversa(par, giusti)) {
      return sposta301(`${base}${percorsoElenco(lingua)}cerca${giusti.size ? `?${giusti}` : ""}`);
    }
    return await paginaCerca(lingua, q, materia, ordineC);
  }
  if (corso && !RE_SLUG_CORSO.test(corso)) return nonTrovata();
  const pRaw = par.get("pagina");
  if (pRaw !== null && !/^[1-9][0-9]{0,3}$/.test(pRaw)) return nonTrovata();
  const pagina = pRaw === null ? 1 : Number(pRaw);
  const ordine = ordineDi(par.get("ordine"));
  const { chiave: materia, sposta } = slug ? chiaveMateria(lingua, slug) : { chiave: null, sposta: false };
  if (ordine !== "consigliati") giusti.set("ordine", ordine);
  if (pagina > 1) giusti.set("pagina", String(pagina));
  if (ref) giusti.set("ref", ref);
  // Con la barra finale e con lo slug della lingua (/it/appunti/math/ →
  // /it/appunti/matematica/). Location relativa come il 301 di /s/.
  if (!barra || sposta || queryDiversa(par, giusti)) {
    return sposta301(`${base}${percorsoElenco(lingua, materia, corso)}${giusti.size ? `?${giusti}` : ""}`);
  }
  if (!materia) return await paginaIndice(lingua, pagina, ordine);
  return await paginaElenco(lingua, materia, corso ?? null, pagina, ordine);
}

/// Il nome di una materia nella lingua dell'elenco (list_web_hubs), con
/// l'italiano come ripiego.
function nomeMateria(hubs: HubWeb[], slug: string): string {
  const h = hubs.find((x) => x.materia_slug === slug && x.corso_slug === null) ??
    hubs.find((x) => x.materia_slug === slug);
  return (h?.materia ?? "").trim() || MATERIE[slug]?.it || slug;
}

/// ` lang="…"` sui nomi che il database dà nella lingua dell'elenco.
const langElenco = (lingua: string) => (lingua === "it" ? "" : ` lang="${esc(lingua)}"`);

// ── Il catalogo come l'app (catalogo 218, 2026-09-24) ───────────────────────
// Le schede, le strisce e i filtri copiano marketplace_widgets.dart (MW) e
// marketplace_screen.dart (MS): stessi elementi, stesso ordine, stesse
// misure. Via le azioni di scrittura (Installa, Segnala, voto) e i numeri che
// il web non mostra (installazioni, autori). Nessuna soglia si ricalcola qui:
// voto, efficacia e vetrine arrivano già filtrati dalla 218, e un NULL vuol
// dire «non si mostra».

/// Le glifi Material Rounded dell'app (MaterialIcons-Regular.otf, estratte
/// con fontTools), in una griglia 24×24. Ogni pagina inlinea solo le sue.
const ICONE: Record<string, string> = {
  arrow:
    "M5.02 12.98H16.17L11.3 17.86C10.92 18.28 10.92 18.89 11.3 19.31C11.67 19.69 12.33 19.69 12.7 19.31L19.31 12.7C19.69 12.33 19.69 11.67 19.31 11.3L12.7 4.69C12.33 4.31 11.67 4.31 11.3 4.69C10.92 5.11 10.92 5.72 11.3 6.09L16.17 11.02H5.02C4.45 11.02 3.98 11.44 3.98 12C3.98 12.56 4.45 12.98 5.02 12.98Z",
  auto_awesome:
    "M19.45 8.02 20.25 6.23 21.98 5.44C22.41 5.3 22.41 4.73 21.98 4.55L20.25 3.75L19.45 2.02C19.27 1.59 18.75 1.59 18.56 2.02L17.77 3.75L15.98 4.55C15.61 4.73 15.61 5.25 15.98 5.44L17.77 6.23L18.56 8.02C18.7 8.39 19.27 8.39 19.45 8.02ZM11.48 9.52 9.89 6C9.56 5.2 8.44 5.2 8.11 6L6.52 9.52L3 11.11C2.2 11.44 2.2 12.56 3 12.89L6.52 14.48L8.11 18C8.44 18.8 9.56 18.8 9.89 18L11.48 14.48L15 12.89C15.8 12.56 15.8 11.44 15 11.11L11.48 9.52ZM18.56 15.98 17.77 17.77 15.98 18.56C15.61 18.7 15.61 19.27 15.98 19.45L17.77 20.25L18.56 21.98C18.7 22.41 19.27 22.41 19.45 21.98L20.25 20.25L21.98 19.45C22.41 19.27 22.41 18.75 21.98 18.56L20.25 17.77L19.45 15.98C19.27 15.61 18.7 15.61 18.56 15.98Z",
  auto_stories:
    "M18.14 1.36 14.16 5.34C14.06 5.44 14.02 5.58 14.02 5.72V13.88C14.02 14.3 14.53 14.53 14.81 14.25L18.84 10.64C18.94 10.55 18.98 10.41 18.98 10.27V1.69C18.98 1.27 18.47 1.03 18.14 1.36ZM22.45 5.2C21.98 4.97 21.52 4.78 21 4.59V16.64C19.88 16.22 18.7 15.98 17.48 15.98C15.61 15.98 13.73 16.55 12 17.58V5.48C10.36 4.55 8.53 3.98 6.52 3.98C4.69 3.98 3 4.45 1.55 5.2C1.22 5.34 0.98 5.72 0.98 6.09V18.14C0.98 18.94 1.83 19.41 2.48 19.03C3.7 18.42 5.06 18 6.52 18C8.58 18 10.5 18.8 12 20.02C13.5 18.8 15.42 18 17.48 18C18.94 18 20.3 18.42 21.52 19.03C22.17 19.41 23.02 18.94 23.02 18.19V6.09C23.02 5.72 22.78 5.34 22.45 5.2Z",
  chevron:
    "M9.28 6.7C8.91 7.08 8.91 7.73 9.28 8.11L13.17 12L9.28 15.89C8.91 16.27 8.91 16.92 9.28 17.3C9.7 17.67 10.31 17.67 10.69 17.3L15.28 12.7C15.7 12.33 15.7 11.67 15.28 11.3L10.69 6.7C10.31 6.33 9.7 6.33 9.28 6.7Z",
  chevron_l:
    "M14.72 6.7C14.3 6.33 13.69 6.33 13.31 6.7L8.72 11.3C8.3 11.67 8.3 12.33 8.72 12.7L13.31 17.3C13.69 17.67 14.3 17.67 14.72 17.3C15.09 16.92 15.09 16.27 14.72 15.89L10.83 12L14.72 8.11C15.09 7.73 15.09 7.08 14.72 6.7Z",
  cloud_off:
    "M24 15C24 12.38 21.94 10.22 19.36 10.03C18.66 6.61 15.66 3.98 12 3.98C10.69 3.98 9.42 4.36 8.34 4.97L9.84 6.47C10.5 6.19 11.25 6 12 6C15.05 6 17.48 8.44 17.48 11.48V12H18.98C20.67 12 21.98 13.36 21.98 15C21.98 15.98 21.52 16.83 20.81 17.39L22.22 18.8C23.3 17.91 24 16.55 24 15ZM3.7 4.55C3.33 4.97 3.33 5.58 3.7 5.95L5.77 8.02H5.34C2.06 8.39 -0.42 11.39 0.05 14.81C0.47 17.86 3.19 20.02 6.23 20.02H17.72L19.03 21.28C19.41 21.7 20.06 21.7 20.44 21.28C20.81 20.91 20.81 20.25 20.44 19.88L5.11 4.55C4.73 4.17 4.08 4.17 3.7 4.55ZM6 18C3.8 18 2.02 16.22 2.02 14.02C2.02 11.81 3.8 9.98 6 9.98H7.73L15.75 18H6Z",
  code:
    "M8.72 15.89 4.78 12 8.72 8.11C9.09 7.69 9.09 7.08 8.72 6.7C8.3 6.33 7.69 6.33 7.31 6.7L2.72 11.3C2.3 11.67 2.3 12.33 2.72 12.7L7.31 17.3C7.69 17.67 8.3 17.67 8.72 17.3C9.09 16.92 9.09 16.31 8.72 15.89ZM15.28 15.89 19.22 12 15.28 8.11C14.91 7.69 14.91 7.08 15.28 6.7C15.7 6.33 16.31 6.33 16.69 6.7L21.28 11.3C21.7 11.67 21.7 12.33 21.28 12.7L16.69 17.3C16.31 17.67 15.7 17.67 15.28 17.3C14.91 16.92 14.91 16.31 15.28 15.89Z",
  draw:
    "M18.84 10.41 19.92 9.33C20.67 8.53 20.67 7.27 19.92 6.52L18.52 5.11C17.72 4.31 16.45 4.31 15.66 5.11L14.62 6.14L18.84 10.41ZM13.17 7.55 4.12 16.59C4.03 16.69 3.98 16.83 3.98 16.97V20.48C3.98 20.77 4.22 21 4.5 21H8.06C8.16 21 8.3 20.95 8.39 20.86L17.44 11.81L13.17 7.55ZM18.98 17.48C18.98 19.69 16.45 21 14.02 21C13.45 21 12.98 20.53 12.98 20.02C12.98 19.45 13.45 18.98 14.02 18.98C15.56 18.98 17.02 18.28 17.02 17.48C17.02 17.02 16.5 16.64 15.75 16.31L17.25 14.81C18.33 15.47 18.98 16.31 18.98 17.48ZM4.59 13.36C3.61 12.8 3 12.05 3 11.02C3 9.19 4.88 8.39 6.56 7.64C7.59 7.17 9 6.56 9 6C9 5.58 8.2 5.02 6.98 5.02C5.72 5.02 5.2 5.62 5.16 5.62C4.83 6.05 4.17 6.09 3.75 5.77C3.38 5.44 3.28 4.83 3.61 4.36C3.75 4.22 4.78 3 6.98 3C9.23 3 11.02 4.31 11.02 6C11.02 7.88 9.05 8.72 7.36 9.47C6.42 9.89 5.02 10.5 5.02 11.02C5.02 11.3 5.44 11.58 6.05 11.86L4.59 13.36Z",
  drop:
    "M8.72 11.72 11.3 14.3C11.67 14.67 12.33 14.67 12.7 14.3L15.28 11.72C15.94 11.06 15.47 9.98 14.58 9.98H9.42C8.53 9.98 8.06 11.06 8.72 11.72Z",
  eco:
    "M6.05 8.06C3.33 10.78 3.33 15.19 6.05 17.95C7.5 14.53 10.12 11.67 13.41 9.98C10.64 12.33 8.67 15.61 8.02 19.31C10.59 20.53 13.78 20.11 15.94 17.95C18.94 14.95 19.78 6.8 19.97 4.55C19.97 4.27 19.73 4.03 19.45 4.03C17.2 4.22 9.05 5.06 6.05 8.06Z",
  event:
    "M15.98 12.98H12.98C12.47 12.98 12 13.45 12 14.02V17.02C12 17.53 12.47 18 12.98 18H15.98C16.55 18 17.02 17.53 17.02 17.02V14.02C17.02 13.45 16.55 12.98 15.98 12.98ZM15.98 3V3.98H8.02V3C8.02 2.44 7.55 2.02 6.98 2.02C6.47 2.02 6 2.44 6 3V3.98H5.02C3.89 3.98 3 4.92 3 6V20.02C3 21.09 3.89 21.98 5.02 21.98H18.98C20.11 21.98 21 21.09 21 20.02V6C21 4.92 20.11 3.98 18.98 3.98H18V3C18 2.44 17.53 2.02 17.02 2.02C16.45 2.02 15.98 2.44 15.98 3ZM18 20.02H6C5.44 20.02 5.02 19.55 5.02 18.98V9H18.98V18.98C18.98 19.55 18.56 20.02 18 20.02Z",
  flag:
    "M14.02 6 13.27 4.55C13.12 4.22 12.75 3.98 12.38 3.98H6C5.44 3.98 5.02 4.45 5.02 5.02V20.02C5.02 20.53 5.44 21 6 21C6.56 21 6.98 20.53 6.98 20.02V14.02H12L12.7 15.47C12.89 15.8 13.22 15.98 13.59 15.98H18.98C19.55 15.98 20.02 15.56 20.02 15V6.98C20.02 6.47 19.55 6 18.98 6H14.02ZM18 14.02H14.02L12.98 12H6.98V6H12L12.98 8.02H18V14.02Z",
  gavel:
    "M2.02 21H12C12.56 21 12.98 21.47 12.98 21.98C12.98 22.55 12.56 23.02 12 23.02H2.02C1.45 23.02 0.98 22.55 0.98 21.98C0.98 21.47 1.45 21 2.02 21ZM5.25 8.06 8.06 5.25 20.81 17.95C21.56 18.75 21.56 20.02 20.81 20.81C20.02 21.56 18.75 21.56 17.95 20.81L5.25 8.06ZM13.73 2.39 16.55 5.25C17.34 6 17.34 7.31 16.55 8.06L15.14 9.47L9.47 3.84L10.92 2.44C11.67 1.64 12.94 1.64 13.73 2.39ZM3.84 9.47 9.47 15.14 8.06 16.55C7.31 17.34 6.05 17.34 5.25 16.55L2.44 13.73C1.64 12.94 1.64 11.67 2.44 10.88L3.84 9.47Z",
  grid:
    "M5.02 11.02H9C10.08 11.02 11.02 10.08 11.02 9V5.02C11.02 3.89 10.08 3 9 3H5.02C3.89 3 3 3.89 3 5.02V9C3 10.08 3.89 11.02 5.02 11.02ZM5.02 21H9C10.08 21 11.02 20.11 11.02 18.98V15C11.02 13.92 10.08 12.98 9 12.98H5.02C3.89 12.98 3 13.92 3 15V18.98C3 20.11 3.89 21 5.02 21ZM12.98 5.02V9C12.98 10.08 13.92 11.02 15 11.02H18.98C20.11 11.02 21 10.08 21 9V5.02C21 3.89 20.11 3 18.98 3H15C13.92 3 12.98 3.89 12.98 5.02ZM15 21H18.98C20.11 21 21 20.11 21 18.98V15C21 13.92 20.11 12.98 18.98 12.98H15C13.92 12.98 12.98 13.92 12.98 15V18.98C12.98 20.11 13.92 21 15 21Z",
  healing:
    "M17.72 12 21.7 8.06C22.08 7.64 22.08 7.03 21.7 6.61L17.39 2.3C16.97 1.92 16.36 1.92 15.94 2.3L12 6.28L8.02 2.3C7.78 2.11 7.55 2.02 7.31 2.02C7.03 2.02 6.8 2.11 6.61 2.3L2.25 6.61C1.88 7.03 1.88 7.64 2.25 8.06L6.23 12L2.25 15.98C1.88 16.41 1.88 17.02 2.25 17.39L6.61 21.75C6.98 22.12 7.59 22.12 8.02 21.75L12 17.77L15.94 21.75C16.17 21.94 16.41 22.03 16.69 22.03C16.92 22.03 17.2 21.94 17.39 21.75L21.7 17.39C22.12 17.02 22.12 16.41 21.7 15.98L17.72 12ZM12 9C12.56 9 12.98 9.47 12.98 9.98C12.98 10.55 12.56 11.02 12 11.02C11.44 11.02 11.02 10.55 11.02 9.98C11.02 9.47 11.44 9 12 9ZM7.31 10.97 3.66 7.36 7.31 3.7 10.92 7.31 7.31 10.97ZM9.98 12.98C9.47 12.98 9 12.56 9 12C9 11.44 9.47 11.02 9.98 11.02C10.55 11.02 11.02 11.44 11.02 12C11.02 12.56 10.55 12.98 9.98 12.98ZM12 15C11.44 15 11.02 14.53 11.02 14.02C11.02 13.45 11.44 12.98 12 12.98C12.56 12.98 12.98 13.45 12.98 14.02C12.98 14.53 12.56 15 12 15ZM14.02 11.02C14.53 11.02 15 11.44 15 12C15 12.56 14.53 12.98 14.02 12.98C13.45 12.98 12.98 12.56 12.98 12C12.98 11.44 13.45 11.02 14.02 11.02ZM16.64 20.34 13.03 16.73 16.64 13.08 20.3 16.69 16.64 20.34Z",
  hub:
    "M8.39 18.19C8.77 18.7 9 19.31 9 20.02C9 21.66 7.64 23.02 6 23.02C4.36 23.02 3 21.66 3 20.02C3 18.33 4.36 17.02 6 17.02C6.42 17.02 6.84 17.11 7.22 17.25L8.62 15.47C7.73 14.44 7.36 13.08 7.55 11.81L5.53 11.11C4.97 11.95 4.08 12.52 3 12.52C1.36 12.52 0 11.16 0 9.52C0 7.83 1.36 6.52 3 6.52C4.64 6.52 6 7.83 6 9.52C6 9.56 6 9.66 6 9.7L8.02 10.41C8.67 9.19 9.84 8.3 11.25 8.06V5.91C9.94 5.58 9 4.41 9 3C9 1.36 10.36 0 12 0C13.64 0 15 1.36 15 3C15 4.41 14.06 5.58 12.75 5.91V8.06C14.16 8.3 15.33 9.19 15.98 10.41L18 9.7C18 9.66 18 9.56 18 9.52C18 7.83 19.36 6.52 21 6.52C22.64 6.52 24 7.83 24 9.52C24 11.16 22.64 12.52 21 12.52C19.92 12.52 19.03 11.95 18.47 11.11L16.45 11.81C16.64 13.08 16.31 14.44 15.38 15.52L16.78 17.25C17.16 17.11 17.58 17.02 18 17.02C19.64 17.02 21 18.33 21 20.02C21 21.66 19.64 23.02 18 23.02C16.36 23.02 15 21.66 15 20.02C15 19.31 15.23 18.7 15.61 18.19L14.2 16.45C12.84 17.2 11.2 17.2 9.8 16.45L8.39 18.19Z",
  menu_book:
    "M17.48 4.5C15.56 4.5 13.45 4.92 12 6C10.55 4.92 8.44 4.5 6.52 4.5C5.06 4.5 3.52 4.73 2.2 5.3C1.5 5.62 0.98 6.33 0.98 7.12V18.42C0.98 19.73 2.2 20.67 3.47 20.34C4.45 20.11 5.48 20.02 6.52 20.02C8.06 20.02 9.7 20.25 11.06 20.91C11.67 21.23 12.33 21.23 12.94 20.91C14.25 20.25 15.94 20.02 17.48 20.02C18.47 20.02 19.55 20.11 20.53 20.34C21.75 20.67 22.97 19.73 22.97 18.42V7.12C22.97 6.33 22.5 5.62 21.75 5.3C20.48 4.73 18.94 4.5 17.48 4.5ZM21 17.25C21 17.86 20.44 18.33 19.78 18.19C19.03 18.05 18.28 18 17.48 18C15.8 18 13.36 18.66 12 19.5V8.02C13.36 7.17 15.8 6.52 17.48 6.52C18.42 6.52 19.31 6.61 20.2 6.8C20.67 6.89 21 7.31 21 7.78V17.25ZM13.97 11.02C13.64 11.02 13.36 10.83 13.27 10.5C13.12 10.08 13.36 9.66 13.73 9.56C15.28 9.05 17.3 8.91 19.12 9.09C19.5 9.14 19.83 9.52 19.78 9.94C19.73 10.36 19.36 10.64 18.94 10.59C17.3 10.41 15.56 10.55 14.2 10.97C14.11 10.97 14.06 11.02 13.97 11.02ZM13.97 13.69C13.64 13.69 13.36 13.45 13.27 13.17C13.12 12.75 13.36 12.33 13.73 12.19C15.28 11.72 17.3 11.53 19.12 11.77C19.5 11.81 19.83 12.19 19.78 12.61C19.73 12.98 19.36 13.31 18.94 13.27C17.3 13.08 15.56 13.22 14.2 13.64C14.11 13.64 14.06 13.69 13.97 13.69ZM13.97 16.31C13.64 16.31 13.36 16.12 13.27 15.8C13.12 15.42 13.36 15 13.73 14.86C15.28 14.39 17.3 14.2 19.12 14.44C19.5 14.48 19.83 14.86 19.78 15.23C19.73 15.66 19.36 15.94 18.94 15.89C17.3 15.7 15.56 15.89 14.2 16.31C14.11 16.31 14.06 16.31 13.97 16.31Z",
  movie:
    "M18 3.98 19.83 7.64C19.92 7.78 19.78 8.02 19.59 8.02H17.62C17.25 8.02 16.88 7.78 16.73 7.45L15 3.98H12.98L14.81 7.64C14.91 7.78 14.77 8.02 14.58 8.02H12.61C12.23 8.02 11.91 7.78 11.72 7.45L9.98 3.98H8.02L9.8 7.64C9.89 7.78 9.8 8.02 9.61 8.02H7.64C7.22 8.02 6.89 7.78 6.7 7.45L5.02 3.98H3.98C2.91 3.98 2.02 4.92 2.02 6V18C2.02 19.08 2.91 20.02 3.98 20.02H20.02C21.09 20.02 21.98 19.08 21.98 18V5.02C21.98 4.45 21.56 3.98 21 3.98H18Z",
  music:
    "M12 5.02V13.55C11.06 13.03 9.89 12.8 8.67 13.22C7.31 13.69 6.28 14.91 6.05 16.31C5.58 19.03 7.92 21.38 10.64 20.95C12.61 20.62 14.02 18.84 14.02 16.83V6.98H15.98C17.11 6.98 18 6.09 18 5.02C18 3.89 17.11 3 15.98 3H14.02C12.89 3 12 3.89 12 5.02Z",
  palette:
    "M12 2.02C6.47 2.02 2.02 6.47 2.02 12C2.02 17.53 6.47 21.98 12 21.98C13.36 21.98 14.48 20.86 14.48 19.5C14.48 18.89 14.25 18.28 13.88 17.81C13.78 17.72 13.73 17.62 13.73 17.48C13.73 17.2 13.97 17.02 14.25 17.02H15.98C19.31 17.02 21.98 14.3 21.98 11.02C21.98 6.05 17.53 2.02 12 2.02ZM17.48 12.98C16.69 12.98 15.98 12.33 15.98 11.48C15.98 10.69 16.69 9.98 17.48 9.98C18.33 9.98 18.98 10.69 18.98 11.48C18.98 12.33 18.33 12.98 17.48 12.98ZM14.48 9C13.69 9 12.98 8.34 12.98 7.5C12.98 6.66 13.69 6 14.48 6C15.33 6 15.98 6.66 15.98 7.5C15.98 8.34 15.33 9 14.48 9ZM5.02 11.48C5.02 10.69 5.67 9.98 6.52 9.98C7.31 9.98 8.02 10.69 8.02 11.48C8.02 12.33 7.31 12.98 6.52 12.98C5.67 12.98 5.02 12.33 5.02 11.48ZM11.02 7.5C11.02 8.34 10.31 9 9.52 9C8.67 9 8.02 8.34 8.02 7.5C8.02 6.66 8.67 6 9.52 6C10.31 6 11.02 6.66 11.02 7.5Z",
  person:
    "M12 5.91C13.17 5.91 14.11 6.84 14.11 8.02C14.11 9.14 13.17 10.08 12 10.08C10.83 10.08 9.89 9.14 9.89 8.02C9.89 6.84 10.83 5.91 12 5.91ZM12 14.91C14.95 14.91 18.09 16.36 18.09 17.02V18.09H5.91V17.02C5.91 16.36 9.05 14.91 12 14.91ZM12 3.98C9.8 3.98 8.02 5.81 8.02 8.02C8.02 10.22 9.8 12 12 12C14.2 12 15.98 10.22 15.98 8.02C15.98 5.81 14.2 3.98 12 3.98ZM12 12.98C9.33 12.98 3.98 14.34 3.98 17.02V18.98C3.98 19.55 4.45 20.02 5.02 20.02H18.98C19.55 20.02 20.02 19.55 20.02 18.98V17.02C20.02 14.34 14.67 12.98 12 12.98Z",
  premium:
    "M10.92 12.75 12 11.95 13.08 12.75C13.45 13.03 13.97 12.66 13.83 12.19L13.45 10.83L14.62 9.89C15 9.61 14.81 9 14.3 9H12.89L12.47 7.64C12.33 7.22 11.67 7.22 11.53 7.64L11.11 9H9.7C9.19 9 9 9.61 9.38 9.89L10.55 10.83L10.12 12.19C9.98 12.66 10.55 13.03 10.92 12.75ZM6 21.61C6 22.31 6.66 22.78 7.31 22.55L12 21L16.69 22.55C17.34 22.78 18 22.31 18 21.61V15.28C19.22 13.88 20.02 12.05 20.02 9.98C20.02 5.58 16.41 2.02 12 2.02C7.59 2.02 3.98 5.58 3.98 9.98C3.98 12.05 4.78 13.88 6 15.28V21.61ZM12 3.98C15.33 3.98 18 6.7 18 9.98C18 13.31 15.33 15.98 12 15.98C8.67 15.98 6 13.31 6 9.98C6 6.7 8.67 3.98 12 3.98Z",
  psychology:
    "M12.98 8.58C12.19 8.58 11.58 9.19 11.58 9.98C11.58 10.78 12.19 11.44 12.98 11.44C13.78 11.44 14.44 10.78 14.44 9.98C14.44 9.19 13.78 8.58 12.98 8.58ZM13.22 3C9.38 2.91 6.19 5.86 6 9.66L4.08 12.19C3.84 12.52 4.08 12.98 4.5 12.98H6V15.98C6 17.11 6.89 18 8.02 18H9V20.02C9 20.53 9.47 21 9.98 21H15C15.56 21 15.98 20.53 15.98 20.02V16.31C18.42 15.14 20.11 12.66 20.02 9.75C19.88 6.14 16.83 3.09 13.22 3ZM15.98 9.98C15.98 10.12 15.98 10.27 15.98 10.41L16.83 11.06C16.88 11.11 16.92 11.2 16.88 11.3L16.08 12.7C16.03 12.8 15.89 12.8 15.8 12.8L14.81 12.38C14.62 12.56 14.39 12.66 14.16 12.75L14.02 13.83C13.97 13.92 13.92 14.02 13.78 14.02H12.19C12.09 14.02 12 13.92 12 13.83L11.86 12.75C11.58 12.66 11.39 12.56 11.16 12.38L10.17 12.8C10.08 12.8 9.98 12.8 9.94 12.7L9.14 11.3C9.09 11.2 9.09 11.11 9.19 11.06L10.03 10.41C10.03 10.27 9.98 10.12 9.98 9.98C9.98 9.89 10.03 9.75 10.03 9.61L9.19 8.95C9.09 8.91 9.09 8.81 9.14 8.67L9.94 7.31C9.98 7.22 10.08 7.17 10.17 7.22L11.2 7.64C11.39 7.45 11.62 7.31 11.86 7.22L12 6.19C12 6.05 12.09 6 12.19 6H13.78C13.92 6 13.97 6.05 14.02 6.19L14.16 7.22C14.39 7.31 14.62 7.45 14.81 7.64L15.8 7.22C15.89 7.17 16.03 7.22 16.08 7.31L16.88 8.67C16.92 8.77 16.88 8.91 16.83 8.95L15.94 9.61C15.98 9.75 15.98 9.84 15.98 9.98Z",
  psychology_o:
    "M15.8 7.22 14.81 7.64C14.62 7.45 14.39 7.31 14.16 7.22L14.02 6.19C13.97 6.05 13.92 6 13.78 6H12.19C12.09 6 12 6.05 12 6.19L11.86 7.22C11.62 7.31 11.39 7.45 11.2 7.64L10.17 7.22C10.08 7.17 9.98 7.22 9.94 7.31L9.14 8.67C9.09 8.77 9.14 8.91 9.19 8.95L10.03 9.61C10.03 9.75 9.98 9.89 9.98 9.98C9.98 10.12 10.03 10.27 10.03 10.41L9.19 11.06C9.09 11.11 9.09 11.2 9.14 11.3L9.94 12.7C9.98 12.8 10.08 12.8 10.17 12.8L11.2 12.38C11.39 12.56 11.62 12.66 11.86 12.75L12 13.83C12 13.92 12.09 14.02 12.19 14.02H13.78C13.92 14.02 13.97 13.92 14.02 13.83L14.16 12.75C14.39 12.66 14.62 12.56 14.81 12.38L15.8 12.8C15.89 12.8 16.03 12.8 16.03 12.7L16.83 11.3C16.92 11.2 16.88 11.11 16.78 11.06L15.98 10.41C15.98 10.27 15.98 10.12 15.98 9.98C15.98 9.84 15.98 9.75 15.98 9.61L16.83 8.95C16.92 8.91 16.92 8.77 16.88 8.67L16.08 7.31C16.03 7.22 15.89 7.17 15.8 7.22ZM12.98 11.44C12.19 11.44 11.58 10.78 11.58 9.98C11.58 9.19 12.19 8.58 12.98 8.58C13.78 8.58 14.44 9.19 14.44 9.98C14.44 10.78 13.78 11.44 12.98 11.44ZM19.92 9.05C19.5 5.81 16.69 3.19 13.41 3C13.27 3 13.12 3 12.98 3C9.47 3 6.56 5.62 6.09 9L4.17 12.47C3.75 13.12 4.22 14.02 5.02 14.02H6V15.98C6 17.11 6.89 18 8.02 18H9V21H15.98V16.31C18.61 15.05 20.34 12.23 19.92 9.05ZM14.91 14.62 14.02 15.05V18.98H11.02V15.98H8.02V12H6.7L8.02 9.66C8.2 7.08 10.36 5.02 12.98 5.02C15.75 5.02 18 7.22 18 9.98C18 12.09 16.69 13.88 14.91 14.62Z",
  schedule:
    "M12 2.02C6.47 2.02 2.02 6.47 2.02 12C2.02 17.53 6.47 21.98 12 21.98C17.53 21.98 21.98 17.53 21.98 12C21.98 6.47 17.53 2.02 12 2.02ZM12 20.02C7.59 20.02 3.98 16.41 3.98 12C3.98 7.59 7.59 3.98 12 3.98C16.41 3.98 20.02 7.59 20.02 12C20.02 16.41 16.41 20.02 12 20.02ZM11.77 6.98H11.72C11.3 6.98 11.02 7.31 11.02 7.73V12.42C11.02 12.8 11.2 13.12 11.48 13.31L15.66 15.8C15.98 15.98 16.41 15.89 16.64 15.56C16.83 15.19 16.73 14.77 16.36 14.58L12.52 12.28V7.73C12.52 7.31 12.19 6.98 11.77 6.98Z",
  school:
    "M5.02 13.17V15.98C5.02 16.73 5.39 17.39 6.05 17.77L11.06 20.48C11.62 20.81 12.38 20.81 12.94 20.48L17.95 17.77C18.61 17.39 18.98 16.73 18.98 15.98V13.17L12.94 16.5C12.38 16.83 11.62 16.83 11.06 16.5L5.02 13.17ZM11.06 3.52 2.62 8.11C1.92 8.48 1.92 9.52 2.62 9.89L11.06 14.48C11.62 14.81 12.38 14.81 12.94 14.48L21 10.08V15.98C21 16.55 21.47 17.02 21.98 17.02C22.55 17.02 23.02 16.55 23.02 15.98V9.61C23.02 9.23 22.78 8.91 22.5 8.72L12.94 3.52C12.38 3.19 11.62 3.19 11.06 3.52Z",
  science:
    "M20.53 17.72 15 11.02V5.02H15.98C16.55 5.02 17.02 4.55 17.02 3.98C17.02 3.47 16.55 3 15.98 3H8.02C7.45 3 6.98 3.47 6.98 3.98C6.98 4.55 7.45 5.02 8.02 5.02H9V11.02L3.47 17.72C3.14 18.14 3 18.56 3 18.98C3 20.02 3.8 21 5.02 21H18.98C20.2 21 21 20.02 21 18.98C21 18.56 20.86 18.14 20.53 17.72Z",
  search:
    "M15.52 14.02H14.72L14.44 13.73C15.61 12.33 16.27 10.41 15.89 8.39C15.42 5.62 13.12 3.38 10.31 3.05C6.09 2.53 2.53 6.09 3.05 10.31C3.38 13.12 5.62 15.42 8.39 15.89C10.41 16.27 12.33 15.61 13.73 14.44L14.02 14.72V15.52L18.23 19.73C18.66 20.16 19.31 20.16 19.73 19.73C20.16 19.36 20.16 18.66 19.73 18.28L15.52 14.02ZM9.52 14.02C7.03 14.02 5.02 12 5.02 9.52C5.02 7.03 7.03 5.02 9.52 5.02C12 5.02 14.02 7.03 14.02 9.52C14.02 12 12 14.02 9.52 14.02Z",
  sort:
    "M3.98 18H8.02C8.53 18 9 17.53 9 17.02C9 16.45 8.53 15.98 8.02 15.98H3.98C3.47 15.98 3 16.45 3 17.02C3 17.53 3.47 18 3.98 18ZM3 6.98C3 7.55 3.47 8.02 3.98 8.02H20.02C20.53 8.02 21 7.55 21 6.98C21 6.47 20.53 6 20.02 6H3.98C3.47 6 3 6.47 3 6.98ZM3.98 12.98H14.02C14.53 12.98 15 12.56 15 12C15 11.44 14.53 11.02 14.02 11.02H3.98C3.47 11.02 3 11.44 3 12C3 12.56 3.47 12.98 3.98 12.98Z",
  star:
    "M12 17.25 16.17 19.78C16.92 20.25 17.86 19.55 17.62 18.7L16.55 13.97L20.2 10.78C20.86 10.22 20.53 9.14 19.64 9.05L14.81 8.62L12.94 4.17C12.56 3.38 11.44 3.38 11.06 4.17L9.19 8.62L4.36 9.05C3.47 9.09 3.14 10.22 3.8 10.78L7.45 13.97L6.38 18.7C6.14 19.55 7.08 20.25 7.83 19.78L12 17.25Z",
  star_border:
    "M19.64 9.05 14.81 8.62 12.94 4.17C12.56 3.38 11.44 3.38 11.06 4.17L9.19 8.62L4.36 9.05C3.47 9.09 3.14 10.22 3.8 10.78L7.45 13.97L6.38 18.7C6.14 19.55 7.08 20.25 7.83 19.78L12 17.25L16.17 19.78C16.92 20.25 17.86 19.55 17.62 18.7L16.55 13.97L20.2 10.78C20.86 10.22 20.53 9.09 19.64 9.05ZM12 15.42 8.25 17.67 9.23 13.41 5.91 10.5 10.31 10.12 12 6.09 13.69 10.12 18.09 10.5 14.77 13.41 15.75 17.67 12 15.42Z",
  star_half:
    "M19.64 9.05 14.81 8.62 12.94 4.17C12.56 3.38 11.44 3.38 11.06 4.17L9.19 8.62L4.36 9.05C3.47 9.09 3.14 10.22 3.8 10.78L7.45 13.97L6.38 18.7C6.14 19.55 7.08 20.25 7.83 19.78L12 17.25L16.17 19.78C16.92 20.25 17.86 19.55 17.62 18.7L16.55 13.97L20.2 10.78C20.86 10.22 20.53 9.09 19.64 9.05ZM12 15.42V6.09L13.69 10.12L18.09 10.5L14.77 13.41L15.75 17.67L12 15.42Z",
  translate:
    "M12.66 15.66C12.8 15.33 12.7 14.91 12.42 14.62L10.31 12.56L10.36 12.52C12.09 10.59 13.36 8.34 14.06 6H16.03C16.55 6 17.02 5.53 17.02 5.02V4.97C17.02 4.45 16.55 3.98 16.03 3.98H9.98V3C9.98 2.44 9.56 2.02 9 2.02C8.44 2.02 8.02 2.44 8.02 3V3.98H1.97C1.45 3.98 0.98 4.45 0.98 4.97C0.98 5.53 1.45 6 1.97 6H12.19C11.48 7.92 10.45 9.75 9 11.34C8.2 10.45 7.5 9.47 6.94 8.48C6.8 8.2 6.47 8.02 6.14 8.02C5.48 8.02 5.02 8.77 5.39 9.33C6 10.5 6.75 11.58 7.69 12.56L3.28 16.88C2.91 17.25 2.91 17.91 3.28 18.28C3.7 18.7 4.31 18.7 4.73 18.28L9 14.02L11.02 16.03C11.53 16.55 12.42 16.36 12.66 15.66ZM17.48 9.98C16.92 9.98 16.36 10.36 16.17 10.92L12.47 20.72C12.23 21.33 12.7 21.98 13.36 21.98C13.73 21.98 14.11 21.75 14.25 21.38L15.14 18.98H19.88L20.77 21.38C20.91 21.75 21.28 21.98 21.66 21.98C22.31 21.98 22.78 21.33 22.55 20.72L18.84 10.92C18.66 10.36 18.09 9.98 17.48 9.98ZM15.89 17.02 17.48 12.66 19.12 17.02H15.89Z",
  trending:
    "M16.83 6.84 18.28 8.3 13.41 13.17 10.12 9.89C9.75 9.47 9.09 9.47 8.72 9.89L2.72 15.89C2.3 16.27 2.3 16.92 2.72 17.3C3.09 17.67 3.75 17.67 4.12 17.3L9.42 12L12.7 15.28C13.08 15.7 13.73 15.7 14.11 15.28L19.69 9.7L21.14 11.16C21.47 11.44 21.98 11.25 21.98 10.78V6.52C21.98 6.23 21.8 6 21.52 6H17.2C16.78 6 16.55 6.56 16.83 6.84Z",
  verified:
    "M23.02 12 20.58 9.19 20.91 5.53 17.3 4.69 15.42 1.5 12 2.95 8.58 1.5 6.7 4.69 3.09 5.48 3.42 9.19 0.98 12 3.42 14.81 3.09 18.47 6.7 19.31 8.58 22.5 12 21.05 15.42 22.5 17.3 19.31 20.91 18.47 20.58 14.81 23.02 12ZM9.38 16.03 6.98 13.59C6.61 13.22 6.61 12.61 6.98 12.19L7.08 12.14C7.45 11.72 8.11 11.72 8.48 12.14L10.08 13.73L15.23 8.58C15.66 8.2 16.27 8.2 16.69 8.58L16.73 8.67C17.11 9.05 17.11 9.7 16.73 10.08L10.83 16.03C10.41 16.41 9.8 16.41 9.38 16.03Z",
  work:
    "M20.02 6H15.98V3.98C15.98 2.91 15.09 2.02 14.02 2.02H9.98C8.91 2.02 8.02 2.91 8.02 3.98V6H3.98C2.91 6 2.02 6.89 2.02 8.02V18.98C2.02 20.11 2.91 21 3.98 21H20.02C21.09 21 21.98 20.11 21.98 18.98V8.02C21.98 6.89 21.09 6 20.02 6ZM14.02 6H9.98V3.98H14.02V6Z",
};

const ic = (nome: string, classe = "") =>
  `<svg class="ic${classe ? ` ${classe}` : ""}" aria-hidden="true" focusable="false"><use href="#i-${nome}"/></svg>`;

/// I simboli che la pagina richiama, nell'ordine in cui compaiono.
function spriteIcone(html: string): string {
  const usati = [...new Set([...html.matchAll(/href="#i-([a-z_]+)"/g)].map((m) => m[1]))]
    .filter((n) => Object.hasOwn(ICONE, n));
  return usati.length
    ? `<svg class="sprite" aria-hidden="true" focusable="false"><defs>${
      usati.map((n) => `<symbol id="i-${n}" viewBox="0 0 24 24"><path d="${ICONE[n]}"/></symbol>`).join("")
    }</defs></svg>`
    : "";
}

/// Le categorie dell'enum dell'app (template_models.dart) con l'etichetta di
/// app_it.arb e l'icona di marketplaceCategoryIcon. Fuori elenco = niente
/// pillola: la 218 lo manda già NULL, e NULL non diventa «Personalizzato».
const CATEGORIE: Record<string, [string, string]> = {
  study: ["Studio", "menu_book"],
  planner: ["Agenda", "event"],
  journal: ["Diario", "auto_stories"],
  calligraphy: ["Calligrafia", "draw"],
  music: ["Musica", "music"],
  storyboard: ["Storyboard", "movie"],
  business: ["Business", "work"],
  mindMap: ["Mappa mentale", "hub"],
  science: ["Scienze", "science"],
  language: ["Lingue", "translate"],
  custom: ["Personalizzato", "palette"],
};
const categoriaDi = (c: unknown): [string, string] | null =>
  typeof c === "string" && Object.hasOwn(CATEGORIE, c) ? CATEGORIE[c] : null;

const ICONA_MATERIA: Record<string, string> = {
  math: "menu_book",
  physics: "science",
  chemistry: "science",
  biology: "science",
  medicine: "healing",
  law: "gavel",
  economics: "work",
  philosophy: "psychology",
  history: "auto_stories",
  language: "translate",
  cs: "code",
};
const iconaMateria = (k: string | null) => (k && Object.hasOwn(ICONA_MATERIA, k) ? ICONA_MATERIA[k] : "menu_book");

/// Un numero dal database, o null: PostgREST manda i numeric come numeri, ma
/// un proxy può mandarli come stringhe.
function numero(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
/// 1234 → «1234», 1 200 000 → «1,2 Mln»: come NumberFormat.compact dell'app.
function numeroIt(n: number): string {
  try {
    return new Intl.NumberFormat("it-IT", { notation: "compact", maximumFractionDigits: 1 }).format(n);
  } catch {
    return String(n);
  }
}
const votoIt = (v: number) => v.toFixed(1).replace(".", ",");

/// La parola più lunga di un testo in em, a peso 600, per eccesso: tarata su
/// Noto Sans (il sans più largo fra quelli di sistema che il catalogo usa;
/// «Matematica» misura 6,0 em, stima 6,3). Solo per scegliere un corpo.
export function larghezzaEm(testo: string): number {
  const em = (c: string) =>
    /[ijl.,'’!|]/.test(c) ? 0.32 : /[tfr]/.test(c) ? 0.44 : /[mw]/.test(c) ? 0.96 : /[MW]/.test(c) ? 1.02
    : /\p{Lu}/u.test(c) ? 0.74 : 0.62;
  const max = Math.max(0, ...testo.split(/\s+/).map((p) => [...p].reduce((s, c) => s + em(c), 0)));
  return Math.round(max * 100) / 100;
}
const concetti = (n: number) => `${n} concett${n === 1 ? "o" : "i"}`;

/// Cinque stelle come MW: piena se ≥ i, mezza se ≥ i − 0,5, vuota altrimenti.
function stelle(voto: number, voti: number | null, classe = ""): string {
  const s = [1, 2, 3, 4, 5]
    .map((i) => (voto >= i ? ic("star") : voto >= i - 0.5 ? ic("star_half") : ic("star_border", "vuota")))
    .join("");
  const n = voti !== null ? `<span class="n" aria-hidden="true">(${esc(numeroIt(voti))})</span>` : "";
  const detto = `Valutazione ${votoIt(voto)} su 5${voti !== null ? `, ${voti} vot${voti === 1 ? "o" : "i"}` : ""}`;
  return `<span class="stelle${classe ? ` ${classe}` : ""}" role="img" aria-label="${detto}">${s}${n}</span>`;
}

/// Il pallino dell'autore: FNV-1a sulle unità UTF-16 del nome mostrato, come
/// _inkfolioAuthorHue (MW:217-237). «Fluera» → sunset.
function pallino(nome: string, classe = ""): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < nome.length; i++) h = Math.imul(h ^ nome.charCodeAt(i), 0x01000193) >>> 0;
  const tinta = ["sunset", "amber", "rose", "grape"][h % 4];
  const iniziale = [...nome.replace(/^@/, "")][0]?.toUpperCase() ?? "?";
  return `<span class="pallino ${tinta}${classe ? ` ${classe}` : ""}" aria-hidden="true">${esc(iniziale)}</span>`;
}

/// «Nuovo» (MW:437-454): nessun distintivo, nessun voto mostrabile, e al
/// massimo 7 giorni. L'app guarda le installazioni, che il web non ha.
function nuovo(r: SemeWeb): boolean {
  if (r.is_official === true || r.is_featured === true || numero(r.voto_medio) !== null) return false;
  const eta = Date.now() - Date.parse(r.created_at ?? "");
  return Number.isFinite(eta) && eta >= 0 && eta <= 7 * 86_400_000;
}

/// Il distintivo di fiducia piccolo: Ufficiale vince su In evidenza.
const nomeFiducia = (r: { is_official?: boolean | null; is_featured?: boolean | null }) =>
  r.is_official === true ? "Ufficiale" : r.is_featured === true ? "In evidenza" : null;
/// Sopra l'anteprima è solo per gli occhi (aria-hidden): il lettore di schermo
/// lo sente in `dopoIlTitolo`, perché il nome della scheda cominci dal titolo
/// come nell'app («titolo. autore. voto», MW:1246-1262).
function fiducia(r: { is_official?: boolean | null; is_featured?: boolean | null }): string {
  const n = nomeFiducia(r);
  return n
    ? `<span class="fiducia${r.is_official === true ? "" : " evid"}" title="${n}" aria-hidden="true">${ic(r.is_official === true ? "verified" : "auto_awesome")}</span>`
    : "";
}
/// I distintivi della scheda come testo nascosto, in fondo al nome del link.
/// ⚠️ a.scheda è position:relative per questo: senza, lo span assoluto
/// sfuggiva alla striscia che scorre e allargava la pagina (misurato: 989 px
/// di scorrimento a 412).
function dopoIlTitolo(voci: Array<string | null | undefined>): string {
  const v = voci.filter((x): x is string => !!x);
  return v.length ? `<span class="vh">${esc(v.join(", "))}</span>` : "";
}

/// L'anteprima «foglio appuntato sulla carta»: cornice a righe da quaderno e
/// foglio a proporzione fissa, così le miniature di una riga sono alte uguali.
function anteprima(r: SemeWeb, subito: boolean, sopra: string): string {
  const img = r.thumb_path ? publicUrl(r.thumb_path) : r.og_path ? publicUrl(r.og_path) : null;
  const cat = categoriaDi(r.category);
  const dentro = img
    ? `<img src="${esc(img)}" alt="" width="400" height="300"${subito ? "" : ` loading="lazy"`} decoding="async" />`
    : `<span class="rigatura">${ic(cat?.[1] ?? "menu_book", "cat")}</span>`;
  return `<span class="cornice"><span class="foglio">${dentro}${sopra}</span></span>`;
}

/// La scheda della griglia e delle strisce (TemplateCard, MW:1073-1463). Tutta
/// la scheda è UN link. La pillola dell'efficacia solo nella griglia.
function schedaSeme(r: SemeWeb, griglia: boolean, subito = false): string {
  const t = (r.title ?? "").trim() || "Senza titolo";
  const cat = categoriaDi(r.category);
  const eNuovo = nuovo(r);
  const sopra = (fiducia(r) || (eNuovo ? `<span class="nuovo" aria-hidden="true">Nuovo</span>` : "")) +
    (cat ? `<span class="categoria" aria-hidden="true">${ic(cat[1])}<span>${esc(cat[0])}</span></span>` : "");
  // Mai author_code sulle pagine indicizzate (dati_web §1): oggi ci arrivano
  // solo pack ufficiali, e l'autore degli studenti lo decide la F3.
  const autore = r.is_official === true ? "Fluera" : null;
  const eff = griglia ? numero(r.efficacia_pct) : null;
  const voto = numero(r.voto_medio);
  const n = numero(r.concept_count);
  return `<li><a class="scheda" href="${SHARE}/s/${esc(r.hash)}">${anteprima(r, subito, sopra)}<span class="testi"><h3 class="t"${attrLingua(r)}>${esc(t)}</h3>${
    autore ? `<span class="autore">${pallino(autore)}${esc(autore)}</span>` : ""
  }${eff !== null ? `<span class="pillola">${ic("trending")}+${Math.round(eff)}% ritenzione</span>` : ""}${
    voto !== null ? stelle(voto, numero(r.voti)) : ""
  }<span class="piede-s"><span>${n !== null && n > 0 ? `${ic("hub")}${concetti(n)}` : ""}</span>${ic("chevron", "vai")}</span>${
    dopoIlTitolo([nomeFiducia(r) ?? (eNuovo ? "Nuovo" : null), cat?.[0]])
  }</span></a></li>`;
}

/// La scheda della striscia «In evidenza» (FeaturedTemplateCard, MW:2367-2626).
function schedaEvidenza(r: SemeWeb): string {
  const t = (r.title ?? "").trim() || "Senza titolo";
  const voto = numero(r.voto_medio);
  return `<li><a class="scheda evid" href="${SHARE}/s/${esc(r.hash)}">${anteprima(r, false, fiducia(r))}<span class="testi"><span class="col"><h3 class="t"${attrLingua(r)}>${esc(t)}</h3>${
    r.is_official === true ? `<span class="autore">${pallino("Fluera", "p24")}Fluera</span>` : ""
  }${voto !== null ? stelle(voto, numero(r.voti)) : ""}${dopoIlTitolo([nomeFiducia(r)])}</span><span class="tondo" aria-hidden="true">${ic("arrow")}</span></span></a></li>`;
}

/// Il banner (_InkfolioFeaturedHero, MS:2358-2810): il primo In evidenza, con
/// la palette OPPOSTA a quella della pagina. È il LCP dell'indice.
function bannerEvidenza(r: SemeWeb): string {
  const t = (r.title ?? "").trim() || "Senza titolo";
  const img = r.thumb_path ? publicUrl(r.thumb_path) : r.og_path ? publicUrl(r.og_path) : null;
  const voto = numero(r.voto_medio);
  const n = numero(r.concept_count);
  const riga = voto !== null
    ? stelle(voto, numero(r.voti), "grandi")
    : n !== null && n > 0
    ? `<span class="e-conc">${ic("hub")}${concetti(n)}</span>`
    : "<span></span>";
  return `<div class="eroe"><a class="eroe-a" href="${SHARE}/s/${esc(r.hash)}"><span class="e-testi"><span class="occhiello">Selezionati dal team Fluera</span><h3${attrLingua(r)}>${esc(t)}</h3>${
    r.is_official === true ? `<span class="e-autore"><span class="e-pal" aria-hidden="true">F</span>Fluera</span>` : ""
  }</span><span class="e-img"><span class="e-foglio">${
    img
      ? `<img src="${esc(img)}" alt="" width="400" height="300" fetchpriority="high" decoding="async" />`
      : `<span class="rigatura">${ic(categoriaDi(r.category)?.[1] ?? "menu_book", "cat")}</span>`
  }</span></span><span class="e-voto">${riga}<span class="tondo grande" aria-hidden="true">${ic("arrow")}</span></span></a></div>`;
}

/// Intestazione di sezione (MS:1975-2059). «Vedi tutti» verso un ordine è
/// nofollow: quelle pagine sono duplicati della base. Come nell'app icona e
/// titolo stanno in una riga e il sottotitolo sotto, dal margine: rientrato
/// sotto il titolo andava a capo sul telefono.
function intestazione(
  id: string,
  icona: string,
  titolo: string,
  sotto: string | null,
  vedi?: { href: string; nofollow: boolean },
): string {
  return `<div class="sez-testa"><div><div class="riga">${ic(icona)}<h2 id="${id}">${esc(titolo)}</h2></div>${sotto ? `<p>${esc(sotto)}</p>` : ""}</div>${
    vedi ? `<a class="vedi" href="${esc(vedi.href)}"${vedi.nofollow ? ` rel="nofollow"` : ""}>Vedi tutti${ic("chevron")}</a>` : ""
  }</div>`;
}

/// Una striscia orizzontale che si scorre anche con le frecce della tastiera.
const striscia = (titolo: string, schede: string, classe = "") =>
  `<div class="striscia${classe ? ` ${classe}` : ""}" role="region" aria-label="${esc(titolo)}" tabindex="0"><ul>${schede}</ul></div>`;

/// Le materie che hanno un elenco, nell'ordine di list_web_hubs.
const materieDi = (hubs: HubWeb[]) =>
  [...new Set(hubs.filter((x) => x.corso_slug === null).map((x) => x.materia_slug))];

/// I chip delle MATERIE al posto dei chip categoria dell'app: sul web oggi
/// ogni pack è «study», e la materia è il percorso. Link normali verso pagine
/// indicizzabili; nella ricerca portano la ricerca con la materia.
function chipMaterie(lingua: string, hubs: HubWeb[], attuale: string | null, q: string | null, ordine: Ordine = "consigliati"): string {
  const href = (k: string | null) => {
    if (q === null) return urlElenco(lingua, k);
    const p = new URLSearchParams({ q });
    if (k) p.set("materia", slugMateria(lingua, k));
    if (ordine !== "consigliati") p.set("ordine", ordine);
    return `${urlElenco(lingua)}cerca?${p}`;
  };
  const voce = (k: string | null, nome: string) =>
    `<li><a class="chip" href="${esc(href(k))}"${attuale === k ? ` aria-current="page"` : ""}>${k ? ic(iconaMateria(k)) : ""}<span${
      k ? langElenco(lingua) : ""
    }>${esc(nome)}</span></a></li>`;
  return `<nav class="chips" aria-label="Materie"><ul>${voce(null, "Tutte")}${
    materieDi(hubs).map((k) => voce(k, nomeMateria(hubs, k))).join("")
  }</ul></nav>`;
}

/// La faccetta «Tutti i corsi ▾» (MS:1791-1829): un <details> con link veri.
/// Nell'indice i corsi stanno sotto il nome della loro materia.
function faccettaCorso(lingua: string, hubs: HubWeb[], materia: string | null, corso: string | null): string {
  const corsi = hubs.filter((h) => h.corso_slug !== null && (materia === null || h.materia_slug === materia));
  if (corsi.length === 0) return "";
  const nomeC = (h: HubWeb) => (h.corso ?? "").trim() || (h.corso_slug ?? "");
  const voce = (h: HubWeb) =>
    `<li><a href="${urlElenco(lingua, h.materia_slug, h.corso_slug)}"${
      h.materia_slug === materia && h.corso_slug === corso ? ` aria-current="page"` : ""
    }${langElenco(lingua)}>${esc(nomeC(h))}<span class="conta">(${Math.max(0, Number(h.n) || 0)})</span></a></li>`;
  const attivo = corso ? corsi.find((h) => h.corso_slug === corso) : undefined;
  const menu = materia
    ? `<li><a href="${urlElenco(lingua, materia)}"${corso ? "" : ` aria-current="page"`}>Tutti i corsi</a></li><li role="separator"></li>${corsi.map(voce).join("")}`
    : materieDi(hubs).map((k) => {
      const suoi = corsi.filter((h) => h.materia_slug === k);
      return suoi.length ? `<li class="gruppo"${langElenco(lingua)}>${esc(nomeMateria(hubs, k))}</li>${suoi.map(voce).join("")}` : "";
    }).join("");
  return `<details class="menu-a faccetta${attivo ? " attiva" : ""}"><summary>${ic("school")}<span>${esc(attivo ? nomeC(attivo) : "Tutti i corsi")}</span>${
    ic("drop")
  }</summary><ul class="menu" role="list">${menu}</ul></details>`;
}

/// «Ordina»: quattro link, e solo la griglia si riordina. Nella ricerca `resto`
/// porta q e materia, come nell'app dove l'ordine vale anche cercando.
function menuOrdina(base: string, ordine: Ordine, resto?: URLSearchParams): string {
  const href = (o: Ordine) => {
    const q = new URLSearchParams(resto);
    if (o !== "consigliati") q.set("ordine", o);
    return `${base}${q.size ? `?${q}` : ""}`;
  };
  const voci = ORDINI.map(([o, nome, nota]) =>
    `<li><a href="${esc(href(o))}#tutti"${o === ordine ? ` aria-current="true"` : ""}${
      o === "consigliati" ? "" : ` rel="nofollow"`
    }>${nome}${nota ? `<small>${nota}</small>` : ""}</a></li>`
  ).join("");
  const attuale = ORDINI.find(([o]) => o === ordine)?.[1] ?? "Consigliati";
  return `<details class="menu-a ordina"><summary aria-label="Ordina: ${attuale}">${ic("sort")}<span>${attuale}</span>${
    ic("drop")
  }</summary><ul class="menu" role="list">${voci}</ul></details>`;
}

/// Il canonical di un elenco: un ordine è la stessa pagina riordinata, quindi
/// punta alla base senza ordine né pagina (e senza noindex: segnali in
/// conflitto che Google sconsiglia).
function canonico(base: string, pagina: number, ordine: Ordine): string {
  if (ordine !== "consigliati") return base;
  return pagina > 1 ? `${base}?pagina=${pagina}` : base;
}

/// Pagine vere al posto dello scroll infinito. Dentro un ordine i link sono
/// nofollow; la pagina 1 non porta ?pagina=1.
function navPagine(base: string, pagina: number, pagine: number, ordine: Ordine): string {
  if (pagine <= 1) return "";
  const url = (n: number) => {
    const q = new URLSearchParams();
    if (ordine !== "consigliati") q.set("ordine", ordine);
    if (n > 1) q.set("pagina", String(n));
    return `${base}${q.size ? `?${q}` : ""}`;
  };
  const nf = ordine === "consigliati" ? "" : " nofollow";
  const numeri = [...new Set([1, pagina - 1, pagina, pagina + 1, pagine])].filter((n) => n >= 1 && n <= pagine).sort((a, b) => a - b);
  const voci: string[] = [];
  numeri.forEach((n, i) => {
    if (i > 0 && n - numeri[i - 1] > 1) voci.push(`<span class="salto" aria-hidden="true">…</span>`);
    voci.push(
      n === pagina
        ? `<span aria-current="page">${n}</span>`
        : `<a href="${esc(url(n))}"${nf ? ` rel="nofollow"` : ""} aria-label="Pagina ${n}">${n}</a>`,
    );
  });
  return `<nav class="pagine" aria-label="Pagine">${
    pagina > 1 ? `<a class="lato" href="${esc(url(pagina - 1))}" rel="prev${nf}">${ic("chevron_l")}Pagina precedente</a>` : ""
  }${voci.join("")}${
    pagina < pagine ? `<a class="lato" href="${esc(url(pagina + 1))}" rel="next${nf}">Pagina successiva${ic("chevron")}</a>` : ""
  }</nav>`;
}

/// La ricerca in cima (ARB:3500). Con una materia, si cerca dentro la materia.
function formCerca(lingua: string, q = "", materia: string | null = null, ordine: Ordine = "consigliati"): string {
  return `<form class="cerca" action="${urlElenco(lingua)}cerca" method="get" role="search">${ic("search", "lente")}<input type="search" name="q" value="${
    esc(q)
  }" minlength="2" maxlength="80" placeholder="Cerca template di studio…" aria-label="Cerca template di studio" enterkeyhint="search" />${
    materia ? `<input type="hidden" name="materia" value="${esc(slugMateria(lingua, materia))}" />` : ""
  }${ordine !== "consigliati" ? `<input type="hidden" name="ordine" value="${ordine}" />` : ""}<button type="submit" aria-label="Cerca">${ic("arrow")}</button></form>`;
}

/// La fascia d'apertura (§ + titolo + stanghetta gialla + sottotitolo).
const fascia = (titoloHtml: string, sotto: string) =>
  `<div class="fascia"><span class="par" aria-hidden="true">§</span><div><h1>${titoloHtml}</h1><span class="stanghetta" aria-hidden="true"></span><p>${
    esc(sotto)
  }</p></div></div>`;

/// Uno stato vuoto come MW:2087-2238.
function statoVuoto(
  icona: string,
  titolo: string,
  testo: string,
  azione: { testo: string; href: string } | null,
  livello: 1 | 2 = 2,
): string {
  return `<div class="vuoto"><span class="cerchio">${ic(icona)}</span><h${livello}>${esc(titolo)}</h${livello}><p>${esc(testo)}</p>${
    azione ? `<a class="btn-tono" href="${esc(azione.href)}">${esc(azione.testo)}</a>` : ""
  }</div>`;
}

/// «Tutti i template»: la griglia e le pagine. Le prime 5 immagini senza lazy
/// solo dove la griglia sta in cima (`inCima`): nell'indice con le vetrine sta
/// sotto quattro strisce, e scaricarle subito rubava banda al banner.
function sezioneTutti(semi: SemeWeb[], nav: string, titolo = "Tutti i template", inCima = true): string {
  return `<section class="sez" id="tutti" aria-labelledby="t-tutti">${intestazione("t-tutti", "grid", titolo, null)}<ul class="griglia">${
    semi.map((r, i) => schedaSeme(r, true, inCima && i < 5)).join("")
  }</ul>${nav}</section>`;
}

/// «Materie e corsi»: ogni elenco con un link, senza aprire un menu. Dopo la
/// griglia, in piccolo, così non pesa sull'aspetto dell'app.
function mappaCorsi(lingua: string, hubs: HubWeb[]): string {
  const la = langElenco(lingua);
  const voci = materieDi(hubs).map((k) => {
    const corsi = hubs.filter((x) => x.materia_slug === k && x.corso_slug !== null)
      .map((x) => `<li><a href="${urlElenco(lingua, k, x.corso_slug)}"${la}>${esc((x.corso ?? "").trim() || (x.corso_slug ?? ""))}</a></li>`)
      .join("");
    return `<li><a class="m" href="${urlElenco(lingua, k)}"${la}>${esc(nomeMateria(hubs, k))}</a>${corsi ? `<ul>${corsi}</ul>` : ""}</li>`;
  }).join("");
  return voci ? `<section class="mappa" aria-labelledby="t-mappa"><h2 id="t-mappa">Materie e corsi</h2><ul>${voci}</ul></section>` : "";
}

/// I menu <details> funzionano da soli; questo li chiude con Esc o con un
/// clic fuori. Solo comodità: senza script la pagina funziona uguale.
/// Porta anche in vista il chip o la scheda che prende il focus: Chromium non
/// fa scorrere una fila se l'elemento è visibile anche solo in parte.
/// Le schede delle strisce, se non stanno intere con l'anello (5 px), vanno a
/// «start»: con «nearest» lo scroll-snap (mandatory, start) le riportava
/// indietro e a 320 px una scheda su due restava tagliata di 11 px a destra.
/// Se stanno già intere non si muove niente (su desktop la fila sta ferma).
/// Il focus da TASTIERA dentro una striscia o una fila di chip: porta la
/// scheda intera in vista. Solo con :focus-visible — Chromium dà il focus al
/// link già al mousedown/touchstart: far scorrere lì spostava la striscia
/// sotto il dito, il rilascio cadeva su un'altra scheda e il clic non apriva
/// niente (misurato a 320 px, 25/09/2026). Serve anche sulla /s/, che ha la
/// striscia «Ti potrebbero interessare».
const FOCUS_STRISCIA = `document.addEventListener("focusin",function(e){var t=e.target,s=t.closest(".striscia"),a,b;if(!t.matches(":focus-visible"))return;if(s&&t.tagName==="A"){a=t.getBoundingClientRect();b=s.getBoundingClientRect();t.scrollIntoView({block:"nearest",inline:a.left-5<b.left||a.right+5>b.right?"start":"nearest"})}else t.closest(".chips a")&&t.scrollIntoView({block:"nearest",inline:"nearest"})});`;
const AIUTO_MENU = `<script>(function(){var D=document,d=D.querySelectorAll("details.menu-a"),o=D.addEventListener.bind(D);function c(e){for(var i=0;i<d.length;i++)if(!e||!d[i].contains(e.target))d[i].removeAttribute("open")}o("click",c);o("keydown",function(e){e.key==="Escape"&&c()});${FOCUS_STRISCIA}})();</script>`;
const AIUTO_STRISCIA = `<script>${FOCUS_STRISCIA}</script>`;

function jsonLdElenco(
  briciole: Array<{ nome: string; url: string }>,
  pagina: { nome: string; descrizione: string; url: string; lingua: string },
  voci: Array<{ nome: string; url: string; posizione: number }>,
): unknown {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BreadcrumbList",
        itemListElement: briciole.map((b, i) => ({ "@type": "ListItem", position: i + 1, name: b.nome, item: b.url })),
      },
      {
        "@type": "CollectionPage",
        name: pagina.nome,
        description: pagina.descrizione,
        url: pagina.url,
        inLanguage: pagina.lingua,
        publisher: { "@type": "Organization", name: "Fluera", url: SITE },
        mainEntity: {
          "@type": "ItemList",
          itemListElement: voci.map((v) => ({ "@type": "ListItem", position: v.posizione, name: v.nome, url: v.url })),
        },
      },
    ],
  };
}

/// L'involucro di ogni pagina degli elenchi. Il noindex (meta e header) e il
/// JSON-LD dipendono da UN parametro: dati strutturati solo dove Google entra.
function paginaWeb(p: {
  lingua: string;
  titolo: string;
  descrizione: string;
  self: string | null;
  siIndicizza: boolean;
  jsonLd?: unknown;
  corpo: string;
  suIndice?: boolean;
}): Response {
  const dentro = `${testata(urlElenco(p.lingua), p.suIndice)}
  <main class="in cat">
    ${p.corpo}
  </main>
  ${piede()}`;
  const body = `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />${p.siIndicizza ? "" : `\n  <meta name="robots" content="noindex" />`}
  <title>${esc(p.titolo)}</title>
  <meta name="description" content="${esc(p.descrizione)}" />${p.self ? `\n  <link rel="canonical" href="${esc(p.self)}" />\n  <meta property="og:url" content="${esc(p.self)}" />` : ""}
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Fluera" />
  <meta property="og:title" content="${esc(p.titolo)}" />
  <meta property="og:description" content="${esc(p.descrizione)}" />
  <meta property="og:image" content="${esc(OG_FALLBACK)}" />
  <meta name="twitter:card" content="summary_large_image" />${
    p.siIndicizza && p.jsonLd ? `\n  <script type="application/ld+json">${jsonPerScript(p.jsonLd)}</script>` : ""
  }${testaWeb(STILE_CATALOGO)}
</head>
<body>
  ${spriteIcone(dentro)}${dentro}
  ${AIUTO_MENU}
</body>
</html>`;
  return paginaSeme(body, p.siIndicizza);
}

/// p_ordine si manda solo quando non è la base: così share nuovo regge anche
/// su un database prima della 218 (la firma a 5 argomenti).
const conOrdine = (o: Ordine) => (o === "consigliati" ? {} : { p_ordine: o });

/// Le vetrine dell'indice, con i testi dell'app. «Vedi tutti» porta alla
/// griglia della stessa pagina con l'ordine giusto; In evidenza non ce l'ha.
const VETRINE: Record<string, { titolo: string; sotto: string; icona: string; vedi: Ordine | null }> = {
  in_evidenza: { titolo: "In evidenza", sotto: "Selezionati dal team Fluera", icona: "auto_awesome", vedi: null },
  piu_efficaci: { titolo: "Provati efficaci", sotto: "Template che aumentano davvero la ritenzione", icona: "premium", vedi: "efficaci" },
  di_tendenza: { titolo: "Di tendenza", sotto: "Popolari tra chi studia questa settimana", icona: "trending", vedi: "consigliati" },
  novita: { titolo: "Novità", sotto: "Appena pubblicati", icona: "schedule", vedi: "recenti" },
};
type Vetrina = { nome: string; righe: VetrinaWeb[] };

/// Le vetrine nell'ordine in cui la 218 le restituisce, ognuna per posto.
/// Quali escono (e da quante schede) lo decide solo il database.
function vetrineDi(rows: VetrinaWeb[]): Vetrina[] {
  const valide = rows.filter((r) => r && typeof r.hash === "string" && HASH_INTERO_RE.test(r.hash));
  return [...new Set(valide.map((r) => r.vetrina))]
    .filter((n) => typeof n === "string" && Object.hasOwn(VETRINE, n))
    .map((nome) => ({
      nome,
      righe: valide.filter((r) => r.vetrina === nome).sort((a, b) => (Number(a.posto) || 0) - (Number(b.posto) || 0)),
    }));
}

function sezioneVetrina(self: string, v: Vetrina): string {
  const d = VETRINE[v.nome];
  const id = `t-${v.nome.replace(/_/g, "-")}`;
  const vedi = d.vedi === null
    ? undefined
    : d.vedi === "consigliati"
    ? { href: `${self}#tutti`, nofollow: false }
    : { href: `${self}?ordine=${d.vedi}#tutti`, nofollow: true };
  const testa = intestazione(id, d.icona, d.titolo, d.sotto, vedi);
  if (v.nome === "in_evidenza") {
    const [primo, ...altri] = v.righe;
    return `<section class="sez vetrina" data-vetrina="in_evidenza" aria-labelledby="${id}">${testa}${bannerEvidenza(primo)}${
      altri.length ? striscia(d.titolo, altri.map(schedaEvidenza).join(""), "evid") : ""
    }</section>`;
  }
  return `<section class="sez vetrina" data-vetrina="${esc(v.nome)}" aria-labelledby="${id}">${testa}${
    striscia(d.titolo, v.righe.map((r) => schedaSeme(r, false)).join(""))
  }</section>`;
}

/// /{lingua}/appunti/ — la vetrina dell'app: fascia, In evidenza, Provati
/// efficaci, Di tendenza, Novità, poi «Tutti i template» a pagine vere e
/// «Materie e corsi». L'indice italiano esiste sempre (in beta dice la
/// verità: i primi pack arrivano), ma resta fuori da Google finché non c'è un
/// elenco. Le altre lingue nascono col loro primo elenco.
async function paginaIndice(lingua: string, pagina: number, ordine: Ordine): Promise<Response> {
  const offset = (pagina - 1) * SEMI_PER_PAGINA;
  if (offset > OFFSET_MAX) return nonTrovata();
  const [h, s, v] = await Promise.all([
    rpcWeb<HubWeb>("list_web_hubs", { p_lingua: lingua }),
    rpcWeb<SemeWeb>("list_web_seeds", { p_lingua: lingua, p_limit: SEMI_PER_PAGINA, p_offset: offset, ...conOrdine(ordine) }),
    // Le strisce sono un arricchimento della prima pagina: tetto di tempo, e
    // un guasto le toglie e basta.
    pagina === 1
      ? rpcWeb<VetrinaWeb>("list_web_vetrine", { p_lingua: lingua, p_per_vetrina: 12 }, 1500)
      : Promise.resolve<EsitoRpc<VetrinaWeb>>({ ok: true, rows: [] }),
  ]);
  if (!h.ok) return rispostaGuasto(`list_web_hubs(${lingua}): ${h.motivo}`);
  const hubs = hubValidi(h.rows);
  if (hubs.length === 0 && (lingua !== "it" || pagina > 1)) return nonTrovata();
  const self = urlElenco(lingua);
  const descrizione = "Pack di appunti divisi per materia, da aprire in Fluera: un canvas per imparare, dove ci scrivi sopra a mano.";
  if (hubs.length === 0) {
    return paginaWeb({
      lingua,
      titolo: "Template di studio e appunti per materia · Fluera",
      descrizione,
      self,
      siIndicizza: false,
      suIndice: true,
      corpo: statoVuoto("eco", "Ancora nessun template", "I pack di studio arrivano presto. Torna a trovarci!", { testo: "Scopri Fluera", href: SITE }, 1),
    });
  }
  if (!s.ok) return rispostaGuasto(`list_web_seeds(${lingua}): ${s.motivo}`);
  if (!v.ok) console.error(`vetrine di ${lingua}: ${v.motivo}`);
  const semi = semiValidi(s.rows);
  if (pagina > 1 && semi.length === 0) return nonTrovata();
  const totale = Math.max(Number(s.rows[0]?.totale ?? 0) || 0, offset + semi.length);
  const pagine = Math.max(1, Math.ceil(totale / SEMI_PER_PAGINA));
  const vetrine = v.ok ? vetrineDi(v.rows) : [];
  // Il testo della fascia dice chi c'è davvero: finché ogni scheda è
  // ufficiale, «dal team Fluera»; dalla F3, con gli studenti, quello dell'app.
  const soloFluera = [...semi, ...vetrine.flatMap((x) => x.righe)].every((r) => r.is_official !== false);
  const self2 = canonico(self, pagina, ordine);
  return paginaWeb({
    lingua,
    titolo: `Template di studio e appunti per materia${pagina > 1 ? ` · pagina ${pagina}` : ""} · Fluera`,
    descrizione,
    self: self2,
    siIndicizza: true,
    suIndice: true,
    jsonLd: ordine === "consigliati"
      ? jsonLdElenco(
        [{ nome: "Fluera", url: SITE }, { nome: "Appunti", url: self }],
        { nome: "Template di studio e appunti per materia", descrizione, url: self2, lingua },
        semi.map((r, i) => ({ nome: titoloSeme(r.title), url: `${SHARE}/s/${r.hash}`, posizione: offset + i + 1 })),
      )
      : undefined,
    corpo: `${formCerca(lingua)}
    <div class="filtri">${chipMaterie(lingua, hubs, null, null)}${faccettaCorso(lingua, hubs, null, null)}${menuOrdina(self, ordine)}</div>
    ${
      fascia(
        soloFluera ? "Template di studio dal team Fluera" : "Template di studio dalla community",
        soloFluera ? "Appunti scritti a mano, gratis da installare in Fluera." : "Appunti scritti a mano da chi studia, gratis da installare.",
      )
    }
    ${vetrine.map((x) => sezioneVetrina(self, x)).join("\n    ")}
    ${sezioneTutti(semi, navPagine(self, pagina, pagine, ordine), undefined, vetrine.length === 0)}
    ${mappaCorsi(lingua, hubs)}`,
  });
}

/// /{lingua}/appunti/{materia}/[{corso}/] — un elenco sopra soglia, o 404.
/// È la vetrina filtrata dell'app (solo la griglia), più il titolo e il testo
/// che servono a Google.
async function paginaElenco(
  lingua: string,
  materia: string,
  corso: string | null,
  pagina: number,
  ordine: Ordine,
): Promise<Response> {
  const offset = (pagina - 1) * SEMI_PER_PAGINA;
  if (offset > OFFSET_MAX) return nonTrovata();
  const [h, s] = await Promise.all([
    rpcWeb<HubWeb>("list_web_hubs", { p_lingua: lingua }),
    rpcWeb<SemeWeb>("list_web_seeds", {
      p_lingua: lingua,
      p_materia_slug: materia,
      p_corso_slug: corso,
      p_limit: SEMI_PER_PAGINA,
      p_offset: offset,
      ...conOrdine(ordine),
    }),
  ]);
  if (!h.ok) return rispostaGuasto(`list_web_hubs(${lingua}): ${h.motivo}`);
  if (!s.ok) return rispostaGuasto(`list_web_seeds(${lingua}/${materia}/${corso ?? ""}): ${s.motivo}`);
  const hubs = hubValidi(h.rows);
  const semi = semiValidi(s.rows);
  // Sotto soglia = 404, non 410: l'elenco può nascere domani.
  const hub = hubs.find((x) => x.materia_slug === materia && x.corso_slug === corso);
  if (!hub) return nonTrovata();
  if (pagina > 1 && semi.length === 0) return nonTrovata();

  const totale = Math.max(Number(s.rows[0]?.totale ?? 0) || 0, offset + semi.length);
  const pagine = Math.max(1, Math.ceil(totale / SEMI_PER_PAGINA));
  const la = langElenco(lingua);
  const nomeM = nomeMateria(hubs, materia);
  const nomeC = corso ? (hub.corso ?? "").trim() || corso : null;
  const haMateria = hubs.some((x) => x.materia_slug === materia && x.corso_slug === null);
  const base = urlElenco(lingua, materia, corso);
  const self = canonico(base, pagina, ordine);
  const h1 = nomeC ?? nomeM;
  const titolo = `${nomeC ? `${nomeC} · Appunti di ${nomeM}` : `Appunti di ${nomeM}`}${pagina > 1 ? ` · pagina ${pagina}` : ""} · Fluera`;
  const descrizione = `Appunti di ${nomeC ? `${nomeC} (${nomeM})` : nomeM} da aprire in Fluera, un canvas per imparare: ci scrivi sopra a mano e li ripassi a libro chiuso.`;

  const briciole = [
    { nome: "Fluera", url: SITE },
    { nome: "Appunti", url: urlElenco(lingua) },
    ...(corso && !haMateria ? [] : [{ nome: nomeM, url: urlElenco(lingua, materia) }]),
    ...(corso && nomeC ? [{ nome: nomeC, url: base }] : []),
  ];
  // Le briciole visibili: «Appunti › Matematica [› Analisi 1]», l'ultima è
  // la pagina stessa.
  const navBriciole = briciole.slice(1)
    .map((b, i, a) => i === a.length - 1 ? `<span aria-current="page">${esc(b.nome)}</span>` : `<a href="${esc(b.url)}">${esc(b.nome)}</a>`)
    .join(`<span class="sep" aria-hidden="true">›</span>`);
  // L'introduzione scende SOTTO la griglia: la griglia si vede subito, come
  // nell'app, e il testo resta nella pagina per chi arriva da Google.
  const intro = !corso && pagina === 1 && lingua === "it" && MATERIE[materia]
    ? `<section class="lettura" aria-labelledby="t-lettura"><h2 id="t-lettura">Studiare ${esc(nomeM)} a mano</h2><p>${esc(MATERIE[materia].intro)}</p></section>`
    : "";
  const nomeH1 = corso || !la ? esc(h1) : `<span${la}>${esc(h1)}</span>`;

  return paginaWeb({
    lingua,
    titolo,
    descrizione,
    self,
    siIndicizza: true, // anche con ?ordine=: il canonical alla base basta
    jsonLd: ordine === "consigliati"
      ? jsonLdElenco(
        briciole,
        { nome: h1, descrizione, url: self, lingua },
        semi.map((r, i) => ({ nome: titoloSeme(r.title), url: `${SHARE}/s/${r.hash}`, posizione: offset + i + 1 })),
      )
      : undefined,
    corpo: `${navBriciole ? `<nav class="briciole" aria-label="Percorso">${navBriciole}</nav>` : ""}
    ${formCerca(lingua, "", materia)}
    <div class="filtri">${chipMaterie(lingua, hubs, materia, null)}${faccettaCorso(lingua, hubs, materia, corso)}${menuOrdina(base, ordine)}</div>
    ${fascia(`Appunti di ${nomeH1}`, `${totale} template di studio da aprire in Fluera.`)}
    ${sezioneTutti(semi, navPagine(base, pagina, pagine, ordine))}
    ${intro}`,
  });
}

/// Minuscolo e senza accenti: «Perché» si trova scrivendo «perche».
const perCercare = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

/// Tutti i semi indicizzabili di una lingua, fino a CERCA_MAX, nell'ordine
/// chiesto: lo fa il database, e il filtro della ricerca lo conserva.
async function semiDellaLingua(lingua: string, ordine: Ordine): Promise<EsitoRpc<SemeWeb>> {
  const primo = await rpcWeb<SemeWeb>("list_web_seeds", { p_lingua: lingua, p_limit: 100, p_offset: 0, ...conOrdine(ordine) });
  if (!primo.ok) return primo;
  const totale = Math.min(Number(primo.rows[0]?.totale ?? 0) || 0, CERCA_MAX);
  const altri = [];
  for (let off = 100; off < totale; off += 100) {
    altri.push(rpcWeb<SemeWeb>("list_web_seeds", { p_lingua: lingua, p_limit: 100, p_offset: off, ...conOrdine(ordine) }));
  }
  const rows = [...primo.rows];
  for (const e of await Promise.all(altri)) {
    if (!e.ok) return e;
    rows.push(...e.rows);
  }
  return { ok: true, rows: semiValidi(rows) };
}

/// /{lingua}/appunti/cerca?q= — sempre noindex (e Disallow in robots.txt):
/// ogni parola cercata sarebbe una pagina sottile. Cerca SOLO fra i semi
/// indicizzabili (list_web_seeds), nel titolo, nella descrizione, nel corso e
/// nel nome della materia.
async function paginaCerca(lingua: string, qRaw: string | null, materia: string | null, ordine: Ordine): Promise<Response> {
  // Gli elenchi servono ai chip delle materie, e dicono se la lingua (o la
  // materia chiesta) ha un catalogo.
  const h = await rpcWeb<HubWeb>("list_web_hubs", { p_lingua: lingua });
  if (!h.ok) return rispostaGuasto(`list_web_hubs(${lingua}): ${h.motivo}`);
  const hubs = hubValidi(h.rows);
  if (hubs.length === 0 && lingua !== "it") return nonTrovata();
  if (materia && !hubs.some((x) => x.materia_slug === materia && x.corso_slug === null)) return nonTrovata();
  const q = (qRaw ?? "").trim();
  const n = [...q].length;
  let esito = "";
  let sotto = "Cerca per titolo, corso o materia.";
  if (n > 0 && (n < 2 || n > 80)) {
    esito = statoVuoto("search", "Cerca template di studio", "Scrivi da due a ottanta caratteri.", null);
  } else if (n > 0) {
    const e = await semiDellaLingua(lingua, ordine);
    if (!e.ok) return rispostaGuasto(`ricerca (${lingua}): ${e.motivo}`);
    const parole = perCercare(q).split(/\s+/).filter(Boolean);
    const trovati = e.rows.filter((r) => {
      if (materia && r.materia_slug !== materia) return false;
      const testo = perCercare(
        [r.title, r.description, r.course, r.materia_slug ? MATERIE[r.materia_slug]?.it : null].filter(Boolean).join(" "),
      );
      return parole.every((p) => testo.includes(p));
    });
    sotto = trovati.length === 1 ? "1 template trovato." : `${trovati.length} template trovati.`;
    esito = trovati.length === 0
      ? statoVuoto("eco", `Nessun risultato per "${q}"`, "Prova con un'altra materia, o azzera i filtri per vedere tutto.", {
        testo: "Azzera filtri",
        href: urlElenco(lingua),
      })
      : sezioneTutti(
        trovati.slice(0, SEMI_PER_PAGINA),
        trovati.length > SEMI_PER_PAGINA ? `<p class="altri">Ci sono altri risultati: prova con una parola in più.</p>` : "",
        "Risultati",
      );
  }
  return paginaWeb({
    lingua,
    titolo: `${n ? `«${q}» · ` : ""}Cerca template di studio · Fluera`,
    descrizione: "Cerca fra i template di studio da aprire in Fluera.",
    self: null,
    siIndicizza: false, // la ricerca: mai su Google
    corpo: `<nav class="briciole" aria-label="Percorso"><a href="${urlElenco(lingua)}">Appunti</a><span class="sep" aria-hidden="true">›</span><span aria-current="page">Cerca</span></nav>
    ${formCerca(lingua, q, materia, ordine)}
    <div class="filtri">${chipMaterie(lingua, hubs, materia, q, ordine)}${
      menuOrdina(`${urlElenco(lingua)}cerca`, ordine, new URLSearchParams([["q", q], ...(materia ? [["materia", slugMateria(lingua, materia)]] : [])]))
    }</div>
    ${fascia(n ? `Risultati per «${esc(q)}»` : "Cerca template di studio", sotto)}
    ${esito}`,
  });
}

// ── Impronta del build (/.well-known/fluera-build) ──────────────────────────
// Lo sha256 dei BYTE del file in esecuzione, calcolato da crypto.subtle: per
// gli stessi byte è identico per costruzione a `sha256sum index.ts`. Se la
// piattaforma servisse il file riscritto (transpilato), l'impronta diverge e
// il cancello va ROSSO — mai un verde inventato. Una lettura per isolate; un
// fallimento non si memorizza, così la richiesta dopo ritenta.
type Impronta = { sha256: string | null; file: string; motivo?: string };
let _impronta: Promise<Impronta> | null = null;

async function calcolaImpronta(): Promise<Impronta> {
  const file = new URL(import.meta.url).pathname.split("/").pop() ?? "";
  try {
    const byte = await Deno.readFile(new URL(import.meta.url));
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", byte));
    return { sha256: Array.from(d, (b) => b.toString(16).padStart(2, "0")).join(""), file };
  } catch (e) {
    return { sha256: null, file, motivo: `lettura del sorgente fallita: ${e}` };
  }
}

async function improntaBuild(): Promise<Impronta> {
  _impronta ??= calcolaImpronta();
  const v = await _impronta;
  if (v.sha256 === null) _impronta = null;
  return v;
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
// Semi ed elenchi da list_web_sitemap (213): la stessa regola delle pagine,
// letta con la chiave ANON. Un guasto non deve mai restituire una sitemap
// VUOTA spacciata per valida — un urlset senza URL dice al motore «non ho
// niente», e deindicizza. Quindi su errore si risponde 503: il crawler
// ritenta, non conclude.
type RigaSitemap = { tipo: string; lingua: string | null; path: string; lastmod: string | null };
/// Il path di un elenco come lo scrive la 213 ('/{lingua}/{materia}[/{corso}]'):
/// la pagina vive sotto /{lingua}/appunti/…/.
const RE_PATH_HUB = /^\/([a-z]{2,3})\/([a-z]{2,20})(?:\/((?=[a-z0-9-]{1,60}$)[a-z0-9]+(?:-[a-z0-9]+)*))?$/;
const RE_PATH_SEME = new RegExp(`^/s/(${HASH_RE.source})$`);

async function sitemapResponse(): Promise<Response> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return new Response("sitemap unavailable", { status: 503 });
  }
  try {
    const e = await rpcWeb<RigaSitemap>("list_web_sitemap", {}, 8000);
    if (!e.ok) throw new Error(e.motivo);
    const giorno = (s: string | null) => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);
    const indici = new Map<string, string | null>();
    const voci: Array<{ loc: string; lastmod: string | null }> = [];
    for (const r of e.rows) {
      if (!r || typeof r.path !== "string") continue;
      const lm = giorno(r.lastmod);
      const hub = r.tipo === "hub" ? r.path.match(RE_PATH_HUB) : null;
      if (hub) {
        voci.push({ loc: urlElenco(hub[1], hub[2], hub[3]), lastmod: lm });
        // L'indice di una lingua è indicizzabile appena esiste un suo elenco.
        const prima = indici.get(hub[1]);
        indici.set(hub[1], prima === undefined || (lm && (!prima || lm > prima)) ? lm : prima);
      } else if (r.tipo === "seme" && RE_PATH_SEME.test(r.path)) {
        voci.push({ loc: `${SHARE}${r.path}`, lastmod: lm });
      }
    }
    const tutte = [...[...indici].map(([l, lm]) => ({ loc: urlElenco(l), lastmod: lm })), ...voci];
    // ⚠️ Zero righe = 503, come promette la 135 (righe 56-60): un urlset vuoto
    // dice al motore «non ho niente» e deindicizza. Fino al 2026-09-24 qui
    // usciva 200 vuoto (misurato dal vivo).
    if (tutte.length === 0) throw new Error("zero pagine indicizzabili");
    const urls = tutte
      .map((r) => {
        const lastmod = r.lastmod ? `\n    <lastmod>${esc(r.lastmod)}</lastmod>` : "";
        return `  <url>\n    <loc>${esc(r.loc)}</loc>${lastmod}\n  </url>`;
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
    const esito = await fetchTemplate(hash);
    const row = esito.tipo === "trovato" ? esito.row : null;
    // 🔞 Non-general: nessuna miniatura né titolo nemmeno nell'immagine —
    // solo il ripiego generico, come la pagina.
    if (row && row.content_maturity === "general") {
      baseUrl = row.og_path
        ? publicUrl(row.og_path)
        : row.thumb_path
        ? publicUrl(row.thumb_path)
        : OG_FALLBACK;
      // Il voto di una indicizzabile viene dalla lettura del web, come la
      // pagina: una sola regola (218), mai una soglia ricopiata qui.
      const scheda = indicizzabile(row) ? await fetchScheda(row.hash) : null;
      const png = await buildOgPng(row, baseUrl, scheda);
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
/// I numeri stampati nell'og.png, fuori da resvg perché il cancello li possa
/// leggere senza WASM. Niente install_count (gonfiabile, S7). Il voto come la
/// /s/: solo sulle indicizzabili e solo da get_web_scheda (0 righe = niente
/// voto); sulle noindex nessun voto.
export function ogNumeri(row: SeedRow, scheda: SchedaWeb | null = null): { stats: string; showStar: boolean } {
  const concepts = Math.max(0, row.concept_count ?? 0);
  const rating = indicizzabile(row) ? Math.max(0, numero(scheda?.voto_medio) ?? 0) : 0;
  const parts: string[] = [];
  if (rating > 0) parts.push(rating.toFixed(1));
  if (concepts > 0) parts.push(`${concepts} concett${concepts === 1 ? "o" : "i"}`);
  return { stats: parts.join("     ·     "), showStar: rating > 0 };
}

async function buildOgPng(
  row: SeedRow,
  baseUrl: string,
  scheda: SchedaWeb | null,
): Promise<Uint8Array<ArrayBuffer>> {
  const { Resvg, font } = await loadResvg();
  const imgBytes = new Uint8Array(await (await fetch(baseUrl)).arrayBuffer());
  const dataUri = `data:${mimeOf(imgBytes)};base64,${toBase64(imgBytes)}`;

  const title = truncate(
    (row.title ?? "Template di studio").trim() || "Template di studio",
    30,
  );
  const { stats, showStar } = ogNumeri(row, scheda);
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
function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

// ── Rendering ───────────────────────────────────────────────────────────────

/// JSON dentro un <script> inline: `JSON.stringify` da solo non basta, perché
/// una stringa con «</script>» chiuderebbe il tag. Si scappano «<», «>», «&»
/// e i due separatori di riga che i vecchi parser JS non accettano.
export function jsonPerScript(v: unknown): string {
  return JSON.stringify(v)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/// I link verso l'app e verso gli store di una pagina /s/, e lo script che
/// sceglie quello giusto NEL BROWSER.
///
/// 📱 PERCHÉ NEL BROWSER (S6, 2026-09-24): prima il server sceglieva dallo
/// user-agent, ma `html()` mette la pagina 120 s nella cache di bordo con
/// Vary solo su Accept-Language — la cache poteva servire la variante Android
/// a un computer, e a Google una pagina diversa da quella degli utenti. Ora
/// l'HTML è identico byte per byte per ogni user-agent.
///
/// 🏪 STORE CHIUSO (S8): come /get, /i, /p, /collab e /r, Play solo con
/// ANDROID_STORE_LIVE === "true", altrimenti /beta — Play oggi risponde 404.
///
/// Perché intent:// su Android: navigare verso l'URL della pagina stessa la
/// RICARICA soltanto, e su iOS gli Universal Links non scattano su una
/// navigazione nello stesso dominio. L'intent apre l'app se c'è (con questo
/// URL, ref compreso), altrimenti Chrome segue S.browser_fallback_url.
function collegamentiSeme(rowHash: string, ref: string) {
  const androidLive = (Deno.env.get("ANDROID_STORE_LIVE") ?? "") === "true";
  const referrer = `s=${rowHash}${ref ? `&ref=${ref}` : ""}`;
  const playUrl = androidLive
    ? `https://play.google.com/store/apps/details?id=${BUNDLE_ID}&referrer=${encodeURIComponent(referrer)}`
    : null;
  const iosFrag = `s=${rowHash}${ref ? `&ref=${encodeURIComponent(ref)}` : ""}`;
  const iosUrl = APPLE_APP_ID ? `https://apps.apple.com/app/id${APPLE_APP_ID}#${iosFrag}` : null;
  const refQ = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  // Il link che l'app riceve: porta il ref, perché l'attribuzione è sua.
  const appLink = `https://share.fluera.dev/s/${rowHash}${refQ}`;
  const androidIntent = `intent://share.fluera.dev/s/${rowHash}${refQ}#Intent;scheme=https;package=${BUNDLE_ID};S.browser_fallback_url=${
    encodeURIComponent(playUrl ?? `${SITE}/beta`)
  };end`;
  const script = `<script>
    (function () {
      var c = ${jsonPerScript({ android: androidIntent, ios: iosUrl, apri: "Apri in Fluera" })};
      var ua = navigator.userAgent || "";
      var a = document.getElementById("apri");
      if (!a) return;
      var h = /iphone|ipad|ipod/i.test(ua) ? c.ios : /android/i.test(ua) ? c.android : null;
      if (h) { a.setAttribute("href", h); a.textContent = c.apri; }
    })();
  </script>`;
  return { playUrl, iosUrl, appLink, script };
}

/// Il meta del banner di Safari: SOLO con un id vero. Prima usciva
/// «app-id=fluera», che non è un id App Store.
function metaAppleItunes(appLink: string): string {
  return APPLE_APP_ID
    ? `\n  <meta name="apple-itunes-app" content="app-id=${esc(APPLE_APP_ID)}, app-argument=${esc(appLink)}" />`
    : "";
}

/// og:image (S9): se la riga ha og_path, l'immagine nello Storage — senza far
/// girare resvg a ogni unfurl (Deno Deploy Free: 10 ore di CPU al mese).
/// Le dimensioni si dichiarano solo dove sono VERE: /s/{hash}/og.png compone
/// a 1200×630, e `<hash>-og.png` è il percorso che l'app carica dopo
/// `SeedThumbnailRenderer.renderOgImage` (1200×630 fissi). Un
/// `official/<hash>_og.png` viene da `publish_curated_seed.mjs --og`, cioè da
/// un file qualunque: lì niente dimensioni.
function ogImmagine(row: SeedRow): { url: string; dimensioni: boolean } {
  if (row.og_path) {
    return {
      url: publicUrl(row.og_path),
      dimensioni: /^[A-Za-z0-9]+-og\.png$/.test(row.og_path),
    };
  }
  return { url: `https://share.fluera.dev/s/${row.hash}/og.png`, dimensioni: true };
}

/// 🔞 La pagina di un seme NON general: risolve (un link non deve morire, 070)
/// ma non porta titolo, descrizione, immagine, autore né og specifici.
function renderPaginaRiservata(row: SeedRow, ref: string): string {
  const self = `https://share.fluera.dev/s/${row.hash}`;
  const l = collegamentiSeme(row.hash, ref);
  const title = "Contenuto disponibile nell'app";
  const desc = "Questo contenuto è disponibile nell'app Fluera.";
  return `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>${esc(title)} · Fluera</title>
  <meta name="description" content="${esc(desc)}" />
  <link rel="canonical" href="${esc(self)}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Fluera" />
  <meta property="og:url" content="${esc(self)}" />
  <meta property="og:title" content="Fluera" />
  <meta property="og:description" content="${esc(desc)}" />
  <meta property="og:image" content="${esc(OG_FALLBACK)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="Fluera" />
  <meta name="twitter:description" content="${esc(desc)}" />
  <meta name="twitter:image" content="${esc(OG_FALLBACK)}" />${metaAppleItunes(l.appLink)}${testaWeb(`
    .riservata{max-width:30rem;padding-top:clamp(24px,8vw,72px)}
    .riservata h1{font-size:clamp(1.75rem,9vw,3rem)}
    p.desc{margin:18px 0 32px;color:var(--muted);font-size:1.0625rem}
    .cta{display:flex;flex-direction:column;gap:12px}`)}
</head>
<body>
  ${testata()}
  <main class="in"><div class="riservata">
    <h1>${esc(title)}</h1>
    <p class="desc">Per vederlo apri il link in Fluera.</p>
    <div class="cta">
      <a class="btn primary" id="apri" href="${esc(SITE)}">Scopri Fluera</a>
      ${l.playUrl ? `<a class="btn ghost" href="${esc(l.playUrl)}">Google Play</a>` : `<a class="btn ghost" href="${esc(SITE)}/beta">Entra nella beta</a>`}
      ${l.iosUrl ? `<a class="btn ghost" href="${esc(l.iosUrl)}">App Store</a>` : ""}
    </div>
  </div></main>
  <footer class="piede"><div class="in"><a href="https://share.fluera.dev/report?hash=${esc(row.hash)}">Segnala questo contenuto</a></div></footer>
  ${l.script}
</body>
</html>`;
}

/// La lingua del contenuto di un seme come tag BCP 47 canonico, o null se
/// `locale` non è un tag valido.
/// ⚠️ È un'APPROSSIMAZIONE: dall'app `locale` è la lingua dell'INTERFACCIA di
/// chi pubblica (_study_seed.dart: Localizations.languageCode), non quella
/// degli appunti. Per i pack ufficiali — gli unici su Google — la dichiara chi
/// li pubblica (publish_curated_seed.mjs --locale).
export function linguaContenuto(row: { locale: string | null }): string | null {
  const l = (row.locale ?? "").trim();
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(l)) return null;
  try {
    return Intl.getCanonicalLocales(l)[0] ?? null;
  } catch {
    return null;
  }
}

/// ` lang="…"` per un blocco del seme, o "" quando è italiano come la pagina.
function attrLingua(row: { locale: string | null }): string {
  const l = linguaContenuto(row);
  return l && l.split("-")[0].toLowerCase() !== "it" ? ` lang="${esc(l)}"` : "";
}

/// 🧾 Dati strutturati (F1, 2026-09-24), SOLO per le pagine indicizzabili:
/// il chiamante decide, qui non si ricontrolla. Niente aggregateRating né
/// review: sono voti raccolti da noi sul nostro prodotto, cioè le recensioni
/// «auto-servite» che le regole di Google escludono dai risultati arricchiti.
/// jsonPerScript e non JSON.stringify: un titolo con «</script>» chiuderebbe
/// il tag e il resto diventerebbe HTML.
function jsonLdSeme(
  row: SeedRow,
  d: {
    self: string;
    title: string;
    description: string;
    image: string;
    briciole: Array<{ nome: string; url: string }>;
    materia: string | null;
    corso: string | null;
    scheda: SchedaWeb | null;
  },
): string {
  const tags = etichette(d.scheda);
  const dati = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BreadcrumbList",
        // Le briciole vere: Fluera › Appunti › Materia › Corso › titolo, solo
        // verso elenchi che esistono.
        itemListElement: [{ nome: "Fluera", url: SITE }, ...d.briciole, { nome: d.title, url: d.self }]
          .map((b, i) => ({ "@type": "ListItem", position: i + 1, name: b.nome, item: b.url })),
      },
      {
        "@type": "LearningResource",
        name: d.title,
        description: d.description,
        image: d.image,
        // La stessa scelta del lang dei blocchi: senza tag valido il contenuto
        // eredita lang="it" dalla pagina, e il markup dice lo stesso.
        inLanguage: linguaContenuto(row) ?? "it",
        url: d.self,
        isAccessibleForFree: (row.price_cents ?? 0) === 0,
        publisher: { "@type": "Organization", name: "Fluera", url: SITE },
        ...(d.materia ? { about: { "@type": "Thing", name: d.materia } } : {}),
        ...(tags.length ? { keywords: tags.join(", ") } : {}),
        ...(d.scheda?.created_at ? { dateCreated: d.scheda.created_at } : {}),
        ...(d.scheda?.updated_at ? { dateModified: d.scheda.updated_at } : {}),
        ...(d.corso ? { educationalLevel: d.corso } : {}),
      },
    ],
  };
  return `\n  <script type="application/ld+json">${jsonPerScript(dati)}</script>`;
}

/// Le etichette della scheda: la 218 le pulisce già (8, da 40 caratteri).
const etichette = (s: SchedaWeb | null): string[] =>
  Array.isArray(s?.tags) ? s.tags.filter((t): t is string => typeof t === "string" && t.trim() !== "").slice(0, 8) : [];

/// «Ti potrebbero interessare», «Tutti gli appunti di …» e il catalogo: solo
/// sulle indicizzabili.
function sezioneCorrelati(v: Vicini): string {
  const schede = v.correlati.map((r) => schedaSeme(r, false)).join("");
  const elenco = schede
    ? `<h2 id="t-correlati">Ti potrebbero interessare</h2>${striscia("Ti potrebbero interessare", schede)}`
    : "";
  const tutti = v.tutti ? `<p><a href="${esc(v.tutti.href)}">Tutti gli appunti di ${esc(v.tutti.nome)} →</a></p>` : "";
  return `<nav class="correlati" aria-label="Altri template">${elenco}<div class="link-el">${tutti}<p><a href="${
    esc(v.catalogo)
  }">Tutto il catalogo →</a></p></div></nav>`;
}

function renderPage(
  row: SeedRow,
  ref: string,
  vicini: Vicini,
  scheda: SchedaWeb | null,
): string {
  // S3: UN indirizzo, senza query. Il ref prima finiva qui dentro, e ogni
  // condivisione creava per Google una pagina diversa; ora vive solo nei link
  // verso l'app e gli store (collegamentiSeme) e nell'app-argument.
  const hash = row.hash;
  const self = `https://share.fluera.dev/s/${hash}`;
  const siIndicizza = indicizzabile(row);
  const og = ogImmagine(row);
  const l = collegamentiSeme(hash, ref);
  const title = (row.title ?? "Template di studio").trim() || "Template di studio";
  // Come l'app: «@» + 6 caratteri del codice (MW:179-207). Un autore non
  // ufficiale arriva solo su una /s/ noindex.
  const author = row.is_official ? "Fluera" : row.author_code ? `@${row.author_code.slice(0, 6)}` : "@anonimo";
  const concepts = Math.max(0, row.concept_count ?? 0);
  // S7: install_count MAI (si gonfia con chiamate anonime, 047). Sulle
  // indicizzabili voto ed efficacia arrivano da get_web_scheda, già sotto le
  // soglie della 218: 0 righe o un guasto = nessun numero, mai un ripiego su
  // get_study_seed. Sulle noindex nessun voto (25/09/2026): la regola «da 5
  // voti di account veri» vive solo nel database (220), e get_study_seed
  // conta anche gli anonimi.
  const voto = siIndicizza ? numero(scheda?.voto_medio) : null;
  const voti = siIndicizza ? numero(scheda?.voti) : null;
  const nConcetti = numero(scheda?.concept_count) ?? (concepts > 0 ? concepts : null);
  const eff = numero(scheda?.efficacia_pct);
  const effN = numero(scheda?.efficacia_studenti);
  const cat = categoriaDi(scheda?.category);
  const tags = etichette(scheda);
  // Tre stati (186): NULL = non dichiarato, e non si scrive niente.
  const ia = row.ai_generated === true;
  const lingua = attrLingua(row);
  // In pagina la pagina degli appunti (miniatura 3:4) quando c'è: la card og
  // ha il banner di un'altra grafica. Gli og:* restano quelli di ogImmagine.
  const foglio = row.thumb_path ? publicUrl(row.thumb_path) : null;

  // SOCIAL PROOF in the unfurl: crawlers render og:title / og:description but
  // NOT the chips below — so the live counts must be folded INTO those tags or
  // they never reach the chat-preview card. Build a compact proof prefix
  // (e.g. "★4,8 (12) · 5 concetti") and prepend it.
  const proofParts = [
    voto !== null ? `★${votoIt(voto)}${voti !== null ? ` (${numeroIt(voti)})` : ""}` : "",
    nConcetti !== null ? concetti(nConcetti) : "",
  ].filter(Boolean);
  const proof = proofParts.join(" · ");

  // Il nome della materia, mai la chiave grezza («math»): nel chip e nella
  // descrizione di ripiego, che finisce anche negli og e nel JSON-LD.
  const disciplina = nomeDisciplina(row.discipline);
  const disciplinaInFrase = disciplina && materiaDi(row.discipline) ? disciplina.toLowerCase() : disciplina;
  const baseDescription = (row.description ?? "").trim() ||
    `Un template di studio${disciplinaInFrase ? ` di ${disciplinaInFrase}` : ""} con ${concepts} concett${concepts === 1 ? "o" : "i"}. Installalo in Fluera e parte un ripasso programmato — il trapianto cognitivo nel tuo modello di studio.`;
  // og:* / twitter:* SOCIAL-PROOF-augmented strings (the card). On-page <title>
  // and the visible <p class="desc"> stay clean (chips already show the proof).
  const ogTitle = proof ? `${title} · ${proof}` : title;
  const ogDescription = proof ? `${proof} — ${baseDescription}` : baseDescription;
  const descrizione = (row.description ?? "").trim();
  const dove = vicini.corso ?? disciplina;

  const distintivo = row.is_official
    ? `<span class="distintivo uff">${ic("verified")}Ufficiale</span>`
    : scheda?.is_featured === true
    ? `<span class="distintivo evid">${ic("auto_awesome")}In evidenza</span>`
    : "";
  // --em: la parola più lunga della materia in em, perché il CSS scelga il
  // corpo che la tiene su una riga («Matemat / ica» a 320 px).
  const stileMateria = disciplina ? ` style="--em:${larghezzaEm(disciplina)}"` : "";
  const materiaV = disciplina
    ? vicini.hubMateria
      ? `<a class="v materia" href="${esc(vicini.hubMateria)}"${stileMateria}>${esc(disciplina)}</a>`
      : `<span class="v materia"${stileMateria}>${esc(disciplina)}</span>`
    : `<span class="v">—</span>`;
  // Il riquadro a tre caselle (TD:1139-1197) senza installazioni: il loro
  // posto va ai concetti veri (nell'app «1» fisso) e alla materia. Il numero
  // dei voti non è nell'etichetta, come nell'app: resta per il lettore di
  // schermo e al passaggio del mouse. «Compare da 5 voti» solo dove può
  // comparire: su una noindex sarebbe una promessa falsa.
  const nVoti = voti !== null ? `${voti} vot${voti === 1 ? "o" : "i"}` : null;
  const riquadro = `<div class="riquadro">
          <div class="cella"${nVoti ? ` title="${nVoti}"` : ""}>${ic("star")}<span class="v"${voto === null && siIndicizza ? ` title="Il voto compare da 5 voti"` : ""}>${
    voto !== null ? votoIt(voto) : "—"
  }</span><span class="e">Valutazione</span>${nVoti ? `<span class="vh">, ${nVoti}</span>` : ""}</div>
          <div class="cella">${ic("hub")}<span class="v">${nConcetti !== null ? esc(numeroIt(nConcetti)) : "—"}</span><span class="e">Concetti</span></div>
          <div class="cella">${ic(iconaMateria(materiaDi(row.discipline)))}${materiaV}<span class="e">Materia</span></div>
        </div>`;
  const briciole = vicini.briciole.map((b) => `<a href="${esc(b.url)}">${esc(b.nome)}</a>`).join(`<span class="sep" aria-hidden="true">›</span>`);

  const dentro = `${testata(vicini.catalogo)}
  <main class="in">
    ${briciole ? `<nav class="briciole" aria-label="Percorso">${briciole}</nav>` : ""}
    <div class="pack">
      <figure class="pack-img"><span class="foglio-g">${
    foglio
      ? `<img src="${esc(foglio)}" alt="${esc(title)}" width="600" height="800" fetchpriority="high" />`
      : `<span class="iniziale" aria-hidden="true">${esc([...title][0]?.toUpperCase() ?? "F")}</span>`
  }</span></figure>
      <div class="pack-info">
        <div class="titolo-riga"><h1${lingua}>${esc(title)}</h1>${distintivo}</div>
        ${ia ? `<span class="ia">Generato dall'IA</span>` : ""}
        <p class="di">${ic("person")}di ${esc(author)}</p>
        ${riquadro}
        ${
    eff !== null
      ? `<div class="eff"><span class="pillola">${ic("trending")}+${Math.round(eff)}% ritenzione</span>${
        effN !== null ? `<span>misurato su ${esc(numeroIt(effN))} studenti</span>` : ""
      }</div>`
      : ""
  }
        <div class="azioni">
          <a class="btn primary" id="apri" href="${esc(SITE)}">Scopri Fluera</a>
          ${l.playUrl ? `<a class="btn ghost" href="${esc(l.playUrl)}">Google Play</a>` : `<a class="btn ghost" href="${esc(SITE)}/beta">Entra nella beta</a>`}
          ${l.iosUrl ? `<a class="btn ghost" href="${esc(l.iosUrl)}">App Store</a>` : ""}
        </div>
        <p class="segnala-riga"><a class="segnala" href="https://share.fluera.dev/report?hash=${esc(hash)}">${ic("flag")}Segnala</a></p>
        ${
    cat || tags.length
      ? `<section class="blocco" aria-labelledby="t-argomenti"><h2 id="t-argomenti">Argomenti</h2><ul class="tag-l">${
        cat ? `<li class="tag cat">${ic(cat[1])}${esc(cat[0])}</li>` : ""
      }${tags.map((t) => `<li class="tag"${lingua}>${esc(t)}</li>`).join("")}</ul></section>`
      : ""
  }
        <section class="blocco" aria-labelledby="t-descrizione"><h2 id="t-descrizione">Descrizione</h2>${
    descrizione ? `<p class="desc"${lingua}>${esc(descrizione)}</p>` : `<p class="desc-vuota">Nessuna descrizione disponibile.</p>`
  }</section>
        <div class="nota">${ic("psychology_o")}<p>Aprendolo in Fluera, i concetti di questo template entrano nel tuo modello di studio, con un primo ripasso programmato per domani.</p></div>
      </div>${siIndicizza ? `\n      ${sezioneCorrelati(vicini)}` : ""}
    </div>
  </main>
  ${piede(hash)}`;

  return `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />${siIndicizza ? "" : `\n  <meta name="robots" content="noindex" />`}
  <title>${esc(title)}${dove ? ` · ${esc(dove)}` : ""} · Fluera</title>
  <meta name="description" content="${esc(ogDescription)}" />
  <link rel="canonical" href="${esc(self)}" />
  <meta property="og:type" content="article" />
  <meta property="og:site_name" content="Fluera" />
  <meta property="og:url" content="${esc(self)}" />
  <meta property="og:title" content="${esc(ogTitle)}" />
  <meta property="og:description" content="${esc(ogDescription)}" />
  <meta property="og:image" content="${esc(og.url)}" />${og.dimensioni ? `\n  <meta property="og:image:width" content="1200" />\n  <meta property="og:image:height" content="630" />` : ""}
  <meta property="og:image:alt" content="${esc(title)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(ogTitle)}" />
  <meta name="twitter:description" content="${esc(ogDescription)}" />
  <meta name="twitter:image" content="${esc(og.url)}" />${metaAppleItunes(l.appLink)}${
    siIndicizza
      ? jsonLdSeme(row, {
        self,
        title,
        description: baseDescription,
        image: og.url,
        briciole: vicini.briciole,
        materia: disciplina,
        corso: vicini.corso,
        scheda,
      })
      : ""
  }${testaWeb(STILE_CATALOGO + STILE_PACK)}
</head>
<body>
  ${spriteIcone(dentro)}${dentro}
  ${l.script}${siIndicizza && vicini.correlati.length ? `\n  ${AIUTO_STRISCIA}` : ""}
</body>
</html>`;
}

// ── Lo stile delle pagine pubbliche: /s/, pagina riservata, elenchi ─────────
// «Inkfolio», la grafica del catalogo dell'app (fluera_theme / marketplace_
// theme.dart): carta crema, inchiostro caldo, titoli in Instrument Serif, un
// solo accento blu e il giallo solo come decorazione. Da fluera.dev restano il
// marchio, la testata, il piede e l'accento. I colori dell'app sono variabili
// CSS, anche in scuro; i nomi di prima (--bg, --fg…) restano come alias. I
// caratteri arrivano da fluera.dev (CORS aperto); i ripieghi hanno le
// metriche misurate, così l'arrivo del font non sposta il testo. Solo CSS
// inline: share non serve file statici. Titoli e nomi arrivano dal database:
// overflow-wrap e colonne a minimo zero, così una parola lunga non allarga la
// pagina a 360 px.
const FONT_SITO = `${SITE}/fonts`;
const STILE_WEB =
  `@font-face{font-family:"Sora Fluera";src:url(${FONT_SITO}/Sora-Bold.woff2) format("woff2");font-weight:700;font-display:swap}` +
  `@font-face{font-family:"Playfair Fluera";src:url(${FONT_SITO}/PlayfairDisplay-SemiBoldItalic.woff2) format("woff2");font-style:italic;font-weight:600;font-display:swap}` +
  `@font-face{font-family:"Sora Fallback";src:local("Arial Bold"),local("Arial");font-weight:700;size-adjust:107.8%;ascent-override:90%;descent-override:26.9%;line-gap-override:0%}` +
  `@font-face{font-family:"Playfair Fallback";src:local("Georgia Italic"),local("Georgia");font-style:italic;font-weight:600;size-adjust:95.2%;ascent-override:113.7%;descent-override:26.4%;line-gap-override:0%}` +
  // Instrument Serif ha un solo peso: l'app chiede w600 (_serifStyle) e Flutter
  // lo ispessisce in sintesi. I titoli chiedono 600 e il browser fa lo stesso;
  // mai font-synthesis:none, o escono più sottili che nell'app.
  `@font-face{font-family:"Instrument Serif";src:url(${FONT_SITO}/InstrumentSerif-Regular.woff2) format("woff2");font-weight:400;font-display:swap;unicode-range:U+0000-024F,U+2000-206F,U+20AC,U+2190-2193}` +
  // Metriche misurate con fontTools (Instrument Serif contro Liberation
  // Serif, che ha quelle di Times New Roman).
  `@font-face{font-family:"Instrument Fallback";src:local("Times New Roman"),local("Liberation Serif");size-adjust:83.8%;ascent-override:118.1%;descent-override:37%;line-gap-override:0%}` +
  `@font-face{font-family:"Caveat Fluera";src:url(${FONT_SITO}/Caveat-Regular.woff2) format("woff2");font-weight:400;font-display:swap}
    :root{color-scheme:light dark;--carta:#FAF8F2;--carta-alta:#FFFFFF;--foglio:#FFFDF8;--lavata:#F7F3EB;--rialzo:#F1EBDD;--inchiostro:#23211B;--inchiostro-2:#6E6656;--accento:#2563EB;--accento-t:#2563EB;--accento-h:#1D4ED8;--accento-velo:#DCE6FB;--su-accento-velo:#16357A;--taupe:#EFE9DB;--filo:#E5DECE;--filo-2:#EFE8D9;--evidenziatore:#FFE55C;--stella-vuota:rgb(110 102 86/.8);--pal-sunset:#F0E1D7;--pal-sunset-t:#6E4A36;--pal-amber:#EEE6CF;--pal-amber-t:#5E4E2C;--pal-rose:#F0DFE2;--pal-rose-t:#6C3E48;--pal-grape:#E4DEEC;--pal-grape-t:#4C3F64;--serif:"Instrument Serif","Instrument Fallback",Georgia,"Times New Roman",serif;--mano:"Caveat Fluera",cursive;--sans:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;--bg:var(--carta);--sup:var(--foglio);--fg:var(--inchiostro);--forte:var(--inchiostro);--muted:var(--inchiostro-2);--dim:var(--inchiostro-2);--riga:var(--filo-2);--riga2:var(--filo);--acc:var(--accento-t);--btn:var(--accento);--btn-t:#FFFFFF;--btn-h:var(--accento-h);--img:var(--rialzo)}
    @media(prefers-color-scheme:dark){:root{--carta:#221E16;--carta-alta:#322C22;--foglio:#2A251C;--lavata:#302B21;--rialzo:#3A3327;--inchiostro:#F2ECE0;--inchiostro-2:#A79E8A;--accento-t:#A8C7FA;--accento-h:#3B74F0;--accento-velo:#1E3054;--su-accento-velo:#C7D9FF;--taupe:#322D22;--filo:#3D3629;--filo-2:#322D23;--stella-vuota:rgb(167 158 138/.7);--pal-sunset:#43342B;--pal-sunset-t:#E6C7B4;--pal-amber:#3F3825;--pal-amber-t:#E2CFA0;--pal-rose:#422E33;--pal-rose-t:#E6C0C8;--pal-grape:#362F44;--pal-grape-t:#CCC0E0}}
    *{box-sizing:border-box}
    html{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;-webkit-text-size-adjust:100%}
    body{margin:0;background:var(--carta);color:var(--inchiostro);font:16px/1.5 var(--sans);overflow-wrap:break-word}
    a{color:var(--accento-t);text-underline-offset:3px}
    .in{max-width:1168px;margin:0 auto;padding-inline:16px}
    .sprite{position:absolute;width:0;height:0;overflow:hidden}
    .ic{width:1em;height:1em;flex:none;fill:currentColor;vertical-align:middle}
    .vh{position:absolute!important;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
    .testata{border-bottom:1px solid var(--filo-2)}
    .testata .in{height:60px;display:flex;align-items:center;gap:16px}
    .marchio{display:inline-flex;align-items:baseline;margin-right:auto;direction:ltr;color:var(--inchiostro);text-decoration:none;font-size:1.125rem;line-height:1;white-space:nowrap}
    .marchio b{font-family:"Sora Fluera","Sora Fallback",system-ui,sans-serif;font-weight:700;letter-spacing:.052em}
    .marchio i{margin-inline-start:.02em;font-family:"Playfair Fluera","Playfair Fallback",Georgia,serif;font-weight:600;letter-spacing:.026em}
    .testata-nav{display:flex;align-items:center;gap:14px}
    .sez{font:14px/1 var(--sans);color:var(--inchiostro-2);text-decoration:none}
    .sez[aria-current]{color:var(--inchiostro);font-weight:600}
    a.sez:hover{color:var(--inchiostro);text-decoration:underline}
    .btn-beta{display:inline-flex;align-items:center;min-height:36px;padding:0 14px;border-radius:12px;background:var(--accento);color:#FFFFFF;font:600 14px/1 var(--sans);text-decoration:none;white-space:nowrap}
    .btn-beta:hover{background:var(--accento-h)}
    h1,h2,h3{margin:0;color:var(--inchiostro);font-family:var(--serif);font-weight:600;letter-spacing:0}
    h1{font-size:28px;line-height:1.12;text-wrap:balance;overflow-wrap:anywhere}
    :is(h1,h2,h3):is(:lang(ar),:lang(hi),:lang(ja),:lang(ko),:lang(zh)){font-family:var(--sans)}
    p,li{text-wrap:pretty}
    .btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:48px;padding:0 20px;border-radius:12px;font:600 16px/1.2 var(--sans);text-align:center;text-decoration:none;transition:background-color 120ms ease-out,border-color 120ms ease-out,transform 120ms ease-out}
    .btn.primary{background:var(--accento);color:#FFFFFF}
    .btn.primary:hover{background:var(--accento-h)}
    .btn.ghost{border:1px solid var(--filo);background:var(--carta);color:var(--inchiostro)}
    .btn.ghost:hover{border-color:var(--inchiostro-2)}
    :focus-visible{outline:2px solid var(--accento-t);outline-offset:3px}
    .piede{margin-top:64px;border-top:1px solid var(--filo-2);font:14px/1.4 var(--sans);color:var(--inchiostro-2)}
    .piede .in{display:flex;flex-wrap:wrap;gap:8px 24px;justify-content:space-between;align-items:center;padding-block:24px}
    .piede a{color:var(--inchiostro-2);text-decoration:none}
    .piede a:hover{color:var(--inchiostro);text-decoration:underline}
    .vuoto{max-width:480px;margin:48px auto 24px;padding:0 24px;text-align:center}
    .stato .vuoto{margin-top:120px}
    .vuoto .cerchio{display:grid;place-items:center;width:76px;height:76px;margin:0 auto 18px;border-radius:50%;background:var(--lavata);color:var(--inchiostro-2)}
    .vuoto .cerchio .ic{width:34px;height:34px}
    .vuoto h1,.vuoto h2{font-size:20px;line-height:1.25}
    .vuoto p{margin:8px 0 20px;font:14px/1.5 var(--sans);color:var(--inchiostro-2)}
    .btn-tono{display:inline-flex;align-items:center;min-height:44px;padding:0 20px;border-radius:12px;background:var(--accento-velo);color:var(--su-accento-velo);font:600 14px/1 var(--sans);text-decoration:none}
    @media(min-width:640px){.in{padding-inline:24px}}
    @media(prefers-reduced-motion:no-preference){.btn:active{transform:scale(.98)}}
    @media(prefers-reduced-motion:reduce){*{transition:none!important}}`;

/// Le schede, le strisce e i filtri degli elenchi (e di «Ti potrebbero
/// interessare» sulla /s/). Misure dell'app fino a 1023 px.
/// Sotto i 1024 «Ordina» scende accanto al corso: nella riga dei chip toglieva
/// spazio, e con tre materie la terza finiva tutta nella sfumatura.
/// La fila dei chip e le strisce hanno un margine negativo e un padding che
/// fanno posto all'anello del focus (2 + 3 px), che sborda e veniva tagliato. La
/// lista è max-content perché il padding destro di un contenitore più stretto
/// dei figli non entra nello scorrimento: a fine corsa l'ultimo chip restava
/// nella sfumatura e l'ultima scheda attaccata al bordo. Da 1024 px le colonne
/// delle strisce compatte sono un sesto del contenitore (cqi); le schede In
/// evidenza restano 260 come nell'app (a un terzo della colonna il foglio
/// diventava più alto del banner).
/// La cornice ha l'altezza della scheda dell'app (_PaperFramedThumb: Center +
/// AspectRatio in un Expanded): il foglio sta dentro, centrato, e ai lati
/// resta la carta; almeno 76 px, perché a 320 px (schede da 138) il foglio
/// scendeva a 40 px e distintivo e categoria si coprivano. Le stelle vuote sono a ≥ 3:1 sul fondo (WCAG 1.4.11): a
/// .45 erano 1,9:1 e in scuro quasi sparivano.
/// Il bordo della ricerca è il confine di un campo di testo: ≥ 3:1 contro la
/// pagina e contro il campo (WCAG 1.4.11). Con --filo-2 era 1,1:1; resta un
/// filo da 1 px, al 75% di --inchiostro-2 sulla carta (3,2:1 chiaro, 3,8:1 scuro).
const STILE_CATALOGO = `
    main.cat{padding-top:2px}
    nav.briciole{margin:14px 0 0;font:12px/1.5 var(--sans);color:var(--inchiostro-2)}
    nav.briciole a{color:inherit;text-decoration:none}
    nav.briciole a:hover{color:var(--inchiostro);text-decoration:underline}
    nav.briciole .sep{margin:0 6px}
    nav.briciole [aria-current]{color:var(--inchiostro)}
    form.cerca{position:relative;display:flex;align-items:center;height:52px;margin:14px 0 0;border:1px solid color-mix(in srgb,var(--inchiostro-2) 75%,var(--carta));border-radius:14px;background:var(--foglio)}
    form.cerca:focus-within{border-color:var(--accento-t);box-shadow:0 0 0 .5px var(--accento-t)}
    form.cerca .lente{position:absolute;left:16px;width:22px;height:22px;color:var(--inchiostro-2);pointer-events:none}
    form.cerca input{flex:1;min-width:0;height:100%;padding:0 4px 0 50px;border:0;background:none;color:var(--inchiostro);font:16px/1 var(--sans);outline:none}
    form.cerca input::placeholder{color:var(--inchiostro-2)}
    form.cerca button{display:grid;place-items:center;width:44px;height:44px;margin-right:4px;border:0;border-radius:12px;background:none;color:var(--inchiostro-2);cursor:pointer}
    form.cerca button .ic{width:22px;height:22px}
    form.cerca button:hover{background:var(--lavata);color:var(--inchiostro)}
    .filtri{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:10px 8px;margin-top:16px}
    nav.chips{grid-column:1/-1;min-width:0;overflow-x:auto;scrollbar-width:none;-webkit-mask-image:linear-gradient(to right,#000 calc(100% - 24px),transparent);mask-image:linear-gradient(to right,#000 calc(100% - 24px),transparent);margin:-4px 0 -4px -6px}
    nav.chips:focus-within{-webkit-mask-image:none;mask-image:none}
    nav.chips::-webkit-scrollbar{display:none}
    nav.chips ul{display:flex;gap:8px;box-sizing:border-box;width:max-content;min-width:100%;margin:0;padding:6px 24px 6px 6px;list-style:none}
    nav.chips a{scroll-margin-inline:24px}
    details.faccetta{grid-column:1;justify-self:start}
    details.ordina{grid-column:2}
    a.chip{display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 14px;border:1px solid var(--filo-2);border-radius:999px;background:var(--lavata);color:var(--inchiostro-2);font:600 13px/1 var(--sans);white-space:nowrap;text-decoration:none;transition:background-color 120ms ease-out}
    a.chip .ic{width:17px;height:17px}
    a.chip:hover{background:var(--rialzo)}
    a.chip[aria-current]{border-color:var(--accento-t);background:var(--accento);color:#FFFFFF;font-weight:700}
    details.menu-a{position:relative;flex:none}
    details.menu-a>summary{display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 8px 0 12px;border:1px solid var(--filo-2);border-radius:999px;background:var(--lavata);color:var(--inchiostro);font:600 12px/1 var(--sans);white-space:nowrap;list-style:none;cursor:pointer}
    details.menu-a>summary::-webkit-details-marker{display:none}
    details.menu-a>summary .ic{width:18px;height:18px;color:var(--inchiostro-2)}
    details.menu-a>summary:hover,details.menu-a[open]>summary{background:var(--rialzo)}
    details.faccetta.attiva>summary{border-color:var(--accento-t);background:var(--accento-velo);color:var(--su-accento-velo)}
    details.faccetta.attiva>summary .ic{color:var(--su-accento-velo)}
    .menu{position:absolute;z-index:20;top:calc(100% + 6px);right:0;width:max-content;min-width:220px;max-width:min(320px,calc(100vw - 32px));max-height:min(440px,70vh);overflow:auto;margin:0;padding:8px;list-style:none;border:1px solid var(--filo-2);border-radius:14px;background:var(--carta-alta);box-shadow:0 8px 24px rgb(0 0 0/.12)}
    details.faccetta .menu{right:auto;left:0}
    .menu a{display:flex;flex-direction:column;justify-content:center;gap:2px;min-height:40px;padding:6px 12px;border-radius:10px;color:var(--inchiostro);font:14px/1.3 var(--sans);text-decoration:none}
    details.faccetta .menu a{flex-direction:row;align-items:center;justify-content:flex-start}
    .menu a:hover{background:var(--lavata)}
    .menu a[aria-current]{color:var(--accento-t);font-weight:600}
    .menu small{color:var(--inchiostro-2);font-size:12px;font-weight:400}
    .menu .conta{margin-left:8px;color:var(--inchiostro-2);font-weight:400}
    .menu .gruppo{padding:10px 12px 4px;color:var(--inchiostro-2);font:600 11px/1.2 var(--sans);letter-spacing:.04em;text-transform:uppercase}
    .menu [role=separator]{height:1px;margin:6px 4px;background:var(--filo-2)}
    .fascia{display:flex;gap:10px;margin:22px 4px 4px}
    .fascia .par{padding-top:2px;color:var(--inchiostro-2);font:600 26px/1 var(--serif);opacity:.45}
    .fascia>div{min-width:0}
    .stanghetta{display:block;width:46px;height:6px;margin:10px 0 12px;border-radius:999px;background:var(--evidenziatore)}
    .fascia p{margin:0;color:var(--inchiostro-2);font:16px/1.45 var(--sans)}
    .sez-testa{display:flex;align-items:flex-end;gap:8px;margin:22px 0 10px}
    .sez-testa>div{flex:1;min-width:0}
    .sez-testa .riga{display:flex;align-items:center;gap:8px}
    .sez-testa .riga>.ic{width:19px;height:19px;margin-top:1.5px;color:var(--inchiostro-2)}
    .sez-testa h2{min-width:0;font-size:21px;line-height:1.2}
    .sez-testa p{margin:2px 0 0;color:var(--inchiostro-2);font:12px/1.35 var(--sans)}
    .vedi{display:inline-flex;align-items:center;gap:2px;min-height:48px;margin:-10px -8px 0 0;padding:0 8px;color:var(--accento-t);font:600 14px/1 var(--sans);white-space:nowrap;text-decoration:none}
    .vedi .ic{width:18px;height:18px}
    .vedi:hover{text-decoration:underline}
    .striscia{margin:-4px -16px 0;padding:6px 16px 10px;overflow-x:auto;scroll-snap-type:x mandatory;overscroll-behavior-x:contain;scroll-padding-inline:16px;scrollbar-width:thin}
    .striscia:focus-visible{outline-offset:-2px}
    .striscia ul{display:grid;grid-auto-flow:column;grid-auto-columns:150px;gap:10px;width:max-content;margin:0;padding:0;list-style:none}
    .striscia li{display:flex;scroll-snap-align:start}
    .striscia.evid ul{grid-auto-columns:260px;gap:14px}
    ul.griglia{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:0;padding:0;list-style:none}
    ul.griglia>li{display:flex;min-width:0}
    a.scheda{position:relative;display:flex;flex-direction:column;width:100%;min-width:0;border:1px solid var(--filo);border-radius:16px;background:var(--carta);color:var(--inchiostro);text-decoration:none;transition:border-color 120ms ease-out,transform 120ms ease-out}
    a.scheda:hover{border-color:color-mix(in srgb,var(--inchiostro-2) 45%,transparent)}
    a.scheda:hover .t,.eroe-a:hover h3{text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px}
    .cornice{display:flex;justify-content:center;aspect-ratio:2/1;min-height:76px;margin:10px 10px 0;padding:8px;border:1px solid var(--filo-2);border-radius:12px;background:repeating-linear-gradient(to bottom,transparent 0 10.5px,color-mix(in srgb,var(--filo-2) 60%,transparent) 10.5px 11px) var(--rialzo)}
    .foglio{position:relative;display:block;height:100%;max-width:100%;aspect-ratio:4/3;overflow:hidden;border-radius:8px;background:var(--foglio)}
    .striscia a.scheda:not(.evid) .cornice{aspect-ratio:17/10}
    .foglio img,.e-foglio img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center}
    .rigatura{position:absolute;inset:0;display:grid;place-items:center;background:repeating-linear-gradient(to bottom,transparent 0 10px,var(--filo) 10px 11px) var(--foglio)}
    .rigatura .cat{width:30px;height:30px;color:color-mix(in srgb,var(--inchiostro-2) 28%,transparent)}
    .fiducia{position:absolute;top:8px;left:8px;display:grid;place-items:center;width:22px;height:22px;border:1px solid var(--filo-2);border-radius:8px;background:var(--accento);color:#FFFFFF}
    .fiducia .ic{width:13px;height:13px}
    .fiducia.evid{background:var(--taupe);color:var(--inchiostro)}
    .nuovo{position:absolute;top:8px;left:8px;padding:3px 7px;border:1px solid var(--filo-2);border-radius:8px;background:var(--taupe);color:var(--inchiostro);font:600 11px/1.2 var(--sans)}
    .categoria{position:absolute;bottom:8px;left:8px;display:inline-flex;align-items:center;gap:4px;max-width:calc(100% - 16px);padding:3px 8px;border-radius:8px;background:rgb(0 0 0/.62);color:#FFFFFF;font:600 11px/1.3 var(--sans);white-space:nowrap}
    .categoria .ic{width:12px;height:12px}
    .categoria>span{min-width:0;overflow:hidden;text-overflow:ellipsis}
    .testi{display:flex;flex-direction:column;flex:1;gap:5px;min-width:0;padding:9px 12px 11px}
    .testi .t{overflow:hidden;font-size:15.5px;line-height:1.15;white-space:nowrap;text-overflow:ellipsis}
    .autore{display:flex;align-items:center;gap:6px;min-width:0;color:var(--inchiostro-2);font:12px/1.3 var(--sans)}
    .pallino{display:inline-grid;place-items:center;flex:none;width:20px;height:20px;border-radius:50%;font:700 9px/1 var(--sans)}
    .pallino.p24{width:24px;height:24px;font-size:11px}
    .pallino.sunset{background:var(--pal-sunset);color:var(--pal-sunset-t)}
    .pallino.amber{background:var(--pal-amber);color:var(--pal-amber-t)}
    .pallino.rose{background:var(--pal-rose);color:var(--pal-rose-t)}
    .pallino.grape{background:var(--pal-grape);color:var(--pal-grape-t)}
    .pillola{display:inline-flex;align-self:flex-start;align-items:center;gap:4px;padding:3px 8px;border:1px solid var(--filo-2);border-radius:8px;background:var(--taupe);color:var(--inchiostro);font:600 11px/1.3 var(--sans);white-space:nowrap}
    .pillola .ic{width:13px;height:13px}
    .stelle{display:inline-flex;align-items:center;color:var(--accento-t)}
    .stelle .ic{width:13px;height:13px}
    .stelle .vuota{color:var(--stella-vuota)}
    .stelle .n{margin-left:4px;color:var(--inchiostro-2);font:11px/1 var(--sans)}
    .piede-s{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-top:auto;padding-top:3px;color:var(--inchiostro-2);font:11px/1.3 var(--sans)}
    .piede-s>span{display:inline-flex;align-items:center;gap:4px;min-width:0}
    .piede-s .ic{width:13px;height:13px}
    .piede-s .vai{width:20px;height:20px;color:var(--accento-t)}
    a.scheda.evid{border-radius:18px}
    a.scheda.evid .cornice{aspect-ratio:19/10;margin:12px 12px 0;padding:10px;border-radius:13px}
    a.scheda.evid .foglio{aspect-ratio:3/2;border-radius:9px}
    a.scheda.evid .testi{flex-direction:row;align-items:flex-end;gap:10px;padding:10px 12px 12px 14px}
    a.scheda.evid .col{display:flex;flex:1;flex-direction:column;gap:7px;min-width:0}
    a.scheda.evid .t{font-size:19px;line-height:1.1}
    .tondo{display:grid;place-items:center;flex:none;width:36px;height:36px;border-radius:50%;background:var(--accento);color:#FFFFFF}
    .tondo .ic{width:20px;height:20px}
    .tondo.grande{width:40px;height:40px}
    .tondo.grande .ic{width:22px;height:22px}
    .eroe{--e-fondo:#221E16;--e-testo:#F2ECE0;--e-cornice:#3A3327;--e-foglio:#2A251C;--e-filo:#322D23;--e-occhiello:#FFE55C;--e-stelle:#A8C7FA;--e-pal:#1E3054;--e-pal-t:#C7D9FF;container-type:inline-size;margin:0 0 14px}
    .eroe-a{display:grid;grid-template-columns:minmax(0,1fr);gap:14px;padding:16px;border-radius:16px;background:var(--e-fondo);color:var(--e-testo);text-decoration:none;box-shadow:0 10px 20px rgb(36 31 23/.23);transition:transform 120ms ease-out}
    .e-testi{display:flex;flex-direction:column;min-width:0}
    .occhiello{color:var(--e-occhiello);font:20px/1 var(--mano)}
    .eroe h3{display:-webkit-box;margin-top:6px;overflow:hidden;color:var(--e-testo);font-size:24px;line-height:1.12;-webkit-line-clamp:2;-webkit-box-orient:vertical}
    .e-autore{display:flex;align-items:center;gap:8px;margin-top:10px;color:color-mix(in srgb,var(--e-testo) 72%,transparent);font:14px/1.3 var(--sans)}
    .e-pal{display:grid;place-items:center;width:26px;height:26px;border:1px solid color-mix(in srgb,var(--e-testo) 18%,transparent);border-radius:50%;background:var(--e-pal);color:var(--e-pal-t);font:700 12px/1 var(--sans)}
    .e-img{display:block;padding:10px;border:1px solid var(--e-filo);border-radius:12px;background:var(--e-cornice)}
    .e-foglio{position:relative;display:block;height:118px;overflow:hidden;border-radius:8px;background:var(--e-foglio)}
    .e-voto{display:flex;align-items:center;justify-content:space-between;gap:12px}
    .eroe .stelle{color:var(--e-stelle)}
    .eroe .stelle .ic{width:16px;height:16px}
    .eroe .stelle .vuota{color:color-mix(in srgb,var(--e-testo) 50%,transparent)}
    .eroe .stelle .n{color:color-mix(in srgb,var(--e-testo) 72%,transparent);font-size:13px}
    .e-conc{display:inline-flex;align-items:center;gap:6px;color:color-mix(in srgb,var(--e-testo) 72%,transparent);font:600 14px/1 var(--sans)}
    .e-conc .ic{width:15px;height:15px}
    @container (min-width:440px){.eroe-a{grid-template-columns:minmax(0,6fr) minmax(0,5fr);grid-template-rows:1fr auto;column-gap:18px}.e-testi{grid-column:1;grid-row:1}.e-img{grid-column:2;grid-row:1/3;align-self:center}.e-voto{grid-column:1;grid-row:2}.e-foglio{height:190px}}
    nav.pagine{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:8px;margin-top:28px}
    nav.pagine a,nav.pagine [aria-current]{display:inline-flex;align-items:center;justify-content:center;gap:4px;min-width:40px;height:40px;padding:0 12px;border:1px solid var(--filo-2);border-radius:999px;background:var(--lavata);color:var(--inchiostro);font:600 14px/1 var(--sans);text-decoration:none}
    nav.pagine a:hover{background:var(--rialzo)}
    nav.pagine [aria-current]{border-color:var(--accento);background:var(--accento);color:#FFFFFF}
    nav.pagine .salto{color:var(--inchiostro-2)}
    nav.pagine .ic{width:18px;height:18px}
    .altri{margin:16px 0 0;color:var(--inchiostro-2);font:14px/1.4 var(--sans);text-align:center}
    .mappa{margin-top:48px;padding-top:22px;border-top:1px solid var(--filo-2)}
    .mappa h2{margin-bottom:12px;font-size:21px}
    .mappa>ul{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px 24px;margin:0;padding:0;list-style:none}
    .mappa .m{color:var(--inchiostro);font:600 14px/1.4 var(--sans);text-decoration:none}
    .mappa ul ul{margin:4px 0 0;padding:0;list-style:none}
    .mappa ul ul a{display:inline-block;padding:3px 0;color:var(--inchiostro-2);font:14px/1.4 var(--sans);text-decoration:none}
    .mappa a:hover{color:var(--accento-t);text-decoration:underline}
    .lettura{max-width:68ch;margin-top:40px;padding-top:22px;border-top:1px solid var(--filo-2)}
    .lettura h2{margin-bottom:10px;font-size:21px}
    .lettura p{margin:0;color:var(--inchiostro-2);font:16px/1.6 var(--sans)}
    @media(prefers-color-scheme:dark){.eroe{--e-fondo:#FAF8F2;--e-testo:#23211B;--e-cornice:#F1EBDD;--e-foglio:#FFFDF8;--e-filo:#EFE8D9;--e-occhiello:#2563EB;--e-stelle:#2563EB;--e-pal:#DCE6FB;--e-pal-t:#16357A}}
    @media(min-width:640px){.striscia{margin:-4px -24px 0;padding-inline:24px;scroll-padding-inline:24px}ul.griglia{grid-template-columns:repeat(3,minmax(0,1fr))}}
    @media(min-width:800px){ul.griglia{grid-template-columns:repeat(4,minmax(0,1fr))}}
    @media(min-width:1024px){nav.chips{grid-column:1;grid-row:1}details.ordina{grid-row:1}details.faccetta{grid-row:2}.fascia h1{font-size:36px}.sez-testa{margin-top:36px}.vedi{min-height:32px;margin-block:0}ul.griglia{grid-template-columns:repeat(5,minmax(0,1fr));gap:16px}.striscia{container-type:inline-size}.striscia ul{grid-auto-columns:calc((100cqi - 5*12px)/6);gap:12px}.eroe h3{font-size:30px}.e-foglio{height:260px}}
    @media(prefers-reduced-motion:no-preference){a.scheda:active,.eroe-a:active,a.chip:active{transform:scale(.98)}}`;

/// La pagina del pack (TemplateDetailScreen): una colonna di 820 come l'app,
/// due colonne da 1024. Sotto i 1024 la barra dei bottoni resta in basso.
/// Su una colonna il foglio è 5:4 come la grande anteprima dell'app (a 4:3 il
/// ritaglio della miniatura 3:4 tagliava la riga di scrittura in fondo).
/// Etichette del riquadro come labelSmall dell'app (11, spaziatura .5), a 600:
/// il w500 dell'app, senza un peso 500 nel font di sistema, esce normale.
/// Sotto i 360 px i due bottoni della barra prendono la larghezza del loro
/// testo (e 8 px di margine): a metà esatta «Entra nella beta» andava a capo.
const STILE_PACK = `
    .pack{display:flex;flex-direction:column;max-width:820px;margin:0 auto}
    .pack-info{display:contents}
    .pack-img{margin:12px 0 18px;padding:12px;border:1px solid var(--filo-2);border-radius:16px;background:var(--rialzo)}
    .foglio-g{position:relative;display:block;aspect-ratio:5/4;overflow:hidden;border-radius:10px;background:var(--foglio)}
    .foglio-g img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center}
    .iniziale{position:absolute;inset:0;display:grid;place-items:center;background:linear-gradient(135deg,var(--accento-velo),var(--rialzo));color:color-mix(in srgb,var(--su-accento-velo) 60%,transparent);font:600 44px/1 var(--serif)}
    .titolo-riga{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:6px 12px}
    .titolo-riga h1{display:-webkit-box;flex:1 1 220px;min-width:0;overflow:hidden;font-size:26px;line-height:1.15;-webkit-line-clamp:3;-webkit-box-orient:vertical}
    .distintivo{display:inline-flex;align-items:center;gap:5px;margin-top:4px;padding:3px 8px;border:1px solid var(--filo-2);border-radius:8px;font:600 11px/1.3 var(--sans);white-space:nowrap}
    .distintivo .ic{width:13px;height:13px}
    .distintivo.uff{border-color:var(--accento);background:var(--accento);color:#FFFFFF}
    .distintivo.evid{background:var(--taupe);color:var(--inchiostro)}
    .ia{align-self:flex-start;margin-top:8px;padding:3px 8px;border-radius:12px;background:var(--lavata);color:var(--inchiostro-2);font:500 10px/1.3 var(--sans)}
    .di{display:flex;align-items:center;gap:6px;margin:8px 0 0;color:var(--inchiostro-2);font:12px/1.3 var(--sans)}
    .di .ic{width:16px;height:16px}
    .riquadro{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin-top:16px;padding:14px 4px;border:1px solid var(--filo-2);border-radius:12px;background:var(--foglio)}
    .cella{position:relative;display:flex;flex-direction:column;align-items:center;gap:4px;min-width:0;padding:0 6px;text-align:center;container-type:inline-size}
    .cella+.cella{border-left:1px solid var(--filo-2)}
    .cella .ic{width:16px;height:16px;color:var(--inchiostro-2)}
    .cella .v{max-width:100%;color:var(--inchiostro);font:600 17px/1.3 var(--sans);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
    .cella .v.materia{font-size:clamp(10px,calc(100cqi / var(--em,6)),17px)}
    .cella a.v{color:var(--accento-t);text-decoration:none}
    .cella a.v:hover{text-decoration:underline}
    .cella .e{color:var(--inchiostro-2);font:600 11px/1.45 var(--sans);letter-spacing:.5px}
    .eff{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin-top:12px;color:var(--inchiostro-2);font:12px/1.3 var(--sans)}
    .pack .blocco h2{margin:26px 0 10px;font-size:19px;line-height:1.2}
    .tag-l{display:flex;flex-wrap:wrap;gap:8px;margin:0;padding:0;list-style:none}
    .tag{display:inline-flex;align-items:center;gap:5px;max-width:220px;padding:4px 9px;border-radius:8px;background:var(--rialzo);color:var(--inchiostro-2);font:600 11.5px/1.3 var(--sans);overflow-wrap:anywhere}
    .tag .ic{width:14px;height:14px}
    .tag.cat{background:color-mix(in srgb,var(--accento-velo) 50%,transparent);color:var(--su-accento-velo)}
    p.desc,.desc-vuota{margin:0;color:var(--inchiostro);font:16px/1.6 var(--sans)}
    .desc-vuota{color:var(--inchiostro-2)}
    .nota{display:flex;gap:10px;margin-top:22px;padding:12px 14px;border:1px solid var(--filo-2);border-radius:12px;background:color-mix(in srgb,var(--accento-velo) 35%,transparent);color:var(--inchiostro-2);font:13px/1.45 var(--sans)}
    .nota .ic{width:20px;height:20px;color:var(--accento-t)}
    .nota p{margin:0}
    .azioni{position:sticky;bottom:0;z-index:10;order:3;display:flex;gap:10px;margin:24px -16px 0;padding:10px 16px 12px;border-top:1px solid var(--filo-2);background:var(--carta)}
    .azioni .btn{flex:1 1 0;min-height:52px;padding:0 12px}
    @media(max-width:359px){.azioni{gap:8px}.azioni .btn{flex-basis:auto;padding:0 8px}}
    .segnala-riga{order:1;margin:18px 0 0}
    .segnala{display:inline-flex;align-items:center;gap:4px;color:var(--inchiostro-2);font:12px/1.3 var(--sans);text-decoration:none}
    .segnala .ic{width:16px;height:16px}
    .segnala:hover{color:var(--inchiostro);text-decoration:underline}
    .correlati{order:2;margin-top:24px;padding-top:20px;border-top:1px solid var(--filo-2)}
    .correlati h2{margin-bottom:12px;font-size:19px}
    .link-el{display:flex;flex-wrap:wrap;gap:0 24px;font:600 14px/1.4 var(--sans)}
    .link-el p{margin:8px 0 0}
    .link-el a{text-decoration:none}
    .link-el a:hover{text-decoration:underline}
    @media(min-width:640px){.azioni{margin-inline:-24px;padding-inline:24px}}
    @media(min-width:1024px){.pack{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,6fr);column-gap:48px;align-items:start;max-width:none}.pack-info{display:flex;flex-direction:column;padding-top:24px}.pack-img{position:sticky;top:24px;margin:24px 0 0}.foglio-g{aspect-ratio:3/4}.titolo-riga h1{font-size:34px}.azioni{position:static;order:0;margin:20px 0 0;padding:0;border:0;background:none}.azioni .btn{flex:0 1 auto;min-width:180px}.segnala-riga{order:0;margin-top:12px}.correlati{grid-column:1/-1;margin-top:40px}}`;

/// Meta del tema, preload del carattere dei titoli e lo stile (base + pagina).
function testaWeb(css: string): string {
  return `
  <meta name="color-scheme" content="light dark" />
  <meta name="theme-color" content="#FAF8F2" media="(prefers-color-scheme: light)" />
  <meta name="theme-color" content="#221E16" media="(prefers-color-scheme: dark)" />
  <link rel="preload" href="${FONT_SITO}/InstrumentSerif-Regular.woff2" as="font" type="font/woff2" crossorigin />
  <link rel="preload" href="${FONT_SITO}/Sora-Bold.woff2" as="font" type="font/woff2" crossorigin />
  <style>
    ${STILE_WEB}
    ${css}
  </style>`;
}

/// La testata: il marchio come su fluera.dev («Flu» Sora, «era» Playfair) e,
/// al posto della AppBar «Catalogo» dell'app, il link all'indice e la beta.
function testata(indice = urlElenco("it"), suIndice = false): string {
  return `<header class="testata"><div class="in"><a class="marchio" href="${SITE}" aria-label="Fluera"><b aria-hidden="true">Flu</b><i aria-hidden="true">era</i></a><nav class="testata-nav" aria-label="Sezioni"><a class="sez" href="${
    esc(indice)
  }"${suIndice ? ` aria-current="page"` : ""}>Catalogo</a><a class="btn-beta" href="${SITE}/beta">Entra nella beta</a></nav></div></header>`;
}

function piede(hash?: string): string {
  return `<footer class="piede"><div class="in"><a href="${SITE}">Che cos'è Fluera →</a>${
    hash ? `<a href="https://share.fluera.dev/report?hash=${esc(hash)}">Segnala un contenuto</a>` : ""
  }</div></footer>`;
}

/// 404, 410, 500 e 503 delle pagine /s/ e degli elenchi, come gli stati vuoti
/// dell'app. Le altre rotte (OAuth, /report, /c…) restano su statusPage.
function paginaStato(
  headline: string,
  body: string,
  o: { icona?: string; azione?: { testo: string; href: string } } = {},
): string {
  const dentro = `${testata()}
  <main class="in"><div class="stato">${
    statoVuoto(o.icona ?? "eco", headline, body, o.azione ?? { testo: "Tutti i template", href: urlElenco("it") }, 1)
  }</div></main>`;
  return `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>${esc(headline)} · Fluera</title>${testaWeb("")}
</head>
<body>
  ${spriteIcone(dentro)}${dentro}
</body>
</html>`;
}

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
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
// 🌍 `Vary: Accept-Language` e' obbligatorio: queste pagine si ramificano
// sull'header (rotta /r/), e `s-maxage=120` le mette in cache di bordo. Senza
// `Vary`, la lingua servita per due minuti e' quella di CHI HA SCALDATO LA
// CACHE — uno studente italiano riceveva la pagina inglese a caso.
function html(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=0, s-maxage=120",
      "Vary": "Accept-Language",
    },
  });
}
/// Le pagine del collegamento OAuth portano uno stato firmato legato a una
/// persona: mai in cache (la cache di bordo di html() le terrebbe 120 s), mai
/// in una cornice altrui (il bottone «Autorizza» sotto un clic rubato), mai
/// nel Referer verso un'altra origine.
function htmlOauth(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
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

type McpDue = {
  title: string;
  next_review_ms: number;
  stage: string;
  stability_days: number;
  lapses: number;
};
type McpErr = { title: string; next_review_ms: number };
type McpUnseen = { title: string };
type McpTopic = { topic: string; accuracy_band: string };
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
  never_studied: McpUnseen[];
  never_studied_total: number;
  exam_gate?: McpExamGate;
};
type McpBlocked = { title: string; blocker: string };
type McpExamGate = {
  ready: number;
  total: number;
  blocked: McpBlocked[];
  blocked_total: number;
};

/// 🔒 Gemello dell'insieme chiuso lato Dart (`kDigestBlockerValues`). Vive
/// anche QUI, e non per ridondanza: `payload_json` lo scrive `authenticated`
/// e la RLS non ne vincola la forma, quindi un motivo inventato arriverebbe
/// verbatim nel contesto dell'assistente. I due lati devono restare uguali —
/// il cancello `mcp_contract` lo pretende.
const MCP_BLOCKERS: Record<string, string> = {
  confidentErrorPending: "una risposta che sembrava giusta e non lo era, ancora da rivedere",
  notEnoughEvidence: "ancora poche domande impegnative",
  needsSecondSession: "una sola sessione di lavoro",
  needsTimeApart: "le due sessioni sono troppo ravvicinate",
  needsSpacedSuccess: "manca il ritrovamento dopo una pausa",
  tooManyRecentErrors: "troppi errori recenti",
  memoryTooWeak: "il ricordo si è raffreddato",
  competenceTooLow: "competenza ancora sotto soglia",
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
/// Un CONTEGGIO che arriva dal device: intero, non negativo, sotto un tetto
/// dichiarato. Fuori range ⇒ 0, non il tetto: un valore assurdo non deve
/// diventare un valore plausibile (un ripiego plausibile e' peggio di uno
/// zero, perche' nessuno lo riconosce come ripiego).
const mcpCount = (v: unknown, max: number): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max
    ? Math.floor(v)
    : 0;

// La proiezione a schema chiuso: gemella di `projectRow` dello spike e del
// contratto Dart (`digestPayloadKeys` in study_digest_builder.dart).
export function mcpProjectRow(raw: Record<string, unknown>): McpRow {
  const row = mcpPick<McpRow>(raw, ["block_id", "canvas_id", "computed_at_ms", "payload"]);
  const rawPayload = (raw.payload_json ?? raw.payload ?? {}) as Record<string, unknown>;
  const p = mcpPick<McpPayload>(rawPayload, [
    "name", "exam_date_ms", "outcome", "readiness", "feasibility",
    "due", "due_total", "errors_due", "errors_due_total", "weak_topics",
    "never_studied", "never_studied_total", "exam_gate",
  ]);
  p.readiness = mcpPick(((p.readiness ?? {}) as unknown) as Record<string, unknown>,
    ["ready", "at_risk", "never_studied"]) as McpPayload["readiness"];
  p.name = mcpText(p.name);
  p.due = ((p.due ?? []) as Record<string, unknown>[])
    .slice(0, MCP_MAX_LIST)
    .map((d) => {
      const e = mcpPick<McpDue>(d, [
        "title", "next_review_ms", "stage", "stability_days", "lapses",
      ]);
      e.title = mcpText(e.title);
      // 🔒 Il cap dei VALORI vale anche per i due numeri nuovi: `payload_json`
      // e' scritto da `authenticated` e la RLS non ne vincola la forma, quindi
      // «stabilita' 9e99 giorni» o «-3 cadute» arriverebbero verbatim nel
      // contesto dell'assistente. Interi, non negativi, con un tetto
      // dichiarato: 3650 giorni (dieci anni) e' oltre qualunque stabilita'
      // che FSRS produca su uno studente vero.
      e.stability_days = mcpCount(e.stability_days, 3650);
      e.lapses = mcpCount(e.lapses, 9999);
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
      const e = mcpPick<McpTopic>(x, ["topic", "accuracy_band"]);
      e.topic = mcpText(e.topic);
      return e;
    });
  p.never_studied = ((p.never_studied ?? []) as Record<string, unknown>[])
    .slice(0, MCP_MAX_LIST)
    .map((x) => {
      const e = mcpPick<McpUnseen>(x, ["title"]);
      e.title = mcpText(e.title);
      return e;
    });
  p.never_studied_total =
    typeof p.never_studied_total === "number"
      ? p.never_studied_total
      : p.never_studied.length;
  p.due_total = typeof p.due_total === "number" ? p.due_total : p.due.length;
  p.errors_due_total =
    typeof p.errors_due_total === "number" ? p.errors_due_total : p.errors_due.length;
  // 🎓 Il verdetto pre-prova. Ri-proiettato come tutto il resto: il device
  // filtra gia', ma il payload lo scrive `authenticated` e la RLS non ne
  // vincola la forma — un motivo inventato o un titolo lungo un chilometro
  // arriverebbero verbatim nel contesto dell'assistente.
  const rawGate = p.exam_gate as unknown;
  if (rawGate && typeof rawGate === "object") {
    const g = mcpPick<McpExamGate>(rawGate as Record<string, unknown>, [
      "ready", "total", "blocked", "blocked_total",
    ]);
    g.ready = mcpCount(g.ready, 9999);
    g.total = mcpCount(g.total, 9999);
    g.blocked = ((g.blocked ?? []) as Record<string, unknown>[])
      .slice(0, MCP_MAX_LIST)
      .map((x) => {
        const e = mcpPick<McpBlocked>(x, ["title", "blocker"]);
        e.title = mcpText(e.title);
        return e;
      })
      // Un motivo fuori dall'insieme chiuso non e' dichiarato nell'informativa:
      // la voce cade INTERA, perche' un titolo con un motivo sconosciuto
      // accanto direbbe «su X c'e' qualcosa» senza dire cosa.
      .filter((e) => e.title.length > 0 && e.blocker in MCP_BLOCKERS);
    g.blocked_total = typeof g.blocked_total === "number"
      ? mcpCount(g.blocked_total, 9999)
      : g.blocked.length;
    p.exam_gate = g;
  } else {
    delete p.exam_gate;
  }
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
// 📅 Giorni di CALENDARIO fra oggi e l'esame — non una differenza in
// millisecondi. Era `Math.ceil((examMs - now) / 86_400_000)`: a fuso costante
// dava il numero giusto, ma quando fra oggi e l'esame cade un cambio d'ora fra
// due mezzanotti locali passano 23 o 25 ore e il conto scivola di uno, su
// TUTTI i giorni in cui il cambio sta nell'intervallo. È la stessa classe che
// in Dart ha già prodotto quattro ricadute (`calendarDaysUntilExam`).
//
// Ancorato a MEZZOGIORNO come `mcpExamDay` qui sopra, e per la stessa ragione:
// `exam_date_ms` è la mezzanotte LOCALE del device, il server vede solo UTC, e
// lo scarto di 12 h recupera il giorno inteso per ogni fuso in (−12, +12].
//
// ⚠️ LIMITE dichiarato: il fuso del device non arriva al server, quindi resta
// un'incertezza di ±1 giorno per chi è lontano da UTC. Questa riparazione
// toglie la deriva da cambio d'ora, non quella.
const mcpDaysLeft = (examMs: number | null, now: number) => {
  if (examMs == null) return null;
  const giorno = (ms: number) => Math.floor((ms + 43_200_000) / 86_400_000);
  return giorno(examMs) - giorno(now);
};
// 🔗 R3 — Il concetto nel link. La rotta /r/ legge e sanifica `?concept=`, e
// il gestore deep-link lo estrae: il connettore non lo passava, quindi ogni
// consiglio atterrava sulla tela e lasciava allo studente il compito di
// ritrovare da solo il concetto di cui si stava parlando.
// ⚠️ Questo commento diceva anche «e la tela apre il punto giusto». Era
// FALSO quando l'ho scritto: l'inquadratura non esisteva. Ora c'e'
// (`FlueraFirstGlimpseControls.focusOnConcept`, chiamata da main.dart dopo
// il primo snapshot NON VUOTO dei concetti) — ma resta verificabile solo su
// un dispositivo: nessun cancello puo' provare che la camera si e' mossa.
const mcpOpenInApp = (canvasId: string, concept?: string | null) =>
  `https://share.fluera.dev/r/${canvasId}` +
  (concept ? `?concept=${encodeURIComponent(concept)}` : "");

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
  // 🕰️ R7: `eta_giorni` è il MINIMO su tutte le righe — con quattro corsi
  // freschi e uno fermo da un mese, l'intera risposta si dichiara vecchia
  // di un mese e la freschezza smette di dire qualcosa. L'età del SINGOLO
  // corso è quella che cambia il consiglio su quel corso.
  const etaCorso = Math.floor((now - r.computed_at_ms) / 86_400_000);
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
    // 🪤 R1: il ramo `passed` usava mcpExamDay e questo mcpIso — la data
    // d'esame usciva D−1 per ogni fuso a est di Greenwich, cioè per ogni
    // studente italiano, su ogni corso che conta ancora. `mcpIso` resta
    // giusto nei bucket del forecast, dove il valore è un istante vero.
    esame: mcpExamDay(p.exam_date_ms),
    giorni_rimanenti: mcpDaysLeft(p.exam_date_ms, now),
    prontezza: {
      sopra_soglia: p.readiness.ready,
      a_rischio: p.readiness.at_risk,
      mai_studiati: p.readiness.never_studied,
    },
    nota_prontezza: "«mai studiati» = mai visti: non è la stessa cosa di «a rischio».",
    aggiornato_giorni_fa: etaCorso,
    ...(etaCorso >= 3
      ? {
        nota_corso_freschezza: `Di questo corso ho una fotografia di ` +
          `${etaCorso} giorni fa: non aprirlo da allora non significa non ` +
          `averlo studiato, significa che da qui non lo vedo.`,
      }
      : {}),
    // 🆕 I mai studiati PER NOME: un conteggio non dice da dove cominciare,
    // che è l'unica cosa utile da dire su un concetto mai visto. Assente in
    // modalità «solo conteggi» (il device non manda titoli) e assente quando
    // non ce ne sono: una chiave vuota si legge come «ho guardato e non c'è».
    ...(p.never_studied.length
      ? {
        mai_studiati_quali: p.never_studied.slice(0, 20).map((u) => u.title),
        ...(p.never_studied_total > Math.min(p.never_studied.length, 20)
          ? {
            nota_mai_studiati:
              `Elenco parziale: ${Math.min(p.never_studied.length, 20)} nomi su ` +
              `${p.never_studied_total}.`,
          }
          : {}),
      }
      : {}),
    // 🪦 R5: `feasibility` è la costante 'unknown' per ogni corso di ogni
    // utente — il calcolo vero esiste, è provato, e non ha un chiamante.
    // Finché è costante non esce: un campo che dice sempre la stessa cosa
    // è rumore che sembra informazione. Il giorno in cui l'app lo cabla,
    // ricompare da solo senza toccare il server.
    ...(p.feasibility && p.feasibility !== "unknown"
      ? { fattibilita: p.feasibility }
      : {}),
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
          // 📏 Quanto regge questo ricordo secondo il modello, in giorni
          // interi, e quante volte è già caduto. Sono i due numeri che
          // cambiano il CONSIGLIO: 2 giorni contro 40 è «stasera» contro
          // «lascialo stare»; 4 cadute vogliono dire che quel concetto va
          // ripreso da un'altra angolazione, non ripassato uguale.
          regge_giorni: d.stability_days,
          ...(d.lapses > 0 ? { gia_caduto_volte: d.lapses } : {}),
          apri_in_fluera: mcpOpenInApp(r.canvas_id, d.title),
        }))
      ).sort((a, b) => b.in_ritardo_da_giorni - a.in_ritardo_da_giorni);
      const errors = scope.flatMap((r) =>
        r.payload.errors_due.filter((e) => e.next_review_ms <= now).map((e) => ({
          // 🔒 `errore` e' il CONCETTO su cui pende la correzione, non la
          // correzione: del diario escono solo il nome del cluster e la
          // data (§2.12, meta' negativa). Il nome del campo lo dice.
          concetto_da_ricontrollare: e.title,
          corso: r.payload.name,
          in_ritardo_da_giorni: Math.max(
            0,
            Math.floor((now - e.next_review_ms) / 86_400_000),
          ),
          apri_in_fluera: mcpOpenInApp(r.canvas_id, e.title),
        }))
      );
      // 🆕 I mai studiati: non sono «in scadenza» — non hanno una scadenza —
      // ma sono meta' della risposta alla domanda che questo strumento
      // riceve davvero, che e' «cosa faccio adesso». Sezione SEPARATA e
      // nominata: mescolarli con le scadenze sarebbe la confusione che
      // `nota_prontezza` esiste per impedire.
      const daIniziare = scope.flatMap((r) =>
        r.payload.never_studied.map((u) => ({
          concetto: u.title,
          corso: r.payload.name,
          apri_in_fluera: mcpOpenInApp(r.canvas_id, u.title),
        }))
      );
      const CAP = 20;
      // 🕳️ «0 in scadenza» NON vuol dire «sei a posto», e la differenza non
      // e' accademica: misurato dal vivo il 2026-08-22, con zero scadenze e
      // due concetti mai visti a 18 giorni dall'esame, l'assistente ha
      // concluso «quindi sei a posto per ora». Era vero alla lettera e
      // sbagliato come consiglio. Un'assenza va DICHIARATA insieme a cio'
      // che non copre, altrimenti si legge come una rassicurazione — la
      // stessa regola per cui un cap silenzioso si legge come completezza.
      const esameVicino = scope
        .map((r) => mcpDaysLeft(r.payload.exam_date_ms, now))
        .filter((g): g is number => typeof g === "number" && g >= 0)
        .sort((a, b) => a - b)[0];
      const maiVisti = scope.reduce((n, r) => n + r.payload.readiness.never_studied, 0);
      const aRischio = scope.reduce((n, r) => n + r.payload.readiness.at_risk, 0);
      // 🔗 R4: anche lo stato vuoto deve poter chiudere col link, e il corso
      // giusto è quello dell'esame più vicino — non il primo dell'elenco.
      const rientro = scope.find((r) =>
        mcpDaysLeft(r.payload.exam_date_ms, now) === esameVicino
      ) ?? scope[0];
      const nienteInScadenza = due.length === 0 && errors.length === 0;
      const notaZero = nienteInScadenza && (maiVisti > 0 || aRischio > 0 ||
          (typeof esameVicino === "number" && esameVicino <= 30))
        ? {
          nota_zero:
            "Nessun ripasso DOVUTO adesso non vuol dire che non ci sia niente da fare: " +
            [
              maiVisti > 0
                ? maiVisti === 1
                  ? "1 concetto non è mai stato visto"
                  : `${maiVisti} concetti non sono mai stati visti`
                : null,
              aRischio > 0
                ? aRischio === 1
                  ? "1 è sotto soglia"
                  : `${aRischio} sono sotto soglia`
                : null,
              typeof esameVicino === "number" && esameVicino <= 30
                ? esameVicino === 0
                  ? "l'esame più vicino è oggi"
                  : esameVicino === 1
                  ? "l'esame più vicino è domani"
                  : `l'esame più vicino è fra ${esameVicino} giorni`
                : null,
            ].filter(Boolean).join(", ") +
            ". Non dire allo studente che è a posto: dillo solo se non c'è " +
            "nessuna di queste tre cose.",
          ...(rientro ? { apri_in_fluera: mcpOpenInApp(rientro.canvas_id) } : {}),
        }
        : {};
      return mcpWrap(scope.length ? scope : rows, {
        in_scadenza_ora: due.slice(0, CAP),
        totale_in_scadenza: due.length,
        ...(due.length > CAP ? { nota_cap: `Mostrati ${CAP} di ${due.length}.` } : {}),
        errori_da_ricontrollare: errors,
        ...(daIniziare.length
          ? {
            mai_studiati_da_iniziare: daIniziare.slice(0, CAP),
            totale_mai_studiati: daIniziare.length,
          }
          : {}),
        ...notaZero,
      }, now);
    }

    case "get_review_forecast": {
      // 🕳️ R2: `Number("sette")` è NaN e `Math.min(NaN, 14)` è NaN — il ciclo
      // dei bucket non girava, la risposta usciva col solo «in_ritardo» e si
      // leggeva come «non hai nulla in scadenza». Un'assenza dedotta da un
      // difetto di parsing: la dottrina violata dal codice, non da una scelta.
      const daysRaw = Math.trunc(Number(args.days ?? 7));
      const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, 14) : 7;
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
          // 🔗 R4: la riga `metodo` ordina in OGNI risposta di chiudere col
          // link, e questo percorso non ne aveva nessuno da usare.
          apri_in_fluera: mcpOpenInApp(r.canvas_id, w.topic),
        }))
      );
      return mcpWrap(scope.length ? scope : rows, {
        topic_deboli: topics,
        // 🕳️ La stessa disciplina di `nota_zero`: un elenco vuoto qui non
        // e' una promessa di solidita'. La soglia e' 4 osservazioni
        // QUALIFICANTI per concetto (kMinEvidence), e sotto quella il
        // sistema dichiara di non sapere invece di stimare.
        nota_fonte: topics.length
          ? "Fasce, mai numeri. Solo concetti con evidenza sufficiente (almeno 4 osservazioni qualificanti)."
          : "Nessun concetto ha ancora abbastanza evidenza per una fascia: NON significa che sia tutto solido, significa che da qui non lo so. Non dedurne che lo studente non abbia punti deboli.",
      }, now);
    }

    case "get_exam_gate": {
      if (args.course && !mcpFindCourse(active, String(args.course))) {
        return mcpWrap(rows, {
          errore: `Corso non trovato fra quelli attivi: "${args.course}". Usa list_courses.`,
        }, now);
      }
      const scope = args.course
        ? [mcpFindCourse(active, String(args.course))].filter(Boolean) as McpRow[]
        : active;
      // 🕳️ Un corso SENZA verdetto e uno con «zero pronti» sono due fatti
      // diversi, e confonderli e' il difetto di sempre: il primo significa
      // «non l'ho misurato», il secondo «l'ho misurato e non ci sei». Escono
      // in due liste separate, mai sommati.
      const conVerdetto = scope.filter((r) => r.payload.exam_gate);
      const senzaVerdetto = scope
        .filter((r) => !r.payload.exam_gate)
        .map((r) => r.payload.name);
      const corsi = conVerdetto.map((r) => {
        const g = r.payload.exam_gate!;
        return {
          corso: r.payload.name,
          pronti: g.ready,
          su: g.total,
          non_pronti: g.blocked.map((b) => ({
            concetto: b.title,
            motivo: MCP_BLOCKERS[b.blocker],
            apri_in_fluera: mcpOpenInApp(r.canvas_id, b.title),
          })),
          non_pronti_totale: g.blocked_total,
          ...(g.blocked_total > g.blocked.length
            ? {
              nota_non_pronti:
                `Elenco parziale: ${g.blocked.length} nomi su ${g.blocked_total}.`,
            }
            : {}),
          apri_in_fluera: mcpOpenInApp(r.canvas_id),
        };
      });
      return mcpWrap(scope.length ? scope : rows, {
        controllo_pre_prova: corsi,
        ...(senzaVerdetto.length
          ? {
            senza_verdetto: senzaVerdetto,
            nota_senza_verdetto:
              "Su questi corsi il controllo non ha ancora abbastanza storia per " +
              "esprimersi: NON significa che lo studente non sia pronto, significa " +
              "che da qui non lo so. Non trattarli come bocciati.",
          }
          : {}),
        nota_controllo:
          "Non è un voto e non è una previsione d'esame: dice se su un argomento " +
          "è stato fatto abbastanza lavoro perché una prova a libro chiuso dentro " +
          "Fluera abbia senso. Il motivo è la PRIMA condizione che manca, non " +
          "l'unica: quando quella è risolta può comparirne un'altra, ed è normale.",
      }, now);
    }

    default:
      throw new McpRpcError(-32602, `Tool sconosciuto: ${name}`);
  }
}

export const MCP_TOOL_DEFS = [
  {
    name: "list_courses",
    // 🔒 P1: «sola lettura» viveva in un commento e in una frase su
    // /connect: nessuna macchina la leggeva. E i default dello spec
    // sono i pessimisti — annotazioni assenti significano distruttivo
    // e mondo aperto, quindi un client prudente fa confermare ogni
    // chiamata. ⚠️ Sono hint non fidati: descrivono, non proteggono.
    annotations: {
      title: "I tuoi corsi",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      "Elenca i corsi dello studente su Fluera: data d'esame, giorni rimanenti, prontezza a conteggi (sopra soglia / a rischio / mai studiati), i NOMI dei concetti mai studiati, esito. Un corso «superato» è fuori dalla pianificazione.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_readiness",
    // 🔒 P1: «sola lettura» viveva in un commento e in una frase su
    // /connect: nessuna macchina la leggeva. E i default dello spec
    // sono i pessimisti — annotazioni assenti significano distruttivo
    // e mondo aperto, quindi un client prudente fa confermare ogni
    // chiamata. ⚠️ Sono hint non fidati: descrivono, non proteggono.
    annotations: {
      title: "Prontezza di un corso",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      "La prontezza di UN corso proiettata alla sua data d'esame, a conteggi (mai percentuali).",
    inputSchema: {
      type: "object",
      properties: { course: { type: "string", description: "Nome del corso" } },
      required: ["course"],
      additionalProperties: false,
    },
  },
  {
    name: "get_due_now",
    // 🔒 P1: «sola lettura» viveva in un commento e in una frase su
    // /connect: nessuna macchina la leggeva. E i default dello spec
    // sono i pessimisti — annotazioni assenti significano distruttivo
    // e mondo aperto, quindi un client prudente fa confermare ogni
    // chiamata. ⚠️ Sono hint non fidati: descrivono, non proteggono.
    annotations: {
      title: "Cosa fare adesso",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      "Cosa fare ADESSO: i concetti in scadenza (con `regge_giorni` = per quanti giorni il modello dice che il ricordo tiene, e `gia_caduto_volte`), gli errori da ricontrollare, e i concetti MAI studiati da cui iniziare. Lista globale annotata per corso (mai in silo: Fluera alterna le materie di proposito). Opzionale: filtra per corso. Zero in scadenza NON significa «a posto»: leggi `nota_zero` se c'è. Chiudi ogni piano col link apri_in_fluera.",
    inputSchema: {
      type: "object",
      properties: { course: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "get_review_forecast",
    // 🔒 P1: «sola lettura» viveva in un commento e in una frase su
    // /connect: nessuna macchina la leggeva. E i default dello spec
    // sono i pessimisti — annotazioni assenti significano distruttivo
    // e mondo aperto, quindi un client prudente fa confermare ogni
    // chiamata. ⚠️ Sono hint non fidati: descrivono, non proteggono.
    annotations: {
      title: "Previsione dei ritorni",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      "Conteggi di ritorni dovuti per giorno, prossimi N giorni (default 7, max 14), più il bucket «in ritardo».",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "integer", minimum: 1, maximum: 14, default: 7 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_exam_gate",
    annotations: {
      title: "Controllo pre-prova",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      "Cosa manca PRIMA di una prova a libro chiuso, per argomento: quanti hanno superato il controllo e quanti no, e per quelli che no il MOTIVO (la prima condizione mancante, non l'unica). Non è un voto né una previsione d'esame. Un corso in `senza_verdetto` non è bocciato: è non misurato — leggi `nota_senza_verdetto`. Opzionale: filtra per corso.",
    inputSchema: {
      type: "object",
      properties: { course: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "get_weak_topics",
    // 🔒 P1: «sola lettura» viveva in un commento e in una frase su
    // /connect: nessuna macchina la leggeva. E i default dello spec
    // sono i pessimisti — annotazioni assenti significano distruttivo
    // e mondo aperto, quindi un client prudente fa confermare ogni
    // chiamata. ⚠️ Sono hint non fidati: descrivono, non proteggono.
    annotations: {
      title: "Argomenti fragili",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      "I concetti su cui lo studente è più fragile, come FASCIA (bassa/media), dalla storia socratica e dagli atti di ricostruzione. Nessuna tendenza: la competenza qui è una fotografia, non una serie. Escono solo i concetti con evidenza sufficiente — un elenco vuoto significa «non ho abbastanza prove», NON «è tutto solido».",
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
        // 🕳️ R6: con zero righe il ramo del digest vuoto rispondeva SUCCESSO
        // a qualunque nome — `segna_come_saputo` compreso veniva assolto
        // dall'assenza di dati invece che rifiutato. Il nome si valida prima
        // di guardare i dati, o l'esistenza di un tool dipende dal digest.
        if (!MCP_TOOL_DEFS.some((t) => t.name === toolName)) {
          throw new McpRpcError(-32602, `Tool sconosciuto: ${toolName}`);
        }
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
          result: {
            content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
            // 🚩 R6: un fallimento di DOMINIO (corso inesistente) usciva come
            // successo. Lo spec vuole che l'errore di esecuzione arrivi al
            // modello, perché si autocorregga, invece di farlo ragionare
            // sopra una risposta che crede buona.
            ...(out && typeof out === "object" && "errore" in out
              ? { isError: true }
              : {}),
          },
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
    return htmlOauth(400, statusPage("Richiesta non valida", "response_type deve essere «code»."));
  }
  if (!clientId || !redirectUri) {
    return htmlOauth(400, statusPage("Richiesta non valida", "Mancano client_id o redirect_uri."));
  }
  const client = await oauthLoadClient(clientId);
  if (!client) {
    return htmlOauth(400, statusPage("Applicazione sconosciuta", "Questo client non è registrato."));
  }
  if (!client.redirect_uris.includes(redirectUri)) {
    // Confronto ESATTO, mai per prefisso: un match parziale è la via classica
    // per farsi consegnare i codici altrove.
    return htmlOauth(400, statusPage("Indirizzo di ritorno non valido", "Non corrisponde a quelli registrati."));
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
  return htmlOauth(200, renderOauthSignIn(client.client_name || clientId, sbAuth.toString()));
}

type OauthRichiesta = {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  resource: string;
  /// Chi ha fatto l'accesso. C'è SOLO nello stato del CONSENSO, che firma il
  /// callback dopo lo scambio del codice con Supabase; lo stato dell'ANDATA
  /// (quello di /oauth/authorize, che chiunque può farsi dare) non ce l'ha.
  /// 🔴 Fino al 2026-09-25 l'utente viaggiava in un campo nascosto del modulo,
  /// fuori dalla firma: chiunque aveva uno stato dell'andata poteva approvare
  /// scrivendo lì l'uuid di un altro e ricevere un token sul suo studio.
  userId?: string;
};

/// Quanto vale uno stato firmato. Copre l'accesso con Google/Apple all'andata
/// e la lettura della schermata di consenso al ritorno: oltre, si ricomincia.
const OAUTH_STATE_TTL_S = 15 * 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

/// `ora` esiste per i test: in produzione è sempre l'orologio.
export async function oauthSignState(r: OauthRichiesta, ora = Date.now()): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify({ ...r, iat: Math.floor(ora / 1000) })));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(), enc.encode(payload));
  return `${payload}.${b64url(sig)}`;
}
/// Solo la firma: il contenuto se l'HMAC torna, null altrimenti. Il tempo lo
/// guardano i due chiamanti qui sotto.
async function oauthVerifiedPayload(
  signed: string,
): Promise<(OauthRichiesta & { iat?: unknown }) | null> {
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
    return JSON.parse(new TextDecoder().decode(b64urlDecode(payload))) as
      OauthRichiesta & { iat?: unknown };
  } catch {
    return null;
  }
}
/// null se la firma non torna, se manca l'istante di firma o se è scaduto.
export async function oauthOpenState(signed: string, ora = Date.now()): Promise<OauthRichiesta | null> {
  const d = await oauthVerifiedPayload(signed);
  if (!d) return null;
  const { iat, ...r } = d;
  const adesso = Math.floor(ora / 1000);
  // Uno stato senza istante è di prima del 2026-09-25: non scade mai, quindi
  // non vale. Il server firma solo interi. Un minuto di tolleranza per gli
  // orologi delle istanze.
  if (
    typeof iat !== "number" || !Number.isInteger(iat) ||
    adesso - iat > OAUTH_STATE_TTL_S || iat - adesso > 60
  ) {
    return null;
  }
  return r;
}
/// Firma valida ma tempo scaduto (o mai scritto): la richiesta è autentica,
/// quindi si può rimandare al SUO client un «access_denied» invece di lasciare
/// la persona su una pagina senza uscita. Il redirect_uri sta dentro la firma
/// ed è stato confrontato ESATTO con quelli registrati all'andata: non è un
/// open redirect. Non conia niente. `conUtente` dice quale stato si aspetta
/// il chiamante (consenso sì, andata no): quello dell'altra fase resta un 400.
async function oauthExpiredRedirect(signed: string, conUtente: boolean): Promise<Response | null> {
  const d = await oauthVerifiedPayload(signed);
  if (!d || (d.userId !== undefined) !== conUtente) return null;
  const u = new URL(d.redirectUri);
  u.searchParams.set("error", "access_denied");
  u.searchParams.set("error_description", "sessione scaduta: riprova il collegamento");
  u.searchParams.set("iss", OAUTH_ISSUER);
  if (d.state) u.searchParams.set("state", d.state);
  return Response.redirect(u.toString(), 302);
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

/// Dove finirà l'accesso, detto in parole. Il nome dell'app lo scrive chi la
/// registra e può mentire (chiunque può chiamarsi «Claude»); l'host di ritorno
/// è dove il codice arriva davvero.
function destinatarioOauth(redirectUri: string): string {
  try {
    const u = new URL(redirectUri);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]") {
      return "un programma su questo computer";
    }
    return u.host;
  } catch {
    return redirectUri;
  }
}

function renderOauthConsent(
  clientName: string,
  email: string,
  r: OauthRichiesta,
  statoConsenso: string,
): string {
  // Identità e richiesta vengono solo dallo stato firmato; dal modulo
  // /oauth/approve legge soltanto la scelta Autorizza/Annulla.
  return oauthShell(
    "Autorizzare?",
    `<h1>${esc(clientName)} potrà leggere il tuo stato di studio</h1>
<p>L'accesso verrà consegnato a <strong>${esc(destinatarioOauth(r.redirectUri))}</strong>.
Se il collegamento non l'hai avviato tu, annulla.</p>
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
  <input type="hidden" name="req" value="${esc(statoConsenso)}">
  <button class="btn" type="submit" name="ok" value="1">Autorizza</button>
  <button class="btn ghost" type="submit" name="ok" value="0">Annulla</button>
</form>
<p class="who">Accesso come ${esc(email)} · Puoi revocare quando vuoi da
Impostazioni → Funzioni cognitive → Collega il tuo assistente.</p>`,
  );
}

// ── /oauth/callback — si torna da Supabase, si mostra il consenso ───────────
async function oauthCallback(url: URL): Promise<Response> {
  const signed = url.searchParams.get("fluera_state") ?? "";
  const r = await oauthOpenState(signed);
  if (!r) {
    return await oauthExpiredRedirect(signed, false) ??
      htmlOauth(400, statusPage("Sessione scaduta", "Riprova il collegamento dall'inizio."));
  }
  // Qui torna solo lo stato dell'ANDATA: uno che porta già un utente è uno
  // stato del consenso rimesso in circolo.
  if (r.userId !== undefined) {
    return htmlOauth(400, statusPage("Sessione scaduta", "Riprova il collegamento dall'inizio."));
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
    return htmlOauth(400, statusPage("Accesso non riuscito", "Riprova il collegamento."));
  }
  const client = await oauthLoadClient(r.clientId);
  // 🔑 L'identità entra nella FIRMA qui, e da nessun'altra parte: è l'unico
  // punto in cui il server sa chi ha fatto l'accesso.
  const statoConsenso = await oauthSignState({ ...r, userId: ident.userId });
  return htmlOauth(
    200,
    renderOauthConsent(client?.client_name || r.clientId, ident.email, r, statoConsenso),
  );
}

// ── /oauth/approve — l'utente ha deciso: si conia il codice ────────────────
async function oauthApprove(req: Request): Promise<Response> {
  if (req.method !== "POST") return oauthError("invalid_request", "usa POST", 405);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return htmlOauth(400, statusPage("Richiesta non valida", "Riprova dall'inizio."));
  }
  const stato = String(form.get("req") ?? "");
  const r = await oauthOpenState(stato);
  if (!r) {
    return await oauthExpiredRedirect(stato, true) ??
      htmlOauth(400, statusPage("Sessione scaduta", "Riprova dall'inizio."));
  }
  // 🔴 L'utente viene SOLO dallo stato firmato del consenso. Un campo del
  // modulo lo scrive chiunque; lo stato dell'andata non ha utente e qui non
  // vale (vedi OauthRichiesta.userId).
  const uid = r.userId ?? "";
  if (!UUID_RE.test(uid)) {
    return htmlOauth(400, statusPage("Sessione scaduta", "Riprova dall'inizio."));
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
    return htmlOauth(200, oauthShell(
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
    return htmlOauth(503, statusPage("Riprova", "Non è stato possibile completare ora."));
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
      p: "Il tuo assistente AI può leggere <strong>cosa devi ripassare e quando</strong>: corsi e date d'esame, i concetti in scadenza con quanto reggono e quante volte sono già caduti, quelli che non hai mai aperto, su quali concetti hai una correzione da ricontrollare, e i punti deboli come fasce. <strong>Mai il contenuto dei tuoi appunti</strong>: non la tua calligrafia, non il testo riconosciuto, non la frase che avevi sbagliato — e non può scrivere nulla.",
      pre: "Prima di tutto, in Fluera:",
      s1: "Impostazioni → Privacy → attiva <strong>Assistente AI collegato</strong>",
      s2: "Impostazioni → Funzioni cognitive → <strong>Collega il tuo assistente</strong>",
      web: "Dai connettori (claude.ai, ChatGPT)",
      webp: "Aggiungi un connettore con questo indirizzo, poi accedi con l'account che usi su Fluera e autorizza:",
      cli: "Da terminale (Claude Code)",
      clip: "Crea una chiave nell'app e incolla il comando che ti mostra:",
      ask: "Cosa puoi chiedergli",
      askp: "Una volta collegato, parlagli come parleresti a un compagno di corso che ha visto il tuo quaderno:",
      q: [
        "Cosa devo ripassare adesso?",
        "Quali corsi ho e quando sono gli esami?",
        "Da dove comincio su Corpo Rigido?",
        "Cosa mi torna nei prossimi sette giorni?",
        "Su cosa sono più debole?",
        "Come sarò messo il giorno dell'esame?",
      ],
      hon: "Quando non sa, lo dice",
      honp: "Un elenco vuoto non è mai una promessa. Se non hai ripassi dovuti ma hai concetti mai aperti e un esame vicino, te lo dice invece di rispondere «sei a posto». Se non ha abbastanza prove per chiamare debole un concetto, dice che non lo sa — non che va tutto bene. E i conteggi non diventano mai percentuali: «uno a rischio, due mai visti» è una cosa che puoi verificare, «sei al 62%» no.",
      rev: "Puoi revocare in ogni momento dall'app. Revocare il consenso chiude tutte le sessioni e cancella l'estratto conservato. Il ripasso che conta si fa comunque qui: a libro chiuso, con la tua calligrafia.",
    }
    : {
      h: "Connect your assistant to Fluera",
      p: "Your AI assistant can read <strong>what you need to review and when</strong>: courses and exam dates, the concepts due with how long they hold and how many times they have lapsed, the ones you have never opened, which concepts carry a correction to recheck, and weak points as coarse bands. <strong>Never the content of your notes</strong>: not your handwriting, not the recognised text, not the sentence you got wrong — and it cannot write anything.",
      pre: "First, in Fluera:",
      s1: "Settings → Privacy → turn on <strong>Connected AI assistant</strong>",
      s2: "Settings → Cognitive features → <strong>Connect your assistant</strong>",
      web: "From connectors (claude.ai, ChatGPT)",
      webp: "Add a connector with this address, then sign in with your Fluera account and approve:",
      cli: "From the terminal (Claude Code)",
      clip: "Create a key in the app and paste the command it shows you:",
      ask: "What you can ask it",
      askp: "Once connected, talk to it the way you would to a coursemate who has seen your notebook:",
      q: [
        "What should I review right now?",
        "Which courses do I have, and when are the exams?",
        "Where do I start on Rigid Body?",
        "What comes back at me over the next seven days?",
        "What am I weakest on?",
        "Where will I stand on the day of the exam?",
      ],
      hon: "When it does not know, it says so",
      honp: "An empty list is never a promise. If nothing is due but you have concepts you have never opened and an exam coming, it tells you — instead of answering «you are all set». If there is not enough evidence to call a concept weak, it says it does not know, not that everything is fine. And counts never turn into percentages: «one at risk, two never seen» is something you can check; «you are at 62%» is not.",
      rev: "You can revoke at any time from the app. Revoking consent closes every session and deletes the stored digest. The review that counts still happens here: closed-book, in your own handwriting.",
    };
  return `<!doctype html><html lang="${it ? "it" : "en"}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t.h)} — Fluera</title>
<style>body{font-family:system-ui,sans-serif;margin:0;background:#F6F7F9;color:#1B2030;line-height:1.6}
main{max-width:38rem;margin:0 auto;padding:3rem 1.25rem 4rem}
h1{font-size:1.7rem;line-height:1.2;margin:0 0 .75rem}h2{font-size:1.05rem;margin:2rem 0 .5rem}
p,li{color:#5C6475}ol{padding-left:1.2rem}li{margin-bottom:.4rem}
code{background:#EEF0F5;border-radius:5px;padding:.15em .4em;font-size:.9em;word-break:break-all}
.note{margin-top:2rem;padding-top:1rem;border-top:1px solid #DDE1E9;font-size:.9rem}\nul.ask{list-style:none;padding:0;margin:.5rem 0 0}\nul.ask li{margin:0 0 .5rem;padding:.5rem .8rem;background:#EEF0F5;border-radius:8px;color:#1B2030}
@media(prefers-color-scheme:dark){body{background:#101319;color:#E8EAF1}p,li{color:#9AA3B5}code{background:#1F2532}.note{border-color:#2A3040}ul.ask li{background:#1A1F29;color:#E8EAF1}}</style>
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
<h2>${esc(t.ask)}</h2>
<p>${esc(t.askp)}</p>
<ul class="ask">${t.q.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>
<h2>${esc(t.hon)}</h2>
<p>${esc(t.honp)}</p>
<p class="note">${esc(t.rev)}</p>
</main></body></html>`;
}
