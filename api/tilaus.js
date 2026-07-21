// DigiOpo – Tilauksen aloitus (verkkomaksu, Paytrail)
// POST /api/tilaus
// Body: { etunimi, sukunimi, email, puhelin, koulu, kunta, oppilasmaara, lisenssikausi, lisatiedot }
//   lisenssikausi: 'vuosi' | '3vuotta' (oletus 'vuosi')
//
// ═══════════════════════════════════════════════════════════════════════════
//  VERKKOMAKSU – MIKSI JÄRJESTYS ON TÄMÄ
//
//  Vanha malli loi lisenssin heti ja lähetti laskun jälkikäteen. Nyt maksu
//  peritään ETUKÄTEEN Paytrailin kautta, ja lisenssi luodaan vasta kun maksu on
//  vahvistettu (api/maksu-callback.js / api/maksu-paluu.js → _lib/tilaus-taytto.js).
//
//  Tämä endpoint siis EI enää luo lisenssiä eikä lähetä sähköpostia. Se:
//    1. validoi tilauksen ja laskee hinnan,
//    2. tallentaa tilauksen `maksut`-tauluun tilassa 'odottaa',
//    3. luo Paytrail-maksun ja palauttaa selaimelle maksusivun URLin (redirectUrl),
//    4. selain ohjaa ostajan Paytrailiin maksamaan.
//
//  Laskunumeroa EI varata täällä – maksamaton tilaus ei saa polttaa juoksevaa
//  laskunumeroa. Numero varataan vasta onnistuneen maksun täytössä.
//
//  Ympäristömuuttujat:
//    SUPABASE_URL, SUPABASE_SERVICE_KEY   – maksut-taulu ja lisenssit
//    PAYTRAIL_MERCHANT_ID, PAYTRAIL_SECRET_KEY – ks. api/_lib/paytrail.js (oletus: testitunnukset)
//    PUBLIC_BASE_URL                      – esim. https://digiopo.fi (redirect/callback-osoitteita varten)
//    RESEND_API_KEY, ADMIN_EMAIL, FROM_EMAIL – sähköpostit (täytössä)
// ═══════════════════════════════════════════════════════════════════════════

import { kirjaaVirhe } from './_lib/virhelogi.js';
import { luoMaksu } from './_lib/paytrail.js';
import { laskeHinta, bruttoSentteina } from './_lib/tilaus-taytto.js';
import crypto from 'node:crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Sallitut originit. Käytetään sekä CORS-otsakkeeseen että redirect/callback-
// osoitteen johtamiseen (maksun jälkeen ostaja palaa samaan domainiin josta lähti).
const SALLITUT_ORIGINIT = new Set([
  'https://digiopo.fi',
  'https://www.digiopo.fi',
]);
const OLETUS_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://digiopo.fi';

// ─── Rate limit (muistipohjainen; tilaus on harvinainen, matalavolyyminen) ───
const tilausYritykset = new Map();
const TILAUS_MAX = 5;
const TILAUS_IKKUNA_MS = 10 * 60 * 1000;

function haeIp(req) {
  const real = String(req.headers['x-real-ip'] || '').trim();
  if (real) return real;
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || 'tuntematon';
}

function rateLimitSallittu(ip) {
  const nyt = Date.now();
  const m = tilausYritykset.get(ip) || { maara: 0, alku: nyt };
  if (nyt - m.alku > TILAUS_IKKUNA_MS) { tilausYritykset.set(ip, { maara: 1, alku: nyt }); return true; }
  if (m.maara >= TILAUS_MAX) return false;
  tilausYritykset.set(ip, { maara: m.maara + 1, alku: m.alku });
  return true;
}

// Tallentaa odottavan maksun ja palauttaa luodun rivin (return=representation),
// jotta saamme id:n talteen. RLS estää selaimen pääsyn – tämä kulkee service_rolella.
async function tallennaMaksu(rivi) {
  const baseUrl = SUPABASE_URL.replace(/\/$/, '');
  const vastaus = await fetch(`${baseUrl}/rest/v1/maksut`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(rivi),
  });
  if (!vastaus.ok) throw new Error(`Supabase ${vastaus.status}: ${await vastaus.text()}`);
  const [luotu] = await vastaus.json();
  return luotu;
}

async function paivitaMaksu(stamp, data) {
  const baseUrl = SUPABASE_URL.replace(/\/$/, '');
  const vastaus = await fetch(
    `${baseUrl}/rest/v1/maksut?stamp=eq.${encodeURIComponent(stamp)}`,
    {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(data),
    }
  );
  if (!vastaus.ok) throw new Error(`Supabase ${vastaus.status}: ${await vastaus.text()}`);
}

