// DigiOpo Home – Tilauksen täyttö (verkkomaksun jälkeen)
//
// ═══════════════════════════════════════════════════════════════════════════
//  ⚠️  JAETTU TIETOKANTA – LUE ENNEN MUUTOKSIA
//
//  Tämä kirjoittaa `lisenssit`-tauluun, jota käyttää MYÖS digiopo
//  (app.digiopo.fi). Taulun skeema ja rajoitteet asuvat siellä:
//      digiopo/supabase_schema.sql, digiopo/docs/03-tietokanta.md
//  Rajoite johon nojataan: koodi NOT NULL UNIQUE, tyyppi CHECK
//  ('testi'|'vuosi'|'kunta'|'opettaja').
// ═══════════════════════════════════════════════════════════════════════════
//
//  MITÄ TÄMÄ TEKEE
//
//  Kun Paytrail on vahvistanut maksun onnistuneeksi, tämä moduuli luo lisenssin
//  ja lähettää koulukoodin + maksukuitin. Toisin kuin vanha laskumalli, lisenssi
//  luodaan tässä vaiheessa TÄYDELLÄ voimassaololla ja `maksettu: true` -tilassa –
//  rahat on jo saatu, joten mitään väliaikaista 30 päivän pääsyä tai jälkikäteen
//  tehtävää "merkitse maksetuksi" -askelta ei enää tarvita.
//
//  Idempotenssi hoidetaan kutsujassa (api/maksu-*.js) maksut-taulun atomisella
//  tilasiirtymällä. Tämä moduuli olettaa, että se kutsutaan täsmälleen kerran
//  per maksettu tilaus.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { kirjaaVirhe } from './virhelogi.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@digiopo.fi';

// ─── Hinnasto (pidä synkassa hinnasto.html / tilauslomake.html kanssa) ───────
export const HINTA = {
  vuosi:     { hinta: 5.90,  minimi: 120 },
  '3vuotta': { hinta: 12.50, minimi: 360 },
};
export const ALV = 0.135;

// ─── Myyjän tiedot (näkyvät maksukuitilla) ───────────────────────────────────
const MYYJA = {
  nimi:        'DigiOpo Palvelut',
  ytunnus:     '3540305-3',
  osoite:      'Herttuantie 1',
  postiosoite: '01520 Vantaa',
};

