import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { kirjaaVirhe } from './_lib/virhelogi.js';

// ═══════════════════════════════════════════════════════════════════════════
//  ⚠️  JAETTU TIETOKANTA – LUE TÄMÄ ENNEN MUUTOKSIA
//
//  Tämä tiedosto kirjoittaa `lisenssit`-tauluun, jota käyttää MYÖS toinen
//  projekti: digiopo (app.digiopo.fi). Taulun skeema ja rajoitteet asuvat
//  siellä, EIVÄT täällä:
//
//      digiopo/supabase_schema.sql          – lisenssit-taulu ja rajoitteet
//      digiopo/docs/03-tietokanta.md        – taulut ja ajojärjestys
//      digiopo/docs/06-lisenssit.md         – lisenssien elinkaari
//
//  RAJOITTEET JOIHIN TÄMÄ TIEDOSTO NOJAA:
//
//    · koodi   NOT NULL, UNIQUE
//              → myös opettajalisenssille on generoitava koodi, vaikka
//                kirjautuminen tapahtuu sähköpostilla. Tämä puuttui aiemmin
//                ja kaatoi jokaisen opettajalisenssitilauksen.
//
//    · tyyppi  CHECK ('testi' | 'vuosi' | 'kunta' | 'opettaja')
//              → uusi tyyppi on lisättävä rajoitteeseen digiopo-repossa.
//
//    · lisenssit_opettaja_email_idx  UNIQUE (email) WHERE tyyppi='opettaja'
//              → yksi opettajalisenssi per sähköposti. Uusintatilaus PÄIVITTÄÄ
//                olemassa olevaa riviä; uusi INSERT kaatuisi indeksiin.
//
//  Jos muutat kannan rajoitteita, tarkista MOLEMMAT projektit. Näin ei tehty
//  kertaalleen, ja uniikki-indeksi olisi kaatanut uusintatilaukset hiljaa –
//  asiakas olisi nähnyt vain "Palvelinvirhe – yritä uudelleen".
// ═══════════════════════════════════════════════════════════════════════════

// DigiOpo – Tilausten automaattinen käsittely
// POST /api/tilaus
// Body: { etunimi, sukunimi, email, puhelin, koulu, kunta, oppilasmaara, tilaustyyppi, lisenssikausi, lisatiedot }
//   lisenssikausi: 'vuosi' | '3vuotta' – koskee vain koululisenssiä, oletus 'vuosi'
// Luo lisenssin Supabaseen ja lähettää sähköpostin koululle + adminille.
//
// Ympäristömuuttujat (Vercel Dashboard → Settings → Environment Variables):
//   SUPABASE_URL          – Supabase-projektin URL
//   SUPABASE_SERVICE_KEY  – Supabase service_role -avain
//   RESEND_API_KEY        – Resend-palvelun API-avain (resend.com)
//   ADMIN_EMAIL           – Sinun sähköpostisi (tilausilmoitukset)
//   FROM_EMAIL            – Lähettäjä, esim. noreply@digiopo.fi (täytyy olla vahvistettu Resendissä)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@digiopo.fi';

// Sallitut originit (lisää tarvittaessa)
const SALLITUT_ORIGINIT = new Set([
  'https://digiopo.fi',
  'https://www.digiopo.fi',
]);

// ─── Rate limit (muistipohjainen; tilaus on harvinainen, matalavolyyminen) ───
// Estää saman IP:n tilaustulvan. Instanssikohtainen laskuri riittää tähän.
const tilausYritykset = new Map();
const TILAUS_MAX = 5;                     // tilausta per IP
const TILAUS_IKKUNA_MS = 10 * 60 * 1000;  // 10 min

