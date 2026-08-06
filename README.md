# fluera-seed-share — bersaglio di deploy, NON la sorgente

⚠️ **Non modificare i file qui.** La sorgente di verità è il monorepo privato:
`Fluera/supabase/functions/seed-share/index.ts`. Questo repo è solo il bersaglio
da cui Deno Deploy costruisce l'app `fluera-seed-share` (org `lorencoshametaj`),
che serve **share.fluera.dev**.

Una modifica fatta qui verrebbe sovrascritta al prossimo allineamento, e nel
frattempo il dominio servirebbe codice che non esiste nel monorepo — che è
esattamente com'è rimasto fermo al 22 giugno per mesi, senza che si vedesse.

## Come si aggiorna

Copia `index.ts` (e `deno.json`) dal monorepo, committa, pusha. Deno Deploy
costruisce dal branch di default. L'entrypoint configurato sull'app è
`index.ts`, working directory vuota.

**Non usare `deno deploy` da CLI su quest'app**: l'upload diretto si pianta
nello step `Prepare` (misurato più volte il 5-6 agosto 2026) perché l'app è
configurata per costruire da Git, non da un caricamento.

## Segreti

Nessun segreto sta nel codice: tutti da `Deno.env` (`SUPABASE_URL`,
`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ANDROID_PACKAGE`,
`APPLE_TEAM_ID`, `APPLE_APP_ID`, `ANDROID_SHA256`), impostati nelle Env
Variables dell'app su console.deno.com. I default cablati sono valori pubblici.