// ─── Hinta ───────────────────────────────────────────────────────────────────
export function laskeHinta(lisenssikausi, oppilasmaara) {
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

// Paytrail veloittaa sentteinä (kokonaisluku). Pyöristetään keskeltä ylös, jotta
// veloitus ei koskaan jää senttiäkään bruttosummaa pienemmäksi.
export function bruttoSentteina(hintatiedot) {
  return Math.round(hintatiedot.brutto * 100);
}

export function muotoileEuro(n) {
  return n.toLocaleString('fi-FI', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function muotoilePvm(d) {
  return new Date(d).toLocaleDateString('fi-FI', { day: 'numeric', month: 'numeric', year: 'numeric' });
}

// ─── Laskunumero (juokseva, kannasta atomisesti) ─────────────────────────────
// Käytetään verkkomaksussa tositenumerona. Vaatii supabase_laskunumerot.sql.
export async function seuraavaLaskunumero() {
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
  if (!r.ok) throw new Error(`Laskunumeron varaus epäonnistui: ${r.status} ${await r.text()}`);
  const numero = String(await r.json());
  if (!/^\d{8}$/.test(numero)) throw new Error(`Laskunumero väärässä muodossa: ${numero}`);
  return numero;
}

// ─── Koodi ───────────────────────────────────────────────────────────────────
// Selkeät merkit – ei O/0, I/1/L jne.
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generoiKoodi(koulu) {
  const sana = koulu.trim().split(/\s+/)[0].toUpperCase();
  const puhdas = sana.replace(/[^A-ZÄÖÅ0-9]/g, '') || 'KOULU';
  const satunnainen = Array.from({ length: 4 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join('');
  const vuosi = new Date().getFullYear() + 1;
  return `${puhdas}-${vuosi}-${satunnainen}`;
}

// ─── Supabase ─────────────────────────────────────────────────────────────────
async function lisaaLisenssi(data) {
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
  if (!vastaus.ok) throw new Error(`Supabase ${vastaus.status}: ${await vastaus.text()}`);
}

// ─── Sähköposti ───────────────────────────────────────────────────────────────
async function lahetaSahkoposti(to, subject, html, attachments = []) {
  if (!RESEND_API_KEY) {
    console.warn('RESEND_API_KEY puuttuu – sähköposti ohitettu');
    return;
  }
  const payload = { from: `DigiOpo <${FROM_EMAIL}>`, to: [to], subject, html };
  if (attachments.length > 0) payload.attachments = attachments;
  const vastaus = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!vastaus.ok) {
    throw new Error(`Resend-virhe (${vastaus.status}) vastaanottajalle ${to}, aihe "${subject}": ${await vastaus.text()}`);
  }
}

// Ajaa lähetykset rinnakkain; yksi epäonnistunut ei estä muita, mutta jokainen
// epäonnistuminen kirjataan api_virheet-tauluun (ei katoa Promise.allSettleniin).
// Lisenssi on jo tallennettu tässä vaiheessa, joten sähköpostivirhe ei estä
// vastausta – mutta sen pitää näkyä admin-paneelissa.
async function lahetaSahkopostitJaKirjaa(endpoint, lisatiedot, emailPromiset) {
  const tulokset = await Promise.allSettled(emailPromiset);
  for (const tulos of tulokset) {
    if (tulos.status === 'rejected') {
      console.error(`${endpoint} – sähköpostin lähetys epäonnistui:`, tulos.reason?.message || tulos.reason);
      await kirjaaVirhe(endpoint, tulos.reason, lisatiedot);
    }
  }
}

// Pikaohjeet-PDF luetaan kerran per käynnistys (cached muistiin).
let pikaohjeBase64 = null;
async function haePikaohjeetBase64() {
  if (pikaohjeBase64) return pikaohjeBase64;
  try {
    const pdfPolku = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'DigiOpo_opettajan_pikaohjeet.pdf');
    pikaohjeBase64 = (await readFile(pdfPolku)).toString('base64');
  } catch (err) {
    console.warn('Pikaohjeet-PDF puuttuu – liitettä ei lähetetä:', err.message);
    pikaohjeBase64 = null;
  }
  return pikaohjeBase64;
}

// ─── Sähköpostipohjat ─────────────────────────────────────────────────────────
function sahkopostiKoululle(etunimi, koodi, voimassa_asti) {
  const pvm = new Date(voimassa_asti).toLocaleDateString('fi-FI', { day: 'numeric', month: 'long', year: 'numeric' });
  return `<!DOCTYPE html>
<html lang="fi">
<body style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;padding:32px 20px;color:#0f2540;background:#f8fbff">
  <div style="text-align:center;margin-bottom:28px">
    <span style="font-size:26px;font-weight:700;color:#1a3f6f">Digi<span style="color:#2d9e6b">Opo</span></span>
  </div>
  <h2 style="color:#1a3f6f;margin-bottom:10px">Hei ${etunimi}!</h2>
  <p style="line-height:1.6;margin-bottom:24px">Kiitos DigiOpo-tilauksestasi ja maksustasi. Koulukoodisi on luotu ja oppilaat voivat nyt kirjautua sisään.</p>
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
  <p style="font-size:13px;color:#7a9ab5;line-height:1.6">Erillinen maksukuitti tulee tässä sähköpostissa liitteen sijaan omana viestinään. Kysyttävää? Vastaa suoraan tähän sähköpostiin.</p>
</body>
</html>`;
}

// Maksukuitti / tosite. Korvaa vanhan laskun: rahat on jo maksettu verkkomaksuna,
// joten tässä ei ole maksuohjeita (IBAN/viitenumero/eräpäivä) vaan vahvistus siitä
// mitä maksettiin, milloin ja millä maksutavalla.
function sahkopostiKuitti(tilaus, hintatiedot, tositenumero, maksettuPvm) {
  const { etunimi, sukunimi, email, koulu, kunta, oppilasmaara, lisenssikausi } = tilaus;
  const tositeNaytto = `${String(tositenumero).slice(0, 4)}-${String(tositenumero).slice(4)}`;

  let tuotekuvaus, maara;
  if (lisenssikausi === '3vuotta') {
    tuotekuvaus = 'DigiOpo Omilla jäljillä – koululisenssi, 3 vuotta';
    maara       = `${oppilasmaara} oppilasta × 12,50 €`;
  } else {
    tuotekuvaus = 'DigiOpo Omilla jäljillä – koululisenssi, 1 lukuvuosi';
    maara       = `${oppilasmaara} oppilasta × 5,90 €`;
  }
  const minimiNota = hintatiedot.minimitilausKaytossa
    ? '<tr><td colspan="3" style="padding:2px 12px 10px;font-size:11.5px;color:#7a9ab5;font-style:italic">Sovelletaan minimitilausta</td></tr>'
    : '';

  return `<!DOCTYPE html>
<html lang="fi">
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;padding:32px 20px;color:#0f2540;background:#ffffff">

  <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px">
    <tr>
      <td><span style="font-size:24px;font-weight:700;color:#1a3f6f">Digi<span style="color:#2d9e6b">Opo</span></span></td>
      <td style="text-align:right"><span style="font-size:26px;font-weight:800;color:#1a6b45;letter-spacing:2px">MAKSUKUITTI</span></td>
    </tr>
  </table>

  <div style="background:#d4f2e7;border:1px solid #2d9e6b;border-radius:12px;padding:14px 18px;margin-bottom:28px;font-size:14px;color:#1a6b45">
    ✓ <strong>Maksu vastaanotettu.</strong> Tilaus on maksettu verkkomaksuna ${muotoilePvm(maksettuPvm)}.
  </div>

  <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px">
    <tr>
      <td style="vertical-align:top;width:50%">
        <div style="font-size:10.5px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#7a9ab5;margin-bottom:8px">MYYJÄ</div>
        <div style="font-size:13.5px;line-height:1.85;color:#0f2540">
          <strong>${MYYJA.nimi}</strong><br>
          Y-tunnus: ${MYYJA.ytunnus}<br>
          ${MYYJA.osoite}<br>
          ${MYYJA.postiosoite}
        </div>
      </td>
      <td style="vertical-align:top;padding-left:24px">
        <div style="font-size:10.5px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#7a9ab5;margin-bottom:8px">KUITIN TIEDOT</div>
        <table cellpadding="0" cellspacing="0" style="font-size:13.5px;line-height:2">
          <tr><td style="color:#3a5a7a;padding-right:14px">Tositenumero</td><td><strong>${tositeNaytto}</strong></td></tr>
          <tr><td style="color:#3a5a7a">Maksupäivä</td><td>${muotoilePvm(maksettuPvm)}</td></tr>
          <tr><td style="color:#3a5a7a">Maksutapa</td><td>Verkkomaksu (Paytrail)</td></tr>
        </table>
      </td>
    </tr>
  </table>

  <div style="background:#f8fbff;border-left:3px solid #1a3f6f;padding:14px 18px;margin-bottom:28px;border-radius:0 8px 8px 0">
    <div style="font-size:10.5px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#7a9ab5;margin-bottom:6px">OSTAJA</div>
    <div style="font-size:13.5px;line-height:1.85">
      <strong>${koulu}</strong>, ${kunta}<br>
      Yhteyshenkilö: ${etunimi} ${sukunimi}<br>
      <span style="color:#3a5a7a">${email}</span>
    </div>
  </div>

  <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:0;font-size:13.5px">
    <thead>
      <tr style="background:#1a3f6f;color:#fff">
        <th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:600">TUOTE / PALVELU</th>
        <th style="padding:10px 12px;text-align:right;font-size:11px;font-weight:600">MÄÄRÄ</th>
        <th style="padding:10px 12px;text-align:right;font-size:11px;font-weight:600;white-space:nowrap">ALV 0 %</th>
      </tr>
    </thead>
    <tbody>
      <tr style="background:#f8fbff">
        <td style="padding:12px;border-bottom:1px solid #ddeaf7">${tuotekuvaus}</td>
        <td style="padding:12px;border-bottom:1px solid #ddeaf7;text-align:right;color:#3a5a7a;white-space:nowrap">${maara}</td>
        <td style="padding:12px;border-bottom:1px solid #ddeaf7;text-align:right;font-weight:600;white-space:nowrap">${muotoileEuro(hintatiedot.netto)}</td>
      </tr>
      ${minimiNota}
    </tbody>
  </table>

  <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;font-size:13.5px">
    <tr><td></td><td style="text-align:right;padding:7px 12px;color:#3a5a7a;white-space:nowrap">Yhteensä (alv 0 %)</td><td style="text-align:right;padding:7px 12px;min-width:110px;white-space:nowrap">${muotoileEuro(hintatiedot.netto)}</td></tr>
    <tr><td></td><td style="text-align:right;padding:7px 12px;color:#3a5a7a">ALV 13,5 %</td><td style="text-align:right;padding:7px 12px;white-space:nowrap">${muotoileEuro(hintatiedot.alv)}</td></tr>
    <tr><td></td><td colspan="2" style="border-top:2px solid #1a3f6f;padding:2px 0"></td></tr>
    <tr><td></td><td style="text-align:right;padding:10px 12px;font-weight:700;font-size:15px;color:#1a6b45">MAKSETTU</td><td style="text-align:right;padding:10px 12px;font-weight:700;font-size:15px;color:#1a6b45;white-space:nowrap">${muotoileEuro(hintatiedot.brutto)}</td></tr>
  </table>

  <p style="font-size:12px;color:#7a9ab5;line-height:1.7">Tämä on kuitti jo maksetusta tilauksesta – sitä ei tarvitse maksaa uudelleen. Kysyttävää? <a href="mailto:digiopo@digiopo.fi" style="color:#2563a8">digiopo@digiopo.fi</a></p>

</body>
</html>`;
}

function sahkopostiAdminille(t, koodi, voimassa_asti, hintatiedot, tositenumero) {
  const pvm = new Date(voimassa_asti).toLocaleDateString('fi-FI');
  const rivi = (nimi, arvo) =>
    `<tr><td style="padding:8px 12px;border-bottom:1px solid #eef5fb;color:#3a5a7a;font-size:13px">${nimi}</td><td style="padding:8px 12px;border-bottom:1px solid #eef5fb;font-size:13px">${arvo}</td></tr>`;
  const lisenssikausiTeksti = t.lisenssikausi === '3vuotta' ? '3 vuoden lisenssi' : 'Vuosilisenssi';
  const hintaTeksti = `${muotoileEuro(hintatiedot.netto)} (alv 0 %) + alv 13,5 % = <strong>${muotoileEuro(hintatiedot.brutto)}</strong> (sis. alv)`
    + (hintatiedot.minimitilausKaytossa ? ' <span style="color:#7a5c00">— minimitilaus käytössä</span>' : '');
  const tositeNaytto = `${String(tositenumero).slice(0, 4)}-${String(tositenumero).slice(4)}`;
  return `<!DOCTYPE html>
<html lang="fi">
<body style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;padding:32px 20px;color:#0f2540">
  <h2 style="color:#1a6b45">💶 Uusi MAKSETTU DigiOpo-tilaus (verkkomaksu)</h2>
  <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
    ${rivi('Koulu', `${t.koulu}, ${t.kunta}`)}
    ${rivi('Yhteyshenkilö', `${t.etunimi} ${t.sukunimi}`)}
    ${rivi('Sähköposti', `<a href="mailto:${t.email}">${t.email}</a>`)}
    ${rivi('Puhelin', t.puhelin || '–')}
    ${rivi('Oppilasmäärä', t.oppilasmaara)}
    ${rivi('Lisenssikausi', lisenssikausiTeksti)}
    ${rivi('Maksettu summa', hintaTeksti)}
    ${rivi('Maksutapa', 'Verkkomaksu (Paytrail)')}
    ${rivi('Tositenumero', tositeNaytto)}
    ${rivi('Lisätiedot', t.lisatiedot || '–')}
    ${rivi('Generoitu koodi', `<strong style="font-size:18px;letter-spacing:2px">${koodi}</strong>`)}
    ${rivi('Voimassa asti', pvm)}
  </table>
  <p style="font-size:12px;color:#7a9ab5">Maksu on vahvistettu Paytrailin kautta, lisenssi on aktiivinen ja koodi lähetetty tilaajalle automaattisesti. Erillistä laskua ei lähetetä.</p>
</body>
</html>`;
}

// ─── Julkinen: täytä maksettu tilaus ─────────────────────────────────────────
//
// tilaus: { etunimi, sukunimi, email, puhelin, koulu, kunta, oppilasmaara,
//           lisenssikausi, lisatiedot }
// tositenumero: valmiiksi varattu laskunumero (kutsuja varaa sen, jotta se
//               tallentuu maksut-riville samassa transaktiossa).
//
// Palauttaa { koodi, voimassa_asti }. Heittää, jos lisenssin luonti epäonnistuu.
export async function taytaTilaus(tilaus, tositenumero) {
  const { etunimi, sukunimi, email, koulu, kunta, oppilasmaara, lisenssikausi, puhelin, lisatiedot } = tilaus;

  const emailNorm = String(email).trim().toLowerCase();
  const henkilo = `${String(etunimi).trim()} ${String(sukunimi).trim()}`;
  const hintatiedot = laskeHinta(lisenssikausi, oppilasmaara);
  const maksettuPvm = new Date().toISOString().split('T')[0];

  // Täysi voimassaolo heti – maksu on saatu. 3v-lisenssi = 3 vuotta, muuten 1.
  const kestoVuosina = lisenssikausi === '3vuotta' ? 3 : 1;
  const loppu = new Date();
  loppu.setFullYear(loppu.getFullYear() + kestoVuosina);
  const voimassa_asti = loppu.toISOString().split('T')[0];

  // Luo lisenssi; 3 yritystä koodin törmäyksen varalta.
  let koodi = null;
  for (let yritys = 0; yritys < 3; yritys++) {
    koodi = generoiKoodi(koulu);
    try {
      await lisaaLisenssi({
        koodi,
        koulu: String(koulu).trim(),
        yhteyshenkilö: henkilo,
        email: emailNorm,
        tyyppi: 'vuosi',
        paikat: Number(oppilasmaara) || null,
        voimassa_asti,
        taysi_voimassa_asti: voimassa_asti,
        laskunumero: String(tositenumero),
        lasku_pvm: maksettuPvm,
        maksettu: true,     // rahat saatu heti
        aktiivinen: true,
      });
      break;
    } catch (err) {
      if (yritys === 2) throw err;
    }
  }

  const pdfB64 = await haePikaohjeetBase64();
  const pdfLiite = pdfB64 ? [{ filename: 'DigiOpo_opettajan_pikaohjeet.pdf', content: pdfB64 }] : [];
  const tositeNaytto = `${String(tositenumero).slice(0, 4)}-${String(tositenumero).slice(4)}`;

  await lahetaSahkopostitJaKirjaa(
    'maksu taytto sahkoposti',
    { koulu, email: emailNorm, koodi },
    [
      lahetaSahkoposti(emailNorm, 'DigiOpo – koulukoodisi on valmis', sahkopostiKoululle(etunimi, koodi, voimassa_asti), pdfLiite),
      lahetaSahkoposti(emailNorm, `DigiOpo – maksukuitti nro ${tositeNaytto}`, sahkopostiKuitti(tilaus, hintatiedot, tositenumero, maksettuPvm)),
      ADMIN_EMAIL && lahetaSahkoposti(ADMIN_EMAIL, `Maksettu DigiOpo-tilaus: ${koulu}`, sahkopostiAdminille(tilaus, koodi, voimassa_asti, hintatiedot, tositenumero)),
    ]
  );

  return { koodi, voimassa_asti };
}

// ─── Koulun koodisähköposti laskutilaukselle ─────────────────────────────────
// Kuten sahkopostiKoululle, mutta ei mainitse maksua: koodi on voimassa 30 pv ja
// jatkuu automaattisesti täyteen kauteen, kun kunta maksaa laskun.
function sahkopostiKoululleLasku(etunimi, koodi, voimassa_asti, taysi_voimassa_asti) {
  const pvm = new Date(voimassa_asti).toLocaleDateString('fi-FI', { day: 'numeric', month: 'long', year: 'numeric' });
  const taysiPvm = new Date(taysi_voimassa_asti).toLocaleDateString('fi-FI', { day: 'numeric', month: 'long', year: 'numeric' });
  return `<!DOCTYPE html>
<html lang="fi">
<body style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;padding:32px 20px;color:#0f2540;background:#f8fbff">
  <div style="text-align:center;margin-bottom:28px">
    <span style="font-size:26px;font-weight:700;color:#1a3f6f">Digi<span style="color:#2d9e6b">Opo</span></span>
  </div>
  <h2 style="color:#1a3f6f;margin-bottom:10px">Hei ${etunimi}!</h2>
  <p style="line-height:1.6;margin-bottom:24px">Kiitos DigiOpo-tilauksestasi. Koulukoodisi on luotu ja oppilaat voivat kirjautua sisään heti.</p>
  <div style="background:#ddeaf7;border-radius:14px;padding:28px;text-align:center;margin-bottom:24px">
    <p style="margin:0 0 8px;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#3a5a7a">KOULUKOODISI</p>
    <p style="font-size:34px;font-weight:700;letter-spacing:5px;color:#1a3f6f;margin:0">${koodi}</p>
    <p style="margin:12px 0 0;font-size:13px;color:#3a5a7a">Voimassa ${pvm} asti</p>
  </div>
  <div style="background:#fef9e0;border:1px solid #f5c842;border-radius:10px;padding:16px 20px;margin-bottom:28px">
    <p style="margin:0;font-size:13px;color:#7a5c00;line-height:1.6">Lasku lähetetään kunnallenne erikseen. Koodi on voimassa 30 päivää, ja kun lasku on maksettu, voimassaolo jatkuu automaattisesti <strong>${taysiPvm}</strong> asti — sinun ei tarvitse tehdä mitään.</p>
  </div>
  <p style="line-height:1.6;margin-bottom:8px"><strong>Näin jaat koodin oppilaille:</strong></p>
  <ol style="line-height:1.8;padding-left:20px;margin-bottom:24px">
    <li>Oppilaat menevät osoitteeseen <strong>app.digiopo.fi</strong></li>
    <li>Syöttävät koulukoodin <strong>${koodi}</strong> kirjautumisruutuun</li>
    <li>Pääsevät suoraan sisältöön</li>
  </ol>
  <div style="text-align:center;margin-bottom:32px">
    <a href="https://app.digiopo.fi" style="background:#1a3f6f;color:#fff;padding:14px 36px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px">Avaa DigiOpo →</a>
  </div>
  <p style="font-size:13px;color:#7a9ab5;line-height:1.6">📖 Opettajan pikaohje on tämän viestin liitteenä. Kysyttävää? Vastaa suoraan tähän sähköpostiin.</p>
</body>
</html>`;
}

// ─── Laskulla-tilauksen täyttö (kunnat) ───────────────────────────────────────
//
// Luo lisenssin HETI, mutta lyhyellä 30 päivän voimassaololla ja tilassa
// maksettu:false. Täysi kausi (taysi_voimassa_asti) on tallessa, ja kun lasku
// maksetaan, admin jatkaa voimassaolon siihen (api/admin-maksut.js → maksettu,
// tai admin-lisenssi.js → merkitse_maksetuksi). Jos laskua ei makseta, pääsy
// päättyy 30 päivässä itsestään – turvallinen oletus, joka suojaa tekaistuilta
// tilauksilta (raha tulee vain laskulla, jonka lähetyksen admin hallitsee).
//
// Palauttaa luodun koodin, jotta se voidaan tallentaa maksut-riville (admin
// laajentaa lisenssin sen perusteella maksun tullessa).
export async function taytaLaskutilaus(tilaus, hintatiedot) {
  const {
    etunimi, sukunimi, email, puhelin, koulu, kunta, oppilasmaara, lisenssikausi, lisatiedot,
    laskutus_nimi, laskutus_ytunnus, laskutus_ovt, laskutus_valittaja,
    laskutus_viite, laskutus_tilausnumero, laskutus_yksikko,
  } = tilaus;

  const emailNorm = String(email).trim().toLowerCase();
  const henkilo = `${String(etunimi).trim()} ${String(sukunimi).trim()}`;
  const luotuPvm = new Date().toISOString().split('T')[0];

  // Lyhyt alkuvoimassaolo (30 pv) + täysi kausi maksun jälkeen.
  const ALKUVOIMASSAOLO_PV = 30;
  const kestoVuosina = lisenssikausi === '3vuotta' ? 3 : 1;
  const taysi = new Date();
  taysi.setFullYear(taysi.getFullYear() + kestoVuosina);
  const taysi_voimassa_asti = taysi.toISOString().split('T')[0];
  const alku = new Date();
  alku.setDate(alku.getDate() + ALKUVOIMASSAOLO_PV);
  const voimassa_asti = alku.toISOString().split('T')[0];

  // Luo lisenssi; 3 yritystä koodin törmäyksen varalta.
  let koodi = null;
  for (let yritys = 0; yritys < 3; yritys++) {
    koodi = generoiKoodi(koulu);
    try {
      await lisaaLisenssi({
        koodi,
        koulu: String(koulu).trim(),
        yhteyshenkilö: henkilo,
        email: emailNorm,
        tyyppi: 'vuosi',
        paikat: Number(oppilasmaara) || null,
        voimassa_asti,               // 30 pv – jatkuu maksun jälkeen
        taysi_voimassa_asti,         // mihin jatketaan kun lasku maksetaan
        maksettu: false,             // lasku lähetetään erikseen
        aktiivinen: true,
      });
      break;
    } catch (err) {
      if (yritys === 2) throw err;
    }
  }

  const kausiTeksti = lisenssikausi === '3vuotta'
    ? 'Koululisenssi, 3 vuotta (12,50 €/oppilas)'
    : 'Koululisenssi, 1 lukuvuosi (5,90 €/oppilas)';
  const rivi = (n, a) =>
    `<tr><td style="padding:6px 14px 6px 0;color:#3a5a7a;vertical-align:top;white-space:nowrap">${n}</td><td style="padding:6px 0;color:#0f2540">${a || '–'}</td></tr>`;

  // Admin: toimenpidelista. Lisenssi ja koodi on jo luotu – jäljellä lasku.
  const adminHtml = `<!DOCTYPE html><html lang="fi"><head><meta charset="UTF-8"></head>
  <body style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;padding:28px 20px;color:#0f2540">
    <h2 style="color:#1a3f6f;margin:0 0 4px">Laskulla-tilaus – lähetä lasku</h2>
    <p style="font-size:13px;color:#7a9ab5;margin:0 0 8px">Lisenssi ja koulukoodi on jo luotu ja lähetetty koululle (voimassa 30 pv). Jäljellä: lähetä verkkolasku kunnan portaaliin ja merkitse tilaus laskutetuksi. Maksun tullessa merkitse maksetuksi → voimassaolo jatkuu täyteen kauteen.</p>
    <p style="font-size:14px;margin:0 0 20px">Koulukoodi: <strong style="font-size:18px;letter-spacing:2px">${koodi}</strong> · ALV 13,5 % (ei käännettyä)</p>

    <div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#7a9ab5;margin:0 0 6px">Laskutettava (kunta)</div>
    <table style="font-size:14px;line-height:1.5;margin-bottom:20px">
      ${rivi('Organisaatio', laskutus_nimi)}
      ${rivi('Y-tunnus', laskutus_ytunnus)}
      ${rivi('Verkkolaskuosoite', laskutus_ovt)}
      ${rivi('Välittäjätunnus', laskutus_valittaja)}
      ${rivi('Viitteenne', `<strong>${laskutus_viite || '–'}</strong>`)}
      ${rivi('Tilausnumero', laskutus_tilausnumero)}
      ${rivi('Vastaanottava yksikkö', laskutus_yksikko)}
    </table>

    <div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#7a9ab5;margin:0 0 6px">Tilaus</div>
    <table style="font-size:14px;line-height:1.5;margin-bottom:20px">
      ${rivi('Tuote', kausiTeksti)}
      ${rivi('Oppilasmäärä', String(oppilasmaara))}
      ${rivi('Veroton', muotoileEuro(hintatiedot.netto))}
      ${rivi('ALV 13,5 %', muotoileEuro(hintatiedot.alv))}
      ${rivi('Yhteensä', `<strong>${muotoileEuro(hintatiedot.brutto)}</strong>`)}
    </table>

    <div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#7a9ab5;margin:0 0 6px">Yhteyshenkilö (koulu)</div>
    <table style="font-size:14px;line-height:1.5">
      ${rivi('Koulu', `${koulu}, ${kunta}`)}
      ${rivi('Nimi', `${etunimi} ${sukunimi}`)}
      ${rivi('Sähköposti', `<a href="mailto:${email}">${email}</a>`)}
      ${rivi('Puhelin', puhelin)}
      ${rivi('Lisätiedot', lisatiedot)}
    </table>
  </body></html>`;

  const pdfB64 = await haePikaohjeetBase64();
  const pdfLiite = pdfB64 ? [{ filename: 'DigiOpo_opettajan_pikaohjeet.pdf', content: pdfB64 }] : [];

  await lahetaSahkopostitJaKirjaa(
    'lasku taytto sahkoposti',
    { koulu, email: emailNorm, koodi },
    [
      lahetaSahkoposti(emailNorm, 'DigiOpo – koulukoodisi on valmis', sahkopostiKoululleLasku(etunimi, koodi, voimassa_asti, taysi_voimassa_asti), pdfLiite),
      ADMIN_EMAIL && lahetaSahkoposti(ADMIN_EMAIL, `LASKUTA: ${koulu} (${kunta}) – ${muotoileEuro(hintatiedot.brutto)}`, adminHtml),
    ]
  );

  return { koodi, voimassa_asti, taysi_voimassa_asti };
}
