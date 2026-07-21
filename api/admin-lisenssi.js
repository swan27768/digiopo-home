// ═══════════════════════════════════════════════════════════════════════════
//  ⚠️  JAETTU TIETOKANTA – LUE TÄMÄ ENNEN MUUTOKSIA
//
//  Tämä tiedosto kirjoittaa `lisenssit`-tauluun, jota käyttää MYÖS toinen
//  projekti: digiopo (app.digiopo.fi). Taulun skeema ja rajoitteet asuvat
//  siellä: digiopo/supabase_schema.sql ja digiopo/docs/03-tietokanta.md.
//
//  Rajoitteet joihin tämä nojaa: koodi NOT NULL UNIQUE, tyyppi-CHECK
//  ('testi'|'vuosi'|'kunta'|'opettaja') ja uniikki osittainen indeksi
//  lisenssit_opettaja_email_idx (yksi opettajalisenssi per sähköposti).
//
//  Jos muutat kannan rajoitteita, tarkista MOLEMMAT projektit.
// ═══════════════════════════════════════════════════════════════════════════

// DigiOpo – Lisenssin luonti hallintapaneelista
//
// GET  /api/admin-lisenssi?action=koulut
//      Header: x-admin-key
//      → { ok, koulut: ["Mäyrälän koulu", ...] }
//        Olemassa olevat koulunimet ehdotuksiksi. Estää kirjoitusvirheen,
//        joka johtaisi siihen ettei opettaja näe oppilaidensa töitä.
//
// POST /api/admin-lisenssi
//      Header: x-admin-key
//      Body: { tyyppi, koulu, yhteyshenkilo, email, voimassa_asti, paikat }
//      → { ok, koodi }
//
// MIKSI TÄMÄ ON OLEMASSA: tilauslomake luo lisenssin vain oikean tilauksen
// yhteydessä ja lähettää aina laskun. Kokeilulisenssit, pilottikoulut ja
// erikoistapaukset jouduttiin siksi luomaan käsin SQL:llä Supabasessa.
// Tämä endpoint tekee saman ilman laskutusta ja ilman SQL-osaamista.
//
// EI LÄHETÄ SÄHKÖPOSTIA. Koodi palautetaan paneeliin, ja välität sen itse.
// Näin testiluonti ei koskaan lähetä oikeaa viestiä vahingossa.
//
// Ympäristömuuttujat:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY  – jo käytössä tilaus.js:ssä
//   ADMIN_DASHBOARD_KEY                 – sama arvo kuin app.digiopo.fi:ssä

import crypto from 'node:crypto';
import { kirjaaVirhe } from './_lib/virhelogi.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_DASHBOARD_KEY = process.env.ADMIN_DASHBOARD_KEY;

// HUOM: '*' eikä origin-lista, kuten muissakin admin-rajapinnoissa
// (admin-tilastot.js, admin-viesti.js, jarjestys.js). Perustelu: valtuutus
// tulee x-admin-key-otsakkeesta EIKÄ evästeestä, ja selain kieltää '*':n
// yhdistämisen credentials-tilaan. Origin ei siis ole turvaraja täällä.
//
// Käytännön syy: hallintapaneelia käytetään myös paikallisena kopiona
// (file://), jolloin origin on 'null' eikä osuisi mihinkään sallittuun
// listaan – ja koko toiminto olisi käyttökelvoton työpöydältä.
const CORS_ORIGIN = '*';

// Sallitut tyypit. HUOM: 'kunta' ja 'vuosi' toimivat pääsyn kannalta
// identtisesti – ks. docs/06-lisenssit.md. Ero on raportoinnissa.
const TYYPIT = new Set(['vuosi', 'kunta', 'testi', 'opettaja']);

// Ei sekaantuvia merkkejä (ei I, O, 0, 1, L) – koodi on sanottava puhelimessa.
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function satunnainen(pituus) {
  return Array.from({ length: pituus }, () =>
    CHARS[crypto.randomInt(CHARS.length)]
  ).join('');
}

// Sama muoto kuin tilaus.js:ssä, jotta käsin ja automaattisesti luodut
// koodit näyttävät samalta eikä alkuperää voi päätellä koodista.
function generoi_koodi(tyyppi, koulu) {
  const vuosi = new Date().getFullYear() + 1;
  if (tyyppi === 'opettaja') return `OPE-${vuosi}-${satunnainen(6)}`;
  const sana = (koulu || '').trim().split(/\s+/)[0].toUpperCase();
  const puhdas = sana.replace(/[^A-ZÄÖÅ0-9]/g, '') || 'KOULU';
  return `${puhdas}-${vuosi}-${satunnainen(4)}`;
}

