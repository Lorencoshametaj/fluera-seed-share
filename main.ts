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

const BUCKET = "public-study-seeds";
const SITE = "https://fluera.dev";
const BUNDLE_ID = Deno.env.get("ANDROID_PACKAGE") ?? "com.fluera.fluera";
const APPLE_TEAM_ID = Deno.env.get("APPLE_TEAM_ID") ?? "7T5647HRV6";
const APPLE_APP_ID = Deno.env.get("APPLE_APP_ID") ?? ""; // numeric store id, when published
const ANDROID_SHA256 = Deno.env.get("ANDROID_SHA256") ??
  "EB:AD:BC:7F:CB:BA:F4:A6:B7:B5:62:8B:50:92:50:F8:28:B7:9D:A3:0B:76:92:BC:61:B7:81:FD:C6:4C:EE:C2";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
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
  const path = new URL(req.url).pathname;

  // ── Deep-link verification (App / Universal Links claim share.fluera.dev) ──
  if (path.endsWith("/.well-known/apple-app-site-association")) {
    return json({
      applinks: { apps: [], details: [{ appID: `${APPLE_TEAM_ID}.${BUNDLE_ID}`, paths: ["/s/*"] }] },
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

  // ── /s/{hash} (tolerate any function-name prefix Supabase may prepend) ──
  const m = path.match(new RegExp(`/s/(${HASH_RE.source})/?$`));
  if (!m) return Response.redirect(SITE, 302);
  const hash = m[1];

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return html(500, statusPage("Errore", "Server non configurato."));
  }
  const row = await fetchTemplate(hash);
  if (!row) return html(410, statusPage("Non più disponibile", "Questo template è stato rimosso o non è più pubblico."));

  const ogImageUrl = row.og_path
    ? publicUrl(row.og_path)
    : row.thumb_path
      ? publicUrl(row.thumb_path)
      : OG_FALLBACK;
  const platform = classify(req.headers.get("user-agent") ?? "");
  return html(200, renderPage(row, hash, ogImageUrl, platform));
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

// ── Rendering ───────────────────────────────────────────────────────────────

function renderPage(row: SeedRow, hash: string, ogImageUrl: string, platform: "ios" | "android" | "other"): string {
  const self = `https://share.fluera.dev/s/${hash}`;
  const title = (row.title ?? "Template di studio").trim() || "Template di studio";
  const author = row.is_official ? "Fluera" : row.author_code ? `@${row.author_code.slice(0, 8)}` : "Anonimo";
  const concepts = Math.max(0, row.concept_count ?? 0);
  const installs = Math.max(0, row.install_count ?? 0);
  const rating = (row.rating_count ?? 0) > 0 ? (row.rating_sum ?? 0) / (row.rating_count ?? 1) : 0;
  const description = (row.description ?? "").trim() ||
    `Un template di studio${row.discipline ? ` di ${row.discipline}` : ""} con ${concepts} concett${concepts === 1 ? "o" : "i"}. Installalo in Fluera e parte un ripasso programmato — il trapianto cognitivo nel tuo modello di studio.`;

  const playUrl = `https://play.google.com/store/apps/details?id=${BUNDLE_ID}&referrer=${encodeURIComponent(`s=${hash}`)}`;
  const iosUrl = APPLE_APP_ID ? `https://apps.apple.com/app/id${APPLE_APP_ID}#s=${hash}` : SITE;
  // Mobile primary CTA = this same https URL: the app intercepts it (Universal /
  // App Link on share.fluera.dev) when installed; otherwise the browser reloads
  // this page and the store buttons are the fallback.
  const primaryHref = platform === "other" ? SITE : self;
  const primaryLabel = platform === "other" ? "Scopri Fluera" : "Apri in Fluera";

  const chips = [
    row.discipline ? chip(row.discipline) : "",
    concepts > 0 ? chip(`${concepts} concetti`) : "",
    installs > 0 ? chip(`${fmt(installs)} installazioni`) : "",
    rating > 0 ? chip(`★ ${rating.toFixed(1)}`) : "",
  ].join("");

  return `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)} · Fluera</title>
  <meta name="description" content="${esc(description)}" />
  <link rel="canonical" href="${esc(self)}" />
  <meta property="og:type" content="article" />
  <meta property="og:site_name" content="Fluera" />
  <meta property="og:url" content="${esc(self)}" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:image" content="${esc(ogImageUrl)}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="${esc(title)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(title)}" />
  <meta name="twitter:description" content="${esc(description)}" />
  <meta name="twitter:image" content="${esc(ogImageUrl)}" />
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
    <p class="desc">${esc(description)}</p>
    <div class="cta">
      <a class="btn primary" href="${esc(primaryHref)}">${esc(primaryLabel)}</a>
      <a class="btn ghost" href="${esc(playUrl)}">Google Play</a>
      ${APPLE_APP_ID ? `<a class="btn ghost" href="${esc(iosUrl)}">App Store</a>` : ""}
    </div>
    <p class="note">Installando in Fluera, i concetti di questo template vengono trapiantati nel tuo modello di studio — con un ripasso programmato per domani.</p>
  </div>
</body>
</html>`;
}

const chip = (s: string) => `<span class="chip">${esc(s)}</span>`;

function statusPage(headline: string, body: string): string {
  return `<!doctype html><html lang="it"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><meta name="robots" content="noindex" /><title>${esc(headline)} · Fluera</title><style>body{margin:0;background:#0a0a0b;color:#f4f4f5;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center}div{max-width:420px;padding:24px}h1{font-size:22px;margin:0 0 8px}p{color:#a1a1aa;margin:0 0 20px}a{color:#818cf8}</style></head><body><div><h1>${esc(headline)}</h1><p>${esc(body)}</p><a href="${SITE}">Vai a Fluera →</a></div></body></html>`;
}

// ── utils ─────────────────────────────────────────────────────────────────────

function classify(ua: string): "ios" | "android" | "other" {
  if (/iphone|ipad|ipod/i.test(ua)) return "ios";
  if (/android/i.test(ua)) return "android";
  return "other";
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
