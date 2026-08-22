# seed-share — the marketplace share/OG + deep-link origin

`index.ts` is a portable **Deno** handler (`Deno.serve`) that powers the
marketplace share link on the branded domain **`share.fluera.dev`**. From ONE
origin it serves:

- `GET /s/{hash}` → the dynamic **OG page** (social unfurl = the worksheet
  preview). Crawlers don't run JS, so the per-template `og:*` tags must be
  server-rendered — a static host (fluera.dev is GitHub Pages) can't do it.
- `GET /s/{hash}/og.png` → the OG card with the LIVE counts baked into pixels.
- `GET /i/{code}` → the **referral redirect** (the end-card / QR link burned
  into every shared time-lapse). UA-sniffs to the right store, carrying the
  code in the Play install referrer. It lives here for the same reason as
  `/s`: `fluera.dev` is static and cannot run it.
- `GET|POST /report` → the public, no-login DSA Art.16 / DMCA takedown intake
  linked from every `/s` page.
- `GET /.well-known/apple-app-site-association` → iOS **Universal Links** claim.
- `GET /.well-known/assetlinks.json` → Android **App Links** claim.

> ⛔ **`supabase functions deploy seed-share` does NOT update
> `share.fluera.dev`.** It deploys a copy that answers at
> `<ref>.supabase.co/functions/v1/seed-share/...` and that nothing points at.
> The branded domain is a **Deno Deploy** project — see below. Deploying only
> to Supabase leaves the live domain silently running the old build.

Because the well-known files sit at the ROOT of the same domain the share link
uses, tapping `share.fluera.dev/s/{hash}` opens the app (when installed +
verified) and otherwise shows the OG page / store buttons.

---

## Why Deno Deploy (recommended), not Supabase Edge Functions / Vercel

`fluera.dev` is **GitHub Pages** (static, can't run server code) and is **not**
behind Cloudflare. The page must live on a serverless host at a **root** path
(so `/.well-known/*` is reachable for App/Universal Links).

- **Deno Deploy** ✅ — runs this exact `Deno.serve` file unchanged, gives a
  custom domain mapped at the **root** (`share.fluera.dev/...`), free.
- Supabase Edge Functions — same Deno code, BUT the public URL keeps the
  `/functions/v1/seed-share` prefix, so `/.well-known/*` can't be at the root →
  deep-link verification breaks. Not suitable for the same-domain deep-link.
- Vercel — would work, but you're staying off it.
- Cloudflare Workers — also great (could even keep everything on `fluera.dev/s/*`)
  but requires moving `fluera.dev` DNS to Cloudflare.

---

## 🚀 Deploy — UN COMANDO

```bash
bash Fluera/supabase/functions/seed-share/deploy.sh
```

Fa il giro che funziona e poi MISURA se il dominio serve davvero il build nuovo
— la domanda che gli altri due percorsi non pongono mai, e l'unica che
distingue «pubblicato» da «funziona». Se manca solo la promozione te lo dice e
ti da' il link alla console.

`bash deploy.sh --solo-controllo` non pubblica: risponde soltanto «come stiamo».

> ⚠️ **Il mirror automatico esiste ma NON gira**: GitHub Actions su `fluera-mono`
> e' fermo per fatturazione (i job non partono affatto — «recent account
> payments have failed or your spending limit needs to be increased»). Il
> workflow, la deploy key e il secret sono tutti a posto e verificati: ripartira'
> da solo il giorno che i minuti tornano. Fino ad allora il comando qui sopra e'
> la via, e **nessuna CI rifa' le verifiche** — l'unico cancello in piedi e'
> l'hook pre-push locale.

## 🪞 Il mirror automatico (quando Actions torna)

**Dal 2026-08-14 non si distribuisce a mano.** `.github/workflows/deploy-seed-share.yml`
rispecchia questa cartella su `Lorencoshametaj/fluera-seed-share` a ogni push su
`main` che la tocchi, e quel repo e' cio' che Deno Deploy costruisce.

> ⚠️ **Rispecchiare non e' promuovere.** Il push fa partire la build, ma la
> revisione entra nelle timeline **Preview** e **Git Branch**: **Production** —
> che possiede `share.fluera.dev` — va promossa **A MANO** dalla console. Non
> esiste un comando CLI (`deno deploy deployments` offre solo `list`). Il
> workflow lo MISURA e lo dice; non finge di averlo fatto.