function haeIp(req) {
  // Vercelin x-real-ip on luotettava (ei väärennettävissä).
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

// Duplikaattisuoja (luotettava, jaettu Supabasen kautta): jos samalle
// sähköpostille on luotu lisenssi viimeisen 3 min aikana, kyseessä on lähes
// varmasti kaksoislähetys (tuplaklikkaus / uudelleenlataus) → ei luoda toista
// lisenssiä eikä laskua. Fail-open: jos tarkistus ei onnistu, tilaus etenee.
// HUOM: suodatetaan myös tyypin mukaan. Aiemmin tarkistus katsoi pelkkää
// sähköpostia, jolloin sama henkilö ei voinut tilata koululisenssiä ja
// opettajalisenssiä kolmen minuutin sisällä – jälkimmäinen kuitattiin
// duplikaatiksi, asiakas näki onnistumisen eikä lisenssiä syntynyt.
async function onTuoreDuplikaatti(emailNorm, tyyppi) {
  const baseUrl = SUPABASE_URL.replace(/\/$/, '');
  const raja = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const r = await fetch(
    `${baseUrl}/rest/v1/lisenssit?email=eq.${encodeURIComponent(emailNorm)}` +
    `&tyyppi=eq.${encodeURIComponent(tyyppi)}&luotu_at=gte.${raja}&select=id&limit=1`,
    { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
  );
  if (!r.ok) return false;
  const rivit = await r.json();
  return Array.isArray(rivit) && rivit.length > 0;
}

// Hakee olemassa olevan opettajalisenssin sähköpostilla. Uusintatilaus
// päivittää tätä riviä eikä luo uutta – kannassa on uniikki-indeksi
// (lisenssit_opettaja_email_idx), joka sallii yhden opettajalisenssin
// per sähköposti, ja api/lisenssi.js valitsisi duplikaateista mielivaltaisen.
async function hae_opettajalisenssi(emailNorm) {
  const baseUrl = SUPABASE_URL.replace(/\/$/, '');
  const r = await fetch(
    `${baseUrl}/rest/v1/lisenssit?email=eq.${encodeURIComponent(emailNorm)}` +
    `&tyyppi=eq.opettaja&select=id,koodi,voimassa_asti&limit=1`,
    { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
  );
  if (!r.ok) return null;
  const [rivi] = await r.json();
  return rivi || null;
}

// ─── Hinnasto (pidä synkassa hinnasto.html / tilauslomake.html kanssa) ───────
const HINTA = {
  vuosi:     { hinta: 5.90,  minimi: 120 },
  '3vuotta': { hinta: 14.90, minimi: 360 },
  opettaja:  { hinta: 49,    minimi: 0 },
};
const ALV = 0.135;

// ─── Laskuttajan tiedot ───────────────────────────────────────────────────────
const LASKUTTAJA = {
  nimi:        'DigiOpo Palvelut',
  ytunnus:     '3540305-3',
  osoite:      'Herttuantie 1',
  postiosoite: '01520 Vantaa',
  iban:        'FI12 7997 7996 9947 81',
  bic:         'HOLVFIHH',
  maksuaika:   14,
};

// ─── Laskutustietojen validointi ─────────────────────────────────────────────
//
// Nämä tarkistukset ovat myös tilauslomake.html:ssä, mutta selainvalidointi on
// käyttömukavuutta – ei suojaa. Lomakkeen ohi voi lähettää mitä tahansa suoraan
// rajapintaan, ja puutteellinen laskutustieto huomataan vasta kun laskua
// yritetään lähettää viikkoja myöhemmin.

const LASKUTUSKENTAT = [
  'laskutus_nimi',
  'laskutus_ytunnus',
  'laskutus_verkkolaskuosoite',
  'laskutus_valittajatunnus',
  'laskutus_viitteenne',
];

// Suomalaisen Y-tunnuksen tarkistusmerkki (mod 11, painot 7-9-10-5-8-4-2)
function ytunnusKelpaa(arvo) {
  const m = String(arvo || '').trim().replace(/\s/g, '').match(/^(\d{7})-?(\d)$/);
  if (!m) return false;
  const painot = [7, 9, 10, 5, 8, 4, 2];
  const summa = m[1].split('').reduce((a, d, i) => a + Number(d) * painot[i], 0);
  const jaannos = summa % 11;
  if (jaannos === 1) return false;
  return (jaannos === 0 ? 0 : 11 - jaannos) === Number(m[2]);
}

function verkkolaskuosoiteKelpaa(arvo) {
  return /^[0-9A-Za-z]{8,20}$/.test(String(arvo || '').trim().replace(/[\s-]/g, ''));
}

// Palauttaa virheilmoituksen tai null, jos tiedot kelpaavat.
function tarkista_laskutustiedot(body) {
  for (const nimi of LASKUTUSKENTAT) {
    if (!String(body?.[nimi] || '').trim()) {
      return 'Laskutustiedot puuttuvat';
    }
  }
  if (!ytunnusKelpaa(body.laskutus_ytunnus)) {
    return 'Virheellinen Y-tunnus';
  }
  if (!verkkolaskuosoiteKelpaa(body.laskutus_verkkolaskuosoite)) {
    return 'Virheellinen verkkolaskuosoite';
  }
  if (!verkkolaskuosoiteKelpaa(body.laskutus_valittajatunnus)) {
    return 'Virheellinen välittäjätunnus';
  }
  return null;
}

// Normalisoi tallennusta varten: Y-tunnus aina muotoon 1234567-8, tunnukset
// ilman välilyöntejä. Kanta pysyy siistinä riippumatta siitä miten asiakas kirjoitti.
function normalisoi_laskutustiedot(body) {
  const yt = String(body.laskutus_ytunnus).trim().replace(/[\s-]/g, '');
  return {
    laskutus_nimi:              String(body.laskutus_nimi).trim(),
    laskutus_ytunnus:           `${yt.slice(0, 7)}-${yt.slice(7)}`,
    laskutus_verkkolaskuosoite: String(body.laskutus_verkkolaskuosoite).trim().replace(/[\s-]/g, ''),
    laskutus_valittajatunnus:   String(body.laskutus_valittajatunnus).trim().replace(/[\s-]/g, ''),
    laskutus_viitteenne:        String(body.laskutus_viitteenne).trim(),
  };
}

function laske_hinta(tilaustyyppi, lisenssikausi, oppilasmaara) {
  if (tilaustyyppi === 'opettajalisenssi') {
    const netto = HINTA.opettaja.hinta;
    return { netto, alv: netto * ALV, brutto: netto * (1 + ALV), minimitilausKaytossa: false };
  }
  const avain = lisenssikausi === '3vuotta' ? '3vuotta' : 'vuosi';
  const { hinta, minimi } = HINTA[avain];
  const maara = Number(oppilasmaara) || 0;
  const laskennallinen = maara * hinta;
  const netto = Math.max(laskennallinen, minimi);
  return {
    netto,
    alv: netto * ALV,
    brutto: netto * (1 + ALV),
    minimitilausKaytossa: netto > laskennallinen,
  };
}

function muotoile_euro(n) {
  return n.toLocaleString('fi-FI', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

// ─── Laskutusapufunktiot ──────────────────────────────────────────────────────

// Varaa seuraavan laskunumeron: VUOSI + juokseva 4-numero (esim. "20260001").
//
// MIKSI EI SATUNNAINEN: numero arvottiin aiemmin väliltä 1000–9999. Neljä
// satunnaista numeroa törmää syntymäpäiväparadoksin mukaisesti nopeasti –
// 50 laskulla törmäyksen todennäköisyys on 12 %, 100 laskulla 39 % ja
// 200 laskulla 86 %. Kaksi laskua samalla numerolla rikkoo kirjanpidon
// tositeketjun, ja verkkolaskuoperaattori hylkää jälkimmäisen. Mikään ei
// myöskään tarkistanut ainutlaatuisuutta, joten törmäys olisi jäänyt huomaamatta.
//
// Numero varataan kannasta atomisesti, joten rinnakkaiset tilaukset eivät voi
// saada samaa numeroa. Muoto säilyy ennallaan (VVVV + 4 numeroa), joten laskun
// näyttömuoto ja viitenumeron laskenta toimivat kuten ennenkin.
//
// Vaatii: supabase_laskunumerot.sql
async function seuraava_laskunumero() {
  const baseUrl = SUPABASE_URL.replace(/\/$/, '');
  const r = await fetch(`${baseUrl}/rest/v1/rpc/seuraava_laskunumero`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  if (!r.ok) {
    throw new Error(`Laskunumeron varaus epäonnistui: ${r.status} ${await r.text()}`);
  }
  const numero = String(await r.json());
  if (!/^\d{8}$/.test(numero)) {
    throw new Error(`Laskunumero väärässä muodossa: ${numero}`);
  }
  return numero;
}

// Suomalainen viitenumeroalgoritmi (mod 10/7/3)
function laske_viitenumero(pohja) {
  const merkit = String(pohja).replace(/\s/g, '').split('').reverse();
  const painot = [7, 3, 1];
  let summa = 0;
  for (let i = 0; i < merkit.length; i++) {
    summa += parseInt(merkit[i], 10) * painot[i % 3];
  }
  const tarkiste = (10 - (summa % 10)) % 10;
  return `${pohja}${tarkiste}`;
}

// Ryhmittelee viitenumeron 5 merkin ryhmiin oikealta vasemmalle (pankkien tapa)
function muotoile_viitenumero(viitenro) {
  const s = String(viitenro);
  const reversed = s.split('').reverse();
  const groups = [];
  for (let i = 0; i < reversed.length; i += 5) {
    groups.push(reversed.slice(i, i + 5).reverse().join(''));
  }
  return groups.reverse().join(' ');
}

// Eräpäivä: tänään + maksuaika päiviä
function luo_erapaiva() {
  const d = new Date();
  d.setDate(d.getDate() + LASKUTTAJA.maksuaika);
  return d;
}

function muotoile_pvm(d) {
  return new Date(d).toLocaleDateString('fi-FI', { day: 'numeric', month: 'numeric', year: 'numeric' });
}

// Käytetään selkeitä merkkejä – ei O/0, I/1/L jne.
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generoi_koodi(koulu) {
  const sana = koulu.trim().split(/\s+/)[0].toUpperCase();
  // Säilytetään suomalainen aakkosto (Ä, Ö)
  const puhdas = sana.replace(/[^A-ZÄÖÅ0-9]/g, '') || 'KOULU';
  const satunnainen = Array.from({ length: 4 }, () =>
    CHARS[Math.floor(Math.random() * CHARS.length)]
  ).join('');
  const vuosi = new Date().getFullYear() + 1;
  return `${puhdas}-${vuosi}-${satunnainen}`;
}

// Opettajalisenssin koodi. Kirjautuminen tapahtuu sähköpostilla eikä koodia
// syötetä minnekään – mutta lisenssit.koodi on NOT NULL ja uniikki, joten
// arvo on pakko generoida. Ilman tätä jokainen opettajalisenssitilaus kaatui
// Postgresin NOT NULL -rajoitteeseen ja asiakas näki vain "Palvelinvirhe".
function generoi_opettaja_koodi() {
  const satunnainen = Array.from({ length: 6 }, () =>
    CHARS[Math.floor(Math.random() * CHARS.length)]
  ).join('');
  return `OPE-${new Date().getFullYear() + 1}-${satunnainen}`;
}

async function lisaa_supabaseen(data) {
  const baseUrl = SUPABASE_URL.replace(/\/$/, '');
  const vastaus = await fetch(`${baseUrl}/rest/v1/lisenssit`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(data),
  });
  if (!vastaus.ok) {
    const teksti = await vastaus.text();
    throw new Error(`Supabase ${vastaus.status}: ${teksti}`);
  }
}

async function paivita_supabaseen(id, data) {
  const baseUrl = SUPABASE_URL.replace(/\/$/, '');
  const vastaus = await fetch(
    `${baseUrl}/rest/v1/lisenssit?id=eq.${encodeURIComponent(id)}`,
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
  if (!vastaus.ok) {
    const teksti = await vastaus.text();
    throw new Error(`Supabase ${vastaus.status}: ${teksti}`);
  }
}

async function laheta_sahkoposti(to, subject, html, attachments = []) {
  if (!RESEND_API_KEY) {
    console.warn('RESEND_API_KEY puuttuu – sähköposti ohitettu');
    return;
  }
  const payload = { from: `DigiOpo <${FROM_EMAIL}>`, to: [to], subject, html };
  if (attachments.length > 0) payload.attachments = attachments;
  const vastaus = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!vastaus.ok) {
    // HUOM: heitetään poikkeus (ei vain kirjata console.erroriin) – ilman tätä
    // Promise.allSettled näkisi lähetyksen "onnistuneena" vaikka Resend palautti
    // virheen, eikä epäonnistuminen näkyisi missään (ei edes api_virheet-taulussa).
    const teksti = await vastaus.text();
    throw new Error(`Resend-virhe (${vastaus.status}) vastaanottajalle ${to}, aihe "${subject}": ${teksti}`);
  }
}

// Ajaa sähköpostien lähetykset rinnakkain (yksi epäonnistunut ei estä muita),
// mutta kirjaa jokaisen epäonnistumisen api_virheet-tauluun sen sijaan että
// se katoaisi hiljaa Promise.allSettled-kutsun sisään. Tilaus/lisenssi on jo
// tallennettu tässä vaiheessa, joten sähköpostivirhe ei koskaan estä vastausta
// asiakkaalle – mutta se pitää silti näkyä admin-paneelissa.
async function laheta_sahkopostit_ja_kirjaa(endpoint, lisatiedot, emailPromiset) {
  const tulokset = await Promise.allSettled(emailPromiset);
  for (const tulos of tulokset) {
    if (tulos.status === 'rejected') {
      console.error(`${endpoint} – sähköpostin lähetys epäonnistui:`, tulos.reason?.message || tulos.reason);
      await kirjaaVirhe(endpoint, tulos.reason, lisatiedot);
    }
  }
}

function sahkoposti_koululle(etunimi, koodi, voimassa_asti) {
  const pvm = new Date(voimassa_asti).toLocaleDateString('fi-FI', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
  return `<!DOCTYPE html>
<html lang="fi">
<body style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;padding:32px 20px;color:#0f2540;background:#f8fbff">
  <div style="text-align:center;margin-bottom:28px">
    <span style="font-size:26px;font-weight:700;color:#1a3f6f">Digi<span style="color:#2d9e6b">Opo</span></span>
  </div>
  <h2 style="color:#1a3f6f;margin-bottom:10px">Hei ${etunimi}!</h2>
  <p style="line-height:1.6;margin-bottom:24px">Kiitos DigiOpo-tilauksestasi. Koulukoodisi on luotu ja oppilaat voivat nyt kirjautua sisään.</p>
  <div style="background:#ddeaf7;border-radius:14px;padding:28px;text-align:center;margin-bottom:28px">
    <p style="margin:0 0 8px;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#3a5a7a">KOULUKOODISI</p>
    <p style="font-size:34px;font-weight:700;letter-spacing:5px;color:#1a3f6f;margin:0">${koodi}</p>
    <p style="margin:12px 0 0;font-size:13px;color:#3a5a7a">Voimassa ${pvm} asti</p>
  </div>
  <p style="line-height:1.6;margin-bottom:8px"><strong>Näin jaat koodin oppilaille:</strong></p>
  <ol style="line-height:1.8;padding-left:20px;margin-bottom:24px">
    <li>Oppilaat menevät osoitteeseen <strong>app.digiopo.fi</strong></li>
    <li>Syöttävät koulukoodin kirjautumisruutuun</li>
    <li>Pääsevät suoraan sisältöön</li>
  </ol>
  <div style="background:#fef9e0;border:1px solid #f5c842;border-radius:10px;padding:16px 20px;margin-bottom:28px">
    <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#7a5c00">💡 Miten jaat linkin oppilaille?</p>
    <p style="margin:0 0 6px;font-size:13px;color:#7a5c00;line-height:1.6"><strong>Vaihtoehto 1 – Yksinkertainen:</strong><br>
      Jaa osoite <strong>app.digiopo.fi</strong> ja koulukoodi <strong>${koodi}</strong>. Oppilas kirjautuu koulukoodilla ja näkee oletusrakenteen.</p>
    <p style="margin:0 0 6px;font-size:13px;color:#7a5c00;line-height:1.6"><strong>Vaihtoehto 2 – Opettajan järjestys (suositeltava):</strong><br>
      Avaa ensin DigiOpo itse → aseta <strong>Sivun hallinta</strong> (sivun alareunasta) → järjestä osiot → kopioi suora ryhmälinkki paneelista ja jaa se oppilaille. Oppilas syöttää vain koulukoodin ${koodi} ja näkee heti sinun järjestyksesi.</p>
    <p style="margin:10px 0 0;font-size:13px;color:#7a5c00;line-height:1.6;border-top:1px solid #f5c842;padding-top:10px">📖 Tutustu opettajan pikaohjeeseen, joka on tämän sähköpostin liitteenä.</p>
  </div>
  <div style="text-align:center;margin-bottom:32px">
    <a href="https://app.digiopo.fi" style="background:#1a3f6f;color:#fff;padding:14px 36px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px">Avaa DigiOpo →</a>
  </div>
  <p style="font-size:13px;color:#7a9ab5;line-height:1.6">Kysyttävää? Vastaa suoraan tähän sähköpostiin.</p>
</body>
</html>`;
}

function sahkoposti_opettajalle(etunimi, email, voimassa_asti) {
  const pvm = new Date(voimassa_asti).toLocaleDateString('fi-FI', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
  return `<!DOCTYPE html>
<html lang="fi">
<body style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;padding:32px 20px;color:#0f2540;background:#f8fbff">
  <div style="text-align:center;margin-bottom:28px">
    <span style="font-size:26px;font-weight:700;color:#1a3f6f">Digi<span style="color:#2d9e6b">Opo</span></span>
  </div>
  <h2 style="color:#1a3f6f;margin-bottom:10px">Hei ${etunimi}!</h2>
  <p style="line-height:1.6;margin-bottom:24px">Kiitos DigiOpo-opettajalisenssin tilauksesta. Henkilökohtainen lisenssisi on nyt aktivoitu ja sidottu sähköpostiosoitteeseesi.</p>
  <div style="background:#ddeaf7;border-radius:14px;padding:28px;text-align:center;margin-bottom:28px">
    <p style="margin:0 0 8px;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#3a5a7a">KIRJAUTUMISSÄHKÖPOSTISI</p>
    <p style="font-size:20px;font-weight:700;color:#1a3f6f;margin:0">${email}</p>
    <p style="margin:12px 0 0;font-size:13px;color:#3a5a7a">Lisenssi voimassa ${pvm} asti</p>
  </div>
  <p style="line-height:1.6;margin-bottom:8px"><strong>Näin kirjaudut sisään:</strong></p>
  <ol style="line-height:1.8;padding-left:20px;margin-bottom:28px">
    <li>Mene osoitteeseen <strong>app.digiopo.fi</strong></li>
    <li>Syötä tämä sähköpostiosoite kirjautumisruutuun</li>
    <li>Saat kirjautumislinkin sähköpostiisi – klikkaa sitä</li>
    <li>Olet sisällä</li>
  </ol>
  <div style="background:#fef9e0;border:1px solid #f5c842;border-radius:10px;padding:16px 20px;margin-bottom:28px;font-size:13.5px;color:#7a5c00;line-height:1.6">
    <strong>Huomio:</strong> Tämä on henkilökohtainen lisenssi. Kirjautumislinkki toimii vain tällä sähköpostiosoitteella, eikä sitä voi jakaa eteenpäin.
  </div>
  <p style="line-height:1.6;margin-bottom:24px;font-size:14px">📖 <strong>Opettajan pikaohjeet</strong> on tämän sähköpostin liitteenä. Siitä näet, miten luot opetusryhmän, järjestät osiot ja jaat sisällön oppilaille.</p>
  <div style="text-align:center;margin-bottom:32px">
    <a href="https://app.digiopo.fi/kirjaudu" style="background:#1a3f6f;color:#fff;padding:14px 36px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px">Kirjaudu DigiOpoon →</a>
  </div>
  <p style="font-size:13px;color:#7a9ab5;line-height:1.6">Kysyttävää? Vastaa suoraan tähän sähköpostiin.</p>
</body>
</html>`;
}

function sahkoposti_adminille(t, koodi, voimassa_asti, hintatiedot) {
  const pvm = new Date(voimassa_asti).toLocaleDateString('fi-FI');
  const rivi = (nimi, arvo) =>
    `<tr><td style="padding:8px 12px;border-bottom:1px solid #eef5fb;color:#3a5a7a;font-size:13px">${nimi}</td><td style="padding:8px 12px;border-bottom:1px solid #eef5fb;font-size:13px">${arvo}</td></tr>`;
  const lisenssikausiTeksti = t.tilaustyyppi === 'koululisenssi'
    ? (t.lisenssikausi === '3vuotta' ? '3 vuoden lisenssi' : 'Vuosilisenssi')
    : '–';
  const hintaTeksti = `${muotoile_euro(hintatiedot.netto)} (alv 0 %) + alv 13,5 % = <strong>${muotoile_euro(hintatiedot.brutto)}</strong> (sis. alv)`
    + (hintatiedot.minimitilausKaytossa ? ' <span style="color:#7a5c00">— minimitilaus käytössä</span>' : '');
  return `<!DOCTYPE html>
<html lang="fi">
<body style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;padding:32px 20px;color:#0f2540">
  <h2 style="color:#1a3f6f">🎉 Uusi DigiOpo-tilaus</h2>
  <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
    ${rivi('Koulu', `${t.koulu}, ${t.kunta}`)}
    ${rivi('Yhteyshenkilö', `${t.etunimi} ${t.sukunimi}`)}
    ${rivi('Sähköposti', `<a href="mailto:${t.email}">${t.email}</a>`)}
    ${rivi('Puhelin', t.puhelin || '–')}
    ${rivi('Oppilasmäärä', t.oppilasmaara)}
    ${rivi('Tilaustyyppi', t.tilaustyyppi === 'koululisenssi' ? 'Koululisenssi' : 'Opettajalisenssi')}
    ${rivi('Lisenssikausi', lisenssikausiTeksti)}
    ${rivi('Laskutettava summa', hintaTeksti)}
    ${rivi('Lisätiedot', t.lisatiedot || '–')}
    ${t.laskutus_nimi ? `
      ${rivi('Laskutettava', `${t.laskutus_nimi} (${t.laskutus_ytunnus})`)}
      ${rivi('Verkkolaskuosoite', `${t.laskutus_verkkolaskuosoite} / välittäjä ${t.laskutus_valittajatunnus}`)}
      ${rivi('Viitteenne', t.laskutus_viitteenne)}
    ` : ''}
    ${rivi('Generoitu koodi', `<strong style="font-size:18px;letter-spacing:2px">${koodi}</strong>`)}
    ${rivi('Voimassa asti', pvm)}
  </table>
  <p style="font-size:12px;color:#7a9ab5">Lisenssi on tallennettu Supabaseen ja koodi lähetetty tilaajalle automaattisesti. Lasku lähetetään erikseen yllä olevan summan mukaisesti.</p>
</body>
</html>`;
}

function sahkoposti_lasku(tilaus, hintatiedot, laskunumero, erapaiva) {
  const { etunimi, sukunimi, email, koulu, kunta, oppilasmaara, tilaustyyppi, lisenssikausi } = tilaus;

  const viitenro        = laske_viitenumero(laskunumero);
  const viitenroNaytto  = muotoile_viitenumero(viitenro);
  const laskunroNaytto  = `${String(laskunumero).slice(0, 4)}-${String(laskunumero).slice(4)}`;
  const laskupvm        = muotoile_pvm(new Date());
  const erapvmNaytto    = muotoile_pvm(erapaiva);

  // Tuoterivi
  let tuotekuvaus, maara, rivihinta;
  if (tilaustyyppi === 'opettajalisenssi') {
    tuotekuvaus = 'DigiOpo – opettajalisenssi, 1 vuosi';
    maara       = '1 lisenssi';
    rivihinta   = muotoile_euro(hintatiedot.netto);
  } else if (lisenssikausi === '3vuotta') {
    tuotekuvaus = 'DigiOpo Omilla jäljillä – koululisenssi, 3 vuotta';
    maara       = `${oppilasmaara} oppilasta × 14,90 €`;
    rivihinta   = muotoile_euro(hintatiedot.netto);
  } else {
    tuotekuvaus = 'DigiOpo Omilla jäljillä – koululisenssi, 1 lukuvuosi';
    maara       = `${oppilasmaara} oppilasta × 5,90 €`;
    rivihinta   = muotoile_euro(hintatiedot.netto);
  }

  const minimiNota = hintatiedot.minimitilausKaytossa
    ? '<tr><td colspan="3" style="padding:2px 12px 10px;font-size:11.5px;color:#7a9ab5;font-style:italic">Sovelletaan minimitilausta</td></tr>'
    : '';

  return `<!DOCTYPE html>
<html lang="fi">
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;padding:32px 20px;color:#0f2540;background:#ffffff">

  <!-- Otsikkorivi -->
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px">
    <tr>
      <td><span style="font-size:24px;font-weight:700;color:#1a3f6f">Digi<span style="color:#2d9e6b">Opo</span></span></td>
      <td style="text-align:right"><span style="font-size:30px;font-weight:800;color:#1a3f6f;letter-spacing:3px">LASKU</span></td>
    </tr>
  </table>

  <!-- Laskuttaja + Laskun tiedot -->
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px">
    <tr>
      <td style="vertical-align:top;width:50%">
        <div style="font-size:10.5px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#7a9ab5;margin-bottom:8px">LASKUTTAJA</div>
        <div style="font-size:13.5px;line-height:1.85;color:#0f2540">
          <strong>${LASKUTTAJA.nimi}</strong><br>
          Y-tunnus: ${LASKUTTAJA.ytunnus}<br>
          ${LASKUTTAJA.osoite}<br>
          ${LASKUTTAJA.postiosoite}
        </div>
      </td>
      <td style="vertical-align:top;padding-left:24px">
        <div style="font-size:10.5px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#7a9ab5;margin-bottom:8px">LASKUN TIEDOT</div>
        <table cellpadding="0" cellspacing="0" style="font-size:13.5px;line-height:2">
          <tr><td style="color:#3a5a7a;padding-right:14px">Laskunumero</td><td><strong>${laskunroNaytto}</strong></td></tr>
          <tr><td style="color:#3a5a7a">Laskupäivä</td><td>${laskupvm}</td></tr>
          <tr><td style="color:#3a5a7a">Eräpäivä</td><td><strong>${erapvmNaytto}</strong></td></tr>
          <tr><td style="color:#3a5a7a">Maksuehto</td><td>${LASKUTTAJA.maksuaika} pv netto</td></tr>
        </table>
      </td>
    </tr>
  </table>

  <!-- Laskutetaan -->
  <div style="background:#f8fbff;border-left:3px solid #1a3f6f;padding:14px 18px;margin-bottom:28px;border-radius:0 8px 8px 0">
    <div style="font-size:10.5px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#7a9ab5;margin-bottom:6px">LASKUTETAAN</div>
    <div style="font-size:13.5px;line-height:1.85">
      ${tilaus.laskutus_nimi
        ? `<strong>${tilaus.laskutus_nimi}</strong><br>
           Y-tunnus: ${tilaus.laskutus_ytunnus}<br>
           Viitteenne: <strong>${tilaus.laskutus_viitteenne}</strong><br>
           <span style="color:#3a5a7a">Verkkolaskuosoite: ${tilaus.laskutus_verkkolaskuosoite}
           · välittäjä ${tilaus.laskutus_valittajatunnus}</span><br><br>
           <span style="color:#3a5a7a">Käyttökohde: ${koulu}, ${kunta}<br>
           Yhteyshenkilö: ${etunimi} ${sukunimi} · ${email}</span>`
        : `<strong>${koulu}</strong>, ${kunta}<br>
           Yhteyshenkilö: ${etunimi} ${sukunimi}<br>
           <span style="color:#3a5a7a">${email}</span>`}
    </div>
  </div>

  <!-- Tuotteet -->
  <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:0;font-size:13.5px">
    <thead>
      <tr style="background:#1a3f6f;color:#fff">
        <th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:600;letter-spacing:0.05em">TUOTE / PALVELU</th>
        <th style="padding:10px 12px;text-align:right;font-size:11px;font-weight:600;letter-spacing:0.05em">MÄÄRÄ</th>
        <th style="padding:10px 12px;text-align:right;font-size:11px;font-weight:600;letter-spacing:0.05em;white-space:nowrap">ALV 0 %</th>
      </tr>
    </thead>
    <tbody>
      <tr style="background:#f8fbff">
        <td style="padding:12px;border-bottom:1px solid #ddeaf7">${tuotekuvaus}</td>
        <td style="padding:12px;border-bottom:1px solid #ddeaf7;text-align:right;color:#3a5a7a;white-space:nowrap">${maara}</td>
        <td style="padding:12px;border-bottom:1px solid #ddeaf7;text-align:right;font-weight:600;white-space:nowrap">${rivihinta}</td>
      </tr>
      ${minimiNota}
    </tbody>
  </table>

  <!-- Yhteensä -->
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;font-size:13.5px">
    <tr>
      <td></td>
      <td style="text-align:right;padding:7px 12px;color:#3a5a7a;white-space:nowrap">Yhteensä (alv 0 %)</td>
      <td style="text-align:right;padding:7px 12px;min-width:110px;white-space:nowrap">${muotoile_euro(hintatiedot.netto)}</td>
    </tr>
    <tr>
      <td></td>
      <td style="text-align:right;padding:7px 12px;color:#3a5a7a">ALV 13,5 %</td>
      <td style="text-align:right;padding:7px 12px;white-space:nowrap">${muotoile_euro(hintatiedot.alv)}</td>
    </tr>
    <tr>
      <td></td>
      <td colspan="2" style="border-top:2px solid #1a3f6f;padding:2px 0"></td>
    </tr>
    <tr>
      <td></td>
      <td style="text-align:right;padding:10px 12px;font-weight:700;font-size:15px;color:#1a3f6f">YHTEENSÄ</td>
      <td style="text-align:right;padding:10px 12px;font-weight:700;font-size:15px;color:#1a3f6f;white-space:nowrap">${muotoile_euro(hintatiedot.brutto)}</td>
    </tr>
  </table>

  <!-- Maksutiedot -->
  <div style="background:#ddeaf7;border-radius:12px;padding:20px 24px;margin-bottom:28px">
    <div style="font-size:10.5px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#3a5a7a;margin-bottom:12px">MAKSUTIEDOT</div>
    <table cellpadding="0" cellspacing="0" style="font-size:13.5px;line-height:2.1;width:100%">
      <tr><td style="color:#3a5a7a;width:130px">Maksunsaaja</td><td><strong>${LASKUTTAJA.nimi}</strong></td></tr>
      <tr><td style="color:#3a5a7a">Tilinumero</td><td><strong>${LASKUTTAJA.iban}</strong></td></tr>
      <tr><td style="color:#3a5a7a">BIC</td><td>${LASKUTTAJA.bic}</td></tr>
      <tr><td style="color:#3a5a7a">Viitenumero</td><td><strong style="font-size:15px;letter-spacing:1px">${viitenroNaytto}</strong></td></tr>
      <tr><td style="color:#3a5a7a">Eräpäivä</td><td><strong>${erapvmNaytto}</strong></td></tr>
      <tr><td style="color:#3a5a7a">Summa</td><td><strong>${muotoile_euro(hintatiedot.brutto)}</strong></td></tr>
    </table>
  </div>

  <p style="font-size:12px;color:#7a9ab5;line-height:1.7;margin-bottom:4px">Pyydämme käyttämään maksaessanne yllä olevaa viitenumeroa, jotta maksu kohdistuu oikein.</p>
  <p style="font-size:12px;color:#7a9ab5;line-height:1.7">Kysyttävää laskusta? Ota yhteyttä: <a href="mailto:digiopo@digiopo.fi" style="color:#2563a8">digiopo@digiopo.fi</a></p>

</body>
</html>`;
}

// Luetaan pikaohjeet-PDF kerran per käynnistys (cached muistiin)
let pikaohjeBase64 = null;
async function hae_pikaohjeet_base64() {
  if (pikaohjeBase64) return pikaohjeBase64;
  try {
    const pdfPolku = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'DigiOpo_opettajan_pikaohjeet.pdf');
    const buf = await readFile(pdfPolku);
    pikaohjeBase64 = buf.toString('base64');
  } catch (err) {
    console.warn('Pikaohjeet-PDF puuttuu – liitettä ei lähetetä:', err.message);
    pikaohjeBase64 = null;
  }
  return pikaohjeBase64;
}

export default async function handler(req, res) {
  // CORS
  const origin = req.headers.origin || '';
  if (SALLITUT_ORIGINIT.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ virhe: 'Metodi ei sallittu' });

  // Rate limit per IP (spämmäyksen esto)
  const ip = haeIp(req);
  if (!rateLimitSallittu(ip)) {
    return res.status(429).json({ ok: false, virhe: 'Liian monta tilausta lyhyessä ajassa. Yritä hetken kuluttua uudelleen.' });
  }

  // Body
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ ok: false, virhe: 'Virheellinen pyyntö' });
  }

  const { etunimi, sukunimi, email, puhelin, koulu, kunta, oppilasmaara, tilaustyyppi, lisenssikausi, lisatiedot } = body || {};

  // Validointi
  if (!etunimi?.trim() || !sukunimi?.trim() || !koulu?.trim() || !kunta?.trim() || !oppilasmaara || !email?.trim()) {
    return res.status(400).json({ ok: false, virhe: 'Pakollinen kenttä puuttuu' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, virhe: 'Virheellinen sähköpostiosoite' });
  }

  // Laskutustiedot vaaditaan vain koululisenssiltä. Ostaja on kunta, joka on
  // hankintayksikkö ja jolla on verkkolaskulain (241/2019) nojalla oikeus vaatia
  // lasku verkkolaskuna – ilman näitä tietoja laskua ei voi lähettää lainkaan.
  // Opettajalisenssin ostaa yksityishenkilö, jolta niitä ei ole mistä kysyä.
  let laskutustiedot = null;
  if (tilaustyyppi === 'koululisenssi') {
    const laskutusVirhe = tarkista_laskutustiedot(body);
    if (laskutusVirhe) {
      return res.status(400).json({ ok: false, virhe: laskutusVirhe });
    }
    // Vasta validoinnin jälkeen – normalisointi olettaa kenttien olevan olemassa.
    laskutustiedot = normalisoi_laskutustiedot(body);
  }

  // ─── Voimassaolo: lyhyt alku, täysi kausi maksun jälkeen ──────────────────
  //
  // MIKSI: tilaus loi aiemmin lisenssin täydellä voimassaololla heti, ennen
  // kuin laskua oli maksettu. Kuka tahansa saattoi täyttää lomakkeen
  // tekaistuilla tiedoilla ja saada toimivan koodin vuodeksi.
  //
  // Nyt asiakas saa koodin heti kuten ennenkin, mutta se on voimassa 30 päivää.
  // Kun lasku maksetaan, voimassaolo jatketaan ostettuun kauteen
  // hallintapaneelista. Jos laskua ei makseta, pääsy päättyy itsestään –
  // oletusarvo on turvallinen eikä vaadi kenenkään muistavan tehdä mitään.
  //
  // Maksuaika on 14 pv, joten 30 pv antaa puskurin viivästyksille ja lomille.
  const ALKUVOIMASSAOLO_PV = 30;

  const kestoVuosina = (tilaustyyppi === 'koululisenssi' && lisenssikausi === '3vuotta') ? 3 : 1;

  // Täysi kausi lasketaan TILAUSPÄIVÄSTÄ, ei maksupäivästä – asiakas saa sen
  // mitä osti, eikä maksun viivästyminen lyhennä hänen kauttaan.
  const taysi = new Date();
  taysi.setFullYear(taysi.getFullYear() + kestoVuosina);
  let taysi_voimassa_asti = taysi.toISOString().split('T')[0];

  const alku = new Date();
  alku.setDate(alku.getDate() + ALKUVOIMASSAOLO_PV);
  // let, ei const: uusintatilauksessa arvo lasketaan uudelleen nykyisestä
  // päättymispäivästä, jottei asiakas menetä jäljellä olevaa aikaa.
  let voimassa_asti = alku.toISOString().split('T')[0];

  const hintatiedot = laske_hinta(tilaustyyppi, lisenssikausi, oppilasmaara);
  const erapaiva    = luo_erapaiva();
  const laskuPvm    = new Date().toISOString().split('T')[0];

  const emailNorm = email.trim().toLowerCase();
  const henkilö = `${etunimi.trim()} ${sukunimi.trim()}`;
  let koodi = null;

  // Duplikaattisuoja: sama sähköposti viimeisen 3 min aikana → älä luo toista
  // lisenssiä/laskua. Käsitellään onnistuneena (tilaus on jo mennyt läpi).
  const tyyppiKannassa = tilaustyyppi === 'opettajalisenssi' ? 'opettaja' : 'vuosi';
  try {
    if (await onTuoreDuplikaatti(emailNorm, tyyppiKannassa)) {
      return res.status(200).json({ ok: true, duplikaatti: true });
    }
  } catch { /* fail-open: ei estetä tilausta jos tarkistus ei onnistu */ }

  // Laskunumero varataan vasta duplikaattitarkistuksen jälkeen. Tuplaklikkaus
  // ei saa polttaa numeroa: juoksevan numeroinnin aukot pitää pystyä
  // selittämään kirjanpidossa, eikä "asiakas klikkasi kahdesti" ole selitys
  // joka löytyy jälkikäteen mistään.
  //
  // Tässä ei ole fail-openia toisin kuin duplikaattitarkistuksessa. Jos numeroa
  // ei saada, tilausta ei synny lainkaan: lisenssi ilman laskunumeroa jäisi
  // laskuttamatta, ja asiakas saisi käyttöoikeuden josta ei koskaan tule laskua.
  let laskunumero;
  try {
    laskunumero = await seuraava_laskunumero();
  } catch (err) {
    console.error('Laskunumeron varaus epäonnistui:', err.message);
    await kirjaaVirhe('tilaus laskunumero', err, { koulu, email: emailNorm });
    return res.status(500).json({ ok: false, virhe: 'Palvelinvirhe – yritä uudelleen' });
  }

  if (tilaustyyppi === 'opettajalisenssi') {
    // Opettajalisenssi: kirjautuminen tapahtuu sähköpostilla, mutta koodi on
    // silti pakollinen kenttä kannassa. Uusintatilaus PÄIVITTÄÄ olemassa
    // olevaa riviä – uusi rivi rikkoisi uniikin indeksin ja tekisi
    // kirjautumisesta arvaamatonta (api/lisenssi.js ottaa data[0]).
    let uusinta = false;
    try {
      const olemassa = await hae_opettajalisenssi(emailNorm);

      if (olemassa) {
        uusinta = true;
        koodi = olemassa.koodi;

        // Täysi kausi jatkuu nykyisestä päättymispäivästä, jos lisenssi on yhä
        // voimassa – muuten asiakas menettäisi jäljellä olevan ajan uusiessaan
        // ajoissa.
        const nykyinenLoppu = new Date(olemassa.voimassa_asti);
        const pohja = nykyinenLoppu > new Date() ? nykyinenLoppu : new Date();
        pohja.setFullYear(pohja.getFullYear() + kestoVuosina);
        taysi_voimassa_asti = pohja.toISOString().split('T')[0];

        // Pääsy jatkuu 30 pv maksua odottaessa – mutta EI koskaan lyhennä
        // olemassa olevaa voimassaoloa. Ajoissa uusiva asiakas ei saa
        // huonompaa pääsyä kuin hänellä jo oli.
        const valiaikainen = new Date();
        valiaikainen.setDate(valiaikainen.getDate() + ALKUVOIMASSAOLO_PV);
        const uusiLoppu = (nykyinenLoppu > valiaikainen ? nykyinenLoppu : valiaikainen)
          .toISOString().split('T')[0];

        await paivita_supabaseen(olemassa.id, {
          koulu: koulu.trim(),
          yhteyshenkilö: henkilö,
          voimassa_asti: uusiLoppu,
          taysi_voimassa_asti,
          laskunumero: String(laskunumero),
          lasku_pvm: laskuPvm,
          maksettu: false,
          aktiivinen: true,
        });
        voimassa_asti = uusiLoppu;
      } else {
        // Uusi lisenssi: yritetään 3 kertaa koodin törmäyksen varalta
        for (let yritys = 0; yritys < 3; yritys++) {
          koodi = generoi_opettaja_koodi();
          try {
            await lisaa_supabaseen({
              koodi,
              koulu: koulu.trim(),
              yhteyshenkilö: henkilö,
              email: emailNorm,
              tyyppi: 'opettaja',
              voimassa_asti,           // 30 pv – maksua odottaessa
              taysi_voimassa_asti,     // mihin jatketaan kun lasku on maksettu
              laskunumero: String(laskunumero),
              lasku_pvm: laskuPvm,
              maksettu: false,
              aktiivinen: true,
            });
            break;
          } catch (err) {
            if (yritys === 2) throw err;
          }
        }
      }
    } catch (err) {
      console.error('Supabase insert epäonnistui:', err.message);
      await kirjaaVirhe('tilaus opettajalisenssi', err, { koulu, email: emailNorm });
      return res.status(500).json({ ok: false, virhe: 'Palvelinvirhe – yritä uudelleen' });
    }

    const tilausData = { etunimi, sukunimi, email: emailNorm, puhelin, koulu, kunta, oppilasmaara, tilaustyyppi, lisenssikausi, lisatiedot, ...laskutustiedot };

    // Pikaohje myös opettajalisenssin ostajalle. Aiemmin liite lähti vain
    // koululisenssin mukana, jolloin yksittäinen opettaja jäi ilman ohjetta –
    // vaikka juuri hän tarvitsee sitä eniten, koska hänellä ei ole koulun
    // yhteyshenkilöä jolta kysyä.
    const opePdfB64 = await hae_pikaohjeet_base64();
    const opePdfLiite = opePdfB64
      ? [{ filename: 'DigiOpo_opettajan_pikaohjeet.pdf', content: opePdfB64 }]
      : [];

    await laheta_sahkopostit_ja_kirjaa(
      'tilaus opettajalisenssi sahkoposti',
      { koulu, email: emailNorm, tilaustyyppi },
      [
        laheta_sahkoposti(emailNorm, 'DigiOpo – opettajalisenssisi on aktivoitu', sahkoposti_opettajalle(etunimi, emailNorm, voimassa_asti), opePdfLiite),
        laheta_sahkoposti(emailNorm, `DigiOpo – lasku nro ${String(laskunumero).slice(0,4)}-${String(laskunumero).slice(4)}`, sahkoposti_lasku(tilausData, hintatiedot, laskunumero, erapaiva)),
        ADMIN_EMAIL && laheta_sahkoposti(
          ADMIN_EMAIL,
          `${uusinta ? 'Uusinta' : 'Uusi'} DigiOpo-tilaus: ${koulu}`,
          sahkoposti_adminille(
            tilausData,
            `${koodi} ${uusinta ? '(uusinta – voimassaoloa jatkettu)' : '(uusi opettajalisenssi)'}`,
            voimassa_asti,
            hintatiedot
          )
        ),
      ]
    );
  } else {
    // Koululisenssi: generoidaan jaettava koodi, yritetään 3 kertaa törmäyksen varalta
    for (let yritys = 0; yritys < 3; yritys++) {
      koodi = generoi_koodi(koulu);
      try {
        await lisaa_supabaseen({
          koodi,
          koulu: koulu.trim(),
          yhteyshenkilö: henkilö,
          email: emailNorm,
          tyyppi: 'vuosi',
          paikat: Number(oppilasmaara) || null, // ostettu oppilasmäärä → ylikäytön seuranta
          voimassa_asti,           // 30 pv – maksua odottaessa
          taysi_voimassa_asti,     // mihin jatketaan kun lasku on maksettu
          laskunumero: String(laskunumero),
          lasku_pvm: laskuPvm,
          maksettu: false,
          aktiivinen: true,
          ...laskutustiedot,
        });
        break;
      } catch (err) {
        if (yritys === 2) {
          console.error('Supabase insert epäonnistui:', err.message);
          await kirjaaVirhe('tilaus koululisenssi', err, { koulu, email: emailNorm });
          return res.status(500).json({ ok: false, virhe: 'Palvelinvirhe – yritä uudelleen' });
        }
      }
    }

    const tilausData = { etunimi, sukunimi, email: emailNorm, puhelin, koulu, kunta, oppilasmaara, tilaustyyppi, lisenssikausi, lisatiedot, ...laskutustiedot };
    const pdfB64 = await hae_pikaohjeet_base64();
    const pdfLiite = pdfB64
      ? [{ filename: 'DigiOpo_opettajan_pikaohjeet.pdf', content: pdfB64 }]
      : [];
    await laheta_sahkopostit_ja_kirjaa(
      'tilaus koululisenssi sahkoposti',
      { koulu, email: emailNorm, koodi, tilaustyyppi },
      [
        laheta_sahkoposti(emailNorm, 'DigiOpo – koulukoodisi on valmis', sahkoposti_koululle(etunimi, koodi, voimassa_asti), pdfLiite),
        laheta_sahkoposti(emailNorm, `DigiOpo – lasku nro ${String(laskunumero).slice(0,4)}-${String(laskunumero).slice(4)}`, sahkoposti_lasku(tilausData, hintatiedot, laskunumero, erapaiva)),
        ADMIN_EMAIL && laheta_sahkoposti(ADMIN_EMAIL, `Uusi DigiOpo-tilaus: ${koulu}`, sahkoposti_adminille(tilausData, koodi, voimassa_asti, hintatiedot)),
      ]
    );
  }

  return res.status(200).json({ ok: true });
}