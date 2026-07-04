// DigiOpo Home – Jaettu virhelokitusapuri
// Sama toiminto kuin digiopo-projektin api/_lib/virhelogi.js:ssä. Kirjaa virheet
// Supabasen api_virheet-tauluun admin-paneelin "Vikatilanteet"-osiota varten.
//
// HUOM: aja supabase_admin_virheet.sql:n sisältö (digiopo-projektista) myös
// SIIHEN Supabase-projektiin, jota tämän tiedoston SUPABASE_URL osoittaa.
//
// TÄRKEÄÄ: lokitus ei koskaan saa kaataa varsinaista pyyntöä.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export async function kirjaaVirhe(endpoint, err, lisatiedot = {}) {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
    const base = SUPABASE_URL.replace(/\/$/, '');
    const viesti = String(err && err.message ? err.message : err).slice(0, 2000);

    await fetch(`${base}/rest/v1/api_virheet`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ endpoint, viesti, lisatiedot }),
    });
  } catch {
    // Lokituksen epäonnistuminen ei saa vaikuttaa käyttäjän pyyntöön
  }
}