**Il cancello della deriva.** `mirror_in_sync.sh` risponde a due domande
separate, perche' confonderle e' costato tre giri il 2026-08-13:
- **(A) rispecchiato** — il file qui e' identico a quello del repo pubblicato?
- **(B) promosso** — il dominio serve davvero quel codice? Si misura estraendo
  dal sorgente la lista di path dell'AASA e confrontandola con quella che il
  dominio restituisce: un'impronta del build osservabile da fuori.

Gira **ogni giorno** (la deriva arriva col tempo, non con un push: questo
dominio ha tenuto un build vecchio per MESI) ed e' certificato da
`mirror_in_sync_controls.sh` — 8 difetti seminati, ognuno deve produrre un
rosso, compresi «sorgente troncato» e «rispecchiato ma non promosso».

Il repo pubblicato e' **pubblico**, quindi il cancello non ha bisogno di
credenziali: `bash mirror_in_sync.sh` gira anche in locale, subito.

**Prerequisito del mirror:** il secret `SEED_SHARE_DEPLOY_KEY` in fluera-mono —
la chiave PRIVATA di una deploy key con permesso di scrittura su
`Lorencoshametaj/fluera-seed-share`. Deploy key e non PAT per la stessa ragione
di `deploy-landing.yml`: un PAT scade, e il giorno che scade la funzione smette
di aggiornarsi in silenzio.

---

## Deploy a mano (ripiego, se il mirror e' rotto)

**Live target (verified 2026-08-05):** org `lorencoshametaj`, app
`fluera-seed-share` → `fluera-seed-share.lorencoshametaj.deno.net`, with
`share.fluera.dev` mapped onto it (same A/AAAA records: `69.67.170.170` /
`2602:f70f::1`).

> ⚠️ **NOT `deployctl`.** `deployctl` targets the *classic* Deno Deploy
> (`dash.deno.com`, `*.deno.dev`), a different product. Against this app it
> just loops on "Provisioning a new access token… Waiting for authorization",
> because the token/app live on the new platform. The new platform's CLI is
> **built into Deno ≥ 2.5**: `deno deploy`. It uploads a **directory**, not a
> single file.

1. Deploy — run from **this directory** (`Fluera/supabase/functions/seed-share/`).
   ⚠️ Non serve piu' dopo ogni modifica: lo fa il mirror. E **non funziona**
   dalla CLI su questa app — si pianta in `Prepare` (working directory `src`
   nella console, file alla radice → aspetta file in una cartella inesistente,
   e dopo 5 minuti esatti la revisione va `cancelled`; 4 tentativi su 4 fra il
   5 e il 13 agosto). La via che funziona e' il **push sul repo pubblicato**:
   ```bash
   cd Fluera/supabase/functions/seed-share
   deno deploy --org lorencoshametaj --app fluera-seed-share --prod
   ```
   Non-interactive (CI / agents): add `--json --non-interactive` and
   authenticate with `DENO_DEPLOY_TOKEN`. Exit codes: 0 OK, 3 AUTH, 4 NOT_FOUND.

   Useful siblings: `deno deploy whoami` (which token/orgs am I?),
   `deno deploy env list --org … --app …`, `deno deploy logs --org … --app …`.

   ⚠️ **The app's BUILD CONFIG lives in the console, and it defaulted to
   `src/main.ts`.** Every `deno deploy` failed at the `building` step with
   `Entrypoint at '/tmp/build/src/main.ts' not found` until it was corrected
   to entrypoint `index.ts` with an EMPTY working directory (2026-08-05). The
   default had gone unnoticed for a year because `deployctl` uploads a
   prebuilt bundle and **skips the build step entirely** — every June revision
   shows `lastStep: "routing"`, never `"building"`. The `deploy.runtime`
   block in `deno.json` here documents the intent, but did NOT override the
   stored console config; fix it in the console (**Edit Config and Retry**) if
   this ever regresses. `deno deploy logs` is RUNTIME logs only — build logs
   are dashboard-only, so a failing build has to be read there.

   **Verify it actually went live** (the domain silently kept an old build
   once — the symptom was `/report` and `/i/*` 302-ing to the marketing home
   while `/s/{hash}` still worked):
   ```bash
   # must list /s/*, /i/* AND /u/*
   curl -s https://share.fluera.dev/.well-known/apple-app-site-association
   # must 302 to play.google.com/...&referrer=code%3DTEST01
   curl -s -o /dev/null -w '%{redirect_url}\n' \
     -H 'User-Agent: Mozilla/5.0 (Linux; Android 14) Chrome/126 Mobile' \
     https://share.fluera.dev/i/TEST01
   # must be 200 (the DSA form), not a redirect
   curl -s -o /dev/null -w '%{http_code}\n' https://share.fluera.dev/report
   ```