// Vakioaikainen vertailu: vastausaika ei saa paljastaa montako merkkiä osui.
function vertaaSalaisuus(annettu, oikea) {
  if (typeof annettu !== 'string' || typeof oikea !== 'string' || !oikea) return false;
  const a = Buffer.from(annettu, 'utf8');
  const b = Buffer.from(oikea, 'utf8');
  if (a.length !== b.length) { crypto.timingSafeEqual(b, b); return false; }
  return crypto.timingSafeEqual(a, b);
}

async function sb(polku, opts = {}) {
  const base = SUPABASE_URL.replace(/\/$/, '');
  return fetch(`${base}/rest/v1/${polku}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(opts.headers || {}),
    },
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ ok: false, virhe: 'palvelin_ei_konfiguroitu' });
  }
  if (!ADMIN_DASHBOARD_KEY) {
    // Fail-closed: ilman avainta endpoint ei toimi lainkaan. Lisenssien
    // luonti on liian merkittävä toiminto avattavaksi vahingossa.
    return res.status(500).json({ ok: false, virhe: 'admin_avain_puuttuu' });
  }
  if (!vertaaSalaisuus(String(req.headers['x-admin-key'] || ''), ADMIN_DASHBOARD_KEY)) {
    return res.status(401).json({ ok: false, virhe: 'ei_valtuutusta' });
  }

  try {
    // ── GET ?action=koulut: koulunimet ehdotuksiksi ───────────────────────
    // ── GET ?action=lista:  lisenssit yhteystietoineen ────────────────────
    if (req.method === 'GET') {
      const action = String(req.query?.action || 'koulut');

      if (action === 'lista') {
        const r = await sb(
          'lisenssit?select=koodi,koulu,yhteyshenkilö,email,tyyppi,voimassa_asti,aktiivinen,paikat,luotu_at' +
          ',laskunumero,lasku_pvm,maksettu,taysi_voimassa_asti' +
          '&order=voimassa_asti.asc'
        );
        if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
        const rivit = await r.json();

        // Laitemäärä 30 pv:ltä lisenssi_kaytto-näkymästä. Jos näkymä puuttuu,
        // lista toimii silti – seurantaluku on lisätieto, ei edellytys.
        let kaytto = {};
        try {
          const k = await sb('lisenssi_kaytto?select=koodi,laitteita_30pv,ylikaytto');
          if (k.ok) for (const x of await k.json()) kaytto[x.koodi] = x;
        } catch { /* ohitetaan */ }

        const tanaan = new Date();
        const lisenssit = rivit.map(x => {
          const loppu = new Date(x.voimassa_asti);
          const paivia = Math.ceil((loppu - tanaan) / 86400000);
          return {
            ...x,
            paivia_jaljella: paivia,
            vanhentunut: paivia < 0,
            pian_vanhenee: paivia >= 0 && paivia <= 30,
            laitteita_30pv: kaytto[x.koodi]?.laitteita_30pv ?? null,
            ylikaytto: kaytto[x.koodi]?.ylikaytto ?? null,
          };
        });
        return res.status(200).json({ ok: true, lisenssit });
      }

      const r = await sb('lisenssit?select=koulu&order=koulu.asc');
      if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
      const rivit = await r.json();
      const koulut = [...new Set(rivit.map(x => x.koulu).filter(Boolean))];
      return res.status(200).json({ ok: true, koulut });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, virhe: 'metodi_ei_sallittu' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

    // ── Maksun kuittaus: jatka voimassaolo ostettuun kauteen ────────────────
    //
    // Tilaus luo lisenssin 30 päivän voimassaololla, jottei maksamaton tilaus
    // anna vuoden pääsyä. Kun lasku on maksettu, voimassaolo jatketaan tähän:
    // taysi_voimassa_asti laskettiin tilaushetkellä (tilauspäivä + ostettu
    // kausi), joten asiakas saa sen mitä osti eikä maksun viivästyminen
    // lyhennä hänen kauttaan.
    if (String(body.toiminto || '') === 'merkitse_maksetuksi') {
      const koodi = String(body.koodi || '').trim();
      if (!koodi) return res.status(400).json({ ok: false, virhe: 'koodi_puuttuu' });

      const haku = await sb(
        `lisenssit?koodi=eq.${encodeURIComponent(koodi)}` +
        `&select=id,koodi,koulu,voimassa_asti,taysi_voimassa_asti,maksettu&limit=1`
      );
      if (!haku.ok) throw new Error(`Supabase ${haku.status}: ${await haku.text()}`);
      const [rivi] = await haku.json();

      if (!rivi) return res.status(200).json({ ok: false, virhe: 'lisenssia_ei_loydy' });
      if (rivi.maksettu) return res.status(200).json({ ok: false, virhe: 'jo_maksettu' });
      if (!rivi.taysi_voimassa_asti) {
        return res.status(200).json({ ok: false, virhe: 'taysi_kausi_puuttuu' });
      }

      const p = await sb(`lisenssit?id=eq.${encodeURIComponent(rivi.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          voimassa_asti: rivi.taysi_voimassa_asti,
          maksettu: true,
        }),
      });
      if (!p.ok) throw new Error(`Supabase ${p.status}: ${await p.text()}`);

      return res.status(200).json({
        ok: true,
        koodi: rivi.koodi,
        koulu: rivi.koulu,
        voimassa_asti: rivi.taysi_voimassa_asti,
      });
    }

    const tyyppi        = String(body.tyyppi || '').trim();
    const koulu         = String(body.koulu || '').trim();
    const yhteyshenkilo = String(body.yhteyshenkilo || '').trim();
    const email         = String(body.email || '').trim().toLowerCase();
    const voimassa_asti = String(body.voimassa_asti || '').trim();
    const paikat        = body.paikat === '' || body.paikat == null
      ? null : Number(body.paikat);

    // ── Validointi ────────────────────────────────────────────────────────
    if (!TYYPIT.has(tyyppi)) {
      return res.status(400).json({ ok: false, virhe: 'virheellinen_tyyppi' });
    }
    if (!koulu || koulu.length > 100) {
      return res.status(400).json({ ok: false, virhe: 'koulu_puuttuu' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(voimassa_asti)) {
      return res.status(400).json({ ok: false, virhe: 'virheellinen_paivamaara' });
    }
    if (new Date(voimassa_asti) <= new Date()) {
      return res.status(400).json({ ok: false, virhe: 'paivamaara_menneisyydessa' });
    }
    if (paikat !== null && (!Number.isInteger(paikat) || paikat < 1)) {
      return res.status(400).json({ ok: false, virhe: 'virheellinen_paikkamaara' });
    }
    // Opettajalisenssi tunnistetaan sähköpostista – ilman sitä se on hyödytön.
    if (tyyppi === 'opettaja' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok: false, virhe: 'email_pakollinen_opettajalle' });
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok: false, virhe: 'virheellinen_email' });
    }

    // ── Opettajalisenssi: yksi per sähköposti ─────────────────────────────
    // Kannassa on uniikki osittainen indeksi (lisenssit_opettaja_email_idx).
    // Kerrotaan tästä selkeästi eikä anneta tietokantavirheen vuotaa läpi.
    if (tyyppi === 'opettaja') {
      const r = await sb(
        `lisenssit?email=eq.${encodeURIComponent(email)}&tyyppi=eq.opettaja&select=koodi,voimassa_asti&limit=1`
      );
      if (r.ok) {
        const [olemassa] = await r.json();
        if (olemassa) {
          return res.status(200).json({
            ok: false,
            virhe: 'opettajalisenssi_on_jo',
            koodi: olemassa.koodi,
            voimassa_asti: olemassa.voimassa_asti,
          });
        }
      }
    }

    // ── Luonti: 3 yritystä koodin törmäyksen varalta ──────────────────────
    let koodi = null;
    let viimeisinVirhe = null;
    for (let yritys = 0; yritys < 3; yritys++) {
      koodi = generoi_koodi(tyyppi, koulu);
      const r = await sb('lisenssit', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          koodi,
          koulu,
          yhteyshenkilö: yhteyshenkilo || null,
          email: email || null,
          tyyppi,
          voimassa_asti,
          paikat,
          aktiivinen: true,
          // Käsin luodusta lisenssistä ei ole laskua, joten se on lähtökohtaisesti
          // "maksettu" – muuten se ilmestyisi perintätyöjonoon.
          maksettu: true,
        }),
      });
      if (r.ok) {
        return res.status(200).json({ ok: true, koodi, tyyppi, koulu, voimassa_asti });
      }
      viimeisinVirhe = `Supabase ${r.status}: ${await r.text()}`;
    }
    throw new Error(viimeisinVirhe || 'Lisenssin luonti epäonnistui');
  } catch (err) {
    console.error('admin-lisenssi:', err.message);
    await kirjaaVirhe('admin-lisenssi', err);
    return res.status(500).json({ ok: false, virhe: 'palvelinvirhe' });
  }
}