export default async function handler(req, res) {
  // CORS
  const origin = req.headers.origin || '';
  if (SALLITUT_ORIGINIT.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, virhe: 'Metodi ei sallittu' });

  const ip = haeIp(req);
  if (!rateLimitSallittu(ip)) {
    return res.status(429).json({ ok: false, virhe: 'Liian monta tilausta lyhyessä ajassa. Yritä hetken kuluttua uudelleen.' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ ok: false, virhe: 'Virheellinen pyyntö' });
  }

  const { etunimi, sukunimi, email, puhelin, koulu, kunta, oppilasmaara, lisenssikausi, lisatiedot } = body || {};

  // Validointi. Verkkomaksussa EI kysytä laskutustietoja (Y-tunnus, verkkolasku-
  // osoite jne.) – maksu hoituu kortilla / verkkopankissa, joten niitä ei tarvita.
  if (!etunimi?.trim() || !sukunimi?.trim() || !koulu?.trim() || !kunta?.trim() || !oppilasmaara || !email?.trim()) {
    return res.status(400).json({ ok: false, virhe: 'Pakollinen kenttä puuttuu' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, virhe: 'Virheellinen sähköpostiosoite' });
  }
  const maara = parseInt(oppilasmaara, 10);
  if (!Number.isInteger(maara) || maara < 1) {
    return res.status(400).json({ ok: false, virhe: 'Virheellinen oppilasmäärä' });
  }
  const kausi = lisenssikausi === '3vuotta' ? '3vuotta' : 'vuosi';

  // Hinta lasketaan palvelimella – selaimen arviota ei koskaan uskota, koska
  // veloitettava summa määräytyy tästä.
  const hintatiedot = laskeHinta(kausi, maara);
  const summaSentteina = bruttoSentteina(hintatiedot);

  // Puhdas tilausobjekti maksut-riville ja myöhempään täyttöön.
  const tilaus = {
    etunimi: String(etunimi).trim(),
    sukunimi: String(sukunimi).trim(),
    email: String(email).trim().toLowerCase(),
    puhelin: String(puhelin || '').trim(),
    koulu: String(koulu).trim(),
    kunta: String(kunta).trim(),
    oppilasmaara: maara,
    lisenssikausi: kausi,
    lisatiedot: String(lisatiedot || '').trim(),
  };

  const stamp = crypto.randomUUID();
  const reference = stamp; // uniikki, ei paljasta mitään ostajasta

  // 1. Tallenna odottava maksu ENNEN Paytrail-kutsua. Jos Paytrail-kutsu
  //    epäonnistuu, rivi jää tilaan 'odottaa' eikä siitä koidu haittaa
  //    (siivotaan vanhat odottavat rivit erikseen).
  try {
    await tallennaMaksu({
      stamp,
      reference,
      tila: 'odottaa',
      summa_sentteina: summaSentteina,
      tilaus,
    });
  } catch (err) {
    console.error('maksut-rivin tallennus epäonnistui:', err.message);
    await kirjaaVirhe('tilaus maksut-insert', err, { koulu: tilaus.koulu, email: tilaus.email });
    return res.status(500).json({ ok: false, virhe: 'Palvelinvirhe – yritä uudelleen' });
  }

  // Redirect/callback-osoitteet: palataan samaan domainiin josta ostaja lähti.
  const base = SALLITUT_ORIGINIT.has(origin) ? origin : OLETUS_BASE_URL;
  const redirectUrls = { success: `${base}/api/maksu-paluu`, cancel: `${base}/api/maksu-paluu` };
  const callbackUrls = { success: `${base}/api/maksu-callback`, cancel: `${base}/api/maksu-callback` };

  // 2. Luo Paytrail-maksu.
  let maksu;
  try {
    maksu = await luoMaksu({
      stamp,
      reference,
      summaSentteina,
      email: tilaus.email,
      kieli: 'FI',
      redirectUrls,
      callbackUrls,
    });
  } catch (err) {
    console.error('Paytrail-maksun luonti epäonnistui:', err.message);
    await kirjaaVirhe('tilaus paytrail', err, { koulu: tilaus.koulu, email: tilaus.email, stamp });
    await paivitaMaksu(stamp, { tila: 'virhe' }).catch(() => {});
    return res.status(502).json({ ok: false, virhe: 'Maksupalveluun ei juuri nyt saada yhteyttä. Yritä hetken kuluttua uudelleen.' });
  }

  // 3. Talleta transaction_id (jäljitettävyys / täsmäytys Paytrailin kanssa).
  await paivitaMaksu(stamp, { transaction_id: maksu.transactionId }).catch((err) => {
    console.warn('transaction_id-päivitys epäonnistui (ei kriittinen):', err.message);
  });

  // 4. Ohjaa selain Paytrailin maksusivulle.
  return res.status(200).json({ ok: true, redirectUrl: maksu.href });
}