2. **Environment variables** — dashboard (App → Settings → Environment
   Variables) or `deno deploy env add <NAME> <VALUE> --org lorencoshametaj
   --app fluera-seed-share`. Prefer the dashboard for SECRETS so the value
   never lands in your shell history. Set them BEFORE deploying: they apply to
   new revisions.
   ```
   SUPABASE_URL              = https://<ref>.supabase.co
   SUPABASE_ANON_KEY         = <anon public key>
   SUPABASE_SERVICE_ROLE_KEY = <service role key>   # ⚠️ see below
   ANDROID_PACKAGE           = com.fluera.fluera    # (default baked in)
   APPLE_TEAM_ID             = 7T5647HRV6           # (default baked in)
   APPLE_APP_ID              = <numeric App Store id>  # once iOS is published
   ANDROID_SHA256            = <release signing SHA-256>  # see ⚠️ below
   ```
   (`SUPABASE_*` are NOT auto-injected on Deno Deploy — set them.)

   🔓 **`ANDROID_STORE_LIVE`** — `"true"` SOLO quando l'app è pubblicamente
   installabile su Play (open testing o produzione). Finché è assente/false,
   `/get` e `/i/{code}` mandano a `fluera.dev/beta` invece che allo store:
   mandare allo store durante l'internal testing produce un 404 di Play, cioè
   un QR che dichiara «questa app non esiste» — peggio della homepage. Questa
   è **l'unica variabile da cambiare** il giorno dell'apertura: ogni QR già
   bruciato nei pixel (video pubblicati, immagini condivise) comincia a
   funzionare da solo, senza ristampare nulla. È il motivo per cui i QR
   puntano a un reindirizzatore e mai a una destinazione finale.

   ⚠️ **`SUPABASE_SERVICE_ROLE_KEY` is required by two routes** and both fail
   SILENTLY-ish without it, so its absence looks like "no traffic" rather than
   "misconfigured":
   - `POST /report` → returns 500 "Server non configurato" (the DSA/DMCA
     intake is dead while the link is shown on every share page);
   - `GET /i/{code}` click logging → `logReferralClick` returns early, so
     `referral_clicks` stays empty and the top of the k-funnel reads as zero.

   It is a **secret**: it bypasses RLS. It is used ONLY for two validated
   writes (the `file_takedown_notice` RPC and the `referral_clicks` insert),
   never echoed into a response.

3. **Custom domain** → `share.fluera.dev` is ALREADY mapped (Domains tab).
   Only needed when standing up a new app: add the domain, create the DNS
   record it shows at the registrar where `fluera.dev` lives (Porkbun), and
   wait for the TLS cert.

4. Point the app at it (already done in code):
   - share link: `https://share.fluera.dev/s/{hash}` (`study_seed_publish_actions.dart`)
   - Android App Link host + iOS `applinks:share.fluera.dev` (manifest + entitlements)
   - `PublicShareLinkHandler.seedHashOf` accepts the host.

## ⚠️ assetlinks SHA must match the app's SIGNING cert

`ANDROID_SHA256` (and the baked-in default) must be the SHA-256 of the cert that
signs the **installed** build. The default is the existing release fingerprint.
A **debug** build is signed with a different cert → App Links won't auto-verify
on a debug install, and the link opens the browser instead of the app. To test
tap-to-install on debug, either add your debug-keystore SHA-256 to
`ANDROID_SHA256` (comma-separate in the function's assetlinks array), or test the
custom scheme: `adb shell am start -a android.intent.action.VIEW -d "fluera://s/<hash>"`.

## Verify after deploy

```bash
curl -s https://share.fluera.dev/.well-known/assetlinks.json
curl -s https://share.fluera.dev/.well-known/apple-app-site-association
curl -sI https://share.fluera.dev/s/<hash>           # 200 + text/html
```
Then run a real hash through https://developers.facebook.com/tools/debug/ to see
the og:image unfurl.
